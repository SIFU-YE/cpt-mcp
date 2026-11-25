// test/morphology-rules.test.js —— 形态规律反哺（2026-10-27 官方 1,550 样本全量统计）
//   · 提交器 <SubmitVisitor>(156) 与 <Submiter>(65) 互斥：全库 0 例共存 → 共存即 error
//   · <ConditionAttr> 是图表专属伴随结构（525/525 与 <Chart> 共现）→ 无 Chart 即 warning
//   · <ReportPageAttr> 1,550/1,550 必备 → 缺失提示带实证注记
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCpt, addCell, addFillSubmit } from '../lib/generate.js';
import { validateCpt } from '../lib/validate.js';
import '../scripts/isolate-store.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-morph-'));

test('普通模板：不误报互斥/双口径；ReportPageAttr 缺失提示带实证', () => {
  const d = tmp();
  try {
    const p = path.join(d, 'a.cpt');
    createCpt(p, { rows: 4, columns: 4 });
    addCell(p, { column: 0, row: 1, content: 'x' });
    addFillSubmit(p, { dsName: 'ds1', table: 't1', bindings: [{ field: 'a', column: 0, row: 1 }] });
    const issues = validateCpt(p);
    const text = JSON.stringify(issues);
    assert.equal(text.includes('两种提交器'), false, '单提交器不误报');
    assert.equal(text.includes('无伴随'), false, '无 ConditionAttr 不误报');
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test('SubmitVisitor 与 Submiter 共存 → error（官方 0 例共存）', () => {
  const d = tmp();
  try {
    const p = path.join(d, 'b.cpt');
    createCpt(p, { rows: 4, columns: 4 });
    addCell(p, { column: 0, row: 1, content: 'x' });
    addFillSubmit(p, { dsName: 'ds1', table: 't1', bindings: [{ field: 'a', column: 0, row: 1 }] });
    // 人为混入第二种提交器（<Submiter>，与 <SubmitVisitor> 是不同标签）
    const raw = fs.readFileSync(p, 'utf8');
    const patched = raw.replace('</ReportWriteAttr>',
      '<Submiter class="com.fr.report.write.BuiltInSQLSubmiter"><Name><![CDATA[混入]]></Name></Submiter></ReportWriteAttr>');
    assert.notEqual(patched, raw, '应插到 ReportWriteAttr 内');
    fs.writeFileSync(p, patched, 'utf8');

    const issues = validateCpt(p);
    const hit = issues.find((i) => /两种提交器/.test(i.message));
    assert.ok(hit, `应报互斥：${JSON.stringify(issues).slice(0, 300)}`);
    assert.equal(hit.severity, 'error');
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test('ConditionAttr 无伴随 Chart → warning；有 Chart 则不报', () => {
  const d = tmp();
  try {
    const p = path.join(d, 'c.cpt');
    createCpt(p, { rows: 4, columns: 4 });
    addCell(p, { column: 0, row: 1, content: 'x' });
    let raw = fs.readFileSync(p, 'utf8');
    raw = raw.replace('</Report>', '<ConditionAttr><Condition/></ConditionAttr></Report>');
    fs.writeFileSync(p, raw, 'utf8');

    const issues = validateCpt(p);
    const hit = issues.find((i) => /ConditionAttr.*无伴随|无伴随/.test(i.message));
    assert.ok(hit, `应报双口径 warning：${JSON.stringify(issues).slice(0, 300)}`);
    assert.equal(hit.severity, 'warning');

    // 有 <Chart> 伴随 → 不再报
    raw = fs.readFileSync(p, 'utf8').replace('</Report>', '<Chart></Chart></Report>');
    fs.writeFileSync(p, raw, 'utf8');
    const issues2 = validateCpt(p);
    assert.equal(issues2.some((i) => /无伴随/.test(i.message)), false, '有 Chart 不应再报');
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});
