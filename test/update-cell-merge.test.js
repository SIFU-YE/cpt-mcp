// test/update-cell-merge.test.js —— 2026-11-12 P0-1「瘦身不丢能力」回归
//
// 背景：按会话记录降本，report 静态表 42→33；调用少但有用的工具**先判断能否并入其它工具**：
//   · set_cell_content_type → update_cell({contentType})
//   · set_cell_span          → update_cell({colspan,rowspan})
//   · get_cell_style         → get_cells({includeStyle:true})
//   · get_build_progress     → read_cpt({includeProgress:true})
//   · add_style / build_report → 具名租约族（style_manage / generator_full），能力不掉
// 本文件在真 MCP（report 档）上把这几条合并路径逐一走通，防止"省了 token 却丢了能力"。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createCpt, addStyle, addCell } from '../lib/generate.js';
import { validateCpt } from '../lib/validate.js';
import { REPORT_STATIC_TOOLS } from '../lib/contract.js';
import '../scripts/isolate-store.mjs'; // M123：JS 基线 store 隔离

delete process.env.CPT_MCP_ALLOWED_ROOTS;

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-merge-'));

async function withReport(fn) {
  const dir = tmp();
  const p = path.join(dir, 'm.cpt');
  createCpt(p, { rows: 4, columns: 4, webWrite: true });
  const client = new Client({ name: 'merge-test', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath, args: ['server.js'], cwd: process.cwd(), stderr: 'pipe',
    env: { CPT_MCP_TOOL_PROFILE: 'report', CPT_MCP_ALLOWED_ROOTS: `${os.homedir()};${os.tmpdir()}` },
  });
  await client.connect(transport);
  const call = async (name, args) => {
    const r = await client.callTool({ name, arguments: args });
    const text = r.content?.[0]?.text ?? '';
    let data = null; try { data = JSON.parse(text); } catch { /* 错误文案非 JSON */ }
    return { isError: r.isError === true, text, data, res: r };
  };
  const names = async () => (await client.listTools()).tools.map((t) => t.name);
  try {
    return await fn({ client, call, names, dir, p });
  } finally {
    await client.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('update_cell 合并 contentType（原 set_cell_content_type）', async () => {
  await withReport(async ({ call, p }) => {
    addCell(p, { column: 0, row: 1, content: 'A' });
    addCell(p, { column: 1, row: 1, content: '1' });
    const ds = await call('update_cell', { path: p, column: 0, row: 1, contentType: 'dsColumn', dsName: 'ds1', columnName: 'spec_id' });
    // ds1 不存在时仍应给出结构化错误而非 unknown-tool（证明参数已进入处理器）
    assert.equal(ds.isError, true);
    assert.match(ds.text, /数据集|dataset|ds1|定位/, `contentType 路径应被处理：${ds.text.slice(0, 160)}`);
    // text → formula 切换（formula 参数等价于旧工具的 formula）
    const f = await call('update_cell', { path: p, column: 1, row: 1, contentType: 'formula', formula: '=SUM(A1:A3)' });
    assert.ok(!f.isError, `contentType=formula 应成功：${f.text.slice(0, 200)}`);
    const cells = await call('get_cells', { path: p, column: 1, row: 1 });
    assert.equal(cells.data?.cells?.[0]?.contentKind, 'object:Formula', '公式应以官方 Formula 对象落盘');
    // 非法 contentType 被完整 schema 拒绝
    const bad = await call('update_cell', { path: p, column: 1, row: 1, contentType: 'nope' });
    assert.equal(bad.isError, true);
  });
});

test('update_cell 合并 colspan/rowspan（原 set_cell_span）', async () => {
  await withReport(async ({ call, p }) => {
    addCell(p, { column: 0, row: 2, content: 'span-me' });
    const merged = await call('update_cell', { path: p, column: 0, row: 2, colspan: 2 });
    assert.ok(!merged.isError, `colspan 合并应成功：${merged.text.slice(0, 200)}`);
    let cells = await call('get_cells', { path: p, column: 0, row: 2 });
    assert.equal(cells.data?.cells?.[0]?.colspan, 2, 'get_cells 应读回 colspan=2');
    const cleared = await call('update_cell', { path: p, column: 0, row: 2, colspan: null });
    assert.ok(!cleared.isError, `colspan=null 取消应成功：${cleared.text.slice(0, 200)}`);
    cells = await call('get_cells', { path: p, column: 0, row: 2 });
    assert.equal(cells.data?.cells?.[0]?.colspan, null, '取消后 colspan 应为 null');
    assert.equal(validateCpt(p).filter((i) => i.severity === 'error').length, 0);
  });
});

test('update_cell 一次只做一类改动（contentType 与 colspan 互斥）', async () => {
  await withReport(async ({ call, p }) => {
    const mixed = await call('update_cell', { path: p, column: 0, row: 1, contentType: 'text', content: 'x', colspan: 2 });
    assert.equal(mixed.isError, true);
    assert.match(mixed.text, /一次只做一类改动/);
    assert.match(mixed.text, /contentType/);
  });
});

test('get_cells({includeStyle:true}) 取代 get_cell_style（单格样式+共享计数）', async () => {
  await withReport(async ({ call, p }) => {
    addStyle(p, { fontSizePt: 16, bold: true, backgroundColor: '#D9E1F2' });
    addCell(p, { column: 0, row: 1, styleIndex: 1, content: 'A' });
    addCell(p, { column: 1, row: 1, styleIndex: 1, content: 'B' });
    const r = await call('get_cells', { path: p, row: 1, includeStyle: true });
    assert.ok(!r.isError, r.text.slice(0, 160));
    const cell = r.data?.cells?.find((c) => c.column === 0 && c.row === 1);
    assert.ok(cell?.styleDetail, 'includeStyle=true 应有 styleDetail');
    assert.equal(cell.styleDetail.styleIndex, 1);
    assert.equal(cell.styleDetail.bold, true);
    assert.equal(cell.styleDetail.backgroundColor, '#D9E1F2');
    assert.ok(cell.styleDetail.sharedCells >= 2, `共享计数应 ≥2，实际 ${cell.styleDetail.sharedCells}`);
    // 默认不附带（不无谓涨上下文）
    const plain = await call('get_cells', { path: p, row: 1 });
    assert.equal(plain.data?.cells?.[0]?.styleDetail, undefined);
  });
});

test('read_cpt({includeProgress:true}) 取代 get_build_progress', async () => {
  await withReport(async ({ call, p, names }) => {
    assert.ok(!(await names()).includes('get_build_progress'), 'get_build_progress 不应再常驻 report 静态表');
    const base = await call('read_cpt', { path: p });
    assert.equal(base.data?.buildProgress, undefined, '默认不带进度（省 token）');
    const withProgress = await call('read_cpt', { path: p, includeProgress: true });
    assert.ok(!withProgress.isError, withProgress.text.slice(0, 160));
    const phases = withProgress.data?.buildProgress?.phases;
    assert.ok(Array.isArray(phases) && phases.length >= 5, 'includeProgress 应返回工序阶段');
    assert.ok(phases.every((x) => x.phase && typeof x.done === 'boolean'));
  });
});

test('add_style 经 style_manage 租约可用（能力不掉）', async () => {
  await withReport(async ({ call, names, p }) => {
    assert.ok(!(await names()).includes('add_style'), 'add_style 默认不在 report 静态表');
    const lease = await call('request_deep_tool_access', { path: p, group: 'style_manage' });
    assert.ok(!lease.isError, lease.text.slice(0, 200));
    assert.equal(lease.data?.status, 'granted');
    assert.deepEqual(lease.data?.enabledTools?.slice().sort(), ['add_style', 'delete_style']);
    assert.ok((await names()).includes('add_style'), '租约后 add_style 应动态可见');
    const added = await call('add_style', { path: p, fontSizePt: 16, bold: true });
    assert.ok(!added.isError, added.text.slice(0, 200));
    assert.ok(Number.isInteger(added.data?.styleIndex));
    const del = await call('delete_style', { path: p, index: added.data.styleIndex, force: true });
    assert.ok(!del.isError, del.text.slice(0, 200));
  });
});

test('build_report 经 generator_full 租约可用；report 静态表只保留 generate_report', async () => {
  await withReport(async ({ call, names, p }) => {
    const list = await names();
    assert.ok(list.includes('generate_report'), 'generate_report 应常驻静态表（从零建表首选）');
    assert.ok(!list.includes('build_report'), 'build_report 默认隐藏（generator_full 租约）');
    assert.equal(list.length, REPORT_STATIC_TOOLS.length, 'report 静态表 = REPORT_STATIC_TOOLS');
    const lease = await call('request_deep_tool_access', { path: p, group: 'generator_full' });
    assert.equal(lease.data?.status, 'granted', lease.text.slice(0, 200));
    assert.deepEqual(lease.data?.enabledTools, ['build_report']);
    const bad = await call('build_report', { path: path.join(path.dirname(p), 'new.cpt'), spec: { cells: [{ column: -1, row: 0 }] } });
    assert.equal(bad.isError, true, '租约后 build_report 应真实可调（非法 spec 被完整校验拒绝）');
    assert.match(bad.text, /spec/);
  });
});
