// test/summary-grouper.test.js —— M76: DSColumn 汇总形态（SummaryGrouper）
//
// 官方样本（形态唯一依据，GettingStarted.cpt 汇总单元格逐字节实证）：
//   <O t="DSColumn">
//   <Attributes dsName="ds1" columnName="销量"/>
//   <Complex/>
//   <RG class="com.fr.report.cell.cellattr.core.group.SummaryGrouper">
//   <FN>
//   <![CDATA[com.fr.data.util.function.SumFunction]]></FN>
//   </RG>
//   <Parameters/>
//   </O>
// 要点：RG 非自闭合；子元素 <FN> 内 CDATA 放聚合函数类名；
//       其余子元素（Attributes/Complex/Parameters/sortXml）与 FunctionGrouper 分组形态完全一致。
// 缺省（不传 summary）= 自闭合 FunctionGrouper，与历史输出逐字节一致（零回归）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCpt, addDataset, addCell } from '../lib/generate.js';
import { setCellContentType } from '../lib/edits.js';
import { DS_SUMMARIES } from '../lib/engine/chart.js';
import { cells } from '../lib/cpt.js';
import { validateCpt } from '../lib/validate.js';
import '../scripts/isolate-store.mjs'; // M123：JS 基线 store 隔离，直跑也不污染真实 store

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-summary-'));
const read = (p) => fs.readFileSync(p, 'utf8');
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

/** 官方汇总形态的 RG 块（与 lib/engine/chart.js dsColumnRGXml 输出逐字节对齐） */
const summaryRG = (fnClass) =>
  `<RG class="com.fr.report.cell.cellattr.core.group.SummaryGrouper">\n<FN>\n<![CDATA[${fnClass}]]></FN>\n</RG>`;
const defaultRG = '<RG class="com.fr.report.cell.cellattr.core.group.FunctionGrouper"/>';

test('DS_SUMMARIES：5 键白名单从 CHART_AGGS 派生（none 不暴露）', () => {
  assert.deepEqual(Object.keys(DS_SUMMARIES).sort(), ['avg', 'count', 'max', 'min', 'sum']);
  assert.equal(DS_SUMMARIES.sum, 'com.fr.data.util.function.SumFunction');
  assert.equal(DS_SUMMARIES.avg, 'com.fr.data.util.function.AverageFunction');
  assert.equal(DS_SUMMARIES.count, 'com.fr.data.util.function.CountFunction');
  assert.equal(DS_SUMMARIES.max, 'com.fr.data.util.function.MaxFunction');
  assert.equal(DS_SUMMARIES.min, 'com.fr.data.util.function.MinFunction');
});

test('add_cell dsColumn + summary=sum：官方 GettingStarted.cpt 汇总形态落盘，其余结构与缺省形态逐字节一致', () => {
  const { d, p: pSum } = scaffold('sum.cpt');
  const pDefault = path.join(d, 'default.cpt');
  fs.copyFileSync(pSum, pDefault);

  addCell(pSum, { column: 1, row: 2, contentType: 'dsColumn', dsName: 'ds1', columnName: '销量', summary: 'sum' });
  addCell(pDefault, { column: 1, row: 2, contentType: 'dsColumn', dsName: 'ds1', columnName: '销量' });

  const sumXml = read(pSum);
  assert.ok(sumXml.includes(summaryRG('com.fr.data.util.function.SumFunction')), '应含官方 SummaryGrouper + FN CDATA 形态');
  assert.ok(!sumXml.includes(defaultRG), '汇总形态不应再出现自闭合 FunctionGrouper');
  // 结构一致性：把汇总 RG 块还原成缺省 RG 后，整份文件应与缺省输出完全相同
  // （即 Attributes/Complex/Parameters/Expand/样式等全部子元素与缺省形态一致）
  const normalized = sumXml.replace(summaryRG('com.fr.data.util.function.SumFunction'), defaultRG);
  assert.equal(normalized, read(pDefault), '除 RG 块外应与缺省形态逐字节一致');
  // 官方样本顺序：Attributes > Complex > RG > Parameters
  const oBlock = sumXml.slice(sumXml.indexOf('<O t="DSColumn">'), sumXml.indexOf('</C>', sumXml.indexOf('<O t="DSColumn">')));
  const iAttr = oBlock.indexOf('<Attributes dsName="ds1" columnName="销量"/>');
  const iComplex = oBlock.indexOf('<Complex/>');
  const iRG = oBlock.indexOf('<RG class="com.fr.report.cell.cellattr.core.group.SummaryGrouper">');
  const iParam = oBlock.indexOf('<Parameters/>');
  assert.ok(iAttr >= 0 && iComplex > iAttr && iRG > iComplex && iParam > iRG, '元素顺序应为 Attributes > Complex > RG > Parameters');
  assert.equal((validateCpt(pSum)).filter((i) => i.severity === 'error').length, 0, '汇总形态不应引入校验错误');
});

test('add_cell：5 个白名单值各产出对应聚合函数类名', () => {
  for (const [key, fnClass] of Object.entries(DS_SUMMARIES)) {
    const { p } = scaffold(`agg-${key}.cpt`);
    addCell(p, { column: 1, row: 2, contentType: 'dsColumn', dsName: 'ds1', columnName: '销量', summary: key });
    assert.ok(read(p).includes(summaryRG(fnClass)), `summary=${key} 应产出 ${fnClass}`);
  }
});

