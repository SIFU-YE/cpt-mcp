// test/fill-submit-type.test.js —— sandbox2/v8 会话暴露的 MCP 能力缺口回归
//
// 背景（2026-11-09 检查 sandbox2/v8 会话）：
//   · 7 张模板的 Doris 直写提交都是 IntelliDMLConfig（智能提交），Doris 不支持智能提交，
//     设计要求 InsertConfig（插入提交）；
//   · cpt-mcp 的 add_fill_submit / update_fill_submit 没有任何「提交类型」参数：
//     update_fill_submit({configType:"InsertConfig"}) 被 strict schema 拒绝（Unrecognized key），
//     get_fill_config 也不回读 DMLConfig class，模型只能 grep XML；
//   · update_fill_submit 对已有 ListCondition 的提交只认 FormulaCondition，改条件直接报错。
// 本文件固化：insert/intelligent 类型读写、ListCondition 读写、自由 SQL 拒绝类型参数。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createCpt, addFillSubmit } from '../lib/generate.js';
import { updateFillSubmit } from '../lib/edits.js';
import { fillConfig } from '../lib/cpt.js';
import '../scripts/isolate-store.mjs';

delete process.env.CPT_MCP_ALLOWED_ROOTS;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-mcp-submit-type-'));
test.after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ } });
const file = (n) => path.join(TMP, n);
const read = (p) => fs.readFileSync(p, 'utf8');

const INTELLI = 'com.fr.write.config.IntelliDMLConfig';
const INSERT = 'com.fr.write.config.InsertConfig';
const LIST_CONDITION = '<Condition class="com.fr.data.condition.ListCondition"/>';
const FORMULA_CONDITION = '<Condition class="com.fr.data.condition.FormulaCondition">';

function fixture(name, opts = {}) {
  const p = file(name);
  createCpt(p, { rows: 8, columns: 5, webWrite: true });
  addFillSubmit(p, {
    dsName: 'Doris', table: 't_control', name: '内置SQL1',
    bindings: [{ field: 'id', column: 0, row: 0, isKey: true }, { field: 'name', column: 1, row: 0 }],
    ...opts,
  });
  return p;
}

test('add_fill_submit 默认仍是智能提交（旧字节/行为不变）', () => {
  const p = fixture('default.cpt');
  assert.ok(read(p).includes(`class="${INTELLI}"`));
  const cfg = fillConfig(p).submits[0];
  assert.equal(cfg.submitType, 'intelligent');
  assert.equal(cfg.dmlConfigClass, INTELLI);
});

test('add_fill_submit submitType:"insert" → InsertConfig，并回读 submitType', () => {
  const p = fixture('insert.cpt', { submitType: 'insert' });
  assert.ok(read(p).includes(`class="${INSERT}"`));
  assert.ok(!read(p).includes(`class="${INTELLI}"`));
  const cfg = fillConfig(p).submits[0];
  assert.equal(cfg.submitType, 'insert');
  assert.equal(cfg.dmlConfigClass, INSERT);
});

test('add_fill_submit 接受 configType 别名（InsertConfig / IntelliDMLConfig / smart）', () => {
  const p1 = fixture('alias-insert.cpt', { configType: 'InsertConfig' });
  assert.equal(fillConfig(p1).submits[0].submitType, 'insert');
  const p2 = fixture('alias-smart.cpt', { configType: 'smart' });
  assert.equal(fillConfig(p2).submits[0].submitType, 'intelligent');
  assert.throws(() => fixture('bad-type.cpt', { submitType: 'merge' }), /不支持的提交类型/);
});

test('update_fill_submit 把智能提交改成插入提交（sandbox2/v8 的根因修复路径）', () => {
  const p = fixture('update-to-insert.cpt');
  const rawBefore = read(p);
  const r = updateFillSubmit(p, { submitIndex: 0, submitType: 'insert' });
  assert.ok(r.changed.includes('submitType'));
  assert.equal(r.submitType, 'insert');
  assert.equal(r.dmlConfigClass, INSERT);
  const rawAfter = read(p);
  assert.ok(rawAfter.includes(`class="${INSERT}"`));
  // 只改 class 一个属性，目标表/列绑定/条件等其余内容原样保留
  assert.equal(rawAfter.replace(`class="${INSERT}"`, `class="${INTELLI}"`), rawBefore);
  assert.equal(fillConfig(p).submits[0].submitType, 'insert');
});

test('update_fill_submit 支持改回智能提交；已是目标类型时不假报 changed', () => {
  const p = fixture('update-back.cpt', { submitType: 'insert' });
  const r1 = updateFillSubmit(p, { submitIndex: 0, configType: 'IntelliDMLConfig' });
  assert.equal(r1.submitType, 'intelligent');
  assert.ok(read(p).includes(`class="${INTELLI}"`));
  const r2 = updateFillSubmit(p, { submitIndex: 0, submitType: 'intelligent' });
  assert.ok(!r2.changed.includes('submitType'), '已是智能提交不应假报 changed');
});

test('自由 SQL 提交拒绝 submitType/configType（没有 DMLConfig）', () => {
  const p = file('free-sql.cpt');
  createCpt(p, { rows: 4, columns: 3, webWrite: true });
  assert.throws(() => addFillSubmit(p, {
    dbName: '填报-读写', sql: 'UPDATE t SET a=1 WHERE id=${id}',
    submitType: 'insert',
  }), /只用于列映射提交/);
  addFillSubmit(p, { dbName: '填报-读写', sql: 'UPDATE t SET a=1 WHERE id=${id}' });
  assert.throws(() => updateFillSubmit(p, { submitIndex: 0, submitType: 'insert' }), /只用于列映射提交/);
});

test('condition:"ListCondition" 写空列表条件；get_fill_config 回读 conditionClass', () => {
  const p = fixture('list-condition.cpt', { condition: 'ListCondition' });
  assert.ok(read(p).includes(LIST_CONDITION));
  const cfg = fillConfig(p).submits[0];
  assert.deepEqual(cfg.condition, { class: 'com.fr.data.condition.ListCondition', formula: null });
  assert.equal(cfg.conditionClass, 'com.fr.data.condition.ListCondition');
});

test('update_fill_submit 能把已有 ListCondition 改成公式条件（不再报“只安全改写 FormulaCondition”）', () => {
  const p = fixture('list-to-formula.cpt');
  updateFillSubmit(p, { submitIndex: 0, condition: 'ListCondition' });
  const r = updateFillSubmit(p, { submitIndex: 0, condition: 'Y5=1' });
  assert.ok(r.changed.includes('condition'));
  assert.equal(r.condition, 'Y5=1');
  assert.ok(read(p).includes(FORMULA_CONDITION));
  assert.ok(!read(p).includes(LIST_CONDITION));
  assert.equal(fillConfig(p).submits[0].condition.formula, 'Y5=1');

  const r2 = updateFillSubmit(p, { submitIndex: 0, condition: 'ListCondition' });
  assert.equal(r2.condition, 'ListCondition');
  assert.ok(read(p).includes(LIST_CONDITION));
});

test('submitType + condition 可以一次原子修改', () => {
  const p = fixture('both.cpt');
  const r = updateFillSubmit(p, { submitIndex: 0, submitType: 'insert', condition: 'Y5=1' });
  assert.equal(r.submitType, 'insert');
  assert.equal(r.condition, 'Y5=1');
  assert.ok(read(p).includes(`class="${INSERT}"`));
  assert.ok(read(p).includes(FORMULA_CONDITION));
  assert.equal(fillConfig(p).submits[0].submitType, 'insert');
  assert.equal(fillConfig(p).submits[0].condition.formula, 'Y5=1');
});
