// test/result-formula.test.js —— 字段显示值变换（官方 <Result> 元素）
//
// 逆向依据（官方 1559 样本实测）：
//   DSColumn 单元格共 5517 个，其中带 <Result> 的只有 479 个（8.7%），
//   而这 479 个里又有 364 个是恒等的 `$$$`（等于没变换）。
//   ⇒ 结论一：<Result> **不是必填**，不给它与 91.3% 的官方样本一致。
//   ⇒ 结论二：它承载的是真正的"字段逻辑"——
//        `$$$/10000`                      元 → 万元
//        `ROUND($$$,0)`                   取整
//        `货主城市+$$$`                    与别的字段拼接
//        `$$$ + "( 分机号：" + 分机 + ")"`  串成一句话
//   元素位置（官方实测，顺序固定）：
//     Attributes > [Condition] > Complex > RG > Result > Parameters > [cellSortAttr]
//
// 【本文件锁住三件事】
//   1. 给 result 时 <Result> 落在 <RG> 之后、<Parameters/> 之前
//   2. 不给 result 时绝不产出 <Result>（保持与官方 91.3% 一致的形态）
//   3. 非法输入被拒，且不写坏文件
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateReport } from '../lib/engine/index.js';
import { createCpt, addCell, addDataset } from '../lib/generate.js';
import { validateCpt } from '../lib/validate.js';
import '../scripts/isolate-store.mjs'; // M123：JS 基线 store 隔离，直跑也不污染真实 store

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-result-'));
const read = (p) => fs.readFileSync(p, 'utf8');

/** 取出某个 DSColumn 单元格块 */
const dsColumnBlock = (xml, columnName) => {
  const at = xml.indexOf(`columnName="${columnName}"`);
  assert.notEqual(at, -1, `应有 columnName=${columnName} 的单元格`);
  const start = xml.lastIndexOf('<O t="DSColumn">', at);
  return xml.slice(start, xml.indexOf('</O>', at) + 4);
};

test('addCell.result：<Result> 落在 RG 之后、Parameters 之前', () => {
  const d = tmp();
  const p = path.join(d, 'a.cpt');
  createCpt(p, { rows: 3, columns: 2 });
  addDataset(p, { name: 'ds1', connection: 'Doris', sql: 'SELECT 1' });
  addCell(p, {
    column: 0, row: 1, contentType: 'dsColumn',
    dsName: 'ds1', columnName: 'amount', result: '$$$/10000',
  });
  const blk = dsColumnBlock(read(p), 'amount');
  // 顺序：Attributes → Complex → RG → Result → Parameters
  const seq = [...blk.matchAll(/<([A-Za-z][\w]*)\b/g)].map((m) => m[1]);
  assert.ok(seq.indexOf('RG') < seq.indexOf('Result'), 'Result 必须在 RG 之后');
  assert.ok(seq.indexOf('Result') < seq.indexOf('Parameters'), 'Result 必须在 Parameters 之前');
  assert.match(blk, /<Result>\s*<!\[CDATA\[\$\$\$\/10000\]\]><\/Result>/);
});

test('不传 result 时绝不产出 <Result>（与官方 91.3% 形态一致）', () => {
  const d = tmp();
  const p = path.join(d, 'b.cpt');
  createCpt(p, { rows: 3, columns: 2 });
  addDataset(p, { name: 'ds1', connection: 'Doris', sql: 'SELECT 1' });
  addCell(p, { column: 0, row: 1, contentType: 'dsColumn', dsName: 'ds1', columnName: 'amount' });
  assert.doesNotMatch(dsColumnBlock(read(p), 'amount'), /<Result/);
});

test('generate_report：字段带 result → 产出显示值变换且自检无 error', () => {
  const d = tmp();
  const p = path.join(d, '万元.cpt');
  const r = generateReport({
    path: p,
    title: '销售汇总（万元）',
    source: { connection: 'Doris', table: 'sales' },
    fields: [
      { name: 'region', label: '地区', type: 'text' },
      { name: 'amount', label: '销售额', type: 'money', result: 'ROUND($$$/10000, 2)' },
    ],
  });
  assert.equal(r.checkResult.hasError, false);
  const blk = dsColumnBlock(read(p), 'amount');
  assert.match(blk, /<Result>\s*<!\[CDATA\[ROUND\(\$\$\$\/10000, 2\)\]\]><\/Result>/);
  // 只给一个字段加 result 时，另一个字段不该被波及
  assert.doesNotMatch(dsColumnBlock(read(p), 'region'), /<Result/);
});

test('安全围栏：result 传非字符串被拒，且不写坏文件', () => {
  const d = tmp();
  const p = path.join(d, 'c.cpt');
  assert.throws(
    () => generateReport({
      path: p, title: 'x',
      source: { connection: 'Doris', table: 't' },
      fields: [{ name: 'amount', type: 'money', result: 10000 }],
    }),
    /必须是字符串/,
    'result: 10000 这种数字输入若静默当公式写进去，设计器里会显示成一个裸数字，极难排查',
  );
});

test('result 的 CDATA 闭合注入被挡（assertSafeCdata 生效）', () => {
  const d = tmp();
  const p = path.join(d, 'd.cpt');
  createCpt(p, { rows: 3, columns: 2 });
  addDataset(p, { name: 'ds1', connection: 'Doris', sql: 'SELECT 1' });
  assert.throws(
    () => addCell(p, {
      column: 0, row: 1, contentType: 'dsColumn',
      dsName: 'ds1', columnName: 'a', result: '$$$ ]]> <x/>',
    }),
    /\]\]>/,
  );
});

test('带 result 的模板仍通过结构校验', () => {
  const d = tmp();
  const p = path.join(d, 'e.cpt');
  generateReport({
    path: p, title: 'x',
    source: { connection: 'Doris', table: 't' },
    fields: [{ name: 'a', type: 'money', result: '$$$/1000' }],
  });
  // validateCpt 返回 issue 数组（不是 {hasError} 对象），这里断言没有 error 级问题
  const issues = validateCpt(p);
  const errs = issues.filter((i) => i.severity === 'error');
  assert.deepEqual(errs, [], `不应有 error 级问题：${JSON.stringify(errs)}`);
});
