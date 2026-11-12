// cpt-mcp/lib/schedule.js —— 定时任务调度器（auto-runner 模式）
//
// 设计目标：模仿 agent-team/core/mcp/server.py 的 auto-runner 模式，把"定时任务"
// 做成 cpt-mcp 内部的能力：暴露 start/add/list/run/status/history/stop 工具，
// 任务配置持久化到 .cpt 同目录的 .cpt-schedule.json，进程内 node-cron 调度。
//
// 关键不变量：
//   - 调度器在 MCP 进程内单实例（globalThis.__cpt_scheduler）
//   - 文件只存配置（不存 cronTask 对象），重启后从 JSON 重新订阅
//   - 写文件用 mkdir-based 跨平台文件锁（不依赖第三方锁库）
//   - 每任务执行历史最多保留 50 条（截断老的）
//   - 动作通过注册表（ACTIONS）扩展，新增动作只动一个 map

import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync, rmSync, renameSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import cron from 'node-cron';

import { validateCpt, issueSummary } from './validate.js';
import { reviewStyles, reviewReasonableness } from './engine/index.js';
import { decompileCpt } from './fr-decompile.js';
import { assertDecompileOutput, assertToolPath } from './security.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const HISTORY_LIMIT = 50;
const SCHEDULE_FILENAME = '.cpt-schedule.json';
const LOCK_FILENAME = '.cpt-schedule.json.lock';
const LOCK_RETRY_MS = 25;
const LOCK_MAX_WAIT_MS = 5000;

// ---------------- 文件锁（mkdir 互斥） ----------------

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function acquireLock(lockPath) {
  const start = Date.now();
  while (true) {
    try {
      mkdirSync(lockPath);
      return;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
    try {
      const st = statSync(lockPath);
      if (Date.now() - st.mtimeMs > 30000) {
        try { rmSync(lockPath, { recursive: true, force: true }); } catch { /* ignore */ }
      }
    } catch { /* 锁目录刚被释放 */ }
    if (Date.now() - start > LOCK_MAX_WAIT_MS) {
      throw new Error(`acquireLock 超时：${lockPath}`);
    }
    await sleep(LOCK_RETRY_MS);
  }
}

function releaseLock(lockPath) {
  try { rmSync(lockPath, { recursive: true, force: true }); } catch { /* ignore */ }
}

async function withLock(lockPath, fn) {
  await acquireLock(lockPath);
  try { return await fn(); } finally { releaseLock(lockPath); }
}

// ---------------- 执行租约（跨进程防重复执行） ----------------
//
// 多个 MCP server 进程可能加载同一份 .cpt-schedule.json；历史写入有锁不会坏数据，
// 但同一任务会被每个进程各跑一遍。执行前以「任务级租约目录」仲裁：拿不到租约
// （另一进程正在执行，或租约未过期）就跳过本次触发。租约 10 分钟自动过期兜底进程崩溃。

const RUN_LEASE_MS = 10 * 60 * 1000;

function runLeasePathFor(cptPath, taskId) {
  return join(dirname(schedulePathFor(cptPath)), `.cpt-schedule.run-${taskId}.lock`);
}

function tryAcquireRunLease(cptPath, taskId) {
  const p = runLeasePathFor(cptPath, taskId);
  try {
    mkdirSync(p);
    return { acquired: true, path: p };
  } catch (e) {
    if (e.code !== 'EEXIST') return { acquired: true, path: p }; // 租约机制自身故障不阻塞执行
  }
  try {
    if (Date.now() - statSync(p).mtimeMs > RUN_LEASE_MS) {
      try { rmSync(p, { recursive: true, force: true }); } catch { /* ignore */ }
      try { mkdirSync(p); return { acquired: true, path: p }; } catch { return { acquired: false, path: p }; }
    }
  } catch { /* 租约刚好被释放 */ }
  return { acquired: false, path: p };
}

// ---------------- 路径 / 存储 ----------------

function schedulePathFor(cptPath) {
  const abs = resolve(cptPath);
  return join(dirname(abs), SCHEDULE_FILENAME);
}

function lockPathFor(cptPath) {
  const abs = resolve(cptPath);
  return join(dirname(abs), LOCK_FILENAME);
}

function emptyStore(cptPath) {
  return {
    version: 1,
    cpt: resolve(cptPath),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    tasks: [],
  };
}

async function readStore(cptPath) {
  const p = schedulePathFor(cptPath);
  if (!existsSync(p)) return emptyStore(cptPath);
  return readStoreUnsafe(cptPath);
}

async function readStoreUnsafe(cptPath) {
  const p = schedulePathFor(cptPath);
  if (!existsSync(p)) return emptyStore(cptPath);
  try {
    const raw = readFileSync(p, 'utf8');
    const obj = JSON.parse(raw);
    if (!Array.isArray(obj.tasks)) obj.tasks = [];
    if (!obj.cpt) obj.cpt = resolve(cptPath);
    return obj;
  } catch (e) {
    try { writeFileSync(p + '.corrupt.' + Date.now(), readFileSync(p)); } catch { /* ignore */ }
    return emptyStore(cptPath);
  }
}

async function writeStore(cptPath, store) {
  store.updatedAt = new Date().toISOString();
  return writeStoreUnsafe(cptPath, store);
}

async function writeStoreUnsafe(cptPath, store) {
  const p = schedulePathFor(cptPath);
  // M21 修复: 原子写 (临时文件 + rename), 避免 .cpt-schedule.json 写半截
  // 锁已保证无并发, 临时文件名加 pid 避免历史残留冲突
  const tmp = p + '.tmp.' + process.pid + '.' + Date.now();
  writeFileSync(tmp, JSON.stringify(store, null, 2));
  try {
    renameSync(tmp, p);
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* ignore */ }
    throw e;
  }
}

