// test/param-panel.test.js —— 参数面板控件增删改结构完整性
//
// 依据：sandbox4 事故复盘（实施产物-参数面板GUI复制清单-数据部财务部.md）
//  - delete_parameter_widget 旧缺陷：只删 <InnerWidget> 残留空壳 <BoundsWidget>，模板打不开
//  - add_parameter_widget 旧缺陷：新建 Layout 骨架缺官方尾部元素（NameTagModified/WidgetNameTagMap/ParamAttr）
//  - rename_parameter_widget 契约：控件名出现在四处（① WidgetName ② NameTag ③ RPA 内 Parameter 的
//    Attributes ④ MobileWidgetList 的 widgetName），漏改即绑定断裂/移动端挂空；只改 RPA 块内，
//    块外同名 Attributes（数据集参数，SQL ${X} 锚点）绝不能动。
// 官方结构（EVA经济附加值模型.cpt 等 260 例）：
//   <Layout class="...WParameterLayout"><WidgetName/><Margin/><LCAttr/>
//     <Widget class="...WAbsoluteLayout$BoundsWidget"><InnerWidget>...</InnerWidget><BoundsAttr/></Widget>...
//     <NameTagModified/><WidgetNameTagMap/><ParamAttr/></Layout>
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCpt, addParameterWidget, setParameterPanel } from '../lib/generate.js';
import { deleteParameterWidget, renameParameterWidget, updateParameterWidget } from '../lib/edits.js';
import { validateCpt } from '../lib/validate.js';
import { parameterPanel } from '../lib/cpt.js';
import '../scripts/isolate-store.mjs'; // M123：JS 基线 store 隔离，直跑也不污染真实 store

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-ppanel-'));
const readPanel = (p) => {
  const raw = fs.readFileSync(p, 'utf8');
  const s = raw.indexOf('<ReportParameterAttr>');
  const e = raw.indexOf('</ReportParameterAttr>', s);
  return { raw, seg: raw.slice(s, e) };
};
const count = (seg) => ({
  bw: (seg.match(/<Widget class="com\.fr\.form\.ui\.container\.WAbsoluteLayout\$BoundsWidget">/g) || []).length,
  inner: (seg.match(/<InnerWidget/g) || []).length,
  names: [...seg.matchAll(/<WidgetName name="([^"]+)"/g)].map((m) => m[1]),
});
// 精确空壳：BoundsWidget 块内无 InnerWidget 即为空壳
const emptyShells = (seg) => {
  const re = /<Widget class="com\.fr\.form\.ui\.container\.WAbsoluteLayout\$BoundsWidget">[\s\S]*?<\/Widget>/g;
  let m, shells = 0;
  while ((m = re.exec(seg)) !== null) if (!m[0].includes('<InnerWidget')) shells++;
  return shells;
};

test('参数面板骨架含官方尾部元素（NameTagModified/WidgetNameTagMap/ParamAttr）', () => {
  const d = tmp();
  const p = path.join(d, 'a.cpt');
  createCpt(p, { rows: 3, columns: 3 });
  setParameterPanel(p, { title: '查询' });
  const { seg } = readPanel(p);
  assert.ok(seg.includes('NameTagModified'), '骨架应含 <NameTagModified/>');
  assert.ok(seg.includes('WidgetNameTagMap'), '骨架应含 <WidgetNameTagMap/>');
  assert.ok(seg.includes('ParamAttr'), '骨架应含 <ParamAttr .../>');
  fs.rmSync(d, { recursive: true, force: true });
});

test('add_parameter_widget：增多个控件不丢 Layout 尾部', () => {
  const d = tmp();
  const p = path.join(d, 'a.cpt');
  createCpt(p, { rows: 3, columns: 3 });
  addParameterWidget(p, { name: 'kw', type: 'text', x: 10, y: 10, width: 100, height: 24 });
  addParameterWidget(p, { name: 'date', type: 'date', x: 120, y: 10, width: 100, height: 24 });
  const { seg } = readPanel(p);
  const c = count(seg);
  assert.equal(c.bw, 2, '两个 BoundsWidget');
  assert.equal(c.inner, 2, '两个 InnerWidget');
  assert.deepEqual(c.names, ['para', 'kw', 'date'], 'Layout 自身 para + 两控件');
  assert.ok(seg.includes('NameTagModified'), 'Layout 尾部保留');
  assert.equal(emptyShells(seg), 0, '无空壳');
  fs.rmSync(d, { recursive: true, force: true });
});

