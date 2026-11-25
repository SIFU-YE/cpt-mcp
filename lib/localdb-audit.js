// cpt-mcp/lib/localdb-audit.js —— 模板全部 SQL 数据集的离线审计（本地 SQLite，不连真实库）
//
// 定位（2026-11-02 用户决策：本地 SQL 审计「一步到位」进 quality_gate_cpt 的 blocker 层）：
//   · quality_gate_cpt 默认开启本审计；本地库没配置/没建 → 整体 enabled=false，不产生 blocker（零回归）；
//   · 能定位到「模板自身写错了」的问题 → blocker（SQL 在本地库都 prepare 不过 / 返回列与 dsColumn 绑定对不上）；
//   · 只是「本地环境没准备好」的问题 → warning（缺表/缺列/方言缺口/未解析 FR 参数），
//     绝不把环境问题误判成报表错误（否则用户会去改本来正确的模板）。
//
// 判据：
//   1) 本地库存在（按数据连接映射），否则跳过；
//   2) 数据集 SQL 代入参数（没有运行时参数 → 只检测语法/列，不执行）；
//   3) 方言改写后 prepare（`stmt.columns()` 可拿到返回列，不执行数据）——
//      未解析参数按 null → formula-empty → all-empty 三档占位依次试，取第一个能过的，
//      公式型 ${if(...)} 落表达式位（WHERE 1=1 ${if(...)}）不再被 NULL 占位误报成语法 blocker；
//   4) SQL 返回列 vs 模板 DSColumn 绑定做双向 diff。
import { datasets } from './cpt.js';
import {
  datasetBindings, substituteParams, diffBindings, extractTokens,
  prepareWithMaskStrategies, maskStrategyLabel,
} from './sql-check.js';
import { resolveLocalDbName, prepareLocalSql, localDbGuide } from './localdb.js';

/**
 * 把未解析的 FR `${...}` 令牌全部替换成 NULL（旧口径，保留导出兼容）；
 * 审计/离线校验已改用 `sql-check.js` 的三档候选（见 prepareWithMaskStrategies）。
 */
export function maskUnresolvedTokens(sql) {
  return String(sql ?? '').replace(/\$\{[\s\S]*?\}/g, ' NULL ');
}

/**
 * 审计一个模板里所有 SQL 数据集。
 * @param {string} cptPath .cpt 绝对路径
 * @param {{db?:string, connection?:string, maxDatasets?:number}} [opts]
 * @returns {{enabled:boolean, reason?:string, hint?:string, db?:string, source?:string,
 *   datasets:object[], blockers:object[], warnings:object[], dialectIssues:object[], note:string}}
 */
export function auditTemplateLocalSql(cptPath, opts = {}) {
  const out = {
    enabled: false,
    datasets: [],
    blockers: [],
    warnings: [],
    dialectIssues: [],
    note: '本地 SQL 审计（SQLite 离线 prepare，不连真实库）：能定位模板自身错误的问题进 blockers；本地库不全/方言缺口只进 warnings',
  };
  let dsList;
  try {
    dsList = datasets(cptPath);
  } catch (e) {
    return { ...out, reason: `模板无法解析：${e.message}` };
  }
  const sqlDatasets = dsList.filter((d) => d.sql && String(d.sql).trim());
  if (!sqlDatasets.length) return { ...out, enabled: false, reason: '模板没有 SQL 数据集（Excel/树数据集不适用本地 SQL 审计）' };

  // 解析本地库：优先显式 db；否则按各数据集的 connection 映射（要求至少一个能命中）
  const resolvedFor = (connection) => {
    if (opts.db) return resolveLocalDbName({ db: opts.db });
    return resolveLocalDbName({ connection: opts.connection || connection });
  };
  const first = resolvedFor(sqlDatasets[0].connection);
  if (!first.exists) {
    return {
      ...out,
      reason: `本地 SQLite 测试库未初始化（解析到 "${first.name}"：${first.file}）`,
      hint: localDbGuide(first.name),
    };
  }
  out.enabled = true;
  out.db = first.name;
  out.source = first.source;

  let bindings;
  try { bindings = datasetBindings(cptPath); } catch { bindings = new Map(); }
  const maxDatasets = Math.min(Math.max(1, Number(opts.maxDatasets ?? 50)), 200);
  let checked = 0;
  for (const ds of sqlDatasets) {
    if (checked >= maxDatasets) {
      out.warnings.push({ code: 'local_sql_audit_truncated', message: `模板 SQL 数据集超过 ${maxDatasets} 个，其余未审计（可传 localSqlAuditMaxDatasets 调整）` });
      break;
    }
    checked += 1;
    const rec = auditOneDataset({ cptPath, ds, bindings, resolvedFor });
    out.datasets.push(rec);
    for (const b of rec.blockers) out.blockers.push(b);
    for (const w of rec.warnings) out.warnings.push(w);
    for (const d of rec.dialectIssues) out.dialectIssues.push({ dataset: ds.name, ...d });
  }
  return out;
}

