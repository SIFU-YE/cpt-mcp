// cpt-mcp/scripts/review-gate.mjs —— 质量门槛 · 官方样本地面真值回归
//
// 【为什么需要这个脚本】
//   单元测试捕捉不了"语义理解错误"：quality_gate 曾实现"同行多列 dsColumn 缺左父格 = blocker"，
//   测试与实现建立在同一个错误假设上，测试全绿但产品是错的 —— 官方样本一跑，40/300 误报现形。
//   FR 官方 reportlets 是"设计器认可的模板"集合，quality_gate 对它们必须零误报、零崩溃。
//   任何 blocker/异常都是门槛本身的回归，而不是样本的问题（个别官方样本确有历史遗留结构问题，
//   出现时先人工确认再决定是否修正门槛规则，不要静默加白名单）。
//
// 用法：node scripts/review-gate.mjs [--dir <路径>] [--limit N] [--fail-on-error]
//   --fail-on-error  出现任何 blocker/异常时退出码 1（CI 严格模式；默认只打印报告）
import { qualityGate } from '../lib/quality.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
// 迁移友好：优先 --dir / FR_REPORTLETS_DIR；未配置时使用仓库内 tmp_test，
// 不依赖任何本机盘符或 FineReport 安装位置。
const DEFAULT_DIR = process.env.FR_REPORTLETS_DIR
  || (process.env.FR_HOME ? path.join(process.env.FR_HOME, 'webapps', 'webroot', 'WEB-INF', 'reportlets') : null)
  || path.join(REPO_ROOT, 'tmp_test');

function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : def;
}
const opts = {
  dir: arg('--dir', DEFAULT_DIR),
  limit: Number(arg('--limit', '0')) || 0,
  failOnError: process.argv.includes('--fail-on-error'),
};

function* walkCpt(dir) {
  if (!fs.existsSync(dir)) return;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) yield* walkCpt(p);
    else if (p.toLowerCase().endsWith('.cpt')) yield p;
  }
}

const all = [...walkCpt(opts.dir)];
if (all.length === 0) {
  console.error(`[review-gate] 目录不存在或未找到任何 .cpt: ${opts.dir}`);
  console.error('可用 --dir <路径> 指定其他目录。');
}
const sample = opts.limit > 0 ? all.slice(0, opts.limit) : all;

let pass = 0, fail = 0, threw = 0;
const blockerTypes = new Map();
const failSamples = [];
const throwSamples = [];
const t0 = Date.now();

for (const p of sample) {
  try {
    const g = qualityGate(p);
    if (g.pass) { pass++; continue; }
    fail++;
    for (const b of g.blockers) {
      const key = b.message.slice(0, 60);
      blockerTypes.set(key, (blockerTypes.get(key) || 0) + 1);
    }
    if (failSamples.length < 20) failSamples.push({ file: p, blockers: g.blockers.map((b) => b.message.slice(0, 90)) });
  } catch (e) {
    threw++;
    if (throwSamples.length < 20) throwSamples.push(`${path.basename(p)} :: ${e.message.slice(0, 120)}`);
  }
}
const ms = Date.now() - t0;

console.log(JSON.stringify({
  dir: opts.dir,
  total: all.length,
  sampled: sample.length,
  pass,
  failed: fail,
  threw,
  passRate: sample.length ? `${((pass / sample.length) * 100).toFixed(1)}%` : 'n/a',
  blockerTypes: [...blockerTypes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12),
  failSamples,
  throwSamples,
  durationMs: ms,
  note: '官方样本是「设计器认可的模板」：pass 应为 100%。任何 blocker/异常都是门槛规则自身的回归——先人工确认样本，再修正规则，不要加白名单。',
}, null, 2));

if (opts.failOnError && (fail > 0 || threw > 0)) process.exitCode = 1;
