// cpt-mcp/lib/preview-local-guard.js —— 内置 FR 预览的数据连接安全围栏（2026-11-09）
//
// 用户约束：**不允许内置环境直接连接生产数据库；只允许 MCP 从生产库只读取数/结构，
// 再导入内置 SQLite。**
//
// FR 预览实例的平台库（finedb）会继承设计器/种子里的 ConnectionConfig。若种子里有
// jdbc:mysql://生产地址，预览页的数据集和填报提交会直接打到生产库——这是必须拦住的
// 旁路。本模块只读扫描 finedb 的 db.script/db.log，识别 ConnectionConfig.connections.*.url：
//   · 允许：jdbc:sqlite:（内置 SQLite）与 jdbc:hsqldb:file:/mem:（本地平台库）；
//   · 其它 jdbc: URL（mysql/doris/oracle/sqlserver/...）一律视为外部生产连接，阻止启动。
//
// 预览启动前调用 inspectPreviewFinedb() 做硬拦截；MCP 自己的真实库只读通道不经过这里。

import fs from 'node:fs';
import path from 'node:path';

const ENTITY_ROW_RE = /INSERT\s+INTO\s+(?:PUBLIC\.)?FINE_CONF_ENTITY\s+VALUES\s*\(\s*'ConnectionConfig\.connections\.(.+?)\.url'\s*,\s*'((?:''|[^'])*)'\s*\)/gi;

/** HSQLDB SQL 字符串反转义（'' → '）。 */
function unescapeSqlString(s) {
  return String(s).replace(/''/g, "'");
}

/**
 * 从 HSQLDB db.script/db.log 文本提取数据连接 URL。
 * @param {string} text
 * @returns {{name:string,url:string}[]}
 */
export function extractConnectionUrls(text) {
  const out = [];
  if (!text) return out;
  for (const m of String(text).matchAll(ENTITY_ROW_RE)) {
    out.push({ name: unescapeSqlString(m[1]), url: unescapeSqlString(m[2]) });
  }
  return out;
}

/** 只允许内置 SQLite / 本地 HSQLDB；空 URL 视作未配置，不主动连外部。 */
export function isLocalJdbcUrl(url) {
  const u = String(url ?? '').trim();
  if (!u || u === '__EMPTY__') return true;
  return /^jdbc:sqlite:/i.test(u) || /^jdbc:hsqldb:(file|mem):/i.test(u);
}

function readIfExists(file) {
  try {
    return fs.existsSync(file) && fs.statSync(file).isFile() ? fs.readFileSync(file, 'utf8') : null;
  } catch {
    return null;
  }
}

/**
 * 只读检查预览平台库中的外部数据连接。
 *
 * 同时检查 `.fr-preview/finedb-seed`（若存在）与 FR_HOME 的 finedb 回退源；
 * 任一来源出现非本地 URL 都拒绝，避免“种子缺文件时回退到设计器生产连接”。
 *
 * @param {{seedDir?:string, frHome?:string}} [o]
 * @returns {{ok:boolean, blocked:{name:string,url:string}[], localCount:number,
 *   sources:string[], reason?:string}}
 */
export function inspectPreviewFinedb({ seedDir, frHome } = {}) {
  const candidates = [];
  if (seedDir) {
    candidates.push({ source: `${seedDir}/db.script`, file: path.join(seedDir, 'db.script') });
    candidates.push({ source: `${seedDir}/db.log`, file: path.join(seedDir, 'db.log') });
  }
  if (frHome) {
    const embed = path.join(frHome, 'bin', 'embed', 'finedb');
    candidates.push({ source: `${embed}/db.script`, file: path.join(embed, 'db.script') });
    candidates.push({ source: `${embed}/db.log`, file: path.join(embed, 'db.log') });
  }
  const seen = [];
  const blocked = [];
  let localCount = 0;
  for (const c of candidates) {
    const text = readIfExists(c.file);
    if (text == null) continue;
    seen.push(c.source);
    for (const row of extractConnectionUrls(text)) {
      if (isLocalJdbcUrl(row.url)) {
        localCount += 1;
      } else {
        blocked.push(row);
      }
    }
  }
  return {
    ok: blocked.length === 0,
    blocked,
    localCount,
    sources: [...new Set(seen)],
    ...(blocked.length
      ? { reason: `FR 预览平台库发现 ${blocked.length} 个外部 JDBC 连接（${blocked.map((b) => b.name).join('、')}）；内置环境禁止直连生产库` }
      : {}),
  };
}
