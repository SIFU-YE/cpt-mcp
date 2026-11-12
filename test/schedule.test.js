// cpt-mcp/test/schedule.test.js —— 定时任务调度器（auto-runner 模式）单元测试
// 覆盖：cron 解析/nextRun、文件锁、add/list/get/remove/enable/disable、runNow 真实执行、并发、损坏 JSON 容错、decompile 缺工具降级
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  addTask, listTasks, getTask, removeTask, enableTask, disableTask, runTask,
  schedulerStatus, schedulerHistory, stopScheduler, listActions,
  getScheduler, parseCron, computeNextRun, nextRunFromCron,
} from '../lib/schedule.js';
import { decompileCpt, detectFrHome } from '../lib/fr-decompile.js';
import { createCpt } from '../lib/generate.js';
import '../scripts/isolate-store.mjs'; // M123：JS 基线 store 隔离，直跑也不污染真实 store

// 每个 test 用独立子目录，避免 .cpt-schedule.json 跨 case 污染
function makeDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-mcp-sched-')); }
const newCpt = (dir, n) => {
  const p = path.join(dir, n);
  createCpt(p, { rows: 2, columns: 2, withWebAttr: false });
  return p;
};

// ---- 纯函数 ----

test('parseCron: 标准 5 字段', () => {
  const f = parseCron('0 3 * * *');
  assert.deepEqual(f.minutes, [0]);
  assert.deepEqual(f.hours, [3]);
  assert.equal(f.days.length, 31);
  assert.equal(f.months.length, 12);
  assert.equal(f.weeks.length, 7);
});

test('parseCron: */n 与 a-b', () => {
  const f = parseCron('*/15 9-17 * * 1-5');
  assert.deepEqual(f.minutes, [0, 15, 30, 45]);
  assert.deepEqual(f.hours, [9, 10, 11, 12, 13, 14, 15, 16, 17]);
  assert.deepEqual(f.weeks, [1, 2, 3, 4, 5]);
});

test('parseCron: 拒绝非 5 字段', () => {
  assert.throws(() => parseCron('0 3 * *'), /5 字段/);
});

test('nextRunFromCron: */5 * * * * 必须 5 分钟粒度', () => {
  const base = new Date('2025-06-01T10:02:00.000Z');
  const next = nextRunFromCron('*/5 * * * *', base);
  assert.ok(next, '应返回 next');
  assert.equal(next.getMinutes() % 5, 0);
  assert.ok(next.getTime() > base.getTime(), '应严格在未来');
});

test('nextRunFromCron: 0 3 * * * 必须 03:00（本地时区，与 node-cron 触发一致）', () => {
  const base = new Date('2025-06-01T10:00:00.000Z');
  const next = nextRunFromCron('0 3 * * *', base);
  assert.equal(next.getHours(), 3);
  assert.equal(next.getMinutes(), 0);
});

test('nextRunFromCron: 永不匹配的 cron（0 0 30 2 *）快速返回 null', () => {
  const t0 = Date.now();
  const next = nextRunFromCron('0 0 30 2 *', new Date());
  assert.equal(next, null);
  assert.ok(Date.now() - t0 < 2000, '逐日扫描应在 2 秒内得出结论');
});

test('computeNextRun: 非法 cron 返回 null', () => {
  assert.equal(computeNextRun('not a cron'), null);
});

test('listActions: 4 个核心动作', () => {
  const a = listActions().map((x) => x.name);
  assert.ok(a.includes('validate'));
  assert.ok(a.includes('style_review'));
  assert.ok(a.includes('reasonableness_review'));
  assert.ok(a.includes('decompile'));
});

// ---- 存储 / 调度生命周期 ----

