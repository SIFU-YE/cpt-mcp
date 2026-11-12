// test/localdb-schema.test.js —— 真实库 schema → SQLite DDL 映射 / DDL 兜底解析 / 结构对账（2026-11-02）
// 纯函数测试，不连真实库、不写文件。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mysqlTypeToSqlite, normalizeShowColumn, normalizeShowIndex, buildCreateTableSql,
  parseMysqlCreateTable, buildFromMysqlDdl, extractCreateTableStatements, diffSchemaSnapshots,
  schemaSnapshotFromShow, quoteIdent,
} from '../lib/localdb-schema.js';

test('类型映射：MySQL/Doris 类型 → SQLite 亲和 + 告警', () => {
  const cases = [
    ['int(11)', 'INTEGER'], ['tinyint(1)', 'INTEGER'], ['bigint', 'INTEGER'], ['year', 'INTEGER'],
    ['decimal(18,2)', 'NUMERIC'], ['numeric(10,4)', 'NUMERIC'],
    ['float', 'REAL'], ['double', 'REAL'],
    ['date', 'TEXT'], ['datetime(3)', 'TEXT'], ['timestamp', 'TEXT'], ['time', 'TEXT'],
    ['varchar(255)', 'TEXT'], ['longtext', 'TEXT'], ['json', 'TEXT'], ['enum(\'a\',\'b\')', 'TEXT'],
    ['blob', 'BLOB'], ['varbinary(32)', 'BLOB'],
  ];
  for (const [type, want] of cases) {
    assert.equal(mysqlTypeToSqlite(type).sqlite, want, `${type} → ${want}`);
  }
  assert.ok(mysqlTypeToSqlite('bigint').warnings.some((w) => /BIGINT/.test(w)));
  assert.ok(mysqlTypeToSqlite('decimal(10,2)').warnings.some((w) => /DECIMAL|精度/.test(w)));
  assert.ok(mysqlTypeToSqlite('timestamp').warnings.some((w) => /时区/.test(w)));
});

test('SHOW 元数据规范化：兼容 mysql2 与 Doris 的键名大小写', () => {
  const c = normalizeShowColumn({ Field: 'a', Type: 'int(11)', Null: 'NO', Key: 'PRI', Default: '0', Extra: '', Comment: '主键' });
  assert.deepEqual({ name: c.name, type: c.type, nullable: c.nullable, default: c.default, key: c.key }, { name: 'a', type: 'int(11)', nullable: false, default: '0', key: 'PRI' });
  const c2 = normalizeShowColumn({ field: 'b', type: 'varchar(8)', null: 'YES', default: null, extra: 'DEFAULT_GENERATED' });
  assert.equal(c2.name, 'b');
  assert.equal(c2.nullable, true);
  const i = normalizeShowIndex({ Table: 't', Non_unique: 0, Key_name: 'PRIMARY', Seq_in_index: 1, Column_name: 'id', Index_type: 'BTREE' });
  assert.deepEqual([i.nonUnique, i.keyName, i.seq, i.column], [0, 'PRIMARY', 1, 'id']);
});

