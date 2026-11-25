// test/param-panel-layout.test.js —— 「筛选控件异常」回归：自动布局 / 复选字典 / 尺寸与标签可改 / 面板体检
//
// 实据（2026-10-29 复盘）：report 模式反复出现「筛选控件样式错误、标签缺失、位置重叠」。
// 根因链：
//  1) add_parameter_widget 的 x/y 默认 (10,10)，不传坐标时连续新增全部叠在左上角 → 预览一片重叠；
//  2) checkBox 分支不写 Dictionary/RAAttr，items 被静默丢弃 → 预览是空复选组；
//  3) update_parameter_widget 只有 x/y，改不了 width/height（尺寸错只能删了重建）→ 会话反复 add/delete；
//  4) validate/quality_gate 完全不看参数面板 → 上述异常照样全绿交付。
// 本文件锁定修复后的契约。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCpt, addParameterWidget, setParameterPanel } from '../lib/generate.js';
import { updateParameterWidget, deleteParameterWidget, renameParameterWidget } from '../lib/edits.js';
import { validateCpt } from '../lib/validate.js';
import '../scripts/isolate-store.mjs'; // JS 基线 store 隔离

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-pplayout-'));
const readPanel = (p) => {
  const raw = fs.readFileSync(p, 'utf8');
  const s = raw.indexOf('<ReportParameterAttr>');
  const e = raw.indexOf('</ReportParameterAttr>', s);
  return { raw, seg: raw.slice(s, e) };
};
const boxes = (seg) => [...seg.matchAll(/<BoundsAttr x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)"\/>/g)]
  .map((m) => ({ x: +m[1], y: +m[2], w: +m[3], h: +m[4] }));
const overlaps = (a, b) => Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > 1
  && Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) > 1;

test('add_parameter_widget 不传 x/y：自动排布，互不重叠（不再默认 (10,10) 叠一起）', () => {
  const d = tmp();
  const p = path.join(d, 'auto.cpt');
  createCpt(p, { rows: 3, columns: 3 });
  setParameterPanel(p, { title: '查询' });
  const r1 = addParameterWidget(p, { name: 'dept', type: 'comboBox', items: [{ key: 'A', value: 'A' }] });
  const r2 = addParameterWidget(p, { name: 'kw', type: 'text' });
  const r3 = addParameterWidget(p, { name: 'day', type: 'date' });
  for (const r of [r1, r2, r3]) {
    assert.equal(r.autoPlaced, true, '未传坐标应标记 autoPlaced');
    assert.ok(Number.isFinite(r.x) && Number.isFinite(r.y), '自动布局必须给出 x/y');
  }
  const { seg } = readPanel(p);
  const bs = boxes(seg);
  assert.equal(bs.length, 3);
  for (let i = 0; i < bs.length; i++) {
    for (let j = i + 1; j < bs.length; j++) {
      assert.equal(overlaps(bs[i], bs[j]), false, `自动布局后的控件不应重叠（第 ${i + 1} 与第 ${j + 1} 个）`);
    }
  }
  fs.rmSync(d, { recursive: true, force: true });
});

test('add_parameter_widget 显式 x/y：保持用户坐标（自定义布局不被自动布局干扰）', () => {
  const d = tmp();
  const p = path.join(d, 'explicit.cpt');
  createCpt(p, { rows: 3, columns: 3 });
  const r = addParameterWidget(p, { name: 'kw', type: 'text', x: 120, y: 40, width: 90, height: 22 });
  assert.equal(r.autoPlaced, undefined, '显式坐标不应标记 autoPlaced');
  const { seg } = readPanel(p);
  assert.ok(seg.includes('<BoundsAttr x="120" y="40" width="90" height="22"/>'), '显式坐标原样落盘');
  fs.rmSync(d, { recursive: true, force: true });
});

test('checkBox 复选组：items/dictionary 落盘为 Dictionary + RAAttr；无选项时显式报错而非静默丢参', () => {
  const d = tmp();
  const p = path.join(d, 'cb.cpt');
  createCpt(p, { rows: 3, columns: 3 });
  addParameterWidget(p, {
    name: 'only_valid', type: 'checkBox', label: '只看有效',
    items: [{ key: '1', value: '是' }], defaultValue: '1',
  });
  const { seg } = readPanel(p);
  const cb = seg.match(/<InnerWidget class="com\.fr\.form\.ui\.CheckBoxGroup">[\s\S]*?<\/InnerWidget>/);
  assert.ok(cb, '生成 CheckBoxGroup');
  assert.ok(cb[0].includes('com.fr.data.impl.CustomDictionary'), '复选组必须写 CustomDictionary（此前遗漏）');
  assert.ok(cb[0].includes('<Dict key="1" value="是"/>'), 'items 必须落盘（此前被静默丢弃）');
  assert.ok(cb[0].includes('<RAAttr isArray="false" delimiter="&apos;,&apos;"/>'), '复选组需要 RAAttr 返回值属性');
  // 无字典/无 items 的复选组是空控件，必须拒绝
  assert.throws(() => addParameterWidget(p, { name: 'empty_cb', type: 'checkBox' }), /必须提供 dictionary 或非空 items/);
  assert.throws(() => addParameterWidget(p, { name: 'empty_ccb', type: 'comboCheckBox' }), /必须提供 dictionary 或非空 items/);
  fs.rmSync(d, { recursive: true, force: true });
});

