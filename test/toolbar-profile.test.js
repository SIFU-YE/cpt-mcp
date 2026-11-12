// test/toolbar-profile.test.js —— M93 工具栏按钮读写进 focused
//
// 背景：V3 业务填报收尾（规格ID补行 si0 改 spec_id、下载模板 HS/HN 对齐网格、
// 重算按钮去诊断浮层）三项都要 set_toolbar_button_js，但 focused/report 档没有
// 注册任何工具栏工具——排错会话只能整块裸改 XML（set#2 多敲 } 事故的根因之一）。
// 修法：list_toolbar_buttons（读）+ set_toolbar_button_js（改）进 focused
// （report 自动继承）；增/删/移保留 full 档，最小权限。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createCpt } from '../lib/generate.js';
import { addToolbarButton, listToolbarButtons, setToolbarButtonJs } from '../lib/edits.js';
import { addDataset } from '../lib/generate.js';
import { parameters } from '../lib/cpt.js';
import { validateCpt } from '../lib/validate.js';
import '../scripts/isolate-store.mjs'; // M123：JS 基线 store 隔离，直跑也不污染真实 store

delete process.env.CPT_MCP_ALLOWED_ROOTS;

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-tbprof-'));
const errCount = (v) => (Array.isArray(v) ? v : v.issues ?? []).filter((x) => x.severity === 'error').length;

function fixture() {
  const d = tmp();
  const p = path.join(d, 't.cpt');
  createCpt(p, { rows: 2, columns: 2, webWrite: true });
  addToolbarButton(p, { buttonText: '重算', js: 'var a = 1;' });
  return { d, p };
}

test('M93 工具栏读写：列出按钮 + match 改 JS，结构合法', () => {
  const { d, p } = fixture();
  const l = listToolbarButtons(p);
  assert.equal(l.count, 1);
  assert.equal(l.buttons[0].text, '重算');
  assert.equal(l.buttons[0].hasJs, true);
  const r = setToolbarButtonJs(p, { match: 'var a = 1;', js: 'var a = 2; toast("ok");' });
  assert.equal(r.mode, 'replace', '（2026-11-03 统一口径：整块写入=mode replace）');
  const raw = fs.readFileSync(p, 'utf8');
  assert.ok(raw.includes('var a = 2;'), 'JS 已写回');
  assert.ok(!raw.includes('var a = 1;'), '旧 JS 已替换');
  assert.equal(errCount(validateCpt(p)), 0);
  // 按钮不存在 → 拒绝（不静默新建）
  assert.throws(() => setToolbarButtonJs(p, { buttonText: '不存在', js: 'x=1;' }), /未找到|没有按钮/);
  fs.rmSync(d, { recursive: true, force: true });
});

test('M93 工具栏读写在 focused 档端到端可调（排错会话必须调得到）', async () => {
  const { d, p } = fixture();
  const client = new Client({ name: 'tbprof-test', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath, args: ['server.js'], cwd: process.cwd(), stderr: 'pipe',
    env: { CPT_MCP_TOOL_PROFILE: 'focused' },
  });
  await client.connect(transport);
  try {
    const names = (await client.listTools()).tools.map((t) => t.name);
    assert.ok(names.includes('list_toolbar_buttons'), 'focused 应含 list_toolbar_buttons');
    assert.ok(names.includes('set_toolbar_button_js'), 'focused 应含 set_toolbar_button_js');
    const l = await client.callTool({ name: 'list_toolbar_buttons', arguments: { path: p } });
    assert.ok(!l.isError, l.content?.[0]?.text);
    assert.equal(JSON.parse(l.content[0].text).count, 1);
    const w = await client.callTool({
      name: 'set_toolbar_button_js',
      arguments: { path: p, buttonText: '重算', js: 'var a = 3;', allowUnsafeScript: true },
    });
    assert.ok(!w.isError, w.content?.[0]?.text);
    assert.ok(fs.readFileSync(p, 'utf8').includes('var a = 3;'), 'MCP 端到端写回成功');
  } finally {
    await client.close();
  }
  fs.rmSync(d, { recursive: true, force: true });
});

