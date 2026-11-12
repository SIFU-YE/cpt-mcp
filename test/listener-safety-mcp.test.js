// test/listener-safety-mcp.test.js —— MCP 协议层：Listener 大块写入安全参数确实暴露且生效
//
// 2026-11-03 事故（187KB afterload 被 8KB 整块替换）修复的协议层回归：
// ① set_webwrite_js / set_report_listener 的 inputSchema 暴露 patchFind/patchReplace/patchAll/allowShrink；
// ② 真实经 MCP 调用：整块缩水替换 → isError + 指路 allowShrink；片段替换 → mode=patch；allowShrink=true 放行；
// ③ patchReplace 文本同样受 allowUnsafeScript 安全围栏（不传就拒）。
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createCpt } from '../lib/generate.js';
import '../scripts/isolate-store.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(__dirname, '..', 'server.js');
let client = null;

before(async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER],
    cwd: path.join(__dirname, '..'),
    env: { CPT_MCP_TOOL_PROFILE: 'full' },
  });
  client = new Client({ name: 'cpt-mcp-listener-safety', version: '0.0.1' });
  await client.connect(transport);
});

after(async () => {
  if (client) { try { await client.close(); } catch { /* 已断开 */ } client = null; }
});

async function call(tool, args) {
  const res = await client.callTool({ name: tool, arguments: args });
  const text = res.content?.find((c) => c.type === 'text')?.text ?? '';
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  return { res, data, text };
}

const bigJs = (lines = 2500) => `// 共享大块\n` + Array.from({ length: lines }, (_, i) => `function fn${i}() { return ${i}; }`).join('\n');

test('MCP schema：两个 Listener 写工具都暴露 patchFind/patchReplace/patchAll/allowShrink', async () => {
  const { tools } = await client.listTools();
  for (const name of ['set_webwrite_js', 'set_report_listener']) {
    const t = tools.find((x) => x.name === name);
    assert.ok(t, `${name} 应存在`);
    for (const key of ['patchFind', 'patchReplace', 'patchAll', 'allowShrink']) {
      assert.ok(t.inputSchema?.properties?.[key], `${name} 应暴露 ${key}`);
    }
  }
  // 读工具应说明 jsBytes/jsLines（描述里出现即可）
  const get = tools.find((x) => x.name === 'get_webwrite_js');
  assert.match(get.description, /jsBytes/);
  assert.match(get.description, /jsLines/);
});

test('MCP 端到端：整块缩水被拒 → 片段替换成功 → allowShrink 放行', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-mcp-listenersafe-'));
  const p = path.join(dir, 'e2e.cpt');
  createCpt(p, { rows: 3, columns: 3, webWrite: true });
  try {
    const big = bigJs(2500);
    const ins = await call('set_webwrite_js', { path: p, event: 'afterappend', js: big, allowUnsafeScript: true });
    assert.equal(ins.res.isError, undefined, `insert 失败: ${ins.text.slice(0, 200)}`);
    assert.equal(ins.data.mode, 'insert');

    // ① 整块缩水：拒绝（协议层 isError）
    const bad = await call('set_webwrite_js', { path: p, event: 'afterappend', js: 'var tiny = 1;', allowUnsafeScript: true });
    assert.equal(bad.res.isError, true, '整块缩水替换应被拒绝');
    assert.match(bad.text, /拒绝整块替换/);
    assert.match(bad.text, /allowShrink/);

    // ② 片段替换成功（替换文本也是 JS → 必须带 allowUnsafeScript）
    const noAuth = await call('set_webwrite_js', { path: p, event: 'afterappend', patchFind: '共享大块', patchReplace: '已补丁' });
    assert.equal(noAuth.res.isError, true, 'patchReplace 无 allowUnsafeScript 应被围栏拒绝');
    const ok = await call('set_webwrite_js', { path: p, event: 'afterappend', patchFind: '共享大块', patchReplace: '已补丁', allowUnsafeScript: true });
    assert.equal(ok.res.isError, undefined, `片段替换失败: ${ok.text.slice(0, 200)}`);
    assert.equal(ok.data.mode, 'patch');
    assert.equal(ok.data.patchHits, 1);
    assert.ok(ok.data.jsBytesBefore > ok.data.jsBytesAfter, '中文注释替换后字节数应减少（4 字节字符换 3 字）');

    // ③ allowShrink=true 放行整块替换
    const okShrink = await call('set_webwrite_js', { path: p, event: 'afterappend', js: 'var finallySmall = 1;', allowUnsafeScript: true, allowShrink: true });
    assert.equal(okShrink.res.isError, undefined, `allowShrink 放行失败: ${okShrink.text.slice(0, 200)}`);
    const read = await call('get_webwrite_js', { path: p, event: 'afterappend' });
    assert.equal(read.data.listeners[0].js, 'var finallySmall = 1;');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
