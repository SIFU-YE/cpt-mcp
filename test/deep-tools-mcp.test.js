import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import { createCpt, addCell } from '../lib/generate.js';
import { cells } from '../lib/cpt.js';
import '../scripts/isolate-store.mjs'; // M123：JS 基线 store 隔离，直跑也不污染真实 store

function decode(result) {
  return JSON.parse(result.content[0].text);
}

/**
 * 次数型租约（maxCalls 次 + TTL 兜底）：反复调用某深层工具，直到它从注册表消失
 * （次数耗尽 → reconcile → 动态注销），返回实际消耗的调用次数。
 * cap 兜底防死循环——同一工具可能同时挂着多份租约（如先越权消耗一次、再重新授予），
 * 必须全部耗尽才注销，故上限给到 120 而非 maxCalls。
 */
// 2026-10-27 P0-2：额度耗尽后不再动态注销（保持注册、报续租指引），循环改为"等续租错误"。
// 顺带守卫：整个过程工具必须始终在 tools/list 里（真隐藏只属于从未授予的工具）。
async function exhaustUntilHidden(client, name, args, cap = 120) {
  for (let i = 0; i < cap; i++) {
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    assert.ok(names.includes(name), `${name} 耗尽后应保持注册（P0-2）`);
    const r = await client.callTool({ name, arguments: args });
    const txt = (r.content || []).map((c) => c && c.text || '').join('');
    if (r.isError && /无可用租约|重新授权|not found/.test(txt)) return i;
  }
  throw new Error(`${name} 连续调用 ${cap} 次仍可用（额度未耗尽？）`);
}

