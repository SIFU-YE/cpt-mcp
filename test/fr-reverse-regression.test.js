import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createCpt, addCell, addSheet, addStyle, setGrid, setParameterPanel, setReportSettings } from '../lib/generate.js';
import { getCellStyle, updateCellStyle } from '../lib/edits.js';
import { buildReport } from '../lib/engine/builder.js';
import { generateReport } from '../lib/engine/smart.js';
import { load, locateSheet, styleBlocks } from '../lib/xml.js';
import '../scripts/isolate-store.mjs'; // M123：JS 基线 store 隔离，直跑也不污染真实 store

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-fr-reverse-'));
const file = (name) => path.join(TMP, name);

test('FR 官方样本：单元格 s 只索引 StyleList，addStyle 返回真实追加索引', (t) => {
  const source = 'D:/FineReport_11.0/webapps/webroot/WEB-INF/reportlets/demo/basic/产品明细.cpt';
  if (!fs.existsSync(source)) return t.skip('本机无 FR 官方样本');
  const target = file('product.cpt');
  fs.copyFileSync(source, target);

  const before = styleBlocks(load(target).raw).blocks.length;
  assert.equal(before, 20);
  const cell = getCellStyle(target, 0, 0);
  assert.equal(cell.styleIndex, 1);
  assert.equal(cell.fontName, 'Microsoft YaHei UI');
  assert.equal(cell.fontSizePt, 36);
  assert.equal(cell.horizontalAlignment, 2);
  assert.ok(cell.border?.top);

  const added = addStyle(target, { fontSizePt: 13 });
  assert.equal(added.styleIndex, before);
  assert.equal(styleBlocks(load(target).raw).blocks.length, before + 1);
});

test('FR 官方旧序列化：legacy WorkSheet 与无属性 <Style> 可定位', (t) => {
  const source = 'D:/FineReport_11.0/webapps/webroot/WEB-INF/reportlets/doc/Advanced/Columns_1.cpt';
  if (!fs.existsSync(source)) return t.skip('本机无 FR 官方样本');
  const target = file('columns.cpt');
  fs.copyFileSync(source, target);

  assert.equal(locateSheet(load(target).raw, 'sheet1').index, 0);
  assert.equal(styleBlocks(load(target).raw).blocks.length, 5);
  assert.equal(getCellStyle(target, 0, 3).styleIndex, 4);
});

test('updateCellStyle 默认 clone-on-write，且未请求的 FRFont 属性不丢失', () => {
  const target = file('clone-on-write.cpt');
  createCpt(target, { rows: 2, columns: 2 });
  const style = addStyle(target, { fontSizePt: 12, underline: true, strikethrough: true });
  addCell(target, { column: 0, row: 0, content: 'A', styleIndex: style.styleIndex });
  addCell(target, { column: 1, row: 0, content: 'B', styleIndex: style.styleIndex });

  const changed = updateCellStyle(target, 0, 0, { fontSizePt: 20, italic: true });
  const first = getCellStyle(target, 0, 0);
  const second = getCellStyle(target, 1, 0);
  assert.notEqual(changed.styleIndex, changed.originalStyleIndex);
  assert.equal(first.fontSizePt, 20);
  assert.equal(first.italic, true);
  assert.equal(first.underline, true);
  assert.equal(first.strikethrough, true);
  assert.equal(second.styleIndex, style.styleIndex);
  assert.equal(second.fontSizePt, 12);
});

test('buildReport 把 styleIndex 解释为 styles[] 下标并映射到真实 StyleList', () => {
  const target = file('style-map.cpt');
  buildReport({
    path: target,
    styles: [{ fontName: '微软雅黑', fontSizePt: 20, bold: true, backgroundColor: '#123456' }],
    cells: [{ column: 0, row: 0, content: '标题', styleIndex: 0 }],
  });
  const style = getCellStyle(target, 0, 0);
  assert.equal(style.styleIndex, 1, '骨架样式 0 后的第一个声明样式应序列化为 1');
  assert.equal(style.fontSizePt, 20);
  assert.equal(style.bold, true);
  assert.equal(style.backgroundColor, '#123456');
});

