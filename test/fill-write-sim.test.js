// test/fill-write-sim.test.js —— 填报提交本地试写（P2）
//
// 验证：两个 sheet 写同一目标表/key 时，模拟器能报告每 sheet 写行数、写事件、
// 重复写 key、旧行覆盖风险，并且整个过程在事务内回滚（本地表数据不变）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import '../scripts/isolate-store.mjs';
import { createCpt, addSheet, addFillSubmit, addCell } from '../lib/generate.js';
import { createLocalDb, dropLocalDb, executeLocalScript, runLocalSql } from '../lib/localdb.js';
import { simulateFillSubmit } from '../lib/fill-write-sim.js';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-fill-sim-'));
let seq = 0;
const dbName = () => `sim_${Date.now().toString(36)}_${++seq}`;

function makeCpt({ condition = null } = {}) {
  const p = path.join(TMP, `sim-${++seq}.cpt`);
  createCpt(p, { rows: 6, columns: 5, webWrite: true });
  addSheet(p, { sheetName: 's2', rows: 6, columns: 5 });
  addCell(p, { column: 0, row: 1, widget: 'text' });
  addCell(p, { column: 2, row: 1, widget: 'text' });
  addCell(p, { column: 0, row: 1, widget: 'text', sheet: 1 });
  addCell(p, { column: 2, row: 1, widget: 'text', sheet: 1 });
  addFillSubmit(p, {
    dsName: 'demo_conn', table: 'fill_target_demo', name: '提交A', sheet: 0,
    ...(condition ? { condition } : {}),
    bindings: [
      { field: 'id', isKey: true, column: 0, row: 1 },
      { field: 'source_type', constant: 'A' },
      { field: 'v', column: 2, row: 1 },
    ],
  });
  addFillSubmit(p, {
    dsName: 'demo_conn', table: 'fill_target_demo', name: '提交B', sheet: 1,
    bindings: [
      { field: 'id', isKey: true, column: 0, row: 1 },
      { field: 'source_type', constant: 'B' },
      { field: 'v', column: 2, row: 1 },
    ],
  });
  return p;
}

function makeDb() {
  const db = dbName();
  createLocalDb(db);
  executeLocalScript(db, "CREATE TABLE fill_target_demo (id INTEGER PRIMARY KEY, source_type TEXT, v TEXT)");
  executeLocalScript(db, "INSERT INTO fill_target_demo(id, source_type, v) VALUES (1, 'A', 'old')");
  return db;
}

test('两个 sheet 同目标同 key：报告 staleKeys，且事务回滚不改本地数据', () => {
  const p = makeCpt();
  const db = makeDb();
  try {
    const r = simulateFillSubmit({
      db, path: p,
      scenario: {
        0: [{ id: 1, v: 'new-from-A' }],
        1: [{ id: 1, v: 'old-from-B' }],
      },
    });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.rolledBack, true);
    assert.equal(r.totals.staleKeys, 1, JSON.stringify(r.totals));
    assert.equal(r.totals.overwrittenKeys >= 1, true, JSON.stringify(r.warnings));
    assert.ok(r.staleKeys[0].sheets.includes('sheet1') && r.staleKeys[0].sheets.includes('s2'), JSON.stringify(r.staleKeys));
    assert.equal(r.sheets.length, 2);
    assert.equal(r.tables[0].table, 'fill_target_demo');
    assert.equal(r.tables[0].beforeRows, 1);
    assert.equal(r.tables[0].afterRows, 1, '同一 key 只 update，不新增行');
    assert.equal(r.totals.writeEvents, 2);
    // 回滚验证：本地仍为 old，没有被模拟写成 old-from-B/new
    const v = runLocalSql(db, "SELECT v FROM fill_target_demo WHERE id=1").rows[0].v;
    assert.equal(v, 'old');
  } finally {
    dropLocalDb(db, { confirm: true });
  }
});

test('single-sheet 只模拟当前 sheet：不产生跨 sheet staleKeys', () => {
  const p = makeCpt();
  const db = makeDb();
  try {
    const r = simulateFillSubmit({
      db, path: p, mode: 'single-sheet', sheet: 0,
      scenario: { 0: [{ id: 1, v: 'only-A' }], 1: [{ id: 1, v: 'old-B' }] },
    });
    assert.equal(r.ok, true);
    assert.equal(r.totals.staleKeys, 0);
    assert.equal(r.totals.writeEvents, 1);
    assert.equal(r.submissions.length, 1);
    assert.equal(r.sheets.length, 1);
  } finally {
    dropLocalDb(db, { confirm: true });
  }
});

test('repeat：同一 sheet 重复提交可统计重复写，但不误报跨 sheet stale', () => {
  const p = makeCpt();
  const db = makeDb();
  try {
    const r = simulateFillSubmit({
      db, path: p, mode: 'single-sheet', sheet: 0, repeat: 2,
      scenario: { 0: [{ id: 1, v: 'repeat' }] },
    });
    assert.equal(r.ok, true);
    assert.equal(r.totals.writeEvents, 2);
    assert.equal(r.totals.staleKeys, 0);
    assert.equal(r.submissions.length, 1, 'repeat 不应把同一个提交重复列成多条');
  } finally {
    dropLocalDb(db, { confirm: true });
  }
});

test('条件：未提供 __condition 时给未求值提示；__condition:false 明确跳过', () => {
  const p = makeCpt({ condition: 'len(B3)!=0' });
  const db = makeDb();
  try {
    const r = simulateFillSubmit({
      db, path: p, mode: 'single-sheet', sheet: 0,
      scenario: { 0: [{ id: 1, v: 'x' }, { id: 2, v: 'y', __condition: false }] },
    });
    assert.equal(r.ok, true);
    assert.ok(r.warnings.some((w) => w.code === 'CONDITION_NOT_EVALUATED'), JSON.stringify(r.warnings));
    assert.equal(r.totals.skipped, 1);
    assert.equal(r.totals.writeEvents, 1);
  } finally {
    dropLocalDb(db, { confirm: true });
  }
});

test('目标表缺失/自由 SQL 提交：给结构化告警，不抛异常', () => {
  const p = path.join(TMP, 'missing-target.cpt');
  createCpt(p, { rows: 3, columns: 3, webWrite: true });
  addFillSubmit(p, { dsName: 'demo_conn', table: 'no_such_table', name: '提交', bindings: [{ field: 'id', isKey: true, column: 0, row: 1 }] });
  const db = dbName();
  createLocalDb(db);
  try {
    const r = simulateFillSubmit({ db, path: p, scenario: { 0: [{ id: 1 }] } });
    assert.equal(r.ok, true);
    assert.ok(r.warnings.some((w) => w.code === 'TARGET_TABLE_MISSING'));
  } finally {
    dropLocalDb(db, { confirm: true });
  }

  const q = path.join(TMP, 'free-sql.cpt');
  createCpt(q, { rows: 3, columns: 3, webWrite: true });
  addFillSubmit(q, { dbName: 'demo_conn', sql: 'UPDATE t SET a=1 WHERE id=${id}', name: '删除' });
  const db2 = dbName();
  createLocalDb(db2);
  executeLocalScript(db2, 'CREATE TABLE t (id INTEGER PRIMARY KEY, a INTEGER)');
  try {
    const r = simulateFillSubmit({ db: db2, path: q, scenario: { 0: [{ id: 1 }] } });
    assert.equal(r.ok, true);
    assert.ok(r.warnings.some((w) => w.code === 'FREE_SQL_NOT_SIMULATED'));
    assert.equal(r.totals.writeEvents, 0);
  } finally {
    dropLocalDb(db2, { confirm: true });
  }
});
