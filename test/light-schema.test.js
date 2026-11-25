// test/light-schema.test.js —— M113 轻 entry：广告 schema 与全量校验解耦
//
// 背景：`spec`(30,255 B) / `border`(1,098 B×2) / `options`(6,720 B) 这类"参数级文档"占了
// report 档静态表的 70%。本改造只把**广告层**收轻（高频字段 + 一句"去哪取完整说明"），
// 巨块语义外移到 lib/spec-sections.js，由 get_capabilities({tool,section}) 按需下发。
//
// 本文件锁定的不变量（对应方案 A9 与风险 5.4"轻 schema 引发的静默剥离"）：
//   ① 广告层只宽不严：广告 schema 接受的值集合 ⊇ 完整 schema 接受的值集合
//      （凡是完整 schema 认的参数，广告层不能先拒掉）；
//   ② 未广告的字段**必须透传**到处理器，由完整 schema 复核 —— 绝不静默丢弃；
//   ③ 非法值仍返回**字段级**错误，并附"该字段所属的节"（错误即文档，一次往返闭环）；
//   ④ 向后兼容：get_capabilities 无参行为不变（返回全量清单）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { LIGHT_TOOLS, LIGHT_TOOL_NAMES } from '../lib/light-schemas.js';
import { SPEC_SECTIONS, SECTION_REFS, REPORT_STATIC_TOOLS, LEASE_GROUPS } from '../lib/contract.js';
import { FULL_ONLY_WAIVERS } from '../lib/reachability.js';
import '../scripts/isolate-store.mjs'; // M123：JS 基线 store 隔离，直跑也不污染真实 store

delete process.env.CPT_MCP_ALLOWED_ROOTS;

