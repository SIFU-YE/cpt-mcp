// cpt-mcp/lib/path-util.js —— 文件路径归一（leaf：只依赖 node:path）
//
// 2026-10-29 整理：同一实现（resolve + win32 小写）曾在 cell-batch.js / deep-tools.js /
// js-baseline.js / read-gate.js 各抄一份。租约/选择集/JS 基线/读取门禁都靠它做"同一文件"判定，
// 副本一旦分叉就会出现"同一路径判成两个文件"的隐蔽 bug，故收敛为单一实现。

import path from 'node:path';

export const normalizePath = (filePath) => {
  const resolved = path.resolve(filePath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
};
