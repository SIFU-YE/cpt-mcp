// test/preview-local-config.test.js —— 预览平台只写本地 SQLite 连接（2026-11-09）
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildLocalConnectionSql, applyLocalConnectionsToFinedb,
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
  assert.match(sql, /ConnectionConfig\.connections\.填报-读写\.url/);
  assert.match(sql, /填报-读写/);
  assert.doesNotMatch(sql, /jdbc:(mysql|doris|oracle|sqlserver)/i);
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
  assert.match(text, /DELETE FROM FINE_CONF_ENTITY WHERE ID LIKE 'ConnectionConfig\.connections%'/);
  assert.match(text, /jdbc:sqlite:\/\//);
  assert.match(text, /org\.sqlite\.JDBC/);
  fs.rmSync(dir, { recursive: true, force: true });
});
