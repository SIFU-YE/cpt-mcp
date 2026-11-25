// test/chart.test.js —— 图表（柱形 / 折线 / 饼）
//
// 逆向依据（官方 1559 样本实证）：
//   图表单元格：<C c r cs rs><O t="CC"><LayoutAttr selectedIndex="0"/>CHART</O><PrivilegeControl/><Expand/></C>
//     <O t="CC"> 后紧跟 LayoutAttr 的有 540/543（99.4%）
//   Plot class：VanChartColumnPlot 194 / PiePlot4VanChart 100 / VanChartLinePlot 58
//   ChartDefinition（681 个）两种数据集驱动形态：
//     单数值列 → OneValueCDDefinition（166 例，seriesName=X轴分类 / valueName=数值 / CategoryName value="无"）
//     多数值列 → MoreNameCDDefinition（230 例，CategoryName=X轴分类 + 多个 ChartSummaryColumn）
//     两者与 Plot 类型自由交叉（柱形 52/109、折线 16/40、饼 76/1），故按数值列个数自动选
//   聚合类：com.fr.data.util.function 下只有 Sum/Average/Count/Max/Min/None 六个
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCpt, addDataset } from '../lib/generate.js';
import { addChart, chartXml, chartDefinitionXml, CHART_TYPES, normalizeAgg } from '../lib/engine/chart.js';
import { generateReport } from '../lib/engine/index.js';
import { validateCpt } from '../lib/validate.js';
import '../scripts/isolate-store.mjs'; // M123：JS 基线 store 隔离，直跑也不污染真实 store

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-chart-'));
const read = (p) => fs.readFileSync(p, 'utf8');
const errCount = (p) => (validateCpt(p)).filter((i) => i.severity === 'error').length;
function throwsWith(fn, re, msg) {
  let caught;
  try { fn(); } catch (e) { caught = e; }
  assert.ok(caught, msg ?? `应抛错：${re}`);
  assert.match(caught.message, re, msg);
}

function scaffold(name = 'a.cpt') {
  if (path.basename(name) !== name || name.includes('..')) throw new Error(`scaffold 非法文件名: ${name}`);
  const d = tmp();
  const p = path.join(d, name);
  createCpt(p, { title: 'T', rows: 20, columns: 6 });
  addDataset(p, { name: 'ds1', connection: 'Doris', sql: 'SELECT 1' });
  return { d, p };
}

test('三种图表的骨架各自取自官方样本，Plot class 与出处可追溯', () => {
  assert.deepEqual(Object.keys(CHART_TYPES).sort(), ['column', 'line', 'pie']);
  assert.equal(CHART_TYPES.column.plotClass, 'com.fr.plugin.chart.column.VanChartColumnPlot');
  assert.equal(CHART_TYPES.line.plotClass, 'com.fr.plugin.chart.line.VanChartLinePlot');
  assert.equal(CHART_TYPES.pie.plotClass, 'com.fr.plugin.chart.PiePlot4VanChart');
  for (const k of Object.keys(CHART_TYPES)) {
    assert.ok(CHART_TYPES[k].source.endsWith('.cpt'), `${k} 应记录官方样本出处`);
  }
});

test('add_chart：单元格包裹与官方 543 例一致（O t=CC + LayoutAttr + PrivilegeControl + Expand）', () => {
  const { d, p } = scaffold();
  const r = addChart(p, {
    column: 0, row: 5, type: 'column', title: '各地区销售额',
    dsName: 'ds1', category: '地区', values: [{ name: 'amount', agg: 'sum' }],
    colspan: 4, rowspan: 12,
  });
  assert.equal(r.action, 'add_chart');
  assert.equal(r.chartType, '柱形图');

  const xml = read(p);
  assert.match(xml, /<C c="0" r="5" cs="4" rs="12">/);
  const i = xml.indexOf('<C c="0" r="5"');
  const cell = xml.slice(i, xml.indexOf('</C>', i));
  assert.match(cell, /<O t="CC">\n<LayoutAttr selectedIndex="0"\/>/, 'LayoutAttr 紧跟 <O t="CC">');
  assert.match(cell, /<\/Chart>\n<\/O>\n<PrivilegeControl\/>\n<Expand\/>/, '图表块后是 </O> + PrivilegeControl + Expand');
  assert.equal(errCount(p), 0, '写入后仍是可解析的合法模板');
  fs.rmSync(d, { recursive: true, force: true });
});

