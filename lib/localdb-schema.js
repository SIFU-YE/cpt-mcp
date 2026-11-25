// cpt-mcp/lib/localdb-schema.js —— 真实库 schema → SQLite DDL 映射与结构对账（2026-11-02）
//
// 【约束】用户环境读不到 information_schema（Doris 权限受限），所以 schema 导入走
//   `SHOW FULL COLUMNS` / `SHOW INDEX` / `SHOW CREATE TABLE` 三条只读通道（lib/db.js 新增放行）。
// 本模块是纯函数层：
//   · mysqlTypeToSqlite：MySQL/Doris 类型 → SQLite 类型亲和（带告警）；
//   · buildCreateTableSql：把 SHOW 元数据装配成 SQLite CREATE TABLE + CREATE INDEX；
//   · parseMysqlCreateTable：给没有真实库连接时的 DDL 文本兜底（`source:"ddl"`）；
//   · diffSchemaSnapshots：真实库结构快照 vs 本地 SQLite 结构快照（类型/PK/索引/列）。
//
// 【为什么不追求 100% 等价】SQLite 只有 5 种存储类型亲和；DECIMAL 精度、字符集/排序、
// 生成列、外键、分区、引擎等无法等价。本模块只保证「报表 SQL 用到的结构」对齐，
// 其余差异全部进 warnings/caveats，绝不静默丢。
import { splitSqlStatements } from './localdb-sql.js';

const INT_TYPES = new Set(['tinyint', 'smallint', 'mediumint', 'int', 'integer', 'bigint', 'year', 'bit', 'bool', 'boolean']);
const TEXT_TYPES = new Set(['char', 'varchar', 'tinytext', 'text', 'mediumtext', 'longtext', 'enum', 'set', 'json']);
const BLOB_TYPES = new Set(['blob', 'tinyblob', 'mediumblob', 'longblob', 'binary', 'varbinary']);
const DATE_TYPES = new Set(['date', 'datetime', 'timestamp', 'time']);

function baseType(type) {
  const t = String(type ?? '').trim().toLowerCase();
  const m = t.match(/^([a-z]+)/);
  return m ? m[1] : t;
}

/**
 * MySQL/Doris 类型 → SQLite 类型亲和。
 * @returns {{sqlite:'INTEGER'|'REAL'|'NUMERIC'|'TEXT'|'BLOB', warnings:string[]}}
 */
export function mysqlTypeToSqlite(type) {
  const raw = String(type ?? '').trim();
  const t = baseType(raw);
  const warnings = [];
  if (t === 'bigint') {
    warnings.push('BIGINT 在 SQLite 是有符号 64 位；超过 2^63-1 的值会损失精度（样例导入时会告警）');
    return { sqlite: 'INTEGER', warnings };
  }
  if (INT_TYPES.has(t)) {
    if (t === 'bit') warnings.push(`BIT 列 "${raw}" 按 INTEGER 处理（位串语义与 MySQL 不同）`);
    return { sqlite: 'INTEGER', warnings };
  }
  if (t === 'decimal' || t === 'numeric') {
    warnings.push(`DECIMAL/NUMERIC（${raw}）在 SQLite 用 NUMERIC 亲和，精度/舍入与 MySQL 不完全一致`);
    return { sqlite: 'NUMERIC', warnings };
  }
  if (t === 'float' || t === 'double' || t === 'real') return { sqlite: 'REAL', warnings };
  if (DATE_TYPES.has(t)) {
    if (/timestamp/i.test(raw)) warnings.push('TIMESTAMP 在本地库存为 TEXT，时区语义按宿主本地时间（与真实库可能不同）');
    return { sqlite: 'TEXT', warnings };
  }
  if (TEXT_TYPES.has(t)) {
    if (t === 'json') warnings.push('JSON 在 SQLite 存 TEXT；JSON_EXTRACT 由 SQLite JSON1 提供，复杂路径/报错行为略有差异');
    if (t === 'enum' || t === 'set') warnings.push(`${t.toUpperCase()} 在 SQLite 存 TEXT（未建 CHECK 约束，非法值不会被拦截）`);
    return { sqlite: 'TEXT', warnings };
  }
  if (BLOB_TYPES.has(t)) return { sqlite: 'BLOB', warnings };
  warnings.push(`未知类型 "${raw}" 按 TEXT 处理（请核对是否报表用到的表）`);
  return { sqlite: 'TEXT', warnings };
}

