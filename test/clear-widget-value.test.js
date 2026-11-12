// test/clear-widget-value.test.js —— M115 清理「控件默认值槽塞了数据集对象」脏形态
//
// 背景（能力缺口，sandbox4/V3/sample-fillV3.cpt 实测 11 处）：
//   该文件的 11 个填报单元格长成这样：
//     <Widget class="com.fr.form.ui.TextEditor">
//       ...
//       <widgetValue>
//         <O t="DSColumn">…</O>        ← 数据集对象被写进了**控件默认值槽**
//       </widgetValue>
//     </Widget>
//   官方 1550 份样本里 **0 例**；quality_gate_cpt 报 error。
//   正确形态：数据绑定是**单元格级** <O t="DSColumn">（与 <Widget> 平级、在 <PrivilegeControl/> 之前），
//   值槽只能放默认值/公式。多数控件本就没有 <widgetValue>，删掉值槽不影响取数。
//
//   M115 之前没有任何工具能只删这一个子节点：
//     · set_cell_widget(type:'none')  删整个 <Widget>（连 Listener/Tooltip/Reg 一起没）——有 Listener 时还会被拒
//     · set_cell_content_type         改绑定类型，碰脏值槽会要求"先 delete_cell"（丢监听/条件属性/扩展父格）
//     · update_report_node            只动 Report 直接子节点，够不到单元格内的 <Widget>
//   本文件锁定新工具 clear_widget_value 的"只删值槽、其余字节原样"语义，以及 set_widget_value
//   在遇到脏值槽时的**定向报错**（M115 同时修掉了它 indexOf('<O>') 匹配不到 <O t="…"> 的检测 bug）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCpt, addCell, addSheet, addDataset } from '../lib/generate.js';
import { clearWidgetValue, setWidgetValue, setCellListener } from '../lib/edits.js';
import { qualityGate } from '../lib/quality.js';
import { validateCpt } from '../lib/validate.js';
import '../scripts/isolate-store.mjs'; // M123：JS 基线 store 隔离，直跑也不污染真实 store

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-cwv-'));
const read = (p) => fs.readFileSync(p, 'utf8');
const cellSeg = (p, c, r) => {
  const raw = read(p);
  const cc = raw.indexOf(`<C c="${c}" r="${r}"`);
  const ce = raw.indexOf('</C>', cc);
  return raw.slice(cc, ce);
};
const errCount = (p) => validateCpt(p).filter((x) => x.severity === 'error').length;

/** 造一个「控件默认值槽塞数据集对象」的脏格。
 *  照真实文件（sandbox4/V3/sample-fillV3.cpt）的形态：单元格级已是**正常** DSColumn 绑定
 *  （<O t="DSColumn"><Attributes dsName=… columnName=…>…），控件值槽里**多塞了同一个对象**。
 *  这样 quality_gate 的唯一 blocker 就是脏值槽本身。 */
function makeDirty(p, { c = 0, r = 1 } = {}) {
  createCpt(p, { rows: 3, columns: 3 });
  addDataset(p, { name: 'ds1', connection: 'Doris', sql: 'select id, name from t' });
  addCell(p, { column: c, row: r, contentType: 'dsColumn', dsName: 'ds1', columnName: 'id', widget: 'text' });
  let raw = read(p);
  const before = /<O>\s*<!\[CDATA\[\]\]><\/O>/.exec(raw);
  assert.ok(before, '前置：生成的控件应有裸 <O> 值槽');
  raw = raw.replace(before[0], '<O t="DSColumn">\n<Attributes dsName="ds1" columnName="id"/>\n<Complex/>\n</O>');
  fs.writeFileSync(p, raw);
  // 前置自检：单元格级绑定仍在（取数靠它），脏的只是值槽
  assert.equal((read(p).match(/<O t="DSColumn">/g) || []).length, 2, '前置：单元格级 1 处 + 脏值槽 1 处');
}

