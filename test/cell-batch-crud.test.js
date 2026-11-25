import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createCpt, addCell } from '../lib/generate.js';
import { cells, styles } from '../lib/cpt.js';
import { selectCellSet, planCellBatch, applyCellBatch, parseA1, compressCellRanges } from '../lib/cell-batch.js';
import '../scripts/isolate-store.mjs'; // M123：JS 基线 store 隔离，直跑也不污染真实 store

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-cell-batch-'));
  const cpt = path.join(dir, 'batch.cpt');
  createCpt(cpt, { rows: 20, columns: 10 });
  for (let row = 0; row < 4; row += 1) {
    for (let column = 0; column < 3; column += 1) addCell(cpt, { column, row, content: `${column},${row}` });
  }
  return { dir, cpt };
}

test('A1 解析与坐标压缩不扩大稀疏选区', () => {
  assert.deepEqual(parseA1('BC23'), { column: 54, row: 22 });
  const compressed = compressCellRanges([
    { sheet: 'sheet1', sheetIndex: 0, column: 0, row: 0 },
    { sheet: 'sheet1', sheetIndex: 0, column: 1, row: 0 },
    { sheet: 'sheet1', sheetIndex: 0, column: 0, row: 1 },
    { sheet: 'sheet1', sheetIndex: 0, column: 1, row: 1 },
    { sheet: 'sheet1', sheetIndex: 0, column: 3, row: 1 },
  ]);
  assert.deepEqual(compressed.sort(), ['sheet1!A1:B2', 'sheet1!D2'].sort());
});

test('cellSet 默认只返回压缩摘要，并签发可复用 selectionId', () => {
  const { dir, cpt } = fixture();
  try {
    const result = selectCellSet(cpt, {
      sheet: 0, ranges: ['A1:C4'], where: { styleIndexes: [0] }, groupBy: ['style'],
    });
    assert.equal(result.matchedCount, 12);
    assert.deepEqual(result.coverage, ['sheet1!A1:C4']);
    assert.equal(result.groups[0].count, 12);
    assert.equal(result.items, undefined, 'summary 不应把全部单元格返回给模型');
    assert.match(result.selectionId, /^[0-9a-f-]{36}$/i);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('批量样式更新按原样式分组复用克隆，plan/apply 后只新增一个样式', () => {
  const { dir, cpt } = fixture();
  try {
    const selection = selectCellSet(cpt, { sheet: 0, ranges: ['A1:C4'] });
    const plan = planCellBatch(cpt, [{
      op: 'update', target: { selectionId: selection.selectionId },
      data: { patch: { style: { fontSizePt: 11, bold: true } } },
    }]);
    assert.equal(plan.status, 'ready');
    assert.equal(plan.affectedCount, 12);
    assert.equal(styles(cpt).length, 1, 'plan 不能修改原文件');

    const applied = applyCellBatch(cpt, plan.planId);
    assert.equal(applied.status, 'applied');
    assert.equal(styles(cpt).length, 2);
    assert.deepEqual([...new Set(cells(cpt).map((cell) => cell.style))], [1]);
    assert.ok(fs.existsSync(applied.backupPath));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CPT_MCP_NO_BAK=1 时 apply 不留 .bak-batch（版本走报表模式）', () => {
  const { dir, cpt } = fixture();
  const prev = process.env.CPT_MCP_NO_BAK;
  process.env.CPT_MCP_NO_BAK = '1';
  try {
    const selection = selectCellSet(cpt, { sheet: 0, ranges: ['A1:A2'] });
    const plan = planCellBatch(cpt, [{
      op: 'update', target: { selectionId: selection.selectionId },
      data: { patch: { content: 'NB' } },
    }]);
    const applied = applyCellBatch(cpt, plan.planId);
    assert.equal(applied.status, 'applied');
    assert.equal(applied.backupPath, null);
    assert.equal(fs.readdirSync(dir).filter((f) => f.includes('.bak-batch-')).length, 0);
  } finally {
    if (prev === undefined) delete process.env.CPT_MCP_NO_BAK;
    else process.env.CPT_MCP_NO_BAK = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('批量 create matrix 与 delete clear 均通过事务计划执行', () => {
  const { dir, cpt } = fixture();
  try {
    const createPlan = planCellBatch(cpt, [{
      op: 'create', target: { sheet: 0, anchor: 'E1' },
      data: { matrix: [['名称', '金额'], ['甲', '100']] },
    }]);
    assert.equal(createPlan.status, 'ready');
    applyCellBatch(cpt, createPlan.planId);
    assert.equal(cells(cpt).length, 16);

    const selection = selectCellSet(cpt, { sheet: 0, ranges: ['E1:F2'] });
    const deletePlan = planCellBatch(cpt, [{ op: 'delete', target: { selectionId: selection.selectionId }, data: { mode: 'clear' } }]);
    assert.equal(deletePlan.status, 'ready');
    applyCellBatch(cpt, deletePlan.planId);
    assert.equal(cells(cpt).length, 12);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('文件在 plan 后变化时拒绝应用旧计划', () => {
  const { dir, cpt } = fixture();
  try {
    const selection = selectCellSet(cpt, { sheet: 0, cells: ['A1'] });
    const plan = planCellBatch(cpt, [{
      op: 'update', target: { selectionId: selection.selectionId }, data: { patch: { content: '新值' } },
    }]);
    assert.equal(plan.status, 'ready');
    addCell(cpt, { column: 8, row: 8, content: '外部变化' });
    assert.throws(() => applyCellBatch(cpt, plan.planId), /已失效/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('批量选择与修改拒绝拼错字段，不静默扩大选区或部分执行', () => {
  const { dir, cpt } = fixture();
  try {
    assert.throws(
      () => selectCellSet(cpt, { sheet: 0, where: { styleIndex: [0] } }),
      /未支持字段.*不得猜测或静默忽略/,
    );
    const failed = planCellBatch(cpt, [{
      op: 'update', target: { sheet: 0, cells: ['A1'] },
      data: { patch: { style: { font_size: 12 } } },
    }]);
    assert.equal(failed.status, 'failed');
    assert.match(failed.message, /font_size.*不得猜测或静默忽略/);
    assert.equal(cells(cpt)[0].style, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