/** 大小写不敏感取字段（mysql2 对 SHOW 结果的键名大小写与 Doris 可能不同） */
function pick(obj, keys) {
  if (!obj || typeof obj !== 'object') return undefined;
  for (const k of keys) {
    if (Object.prototype.hasOwnProperty.call(obj, k)) return obj[k];
    const hit = Object.keys(obj).find((x) => x.toLowerCase() === k.toLowerCase());
    if (hit !== undefined) return obj[hit];
  }
  return undefined;
}

/** 把 SHOW FULL COLUMNS 一行规范化为内部结构 */
export function normalizeShowColumn(row) {
  const field = pick(row, ['Field', 'field', 'COLUMN_NAME', 'column_name']);
  const type = pick(row, ['Type', 'type', 'COLUMN_TYPE', 'column_type']);
  const nullable = pick(row, ['Null', 'null', 'IS_NULLABLE', 'is_nullable']);
  const def = pick(row, ['Default', 'default', 'COLUMN_DEFAULT', 'column_default']);
  const extra = pick(row, ['Extra', 'extra', 'EXTRA']);
  const key = pick(row, ['Key', 'key', 'COLUMN_KEY', 'column_key']);
  const comment = pick(row, ['Comment', 'comment', 'COLUMN_COMMENT', 'column_comment']);
  return {
    name: String(field ?? ''),
    type: String(type ?? ''),
    nullable: String(nullable ?? 'YES').toUpperCase() === 'YES',
    default: def === undefined ? null : def,
    extra: String(extra ?? ''),
    key: String(key ?? ''),
    comment: comment == null ? '' : String(comment),
  };
}

/** 把 SHOW INDEX 一行规范化为内部结构 */
export function normalizeShowIndex(row) {
  return {
    table: String(pick(row, ['Table', 'table', 'TABLE_NAME']) ?? ''),
    nonUnique: Number(pick(row, ['Non_unique', 'non_unique', 'NON_UNIQUE']) ?? 1) === 0 ? 0 : 1,
    keyName: String(pick(row, ['Key_name', 'key_name', 'INDEX_NAME']) ?? ''),
    seq: Number(pick(row, ['Seq_in_index', 'seq_in_index', 'SEQ_IN_INDEX']) ?? 0),
    column: String(pick(row, ['Column_name', 'column_name', 'COLUMN_NAME']) ?? ''),
    indexType: String(pick(row, ['Index_type', 'index_type', 'INDEX_TYPE']) ?? ''),
    expression: pick(row, ['Expression', 'expression']) ?? null,
  };
}

