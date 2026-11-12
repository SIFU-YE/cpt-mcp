// cpt-mcp/test/localdb-dialect.test.js
// 本地 SQLite 方言兼容层（lib/localdb-sql.js）的单元测试。
//
// 覆盖：
//   1) translateMySqlToSqlite：词法保护（字符串/注释/反引号）、各改写项、只报告不改写的 issue；
//   2) splitSqlStatements：字符串/注释/反引号内的分号、空语句丢弃；
//   3) registerMySqlFunctions：日期/字符串/条件/JSON/正则 UDF 的 MySQL 语义；
//   4) LOCAL_SQL_CAVEATS：已知差异清单。
//
// 测试不依赖 cpt-mcp 其它模块，全部使用内存库，结束时 db.close()，不产生临时文件。
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  translateMySqlToSqlite,
  registerMySqlFunctions,
  splitSqlStatements,
  LOCAL_SQL_CAVEATS,
} from '../lib/localdb-sql.js';

/** 断言用的宽松归一化：折叠空白、逗号后统一一个空格（测试 SQL 的字符串里不含逗号）。 */
function norm(sql) {
  return String(sql).replace(/\s+/g, ' ').replace(/\s*,\s*/g, ', ').trim();
}

function withDb(fn) {
  const db = new DatabaseSync(':memory:', { enableDoubleQuotedStringLiterals: true });
  try {
    const info = registerMySqlFunctions(db);
    return fn(db, info);
  } finally {
    db.close();
  }
}

function scalar(db, sql) {
  return db.prepare(sql).get().v;
}

// ---------------------------------------------------------------------------
// translateMySqlToSqlite
// ---------------------------------------------------------------------------

test('translate：字符串/注释/反引号里的关键字原样保留', () => {
  const sql = [
    "select 'STRAIGHT_JOIN LIMIT 1,2 INTERVAL 1 DAY || #' as s, `BINARY` from t",
    '-- STRAIGHT_JOIN',
    '/* DATE_ADD(x, INTERVAL 1 DAY) */ where c = 1',
  ].join('\n');
  const r = translateMySqlToSqlite(sql);
  assert.equal(r.changed, false);
  assert.ok(r.sql.includes("'STRAIGHT_JOIN LIMIT 1,2 INTERVAL 1 DAY || #'"));
  assert.ok(r.sql.includes('`BINARY`'));
  assert.ok(r.sql.includes('-- STRAIGHT_JOIN'));
  assert.ok(r.sql.includes('/* DATE_ADD(x, INTERVAL 1 DAY) */'));
  assert.deepEqual(r.issues, []);
});

// ---------------------------------------------------------------------------
// schema 限定表名（Doris `bi_ads.表名`）→ 裸表名：本地镜像库按裸表名导入，
// 不改写会在 prepare 阶段直接 no such table（离线审计 enabled:false）。
// ---------------------------------------------------------------------------

test('translate：schema 限定表名改写为裸表名（含列引用），每个 schema 只报一条 issue', () => {
  const sql = 'select * from bi_ads.ods_sku x join bi_ads.other o on bi_ads.ods_sku.id = o.id where bi_ads.ods_sku.qty > 0';
  const r = translateMySqlToSqlite(sql);
  assert.equal(r.changed, true);
  assert.equal(norm(r.sql), 'select * from ods_sku x join other o on ods_sku.id = o.id where ods_sku.qty > 0');
  // 4 处 bi_ads 限定（1 表位 + 1 表位 + 2 列引用）→ 只报 1 条 issue，不刷屏
  assert.equal(r.issues.length, 1);
  assert.equal(r.issues[0].code, 'schema_prefix_stripped');
  assert.match(r.issues[0].hint, /本地 SQLite 没有 schema 命名空间/);
  assert.match(r.issues[0].hint, /只作用于本地 SQL|真实库执行不受影响/);
});

