// test/js-syntax-gate.test.js —— P0 V2-F12：validate/gate 纳入 JS 语法检查
//
// 背景：validate_cpt / quality_gate_cpt 至今不解析 JS，已提交的语法污染仍全绿。
// 修法：validate 复用 check_report_js 的 V8 扫描逻辑，失败块报 warning 并给 fix；
// quality_gate 经 gatherIssues 进入 advisory（可闭环，不阻断）。
// 【t8 口径修正】必须 warning 而非 error：V8 比 FR 设计器严格，官方样本自身含代码位
// ]A 污染但设计器可打开（t7 实证 review:gate 1509/1550），error 会误杀官方基线。
// 约束：官方 1550 基线不变 —— warning 只针对真语法错误，字符串内 "]A" 不得上报。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createCpt } from '../lib/generate.js';
import { setReportJs, setToolbarButtonJs, addToolbarButton, setFillToolbar } from '../lib/edits.js';
import { validateCpt } from '../lib/validate.js';
import { qualityGate } from '../lib/quality.js';
import { checkReportJs } from '../lib/cpt.js';
import { generateReport } from '../lib/engine/index.js';
import '../scripts/isolate-store.mjs'; // M123：JS 基线 store 隔离，直跑也不污染真实 store

delete process.env.CPT_MCP_ALLOWED_ROOTS;

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-jssyntax-'));

// sandbox7 真实事故形态：try 块没闭合，catch 落单（V8 两次解析都失败）
const BROKEN = 'if (jobs.length > 5) { try { if (x) { toast("批量计算"); } catch (e0) { } }';

test('P0-1 坏JS：validate 报 warning（非 error），gate advisory 带可执行 fix 且不阻断', () => {
  const d = tmp();
  const p = path.join(d, 'bad.cpt');
  createCpt(p, { rows: 3, columns: 3 });
  setReportJs(p, { js: BROKEN, sheet: 0 });

  // 对照：check_report_js 本身能拦
  const chk = checkReportJs(p);
  assert.equal(chk.failed, 1, `check 应报1错：${JSON.stringify(chk.failures)}`);

  // validate 新增 JS 语法节：warning 可见，不进 error（t8 保基线）
  const issues = validateCpt(p);
  const jsWarns = issues.filter((i) => i.severity === 'warning' && /JS 语法错误/.test(i.message));
  assert.equal(jsWarns.length, 1, `validate 应报1个JS warning：${JSON.stringify(issues)}`);
  assert.equal(issues.filter((i) => i.severity === 'error' && /JS 语法错误/.test(i.message)).length, 0, '不得报 error');
  assert.match(jsWarns[0].location, /JS语法/);
  assert.match(jsWarns[0].fix, /check_report_js/);

  // gate：warning 进 advisory 可闭环，不阻断 pass
  const gate = qualityGate(p);
  assert.equal(gate.pass, true, 'warning 级别不阻断交付');
  assert.equal(gate.blockers.filter((b) => /JS 语法错误/.test(b.message)).length, 0, '不得进 blocker');
  const adv = gate.advisories.filter((a) => /JS 语法错误/.test(a.message));
  assert.equal(adv.length, 1, `gate advisory 应含JS项：${JSON.stringify(gate.advisories)}`);
  assert.ok(adv[0].fix && /set_report_js|check_report_js/.test(adv[0].fix), 'advisory 带可执行修复指引');
  fs.rmSync(d, { recursive: true, force: true });
});

test('P0-1 工具栏坏JS（上报任务管理V3形态）：validate 报 warning', () => {
  const d = tmp();
  const p = path.join(d, 'toolbar-bad.cpt');
  createCpt(p, { rows: 3, columns: 3, webWrite: true });
  setFillToolbar(p);
  addToolbarButton(p, { buttonText: '批量计算' });
  setToolbarButtonJs(p, { buttonText: '批量计算', js: BROKEN });

  const issues = validateCpt(p);
  const jsWarns = issues.filter((i) => i.severity === 'warning' && /JS 语法错误/.test(i.message));
  assert.equal(jsWarns.length, 1, `工具栏坏JS应被validate警示：${JSON.stringify(issues)}`);
  assert.match(jsWarns[0].location, /工具栏/);
  assert.equal(qualityGate(p).pass, true, 'warning 不阻断 gate');
  fs.rmSync(d, { recursive: true, force: true });
});

test('P0-1 字符串内 "]A" 不得上报（1550基线保护）', () => {
  const d = tmp();
  const p = path.join(d, 'strok.cpt');
  createCpt(p, { rows: 3, columns: 3 });
  // "]A" 仅出现在字符串字面量内，V8 解析合法
  setReportJs(p, { js: 'var s = "]A"; var t = "a]A b"; toast(s + t);', sheet: 0 });

  const chk = checkReportJs(p);
  assert.equal(chk.failed, 0, `字符串内]A不得判错：${JSON.stringify(chk.failures)}`);
  const issues = validateCpt(p);
  assert.equal(
    issues.filter((i) => /JS 语法错误/.test(i.message)).length,
    0,
    '字符串内]A不得上报（任何级别）',
  );
  fs.rmSync(d, { recursive: true, force: true });
});

test('P0-1 好模板与成品模板基线不变：无JS / 合法JS 零上报，gate 照常 pass', () => {
  const d = tmp();
  // 无 JS 的骨架 + 合法 JS
  const p1 = path.join(d, 'ok.cpt');
  createCpt(p1, { rows: 3, columns: 3 });
  setReportJs(p1, { js: 'contentPane.setPage(1);', sheet: 0 });
  assert.equal(
    validateCpt(p1).filter((i) => /JS 语法错误/.test(i.message)).length,
    0,
  );

  // generateReport 成品模板（无 JS）：不得因新增检查多出上报
  const p2 = path.join(d, 'good.cpt');
  generateReport({
    path: p2,
    title: '月度销售',
    source: { connection: 'Doris', table: 'sales' },
    fields: [
      { name: 'region', label: '地区' },
      { name: 'amount', label: '金额', type: 'money' },
    ],
  });
  const goodIssues = validateCpt(p2);
  assert.equal(
    goodIssues.filter((i) => /JS 语法错误/.test(i.message)).length,
    0,
    '成品模板不得新增JS上报',
  );
  assert.equal(qualityGate(p2).pass, true, `成品模板 gate 应照常过：${JSON.stringify(qualityGate(p2).blockers)}`);
  fs.rmSync(d, { recursive: true, force: true });
});

test('P0-1 空JS块跳过不报错', () => {
  const d = tmp();
  const p = path.join(d, 'empty.cpt');
  createCpt(p, { rows: 3, columns: 3 });
  setReportJs(p, { js: '   ', sheet: 0 });
  const chk = checkReportJs(p);
  assert.equal(chk.failed, 0);
  assert.equal(
    validateCpt(p).filter((i) => /JS 语法错误/.test(i.message)).length,
    0,
  );
  fs.rmSync(d, { recursive: true, force: true });
});
