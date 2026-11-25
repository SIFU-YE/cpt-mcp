// test/arg-alias.test.js —— 参数别名归一 + "严格校验带合法键"（2026-10-26 P0）
//
// 覆盖两类回归：
//  ① 语义直觉写法（text / condition / title / width / marginTop / invisible / valueField）
//     不再被 strict 拒掉，而是被归一成规范字段名，并在返回体尾部给出纠正回执；
//  ② 真无法纠正的未知键，报错必须附「该处可用字段」（原来只有 "Unrecognized key: x"）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { normalizeArgs, allowedKeysAt } from '../lib/arg-normalize.js';
import { createCpt, addCell } from '../lib/generate.js';
import '../scripts/isolate-store.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-arg-'));

// ---------- 单元：别名归一 ----------

test('别名·工具栏按钮 text/name/label → buttonText', () => {
  for (const from of ['text', 'name', 'label', 'title', 'value']) {
    const { args, fixes } = normalizeArgs('add_toolbar_button', { path: 'C:\\a.cpt', [from]: '导出' }, {});
    assert.equal(args.buttonText, '导出', `${from} 应归一到 buttonText`);
    assert.equal(args[from], undefined, `${from} 应被移除`);
    assert.match(fixes.join('；'), /→buttonText/);
  }
});

test('别名·高亮 condition/wholeRow → formula/scope', () => {
  const r1 = normalizeArgs('add_cell_highlight', { path: 'x', condition: '$$$ < 0' }, {});
  assert.equal(r1.args.formula, '$$$ < 0');
  assert.equal(r1.args.condition, undefined);

  const r2 = normalizeArgs('add_cell_highlight', { path: 'x', condition: { op: 'lt', value: 0 } }, {});
  assert.deepEqual(r2.args.compare, { op: 'lt', value: 0 });

  const r3 = normalizeArgs('add_cell_highlight', { path: 'x', wholeRow: true }, {});
  assert.equal(r3.args.scope, 'row');
  const r4 = normalizeArgs('add_cell_highlight', { path: 'x', wholeRow: false }, {});
  assert.equal(r4.args.scope, 'cell');
});

test('别名·invisible 在 add/update 参数面板上语义不同（add→hidden、update→visible 取反）', () => {
  const add = normalizeArgs('add_parameter_widget', { path: 'x', name: 'w', invisible: true }, {});
  assert.equal(add.args.hidden, true);
  assert.match(add.fixes.join('；'), /真正隐藏请补 update_parameter_widget/);

  const upd = normalizeArgs('update_parameter_widget', { path: 'x', name: 'w', invisible: true }, {});
  assert.equal(upd.args.visible, false);
  const upd2 = normalizeArgs('update_parameter_widget', { path: 'x', name: 'w', invisible: false }, {});
  assert.equal(upd2.args.visible, true);
});

test('别名·borderStyle → noBorder', () => {
  assert.equal(normalizeArgs('update_parameter_widget', { path: 'x', borderStyle: 'none' }, {}).args.noBorder, true);
  assert.equal(normalizeArgs('update_parameter_widget', { path: 'x', borderStyle: 'solid' }, {}).args.noBorder, false);
});

test('别名·下拉字典 valueField/textField/displayColumn → kiName/viName，items 提到顶层', () => {
  const { args } = normalizeArgs('add_parameter_widget', {
    path: 'x', name: 'w', dictionary: { type: 'table', dsName: 'ds1', valueField: 'id', textField: 'name', items: [{ key: 'a', value: 'A' }] },
  }, {});
  assert.equal(args.dictionary.kiName, 'id');
  assert.equal(args.dictionary.viName, 'name');
  assert.equal(args.dictionary.valueField, undefined);
  assert.deepEqual(args.items, [{ key: 'a', value: 'A' }], 'items 必须移到控件顶层');
  assert.equal(args.dictionary.items, undefined);
});

test('别名·generate_report fields：title/width/sum → label/widthMm/summary，align 字符串→数字', () => {
  const { args, fixes } = normalizeArgs('generate_report', {
    path: 'x',
    fields: [{ name: 'a', title: '甲', width: 30, sum: true, align: 'center' }],
  }, {});
  assert.deepEqual(args.fields[0], { name: 'a', label: '甲', widthMm: 30, summary: true, align: 0 });
  assert.ok(fixes.length >= 4);
});

test('别名·build_report spec：settings 缺 Mm 后缀、parameterWidgets 字典 items 放错层', () => {
  const { args } = normalizeArgs('build_report', {
    path: 'x',
    spec: {
      settings: { marginTop: 6, marginLeft: 19 },
      parameterWidgets: [{ name: 'w', dictionary: { type: 'custom', items: [{ key: 'k', value: 'v' }] } }],
    },
  }, {});
  assert.equal(args.spec.settings.marginTopMm, 6);
  assert.equal(args.spec.settings.marginTop, undefined);
  assert.deepEqual(args.spec.parameterWidgets[0].items, [{ key: 'k', value: 'v' }]);
});

