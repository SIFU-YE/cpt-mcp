// test/js-baseline-reset.test.js —— C-C：JS 基线复位开关（不再逼模型去删 AppData 文件）
//
// 【缺陷证据·2026-11-03 11:49:45 sandbox16 会话 session-b9ea67ca】写坏块后重做，门禁按旧基线报
// "JS 块数较基线减少"blocker；模型试图 `delete_file %LOCALAPPDATA%\cpt-mcp\js-baseline\<sha>.json`
// 被"路径在工作区外"拒绝，只能 git_rollback + 重写块绕行。基线是 MCP 自有缓存，应给显式开关：
//   · validate_cpt / quality_gate_cpt 新增可选参数 resetJsBaseline:true（默认 false）；
//   · 只删**本模板**的 per-key 条目后按当前文件重建（不同模板物理隔离，不误伤其他模板）；
//   · 返回 baselineReset:true + baselineResetInfo（旧计数 previous / 新计数 current）；
//   · 默认路径语义不变：不传时丢失告警照旧拦截。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createCpt } from '../lib/generate.js';
import { setReportJs, setWebWriteJs } from '../lib/edits.js';
import { validateCpt } from '../lib/validate.js';
import { qualityGate } from '../lib/quality.js';
import { checkJsBaseline, recordJsBaseline, resetJsBaseline, baselineStorePath } from '../lib/js-baseline.js';
import { load } from '../lib/xml.js';
import '../scripts/isolate-store.mjs';

function freshStore(t) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-jsbl-reset-'));
  t.after(() => { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } });
  process.env.CPT_MCP_JS_BASELINE = path.join(d, 'js-baseline.json');
  process.env.CPT_MCP_ALLOWED_ROOTS = [process.env.CPT_MCP_ALLOWED_ROOTS, d].filter(Boolean).join(path.delimiter);
  return { d, store: process.env.CPT_MCP_JS_BASELINE };
}

const uniq = (tag) => path.join(os.tmpdir(), `cpt-jsbl-reset-${tag}-${process.pid}-${Date.now()}.cpt`);
const read = (p) => fs.readFileSync(p, 'utf8');

/** 造一个 2 块模板（TopJS + 填报事件），并经 cpt-mcp 写入通道落基线 */
function seedTracked(p) {
  createCpt(p, { rows: 3, columns: 3, webWrite: true });
  setReportJs(p, { js: 'var a = 1;', sheet: 0 });
  setWebWriteJs(p, { event: 'afterload', js: 'var b = 2;' });
  recordJsBaseline(p); // 确定性基线（topjs:sheet1 1 + wbweb 1 = 2）
}

/** 模拟"外部有意删块"：直接改文件移除 TopJS（不经 cpt-mcp 写入通道，基线不刷新） */
function dropTopJs(p) {
  const raw = read(p);
  const lost = raw.replace(/<TopJS><!\[CDATA\[var a = 1;\]\]><\/TopJS>/, '');
  assert.notEqual(lost, raw, '测试夹具应确实移除了 TopJS');
  fs.writeFileSync(p, lost, 'utf8');
}

test('C-C resetJsBaseline：删本模板条目→按当前文件重建，旧计数摘要正确，不误伤其他模板', (t) => {
  freshStore(t);
  const p1 = uniq('a'); const p2 = uniq('b');
  try {
    seedTracked(p1);
    seedTracked(p2);
    // 两个模板各有独立 per-key 条目
    assert.equal(checkJsBaseline(p1, load(p1).parsed).known, true);
    assert.equal(checkJsBaseline(p2, load(p2).parsed).known, true);
    dropTopJs(p1);
    // 复位前：默认语义仍是"丢块 → error"
    const err = validateCpt(p1).find((i) => i.location === 'JS块基线' && i.severity === 'error');
    assert.ok(err, '丢块应先被拦截（复位不改变默认语义）');
    assert.match(err.fix, /resetJsBaseline/, 'error.fix 应给出复位路径（模型可见的可执行闭环）');

    const info = resetJsBaseline(p1);
    assert.equal(info.reset, true);
    assert.equal(info.hadBaseline, true);
    assert.equal(info.previous.total, 2, `旧计数摘要应为 2：${JSON.stringify(info.previous)}`);
    assert.equal(info.previous.byCat['topjs:sheet1'], 1);
    assert.equal(info.current.total, 1, '复位后基线=当前文件');
    assert.match(info.hint, /仅在本模板 JS 块确实是有意删减/);

    // 复位后：不再报丢块
    assert.ok(!validateCpt(p1).some((i) => i.location === 'JS块基线' && i.severity === 'error'), '复位后不应再报丢块');
    // 其他模板条目未被误伤
    const b2 = checkJsBaseline(p2, load(p2).parsed);
    assert.equal(b2.known, true, '其他模板基线仍在');
    assert.equal(b2.loss, false, '其他模板不受影响');
    assert.equal(b2.current.total, 2);
    // store 是 per-key 目录形态：至少两个条目文件
    const entries = fs.readdirSync(baselineStorePath()).filter((f) => f.endsWith('.json'));
    assert.ok(entries.length >= 2, `两个模板应有各自条目：${entries.join(',')}`);
  } finally {
    fs.rmSync(p1, { force: true });
    fs.rmSync(p2, { force: true });
  }
});

