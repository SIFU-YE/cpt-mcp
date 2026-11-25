// cpt-mcp/lib/test-env.js —— 报表级测试环境准备（2026-11-09）
//
// 用户口径：
//   · 新建报表：在内置 SQLite 本地库造 fixture（DDL + seed）后测试；
//   · 修改已有报表：把报表实际用到的**外部环境**复制进内置 SQLite，包括
//     schema 与少量样例数据；外部真实库始终只读，绝不写业务库；
//   · 填报报表除了数据集查询表，还必须镜像**填报提交目标表**（列映射的 table /
//     自由 SQL 的 UPDATE/INSERT/DELETE 目标），否则本地填报链路仍然跑不起来；
//   · 本地 SQLite 只能证明数据/结构/SQL 层；填报工具栏、Web 事件、真实提交仍需
//     FR 本地预览实点。本模块把 runtime 状态明确标成 unverified，绝不把
//     “SQLite 准备完成”冒充“运行期验证完成”。
//
// 本模块不直接连接真实库：schema/抽样全部委托 localdb-import 的只读通道；
// 外部连接只用于 SHOW/SELECT 只读读取，目标永远写 <cwd>/.cpt-mcp/localdb/*.sqlite。

import fs from 'node:fs';
import path from 'node:path';
import { datasets, fillConfig } from './cpt.js';
import {
  autoPrepareLocalDb, extractTableRefs, extractWriteTableRefs,
  importDdlIntoLocalDb, seedLocalDb,
} from './localdb-import.js';
import { listLocalTables, readLocalDbConfig, resolveLocalDbName, updateLocalDbConfig, readWriteAuditConfig, startWriteAuditRun } from './localdb.js';

/**
 * 记住「本地库 <- 报表连接名」映射：prepareReportTestEnv 在复用已有本地表时也要写，
 * 否则后续 start_fr_preview 的 localPreviewConnections 找不到对应库。
 */
function rememberLocalDbConnection(dbName, connection) {
  const conn = String(connection ?? '').trim();
  const db = String(dbName ?? '').trim();
  if (!conn || !db) return;
  try {
    const cfg = readLocalDbConfig();
    const dbs = { ...(cfg.databases || {}) };
    const prev = dbs[db] && typeof dbs[db] === 'object' ? dbs[db] : {};
    if (String(prev.sourceConnection || '').toLowerCase() === conn.toLowerCase()) return;
    dbs[db] = { ...prev, file: `${db}.sqlite`, sourceConnection: conn };
    updateLocalDbConfig({ default: cfg.default || db, databases: dbs });
  } catch {
    // 映射写失败不阻断本地库准备；localPreviewConnections 会返回 local-db-missing 并给出 nextAction。
  }
}

function safeDbSuffix(name, fallback) {
  const s = String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 28);
  return s || fallback;
}

function dbNameFor(base, group, index, total) {
  if (total <= 1) return base;
  const suffix = safeDbSuffix(group.name, `conn${index + 1}`);
  return `${base}__${suffix}`.slice(0, 64);
}

function uniqueBareTables(refs) {
  return [...new Set((refs || [])
    .map((t) => String(t || '').split('.').pop())
    .filter(Boolean))];
}

function addGroup(groups, name, tableRefs, meta) {
  const key = name || '<未声明连接>';
  let group = groups.get(key);
  if (!group) {
    group = {
      name: name || null,
      tables: [],
      datasets: [],
      fillSubmits: [],
      sources: [],
    };
    groups.set(key, group);
  }
  for (const t of uniqueBareTables(tableRefs)) {
    if (!group.tables.includes(t)) group.tables.push(t);
  }
  if (meta.source === 'dataset' && !group.datasets.includes(meta.name)) group.datasets.push(meta.name);
  if (meta.source === 'fill-submit' && !group.fillSubmits.includes(meta.name)) group.fillSubmits.push(meta.name);
  if (!group.sources.includes(meta.source)) group.sources.push(meta.source);
  return group;
}

/**
 * 只读扫描报表的测试环境需求（不建库、不连真实库）。
 *
 * @param {string} cptPath .cpt 路径
 * @param {{connection?:string}} [opts] connection 可选：只关注某个数据连接
 * @returns {{
 *   path:string, exists:boolean, kind:'new'|'existing',
 *   connections:{name:string|null,tables:string[],datasets:string[],fillSubmits:string[],sources:string[]}[],
 *   datasets:object[], fillSubmits:object[], hasFill:boolean, warnings:string[]
 * }}
 */
