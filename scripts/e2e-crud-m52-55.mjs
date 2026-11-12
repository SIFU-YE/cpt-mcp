// scripts/e2e-crud-m52-55.mjs —— M52-M55 增改查补齐端到端
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const {
  createCpt, addDataset, addStyle, addFloatElement, addCell,
  addFillSubmit,
  setPageHeaderFooter, addSheet, addParameterWidget,
} = await import(pathToFileURL(path.join(here, '../lib/generate.js')).href);
const {
  updateReportNode, setReportListener, setWebWriteExtras,
  deleteCellHyperlink, deleteCellHighlight, getCellHighlight,
  deleteFillSubmit, deleteSheet, deleteStyle, deleteParameterWidget, deletePageHeaderFooter,
  addParameter, addFillBinding, addCellHighlight, addCellHyperlink,
} = await import(pathToFileURL(path.join(here, '../lib/edits.js')).href);
const { validateCpt } = await import(pathToFileURL(path.join(here, '../lib/validate.js')).href);
const { addChart } = await import(pathToFileURL(path.join(here, '../lib/engine/chart.js')).href);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-m52-55-'));
let pass = 0, fail = 0;
const check = (name, ok, extra = '') => { console.log(`  ${ok ? '✅' : '❌'} ${name}${extra ? ' — ' + extra : ''}`); if (ok) pass++; else fail++; };

// 公共 .cpt
const p = path.join(dir, 'a.cpt');
createCpt(p, { rows: 4, columns: 4, webWrite: true });
addDataset(p, { name: 'ds1', connection: 'Doris', sql: 'SELECT * FROM t1' });
addStyle(p, { fontSizePt: 14 });
addStyle(p, { fontSizePt: 16, bold: true });
addCell(p, { column: 0, row: 0, content: '标题' });
addCell(p, { column: 0, row: 1, content: '数据' });
addCell(p, { column: 1, row: 1, content: 'D1' });
addCell(p, { column: 0, row: 2, content: 'A' });
addCell(p, { column: 0, row: 3, content: 'B' });
addParameter(p, 'city');
addParameterWidget(p, { name: 'city', type: 'text' });
addFillSubmit(p, { dsName: 'dw_marketing', table: 't1' });
addFillBinding(p, 0, 'col0', 0, 1);
addCellHighlight(p, { column: 0, row: 1, formula: 'row() % 2 = 0', background: '#EEEEEE' });
addCell(p, { column: 1, row: 0, content: '链接' });
addCellHyperlink(p, { column: 1, row: 0, type: 'url', url: 'https://example.com', name: '外链' });
setPageHeaderFooter(p, { header: { left: { text: '机密' } }, footer: { center: { text: '页码1' } } });
addSheet(p, { sheetName: 'sheet2', rows: 2, columns: 2 });
addChart(p, { column: 2, row: 2, type: 'column', dsName: 'ds1', category: 'col0', values: [{ name: 'col0', agg: 'sum' }] });
addFloatElement(p, { content: '装饰', name: 'FloatA', leftMm: 5, topMm: 5, widthMm: 20, heightMm: 8 });

// === M52 报告级 ===

// ① update_report_node: 加自定义 ReportUI 节点
{
  const r = updateReportNode(p, { nodeName: 'ReportUI', xmlBody: '<O>自定义UI</O>', sheet: 0 });
  check('update_report_node 插入 ReportUI', r.action === 'update_report_node' && r.mode === 'upsert');
  check('ReportUI 已写入', fs.readFileSync(p, 'utf8').includes('<ReportUI>'));
  // 删除
  updateReportNode(p, { nodeName: 'ReportUI', sheet: 0 });
  check('update_report_node 删除 ReportUI', !fs.readFileSync(p, 'utf8').includes('<ReportUI>'));
}

// ② set_report_listener: 增/改/删
{
  const r = setReportListener(p, { event: 'onload', js: 'FR.Msg.alert("加载")', sheet: 0 });
  check('set_report_listener 加 onload', r.action?.includes('update_report_node') || fs.readFileSync(p, 'utf8').includes('<Listener event="onload">'));
  check('onload Listener 已写入', fs.readFileSync(p, 'utf8').includes('FR.Msg.alert("加载")'));
  // 删
  setReportListener(p, { event: 'onload', sheet: 0 });
  check('set_report_listener 删 onload', !fs.readFileSync(p, 'utf8').includes('event="onload"'));
}

// ③ set_webwrite_extras: 改 WebWrite 的 SheetPosition
{
  const r = setWebWriteExtras(p, { webWrite: { SheetPosition: '5' } });
  check('set_webwrite_extras 改 WebWrite', fs.readFileSync(p, 'utf8').includes('SheetPosition="5"'));
  // 传 null=删
  setWebWriteExtras(p, { showWidgets: null });
  check('set_webwrite_extras 删 ShowWidgets', !fs.readFileSync(p, 'utf8').includes('<ShowWidgets'));
}