test('单格工具默认隐藏，精确租约后出现，次数耗尽后报续租指引（P0-2）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-deep-mcp-'));
  const cpt = path.join(dir, 'deep.cpt');
  createCpt(cpt, { rows: 2, columns: 2 });
  addCell(cpt, { column: 0, row: 0, content: 'A1' });

  const client = new Client({ name: 'deep-test', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: ['server-generate.js'], cwd: process.cwd(), stderr: 'pipe' });
  await client.connect(transport);
  try {
    let names = (await client.listTools()).tools.map((tool) => tool.name);
    assert.ok(!names.includes('get_cell_style'));
    assert.ok(!names.includes('run_fr_engine_check'));
    assert.ok(!names.includes('batch_mutate_cells'), 'batch_mutate_cells 默认隐藏');
    assert.ok(!names.includes('update_report_node'), 'update_report_node 默认隐藏');
    assert.ok(!names.includes('regenerate_from_meta'), 'regenerate_from_meta 默认隐藏');

    // t2 真隐藏：未解锁的深层工具根本未注册（协议层 not found），而非 disabled 占位。
    // 注：SDK client.callTool 把协议错误转为 isError 结果而非抛错，故断言返回值。
    const locked = await client.callTool({ name: 'batch_mutate_cells', arguments: { path: cpt, mode: 'plan', commands: [] } });
    assert.equal(locked.isError, true);
    assert.match(locked.content[0].text, /not found/);
    assert.doesNotMatch(locked.content[0].text, /disabled/);

    const access = decode(await client.callTool({
      name: 'request_deep_tool_access',
      arguments: { group: 'cell_detail', path: cpt, reason: 'exact_cell_read', target: { sheet: 0, cell: 'A1', requiredFields: ['style'] } },
    }));
    assert.equal(access.status, 'granted');
    assert.deepEqual(access.enabledTools, ['get_cell_style']);

    names = (await client.listTools()).tools.map((tool) => tool.name);
    assert.ok(names.includes('get_cell_style'));
    const style = decode(await client.callTool({ name: 'get_cell_style', arguments: { path: cpt, sheet: 0, column: 0, row: 0 } }));
    assert.equal(style.styleIndex, 0);

    // 次数型租约：1 次调用后仍应可见（旧契约"1 次即隐藏"已改为 maxCalls 次 + TTL 兜底）
    names = (await client.listTools()).tools.map((tool) => tool.name);
    assert.ok(names.includes('get_cell_style'), '次数型租约：1 次调用后工具仍应可见');
    assert.ok(access.maxCalls > 1, `granted 应回传次数额度，实际 ${access.maxCalls}`);
    assert.ok(access.expiresInSeconds > 60, `granted 应回传 TTL 兜底秒数，实际 ${access.expiresInSeconds}`);

    // 耗尽次数 → 保持注册 + 续租指引（P0-2；不再是协议层裸 not found）
    const spent = await exhaustUntilHidden(client, 'get_cell_style', { path: cpt, sheet: 0, column: 0, row: 0 }, access.maxCalls + 5);
    assert.ok(spent >= access.maxCalls - 1, `应耗尽约 maxCalls=${access.maxCalls} 次才隐藏，实际 ${spent} 次`);
    const styleRelocked = await client.callTool({ name: 'get_cell_style', arguments: { path: cpt, sheet: 0, column: 0, row: 0 } });
    assert.equal(styleRelocked.isError, true, '次数耗尽后应不可调');
    assert.match(styleRelocked.content[0].text, /无可用租约|重新授权/, '应给出续租指引而不是裸 not found');
    assert.match(styleRelocked.content[0].text, /request_deep_tool_access/, '续租指引应含可复制命令');
    assert.doesNotMatch(styleRelocked.content[0].text, /disabled/);

    // P3：batch_mutate_cells 下沉深层，须先凭 report_rewrite 租约解锁才可见
    const rewrite = decode(await client.callTool({
      name: 'request_deep_tool_access',
      arguments: { group: 'report_rewrite', path: cpt, reason: 'explicit_rewrite' },
    }));
    assert.equal(rewrite.status, 'granted');
    assert.deepEqual(rewrite.enabledTools.sort(), ['batch_mutate_cells', 'regenerate_from_meta', 'update_report_node']);
    names = (await client.listTools()).tools.map((tool) => tool.name);
    assert.ok(names.includes('batch_mutate_cells'), 'report_rewrite 租约后 batch_mutate_cells 可见');
    assert.ok(names.includes('update_report_node'));
    assert.ok(names.includes('regenerate_from_meta'));

    const failedPlan = decode(await client.callTool({
      name: 'batch_mutate_cells',
      arguments: {
        path: cpt, mode: 'plan',
        commands: [{ op: 'update', target: { sheet: 0, cells: ['A1'] }, data: { patch: { style: { styleIndex: 999 } } } }],
      },
    }));
    assert.equal(failedPlan.status, 'failed');
    assert.equal(failedPlan.fallbackEligible, true);
    assert.deepEqual(failedPlan.target, { sheet: 0, cell: 'A1' });

    const fallback = decode(await client.callTool({
      name: 'request_deep_tool_access',
      arguments: { group: 'cell_primitive', path: cpt, reason: 'batch_failure', failureId: failedPlan.failureId },
    }));
    assert.equal(fallback.status, 'granted');
    assert.ok(fallback.enabledTools.includes('update_cell'));
    const wrongTarget = await client.callTool({
      name: 'update_cell', arguments: { path: cpt, sheet: 0, column: 1, row: 0, content: '不得写入' },
    });
    assert.equal(wrongTarget.isError, true, '批量失败租约必须绑定失败的唯一坐标');
    // 越权必须落不到盘上（安全边界不变）
    assert.equal(cells(cpt)[0].contentText, 'A1', '越权写入不得改动 A1');
    // 次数型：越权消耗 1 次额度、但仍剩 19 次 → 工具仍可见
    // （旧契约"越权即重新隐藏"随 1 次额度一并调整；额度耗尽后仍会注销，见下方 t2）
    names = (await client.listTools()).tools.map((tool) => tool.name);
    assert.ok(names.includes('update_cell'), '越权消耗 1 次后仍有剩余额度，工具应仍可见');
    const replay = await client.callTool({
      name: 'request_deep_tool_access',
      arguments: { group: 'cell_primitive', path: cpt, reason: 'batch_failure', failureId: failedPlan.failureId },
    });
    assert.equal(replay.isError, true, 'failureId 必须是一次性凭据');

    const retryPlan = decode(await client.callTool({
      name: 'batch_mutate_cells',
      arguments: {
        path: cpt, mode: 'plan',
        commands: [{ op: 'update', target: { sheet: 0, cells: ['A1'] }, data: { patch: { style: { styleIndex: 999 } } } }],
      },
    }));
    decode(await client.callTool({
      name: 'request_deep_tool_access',
      arguments: { group: 'cell_primitive', path: cpt, reason: 'batch_failure', failureId: retryPlan.failureId },
    }));
    const exactFallback = decode(await client.callTool({
      name: 'update_cell', arguments: { path: cpt, sheet: 0, column: 0, row: 0, content: '单格降级' },
    }));
    assert.equal(exactFallback.action, 'update_cell_content');
    assert.equal(cells(cpt)[0].contentText, '单格降级');
    // 次数型：单次降级调用后额度未尽，工具仍可见（旧"1 次即隐藏"已废弃）
    names = (await client.listTools()).tools.map((tool) => tool.name);
    assert.ok(names.includes('update_cell'), '次数型租约：单次降级调用后工具仍应可见');
    // t2（P0-2 语义）：租约额度耗尽后保持注册，再调用报续租指引。
    // 此时并存两份 update_cell 租约（越权消耗过的 fallback + retry 新授予），须全部耗尽才注销。
    const spentCell = await exhaustUntilHidden(client, 'update_cell', { path: cpt, sheet: 0, column: 0, row: 0, content: 'x' });
    assert.ok(spentCell >= fallback.maxCalls - 1, `应耗尽约 maxCalls=${fallback.maxCalls} 次额度才隐藏，实际 ${spentCell} 次`);
    const relocked = await client.callTool({ name: 'update_cell', arguments: { path: cpt, sheet: 0, column: 0, row: 0, content: 'y' } });
    assert.equal(relocked.isError, true);
    assert.match(relocked.content[0].text, /无可用租约|重新授权/, '耗尽后应报续租指引（P0-2）');
    assert.doesNotMatch(relocked.content[0].text, /disabled/);
  } finally {
    await client.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('focused 下 profile 外深层工具同样真隐藏，租约后动态出现、额度耗尽后报续租指引', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-deep-focused-'));
  const cpt = path.join(dir, 'deep-focused.cpt');
  createCpt(cpt, { rows: 2, columns: 2 });
  addCell(cpt, { column: 0, row: 0, content: 'A1' });

  const client = new Client({ name: 'deep-focused-test', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: ['server-focused.js'], cwd: process.cwd(), stderr: 'pipe' });
  await client.connect(transport);
  try {
    let names = (await client.listTools()).tools.map((tool) => tool.name);
    // profile 内深层静态可用；profile 外深层真隐藏（未注册）
    assert.ok(names.includes('get_cell_style'), 'focused 静态包含 get_cell_style');
    assert.ok(!names.includes('get_cell_hyperlink'), 'get_cell_hyperlink 在 focused 下默认隐藏');
    // 未解锁的深层工具应 not found（真隐藏），而非 disabled
    const lockedFocused = await client.callTool({ name: 'get_cell_hyperlink', arguments: { path: cpt, sheet: 0, column: 0, row: 0 } });
    assert.equal(lockedFocused.isError, true);
    assert.match(lockedFocused.content[0].text, /not found/);
    assert.doesNotMatch(lockedFocused.content[0].text, /disabled/);

    const access = decode(await client.callTool({
      name: 'request_deep_tool_access',
      arguments: { group: 'cell_detail', path: cpt, reason: 'exact_cell_read', target: { sheet: 0, cell: 'A1', requiredFields: ['hyperlink'] } },
    }));
    assert.equal(access.status, 'granted');
    assert.deepEqual(access.enabledTools, ['get_cell_hyperlink']);
    names = (await client.listTools()).tools.map((tool) => tool.name);
    assert.ok(names.includes('get_cell_hyperlink'), '租约后动态注册可见');
    const links = decode(await client.callTool({ name: 'get_cell_hyperlink', arguments: { path: cpt, sheet: 0, column: 0, row: 0 } }));
    assert.equal(links.hasHyperlink, false);
    // 次数型：1 次调用后额度未尽，工具仍可见（旧"1 次即隐藏"已废弃）
    names = (await client.listTools()).tools.map((tool) => tool.name);
    assert.ok(names.includes('get_cell_hyperlink'), '次数型租约：1 次调用后工具仍应可见');
    // 耗尽额度 → 保持注册 + 续租指引（P0-2）
    const spentFocused = await exhaustUntilHidden(client, 'get_cell_hyperlink', { path: cpt, sheet: 0, column: 0, row: 0 }, access.maxCalls + 5);
    assert.ok(spentFocused >= access.maxCalls - 1, `应耗尽约 maxCalls=${access.maxCalls} 次才隐藏，实际 ${spentFocused} 次`);
    const relockedFocused = await client.callTool({ name: 'get_cell_hyperlink', arguments: { path: cpt, sheet: 0, column: 0, row: 0 } });
    assert.equal(relockedFocused.isError, true);
    assert.match(relockedFocused.content[0].text, /无可用租约|重新授权/, 'focused 下耗尽也应报续租指引（P0-2）');
  } finally {
    await client.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('generate profile 的质量门槛不自动授予 FR 引擎租约；显式 request fr_engine 后才可调', async () => {
  // 2026-11-07 P1-6 收口：门禁曾在 required 时自动 request fr_engine → tools/list 42→44 的隐藏副作用。
  // 现在只给结构化指路（deepAccess=not_requested + nextAction），解锁必须由调用方显式申请。
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-fr-deep-'));
  const cpt = path.join(dir, 'engine.cpt');
  createCpt(cpt, { rows: 2, columns: 2 });
  addCell(cpt, { column: 0, row: 0, content: 'A1' });

  const client = new Client({ name: 'fr-deep-test', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: ['server-generate.js'], cwd: process.cwd(), stderr: 'pipe' });
  await client.connect(transport);
  try {
    const namesBefore = (await client.listTools()).tools.map((tool) => tool.name);
    assert.ok(!namesBefore.includes('run_fr_engine_check'), 'generate profile 默认不含引擎工具');

    const gate = decode(await client.callTool({ name: 'quality_gate_cpt', arguments: { path: cpt } }));
    assert.equal(gate.structuralPass, true);
    assert.equal(gate.engineCheck.required, true);
    assert.equal(gate.deliveryPass, false);
    assert.equal(gate.engineCheck.deepAccess?.status, 'not_requested', '门禁不得自动申请租约');
    assert.match(String(gate.engineCheck.deepAccess?.hint), /verify_cpt/, '指路应首选 verify_cpt 免租约通道');
    assert.match(String(gate.nextAction), /verify_cpt/);
    assert.match(String(gate.nextAction), /explicit_engine_check/);

    const namesAfterGate = (await client.listTools()).tools.map((tool) => tool.name);
    assert.deepEqual(namesAfterGate.slice().sort(), namesBefore.slice().sort(), '调用门禁不得改变 tools/list（消除 42→44 副作用）');
    assert.ok(!namesAfterGate.includes('run_fr_engine_check'), '门禁不得顺带解锁引擎工具');

    // 旧的门禁专用理由已下线：fr_engine 只接受 explicit_engine_check
    const badReason = await client.callTool({ name: 'request_deep_tool_access', arguments: { path: cpt, group: 'fr_engine', reason: 'quality_gate' } });
    assert.equal(badReason.isError, true, 'reason=quality_gate 应被拒（门禁不再授予租约）');

    // 显式租约：运行时就绪 → 解锁；缺 FR 运行时 → 结构化 not-ready 且同样不注册工具
    const lease = decode(await client.callTool({
      name: 'request_deep_tool_access',
      arguments: { path: cpt, group: 'fr_engine', reason: 'explicit_engine_check' },
    }));
    const namesLeased = (await client.listTools()).tools.map((tool) => tool.name);
    if (lease.status === 'granted') {
      assert.ok(namesLeased.includes('run_fr_engine_check'), '显式租约后应解锁 run_fr_engine_check');
      assert.ok(namesLeased.includes('fr_engine_check'), '显式租约后应解锁 fr_engine_check');
    } else {
      assert.notEqual(lease.ok, true, `运行时未就绪应返回结构化状态（实际 status=${lease.status}）`);
      assert.ok(!namesLeased.includes('run_fr_engine_check'), '运行时未就绪时不得注册引擎工具');
    }
  } finally {
    await client.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('cellSet selectionId 可直接驱动批量 plan/apply，无需逐格读写', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-batch-mcp-'));
  const cpt = path.join(dir, 'batch-mcp.cpt');
  createCpt(cpt, { rows: 3, columns: 3 });
  addCell(cpt, { column: 0, row: 0, content: '旧1' });
  addCell(cpt, { column: 1, row: 0, content: '旧2' });

  const client = new Client({ name: 'batch-mcp-test', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: ['server-generate.js'], cwd: process.cwd(), stderr: 'pipe' });
  await client.connect(transport);
  try {
    const intent = decode(await client.callTool({
      name: 'record_cpt_read_intent',
      arguments: { path: cpt, views: ['cellSet'], purpose: '批量更新首行', confirmedFacts: ['用户明确指定工作表0和A1:B1'], uncertainties: [] },
    }));
    const selected = decode(await client.callTool({
      name: 'read_cpt_compact',
      arguments: { permitId: intent.permitId, path: cpt, view: 'cellSet', selector: { sheet: 0, ranges: ['A1:B1'], groupBy: ['style'] } },
    }));
    assert.equal(selected.matchedCount, 2);
    assert.equal(selected.items, undefined);

    // P3：batch_mutate_cells 下沉深层，须先凭 report_rewrite 租约解锁
    const rewrite = decode(await client.callTool({
      name: 'request_deep_tool_access',
      arguments: { group: 'report_rewrite', path: cpt, reason: 'explicit_rewrite' },
    }));
    assert.equal(rewrite.status, 'granted');

    const plan = decode(await client.callTool({
      name: 'batch_mutate_cells',
      arguments: { path: cpt, mode: 'plan', commands: [{ op: 'update', target: { selectionId: selected.selectionId }, data: { patch: { content: '批量值' } } }] },
    }));
    assert.equal(plan.status, 'ready');
    const applied = decode(await client.callTool({ name: 'batch_mutate_cells', arguments: { path: cpt, mode: 'apply', planId: plan.planId } }));
    assert.equal(applied.affectedCount, 2);
    assert.deepEqual(cells(cpt).map((cell) => cell.contentText), ['批量值', '批量值']);
  } finally {
    await client.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// M121 死锁回归：声明里没有 path 参数的深层工具（机器级/全局），曾因 beforeCall 要求
// "args.path 必须等于租约绑定路径"而永远匹配不上 —— granted 之后照样永久"未授权"。
// 根因：匹配式 (args?.path && ...) 对无 path 的工具恒为假。
// 本组用例同时钉死"放开路径匹配"没有削弱安全边界：带 path 的工具仍必须单文件隔离。
const PATHLESS_TOOLS = ['fr_detect', 'fr_inspect', 'scheduler_status', 'scheduler_stop', 'scheduler_actions'];

test('M121 无 path 声明的深层工具 granted 后可调用（死锁回归），且路径/额度/零租约三重边界不变', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-pathless-'));
  const cpt = path.join(dir, 'pathless.cpt');
  const other = path.join(dir, 'other.cpt');
  createCpt(cpt, { rows: 2, columns: 2 });
  createCpt(other, { rows: 2, columns: 2 });

  const client = new Client({ name: 'pathless-test', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: ['server.js'], cwd: process.cwd(), stderr: 'pipe' });
  await client.connect(transport);
  const call = async (name, args) => {
    const r = await client.callTool({ name, arguments: args });
    const text = r.content?.[0]?.text ?? '';
    let data = null; try { data = JSON.parse(text); } catch { /* 报错文案非 JSON */ }
    return { isError: r.isError === true, text, data };
  };
  try {
    // ① 零租约：5 个机器级工具必须仍真隐藏（协议层报错，非放行）
    for (const name of PATHLESS_TOOLS) {
      const locked = await call(name, {});
      assert.equal(locked.isError, true, `${name} 零租约时应被拒`);
      assert.match(locked.text, /not found|未授权|无可用租约/, `${name} 零租约应为真隐藏：${locked.text.slice(0, 120)}`);
    }

    // ② diagnostics 组 granted 后，组内带 path 与不带 path 的工具**都**可调
    const diag = await call('request_deep_tool_access', { path: cpt, group: 'diagnostics' });
    assert.equal(diag.data.status, 'granted');
    assert.ok(diag.data.enabledTools.includes('fr_detect'), 'diagnostics 应含 fr_detect');
    assert.ok(diag.data.enabledTools.includes('list_cpt_issues'), 'diagnostics 应含带 path 的 list_cpt_issues');

    const detect = await call('fr_detect', {});
    assert.equal(detect.isError, false, `fr_detect 应可调（死锁回归）：${detect.text.slice(0, 200)}`);
    assert.ok(detect.data?.frHome !== undefined, 'fr_detect 应返回 frHome 探测结果');

    const inspect = await call('fr_inspect', {});
    assert.equal(inspect.isError, false, `fr_inspect 应可调（死锁回归）：${inspect.text.slice(0, 200)}`);

    const issues = await call('list_cpt_issues', { path: cpt });
    assert.equal(issues.isError, false, `同文件带 path 调用应放行：${issues.text.slice(0, 200)}`);

    // ③ 安全边界一：带 path 的工具跨文件复用租约 → 必须仍被拒，且文案要指认"路径不匹配"
    //    （不能笼统说"无可用租约"，否则模型会走重租这条错药方）
    const cross = await call('list_cpt_issues', { path: other });
    assert.equal(cross.isError, true, '跨文件复用必须仍被拒');
    assert.match(cross.text, /不匹配/, `路径不匹配应单独指认：${cross.text.slice(0, 240)}`);
    assert.match(cross.text, /租约绑定在/, `应报出租约绑定路径：${cross.text.slice(0, 240)}`);
    assert.doesNotMatch(cross.text, /额度已用尽或已过期/, `路径不匹配不得误报成额度耗尽：${cross.text.slice(0, 240)}`);

    // ④ 安全边界二：不带 path 的工具调用不得借"路径匹配"放行到未授权状态——
    //    schedule 组同理（3 个全局工具无 path，schedule_list/schedule_get 有 path）
    const sched = await call('request_deep_tool_access', { path: cpt, group: 'schedule' });
    assert.equal(sched.data.status, 'granted');
    for (const name of ['scheduler_status', 'scheduler_actions', 'scheduler_stop']) {
      const r = await call(name, {});
      assert.equal(r.isError, false, `${name} granted 后应可调（死锁回归）：${r.text.slice(0, 200)}`);
    }
    const schedList = await call('schedule_list', { path: cpt });
    assert.equal(schedList.isError, false, `schedule_list 同文件应可调：${schedList.text.slice(0, 200)}`);
    const schedCross = await call('schedule_list', { path: other });
    assert.equal(schedCross.isError, true, 'schedule_list 跨文件复用必须仍被拒');
    assert.match(schedCross.text, /不匹配/, `应指认路径不匹配：${schedCross.text.slice(0, 240)}`);
  } finally {
    await client.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ⑤ 额度对 pathless 工具同样生效。单列一个用例：额度计数必须从干净的单租约起步，
//    混在上面那个用例里会被前置调用消耗掉，精确断言必然失配。
test('M121 额度耗尽同样适用于无 path 工具：跑满 maxCalls 次后重新隐藏', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-pathless-quota-'));
  const cpt = path.join(dir, 'quota.cpt');
  createCpt(cpt, { rows: 2, columns: 2 });

  const client = new Client({ name: 'pathless-quota-test', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: ['server.js'], cwd: process.cwd(), stderr: 'pipe' });
  await client.connect(transport);
  const call = async (name, args) => {
    const r = await client.callTool({ name, arguments: args });
    const text = r.content?.[0]?.text ?? '';
    let data = null; try { data = JSON.parse(text); } catch { /* 报错文案非 JSON */ }
    return { isError: r.isError === true, text, data };
  };
  try {
    const diag = await call('request_deep_tool_access', { path: cpt, group: 'diagnostics' });
    assert.equal(diag.data.status, 'granted');
    const max = diag.data.maxCalls;
    assert.ok(max > 1, `额度应为次数型，实际 ${max}`);

    let last = null;
    for (let i = 0; i < max; i++) last = await call('fr_detect', {});
    assert.equal(last.isError, false, `第 ${max} 次调用应在额度内：${last.text.slice(0, 200)}`);

    const spent = await call('fr_detect', {});
    assert.equal(spent.isError, true, `第 ${max + 1} 次调用应因额度耗尽被拒：${spent.text.slice(0, 200)}`);
    assert.match(spent.text, /not found|未授权|无可用租约/, `额度耗尽应真隐藏：${spent.text.slice(0, 200)}`);
    assert.doesNotMatch(spent.text, /disabled/, '额度耗尽应动态注销，非 disabled 占位');
  } finally {
    await client.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
