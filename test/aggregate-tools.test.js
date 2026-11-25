// test/aggregate-tools.test.js —— P1 工具增强三件套
// 1) set_widget_value：修改已有单元格控件的 widgetValue（修 Label 空文本不显示）
// 2) set_cell_widget text 参数：换控件类型时同步写显示文本
// 3) set_report_listener aggregate：同 event 的 JS 追加合并进现有 Listener（按事件类型聚合）
// 4) add_parameter_widget hidden：隐藏控件自动停靠参数面板右下边界，不占可见区域
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCpt, addCell, addParameterWidget } from '../lib/generate.js';
import { setCellWidget, setWidgetValue, setReportListener, setWebWriteJs } from '../lib/edits.js';
import { webwriteListener, reportListener, duplicateEventGroups } from '../lib/cpt.js';
import { validateCpt } from '../lib/validate.js';
import '../scripts/isolate-store.mjs'; // M123：JS 基线 store 隔离，直跑也不污染真实 store

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-agg-'));
const errCount = (p) => (validateCpt(p)).filter((x) => x.severity === 'error').length;
const dupCount = (p) => validateCpt(p).filter((x) => /事件唯一/.test(`${x.location}|${x.message}`)).length;

/** 官方结构 Listener 块（测试内自造存量散块用） */
const mkListener = (js, event = 'afterload') => `<Listener event="${event}">
<JavaScript class="com.fr.js.JavaScriptImpl">
<Parameters/>
<Content>
<![CDATA[${js}]]></Content>
</JavaScript>
</Listener>`;
/** 向容器末尾注入若干 Listener 散块（模拟设计器/外部工具落盘的存量多块） */
function injectBlocks(p, container, blocks) {
  const raw = fs.readFileSync(p, 'utf8');
  const end = raw.indexOf(`</${container}>`);
  assert.ok(end > 0, `应找到 </${container}>`);
  fs.writeFileSync(p, raw.slice(0, end) + blocks.join('\n') + '\n' + raw.slice(end));
}

/** 读单元格控件 widgetValue 的 CDATA 文本 */
const readWidgetValue = (p, col, row) => {
  const raw = fs.readFileSync(p, 'utf8');
  const cc = raw.indexOf(`<C c="${col}" r="${row}"`);
  if (cc < 0) return null;
  const ce = raw.indexOf('</C>', cc);
  const seg = raw.slice(cc, ce);
  const w = seg.indexOf('<widgetValue>');
  if (w < 0) return null;
  const seg2 = seg.slice(w);
  const cb = seg2.indexOf('<![CDATA[');
  if (cb < 0) return '';
  const cbe = seg2.indexOf(']]>', cb);
  return seg2.slice(cb + 9, cbe);
};

// ---------- 1) set_widget_value ----------

test('set_widget_value：给 Label 控件写入显示文本（修空默认值字体不显示）', () => {
  const d = tmp();
  const p = path.join(d, 'a.cpt');
  createCpt(p, { rows: 3, columns: 3 });
  addCell(p, { column: 0, row: 1, widget: 'label' }); // 默认 content 为空
  assert.equal(readWidgetValue(p, 0, 1), '', '前置：默认值为空');
  const r = setWidgetValue(p, { column: 0, row: 1, text: '生产状态' });
  assert.equal(r.action, 'set_widget_value');
  assert.equal(readWidgetValue(p, 0, 1), '生产状态');
  assert.equal(errCount(p), 0);
  fs.rmSync(d, { recursive: true, force: true });
});

test('set_widget_value：重复写入为覆盖语义（幂等），TextEditor 控件同样可用', () => {
  const d = tmp();
  const p = path.join(d, 'a.cpt');
  createCpt(p, { rows: 3, columns: 3 });
  addCell(p, { column: 1, row: 1, widget: 'text' });
  setWidgetValue(p, { column: 1, row: 1, text: '第一版' });
  setWidgetValue(p, { column: 1, row: 1, text: '第二版' });
  assert.equal(readWidgetValue(p, 1, 1), '第二版', '覆盖不追加');
  assert.equal(errCount(p), 0);
  fs.rmSync(d, { recursive: true, force: true });
});

test('set_widget_value：无控件格 / 缺参数 报错', () => {
  const d = tmp();
  const p = path.join(d, 'a.cpt');
  createCpt(p, { rows: 3, columns: 3 });
  addCell(p, { column: 0, row: 1, content: '纯文本格' }); // 存在但无 <Widget>
  assert.throws(() => setWidgetValue(p, { column: 0, row: 1, text: 'x' }), /未找到 <Widget>/);
  assert.throws(() => setWidgetValue(p, { column: 0, row: 0 }), /必须提供/);
  fs.rmSync(d, { recursive: true, force: true });
});

// ---------- 2) set_cell_widget text 参数 ----------

