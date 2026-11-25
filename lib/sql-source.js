// cpt-mcp/lib/sql-source.js
// SQL 来源解析（2026-11-23 新增）
//
// 【为什么需要这一层】
//   add_dataset / update_dataset / build_report / generate_report 原先只接受**内联在参数里的 SQL**。
//   现实里两段报表 SQL 合计 1647 行（约 50KB），让模型把 SQL 原文塞进工具参数既贵又易截断；
//   而"从文件读 SQL"没有入口，只能退化成多次 add_cell / 手动粘贴。
//   本模块把「SQL 文本」与「SQL 来源（内联 / 文件）」解耦成统一入口，各业务模块只依赖
//   `resolveSql()` 的返回值，不再各自实现文件读取与安全校验。
//
// 【安全边界（与 CPT 路径同一套围栏）】
//   · 路径必须通过 security.assertToolPath（CPT_MCP_ALLOWED_ROOTS / 项目目录 / 临时目录；
//     拒绝 .git、node_modules 等受保护段；Windows 备用数据流/结尾点空格等混淆一律拒绝）
//   · 只接受 .sql / .txt 普通文件（拒绝目录、符号链接指向的非常规文件、二进制）
//   · 体积上限默认 2MB（CPT_MCP_SQL_FILE_MAX_BYTES 可调），防止把巨型文件读进上下文/内存
//   · UTF-8 读取并剥 BOM；含 NUL 字节视为二进制直接拒绝
//   · 只读属性：本模块不写任何文件
import fs from 'node:fs';
import path from 'node:path';
import { assertToolPath } from './security.js';

export const SQL_FILE_MAX_BYTES = (() => {
  const raw = Number(process.env.CPT_MCP_SQL_FILE_MAX_BYTES);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 2_000_000;
})();

const SQL_FILE_EXTENSIONS = new Set(['.sql', '.txt']);

/** 从文件读取 SQL；失败信息全部可操作（说清哪个参数、哪个路径、怎么改）。 */
export function sqlFromFile(sqlFile, { toolName = 'add_dataset', label = 'sqlFile' } = {}) {
  if (typeof sqlFile !== 'string' || !sqlFile.trim()) {
    throw new Error(`${label} 必须是非空文件路径（字符串）`);
  }
  const raw = sqlFile.trim();
  const abs = assertToolPath(toolName, raw, { write: false });

  let stat;
  try {
    stat = fs.statSync(abs);
  } catch {
    throw new Error(`${label} 指向的文件不存在或不可读：${abs}`);
  }
  if (!stat.isFile()) throw new Error(`${label} 必须是普通文件（当前是目录或特殊文件）：${abs}`);
  const ext = path.extname(abs).toLowerCase();
  if (!SQL_FILE_EXTENSIONS.has(ext)) {
    throw new Error(`${label} 只接受 .sql / .txt 文本文件，收到 "${ext || '(无扩展名)'}"：${abs}`);
  }
  if (stat.size > SQL_FILE_MAX_BYTES) {
    throw new Error(
      `${label} 体积 ${stat.size}B 超过上限 ${SQL_FILE_MAX_BYTES}B（可用 CPT_MCP_SQL_FILE_MAX_BYTES 调整）：${abs}`
    );
  }
  const buffer = fs.readFileSync(abs);
  if (buffer.includes(0)) throw new Error(`${label} 含 NUL 字节，疑似二进制文件（只接受 UTF-8 文本 SQL）：${abs}`);
  let sql = buffer.toString('utf8');
  if (sql.charCodeAt(0) === 0xfeff) sql = sql.slice(1); // 剥 UTF-8 BOM
  if (!sql.trim()) throw new Error(`${label} 内容为空：${abs}`);
  return {
    sql,
    fromFile: { path: abs, bytes: stat.size, encoding: 'utf-8' },
  };
}

/**
 * 统一解析 SQL 来源：内联 sql 与 sqlFile 二选一。
 * @returns {{sql: string|undefined, fromFile: {path:string,bytes:number,encoding:string}|null}}
 */
export function resolveSql({ sql, sqlFile, toolName = 'add_dataset', label = 'sql' } = {}) {
  const hasSql = sql !== undefined && sql !== null && String(sql).trim() !== '';
  const hasFile = sqlFile !== undefined && sqlFile !== null;
  if (hasSql && hasFile) {
    throw new Error(`${label} 与 ${label}File 只能二选一：把 SQL 直接写进 ${label}，或只给 ${label}File 指向 .sql/.txt 文件`);
  }
  if (hasFile) return sqlFromFile(sqlFile, { toolName, label: `${label}File` });
  return { sql: hasSql ? sql : undefined, fromFile: null };
}

/** 供工具返回体使用的来源摘要（不包含 SQL 全文，避免回显 50KB 上下文）。 */
export function describeSqlSource(fromFile) {
  if (!fromFile) return null;
  return { fromFile: fromFile.path, bytes: fromFile.bytes };
}
