// test/localdb-import.test.js —— 真实库使用情况扫描 / DDL 导入 / 数据导入失败路径（2026-11-02）
// 不连真实数据库：真实库相关只测「未配置连接时的可读报错」与纯逻辑扫描。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import '../scripts/isolate-store.mjs';
import { createCpt, addDataset } from '../lib/generate.js';
import {
  extractTableRefs, collectTemplateTableUsage, findCptFiles,
  importDdlIntoLocalDb, importSchemaFromDb, importDataFromDb, listRealTables, seedLocalDb,
  autoPrepareLocalDb, detectSensitiveColumns,
} from '../lib/localdb-import.js';
import { createLocalDb, dropLocalDb, runLocalSql, listLocalTables, localDbPath } from '../lib/localdb.js';

let seq = 0;
function freshDbName(prefix = 'imp') {
  seq += 1;
  return `${prefix}${seq}_${Date.now().toString(36)}`.slice(0, 60);
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-localdb-imp-'));

test('extractTableRefs：FROM/JOIN/库名限定/反引号/子查询/字符串噪声', () => {
  const sql = `
    SELECT a.x, b.y FROM \`bi_ods\`.\`ods_order\` a
    JOIN ods_user b ON a.uid = b.id
    WHERE a.note = 'from fake_table join fake2'
      AND a.dt >= '${'{start}'}'
    UNION ALL
    SELECT * FROM (SELECT 1 FROM inner_t) t
  `;
  const refs = extractTableRefs(sql);
  assert.ok(refs.includes('ods_order'));
  assert.ok(refs.includes('ods_user'));
  assert.ok(!refs.includes('fake_table'), '字符串里的表名不应被抓到');
  assert.ok(!refs.includes('fake2'));
  // 2026-11-07 P0：子查询里的表必须命中（旧实现反复去括号，只抓到外层/别名）
  assert.ok(refs.includes('inner_t'), `子查询里的表必须识别（实际 ${refs.join(',')}）`);
  assert.ok(!refs.includes('t'), '别名不是表');
});

test('extractTableRefs：EXISTS/IN 子查询、CTE、UNION、字符串/注释噪声全抓（2026-11-07 P0）', () => {
  // 用户实测：autoTables 漏 demo_permission（它在 EXISTS 子查询里是活引用）
  const sql = [
    'SELECT p.id FROM demo_fill_target p',
    "WHERE EXISTS (SELECT 1 FROM demo_permission n WHERE n.uid = p.uid AND n.note = 'from fake_t join fake2')",
    '  AND p.id IN (SELECT op.rid FROM demo_approval op WHERE op.ok = 1)',
    '  -- from fake3 join fake4',
    '  /* from fake5 */',
    'UNION ALL',
    'SELECT c.id FROM (SELECT * FROM inner_t) c',
  ].join('\n');
  const refs = extractTableRefs(sql);
  for (const t of ['demo_fill_target', 'demo_permission', 'demo_approval', 'inner_t']) {
    assert.ok(refs.includes(t), `必须抓到 ${t}（实际 ${refs.join(',')}）`);
  }
  for (const fake of ['fake_t', 'fake2', 'fake3', 'fake4', 'fake5']) {
    assert.ok(!refs.includes(fake), `字符串/注释里的 ${fake} 不应被抓`);
  }

  const cte = extractTableRefs('WITH base AS (SELECT * FROM pa_base) SELECT * FROM base JOIN pa_x ON base.id = pa_x.id');
  assert.ok(cte.includes('pa_base'), `CTE 体里的表要抓到（实际 ${cte.join(',')}）`);
  assert.ok(cte.includes('pa_x'), cte.join(','));

  const union = extractTableRefs('SELECT * FROM t1 UNION SELECT * FROM t2');
  assert.deepEqual(union.slice().sort(), ['t1', 't2']);

  const deep = extractTableRefs('SELECT * FROM (SELECT * FROM (SELECT * FROM deep_t) a) b');
  assert.deepEqual(deep, ['deep_t'], deep.join(','));

  // EXTRACT/TRIM/SUBSTRING 的 FROM 是函数参数，不是表位
  const fn = extractTableRefs("SELECT EXTRACT(YEAR FROM dt), TRIM(BOTH 'x' FROM col), SUBSTRING(s FROM 1) FROM real_t");
  assert.deepEqual(fn, ['real_t'], fn.join(','));
});

test('collectTemplateTableUsage：嵌套子查询（EXISTS/IN）里的表也计入 autoTables 清单（2026-11-07 P0）', () => {
  const dir = tmp();
  try {
    const p = path.join(dir, 'nested.cpt');
    createCpt(p, { rows: 3, columns: 3 });
    addDataset(p, {
      name: 'ds1',
      connection: 'Doris',
      sql: [
        'SELECT p.id FROM demo_fill_target p',
        'WHERE EXISTS (SELECT 1 FROM demo_permission n WHERE n.uid = p.uid)',
        '  AND p.id IN (SELECT op.rid FROM demo_approval op WHERE op.ok = 1)',
      ].join('\n'),
    });
    const usage = collectTemplateTableUsage({ connection: 'Doris', root: dir });
    assert.deepEqual([...usage.tables].sort(), ['demo_approval', 'demo_fill_target', 'demo_permission']);
    assert.equal(usage.datasets.length, 1);
    assert.equal(usage.datasets[0].refs.length, 3);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('findCptFiles / collectTemplateTableUsage：按数据连接名过滤并汇总实际用表', () => {
  const dir = tmp();
  try {
    const p1 = path.join(dir, 'a.cpt');
    const p2 = path.join(dir, 'sub', 'b.cpt');
    fs.mkdirSync(path.dirname(p2), { recursive: true });
    createCpt(p1, { rows: 3, columns: 3 });
    addDataset(p1, { name: 'ds1', connection: 'Doris', sql: 'SELECT * FROM ods_a JOIN ods_b ON 1=1' });
    createCpt(p2, { rows: 3, columns: 3 });
    addDataset(p2, { name: 'ds2', connection: 'MySQL2', sql: 'SELECT * FROM mysql_only_t' });
    addDataset(p2, { name: 'ds3', connection: 'Doris', sql: 'SELECT * FROM ods_c' });
    const files = findCptFiles(dir);
    assert.equal(files.length, 2);
    const usage = collectTemplateTableUsage({ connection: 'Doris', root: dir });
    assert.deepEqual([...usage.tables].sort(), ['ods_a', 'ods_b', 'ods_c']);
    assert.equal(usage.files.length, 2);
    assert.ok(usage.datasets.every((d) => d.connection === 'Doris'));
    const all = collectTemplateTableUsage({ root: dir });
    assert.ok(all.tables.includes('mysql_only_t'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('importDdlIntoLocalDb：DDL 建表 + 复杂类型/索引可用，replace=false 跳过已有表', () => {
  const db = freshDbName('ddl');
  createLocalDb(db);
  try {
    const ddl = `CREATE TABLE \`ods_demo\` (
      \`id\` bigint NOT NULL AUTO_INCREMENT,
      \`name\` varchar(32) NOT NULL,
      \`qty\` decimal(10,2) DEFAULT '0.00',
      \`dt\` datetime DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (\`id\`),
      UNIQUE KEY \`uk_name\` (\`name\`)
    );`;
    const r = importDdlIntoLocalDb({ db, ddl, replace: true });
    assert.equal(r.ok, true);
    assert.deepEqual(r.imported.map((i) => i.table), ['ods_demo']);
    assert.ok(listLocalTables(db).includes('ods_demo'));
    const info = runLocalSql(db, 'SELECT name, type FROM pragma_table_info(?)', { params: ['ods_demo'] }).rows;
    assert.equal(info.find((c) => c.name === 'id').type, 'INTEGER');
    assert.equal(info.find((c) => c.name === 'qty').type, 'NUMERIC');
    runLocalSql(db, "INSERT INTO ods_demo (name, qty, dt) VALUES ('a', 1.5, '2026-01-02 03:04:05')", { write: true });
    assert.equal(runLocalSql(db, 'SELECT COUNT(*) AS n FROM ods_demo').rows[0].n, 1);
    // 统一索引名以表名开头，避免跨表冲突
    const idx = runLocalSql(db, "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='ods_demo'").rows.map((x) => x.name);
    assert.ok(idx.some((n) => n.includes('uk_name')));
    // replace=false：跳过已有表
    const skip = importDdlIntoLocalDb({ db, ddl, replace: false });
    assert.equal(skip.ok, false);
    assert.ok(skip.warnings.some((w) => /replace=false/.test(w)));
    // 2026-11-06 P0：replace 默认 false —— 不传参数也必须跳过已有表（绝不默认 DROP 重建）
    const skipByDefault = importDdlIntoLocalDb({ db, ddl });
    assert.equal(skipByDefault.ok, false, '默认不应重建已存在表');
    assert.ok(skipByDefault.warnings.some((w) => /replace=false（默认）/.test(w)), '默认跳过时应给出显式说明');
    // 且原表数据仍在（证明没有发生 DROP+重建）
    assert.equal(runLocalSql(db, 'SELECT COUNT(*) AS n FROM ods_demo').rows[0].n, 1);
  } finally {
    dropLocalDb(db, { confirm: true });
  }
});

test('importSchemaFromDb / importDataFromDb：未配置真实库连接时给出配置指引（不崩）', async () => {
  const saved = { ...process.env };
  for (const k of Object.keys(process.env)) if (k.startsWith('CPT_DB_')) delete process.env[k];
  process.env.CPT_DB_DISABLE_CONFIG_FILES = '1';
  const db = freshDbName('noconf');
  try {
    await assert.rejects(
      () => importSchemaFromDb({ db, connection: 'Doris', autoTables: false }),
      /数据库连接未配置|CPT_DB_CONNECTIONS/,
    );
    await assert.rejects(
      () => importDataFromDb({ db, connection: 'Doris' }),
      /数据库连接未配置|CPT_DB_CONNECTIONS/,
    );
    await assert.rejects(() => listRealTables('Doris'), /数据库连接未配置|CPT_DB_CONNECTIONS/);
  } finally {
    for (const k of Object.keys(process.env)) if (k.startsWith('CPT_DB_')) delete process.env[k];
    Object.assign(process.env, saved);
    dropLocalDb(db, { confirm: true }).catch?.(() => {});
  }
});

test('seedLocalDb：本地造数不依赖真实库（insert/upsert 已在 core 覆盖，这里验 DDL+seed 组合）', () => {
  const db = freshDbName('seed2');
  createLocalDb(db);
  try {
    importDdlIntoLocalDb({ db, ddl: 'CREATE TABLE t (id int PRIMARY KEY, name varchar(16), qty decimal(8,2));' });
    seedLocalDb({ db, table: 't', rows: [{ id: 1, name: 'A', qty: 1.25 }, { id: 2, name: 'B', qty: 2.5 }] });
    const rows = runLocalSql(db, 'SELECT id, name, qty FROM t ORDER BY id').rows;
    assert.deepEqual(rows.map((r) => r.name), ['A', 'B']);
    assert.equal(Number(rows[1].qty), 2.5);
  } finally {
    dropLocalDb(db, { confirm: true });
  }
});

// ---------------------------------------------------------------------------
// 2026-11-04：真实库按需自动抽样（auto action）—— 不连真实库，用 DDL + 注入伪只读通道验证
// ---------------------------------------------------------------------------

function settingsDir(settings = null) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-autodb-settings-'));
  if (settings) {
    fs.mkdirSync(path.join(dir, '.cpt-mcp'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.cpt-mcp', 'localdb.json'), JSON.stringify({ settings }), 'utf8');
  }
  return dir;
}

/** 造一个引用 table 的 .cpt（连接名 Doris） */
function cptUsing(dir, table = 'ods_sku') {
  const p = path.join(dir, `${table}-${Date.now().toString(36)}.cpt`);
  createCpt(p, { rows: 3, columns: 3 });
  addDataset(p, { name: 'ds1', connection: 'Doris', sql: `SELECT sku_code, sku_name FROM ${table} WHERE qty > 0` });
  return p;
}

test('detectSensitiveColumns：识别 name/mobile/phone/id_card/bank/email/address 等敏感列（只报列名）', () => {
  const cols = ['sku_code', 'name', 'user_name', 'mobile_no', 'phone', 'tel', 'id_card', 'bank_account', 'email', 'address', 'qty', 'remark'];
  const hit = detectSensitiveColumns(cols);
  for (const c of ['name', 'user_name', 'mobile_no', 'phone', 'tel', 'id_card', 'bank_account', 'email', 'address']) {
    assert.ok(hit.includes(c), `应识别敏感列 ${c}（实际 ${hit.join('、')}）`);
  }
  for (const c of ['sku_code', 'qty', 'remark']) assert.ok(!hit.includes(c), `${c} 不应误报`);
  // 中文列名
  const zh = detectSensitiveColumns(['客户姓名', '手机号', '身份证号', '家庭住址', '数量合计']);
  assert.deepEqual(zh.sort(), ['家庭住址', '手机号', '客户姓名', '身份证号'].sort());
  // 支持列对象数组 / 去重
  assert.deepEqual(detectSensitiveColumns([{ name: 'email' }, { name: 'email' }, { name: 'qty' }]), ['email']);
});

test('importDataFromDb：默认 sampleRows=200、只走只读 SELECT * LIMIT n、敏感列点名但回报体不回显值', async () => {
  const db = freshDbName('data_default');
  createLocalDb(db);
  const sqls = [];
  try {
    importDdlIntoLocalDb({
      db,
      ddl: 'CREATE TABLE ods_people (id int, name varchar(32), mobile varchar(20), qty int);',
    });
    const r = await importDataFromDb({
      db,
      connection: 'Doris',
      deps: {
        resolveConnection: () => ({ conn: { name: 'Doris' }, notice: null }),
        runSelectSql: async (_conn, sql, opts) => {
          sqls.push({ sql, maxRows: opts?.maxRows });
          const limit = Number((/LIMIT\s+(\d+)/i.exec(sql) || [])[1] || 0);
          const rows = Array.from({ length: Math.min(limit, 5) }, (_, i) => ({ id: i + 1, name: `n${i}`, mobile: `m${i}`, qty: i }));
          return { rows, truncated: false };
        },
      },
    });
    assert.equal(r.ok, true);
    assert.equal(r.sampleRows, 200, '2026-11-04 起 data 动作 sampleRows 默认 200（原 100）');
    assert.equal(sqls.length, 1);
    assert.match(sqls[0].sql, /^SELECT \* FROM `ods_people` LIMIT 200$/i, '抽样必须走只读 SELECT * LIMIT n');
    // 敏感列点名（不打印值）
    const text = JSON.stringify(r);
    assert.ok(r.warnings.some((w) => /疑似敏感列/.test(w) && /name/.test(w) && /mobile/.test(w)), JSON.stringify(r.warnings));
    assert.ok(!text.includes('n0') && !text.includes('m0'), '返回体不得回显任何敏感取值');
  } finally {
    dropLocalDb(db, { confirm: true });
  }
});

test('importDataFromDb：单表 sampleRows / 总量 maxTotal 双上限生效（limit 逐表收敛）', async () => {
  const db = freshDbName('data_cap');
  createLocalDb(db);
  const sqls = [];
  try {
    importDdlIntoLocalDb({
      db,
      ddl: 'CREATE TABLE ods_a (id int, qty int);\nCREATE TABLE ods_b (id int, qty int);',
    });
    const r = await importDataFromDb({
      db,
      connection: 'Doris',
      tables: ['ods_a', 'ods_b'],
      sampleRows: 2,
      maxTotal: 3,
      deps: {
        resolveConnection: () => ({ conn: {}, notice: null }),
        runSelectSql: async (_conn, sql) => {
          sqls.push(sql);
          const limit = Number((/LIMIT\s+(\d+)/i.exec(sql) || [])[1] || 0);
          return { rows: Array.from({ length: Math.min(limit, 5) }, (_, i) => ({ id: i + 1, qty: i })), truncated: false };
        },
      },
    });
    assert.deepEqual(r.tables.map((t) => t.rows), [2, 1], '第一张 2 行后第二张只剩 1 行额度');
    assert.equal(r.totalRows, 3);
    assert.equal(r.sampleRows, 2);
    assert.match(sqls[0], /LIMIT 2$/i);
    assert.match(sqls[1], /LIMIT 1$/i);
  } finally {
    dropLocalDb(db, { confirm: true });
  }
});

test('importDataFromDb：autoTables + path 只抽模板实际引用的表（不碰本地其它表）', async () => {
  const db = freshDbName('data_auto');
  createLocalDb(db);
  const dir = tmp();
  try {
    importDdlIntoLocalDb({
      db,
      ddl: 'CREATE TABLE ods_used (id int);\nCREATE TABLE local_only (id int);',
    });
    const p = cptUsing(dir, 'ods_used');
    const r = await importDataFromDb({
      db,
      connection: 'Doris',
      autoTables: true,
      path: p,
      deps: {
        resolveConnection: () => ({ conn: {}, notice: null }),
        runSelectSql: async () => ({ rows: [], truncated: false }),
      },
    });
    assert.deepEqual(r.tables.map((t) => t.table), ['ods_used'], `只应抽模板引用的表（实际 ${JSON.stringify(r.tables)}）`);
  } finally {
    dropLocalDb(db, { confirm: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** auto 测试用伪依赖：importSchema 用 DDL 本地建表，importData 记录参数并造数（不连真实库） */
function fakeAutoDeps(records) {
  return {
    importSchema: async ({ db, tables }) => {
      const existing = new Set(listLocalTables(db));
      const toCreate = tables.filter((t) => !existing.has(t));
      if (toCreate.length) {
        importDdlIntoLocalDb({
          db,
          ddl: toCreate.map((t) => `CREATE TABLE ${t} (id int, sku_code varchar(32), sku_name varchar(64));`).join('\n'),
        });
      }
      return {
        ok: toCreate.length > 0,
        imported: toCreate.map((t) => ({ table: t, columns: 3 })),
        warnings: tables.filter((t) => existing.has(t)).map((t) => `本地已存在表 ${t}：replace=false（默认），已跳过`),
        notFound: [],
      };
    },
    importData: async ({ db, tables, sampleRows, maxTotal }) => {
      records.push({ tables, sampleRows, maxTotal });
      for (const table of tables) {
        seedLocalDb({ db, table, rows: [{ id: 1, sku_code: 'S1', sku_name: '甲' }, { id: 2, sku_code: 'S2', sku_name: '乙' }] });
      }
      return {
        ok: true,
        tables: tables.map((t) => ({ table: t, rows: 2 })),
        totalRows: tables.length * 2,
        warnings: ['表 ods_sku 含疑似敏感列：sku_name（仅按样例导入本地测试库，返回体不回显取值）'],
      };
    },
  };
}

test('autoPrepareLocalDb：一条命令完成 schema+按需抽样，默认 200 行/表 / 5000 行总量，已有数据不覆盖', async () => {
  const db = freshDbName('auto');
  const dir = tmp();
  const cwd = settingsDir();
  const records = [];
  try {
    const p = cptUsing(dir, 'ods_sku');
    const r = await autoPrepareLocalDb({ db, connection: 'Doris', path: p, cwd, deps: fakeAutoDeps(records) });
    assert.equal(r.ok, true, JSON.stringify(r.error ?? r.warnings));
    assert.equal(r.mode, 'auto');
    assert.equal(r.localDbReady, true);
    assert.deepEqual(r.schema.tables, ['ods_sku']);
    assert.deepEqual(r.schema.created, ['ods_sku']);
    assert.equal(r.data.totalRows, 2);
    assert.equal(r.data.sampleRows, 200);
    assert.equal(r.data.maxTotal, 5000);
    assert.deepEqual(records[0], { tables: ['ods_sku'], sampleRows: 200, maxTotal: 5000 }, '默认值取 localdb.json settings 默认 200/5000');
    assert.ok(r.warnings.some((w) => /疑似敏感列/.test(w)), JSON.stringify(r.warnings));
    assert.match(r.nextAction, /run_dataset_sql_check/);
    assert.match(r.nextAction, /target: "local"/);

    // 第二次：schema 已存在 + 本地已有数据 → 不重建、不覆盖、不算错
    const records2 = [];
    const r2 = await autoPrepareLocalDb({ db, connection: 'Doris', path: p, cwd, deps: fakeAutoDeps(records2) });
    assert.equal(r2.ok, true);
    assert.deepEqual(r2.schema.created, [], '已存在的表默认不 DROP 重建');
    assert.deepEqual(r2.schema.skipped, ['ods_sku']);
    assert.deepEqual(r2.data.skipped, [{ table: 'ods_sku', rows: 2 }]);
    assert.equal(r2.data.totalRows, 0);
    assert.equal(records2.length, 0, '已有数据的表不再抽样');
    assert.ok(r2.warnings.some((w) => /已有数据/.test(w)));
  } finally {
    dropLocalDb(db, { confirm: true });
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('autoPrepareLocalDb：settings 覆盖抽样上限；autoSample=false 只镜像结构', async () => {
  const db = freshDbName('auto_settings');
  const dir = tmp();
  const cwd = settingsDir({ sampleRows: 50, maxTotal: 100 });
  const records = [];
  try {
    const p = cptUsing(dir, 'ods_setting');
    const r = await autoPrepareLocalDb({ db, connection: 'Doris', path: p, cwd, deps: fakeAutoDeps(records) });
    assert.equal(r.ok, true);
    assert.equal(r.data.sampleRows, 50);
    assert.equal(r.data.maxTotal, 100);
    assert.deepEqual(records[0], { tables: ['ods_setting'], sampleRows: 50, maxTotal: 100 });

    // autoSample=false（用户配置）→ 不抽样
    const db2 = freshDbName('auto_nosample');
    const cwd2 = settingsDir({ autoSample: false });
    const records2 = [];
    try {
      const r2 = await autoPrepareLocalDb({ db: db2, connection: 'Doris', path: p, cwd: cwd2, deps: fakeAutoDeps(records2) });
      assert.equal(r2.ok, true);
      assert.equal(r2.data.totalRows, 0);
      assert.equal(records2.length, 0);
      assert.ok(r2.warnings.some((w) => /autoSample=false/.test(w)));
    } finally {
      dropLocalDb(db2, { confirm: true });
      fs.rmSync(cwd2, { recursive: true, force: true });
    }
  } finally {
    dropLocalDb(db, { confirm: true });
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('autoPrepareLocalDb：无 connection → 结构化错误 + nextAction（不抛错、不崩）', async () => {
  const db = freshDbName('auto_noconn');
  const r = await autoPrepareLocalDb({ db, connection: '' });
  assert.equal(r.ok, false);
  assert.equal(r.localDbReady, false);
  assert.equal(r.mode, 'auto');
  assert.equal(r.error.code, 'connection_required');
  assert.match(r.nextAction, /CPT_DB_CONNECTIONS/);
  assert.match(r.nextAction, /local_db_admin/);
  assert.match(r.nextAction, /action: "ddl"/, '应给出纯离线替代路径');
});

test('autoPrepareLocalDb：真实库连接未配置 → 结构化错误（不联网、不崩溃），本地库不被当成已就绪', async () => {
  const saved = { ...process.env };
  for (const k of Object.keys(process.env)) if (k.startsWith('CPT_DB_')) delete process.env[k];
  process.env.CPT_DB_DISABLE_CONFIG_FILES = '1';
  const db = freshDbName('auto_real_noconf');
  const dir = tmp();
  const cwd = settingsDir();
  try {
    const p = cptUsing(dir, 'ods_sku');
    const r = await autoPrepareLocalDb({ db, connection: 'Doris', path: p, cwd });
    assert.equal(r.ok, false);
    assert.equal(r.localDbReady, false);
    // 2026-11-04 P2（独立验收）：连接先验，失败不再留下空库文件
    assert.equal(r.error.code, 'connection_unresolved');
    assert.match(r.error.message, /数据库连接未配置|CPT_DB_CONNECTIONS/);
    assert.equal(fs.existsSync(localDbPath(db)), false, '连接不可解析时不应先建空库');
    assert.match(r.nextAction, /local_db_import\(\{ action: "auto"/);
  } finally {
    for (const k of Object.keys(process.env)) if (k.startsWith('CPT_DB_')) delete process.env[k];
    Object.assign(process.env, saved);
    dropLocalDb(db, { confirm: true });
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

// ================= 2026-11-05 缺口补齐（审计 P1-1/P1-5） =================

test('importDataFromDb：单连接静默回退的 notice 必须写进 warnings（不静默用错库）', async () => {
  const db = freshDbName('data_notice');
  createLocalDb(db);
  importDdlIntoLocalDb({ db, ddl: 'CREATE TABLE ods_sku (id int, sku_code varchar(32));' });
  try {
    const r = await importDataFromDb({
      db, connection: 'Doris', tables: ['ods_sku'], sampleRows: 2,
      deps: {
        resolveConnection: () => ({ conn: {}, notice: '数据连接名 "Doris" 未在配置中找到，已回退到唯一配置的连接 "testdb"' }),
        runSelectSql: async () => ({ rows: [{ id: 1, sku_code: 'S1' }] }),
      },
    });
    assert.equal(r.ok, true, JSON.stringify(r).slice(0, 600));
    assert.ok(r.warnings.some((w) => /数据连接回退/.test(w)), `notice 必须可见：${JSON.stringify(r.warnings)}`);
    assert.ok(r.warnings.some((w) => /核对 connection 名/.test(w)));
  } finally {
    dropLocalDb(db, { confirm: true });
  }
});

test('autoPrepareLocalDb：连接回退与 JOIN 抽样 caveat 进返回体 warnings（P1-1/P1-5）', async () => {
  const db = freshDbName('auto_notice');
  const dir = tmp();
  const cwd = settingsDir();
  const records = [];
  const deps = {
    ...fakeAutoDeps(records),
    resolveConnection: () => ({ conn: {}, notice: '数据连接名 "Doris" 未在配置中找到，已回退到唯一配置的连接 "testdb"' }),
  };
  try {
    const p = cptUsing(dir, 'ods_a');
    const r = await autoPrepareLocalDb({
      db, connection: 'Doris', path: p, tables: ['ods_a', 'ods_b'], cwd, deps,
    });
    assert.equal(r.ok, true, JSON.stringify(r.error ?? r.warnings));
    assert.ok(r.warnings.some((w) => /数据连接回退/.test(w)), `回退 notice 必须可见：${JSON.stringify(r.warnings)}`);
    assert.ok(r.warnings.some((w) => /JOIN/.test(w)), `JOIN 抽样 caveat 必须可见：${JSON.stringify(r.warnings)}`);
  } finally {
    dropLocalDb(db, { confirm: true });
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
