// test/verify.test.js —— MCP 自主核验（verify_cpt + 写工具自动 selfCheck）
//
// 目标：cpt-mcp 自己就能回答"这次写完之后模板还是好的吗、我要的改动真落地了吗"，
// 不必靠模型记得再调 validate_cpt / quality_gate_cpt / 引擎。
//   ① verifyCpt 分层结论：结构 / 门禁 / 期望值对账 /（可选）真引擎；
//   ② expectations 不符 = blocker（拿得到"期望 X 实际 Y"）；
//   ③ 写工具返回体自动带 selfCheck（默认 structure；CPT_MCP_AUTO_VERIFY=off 可关）；
//   ④ verify_cpt 工具在 report 档可见（静态表 2026-11-12 P0-1 后 33 项）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createCpt, addCell, addStyle } from '../lib/generate.js';
import { verifyCpt, templateFacts } from '../lib/verify.js';
import { CPT_MCP_INSTRUCTIONS, REPORT_STATIC_TOOLS } from '../lib/contract.js';
import '../scripts/isolate-store.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-verify-'));

function makeTemplate() {
  const d = tmp();
  const cpt = path.join(d, 'v.cpt');
  createCpt(cpt, { rows: 6, columns: 5 });
  addStyle(cpt, { fontSizePt: 12, bold: true });
  addCell(cpt, { column: 0, row: 1, content: '标题甲' });
  addCell(cpt, { column: 1, row: 1, content: '正文乙' });
  return { d, cpt };
}

