// test/golden.test.js —— 生成产物快照回归（生成稳定度的根基）
//
// 【解决什么】生成链路是确定性的（模板内容里无时间戳/随机量），同 spec 应产出
// byte 级一致的 XML。任何代码改动导致输出漂移（哪怕只是重构），这里立刻显形 ——
// diff 就是 review 材料。教训来源：左父格语义错误曾以"测试全绿"的形态存活。
//
// 用法：
//   npm test              # 常规：生成产物与 test/golden/*.xml 逐字节比对
//   npm run test:golden   # 同上（显式入口）
//   UPDATE_GOLDEN=1 npm run test:golden   # 有意变更默认样式/布局后重新固化基线
//                                          # （commit 说明必须写明变更原因）
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { generateReport } from '../lib/engine/index.js';
import { createCpt, addDataset, addStyle, addCell, addFillSubmit, setGrid, addTreeDataset, addFloatElement } from '../lib/generate.js';
import { addChart } from '../lib/engine/chart.js';
import { buildReport } from '../lib/engine/builder.js';
import '../scripts/isolate-store.mjs'; // M123：JS 基线 store 隔离，直跑也不污染真实 store

const GOLDEN = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w):/, '$1:')), 'golden');
const UPDATE = process.env.UPDATE_GOLDEN === '1' || process.argv.includes('--update');
const normalize = (s) => s.replaceAll('\r\n', '\n');

/** 每个 golden 用例 = { spec: 生成函数, note: 覆盖点 }；生成函数必须完全确定性 */
const CASES = {
  'minimal-skeleton': {
    note: 'create_cpt 骨架（无标题/无 Web 属性变体）',
    gen: (p) => createCpt(p, { rows: 3, columns: 4 }),
  },
  'detail-summary-chart': {
    note: 'generate_report 全家桶：明细+汇总+斑马纹+图表+参数面板',
    gen: (p) => generateReport({
      path: p,
      title: '月度销售',
      source: { connection: 'Doris', table: 'sales', parameters: [{ name: 'region', defaultValue: '华东' }] },
      fields: [
        { name: 'region', label: '地区' },
        { name: 'product', label: '产品名称', type: 'text' },
        { name: 'qty', label: '销量', type: 'number' },
        { name: 'amount', label: '金额', type: 'money', summary: 'sum' },
      ],
      fill: { table: 'sales' },
      chart: { type: 'column', category: 'region', values: [{ name: 'amount', agg: 'sum' }] },
    }),
  },
  'fill-template': {
    note: '原语拼装填报模板：控件 + 主键绑定',
    gen: (p) => {
      createCpt(p, { rows: 3, columns: 5, webWrite: true });
      addStyle(p, { fontSizePt: 12, bold: true, backgroundColor: '#D9E1F2' });
      addStyle(p, { fontSizePt: 12 });
      ['工号', '姓名', '部门', '入职日期', '薪资'].forEach((h, i) => addCell(p, { column: i, row: 0, content: h, styleIndex: 1 }));
      addCell(p, { column: 0, row: 1, styleIndex: 2, widget: 'text' });
      addCell(p, { column: 2, row: 1, styleIndex: 2, widget: 'comboBox', widgetItems: [{ key: '研发', value: '研发' }] });
      addCell(p, { column: 3, row: 1, styleIndex: 2, widget: 'date' });
      addFillSubmit(p, { dsName: 'Doris', table: 'emp', bindings: [{ field: 'no', column: 0, row: 1, isKey: true }] });
      setGrid(p, { rowHeights: [900000, 720000, 720000] });
    },
  },
  'tree-dataset': {
    note: '树数据集 + 层级列',
    gen: (p) => {
      createCpt(p, { rows: 4, columns: 3 });
      addDataset(p, { name: 'org', connection: 'Doris', sql: 'SELECT id, name, parent_id FROM org_table' });
      addTreeDataset(p, { name: 'org_tree', source: 'org', childField: 0, parentField: 2, childFieldName: 'id', parentFieldName: 'parent_id' });
      addStyle(p, { fontSizePt: 12 });
      addCell(p, { column: 0, row: 1, contentType: 'dsColumn', dsName: 'org_tree', columnName: 'name', styleIndex: 1 });
    },
  },
  'detail-compact': {
    note: 'P1-1 版式密度：compact 档（字号/行高/列宽整表联动）',
    gen: (p) => generateReport({
      path: p,
      title: '运营明细',
      source: { connection: 'Doris', table: 'ops' },
      fields: [
        { name: 'sku', label: 'SKU 编码' },
        { name: 'qty', label: '销量', type: 'number' },
      ],
      options: { density: 'compact' },
    }),
  },
  'detail-wide-header': {
    note: 'P1-2 列宽自适应：长中文表头自动加宽',
    gen: (p) => generateReport({
      path: p,
      title: '年度经营分析',
      source: { connection: 'Doris', table: 'finance' },
      fields: [
        { name: 'metric', label: '年度销售额完成情况对比分析' },
        { name: 'amount', label: '金额', type: 'money' },
      ],
    }),
  },
  'multi-sheet': {
    note: 'build_report 多工作表一次成型',
    gen: (p) => buildReport({
      path: p,
      sheets: [{ name: '华东' }, { name: '华北' }],
      datasets: [{ name: 'ds', connection: 'Doris', sql: 'SELECT region, amount FROM t WHERE region in (${a},${b})',
        parameters: [{ name: 'a', defaultValue: '华东' }, { name: 'b', defaultValue: '华北' }] }],
      styles: [{ fontSizePt: 14 }, { fontSizePt: 12, bold: true }, { fontSizePt: 12 }],
      cells: ['华东', '华北'].flatMap((sheet) => [
        { column: 0, row: 0, content: `${sheet}销售`, styleIndex: 0, colspan: 2, sheet },
        { column: 0, row: 1, content: '地区', styleIndex: 1, sheet },
        { column: 1, row: 1, content: '金额', styleIndex: 1, sheet },
        { column: 0, row: 2, contentType: 'dsColumn', dsName: 'ds', columnName: 'region', styleIndex: 2, sheet },
        { column: 1, row: 2, contentType: 'dsColumn', dsName: 'ds', columnName: 'amount', styleIndex: 2, sheet },
      ]),
      settings: { paper: 'A4' },
      check: false,
    }),
  },
  'dashboard': {
    note: '大屏：浮动标语/KPI + 柱/折/饼三图 + 16:9 纸张',
    gen: (p) => {
      createCpt(p, { title: '2026 销售监控中心', rows: 20, columns: 12 });
      addDataset(p, { name: 'ds1', connection: 'Doris', sql: 'SELECT region, amount FROM s1' });
      addDataset(p, { name: 'ds2', connection: 'Doris', sql: 'SELECT month, amount FROM s2' });
      addDataset(p, { name: 'ds3', connection: 'Doris', sql: 'SELECT cat, amount FROM s3' });
      addStyle(p, { fontSizePt: 24, bold: true, foregroundColor: '#00E4FF' });
      addFloatElement(p, { content: '监控中心', styleIndex: 1, leftMm: 80, topMm: 4, widthMm: 100, heightMm: 14 });
      addChart(p, { column: 0, row: 1, colspan: 6, rowspan: 10, type: 'column', dsName: 'ds1', category: 'region', values: ['amount'] });
      addChart(p, { column: 6, row: 1, colspan: 6, rowspan: 10, type: 'line', dsName: 'ds2', category: 'month', values: ['amount'] });
      addChart(p, { column: 0, row: 11, colspan: 12, rowspan: 9, type: 'pie', dsName: 'ds3', category: 'cat', values: ['amount'] });
      setGrid(p, { rowHeights: Array.from({ length: 20 }, () => 720000) });
      setGrid(p, { columnWidths: Array.from({ length: 12 }, () => 3168000) });
    },
  },
};

