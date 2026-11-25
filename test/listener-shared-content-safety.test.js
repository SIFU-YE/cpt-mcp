// test/listener-shared-content-safety.test.js —— Listener 共享大 Content 的写入自卫（2026-11-03 事故回归）
//
// 事故：某填报模板 afterload 是**一个** 186,767 字节的共享 <Content>（frFin 核心 + 手动化 + Ctrl 多选 +
// 补丁 1~4 全在同一段）。本意只改其中一小段，却用「match 选块 + js 整块替换」把整段换成 8KB：
// 文件 533,581 → 366,347 B，JS 块数仍 44、语法/validate/quality/引擎全绿，功能已全丢。
//
// 本文件锁定修复后的能力：
// ① 读侧 get_webwrite_js / get_report_listener 每项带 jsLength/jsBytes/jsLines（UTF-8 字节、行数）；
// ② 整块替换缩水护栏：旧 Content ≥4KB 且新内容 <60% 且少 ≥2KB → 拒绝写入（文件不动），allowShrink:true 才放行；
// ③ patchFind/patchReplace 片段替换：literal、默认唯一命中、只改命中片段（块内其余原文原样保留）、
//    与 js/aggregate 互斥；返回 jsBytesBefore/jsBytesAfter 供对账；
// ④ 小块正常替换、新建块、aggregate 追加等老行为不受影响。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCpt } from '../lib/generate.js';
import { setReportListener, setWebWriteJs } from '../lib/edits.js';
import { webwriteListener, reportListener } from '../lib/cpt.js';
import '../scripts/isolate-store.mjs'; // JS 基线 store 隔离

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-listener-safety-'));
const read = (p) => fs.readFileSync(p, 'utf8');

/** 生成一段大 JS（默认 ~100KB、多行）：包含可定位片段与多字节中文注释。 */
function bigJs(lines = 3000, tag = 'KEEP') {
  const head = `// 共享大块开始 tag=${tag}\nvar sharedMarker = '${tag}-PLACEHOLDER';\n// 中文注释：这一整段是多个补丁共用的 Content，整块替换会丢功能\n`;
  const body = Array.from({ length: lines }, (_, i) => `function fn_${tag}_${i}() { return ${i}; }`).join('\n');
  return `${head}${body}\n// 共享大块结束`;
}

/** 预置模板：填报 Web 事件 afterappend 写入大块（createCpt 带 webWrite 容器）。 */
function cptWithBigWebWrite(js) {
  const d = tmp();
  const p = path.join(d, 'w.cpt');
  createCpt(p, { rows: 3, columns: 3, webWrite: true });
  setWebWriteJs(p, { event: 'afterappend', js });
  return { d, p };
}

// ---------- ① 读侧度量 ----------

test('读侧：get_webwrite_js 每项带 jsBytes/jsLines，且与原文一致', () => {
  const d = tmp();
  const p = path.join(d, 'm.cpt');
  createCpt(p, { rows: 3, columns: 3, webWrite: true });
  const js = '// 中文注释一行\nvar a = 1;\nvar b = 2;\n';
  setWebWriteJs(p, { event: 'afterappend', js });
  const r = webwriteListener(p, { event: 'afterappend' });
  assert.equal(r.count, 1);
  const l = r.listeners[0];
  assert.equal(l.js, js);
  assert.equal(l.jsLength, js.length, 'jsLength 仍是字符数');
  assert.equal(l.jsBytes, Buffer.byteLength(js, 'utf8'), 'jsBytes = UTF-8 字节数');
  assert.equal(l.jsLines, js.split('\n').length, 'jsLines = 按 \\n 的行数');
  // 事件清单模式（不传 event）也要带度量
  const list = webwriteListener(p);
  assert.equal(list.events[0].jsBytes, Buffer.byteLength(js, 'utf8'));
  assert.equal(list.events[0].jsLines, js.split('\n').length);
  fs.rmSync(d, { recursive: true, force: true });
});

test('读侧：get_report_listener 每项带 jsBytes/jsLines', () => {
  const d = tmp();
  const p = path.join(d, 'r.cpt');
  createCpt(p, { rows: 3, columns: 3 });
  const js = '// 中文\nfunction keepA() { return 1; }\nfunction keepB() { return 2; }';
  setReportListener(p, { event: 'afterload', js, sheet: 0 });
  const r = reportListener(p, { event: 'afterload' });
  assert.equal(r.count, 1);
  assert.equal(r.listeners[0].jsBytes, Buffer.byteLength(js, 'utf8'));
  assert.equal(r.listeners[0].jsLines, 3);
  fs.rmSync(d, { recursive: true, force: true });
});

