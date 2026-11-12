// test/js-fragment-patch-escapes.test.js —— 片段替换 2026-11-03 二次修复回归
//
// 覆盖两组能力：
//  B（P0 缺陷）：patchFind 匹配兼容 FR 设计器转义 `]A`（`]` 的落盘编码；官方语料 237 个 `]` 100% 如此）。
//     真实证据：sandbox4 session-de4f833e 14:52:54 / 14:53:07 / 15:01:31 / 15:01:38（event=afterload）
//     4 次「patchFind 未命中（0 处）」——模型传净文本 `]`，原文是 `]A`。修复后：净 `]` 与落盘 `]A`
//     均可命中，回写保持 `]A` 编码（不双重编码、也不把已有 `]A` 解码写回）；0 命中报错给候选。
//  A（P0）：4 个 JS 写工具补齐 patchFind/patchReplace/patchAll/allowShrink/expectedSha256 与统一返回体：
//     set_report_js / set_toolbar_button_js / update_cell_listener（add_cell_listener 保持只增语义并指路）。
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createCpt, addCell, addSheet } from '../lib/generate.js';
import {
  setWebWriteJs, setReportListener, setReportJs, setToolbarButtonJs, updateCellListener,
  setCellListener, getCellListener, listToolbarButtons, addToolbarButton,
} from '../lib/edits.js';
import { webwriteListener, overview, jsSha256 } from '../lib/cpt.js';
import { validateCpt } from '../lib/validate.js';
import { runToolGuards } from '../lib/tool-guards.js';
import '../scripts/isolate-store.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-jspatch-'));
const read = (p) => fs.readFileSync(p, 'utf8');
const errs = (p) => validateCpt(p).filter((x) => x.severity === 'error');
const bytes = (s) => Buffer.byteLength(s, 'utf8');

/** 共享大块（>4KB，含可定位片段与中文注释）。 */
function bigJs(lines = 2600, tag = 'KEEP') {
  return `// 共享大块 tag=${tag}\nvar sharedMarker = '${tag}-PLACEHOLDER';\n// 中文注释：这一整段是多个补丁共用的 JS，整块替换会丢功能\n`
    + Array.from({ length: lines }, (_, i) => `function fn_${tag}_${i}() { return ${i}; }`).join('\n')
    + '\n// 共享大块结束';
}

// ===================== B：设计器转义 `]A` 感知匹配 =====================

