// cpt-mcp/lib/preview-local-config.js —— 把内置 SQLite 连接写入 FR 预览的 finedb（2026-11-09）
//
// 目标：`start_fr_preview` 不再让用户手工到 adminUrl 配连接。MCP 已经用只读通道把
// 生产 schema/样例导入 `<cwd>/.cpt-mcp/localdb/*.sqlite`，这里只把**本地 SQLite**
// 连接写进预览实例的 HSQLDB finedb；绝不写任何生产 JDBC URL/凭据。
//
// 做法（FineReport 官方 finedb 结构）：
//   FINE_CONF_ENTITY:
//     ConnectionConfig.connections                       -> ["连接名", ...]
//     ConnectionConfig.connections.<name>.*              -> driver/url/...
// 预览运行库在 runtime 的 WEB-INF/embed/finedb；启动前：
//   1) 删除 db.log（避免旧种子日志在脚本之后重放、把生产连接又带回来）；
//   2) 向 db.script 追加 DELETE 全部 ConnectionConfig 行 + 本地 SQLite 连接行。
// 只允许 .cpt-mcp/localdb 下的 SQLite 文件；URL 由本模块拼装，不接受外部 JDBC URL。

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const LOCAL_DBCP_ATTRS = {
  initialSize: '0',
  keepAlive: 'true',
  keepAliveBetweenTimeMillis: '120000',
  maxActive: '50',
  maxEvictableIdleTimeMillis: '25200000',
  maxIdle: '10',
  maxWait: '10000',
  minEvictableIdleTimeMillis: '1800000',
  minIdle: '0',
  numTestsPerEvictionRun: '3',
  testOnBorrow: 'false',
  testOnReturn: 'false',
  testWhileIdle: 'false',
  timeBetweenEvictionRunsMillis: '-1',
  validationQuery: '__EMPTY__',
};

