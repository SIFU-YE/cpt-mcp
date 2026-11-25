// test/write-path-e2e.test.js —— 单写工具 MCP 通道覆盖（审计补齐）
//
// 背景：全量审计发现 30+ 单写工具从未走过 MCP（仅 lib 层覆盖）：MCP 的
// schema→围栏→handler→ok 整条接线无人验过。本文件对它们逐个活体调用
// （单 server 进程 + 分域独立夹具 + 最小合法参数），之后任何接线断裂都会红。
// batch 家族由 test/batch.test.js（lib 语义）+ 本文件抽查覆盖。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createCpt } from '../lib/generate.js';
import { validateCpt } from '../lib/validate.js';
import '../scripts/isolate-store.mjs'; // M123：JS 基线 store 隔离，直跑也不污染真实 store

delete process.env.CPT_MCP_ALLOWED_ROOTS;

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-writee2e-'));
const errCount = (v) => (Array.isArray(v) ? v : v.issues ?? []).filter((x) => x.severity === 'error').length;

let client;
test.before(async () => {
  client = new Client({ name: 'writee2e-test', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath, args: ['server.js'], cwd: process.cwd(), stderr: 'pipe',
    env: { CPT_MCP_TOOL_PROFILE: 'full' },
  });
  await client.connect(transport);
});
test.after(async () => { await client?.close(); fs.rmSync(DIR, { recursive: true, force: true }); });

async function call(name, args) {
  const r = await client.callTool({ name, arguments: args });
  assert.ok(!r.isError, `${name} 不应报错：${r.content?.[0]?.text}`);
  return JSON.parse(r.content[0].text);
}
// 新鲜 webWrite 夹具（多数写工具的前置）
function fresh(n = `w-${Date.now()}-${Math.floor(Math.random() * 1e6)}.cpt`) {
  const p = path.join(DIR, n);
  createCpt(p, { rows: 6, columns: 6, webWrite: true });
  return p;
}

test('工作表/样式/模板主题/网格设置', async () => {
  const p = fresh();
  await call('add_sheet', { path: p, sheetName: 'sb' });
  await call('delete_sheet', { path: p, sheet: 'sb' });
  const styles = await call('get_styles', { path: p });
  await call('add_style', { path: p, fontSizePt: 16 });
  const after = await call('get_styles', { path: p });
  assert.equal(after.styles.length, styles.styles.length + 1);
  await call('delete_style', { path: p, index: after.styles.length - 1 });
  await call('set_template_theme', { path: p, theme: '经典浅灰' });
  await call('set_grid', { path: p, rowCount: 6 });
  assert.equal(errCount(validateCpt(p)), 0);
});

test('填报工具栏整套（设/增/图标/移/删）', async () => {
  const p = fresh();
  await call('set_fill_toolbar', { path: p });
  await call('add_toolbar_button', { path: p, buttonText: 'W1' });
  await call('set_toolbar_button_icon', { path: p, buttonText: 'W1', iconName: 'submit' });
  await call('move_toolbar_button', { path: p, buttonText: 'W1', to: 'last' });
  const list = await call('list_toolbar_buttons', { path: p });
  assert.ok(list.count >= 5, `应含默认4按钮+W1，实际 ${list.count}`);
  await call('delete_toolbar_button', { path: p, buttonText: 'W1' });
  assert.equal(errCount(validateCpt(p)), 0);
});

test('报表 JS 与填报事件 JS 写删', async () => {
  const p = fresh();
  await call('set_report_js', { path: p, js: 'var t=1;', allowUnsafeScript: true, sheet: 0 });
  await call('set_webwrite_js', { path: p, event: 'afterload', js: 'var w=1;', allowUnsafeScript: true });
  await call('set_webwrite_extras', { path: p, editRowColor: { color: '#FF0000' } });
  await call('set_report_js', { path: p, sheet: 0 });
  assert.equal(errCount(validateCpt(p)), 0);
});

test('页眉页脚设删', async () => {
  const p = fresh();
  await call('set_page_header_footer', { path: p, footer: { center: { preset: 'pageNumber' } } });
  await call('delete_page_header_footer', { path: p, which: 'footer' });
  assert.equal(errCount(validateCpt(p)), 0);
});

