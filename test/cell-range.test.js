// test/cell-range.test.js —— 批量列区间操作（delete_cell_range / shift_cell_range）
//
// 背景：用户报告「重建单元格列位错位」（如 c7 已是 combination，重建 c8 又写了 combination，
// 造成右侧整段列后移一位）时，此前只能逐格 delete+add，约 40 次操作、token 花费巨大。
// 本测试锁定区间级批量工具的语义：
//   delete_cell_range：整列删除 + 右列整体左移补位（Excel 删除整列），同步改写填报绑定；
//                      全宽标题横幅（cs 覆盖整表）自动缩窄。
//   shift_cell_range： 整段列平移 delta 列归位，同步改写填报绑定与扩展父格引用；
//                      insert=true 插入式挪移（Excel「插入剪切的单元格」）：目的列被占用时
//                      让位列自动轮转换位，不再需要「腾暂存列 → 搬块 → 回填」绕行。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCpt, addCell, addFillSubmit, addStyle } from '../lib/generate.js';
import { deleteCellRange, shiftCellRange, addFillBinding } from '../lib/edits.js';
import { validateCpt } from '../lib/validate.js';
import '../scripts/isolate-store.mjs'; // M123：JS 基线 store 隔离，直跑也不污染真实 store

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-range-'));
const readSheet = (p, sheet = 0) => {
  const raw = fs.readFileSync(p, 'utf8');
  const starts = [...raw.matchAll(/<Report class="[^"]*WorkSheet"[^>]*>|<Report class="com\.fr\.report\.poly\.PolyWorkSheet"[^>]*>/g)];
  const s = starts[sheet]?.index ?? raw.indexOf('<Report ');
  const ss = raw.lastIndexOf('<Report ', s);
  const e = raw.indexOf('</Report>', s);
  return { raw, sheetSeg: raw.slice(ss < 0 ? 0 : ss, e < 0 ? raw.length : e) };
};
const cells = (seg) => [...seg.matchAll(/<C c="([0-9]+)" r="([0-9]+)"[^>]*>/g)].map((m) => `${m[1]},${m[2]}`);
const binds = (raw) => [...raw.matchAll(/<ColumnConfig name="([^"]+)"[^>]*>[\s\S]*?<ColumnRow column="([0-9]+)" row="([0-9]+)"/g)]
  .map((m) => `${m[1]}@${m[2]},${m[3]}`);
const errCount = (p) => (validateCpt(p)).filter((x) => x.severity === 'error').length;

function buildGrid(p, cols) {
  createCpt(p, { rows: 2, columns: cols });
  // 夹具用 styleIndex:1，必须先真的建出样式 1 —— 否则表格每格都报"样式索引越界"。
  // （此前 errCount 写成 validateCpt(p).issues ?? [] 恒为 0，把这个问题盖住了。）
  addStyle(p, { fontSizePt: 12 });
  for (let c = 0; c < cols; c++) addCell(p, { column: c, row: 0, content: `H${c}`, styleIndex: 1 });
}

test('delete_cell_range：整列删除 + 右列左移，填报绑定同步跟随', () => {
  const d = tmp();
  const p = path.join(d, 'a.cpt');
  buildGrid(p, 6); // c0..c5
  addFillSubmit(p, { name: 's1', table: 't_test' });
  addFillBinding(p, 0, 'f1', 1, 0);
  addFillBinding(p, 0, 'f2', 3, 0);
  const r = deleteCellRange(p, { sheet: 0, fromColumn: 2, toColumn: 2 });
  assert.equal(r.deletedCells, 1);
  assert.equal(r.reboundCount, 1, 'c3 右边且被引用，绑定应左移');
  const { sheetSeg } = readSheet(p);
  assert.deepEqual(cells(sheetSeg), ['0,0', '1,0', '2,0', '3,0', '4,0'], '旧 c3..c5 左移到 c2..c4，不再有 c5');
  assert.deepEqual(binds(fs.readFileSync(p, 'utf8')).sort(), ['f1@1,0', 'f2@2,0'], 'f2(3,0)→(2,0)');
  assert.equal(errCount(p), 0);
  fs.rmSync(d, { recursive: true, force: true });
});

test('delete_cell_range：全宽标题横幅自动缩窄 cs', () => {
  const d = tmp();
  const p = path.join(d, 'a.cpt');
  buildGrid(p, 5);
  // 制造全宽横幅：把 (0,0) 改成覆盖整表的合并区（模拟官方标题行）
  const raw = fs.readFileSync(p, 'utf8');
  const r0 = raw.indexOf('<C c="0" r="0"');
  const gt = raw.indexOf('>', r0);
  const newRaw = raw.slice(0, gt) + ' cs="5"' + raw.slice(gt);
  fs.writeFileSync(p, newRaw, 'utf8');
  const r = deleteCellRange(p, { sheet: 0, fromColumn: 2, toColumn: 2 });
  assert.ok(r.deletedCells >= 1);
  const { raw: after } = readSheet(p);
  const banner = after.match(/<C c="0" r="0"[^>]*\bcs="([0-9]+)"/);
  assert.ok(banner, '标题横幅仍在');
  assert.equal(Number(banner[1]), 4, 'cs 从 5 缩窄到 4（删了 1 列）');
  assert.equal(errCount(p), 0);
  fs.rmSync(d, { recursive: true, force: true });
});

test('delete_cell_range：shiftLeft=false 只删不挪', () => {
  const d = tmp();
  const p = path.join(d, 'a.cpt');
  buildGrid(p, 5);
  deleteCellRange(p, { sheet: 0, fromColumn: 2, toColumn: 2, shiftLeft: false });
  const { sheetSeg } = readSheet(p);
  assert.deepEqual(cells(sheetSeg), ['0,0', '1,0', '3,0', '4,0'], 'c2 被删，其余原位不动');
  fs.rmSync(d, { recursive: true, force: true });
});

test('delete_cell_range：合并区锚点在待删带内部时拒绝', () => {
  const d = tmp();
  const p = path.join(d, 'a.cpt');
  buildGrid(p, 5);
  const raw = fs.readFileSync(p, 'utf8');
  const r2 = raw.indexOf('<C c="1" r="0"');
  const gt = raw.indexOf('>', r2);
  fs.writeFileSync(p, raw.slice(0, gt) + ' cs="3"' + raw.slice(gt), 'utf8'); // (1,0) 起跨 3 列，锚点在带 [1..1] 内
  assert.throws(() => deleteCellRange(p, { sheet: 0, fromColumn: 1, toColumn: 1 }),
    /合并区.*相交|锚点位于待删带内|跨列合并/);
  fs.rmSync(d, { recursive: true, force: true });
});

test('shift_cell_range：整段列左移归位 + 绑定/引用改写', () => {
  const d = tmp();
  const p = path.join(d, 'a.cpt');
  buildGrid(p, 8); // c0..c7
  addFillSubmit(p, { name: 's1', table: 't_test' });
  addFillBinding(p, 0, 'f1', 5, 0);
  addFillBinding(p, 0, 'f2', 7, 0);
  // 把 c4..c7 左移 1 列：目标 c3..c6 必须为空 —— 先把 c3 挪走腾位（c3 -> c8 空列）
  shiftCellRange(p, { sheet: 0, fromColumn: 3, toColumn: 3, delta: 5 }); // c3->c8
  const r = shiftCellRange(p, { sheet: 0, fromColumn: 4, toColumn: 7, delta: -1 }); // c4..c7 -> c3..c6
  assert.equal(r.movedCells, 4);
  const { raw, sheetSeg } = readSheet(p);
  const c = cells(sheetSeg);
  assert.ok(c.includes('3,0') && c.includes('6,0'), '旧 c4..c7 现居 c3..c6');
  assert.ok(!c.includes('7,0'), 'c7 已让位');
  assert.ok(binds(raw).includes('f1@4,0') && binds(raw).includes('f2@6,0'), '绑定随列左移');
  const hdr = (col) => {
    const m = raw.match(new RegExp(`<C c="${col}" r="0"[^>]*>[\\s\\S]{0,200}`));
    const o = m && m[0].match(/<!\[CDATA\[([^\]]{0,20})/);
    return o ? o[1] : '';
  };
  assert.equal(hdr(3), 'H4', 'c3 内容 = 旧 H4');
  assert.equal(hdr(6), 'H7', 'c6 内容 = 旧 H7');
  assert.equal(errCount(p), 0);
  fs.rmSync(d, { recursive: true, force: true });
});

test('shift_cell_range：目标列有非移动单元格时报错', () => {
  const d = tmp();
  const p = path.join(d, 'a.cpt');
  buildGrid(p, 5);
  assert.throws(() => shiftCellRange(p, { sheet: 0, fromColumn: 0, toColumn: 1, delta: 1 }), /已有单元格|撞上|冲突/);
  fs.rmSync(d, { recursive: true, force: true });
});

test('shift_cell_range：delta=0 / 越界 / 区间无单元格 均报错', () => {
  const d = tmp();
  const p = path.join(d, 'a.cpt');
  buildGrid(p, 4);
  assert.throws(() => shiftCellRange(p, { sheet: 0, fromColumn: 1, toColumn: 2, delta: 0 }), /delta 非法/);
  assert.throws(() => shiftCellRange(p, { sheet: 0, fromColumn: 0, toColumn: 1, delta: -2 }), /越界/);
  assert.throws(() => shiftCellRange(p, { sheet: 0, fromColumn: 1, toColumn: 1, delta: 1, fromRow: 9, toRow: 9 }), /无单元格可移动/);
  assert.throws(() => deleteCellRange(p, { sheet: 0, fromColumn: 2, toColumn: 1 }), /列区间非法/);
  fs.rmSync(d, { recursive: true, force: true });
});

const hdr = (raw, col, row) => {
  const m = raw.match(new RegExp(`<C c="${col}" r="${row}"[^>]*>[\\s\\S]{0,200}`));
  const o = m && m[0].match(/<!\[CDATA\[([^\]]{0,20})/);
  return o ? o[1] : '';
};

test('shift_cell_range insert=true：目的列被占用时让位列轮转换位（右移），无需暂存列', () => {
  const d = tmp();
  const p = path.join(d, 'a.cpt');
  buildGrid(p, 8); // c0..c7 = H0..H7
  addFillSubmit(p, { name: 's1', table: 't_test' });
  addFillBinding(p, 0, 'f1', 2, 0);
  addFillBinding(p, 0, 'f2', 6, 0);
  // 块 c2..c3 右移 3（→ c5..c6），目的列 c5..c6 被 H5/H6 占着：
  // insert=true 让位带 c4..c6 整段轮转补到 c2..c4（H4,H5,H6 前移，H2,H3 后落）
  const r = shiftCellRange(p, { sheet: 0, fromColumn: 2, toColumn: 3, delta: 3, insert: true });
  assert.equal(r.insert, true);
  assert.equal(r.movedCells, 5, '轮转覆盖整个 span c2..c6（块 2 格 + 让位 3 格）');
  assert.deepEqual(r.gapColumns, [4, 6]);
  assert.deepEqual(r.spanColumns, [2, 6]);
  const { raw, sheetSeg } = readSheet(p);
  assert.deepEqual(cells(sheetSeg).sort(), ['0,0', '1,0', '2,0', '3,0', '4,0', '5,0', '6,0', '7,0']);
  assert.equal(hdr(raw, 1, 0), 'H1', 'span 外不动');
  assert.equal(hdr(raw, 2, 0), 'H4');
  assert.equal(hdr(raw, 3, 0), 'H5');
  assert.equal(hdr(raw, 4, 0), 'H6');
  assert.equal(hdr(raw, 5, 0), 'H2', '块 c2 落到 c5');
  assert.equal(hdr(raw, 6, 0), 'H3', '块 c3 落到 c6');
  assert.equal(hdr(raw, 7, 0), 'H7', 'span 外不动');
  assert.deepEqual(binds(raw).sort(), ['f1@5,0', 'f2@4,0'], '绑定随块/让位列各自换位');
  assert.equal(errCount(p), 0);
  fs.rmSync(d, { recursive: true, force: true });
});

test('shift_cell_range insert=true：左移轮转换位（让位列补到块右侧）', () => {
  const d = tmp();
  const p = path.join(d, 'a.cpt');
  buildGrid(p, 8);
  // 块 c5..c6 左移 3（→ c2..c3），让位带 c2..c4 轮转补到 c4..c6
  const r = shiftCellRange(p, { sheet: 0, fromColumn: 5, toColumn: 6, delta: -3, insert: true });
  assert.deepEqual(r.gapColumns, [2, 4]);
  const { raw } = readSheet(p);
  assert.equal(hdr(raw, 2, 0), 'H5');
  assert.equal(hdr(raw, 3, 0), 'H6');
  assert.equal(hdr(raw, 4, 0), 'H2');
  assert.equal(hdr(raw, 5, 0), 'H3');
  assert.equal(hdr(raw, 6, 0), 'H4');
  assert.equal(hdr(raw, 0, 0), 'H0');
  assert.equal(hdr(raw, 7, 0), 'H7');
  assert.equal(errCount(p), 0);
  fs.rmSync(d, { recursive: true, force: true });
});

test('shift_cell_range insert=true：让位带无单元格时与平移等价', () => {
  const d = tmp();
  const p = path.join(d, 'a.cpt');
  createCpt(p, { rows: 1, columns: 8 });
  addStyle(p, { fontSizePt: 12 });
  for (const c of [0, 1, 5, 6, 7]) addCell(p, { column: c, row: 0, content: `H${c}`, styleIndex: 1 }); // c2..c4 空
  const r = shiftCellRange(p, { sheet: 0, fromColumn: 0, toColumn: 1, delta: 3, insert: true });
  assert.equal(r.movedCells, 2, '让位带为空，只有块内 2 格参与');
  const { raw } = readSheet(p);
  assert.equal(hdr(raw, 3, 0), 'H0');
  assert.equal(hdr(raw, 4, 0), 'H1');
  assert.equal(hdr(raw, 0, 0), '', '源位已腾空');
  assert.equal(hdr(raw, 5, 0), 'H5');
  assert.equal(errCount(p), 0);
  fs.rmSync(d, { recursive: true, force: true });
});

test('shift_cell_range insert=true：跨轮转边界的合并区拒绝（会拆开合并）', () => {
  const d = tmp();
  const p = path.join(d, 'a.cpt');
  buildGrid(p, 8);
  // (3,0) cs=2 覆盖 c3..c4：c3 属块、c4 属让位带，轮转会把合并区拆开
  const raw0 = fs.readFileSync(p, 'utf8');
  const at = raw0.indexOf('<C c="3" r="0"');
  const gt = raw0.indexOf('>', at);
  fs.writeFileSync(p, raw0.slice(0, gt) + ' cs="2"' + raw0.slice(gt), 'utf8');
  assert.throws(() => shiftCellRange(p, { sheet: 0, fromColumn: 2, toColumn: 3, delta: 3, insert: true }),
    /轮转边界|拆开|解除合并/);
  fs.rmSync(d, { recursive: true, force: true });
});

test('shift_cell_range insert=true：行域过滤只轮转域内行，域外行不动', () => {
  const d = tmp();
  const p = path.join(d, 'a.cpt');
  createCpt(p, { rows: 2, columns: 8 });
  addStyle(p, { fontSizePt: 12 });
  for (let c = 0; c < 8; c++) {
    addCell(p, { column: c, row: 0, content: `H${c}`, styleIndex: 1 });
    addCell(p, { column: c, row: 1, content: `X${c}`, styleIndex: 1 });
  }
  shiftCellRange(p, { sheet: 0, fromColumn: 2, toColumn: 3, delta: 3, insert: true, fromRow: 0, toRow: 0 });
  const { raw } = readSheet(p);
  assert.equal(hdr(raw, 2, 0), 'H4', 'r0 参与轮转');
  assert.equal(hdr(raw, 5, 0), 'H2');
  assert.equal(hdr(raw, 2, 1), 'X2', 'r1 不在移动行域，原位不动');
  assert.equal(hdr(raw, 5, 1), 'X5');
  assert.equal(errCount(p), 0);
  fs.rmSync(d, { recursive: true, force: true });
});

test('shift_cell_range insert=true：rs 合并格目的位撞上域外单元格时报错并指路行域', () => {
  const d = tmp();
  const p = path.join(d, 'a.cpt');
  createCpt(p, { rows: 2, columns: 8 });
  addStyle(p, { fontSizePt: 12 });
  for (let c = 0; c < 8; c++) addCell(p, { column: c, row: 0, content: `H${c}`, styleIndex: 1 });
  addCell(p, { column: 5, row: 1, content: 'X5', styleIndex: 1 });
  // (2,0) rs=2 覆盖 (2,0)-(2,1)，其目的位 (5,0)-(5,1) 与域外格 (5,1) 重叠
  const raw0 = fs.readFileSync(p, 'utf8');
  const at = raw0.indexOf('<C c="2" r="0"');
  const gt = raw0.indexOf('>', at);
  fs.writeFileSync(p, raw0.slice(0, gt) + ' rs="2"' + raw0.slice(gt), 'utf8');
  assert.throws(() => shiftCellRange(p, { sheet: 0, fromColumn: 2, toColumn: 3, delta: 3, insert: true, fromRow: 0, toRow: 0 }),
    /未参与轮转|重叠/);
  // 把 (5,1) 也纳入移动行域即可轮转（无悬空）
  const r = shiftCellRange(p, { sheet: 0, fromColumn: 2, toColumn: 3, delta: 3, insert: true, fromRow: 0, toRow: 1 });
  assert.equal(r.movedCells, 6, 'r0 span c2..c6 五格 + 让位带格 (5,1)');
  const { raw } = readSheet(p);
  assert.equal(hdr(raw, 5, 0), 'H2', 'rs=2 格随块落到 (5,0)，覆盖 (5,0)-(5,1)');
  assert.equal(hdr(raw, 5, 1), '', '(5,1) 已被 rs=2 目的位覆盖，无独立格');
  assert.equal(hdr(raw, 3, 1), 'X5', '(5,1) 随让位带轮转补到 (3,1)');
  assert.equal(hdr(raw, 2, 0), 'H4', '让位带 (4,0) 补到 (2,0)');
  fs.rmSync(d, { recursive: true, force: true });
});

test('shift_cell_range：列号进位变长时整体改写不串格（右移进位回归）', () => {
  const d = tmp();
  const p = path.join(d, 'a.cpt');
  createCpt(p, { rows: 40, columns: 14 });
  addStyle(p, { fontSizePt: 12 });
  for (let r = 0; r < 40; r++) for (let c = 0; c < 12; c++) addCell(p, { column: c, row: r, content: `${c}x${r}`, styleIndex: 1 }); // c12..c13 留空作目的位
  // c8..c9 右移 4（→ c12..c13）："8"->"12"、"9"->"13" 均进位变长，40 行 × 2 列 = 80 次变长改写。
  // 旧实现 d>0 按文档正序改写，进位累积漂移会让后续标签索引失真（约 8 次后定位失败/改错格）。
  const r = shiftCellRange(p, { sheet: 0, fromColumn: 8, toColumn: 9, delta: 4 });
  assert.equal(r.movedCells, 80);
  const { raw, sheetSeg } = readSheet(p);
  assert.equal(cells(sheetSeg).length, 12 * 40, '坐标唯一且一格不少');
  for (let row = 0; row < 40; row++) {
    assert.equal(hdr(raw, 12, row), `8x${row}`, `(12,${row}) = 旧 c8`);
    assert.equal(hdr(raw, 13, row), `9x${row}`, `(13,${row}) = 旧 c9`);
    assert.equal(hdr(raw, 10, row), `10x${row}`, `(10,${row}) 不动`);
    assert.equal(hdr(raw, 11, row), `11x${row}`, `(11,${row}) 不动`);
    assert.equal(hdr(raw, 7, row), `7x${row}`, `(7,${row}) 不动`);
  }
  assert.equal(errCount(p), 0);
  fs.rmSync(d, { recursive: true, force: true });
});