test('单数值列 → OneValueCDDefinition（官方 166 例形态）', () => {
  const def = chartDefinitionXml({
    dsName: 'ds1', category: '货主地区',
    values: [{ name: '运货费', agg: 'avg' }],
  });
  assert.match(def, /<OneValueCDDefinition seriesName="货主地区" valueName="运货费" function="com\.fr\.data\.util\.function\.AverageFunction">/);
  assert.match(def, /<Top topCate="-1" topValue="-1" isDiscardOtherCate="false" isDiscardOtherSeries="false" isDiscardNullCate="false" isDiscardNullSeries="false"\/>/);
  assert.match(def, /<TableData class="com\.fr\.data\.impl\.NameTableData">\n<Name>\n<!\[CDATA\[ds1\]\]><\/Name>\n<\/TableData>/);
  assert.match(def, /<CategoryName value="无"\/>/, '单系列时 CategoryName 恒为「无」');
});

test('多数值列 → MoreNameCDDefinition（官方 230 例形态）', () => {
  const def = chartDefinitionXml({
    dsName: 'ds1', category: '国家',
    values: [{ name: '数量', agg: 'sum' }, { name: '金额', agg: 'sum', label: '销售额' }],
  });
  assert.match(def, /<MoreNameCDDefinition>/);
  assert.match(def, /<CategoryName value="国家"\/>/, '多系列时 X 轴分类写在 CategoryName');
  assert.match(def, /<ChartSummaryColumn name="数量" function="com\.fr\.data\.util\.function\.SumFunction" customName="数量"\/>/);
  assert.match(def, /<ChartSummaryColumn name="金额" function="com\.fr\.data\.util\.function\.SumFunction" customName="销售额"\/>/);
});

test('标题与图表名写进骨架槽位，CDATA 闭合符被拦下', () => {
  const x = chartXml({
    type: 'pie', title: '占比分析', dsName: 'ds1',
    category: '类型', values: ['数量'],
  });
  assert.match(x, /<Chart name="占比分析"/);
  assert.match(x, /<O>\n<!\[CDATA\[占比分析\]\]><\/O>/);
  assert.match(x, /class="com\.fr\.plugin\.chart\.PiePlot4VanChart"/);
  // CDATA 闭合符会截断 XML，必须在写入前被拦下
  throwsWith(() => chartXml({ type: 'pie', title: 'a]]>b', dsName: 'd', category: 'c', values: ['v'] }), /CDATA|非法|闭合/);
});

test('安全围栏：图表类型 / 聚合方式 / 坐标 / 缺字段都会被明确拒绝', () => {
  const { d, p } = scaffold('b.cpt');
  throwsWith(() => addChart(p, { column: 0, row: 1, type: 'radar', dsName: 'ds1', category: 'a', values: ['b'] }),
    /不支持/, '雷达图未开放，应明确列出可用类型');
  throwsWith(() => addChart(p, { column: 0, row: 1, type: 'column', dsName: 'ds1', category: 'a', values: [{ name: 'b', agg: 'median' }] }),
    /agg/, 'median 不在官方六个聚合类里');
  throwsWith(() => addChart(p, { column: -1, row: 1, dsName: 'ds1', category: 'a', values: ['b'] }), /坐标非法/);
  throwsWith(() => addChart(p, { column: 0, row: 1, dsName: '', category: 'a', values: ['b'] }), /dsName/);
  throwsWith(() => addChart(p, { column: 0, row: 1, dsName: 'ds1', category: 'a', values: [] }), /values/);
  assert.doesNotMatch(read(p), /<Chart /, '任何拒绝都不应写坏模板');
  fs.rmSync(d, { recursive: true, force: true });
});

