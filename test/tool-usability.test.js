// test/tool-usability.test.js —— 2026-10-29「最新几个会话」审计的 4 类真实调用失败：
//  1) update_parameter_widget(dictionary:{type:"custom",items}) 被误判成"dictionary 与 items 同时传"（10-28 真实返工）
//  2) add_fill_submit(connection) 键名不认识（10-29 真实调用）
//  3) update_cell_style(scope:"style") 枚举外取值（10-29 真实调用）
//  4) delete_cell_range 漏必填参数 → "expected number, received NaN"（10-29 真实调用）
//  5) get_webwrite_js 不传 event 报校验失败 → 改为返回事件清单（10-29 真实调用）
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { normalizeArgs, missingRequiredArgs } from '../lib/arg-normalize.js';
import { createCpt, addParameterWidget, addCell } from '../lib/generate.js';
import { updateParameterWidget, updateCellStyle, setWebWriteJs } from '../lib/edits.js';
import { webwriteListener } from '../lib/cpt.js';
import '../scripts/isolate-store.mjs'; // M123：JS 基线 store 隔离，直跑也不污染真实 store

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-ux-'));

test('update_parameter_widget：dictionary:{type:"custom",items} 归一为顶层 items，不再误判"不能同时传"', () => {
  const p = path.join(tmp(), 'a.cpt');
  createCpt(p, { rows: 3, columns: 3 });
  addParameterWidget(p, { name: 'kw', type: 'comboBox', label: '关键词', items: [{ key: 'A', value: 'A' }] });
  const schema = {
    path: z.string(), name: z.string(),
    dictionary: z.object({ type: z.enum(['custom']) }).passthrough().optional(),
    items: z.array(z.any()).optional(),
  };
  const { args, fixes } = normalizeArgs('update_parameter_widget', {
    path: p, name: 'kw', dictionary: { type: 'custom', items: [{ key: 'B', value: 'B' }] },
  }, schema);
  assert.deepEqual(args.dictionary, { type: 'custom', items: [{ key: 'B', value: 'B' }] }, 'custom 字典应保持整块 dictionary:{type,items}，可把已有 DatabaseDictionary 转成自定义项');
  assert.equal(args.items, undefined, 'items 已并入 dictionary.items，避免二选一');
  assert.ok(fixes.some((f) => /items/.test(f)), `应有纠正回执：${fixes}`);
  // 归一后的参数能直接走通真实更新（此前会抛"dictionary 与 items 不能同时传"）
  const r = updateParameterWidget(p, { name: args.name, dictionary: args.dictionary });
  assert.equal(r.action, 'update_parameter_widget');
  assert.match(fs.readFileSync(p, 'utf8'), /<Dict key="B" value="B"\/>/);
});

test('add_fill_submit：connection 别名按模式落到 dsName（列映射）/ dbName（自由 SQL）', () => {
  const schema = {
    path: z.string(), dsName: z.string().optional(), dbName: z.string().optional(),
    table: z.string().optional(), sql: z.string().optional(),
    bindings: z.array(z.any()).optional(), schema: z.string().default(''),
  };
  const builtin = normalizeArgs('add_fill_submit', { path: 'a.cpt', table: 't1', connection: 'Doris' }, schema);
  assert.equal(builtin.args.dsName, 'Doris', '列映射模式 connection→dsName');
  assert.equal(builtin.args.connection, undefined, 'connection 应被移除（否则严格校验报未知键）');
  const free = normalizeArgs('add_fill_submit', { path: 'a.cpt', sql: 'update t set a=1', connection: 'Doris' }, schema);
  assert.equal(free.args.dbName, 'Doris', '自由 SQL 模式 connection→dbName');
  assert.equal(free.args.connection, undefined);
});

test('update_cell_style：scope="style"→"shared"（枚举外取值归一）', () => {
  const p = path.join(tmp(), 's.cpt');
  createCpt(p, { rows: 2, columns: 2 });
  addCell(p, { column: 0, row: 1, content: 'x' });
  const schema = { path: z.string(), column: z.coerce.number().int(), row: z.coerce.number().int(), scope: z.enum(['cell', 'shared']).default('cell') };
  const { args, fixes } = normalizeArgs('update_cell_style', { path: p, column: 0, row: 1, scope: 'style' }, schema);
  assert.equal(args.scope, 'shared');
  assert.ok(fixes.some((f) => /shared/.test(f)));
  assert.doesNotThrow(() => updateCellStyle(p, args.column, args.row, { scope: args.scope, bold: true }));
});

test('update_report_node：content/xml/nodeXml → xmlBody', () => {
  const schema = { path: z.string(), nodeName: z.string(), xmlBody: z.string().optional() };
  for (const key of ['content', 'xml', 'nodeXml', 'xmlContent', 'body']) {
    const { args } = normalizeArgs('update_report_node', { path: 'a.cpt', nodeName: 'ReportPageAttr', [key]: '<ReportPageAttr/>' }, schema);
    assert.equal(args.xmlBody, '<ReportPageAttr/>', `${key} 应搬到 xmlBody`);
    assert.equal(args[key], undefined, `${key} 应被移除`);
  }
});

test('缺必填参数给可读清单（delete_cell_range 不再报 expected number, received NaN）', () => {
  const schema = {
    path: z.string(),
    fromColumn: z.coerce.number().int().min(0),
    toColumn: z.coerce.number().int().min(0),
    shiftLeft: z.coerce.boolean().default(true),
    sheet: z.string().optional(),
  };
  assert.deepEqual(missingRequiredArgs(schema, { path: 'a.cpt' }), ['fromColumn', 'toColumn'], '缺必填应被点名列出来');
  assert.deepEqual(missingRequiredArgs(schema, { path: 'a.cpt', fromColumn: 1, toColumn: 2 }), [], '默认值/可选字段不算缺');
});

test('get_webwrite_js：不传 event 返回事件清单（不含 JS 正文），传 event 才读全文', () => {
  const p = path.join(tmp(), 'w.cpt');
  createCpt(p, { rows: 3, columns: 3, webWrite: true });
  setWebWriteJs(p, { event: 'afterload', js: 'console.log("afterload");' });
  setWebWriteJs(p, { event: 'beforeappend', js: 'var a = 1;' });
  const list = webwriteListener(p, {});
  assert.equal(list.action, 'get_webwrite_js');
  assert.equal(list.count, 2);
  assert.deepEqual(list.events.map((e) => e.event).sort(), ['afterload', 'beforeappend']);
  assert.ok(list.events.every((e) => e.js === undefined), '清单模式不应带 JS 正文');
  assert.ok(list.events.every((e) => typeof e.jsLength === 'number' && e.jsLength > 0), '清单应带 jsLength/shape');
  assert.match(list.hint, /传 event/);
  const one = webwriteListener(p, { event: 'afterload' });
  assert.equal(one.count, 1);
  assert.match(one.listeners[0].js, /afterload/);
  // 空模板也给引导而不是报错
  const empty = path.join(tmp(), 'e.cpt');
  createCpt(empty, { rows: 2, columns: 2 });
  const none = webwriteListener(empty, {});
  assert.equal(none.count, 0);
  assert.match(none.hint, /set_webwrite_js/);
});
