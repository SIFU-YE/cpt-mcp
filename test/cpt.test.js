// cpt-mcp/test/cpt.test.js —— 端到端测试：create→add 全链路生成模板并校验
// 运行：npm test  （node --test test/）
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createCpt, addDataset, addStyle, addCell, addFillSubmit, setReportSettings, setParameterPanel, setGrid, addParameterWidget, setTemplateTheme, addFloatElement, addSheet } from '../lib/generate.js';
import { addChart } from '../lib/engine/chart.js';
import {
  addParameter, updateDatasetSql, addFillBinding, updateCellStyle, getCellStyle,
  updateParameter, deleteParameter, updateCellTooltip, updateCellContent, deleteCell,
  updateFillBinding, deleteFillBinding, setCellContentType, setCellListener, deleteParameterWidget, setFillToolbar, setReportJs, setWebWriteJs,
  deleteCellSort, addCellHighlight,
  getChart, updateChart, updateCellHyperlink, updateCellHighlight, getCellListener, updateCellListener, deleteCellListener,
  getCellSort, updateCellSort, getFloatElement, updateFloatElement, updateFillSubmit, updateSheet,
  addCellHyperlink, getCellHyperlink, getCellHighlight, updateCellInsertPolicy,
  normalizeInsertPolicy, INSERT_POLICY_VALUES,
} from '../lib/edits.js';
import { load, styleBlocks } from '../lib/xml.js';
import { datasets, parameters, cells, fillConfig, overview, parameterPanel } from '../lib/cpt.js';
import { validateCpt, issueSummary } from '../lib/validate.js';
import { planCellBatch, applyCellBatch } from '../lib/cell-batch.js';
import { diagnoseFillRowIntegrity, cellFillProfile } from '../lib/fill-integrity.js';
import '../scripts/isolate-store.mjs'; // M123：JS 基线 store 隔离，直跑也不污染真实 store

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-mcp-test-'));
const file = (n) => path.join(TMP, n);

function errorsOf(p) {
  return validateCpt(p).filter((i) => i.severity === 'error').map((i) => i.message);
}

/** 造一个填报 sheet（表头 + 数据行控件 + DSColumn + 提交），供 insertPolicy / 填报行完整性测试复用 */
function makeFillSheet(p) {
  createCpt(p, { title: '填报完整性', rows: 3, columns: 5, webWrite: true });
  addStyle(p, { fontSizePt: 12, bold: true });
  addStyle(p, { fontSizePt: 12 });
  ['工号', '姓名', '部门', '入职日期', '薪资'].forEach((h, i) =>
    addCell(p, { column: i, row: 0, content: h, styleIndex: 1 }));
  addCell(p, { column: 0, row: 1, styleIndex: 2, widget: 'text' });
  addCell(p, { column: 1, row: 1, styleIndex: 2, widget: 'text' });
  addCell(p, { column: 2, row: 1, styleIndex: 2, widget: 'comboBox', widgetItems: [{ key: '研发', value: '研发' }] });
  addCell(p, { column: 3, row: 1, styleIndex: 2, widget: 'date' });
  addCell(p, { column: 4, row: 1, styleIndex: 2, widget: 'number' });
  addFillSubmit(p, { dsName: 'Doris', table: 'emp', bindings: [{ field: 'no', column: 0, row: 1, isKey: true }] });
  return p;
}

// ---------------- 填报行完整性：insertPolicy 写/读/校验/诊断闭环 ----------------

test('insertPolicy：官方枚举白名单（copy/default/null）与非法值拒绝', () => {
  assert.deepEqual([...INSERT_POLICY_VALUES], ['null', 'default', 'copy']);
  assert.equal(normalizeInsertPolicy('copy'), 'copy');
  assert.equal(normalizeInsertPolicy(' copy '), 'copy');
  assert.equal(normalizeInsertPolicy('default'), 'default');
  assert.equal(normalizeInsertPolicy('null'), 'null');
  // 臆造值必须拒绝（FR 常量池实证只有三态，first/none 之类的猜测会产出设计器不认的模板）
  for (const bad of ['first', 'none', 'true', 'Copy', '1']) {
    assert.throws(() => normalizeInsertPolicy(bad), /取值非法/, `应拒绝 ${bad}`);
  }
});

test('insertPolicy：updateCellInsertPolicy 写入官方形态，位置在 CellOptionalAttrHolder 之后、Expand 之前', () => {
  const p = file('ip-form.cpt');
  makeFillSheet(p);
  const r = updateCellInsertPolicy(p, 0, 1, 'copy');
  assert.equal(r.action, 'update_cell_insert_policy');
  assert.equal(r.mode, 'insert');
  const xml = fs.readFileSync(p, 'utf8');
  const cellStart = xml.indexOf('<C c="0" r="1"');
  const seg = xml.slice(cellStart, xml.indexOf('</C>', cellStart));
  assert.ok(seg.includes('<CellInsertPolicy><InsertPolicy><![CDATA[copy]]></InsertPolicy></CellInsertPolicy>'), `应写入官方 CDATA 形态，实际：${seg.slice(0, 200)}`);
  assert.ok(seg.indexOf('<PrivilegeControl/>') < seg.indexOf('<CellInsertPolicy'), '应排在 PrivilegeControl 之后（官方序列化顺序：值→PrivilegeControl→其他属性）');
  assert.ok(seg.indexOf('<CellInsertPolicy') < seg.indexOf('<Expand'), '应排在 <Expand> 之前');
});

test('insertPolicy：既有自闭合 <CellInsertPolicy/>（官方主流形态 82/100 份模板）可写可删，batch 同路径', () => {
  // F1 回归：官方 1550 样本里自闭合 <CellInsertPolicy/> 出现 576 处 / 82 份模板（设计器把 null 值落盘成自闭合）。
  // 旧实现用 blockRange 找闭合标签 → 对自闭合直接抛错，写入口在这批模板上全线失效（业务侧只能再直写 XML）。
  const p = file('ip-selfclosing.cpt');
  makeFillSheet(p);
  fs.writeFileSync(p, fs.readFileSync(p, 'utf8')
    .replace('<C c="0" r="1" s="2">', '<C c="0" r="1" s="2">\n<CellInsertPolicy/>'), 'utf8');
  // ① set（自闭合 → 官方完整形态）
  const r = updateCellInsertPolicy(p, 0, 1, 'copy');
  assert.equal(r.mode, 'update-self-closing');
  assert.equal(cells(p).find((c) => c.column === 0 && c.row === 1).insertPolicy, 'copy');
  assert.equal((fs.readFileSync(p, 'utf8').match(/<CellInsertPolicy/g) || []).length, 1, '不得重复落节点');
  // ② replace（已有完整节点再改写）
  assert.equal(updateCellInsertPolicy(p, 0, 1, 'default').mode, 'update');
  assert.equal(cells(p).find((c) => c.column === 0 && c.row === 1).insertPolicy, 'default');
  // ③ remove（整块删除，不留空行）
  assert.equal(updateCellInsertPolicy(p, 0, 1, null).mode, 'remove');
  const afterRemove = fs.readFileSync(p, 'utf8');
  assert.equal((afterRemove.match(/CellInsertPolicy/g) || []).length, 0);
  assert.ok(!/\n\s*\n\s*<Expand/.test(afterRemove), `删除后不应留下空行：${JSON.stringify(afterRemove.slice(afterRemove.indexOf('<C c="0" r="1"'), afterRemove.indexOf('<C c="0" r="1"') + 160))}`);
  // ④ batch patch 走同一路径：自闭合格上 plan→apply 批量补 copy
  const p2 = file('ip-selfclosing-batch.cpt');
  makeFillSheet(p2);
  fs.writeFileSync(p2, fs.readFileSync(p2, 'utf8')
    .replace('<C c="0" r="1" s="2">', '<C c="0" r="1" s="2">\n<CellInsertPolicy/>'), 'utf8');
  const plan = planCellBatch(p2, [{ op: 'update', target: { sheet: 0, cells: ['A2'] }, data: { patch: { insertPolicy: 'copy' } } }]);
  assert.equal(plan.status, 'ready', `自闭合格上 batch plan 不应失败：${JSON.stringify(plan)}`);
  assert.equal(applyCellBatch(p2, plan.planId).status, 'applied');
  assert.equal(cells(p2).find((c) => c.column === 0 && c.row === 1).insertPolicy, 'copy');
  // ⑤ 混存文件（自闭合 + 完整节点）两格都能改
  const p3 = file('ip-mixed.cpt');
  makeFillSheet(p3);
  fs.writeFileSync(p3, fs.readFileSync(p3, 'utf8')
    .replace('<C c="0" r="1" s="2">', '<C c="0" r="1" s="2">\n<CellInsertPolicy/>')
    .replace('<C c="1" r="1" s="2">', '<C c="1" r="1" s="2">\n<CellInsertPolicy><InsertPolicy><![CDATA[default]]></InsertPolicy></CellInsertPolicy>'), 'utf8');
  updateCellInsertPolicy(p3, 0, 1, 'copy');
  updateCellInsertPolicy(p3, 1, 1, 'copy');
  const mixed = cells(p3).filter((c) => c.row === 1).sort((a, b) => a.column - b.column);
  assert.deepEqual(mixed.map((c) => c.insertPolicy), ['copy', 'copy', null, null, null]);
});

test('insertPolicy：CellOptionalAttrHolder 自闭合写法也作锚点（不得插到它之前）', () => {
  // F4 回归：旧正则 /<CellOptionalAttrHolder[\s>]/ 漏掉 '/'，自闭合时静默退到 PrivilegeControl 锚点，
  // 结果插入位置早于 CellOptionalAttrHolder，违背「CellOptionalAttrHolder 之后」的验收口径。
  const p = file('ip-opt-selfclosing.cpt');
  makeFillSheet(p);
  fs.writeFileSync(p, fs.readFileSync(p, 'utf8')
    .replace('<C c="0" r="1" s="2">', '<C c="0" r="1" s="2">\n<CellOptionalAttrHolder/>'), 'utf8');
  updateCellInsertPolicy(p, 0, 1, 'copy');
  const xml = fs.readFileSync(p, 'utf8');
  const c = xml.indexOf('<C c="0" r="1"');
  const seg = xml.slice(c, xml.indexOf('</C>', c));
  assert.ok(seg.indexOf('<CellInsertPolicy') > seg.indexOf('<CellOptionalAttrHolder/>'),
    `应排在自闭合 CellOptionalAttrHolder 之后，实际：${seg}`);
  assert.ok(seg.indexOf('<CellOptionalAttrHolder/>') < seg.indexOf('<PrivilegeControl/>'), '测试造出的锚点顺序应保持官方形态');
});