test('C-C resetJsBaseline：无基线时调用也重建（hadBaseline=false，不抛错）', (t) => {
  freshStore(t);
  const p = uniq('fresh');
  const p2 = uniq('never');
  try {
    createCpt(p, { rows: 3, columns: 3, webWrite: true });
    setReportJs(p, { js: 'var a = 1;', sheet: 0 });
    // 先清掉写盘钩子建立的条目，模拟"基线缺失"
    const info0 = resetJsBaseline(p);
    assert.equal(info0.hadBaseline, true, '写盘通道已建基线');
    // 再用一个从未 validate 过的路径
    fs.copyFileSync(p, p2);
    const info = resetJsBaseline(p2);
    assert.equal(info.hadBaseline, false, '首次路径无基线');
    assert.equal(info.previous, null);
    assert.equal(info.current.total, 1);
    assert.equal(checkJsBaseline(p2, load(p2).parsed).known, true, '复位后基线已建立');
  } finally {
    fs.rmSync(p, { force: true });
    fs.rmSync(p2, { force: true });
  }
});

test('C-C qualityGate({resetJsBaseline:true})：默认仍拦截，显式复位后放行并带旧计数', (t) => {
  freshStore(t);
  const p = uniq('gate');
  try {
    seedTracked(p);
    dropTopJs(p);
    // 默认：基线丢块进 blockers
    const before = qualityGate(p);
    assert.ok(before.blockers.some((b) => /JS 块数较基线减少/.test(b.message)), '默认调用必须仍拦截丢块');
    assert.equal(Object.hasOwn(before, 'baselineReset'), false, '未传参数时返回体不出现 baselineReset');
    // 显式复位：先复位再校验，所以本轮不再出现丢块 blocker
    const after = qualityGate(p, { resetJsBaseline: true });
    assert.equal(after.baselineReset, true);
    assert.equal(after.baselineResetInfo.hadBaseline, true);
    assert.equal(after.baselineResetInfo.previous.total, 2);
    assert.equal(after.baselineResetInfo.current.total, 1);
    assert.ok(!after.blockers.some((b) => /JS 块数较基线减少/.test(b.message)), `复位后不应再报丢块：${JSON.stringify(after.blockers.map((b) => b.message))}`);
    assert.equal(after.pass, true, '复位后结构门槛应通过（无其他 blocker）');
  } finally {
    fs.rmSync(p, { force: true });
  }
});

test('C-C MCP 端到端：validate_cpt/quality_gate_cpt 接受 resetJsBaseline（默认不出字段、复位后带旧计数）', async (t) => {
  const { d } = freshStore(t);
  const p1 = path.join(d, 'e2e-validate.cpt');
  const p2 = path.join(d, 'e2e-gate.cpt');
  triggerResetFixtures(p1, p2);

  const client = new Client({ name: 'jsbl-reset-test', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath, args: ['server.js'], cwd: process.cwd(), stderr: 'pipe',
    env: { CPT_MCP_TOOL_PROFILE: 'report', CPT_MCP_ALLOWED_ROOTS: [os.tmpdir(), d].join(path.delimiter) },
  });
  await client.connect(transport);
  const call = async (name, args) => {
    const r = await client.callTool({ name, arguments: args });
    const text = r.content?.[0]?.text ?? '';
    let data = null; try { data = JSON.parse(text); } catch { /* 非 JSON 报错文案 */ }
    return { isError: r.isError === true, text, data };
  };
  try {
    // ① 默认调用：丢块 error 仍在，返回体无 baselineReset
    const plain = await call('validate_cpt', { path: p1 });
    assert.equal(plain.isError, false, plain.text.slice(0, 200));
    assert.equal(Object.hasOwn(plain.data, 'baselineReset'), false, '默认（未传参）返回体不应出现 baselineReset');
    assert.ok(plain.data.issues.some((i) => i.location === 'JS块基线' && i.severity === 'error'), '默认仍拦截丢块');

    // ② resetJsBaseline=true：复位 + 带旧计数摘要，本轮不再报丢块
    const reset = await call('validate_cpt', { path: p1, resetJsBaseline: true });
    assert.equal(reset.isError, false, reset.text.slice(0, 300));
    assert.equal(reset.data.baselineReset, true);
    assert.equal(reset.data.baselineResetInfo.previous.total, 2);
    assert.equal(reset.data.baselineResetInfo.current.total, 1);
    assert.ok(!reset.data.issues.some((i) => i.location === 'JS块基线' && i.severity === 'error'), '复位后本轮不应报丢块');
    // 再跑一次：基线已按当前文件重建，稳定不再报
    const again = await call('validate_cpt', { path: p1 });
    assert.ok(!again.data.issues.some((i) => i.location === 'JS块基线' && i.severity === 'error'), '复位后重跑仍应稳定');

    // ③ quality_gate_cpt 同一开关
    const gateReset = await call('quality_gate_cpt', { path: p2, resetJsBaseline: true, localSqlAudit: false });
    assert.equal(gateReset.isError, false, gateReset.text.slice(0, 300));
    assert.equal(gateReset.data.baselineReset, true);
    assert.equal(gateReset.data.baselineResetInfo.previous.total, 2);
  } finally {
    await client.close();
  }
});

/** 端到端夹具：两个模板都建过基线后各删一个块（模拟"外部有意删块"） */
function triggerResetFixtures(p1, p2) {
  seedTracked(p1);
  seedTracked(p2);
  dropTopJs(p1);
  dropTopJs(p2);
}