test('translate：schema 改写不误伤 alias.column、字符串、注释，反引号限定名按词法改写', () => {
  // alias.col（两段式）绝不能动
  const aliasSql = 'select t.col from t where t.qty > 0';
  const aliasR = translateMySqlToSqlite(aliasSql);
  assert.equal(aliasR.changed, false);
  assert.deepEqual(aliasR.issues, []);

  // 字符串里的 schema.table 原样保留
  const strSql = 'select \'bi_ads.ods_sku\' as s, "bi_ads.other" as t2 from t where c = 1';
  const strR = translateMySqlToSqlite(strSql);
  assert.equal(strR.changed, false, strR.sql);
  assert.equal(strR.issues.length, 0);

  // 注释原样保留，只有真正的表位被改写
  const cmtSql = '-- from bi_ads.ods_sku\n/* bi_ads.other */ select * from bi_ads.real_t';
  const cmtR = translateMySqlToSqlite(cmtSql);
  assert.ok(cmtR.sql.includes('-- from bi_ads.ods_sku'));
  assert.ok(cmtR.sql.includes('/* bi_ads.other */'));
  assert.match(norm(cmtR.sql), /select \* from real_t$/);
  assert.equal(cmtR.issues.length, 1);

  // 反引号限定名：只删 schema 段，反引号保留
  const tickR = translateMySqlToSqlite('SELECT * FROM `bi_ads`.`ods_sku` WHERE `bi_ads`.`ods_sku`.`qty` > 0');
  assert.equal(norm(tickR.sql), 'SELECT * FROM `ods_sku` WHERE `ods_sku`.`qty` > 0');
  assert.equal(tickR.issues.length, 1);

  // 别名恰好与 schema 同名时不误删列引用里的"别名.列"
  const shadow = translateMySqlToSqlite('select * from bi_ads.ods_sku as bi_ads where bi_ads.qty > 0');
  assert.equal(norm(shadow.sql), 'select * from ods_sku as bi_ads where bi_ads.qty > 0');
});

test('translate：FROM 逗号列表 / UPDATE / INSERT INTO 表位都改写；多段限定名收敛', () => {
  const comma = translateMySqlToSqlite('select * from a, bi_ads.b, c where a.id = b.id');
  assert.equal(norm(comma.sql), 'select * from a, b, c where a.id = b.id');
  assert.equal(comma.issues.length, 1);

  const upd = translateMySqlToSqlite('update bi_ads.t set qty = 1 where id = 2');
  assert.equal(norm(upd.sql), 'update t set qty = 1 where id = 2');
  assert.equal(upd.issues[0].code, 'schema_prefix_stripped');

  const ins = translateMySqlToSqlite('insert into bi_ads.t (a, b) values (1, 2)');
  assert.equal(norm(ins.sql), 'insert into t (a, b) values (1, 2)');

  // `catalog.db.table.column` → `table.column`（catalog、db 各报一条）
  const chain = translateMySqlToSqlite('select catalog.db.t.a from catalog.db.t');
  assert.equal(norm(chain.sql), 'select t.a from t');
  assert.equal(chain.issues.length, 2);

  // 裸表位（无 schema）不产生 issue、不改写
  const bare = translateMySqlToSqlite('select a.id from a join b on a.id = b.id');
  assert.equal(bare.changed, false);
  assert.deepEqual(bare.issues, []);
});

test('translate：优化器 hint 与 STRAIGHT_JOIN', () => {
  const r = translateMySqlToSqlite('select /*+ MAX_EXECUTION_TIME(1000) */ * from a straight_join b on a.id = b.id');
  assert.equal(r.changed, true);
  assert.ok(!r.sql.includes('/*+'));
  assert.ok(!/straight_join/i.test(r.sql));
  assert.ok(r.sql.includes('JOIN'));
  assert.deepEqual(r.issues.map((i) => i.code), ['optimizer_hint_removed', 'straight_join_removed']);
});