export function inspectReportTestEnv(cptPath, opts = {}) {
  const abs = path.resolve(String(cptPath || ''));
  const warnings = [];
  if (!cptPath || !fs.existsSync(abs)) {
    return {
      path: abs, exists: false, kind: 'new',
      connections: [], datasets: [], fillSubmits: [], hasFill: false,
      warnings: ['报表文件尚不存在（新建报表）：使用 local_db_admin create + local_db_import ddl/seed 建 SQLite fixture 后测试。'],
    };
  }

  let dsList = [];
  try {
    dsList = datasets(abs);
  } catch (e) {
    warnings.push(`读取数据集失败：${e.message}`);
  }
  let fc = { submits: [] };
  try {
    fc = fillConfig(abs);
  } catch (e) {
    warnings.push(`读取填报配置失败：${e.message}`);
  }

  const groups = new Map();
  for (const ds of dsList) {
    if (!ds.sql || !ds.connection) continue;
    if (opts.connection && String(ds.connection).toLowerCase() !== String(opts.connection).toLowerCase()) continue;
    addGroup(groups, ds.connection, extractTableRefs(ds.sql), { source: 'dataset', name: ds.name });
  }
  for (const submit of fc.submits || []) {
    const conn = submit.dsName || submit.dbName || null;
    if (opts.connection && (!conn || String(conn).toLowerCase() !== String(opts.connection).toLowerCase())) continue;
    const refs = [];
    if (submit.table) refs.push(submit.schema ? `${submit.schema}.${submit.table}` : submit.table);
    if (submit.sql) refs.push(...extractTableRefs(submit.sql), ...extractWriteTableRefs(submit.sql));
    const clean = uniqueBareTables(refs);
    if (!clean.length) {
      if (!conn) warnings.push(`填报提交「${submit.name}」没有声明数据连接，也没有可识别的目标表，无法复制环境`);
      continue;
    }
    addGroup(groups, conn, clean, { source: 'fill-submit', name: submit.name });
  }

  const connections = [...groups.values()];
  if (!connections.length) {
    warnings.push('未发现外部数据连接/表引用；新建报表可直接用 SQLite DDL+seed 造 fixture。');
  }
  return {
    path: abs,
    exists: true,
    kind: 'existing',
    connections,
    datasets: dsList,
    fillSubmits: fc.submits || [],
    hasFill: (fc.submits || []).length > 0,
    warnings,
  };
}

function runtimePlan(plan) {
  const required = plan.hasFill === true;
  const previewConnections = [...new Set(plan.connections.map((c) => c.name).filter(Boolean))];
  return {
    required,
    status: 'unverified',
    previewConnections,
    reason: required
      ? '本地 SQLite 只能验证数据/结构/SQL；填报提交、工具栏、Web 事件与真实入库必须用 fr_preview 实点，当前未验证。'
      : '没有填报提交；本地 SQL 审计可覆盖数据集查询，运行期样式/JS 仍建议用 fr_preview 复查。',
    checklist: required ? [
      '启动 fr_preview 并轮询到 running',
      '启动 start_fr_preview({path})：localTest 缺省 true，会自动把返回的本地 SQLite 连接写入预览 finedb',
      '打开 writeUrl，用真实业务样例（老品/新品各一行）逐项点提交/校验/导入，核对落库结果与回滚',
      '记录 URL、时间、操作步骤和结果；未点过就不能在交付里写「运行期已验证」',
      '提交后用 local_db_import 返回的 writeAudit.runId 调 local_db_admin({action:"write_audit"}) 记录写入行数/次数/时间',
    ] : [],
  };
}

