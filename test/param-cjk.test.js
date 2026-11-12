import '../scripts/isolate-store.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createCpt, addDataset, setParameterPanel, addParameterWidget } from '../lib/generate.js';
import { addParameter, updateParameter, deleteParameter, renameParameterWidget } from '../lib/edits.js';
import { parameters } from '../lib/cpt.js';
import { validateCpt } from '../lib/validate.js';
import { reviewReasonableness } from '../lib/engine/reason.js';

delete process.env.CPT_MCP_ALLOWED_ROOTS;

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-paramcjk-'));

test('F7 中文参数名增改删读回全通', () => {
  const d = tmp();
  const p = path.join(d, 'cjk.cpt');
  createCpt(p, { rows: 3, columns: 3 });
  addDataset(p, { name: 'ds1', connection: 'Doris', sql: 'SELECT 1' });
  // 增：纯中文 + 中英混排
  addParameter(p, '部门名称', '研发');
  addParameter(p, 'dept_部门1', 'x');
  let got = parameters(p).filter((x) => x.name === '部门名称');
  assert.equal(got.length, 1, '中文参数应可新增并读回');
  assert.equal(got[0].defaultValue, '研发');
  // 改名：中文 → 中文
  updateParameter(p, '部门名称', undefined, '销售部');
  got = parameters(p).filter((x) => x.name === '销售部');
  assert.equal(got.length, 1, '中文改名后应可读回');
  assert.equal(parameters(p).filter((x) => x.name === '部门名称').length, 0, '旧名不应残留');
  // 删
  deleteParameter(p, '销售部');
  deleteParameter(p, 'dept_部门1');
  assert.equal(parameters(p).filter((x) => x.name === '销售部').length, 0, '删除后不应读回');
  assert.equal(validateCpt(p).filter((i) => i.severity === 'error').length, 0, '中文参数全流程不得引入校验 error');
  fs.rmSync(d, { recursive: true, force: true });
});

test('F7 中文参数 validate 0 error（含默认值写盘）', () => {
  const d = tmp();
  const p = path.join(d, 'cjk-v.cpt');
  createCpt(p, { rows: 3, columns: 3 });
  addDataset(p, { name: 'ds1', connection: 'Doris', sql: "SELECT * FROM t WHERE d = '${部门名称}'", parameters: [{ name: '部门名称', defaultValue: '研发' }] });
  const errors = validateCpt(p).filter((i) => i.severity === 'error');
  assert.deepEqual(errors, [], '中文参数模板 validate 应 0 error');
  fs.rmSync(d, { recursive: true, force: true });
});

test('F7 reason 检出中文 ${} 引用', () => {
  const d = tmp();
  const p = path.join(d, 'cjk-r.cpt');
  createCpt(p, { rows: 3, columns: 3 });
  // 故意不定义参数：reason 应把 ${部门名称} 检出为待传参引用（旧 ASCII 正则直接漏检）
  addDataset(p, { name: 'ds1', connection: 'Doris', sql: "SELECT * FROM t WHERE d = '${部门名称}'" });
  const { issues } = reviewReasonableness(p);
  assert.ok(
    issues.some((i) => String(i.location).includes('ds1') && String(i.message).includes('部门名称')),
    'reason 应检出 ${部门名称} 引用（未定义时报 SQL 引用参数 部门名称）',
  );
  fs.rmSync(d, { recursive: true, force: true });
});

test('F7 控件改名复用同口径：中文新名放行', () => {
  const d = tmp();
  const p = path.join(d, 'cjk-w.cpt');
  createCpt(p, { rows: 3, columns: 3 });
  setParameterPanel(p, { title: '参数' });
  addParameterWidget(p, { name: 'kw', type: 'text' });
  const r = renameParameterWidget(p, { name: 'kw', newName: '部门' });
  assert.equal(r.newName, '部门', '中文控件新名应放行');
  fs.rmSync(d, { recursive: true, force: true });
});

test('F7 非法名仍拒绝（数字开头/含空格/含连字符）', () => {
  const d = tmp();
  const p = path.join(d, 'cjk-n.cpt');
  createCpt(p, { rows: 3, columns: 3 });
  addDataset(p, { name: 'ds1', connection: 'Doris', sql: 'SELECT 1' });
  for (const bad of ['1abc', '含 空格', 'a-b', '']) {
    assert.throws(() => addParameter(p, bad, 'x'), /非法/, `仍应拒绝 ${JSON.stringify(bad)}`);
  }
  fs.rmSync(d, { recursive: true, force: true });
});