test('B1 set_webwrite_js：净文本 patchFind 命中 `]A` 落盘内容，回写保持 `]A`、其余原文不动', () => {
  const d = tmp();
  try {
    const p = path.join(d, 'w.cpt');
    createCpt(p, { rows: 3, columns: 3, webWrite: true });
    const js = 'var keep = list[idx]A;\nvar s = "foo]Abar";\nvar tail = 1;';
    setWebWriteJs(p, { event: 'afterload', js });
    const r = setWebWriteJs(p, { event: 'afterload', patchFind: 'foo]bar', patchReplace: 'baz]qux' });
    assert.equal(r.mode, 'patch');
    assert.equal(r.patchHits, 1);
    assert.equal(r.patchMatchedBy, 'designer-decoded', '应走「解码 Content 后匹配」路径');
    assert.match(r.patchFindNote, /设计器/);
    // 读回口径不变：仍是 CDATA 原文，未命中部分原样保留，替换文本按 `]`→`]A` 落盘
    assert.equal(
      webwriteListener(p, { event: 'afterload' }).listeners[0].js,
      'var keep = list[idx]A;\nvar s = "baz]Aqux";\nvar tail = 1;',
    );
    const xml = read(p);
    assert.ok(xml.includes('var keep = list[idx]A;'), '未命中部分保持原 `]A`（禁止解码写回）');
    assert.ok(!xml.includes(']AA'), '不得产生 `]AA` 双重编码');
    assert.equal(errs(p).length, 0);
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test('B2 模型传 raw `]A` 可原文命中；patchReplace 已带 `]A` 不双重编码', () => {
  const d = tmp();
  try {
    const p = path.join(d, 'raw.cpt');
    createCpt(p, { rows: 3, columns: 3, webWrite: true });
    // ① 模型把读回的原文 `foo]Abar` 直接当 patchFind（raw）→ 原文 literal 命中
    setWebWriteJs(p, { event: 'afterload', js: 'var s = "foo]Abar";' });
    let r = setWebWriteJs(p, { event: 'afterload', patchFind: 'foo]Abar', patchReplace: 'ZZ]AQQ' });
    assert.equal(r.patchHits, 1);
    assert.equal(r.patchMatchedBy, undefined, '原文命中不额外报匹配方式（零 token 增长）');
    assert.ok(read(p).includes('var s = "ZZ]AQQ";'), '已编码的 patchReplace 原样写入');
    assert.ok(!read(p).includes(']AA'), '不得双重编码');
    // ② 净 patchFind（展示文本 `ZZ]QQ`）+ 已编码 patchReplace → 解码路径命中、替换文本保持单层 `]A`
    r = setWebWriteJs(p, { event: 'afterload', patchFind: 'ZZ]QQ', patchReplace: 'new]Aval' });
    assert.equal(r.patchHits, 1);
    assert.equal(r.patchMatchedBy, 'designer-decoded');
    assert.ok(read(p).includes('var s = "new]Aval";'));
    assert.ok(!read(p).includes(']AA'));
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test('B3 0 命中：报错含「已按原文/解码各试一次」+ 最接近片段候选，文件不动', () => {
  const d = tmp();
  try {
    const p = path.join(d, 'miss.cpt');
    createCpt(p, { rows: 3, columns: 3, webWrite: true });
    setWebWriteJs(p, { event: 'afterload', js: 'var target = "foo]Abar";\nvar other = 1;' });
    const before = read(p);
    let err = null;
    try {
      setWebWriteJs(p, { event: 'afterload', patchFind: 'var target = "foo]barTAIL"', patchReplace: 'x' });
    } catch (e) { err = e; }
    assert.ok(err, '0 命中必须抛错');
    assert.match(err.message, /未命中（0 处）/);
    assert.match(err.message, /已按原文/);
    assert.match(err.message, /设计器转义解码/, '必须说明已按 `]A`→`]` 解码重试');
    assert.match(err.message, /最接近片段候选/);
    assert.match(err.message, /偏移 \d+/, '候选应带原文偏移');
    assert.match(err.message, /文件未改动/);
    assert.equal(read(p), before, '0 命中不写文件');
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test('B4 set_report_listener 共用同一套 `]A` 感知匹配（净 patchFind 命中 `]A` 原文）', () => {
  const d = tmp();
  try {
    const p = path.join(d, 'rl.cpt');
    createCpt(p, { rows: 3, columns: 3 });
    setReportListener(p, { event: 'afterload', js: 'var s = rows[0]A;\nvar keep = 1;', sheet: 0 });
    const r = setReportListener(p, { event: 'afterload', sheet: 0, patchFind: 'rows[0]', patchReplace: 'rows[1]' });
    assert.equal(r.mode, 'patch');
    assert.equal(r.patchHits, 1);
    assert.equal(r.patchMatchedBy, 'designer-decoded');
    assert.ok(read(p).includes('rows[1]A'));
    assert.ok(read(p).includes('var keep = 1;'));
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

// ===================== A1：set_report_js =====================

test('A1 set_report_js：patch/整块/删除返回口径 + 缩水护栏 + allowShrink + expectedSha256 + `]A`', () => {
  const d = tmp();
  try {
    const p = path.join(d, 't.cpt');
    createCpt(p, { rows: 3, columns: 3 });
    const big = bigJs(2600, 'TOP');
    // 新建：整块写入 mode=replace，无旧块 before=0
    let r = setReportJs(p, { js: big });
    assert.equal(r.action, 'set_report_js');
    assert.equal(r.mode, 'replace');
    assert.equal(r.jsBytesBefore, 0);
    assert.equal(r.jsLinesBefore, 0);
    assert.equal(r.jsBytesAfter, bytes(big));
    // 片段替换：只改一段，其余原文保留
    r = setReportJs(p, { patchFind: 'var sharedMarker', patchReplace: 'var patchedMarker' });
    assert.equal(r.mode, 'patch');
    assert.equal(r.patchHits, 1);
    assert.equal(r.jsBytesBefore, bytes(big));
    assert.equal(r.jsBytesAfter, bytes(big.replace('var sharedMarker', 'var patchedMarker')));
    const topJsAfterPatch = overview(p).jsBlocks[0];
    assert.equal(topJsAfterPatch.topJsBytes, r.jsBytesAfter, 'read_cpt 的 topJsBytes 应与写侧 after 对得上');
    // 多处命中：默认拒绝、patchAll 才全替换（大块→小测试片段需显式 allowShrink 放行）
    setReportJs(p, { js: 'var a = X; var b = X;', allowShrink: true });
    assert.throws(() => setReportJs(p, { patchFind: 'X', patchReplace: 'Y' }), /命中 2 处/);
    r = setReportJs(p, { patchFind: 'X', patchReplace: 'Y', patchAll: true });
    assert.equal(r.patchHits, 2);
    // 互斥
    assert.throws(() => setReportJs(p, { patchFind: 'a', js: 'var x=1;' }), /不能同时传 js/);
    // 回到大块：整块缩水拒绝（文件不动）→ allowShrink 放行
    setReportJs(p, { js: big });
    const before = read(p);
    assert.throws(() => setReportJs(p, { js: 'var tiny = 1;' }), /拒绝整块替换[\s\S]*allowShrink/);
    assert.equal(read(p), before, '护栏拒绝后文件不动');
    r = setReportJs(p, { js: 'var tiny = 1;', allowShrink: true });
    assert.equal(r.mode, 'replace');
    assert.ok(r.jsBytesBefore > 4096);
    // `]A` 解码匹配 + expectedSha256（read_cpt 概览即可拿到旧块 sha）
    const js2 = 'var arr = data[0]A;\nvar keep = 1;';
    setReportJs(p, { js: js2 });
    const blk = overview(p).jsBlocks[0];
    assert.equal(blk.topJsBytes, bytes(js2));
    assert.equal(blk.topJsSha256, jsSha256(js2), 'read_cpt 应给 TopJS sha256（供 expectedSha256 自卫）');
    assert.throws(() => setReportJs(p, { patchFind: 'keep = 1', patchReplace: 'keep = 2', expectedSha256: '0'.repeat(64) }), /sha 不符/);
    r = setReportJs(p, { patchFind: 'keep = 1', patchReplace: 'keep = 2', expectedSha256: blk.topJsSha256 });
    assert.equal(r.patchHits, 1);
    r = setReportJs(p, { patchFind: 'data[0]', patchReplace: 'data[1]' });
    assert.equal(r.patchMatchedBy, 'designer-decoded');
    assert.ok(read(p).includes('data[1]A'), '回写保持 `]A` 编码');
    // 删除：mode=delete + before 度量
    r = setReportJs(p, { js: null });
    assert.equal(r.mode, 'delete');
    assert.ok(r.jsBytesBefore > 0);
    assert.equal(r.jsBytesAfter, 0);
    assert.ok(!read(p).includes('<TopJS>'));
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test('A1b set_report_js：多表 TopJS 未传 sheet → patch/expectedSha256 拒绝（禁止静默命中第一个）', () => {
  const d = tmp();
  try {
    const p = path.join(d, 'multi.cpt');
    createCpt(p, { rows: 3, columns: 3 });
    setReportJs(p, { js: 'var a = 1;' });
    addSheet(p, { sheetName: 's2' });
    setReportJs(p, { js: 'var b = 2;', sheet: 1 });
    assert.throws(() => setReportJs(p, { patchFind: 'var a', patchReplace: 'var c' }), /2 个 <TopJS>/);
    assert.throws(() => setReportJs(p, { js: 'var x = 1;', expectedSha256: '0'.repeat(64) }), /2 个 <TopJS>/);
    const r = setReportJs(p, { sheet: 0, patchFind: 'var a', patchReplace: 'var c' });
    assert.equal(r.patchHits, 1);
    assert.ok(read(p).includes('var c = 1;'));
    assert.ok(read(p).includes('var b = 2;'), '另一张表的 TopJS 不动');
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

// ===================== A2：set_toolbar_button_js =====================

test('A2 set_toolbar_button_js：patch（含 `]A`）、护栏、allowShrink、expectedSha256、无 JS 拒绝', () => {
  const d = tmp();
  try {
    const p = path.join(d, 'bt.cpt');
    createCpt(p, { rows: 3, columns: 3, webWrite: true });
    const js = 'var list = data[idx]A;\nvar keep = 1;';
    addToolbarButton(p, { buttonText: '重算', js });
    // 读侧补齐度量/sha（expectedSha256 的自卫依赖它）
    let listed = listToolbarButtons(p).buttons.find((b) => b.text === '重算');
    assert.equal(listed.jsBytes, bytes(js));
    assert.equal(listed.sha256, jsSha256(js), 'list_toolbar_buttons 应给按钮 JS 的 sha256');
    // 净 patchFind 命中 `]A` 原文
    let r = setToolbarButtonJs(p, { buttonText: '重算', patchFind: 'data[idx]', patchReplace: 'data[j]' });
    assert.equal(r.mode, 'patch');
    assert.equal(r.patchHits, 1);
    assert.equal(r.patchMatchedBy, 'designer-decoded');
    assert.ok(read(p).includes('data[j]A'));
    // 大按钮：整块缩水拒绝 → allowShrink 放行
    addToolbarButton(p, { buttonText: '大按钮', js: bigJs(2600, 'BTN') });
    const before = read(p);
    assert.throws(() => setToolbarButtonJs(p, { buttonText: '大按钮', js: 'var tiny = 1;' }), /拒绝整块替换[\s\S]*allowShrink/);
    assert.equal(read(p), before);
    r = setToolbarButtonJs(p, { buttonText: '大按钮', js: 'var tiny = 1;', allowShrink: true });
    assert.equal(r.mode, 'replace');
    assert.ok(r.jsBytesBefore > 4096);
    // expectedSha256（patch 与删除两条路径都核对）
    listed = listToolbarButtons(p).buttons.find((b) => b.text === '大按钮');
    assert.throws(() => setToolbarButtonJs(p, { buttonText: '大按钮', patchFind: 'tiny', patchReplace: 'small', expectedSha256: '0'.repeat(64) }), /sha 不符/);
    r = setToolbarButtonJs(p, { buttonText: '大按钮', patchFind: 'tiny', patchReplace: 'small', expectedSha256: listed.sha256 });
    assert.equal(r.patchHits, 1);
    assert.ok(read(p).includes('var small = 1;'));
    assert.throws(() => setToolbarButtonJs(p, { buttonText: '大按钮', expectedSha256: '0'.repeat(64) }), /sha 不符/);
    r = setToolbarButtonJs(p, { buttonText: '大按钮', expectedSha256: jsSha256('var small = 1;') });
    assert.equal(r.mode, 'delete');
    assert.ok(r.jsBytesBefore > 0);
    assert.equal(r.jsBytesAfter, 0);
    // 无 JS 的空按钮：patch 报错指路（不新建）
    addToolbarButton(p, { buttonText: '空按钮' });
    assert.throws(() => setToolbarButtonJs(p, { buttonText: '空按钮', patchFind: 'x', patchReplace: 'y' }), /没有 JavaScriptImpl 块/);
    // 互斥
    assert.throws(() => setToolbarButtonJs(p, { buttonText: '重算', patchFind: 'x', js: 'var y=1;' }), /不能同时传 js/);
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

// ===================== A3：update_cell_listener =====================

test('A3 update_cell_listener：patch（含 `]A`）、护栏、allowShrink、expectedSha256、互斥/必填校验', () => {
  const d = tmp();
  try {
    const p = path.join(d, 'cl.cpt');
    createCpt(p, { rows: 3, columns: 3 });
    addCell(p, { column: 0, row: 0, content: '格' });
    setCellListener(p, 0, 0, { event: 'click', js: 'var list = data[idx]A;\nvar keep = 1;' });
    // patch：只改命中片段、className 沿用
    let r = updateCellListener(p, 0, 0, { event: 'click', patchFind: 'data[idx]', patchReplace: 'data[j]' });
    assert.equal(r.mode, 'patch');
    assert.equal(r.patchHits, 1);
    assert.equal(r.patchMatchedBy, 'designer-decoded');
    assert.equal(r.className, 'com.fr.js.JavaScriptImpl');
    assert.ok(read(p).includes('data[j]A'));
    // 整块写入（变大）→ replace；再缩水 → 拒绝；allowShrink → 放行
    const big = bigJs(2600, 'CELL');
    r = updateCellListener(p, 0, 0, { event: 'click', js: big });
    assert.equal(r.mode, 'replace');
    assert.equal(r.jsBytesAfter, bytes(big));
    const before = read(p);
    assert.throws(() => updateCellListener(p, 0, 0, { event: 'click', js: 'var tiny = 1;' }), /拒绝整块替换[\s\S]*allowShrink/);
    assert.equal(read(p), before);
    r = updateCellListener(p, 0, 0, { event: 'click', js: 'var tiny = 1;', allowShrink: true });
    assert.ok(r.jsBytesBefore > 4096);
    // expectedSha256：整块与 patch 都核对（get_cell_listener 的 sha256 可直接用）
    const sha = getCellListener(p, 0, 0, { event: 'click' }).listeners[0].sha256;
    assert.throws(() => updateCellListener(p, 0, 0, { event: 'click', js: 'var x = 1;', expectedSha256: '0'.repeat(64) }), /sha 不符/);
    assert.throws(() => updateCellListener(p, 0, 0, { event: 'click', patchFind: 'tiny', patchReplace: 'small', expectedSha256: '0'.repeat(64) }), /sha 不符/);
    r = updateCellListener(p, 0, 0, { event: 'click', patchFind: 'tiny', patchReplace: 'small', expectedSha256: sha });
    assert.equal(r.patchHits, 1);
    // 校验：js 与 patchFind 二选一必给；互斥
    assert.throws(() => updateCellListener(p, 0, 0, { event: 'click', js: 'var x=1;', patchFind: 'a' }), /不能同时传 js/);
    assert.throws(() => updateCellListener(p, 0, 0, { event: 'click' }), /js 不能为空/);
    assert.equal(errs(p).length, 0);
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

// ===================== A4：add_cell_listener 只增语义保持 =====================

test('A4 add_cell_listener：保持只增（不加 patchFind），返回 before=0/after 度量并指路 update_cell_listener', () => {
  const d = tmp();
  try {
    const p = path.join(d, 'add.cpt');
    createCpt(p, { rows: 3, columns: 3 });
    addCell(p, { column: 0, row: 0, content: '格' });
    const r = setCellListener(p, 0, 0, { event: 'click', js: 'var a = 1;' });
    assert.equal(r.mode, 'insert');
    assert.equal(r.jsBytesBefore, 0, '只增：没有旧块，before 记 0');
    assert.equal(r.jsLinesBefore, 0);
    assert.equal(r.jsBytesAfter, bytes('var a = 1;'));
    assert.equal(r.jsLinesAfter, 1);
    // 同 event 已存在 → 仍报错引导改/删专用工具（绝不覆盖）
    assert.throws(() => setCellListener(p, 0, 0, { event: 'click', js: 'var b = 2;' }), /update_cell_listener/);
    assert.ok(read(p).includes('var a = 1;') && !read(p).includes('var b = 2;'));
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

// ===================== A6：片段替换参数预检 =====================

test('A6 参数预检：patchReplace 必配 patchFind、空 patchFind 不静默退化成整块/删除', () => {
  const d = tmp();
  try {
    const p = path.join(d, 'v.cpt');
    createCpt(p, { rows: 3, columns: 3, webWrite: true });
    setReportJs(p, { js: 'var a = 1;' });
    addToolbarButton(p, { buttonText: 'B', js: 'var a = 1;' });
    addCell(p, { column: 0, row: 0, content: '格' });
    setCellListener(p, 0, 0, { event: 'click', js: 'var a = 1;' });
    const before = read(p);
    // 只传 patchReplace：若静默走整块写入/删除，会误改模板 → 必须明确报错
    assert.throws(() => setReportJs(p, { patchReplace: 'x();' }), /必须配合非空 patchFind/);
    assert.throws(() => setToolbarButtonJs(p, { buttonText: 'B', patchReplace: 'x();' }), /必须配合非空 patchFind/);
    assert.throws(() => updateCellListener(p, 0, 0, { event: 'click', patchReplace: 'x();' }), /必须配合非空 patchFind/);
    assert.throws(() => setReportListener(p, { event: 'afterload', patchReplace: 'x();' }), /必须配合非空 patchFind/);
    assert.throws(() => setWebWriteJs(p, { event: 'afterload', patchReplace: 'x();' }), /必须配合非空 patchFind/);
    // 空 patchFind：等同未传，同样拒绝（不得退化成删除）
    assert.throws(() => setReportJs(p, { patchFind: '', js: null }), /patchFind 不能为空/);
    assert.throws(() => setToolbarButtonJs(p, { buttonText: 'B', patchFind: '', js: null }), /patchFind 不能为空/);
    assert.throws(() => updateCellListener(p, 0, 0, { event: 'click', patchFind: '' }), /patchFind 不能为空/);
    assert.equal(read(p), before, '预检失败必须不写文件');
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

// ===================== MCP 协议层：schema 与工具描述 =====================

let client = null;
before(async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(__dirname, '..', 'server.js')],
    cwd: path.join(__dirname, '..'),
    env: { CPT_MCP_TOOL_PROFILE: 'full' },
  });
  client = new Client({ name: 'cpt-mcp-js-patch', version: '0.0.1' });
  await client.connect(transport);
});

after(async () => {
  if (client) { try { await client.close(); } catch { /* 已断开 */ } client = null; }
});

test('MCP schema：5 个 JS 写工具暴露 patch/护栏/sha 参数；update_cell_listener 的 js 改为可选', async () => {
  const { tools } = await client.listTools();
  const must = ['patchFind', 'patchReplace', 'patchAll', 'allowShrink', 'expectedSha256'];
  for (const name of ['set_report_js', 'set_toolbar_button_js', 'update_cell_listener', 'set_webwrite_js', 'set_report_listener']) {
    const t = tools.find((x) => x.name === name);
    assert.ok(t, `${name} 应存在`);
    for (const key of must) assert.ok(t.inputSchema?.properties?.[key], `${name} 应暴露 ${key}`);
    assert.match(t.description, /patchFind/, `${name} 描述应说明支持片段替换`);
    assert.match(t.description, /allowShrink/, `${name} 描述应说明缩水护栏开关`);
  }
  const ut = tools.find((x) => x.name === 'update_cell_listener');
  assert.ok(!(ut.inputSchema.required || []).includes('js'), 'update_cell_listener 的 js 必须可选（patch 模式不传 js）');
  // add_cell_listener 只增：不塞无意义 patch 参数，但描述要指路
  const al = tools.find((x) => x.name === 'add_cell_listener');
  assert.ok(!al.inputSchema?.properties?.patchFind, 'add_cell_listener 不应有 patchFind（只增语义，无旧块可改）');
  assert.match(al.description, /update_cell_listener/);
  assert.match(al.description, /patchFind/);
  // 读侧：list_toolbar_buttons 描述说明给 jsBytes/sha256（expectedSha256 的自卫来源）
  const lt = tools.find((x) => x.name === 'list_toolbar_buttons');
  assert.match(lt.description, /sha256/);
});

async function call(tool, args) {
  const res = await client.callTool({ name: tool, arguments: args });
  const text = res.content?.find((c) => c.type === 'text')?.text ?? '';
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  return { res, data, text };
}

test('MCP 端到端：set_report_js / update_cell_listener 的 patch 参数经协议生效（含 `]A` 与安全围栏）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-jspatch-mcp-'));
  const p = path.join(dir, 'e2e.cpt');
  createCpt(p, { rows: 3, columns: 3 });
  try {
    // ① set_report_js 整块写入（新建 mode=replace）→ 净 patchFind 命中 `]A`
    const seed = await call('set_report_js', { path: p, js: 'var arr = data[0]A;\nvar keep = 1;', allowUnsafeScript: true });
    assert.equal(seed.res.isError, undefined, `写入失败: ${seed.text.slice(0, 200)}`);
    assert.equal(seed.data.mode, 'replace');
    // ② 不带 allowUnsafeScript 的 patchReplace 被安全围栏拒绝
    const noAuth = await call('set_report_js', { path: p, patchFind: 'keep = 1', patchReplace: 'keep = 2' });
    assert.equal(noAuth.res.isError, true, 'patchReplace 属可执行 JS，必须过 allowUnsafeScript');
    assert.match(noAuth.text, /allowUnsafeScript/);
    // ③ 授权后 patch 成功（`]` 净文本命中 `]A` 原文）
    const ok = await call('set_report_js', { path: p, patchFind: 'data[0]', patchReplace: 'data[1]', allowUnsafeScript: true });
    assert.equal(ok.res.isError, undefined, `patch 失败: ${ok.text.slice(0, 200)}`);
    assert.equal(ok.data.mode, 'patch');
    assert.equal(ok.data.patchHits, 1);
    assert.equal(ok.data.patchMatchedBy, 'designer-decoded');
    assert.ok(fs.readFileSync(p, 'utf8').includes('data[1]A'));
    // ④ update_cell_listener：不传 js、只传 patchFind（js 在 schema 里已改为可选）
    addCell(p, { column: 0, row: 0, content: '格' });
    const add = await call('add_cell_listener', { path: p, column: 0, row: 0, event: 'click', js: 'var a = 1;\nvar b = 2;', allowUnsafeScript: true });
    assert.equal(add.res.isError, undefined, `add_cell_listener 失败: ${add.text.slice(0, 200)}`);
    const up = await call('update_cell_listener', { path: p, column: 0, row: 0, event: 'click', patchFind: 'b = 2', patchReplace: 'b = 3', allowUnsafeScript: true });
    assert.equal(up.res.isError, undefined, `update patch 失败: ${up.text.slice(0, 200)}`);
    assert.equal(up.data.mode, 'patch');
    assert.equal(up.data.patchHits, 1);
    // ⑤ 缩水护栏经协议拒绝（错误文本指路 allowShrink）
    await call('set_report_js', { path: p, js: bigJs(2600, 'MCP'), allowUnsafeScript: true, allowShrink: true });
    const bad = await call('set_report_js', { path: p, js: 'var tiny = 1;', allowUnsafeScript: true });
    assert.equal(bad.res.isError, true, '大块整块缩水应被拒绝');
    assert.match(bad.text, /拒绝整块替换/);
    assert.match(bad.text, /allowShrink/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('批量 patch 的 patchReplace 同样受 allowUnsafeScript 围栏（与单工具口径一致）', () => {
  assert.throws(
    () => runToolGuards('update_cell_listener_batch', { items: [{ patch: { patchReplace: 'x();' } }] }),
    /allowUnsafeScript/,
  );
  assert.doesNotThrow(() => runToolGuards('update_cell_listener_batch', { items: [{ patch: { patchReplace: 'x();' } }], allowUnsafeScript: true }));
  // 空 patchReplace = 删除片段，不是可执行 JS → 不要求开关
  assert.doesNotThrow(() => runToolGuards('update_cell_listener_batch', { items: [{ patch: { patchReplace: '' } }] }));
  // expectedSha256/allowShrink 不是 JS 载荷
  assert.doesNotThrow(() => runToolGuards('update_cell_listener', { patchFind: 'a', allowShrink: true }));
  assert.throws(() => runToolGuards('set_report_js', { patchFind: 'a', patchReplace: 'x();' }), /allowUnsafeScript/);
});