function nextAction(plan, ok, missing) {
  const p = JSON.stringify(plan.path);
  const lines = [];
  if (!ok) {
    lines.push('测试环境未就绪：以下连接/表需要先补数据或结构（外部库只读，禁止写业务库）：');
    for (const m of missing) lines.push(`  · ${m.connection || '<未声明连接>'}：缺表 ${m.tables.join('、')}`);
    lines.push('  A. 有只读真实连接：local_db_import({ action: "report", db: "main", path: ' + p + ' }) 重试（会自动镜像 schema+按需抽样）；');
    lines.push('  B. 无真实连接：用 local_db_import({ action: "ddl" }) + action:"seed" 在本地 SQLite 造同结构/小数据 fixture；');
    return lines.join('\n');
  }
  lines.push(`测试环境已就绪：run_dataset_sql_check({ path: ${p}, target: "local", offline: true }) 校验全部数据集 SQL；`);
  lines.push(`  quality_gate_cpt({ path: ${p} }) 会带本地 SQL 审计。`);
  if (plan.hasFill) {
    lines.push('  填报运行期：start_fr_preview({ path: ' + p + ' }) 的 localTest 缺省 true 会自动写入本地 SQLite 连接 → 打开 writeUrl 实点提交；缺库/缺表会直接拒绝启动。');
    lines.push('  写审计：准备时用 local_db_import({ action:"report", db:"main", path: ' + p + ', writeAudit:true }) 拿 writeAudit.runId；提交后 local_db_admin({ action:"write_audit", db:"main", runId }) 查看写入行数/次数/时间。');
    lines.push('  未完成预览点检前，交付结论必须写「运行期未验证」。');
  }
  return lines.join('\n');
}

/**
 * 准备报表级测试环境：把报表用到的所有外部连接（数据集 + 填报提交目标表）
 * 复制到内置 SQLite（只读镜像 schema + 少量样例数据）。
 *
 * 新建报表（path 不存在）：可选 ddl/table/rows 建 fixture；否则返回建 fixture 的下一步。
 * 已有报表：逐个连接检查本地库；本地已覆盖则复用，未覆盖则调用 autoPrepareLocalDb
 * 从真实库只读镜像/抽样。任何连接/表失败都返回结构化 missing，不会触碰业务库。
 *
 * @param {object} o
 * @param {string} o.db 本地库名（多连接时作为前缀）
 * @param {string} o.path .cpt 路径
 * @param {string} [o.connection] 只准备某个连接
 * @param {number} [o.sampleRows]
 * @param {number} [o.maxTotal]
 * @param {boolean} [o.autoSample]
 * @param {boolean} [o.replace]
 * @param {string} [o.ddl] 新建报表：可选 DDL
 * @param {string} [o.table] 新建报表：可选 seed 表
 * @param {object[]} [o.rows] 新建报表：可选 seed 行
 * @param {object} [o.deps] 测试注入（autoPrepare/listTables/resolveDb/importDdl/seed）
 * @returns {Promise<object>}
 */
