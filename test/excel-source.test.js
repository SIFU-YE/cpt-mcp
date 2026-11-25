// test/excel-source.test.js —— generate_report 的 Excel 数据源分支
//
// 为什么单独一个文件测这条路径：
//   用户最终目标是「提交字段逻辑和数据来源即可生成报表」，而"数据来源"很大一类是
//   「手上只有一张表」。这条路径完全绕开 connection / SQL —— 数据集走 ExcelTableData，
//   字段名就是 Excel 列名。它与 SQL 分支在 builder 里分流到不同原语，
//   任何一个分支写坏都不会被另一个分支的测试发现，所以必须单独锁住。
//
// 实证：ExcelTableData 官方 3 例，形态完全一致（见 test/dataset-extra.test.js 头部）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateReport } from '../lib/engine/index.js';
import { datasets } from '../lib/cpt.js';
import '../scripts/isolate-store.mjs'; // M123：JS 基线 store 隔离，直跑也不污染真实 store

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-excel-'));
const file = (n) => path.join(TMP, n);

const FIELDS = [
  { name: '地区', type: 'text' },
  { name: '销售额', type: 'money', summary: 'sum' },
];

test('generateReport：Excel 数据源 → 产出 ExcelTableData 且自检无 error', () => {
  const p = file('excel报表.cpt');
  const r = generateReport({
    path: p,
    title: '地区销售汇总',
    source: { excelFile: 'reportlets/data/销售明细.xlsx' },
    fields: FIELDS,
  });
  assert.equal(r.checkResult.hasError, false,
    `不应有 error: ${JSON.stringify(r.checkResult.validate.summary)}`);
  assert.equal(r.summary.dataSourceType, 'excel');
  assert.equal(r.summary.excelFile, 'reportlets/data/销售明细.xlsx');
  // 关键：Excel 分支不该凭空造出 SQL
  assert.equal(r.summary.sql, undefined, 'Excel 来源不需要 SQL');

  const xml = fs.readFileSync(p, 'utf8');
  assert.match(xml, /class="com\.fr\.data\.impl\.ExcelTableData"/);
  assert.match(xml, /filePath="reportlets\/data\/销售明细\.xlsx"/);
  assert.doesNotMatch(xml, /com\.fr\.data\.impl\.DBTableData/, '不应同时生成 SQL 数据集');
});

test('generateReport：Excel 分支的字段名就是 Excel 列名，不再走 safeIdent 反引号包裹', () => {
  const p = file('中文列名.cpt');
  const r = generateReport({
    path: p,
    title: '中文列名测试',
    source: { excelFile: 'D:/data/销售.xlsx', fromEnv: false, needColumnName: true },
    fields: [{ name: '销售额', type: 'money' }],
  });
  assert.equal(r.checkResult.hasError, false);
  const xml = fs.readFileSync(p, 'utf8');
  // 数据集列的引用形态是 <O t="DSColumn"><Attributes dsName="ds1" columnName="销售额"/>，
  // 不是 ds1.销售额。这里要锁的是：列名原样使用，没有被 SQL 分支的 safeIdent 加上反引号。
  assert.match(xml, /<Attributes dsName="ds1" columnName="销售额"\/>/);
  assert.doesNotMatch(xml, /columnName="`销售额`/, 'Excel 列名不该被反引号包裹（那是 SQL 分支的转义）');
  assert.match(xml, /isFromEnv="false"/, 'fromEnv=false 应透传到 ExcelTableDataAttr');
});

test('generateReport：Excel 数据集能被读回（get_datasets 口径）', () => {
  const p = file('读回.cpt');
  generateReport({
    path: p,
    title: '读回验证',
    source: { excelFile: 'reportlets/data/t.xlsx' },
    fields: FIELDS,
  });
  const ds = datasets(p);
  assert.ok(Array.isArray(ds) && ds.length === 1, '应只有 1 个数据集');
  assert.equal(ds[0].name, 'ds1');
});

test('安全围栏：Excel 来源 + 填报，未给 fill.dsName 时明确拒绝', () => {
  const p = file('填报缺连接.cpt');
  assert.throws(
    () => generateReport({
      path: p,
      title: 'x',
      source: { excelFile: 'reportlets/a.xlsx' },
      fields: FIELDS,
      fill: { table: 't_sales', fields: [{ field: '销售额' }] },
    }),
    /fill\.dsName/,
    'Excel 没法当回写目标，必须显式给回写用的数据连接',
  );
});

test('安全围栏：既不给 connection 也不给 excelFile 时报错要指出 Excel 这条路', () => {
  assert.throws(
    () => generateReport({
      path: file('无来源.cpt'), title: 'x',
      source: {}, fields: FIELDS,
    }),
    /excelFile/,
    '报错里必须给出"改用 excelFile"这条出路，否则模型只知道此路不通、不知道还能怎么走',
  );
});
