// scripts/verify-cpt-readable.mjs —— 验证 cpt-mcp 生成的 .cpt 能被标准 SDK 解析
// 用 fast-xml-parser (cpt-mcp 自身用) 读, 打印关键节点
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { XMLParser } from 'fast-xml-parser';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CPT = path.join(__dirname, '..', 'tmp_test', 'e2e-销售汇总.cpt');

if (!fs.existsSync(CPT)) {
  console.error('NOT FOUND:', CPT);
  process.exit(1);
}

const raw = fs.readFileSync(CPT, 'utf8');
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  cdataPropName: '__cdata',
  textNodeName: '#text',
  trimValues: false,
  parseTagValue: false,
  parseAttributeValue: false,
  commentPropName: '__comment',
  processEntities: false,
});
const parsed = parser.parse(raw);

const wb = parsed.WorkBook;
const checks = [];

// 1) XML 版本
checks.push(['xmlVersion',   wb['@_xmlVersion'] === '20211223', wb['@_xmlVersion']]);
checks.push(['releaseVersion', wb['@_releaseVersion'] === '11.5.0', wb['@_releaseVersion']]);

// 2) Report 块
const report = Array.isArray(wb.Report) ? wb.Report[0] : wb.Report;
checks.push(['Report class',  report['@_class'] === 'com.fr.report.worksheet.WorkSheet', report['@_class']]);
checks.push(['Report name',    report['@_name'] === 'sheet1', report['@_name']]);

// 3) WorkBook 顶层
checks.push(['WorkBook',      !!wb, !!wb]);
checks.push(['TableDataMap',  !!wb.TableDataMap, !!wb.TableDataMap]);
checks.push(['StyleList',     !!wb.StyleList, !!wb.StyleList]);
checks.push(['Style count',   Array.isArray(wb.StyleList?.Style) ? wb.StyleList.Style.length === 7 : false, wb.StyleList?.Style?.length]);

// 4) 数据集
const td = wb.TableDataMap?.TableData;
checks.push(['TableData name', td?.['@_name'] === 'ds_sales', td?.['@_name']]);
checks.push(['TableData class', td?.['@_class'] === 'com.fr.data.impl.DBTableData', td?.['@_class']]);
checks.push(['Connection name', td?.Connection?.DatabaseName?.__cdata === 'Doris', td?.Connection?.DatabaseName?.__cdata]);
checks.push(['Query SQL not empty', !!td?.Query?.__cdata && td.Query.__cdata.length > 10, td?.Query?.__cdata?.slice(0, 30)]);

// 5) ReportWriteAttr (填报)
const rwa = report.ReportWriteAttr;
checks.push(['ReportWriteAttr',  !!rwa, !!rwa]);
checks.push(['SubmitVisitor class', rwa?.SubmitVisitor?.['@_class'] === 'com.fr.report.write.BuiltInSQLSubmiter', rwa?.SubmitVisitor?.['@_class']]);
const cols = rwa?.SubmitVisitor?.DMLConfig?.ColumnConfig;
const colCount = Array.isArray(cols) ? cols.length : (cols ? 1 : 0);
checks.push(['ColumnConfig count', colCount === 5, colCount]);

// 6) 单元格
const cells = report.CellElementList?.C;
const cellArr = Array.isArray(cells) ? cells : (cells ? [cells] : []);
checks.push(['Cell count',       cellArr.length === 12, cellArr.length]);
// 检查表头"大区"在 (0,0)
const c00 = cellArr.find((c) => c['@_c'] === '0' && c['@_r'] === '0');
const c00Text = c00?.O?.__cdata || (typeof c00?.O === 'string' ? c00.O : '');
checks.push(['Cell (0,0) = "大区"', c00Text === '大区', c00Text]);
// 检查 DSColumn 在 (0,1)
const c01 = cellArr.find((c) => c['@_c'] === '0' && c['@_r'] === '1');
checks.push(['Cell (0,1) DSColumn', c01?.O?.['@_t'] === 'DSColumn' && c01?.O?.Attributes?.['@_dsName'] === 'ds_sales', c01?.O?.['@_t']]);
// 检查 submit widget
const c14 = cellArr.find((c) => c['@_c'] === '4' && c['@_r'] === '1');
checks.push(['Cell (4,1) submit widget', c14?.Widget?.['@_class'] === 'com.fr.report.web.button.write.Submit', c14?.Widget?.['@_class']]);

// 7) ReportParameterAttr
const rpa = parsed.WorkBook?.ReportParameterAttr;
checks.push(['ReportParameterAttr',  !!rpa, !!rpa]);
checks.push(['Parameter widget count', Array.isArray(rpa?.ParameterUI?.Layout?.Widget) ? rpa.ParameterUI.Layout.Widget.length === 1 : !!rpa?.ParameterUI?.Layout?.Widget, '?']);

// 8) ReportWebAttr (P1 修复)
const rwa2 = parsed.WorkBook?.ReportWebAttr;
checks.push(['ReportWebAttr',        !!rwa2, !!rwa2]);
checks.push(['WebWriteContent',      !!rwa2?.WebWriteContent, !!rwa2?.WebWriteContent]);
checks.push(['WebWrite SheetPosition', rwa2?.WebWriteContent?.WebWrite?.['@_SheetPosition'] === '3', rwa2?.WebWriteContent?.WebWrite?.['@_SheetPosition']]);

// 9) ElementCaseMobileAttr (P1 修复)
checks.push(['ElementCaseMobileAttr', !!parsed.WorkBook?.ElementCaseMobileAttr, !!parsed.WorkBook?.ElementCaseMobileAttr]);

// 报告
let pass = 0, fail = 0;
for (const [name, ok, val] of checks) {
  const mark = ok ? 'OK ' : 'FAIL';
  console.log(`  [${mark}] ${name.padEnd(28)} = ${JSON.stringify(val)}`);
  ok ? pass++ : fail++;
}
console.log('');
console.log(`Total: ${pass} pass, ${fail} fail (of ${checks.length} checks)`);
process.exit(fail > 0 ? 1 : 0);
