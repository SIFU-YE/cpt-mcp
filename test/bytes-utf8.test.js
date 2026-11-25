import '../scripts/isolate-store.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createCpt, addDataset } from '../lib/generate.js';
import { addParameter, updateParameter } from '../lib/edits.js';

delete process.env.CPT_MCP_ALLOWED_ROOTS;

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-bytesutf8-'));

test('F4 中文内容模板 bytes===statSync.size（UTF-8 口径）', () => {
  const d = tmp();
  const p = path.join(d, 'cn.cpt');
  const r = createCpt(p, { rows: 3, columns: 3, title: '销售报表_测试中文' });
  const stat = fs.statSync(p).size;
  assert.equal(r.bytes, stat, '中文标题模板 bytes 应等于文件 stat 大小');
  const raw = fs.readFileSync(p, 'utf8');
  assert.equal(r.bytes, Buffer.byteLength(raw, 'utf8'), 'bytes 应等于 Buffer.byteLength(落盘原文)');
  assert.ok(Buffer.byteLength(raw, 'utf8') > raw.length, '中文模板应能区分 UTF-8 字节与 UTF-16 length（旧口径会偏小）');
  fs.rmSync(d, { recursive: true, force: true });
});

test('F4 ASCII 模板 bytes===statSync.size', () => {
  const d = tmp();
  const p = path.join(d, 'ascii.cpt');
  const r = createCpt(p, { rows: 3, columns: 3, title: 'ascii-title-123' });
  const stat = fs.statSync(p).size;
  assert.equal(r.bytes, stat, 'ASCII 模板 bytes 应等于文件 stat 大小');
  fs.rmSync(d, { recursive: true, force: true });
});

test('F4 update_* 写工具同口径：updateParameter 中文默认值 bytes===stat', () => {
  const d = tmp();
  const p = path.join(d, 'upd.cpt');
  createCpt(p, { rows: 3, columns: 3 });
  addDataset(p, { name: 'ds1', connection: 'Doris', sql: 'SELECT 1' });
  addParameter(p, 'ptest', 'init');
  const r = updateParameter(p, 'ptest', '中文默认值测试');
  const stat = fs.statSync(p).size;
  assert.equal(r.bytes, stat, 'updateParameter 中文写回后 bytes 应等于文件 stat 大小');
  const raw = fs.readFileSync(p, 'utf8');
  assert.equal(r.bytes, Buffer.byteLength(raw, 'utf8'));
  fs.rmSync(d, { recursive: true, force: true });
});