test('别名·通用 Mm 后缀按 schema 字段推断（不带 Mm 也能吃、多带 Mm 也能还原）', () => {
  const schema = { marginTopMm: z.any(), widthMm: z.any() };
  const a = normalizeArgs('whatever_tool', { marginTop: 3 }, schema);
  assert.equal(a.args.marginTopMm, 3);
  const b = normalizeArgs('whatever_tool', { marginTopMm: 4, widthMm: 5 }, schema);
  assert.equal(b.args.marginTopMm, 4, '本来就对的字段不应被动');
  assert.ok(!b.fixes.length);
});

test('合法键提示·allowedKeysAt 能在嵌套路径上取到字段（含数组元素）', () => {
  const schema = {
    path: z.string(),
    spec: z.object({
      settings: z.object({ marginTopMm: z.number().optional() }),
      cells: z.array(z.object({ column: z.number(), content: z.string() })),
    }),
  };
  assert.deepEqual(allowedKeysAt(schema, ['spec', 'settings']).sort(), ['marginTopMm']);
  assert.deepEqual(allowedKeysAt(schema, ['spec', 'cells', 0]).sort(), ['column', 'content']);
  assert.deepEqual(allowedKeysAt(schema, []).sort(), ['path', 'spec']);
});

// ---------- 端到端：真无法纠正的键 → 报错带合法字段 ----------

test('端到端·未知键报错必须附「该处可用字段」（此前只有 Unrecognized key）', async () => {
  const d = tmp();
  const p = path.join(d, 'a.cpt');
  createCpt(p, { rows: 3, columns: 4 });
  const client = new Client({ name: 'arg-alias-test', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath, args: ['server.js'], cwd: process.cwd(), stderr: 'pipe',
    env: { CPT_MCP_TOOL_PROFILE: 'full' },
  });
  await client.connect(transport);
  try {
    const r = await client.callTool({
      name: 'add_cell',
      arguments: { path: p, column: 0, row: 0, content: 'x', zzzNotAField: 1 },
    });
    const text = (r.content || []).map((c) => c.text).join('\n');
    assert.ok(r.isError, '未知键必须报错（不静默丢弃）');
    assert.match(text, /Unrecognized key/, '仍要指出未知键本身');
    assert.match(text, /该处可用字段/, '必须补上合法字段清单');
    assert.match(text, /column/, '清单里应能看到真实字段名');
  } finally {
    await client.close();
    fs.rmSync(d, { recursive: true, force: true });
  }
});

// ---------- 端到端：别名写法直接可用 + 纠正回执 ----------

test('端到端·add_cell_highlight 用 condition/wholeRow 直接成功，并回报纠正', async () => {
  const d = tmp();
  const p = path.join(d, 'b.cpt');
  createCpt(p, { rows: 3, columns: 4 });
  addCell(p, { column: 0, row: 0, content: '1', contentType: 'text' });
  const client = new Client({ name: 'arg-alias-test2', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath, args: ['server.js'], cwd: process.cwd(), stderr: 'pipe',
    env: { CPT_MCP_TOOL_PROFILE: 'full' },
  });
  await client.connect(transport);
  try {
    const r = await client.callTool({
      name: 'add_cell_highlight',
      arguments: { path: p, column: 0, row: 0, condition: '$$$ < 0', wholeRow: true, fontColor: '#FF0000' },
    });
    const text = (r.content || []).map((c) => c.text).join('\n');
    assert.ok(!r.isError, `别名写法应直接成功，实际：${text}`);
    assert.match(text, /\[参数已自动纠正\]/, '应回执纠正了哪些字段');
    assert.match(text, /condition→formula|wholeRow/, '回执要说明纠正项');
  } finally {
    await client.close();
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test('别名·set_toolbar_button_js 的 button/text/name → buttonText', () => {
  for (const key of ['button', 'text', 'name', 'title', 'label']) {
    const { args } = normalizeArgs('set_toolbar_button_js', { path: 'x', [key]: '导出' }, {});
    assert.equal(args.buttonText, '导出', `${key} 应归一到 buttonText`);
  }
});

test('别名·update_sheet 的 name/title → newName', () => {
  const a = normalizeArgs('update_sheet', { path: 'x', sheet: 'sheet1', name: '特殊填报' }, {});
  assert.equal(a.args.newName, '特殊填报');
  assert.equal(a.args.name, undefined);
  const b = normalizeArgs('update_sheet', { path: 'x', sheet: 0, title: '常规填报' }, {});
  assert.equal(b.args.newName, '常规填报');
});

test('别名·update_cell_listener_batch 扁平 items → {target,patch}', () => {
  const { args } = normalizeArgs('update_cell_listener_batch', {
    path: 'x',
    items: [{ column: 0, row: 1, event: 'click', js: 'var a=1;' }],
  }, {});
  assert.deepEqual(args.items[0].target, { column: 0, row: 1, event: 'click' });
  assert.deepEqual(args.items[0].patch, { js: 'var a=1;' });
  assert.equal(args.items[0].column, undefined);
});