test('装配 CREATE TABLE：自增主键/NOT NULL/DEFAULT/唯一索引/全文索引跳过', () => {
  const columns = [
    normalizeShowColumn({ Field: 'id', Type: 'bigint', Null: 'NO', Key: 'PRI', Default: null, Extra: 'auto_increment' }),
    normalizeShowColumn({ Field: 'name', Type: 'varchar(64)', Null: 'NO', Key: '', Default: null, Extra: '' }),
    normalizeShowColumn({ Field: 'qty', Type: 'decimal(10,2)', Null: 'YES', Key: '', Default: '0.00', Extra: '' }),
    normalizeShowColumn({ Field: 'created_at', Type: 'datetime', Null: 'YES', Key: '', Default: 'CURRENT_TIMESTAMP', Extra: 'DEFAULT_GENERATED' }),
    normalizeShowColumn({ Field: 'content', Type: 'longtext', Null: 'YES', Key: '', Default: null, Extra: '' }),
  ];
  const indexes = [
    normalizeShowIndex({ Table: 't', Non_unique: 0, Key_name: 'PRIMARY', Seq_in_index: 1, Column_name: 'id' }),
    normalizeShowIndex({ Table: 't', Non_unique: 0, Key_name: 'uk_name', Seq_in_index: 1, Column_name: 'name' }),
    normalizeShowIndex({ Table: 't', Non_unique: 1, Key_name: 'idx_qty', Seq_in_index: 1, Column_name: 'qty' }),
    normalizeShowIndex({ Table: 't', Non_unique: 1, Key_name: 'ft_content', Seq_in_index: 1, Column_name: 'content', Index_type: 'FULLTEXT' }),
  ];
  const built = buildCreateTableSql({ table: 't', columns, indexes });
  assert.match(built.sql, /"id" INTEGER PRIMARY KEY AUTOINCREMENT/);
  assert.match(built.sql, /"name" TEXT NOT NULL/);
  assert.match(built.sql, /"qty" NUMERIC DEFAULT 0\.00/);
  assert.match(built.sql, /"created_at" TEXT DEFAULT CURRENT_TIMESTAMP/);
  assert.equal(built.autoIncrement, 'id');
  assert.deepEqual(built.primaryKey, ['id']);
  assert.equal(built.indexSql.length, 2, 'FULLTEXT 索引应被跳过，只留唯一+普通');
  assert.ok(built.indexSql.some((s) => /CREATE UNIQUE INDEX/.test(s)));
  assert.ok(built.warnings.some((w) => /FULLTEXT/.test(w)));
  // 表名/列名引号转义
  assert.equal(quoteIdent('a"b'), '"a""b"');
});

test('复合主键 + 多列索引 + 生成列告警', () => {
  const columns = [
    normalizeShowColumn({ Field: 'a', Type: 'int', Null: 'NO', Key: 'PRI', Extra: '' }),
    normalizeShowColumn({ Field: 'b', Type: 'int', Null: 'NO', Key: 'PRI', Extra: '' }),
    normalizeShowColumn({ Field: 'c', Type: 'int', Null: 'YES', Key: '', Extra: 'VIRTUAL GENERATED' }),
  ];
  const indexes = [
    normalizeShowIndex({ Non_unique: 0, Key_name: 'PRIMARY', Seq_in_index: 1, Column_name: 'a' }),
    normalizeShowIndex({ Non_unique: 0, Key_name: 'PRIMARY', Seq_in_index: 2, Column_name: 'b' }),
    normalizeShowIndex({ Non_unique: 1, Key_name: 'idx_ab', Seq_in_index: 1, Column_name: 'a' }),
    normalizeShowIndex({ Non_unique: 1, Key_name: 'idx_ab', Seq_in_index: 2, Column_name: 'b' }),
  ];
  const built = buildCreateTableSql({ table: 't2', columns, indexes });
  assert.match(built.sql, /PRIMARY KEY \("a", "b"\)/);
  assert.equal(built.autoIncrement, null);
  assert.ok(built.warnings.some((w) => /生成列/.test(w)));
  assert.ok(built.indexSql.some((s) => /"a", "b"/.test(s)), '多列索引按 Seq 拼接');
});

