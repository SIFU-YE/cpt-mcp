// test/fill-binding-profile.test.js —— 填报绑定治理在 report 档（M101 语义 + M113 租约化）
//
// 背景（M101）：update/delete_fill_binding 原先只在 full 档，report 会话调即 unknown tool——
// 售后卡 material_code 去主键改纯 INSERT 被迫报“必须手工开设计器”。
// M113 工具上下文瘦身：填报提交/字段绑定整族（fill_binding）从静态表下沉为**场景族租约**——
// 问题不再是"report 档有没有这个工具"，而是"report 档一次租约能不能把这一族拿到手并跑通闭环"。
// 本文件端到端锁定后者：静态表里看不到 → request_deep_tool_access 解锁整族 → 读改写闭环成立。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createCpt, addCell, addDataset } from '../lib/generate.js';
import '../scripts/isolate-store.mjs'; // M123：JS 基线 store 隔离，直跑也不污染真实 store

delete process.env.CPT_MCP_ALLOWED_ROOTS;

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-fillbind-'));

test('M101/M113 填报绑定族在 report 档经租约端到端可调（material_code 去主键改纯 INSERT）', async () => {
  const d = tmp();
  const p = path.join(d, 'x.cpt');
  createCpt(p, { rows: 2, columns: 6, webWrite: true });
  addDataset(p, { name: 'ds1', connection: 'Doris', sql: 'SELECT 1' });
  addCell(p, { column: 0, row: 0, content: 'M' });

  const client = new Client({ name: 'fillbind-test', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath, args: ['server.js'], cwd: process.cwd(), stderr: 'pipe',
    env: { CPT_MCP_TOOL_PROFILE: 'report' },
  });
  await client.connect(transport);
  const call = async (name, args) => {
    const r = await client.callTool({ name, arguments: args });
    assert.ok(!r.isError, `${name} 不应报错：${r.content?.[0]?.text}`);
    return JSON.parse(r.content[0].text);
  };
  try {
    let names = (await client.listTools()).tools.map((t) => t.name);
    // 瘦身后：填报族不在静态表里（省每请求 token），但有具名租约通道
    for (const t of ['add_fill_submit', 'update_fill_binding', 'delete_fill_binding', 'set_fill_toolbar']) {
      assert.ok(!names.includes(t), `${t} 应已下沉到 fill_binding 族（不在 report 静态表）`);
    }
    // 读侧 get_fill_config 仍在静态表（租约只管写侧）
    assert.ok(names.includes('get_fill_config'), 'get_fill_config 应常驻静态表');
    // 未解锁时调用 → 报 not found（真隐藏，不是 disabled 占位）
    const before = await client.callTool({ name: 'update_fill_binding', arguments: { path: p, field: 'material_code', isKey: false } });
    assert.equal(before.isError, true, '未解锁时不应可调');
    // 一次租约解锁整族
    const lease = await call('request_deep_tool_access', { path: p, group: 'fill_binding' });
    assert.equal(lease.status, 'granted');
    assert.equal(lease.group, 'fill_binding');
    names = (await client.listTools()).tools.map((t) => t.name);
    for (const t of ['add_fill_submit', 'update_fill_binding', 'delete_fill_binding']) {
      assert.ok(names.includes(t), `租约后 ${t} 应动态可见`);
    }
    // 建提交
    await call('add_fill_submit', { path: p, dsName: 'ds1', table: 't', bindings: [{ field: 'material_code', column: 0, row: 0, isKey: true }] });
    // 去键：isKey true→false（售后卡场景同构）
    const u = await call('update_fill_binding', { path: p, submitIndex: 0, field: 'material_code', isKey: false });
    assert.equal(u.action, 'update_fill_binding');
    const cfg = await call('get_fill_config', { path: p });
    const keys = (cfg.submits?.[0]?.columns ?? []).filter((c) => c.isKey === true || c.isKey === 'true');
    assert.equal(keys.length, 0, `去键后应 0 主键：${JSON.stringify(cfg.submits?.[0]?.columns)}`);
    // 删绑定
    await call('delete_fill_binding', { path: p, submitIndex: 0, field: 'material_code' });
    const cfg2 = await call('get_fill_config', { path: p });
    assert.ok(!(cfg2.submits?.[0]?.columns ?? []).some((c) => c.field === 'material_code'), '绑定应已删除');
  } finally {
    await client.close();
  }
  fs.rmSync(d, { recursive: true, force: true });
});
