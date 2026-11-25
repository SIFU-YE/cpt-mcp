// test/js-read-locate.test.js —— 读侧「定位 / 分页 / 读按钮正文」能力（2026-11-19）
//
// 背景（两个真实会话暴露的 cpt-mcp 能力缺口）：
//   ① 某会话/v1：改工具栏按钮 JS 前只能拿到 hasJs/jsBytes/jsLines/sha256，拿不到 JS 正文
//      → 无法核对旧块，只能整块盲写或绕去裸读 .cpt XML。
//   ② 某会话/v5：afterload 有 40KB / 5,600+ 行 JS，只能在「整块读」和「按字符偏移读」之间选，
//      模型不知道目标片段在哪个偏移 → 被迫裸读 .cpt XML，最终没完成 writesuccess/遮罩收口配置。
// 修复：list_toolbar_buttons 补 includeJs + jsOffset/jsLimit + buttonText/index/match；
//      get_webwrite_js / get_report_listener 补 find（命中偏移/行号/上下文）与 availableEvents，
//      并把 jsOffset/jsLimit/find 广告进轻 schema（此前「可传但不可见」）。
// 2026-11-19 审查补强：report_listener 省略 event=清单（不再整块回全部 JS）；find 模式带
//      designerEscapes、忽略分页参数并在 hint 说明；jsTruncated 尾段不误报；定位模式 count 保留
//      总数并另给 matched；js 结构异常给 jsStructureMismatch 标志。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createCpt } from '../lib/generate.js';
import { addToolbarButton, listToolbarButtons, setReportListener, setWebWriteJs } from '../lib/edits.js';
import { webwriteListener, reportListener, findJsWindows } from '../lib/cpt.js';
import { CPT_MCP_INSTRUCTIONS } from '../lib/contract.js';
import '../scripts/isolate-store.mjs'; // M123：JS 基线 store 隔离，直跑也不污染真实 store

delete process.env.CPT_MCP_ALLOWED_ROOTS;

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-jsread-'));
const sha = (s) => createHash('sha256').update(String(s ?? ''), 'utf8').digest('hex');

const PAD = 'var pad = 0;\n'.repeat(300);
const MASK_MODULE = '/* 统一遮罩模块 START */\nfunction beginMask() { return 1; }\n/* 统一遮罩模块 END */\n';
const BIG_AFTERLOAD = `/* HEAD */\n${PAD}${MASK_MODULE}${'var tail = 1;\n'.repeat(20)}`;

function fixture() {
  const d = tmp();
  const p = path.join(d, 't.cpt');
  createCpt(p, { rows: 2, columns: 2, webWrite: true });
  addToolbarButton(p, { buttonText: '重算', js: 'var marker = "RECALC-V1";\nfunction longFn(){ return 1; }' });
  addToolbarButton(p, { buttonText: '导出', js: 'var exp = 1;' });
  setWebWriteJs(p, { event: 'afterload', js: BIG_AFTERLOAD });
  setWebWriteJs(p, { event: 'writesuccess', js: 'window.__mask && window.__mask.end(true, "ok");' });
  setReportListener(p, { event: 'afterload', js: 'var FIN = "FIN-MARK";', sheet: 0 });
  return { d, p };
}