test('DDL 文本兜底解析：列/主键/唯一索引/注释', () => {
  const ddl = `CREATE TABLE \`demo\` (
  \`id\` bigint NOT NULL AUTO_INCREMENT,
  \`name\` varchar(64) NOT NULL DEFAULT '' COMMENT '名称',
  \`qty\` decimal(10,2) DEFAULT '0.00',
  \`created_at\` datetime DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (\`id\`),
  UNIQUE KEY \`uk_name\` (\`name\`),
  KEY \`idx_qty\` (\`qty\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='演示表';`;
  const parsed = parseMysqlCreateTable(ddl);
  assert.equal(parsed.table, 'demo');
  assert.equal(parsed.columns.length, 4);
  const idCol = parsed.columns.find((c) => c.name === 'id');
  assert.match(idCol.type, /bigint/i);
  assert.match(idCol.extra, /auto_increment/);
  const built = buildFromMysqlDdl(ddl);
  assert.match(built.sql, /"id" INTEGER PRIMARY KEY AUTOINCREMENT/);
  assert.match(built.sql, /"name" TEXT NOT NULL/);
  assert.ok(built.indexSql.some((s) => /uk_name/.test(s)));
  assert.ok(built.parseWarnings.length === 0 || Array.isArray(built.parseWarnings));
});

test('DDL 多表拆分只取 CREATE TABLE；解析失败给出可读错误', () => {
  const stmts = extractCreateTableStatements("CREATE TABLE a (x int);\nINSERT INTO a VALUES (1);\nCREATE TABLE b (y int);");
  assert.equal(stmts.length, 2);
  assert.throws(() => parseMysqlCreateTable('DROP TABLE x'), /未找到 CREATE TABLE/);
});

test('结构对账：一致/缺表/多表/缺列/类型差/PK 差', () => {
  const expected = {
    t: {
      columns: [{ name: 'id', type: 'INTEGER', pk: 1 }, { name: 'name', type: 'TEXT', pk: 0 }],
      indexes: [{ name: 'uk_name', unique: true, columns: ['name'] }],
    },
  };
  const okLocal = {
    t: {
      columns: [{ name: 'id', type: 'INTEGER', pk: 1 }, { name: 'name', type: 'TEXT', pk: 0 }],
      indexes: [{ name: 'idx_t_uk_name', unique: true, columns: ['name'], origin: 'c' }],
    },
  };
  assert.equal(diffSchemaSnapshots(expected, okLocal).match, true);
  const bad = diffSchemaSnapshots(expected, {
    t: {
      columns: [{ name: 'id', type: 'NUMERIC', pk: 0 }, { name: 'extra', type: 'TEXT', pk: 0 }],
      indexes: [],
    },
    onlyLocal: { columns: [], indexes: [] },
  });
  assert.equal(bad.match, false);
  assert.deepEqual(bad.missingTables, []);
  assert.deepEqual(bad.extraTables, ['onlyLocal']);
  assert.ok(bad.issues.some((i) => i.kind === 'missing-column'));
  assert.ok(bad.issues.some((i) => i.kind === 'type-mismatch'));
  assert.ok(bad.issues.some((i) => i.kind === 'primary-key-mismatch'));
  assert.ok(bad.issues.some((i) => i.kind === 'missing-index'));
  const missing = diffSchemaSnapshots({ z: { columns: [], indexes: [] } }, {});
  assert.deepEqual(missing.missingTables, ['z']);
});

test('schemaSnapshotFromShow：主键/索引/类型归一为本地快照形状', () => {
  const snap = schemaSnapshotFromShow({
    table: 't',
    columns: [
      normalizeShowColumn({ Field: 'id', Type: 'int', Null: 'NO', Key: 'PRI' }),
      normalizeShowColumn({ Field: 'name', Type: 'varchar(10)', Null: 'YES' }),
    ],
    indexes: [
      normalizeShowIndex({ Non_unique: 0, Key_name: 'PRIMARY', Seq_in_index: 1, Column_name: 'id' }),
      normalizeShowIndex({ Non_unique: 1, Key_name: 'idx_name', Seq_in_index: 1, Column_name: 'name' }),
    ],
  });
  assert.deepEqual(snap.t.columns.map((c) => [c.name, c.type, c.pk]), [['id', 'INTEGER', 1], ['name', 'TEXT', 0]]);
  assert.deepEqual(snap.t.indexes, [{ name: 'idx_name', unique: false, columns: ['name'] }]);
});
