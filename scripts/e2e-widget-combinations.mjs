// scripts/e2e-widget-combinations.mjs —— 多 widget 组合 + 多 fill_submit 边界 e2e
// 跑法: cd 桌面 && node scripts/e2e-widget-combinations.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildReport } from '../lib/engine/builder.js';
import { validateCpt } from '../lib/validate.js';
import { XMLParser } from 'fast-xml-parser';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const OUT = path.join(root, 'tmp_test', 'e2e-多widget.cpt');

console.log('== cpt-mcp 多 widget 组合 e2e ==');
console.log('out:', OUT);

const spec = {
  title: '多 widget + 多 fill_submit (e2e)',
  rows: 8,
  columns: 4,
  headerRowCount: 1,
  webWrite: true,
  sheets: [{ name: '表单' }, { name: '操作' }],

  // 只用默认样式 (0) — 关注 widget 行为而非样式
  styles: [],

  datasets: [
    { name: 'ds1', connection: 'Doris', sql: "SELECT id, name FROM form_data" },
  ],

  // 参数面板: 联动控件 (类型: text + date + submitButton)
  parameters: [
    { name: 'q', defaultValue: '' },
    { name: 'start_date', defaultValue: '2026-01-01' },
  ],
  parameterPanel: { title: '查询条件', showWindow: true, windowPosition: 1 },
  parameterWidgets: [
    { name: 'q', type: 'text', label: '关键字' },
    { name: 'start_date', type: 'date', label: '开始日期' },
    { name: 'Search', type: 'submitButton', text: '查询' },
  ],

  cells: [
    // ===== Sheet 0: 表单输入区 =====
    { column: 0, row: 0, content: '字段', styleIndex: 0 },
    { column: 1, row: 0, content: '值',   styleIndex: 0 },

    // 5 种输入控件
    { column: 0, row: 1, content: '文本', styleIndex: 0 },
    { column: 1, row: 1, content: '', widget: 'text', styleIndex: 0 },

    { column: 0, row: 2, content: '数字', styleIndex: 0 },
    { column: 1, row: 2, content: '0', widget: 'number', styleIndex: 0 },

    { column: 0, row: 3, content: '日期', styleIndex: 0 },
    { column: 1, row: 3, content: '2026-01-01', widget: 'date', styleIndex: 0 },

    { column: 0, row: 4, content: '长文本', styleIndex: 0 },
    { column: 1, row: 4, content: '', widget: 'textarea', styleIndex: 0 },

    { column: 0, row: 5, content: '下拉', styleIndex: 0 },
    { column: 1, row: 5, content: 'A', widget: 'comboBox', widgetItems: [
      { key: 'A', value: '选项 A' },
      { key: 'B', value: '选项 B' },
      { key: 'C', value: '选项 C' },
    ], styleIndex: 0 },

    { column: 0, row: 6, content: '复选', styleIndex: 0 },
    { column: 1, row: 6, content: 'true', widget: 'checkBox', styleIndex: 0 },

    { column: 0, row: 7, content: '标签', styleIndex: 0 },
    { column: 1, row: 7, content: '只读标签内容', widget: 'label', styleIndex: 0 },

    // ===== Sheet 1: 操作按钮区 =====
    { column: 0, row: 0, sheet: 1, content: '提交',     widget: 'submit',    styleIndex: 0 },
    { column: 1, row: 0, sheet: 1, content: '新增行',   widget: 'appendRow', styleIndex: 0 },
    // custom 控件: Excel 导入按钮 (M-plot 模拟)
    { column: 2, row: 0, sheet: 1, content: '导入 Excel', widget: 'custom',
      widgetClass: 'com.fr.plugin.excel.ui.ExcelImportButton',
      pluginID: 'com.fr.plugin.mark.excel.import.v11',
      pluginVersion: '11.0',
      styleIndex: 0 },
  ],

  // 多 fill_submit (M39 验证): 2 个跨 sheet 提交
  fills: [
    {
      dsName: 'Doris',
      table: 'main_table',
      sheet: 0,
      bindings: [
        { field: 'txt',  column: 1, row: 1 },
        { field: 'num',  column: 1, row: 2 },
        { field: 'dt',   column: 1, row: 3 },
        { field: 'note', column: 1, row: 4 },
        { field: 'opt',  column: 1, row: 5 },
        { field: 'chk',  column: 1, row: 6 },
      ],
    },
    {
      dsName: 'Doris',
      table: 'op_table',
      sheet: 1,
      bindings: [
        { field: 'op_type', column: 0, row: 0 },
      ],
    },
  ],
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
try { fs.rmSync(OUT, { force: true }); } catch { /* ignore */ }

const r = buildReport({ path: OUT, ...spec });

console.log('');
console.log('  steps       :', r.steps.length);
console.log('  hasError    :', r.checkResult?.hasError);
console.log('  errors      :', (r.checkResult?.errors || []).length);
const issues = validateCpt(OUT);
const errCount = issues.filter((i) => i.severity === 'error').length;
console.log('  validate_cpt:', `error=${errCount} warning=${issues.filter((i) => i.severity === 'warning').length}`);

const raw = fs.readFileSync(OUT, 'utf8');
const p = new XMLParser({
  ignoreAttributes: false, attributeNamePrefix: '@_',
  cdataPropName: '__cdata', textNodeName: '#text',
  parseTagValue: false, parseAttributeValue: false, processEntities: false,
});
const x = p.parse(raw);

// 找所有 cell + 收集 widget class
const reports = Array.isArray(x.WorkBook.Report) ? x.WorkBook.Report : [x.WorkBook.Report];
const allCells = [];
for (const r of reports) {
  const c = r.CellElementList?.C;
  if (c) allCells.push(...(Array.isArray(c) ? c : [c]));
}

const checks = [];

// === Sheet 0 (表单) 的 widget 验证 ===
const widgetMap = {
  1: { name: 'TextEditor',         widget: 'text' },
  2: { name: 'NumberEditor',       widget: 'number' },
  3: { name: 'DateEditor',         widget: 'date' },
  4: { name: 'TextArea',           widget: 'textarea' },
  5: { name: 'ComboBox',           widget: 'comboBox' },
  6: { name: 'CheckBox',           widget: 'checkBox' },
  7: { name: 'Label',              widget: 'label' },
};
for (const [rowStr, exp] of Object.entries(widgetMap)) {
  const row = Number(rowStr);
  const cell = allCells.find((c) => c['@_c'] === '1' && c['@_r'] === String(row) && c['@_sheet'] !== '1');
  const wc = cell?.Widget?.['@_class'];
  const ok = !!wc && wc.endsWith('.' + exp.name);
  checks.push([`Cell (1,${row}) widget=${exp.widget}`, ok, wc || 'missing']);
}

// === comboBox 必须有 Dictionary 节点 ===
const cboCell = allCells.find((c) => c['@_c'] === '1' && c['@_r'] === '5');
checks.push(['ComboBox 有 Dictionary', !!cboCell?.Widget?.Dictionary, !!cboCell?.Widget?.Dictionary]);
checks.push(['ComboBox Dict item 数=3', cboCell?.Widget?.Dictionary?.CustomDictAttr?.Dict?.length === 3, cboCell?.Widget?.Dictionary?.CustomDictAttr?.Dict?.length]);

// === checkBox 不需要 Dictionary ===
const chkCell = allCells.find((c) => c['@_c'] === '1' && c['@_r'] === '6');
checks.push(['CheckBox 无 Dictionary', !chkCell?.Widget?.Dictionary, !chkCell?.Widget?.Dictionary]);

// === Label 的 widgetValue 含 "只读标签内容" ===
const lblCell = allCells.find((c) => c['@_c'] === '1' && c['@_r'] === '7');
const lblText = lblCell?.Widget?.widgetValue?.O?.__cdata || '';
checks.push(['Label 文本保留', lblText === '只读标签内容', lblText]);

// === Sheet 1 (操作) 的按钮验证 ===
// 注意: 多 sheet 的 cell 在 XML 里按 <Report> 块分组, 不带 @_sheet 属性
// 验证时应按 Report 索引找
const submitReport = reports[1];
const submitCells = submitReport?.CellElementList?.C
  ? (Array.isArray(submitReport.CellElementList.C) ? submitReport.CellElementList.C : [submitReport.CellElementList.C])
  : [];
const submitCell = submitCells.find((c) => c['@_c'] === '0' && c['@_r'] === '0');
checks.push(['Submit button class', submitCell?.Widget?.['@_class'] === 'com.fr.report.web.button.write.Submit', submitCell?.Widget?.['@_class']]);

const addRowCell = submitCells.find((c) => c['@_c'] === '1' && c['@_r'] === '0');
checks.push(['AppendRow button class', addRowCell?.Widget?.['@_class'] === 'com.fr.report.web.button.write.AppendColumnRow', addRowCell?.Widget?.['@_class']]);

// === Custom (Excel 导入) — 含 pluginID + plugin-version ===
const customCell = submitCells.find((c) => c['@_c'] === '2' && c['@_r'] === '0');
checks.push(['Custom Widget class', customCell?.Widget?.['@_class'] === 'com.fr.plugin.excel.ui.ExcelImportButton', customCell?.Widget?.['@_class']]);
checks.push(['Custom pluginID', customCell?.Widget?.['@_pluginID'] === 'com.fr.plugin.mark.excel.import.v11', customCell?.Widget?.['@_pluginID']]);
checks.push(['Custom plugin-version', customCell?.Widget?.['@_plugin-version'] === '11.0', customCell?.Widget?.['@_plugin-version']]);

// === 多 fill_submit: 2 个 SubmitVisitor, 跨 sheet ===
const subs = (() => {
  // collect from both reports
  const out = [];
  for (const r of reports) {
    const sw = r.ReportWriteAttr?.SubmitVisitor;
    if (sw) out.push(...(Array.isArray(sw) ? sw : [sw]));
  }
  return out;
})();
checks.push(['SubmitVisitor count = 2 (M39)', subs.length === 2, subs.length]);
checks.push(['Submit 0 sheet=main_table (sheet 0)', subs[0]?.DMLConfig?.Table?.['@_name'] === 'main_table', subs[0]?.DMLConfig?.Table?.['@_name']]);
checks.push(['Submit 1 sheet=op_table (sheet 1)', subs[1]?.DMLConfig?.Table?.['@_name'] === 'op_table', subs[1]?.DMLConfig?.Table?.['@_name']]);
checks.push(['Submit 0 bindings count = 6', subs[0]?.DMLConfig?.ColumnConfig?.length === 6, subs[0]?.DMLConfig?.ColumnConfig?.length]);
// submit 1 (op_table) 只有 1 个 binding, fast-xml-parser 解析成 object 非 array
const sub1Cols = subs[1]?.DMLConfig?.ColumnConfig;
const sub1Count = Array.isArray(sub1Cols) ? sub1Cols.length : (sub1Cols ? 1 : 0);
checks.push(['Submit 1 bindings count = 1', sub1Count === 1, sub1Count]);

// === 参数面板: 3 widget ===
// 注意: parameterWidgets spec 是同名的, 但 InnerWidget.@_name 取自 addParameterWidget 内部
// 实际写的是 WidgetName.@_name
const pUi = x.WorkBook?.ReportParameterAttr?.ParameterUI?.Layout;
const pWidgets = pUi?.Widget ? (Array.isArray(pUi.Widget) ? pUi.Widget : [pUi.Widget]) : [];
checks.push(['ParameterPanel widget count = 3', pWidgets.length === 3, pWidgets.length]);
const widgetNames = pWidgets.map((w) => w?.WidgetName?.['@_name'] || w?.InnerWidget?.WidgetName?.['@_name']);
checks.push(['ParameterPanel 包含 q / start_date / Search',
  widgetNames.includes('q') && widgetNames.includes('start_date') && widgetNames.includes('Search'),
  JSON.stringify(widgetNames)]);

let pass = 0, fail = 0;
for (const [name, ok, val] of checks) {
  const v = JSON.stringify(val)?.slice(0, 60) || 'undefined';
  console.log(`  [${ok ? 'OK ' : 'FAIL'}] ${name.padEnd(45)} = ${v}`);
  ok ? pass++ : fail++;
}
console.log('');
console.log(`Total: ${pass} pass, ${fail} fail`);

if (errCount > 0 || fail > 0) {
  console.error('E2E FAILED');
  process.exit(1);
}
console.log('E2E PASS');