async function withProfile(profile, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-light-'));
  const p = path.join(dir, 't.cpt');
  const client = new Client({ name: 'light-test', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath, args: ['server.js'], cwd: process.cwd(), stderr: 'pipe',
    env: { CPT_MCP_TOOL_PROFILE: profile },
  });
  await client.connect(transport);
  const call = async (name, args) => {
    const r = await client.callTool({ name, arguments: args });
    const text = r.content?.[0]?.text ?? '';
    let data = null; try { data = JSON.parse(text); } catch { /* 报错文案非 JSON */ }
    return { isError: r.isError === true, text, data };
  };
  try {
    return await fn({ client, call, dir, p });
  } finally {
    await client.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const withReport = (fn) => withProfile('report', fn);

/** 一次列出某档位真实 tools/list（用于跨档位形态断言）。 */
async function listTools(profile) {
  const client = new Client({ name: 'light-list', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath, args: ['server.js'], cwd: process.cwd(), stderr: 'pipe',
    env: { CPT_MCP_TOOL_PROFILE: profile },
  });
  await client.connect(transport);
  try {
    return (await client.listTools()).tools;
  } finally {
    await client.close();
  }
}

test('M113 轻 entry 表：工具名齐备、描述与参数描述在字节口径内、必填字段齐备', () => {
  assert.ok(LIGHT_TOOL_NAMES.length >= 15, `轻 entry 工具应 ≥15，实际 ${LIGHT_TOOL_NAMES.length}`);
  for (const name of LIGHT_TOOL_NAMES) {
    const def = LIGHT_TOOLS[name];
    assert.ok(def.description && Buffer.byteLength(def.description, 'utf8') > 0, `${name} 缺 description`);
    if (name === 'get_capabilities') {
      // 地图入口本身无必填参数（无参 = 全量清单，向后兼容）
      assert.deepEqual(def.required, [], 'get_capabilities 不应有必填参数');
      assert.equal(def.shape.path, undefined, 'get_capabilities 不需要 path');
      continue;
    }
    assert.ok(def.required.includes('path'), `${name} 的 required 必须含 path`);
    assert.ok(def.shape.path, `${name} 的 shape 缺 path`);
    // advertised：required 之外一律 optional —— zod raw shape 默认必填，不标 optional 会误拒可选参数
    for (const [k, v] of Object.entries(def.advertised)) {
      if (def.required.includes(k)) assert.ok(v, `${name}.${k} 缺失`);
      else assert.ok(v.isOptional?.() === true, `${name}.${k} 在广告层必须是 optional（否则模型少传就被拒）`);
    }
  }
});

test('M113 轻 entry 工具都仍会注册进上下文（静态档/租约族/豁免表至少覆盖其一）', () => {
  // 轻 entry 只服务于"会被注册的工具"：常驻静态表、租约解锁后的深层工具、或 full/adhoc 工具。
  // 2026-11-12 P0-1 后 add_style / set_cell_content_type / set_cell_span / build_report 已离开
  // report 静态表，但分别由 style_manage / cell_primitive / generator_full 租约族承载。
  const covered = new Set([...REPORT_STATIC_TOOLS]);
  for (const def of Object.values(LEASE_GROUPS)) for (const member of def.members) covered.add(member);
  for (const waiver of FULL_ONLY_WAIVERS) for (const name of waiver.tools) covered.add(name);
  for (const name of LIGHT_TOOL_NAMES) {
    assert.ok(covered.has(name), `${name} 是轻 entry 但不在任何静态档/租约族/豁免表内（轻定义成死配置）`);
  }
});

test('M113 分节体系：节键唯一、正文非空且不重复、SECTION_REFS 与 usedBy 双向一致', () => {
  const keys = Object.keys(SPEC_SECTIONS);
  assert.equal(keys.length, 18, `应有 18 节（2026-10-26 新增 ptc.recipes），实际 ${keys.length}`);
  assert.equal(new Set(keys).size, keys.length, '节键不得重复');
  const bodies = new Set();
  for (const k of keys) {
    const body = SPEC_SECTIONS[k].covers;
    assert.ok(body && body.trim().length > 0, `节 ${k} 正文为空`);
    assert.ok(!bodies.has(body), `节 ${k} 正文与其它节重复（同名/重复节必须唯一）`);
    bodies.add(body);
    assert.ok(SPEC_SECTIONS[k].usedBy.length > 0, `节 ${k} 未声明 usedBy`);
    for (const t of SPEC_SECTIONS[k].usedBy) {
      assert.ok((SECTION_REFS[t] ?? []).includes(k), `节 ${k} 声明 usedBy=${t}，但 ${t} 未引用它`);
    }
  }
  for (const [t, refs] of Object.entries(SECTION_REFS)) {
    assert.ok(LIGHT_TOOLS[t], `SECTION_REFS 里的 ${t} 不是轻 entry 工具`);
    for (const ref of refs) assert.ok(SPEC_SECTIONS[ref], `${t} 引用了未登记的节 ${ref}`);
  }
  // 参数 ≥3 且**有巨块文档要外移**的轻 entry 工具必须登记节引用。
  // 例外：只收 schema（参数多但说明本来就短）的工具，其参数语义仍在自己的广告 schema 里，
  // 没有"取不到全量语义"的风险 —— 判据用"广告 schema 里是否仍有宽松对象/数组参数"。
  const EXEMPT_NO_SECTION = new Set(['get_capabilities', 'record_cpt_read_intent']);
  for (const [t, def] of Object.entries(LIGHT_TOOLS)) {
    if (Object.keys(def.shape).length >= 3 && !EXEMPT_NO_SECTION.has(t)) {
      assert.ok((SECTION_REFS[t] ?? []).length > 0, `${t} 参数 ≥3 但未登记任何外移节`);
    }
  }
});

test('M113 A9：add_cell 只广告轻 schema，section 仍取回全量语义；未广告字段透传不丢', async () => {
  await withReport(async ({ client, call, p }) => {
    const tools = (await client.listTools()).tools;
    const addCell = tools.find((t) => t.name === 'add_cell');
    const props = Object.keys(addCell.inputSchema.properties);
    assert.ok(!props.includes('widgetDictionary'), 'add_cell 广告 schema 不应含 widgetDictionary（已外移）');
    assert.ok(!props.includes('expand'), 'add_cell 广告 schema 不应含 expand（已外移）');

    // ① 分节下发：能取回外移的全量语义
    const cap = await call('get_capabilities', { tool: 'add_cell', section: 'cell.dictionary' });
    assert.ok(!cap.isError, cap.text.slice(0, 120));
    assert.ok(cap.text.includes('widgetDictionary'), 'section=cell.dictionary 应命中 widgetDictionary');
    assert.ok(cap.text.includes('TableDataDictionary'), 'section 正文应含官方落点类名');
    assert.deepEqual(Object.keys(cap.data.specSections), ['cell.dictionary']);

    // ② 无参向后兼容
    const full = await call('get_capabilities', {});
    assert.ok(!full.isError);
    assert.equal(full.data.toolMap.staticTools.length, REPORT_STATIC_TOOLS.length, '无参调用仍返回全量清单（含工具地图）');
    assert.ok(Object.keys(full.data.toolMap.leaseGroups).length >= 13, '无参调用应含族目录');
    assert.ok(full.data.toolClasses.all.length >= 192, '无参调用应含工具分类清单');

    // ③ 未广告字段必须透传到处理器（M109 的 widgetDictionary 落盘验证）
    await call('create_cpt', { path: p, rows: 3, columns: 3 });
    await call('add_dataset', { path: p, name: 'ds1', connection: 'Doris', sql: 'SELECT 1 AS spec_id' });
    const added = await call('add_cell', {
      path: p, column: 0, row: 1, styleIndex: 0, widget: 'comboBox',
      widgetDictionary: { type: 'table', dsName: 'ds1', kiName: 'spec_id', viName: 'spec_id' },
    });
    assert.ok(!added.isError, `未广告字段应透传并被全量 schema 接受：${added.text.slice(0, 200)}`);
    const dict = await call('get_cell_dictionary', { path: p, column: 0, row: 1, sheet: 0 });
    assert.equal(dict.data?.kind, 'table', `widgetDictionary 应真的落盘：${dict.text.slice(0, 160)}`);
    assert.equal(dict.data?.kiName, 'spec_id');

    // ④ 拼错参数名 → 字段级报错 + 节引用（不静默剥离）
    const typo = await call('add_cell', { path: p, column: 0, row: 2, styleIndex: 0, widgetTypo: 'x' });
    assert.equal(typo.isError, true);
    assert.match(typo.text, /参数校验失败/);
    assert.match(typo.text, /widgetTypo/);
    assert.match(typo.text, /get_capabilities\(\{tool:"add_cell"/);

    // ⑤ 枚举越界 → 字段级报错（完整 schema 仍在把关）
    const bad = await call('set_report_settings', { path: p, orientation: 5 });
    assert.equal(bad.isError, true);
    assert.match(bad.text, /orientation/);

    // ⑥ 巨块 spec 仍被完整校验（广告层只是 object，不放松语义）。
    // build_report 已下沉 generator_full（report 档默认隐藏）→ 用 full 档单独验证它的 spec 校验。
    const badSpec = await withProfile('full', async ({ call: fullCall, dir: fullDir }) =>
      fullCall('build_report', { path: path.join(fullDir, 'x.cpt'), spec: { cells: [{ column: -1, row: 0 }] } }));
    assert.equal(badSpec.isError, true);
    assert.match(badSpec.text, /spec\.cells\.0\.column/);
  });
});

test('M113 轻 entry 的广告 schema 字节显著小于原样工具（省的是每请求常驻）', async () => {
  const reportTools = await listTools('report');
  const focusedTools = await listTools('focused');
  const byName = Object.fromEntries(reportTools.map((t) => [t.name, t]));
  const focusedByName = Object.fromEntries(focusedTools.map((t) => [t.name, t]));
  const bytes = (v) => Buffer.byteLength(JSON.stringify(v), 'utf8');
  // build_report 的 spec 子树已外移：广告 schema 必须回到 1 KB 量级
  // （它已从 report 静态表下沉 generator_full，但仍随租约/focused 进入上下文，形态约束不变）
  assert.ok(bytes(focusedByName.build_report.inputSchema) <= 1000, `build_report 广告 schema ${bytes(focusedByName.build_report.inputSchema)} B`);
  assert.ok(bytes(byName.add_cell.inputSchema) <= 1200, `add_cell 广告 schema ${bytes(byName.add_cell.inputSchema)} B`);
  // 对照：原样工具（参数少、无巨块）本来就很轻
  assert.ok(bytes(byName.get_datasets.inputSchema) <= 400, 'get_datasets 应保持原样轻量');
  // report 档整体 ≤ 12k token（40,000 B，bytes/3.3；2026-11-12 P0-1 后收紧）
  assert.ok(bytes(reportTools) <= 40000, `report 静态表 ${bytes(reportTools)} B 超 12k token 上限`);
});