test('M115 clear_widget_value：脏值槽删除后 blockers 归零，单元格级绑定与控件原样保留', () => {
  const d = tmp();
  const p = path.join(d, 'a.cpt');
  makeDirty(p);
  const g0 = qualityGate(p);
  assert.equal(g0.blockers.length, 1, '前置：脏形态应被 quality_gate 报 1 个 blocker');
  assert.equal(g0.pass, false);
  assert.match(g0.blockers[0].location, /单元格\(sheet1\.0,1\)/);

  const r = clearWidgetValue(p, { column: 0, row: 1, expectObject: true });
  assert.equal(r.action, 'clear_widget_value');
  assert.equal(r.mode, 'clear');
  assert.equal(r.removedSlotKind, 'object');
  assert.equal(r.removedObjectType, 'DSColumn');
  assert.ok(r.bytesAfter < r.bytesBefore, '应实删字节');

  const seg = cellSeg(p, 0, 1);
  assert.ok(!seg.includes('<widgetValue>'), '值槽整块已删');
  assert.equal((seg.match(/<O t="DSColumn">/g) || []).length, 1, '单元格级绑定必须原样保留（唯一一处）');
  assert.match(seg, /<Widget class="com\.fr\.form\.ui\.TextEditor">/, '控件本体保留');
  assert.match(seg, /<Reg class="com\.fr\.form\.ui\.reg\.NoneReg"\/>/, '控件子结构（Reg）保留');
  assert.match(seg, /<PrivilegeControl\/>/, '单元格结构保留');

  const g1 = qualityGate(p);
  assert.equal(g1.blockers.length, 0, 'clean 后 blockers 应归零');
  assert.equal(g1.pass, true);
  assert.equal(errCount(p), 0, 'validate 无 error');
  fs.rmSync(d, { recursive: true, force: true });
});

test('M115 clear_widget_value：值槽里的 Listener 不在删除范围内（只删值槽，不动控件子结构）', () => {
  const d = tmp();
  const p = path.join(d, 'a.cpt');
  makeDirty(p);
  // 给这个控件格挂一个 stopedit 监听（真实填报格普遍有），确认清理不误伤
  setCellListener(p, 0, 1, { event: 'stopedit', js: 'alert(1)' });
  const before = cellSeg(p, 0, 1);
  assert.ok(before.includes('event="stopedit"'), '前置：监听已写入');

  clearWidgetValue(p, { column: 0, row: 1, expectObject: true });

  const after = cellSeg(p, 0, 1);
  assert.ok(after.includes('event="stopedit"'), '监听器必须原样保留');
  assert.ok(after.includes('alert(1)'), '监听 JS 正文必须原样保留');
  assert.ok(!after.includes('<widgetValue>'), '值槽已删');
  assert.equal(errCount(p), 0);
  fs.rmSync(d, { recursive: true, force: true });
});

test('M115 clear_widget_value：expectObject=true 时普通默认值不被误删；=false 才是"清默认值"', () => {
  const d = tmp();
  const p = path.join(d, 'a.cpt');
  createCpt(p, { rows: 3, columns: 3 });
  addCell(p, { column: 0, row: 1, widget: 'text', text: '默认值' });
  const raw0 = read(p);

  // 值槽是普通文本（裸 <O>）：expectObject=true → 跳过，文件不动
  const skip = clearWidgetValue(p, { column: 0, row: 1, expectObject: true });
  assert.equal(skip.mode, 'skipped');
  assert.equal(skip.slotKind, 'bare');
  assert.equal(read(p), raw0, 'skipped 必须零字节改动');

  // expectObject=false（默认）：确实删
  const done = clearWidgetValue(p, { column: 0, row: 1 });
  assert.equal(done.mode, 'clear');
  assert.equal(done.removedSlotKind, 'bare');
  assert.ok(!cellSeg(p, 0, 1).includes('<widgetValue>'));
  assert.equal(errCount(p), 0, '删掉默认值是合法形态');
  fs.rmSync(d, { recursive: true, force: true });
});

test('M115 clear_widget_value：幂等（本无值槽 → mode=none 不写文件）与边界拒绝', () => {
  const d = tmp();
  const p = path.join(d, 'a.cpt');
  createCpt(p, { rows: 3, columns: 3 });
  addCell(p, { column: 0, row: 1, widget: 'text' });
  clearWidgetValue(p, { column: 0, row: 1 });
  const raw1 = read(p);

  const again = clearWidgetValue(p, { column: 0, row: 1 });
  assert.equal(again.mode, 'none', '第二次调用应 mode=none');
  assert.equal(read(p), raw1, 'mode=none 不写文件');

  // 非控件格
  addCell(p, { column: 2, row: 2, content: '纯文本' });
  assert.throws(() => clearWidgetValue(p, { column: 2, row: 2 }), /未找到 <Widget>/);
  // 缺列行（与其它编辑工具一致：必填）
  assert.throws(() => clearWidgetValue(p, { column: 0 }), /column 与 row/);
  fs.rmSync(d, { recursive: true, force: true });
});