test('insertPolicy：已有 CellInsertPolicy 时只替换 InsertPolicy CDATA，不重复落节点', () => {
  const p = file('ip-replace.cpt');
  makeFillSheet(p);
  updateCellInsertPolicy(p, 0, 1, 'copy');
  updateCellInsertPolicy(p, 0, 1, 'default');
  const xml = fs.readFileSync(p, 'utf8');
  assert.equal((xml.match(/<CellInsertPolicy/g) || []).length, 1);
  assert.ok(xml.includes('<![CDATA[default]]>'));
  assert.equal(cells(p).find((c) => c.column === 0 && c.row === 1).insertPolicy, 'default');
  // CellOptionalAttrHolder 存在时插到它之后（写 XML 取证：CellOptionalAttrHolder 与 CellInsertPolicyAttr 同为 optionalAttributes）
  const p2 = file('ip-anchor.cpt');
  makeFillSheet(p2);
  fs.writeFileSync(p2, fs.readFileSync(p2, 'utf8').replace('<C c="0" r="1" s="2">', '<C c="0" r="1" s="2">\n<CellOptionalAttrHolder/>'), 'utf8');
  updateCellInsertPolicy(p2, 0, 1, 'copy');
  const xml2 = fs.readFileSync(p2, 'utf8');
  const c2 = xml2.indexOf('<C c="0" r="1"');
  const seg2 = xml2.slice(c2, xml2.indexOf('</C>', c2));
  const i2 = seg2.indexOf('<CellOptionalAttrHolder/>');
  assert.ok(i2 >= 0, '测试造出的 CellOptionalAttrHolder 应存在');
  assert.ok(seg2.indexOf('<CellInsertPolicy') > i2, `应排在 CellOptionalAttrHolder 之后，实际：${seg2}`);
  assert.ok(seg2.indexOf('<CellOptionalAttrHolder/>') < seg2.indexOf('<CellInsertPolicy'), '应排在 CellOptionalAttrHolder 之后');
  assert.ok(seg2.indexOf('<CellInsertPolicy') < seg2.indexOf('<Expand'), `应排在 <Expand> 之前，实际：${seg2}`);
});

test('insertPolicy：写后 get_cells 读回一致（copy/default），null 删除节点，未写格为 null', () => {
  const p = file('ip-roundtrip.cpt');
  makeFillSheet(p);
  const before = cells(p, { sheet: 0 }).find((c) => c.column === 2 && c.row === 1);
  assert.equal(before.insertPolicy, null, '未写入时读回 null');
  updateCellInsertPolicy(p, 2, 1, 'copy');
  assert.equal(cells(p).find((c) => c.column === 2 && c.row === 1).insertPolicy, 'copy');
  updateCellInsertPolicy(p, 2, 1, 'default');
  assert.equal(cells(p).find((c) => c.column === 2 && c.row === 1).insertPolicy, 'default');
  const removed = updateCellInsertPolicy(p, 2, 1, null);
  assert.equal(removed.mode, 'remove');
  assert.equal(cells(p).find((c) => c.column === 2 && c.row === 1).insertPolicy, null);
  assert.equal((fs.readFileSync(p, 'utf8').match(/<CellInsertPolicy/g) || []).length, 0);
});

test('insertPolicy：batch_mutate_cells 的 patch 白名单支持 insertPolicy（批量补 copy），非法值在 plan 阶段拒绝', () => {
  const p = file('ip-batch.cpt');
  makeFillSheet(p);
  const plan = planCellBatch(p, [{
    op: 'update', target: { sheet: 0, ranges: ['A2:E2'] }, data: { patch: { insertPolicy: 'copy' } },
  }]);
  assert.equal(plan.status, 'ready', JSON.stringify(plan));
  assert.equal(plan.summary.update, 5);
  const applied = applyCellBatch(p, plan.planId);
  assert.equal(applied.status, 'applied');
  const row1 = cells(p, { sheet: 0 }).filter((c) => c.row === 1).sort((a, b) => a.column - b.column);
  assert.deepEqual(row1.map((c) => c.insertPolicy), ['copy', 'copy', 'copy', 'copy', 'copy']);
  // 非法枚举：plan 阶段即失败（不落盘）
  const bad = planCellBatch(p, [{
    op: 'update', target: { sheet: 0, ranges: ['A2'] }, data: { patch: { insertPolicy: 'first' } },
  }]);
  assert.equal(bad.status, 'failed');
  assert.match(bad.message, /insertPolicy 取值非法/);
  // 未支持字段仍被拦（白名单语义保持）
  const unknown = planCellBatch(p, [{
    op: 'update', target: { sheet: 0, ranges: ['A2'] }, data: { patch: { insertPolcy: 'copy' } },
  }]);
  assert.equal(unknown.status, 'failed');
  assert.match(unknown.message, /未支持字段/);
});

test('insertPolicy：validate_cpt 只报「行内不一致」（业务侧补漏的真实症状），全行未设不报 warning；非填报 sheet 不误报', () => {
  const p = file('ip-validate.cpt');
  makeFillSheet(p);
  const fillIssues = () => validateCpt(p).filter((i) => /填报行完整性/.test(i.message));
  // 官方语料口径（1550 样本实证）：全行未设 insertPolicy 是常态 → 不报 warning
  assert.equal(fillIssues().filter((i) => i.severity === 'warning').length, 0,
    `全行未设不应报 warning（官方 178 个填报 sheet 中 175 个如此）：${JSON.stringify(fillIssues())}`);
  // 只补 3 格 → 行内不一致，报 warning 且列出缺格
  for (const col of [0, 1, 2]) updateCellInsertPolicy(p, col, 1, 'copy');
  const inconsistent = fillIssues().filter((i) => i.severity === 'warning');
  assert.equal(inconsistent.length, 1, `应报 1 条行内不一致：${JSON.stringify(inconsistent)}`);
  assert.match(inconsistent[0].location, /数据行\(sheet1!第 2 行\)/);
  assert.match(inconsistent[0].message, /sheet1!D2、sheet1!E2 未设/);
  assert.match(inconsistent[0].fix, /insertPolicy/);
  // 行内仍有未设格时只报这一条 warning（不额外刷 info；逐格清单由 diagnose 工具给）
  assert.equal(fillIssues().filter((i) => i.severity === 'info').length, 0, '有 warning 时不再追加 info 提示');
  // 补齐 5 格 → 全部清零
  for (const col of [3, 4]) updateCellInsertPolicy(p, col, 1, 'copy');
  const after = fillIssues();
  assert.equal(after.filter((i) => i.severity === 'warning').length, 0, '补齐后不应再有 warning');
  assert.equal(after.filter((i) => i.severity !== 'info').length, 0, '补齐后不应再有非 info 项');
  // 非填报 sheet（另一文件，无 SubmitVisitor）不报
  const q = file('ip-noFill.cpt');
  createCpt(q, { title: '展示', rows: 2, columns: 2 });
  addStyle(q, { fontSizePt: 12 });
  addCell(q, { column: 0, row: 0, content: 'A', styleIndex: 1 });
  assert.equal(validateCpt(q).filter((i) => /填报行完整性/.test(i.message)).length, 0);
});

test('insertPolicy：default 混用不报 warning（官方 插入行策略.cpt 形态）；copy+default 混存也归 info', () => {
  // F3/t9 回归：官方 doc/Form/LineForm/插入行策略.cpt 是 B3=default + F3=copy、A3/C3/D3/E3/G3 未设 ——
  // 同行存在两种显式策略、没有唯一对齐目标，既不能报 warning，也不能提示把 default 改成 copy。
  const p = file('ip-default-mix.cpt');
  makeFillSheet(p);
  const issuesOf = () => validateCpt(p).filter((i) => /填报行完整性/.test(i.message));
  // ① 只给 B2(列1) 设 default → 行内 default/null 混用：不得报 warning，只报 info
  updateCellInsertPolicy(p, 1, 1, 'default');
  const onlyDefault = issuesOf();
  assert.equal(onlyDefault.filter((i) => i.severity === 'warning').length, 0, `default 混用不得报 warning：${JSON.stringify(onlyDefault)}`);
  const mixInfo = onlyDefault.filter((i) => i.severity === 'info' && /default/.test(i.message));
  assert.equal(mixInfo.length, 1, `应有一条 default 混用 info：${JSON.stringify(onlyDefault)}`);
  assert.ok(!/copy/.test(mixInfo[0].fix || ''), `default 行的 fix 不得提示改成 copy：${mixInfo[0].fix}`);
  // ② t9：再给 F2(列4) 设 copy → 同行 copy+default 混存 = 无唯一对齐目标 → 仍是 info（不得报 warning）
  updateCellInsertPolicy(p, 4, 1, 'copy');
  const mixed = issuesOf();
  assert.equal(mixed.filter((i) => i.severity === 'warning').length, 0,
    `copy+default 混存不得报 warning（队长 t9 裁定）：${JSON.stringify(mixed.filter((i) => i.severity === 'warning'))}`);
  const mixRow = mixed.filter((i) => i.severity === 'info' && /insertPolicy 不统一/.test(i.message));
  assert.equal(mixRow.length, 1, `应有一条"不统一" info：${JSON.stringify(mixed)}`);
  // 文案必须按策略分组表述：copy 的格说 copy、default 的格说 default，且 fix 不得诱导改 default
  assert.match(mixRow[0].message, /sheet1!E2=copy/);
  assert.match(mixRow[0].message, /sheet1!B2=default/);
  assert.ok(!/已设 copy/.test(mixRow[0].message.replace(/sheet1!E2=copy/g, '')), `不得把 default 混述为 copy：${mixRow[0].message}`);
  // ③ 诊断侧：default 的 B2 不进待补清单；未设的格才进，且无重复坐标
  const d = diagnoseFillRowIntegrity(p);
  assert.deepEqual(d.sheets[0].missing.insertPolicyCopy, [], 'copy+default 混存不算 warning 级缺格');
  const sugg = d.sheets[0].suggestedFixCells;
  assert.ok(!sugg.includes('sheet1!B2'), `显式 default 的格不得出现在待补清单：${JSON.stringify(sugg)}`);
  assert.equal(new Set(sugg).size, sugg.length, `建议清单不得有重复坐标：${JSON.stringify(sugg)}`);
});

