// test/reachability.test.js —— M102 可达性不变量：注册即三选一，无第四种
//
// 背景：M93/M95/M99-D1/M101 连出四次“存在但不可达”（注册了，却不在任何档位、
// 也不在任何租约组，非 full 调即 unknown tool）。根因是 tool() 静默放行。
// 本测试锁定：全量工具名 ∈ 档位静态名单 ∪ 租约组 ∪ FULL_ONLY_WAIVERS，
// 新工具未做选择直接起不来（服务端启动断言同逻辑，见 server.js 末尾）。
// adhoc 临租是运行时逃生舱，不计入覆盖（否则检查空转）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { FULL_ONLY_WAIVERS, assertReachability } from '../lib/reachability.js';
import { DEEP_TOOL_GROUPS } from '../lib/deep-tools.js';
import '../scripts/isolate-store.mjs'; // M123：JS 基线 store 隔离，直跑也不污染真实 store

test('M102 不变量单元：黑户被揪出，豁免被承认，幽灵豁免被揪出，adhoc 不算数', () => {
  // 黑户：注册了但三处全无 → 抛错点名
  assert.throws(
    () => assertReachability({ all: ['a', 'ghost_tool'], profiles: [['a']], groups: [[]], waivers: [] }),
    /ghost_tool/,
  );
  // 豁免：放行
  assert.deepEqual(
    assertReachability({ all: ['a', 'w1'], profiles: [['a']], groups: [[]], waivers: [{ family: 'f', reason: 'r', tools: ['w1'] }] }),
    { ok: true, total: 2 },
  );
  // 幽灵豁免（列了不存在的工具）→ 抛错，防表腐烂
  assert.throws(
    () => assertReachability({ all: ['a'], profiles: [['a']], groups: [[]], waivers: [{ family: 'f', reason: 'r', tools: ['stale'] }] }),
    /腐烂.*stale/,
  );
  // adhoc 逃生舱不计入：只靠 adhoc 能租到的工具仍算黑户（否则检查空转）
  assert.throws(
    () => assertReachability({ all: ['a', 'adhoc_only'], profiles: [['a']], groups: [[]], waivers: [] }),
    /adhoc_only/,
  );
});

test('M102 不变量活体：四档真实列表 + 真实租约组 + 真实豁免表全覆盖 208 工具', async () => {
  const lists = {};
  for (const [entry, env] of [
    ['full', { CPT_MCP_TOOL_PROFILE: 'full' }],
    // 2026-10-29 修：原来传空 env，SDK 按默认环境起服务 ⇒ 实际测的是 report 档，
    // focused 档的真实清单从未进过 assertReachability（现在显式指定 profile）。
    ['focused', { CPT_MCP_TOOL_PROFILE: 'focused' }],
    ['report', { CPT_MCP_TOOL_PROFILE: 'report' }],
    ['generate', { CPT_MCP_TOOL_PROFILE: 'generate' }],
  ]) {
    const client = new Client({ name: 'reach-test', version: '1.0.0' });
    const transport = new StdioClientTransport({
      command: process.execPath, args: ['server.js'], cwd: process.cwd(), stderr: 'pipe',
      ...(Object.keys(env).length ? { env } : {}),
    });
    await client.connect(transport);
    try {
      lists[entry] = (await client.listTools()).tools.map((t) => t.name);
    } finally {
      await client.close();
    }
  }
  assert.equal(lists.full.length, 208, `full 档应 208，实际 ${lists.full.length}`);
  const r = assertReachability({
    all: lists.full,
    profiles: [lists.focused, lists.report, lists.generate],
    groups: Object.values(DEEP_TOOL_GROUPS).map((s) => [...s]),
    waivers: FULL_ONLY_WAIVERS,
  });
  assert.deepEqual(r, { ok: true, total: 208 });
}, { timeout: 120000 });

test('M102 adhoc 端到端：按名直租打通“存在但不可达”，分级与禁区守住', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-adhoc-'));
  const P = path.join(dir, 'a.cpt');
  const client = new Client({ name: 'adhoc-test', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath, args: ['server.js'], cwd: process.cwd(), stderr: 'pipe',
    env: { CPT_MCP_TOOL_PROFILE: 'generate' },
  });
  await client.connect(transport);
  const call = async (name, args) => {
    const r = await client.callTool({ name, arguments: args });
    return { isError: !!r.isError, text: r.content?.[0]?.text ?? '' };
  };
  const R = (extra) => ({ path: P, ...extra });
  try {
    // 未知工具名直接拒绝（防臆造）
    const unk = await call('request_deep_tool_access', R({ group: 'adhoc', reason: 'adhoc_read', tools: ['nope_tool'] }));
    assert.equal(unk.isError, true);
    assert.match(unk.text, /未知工具名/);
    // 已编组工具旁路拒绝（保护专用门禁）
    const bypass = await call('request_deep_tool_access', R({ group: 'adhoc', reason: 'adhoc_read', tools: ['get_cell_batch'] }));
    assert.equal(bypass.isError, true);
    assert.match(bypass.text, /专用租约通道/);
    // 已静态可见的不占租约
    const vis = await call('request_deep_tool_access', R({ group: 'adhoc', reason: 'adhoc_read', tools: ['read_cpt'] }));
    assert.equal(vis.isError, false);
    assert.equal(JSON.parse(vis.text).status, 'already-visible');
    // 读档直租：get_chart 在 generate 档从不可见到可调（M113 后它已编入 chart_float 族，
    // 不再是 adhoc 受理对象 → 改用具名族租约，并断言同一动作在 adhoc 下被拒，见下一段）
    let names = (await client.listTools()).tools.map((t) => t.name);
    assert.ok(!names.includes('get_chart'));
    const viaAdhoc = await call('request_deep_tool_access', R({ group: 'adhoc', reason: 'adhoc_read', tools: ['get_chart'] }));
    assert.equal(viaAdhoc.isError, true, '已编组工具必须走具名族，adhoc 不受理');
    assert.match(viaAdhoc.text, /专用租约通道/);
    const g = await call('request_deep_tool_access', R({ group: 'chart_float' }));
    assert.equal(g.isError, false);
    assert.equal(JSON.parse(g.text).status, 'granted');
    names = (await client.listTools()).tools.map((t) => t.name);
    assert.ok(names.includes('get_chart'), '租约后应动态可见');
    // adhoc 仍是"未编组工具"的逃生舱：set_widget_value / clear_widget_value 未编入任何场景族
    const adhocGrant = await call('request_deep_tool_access', R({ group: 'adhoc', reason: 'adhoc_write', tools: ['set_widget_value'] }));
    assert.equal(adhocGrant.isError, false, `未编组工具应可 adhoc 直租：${adhocGrant.text.slice(0, 120)}`);
    assert.equal(JSON.parse(adhocGrant.text).status, 'granted');
    // reason 分级收紧：读档理由租破坏性工具必须被拒（delete_style 已进 style_manage 具名族，改测 clear_widget_value）
    const wrong = await call('request_deep_tool_access', R({ group: 'adhoc', reason: 'adhoc_read', tools: ['clear_widget_value'] }));
    assert.equal(wrong.isError, true);
    assert.match(wrong.text, /adhoc_destructive/);
  } finally {
    await client.close();
  }
  fs.rmSync(dir, { recursive: true, force: true });
}, { timeout: 120000 });