/** 整个 read-modify-write 在同一把锁内；fn 返回新 store。用于 add/remove/setEnabled/_runOne 等。 */
async function mutateStore(cptPath, fn) {
  const lock = lockPathFor(cptPath);
  return withLock(lock, async () => {
    const store = await readStoreUnsafe(cptPath);
    const result = await fn(store);
    await writeStoreUnsafe(cptPath, result || store);
    return result || store;
  });
}

// ---------------- nextRun 计算 ----------------

function isLeap(y) { return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0; }
const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function expandField(field, min, max) {
  if (field === '*') {
    const out = []; for (let i = min; i <= max; i++) out.push(i); return out;
  }
  const out = new Set();
  for (const part of field.split(',')) {
    let step = 1;
    let body = part;
    if (part.includes('/')) {
      const [b, s] = part.split('/');
      step = Math.max(1, parseInt(s, 10) || 1);
      body = b;
    }
    let lo, hi;
    if (body === '*' || body === '') { lo = min; hi = max; }
    else if (body.includes('-')) {
      const [a, b] = body.split('-');
      lo = parseInt(a, 10); hi = parseInt(b, 10);
    } else {
      lo = hi = parseInt(body, 10);
    }
    if (Number.isNaN(lo) || Number.isNaN(hi)) throw new Error(`非法 cron 字段：${field}`);
    lo = Math.max(min, lo); hi = Math.min(max, hi);
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return [...out].sort((a, b) => a - b);
}

function parseCron(expr) {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error(`cron 必须是 5 字段：分 时 日 月 周（当前 ${parts.length}）`);
  const [m, h, d, mo, w] = parts;
  return {
    minutes: expandField(m, 0, 59),
    hours: expandField(h, 0, 23),
    days: expandField(d, 1, 31),
    months: expandField(mo, 1, 12),
    // R20 S20-1: cron 周字段 0-7（0 与 7 都是周日，node-cron/croner 会把 7 归一为 0）。
    // 旧实现 expandField(w, 0, 6) 会把 7 clamp 成 6（周六），导致 nextRun 预测与实际触发不一致。
    // 修复：先按 0-7 展开，再把 7 归一为 0（去重排序；范围如 5-7 → 周五+周六+周日）。
    weeks: [...new Set(expandField(w, 0, 7).map((v) => (v === 7 ? 0 : v)))].sort((a, b) => a - b),
  };
}

function nextRunFromCron(expr, fromDate = new Date()) {
  // 与 node-cron.schedule 一致：按本机时区解释 cron 字段。
  // （此前按 UTC 解释导致 nextRun 显示与实际触发时间差一个时区偏移，已修复。）
  const fields = parseCron(expr);
  const start = new Date(fromDate.getTime());
  start.setSeconds(0, 0);
  start.setMinutes(start.getMinutes() + 1);
  // 逐日扫描 + 当天内小时/分钟有序查找，替代逐分钟循环
  //（旧实现最坏 366*24*60 次迭代，如 "0 0 30 2 *" 这类永不匹配的表达式）
  const dayStart = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  const limitDays = 366 * 3;
  for (let d = 0; d < limitDays; d++) {
    const day = new Date(dayStart.getFullYear(), dayStart.getMonth(), dayStart.getDate() + d);
    if (!fields.months.includes(day.getMonth() + 1)) continue;
    if (!fields.days.includes(day.getDate())) continue;
    const dow = day.getDay();
    const weekOk = fields.weeks.length < 7 ? fields.weeks.includes(dow) : true;
    if (!weekOk) continue;
    for (const h of fields.hours) {
      for (const m of fields.minutes) {
        const t = new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m, 0, 0);
        if (t.getTime() >= start.getTime()) return t;
      }
    }
  }
  return null;
}

