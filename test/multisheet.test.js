import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCpt, addSheet, addCell } from '../lib/generate.js';
import { cells } from '../lib/cpt.js';
import { getCellStyle, deleteCell } from '../lib/edits.js';
import { validateCpt } from '../lib/validate.js';
import '../scripts/isolate-store.mjs'; // M123：JS 基线 store 隔离，直跑也不污染真实 store

test('多工作表：add_sheet + add_cell(sheet) + 读取/样式/删除/校验', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-ms-'));
  const p = path.join(dir, 'x.cpt');
  createCpt(p, { rows: 3, columns: 4 });

  const r = addSheet(p, { sheetName: 'sheet2', rows: 3, columns: 4 });
  assert.equal(r.sheet, 'sheet2');

  // 同一坐标(0,0)分别写入 sheet1(索引0) 与 sheet2(名称)
  addCell(p, { column: 0, row: 0, content: 'A', sheet: 0 });
  addCell(p, { column: 0, row: 0, content: 'B', sheet: 1 });
  addCell(p, { column: 1, row: 0, content: 'C', sheet: 'sheet2' });

  const cs = cells(p);
  assert.equal(cs.length, 3);
  assert.equal(cs.filter((c) => c.sheetIndex === 0).length, 1, 'sheet1 应只有 1 个单元格');
  assert.equal(cs.filter((c) => c.sheetIndex === 1).length, 2, 'sheet2 应有 2 个单元格');

  // get_cell_style 按 sheet 定位同坐标单元格
  const st0 = getCellStyle(p, 0, 0, 0);
  const st1 = getCellStyle(p, 0, 0, 1);
  assert.equal(st0.styleIndex, 0);
  assert.equal(st1.styleIndex, 0);

  // delete_cell 限 sheet2（名称形式）只删 sheet2 的 (0,0)
  deleteCell(p, 0, 0, 'sheet2');
  const cs2 = cells(p);
  assert.equal(cs2.length, 2);
  assert.equal(cs2.filter((c) => c.sheetIndex === 0).length, 1, 'sheet1 (0,0) 不应被误删');

  const issues = validateCpt(p);
  assert.equal(issues.filter((i) => i.severity === 'error').length, 0, '多 sheet 产物校验应无 error');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('多工作表：addSheet 重名应报错', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-ms2-'));
  const p = path.join(dir, 'x.cpt');
  createCpt(p, { rows: 2, columns: 2 });
  addSheet(p, { sheetName: '常规填报' });
  assert.throws(() => addSheet(p, { sheetName: '常规填报' }), /工作表已存在/);
  fs.rmSync(dir, { recursive: true, force: true });
});
