import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import { DeepToolManager } from '../lib/deep-tools.js';
import { createCpt } from '../lib/generate.js';
import '../scripts/isolate-store.mjs'; // M123：JS 基线 store 隔离，直跑也不污染真实 store

function decode(result) {
  assert.equal(result.isError, undefined, `调用不应报错: ${result.content?.[0]?.text}`);
  return JSON.parse(result.content[0].text);
}

// —— 单元：leaseStatus + warningFor 阈值 ——
test('P0-1·单元：leaseStatus 回剩次/过期秒数，warningFor 只在剩≤20%时预警', () => {
  let now = Date.now();
  const mgr = new DeepToolManager({ now: () => now });
  assert.deepEqual(mgr.leaseStatus(), [], '初始无租约');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-lease-status-'));
  const cpt = path.join(dir, 's.cpt');
  createCpt(cpt, { rows: 2, columns: 2 });
  const granted = mgr.grant({
    group: 'diagnostics', filePath: cpt, tools: ['list_cpt_issues'],
    ttlSeconds: 3600, maxCalls: 20, reason: 'diagnostics_read',
  });
  assert.equal(granted.maxCalls, 20);

  let status = mgr.leaseStatus();
  assert.equal(status.length, 1);
  assert.equal(status[0].group, 'diagnostics');
  assert.equal(status[0].remaining, 20);
  assert.equal(status[0].maxCalls, 20);
  assert.ok(status[0].expiresInSeconds > 3500 && status[0].expiresInSeconds <= 3600);
  assert.deepEqual(status[0].tools, ['list_cpt_issues']);

  // 消耗 15 次 → 剩 5/20（25%），不预警
  const lease = [...mgr.leases.values()][0];
  assert.equal(mgr.warningFor(lease), null, '满额时无预警');
  for (let i = 0; i < 15; i++) {
    const l = mgr.beforeCall('list_cpt_issues', { path: cpt });
    mgr.afterCall(l);
  }
  assert.equal(mgr.leaseStatus()[0].remaining, 5);
  assert.equal(mgr.warningFor(lease), null, '剩 25% 时仍不预警');

  // 再消耗 1 次 → 剩 4/20（20%），预警出现且指路自查
  const l16 = mgr.beforeCall('list_cpt_issues', { path: cpt });
  mgr.afterCall(l16);
  const warn = mgr.warningFor(lease);
  assert.match(warn, /剩 4\/20/, '预警应报剩次');
  assert.match(warn, /get_capabilities\(\{leases:true\}\)/, '预警应指路剩余额度自查');

  // 耗尽 → 状态清空（reconcile 动态注销）
  for (let i = 0; i < 4; i++) {
    const l = mgr.beforeCall('list_cpt_issues', { path: cpt });
    mgr.afterCall(l);
  }
  assert.deepEqual(mgr.leaseStatus(), [], '耗尽后无有效租约');
});

test('P0-1·单元：小额度租约（3次）剩1次即预警，单次租约不预警', () => {
  const mgr = new DeepToolManager({});
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-lease-small-'));
  const cpt = path.join(dir, 's.cpt');
  createCpt(cpt, { rows: 1, columns: 1 });
  mgr.grant({ group: 'adhoc', filePath: cpt, tools: ['list_cpt_issues'], ttlSeconds: 180, maxCalls: 3, reason: 'adhoc_read' });
  const lease = [...mgr.leases.values()][0];
  assert.equal(mgr.warningFor(lease), null);
  for (let i = 0; i < 2; i++) {
    const l = mgr.beforeCall('list_cpt_issues', { path: cpt });
    mgr.afterCall(l);
  }
  assert.match(mgr.warningFor(lease) ?? '', /剩 1\/3/, '3次额度剩1次即预警');

  const mgr1 = new DeepToolManager({});
  mgr1.grant({ group: 'adhoc', filePath: cpt, tools: ['list_cpt_issues'], ttlSeconds: 120, maxCalls: 1, reason: 'adhoc_read' });
  const one = [...mgr1.leases.values()][0];
  assert.equal(mgr1.warningFor(one), null, '单次租约调用前不预警');
  const o = mgr1.beforeCall('list_cpt_issues', { path: cpt });
  mgr1.afterCall(o);
  assert.deepEqual(mgr1.leaseStatus(), [], '单次调用后租约消失');
});

// —— 集成：get_capabilities({leases:true}) + 深层结果 leaseWarning ——
test('P0-1·集成：leases 按需下发，剩≤20%时深层结果自带 leaseWarning', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-lease-mcp-'));
  const cpt = path.join(dir, 's.cpt');
  createCpt(cpt, { rows: 2, columns: 2 });

  const client = new Client({ name: 'lease-status-test', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: ['server.js'], cwd: process.cwd(), stderr: 'pipe' });
  await client.connect(transport);
  try {
    // 不带 leases：无 activeLeases 键（按需下发，不污染常规返回）
    const base = decode(await client.callTool({ name: 'get_capabilities', arguments: {} }));
    assert.ok(!('activeLeases' in base), '不带 leases 时不应下发活租约');

    // 初始查：空数组
    const empty = decode(await client.callTool({ name: 'get_capabilities', arguments: { leases: true } }));
    assert.deepEqual(empty.activeLeases, [], '初始应无活租约');

    const granted = decode(await client.callTool({
      name: 'request_deep_tool_access',
      arguments: { path: cpt, group: 'diagnostics', reason: 'diagnostics_read' },
    }));
    assert.equal(granted.status, 'granted');

    const full = decode(await client.callTool({ name: 'get_capabilities', arguments: { leases: true } }));
    assert.equal(full.activeLeases.length, 1);
    assert.equal(full.activeLeases[0].group, 'diagnostics');
    assert.equal(full.activeLeases[0].remaining, 20);
    assert.equal(full.activeLeases[0].maxCalls, 20);
    assert.ok(full.activeLeases[0].expiresInSeconds > 3500);

    // 前 15 次无预警，第 16 次（剩 4/20）开始带 leaseWarning
    for (let i = 1; i <= 16; i++) {
      const r = decode(await client.callTool({ name: 'list_cpt_issues', arguments: { path: cpt } }));
      if (i < 16) assert.ok(!('leaseWarning' in r), `第 ${i} 次不应带预警`);
      else assert.match(r.leaseWarning, /剩 4\/20/, '第 16 次应带剩 4/20 预警');
    }
    const after = decode(await client.callTool({ name: 'get_capabilities', arguments: { leases: true } }));
    assert.equal(after.activeLeases[0].remaining, 4, '自查剩次应与实际消耗一致');
  } finally {
    await client.close();
  }
});
