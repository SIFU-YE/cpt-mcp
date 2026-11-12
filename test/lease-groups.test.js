// test/lease-groups.test.js —— M113 场景族租约接线（14 个族 = 13 个 M113 新族 + fr_preview + group=auto 判组）
//
// 背景（施工单 F1，high）：`auto` 兜底路径曾**结构性不可用** —— `server.js` 的非 adhoc 分支
// 不把 `tools` 透传给 `lib/deep-tools.js`，而判组逻辑在 lib 里按 tools 反查族，于是
// 逐字执行 instructions 的兜底文字只会得到「auto 必须显式列出 tools=[工具名]」。
// 本文件把这条通路钉死在真服上：**每个断言都必须能失败**（下方"反例"注释给出红法）。
//
// 锁定的不变量：
//   ① 14 个新族逐一 request_deep_tool_access → status=granted，且组内工具随后真实可见；
//   ② 具名族的 reason 可省略（服务端按族策略自填）；显式传错 reason 被拒；
//   ③ group=auto 按名反查族；命中门禁组被拒并回指正确通道；未编组工具回指 adhoc；
//   ④ adhoc 旧语义不变（分级 reason、不受理已编组工具、已静态可见不占租约）；
//   ⑤ 既有 5 族语义与门禁不变（cell_primitive 仍需 failureId、report_rewrite 仍需 explicit_rewrite）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createCpt } from '../lib/generate.js';
import { LEASE_GROUPS, GATE_GROUPS, DEEP_TOOLS } from '../lib/contract.js';
import { GROUP_POLICY, DEEP_TOOL_GROUPS } from '../lib/deep-tools.js';
import '../scripts/isolate-store.mjs'; // M123：JS 基线 store 隔离，直跑也不污染真实 store

delete process.env.CPT_MCP_ALLOWED_ROOTS;

/** 方案 2.2 的 13 个新族 + 2026-10-29 新增 fr_preview 族（既有 5 族单列，语义不变） */
const EXISTING_GROUPS = ['cell_detail', 'cell_primitive', 'fr_engine', 'report_rewrite', 'batch_read'];
const NEW_GROUPS = Object.keys(LEASE_GROUPS).filter((g) => !EXISTING_GROUPS.includes(g));

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-lease-'));