function computeNextRun(cron) {
  try { return nextRunFromCron(cron, new Date())?.toISOString() || null; } catch { return null; }
}

export { parseCron, nextRunFromCron, computeNextRun };

// ---------------- 动作注册表 ----------------
// 动作可同步复用 cpt-mcp 现有工具的纯函数；返回 {ok, summary, log, detail}。

const ACTIONS = {
  validate: {
    describe: '结构校验：调 validate_cpt，返回错误/警告数与摘要',
    argsSchema: {
      severity: { type: 'string', enum: ['error', 'warning', 'all'], default: 'all' },
    },
    run: async (cpt, args = {}) => {
      const issues = validateCpt(cpt);
      const sev = args.severity || 'all';
      const filtered = sev === 'all' ? issues : issues.filter((i) => i.severity === sev);
      const summary = issueSummary(filtered);
      const summaryStr = `校验: error=${summary.error} warning=${summary.warning} info=${summary.info}`;
      return { ok: summary.error === 0, summary: summaryStr, log: summaryStr, detail: { counts: summary, count: filtered.length, issues: filtered.slice(0, 10) } };
    },
  },
  style_review: {
    describe: '样式审查：调 style_review_cpt',
    run: async (cpt) => {
      const r = reviewStyles(cpt);
      const summary = `样式审查: ${(r.issues || []).length} 条问题`;
      return { ok: true, summary, log: summary, detail: r };
    },
  },
  reasonableness_review: {
    describe: '合理性审查：调 reasonableness_review_cpt',
    run: async (cpt) => {
      const r = reviewReasonableness(cpt);
      const summary = `合理性审查: ${(r.issues || []).length} 条问题`;
      return { ok: true, summary, log: summary, detail: r };
    },
  },
  decompile: {
    describe: '调本地 FR 设计器反编译 .cpt 到源码目录（需 FR_HOME/bin/cptdec）',
    argsSchema: {
      outDir: { type: 'string', description: '反编译输出目录（缺省与 .cpt 同目录的 .decompiled/）' },
    },
    run: async (cpt, args = {}) => {
      if (process.env.CPT_MCP_ALLOW_SCHEDULE_SIDE_EFFECTS !== '1') {
        throw new Error('安全围栏：定时 decompile 默认关闭；明确确认后设置 CPT_MCP_ALLOW_SCHEDULE_SIDE_EFFECTS=1');
      }
      assertToolPath('fr_decompile', cpt, { write: false });
      assertDecompileOutput(cpt, args.outDir);
      const r = await decompileCpt(cpt, args.outDir);
      const summary = `反编译: ${r.status} -> ${r.outputDir}`;
      return { ok: !!r.ok, summary, log: r.log || summary, detail: r };
    },
  },
};

