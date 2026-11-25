// cpt-mcp/test/cell-span.test.js —— M111 单元格跨行跨列（合并/拆分）就地编辑
//
// 背景：官方 1550 份实测 7142 个跨行跨列格（cs 6702 / rs 1576 / cs+rs 1136），而 cpt-mcp 此前只能在
// add_cell 时给【新格】设 colspan/rowspan —— 已有格改跨列（如"字典 sheet 标题没跨列"）只能
// delete_cell + add_cell 重建，会丢监听器/条件属性/扩展父格引用。本测试锁定就地改 cs/rs 的行为。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCpt, addCell, addSheet } from '../lib/generate.js';
import { setCellSpan } from '../lib/edits.js';
import { validateCpt } from '../lib/validate.js';
import '../scripts/isolate-store.mjs'; // M123：JS 基线 store 隔离，直跑也不污染真实 store

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-span-'));
const errCount = (p) => validateCpt(p).filter((x) => x.severity === 'error').length;
const headOf = (p, c, r) => {
  const raw = fs.readFileSync(p, 'utf8');
  const m = new RegExp(`<C c="${c}" r="${r}"[^>]*>`).exec(raw);
  return m ? m[0] : null;
};

test('M111 set_cell_span：标题格跨列（cs 就地插入，其余字节保留）', () => {
  const d = tmp();
  const p = path.join(d, 'title.cpt');
  createCpt(p, { rows: 3, columns: 6 });
  addCell(p, { column: 0, row: 0, content: '字典·项目配置（供JS查表）', styleIndex: 0 });
  addCell(p, { column: 0, row: 1, content: '工作项目' });
  // 同排另一块的标题（c6 起，块之间不重叠）
  addCell(p, { column: 5, row: 0, content: '字典·快照参考' });
  const r = setCellSpan(p, { column: 0, row: 0, sheet: 0, colspan: 5 });
  assert.equal(r.mode, 'update');
  assert.deepEqual(r.before, { colspan: 1, rowspan: 1 });
  assert.deepEqual(r.after, { colspan: 5, rowspan: 1 });
  assert.equal(headOf(p, 0, 0), '<C c="0" r="0" s="0" cs="5">', 'cs 应插在属性末尾（官方顺序）');
  assert.equal(headOf(p, 5, 0), '<C c="5" r="0" s="0">', '相邻格不受影响');
  assert.equal(errCount(p), 0);
  // 幂等
  assert.equal(setCellSpan(p, { column: 0, row: 0, sheet: 0, colspan: 5 }).mode, 'none');
  // 取消跨列 → 属性被删除
  const back = setCellSpan(p, { column: 0, row: 0, sheet: 0, colspan: null });
  assert.equal(back.after.colspan, 1);
  assert.equal(headOf(p, 0, 0), '<C c="0" r="0" s="0">');
  assert.equal(errCount(p), 0);
  fs.rmSync(d, { recursive: true, force: true });
});

test('M111 set_cell_span：cs+rs 同写（官方 cs 先 rs 后）与只传一个保持另一个', () => {
  const d = tmp();
  const p = path.join(d, 'both.cpt');
  createCpt(p, { rows: 4, columns: 4 });
  addCell(p, { column: 0, row: 0, content: 'x' });
  setCellSpan(p, { column: 0, row: 0, sheet: 0, colspan: 4, rowspan: 2 });
  assert.equal(headOf(p, 0, 0), '<C c="0" r="0" s="0" cs="4" rs="2">', 'cs 应在 rs 之前（官方 Demo.cpt 形态）');
  // 只改 rowspan：colspan 保持 4
  setCellSpan(p, { column: 0, row: 0, sheet: 0, rowspan: 3 });
  assert.equal(headOf(p, 0, 0), '<C c="0" r="0" s="0" cs="4" rs="3">');
  assert.equal(errCount(p), 0);
  fs.rmSync(d, { recursive: true, force: true });
});

test('M111 set_cell_span：覆盖到已有格必须拒绝并列出坐标（不制造重叠合并）', () => {
  const d = tmp();
  const p = path.join(d, 'conflict.cpt');
  createCpt(p, { rows: 2, columns: 4 });
  addCell(p, { column: 0, row: 0, content: 'A' });
  addCell(p, { column: 1, row: 0, content: 'B' });
  addCell(p, { column: 3, row: 0, content: 'D' });
  assert.throws(() => setCellSpan(p, { column: 0, row: 0, sheet: 0, colspan: 3 }), /覆盖 1 个已有单元格.*\(1,0\)/);
  // 覆盖区外（cs=1 只覆盖自身）不报错
  assert.equal(setCellSpan(p, { column: 0, row: 0, sheet: 0, colspan: 1 }).after.colspan, 1);
  // 只能覆盖到空地：cs=2 → (1,0) 冲突；先把 c1 删掉
  fs.rmSync(d, { recursive: true, force: true });
});

test('M111 set_cell_span：参数与坐标围栏', () => {
  const d = tmp();
  const p = path.join(d, 'guard.cpt');
  createCpt(p, { rows: 3, columns: 3 });
  addCell(p, { column: 0, row: 0, content: 'x' });
  assert.throws(() => setCellSpan(p, { column: 0, row: 0, sheet: 0 }), /至少传 colspan 或 rowspan/);
  assert.throws(() => setCellSpan(p, { column: 0, row: 0, sheet: 0, colspan: 0 }), /1-1000/);
  assert.throws(() => setCellSpan(p, { column: 0, row: 0, sheet: 0, colspan: 1.5 }), /1-1000/);
  assert.throws(() => setCellSpan(p, { column: 9, row: 9, sheet: 0, colspan: 2 }), /未找到/);
  assert.throws(() => setCellSpan(p, { column: -1, row: 0, sheet: 0, colspan: 2 }), /坐标非法/);
  fs.rmSync(d, { recursive: true, force: true });
});

test('M111 set_cell_span：多工作表未传 sheet 直接拒绝（防改错表）', () => {
  const d = tmp();
  const p = path.join(d, 'multi.cpt');
  createCpt(p, { rows: 3, columns: 3 });
  addSheet(p, { sheetName: 's2' });
  addCell(p, { column: 0, row: 0, content: 'x', sheet: 0 });
  addCell(p, { column: 0, row: 0, content: 'y', sheet: 1 });
  assert.throws(() => setCellSpan(p, { column: 0, row: 0, colspan: 2 }), /必须显式提供 sheet/);
  // 传表名即可
  const r = setCellSpan(p, { column: 0, row: 0, colspan: 2, sheet: 's2' });
  assert.equal(r.after.colspan, 2);
  assert.equal(errCount(p), 0);
  fs.rmSync(d, { recursive: true, force: true });
});