test('translate：一元 BINARY 去掉，CAST(x AS BINARY) 保持不动', () => {
  const r = translateMySqlToSqlite("select binary 'abc' as b, cast(x as binary) as c from t where binary name = 'x'");
  assert.equal(norm(r.sql), "select 'abc' as b, cast(x as binary) as c from t where name = 'x'");
  assert.deepEqual(r.issues.map((i) => i.code), ['binary_operator_ignored', 'binary_operator_ignored']);
  assert.equal(r.changed, true);
});

test('translate：CAST 类型映射（CHAR/SIGNED/UNSIGNED/DECIMAL/DATETIME/DATE/TIME/JSON）', () => {
  const sql = [
    'select cast(a as char), cast(b as signed), cast(c as unsigned),',
    'cast(d as decimal(10,2)), cast(e as datetime), cast(f as date),',
    'cast(g as time), cast(h as json), cast(i as signed integer) from t',
  ].join(' ');
  const r = translateMySqlToSqlite(sql);
  const s = norm(r.sql);
  assert.ok(s.includes('cast(a as TEXT)'));
  assert.ok(s.includes('cast(b as INTEGER)'));
  assert.ok(s.includes('cast(c as INTEGER)'));
  assert.ok(s.includes('cast(d as NUMERIC'));
  assert.ok(s.includes('cast(e as TEXT)'));
  assert.ok(s.includes('cast(f as TEXT)'));
  assert.ok(s.includes('cast(g as TEXT)'));
  assert.ok(s.includes('cast(h as TEXT)'));
  assert.ok(s.includes('cast(i as INTEGER'));
  assert.equal((s.match(/as TEXT/g) || []).length, 5);
  assert.equal(r.changed, true);
});

test('translate：CONVERT(x, TYPE) → CAST，USING 字符集转换不动', () => {
  const r = translateMySqlToSqlite('select convert(a, char), convert(b, signed), convert(c using utf8) from t');
  const s = norm(r.sql).toLowerCase();
  assert.ok(s.includes('cast(a as text)'));
  assert.ok(s.includes('cast(b as integer)'));
  assert.ok(s.includes('convert(c using utf8)'));
  assert.equal(r.changed, true);
});

test('translate：GROUP_CONCAT 的 SEPARATOR 只改函数顶层，字符串/嵌套括号不动', () => {
  const r = translateMySqlToSqlite("select group_concat(distinct concat(name, ',') separator '|') from t");
  assert.ok(!/separator/i.test(r.sql));
  assert.ok(r.sql.includes("concat(name, ',')"));
  assert.ok(r.sql.includes(", '|')"));
  assert.equal(r.changed, true);
});

test('translate：DATE_ADD/DATE_SUB/ADDDATE/SUBDATE 统一改写成 date_add/date_sub(dt, n, unit)', () => {
  const sql = [
    'select date_add(d, interval 1 day), date_sub(d, interval 2 month),',
    "adddate(d, interval -1.5 hour), subdate(d, interval 3 quarter), adddate(d, 7) from t",
  ].join(' ');
  const r = translateMySqlToSqlite(sql);
  assert.equal(
    norm(r.sql),
    "select date_add(d, 1, 'day'), date_sub(d, 2, 'month'), date_add(d, -1.5, 'hour'), "
      + "date_sub(d, 3, 'quarter'), date_add(d, 7, 'day') from t",
  );
  assert.deepEqual(r.issues, []);
  assert.equal(r.changed, true);
});

test('translate：未识别的 INTERVAL 单位原样保留并报 unsupported_interval_unit', () => {
  const sql = 'select date_add(d, interval 1 fortnight) from t';
  const r = translateMySqlToSqlite(sql);
  assert.equal(r.sql, sql);
  assert.equal(r.changed, false);
  assert.deepEqual(r.issues.map((i) => i.code), ['unsupported_interval_unit']);
});

test('translate：GREATEST/LEAST → max/min', () => {
  const r = translateMySqlToSqlite('select greatest(a,b), least(a,b) from t');
  assert.equal(norm(r.sql), 'select max(a, b), min(a, b) from t');
  assert.equal(r.changed, true);
});

