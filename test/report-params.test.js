// test/report-params.test.js —— P1-1：报表级参数独立增改通道
//
// 背景（残留①）：add_parameter 补报表级 fine_username 报"参数名已存在"（数据集层同名
// 冲突，全文档 includes 误杀）。修法：数据集层（TableData>Parameters）与报表级
// （ReportParameterAttr 直接子级）读写分层，同名跨层合法、同层互斥。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createCpt, addDataset, setParameterPanel, addParameterWidget } from '../lib/generate.js';
import { addParameter, updateParameter, deleteParameter } from '../lib/edits.js';
import { addParameterBatch, updateParameterBatch, deleteParameterBatch, getParameterBatch } from '../lib/batch.js';
import { parameters } from '../lib/cpt.js';
import { validateCpt } from '../lib/validate.js';
import '../scripts/isolate-store.mjs'; // M123：JS 基线 store 隔离，直跑也不污染真实 store

delete process.env.CPT_MCP_ALLOWED_ROOTS;

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-reportparam-'));
const ofScope = (list, name, scope) => list.filter((p) => p.name === name && p.scope === scope);

test('P1-1 报障复现：数据集层同名时报表级仍可独立新增', () => {
  const d = tmp();
  const p = path.join(d, 'a.cpt');
  createCpt(p, { rows: 3, columns: 3 });
  addDataset(p, { name: 'ds1', connection: 'Doris', sql: 'SELECT * FROM t WHERE u = ${fine_username}', parameters: [{ name: 'fine_username', defaultValue: 'a' }] });
  setParameterPanel(p, { title: '参数' });

  const r = addParameter(p, 'fine_username', 'sys', 'report');
  assert.equal(r.scope, 'report');
  const list = parameters(p);
  assert.equal(ofScope(list, 'fine_username', 'dataset').length, 1, '数据集层保留');
  assert.equal(ofScope(list, 'fine_username', 'report').length, 1, '报表级新增');
  assert.equal(ofScope(list, 'fine_username', 'report')[0].defaultValue, 'sys');
  // 落盘形态：报表级直接子级位于 </ReportParameterAttr> 之前
  const raw = fs.readFileSync(p, 'utf8');
  const rpaEnd = raw.indexOf('</ReportParameterAttr>');
  const blk = raw.lastIndexOf('<Parameter>', rpaEnd);
  assert.ok(blk > raw.indexOf('</ParameterUI>'), '报表级 Parameter 应在 ParameterUI 之后');
  assert.ok(raw.slice(blk, rpaEnd).includes('<Attributes name="fine_username"/>'));
  assert.equal(validateCpt(p).filter((i) => i.severity === 'error').length, 0, '双层同名不得引入校验 error');
  fs.rmSync(d, { recursive: true, force: true });
});

test('P1-1 反向：报表级（控件绑定）存在时数据集层同名可新增', () => {
  const d = tmp();
  const p = path.join(d, 'b.cpt');
  createCpt(p, { rows: 3, columns: 3 });
  addDataset(p, { name: 'ds1', connection: 'Doris', sql: 'SELECT 1' });
  setParameterPanel(p, { title: '参数' });
  addParameterWidget(p, { name: 'kw', type: 'text' }); // 自动建报表级同名绑定
  assert.equal(ofScope(parameters(p), 'kw', 'report').length, 1);

  addParameter(p, 'kw', 'v'); // 默认 dataset，不再被报表级误杀
  assert.equal(ofScope(parameters(p), 'kw', 'dataset').length, 1);
  assert.equal(validateCpt(p).filter((i) => i.severity === 'error').length, 0);
  fs.rmSync(d, { recursive: true, force: true });
});

test('P1-1 同层重名仍拒绝，无面板时报表级引导建面板', () => {
  const d = tmp();
  const p = path.join(d, 'c.cpt');
  createCpt(p, { rows: 3, columns: 3 });
  addDataset(p, { name: 'ds1', connection: 'Doris', sql: 'SELECT 1', parameters: [{ name: 'a' }] });
  assert.throws(() => addParameter(p, 'a', 'x'), /数据集参数 "a" 已存在/, '同数据集层重名仍拒绝');
  // 无 ReportParameterAttr：报表级引导
  assert.throws(() => addParameter(p, 'b', 'x', 'report'), /set_parameter_panel/, '无面板时应引导先建面板');
  setParameterPanel(p, { title: '参数' });
  addParameter(p, 'b', 'x', 'report');
  assert.throws(() => addParameter(p, 'b', 'y', 'report'), /报表级参数 "b" 已存在/, '同报表级重名仍拒绝');
  assert.throws(() => addParameter(p, '!!!', 'y'), /非法/, '参数名校验保留');
  assert.throws(() => addParameter(p, 'c', 'y', 'nope'), /scope 非法/, 'scope 白名单');
  fs.rmSync(d, { recursive: true, force: true });
});

