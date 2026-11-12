// test/ptc-batch.test.js —— PTC/code-mode 友好度验收（2026-10-26 P0）
//
// 三件事必须成立，否则"把重复调用写成一段程序"就落不了地：
//   ① report 档能看到批量工具（add_parameter_widget_batch / update_parameter_widget_batch /
//      add_cell_highlight_batch），一次调用替代 N 次单品调用；
//   ② 对象型结果带 structuredContent —— 程序里直接拿对象，不必 JSON.parse(content[0].text)；
//   ③ 批量工具是"逐项结果 + 部分成功"：单条失败不中断，程序里按 results 补偿；
//   ④ get_capabilities({section:"ptc.recipes"}) 能读到可抄的 PTC 配方。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createCpt, addCell } from '../lib/generate.js';
import { REPORT_STATIC_TOOLS } from '../lib/contract.js';
import '../scripts/isolate-store.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-ptc-'));

async function withClient(fn) {
  const d = tmp();
  const cpt = path.join(d, 'a.cpt');
  createCpt(cpt, { rows: 6, columns: 6 });
  addCell(cpt, { column: 0, row: 1, content: '1' });
  const client = new Client({ name: 'ptc-batch-test', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath, args: ['server.js'], cwd: process.cwd(), stderr: 'pipe',
    env: { CPT_MCP_TOOL_PROFILE: 'report', CPT_MCP_ALLOWED_ROOTS: `${os.homedir()};${os.tmpdir()}` },
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

test('report 档暴露两个批量工具；非原子的 highlight 批量默认隐藏（P0-1 原子化）', async () => {
  await withClient(async ({ client, cpt }) => {
    const names = (await client.listTools()).tools.map((t) => t.name);
    for (const t of ['add_parameter_widget_batch', 'update_parameter_widget_batch']) {
      assert.ok(names.includes(t), `report 档应含 ${t}`);
    }
    // 2026-11-12 P0-1：add_cell_highlight_batch 是非原子批量便利工具，与原子化原则冲突 →
    // 不再常驻 report 静态表；仍需时走 adhoc 按名临租（能力不掉）。
    assert.ok(!names.includes('add_cell_highlight_batch'), 'add_cell_highlight_batch 应默认隐藏（非原子批量）');
    const lease = await client.callTool({
      name: 'request_deep_tool_access',
      arguments: { path: cpt, group: 'adhoc', reason: 'adhoc_write', tools: ['add_cell_highlight_batch'] },
    });
    assert.ok(!lease.isError, textOf(lease));
    const after = (await client.listTools()).tools.map((t) => t.name);
    assert.ok(after.includes('add_cell_highlight_batch'), 'adhoc 临租后应可见（能力仍可达）');
    assert.equal(names.length, REPORT_STATIC_TOOLS.length, `report 档应为 ${REPORT_STATIC_TOOLS.length} 项，实际 ${names.length}`);
  });
});

test('对象型结果带 structuredContent（程序里免 JSON.parse）', async () => {
  await withClient(async ({ client, cpt }) => {
    const r = await client.callTool({ name: 'get_datasets', arguments: { path: cpt } });
    assert.ok(!r.isError, textOf(r));
    // 数组型结果：structuredContent = { items: [...] }；文本分支保持原样（数组）
    assert.ok(Array.isArray(r.structuredContent?.items), '数组结果应包成 { items: [...] }');
    assert.ok(Array.isArray(jsonOf(r)), '文本分支仍是原数组，兼容旧客户端');

    const gate = await client.callTool({ name: 'quality_gate_cpt', arguments: { path: cpt } });
    assert.ok(gate.structuredContent && typeof gate.structuredContent === 'object', '对象结果应直接是对象');
    assert.equal(typeof gate.structuredContent.pass, 'boolean');
  });
});

test('批量加参数控件：一次调用写 3 个，summary 逐项可读', async () => {
  await withClient(async ({ client, cpt }) => {
    const r = await client.callTool({
      name: 'add_parameter_widget_batch',
      arguments: { path: cpt, items: [
        { name: 'p1', type: 'text', label: 'P1', x: 10, y: 10, width: 100, height: 24 },
        { name: 'p2', type: 'text', label: 'P2', x: 120, y: 10, width: 100, height: 24 },
        { name: 'p3', type: 'text', label: 'P3', x: 230, y: 10, width: 100, height: 24 },
      ] },
    });
    assert.ok(!r.isError, textOf(r));
    const data = jsonOf(r);
    assert.equal(data.summary.total, 3);
    assert.equal(data.summary.failed, 0);
    assert.equal(data.summary.inserted, 3);

    const panel = jsonOf(await client.callTool({ name: 'get_parameter_panel', arguments: { path: cpt } }));
    const widgets = (panel.widgets || panel.Widgets || []).map((w) => w.name);
    // 2026-10-29：带 label 的参数控件会额外生成配套可见 Label 控件（lbl_<name>）
    assert.deepEqual(widgets.sort(), ['lbl_p1', 'lbl_p2', 'lbl_p3', 'p1', 'p2', 'p3']);
  });
});

test('批量加高亮：单条失败不中断，per-item results 可定位（PTC 里按 results 补偿）', async () => {
  await withClient(async ({ client, cpt }) => {
    // 2026-11-12 P0-1：add_cell_highlight_batch 默认隐藏（非原子批量）→ 先 adhoc 按名临租
    const lease = await client.callTool({
      name: 'request_deep_tool_access',
      arguments: { path: cpt, group: 'adhoc', reason: 'adhoc_write', tools: ['add_cell_highlight_batch'] },
    });
    assert.ok(!lease.isError, textOf(lease));
    const r = await client.callTool({
      name: 'add_cell_highlight_batch',
      arguments: { path: cpt, items: [
        { column: 0, row: 1, formula: 'row() % 2 = 0', background: '#F5F8FA', scope: 'row' }, // 单元格存在
        { column: 0, row: 5, formula: '$$$ < 0', fontColor: '#FF0000' },                      // 单元格不存在 → 失败
        { column: 0, row: 1, formula: '$$$ < 0', fontColor: '#FF0000' },                      // 同格再叠一条
      ] },
    });
    assert.ok(!r.isError, '批量工具本身不应整批报错');
    const data = jsonOf(r);
    assert.equal(data.summary.total, 3);
    assert.equal(data.summary.failed, 1, '缺单元格那条应记 failed');
    assert.equal(data.summary.inserted, 2, '其余两条应成功（不中断）');
    const failed = data.results.filter((x) => x.status === 'failed');
    assert.equal(failed.length, 1);
    assert.match(failed[0].error, /未找到|定位失败/);
    assert.ok(r.structuredContent, '批量结果同样要结构化');
  });
});

test('get_capabilities 可读 ptc.recipes（配方可直接照抄）', async () => {
  await withClient(async ({ client }) => {
    const r = await client.callTool({ name: 'get_capabilities', arguments: { section: 'ptc.recipes' } });
    const txt = textOf(r);
    assert.match(txt, /配方 A/, '应含批量加参数控件配方');
    assert.match(txt, /run_code/, '应说明 PTC 场景');
    assert.match(txt, /request_deep_tool_access|租约/, '应说明深层工具需先解锁');
  });
});