test('translate：|| → OR，字符串里的 || 不动；# 注释移除', () => {
  const r = translateMySqlToSqlite("select a || b, 'x || y' as s # tail\nfrom t");
  assert.equal(norm(r.sql), "select a OR b, 'x || y' as s from t");
  assert.ok(!r.sql.includes('# tail'));
  assert.deepEqual(r.issues.map((i) => i.code), ['pipe_operator_assumed_or', 'hash_comment_removed']);
  assert.equal(r.changed, true);
});

test('translate：运算符 INTERVAL / DIV / COLLATE 只报告不硬改，issue 形状正确', () => {
  const sql = "select dt + interval 1 day from t where a div 2 = 1 and b collate utf8mb4_bin = 'x'";
  const r = translateMySqlToSqlite(sql);
  assert.equal(r.changed, false);
  assert.deepEqual(
    r.issues.map((i) => i.code).sort(),
    ['unsupported_collate', 'unsupported_div_operator', 'unsupported_interval_operator'],
  );
  for (const issue of r.issues) {
    assert.ok(issue.at >= 0, 'at 不能为负');
    assert.ok(issue.snippet.length <= 40, `snippet 应不超过 40 字符：${issue.snippet.length}`);
    assert.ok(issue.hint.includes('不代表报表 SQL 错'), 'hint 需说明本地限制');
  }
});

test('translate：MATCH ... AGAINST 与 ON DUPLICATE KEY UPDATE 只报告', () => {
  const fulltext = translateMySqlToSqlite("select * from t where match(title) against ('x')");
  assert.equal(fulltext.changed, false);
  assert.deepEqual(fulltext.issues.map((i) => i.code), ['unsupported_fulltext']);

  const upsert = translateMySqlToSqlite('insert into t (a) values (1) on duplicate key update a = 2');
  assert.equal(upsert.changed, false);
  assert.deepEqual(upsert.issues.map((i) => i.code), ['unsupported_upsert']);
  assert.ok(upsert.issues[0].hint.includes('不代表报表 SQL 错'));
});

// ---------------------------------------------------------------------------
// splitSqlStatements
// ---------------------------------------------------------------------------

test('splitSqlStatements：字符串/注释/反引号内的分号不切分', () => {
  const sql = [
    "select 'a;b' as x;",
    '-- c;d',
    '/* e;f */ select `we;ird` from t;',
    '# hash ;',
    'insert into t values ("x;y");',
  ].join('\n');
  const stmts = splitSqlStatements(sql);
  assert.equal(stmts.length, 3);
  assert.ok(stmts[0].includes("'a;b'"));
  assert.ok(stmts[1].includes('`we;ird`'));
  assert.ok(stmts[1].includes('-- c;d'));
  assert.ok(stmts[2].includes('"x;y"'));
  assert.ok(stmts[2].includes('# hash ;'));
});

test('splitSqlStatements：空语句丢弃，双引号/单引号转义正确', () => {
  assert.deepEqual(splitSqlStatements(';; ;\n'), []);
  assert.deepEqual(splitSqlStatements('select 1;;select 2;'), ['select 1', 'select 2']);
  const stmts = splitSqlStatements("select 'it''s;ok'; select \"a\"\"b;c\";");
  assert.equal(stmts.length, 2);
  assert.ok(stmts[0].includes("'it''s;ok'"));
  assert.ok(stmts[1].includes('"a""b;c"'));
});

// ---------------------------------------------------------------------------
// registerMySqlFunctions：字符串 / 条件
// ---------------------------------------------------------------------------

test('UDF：concat 的 NULL 传播、concat_ws 跳过 NULL、if 真值', () => withDb((db) => {
  assert.equal(scalar(db, "select concat('a','b') as v"), 'ab');
  assert.equal(scalar(db, "select concat('a',null,'b') as v"), null);
  assert.equal(scalar(db, 'select concat(1,2) as v'), '12');
  assert.equal(scalar(db, "select concat_ws('-', 'a', null, 'b') as v"), 'a-b');
  assert.equal(scalar(db, "select concat_ws(null, 'a', 'b') as v"), null);
  assert.equal(scalar(db, "select if(1, 'yes', 'no') as v"), 'yes');
  assert.equal(scalar(db, "select if(0, 'yes', 'no') as v"), 'no');
  assert.equal(scalar(db, "select if(null, 'yes', 'no') as v"), 'no');
}));

