// test/localdb-report-env.test.js —— 报表级测试环境（2026-11-09）
//
// 覆盖用户口径：
//   · 修改已有报表：扫描全部数据连接 + 填报提交目标表，复制进内置 SQLite；
//   · 新建报表：path 不存在时可用 ddl/seed 建 SQLite fixture；
//   · 外部库只读：无真实连接时返回结构化 missing，不崩溃、不写业务库；
//   · 运行期预览不得冒充已验：runtime.status=unverified。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import '../scripts/isolate-store.mjs';
import { createCpt, addDataset, addFillSubmit } from '../lib/generate.js';
import {
  collectTemplateTableUsage, extractWriteTableRefs,
} from '../lib/localdb-import.js';
import { inspectReportTestEnv, prepareReportTestEnv, localPreviewConnections } from '../lib/test-env.js';
import { capabilityManifest } from '../lib/capabilities.js';
import { createLocalDb, dropLocalDb } from '../lib/localdb.js';

let seq = 0;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-report-env-'));

function makeTemplate(dir, { withDataset = true, withFill = true, withFreeSql = false } = {}) {
  seq += 1;
  const p = path.join(dir, `report-${seq}.cpt`);
  createCpt(p, { rows: 12, columns: 8, webWrite: true });
  if (withDataset) addDataset(p, { name: 'ds1', connection: 'Doris', sql: 'SELECT sku_code FROM ods_sku' });
  if (withFill) {
    addFillSubmit(p, {
      dsName: '填报-读写',
      schema: 'bi_ads',
      table: 'ods_fill',
      name: '提交',
      bindings: [{ field: 'sku_code', column: 0, row: 1, isKey: true }],
    });
  }
  if (withFreeSql) {
    addFillSubmit(p, {
      name: '更新',
      dbName: '填报-读写',
      sql: 'UPDATE ods_fill SET qty=${qty} WHERE sku_code=${sku_code}',
    });
  }
  return p;
}

test('extractWriteTableRefs：UPDATE/INSERT/DELETE/反引号/字符串噪声', () => {
  assert.deepEqual(extractWriteTableRefs('UPDATE ods_fill SET qty=1 WHERE id=2'), ['ods_fill']);
  assert.deepEqual(extractWriteTableRefs('INSERT INTO `bi_ads`.`ods_fill` (a) VALUES (1)'), ['ods_fill']);
  assert.deepEqual(extractWriteTableRefs('DELETE FROM ods_fill WHERE id=1'), ['ods_fill']);
  assert.deepEqual(extractWriteTableRefs("SELECT 'UPDATE fake SET x=1' FROM real_t"), []);
  assert.deepEqual(extractWriteTableRefs('-- UPDATE fake SET x=1\nUPDATE real_t SET x=1'), ['real_t']);
  // 函数/ON DUPLICATE KEY/FOR UPDATE 不是写表锚点
  assert.deepEqual(extractWriteTableRefs("SELECT REPLACE(name,'a','b') FROM t"), []);
  assert.deepEqual(extractWriteTableRefs('INSERT INTO t (a) VALUES (1) ON DUPLICATE KEY UPDATE a=2'), ['t']);
  assert.deepEqual(extractWriteTableRefs('SELECT * FROM t FOR UPDATE'), []);
});