test('add_cell：非法 summary（含 none）throw 且报错列出全部合法值', () => {
  const { p } = scaffold();
  for (const bad of ['xyz', 'none', 'None', 'SUM ()', '求和']) {
    throwsWith(
      () => addCell(p, { column: 1, row: 2, contentType: 'dsColumn', dsName: 'ds1', columnName: '销量', summary: bad }),
      /sum \/ avg \/ count \/ max \/ min/,
      `非法值 "${bad}" 应报错并列出合法值`
    );
  }
});

test('add_cell：非 dsColumn 传 summary throw', () => {
  const { p } = scaffold();
  throwsWith(
    () => addCell(p, { column: 0, row: 1, content: '合计', summary: 'sum' }),
    /summary（DSColumn 汇总方式）只能用于 contentType="dsColumn"/,
    '文本格传 summary 应拒绝'
  );
  throwsWith(
    () => addCell(p, { column: 0, row: 1, content: '=SUM(A1)', summary: 'avg' }),
    /只能用于 contentType="dsColumn"/,
    '公式格传 summary 应拒绝'
  );
});

test('add_cell 缺省回归：不传 summary 输出自闭合 FunctionGrouper（与改动前一致）', () => {
  const { p } = scaffold();
  addCell(p, { column: 1, row: 2, contentType: 'dsColumn', dsName: 'ds1', columnName: '销量' });
  const xml = read(p);
  assert.ok(xml.includes(defaultRG), '缺省应保持自闭合 FunctionGrouper');
  assert.ok(!xml.includes('SummaryGrouper'), '缺省不应出现 SummaryGrouper');
});

test('set_cell_content_type：summary=sum 以官方汇总形态落盘，其余结构与缺省一致', () => {
  const { d, p: pSum } = scaffold('sct-sum.cpt');
  const pDefault = path.join(d, 'sct-default.cpt');
  fs.copyFileSync(pSum, pDefault);

  addCell(pSum, { column: 2, row: 3, content: '占位' });
  addCell(pDefault, { column: 2, row: 3, content: '占位' });
  setCellContentType(pSum, { column: 2, row: 3, contentType: 'dsColumn', dsName: 'ds1', columnName: '销量', summary: 'sum' });
  setCellContentType(pDefault, { column: 2, row: 3, contentType: 'dsColumn', dsName: 'ds1', columnName: '销量' });

  const sumXml = read(pSum);
  assert.ok(sumXml.includes(summaryRG('com.fr.data.util.function.SumFunction')), 'set_cell_content_type 也应产出官方汇总形态');
  const normalized = sumXml.replace(summaryRG('com.fr.data.util.function.SumFunction'), defaultRG);
  assert.equal(normalized, read(pDefault), '除 RG 块外应与缺省形态逐字节一致');
});

test('set_cell_content_type：非法 summary / 非 dsColumn 传 summary / 缺省回归', () => {
  const { d, p } = scaffold('sct-edge.cpt');
  // 先建占位格（setCellContentType 需定位已有单元格）
  addCell(p, { column: 2, row: 3, content: '占位' });
  throwsWith(
    () => setCellContentType(p, { column: 2, row: 3, contentType: 'dsColumn', dsName: 'ds1', columnName: '销量', summary: 'xyz' }),
    /sum \/ avg \/ count \/ max \/ min/,
    '非法值应报错并列出合法值'
  );
  throwsWith(
    () => setCellContentType(p, { column: 2, row: 3, contentType: 'dsColumn', dsName: 'ds1', columnName: '销量', summary: 'none' }),
    /sum \/ avg \/ count \/ max \/ min/,
    'none 对数据列无意义，应拒绝'
  );
  throwsWith(
    () => setCellContentType(p, { column: 2, row: 3, contentType: 'text', content: 'x', summary: 'sum' }),
    /summary（DSColumn 汇总方式）只能用于 contentType="dsColumn"/,
    'text 格传 summary 应拒绝'
  );
  // 缺省回归：不传 summary 保持 FunctionGrouper 自闭合
  setCellContentType(p, { column: 2, row: 3, contentType: 'dsColumn', dsName: 'ds1', columnName: '销量' });
  const xml = read(p);
  assert.ok(xml.includes(defaultRG), '缺省应保持自闭合 FunctionGrouper');
  assert.ok(!xml.includes('SummaryGrouper'), '缺省不应出现 SummaryGrouper');
  void d;
});

test('写后读回：get_cells（cells）对 SummaryGrouper 汇总格正常读取', () => {
  const { d, p } = scaffold('readback.cpt');
  // 出口 1：add_cell + summary
  addCell(p, { column: 1, row: 2, contentType: 'dsColumn', dsName: 'ds1', columnName: '销量', summary: 'sum' });
  // 出口 2：set_cell_content_type + summary
  addCell(p, { column: 2, row: 2, content: '占位' });
  setCellContentType(p, { column: 2, row: 2, contentType: 'dsColumn', dsName: 'ds1', columnName: '金额', summary: 'avg' });

  const list = cells(p);
  const c1 = list.find((c) => c.column === 1 && c.row === 2);
  const c2 = list.find((c) => c.column === 2 && c.row === 2);
  assert.ok(c1, 'add_cell 汇总格应能读回');
  assert.equal(c1.contentObjectType, 'DSColumn');
  assert.ok(c2, 'set_cell_content_type 汇总格应能读回');
  assert.equal(c2.contentObjectType, 'DSColumn');
  void d;
});