test('M115 set_widget_value 检测 bug 修复：<O t="DSColumn"> 值槽不再误报"无 <O>"，而是定向指向 clear_widget_value', () => {
  const d = tmp();
  const p = path.join(d, 'a.cpt');
  makeDirty(p);
  // 修复前：inner.indexOf('<O>') 匹配不到 <O t="DSColumn"> → 报 "widgetValue 内无 <O>"（误导：明明有）
  // 修复后：识别为内容对象，拒绝覆盖并点名 clear_widget_value
  assert.throws(
    () => setWidgetValue(p, { column: 0, row: 1, text: 'x' }),
    (e) => /单元格内容对象/.test(e.message)
      && /DSColumn/.test(e.message)
      && /clear_widget_value/.test(e.message)
      && !/无 <O>/.test(e.message),
    '应报"值槽里是内容对象"并指路 clear_widget_value，而非"无 <O>"',
  );
  // 且拒绝时不改文件（不能把对象当默认值文本写坏）
  assert.ok(cellSeg(p, 0, 1).includes('<O t="DSColumn">'), '拒绝路径不写文件');

  // 清理后，同一格可以正常写默认值
  clearWidgetValue(p, { column: 0, row: 1, expectObject: true });
  const w = setWidgetValue(p, { column: 0, row: 1, text: '正常默认值' });
  assert.equal(w.action, 'set_widget_value');
  const seg = cellSeg(p, 0, 1);
  assert.ok(seg.includes('正常默认值'), '默认值已写入');
  assert.equal((seg.match(/<O t="DSColumn">/g) || []).length, 1, '单元格级绑定仍在');
  assert.equal(errCount(p), 0);
  fs.rmSync(d, { recursive: true, force: true });
});

test('M115 多表：同坐标格并存时 sheet 必填（拒绝静默命中第一格），指定 sheet 只动那一个', () => {
  const d = tmp();
  const p = path.join(d, 'a.cpt');
  createCpt(p, { rows: 3, columns: 3 });
  addSheet(p, { sheetName: 'sheet2', rows: 3, columns: 3 });
  // 两表同坐标 (0,1) 都是控件格，各自造脏值槽
  for (const sh of [0, 1]) {
    addCell(p, { column: 0, row: 1, widget: 'text', sheet: sh });
  }
  let raw = read(p);
  assert.equal((raw.match(/<O t="DSColumn">/g) || []).length, 0);
  // 逐表把裸 <O> 值槽换成对象（两处）
  raw = raw.split('<O>\n<![CDATA[]]></O>').join('<O t="DSColumn">\n<Attributes name="ds1"/>\n</O>');
  fs.writeFileSync(p, raw);
  assert.equal((raw.match(/<widgetValue>/g) || []).length, 2, '前置：两表各有一个脏值槽');

  // 缺省 sheet → 同坐标两表并存，必须拒绝（M91 防误删约定）
  assert.throws(() => clearWidgetValue(p, { column: 0, row: 1 }), /未传 sheet|均存在/);

  // 指定 sheet=1（索引）→ 只删第二表的
  const r = clearWidgetValue(p, { column: 0, row: 1, sheet: 1, expectObject: true });
  assert.equal(r.mode, 'clear');
  const after = read(p);
  assert.equal((after.match(/<widgetValue>/g) || []).length, 1, '只应删掉被指定表的那一个值槽');
  // 表名形式同样可用
  const r2 = clearWidgetValue(p, { column: 0, row: 1, sheet: 'sheet1', expectObject: true });
  assert.equal(r2.mode, 'clear');
  assert.equal((read(p).match(/<widgetValue>/g) || []).length, 0, '两张表的值槽都已清理');
  fs.rmSync(d, { recursive: true, force: true });
});
