// test/event-naming.test.js —— M94 事件唯一性 + 命名规范
//
// 背景：6 个 V3 模板的 WebWriteContent 各挂 2~4 个 afterload（填报3/审批4/汇总2），
// 改错块/写回污染后只能人肉二分；另需防 Σ 类特殊字符进入命名（标识符 error，注释 warning），
// 版本标记统一英文前缀+数字可带小数（v3.7/F12/t8 合法，日期时间戳不在此限）。
// 口径：①②→✓✗ 等注释排版符号祖父豁免（存量上百处，全拦则告警淹没信号）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCpt } from '../lib/generate.js';
import { setWebWriteJs, setReportListener } from '../lib/edits.js';
import { validateCpt } from '../lib/validate.js';
import { checkReportJs, duplicateEventGroups, reportListener } from '../lib/cpt.js';
import '../scripts/isolate-store.mjs'; // M123：JS 基线 store 隔离，直跑也不污染真实 store

delete process.env.CPT_MCP_ALLOWED_ROOTS;

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-m94-'));
const of = (issues, re) => issues.filter((i) => re.test(`${i.severity}|${i.location}|${i.message}`));

function webwriteFixture() {
  const d = tmp();
  const p = path.join(d, 'x.cpt');
  createCpt(p, { rows: 2, columns: 2, webWrite: true });
  setWebWriteJs(p, { event: 'afterload', js: 'var keep = 1;' });
  return { d, p };
}
/** 文本级复制首个 afterload 块，模拟存量多份代码（与 V3 模板同构） */
function duplicateFirstAfterload(p) {
  const raw = fs.readFileSync(p, 'utf8');
  const m = raw.match(/<Listener\s+event="afterload"[^>]*>[\s\S]*?<\/Listener>/);
  assert.ok(m, '应先有 1 个 afterload');
  const at = raw.indexOf(m[0]) + m[0].length;
  fs.writeFileSync(p, raw.slice(0, at) + '\n' + m[0].replace('var keep = 1;', 'var second = 2;') + raw.slice(at));
}

test('M94 事件唯一：WebWrite 同事件多份 → warning，fix 给合并路径', () => {
  const { d, p } = webwriteFixture();
  assert.equal(of(validateCpt(p), /事件唯一/).length, 0, '单份时不告警');
  duplicateFirstAfterload(p);
  const warns = of(validateCpt(p), /事件唯一/);
  assert.equal(warns.length, 1, `应报1条去重 warning：${JSON.stringify(warns)}`);
  assert.equal(warns[0].severity, 'warning');
  assert.match(warns[0].location, /afterload×2/);
  assert.match(warns[0].fix, /aggregate|合并/);
  assert.equal(validateCpt(p).filter((i) => i.severity === 'error').length, 0, 'warning 不阻断');
  fs.rmSync(d, { recursive: true, force: true });
});

test('M94 事件唯一：报表级分表不误报，同表重复才报', () => {
  const d = tmp();
  const p = path.join(d, 'x.cpt');
  createCpt(p, { rows: 2, columns: 2 });
  setReportListener(p, { event: 'afterload', js: 'var s0 = 1;', sheet: 0 });
  assert.equal(of(validateCpt(p), /事件唯一/).length, 0, '单表单份不告警');
  fs.rmSync(d, { recursive: true, force: true });
});

test('M94 命名：Σ 进标识符 error，进注释 warning；坏版本标记 warning', () => {
  const d = tmp();
  const p = path.join(d, 'x.cpt');
  createCpt(p, { rows: 2, columns: 2, webWrite: true });
  setWebWriteJs(p, { event: 'afterload', js: '// v★3 规格Σ合计\nvar okΣ = 1;\nvar v37 = 1;' });
  const issues = validateCpt(p);
  const errs = of(issues, /^error\|命名/);
  assert.equal(errs.length, 1, `标识符 Σ 应 error：${JSON.stringify(errs)}`);
  assert.match(errs[0].message, /okΣ/);
  const warns = of(issues, /^warning\|命名/);
  assert.ok(warns.some((w) => /希腊字母/.test(w.message)), '注释 Σ 应 warning');
  assert.ok(warns.some((w) => /v★3/.test(w.message)), '坏版本标记应 warning');
  fs.rmSync(d, { recursive: true, force: true });
});

test('M94 命名：合法标记零告警（v3.7/F12/t8补丁/日期/排版符号豁免）', () => {
  const d = tmp();
  const p = path.join(d, 'x.cpt');
  createCpt(p, { rows: 2, columns: 2, webWrite: true });
  setWebWriteJs(p, { event: 'afterload', js: '// v3.7 F12 t8补丁 2026-09-24：① 初始化 → 校验 ✓\nvar total = 1;' });
  const issues = of(validateCpt(p), /命名/);
  assert.deepEqual(issues, [], `合法内容应零命名告警：${JSON.stringify(issues)}`);
  fs.rmSync(d, { recursive: true, force: true });
});

test('M99-D2 WebPageContent 独立容器：读扫查全可见，去重不跨容器合并', () => {
  const d = tmp();
  const p = path.join(d, 'x.cpt');
  createCpt(p, { rows: 2, columns: 2 });
  setReportListener(p, { event: 'afterload', js: 'var r = 1;', sheet: 0 });
  // 仿三审批实证形态：Report 直属 <WebPageContent><Listener event="afterload">
  const raw = fs.readFileSync(p, 'utf8');
  const wpc = `<WebPageContent><Listener event="afterload"><JavaScript class="com.fr.js.JavaScriptImpl"><Parameters/><Content><![CDATA[var w = 2;]]></Content></JavaScript></Listener></WebPageContent>`;
  assert.ok(raw.includes('</Report>'), '应有 Report 块');
  fs.writeFileSync(p, raw.replace('</Report>', `${wpc}</Report>`));
  // 读：两块都可见且 area 区分
  const rl = reportListener(p, { event: 'afterload' });
  assert.equal(rl.count, 2, `报表+分页应各见1块：${JSON.stringify(rl.listeners.map((l) => l.area))}`);
  assert.deepEqual(rl.listeners.map((l) => l.area).sort(), ['report', 'webpage']);
  // 扫：check 覆盖分页块定位
  const chk = checkReportJs(p);
  assert.ok(chk.failures.length === 0);
  assert.ok(chk.blocks >= 2);
  // 去重：不同容器不触发合并要求（绝不能并入合并）
  const dups = duplicateEventGroups(p);
  assert.deepEqual(dups, [], `跨容器 afterload 不得要求合并：${JSON.stringify(dups)}`);
  // 同容器重复仍告警（容器内唯一性不受影响）
  const raw2 = fs.readFileSync(p, 'utf8');
  const m = raw2.match(/<Listener\s+event="afterload"[^>]*>[\s\S]*?<\/Listener>/);
  const at = raw2.indexOf(m[0]) + m[0].length;
  fs.writeFileSync(p, raw2.slice(0, at) + '\n' + m[0] + raw2.slice(at));
  const dups2 = duplicateEventGroups(p);
  assert.equal(dups2.length, 1, '同容器重复仍应上榜');
  assert.match(dups2[0].container, /报表事件/);
  fs.rmSync(d, { recursive: true, force: true });
});
