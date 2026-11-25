// test/cell-dictionary-read.test.js —— M96 单元格下拉字典读取
//
// 背景：读半边一直空着——get_cells 不暴露 Dictionary 节点，diagnose 只报有/无，
// M91 写入口回显的前提是“已经知道格子字典是什么”。V3 规格下拉核对（ki/vi/取数表）
// 被迫走三重证据推定。本工具一次返回字典正文，读改闭环。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createCpt, addCell, addSheet } from '../lib/generate.js';
import { getCellDictionary } from '../lib/edits.js';
import { validateCpt } from '../lib/validate.js';
import '../scripts/isolate-store.mjs'; // M123：JS 基线 store 隔离，直跑也不污染真实 store

delete process.env.CPT_MCP_ALLOWED_ROOTS;

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-dictread-'));
const errCount = (v) => (Array.isArray(v) ? v : v.issues ?? []).filter((x) => x.severity === 'error').length;

// FR 真实形态（与 M91 测试同源）：TableDataDictionary = FormulaDictAttr + 取数表
const TABLE_DICT = (ki, vi, ds) => `<Dictionary class="com.fr.data.impl.TableDataDictionary">
<FormulaDictAttr kiName="${ki}" viName="${vi}"/>
<TableDataDictAttr>
<TableData class="com.fr.data.impl.NameTableData">
<Name>
<![CDATA[${ds}]]></Name>
</TableData>
</TableDataDictAttr>
</Dictionary>`;
const EMPTY_CUSTOM_DICT = `<Dictionary class="com.fr.data.impl.CustomDictionary">
<CustomDictAttr>
</CustomDictAttr>
</Dictionary>`;

function tableCell(p, { column, row, sheet, ki = 'spec_id', vi = 'spec_id', ds = 'ds_goods' } = {}) {
  addCell(p, { column, row, widget: 'comboBox', sheet });
  const raw = fs.readFileSync(p, 'utf8');
  assert.ok(raw.includes(EMPTY_CUSTOM_DICT));
  fs.writeFileSync(p, raw.replace(EMPTY_CUSTOM_DICT, TABLE_DICT(ki, vi, ds)));
}

test('M96 取数表字典：ki/vi/取数表一次读回，只读不改文件', () => {
  const d = tmp();
  const p = path.join(d, 'a.cpt');
  createCpt(p, { rows: 3, columns: 6 });
  tableCell(p, { column: 5, row: 2, sheet: 0 });
  const before = fs.readFileSync(p, 'utf8');
  const r = getCellDictionary(p, { column: 5, row: 2, sheet: 0 });
  assert.equal(r.action, 'get_cell_dictionary');
  assert.equal(r.hasDictionary, true);
  assert.equal(r.kind, 'table');
  assert.equal(r.kiName, 'spec_id');
  assert.equal(r.viName, 'spec_id');
  assert.equal(r.table, 'ds_goods');
  assert.equal(fs.readFileSync(p, 'utf8'), before, '只读不得改文件');
  assert.equal(errCount(validateCpt(p)), 0);
  fs.rmSync(d, { recursive: true, force: true });
});

test('M96 自定义字典读 items；无字典格返回 none 不抛错', () => {
  const d = tmp();
  const p = path.join(d, 'a.cpt');
  createCpt(p, { rows: 3, columns: 3 });
  addCell(p, { column: 0, row: 0, widget: 'comboBox', widgetItems: [{ key: 'k1', value: 'v1' }], sheet: 0 });
  const r = getCellDictionary(p, { column: 0, row: 0, sheet: 0 });
  assert.equal(r.kind, 'custom');
  assert.deepEqual(r.items, [{ key: 'k1', value: 'v1' }]);
  addCell(p, { column: 1, row: 1, widget: 'text', sheet: 0 });
  const r2 = getCellDictionary(p, { column: 1, row: 1, sheet: 0 });
  assert.equal(r2.hasDictionary, false);
  assert.equal(r2.kind, 'none');
  fs.rmSync(d, { recursive: true, force: true });
});

test('M96 sheet 必填；多表同坐标按 sheet 精确返回（防读错通道）', () => {
  const d = tmp();
  const p = path.join(d, 'a.cpt');
  createCpt(p, { rows: 3, columns: 6 });
  addSheet(p, { sheetName: 'sheet2', rows: 3, columns: 6 });
  tableCell(p, { column: 5, row: 2, sheet: 0, ki: 'outer_id', vi: 'outer_id' });
  tableCell(p, { column: 5, row: 2, sheet: 1, ki: 'spec_id', vi: 'spec_id' });
  assert.throws(() => getCellDictionary(p, { column: 5, row: 2 }), /必须显式提供 sheet/);
  assert.equal(getCellDictionary(p, { column: 5, row: 2, sheet: 0 }).kiName, 'outer_id');
  assert.equal(getCellDictionary(p, { column: 5, row: 2, sheet: 1 }).kiName, 'spec_id');
  assert.throws(() => getCellDictionary(p, { column: 9, row: 9, sheet: 0 }), /未找到/);
  fs.rmSync(d, { recursive: true, force: true });
});

test('M96 focused 端到端可调（此前无工具可读，只能三重证据推定）', async () => {
  const d = tmp();
  const p = path.join(d, 'a.cpt');
  createCpt(p, { rows: 3, columns: 6 });
  tableCell(p, { column: 5, row: 2, sheet: 0 });
  const client = new Client({ name: 'dictread-test', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath, args: ['server.js'], cwd: process.cwd(), stderr: 'pipe',
    env: { CPT_MCP_TOOL_PROFILE: 'focused' },
  });
  await client.connect(transport);
  try {
    const names = (await client.listTools()).tools.map((t) => t.name);
    assert.ok(names.includes('get_cell_dictionary'), 'focused 应含 get_cell_dictionary');
    const r = await client.callTool({ name: 'get_cell_dictionary', arguments: { path: p, column: 5, row: 2, sheet: 0 } });
    assert.ok(!r.isError, r.content?.[0]?.text);
    const data = JSON.parse(r.content[0].text);
    assert.deepEqual([data.kind, data.kiName, data.viName, data.table], ['table', 'spec_id', 'spec_id', 'ds_goods']);
  } finally {
    await client.close();
  }
  fs.rmSync(d, { recursive: true, force: true });
});
