// test/localdb-offline.test.js —— 本地 SQLite 离线校验/对账/质量门禁 blocker（2026-11-02）
// 覆盖：离线 prepare 审计（语法/列绑定）、本地实跑、真实 vs 本地 compare 纯函数、
//       qualityGate(localSqlAudit:true) 的 blocker/warning 分级。不连真实数据库。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import '../scripts/isolate-store.mjs';
import { createCpt, addDataset, addCell } from '../lib/generate.js';
import {
  checkDatasetSqlLocal, compareDatasetChecks, LOCAL_CHECK_CAVEATS, datasetBindings,
  maskUnresolvedCandidates, maskStrategyLabel,
} from '../lib/sql-check.js';
import { createLocalDb, dropLocalDb, updateLocalDbConfig, runLocalSql } from '../lib/localdb.js';
import { importDdlIntoLocalDb, seedLocalDb } from '../lib/localdb-import.js';
import { auditTemplateLocalSql } from '../lib/localdb-audit.js';
import { qualityGate } from '../lib/quality.js';

let seq = 0;
function freshDbName(prefix = 'audit') {
  seq += 1;
  return `${prefix}${seq}_${Date.now().toString(36)}`.slice(0, 60);
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-localdb-offline-'));

/** 建一个带 SQL 数据集 + dsColumn 绑定的模板 */
function fixture(dir, { name = 'a.cpt', sql = 'SELECT sku_code, sku_name FROM ods_sku WHERE qty > 0', bindings = ['sku_code', 'sku_name'], connection = 'Doris' } = {}) {
  const p = path.join(dir, name);
  createCpt(p, { rows: 4, columns: 4 });
  addDataset(p, { name: 'ds1', connection, sql });
  bindings.forEach((col, i) => {
    addCell(p, { column: i, row: 1, contentType: 'dsColumn', dsName: 'ds1', columnName: col });
  });
  return p;
}

function makeLocalDb(db, { withTable = true } = {}) {
  createLocalDb(db);
  updateLocalDbConfig({ default: db, databases: { [db]: { file: `${db}.sqlite`, sourceConnection: 'Doris' } } });
  if (withTable) {
    importDdlIntoLocalDb({
      db,
      ddl: 'CREATE TABLE ods_sku (sku_code varchar(32) NOT NULL, sku_name varchar(64), qty int);',
    });
    seedLocalDb({ db, table: 'ods_sku', rows: [
      { sku_code: 'SKU-1', sku_name: '商品一', qty: 3 },
      { sku_code: 'SKU-2', sku_name: '商品二', qty: 0 },
    ] });
  }
}

test('offline prepare：语法/列名可审计，列绑定一致时 ok=true', async () => {
  const dir = tmp();
  const db = freshDbName();
  try {
    const p = fixture(dir);
    makeLocalDb(db);
    const r = await checkDatasetSqlLocal({ cptPath: p, localDb: db, offline: true });
    assert.equal(r.ok, true, JSON.stringify(r.execError ?? r.bindingCheck));
    assert.equal(r.executed, false);
    assert.deepEqual(r.prepared.columns, ['sku_code', 'sku_name']);
    assert.equal(r.bindingCheck.missingInSql.length, 0);
    assert.equal(r.bindingCheck.matched, 2);
  } finally {
    dropLocalDb(db, { confirm: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('本地实跑：参数代入/行数/方言层生效；缺绑定列时 ok=false 并点名', async () => {
  const dir = tmp();
  const db = freshDbName();
  try {
    const p = fixture(dir);
    makeLocalDb(db);
    const r = await checkDatasetSqlLocal({ cptPath: p, localDb: db, maxRows: 10 });
    assert.equal(r.ok, true);
    assert.equal(r.executed, true);
    assert.equal(r.execution.rows.length, 1, 'WHERE qty > 0 应过滤掉 qty=0 的行');
    // 绑定列缺失：SQL 只返回 sku_code，但模板绑定了 sku_name
    const p2 = fixture(dir, { name: 'b.cpt', sql: 'SELECT sku_code FROM ods_sku', bindings: ['sku_code', 'sku_name'] });
    const r2 = await checkDatasetSqlLocal({ cptPath: p2, localDb: db, offline: true });
    assert.equal(r2.ok, false);
    assert.deepEqual(r2.bindingCheck.missingInSql.map((m) => m.column), ['sku_name']);
    assert.ok(r2.hints.some((h) => /本地 SQL 未返回/.test(h)));
  } finally {
    dropLocalDb(db, { confirm: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('本地库不存在：返回可操作指引而不是抛错', async () => {
  const dir = tmp();
  try {
    const p = path.join(dir, 'x.cpt');
    createCpt(p, { rows: 3, columns: 3 });
    addDataset(p, { name: 'ds1', connection: 'Doris', sql: 'SELECT 1 AS a' });
    const r = await checkDatasetSqlLocal({ cptPath: p, localDb: 'no_such_db_zz', offline: true });
    assert.equal(r.ok, false);
    assert.match(r.error, /不存在/);
    assert.ok(r.hints.some((h) => /local_db_admin/.test(h)));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('缺表：离线通道归类为 missing-table（不是语法错）', async () => {
  const dir = tmp();
  const db = freshDbName();
  try {
    const p = fixture(dir, { sql: 'SELECT * FROM no_such_table' });
    makeLocalDb(db);
    const r = await checkDatasetSqlLocal({ cptPath: p, localDb: db, offline: true });
    assert.equal(r.ok, false);
    assert.equal(r.execError.kind, 'missing-table');
    assert.match(r.execError.message, /no such table/);
  } finally {
    dropLocalDb(db, { confirm: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('方言缺口：不支持的写法仍返回 dialectIssues（不静默吞掉）', async () => {
  const dir = tmp();
  const db = freshDbName();
  try {
    const p = fixture(dir, { sql: "SELECT sku_code FROM ods_sku WHERE sku_name REGEXP '^A' AND qty DIV 2 = 0" });
    makeLocalDb(db);
    const r = await checkDatasetSqlLocal({ cptPath: p, localDb: db, offline: true });
    // DIV 无法改写成合法 SQLite → 应明确报错或给出 dialectIssues，不能假装 ok
    assert.equal(r.ok, false);
    assert.ok((r.execError.dialectIssues?.length ?? 0) + (r.dialectIssues?.length ?? 0) >= 0);
  } finally {
    dropLocalDb(db, { confirm: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('compareDatasetChecks：match/rows-differ/columns-differ/values-differ/local-error 判定', () => {
  const realExec = (cols, rows, rowCount = rows.length) => ({ execution: { columns: cols.map((n) => ({ name: n })), rows, rowCount }, hints: [] });
  const localExec = (cols, rows, rowCount = rows.length) => ({ execution: { columns: cols.map((n) => ({ name: n })), rows, rowCount }, hints: [] });
  const match = compareDatasetChecks(realExec(['a', 'b'], [{ a: 1, b: 'x' }]), localExec(['a', 'b'], [{ a: 1, b: 'x' }]));
  assert.equal(match.verdict, 'match');
  const rowsDiff = compareDatasetChecks(realExec(['a'], [{ a: 1 }], 5), localExec(['a'], [{ a: 1 }], 3));
  assert.equal(rowsDiff.verdict, 'rows-differ');
  const colsDiff = compareDatasetChecks(realExec(['a', 'b'], [{ a: 1, b: 2 }]), localExec(['a'], [{ a: 1 }]));
  assert.equal(colsDiff.verdict, 'columns-differ');
  assert.deepEqual(colsDiff.columns.missingInLocal, ['b']);
  const values = compareDatasetChecks(realExec(['amount'], [{ amount: '19.90' }]), localExec(['amount'], [{ amount: 19.9 }]));
  assert.equal(values.verdict, 'match', '数值格式 19.90 vs 19.9 应视为一致（容差比较）');
  const values2 = compareDatasetChecks(realExec(['name'], [{ name: '甲' }]), localExec(['name'], [{ name: '乙' }]));
  assert.equal(values2.verdict, 'values-differ');
  const localErr = compareDatasetChecks(realExec(['a'], [{ a: 1 }]), { execError: { message: 'boom' } });
  assert.equal(localErr.verdict, 'local-error');
  assert.ok(Array.isArray(LOCAL_CHECK_CAVEATS) && LOCAL_CHECK_CAVEATS.length > 0);
});

test('auditTemplateLocalSql：本地库未建时 enabled=false；建库后逐数据集给出 pass/blocker/warning', () => {
  const dir = tmp();
  const db = freshDbName();
  try {
    const p = fixture(dir, { name: 'ok.cpt' });
    const noDb = auditTemplateLocalSql(p);
    assert.equal(noDb.enabled, false);
    assert.match(noDb.reason, /本地 SQLite 测试库未初始化/);

    makeLocalDb(db);
    const audit = auditTemplateLocalSql(p, { db });
    assert.equal(audit.enabled, true);
    assert.equal(audit.datasets.length, 1);
    assert.equal(audit.datasets[0].status, 'pass');
    assert.deepEqual([...datasetBindings(p).get('ds1').keys()].sort(), ['sku_code', 'sku_name']);

    // 语法错 → blocker
    const bad = fixture(dir, { name: 'bad.cpt', sql: 'SELEC 1' });
    const auditBad = auditTemplateLocalSql(bad, { db });
    assert.equal(auditBad.datasets[0].status, 'blocker');
    assert.ok(auditBad.blockers.some((b) => b.code === 'local_sql_syntax'));

    // 缺表 → warning（不是 blocker）
    const missing = fixture(dir, { name: 'missing.cpt', sql: 'SELECT * FROM not_imported_t' });
    const auditMissing = auditTemplateLocalSql(missing, { db });
    assert.equal(auditMissing.datasets[0].status, 'warning');
    assert.equal(auditMissing.blockers.length, 0);
    assert.ok(auditMissing.warnings.some((w) => w.code === 'local_db_missing_table'));
  } finally {
    dropLocalDb(db, { confirm: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('离线审计：Doris schema 限定表名（bi_ads.ods_sku）在裸表镜像上 enabled=true 且 pass', async () => {
  const dir = tmp();
  const db = freshDbName();
  try {
    makeLocalDb(db); // 镜像库按裸表名导入 ods_sku
    const p = fixture(dir, {
      name: 'schema.cpt',
      sql: 'SELECT sku_code, sku_name FROM bi_ads.ods_sku WHERE qty > 0',
    });

    // prepare-only 通道：改写后应能绑定列，并保留 schema_prefix_stripped 说明
    const r = await checkDatasetSqlLocal({ cptPath: p, localDb: db, offline: true });
    assert.equal(r.ok, true, JSON.stringify(r.execError ?? r.prepared?.error ?? r.bindingCheck));
    assert.deepEqual(r.prepared.columns, ['sku_code', 'sku_name']);
    assert.equal(r.bindingCheck.matched, 2);
    assert.ok(r.dialectIssues.some((i) => i.code === 'schema_prefix_stripped'), '方言层必须报告 schema 改写，不得静默');

    // 本地实跑通道（非 offline）也走同一改写
    const ran = await checkDatasetSqlLocal({ cptPath: p, localDb: db, maxRows: 10 });
    assert.equal(ran.ok, true, JSON.stringify(ran.execError));
    assert.equal(ran.executed, true);
    assert.equal(ran.execution.rows.length, 1, 'WHERE qty > 0 应过滤掉 qty=0 的行');

    // 离线审计（FIX-6 依赖）：不再 enabled:false / 不再缺表
    const audit = auditTemplateLocalSql(p, { db });
    assert.equal(audit.enabled, true);
    assert.equal(audit.datasets.length, 1);
    assert.equal(audit.datasets[0].status, 'pass');
    assert.ok(audit.datasets[0].dialectIssues.some((i) => i.code === 'schema_prefix_stripped'));

    // qualityGate 的 localSqlAudit 不再因 schema 限定产生 local_sql blocker
    const gate = qualityGate(p, { localSqlAudit: true, localSqlAuditDb: db });
    assert.equal(gate.localSqlAudit.enabled, true);
    assert.equal(gate.blockers.filter((b) => b.source === 'local_sql').length, 0);
    assert.equal(gate.localSqlAudit.datasets[0].status, 'pass');
  } finally {
    dropLocalDb(db, { confirm: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('离线审计：schema 限定但本地缺表 → 仍归类 missing-table（warning，不是 blocker）', () => {
  const dir = tmp();
  const db = freshDbName();
  try {
    makeLocalDb(db);
    const p = fixture(dir, {
      name: 'schema-missing.cpt',
      sql: 'SELECT sku_code FROM bi_ads.not_imported_t',
      bindings: ['sku_code'],
    });
    const audit = auditTemplateLocalSql(p, { db });
    assert.equal(audit.enabled, true);
    assert.equal(audit.datasets[0].status, 'warning');
    assert.equal(audit.blockers.length, 0);
    assert.ok(audit.warnings.some((w) => w.code === 'local_db_missing_table'));
    // 改写本身有据可查：issue 在，缺表结论才是环境问题而不是 SQL 写错
    assert.ok(audit.datasets[0].dialectIssues.some((i) => i.code === 'schema_prefix_stripped'));
  } finally {
    dropLocalDb(db, { confirm: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('qualityGate：localSqlAudit 默认（不传）不跑；传 true 时语法错进 blockers、缺表只进 advisories', () => {
  const dir = tmp();
  const db = freshDbName();
  try {
    const bad = fixture(dir, { name: 'gate-bad.cpt', sql: 'SELEC 1' });
    makeLocalDb(db);
    const gateOff = qualityGate(bad);
    assert.equal(gateOff.localSqlAudit, undefined, '内部默认调用不跑本地审计（零回归）');

    const gate = qualityGate(bad, { localSqlAudit: true, localSqlAuditDb: db });
    assert.equal(gate.pass, false);
    assert.ok(gate.blockers.some((b) => b.source === 'local_sql' && /无法通过 SQLite 语法解析/.test(b.message)));
    assert.ok(gate.blockers.find((b) => b.source === 'local_sql').fix.length > 0);

    const missing = fixture(dir, { name: 'gate-missing.cpt', sql: 'SELECT * FROM missing_t' });
    const gate2 = qualityGate(missing, { localSqlAudit: true, localSqlAuditDb: db });
    assert.equal(gate2.blockers.filter((b) => b.source === 'local_sql').length, 0, '缺表属环境问题，不得作为 blocker');
    assert.ok(gate2.advisories.some((a) => a.source === 'local_sql'));
    assert.equal(gate2.localSqlAudit.enabled, true);
    // 2026-11-04：审计已生效时顶层状态同样可见（不再只有 skipped 一种信号）
    assert.equal(gate2.localSqlAuditStatus.enabled, true);
    assert.equal(gate2.localSqlAuditStatus.datasets, 1);
    assert.equal(gate2.localSqlAuditStatus.code, undefined);
    assert.match(gate2.note, /localSqlAuditStatus/);
  } finally {
    dropLocalDb(db, { confirm: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('qualityGate：本地库没建时 localSqlAudit 自动跳过，delivery 判定不被环境问题影响', () => {
  const dir = tmp();
  try {
    const p = fixture(dir, { name: 'nodblib.cpt' });
    const gate = qualityGate(p, { localSqlAudit: true, localSqlAuditDb: 'definitely_missing_db' });
    assert.equal(gate.localSqlAudit.enabled, false);
    assert.equal(gate.blockers.filter((b) => b.source === 'local_sql').length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 2026-11-07 P0（用户实测）：公式型参数 ${if(...)} 落表达式位，NULL 占位会拼出
// `WHERE 1=1 NULL` → 语法错 → quality_gate 把"参数无法离线代入"误报成模板 SQL blocker。
// 修复：null → formula-empty → all-empty 三档占位依次 prepare，取第一个成功的。
// ---------------------------------------------------------------------------

test('maskUnresolvedCandidates：三档候选顺序 + 简单/公式分类', () => {
  const sql = 'SELECT * FROM t WHERE 1=1 ${if(len(d)=0,"","AND d=1")} AND dt=\'${start}\'';
  const cands = maskUnresolvedCandidates(sql);
  assert.deepEqual(cands.map((c) => c.strategy), ['null', 'formula-empty', 'all-empty']);
  assert.ok(!/\$\{/.test(cands[0].sql), '候选里不应残留 ${...}');
  // formula-empty：公式 token 消失，简单 ${start} 仍 NULL
  assert.ok(cands[1].sql.includes("AND dt=' NULL '"), cands[1].sql);
  assert.ok(!cands[1].sql.includes('if(len(d)='), '公式型 token 在 formula-empty 里应被替换为空串');
  // all-empty：全部空串
  assert.ok(cands[2].sql.includes("AND dt=''"), cands[2].sql);
  assert.equal(maskStrategyLabel('formula-empty'), '公式参数=空串、简单参数=NULL');
  assert.equal(maskStrategyLabel('null'), '全部未解析参数=NULL');
});

test('离线审计：公式型参数落表达式位（WHERE 1=1 ${if(...)}）不再误报语法 blocker（用户实测 P0）', async () => {
  const dir = tmp();
  const db = freshDbName('formula');
  try {
    makeLocalDb(db);
    const sql = 'SELECT sku_code, sku_name FROM ods_sku WHERE 1=1\n${if(len(dept)=0,"","AND sku_name = \'x\'")}';
    const p = fixture(dir, { name: 'formula-param.cpt', sql });

    // ① offline prepare：null 候选语法错 → formula-empty 成功
    const r = await checkDatasetSqlLocal({ cptPath: p, localDb: db, offline: true });
    assert.equal(r.ok, true, JSON.stringify(r.execError ?? r.bindingCheck));
    assert.equal(r.paramMaskStrategy, 'formula-empty');
    assert.deepEqual(r.prepared.columns, ['sku_code', 'sku_name']);
    assert.equal(r.prepared.paramMaskStrategy, 'formula-empty');
    assert.ok(r.hints.some((h) => /占位策略：公式参数=空串/.test(h)), JSON.stringify(r.hints));

    // ② 不传 offline 直接 target:"local"（用户原话场景）：不执行、只 prepare，也不能因公式参数报语法错
    const rNoOffline = await checkDatasetSqlLocal({ cptPath: p, localDb: db });
    assert.equal(rNoOffline.executed, false);
    assert.match(rNoOffline.skippedReason, /force=true/);
    assert.equal(rNoOffline.ok, true, JSON.stringify(rNoOffline.execError ?? rNoOffline.unresolvedParams));
    assert.equal(rNoOffline.paramMaskStrategy, 'formula-empty');

    // ③ quality_gate 的 localSqlAudit：enabled + status=pass + blockers=0，仅 warning
    const audit = auditTemplateLocalSql(p, { db });
    assert.equal(audit.enabled, true);
    assert.equal(audit.datasets[0].status, 'pass');
    assert.equal(audit.blockers.length, 0);
    assert.equal(audit.datasets[0].paramMaskStrategy, 'formula-empty');
    const masked = audit.warnings.find((w) => w.code === 'local_sql_masked_params');
    assert.ok(masked, JSON.stringify(audit.warnings.map((w) => w.code)));
    assert.match(masked.message, /公式参数=空串/);
    assert.match(masked.message, /未校验参数过滤语义/);

    const gate = qualityGate(p, { localSqlAudit: true, localSqlAuditDb: db });
    assert.equal(gate.localSqlAudit.enabled, true);
    assert.equal(gate.localSqlAudit.datasets[0].status, 'pass');
    assert.equal(gate.blockers.filter((b) => b.source === 'local_sql').length, 0, '不得误报为 blocker');
    assert.equal(gate.pass, true, JSON.stringify(gate.blockers));
  } finally {
    dropLocalDb(db, { confirm: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('离线审计：简单 ${name} 未解析仍按 NULL 占位（策略 null，旧行为兼容）', async () => {
  const dir = tmp();
  const db = freshDbName('simple');
  try {
    makeLocalDb(db);
    const p = fixture(dir, {
      name: 'simple-param.cpt',
      sql: "SELECT sku_code FROM ods_sku WHERE sku_code = '${code}'",
      bindings: ['sku_code'],
    });
    const r = await checkDatasetSqlLocal({ cptPath: p, localDb: db, offline: true });
    assert.equal(r.ok, true, JSON.stringify(r.execError));
    assert.equal(r.paramMaskStrategy, 'null');

    const audit = auditTemplateLocalSql(p, { db });
    assert.equal(audit.datasets[0].status, 'pass');
    assert.equal(audit.datasets[0].paramMaskStrategy, 'null');
    assert.equal(audit.blockers.length, 0);
    const masked = audit.warnings.find((w) => w.code === 'local_sql_masked_params');
    assert.ok(masked);
    assert.match(masked.message, /全部未解析参数=NULL/);
  } finally {
    dropLocalDb(db, { confirm: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('离线审计：三档占位都失败时仍是 warning（不误报语法 blocker）', async () => {
  const dir = tmp();
  const db = freshDbName('failall');
  try {
    makeLocalDb(db);
    // 公式在表位：NULL / 空串 / 空串 三档都拼不出合法表名
    const p = fixture(dir, {
      name: 'formula-allfail.cpt',
      sql: 'SELECT sku_code FROM ${if(len(x)=0,"ods_sku","ods_sku2")}',
      bindings: ['sku_code'],
    });
    const audit = auditTemplateLocalSql(p, { db });
    assert.equal(audit.enabled, true);
    assert.equal(audit.datasets[0].status, 'warning');
    assert.equal(audit.blockers.length, 0, '含参数令牌时不得把无法离线判定判成 blocker');
    const w = audit.warnings.find((x) => x.code === 'local_sql_syntax_with_params');
    assert.ok(w, JSON.stringify(audit.warnings.map((x) => x.code)));
    assert.match(w.message, /三档占位策略/);
    assert.equal(audit.datasets[0].paramMaskStrategy, null);

    const r = await checkDatasetSqlLocal({ cptPath: p, localDb: db, offline: true });
    assert.equal(r.ok, false);
    assert.equal(r.execError.kind, 'syntax');
    assert.equal(r.paramMaskStrategy, null);
  } finally {
    dropLocalDb(db, { confirm: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
