// test/lease-ux-fixes.test.js —— 2026-11-23 v1 会话缺口修复的回归锁
//
// 背景（某会话/v1 实测，183 次工具失败里的一类）：
//   ① 容器参数被当 JSON 字符串传 → "widgetItems/items: expected array, received string"（11 次）
//   ② group=auto 遇到未编组工具只回一段"改用 adhoc"的报错，模型还得再发一轮（2 次）
//   ③ 单文件租约下漏传 path → "租约绑定在 X，本次 path=(未传) 不匹配"（2 次）
import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';

import { normalizeArgs } from '../lib/arg-normalize.js';
import { DeepToolManager } from '../lib/deep-tools.js';

// ---------------------------------------------------------------------------
// ① 容器参数：JSON 字符串 → 数组/对象；字符串字段绝不被误解析
// ---------------------------------------------------------------------------
const cellSchema = {
  path: z.string(),
  column: z.coerce.number().int(),
  row: z.coerce.number().int(),
  content: z.string().optional(),
  widget: z.string().optional(),
  widgetItems: z.array(z.object({ key: z.string(), value: z.string() })).optional(),
  widgetDictionary: z.object({ type: z.string() }).optional(),
};

test('容器容错：数组参数被作为 JSON 字符串传入时解析（v1 会话 widgetItems 11 次踩坑）', () => {
  const { args, fixes } = normalizeArgs('add_cell', {
    path: 'x.cpt', column: 0, row: 0, widget: 'comboBox',
    widgetItems: '[{"key":"a","value":"甲"},{"key":"b","value":"乙"}]',
  }, cellSchema);
  assert.deepEqual(args.widgetItems, [{ key: 'a', value: '甲' }, { key: 'b', value: '乙' }]);
  assert.ok(fixes.some((f) => f.includes('widgetItems')), '应回报纠正说明，让模型下一轮直接用数组');
  // 严格 schema 必须能通过（此前正是在这一步被拒）
  assert.equal(z.object(cellSchema).strict().safeParse(args).success, true);
});

test('容器容错：对象参数被作为 JSON 字符串传入时解析', () => {
  const { args, fixes } = normalizeArgs('add_cell', {
    path: 'x.cpt', column: 0, row: 0, widgetDictionary: '{"type":"table","dsName":"ds1"}',
  }, cellSchema);
  assert.deepEqual(args.widgetDictionary, { type: 'table', dsName: 'ds1' });
  assert.ok(fixes.some((f) => f.includes('widgetDictionary')));
  assert.equal(z.object(cellSchema).strict().safeParse(args).success, true);
});

test('容器容错：单对象自动包成数组（既有 audit A 行为保持）', () => {
  const { args } = normalizeArgs('add_cell', {
    path: 'x.cpt', column: 0, row: 0, widgetItems: { key: 'a', value: '甲' },
  }, cellSchema);
  assert.deepEqual(args.widgetItems, [{ key: 'a', value: '甲' }]);
});

test('容器容错：字符串字段以 [ 或 { 开头的正文不得被误解析', () => {
  const { args } = normalizeArgs('update_cell', {
    path: 'x.cpt', column: 0, row: 0, content: '[2026-11-21] 需求提到 {单号} 与 "引号"',
  }, cellSchema);
  assert.equal(args.content, '[2026-11-21] 需求提到 {单号} 与 "引号"');
});

test('容器容错：非法 JSON 字符串不做猜测性改写（留给严格校验报原始错误）', () => {
  const { args } = normalizeArgs('add_cell', {
    path: 'x.cpt', column: 0, row: 0, widgetItems: "[{key:'a'}]",
  }, cellSchema);
  assert.equal(args.widgetItems, "[{key:'a'}]");
  assert.equal(z.object(cellSchema).strict().safeParse(args).success, false);
});

// ---------------------------------------------------------------------------
// ② group=auto 对未编组工具自动回退 adhoc（不再让模型多发一轮）
// ---------------------------------------------------------------------------
test('auto 回退：未编组工具按副作用分级自动 adhoc 直租', () => {
  const m = new DeepToolManager();
  const granted = m.grantAuto({ filePath: 'C:/tmp/x/t.cpt', tools: ['set_cell_widget'] });
  assert.equal(granted.status, 'granted');
  assert.equal(granted.group, 'adhoc');
  assert.equal(granted.tier, 'write', 'set_cell_widget 属写工具 → adhoc_write 分级');
  assert.ok(granted.enabledTools.includes('set_cell_widget'));
  assert.match(granted.note || '', /未编入场景族/);
});

test('auto 回退：未带 path 时仍给可执行的下一步（不是空报错）', () => {
  const m = new DeepToolManager();
  assert.throws(
    () => m.grantAuto({ tools: ['set_cell_widget'] }),
    /需按名直租 adhoc，但本次未带 path[\s\S]*group:'adhoc'/,
  );
});

// ---------------------------------------------------------------------------
// ③ 单文件租约下漏传 path：按租约绑定文件补齐；多文件租约仍要求显式 path
// ---------------------------------------------------------------------------
test('租约 path 补齐：只有一个绑定文件时自动沿用', () => {
  const m = new DeepToolManager();
  const granted = m.grant({
    group: 'scripting', filePath: 'C:/tmp/single/t.cpt', tools: ['set_webwrite_js'],
    ttlSeconds: 60, maxCalls: 5, reason: 'explicit_scripting',
  });
  const args = {};
  const lease = m.beforeCall('set_webwrite_js', args);
  assert.ok(lease, '应命中租约而不是报"未传 path"');
  assert.equal(args.path, lease.path, '调用参数应被补齐为租约绑定文件');
  assert.equal(args.path.toLowerCase(), granted.scope.path.toLowerCase(), '补齐值与租约绑定文件一致');
  m.afterCall(lease);
});

test('租约 path 补齐：多文件租约仍要求显式 path（不得跨文件误写）', () => {
  const m = new DeepToolManager();
  m.grant({ group: 'scripting', filePath: 'C:/tmp/a/t.cpt', tools: ['set_webwrite_js'], ttlSeconds: 60, maxCalls: 5, reason: 'x' });
  m.grant({ group: 'scripting', filePath: 'C:/tmp/b/t.cpt', tools: ['set_webwrite_js'], ttlSeconds: 60, maxCalls: 5, reason: 'x' });
  assert.throws(() => m.beforeCall('set_webwrite_js', {}), /不匹配/);
});
