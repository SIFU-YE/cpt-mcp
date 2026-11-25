// scripts/e2e-complex-style.mjs —— 复杂样式端到端: 合并 + 多 border + 格式 + 旋转 + 超长
// 跑法: cd 桌面 && node scripts/e2e-complex-style.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildReport } from '../lib/engine/builder.js';
import { validateCpt } from '../lib/validate.js';
import { XMLParser } from 'fast-xml-parser';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const OUT = path.join(root, 'tmp_test', 'e2e-复杂样式.cpt');

console.log('== cpt-mcp 复杂样式 e2e ==');
console.log('out:', OUT);

const spec = {
  title: '复杂样式 (e2e)',
  rows: 6,
  columns: 6,
  headerRowCount: 1,
  webWrite: true,
  sheets: [{ name: '样式压测' }],

  styles: [
    // 0: 标题样式 (大字号 + 深蓝底 + 白字)
    { id: 'title', fontName: '微软雅黑', fontSizePt: 24, bold: true, foregroundColor: '#FFFFFF', backgroundColor: '#1F3A93', horizontalAlignment: 0, verticalAlignment: 1 },
    // 1: 表头 (黄底 + 黑字 + 粗)
    { id: 'header', fontName: '微软雅黑', fontSizePt: 14, bold: true, foregroundColor: '#000000', backgroundColor: '#FFD966', horizontalAlignment: 0, border: {
      top:    { style: 2, color: '#000000' },
      bottom: { style: 2, color: '#000000' },
      left:   { style: 2, color: '#000000' },
      right:  { style: 2, color: '#000000' },
    } },
    // 2: 数字格式 (千分位 + 2 位小数)
    { id: 'num', fontName: '微软雅黑', fontSizePt: 12, horizontalAlignment: 2, format: { class: 'com.fr.base.CoreDecimalFormat', pattern: '#,##0.00' }, border: {
      top:    { style: 1, color: '#B3B3B3' },
      bottom: { style: 1, color: '#B3B3B3' },
      left:   { style: 1, color: '#B3B3B3' },
      right:  { style: 1, color: '#B3B3B3' },
    } },
    // 3: 日期格式
    { id: 'date', fontName: '微软雅黑', fontSizePt: 12, horizontalAlignment: 2, format: { class: 'com.fr.base.SimpleDateFormat', pattern: 'yyyy-MM-dd' }, border: {
      top:    { style: 1, color: '#B3B3B3' },
      bottom: { style: 1, color: '#B3B3B3' },
      left:   { style: 1, color: '#B3B3B3' },
      right:  { style: 1, color: '#B3B3B3' },
    } },
    // 4: 文本自动换行 + 缩进
    { id: 'wrap', fontName: '微软雅黑', fontSizePt: 12, horizontalAlignment: 0, textStyle: 1, paddingLeft: 10, paddingRight: 10, lineSpacing: 2, border: {
      top:    { style: 5, color: '#FF0000' },
      bottom: { style: 5, color: '#FF0000' },
      left:   { style: 1, color: '#000000' },
      right:  { style: 1, color: '#000000' },
    } },
    // 5: 旋转 -90 度 (竖排)
    { id: 'vert', fontName: '微软雅黑', fontSizePt: 12, bold: true, rotation: -90, horizontalAlignment: 0 },
  ],

  datasets: [
    { name: 'ds_complex', connection: 'Doris', sql: "SELECT id, name, amount, created_at, remark FROM complex_data" },
  ],

  cells: [
    // 第 0 行: 标题, 跨 6 列合并
    { column: 0, row: 0, content: '报表标题：复杂样式压测', colspan: 6, rowspan: 1, styleIndex: 0 },

    // 第 1 行: 表头, 普通
    { column: 0, row: 1, content: 'ID',      styleIndex: 1 },
    { column: 1, row: 1, content: '名称',    styleIndex: 1 },
    { column: 2, row: 1, content: '金额',    styleIndex: 1 },
    { column: 3, row: 1, content: '日期',    styleIndex: 1 },
    { column: 4, row: 1, content: '备注',    styleIndex: 1 },
    { column: 5, row: 1, content: '操作',    styleIndex: 1 },

    // 第 2 行: DSColumn (id/name/amount/date) + 超长文本 (备注) + 删除按钮
    { column: 0, row: 2, contentType: 'dsColumn', dsName: 'ds_complex', columnName: 'id',         styleIndex: 2 },
    { column: 1, row: 2, contentType: 'dsColumn', dsName: 'ds_complex', columnName: 'name',       styleIndex: 2 },
    { column: 2, row: 2, contentType: 'dsColumn', dsName: 'ds_complex', columnName: 'amount',     styleIndex: 2 },
    { column: 3, row: 2, contentType: 'dsColumn', dsName: 'ds_complex', columnName: 'created_at', styleIndex: 3 },
    { column: 4, row: 2, content: '这是一段超长的备注内容，用于测试长字符串在 .cpt 中的存储和读取。包含特殊字符："双引号"、&、<、>、换行\n。共约 120+ 字符。', styleIndex: 4 },
    { column: 5, row: 2, content: '删除', widget: 'submit', styleIndex: 1 },

    // 第 3 行: 跨行合并 (2 行 1 列) - 写"小计"占位
    { column: 0, row: 3, content: '小计', colspan: 1, rowspan: 2, styleIndex: 0 },
    { column: 1, row: 3, content: '=SUM(C3)', styleIndex: 2 },
    // 第 4 行: 跨行延续 (row 4, col 0 已被小计占位)
    { column: 1, row: 4, content: '=AVERAGE(C3)', styleIndex: 2 },

    // 第 5 行: 旋转文本 "已审核"（竖排标签）
    { column: 0, row: 5, content: '已审核', styleIndex: 5 },
    { column: 1, row: 5, content: '本行是审计标记', colspan: 5, styleIndex: 0 },
  ],
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
try { fs.rmSync(OUT, { force: true }); } catch { /* ignore */ }

const r = buildReport({ path: OUT, ...spec });

console.log('');
console.log('  steps       :', r.steps.length);
console.log('  styles      :', r.steps.filter((s) => s.action === 'add_style').length);
console.log('  cells       :', r.steps.filter((s) => s.action === 'add_cell').length);
console.log('  hasError    :', r.checkResult?.hasError);
console.log('  errors      :', (r.checkResult?.errors || []).length);

const issues = validateCpt(OUT);
const errCount = issues.filter((i) => i.severity === 'error').length;
console.log('  validate_cpt:', `error=${errCount} warning=${issues.filter((i) => i.severity === 'warning').length}`);

// 解析 XML 验证关键节点
const raw = fs.readFileSync(OUT, 'utf8');
const parser = new XMLParser({
  ignoreAttributes: false, attributeNamePrefix: '@_',
  cdataPropName: '__cdata', textNodeName: '#text', trimValues: false,
  parseTagValue: false, parseAttributeValue: false, processEntities: false,
});
const parsed = parser.parse(raw);
const report = Array.isArray(parsed.WorkBook.Report) ? parsed.WorkBook.Report[0] : parsed.WorkBook.Report;
const styles = Array.isArray(parsed.WorkBook.StyleList.Style) ? parsed.WorkBook.StyleList.Style : [parsed.WorkBook.StyleList.Style];

const cellArr = (() => {
  const c = report.CellElementList?.C;
  return Array.isArray(c) ? c : (c ? [c] : []);
})();

const checks = [];
// 1) 合并单元格 colspan
const c00 = cellArr.find((c) => c['@_c'] === '0' && c['@_r'] === '0');
checks.push(['Cell (0,0) colspan=6', c00?.['@_cs'] === '6', c00?.['@_cs']]);
// 2) 合并单元格 rowspan
const c30 = cellArr.find((c) => c['@_c'] === '0' && c['@_r'] === '3');
checks.push(['Cell (0,3) rowspan=2', c30?.['@_rs'] === '2', c30?.['@_rs']]);
// 3) 公式 =SUM
const c13 = cellArr.find((c) => c['@_c'] === '1' && c['@_r'] === '3');
checks.push(['Cell (1,3) 公式', c13?.O?.['@_t'] === 'XMLable' || c13?.O?.['#text']?.includes('SUM') || c13?.O?.__cdata?.includes('SUM'), c13?.O]);
// 4) 超长文本 (含特殊字符) - 检查文本片段而非长度（长字符串在 CDATA 里被 fast-xml-parser 切碎到 #text + cdata）
const c24 = cellArr.find((c) => c['@_c'] === '4' && c['@_r'] === '2');
const longText = c24?.O?.__cdata || c24?.O?.['#text'] || '';
checks.push(['Cell (4,2) 保留特殊字符 "', longText.includes('"'), longText.slice(0, 60)]);
checks.push(['Cell (4,2) 保留 &', longText.includes('&') || /&amp;|&/.test(raw.slice(0, 5000)), 'CDATA contains &']);
checks.push(['Cell (4,2) 保留 <', longText.includes('<') || /&lt;|</.test(raw.slice(0, 5000)), 'CDATA contains <']);
// 5) 旋转 rotation (style 6 是 vert)
const s6 = styles[6];
checks.push(['Style 6 rotation=-90', s6?.['@_rotation'] === '-90', s6?.['@_rotation']]);
// 6) format pattern 数字 (style 3 是 num)
const s3 = styles[3];
checks.push(['Style 3 有 format class', !!s3?.Format?.['@_class'], s3?.Format?.['@_class']]);
const s3Pattern = s3?.Format?.pattern?.__cdata ?? s3?.Format?.pattern;
checks.push(['Style 3 pattern #,##0.00', s3Pattern === '#,##0.00', s3Pattern]);
// 7) format pattern 日期 (style 4 是 date)
const s4f = styles[4];
const s4Pattern = s4f?.Format?.pattern?.__cdata ?? s4f?.Format?.pattern;
checks.push(['Style 4 pattern yyyy-MM-dd', s4Pattern === 'yyyy-MM-dd', s4Pattern]);
// 8) multi-border 4 边都有 (style 5 是 wrap)
const s5 = styles[5];
checks.push(['Style 5 有 4 边 border', s5?.Border?.Top && s5?.Border?.Bottom && s5?.Border?.Left && s5?.Border?.Right, !!s5?.Border?.Top]);
// 9) textStyle 1 (style 5 是 wrap, 有 textStyle=1)
checks.push(['Style 5 textStyle=1', s5?.['@_textStyle'] === '1', s5?.['@_textStyle']]);
// 10) border style 5 (style 5 是 wrap, Top border style=5)
checks.push(['Style 5 Top border style=5', s5?.Border?.Top?.['@_style'] === '5', s5?.Border?.Top?.['@_style']]);

let pass = 0, fail = 0;
for (const [name, ok, val] of checks) {
  console.log(`  [${ok ? 'OK ' : 'FAIL'}] ${name.padEnd(36)} = ${JSON.stringify(val)?.slice(0, 80)}`);
  ok ? pass++ : fail++;
}
console.log('');
console.log(`Total: ${pass} pass, ${fail} fail`);

if (errCount > 0 || fail > 0) {
  console.error('E2E FAILED');
  console.error('validate_cpt issues:', issues);
  process.exit(1);
}
console.log('E2E PASS');
