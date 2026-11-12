// scripts/e2e-sheet-binding.mjs —— A 复核: add_fill_binding/update/delete 的 sheet 参数
// 场景: 双 sheet 报表, 每个 sheet 各一个 SubmitVisitor, 验证 sheet 限定绑定只落在该表
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const { createCpt, addSheet, addFillSubmit } = await import(pathToFileURL(path.join(here, '../lib/generate.js')).href);
const { addFillBinding, updateFillBinding, deleteFillBinding } = await import(pathToFileURL(path.join(here, '../lib/edits.js')).href);
const { validateCpt } = await import(pathToFileURL(path.join(here, '../lib/validate.js')).href);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-sheetbind-'));
const p = path.join(dir, 'multi.cpt');

let pass = 0, fail = 0;
function check(name, ok, extra = '') {
  console.log(`  ${ok ? '✅' : '❌'} ${name}${extra ? ' — ' + extra : ''}`);
  if (ok) pass++; else fail++;
}

// 双 sheet 报表
createCpt(p, { rows: 3, columns: 4 });
addSheet(p, { sheetName: 'sheet2', rows: 3, columns: 4 });
// 每个 sheet 各自建一个提交（绑定不同表）
addFillSubmit(p, { dsName: 'dw_marketing', table: 't_special', name: '特殊提交', sheet: 0 });
addFillSubmit(p, { dsName: 'dw_marketing', table: 't_normal', name: '常规提交', sheet: 1 });

// 1) 不传 sheet（向后兼容：全工作簿顺序定位）：第 1 个 SubmitVisitor = sheet0 的
addFillBinding(p, 0, 'col_special', 0, 1);
let xml = fs.readFileSync(p, 'utf8');
let sheet0Has = xml.includes('name="col_special"');
check('不传 sheet 绑定落在第 1 个工作表', sheet0Has);

// 2) 传 sheet=1 绑定第 2 个工作表的提交
addFillBinding(p, 0, 'col_normal', 1, 1, false, 1);
xml = fs.readFileSync(p, 'utf8');
// col_normal 应出现在 sheet2 的 Report 块内（sheet2 提交表格段）, col_special 在 sheet1 段
const sheet1Block = xml.indexOf('name="sheet1"');
const sheet2Block = xml.indexOf('name="sheet2"');
const colNormalPos = xml.indexOf('name="col_normal"');
const colSpecialPos = xml.indexOf('name="col_special"');
check('sheet=1 绑定 col_normal 落在第 2 个工作表内', colNormalPos > sheet2Block, `pos=${colNormalPos} sheet2=${sheet2Block}`);
check('col_special 仍在第 1 个工作表', colSpecialPos < sheet2Block, `pos=${colSpecialPos}`);

// 3) update_fill_binding 带 sheet 改名/移坐标
updateFillBinding(p, 0, 'col_normal', { newField: 'col_normal2', column: 2, row: 2 }, 1);
xml = fs.readFileSync(p, 'utf8');
check('update sheet=1 改名生效', xml.includes('name="col_normal2"') && !xml.includes('name="col_normal"'), '');
check('update sheet=1 坐标生效', xml.includes('column="2"') && xml.includes('<ColumnRow column="2" row="2"/>'), '');

// 4) 越界: sheet=1 传 submitIndex=1（该表只有 1 个提交）应抛错
let threw = false;
try { addFillBinding(p, 1, 'col_oops', 0, 0, false, 1); } catch { threw = true; }
check('sheet=1 submitIndex=1 越界抛错（不再穿透到别的 sheet）', threw);

// 5) delete_fill_binding 带 sheet
deleteFillBinding(p, 0, 'col_normal2', 1);
xml = fs.readFileSync(p, 'utf8');
check('delete sheet=1 删除 col_normal2', !xml.includes('col_normal2') && xml.includes('col_special'), '');

// 6) validate 无 error
const issues = validateCpt(p);
const err = issues.filter((i) => i.severity === 'error').length;
check('validate_cpt error=0', err === 0, `errors=${err}`);

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\nA 复核: ${pass} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);