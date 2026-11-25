// test/localdb-write-audit.test.js —— SQLite 写审计（P1）
//
// 全部在 isolate-store 的临时本地库根目录跑；不碰用户工程、不连外部数据库。
import test from 'node:test';
import assert from 'node:assert/strict';
import '../scripts/isolate-store.mjs';
import {
  createLocalDb, dropLocalDb, executeLocalScript, runLocalSql,
  startWriteAuditRun, stopWriteAuditRun, readWriteAudit, installWriteAuditTriggers,
} from '../lib/localdb.js';

function freshDbName(prefix = 'wa') {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`.slice(0, 60);
}

test('写审计：INSERT/UPDATE/DELETE 计数、行数变化、source_type 来源分组', () => {
  const db = freshDbName();
  createLocalDb(db);
  try {
    executeLocalScript(db, 'CREATE TABLE t (id INTEGER PRIMARY KEY, source_type TEXT, v TEXT)');
    const run = startWriteAuditRun(db, { tables: ['t'], note: 'unit' });
    assert.equal(run.ok, true);
    assert.match(run.runId, /^wa-/);
    runLocalSql(db, "INSERT INTO t(id, source_type, v) VALUES (1,'A','a')", { write: true });
    runLocalSql(db, "INSERT INTO t(id, source_type, v) VALUES (2,'B','b')", { write: true });
    runLocalSql(db, "UPDATE t SET v='a2' WHERE id=1", { write: true });
    runLocalSql(db, 'DELETE FROM t WHERE id=2', { write: true });
    stopWriteAuditRun(db, { runId: run.runId });

    const wa = readWriteAudit(db, { runId: run.runId });
    assert.equal(wa.ok, true);
    assert.equal(wa.enabled, true);
    assert.equal(wa.totals.writeEvents, 4);
    assert.equal(wa.totals.inserts, 2);
    assert.equal(wa.totals.updates, 1);
    assert.equal(wa.totals.deletes, 1);
    assert.equal(wa.tables[0].table, 't');
    assert.equal(wa.tables[0].beforeRows, 0);
    assert.equal(wa.tables[0].afterRows, 1);
    assert.equal(wa.tables[0].delta, 1);
    assert.ok(wa.totals.firstWriteAt && wa.totals.lastWriteAt);
    const hints = Object.fromEntries(wa.bySheetHint.map((x) => [x.sheetHint, x.events]));
    assert.equal(hints['A'], 2);
    assert.equal(hints['B'], 2); // INSERT + DELETE
  } finally {
    dropLocalDb(db, { confirm: true });
  }
});

test('写审计：未安装触发器的库返回 enabled:false，不抛错', () => {
  const db = freshDbName();
  createLocalDb(db);
  try {
    executeLocalScript(db, 'CREATE TABLE t (id INTEGER PRIMARY KEY)');
    const wa = readWriteAudit(db, { last: 1 });
    assert.equal(wa.ok, true);
    assert.equal(wa.enabled, false);
    assert.match(String(wa.reason), /写审计/);
  } finally {
    dropLocalDb(db, { confirm: true });
  }
});

test('写审计：触发器可重复安装，且不审计 __cpt_ 表自身', () => {
  const db = freshDbName();
  createLocalDb(db);
  try {
    executeLocalScript(db, 'CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
    installWriteAuditTriggers(db, ['t']);
    installWriteAuditTriggers(db, ['t']);
    const run = startWriteAuditRun(db, { tables: ['t'], installTriggers: false });
    runLocalSql(db, "INSERT INTO t(id,v) VALUES (1,'x')", { write: true });
    stopWriteAuditRun(db, { runId: run.runId });
    const wa = readWriteAudit(db, { runId: run.runId });
    assert.equal(wa.totals.writeEvents, 1);
    assert.equal(wa.tables[0].table, 't');
  } finally {
    dropLocalDb(db, { confirm: true });
  }
});
