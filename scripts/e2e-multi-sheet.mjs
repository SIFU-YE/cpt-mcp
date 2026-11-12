// scripts/e2e-multi-sheet.mjs —— 多 sheet + 跨 sheet 引用 + 复杂样式 + 多 fill_submit 端到端
// 跑法: cd 桌面 && node scripts/e2e-multi-sheet.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildReport } from '../lib/engine/builder.js';
import { validateCpt } from '../lib/validate.js';
import { overview, datasets, cells, fillConfig } from '../lib/cpt.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const OUT = path.join(root, 'tmp_test', 'e2e-多sheet-订单.cpt');

console.log('== cpt-mcp 多 sheet e2e ==');
console.log('out:', OUT);

const spec = {
  title: '订单主从表 (e2e)',
  rows: 10,
  columns: 8,
  headerRowCount: 1,
  sheets: [
    { name: '订单主表' },
    { name: '订单明细' },
  ],
  webWrite: true,

  // 全局 styles: 主表 6 个 + 明细 1 个 = 7 个
  styles: [
    { id: 'h1', fontName: '微软雅黑', fontSizePt: 18, bold: true, foregroundColor: '#FFFFFF', backgroundColor: '#3836B3', horizontalAlignment: 0 },
    { id: 'd1', fontName: '微软雅黑', fontSizePt: 14, horizontalAlignment: 0, border: { top:{style:1,color:'#B3B3B3'},bottom:{style:1,color:'#B3B3B3'},left:{style:1,color:'#B3B3B3'},right:{style:1,color:'#B3B3B3'} } },
    { id: 'd2', fontName: '微软雅黑', fontSizePt: 14, bold: true, horizontalAlignment: 0, backgroundColor: '#F2F9FF', border: { top:{style:1,color:'#B3B3B3'},bottom:{style:1,color:'#B3B3B3'},left:{style:1,color:'#B3B3B3'},right:{style:1,color:'#B3B3B3'} } },
  ],

  datasets: [
    { name: 'ds_order', connection: 'Doris', sql: "SELECT order_id, customer, amount, created_at FROM orders WHERE order_id = '${order_id}'" },
    { name: 'ds_detail', connection: 'Doris', sql: "SELECT product, qty, price FROM order_details WHERE order_id = '${order_id}'" },
  ],

  // 多 sheet 单元格: 字段 sheet (0/1) 显式指定
  cells: [
    // ===== Sheet 0: 订单主表 =====
    { column: 0, row: 0, sheet: 0, content: '订单号', styleIndex: 0 },
    { column: 1, row: 0, sheet: 0, content: '客户',   styleIndex: 0 },
    { column: 2, row: 0, sheet: 0, content: '金额',   styleIndex: 0 },
    { column: 3, row: 0, sheet: 0, content: '日期',   styleIndex: 0 },
    { column: 0, row: 1, sheet: 0, contentType: 'dsColumn', dsName: 'ds_order', columnName: 'order_id',  styleIndex: 1 },
    { column: 1, row: 1, sheet: 0, contentType: 'dsColumn', dsName: 'ds_order', columnName: 'customer', styleIndex: 1 },
    { column: 2, row: 1, sheet: 0, contentType: 'dsColumn', dsName: 'ds_order', columnName: 'amount',   styleIndex: 1 },
    { column: 3, row: 1, sheet: 0, contentType: 'dsColumn', dsName: 'ds_order', columnName: 'created_at', styleIndex: 1 },
    // sheet 0 填报输入: 订单号查询 + 提交按钮
    { column: 0, row: 3, sheet: 0, content: '查询:', styleIndex: 1 },
    { column: 1, row: 3, sheet: 0, content: '', widget: 'text', styleIndex: 1 },
    { column: 2, row: 3, sheet: 0, content: '提交', widget: 'submit', styleIndex: 1 },

    // ===== Sheet 1: 订单明细 =====
    { column: 0, row: 0, sheet: 1, content: '产品',     styleIndex: 0 },
    { column: 1, row: 0, sheet: 1, content: '数量',     styleIndex: 0 },
    { column: 2, row: 0, sheet: 1, content: '单价',     styleIndex: 0 },
    { column: 3, row: 0, sheet: 1, content: '小计',     styleIndex: 0 },
    { column: 0, row: 1, sheet: 1, contentType: 'dsColumn', dsName: 'ds_detail', columnName: 'product', styleIndex: 1 },
    { column: 1, row: 1, sheet: 1, contentType: 'dsColumn', dsName: 'ds_detail', columnName: 'qty',     styleIndex: 1 },
    { column: 2, row: 1, sheet: 1, contentType: 'dsColumn', dsName: 'ds_detail', columnName: 'price',   styleIndex: 1 },
    // 公式: 小计 = 数量 * 单价
    { column: 3, row: 1, sheet: 1, content: '=B2*C2', styleIndex: 2 },
  ],

  // 多 sheet 填报表提交
  fills: [
    {
      dsName: 'Doris',
      table: 'orders',
      sheet: 0,
      bindings: [
        { field: 'order_id',  column: 0, row: 1 },
        { field: 'customer',  column: 1, row: 1 },
        { field: 'amount',    column: 2, row: 1 },
      ],
    },
    {
      dsName: 'Doris',
      table: 'order_details',
      sheet: 1,
      bindings: [
        { field: 'product', column: 0, row: 1 },
        { field: 'qty',     column: 1, row: 1 },
        { field: 'price',   column: 2, row: 1 },
      ],
    },
  ],

  parameters: [
    { name: 'order_id', defaultValue: '' },
  ],
  parameterPanel: { title: '订单查询', showWindow: true, windowPosition: 1 },
  parameterWidgets: [
    { name: 'order_id', type: 'text', label: '订单号' },
    { name: 'Search', type: 'submitButton', text: '查询' },
  ],
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
try { fs.rmSync(OUT, { force: true }); } catch { /* ignore */ }

const r = buildReport({ path: OUT, ...spec });

console.log('');
console.log('  steps       :', r.steps.length);
console.log('  styles      :', r.steps.filter((s) => s.action === 'add_style').length);
console.log('  cells       :', r.steps.filter((s) => s.action === 'add_cell').length);
console.log('  datasets    :', r.steps.filter((s) => s.action === 'add_dataset').length);
console.log('  fillSubmit  :', r.steps.filter((s) => s.action === 'add_fill_submit').length);
console.log('  sheets added:', r.steps.filter((s) => s.action === 'add_sheet').length);
console.log('  hasError    :', r.checkResult?.hasError);
console.log('  errors      :', (r.checkResult?.errors || []).length);

const issues = validateCpt(OUT);
const errCount = issues.filter((i) => i.severity === 'error').length;
const warnCount = issues.filter((i) => i.severity === 'warning').length;
console.log('  validate_cpt:', `error=${errCount} warning=${warnCount}`);

const ov = overview(OUT);
console.log('  overview    :', JSON.stringify(ov));
console.log('  datasets    :', datasets(OUT).map((d) => `${d.name}=${d.sql?.slice(0, 20)}...`));
console.log('  cells per sheet:', JSON.stringify(ov.sheets?.map((_, i) => cells(OUT, { sheet: i }).length)));
console.log('  fill configs:', fillConfig(OUT).submits?.map((s) => `${s.name}@${s.sheet} [${s.columns?.map((c) => c.field).join(',')}]`));

// S4 验证: sheets[0].name 真的作为主 sheet 名 (修复前会是 sheet1)
const sheetsList = ov.sheets || [];
console.log('  sheets       :', JSON.stringify(sheetsList));
console.log('  S4 sheets[0] 名字 =', sheetsList[0] === '订单主表' ? '✅ 订单主表' : '❌ ' + sheetsList[0] + ' (期望 订单主表)');

// 期望: 2 sheet + 2 dataset + 2 fill_submit + 19 cell (sheet0=11, sheet1=8) + 0 error + sheets[0].name="订单主表" (S4)
const expected = { sheets: 2, datasets: 2, cellCount: 19, fillSubmits: 2, firstSheetName: '订单主表' };
const ok =
  ov.sheets?.length === expected.sheets &&
  ov.datasets === expected.datasets &&
  ov.cellCount === expected.cellCount &&
  ov.fillSubmits === expected.fillSubmits &&
  sheetsList[0] === expected.firstSheetName &&
  errCount === 0;

if (!ok) {
  console.error('');
  console.error('E2E FAILED');
  console.error('expected:', JSON.stringify(expected));
  console.error('actual overview:', JSON.stringify(ov));
  process.exit(1);
}
console.log('');
console.log('E2E PASS');
