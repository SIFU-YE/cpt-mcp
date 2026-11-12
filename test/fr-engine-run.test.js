// test/fr-engine-run.test.js —— run_fr_engine_check（触发性 verify:fr）输入校验与优雅降级
//
// 不实际跑真实 FR 引擎（依赖本机 FineReport + 编译，慢且环境相关）；这里覆盖确定性分支：
//   - 输入校验（不存在 / 路径围栏 / batch 空 / roundTrip 不存在）
//   - 环境缺失优雅降级（missing-tool，不抛错）
// 真实引擎路径已在开发机验证（ecj 编译 → 加载 → 报告落盘 → fr_engine_check 复查 pass）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCpt } from '../lib/generate.js';
import { runFrEngineCheck } from '../lib/fr-engine-run.js';
import '../scripts/isolate-store.mjs'; // M123：JS 基线 store 隔离，直跑也不污染真实 store

const tmp = () => {
  // 显式放行测试临时目录，避免会话级 CPT_MCP_ALLOWED_ROOTS 覆盖默认根（否则 tmp 不在允许根被拒）
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-frrun-t-'));
  process.env.CPT_MCP_ALLOWED_ROOTS = [process.env.CPT_MCP_ALLOWED_ROOTS, d].filter(Boolean).join(path.delimiter);
  return d;
};

test('run_fr_engine_check：输入校验（不存在/越界/batch空/roundTrip不存在）', async () => {
  const d = tmp();
  const p = path.join(d, 'a.cpt');
  createCpt(p, { rows: 3, columns: 3 });
  // 不存在
  const no = await runFrEngineCheck(path.join(d, 'nope.cpt'));
  assert.equal(no.status, 'bad-input');
  // 越界路径（System32）
  const sys = path.join(path.parse(process.cwd()).root, 'Windows', 'System32', 'x.cpt');
  await assert.rejects(() => runFrEngineCheck(sys), /安全围栏/);
  // batch 空数组 → bad-input
  const empty = await runFrEngineCheck(p, { batch: [] });
  assert.equal(empty.status, 'bad-input');
  // batch 里含不存在
  const badBatch = await runFrEngineCheck(p, { batch: [p, path.join(d, 'nope2.cpt')] });
  assert.equal(badBatch.status, 'bad-input');
  fs.rmSync(d, { recursive: true, force: true });
});

test('run_fr_engine_check：roundTrip 与输入同路径 → 早期拒绝（防源模板被导出覆写）', async () => {
  // 回归背景（2026-09-27 实际事故）：roundTrip 传成与 path 相同路径时，旧版探针把引擎
  // 导出结果直接写回源 .cpt，FR writer 丢 WorkBook 级 TopJS 块（sandbox4 售价跟随补丁整块丢失）。
  // 修复后：服务端早期拒绝 + 探针导出走临时文件 + verify 脚本 spawn 前后 sha256 比对。
  const d = tmp();
  const p = path.join(d, 'a.cpt');
  createCpt(p, { rows: 3, columns: 3 });
  const same = await runFrEngineCheck(p, { roundTrip: p });
  assert.equal(same.status, 'bad-input');
  assert.match(same.hint, /与输入模板相同/);
  fs.rmSync(d, { recursive: true, force: true });
});

test('run_fr_engine_check：环境缺失优雅降级（missing-tool，不抛错）', async (t) => {
  const d = tmp();
  const p = path.join(d, 'a.cpt');
  createCpt(p, { rows: 3, columns: 3 });
  const { detectFrHome } = await import('../lib/fr-decompile.js');
  if (detectFrHome().frHome) {
    // 本机有 FR：真实引擎路径（ecj 编译→加载→报告→复查 pass）已在开发机验证，这里不重复跑引擎（慢且环境相关）
    return t.skip('本机有 FineReport：真实 verify:fr 路径已在开发机端到端验证（ecj 编译→加载→报告→fr_engine_check pass）');
  }
  const r = await runFrEngineCheck(p);
  assert.equal(r.status, 'missing-tool');
  assert.ok(r.hint.length > 0, 'missing-tool 应带指引');
  fs.rmSync(d, { recursive: true, force: true });
});