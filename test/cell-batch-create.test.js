// test/cell-batch-create.test.js —— 2026-11-23：batch_mutate_cells 建格能力补齐
//
// 背景（会话实测）：create 的 data 字段集没有任何文档，模型写 data:{content,colspan} 会被
// "create.data 含未支持字段 content, colspan" 拒绝；update 又只能改已有格（"update 目标选区为空"）。
// 本测试锁定：create 三种写法（cells / matrix / 单格简写）+ 报错可操作性 + plan/apply 原子语义。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createCpt } from '../lib/generate.js';
import { cells } from '../lib/cpt.js';
import { planCellBatch, applyCellBatch } from '../lib/cell-batch.js';
import '../scripts/isolate-store.mjs';

function fixture(rows = 10, columns = 6) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-cell-create-'));
  const cpt = path.join(dir, 'create.cpt');
  createCpt(cpt, { rows, columns });
  return { dir, cpt };
}

const contentAt = (cpt, column, row) => {
  const hit = cells(cpt).find((c) => c.column === column && c.row === row);
  return hit ? (hit.contentText ?? hit.formula) : undefined;
};

test('create：data.cells 批量建格（plan → apply）', () => {
  const { dir, cpt } = fixture();
  try {
    const plan = planCellBatch(cpt, [{
      op: 'create',
      data: {
        cells: [
          { column: 0, row: 0, content: '标题' },
          { column: 0, row: 1, content: '表头' },
          { column: 1, row: 1, content: '=sum(A2)' },
        ],
      },
    }]);
    assert.equal(plan.status, 'ready');
    assert.equal(plan.affectedCount, 3);
    assert.equal(cells(cpt).length, 0, 'plan 阶段不得改原文件');

    const applied = applyCellBatch(cpt, plan.planId);
    assert.equal(applied.status, 'applied');
    assert.equal(contentAt(cpt, 0, 0), '标题');
    assert.equal(contentAt(cpt, 1, 1), '=sum(A2)');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('create：单格简写（字段直接写在 data 上）+ 坐标从 target.cells 推导', () => {
  const { dir, cpt } = fixture();
  try {
    const r1 = planCellBatch(cpt, [{
      op: 'create',
      target: { cells: ['B3'] },
      data: { content: '简写格', colspan: 2 },
    }]);
    assert.equal(r1.status, 'ready');
    assert.equal(r1.affectedCount, 1);
    applyCellBatch(cpt, r1.planId);
    assert.equal(contentAt(cpt, 1, 2), '简写格');

    // data.cell 单格对象形态
    const r2 = planCellBatch(cpt, [{
      op: 'create',
      data: { cell: { column: 0, row: 3, content: '对象格' } },
    }]);
    assert.equal(r2.status, 'ready');
    applyCellBatch(cpt, r2.planId);
    assert.equal(contentAt(cpt, 0, 3), '对象格');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('create：matrix + target.anchor 一次铺二维表', () => {
  const { dir, cpt } = fixture();
  try {
    const plan = planCellBatch(cpt, [{
      op: 'create',
      target: { sheet: 0, anchor: 'A1' },
      data: { matrix: [['甲', '乙'], ['1', '2']] },
    }]);
    assert.equal(plan.status, 'ready');
    assert.equal(plan.affectedCount, 4);
    applyCellBatch(cpt, plan.planId);
    assert.equal(contentAt(cpt, 0, 0), '甲');
    assert.equal(contentAt(cpt, 1, 0), '乙');
    assert.equal(contentAt(cpt, 1, 1), '2');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('create：未知字段报错必须点名允许字段与三种写法（不再只说“不得猜测”）', () => {
  const { dir, cpt } = fixture();
  try {
    const plan = planCellBatch(cpt, [{
      op: 'create',
      data: { content: 'x', unknownField: 1 },
    }]);
    // plan 失败会返回 failureId（不抛），错误信息在 failure 里
    assert.equal(plan.status, 'failed');
    const message = JSON.stringify(plan);
    assert.match(message, /create\.data/);
    assert.match(message, /cells/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('update：空选区报错提示改用 create（区分“建格”与“改格”）', () => {
  const { dir, cpt } = fixture();
  try {
    const plan = planCellBatch(cpt, [{
      op: 'update',
      target: { sheet: 0, cells: ['A1'] },
      data: { patch: { content: 'x' } },
    }]);
    assert.equal(plan.status, 'failed');
    assert.match(JSON.stringify(plan), /update 只能修改\*\*已存在\*\*的单元格|update 只能修改已存在的单元格|改用 op:"create"/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
