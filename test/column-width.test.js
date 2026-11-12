// test/column-width.test.js —— M99-D3 列宽藏列豁免
//
// 背景：重审 U5 确认误报为主——填报命令列故意设 0.1/0.01mm 隐藏，其表头文本必然
// “超宽”，reason.js 1b 规则逐格报警，纯噪音。修法：可用宽度 <2mm 视为藏列跳过
// （可见列最小 21mm，阈值无误伤）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCpt, addCell } from '../lib/generate.js';
import { setGrid } from '../lib/generate.js';
import { reviewReasonableness } from '../lib/engine/index.js';
import '../scripts/isolate-store.mjs'; // M123：JS 基线 store 隔离，直跑也不污染真实 store

delete process.env.CPT_MCP_ALLOWED_ROOTS;

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-colw-'));
const LONG = '这是一段故意写得很长的表头文本用于触发列宽估算告警';
const widthWarns = (p) => reviewReasonableness(p).issues.filter((i) => /列宽疑似不足/.test(i.message));

test('M99-D3 藏列豁免：0.1mm 命令列长文本不告警', () => {
  const d = tmp();
  const p = path.join(d, 'a.cpt');
  createCpt(p, { rows: 2, columns: 2 });
  addCell(p, { column: 0, row: 0, content: LONG });
  setGrid(p, { columnWidths: [14400, 3168000] }); // c0 = 0.1mm（藏列），c1 = 22mm
  assert.equal(widthWarns(p).length, 0, '藏列文本再长也不应报列宽');
  fs.rmSync(d, { recursive: true, force: true });
});

test('M99-D3 可见窄列仍告警（豁免无误伤）', () => {
  const d = tmp();
  const p = path.join(d, 'a.cpt');
  createCpt(p, { rows: 2, columns: 2 });
  addCell(p, { column: 0, row: 0, content: LONG });
  setGrid(p, { columnWidths: [1440000, 3168000] }); // c0 = 10mm 可见窄列
  const warns = widthWarns(p);
  assert.equal(warns.length, 1, '可见窄列长文本应继续告警');
  assert.match(warns[0].location, /单元格\(sheet1\.0,0\)/);
  fs.rmSync(d, { recursive: true, force: true });
});