function auditOneDataset({ cptPath, ds, bindings, resolvedFor }) {
  const rec = {
    dataset: ds.name,
    connection: ds.connection,
    status: 'skipped',
    blockers: [],
    warnings: [],
    dialectIssues: [],
    columns: [],
    unresolvedParams: [],
    localDb: null,
    // 未解析参数的占位策略：'null' | 'formula-empty' | 'all-empty'；null=未占位/不适用
    paramMaskStrategy: null,
  };
  const resolved = resolvedFor(ds.connection);
  rec.localDb = resolved.name;
  if (!resolved.exists) {
    rec.status = 'skipped';
    rec.warnings.push({ code: 'local_db_missing', dataset: ds.name, message: `数据连接 "${ds.connection}" 没有对应的本地库表结构（解析到 ${resolved.name}），跳过` });
    return rec;
  }

  const sourceSql = String(ds.sql);
  let substituted;
  try {
    substituted = substituteParams(sourceSql, {});
  } catch (e) {
    rec.status = 'warning';
    rec.warnings.push({ code: 'param_substitute_failed', dataset: ds.name, message: `参数代入失败：${e.message}` });
    return rec;
  }
  rec.unresolvedParams = substituted.unresolved || [];
  const tokens = extractTokens(sourceSql);
  let prep;
  let attempted = [];
  if (substituted.unresolved.length) {
    // 2026-11-07 P0：公式型参数落表达式位时，NULL 占位会拼出 `WHERE 1=1 NULL` 语法错；
    // 按 null → formula-empty → all-empty 三档依次 prepare，取第一个成功的。
    const picked = prepareWithMaskStrategies(
      (sqlTry) => prepareLocalSql(resolved.name, sqlTry, { mustExist: true }),
      substituted.sql,
    );
    prep = picked.prep;
    attempted = picked.attempted;
    if (picked.ok) rec.paramMaskStrategy = picked.strategy;
  } else {
    prep = prepareLocalSql(resolved.name, substituted.sql, { mustExist: true });
  }
  rec.dialectIssues = (prep.dialectIssues || []).filter((i) => i.code !== 'optimizer_hint_removed');

  if (!prep.ok) {
    const kind = prep.error?.kind ?? 'other';
    const detail = prep.error?.detail ? `（${prep.error.detail}）` : '';
    if (kind === 'syntax') {
      // 三档占位（NULL / 公式空串 / 全空串）都过不了 prepare → 可能确实是模板 SQL 错，
      // 也可能公式参数在拼 SQL 片段；含参数令牌时按"无法离线判定"降级为 warning（不新增 blocker）
      if (tokens.length) {
        rec.status = 'warning';
        rec.warnings.push({
          code: 'local_sql_syntax_with_params', dataset: ds.name,
          message: `SQL 含 ${tokens.length} 个 FR 参数令牌，三档占位策略（${(attempted.length ? attempted : ['null']).join('/')}）均无法 prepare（可能是公式型参数拼接 SQL 片段）${detail}`,
          hint: '这一类无法离线判定；请用 run_dataset_sql_check({target:"real"}) 或传 params 后在本地跑',
        });
      } else {
        rec.status = 'blocker';
        rec.blockers.push({
          code: 'local_sql_syntax',
          dataset: ds.name,
          message: `数据集 "${ds.name}" 的 SQL 无法通过 SQLite 语法解析${detail}`,
          fix: '先 get_datasets 核对 SQL；把 SQL 存成候选后 run_dataset_sql_check({path, datasetName, sql, target:"real"}) 确认真实库结论，再 update_dataset 修正',
        });
      }
    } else if (kind === 'missing-table') {
      rec.status = 'warning';
      rec.warnings.push({
        code: 'local_db_missing_table', dataset: ds.name,
        message: `本地库缺表 ${detail || prep.error.detail}，无法离线校验该数据集`,
        fix: `local_db_import({action:"schema", db:"${resolved.name}", connection:"${ds.connection}", autoTables:true}) 补齐镜像表`,
      });
    } else if (kind === 'missing-column') {
      rec.status = 'warning';
      rec.warnings.push({
        code: 'local_db_schema_mismatch', dataset: ds.name,
        message: `本地库表结构缺列 ${detail || prep.error.detail}（可能镜像过期或未导入该表）`,
        fix: `local_db_import({action:"schema", db:"${resolved.name}", connection:"${ds.connection}", autoTables:true}) 重新镜像，或 local_db_schema({db:"${resolved.name}", compareWith:"${ds.connection}"}) 看差异`,
      });
    } else if (kind === 'denied') {
      rec.status = 'warning';
      rec.warnings.push({ code: 'local_sql_denied', dataset: ds.name, message: `本地库安全围栏拒绝：${prep.error.message}` });
    } else {
      rec.status = 'warning';
      rec.warnings.push({
        code: 'local_sql_prepare_failed', dataset: ds.name,
        message: `本地库 prepare 失败：${prep.error?.message ?? '未知错误'}`,
        hint: '这可能是本地库结构/方言限制，不等于是报表 SQL 错误；请以真实库 run_dataset_sql_check 结论为准',
      });
    }
    return rec;
  }

  rec.status = 'pass';
  rec.columns = prep.columns || [];
  if (rec.unresolvedParams.length) {
    rec.warnings.push({
      code: 'local_sql_masked_params', dataset: ds.name,
      message: `有 ${rec.unresolvedParams.length} 个 FR 参数未解析，已按「${maskStrategyLabel(rec.paramMaskStrategy)}」占位做语法/列名审计（只校验语法/列名，未校验参数过滤语义）`,
      hint: '如需验证参数分支：传 params 用 run_dataset_sql_check({target:"local"})，或提交 sql 候选后用 target:"real" 核对',
      paramMaskStrategy: rec.paramMaskStrategy,
    });
  }
  // 列名对账（SQL 返回列 vs 模板 DSColumn 绑定）
  const boundCols = bindings.get(ds.name) || new Map();
  if (boundCols.size && rec.columns.length) {
    const diff = diffBindings(boundCols, rec.columns);
    rec.bindingCheck = {
      boundColumns: boundCols.size,
      returnedColumns: rec.columns.length,
      matched: diff.matched,
      missingInSql: diff.missingInSql,
      unboundInSql: diff.unboundInSql,
    };
    if (diff.missingInSql.length) {
      rec.status = 'blocker';
      rec.blockers.push({
        code: 'local_sql_binding',
        dataset: ds.name,
        message: `数据集 "${ds.name}" 的 SQL 未返回 ${diff.missingInSql.length} 个被单元格绑定的列：${diff.missingInSql.slice(0, 10).map((m) => `${m.column}（引用 ${m.referencedBy.join('/')}）`).join('、')}`,
        fix: '对齐 SQL 返回列与单元格 dsColumn 绑定：改 SQL（update_dataset）或改绑定（set_cell_content_type），改完重跑 quality_gate_cpt',
      });
    }
    if (diff.unboundInSql.length) {
      rec.warnings.push({
        code: 'local_sql_unbound_columns', dataset: ds.name,
        message: `SQL 多返回 ${diff.unboundInSql.length} 列未被任何单元格使用（不影响功能，可能是查多了）：${diff.unboundInSql.slice(0, 8).join('、')}`,
      });
    }
  }
  const gapCount = rec.dialectIssues.length;
  if (gapCount) {
    rec.warnings.push({
      code: 'local_sql_dialect_gap', dataset: ds.name,
      message: `方言改写有 ${gapCount} 处本地限制（不影响真实库结论）：${[...new Set(rec.dialectIssues.map((i) => i.code))].join('、')}`,
      hint: '以真实库 run_dataset_sql_check({target:"real"}) 为准；本地缺口见 docs/local-sqlite.md',
    });
  }
  return rec;
}

/** 供 quality.js 用：只取 blocker 形态（severity/source/location/message/fix） */
export function localSqlAuditBlockers(audit) {
  if (!audit?.enabled) return [];
  return (audit.blockers || []).map((b) => ({
    severity: 'error',
    source: 'local_sql',
    location: `数据集 ${b.dataset}`,
    message: b.message,
    fix: b.fix,
  }));
}

/** 供 quality.js 用：warning 形态进 advisories */
export function localSqlAuditWarnings(audit) {
  if (!audit?.enabled) return [];
  return (audit.warnings || []).map((w) => ({
    severity: 'warning',
    source: 'local_sql',
    location: w.dataset ? `数据集 ${w.dataset}` : '本地 SQL 审计',
    message: w.message,
    fix: w.fix || w.hint || '本地库/方言限制，不阻断交付；如需补齐请按 message 中的工具建议操作',
  }));
}