test('insertPolicy：t9 edge case——显式 default 不得进待补清单、文案不得误述、建议清单无重复坐标', () => {
  // 根因：曾用 !hasInsertPolicyCopy 当「缺 copy」，把显式 default 的格也当成待补，且两条收集路径叠加出重复坐标。
  const p = file('ip-t9-edge.cpt');
  makeFillSheet(p);
  const issuesOf = () => validateCpt(p).filter((i) => /填报行完整性/.test(i.message));

  // ① 仅 B2=default（其余未设）：validate 只 info；诊断的待补清单必须是「真正未设」的格，不含 B2
  updateCellInsertPolicy(p, 1, 1, 'default');
  assert.equal(issuesOf().filter((i) => i.severity === 'warning').length, 0, '仅 default 显式不得报 warning');
  const d1 = diagnoseFillRowIntegrity(p).sheets[0];
  assert.deepEqual(d1.missing.insertPolicyCopy, [], 'default 显式不属于缺 copy');
  assert.ok(!d1.suggestedFixCells.includes('sheet1!B2'), `显式 default 的 B2 不得进待补清单：${JSON.stringify(d1.suggestedFixCells)}`);
  assert.ok(!d1.recommendedInsertPolicyCopy.includes('sheet1!B2'), '显式 default 的 B2 不得进 recommendedInsertPolicyCopy');
  assert.equal(new Set(d1.suggestedFixCells).size, d1.suggestedFixCells.length, `建议清单不得重复：${JSON.stringify(d1.suggestedFixCells)}`);
  // 逐格画像三态必须可区分
  const cellB2 = d1.cells.find((c) => c.address === 'sheet1!B2');
  assert.equal(cellB2.insertPolicyUnset, false, 'B2 是显式 default，不为 unset');
  assert.equal(cellB2.insertPolicyCopy, false);
  assert.equal(cellInsertProfileFlags(p, 1, 1), 'explicit-non-copy');

  // ② 清掉 default，改成「A2=copy、其余未设」→ 唯一对齐目标就是 copy → 1 条 warning，且文案只把 A2 说成 copy
  updateCellInsertPolicy(p, 1, 1, null);
  updateCellInsertPolicy(p, 0, 1, 'copy');
  const warn = issuesOf().filter((i) => i.severity === 'warning');
  assert.equal(warn.length, 1, `copy 唯一时的行内不一致应报 1 条 warning：${JSON.stringify(warn)}`);
  assert.match(warn[0].message, /sheet1!A2 已设 copy/);
  assert.ok(!/sheet1!B2 已设 copy/.test(warn[0].message), `不得把未设格说成已设：${warn[0].message}`);
  assert.match(warn[0].fix, /insertPolicy:"copy"/);
  // 缺失坐标 = 真正未设的 B2..E2，且无重复
  const d2 = diagnoseFillRowIntegrity(p).sheets[0];
  assert.deepEqual(d2.missing.insertPolicyCopy, ['sheet1!B2', 'sheet1!C2', 'sheet1!D2', 'sheet1!E2']);
  assert.equal(new Set(d2.suggestedFixCells).size, d2.suggestedFixCells.length, `建议清单不得重复坐标：${JSON.stringify(d2.suggestedFixCells)}`);
  assert.deepEqual(d2.suggestedFixCells, ['sheet1!B2', 'sheet1!C2', 'sheet1!D2', 'sheet1!E2']);
  // 按建议清单补齐 → warning 归零（不变式：建议清单补完即自洽）
  const plan = planCellBatch(p, [{ op: 'update', target: { sheet: 0, cells: d2.suggestedFixCells.map((a) => a.split('!')[1]) }, data: { patch: { insertPolicy: 'copy' } } }]);
  assert.equal(plan.status, 'ready', JSON.stringify(plan));
  applyCellBatch(p, plan.planId);
  assert.equal(issuesOf().filter((i) => i.severity === 'warning').length, 0, '按建议清单补齐后不应残留 warning');
});

/** 读回指定格的三态标记（供 t9 用例断言 unset / explicit-non-copy / copy 可区分） */
function cellInsertProfileFlags(p, column, row) {
  const cell = cells(p).find((c) => c.column === column && c.row === row);
  const prof = cellFillProfile(cell);
  if (prof.policyUnset) return 'unset';
  return prof.hasInsertPolicyCopy ? 'copy' : 'explicit-non-copy';
}

test('insertPolicy：diagnose_fill_row_integrity 一键盘点产出缺失清单并可驱动修复', () => {
  const p = file('ip-diagnose.cpt');
  makeFillSheet(p);
  const before = diagnoseFillRowIntegrity(p);
  assert.equal(before.action, 'diagnose_fill_row_integrity');
  const sheet = before.sheets.find((s) => s.sheetIndex === 0);
  assert.equal(sheet.fillEnabled, true);
  // 全行未设：缺 copy 清单为空（官方常态），但逐格 info 提示仍在，且给出可直接执行的 fix
  assert.deepEqual(sheet.missing.insertPolicyCopy, []);
  assert.equal(before.totals.missingInsertPolicyCopy, 0);
  const cellA2 = sheet.cells.find((c) => c.address === 'sheet1!A2');
  assert.equal(cellA2.needsInsertPolicyCopy, false);
  assert.equal(cellA2.needsInsertPolicyCopyLevel, 'info');
  assert.match(cellA2.problems.map((x) => x.fix).join('\n'), /update_cell/);
  // 只补 2 格 → 盘点出行内不一致清单（缺格坐标可直接驱动修复）
  for (const col of [0, 1]) updateCellInsertPolicy(p, col, 1, 'copy');
  const partial = diagnoseFillRowIntegrity(p);
  assert.equal(partial.totals.missingInsertPolicyCopy, 3);
  assert.equal(partial.sheets[0].partialRowCount, 1);
  assert.deepEqual(partial.sheets[0].missing.inconsistentRowMissingCells, ['sheet1!C2', 'sheet1!D2', 'sheet1!E2']);
  assert.equal(partial.sheets[0].partialRows[0].expect, 'copy');
  // suggestedFixCells 必须「补完即自洽」：按它批量补 copy 后，warning 与盘点缺口都归零
  // （否则只补缺格会在行内造出新的不一致 —— 这是本次修复的核心不变式）
  const suggested = partial.sheets[0].suggestedFixCells;
  assert.deepEqual(suggested, ['sheet1!C2', 'sheet1!D2', 'sheet1!E2']);
  const plan = planCellBatch(p, [{
    op: 'update', target: { sheet: 0, cells: suggested.map((a) => a.split('!')[1]) }, data: { patch: { insertPolicy: 'copy' } },
  }]);
  assert.equal(plan.status, 'ready', JSON.stringify(plan));
  applyCellBatch(p, plan.planId);
  const after = diagnoseFillRowIntegrity(p);
  assert.equal(after.totals.missingInsertPolicyCopy, 0);
  assert.match(after.summary, /通过/);
  assert.equal(after.sheets[0].partialRowCount, 0);
  assert.equal(validateCpt(p).filter((i) => /填报行完整性/.test(i.message) && i.severity === 'warning').length, 0, '按建议清单修复后不应残留 warning');
  assert.equal(cellFillProfile({ widgetClass: 'com.fr.form.ui.ComboBox' }).needsDict, true);
  // 悬空扩展父格：left 指向不存在的格 → 报出（validate 里是 error）
  const q = file('ip-expand.cpt');
  makeFillSheet(q);
  fs.writeFileSync(q, fs.readFileSync(q, 'utf8').replace('<Expand/>', '<Expand left="Z9"/>'), 'utf8');
  const d = diagnoseFillRowIntegrity(q);
  assert.equal(d.totals.danglingExpandParent, 1);
  assert.match(d.sheets[0].missing.expandParent[0].problems[0].problem, /Z9/);
});

test('create_cpt 生成合法骨架', () => {
  const p = file('t1.cpt');
  const r = createCpt(p, { title: '测试模板', rows: 5, columns: 8, webWrite: true });
  assert.equal(r.styleList, 1);
  const ov = overview(p);
  assert.equal(ov.datasets, 0);
  assert.equal(ov.cellCount, 0);
  assert.ok(errorsOf(p).length === 0, `骨架不应有 error: ${errorsOf(p)}`);
  // 骨架（自闭合 <PaperSetting/>）不应误报 warning
  const warnings = validateCpt(p).filter((i) => i.severity === 'warning').map((i) => i.message);
  assert.equal(warnings.length, 0, `骨架不应有 warning: ${warnings.join('; ')}`);
  // 根结构存在
  const { parsed } = load(p);
  assert.ok(parsed.WorkBook?.TableDataMap);
  assert.ok(parsed.WorkBook?.Report?.CellElementList);
  assert.ok(parsed.WorkBook?.StyleList?.Style);
  assert.ok(parsed.WorkBook?.ReportWebAttr);
});

test('add_dataset 添加 SQL 数据集（含参数）', () => {
  const p = file('t1.cpt');
  const r = addDataset(p, {
    name: 'ds1', connection: 'Doris', sql: 'SELECT a, b FROM t WHERE x = \'${p1}\'',
    parameters: [{ name: 'p1', defaultValue: '默认值' }],
  });
  assert.equal(r.name, 'ds1');
  const ds = datasets(p);
  assert.equal(ds.length, 1);
  assert.equal(ds[0].name, 'ds1');
  assert.equal(ds[0].connection, 'Doris');
  assert.equal(ds[0].sql.trim(), "SELECT a, b FROM t WHERE x = '${p1}'");
  assert.equal(ds[0].parameters[0].name, 'p1');
  assert.equal(ds[0].parameters[0].defaultValue, '默认值');
  // 重复添加应报错（缺 connection 也会先报错；这里同时传齐字段以断言"已存在"）
  assert.throws(() => addDataset(p, { name: 'ds1', connection: 'Doris', sql: 'x' }), /已存在/);
  assert.ok(errorsOf(p).length === 0, errorsOf(p).join(';'));
});

test('add_parameter 复用现有工具，格式与真实样本一致', () => {
  const p = file('t1.cpt');
  addParameter(p, 'p2', 'v2');
  const params = parameters(p);
  assert.ok(params.some((x) => x.name === 'p2' && x.defaultValue === 'v2'));
});

test('add_style 追加样式并返回索引', () => {
  const p = file('t1.cpt');
  const r1 = addStyle(p, { fontName: '微软雅黑', fontSizePt: 12, bold: true, backgroundColor: '#FF9900', foregroundColor: '#0000FF' });
  assert.equal(r1.styleIndex, 1);
  const r2 = addStyle(p, { fontSizePt: 9 });
  assert.equal(r2.styleIndex, 2);
  assert.equal(load(p).parsed.WorkBook.StyleList.Style.length, 3);
});

test('add_cell 文本/DSColumn/控件单元格', () => {
  const p = file('t1.cpt');
  addCell(p, { column: 0, row: 0, content: '申请人', styleIndex: 1 });
  addCell(p, { column: 1, row: 0, content: '=TODAY()', contentType: 'formula', styleIndex: 1 });
  addCell(p, { column: 2, row: 0, contentType: 'dsColumn', dsName: 'ds1', columnName: 'a', styleIndex: 1 });
  addCell(p, { column: 3, row: 0, widget: 'text', styleIndex: 2 });
  addCell(p, { column: 4, row: 0, widget: 'date', styleIndex: 2 });
  addCell(p, { column: 5, row: 0, widget: 'submit', styleIndex: 2 });
  const cs = cells(p);
  assert.equal(cs.length, 6);
  assert.equal(cs[0].column, 0); assert.equal(cs[0].row, 0);
  const dsCell = cs.find((c) => c.column === 2);
  assert.equal(dsCell.widgetClass, null);
  assert.ok(load(p).raw.includes('<O t="DSColumn">'));
  const wCells = cs.filter((c) => c.widgetClass);
  assert.equal(wCells.length, 3);
  assert.ok(errorsOf(p).length === 0, errorsOf(p).join(';'));
});

test('add_fill_submit + add_fill_binding 填报链路', () => {
  const p = file('t1.cpt');
  // 先创建绑定指向的单元格（校验要求绑定坐标必须存在）
  addCell(p, { column: 0, row: 1, widget: 'text', styleIndex: 2 });
  addCell(p, { column: 3, row: 1, widget: 'text', styleIndex: 2 });
  const r = addFillSubmit(p, {
    dsName: 'Doris', table: '业务表', bindings: [
      { field: 'applicant', column: 0, row: 1, isKey: false },
    ],
  });
  assert.equal(r.submitIndex, 0);
  // 追加绑定
  addFillBinding(p, 0, 'sku_id', 3, 1, true);
  const fc = fillConfig(p);
  assert.equal(fc.submits.length, 1);
  assert.equal(fc.submits[0].table, '业务表');
  assert.equal(fc.submits[0].dsName, 'Doris');
  assert.equal(fc.submits[0].columns.length, 2);
  const key = fc.submits[0].columns.find((c) => c.field === 'sku_id');
  assert.equal(key.isKey, true);
  assert.equal(key.column, 3); assert.equal(key.row, 1);
  assert.ok(errorsOf(p).length === 0, errorsOf(p).join(';'));
});