async function withReport(fn) {
  const dir = tmp();
  const p = path.join(dir, 't.cpt');
  const client = new Client({ name: 'jsread-test', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath, args: ['server.js'], cwd: process.cwd(), stderr: 'pipe',
    env: { CPT_MCP_TOOL_PROFILE: 'report' },
  });
  await client.connect(transport);
  const call = async (name, args) => {
    const r = await client.callTool({ name, arguments: args });
    const text = r.content?.[0]?.text ?? '';
    let data = null;
    try { data = JSON.parse(text); } catch { /* 报错文案非 JSON */ }
    return { isError: r.isError === true, text, data };
  };
  try {
    return await fn({ client, call, dir, p });
  } finally {
    await client.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('findJsWindows：命中偏移/行号/上下文/截断与未命中提示', () => {
  const code = 'line1\nline2\nTARGET_A x\nline4\nTARGET_A y\n';
  const r = findJsWindows(code, 'TARGET_A');
  assert.equal(r.count, 2);
  assert.equal(r.total, 2);
  assert.equal(r.truncated, false);
  assert.equal(r.matches[0].jsOffset, code.indexOf('TARGET_A'));
  assert.equal(r.matches[0].line, 3);
  assert.equal(r.matches[1].line, 5);
  assert.ok(r.matches[0].context.includes('TARGET_A'));
  assert.equal(code.slice(r.matches[0].contextOffset, r.matches[0].contextOffset + 6), 'line1\n');
  assert.equal(r.matches[0].snippet, undefined, 'snippet 已删除（只回显 needle，无信息量）');
  const limited = findJsWindows(code, 'TARGET_A', { findMax: 1 });
  assert.equal(limited.count, 1);
  assert.equal(limited.total, 2);
  assert.equal(limited.truncated, true);
  const none = findJsWindows(code, 'NO_SUCH_TOKEN_XYZ');
  assert.equal(none.count, 0);
  assert.match(none.hint, /没有字面量/);
  assert.throws(() => findJsWindows(code, ''), /find 不能为空/);
  assert.throws(() => findJsWindows(code, 'x', { findContext: 9999 }), /findContext/);
  assert.throws(() => findJsWindows(code, 'x', { findMax: 0 }), /findMax/);
});

test('list_toolbar_buttons：includeJs 返回旧 JS 正文、分页切片、尾段不误报 truncatd', () => {
  const { d, p } = fixture();
  const js = 'var marker = "RECALC-V1";\nfunction longFn(){ return 1; }';
  const l = listToolbarButtons(p, { includeJs: true });
  assert.equal(l.count, 2, 'count 保持工具栏按钮总数语义');
  const recalc = l.buttons.find((b) => b.text === '重算');
  assert.equal(recalc.js, js, 'includeJs=true 必须返回按钮 JS 原文');
  assert.equal(recalc.jsLength, js.length);
  assert.equal(recalc.sha256, sha(js), 'sha256 与 js 原文同口径（set_toolbar_button_js 的 expectedSha256 可直接用）');
  assert.equal(recalc.jsTruncated, false);
  // 默认不返回正文（省 token，向后兼容）
  const plain = listToolbarButtons(p);
  assert.equal(plain.buttons[0].js, undefined);
  // 分页读：jsOffset/jsLimit
  const sliced = listToolbarButtons(p, { includeJs: true, buttonText: '重算', jsOffset: 4, jsLimit: 6 });
  assert.equal(sliced.matched, 1);
  assert.equal(sliced.count, 2, '定位模式 count 仍是按钮总数');
  assert.equal(sliced.buttons[0].js, 'marker');
  assert.equal(sliced.buttons[0].jsOffset, 4);
  assert.equal(sliced.buttons[0].jsTruncated, true);
  assert.equal(sliced.buttons[0].jsLength, js.length);
  // 尾段：offset+len 已到末尾 → 不是截断
  const tail = listToolbarButtons(p, { includeJs: true, buttonText: '重算', jsOffset: js.length - 5, jsLimit: 100 });
  assert.equal(tail.buttons[0].js, js.slice(-5));
  assert.equal(tail.buttons[0].jsTruncated, false, '尾段不应误报 jsTruncated=true');
  // 定位单颗按钮
  const byText = listToolbarButtons(p, { buttonText: '重算', includeJs: true });
  assert.equal(byText.buttons[0].text, '重算');
  const byIndex = listToolbarButtons(p, { index: 0, includeJs: true });
  assert.equal(byIndex.buttons[0].index, 0);
  assert.throws(() => listToolbarButtons(p, { buttonText: '不存在', includeJs: true }), /未找到/);
  assert.throws(() => listToolbarButtons(p, { includeJs: true, jsOffset: 99999 }), /越界/);
  assert.throws(() => listToolbarButtons(p, { toolbar: 'all', buttonText: '重算' }), /不能与|toolbar/);
  fs.rmSync(d, { recursive: true, force: true });
});

test('list_toolbar_buttons：非标准 <JavaScript> 结构给 jsStructureMismatch 标志', () => {
  const d = tmp();
  const p = path.join(d, 't.cpt');
  createCpt(p, { rows: 2, columns: 2, webWrite: true });
  addToolbarButton(p, { buttonText: '异常按钮', js: 'var a = 1;' });
  let raw = fs.readFileSync(p, 'utf8');
  raw = raw.replace(/<JavaScript class="com\.fr\.js\.JavaScriptImpl"[\s\S]*?<\/JavaScript>/,
    '<JavaScript class="com.fr.js.JavaScriptImpl"><Parameters/></JavaScript>');
  fs.writeFileSync(p, raw);
  const r = listToolbarButtons(p, { includeJs: true, buttonText: '异常按钮' });
  const b = r.buttons[0];
  assert.equal(b.hasJs, true);
  assert.equal(b.jsStructureMismatch, true, '有 <JavaScript> 但无标准 Content 时必须显式标记，避免 js="" 被当旧块为空整块覆盖');
  assert.match(b.jsNote, /不要据此/);
  fs.rmSync(d, { recursive: true, force: true });
});

test('get_webwrite_js find：大块 afterload 先定位再按偏移分页读（不必整块读/裸读 XML）', () => {
  const { d, p } = fixture();
  const r = webwriteListener(p, { event: 'afterload', find: '统一遮罩模块' });
  assert.equal(r.event, 'afterload');
  assert.equal(r.find, '统一遮罩模块');
  assert.equal(r.count, 1);
  const hit = r.listeners[0].find[0];
  assert.equal(hit.jsOffset, BIG_AFTERLOAD.indexOf('统一遮罩模块'));
  assert.equal(hit.line, BIG_AFTERLOAD.slice(0, hit.jsOffset).split('\n').length);
  assert.ok(hit.context.includes('统一遮罩模块'));
  assert.equal(r.listeners[0].js, undefined, 'find 模式不返回全文（省 token）');
  assert.equal(r.listeners[0].jsLength, BIG_AFTERLOAD.length);
  assert.match(r.hint, /忽略 jsOffset\/jsLimit/, 'find 模式忽略分页参数要在 hint 里说明');
  // 用命中的偏移分页读回原文：正是目标片段
  const sliced = webwriteListener(p, { event: 'afterload', jsOffset: hit.jsOffset, jsLimit: 20 });
  assert.equal(sliced.listeners[0].js, BIG_AFTERLOAD.slice(hit.jsOffset, hit.jsOffset + 20));
  // 不传 event = 跨全部 Web 事件搜索
  const cross = webwriteListener(p, { find: '__mask' });
  assert.equal(cross.count, 1);
  assert.equal(cross.events[0].event, 'writesuccess');
  assert.ok(cross.events[0].find.length >= 1);
  fs.rmSync(d, { recursive: true, force: true });
});

test('get_webwrite_js find 未命中：返回 availableEvents；match 同用时的归因提示', () => {
  const { d, p } = fixture();
  const r = webwriteListener(p, { event: 'afterload', find: 'NO-SUCH-TOKEN-XYZ' });
  assert.equal(r.count, 0);
  assert.ok(Array.isArray(r.availableEvents));
  assert.ok(r.availableEvents.includes('afterload'));
  assert.ok(r.availableEvents.includes('writesuccess'));
  assert.match(r.hint, /availableEvents/);
  // find 命中但 match 把 listener 滤掉 → 不能误报「全文没有该字面量」
  const both = webwriteListener(p, { event: 'afterload', find: '统一遮罩模块', match: 'NO-SUCH-MATCH-ZZZ' });
  assert.equal(both.count, 0);
  assert.match(both.hint, /match/, 'match 可能过滤掉命中时 hint 必须点明');
  fs.rmSync(d, { recursive: true, force: true });
});

test('find 模式带 designerEscapes（正文含 ]A 时模型仍知道这是正常编码）', () => {
  const d = tmp();
  const p = path.join(d, 't.cpt');
  createCpt(p, { rows: 2, columns: 2, webWrite: true });
  setWebWriteJs(p, { event: 'afterload', js: 'var MARK = 1;\nvar s = "]A";' });
  const r = webwriteListener(p, { event: 'afterload', find: 'MARK' });
  assert.equal(r.count, 1);
  assert.ok(r.designerEscapes, 'find 模式也要返回 designerEscapes');
  assert.ok(r.designerEscapes.count >= 1);
  fs.rmSync(d, { recursive: true, force: true });
});

test('get_report_listener：省略 event=只列清单（不整块回全部 JS）；find 可全文搜索', () => {
  const { d, p } = fixture();
  const listing = reportListener(p);
  assert.equal(listing.event, null);
  assert.equal(listing.count, 1);
  assert.equal(listing.listeners[0].js, undefined, '清单模式不得回 JS 正文');
  assert.equal(listing.listeners[0].jsLength, 'var FIN = "FIN-MARK";'.length);
  assert.match(listing.hint, /清单/);
  const r = reportListener(p, { find: 'FIN-MARK' });
  assert.equal(r.count, 1);
  assert.equal(r.listeners[0].area, 'report');
  assert.equal(r.listeners[0].find[0].jsOffset, 'var FIN = "FIN-MARK";'.indexOf('FIN-MARK'));
  const none = reportListener(p, { find: 'NOPE-TOKEN' });
  assert.equal(none.count, 0);
  assert.ok(Array.isArray(none.availableEvents));
  assert.ok(none.availableEvents.includes('afterload'));
  // 单事件全文模式仍然工作（js 仍在）
  const full = reportListener(p, { event: 'afterload' });
  assert.equal(full.listeners[0].js, 'var FIN = "FIN-MARK";');
  fs.rmSync(d, { recursive: true, force: true });
});

test('MCP report 档：新参数在 tools/list 可发现（jsOffset/jsLimit/find/includeJs）', async () => {
  await withReport(async ({ client }) => {
    const tools = (await client.listTools()).tools;
    const props = (name) => Object.keys(tools.find((t) => t.name === name).inputSchema.properties);
    // 2026-11-19 教训：能力早就在处理器的 full schema 里（jsOffset/jsLimit 可传但没广告），
    // 模型看不到也不会传 → 等于没有。以下键必须在广告 schema 里可见。
    const ww = props('get_webwrite_js');
    for (const key of ['jsOffset', 'jsLimit', 'find']) {
      assert.ok(ww.includes(key), `get_webwrite_js 广告 schema 应含 ${key}（模型可见才用得上），实际 ${ww.join(',')}`);
    }
    const rl = props('get_report_listener');
    for (const key of ['jsOffset', 'jsLimit', 'find']) {
      assert.ok(rl.includes(key), `get_report_listener 广告 schema 应含 ${key}`);
    }
    const tb = props('list_toolbar_buttons');
    for (const key of ['includeJs', 'jsOffset', 'jsLimit', 'buttonText', 'index', 'match']) {
      assert.ok(tb.includes(key), `list_toolbar_buttons 广告 schema 应含 ${key}`);
    }
  });
});

test('MCP report 档端到端：租约读按钮 JS + 定位大块 JS + 事件清单', async () => {
  await withReport(async ({ call, p }) => {
    const created = await call('create_cpt', { path: p, rows: 2, columns: 2, webWrite: true });
    assert.ok(!created.isError, created.text.slice(0, 200));
    // toolbar_edit 租约族 → add_toolbar_button（report 档默认隐藏，必须真租到）
    const leaseTb = await call('request_deep_tool_access', { path: p, group: 'toolbar_edit' });
    assert.ok(!leaseTb.isError, `toolbar_edit 租约失败：${leaseTb.text.slice(0, 200)}`);
    const btn = await call('add_toolbar_button', {
      path: p, buttonText: '重算', js: 'var marker = "RECALC-V1";', allowUnsafeScript: true,
    });
    assert.ok(!btn.isError, `add_toolbar_button 失败：${btn.text.slice(0, 300)}`);

    const leaseSc = await call('request_deep_tool_access', { path: p, group: 'scripting' });
    assert.ok(!leaseSc.isError, `scripting 租约失败：${leaseSc.text.slice(0, 200)}`);
    const setBig = await call('set_webwrite_js', { path: p, event: 'afterload', js: BIG_AFTERLOAD, allowUnsafeScript: true });
    assert.ok(!setBig.isError, setBig.text.slice(0, 300));
    const setWs = await call('set_webwrite_js', { path: p, event: 'writesuccess', js: 'window.__mask.end(true,"ok");', allowUnsafeScript: true });
    assert.ok(!setWs.isError, setWs.text.slice(0, 300));

    const lb = await call('list_toolbar_buttons', { path: p, includeJs: true, buttonText: '重算' });
    assert.ok(!lb.isError, lb.text.slice(0, 300));
    assert.equal(lb.data.matched, 1);
    assert.ok(lb.data.buttons[0].js.includes('RECALC-V1'), 'includeJs=true 应读到按钮 JS 正文');

    const found = await call('get_webwrite_js', { path: p, event: 'afterload', find: '统一遮罩模块' });
    assert.ok(!found.isError, found.text.slice(0, 300));
    const hit = found.data.listeners[0].find[0];
    assert.equal(hit.jsOffset, BIG_AFTERLOAD.indexOf('统一遮罩模块'));
    const slice = await call('get_webwrite_js', { path: p, event: 'afterload', jsOffset: hit.jsOffset, jsLimit: 12 });
    assert.equal(slice.data.listeners[0].js, BIG_AFTERLOAD.slice(hit.jsOffset, hit.jsOffset + 12));

    const miss = await call('get_webwrite_js', { path: p, event: 'afterload', find: 'NOPE-XYZ' });
    assert.ok(miss.data.availableEvents.includes('writesuccess'), '未命中应回事件清单');

    const rlList = await call('get_report_listener', { path: p });
    assert.ok(!rlList.isError, rlList.text.slice(0, 200));
    assert.equal(rlList.data.listeners?.[0]?.js, undefined, '省略 event 应只列清单，不回全文');
  });
});

test('instructions 已写入读法指引（find/jsOffset、includeJs、writesuccess 语义）', () => {
  assert.ok(CPT_MCP_INSTRUCTIONS.includes('find'), 'instructions 应说明大块 JS 用 find 定位');
  assert.ok(CPT_MCP_INSTRUCTIONS.includes('includeJs'), 'instructions 应说明工具栏按钮 JS 用 includeJs 读');
  assert.ok(CPT_MCP_INSTRUCTIONS.includes('writesuccess'), 'instructions 应点名 writesuccess/writefailure 事件');
  assert.ok(CPT_MCP_INSTRUCTIONS.includes('裸读'), 'instructions 应明确不要裸读 .cpt XML');
});
