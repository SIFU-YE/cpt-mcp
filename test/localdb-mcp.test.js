// test/localdb-mcp.test.js —— 内置 SQLite 本地测试库的 MCP 协议层端到端（2026-11-02）
// 覆盖：工具注册/注解、租约族解锁、建库→导入 DDL→本地执行→离线校验、quality_gate 本地 SQL blocker。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createCpt, addDataset, addCell } from '../lib/generate.js';
import { createLocalDb, dropLocalDb, localTableInfo, localSchemaSnapshot } from '../lib/localdb.js';
import { importDdlIntoLocalDb, seedLocalDb } from '../lib/localdb-import.js';
import '../scripts/isolate-store.mjs';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-localdb-mcp-'));
const LOCALDB = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-localdb-dir-'));
const DB = 'mcp_main';

function fixture(name, sql, bindings = ['sku_code', 'sku_name']) {
  const p = path.join(TMP, name);
  createCpt(p, { rows: 4, columns: 4 });
  addDataset(p, { name: 'ds1', connection: 'Doris', sql });
  bindings.forEach((col, i) => addCell(p, { column: i, row: 1, contentType: 'dsColumn', dsName: 'ds1', columnName: col }));
  return p;
}

async function withServer(env, fn) {
  const client = new Client({ name: 'localdb-mcp-test', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['server.js'],
    cwd: process.cwd(),
    stderr: 'pipe',
    env: { CPT_MCP_LOCALDB_DIR: LOCALDB, ...env },
  });
  await client.connect(transport);
  const call = async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: args });
    const text = r.content?.[0]?.text ?? '';
    let data = null;
    try { data = JSON.parse(text); } catch { /* 报错文案非 JSON */ }
    return { isError: r.isError === true, text, data };
  };
  const list = async () => (await client.listTools()).tools;
  try {
    return await fn({ client, call, list });
  } finally {
    await client.close();
  }
}

test('full 档：6 个本地库工具注册/注解/参数完整；run_dataset_sql_check 暴露 target/localDb/offline', async () => {
  await withServer({ CPT_MCP_TOOL_PROFILE: 'full' }, async ({ list }) => {
    const tools = await list();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    for (const name of ['get_local_db_status', 'local_db_admin', 'local_db_import', 'local_db_exec', 'local_db_schema', 'dataset_sql_parity']) {
      assert.ok(byName[name], `full 档应注册 ${name}`);
      assert.equal(byName[name].annotations?.title, name, `${name} 应有契约注解`);
    }
    assert.equal(byName.get_local_db_status.annotations.readOnlyHint, true);
    assert.equal(byName.local_db_schema.annotations.readOnlyHint, true);
    assert.equal(byName.dataset_sql_parity.annotations.readOnlyHint, true);
    assert.equal(byName.local_db_admin.annotations.destructiveHint, true);
    assert.equal(byName.local_db_import.annotations.readOnlyHint, false);
    assert.equal(byName.local_db_exec.annotations.readOnlyHint, false);
    const sqlProps = byName.run_dataset_sql_check.inputSchema.properties;
    assert.ok(sqlProps.target && sqlProps.localDb && sqlProps.offline, 'run_dataset_sql_check 应暴露 target/localDb/offline');
  });
});

test('report 档：本地库工具默认不可见；租约 local_db 解锁后可查状态', async () => {
  await withServer({ CPT_MCP_TOOL_PROFILE: 'report' }, async ({ call, list }) => {
    const before = (await list()).map((t) => t.name);
    for (const name of ['get_local_db_status', 'local_db_admin', 'local_db_import', 'local_db_exec', 'local_db_schema', 'dataset_sql_parity']) {
      assert.ok(!before.includes(name), `report 档未租约前不应看到 ${name}`);
    }
    const p = fixture('lease.cpt', 'SELECT 1 AS sku_code');
    const grant = await call('request_deep_tool_access', { path: p, group: 'local_db' });
    assert.equal(grant.data?.status, 'granted', grant.text.slice(0, 200));
    const after = (await list()).map((t) => t.name);
    assert.ok(after.includes('get_local_db_status'), '租约后应动态可见');
    const status = await call('get_local_db_status', {});
    assert.equal(status.isError, false, status.text.slice(0, 300));
    assert.equal(status.data.available, true);
    assert.equal(status.data.root, LOCALDB);
  });
});