test('delete_parameter_widget：整块删除不留空壳（含删中间控件）', () => {
  const d = tmp();
  const p = path.join(d, 'a.cpt');
  createCpt(p, { rows: 3, columns: 3 });
  addParameterWidget(p, { name: 'kw', type: 'text', x: 10, y: 10, width: 100, height: 24 });
  addParameterWidget(p, { name: 'date', type: 'date', x: 120, y: 10, width: 100, height: 24 });
  addParameterWidget(p, { name: 'city', type: 'comboBox', x: 230, y: 10, width: 100, height: 24 });
  // 删中间
  const r = deleteParameterWidget(p, 'date');
  assert.equal(r.removed, 'bounds-widget', '整块删除模式');
  let { seg } = readPanel(p);
  let c = count(seg);
  assert.equal(c.bw, 2, '删后剩 2 个 BoundsWidget');
  assert.equal(emptyShells(seg), 0, '无空壳');
  // date 控件已删（Layout 内无其 WidgetName；同名 <Parameter> 定义仍保留属正常语义）
  const layoutSeg = seg.slice(seg.indexOf('<Layout '), seg.indexOf('</Layout>'));
  assert.ok(!layoutSeg.includes('name="date"'), 'date 控件已删');
  // 再删头
  deleteParameterWidget(p, 'kw');
  ({ seg } = readPanel(p));
  c = count(seg);
  assert.equal(c.bw, 1, '删后剩 1 个 BoundsWidget');
  assert.equal(emptyShells(seg), 0, '无空壳');
  const layoutSeg2 = seg.slice(seg.indexOf('<Layout '), seg.indexOf('</Layout>'));
  assert.ok(!layoutSeg2.includes('name="kw"') && layoutSeg2.includes('name="city"'), '仅剩 city 控件');
  // 尾部仍在
  assert.ok(seg.includes('NameTagModified'), 'Layout 尾部保留');
  // 结构校验 0 error
  assert.equal((validateCpt(p)).filter((x) => x.severity === 'error').length, 0);
  fs.rmSync(d, { recursive: true, force: true });
});

test('delete_parameter_widget：无参数面板或无此控件均报错', () => {
  const d = tmp();
  const p = path.join(d, 'a.cpt');
  createCpt(p, { rows: 3, columns: 3 });
  // 无 ReportParameterAttr
  assert.throws(() => deleteParameterWidget(p, 'nope'), /ReportParameterAttr|未找到|参数面板/);
  // 有面板但控件不存在
  setParameterPanel(p, { title: '查询' });
  assert.throws(() => deleteParameterWidget(p, 'nope'), /未找到/);
  fs.rmSync(d, { recursive: true, force: true });
});

