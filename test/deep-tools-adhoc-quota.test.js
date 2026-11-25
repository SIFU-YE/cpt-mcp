// test/deep-tools-adhoc-quota.test.js —— 审查修复①：adhoc 租出的非深层工具必须强制额度
// 回归点：P0-2 取消动态注销后，非深层 adhoc 工具若不强制，会变成"一次授权、永久免费"。
import test from 'node:test';
import assert from 'node:assert/strict';
import { DeepToolManager, DEEP_TOOL_NAMES } from '../lib/deep-tools.js';
import '../scripts/isolate-store.mjs';

function manager() {
  const m = new DeepToolManager();
  m.onDynamicRegister = () => {};
  m.onDynamicUnregister = () => {};
  return m;
}

test('非深层 adhoc 工具：额度耗尽后报续租指引，而不是无限放行', () => {
  const m = manager();
  const filePath = 'C:/work/a.cpt';
  const grant = m.grant({ group: 'adhoc', filePath, tools: ['add_fill_submit'], reason: 'adhoc_write', maxCalls: 2, ttlSeconds: 3600 });
  assert.ok(grant.leaseId, '应授出租约');

  const a1 = m.beforeCall('add_fill_submit', { path: filePath });
  assert.ok(a1, '第 1 次应拿到租约');
  m.afterCall(a1);

  const a2 = m.beforeCall('add_fill_submit', { path: filePath });
  assert.ok(a2, '第 2 次应拿到租约');
  m.afterCall(a2);

  assert.throws(
    () => m.beforeCall('add_fill_submit', { path: filePath }),
    /无可用租约|重新授权/,
    '第 3 次（额度 2 用尽）应报续租指引',
  );
});

test('从未授予、且不在可租约宇宙里的工具不走租约强制（profile 静态工具不受影响）', () => {
  const m = manager();
  const freeName = ['get_capabilities', 'read_cpt', 'quality_gate_cpt'].find((n) => !DEEP_TOOL_NAMES.has(n));
  assert.ok(freeName, '应能找到一个不在 DEEP_TOOL_NAMES 里的名字');
  const lease = m.beforeCall(freeName, { path: 'C:/work/a.cpt' });
  assert.equal(lease, null, '未进 dynamicVisible 且非深层的工具不走租约强制');
});

test('续租命令含工具名与路径（可直接复制）', () => {
  const m = manager();
  const filePath = 'D:/带空格 的目录/表.cpt';
  m.grant({ group: 'adhoc', filePath, tools: ['add_fill_submit'], reason: 'adhoc_write', maxCalls: 1, ttlSeconds: 3600 });
  m.afterCall(m.beforeCall('add_fill_submit', { path: filePath }));
  try {
    m.beforeCall('add_fill_submit', { path: filePath });
    assert.fail('应抛错');
  } catch (e) {
    assert.match(e.message, /request_deep_tool_access\(\{path:"D:\/带空格 的目录\/表\.cpt"/, 'path 应被 JSON.stringify 保护');
    assert.match(e.message, /tools:\['add_fill_submit'\]/);
  }
});
