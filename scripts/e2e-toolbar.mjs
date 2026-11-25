// scripts/e2e-toolbar.mjs —— C 复核: set_fill_toolbar 填报工具栏增量
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const { createCpt, buildReport, addSheet } = await import(pathToFileURL(path.join(here, '../lib/generate.js')).href);
const { setFillToolbar } = await import(pathToFileURL(path.join(here, '../lib/edits.js')).href);
const { validateCpt } = await import(pathToFileURL(path.join(here, '../lib/validate.js')).href);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-toolbar-'));
let pass = 0, fail = 0;
function check(name, ok, extra = '') {
  console.log(`  ${ok ? '✅' : '❌'} ${name}${extra ? ' — ' + extra : ''}`);
  if (ok) pass++; else fail++;
}

// 1) create_cpt(webWrite=true) 已有 WebWriteContent → 添加工具栏
{
  const p = path.join(dir, 'a.cpt');
  createCpt(p, { rows: 3, columns: 4, webWrite: true });
  setFillToolbar(p, {}); // 缺省四按钮
  const xml = fs.readFileSync(p, 'utf8');
  check('缺省 buttons 生成四按钮', ['Submit', 'Verify', 'AppendColumnRow', 'DeleteColumnRow'].every((c) => xml.includes(c)), '');
  check('位于 WebWriteContent 内', (xml.indexOf('<ToolBars>') > xml.indexOf('<WebWriteContent>')) && (xml.indexOf('</ToolBars>') < xml.indexOf('</WebWriteContent>')), '');
  check('含官方结构 ToolBarManager/Location/Embed', xml.includes('<ToolBarManager>') && xml.includes('<Embed position="1"/>'), '');
  const err = validateCpt(p).filter((i) => i.severity === 'error').length;
  check('validate error=0', err === 0, `errors=${err}`);
  fs.rmSync(p, { force: true });
}

// 2) 自定义按钮（只 submit + verify）→ 替换
{
  const p = path.join(dir, 'b.cpt');
  createCpt(p, { rows: 3, columns: 4, webWrite: true });
  setFillToolbar(p, { buttons: ['submit', 'verify'] });
  let xml = fs.readFileSync(p, 'utf8');
  check('自定义 [submit,verify] 生效', xml.includes('Submit') && xml.includes('Verify') && !xml.includes('AppendColumnRow'), '');
  // 再替换成 append-row 单独 → 无 Submit
  setFillToolbar(p, { buttons: 'append-row' });
  xml = fs.readFileSync(p, 'utf8');
  check('单按钮字符串替换（append-row）', xml.includes('AppendColumnRow') && !xml.includes('Submit'), '');
  const err = validateCpt(p).filter((i) => i.severity === 'error').length;
  check('valided error=0 (替换后)', err === 0, `errors=${err}`);
  fs.rmSync(p, { force: true });
}

// 3) 未知按钮抛错 + 非填报模板抛错
{
  const p = path.join(dir, 'c.cpt');
  createCpt(p, { rows: 2, columns: 2 }); // webWrite 缺省 false → 无 WebWriteContent
  let threw = false;
  try { setFillToolbar(p, { buttons: ['submit'] }); } catch (e) { threw = e.message.includes('WebWriteContent'); }
  check('非填报模板（无 WebWriteContent）抛错', threw);
  const p2 = path.join(dir, 'd.cpt');
  createCpt(p2, { rows: 2, columns: 2, webWrite: true });
  threw = false;
  try { setFillToolbar(p2, { buttons: ['nonsense'] }); } catch { threw = true; }
  check('未知按钮抛错', threw);
  fs.rmSync(p, { force: true }); fs.rmSync(p2, { force: true });
}

