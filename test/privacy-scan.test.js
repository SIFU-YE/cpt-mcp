// 隐私门禁自检：扫描器必须对干净目录返回 0、对含伪造 token 的目录返回 1，
// 且报错输出不得回显命中的敏感值。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCAN = path.join(ROOT, 'scripts', 'scan-secrets.mjs');

function runScan(dir) {
  return spawnSync(process.execPath, [SCAN, '--root', dir], { encoding: 'utf8' });
}

test('scan-secrets：干净目录通过', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-privacy-clean-'));
  fs.writeFileSync(path.join(d, 'a.js'), 'export const answer = 42; // 示例占位\n');
  const r = runScan(d);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /未发现/);
  fs.rmSync(d, { recursive: true, force: true });
});

test('scan-secrets：伪造 token 被拦截且不回显敏感值', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-privacy-bad-'));
  const fake = 'ghp_' + 'A'.repeat(24); // 拼接构造，避免本测试文件自身被扫描命中
  fs.writeFileSync(path.join(d, 'leak.js'), `const token = '${fake}';\n`);
  const r = runScan(d);
  assert.equal(r.status, 1, '应拒绝包含 token 的目录');
  assert.match(r.stderr, /GitHub 令牌/);
  assert.ok(!r.stderr.includes(fake), '错误输出不得回显 token 原文');
  fs.rmSync(d, { recursive: true, force: true });
});
