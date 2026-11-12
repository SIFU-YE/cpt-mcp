// test/localdb-core.test.js —— 内置 SQLite 本地测试库：核心/安全/快照/导出（2026-11-02）
//
// 全部在临时目录（isolate-store 已把 CPT_MCP_LOCALDB_DIR 指到 mkdtemp）里跑，
// 不碰用户真实工程目录、不连真实数据库。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import '../scripts/isolate-store.mjs';
import {
  sqliteInfo, localDbRoot, localDbPath, isValidDbName, createLocalDb, dropLocalDb,
  runLocalSql, openLocalDb, closeLocalDb, getLocalDbStatus, listLocalDbFiles, snapshotLocalDb,
  restoreLocalDb, exportLocalDbSql, resolveLocalDbName, updateLocalDbConfig, localSchemaHash,
  executeLocalScript, assertUserSqlAllowed, classifySqliteError,
  readLocalDbSettings, LOCAL_DB_SETTINGS_DEFAULTS,
} from '../lib/localdb.js';
import { importSqlIntoLocalDb, seedLocalDb } from '../lib/localdb-import.js';

let seq = 0;
function freshDbName(prefix = 't') {
  seq += 1;
  return `${prefix}${seq}_${Date.now().toString(36)}`.slice(0, 60);
}

test('node:sqlite 可用且版本可读（Node 24 内置，无 npm 依赖）', () => {
  const info = sqliteInfo();
  assert.equal(info.available, true, `node:sqlite 应可用：${info.error ?? ''}`);
  assert.match(String(info.sqliteVersion), /^\d+\.\d+/);
});

test('库根目录/库名围栏：env 隔离生效、非法名与路径逃逸被拒', () => {
  assert.equal(localDbRoot(), process.env.CPT_MCP_LOCALDB_DIR);
  assert.equal(isValidDbName('main'), true);
  assert.equal(isValidDbName('测试库_1'), true);
  for (const bad of ['', '../x', 'a/b', 'a b', '.', '..', 'x'.repeat(80)]) {
    assert.equal(isValidDbName(bad), false, `应拒绝库名：${JSON.stringify(bad)}`);
    assert.throws(() => localDbPath(bad), /库名非法|路径越界/, `应拒绝库名：${bad}`);
  }
});

test('建库/状态/列表：文件落在根内，配置与 schemaHash 可读', () => {
  const db = freshDbName('core');
  const created = createLocalDb(db);
  assert.equal(created.created, true);
  assert.ok(fs.existsSync(created.file));
  assert.ok(fs.realpathSync(created.file).startsWith(fs.realpathSync(localDbRoot())));
  const status = getLocalDbStatus(db);
  assert.equal(status.db.name, db);
  assert.equal(status.db.tables, 0);
  assert.match(status.db.schemaHash, /^[0-9a-f]{16}$/);
  const all = getLocalDbStatus();
  assert.ok(all.dbs.some((d) => d.name === db));
  assert.ok(listLocalDbFiles().some((f) => f.name === db));
  dropLocalDb(db, { confirm: true });
});

test('本地完整权限：DDL/DML/查询/位置参数/事务脚本', () => {
  const db = freshDbName('crud');
  createLocalDb(db);
  assert.equal(runLocalSql(db, 'CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT, qty NUMERIC)', { write: true }).ok, true);
  assert.equal(runLocalSql(db, "INSERT INTO t (name, qty) VALUES ('a', 1.5)", { write: true }).ok, true);
  const ins = runLocalSql(db, 'INSERT INTO t (name, qty) VALUES (?, ?)', { write: true, params: ['b', 2] });
  assert.equal(ins.changes, 1);
  const rows = runLocalSql(db, "SELECT id, name, qty FROM t WHERE name IN ('a','b') ORDER BY id");
  assert.deepEqual(rows.rows.map((r) => r.name), ['a', 'b']);
  assert.equal(rows.columns.length, 3);
  assert.equal(rows.truncated, false);
  const upd = runLocalSql(db, "UPDATE t SET qty = qty + 10 WHERE name = 'a'", { write: true });
  assert.equal(upd.changes, 1);
  const del = runLocalSql(db, "DELETE FROM t WHERE name = 'b'", { write: true });
  assert.equal(del.changes, 1);
  // 多语句脚本 + 事务
  const script = executeLocalScript(db, "CREATE TABLE s (x TEXT); INSERT INTO s VALUES ('1'); INSERT INTO s VALUES ('2');");
  assert.equal(script.executed, 3);
  assert.equal(runLocalSql(db, 'SELECT COUNT(*) AS n FROM s').rows[0].n, 2);
  dropLocalDb(db, { confirm: true });
});

