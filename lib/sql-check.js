// cpt-mcp/lib/sql-check.js —— 模板数据集 SQL 的"实跑 + 列名对账"（2026-10-26）
//
// 背景（v1 会话实测）：`run_fr_engine_check` / `quality_gate_cpt` 都不执行 SQL，
// 于是每个数据集 SQL 只能先用 `mcp__doris__*` 手工跑 487 次验证，再手动同步回 .cpt；
// 而"SQL 返回列"与"单元格绑定的 dsColumn"是否对得上，全靠人肉数。本模块把这两步收进 MCP：
//   1) 从模板取数据集 SQL（或直接校验一段候选 SQL）；
//   2) 代入数据集参数（${name}），FR 公式型参数（${if(...)}）识别为未解析并如实报告；
//   3) 走只读通道实跑，返回行数/列名/样例/耗时；
//   4) 把 SQL 返回列与「单元格实际绑定的列」做双向 diff —— 模板引用了但 SQL 没返回的列必须点名。
//
// 2026-11-02 起新增本地 SQLite 测试通道（不连真实库）：
//   checkDatasetSqlLocal —— target=local：方言改写后在本地库执行（offline=true 时只 prepare 不执行）；
//   checkDatasetSqlBoth  —— target=both：真实库只读跑一遍 + 本地跑一遍，给列/行数/样例对账（parity）。
//   本地通道只做「语法/结构/列绑定」的可信校验；数值精度/时区/排序等以真实库为准（见 LOCAL_CHECK_CAVEATS）。
import { datasets } from './cpt.js';
import { load } from './xml.js';
import { runSelectSql } from './db.js';
import { asArray, asReports } from './parsed-shape.js';
import {
  resolveLocalDbName, runLocalSql, localDbGuide, prepareLocalSql,
  readLocalDbSettings, SQL_TEST_TARGETS,
} from './localdb.js';


// ---------------- target 解析（2026-11-04：默认 local，真实库显式） ----------------
//
// 用户口径（2026-11-04 确认）：**默认 local，真实库显式**；`target=real/both` 才连真实库。
// 优先级（高 → 低）：
//   ① 显式参数 target
//   ② 环境变量 CPT_MCP_SQL_TARGET（合法值 local/real/both；CPT_MCP_SQL_TEST_TARGET 为兼容别名）
//   ③ <cwd>/.cpt-mcp/localdb.json 的 settings.sqlTestTarget
//   ④ 默认 'local'
// 非法的显式值/环境变量/配置值一律**忽略并回退下一级**（不报错，避免一个错 env 把校验打瘫）。
// 不提供 target:"auto"：缺省即 local，多一个 auto 只会让默认不透明（用户口径）。

/** 合法 target 值（与 local_db settings 共用一份常量，避免两处漂移） */
export const SQL_CHECK_TARGETS = SQL_TEST_TARGETS;

function normalizeSqlCheckTarget(v) {
  const s = String(v ?? '').trim().toLowerCase();
  return SQL_CHECK_TARGETS.includes(s) ? s : null;
}

/**
 * 解析本次 run_dataset_sql_check 实际使用的 target。
 * @param {{target?:string, cwd?:string}} [o] cwd 用于定位 `<cwd>/.cpt-mcp/localdb.json`（缺省按 localDbRoot 的配置位置）
 * @returns {{target:'local'|'real'|'both', source:'explicit'|'env'|'config'|'default'}}
 */
export function resolveSqlCheckTarget({ target, cwd } = {}) {
  const explicit = normalizeSqlCheckTarget(target);
  if (explicit) return { target: explicit, source: 'explicit' };
  const env = normalizeSqlCheckTarget(process.env.CPT_MCP_SQL_TARGET)
    ?? normalizeSqlCheckTarget(process.env.CPT_MCP_SQL_TEST_TARGET); // 兼容旧 env 名
  if (env) return { target: env, source: 'env' };
  let settings = null;
  try {
    settings = cwd && String(cwd).trim()
      ? readLocalDbSettings({ cwd: String(cwd).trim() })
      : readLocalDbSettings();
  } catch { settings = null; }
  // 只有配置文件里**真正提供了合法值**才算 config 来源；否则是 readLocalDbSettings 的默认回退
  const fromConfig = Array.isArray(settings?.provided) && settings.provided.includes('sqlTestTarget');
  const cfg = fromConfig ? normalizeSqlCheckTarget(settings.sqlTestTarget) : null;
  if (cfg) return { target: cfg, source: 'config' };
  return { target: 'local', source: 'default' };
}

/** 本地库未初始化时的结构化 nextAction（模型可直接照做；不静默改连真实库） */
function localDbSetupNextAction({ cptPath, connection, dbName } = {}) {
  const db = dbName || 'main';
  const conn = connection || '<数据连接名，如 Doris>';
  const p = cptPath || '<模板.cpt 绝对路径>';
  return [
    `本地库 "${db}" 未初始化：本地 SQLite 测试模式默认 target=local，**不会静默改连真实库**。按顺序执行：`,
    `  ⓪ report/focused 档先解锁租约：request_deep_tool_access({ path: ${JSON.stringify(p)}, group: "local_db" })`,
    `  ① local_db_admin({ action: "create", db: ${JSON.stringify(db)} }) 建库`,
    `  ② local_db_import({ action: "auto", db: ${JSON.stringify(db)}, connection: ${JSON.stringify(conn)}, path: ${JSON.stringify(p)} }) 镜像结构并按需抽样（默认 ≤200 行/表、≤5000 行）`,
    `  ③ 重跑 run_dataset_sql_check({ path: ${JSON.stringify(p)}, target: "local", offline: true }) 或 quality_gate_cpt({ path: ${JSON.stringify(p)} })`,
    '没有真实库连接时也可纯离线：local_db_import({ action: "ddl", db, ddl: "CREATE TABLE ..." }) + local_db_import({ action: "seed", db, table, rows })',
    '确需真实库结论时显式传 target:"real"（或 env CPT_MCP_SQL_TARGET=real / localdb.json settings.sqlTestTarget="real"）',
  ].join('\n');
}


/** 取指定数据集（缺省第一个 SQL 数据集）的 SQL 与连接名 */
export function datasetSqlOf(cptPath, dsName) {
  const list = datasets(cptPath);
  if (!list.length) throw new Error(`${cptPath} 里没有数据集（TableDataMap 为空）`);
  let target;
  if (dsName) {
    target = list.find((d) => d.name === dsName) || list.find((d) => d.name.toLowerCase() === String(dsName).toLowerCase());
    if (!target) throw new Error(`未找到数据集 "${dsName}"（现有：${list.map((d) => d.name).join('、')}）`);
  } else {
    target = list.find((d) => d.sql) || list[0];
  }
  if (!target.sql) throw new Error(`数据集 "${target.name}" 没有 SQL（可能是 Excel/树数据集）；本工具只校验 SQL 数据集`);
  return { dataset: target.name, connection: target.connection, sql: target.sql, parameters: target.parameters, all: list };
}

/**
 * 扫模板里所有 DSColumn 绑定：dsName -> Set(columnName)，并记录每列的引用单元格（便于报错定位）
 * 结构：<C c= r=><O t="DSColumn"><Attributes dsName="ds1" columnName="序号"/>
 */
export function datasetBindings(cptPath) {
  const { parsed } = load(cptPath);
  const map = new Map();
  for (const { report, sheet } of asReports(parsed)) {
    for (const c of asArray(report.CellElementList?.C)) {
      const o = c?.O;
      if (!o || typeof o !== 'object' || o['@_t'] !== 'DSColumn') continue;
      const attrs = o.Attributes;
      const one = (a) => {
        const ds = a?.['@_dsName'];
        const col = a?.['@_columnName'];
        if (!ds || !col) return;
        if (!map.has(ds)) map.set(ds, new Map());
        const cols = map.get(ds);
        if (!cols.has(col)) cols.set(col, []);
        cols.get(col).push(`${sheet}!R${c['@_r']}C${c['@_c']}`);
      };
      if (Array.isArray(attrs)) attrs.forEach(one); else one(attrs);
    }
  }
  return map;
}

/** 找 SQL 里的 ${...} 令牌（FR：${参数名} 与 ${if(...)} 公式两种） */
export function extractTokens(sql) {
  const tokens = [];
  const re = /\$\{([\s\S]*?)\}/g;
  let m;
  while ((m = re.exec(String(sql))) !== null) {
    tokens.push({ raw: m[0], inner: m[1].trim(), index: m.index });
  }
  return tokens;
}

/**
 * 代入数据集参数。
 * 口径：FR 的 ${param} 是**文本级替换**，模板里通常已经写好引号（如 dt >= '${start}'）。
 * 因此默认按原文插入、不自动加引号（自动加会和模板里的引号叠成 ''2026-01-01''）；
 * 需要加引号时显式传 {quoteStrings:true}。字符串里的单引号一律转义为 ''。
 * @param {string} sql
 * @param {object} params
 * @param {{quoteStrings?:boolean}} [opts]
 * @returns {{sql:string, used:object, unresolved:{raw:string,reason:string}[]}}
 */