test('templateFacts：客观计数可用于期望值对账', () => {
  const { d, cpt } = makeTemplate();
  try {
    const f = templateFacts(cpt);
    assert.equal(f.cells, 2, '两个 addCell');
    assert.equal(f.styles >= 1, true, '至少有 1 个自定义样式');
    assert.equal(f.toolbarButtons, 0);
    assert.equal(f.sheets, 1);
    assert.match(f.sha256, /^[0-9a-f]{16}$/);
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test('verifyCpt：结构 + 门禁分层通过（engine=false 时引擎层 skipped）', async () => {
  const { d, cpt } = makeTemplate();
  try {
    const v = await verifyCpt(cpt);
    assert.equal(v.ok, true, JSON.stringify(v.blockers));
    const byId = Object.fromEntries(v.layers.map((l) => [l.id, l.status]));
    // 全新模板通常带 warning（无数据集/无纸张/无参数）——warning 不算失败
    assert.ok(['pass', 'warn'].includes(byId.structure), `structure=${byId.structure}`);
    assert.ok(['pass', 'warn'].includes(byId.gate), `gate=${byId.gate}`);
    assert.equal(byId.expectations, 'skipped');
    assert.equal(byId.engine, 'skipped');
    assert.ok(typeof v.nextAction === 'string' && v.nextAction.length > 0);
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test('expectations：数量不符 → blocker 带"期望/实际"', async () => {
  const { d, cpt } = makeTemplate();
  try {
    const v = await verifyCpt(cpt, { expectations: { cells: 2, toolbarButtons: 2 } });
    assert.equal(v.ok, false);
    const b = v.blockers.find((x) => /toolbarButtons/.test(x.message));
    assert.ok(b, JSON.stringify(v.blockers));
    assert.match(b.message, /期望 2，实际 0/);
    assert.ok(b.fix);

    const pass = await verifyCpt(cpt, { expectations: { cells: 2, styles: 2, hasText: ['标题甲'], notHasText: ['不该有'] } });
    assert.equal(pass.ok, true, JSON.stringify(pass.blockers));
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test('verifyCpt：文件不存在/损坏 → ok=false 且给修复建议', async () => {
  const d = tmp();
  try {
    const missing = await verifyCpt(path.join(d, 'nope.cpt'));
    assert.equal(missing.ok, false);
    assert.equal(missing.layers[0].id, 'file');

    const broken = path.join(d, 'broken.cpt');
    fs.writeFileSync(broken, '<Report><CellElementList>不闭合', 'utf8');
    const v = await verifyCpt(broken);
    assert.equal(v.ok, false);
    assert.ok(v.blockers.length > 0);
    assert.match(v.nextAction, /修复/);
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test('verify_cpt 路径策略按实际副作用：engine=false 可只读核验 FR 官方样本，engine=true 因会落盘被拒', async () => {
  // 2026-11-06：verify_cpt 注解归写（engine 默认 true 会写 .fr-engine-check），
  // 但 engine=false 是纯读核验 —— 路径围栏按实际副作用取，避免"只读核验官方样本"能力回退。
  const frHome = tmp();
  const sampleDir = path.join(frHome, 'webapps', 'webroot', 'WEB-INF', 'reportlets', 'demo');
  fs.mkdirSync(sampleDir, { recursive: true });
  const sample = path.join(sampleDir, 'Demo.cpt');
  createCpt(sample, { rows: 4, columns: 4 });
  try {
    await withClient(async ({ client }) => {
      const ro = await client.callTool({ name: 'verify_cpt', arguments: { path: sample, engine: false } });
      assert.ok(!ro.isError, `engine=false 应允许只读核验 FR 官方样本：${textOf(ro).slice(0, 200)}`);
      const rw = await client.callTool({ name: 'verify_cpt', arguments: { path: sample, engine: true } });
      assert.equal(rw.isError, true, 'engine=true 会写 .fr-engine-check，必须拒绝写 FineReport 安装目录');
      assert.match(textOf(rw), /禁止写入 FineReport 安装目录/);
      // 2026-11-07：validate_cpt / quality_gate_cpt 注解也归写（js-baseline / 租约），
      // 但只写自有缓存、不改 .cpt 相邻文件 —— 路径围栏同样按只读副作用放行。
      for (const name of ['validate_cpt', 'quality_gate_cpt']) {
        const r = await client.callTool({ name, arguments: { path: sample, ...(name === 'quality_gate_cpt' ? { localSqlAudit: false } : {}) } });
        assert.ok(!r.isError, `${name} 应允许只读核验 FR 官方样本：${textOf(r).slice(0, 200)}`);
      }
    }, { FR_HOME: frHome });
  } finally {
    fs.rmSync(frHome, { recursive: true, force: true });
  }
});

test('核验类注解纠正（2026-11-07 P1）：validate_cpt / quality_gate_cpt 归写、不挂 S6、不挂写后 selfCheck', async () => {
  // 复审 P1-6：两者 readOnlyHint=true 但实际会落盘（都走 buildProgress → 写 js-baseline 基线）。
  // 注解必须改成写，但保持"不挂 S6 / 不挂 selfCheck"（P1-6 收口后 quality_gate 已不再改 tools/list）。
  await withClient(async ({ client, cpt }) => {
    const tools = (await client.listTools()).tools;
    for (const name of ['validate_cpt', 'quality_gate_cpt']) {
      const t = tools.find((x) => x.name === name);
      assert.ok(t, `${name} 应在 report 档静态可见`);
      assert.equal(t.annotations?.readOnlyHint, false, `${name} 会落盘（js-baseline 基线），注解须为写`);
      assert.equal(t.annotations?.destructiveHint, false, `${name} 不改 .cpt 正文，不应标破坏性`);
      assert.equal(t.annotations?.idempotentHint, true, `${name} 重复调用结果一致 ⇒ 幂等写`);
      assert.ok(!(t.description || '').includes('【边界·S6】'), `${name} 不改 .cpt 正文，不应挂 S6 提示`);
    }
    const v = await client.callTool({ name: 'validate_cpt', arguments: { path: cpt } });
    assert.equal(jsonOf(v).selfCheck, undefined, 'validate_cpt 是核验入口，不应再挂写后 selfCheck');
    const g = await client.callTool({ name: 'quality_gate_cpt', arguments: { path: cpt, localSqlAudit: false } });
    assert.equal(jsonOf(g).selfCheck, undefined, 'quality_gate_cpt 是核验入口，不应再挂写后 selfCheck');
  });
});

test('quality_gate_cpt 门禁自洽（2026-11-07 P1/P1-6）：不自动授予租约、tools/list 不变，nextAction 首选 verify_cpt', async () => {
  await withClient(async ({ client, cpt }) => {
    const namesBefore = (await client.listTools()).tools.map((t) => t.name);
    const r = await client.callTool({ name: 'quality_gate_cpt', arguments: { path: cpt, localSqlAudit: false } });
    const g = jsonOf(r);
    assert.equal(g.pass, true, `骨架模板应结构通过：${JSON.stringify(g.blockers)}`);
    assert.notEqual(g.engineCheck.status, 'pass', '新模板引擎结论应为 not-run');
    assert.equal(g.engineCheck.required, true);
    assert.equal(g.deliveryPass, false);
    // P1-6：门禁只指路、不代办 —— 不再自动 request fr_engine（旧行为会让 tools/list 数量变化）
    assert.equal(g.engineCheck.deepAccess?.status, 'not_requested', '门禁不得自动申请租约');
    const namesAfter = (await client.listTools()).tools.map((t) => t.name);
    assert.deepEqual(namesAfter.slice().sort(), namesBefore.slice().sort(), '调用门禁不得改变 tools/list');
    assert.equal(namesAfter.length, REPORT_STATIC_TOOLS.length, `report 档应保持 ${REPORT_STATIC_TOOLS.length} 项，实际 ${namesAfter.length}`);
    // nextAction：首选 verify_cpt（免租约），run_fr_engine_check 需显式租约；两条路都要写清楚
    assert.match(String(g.nextAction), /verify_cpt\(\{path/, 'nextAction 应首选 verify_cpt 免租约通道');
    assert.match(String(g.nextAction), /request_deep_tool_access/, 'nextAction 应给出显式租约调用');
    assert.match(String(g.nextAction), /explicit_engine_check/);
    assert.match(String(g.nextAction), /run_fr_engine_check/);
    assert.doesNotMatch(String(g.nextAction), /自动授予|会自动|已为你?(解锁|授予)/, 'nextAction 不得声称自动授予');
    assert.doesNotMatch(String(g.note), /重跑本工具直到通过/, '不得再暗示"只重跑本工具"就能翻 deliveryPass');
    // 契约层：instructions 写清两条通道，且不再有"门禁自动授予"的说法
    assert.match(CPT_MCP_INSTRUCTIONS, /run_fr_engine_check\(\{path\}\)/, 'instructions 应给出 run_fr_engine_check 通道');
    assert.match(CPT_MCP_INSTRUCTIONS, /verify_cpt\(\{path, engine:true\}\)/, 'instructions 应把 verify_cpt 写成免租约通道');
    assert.match(CPT_MCP_INSTRUCTIONS, /explicit_engine_check/, 'instructions 应给出 fr_engine 的显式租约理由');
    assert.doesNotMatch(CPT_MCP_INSTRUCTIONS, /(?<!不)会自动授予|quality_gate_cpt 自动授予/, 'instructions 不得再声称门禁自动授予租约（允许"不会自动授予"这种否定表述）');
    assert.doesNotMatch(CPT_MCP_INSTRUCTIONS, /重跑 quality_gate_cpt 直到通过/, 'instructions 不得再暗示只重跑门禁即可');
  });
});

async function withClient(fn, extraEnv = {}) {
  const d = tmp();
  const cpt = path.join(d, 'a.cpt');
  createCpt(cpt, { rows: 6, columns: 6 });
  const client = new Client({ name: 'verify-test', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath, args: ['server.js'], cwd: process.cwd(), stderr: 'pipe',
    env: {
      CPT_MCP_TOOL_PROFILE: 'report',
      CPT_MCP_ALLOWED_ROOTS: `${os.homedir()};${os.tmpdir()}`,
      // 与 isolate-store.mjs 同源：核验类写工具会写 js-baseline，子进程必须用隔离目录，
      // 否则单测会污染真实 %LOCALAPPDATA%/cpt-mcp/js-baseline/。
      ...(process.env.CPT_MCP_JS_BASELINE ? { CPT_MCP_JS_BASELINE: process.env.CPT_MCP_JS_BASELINE } : {}),
      ...extraEnv,
    },
  });
  await client.connect(transport);
  try {
    return await fn({ client, cpt, dir: d });
  } finally {
    await client.close();
    fs.rmSync(d, { recursive: true, force: true });
  }
}

const textOf = (r) => (r.content || []).map((c) => c.text).join('\n');
const jsonOf = (r) => JSON.parse((r.content || []).find((c) => c.type === 'text').text);

test(`report 档暴露 verify_cpt（共 ${REPORT_STATIC_TOOLS.length} 项），且不要求 engine 也能出结论`, async () => {
  await withClient(async ({ client, cpt }) => {
    const tools = (await client.listTools()).tools;
    const names = tools.map((t) => t.name);
    assert.ok(names.includes('verify_cpt'), 'report 档应含 verify_cpt');
    assert.equal(names.length, REPORT_STATIC_TOOLS.length, `report 档应为 ${REPORT_STATIC_TOOLS.length} 项，实际 ${names.length}`);

    // 2026-11-06 P0 注解纠正：engine 默认 true 会写 .fr-engine-check / spawn npm，
    // 因此 verify_cpt 必须标为写（幂等写），但它是核验入口、不改 .cpt 正文：
    // 不挂 S6 写边界提示，也不挂写后 selfCheck（NON_TEMPLATE_WRITE_TOOLS）。
    const vt = tools.find((t) => t.name === 'verify_cpt');
    assert.equal(vt.annotations?.readOnlyHint, false, 'verify_cpt 注解上应为写（会落盘引擎报告）');
    assert.equal(vt.annotations?.destructiveHint, false);
    assert.equal(vt.annotations?.idempotentHint, true, '同目标重跑覆盖同一份报告 ⇒ 幂等');
    assert.ok(!(vt.description || '').includes('【边界·S6】'), 'verify_cpt 不改 .cpt 正文，不应挂 S6 写边界提示');

    const r = await client.callTool({ name: 'verify_cpt', arguments: { path: cpt, engine: false } });
    assert.ok(!r.isError, textOf(r));
    const v = jsonOf(r);
    assert.equal(v.ok, true, JSON.stringify(v.blockers));
    assert.equal(r.structuredContent?.status, 'pass', '对象结果应带 structuredContent');
    assert.equal(v.layers.find((l) => l.id === 'structure').status, 'pass');
    assert.equal(v.selfCheck, undefined, 'verify_cpt 本身是全层核验入口，不应再挂写后 selfCheck');
  });
});

test('verify_cpt 的 expectations 不符 → isError=false 但 ok=false + blocker', async () => {
  await withClient(async ({ client, cpt }) => {
    const r = await client.callTool({
      name: 'verify_cpt',
      arguments: { path: cpt, engine: false, expectations: { cells: 99 } },
    });
    const v = jsonOf(r);
    assert.equal(v.ok, false);
    assert.match(v.blockers[0].message, /cells 期望 99/);
  });
});

test('写工具返回体自动带 selfCheck（默认 structure）', async () => {
  await withClient(async ({ client, cpt }) => {
    const r = await client.callTool({ name: 'add_cell', arguments: { path: cpt, column: 0, row: 2, content: '自检' } });
    assert.ok(!r.isError, textOf(r));
    const data = jsonOf(r);
    assert.ok(data.selfCheck, '写工具返回体应带 selfCheck');
    assert.ok(['pass', 'warn'].includes(data.selfCheck.status), `自检状态异常：${data.selfCheck.status}`);
    assert.equal(data.selfCheck.layers.structure, 'pass');
    assert.equal(data.selfCheck.layers.gate, 'pass');
    assert.equal(data.selfCheck.layers.engine, 'skipped', '默认不跑引擎');
    assert.ok(data.selfCheck.facts && data.selfCheck.facts.cells >= 1, 'selfCheck 应带客观事实（cells 等）');
    // structuredContent 同步带上 selfCheck（PTC 程序里直接读）
    assert.ok(r.structuredContent?.selfCheck, 'structuredContent 应同步 selfCheck');
  });
});

test('CPT_MCP_AUTO_VERIFY=off 时不附加 selfCheck', async () => {
  await withClient(async ({ client, cpt }) => {
    const r = await client.callTool({ name: 'add_cell', arguments: { path: cpt, column: 0, row: 3, content: 'x' } });
    assert.ok(!r.isError, textOf(r));
    assert.equal(jsonOf(r).selfCheck, undefined);
  }, { CPT_MCP_AUTO_VERIFY: 'off' });
});

const FR_HOME = 'D:/FineReport_11.0';
test('verify_cpt engine=true：真引擎层给出 pass 或明确 skipped', { skip: !fs.existsSync(FR_HOME) && '本机未安装 FineReport' }, async () => {
  await withClient(async ({ client, cpt }) => {
    // 真引擎首跑要编译探针 + 起 JVM，机器繁忙时可 >60s；MCP 客户端默认超时也是 60s（先报 -32001）。
    // 这里显式放宽客户端超时到 180s，断言口径不变（只测"能给出 pass/skipped/fail 分层结论"）。
    const r = await client.callTool({ name: 'verify_cpt', arguments: { path: cpt, engine: true } }, undefined, { timeout: 180_000 });
    assert.ok(!r.isError, textOf(r));
    const v = jsonOf(r);
    const engineLayer = v.layers.find((l) => l.id === 'engine');
    assert.ok(['pass', 'skipped', 'fail'].includes(engineLayer.status), JSON.stringify(engineLayer));
    if (engineLayer.status === 'pass') assert.equal(v.ok, true, JSON.stringify(v.blockers));
  });
});