test('add_fill_submit 自由 SQL 模式（FreeSQLSubmiter）：sql 互斥、DBName+SQL 结构', () => {
  const p = file('t-freesql.cpt');
  createCpt(p, {});
  // 自由 SQL 提交（删除/条件更新用）
  const r = addFillSubmit(p, { dbName: '填报-读写', sql: 'UPDATE t SET is_delete=1 WHERE id=${id}', name: '删除-软删SQL' });
  assert.equal(r.action, 'add_fill_submit');
  assert.equal(r.mode, 'free-sql');
  assert.equal(r.submitIndex, 0);
  const raw = fs.readFileSync(p, 'utf8');
  assert.ok(raw.includes('com.fr.report.write.FreeSQLSubmiter'), 'FreeSQLSubmiter class');
  assert.ok(raw.includes('<DBName>') && raw.includes('填报-读写'), 'DBName');
  assert.ok(raw.includes('<SQL>') && raw.includes('UPDATE t SET is_delete=1 WHERE id=${id}'), 'SQL 原文');
  assert.ok(!raw.includes('DMLConfig'), '自由 SQL 模式不含 DMLConfig');
  // 互斥：sql + table/bindings
  assert.throws(() => addFillSubmit(p, { dsName: 'x', table: 't', sql: 'UPDATE ...' }), /互斥/);
  assert.throws(() => addFillSubmit(p, { sql: 'UPDATE ...', bindings: [{ field: 'a', column: 0, row: 0 }] }), /互斥/);
  // 无 sql 无 table → 报错
  assert.throws(() => addFillSubmit(p, { dbName: 'x' }), /table|sql|互斥/);
  assert.ok(errorsOf(p).length === 0, errorsOf(p).join(';'));
});

test('set_report_settings 纸张/边距（单位换算）', () => {
  const p = file('t1.cpt');
  const r = setReportSettings(p, { paper: 'A3', orientation: 1, marginTopMm: 10 });
  assert.equal(r.paper, 'A3');
  const raw = load(p).raw;
  assert.ok(raw.includes('<PaperSetting orientation="1">'));
  assert.ok(raw.includes('<PaperSize width="42768000" height="60480000"/>')); // A3 297×420mm
  assert.ok(raw.includes('top="1440000"')); // 10mm
  assert.ok(errorsOf(p).length === 0, errorsOf(p).join(';'));
});

test('set_parameter_panel 参数面板', () => {
  const p = file('t1.cpt');
  setParameterPanel(p, { title: '筛选条件', showWindow: true });
  const raw = load(p).raw;
  assert.ok(raw.includes('<ReportParameterAttr>'));
  assert.ok(raw.includes('<![CDATA[筛选条件]]>'));
  // 重复调用应整块替换而非重复插入
  setParameterPanel(p, { title: '新标题' });
  assert.equal((raw.match(/<ReportParameterAttr>/g) || []).length, 1);
  assert.ok(load(p).raw.includes('<![CDATA[新标题]]>'));
  assert.ok(errorsOf(p).length === 0, errorsOf(p).join(';'));
});

test('set_grid 行高/列宽', () => {
  const p = file('t1.cpt');
  const r = setGrid(p, { rowCount: 6, columnWidths: [1000, 2000, 3000] });
  assert.equal(r.rowHeights, '723900,723900,723900,723900,723900,723900');
  assert.equal(r.columnWidths, '1000,2000,3000');
  assert.ok(errorsOf(p).length === 0, errorsOf(p).join(';'));
});

test('update_cell_style 对新生成样式生效（共享提示）', () => {
  const p = file('t1.cpt');
  const before = getCellStyle(p, 0, 0);
  assert.equal(before.backgroundColor, '#FF9900'); // add_style 创建的样式1：背景 #FF9900
  const r = updateCellStyle(p, 0, 0, { backgroundColor: '#112233', bold: true, fontSizePt: 14 });
  assert.equal(r.sharedCells >= 1, true);
  const after = getCellStyle(p, 0, 0);
  assert.equal(after.backgroundColor, '#112233');
  assert.equal(after.bold, true);
  assert.equal(after.fontSizePt, 14);
});

test('全链路最终模板可被 validate 通过且无 error', () => {
  const p = file('t1.cpt');
  const issues = validateCpt(p);
  const summary = issueSummary(issues);
  assert.equal(summary.error, 0, `最终模板不应有 error: ${issues.filter((i) => i.severity === 'error').map((i) => i.message).join('; ')}`);
  // 参数引用一致性：SQL 引用的 ${p1} 已定义
  const ds = datasets(p);
  const sql = ds[0].sql;
  assert.ok(sql.includes('${p1}'));
});

test('属性形式样式读写兼容（Demo.cpt 副本：foreground 属性 + Background 属性）', (t) => {
  const src = 'D:/FineReport_11.0/webapps/webroot/WEB-INF/reportlets/demo/analytics/Demo.cpt';
  if (!fs.existsSync(src)) { t.skip('官方样本不存在'); return; }
  const p = file('demo_copy.cpt');
  fs.copyFileSync(src, p);
  // Demo.cpt 有 <C c="0" r="9" cs="4" s="0">，样式0 为 <FRFont ... foreground="-4144960"/> 属性形式
  const before = getCellStyle(p, 0, 9);
  assert.equal(before.foregroundColor, '#C0C0C0'); // -4144960 → #C0C0C0
  assert.equal(before.fontSizePt, 18); // size=72 → 18pt
  // 写入前景色：应更新 foreground 属性而非新增子元素
  const changed = updateCellStyle(p, 0, 9, { foregroundColor: '#FF0000' });
  const raw = load(p).raw;
  const block = styleBlocks(raw).blocks[changed.styleIndex];
  const targetStyle = raw.slice(block.start, block.end);
  assert.ok(targetStyle.includes('foreground="-65536"'), `foreground 属性应更新为 -65536: ${targetStyle}`);
  assert.ok(!targetStyle.includes('<foreground>'), '不应产生重复的 <foreground> 子元素');
  assert.equal(getCellStyle(p, 0, 9).styleIndex, changed.styleIndex, '目标单元格应重新绑定到克隆样式');
  assert.equal(getCellStyle(p, 0, 9).foregroundColor, '#FF0000');
});

test('真实样本回归：现有读/校验能力不破坏官方模板', (t) => {
  const real = 'D:/FineReport_11.0/webapps/webroot/WEB-INF/reportlets/demo/analytics/Demo.cpt';
  if (!fs.existsSync(real)) { t.skip('官方样本不存在'); return; }
  // 读取不应抛错
  const ds = datasets(real);
  assert.ok(ds.length >= 2);
  const cs = cells(real);
  assert.ok(cs.length > 0);
  const fc = fillConfig(real);
  assert.ok(Array.isArray(fc.submits));
  // 校验不应抛错
  validateCpt(real);
});

test('真实填报样本回归：sample-fill.cpt', (t) => {
  const real = process.env.CPT_MCP_FILL_SAMPLE
    ?? path.join(os.homedir(), 'Desktop', 'sandbox4', 'sample-fill.cpt');
  if (!fs.existsSync(real)) { t.skip('填报样本不存在'); return; }
  const fc = fillConfig(real);
  assert.ok(fc.submits.length >= 1);
  assert.equal(fc.submits[0].columns.length > 20, true);
  const cs = cells(real);
  const widgets = cs.filter((c) => c.widgetClass);
  assert.ok(widgets.length >= 30);
});

test('回归：replaceAttr 真正替换属性值（修复前是插入导致 name="新旧"并存）', async () => {
  const { replaceAttr } = await import('../lib/xml.js');
  const raw = '<ColumnConfig name="old_name" isKey="false"/>';
  const out = replaceAttr(raw, 0, raw.length, 'name', 'new_name', '测试');
  assert.equal(out, '<ColumnConfig name="new_name" isKey="false"/>');
  // 值变长/变短都正确
  const out2 = replaceAttr(out, 0, out.length, 'isKey', 'true', '测试');
  assert.equal(out2, '<ColumnConfig name="new_name" isKey="true"/>');
});

// ---------------- 审查补充用例（blocking bug 回归 + 覆盖缺口） ----------------

test('回归：update_fill_binding 改名（newField）不再抛错', () => {
  const p = file('t2.cpt');
  createCpt(p, {});
  addCell(p, { column: 0, row: 1, widget: 'text' });
  addFillSubmit(p, { dsName: 'Doris', table: 't', bindings: [{ field: 'old_name', column: 0, row: 1 }] });
  // 之前：改名后仍用旧名重定位 → 必抛「定位失败」
  const r = updateFillBinding(p, 0, 'old_name', { newField: 'new_name' });
  assert.equal(r.action, 'update_fill_binding');
  const fc = fillConfig(p);
  assert.equal(fc.submits[0].columns[0].field, 'new_name');
});

test('回归：update_fill_binding 改常量值（ColumnRow → <O>值</O>，根治 is_delete 依赖单元格）', () => {
  const p = file('t-const.cpt');
  createCpt(p, {});
  addCell(p, { column: 24, row: 1, widget: 'text' });
  addFillSubmit(p, { dsName: 'Doris', table: 't', bindings: [{ field: 'is_delete', column: 24, row: 1 }] });
  // 改前应是 ColumnRow
  let fc = fillConfig(p);
  assert.equal(fc.submits[0].columns[0].field, 'is_delete');
  const before = fs.readFileSync(p, 'utf8');
  assert.ok(before.includes('<ColumnRow column="24" row="1"/>'), '改前为单元格坐标绑定');
  // 常量 0
  const r = updateFillBinding(p, 0, 'is_delete', { constant: 0 });
  assert.equal(r.action, 'update_fill_binding');
  assert.equal(r.mode, 'constant');
  assert.equal(r.constant, '0');
  const after = fs.readFileSync(p, 'utf8');
  assert.ok(after.includes('<O>'), '已改为常量绑定');
  assert.ok(!after.includes('<ColumnRow column="24"'), '不再依赖单元格');
  assert.ok(after.includes('<![CDATA[0]]>'), '常量值为 0');
  // 互斥：constant + column 报错
  assert.throws(() => updateFillBinding(p, 0, 'is_delete', { constant: 1, column: 24 }), /互斥|常量值绑定/);
});

test('回归：前景色二次更新不再静默失效（属性+子元素不并存）', () => {
  const p = file('t3.cpt');
  createCpt(p, {});
  addCell(p, { column: 0, row: 0, content: 'x', styleIndex: 0 });
  // 骨架样式0 为自闭合无属性 FRFont
  updateCellStyle(p, 0, 0, { foregroundColor: '#FF0000' });
  assert.equal(getCellStyle(p, 0, 0).foregroundColor, '#FF0000');
  // 二次改色：必须真正生效
  updateCellStyle(p, 0, 0, { foregroundColor: '#00FF00' });
  assert.equal(getCellStyle(p, 0, 0).foregroundColor, '#00FF00');
  // XML 不应同时存在 foreground 属性与 <foreground> 子元素
  const raw = load(p).raw;
  const styleSeg = raw.slice(raw.indexOf('<Style '), raw.indexOf('</Style>'));
  const hasAttr = /foreground="[^"]+"/.test(styleSeg);
  const hasChild = /<foreground>/.test(styleSeg);
  assert.ok(!(hasAttr && hasChild), `属性与子元素不应并存: ${styleSeg}`);
});

