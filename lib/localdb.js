// cpt-mcp/lib/localdb.js —— 内置独立 SQLite 本地测试库（2026-11-02）
//
// 【为什么需要】
//   报表数据集 SQL 只能在真实 MySQL/Doris 上验证（v1 会话 487 次手工查询），改完再人肉同步回 .cpt；
//   真实库只读、受网络/权限/数据量限制，且生产数据不适合反复试错。本模块用 Node 24 内置的
//   `node:sqlite`（零 npm 依赖、零原生编译）在**项目工作目录**下开一套本地测试库：
//     - 结构从真实库只读镜像（SHOW FULL COLUMNS / SHOW INDEX / SHOW CREATE TABLE）；
//     - 数据集 SQL 经方言层翻译后可在本地执行/离线 prepare；
//     - **MCP 对本地库有完整 DDL/DML 权限**（造数据、改结构、重置都可），可独立测试；
//     - 对外部真实数据库依旧只读（lib/db.js 的围栏不变）。
//
// 【安全模型】
//   1) 路径边界：库文件只能在 `<cwd>/.cpt-mcp/localdb/`（env CPT_MCP_LOCALDB_DIR 可覆盖）内；
//      DB 名白名单正则 + realpath 前缀校验 + 拒绝 symlink/junction 逃逸。
//   2) 用户 SQL 通过 SQLite `setAuthorizer` 二次收口：拒绝 ATTACH / DETACH / PRAGMA /
//      load_extension 等危险动作；查询通道用 readOnly 连接，写通道需显式 open(..., {write:true})。
//   3) 内部（schema 导入 / 导出 / 状态 / 快照）用不带 authorizer 的 internal 连接，
//      只被本模块可信代码调用，不接收用户 SQL。
//   4) 单语句围栏 + 行数上限；`local_db_import` 的脚本导入是唯一多语句入口（逐句执行 + 事务）。
//
// 【为什么用 createRequire 而不是顶层 import】
//   `node:sqlite` 需要 Node >= 22.13/23.4；cpt-mcp 没有 engines 限制，用户可能在更老的 Node 上跑。
//   顶层 import 会让整个 MCP 启动失败；这里改为首次使用时探测，不可用时只有本地库工具报
//   "Node 版本不足"，其余 207 个工具不受影响。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { splitSqlStatements, registerMySqlFunctions, translateMySqlToSqlite } from './localdb-sql.js';

const require = createRequire(import.meta.url);

const DB_EXT = '.sqlite';
const DB_NAME_RE = /^[A-Za-z0-9._\-\u4e00-\u9fa5]{1,64}$/;
const DANGEROUS_FUNCTIONS = new Set(['load_extension', 'readfile', 'writefile', 'edit', 'fts3_tokenizer', 'sqlite_compileoption_used']);
// 表值 pragma（SELECT * FROM pragma_table_info(?)）在 authorizer 里表现为 SQLITE_PRAGMA；
// 这些是只读结构内省，允许（普通 PRAGMA 语句仍被语句白名单拒绝）。
const SAFE_PRAGMA_TVF = new Set(['table_info', 'table_xinfo', 'index_list', 'index_info', 'index_xinfo', 'foreign_key_list', 'database_list', 'collation_list', 'pragma_list', 'function_list', 'module_list', 'compile_options']);

/** 是否允许的 DB 名（不含扩展名；允许传 `main` 或 `main.sqlite`） */
export function isValidDbName(name) {
  const n = String(name ?? '').trim().replace(/\.sqlite$/i, '');
  return DB_NAME_RE.test(n) && n !== '.' && n !== '..';
}

let _sqlite = null;
let _sqliteError = null;

/** 懒加载 node:sqlite；返回 { DatabaseSync, backup, constants, version } 或抛可读错误 */
export function loadSqlite() {
  if (_sqlite) return _sqlite;
  if (_sqliteError) throw _sqliteError;
  try {
    const mod = require('node:sqlite');
    if (!mod?.DatabaseSync) throw new Error('node:sqlite 未导出 DatabaseSync');
    _sqlite = mod;
  } catch (e) {
    _sqliteError = new Error(
      `内置 SQLite 不可用：当前 Node ${process.version} 不支持 node:sqlite（需要 Node >= 22.13，推荐 24 LTS）。`
      + `本地测试库相关工具将不可用，其余工具不受影响。原始错误：${e.message}`,
    );
    throw _sqliteError;
  }
  return _sqlite;
}

/** 只探测不抛错：供 get_local_db_status 使用 */
export function sqliteInfo() {
  try {
    const mod = loadSqlite();
    const db = new mod.DatabaseSync(':memory:');
    const v = db.prepare('select sqlite_version() as v').get()?.v ?? null;
    db.close();
    return { available: true, nodeVersion: process.version, sqliteVersion: v };
  } catch (e) {
    return { available: false, nodeVersion: process.version, error: e.message };
  }
}

// ---------------- 根目录 / 配置 / 路径守卫 ----------------

/** 本地库根目录：env CPT_MCP_LOCALDB_DIR（绝对或相对 cwd）优先，否则 <cwd>/.cpt-mcp/localdb */
export function localDbRoot() {
  const env = process.env.CPT_MCP_LOCALDB_DIR;
  if (env && String(env).trim()) return path.resolve(String(env).trim());
  return path.join(process.cwd(), '.cpt-mcp', 'localdb');
}

/** 配置文件：默认与根目录同级的 `<cwd>/.cpt-mcp/localdb.json`（env 模式下放在 root 的父目录） */
export function localDbConfigPath() {
  const root = localDbRoot();
  return path.join(path.dirname(root), 'localdb.json');
}

export function ensureLocalDbRoot() {
  const root = localDbRoot();
  fs.mkdirSync(root, { recursive: true });
  return root;
}

/** 校验并返回库文件绝对路径（不创建文件） */
export function localDbPath(name) {
  const n = String(name ?? '').trim();
  if (!isValidDbName(n)) {
    throw new Error(`本地库名非法："${n}"（只允许字母/数字/中文/._-，1~64 字符；如 main）`);
  }
  const base = n.replace(/\.sqlite$/i, '') + DB_EXT;
  const root = ensureLocalDbRoot();
  const realRoot = fs.realpathSync(root);
  const candidate = path.join(realRoot, base);
  const rel = path.relative(realRoot, candidate);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`本地库路径越界：${candidate}`);
  // 已存在时拒绝 symlink/junction 指到根外
  try {
    const st = fs.lstatSync(candidate);
    if (st.isSymbolicLink()) throw new Error(`拒绝使用符号链接库文件：${candidate}（请删除后重建）`);
    const real = fs.realpathSync(candidate);
    const relReal = path.relative(realRoot, real);
    if (relReal.startsWith('..') || path.isAbsolute(relReal)) throw new Error(`本地库真实路径越界：${real}`);
  } catch (e) {
    if (e.code && e.code !== 'ENOENT' && !/符号链接|越界/.test(e.message)) throw e;
    if (/符号链接|越界/.test(e.message)) throw e;
  }
  return candidate;
}