test('set_cell_widget：type=label + text 同步写入控件文本', () => {
  const d = tmp();
  const p = path.join(d, 'a.cpt');
  createCpt(p, { rows: 3, columns: 3 });
  addCell(p, { column: 0, row: 1, widget: 'text' });
  const r = setCellWidget(p, { column: 0, row: 1, type: 'label', text: '排产状态' });
  assert.equal(r.newClass, 'com.fr.form.ui.Label');
  assert.equal(readWidgetValue(p, 0, 1), '排产状态', '换类型时文本同步写入，不再为空');
  assert.equal(errCount(p), 0);
  fs.rmSync(d, { recursive: true, force: true });
});

// ---------- 3) set_report_listener aggregate ----------

test('set_report_listener aggregate=true：同 event JS 追加合并，不新建 Listener 块', () => {
  const d = tmp();
  const p = path.join(d, 'a.cpt');
  createCpt(p, { rows: 3, columns: 3 });
  setReportListener(p, { event: 'afterload', js: 'initPage();' });
  const r = setReportListener(p, { event: 'afterload', js: 'refreshChart();', aggregate: true });
  assert.equal(r.mode, 'append');
  const raw = fs.readFileSync(p, 'utf8');
  const count = (raw.match(/<Listener event="afterload"/g) || []).length;
  assert.equal(count, 1, '同 event 仍只有一个 Listener 块');
  const m = raw.match(/<Listener event="afterload">[\s\S]*?<Content>\s*<!\[CDATA\[([\s\S]*?)\]\]>/);
  assert.ok(m, '找到 Content');
  assert.ok(m[1].includes('initPage();'), '保留首次 JS');
  assert.ok(m[1].includes('refreshChart();'), '追加新 JS');
  assert.equal(errCount(p), 0);
  fs.rmSync(d, { recursive: true, force: true });
});

test('set_report_listener aggregate：无现有 Listener 时行为与普通写入一致', () => {
  const d = tmp();
  const p = path.join(d, 'a.cpt');
  createCpt(p, { rows: 3, columns: 3 });
  setReportListener(p, { event: 'onload', js: 'boot();', aggregate: true });
  const raw = fs.readFileSync(p, 'utf8');
  const count = (raw.match(/<Listener event="onload"/g) || []).length;
  assert.equal(count, 1, '新建了一个 Listener');
  assert.ok(raw.includes('boot();'));
  assert.equal(errCount(p), 0);
  fs.rmSync(d, { recursive: true, force: true });
});

// ---------- 3b) JS 合并约定：同容器内相同事件类型的 JS 只允许一个 <Listener> 代码块 ----------

test('JS 合并约定：set_webwrite_js aggregate 把同 event 散块并回一个代码块（不丢内容）', () => {
  const d = tmp();
  const p = path.join(d, 'a.cpt');
  createCpt(p, { rows: 2, columns: 2, webWrite: true });
  injectBlocks(p, 'WebWriteContent', [
    mkListener('function frFin() { return 1; } // frFin'),
    mkListener('function legacyCalc() { return 2; } // legacy'),
    mkListener('function diag() { return 3; } // 诊断'),
  ]);
  assert.equal(webwriteListener(p, { event: 'afterload' }).count, 3, '预置 3 个 afterload');
  assert.equal(dupCount(p), 1, '合并前应报「事件唯一」');
  const r = setWebWriteJs(p, { event: 'afterload', aggregate: true }); // 不传 js = 只合并，不删除
  assert.equal(r.mode, 'merge');
  assert.equal(r.mergedBlocks, 3);
  assert.equal(webwriteListener(p, { event: 'afterload' }).count, 1, '并为一个 Listener 块');
  const js = webwriteListener(p, { event: 'afterload' }).listeners[0].js;
  assert.ok(js.includes('frFin') && js.includes('legacyCalc') && js.includes('诊断'), `三块 JS 全部保留：${js}`);
  assert.equal(dupCount(p), 0, '合并后不再报「事件唯一」');
  assert.equal(errCount(p), 0);
  fs.rmSync(d, { recursive: true, force: true });
});

test('JS 合并约定：set_webwrite_js aggregate 追加新 JS（mode=append，块数不变）', () => {
  const d = tmp();
  const p = path.join(d, 'a.cpt');
  createCpt(p, { rows: 2, columns: 2, webWrite: true });
  setWebWriteJs(p, { event: 'afterappend', js: 'var first = 1;' });
  const r = setWebWriteJs(p, { event: 'afterappend', js: 'var second = 2;', aggregate: true });
  assert.equal(r.mode, 'append');
  assert.equal(webwriteListener(p, { event: 'afterappend' }).count, 1, '仍只有一个块');
  const js = webwriteListener(p, { event: 'afterappend' }).listeners[0].js;
  assert.ok(js.includes('first') && js.includes('second'), `旧 JS 保留、新 JS 追加：${js}`);
  fs.rmSync(d, { recursive: true, force: true });
});

