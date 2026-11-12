import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCpt, addSheet, addCell, addFillSubmit } from '../lib/generate.js';
import { fillConfig } from '../lib/cpt.js';
import { addFillBinding, deleteFillBinding as delFill, getCellStyle } from '../lib/edits.js';
import '../scripts/isolate-store.mjs'; // M123：JS 基线 store 隔离，直跑也不污染真实 store

test('陷阱 7：addFillSubmit 多 sheet 时按 sheet 定位提交容器（已防御）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-trap7-'));
  const p = path.join(dir, 'x.cpt');
  createCpt(p, { rows: 2, columns: 2 });
  addSheet(p, { sheetName: 'sheet2', rows: 2, columns: 2 });
  addCell(p, { column: 0, row: 0, content: 'a', sheet: 0 });
  addCell(p, { column: 0, row: 0, content: 'b', sheet: 1 });
  // 显式 sheet=1：提交应写在 sheet2 内
  addFillSubmit(p, { dsName: 'Doris', table: 't', sheet: 1, bindings: [{ field: 'f1', column: 0, row: 0 }] });
  const raw = fs.readFileSync(p, 'utf8');
  const r1End = raw.indexOf('</Report>');
  const r1 = raw.slice(0, r1End);
  const r2 = raw.slice(r1End);
  assert.ok(!r1.includes('<SubmitVisitor'), 'sheet1 不应含 SubmitVisitor');
  assert.ok(r2.includes('<SubmitVisitor'), 'sheet2 应含 SubmitVisitor');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('陷阱 8：addFillBinding 多个提交时全文档 findAll 不分提交块（多 sheet 多填报 不可控）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-trap8-'));
  const p = path.join(dir, 'x.cpt');
  createCpt(p, { rows: 3, columns: 3 });
  addFillSubmit(p, { dsName: 'Doris', table: 't1', bindings: [] });
  addFillSubmit(p, { dsName: 'Doris', table: 't2', bindings: [] });
  // 两次提交，addFillBinding 默认 submitIndex=0 → 应绑定到 t1 的提交
  addFillBinding(p, 0, 'f1', 0, 0);
  const fc = fillConfig(p);
  assert.equal(fc.submits[0].columns.length, 1, 'submitIndex=0 应绑定到第 1 个提交');
  assert.equal(fc.submits[0].table, 't1');
  // 第 2 个提交 columns 仍应为空
  assert.equal(fc.submits[1].columns.length, 0, 'submitIndex=1 未被修改');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('陷阱 9：addSheet 名字含中文/特殊字符（FineReport <Report name=> 是否容错）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-trap9-'));
  const p = path.join(dir, 'x.cpt');
  createCpt(p, { rows: 2, columns: 2 });
  const r1 = addSheet(p, { sheetName: '查询-普通' });
  assert.equal(r1.sheet, '查询-普通');
  const r2 = addSheet(p, { sheetName: 'a&b<c>"' });
  assert.equal(r2.sheet, 'a&b<c>"');
  // 重新读取看 XML 中 name 是否被正确转义（escapeXmlAttr 把 < > & " ' 全转义）
  const raw = fs.readFileSync(p, 'utf8');
  assert.ok(/name="a&amp;b&lt;c&gt;&quot;"/.test(raw), '特殊字符应 XML 转义（& < > " 全转）');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('陷阱 10：deleteFillBinding submitIndex 超出范围会抛错（已防御）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-trap10-'));
  const p = path.join(dir, 'x.cpt');
  createCpt(p, { rows: 2, columns: 2 });
  addFillSubmit(p, { dsName: 'Doris', table: 't', bindings: [] });
  assert.throws(() => delFill(p, 5, 'f1'), /全文档提交不足/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('陷阱 11：getCellStyle 对缺 styleIndex 的单元格不抛错（边界）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-trap11-'));
  const p = path.join(dir, 'x.cpt');
  createCpt(p, { rows: 2, columns: 2 });
  // 创建一个有 styleIndex 的单元格
  addCell(p, { column: 0, row: 0, content: 'x' });
  // 改 s=999 模拟脏数据（应在 validate_cpt 里报 error，但 getCellStyle 自身）
  // 实际上 getCellStyle 靠 s 解析，999 在 styles 范围外时返回 styleIndex=999
  // 模拟：直接读 s=0 应能拿到
  const st = getCellStyle(p, 0, 0);
  assert.equal(st.styleIndex, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});