export function substituteParams(sql, params = {}, opts = {}) {
  const quoteStrings = opts.quoteStrings === true;
  const used = {};
  const unresolved = [];
  const out = String(sql).replace(/\$\{([\s\S]*?)\}/g, (raw, innerRaw) => {
    const inner = String(innerRaw).trim();
    // 简单参数：${name}
    if (/^[A-Za-z_][\w]*$/.test(inner)) {
      if (Object.prototype.hasOwnProperty.call(params, inner)) {
        const v = params[inner];
        used[inner] = v;
        if (v === null || v === undefined) return 'NULL';
        if (typeof v === 'number' || typeof v === 'boolean') return String(v);
        const s = String(v).replace(/'/g, "''");
        return quoteStrings ? `'${s}'` : s;
      }
      unresolved.push({ raw, reason: `参数 ${inner} 未提供` });
      return raw;
    }
    // 公式型（if/len 等）或复杂表达式：不猜，原样保留并标记
    unresolved.push({ raw, reason: 'FR 公式参数，本工具不解析（请传 params 用简单 ${name}，或先用设计器预览）' });
    return raw;
  });
  return { sql: out, used, unresolved };
}

// ---------------- 未解析 FR 参数的离线占位策略（2026-11-07 P0） ----------------
//
// 背景（用户实测）：`WHERE 1=1 ${if(len(dept)=0,"","AND dept_name = '"+dept+"'")}` 这类公式型参数
// 落在**表达式位**，旧的"全部换 NULL"会拼成 `WHERE 1=1 NULL` → 本地 prepare 语法错，
// quality_gate 的 localSqlAudit 于是把"参数无法离线代入"误报成模板 SQL 语法 blocker。
// 这里不做 FR 公式解析（超出范围），只按三档占位依次试 prepare，取第一个能过的：
//   ① null          —— 全部 ${...} → NULL（旧行为，简单参数最自然）
//   ② formula-empty —— 公式型/复杂表达式 → 空串、简单 ${name} 仍 NULL（WHERE 1=1 后正好消失）
//   ③ all-empty     —— 全部 → 空串（最后手段）

/** 是否简单参数令牌（${name}）；否则视为 FR 公式/复杂表达式。 */
function tokenIsSimpleParam(inner) {
  return /^[A-Za-z_][\w]*$/.test(String(inner ?? '').trim());
}

/**
 * 未解析 FR 参数 → prepare 候选（按降级顺序，调用方取第一个 prepare 成功的）。
 * @param {string} sql 已代入已知参数的 SQL（未解析令牌原样保留）
 * @returns {Array<{strategy:'null'|'formula-empty'|'all-empty', sql:string}>}
 */
export function maskUnresolvedCandidates(sql) {
  const src = String(sql ?? '');
  const mask = (simpleText, formulaText) =>
    src.replace(/\$\{([\s\S]*?)\}/g, (raw, inner) => (tokenIsSimpleParam(inner) ? simpleText : formulaText));
  return [
    { strategy: 'null', sql: mask(' NULL ', ' NULL ') },
    { strategy: 'formula-empty', sql: mask(' NULL ', '') },
    { strategy: 'all-empty', sql: mask('', '') },
  ];
}

/** 占位策略的说明文案（进 warning/hint；不要回显 SQL 片段）。 */
export function maskStrategyLabel(strategy) {
  if (strategy === 'formula-empty') return '公式参数=空串、简单参数=NULL';
  if (strategy === 'all-empty') return '全部未解析参数=空串';
  return '全部未解析参数=NULL';
}

/**
 * 逐候选 prepare，取第一个成功；全部失败时返回**第一个候选（NULL，旧口径）**的失败结果，
 * 保证错误 kind/文案与改造前一致（不新增 blocker 分类）。
 * @param {(sql:string)=>object} prepare 非抛错版 prepare（返回 prepareLocalSql 的形状）
 * @param {string} sql 含未解析参数的 SQL
 * @returns {{ok:boolean, strategy:string|null, sql:string, prep:object, attempted:string[]}}
 */
export function prepareWithMaskStrategies(prepare, sql) {
  const candidates = maskUnresolvedCandidates(sql);
  let first = null;
  for (const c of candidates) {
    const prep = prepare(c.sql);
    if (!first) first = prep;
    if (prep && prep.ok) {
      return { ok: true, strategy: c.strategy, sql: c.sql, prep, attempted: candidates.map((x) => x.strategy) };
    }
  }
  return { ok: false, strategy: null, sql: candidates[0].sql, prep: first, attempted: candidates.map((x) => x.strategy) };
}

function normCol(s) {
  return String(s ?? '').trim().toLowerCase();
}

/**
 * SQL 返回列 vs 模板 dsColumn 绑定的双向对账（纯函数，便于单测）。
 * @param {Map<string, string[]>} boundCols dsName 下的绑定列 → 引用单元格
 * @param {string[]} returnedNames SQL 实际返回的列名
 * @returns {{matched:number, missingInSql:{column:string,referencedBy:string[]}[], unboundInSql:string[]}}
 */
export function diffBindings(boundCols, returnedNames) {
  const returnedNorm = new Map((returnedNames || []).map((n) => [normCol(n), n]));
  const missingInSql = [];
  for (const [col, refs] of (boundCols || new Map()).entries()) {
    if (!returnedNorm.has(normCol(col))) missingInSql.push({ column: col, referencedBy: (refs || []).slice(0, 5) });
  }
  const boundNorm = new Set([...(boundCols || new Map()).keys()].map(normCol));
  const unboundInSql = (returnedNames || []).filter((n) => !boundNorm.has(normCol(n)));
  return {
    matched: (boundCols ? boundCols.size : 0) - missingInSql.length,
    missingInSql,
    unboundInSql: unboundInSql.slice(0, 40),
  };
}

/**
 * 校验模板数据集 SQL（或候选 SQL）。
 * @param {object} o
 * @param {string} o.cptPath .cpt 绝对路径
 * @param {string} [o.dsName] 数据集名（缺省：第一个 SQL 数据集）
 * @param {string} [o.sql] 候选 SQL（给了就不读模板里的，用于"写入前先验"）
 * @param {object} [o.params] 数据集参数值 ${name}
 * @param {number} [o.maxRows=20] 样例行数
 * @param {boolean} [o.explain] 只跑 EXPLAIN，不取数据
 * @param {number} [o.timeoutMs]
 */
export async function checkDatasetSql(o = {}) {
  const cptPath = o.cptPath;
  if (!cptPath) throw new Error('缺少 cptPath');
  const ds = datasetSqlOf(cptPath, o.dsName);
  const sourceSql = o.sql != null && String(o.sql).trim() !== '' ? String(o.sql) : ds.sql;
  const sqlSource = o.sql != null && String(o.sql).trim() !== '' ? 'candidate' : 'template';

  const { sql: bound, used, unresolved } = substituteParams(sourceSql, o.params || {});
  const hints = [];
  if (unresolved.length) {
    hints.push(`有 ${unresolved.length} 个 FR 参数未解析：${unresolved.map((u) => u.raw).join('、')}；这些位置按原文提交，可能语法错误。`);
  }

  let execution = null;
  let execError = null;
  let skippedReason = null;
  if (unresolved.length && !o.force) {
    skippedReason = `有 ${unresolved.length} 个未解析参数，默认不执行（避免拿错误 SQL 跑生产库）；确认要跑请传 force=true`;
    hints.push(skippedReason);
  } else {
    try {
      const res = await runSelectSql(ds.connection, o.explain ? `EXPLAIN ${bound}` : bound, {
        maxRows: Number(o.maxRows ?? 20),
        timeoutMs: o.timeoutMs,
      });
      execution = {
        rowCount: res.rowCount,
        truncated: res.truncated,
        elapsedMs: res.elapsedMs,
        columns: res.columns,
        rows: res.rows,
        executedSql: res.executedSql,
        ...(res.notice ? { notice: res.notice } : {}),
      };
    } catch (e) {
      execError = e.message;
      hints.push(`执行失败：${e.message}`);
    }
  }

  // 列名对账（只在拿到列时做；EXPLAIN 的列是执行计划，不比）
  let bindingCheck = null;
  if (execution && !o.explain) {
    const bindings = datasetBindings(cptPath);
    const boundCols = bindings.get(ds.dataset) || new Map();
    const returned = execution.columns.map((c) => c.name);
    const diff = diffBindings(boundCols, returned);
    bindingCheck = {
      dataset: ds.dataset,
      boundColumns: boundCols.size,
      returnedColumns: returned.length,
      matched: diff.matched,
      missingInSql: diff.missingInSql,
      unboundInSql: diff.unboundInSql,
    };
    if (diff.missingInSql.length) {
      hints.push(
        `模板绑定了 ${diff.missingInSql.length} 个 SQL 未返回的列（运行时会空白/报错）：` +
        diff.missingInSql.slice(0, 10).map((m) => m.column).join('、'),
      );
    }
    if (diff.unboundInSql.length) {
      hints.push(`SQL 多返回 ${diff.unboundInSql.length} 列未被任何单元格使用（不影响功能，可能是查多了）：${diff.unboundInSql.slice(0, 8).join('、')}`);
    }
  }

  return {
    // ok 的口径：**真的跑通了**才算通过；跳过执行（未解析参数）与连接失败都算未通过
    ok: Boolean(execution) && !execError && (!bindingCheck || bindingCheck.missingInSql.length === 0),
    dataset: ds.dataset,
    connection: ds.connection,
    sqlSource,
    sqlLength: sourceSql.length,
    executed: Boolean(execution),
    skippedReason,
    parametersDeclared: ds.parameters.map((p) => p.name),
    parametersUsed: used,
    unresolvedParams: unresolved,
    execution,
    execError,
    bindingCheck,
    hints,
  };
}

// ---------------- 本地 SQLite 测试通道（2026-11-02） ----------------

/** 本地通道的固定 caveats：与真实库不等价的语义面（每次返回都带上，避免模型误读） */
export const LOCAL_CHECK_CAVEATS = Object.freeze([
  '本地 SQLite 只校验语法/表列结构/绑定列，不保证数值精度、时区、排序规则、sql_mode、字符集与真实库一致',
  '本地通过 ≠ 生产通过：交付前仍应以 run_dataset_sql_check({target:"real"}) 与真实 FR 引擎结论为准',
  '方言改写只覆盖报表 SQL 常用子集；dialectIssues 里的条目属于本地限制，不代表报表 SQL 写错',
  'DATE/DATETIME 在本地存 TEXT，时间函数按宿主本地时区解释；真实库时区可能不同',
  'DECIMAL/NUMERIC 在 SQLite 用 NUMERIC 亲和，聚合/舍入结果可能与 MySQL 有差异',
]);

function localErrorPayload(e) {
  return {
    message: e.message,
    kind: e.kind ?? null,
    detail: e.detail ?? null,
    dialectIssues: e.dialectIssues ?? [],
  };
}

/** 本地库不可用时的统一返回（不抛错，便于 target=both 时仍能给出真实库结果） */
function localUnavailable(o, ds, resolved, reason) {
  return {
    ok: false,
    target: 'local',
    dataset: ds.dataset,
    connection: ds.connection,
    localDb: resolved?.name ?? null,
    localDbSource: resolved?.source ?? null,
    // 2026-11-04：本地库未初始化必须结构化说明 + 给出可执行 nextAction，绝不静默降级到真实库
    localDbReady: false,
    executed: false,
    offline: o.offline === true,
    error: reason,
    nextAction: localDbSetupNextAction({ cptPath: o.cptPath, connection: ds.connection, dbName: resolved?.name }),
    hints: [localDbGuide(resolved?.name)],
    caveats: LOCAL_CHECK_CAVEATS,
  };
}

/**
 * 本地 SQLite 通道校验数据集 SQL。
 * @param {object} o 同 checkDatasetSql，另加：
 * @param {string} [o.localDb] 指定本地库（缺省按 .cpt 数据连接名映射）
 * @param {boolean} [o.offline] 只 prepare（语法/列名审计），不执行数据
 * @param {boolean} [o.force] 有未解析参数时仍尝试执行
 */
export async function checkDatasetSqlLocal(o = {}) {
  const cptPath = o.cptPath;
  if (!cptPath) throw new Error('缺少 cptPath');
  const ds = datasetSqlOf(cptPath, o.dsName);
  const sourceSql = o.sql != null && String(o.sql).trim() !== '' ? String(o.sql) : ds.sql;
  const sqlSource = o.sql != null && String(o.sql).trim() !== '' ? 'candidate' : 'template';
  const resolvedDb = o.localDb
    ? resolveLocalDbName({ db: o.localDb })
    : resolveLocalDbName({ connection: ds.connection });
  if (!resolvedDb.exists) return localUnavailable(o, ds, resolvedDb, `本地库 "${resolvedDb.name}" 不存在：${resolvedDb.file}`);

  const { sql: bound, used, unresolved } = substituteParams(sourceSql, o.params || {});
  const hints = [];
  if (unresolved.length) {
    hints.push(`有 ${unresolved.length} 个 FR 参数未解析：${unresolved.map((u) => u.raw).join('、')}；prepare 时会按占位策略处理，执行前请传 params 或确认 SQL。`);
  }
  const offline = o.offline === true;
  let skippedReason = null;
  if (unresolved.length && !o.force) {
    if (offline) {
      hints.push('offline 模式下未解析参数按占位策略只做 prepare（依次尝试 NULL / 公式参数空串 / 全部空串；只校验语法/列名，不校验参数过滤语义）');
    } else {
      skippedReason = `有 ${unresolved.length} 个未解析参数，默认不执行（避免拿错误 SQL 跑本地库）；确认要跑请传 force=true`;
      hints.push(skippedReason);
    }
  }

  const sqlForWork = bound;
  const started = Date.now();
  let prepared = null;
  let execution = null;
  let execError = null;
  let paramMaskStrategy = null;
  try {
    if (offline || skippedReason) {
      // prepare-only：拿到列名即可（也用于返回明确错误分类）
      // 2026-11-07 P0：含未解析参数时按三档占位依次 prepare —— 公式型参数落表达式位
      // （如 WHERE 1=1 ${if(...)}）不再被 NULL 占位误报成语法错；跳过执行的情况（skippedReason）
      // 同样只做 prepare，错报语法会让人误以为模板 SQL 坏了。
      let prep;
      if (unresolved.length) {
        const picked = prepareWithMaskStrategies((sqlTry) => prepareLocalSqlNamed(resolvedDb.name, sqlTry), bound);
        prep = picked.prep;
        if (picked.ok) {
          paramMaskStrategy = picked.strategy;
          hints.push(`${offline ? '离线' : '仅 prepare'}模式下的未解析参数占位策略：${maskStrategyLabel(paramMaskStrategy)}（只校验语法/列名，不校验参数过滤语义）`);
        } else {
          throw prepFailure(picked.prep);
        }
      } else {
        prep = prepareLocalSqlOrThrow(resolvedDb.name, sqlForWork);
      }
      prepared = {
        columns: prep.columns,
        dialectIssues: prep.dialectIssues,
        translatedSql: prep.translatedSql,
        elapsedMs: Date.now() - started,
        ...(paramMaskStrategy ? { paramMaskStrategy } : {}),
      };
    } else {
      const res = runLocalSql(resolvedDb.name, sqlForWork, { maxRows: Number(o.maxRows ?? 20) });
      execution = {
        rowCount: res.rowCount,
        truncated: res.truncated,
        elapsedMs: res.elapsedMs,
        columns: res.columns,
        rows: res.rows,
        executedSql: res.translatedSql,
        dialectIssues: res.dialectIssues,
      };
    }
  } catch (e) {
    execError = localErrorPayload(e);
    hints.push(`本地库执行失败：${e.message}`);
  }

  const returned = execution?.columns?.map((c) => c.name) ?? prepared?.columns ?? [];
  let bindingCheck = null;
  if (returned.length) {
    const bindings = datasetBindings(cptPath);
    const boundCols = bindings.get(ds.dataset) || new Map();
    const diff = diffBindings(boundCols, returned);
    bindingCheck = {
      dataset: ds.dataset,
      boundColumns: boundCols.size,
      returnedColumns: returned.length,
      matched: diff.matched,
      missingInSql: diff.missingInSql,
      unboundInSql: diff.unboundInSql,
    };
    if (diff.missingInSql.length) {
      hints.push(`模板绑定了 ${diff.missingInSql.length} 个本地 SQL 未返回的列：${diff.missingInSql.slice(0, 10).map((m) => m.column).join('、')}`);
    }
  }

  const dialectIssues = execution?.dialectIssues ?? prepared?.dialectIssues ?? [];
  const ok = !execError && Boolean(execution || prepared) && (!bindingCheck || bindingCheck.missingInSql.length === 0);
  return {
    ok,
    target: 'local',
    dataset: ds.dataset,
    connection: ds.connection,
    localDb: resolvedDb.name,
    localDbSource: resolvedDb.source,
    localDbReady: true,
    sqlSource,
    sqlLength: sourceSql.length,
    executed: Boolean(execution),
    offline,
    skippedReason,
    parametersDeclared: ds.parameters.map((p) => p.name),
    parametersUsed: used,
    unresolvedParams: unresolved,
    // 未解析参数的离线占位策略：'null' | 'formula-empty' | 'all-empty'；null=未占位/不适用
    paramMaskStrategy,
    prepared,
    execution,
    execError,
    bindingCheck,
    dialectIssues,
    hints,
    caveats: LOCAL_CHECK_CAVEATS,
  };
}

/** prepare 失败 → 带 kind/detail/dialectIssues 的 Error（execError 分类口径）。 */
function prepFailure(prep) {
  const err = new Error(prep?.error?.message ?? '本地库 prepare 失败');
  err.kind = prep?.error?.kind ?? null;
  err.detail = prep?.error?.detail ?? null;
  err.dialectIssues = prep?.dialectIssues ?? [];
  return err;
}

function prepareLocalSqlOrThrow(name, sql) {
  // 延迟 import 避免与 audit 模块形成循环（audit → sql-check → localdb）
  const prep = prepareLocalSqlNamed(name, sql);
  if (prep.ok) return prep;
  throw prepFailure(prep);
}

// 由 localdb.js 导出；这里单独包一层保留 future 替换空间
function prepareLocalSqlNamed(name, sql) {
  return prepareLocalSql(name, sql, { mustExist: true });
}

/** 解析行数：真实库截断时是 ">20" 字符串；本地返回 number 或 ">N" */
function countValue(v) {
  if (typeof v === 'string' && v.startsWith('>')) return { truncated: true, n: Number(v.slice(1)) };
  if (typeof v === 'number') return { truncated: false, n: v };
  return { truncated: false, n: null };
}

function valueKind(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'number') return 'number';
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return 'numeric-string';
  return 'string';
}

