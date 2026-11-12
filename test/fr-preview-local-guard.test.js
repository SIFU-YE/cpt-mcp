// test/fr-preview-local-guard.test.js —— 内置预览禁止继承生产数据连接（2026-11-09）
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  extractConnectionUrls, isLocalJdbcUrl, inspectPreviewFinedb,
} from '../lib/preview-local-guard.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-preview-guard-'));

test('extractConnectionUrls：HSQLDB FINE_CONF_ENTITY ConnectionConfig URL 行', () => {
  const text = [
    "INSERT INTO FINE_CONF_ENTITY VALUES('ConnectionConfig.connections','[\"本地填报\"]')",
    "INSERT INTO FINE_CONF_ENTITY VALUES('ConnectionConfig.connections.本地填报.url','jdbc:sqlite://C:/work/.cpt-mcp/localdb/main.sqlite')",
    "INSERT INTO FINE_CONF_ENTITY VALUES('ConnectionConfig.connections.prod.url','jdbc:mysql://prod.example:3306/db')",
  ].join('\n');
  const rows = extractConnectionUrls(text);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.name).sort(), ['prod', '本地填报']);
});

test('isLocalJdbcUrl：只允许 SQLite / 本地 HSQLDB', () => {
  assert.equal(isLocalJdbcUrl('jdbc:sqlite://C:/x/main.sqlite'), true);
  assert.equal(isLocalJdbcUrl('jdbc:hsqldb:file:C:/x/finedb'), true);
  assert.equal(isLocalJdbcUrl('jdbc:hsqldb:mem:test'), true);
  assert.equal(isLocalJdbcUrl(''), true);
  assert.equal(isLocalJdbcUrl('__EMPTY__'), true);
  assert.equal(isLocalJdbcUrl('jdbc:mysql://prod:3306/db'), false);
  assert.equal(isLocalJdbcUrl('jdbc:oracle:thin:@prod:1521:db'), false);
  assert.equal(isLocalJdbcUrl('jdbc:sqlserver://prod:1433;databaseName=db'), false);
});

test('inspectPreviewFinedb：种子含生产连接 → blocked', () => {
  const root = tmp();
  const seed = path.join(root, 'seed');
  fs.mkdirSync(seed, { recursive: true });
  fs.writeFileSync(path.join(seed, 'db.script'), [
    "CREATE MEMORY TABLE PUBLIC.FINE_CONF_ENTITY(ID VARCHAR(1000) NOT NULL PRIMARY KEY,VALUE VARCHAR(16777216));",
    "INSERT INTO FINE_CONF_ENTITY VALUES('ConnectionConfig.connections.prod.url','jdbc:mysql://prod:3306/db');",
  ].join('\n'));
  const r = inspectPreviewFinedb({ seedDir: seed });
  assert.equal(r.ok, false);
  assert.deepEqual(r.blocked.map((b) => b.name), ['prod']);
  assert.match(r.reason, /外部 JDBC 连接/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('inspectPreviewFinedb：仅本地 SQLite/HSQLDB → 通过；FR_HOME 回退源也检查', () => {
  const root = tmp();
  const seed = path.join(root, 'seed');
  const frHome = path.join(root, 'fr');
  fs.mkdirSync(seed, { recursive: true });
  fs.mkdirSync(path.join(frHome, 'bin', 'embed', 'finedb'), { recursive: true });
  fs.writeFileSync(path.join(seed, 'db.script'), [
    "INSERT INTO FINE_CONF_ENTITY VALUES('ConnectionConfig.connections.local.url','jdbc:sqlite://C:/x/main.sqlite');",
    "INSERT INTO FINE_CONF_ENTITY VALUES('ConnectionConfig.connections.mem.url','jdbc:hsqldb:mem:finedb');",
  ].join('\n'));
  // 种子干净但 FR_HOME 回退源有生产连接时也必须拦（保守）
  fs.writeFileSync(path.join(frHome, 'bin', 'embed', 'finedb', 'db.script'), [
    "INSERT INTO FINE_CONF_ENTITY VALUES('ConnectionConfig.connections.prod.url','jdbc:mysql://prod:3306/db');",
  ].join('\n'));
  const r = inspectPreviewFinedb({ seedDir: seed, frHome });
  assert.equal(r.ok, false);
  assert.ok(r.blocked.some((b) => b.name === 'prod'));

  fs.rmSync(path.join(frHome, 'bin', 'embed', 'finedb', 'db.script'));
  const clean = inspectPreviewFinedb({ seedDir: seed, frHome });
  assert.equal(clean.ok, true);
  assert.ok(clean.localCount >= 2);
  fs.rmSync(root, { recursive: true, force: true });
});
