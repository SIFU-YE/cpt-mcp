// cpt-mcp/test/cell-row-range.test.js —— M112 delete_row_range：删整行 + 下方行上移
//
// 背景：行轴此前完全没有通道 —— 删一行只能对该行每个列逐个 delete_cell，行整体上移更是做不到
// （全仓库没有任何改写 r 坐标的代码）。列版 delete_cell_range 只吃列区间。本测试锁定行版语义：
// r 坐标 / rs 跨行合并 / 填报绑定 row / 扩展父格 up·left 引用 / RowHeight 数组 五处同步。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCpt, addCell, addSheet, addFillSubmit } from '../lib/generate.js';
import { deleteRowRange, insertRowRange, addFillBinding } from '../lib/edits.js';
import { validateCpt } from '../lib/validate.js';
import '../scripts/isolate-store.mjs'; // M123：JS 基线 store 隔离，直跑也不污染真实 store

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-rowrange-'));
const errCount = (p) => validateCpt(p).filter((x) => x.severity === 'error').length;
/** 取某个 sheet 内所有 <C> 的 "c,r"（按文件顺序） */
const coords = (p, sheetName = null) => {
  const raw = fs.readFileSync(p, 'utf8');
  let seg = raw;
  if (sheetName != null) {
    const ms = [...raw.matchAll(/<Report class="[^"]*" name="([^"]*)"/g)];
    const i = ms.findIndex((m) => m[1] === sheetName);
    seg = raw.slice(ms[i].index, i + 1 < ms.length ? ms[i + 1].index : raw.length);
  }
  return [...seg.matchAll(/<C c="(\d+)" r="(\d+)"/g)].map((m) => `${m[1]},${m[2]}`);
};
const rowHeights = (p) => {
  const cd = /<RowHeight[^>]*>\s*<!\[CDATA\[([\s\S]*?)\]\]><\/RowHeight>/.exec(fs.readFileSync(p, 'utf8'));
  return cd ? cd[1].split(',').map((s) => s.trim()).filter(Boolean) : null;
};
const head = (p, c, r) => {
  const m = new RegExp(`<C c="${c}" r="${r}"[^>]*>`).exec(fs.readFileSync(p, 'utf8'));
  return m ? m[0] : null;
};

test('M112 delete_row_range：删整行 + 下方行上移（r 与 RowHeight 同步）', () => {
  const d = tmp();
  const p = path.join(d, 'a.cpt');
  createCpt(p, { rows: 4, columns: 3 });
  for (let r = 0; r < 4; r++) for (let c = 0; c < 3; c++) addCell(p, { column: c, row: r, content: `${c}${r}` });
  const before = rowHeights(p).length;
  const res = deleteRowRange(p, { sheet: 0, fromRow: 1, toRow: 1 });
  assert.equal(res.deletedCells, 3);
  assert.equal(res.shiftUp, true);
  assert.deepEqual(coords(p).sort(), ['0,0', '0,1', '0,2', '1,0', '1,1', '1,2', '2,0', '2,1', '2,2'].sort(), '旧第 2/3 行上移到第 1/2 行');
  assert.equal(rowHeights(p).length, before - 1, 'RowHeight 条目同步减少');
  assert.equal(errCount(p), 0);
  fs.rmSync(d, { recursive: true, force: true });
});

test('M112 delete_row_range：shiftUp=false 只删不挪', () => {
  const d = tmp();
  const p = path.join(d, 'b.cpt');
  createCpt(p, { rows: 4, columns: 2 });
  for (let r = 0; r < 4; r++) for (let c = 0; c < 2; c++) addCell(p, { column: c, row: r, content: `${c}${r}` });
  deleteRowRange(p, { sheet: 0, fromRow: 1, toRow: 1, shiftUp: false });
  assert.deepEqual(coords(p).sort(), ['0,0', '0,2', '0,3', '1,0', '1,2', '1,3'].sort(), '不挪动：2/3 行留在原位');
  assert.equal(errCount(p), 0);
  fs.rmSync(d, { recursive: true, force: true });
});

test('M112 delete_row_range：跨行合并锚点在带上方且完整覆盖 → 自动缩窄 rs', () => {
  const d = tmp();
  const p = path.join(d, 'merge.cpt');
  createCpt(p, { rows: 5, columns: 3 });
  addCell(p, { column: 0, row: 0, content: 'M', rowspan: 3 });        // 覆盖行 0..2
  addCell(p, { column: 1, row: 3, content: 'x' });
  addCell(p, { column: 1, row: 4, content: 'y' });
  const res = deleteRowRange(p, { sheet: 0, fromRow: 2, toRow: 2 });
  assert.equal(res.deletedCells, 0, '行 2 无独立格（已被合并区覆盖），操作仍成立');
  assert.equal(head(p, 0, 0), '<C c="0" r="0" s="0" rs="2">', 'rs 3→2（合并区自动缩窄）');
  assert.equal(errCount(p), 0);
  fs.rmSync(d, { recursive: true, force: true });
});

test('M112 delete_row_range：跨行合并锚点落在待删带内 → 拒绝', () => {
  const d = tmp();
  const p = path.join(d, 'bad-merge.cpt');
  createCpt(p, { rows: 5, columns: 3 });
  addCell(p, { column: 0, row: 2, content: 'M', rowspan: 2 });        // 覆盖行 2..3，锚点在带内
  addCell(p, { column: 1, row: 2, content: 'x' });
  assert.throws(() => deleteRowRange(p, { sheet: 0, fromRow: 2, toRow: 2 }), /跨行合并区.*锚点不在带上方完整覆盖/s);
  fs.rmSync(d, { recursive: true, force: true });
});

test('M112 delete_row_range：扩展父格引用指向带内 → 拒绝；指向带下方 → 同步上移', () => {
  const d = tmp();
  const p = path.join(d, 'ref.cpt');
  createCpt(p, { rows: 6, columns: 3 });
  addCell(p, { column: 0, row: 1, content: 'r1' });
  // 引用方在带【外】(row 4)，引用目标在带内 (A4 → 行 3)：删行 3 会让它悬空 → 必须拒绝
  addCell(p, { column: 1, row: 4, content: 'r4', expand: { dir: 0, upParent: 'A4' } });
  // 删行 3（带内被引用）→ 拒绝
  assert.throws(() => deleteRowRange(p, { sheet: 0, fromRow: 3, toRow: 3 }), /扩展父格 up="A4".*悬空/s);
  // 改指带下方：删行 1，up 指向行 3 > to=1 → 应上移为 A3（0 基 2）
  const res = deleteRowRange(p, { sheet: 0, fromRow: 1, toRow: 1 });
  assert.equal(res.refRewritten, 1);
  assert.match(fs.readFileSync(p, 'utf8'), /up="A3"/, 'up 引用行号同步上移');
  assert.equal(errCount(p), 0);
  fs.rmSync(d, { recursive: true, force: true });
});

test('M112 delete_row_range：填报绑定 row 在带内 → 拒绝；在带下方 → 同步上移', () => {
  const d = tmp();
  const p = path.join(d, 'bind.cpt');
  createCpt(p, { rows: 5, columns: 3, webWrite: true });
  addFillSubmit(p, { name: 's1', table: 't_test' });
  addFillBinding(p, 0, 'f1', 0, 3);                                    // 绑定 row=3
  addCell(p, { column: 0, row: 0, content: 'h' });
  addCell(p, { column: 0, row: 1, content: 'a' });
  addCell(p, { column: 0, row: 2, content: 'b' });
  addCell(p, { column: 0, row: 3, content: 'c' });
  assert.throws(() => deleteRowRange(p, { sheet: 0, fromRow: 3, toRow: 3 }), /填报绑定 row="3".*悬空/s);
  const res = deleteRowRange(p, { sheet: 0, fromRow: 1, toRow: 1 });
  assert.equal(res.reboundCount, 1);
  assert.match(fs.readFileSync(p, 'utf8'), /<ColumnRow column="0" row="2"/, '绑定 row 3→2');
  assert.equal(errCount(p), 0);
  fs.rmSync(d, { recursive: true, force: true });
});

test('M112 delete_row_range：参数围栏 + 空带 + 多表 sheet', () => {
  const d = tmp();
  const p = path.join(d, 'guard.cpt');
  createCpt(p, { rows: 3, columns: 2 });
  addCell(p, { column: 0, row: 0, content: 'x' });
  assert.throws(() => deleteRowRange(p, { sheet: 0, fromRow: 2, toRow: 1 }), /行区间非法/);
  assert.throws(() => deleteRowRange(p, { sheet: 0, fromRow: -1, toRow: 1 }), /行区间非法/);
  assert.throws(() => deleteRowRange(p, { sheet: 0, fromRow: 2, toRow: 2, shiftUp: false }), /不会产生任何变化/);
  // 多表：只动指定表
  addSheet(p, { sheetName: 'sheet2', rows: 3, columns: 2 });
  addCell(p, { column: 0, row: 0, content: 's2r0', sheet: 'sheet2' });
  addCell(p, { column: 0, row: 1, content: 's2r1', sheet: 'sheet2' });
  deleteRowRange(p, { sheet: 'sheet2', fromRow: 0, toRow: 0 });
  assert.deepEqual(coords(p, 'sheet2'), ['0,0'], 'sheet2 内 1 行上移归位');
  assert.deepEqual(coords(p, 'sheet1'), ['0,0'], 'sheet1 不受影响');
  assert.equal(errCount(p), 0);
  fs.rmSync(d, { recursive: true, force: true });
});

test('M112 delete_row_range：引用方自身在待删行内不算悬空（真实填报行 left="A3" 形态）', () => {
  // 真实模板里同一数据行的格普遍写成 left="A3"（指向自己这一行）；若不排除"引用方在带内"，
  // 删该行会被它自己的引用挡住 —— 现场四表文件删 字典 sheet r2 时正是这样被误拦。
  const d = tmp();
  const p = path.join(d, 'self-ref.cpt');
  createCpt(p, { rows: 4, columns: 3 });
  addCell(p, { column: 0, row: 2, content: 'A3' });
  addCell(p, { column: 1, row: 2, content: 'b', expand: { dir: 0, leftParent: 'A3' } });
  addCell(p, { column: 2, row: 2, content: 'c', expand: { dir: 0, leftParent: 'A3' } });
  addCell(p, { column: 0, row: 3, content: 'A4' });
  const res = deleteRowRange(p, { sheet: 0, fromRow: 2, toRow: 2 });
  assert.equal(res.deletedCells, 3, '整行 3 格都能删掉（不被自身 left 引用挡住）');
  assert.deepEqual(coords(p), ['0,2'], 'row3 的唯一格上移到 row2（createCpt 只造空骨架，无其它内容格）');
  assert.equal(errCount(p), 0);
  fs.rmSync(d, { recursive: true, force: true });
});

test('insert_row_range：atRow 前插入整行，下方 r 与 RowHeight 同步下移', () => {
  const d = tmp();
  const p = path.join(d, 'ins.cpt');
  createCpt(p, { rows: 3, columns: 2 });
  for (let r = 0; r < 3; r++) for (let c = 0; c < 2; c++) addCell(p, { column: c, row: r, content: `${c}${r}` });
  const before = rowHeights(p).length;
  const res = insertRowRange(p, { sheet: 0, atRow: 1, count: 1 });
  assert.equal(res.shiftedCells, 4, '行 1、2 的 4 个单元格下移');
  assert.deepEqual(coords(p).sort(), ['0,0', '1,0', '0,2', '1,2', '0,3', '1,3'].sort(), '行 1/2 → 2/3');
  assert.equal(rowHeights(p).length, before + 1, 'RowHeight 插入 1 项');
  assert.equal(errCount(p), 0);
  fs.rmSync(d, { recursive: true, force: true });
});

test('insert_row_range：插入点落在跨行合并区内部 → 锚点自动扩高 rs', () => {
  const d = tmp();
  const p = path.join(d, 'ins-merge.cpt');
  createCpt(p, { rows: 4, columns: 2 });
  addCell(p, { column: 0, row: 0, content: 'M', rowspan: 2 }); // 覆盖行 0..1
  addCell(p, { column: 1, row: 2, content: 'x' });
  const res = insertRowRange(p, { sheet: 0, atRow: 1, count: 1 });
  assert.equal(res.expandedMerges, 1);
  assert.match(head(p, 0, 0), /rs="3"/, 'rs 2→3（新行并入合并区）');
  assert.equal(errCount(p), 0);
  fs.rmSync(d, { recursive: true, force: true });
});

test('insert_row_range：填报绑定 row 与扩展父格 up 引用同步下移', () => {
  const d = tmp();
  const p = path.join(d, 'ins-bind.cpt');
  createCpt(p, { rows: 5, columns: 3, webWrite: true });
  addFillSubmit(p, { name: 's1', table: 't_test' });
  addFillBinding(p, 0, 'f1', 0, 2); // 绑定 row=2
  addCell(p, { column: 0, row: 2, content: 'a', expand: { dir: 0, upParent: 'A3' } }); // A3 = 行 2
  const res = insertRowRange(p, { sheet: 0, atRow: 2, count: 1 });
  assert.equal(res.reboundCount, 1);
  assert.match(fs.readFileSync(p, 'utf8'), /<ColumnRow column="0" row="3"/, '绑定 row 2→3');
  assert.equal(res.refRewritten, 1);
  assert.match(fs.readFileSync(p, 'utf8'), /up="A4"/, '父格引用 A3→A4');
  assert.equal(errCount(p), 0);
  fs.rmSync(d, { recursive: true, force: true });
});

test('insert_row_range：参数围栏 + rowHeightMm 指定新行行高', () => {
  const d = tmp();
  const p = path.join(d, 'ins-guard.cpt');
  createCpt(p, { rows: 3, columns: 2 });
  addCell(p, { column: 0, row: 0, content: 'x' });
  assert.throws(() => insertRowRange(p, { sheet: 0, atRow: -1 }), /atRow 非法/);
  assert.throws(() => insertRowRange(p, { sheet: 0, atRow: 0, count: 0 }), /count 非法/);
  assert.throws(() => insertRowRange(p, { sheet: 0, atRow: 0, rowHeightMm: -1 }), /rowHeightMm 非法/);
  const before = rowHeights(p);
  insertRowRange(p, { sheet: 0, atRow: 0, count: 1, rowHeightMm: 12 });
  const after = rowHeights(p);
  assert.equal(after.length, before.length + 1);
  assert.equal(errCount(p), 0);
  fs.rmSync(d, { recursive: true, force: true });
});