test('查询通道只读：写 SQL 被前置围栏拒绝、只读连接写库被 SQLite 拒绝', () => {
  const db = freshDbName('ro');
  createLocalDb(db);
  runLocalSql(db, 'CREATE TABLE t (a TEXT)', { write: true });
  assert.throws(() => runLocalSql(db, "INSERT INTO t VALUES ('x')"), /只读查询通道/);
  const ro = openLocalDb(db, {});
  try {
    assert.throws(() => ro.exec("INSERT INTO t VALUES ('x')"), /readonly|not authorized|只读/i);
  } finally { closeLocalDb(ro); }
  dropLocalDb(db, { confirm: true });
});

test('安全围栏：ATTACH/PRAGMA/多语句被拒（授权器 + 语句白名单双保险）', () => {
  const db = freshDbName('sec');
  createLocalDb(db);
  const outside = path.join(process.env.CPT_MCP_LOCALDB_DIR, '..', 'outside.sqlite');
  // ① 用户入口白名单
  assert.throws(() => runLocalSql(db, `ATTACH DATABASE '${outside.replace(/'/g, "''")}' AS x`, { write: true }), /拒绝执行|ATTACH/i);
  assert.throws(() => runLocalSql(db, 'PRAGMA journal_mode = WAL', { write: true }), /拒绝执行/);
  assert.throws(() => runLocalSql(db, 'CREATE TABLE a (x); CREATE TABLE b (y);', { write: true }), /一次只执行一条/);
  // ② 授权器（绕过入口直接 exec，模拟内部/注入路径）
  const w = openLocalDb(db, { write: true });
  try {
    assert.throws(() => w.exec(`ATTACH DATABASE '${outside.replace(/'/g, "''")}' AS x`), /not authorized|authorized/i);
    assert.throws(() => w.exec('PRAGMA journal_mode = DELETE'), /not authorized|authorized/i);
  } finally { closeLocalDb(w); }
  assert.equal(classifySqliteError('no such table: t').kind, 'missing-table');
  assert.equal(classifySqliteError('no such column: x').kind, 'missing-column');
  assert.equal(classifySqliteError('near "FROM": syntax error').kind, 'syntax');
  dropLocalDb(db, { confirm: true });
});

test('方言改写入口：MySQL 常用写法可在本地执行（CONCAT/IF/DATE_FORMAT/反引号/HASH 注释）', () => {
  const db = freshDbName('dialect');
  createLocalDb(db);
  runLocalSql(db, 'CREATE TABLE `t` (`d` TEXT, `n` INT)', { write: true });
  runLocalSql(db, "INSERT INTO `t` VALUES ('2026-01-02 03:04:05', 0)", { write: true });
  const r = runLocalSql(db, [
    '# MySQL hash comment',
    "SELECT DATE_FORMAT(`d`, '%Y-%m-%d') AS dd, IF(`n` = 0, 'zero', 'other') AS f,",
    "CONCAT('a', 'b') AS c FROM `t`",
  ].join('\n'));
  assert.equal(r.ok, true);
  assert.equal(r.rows[0].dd, '2026-01-02');
  assert.equal(r.rows[0].f, 'zero');
  assert.equal(r.rows[0].c, 'ab');
  dropLocalDb(db, { confirm: true });
});

test('快照/恢复：snapshot 后继续写，restore 回到快照状态', async () => {
  const db = freshDbName('snap');
  createLocalDb(db);
  runLocalSql(db, 'CREATE TABLE t (a INTEGER)', { write: true });
  runLocalSql(db, 'INSERT INTO t VALUES (1)', { write: true });
  const snap = await snapshotLocalDb(db, 'v1');
  assert.ok(fs.existsSync(snap.file));
  runLocalSql(db, 'INSERT INTO t VALUES (2)', { write: true });
  assert.equal(runLocalSql(db, 'SELECT COUNT(*) AS n FROM t').rows[0].n, 2);
  await restoreLocalDb(db, 'v1');
  assert.equal(runLocalSql(db, 'SELECT COUNT(*) AS n FROM t').rows[0].n, 1);
  dropLocalDb(db, { confirm: true });
});

test('导出 SQL 可重建（round-trip）：schema.sql/data.sql → 新库导入后数据一致', () => {
  const db = freshDbName('exp');
  createLocalDb(db);
  runLocalSql(db, 'CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT, qty NUMERIC, b BLOB)', { write: true });
  runLocalSql(db, "INSERT INTO t (name, qty, b) VALUES ('张三', 19.9, X'0102')", { write: true });
  const exp = exportLocalDbSql(db, { includeData: true });
  assert.ok(fs.existsSync(exp.files.schema));
  assert.ok(fs.existsSync(exp.files.data));
  const schemaText = fs.readFileSync(exp.files.schema, 'utf8');
  const dataText = fs.readFileSync(exp.files.data, 'utf8');
  assert.match(schemaText, /CREATE TABLE "?t"?/);
  assert.match(dataText, new RegExp(`INSERT INTO "?t"?`));
  const db2 = freshDbName('exp2');
  createLocalDb(db2);
  importSqlIntoLocalDb({ db: db2, sql: schemaText });
  importSqlIntoLocalDb({ db: db2, sql: dataText });
  const rows = runLocalSql(db2, 'SELECT id, name, qty FROM t').rows;
  assert.deepEqual(rows.map((r) => ({ id: r.id, name: r.name })), [{ id: 1, name: '张三' }]);
  dropLocalDb(db, { confirm: true });
  dropLocalDb(db2, { confirm: true });
});

