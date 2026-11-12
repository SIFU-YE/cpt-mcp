// cpt-mcp/lib/hot-reload.js —— cpt-mcp 源码热重启（2026-11-07）
//
// 背景：DSH 的 @deepseek-ai/dsh-mcp-client 在 MCP 连接断开后，会按 reconnect policy 自动重连
// **同一 command**（默认 enabled=true / initialDelayMs=500 / maxAttempts=10）。因此 cpt-mcp 只需在
// 自身源码变化后**自行退出**，DSH 就会拉起新进程加载新代码，不必重启整个 DSH。
//
// 设计（纯 Node，无新依赖；只读文件元数据，不碰本地测试库/报表工作区）：
//   · 指纹：包根 server.js + lib/**/*.js 的 size+mtimeMs（递归；排除 node_modules/test/.git/.cpt-mcp 等）；
//   · 轮询 1000ms；发现变化后进入 2000ms 静默期（期间再变就顺延），静默结束才重启；
//   · 启动后 3000ms 宽限期（避免 pre-push 同步到一半时连环重启）；
//   · 手动触发：<cwd>/.cpt-mcp/hot-reload.request 存在即重启（触发前删除该 marker，防止新进程循环）；
//   · 默认启用；CPT_MCP_HOT_RELOAD=0 关闭；日志只写 stderr，绝不污染 MCP 的 stdio 协议流。
import fs from 'node:fs';
import path from 'node:path';

/** 轮询间隔（ms） */
export const DEFAULT_INTERVAL_MS = 1000;
/** 静默期（ms）：变化后再等这么久没有新变化才重启 */
export const DEFAULT_QUIET_MS = 2000;
/** 启动宽限期（ms）：刚启动这段时间内的变化先吸收，避免同步到一半就重启 */
export const DEFAULT_GRACE_MS = 3000;
/** 手动重启 marker（相对 cwd） */
export const MARKER_REL = path.join('.cpt-mcp', 'hot-reload.request');

// 只监控 cpt-mcp 源码：包根 server.js + lib/**/*.js。
// 其余目录一律排除（node_modules 第三方代码、test/tests 测试、.git、本地库/预览/回收站等运行数据）。
const SKIP_DIRS = new Set([
  'node_modules', 'test', 'tests', '.git', '.cpt-mcp', '.fr-preview', 'tmp', '.trash', 'coverage', 'dist', 'build',
]);

function fileMeta(abs) {
  let st;
  try {
    st = fs.statSync(abs);
  } catch {
    return null;
  }
  if (!st.isFile()) return null;
  return { size: st.size, mtimeMs: Math.round(st.mtimeMs) };
}

/**
 * 计算源码指纹：{ 相对路径: {size, mtimeMs} }。只读元数据、不读内容，开销极小。
 * 路径统一用 `/` 分隔（跨平台稳定）；缺失的 server.js / lib 目录不会报错。
 * @param {string} root cpt-mcp 包根（server.js 所在目录）
 * @returns {Record<string, {size:number, mtimeMs:number}>}
 */
export function fingerprintSources(root) {
  const out = {};
  const add = (abs, rel) => {
    const meta = fileMeta(abs);
    if (meta) out[rel] = meta;
  };
  add(path.join(root, 'server.js'), 'server.js');
  const walk = (dir, relDir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name.startsWith('.')) continue; // .git/.cpt-mcp/.fr-preview/.trash 等
      const abs = path.join(dir, e.name);
      const rel = `${relDir}/${e.name}`;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(abs, rel);
      } else if (e.isFile() && e.name.endsWith('.js')) {
        add(abs, rel);
      }
    }
  };
  walk(path.join(root, 'lib'), 'lib');
  return out;
}

/**
 * 对比两份指纹。
 * @returns {{changed:string[], added:string[], removed:string[], any:boolean}}
 */
export function diffFingerprint(prev = {}, next = {}) {
  const changed = [];
  const added = [];
  const removed = [];
  for (const [rel, meta] of Object.entries(next)) {
    const old = prev[rel];
    if (!old) added.push(rel);
    else if (old.size !== meta.size || old.mtimeMs !== meta.mtimeMs) changed.push(rel);
  }
  for (const rel of Object.keys(prev)) {
    if (!next[rel]) removed.push(rel);
  }
  return { changed, added, removed, any: changed.length + added.length + removed.length > 0 };
}