export function listActions() {
  return Object.entries(ACTIONS).map(([name, a]) => ({ name, describe: a.describe, argsSchema: a.argsSchema || {} }));
}

function getAction(name) {
  const a = ACTIONS[name];
  if (!a) throw new Error(`未知动作: ${name}（可用: ${Object.keys(ACTIONS).join(', ')}）`);
  return a;
}

// ---------------- Scheduler 单例 ----------------

class Scheduler {
  constructor() {
    this.started = false;
    this.cronTasks = new Map();
    this.runState = new Map();
    // 已加载过 store 的目录（幂等加载：重启后首个 schedule 类调用触发重订阅）
    this.loadedDirs = new Set();
  }

  /**
   * 确保该 .cpt 所在目录的持久化任务已订阅。
   * 修复：注释与 README 声称「重启时自动重新加载并订阅」，但代码从未在启动/调用时
   * 执行 loadFor —— 服务重启后定时任务静默失效（行为回归 S7 发现）。
   * 幂等：同目录只加载一次；新任务由 addTask 单独订阅。
   */
  async ensureLoadedFor(cptPath) {
    this.ensureStarted();
    const cpt = resolve(cptPath);
    const dir = dirname(schedulePathFor(cpt));
    if (this.loadedDirs.has(dir)) return { cpt, loaded: 0, cached: true };
    this.loadedDirs.add(dir);
    const store = await readStore(cpt);
    for (const t of store.tasks) {
      // 安全围栏：副作用任务（decompile）在重启重载时同样需要显式放行，
      // 否则保持未订阅（不会被 cron 触发），直到环境变量开启
      if (t.action === 'decompile' && process.env.CPT_MCP_ALLOW_SCHEDULE_SIDE_EFFECTS !== '1') continue;
      this._scheduleOne(cpt, t);
    }
    return { cpt, loaded: store.tasks.length };
  }

  ensureStarted() {
    if (this.started) return;
    this.started = true;
    const cleanup = () => {
      for (const { task } of this.cronTasks.values()) {
        try { task.stop(); } catch { /* ignore */ }
      }
      this.cronTasks.clear();
    };
    process.once('exit', cleanup);
    process.once('SIGINT', () => { cleanup(); process.exit(0); });
    process.once('SIGTERM', () => { cleanup(); process.exit(0); });
  }

  async loadFor(cptPath) {
    return this.ensureLoadedFor(cptPath);
  }

  trackedIdsFor(cptPath) {
    const cpt = resolve(cptPath);
    return [...this.cronTasks.entries()].filter(([, v]) => v.cpt === cpt).map(([k]) => k);
  }

  _scheduleOne(cpt, cfg) {
    if (this.cronTasks.has(cfg.id)) {
      try { this.cronTasks.get(cfg.id).task.stop(); } catch { /* ignore */ }
    }
    if (!cfg.enabled) { this.cronTasks.delete(cfg.id); return; }
    if (!cron.validate(cfg.cron)) throw new Error(`非法 cron 表达式: ${cfg.cron}`);
    const task = cron.schedule(cfg.cron, async () => {
      await this._runOne(cpt, cfg.id);
    }, { scheduled: true });
    this.cronTasks.set(cfg.id, { task, cpt, cfg });
  }

