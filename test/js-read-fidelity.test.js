// test/js-read-fidelity.test.js —— JS 读回保真 + FR 转义 `]A` 的正确口径
//
// 【M116 全面更正】本文件早期版本把代码位 `]A` 当"污染"，要求 cells 打 jsSuspicious、
// read_cpt_compact 出 jsAlert。**那个前提是错的**：`]A` 是 FR 设计器对 `]` 的落盘转义。
// 全量官方语料（reportlets 1550 份 / 337 个非空 JS 块）实测：
//   · 含 `]A` 的模板 915 份；官方 JS 里 `]` 共 237 个，**100% 写成 `]A`**；
//   · 原文喂 V8 → 55 块失败；解码 `]A`→`]` 后喂 V8 → **0 块失败**。
// 旧检测器越"灵敏"越说明判据不成立（"官方也中招"本该推翻前提，而不是给检测器找台阶）。
//
// 现在的两条口径（互不冲突）：
//   ① **读回**保持原文所见即所得 —— 出参要能与文件逐字节对账，解码不得污染读值；
//   ② **判定**（check_report_js / validate 的 JS 语法）必须先解码再喂 V8。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createCpt, addCell } from '../lib/generate.js';
import { setCellListener, setReportJs } from '../lib/edits.js';
import { cells, checkReportJs, hasSuspiciousJsResidue, decodeFrJsForParse } from '../lib/cpt.js';
import { readCptCompact } from '../lib/read-gate.js';
import { validateCpt } from '../lib/validate.js';
import '../scripts/isolate-store.mjs'; // M123：JS 基线 store 隔离，直跑也不污染真实 store

delete process.env.CPT_MCP_ALLOWED_ROOTS;

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-jsfidelity-'));
// 含 XML 实体敏感字符 + 字符串内 ]A：若读侧做反转义/转义，字节必对不上
const RICH_JS = 'var s = "]A"; if (a < b && c > d) { toast("x\'y\\"z&<ok>"); }';

test('M116 读回保真：写入的 JS 读回字节一致（非转义伪影），且落盘为 CDATA 原文', () => {
  const d = tmp();
  const p = path.join(d, 'a.cpt');
  createCpt(p, { rows: 3, columns: 3 });
  addCell(p, { column: 0, row: 0, content: 'A' });
  setCellListener(p, 0, 0, { event: 'click', js: RICH_JS });
  setReportJs(p, { js: RICH_JS, sheet: 0 });

  const c = cells(p).find((x) => x.column === 0 && x.row === 0);
  const li = c.listeners.find((l) => l.event === 'click');
  assert.equal(li.js, RICH_JS, '单元格监听 JS 必须原文读回');
  assert.equal(Object.hasOwn(li, 'jsSuspicious'), false, 'M116：jsSuspicious 字段已移除（]A 不是缺陷信号）');

  const chk = checkReportJs(p);
  assert.equal(chk.failed, 0, `合法 JS 不得判错：${JSON.stringify(chk.failures)}`);
  const raw = fs.readFileSync(p, 'utf8');
  assert.ok(raw.includes(`<![CDATA[${RICH_JS}]]>`), 'TopJS 应以 CDATA 原文落盘');
  fs.rmSync(d, { recursive: true, force: true });
});

test('M116 官方形态：`]A` 是 FR 对 `]` 的转义 —— 解码后是合法 JS，不得判语法错', () => {
  const d = tmp();
  const p = path.join(d, 'fr-escape.cpt');
  createCpt(p, { rows: 3, columns: 3 });
  addCell(p, { column: 1, row: 0, content: 'B' });
  // 官方最常见形态：`F.COLS[si]A` 实为 `F.COLS[si]`
  const FR_JS = 'var C = F.COLS[si]A;\nvar ks = []A;\nfor (var i = 0; i < rows.length; i++) { ks.push(rows[i]A); }';
  setCellListener(p, 1, 0, { event: 'click', js: FR_JS });
  setReportJs(p, { js: FR_JS, sheet: 0 });

  // ① 读回仍是原文（对账口径不变）
  const c = cells(p).find((x) => x.column === 1 && x.row === 0);
  assert.equal(c.listeners[0].js, FR_JS, '读回保持原文（文件对账需要）');

  // ② 解码函数把 ]A 还原为 ]
  assert.equal(decodeFrJsForParse(FR_JS), FR_JS.split(']A').join(']'));
  assert.ok(decodeFrJsForParse(FR_JS).includes('F.COLS[si];'), '解码后应是正常下标取值');

  // ③ 语法检查（解码口径）必须全过 —— 这是 M116 的核心修复点
  const chk = checkReportJs(p);
  assert.equal(chk.failed, 0, `FR 转义形态不得判语法错：${JSON.stringify(chk.failures)}`);

  // ④ validate 也不得再报 JS 语法 warning
  const w = validateCpt(p).filter((i) => i.severity === 'warning' && /JS语法/.test(i.location));
  assert.equal(w.length, 0, `validate 不得报 JS 语法 warning：${JSON.stringify(w)}`);

  // ⑤ 过时检测器已失效（恒 false），读侧不再挂 jsAlert
  assert.equal(hasSuspiciousJsResidue('goNext(]A);'), false, 'M116：]A 不再是残字信号');
  const r = readCptCompact(p, { view: 'cells', detail: 'standard' });
  assert.equal(r.jsAlert ?? null, null, '读侧不得再出"可疑残字"提示');
  fs.rmSync(d, { recursive: true, force: true });
});

test('M116 真语法错误仍必须被抓到（解码不吞掉真缺陷）', () => {
  const d = tmp();
  const p = path.join(d, 'broken.cpt');
  createCpt(p, { rows: 3, columns: 3 });
  addCell(p, { column: 0, row: 0, content: 'A' });
  // 真少一个 }：sandbox7 实测过的场景，必须仍报错
  setCellListener(p, 0, 0, { event: 'click', js: 'function f() {\n  var a = 1;\n' });
  const chk = checkReportJs(p);
  assert.equal(chk.failed, 1, '真语法错误必须仍被抓到');
  assert.ok(chk.failures[0].line >= 1, '必须带块内行号');

  // 含 ]A 的真错误：解码后仍应报错（证明解码不是"一律放行"）
  const p2 = path.join(d, 'broken2.cpt');
  createCpt(p2, { rows: 3, columns: 3 });
  addCell(p2, { column: 0, row: 0, content: 'A' });
  setCellListener(p2, 0, 0, { event: 'click', js: 'var a = []A;\nfunction f() {\n  var b = 1;\n' });
  assert.equal(checkReportJs(p2).failed, 1, '解码后仍缺 } 的必须报错');
  fs.rmSync(d, { recursive: true, force: true });
});

test('M116 干净模板：无 jsAlert（基线不变）', () => {
  const d = tmp();
  const p = path.join(d, 'ok.cpt');
  createCpt(p, { rows: 3, columns: 3 });
  addCell(p, { column: 0, row: 0, content: 'A' });
  setCellListener(p, 0, 0, { event: 'click', js: 'goNext();' });

  const c = cells(p).find((x) => x.column === 0 && x.row === 0);
  assert.equal(c.listeners[0].js, 'goNext();');

  const r = readCptCompact(p, { view: 'cells', detail: 'standard' });
  assert.equal(r.jsAlert ?? null, null, '干净模板不得多出提示');
  const summary = readCptCompact(p, { view: 'cells', detail: 'summary' });
  assert.equal(summary.jsAlert ?? null, null, 'summary 口径（无JS正文）不得多出提示');
  fs.rmSync(d, { recursive: true, force: true });
});
