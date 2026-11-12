// test/fr-js-escape.test.js —— M116 FR 设计器 JS 转义 `]A` 的口径定案
//
// 这是本轮最重要的"证据固化"测试：把"`]A` 是设计器转义、不是污染"这一结论钉在官方全量语料上。
// 若将来有人（或某次重构）又把 `]A` 当残字、或把解码从判定路径里去掉，本测试会立刻变红。
//
// 背景（为什么值得单独一个文件）：
//   M83 起 check_report_js 不解码 `]A`，于是对含 `]A` 的文件一律报 `Unexpected identifier 'A'`。
//   t7/t8 期间发现**官方样本也报错 41 份**，当时的结论是"官方样本自身含代码位 ]A 污染，
//   但设计器能打开（V8 比 FR 设计器严格）"，于是把 validate 的级别从 error 降成 warning 收场。
//   这个归因是错的、而且危害不小：
//     · `]A` 实为 **FR 设计器对 `]` 的落盘转义**；官方 237 个 `]` 100% 都写成 `]A`；
//     · "官方也中招"本该推翻"它是污染"的前提，却被用来给检测器找台阶（检测器越灵敏越可疑）；
//     · 代价是真实的：sabndbox4/V3 文件被报 25 个 A 警告，差点被当成真问题去"修 25 块 JS"，
//       而**去修反而会把设计器的转义改坏**（把 `]A` 改成 `]` 会让设计器读成别的语义）。
//   教训（已写进 lib/cpt.js 的注释）：**检测器在权威语料上大面积报错时，先怀疑检测器**。
//
// 官方语料实测（本测试固化，需要本机 FR 安装才跑；缺失则跳过而非失败）：
//   模板 1550 份 ｜ 含 `]A` 的 915 份 ｜ 有非空 JS 块的 337 个块
//   官方 JS 里 `]` 共 237 个 —— 写成 `]A` 的 **237 个（100%）**
//   原文喂 V8 → 55 块失败 ｜ 解码后喂 V8 → **0 块失败**
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';

import { createCpt, addCell } from '../lib/generate.js';
import { setCellListener } from '../lib/edits.js';
import { checkReportJs, decodeFrJsForParse, jsBlocks } from '../lib/cpt.js';
import { load } from '../lib/xml.js';
import '../scripts/isolate-store.mjs'; // M123：JS 基线 store 隔离，直跑也不污染真实 store

const FR_ROOT = process.env.FR_HOME
  ? path.join(process.env.FR_HOME, 'webapps/webroot/WEB-INF/reportlets')
  : 'D:/FineReport_11.0/webapps/webroot/WEB-INF/reportlets';

const parseOk = (code) => {
  try { new vm.Script(code); return true; } catch { /* fallthrough */ }
  try { new vm.Script(`(function(){\n${code}\n})`); return true; } catch { return false; }
};
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-frjs-'));

test('M116 单元：decodeFrJsForParse 只还原 `]A`→`]`，不影响其它字节', () => {
  assert.equal(decodeFrJsForParse('F.COLS[si]A;'), 'F.COLS[si];');
  assert.equal(decodeFrJsForParse('var a = []A;'), 'var a = [];');
  assert.equal(decodeFrJsForParse('m[1]A + m[2]A'), 'm[1] + m[2]');
  // 不含 ]A 的原样返回
  assert.equal(decodeFrJsForParse('var a = [1,2];'), 'var a = [1,2];');
  // 非字符串安全
  assert.equal(decodeFrJsForParse(null), null);
  assert.equal(decodeFrJsForParse(undefined), undefined);
  // 字符串字面量里的 ]A 也一并还原（设计器的转义是全局的，不区分代码位/字面量）
  assert.equal(decodeFrJsForParse('console.log("[x]A")'), 'console.log("[x]")');
});

