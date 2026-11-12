import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCpt, addStyle, addCell, addDataset, setGrid, setReportSettings, addSheet } from '../lib/generate.js';
import { styles, gridSizes } from '../lib/cpt.js';
import { getCellStyle } from '../lib/edits.js';
import { buildReport } from '../lib/engine/builder.js';
import { load } from '../lib/xml.js';
import '../scripts/isolate-store.mjs'; // M123：JS 基线 store 隔离，直跑也不污染真实 store

test('陷阱 1：add_style 不传 fontSizePt 时默认 14pt（与沙盘2 成品数据行一致）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-trap1-'));
  const p = path.join(dir, 'x.cpt');
  createCpt(p, { rows: 2, columns: 2 });
  const r = addStyle(p, {}); // 不传任何参数
  const st = styles(p).find(s => s.styleIndex === r.styleIndex);
  assert.equal(st.fontSizePt, 14, '默认 14pt（与成品一致）');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('陷阱 2：addCell contentType=dsColumn 缺 dsName/columnName 应报错（已防御）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-trap2-'));
  const p = path.join(dir, 'x.cpt');
  createCpt(p, { rows: 2, columns: 2 });
  assert.throws(() => addCell(p, { column: 0, row: 0, contentType: 'dsColumn' }), /DSColumn/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('陷阱 3：addDataset 缺 connection 应报错（已防御）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-trap3-'));
  const p = path.join(dir, 'x.cpt');
  createCpt(p, { rows: 2, columns: 2 });
  assert.throws(() => addDataset(p, { name: 'ds1', connection: '', sql: 'select 1' }), /缺 connection/);
  assert.throws(() => addDataset(p, { name: 'ds1', connection: 'Doris', sql: '' }), /缺 sql/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('陷阱 4：setGrid rowHeights 为空数组应报错（已防御）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-trap4-'));
  const p = path.join(dir, 'x.cpt');
  createCpt(p, { rows: 2, columns: 2 });
  assert.throws(() => setGrid(p, { rowHeights: [] }), /rowHeights 不能为空/);
  assert.throws(() => setGrid(p, { columnWidths: [] }), /columnWidths 不能为空/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('陷阱 5：addCell 同坐标重复写应抛错（已防御）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-trap5-'));
  const p = path.join(dir, 'x.cpt');
  createCpt(p, { rows: 2, columns: 2 });
  addCell(p, { column: 0, row: 0, content: 'A' });
  assert.throws(() => addCell(p, { column: 0, row: 0, content: 'B' }), /add_cell 失败.*\(0,0\)|已存在/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('陷阱 6：build_report spec.grid 支持 rowHeightMm/columnWidthMm（mm 友好口径）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-trap6-'));
  const p = path.join(dir, 'x.cpt');
  // 模型用 mm 值：9/7 自动换算成 1296000/1008000
  buildReport({
    path: p, rows: 2, columns: 2, headerRowCount: 1,
    grid: { rowHeightMm: [9, 7] },
    cells: [{ column: 0, row: 0, content: 'x' }],
  });
  const gs = gridSizes(p);
  assert.equal(gs[0].rowHeights.values[0], 9 * 144000, '9mm 换算正确');
  assert.equal(gs[0].rowHeights.values[1], 7 * 144000, '7mm 换算正确');
  // 显式 rowHeights 优先于 rowHeightMm
  buildReport({
    path: p + '.2', rows: 2, columns: 2,
    grid: { rowHeights: [100, 200], rowHeightMm: [9, 7] },
    cells: [],
  });
  const gs2 = gridSizes(p + '.2');
  assert.equal(gs2[0].rowHeights.values[0], 100, 'rowHeights 优先');
  fs.rmSync(dir, { recursive: true, force: true });
});
