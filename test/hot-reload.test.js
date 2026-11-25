// test/hot-reload.test.js —— cpt-mcp 源码热重启（2026-11-07）
//
// 覆盖：fingerprintSources/diffFingerprint 纯函数、忽略 test/node_modules、变化触发、
//       静默期合并多次写、启动宽限、手动 marker（触发并删除）、stop、CPT_MCP_HOT_RELOAD=0 关闭。
// 全部用短 interval/quiet/grace（真实计时器）避免慢测试；每个用例结束 stop 清理 timer。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  fingerprintSources, diffFingerprint, installHotReload,
  DEFAULT_INTERVAL_MS, DEFAULT_QUIET_MS, DEFAULT_GRACE_MS, MARKER_REL,
} from '../lib/hot-reload.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-hot-reload-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function write(p, content) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

async function waitFor(fn, timeoutMs = 3000, stepMs = 20) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await sleep(stepMs);
  }
  return false;
}

function tree(root) {
  write(path.join(root, 'server.js'), '// server entry\n');
  write(path.join(root, 'lib', 'a.js'), 'export const a = 1;\n');
  write(path.join(root, 'lib', 'nested', 'b.js'), 'export const b = 1;\n');
  write(path.join(root, 'test', 'x.test.js'), '// 测试目录不监控\n');
  write(path.join(root, 'tests', 'y.js'), '// 测试目录不监控\n');
  write(path.join(root, 'node_modules', 'dep', 'index.js'), '// 依赖不监控\n');
  write(path.join(root, 'lib', 'notes.txt'), '非 .js 不监控\n');
  write(path.join(root, '.cpt-mcp', 'something.json'), '点目录不监控\n');
}

