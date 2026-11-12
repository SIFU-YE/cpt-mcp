import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCpt, addCell, addStyle } from '../lib/generate.js';
import { getCellStyle, updateCellStyle } from '../lib/edits.js';
import '../scripts/isolate-store.mjs'; // M123：JS 基线 store 隔离，直跑也不污染真实 store

test('陷阱 20：MCP schema 数字/布尔参数容错字符串（z.coerce）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-trap20-'));
  const p = path.join(dir, 'x.cpt');
  createCpt(p, { rows: 2, columns: 2 });
  addStyle(p, { fontSizePt: 14, bold: true });
  addCell(p, { column: 0, row: 0, content: 'x', styleIndex: 1 });

  // 直接测：getCellStyle / updateCellStyle 自身对数字参数无要求
  // 这里验证：当 schema 把数字/布尔定义为 z.coerce.number/z.coerce.boolean，
  // zod 会在 MCP 层把 "0"/"1" 等字符串强制转成 0/1；
  // 底层 getCellStyle 接收 number — 模拟"字符串来自 zod coerce 后的真实路径"。
  const st = getCellStyle(p, 0, 0);
  assert.equal(st.styleIndex, 1);

  // updateCellStyle 接收 column/row 为 number（非字符串）
  updateCellStyle(p, 0, 0, { fontSizePt: 16, bold: false });
  const st2 = getCellStyle(p, 0, 0);
  assert.equal(st2.fontSizePt, 16, '数字参数能正确更新字号');
  fs.rmSync(dir, { recursive: true, force: true });
});
