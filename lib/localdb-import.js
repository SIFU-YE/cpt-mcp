// cpt-mcp/lib/localdb-import.js —— 真实库 → 本地 SQLite 的 schema/样例数据导入（2026-11-02）
//
// 用户环境读不到 information_schema（Doris 权限受限），因此元数据走三条只读通道：
//   SHOW TABLES / SHOW FULL COLUMNS / SHOW INDEX（lib/db.js 只读白名单已放行；SHOW CREATE TABLE 仅作兜底）。
//
// 「导哪些表」不靠拍脑袋：
//   ① 显式 tables 列表；
//   ② autoTables:true → 扫描当前项目 .cpt 的数据集 SQL，抽取 **所有深度** 的 FROM/JOIN 引用
//      （含 EXISTS / IN 子查询、FROM (SELECT…)、CTE 体、UNION 各支；字符串/注释里的假表名不算），
//      并按数据连接名过滤（用户 2026-11-02 决策：外部库要联合 CPT-MCP 实际使用情况决定）；
//   ③ 都没有 → 报错并列出真实库前 30 张表，避免静默全量导入。
//
// 数据样例默认不导（schema-only）；sampleRows>0 时才导，并设单表/总量双上限。
import fs from 'node:fs';
import path from 'node:path';
import { datasets, fillConfig } from './cpt.js';
import { resolveConnection, runSelectSql } from './db.js';
import { tokenizeSql, SQL_SKIP_TOKEN_TYPES } from './localdb-sql.js';
import {
  createLocalDb, executeLocalScript, listLocalTables, localTableInfo,
  localSchemaHash, resolveLocalDbName, requireLocalDb, openLocalDb, updateLocalDbConfig,
  readLocalDbSettings,
} from './localdb.js';
import {
  normalizeShowColumn, normalizeShowIndex, buildCreateTableSql,
  extractCreateTableStatements, buildFromMysqlDdl,
} from './localdb-schema.js';

const TABLE_NAME_RE = /^[A-Za-z0-9_$\u4e00-\u9fa5.]+$/;
const MAX_SQL_FILE_BYTES = 5 * 1024 * 1024;

export function assertSafeTableName(name) {
  const t = String(name ?? '').trim();
  if (!TABLE_NAME_RE.test(t)) throw new Error(`表名非法："${t}"（只允许字母/数字/中文/_/$/.）`);
  return t;
}

function quoteSqlIdent(name) {
  return `\`${String(name).replace(/`/g, '``')}\``;
}

// ---------------- 敏感列识别（PII 点名警告；只报列名，绝不回显值） ----------------

/**
 * 疑似敏感列名模式（大小写不敏感；英文按 token/后缀匹配，中文按子串）。
 * 口径：宁可多报（本地测试数据也不应外传），但只点名列名，不打印任何取值。
 */
const SENSITIVE_COLUMN_PATTERNS = Object.freeze([
  /(^|_)(full_?name|real_?name|user_?name|customer_?name|contact_?name|name)$/i,
  /(^|_)(mobile|phone|tel|telephone|contact_?phone)(_?no)?$/i,
  /(^|_)(id_?card|idcard|identity_?no|id_?no)(_?no)?$/i,
  /(^|_)(bank|bank_?card|bank_?account|account_?no)$/i,
  /(^|_)(e_?mail|email|mail)(_?addr(ess)?)?$/i,
  /(^|_)(address|addr|home_?address)$/i,
  /姓名|名字|手机号|手机|电话|身份证|银行卡|银行账号|账户|邮箱|邮件|地址|住址/,
]);

/**
 * 从列名里挑出疑似敏感列（纯函数，便于单测）。
 * @param {Array<string|{name?:string}>} columns 列名数组或列对象数组
 * @returns {string[]} 命中的原始列名（去重、保持顺序）
 */
export function detectSensitiveColumns(columns) {
  const names = (columns || [])
    .map((c) => (typeof c === 'string' ? c : c?.name))
    .filter((n) => n != null && String(n).trim() !== '')
    .map((n) => String(n).trim());
  const hit = [];
  for (const name of names) {
    const low = name.toLowerCase();
    if (SENSITIVE_COLUMN_PATTERNS.some((re) => re.test(low) || re.test(name))) {
      if (!hit.includes(name)) hit.push(name);
    }
  }
  return hit;
}

/** 抽样数据 PII 警告文案（表级；不打印任何值） */
function sensitiveWarning(table, sensitive) {
  return `表 ${table} 含疑似敏感列：${sensitive.join('、')}（仅按样例导入本地测试库，返回体不回显取值；.sqlite/data.sql 请勿提交或外传）`;
}

function clampInt(v, def, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.min(Math.max(Math.trunc(n), min), max);
}

// ---------------- 只读读取真实库元数据 ----------------

/** 列出真实库当前 database 下的表（SHOW TABLES；只读） */
export async function listRealTables(connection) {
  const res = await runSelectSql(connection, 'SHOW TABLES', { maxRows: 1000 });
  const names = [];
  for (const row of res.rows || []) {
    const first = Object.values(row).find((v) => typeof v === 'string' && v.trim());
    if (first) names.push(first.trim());
  }
  return [...new Set(names)];
}

/** SHOW FULL COLUMNS FROM `t`（只读）→ 规范化列结构 */
export async function showFullColumns(connection, table) {
  const t = assertSafeTableName(table);
  const res = await runSelectSql(connection, `SHOW FULL COLUMNS FROM ${quoteSqlIdent(t)}`, { maxRows: 500 });
  return (res.rows || []).map(normalizeShowColumn).filter((c) => c.name);
}

/** SHOW INDEX FROM `t`（只读）→ 规范化索引结构 */
export async function showIndexes(connection, table) {
  const t = assertSafeTableName(table);
  const res = await runSelectSql(connection, `SHOW INDEX FROM ${quoteSqlIdent(t)}`, { maxRows: 1000 });
  return (res.rows || []).map(normalizeShowIndex).filter((i) => i.keyName);
}

/** SHOW CREATE TABLE（兜底通道；lib/db.js 白名单放行后可用） */
export async function showCreateTable(connection, table) {
  const t = assertSafeTableName(table);
  const res = await runSelectSql(connection, `SHOW CREATE TABLE ${quoteSqlIdent(t)}`, { maxRows: 1 });
  const row = (res.rows || [])[0] || {};
  const ddl = Object.values(row).find((v) => typeof v === 'string' && /create\s+table/i.test(v));
  if (!ddl) throw new Error(`SHOW CREATE TABLE ${t} 未返回 DDL`);
  return ddl;
}

// ---------------- 从 .cpt 使用情况推导表清单 ----------------

const SKIP_DIRS = new Set(['node_modules', '.git', '.cpt-mcp', 'temp', 'tmp', 'dist', 'build', 'backup', 'bak', 'target', '.idea', '.vscode']);

