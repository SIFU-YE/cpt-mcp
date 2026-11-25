// test/fill-binding-sheet.test.js —— P2-2：填报绑定多 sheet 口径加固
//
// 背景：add_fill_binding 多 sheet 下 submitIndex 口径反直觉（不传=全局连续编号，
// 传 sheet=表内相对索引），靠口口相传。修法：描述层加固 + 越界报错直接给分布与正确传参。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createCpt, addSheet, addCell, addFillSubmit } from '../lib/generate.js';
import { addFillBinding, updateFillBinding, deleteFillBinding } from '../lib/edits.js';
import { fillConfig } from '../lib/cpt.js';
import '../scripts/isolate-store.mjs'; // M123：JS 基线 store 隔离，直跑也不污染真实 store

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-bindsheet-'));

// 双表双提交：sheet1→t1（全局0/表内0），sheet2→t2（全局1/表内0）
function twoSheetTwoSubmits(dir, name = 'a.cpt') {
  const p = path.join(dir, name);
  createCpt(p, { rows: 3, columns: 3 });
  addSheet(p, { sheetName: 'sheet2', rows: 3, columns: 3 });
  addCell(p, { column: 0, row: 1, widget: 'text', sheet: 0 });
  addCell(p, { column: 0, row: 1, widget: 'text', sheet: 1 });
  addFillSubmit(p, { dsName: 'Doris', table: 't1', bindings: [{ field: 'f1', column: 0, row: 1 }], sheet: 0 });
  addFillSubmit(p, { dsName: 'Doris', table: 't2', bindings: [{ field: 'g1', column: 0, row: 1 }], sheet: 1 });
  return p;
}

test('P2-2 全局编号与表内索引等价（全局1 == sheet2表内0）', () => {
  const d = tmp();
  const p = twoSheetTwoSubmits(d);
  addFillBinding(p, 1, 'g2', 0, 1); // 全局编号，不传 sheet
  addFillBinding(p, 0, 'g3', 0, 1, false, 1); // 表内相对索引 + sheet
  const fc = fillConfig(p);
  const s2 = fc.submits.find((s) => s.sheet === 'sheet2');
  assert.ok(s2.columns.some((c) => c.field === 'g2'), '全局1 应落在 sheet2 提交');
  assert.ok(s2.columns.some((c) => c.field === 'g3'), 'sheet=1+表内0 应落在同一提交');
  const s1 = fc.submits.find((s) => s.sheet === 'sheet1');
  assert.ok(!s1.columns.some((c) => c.field === 'g2' || c.field === 'g3'), 'sheet1 提交不得被误绑');
  fs.rmSync(d, { recursive: true, force: true });
});

test('P2-2 越界报错直接给分布与正确传参（全局/表内两口径）', () => {
  const d = tmp();
  const p = twoSheetTwoSubmits(d);
  // 全局越界
  assert.throws(
    () => addFillBinding(p, 5, 'x', 0, 1),
    (e) => {
      assert.match(e.message, /全局连续编号/, '点明全局口径');
      assert.match(e.message, /submitIndex=5/, '回显请求值');
      assert.match(e.message, /现分布：.*sheet1.*sheet2/s, '给出提交分布');
      assert.match(e.message, /get_fill_config/, '指向查询工具');
      return true;
    },
    '全局越界应带指引',
  );
  // 表内越界
  assert.throws(
    () => addFillBinding(p, 3, 'x', 0, 1, false, 0),
    (e) => {
      assert.match(e.message, /表内相对索引/, '点明表内口径');
      assert.match(e.message, /工作表\[0\]/, '回显工作表');
      assert.match(e.message, /submitIndex=3/, '回显请求值');
      assert.match(e.message, /get_fill_config/, '指向查询工具');
      return true;
    },
    '表内越界应带指引',
  );
  // update/delete 同口径
  assert.throws(() => updateFillBinding(p, 2, 'g1', { column: 1 }), /全局连续编号/, 'update 全局越界同指引');
  assert.throws(() => deleteFillBinding(p, 2, 'g1', 1), /表内相对索引/, 'delete 表内越界同指引');
  fs.rmSync(d, { recursive: true, force: true });
});

test('P2-2 重复字段报错带口径（表内/全局）', () => {
  const d = tmp();
  const p = twoSheetTwoSubmits(d);
  assert.throws(
    () => addFillBinding(p, 0, 'g1', 0, 1, false, 1),
    /工作表\[1\]内第 1 个提交（表内相对索引）/,
    '表内重复应点明口径',
  );
  assert.throws(
    () => addFillBinding(p, 1, 'g1', 0, 1),
    /全局第 2 个提交（全局连续编号）/,
    '全局重复应点明口径',
  );
  fs.rmSync(d, { recursive: true, force: true });
});

test('P2-2 基线：单提交模板省略 sheet 照常工作', () => {
  const d = tmp();
  const p = path.join(d, 's.cpt');
  createCpt(p, { rows: 3, columns: 3 });
  addCell(p, { column: 0, row: 1, widget: 'text' });
  addFillSubmit(p, { dsName: 'Doris', table: 't', bindings: [{ field: 'f1', column: 0, row: 1 }] });
  addFillBinding(p, 0, 'f2', 0, 1);
  updateFillBinding(p, 0, 'f2', { column: 1 });
  assert.ok(fillConfig(p).submits[0].columns.some((c) => c.field === 'f2' && c.column === 1));
  deleteFillBinding(p, 0, 'f2');
  assert.ok(!fillConfig(p).submits[0].columns.some((c) => c.field === 'f2'));
  fs.rmSync(d, { recursive: true, force: true });
});
