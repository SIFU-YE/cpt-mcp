// test/cohesion-invariants.test.js —— 2026-10-29 结构整理的不变量锁
//
// 背景：本轮整理做了四类"单一事实源"改造（写工具清单由 contract 派生、颜色/尺寸助手收敛、
// parsed 树取用口径收敛、工具围栏表驱动化）。这些改造的价值在于"以后不会再分叉"，
// 因此用本文件把关键不变量钉死：
//   ① 分类集合与注册表一一对应（不多不少、写集合两两不相交）；
//   ② 租约族成员 / 轻 entry / 静态表 / 注册表四者同源；
//   ③ parsed-shape、path-util 两个 leaf 的行为口径（负值舍入、实体反转义、路径归一）；
//   ④ JS 基线写盘钩子必须由 js-baseline 模块注册（依赖倒置后不再由 xml.js 静态 import）；
//   ⑤ 工具级安全围栏表覆盖的名字都是真实注册工具，且行为与整理前等价（js:null 也走围栏）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import '../scripts/isolate-store.mjs'; // M123：JS 基线 store 隔离

import {
  READ_ONLY_TOOLS, DESTRUCTIVE_TOOLS, IDEMPOTENT_WRITE_TOOLS, APPEND_WRITE_TOOLS,
  OPEN_WORLD_TOOLS, REPORT_STATIC_TOOLS, LEASE_GROUPS, DEEP_TOOLS,
} from '../lib/contract.js';
import { LIGHT_TOOL_NAMES } from '../lib/light-schemas.js';
import { FULL_ONLY_WAIVERS } from '../lib/reachability.js';
import {
  JS_PAYLOAD_TOOLS, JS_ITEMS_TOOLS, JS_PATCH_ITEMS_TOOLS, PER_TOOL_GUARDS, runToolGuards,
} from '../lib/tool-guards.js';
import { writeHookCount, registerWriteHook, runWriteHooks } from '../lib/write-hooks.js';
import { asArray, asReports, cdataOf, unescapeXml } from '../lib/parsed-shape.js';
import { normalizePath } from '../lib/path-util.js';
import { mmToUnit, unitToMm } from '../lib/engine/rules.js';
import '../lib/js-baseline.js'; // side-effect：注册写盘后基线刷新钩子

const ROOT = path.resolve(import.meta.dirname, '..');

