// scripts/e2e-frozen.mjs —— B 复核: set_report_settings 冻结行列 (frozenColumn/frozenRow)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const { createCpt, setReportSettings } = await import(pathToFileURL(path.join(here, '../lib/generate.js')).href);
const { locateSheet } = await import(pathToFileURL(path.join(here, '../lib/xml.js')).href);
const { validateCpt } = await import(pathToFileURL(path.join(here, '../lib/validate.js')).href);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-frozen-'));
const p = path.join(dir, 'f.cpt');
let pass = 0, fail = 0;
function check(name, ok, extra = '') {
  console.log(`  ${ok ? '✅' : '❌'} ${name}${extra ? ' — ' + extra : ''}`);
  if (ok) pass++; else fail++;
}

createCpt(p, { rows: 3, columns: 4 });

// 1) 设置冻结 4 列 8 行 → columnrow="D8"（对齐官方样本）
setReportSettings(p, { frozenColumn: 4, frozenRow: 8 });
let xml = fs.readFileSync(p, 'utf8');
let rsSeg = null;
{
  const b = locateSheet(xml, 0);
  const rsS = xml.indexOf('<ReportSettings', b.start);
  const rsE = xml.indexOf('</ReportSettings>', rsS);
  rsSeg = xml.slice(rsS, rsE);
}
const hasD8 = rsSeg.includes('<FrozenColumnRow columnrow="D8"/>');
const inPaperBefore = rsSeg.indexOf('<FrozenColumnRow') > -1 && rsSeg.indexOf('<FrozenColumnRow') < rsSeg.indexOf('<PaperSetting');
check('frozenColumn=4 frozenRow=8 → <FrozenColumnRow columnrow="D8"/>', hasD8);
check('FrozenColumnRow 在 PaperSetting 之前（官方结构）', inPaperBefore);

// 2) 覆盖修改 → columnrow="B3"
setReportSettings(p, { frozenColumn: 2, frozenRow: 3 });
xml = fs.readFileSync(p, 'utf8');
check('覆盖更新 → B3（无重复节点）', xml.includes('columnrow="B3"') && !xml.includes('columnrow="D8"') && (xml.match(/FrozenColumnRow/g) || []).length === 1, `count=${(xml.match(/FrozenColumnRow/g) || []).length}`);

// 3) 清除（都传 0）→ 无 FrozenColumnRow
setReportSettings(p, { frozenColumn: 0, frozenRow: 0 });
xml = fs.readFileSync(p, 'utf8');
check('都传 0 清除冻结节点', !xml.includes('FrozenColumnRow'));

// 4) 只冻结行（frozenRow=3, column 缺省 → 不冻结列 → "A3"）
setReportSettings(p, { frozenRow: 3 });
xml = fs.readFileSync(p, 'utf8');
check('只冻结 3 行 → columnrow="A3"', xml.includes('columnrow="A3"'));

// 5) 只冻结列（frozenColumn=2, row 缺省 → "B1"）
setReportSettings(p, { frozenColumn: 2 });
xml = fs.readFileSync(p, 'utf8');
check('只冻结 2 列 → columnrow="B1"', xml.includes('columnrow="B1"'));

// 6) 非法值抛错
let threw = false;
try { setReportSettings(p, { frozenColumn: -1 }); } catch { threw = true; }
check('frozenColumn=-1 抛错', threw);

// 7) validate error=0
const issues = validateCpt(p);
check('validate_cpt error=0', issues.filter((i) => i.severity === 'error').length === 0);

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\nB 复核: ${pass} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);