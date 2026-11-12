// cpt-mcp/lib/db.js —— 数据连接配置解析 + 只读 SQL 执行器（2026-10-26）
//
// 背景（v1 会话实测）：cpt-mcp 完全没有数据库能力，模板数据集 SQL 只能在 `mcp__doris__*`
// 里手工跑（该会话 487 次查询），改完 SQL 再手动同步进 .cpt —— 两份事实源靠人肉对齐。
// 本模块给 cpt-mcp 补上"只读执行"这一层，供 run_dataset_sql_check 使用。
//
// 安全边界（M145 口径）：
//   · 只允许 SELECT / WITH / SHOW / DESC / DESCRIBE / EXPLAIN 单语句；
//   · mysql2 连接强制 multipleStatements:false（服务端双重保险）；
//   · 统一套 LIMIT（缺省时追加）+ 行数上限 + 客户端超时（超时即 destroy 连接）；
//   · 凭据只从环境变量/本地配置文件读，绝不写进 cpt、不打印密码。
//
// 配置来源（优先级从高到低）：
//   1) 环境变量 CPT_DB_CONNECTIONS = JSON：{"Doris":{"host":"...","port":39030,"user":"...","password":"...","database":"bi_ods"}}
//   2) 环境变量 CPT_DB_CONN_FILE 指向的 JSON 文件
//   3) 当前会话工作目录下的 db-connections.json（workspace 局部覆盖）
//   4) 用户级 ~/.cpt-mcp/db-connections.json（**推荐**：与安装位置无关，重装/换工程都不丢）
//   5) 安装目录（仓库根）下的 db-connections.json（本机开发用；全局安装时是 npm 目录，重装会丢）
//   6) 单连接环境变量：CPT_DB_HOST / CPT_DB_PORT / CPT_DB_USER / CPT_DB_PASSWORD / CPT_DB_DATABASE
//      连接名取 CPT_DB_NAME（缺省 "Doris"，与设计器里常见的数据连接名对齐）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.dirname(MODULE_DIR);
const DEFAULT_CONN_NAME = 'Doris';
const HARD_MAX_ROWS = 1000;

/** 配置文件候选路径（按优先级；后者只在前者不存在/非法时生效） */
export function configFileCandidates() {
  const list = [];
  if (process.env.CPT_DB_CONN_FILE) list.push(process.env.CPT_DB_CONN_FILE);
  list.push(path.join(process.cwd(), 'db-connections.json'));
  list.push(path.join(os.homedir(), '.cpt-mcp', 'db-connections.json'));
  list.push(path.join(REPO_ROOT, 'db-connections.json'));
  return list;
}

