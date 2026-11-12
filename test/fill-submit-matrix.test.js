// test/fill-submit-matrix.test.js —— 跨 sheet 填报提交拓扑（P0）
//
// 场景来源：双 sheet 样本两个 sheet 都提交到 fill_target_demo（key=id），
// sheet 有 来源判别常量列但未进入主键/提交条件；点击一个 sheet 提交时，
// 另一个 sheet 的旧行也会参与 upsert，导致新数据被旧数据覆盖/回退。
import test from 'node:test';
import assert from 'node:assert/strict';

import { buildFillSubmitMatrix } from '../lib/cpt.js';

function submit(overrides = {}) {
  return {
    index: 0,
    sheet: 0,
    name: '提交1',
    mode: 'built-in',
    submitType: 'intelligent',
    dsName: 'demo_conn',
    schema: '',
    table: 'fill_target_demo',
    columns: [
      { field: 'id', isKey: true, constant: null },
      { field: 'dept_name', isKey: false, constant: null },
    ],
    condition: null,
    ...overrides,
  };
}

test('同目标/同主键/无来源条件：识别为高风险共享目标', () => {
  const m = buildFillSubmitMatrix([
    submit({ index: 0, sheet: 0 }),
    submit({ index: 1, sheet: 1 }),
  ]);
  assert.equal(m.summary.sharedTargets, 1);
  assert.equal(m.summary.highRiskTargets, 1);
  assert.equal(m.targetGroups[0].sameKey, true);
  assert.equal(m.targetGroups[0].hasSheetDiscriminator, false);
  assert.equal(m.targetGroups[0].risk, 'shared-target-same-key-no-discriminator');
  assert.equal(m.warnings[0].code, 'FILL_SHARED_TARGET');
  assert.match(m.warnings[0].message, /旧行|覆盖|回退/);
});

test('来源判别常量列未进入主键/条件：仍按高风险处理', () => {
  const m = buildFillSubmitMatrix([
    submit({ sheet: 0, columns: [
      { field: 'id', isKey: true, constant: null },
      { field: 'source_type', isKey: false, constant: 'A' },
    ] }),
    submit({ index: 1, sheet: 1, columns: [
      { field: 'id', isKey: true, constant: null },
      { field: 'source_type', isKey: false, constant: 'B' },
    ] }),
  ]);
  assert.equal(m.summary.highRiskTargets, 1);
  assert.equal(m.targetGroups[0].hasSheetDiscriminator, false);
});

test('来源判别字段进入主键或提交条件：共享目标仅提示，不判高风险', () => {
  const withKey = buildFillSubmitMatrix([
    submit({ sheet: 0, columns: [
      { field: 'source_type', isKey: true, constant: 'A' },
      { field: 'id', isKey: true, constant: null },
    ] }),
    submit({ index: 1, sheet: 1, columns: [
      { field: 'source_type', isKey: true, constant: 'B' },
      { field: 'id', isKey: true, constant: null },
    ] }),
  ]);
  assert.equal(withKey.summary.sharedTargets, 1);
  assert.equal(withKey.summary.highRiskTargets, 0);
  assert.equal(withKey.targetGroups[0].hasSheetDiscriminator, true);

  const withCondition = buildFillSubmitMatrix([
    submit({ sheet: 0, condition: { class: 'com.fr.data.condition.FormulaCondition', formula: "source_type='A'" } }),
    submit({ index: 1, sheet: 1, condition: { class: 'com.fr.data.condition.FormulaCondition', formula: "source_type='B'" } }),
  ]);
  assert.equal(withCondition.summary.highRiskTargets, 0);
});

test('不同目标或单 sheet 不产生共享目标告警', () => {
  const single = buildFillSubmitMatrix([submit({ sheet: 0 })]);
  assert.equal(single.summary.sharedTargets, 0);
  assert.equal(single.warnings.length, 0);

  const different = buildFillSubmitMatrix([
    submit({ sheet: 0, table: 't1' }),
    submit({ index: 1, sheet: 1, table: 't2' }),
  ]);
  assert.equal(different.summary.sharedTargets, 0);
});

test('自由 SQL 的写目标也参与共享目标识别', () => {
  const m = buildFillSubmitMatrix([
    submit({ index: 0, sheet: 0, mode: 'free-sql', table: null, dbName: 'demo_conn', sql: 'UPDATE fill_target_demo SET x=1 WHERE id=${id}' }),
    submit({ index: 1, sheet: 1, mode: 'free-sql', table: null, dbName: 'demo_conn', sql: 'INSERT INTO fill_target_demo (id) VALUES (${id})' }),
  ]);
  assert.equal(m.summary.sharedTargets, 1);
  assert.equal(m.targetGroups[0].table, 'fill_target_demo');
});
