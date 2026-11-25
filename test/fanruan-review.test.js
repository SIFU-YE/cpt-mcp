import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCpt, addStyle, addCell } from '../lib/generate.js';
import { styles, gridSizes } from '../lib/cpt.js';
import { getCellStyle, updateCellStyle } from '../lib/edits.js';
import '../scripts/isolate-store.mjs'; // M123：JS 基线 store 隔离，直跑也不污染真实 store

test('审查报告 1 点：下划线/删除线用官方独立属性，而非 style 位 4/8', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-fr1-'));
  const p = path.join(dir, 'x.cpt');
  createCpt(p, { rows: 2, columns: 2 });
  const r = addStyle(p, { fontSizePt: 14, underline: true, strikethrough: true });
  const raw = fs.readFileSync(p, 'utf8');
  // 生成的 FRFont 不应有 style=13（4+8），而应有独立属性
  assert.ok(!/<FRFont [^>]*style="1[38]"/.test(raw), '不应出现 style=13/18');
  assert.ok(/underline="1"/.test(raw), '应有 underline="1"');
  assert.ok(/isStrikethrough="true"/.test(raw), '应有 isStrikethrough="true"');
  // 反读
  const st = styles(p).find(s => s.styleIndex === r.styleIndex);
  assert.equal(st.underline, true);
  assert.equal(st.strikethrough, true);
  // updateCellStyle 关闭下划线
  addCell(p, { column: 0, row: 0, content: 'x', styleIndex: r.styleIndex });
  updateCellStyle(p, 0, 0, { underline: false, strikethrough: false });
  const gs = getCellStyle(p, 0, 0);
  assert.equal(gs.underline, false);
  assert.equal(gs.strikethrough, false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('审查报告 2 点：文本单元格 Expand 为官方极简 <Expand/>（无 cellSortAttr/sortHeader/extendable）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-fr2-'));
  const p = path.join(dir, 'x.cpt');
  createCpt(p, { rows: 2, columns: 2 });
  addCell(p, { column: 0, row: 0, content: 'A' });
  const raw = fs.readFileSync(p, 'utf8');
  assert.ok(!raw.includes('extendable="3"'), '不应有 extendable="3"');
  assert.ok(!raw.includes('sortHeader'), '不应有 sortHeader');
  assert.ok(!raw.includes('cellSortAttr'), 'P1 修复后文本单元格不应写 cellSortAttr');
  assert.ok(!raw.includes('CellGUIAttr'), 'P1 修复后文本单元格不应写 CellGUIAttr');
  assert.ok(!raw.includes('CellPageAttr'), 'P1 修复后文本单元格不应写 CellPageAttr');
  // 官方样本极简形式：<C>...<PrivilegeControl/><Expand/></C>
  assert.ok(/<C c="0" r="0" s="0">[\s\S]*?<PrivilegeControl\/>[\s\S]*?<Expand\/>[\s\S]*?<\/C>/.test(raw), '应为官方极简 <PrivilegeControl/><Expand/></C>');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('审查报告 3 点：Submit 按钮 i18n key 与 Verify', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-fr3-'));
  const p = path.join(dir, 'x.cpt');
  createCpt(p, { rows: 2, columns: 2 });
  addCell(p, { column: 0, row: 0, widget: 'submit' });
  const raw = fs.readFileSync(p, 'utf8');
  assert.ok(raw.includes("i18n('Utils-Submit')"), '应为 Utils-Submit');
  assert.ok(/<Verify failVerifySubmit="false"\s*\/>/.test(raw) || /<Verify failVerifySubmit="false">/.test(raw), 'Verify 无 value');
  assert.ok(!raw.includes('FailVerifySubmit="false" value="true"'), '不应有 value="true"');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('审查报告 4/8 点：widgetValue 带 O + Format 子元素', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-fr4-'));
  const p = path.join(dir, 'x.cpt');
  createCpt(p, { rows: 2, columns: 2 });
  const r = addStyle(p, { fontSizePt: 14, format: { class: 'com.fr.base.CoreDecimalFormat', pattern: '#,##0.00', roundingMode: 6 } });
  const raw = fs.readFileSync(p, 'utf8');
  assert.ok(/<Format class="com.fr.base.CoreDecimalFormat" roundingMode="6">/.test(raw), '应有 Format 子元素');
  assert.ok(raw.includes('#,##0.00'), 'pattern 应在 CDATA');
  addCell(p, { column: 0, row: 0, widget: 'text' });
  const r2 = fs.readFileSync(p, 'utf8');
  // 检查 >=1 处 widgetValue 带 O
  assert.ok(/<widgetValue>\s*<O>\s*<!\[CDATA\[\]\]><\/O>\s*<\/widgetValue>/.test(r2), 'widgetValue 应带 <O><![CDATA[]]>');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('审查报告 6 点：number 控件类型', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-fr6-'));
  const p = path.join(dir, 'x.cpt');
  createCpt(p, { rows: 2, columns: 2 });
  addCell(p, { column: 0, row: 0, widget: 'number' });
  const raw = fs.readFileSync(p, 'utf8');
  assert.ok(raw.includes('com.fr.form.ui.NumberEditor'), '应生成 NumberEditor');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('审查报告 9 点：horizontal_alignment 支持 4', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-fr9-'));
  const p = path.join(dir, 'x.cpt');
  createCpt(p, { rows: 2, columns: 2 });
  const r = addStyle(p, { horizontalAlignment: 4 });
  const raw = fs.readFileSync(p, 'utf8');
  // 底层 addStyle 直接写 horizontal_alignment="4"（schema max 由 server.js 控制）
  assert.ok(/horizontal_alignment="4"/.test(raw), '应能写 horizontal_alignment="4"');
  fs.rmSync(dir, { recursive: true, force: true });
});
