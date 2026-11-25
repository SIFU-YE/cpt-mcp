// test/set-content-type-force.test.js —— P0-3（审计 G 类 7 条）：对象内容换型 force 整块替换
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCpt, addCell } from '../lib/generate.js';
import { setCellContentType } from '../lib/edits.js';
import '../scripts/isolate-store.mjs';

test('对象内容换型：无 force 报错带药方；force:true 整块替换', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-force-'));
  try {
    const p = path.join(d, 'a.cpt');
    createCpt(p, { rows: 3, columns: 3 });
    // 先建文本格，再用 setCellContentType 转成公式 —— 公式 = 对象内容（<O t="XMLable" class="com.fr.base.Formula">…）
    addCell(p, { column: 0, row: 1, content: '占位' });
    setCellContentType(p, { column: 0, row: 1, contentType: 'formula', formula: 'SUM(A1:A2)' });
    const raw0 = fs.readFileSync(p, 'utf8');
    assert.ok(raw0.includes('<O t="'), '前置条件：应是对象内容');

    assert.throws(
      () => setCellContentType(p, { column: 0, row: 1, contentType: 'text', content: '你好' }),
      /force:true/,
      '无 force 应报错并给出 force 药方',
    );

    const r = setCellContentType(p, { column: 0, row: 1, contentType: 'text', content: '你好', force: true });
    assert.equal(r.forced, true, '结果应标记 forced');
    assert.equal(r.mode, 'replace-object');

    const raw = fs.readFileSync(p, 'utf8');
    assert.ok(raw.includes('你好'), '新内容应落盘');
    assert.equal(raw.includes('com.fr.base.Formula'), false, '原对象内容应被整块替换');
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test('force 不影响普通单元格换型（text→formula 正常路径）', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-force2-'));
  try {
    const p = path.join(d, 'b.cpt');
    createCpt(p, { rows: 3, columns: 3 });
    addCell(p, { column: 1, row: 1, content: '文本' });
    const r = setCellContentType(p, { column: 1, row: 1, contentType: 'formula', formula: 'SUM(A1:A2)' });
    assert.notEqual(r.mode, 'replace-object');
    const raw = fs.readFileSync(p, 'utf8');
    assert.ok(raw.includes('com.fr.base.Formula'), '应换成公式对象内容');
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});