/** 递归找 .cpt（有深度/数量上限，避免大工程扫太久） */
export function findCptFiles(root = process.cwd(), { maxFiles = 300, maxDepth = 6 } = {}) {
  const out = [];
  const walk = (dir, depth) => {
    if (out.length >= maxFiles || depth > maxDepth) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      if (out.length >= maxFiles) return;
      if (ent.isDirectory()) {
        if (SKIP_DIRS.has(ent.name) || ent.name.startsWith('.')) continue;
        walk(path.join(dir, ent.name), depth + 1);
      } else if (ent.isFile() && /\.cpt$/i.test(ent.name)) {
        out.push(path.join(dir, ent.name));
      }
    }
  };
  walk(path.resolve(root), 0);
  return out;
}

/** FROM/JOIN 之后的"名字位"停用词：这些不是表名（FROM (SELECT…)、FROM DUAL 等）。 */
const TABLE_REF_STOPWORDS = new Set([
  'SELECT', 'VALUES', 'LATERAL', 'TABLE', 'ONLY', 'WITH', 'DUAL',
  'UNION', 'EXCEPT', 'INTERSECT', 'WHERE', 'GROUP', 'ORDER', 'HAVING', 'LIMIT',
  'SET', 'ON', 'USING', 'FOR', 'LOCK', 'RETURNING', 'OFFSET',
]);

/** 表位锚点：FROM / JOIN（含 STRAIGHT_JOIN 变体）。 */
const TABLE_REF_ANCHORS = new Set(['FROM', 'JOIN', 'STRAIGHT_JOIN']);

/** token → 标识符名字（反引号去壳；其他类型返回 null）。 */
function tokenIdentName(token) {
  if (!token) return null;
  if (token.type === 'word') return token.text;
  if (token.type === 'ident') {
    const raw = token.text;
    if (raw.startsWith('`') && raw.endsWith('`') && raw.length >= 2) return raw.slice(1, -1).replace(/``/g, '`');
    return raw;
  }
  return null;
}

/**
 * 从 SQL 文本提取 FROM/JOIN 引用的表（纯函数）。
 *
 * 2026-11-07 P0 修复：旧实现反复 `replace(/\([^()]*\)/g, ' ')` 去括号"降噪"，会把子查询里的
 * 活引用一起删掉（用户实测 `WHERE EXISTS (SELECT 1 FROM demo_permission …)` 漏表，
 * autoTables 只导入 2 张）。现在改为词法扫描：
 *   - 用 lib/localdb-sql.js 的 tokenizer（字符串/注释/反引号整体成 token），不会在字符串
 *     或注释里误抓表名；
 *   - 任意深度的 FROM/JOIN 都抓（含 EXISTS / IN 子查询、`FROM (SELECT …)`、CTE 体、UNION 各支）；
 *   - 括号内只有出现过 SELECT/WITH（= 子查询体）才认 FROM，避免把 `EXTRACT(YEAR FROM dt)`、
 *     `TRIM(BOTH 'x' FROM col)`、`SUBSTRING(s FROM 1)` 这种函数参数里的 FROM 当成表位；
 *   - `FROM (`（子查询起点）/ `FROM SELECT` 等不抓；schema 限定名只取最后一段裸表名；
 *   - 允许保守 false positive（autoTables 最终会按真实库表清单过滤），但**不能漏真表**。
 *
 * @param {string} sql
 * @returns {string[]} 去重后的裸表名（保持 SQL 里的原始大小写）
 */
export function extractTableRefs(sql) {
  const tokens = tokenizeSql(sql);
  const sig = [];
  for (let i = 0; i < tokens.length; i += 1) {
    if (!SQL_SKIP_TOKEN_TYPES.has(tokens[i].type)) sig.push(i);
  }
  const refs = [];
  const pushRef = (name) => {
    if (!name) return;
    const bare = name.includes('.') ? name.split('.').pop() : name;
    if (!bare || TABLE_REF_STOPWORDS.has(bare.toUpperCase())) return;
    refs.push(bare);
  };
  const depths = []; // 每层括号内是否出现过 SELECT/WITH（= 子查询体）
  for (let k = 0; k < sig.length; k += 1) {
    const t = tokens[sig[k]];
    if (t.type === 'punct') {
      if (t.text === '(') depths.push(false);
      else if (t.text === ')') depths.pop();
      continue;
    }
    if (t.type !== 'word') continue;
    const upper = t.text.toUpperCase();
    if (upper === 'SELECT' || upper === 'WITH') {
      if (depths.length) depths[depths.length - 1] = true;
      continue;
    }
    if (!TABLE_REF_ANCHORS.has(upper)) continue;
    // 括号里且本层没有 SELECT/WITH → 函数参数里的 FROM（EXTRACT/TRIM/SUBSTRING…），不是表位
    if (depths.length && depths[depths.length - 1] !== true) continue;
    let j = k + 1;
    const firstName = tokenIdentName(tokens[sig[j]]);
    if (!firstName) continue; // FROM ( / FROM SELECT / FROM NULL …
    if (TABLE_REF_STOPWORDS.has(firstName.toUpperCase())) continue;
    let name = firstName;
    // schema 限定链：name(.name)* —— 最终只取最后一段（本地镜像按裸表名导入）
    for (;;) {
      const dot = tokens[sig[j + 1]];
      const nxt = tokens[sig[j + 2]];
      if (!dot || dot.type !== 'punct' || dot.text !== '.') break;
      const nm = tokenIdentName(nxt);
      if (!nm || TABLE_REF_STOPWORDS.has(nm.toUpperCase())) break;
      name += `.${nm}`;
      j += 2;
    }
    // `FROM f(...)` 是表值函数而不是表（`FROM (` 已在 firstName 处跳过）
    const after = tokens[sig[j + 1]];
    if (after && after.type === 'punct' && after.text === '(') { k = j; continue; }
    pushRef(name);
    k = j;
  }
  return [...new Set(refs)];
}

/** DML 表位锚点：数据集 SQL 之外，填报提交（自由 SQL）和导入逻辑常用这些写语句。 */
const WRITE_TABLE_ANCHORS = new Set(['UPDATE', 'INSERT', 'REPLACE', 'DELETE', 'TRUNCATE']);

/** 读一个标识符链（schema.table），返回 { name, next }；调用方保证 j 指向名字位。 */
function readIdentChain(tokens, sig, j) {
  const firstName = tokenIdentName(tokens[sig[j]]);
  if (!firstName || TABLE_REF_STOPWORDS.has(firstName.toUpperCase())) return { name: null, next: j };
  let name = firstName;
  let cursor = j;
  for (;;) {
    const dot = tokens[sig[cursor + 1]];
    const nxt = tokens[sig[cursor + 2]];
    if (!dot || dot.type !== 'punct' || dot.text !== '.') break;
    const nm = tokenIdentName(nxt);
    if (!nm || TABLE_REF_STOPWORDS.has(nm.toUpperCase())) break;
    name += `.${nm}`;
    cursor += 2;
  }
  return { name, next: cursor };
}