function cellEqual(a, b) {
  if (a === null || a === undefined) return b === null || b === undefined;
  if (b === null || b === undefined) return false;
  const ka = valueKind(a);
  const kb = valueKind(b);
  if ((ka === 'number' || ka === 'numeric-string') && (kb === 'number' || kb === 'numeric-string')) {
    const na = Number(a); const nb = Number(b);
    return Number.isFinite(na) && Number.isFinite(nb) && Math.abs(na - nb) <= Math.max(1e-9, Math.abs(na) * 1e-12);
  }
  return String(a) === String(b);
}

/**
 * 真实库结果 vs 本地库结果对账（纯函数，便于单测）。
 * @returns {{verdict:string, columns:object, rowCount:object, sampleDiff:object[], caveats:string[], hints:string[]}}
 */
export function compareDatasetChecks(real, local, { maxSampleRows = 10 } = {}) {
  const caveats = [...LOCAL_CHECK_CAVEATS];
  const hints = [];
  const realCols = (real?.execution?.columns ?? []).map((c) => String(c?.name ?? c ?? ''));
  const localCols = (local?.execution?.columns ?? local?.prepared?.columns ?? []).map((c) => String(c?.name ?? c ?? ''));
  const norm = (s) => String(s ?? '').trim().toLowerCase();
  const realSet = new Set(realCols.map(norm));
  const localSet = new Set(localCols.map(norm));
  const missingInLocal = realCols.filter((c) => !localSet.has(norm(c)));
  const extraInLocal = localCols.filter((c) => !realSet.has(norm(c)));
  const orderEqual = realCols.length === localCols.length && realCols.every((c, i) => norm(c) === norm(localCols[i]));
  const columns = {
    real: realCols,
    local: localCols,
    match: missingInLocal.length === 0 && extraInLocal.length === 0,
    orderEqual,
    missingInLocal,
    extraInLocal,
  };
  const realCount = countValue(real?.execution?.rowCount ?? real?.execution?.rows?.length);
  const localCount = countValue(local?.execution?.rowCount ?? local?.execution?.rows?.length);
  const rowCount = {
    real: realCount.n,
    local: localCount.n,
    equal: realCount.n === localCount.n && realCount.truncated === localCount.truncated,
  };

  const sampleDiff = [];
  const realRows = real?.execution?.rows ?? [];
  const localRows = local?.execution?.rows ?? [];
  const realNameByNorm = new Map(realCols.map((c) => [norm(c), c]));
  const localNameByNorm = new Map(localCols.map((c) => [norm(c), c]));
  const common = realCols.filter((c) => localSet.has(norm(c)));
  const rowsToCompare = Math.min(realRows.length, localRows.length, maxSampleRows);
  for (let r = 0; r < rowsToCompare; r += 1) {
    for (const col of common) {
      const rv = realRows[r]?.[realNameByNorm.get(norm(col))];
      const lv = localRows[r]?.[localNameByNorm.get(norm(col))];
      if (!cellEqual(rv, lv)) {
        sampleDiff.push({
          row: r, column: col,
          real: rv === undefined ? null : rv,
          local: lv === undefined ? null : lv,
          kind: valueKind(rv) === valueKind(lv) ? 'value' : `${valueKind(rv)}-vs-${valueKind(lv)}`,
        });
        if (sampleDiff.length >= 30) break;
      }
    }
    if (sampleDiff.length >= 30) break;
  }

  let verdict = 'match';
  if (real?.execError) verdict = 'real-error';
  else if (local?.execError) verdict = 'local-error';
  else if (local?.error) verdict = 'local-unavailable';
  else if (local?.skippedReason) verdict = 'local-skipped';
  else if (!columns.match) verdict = 'columns-differ';
  else if (!rowCount.equal) verdict = 'rows-differ';
  else if (sampleDiff.length) verdict = 'values-differ';
  if (verdict === 'match') {
    hints.push('本地库与真实库在本次参数下结果一致（列/行数/样例行）；数值精度等已知差异见 caveats');
  } else if (verdict === 'columns-differ') {
    hints.push(`列不一致：真实库有而本地没有 [${missingInLocal.join('、')}]；本地多出 [${extraInLocal.join('、')}]。先核对本地 schema 是否镜像偏旧`);
  } else if (verdict === 'rows-differ') {
    hints.push('行数不一致：可能是数据不一致/本地样例数据不同/真实库查询截断；若本地是 fixture 属正常，建议只在结构层面参考');
  } else if (verdict === 'values-differ') {
    hints.push('样例行取值有差异：常见于 DECIMAL 格式（19.90 vs 19.9）、日期时区、排序规则；聚合类查询请以真实库为准');
  } else if (verdict === 'local-error') {
    hints.push(`本地执行失败：${local?.execError?.message ?? '未知'}；这不等于报表 SQL 错误，先本地库补表/补数据或看 dialectIssues`);
  }
  return { verdict, columns, rowCount, sampleDiff, caveats, hints };
}