/** 标识符引用（SQLite 双引号；内部名字已经过白名单约束） */
export function quoteIdent(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

function sqlLiteralForDefault(col, warnings) {
  const d = col.default;
  if (d === null || d === undefined) return null;
  const s = String(d);
  const t = baseType(col.type);
  if (/^current_timestamp(\(\d*\))?$/i.test(s)) {
    if (/\(\d+\)$/i.test(s)) warnings.push(`列 ${col.name} 的 DEFAULT ${s} 精度被忽略（SQLite 只到秒）`);
    return 'CURRENT_TIMESTAMP';
  }
  if (DATE_TYPES.has(t) && /^current_date$/i.test(s)) return 'CURRENT_DATE';
  if (/^current_time$/i.test(s)) warnings.push(`列 ${col.name} 的 DEFAULT CURRENT_TIME 未保留（SQLite 无同义默认值）`);
  if (INT_TYPES.has(t) || t === 'decimal' || t === 'numeric' || t === 'float' || t === 'double') {
    if (/^-?\d+(\.\d+)?$/.test(s)) return s;
  }
  if (t === 'bit') {
    const m = s.match(/^b'([01]+)'$/i);
    if (m) return String(parseInt(m[1] || '0', 2));
  }
  // 其它表达式默认值（uuid()/now(3) 等）SQLite 不支持 → 丢弃并告警
  if (/^\(.*\)$/.test(s) || /^[a-z_]+\s*\(/i.test(s)) {
    warnings.push(`列 ${col.name} 的表达式默认值 "${s}" 未迁移（SQLite 不支持该默认值表达式）`);
    return null;
  }
  return `'${s.replace(/'/g, "''")}'`;
}

/**
 * 用 SHOW FULL COLUMNS + SHOW INDEX 的规范化数据装配 SQLite DDL。
 * @param {{table:string, columns:object[], indexes:object[]}} o columns 来自 normalizeShowColumn / indexes 来自 normalizeShowIndex
 * @returns {{sql:string, indexSql:string[], warnings:string[], primaryKey:string[], autoIncrement:string|null}}
 */
export function buildCreateTableSql({ table, columns, indexes = [] }) {
  const warnings = [];
  if (!table) throw new Error('buildCreateTableSql 缺少表名');
  const colList = (columns || []).filter((c) => c && c.name);
  if (!colList.length) throw new Error(`表 ${table} 没有列信息（SHOW FULL COLUMNS 返回空）`);

  // 主键顺序：优先 SHOW INDEX 的 PRIMARY，其次 Key=PRI 的列顺序
  const pkIndex = (indexes || []).filter((i) => String(i.keyName ?? i.name ?? '').toUpperCase() === 'PRIMARY').sort((a, b) => a.seq - b.seq).map((i) => i.column).filter(Boolean);
  const pkCols = pkIndex.length ? pkIndex : colList.filter((c) => String(c.key ?? '').toUpperCase() === 'PRI').map((c) => c.name);
  const colNames = new Set(colList.map((c) => c.name));

  // AUTO_INCREMENT：单列主键 + 整型 + extra 含 auto_increment
  const autoCandidates = colList.filter((c) => /auto_increment/i.test(c.extra) && INT_TYPES.has(baseType(c.type)));
  const autoIncrement = autoCandidates.length === 1 && pkCols.length === 1 && pkCols[0] === autoCandidates[0].name ? autoCandidates[0].name : null;
  if (autoCandidates.length && !autoIncrement) {
    warnings.push(`表 ${table} 的 AUTO_INCREMENT 列 ${autoCandidates.map((c) => c.name).join('、')} 未能映射为 SQLite 自增主键（要求单列整型主键）；导入数据时请显式给主键值`);
  }

  const defs = [];
  for (const col of colList) {
    if (/VIRTUAL GENERATED|STORED GENERATED/i.test(col.extra)) {
      warnings.push(`列 ${col.name} 是生成列（${col.extra}），本地库跳过该列；报表 SQL 如引用它需在本地改用等价表达式`);
      continue;
    }
    if (!colNames.has(col.name)) continue;
    const mapped = mysqlTypeToSqlite(col.type);
    warnings.push(...mapped.warnings.map((w) => `${table}.${col.name}：${w}`));
    // 主键列强制 NOT NULL（SQLite 隐式，但显式写出来更贴近 MySQL 的展示）
    const isPk = pkCols.includes(col.name);
    const parts = [quoteIdent(col.name), mapped.sqlite];
    if (autoIncrement === col.name) {
      parts.push('PRIMARY KEY AUTOINCREMENT');
    } else {
      if (!col.nullable || isPk) parts.push('NOT NULL');
      const lit = sqlLiteralForDefault(col, warnings);
      if (lit !== null) parts.push(`DEFAULT ${lit}`);
    }
    defs.push(`  ${parts.join(' ')}`);
    if (autoIncrement !== col.name && !pkCols.length && /auto_increment/i.test(col.extra)) {
      warnings.push(`表 ${table} 的 ${col.name} 有 AUTO_INCREMENT 但无主键，本地库按普通整型处理`);
    }
  }

  if (pkCols.length && autoIncrement !== pkCols[0]) {
    const pkReal = pkCols.filter((c) => colNames.has(c));
    if (pkReal.length) defs.push(`  PRIMARY KEY (${pkReal.map(quoteIdent).join(', ')})`);
  }

  const sql = `CREATE TABLE ${quoteIdent(table)} (\n${defs.join(',\n')}\n);`;

  // 索引
  const indexSql = [];
  const groups = new Map();
  for (const idx of indexes || []) {
    if (!idx.keyName || idx.keyName.toUpperCase() === 'PRIMARY') continue;
    if (!idx.column && !idx.expression) continue;
    if (/FULLTEXT|SPATIAL|RTREE/i.test(idx.indexType)) {
      warnings.push(`表 ${table} 的索引 ${idx.keyName} 是 ${idx.indexType}，SQLite 不支持，已跳过`);
      continue;
    }
    if (idx.expression) {
      warnings.push(`表 ${table} 的索引 ${idx.keyName} 使用了表达式，SQLite 未迁移`);
      continue;
    }
    if (!colNames.has(idx.column)) {
      warnings.push(`表 ${table} 的索引 ${idx.keyName} 引用了未知列 ${idx.column}，已跳过`);
      continue;
    }
    if (!groups.has(idx.keyName)) groups.set(idx.keyName, []);
    groups.get(idx.keyName).push(idx);
  }
  let n = 0;
  for (const [keyName, list] of groups) {
    list.sort((a, b) => a.seq - b.seq);
    const cols = list.map((i) => i.column);
    const unique = list[0].nonUnique === 0;
    n += 1;
    const idxName = `idx_${table}_${keyName}`.replace(/[^\w\u4e00-\u9fa5]/g, '_').slice(0, 120) || `idx_${table}_${n}`;
    indexSql.push(`CREATE ${unique ? 'UNIQUE ' : ''}INDEX ${quoteIdent(idxName)} ON ${quoteIdent(table)} (${cols.map(quoteIdent).join(', ')});`);
  }
  return { sql, indexSql, warnings, primaryKey: pkCols, autoIncrement };
}

/** 从 SHOW 元数据生成结构快照（与 localSchemaSnapshot 同形状） */
export function schemaSnapshotFromShow({ table, columns, indexes = [] }) {
  const cols = (columns || []).filter((c) => c && c.name);
  const pk = (indexes || []).filter((i) => String(i.keyName ?? i.name ?? '').toUpperCase() === 'PRIMARY').sort((a, b) => a.seq - b.seq).map((i) => i.column);
  const pkFallback = pk.length ? pk : cols.filter((c) => String(c.key ?? '').toUpperCase() === 'PRI').map((c) => c.name);
  const normalizedCols = cols.map((c) => ({
    name: c.name,
    type: mysqlTypeToSqlite(c.type).sqlite,
    mysqlType: c.type,
    notnull: !c.nullable || pkFallback.includes(c.name),
    default: c.default == null ? null : String(c.default),
    pk: pkFallback.indexOf(c.name) + 1 || 0,
    comment: c.comment || '',
  }));
  const groups = new Map();
  for (const idx of indexes || []) {
    if (!idx.keyName || idx.keyName.toUpperCase() === 'PRIMARY' || !idx.column) continue;
    if (!groups.has(idx.keyName)) groups.set(idx.keyName, []);
    groups.get(idx.keyName).push(idx);
  }
  const idxOut = [];
  for (const [keyName, list] of groups) {
    list.sort((a, b) => a.seq - b.seq);
    idxOut.push({ name: keyName, unique: list[0].nonUnique === 0, columns: list.map((i) => i.column) });
  }
  return { [table]: { columns: normalizedCols, indexes: idxOut } };
}

// ---------------- DDL 文本兜底解析 ----------------

function splitTopLevel(body) {
  const parts = [];
  let depth = 0;
  let quote = null;
  let cur = '';
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (quote) {
      cur += ch;
      if (ch === '\\' && i + 1 < body.length) { cur += body[i + 1]; i += 1; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; cur += ch; continue; }
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) { parts.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

/** 解析 MySQL CREATE TABLE 文本（兜底；只覆盖常见列定义/主键/普通/唯一索引） */
export function parseMysqlCreateTable(ddl) {
  const text = String(ddl ?? '');
  const m = text.match(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?`?([\w$\u4e00-\u9fa5.]+)`?\s*\(/i);
  if (!m) throw new Error('无法解析 DDL：未找到 CREATE TABLE (...)');
  const table = m[1].split('.').pop();
  const start = m.index + m[0].length;
  let depth = 1;
  let quote = null;
  let end = -1;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\' && i + 1 < text.length) { i += 1; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
    if (ch === '(') depth += 1;
    else if (ch === ')') { depth -= 1; if (depth === 0) { end = i; break; } }
  }
  if (end < 0) throw new Error('无法解析 DDL：括号不配对');
  const body = text.slice(start, end);
  const warnings = [];
  const columns = [];
  const indexes = [];
  let pkCols = [];
  for (const part of splitTopLevel(body)) {
    if (!part) continue;
    if (/^PRIMARY\s+KEY/i.test(part)) {
      const cols = [...part.matchAll(/`?([\w$\u4e00-\u9fa5]+)`?/g)].map((x) => x[1]);
      // 去掉 PRIMARY/KEY 两个词本身（大写匹配的裸词）
      pkCols = cols.filter((c) => !/^(primary|key|using|btree)$/i.test(c));
      continue;
    }
    if (/^UNIQUE\s+(KEY|INDEX)/i.test(part)) {
      const cols = extractKeyCols(part);
      if (cols.length) indexes.push({ name: indexName(part), nonUnique: 0, seq: 0, column: cols[0], indexType: 'BTREE', expression: null, _cols: cols });
      continue;
    }
    if (/^(KEY|INDEX)\s/i.test(part)) {
      const cols = extractKeyCols(part);
      if (cols.length) indexes.push({ name: indexName(part), nonUnique: 1, seq: 0, column: cols[0], indexType: 'BTREE', expression: null, _cols: cols });
      continue;
    }
    if (/^(CONSTRAINT|FOREIGN\s+KEY|CHECK)\b/i.test(part)) {
      warnings.push(`DDL 约束未迁移：${part.slice(0, 80)}…`);
      continue;
    }
    // 列定义
    const cm = part.match(/^`([^`]+)`\s+([\s\S]+)$/) || part.match(/^([\w$\u4e00-\u9fa5]+)\s+([\s\S]+)$/);
    if (!cm) { warnings.push(`无法解析 DDL 片段：${part.slice(0, 80)}`); continue; }
    const name = cm[1];
    const rest = cm[2];
    const typeMatch = rest.match(/^([a-z]+(?:\s+[a-z]+)?(?:\s*\(\s*[^)]*\))?)/i);
    const type = typeMatch ? typeMatch[1] : 'varchar(255)';
    const upper = rest.toUpperCase();
    const nullable = !/\bNOT\s+NULL\b/.test(upper);
    const autoInc = /\bAUTO_INCREMENT\b/.test(upper);
    const isPk = /\bPRIMARY\s+KEY\b/.test(upper);
    let def = null;
    const dm = rest.match(/\bDEFAULT\s+('(?:[^'\\]|\\.)*'|`[^`]*`|[^\s,]+)/i);
    if (dm) {
      const raw = dm[1];
      if (/^'.*'$/.test(raw)) def = raw.slice(1, -1).replace(/''/g, "'");
      else if (/^b'[01]+'$/i.test(raw)) def = raw;
      else def = raw;
    }
    columns.push({
      name,
      type,
      nullable,
      default: def,
      extra: [autoInc ? 'auto_increment' : '', isPk ? 'PRIMARY' : '', /GENERATED/i.test(upper) ? 'GENERATED' : ''].filter(Boolean).join(' '),
      key: isPk ? 'PRI' : '',
      comment: (rest.match(/COMMENT\s+'((?:[^'\\]|\\.)*)'/i) || [])[1] || '',
    });
  }
  if (pkCols.length) {
    indexes.push(...pkCols.map((column, i) => ({ name: 'PRIMARY', keyName: 'PRIMARY', nonUnique: 0, seq: i + 1, column, indexType: 'BTREE', expression: null })));
  }
  // 索引展开为多行 SHOW INDEX 形态（seq 从 1 起；keyName 与 SHOW 结果对齐）
  const expanded = [];
  for (const idx of indexes) {
    const cols = idx._cols || [idx.column];
    cols.forEach((column, i) => expanded.push({ ...idx, keyName: idx.keyName ?? idx.name, seq: i + 1, column }));
  }
  return { table, columns, indexes: expanded, warnings };
}

function extractKeyCols(part) {
  const m = part.match(/\(([^)]*)\)/);
  if (!m) return [];
  return m[1].split(',').map((s) => s.trim().replace(/^`|`$/g, '').replace(/\s+(ASC|DESC)$/i, '')).filter((c) => c && !/[()]/.test(c));
}

