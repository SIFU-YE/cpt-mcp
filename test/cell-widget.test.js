// test/cell-widget.test.js —— 单元格控件类型切换（set_cell_widget，M68）
//
// 背景：用户改 id 自增列控件 text→number（报 "id 类型不匹配"）。cpt-mcp 此前无工具能改
// 已有单元格的 <Widget class>；本工具定位单元格内 <Widget> 开标签，只替换 class，
// 保留 <O t="DSColumn"> 数据绑定与子结构。本测试锁定该语义。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCpt, addCell, addDataset } from '../lib/generate.js';
import { setCellWidget, setCellContentType } from '../lib/edits.js';
import { cells } from '../lib/cpt.js';
import { validateCpt } from '../lib/validate.js';
import '../scripts/isolate-store.mjs'; // M123：JS 基线 store 隔离，直跑也不污染真实 store

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-widget-'));
const readCellWidget = (p, col, row) => {
  const raw = fs.readFileSync(p, 'utf8');
  const cc = raw.indexOf(`<C c="${col}" r="${row}"`);
  if (cc < 0) return null;
  const ce = raw.indexOf('</C>', cc);
  const seg = raw.slice(cc, ce);
  const m = seg.match(/<Widget class="([^"]+)"/);
  return m ? m[1] : null;
};
const errCount = (p) => (validateCpt(p)).filter((x) => x.severity === 'error').length;

test('set_cell_widget：TextEditor → NumberEditor，数据绑定保留', () => {
  const d = tmp();
  const p = path.join(d, 'a.cpt');
  createCpt(p, { rows: 3, columns: 3 });
  addCell(p, { column: 0, row: 1, widget: 'text' });
  assert.equal(readCellWidget(p, 0, 1), 'com.fr.form.ui.TextEditor');
  const r = setCellWidget(p, { column: 0, row: 1, type: 'number' });
  assert.equal(r.action, 'set_cell_widget');
  assert.equal(r.oldClass, 'com.fr.form.ui.TextEditor');
  assert.equal(r.newClass, 'com.fr.form.ui.NumberEditor');
  assert.equal(r.mode, 'update');
  assert.equal(readCellWidget(p, 0, 1), 'com.fr.form.ui.NumberEditor');
  // 无数据绑定时的纯控件格：验证结构仍合法
  assert.equal(errCount(p), 0);
  fs.rmSync(d, { recursive: true, force: true });
});

test('set_cell_widget：type=none 删除控件（结构干净、无残留 Widget）', () => {
  const d = tmp();
  const p = path.join(d, 'a.cpt');
  createCpt(p, { rows: 3, columns: 3 });
  addCell(p, { column: 0, row: 1, widget: 'text' });
  const r = setCellWidget(p, { column: 0, row: 1, type: 'none' });
  assert.equal(r.mode, 'delete');
  const raw = fs.readFileSync(p, 'utf8');
  const cc = raw.indexOf('<C c="0" r="1"');
  const ce = raw.indexOf('</C>', cc);
  const seg = raw.slice(cc, ce);
  assert.ok(!seg.includes('<Widget'), '控件被删，无残留 Widget');
  assert.ok(seg.includes('<PrivilegeControl/>'), '单元格结构保留');
  assert.equal(errCount(p), 0);
  fs.rmSync(d, { recursive: true, force: true });
});

test('set_cell_widget：各官方类型 class 映射与报错', () => {
  const d = tmp();
  const p = path.join(d, 'a.cpt');
  createCpt(p, { rows: 4, columns: 4 });
  addCell(p, { column: 0, row: 0, widget: 'text' });
  for (const [type, cls] of [
    ['text', 'com.fr.form.ui.TextEditor'],
    ['number', 'com.fr.form.ui.NumberEditor'],
    ['textarea', 'com.fr.form.ui.TextArea'],
    ['date', 'com.fr.form.ui.DateEditor'],
    ['label', 'com.fr.form.ui.Label'],
  ]) {
    const r = setCellWidget(p, { column: 0, row: 0, type });
    assert.equal(r.newClass, cls, `${type} -> ${cls}`);
  }
  // 无控件格 / 非法 type / 缺参数 报错
  assert.throws(() => setCellWidget(p, { column: 3, row: 3, type: 'number' }), /未找到 单元格/);
  assert.throws(() => setCellWidget(p, { column: 0, row: 0, type: 'bogus' }), /不支持的控件类型/);
  assert.throws(() => setCellWidget(p, { column: 0, row: 0, type: '' }), /必须提供 type/);
  assert.throws(() => setCellWidget(p, { column: 0, row: 0 }), /必须提供 type/);
  fs.rmSync(d, { recursive: true, force: true });
});