async function withReport(fn) {
  const dir = tmp();
  const p = path.join(dir, 't.cpt');
  createCpt(p, { rows: 3, columns: 3, webWrite: true });
  const client = new Client({ name: 'lease-test', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath, args: ['server.js'], cwd: process.cwd(), stderr: 'pipe',
    env: { CPT_MCP_TOOL_PROFILE: 'report' },
  });
  await client.connect(transport);
  const call = async (name, args) => {
    const r = await client.callTool({ name, arguments: args });
    const text = r.content?.[0]?.text ?? '';
    let data = null; try { data = JSON.parse(text); } catch { /* 报错文案非 JSON */ }
    return { isError: r.isError === true, text, data };
  };
  const list = async () => (await client.listTools()).tools.map((t) => t.name);
  try {
    return await fn({ client, call, list, dir, p });
  } finally {
    await client.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('M113 组表：16 个族齐备、成员与策略完整、门禁组只有既有 4 个', () => {
  assert.equal(NEW_GROUPS.length, 16, `应有 16 个新族（含 2026-11-02 local_db + 2026-11-12 style_manage），实际 ${NEW_GROUPS.length}：${NEW_GROUPS.join(',')}`);
  assert.deepEqual(GATE_GROUPS, ['cell_detail', 'cell_primitive', 'fr_engine', 'report_rewrite'], '门禁组 = 既有 4 组，新族不设门禁');
  const seen = new Map();
  for (const [g, def] of Object.entries(LEASE_GROUPS)) {
    assert.ok(def.members.length > 0, `族 ${g} 没有成员`);
    assert.ok(def.ttlSeconds > 0 && def.maxCalls > 0, `族 ${g} 的 ttl/maxCalls 必须为正`);
    assert.ok(def.why && def.why.length > 0, `族 ${g} 缺 why（地图要靠它指路）`);
    assert.ok(GROUP_POLICY[g], `族 ${g} 未进 GROUP_POLICY 策略表`);
    assert.deepEqual([...DEEP_TOOL_GROUPS[g]].sort(), [...def.members].sort(), `族 ${g} 的 DEEP_TOOL_GROUPS 与 LEASE_GROUPS 不一致`);
    for (const m of def.members) {
      assert.ok(!seen.has(m), `${m} 同时属于 ${seen.get(m)} 与 ${g}（跨族重复会让 auto 判组产生歧义）`);
      seen.set(m, g);
      assert.ok(DEEP_TOOLS.has(m), `${m} 应进 DEEP_TOOLS（默认隐藏、凭租约解锁）`);
    }
  }
});

test('M113 15 个族逐一 granted，且具名族 reason 可省略、传错被拒', async () => {
  await withReport(async ({ call, list, p }) => {
    const before = new Set(await list());
    const results = [];
    for (const g of NEW_GROUPS) {
      // 逐族用**新会话**验证会很慢，这里同会话连租：族之间互不干扰（各自 ttl/次数独立）
      const r = await call('request_deep_tool_access', { path: p, group: g });
      // report 档成员全静态的族（generator_full：build_report/generate_report 均静态可见）直接回
      // already-visible —— 不消耗租约也不白烧门禁凭据（2026-10-29 修）。
      if (r.data?.status === 'already-visible') {
        results.push(`${g}:already-visible`);
        assert.deepEqual(r.data.alreadyVisible.slice().sort(), [...LEASE_GROUPS[g].members].sort(),
          `族 ${g} 全静态可见时应回 alreadyVisible=成员表`);
        continue;
      }
      const granted = r.data?.status === 'granted' && r.data?.group === g;
      results.push(`${g}:${granted ? 'granted' : 'FAIL(' + r.text.slice(0, 60) + ')'}`);
      assert.ok(granted, `族 ${g} 应 granted：${r.text.slice(0, 200)}`);
      assert.deepEqual(r.data.enabledTools.slice().sort(), [...LEASE_GROUPS[g].members].sort(), `族 ${g} 的 enabledTools 应等于成员表`);
      assert.equal(r.data.expiresInSeconds, LEASE_GROUPS[g].ttlSeconds, `族 ${g} 的 ttl 应来自策略表`);
      assert.equal(r.data.maxCalls, LEASE_GROUPS[g].maxCalls, `族 ${g} 的 maxCalls 应来自策略表`);
    }
    // 租约后组内工具真实可见（真隐藏 → 动态注册）
    const after = new Set(await list());
    for (const g of NEW_GROUPS) {
      const sample = LEASE_GROUPS[g].members[0];
      assert.ok(after.has(sample), `族 ${g} 租约后 ${sample} 应动态可见`);
    }
    assert.ok(after.size > before.size, '租约应让可见工具数增加');
    // 显式传错 reason 被拒（不静默放行）
    const wrong = await call('request_deep_tool_access', { path: p, group: 'scripting', reason: 'explicit_page_setup' });
    assert.equal(wrong.isError, true);
    assert.match(wrong.text, /仅允许 reason=explicit_script_edit/);
    // 必须绑 path 的族缺 path 被拒（generator_full 除外）
    const noPath = await call('request_deep_tool_access', { group: 'scripting', reason: 'explicit_script_edit' });
    assert.equal(noPath.isError, true);
    console.log('15 族接线：' + results.join(' '));
  });
});

test('M113 group=auto 判组：按名反查族 / 门禁组被拒并回指 / 未编组回指 adhoc（F1）', async () => {
  await withReport(async ({ call, p }) => {
    // ① 具名族成员 → granted 且 group 正确（施工单指定的决定性断言）
    const chart = await call('request_deep_tool_access', { path: p, group: 'auto', tools: ['get_chart'] });
    assert.equal(chart.data?.status, 'granted', `auto 判组应 granted：${chart.text.slice(0, 200)}`);
    assert.equal(chart.data?.group, 'chart_float');
    assert.deepEqual(chart.data?.resolvedFrom, ['get_chart']);
    assert.match(chart.data?.note ?? '', /auto 判组 → chart_float/);

    // 逐族抽样：auto 对每个新族都能判对（防止"只接线了一个 chart_float"）
    for (const g of NEW_GROUPS) {
      if (g === 'generator_full') continue; // 成员默认静态，见下一条
      const sample = LEASE_GROUPS[g].members[0];
      const r = await call('request_deep_tool_access', { path: p, group: 'auto', tools: [sample] });
      assert.equal(r.data?.group, g, `auto 应把 ${sample} 判到 ${g}，实际 ${r.data?.group ?? r.text.slice(0, 80)}`);
    }

    // ② 门禁组：拒绝且回指正确通道（不绕过任何既有门禁）
    const gate = await call('request_deep_tool_access', { path: p, group: 'auto', tools: ['batch_mutate_cells'] });
    assert.equal(gate.isError, true);
    assert.match(gate.text, /门禁组/);
    assert.match(gate.text, /report_rewrite/);
    const gate2 = await call('request_deep_tool_access', { path: p, group: 'auto', tools: ['run_fr_engine_check'] });
    assert.equal(gate2.isError, true);
    assert.match(gate2.text, /explicit_engine_check/);

    // ③ 已静态可见的工具 → already-visible（不占租约，也不误判门禁族）
    //    add_cell 既在 report 静态表、又属门禁族 cell_primitive：必须优先判定"已可见"
    const visible = await call('request_deep_tool_access', { path: p, group: 'auto', tools: ['add_cell'] });
    assert.equal(visible.data?.status, 'already-visible', visible.text.slice(0, 200));

    // ④ 未编组工具 → 回指 adhoc 与应传的分级 reason
    const ungrouped = await call('request_deep_tool_access', { path: p, group: 'auto', tools: ['set_widget_value'] });
    assert.equal(ungrouped.isError, true);
    assert.match(ungrouped.text, /未编入任何场景族/);
    assert.match(ungrouped.text, /group:'adhoc'/);
    assert.match(ungrouped.text, /adhoc_write/);

    // ⑤ 其余拒绝路径：未知工具名 / 跨族 / 空 tools
    const unknown = await call('request_deep_tool_access', { path: p, group: 'auto', tools: ['nope_tool'] });
    assert.equal(unknown.isError, true);
    assert.match(unknown.text, /未知工具名/);
    const cross = await call('request_deep_tool_access', { path: p, group: 'auto', tools: ['get_chart', 'set_report_js'] });
    assert.equal(cross.isError, true);
    assert.match(cross.text, /一次只能租一个族/);
    const empty = await call('request_deep_tool_access', { path: p, group: 'auto' });
    assert.equal(empty.isError, true);
    assert.match(empty.text, /必须显式列出 tools/);
  });
});

test('M113 adhoc 旧语义不变：分级 reason、不受理已编组工具、已静态可见不占租约', async () => {
  await withReport(async ({ call, p }) => {
    const bypass = await call('request_deep_tool_access', { path: p, group: 'adhoc', reason: 'adhoc_read', tools: ['get_chart'] });
    assert.equal(bypass.isError, true);
    assert.match(bypass.text, /专用租约通道/);
    const vis = await call('request_deep_tool_access', { path: p, group: 'adhoc', reason: 'adhoc_read', tools: ['read_cpt'] });
    assert.equal(vis.data?.status, 'already-visible');
    const tier = await call('request_deep_tool_access', { path: p, group: 'adhoc', reason: 'adhoc_read', tools: ['set_widget_value'] });
    assert.equal(tier.isError, true);
    assert.match(tier.text, /adhoc_write/);
    const ok = await call('request_deep_tool_access', { path: p, group: 'adhoc', reason: 'adhoc_write', tools: ['set_widget_value'] });
    assert.equal(ok.data?.status, 'granted');
    assert.equal(ok.data?.tier, 'write');
    const unknown = await call('request_deep_tool_access', { path: p, group: 'adhoc', reason: 'adhoc_read', tools: ['nope_tool'] });
    assert.equal(unknown.isError, true);
    assert.match(unknown.text, /未知工具名/);
  });
});

test('M113 既有 5 族门禁不放松：cell_primitive 仍需 failureId、report_rewrite 仍需 explicit_rewrite', async () => {
  await withReport(async ({ call, p }) => {
    const prim = await call('request_deep_tool_access', { path: p, group: 'cell_primitive', reason: 'batch_failure' });
    assert.equal(prim.isError, true);
    assert.match(prim.text, /failureId/);
    const primBogus = await call('request_deep_tool_access', { path: p, group: 'cell_primitive', reason: 'whatever', failureId: 'x' });
    assert.equal(primBogus.isError, true);
    assert.match(primBogus.text, /只能在批量操作失败后凭 failureId 解锁/);
    const rw = await call('request_deep_tool_access', { path: p, group: 'report_rewrite', reason: 'not_it' });
    assert.equal(rw.isError, true);
    assert.match(rw.text, /explicit_rewrite/);
    // auto 也不能绕开这两族（已在上面的门禁断言里覆盖），这里再确认具名组本身仍可用
    const rwOk = await call('request_deep_tool_access', { path: p, group: 'report_rewrite', reason: 'explicit_rewrite' });
    assert.equal(rwOk.data?.status, 'granted');
    const cd = await call('request_deep_tool_access', { path: p, group: 'cell_detail', reason: 'exact_cell_read', target: { sheet: 0, cell: 'A1' } });
    // 2026-11-12 P0-1：get_cell_style 已并入 get_cells({includeStyle:true})，不再常驻 report 静态表
    // （但仍在 cell_detail 门禁族、按 requiredFields 决定成员）⇒ 这里应正常授予单格样式租约。
    assert.equal(cd.data?.status, 'granted');
    assert.deepEqual(cd.data?.enabledTools, ['get_cell_style'], 'cell_detail 按 requiredFields 决定成员');
    assert.equal(cd.data?.group, 'cell_detail');
    const cdNoTarget = await call('request_deep_tool_access', { path: p, group: 'cell_detail', reason: 'exact_cell_read' });
    assert.equal(cdNoTarget.isError, true);
    assert.match(cdNoTarget.text, /target\.sheet 和 target\.cell/);
  });
});

test('M113 get_capabilities({group}) 与运行时组表同源（地图不漂移）', async () => {
  await withReport(async ({ call }) => {
    for (const g of Object.keys(LEASE_GROUPS)) {
      const r = await call('get_capabilities', { group: g });
      assert.ok(!r.isError, r.text.slice(0, 120));
      assert.deepEqual(r.data.group.members, LEASE_GROUPS[g].members, `族 ${g} 的地图成员与组表不一致`);
      assert.equal(r.data.group.ttlSeconds, LEASE_GROUPS[g].ttlSeconds);
      assert.equal(r.data.group.gate, LEASE_GROUPS[g].gate === true);
      assert.match(r.data.group.unlock, new RegExp(`group:'${g}'`), `族 ${g} 应给出逐字可执行的解锁示例`);
    }
    const bad = await call('get_capabilities', { group: 'nosuchgroup' });
    assert.ok(Array.isArray(bad.data?.unknown) && bad.data.unknown.length > 0, '未知族应明确报错并给出可用族清单');
  });
});
