// scripts/audit-sync.mjs —— 一键审计桌面 vs 全局 SHA1
// 跑法: cd 桌面目录 && node scripts/audit-sync.mjs
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const globalRoot = path.join(process.env.APPDATA || '', 'reasonix', 'mcp-servers', 'cpt-mcp');

function sha1(p) {
  try { return crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex').slice(0, 8); }
  catch { return null; }
}

const list = spawnSync('node', [path.join(__dirname, 'sync-manifest.mjs')], { encoding: 'utf8' }).stdout.trim().split(/\r?\n/);
let diff = 0, onlyDesktop = 0, onlyGlobal = 0;
for (const f of list) {
  const a = path.join(root, f);
  const b = path.join(globalRoot, f);
  const sa = sha1(a);
  const sb = sha1(b);
  if (sa && !sb) { onlyDesktop++; console.log('  ONLY-DESKTOP:', f, sa); }
  else if (!sa && sb) { onlyGlobal++; console.log('  ONLY-GLOBAL:', f, sb); }
  else if (sa !== sb) { diff++; console.log('  DIFF:        ', f, sa, '!=', sb); }
}
console.log('');
console.log('Files checked:', list.length);
console.log('Diff        :', diff);
console.log('Only desktop:', onlyDesktop);
console.log('Only global :', onlyGlobal);
if (diff === 0 && onlyDesktop === 0 && onlyGlobal === 0) {
  console.log('AUDIT PASS: desktop and global are byte-identical');
  process.exit(0);
} else {
  console.log('AUDIT FAIL: see diffs above');
  process.exit(1);
}