/**
 * 从写语句（UPDATE / INSERT INTO / REPLACE INTO / DELETE FROM / TRUNCATE TABLE）
 * 提取目标表。与 extractTableRefs 一样走词法 token，字符串/注释里的假表名不会被误抓。
 *
 * 填报提交有两条通道：列映射提交直接带 table；自由 SQL 提交的 SQL 常是
 * `UPDATE t SET ...` / `INSERT INTO t ...`，旧 autoTables 只扫数据集 FROM/JOIN，
 * 会漏掉这些**真正会被写入**的表，导致本地库只建了查询表、没有目标表。
 *
 * @param {string} sql
 * @returns {string[]} 去重后的裸表名（保持原大小写）
 */
export function extractWriteTableRefs(sql) {
  const tokens = tokenizeSql(sql);
  const sig = [];
  for (let i = 0; i < tokens.length; i += 1) {
    if (!SQL_SKIP_TOKEN_TYPES.has(tokens[i].type)) sig.push(i);
  }
  const refs = [];
  const prevWord = (k) => {
    for (let i = k - 1; i >= 0; i -= 1) {
      const w = tokens[sig[i]];
      if (w.type === 'word') return w.text.toUpperCase();
    }
    return null;
  };
  for (let k = 0; k < sig.length; k += 1) {
    const t = tokens[sig[k]];
    if (t.type !== 'word') continue;
    const upper = t.text.toUpperCase();
    if (!WRITE_TABLE_ANCHORS.has(upper)) continue;
    // 避免把 SELECT REPLACE(...) / ON DUPLICATE KEY UPDATE / FOR UPDATE 当写表锚点
    if (upper === 'UPDATE' && ['KEY', 'FOR'].includes(prevWord(k))) continue;
    let j = k + 1;
    let sawInto = false;
    let sawFrom = false;
    while (j < sig.length) {
      const w = tokens[sig[j]];
      if (w.type !== 'word') break;
      const wu = w.text.toUpperCase();
      if ((upper === 'INSERT' || upper === 'REPLACE') && ['IGNORE', 'LOW_PRIORITY', 'DELAYED', 'HIGH_PRIORITY'].includes(wu)) { j += 1; continue; }
      if ((upper === 'INSERT' || upper === 'REPLACE') && wu === 'INTO') { sawInto = true; j += 1; continue; }
      if (upper === 'DELETE' && wu === 'FROM') { sawFrom = true; j += 1; continue; }
      if (upper === 'TRUNCATE' && wu === 'TABLE') { j += 1; continue; }
      break;
    }
    // INSERT/REPLACE 必须带 INTO（否则可能是 SELECT 里的 REPLACE() 函数）；
    // DELETE 必须带 FROM；TRUNCATE 的 TABLE 可省略（MySQL 允许 TRUNCATE t）。
    if ((upper === 'INSERT' || upper === 'REPLACE') && !sawInto) continue;
    if (upper === 'DELETE' && !sawFrom) continue;
    const got = readIdentChain(tokens, sig, j);
    if (!got.name) continue;
    refs.push(got.name.split('.').pop());
  }
  return [...new Set(refs)];
}

/**
 * 扫描模板使用到的表（按连接名过滤）。
 *
 * 2026-11-09：除数据集 SQL 的 FROM/JOIN 外，还纳入**填报提交的目标表**：
 *   · 列映射提交（BuiltInSQLSubmiter）的 dsName + table；
 *   · 自由 SQL 提交（FreeSQLSubmiter）的 dbName + SQL 里的 UPDATE/INSERT/DELETE 表位。
 * 这是「修改已有报表时复制外部环境」的关键：只镜像查询表、不镜像提交目标表，本地填报仍会失败。
 *
 * @param {{connection?:string, root?:string, files?:string[]}} [o]
 * @returns {{tables:string[], files:string[], datasets:{file:string,dataset:string,connection:string,refs:string[]}[],
 *   fillSubmits:{file:string,submit:string,connection:string,refs:string[]}[]}}
 */
export function collectTemplateTableUsage(o = {}) {
  const files = o.files && o.files.length ? o.files : findCptFiles(o.root ?? process.cwd());
  const datasetUsage = [];
  const fillUsage = [];
  for (const file of files) {
    let dsList = [];
    try { dsList = datasets(file); } catch { continue; }
    for (const ds of dsList) {
      if (!ds.sql) continue;
      if (o.connection && ds.connection && String(ds.connection).toLowerCase() !== String(o.connection).toLowerCase()) continue;
      const refs = extractTableRefs(ds.sql);
      if (refs.length) datasetUsage.push({ file, dataset: ds.name, connection: ds.connection, refs });
    }
    let fc = null;
    try { fc = fillConfig(file); } catch { /* 非 flat XML / 结构异常：数据集扫描仍可用 */ }
    for (const submit of fc?.submits || []) {
      const connection = submit.dsName || submit.dbName || null;
      if (o.connection) {
        if (!connection || String(connection).toLowerCase() !== String(o.connection).toLowerCase()) continue;
      }
      const refs = [];
      if (submit.table) refs.push(submit.schema ? `${submit.schema}.${submit.table}` : submit.table);
      if (submit.sql) refs.push(...extractTableRefs(submit.sql), ...extractWriteTableRefs(submit.sql));
      const clean = [...new Set(refs)];
      if (clean.length) fillUsage.push({ file, submit: submit.name, connection, refs: clean });
    }
  }
  const usage = [...datasetUsage, ...fillUsage];
  const tables = [...new Set(usage.flatMap((u) => u.refs).map((t) => t.split('.').pop()))];
  return {
    tables,
    files: [...new Set(usage.map((u) => u.file))],
    datasets: datasetUsage,
    fillSubmits: fillUsage,
  };
}

// ---------------- schema 导入 ----------------

/** P2-5：连接解析回退提示的后缀。成功路径写 warnings；错误/早退路径（throw）也必须带上，
 *  否则用户只看到"表不存在/清单为空"，不知道实际查的是回退后的库。 */
export function connectionFallbackSuffix(resolution, what = '本次镜像/抽样来自回退后的真实连接') {
  const notice = resolution && typeof resolution === 'object' ? resolution.notice : null;
  if (!notice) return '';
  return `\n【注意·数据连接回退】${notice}；${what}，请核对 connection 名是否写错。`;
}

/**
 * 导入 schema 到本地库。
 * @param {object} o
 * @param {string} o.db 本地库名
 * @param {string} o.connection .cpt 里的数据连接名（真实库只读）
 * @param {string[]} [o.tables] 显式表清单
 * @param {boolean} [o.autoTables] 从当前项目 .cpt 数据集 SQL 推导表清单
 * @param {string} [o.root] 项目根（默认 cwd；autoTables 扫描起点）
 * @param {boolean} [o.replace=false] 已存在的本地表：默认 false=跳过（不 DROP）；true=DROP 后重建
 */
