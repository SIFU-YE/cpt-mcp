// cpt-mcp/test/build-report-rewrite.test.js —— build_report 覆盖语义回归测试
// 2026-11-06 P0 语义：默认 noOverwrite=true（目标已存在拒绝覆盖）；
// 只有显式 noOverwrite:false 才允许重跑覆盖同一 path。本文件锁定两侧行为。
// 跑法: cd 桌面 && node --test test/build-report-rewrite.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildReport } from '../lib/engine/builder.js';
import { readFillToolbarButtons } from '../lib/edits.js';
import { validateCpt } from '../lib/validate.js';
import '../scripts/isolate-store.mjs'; // M123：JS 基线 store 隔离，直跑也不污染真实 store

test('build_report 显式 noOverwrite:false 可重跑同一 path（覆盖原文件）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-build-rewrite-'));
  const p = path.join(dir, 'x.cpt');
  const spec = {
    title: '重跑覆盖测试',
    rows: 3,
    columns: 4,
    headerRowCount: 1,
    datasets: [
      { name: 'ds1', connection: 'Doris', sql: "SELECT 1 AS a" },
    ],
    styles: [
      { fontSizePt: 14, bold: false, horizontalAlignment: 0 },
      { fontSizePt: 18, bold: true, horizontalAlignment: 0 },
    ],
    cells: [
      { column: 0, row: 0, content: '表头', styleIndex: 1 },
      { column: 0, row: 1, content: '数据', styleIndex: 0 },
    ],
    fill: {
      dsName: 'Doris',
      table: 't1',
      bindings: [{ field: 'a', column: 0, row: 1 }],
    },
  };

  // 第 1 次：成功（新路径，默认值不构成阻碍）
  const r1 = buildReport({ path: p, ...spec });
  assert.ok(fs.existsSync(p), '第 1 次：文件应已生成');
  assert.equal(r1.checkResult.hasError, false, '第 1 次：checkResult.hasError=false');
  const mtime1 = fs.statSync(p).mtimeMs;

  // 第 2 次：显式 noOverwrite:false 才允许覆盖（新语义下默认会拒绝）
  let r2;
  assert.doesNotThrow(() => { r2 = buildReport({ path: p, ...spec, noOverwrite: false }); });
  assert.ok(fs.existsSync(p), '第 2 次：文件应仍存在');
  assert.equal(r2.checkResult.hasError, false, '第 2 次：checkResult.hasError=false');
  const mtime2 = fs.statSync(p).mtimeMs;
  assert.ok(mtime2 >= mtime1, '第 2 次：mtime 应不早于第 1 次（文件被覆盖）');

  // 第 3 次：再次重跑（连续覆盖 3 次）
  let r3;
  assert.doesNotThrow(() => { r3 = buildReport({ path: p, ...spec, noOverwrite: false }); });
  assert.equal(r3.checkResult.hasError, false);

  // 校验最终文件
  const issues = validateCpt(p);
  const errs = issues.filter((i) => i.severity === 'error');
  assert.equal(errs.length, 0, '最终 validate_cpt: 0 error');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('build_report 改 spec 后重跑：新内容覆盖旧内容', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-build-rewrite-'));
  const p = path.join(dir, 'x.cpt');
  const spec1 = {
    title: '第一版',
    rows: 3,
    columns: 4,
    cells: [{ column: 0, row: 0, content: 'A1', styleIndex: 0 }],
  };
  const spec2 = {
    title: '第二版',  // 改了
    rows: 5,           // 改了
    columns: 6,       // 改了
    cells: [{ column: 0, row: 0, content: 'B1', styleIndex: 0 }],
  };

  buildReport({ path: p, ...spec1 });
  const raw1 = fs.readFileSync(p, 'utf8');
  assert.ok(raw1.includes('A1'), '第 1 版应含 A1');

  buildReport({ path: p, ...spec2, noOverwrite: false });
  const raw2 = fs.readFileSync(p, 'utf8');
  assert.ok(raw2.includes('B1'), '第 2 版应含 B1');
  assert.ok(!raw2.includes('A1'), '第 2 版不应含 A1（旧内容被覆盖）');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('build_report 不存在的路径照常工作（原有功能）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-build-rewrite-'));
  const p = path.join(dir, 'x.cpt');
  const spec = {
    title: '全新生成',
    rows: 2,
    columns: 2,
    cells: [],
  };
  let r;
  assert.doesNotThrow(() => { r = buildReport({ path: p, ...spec }); });
  assert.ok(fs.existsSync(p));
  assert.equal(r.checkResult.hasError, false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('build_report 默认（不传 noOverwrite）拒绝覆盖已有文件（2026-11-06 P0）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-build-rewrite-'));
  const p = path.join(dir, 'x.cpt');
  fs.writeFileSync(p, 'PRESERVE_ME', 'utf8');

  assert.throws(
    () => buildReport({ path: p, rows: 2, columns: 2, cells: [] }),
    /noOverwrite=true.*拒绝覆盖/,
    '默认应拒绝覆盖已有文件'
  );
  assert.equal(fs.readFileSync(p, 'utf8'), 'PRESERVE_ME', '默认拒绝时旧文件不应被删/改');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('build_report noOverwrite=true 拒绝覆盖已有文件（S3）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-build-rewrite-'));
  const p = path.join(dir, 'x.cpt');
  // 先建一个含特殊标记的旧文件
  fs.writeFileSync(p, 'PRESERVE_ME', 'utf8');

  // 尝试覆盖应抛错
  assert.throws(
    () => buildReport({ path: p, rows: 2, columns: 2, cells: [], noOverwrite: true }),
    /noOverwrite=true.*拒绝覆盖/,
    'noOverwrite=true 应当拒绝覆盖'
  );

  // 关键: 旧文件内容应保持不变
  const preserved = fs.readFileSync(p, 'utf8');
  assert.equal(preserved, 'PRESERVE_ME', 'noOverwrite=true 时旧文件不应被删');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('CPT_MCP_NO_BAK=1 时覆盖发布不留 .bak-build-*（版本走报表模式）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-build-rewrite-'));
  const p = path.join(dir, 'x.cpt');
  const prev = process.env.CPT_MCP_NO_BAK;
  process.env.CPT_MCP_NO_BAK = '1';
  try {
    buildReport({ path: p, rows: 2, columns: 2, cells: [] });
    buildReport({ path: p, rows: 2, columns: 2, cells: [], noOverwrite: false });
    assert.ok(fs.existsSync(p), '覆盖发布仍成功');
    assert.equal(fs.readdirSync(dir).filter((f) => f.includes('.bak-build-')).length, 0);
    assert.equal(validateCpt(p).filter((i) => i.severity === 'error').length, 0);
  } finally {
    if (prev === undefined) delete process.env.CPT_MCP_NO_BAK;
    else process.env.CPT_MCP_NO_BAK = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('build_report noOverwrite=true 但文件不存在: 正常创建', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-build-rewrite-'));
  const p = path.join(dir, 'x.cpt');
  assert.doesNotThrow(() => {
    buildReport({ path: p, rows: 2, columns: 2, cells: [], noOverwrite: true });
  });
  assert.ok(fs.existsSync(p));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('M106 整表重建清空填报工具栏必须预警（toolbarNotice）+ 照预警可原样补回', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-build-toolbar-'));
  const p = path.join(dir, 'tb.cpt');
  const base = { path: p, title: '工具栏预警', rows: 4, columns: 3, webWrite: true };
  const buttons = ['submit', 'append-row', 'delete-row', 'import-append'];

  // ① 首次构建（无原模板）不应误报
  const first = buildReport({ ...base, toolbar: buttons });
  assert.equal(first.toolbarNotice, null, '首次构建无原工具栏，不应预警');
  assert.deepEqual(readFillToolbarButtons(p).sort(), [...buttons].sort());

  // ② 重建但不传 toolbar → 必须预警，且回显原按钮、给出可照抄的补救写法
  const second = buildReport({ ...base, noOverwrite: false });
  assert.ok(second.toolbarNotice, '原工具栏非空而本次未传 toolbar，必须给 toolbarNotice');
  assert.equal(second.toolbarNotice.level, 'warning');
  assert.deepEqual(second.toolbarNotice.cleared.sort(), [...buttons].sort(), '预警须回显原有按钮');
  assert.match(second.toolbarNotice.message, /set_fill_toolbar/, '预警须给出补救路径');
  assert.deepEqual(readFillToolbarButtons(p), [], '重建后工具栏确实为空（现象如实上报）');

  // ③ 照预警把按钮传回去 → 不应再预警，且按钮原样恢复
  const third = buildReport({ ...base, toolbar: second.toolbarNotice.cleared, noOverwrite: false });
  assert.equal(third.toolbarNotice, null);
  assert.deepEqual(readFillToolbarButtons(p).sort(), [...buttons].sort(), '按钮须原样补回');
  assert.equal(validateCpt(p).filter((i) => i.severity === 'error').length, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});