  async _runOne(cpt, taskId) {
    const cptR = cpt;
    const startedAt = new Date().toISOString();
    this.runState.set(taskId, { status: 'running', startedAt });
    const t0 = Date.now();
    let result;
    let cfg;
    let lease = null;
    try {
      // 读 cfg（不修改）以获取 action/args；同时校验 enabled
      const readStore0 = await readStore(cptR);
      cfg = readStore0.tasks.find((t) => t.id === taskId);
      if (!cfg) { this.runState.set(taskId, { status: 'error', error: '任务已不存在' }); return; }
      if (!cfg.enabled) { this.runState.set(taskId, { status: 'idle' }); return; }
      // 跨进程执行仲裁：另一进程正在执行同一任务时跳过本次触发
      lease = tryAcquireRunLease(cptR, taskId);
      if (!lease.acquired) {
        this.runState.set(taskId, { status: 'skipped', startedAt, summary: '另一进程正在执行，本次跳过' });
        return;
      }
      const action = getAction(cfg.action);
      result = await action.run(cptR, cfg.actionArgs || {});
    } catch (e) {
      result = { ok: false, summary: `执行失败: ${e.message}`, log: e.stack || e.message, detail: null };
    } finally {
      if (lease?.acquired) releaseLock(lease.path);
    }
    const finishedAt = new Date().toISOString();
    const durationMs = Date.now() - t0;
    const logStr = typeof result.log === 'string' ? result.log : (result.log == null ? '' : JSON.stringify(result.log));
    const histEntry = {
      ts: finishedAt, durationMs,
      status: result.ok ? 'ok' : 'error',
      summary: result.summary,
      log: logStr.slice(0, 2000),
    };
    // 写历史 + 重新计算 nextRun：整个 R-M-W 在锁内
    await mutateStore(cptR, (store) => {
      const t = store.tasks.find((x) => x.id === taskId);
      if (!t) return store;
      t.history = t.history || [];
      t.history.unshift(histEntry);
      if (t.history.length > HISTORY_LIMIT) t.history.length = HISTORY_LIMIT;
      t.lastRun = { ts: finishedAt, durationMs, status: result.ok ? 'ok' : 'error', summary: result.summary };
      t.nextRun = computeNextRun(t.cron);
      return store;
    });
    this.runState.set(taskId, {
      status: result.ok ? 'ok' : 'error',
      startedAt, finishedAt, durationMs,
      summary: result.summary,
      error: result.ok ? undefined : result.summary,
    });
  }

  async runNow(cptPath, taskId) {
    this.ensureStarted();
    const cpt = resolve(cptPath);
    await this._runOne(cpt, taskId);
    return this.runState.get(taskId);
  }

  status(taskId) { return this.runState.get(taskId) || null; }
  activeCount() { return this.cronTasks.size; }
  stop() {
    for (const { task } of this.cronTasks.values()) { try { task.stop(); } catch { /* ignore */ } }
    this.cronTasks.clear();
    this.loadedDirs.clear();
    this.started = false;
  }
}

let _instance = null;
export function getScheduler() {
  if (!_instance) _instance = new Scheduler();
  return _instance;
}

// ---------------- 对外 API（供 server.js 工具调用） ----------------

export async function addTask(cptPath, { cron: cronExpr, action, actionArgs, note }) {
  if (!cronExpr || !cron.validate(cronExpr)) throw new Error(`非法 cron 表达式: ${cronExpr}`);
  getAction(action); // 校验存在

  // M26 防御: actionArgs 限大小, 防止超大 JSON 撑爆 .cpt-schedule.json
  const serialized = JSON.stringify(actionArgs || {});
  if (serialized.length > 4096) {
    throw new Error(`actionArgs 序列化超长 (${serialized.length} > 4096 字符)。请精简参数`);
  }
  if (note != null && String(note).length > 500) {
    throw new Error(`note 超长 (${String(note).length} > 500 字符)`);
  }

  // M24 防御: 单 .cpt 任务数上限 50, 防恶意 schedule_add 撑爆内存
  const cpt = resolve(cptPath);
  await getScheduler().ensureLoadedFor(cpt);
  const sch = getScheduler();
  sch.ensureStarted();
  const id = randomUUID();
  const MAX_TASKS_PER_CPT = 50;
  const task = {
    id,
    cron: cronExpr,
    action,
    actionArgs: actionArgs || {},
    enabled: true,
    note: note || '',
    createdAt: new Date().toISOString(),
    nextRun: computeNextRun(cronExpr),
    history: [],
  };
  // read+modify+write 必须在同一把锁内（mutateStore 自带 withLock）；
  // 上限复查必须在锁内做 —— 只在锁外预检存在 TOCTOU（两个进程同时 add 都通过预检）
  const stored = await mutateStore(cpt, (store) => {
    if (store.tasks.length >= MAX_TASKS_PER_CPT) {
      throw new Error(`单 .cpt 任务数已达上限 ${MAX_TASKS_PER_CPT}。请先 schedule_remove 删除不用的任务`);
    }
    store.tasks.push(task);
    return store;
  });
  // 锁释放后再订阅（订阅操作有 node-cron 自身线程安全）
  sch._scheduleOne(cpt, task);
  return { id, task, storePath: schedulePathFor(cpt) };
}