// 4) 双 sheet 场景：add_sheet 后工具栏仍模板级（一次设置全 sheet 生效）
{
  const p = path.join(dir, 'e.cpt');
  createCpt(p, { rows: 2, columns: 3, webWrite: true });
  addSheet(p, { sheetName: 'sheet2', rows: 2, columns: 3 });
  setFillToolbar(p, { buttons: ['submit', 'delete-row'] });
  const xml = fs.readFileSync(p, 'utf8');
  const wwc = xml.indexOf('<WebWriteContent>');
  const sheet2 = xml.indexOf('name="sheet2"');
  const tools = xml.indexOf('<ToolBars>');
  check('双 sheet 下工具栏仍在模板级（WebWriteContent 内）', tools > wwc && tools < xml.indexOf('name="sheet1"') < 0 || (tools > wwc && tools < sheet2), `tools=${tools} wwc=${wwc} sheet1=${xml.indexOf('name="sheet1"')} sheet2=${sheet2}`);
  const err = validateCpt(p).filter((i) => i.severity === 'error').length;
  check('validate error=0 (双 sheet)', err === 0, `errors=${err}`);
  fs.rmSync(p, { force: true });
}

// 5) S15-1: 自闭合 <WebWriteContent/> 展开
{
  const p = path.join(dir, 'f.cpt');
  createCpt(p, { rows: 2, columns: 2, webWrite: true });
  let xml = fs.readFileSync(p, 'utf8');
  const st = xml.indexOf('<WebWriteContent>');
  const en = xml.indexOf('</WebWriteContent>') + '</WebWriteContent>'.length;
  xml = xml.slice(0, st) + '<WebWriteContent/>' + xml.slice(en);
  fs.writeFileSync(p, xml, 'utf8');
  setFillToolbar(p, { buttons: ['submit'] });
  const after = fs.readFileSync(p, 'utf8');
  check('自闭合 <WebWriteContent/> 展开为完整块 + ToolBars', after.includes('<WebWriteContent>') && after.includes('</WebWriteContent>') && after.includes('Submit') && (after.match(/<WebWriteContent/g) || []).length === 1, '');
  const err = validateCpt(p).filter((i) => i.severity === 'error').length;
  check('validate error=0 (自闭合展开)', err === 0, `errors=${err}`);
  fs.rmSync(p, { force: true });
}

// 6) S15-1: 带属性 <ToolBars foo="1"> 替换
{
  const p = path.join(dir, 'g.cpt');
  createCpt(p, { rows: 2, columns: 2, webWrite: true });
  let xml = fs.readFileSync(p, 'utf8');
  // createCpt 产物 ToolBars 是自闭合 <ToolBars/> → 先展开为带属性开闭对构造合法测试输入
  // 注意: 模板有两处 ToolBars(WebPageContent 前部 + WebWriteContent 后部), 属性要加到 WebWriteContent 块内的那个(最后的)
  const tbSelf = xml.lastIndexOf('<ToolBars/>');
  if (tbSelf >= 0) {
    xml = xml.slice(0, tbSelf) + '<ToolBars foo="1">\n</ToolBars>' + xml.slice(tbSelf + '<ToolBars/>'.length);
  } else {
    const st = xml.lastIndexOf('<ToolBars>');
    const en = xml.indexOf('</ToolBars>', st) + '</ToolBars>'.length;
    xml = xml.slice(0, st) + '<ToolBars foo="1">' + xml.slice(st + '<ToolBars>'.length, en - '</ToolBars>'.length) + '</ToolBars>' + xml.slice(en);
  }
  fs.writeFileSync(p, xml, 'utf8');
  setFillToolbar(p, { buttons: ['verify'] });
  const after = fs.readFileSync(p, 'utf8');
  // 模板本身有两处 ToolBars（WebPageContent + WebWriteContent），断言限定在 WebWriteContent 块内
  const wwcS = after.indexOf('<WebWriteContent');
  const wwcE = after.indexOf('</WebWriteContent>', wwcS);
  const wwcSeg2 = after.slice(wwcS, wwcE);
  check('带属性 <ToolBars foo="1"> 被替换（无重复）', after.includes('Verify') && !after.includes('foo="1"') && (wwcSeg2.match(/<ToolBars/g) || []).length === 1, `wwc内 count=${(wwcSeg2.match(/<ToolBars/g) || []).length}`);
  const err = validateCpt(p).filter((i) => i.severity === 'error').length;
  check('validate error=0 (带属性替换)', err === 0, `errors=${err}`);
  fs.rmSync(p, { force: true });
}

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\nC 复核: ${pass} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);