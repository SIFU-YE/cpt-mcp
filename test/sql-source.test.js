// test/sql-source.test.js —— 2026-11-23：SQL 来源解耦（内联 sql / 文件 sqlFile）
//
// 背景：add_dataset / update_dataset / build_report / generate_report 原先只收内联 SQL，
// 两段报表 SQL 合计 1647 行（约 50KB）时只能把原文塞进工具参数。本测试锁定新增的文件通道
// 及其安全边界（allowedRoots、扩展名、二进制、体积、BOM、二选一）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { resolveSql, sqlFromFile, SQL_FILE_MAX_BYTES } from '../lib/sql-source.js';
import '../scripts/isolate-store.mjs';

// 安全围栏按进程环境读取 allowedRoots；本文件把允许根限定到临时目录，避免依赖开发机环境变量
process.env.CPT_MCP_ALLOWED_ROOTS = os.tmpdir();

function fixture(files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-sql-src-'));
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content);
  }
  return dir;
}

test('内联 sql 原样返回；sql 与 sqlFile 同时给则报二选一', () => {
  const inline = resolveSql({ sql: 'select 1', toolName: 'add_dataset' });
  assert.equal(inline.sql, 'select 1');
  assert.equal(inline.fromFile, null);

  assert.throws(
    () => resolveSql({ sql: 'select 1', sqlFile: 'x.sql', toolName: 'add_dataset' }),
    /只能二选一/
  );
});

test('从 .sql 文件读取：UTF-8 正常、BOM 被剥离、返回来源摘要', () => {
  const dir = fixture({ 'a.sql': '\uFEFFselect dept, amount from t_a' });
  try {
    const r = resolveSql({ sqlFile: path.join(dir, 'a.sql'), toolName: 'add_dataset' });
    assert.equal(r.sql, 'select dept, amount from t_a', 'BOM 必须剥掉');
    assert.equal(r.fromFile.path, fs.realpathSync.native(path.join(dir, 'a.sql')));
    assert.ok(r.fromFile.bytes > 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('.txt 也接受（有时 SQL 存在 txt 记事本里）', () => {
  const dir = fixture({ 'b.txt': 'select 1 from t' });
  try {
    assert.equal(sqlFromFile(path.join(dir, 'b.txt')).sql, 'select 1 from t');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('不存在的文件 / 目录 / 非法扩展名 都给出可操作报错', () => {
  const dir = fixture({ 'c.csv': 'a,b\n1,2' });
  try {
    assert.throws(() => sqlFromFile(path.join(dir, 'nope.sql')), /不存在或不可读/);
    assert.throws(() => sqlFromFile(dir), /必须是普通文件/);
    assert.throws(() => sqlFromFile(path.join(dir, 'c.csv')), /只接受 \.sql \/ \.txt/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('空文件 / 含 NUL 的二进制文件 被拒绝', () => {
  const dir = fixture({ 'empty.sql': '   \n\t ', 'bin.sql': Buffer.from([0x73, 0x00, 0x71]) });
  try {
    assert.throws(() => sqlFromFile(path.join(dir, 'empty.sql')), /内容为空/);
    assert.throws(() => sqlFromFile(path.join(dir, 'bin.sql')), /NUL 字节/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('超出体积上限被拒绝（SQL_FILE_MAX_BYTES）', () => {
  const dir = fixture({ 'big.sql': 'x'.repeat(SQL_FILE_MAX_BYTES + 1) });
  try {
    assert.throws(
      () => sqlFromFile(path.join(dir, 'big.sql')),
      new RegExp(`超过上限 ${SQL_FILE_MAX_BYTES}B`)
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('安全围栏：允许目录之外的文件被拒绝（不得借 sqlFile 读任意文件）', () => {
  const outside = path.join(process.env.SystemRoot || 'C:\\Windows', 'win.ini');
  assert.throws(
    () => sqlFromFile(outside),
    /不在允许目录内|不存在或不可读/
  );
});

test('sqlFile 传空串 / 非字符串 给出明确报错', () => {
  assert.throws(() => sqlFromFile(''), /必须是非空文件路径/);
  assert.throws(() => sqlFromFile(123), /必须是非空文件路径/);
});
