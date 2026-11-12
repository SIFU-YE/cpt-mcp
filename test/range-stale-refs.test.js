// test/range-stale-refs.test.js —— 列/行区间挪移后的“陈旧 A1 引用”体检（sandbox19/v1 缺口回归）
//
// 背景（2026-10-31 追溯 sandbox19/v1）：
//   shift_cell_range / delete_cell_range 只同步改写 <C c/r>、填报绑定 ColumnRow 与扩展父格
//   left/up 引用，**公式与提交条件里的 A1 文本不会自动改**。会话里因此连续踩了两次静默失败：
//     · 插入序号列后隐藏公式还写 S5（实际数据已挪到 T 列）→ id/create_by 取错值；
//     · 提交条件还写 Y5=1（改动标记已挪到 Z 列）→ 一行都不过滤，点提交"刷新后没数据"。
//   工具文档只留一句“请一并确认”，模型只能 grep 全文 CDATA 自己找。
// 本文件锁定：挪移/删除后返回 staleRefs（含建议新坐标）+ hint 给出修法；只体检不改字节。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createCpt, addCell, addFillSubmit } from '../lib/generate.js';
import { shiftCellRange, deleteCellRange, deleteRowRange } from '../lib/edits.js';
import '../scripts/isolate-store.mjs';

delete process.env.CPT_MCP_ALLOWED_ROOTS;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-mcp-stale-refs-'));
const file = (n) => path.join(TMP, n);
const read = (p) => fs.readFileSync(p, 'utf8');

test('shift_cell_range：公式/提交条件里的旧列引用进 staleRefs（含建议坐标），字节不动', () => {
  const p = file('shift-stale.cpt');
  createCpt(p, { rows: 8, columns: 6, webWrite: true });
  // A1 公式引用 B2 两次（去重后该位置只报一条）；另有一个引用 E2（不在移动域，不该报）
  addCell(p, { column: 0, row: 0, content: '=IF(LEN(B2)=0,UUID(32),B2)+SUM(E2)', contentType: 'formula' });
  addCell(p, { column: 1, row: 1, content: 'B' });
  addCell(p, { column: 4, row: 1, content: 'E' });
  addFillSubmit(p, {
    dsName: 'Doris', table: 't', name: '提交',
    bindings: [{ field: 'a', column: 0, row: 0 }],
    condition: 'B2=1',
  });
  const before = read(p);
  const r = shiftCellRange(p, { sheet: 0, fromColumn: 1, toColumn: 1, delta: 1 });
  assert.ok(Array.isArray(r.staleRefs) && r.staleRefs.length > 0, '应返回 staleRefs');
  const refs = r.staleRefs.map((x) => `${x.where}|${x.ref}|${x.issue}|${x.suggest ?? ''}`);
  assert.ok(refs.some((x) => x.includes('单元格 A1 公式|B2|needs-shift|C2')), `公式 B2→C2 应被体检出来：${JSON.stringify(r.staleRefs)}`);
  assert.ok(refs.some((x) => x.includes('提交#0 条件|B2|needs-shift|C2')), `提交条件 B2→C2 应被体检出来：${JSON.stringify(r.staleRefs)}`);
  assert.ok(!refs.some((x) => x.includes('E2')), `移动域之外的 E2 不应误报：${JSON.stringify(r.staleRefs)}`);
  assert.equal(refs.filter((x) => x.startsWith('单元格 A1 公式|B2')).length, 1, '同一位置同一引用应去重');
  assert.ok(r.hint.includes('update_cell') && r.hint.includes('update_fill_submit'), `hint 应给出修法：${r.hint}`);
  // 只体检不改字节：公式与条件文本原样保留（由调用方用 update_cell/update_fill_submit 显式修）
  const after = read(p);
  assert.ok(after.includes('LEN(B2)') && after.includes('CDATA[B2=1]'), '公式/条件文本不得被静默改写');
  assert.notEqual(before, after, '单元格坐标/绑定仍应被挪移（只是公式/条件文本不动）');
});

test('shift_cell_range insert=true：轮转让位列的引用也给出映射建议', () => {
  const p = file('shift-insert.cpt');
  createCpt(p, { rows: 6, columns: 6, webWrite: true });
  addCell(p, { column: 0, row: 0, content: '=B2+C2', contentType: 'formula' });
  addCell(p, { column: 1, row: 1, content: 'b' });
  addCell(p, { column: 2, row: 1, content: 'c' });
  const r = shiftCellRange(p, { sheet: 0, fromColumn: 1, toColumn: 1, delta: 1, insert: true });
  const refs = (r.staleRefs ?? []).map((x) => `${x.ref}->${x.suggest}`);
  // 插入式轮转：B(源块) → C；C(让位列) → B
  assert.ok(refs.includes('B2->C2'), `源块引用应 B2→C2：${JSON.stringify(refs)}`);
  assert.ok(refs.includes('C2->B2'), `让位列引用应 C2→B2：${JSON.stringify(refs)}`);
});

test('delete_cell_range：被删列的引用标 dangling，右侧列引用给出左移建议', () => {
  const p = file('delete-stale.cpt');
  createCpt(p, { rows: 6, columns: 6, webWrite: true });
  addCell(p, { column: 0, row: 0, content: '=C2+D2', contentType: 'formula' });
  addCell(p, { column: 1, row: 1, content: 'b' });
  addCell(p, { column: 2, row: 1, content: 'c' });
  addCell(p, { column: 3, row: 1, content: 'd' });
  addFillSubmit(p, { dsName: 'Doris', table: 't', name: '提交', bindings: [{ field: 'a', column: 1, row: 0 }], condition: 'D2=1' });
  const r = deleteCellRange(p, { sheet: 0, fromColumn: 2, toColumn: 2 });
  const refs = (r.staleRefs ?? []).map((x) => `${x.ref}|${x.issue}|${x.suggest ?? ''}`);
  assert.ok(refs.includes('C2|dangling-ref|'), `被删列 C 的引用应为 dangling：${JSON.stringify(refs)}`);
  assert.ok(refs.includes('D2|needs-shift|C2'), `右侧 D 应建议左移到 C：${JSON.stringify(refs)}`);
  assert.ok(r.hint.includes('悬空') || r.hint.includes('update_cell'), r.hint);
});

test('delete_row_range：行轴同样体检（删行/上移建议），未被引用行不误报', () => {
  const p = file('delete-row-stale.cpt');
  createCpt(p, { rows: 10, columns: 4 });
  addCell(p, { column: 0, row: 0, content: '=A5+A6', contentType: 'formula' });
  addCell(p, { column: 0, row: 4, content: 'x' });
  addCell(p, { column: 0, row: 5, content: 'y' });
  const r = deleteRowRange(p, { sheet: 0, fromRow: 2, toRow: 2 });
  const refs = (r.staleRefs ?? []).map((x) => `${x.ref}->${x.suggest}`);
  assert.ok(refs.includes('A5->A4'), `A5 应建议 A4：${JSON.stringify(refs)}`);
  assert.ok(refs.includes('A6->A5'), `A6 应建议 A5：${JSON.stringify(refs)}`);
  assert.ok(!refs.some((x) => x.includes('A1')), `公式自身 A1 不应误报：${JSON.stringify(refs)}`);
});

process.on('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ } });
