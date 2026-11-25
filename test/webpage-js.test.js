// test/webpage-js.test.js —— 模板级 <ReportWebAttr><WebPageContent> 分页预览事件 JS 的读写
//
// 背景（2026-11-07 审批模板收尾）：用户要删分页预览 afterload 里最后一行
//   console.log("[审批-分页] 任务:" + t + " 上报人:" + s);
// 该块同时含审批人名单注入（*_approvers），整节点改写会把注入一起覆盖。
// cpt-mcp 旧工具集只有：set_report_listener（只写 Report 子级）、set_webwrite_js（只写
// WebWriteContent）、update_report_node（低层整节点）；<ReportWebAttr><WebPageContent> 没有
// 结构化写入口。本测试锁定新 set_webpage_js 的「定位 / 读回 / 片段替换 / 保留同块其它 JS」
// 行为，以及读侧 get_report_listener 对该容器的纳入。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCpt } from '../lib/generate.js';
import { setWebPageJs, setWebWriteJs } from '../lib/edits.js';
import { reportListener, checkReportJs } from '../lib/cpt.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import '../scripts/isolate-store.mjs'; // JS 基线 store 隔离

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-webpage-js-'));
const read = (p) => fs.readFileSync(p, 'utf8');
const webpageListeners = (p, event) => reportListener(p, { event }).listeners.filter((l) => l.area === 'webpage');

const APPROVERS = [
  'var names = {',
  '  "业务部": "张三",',
  '  "数据部": "李四",',
  '};',
  'var t = "业务部";',
  'var s = names[t];',
].join('\n');
const CONSOLE_LINE = 'console.log("[审批-分页] 任务:" + t + " 上报人:" + s);';

test('set_webpage_js：写入 WebPageContent/afterload，get_report_listener 以 area=webpage 读回', () => {
  const d = tmp();
  const p = path.join(d, 'a.cpt');
  createCpt(p, { rows: 3, columns: 3 });
  try {
    const js = `${APPROVERS}\n${CONSOLE_LINE}`;
    const r = setWebPageJs(p, { event: 'afterload', js });
    assert.equal(r.action, 'set_webpage_js');
    assert.equal(r.mode, 'insert');
    assert.equal(r.jsBytesAfter, Buffer.byteLength(js, 'utf8'));

    const got = webpageListeners(p, 'afterload');
    assert.equal(got.length, 1, '应能从 WorkBook 级 WebPageContent 读回 afterload');
    assert.equal(got[0].scope, 'workbook');
    assert.equal(got[0].js, js, '读回 CDATA 原文应与写入一致');
    assert.equal(got[0].jsBytes, Buffer.byteLength(js, 'utf8'));

    const xml = read(p);
    assert.ok(xml.includes('<ReportWebAttr>'));
    assert.ok(xml.includes('<WebPageContent>'));
    assert.ok(xml.includes('<Listener event="afterload">'));
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test('set_webpage_js：patchFind 只删 console.log 行，审批人注入等其他 JS 原样保留', () => {
  const d = tmp();
  const p = path.join(d, 'a.cpt');
  createCpt(p, { rows: 3, columns: 3 });
  try {
    const js = `${APPROVERS}\n${CONSOLE_LINE}`;
    setWebPageJs(p, { event: 'afterload', js });
    const before = webpageListeners(p, 'afterload')[0];

    const r = setWebPageJs(p, {
      event: 'afterload',
      match: '[审批-分页]',
      expectedSha256: before.sha256,
      patchFind: CONSOLE_LINE,
      patchReplace: '',
    });
    assert.equal(r.mode, 'patch');
    assert.equal(r.patchHits, 1);
    assert.equal(r.jsBytesAfter, Buffer.byteLength(`${APPROVERS}\n`, 'utf8'), '只删命中行；行前换行按片段替换语义保留');
    assert.ok(r.jsBytesAfter < r.jsBytesBefore);

    const after = webpageListeners(p, 'afterload')[0];
    assert.ok(!after.js.includes('console.log'), 'console.log 行应被删除');
    assert.ok(after.js.includes('"业务部": "张三"'), '审批人注入必须保留');
    assert.ok(after.js.includes('var s = names[t];'), '同块其它 JS 必须保留');
    assert.equal(after.js.trimEnd(), APPROVERS, '只删命中片段，其余字节不变');
    assert.equal(after.jsLines, (`${APPROVERS}\n`).split('\n').length);

    const chk = checkReportJs(p);
    assert.equal(chk.failed, 0, `删除后 JS 语法应仍合法：${JSON.stringify(chk.failures)}`);
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test('set_webpage_js：同 event 多 Listener 未传 match 拒绝静默命中，match 只改目标块', () => {
  const d = tmp();
  const p = path.join(d, 'a.cpt');
  createCpt(p, { rows: 2, columns: 2 });
  try {
    setWebPageJs(p, { event: 'afterload', js: 'var keep = "A";' });
    // 直接拼出第二个同 event Listener（模拟真实模板同事件多块）
    const xml = read(p);
    const marker = '<Listener event="afterload">';
    const second = '<Listener event="afterload">\n<JavaScript class="com.fr.js.JavaScriptImpl">\n<Parameters/>\n<Content>\n<![CDATA[var target = "B";]]></Content>\n</JavaScript>\n</Listener>\n';
    fs.writeFileSync(p, xml.replace(marker, `${second}${marker}`));

    assert.throws(
      () => setWebPageJs(p, { event: 'afterload', js: 'var fail = true;' }),
      /禁止静默命中第一个/,
    );
    const r = setWebPageJs(p, { event: 'afterload', match: 'target = "B"', js: 'var target = "B2";' });
    assert.equal(r.mode, 'update');
    const xml2 = read(p);
    assert.ok(xml2.includes('var keep = "A";'), '另一块必须原样保留');
    assert.ok(xml2.includes('var target = "B2";'));
    assert.ok(!xml2.includes('var target = "B";'));

    const merged = setWebPageJs(p, { event: 'afterload', aggregate: true });
    assert.equal(merged.mode, 'merge');
    const got = webpageListeners(p, 'afterload');
    assert.equal(got.length, 1, 'aggregate 后只保留一个 Listener');
    assert.ok(got[0].js.includes('var keep = "A";'));
    assert.ok(got[0].js.includes('var target = "B2";'));
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test('set_webpage_js：删除只删 WebPageContent 同 event 块，不碰 WebWriteContent 同 event', () => {
  const d = tmp();
  const p = path.join(d, 'a.cpt');
  createCpt(p, { rows: 2, columns: 2, webWrite: true });
  try {
    setWebPageJs(p, { event: 'afterload', js: 'var page = 1;' });
    setWebWriteJs(p, { event: 'afterload', js: 'var write = 2;' });

    const r = setWebPageJs(p, { event: 'afterload' });
    assert.equal(r.mode, 'delete');
    assert.equal(webpageListeners(p, 'afterload').length, 0, '分页预览块应删除');
    const write = reportListener(p, { event: 'afterload' }).listeners.filter((l) => l.area === 'report');
    // reportListener 的 area=report 是 Report 子级；WebWrite 不在其中，直接查 XML 确认它还在。
    assert.equal(write.length, 0);
    assert.ok(read(p).includes('var write = 2;'), 'WebWriteContent 同 event 块必须保留');
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test('set_webpage_js：缺 WebPageContent 时补建标准容器；自闭合容器会展开', () => {
  const d = tmp();
  const p = path.join(d, 'a.cpt');
  createCpt(p, { rows: 2, columns: 2, withWebAttr: false });
  try {
    assert.ok(!read(p).includes('<WebPageContent>'));
    const r = setWebPageJs(p, { event: 'afterload', js: 'var created = true;' });
    assert.equal(r.mode, 'insert');
    assert.equal(r.repaired, 'created');
    const xml = read(p);
    assert.ok(xml.includes('<ReportWebAttr>'));
    assert.ok(xml.includes('<WebPageContent>'));
    assert.ok(xml.includes('var created = true;'));
    assert.equal(webpageListeners(p, 'afterload').length, 1);

    // 自闭合容器 → 展开后可挂 Listener
    const p2 = path.join(d, 'b.cpt');
    createCpt(p2, { rows: 2, columns: 2 });
    fs.writeFileSync(p2, read(p2).replace(/<WebPageContent>[\s\S]*?<\/WebPageContent>/, '<WebPageContent/>'));
    const r2 = setWebPageJs(p2, { event: 'afterload', js: 'var expanded = true;' });
    assert.equal(r2.repaired, 'expanded');
    assert.ok(read(p2).includes('var expanded = true;'));
    assert.equal(webpageListeners(p2, 'afterload').length, 1);
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test('set_webpage_js：expectedSha256 不符时拒绝且不写文件', () => {
  const d = tmp();
  const p = path.join(d, 'a.cpt');
  createCpt(p, { rows: 2, columns: 2 });
  try {
    setWebPageJs(p, { event: 'afterload', js: 'var v = 1;' });
    const before = read(p);
    assert.throws(
      () => setWebPageJs(p, { event: 'afterload', js: 'var v = 2;', expectedSha256: '0'.repeat(64) }),
      /expectedSha256|sha256|不符/i,
    );
    assert.equal(read(p), before, '校验失败不得写文件');
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test('set_webpage_js：patch/delete 目标不存在时不得先建容器（文件不变）', () => {
  const d = tmp();
  const p = path.join(d, 'a.cpt');
  createCpt(p, { rows: 2, columns: 2, withWebAttr: false });
  try {
    const before = read(p);
    assert.throws(
      () => setWebPageJs(p, { event: 'afterload', patchFind: 'x', patchReplace: '' }),
      /无 <WebPageContent>|文件未改动/,
    );
    assert.equal(read(p), before, 'patch 失败不得建容器/改文件');
    assert.throws(
      () => setWebPageJs(p, { event: 'afterload' }),
      /无 <WebPageContent>|文件未改动/,
    );
    assert.equal(read(p), before, 'delete 失败不得建容器/改文件');
    const noop = setWebPageJs(p, { event: 'afterload', aggregate: true });
    assert.equal(noop.mode, 'noop');
    assert.equal(read(p), before, 'aggregate 无 js 且无容器不得改文件');
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test('MCP full 档：set_webpage_js 可调用，且可执行 JS 需 allowUnsafeScript', async () => {
  const d = tmp();
  const p = path.join(d, 'mcp.cpt');
  createCpt(p, { rows: 2, columns: 2 });
  const client = new Client({ name: 'webpage-js-test', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['server.js'],
    cwd: process.cwd(),
    stderr: 'pipe',
    env: {
      CPT_MCP_TOOL_PROFILE: 'full',
      CPT_MCP_HOT_RELOAD: '0',
      CPT_MCP_ALLOWED_ROOTS: os.tmpdir(),
    },
  });
  await client.connect(transport);
  try {
    const tools = (await client.listTools()).tools;
    const tool = tools.find((t) => t.name === 'set_webpage_js');
    assert.ok(tool, 'full 档应注册 set_webpage_js');
    assert.ok(tool.inputSchema?.properties?.path);
    assert.ok(tool.inputSchema?.properties?.event);

    const blocked = await client.callTool({
      name: 'set_webpage_js',
      arguments: { path: p, event: 'afterload', js: 'var mcpSafe = true;' },
    });
    assert.equal(blocked.isError, true, '未传 allowUnsafeScript 必须被安全围栏拒绝');
    assert.match(blocked.content?.[0]?.text ?? '', /allowUnsafeScript/);

    const ok = await client.callTool({
      name: 'set_webpage_js',
      arguments: { path: p, event: 'afterload', js: 'var mcpSafe = true;', allowUnsafeScript: true },
    });
    assert.notEqual(ok.isError, true, ok.content?.[0]?.text);
    assert.match(ok.content?.[0]?.text ?? '', /set_webpage_js/);

    const got = await client.callTool({
      name: 'get_report_listener',
      arguments: { path: p, event: 'afterload' },
    });
    assert.notEqual(got.isError, true);
    const parsed = JSON.parse(got.content?.[0]?.text ?? '{}');
    assert.equal(parsed.listeners?.some((l) => l.area === 'webpage' && l.js.includes('mcpSafe')), true);
  } finally {
    await client.close();
    fs.rmSync(d, { recursive: true, force: true });
  }
}, { timeout: 60000 });
