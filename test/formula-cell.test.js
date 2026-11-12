// test/formula-cell.test.js —— 2026-10-29 公式闭环（sandbox19 v1 会话「不能改公式」根因）
//
// 三个缺陷：
//  ① add_cell(contentType:'formula') 写成普通 <O> CDATA（= 开头文本），FR 不当作公式计算；
//  ② update_cell 遇到官方公式对象（<O t="XMLable" class="com.fr.base.Formula">）直接拒绝"对象内容"，
//     且 set_cell_content_type 的 force 逃生口没在 MCP schema 暴露 → 只能 delete+add 反复；
//  ③ set_cell_content_type(formula) 传 "=ROW()-4" 会写成 "==ROW()-4"（无条件再补一个 =）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCpt, addCell } from '../lib/generate.js';
import { updateCellContent, setCellContentType } from '../lib/edits.js';
import { cells } from '../lib/cpt.js';
import '../scripts/isolate-store.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-formula-'));
const read = (p) => fs.readFileSync(p, 'utf8');
const cellXml = (p, c, r) => {
  const s = read(p);
  const i = s.indexOf(`<C c="${c}" r="${r}"`);
  assert.ok(i >= 0, `应存在单元格 (${c},${r})`);
  const end = s.indexOf('</C>', i);
  return s.slice(i, end + 4);
};
const FORMULA_TAG = '<O t="XMLable" class="com.fr.base.Formula">';

test('add_cell contentType=formula 写官方 Formula 对象（裸 = CDATA 不是公式）', () => {
  const p = path.join(tmp(), 'a.cpt');
  createCpt(p, { rows: 3, columns: 2 });
  addCell(p, { column: 0, row: 1, content: '=ROW()-1', contentType: 'formula' });
  const xml = cellXml(p, 0, 1);
  assert.ok(xml.includes(FORMULA_TAG), `应为官方公式对象：${xml}`);
  assert.match(xml, /<Attributes>\s*<!\[CDATA\[=ROW\(\)-1\]\]>/, '公式正文以单个 = 开头');
  assert.ok(!/<O>\s*<!\[CDATA\[=/.test(xml), '不应是裸 <O> CDATA 文本');
  // 不带 = 也归一
  addCell(p, { column: 1, row: 1, content: 'SUM(A1:A2)', contentType: 'formula' });
  assert.match(cellXml(p, 1, 1), /<!\[CDATA\[=SUM\(A1:A2\)\]\]>/);
});

test('update_cell content="=..." 原位改公式（保持对象，不再报"对象内容不能改"）', () => {
  const p = path.join(tmp(), 'u.cpt');
  createCpt(p, { rows: 3, columns: 2 });
  addCell(p, { column: 0, row: 1, content: '=ROW()-1', contentType: 'formula' });
  const r = updateCellContent(p, 0, 1, '=ROW()-4');
  assert.equal(r.mode, 'formula-update');
  const xml = cellXml(p, 0, 1);
  assert.ok(xml.includes(FORMULA_TAG), '对象形态保留');
  assert.match(xml, /<!\[CDATA\[=ROW\(\)-4\]\]>/);
  assert.ok(!xml.includes('ROW()-1'), '旧公式已被替换');
});

test('update_cell 文本格传 = 开头内容 → 升级为官方公式对象', () => {
  const p = path.join(tmp(), 'c.cpt');
  createCpt(p, { rows: 3, columns: 2 });
  addCell(p, { column: 0, row: 1, content: '占位', contentType: 'text' });
  const r = updateCellContent(p, 0, 1, '=1+1');
  assert.equal(r.mode, 'formula-convert');
  const xml = cellXml(p, 0, 1);
  assert.ok(xml.includes(FORMULA_TAG));
  assert.match(xml, /<!\[CDATA\[=1\+1\]\]>/);
});

test('update_cell 对公式格传纯文本 → 明确指路 set_cell_content_type(force)', () => {
  const p = path.join(tmp(), 'e.cpt');
  createCpt(p, { rows: 3, columns: 2 });
  addCell(p, { column: 0, row: 1, content: '=1+1', contentType: 'formula' });
  assert.throws(() => updateCellContent(p, 0, 1, '纯文本'), /公式对象.*set_cell_content_type/);
});

test('update_cell 对 DSColumn 对象内容仍拒绝，并指路 set_cell_content_type(force)', () => {
  const p = path.join(tmp(), 'd.cpt');
  createCpt(p, { rows: 3, columns: 2 });
  addCell(p, { column: 0, row: 1, content: 'x', contentType: 'text' });
  // 直接造官方 DSColumn 对象形态（避免依赖数据集）
  const s = read(p).replace(/<C c="0" r="1"[^>]*>[\s\S]*?<\/C>/, '<C c="0" r="1" s="0">\n<O t="DSColumn">\n<Attributes dsName="ds1" columnName="id"/>\n<Complex/>\n<FunctionGrouper/>\n<Parameters/>\n</O><PrivilegeControl/>\n<Expand/>\n</C>');
  fs.writeFileSync(p, s, 'utf8');
  assert.throws(() => updateCellContent(p, 0, 1, '文本'), /对象内容.*set_cell_content_type/);
});

test('set_cell_content_type formula 归一单个 =（此前会写 ==ROW()-4）', () => {
  const p = path.join(tmp(), 's.cpt');
  createCpt(p, { rows: 3, columns: 2 });
  addCell(p, { column: 0, row: 1, content: 'x', contentType: 'text' });
  setCellContentType(p, { column: 0, row: 1, contentType: 'formula', formula: '=ROW()-4' });
  let xml = cellXml(p, 0, 1);
  assert.ok(xml.includes(FORMULA_TAG));
  assert.match(xml, /<!\[CDATA\[=ROW\(\)-4\]\]>/);
  assert.ok(!xml.includes('==ROW'), '不应出现双 = 号');
  // 不带 = 同样归一（已是公式对象 → 用 force 整块替换）
  setCellContentType(p, { column: 0, row: 1, contentType: 'formula', formula: 'SUM(A1:A2)', force: true });
  xml = cellXml(p, 0, 1);
  assert.match(xml, /<!\[CDATA\[=SUM\(A1:A2\)\]\]>/);
});

test('set_cell_content_type 对象内容：无 force 拒绝，force=true 整块替换为公式', () => {
  const p = path.join(tmp(), 'f.cpt');
  createCpt(p, { rows: 3, columns: 2 });
  addCell(p, { column: 0, row: 1, content: '=1+1', contentType: 'formula' });
  assert.throws(() => setCellContentType(p, { column: 0, row: 1, contentType: 'text', content: '文本' }), /force:true/);
  const r = setCellContentType(p, { column: 0, row: 1, contentType: 'formula', formula: '=ROW()-9', force: true });
  assert.equal(r.mode, 'replace-object');
  assert.match(cellXml(p, 0, 1), /<!\[CDATA\[=ROW\(\)-9\]\]>/);
});

test('cells() 读回公式源码：formula/contentKind/contentText', () => {
  const p = path.join(tmp(), 'r.cpt');
  createCpt(p, { rows: 3, columns: 2 });
  addCell(p, { column: 0, row: 1, content: '=ROW()-1', contentType: 'formula' });
  const c = cells(p).find((x) => x.column === 0 && x.row === 1);
  assert.equal(c.contentKind, 'object:Formula');
  assert.equal(c.formula, '=ROW()-1');
  assert.equal(c.contentText, '=ROW()-1');
  assert.equal(c.contentObjectType, 'XMLable');
  assert.equal(c.contentClass, 'com.fr.base.Formula');
});
