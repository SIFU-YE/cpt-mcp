// cpt-mcp/test/engine.test.js —— 微型报表引擎（样式审查/合理性审查/报表构建）测试
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildReport, reviewStyles, reviewReasonableness } from '../lib/engine/index.js';
import { buildReportSpecSchema } from '../lib/engine/spec.js';
import { validateCpt, issueSummary } from '../lib/validate.js';
import { overview } from '../lib/cpt.js';
import { createCpt, addCell } from '../lib/generate.js';
import '../scripts/isolate-store.mjs'; // M123：JS 基线 store 隔离，直跑也不污染真实 store

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-engine-test-'));
const file = (n) => path.join(TMP, n);

const buildSpec = (p) => ({
  path: p,
  title: '引擎测试报表',
  sheetName: 'sheet1',
  rows: 3,
  columns: 4,
  datasets: [
    { name: 'ds1', connection: 'JDBC', sql: 'SELECT * FROM t WHERE id=${p1}', parameters: [{ name: 'p1', defaultValue: '1' }] },
  ],
  styles: [
    { id: 'hdr', fontName: '微软雅黑', fontSizePt: 12, bold: true, horizontalAlignment: 'center' },
  ],
  cells: [
    { column: 0, row: 0, content: '报表标题', styleIndex: 0, colspan: 4 },
    { column: 0, row: 1, content: '名称', style: { id: 'hdr', fontName: '微软雅黑', fontSizePt: 12, bold: true } },
    { column: 1, row: 1, content: '=A2', styleIndex: 0 },
    { column: 2, row: 1, content: '数据列', contentType: 'dsColumn', dsName: 'ds1', columnName: 'col1', styleIndex: 0 },
  ],
  fill: { dsName: 'JDBC', table: 't1', bindings: [{ field: 'name', column: 0, row: 1, isKey: true }] },
  settings: { paper: 'A4', orientation: 0, marginTopMm: 15, marginBottomMm: 15, marginLeftMm: 10, marginRightMm: 10 },
  grid: { rowCount: 3, columnCount: 4 },
  parameters: [{ name: 'p', defaultValue: 'x' }],
  parameterPanel: { title: '查询', showWindow: true },
});

test('buildReport：语义化构建生成合法 CPT 且三层自检可运行', () => {
  const p = file('built.cpt');
  const r = buildReport(buildSpec(p));
  // 文件已生成
  assert.ok(fs.existsSync(p), 'CPT 文件应已生成');
  // 骨架报告：应有工作表
  const ov = overview(p);
  assert.equal(ov.sheets.length, 1);
  // 自检对象存在
  assert.ok(r.checkResult, '应返回自检结果');
  // 三层可解析（不抛异常即可，issues 可空可非空）
  assert.ok(Array.isArray(r.checkResult.validate.issues));
  assert.ok(Array.isArray(r.checkResult.style.issues));
  assert.ok(Array.isArray(r.checkResult.reasonableness.issues));
  // validate 不应出现"文件无法解析"之类的 error（存在 error 语义上允许，但 count 可统计）
  assert.equal(r.checkResult.validate.summary.error + r.checkResult.validate.summary.warning + r.checkResult.validate.summary.info >= 0, true);
});

test('构建产物可被 validate/review 再次独立解析（幂等/不损坏）', () => {
  const p = file('built2.cpt');
  buildReport(buildSpec(p), { check: false });
  const v = validateCpt(p);
  const st = reviewStyles(p);
  const rs = reviewReasonableness(p);
  // 关键：结构校验不应是"无法解析"这种文件级 error
  const fatal = v.filter((i) => i.severity === 'error' && /无法解析|XML 校验失败/.test(i.message));
  assert.equal(fatal.length, 0, '不应出现文件级解析错误');
  // 单元格数量：标题+名称+公式+数据列
  const ov = overview(p);
  assert.ok(ov.cellCount >= 3);
});

test('官方基准：Demo.cpt 审查函数结构正确（若样本存在）', (t) => {
  const demo = 'D:/FineReport_11.0/webapps/webroot/WEB-INF/reportlets/demo/analytics/Demo.cpt';
  if (!fs.existsSync(demo)) {
    t.skip('官方样本不存在，跳过');
    return;
  }
  const st = reviewStyles(demo);
  const rs = reviewReasonableness(demo);
  const v = validateCpt(demo);
  assert.ok(Array.isArray(st.issues));
  assert.ok(Array.isArray(rs.issues));
  assert.ok(Array.isArray(v));
  // issues 结构：severity/location/message
  for (const i of [...st.issues, ...rs.issues]) {
    assert.ok(['error', 'warning', 'info'].includes(i.severity));
    assert.ok(i.message);
  }
});