function rm(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

test('fingerprintSources：只抓 server.js + lib/**/*.js，忽略 test/tests/node_modules/非 js/点目录', () => {
  const root = tmp();
  try {
    tree(root);
    const fp = fingerprintSources(root);
    assert.deepEqual(Object.keys(fp).sort(), ['lib/a.js', 'lib/nested/b.js', 'server.js']);
    assert.equal(typeof fp['server.js'].size, 'number');
    assert.equal(typeof fp['lib/a.js'].mtimeMs, 'number');
    assert.ok(fp['lib/a.js'].mtimeMs > 0);
    // 不存在的根 / 缺失 server.js / 缺失 lib 不报错
    assert.deepEqual(fingerprintSources(path.join(root, 'definitely-missing')), {});
  } finally {
    rm(root);
  }
});

test('diffFingerprint：changed/added/removed 分类与 any', () => {
  const prev = { 'server.js': { size: 1, mtimeMs: 10 }, 'lib/a.js': { size: 2, mtimeMs: 20 } };
  const next = {
    'server.js': { size: 1, mtimeMs: 10 },
    'lib/a.js': { size: 3, mtimeMs: 20 }, // size 变
    'lib/b.js': { size: 1, mtimeMs: 1 },  // 新增
  };
  const d = diffFingerprint(prev, next);
  assert.deepEqual(d.changed, ['lib/a.js']);
  assert.deepEqual(d.added, ['lib/b.js']);
  assert.deepEqual(d.removed, []);
  assert.equal(d.any, true);

  assert.equal(diffFingerprint(prev, prev).any, false);
  const d2 = diffFingerprint(prev, { 'server.js': { size: 1, mtimeMs: 99 } });
  assert.deepEqual(d2.changed, ['server.js']);
  assert.deepEqual(d2.removed, ['lib/a.js']);
  assert.equal(diffFingerprint().any, false, '缺省参数安全');
});

test('installHotReload：lib 源码写盘后触发 onRestart 一次，日志说明文件与自动重连', async () => {
  const root = tmp();
  const calls = [];
  const logs = [];
  const h = installHotReload({
    root, cwd: root, enabled: true,
    intervalMs: 20, quietMs: 40, graceMs: 0,
    onRestart: (info) => calls.push(info),
    logger: (line) => logs.push(line),
  });
  try {
    assert.equal(h.enabled, true);
    await sleep(40); // 让 watcher 先跑几轮基线
    write(path.join(root, 'lib', 'a.js'), 'export const a = 2;\n');
    assert.ok(await waitFor(() => calls.length === 1), '写盘后应触发重启');
    assert.equal(calls.length, 1, '只触发一次（never 重复 onRestart）');
    assert.equal(calls[0].reason, 'source-change');
    assert.ok(calls[0].files.includes('lib/a.js'), JSON.stringify(calls[0].files));
    assert.match(calls[0].at, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(logs.length, 1, '重启只记一行 stderr');
    assert.match(logs[0], /lib\/a\.js/);
    assert.match(logs[0], /自动重连/);
    // 重启后 watcher 已自行停止
    write(path.join(root, 'lib', 'a.js'), 'export const a = 3;\n');
    await sleep(100);
    assert.equal(calls.length, 1);
  } finally {
    h.stop();
    rm(root);
  }
});

test('installHotReload：静默期内多次写盘合并为一次重启', async () => {
  const root = tmp();
  const calls = [];
  const h = installHotReload({
    root, cwd: root, enabled: true,
    intervalMs: 15, quietMs: 120, graceMs: 0,
    onRestart: (info) => calls.push(info),
    logger: () => {},
  });
  try {
    await sleep(30);
    for (let i = 2; i <= 4; i += 1) {
      write(path.join(root, 'lib', 'a.js'), `export const a = ${i};\n`);
      await sleep(30); // 三次写都在静默期内
    }
    assert.ok(await waitFor(() => calls.length === 1), '静默结束后应触发');
    await sleep(150);
    assert.equal(calls.length, 1, '多次写只重启一次');
  } finally {
    h.stop();
    rm(root);
  }
});

test('installHotReload：启动宽限期内不重启，宽限结束才触发', async () => {
  const root = tmp();
  const calls = [];
  const startedAt = Date.now();
  const graceMs = 250;
  const h = installHotReload({
    root, cwd: root, enabled: true,
    intervalMs: 20, quietMs: 20, graceMs,
    onRestart: (info) => calls.push({ ...info, atMs: Date.now() }),
    logger: () => {},
  });
  try {
    write(path.join(root, 'lib', 'a.js'), 'export const a = 2;\n'); // 刚启动就变化
    await sleep(150);
    assert.equal(calls.length, 0, '宽限期内不得重启（避免同步到一半被打回）');
    assert.ok(await waitFor(() => calls.length === 1, 3000), '宽限结束后应触发');
    assert.ok(calls[0].atMs - startedAt >= graceMs - 10, `重启时间 ${calls[0].atMs - startedAt}ms 应 >= 宽限 ${graceMs}ms`);
  } finally {
    h.stop();
    rm(root);
  }
});

test('installHotReload：<cwd>/.cpt-mcp/hot-reload.request 手动触发并删除 marker', async () => {
  const root = tmp();
  const calls = [];
  const h = installHotReload({
    root, cwd: root, enabled: true,
    intervalMs: 20, quietMs: 20, graceMs: 0,
    onRestart: (info) => calls.push(info),
    logger: () => {},
  });
  try {
    const marker = path.join(root, MARKER_REL);
    await sleep(30);
    assert.equal(fs.existsSync(marker), false, '目录不存在也不能报错');
    write(marker, 'restart');
    assert.ok(await waitFor(() => calls.length === 1), 'marker 存在应触发重启');
    assert.equal(calls[0].reason, 'marker');
    assert.equal(fs.existsSync(marker), false, 'marker 必须在重启前删除，防止新进程循环');
  } finally {
    h.stop();
    rm(root);
  }
});

test('installHotReload.stop：停止后源码变化不再触发', async () => {
  const root = tmp();
  const calls = [];
  const h = installHotReload({
    root, cwd: root, enabled: true,
    intervalMs: 20, quietMs: 20, graceMs: 0,
    onRestart: () => calls.push(1),
    logger: () => {},
  });
  try {
    h.stop();
    write(path.join(root, 'lib', 'a.js'), 'export const a = 2;\n');
    await sleep(120);
    assert.equal(calls.length, 0);
  } finally {
    h.stop();
    rm(root);
  }
});

test('installHotReload：默认启用（env 未设 0），CPT_MCP_HOT_RELOAD=0 关闭', async () => {
  const root = tmp();
  const calls = [];
  const saved = process.env.CPT_MCP_HOT_RELOAD;
  let on;
  let off;
  try {
    tree(root);
    delete process.env.CPT_MCP_HOT_RELOAD;
    on = installHotReload({
      root, cwd: root, intervalMs: 20, quietMs: 20, graceMs: 0,
      onRestart: (info) => calls.push(info), logger: () => {},
    });
    assert.equal(on.enabled, true, '默认应启用');

    process.env.CPT_MCP_HOT_RELOAD = '0';
    off = installHotReload({
      root, cwd: root, intervalMs: 20, quietMs: 20, graceMs: 0,
      onRestart: () => calls.push({ reason: 'disabled-should-not-fire' }), logger: () => {},
    });
    assert.equal(off.enabled, false, 'CPT_MCP_HOT_RELOAD=0 应关闭');

    write(path.join(root, 'lib', 'a.js'), 'export const a = 2;\n');
    assert.ok(await waitFor(() => calls.length >= 1), '默认启用的 watcher 应触发');
    assert.equal(calls.length, 1, '关闭后的 watcher 不得触发');
    assert.equal(calls[0].reason, 'source-change');

    // 常量默认值可被外部覆盖（文档口径）
    assert.equal(DEFAULT_INTERVAL_MS, 1000);
    assert.equal(DEFAULT_QUIET_MS, 2000);
    assert.equal(DEFAULT_GRACE_MS, 3000);
  } finally {
    on?.stop();
    off?.stop();
    if (saved === undefined) delete process.env.CPT_MCP_HOT_RELOAD;
    else process.env.CPT_MCP_HOT_RELOAD = saved;
    rm(root);
  }
});