export async function prepareReportTestEnv(o = {}) {
  const db = String(o.db ?? '').trim();
  if (!db) throw new Error('prepareReportTestEnv 缺少 db（本地库名）');
  if (!o.path) throw new Error('prepareReportTestEnv 缺少 path（报表 .cpt）');
  const plan = inspectReportTestEnv(o.path, { connection: o.connection });
  const writeAuditCfg = readWriteAuditConfig();
  const writeAuditEnabled = o.writeAudit === true || (o.writeAudit !== false && writeAuditCfg.enabled === true);
  const deps = {
    autoPrepare: autoPrepareLocalDb,
    listTables: listLocalTables,
    resolveDb: resolveLocalDbName,
    importDdl: importDdlIntoLocalDb,
    seed: seedLocalDb,
    ...(o.deps && typeof o.deps === 'object' ? o.deps : {}),
  };
  const base = {
    ok: false,
    mode: 'report',
    kind: plan.kind,
    db,
    path: plan.path,
    sampleRows: o.sampleRows,
    maxTotal: o.maxTotal,
    runtime: runtimePlan(plan),
  };

  // 新建报表：不猜外部环境；只接受显式 DDL/seed 造 SQLite fixture。
  if (plan.kind === 'new') {
    const fixture = { ddl: null, seed: null };
    const warnings = [...plan.warnings];
    try {
      if (o.ddl) fixture.ddl = deps.importDdl({ db, ddl: o.ddl, replace: o.replace === true });
      if (o.table && Array.isArray(o.rows) && o.rows.length) {
        fixture.seed = deps.seed({ db, table: o.table, rows: o.rows, mode: o.seedMode || 'insert' });
      }
    } catch (e) {
      return {
        ...base,
        error: { code: 'fixture_failed', message: e.message },
        warnings,
        nextAction: `新建报表 SQLite fixture 创建失败：${e.message}\n先 local_db_admin({action:"create",db:${JSON.stringify(db)}}) 再 local_db_import({action:"ddl",...}) / {action:"seed",...}`,
      };
    }
    const hasFixture = Boolean(fixture.ddl || fixture.seed);
    return {
      ...base,
      ok: hasFixture,
      fixture,
      warnings,
      nextAction: hasFixture
        ? nextAction(plan, true, [])
        : `新建报表 SQLite fixture 尚未创建。先在本地库造表/样例：local_db_admin({action:"create",db:${JSON.stringify(db)}}) → local_db_import({action:"ddl",db:${JSON.stringify(db)},ddl:"CREATE TABLE ..."}) → local_db_import({action:"seed",db:${JSON.stringify(db)},table:"...",rows:[...]})；也可以直接带 ddl/table/rows 重跑 action:"report"。`,
    };
  }

  const groups = plan.connections;
  if (!groups.length) {
    // 新建报表通常已 create_cpt（path 存在但还没有外部连接）：同样允许显式 DDL/seed 建 fixture。
    const fixture = { ddl: null, seed: null };
    try {
      if (o.ddl) fixture.ddl = deps.importDdl({ db, ddl: o.ddl, replace: o.replace === true });
      if (o.table && Array.isArray(o.rows) && o.rows.length) {
        fixture.seed = deps.seed({ db, table: o.table, rows: o.rows, mode: o.seedMode || 'insert' });
      }
    } catch (e) {
      return {
        ...base,
        error: { code: 'fixture_failed', message: e.message },
        warnings: [...plan.warnings, e.message],
        nextAction: `SQLite fixture 创建失败：${e.message}`,
      };
    }
    const hasFixture = Boolean(fixture.ddl || fixture.seed);
    return {
      ...base,
      ok: hasFixture || plan.kind === 'existing',
      fixture,
      connections: [],
      warnings: plan.warnings,
      nextAction: nextAction(plan, true, []),
    };
  }

  const connResults = [];
  const missing = [];
  const warnings = [...plan.warnings];
  for (const [i, group] of groups.entries()) {
    const dbName = dbNameFor(db, group, i, groups.length);
    const resolved = deps.resolveDb({ db: dbName });
    const dbFile = resolved.file;
    let localTables = [];
    try {
      if (resolved.exists) localTables = deps.listTables(dbName) || [];
    } catch { localTables = []; }
    let missingTables = group.tables.filter((t) => !localTables.includes(t));
    let prepared = missingTables.length === 0;
    let source = prepared ? 'local' : null;
    let result = null;
    let error = null;

    if (!prepared) {
      if (!group.name) {
        error = { code: 'connection_missing', message: '填报提交未声明数据连接，无法从外部库复制环境' };
      } else {
        try {
          result = await deps.autoPrepare({
            db: dbName,
            connection: group.name,
            path: plan.path,
            tables: group.tables,
            sampleRows: o.sampleRows,
            maxTotal: o.maxTotal,
            autoSample: o.autoSample,
            replace: o.replace,
          });
        } catch (e) {
          error = { code: 'prepare_failed', message: e.message };
        }
        if (result && result.ok) {
          source = 'real-readonly';
        } else {
          error = result?.error || error || { code: 'prepare_failed', message: '真实库环境复制失败' };
        }
        try { localTables = deps.listTables(dbName) || []; } catch { /* ignore */ }
        missingTables = group.tables.filter((t) => !localTables.includes(t));
        prepared = missingTables.length === 0;
      }
    }

    if (prepared) rememberLocalDbConnection(dbName, group.name);

    const rec = {
      connection: group.name,
      db: dbName,
      dbFile,
      tables: group.tables,
      datasets: group.datasets,
      fillSubmits: group.fillSubmits,
      prepared,
      source: prepared ? (source || 'local') : null,
      missingTables,
      ...(result ? { schema: result.schema, data: result.data } : {}),
      ...(error ? { error } : {}),
    };
    connResults.push(rec);
    if (!prepared) missing.push({ connection: group.name, tables: missingTables });
  }

  const ok = missing.length === 0;
  // 同一本地库可能被多个连接复用：审计 run 必须按 db 去重，否则后一个 start 会
  // 覆盖 active run/触发器，前一个 runId 永远收不到事件。
  const auditTargets = new Map();
  if (writeAuditEnabled) {
    for (const rec of connResults) {
      if (!rec.prepared || !rec.tables?.length) continue;
      if (!auditTargets.has(rec.db)) auditTargets.set(rec.db, new Set());
      for (const t of rec.tables) auditTargets.get(rec.db).add(t);
    }
    const auditRuns = new Map();
    for (const [auditDb, tables] of auditTargets) {
      try {
        const run = startWriteAuditRun(auditDb, {
          tables: [...tables],
          note: `report:${path.basename(plan.path)}`,
          capture: writeAuditCfg.capture,
        });
        auditRuns.set(auditDb, run);
      } catch (e) {
        warnings.push(`${auditDb}：写审计安装失败：${e.message}`);
      }
    }
    for (const rec of connResults) {
      if (auditRuns.has(rec.db)) rec.writeAudit = auditRuns.get(rec.db);
    }
  }
  for (const rec of connResults) {
    if (rec.error) warnings.push(`${rec.connection || '<未声明连接>'}：${rec.error.message}`);
  }
  const writeAudit = writeAuditEnabled
    ? {
        enabled: true,
        runs: (() => {
          const seen = new Set();
          return connResults
            .filter((c) => c.writeAudit)
            .map((c) => ({ connection: c.connection, db: c.db, runId: c.writeAudit.runId, tables: c.writeAudit.tables }))
            .filter((r) => {
              if (seen.has(r.runId)) return false;
              seen.add(r.runId);
              return true;
            });
        })(),
        nextAction: '打开 start_fr_preview 返回的 writeUrl，手工提交后调用 local_db_admin({ action:"write_audit", db, runId }) 查看写入行数/次数/时间；只记录本地 SQLite，不触碰真实库。',
      }
    : null;
  return {
    ...base,
    ok,
    connections: connResults,
    missing,
    warnings: [...new Set(warnings)],
    ...(writeAudit ? { writeAudit } : {}),
    // FR 内置 org.sqlite.JDBC；本地预览平台可在 adminUrl 用这些同名连接直接指到本地库。
    preview: {
      driver: 'org.sqlite.JDBC',
      connections: connResults
        .filter((c) => c.dbFile)
        .map((c) => ({
          name: c.connection,
          db: c.db,
          url: `jdbc:sqlite://${String(c.dbFile).replace(/\\/g, '/')}`,
          ready: c.prepared === true,
        })),
      note: '本地 SQLite 只能验证数据/结构/SQL；start_fr_preview({path}) 的 localTest 缺省 true 会自动写入这些同名本地连接（只写 jdbc:sqlite），填报仍须在 writeUrl 实点。',
    },
    nextAction: nextAction(plan, ok, missing),
  };
}