test('addTask: 持久化到 .cpt-schedule.json，并立即被调度器 tracked', async () => {
  const dir = makeDir();
  const p = newCpt(dir, 'a.cpt');
  const r = await addTask(p, { cron: '*/10 * * * *', action: 'validate', note: 'unit' });
  assert.ok(r.id);
  const storePath = path.join(dir, '.cpt-schedule.json');
  assert.ok(fs.existsSync(storePath), 'store 文件应已落盘');
  const stored = JSON.parse(fs.readFileSync(storePath, 'utf8'));
  assert.equal(stored.tasks.length, 1);
  assert.equal(stored.tasks[0].cron, '*/10 * * * *');
  assert.equal(stored.tasks[0].action, 'validate');
  assert.deepEqual(getScheduler().trackedIdsFor(p), [r.id]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('addTask: 非法 cron 抛错', async () => {
  const dir = makeDir();
  const p = newCpt(dir, 'bad.cpt');
  await assert.rejects(() => addTask(p, { cron: 'every minute', action: 'validate' }), /cron/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('addTask: 未知 action 抛错', async () => {
  const dir = makeDir();
  const p = newCpt(dir, 'b.cpt');
  await assert.rejects(() => addTask(p, { cron: '0 * * * *', action: 'no_such_action' }), /未知动作/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('listTasks: 含 tracked + runState 字段', async () => {
  const dir = makeDir();
  const p = newCpt(dir, 'c.cpt');
  await addTask(p, { cron: '0 * * * *', action: 'validate' });
  const r = await listTasks(p);
  assert.equal(r.tasks.length, 1);
  assert.equal(r.tasks[0].tracked, true);
  assert.equal(r.tasks[0].enabled, true);
  assert.ok(r.tasks[0].nextRun, '应有 nextRun');
  assert.equal(r.tasks[0].runState, null, '未执行过则 runState=null');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('runNow: validate 真实执行并写回 history', async () => {
  const dir = makeDir();
  const p = newCpt(dir, 'd.cpt');
  const r = await addTask(p, { cron: '0 3 * * *', action: 'validate' });
  const state = await runTask(p, r.id);
  assert.ok(['ok', 'error'].includes(state.status));
  assert.ok(state.durationMs >= 0);
  assert.ok(state.summary, '应返回 summary');
  const t = await getTask(p, r.id);
  assert.equal(t.history.length, 1);
  assert.ok(t.lastRun);
  assert.equal(typeof t.history[0].log, 'string');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('disable / enable: 跟踪状态切换', async () => {
  const dir = makeDir();
  const p = newCpt(dir, 'e.cpt');
  const r = await addTask(p, { cron: '0 3 * * *', action: 'validate' });
  assert.equal(getScheduler().trackedIdsFor(p).length, 1);
  await disableTask(p, r.id);
  assert.equal(getScheduler().trackedIdsFor(p).length, 0, 'disable 后应从订阅移除');
  const t = await getTask(p, r.id);
  assert.equal(t.enabled, false);
  await enableTask(p, r.id);
  assert.equal(getScheduler().trackedIdsFor(p).length, 1, 'enable 后重新订阅');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('removeTask: 同时从 store 与调度器删除', async () => {
  const dir = makeDir();
  const p = newCpt(dir, 'f.cpt');
  const r = await addTask(p, { cron: '0 3 * * *', action: 'validate' });
  const rem = await removeTask(p, r.id);
  assert.equal(rem.remaining, 0);
  assert.equal(getScheduler().trackedIdsFor(p).length, 0);
  await assert.rejects(() => getTask(p, r.id), /任务不存在/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('schedulerStatus: 含 activeTasks/pid/nodeVersion', async () => {
  const s = await schedulerStatus();
  assert.equal(typeof s.activeTasks, 'number');
  assert.equal(typeof s.pid, 'number');
  assert.ok(s.nodeVersion.startsWith('v'));
});

test('schedulerHistory: limit 截断', async () => {
  const dir = makeDir();
  const p = newCpt(dir, 'g.cpt');
  const r = await addTask(p, { cron: '0 3 * * *', action: 'validate' });
  for (let i = 0; i < 3; i++) await runTask(p, r.id);
  const h = await schedulerHistory(p, r.id, 2);
  assert.equal(h.history.length, 2);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---- 并发：文件锁 ----

test('文件锁: 并发 addTask 不会破坏 store', async () => {
  const dir = makeDir();
  const p = newCpt(dir, 'h.cpt');
  await Promise.all(Array.from({ length: 5 }, (_, i) =>
    addTask(p, { cron: `*/${i + 1} * * * *`, action: 'validate', note: `t${i}` })
  ));
  const r = await listTasks(p);
  assert.equal(r.tasks.length, 5);
  for (const t of r.tasks) {
    const detail = await getTask(p, t.id);
    assert.equal(detail.id, t.id);
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---- 损坏 JSON 容错 ----

test('readStore: store 文件损坏时返回空 store 而不抛', async () => {
  const sub = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-mcp-corrupt-'));
  const bad = path.join(sub, 'bad.cpt');
  createCpt(bad, { rows: 1, columns: 1, withWebAttr: false });
  const badStore = path.join(sub, '.cpt-schedule.json');
  fs.writeFileSync(badStore, '{ this is not json');
  const r = await listTasks(bad);
  assert.equal(r.tasks.length, 0, '损坏文件应被忽略，返回空');
  const corruptBackup = fs.readdirSync(sub).find((n) => n.startsWith('.cpt-schedule.json.corrupt.'));
  assert.ok(corruptBackup, '损坏文件应被备份为 .corrupt.<ts>');
  fs.rmSync(sub, { recursive: true, force: true });
});

// ---- fr-decompile 探测 ----

test('detectFrHome: 当前测试环境通常未装 FR，返回结构化结果', () => {
  const d = detectFrHome();
  assert.ok(d);
  assert.ok(['env:FR_HOME', 'default', 'not-found'].includes(d.source));
});

test('decompileCpt: cpt 不存在时返回结构化错误', async () => {
  const r = await decompileCpt('C:/no/such/file.cpt');
  assert.equal(r.ok, false);
  assert.equal(r.status, 'cpt-not-found');
});

test('decompileCpt: 缺工具时返回 missing-tool + hint', async () => {
  if (detectFrHome().tool) return; // 已装则跳过
  const dir = makeDir();
  const p = newCpt(dir, 'j.cpt');
  const r = await decompileCpt(p);
  assert.equal(r.ok, false);
  assert.equal(r.status, 'missing-tool');
  assert.ok(r.hint.includes('FR_HOME'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test.after(async () => {
  stopScheduler();
});