test('golden: 生成链路确定性（同 spec 双跑 byte 一致）', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-golden-det-'));
  const p1 = path.join(d, 'a.cpt');
  const p2 = path.join(d, 'b.cpt');
  CASES['detail-summary-chart'].gen(p1);
  CASES['detail-summary-chart'].gen(p2);
  assert.equal(normalize(fs.readFileSync(p1, 'utf8')), normalize(fs.readFileSync(p2, 'utf8')),
    '同 spec 两次生成结果不一致 —— 生成链路存在非确定性来源，快照回归将不可用');
  fs.rmSync(d, { recursive: true, force: true });
});

for (const [name, { gen }] of Object.entries(CASES)) {
  test(`golden: ${name}`, () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-golden-'));
    const p = path.join(d, 'a.cpt');
    gen(p);
    const xml = normalize(fs.readFileSync(p, 'utf8'));
    const goldenPath = path.join(GOLDEN, `${name}.xml`);
    if (UPDATE) {
      fs.mkdirSync(GOLDEN, { recursive: true });
      fs.writeFileSync(goldenPath, xml);
      console.log(`  [golden] 已更新基线: ${goldenPath}`);
      fs.rmSync(d, { recursive: true, force: true });
      return;
    }
    assert.ok(fs.existsSync(goldenPath), `缺少 golden 基线 ${goldenPath}（用 UPDATE_GOLDEN=1 npm run test:golden 固化）`);
    const expected = normalize(fs.readFileSync(goldenPath, 'utf8'));
    fs.rmSync(d, { recursive: true, force: true });
    assert.equal(xml, expected,
      '生成产物与快照不一致 —— 输出发生漂移。若是有意的样式/布局变更：UPDATE_GOLDEN=1 重新固化并在 commit 说明原因；否则排查改动');
  });
}