export async function importSchemaFromDb(o = {}) {
  const db = String(o.db ?? '').trim();
  if (!db) throw new Error('importSchemaFromDb 缺少 db（本地库名）');
  const connection = o.connection;
  if (!connection) throw new Error('importSchemaFromDb 缺少 connection（.cpt 里的数据连接名，如 Doris）');
  // P2-5：错误/早退路径（SHOW TABLES 空、无表、表不存在、清单读取异常）此前会在写入 warnings 前抛出，
  // notice 丢失 → 用户只看到"表不存在"却不知道查的是回退后的库。这里给所有 throw 追加同一句提示。
  // deps 仅用于测试注入（resolveConnection/listRealTables/createLocalDb），生产不要传。
  const deps = { resolveConnection, listRealTables, createLocalDb, ...(o.deps && typeof o.deps === 'object' ? o.deps : {}) };
  const connectionResolution = deps.resolveConnection(connection);
  const fallback = connectionFallbackSuffix(connectionResolution, '本次镜像的表/列来自回退后的真实连接');
  // P2-1（第三轮独立复验）：本地库建库失败也属于「本地库不可用」早退，notice 同样不能丢
  try {
    deps.createLocalDb(db); // 已存在则幂等返回
  } catch (e) {
    throw new Error(`创建本地库失败：${e.message}${fallback}`);
  }

  let realTables;
  try {
    realTables = await deps.listRealTables(connection);
  } catch (e) {
    throw new Error(`读取真实库表清单失败：${e.message}${fallback}`);
  }
  if (!realTables.length) throw new Error(`真实库连接 "${connection}" 的 SHOW TABLES 返回空（检查 database 配置/权限）${fallback}`);

  let wanted = Array.isArray(o.tables) ? o.tables.map(String) : null;
  let usage = null;
  if ((!wanted || !wanted.length) && o.autoTables) {
    usage = collectTemplateTableUsage({ connection, root: o.root ?? process.cwd() });
    const realSet = new Map(realTables.map((t) => [t.toLowerCase(), t]));
    wanted = usage.tables.map((t) => realSet.get(String(t).toLowerCase())).filter(Boolean);
  }
  if (!wanted || !wanted.length) {
    throw new Error([
      '没有可导入的表。三种方式任选：',
      '  ① tables: ["表1","表2"] 显式指定；',
      '  ② autoTables: true —— 扫描当前项目 .cpt 的数据集 SQL，导入它们实际引用的表（推荐）；',
      `  ③ 真实库现有表（前 30 张）：${realTables.slice(0, 30).join('、')}${realTables.length > 30 ? '…' : ''}`,
    ].join('\n') + fallback);
  }
  const realSet = new Map(realTables.map((t) => [t.toLowerCase(), t]));
  const resolved = [];
  const notFound = [];
  for (const t of wanted) {
    const hit = realSet.get(String(t).toLowerCase());
    if (hit) resolved.push(hit); else notFound.push(t);
  }
  if (!resolved.length) throw new Error(`要导入的表在真实库都不存在：${notFound.join('、')}${fallback}`);

  const existing = new Set(listLocalTables(db));
  const script = [];
  const imported = [];
  const warnings = [];
  const metaRows = [];
  if (connectionResolution?.notice) {
    warnings.push(`数据连接回退：${connectionResolution.notice}；本次镜像的表/列来自回退后的真实连接，请核对 connection 名是否写错`);
  }
  for (const table of resolved) {
    // 2026-11-06 P0：默认 false —— 已存在同名表只跳过、不 DROP；重建须显式 replace:true。
    const replace = o.replace === true;
    if (existing.has(table) && !replace) {
      warnings.push(`本地已存在表 ${table}：replace=false（默认），已跳过；确要 DROP+重建请显式传 replace:true`);
      continue;
    }
    let columns;
    let indexes;
    try {
      [columns, indexes] = await Promise.all([showFullColumns(connection, table), showIndexes(connection, table)]);
    } catch (e) {
      warnings.push(`表 ${table} 元数据读取失败（已跳过）：${e.message}`);
      continue;
    }
    if (!columns.length) { warnings.push(`表 ${table} 的 SHOW FULL COLUMNS 为空（已跳过）`); continue; }
    const built = buildCreateTableSql({ table, columns, indexes });
    warnings.push(...built.warnings);
    if (existing.has(table)) script.push(`DROP TABLE IF EXISTS ${quoteSqlIdent(table)};`);
    script.push(built.sql);
    script.push(...built.indexSql);
    imported.push({
      table,
      columns: columns.length,
      indexes: built.indexSql.length,
      primaryKey: built.primaryKey,
      autoIncrement: built.autoIncrement,
      comments: columns.map((c) => ({ column: c.name, comment: c.comment })).filter((c) => c.comment),
    });
    metaRows.push(['table:' + table, JSON.stringify({
      sourceConnection: connection,
      importedAt: new Date().toISOString(),
      mysqlColumns: columns.map((c) => ({ name: c.name, type: c.type, comment: c.comment })),
      warnings: built.warnings,
    })]);
  }
  if (!imported.length) {
    return { ok: false, db, connection, imported: [], warnings, notFound, note: '没有表被导入（全部被跳过或失败）' };
  }
  const metaInserts = metaRows.map(([k, v]) => `INSERT OR REPLACE INTO __cpt_meta(k,v) VALUES (${sqlLiteral(k)}, ${sqlLiteral(v)});`);
  try {
    executeLocalScript(db, [...script, ...metaInserts].join('\n'));
  } catch (e) {
    throw new Error(`执行建表脚本失败：${e.message}${fallback}`);
  }
  const schemaHash = localSchemaHash(db);
  const cfg = resolveLocalDbName({ db });
  const prev = cfg.config.databases?.[cfg.name] ?? {};
  try {
    updateLocalDbConfig({
      default: cfg.config.default || cfg.name,
      databases: {
        ...(cfg.config.databases || {}),
        [cfg.name]: {
          ...prev,
          file: `${cfg.name}.sqlite`,
          sourceConnection: connection,
          schemaMode: 'mirror',
          syncedAt: new Date().toISOString(),
          schemaHash,
          tables: imported.map((i) => i.table),
        },
      },
    });
  } catch (e) {
    throw new Error(`更新本地库配置失败：${e.message}${fallback}`);
  }
  return {
    ok: true,
    db,
    connection,
    imported,
    notFound,
    warnings: [...new Set(warnings)],
    schemaHash,
    autoTables: Boolean(o.autoTables),
    usageFiles: usage ? usage.files : undefined,
    note: 'schema 已镜像；结构和真实库的差异用 local_db_schema({compareWith:"' + connection + '"}) 核对',
  };
}

// ---------------- 样例数据导入 ----------------

