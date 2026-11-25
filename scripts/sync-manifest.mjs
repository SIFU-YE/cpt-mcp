#!/usr/bin/env node
// cpt-mcp/scripts/sync-manifest.mjs
// 自动生成桌面→全局同步的 manifest 文件清单（单一事实源）。
// 被 scripts/sync-apply.mjs（Node 快速同步）与 scripts/sync-to-global.ps1 共同使用；
// 也可直接跑：node scripts/sync-manifest.mjs [--txt|--ps1]
//
// 规则：
//   包含：所有 .js / .mjs / .cjs / .ts（不含 .d.ts）/ .ps1 / .json（除 *.lock）/ .md
//   排除：node_modules/  .git/  .bak-*/  tmp_test/  demo/  *.min.js  *.map
//   总是包含：package.json  package-lock.json
//   总是排除：package-lock.json 仍包含（与 npm install 协同）
//   输出：UTF-8 文本，每行一个相对路径，PowerShell 数组字面量可直接 paste

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const INCLUDE_EXT = new Set(['.js', '.mjs', '.cjs', '.ts', '.ps1', '.sh', '.json', '.md', '.xml']);
const EXCLUDE_DIRS = new Set(['node_modules', '.git', 'tmp_test', 'demo', 'dist', 'build', '.next', 'coverage', '.workbuddy']);
const EXCLUDE_FILES = new Set([]); // 显式排除个别文件
const EXCLUDE_PATTERNS = [/\.min\.js$/, /\.map$/, /\.bak-\d{8}-\d{6}$/i];

function* walk(dir, base = dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return; }
  for (const e of entries) {
    if (e.name.startsWith('.bak-')) continue; // 任何 .bak-* 目录
    if (EXCLUDE_DIRS.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      yield* walk(p, base);
    } else if (e.isFile()) {
      const ext = path.extname(e.name).toLowerCase();
      if (!INCLUDE_EXT.has(ext)) continue;
      if (EXCLUDE_FILES.has(e.name)) continue;
      if (EXCLUDE_PATTERNS.some((re) => re.test(p))) continue;
      yield path.relative(base, p).replaceAll(path.sep, '/');
    }
  }
}

/** 生成同步清单：相对 rootDir 的 POSIX 路径（package.json / package-lock.json 置前）。 */
export function syncManifest(rootDir) {
  const root = path.resolve(rootDir);
  const all = [...walk(root)].sort();
  // 总是确保根级 package.json / package-lock.json 在前
  const pkg = all.filter((f) => f === 'package.json' || f === 'package-lock.json');
  const others = all.filter((f) => f !== 'package.json' && f !== 'package-lock.json');
  return [...pkg, ...others];
}

// CLI：被 sync-to-global.ps1 / 人工直接调用时输出清单；被 import 时不执行。
const invokedDirectly = process.argv[1] != null
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) {
  const args = process.argv.slice(2);
  const flag = args.find((a) => a === '--ps1' || a === '--txt') ?? 'txt';
  const list = syncManifest(path.resolve(__dirname, '..'));
  if (flag === '--ps1') {
    // PowerShell 数组字面量（单引号包裹）
    console.log('  # === AUTO-GENERATED manifest (do not edit by hand) ===');
    for (const f of list) console.log(`  '${f}'`);
    console.log('  # === END manifest ===');
  } else {
    // 纯文本（每行一个）
    for (const f of list) console.log(f);
  }
}