/** 手写一份含官方四处引用 + 块外数据集同名锚点的 RPA 片段（结构对齐 EVA 样本） */
function fixture() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<WorkBook xmlVersion="20170720" releaseVersion="10.0.0">
<TableDataMap>
<TableData name="ds1" class="com.fr.data.impl.DBTableData">
<Parameters>
<Parameter><Attributes name="rate"/><O><![CDATA[1]]></O></Parameter>
</Parameters>
<Query><![CDATA[SELECT * FROM t WHERE x=\${rate}]]></Query>
</TableData>
</TableDataMap>
<ReportWebAttr><ReportAttr report_type="0"/></ReportWebAttr>
<Report>
<Parameters/>
<ReportParameterAttr>
<ParameterUI class="com.fr.form.main.parameter.FormParameterUI">
<Layout class="com.fr.form.ui.container.WParameterLayout">
<WidgetName name="para"/>
<Margin/>
<LCAttr class="com.fr.form.ui.LayoutBorderAttr"/>
<Widget class="com.fr.form.ui.container.WAbsoluteLayout$BoundsWidget">
<InnerWidget class="com.fr.form.parameter.TextField">
<WidgetName name="rate"/>
<WidgetAttr description=""/>
</InnerWidget>
<BoundsAttr x="10" y="10" width="100" height="24"/>
</Widget>
<Sorted sorted="false"/>
<MobileWidgetList><Widget widgetName="rate"/></MobileWidgetList>
<Display display="true"/>
<DelayDisplayContent delay="true"/>
<UseParamsTemplate use="false"/>
<Position position="1"/>
<Design_Width design_width="960"/>
<NameTagModified/>
<WidgetNameTagMap><NameTag name="rate" tag="利率:"/></WidgetNameTagMap>
<ParamAttr class="com.fr.report.mobile.DefaultMobileParamStyle"/>
</Layout>
<DesignAttr width="960" height="76"/>
</ParameterUI>
<Parameter><Attributes name="rate"/><O><![CDATA[0.25]]></O></Parameter>
<Background name="NullBackground"/>
</ReportParameterAttr>
<ReportWebAttr><ServerPrinter/></ReportWebAttr>
</Report>
</WorkBook>
`;
}

test('rename_parameter_widget：四位一体同步改名，块外数据集同名锚点不动', () => {
  const d = tmp();
  const p = path.join(d, 'a.cpt');
  fs.writeFileSync(p, fixture(), 'utf8');
  const r = renameParameterWidget(p, { name: 'rate', newName: 'rate2' });
  assert.equal(r.action, 'rename_parameter_widget');
  assert.equal(r.renamedParameterBinding, true, 'RPA 内报告参数绑定已改名');
  assert.equal(r.renamedNameTag, true, 'NameTag 标签映射已改名');
  assert.equal(r.renamedMobileRef, true, '移动端控件引用已改名');
  const after = fs.readFileSync(p, 'utf8');
  const s = after.indexOf('<ReportParameterAttr>');
  const e = after.indexOf('</ReportParameterAttr>', s);
  const seg = after.slice(s, e);
  assert.deepEqual([...seg.matchAll(/<WidgetName name="([^"]+)"/g)].map((m) => m[1]), ['para', 'rate2'], '控件名本体已改');
  assert.ok(seg.includes('<NameTag name="rate2" tag="利率:"/>'), 'NameTag 已改');
  assert.ok(seg.includes('<Attributes name="rate2"/>'), '参数绑定已改');
  assert.ok(seg.includes('<Widget widgetName="rate2"/>'), '移动端引用已改');
  assert.ok(!seg.includes('rate"') && !seg.includes('name="rate"'), 'RPA 内无旧名残留');
  // 块外（TableDataMap 数据集参数 + SQL ${rate}）必须原样
  const outside = after.slice(0, s) + after.slice(e);
  assert.ok(outside.includes('<Attributes name="rate"/>'), '数据集参数未动');
  assert.ok(outside.includes('x=${rate}'), 'SQL 引用未动');
  assert.ok(!outside.includes('rate2'), '块外无新名泄漏');
  // 尾部保持
  assert.ok(seg.includes('<NameTagModified/>') && seg.includes('<ParamAttr'), 'Layout 尾部保留');
  assert.equal((validateCpt(p)).filter((x) => x.severity === 'error').length, 0);
  fs.rmSync(d, { recursive: true, force: true });
});

test('rename_parameter_widget：仅缺部分引用时按实际存在报告（不臆报）', () => {
  const d = tmp();
  const p = path.join(d, 'a.cpt');
  createCpt(p, { rows: 3, columns: 3 });
  addParameterWidget(p, { name: 'kw', type: 'text', x: 10, y: 10, width: 100, height: 24 });
  const r = renameParameterWidget(p, { name: 'kw', newName: 'kw2' });
  assert.equal(r.renamedParameterBinding, true, '骨架生成的同名参数绑定也改名');
  assert.equal(r.renamedNameTag, false, '骨架无 NameTag，如实报告 false');
  assert.equal(r.renamedMobileRef, false, '骨架无 MobileWidgetList，如实报告 false');
  const after = fs.readFileSync(p, 'utf8');
  const s = after.indexOf('<ReportParameterAttr>');
  const e = after.indexOf('</ReportParameterAttr>', s);
  const seg = after.slice(s, e);
  assert.deepEqual([...seg.matchAll(/<WidgetName name="([^"]+)"/g)].map((m) => m[1]), ['para', 'kw2'], 'Layout para + 改名后控件');
  assert.ok(seg.includes('<Attributes name="kw2"/>'), '参数绑定已改');
  assert.ok(!seg.includes('name="kw"'), '无旧名残留');
  fs.rmSync(d, { recursive: true, force: true });
});

test('rename_parameter_widget：非法新名/重名/不存在/同名新旧均报错', () => {
  const d = tmp();
  const p = path.join(d, 'a.cpt');
  createCpt(p, { rows: 3, columns: 3 });
  addParameterWidget(p, { name: 'kw', type: 'text', x: 10, y: 10, width: 100, height: 24 });
  addParameterWidget(p, { name: 'date', type: 'date', x: 120, y: 10, width: 100, height: 24 });
  assert.throws(() => renameParameterWidget(p, { name: 'kw', newName: '9bad' }), /非法/);
  assert.throws(() => renameParameterWidget(p, { name: 'kw', newName: 'date' }), /已存在/);
  assert.throws(() => renameParameterWidget(p, { name: 'kw', newName: 'kw' }), /相同/);
  assert.throws(() => renameParameterWidget(p, { name: 'nope', newName: 'ok1' }), /未找到/);
  assert.throws(() => renameParameterWidget(p, {}), /必须提供 name/);
  fs.rmSync(d, { recursive: true, force: true });
});

// ---------------- M72 闭环：delete_parameter_widget 清理无引用的同名 Parameter 绑定 ----------------

test('M72：delete_parameter_widget 删除控件后同步清理孤儿同名 Parameter；共享时保留', () => {
  const d = tmp();
  const p = path.join(d, 'a.cpt');
  createCpt(p, { rows: 3, columns: 3 });
  setParameterPanel(p, { title: '查询' });
  addParameterWidget(p, { name: 'p1', type: 'text' });
  // 修复前：删控件后 <ReportParameterAttr> 内仍残留 <Parameter><Attributes name="p1"/>（死绑定）
  const r = deleteParameterWidget(p, 'p1');
  assert.equal(r.removed, 'bounds-widget');
  const panel1 = parameterPanel(p);
  assert.deepEqual(panel1.widgets, [], '控件已删');
  assert.ok(!panel1.parameters.some((x) => x.name === 'p1'), `孤儿 Parameter 应被清理: ${JSON.stringify(panel1.parameters)}`);
  const seg1 = readPanel(p).seg;
  assert.ok(!seg1.includes('<Attributes name="p1"/>'), 'RPA 内无 p1 绑定残留');
  assert.ok((validateCpt(p)).filter((x) => x.severity === 'error').length === 0, '删除后结构仍合法');
  // 共享场景：两个同名控件共享一个 Parameter —— 删一个后 Parameter 必须保留
  addParameterWidget(p, { name: 'p2', type: 'text' });
  // M117 同名防护：默认拒绝同名追加，刻意并存必须显式 allowDuplicate=true
  assert.throws(() => addParameterWidget(p, { name: 'p2', type: 'text' }), /已存在同名控件/);
  addParameterWidget(p, { name: 'p2', type: 'text', allowDuplicate: true });
  deleteParameterWidget(p, 'p2');
  const panel2 = parameterPanel(p);
  assert.equal((readPanel(p).seg.match(/<WidgetName name="p2"\/>/g) || []).length, 1, '只剩一个 p2 控件');
  assert.ok(panel2.parameters.some((x) => x.name === 'p2'), '仍有同名控件时共享 Parameter 绑定保留');
  fs.rmSync(d, { recursive: true, force: true });
});
test('M80 update_parameter_widget：不可见开关 + 默认值，读回可验收', () => {
  const d = tmp();
  const p = path.join(d, 'm80.cpt');
  createCpt(p, { rows: 3, columns: 3 });
  addParameterWidget(p, { name: 'page', type: 'text', x: 10, y: 10, width: 100, height: 24 });
  addParameterWidget(p, { name: 'q', type: 'submitButton', x: 120, y: 10, width: 80, height: 24 });
  // 前置：新建默认可见、无 invisible
  let panel = parameterPanel(p);
  assert.equal(panel.widgets.find((w) => w.name === 'page').invisible, false);
  // 藏起 page：与 OEM成品计划表.cpt 设计器形态一致
  const r1 = updateParameterWidget(p, { name: 'page', visible: false });
  assert.equal(r1.mode, 'update');
  assert.deepEqual(r1.changed, ['visible=false']);
  let { seg } = readPanel(p);
  assert.ok(seg.includes('<WidgetAttr invisible="true"'), '应写设计器 invisible 形态');
  panel = parameterPanel(p);
  assert.equal(panel.widgets.find((w) => w.name === 'page').invisible, true);
  // 重复隐藏 → none（幂等）
  assert.equal(updateParameterWidget(p, { name: 'page', visible: false }).mode, 'none');
  // 恢复可见：属性彻底移除（设计器默认未勾选态）
  updateParameterWidget(p, { name: 'page', visible: true });
  ({ seg } = readPanel(p));
  assert.ok(!seg.includes('invisible='), '恢复可见后无残留属性');
  assert.equal(parameterPanel(p).widgets.find((w) => w.name === 'page').invisible, false);
  // 默认值：文本控件可设，读回一致
  updateParameterWidget(p, { name: 'page', defaultValue: '1' });
  assert.equal(parameterPanel(p).widgets.find((w) => w.name === 'page').defaultValue, '1');
  // 查询按钮无 widgetValue → 拒绝
  assert.throws(() => updateParameterWidget(p, { name: 'q', defaultValue: 'x' }), /无 <widgetValue>/);
  // 非法输入
  assert.throws(() => updateParameterWidget(p, { name: 'nope', visible: false }), /未找到/);
  assert.throws(() => updateParameterWidget(p, { name: 'page' }), /至少传一个/);
  assert.equal(validateCpt(p).filter((i) => i.severity === 'error').length, 0);
  fs.rmSync(d, { recursive: true, force: true });
});

test('M81 面板标签字体/边框：新建可带，存量可补，输入框拒绝', () => {
  const d = tmp();
  const p = path.join(d, 'm81.cpt');
  createCpt(p, { rows: 3, columns: 3 });
  // 新建即带：与 OEM成品计划表.cpt 实证同结构
  addParameterWidget(p, { name: '成品名称', type: 'label', x: 10, y: 10, width: 100, height: 24, fontName: '微软雅黑', fontSize: 96, noBorder: true });
  addParameterWidget(p, { name: 'kw', type: 'text', x: 120, y: 10, width: 100, height: 24 });
  let { seg } = readPanel(p);
  assert.ok(seg.includes('<FRFont name="微软雅黑" style="0" size="96"/>'), '标签字体实证形态');
  assert.ok(seg.includes('<border style="0">'), '无边框实证形态');
  let panel = parameterPanel(p);
  const lbl = panel.widgets.find((w) => w.name === '成品名称');
  assert.equal(lbl.fontName, '微软雅黑');
  assert.equal(lbl.fontSize, 96);
  assert.equal(lbl.borderStyle, 0);
  // 新建时往输入框加字体 → 拒绝（臆造形态设防）
  assert.throws(() => addParameterWidget(p, { name: 'bad', type: 'text', fontName: '微软雅黑' }), /只支持 type="label"/);
  // 存量补：删字体/边框后补回
  let raw = fs.readFileSync(p, 'utf8');
  raw = raw.replace('<FRFont name="微软雅黑" style="0" size="96"/>', '').replace(/<border style="0">[\s\S]*?<\/border>/, '');
  fs.writeFileSync(p, raw);
  const r = updateParameterWidget(p, { name: '成品名称', fontName: '微软雅黑', fontSize: 96, noBorder: true });
  assert.equal(r.mode, 'update');
  assert.deepEqual(r.changed, ['font=微软雅黑/96', 'border=none']);
  ({ seg } = readPanel(p));
  assert.ok(seg.includes('<FRFont name="微软雅黑" style="0" size="96"/>'), '补回字体');
  assert.ok(seg.includes('<border style="0">'), '补回边框');
  // 输入框补字体 → 拒绝
  assert.throws(() => updateParameterWidget(p, { name: 'kw', fontName: '微软雅黑' }), /只支持 Label/);
  assert.equal(validateCpt(p).filter((i) => i.severity === 'error').length, 0);
  fs.rmSync(d, { recursive: true, force: true });
});

test('M84 update_parameter_widget：公式值类型 + 坐标（不污染字典）', () => {
  const d = tmp();
  const p = path.join(d, 'm84.cpt');
  createCpt(p, { rows: 3, columns: 3 });
  addParameterWidget(p, { name: 'p_start', type: 'date', x: 10, y: 10, width: 100, height: 24 });
  addParameterWidget(p, { name: 'p_correct', type: 'comboBox', items: [{ key: '全部', value: '全部' }, { key: '正确', value: '正确' }], x: 20, y: 10, width: 100, height: 24 });
  // 1) 公式类型：valueType=formula，公式内容 ""（空字符串表达式，不带 = 前缀）
  const r1 = updateParameterWidget(p, { name: 'p_start', defaultValue: '""', valueType: 'formula' });
  assert.equal(r1.mode, 'update');
  assert.deepEqual(r1.changed, ['valueType=formula']);
  let seg = readPanel(p).seg;
  assert.ok(seg.includes('<O t="XMLable" class="com.fr.base.Formula">'), '公式类型 O 形态');
  assert.ok(seg.includes('<![CDATA[""]]>'), '公式内容 "" 原样写入');
  // 2) 坐标：x/y 改 BoundsAttr，字典不受影响
  const r2 = updateParameterWidget(p, { name: 'p_correct', x: 210, y: 42 });
  assert.equal(r2.mode, 'update');
  assert.ok(r2.changed.some((c) => c === 'pos=210,42'), `changed 含 pos：${JSON.stringify(r2.changed)}`);
  seg = readPanel(p).seg;
  assert.ok(seg.includes('x="210"'), 'x 已改 210');
  assert.ok(seg.includes('y="42"'), 'y 已改 42');
  assert.ok(seg.includes('key="全部"') && seg.includes('key="正确"'), 'CustomDictionary 字典未被污染');
  // 3) 只改坐标、不传 defaultValue 时，widgetValue 不动
  assert.equal((seg.match(/com\.fr\.base\.Formula/g) || []).length, 1, '公式 O 只一个（坐标调用未碰 widgetValue）');
  // 4) 非法坐标拒绝
  assert.throws(() => updateParameterWidget(p, { name: 'p_correct', x: 'abc' }), /x 非法/);
  assert.equal(validateCpt(p).filter((i) => i.severity === 'error').length, 0);
  fs.rmSync(d, { recursive: true, force: true });
});

test('M84 set_parameter_panel：delayPlaying 打开即查询（且不清控件）', () => {
  const d = tmp();
  const p = path.join(d, 'm84b.cpt');
  createCpt(p, { rows: 3, columns: 3 });
  setParameterPanel(p, { title: '查询' });
  addParameterWidget(p, { name: 'kw', type: 'text', x: 10, y: 10, width: 100, height: 24 });
  // delayPlaying=false → 打开即查
  setParameterPanel(p, { delayPlaying: false });
  let raw = fs.readFileSync(p, 'utf8');
  const attrs0 = raw.match(/<Attributes [^>]*>/)[0];
  assert.ok(attrs0.includes('delayPlaying="false"'), 'delayPlaying=false 已写');
  // 控件未被清掉（不是整块替换）
  assert.ok(raw.includes('name="kw"'), '控件 kw 仍在（upsert 非整块替换）');
  // delayPlaying=true → 首屏空白等点查询
  setParameterPanel(p, { delayPlaying: true });
  raw = fs.readFileSync(p, 'utf8');
  assert.ok(raw.match(/<Attributes [^>]*>/)[0].includes('delayPlaying="true"'), 'delayPlaying=true 已写');
  assert.equal(validateCpt(p).filter((i) => i.severity === 'error').length, 0);
  fs.rmSync(d, { recursive: true, force: true });
});

test('M85 add_parameter_widget：comboCheckBox 下拉多选（db 字典 + 返回值字符串逗号分隔）', () => {
  const d = tmp();
  const p = path.join(d, 'm85.cpt');
  createCpt(p, { rows: 3, columns: 3 });
  setParameterPanel(p, { title: '查询' });
  // 用户场景：p_dept 文本框 → 下拉多选，字典连 Doris 表列，返回值=字符串、分隔符 ','
  const r = addParameterWidget(p, {
    name: 'p_dept', type: 'comboCheckBox',
    label: '部门',
    dictionary: { type: 'db', connection: 'Doris', table: 'bi_ads.ads_formula_archiving_follow_main', kiName: 'apply_dept', viName: 'apply_dept' },
    x: 10, y: 10, width: 120, height: 24,
  });
  assert.equal(r.action, 'add_parameter_widget');
  assert.equal(r.type, 'comboCheckBox');
  const { seg } = readPanel(p);
  assert.ok(seg.includes('com.fr.form.ui.ComboCheckBox'), 'InnerWidget 类为 ComboCheckBox');
  assert.ok(seg.includes('<RAAttr delimiter="&apos;,&apos;" isArray="false"/>'), '返回值字符串+逗号分隔（RAAttr 实证形态）');
  assert.ok(seg.includes('com.fr.data.impl.DatabaseDictionary'), 'db 字典类');
  assert.ok(seg.includes('bi_ads.ads_formula_archiving_follow_main'), '表名写入 DBDictAttr');
  assert.ok(seg.includes('<![CDATA[Doris]]>'), '连接名 Doris 写入');
  assert.ok(seg.includes('kiName="apply_dept"') && seg.includes('viName="apply_dept"'), '实际值/显示值列 apply_dept');
  assert.ok(seg.includes('name="p_dept"'), '控件名 p_dept');
  // 同名 Parameter 自动绑定
  assert.ok(seg.includes('<Attributes name="p_dept"/>'), '同名参数绑定已追加');
  // 可被 get_parameter_panel 读回
  const panel = parameterPanel(p);
  const w = panel.widgets.find((x) => x.name === 'p_dept');
  assert.ok(w, 'parameterPanel 能读回控件');
  assert.ok(String(w.class || '').includes('ComboCheckBox'), '读回类名 ComboCheckBox');
  assert.equal(validateCpt(p).filter((i) => i.severity === 'error').length, 0);
  fs.rmSync(d, { recursive: true, force: true });
});

test('M85 完整转换流程：文本框 → 下拉多选（删旧建新 + 打开即查）', () => {
  const d = tmp();
  const p = path.join(d, 'm85b.cpt');
  createCpt(p, { rows: 3, columns: 3 });
  setParameterPanel(p, { title: '查询' });
  // 旧：文本框控件（用户现状 p_dept/p_no/p_bcp/p_code 为文本框）
  addParameterWidget(p, { name: 'p_dept', type: 'text', x: 10, y: 10, width: 100, height: 24 });
  // 1) 删旧文本框
  const del = deleteParameterWidget(p, 'p_dept');
  assert.equal(del.action, 'delete_parameter_widget');
  // 2) 建新下拉多选（同名自动绑定）
  addParameterWidget(p, {
    name: 'p_dept', type: 'comboCheckBox',
    dictionary: { type: 'db', connection: 'Doris', table: 'bi_ads.ads_formula_archiving_follow_main', kiName: 'apply_dept', viName: 'apply_dept' },
    x: 10, y: 10, width: 120, height: 24,
  });
  // 3) 取消「点击查询前不显示报表内容」= delayPlaying=false 打开即查
  setParameterPanel(p, { delayPlaying: false });
  let raw = fs.readFileSync(p, 'utf8');
  const attrs0 = raw.match(/<Attributes [^>]*>/)[0];
  assert.ok(attrs0.includes('delayPlaying="false"'), 'delayPlaying=false 打开即查');
  const { seg } = readPanel(p);
  assert.ok(seg.includes('com.fr.form.ui.ComboCheckBox'), '已是下拉多选');
  assert.ok(!/TextEditor/.test(seg), '文本框控件已删除');
  // 控件名 p_dept 在面板中唯一（无残留旧控件空壳）
  assert.equal((seg.match(/<WidgetName name="p_dept"\/>/g) || []).length, 1, '控件名唯一');
  assert.equal(validateCpt(p).filter((i) => i.severity === 'error').length, 0);
  fs.rmSync(d, { recursive: true, force: true });
});