test('本地库端到端：建库→DDL 建表→exec 造数→离线校验模板 SQL→quality_gate blocker 分级', async () => {
  await withServer({ CPT_MCP_TOOL_PROFILE: 'full' }, async ({ call }) => {
    const created = await call('local_db_admin', { action: 'create', db: DB });
    assert.equal(created.isError, false, created.text.slice(0, 200));
    const ddl = await call('local_db_import', {
      action: 'ddl', db: DB,
      ddl: 'CREATE TABLE ods_sku (sku_code varchar(32) NOT NULL, sku_name varchar(64), qty int);',
    });
    assert.equal(ddl.isError, false, ddl.text.slice(0, 300));
    const seed = await call('local_db_import', {
      action: 'seed', db: DB, table: 'ods_sku', mode: 'insert',
      rows: [{ sku_code: 'SKU-1', sku_name: '商品一', qty: 3 }, { sku_code: 'SKU-2', sku_name: '商品二', qty: 0 }],
    });
    assert.equal(seed.isError, false, seed.text.slice(0, 300));
    assert.equal(seed.data.rows, 2);

    // 本地执行（MySQL 常用函数）
    const q = await call('local_db_exec', {
      db: DB, sql: "SELECT CONCAT(sku_code, ':') AS k, DATE_FORMAT('2026-01-02 03:04:05', '%Y%m%d') AS d FROM ods_sku ORDER BY sku_code",
    });
    assert.equal(q.isError, false, q.text.slice(0, 300));
    assert.equal(q.data.rows.length, 2);
    assert.equal(q.data.rows[0].k, 'SKU-1:');
    assert.equal(q.data.rows[0].d, '20260102');

    // 写权限围栏：未 allowWrite 的 exec 被拒
    const denied = await call('local_db_exec', { db: DB, sql: 'DELETE FROM ods_sku', mode: 'exec' });
    assert.equal(denied.isError, true);
    assert.match(denied.text, /allowWrite/);

    // 离线校验模板 SQL
    const ok = fixture('ok.cpt', 'SELECT sku_code, sku_name FROM ods_sku WHERE qty > 0');
    const check = await call('run_dataset_sql_check', { path: ok, datasetName: 'ds1', target: 'local', offline: true, localDb: DB });
    assert.equal(check.isError, false, check.text.slice(0, 400));
    assert.equal(check.data.ok, true, check.text.slice(0, 400));
    assert.equal(check.data.target, 'local');
    assert.equal(check.data.localDb, DB);
    assert.deepEqual(check.data.bindingCheck.missingInSql, []);

    // 质量门槛：本地库建好时默认开启审计；语法错 → blocker
    const bad = fixture('bad.cpt', 'SELEC 1');
    const gateBad = await call('quality_gate_cpt', { path: bad, localSqlAuditDb: DB });
    assert.equal(gateBad.isError, false, gateBad.text.slice(0, 300));
    assert.ok(gateBad.data.localSqlAudit.enabled, '本地库存在时应启用本地 SQL 审计');
    assert.ok(gateBad.data.blockers.some((b) => b.source === 'local_sql'), JSON.stringify(gateBad.data.blockers).slice(0, 400));
    assert.equal(gateBad.data.pass, false);

    // 好模板：本地审计通过（deliveryPass 仍取决于真实引擎，不在本测试断言）
    const gateOk = await call('quality_gate_cpt', { path: ok, localSqlAuditDb: DB });
    assert.equal(gateOk.data.localSqlAudit.enabled, true);
    assert.equal(gateOk.data.blockers.filter((b) => b.source === 'local_sql').length, 0);
    assert.equal(gateOk.data.pass, true, JSON.stringify(gateOk.data.blockers).slice(0, 300));

    // 2026-11-07 P0：用户实测「WHERE 1=1 + 公式型参数」模板，MCP 端到端不再误报语法 blocker
    const formula = fixture(
      'formula.cpt',
      'SELECT sku_code, sku_name FROM ods_sku WHERE 1=1\n${if(len(dept)=0,"","AND sku_name = \'x\'")}',
    );
    const fcheck = await call('run_dataset_sql_check', { path: formula, datasetName: 'ds1', target: 'local', offline: true, localDb: DB });
    assert.equal(fcheck.isError, false, fcheck.text.slice(0, 400));
    assert.equal(fcheck.data.ok, true, fcheck.text.slice(0, 400));
    assert.equal(fcheck.data.paramMaskStrategy, 'formula-empty', fcheck.text.slice(0, 300));
    assert.equal(fcheck.data.executed, false);
    assert.deepEqual(fcheck.data.bindingCheck.missingInSql, []);

    const gateFormula = await call('quality_gate_cpt', { path: formula, localSqlAuditDb: DB });
    assert.equal(gateFormula.data.localSqlAudit.enabled, true);
    assert.equal(gateFormula.data.localSqlAudit.datasets[0].status, 'pass', JSON.stringify(gateFormula.data.localSqlAudit).slice(0, 300));
    assert.equal(gateFormula.data.blockers.filter((b) => b.source === 'local_sql').length, 0);
    assert.equal(gateFormula.data.pass, true, JSON.stringify(gateFormula.data.blockers).slice(0, 300));
  });
});

// ---------------------------------------------------------------------------
// 2026-11-07 P0：local_db_schema 报 "Do not know how to serialize a BigInt"
// 根因：readBigInts:true 让 COUNT(*) 是 bigint，旧 ok() 直接 JSON.stringify 抛错。
// ---------------------------------------------------------------------------