// ---------- ② 整块替换缩水护栏 ----------

test('护栏：大 Content 整块换成小段 → 拒绝且文件不动（webwrite）', () => {
  const big = bigJs(3000, 'BIG');
  const { d, p } = cptWithBigWebWrite(big);
  const before = read(p);
  assert.throws(
    () => setWebWriteJs(p, { event: 'afterappend', js: 'var tiny = 1;' }),
    /拒绝整块替换[\s\S]*allowShrink/,
    '大块共享 Content 禁止整块缩水替换',
  );
  assert.equal(read(p), before, '拒绝后文件必须原样不动');
  assert.equal(webwriteListener(p, { event: 'afterappend' }).listeners[0].js, big);
  fs.rmSync(d, { recursive: true, force: true });
});

test('护栏：大 Content 整块换成新大段（未 >40% 缩水）→ 放行', () => {
  const big = bigJs(2000, 'BIG2');
  const { d, p } = cptWithBigWebWrite(big);
  const replacement = bigJs(1800, 'NEW');
  const r = setWebWriteJs(p, { event: 'afterappend', js: replacement });
  assert.equal(r.mode, 'update');
  assert.equal(r.jsBytesBefore, Buffer.byteLength(big, 'utf8'));
  assert.equal(r.jsBytesAfter, Buffer.byteLength(replacement, 'utf8'));
  assert.equal(webwriteListener(p, { event: 'afterappend' }).listeners[0].js, replacement);
  fs.rmSync(d, { recursive: true, force: true });
});

test('护栏：allowShrink=true 明确放行整块缩水替换', () => {
  const big = bigJs(3000, 'BIG3');
  const { d, p } = cptWithBigWebWrite(big);
  const small = 'var intentionallySmall = 1;';
  const r = setWebWriteJs(p, { event: 'afterappend', js: small, allowShrink: true });
  assert.equal(r.mode, 'update');
  assert.equal(r.jsBytesBefore, Buffer.byteLength(big, 'utf8'));
  assert.equal(r.jsBytesAfter, Buffer.byteLength(small, 'utf8'));
  assert.equal(webwriteListener(p, { event: 'afterappend' }).listeners[0].js, small);
  fs.rmSync(d, { recursive: true, force: true });
});

test('护栏：小块（<4KB）正常替换不受影响（老行为兼容）', () => {
  const d = tmp();
  const p = path.join(d, 's.cpt');
  createCpt(p, { rows: 3, columns: 3, webWrite: true });
  setWebWriteJs(p, { event: 'afterappend', js: 'var oldValue = 123;' });
  const r = setWebWriteJs(p, { event: 'afterappend', js: 'var v = 1;' }); // 变短但块很小 → 不拦
  assert.equal(r.mode, 'update');
  assert.equal(r.jsBytesAfter, Buffer.byteLength('var v = 1;', 'utf8'));
  assert.equal(webwriteListener(p, { event: 'afterappend' }).listeners[0].js, 'var v = 1;');
  fs.rmSync(d, { recursive: true, force: true });
});

test('护栏：report listener 同样拦截大 afterload 整块缩水', () => {
  const big = bigJs(3000, 'RPT');
  const d = tmp();
  const p = path.join(d, 'rb.cpt');
  createCpt(p, { rows: 3, columns: 3 });
  setReportListener(p, { event: 'afterload', js: big, sheet: 0 });
  const before = read(p);
  assert.throws(
    () => setReportListener(p, { event: 'afterload', js: 'var tiny = 1;', sheet: 0 }),
    /拒绝整块替换[\s\S]*allowShrink/,
  );
  assert.equal(read(p), before);
  // allowShrink 放行（report 路径最终走 updateReportNode，mode/action 由低层返回，这里只核对落盘结果）
  const r = setReportListener(p, { event: 'afterload', js: 'var ok = 1;', sheet: 0, allowShrink: true });
  assert.equal(r.jsBytesAfter, Buffer.byteLength('var ok = 1;', 'utf8'));
  assert.equal(reportListener(p, { event: 'afterload' }).listeners[0].js, 'var ok = 1;');
  fs.rmSync(d, { recursive: true, force: true });
});

// ---------- ③ 片段替换 ----------