/** server.js 里真实注册的工具名（208 个静态声明；不含动态租约注册） */
function registeredToolNames() {
  const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  return new Set([...src.matchAll(/^tool\('([a-z0-9_]+)'/gm)].map((m) => m[1]));
}

test('注册表与分类集合一一对应：写集合两两不相交，且并集恰为非只读工具', () => {
  const registered = registeredToolNames();
  assert.equal(registered.size, 208, `server.js 应静态注册 208 个工具，实际 ${registered.size}`);
  for (const [label, set] of [
    ['READ_ONLY', READ_ONLY_TOOLS], ['DESTRUCTIVE', DESTRUCTIVE_TOOLS],
    ['IDEMPOTENT_WRITE', IDEMPOTENT_WRITE_TOOLS], ['APPEND_WRITE', APPEND_WRITE_TOOLS],
    ['OPEN_WORLD', OPEN_WORLD_TOOLS],
  ]) {
    for (const name of set) assert.ok(registered.has(name), `${label} 集合里的 ${name} 不是已注册工具（名字漂移/死配置）`);
  }
  // 三类写集合互斥（openWorld 是正交轴，不参与互斥检查）
  const writes = [...DESTRUCTIVE_TOOLS, ...IDEMPOTENT_WRITE_TOOLS, ...APPEND_WRITE_TOOLS];
  assert.equal(new Set(writes).size, writes.length, '写集合之间不得重复归类');
  const writeUnion = new Set(writes);
  const nonReadOnly = new Set([...registered].filter((n) => !READ_ONLY_TOOLS.has(n)));
  assert.deepEqual([...writeUnion].sort(), [...nonReadOnly].sort(), '写集合并集必须精确等于"非只读"工具集');
  for (const name of WRITE_SAMPLE()) assert.ok(writeUnion.has(name), `${name} 应归入写集合`);
});

// 抽样几个"曾经漏归类"的工具（withWriteBoundary 的派生清单依赖这些集合完整）
function WRITE_SAMPLE() {
  return ['delete_row_range', 'schedule_add', 'add_cell_hyperlink', 'batch_mutate_cells'];
}

test('租约族成员 / 轻 entry / report 静态表 / 注册表四者同源', () => {
  const registered = registeredToolNames();
  for (const [group, def] of Object.entries(LEASE_GROUPS)) {
    for (const member of def.members) {
      assert.ok(registered.has(member), `族 ${group} 的成员 ${member} 不是已注册工具`);
      assert.ok(DEEP_TOOLS.has(member), `族 ${group} 的成员 ${member} 应进 DEEP_TOOLS`);
    }
  }
  assert.equal(REPORT_STATIC_TOOLS.length, 33, 'report 静态表应 33 项（2026-11-12 P0-1 精简：42→33）');
  assert.equal(new Set(REPORT_STATIC_TOOLS).size, REPORT_STATIC_TOOLS.length, 'report 静态表不得重复');
  for (const name of REPORT_STATIC_TOOLS) assert.ok(registered.has(name), `静态表里的 ${name} 不是已注册工具`);
  // 轻 entry 是"省静态字节"的实现手段，只对仍会注册进上下文的工具有效：
  // 静态表 ∪ 租约族 ∪ 豁免表 至少覆盖其一，否则该轻定义成死配置。
  const everVisible = new Set([...REPORT_STATIC_TOOLS]);
  for (const def of Object.values(LEASE_GROUPS)) for (const member of def.members) everVisible.add(member);
  for (const waiver of FULL_ONLY_WAIVERS) for (const name of waiver.tools) everVisible.add(name);
  for (const name of LIGHT_TOOL_NAMES) {
    assert.ok(everVisible.has(name), `轻 entry ${name} 不在任何静态档/租约族/豁免表内（轻定义会成死配置）`);
  }
  // generate_report 已从 generator_full 移出（三档全静态，属纯死配置）
  assert.ok(!LEASE_GROUPS.generator_full.members.includes('generate_report'), 'generate_report 不应再列为 generator_full 成员');
  // 2026-11-12 P0-1：build_report 从 report 静态表下沉 generator_full（能力仍可达，按需租）
  assert.ok(!REPORT_STATIC_TOOLS.includes('build_report'), 'build_report 应已下沉 generator_full');
  assert.ok(LEASE_GROUPS.generator_full.members.includes('build_report'), 'build_report 必须在 generator_full 族内');
});

test('parsed-shape：数组/工作表/CDATA/实体口径唯一', () => {
  assert.deepEqual(asArray(null), []);
  assert.deepEqual(asArray(undefined), []);
  assert.deepEqual(asArray(5), [5]);
  assert.deepEqual(asArray([1, 2]), [1, 2]);
  const reports = asReports({ WorkBook: { Report: [{ '@_name': 's1' }, {}] } });
  assert.deepEqual(reports.map((r) => r.sheet), ['s1', 'sheet2']);
  assert.deepEqual(reports.map((r) => r.index), [0, 1]);
  assert.equal(cdataOf({ __cdata: 'x' }), 'x');
  assert.equal(cdataOf('y'), 'y');
  assert.equal(unescapeXml('&lt;a&gt;&amp;&quot;&apos;'), `<a>&"'`);
  assert.equal(unescapeXml(null), '');
});

test('path-util：路径归一唯一（win32 小写、绝对路径）', () => {
  const raw = path.join('some', 'dir', '..', 'x.cpt');
  const expected = process.platform === 'win32' ? path.resolve(raw).toLowerCase() : path.resolve(raw);
  assert.equal(normalizePath(raw), expected);
  assert.equal(normalizePath(path.resolve(raw)), expected);
});

test('尺寸换算：mmToUnit 整数化、unitToMm 负值按十进制半舍入（不产生 0.001 漂移）', () => {
  assert.equal(mmToUnit(1), 144000);
  assert.equal(unitToMm(144000), 1);
  assert.equal(unitToMm(-19944), -0.139, '旧 edits 读侧口径是 toFixed(3)：-19944 → -0.139');
  assert.equal(unitToMm(19944), 0.139);
  assert.equal(unitToMm(0), 0);
});

test('写盘钩子：js-baseline 模块注册后，save 路径才会刷新基线（依赖倒置的接线锁）', () => {
  assert.ok(writeHookCount() >= 1, 'js-baseline 被 import 后必须已注册写盘后钩子');
  const seen = [];
  const hook = (p) => seen.push(p);
  const before = writeHookCount();
  registerWriteHook(hook);
  registerWriteHook(hook); // 幂等：重复注册不重复执行
  assert.equal(writeHookCount(), before + 1);
  runWriteHooks('C:/tmp/x.cpt');
  assert.deepEqual(seen, ['C:/tmp/x.cpt']);
  // 钩子内部失败不得影响写入（也不阻断其它钩子）
  const before2 = writeHookCount();
  registerWriteHook(() => { throw new Error('boom'); });
  assert.equal(writeHookCount(), before2 + 1);
  assert.doesNotThrow(() => runWriteHooks('C:/tmp/y.cpt'));
});

test('工具围栏表：覆盖名都是真实工具，JS 授权口径与整理前逐条等价', () => {
  const registered = registeredToolNames();
  const guarded = new Set([...JS_PAYLOAD_TOOLS, ...JS_ITEMS_TOOLS, ...JS_PATCH_ITEMS_TOOLS, ...Object.keys(PER_TOOL_GUARDS)]);
  for (const name of guarded) assert.ok(registered.has(name), `围栏表里的 ${name} 不是已注册工具（死配置）`);
  assert.ok(guarded.size >= 20, `围栏应覆盖 ≥20 个工具，实际 ${guarded.size}`);

  const savedUnsafe = process.env.CPT_MCP_ALLOW_UNSAFE_SCRIPT;
  const savedSched = process.env.CPT_MCP_ALLOW_SCHEDULE_SIDE_EFFECTS;
  delete process.env.CPT_MCP_ALLOW_UNSAFE_SCRIPT;
  delete process.env.CPT_MCP_ALLOW_SCHEDULE_SIDE_EFFECTS;
  try {
    // ① JS 载荷工具：有脚本且未授权 → 拒；授权 → 放行；空 js → 放行
    assert.throws(() => runToolGuards('set_report_js', { js: 'var a = 1;' }), /allowUnsafeScript/);
    assert.doesNotThrow(() => runToolGuards('set_report_js', { js: 'var a = 1;', allowUnsafeScript: true }));
    assert.doesNotThrow(() => runToolGuards('set_report_js', {}));
    // ② 旧口径 js:null 也走围栏（String(null)='null' 非空；strict schema 之外再兜一层）
    assert.throws(() => runToolGuards('set_report_js', { js: null }), /allowUnsafeScript/);
    // ③ 批量 items[].js / items[].patch.js 逐项扫描
    assert.throws(() => runToolGuards('add_report_listener_batch', { items: [{ js: 'var b = 2;' }] }), /allowUnsafeScript/);
    assert.throws(() => runToolGuards('update_toolbar_button_batch', { items: [{ patch: { js: 'var c = 3;' } }] }), /allowUnsafeScript/);
    // ④ update_cell 的脚本特征检测（looksLikeScript：<script / javascript: / eval / document. 等）
    assert.throws(() => runToolGuards('update_cell', { content: '<script>alert(1)</script>' }), /allowUnsafeScript/);
    // ⑤ 定时任务 decompile 默认关闭
    assert.throws(() => runToolGuards('schedule_add', { action: 'decompile' }), /CPT_MCP_ALLOW_SCHEDULE_SIDE_EFFECTS/);
    // ⑥ 未登记工具不做事（围栏只对表内工具生效）
    assert.doesNotThrow(() => runToolGuards('get_cells', { path: 'C:/tmp/x.cpt' }));
  } finally {
    if (savedUnsafe === undefined) delete process.env.CPT_MCP_ALLOW_UNSAFE_SCRIPT;
    else process.env.CPT_MCP_ALLOW_UNSAFE_SCRIPT = savedUnsafe;
    if (savedSched === undefined) delete process.env.CPT_MCP_ALLOW_SCHEDULE_SIDE_EFFECTS;
    else process.env.CPT_MCP_ALLOW_SCHEDULE_SIDE_EFFECTS = savedSched;
  }
});
