// scripts/e2e-build-report.mjs —— 端到端验证: 加载 base-spec + 覆盖业务字段 + build_report 生成完整 .cpt
// 用 base-spec 的 spread 模式, 模拟模型调 cpt-mcp/build_report 的真实链路
// 跑法: cd 桌面 && node scripts/e2e-build-report.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildReport } from '../lib/engine/builder.js';
import { validateCpt } from '../lib/validate.js';
import { overview } from '../lib/cpt.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const SPEC_PATH = path.join(root, 'docs', 'base-spec', 'cpt-mcp-default-spec.json');
const OUT_DIR = path.join(root, 'tmp_test');
const OUT = path.join(OUT_DIR, 'e2e-销售汇总.cpt');

console.log('== cpt-mcp 端到端 build_report 测试 ==');
console.log('spec :', SPEC_PATH);
console.log('out  :', OUT);

// 1) 加载 base-spec, 过滤元字段
const raw = JSON.parse(fs.readFileSync(SPEC_PATH, 'utf8'));
const { _comment, _source, _schemaRef, ...base } = raw;

// 2) 业务覆盖 —— "销售汇总表" 真实场景
const spec = {
  ...base,
  title: '销售汇总表 (e2e 测试)',
  rows: 8,
  columns: 6,
  headerRowCount: 1,
  datasets: [
    {
      name: 'ds_sales',
      connection: 'Doris',
      sql: 'SELECT region, salesperson, SUM(amount) AS total FROM sales_log GROUP BY region, salesperson',
    },
  ],
  cells: [
    // 表头
    { column: 0, row: 0, content: '大区',         styleIndex: 0 },
    { column: 1, row: 0, content: '销售员',        styleIndex: 0 },
    { column: 2, row: 0, content: '销售额',        styleIndex: 0 },
    { column: 3, row: 0, content: '佣金',          styleIndex: 1 },
    { column: 4, row: 0, content: '操作',          styleIndex: 0 },
    { column: 5, row: 0, content: '备注',          styleIndex: 0 },
    // 数据行（DSColumn）
    { column: 0, row: 1, contentType: 'dsColumn', dsName: 'ds_sales', columnName: 'region',     styleIndex: 4 },
    { column: 1, row: 1, contentType: 'dsColumn', dsName: 'ds_sales', columnName: 'salesperson', styleIndex: 4 },
    { column: 2, row: 1, contentType: 'dsColumn', dsName: 'ds_sales', columnName: 'total',      styleIndex: 5 },
    // 填报输入单元格
    { column: 3, row: 1, content: '', widget: 'text', styleIndex: 5 },
    { column: 4, row: 1, content: '查看', widget: 'submit', styleIndex: 4 },
    { column: 5, row: 1, content: '初始备注', styleIndex: 4 },
  ],
  parameters: [
    { name: 'region', defaultValue: '' },
  ],
  parameterWidgets: [
    { name: 'region', type: 'comboBox', label: '大区筛选', items: [
      { key: '华东', value: '华东' },
      { key: '华北', value: '华北' },
      { key: '华南', value: '华南' },
    ] },
  ],
  fill: {
    dsName: 'Doris',
    table: 'sales_summary',
    bindings: [
      { field: 'region',     column: 0, row: 1 },
      { field: 'salesperson', column: 1, row: 1 },
      { field: 'total',      column: 2, row: 1 },
      { field: 'commission', column: 3, row: 1 },
      { field: 'note',       column: 5, row: 1 },
    ],
  },
};

fs.mkdirSync(OUT_DIR, { recursive: true });
try { fs.rmSync(OUT, { force: true }); } catch { /* ignore */ }

// 3) 跑 build_report (M37: webWrite 透传, 走完整填报模板路径)
const r = buildReport({ path: OUT, ...spec, webWrite: true });

// 4) 验证
const errs = r.checkResult?.errors || [];
const ok = !r.checkResult?.hasError;
console.log('');
console.log('  steps        :', r.steps.length);
console.log('  styles added :', r.steps.filter((s) => s.action === 'add_style').length);
console.log('  cells added  :', r.steps.filter((s) => s.action === 'add_cell').length);
console.log('  errors       :', errs.length);
console.log('  hasError     :', r.checkResult?.hasError);

const issues = validateCpt(OUT);
const errCount = issues.filter((i) => i.severity === 'error').length;
const warnCount = issues.filter((i) => i.severity === 'warning').length;
console.log('  validate_cpt :', `error=${errCount} warning=${warnCount} info=${issues.filter((i) => i.severity === 'info').length}`);
console.log('  overview     :', JSON.stringify(overview(OUT)));

if (!ok || errCount > 0) {
  console.error('E2E FAILED');
  console.error(JSON.stringify(r.checkResult, null, 2).slice(0, 1500));
  process.exit(1);
}
console.log('');
console.log('E2E PASS');

// 不删 tmp_test 目录, 留着看
console.log('文件已生成: ' + OUT);