test('JS 合并约定：set_report_listener aggregate 把报表级同 event 散块并回一个代码块', () => {
  const d = tmp();
  const p = path.join(d, 'a.cpt');
  createCpt(p, { rows: 2, columns: 2 });
  setReportListener(p, { event: 'afterload', js: 'function A() { return 1; } // A块' });
  injectBlocks(p, 'Report', [
    mkListener('function B() { return 2; } // B块'),
    mkListener('function C() { return 3; } // C块'),
  ]);
  assert.equal(reportListener(p, { event: 'afterload' }).count, 3, '预置 3 块');
  const r = setReportListener(p, { event: 'afterload', aggregate: true, js: 'function D() { return 4; } // D块' });
  assert.equal(r.mode, 'merge');
  assert.equal(r.mergedBlocks, 3);
  assert.equal(reportListener(p, { event: 'afterload' }).count, 1, '并为一个块');
  const js = reportListener(p, { event: 'afterload' }).listeners[0].js;
  for (const tag of ['A块', 'B块', 'C块', 'D块']) assert.ok(js.includes(tag), `保留 ${tag}：${js}`);
  assert.equal(dupCount(p), 0, '合并后不再报「事件唯一」');
  fs.rmSync(d, { recursive: true, force: true });
});

test('JS 合并约定：跨容器不合并（报表事件与填报事件各自唯一即合规）', () => {
  const d = tmp();
  const p = path.join(d, 'a.cpt');
  createCpt(p, { rows: 2, columns: 2, webWrite: true });
  setWebWriteJs(p, { event: 'afterload', js: 'webWriteJs();' });
  setReportListener(p, { event: 'afterload', js: 'reportJs();' });
  assert.equal(webwriteListener(p, { event: 'afterload' }).count, 1);
  assert.equal(reportListener(p, { event: 'afterload' }).count, 1);
  assert.deepEqual(duplicateEventGroups(p), [], '不同容器各自唯一，不要求合并');
  // webwrite aggregate 只合并 WebWriteContent 内的块，不吞报表块
  const r = setWebWriteJs(p, { event: 'afterload', js: 'webWriteJs2();', aggregate: true });
  assert.equal(r.mode, 'append');
  assert.equal(reportListener(p, { event: 'afterload' }).count, 1, '报表块不被 webwrite 合并吞掉');
  const wj = webwriteListener(p, { event: 'afterload' }).listeners[0].js;
  assert.ok(wj.includes('webWriteJs();') && wj.includes('webWriteJs2();'), `只追加填报块：${wj}`);
  fs.rmSync(d, { recursive: true, force: true });
});

test('JS 合并约定：不带 aggregate 时同 event 多块仍拒绝（防误删不变），提示给出 aggregate 路径', () => {
  const d = tmp();
  const p = path.join(d, 'a.cpt');
  createCpt(p, { rows: 2, columns: 2, webWrite: true });
  injectBlocks(p, 'WebWriteContent', [mkListener('var a = 1;'), mkListener('var b = 2;')]);
  assert.equal(webwriteListener(p, { event: 'afterload' }).count, 2, '预置 2 块');
  assert.throws(() => setWebWriteJs(p, { event: 'afterload', js: 'x();' }), /aggregate=true/, '拒绝并指路合并约定');
  assert.equal(webwriteListener(p, { event: 'afterload' }).count, 2, '拒绝后块数不变');
  fs.rmSync(d, { recursive: true, force: true });
});

// ---------- 4) add_parameter_widget hidden ----------

test('add_parameter_widget hidden=true：自动停靠现有控件右下边界，不占可见区域', () => {
  const d = tmp();
  const p = path.join(d, 'a.cpt');
  createCpt(p, { rows: 3, columns: 3 });
  addParameterWidget(p, { name: 'dept', type: 'text', x: 10, y: 10, width: 100, height: 24 });
  const r = addParameterWidget(p, {
    name: 'fine_username', type: 'text', x: 10, y: 10, width: 100, height: 24, hidden: true,
  });
  // 右下边界 = 现有控件的 max(x+width), max(y+height) = (110, 34)
  assert.equal(r.x, 110, 'x 停靠右边界');
  assert.equal(r.y, 34, 'y 停靠下边界');
  assert.equal(r.hidden, true);
  const raw = fs.readFileSync(p, 'utf8');
  const m = raw.match(/<WidgetName name="fine_username"\/>[\s\S]*?<BoundsAttr x="([\d.]+)" y="([\d.]+)"/);
  assert.ok(m, 'fine_username 控件 BoundsAttr 存在');
  assert.equal(Number(m[1]), 110);
  assert.equal(Number(m[2]), 34);
  assert.equal(errCount(p), 0);
  fs.rmSync(d, { recursive: true, force: true });
});