test('checkBox 支持 dictionary（db 字典）而不只是 items', () => {
  const d = tmp();
  const p = path.join(d, 'cbdict.cpt');
  createCpt(p, { rows: 3, columns: 3 });
  addParameterWidget(p, {
    name: 'dept_cb', type: 'checkBox',
    dictionary: { type: 'db', connection: 'Doris', table: 't', kiName: 'dept', viName: 'dept' },
  });
  const { seg } = readPanel(p);
  assert.ok(seg.includes('com.fr.data.impl.DatabaseDictionary'), 'db 字典落盘');
  assert.ok(/<WidgetName name="dept_cb"\/>/.test(seg));
  fs.rmSync(d, { recursive: true, force: true });
});

test('update_parameter_widget 支持 width/height：尺寸异常可直接修，无需删了重建', () => {
  const d = tmp();
  const p = path.join(d, 'size.cpt');
  createCpt(p, { rows: 3, columns: 3 });
  addParameterWidget(p, { name: 'kw', type: 'text', x: 10, y: 10, width: 100, height: 24 });
  const r = updateParameterWidget(p, { name: 'kw', width: 160, height: 28 });
  assert.equal(r.mode, 'update');
  const { seg } = readPanel(p);
  assert.ok(seg.includes('<BoundsAttr x="10" y="10" width="160" height="28"/>'), 'width/height 应写回 BoundsAttr');
  // 非法尺寸拒绝（0/负尺寸 = 不可见异常控件）
  assert.throws(() => updateParameterWidget(p, { name: 'kw', width: 0 }), /> 0/);
  assert.throws(() => updateParameterWidget(p, { name: 'kw', height: -5 }), /> 0/);
  fs.rmSync(d, { recursive: true, force: true });
});

test('update_parameter_widget 支持 label：改/删 LabelName；Label 控件改 widgetValue 文字', () => {
  const d = tmp();
  const p = path.join(d, 'label.cpt');
  createCpt(p, { rows: 3, columns: 3 });
  addParameterWidget(p, { name: 'kw', type: 'text', x: 10, y: 10, width: 100, height: 24 });
  updateParameterWidget(p, { name: 'kw', label: '产品编码' });
  let { seg } = readPanel(p);
  assert.ok(/<WidgetName name="kw"\/>\s*<LabelName name="产品编码"\/>/.test(seg), '补 LabelName');
  updateParameterWidget(p, { name: 'kw', label: '' });
  ({ seg } = readPanel(p));
  assert.ok(!/<LabelName\b/.test(seg), 'label="" 应删除标签');
  // Label 类型控件的文字在 widgetValue 里
  addParameterWidget(p, { name: 'lbl', type: 'label', defaultValue: '旧文字', x: 10, y: 50, width: 90, height: 24 });
  updateParameterWidget(p, { name: 'lbl', label: '新文字' });
  ({ seg } = readPanel(p));
  assert.ok(/<WidgetName name="lbl"\/>[\s\S]*?<widgetValue>\s*<O>\s*<!\[CDATA\[新文字\]\]>/.test(seg), 'Label 控件改 widgetValue 文字');
  fs.rmSync(d, { recursive: true, force: true });
});

test('label 生成独立可见 Label 控件（LabelName 在 Web 参数面板不渲染）', () => {
  const d = tmp();
  const p = path.join(d, 'labelwidget.cpt');
  createCpt(p, { rows: 3, columns: 3 });
  setParameterPanel(p, { title: '查询' });
  const r = addParameterWidget(p, { name: 'dept', type: 'comboBox', label: '部门', items: [{ key: 'A', value: 'A' }] });
  assert.ok(r.labelWidget && r.labelWidget.name, '返回值应带配套标签信息');
  const { seg } = readPanel(p);
  assert.match(seg, new RegExp(`<WidgetName name="${r.labelWidget.name}"/>`), '面板里应有独立 Label 控件');
  assert.match(seg, new RegExp(`<WidgetName name="${r.labelWidget.name}"/>[\\s\\S]*?<!\\[CDATA\\[部门\\]\\]>`), '标签文字=label');
  // 标签在控件左侧，且所有可见控件不重叠（按 BoundsWidget 块解析，避免 Layout 的 para WidgetName 误配）
  const all = [...seg.matchAll(/<Widget class="com\.fr\.form\.ui\.container\.WAbsoluteLayout\$BoundsWidget">([\s\S]*?)<\/Widget>/g)]
    .map((m) => {
      const nm = (m[1].match(/<WidgetName name="([^"]+)"/) || [])[1];
      const ba = m[1].match(/<BoundsAttr x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)"\/>/);
      return nm && ba ? { name: nm, x: +ba[1], y: +ba[2], w: +ba[3], h: +ba[4] } : null;
    })
    .filter(Boolean);
  const lb = all.find((b) => b.name === r.labelWidget.name);
  const ctl = all.find((b) => b.name === 'dept');
  assert.ok(lb && ctl, '标签与控件都在面板里');
  assert.ok(lb.x < ctl.x, '标签应在控件左侧');
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      assert.equal(overlaps(all[i], all[j]), false, `标签/控件不应重叠：${all[i].name} × ${all[j].name}`);
    }
  }
  fs.rmSync(d, { recursive: true, force: true });
});