export async function listTasks(cptPath) {
  const cpt = resolve(cptPath);
  await getScheduler().ensureLoadedFor(cpt);
  const sch = getScheduler();
  const store = await readStore(cpt);
  const tracked = new Set(sch.trackedIdsFor(cpt));
  return {
    cpt,
    storePath: schedulePathFor(cpt),
    updatedAt: store.updatedAt,
    active: sch.activeCount(),
    tasks: store.tasks.map((t) => ({
      ...t,
      tracked: tracked.has(t.id),
      runState: sch.status(t.id),
    })),
  };
}

export async function getTask(cptPath, taskId) {
  const cpt = resolve(cptPath);
  await getScheduler().ensureLoadedFor(cpt);
  const sch = getScheduler();
  const store = await readStore(cpt);
  const t = store.tasks.find((x) => x.id === taskId);
  if (!t) throw new Error(`任务不存在: ${taskId}`);
  return { ...t, tracked: sch.trackedIdsFor(cpt).includes(taskId), runState: sch.status(taskId) };
}

export async function removeTask(cptPath, taskId) {
  const cpt = resolve(cptPath);
  await getScheduler().ensureLoadedFor(cpt);
  const sch = getScheduler();
  let removed = null;
  await mutateStore(cpt, (store) => {
    const idx = store.tasks.findIndex((x) => x.id === taskId);
    if (idx < 0) throw new Error(`任务不存在: ${taskId}`);
    removed = store.tasks.splice(idx, 1)[0];
    return store;
  });
  const entry = sch.cronTasks.get(taskId);
  if (entry) { try { entry.task.stop(); } catch { /* ignore */ } sch.cronTasks.delete(taskId); }
  const finalStore = await readStore(cpt);
  return { removed, remaining: finalStore.tasks.length };
}

async function setEnabled(cptPath, taskId, enabled) {
  const cpt = resolve(cptPath);
  await getScheduler().ensureLoadedFor(cpt);
  const sch = getScheduler();
  let t;
  await mutateStore(cpt, (store) => {
    t = store.tasks.find((x) => x.id === taskId);
    if (!t) throw new Error(`任务不存在: ${taskId}`);
    t.enabled = enabled;
    t.updatedAt = new Date().toISOString();
    return store;
  });
  if (enabled) sch._scheduleOne(cpt, t);
  else {
    const entry = sch.cronTasks.get(taskId);
    if (entry) { try { entry.task.stop(); } catch { /* ignore */ } sch.cronTasks.delete(taskId); }
  }
  return t;
}

export const enableTask = (cptPath, taskId) => setEnabled(cptPath, taskId, true);
export const disableTask = (cptPath, taskId) => setEnabled(cptPath, taskId, false);

export async function runTask(cptPath, taskId) {
  await getScheduler().ensureLoadedFor(cptPath);
  const sch = getScheduler();
  return sch.runNow(cptPath, taskId);
}

export async function schedulerStatus() {
  const sch = getScheduler();
  return {
    started: sch.started,
    activeTasks: sch.activeCount(),
    activeTaskIds: [...sch.cronTasks.keys()],
    uptimeSec: Math.round(process.uptime()),
    pid: process.pid,
    nodeVersion: process.version,
  };
}

export async function schedulerHistory(cptPath, taskId, limit = 20) {
  const cpt = resolve(cptPath);
  await getScheduler().ensureLoadedFor(cpt);
  const sch = getScheduler();
  const store = await readStore(cpt);
  const t = store.tasks.find((x) => x.id === taskId);
  if (!t) throw new Error(`任务不存在: ${taskId}`);
  return {
    taskId, action: t.action, cron: t.cron,
    runState: sch.status(taskId),
    history: (t.history || []).slice(0, limit),
  };
}

export function stopScheduler() {
  const sch = getScheduler();
  sch.stop();
  return { stopped: true };
}