test('M99-D1/M113 存量参数治理族在 report 档经租约端到端可调（死参数不再留置）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-paramdel-'));
  const p = path.join(dir, 'x.cpt');
  createCpt(p, { rows: 2, columns: 2 });
  addDataset(p, { name: 'ds1', connection: 'Doris', sql: 'SELECT 1', parameters: [{ name: 'first_users', defaultValue: 'x' }] });
  let names = parameters(p).map((x) => x.name);
  assert.ok(names.includes('first_users'), '先决：死参数存在');
  const client = new Client({ name: 'paramdel-test', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath, args: ['server.js'], cwd: process.cwd(), stderr: 'pipe',
    env: { CPT_MCP_TOOL_PROFILE: 'report' },
  });
  await client.connect(transport);
  try {
    // M113：参数与参数面板整族下沉为 param_panel 租约（每请求省 ~4.4 KB），一次解锁整族
    let all = (await client.listTools()).tools.map((t) => t.name);
    assert.ok(!all.includes('delete_parameter'), 'delete_parameter 应已下沉到 param_panel 族');
    assert.ok(!all.includes('update_parameter'), 'update_parameter 应已下沉到 param_panel 族');
    const lease = await client.callTool({ name: 'request_deep_tool_access', arguments: { path: p, group: 'param_panel' } });
    assert.ok(!lease.isError, lease.content?.[0]?.text);
    assert.equal(JSON.parse(lease.content[0].text).status, 'granted');
    all = (await client.listTools()).tools.map((t) => t.name);
    assert.ok(all.includes('delete_parameter'), '租约后应含 delete_parameter');
    assert.ok(all.includes('update_parameter'), '租约后应含 update_parameter');
    const r = await client.callTool({ name: 'delete_parameter', arguments: { path: p, name: 'first_users' } });
    assert.ok(!r.isError, r.content?.[0]?.text);
    names = parameters(p).map((x) => x.name);
    assert.ok(!names.includes('first_users'), '死参数应已删除');
    assert.equal(errCount(p), 0);
  } finally {
    await client.close();
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('M102/M113 工具栏编辑族在 report 档经租约可调（按钮增列出改闭环）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-tbadd-'));
  const p = path.join(dir, 'x.cpt');
  createCpt(p, { rows: 2, columns: 2, webWrite: true });
  const client = new Client({ name: 'tbadd-test', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath, args: ['server.js'], cwd: process.cwd(), stderr: 'pipe',
    env: { CPT_MCP_TOOL_PROFILE: 'report' },
  });
  await client.connect(transport);
  try {
    // M113：工具栏按钮的增删移/图标整族下沉为 toolbar_edit 租约（含写 JS 的 set_toolbar_button_js）；
    // 读侧 list_toolbar_buttons 留在静态表（读是每个任务的第一步，为省几百字节付一次租约往返是净亏）
    let all = (await client.listTools()).tools.map((t) => t.name);
    assert.ok(!all.includes('add_toolbar_button'), 'add_toolbar_button 应已下沉到 toolbar_edit 族');
    assert.ok(!all.includes('set_toolbar_button_js'), 'set_toolbar_button_js 应已下沉到 toolbar_edit 族');
    assert.ok(all.includes('list_toolbar_buttons'), '读侧 list_toolbar_buttons 应常驻静态表');
    const lease = await client.callTool({ name: 'request_deep_tool_access', arguments: { path: p, group: 'toolbar_edit' } });
    assert.ok(!lease.isError, lease.content?.[0]?.text);
    all = (await client.listTools()).tools.map((t) => t.name);
    assert.ok(all.includes('add_toolbar_button'), '租约后应含 add_toolbar_button');
    assert.ok(all.includes('set_toolbar_button_js'), '租约后应含 set_toolbar_button_js');
    const add = await client.callTool({ name: 'add_toolbar_button', arguments: { path: p, buttonText: 'R1删' } });
    assert.ok(!add.isError, add.content?.[0]?.text);
    const list = await client.callTool({ name: 'list_toolbar_buttons', arguments: { path: p } });
    assert.ok(JSON.parse(list.content[0].text).buttons.some((b) => b.text === 'R1删'), '新建按钮应可列出');
    assert.equal(errCount(validateCpt(p)), 0);
  } finally {
    await client.close();
  }
  fs.rmSync(dir, { recursive: true, force: true });
});
