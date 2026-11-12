// cpt-mcp/test/json-safe.test.js —— MCP 出口 JSON 安全化（2026-11-07 P0：BigInt 序列化）
//
// 背景：lib/localdb.js 用 node:sqlite 的 readBigInts:true 保 BIGINT 精度，COUNT(*) 等聚合是
// bigint；旧 ok() 直接 JSON.stringify → 抛 "Do not know how to serialize a BigInt"，
// local_db_schema 整体失败（用户实测）。本文件锁住 lib/json-safe.js 的转换口径与穿透结构。
import test from 'node:test';
import assert from 'node:assert/strict';
import { toJsonSafeValue, toJsonSafeDeep, stringifyJsonSafe } from '../lib/json-safe.js';

test('toJsonSafeValue：BigInt → 安全整数或十进制字符串；Uint8Array → base64', () => {
  assert.equal(toJsonSafeValue(42n), 42);
  assert.equal(toJsonSafeValue(0n), 0);
  assert.equal(toJsonSafeValue(2n ** 63n), '9223372036854775808');
  assert.equal(toJsonSafeValue(-(2n ** 63n)), '-9223372036854775808');
  // 2^53 起不是安全整数 → 十进制字符串，避免静默丢精度
  assert.equal(toJsonSafeValue(2n ** 53n), '9007199254740992');
  assert.equal(toJsonSafeValue(new Uint8Array([1, 2, 3])), 'base64:AQID');
  assert.equal(toJsonSafeValue(null), null);
  assert.equal(toJsonSafeValue(undefined), undefined);
  assert.equal(toJsonSafeValue('x'), 'x');
  assert.equal(toJsonSafeValue(1.5), 1.5);
});

test('toJsonSafeDeep：嵌套结构里的 BigInt 全部转安全值，其余结构/引用类型原样', () => {
  const date = new Date('2026-11-07T00:00:00.000Z');
  const raw = {
    rows: 1000n,
    nested: { big: 2n ** 70n, list: [1n, 'a', { deep: 3n }] },
    bin: new Uint8Array([104, 105]),
    date,
    text: 'keep',
    flag: true,
    nil: null,
  };
  const safe = toJsonSafeDeep(raw);
  assert.equal(safe.rows, 1000);
  assert.equal(safe.nested.big, String(2n ** 70n));
  assert.deepEqual(safe.nested.list, [1, 'a', { deep: 3 }]);
  assert.equal(safe.bin, 'base64:aGk=');
  assert.equal(safe.date, date, 'Date 保持原引用（JSON.stringify 的文本表现不变）');
  assert.equal(safe.text, 'keep');
  assert.equal(safe.flag, true);
  assert.equal(safe.nil, null);
  assert.notEqual(safe, raw, '顶层容器是副本，避免污染业务对象');
  // 关键：不再抛 "Do not know how to serialize a BigInt"
  const text = JSON.stringify(safe);
  assert.ok(text.includes('"rows":1000'), text);
  assert.ok(!/BigInt/.test(text), text);
});

test('toJsonSafeDeep：循环引用不炸；数组顶层仍是数组（ok() 的 items 包装依赖这一点）', () => {
  const a = { name: 'a' };
  a.self = a;
  const safe = toJsonSafeDeep(a);
  assert.equal(safe.name, 'a');
  assert.equal(safe.self, '[circular]');
  assert.doesNotThrow(() => JSON.stringify(safe));

  const arr = toJsonSafeDeep([1n, 2n]);
  assert.ok(Array.isArray(arr));
  assert.deepEqual(arr, [1, 2]);

  assert.equal(typeof stringifyJsonSafe({ x: 1n }), 'string');
  assert.doesNotThrow(() => stringifyJsonSafe({ x: 1n }));
  assert.equal(stringifyJsonSafe({ x: 1n }), '{"x":1}');
  assert.equal(stringifyJsonSafe({ x: 1n }, 2), '{\n  "x": 1\n}');
});
