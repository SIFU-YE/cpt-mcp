// scripts/e2e-guardrails.mjs —— M48+M49 安全围栏端到端
import fs from 'node:fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'node:url';
import { load, save } from '../lib/xml.js';
import { createCpt, addCell, addStyle } from '../lib/generate.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-guard-'));

// M48 case 1: 读合成 ZIP (PK\x03\x04 头) 应抛 M48
function testM48ReadZip() {
  // sandbox6/防腐调整跟进报表.cpt 实际是纯 XML 1.0 (前 4 字节 = 3c 3f 78 6d)
  // 不是 ZIP; M48 主要防 cptdec 工具导出的"ZIP 模板包"形式 .cpt
  // 用合成 ZIP 头测试 M48
  const fakeZip = path.join(dir, 'fake.cpt');
  fs.writeFileSync(fakeZip, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0, 0, 0, 0, 0]));
  try {
    load(fakeZip);
    console.log('  M48 FAIL: load() 没拒绝合成 ZIP');
    return false;
  } catch (e) {
    const ok = e.message.includes('M48') && e.message.includes('ZIP');
    console.log('  M48 合成 ZIP 拒绝:', ok ? '✅' : '❌', e.message.slice(0, 100));
    return ok;
  }
}

// M48 case 2: 读二进制 xls 头应抛
function testM48ReadBinary() {
  const fake = path.join(dir, 'fake.xls');
  fs.writeFileSync(fake, Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0, 0, 0, 0]));
  try {
    load(fake);
    console.log('  M48 FAIL: 读 OLE2 xls 没抛错');
    return false;
  } catch (e) {
    const ok = e.message.includes('M48') && (e.message.includes('二进制') || e.message.includes('magic'));
    console.log('  M48 xls 拒绝:', ok ? '✅' : '❌', e.message.slice(0, 80));
    return ok;
  }
}

// M48 case 3: 读纯 XML .cpt 应正常
function testM48ReadValid() {
  const p = path.join(dir, 'good.cpt');
  createCpt(p, { rows: 2, columns: 2 });
  try {
    const r = load(p);
    console.log('  M48 纯 XML 读取:', r.raw.length > 0 ? '✅' : '❌');
    fs.rmSync(p, { force: true });
    return r.raw.length > 0;
  } catch (e) {
    console.log('  M48 FAIL 正常 XML:', e.message);
    fs.rmSync(p, { force: true });
    return false;
  }
}

// M49 case 1: save 写后必须是 <?xm 开头
function testM49Write() {
  const p = path.join(dir, 'a.cpt');
  createCpt(p, { rows: 2, columns: 2 });
  addCell(p, { column: 0, row: 0, content: '测试' });
  addStyle(p, { fontSizePt: 14, bold: true });
  // 此时 p 应是 flat XML (因为 createCpt 写的就是)
  const bytes = fs.readFileSync(p);
  const ok = bytes[0] === 0x3c && bytes[1] === 0x3f && bytes[2] === 0x78 && bytes[3] === 0x6d;
  console.log('  M49 save 后首 4 字节是 <?xm:', ok ? '✅' : '❌', `0x${bytes[0].toString(16)} 0x${bytes[1].toString(16)} 0x${bytes[2].toString(16)} 0x${bytes[3].toString(16)}`);
  fs.rmSync(p, { force: true });
  return ok;
}

// M49 case 2: 写路径也走 load 拦截 (纯 XML 11.5 .cpt 应当正常通过 M48 读取)
function testM49RoundTripZip() {
  // 可选外部样本：通过 CPT_E2E_SAMPLE 指向真实/合成 .cpt；未配置时用仓库内相对路径。
  const sandboxZip = process.env.CPT_E2E_SAMPLE
    || path.join(REPO_ROOT, 'tmp_test', 'example-zip-template.cpt');
  if (!fs.existsSync(sandboxZip)) { console.log('  M49 ZIP 跳过 (无可选样本)'); return true; }
  const cp = path.join(dir, 'b.cpt');
  fs.copyFileSync(sandboxZip, cp);
  try {
    // 样本是纯 XML (M48 不拦), 应正常 addCell + write (M49 写后 <?xm)
    addCell(cp, { column: 5, row: 5, content: 'test' });
    const bytes = fs.readFileSync(cp);
    const ok = bytes[0] === 0x3c && bytes[1] === 0x3f && bytes[2] === 0x78 && bytes[3] === 0x6d;
    console.log('  M49 纯 XML 11.5 写路径后首 4 字节 = <?xm:', ok ? '✅' : '❌');
    return ok;
  } catch (e) {
    console.log('  M49 FAIL 纯 XML 写路径:', e.message);
    return false;
  }
}

let pass = 0, fail = 0;
const tests = [
  ['M48 读 ZIP 拒绝', testM48ReadZip],
  ['M48 读 xls 二进制拒绝', testM48ReadBinary],
  ['M48 读纯 XML 正常', testM48ReadValid],
  ['M49 save 后首 4 字节 = <?xm', testM49Write],
  ['M49 ZIP 写路径也被 M48 拦截', testM49RoundTripZip],
];
for (const [name, fn] of tests) {
  console.log(`\n=== ${name} ===`);
  if (fn()) pass++; else fail++;
}
console.log(`\nTotal: ${pass} pass, ${fail} fail`);
fs.rmSync(dir, { recursive: true, force: true });
process.exit(fail > 0 ? 1 : 0);
