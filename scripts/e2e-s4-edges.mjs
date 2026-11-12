// scripts/e2e-s4-edges.mjs —— S4 扩展边界: 空名 / 缺 name / 同名抛错
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { buildReport } from '../lib/engine/builder.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-s4-'));
const cases = [
  {
    name: 'A: sheets[0] 没 name 字段, sheetName="X" (用 sheetName 兜底)',
    spec: { sheetName: 'X', sheets: [{}, { name: 'Y' }] },
    expect: ['X', 'Y'],
  },
  {
    name: 'B: sheets[0] 没 name 字段 (用默认 sheetName)',
    spec: { sheets: [{}, { name: '明细' }] },
    expect: ['sheet1', '明细'],
  },
  {
    name: 'C: sheets 长度 1 (走 createCpt 路径)',
    spec: { sheets: [{ name: '唯一' }] },
    expect: ['唯一'],
  },
  {
    name: 'D: sheets[0].name 和 sheetName 都给 (sheets 优先)',
    spec: { sheetName: 'should_not_use', sheets: [{ name: '实际用' }] },
    expect: ['实际用'],
  },
  {
    name: 'E: 名字重复 sheets=[A, A] (应抛错)',
    spec: { sheets: [{ name: 'A' }, { name: 'A' }] },
    expectError: /重复 \(sheets 内 sheet 名必须唯一/,
  },
  {
    name: 'F: sheets[0] 名字 和 sheetName 一样 (不重命名)',
    spec: { sheetName: 'X', sheets: [{ name: 'X' }, { name: 'Y' }] },
    expect: ['X', 'Y'],
  },
  {
    name: 'G: sheets=[A, a] 大小写不同 (不视为重复, 大小写敏感)',
    spec: { sheets: [{ name: 'A' }, { name: 'a' }] },
    expect: ['A', 'a'],
  },
  {
    name: 'H: 3 个 sheet, 第 3 与主 sheet 重复 (effectiveSheetName=sheets[0].name, 错误信息指主 sheet)',
    spec: { sheets: [{ name: 'A' }, { name: 'B' }, { name: 'A' }] },
    expectError: /下标 2 名字 "A" 与 (主 sheet|sheets\[0\]) 重复/,
  },
  {
    name: 'I: sheets[1].name 是 object (应抛类型错, 不产生 [object Object] sheet 名)',
    spec: { sheets: [{ name: 'A' }, { name: { foo: 'bar' } }] },
    expectError: /sheets\[1\]\.name 类型非法/,
  },
  {
    name: 'J: sheets[1].name 是数字 42 (转字符串 "42", 正常)',
    spec: { sheets: [{ name: 'A' }, { name: 42 }] },
    expect: ['A', '42'],
  },
  {
    name: 'K: sheets[1].name 是布尔 true (转字符串 "true", 正常)',
    spec: { sheets: [{ name: 'A' }, { name: true }] },
    expect: ['A', 'true'],
  },
  {
    name: 'L: sheets[1].name 是 NaN (应抛 NaN 错, 不写入 "NaN" sheet)',
    spec: { sheets: [{ name: 'A' }, { name: NaN }] },
    expectError: /不接受 NaN\/Infinity/,
  },
  {
    name: 'M: sheets[1].name 是 Infinity (应抛 NaN 错)',
    spec: { sheets: [{ name: 'A' }, { name: Infinity }] },
    expectError: /不接受 NaN\/Infinity/,
  },
  {
    name: 'N: sheets=[{name:"sheet2"}, {name: "sheet2"}] 重复名 (抛错)',
    spec: { sheets: [{ name: 'sheet2' }, { name: 'sheet2' }] },
    expectError: /下标 1 名字 "sheet2" 与 主 sheet 重复/,
  },
];

let pass = 0, fail = 0;
for (const tc of cases) {
  const p = path.join(dir, 'x.cpt');
  if (fs.existsSync(p)) fs.rmSync(p, { force: true });
  try {
    const r = buildReport({ path: p, ...tc.spec, rows: 2, columns: 2 });
    if (tc.expectError) {
      console.log(`  [FAIL] ${tc.name}: expected throw, got OK`);
      fail++;
      continue;
    }
    // 读 sheet names 用 .cpt XML
    const raw = fs.readFileSync(p, 'utf8');
    const names = [...raw.matchAll(/<Report [^>]*name="([^"]+)"/g)].map((m) => m[1]);
    const ok = JSON.stringify(names) === JSON.stringify(tc.expect);
    console.log(`  [${ok ? 'OK ' : 'FAIL'}] ${tc.name}: ${JSON.stringify(names)} ${ok ? '==' : '!='} ${JSON.stringify(tc.expect)}`);
    ok ? pass++ : fail++;
  } catch (e) {
    if (tc.expectError && tc.expectError.test(e.message)) {
      console.log(`  [OK ] ${tc.name}: throw "${e.message.slice(0, 60)}"`);
      pass++;
    } else {
      console.log(`  [FAIL] ${tc.name}: unexpected throw: ${e.message}`);
      fail++;
    }
  } finally {
    try { fs.rmSync(p, { force: true }); } catch { /* ignore */ }
  }
}
fs.rmSync(dir, { recursive: true, force: true });
console.log('');
console.log(`Total: ${pass} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
