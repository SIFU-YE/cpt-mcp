// cpt-mcp/scripts/review-regression.mjs
// 微型报表引擎 · 全样本回归抽查脚本
// 对 FineReport 官方 reportlets 目录（或任意目录）下的 .cpt 批量跑 样式审查 + 合理性审查，
// 统计：样本数、issue 分级计数、抛异常数、"特殊字符"误报数、审查耗时。
// 用法：node scripts/review-regression.mjs [--dir <路径>] [--limit N] [--fail-on-error]
import { reviewStyles, reviewReasonableness } from '../lib/engine/index.js';
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
  detailSpecial: process.argv.includes('--detail-special'),
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
  console.error(`[review-regression] 目录不存在或未找到任何 .cpt: ${opts.dir}`);
  console.error('可用 --dir <路径> 指定其他目录。');
}
const sample = opts.limit > 0 ? all.slice(0, opts.limit) : all;

let ok = 0, err = 0, styleIssues = { error: 0, warning: 0, info: 0 }, reasonIssues = { error: 0, warning: 0, info: 0 };
let specialErr = 0;
const errSamples = [];
const specialDetail = [];
const t0 = Date.now();

for (const p of sample) {
  try {
    const st = reviewStyles(p);
    const rs = reviewReasonableness(p);
    for (const i of st.issues) styleIssues[i.severity] += 1;
    for (const i of rs.issues) reasonIssues[i.severity] += 1;
    const special = rs.issues.filter((i) => i.message.includes('特殊字符'));
    specialErr += special.length;
    if (opts.detailSpecial) {
      for (const i of special) {
        if (specialDetail.length < 30) specialDetail.push({ file: p, message: i.message });
      }
    }
    ok++;
  } catch (e) {
    err++;
    if (errSamples.length < 20) errSamples.push(`${p} :: ${e.message}`);
  }
}
const ms = Date.now() - t0;

console.log(JSON.stringify({
  dir: opts.dir,
  total: all.length,
  sampled: sample.length,
  passed: ok,
  threw: err,
  styleIssues,
  reasonIssues,
  specialCharMisreports: specialErr,
  specialDetail,
  durationMs: ms,
  errSamples,
}, null, 2));

if (opts.failOnError && (err > 0 || specialErr > 0)) process.exitCode = 1;