/** 读取 localdb.json（不存在/非法返回空对象，不抛错） */
export function readLocalDbConfig() {
  try {
    const raw = fs.readFileSync(localDbConfigPath(), 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed;
  } catch {
    return {};
  }
}

// ---------------- 本地测试设置（localdb.json 的 settings 段，2026-11-04） ----------------
//
// 用户口径（2026-11-04 确认）：**默认 local，真实库显式**。
// 这里只负责"读"，且保证任何情况下都不抛错 —— 配置文件缺失、JSON 写坏、字段类型不对，
// 都逐字段回退默认值；run_dataset_sql_check 的 target 解析、local_db_import({action:"auto"})
// 的抽样上限都从这里取默认，避免两处硬编码漂移。

/** settings 段默认值（2026-11-04 口径：默认 local，真实库显式） */
export const LOCAL_DB_SETTINGS_DEFAULTS = Object.freeze({
  // run_dataset_sql_check 缺省 target：local=内置 SQLite（默认）/ real=真实库 / both=对账。
  // 优先级：显式参数 > env CPT_MCP_SQL_TARGET（别名 CPT_MCP_SQL_TEST_TARGET）> localdb.json settings.sqlTestTarget > 本默认。
  sqlTestTarget: 'local',
  // 真实库按需抽样（local_db_import({action:"auto"}) / action:"data"）：单表最多行数
  sampleRows: 200,
  // 真实库按需抽样：单次导入总量上限（所有表合计）
  maxTotal: 5000,
  // local_db_import({action:"auto"}) 是否自动从真实库抽样数据（false=只镜像结构）
  autoSample: true,
});

/** 合法的 sqlTestTarget 取值 */
export const SQL_TEST_TARGETS = Object.freeze(['local', 'real', 'both']);

function settingsConfigPath({ root, cwd } = {}) {
  try {
    if (cwd && String(cwd).trim()) return path.join(path.resolve(String(cwd).trim()), '.cpt-mcp', 'localdb.json');
    // root = 本地库根目录（与 CPT_MCP_LOCALDB_DIR 同义），配置文件与它同级（放在 root 的父目录）
    if (root && String(root).trim()) return path.join(path.dirname(path.resolve(String(root).trim())), 'localdb.json');
  } catch { /* 路径非法 → 走默认 */ }
  return localDbConfigPath();
}

function intSetting(v, min, max) {
  const s = typeof v === 'string' && v.trim() !== '' ? v.trim() : v;
  const n = Number(s);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < min) return null;
  return Math.min(n, max);
}

/**
 * 安全读取 `.cpt-mcp/localdb.json` 的 `settings` 段（2026-11-04）。
 *
 * **绝不抛错**：文件不存在 / 非法 JSON / 字段缺失或类型不对 → 逐字段回退
 * `LOCAL_DB_SETTINGS_DEFAULTS`；合法但超出范围的值按上限收敛（sampleRows ≤5000、maxTotal ≤200000，
 * 且 maxTotal ≥ sampleRows）。
 *
 * 配置文件路径：
 *   - 传 `cwd`：`<cwd>/.cpt-mcp/localdb.json`；
 *   - 不传 `cwd`、传 `root`：`<root 的父目录>/localdb.json`（root = 本地库根目录，与 CPT_MCP_LOCALDB_DIR 同义）；
 *   - 都不传：与 `localDbConfigPath()` 同源（尊重 CPT_MCP_LOCALDB_DIR，缺省 `<cwd>/.cpt-mcp/localdb.json`）。
 *
 * @param {{root?:string, cwd?:string}} [o]
 * @returns {{sqlTestTarget:'local'|'real'|'both', sampleRows:number, maxTotal:number, autoSample:boolean,
 *   settingsFile:string, settingsExists:boolean, provided:string[]}}
 */
export function readLocalDbSettings({ root, cwd } = {}) {
  const out = { ...LOCAL_DB_SETTINGS_DEFAULTS };
  const provided = [];
  let file = '';
  let exists = false;
  let raw = null;
  try {
    file = settingsConfigPath({ root, cwd });
    exists = fs.existsSync(file);
    if (exists) raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    raw = null; // 非法 JSON / 读失败 → 全部回退默认
  }
  const src = raw && typeof raw === 'object' && !Array.isArray(raw)
    && raw.settings && typeof raw.settings === 'object' && !Array.isArray(raw.settings)
    ? raw.settings
    : null;
  if (src) {
    if (typeof src.sqlTestTarget === 'string') {
      const t = src.sqlTestTarget.trim().toLowerCase();
      if (SQL_TEST_TARGETS.includes(t)) { out.sqlTestTarget = t; provided.push('sqlTestTarget'); }
    }
    const sr = intSetting(src.sampleRows, 1, 5000);
    if (sr != null) { out.sampleRows = sr; provided.push('sampleRows'); }
    const mt = intSetting(src.maxTotal, 1, 200000);
    if (mt != null) { out.maxTotal = mt; provided.push('maxTotal'); }
    if (typeof src.autoSample === 'boolean') { out.autoSample = src.autoSample; provided.push('autoSample'); }
  }
  // 双上限自洽：总量上限不得低于单表上限（否则单表永远抽不满）
  if (out.maxTotal < out.sampleRows) out.maxTotal = out.sampleRows;
  return { ...out, settingsFile: file, settingsExists: exists, provided };
}

// ---------------- SQLite 写审计配置（2026-11-11） ----------------
//
// 只在**本地 SQLite 测试库**安装触发器；真实库只读，不装任何东西。
// 默认关闭，显式 settings.writeAudit.enabled=true / CPT_MCP_WRITE_AUDIT=1 /
// prepareReportTestEnv({writeAudit:true}) 才启用。

export const WRITE_AUDIT_DEFAULTS = Object.freeze({
  enabled: false,
  capture: 'counts',       // counts | keys（当前 counts 只记录事件计数；keys 预留）
  installTriggers: true,
  maxEvents: 5000,
  retainRuns: 20,
  simulateMaxRows: 5000,
});

/** 读 settings.writeAudit（非法/缺失逐字段回退，绝不抛错） */
export function readWriteAuditConfig({ root, cwd } = {}) {
  const out = { ...WRITE_AUDIT_DEFAULTS };
  let src = null;
  try {
    const file = settingsConfigPath({ root, cwd });
    if (fs.existsSync(file)) {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      src = raw?.settings?.writeAudit;
    }
  } catch { src = null; }
  if (src && typeof src === 'object' && !Array.isArray(src)) {
    if (typeof src.enabled === 'boolean') out.enabled = src.enabled;
    if (typeof src.installTriggers === 'boolean') out.installTriggers = src.installTriggers;
    if (typeof src.capture === 'string' && ['counts', 'keys'].includes(src.capture)) out.capture = src.capture;
    const me = intSetting(src.maxEvents, 1, 100000);
    if (me != null) out.maxEvents = me;
    const rr = intSetting(src.retainRuns, 1, 1000);
    if (rr != null) out.retainRuns = rr;
    const sm = intSetting(src.simulateMaxRows, 1, 20000);
    if (sm != null) out.simulateMaxRows = sm;
  }
  const envBool = (name, fallback) => {
    const v = process.env[name];
    if (v == null || String(v).trim() === '') return fallback;
    return /^(1|true|yes|on)$/i.test(String(v).trim());
  };
  out.enabled = envBool('CPT_MCP_WRITE_AUDIT', out.enabled);
  const envCapture = process.env.CPT_MCP_WRITE_AUDIT_CAPTURE;
  if (envCapture && ['counts', 'keys'].includes(String(envCapture).trim())) out.capture = String(envCapture).trim();
  const envMax = intSetting(process.env.CPT_MCP_WRITE_AUDIT_MAX_EVENTS, 1, 100000);
  if (envMax != null) out.maxEvents = envMax;
  const envRetain = intSetting(process.env.CPT_MCP_WRITE_AUDIT_RETAIN, 1, 1000);
  if (envRetain != null) out.retainRuns = envRetain;
  const envSimMax = intSetting(process.env.CPT_MCP_SIMULATE_MAX_ROWS, 1, 20000);
  if (envSimMax != null) out.simulateMaxRows = envSimMax;
  return out;
}

