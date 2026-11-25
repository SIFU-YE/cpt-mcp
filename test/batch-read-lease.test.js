// test/batch-read-lease.test.js —— M95 批量读取租约组 batch_read
//
// 背景：18 个 get_*_batch 已注册且只读，但既不在任何 profile，也不在任何租约组——
// 在 focused/report/generate 档彻底不可达，排错会话调 get_cell_listener_batch 等
// 直接 unknown tool（v4 实测），只能退回单格逐个读，深挖 29 监听器/10 按钮时步数爆炸。
// 修法：下沉为 batch_read 租约组（reason=batch_read，绑定单文件，20 次/3600 秒兜底，
// 与其余 17 族统一的次数型额度）。profile 静态计数不变（零 token 成本）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createCpt, addCell } from '../lib/generate.js';
import { DeepToolManager, DEEP_TOOL_GROUPS } from '../lib/deep-tools.js';
import '../scripts/isolate-store.mjs'; // M123：JS 基线 store 隔离，直跑也不污染真实 store

delete process.env.CPT_MCP_ALLOWED_ROOTS;

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-batchread-'));
function decode(result) {
  assert.ok(!result.isError, result.content?.[0]?.text);
  return JSON.parse(result.content[0].text);
}

test('M95 batch_read 组定义：18 个 get_*_batch 且与契约一致', async () => {
  const { DEEP_TOOLS } = await import('../lib/contract.js');
  assert.equal(DEEP_TOOL_GROUPS.batch_read.size, 18);
  for (const name of DEEP_TOOL_GROUPS.batch_read) {
    assert.ok(DEEP_TOOLS.has(name), `${name} 应进 DEEP_TOOLS（默认隐藏）`);
  }
  for (const t of ['get_cell_listener_batch', 'get_toolbar_button_batch', 'get_report_listener_batch']) {
    assert.ok(DEEP_TOOL_GROUPS.batch_read.has(t), `排错高频 ${t} 必须在组内`);
  }
});

test('M95 租约语义：reason/路径双约束，读无副作用', () => {
  const mgr = new DeepToolManager();
  assert.throws(() => mgr.request({ group: 'batch_read', path: '/x.cpt', reason: 'exact_cell_read' }), /仅允许 reason=batch_read/);
  assert.throws(() => mgr.request({ group: 'batch_read', reason: 'batch_read' }), /必须绑定 path/);
  assert.throws(() => mgr.request({ group: 'nope', path: '/x.cpt', reason: 'batch_read' }), /未知深层工具组/);
  const g = mgr.request({ group: 'batch_read', path: '/x.cpt', reason: 'batch_read' });
  assert.equal(g.status, 'granted');
  assert.equal(g.enabledTools.length, 18);
});

test('M98 租约自诊断：未知组自报家门 verdict 新旧；granted 附重同步指引', () => {
  const mgr = new DeepToolManager();
  // 旧服务端（无 batch_read 组）报出的清单里就没有 batch_read——调用方凭此直接判定需重启 MCP
  assert.throws(
    () => mgr.request({ group: 'nope', path: '/x.cpt', reason: 'x' }),
    /已知组：.*batch_read/,
  );
  const g = mgr.request({ group: 'batch_read', path: '/x.cpt', reason: 'batch_read' });
  assert.match(g.note, /unknown tool.*重试|重试.*unknown tool/, 'granted 应附桥接重同步竞态指引');
});

test('M95 端到端：generate 档默认不可见 → 租约解锁 → 批量可读 → 限单文件', async () => {
  const dir = tmp();
  const cpt = path.join(dir, 'b.cpt');
  const other = path.join(dir, 'o.cpt');
  createCpt(cpt, { rows: 2, columns: 2 });
  createCpt(other, { rows: 2, columns: 2 });
  addCell(cpt, { column: 0, row: 0, content: 'A1' });

  const client = new Client({ name: 'batchread-test', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: ['server-generate.js'], cwd: process.cwd(), stderr: 'pipe' });
  await client.connect(transport);
  try {
    let names = (await client.listTools()).tools.map((t) => t.name);
    for (const t of ['get_cell_batch', 'get_cell_listener_batch', 'get_toolbar_button_batch', 'get_report_listener_batch']) {
      assert.ok(!names.includes(t), `${t} 默认隐藏`);
    }
    const locked = await client.callTool({ name: 'get_cell_batch', arguments: { path: cpt, targets: [{ column: 0, row: 0 }] } });
    assert.equal(locked.isError, true);
    assert.match(locked.content[0].text, /not found/);

    const access = decode(await client.callTool({
      name: 'request_deep_tool_access',
      arguments: { group: 'batch_read', path: cpt, reason: 'batch_read' },
    }));
    assert.equal(access.status, 'granted');
    assert.equal(access.enabledTools.length, 18);

    names = (await client.listTools()).tools.map((t) => t.name);
    assert.ok(names.includes('get_cell_batch'), '租约后批量读可见');
    const got = decode(await client.callTool({
      name: 'get_cell_batch', arguments: { path: cpt, targets: [{ column: 0, row: 0 }, { column: 9, row: 9 }] },
    }));
    const text = JSON.stringify(got);
    assert.match(text, /"status":"read"/, '命中格应读出');
    assert.match(text, /skipped/, '未命中格记 skipped 不中断');

    // 租约绑定单文件：换文件调用被拒
    const cross = await client.callTool({
      name: 'get_cell_batch', arguments: { path: other, targets: [{ column: 0, row: 0 }] },
    });
    assert.equal(cross.isError, true);
    assert.match(cross.content[0].text, /未授权|request_deep_tool_access/);
  } finally {
    await client.close();
  }
  fs.rmSync(dir, { recursive: true, force: true });
});
