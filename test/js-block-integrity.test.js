import '../scripts/isolate-store.mjs';
// test/js-block-integrity.test.js —— F1 JS 块读写自卫：读侧 jsLength+sha256、分段分页、写侧 expectedSha256
//
// 背景：读侧 get_webwrite_js/get_report_listener/get_cell_listener 回裸 js 无长度无 hash，
// 桥接层截断出 Omitted 标记后模型据残块重写丢行而门禁全绿。本文件回归：
// ① 读侧每项带 jsLength（字符数）+ sha256（hex，对 CDATA 原文）；
// ② jsOffset/jsLimit 字符分页（默认全量），分页拼接==原文；越界/负数抛错，空返回不报错；
// ③ 写侧 expectedSha256：对上可写、对不上拒绝且文件不动；不传则老行为不变。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createCpt, addCell } from '../lib/generate.js';
import { reportListener, webwriteListener } from '../lib/cpt.js';
import { setReportListener, setWebWriteJs, setCellListener, getCellListener, updateCellListener } from '../lib/edits.js';

const sha = (s) => createHash('sha256').update(String(s), 'utf8').digest('hex');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-jsinteg-'));
const fileSha = (p) => sha(fs.readFileSync(p, 'utf8'));

const JS_A = 'function rowCalc(){ var total = 0; for (var i = 0; i < 10; i++) { total += i; } return total; }\nrowCalc();';
const JS_B = 'function rowCalc(){ return 42; }';

test('report 读带 jsLength+sha256 且长度自洽', () => {
  const d = tmp(); const p = path.join(d, 'r.cpt');
  createCpt(p, { rows: 3, columns: 3 });
  setReportListener(p, { event: 'afterload', js: JS_A, sheet: 0 });
  const r = reportListener(p, { event: 'afterload' });
  assert.equal(r.count, 1);
  const l = r.listeners[0];
  assert.equal(l.js, JS_A);
  assert.equal(l.jsLength, JS_A.length, 'jsLength 为原文字符数');
  assert.equal(l.sha256, sha(JS_A), 'sha256 对 CDATA 原文');
  fs.rmSync(d, { recursive: true, force: true });
});

test('webwrite 读带 jsLength+sha256 且长度自洽', () => {
  const d = tmp(); const p = path.join(d, 'w.cpt');
  createCpt(p, { rows: 3, columns: 3, webWrite: true });
  setWebWriteJs(p, { event: 'afterappend', js: JS_A });
  const r = webwriteListener(p, { event: 'afterappend' });
  assert.equal(r.count, 1);
  const l = r.listeners[0];
  assert.equal(l.js, JS_A);
  assert.equal(l.jsLength, JS_A.length);
  assert.equal(l.sha256, sha(JS_A));
  fs.rmSync(d, { recursive: true, force: true });
});

test('cell 读带 jsLength+sha256 且长度自洽', () => {
  const d = tmp(); const p = path.join(d, 'c.cpt');
  createCpt(p, { rows: 3, columns: 3 });
  addCell(p, { column: 0, row: 0, content: 'X' });
  setCellListener(p, 0, 0, { event: 'click', js: JS_A });
  const r = getCellListener(p, 0, 0, { event: 'click' });
  assert.equal(r.count, 1);
  const l = r.listeners[0];
  assert.equal(l.js, JS_A);
  assert.equal(l.jsLength, JS_A.length);
  assert.equal(l.sha256, sha(JS_A));
  fs.rmSync(d, { recursive: true, force: true });
});

test('分页切片拼接==原文（report/webwrite/cell，含字符串数字）', () => {
  const d = tmp(); const p = path.join(d, 'pg.cpt');
  createCpt(p, { rows: 3, columns: 3, webWrite: true });
  addCell(p, { column: 0, row: 0, content: 'X' });
  setReportListener(p, { event: 'afterload', js: JS_A, sheet: 0 });
  setWebWriteJs(p, { event: 'afterappend', js: JS_A });
  setCellListener(p, 0, 0, { event: 'click', js: JS_A });
  const readers = [
    (o) => reportListener(p, { event: 'afterload', ...o }).listeners[0],
    (o) => webwriteListener(p, { event: 'afterappend', ...o }).listeners[0],
    (o) => getCellListener(p, 0, 0, { event: 'click', ...o }).listeners[0],
  ];
  for (const read of readers) {
    const full = read({}).js;
    assert.equal(full, JS_A, '默认全量');
    const a = read({ jsOffset: 0, jsLimit: 10 }).js;
    const b = read({ jsOffset: 10, jsLimit: 10 }).js;
    const c = read({ jsOffset: 20 }).js;
    assert.equal(a + b + c, JS_A, '分段拼接==原文');
    assert.equal(read({ jsOffset: '10', jsLimit: '10' }).js, JS_A.slice(10, 20), '字符串数字同样放行');
    assert.equal(read({ jsOffset: JS_A.length }).js, '', 'offset==全文长度 → 空串不报错');
    assert.equal(read({ jsLimit: 0 }).js, '', 'limit=0 → 空串不报错');
    assert.equal(read({}).jsLength, JS_A.length, '分页不改变 jsLength（恒指全文）');
    assert.equal(read({ jsOffset: 5, jsLimit: 5 }).sha256, sha(JS_A), '分页不改变 sha256（恒指全文）');
    assert.throws(() => read({ jsOffset: JS_A.length + 1 }), /越界/, 'offset 越界抛错');
    assert.throws(() => read({ jsOffset: -1 }), /非法/, '负数 offset 抛错');
    assert.throws(() => read({ jsLimit: -1 }), /非法/, '负数 limit 抛错');
  }
  fs.rmSync(d, { recursive: true, force: true });
});