test('buildReport 在声明样式索引越界时不发布新文件或覆盖旧文件', () => {
  const fresh = file('bad-fresh.cpt');
  assert.throws(() => buildReport({
    path: fresh,
    styles: [{ fontSizePt: 12 }],
    cells: [{ column: 0, row: 0, content: 'x', styleIndex: 9 }],
  }), /styleIndex=9.*越界/);
  assert.equal(fs.existsSync(fresh), false);

  const existing = file('bad-existing.cpt');
  fs.writeFileSync(existing, 'PRESERVE', 'utf8');
  // 显式 noOverwrite:false 越过覆盖保护，确保失败原因仍是 styleIndex 越界（而不是"拒绝覆盖"）
  assert.throws(() => buildReport({
    path: existing,
    styles: [{ fontSizePt: 12 }],
    cells: [{ column: 0, row: 0, content: 'x', styleIndex: 9 }],
    noOverwrite: false,
  }), /styleIndex=9.*越界/);
  assert.equal(fs.readFileSync(existing, 'utf8'), 'PRESERVE');
});

test('generateReport 第 27 列汇总使用 AA 单元格引用', () => {
  const target = file('aa-summary.cpt');
  const fields = Array.from({ length: 27 }, (_, index) => ({
    name: `f${index + 1}`,
    type: 'number',
    ...(index === 26 ? { summary: 'sum' } : {}),
  }));
  generateReport({ path: target, source: { connection: 'JDBC', table: 't' }, fields });
  assert.match(load(target).raw, /<!\[CDATA\[=sum\(AA3\)\]\]>/i);
});

test('多工作表设置只修改目标 sheet；参数面板只改显式字段', () => {
  const target = file('scoped-settings.cpt');
  createCpt(target, { rows: 2, columns: 2, sheetName: 'first' });
  addSheet(target, { sheetName: 'second', rows: 2, columns: 2 });
  setReportSettings(target, { orientation: 1, sheet: 'second' });
  setGrid(target, { rowHeights: [111, 222], sheet: 'second' });

  const raw = load(target).raw;
  const first = locateSheet(raw, 'first');
  const second = locateSheet(raw, 'second');
  assert.match(raw.slice(first.start, first.end), /<PaperSetting\/>/);
  assert.doesNotMatch(raw.slice(first.start, first.end), /<PaperSetting orientation="1">/);
  assert.match(raw.slice(second.start, second.end), /<PaperSetting orientation="1">/);
  assert.doesNotMatch(raw.slice(first.start, first.end), /<!\[CDATA\[111,222\]\]>/);
  assert.match(raw.slice(second.start, second.end), /<!\[CDATA\[111,222\]\]>/);

  setParameterPanel(target, { title: '旧标题', showWindow: false, windowPosition: 3 });
  setParameterPanel(target, { title: '新标题' });
  const panel = load(target).raw.match(/<ReportParameterAttr>[\s\S]*?<\/ReportParameterAttr>/)?.[0] ?? '';
  assert.match(panel, /showWindow="false"/);
  assert.match(panel, /windowPosition="3"/);
  assert.match(panel, /<!\[CDATA\[新标题\]\]>/);
});

test('generateReport 拒绝图表引用 fields 外的字段', () => {
  assert.throws(() => generateReport({
    path: file('bad-chart.cpt'),
    source: { connection: 'JDBC', table: 't' },
    fields: [{ name: '地区' }, { name: '销售额', type: 'money' }],
    chart: { category: '不存在', values: ['销售额'] },
  }), /chart\.category=.*不在 fields/);
  assert.throws(() => generateReport({
    path: file('bad-chart-value.cpt'),
    source: { connection: 'JDBC', table: 't' },
    fields: [{ name: '地区' }, { name: '销售额', type: 'money' }],
    chart: { category: '地区', values: ['不存在'] },
  }), /chart\.values 字段.*不在 fields/);
});
