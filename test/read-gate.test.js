import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { CptReadGate, readCptCompact } from '../lib/read-gate.js';
import { createCpt, addDataset, addCell } from '../lib/generate.js';
import '../scripts/isolate-store.mjs'; // M123：JS 基线 store 隔离，直跑也不污染真实 store

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-read-gate-'));
  const cpt = path.join(dir, 'sample.cpt');
  createCpt(cpt, { rows: 30, columns: 2 });
  addDataset(cpt, {
    name: 'ds1', connection: 'Doris', sql: `SELECT '${'x'.repeat(500)}' AS long_value`,
    parameters: Array.from({ length: 25 }, (_, index) => ({ name: `p${index}`, defaultValue: String(index) })),
  });
  for (let row = 0; row < 25; row += 1) {
    addCell(cpt, { column: 0, row, content: `cell-${row}-${'文'.repeat(250)}` });
  }
  return { dir, cpt, audit: path.join(dir, 'audit', 'read.jsonl') };
}

test('存在不明确事项时记录拒绝日志，但不签发 permit', () => {
  const { dir, cpt, audit } = fixture();
  try {
    const gate = new CptReadGate({ auditLogPath: audit });
    const result = gate.recordIntent({
      path: cpt,
      views: ['cells'],
      purpose: '查看目标单元格',
      confirmedFacts: ['用户要求检查模板'],
      uncertainties: ['用户没有说明工作表'],
    });
    assert.deepEqual(result, { status: 'clarification_required', questions: ['用户没有说明工作表'] });
    const line = JSON.parse(fs.readFileSync(audit, 'utf8').trim());
    assert.equal(line.status, 'clarification_required');
    assert.throws(
      () => gate.assertAuthorized({ permitId: 'missing', path: cpt, view: 'cells' }),
      /请先调用 record_cpt_read_intent/,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('permit 严格绑定 CPT 路径、读取视图和有效期', () => {
  const { dir, cpt, audit } = fixture();
  let now = Date.now();
  try {
    const gate = new CptReadGate({ auditLogPath: audit, ttlSeconds: 10, now: () => now });
    const result = gate.recordIntent({
      path: cpt,
      views: ['overview'],
      purpose: '读取概览',
      confirmedFacts: ['用户明确指定该文件'],
      uncertainties: [],
    });
    assert.equal(result.status, 'authorized');
    assert.doesNotThrow(() => gate.assertAuthorized({ permitId: result.permitId, path: cpt, view: 'overview' }));
    assert.throws(() => gate.assertAuthorized({ permitId: result.permitId, path: cpt, view: 'cells' }), /未授权/);
    assert.throws(() => gate.assertAuthorized({ permitId: result.permitId, path: path.join(dir, 'other.cpt'), view: 'overview' }), /路径不匹配/);
    now += 10_001;
    assert.throws(() => gate.assertAuthorized({ permitId: result.permitId, path: cpt, view: 'overview' }), /已过期/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('审计日志未成功落盘时绝不签发 permit', () => {
  const { dir, cpt } = fixture();
  try {
    const gate = new CptReadGate({ auditLogPath: dir }); // 目录不能作为 appendFile 目标
    assert.throws(() => gate.recordIntent({
      path: cpt, views: ['overview'], purpose: '读取概览',
      confirmedFacts: ['用户明确指定该文件'], uncertainties: [],
    }));
    assert.equal(gate.permits.size, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('紧凑读取默认分页并裁剪长文本', () => {
  const { dir, cpt } = fixture();
  try {
    const first = readCptCompact(cpt, { view: 'cells' });
    assert.equal(first.total, 25);
    assert.equal(first.items.length, 20);
    assert.equal(first.hasMore, true);
    assert.equal(first.nextCursor, 20);
    assert.ok(first.items[0].contentText.length <= 201);
    assert.ok(first.truncatedFields.some((field) => field.includes('contentText')));

    const second = readCptCompact(cpt, { view: 'cells', cursor: first.nextCursor, limit: 50 });
    assert.equal(second.items.length, 5);
    assert.equal(second.hasMore, false);
    assert.equal(second.nextCursor, null);

    const data = readCptCompact(cpt, { view: 'datasets', selector: { name: 'ds1' } });
    assert.equal(data.items.length, 1);
    assert.ok(data.items[0].sql.length <= 201);

    const standard = readCptCompact(cpt, { view: 'datasets', detail: 'standard' });
    assert.equal(standard.items[0].parameters.length, 20, '嵌套列表也必须服从默认 token 上限');
    assert.ok(standard.truncatedFields.some((field) => field.includes('parameters')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('坐标型视图缺少明确坐标时拒绝推测', () => {
  const { dir, cpt } = fixture();
  try {
    assert.throws(() => readCptCompact(cpt, { view: 'cellStyle' }), /不得推测坐标/);
    assert.throws(() => readCptCompact(cpt, { view: 'hyperlink', selector: { row: 0 } }), /不得推测坐标/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('统一入口的全部读取视图均可调度到底层实现', () => {
  const { dir, cpt } = fixture();
  try {
    for (const view of ['overview', 'datasets', 'parameters', 'cells', 'fill', 'styles', 'page', 'grid', 'panel']) {
      assert.doesNotThrow(() => readCptCompact(cpt, { view }), `视图 ${view} 应可读取`);
    }
    for (const view of ['cellStyle', 'hyperlink']) {
      assert.doesNotThrow(() => readCptCompact(cpt, { view, selector: { column: 0, row: 0 } }), `视图 ${view} 应可读取`);
    }
    const set = readCptCompact(cpt, { view: 'cellSet', selector: { sheet: 0, ranges: ['A1:A25'], groupBy: ['style'] } });
    assert.equal(set.matchedCount, 25);
    assert.equal(set.items, undefined, 'cellSet 默认只返回压缩摘要');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
