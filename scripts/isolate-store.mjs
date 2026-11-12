// cpt-mcp/scripts/isolate-store.mjs —— JS 基线 store 的进程隔离（M123）
//
// 【为什么需要】lib/js-baseline.js 把基线存在**一个**共享 JSON 里，upsert 是裸的
// read→改→write（无锁）。而 `node --test` 默认按文件分进程（实测 2 文件 → 2 个 ppid 相同的
// 子进程），单次全量已有 13 个测试文件 spawn server.js（21 站点）+ 6 个 scripts + 约 62 个
// 文件进程内触发 save()，全部并发写同一个真实 store。后果有二：
//   ① flake：A 写完"删块后"的低计数，B 拿更早的快照落盘 → A 的刷新被覆盖回高计数
//      → validate 误报"JS 块丢失" error（即 test/write-path-e2e 那条 1 !== 0）。
//      已精确复现：loss:true, decreased:[{cat:'repev:0', base:1, now:0}]。
//   ② 污染用户数据：真实 store 曾 479 条里 474 条是 %TEMP% 测试残留，LRU 上限 500 ——
//      测试每轮都在挤掉真实模板的基线；被挤掉后下次 validate 走"首见建基线"，
//      在**已丢块的状态**上重建 → 该次丢失被静默跳过，M120 那道闸对它永久失效。
//
// 【M124 之后】store 已改成 per-key 布局（见 lib/js-baseline.js 头注），文件锁随之删除——
// 不同 key 物理隔离，丢更新从「被锁住」变成「结构上不可能」。本隔离仍必需：
// 它防的是上面 ②（测试往真实用户 store 写残留、挤掉真实基线），与并发无关。
// 另注：M123 时代的 `.lock` 残留已随锁一并消失（当时实测连跑 5 轮泄漏 11 个目录）。
//
// 【怎么用】
//   - `node --test --import ./scripts/isolate-store.mjs`：**每个**测试子进程各自执行一次
//     （实测），各自 mkdtemp 出私有 store → 测试与真实用户 store 彻底分离。
//   - scripts/*.mjs 顶部 `await import('./isolate-store.mjs')`，同理隔离自身。
//   - 尊重已显式设置的 CPT_MCP_JS_BASELINE（test/js-baseline.test.js 自建临时 store 的用法不变）。
//
// 【关键约束】仅在测试进程里 set process.env 是**不够的**：server.js 子进程不会继承。
// SDK 的 getDefaultEnvironment() 走白名单（只有 LOCALAPPDATA/PATH/TEMP 等 12 个），
// 不含 CPT_MCP_JS_BASELINE → server 写真实 store、测试读临时 store，**两边分家**，
// 静默削弱检查。故必须把该变量 push 进 DEFAULT_INHERITED_ENV_VARS（SDK 导出的可变数组，
// 实测 push 可用 12→13）。已端到端验证：server 子进程 save 写入的基线，测试进程能读到。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_INHERITED_ENV_VARS } from '@modelcontextprotocol/sdk/client/stdio.js';

/**
 * 启动期清扫：回收历史运行泄漏的隔离目录。
 *
 * 【为什么会有泄漏】exit 钩子只在**正常退出**时执行；`node --test` 收尾会强杀
 * 尚未正常关闭的子进程（M123 实测：连跑 5 轮全量泄漏 11 个目录），钩子就此跳过。
 * 单跑看不出来，多轮才累积。（M124 注：目录里的 `.lock` 残留已随文件锁一并消失，
 * 现在剩的是 per-key 条目文件本身 —— 泄漏量级也从「整库快照」降到「几个小文件」。）
 *
 * 【阈值取 1 小时】全量约 3 分钟，1 小时远超任何在跑的套件 → 不会误删并发套件的
 * store。即使极端情况下误删，也只是该进程基线退化为"首见重建"（不产生假 error），
 * 写入路径会 mkdirSync 递归重建，不会崩。
 */
const STALE_MS = 60 * 60 * 1000;

function sweepStaleDirs() {
  let names = [];
  try { names = fs.readdirSync(os.tmpdir()); } catch { return; }
  const cutoff = Date.now() - STALE_MS;
  for (const name of names) {
    if (!name.startsWith('cpt-mcp-jsbl-')) continue;
    const dir = path.join(os.tmpdir(), name);
    try {
      if (fs.statSync(dir).mtimeMs >= cutoff) continue; // 太新 → 可能是并发套件在用
      fs.rmSync(dir, { recursive: true, force: true });
    } catch { /* 被占用/已消失 → 跳过 */ }
  }
}