/** 合并写入配置（尽力而为；写失败只返回 false，不影响库本身） */
export function updateLocalDbConfig(patch) {  try {
    const cfg = { ...readLocalDbConfig(), ...patch };
    fs.mkdirSync(path.dirname(localDbConfigPath()), { recursive: true });
    fs.writeFileSync(localDbConfigPath(), JSON.stringify(cfg, null, 2) + '\n', 'utf8');
    return true;
  } catch {
    return false;
  }
}

/** 列出根目录下已存在的本地库（按名称排序） */
export function listLocalDbFiles() {
  const root = localDbRoot();
  if (!fs.existsSync(root)) return [];
  const out = [];
  for (const ent of fs.readdirSync(root, { withFileTypes: true })) {
    if (!ent.isFile() || !/\.sqlite$/i.test(ent.name)) continue;
    const file = path.join(root, ent.name);
    const st = fs.statSync(file);
    out.push({ name: ent.name.replace(/\.sqlite$/i, ''), file, bytes: st.size, mtimeMs: st.mtimeMs });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * 解析本次要用哪个本地库：
 *   ① 显式 db 参数（含名或带 .sqlite）；
 *   ② 配置里 databases[*].sourceConnection 与 .cpt 的 connection 匹配；
 *   ③ 配置 default；
 *   ④ 回退 'main'。
 * 返回 { name, file, exists, source }；不抛错（调用方决定是否要求存在）。
 */
export function resolveLocalDbName({ db, connection } = {}) {
  const cfg = readLocalDbConfig();
  if (db && String(db).trim()) {
    const name = String(db).trim().replace(/\.sqlite$/i, '');
    return { name, file: localDbPath(name), exists: fs.existsSync(localDbPath(name)), source: 'explicit', config: cfg };
  }
  const dbs = cfg.databases && typeof cfg.databases === 'object' ? cfg.databases : {};
  if (connection) {
    const hit = Object.entries(dbs).find(([, v]) => v && String(v.sourceConnection || '').toLowerCase() === String(connection).toLowerCase());
    if (hit) {
      const name = hit[0];
      return { name, file: localDbPath(name), exists: fs.existsSync(localDbPath(name)), source: 'connection', config: cfg };
    }
  }
  const def = cfg.default && String(cfg.default).trim() ? String(cfg.default).trim() : 'main';
  return { name: def, file: localDbPath(def), exists: fs.existsSync(localDbPath(def)), source: 'default', config: cfg };
}

/** 本地库使用指引（工具报错时拼在错误里，模型可直接照做） */
export function localDbGuide(dbName) {
  return [
    `本地 SQLite 测试库尚未初始化${dbName ? `（库名：${dbName}）` : ''}。先建库并镜像真实库结构：`,
    '  ⓞ report/focused 档这些工具属 local_db 租约族，先 request_deep_tool_access({ path: "<模板.cpt>", group: "local_db" }) 解锁（full 档可直接调用）',
    '  ① local_db_admin({ action: "create", db: "main" })',
    '  ② local_db_import({ action: "schema", db: "main", connection: "Doris", autoTables: true })',
    '     （autoTables 会扫描当前项目 .cpt 的数据集 SQL，导入它们实际引用的表）',
    '     ★ 一条命令替代 ①②：local_db_import({ action: "auto", db: "main", connection: "Doris", path: "<模板.cpt>" })',
    '       镜像结构 + 按需抽样（默认 ≤200 行/表、≤5000 行；autoSample=false 或 localdb.json settings.autoSample=false 可关）',
    '  ③ run_dataset_sql_check({ path: "...", target: "local", offline: true }) 离线验证',
    '  没有真实库连接时也可纯离线建 fixture：local_db_import({ action: "ddl", db: "main", ddl: "CREATE TABLE ..." }) + seed',
    `本地库根目录：${localDbRoot()}（可用 env CPT_MCP_LOCALDB_DIR 覆盖）`,
  ].join('\n');
}

// ---------------- 打开连接 / 授权器 ----------------

function loadCtor() {
  return loadSqlite().DatabaseSync;
}

function buildAuthorizer(db, { write }) {
  const c = loadSqlite().constants;
  db.setAuthorizer((action, p1, p2) => {
    if (action === c.SQLITE_ATTACH || action === c.SQLITE_DETACH) return c.SQLITE_DENY;
    if (action === c.SQLITE_PRAGMA) {
      // 普通 PRAGMA 被语句白名单挡住；这里只放行表值 pragma 的只读结构内省
      return SAFE_PRAGMA_TVF.has(String(p1 || '').toLowerCase()) ? c.SQLITE_OK : c.SQLITE_DENY;
    }
    if (action === c.SQLITE_FUNCTION && DANGEROUS_FUNCTIONS.has(String(p2 || '').toLowerCase())) return c.SQLITE_DENY;
    if (!write) {
      const deny = new Set([
        c.SQLITE_CREATE_INDEX, c.SQLITE_CREATE_TABLE, c.SQLITE_CREATE_TEMP_INDEX, c.SQLITE_CREATE_TEMP_TABLE,
        c.SQLITE_CREATE_TEMP_TRIGGER, c.SQLITE_CREATE_TEMP_VIEW, c.SQLITE_CREATE_TRIGGER, c.SQLITE_CREATE_VIEW,
        c.SQLITE_DELETE, c.SQLITE_DROP_INDEX, c.SQLITE_DROP_TABLE, c.SQLITE_DROP_TEMP_INDEX, c.SQLITE_DROP_TEMP_TABLE,
        c.SQLITE_DROP_TEMP_TRIGGER, c.SQLITE_DROP_TEMP_VIEW, c.SQLITE_DROP_TRIGGER, c.SQLITE_DROP_VIEW,
        c.SQLITE_INSERT, c.SQLITE_UPDATE, c.SQLITE_ALTER_TABLE, c.SQLITE_REINDEX, c.SQLITE_ANALYZE,
        c.SQLITE_CREATE_VTABLE, c.SQLITE_DROP_VTABLE,
      ]);
      if (deny.has(action)) return c.SQLITE_DENY;
    }
    return c.SQLITE_OK;
  });
}

function prepareWritePragmas(db) {
  try { db.exec('PRAGMA journal_mode = WAL'); } catch { /* 内存库/只读介质等场景尽力而为 */ }
  try { db.exec('PRAGMA synchronous = NORMAL'); } catch { /* ignore */ }
  try { db.exec('PRAGMA busy_timeout = 5000'); } catch { /* ignore */ }
  try { db.exec('PRAGMA temp_store = MEMORY'); } catch { /* ignore */ }
}

/**
 * 打开本地库连接。
 * @param {string} name
 * @param {{write?:boolean, internal?:boolean, mustExist?:boolean}} [opts]
 *   write=true  → 读写连接（授权器允许 DDL/DML，仍拒绝 ATTACH/PRAGMA/load_extension）
 *   internal=true → 不带授权器（仅供本模块内部可信操作：schema 导出/快照/状态）
 *   mustExist=false → 读写连接可新建文件；只读连接必须已存在
 */
export function openLocalDb(name, opts = {}) {
  const Ctor = loadCtor();
  const write = opts.write === true;
  const internal = opts.internal === true;
  const file = localDbPath(name);
  if (!write && !fs.existsSync(file)) throw new Error(`本地库不存在：${file}\n${localDbGuide(name)}`);
  if (opts.mustExist === true && !fs.existsSync(file)) throw new Error(`本地库不存在：${file}\n${localDbGuide(name)}`);
  let db;
  try {
    db = new Ctor(file, {
      readOnly: !write && !internal ? true : false,
      timeout: 5000,
      enableDoubleQuotedStringLiterals: true, // MySQL 默认双引号是字符串；与真实库对齐
      readBigInts: true, // BIGINT 保精度；工具层输出时再转 JSON 安全值
    });
  } catch (e) {
    throw new Error(`打开本地库失败：${file}：${e.message}`);
  }
  try {
    if (write) prepareWritePragmas(db);
    registerMySqlFunctions(db);
    if (!internal) buildAuthorizer(db, { write });
    return db;
  } catch (e) {
    try { db.close(); } catch { /* ignore */ }
    throw e;
  }
}

/** 关闭连接（吞掉 close 异常） */
export function closeLocalDb(db) {
  try { db.close(); } catch { /* ignore */ }
}

/** JSON 安全化：BigInt→安全整数或十进制字符串；Uint8Array→base64:...；null 保留 */
export function toJsonSafe(v) {
  if (v === null || v === undefined) return v;
  if (typeof v === 'bigint') {
    const n = Number(v);
    return Number.isSafeInteger(n) ? n : v.toString();
  }
  if (v instanceof Uint8Array) return `base64:${Buffer.from(v).toString('base64')}`;
  return v;
}

// ---------------- SQLite 写审计（触发器 + run） ----------------
//
// 只给本地测试库安装 AFTER INSERT/UPDATE/DELETE 触发器；触发器把事件写入
// __cpt_write_event，FR 预览进程（独立 Java 进程）写同一个 SQLite 文件时也能被记录。
// 审计不保存业务值，默认只保存表名/操作/时间；不改变业务表结构以外的东西。

const WRITE_AUDIT_RUN = '__cpt_write_run';
const WRITE_AUDIT_EVENT = '__cpt_write_event';
const WRITE_AUDIT_ACTIVE = '__cpt_active_run';

function auditQuoteIdent(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

function auditHash(text) {
  return crypto.createHash('sha1').update(String(text)).digest('hex').slice(0, 12);
}

function ensureWriteAuditSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS ${WRITE_AUDIT_RUN} (
    run_id TEXT PRIMARY KEY,
    template_hash TEXT,
    capture TEXT NOT NULL DEFAULT 'counts',
    started_at TEXT NOT NULL,
    ended_at TEXT,
    before_json TEXT,
    note TEXT
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS ${WRITE_AUDIT_EVENT} (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    table_name TEXT NOT NULL,
    op TEXT NOT NULL,
    changed_at TEXT NOT NULL,
    sheet_hint TEXT
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS ${WRITE_AUDIT_ACTIVE} (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    run_id TEXT NOT NULL
  )`);
  db.exec(`CREATE INDEX IF NOT EXISTS __cpt_write_event_run ON ${WRITE_AUDIT_EVENT}(run_id)`);
}

function tableNamesForAudit(db) {
  try {
    return db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '__cpt_%'")
      .all().map((r) => String(r.name));
  } catch { return []; }
}

function auditTriggerName(table, op) {
  return `__cpt_wr_${String(op).toLowerCase()}_${auditHash(table)}`;
}

function dropWriteAuditTriggers(db) {
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE '__cpt_wr_%'").all();
  for (const r of rows) {
    try { db.exec(`DROP TRIGGER IF EXISTS ${auditQuoteIdent(r.name)}`); } catch { /* ignore */ }
  }
}

function columnNames(db, table) {
  try {
    return db.prepare(`PRAGMA table_info(${auditQuoteIdent(table)})`).all().map((r) => String(r.name));
  } catch { return []; }
}

/**
 * 给本地库的目标表安装写审计触发器。
 * @param {string} name 本地库名
 * @param {string[]} tables 目标表（来自 fillConfig；空数组=所有业务表）
 * @param {{capture?:'counts'|'keys'}} [opts]
 * @returns {{ok:boolean, db:string, tables:string[], skipped:string[]}}
 */
export function installWriteAuditTriggers(name, tables = [], opts = {}) {
  const clean = String(name).replace(/\.sqlite$/i, '');
  const db = openLocalDb(clean, { internal: true, mustExist: true });
  try {
    ensureWriteAuditSchema(db);
    dropWriteAuditTriggers(db);
    const existing = new Set(tableNamesForAudit(db));
    const wanted = (Array.isArray(tables) && tables.length ? tables : [...existing])
      .map((t) => String(t || '').split('.').pop())
      .filter((t) => t && existing.has(t));
    const skipped = (Array.isArray(tables) ? tables : [])
      .map((t) => String(t || '').split('.').pop())
      .filter((t) => t && !existing.has(t));
    const installed = [];
    for (const table of wanted) {
      const cols = columnNames(db, table);
      const hint = cols.find((c) => /^(fill_type|source_sheet|source_type|sheet_id|sheet_name)$/i.test(c));
      const hintExpr = (alias) => (hint ? `${alias}.${auditQuoteIdent(hint)}` : 'NULL');
      for (const op of ['INSERT', 'UPDATE', 'DELETE']) {
        const trigger = auditTriggerName(table, op);
        const alias = op === 'DELETE' ? 'OLD' : 'NEW';
        const tableLit = String(table).replace(/'/g, "''");
        const sql = `CREATE TRIGGER ${auditQuoteIdent(trigger)}
AFTER ${op} ON ${auditQuoteIdent(table)}
BEGIN
  INSERT INTO ${WRITE_AUDIT_EVENT}(run_id, table_name, op, changed_at, sheet_hint)
  SELECT run_id, '${tableLit}', '${op}', strftime('%Y-%m-%dT%H:%M:%fZ','now'), ${hintExpr(alias)}
  FROM ${WRITE_AUDIT_ACTIVE} WHERE id = 1;
END`;
        db.exec(sql);
      }
      installed.push(table);
    }
    return { ok: true, db: clean, tables: installed, skipped, hintColumn: wanted.map((t) => ({ table: t, column: columnNames(db, t).find((c) => /^(fill_type|source_sheet|source_type|sheet_id|sheet_name)$/i.test(c)) || null })) };
  } finally {
    closeLocalDb(db);
  }
}

/**
 * 开始一次写审计：记录 run、before 行数、激活 active run。
 * 用于 prepare_report_test_env 后手工/预览提交，之后再 readWriteAudit。
 */
export function startWriteAuditRun(name, { tables = [], templateHash = null, note = null, capture = 'counts', installTriggers = true } = {}) {
  const clean = String(name).replace(/\.sqlite$/i, '');
  const runId = `wa-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
  if (installTriggers) installWriteAuditTriggers(clean, tables, { capture });
  const db = openLocalDb(clean, { internal: true, mustExist: true });
  try {
    ensureWriteAuditSchema(db);
    const existing = new Set(tableNamesForAudit(db));
    const targetTables = (Array.isArray(tables) && tables.length ? tables : [...existing])
      .map((t) => String(t || '').split('.').pop())
      .filter((t) => t && existing.has(t));
    const before = {};
    for (const t of targetTables) {
      try { before[t] = toJsonSafe(db.prepare(`SELECT COUNT(*) AS n FROM ${auditQuoteIdent(t)}`).get()?.n ?? 0); } catch { before[t] = null; }
    }
    db.prepare(`INSERT INTO ${WRITE_AUDIT_RUN}(run_id, template_hash, capture, started_at, before_json, note)
      VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?, ?)`)
      .run(runId, templateHash ? String(templateHash).slice(0, 64) : null, capture, JSON.stringify(before), note ? String(note).slice(0, 500) : null);
    db.exec(`DELETE FROM ${WRITE_AUDIT_ACTIVE}`);
    db.prepare(`INSERT INTO ${WRITE_AUDIT_ACTIVE}(id, run_id) VALUES (1, ?)`).run(runId);
    return { ok: true, db: clean, runId, tables: targetTables, before };
  } finally {
    closeLocalDb(db);
  }
}

/** 读取当前 active 写审计 run（没有则 null；不创建表、不改库）。 */
export function getActiveWriteAuditRun(name) {
  const clean = String(name).replace(/\.sqlite$/i, '');
  const db = openLocalDb(clean, { internal: true, mustExist: true });
  try {
    const hasRun = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(WRITE_AUDIT_RUN);
    const hasActive = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(WRITE_AUDIT_ACTIVE);
    if (!hasRun || !hasActive) return null;
    const active = db.prepare(`SELECT run_id FROM ${WRITE_AUDIT_ACTIVE} WHERE id=1`).get();
    if (!active?.run_id) return null;
    const run = db.prepare(`SELECT * FROM ${WRITE_AUDIT_RUN} WHERE run_id=?`).get(active.run_id);
    if (!run) return null;
    return { ok: true, db: clean, runId: run.run_id, startedAt: run.started_at, captured: run.capture || 'counts' };
  } finally {
    closeLocalDb(db);
  }
}

/** 结束当前写审计（清空 active；不清事件，供事后读）。 */
export function stopWriteAuditRun(name, { runId = null } = {}) {
  const clean = String(name).replace(/\.sqlite$/i, '');
  const db = openLocalDb(clean, { internal: true, mustExist: true });
  try {
    ensureWriteAuditSchema(db);
    const active = db.prepare(`SELECT run_id FROM ${WRITE_AUDIT_ACTIVE} WHERE id = 1`).get();
    const target = runId || active?.run_id || null;
    db.exec(`DELETE FROM ${WRITE_AUDIT_ACTIVE}`);
    if (target) db.prepare(`UPDATE ${WRITE_AUDIT_RUN} SET ended_at = COALESCE(ended_at, strftime('%Y-%m-%dT%H:%M:%fZ','now')) WHERE run_id = ?`).run(target);
    return { ok: true, db: clean, runId: target };
  } finally {
    closeLocalDb(db);
  }
}

/**
 * 读取写审计汇总。默认最近 1 个 run；runId 指定。
 * 只返回计数/时间/表名，不返回值内容。
 */
export function readWriteAudit(name, { runId = null, last = 1, keepRuns = null } = {}) {
  const clean = String(name).replace(/\.sqlite$/i, '');
  const db = openLocalDb(clean, { internal: true, mustExist: true });
  try {
    const has = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
      .get(WRITE_AUDIT_RUN);
    if (!has) return { ok: true, enabled: false, db: clean, reason: '该本地库没有写审计表（先 local_db_admin({action:"write_audit", setup:true}) 或 local_db_import action:report + 写审计开启）' };
    const run = runId
      ? db.prepare(`SELECT * FROM ${WRITE_AUDIT_RUN} WHERE run_id=?`).get(runId)
      : db.prepare(`SELECT * FROM ${WRITE_AUDIT_RUN} ORDER BY started_at DESC LIMIT ?`).get(Math.min(Math.max(1, Number(last) || 1), 50));
    if (!run) return { ok: true, enabled: true, db: clean, run: null, reason: runId ? `未找到 runId ${runId}` : '还没有写审计 run' };
    const events = db.prepare(`SELECT table_name, op, COUNT(*) AS n, MIN(changed_at) AS first_at, MAX(changed_at) AS last_at
      FROM ${WRITE_AUDIT_EVENT} WHERE run_id=? GROUP BY table_name, op ORDER BY table_name, op`).all(run.run_id);
    const byHint = db.prepare(`SELECT COALESCE(sheet_hint,'<unknown>') AS sheet_hint, COUNT(*) AS n
      FROM ${WRITE_AUDIT_EVENT} WHERE run_id=? GROUP BY sheet_hint ORDER BY n DESC`).all(run.run_id);
    const before = (() => { try { return JSON.parse(run.before_json || '{}'); } catch { return {}; } })();
    const tableSet = new Set(events.map((e) => String(e.table_name)));
    for (const t of Object.keys(before)) tableSet.add(t);
    const tables = [];
    for (const table of tableSet) {
      const ev = events.filter((e) => String(e.table_name) === table);
      const after = (() => {
        try { return toJsonSafe(db.prepare(`SELECT COUNT(*) AS n FROM ${auditQuoteIdent(table)}`).get()?.n ?? 0); } catch { return null; }
      })();
      const b = before[table] ?? null;
      tables.push({
        table,
        beforeRows: b,
        afterRows: after,
        delta: (typeof b === 'number' && typeof after === 'number') ? after - b : null,
        inserts: ev.filter((e) => e.op === 'INSERT').reduce((n, e) => n + Number(e.n || 0), 0),
        updates: ev.filter((e) => e.op === 'UPDATE').reduce((n, e) => n + Number(e.n || 0), 0),
        deletes: ev.filter((e) => e.op === 'DELETE').reduce((n, e) => n + Number(e.n || 0), 0),
        firstWriteAt: ev.reduce((a, e) => (!a || String(e.first_at) < a ? String(e.first_at) : a), null),
        lastWriteAt: ev.reduce((a, e) => (!a || String(e.last_at) > a ? String(e.last_at) : a), null),
      });
    }
    const total = (op) => events.filter((e) => e.op === op).reduce((n, e) => n + Number(e.n || 0), 0);
    const allTimes = events.flatMap((e) => [e.first_at, e.last_at]).filter(Boolean).map(String).sort();
    const out = {
      ok: true,
      enabled: true,
      db: clean,
      runId: run.run_id,
      templateHash: run.template_hash || null,
      capture: run.capture || 'counts',
      startedAt: run.started_at,
      endedAt: run.ended_at || null,
      totals: {
        writeEvents: events.reduce((n, e) => n + Number(e.n || 0), 0),
        inserts: total('INSERT'),
        updates: total('UPDATE'),
        deletes: total('DELETE'),
        tables: tables.length,
        firstWriteAt: allTimes[0] || null,
        lastWriteAt: allTimes[allTimes.length - 1] || null,
      },
      tables,
      bySheetHint: byHint.map((r) => ({ sheetHint: r.sheet_hint, events: Number(r.n) })),
      warnings: [],
    };
    if (out.totals.writeEvents === 0) out.warnings.push({ code: 'WRITE_AUDIT_EMPTY', message: '该 run 没有捕获到写事件：可能未执行提交、目标表未安装触发器，或写的是非目标表。' });
    if (out.tables.some((t) => t.inserts > 0 && t.updates > 0)) out.warnings.push({ code: 'MIXED_INSERT_UPDATE', message: '同一 run 同时有 INSERT 和 UPDATE；多 sheet 提交时请按 bySheetHint 核对是否重复写入。' });
    const auditCfg = readWriteAuditConfig();
    if (out.totals.writeEvents > auditCfg.maxEvents) {
      out.warnings.push({ code: 'WRITE_AUDIT_EVENT_LIMIT', message: `本次写事件 ${out.totals.writeEvents} 超过 settings.writeAudit.maxEvents=${auditCfg.maxEvents}，请缩小提交范围或调大上限后再分析。` });
    }
    // 保留上限：只清理旧 run（不删当前 run）
    const keep = Math.min(Math.max(1, Number(keepRuns) || 20), 1000);
    const old = db.prepare(`SELECT run_id FROM ${WRITE_AUDIT_RUN} WHERE run_id <> ? ORDER BY started_at DESC LIMIT -1 OFFSET ?`).all(run.run_id, keep);
    for (const r of old) {
      db.prepare(`DELETE FROM ${WRITE_AUDIT_EVENT} WHERE run_id=?`).run(r.run_id);
      db.prepare(`DELETE FROM ${WRITE_AUDIT_RUN} WHERE run_id=?`).run(r.run_id);
    }
    return out;
  } finally {
    closeLocalDb(db);
  }
}

/** 本地库是否需要写审计（配置/env，不创建表）。 */
export function writeAuditConfigFor(name = null) {
  return readWriteAuditConfig();
}

function safeColumns(stmt) {
  try {
    const cols = stmt.columns?.() ?? [];
    return cols.map((c) => ({ name: c.name, type: c.type ?? null, table: c.table ?? null }));
  } catch {
    return [];
  }
}

// ---------------- 用户 SQL 执行 ----------------

const QUERY_RE = /^\s*(select|with|values|explain)\b/i;
const BLOCKED_STMT_RE = /^\s*(attach|detach|vacuum|pragma|load_extension)\b/i;
const MULTI_STMT_HINT = '本地库工具一次只执行一条语句（脚本导入请用 local_db_import 的 sql 文件入口）';

/** 去掉语句开头的注释/空白，便于判断首关键字（MySQL # 注释、-- 注释、块注释） */
function stripLeadingComments(sql) {
  let s = String(sql ?? '');
  for (;;) {
    const before = s;
    s = s.replace(/^\s+/, '');
    s = s.replace(/^#[^\n]*/, '');
    s = s.replace(/^--[^\n]*/, '');
    s = s.replace(/^\/\*[\s\S]*?\*\//, '');
    if (s === before) return s;
  }
}

/** 单语句 + 危险语句围栏（用户 SQL 入口；内部脚本导入走 executeLocalScript） */
export function assertUserSqlAllowed(sql, { write = false } = {}) {
  const s = String(sql ?? '').trim();
  if (!s) throw new Error('SQL 为空');
  const stmts = splitSqlStatements(s);
  if (stmts.length > 1) throw new Error(`${MULTI_STMT_HINT}\n检测到 ${stmts.length} 条语句。`);
  const body = stmts[0] ?? s;
  const head = stripLeadingComments(body);
  if (BLOCKED_STMT_RE.test(head)) {
    throw new Error('本地库拒绝执行 ATTACH / DETACH / VACUUM / PRAGMA / load_extension（安全围栏，避免越界读写外部文件）。');
  }
  if (!write && !QUERY_RE.test(head)) throw new Error('只读查询通道只接受 SELECT / WITH / VALUES / EXPLAIN；写操作请显式 mode:"exec" 且 allowWrite:true。');
  return body;
}

/** SQLite 报错归类：语法错 / 缺表 / 缺列 / 其它（离线审计据此区分 blocker 与环境问题） */
export function classifySqliteError(message) {
  const msg = String(message ?? '');
  let m;
  if ((m = msg.match(/no such table:\s*(.+)/i))) return { kind: 'missing-table', detail: m[1].trim(), message: msg };
  if ((m = msg.match(/no such column:\s*(.+)/i))) return { kind: 'missing-column', detail: m[1].trim(), message: msg };
  if (/syntax error|incomplete input|unrecognized token|near\s+".*"/i.test(msg)) return { kind: 'syntax', detail: null, message: msg };
  if (/not authorized|prohibited/i.test(msg)) return { kind: 'denied', detail: null, message: msg };
  return { kind: 'other', detail: null, message: msg };
}

/**
 * 在本地库执行单条 SQL（用户入口）。
 * @param {string} name
 * @param {string} sql
 * @param {{write?:boolean, params?:object|Array, maxRows?:number}} [opts]
 * @returns {{ok:boolean, db:string, translatedSql:string, dialectIssues:object[], columns:{name:string,type?:string|null}[],
 *   rows:object[], rowCount:number|string, truncated:boolean, changes?:number, lastInsertRowid?:number|string, elapsedMs:number, kind:'query'|'exec'}}
 */
export function runLocalSql(name, sql, opts = {}) {
  const write = opts.write === true;
  const body = assertUserSqlAllowed(sql, { write });
  const translated = translateMySqlToSqlite(body);
  const maxRows = Math.min(Math.max(1, Number(opts.maxRows ?? 200)), 5000);
  const started = Date.now();
  const db = openLocalDb(name, { write });
  try {
    const stmt = db.prepare(translated.sql);
    const kind = QUERY_RE.test(stripLeadingComments(translated.sql)) ? 'query' : 'exec';
    const columns = safeColumns(stmt);
    if (kind === 'exec') {
      const info = paramsRun(stmt, opts.params);
      return {
        ok: true,
        db: String(name).replace(/\.sqlite$/i, ''),
        translatedSql: translated.sql,
        dialectIssues: translated.issues,
        columns,
        rows: [],
        rowCount: 0,
        truncated: false,
        changes: typeof info.changes === 'bigint' ? toJsonSafe(info.changes) : info.changes,
        lastInsertRowid: toJsonSafe(info.lastInsertRowid),
        elapsedMs: Date.now() - started,
        kind,
      };
    }
    const rows = [];
    let truncated = false;
    const iter = stmt.iterate(...paramsArgs(opts.params));
    for (const row of iter) {
      if (rows.length >= maxRows) { truncated = true; break; }
      const o = {};
      for (const k of Object.keys(row)) o[k] = toJsonSafe(row[k]);
      rows.push(o);
    }
    return {
      ok: true,
      db: String(name).replace(/\.sqlite$/i, ''),
      translatedSql: translated.sql,
      dialectIssues: translated.issues,
      columns: columns.length ? columns : (rows[0] ? Object.keys(rows[0]).map((n) => ({ name: n, type: null })) : []),
      rows,
      rowCount: truncated ? `>${maxRows}` : rows.length,
      truncated,
      elapsedMs: Date.now() - started,
      kind,
    };
  } catch (e) {
    const c = classifySqliteError(e.message);
    const err = new Error(`本地库执行失败（${c.kind}）：${c.message}`);
    err.kind = c.kind;
    err.detail = c.detail;
    err.dialectIssues = translated.issues;
    throw err;
  } finally {
    closeLocalDb(db);
  }
}

function paramsArgs(params) {
  if (params == null) return [];
  if (Array.isArray(params)) return params.map(coerceBind);
  throw new Error('params 必须是数组（位置参数 ? / ?1）或对象（命名参数 :name）');
}

function paramsRun(stmt, params) {
  if (params == null) return stmt.run();
  if (Array.isArray(params)) return stmt.run(...params.map(coerceBind));
  const named = {};
  for (const [k, v] of Object.entries(params)) named[`:${k}`] = coerceBind(v);
  return stmt.run(named);
}

function coerceBind(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'bigint') return v;
  if (v instanceof Uint8Array) return v;
  return v;
}

/** 仅 prepare 不执行：给离线语法/列名审计用（依赖 stmt.columns()，SQLite 3.53 实测可用） */
export function prepareLocalSql(name, sql, opts = {}) {
  const translated = translateMySqlToSqlite(String(sql));
  const db = openLocalDb(name, { internal: true, mustExist: opts.mustExist !== false });
  try {
    const stmt = db.prepare(translated.sql);
    return {
      ok: true,
      db: String(name).replace(/\.sqlite$/i, ''),
      translatedSql: translated.sql,
      dialectIssues: translated.issues,
      columns: safeColumns(stmt).map((c) => c.name),
    };
  } catch (e) {
    const c = classifySqliteError(e.message);
    return { ok: false, db: String(name).replace(/\.sqlite$/i, ''), translatedSql: translated.sql, dialectIssues: translated.issues, error: { kind: c.kind, detail: c.detail, message: c.message } };
  } finally {
    closeLocalDb(db);
  }
}

/** 多语句脚本执行（仅内部/导入入口）：逐句执行 + 事务，任一句失败整体回滚 */
export function executeLocalScript(name, script) {
  const stmts = splitSqlStatements(String(script ?? ''));
  if (!stmts.length) return { ok: true, executed: 0 };
  const db = openLocalDb(name, { write: true });
  let executed = 0;
  try {
    db.exec('BEGIN IMMEDIATE');
    for (const raw of stmts) {
      const translated = translateMySqlToSqlite(raw);
      db.exec(translated.sql);
      executed += 1;
    }
    db.exec('COMMIT');
    return { ok: true, executed, statements: stmts.length };
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* ignore */ }
    const c = classifySqliteError(e.message);
    throw new Error(`脚本第 ${executed + 1} 条执行失败（${c.kind}）：${c.message}`);
  } finally {
    closeLocalDb(db);
  }
}

// ---------------- 建库 / 删库 / 状态 / 内省 ----------------

/** 建库（open 即创建空文件），返回状态；overwrite=true 时先删再建 */
export function createLocalDb(name, { overwrite = false } = {}) {
  const file = localDbPath(name);
  const cleanName = String(name).replace(/\.sqlite$/i, '');
  if (fs.existsSync(file)) {
    if (!overwrite) {
      return { ok: true, created: false, db: cleanName, file, message: '本地库已存在（如需重建请传 overwrite:true）' };
    }
    dropLocalDb(cleanName, { confirm: true });
  }
  const db = openLocalDb(cleanName, { write: true });
  try {
    db.exec("CREATE TABLE IF NOT EXISTS __cpt_meta (k TEXT PRIMARY KEY, v TEXT)");
  } finally {
    closeLocalDb(db);
  }
  updateLocalDbConfig({
    databases: { ...(readLocalDbConfig().databases || {}), [cleanName]: { ...(readLocalDbConfig().databases || {})[cleanName], file: `${cleanName}.sqlite`, createdAt: new Date().toISOString() } },
  });
  return { ok: true, created: true, db: cleanName, file };
}

/** 删库（要求 confirm:true；删除 .sqlite/-wal/-shm 与配置项） */
export function dropLocalDb(name, { confirm = false } = {}) {
  if (confirm !== true) throw new Error('删库需要显式确认：dropLocalDb(name, {confirm:true}) / local_db_admin({action:"drop", confirm:true})');
  const file = localDbPath(name);
  const cleanName = String(name).replace(/\.sqlite$/i, '');
  const removed = [];
  for (const f of [file, `${file}-wal`, `${file}-shm`]) {
    try { fs.rmSync(f, { force: true }); removed.push(f); } catch { /* ignore */ }
  }
  const cfg = readLocalDbConfig();
  if (cfg.databases && cfg.databases[cleanName]) {
    const next = { ...cfg.databases };
    delete next[cleanName];
    updateLocalDbConfig({ databases: next });
  }
  return { ok: true, db: cleanName, removed };
}

/** 内省：表清单 */
export function listLocalTables(name) {
  const db = openLocalDb(name, { internal: true, mustExist: true });
  try {
    return db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '__cpt_%' ORDER BY name",
    ).all().map((r) => r.name);
  } finally { closeLocalDb(db); }
}

/** 内省：单表列信息 / 索引 / 行数 */
export function localTableInfo(name, table) {
  const db = openLocalDb(name, { internal: true, mustExist: true });
  try {
    const cols = db.prepare('SELECT cid, name, type, "notnull" AS "notnull", dflt_value, pk FROM pragma_table_info(?)').all(table);
    const idx = db.prepare("SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name=? ORDER BY name").all(table);
    let rows = null;
    // readBigInts:true → COUNT(*) 是 bigint，直接进 MCP 返回体会让 JSON.stringify 抛错（2026-11-07 P0）
    try { rows = toJsonSafe(db.prepare(`SELECT COUNT(*) AS n FROM "${String(table).replace(/"/g, '""')}"`).get()?.n ?? null); } catch { rows = null; }
    // 同理 pragma_table_info 的 cid 也是 INTEGER→bigint（columns[].cid 曾同样炸序列化），统一转安全值
    return {
      table,
      columns: cols.map((c) => ({
        cid: toJsonSafe(c.cid),
        name: c.name,
        type: c.type,
        notnull: Number(c.notnull) === 1,
        dflt_value: toJsonSafe(c.dflt_value),
        pk: Number(c.pk) || 0,
      })),
      indexes: idx.map((i) => ({ name: i.name, sql: i.sql })),
      rows,
    };
  } finally { closeLocalDb(db); }
}

/** 内省：整库表结构与行数（用于状态/导出/对账） */
export function localSchemaSnapshot(name) {
  const db = openLocalDb(name, { internal: true, mustExist: true });
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '__cpt_%' ORDER BY name")
      .all().map((r) => r.name);
    const out = {};
    for (const t of tables) {
      const columns = db.prepare('SELECT name, type, "notnull" AS "notnull", dflt_value, pk FROM pragma_table_info(?)').all(t)
        .map((c) => ({
          name: c.name,
          type: c.type,
          notnull: Number(c.notnull) === 1,
          default: toJsonSafe(c.dflt_value ?? null),
          pk: Number(c.pk) || 0,
        }));
      const indexes = db.prepare('SELECT name, "unique" AS uniq, origin FROM pragma_index_list(?)').all(t).map((i) => {
        const cols = db.prepare('SELECT name FROM pragma_index_info(?) ORDER BY seqno').all(i.name).map((x) => x.name);
        return { name: i.name, unique: Number(i.uniq) === 1, origin: i.origin, columns: cols };
      });
      let rows = null;
      // 同 localTableInfo：COUNT(*) 是 bigint，必须在进 MCP 返回体前转 JSON 安全值（2026-11-07 P0）
      try { rows = toJsonSafe(db.prepare(`SELECT COUNT(*) AS n FROM "${t.replace(/"/g, '""')}"`).get()?.n ?? null); } catch { rows = null; }
      out[t] = { columns, indexes, rows };
    }
    return out;
  } finally { closeLocalDb(db); }
}

/** schema 指纹（结构变化即变；不含数据） */
export function localSchemaHash(name) {
  const db = openLocalDb(name, { internal: true, mustExist: true });
  try {
    const rows = db.prepare("SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type, name").all();
    const h = crypto.createHash('sha256');
    for (const r of rows) h.update(`${r.type}\u0000${r.name}\u0000${r.sql}\n`);
    return h.digest('hex').slice(0, 16);
  } finally { closeLocalDb(db); }
}

/** 本地库状态（单个或全部） */
export function getLocalDbStatus(name) {
  const info = sqliteInfo();
  const root = localDbRoot();
  const files = listLocalDbFiles();
  const cfg = readLocalDbConfig();
  const readSettings = readLocalDbSettings();
  const writeAudit = readWriteAuditConfig();
  const describe = (f) => {
    const base = { name: f.name, file: f.file, bytes: f.bytes, mtime: new Date(f.mtimeMs).toISOString() };
    const dbCfg = cfg.databases?.[f.name] ?? null;
    try {
      const tables = listLocalTables(f.name);
      return {
        ...base,
        tables: tables.length,
        tableNames: tables.slice(0, 50),
        schemaHash: localSchemaHash(f.name),
        sqliteVersion: info.available ? info.sqliteVersion : null,
        ...(dbCfg ? { config: dbCfg } : {}),
      };
    } catch (e) {
      return { ...base, error: e.message };
    }
  };
  if (name) {
    const cleanName = String(name).replace(/\.sqlite$/i, '');
    const file = files.find((f) => f.name === cleanName);
    return {
      ...info,
      root,
      configPath: localDbConfigPath(),
      defaultDb: cfg.default || 'main',
      db: file ? describe(file) : { name: cleanName, file: localDbPath(cleanName), exists: false },
      config: cfg,
      settings: readSettings,
      writeAudit,
    };
  }
  return {
    ...info,
    root,
    configPath: localDbConfigPath(),
    defaultDb: cfg.default || 'main',
    dbs: files.map(describe),
    config: cfg,
    settings: readSettings,
    writeAudit,
  };
}

/** 恢复“不存在即报错”的统一入口：返回 file + name，供工具层早失败 */
export function requireLocalDb(name, opts = {}) {
  const resolved = resolveLocalDbName({ db: name, connection: opts.connection });
  if (!resolved.exists) throw new Error(`本地库 "${resolved.name}" 不存在：${resolved.file}\n${localDbGuide(resolved.name)}`);
  return resolved;
}

// ---------------- 快照 / 恢复 / 导出 ----------------

const SNAPSHOT_RE = /^[A-Za-z0-9._-]{1,64}$/;

/** 备份快照（SQLite backup API；异步） */
export async function snapshotLocalDb(name, snapshotName = null) {
  const cleanName = String(name).replace(/\.sqlite$/i, '');
  const snap = String(snapshotName ?? new Date().toISOString().replace(/[:.]/g, '-'));
  if (!SNAPSHOT_RE.test(snap)) throw new Error(`快照名非法：${snap}（只允许字母/数字/._-）`);
  const { backup } = loadSqlite();
  const src = openLocalDb(cleanName, { internal: true, mustExist: true });
  const dir = path.join(localDbRoot(), 'snapshots', cleanName);
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, `${snap}.sqlite`);
  try {
    await backup(src, dest);
    return { ok: true, db: cleanName, snapshot: snap, file: dest, bytes: fs.statSync(dest).size };
  } finally {
    closeLocalDb(src);
  }
}

/** 从快照恢复（用 backup 反向覆盖；先确认目标库可写） */
export async function restoreLocalDb(name, snapshotName) {
  const cleanName = String(name).replace(/\.sqlite$/i, '');
  const snap = String(snapshotName ?? '');
  if (!SNAPSHOT_RE.test(snap)) throw new Error(`快照名非法：${snap}`);
  const dir = path.join(localDbRoot(), 'snapshots', cleanName);
  const srcFile = path.join(dir, `${snap}.sqlite`);
  if (!fs.existsSync(srcFile)) throw new Error(`快照不存在：${srcFile}`);
  const { backup } = loadSqlite();
  localDbPath(cleanName); // 路径守卫
  const src = openLocalDbFromFile(srcFile);
  try {
    await backup(src, localDbPath(cleanName));
    return { ok: true, db: cleanName, snapshot: snap, restoredFrom: srcFile };
  } finally {
    closeLocalDb(src);
  }
}

function openLocalDbFromFile(file) {
  const Ctor = loadCtor();
  const db = new Ctor(file, { readOnly: true, timeout: 5000, enableDoubleQuotedStringLiterals: true, readBigInts: true });
  try {
    registerMySqlFunctions(db);
    return db;
  } catch (e) {
    closeLocalDb(db);
    throw e;
  }
}

/** 导出可入库的 SQL 文本（schema.sql + data.sql + meta.json；二进制 .sqlite 不入 git） */
export function exportLocalDbSql(name, { includeData = true, tables = null } = {}) {
  const cleanName = String(name).replace(/\.sqlite$/i, '');
  const db = openLocalDb(cleanName, { internal: true, mustExist: true });
  try {
    const allTables = db.prepare("SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '__cpt_%' AND sql IS NOT NULL ORDER BY name").all()
      .filter((t) => !tables || tables.includes(t.name));
    const schemaParts = [];
    const dataParts = [];
    for (const t of allTables) {
      schemaParts.push(`${t.sql};`);
      const idxSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name=? AND sql IS NOT NULL ORDER BY name").all(t.name);
      for (const i of idxSql) schemaParts.push(`${i.sql};`);
    }
    if (includeData) {
      for (const t of allTables) {
        if (t.name.startsWith('__cpt_')) continue;
        const rows = db.prepare(`SELECT * FROM "${t.name.replace(/"/g, '""')}"`).all();
        const cols = db.prepare('SELECT name FROM pragma_table_info(?)').all(t.name).map((c) => c.name);
        for (const r of rows) {
          const vals = cols.map((c) => sqlLiteral(toJsonSafe(r[c])));
          dataParts.push(`INSERT INTO "${t.name.replace(/"/g, '""')}" (${cols.map((c) => `"${c.replace(/"/g, '""')}"`).join(', ')}) VALUES (${vals.join(', ')});`);
        }
      }
    }
    const schemaSql = schemaParts.join('\n') + '\n';
    const dataSql = dataParts.join('\n') + (dataParts.length ? '\n' : '');
    const meta = {
      db: cleanName,
      exportedAt: new Date().toISOString(),
      sqliteVersion: sqliteInfo().sqliteVersion ?? null,
      schemaHash: localSchemaHash(cleanName),
      tables: allTables.map((t) => t.name),
      includeData,
      note: '由 cpt-mcp 本地 SQLite 生成；二进制 .sqlite 不入 git，提交本目录的 schema.sql/data.sql 即可重建 fixture',
    };
    const outDir = path.join(localDbRoot(), 'exports', cleanName);
    fs.mkdirSync(outDir, { recursive: true });
    const files = {
      schema: path.join(outDir, 'schema.sql'),
      data: includeData ? path.join(outDir, 'data.sql') : null,
      meta: path.join(outDir, 'meta.json'),
    };
    fs.writeFileSync(files.schema, schemaSql, 'utf8');
    if (files.data) fs.writeFileSync(files.data, dataSql, 'utf8');
    fs.writeFileSync(files.meta, JSON.stringify(meta, null, 2) + '\n', 'utf8');
    return {
      ok: true,
      db: cleanName,
      dir: outDir,
      files,
      tables: meta.tables,
      samples: includeData ? dataParts.length : 0,
      note: '把 schema.sql/data.sql 提交到版本库即可跨机器重建；库文件本身不建议提交',
    };
  } finally { closeLocalDb(db); }
}

function sqlLiteral(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'string') {
    if (v.startsWith('base64:')) return `X'${Buffer.from(v.slice(7), 'base64').toString('hex')}'`;
    return `'${v.replace(/'/g, "''")}'`;
  }
  return `'${String(v).replace(/'/g, "''")}'`;
}

/** 目录是否在根内（测试用） */
export function isPathInsideRoot(p) {
  try {
    const root = fs.realpathSync(localDbRoot());
    const real = fs.realpathSync(p);
    const rel = path.relative(root, real);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  } catch {
    return false;
  }
}

export { os };