/**
 * target=both：真实库（只读）+ 本地库各跑一遍，返回 parity。
 * 注意：真实库仍是交付判定依据（ok 沿用真实库结论）；本地结果只作对账参考。
 */
export async function checkDatasetSqlBoth(o = {}) {
  const real = await checkDatasetSql(o);
  const local = await checkDatasetSqlLocal(o);
  const parity = compareDatasetChecks(real, local, { maxSampleRows: Number(o.sampleRows ?? 10) });
  return {
    ...real,
    target: 'both',
    ok: real.ok,
    local,
    parity,
    hints: [...(real.hints || []), ...(parity.hints || [])],
  };
}

/**
 * 统一入口（2026-11-04）：按 target 解析优先级分发 local / real / both。
 *
 * server.js 的 run_dataset_sql_check 应改为调用本函数（schema 不要再 `.default("real")`）：
 * 不传 target 时按「显式 > env CPT_MCP_SQL_TARGET（别名 CPT_MCP_SQL_TEST_TARGET）> localdb.json settings.sqlTestTarget > local」
 * 解析；返回值额外带 `target`（实际生效值）与 `targetSource`（explicit/env/config/default）。
 * 本地库未初始化时 local 分支返回 localDbReady:false + nextAction，**不会静默连真实库**。
 *
 * @param {object} o 同 checkDatasetSql / checkDatasetSqlLocal / checkDatasetSqlBoth，另加：
 * @param {string} [o.target] 显式 target：local / real / both
 * @param {string} [o.cwd] target 解析时读取 `<cwd>/.cpt-mcp/localdb.json` 的起点（缺省按 localDbRoot 配置位置）
 * @returns {Promise<object>} 三个通道各自的返回结构 + {target, targetSource}
 */
export async function checkDatasetSqlAuto(o = {}) {
  const resolved = resolveSqlCheckTarget({ target: o.target, cwd: o.cwd });
  let result;
  if (resolved.target === 'local') result = await checkDatasetSqlLocal(o);
  else if (resolved.target === 'both') result = await checkDatasetSqlBoth(o);
  else result = await checkDatasetSql(o);
  return {
    ...result,
    target: resolved.target,
    // 审计文档 P0-A 口径：请求值 vs 实际生效值 vs 来源三层可见（响应字段，不进 tools/list）
    targetRequested: o.target === undefined || o.target === null ? null : String(o.target),
    targetEffective: resolved.target,
    targetSource: resolved.source,
  };
}