test('可见标签的联动：update 改文字、rename 同步改名、delete 连带删除', () => {
  const d = tmp();
  const p = path.join(d, 'labelcycle.cpt');
  createCpt(p, { rows: 3, columns: 3 });
  addParameterWidget(p, { name: 'kw', type: 'text', label: '旧标签', x: 200, y: 10 });
  let { seg } = readPanel(p);
  assert.match(seg, /<WidgetName name="lbl_kw"\/>/, '初始配套标签');
  // update：LabelName 与可见 Label 的文字一起改
  updateParameterWidget(p, { name: 'kw', label: '新标签' });
  ({ seg } = readPanel(p));
  assert.match(seg, /<LabelName name="新标签"\/>/, '控件 LabelName 已改');
  assert.match(seg, /<WidgetName name="lbl_kw"\/>[\s\S]*?<!\[CDATA\[新标签\]\]>/, '可见标签文字已改');
  // rename：配套标签控件名 lbl_kw → lbl_kw2
  const rr = renameParameterWidget(p, { name: 'kw', newName: 'kw2' });
  assert.equal(rr.renamedLabelWidget, true, 'rename 应同步配套标签');
  ({ seg } = readPanel(p));
  assert.match(seg, /<WidgetName name="lbl_kw2"\/>/, '配套标签已改名');
  assert.doesNotMatch(seg, /<WidgetName name="lbl_kw"\/>/, '旧标签名不应残留');
  // delete：控件与配套标签一起删除
  deleteParameterWidget(p, 'kw2');
  ({ seg } = readPanel(p));
  assert.doesNotMatch(seg, /<WidgetName name="kw2"\/>/, '控件已删');
  assert.doesNotMatch(seg, /<WidgetName name="lbl_kw2"\/>/, '配套标签一并删除');
  fs.rmSync(d, { recursive: true, force: true });
});

test('validate 参数面板体检：重叠 / 空复选组 / 零尺寸以 warning 上报（不误杀官方基线）', () => {
  const d = tmp();
  const p = path.join(d, 'bad.cpt');
  createCpt(p, { rows: 3, columns: 3 });
  // 刻意重叠：显式给相同坐标（模拟旧默认 (10,10) 的行为）
  addParameterWidget(p, { name: 'a', type: 'text', x: 10, y: 10, width: 100, height: 24 });
  addParameterWidget(p, { name: 'b', type: 'text', x: 10, y: 10, width: 100, height: 24 });
  let issues = validateCpt(p).filter((i) => i.location.startsWith('参数面板'));
  assert.ok(issues.some((i) => /位置重叠/.test(i.message)), '重叠应被检出一');
  assert.ok(issues.every((i) => i.severity === 'warning'), '面板体检默认 warning（官方样本存在刻意重叠）');
  // 空复选组 + 零尺寸：直接改原始 XML 模拟外部坏文件
  const raw = fs.readFileSync(p, 'utf8');
  const fixed = raw
    .replace('<InnerWidget class="com.fr.form.ui.TextEditor">\n<WidgetName name="b"/>', '<InnerWidget class="com.fr.form.ui.CheckBoxGroup">\n<WidgetName name="b"/>')
    .replace('<innerWidget', '<innerWidget')
    .replace('<BoundsAttr x="10" y="10" width="100" height="24"/>', '<BoundsAttr x="10" y="10" width="0" height="0"/>');
  fs.writeFileSync(p, fixed, 'utf8');
  issues = validateCpt(p).filter((i) => i.location.startsWith('参数面板'));
  assert.ok(issues.some((i) => /CheckBoxGroup 没有配置任何选项/.test(i.message)), '空复选组应被检出');
  assert.ok(issues.some((i) => /尺寸非法/.test(i.message)), '零尺寸应被检出');
  fs.rmSync(d, { recursive: true, force: true });
});