/**
 * 安装源码热重启 watcher（fail-open：内部异常只记日志，不抛出到调用方）。
 *
 * @param {object} [options]
 * @param {string} [options.root] cpt-mcp 包根（默认 process.cwd()）
 * @param {string} [options.cwd] 手动 marker 的基准目录（默认 process.cwd()）
 * @param {boolean} [options.enabled] 显式开关；缺省按 `CPT_MCP_HOT_RELOAD !== '0'`
 * @param {(info:{reason:'source-change'|'marker', files:string[], at:string})=>void} [options.onRestart]
 *   重启回调（默认 `process.exit(0)`，交给 DSH mcp-client 自动重连重新拉起；测试注入 fake）
 * @param {number} [options.intervalMs=1000] 轮询间隔
 * @param {number} [options.quietMs=2000] 静默期
 * @param {number} [options.graceMs=3000] 启动宽限期
 * @param {(line:string)=>void} [options.logger] 日志函数（默认写 stderr 一行）
 * @returns {{enabled:boolean, stop:()=>void, checkNow:()=>void, fingerprint:()=>object, markerPath:string, root:string}}
 */
export function installHotReload(options = {}) {
  const root = options.root ?? process.cwd();
  const cwd = options.cwd ?? process.cwd();
  const intervalMs = Number(options.intervalMs ?? DEFAULT_INTERVAL_MS) || DEFAULT_INTERVAL_MS;
  const quietMs = Math.max(0, Number(options.quietMs ?? DEFAULT_QUIET_MS) || 0);
  const graceMs = Math.max(0, Number(options.graceMs ?? DEFAULT_GRACE_MS) || 0);
  const log = typeof options.logger === 'function'
    ? options.logger
    : (line) => {
      // 默认走同步写 fd 2：紧接着就 process.exit，Windows 上 stderr 异步管道可能丢最后一行
      try { fs.writeSync(2, `${line}\n`); } catch { /* 日志失败不影响重启 */ }
    };
  const markerPath = path.join(cwd, MARKER_REL);
  const enabled = options.enabled !== false && process.env.CPT_MCP_HOT_RELOAD !== '0';

  if (!enabled) {
    return { enabled: false, stop() {}, checkNow() {}, fingerprint: () => fingerprintSources(root), markerPath, root };
  }

  const startedAt = Date.now();
  let baseline = fingerprintSources(root);
  let pending = null; // { reason, files, since }
  let restarting = false;
  let timer = null;

  const stop = () => {
    if (timer) { clearInterval(timer); timer = null; }
  };

  const logOnce = (line) => {
    try { log(line); } catch { /* 日志失败不影响重启 */ }
  };

  const restart = (reason, files) => {
    if (restarting) return;
    restarting = true;
    stop();
    const info = { reason, files, at: new Date().toISOString() };
    const why = reason === 'marker'
      ? '手动 marker .cpt-mcp/hot-reload.request'
      : `检测到源码变化（${files.slice(0, 3).join('、')}${files.length > 3 ? ` 等 ${files.length} 个文件` : ''}）`;
    logOnce(`[cpt-mcp] 源码热重启：${why}；进程即将退出，DSH mcp-client 会自动重连并加载新代码`);
    try {
      if (typeof options.onRestart === 'function') options.onRestart(info);
      else process.exit(0);
    } catch (e) {
      restarting = false; // 回调失败不锁死 watcher（下次变化还能再试）
      logOnce(`[cpt-mcp] 热重启回调失败（忽略）：${e?.message ?? e}`);
    }
  };

  const tick = () => {
    if (restarting) return;
    try {
      const now = Date.now();

      // ① 手动 marker：存在即触发（删掉 marker 防止新进程循环）
      let markerExists = false;
      try { markerExists = fs.existsSync(markerPath); } catch { markerExists = false; }
      if (markerExists) {
        try { fs.unlinkSync(markerPath); } catch { /* 别人已删/权限问题：忽略 */ }
        pending = { reason: 'marker', files: [], since: now };
      }

      // ② 源码指纹变化：更新基线并重置静默计时（marker 待处理时不降级覆盖）
      const next = fingerprintSources(root);
      const diff = diffFingerprint(baseline, next);
      if (diff.any) {
        baseline = next;
        if (pending?.reason !== 'marker') {
          pending = { reason: 'source-change', files: [...diff.changed, ...diff.added, ...diff.removed], since: now };
        }
        return;
      }

      // ③ 到点重启：先过启动宽限期；源码变化还要过静默期（marker 只需宽限期）
      if (!pending) return;
      if (now - startedAt < graceMs) return;
      if (pending.reason === 'source-change' && now - pending.since < quietMs) return;
      restart(pending.reason, pending.files);
    } catch (e) {
      // fail-open：watcher 自身异常绝不影响 MCP 服务
      logOnce(`[cpt-mcp] 热重启 watcher 异常（忽略）：${e?.message ?? e}`);
    }
  };

  timer = setInterval(tick, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();

  return {
    enabled: true,
    stop,
    checkNow: () => tick(),
    fingerprint: () => fingerprintSources(root),
    markerPath,
    root,
  };
}