test('片段替换：只改命中片段，块内其余原文（函数/中文/结构）原样保留 + 返回前后字节数', () => {
  const big = bigJs(3000, 'PATCH');
  const { d, p } = cptWithBigWebWrite(big);
  const find = "'PATCH-PLACEHOLDER'";
  const repl = "'PATCHED'";
  const r = setWebWriteJs(p, { event: 'afterappend', patchFind: find, patchReplace: repl });
  assert.equal(r.action, 'set_webwrite_js');
  assert.equal(r.mode, 'patch');
  assert.equal(r.patchHits, 1);
  assert.equal(r.jsBytesBefore, Buffer.byteLength(big, 'utf8'));
  const expected = big.split(find).join(repl);
  assert.equal(r.jsBytesAfter, Buffer.byteLength(expected, 'utf8'));
  assert.equal(r.jsLinesAfter, expected.split('\n').length);
  const after = webwriteListener(p, { event: 'afterappend' }).listeners[0].js;
  assert.equal(after, expected, '等价于原文做一次 literal 替换');
  assert.ok(after.includes('function fn_PATCH_2999()'), '大块其余函数全部保留');
  assert.ok(after.includes('中文注释'), '多字节内容保留');
  assert.ok(read(p).includes('<Parameters/>'), 'Listener 结构节点保留');
  fs.rmSync(d, { recursive: true, force: true });
});

test('片段替换：report listener 可用，且只改一段（其余函数保留）', () => {
  const big = bigJs(3000, 'RP');
  const d = tmp();
  const p = path.join(d, 'rp.cpt');
  createCpt(p, { rows: 3, columns: 3 });
  setReportListener(p, { event: 'afterload', js: big, sheet: 0 });
  const r = setReportListener(p, { event: 'afterload', sheet: 0, patchFind: 'var sharedMarker', patchReplace: 'var patchedMarker' });
  assert.equal(r.mode, 'patch');
  assert.equal(r.patchHits, 1);
  const after = reportListener(p, { event: 'afterload' }).listeners[0].js;
  assert.ok(after.includes('var patchedMarker'));
  assert.ok(after.includes('function fn_RP_2999()'));
  assert.ok(after.includes('共享大块结束'));
  fs.rmSync(d, { recursive: true, force: true });
});

test('片段替换：0 处命中 / 多处命中 → 拒绝且文件不动；patchAll=true 才全替换', () => {
  const d = tmp();
  const p = path.join(d, 'x.cpt');
  createCpt(p, { rows: 3, columns: 3, webWrite: true });
  const js = 'var a = __MARK__;\nvar b = __MARK__;\nvar c = 3;';
  setWebWriteJs(p, { event: 'afterappend', js });
  const before = read(p);
  assert.throws(() => setWebWriteJs(p, { event: 'afterappend', patchFind: 'NOT_PRESENT', patchReplace: 'x' }), /未命中（0 处）/);
  assert.throws(() => setWebWriteJs(p, { event: 'afterappend', patchFind: '__MARK__', patchReplace: 'Y' }), /命中 2 处/);
  assert.equal(read(p), before, '两次拒绝后文件不动');
  const r = setWebWriteJs(p, { event: 'afterappend', patchFind: '__MARK__', patchReplace: 'Y', patchAll: true });
  assert.equal(r.patchHits, 2);
  const after = webwriteListener(p, { event: 'afterappend' }).listeners[0].js;
  assert.equal(after, 'var a = Y;\nvar b = Y;\nvar c = 3;');
  fs.rmSync(d, { recursive: true, force: true });
});

test('片段替换：patchFind 与 js / aggregate 互斥；patchReplace 可空（删片段）', () => {
  const d = tmp();
  const p = path.join(d, 'm2.cpt');
  createCpt(p, { rows: 3, columns: 3, webWrite: true });
  setWebWriteJs(p, { event: 'afterappend', js: 'var keep = 1; /*DELETE_ME*/ var after = 2;' });
  assert.throws(() => setWebWriteJs(p, { event: 'afterappend', patchFind: 'keep', js: 'var x = 1;' }), /不能同时传 js/);
  assert.throws(() => setWebWriteJs(p, { event: 'afterappend', patchFind: 'keep', aggregate: true }), /不能与 aggregate 联用/);
  const r = setWebWriteJs(p, { event: 'afterappend', patchFind: ' /*DELETE_ME*/' }); // 空 patchReplace = 删片段
  assert.equal(r.patchHits, 1);
  assert.equal(webwriteListener(p, { event: 'afterappend' }).listeners[0].js, 'var keep = 1; var after = 2;');
  fs.rmSync(d, { recursive: true, force: true });
});

test('片段替换：patchFind 未找到目标 event → 报错（不会新建块）', () => {
  const d = tmp();
  const p = path.join(d, 'nf.cpt');
  createCpt(p, { rows: 3, columns: 3, webWrite: true });
  setWebWriteJs(p, { event: 'afterappend', js: 'var a = 1;' });
  const before = read(p);
  assert.throws(() => setWebWriteJs(p, { event: 'writesuccess', patchFind: 'a', patchReplace: 'b' }), /无法片段替换/);
  assert.equal(read(p), before);
  fs.rmSync(d, { recursive: true, force: true });
});

