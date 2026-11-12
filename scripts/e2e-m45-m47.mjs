// scripts/e2e-m45-m47.mjs —— 端到端测试 M45 (TableDataMap 容错) + M47 (setCellContentType)
import fs from 'node:fs';
import path from 'path';
import os from 'os';
import { createCpt, addDataset, addStyle, addCell } from '../lib/generate.js';
import { setCellContentType } from '../lib/edits.js';
import { overview, cells } from '../lib/cpt.js';
import { validateCpt } from '../lib/validate.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-m45m47-'));

// M45 case: 自闭合 TableDataMap 写 dataset
async function testM45() {
  const p = path.join(dir, 'a.cpt');
  // 手工建一个自闭合 TableDataMap 的 .cpt
  fs.writeFileSync(p, `<?xml version="1.0" encoding="UTF-8"?>
<WorkBook xmlVersion="20211223" releaseVersion="11.5.0">
<TableDataMap/>
<Report class="com.fr.report.worksheet.WorkSheet" name="sheet1">
<ReportPageAttr><HR/><FR/><HC/><FC/></ReportPageAttr>
<ColumnPrivilegeControl/>
<RowPrivilegeControl/>
<RowHeight defaultValue="723900"><![CDATA[723900]]></RowHeight>
<ColumnWidth defaultValue="2743200"><![CDATA[2743200]]></ColumnWidth>
<CellElementList/>
<ReportAttrSet><ReportSettings headerHeight="0" footerHeight="0"><PaperSetting/></ReportSettings></ReportAttrSet>
<ReportWebAttr/>
</Report>
<StyleList><Style horizontal_alignment="0" imageLayout="1"><FRFont name="SimSun" style="0" size="72"/><Background name="NullBackground"/><Border/></Style></StyleList>
<DesignerVersion DesignerVersion="LAA"/>
<PreviewType PreviewType="0"/>
</WorkBook>
`, 'utf8');

  // 现在 add_dataset
  try {
    addDataset(p, { name: 'ds1', connection: 'Doris', sql: 'SELECT 1' });
    console.log('  M45: add_dataset 成功 (自闭合 TableDataMap 已支持)');
  } catch (e) {
    console.log('  M45 FAIL:', e.message);
    fs.rmSync(p, { force: true });
    return false;
  }
  const issues = validateCpt(p);
  const err = issues.filter((i) => i.severity === 'error').length;
  console.log('  M45: validate_cpt error count =', err);
  fs.rmSync(p, { force: true });
  return err === 0;
}

// M47 case: 空白 cell → DSColumn
function testM47() {
  const p = path.join(dir, 'b.cpt');
  try { fs.rmSync(p, { force: true }); } catch { /* ignore */ }
  createCpt(p, { rows: 2, columns: 2 });
  addDataset(p, { name: 'ds1', connection: 'Doris', sql: 'SELECT 1' });
  addCell(p, { column: 0, row: 1, content: 'placeholder' });

  // 改造成 DSColumn
  try {
    setCellContentType(p, { column: 0, row: 1, contentType: 'dsColumn', dsName: 'ds1', columnName: 'col1' });
    console.log('  M47: setCellContentType(dsColumn) 成功');
  } catch (e) {
    console.log('  M47 FAIL:', e.message);
    fs.rmSync(p, { force: true });
    return false;
  }

  // 验证 XML
  const xml = fs.readFileSync(p, 'utf8');
  const hasDsColumn = xml.includes('t="DSColumn"') && xml.includes('dsName="ds1"') && xml.includes('columnName="col1"');
  console.log('  M47: XML 含 DSColumn 节点 =', hasDsColumn);
  fs.rmSync(p, { force: true });
  return hasDsColumn;
}

// M47 case 2: 改造成 formula
function testM47Formula() {
  const p = path.join(dir, 'c.cpt');
  try { fs.rmSync(p, { force: true }); } catch { /* ignore */ }
  createCpt(p, { rows: 2, columns: 2 });
  addCell(p, { column: 0, row: 1, content: 'temp' });
  try {
    setCellContentType(p, { column: 0, row: 1, contentType: 'formula', formula: 'SUM(A1:A10)' });
    const xml = fs.readFileSync(p, 'utf8');
    const ok = xml.includes('class="com.fr.base.Formula"') && xml.includes('=SUM(A1:A10)');
    console.log('  M47 formula: ', ok);
    fs.rmSync(p, { force: true });
    return ok;
  } catch (e) {
    console.log('  M47 formula FAIL:', e.message);
    fs.rmSync(p, { force: true });
    return false;
  }
}

// M47 case 3: 已有 DSColumn 的 cell 不能改 (抛错)
function testM47DoubleSet() {
  const p = path.join(dir, 'd.cpt');
  try { fs.rmSync(p, { force: true }); } catch { /* ignore */ }
  createCpt(p, { rows: 2, columns: 2 });
  addDataset(p, { name: 'ds1', connection: 'Doris', sql: 'SELECT 1' });
  addCell(p, { column: 0, row: 1, content: 'placeholder' });
  setCellContentType(p, { column: 0, row: 1, contentType: 'dsColumn', dsName: 'ds1', columnName: 'col1' });
  try {
    setCellContentType(p, { column: 0, row: 1, contentType: 'formula', formula: 'SUM(A1)' });
    console.log('  M47 已有 DSColumn 再设: 预期抛错, 实际未抛');
    fs.rmSync(p, { force: true });
    return false;
  } catch (e) {
    console.log('  M47 已有 DSColumn 再设: 正确抛错:', e.message.slice(0, 60));
    fs.rmSync(p, { force: true });
    return true;
  }
}

let pass = 0, fail = 0;
const tests = [
  ['M45 自闭合 TableDataMap', testM45],
  ['M47 改造成 DSColumn', testM47],
  ['M47 改造成 formula', testM47Formula],
  ['M47 已有对象内容时抛错', testM47DoubleSet],
];
for (const [name, fn] of tests) {
  console.log(`\n=== ${name} ===`);
  if (fn()) pass++; else fail++;
}
console.log(`\nTotal: ${pass} pass, ${fail} fail`);
fs.rmSync(dir, { recursive: true, force: true });
process.exit(fail > 0 ? 1 : 0);
