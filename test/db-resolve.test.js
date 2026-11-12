// test/db-resolve.test.js —— resolveExactConnection：显式点名的连接必须严格校验（2026-11-07 P0）
//
// 背景：local_db_schema({compareWith:"不存在的连接"}) 旧实现直接 listRealTables(compareWith)，
// 而 resolveConnection 在只配了一个连接时会把未知名字**回退**过去 → 用户以为只是看本地 schema，
// 实际却对默认真实库跑了 SHOW TABLES（可能误查生产库）。严格版只认配置里的名字，绝不回退。
import test from 'node:test';
import assert from 'node:assert/strict';
import '../scripts/isolate-store.mjs';
import { resolveExactConnection, resolveConnection } from '../lib/db.js';

const ENV_KEYS = [
  'CPT_DB_CONNECTIONS', 'CPT_DB_DISABLE_CONFIG_FILES', 'CPT_DB_CONN_FILE', 'CPT_DB_DEFAULT',
  'CPT_DB_HOST', 'CPT_DB_NAME', 'CPT_DB_PORT', 'CPT_DB_USER', 'CPT_DB_PASSWORD', 'CPT_DB_DATABASE',
];

/** 隔离连接配置：测试内只认这里给的配置，结尾恢复原环境（不打印任何凭据） */
function withConnections(config, fn) {
  const saved = {};
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  process.env.CPT_DB_DISABLE_CONFIG_FILES = '1';
  if (config) process.env.CPT_DB_CONNECTIONS = JSON.stringify(config);
  try {
    return fn();
  } finally {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

const FAKE = { host: '127.0.0.1', port: 1, user: 'u', password: 'p', database: 'd' };

test('resolveExactConnection：只认配置名（大小写不敏感），未知连接直接报错并列出已配置名', () => {
  withConnections({ Doris: FAKE, Ods: FAKE }, () => {
    assert.equal(resolveExactConnection('Doris').name, 'Doris');
    assert.equal(resolveExactConnection('doris').name, 'Doris', '大小写不敏感');
    assert.throws(() => resolveExactConnection('NoSuchConn'), (e) => {
      assert.match(e.message, /未在配置中找到/);
      assert.match(e.message, /不做回退/);
      assert.match(e.message, /Doris/);
      assert.match(e.message, /Ods/);
      return true;
    });
    assert.throws(() => resolveExactConnection(''), /不能为空/);
    assert.throws(() => resolveExactConnection(undefined), /不能为空/);
  });
});

test('对照：resolveConnection 会回退唯一连接，所以 compareWith 必须用严格版', () => {
  withConnections({ Doris: FAKE }, () => {
    const r = resolveConnection('NoSuchConn');
    assert.match(r.notice ?? '', /回退到唯一配置的连接/, '旧行为：未知名回退唯一连接（正是误查真实库的根因）');
    // 严格版：同名合法、未知名直接拒绝
    assert.equal(resolveExactConnection('Doris').name, 'Doris');
    assert.throws(() => resolveExactConnection('NoSuchConn'), /未在配置中找到/);
  });
});

test('没有任何连接配置时：resolveExactConnection 给配置指引（可操作错误，不崩）', () => {
  withConnections(null, () => {
    assert.throws(() => resolveExactConnection('Doris'), /数据库连接未配置/);
  });
});