// ---------------------------------------------------------------------------
// registerMySqlFunctions：日期时间
// ---------------------------------------------------------------------------

test('UDF：date_format 常用占位符与非法输入', () => withDb((db) => {
  assert.equal(
    scalar(db, "select date_format('2026-01-02 03:04:05', '%Y-%m-%d %H:%i:%s') as v"),
    '2026-01-02 03:04:05',
  );
  assert.equal(scalar(db, "select date_format('2026-01-02', '%Y/%c/%e') as v"), '2026/1/2');
  assert.equal(scalar(db, "select date_format('2026-01-02 15:04:05', '%h:%i %p') as v"), '03:04 PM');
  assert.equal(scalar(db, "select date_format('2026-01-02 15:04:05', '%W %M %D') as v"), 'Friday January 2nd');
  assert.equal(scalar(db, "select date_format('2026-01-02 03:04:05.123', '%f') as v"), '123000');
  assert.equal(scalar(db, "select date_format('bad-date', '%Y') as v"), null);
}));

test('UDF：str_to_date 反向解析，无时分秒时只输出日期', () => withDb((db) => {
  assert.equal(
    scalar(db, "select str_to_date('2026-01-02 03:04:05', '%Y-%m-%d %H:%i:%s') as v"),
    '2026-01-02 03:04:05',
  );
  assert.equal(scalar(db, "select str_to_date('2026/01/02', '%Y/%m/%d') as v"), '2026-01-02');
  assert.equal(scalar(db, "select str_to_date('02 Jan 2026', '%d %b %Y') as v"), '2026-01-02');
  assert.equal(scalar(db, "select str_to_date('nope', '%Y-%m-%d') as v"), null);
}));

