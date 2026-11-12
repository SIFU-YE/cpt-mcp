// test/rowheight-fix.test.js —— P2-1：新增行行高耦合收敛
//
// 背景（造数验证 t2）：新增行不补行高，gate 即报 RowHeight 警告，规则严但修法散。
// 修法②：警告文案直接给出可执行 fix（get_grid 取数组→尾部按缺省补齐→set_grid 回写）。
// 未选①（写入时自动继承）：会改变 add_cell 落盘字节、冲击 golden，且 FR 本就用
// defaultValue 回退，文件合法，warning 只是提示。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createCpt, addCell, setGrid } from '../lib/generate.js';
import { gridSizes } from '../lib/cpt.js';
import { reviewReasonableness } from '../lib/engine/index.js';
import { qualityGate } from '../lib/quality.js';
import '../scripts/isolate-store.mjs'; // M123：JS 基线 store 隔离，直跑也不污染真实 store

delete process.env.CPT_MCP_ALLOWED_ROOTS;

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-rowh-'));

test('P2-1 超界 warning 自带可执行 suggestion（含具体补齐数）', () => {
  const d = tmp();
  const p = path.join(d, 'a.cpt');
  createCpt(p, { rows: 3, columns: 3 });
  addCell(p, { column: 0, row: 5, content: '新增行' });
  addCell(p, { column: 5, row: 0, content: '新增列' });

  const rs = reviewReasonableness(p);
  const rowW = rs.issues.filter((i) => /超出 RowHeight 数量/.test(i.message));
  assert.equal(rowW.length, 1, `应报1条行高warning：${JSON.stringify(rs.issues)}`);
  assert.equal(rowW[0].severity, 'warning', '保持 warning，不升级 error');
  assert.match(rowW[0].suggestion, /set_grid\(\{ rowHeights: \[\.\.\.\] \}\)/, 'fix 指向 set_grid 数组口径');
  assert.match(rowW[0].suggestion, /补齐至 6 个/, '给出具体补齐数（行号5→6个）');
  assert.match(rowW[0].suggestion, /723900/, '给出默认行高');
  assert.match(rowW[0].suggestion, /勿用裸 rowCount/, '警示裸 rowCount 会重置自定义行高');

  const colW = rs.issues.filter((i) => /超出 ColumnWidth 数量/.test(i.message));
  assert.equal(colW.length, 1);
  assert.match(colW[0].suggestion, /set_grid\(\{ columnWidths: \[\.\.\.\] \}\)/);
  assert.match(colW[0].suggestion, /补齐至 6 个/);
  fs.rmSync(d, { recursive: true, force: true });
});

test('P2-1 gate advisory 带 fix，且 warning 不阻断 pass', () => {
  const d = tmp();
  const p = path.join(d, 'b.cpt');
  createCpt(p, { rows: 3, columns: 3 });
  addCell(p, { column: 0, row: 4, content: '新增行' });

  const gate = qualityGate(p);
  assert.equal(gate.pass, true, 'warning 级别不阻断交付');
  const adv = gate.advisories.filter((a) => /超出 RowHeight 数量/.test(a.message));
  assert.equal(adv.length, 1, 'gate advisory 应含该 warning');
  assert.match(adv[0].fix, /set_grid/, 'advisory fix 可执行');
  assert.match(adv[0].fix, /723900/);
  fs.rmSync(d, { recursive: true, force: true });
});

test('P2-1 按指引执行可闭环（补齐后 warning 消除，既有自定义行高保留）', () => {
  const d = tmp();
  const p = path.join(d, 'c.cpt');
  createCpt(p, { rows: 3, columns: 3 });
  // 先设一个自定义表头行高，验证闭环过程不重置它
  setGrid(p, { rowHeights: [1296000, 1008000, 1008000] });
  addCell(p, { column: 0, row: 4, content: '新增行' });
  assert.ok(reviewReasonableness(p).issues.some((i) => /超出 RowHeight 数量/.test(i.message)), '先决：应有 warning');

  // 指引口径：get_grid 取数组 → 尾部按缺省补齐 → set_grid 回写
  const cur = gridSizes(p).find((g) => g.sheetIndex === 0).rowHeights.values;
  assert.deepEqual(cur, [1296000, 1008000, 1008000]);
  const padded = [...cur];
  while (padded.length < 5) padded.push(723900);
  setGrid(p, { rowHeights: padded });

  const after = reviewReasonableness(p);
  assert.equal(after.issues.filter((i) => /超出 RowHeight 数量/.test(i.message)).length, 0, '补齐后 warning 消除');
  const kept = gridSizes(p).find((g) => g.sheetIndex === 0).rowHeights.values;
  assert.deepEqual(kept, [1296000, 1008000, 1008000, 723900, 723900], '自定义行高保留，新增行用缺省');
  fs.rmSync(d, { recursive: true, force: true });
});

test('P2-1 基线：界内单元格无超界 warning', () => {
  const d = tmp();
  const p = path.join(d, 'd.cpt');
  createCpt(p, { rows: 3, columns: 3 });
  addCell(p, { column: 0, row: 0, content: 'a' });
  addCell(p, { column: 2, row: 2, content: 'b' });
  const rs = reviewReasonableness(p);
  assert.equal(rs.issues.filter((i) => /超出 (RowHeight|ColumnWidth) 数量/.test(i.message)).length, 0);
  fs.rmSync(d, { recursive: true, force: true });
});
