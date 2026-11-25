// cpt-mcp/scripts/check-tmp-clean.mjs —— 一键检查 tmp_test 目录是否已清理
// 跑法: cd 桌面目录 && node scripts/check-tmp-clean.mjs
// exit 0 = 都已清理；exit 1 = 仍有残留
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const globalRoot = path.join(process.env.APPDATA || '', 'reasonix', 'mcp-servers', 'cpt-mcp');

const targets = [
  path.join(root, 'tmp_test'),
  path.join(globalRoot, 'tmp_test'),
];
let residual = 0;
for (const p of targets) {
  const exists = fs.existsSync(p);
  const label = p.includes('Desktop') ? 'desktop' : 'global ';
  console.log(`  ${label} tmp_test: ${exists ? 'EXISTS (residual)' : 'clean'}`);
  if (exists) residual++;
}
if (residual === 0) {
  console.log('TMP_CLEAN: all tmp_test directories removed');
  process.exit(0);
} else {
  console.log('TMP_DIRTY: ' + residual + ' tmp_test directory still exists');
  process.exit(1);
}