test('安全围栏：同坐标已有单元格时不覆盖', () => {
  const { d, p } = scaffold('c.cpt');
  addChart(p, { column: 0, row: 3, dsName: 'ds1', category: 'a', values: ['b'] });
  throwsWith(() => addChart(p, { column: 0, row: 3, dsName: 'ds1', category: 'a', values: ['b'] }), /已存在/);
  fs.rmSync(d, { recursive: true, force: true });
});

test('normalizeAgg：true/别名归一化为官方六个聚合类之一', () => {
  assert.equal(normalizeAgg(true), 'sum');
  assert.equal(normalizeAgg(undefined), 'sum');
  assert.equal(normalizeAgg('average'), 'avg');
  assert.equal(normalizeAgg('COUNT'), 'count');
  assert.equal(normalizeAgg('none'), 'none');
  throwsWith(() => normalizeAgg('median'), /agg/);
});

test('generate_report(chart:true) —— 只给字段+数据源就白得一张图表', () => {
  const d = tmp();
  const p = path.join(d, 'g.cpt');
  const r = generateReport({
    path: p,
    title: '销售分析',
    source: { connection: 'Doris', table: 'sales' },
    fields: [
      { name: 'region', label: '地区', type: 'text' },
      { name: 'amount', label: '金额', type: 'money', summary: 'sum' },
      { name: 'qty', label: '数量', type: 'number', summary: 'sum' },
    ],
    chart: true,
  });
  assert.equal(r.checkResult.hasError, false, JSON.stringify(r.checkResult.errors));

  const s = r.summary.chart;
  assert.equal(s.type, 'column', '默认柱形图');
  assert.equal(s.category, 'region', 'X 轴自动取第一个文本字段');
  assert.deepEqual(s.values.map((v) => v.name), ['amount', 'qty'], '数值列自动取所有数值字段');
  assert.ok(s.values.every((v) => v.agg === 'sum'), '默认 sum 聚合');
  assert.equal(s.position.row, 4 + 1, '图表放在明细表（含汇总行）下方、空一行');

  const xml = read(p);
  assert.match(xml, /class="com\.fr\.plugin\.chart\.column\.VanChartColumnPlot"/);
  assert.match(xml, /<MoreNameCDDefinition>/, '两个数值列 → 多系列');
  assert.match(xml, /<CategoryName value="region"\/>/);
  assert.equal(errCount(p), 0);
  fs.rmSync(d, { recursive: true, force: true });
});

test('generate_report(chart:{type:"pie"}) —— 饼图自动收敛为单数值列定义', () => {
  const d = tmp();
  const p = path.join(d, 'pie.cpt');
  const r = generateReport({
    path: p,
    title: '占比',
    source: { connection: 'Doris', table: 'sales' },
    fields: [
      { name: 'region', label: '地区', type: 'text' },
      { name: 'amount', label: '金额', type: 'money' },
    ],
    chart: { type: 'pie' },
  });
  assert.equal(r.checkResult.hasError, false);
  const xml = read(p);
  assert.match(xml, /class="com\.fr\.plugin\.chart\.PiePlot4VanChart"/);
  assert.match(xml, /<OneValueCDDefinition seriesName="region" valueName="amount"/);
  fs.rmSync(d, { recursive: true, force: true });
});

test('generate_report：饼图给多个数值列被拒（官方 100 个饼图只有 1 例多数值列）', () => {
  const d = tmp();
  const p = path.join(d, 'bad.cpt');
  throwsWith(() => generateReport({
    path: p,
    title: 'x',
    source: { connection: 'D', table: 't' },
    fields: [
      { name: 'region', type: 'text' },
      { name: 'a', type: 'money' },
      { name: 'b', type: 'money' },
    ],
    chart: { type: 'pie' },
  }), /饼图只支持一个数值列/);
  fs.rmSync(d, { recursive: true, force: true });
});

test('generate_report：没有数值字段时给出可操作的替代方案', () => {
  const d = tmp();
  const p = path.join(d, 'nonum.cpt');
  throwsWith(() => generateReport({
    path: p,
    source: { connection: 'D', table: 't' },
    fields: [{ name: 'region', type: 'text' }, { name: 'memo', type: 'text' }],
    chart: true,
  }), /count/, '引导用 count 计数，而不是让模型干瞪眼');
  fs.rmSync(d, { recursive: true, force: true });
});