test('UDF：date_add/date_sub 跨月与负值、last_day、now/curdate/curtime', () => withDb((db) => {
  assert.equal(scalar(db, "select date_add('2026-01-31', 1, 'month') as v"), '2026-02-28');
  assert.equal(scalar(db, "select date_add('2026-03-01', -1, 'day') as v"), '2026-02-28');
  assert.equal(
    scalar(db, "select date_add('2026-01-01 10:00:00', 90, 'minute') as v"),
    '2026-01-01 11:30:00',
  );
  assert.equal(scalar(db, "select date_sub('2026-01-01', 1, 'day') as v"), '2025-12-31');
  assert.equal(scalar(db, "select last_day('2026-02-05') as v"), '2026-02-28');
  assert.equal(scalar(db, "select last_day('2024-02-05') as v"), '2024-02-29');
  assert.match(scalar(db, 'select now() as v'), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  assert.match(scalar(db, 'select curdate() as v'), /^\d{4}-\d{2}-\d{2}$/);
  assert.match(scalar(db, 'select curtime() as v'), /^\d{2}:\d{2}:\d{2}$/);
}));

test('UDF：datediff 与 timestampdiff（按 MySQL 截断口径）', () => withDb((db) => {
  assert.equal(scalar(db, "select datediff('2026-01-10','2026-01-01') as v"), 9);
  assert.equal(
    scalar(db, "select timestampdiff('day','2026-01-01 23:00:00','2026-01-02 01:00:00') as v"),
    0,
  );
  assert.equal(
    scalar(db, "select timestampdiff('hour','2026-01-01 00:00:00','2026-01-01 05:30:00') as v"),
    5,
  );
  assert.equal(scalar(db, "select timestampdiff('month','2026-01-31','2026-02-28') as v"), 0);
  assert.equal(scalar(db, "select timestampdiff('month','2026-01-01','2026-03-01') as v"), 2);
}));

test('UDF：日期部件、weekday/dayofweek、weekofyear、date_trunc', () => withDb((db) => {
  // 2026-01-02 是周五
  assert.equal(scalar(db, "select weekday('2026-01-02') as v"), 4);
  assert.equal(scalar(db, "select dayofweek('2026-01-02') as v"), 6);
  assert.equal(scalar(db, "select dayofmonth('2026-01-02') as v"), 2);
  assert.equal(scalar(db, "select dayofyear('2026-01-02') as v"), 2);
  assert.equal(scalar(db, "select weekofyear('2026-01-02') as v"), 1);
  assert.equal(scalar(db, "select quarter('2026-05-02') as v"), 2);
  assert.equal(scalar(db, "select year('2026-01-02 03:04:05') as v"), 2026);
  assert.equal(scalar(db, "select month('2026-01-02') as v"), 1);
  assert.equal(scalar(db, "select day('2026-01-02') as v"), 2);
  assert.equal(scalar(db, "select hour('2026-01-02 03:04:05') as v"), 3);
  assert.equal(scalar(db, "select minute('2026-01-02 03:04:05') as v"), 4);
  assert.equal(scalar(db, "select second('2026-01-02 03:04:05') as v"), 5);
  assert.equal(
    scalar(db, "select date_trunc('month','2026-05-17 13:45:10') as v"),
    '2026-05-01 00:00:00',
  );
  assert.equal(
    scalar(db, "select date_trunc('day','2026-05-17 13:45:10') as v"),
    '2026-05-17 00:00:00',
  );
}));

// ---------------------------------------------------------------------------
// registerMySqlFunctions：字符串函数
// ---------------------------------------------------------------------------

test('UDF：substring_index 正负 count、find_in_set、locate 2/3 参', () => withDb((db) => {
  assert.equal(scalar(db, "select substring_index('a,b,c', ',', 2) as v"), 'a,b');
  assert.equal(scalar(db, "select substring_index('a,b,c', ',', -2) as v"), 'b,c');
  assert.equal(scalar(db, "select substring_index('a,b,c', ',', 0) as v"), '');
  assert.equal(scalar(db, "select substring_index('a,b,c', ',', 9) as v"), 'a,b,c');
  assert.equal(scalar(db, "select find_in_set('b','a,b,c') as v"), 2);
  assert.equal(scalar(db, "select find_in_set('z','a,b,c') as v"), 0);
  assert.equal(scalar(db, "select locate('b','abc') as v"), 2);
  assert.equal(scalar(db, "select locate('b','abc',3) as v"), 0);
  assert.equal(scalar(db, "select locate('a','abc',1) as v"), 1);
}));

test('UDF：lpad/rpad/repeat/reverse/char_length/mid/left/right', () => withDb((db) => {
  assert.equal(scalar(db, "select lpad('7', 3, '0') as v"), '007');
  assert.equal(scalar(db, "select rpad('7', 3, '0') as v"), '700');
  assert.equal(scalar(db, "select lpad('abcdef', 3, 'x') as v"), 'abc');
  assert.equal(scalar(db, "select repeat('ab', 3) as v"), 'ababab');
  assert.equal(scalar(db, "select reverse('abc') as v"), 'cba');
  assert.equal(scalar(db, "select char_length('中文') as v"), 2);
  assert.equal(scalar(db, "select character_length('中文') as v"), 2);
  assert.equal(scalar(db, "select mid('abcdef', 2, 3) as v"), 'bcd');
  assert.equal(scalar(db, "select left('abcdef', 2) as v"), 'ab');
  assert.equal(scalar(db, "select right('abcdef', 2) as v"), 'ef');
}));

// ---------------------------------------------------------------------------
// registerMySqlFunctions：哈希 / JSON / 正则 / 数学
// ---------------------------------------------------------------------------

test('UDF：哈希/JSON/正则/数学', () => withDb((db) => {
  assert.equal(scalar(db, "select hex('abc') as v"), '616263');
  assert.equal(scalar(db, 'select hex(255) as v'), 'FF');
  assert.equal(scalar(db, "select unhex('616263') as v"), 'abc');
  assert.equal(scalar(db, "select unhex('zz') as v"), null);
  assert.equal(scalar(db, "select md5('abc') as v"), '900150983cd24fb0d6963f7d28e17f72');
  assert.equal(scalar(db, "select 'abc' regexp '^a' as v"), 1);
  assert.equal(scalar(db, "select 'abc' regexp '^b' as v"), 0);
  assert.equal(scalar(db, "select 'abc' regexp '[' as v"), 0);
  assert.equal(scalar(db, "select json_unquote('\"abc\"') as v"), 'abc');
  assert.equal(scalar(db, "select json_unquote('abc') as v"), 'abc');
  const r = db.prepare('select rand() as v').get().v;
  assert.ok(r >= 0 && r < 1, 'rand() 应在 [0,1)');
  assert.equal(scalar(db, 'select truncate(1.999, 2) as v'), 1.99);
  assert.equal(scalar(db, 'select mod(7, 3) as v'), 1);
  assert.equal(scalar(db, 'select mod(7, 0) as v'), null);
  assert.equal(scalar(db, 'select power(2, 10) as v'), 1024);
}));

test('UDF：from_unixtime/unix_timestamp 往返（本地时区）', () => withDb((db) => {
  assert.equal(
    scalar(db, "select from_unixtime(unix_timestamp('2026-01-02 03:04:05')) as v"),
    '2026-01-02 03:04:05',
  );
  const expected = Math.floor(new Date(2026, 0, 2, 3, 4, 5).getTime() / 1000);
  assert.equal(scalar(db, "select unix_timestamp('2026-01-02 03:04:05') as v"), expected);
  assert.equal(
    scalar(db, "select from_unixtime(unix_timestamp('2026-01-02 03:04:05'), '%Y/%m/%d') as v"),
    '2026/01/02',
  );
}));

// ---------------------------------------------------------------------------
// 注册清单 / caveats
// ---------------------------------------------------------------------------

test('registerMySqlFunctions：返回去重的注册清单与关键 caveats', () => withDb((db, info) => {
  const required = [
    'concat', 'concat_ws', 'if', 'date_format', 'str_to_date', 'from_unixtime', 'unix_timestamp',
    'date_add', 'date_sub', 'datediff', 'timestampdiff', 'last_day',
    'year', 'month', 'day', 'hour', 'minute', 'second',
    'weekday', 'dayofweek', 'dayofmonth', 'dayofyear', 'weekofyear', 'quarter', 'date_trunc',
    'substring_index', 'find_in_set', 'locate', 'lpad', 'rpad', 'repeat', 'reverse',
    'char_length', 'character_length', 'mid', 'hex', 'unhex', 'md5', 'left', 'right',
    'rand', 'truncate', 'mod', 'json_unquote', 'regexp',
  ];
  for (const name of required) {
    assert.ok(info.registered.includes(name), `registered 缺少 ${name}`);
  }
  assert.equal(new Set(info.registered).size, info.registered.length, 'registered 不应有重复项');
  assert.ok(info.caveats.some((c) => c.includes('时区')), 'caveats 需说明时区口径');
  assert.ok(info.caveats.some((c) => c.includes('短路')), 'caveats 需说明 IF 非短路');
  assert.ok(info.caveats.some((c) => c.includes('占位符')), 'caveats 需说明日期占位符覆盖不完整');
  assert.ok(info.caveats.some((c) => /REGEXP|正则/.test(c)), 'caveats 需说明正则语义差异');

  assert.ok(Array.isArray(LOCAL_SQL_CAVEATS) && LOCAL_SQL_CAVEATS.length >= 8);
  assert.ok(LOCAL_SQL_CAVEATS.some((c) => c.includes('DECIMAL')));
  assert.ok(LOCAL_SQL_CAVEATS.some((c) => c.includes('||')));
  assert.ok(LOCAL_SQL_CAVEATS.some((c) => c.includes('排序')));
}));
