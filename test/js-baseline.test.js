// test/js-baseline.test.js —— M120 JS 块数基线：拦截「整块丢失」
//
// 背景（2026-09-27 实际事故）：run_fr_engine_check 旧探针把引擎导出覆写回源 .cpt，
// FR writer 丢 WorkBook 级 TopJS 整块（sandbox4/V3「售价跟随规格」150 行），
// validate/quality_gate 均不盘点块数基线，全绿放行。本测试锁死：
//   t1 经 cpt-mcp 写入的文件 save 时已建基线 → validate 不误报
//   t2 外部新建文件首见 → info 建立基线（一次）
//   t3 外部覆写丢块 → validate error；基线保持，重跑持续报
//   t4 无丢失的增长 → 静默刷新基线不报（cpt-mcp 写入通道经 save 钩子自动跟进）
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCpt } from '../lib/generate.js';
import { setReportJs, setWebWriteJs } from '../lib/edits.js';
import { validateCpt } from '../lib/validate.js';
import { checkJsBaseline, recordJsBaseline, baselineStorePath } from '../lib/js-baseline.js';
import { load } from '../lib/xml.js';
import '../scripts/isolate-store.mjs'; // M123：JS 基线 store 隔离，直跑也不污染真实 store

function freshStore(t) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-jsbl-t-'));
  t.after(() => { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } });
  const store = path.join(d, 'js-baseline.json');
  process.env.CPT_MCP_JS_BASELINE = store;
  // 允许路径围栏放行 tmp 目录（与其他测试同口径）
  process.env.CPT_MCP_ALLOWED_ROOTS = [process.env.CPT_MCP_ALLOWED_ROOTS, d].filter(Boolean).join(path.delimiter);
  return { d, store };
}

test('js-baseline：cpt-mcp 写入的文件 save 即建基线，validate 不误报', (t) => {
  freshStore(t);
  const p = path.join(os.tmpdir(), `cpt-jsbl-a-${process.pid}-${Date.now()}.cpt`);
  createCpt(p, { rows: 3, columns: 3, webWrite: true });
  setReportJs(p, { js: 'var a = 1;', sheet: 0 });

  const v = validateCpt(p);
  assert.ok(!v.some((i) => i.location === 'JS块基线' && i.severity === 'error'), '基线随 save 跟进，不应报丢失');
  assert.ok(!v.some((i) => i.location === 'JS块基线' && i.severity === 'info'), '基线已由 save 建立，validate 不应重报 info');
  assert.ok(fs.existsSync(baselineStorePath()), '基线库文件应已落盘');
  fs.rmSync(p, { force: true });
});

test('js-baseline：外部新建文件首见 → info 建立基线（一次）', (t) => {
  freshStore(t);
  const src = path.join(os.tmpdir(), `cpt-jsbl-src-${process.pid}-${Date.now()}.cpt`);
  createCpt(src, { rows: 3, columns: 3, webWrite: true });
  setReportJs(src, { js: 'var a = 1;', sheet: 0 });
  setWebWriteJs(src, { event: 'afterload', js: 'var b = 2;' });

  // 全新路径（基线库无记录）＝模拟外部已有模板首次进入 validate
  const p = path.join(os.tmpdir(), `cpt-jsbl-ext-${process.pid}-${Date.now()}.cpt`);
  fs.copyFileSync(src, p);
  const v1 = validateCpt(p);
  const info1 = v1.find((i) => i.location === 'JS块基线');
  assert.ok(info1, '首见应有基线 info');
  assert.equal(info1.severity, 'info');
  assert.match(info1.message, /已建立 JS 块基线（2 块）/);
  const v2 = validateCpt(p);
  assert.ok(!v2.some((i) => i.location === 'JS块基线'), '二跑不应再报');
  fs.rmSync(src, { force: true });
  fs.rmSync(p, { force: true });
});

test('js-baseline：外部覆写丢块 → validate error；基线保持，重跑持续报', (t) => {
  freshStore(t);
  const p = path.join(os.tmpdir(), `cpt-jsbl-b-${process.pid}-${Date.now()}.cpt`);
  createCpt(p, { rows: 3, columns: 3, webWrite: true });
  setReportJs(p, { js: 'var a = 1;', sheet: 0 });
  setWebWriteJs(p, { event: 'afterload', js: 'var b = 2;' });
  recordJsBaseline(p); // 确定性基线（TopJS 1 + wbweb 1）
  const base = checkJsBaseline(p, load(p).parsed);
  assert.equal(base.known, true);
  assert.equal(base.current.total, 2, '基线应为 2 块');

  // 模拟外部工具覆写：重写文件移除 TopJS 块（不经 cpt-mcp 通道）
  const raw = fs.readFileSync(p, 'utf8');
  const lost = raw.replace(/<TopJS><!\[CDATA\[var a = 1;\]\]><\/TopJS>/, '');
  assert.notEqual(lost, raw, '覆写应确实移除了 TopJS');
  fs.writeFileSync(p, lost, 'utf8');

  const v1 = validateCpt(p);
  const err = v1.find((i) => i.location === 'JS块基线' && i.severity === 'error');
  assert.ok(err, '丢块应报 error');
  assert.match(err.message, /较基线减少/);
  assert.match(err.message, /topjs:sheet1 基线1→现存0/);

  const v2 = validateCpt(p);
  assert.ok(v2.some((i) => i.location === 'JS块基线' && i.severity === 'error'), '基线未处置前重跑持续报');
  fs.rmSync(p, { force: true });
});

test('js-baseline：无丢失的增长 → 静默刷新基线不报', (t) => {
  freshStore(t);
  const p = path.join(os.tmpdir(), `cpt-jsbl-c-${process.pid}-${Date.now()}.cpt`);
  createCpt(p, { rows: 3, columns: 3, webWrite: true });
  setReportJs(p, { js: 'var a = 1;', sheet: 0 });
  validateCpt(p); // 基线 1 块
  setWebWriteJs(p, { event: 'beforesubmit', js: 'var c = 3;' }); // 经 cpt-mcp 加一块 → save 自动刷新
  const v = validateCpt(p);
  assert.ok(!v.some((i) => i.location === 'JS块基线' && i.severity === 'error'), '增长不是丢失，不应报');
  assert.ok(!v.some((i) => i.location === 'JS块基线' && i.severity === 'info'), '基线已存在，不应重报 info');
  const bl = checkJsBaseline(p, load(p).parsed);
  assert.equal(bl.current.total, 2, '基线应已刷新到 2 块');
  fs.rmSync(p, { force: true });
});