/**
 * 把当前进程的 JS 基线 store 隔离到临时文件；幂等，可重复调用。
 * @returns {string} 实际生效的 store 路径
 */
export function isolateBaselineStore() {
  // ① 先开白名单：无论 store 路径谁定的，都必须能穿透到 server 子进程
  if (!DEFAULT_INHERITED_ENV_VARS.includes('CPT_MCP_JS_BASELINE')) {
    DEFAULT_INHERITED_ENV_VARS.push('CPT_MCP_JS_BASELINE');
  }
  // ② 已显式设置（如 js-baseline.test 自建）→ 尊重，不覆盖
  if (process.env.CPT_MCP_JS_BASELINE) return process.env.CPT_MCP_JS_BASELINE;
  // ③ 回收历史泄漏（必须在建新目录之前，避免把自己当陈旧项删掉）
  sweepStaleDirs();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-mcp-jsbl-'));
  process.env.CPT_MCP_JS_BASELINE = path.join(dir, 'js-baseline.json');
  // ④ 尽力清理：正常退出时立刻回收；异常退出由下次运行的 sweepStaleDirs 兜底
  process.on('exit', () => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 尽力而为 */ }
  });
  return process.env.CPT_MCP_JS_BASELINE;
}

// 作为 --import 入口 / 被 import 时立即生效
isolateBaselineStore();

/**
 * 把「内置 SQLite 本地测试库」隔离到临时目录（2026-11-02）。
 * 与 js-baseline 同理：测试绝不能往用户真实工程目录 `.cpt-mcp/localdb/` 写库文件，
 * 也不能让 server 子进程读到真实库（SDK 的 getDefaultEnvironment 白名单不含该变量，
 * 必须 push 进 DEFAULT_INHERITED_ENV_VARS 才能穿透到 server 子进程）。
 * 尊重显式设置的 CPT_MCP_LOCALDB_DIR（单测自建临时库的用法不变）。
 * @returns {string} 实际生效的本地库根目录
 */
export function isolateLocalDbDir() {
  if (!DEFAULT_INHERITED_ENV_VARS.includes('CPT_MCP_LOCALDB_DIR')) {
    DEFAULT_INHERITED_ENV_VARS.push('CPT_MCP_LOCALDB_DIR');
  }
  if (process.env.CPT_MCP_LOCALDB_DIR) return process.env.CPT_MCP_LOCALDB_DIR;
  sweepStaleLocalDbDirs();
  // 2026-11-04 P2（独立验收发现）：localdb.json 配置路径 = dirname(CPT_MCP_LOCALDB_DIR)。
  // 若根直接是 <tmp>/cpt-mcp-localdb-XXXX，配置会落到**共享的** <tmp>/localdb.json，
  // 并发套件/上次残留会串味（定向套件首跑偶发 1 次 flake）。这里把根放进私有
  // base/.cpt-mcp/localdb（与生产 <cwd>/.cpt-mcp/localdb 同构），配置落在
  // base/.cpt-mcp/localdb.json，随 base 一起回收，彻底私有不共享。
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-mcp-localdb-'));
  const dir = path.join(base, '.cpt-mcp', 'localdb');
  fs.mkdirSync(dir, { recursive: true });
  process.env.CPT_MCP_LOCALDB_DIR = dir;
  process.on('exit', () => {
    try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* 尽力而为 */ }
  });
  return dir;
}

const LOCALDB_STALE_MS = 60 * 60 * 1000;

/** 回收异常退出泄漏的本地库隔离目录（阈值 1 小时，避免误删并发套件） */
function sweepStaleLocalDbDirs() {
  let names = [];
  try { names = fs.readdirSync(os.tmpdir()); } catch { return; }
  const cutoff = Date.now() - LOCALDB_STALE_MS;
  for (const name of names) {
    if (!name.startsWith('cpt-mcp-localdb-')) continue;
    const dir = path.join(os.tmpdir(), name);
    try {
      if (fs.statSync(dir).mtimeMs >= cutoff) continue;
      fs.rmSync(dir, { recursive: true, force: true });
    } catch { /* 被占用/已消失 → 跳过 */ }
  }
}

isolateLocalDbDir();