test('collectTemplateTableUsage：同时包含数据集查询表与填报提交目标表', () => {
  const dir = tmp();
  try {
    const p = makeTemplate(dir, { withFreeSql: true });
    const usage = collectTemplateTableUsage({ files: [p] });
    assert.ok(usage.tables.includes('ods_sku'), usage.tables.join(','));
    assert.ok(usage.tables.includes('ods_fill'), usage.tables.join(','));
    assert.equal(usage.datasets.length, 1);
    assert.equal(usage.fillSubmits.length, 2);
    assert.ok(usage.fillSubmits.every((f) => f.connection === '填报-读写'));

    const fillOnly = collectTemplateTableUsage({ files: [p], connection: '填报-读写' });
    assert.ok(fillOnly.tables.includes('ods_fill'));
    assert.ok(!fillOnly.tables.includes('ods_sku'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('inspectReportTestEnv：已有报表按连接分组；新建报表 kind=new', () => {
  const dir = tmp();
  try {
    const p = makeTemplate(dir);
    const plan = inspectReportTestEnv(p);
    assert.equal(plan.kind, 'existing');
    assert.equal(plan.hasFill, true);
    const names = plan.connections.map((c) => c.name).sort();
    assert.deepEqual(names, ['Doris', '填报-读写']);
    const fill = plan.connections.find((c) => c.name === '填报-读写');
    assert.ok(fill.tables.includes('ods_fill'));
    assert.ok(fill.fillSubmits.includes('提交'));

    const missing = inspectReportTestEnv(path.join(dir, 'not-created.cpt'));
    assert.equal(missing.kind, 'new');
    assert.equal(missing.connections.length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('prepareReportTestEnv：本地已有目标表则直接复用；运行期仍标 unverified', async () => {
  const dir = tmp();
  const db = `reportenv_${Date.now().toString(36)}`.slice(0, 60);
  try {
    const p = makeTemplate(dir, { withDataset: false, withFill: true });
    createLocalDb(db);
    const ddl = await import('../lib/localdb-import.js').then((m) => m.importDdlIntoLocalDb({
      db,
      ddl: 'CREATE TABLE ods_fill (sku_code varchar(32) PRIMARY KEY, qty int);',
      replace: true,
    }));
    assert.equal(ddl.ok, true);
    const r = await prepareReportTestEnv({ db, path: p, autoSample: false });
    assert.equal(r.ok, true, JSON.stringify(r.missing));
    assert.equal(r.kind, 'existing');
    assert.equal(r.connections.length, 1);
    assert.equal(r.connections[0].prepared, true);
    assert.equal(r.connections[0].source, 'local');
    assert.equal(r.runtime.required, true);
    assert.equal(r.runtime.status, 'unverified');
    assert.equal(r.preview.driver, 'org.sqlite.JDBC');
    assert.match(String(r.preview.connections[0].url), /^jdbc:sqlite:\/\//);
    assert.match(String(r.nextAction), /start_fr_preview/);

    // start_fr_preview 的 localTest 预检：只返回已就绪的本地 SQLite 连接，不读取生产配置。
    const preview = localPreviewConnections(p);
    assert.equal(preview.ok, true, JSON.stringify(preview.missing));
    assert.equal(preview.connections.length, 1);
    assert.equal(preview.connections[0].name, '填报-读写');
    assert.match(preview.connections[0].dbFile, /\.sqlite$/i);
  } finally {
    try { dropLocalDb(db, { confirm: true }); } catch { /* ignore */ }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('prepareReportTestEnv：本地缺表且无真实连接 → 结构化 missing，不触碰外部库', async () => {
  const dir = tmp();
  const db = `reportmissing_${Date.now().toString(36)}`.slice(0, 60);
  try {
    const p = makeTemplate(dir, { withDataset: false, withFill: true });
    createLocalDb(db);
    const r = await prepareReportTestEnv({ db, path: p, autoSample: false });
    assert.equal(r.ok, false);
    assert.ok(r.missing.length >= 1);
    assert.ok(r.missing.some((m) => m.connection === '填报-读写' && m.tables.includes('ods_fill')));
    assert.ok(r.connections[0].error);
    assert.match(String(r.nextAction), /local_db_import\(\{ action: "ddl" \}\)/);
  } finally {
    try { dropLocalDb(db, { confirm: true }); } catch { /* ignore */ }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('prepareReportTestEnv：新建报表未带 fixture → ok=false + 可执行建 fixture 指引', async () => {
  const dir = tmp();
  const db = `reportempty_${Date.now().toString(36)}`.slice(0, 60);
  try {
    const r = await prepareReportTestEnv({ db, path: path.join(dir, 'new-empty.cpt') });
    assert.equal(r.ok, false);
    assert.equal(r.kind, 'new');
    assert.match(String(r.nextAction), /local_db_admin/);
    assert.match(String(r.nextAction), /action:"ddl"/);
  } finally {
    try { dropLocalDb(db, { confirm: true }); } catch { /* ignore */ }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('prepareReportTestEnv：新建报表可显式 ddl/seed 建 SQLite fixture', async () => {
  const dir = tmp();
  const db = `reportnew_${Date.now().toString(36)}`.slice(0, 60);
  const p = path.join(dir, 'new-report.cpt');
  try {
    const r = await prepareReportTestEnv({
      db,
      path: p,
      ddl: 'CREATE TABLE ods_new (id varchar(32) PRIMARY KEY, qty int);',
      table: 'ods_new',
      rows: [{ id: 'A', qty: 1 }],
    });
    assert.equal(r.ok, true);
    assert.equal(r.kind, 'new');
    assert.equal(r.fixture.ddl.ok, true);
    assert.equal(r.fixture.seed.ok, true);
    assert.match(String(r.nextAction), /run_dataset_sql_check/);
  } finally {
    try { dropLocalDb(db, { confirm: true }); } catch { /* ignore */ }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('capabilityManifest：模型可见的能力契约包含 action:report 与生产隔离', () => {
  const c = capabilityManifest();
  assert.match(c.workflow.reportTestEnv, /action:"report"/);
  assert.match(c.workflow.reportTestEnv, /external-data-connection-blocked/);
  assert.match(c.workflow.reportTestEnv, /localTest 缺省 true/);
  assert.match(c.workflow.reportTestEnv, /fillRuntime=unverified/);
  assert.match(c.environment.localDb.note, /action:"report"/);
});