test('update_parameter 改默认值/改名', () => {
  const p = file('t4.cpt');
  createCpt(p, {});
  addDataset(p, { name: 'ds1', connection: 'Doris', sql: 'SELECT 1', parameters: [{ name: 'p1', defaultValue: 'a' }] });
  updateParameter(p, 'p1', 'b');
  updateParameter(p, 'p1', undefined, 'p2');
  const ps = parameters(p);
  assert.ok(ps.some((x) => x.name === 'p2' && x.defaultValue === 'b'));
});

test('delete_parameter / delete_cell / delete_fill_binding', () => {
  const p = file('t5.cpt');
  createCpt(p, {});
  addDataset(p, { name: 'ds1', connection: 'Doris', sql: 'SELECT 1', parameters: [{ name: 'p1' }, { name: 'p2' }] });
  addCell(p, { column: 0, row: 0, content: 'a' });
  addCell(p, { column: 0, row: 1, widget: 'text' });
  addFillSubmit(p, { dsName: 'Doris', table: 't', bindings: [{ field: 'f1', column: 0, row: 1 }] });
  deleteParameter(p, 'p1');
  assert.ok(!parameters(p).some((x) => x.name === 'p1'));
  deleteCell(p, 0, 0);
  assert.ok(!cells(p).some((c) => c.column === 0 && c.row === 0));
  deleteFillBinding(p, 0, 'f1');
  assert.equal(fillConfig(p).submits[0].columns.length, 0);
});

test('update_cell：tooltip 与 content（<O> 节点兼容）', () => {
  const p = file('t6.cpt');
  createCpt(p, {});
  addCell(p, { column: 0, row: 0, content: '原文' });
  // M82: 格内无 ToolTipText → 自动补建官方 CellGUIAttr/ToolTipText（设计器 =$$$ 形态），不再抛错
  const rt = updateCellTooltip(p, 0, 0, '=$$$');
  assert.equal(rt.mode, 'insert');
  const rawTip = fs.readFileSync(p, 'utf8');
  assert.ok(rawTip.includes('<CellGUIAttr adjustmode="0" customTooltip="false">'), '补建官方 CellGUIAttr 形态');
  assert.ok(rawTip.includes('<![CDATA[=$$$]]>'), '=$$$ 公式原文写入');
  assert.equal(cells(p).find((c) => c.column === 0 && c.row === 0).tooltip, '=$$$');
  // 已有再改 → update
  assert.equal(updateCellTooltip(p, 0, 0, '新提示').mode, 'update');
  assert.equal(cells(p).find((c) => c.column === 0 && c.row === 0).tooltip, '新提示');
  // content：生成模板内容在 <O> 节点，updateCellContent 应兼容
  const r = updateCellContent(p, 0, 0, '新文本');
  assert.equal(r.action, 'update_cell_content');
  const cs = cells(p);
  assert.equal(cs.find((c) => c.column === 0 && c.row === 0).contentText, '新文本');
});

test('生成模板单元格 contentText/contentKind 可读（<O> 兼容）', () => {
  const p = file('t7.cpt');
  createCpt(p, {});
  addDataset(p, { name: 'ds1', connection: 'Doris', sql: 'SELECT 1' });
  addCell(p, { column: 0, row: 0, content: '文本' });
  addCell(p, { column: 1, row: 0, contentType: 'dsColumn', dsName: 'ds1', columnName: 'a' });
  const cs = cells(p);
  const txt = cs.find((c) => c.column === 0);
  assert.equal(txt.contentKind, 'text');
  assert.equal(txt.contentText, '文本');
  const ds = cs.find((c) => c.column === 1);
  assert.equal(ds.contentKind, 'object:DSColumn');
  assert.equal(ds.contentObjectType, 'DSColumn');
});

// ---------------- M72 闭环：写后读回 ----------------

test('M72 闭环：控件格改数据绑定后 get_cells 可读回；监听器/主题/JS/工具栏可读回', () => {
  const p = file('t72.cpt');
  createCpt(p, { rows: 5, columns: 8, webWrite: true });
  addDataset(p, { name: 'ds1', connection: 'Doris', sql: 'SELECT a FROM t' });
  addStyle(p, { fontSizePt: 12 });
  addCell(p, { column: 0, row: 1, widget: 'text' });
  addCell(p, { column: 1, row: 1, content: 'x' });
  // ① set_cell_content_type 改控件格为 DSColumn → cells() 必须读回（修复前 contentObjectType=null）
  const ct = setCellContentType(p, { column: 0, row: 1, contentType: 'dsColumn', dsName: 'ds1', columnName: 'a' });
  // M106：控件格无单元格级 <O>，绑定插在 <PrivilegeControl/> 之前（此前误走 replace 写进 widgetValue）
  assert.equal(ct.mode, 'insert');
  const c01 = cells(p).find((c) => c.column === 0 && c.row === 1);
  assert.equal(c01.contentObjectType, 'DSColumn', '单元格级 <O t="DSColumn"> 应被读回');
  assert.equal(c01.contentKind, 'object:DSColumn');
  // ② 单元格监听器 → cells() 读回正文
  setCellListener(p, 1, 1, { event: 'click', js: "alert('m72')" });
  const c11 = cells(p).find((c) => c.column === 1 && c.row === 1);
  assert.ok(Array.isArray(c11.listeners) && c11.listeners.some((l) => l.event === 'click' && l.js.includes('m72')),
    `listeners 应含 event+js: ${JSON.stringify(c11.listeners)}`);
  // ③ 主题 + TopJS + WebJS + 工具栏 → overview 概览读回（写后不再是黑盒）
  setTemplateTheme(p, '经典浅灰');
  setReportJs(p, { js: '// topjs' });
  setWebWriteJs(p, { event: 'writesuccess', js: '// webjs' });
  setFillToolbar(p, { buttons: ['submit'] });
  const ov = overview(p);
  assert.equal(ov.theme, '经典浅灰');
  const blk = ov.jsBlocks[0];
  assert.equal(blk.topJs, true, 'TopJS 存在性应读回');
  assert.ok(blk.webwriteListeners >= 1, `webwriteListeners=${blk.webwriteListeners}`);
  assert.ok(blk.toolbarButtons >= 1, `toolbarButtons=${blk.toolbarButtons}`);
  assert.ok(blk.cellListeners >= 1, `cellListeners=${blk.cellListeners}`);
});

// ---------------- 第二轮审查补充用例 ----------------

test('回归：set_report_settings 多属性连续 upsert（骨架无居中属性）不抛错', () => {
  const p = file('t8.cpt');
  createCpt(p, {});
  // 修复前：第二次 upsert 用过期 tagEnd → 抛「开标签未闭合」
  const r = setReportSettings(p, {
    paper: 'A4', orientation: 0,
    isHorizontalCenterOnPage: true, isVerticalCenterOnPage: true, shrinkToFitMode: 1,
  });
  assert.equal(r.action, 'set_report_settings');
  const raw = load(p).raw;
  assert.ok(raw.includes('isHorizontalCenterOnPage="true"'));
  assert.ok(raw.includes('isVerticalCenterOnPage="true"'));
  assert.ok(raw.includes('shrinkToFitMode="1"'));
  // 第二次调用（属性已存在，走替换路径）也应正常
  setReportSettings(p, { isHorizontalCenterOnPage: false });
  assert.ok(load(p).raw.includes('isHorizontalCenterOnPage="false"'));
});

test('回归：set_grid 无参数不改 defaultValue（不静默改模板）', () => {
  const p = file('t9.cpt');
  createCpt(p, {});
  // 手工把 defaultValue 改为非默认值
  let raw0 = load(p).raw;
  raw0 = raw0.replace('<RowHeight defaultValue="723900">', '<RowHeight defaultValue="500000">');
  raw0 = raw0.replace('<ColumnWidth defaultValue="2743200">', '<ColumnWidth defaultValue="999999">');
  fs.writeFileSync(p, raw0, 'utf8');
  // 不传任何参数调用
  setGrid(p, {});
  const raw = load(p).raw;
  assert.ok(raw.includes('<RowHeight defaultValue="500000">'), 'defaultValue 不应被改写');
  assert.ok(raw.includes('<ColumnWidth defaultValue="999999">'));
  // 传参数时正常更新
  setGrid(p, { rowCount: 2 });
  assert.ok(load(p).raw.includes('<RowHeight defaultValue="723900">'));
});

test('回归：cells() 读取 <O>纯文本（非 CDATA）不误判 empty', () => {
  const p = file('t10.cpt');
  createCpt(p, {});
  // 手工构造 <O>纯文本</O>（无 CDATA）单元格
  const { raw } = load(p);
  const cell = '<C c="0" r="0" s="0">\n<O>纯文本</O>\n<PrivilegeControl/>\n<CellGUIAttr adjustmode="0"/>\n<CellPageAttr/>\n<Expand extendable="3">\n<cellSortAttr>\n<sortExpressions/>\n<sortHeader sortArea="A1"/>\n</cellSortAttr>\n</Expand>\n</C>\n';
  const out = raw.replace('</CellElementList>', cell + '</CellElementList>');
  fs.writeFileSync(p, out, 'utf8');
  const cs = cells(p);
  const c = cs.find((x) => x.column === 0 && x.row === 0);
  assert.equal(c.contentKind, 'text');
  assert.equal(c.contentText, '纯文本');
});

test('回归：update_fill_binding 改名含 XML 特殊字符（& < >）', () => {
  const p = file('t11.cpt');
  createCpt(p, {});
  addCell(p, { column: 0, row: 1, widget: 'text' });
  addFillSubmit(p, { dsName: 'Doris', table: 't', bindings: [{ field: 'a&b', column: 0, row: 1 }] });
  // 字段名含 &：XML 中存储为 a&amp;b，匹配需转义
  const r = updateFillBinding(p, 0, 'a&b', { newField: 'c<d' });
  assert.equal(r.action, 'update_fill_binding');
  const fc = fillConfig(p);
  assert.equal(fc.submits[0].columns[0].field, 'c<d');
});

test('回归：前景色「属性+子元素并存」脏数据改色同步生效', () => {
  const p = file('t12.cpt');
  createCpt(p, {});
  addCell(p, { column: 0, row: 0, content: 'x', styleIndex: 0 });
  // 构造脏数据：属性 + 子元素并存（修复前只改属性，读取（子元素优先）仍旧值）
  let raw0 = load(p).raw;
  raw0 = raw0.replace(
    '<FRFont name="微软雅黑" style="0" size="72"/>',
    '<FRFont name="微软雅黑" style="0" size="72" foreground="-65536">\n<foreground>\n<FineColor color="-65536" hor="-1" ver="-1"/>\n</foreground>\n</FRFont>'
  );
  fs.writeFileSync(p, raw0, 'utf8');
  updateCellStyle(p, 0, 0, { foregroundColor: '#00FF00' });
  assert.equal(getCellStyle(p, 0, 0).foregroundColor, '#00FF00');
});