function readJsonFile(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function normalizeConn(name, raw) {
  if (!raw || typeof raw !== 'object') return null;
  const host = raw.host || raw.hostname;
  const user = raw.user || raw.username;
  if (!host || !user) return null;
  const port = Number(raw.port ?? 3306);
  return {
    name,
    host: String(host),
    port: Number.isFinite(port) && port > 0 ? port : 3306,
    user: String(user),
    password: raw.password == null ? '' : String(raw.password),
    database: raw.database || raw.db || undefined,
    connectTimeoutMs: Number(raw.connectTimeoutMs ?? 10000),
  };
}

/** 读出全部已配置连接（name -> config）；无配置返回空对象 */
export function listConnections() {
  const out = {};
  const merge = (obj) => {
    if (!obj || typeof obj !== 'object') return;
    for (const [k, v] of Object.entries(obj)) {
      const c = normalizeConn(k, v);
      if (c) out[k] = c;
    }
  };
  const envJson = process.env.CPT_DB_CONNECTIONS;
  if (envJson) {
    try { merge(JSON.parse(envJson)); } catch { /* 忽略非法 JSON，落到其它来源 */ }
  }
  // 文件来源：按优先级逐个尝试，**第一个能解析出连接的生效**（避免多个文件互相打架）
  // CPT_DB_DISABLE_CONFIG_FILES=1 供单测/排查时彻底关掉文件来源（只认环境变量）
  if (!Object.keys(out).length && process.env.CPT_DB_DISABLE_CONFIG_FILES !== '1') {
    for (const p of configFileCandidates()) {
      const parsed = readJsonFile(p);
      if (parsed && typeof parsed === 'object') {
        merge(parsed);
        if (Object.keys(out).length) break;
      }
    }
  }

  if (process.env.CPT_DB_HOST) {
    const name = process.env.CPT_DB_NAME || DEFAULT_CONN_NAME;
    const c = normalizeConn(name, {
      host: process.env.CPT_DB_HOST,
      port: process.env.CPT_DB_PORT,
      user: process.env.CPT_DB_USER,
      password: process.env.CPT_DB_PASSWORD,
      database: process.env.CPT_DB_DATABASE,
    });
    if (c) out[name] = c;
  }
  return out;
}

function configGuide() {
  return [
    '数据库连接未配置。cpt-mcp 只读执行数据集 SQL 需要一份连接配置，四种写法任选：',
    '  ① 环境变量 CPT_DB_CONNECTIONS=\'{"Doris":{"host":"...","port":39030,"user":"...","password":"...","database":"bi_ods"}}\'',
    '  ② 用户级文件 ~/.cpt-mcp/db-connections.json（推荐：与安装位置无关，重装不丢）',
    '  ③ 当前工作目录下的 db-connections.json（只对当前工程生效）',
    '  ④ 环境变量 CPT_DB_CONN_FILE 指向任意 JSON 文件',
    '文件格式：{"Doris":{"host":"...","port":39030,"user":"...","password":"...","database":"bi_ods"}}',
    '键名要与 .cpt 数据集里的"数据连接名"一致（见 get_datasets 的 connection 字段）。',
  ].join('\n');
}

/**
 * 解析连接：优先按名字精确匹配；名字查不到但只配了一个连接时回退到它（并给出 notice）。
 * @param {string} [name] .cpt 里的数据连接名（如 "Doris"）
 * @returns {{conn: object, notice: string|null}}
 */
export function resolveConnection(name) {
  const all = listConnections();
  const names = Object.keys(all);
  if (!names.length) throw new Error(configGuide());
  if (name && all[name]) return { conn: all[name], notice: null };
  if (name) {
    const lower = String(name).toLowerCase();
    const hit = names.find((n) => n.toLowerCase() === lower);
    if (hit) return { conn: all[hit], notice: null };
    if (names.length === 1) {
      return {
        conn: all[names[0]],
        notice: `数据连接名 "${name}" 未在配置中找到，已回退到唯一配置的连接 "${names[0]}"`,
      };
    }
    throw new Error(`数据连接 "${name}" 未配置。当前已配置：${names.join(', ')}。\n${configGuide()}`);
  }
  const def = process.env.CPT_DB_DEFAULT;
  if (def && all[def]) return { conn: all[def], notice: null };
  return { conn: all[names[0]], notice: null };
}

/**
 * 严格解析连接：只认配置里存在的名字（大小写不敏感），**绝不回退**到唯一/默认连接。
 *
 * 用于「用户显式点名」的场景（如 local_db_schema({compareWith})）：resolveConnection 在只配了
 * 一个连接时会把未知名字回退过去 —— 2026-11-07 用户实测：compareWith:"不存在的连接" 也真的去
 * 跑了默认连接的真实库 SHOW TABLES（可能误查生产库）。这里校验失败直接给可操作错误，不发任何
 * 真实库请求；连接名不是凭据，错误里可以列出已配置的名字。
 * @param {string} name
 * @returns {{conn: object, name: string}} name 为配置里的原始大小写
 */
export function resolveExactConnection(name) {
  const all = listConnections();
  const names = Object.keys(all);
  if (!names.length) throw new Error(configGuide());
  const wanted = String(name ?? '').trim();
  if (!wanted) throw new Error(`数据连接名不能为空。当前已配置：${names.join(', ')}`);
  const hit = names.find((n) => n.toLowerCase() === wanted.toLowerCase());
  if (!hit) {
    throw new Error(
      `数据连接 "${wanted}" 未在配置中找到；compareWith 不做回退（避免误查默认/生产库）。`
      + `当前已配置：${names.join(', ')}。请把 compareWith 改成上面之一后重试`
      + `（名字需与 .cpt 数据集里的 connection 字段一致）。`,
    );
  }
  return { conn: all[hit], name: hit };
}

const READONLY_RE = /^\s*(select|with|show|desc|describe|explain)\b/i;
const WRITE_WORD_RE = /\b(insert|update|delete|drop|alter|create|truncate|replace|grant|revoke|call|load|export|set\s+session)\b/i;
// 2026-11-02 本地 SQLite 镜像 schema 需要读元数据：这三类 SHOW 是只读的，
// 但 SHOW CREATE TABLE 的 "CREATE" 会被 WRITE_WORD_RE 误杀 → 单独白名单放行。
// 只放行「SHOW 元数据 + 单个标识符」的精确形态，不允许拼接其它子句/多语句。
const SHOW_CREATE_TABLE_RE = /^show\s+create\s+table\s+[`"\w.$\u4e00-\u9fa5]+\s*$/i;
const SHOW_COLUMNS_RE = /^show\s+(full\s+)?columns\s+from\s+[`"\w.$\u4e00-\u9fa5]+\s*$/i;
const SHOW_INDEX_RE = /^show\s+(index|indexes|keys)\s+from\s+[`"\w.$\u4e00-\u9fa5]+\s*$/i;

/** 判定 SQL 是否只读（单语句）。返回 {ok, reason} */
export function isReadOnlySql(sql) {
  const s = String(sql ?? '').trim();
  if (!s) return { ok: false, reason: 'SQL 为空' };
  // 去掉行注释/块注释后再判断
  const stripped = s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ').trim();
  const body = stripped.replace(/;\s*$/, '');
  if (body.includes(';')) return { ok: false, reason: '只允许单条语句（检测到分号分隔的多语句）' };
  if (!READONLY_RE.test(body)) return { ok: false, reason: '只允许只读语句（SELECT / WITH / SHOW / DESC / EXPLAIN）' };
  // 元数据只读白名单：SHOW CREATE TABLE / SHOW [FULL] COLUMNS / SHOW INDEX（本地 SQLite 镜像 schema 用）
  if (SHOW_CREATE_TABLE_RE.test(body) || SHOW_COLUMNS_RE.test(body) || SHOW_INDEX_RE.test(body)) {
    return { ok: true, reason: null };
  }
  // 去掉字符串字面量后检查写词，避免把 'delete' 之类的字面量误判
  const noLiteral = body.replace(/'(?:[^'\\]|\\.)*'/g, "''").replace(/"(?:[^"\\]|\\.)*"/g, '""');
  const hit = noLiteral.match(WRITE_WORD_RE);
  if (hit) return { ok: false, reason: `疑似写语句关键字 "${hit[1]}"，只读通道拒绝执行` };
  return { ok: true, reason: null };
}

/** 没有 LIMIT 时追加一个；返回实际执行的 SQL */
function withLimit(sql, limit) {
  const s = String(sql).trim().replace(/;\s*$/, '');
  if (/\blimit\s+\d+/i.test(s)) return s;
  if (/^\s*(show|desc|describe|explain)\b/i.test(s)) return s; // 这些语句不吃 LIMIT
  return `${s}\nLIMIT ${limit}`;
}

/**
 * 执行只读 SQL。
 * @param {string} connName .cpt 数据连接名
 * @param {string} sql
 * @param {{maxRows?:number, timeoutMs?:number, explain?:boolean, fetchAll?:boolean}} [opts]
 * @returns {Promise<{ok:boolean, connection:string, database?:string, elapsedMs:number, rowCount:number,
 *   truncated:boolean, columns:{name:string,type?:number}[], rows:object[], executedSql:string,
 *   notice?:string}>}
 */
export async function runSelectSql(connName, sql, opts = {}) {
  const maxRowsRaw = Number(opts.maxRows ?? 100);
  const maxRows = Number.isFinite(maxRowsRaw) ? Math.min(Math.max(1, maxRowsRaw), HARD_MAX_ROWS) : 100;
  const timeoutMs = Math.min(Math.max(1000, Number(opts.timeoutMs ?? 20000)), 120000);
  const guard = isReadOnlySql(sql);
  if (!guard.ok) throw new Error(`run_dataset_sql_check 拒绝执行：${guard.reason}`);
  const { conn, notice } = resolveConnection(connName);

  let mysql;
  try {
    mysql = (await import('mysql2/promise')).default;
  } catch (e) {
    throw new Error(`缺少 mysql2 依赖（npm i mysql2）：${e.message}`);
  }

  const executedSql = withLimit(sql, maxRows + 1);
  const started = Date.now();
  const connection = await mysql.createConnection({
    host: conn.host,
    port: conn.port,
    user: conn.user,
    password: conn.password,
    database: conn.database,
    connectTimeout: conn.connectTimeoutMs,
    multipleStatements: false,
    dateStrings: true, // 日期按字符串返回，便于与 cpt 里的文本样式对齐
    supportBigNumbers: true,
    bigNumberStrings: true,
  });
  let timer = null;
  try {
    const queryPromise = connection.query(executedSql);
    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(() => {
        try { connection.destroy(); } catch { /* ignore */ }
        reject(new Error(`SQL 执行超时（>${timeoutMs}ms），已中断连接。可加 LIMIT 或缩小范围后重试`));
      }, timeoutMs);
    });
    const [rows, fields] = await Promise.race([queryPromise, timeoutPromise]);
    const list = Array.isArray(rows) ? rows : [];
    const truncated = list.length > maxRows;
    const sliced = truncated ? list.slice(0, maxRows) : list;
    return {
      ok: true,
      connection: conn.name,
      database: conn.database,
      elapsedMs: Date.now() - started,
      rowCount: truncated ? `>${maxRows}` : list.length,
      truncated,
      columns: (fields || []).map((f) => ({ name: f.name, type: f.type })),
      rows: sliced,
      executedSql,
      ...(notice ? { notice } : {}),
    };
  } finally {
    if (timer) clearTimeout(timer);
    try { await connection.end(); } catch { /* 已 destroy 的情况下 end 会抛，忽略 */ }
  }
}

/** 连接是否可用（只做 connect + ping，不查数据） */