test('连接名→本地库映射：配置 sourceConnection 命中优先，否则回落 default', () => {
  const db = freshDbName('map');
  createLocalDb(db);
  updateLocalDbConfig({ default: db, databases: { [db]: { file: `${db}.sqlite`, sourceConnection: 'Doris' } } });
  assert.equal(resolveLocalDbName({ connection: 'Doris' }).name, db);
  assert.equal(resolveLocalDbName({ connection: 'doris' }).name, db, '连接名大小写不敏感');
  assert.equal(resolveLocalDbName({ connection: 'MySQL2' }).source, 'default');
  assert.equal(resolveLocalDbName({}).name, db);
  updateLocalDbConfig({ databases: { [db]: { sourceConnection: 'Doris' } } });
  dropLocalDb(db, { confirm: true });
});

test('删库需显式确认；reset 语义 = confirm + 重建空库', () => {
  const db = freshDbName('drop');
  createLocalDb(db);
  runLocalSql(db, 'CREATE TABLE t (a INTEGER)', { write: true });
  assert.throws(() => dropLocalDb(db), /confirm/i);
  assert.equal(fs.existsSync(localDbPath(db)), true);
  dropLocalDb(db, { confirm: true });
  assert.equal(fs.existsSync(localDbPath(db)), false);
});

test('schemaHash 随结构变化，数据变化不影响', () => {
  const db = freshDbName('hash');
  createLocalDb(db);
  runLocalSql(db, 'CREATE TABLE t (a INTEGER)', { write: true });
  const h1 = localSchemaHash(db);
  runLocalSql(db, 'INSERT INTO t VALUES (1)', { write: true });
  assert.equal(localSchemaHash(db), h1, '仅数据变化不应改变结构指纹');
  runLocalSql(db, 'ALTER TABLE t ADD COLUMN b TEXT', { write: true });
  assert.notEqual(localSchemaHash(db), h1);
  dropLocalDb(db, { confirm: true });
});

test('seed 造数：insert/replace/upsert 与未知列报错', () => {
  const db = freshDbName('seed');
  createLocalDb(db);
  runLocalSql(db, 'CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)', { write: true });
  seedLocalDb({ db, table: 't', rows: [{ id: 1, name: 'a' }, { id: 2, name: 'b' }] });
  assert.equal(runLocalSql(db, 'SELECT COUNT(*) AS n FROM t').rows[0].n, 2);
  seedLocalDb({ db, table: 't', rows: [{ id: 1, name: 'z' }], mode: 'upsert' });
  assert.equal(runLocalSql(db, 'SELECT name FROM t WHERE id=1').rows[0].name, 'z');
  seedLocalDb({ db, table: 't', rows: [{ id: 1, name: 'r' }], mode: 'replace' });
  assert.equal(runLocalSql(db, 'SELECT name FROM t WHERE id=1').rows[0].name, 'r');
  assert.throws(() => seedLocalDb({ db, table: 't', rows: [{ nope: 1 }] }), /未知列/);
  assert.throws(() => seedLocalDb({ db, table: 't', rows: [] }), /非空 rows/);
  dropLocalDb(db, { confirm: true });
});

test('assertUserSqlAllowed：查询/写/多语句/危险语句口径', () => {
  assert.equal(assertUserSqlAllowed('SELECT 1'), 'SELECT 1');
  assert.throws(() => assertUserSqlAllowed('INSERT INTO t VALUES (1)'), /只读查询通道/);
  assert.equal(assertUserSqlAllowed('INSERT INTO t VALUES (1)', { write: true }), 'INSERT INTO t VALUES (1)');
  assert.throws(() => assertUserSqlAllowed('SELECT 1; SELECT 2'), /一次只执行一条/);
  assert.throws(() => assertUserSqlAllowed('VACUUM'), /拒绝执行/);
  assert.throws(() => assertUserSqlAllowed('PRAGMA table_info(t)'), /拒绝执行/);
});

// ---------------------------------------------------------------------------
// 2026-11-04：localdb.json 的 settings 段（默认 local / 抽样上限）安全读取
// ---------------------------------------------------------------------------

const SETTINGS_TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-localdb-settings-'));