// HSQLDB ScriptReaderText 按 Latin-1 逐字节读取 db.script：非 ASCII 文本必须以
// \uXXXX 码元转义写入（种子 db.script 实测 2.7MB 全 ASCII，真实中文全部 \uXXXX
// 存放，如 \u667a\u6167\u6570\u636e=智慧数据）。2026-11-20 事故：中文连接名按
// 原始 UTF-8 字节写入 → 平台按 Latin-1 读回成乱码键（填报 → \u00e5\u00a1\u00ab…）
// → 模板报 31300013「找不到数据连接」、填报网格整页不渲染；纯 ASCII 名（Doris）
// 不受影响。转义顺序必须先反斜杠、再单引号、最后非 ASCII：\uXXXX 由本函数引入，
// 不能让数据里原有的反斜杠破坏它；HSQLDB 对未知转义序列按字面保留，因此反斜杠
// 写作 \u005c（由读侧统一解码），而不是 \\ 加倍。
function sqlString(value) {
  const escaped = String(value)
    .replace(/\\/g, '\\u005c')
    .replace(/'/g, "''")
    .replace(/[\u0080-\uffff]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`);
  return `'${escaped}'`;
}

function assertLocalConnection(connection) {
  const name = String(connection?.name ?? '').trim();
  const dbFile = path.resolve(String(connection?.dbFile ?? ''));
  if (!name) throw new Error('本地连接缺少 name');
  if (/[\r\n]/.test(name)) throw new Error(`本地连接名含换行/回车：${JSON.stringify(name)}`);
  if (!/\.sqlite$/i.test(dbFile)) {
    throw new Error(`本地连接 ${name} 只允许 .sqlite 文件：${dbFile}`);
  }
  if (!dbFile || !fs.existsSync(dbFile) || !fs.statSync(dbFile).isFile()) {
    throw new Error(`本地连接 ${name} 的 SQLite 文件不存在：${dbFile}`);
  }
  return { name, dbFile, url: `jdbc:sqlite://${dbFile.replace(/\\/g, '/')}` };
}

/**
 * 生成写入 FINE_CONF_ENTITY 的 HSQLDB SQL。纯函数，便于单测。
 * 调用方负责保证 connections 来自本地 SQLite；这里仍做文件/后缀/名称校验。
 * @param {{name:string, dbFile:string}[]} connections
 * @returns {{sql:string, names:string[], rows:Array<[string,string]>}}
 */
export function buildLocalConnectionSql(connections = []) {
  const safe = [];
  const seen = new Set();
  for (const c of Array.isArray(connections) ? connections : []) {
    const local = assertLocalConnection(c);
    const key = local.name.toLowerCase();
    if (seen.has(key)) throw new Error(`本地连接重名：${local.name}`);
    seen.add(key);
    safe.push(local);
  }
  const names = safe.map((c) => c.name);
  const rows = [['ConnectionConfig.connections', JSON.stringify(names)]];
  for (const c of safe) {
    const p = `ConnectionConfig.connections.${c.name}`;
    rows.push([`${p}.authentication.username`, '__EMPTY__']);
    rows.push([`${p}.authentication.password`, '__EMPTY__']);
    rows.push([`${p}.catalog`, '__EMPTY__']);
    rows.push([`${p}.creator`, 'cpt-mcp-testenv']);
    rows.push([`${p}.database`, '__EMPTY__']);
    for (const [k, v] of Object.entries(LOCAL_DBCP_ATTRS)) rows.push([`${p}.dbcpAttr.${k}`, v]);
    rows.push([`${p}.driver`, 'org.sqlite.JDBC']);
    rows.push([`${p}.driverSource`, '__EMPTY__']);
    rows.push([`${p}.encryptPassword`, 'true']);
    rows.push([`${p}.fetchSize`, '-1']);
    rows.push([`${p}.identity`, crypto.randomUUID()]);
    rows.push([`${p}.schema`, '__EMPTY__']);
    rows.push([`${p}.url`, c.url]);
  }
  const sql = rows
    .map(([id, value]) => `INSERT INTO FINE_CONF_ENTITY VALUES(${sqlString(id)}, ${sqlString(value)});`)
    .join('\n');
  return { sql, names, rows };
}

/**
 * 从 HSQLDB db.script 文本里删掉所有 ConnectionConfig.connections 行。
 * HSQLDB ScriptReaderText 不接受 DELETE/COMMIT，所以只能做文本清理；同时清掉
 * 种子/运行库里可能残留的生产连接（只保留调用方马上要追加的本地 SQLite 连接）。
 * @param {string} scriptText
 * @returns {string}
 */
export function stripLocalConnectionRows(scriptText) {
  const lines = String(scriptText ?? '').split(/\r?\n/);
  const isConnectionRow = (line) =>
    /^DELETE FROM FINE_CONF_ENTITY WHERE ID LIKE 'ConnectionConfig\.connections%';?$/.test(line) ||
    /^INSERT INTO FINE_CONF_ENTITY\s+VALUES\s*\(\s*'ConnectionConfig\.connections/.test(line);
  const out = lines.filter((line) => !isConnectionRow(line.trim())).join('\n').replace(/\n+$/, '\n');
  return out.endsWith('\n') ? out : `${out}\n`;
}
/**
 * 把本地 SQLite 连接写入 runtime 的 finedb，并删除可能重放旧配置的 db.log。
 * 必须在 `prepareRuntime` 之后、spawn Java 之前调用；只改 runtime 副本，不碰 FR_HOME/种子。
 *
 * @param {string} finedbDir runtime 的 WEB-INF/embed/finedb
 * @param {{name:string, dbFile:string}[]} connections
 * @returns {{names:string[], script:string, logRemoved:boolean}}
 */
export function applyLocalConnectionsToFinedb(finedbDir, connections = []) {
  const dir = path.resolve(String(finedbDir ?? ''));
  const script = path.join(dir, 'db.script');
  if (!fs.existsSync(script)) throw new Error(`runtime finedb/db.script 不存在：${script}`);
  const built = buildLocalConnectionSql(connections);
  // 不能向 HSQLDB db.script 追加 DELETE（实测 ScriptReaderText 在 DELETE 行直接
  // 报 “error in script file”）；改为文本层移除旧的 ConnectionConfig.connections 行，
  // 再追加纯 INSERT。这样也顺便清掉种子里的外部连接配置，保证预览只连本地 SQLite。
  const cleaned = stripLocalConnectionRows(fs.readFileSync(script, 'utf8'));
  fs.writeFileSync(script, cleaned, 'utf8');
  const prefix = cleaned.endsWith('\n') ? '' : '\n';
  fs.appendFileSync(script, `${prefix}${built.sql}\n`, 'utf8');
  let logRemoved = false;
  for (const name of ['db.log', 'db.tmp']) {
    const f = path.join(dir, name);
    if (fs.existsSync(f)) {
      fs.rmSync(f, { force: true });
      if (name === 'db.log') logRemoved = true;
    }
  }
  return { names: built.names, script, logRemoved };
}
