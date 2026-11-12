// cpt-mcp/scripts/prune-store.mjs —— 清理 JS 基线 store 中的失效条目（M123 引入，M124 改 per-key）
//
// 【为什么要清】测试与 verify 脚本若未隔离，会往**真实用户 store** 写临时模板的基线。
// M123 实测：真实 store 500 条（已顶到 LRU 上限）里 495 条是 %TEMP% 测试残留、仅 5 条真实模板。
// 这些条目挤占容量会把**真实模板**的基线挤掉；被挤掉后下次 validate 走"首见建基线"、
// 在已丢块的状态上重建 → 该次丢失被静默跳过，M120 那道闸对该模板失效。
//
// 【M124 布局】store 是**目录**，每个被跟踪的模板一个 `<sha1(路径)>.json`，
// 内容 {key, updatedAt, total, byCat}。本脚本逐个读 `key` 字段做判断。
// 同时回收两类垃圾（与 lib/js-baseline.js 的 maintainDir/sweepLegacyDebris 同口径，
// 这里只是给存量数据做一次性清理）：
//   ① 目录内陈旧的中间文件 `<hash>.json.tmp.*`（写进程在 rename 前被 kill 的孤儿）
//   ② store 父目录里老单文件格式的中间文件 `js-baseline.json.tmp.*`
//      （M124 实测真实 store 已累积 143 个 / 8.1 MB）
//
// 【删除口径·保守】条目只删两类，且都不碰真实模板：
//   - 目标 .cpt 已不存在（临时目录早被 rmSync，基线已无意义）
//   - 位于系统临时目录下（os.tmpdir()/TEMP/TMP）—— 测试与 verify 脚本的产物
// 其余（含盘上真实模板、官方样本）一律保留。
//
// 用法：
//   node scripts/prune-store.mjs            # 预演，只报告不改文件
//   node scripts/prune-store.mjs --apply    # 真正落盘
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const APPLY = process.argv.includes('--apply');
const TMP_STALE_MS = 5 * 60 * 1000;

/** store 根目录：与 lib/js-baseline.js 的 storeDir() 同口径（env 指向 *.json 时剥后缀当目录） */
function storeDir() {
  let p;
  if (process.env.CPT_MCP_JS_BASELINE) {
    p = path.resolve(process.env.CPT_MCP_JS_BASELINE);
  } else if (process.platform === 'win32') {
    p = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'cpt-mcp', 'js-baseline');
  } else {
    p = path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state'), 'cpt-mcp', 'js-baseline');
  }
  return p.toLowerCase().endsWith('.json') ? p.slice(0, -5) : p;
}

const dir = storeDir();
if (!fs.existsSync(dir)) { console.log(`store 目录不存在，无需清理：${dir}`); process.exit(0); }

const tmpRoots = [os.tmpdir(), process.env.TEMP, process.env.TMP]
  .filter(Boolean).map((x) => path.resolve(x).toLowerCase());
const isTempPath = (p) => {
  const lower = path.resolve(p).toLowerCase();
  return tmpRoots.some((root) => lower === root || lower.startsWith(root + path.sep.toLowerCase()) || lower.startsWith(`${root}/`));
};

// ---- ① 扫中间文件垃圾 ----
const now = Date.now();
const debris = [];
for (const n of fs.readdirSync(dir)) {
  if (!n.includes('.tmp.')) continue;
  const f = path.join(dir, n);
  try { if (now - fs.statSync(f).mtimeMs > TMP_STALE_MS) debris.push(f); } catch { /* 占用中 */ }
}
const parent = path.dirname(dir);
const legacyPrefix = `${path.basename(dir)}.json.tmp.`;
try {
  for (const n of fs.readdirSync(parent)) {
    if (!n.startsWith(legacyPrefix)) continue;
    const f = path.join(parent, n);
    try { if (now - fs.statSync(f).mtimeMs > TMP_STALE_MS) debris.push(f); } catch { /* 占用中 */ }
  }
} catch { /* 父目录不可读 → 跳过 */ }

// ---- ② 扫条目 ----
const keep = [];
const drop = { missing: [], inTemp: [], broken: [] };
let total = 0;
for (const n of fs.readdirSync(dir)) {
  if (!n.endsWith('.json')) continue;
  total++;
  const f = path.join(dir, n);
  let entry;
  try { entry = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { drop.broken.push(f); continue; }
  if (!entry || typeof entry.key !== 'string') { drop.broken.push(f); continue; }
  if (isTempPath(entry.key)) { drop.inTemp.push(f); continue; }
  if (!fs.existsSync(path.resolve(entry.key))) { drop.missing.push(f); continue; }
  keep.push({ f, key: entry.key });
}

console.log(`store 目录: ${dir}`);
console.log(`  条目总数 : ${total}`);
console.log(`  临时目录 : ${drop.inTemp.length}`);
console.log(`  路径已失效: ${drop.missing.length}`);
console.log(`  读取损坏 : ${drop.broken.length}`);
console.log(`  保留     : ${keep.length}`);
console.log(`  中间文件垃圾: ${debris.length} 个`);

const nothingToDo = keep.length === total && debris.length === 0;
if (nothingToDo) { console.log('无需清理。'); process.exit(0); }

if (!APPLY) {
  console.log('\n[预演] 未加 --apply，不改文件。示例将删除：');
  [...debris, ...drop.inTemp, ...drop.missing, ...drop.broken].slice(0, 5)
    .forEach((f) => console.log('   -', f));
  console.log('确认无误后运行：node scripts/prune-store.mjs --apply');
  process.exit(0);
}

let removed = 0;
for (const f of [...debris, ...drop.inTemp, ...drop.missing, ...drop.broken]) {
  try { fs.unlinkSync(f); removed++; } catch { /* 被占用 → 下次再清 */ }
}
console.log(`\n已清理：${removed} 个文件（条目 ${total} → ${keep.length}，另含中间文件垃圾）`);
