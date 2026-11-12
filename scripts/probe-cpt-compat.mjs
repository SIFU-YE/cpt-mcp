// scripts/probe-cpt-compat.mjs —— 静态对比 cpt-mcp 生成产物 vs 官方 sample.cpt
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEMO = path.join(__dirname, '..', 'demo', '示例填报模板.cpt');
const OFFICIAL = process.env.FR_SAMPLE
  || (process.env.FR_HOME ? path.join(process.env.FR_HOME, 'webapps', 'webroot', 'WEB-INF', 'reportlets', 'GettingStarted.cpt') : null);

const a = fs.readFileSync(DEMO, 'utf8');
const b = OFFICIAL && fs.existsSync(OFFICIAL) ? fs.readFileSync(OFFICIAL, 'utf8') : null;

function firstC(xml) {
  const m = xml.match(/<C [^>]*>[\s\S]*?<\/C>/);
  return m ? m[0] : '';
}

console.log('=== DEMO 第一个 C 块（add_cell 生成） ===');
console.log(firstC(a));
console.log();
console.log('=== OFFICIAL 第一个 C 块（设计器生成） ===');
if (b) console.log(firstC(b));
else console.log('OFFICIAL NOT FOUND');

function cChildren(xml) {
  const counts = {};
  const re = /<[A-Z][A-Za-z]*\b/g;
  let m;
  while ((m = re.exec(xml))) counts[m[0]] = (counts[m[0]] || 0) + 1;
  return counts;
}
const demo = cChildren(a);
const off = b ? cChildren(b) : {};
const keys = new Set([...Object.keys(demo), ...Object.keys(off)]);
console.log();
console.log('=== 大写标签出现次数（DEMO vs OFFICIAL） ===');
[...keys].sort().forEach((k) => {
  if (k === 'CDATA') return;
  if (demo[k] || off[k]) console.log(`${k.padEnd(28)}  demo=${String(demo[k] || 0).padStart(3)}  off=${String(off[k] || 0).padStart(3)}`);
});