/**
 * 给 start_fr_preview 用的本地连接映射：只返回**已就绪**的本地 SQLite 连接。
 * 不在内部环境直接连接生产库；调用方（server.js）拿不到连接或表不齐时拒绝启动预览，
 * 让用户先跑 local_db_import({action:"report"})，而不是继承 finedb 里的外部连接。
 *
 * @param {string} cptPath
 * @returns {{ok:boolean, path:string|null, kind:string, connections:{name:string,db:string,dbFile:string}[], missing:Array, nextAction:string}}
 */
export function localPreviewConnections(cptPath) {
  const plan = inspectReportTestEnv(cptPath);
  const connections = [];
  const missing = [];
  for (const group of plan.connections) {
    if (!group.name) continue; // Excel/内置数据集没有外部连接名
    let resolved;
    try {
      resolved = resolveLocalDbName({ connection: group.name });
    } catch (e) {
      missing.push({ connection: group.name, reason: `本地库名解析失败：${e.message}` });
      continue;
    }
    if (!resolved.exists) {
      missing.push({ connection: group.name, reason: 'local-db-missing' });
      continue;
    }
    let localTables;
    try {
      localTables = listLocalTables(resolved.name);
    } catch (e) {
      missing.push({ connection: group.name, reason: `本地库读取失败：${e.message}` });
      continue;
    }
    const lower = new Set(localTables.map((t) => String(t).toLowerCase()));
    const missingTables = (group.tables || []).filter((t) => !lower.has(String(t).toLowerCase()));
    if (missingTables.length) {
      missing.push({ connection: group.name, reason: 'local-tables-missing', tables: missingTables });
      continue;
    }
    connections.push({ name: group.name, db: resolved.name, dbFile: resolved.file });
  }
  const ok = missing.length === 0;
  return {
    ok,
    path: plan.path,
    kind: plan.kind,
    connections,
    missing,
    ...(ok
      ? { nextAction: '启动 start_fr_preview({path})：MCP 会把上述本地 SQLite 连接写入预览 finedb（只写 jdbc:sqlite）；仍须打开 writeUrl 实点填报。' }
      : {
        nextAction: '本地预览环境未就绪：先 request_deep_tool_access({ path, group:"local_db" }) → '
          + 'local_db_import({ action:"report", db:"main", path }) 复制全部连接+填报目标表，再重试 start_fr_preview。',
      }),
  };
}