test('片段替换：expectedSha256 对得上可写、对不上拒绝且文件不动', () => {
  const d = tmp();
  const p = path.join(d, 'sha.cpt');
  createCpt(p, { rows: 3, columns: 3, webWrite: true });
  setWebWriteJs(p, { event: 'afterappend', js: 'var shaTest = 1;' });
  const l = webwriteListener(p, { event: 'afterappend' }).listeners[0];
  const before = read(p);
  assert.throws(
    () => setWebWriteJs(p, { event: 'afterappend', patchFind: 'shaTest', patchReplace: 'shaPatched', expectedSha256: '0'.repeat(64) }),
    /expectedSha256/,
  );
  assert.equal(read(p), before);
  const r = setWebWriteJs(p, { event: 'afterappend', patchFind: 'shaTest', patchReplace: 'shaPatched', expectedSha256: l.sha256 });
  assert.equal(r.patchHits, 1);
  assert.ok(webwriteListener(p, { event: 'afterappend' }).listeners[0].js.includes('shaPatched'));
  fs.rmSync(d, { recursive: true, force: true });
});

// ---------- ④ 老行为不受影响 ----------

test('多块同 event：patchFind 配合 match 只改被选中的那一块', () => {
  const d = tmp();
  const p = path.join(d, 'multi.cpt');
  createCpt(p, { rows: 3, columns: 3, webWrite: true });
  setWebWriteJs(p, { event: 'afterappend', js: 'var keepFirst = 1; // 块一' });
  // 再注入第二个同 event 块（模拟设计器/外部工具落盘的存量散块）
  const raw = fs.readFileSync(p, 'utf8');
  const end = raw.indexOf('</WebWriteContent>');
  const second = `<Listener event="afterappend">
<JavaScript class="com.fr.js.JavaScriptImpl">
<Parameters/>
<Content>
<![CDATA[var keepSecond = 2; // 块二]]></Content>
</JavaScript>
</Listener>
`;
  fs.writeFileSync(p, raw.slice(0, end) + second + raw.slice(end));
  assert.equal(webwriteListener(p, { event: 'afterappend' }).count, 2);
  const r = setWebWriteJs(p, { event: 'afterappend', match: 'keepSecond', patchFind: 'keepSecond', patchReplace: 'patchedSecond' });
  assert.equal(r.patchHits, 1);
  const listeners = webwriteListener(p, { event: 'afterappend' }).listeners;
  assert.equal(listeners.length, 2, '块数不变');
  assert.ok(listeners[0].js.includes('keepFirst'), '未选中的块一原样保留');
  assert.ok(listeners[1].js.includes('patchedSecond'), '选中的块二只改片段');
  assert.ok(listeners[1].js.includes('// 块二'), '块二其余原文保留');
  fs.rmSync(d, { recursive: true, force: true });
});

test('整块替换大块（未触发缩水）返回 hint 提醒优先用片段替换', () => {
  const big = bigJs(2000, 'HINT');
  const { d, p } = cptWithBigWebWrite(big);
  const r = setWebWriteJs(p, { event: 'afterappend', js: bigJs(1900, 'NEWHINT') });
  assert.match(r.hint, /patchFind\/patchReplace/);
  assert.ok(r.jsBytesBefore > 4096);
  fs.rmSync(d, { recursive: true, force: true });
});

test('老行为：无现有块 → 插入新模式；aggregate 追加不触发护栏', () => {
  const d = tmp();
  const p = path.join(d, 'ins.cpt');
  createCpt(p, { rows: 3, columns: 3, webWrite: true });
  const r1 = setWebWriteJs(p, { event: 'afterappend', js: bigJs(3000, 'INS') });
  assert.equal(r1.mode, 'insert', '首次写入是新建');
  assert.equal(r1.jsBytesAfter, Buffer.byteLength(bigJs(3000, 'INS'), 'utf8'));
  // aggregate 追加：块只变大不缩小，护栏不适用
  const more = '\n// appended tail';
  const r2 = setWebWriteJs(p, { event: 'afterappend', js: more, aggregate: true });
  assert.equal(r2.mode, 'append');
  const after = webwriteListener(p, { event: 'afterappend' }).listeners[0].js;
  assert.ok(after.endsWith('// appended tail'));
  assert.ok(after.startsWith('// 共享大块开始 tag=INS'), '原大块保留');
  fs.rmSync(d, { recursive: true, force: true });
});