function writeLocalDbJson(dir, content) {
  fs.mkdirSync(path.join(dir, '.cpt-mcp'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.cpt-mcp', 'localdb.json'), typeof content === 'string' ? content : JSON.stringify(content), 'utf8');
}

test('readLocalDbSettings：文件不存在/非法 JSON/非法字段 → 逐字段回退默认，绝不抛错', () => {
  const dir = path.join(SETTINGS_TMP, 'defaults');
  fs.mkdirSync(dir, { recursive: true });
  const def = readLocalDbSettings({ cwd: dir });
  assert.equal(def.sqlTestTarget, 'local');
  assert.equal(def.sampleRows, 200);
  assert.equal(def.maxTotal, 5000);
  assert.equal(def.autoSample, true);
  assert.equal(def.settingsExists, false);
  assert.deepEqual(def.provided, []);
  assert.equal(def.settingsFile, path.join(dir, '.cpt-mcp', 'localdb.json'));
  assert.deepEqual({ sqlTestTarget: LOCAL_DB_SETTINGS_DEFAULTS.sqlTestTarget }, { sqlTestTarget: 'local' });

  // 非法 JSON → 默认（不抛）
  const bad = path.join(SETTINGS_TMP, 'bad-json');
  writeLocalDbJson(bad, '{ this is not json ');
  assert.doesNotThrow(() => readLocalDbSettings({ cwd: bad }));
  assert.deepEqual(
    (({ sqlTestTarget, sampleRows, maxTotal, autoSample }) => ({ sqlTestTarget, sampleRows, maxTotal, autoSample }))(readLocalDbSettings({ cwd: bad })),
    { sqlTestTarget: 'local', sampleRows: 200, maxTotal: 5000, autoSample: true },
  );

  // 顶层是数组 / settings 不是对象 / 字段类型全错 → 默认
  const weird = path.join(SETTINGS_TMP, 'weird');
  writeLocalDbJson(weird, '[]');
  assert.equal(readLocalDbSettings({ cwd: weird }).sqlTestTarget, 'local');
  writeLocalDbJson(weird, { settings: 'nope' });
  assert.equal(readLocalDbSettings({ cwd: weird }).sqlTestTarget, 'local');
  writeLocalDbJson(weird, { settings: { sqlTestTarget: 'nope', sampleRows: 'abc', maxTotal: 'x', autoSample: 'yes' } });
  const w = readLocalDbSettings({ cwd: weird });
  assert.equal(w.sqlTestTarget, 'local');
  assert.equal(w.sampleRows, 200);
  assert.equal(w.maxTotal, 5000);
  assert.equal(w.autoSample, true);
  assert.deepEqual(w.provided, []);
});

test('readLocalDbSettings：合法 settings 生效（大小写归一/超限收敛/双上限自洽），provided 记录来源字段', () => {
  const dir = path.join(SETTINGS_TMP, 'valid');
  writeLocalDbJson(dir, {
    settings: { sqlTestTarget: 'REAL', sampleRows: 50, maxTotal: 100, autoSample: false },
  });
  const s = readLocalDbSettings({ cwd: dir });
  assert.equal(s.sqlTestTarget, 'real', '合法值应大小写归一');
  assert.equal(s.sampleRows, 50);
  assert.equal(s.maxTotal, 100);
  assert.equal(s.autoSample, false);
  assert.equal(s.settingsExists, true);
  assert.deepEqual([...s.provided].sort(), ['autoSample', 'maxTotal', 'sampleRows', 'sqlTestTarget']);

  // 超限收敛：sampleRows >5000、maxTotal >200000
  writeLocalDbJson(dir, { settings: { sampleRows: 99999, maxTotal: 99999999 } });
  const clamped = readLocalDbSettings({ cwd: dir });
  assert.equal(clamped.sampleRows, 5000);
  assert.equal(clamped.maxTotal, 200000);

  // 双上限自洽：maxTotal < sampleRows → 抬到 sampleRows
  writeLocalDbJson(dir, { settings: { sampleRows: 100, maxTotal: 10 } });
  const fixed = readLocalDbSettings({ cwd: dir });
  assert.equal(fixed.sampleRows, 100);
  assert.equal(fixed.maxTotal, 100);

  // root 变体：root = 本地库根目录（与 CPT_MCP_LOCALDB_DIR 同义）→ 配置文件在 root 的父目录
  const rootBase = path.join(SETTINGS_TMP, 'root-variant');
  const root = path.join(rootBase, 'localdb');
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(rootBase, 'localdb.json'), JSON.stringify({ settings: { sqlTestTarget: 'both' } }), 'utf8');
  assert.equal(readLocalDbSettings({ root }).sqlTestTarget, 'both');
  assert.equal(readLocalDbSettings({ root }).settingsFile, path.join(rootBase, 'localdb.json'));
});