function indexName(part) {
  const m = part.match(/^(?:UNIQUE\s+)?(?:KEY|INDEX)\s+`?([\w$\u4e00-\u9fa5]+)`?/i);
  return m ? m[1] : `idx_${Date.now()}`;
}

// ---------------- 结构对账 ----------------

const TYPE_EQUIV = new Map([
  ['INT', 'INTEGER'], ['INTEGER', 'INTEGER'], ['BIGINT', 'INTEGER'], ['TINYINT', 'INTEGER'], ['SMALLINT', 'INTEGER'],
  ['NUMERIC', 'NUMERIC'], ['DECIMAL', 'NUMERIC'], ['REAL', 'REAL'], ['DOUBLE', 'REAL'], ['FLOAT', 'REAL'],
  ['TEXT', 'TEXT'], ['VARCHAR', 'TEXT'], ['CHAR', 'TEXT'], ['BLOB', 'BLOB'],
]);

function normType(t) {
  const u = String(t ?? '').trim().toUpperCase().replace(/\(.*\)/, '');
  return TYPE_EQUIV.get(u) ?? u;
}

/**
 * 结构对账：expected（真实库快照）vs actual（本地库快照）。
 * 两者形状均为 {table: {columns:[{name,type,notnull,pk?}], indexes:[{name,unique,columns}]}}。
 * @returns {{match:boolean, missingTables:string[], extraTables:string[], issues:object[], tables:object}}
 */
