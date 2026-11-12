// test/arg-alias-p01.test.js —— P0-1（两天会话审计 A 类 30 条）：高频误写键名归一 + 数组参数容错
import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { normalizeArgs } from '../lib/arg-normalize.js';

test('add_fill_submit: columns/cols/columnMap → bindings', () => {
  const schema = {
    path: z.string(),
    dsName: z.string().optional(),
    table: z.string().optional(),
    bindings: z.array(z.object({ field: z.string(), column: z.number(), row: z.number() }).passthrough()).optional(),
  };
  for (const wrong of ['columns', 'cols', 'columnMap', 'bindingsMap']) {
    const { args, fixes } = normalizeArgs('add_fill_submit', { path: 'a.cpt', [wrong]: [{ field: 'c1', column: 0, row: 1 }] }, schema);
    assert.ok(Array.isArray(args.bindings), `${wrong} 应搬到 bindings`);
    assert.equal(args[wrong], undefined, `${wrong} 应被移除`);
    assert.ok(fixes.some((f) => f.includes('bindings')), `应有纠正回执：${fixes}`);
  }
});

test('update/delete_fill_binding: submit/index → submitIndex', () => {
  const schema = { path: z.string(), submitIndex: z.number().optional(), field: z.string() };
  for (const tool of ['update_fill_binding', 'delete_fill_binding', 'delete_fill_submit']) {
    const { args } = normalizeArgs(tool, { path: 'a.cpt', submit: 2, field: 'c1' }, schema);
    assert.equal(args.submitIndex, 2, `${tool}: submit 应搬到 submitIndex`);
    assert.equal(args.submit, undefined);
  }
});

test('数组参数容错：单对象自动包成 [v]（targets/items/bindings）', () => {
  const schema = {
    path: z.string(),
    targets: z.array(z.object({ buttonText: z.string() }).passthrough()).optional(),
  };
  const { args, fixes } = normalizeArgs('get_toolbar_button_batch', { path: 'a.cpt', targets: { buttonText: '批量导入' } }, schema);
  assert.deepEqual(args.targets, [{ buttonText: '批量导入' }], '单对象应包成数组');
  assert.ok(fixes.some((f) => f.includes('单对象')), `应有纠正回执：${fixes}`);

  // 别名搬移后同样生效：columns（单对象）→ bindings → [v]
  const schema2 = {
    path: z.string(),
    bindings: z.array(z.object({ field: z.string() }).passthrough()).optional(),
  };
  const r = normalizeArgs('add_fill_submit', { path: 'a.cpt', columns: { field: 'c1' } }, schema2);
  assert.deepEqual(r.args.bindings, [{ field: 'c1' }], '别名搬移后也应包数组');
});

test('已是数组/真缺参不受影响', () => {
  const schema = { path: z.string(), targets: z.array(z.object({ buttonText: z.string() }).passthrough()).optional() };
  const a = normalizeArgs('get_toolbar_button_batch', { path: 'a.cpt', targets: [{ buttonText: 'x' }] }, schema);
  assert.deepEqual(a.args.targets, [{ buttonText: 'x' }]);
  assert.equal(a.fixes.length, 0, '无需纠正不应产生回执');
});

// —— 字典条目归一（审计 A 类尾巴：spec.dictionary "items" / custom 字典写错层） ——
import { normalizeArgs as _na } from '../lib/arg-normalize.js';
import { z as _z } from 'zod';

test('add_parameter_widget: dictionary.options/entries→items，字符串/别名条目→{key,value}', () => {
  const schema = {
    path: _z.string(),
    name: _z.string(),
    items: _z.array(_z.object({ key: _z.string(), value: _z.string() }).strict()).optional(),
    dictionary: _z.object({ type: _z.string().optional() }).strict().optional(),
  };
  const { args, fixes } = _na('add_parameter_widget', {
    path: 'a.cpt', name: '组别',
    dictionary: { type: 'custom', options: ['华东', '华南'] },
  }, schema);
  assert.deepEqual(args.items, [{ key: '华东', value: '华东' }, { key: '华南', value: '华南' }]);
  assert.equal(args.dictionary.options, undefined, 'dictionary 里的 options 应清空');
  assert.ok(fixes.some((f) => f.includes('dictionary.options→items')), `应有纠正回执：${fixes}`);

  // {text,value} 形态条目
  const r2 = _na('add_parameter_widget', {
    path: 'a.cpt', name: '渠道',
    items: [{ text: '线上', value: 'online' }],
  }, schema);
  assert.deepEqual(r2.args.items, [{ key: '线上', value: 'online' }]);
});

test('build_report spec.parameterWidgets[].dictionary.entries→items（嵌套归一）', () => {
  const schema = { path: _z.string(), spec: _z.any() };
  const { args } = _na('build_report', {
    path: 'a.cpt',
    spec: { parameterWidgets: [{ name: '年份', dictionary: { type: 'custom', entries: ['2025', '2026'] } }] },
  }, schema);
  const w = args.spec.parameterWidgets[0];
  assert.deepEqual(w.items, [{ key: '2025', value: '2025' }, { key: '2026', value: '2026' }]);
  assert.equal(w.dictionary.entries, undefined);
});