test('P1-1 改/删：auto 唯一自动定位，两层同名必须明确 scope', () => {
  const d = tmp();
  const p = path.join(d, 'd.cpt');
  createCpt(p, { rows: 3, columns: 3 });
  addDataset(p, { name: 'ds1', connection: 'Doris', sql: 'SELECT 1', parameters: [{ name: 'solo', defaultValue: '1' }] });
  setParameterPanel(p, { title: '参数' });

  // 跨层唯一：auto 直达报表级
  addParameter(p, 'r1', 'rv', 'report');
  updateParameter(p, 'r1', 'rv2'); // auto → report
  assert.equal(ofScope(parameters(p), 'r1', 'report')[0].defaultValue, 'rv2');
  updateParameter(p, 'solo', '2'); // auto → dataset（legacy 行为不变）
  assert.equal(ofScope(parameters(p), 'solo', 'dataset')[0].defaultValue, '2');

  // 两层同名：auto 改/删必须抛错明确
  addParameter(p, 'solo', 'r', 'report');
  assert.throws(() => updateParameter(p, 'solo', 'x'), /明确 scope/, '两层同名 auto 改应抛错');
  assert.throws(() => deleteParameter(p, 'solo'), /明确 scope/, '两层同名 auto 删应抛错');
  // 定层改值 + 改名（同层判重，跨层不拦）
  updateParameter(p, 'solo', 'dx', undefined, 'dataset');
  assert.equal(ofScope(parameters(p), 'solo', 'dataset')[0].defaultValue, 'dx');
  updateParameter(p, 'solo', undefined, 'solo2', 'report');
  assert.equal(ofScope(parameters(p), 'solo2', 'report').length, 1);
  assert.equal(ofScope(parameters(p), 'solo', 'report').length, 0);
  assert.throws(() => updateParameter(p, 'solo2', undefined, 'r1', 'report'), /已存在/, '同层改名判重');
  // 定层删除只动命中层
  deleteParameter(p, 'solo2', 'report');
  assert.equal(ofScope(parameters(p), 'solo2', 'report').length, 0);
  assert.equal(ofScope(parameters(p), 'solo', 'dataset').length, 1, '数据集层不受影响');
  assert.throws(() => deleteParameter(p, 'nope'), /未找到/, '不存在仍抛错');
  fs.rmSync(d, { recursive: true, force: true });
});

test('P1-1 dsName 定点多数据集 + 批量透传 scope', async () => {
  const d = tmp();
  const p = path.join(d, 'e.cpt');
  createCpt(p, { rows: 3, columns: 3 });
  addDataset(p, { name: 'ds1', connection: 'Doris', sql: 'SELECT 1', parameters: [{ name: 'k' }] });
  addDataset(p, { name: 'ds2', connection: 'Doris', sql: 'SELECT 2' });
  setParameterPanel(p, { title: '参数' });

  addParameter(p, 'k2', 'v2', 'dataset', 'ds2');
  const raw = fs.readFileSync(p, 'utf8');
  const ds2 = raw.indexOf('name="ds2"');
  const k2 = raw.indexOf('<Attributes name="k2"/>');
  assert.ok(k2 > ds2, 'dsName 定点应落在 ds2 段内');
  assert.throws(() => addParameter(p, 'k', 'x', 'dataset', 'ds1'), /数据集参数 "k" 已存在/, '定点判重按目标数据集');

  const addR = await addParameterBatch(p, [
    { name: 'b1', defaultValue: '1', scope: 'report' },
    { name: 'b1', defaultValue: '2', scope: 'dataset' },
  ]);
  assert.equal(addR.summary.inserted, 2, '批量跨层同名双插应全过');
  const getR = await getParameterBatch(p, [{ name: 'b1' }, { name: 'b1', scope: 'report' }]);
  assert.equal(getR.results[0].data.scope, 'dataset', '不限定时命中数据集层（首条）');
  assert.equal(getR.results[1].data.scope, 'report', 'scope 限定读报表级');
  const updR = await updateParameterBatch(p, [{ target: { name: 'b1', scope: 'report' }, patch: { defaultValue: '9' } }]);
  assert.equal(updR.summary.updated, 1);
  assert.equal(ofScope(parameters(p), 'b1', 'report')[0].defaultValue, '9');
  const delR = await deleteParameterBatch(p, [{ name: 'b1', scope: 'report' }]);
  assert.equal(delR.summary.deleted, 1);
  assert.equal(ofScope(parameters(p), 'b1', 'report').length, 0);
  assert.equal(ofScope(parameters(p), 'b1', 'dataset').length, 1);
  fs.rmSync(d, { recursive: true, force: true });
});

test('§5 补遗：SQL 引用仅报表级定义的参数不报 warning，未定义仍报', () => {
  const d = tmp();
  const p = path.join(d, 'f.cpt');
  createCpt(p, { rows: 3, columns: 3 });
  addDataset(p, { name: 'ds1', connection: 'Doris', sql: 'SELECT * FROM t WHERE u = ${only_report} AND v = ${ghost}' });
  setParameterPanel(p, { title: '参数' });

  // 仅报表级定义 only_report → §5 不得误报；从未定义的 ghost 仍报 1 条
  addParameter(p, 'only_report', 'sys', 'report');
  const issues = validateCpt(p).filter((i) => /SQL 引用参数/.test(i.message));
  assert.equal(issues.filter((i) => /only_report/.test(i.message)).length, 0, '报表级供数不得误报');
  assert.equal(issues.filter((i) => /ghost/.test(i.message)).length, 1, '真正未定义仍报 warning');
  fs.rmSync(d, { recursive: true, force: true });
});
