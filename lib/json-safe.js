// cpt-mcp/lib/json-safe.js
// MCP 返回体的 JSON 安全化（出口兜底）。
//
// 背景（2026-11-07 用户实测 P0）：lib/localdb.js 用 node:sqlite 的 `readBigInts: true` 保 BIGINT
// 精度，于是 COUNT(*)/SUM() 这类聚合列是 **bigint**。工具 handler 把结果交给 server.js 的 ok()
// 后，`JSON.stringify(data)` 直接抛 `TypeError: Do not know how to serialize a BigInt`
// （MCP 工具调用整体失败，用户看到的就是这句）。同理 Uint8Array/Buffer 在 text 分支会被序列化成
// `{"0":…}` 对象、在 structuredContent 里也过不了 JSON 序列化。
//
// 设计取舍：
//   - 只在出口做**无损**转换：bigint → 安全整数（Number.isSafeInteger）或十进制字符串；
//     Uint8Array → `base64:…`（与 lib/localdb.js 的 toJsonSafe 同一口径）；
//   - 其余值原样透传，不重构业务结构：Date / 带 toJSON 的对象 / 类实例保持原引用，
//     JSON 文本表现与改造前完全一致（避免为了兜底把工具返回体偷偷改形）；
//   - 纯函数、无三方依赖，便于单测；ok() 之外若还有直接 JSON.stringify 的出口也可复用。
//
// 注意：这不是"BigInt 就该丢掉"的借口 —— 源头（localTableInfo/localSchemaSnapshot 的 rows）
// 仍然显式 toJsonSafe，本模块只是防其它未知出口把 bigint 漏给 JSON.stringify。

const SAFE_INT = Number.MAX_SAFE_INTEGER;

/** 单个值的 JSON 安全化（不递归；数组/普通对象原样返回，由 toJsonSafeDeep 处理）。 */
export function toJsonSafeValue(v) {
  if (v === null || v === undefined) return v;
  if (typeof v === 'bigint') {
    const n = Number(v);
    return Number.isSafeInteger(n) ? n : v.toString();
  }
  if (v instanceof Uint8Array) return `base64:${Buffer.from(v).toString('base64')}`;
  return v;
}

function isPlainObject(v) {
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function walk(v, seen) {
  // 原始值 / bigint / 二进制
  if (v === null || typeof v !== 'object') return toJsonSafeValue(v);
  if (v instanceof Uint8Array) return toJsonSafeValue(v);
  // 交给 JSON.stringify 自己处理的类型（Date、带 toJSON 的、类实例）保持原引用，
  // 避免改变既有返回结构；这些类型内部不可能再嵌套 bigint（业务侧不会这么构造）。
  if (typeof v.toJSON === 'function') return v;
  if (!Array.isArray(v) && !isPlainObject(v)) return v;
  if (seen.has(v)) return '[circular]';
  seen.add(v);
  try {
    if (Array.isArray(v)) return v.map((x) => walk(x, seen));
    const out = {};
    for (const k of Object.keys(v)) out[k] = walk(v[k], seen);
    return out;
  } finally {
    seen.delete(v);
  }
}

/** 递归 JSON 安全化：bigint → number|string、Uint8Array → base64:…，其余结构原样。 */
export function toJsonSafeDeep(value) {
  return walk(value, new WeakSet());
}

/** 直接给 JSON.stringify 用：先安全化再序列化（等价于 JSON.stringify(toJsonSafeDeep(v), null, indent) ）。 */
export function stringifyJsonSafe(value, indent = 0) {
  return JSON.stringify(toJsonSafeDeep(value), null, indent);
}

export { SAFE_INT };
