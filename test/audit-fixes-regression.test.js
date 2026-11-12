// cpt-mcp/test/audit-fixes-regression.test.js —— P0/P1/P2 审核修复回归锁定（t4）
// 三类：A批量补偿（非原子+补偿指引）/ B deliveryPass三字段文案 / C 关键整数混淆矩阵 + deep-tools耗次文案
// 只做锁定断言，不改任何实现语义。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createCpt } from '../lib/generate.js';
import { datasets } from '../lib/cpt.js';
import { addDatasetBatch } from '../lib/batch.js';
import { qualityGate } from '../lib/quality.js';
import { CPT_MCP_INSTRUCTIONS } from '../lib/contract.js';
import { capabilityManifest } from '../lib/capabilities.js';
import { assertCriticalIntParams } from '../lib/security.js';
import '../scripts/isolate-store.mjs'; // M123：JS 基线 store 隔离，直跑也不污染真实 store

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-audit-reg-'));
  const cpt = path.join(dir, 'reg.cpt');
  createCpt(cpt, { rows: 4, columns: 4 });
  return { dir, cpt };
}

// ============ A. 批量补偿（非原子） ============
test('A1·批量非原子：部分成功保留、失败记failed（补偿前提）', async () => {
  const { dir, cpt } = fixture();
  try {
    const r = await addDatasetBatch(cpt, [
      { name: 'ds1', connection: 'Doris', sql: 'select 1' },
      { name: 'ds1', connection: 'Doris', sql: 'select 2' }, // 重名 → failed
      { name: 'ds2', connection: 'Doris', sql: 'select 3' },
    ]);
    assert.equal(r.summary.total, 3);
    assert.equal(r.summary.inserted, 2);
    assert.equal(r.summary.failed, 1);
    assert.equal(r.results[1].status, 'failed');
    assert.match(String(r.results[1].error || ''), /.+/);
    // 已成功项落盘保留（非原子语义：不回滚）
    assert.deepEqual(datasets(cpt).map((d) => d.name).sort(), ['ds1', 'ds2']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('A2·批量非原子文案锁定：contract§七/batch头/batch_mutate引导', () => {
  assert.match(CPT_MCP_INSTRUCTIONS, /非原子/, 'contract 应声明 *_batch 非原子');
  assert.match(CPT_MCP_INSTRUCTIONS, /batch_mutate_cells/, 'contract 应引导单元格原子走 batch_mutate_cells');
  assert.match(CPT_MCP_INSTRUCTIONS, /plan.*apply/i, 'contract 应提及 plan→apply 两阶段');
  const batchHead = fs.readFileSync(new URL('../lib/batch.js', import.meta.url), 'utf8');
  assert.match(batchHead, /非原子/, 'lib/batch.js 头应声明非原子');
  assert.match(batchHead, /batch_mutate_cells/, 'lib/batch.js 头应引导 batch_mutate_cells');
  const serverSrc = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  assert.match(serverSrc, /与 \*_batch 非原子逐项执行不同/, 'batch_mutate_cells 描述应与 *_batch 非原子区分');
});

// ============ B. deliveryPass 三字段文案 ============
test('B1·deliveryPass语义：结构通过≠可交付（引擎未跑时deliveryPass=false）', () => {
  const { dir, cpt } = fixture();
  try {
    const gate = qualityGate(cpt);
    assert.equal(gate.pass, true, `骨架模板应结构通过：${JSON.stringify(gate.blockers)}`);
    assert.equal(gate.blockers.length, 0);
    assert.match(String(gate.note || ''), /deliveryPass/, 'gate note 应含 deliveryPass 口径');
    assert.match(String(gate.note || ''), /三字段/, 'gate note 应声明三字段并列');
    // 复刻 server.js quality_gate_cpt 的映射（structuralPass 镜像 blockers 为空；deliveryPass=pass&&engine pass）
    const structuralPass = (gate.blockers?.length ?? 0) === 0;
    const deliveryPass = gate.pass === true && gate.engineCheck?.status === 'pass';
    assert.equal(structuralPass, true);
    assert.notEqual(gate.engineCheck.status, 'pass', '引擎未通过时 status 不应为 pass');
    assert.equal(deliveryPass, false, '引擎未跑/不可用时 deliveryPass 必须为 false（仅结构通过不可交付）');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('B2·deliveryPass文案锁定：contract铁律/server描述/capabilities/README', () => {
  assert.match(CPT_MCP_INSTRUCTIONS, /structuralPass/, 'contract 铁律应含 structuralPass');
  assert.match(CPT_MCP_INSTRUCTIONS, /deliveryPass/, 'contract 铁律应含 deliveryPass');
  assert.match(CPT_MCP_INSTRUCTIONS, /不要混用/, 'contract 应强调三字段不要混用');
  const serverSrc = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  assert.match(serverSrc, /pass\/structuralPass\/deliveryPass 三字段并列/, 'server quality_gate 描述应三字段并列');
  assert.match(serverSrc, /deliveryPass=true.*才可交付/, 'server 描述应声明 deliveryPass=true 才可交付');
  const manifest = capabilityManifest();
  assert.match(String(manifest.workflow?.deliveryGate || ''), /deliveryPass/, 'capabilities deliveryGate 应含 deliveryPass');
  const readme = fs.readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  assert.match(readme, /deliveryPass/, 'README 应含 deliveryPass 口径');
});

// ============ C. 关键整数混淆矩阵（P2-1） + deep-tools耗次文案（P2-2） ============
test('C1·混淆矩阵顶层：空串/布尔拒，数字/纯数字串放行', () => {
  // 拒绝：空串（含空白）、布尔
  for (const bad of ['', '   ', true, false]) {
    assert.throws(() => assertCriticalIntParams('add_cell', { column: bad, row: 0 }), /不接受/, `column=${JSON.stringify(bad)} 应拒`);
    assert.throws(() => assertCriticalIntParams('add_cell', { column: 0, row: bad }), /不接受/, `row=${JSON.stringify(bad)} 应拒`);
  }
  // 放行：数字 0/正整数、纯数字字符串
  for (const good of [0, 1, 12, '0', '3', '12']) {
    assert.doesNotThrow(() => assertCriticalIntParams('add_cell', { column: good, row: good }), `column/row=${JSON.stringify(good)} 应放行`);
  }
  // 非关键字段不受影响
  assert.doesNotThrow(() => assertCriticalIntParams('add_cell', { content: '', styleIndex: '' }));
});

test('C2·混淆矩阵嵌套：items/targets/target.target 直通路径同样拦截', () => {
  assert.throws(() => assertCriticalIntParams('add_dataset_batch', { items: [{ column: '' }] }), /不接受/);
  assert.throws(() => assertCriticalIntParams('delete_cell_batch', { targets: [{ column: true, row: 0 }] }), /不接受/);
  assert.throws(() => assertCriticalIntParams('update_cell_batch', { items: [{ target: { column: 0, row: '' } }] }), /不接受/);
  assert.throws(() => assertCriticalIntParams('update_cell_batch', { items: [{ target: { column: false, row: 0 } }] }), /不接受/);
  // 嵌套合法值放行
  assert.doesNotThrow(() => assertCriticalIntParams('update_cell_batch', { items: [{ target: { column: 0, row: '1' } }] }));
  assert.doesNotThrow(() => assertCriticalIntParams('add_dataset_batch', { items: [{ name: 'ds1' }] }));
});

test('C3·deep-tools被拒耗次文案锁定：4处拒绝均声明凭据已消耗', () => {
  const src = fs.readFileSync(new URL('../lib/deep-tools.js', import.meta.url), 'utf8');
  assert.match(src, /failureId 与当前 CPT 路径不匹配.*一次性凭据，本次请求已将其消耗/, '路径不匹配拒绝应声明消耗一次性 failureId');
  assert.match(src, /多个或不明确的单元格.*本次被拒已将其消耗/, '多格拒绝应声明消耗一次性 failureId');
  // 次数型租约（20 次额度）：越权/表不一致各扣 1 次额度，文案必须如实声明已扣次
  assert.match(src, /禁止用于其他单元格或批量循环.*已消耗 1 次额度/, '越权单元格拒绝应声明已消耗 1 次额度');
  assert.match(src, /工作表与调用参数不一致.*已消耗 1 次额度/, '工作表不一致拒绝应声明已消耗 1 次额度');
});