test('参数面板控件整套 + 移动端孤儿拒绝', async () => {
  const p = fresh();
  await call('set_parameter_panel', { path: p });
  await call('add_parameter_widget', { path: p, name: 'w1', type: 'text', x: 1, y: 1, width: 50, height: 20 });
  await call('update_parameter_widget', { path: p, name: 'w1', defaultValue: 'd' });
  await call('rename_parameter_widget', { path: p, name: 'w1', newName: 'w2' });
  await call('delete_parameter_widget', { path: p, name: 'w2' });
  const bad = await client.callTool({ name: 'delete_mobile_widget_ref', arguments: { path: p, name: 'ghost' } });
  assert.ok(bad.isError, '不存在的移动端引用应干净拒绝');
  assert.equal(errCount(validateCpt(p)), 0);
});

test('报表级参数增改删', async () => {
  const p = fresh();
  await call('add_dataset', { path: p, name: 'ds1', connection: 'Doris', sql: 'SELECT 1' });
  await call('add_parameter', { path: p, name: 'pp', defaultValue: 'x', scope: 'dataset', dsName: 'ds1' });
  await call('update_parameter', { path: p, name: 'pp', defaultValue: 'y' });
  await call('delete_parameter', { path: p, name: 'pp' });
  assert.equal(errCount(validateCpt(p)), 0);
});

test('填报绑定/条件属性/超链接增删（含改）', async () => {
  const p = fresh();
  await call('add_cell', { path: p, column: 0, row: 0, content: 'H' });
  await call('add_cell', { path: p, column: 1, row: 1, content: 'X' });
  await call('add_fill_submit', { path: p, dsName: 'ds1', table: 'emp', bindings: [{ field: 'k', column: 0, row: 0, isKey: true }] });
  await call('add_fill_binding', { path: p, field: 'f1', column: 1, row: 1 });
  await call('add_cell_highlight', { path: p, column: 1, row: 1, formula: '$$$<0', background: '#FF0000' });
  await call('add_cell_hyperlink', { path: p, column: 1, row: 1, type: 'url', url: 'https://e.com/x', name: 'hl1' });
  await call('update_cell_highlight', { path: p, column: 1, row: 1, formula: '$$$<0', background: '#00FF00' });
  await call('update_cell_hyperlink', { path: p, column: 1, row: 1, name: 'hl1', url: 'https://e.com/y' });
  await call('update_fill_submit', { path: p, submitIndex: 0, table: 'emp2' });
  await call('delete_cell_highlight', { path: p, column: 1, row: 1, formula: '$$$<0' });
  await call('delete_cell_hyperlink', { path: p, column: 1, row: 1, name: 'hl1' });
  await call('delete_fill_binding', { path: p, field: 'f1' });
  assert.equal(errCount(validateCpt(p)), 0);
});

test('监听/图表/浮动/排序/工作表改名', async () => {
  const p = fresh();
  await call('add_dataset', { path: p, name: 'ds1', connection: 'Doris', sql: 'SELECT a, b FROM t' });
  await call('add_cell', { path: p, column: 0, row: 0, content: 'S' });
  await call('add_cell', { path: p, column: 3, row: 3, content: 'C' });
  await call('add_cell_listener_batch', { path: p, cells: [{ column: 3, row: 3 }], event: 'click', js: 'var a=1;', allowUnsafeScript: true });
  await call('add_chart', { path: p, column: 0, row: 4, type: 'column', dsName: 'ds1', category: 'a', values: ['b'] });
  await call('update_chart', { path: p, column: 0, row: 4, title: 'T' });
  await call('add_float_element', { path: p, content: 'fx', name: 'FL1' });
  await call('update_float_element', { path: p, name: 'FL1', content: 'fx2' });
  await call('update_cell_sort', { path: p, column: 0, row: 0, sort: [{ area: 'a', direction: 'asc' }] });
  await call('add_sheet', { path: p, sheetName: 'sb' });
  await call('update_sheet', { path: p, sheet: 'sb', newName: 'sb2' });
  await call('delete_sheet', { path: p, sheet: 'sb2' });
  assert.equal(errCount(validateCpt(p)), 0);
});