// ---------------- 第三轮审查补充用例 ----------------

test('回归：add_dataset 连接名含 & 不双重转义（CDATA 字面量）', () => {
  const p = file('t13.cpt');
  createCpt(p, {});
  addDataset(p, {
    name: 'ds1', connection: 'jdbc:mysql://h/db?useSSL=false&a=1', sql: 'SELECT 1',
  });
  const ds = datasets(p);
  assert.equal(ds[0].connection, 'jdbc:mysql://h/db?useSSL=false&a=1');
  assert.ok(load(p).raw.includes('useSSL=false&a=1'), 'CDATA 中 & 不应转义为 &amp;');
});

test('回归：set_report_settings 匹配自闭合 <ReportSettings/>（无属性形态）', () => {
  const p = file('t14.cpt');
  createCpt(p, {});
  // 手工把整个 ReportSettings 块（含子节点）替换为无属性自闭合形态
  let raw0 = load(p).raw;
  raw0 = raw0.replace(/<ReportSettings[\s\S]*?<\/ReportSettings>/, '<ReportSettings/>');
  fs.writeFileSync(p, raw0, 'utf8');
  assert.ok(load(p).raw.includes('<ReportSettings/>'), '前置条件：已是自闭合形态');
  const r = setReportSettings(p, { isHorizontalCenterOnPage: true, shrinkToFitMode: 2 });
  assert.equal(r.action, 'set_report_settings');
  const raw = load(p).raw;
  assert.ok(raw.includes('isHorizontalCenterOnPage="true"'), '自闭合 ReportSettings 应能插入属性');
  assert.ok(raw.includes('shrinkToFitMode="2"'));
});

// ---------------- 第四轮审查补充用例 ----------------

test('回归：自闭合带属性 <ReportSettings shrinkToFitMode="0"/> 展开保留属性', () => {
  const p = file('t15.cpt');
  createCpt(p, {});
  // 构造自闭合但带属性的 ReportSettings（含子节点块替换）
  let raw0 = load(p).raw;
  raw0 = raw0.replace(/<ReportSettings[\s\S]*?<\/ReportSettings>/, '<ReportSettings shrinkToFitMode="0"/>');
  fs.writeFileSync(p, raw0, 'utf8');
  const r = setReportSettings(p, { paper: 'A4', isHorizontalCenterOnPage: true });
  assert.equal(r.action, 'set_report_settings');
  const raw = load(p).raw;
  assert.ok(raw.includes('shrinkToFitMode="0"'), '展开后应保留原 shrinkToFitMode 属性');
  assert.ok(raw.includes('isHorizontalCenterOnPage="true"'), '应能插入新属性');
});

test('回归：set_grid 传数组时保持原 defaultValue（不改为常量）', () => {
  const p = file('t16.cpt');
  createCpt(p, {});
  let raw0 = load(p).raw;
  raw0 = raw0.replace('<RowHeight defaultValue="723900">', '<RowHeight defaultValue="500000">');
  fs.writeFileSync(p, raw0, 'utf8');
  setGrid(p, { rowHeights: [1000, 2000] });
  const raw = load(p).raw;
  assert.ok(raw.includes('<RowHeight defaultValue="500000">'), '数组时 defaultValue 应保持原值 500000');
  assert.ok(raw.includes('<![CDATA[1000,2000]]>'), 'CDATA 应更新为数组值');
  // count 平铺时 defaultValue 更新为平铺值
  setGrid(p, { rowCount: 3 });
  assert.ok(load(p).raw.includes('<RowHeight defaultValue="723900">'));
});

test('回归：val() 对 #text 形态反转义实体（<Name>a &amp; b</Name>）', async () => {
  // 通过 fillConfig 的 Name 节点验证：构造非 CDATA 的 <Name>a &amp; b</Name>
  const p = file('t17.cpt');
  createCpt(p, {});
  addCell(p, { column: 0, row: 1, widget: 'text' });
  addFillSubmit(p, { dsName: 'Doris', table: 't', bindings: [{ field: 'f1', column: 0, row: 1 }] });
  let raw0 = load(p).raw;
  raw0 = raw0.replace('<![CDATA[内置SQL1]]></Name>', 'a &amp; b</Name>');
  fs.writeFileSync(p, raw0, 'utf8');
  const fc = fillConfig(p);
  assert.ok(fc.submits[0].name.includes('a & b'), `Name 应反转义实体: ${fc.submits[0].name}`);
});

test('回归：MCP path 参数拒绝非 .cpt 路径', async () => {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'server.js')], cwd: path.join(path.dirname(fileURLToPath(import.meta.url)), '..') });
  const client = new Client({ name: 'cpt-mcp-test', version: '0.0.1' });
  await client.connect(transport);
  const r = await client.callTool({ name: 'read_cpt', arguments: { path: file('not_cpt.txt') } });
  assert.equal(r.isError, true, '非 .cpt 路径应被 zod 拒绝');
  await client.close();
});

// ---------------- 指南升级（路线D 参数面板控件 + 控件补全 + 版本调优）用例 ----------------

test('add_parameter_widget：下拉/文本框/查询按钮 + 同名 Parameter 绑定', () => {
  const p = file('t18.cpt');
  createCpt(p, {});
  // 下拉（数据库字典）
  addParameterWidget(p, {
    name: '产品类型', type: 'comboBox', label: '产品类型：',
    dictionary: { type: 'db', table: '销量', kiName: '产品类型', viName: '产品类型', connection: 'FRDemo' },
    x: 100, y: 20, width: 120, height: 24,
  });
  // 文本框
  addParameterWidget(p, { name: '销售员', type: 'text', x: 230, y: 20, width: 80, height: 24 });
  // 查询按钮
  addParameterWidget(p, { name: 'Search', type: 'submitButton', text: '查询', x: 320, y: 20, width: 60, height: 24 });
  const raw = load(p).raw;
  assert.ok(raw.includes('<ParameterUI class="com.fr.form.main.parameter.FormParameterUI">'), '应生成 ParameterUI');
  assert.ok(raw.includes('WAbsoluteLayout$BoundsWidget'), '控件用 BoundsWidget 包裹');
  assert.ok(raw.includes('com.fr.form.ui.ComboBox'), '下拉控件');
  assert.ok(raw.includes('com.fr.form.parameter.FormSubmitButton'), '查询按钮');
  assert.ok(raw.includes('com.fr.data.impl.DatabaseDictionary'), '数据库字典');
  // 2026-10-29：label 生成独立的可见 Label 控件（lbl_产品类型，设计器同款），控件右移给标签让位
  // （此前只写 <LabelName>，Web 参数面板不渲染 → 筛选控件「缺少标签」的根因）
  assert.ok(raw.includes('<LabelName name="产品类型："/>'), '控件 LabelName（设计器显示名）');
  assert.ok(/<WidgetName name="lbl_产品类型"\/>/.test(raw), '配套可见标签控件 lbl_产品类型');
  assert.ok(raw.includes('<BoundsAttr x="119" y="20" width="120" height="24"/>'), '控件 BoundsAttr（标签占位后右移）');
  // 同名 Parameter 绑定
  const panel = parameterPanel(p);
  assert.equal(panel.title, '参数');
  assert.equal(panel.widgets.length, 4, '3 个控件 + 1 个配套标签');
  assert.ok(panel.widgets.some((w) => w.name === '产品类型' && w.class === 'com.fr.form.ui.ComboBox'));
  assert.ok(panel.parameters.some((q) => q.name === '产品类型'));
  assert.ok(panel.parameters.some((q) => q.name === '销售员'));
  // 不重复添加同名 Parameter
  // M117：同名控件默认拒绝追加（静默产生两个同名控件是危险默认），刻意并存须显式 allowDuplicate=true
  assert.throws(() => addParameterWidget(p, { name: '产品类型', type: 'text' }), /已存在同名控件/);
  addParameterWidget(p, { name: '产品类型', type: 'text', allowDuplicate: true });
  assert.equal(load(p).raw.match(/<Attributes name="产品类型"\/>/g).length, 1, '同名参数不重复');
  // 显式 allowDuplicate=true 时才追加第二个控件（参数仍同名绑定）
  assert.equal(parameterPanel(p).widgets.length, 5, '追加控件后 3 控件 + 1 标签 + 1 重复控件');
});

test('add_cell 新控件类型：comboCheckBox/label/custom（插件按钮）', () => {
  const p = file('t19.cpt');
  createCpt(p, {});
  addCell(p, { column: 0, row: 0, widget: 'comboCheckBox', widgetItems: [{ key: 'a', value: 'A' }] });
  addCell(p, { column: 1, row: 0, widget: 'label', content: '备注：' });
  addCell(p, {
    column: 2, row: 0, widget: 'custom',
    widgetClass: 'com.fr.plugin.excel.ui.ExcelImportButton',
    pluginID: 'com.fr.plugin.mark.excel.import.v11', pluginVersion: '1.9.3',
  });
  const raw = load(p).raw;
  assert.ok(raw.includes('class="com.fr.form.ui.ComboCheckBox"'), 'comboCheckBox 控件');
  assert.ok(raw.includes('<RAAttr delimiter="&apos;,&apos;" isArray="false"/>'), 'RAAttr 多值属性');
  assert.ok(raw.includes('class="com.fr.form.ui.Label"'), 'label 控件');
  assert.ok(raw.includes('<![CDATA[备注：]]></O>'), 'label 文本');
  assert.ok(raw.includes('com.fr.plugin.excel.ui.ExcelImportButton'), '自定义控件 class');
  assert.ok(raw.includes('pluginID="com.fr.plugin.mark.excel.import.v11"'), 'pluginID 透传');
  assert.ok(raw.includes('plugin-version="1.9.3"'), 'plugin-version 透传');
  const cs = cells(p);
  assert.equal(cs.length, 3);
  assert.equal(cs[0].widgetClass, 'com.fr.form.ui.ComboCheckBox');
});

test('create_cpt 默认版本为 11.5.0（20211223）且 DesignerVersion=LAA', () => {
  const p = file('t20.cpt');
  createCpt(p, {});
  const ov = overview(p);
  assert.equal(ov.releaseVersion, '11.5.0');
  assert.equal(ov.xmlVersion, '20211223');
  assert.ok(load(p).raw.includes('DesignerVersion DesignerVersion="LAA"'));
});

test('set_parameter_panel 已存在时保留 ParameterUI 控件', () => {
  const p = file('t21.cpt');
  createCpt(p, {});
  addParameterWidget(p, { name: 'p1', type: 'text' });
  // 改标题不应清掉控件
  setParameterPanel(p, { title: '新标题' });
  const panel = parameterPanel(p);
  assert.equal(panel.title, '新标题');
  assert.equal(panel.widgets.length, 1, '改标题后控件应保留');
});

test.after(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 忽略 */ }
});

