// test/preview-local-config.test.js —— 预览平台只写本地 SQLite 连接（2026-11-09）
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildLocalConnectionSql, applyLocalConnectionsToFinedb, stripLocalConnectionRows,
} from '../lib/preview-local-config.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-preview-local-config-'));

test('buildLocalConnectionSql：只生成 org.sqlite.JDBC 本地连接，URL 用正斜杠', () => {
  const dir = tmp();
  const dbFile = path.join(dir, 'main.sqlite');
  fs.writeFileSync(dbFile, '');
  const { sql, names } = buildLocalConnectionSql([{ name: '填报-读写', dbFile }]);
  assert.deepEqual(names, ['填报-读写']);
  assert.match(sql, /ConnectionConfig\.connections/);
  assert.match(sql, /org\.sqlite\.JDBC/);
  assert.match(sql, /jdbc:sqlite:\/\//);
  // HSQLDB 按 Latin-1 读 db.script：中文键必须 \uXXXX 转义（填报-读写 → \u586b\u62a5-\u8bfb\u5199）
  assert.match(sql, /ConnectionConfig\.connections\.\\u586b\\u62a5-\\u8bfb\\u5199\.url/);
  assert.doesNotMatch(sql, /填报-读写/);
  assert.doesNotMatch(sql, /jdbc:(mysql|doris|oracle|sqlserver)/i);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('buildLocalConnectionSql：非 ASCII 连接名按 HSQLDB \\uXXXX 码元转义，产出纯 ASCII', () => {
  const dir = tmp();
  const dbFile = path.join(dir, 'main.sqlite');
  fs.writeFileSync(dbFile, '');
  const { sql } = buildLocalConnectionSql([{ name: '填报-读写', dbFile }]);
  // 种子 db.script 实测全 ASCII；我们的注入行也必须全 ASCII，杜绝字节集歧义
  assert.ok(!/[^\x00-\x7f]/.test(sql), '注入 SQL 必须纯 ASCII');
  assert.match(sql, /'ConnectionConfig\.connections', '\["\\u586b\\u62a5-\\u8bfb\\u5199"\]'/);
  // 单引号转义（''）与 \uXXXX 共存：填'报 → \u586b''\u62a5
  const { sql: quoted } = buildLocalConnectionSql([{ name: "填'报", dbFile }]);
  assert.match(quoted, /\\u586b''\\u62a5/);
  assert.ok(!/[^\x00-\x7f]/.test(quoted));
  // 数据里原有反斜杠必须写作 \u005c，不得按 \\ 加倍（HSQLDB 对未知转义按字面保留）
  const { sql: slashed } = buildLocalConnectionSql([{ name: '填\\报', dbFile }]);
  assert.match(slashed, /\\u586b\\u005c\\u62a5/);
  assert.doesNotMatch(slashed, /\\\\u586b/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('buildLocalConnectionSql：连接名单引号被 SQL 转义，不产生注入', () => {
  const dir = tmp();
  const dbFile = path.join(dir, 'main.sqlite');
  fs.writeFileSync(dbFile, '');
  const { sql } = buildLocalConnectionSql([{ name: "O'Brien", dbFile }]);
  assert.match(sql, /O''Brien/);
  assert.doesNotMatch(sql, /O'Brien'/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('buildLocalConnectionSql：拒绝缺失/非 sqlite/重名连接', () => {
  const dir = tmp();
  const dbFile = path.join(dir, 'main.sqlite');
  fs.writeFileSync(dbFile, '');
  assert.throws(() => buildLocalConnectionSql([{ name: 'x', dbFile: path.join(dir, 'missing.sqlite') }]), /不存在/);
  assert.throws(() => buildLocalConnectionSql([{ name: 'x', dbFile: path.join(dir, 'x.db') }]), /只允许 \.sqlite/);
  assert.throws(() => buildLocalConnectionSql([
    { name: 'x', dbFile }, { name: 'X', dbFile },
  ]), /重名/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('stripLocalConnectionRows：清掉带/不带空格的历史连接行，保留其他表行', () => {
  const raw = [
    "INSERT INTO FINE_CONF_ENTITY VALUES('ConnectionConfig.connections','[\"Doris\"]')",
    "INSERT INTO FINE_CONF_ENTITY VALUES('ConnectionConfig.connections.Doris.url','jdbc:mysql://prod/db')",
    "INSERT INTO FINE_CONF_ENTITY VALUES('ConnectionConfig.connections', '[\"Local\"]');",
    "INSERT INTO FINE_CONF_ENTITY VALUES('Other.key', 'keep');",
  ].join('\n');
  const clean = stripLocalConnectionRows(raw);
  assert.doesNotMatch(clean, /ConnectionConfig\.connections/);
  assert.match(clean, /Other\.key/);
  assert.ok(clean.endsWith('\n'));
});

test('applyLocalConnectionsToFinedb：重复注入不累积旧连接行', () => {
  const dir = tmp();
  const finedb = path.join(dir, 'finedb');
  fs.mkdirSync(finedb, { recursive: true });
  const script = path.join(finedb, 'db.script');
  fs.writeFileSync(script, "CREATE MEMORY TABLE FINE_CONF_ENTITY(ID VARCHAR(1000),VALUE VARCHAR(16777216));\n" +
    "INSERT INTO FINE_CONF_ENTITY VALUES('ConnectionConfig.connections','[\"Doris\"]')\n", 'utf8');
  const dbFile = path.join(dir, 'main.sqlite');
  fs.writeFileSync(dbFile, '');
  applyLocalConnectionsToFinedb(finedb, [{ name: '本地', dbFile }]);
  applyLocalConnectionsToFinedb(finedb, [{ name: '本地', dbFile }]);
  const text = fs.readFileSync(script, 'utf8');
  assert.equal((text.match(/ConnectionConfig\.connections'/g) || []).length, 1);
  assert.equal((text.match(/ConnectionConfig\.connections\.\\u672c\\u5730\.url/g) || []).length, 1);
  assert.ok(!/[^\x00-\x7f]/.test(text), '注入后的 db.script 必须纯 ASCII');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('applyLocalConnectionsToFinedb：追加 SQL、删除 db.log，下次启动不再重放旧配置', () => {
  const dir = tmp();
  const finedb = path.join(dir, 'finedb');
  fs.mkdirSync(finedb, { recursive: true });
  const script = path.join(finedb, 'db.script');
  fs.writeFileSync(script, 'CREATE MEMORY TABLE PUBLIC.FINE_CONF_ENTITY(ID VARCHAR(1000),VALUE VARCHAR(16777216));\n', 'utf8');
  fs.writeFileSync(path.join(finedb, 'db.log'), 'old log', 'utf8');
  const dbFile = path.join(dir, 'main.sqlite');
  fs.writeFileSync(dbFile, '');
  const r = applyLocalConnectionsToFinedb(finedb, [{ name: '本地', dbFile }]);
  assert.deepEqual(r.names, ['本地']);
  assert.equal(r.logRemoved, true);
  assert.equal(fs.existsSync(path.join(finedb, 'db.log')), false);
  const text = fs.readFileSync(script, 'utf8');
  assert.doesNotMatch(text, /DELETE FROM FINE_CONF_ENTITY/);
  assert.match(text, /INSERT INTO FINE_CONF_ENTITY VALUES\('ConnectionConfig\.connections'/);
  assert.match(text, /jdbc:sqlite:\/\//);
  assert.match(text, /org\.sqlite\.JDBC/);
  fs.rmSync(dir, { recursive: true, force: true });
});