test('report 写侧：expectedSha 对上可写、对不上拒绝且文件不动、不传照常过', () => {
  const d = tmp(); const p = path.join(d, 'rw.cpt');
  createCpt(p, { rows: 3, columns: 3 });
  setReportListener(p, { event: 'afterload', js: JS_A, sheet: 0 });
  const good = sha(JS_A);
  // 对上可写
  setReportListener(p, { event: 'afterload', js: JS_B, sheet: 0, expectedSha256: good });
  assert.equal(reportListener(p, { event: 'afterload' }).listeners[0].js, JS_B);
  // 对不上拒绝且文件不动
  const before = fileSha(p);
  assert.throws(() => setReportListener(p, { event: 'afterload', js: 'evil();', sheet: 0, expectedSha256: '0'.repeat(64) }), /sha 不符/);
  assert.equal(fileSha(p), before, '拒绝后文件未动');
  assert.equal(reportListener(p, { event: 'afterload' }).listeners[0].js, JS_B, '原块内容不变');
  // 删带错 sha 同样拒绝
  assert.throws(() => setReportListener(p, { event: 'afterload', sheet: 0, expectedSha256: 'f'.repeat(64) }), /sha 不符/);
  assert.equal(reportListener(p, { event: 'afterload' }).count, 1, '块仍在');
  // 不传 expectedSha256 老调用照常过
  setReportListener(p, { event: 'afterload', js: JS_A, sheet: 0 });
  assert.equal(reportListener(p, { event: 'afterload' }).listeners[0].js, JS_A);
  fs.rmSync(d, { recursive: true, force: true });
});

test('webwrite 写侧：expectedSha 对上可写（含 match 路径）、对不上拒绝且文件不动', () => {
  const d = tmp(); const p = path.join(d, 'ww.cpt');
  createCpt(p, { rows: 3, columns: 3, webWrite: true });
  setWebWriteJs(p, { event: 'afterappend', js: JS_A });
  const good = sha(JS_A);
  // match 路径对上可写
  setWebWriteJs(p, { event: 'afterappend', js: JS_B, match: 'rowCalc', expectedSha256: good });
  assert.equal(webwriteListener(p, { event: 'afterappend' }).listeners[0].js, JS_B);
  // 对不上拒绝且文件不动
  const before = fileSha(p);
  assert.throws(() => setWebWriteJs(p, { event: 'afterappend', js: 'evil();', match: 'rowCalc', expectedSha256: '0'.repeat(64) }), /sha 不符/);
  assert.equal(fileSha(p), before, '拒绝后文件未动');
  // aggregate 与 expectedSha256 拒绝联用
  assert.throws(() => setWebWriteJs(p, { event: 'afterappend', js: JS_B, aggregate: true, expectedSha256: good }), /aggregate/);
  // 不传 expectedSha256 老调用照常过
  setWebWriteJs(p, { event: 'afterappend', js: JS_A, match: 'rowCalc' });
  assert.equal(webwriteListener(p, { event: 'afterappend' }).listeners[0].js, JS_A);
  fs.rmSync(d, { recursive: true, force: true });
});

test('cell 写侧：expectedSha 对上可写、对不上拒绝且文件不动、不传照常过', () => {
  const d = tmp(); const p = path.join(d, 'cu.cpt');
  createCpt(p, { rows: 3, columns: 3 });
  addCell(p, { column: 0, row: 0, content: 'X' });
  setCellListener(p, 0, 0, { event: 'click', js: JS_A });
  const good = getCellListener(p, 0, 0, { event: 'click' }).listeners[0].sha256;
  assert.equal(good, sha(JS_A));
  updateCellListener(p, 0, 0, { event: 'click', js: JS_B, expectedSha256: good });
  assert.equal(getCellListener(p, 0, 0, { event: 'click' }).listeners[0].js, JS_B);
  const before = fileSha(p);
  assert.throws(() => updateCellListener(p, 0, 0, { event: 'click', js: 'evil();', expectedSha256: '0'.repeat(64) }), /sha 不符/);
  assert.equal(fileSha(p), before, '拒绝后文件未动');
  assert.equal(getCellListener(p, 0, 0, { event: 'click' }).listeners[0].js, JS_B, '原块内容不变');
  updateCellListener(p, 0, 0, { event: 'click', js: JS_A });
  assert.equal(getCellListener(p, 0, 0, { event: 'click' }).listeners[0].js, JS_A);
  fs.rmSync(d, { recursive: true, force: true });
});

test('report 写侧：expectedSha 与 aggregate 拒绝联用、无块时拒绝新建', () => {
  const d = tmp(); const p = path.join(d, 'ra.cpt');
  createCpt(p, { rows: 3, columns: 3 });
  setReportListener(p, { event: 'afterload', js: JS_A, sheet: 0 });
  assert.throws(() => setReportListener(p, { event: 'afterload', js: JS_B, sheet: 0, aggregate: true, expectedSha256: sha(JS_A) }), /aggregate/);
  assert.throws(() => setReportListener(p, { event: 'nope', js: JS_B, sheet: 0, expectedSha256: '0'.repeat(64) }), /无从核对/);
  fs.rmSync(d, { recursive: true, force: true });
});