// ---------------- M79 delete_cell_sort ----------------
// 设计器原生形态（sandbox6 防腐调整跟进报表1.cpt 实证）：
// <Expand dir="0"><cellSortAttr><sortExpressions><cellSortExpression sortRule="0" sortArea="A4"/>
// </sortExpressions><sortHeader …/></cellSortAttr></Expand>，同格 O 内带空占位；无规则格为 <Expand/>。
test('M79 delete_cell_sort：只删扩展后排序，控件/条件属性/监听原样保留', () => {
  const p = file('sort1.cpt');
  createCpt(p, { rows: 4, columns: 3 });
  addDataset(p, { name: 'ds1', connection: 'Doris', sql: 'SELECT a,b FROM t' });
  // 注：addCell 建控件格时不生成 <O t="DSColumn">，故先建纯数据格，控件以后缀标准形态注入
  // （与 sandbox6 实证同格“O+Widget”并存一致）
  addCell(p, { column: 0, row: 3, contentType: 'dsColumn', dsName: 'ds1', columnName: 'a' });
  // 挂上需要保的东西：控件 + 条件属性 + 监听
  addCellHighlight(p, { column: 0, row: 3, formula: '$$$<0', fontColor: '#FF0000' });
  setCellListener(p, 0, 3, { event: 'click', js: "c20link('x')" });
  // 注入设计器原生 Expand 规则 + O 空占位
  let raw = fs.readFileSync(p, 'utf8');
  const cellAt = raw.indexOf('<C c="0" r="3"');
  const cellEnd = raw.indexOf('</C>', cellAt);
  let seg = raw.slice(cellAt, cellEnd);
  assert.ok(seg.includes('<Expand dir="0"/>'), '前置：MCP 生成格为自闭合 Expand');
  seg = seg.replace('<Expand dir="0"/>',
    `<Expand dir="0">
<cellSortAttr>
<sortExpressions>
<cellSortExpression sortRule="0" sortArea="A4"/>
</sortExpressions>
<sortHeader sortArea="A4">
<sortItem sortRule="1">
<FineColor color="-14606046" hor="-1" ver="-1"/>
</sortItem>
</sortHeader>
</cellSortAttr>
</Expand>`);
  // 注：Listener 内也有 <Parameters/>，必须锚定 O 内容区（设计器顺序 O>Parameters 在 Listener 之后亦合法，此处仅为占位注入）
  const oAt = seg.indexOf('<O t="DSColumn">');
  assert.ok(oAt >= 0, '前置：数据格有 <O t="DSColumn">');
  const oParam = seg.indexOf('<Parameters/>', oAt);
  assert.ok(oParam >= 0, '前置：O 内有 <Parameters/>');
  seg = seg.slice(0, oParam) + `<Parameters/>
<cellSortAttr>
<sortExpressions/>
</cellSortAttr>` + seg.slice(oParam + '<Parameters/>'.length);
  // 注入标准文本控件（设计器原生“O+Widget”并存形态）
  seg = seg.replace('<Expand dir=', `<Widget class="com.fr.form.ui.TextEditor">
<WidgetAttr aspectRatioLocked="false" aspectRatioBackup="-1.0" description="">
<MobileBookMark useBookMark="false" bookMarkName="" frozen="false" index="-1" oldWidgetName=""/>
<PrivilegeControl/>
</WidgetAttr>
<TextAttr/>
<Reg class="com.fr.form.ui.reg.NoneReg"/>
<widgetValue/>
</Widget>
<Expand dir=`);
  raw = raw.slice(0, cellAt) + seg + raw.slice(cellEnd);
  fs.writeFileSync(p, raw);

  const r = deleteCellSort(p, { column: 0, row: 3 });
  assert.equal(r.action, 'delete_cell_sort');
  assert.equal(r.deleted, 1);
  assert.deepEqual(r.results[0].removed, [{ location: 'expand', sortArea: 'A4', sortRule: '0' }]);
  const after = fs.readFileSync(p, 'utf8');
  const segAfter = after.slice(after.indexOf('<C c="0" r="3"'), after.indexOf('</C>', after.indexOf('<C c="0" r="3"')));
  assert.ok(segAfter.includes('<Expand dir="0"/>'), 'Expand 塌回自闭合（属性保留）');
  assert.ok(!segAfter.includes('cellSort'), '排序规则清零（含 O 空占位）');
  assert.ok(segAfter.includes("c20link('x')"), '监听 JS 原样保留');
  assert.ok(segAfter.includes('HighlightList'), '条件属性原样保留');
  assert.ok(segAfter.includes('<Widget'), '控件原样保留');
  assert.equal(validateCpt(p).filter((i) => i.severity === 'error').length, 0);
});

test('M79 delete_cell_sort：MCP 自写 O 层规则可删 + 批量混合（删/跳过/不存在）', () => {
  const p = file('sort2.cpt');
  createCpt(p, { rows: 4, columns: 4 });
  addDataset(p, { name: 'ds1', connection: 'Doris', sql: 'SELECT a,b FROM t' });
  addCell(p, { column: 0, row: 3, contentType: 'dsColumn', dsName: 'ds1', columnName: 'a', sort: [{ area: 'b', direction: 'asc' }] });
  addCell(p, { column: 1, row: 3, contentType: 'dsColumn', dsName: 'ds1', columnName: 'b' });
  const before = fs.readFileSync(p, 'utf8');
  assert.ok(before.includes('cellSortExpression'), '前置：O 层自写规则存在');
  const r = deleteCellSort(p, { cells: [{ column: 0, row: 3 }, { column: 1, row: 3 }, { column: 9, row: 9 }] });
  assert.equal(r.cellCount, 3);
  assert.equal(r.deleted, 1);
  assert.equal(r.skipped, 2);
  assert.deepEqual(r.results[0].removed, [{ location: 'content', sortArea: 'b', sortRule: '升序' }]);
  assert.equal(r.results[1].mode, 'none');
  assert.ok(r.results[2].note.includes('不存在'), '不存在的格跳过不抛错');
  const after = fs.readFileSync(p, 'utf8');
  assert.ok(!after.includes('cellSortExpression'), 'O 层规则已删');
  assert.ok(after.includes('<Expand dir="0"/>') || !after.includes('<Expand dir="0">'), 'Expand 未被意外改写');
  assert.equal(validateCpt(p).filter((i) => i.severity === 'error').length, 0);
  // 非法输入
  assert.throws(() => deleteCellSort(p, { cells: [] }), /cells 数组/);
  assert.throws(() => deleteCellSort(p, { cells: [{ column: 0, row: 3 }, { column: 0, row: 3 }] }), /重复/);
});

// ============ P1 单独项补齐：13 个「改/删/查」语义工具 ============
// 语义约定：update_* 只改已存在目标（未命中报错不新增）；delete_cell_listener 严格删已存在；
// get_* 只读。全部基于文本锚点原位替换，不追加/不复制/不重建无关结构。

function p1Scaffold(name = 'p1.cpt') {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-p1-'));
  const p = path.join(d, name);
  createCpt(p, { title: 'T', rows: 20, columns: 8, webWrite: true });
  addDataset(p, { name: 'ds1', connection: 'Doris', sql: 'SELECT region, amount, qty FROM t' });
  addStyle(p, { fontSizePt: 12 });
  addCell(p, { column: 0, row: 0, content: '文本格', styleIndex: 1 });
  return { d, p };
}
const p1Throws = (fn, re) => { let c; try { fn(); } catch (e) { c = e; } assert.ok(c, `应抛错 ${re}`); assert.match(c.message, re); };

test('P1 update_chart / get_chart：改标题/数值列/类型，保留坐标与合并跨度', () => {
  const { d, p } = p1Scaffold();
  addChart(p, { column: 0, row: 2, type: 'column', dsName: 'ds1', category: 'region', values: [{ name: 'amount', agg: 'sum' }], title: '销售', colspan: 5, rowspan: 14 });
  let g = getChart(p, { column: 0, row: 2 });
  assert.equal(g.type, 'column');
  assert.equal(g.dsName, 'ds1');
  assert.equal(g.category, 'region');
  assert.equal(g.values[0].name, 'amount');
  assert.equal(g.colspan, 5);
  assert.equal(g.rowspan, 14);
  updateChart(p, { column: 0, row: 2, title: '销售额', values: ['amount', 'qty'] });
  g = getChart(p, { column: 0, row: 2 });
  assert.equal(g.title, '销售额');
  assert.deepEqual(g.values.map((v) => v.name), ['amount', 'qty']);
  assert.equal(g.colspan, 5, '合并跨度保留');
  updateChart(p, { column: 0, row: 2, type: 'line' });
  assert.equal(getChart(p, { column: 0, row: 2 }).type, 'line');
  p1Throws(() => updateChart(p, { column: 0, row: 0, title: 'x' }), /不是图表/);
  fs.rmSync(d, { recursive: true, force: true });
});

test('P1 update_float_element / get_float_element：改内容/位置/名称', () => {
  const { d, p } = p1Scaffold();
  addFloatElement(p, { content: '大标题', styleIndex: 1, leftMm: 10, topMm: 20, widthMm: 60, heightMm: 12, name: 'F1' });
  assert.equal(getFloatElement(p, { name: 'F1' }).floats[0].content, '大标题');
  const r = updateFloatElement(p, { name: 'F1', content: '新标题', leftMm: 30, newName: 'F2' });
  assert.equal(r.action, 'update_float_element');
  const fe = getFloatElement(p, { name: 'F2' });
  assert.equal(fe.floats[0].content, '新标题');
  assert.equal(fe.floats[0].positionMm.leftMm, 30);
  assert.equal(getFloatElement(p, { name: 'F1' }).count, 0);
  p1Throws(() => updateFloatElement(p, { name: 'NOPE', content: 'x' }), /未找到/);
  fs.rmSync(d, { recursive: true, force: true });
});

test('P1 update_cell_hyperlink：改 URL/打开方式/名称，未传沿用现状', () => {
  const { d, p } = p1Scaffold();
  addCellHyperlink(p, { column: 0, row: 0, type: 'url', url: 'https://a.com', name: '官网' });
  updateCellHyperlink(p, 0, 0, { name: '官网', url: 'https://b.com', target: '_self', newName: '官网2' });
  const hl = getCellHyperlink(p, 0, 0);
  assert.match(hl.hyperlinks[0].url, /^https:\/\/b\.com/);
  assert.equal(hl.hyperlinks[0].name, '官网2');
  p1Throws(() => updateCellHyperlink(p, 0, 0, { name: 'NOPE', url: 'https://x.com' }), /未找到/);
  fs.rmSync(d, { recursive: true, force: true });
});

test('P1 update_cell_hyperlink：reportlet 传参只改打开方式时原样保留', () => {
  const { d, p } = p1Scaffold();
  addCellHyperlink(p, { column: 0, row: 0, type: 'reportlet', reportletPath: '/demo/明细.cpt', params: { 订单号: '=$订单号' }, name: '下钻' });
  updateCellHyperlink(p, 0, 0, { name: '下钻', target: '_dialog', width: 800 });
  const hl = getCellHyperlink(p, 0, 0);
  assert.equal(hl.hyperlinks[0].type, 'reportlet');
  assert.equal(hl.hyperlinks[0].reportletPath, '/demo/明细.cpt');
  assert.equal(hl.hyperlinks[0].params.length, 1);
  assert.equal(hl.hyperlinks[0].params[0].name, '订单号');
  assert.match(hl.hyperlinks[0].params[0].value, /=\$订单号/);
  fs.rmSync(d, { recursive: true, force: true });
});