test('M116 回归：不解码就会把 FR 官方形态判成语法错（证明解码是必需的）', () => {
  const FR = 'var C = F.COLS[si]A;\nvar ks = []A;\nvar Y = Number(m[1]A);';
  // 原文（不解码）—— 必然是语法错误，报错形态就是 Unexpected identifier 'A'
  assert.equal(parseOk(FR), false, '未解码的 FR 形态喂 V8 必失败');
  let err = '';
  try { new vm.Script(FR); } catch (e) { err = String(e.message); }
  assert.match(err, /Unexpected identifier 'A'/, '复现 check_report_js 报的错');
  // 解码后 —— 必须通过
  assert.equal(parseOk(decodeFrJsForParse(FR)), true, '解码后必须是合法 JS');
});

test('M116 端到端：含 FR 转义的模板 check_report_js 全过、validate 无 JS warning', async () => {
  const d = tmp();
  const p = path.join(d, 'esc.cpt');
  createCpt(p, { rows: 3, columns: 3 });
  addCell(p, { column: 0, row: 0, content: 'A' });
  setCellListener(p, 0, 0, {
    event: 'click',
    js: 'var C = F.COLS[si]A;\nvar ks = []A;\nfor (var i = 0; i < rows.length; i++) { ks.push(rows[i]A); }',
  });
  const r = checkReportJs(p);
  assert.equal(r.failed, 0, `FR 转义不得判错：${JSON.stringify(r.failures)}`);
  const { validateCpt } = await import('../lib/validate.js');
  const w = validateCpt(p).filter((i) => i.severity === 'warning' && /JS语法/.test(i.location));
  assert.equal(w.length, 0, 'validate 不得再报 JS 语法 warning');
  fs.rmSync(d, { recursive: true, force: true });
});

test('M116 官方语料实证：`]A` 是转义（官方 `]` 100% 写成 `]A`，解码后 0 失败）', { skip: !fs.existsSync(FR_ROOT) }, () => {
  const walk = (dir, out = []) => {
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
    for (const e of ents) {
      const q = path.join(dir, e.name);
      if (e.isDirectory()) walk(q, out);
      else if (e.name.toLowerCase().endsWith('.cpt')) out.push(q);
    }
    return out;
  };
  const all = walk(FR_ROOT);
  assert.ok(all.length > 1000, `官方语料应 >1000 份，实际 ${all.length}（FR_ROOT=${FR_ROOT}）`);

  let withA = 0, brTotal = 0, brA = 0, blocks = 0, rawFail = 0, decFail = 0;
  for (const f of all) {
    let t = '';
    try { t = fs.readFileSync(f, 'utf8'); } catch { continue; }
    if (t.includes(']A')) withA++;
    let parsed;
    try { parsed = load(f).parsed; } catch { continue; }
    for (const b of jsBlocks(parsed)) {
      if (!b.code.trim()) continue;
      blocks++;
      for (let i = 0; i < b.code.length; i++) {
        if (b.code[i] === ']') { brTotal++; if (b.code[i + 1] === 'A') brA++; }
      }
      if (!parseOk(b.code)) rawFail++;
      if (!parseOk(decodeFrJsForParse(b.code))) decFail++;
    }
  }

  // ① 官方确实广泛使用该形态
  assert.ok(withA > 500, `含 ]A 的官方模板应 >500 份，实际 ${withA}`);
  // ② 官方每一个 `]` 都是 `]A` 形态 —— 这是"它是转义而非偶发污染"的铁证
  assert.equal(brA, brTotal, `官方 JS 的 ${brTotal} 个 ] 应当 100% 写成 ]A，实际 ${brA}`);
  assert.ok(brTotal > 100, `样本应收敛到足够多的 ] 才具说服力，实际 ${brTotal}`);
  // ③ 不解码必大面积失败
  assert.ok(rawFail > 0, `不解码时应能复现假阳性，实际 rawFail=${rawFail}`);
  // ④ 解码后必须 0 失败 —— 这条一旦变红就说明解码路径被破坏
  assert.equal(decFail, 0, `解码后官方样本必须 0 失败（块数 ${blocks}）`);

  console.log(`  [M116 实证] 官方 ${all.length} 份｜含 ]A ${withA} 份｜JS 块 ${blocks} 个｜`
    + `] 共 ${brTotal} 个全为 ]A 形态｜原文失败 ${rawFail} 块 → 解码后 ${decFail} 块`);
});
