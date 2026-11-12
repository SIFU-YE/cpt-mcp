// test/sql-check.test.js —— 数据集 SQL 实跑 + 列名对账（2026-10-26 P0-B）
//
// 不依赖真实数据库：只读围栏、参数代入、绑定扫描、列名 diff 都是纯逻辑；
// "未配置数据库连接"路径也要给出可操作指引（而不是崩）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCpt, addDataset, addCell } from '../lib/generate.js';
import {
  datasetSqlOf, datasetBindings, extractTokens, substituteParams, diffBindings, checkDatasetSql,
  resolveSqlCheckTarget, checkDatasetSqlAuto, SQL_CHECK_TARGETS,
} from '../lib/sql-check.js';
import { createLocalDb, dropLocalDb } from '../lib/localdb.js';
import { importDdlIntoLocalDb, seedLocalDb } from '../lib/localdb-import.js';
import { isReadOnlySql, listConnections, resolveConnection } from '../lib/db.js';
import '../scripts/isolate-store.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-sql-'));

/** 临时改 env（含删除），结束后完整恢复：含测试体内删掉的 CPT_DB_ 前缀变量与 CPT_MCP_SQL_TARGET 及其别名 */
async function withEnv(patch, fn) {
  const snapshot = new Map();
  const remember = (k) => {
    if (!snapshot.has(k)) snapshot.set(k, Object.prototype.hasOwnProperty.call(process.env, k) ? process.env[k] : undefined);
  };
  for (const k of Object.keys(process.env)) {
    if (k.startsWith('CPT_DB_') || k === 'CPT_MCP_SQL_TARGET' || k === 'CPT_MCP_SQL_TEST_TARGET') remember(k);
  }
  for (const [k, v] of Object.entries(patch)) {
    remember(k);
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of snapshot.entries()) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

function writeSettings(cwd, settings) {
  fs.mkdirSync(path.join(cwd, '.cpt-mcp'), { recursive: true });
  fs.writeFileSync(path.join(cwd, '.cpt-mcp', 'localdb.json'), JSON.stringify({ settings }), 'utf8');
}

/** 造一个带 SQL 数据集 + dsColumn 绑定的模板 */
function fixture(sql = 'SELECT sku_code, sku_name FROM bi_ods.t') {
  const d = tmp();
  const p = path.join(d, 'a.cpt');
  createCpt(p, { rows: 4, columns: 4 });
  addDataset(p, { name: 'ds1', connection: 'Doris', sql });
  addCell(p, { column: 0, row: 1, contentType: 'dsColumn', dsName: 'ds1', columnName: 'sku_code' });
  addCell(p, { column: 1, row: 1, contentType: 'dsColumn', dsName: 'ds1', columnName: 'sku_name' });
  return { dir: d, path: p };
}

// ---------- 只读围栏 ----------

test('只读围栏·允许 SELECT/WITH/SHOW/DESC/EXPLAIN', () => {
  for (const sql of [
    'SELECT 1',
    'select * from t where a = 1',
    'WITH x AS (SELECT 1) SELECT * FROM x',
    'SHOW TABLES',
    'DESC bi_ods.t',
    'EXPLAIN SELECT 1',
    'SELECT 1 -- 注释里有 delete 字样',
    "SELECT 'insert into t' AS s",
  ]) {
    assert.equal(isReadOnlySql(sql).ok, true, `应允许：${sql}`);
  }
});

test('只读围栏·拒绝写语句与多语句', () => {
  assert.equal(isReadOnlySql('INSERT INTO t VALUES (1)').ok, false);
  assert.equal(isReadOnlySql('UPDATE t SET a=1').ok, false);
  assert.equal(isReadOnlySql('DELETE FROM t').ok, false);
  assert.equal(isReadOnlySql('DROP TABLE t').ok, false);
  assert.equal(isReadOnlySql('SELECT 1; DROP TABLE t').ok, false, '多语句必须拒绝');
  assert.equal(isReadOnlySql('SELECT 1 /* x */; SELECT 2').ok, false);
  assert.equal(isReadOnlySql('  ').ok, false);
  assert.match(isReadOnlySql('UPDATE t SET a=1').reason, /只读/);
});

// ---------- 参数代入 ----------

test('参数·${name} 代入并记录用到哪些；公式型参数如实标记为未解析', () => {
  const r = substituteParams(
    "SELECT * FROM t WHERE dt >= '${start}' AND n = ${n} ${if(len(k)>0,\" AND k='\"+k+\"'\",\"\")}",
    { start: '2026-01-01', n: 10 },
  );
  assert.match(r.sql, /dt >= '2026-01-01'/);  // 模板自带引号，代入值不再加引号
  assert.match(r.sql, /n = 10/);
  assert.deepEqual(Object.keys(r.used).sort(), ['n', 'start']);
  assert.equal(r.unresolved.length, 1, '公式型参数应报未解析');
  assert.match(r.unresolved[0].raw, /\$\{if\(/);
});

test('参数·缺参数时原样保留并标记原因；空值代入 NULL；单引号转义', () => {
  const missing = substituteParams('SELECT ${a}', {});
  assert.equal(missing.unresolved[0].raw, '${a}');
  assert.match(missing.unresolved[0].reason, /未提供/);

  assert.match(substituteParams('SELECT ${a}', { a: null }).sql, /NULL/);
  assert.match(substituteParams("SELECT '${a}'", { a: "O'Neil" }).sql, /'O''Neil'/);
});

test('参数·extractTokens 能数出全部令牌', () => {
  const t = extractTokens('SELECT ${a}, ${b} FROM t WHERE x=${if(a>0,"1","0")}');
  assert.equal(t.length, 3);
  assert.deepEqual(t.map((x) => x.inner), ['a', 'b', 'if(a>0,"1","0")']);
});

// ---------- 模板读取 ----------

test('模板·datasetSqlOf 取到 SQL/连接；datasetBindings 扫出 dsColumn 绑定与引用单元格', () => {
  const { dir, path: p } = fixture();
  try {
    const ds = datasetSqlOf(p);
    assert.equal(ds.dataset, 'ds1');
    assert.equal(ds.connection, 'Doris');
    assert.match(ds.sql, /FROM bi_ods\.t/);

    const bindings = datasetBindings(p);
    const cols = bindings.get('ds1');
    assert.ok(cols, '应扫到 ds1 的绑定');
    assert.deepEqual([...cols.keys()].sort(), ['sku_code', 'sku_name']);
    assert.match(cols.get('sku_code')[0], /^sheet1!R\d+C\d+$/, '要能定位到具体单元格');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('模板·未找到数据集时给出可选清单', () => {
  const { dir, path: p } = fixture();
  try {
    assert.throws(() => datasetSqlOf(p, 'dsX'), /未找到数据集 "dsX"（现有：ds1）/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- 列名对账 ----------

test('对账·SQL 少返回的列必须点名（运行时会空白），多返回的列提示但不算错', () => {
  const bound = new Map([['sku_code', ['sheet1!R1C0']], ['sku_name', ['sheet1!R1C1']], ['brand', ['sheet1!R1C2']]]);
  const diff = diffBindings(bound, ['SKU_CODE', 'sku_name', 'extra_col']);
  assert.equal(diff.matched, 2, 'sku_code（大小写不敏感）与 sku_name 都算匹配，brand 缺列');
  assert.deepEqual(diff.missingInSql.map((m) => m.column), ['brand']);
  assert.deepEqual(diff.unboundInSql, ['extra_col']);
});

// ---------- 未配置数据库时的行为 ----------

test('未配置数据库连接·execError 给出配置指引而不是崩', async () => {
  const { dir, path: p } = fixture();
  const saved = { ...process.env };
  for (const k of Object.keys(process.env)) {
    if (k.startsWith('CPT_DB_')) delete process.env[k];
  }
  // 本机可能存在 ~/.cpt-mcp/db-connections.json（真实用户配置），用例必须隔离
  process.env.CPT_DB_DISABLE_CONFIG_FILES = '1';
  try {
    assert.deepEqual(listConnections(), {}, '测试环境不应有连接配置');
    const r = await checkDatasetSql({ cptPath: p, maxRows: 5 });
    assert.equal(r.ok, false);
    assert.match(r.execError, /数据库连接未配置/);
    assert.ok(r.hints.some((h) => /执行失败/.test(h)));
    assert.equal(r.execution, null);
  } finally {
    for (const k of Object.keys(process.env)) if (k.startsWith('CPT_DB_')) delete process.env[k];
    Object.assign(process.env, saved);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('未配置数据库连接·resolveConnection 指引包含四种配置写法', () => {
  const saved = process.env.CPT_DB_CONNECTIONS;
  delete process.env.CPT_DB_CONNECTIONS;
  process.env.CPT_DB_DISABLE_CONFIG_FILES = '1';
  try {
    assert.throws(() => resolveConnection('Doris'), /CPT_DB_CONNECTIONS[\s\S]*\.cpt-mcp[\s\S]*CPT_DB_CONN_FILE/);
  } finally {
    delete process.env.CPT_DB_DISABLE_CONFIG_FILES;
    if (saved !== undefined) process.env.CPT_DB_CONNECTIONS = saved;
  }
});

test('有未解析参数时默认不执行，并提示 force（避免拿错 SQL 打生产库）', async () => {
  const { dir, path: p } = fixture('SELECT * FROM t WHERE dt = ${start}');
  const saved = process.env.CPT_DB_CONNECTIONS;
  process.env.CPT_DB_CONNECTIONS = JSON.stringify({ Doris: { host: '127.0.0.1', port: 1, user: 'u', password: 'p' } });
  try {
    const r = await checkDatasetSql({ cptPath: p, maxRows: 5 });
    assert.equal(r.ok, false);
    assert.equal(r.execution, null);
    assert.equal(r.executed, false);
    assert.match(r.skippedReason, /force=true/);
    assert.equal(r.unresolvedParams.length, 1);
    assert.ok(r.hints.some((h) => /force=true/.test(h)));
  } finally {
    if (saved === undefined) delete process.env.CPT_DB_CONNECTIONS; else process.env.CPT_DB_CONNECTIONS = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 2026-11-04：SQLite 测试模式默认口径 —— 默认 local，真实库显式
// ---------------------------------------------------------------------------

test('resolveSqlCheckTarget：显式 > env > localdb.json settings > 默认 local；非法值逐级回退', async () => {
  const cwd = tmp();
  try {
    await withEnv({ CPT_MCP_SQL_TARGET: undefined, CPT_MCP_SQL_TEST_TARGET: undefined }, async () => {
      // 无配置 → 默认 local（2026-11-04 用户口径：真实库显式）
      assert.deepEqual(resolveSqlCheckTarget({ cwd }), { target: 'local', source: 'default' });
      // 配置文件 settings.sqlTestTarget
      writeSettings(cwd, { sqlTestTarget: 'both' });
      assert.deepEqual(resolveSqlCheckTarget({ cwd }), { target: 'both', source: 'config' });
      // env 覆盖 config
      process.env.CPT_MCP_SQL_TARGET = 'real';
      assert.deepEqual(resolveSqlCheckTarget({ cwd }), { target: 'real', source: 'env' });
      // 显式参数覆盖 env
      assert.deepEqual(resolveSqlCheckTarget({ target: 'local', cwd }), { target: 'local', source: 'explicit' });
      // 非法显式值忽略 → 下一级 env
      assert.deepEqual(resolveSqlCheckTarget({ target: 'nonsense', cwd }), { target: 'real', source: 'env' });
      // 非法 env 忽略 → config
      process.env.CPT_MCP_SQL_TARGET = 'bogus';
      assert.deepEqual(resolveSqlCheckTarget({ cwd }), { target: 'both', source: 'config' });
      // 非法 config 忽略 → default local（不能因为回退默认值被误判成 source=config）
      writeSettings(cwd, { sqlTestTarget: 'BOGUS' });
      delete process.env.CPT_MCP_SQL_TARGET;
      assert.deepEqual(resolveSqlCheckTarget({ cwd }), { target: 'local', source: 'default' });
      // 配置非法 JSON 也不抛（readLocalDbSettings 兜底）
      fs.writeFileSync(path.join(cwd, '.cpt-mcp', 'localdb.json'), '{oops', 'utf8');
      assert.deepEqual(resolveSqlCheckTarget({ cwd }), { target: 'local', source: 'default' });
      // 兼容别名 CPT_MCP_SQL_TEST_TARGET（旧名）：主名未设时生效
      process.env.CPT_MCP_SQL_TEST_TARGET = 'both';
      assert.deepEqual(resolveSqlCheckTarget({ cwd }), { target: 'both', source: 'env' }, '旧 env 名应兼容');
      // 主名优先于别名
      process.env.CPT_MCP_SQL_TARGET = 'real';
      assert.deepEqual(resolveSqlCheckTarget({ cwd }), { target: 'real', source: 'env' });
      delete process.env.CPT_MCP_SQL_TARGET;
      delete process.env.CPT_MCP_SQL_TEST_TARGET;
    });
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
  assert.deepEqual([...SQL_CHECK_TARGETS], ['local', 'real', 'both']);
});

test('默认 target=local：本地库未初始化时返回 localDbReady:false + nextAction，不静默连真实库', async () => {
  const { dir, path: p } = fixture();
  const cwd = tmp();
  try {
    await withEnv({ CPT_MCP_SQL_TARGET: undefined, CPT_MCP_SQL_TEST_TARGET: undefined, CPT_DB_DISABLE_CONFIG_FILES: '1' }, async () => {
      assert.deepEqual(listConnections(), {}, '测试环境不应有真实连接配置');
      const r = await checkDatasetSqlAuto({ cptPath: p, localDb: 'definitely_missing_db_zz', cwd });
      assert.equal(r.target, 'local', '缺省 target 必须是 local');
      assert.equal(r.targetSource, 'default');
      assert.equal(r.targetRequested, null);
      assert.equal(r.targetEffective, 'local');
      assert.equal(r.localDbReady, false);
      assert.equal(r.ok, false);
      assert.equal(r.executed, false);
      assert.equal(r.execution ?? null, null);
      // 结构化 nextAction：先 local_db_admin create 再 local_db_import auto
      assert.match(r.nextAction, /local_db_admin/);
      assert.match(r.nextAction, /action: "create"/);
      assert.match(r.nextAction, /local_db_import/);
      assert.match(r.nextAction, /action: "auto"/);
      assert.match(r.nextAction, /target:\s?"real"/, '应说明真实库要显式指定');
      // 完全没有触达真实库（连配置都没读失败）——本地通道的 error 是"库不存在"而不是连接错误
      assert.equal(r.execError ?? null, null);
      assert.match(String(r.error), /不存在/);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('显式 target=local 且本地库已建：checkDatasetSqlAuto 走本地通道并返回 localDbReady:true', async () => {
  const { dir, path: p } = fixture('SELECT sku_code, sku_name FROM ods_sku WHERE qty > 0');
  const db = `sql_auto_${Date.now().toString(36)}`;
  const cwd = tmp();
  createLocalDb(db);
  try {
    importDdlIntoLocalDb({ db, ddl: 'CREATE TABLE ods_sku (sku_code varchar(32) NOT NULL, sku_name varchar(64), qty int);' });
    seedLocalDb({ db, table: 'ods_sku', rows: [{ sku_code: 'S1', sku_name: '甲', qty: 1 }] });
    await withEnv({ CPT_MCP_SQL_TARGET: 'real' }, async () => {
      // 显式 local 覆盖 env=real（真实库不可用也不影响本地通道）
      const r = await checkDatasetSqlAuto({ cptPath: p, target: 'local', offline: true, localDb: db, cwd });
      assert.equal(r.target, 'local');
      assert.equal(r.targetSource, 'explicit');
      assert.equal(r.targetRequested, 'local');
      assert.equal(r.localDbReady, true);
      assert.equal(r.ok, true, JSON.stringify(r.execError ?? r.prepared?.error));
      assert.deepEqual(r.prepared.columns, ['sku_code', 'sku_name']);
      assert.equal(r.executed, false);
    });
  } finally {
    dropLocalDb(db, { confirm: true });
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('env CPT_MCP_SQL_TARGET=real：真实库显式通道（未配置连接时给可读错误，而非本地结果）', async () => {
  const { dir, path: p } = fixture();
  try {
    await withEnv({ CPT_MCP_SQL_TARGET: 'real', CPT_DB_DISABLE_CONFIG_FILES: '1' }, async () => {
      for (const k of Object.keys(process.env)) if (k.startsWith('CPT_DB_') && k !== 'CPT_DB_DISABLE_CONFIG_FILES') delete process.env[k];
      const r = await checkDatasetSqlAuto({ cptPath: p, maxRows: 5 });
      assert.equal(r.target, 'real');
      assert.equal(r.targetSource, 'env');
      assert.equal(r.ok, false);
      assert.match(String(r.execError), /数据库连接未配置/);
      assert.equal(r.localDbReady, undefined, '真实库通道不返回本地库就绪字段');
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