function bindValue(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v instanceof Date) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())} ${pad(v.getHours())}:${pad(v.getMinutes())}:${pad(v.getSeconds())}`;
  }
  if (Buffer.isBuffer(v)) return new Uint8Array(v);
  if (typeof v === 'bigint') return v;
  return v;
}

/**
 * 从真实库导入样例行（只读 SELECT * LIMIT n）→ 覆盖本地同表数据（append=true 追加）。
 *
 * 2026-11-04：`autoTables:true` 时可按模板推导表清单（`path` 指定单个 .cpt；缺省扫 root 下全部 .cpt），
 * 只对本地库已有同名表的表抽样；`sampleRows` 默认 200、`maxTotal` 默认 50000（单表/总量双上限）。
 * 敏感列（name/mobile/phone/id_card/bank/email/address 等）在 warnings 里点名，但绝不回显取值。
 *
 * @param {object} o
 * @param {string} o.db 本地库名
 * @param {string} o.connection 真实库连接名
 * @param {string[]} [o.tables] 表清单（缺省用本地库所有表）
 * @param {boolean} [o.autoTables=false] 未传 tables 时按 .cpt 数据集 SQL 推导表清单（未命中则回退本地全部表）
 * @param {string} [o.path] autoTables 扫描的单个 .cpt（缺省扫 root）
 * @param {string} [o.root] autoTables 扫描起点（缺省 cwd）
 * @param {number} [o.sampleRows=200] 每张表最多导入行数
 * @param {number} [o.maxTotal=50000] 全部表合计上限
 * @param {boolean} [o.append=false]
 * @param {object} [o.deps] 测试注入（{runSelectSql, resolveConnection, listLocalTables}），生产不要传
 */
export async function importDataFromDb(o = {}) {
  const db = String(o.db ?? '').trim();
  if (!db) throw new Error('importDataFromDb 缺少 db');
  const connection = o.connection;
  if (!connection) throw new Error('importDataFromDb 缺少 connection');
  const deps = {
    resolveConnection,
    runSelectSql,
    listLocalTables,
    ...(o.deps && typeof o.deps === 'object' ? o.deps : {}),
  };
  // 2026-11-05 P1-1：保留 resolveConnection 的 notice（单连接回退）→ 写进 warnings，不要静默
  const connectionResolution = deps.resolveConnection(connection);
  // P2-5：requireLocalDb / listLocalTables / 无表 早退此前都在 warnings 之前抛错，notice 会丢
  const fallback = connectionFallbackSuffix(connectionResolution, '本次抽样来自回退后的真实连接');
  try {
    requireLocalDb(db);
  } catch (e) {
    throw new Error(`${e.message}${fallback}`);
  }
  let localTables;
  try {
    localTables = deps.listLocalTables(db);
  } catch (e) {
    throw new Error(`读取本地库 ${db} 表清单失败：${e.message}${fallback}`);
  }
  const warnings = [];
  if (connectionResolution?.notice) {
    warnings.push(`数据连接回退：${connectionResolution.notice}；本次抽样来自回退后的真实连接，请核对 connection 名是否写错`);
  }

  let tables;
  if (Array.isArray(o.tables) && o.tables.length) {
    tables = o.tables.map(String);
  } else if (o.autoTables === true) {
    const usage = collectTemplateTableUsage({
      connection,
      ...(o.path ? { files: [path.resolve(String(o.path))] } : { root: o.root ?? process.cwd() }),
    });
    const wanted = [...new Set((usage.tables || []).map((t) => String(t).split('.').pop()).filter(Boolean))];
    tables = wanted.filter((t) => localTables.includes(t));
    const notLocal = wanted.filter((t) => !localTables.includes(t));
    if (notLocal.length) {
      warnings.push(`autoTables 扫描到但本地库还没有的表（先 local_db_import({action:"schema", autoTables:true}) 补镜像）：${notLocal.join('、')}`);
    }
    if (!tables.length) {
      tables = localTables;
      warnings.push('autoTables 未命中本地表，已回退为本地库全部表（可传 tables 精确指定）');
    }
  } else {
    tables = localTables;
  }
  const missing = tables.filter((t) => !localTables.includes(t));
  tables = tables.filter((t) => localTables.includes(t));
  if (!tables.length) throw new Error(`本地库 ${db} 没有可导入数据的表${missing.length ? `（指定表不存在：${missing.join('、')}）` : ''}，先 local_db_import 导入 schema${fallback}`);
  const sampleRows = Math.min(Math.max(1, Number(o.sampleRows ?? 200)), 5000);
  const maxTotal = Math.min(Math.max(sampleRows, Number(o.maxTotal ?? 50000)), 200000);
  const append = o.append === true;

  const localDb = openLocalDb(db, { internal: true, mustExist: true });
  const results = [];
  let total = 0;
  try {
    localDb.exec('BEGIN IMMEDIATE');
    for (const table of tables) {
      if (total >= maxTotal) { warnings.push(`已达总量上限 ${maxTotal} 行，剩余表未导入`); break; }
      const limit = Math.min(sampleRows, maxTotal - total);
      const info = localTableInfo(db, table);
      const colNames = info.columns.map((c) => c.name);
      // PII：只点名敏感列名，绝不回显取值（2026-11-04）
      const sensitive = detectSensitiveColumns(colNames);
      if (sensitive.length) warnings.push(sensitiveWarning(table, sensitive));
      let sel;
      try {
        // 抽样只走 lib/db.js 的只读通道（SELECT * LIMIT n；写词/多语句/超时围栏都在那一层）
        sel = await deps.runSelectSql(connection, `SELECT * FROM ${quoteSqlIdent(table)} LIMIT ${limit}`, { maxRows: limit });
      } catch (e) {
        warnings.push(`表 ${table} 取样失败（已跳过）：${e.message}`);
        continue;
      }
      const rows = sel.rows || [];
      const unknown = rows.length ? Object.keys(rows[0]).filter((k) => !colNames.includes(k)) : [];
      if (unknown.length) warnings.push(`表 ${table} 真实库列不在本地表中（已忽略）：${unknown.join('、')}`);
      if (!append) localDb.exec(`DELETE FROM ${quoteSqlIdent(table)};`);
      const placeholders = colNames.map(() => '?').join(', ');
      const stmt = localDb.prepare(`INSERT INTO ${quoteSqlIdent(table)} (${colNames.map(quoteSqlIdent).join(', ')}) VALUES (${placeholders})`);
      let inserted = 0;
      for (const row of rows) {
        const values = colNames.map((c) => bindValue(row[c]));
        // 超 64 位整数：SQLite 会退化成 REAL，这里提前提示
        for (let i = 0; i < values.length; i += 1) {
          const v = values[i];
          if (typeof v === 'string' && /^-?\d{19,}$/.test(v) && /INTEGER/i.test(String(info.columns[i]?.type ?? ''))) {
            warnings.push(`表 ${table}.${colNames[i]} 的值 ${v} 超出 SQLite 64 位整数，将按 REAL 存储（精度风险）`);
          }
        }
        stmt.run(...values);
        inserted += 1;
      }
      total += inserted;
      results.push({
        table,
        rows: inserted,
        truncated: sel.truncated === true,
        ...(sensitive.length ? { sensitiveColumns: sensitive } : {}),
      });
    }
    localDb.exec('COMMIT');
  } catch (e) {
    try { localDb.exec('ROLLBACK'); } catch { /* ignore */ }
    throw e;
  } finally {
    try { localDb.close(); } catch { /* ignore */ }
  }
  return { ok: true, db, connection, tables: results, totalRows: total, sampleRows, warnings: [...new Set(warnings)] };
}

// ---------------- 一条命令：真实库 → 本地库（schema + 按需抽样，2026-11-04） ----------------

// settings 读取失败时的兜底（readLocalDbSettings 本身不抛错，这里只是双保险）
const LOCALDB_SETTINGS_FALLBACK = Object.freeze({ sqlTestTarget: 'local', sampleRows: 200, maxTotal: 5000, autoSample: true });

/** autoPrepareLocalDb 的连接缺失/失败引导（不抛错，直接可执行） */
function autoNextAction({ db, connection, path: cptPath, phase }) {
  const dbJson = JSON.stringify(db || 'main');
  const connJson = JSON.stringify(connection || '<数据连接名，如 Doris>');
  const pathJson = JSON.stringify(cptPath || '<模板.cpt 绝对路径>');
  const head = phase === 'connection'
    ? '真实库连接未配置，无法执行 schema 镜像与抽样。两种走法任选：'
    : '真实库导入没有成功。先排查连接/表名，再重试：';
  return [
    head,
    `  A. 配好只读连接后重试：local_db_import({ action: "auto", db: ${dbJson}, connection: ${connJson}, path: ${pathJson} })`,
    '     连接配置见 lib/db.js 的四种写法（CPT_DB_CONNECTIONS / ~/.cpt-mcp/db-connections.json 等），本工具不写任何凭据。',
    `  B. 纯离线自建 fixture（不需要真实库）：local_db_admin({ action: "create", db: ${dbJson} }) → local_db_import({ action: "ddl", db: ${dbJson}, ddl: "CREATE TABLE ..." }) → local_db_import({ action: "seed", db: ${dbJson}, table: "...", rows: [...] })`,
    `  完成后：run_dataset_sql_check({ path: ${pathJson}, target: "local", offline: true, localDb: ${dbJson} })`,
  ].join('\n');
}

/**
 * 真实库按需自动抽样（2026-11-04 用户口径）：**一条命令完成本地库准备**。
 *
 * 流程：
 *   ① 表清单：显式 `tables`；否则按模板推导（`path` 指定的 .cpt，缺省 root 下全部 .cpt）——
 *      复用 `extractTableRefs/collectTemplateTableUsage` 的任意深度 FROM/JOIN 扫描；
 *   ② schema：`importSchemaFromDb`（真实库只读 SHOW TABLES / SHOW FULL COLUMNS / SHOW INDEX）；
 *   ③ 数据：只对**本地还是空表**的表抽样（只读 `SELECT * LIMIT n`，走 lib/db.js 只读通道），
 *      单表 `sampleRows`（默认 200，取 localdb.json settings.sampleRows）与总量 `maxTotal`
 *      （默认 5000，取 settings.maxTotal）双上限；已有数据的表默认跳过（不覆盖本地造数）。
 *
 * 安全：只把真实库的表结构 + 样例行写进本地 SQLite；连接凭据只用于 lib/db.js 的只读连接，
 * 不写 SQLite、不进日志/返回体；敏感列名点名警告（不打印值）。
 *
 * 无真实连接时**不崩溃**：返回 `{ok:false, error:{code:'connection_required'|'schema_import_failed'}, nextAction}`。
 *
 * @param {object} o
 * @param {string} o.db 本地库名
 * @param {string} o.connection .cpt 里的数据连接名（如 Doris）
 * @param {string} [o.path] 模板 .cpt（推导表清单 / nextAction 示例）
 * @param {string} [o.root] 模板扫描起点（缺省 cwd）
 * @param {string} [o.cwd] 读取 `.cpt-mcp/localdb.json` settings 的项目根（缺省 cwd / root）
 * @param {string[]} [o.tables] 显式表清单（给了就不扫模板）
 * @param {number} [o.sampleRows] 单表抽样上限（默认 settings.sampleRows=200）
 * @param {number} [o.maxTotal] 总量上限（默认 settings.maxTotal=5000；也接受 maxTotalRows 别名）
 * @param {boolean} [o.autoSample] false=只镜像结构不抽样（默认 settings.autoSample=true）
 * @param {boolean} [o.replace=false] schema 已存在同名表是否 DROP 重建（默认 false 跳过）
 * @param {object} [o.deps] 测试注入（{importSchema, importData, listLocalTables, localTableInfo, collectUsage}）
 * @returns {Promise<object>} {ok, db, connection, mode:'auto', localDbReady, schema:{tables,created,skipped,warnings},
 *   data:{tables,totalRows,sampleRows,maxTotal,skipped}, warnings, nextAction}
 */
export async function autoPrepareLocalDb(o = {}) {
  const db = String(o.db ?? '').trim();
  if (!db) throw new Error('autoPrepareLocalDb 缺少 db（本地库名）');
  const connection = String(o.connection ?? '').trim();
  const cptPath = o.path ? path.resolve(String(o.path)) : null;
  const settingsCwd = o.cwd || o.root;
  let settings;
  try {
    settings = settingsCwd ? readLocalDbSettings({ cwd: String(settingsCwd) }) : readLocalDbSettings();
  } catch {
    settings = { ...LOCALDB_SETTINGS_FALLBACK };
  }
  const sampleRows = clampInt(o.sampleRows ?? settings.sampleRows, 200, 1, 5000);
  const maxTotal = clampInt(o.maxTotal ?? o.maxTotalRows ?? settings.maxTotal, 5000, 1, 200000);
  const maxTotalEff = Math.max(maxTotal, sampleRows);
  const autoSample = o.autoSample === false ? false : (o.autoSample === true ? true : settings.autoSample !== false);
  const deps = {
    importSchema: importSchemaFromDb,
    importData: importDataFromDb,
    listLocalTables,
    localTableInfo,
    collectUsage: collectTemplateTableUsage,
    resolveConnection,
    // 返回 resolveConnection 的完整结果（含 notice），供 0.5 校验后把静默回退写进 warnings
    validateConnection: (connection) => (o.deps?.resolveConnection || resolveConnection)(connection),
    ...(o.deps && typeof o.deps === 'object' ? o.deps : {}),
  };
  const warnings = [];
  const base = { db, connection: connection || null, mode: 'auto', sampleRows, maxTotal: maxTotalEff };

  // 0) 没有真实连接就不继续（不崩溃；给出可执行 nextAction + 纯离线替代路径）
  if (!connection) {
    return {
      ...base,
      ok: false,
      localDbReady: false,
      error: { code: 'connection_required', message: 'local_db_import({action:"auto"}) 需要 connection（.cpt 里的数据连接名，如 "Doris"）；没有真实库连接时请用 action:"ddl" + action:"seed" 纯离线造 fixture' },
      warnings,
      nextAction: autoNextAction({ db, connection, path: cptPath, phase: 'connection' }),
    };
  }

  // ① 表清单：显式 tables > 模板扫表 > 报错引导（不会静默全量导入真实库）
  let tables = Array.isArray(o.tables) && o.tables.length
    ? [...new Set(o.tables.map((t) => String(t).split('.').pop()).filter(Boolean))]
    : null;
  let usage = null;
  if (!tables) {
    try {
      usage = deps.collectUsage({
        connection,
        ...(cptPath ? { files: [cptPath] } : { root: o.root ?? process.cwd() }),
      });
    } catch (e) {
      return {
        ...base,
        ok: false,
        localDbReady: false,
        error: { code: 'template_scan_failed', message: `扫描模板推导表清单失败：${e.message}` },
        warnings,
        nextAction: autoNextAction({ db, connection, path: cptPath }),
      };
    }
    tables = [...new Set((usage.tables || []).map((t) => String(t).split('.').pop()).filter(Boolean))];
  }
  if (!tables.length) {
    return {
      ...base,
      ok: false,
      localDbReady: false,
      error: {
        code: 'no_tables',
        message: cptPath
          ? `模板 ${cptPath} 里没有找到数据连接 "${connection || '(未指定)'}" 的 SQL 表引用（是不是 Excel/树数据集？或表名都在字符串/注释里）`
          : '没有找到要导入的表：传 tables 显式指定，或用 path 指定 .cpt / 在项目根下放 .cpt 让 autoTables 扫描',
      },
      warnings,
      nextAction: autoNextAction({ db, connection, path: cptPath }),
    };
  }

  // 0.5) 连接名必须可解析：先验连接再建库，避免「建了空库、schema 导入才失败」的残留（独立验收 P2）
  let connectionResolution = null;
  try {
    connectionResolution = (deps.validateConnection || ((c) => (deps.resolveConnection || resolveConnection)(c)))(connection);
  } catch (e) {
    return {
      ...base,
      ok: false,
      localDbReady: false,
      error: {
        code: 'connection_unresolved',
        message: `真实库连接 "${connection}" 不可用：${e.message}；没有真实库时请用 action:"ddl" + action:"seed" 纯离线造 fixture`,
      },
      warnings,
      nextAction: autoNextAction({ db, connection, path: cptPath, phase: 'connection' }),
    };
  }
  // 2026-11-05 P1-1：单连接静默回退必须可见（否则镜像/抽样可能来自非预期库）
  if (connectionResolution?.notice) {
    warnings.push(`数据连接回退：${connectionResolution.notice}；本次镜像/抽样来自回退后的真实连接，请核对 connection 名是否写错；要禁止回退请显式配置该连接`);
  }
  // 2026-11-05 P1-5：抽样口径 caveat 进返回体（此前只在 docs 里）
  if (autoSample && tables.length > 1) {
    warnings.push('按需抽样是逐表只读 SELECT * LIMIT n（不跑 JOIN）：JOIN 后的行数/关联完整性可能与真实库不同；关键报表请用 run_dataset_sql_check({target:"real"}) 复核');
  }

  // 建库（幂等）+ schema 镜像（真实库只读）
  createLocalDb(db);
  let schemaRes = null;
  try {
    schemaRes = await deps.importSchema({ db, connection, tables, root: o.root, replace: o.replace === true });
  } catch (e) {
    return {
      ...base,
      ok: false,
      localDbReady: false,
      error: { code: 'schema_import_failed', message: e.message },
      warnings,
      nextAction: autoNextAction({ db, connection, path: cptPath, phase: 'schema' }),
    };
  }
  const schemaWarnings = [...new Set(Array.isArray(schemaRes?.warnings) ? schemaRes.warnings : [])];
  let localNow = [];
  try { localNow = deps.listLocalTables(db) || []; } catch { localNow = []; }
  const created = (Array.isArray(schemaRes?.imported) ? schemaRes.imported : []).map((i) => (typeof i === 'string' ? i : i?.table)).filter(Boolean);
  const skipped = tables.filter((t) => !created.includes(t));
  const readyTables = tables.filter((t) => localNow.includes(t));
  if (!readyTables.length) {
    return {
      ...base,
      ok: false,
      localDbReady: false,
      error: {
        code: 'schema_import_failed',
        message: `没有表成功镜像到本地库：${schemaRes?.note || schemaWarnings[0] || '真实库表清单里找不到这些表'}`,
      },
      schema: { tables, created, skipped, warnings: schemaWarnings },
      warnings: [...new Set([...warnings, ...schemaWarnings])],
      nextAction: autoNextAction({ db, connection, path: cptPath, phase: 'schema' }),
    };
  }
  if (skipped.length) {
    warnings.push(`以下表未新建（本地已存在或真实库读取失败，已按需继续）：${skipped.join('、')}`);
  }

  // ② 按需抽样：只补"本地还是空表"的表，已有数据默认不动（不覆盖本地造数）
  const data = {
    tables: [],
    totalRows: 0,
    sampleRows,
    maxTotal: maxTotalEff,
    skipped: [],
  };
  if (!autoSample) {
    warnings.push('autoSample=false（或 localdb.json settings.autoSample=false）：已跳过样例数据抽样，只镜像了结构');
  } else {
    const empty = [];
    for (const t of readyTables) {
      try {
        const info = deps.localTableInfo(db, t);
        const n = Number(info?.rows ?? 0);
        if (!n) empty.push(t);
        else data.skipped.push({ table: t, rows: n });
      } catch {
        empty.push(t);
      }
    }
    if (data.skipped.length) {
      warnings.push(`以下本地表已有数据（样例 ${data.skipped.reduce((n, x) => n + x.rows, 0)} 行），跳过抽样以免覆盖本地造数：${data.skipped.map((x) => x.table).join('、')}；要刷新请显式 local_db_import({action:"data", db:${JSON.stringify(db)}, connection:${JSON.stringify(connection)}})`);
    }
    if (empty.length) {
      try {
        const r = await deps.importData({ db, connection, tables: empty, sampleRows, maxTotal: maxTotalEff, append: false });
        data.tables = Array.isArray(r?.tables) ? r.tables : [];
        data.totalRows = Number(r?.totalRows ?? 0);
        warnings.push(...(Array.isArray(r?.warnings) ? r.warnings : []));
      } catch (e) {
        data.error = { message: e.message };
        warnings.push(`样例数据抽样失败（结构已就绪，可稍后重试 action:"data"）：${e.message}`);
      }
    }
  }

  return {
    ...base,
    ok: true,
    localDbReady: true,
    schema: { tables, created, skipped, warnings: schemaWarnings },
    data,
    warnings: [...new Set(warnings)],
    nextAction: [
      `本地库 "${db}" 已就绪：结构 ${created.length} 张表、样例数据 ${data.totalRows} 行（上限 ${sampleRows} 行/表、${maxTotalEff} 行合计）。`,
      `  下一步：run_dataset_sql_check({ path: ${JSON.stringify(cptPath || '<模板.cpt>')}, target: "local", offline: true, localDb: ${JSON.stringify(db)} }) 离线校验；`,
      `  quality_gate_cpt({ path }) 默认带本地 SQL 审计；真实库结论仍以显式 target:"real" 为准。`,
    ].join('\n'),
  };
}

// ---------------- 本地造数 / SQL 文本导入 / DDL 导入 ----------------

/** 本地造数：rows 为对象数组；mode=insert|replace|upsert（upsert 需主键） */
export function seedLocalDb(o = {}) {
  const db = String(o.db ?? '').trim();
  if (!db) throw new Error('seedLocalDb 缺少 db');
  const table = assertSafeTableName(o.table);
  const rows = Array.isArray(o.rows) ? o.rows : null;
  if (!rows || !rows.length) throw new Error('seedLocalDb 需要非空 rows 数组');
  const mode = String(o.mode ?? 'insert').toLowerCase();
  if (!['insert', 'replace', 'upsert'].includes(mode)) throw new Error('mode 只能是 insert / replace / upsert');
  requireLocalDb(db);
  const info = localTableInfo(db, table);
  const colNames = info.columns.map((c) => c.name);
  const pkCols = info.columns.filter((c) => c.pk > 0).map((c) => c.name);
  if (mode === 'upsert' && !pkCols.length) throw new Error(`表 ${table} 没有主键，无法 upsert（改用 replace 或 insert）`);
  for (const [i, row] of rows.entries()) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error(`rows[${i}] 必须是对象`);
    const unknown = Object.keys(row).filter((k) => !colNames.includes(k));
    if (unknown.length) throw new Error(`rows[${i}] 有未知列：${unknown.join('、')}（本地表列：${colNames.join('、')}）`);
  }
  const placeholders = colNames.map(() => '?').join(', ');
  const insertSql = mode === 'replace'
    ? `INSERT OR REPLACE INTO ${quoteSqlIdent(table)} (${colNames.map(quoteSqlIdent).join(', ')}) VALUES (${placeholders})`
    : `INSERT INTO ${quoteSqlIdent(table)} (${colNames.map(quoteSqlIdent).join(', ')}) VALUES (${placeholders})`;
  // 直接打开内部连接做事务（seed 是可信入口；仍只操作本地库文件）
  const local = openInternal(db);
  try {
    local.exec('BEGIN IMMEDIATE');
    const stmt = local.prepare(insertSql);
    let n = 0;
    for (const row of rows) {
      const values = colNames.map((c) => bindValue(row[c] ?? null));
      if (mode === 'upsert') {
        // 用 SQLite 原生 upsert：INSERT ... ON CONFLICT(pk) DO UPDATE SET ...
        const upd = colNames.filter((c) => !pkCols.includes(c)).map((c) => `${quoteSqlIdent(c)}=excluded.${quoteSqlIdent(c)}`);
        const sql = `INSERT INTO ${quoteSqlIdent(table)} (${colNames.map(quoteSqlIdent).join(', ')}) VALUES (${placeholders})`
          + ` ON CONFLICT(${pkCols.map(quoteSqlIdent).join(', ')}) DO UPDATE SET ${upd.length ? upd.join(', ') : 'rowid=rowid'}`;
        local.prepare(sql).run(...values);
      } else {
        stmt.run(...values);
      }
      n += 1;
    }
    local.exec('COMMIT');
    return { ok: true, db, table, rows: n, mode };
  } catch (e) {
    try { local.exec('ROLLBACK'); } catch { /* ignore */ }
    throw e;
  } finally {
    try { local.close(); } catch { /* ignore */ }
  }
}

// 内部连接：不走授权器（仅可信代码）
function openInternal(db) {
  return openLocalDb(db, { internal: true, mustExist: true });
}

/** 导入 SQL 文本/文件（脚本逐句 + 事务） */
export function importSqlIntoLocalDb(o = {}) {
  const db = String(o.db ?? '').trim();
  if (!db) throw new Error('importSqlIntoLocalDb 缺少 db');
  requireLocalDb(db);
  let sql = o.sql != null ? String(o.sql) : null;
  if (sql == null && o.file) {
    const file = path.resolve(String(o.file));
    const st = fs.statSync(file);
    if (st.size > MAX_SQL_FILE_BYTES) throw new Error(`SQL 文件过大（${st.size} B > ${MAX_SQL_FILE_BYTES} B）`);
    sql = fs.readFileSync(file, 'utf8');
  }
  if (!sql || !sql.trim()) throw new Error('importSqlIntoLocalDb 需要 sql 文本或 file 路径');
  const result = executeLocalScript(db, sql);
  return { ok: true, db, ...result };
}

/** 导入 MySQL DDL 文本（离线兜底：没有真实库连接时也能建 fixture） */
export function importDdlIntoLocalDb(o = {}) {
  const db = String(o.db ?? '').trim();
  if (!db) throw new Error('importDdlIntoLocalDb 缺少 db');
  const ddl = String(o.ddl ?? '');
  if (!ddl.trim()) throw new Error('importDdlIntoLocalDb 需要 ddl 文本');
  createLocalDb(db);
  const stmts = extractCreateTableStatements(ddl);
  if (!stmts.length) throw new Error('DDL 里没有 CREATE TABLE 语句');
  const existing = new Set(listLocalTables(db));
  const script = [];
  const imported = [];
  const warnings = [];
  for (const stmt of stmts) {
    let parsed;
    try {
      parsed = buildFromMysqlDdl(stmt);
    } catch (e) {
      warnings.push(`DDL 解析失败（已跳过）：${e.message}`);
      continue;
    }
    warnings.push(...(parsed.parseWarnings || []), ...(parsed.warnings || []));
    // 2026-11-06 P0：默认 false（跳过已存在表，不 DROP）；重建须显式 replace:true。
    const replace = o.replace === true;
    if (existing.has(parsed.table) && !replace) { warnings.push(`本地已存在表 ${parsed.table}：replace=false（默认），已跳过；确要 DROP+重建请显式传 replace:true`); continue; }
    if (existing.has(parsed.table)) script.push(`DROP TABLE IF EXISTS ${quoteSqlIdent(parsed.table)};`);
    script.push(parsed.sql, ...parsed.indexSql);
    imported.push({ table: parsed.table, primaryKey: parsed.primaryKey, autoIncrement: parsed.autoIncrement });
  }
  if (!imported.length) return { ok: false, db, imported: [], warnings, note: '没有表被导入' };
  executeLocalScript(db, script.join('\n'));
  return { ok: true, db, imported, warnings: [...new Set(warnings)], schemaHash: localSchemaHash(db) };
}

function sqlLiteral(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return `'${String(v).replace(/'/g, "''")}'`;
}
