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

function sqlString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
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
  const sql = [
    "DELETE FROM FINE_CONF_ENTITY WHERE ID LIKE 'ConnectionConfig.connections%';",
    ...rows.map(([id, value]) => `INSERT INTO FINE_CONF_ENTITY VALUES(${sqlString(id)}, ${sqlString(value)});`),
  ].join('\n');
  return { sql, names, rows };
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
  fs.appendFileSync(script, `\n-- cpt-mcp: local-only data connections\n${built.sql}\n`, 'utf8');
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
