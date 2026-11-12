// cpt-mcp/scripts/base-spec-smoke.mjs
// 冒烟测试：用 docs/base-spec/cpt-mcp-default-spec.json 作为基线，加最小业务字段，调 build_report
// 验证：1) build_report 不抛错；2) checkResult.hasError === false；3) 生成文件能被 validate_cpt 0 error
// 用法：node scripts/base-spec-smoke.mjs [outputPath]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildReport } from '../lib/engine/builder.js';
import { validateCpt } from '../lib/validate.js';
import { overview } from '../lib/cpt.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SPEC_PATH = path.join(__dirname, '..', 'docs', 'base-spec', 'cpt-mcp-default-spec.json');
const outPath = process.argv[2] || path.join(__dirname, '..', 'tmp_test', 'base-spec-smoke.cpt');

console.log('== cpt-mcp base-spec smoke ==');
console.log('spec :', SPEC_PATH);
console.log('out  :', outPath);

// 1) 过滤元字段后 spread
const raw = JSON.parse(fs.readFileSync(SPEC_PATH, 'utf8'));
const { _comment, _source, _schemaRef, ...base } = raw;

// 2) 业务覆盖：1 个数据集 + 1 个表头单元格 + 1 个数据单元格 + 1 个填报
const spec = {
  ...base,
  title: 'base-spec 冒烟测试',
  datasets: [
    {
      name: 'ds1',
      connection: 'Doris',
      sql: "SELECT 'A' AS col_a, 'B' AS col_b, 1 AS col_c",
    },
  ],
  cells: [
    { column: 1, row: 0, content: '列A', styleIndex: 0 },
    { column: 2, row: 0, content: '列B', styleIndex: 0 },
    { column: 3, row: 0, content: '列C', styleIndex: 0 },
    { column: 1, row: 1, contentType: 'dsColumn', dsName: 'ds1', columnName: 'col_a', styleIndex: 4 },
    { column: 2, row: 1, contentType: 'dsColumn', dsName: 'ds1', columnName: 'col_b', styleIndex: 4 },
    { column: 3, row: 1, contentType: 'dsColumn', dsName: 'ds1', columnName: 'col_c', styleIndex: 4 },
  ],
  fill: {
    dsName: 'Doris',
    table: 'smoke_test_table',
    bindings: [
      { field: 'col_a', column: 1, row: 1 },
      { field: 'col_b', column: 2, row: 1 },
      { field: 'col_c', column: 3, row: 1 },
    ],
  },
};

fs.mkdirSync(path.dirname(outPath), { recursive: true });
try { fs.rmSync(outPath, { force: true }); } catch { /* ignore */ }

// 3) 跑 build_report
const r = buildReport({ path: outPath, ...spec });

// 4) 断言
const errs = r.checkResult?.errors || [];
const ok = !r.checkResult?.hasError;
console.log('  steps         :', r.steps.length);
console.log('  styles added  :', r.steps.filter((s) => s.action === 'add_style').length);
console.log('  cells added   :', r.steps.filter((s) => s.action === 'add_cell').length);
console.log('  errors        :', errs.length);
console.log('  hasError      :', r.checkResult?.hasError);

// 5) 二次独立 validate
const issues = validateCpt(outPath);
const errorCount = issues.filter((i) => i.severity === 'error').length;
console.log('  validate_cpt  : error=' + errorCount + ' warning=' + issues.filter((i) => i.severity === 'warning').length + ' info=' + issues.filter((i) => i.severity === 'info').length);
console.log('  overview      :', JSON.stringify(overview(outPath)));

if (!ok || errorCount > 0) {
  console.error('SMOKE FAILED');
  console.error(JSON.stringify(r.checkResult, null, 2).slice(0, 1500));
  process.exit(1);
}
console.log('SMOKE OK');
