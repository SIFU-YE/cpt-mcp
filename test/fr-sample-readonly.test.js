// test/fr-sample-readonly.test.js —— P1-5（审计 C 类）：FR_HOME 官方样本目录 reportlets/** 只读放行
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertToolPath } from '../lib/security.js';
import '../scripts/isolate-store.mjs';

test('FR 样本（reportlets/**）只读放行、写入拒绝；reportlets 之外仍拒绝', () => {
  const fr = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-fr-'));
  const prev = process.env.FR_HOME;
  process.env.FR_HOME = fr;
  try {
    const sample = path.join(fr, 'webapps', 'webroot', 'WEB-INF', 'reportlets', 'doc', 'Advanced', '每页显示固定行数.cpt');
    fs.mkdirSync(path.dirname(sample), { recursive: true });
    fs.writeFileSync(sample, '<Report/>', 'utf8');
    const outside = path.join(fr, 'config', 'finedb.properties');
    fs.mkdirSync(path.dirname(outside), { recursive: true });
    fs.writeFileSync(outside, 'x=1', 'utf8');

    // 只读放行（对照官方样本的场景）
    const ok = assertToolPath('get_page_settings', sample, { write: false });
    assert.equal(ok, path.resolve(sample), 'reportlets/** 只读应放行');

    // 写入拒绝（即使在 reportlets 下）
    assert.throws(() => assertToolPath('add_cell', sample, { write: true }), /禁止写入|不在允许目录/, 'FR_HOME 写入仍拒绝');

    // reportlets 之外的 FR 文件：普通工具仍然拒绝（防读配置/凭据）
    assert.throws(() => assertToolPath('read_cpt', outside, { write: false }), /不在允许目录/, 'reportlets 外不放行');
  } finally {
    if (prev === undefined) delete process.env.FR_HOME; else process.env.FR_HOME = prev;
    fs.rmSync(fr, { recursive: true, force: true });
  }
});