// === M53 单元格补齐 ===

// ④ delete_cell_hyperlink
{
  const r = deleteCellHyperlink(p, 1, 0, { name: '外链' });
  check('delete_cell_hyperlink 删 name=外链', r.action === 'delete_cell_hyperlink');
  check('外链已删', !fs.readFileSync(p, 'utf8').includes('外链'));
}

// ⑤ delete_cell_highlight + ⑥ get_cell_highlight
{
  const r = deleteCellHighlight(p, 0, 1, { formula: 'row() % 2 = 0' });
  check('delete_cell_highlight 删指定 formula', r.action === 'delete_cell_highlight' && r.removed === 1);
  check('Highlight 块已删', !fs.readFileSync(p, 'utf8').includes('row() % 2 = 0'));
  // 清整组
  addCellHighlight(p, { column: 0, row: 1, formula: 'row() % 2 = 0', background: '#EEEEEE' });
  deleteCellHighlight(p, 0, 1);
  check('delete_cell_highlight 清整组', !fs.readFileSync(p, 'utf8').includes('<HighlightList>'));
  // get
  addCellHighlight(p, { column: 0, row: 1, formula: 'row() % 2 = 0', background: '#EEEEEE' });
  const g = getCellHighlight(p, 0, 1);
  check('get_cell_highlight 有 1 条', g.highlights.length === 1);
  check('get_cell_highlight formula 正确', g.highlights[0]?.formula === 'row() % 2 = 0');
}

// === M54 表格补齐 ===

// ⑦ delete_fill_submit
{
  const r = deleteFillSubmit(p, 0);
  check('delete_fill_submit 删 submitIndex=0', r.action === 'delete_fill_submit');
  check('SubmitVisitor 已删', !fs.readFileSync(p, 'utf8').includes('SubmitVisitor'));
}

// ⑧ delete_sheet
{
  const r = deleteSheet(p, 'sheet2');
  check('delete_sheet 删 sheet2', r.action === 'delete_sheet');
  check('sheet2 已删', !fs.readFileSync(p, 'utf8').includes('name="sheet2"'));
  // 最后 1 个不能删
  let threw = false;
  try { deleteSheet(p, 0); } catch { threw = true; }
  check('最后 1 个 sheet 不可删', threw);
}

// ⑨ delete_style
{
  // 重新加 chart 让 style 1 被引用（chart 默认 style 0 不算; chart 自身 style 0, fill 用 0）
  // 简化: 用 c="..." s="1" 引用样式 1（先在 (3,3) 加一个 cell style=1）
  addCell(p, { column: 3, row: 3, content: 'X', styleIndex: 1 });
  let threw = false;
  try { deleteStyle(p, 1); } catch { threw = true; }
  check('delete_style 被引抛错', threw);
  // 删除 cell 释放引用
  // 没有 delete_cell, 用 update_cell 占位 - 实际可用 set_cell_content_type 或简单点：直接 force 删
  const r = deleteStyle(p, 1, { force: true });
  check('delete_style force 强删', r.action === 'delete_style');
  check('force 删后样式 1 不在', !fs.readFileSync(p, 'utf8').includes('s="1"') || !fs.readFileSync(p, 'utf8').match(/<Style[^>]*index="1"/));
}

// === M55 面板/工具补齐 ===

// ⑩ delete_parameter_widget
{
  const r = deleteParameterWidget(p, 'city');
  check('delete_parameter_widget 删 city', r.action === 'delete_parameter_widget');
  check('city 控件已删', !fs.readFileSync(p, 'utf8').includes('name="city"') || !fs.readFileSync(p, 'utf8').match(/<InnerWidget[\s\S]*?name="city"/));
}

// ⑪ delete_page_header_footer
{
  const r = deletePageHeaderFooter(p, { which: 'header' });
  check('delete_page_header_footer 删 header', r.action === 'delete_page_header_footer' && r.removed > 0);
  check('Header 已删', !fs.readFileSync(p, 'utf8').includes('<Header>') && !fs.readFileSync(p, 'utf8').includes('<Header '));
  // 删 footer
  deletePageHeaderFooter(p, { which: 'footer' });
  check('footer 已删', !fs.readFileSync(p, 'utf8').includes('<Footer>') && !fs.readFileSync(p, 'utf8').includes('<Footer '));
}

// === 收尾 ===
const issues = validateCpt(p);
const err = issues.filter((i) => i.severity === 'error').length;
check('validate_cpt error=0 (11 工具收尾)', err === 0, `errors=${err}`);

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\nM52-M55 增改查补齐 e2e: ${pass} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);