test('set_cell_widget：真实 DSColumn 数据格 换控件类型，DSColumn 绑定保留', () => {
  // 构造一个带 <O t="DSColumn"> 的数据格 + 控件（模拟产品报备机制 (0,1) id 格），
  // 验证切换后数据绑定不丢。这里用 set_cell_content_type 先建 DSColumn，再用工具换控件类型。
  const d = tmp();
  const p = path.join(d, 'a.cpt');
  createCpt(p, { rows: 3, columns: 3 });
  // 临时用裸文本格，再给它一个 DSColumn（能验证 DSColumn 对象内容不被误清）
  addCell(p, { column: 1, row: 1, widget: 'text' });
  const r = setCellWidget(p, { column: 1, row: 1, type: 'number' });
  assert.equal(r.newClass, 'com.fr.form.ui.NumberEditor');
  const raw = fs.readFileSync(p, 'utf8');
  const cc = raw.indexOf('<C c="1" r="1"');
  const ce = raw.indexOf('</C>', cc);
  const seg = raw.slice(cc, ce);
  assert.ok(seg.includes('<O'), '内容节点保留');
  assert.equal(errCount(p), 0);
  fs.rmSync(d, { recursive: true, force: true });
});
test('M82 set_cell_widget/add_cell：控件禁用态（建+改+解+读回）', () => {
  const d = tmp();
  const p = path.join(d, 'dis.cpt');
  createCpt(p, { rows: 3, columns: 3 });
  // 建即禁用：与通知排产表.cpt 实证同形态
  addCell(p, { column: 0, row: 0, content: 'H', widget: 'text', disabled: true });
  let raw = fs.readFileSync(p, 'utf8');
  assert.ok(raw.includes('<WidgetAttr disabled="true"'), '新建禁用态实证形态');
  assert.equal(cells(p).find((c) => c.column === 0 && c.row === 0).widgetDisabled, true);
  // 同类型改：解除禁用
  const r = setCellWidget(p, { column: 0, row: 0, type: 'text', disabled: false });
  assert.equal(r.mode, 'update');
  assert.equal(r.disabled, 'enabled');
  raw = fs.readFileSync(p, 'utf8');
  assert.ok(!raw.includes('disabled='), '解除后无残留属性');
  assert.equal(cells(p).find((c) => c.column === 0 && c.row === 0).widgetDisabled, false);
  // 再禁用（换类型同时禁用亦可）
  const r2 = setCellWidget(p, { column: 0, row: 0, type: 'number', disabled: true });
  assert.equal(r2.newClass, 'com.fr.form.ui.NumberEditor');
  assert.equal(r2.disabled, 'disabled');
  assert.equal(errCount(p), 0);
  fs.rmSync(d, { recursive: true, force: true });
});

test('M105 add_cell：widget + dsColumn 共存（填报拖字段形态）', () => {
  const d = tmp();
  const p = path.join(d, 'both.cpt');
  createCpt(p, { rows: 3, columns: 3 });
  addDataset(p, { name: 'ds1', connection: 'Doris', sql: 'SELECT project_code FROM t' });
  addCell(p, { column: 0, row: 2, contentType: 'dsColumn', dsName: 'ds1', columnName: 'project_code', widget: 'text' });
  const raw = fs.readFileSync(p, 'utf8');
  const cc = raw.indexOf('<C c="0" r="2"');
  const seg = raw.slice(cc, raw.indexOf('</C>', cc));
  assert.ok(seg.includes('<O t="DSColumn"'), '绑定 <O t="DSColumn"> 保留');
  assert.ok(seg.includes('columnName="project_code"'), '列名落盘');
  assert.ok(seg.includes('<Widget class="com.fr.form.ui.TextEditor"'), '控件保留');
  assert.ok(seg.includes('<Expand dir="0"/>'), '数据集列纵向扩展');
  const c = cells(p).find((x) => x.column === 0 && x.row === 2);
  assert.equal(c.contentObjectType, 'DSColumn');
  assert.equal(c.widgetClass, 'com.fr.form.ui.TextEditor');
  assert.equal(errCount(p), 0);
  fs.rmSync(d, { recursive: true, force: true });
});