test('local_db_schema：BIGINT 行数不再触发 BigInt 序列化错误（用户实测 P0）', async () => {
  const db = 'bigint_mcp';
  await withServer({ CPT_MCP_TOOL_PROFILE: 'full' }, async ({ call }) => {
    const created = await call('local_db_admin', { action: 'create', db });
    assert.equal(created.isError, false, created.text.slice(0, 200));
    const ddl = await call('local_db_import', { action: 'ddl', db, ddl: 'CREATE TABLE big_rows (id INTEGER PRIMARY KEY, n BIGINT);' });
    assert.equal(ddl.isError, false, ddl.text.slice(0, 300));
    const ins = await call('local_db_exec', {
      db,
      mode: 'exec',
      allowWrite: true,
      sql: 'INSERT INTO big_rows(n) WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 1000) SELECT x FROM c',
    });
    assert.equal(ins.isError, false, ins.text.slice(0, 300));

    const schema = await call('local_db_schema', { db });
    assert.equal(schema.isError, false, schema.text.slice(0, 400));
    const row = (schema.data.tables || []).find((t) => t.table === 'big_rows');
    assert.ok(row, `tables 应含 big_rows：${schema.text.slice(0, 300)}`);
    assert.equal(typeof row.rows, 'number', `rows 应为 number（不能是 bigint），实际 ${typeof row.rows}`);
    assert.equal(row.rows, 1000);
    // 整个返回体（含列/索引内省）必须能再次 JSON.stringify（旧实现整个调用直接失败）
    assert.doesNotThrow(() => JSON.stringify(schema.data), 'local_db_schema 返回体必须 JSON 安全');
    const nCol = (row.columns || []).find((c) => c.name === 'n');
    assert.ok(nCol, 'columns 应含 n');
    assert.equal(typeof nCol.pk, 'number');
  });
});

test('localTableInfo / localSchemaSnapshot：COUNT(*) 已从 bigint 转 JSON 安全值', () => {
  const db = 'bigint_unit';
  createLocalDb(db);
  try {
    importDdlIntoLocalDb({ db, ddl: 'CREATE TABLE unit_rows (id INTEGER PRIMARY KEY, n BIGINT);' });
    seedLocalDb({ db, table: 'unit_rows', rows: [{ id: 1, n: 1 }, { id: 2, n: 2 }] });

    const info = localTableInfo(db, 'unit_rows');
    assert.equal(typeof info.rows, 'number', `localTableInfo().rows 应为 number，实际 ${typeof info.rows}`);
    assert.equal(info.rows, 2);
    const idCol = info.columns.find((c) => c.name === 'id');
    assert.equal(typeof idCol.cid, 'number', `columns[].cid 应为 number（pragma INTEGER 也是 bigint 泄漏点），实际 ${typeof idCol.cid}`);
    assert.doesNotThrow(() => JSON.stringify(info), 'localTableInfo 结果必须能 JSON.stringify');

    const snap = localSchemaSnapshot(db);
    assert.equal(typeof snap.unit_rows.rows, 'number');
    assert.equal(snap.unit_rows.rows, 2);
    assert.doesNotThrow(() => JSON.stringify(snap), 'localSchemaSnapshot 结果必须能 JSON.stringify');
  } finally {
    dropLocalDb(db, { confirm: true });
  }
});

// ---------------------------------------------------------------------------
// 2026-11-07 P0：compareWith 是"用户显式点名"，不得回落到默认/真实连接
// ---------------------------------------------------------------------------

test('local_db_schema：compareWith 未知连接名严格拒绝，不触达任何真实库（用户实测 P0）', async () => {
  const db = 'cmp_strict';
  await withServer({
    CPT_MCP_TOOL_PROFILE: 'full',
    // 隔离机器上的真实连接配置：只留一个假连接（127.0.0.1:1），即使误连也会立刻失败而不是查生产库
    CPT_DB_DISABLE_CONFIG_FILES: '1',
    CPT_DB_CONNECTIONS: JSON.stringify({ Doris: { host: '127.0.0.1', port: 1, user: 'u', password: 'p', database: 'd' } }),
  }, async ({ call }) => {
    const created = await call('local_db_admin', { action: 'create', db });
    assert.equal(created.isError, false, created.text.slice(0, 200));

    const r = await call('local_db_schema', { db, compareWith: 'NoSuchConn' });
    assert.equal(r.isError, true, r.text.slice(0, 300));
    assert.match(r.text, /未在配置中找到/);
    assert.match(r.text, /不做回退/);
    assert.match(r.text, /Doris/, '错误里应列出已配置连接名（连接名不是凭据）');
    assert.doesNotMatch(r.text, /ECONNREFUSED|connect\s+ECONN/i, '必须在连真实库之前就拒绝');
  });
});