export function diffSchemaSnapshots(expected, actual) {
  const exp = expected || {};
  const act = actual || {};
  const missingTables = Object.keys(exp).filter((t) => !act[t]);
  const extraTables = Object.keys(act).filter((t) => !exp[t]);
  const issues = [];
  const tables = {};
  for (const t of Object.keys(exp)) {
    if (!act[t]) continue;
    const e = exp[t];
    const a = act[t];
    const eCols = new Map((e.columns || []).map((c) => [String(c.name).toLowerCase(), c]));
    const aCols = new Map((a.columns || []).map((c) => [String(c.name).toLowerCase(), c]));
    const missingColumns = [...eCols.keys()].filter((c) => !aCols.has(c));
    const extraColumns = [...aCols.keys()].filter((c) => !eCols.has(c));
    const typeMismatch = [];
    for (const [k, ec] of eCols) {
      const ac = aCols.get(k);
      if (!ac) continue;
      if (normType(ec.type) !== normType(ac.type)) typeMismatch.push({ column: ec.name, expected: normType(ec.type), local: normType(ac.type) });
    }
    const ePk = (e.columns || []).filter((c) => Number(c.pk) > 0).map((c) => c.name);
    const aPk = (a.columns || []).filter((c) => Number(c.pk) > 0).map((c) => c.name);
    const pkMismatch = JSON.stringify(ePk) !== JSON.stringify(aPk) ? { expected: ePk, local: aPk } : null;
    const eIdx = (e.indexes || []).map((i) => `${i.unique ? 'U' : ''}(${i.columns.join(',')})`).sort();
    const aIdx = (a.indexes || []).filter((i) => i.origin !== 'pk').map((i) => `${i.unique ? 'U' : ''}(${i.columns.join(',')})`).sort();
    const missingIndexes = eIdx.filter((i) => !aIdx.includes(i));
    const extraIndexes = aIdx.filter((i) => !eIdx.includes(i));
    if (missingColumns.length) issues.push({ table: t, kind: 'missing-column', detail: missingColumns });
    if (extraColumns.length) issues.push({ table: t, kind: 'extra-column', detail: extraColumns });
    if (typeMismatch.length) issues.push({ table: t, kind: 'type-mismatch', detail: typeMismatch });
    if (pkMismatch) issues.push({ table: t, kind: 'primary-key-mismatch', detail: pkMismatch });
    if (missingIndexes.length) issues.push({ table: t, kind: 'missing-index', detail: missingIndexes });
    if (extraIndexes.length) issues.push({ table: t, kind: 'extra-index', detail: extraIndexes });
    tables[t] = {
      columns: { expected: eCols.size, local: aCols.size },
      issues: issues.filter((i) => i.table === t).map((i) => i.kind),
    };
  }
  return {
    match: missingTables.length === 0 && extraTables.length === 0 && issues.length === 0,
    missingTables,
    extraTables,
    issues,
    tables,
  };
}

/** 把 SHOW CREATE TABLE 的文本解析后再生成 CREATE 语句（DDL 兜底入口） */
export function buildFromMysqlDdl(ddl) {
  const parsed = parseMysqlCreateTable(ddl);
  const built = buildCreateTableSql({ table: parsed.table, columns: parsed.columns, indexes: parsed.indexes });
  return { ...built, table: parsed.table, parseWarnings: parsed.warnings };
}

/** 把 DDL 里的多张表拆出来（先给 local_db_import 的 ddl 入口用；无匹配返回空数组） */
export function extractCreateTableStatements(script) {
  return splitSqlStatements(String(script ?? '')).filter((s) => /^\s*CREATE\s+TABLE/i.test(s));
}