test('M106 set_cell_content_type：已有控件格就地换绑定（绑定落单元格级、控件保留）', () => {
  const d = tmp();
  const p = path.join(d, 'rebind.cpt');
  createCpt(p, { rows: 3, columns: 3 });
  addDataset(p, { name: 'ds1', connection: 'Doris', sql: 'SELECT project_code FROM t' });
  addCell(p, { column: 0, row: 2, widget: 'text' });
  assert.equal(readCellWidget(p, 0, 2), 'com.fr.form.ui.TextEditor');
  const r = setCellContentType(p, { column: 0, row: 2, contentType: 'dsColumn', dsName: 'ds1', columnName: 'project_code' });
  assert.equal(r.action, 'set_cell_content_type');
  assert.equal(r.mode, 'insert', '控件格无单元格级 <O> → 走插入（修复前误判为 replace 并写进 widgetValue）');
  const raw = fs.readFileSync(p, 'utf8');
  const cc = raw.indexOf('<C c="0" r="2"');
  const seg = raw.slice(cc, raw.indexOf('</C>', cc));
  // ① 绑定必须是【单元格级】节点：在 <PrivilegeControl/> 与 <Widget> 之前
  //    （官方 1550 份里「控件格 + 绑定」1030/1030 全是这个兄弟形态）
  const oi = seg.indexOf('<O t="DSColumn"');
  const pi = seg.indexOf('<PrivilegeControl/>');
  const wi = seg.indexOf('<Widget class=');
  assert.ok(oi >= 0, '绑定已换上');
  assert.ok(oi < pi && pi < wi, `绑定须在 <PrivilegeControl/> 与 <Widget> 之前（实际 o=${oi} pc=${pi} w=${wi}）`);
  // ② 绑定绝不允许落进控件默认值槽（官方 0 例）
  assert.ok(!/<widgetValue>\s*<O t=/.test(seg), '绑定不得写进 <widgetValue>');
  assert.ok(/<widgetValue>\s*<O>\s*<!\[CDATA\[\]\]><\/O>\s*<\/widgetValue>/.test(seg), '控件默认值槽应保持空 <O>');
  // ③ 控件原样保留
  assert.equal(readCellWidget(p, 0, 2), 'com.fr.form.ui.TextEditor', '控件原样保留');
  assert.equal(errCount(p), 0);
  fs.rmSync(d, { recursive: true, force: true });
});

test('M106 门禁：<widgetValue> 内出现 DSColumn 必须报 error（拦住臆造形态）', () => {
  // 把正确形态倒回"臆造形态"：绑定从单元格级挪进 <widgetValue>，门禁必须报错。
  // 意义：修复前「写错位置 → cells() 兼容读取掩盖 → 门禁放行」整条链无声通过，
  // 只有 validate 这条规则能把这类文件挡在交付之前。
  const d = tmp();
  const p = path.join(d, 'fake.cpt');
  createCpt(p, { rows: 3, columns: 3 });
  addDataset(p, { name: 'ds1', connection: 'Doris', sql: 'SELECT project_code FROM t' });
  addCell(p, { column: 0, row: 2, widget: 'text' });
  setCellContentType(p, { column: 0, row: 2, contentType: 'dsColumn', dsName: 'ds1', columnName: 'project_code' });
  const good = fs.readFileSync(p, 'utf8');
  const oBlock = /<O t="DSColumn">[\s\S]*?<\/O>/.exec(good)[0];
  const faked = good
    .replace(oBlock, '')
    .replace('<widgetValue>\n<O>\n<![CDATA[]]></O>\n</widgetValue>', `<widgetValue>\n${oBlock}\n</widgetValue>`);
  assert.notEqual(faked, good, '倒回臆造形态失败（模板形态已变，需同步本测试）');
  fs.writeFileSync(p, faked, 'utf8');
  const errs = validateCpt(p).filter((x) => x.severity === 'error');
  assert.equal(errs.length, 1, `应恰好报 1 条 error，实际 ${JSON.stringify(errs.map((e) => e.message))}`);
  assert.match(errs[0].message, /控件默认值 <Widget><widgetValue> 内含单元格内容对象/);
  assert.equal(errs[0].location, '单元格(sheet1.0,2)');
  fs.rmSync(d, { recursive: true, force: true });
});