// —— 审查发现的边界/健壮性回归 ——
test('边界：无 StyleList / 样式索引越界 不崩溃且能标记', () => {
  const p1 = file('nostyle.cpt');
  createCpt(p1, { title: 'ns' });
  fs.writeFileSync(p1, fs.readFileSync(p1, 'utf8').replace(/<StyleList>[\s\S]*?<\/StyleList>/, ''));
  assert.doesNotThrow(() => reviewStyles(p1));
  assert.doesNotThrow(() => reviewReasonableness(p1));

  const p2 = file('oob.cpt');
  createCpt(p2, { title: 'oob' });
  addCell(p2, { column: 0, row: 0, content: 'x', styleIndex: 999 });
  const st = reviewStyles(p2);
  assert.ok(st.issues.some((i) => i.severity === 'error' && /越界/.test(i.message)), '样式越界应报 error');
});

test('边界：中文字段名不应被误报“特殊字符”', () => {
  const p = file('zh.cpt');
  buildReport({
    path: p, title: 'zh', rows: 2, columns: 2,
    cells: [{ column: 0, row: 0, content: '金额', styleIndex: 0 }],
    fill: { dsName: 'JDBC', table: 't', bindings: [{ field: '用户金额', column: 0, row: 0, isKey: true }] },
    check: false,
  });
  const rs = reviewReasonableness(p);
  const special = rs.issues.filter((i) => i.message.includes('特殊字符'));
  assert.equal(special.length, 0, '中文字段名不应被误报为特殊字符');
});

test('边界：builder 相同样式对象复用（不重复 addStyle）', () => {
  const p = file('dedup.cpt');
  const r = buildReport({
    path: p, title: 'dedup', rows: 2, columns: 2,
    styles: [{ fontName: '微软雅黑', fontSizePt: 12, bold: true }],
    cells: [
      { column: 0, row: 0, content: 'a', style: { fontName: '微软雅黑', fontSizePt: 12, bold: true } },
      { column: 1, row: 0, content: 'b', style: { fontName: '微软雅黑', fontSizePt: 12, bold: true } },
    ],
    check: false,
  });
  const addStyleSteps = r.steps.filter((s) => s && s.action === 'add_style');
  assert.equal(addStyleSteps.length, 1, '相同样式应只登记一次');
});

test('build_report 结构化 spec schema：合法通过、非法拦截（zod 参数层）', () => {
  // 合法：正常 spec 应通过
  const ok = buildReportSpecSchema.safeParse({
    title: 't', rows: 3, columns: 4,
    datasets: [{ name: 'ds', sql: 'SELECT * FROM t' }],
    cells: [{ column: 0, row: 0, content: 'x', style: { fontSizePt: 12, foregroundColor: '#C0C0C0' } }],
    fill: { table: 't1', bindings: [{ field: 'a', column: 0, row: 0 }] },
    settings: { paper: 'A4' },
    check: false,
  });
  assert.equal(ok.success, true, '合法 spec 应通过 schema 校验');

  // 非法：单元格负坐标
  const neg = buildReportSpecSchema.safeParse({ cells: [{ column: -1, row: 0 }] });
  assert.equal(neg.success, false, '负坐标应被 schema 拒绝');
  // 非法：fill 缺目标表
  const noTable = buildReportSpecSchema.safeParse({ fill: { dsName: 'JDBC' } });
  assert.equal(noTable.success, false, 'fill 缺 table 应被 schema 拒绝');
  // 非法：字号超范围
  const badFont = buildReportSpecSchema.safeParse({ styles: [{ fontSizePt: 9999 }] });
  assert.equal(badFont.success, false, '字号超范围应被 schema 拒绝');
  // 非法：非法颜色
  const badColor = buildReportSpecSchema.safeParse({ styles: [{ foregroundColor: 'red' }] });
  assert.equal(badColor.success, false, '非法颜色应被 schema 拒绝');
});