test('P1 update_cell_highlight：按 formula/index 定位，改条件或改效果', () => {
  const { d, p } = p1Scaffold();
  addCellHighlight(p, { column: 0, row: 0, formula: '$$$ < 0', fontColor: '#FF0000' });
  updateCellHighlight(p, { column: 0, row: 0, formula: '$$$ < 0', background: '#FFFF00' });
  let h = getCellHighlight(p, 0, 0);
  assert.equal(h.highlights.length, 1);
  assert.equal(h.highlights[0].background.color, '-256');
  updateCellHighlight(p, { column: 0, row: 0, index: 0, newFormula: '$$$ > 100' });
  h = getCellHighlight(p, 0, 0);
  assert.equal(h.highlights[0].formula, '$$$ > 100');
  p1Throws(() => updateCellHighlight(p, { column: 0, row: 0, formula: '$$$ == 0', background: '#000000' }), /找不到/);
  fs.rmSync(d, { recursive: true, force: true });
});

test('P1 cell listener：get / update / delete 严格语义', () => {
  const { d, p } = p1Scaffold();
  setCellListener(p, 0, 0, { event: 'afterinit', js: 'initA();' });
  assert.equal(getCellListener(p, 0, 0, {}).count, 1);
  assert.match(getCellListener(p, 0, 0, {}).listeners[0].js, /initA/);
  assert.equal(updateCellListener(p, 0, 0, { event: 'afterinit', js: 'initB();' }).action, 'update_cell_listener');
  assert.match(getCellListener(p, 0, 0, {}).listeners[0].js, /initB/);
  p1Throws(() => updateCellListener(p, 0, 0, { event: 'click', js: 'x();' }), /未找到/);
  assert.equal(deleteCellListener(p, 0, 0, { event: 'afterinit' }).action, 'delete_cell_listener');
  assert.equal(getCellListener(p, 0, 0, {}).count, 0);
  p1Throws(() => deleteCellListener(p, 0, 0, { event: 'afterinit' }), /未找到/);
  fs.rmSync(d, { recursive: true, force: true });
});

test('P1 update_cell_listener：保留原 className 不强制重置', () => {
  const { d, p } = p1Scaffold();
  const custom = 'com.fr.js.MyCustomJavaScriptImpl';
  setCellListener(p, 0, 0, { event: 'afterinit', js: 'initA();', className: custom });
  assert.equal(getCellListener(p, 0, 0, {}).listeners[0].className, custom);
  // 未传 className → 沿用原 className，不重置为默认
  updateCellListener(p, 0, 0, { event: 'afterinit', js: 'initB();' });
  assert.equal(getCellListener(p, 0, 0, {}).listeners[0].className, custom);
  // 显式传 className → 才切换
  updateCellListener(p, 0, 0, { event: 'afterinit', js: 'initC();', className: 'com.fr.js.AnotherJavaScriptImpl' });
  assert.equal(getCellListener(p, 0, 0, {}).listeners[0].className, 'com.fr.js.AnotherJavaScriptImpl');
  fs.rmSync(d, { recursive: true, force: true });
});

test('P1 get_cell_listener 放宽：裸文本 Content / 缺 JavaScript class 仍能读回（防漏读）', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-p1-len-'));
  const p = path.join(d, 'len.cpt');
  createCpt(p, { title: 'T', rows: 4, columns: 4 });
  addCell(p, { column: 0, row: 0, content: '格' });
  setCellListener(p, 0, 0, { event: 'afterinit', js: 'initA();' });
  // 模拟官方非标准形态：去掉 <JavaScript> 的 class，Content 由 CDATA 改为裸文本
  let raw = fs.readFileSync(p, 'utf8');
  raw = raw.replace('<JavaScript class="com.fr.js.JavaScriptImpl">', '<JavaScript>');
  raw = raw.replace('<Content>\n<![CDATA[initA();]]></Content>', '<Content>initA裸();</Content>');
  fs.writeFileSync(p, raw);
  const r = getCellListener(p, 0, 0, {});
  assert.equal(r.count, 1);
  assert.equal(r.listeners[0].event, 'afterinit');
  assert.equal(r.listeners[0].js, 'initA裸();');
  assert.equal(r.listeners[0].className, null, '缺 class 读回 null，不再漏读');
  fs.rmSync(d, { recursive: true, force: true });
});

test('P1 get_cell_hyperlink 放宽：裸文本 reportlet 路径与裸文本传参读回（防漏读）', () => {
  const { d, p } = p1Scaffold();
  addCellHyperlink(p, { column: 0, row: 0, type: 'reportlet', reportletPath: '/demo/明细.cpt', params: { 订单号: '=A3', type: 'detail' } });
  let raw = fs.readFileSync(p, 'utf8');
  // reportlet 路径与固定值参数均去掉 CDATA，改成裸文本（公式参数仍保留 CDATA 形态）
  raw = raw.replace('<ReportletName showPI="true">\n<![CDATA[/demo/明细.cpt]]>\n</ReportletName>', '<ReportletName showPI="true">/demo/裸路径.cpt</ReportletName>');
  raw = raw.replace('<O>\n<![CDATA[detail]]>\n</O>', '<O>detail裸</O>');
  fs.writeFileSync(p, raw);
  const r = getCellHyperlink(p, 0, 0);
  assert.equal(r.hyperlinks[0].type, 'reportlet');
  assert.equal(r.hyperlinks[0].reportletPath, '/demo/裸路径.cpt', '裸文本 reportlet 路径读回');
  const order = r.hyperlinks[0].params.find((x) => x.name === '订单号');
  const type = r.hyperlinks[0].params.find((x) => x.name === 'type');
  assert.match(order.value, /=A3/, '公式参数值仍读回');
  assert.equal(type.value, 'detail裸', '裸文本固定值参数读回');
  fs.rmSync(d, { recursive: true, force: true });
});

test('P1 update_cell_hyperlink：保留原 className 不强制重置', () => {
  const { d, p } = p1Scaffold();
  addCellHyperlink(p, { column: 0, row: 0, type: 'url', url: 'https://a.com', name: '官网' });
  const before = getCellHyperlink(p, 0, 0);
  assert.equal(before.hyperlinks[0].type, 'url');
  // 改 URL 但未改 type → 原 className（com.fr.js.WebHyperlink）原样保留
  updateCellHyperlink(p, 0, 0, { name: '官网', url: 'https://b.com' });
  const xml = fs.readFileSync(p, 'utf8');
  assert.ok(xml.includes('class="com.fr.js.WebHyperlink"'), 'url 类 hyperlink 的 className 保留');
  // 显式改 type 为 script → className 切换为 JavaScriptImpl
  updateCellHyperlink(p, 0, 0, { name: '官网', type: 'script', script: 'alert(1)' });
  const after = getCellHyperlink(p, 0, 0);
  assert.equal(after.hyperlinks[0].type, 'script');
  fs.rmSync(d, { recursive: true, force: true });
});

test('P1 update_cell_sort / get_cell_sort：设置/读取/清空', () => {
  const { d, p } = p1Scaffold();
  addCell(p, { column: 1, row: 2, contentType: 'dsColumn', dsName: 'ds1', columnName: 'amount', styleIndex: 1 });
  updateCellSort(p, { column: 1, row: 2, sort: [{ area: 'qty', direction: 'desc' }] });
  let s = getCellSort(p, { column: 1, row: 2 });
  assert.equal(s.hasSort, true);
  assert.equal(s.sorts[0].sortArea, 'qty');
  assert.equal(s.sorts[0].direction, 'desc');
  updateCellSort(p, { column: 1, row: 2, sort: [{ area: 'qty', direction: 'asc' }, { area: 'amount', direction: 'desc' }] });
  assert.equal(getCellSort(p, { column: 1, row: 2 }).sorts.length, 2);
  assert.equal(updateCellSort(p, { column: 1, row: 2, sort: [] }).mode, 'delete');
  assert.equal(getCellSort(p, { column: 1, row: 2 }).hasSort, false);
  fs.rmSync(d, { recursive: true, force: true });
});

test('P1 update_fill_submit：改目标表/名称，不追加不重建', () => {
  const { d, p } = p1Scaffold();
  addFillSubmit(p, { dsName: 'Doris', table: 't1', bindings: [{ field: 'region', column: 0, row: 2 }] });
  updateFillSubmit(p, { submitIndex: 0, table: 't2', name: '提交A' });
  const fc = fillConfig(p);
  assert.equal(fc.submits.length, 1);
  assert.equal(fc.submits[0].table, 't2');
  assert.equal(fc.submits[0].name, '提交A');
  p1Throws(() => updateFillSubmit(p, { submitIndex: 5, table: 'x' }), /全文档提交不足/);
  fs.rmSync(d, { recursive: true, force: true });
});

test('P1 update_sheet：重命名工作表', () => {
  const { d, p } = p1Scaffold();
  addSheet(p, { sheetName: 's2', rows: 2, columns: 2 });
  const r = updateSheet(p, { sheet: 's2', newName: 's3' });
  assert.equal(r.action, 'update_sheet');
  assert.ok(fs.readFileSync(p, 'utf8').includes('name="s3"'));
  p1Throws(() => updateSheet(p, { sheet: 0, newName: 's3' }), /已存在/);
  fs.rmSync(d, { recursive: true, force: true });
});

test('P1 改/删/查工具写后 validate 零 error（结构保真）', () => {
  const { d, p } = p1Scaffold();
  addChart(p, { column: 0, row: 2, type: 'column', dsName: 'ds1', category: 'region', values: [{ name: 'amount', agg: 'sum' }] });
  updateChart(p, { column: 0, row: 2, values: ['amount', 'qty'] });
  addFloatElement(p, { content: 'x', name: 'F1' });
  updateFloatElement(p, { name: 'F1', content: 'y' });
  addCellHyperlink(p, { column: 0, row: 0, type: 'script', script: 'a();', name: 's' });
  addCellHighlight(p, { column: 0, row: 0, formula: '$$$ < 0', fontColor: '#FF0000' });
  updateCellHighlight(p, { column: 0, row: 0, formula: '$$$ < 0', background: '#FFFF00' });
  setCellListener(p, 0, 0, { event: 'click', js: 'c();' });
  updateCellListener(p, 0, 0, { event: 'click', js: 'd();' });
  deleteCellListener(p, 0, 0, { event: 'click' });
  addCell(p, { column: 1, row: 2, contentType: 'dsColumn', dsName: 'ds1', columnName: 'amount', styleIndex: 1 });
  updateCellSort(p, { column: 1, row: 2, sort: [{ area: 'qty', direction: 'asc' }] });
  addFillSubmit(p, { dsName: 'Doris', table: 't1', bindings: [{ field: 'region', column: 0, row: 2 }] });
  updateFillSubmit(p, { submitIndex: 0, table: 't2' });
  addSheet(p, { sheetName: 's2', rows: 2, columns: 2 });
  updateSheet(p, { sheet: 's2', newName: 's3' });
  const issues = validateCpt(p);
  assert.equal(issues.filter((i) => i.severity === 'error').length, 0);
  fs.rmSync(d, { recursive: true, force: true });
});
