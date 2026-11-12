#!/usr/bin/env node
// cpt-mcp/scripts/sync-apply.mjs —— 桌面 → 全局 MCP 同步的 Node 实现（快）
//
// 为什么要 Node 版：旧 bash 版对 manifest 里每个文件都 fork 一次 sha1sum + cp，
// Windows/Git-Bash 下 200+ 文件要跑好几分钟（pre-push 会被拖死）。Node 单进程
// 读哈希 + 复制，200 文件 × 2 目标通常在 1~2 秒内完成。
//
// 用法：
//   node scripts/sync-apply.mjs --desktop <desktopDir> <target1> [target2 ...]
// 目标不存在自动跳过（不同机器安装位置不同）。退出码：0=成功/无变化，1=有失败。
//
// 同步范围与 scripts/sync-manifest.mjs 完全一致（单一事实源）。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { syncManifest } from './sync-manifest.mjs';

const args = process.argv.slice(2);
const di = args.indexOf('--desktop');
const desktop = di >= 0 ? args[di + 1] : path.resolve(process.cwd());
const targets = args.filter((a, i) => a !== '--desktop' && i !== di + 1);

if (!desktop || !fs.existsSync(desktop)) {
  console.error(`[sync] desktop not found: ${desktop}`);
  process.exit(1);
}
if (targets.length === 0) {
  console.error('[sync] no target given');
  process.exit(1);
}

const sha1 = (file) => {
  try { return crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex'); } catch { return null; }
};
const ts = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};
const relTo = (root, f) => path.relative(root, f).split(path.sep).join('/');

const files = syncManifest(desktop);
if (files.length === 0) {
  console.error('[sync] manifest is empty (desktop path wrong?)');
  process.exit(1);
}

let syncedTotal = 0;
let failed = 0;
for (const rawTarget of targets) {
  const target = path.resolve(rawTarget);
  console.log(`[sync] target: ${target}`);
  if (!fs.existsSync(target)) {
    console.log('[sync]   (not installed, skip)');
    continue;
  }

  const changed = [];
  for (const f of files) {
    const src = path.join(desktop, f);
    if (!fs.existsSync(src)) continue;
    const dst = path.join(target, f);
    if (!fs.existsSync(dst) || sha1(src) !== sha1(dst)) changed.push(f);
  }

  if (changed.length === 0) {
    console.log('[sync]   in sync, nothing to do');
    continue;
  }

  const backup = path.join(target, `.bak-${ts()}`);
  try {
    for (const f of changed) {
      const dst = path.join(target, f);
      if (!fs.existsSync(dst)) continue;
      const bak = path.join(backup, f);
      fs.mkdirSync(path.dirname(bak), { recursive: true });
      fs.copyFileSync(dst, bak);
    }
    for (const f of changed) {
      const src = path.join(desktop, f);
      const dst = path.join(target, f);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst);
    }
    console.log(`[sync]   backed up to ${backup}`);
    console.log(`[sync]   OK: ${changed.length} files synced`);
    console.log(`[sync]   rollback: cp -r '${backup}/'* '${target}/'`);
    syncedTotal += changed.length;
  } catch (e) {
    failed += 1;
    console.error(`[sync]   FAILED: ${e.message}`);
  }
}

if (syncedTotal === 0) console.log('[sync] all targets in sync');
else console.log(`[sync] done: ${syncedTotal} file(s) updated`);
process.exit(failed > 0 ? 1 : 0);
