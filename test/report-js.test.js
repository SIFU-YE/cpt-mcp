// test/report-js.test.js —— 报表级 JS（TopJS/报表JS）与报表事件（Listener）的增改删
//
// 对照官方样本实证结构：
//   <TopJS><![CDATA[js]]></TopJS> —— 报表顶部 JS / 报表初始化 JS（页面加载时执行）
//   <Listener event="afterload"><JavaScript class="com.fr.js.JavaScriptImpl"><Content><![CDATA[js]]></Content></JavaScript></Listener>
//     （官方 demo\chart\DataVisualization\IOS平台年度数据报告.cpt 等样本）
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCpt, addCell } from '../lib/generate.js';
import { setReportJs, setReportListener, setWebWriteJs, setCellListener, setToolbarButtonJs, addToolbarButton, batchAddCellListeners, deleteToolbarButton, moveToolbarButton, listToolbarButtons, setFillToolbar, setToolbarButtonIcon, addCellHyperlink, deleteCellListener } from '../lib/edits.js';
import { validateCpt } from '../lib/validate.js';
import { checkReportJs } from '../lib/cpt.js';
import '../scripts/isolate-store.mjs'; // M123：JS 基线 store 隔离，直跑也不污染真实 store

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-reportjs-'));
const read = (p) => fs.readFileSync(p, 'utf8');

test('set_report_js：写入 TopJS（报表JS）且为官方 CDATA 结构', () => {
  const d = tmp();
  const p = path.join(d, 'a.cpt');
  createCpt(p, { rows: 3, columns: 3 });
  const r = setReportJs(p, { js: 'contentPane.setPage(1);', sheet: 0 });
  // 2026-11-03：写工具返回口径统一为 mode=patch|replace|delete（整块写入=replace）；
  // action 用本工具名，nodeName 保留（低层 updateReportNode 细节不再外泄）。
  assert.equal(r.action, 'set_report_js');
  assert.equal(r.nodeName, 'TopJS');
  assert.equal(r.mode, 'replace');
  assert.equal(r.jsBytesBefore, 0, '新建时无旧块，before 记 0');
  assert.equal(r.jsBytesAfter, Buffer.byteLength('contentPane.setPage(1);', 'utf8'));
  const xml = read(p);
  const i = xml.indexOf('<TopJS>');
  assert.ok(i >= 0, '应存在 <TopJS> 节点');
  assert.equal(
    xml.slice(i, i + '<TopJS><![CDATA[contentPane.setPage(1);]]></TopJS>'.length),
    '<TopJS><![CDATA[contentPane.setPage(1);]]></TopJS>'
  );
  // TopJS 应位于对应 Report 块内（</Report> 之前）
  const reportEnd = xml.lastIndexOf('</Report>');
  assert.ok(i < reportEnd, 'TopJS 应在 Report 块内');
  // 结构校验不报错
  assert.equal((validateCpt(p)).filter((x) => x.severity === 'error').length, 0);
  fs.rmSync(d, { recursive: true, force: true });
});

test('set_report_js：幂等替换与删除', () => {
  const d = tmp();
  const p = path.join(d, 'a.cpt');
  createCpt(p, { rows: 3, columns: 3 });
  setReportJs(p, { js: 'a();', sheet: 0 });
  setReportJs(p, { js: 'b();', sheet: 0 });
  let xml = read(p);
  assert.equal((xml.match(/<TopJS>/g) || []).length, 1, '重复写入只保留一个 TopJS（替换）');
  assert.ok(xml.includes('b();'), '新 JS 生效');
  assert.ok(!xml.includes('a();'), '旧 JS 被替换');
  // 删除：js 传 null
  setReportJs(p, { js: null, sheet: 0 });
  xml = read(p);
  assert.ok(!xml.includes('<TopJS>'), '删除后无 TopJS');
  fs.rmSync(d, { recursive: true, force: true });
});

test('set_report_js：包含 ]]>/脚本片段的安全拒绝与 CDATA 校验', () => {
  const d = tmp();
  const p = path.join(d, 'a.cpt');
  createCpt(p, { rows: 3, columns: 3 });
  assert.throws(() => setReportJs(p, { js: 'x]]>y', sheet: 0 }), /CDATA|拒绝/);
  fs.rmSync(d, { recursive: true, force: true });
});

test('set_report_listener：写入官方 Listener 事件结构（afterload）', () => {
  const d = tmp();
  const p = path.join(d, 'a.cpt');
  createCpt(p, { rows: 3, columns: 3 });
  const r = setReportListener(p, { event: 'afterload', js: '_g().startMarquee();', sheet: 0 });
  assert.equal(r.nodeName, 'Listener');
  const xml = read(p);
  assert.ok(xml.includes('<Listener event="afterload">'));
  assert.ok(xml.includes('com.fr.js.JavaScriptImpl'));
  assert.ok(xml.includes('_g().startMarquee();'));
  // 同一 event 幂等替换
  setReportListener(p, { event: 'afterload', js: 'b();', sheet: 0 });
  const xml2 = read(p);
  assert.equal((xml2.match(/<Listener event="afterload">/g) || []).length, 1);
  assert.ok(xml2.includes('b();'));
  // 删除
  setReportListener(p, { event: 'afterload', sheet: 0 });
  assert.ok(!read(p).includes('event="afterload"'));
  fs.rmSync(d, { recursive: true, force: true });
});

test('set_webwrite_js：写 WebWriteContent 内填报 Web 事件脚本正文（官方结构）', () => {
  const d = tmp();
  const p = path.join(d, 'a.cpt');
  // 必须含 <WebWriteContent> 的模板
  createCpt(p, { rows: 3, columns: 3, webWrite: true });
  const r = setWebWriteJs(p, { event: 'beforeimportexcel', js: 'if(fr_submitinfo.success){ FR.Msg.toast("ok"); }' });
  assert.equal(r.action, 'set_webwrite_js');
  assert.equal(r.event, 'beforeimportexcel');
  assert.equal(r.mode, 'insert');
  const xml = read(p);
  // 官方结构核对（含 <Parameters/>）
  const block = xml.slice(xml.indexOf('<Listener event="beforeimportexcel">'), xml.indexOf('</Listener>', xml.indexOf('<Listener event="beforeimportexcel">')) + 11);
  assert.ok(block.includes('<JavaScript class="com.fr.js.JavaScriptImpl">'));
  assert.ok(block.includes('<Parameters/>'), '应含官方 <Parameters/> 空参节点');
  assert.ok(block.includes('<Content>'));
  assert.ok(block.includes('fr_submitinfo.success'));
  // 位于 <WebWriteContent> 内部、而非 Report 块
  const wwc = xml.indexOf('<WebWriteContent>');
  const wwcEnd = xml.indexOf('</WebWriteContent>', wwc);
  assert.ok(wwc >= 0 && xml.indexOf('event="beforeimportexcel"') > wwc && xml.indexOf('event="beforeimportexcel"') < wwcEnd, '应在 WebWriteContent 内');
  assert.equal((validateCpt(p)).filter((x) => x.severity === 'error').length, 0);
  fs.rmSync(d, { recursive: true, force: true });
});

test('set_webwrite_js：同 event 幂等替换与删除', () => {
  const d = tmp();
  const p = path.join(d, 'a.cpt');
  createCpt(p, { rows: 3, columns: 3, webWrite: true });
  setWebWriteJs(p, { event: 'writesuccess', js: 'location.reload();' });
  setWebWriteJs(p, { event: 'writesuccess', js: 'FR.Msg.toast(1);' });
  let xml = read(p);
  assert.equal((xml.match(/<Listener event="writesuccess">/g) || []).length, 1, '同 event 只保留一个');
  assert.ok(xml.includes('FR.Msg.toast(1);'), '新 JS 生效');
  assert.ok(!xml.includes('location.reload();'), '旧 JS 被替换');
  // 删除
  setWebWriteJs(p, { event: 'writesuccess' });
  xml = read(p);
  assert.ok(!xml.includes('event="writesuccess"'));
  fs.rmSync(d, { recursive: true, force: true });
});

test('set_webwrite_js：无 WebWriteContent 时报错、js 含 CDATA 终止符被拒', () => {
  const d = tmp();
  const p = path.join(d, 'a.cpt');
  createCpt(p, { rows: 3, columns: 3 }); // 无 webWrite → 无 <WebWriteContent>
  assert.throws(() => setWebWriteJs(p, { event: 'afterappend', js: '1' }), /WebWriteContent/);
  const p2 = path.join(d, 'b.cpt');
  createCpt(p2, { rows: 3, columns: 3, webWrite: true });
  assert.throws(() => setWebWriteJs(p2, { event: 'afterappend', js: 'x]]>y' }), /CDATA|拒绝/);
  fs.rmSync(d, { recursive: true, force: true });
});

test('add_cell_listener：给单元格控件挂 Listener 事件 JS（官方 Widget 内结构）', () => {
  const d = tmp();
  const p = path.join(d, 'a.cpt');
  createCpt(p, { rows: 4, columns: 4 });
  addCell(p, { column: 2, row: 2, widget: 'submit', content: '提交' });
  const r = setCellListener(p, 2, 2, { event: 'click', js: 'contentPane.verifyAndWriteReport();' });
  assert.equal(r.action, 'set_cell_listener');
  assert.equal(r.mode, 'insert');
  const xml = read(p);
  const i = xml.indexOf('<C c="2" r="2"');
  const cell = xml.slice(i, xml.indexOf('</C>', i));
  // Listener 应落在 <Widget> 开标签之后（官方结构）
  const wi = cell.indexOf('<Widget ');
  const li = cell.indexOf('<Listener event="click">');
  assert.ok(wi >= 0 && li > wi, 'Listener 应在 Widget 内');
  assert.ok(cell.includes('<JavaScript class="com.fr.js.JavaScriptImpl">'));
  assert.ok(cell.includes('<Parameters/>'), '含官方 <Parameters/>');
  assert.ok(cell.includes('verifyAndWriteReport'));
  assert.equal((validateCpt(p)).filter((x) => x.severity === 'error').length, 0);
  fs.rmSync(d, { recursive: true, force: true });
});

test('add_cell_listener：多 event 并存、同 event 只增报错（引导改/删专用工具）', () => {
  const d = tmp();
  const p = path.join(d, 'a.cpt');
  createCpt(p, { rows: 4, columns: 4 });
  addCell(p, { column: 0, row: 0, content: '格' });
  // 普通单元格直接内嵌 Listener
  setCellListener(p, 0, 0, { event: 'click', js: 'a();' });
  setCellListener(p, 0, 0, { event: 'afteredit', js: 'b();' });
  let xml = read(p);
  assert.ok(xml.includes('event="click"') && xml.includes('event="afteredit"'), '不同 event 并存');
  // 同 event 只增：不再覆盖，报错并引导 update/delete 专用工具
  assert.throws(() => setCellListener(p, 0, 0, { event: 'click', js: 'c();' }), /update_cell_listener|delete_cell_listener/);
  xml = read(p);
  assert.equal((xml.match(/<Listener event="click">/g) || []).length, 1, '同 event 不重复追加');
  assert.ok(xml.includes('a();') && !xml.includes('c();'), '原 Listener JS 原样保留（不覆盖）');
  // 无 js 不再删除：报错引导 delete_cell_listener
  assert.throws(() => setCellListener(p, 0, 0, { event: 'afteredit' }), /delete_cell_listener/);
  xml = read(p);
  assert.ok(xml.includes('event="afteredit"'), '不传 js 不删除');
  // 删除走专用工具 delete_cell_listener
  assert.equal(deleteCellListener(p, 0, 0, { event: 'afteredit' }).action, 'delete_cell_listener');
  xml = read(p);
  assert.ok(!xml.includes('event="afteredit"'));
  fs.rmSync(d, { recursive: true, force: true });
});

test('add_cell_listener_batch：批量挂同段 stopedit JS 到多个单元格（只增，一次调用替代 N 次单格）', () => {
  const d = tmp();
  const p = path.join(d, 'a.cpt');
  createCpt(p, { rows: 8, columns: 8 });
  // 造 6 个数据格（模拟业务填报的一列输入框）
  const cells = [];
  for (let r = 1; r <= 6; r++) { addCell(p, { column: 2, row: r, widget: 'text' }); cells.push({ column: 2, row: r }); }
  const r = batchAddCellListeners(p, cells, { event: 'stopedit', js: 'editor.cellClicked();' });
  assert.equal(r.action, 'add_cell_listener_batch');
  assert.equal(r.cellCount, 6);
  assert.equal(r.inserted, 6, '6 格全部新挂');
  assert.equal(r.failed, 0);
  const xml = read(p);
  assert.equal((xml.match(/<Listener event="stopedit">/g) || []).length, 6, '恰好 6 个 stopedit Listener');
  assert.ok(xml.includes('editor.cellClicked();'));
  // 再跑一次 → 同 event 已有 Listener，全部 failed，不重复追加、不覆盖
  const r2 = batchAddCellListeners(p, cells, { event: 'stopedit', js: 'editor.cellClicked();' });
  assert.equal((read(p).match(/<Listener event="stopedit">/g) || []).length, 6, '重复执行不追加');
  assert.equal(r2.failed, 6);
  assert.equal(r2.inserted, 0);
  assert.ok(r2.results.every((x) => x.mode === 'failed'));
  // 部分格已有同 event Listener → 已有格 failed 继续，其余 insert
  addCell(p, { column: 3, row: 1, widget: 'text' });
  const extra = { column: 3, row: 1 };
  const r3 = batchAddCellListeners(p, [cells[0], extra], { event: 'stopedit', js: 'editor.cellClicked();' });
  assert.equal(r3.failed, 1, '已有 Listener 的格 failed');
  assert.equal(r3.inserted, 1, '新格仍插入');
  const xml3 = read(p);
  assert.equal((xml3.match(/<Listener event="stopedit">/g) || []).length, 7, '只新增 1 个，原有 6 个不变');
  // 不传 js → 报错（只增，删除请用 delete_cell_listener_batch）
  assert.throws(() => batchAddCellListeners(p, cells, { event: 'stopedit' }), /必须提供 js|delete_cell_listener/);
  assert.equal((validateCpt(p)).filter((x) => x.severity === 'error').length, 0);
  fs.rmSync(d, { recursive: true, force: true });
});

test('add_cell_listener_batch：参数校验（空 cells/重复坐标/非法坐标/js 必填）', () => {
  const d = tmp();
  const p = path.join(d, 'a.cpt');
  createCpt(p, { rows: 3, columns: 3 });
  assert.throws(() => batchAddCellListeners(p, [], { event: 'stopedit', js: 'x;' }), /cells 数组/);
  assert.throws(() => batchAddCellListeners(p, [{ column: 0, row: 0 }, { column: 0, row: 0 }], { event: 'click', js: 'x;' }), /坐标重复/);
  assert.throws(() => batchAddCellListeners(p, [{ column: -1, row: 0 }], { event: 'click', js: 'x;' }), /非法坐标/);
  assert.throws(() => batchAddCellListeners(p, [{ column: 0, row: 0 }], { event: '' }), /必须提供 event/);
  assert.throws(() => batchAddCellListeners(p, [{ column: 0, row: 0 }], { event: 'click' }), /必须提供 js/);
  fs.rmSync(d, { recursive: true, force: true });
});

function seedTwoAfterload(d, name = 'a.cpt') {
  // WebWriteContent 内造两个同 event 的 afterload Listener（模拟真实报表多 Listener 形态）
  const p = path.join(d, name);
  createCpt(p, { rows: 3, columns: 3, webWrite: true });
  let raw = fs.readFileSync(p, 'utf8');
  const head = '<WebWriteContent>';
  const two = head + '\n'
    + '<Listener event="afterload">\n<JavaScript class="com.fr.js.JavaScriptImpl">\n<Parameters/>\n<Content>\n<![CDATA[// 无关脚本\nvar A = 1;]]></Content>\n</JavaScript>\n</Listener>\n'
    + '<Listener event="afterload">\n<JavaScript class="com.fr.js.JavaScriptImpl">\n<Parameters/>\n<Content>\n<![CDATA[function makeRec(){ return 1; }\nvar OP_COL = 38;]]></Content>\n</JavaScript>\n</Listener>\n';
  raw = raw.replace(head, two);
  fs.writeFileSync(p, raw, 'utf8');
  return p;
}

test('set_webwrite_js：match 精确命中同 event 的多个 Listener（真实报表形态）；无 match 多块必须拒绝（M89 防误删）', () => {
  const d = tmp();
  const p = seedTwoAfterload(d);
  // M89 防误删：两个 Listener 且不传 match → 拒绝（禁止静默命中第一个——上次误删根因）
  assert.throws(() => setWebWriteJs(p, { event: 'afterload', js: 'var A = 9;' }), /有 2 个 Listener，未传 match/, '多块无 match 必须拒绝');
  // match=makeRec → 命中第二个（目标段），不动第一个
  const r = setWebWriteJs(p, { event: 'afterload', match: 'makeRec', js: 'function makeRec(sku){ return sku; }\nvar OP_COL = 40;' });
  assert.equal(r.mode, 'update');
  let xml = read(p);
  assert.ok(xml.includes('var OP_COL = 40;'), 'match 目标段被替换');
  assert.ok(xml.includes('// 无关脚本\nvar A = 1;'), '第一个 Listener 原样保留');
  assert.equal((xml.match(/<Listener event="afterload">/g) || []).length, 2, '两个 Listener 都在');
  // match 未命中 → 抛错（不静默插入）
  assert.throws(() => setWebWriteJs(p, { event: 'afterload', match: 'NO_SUCH_TOKEN', js: 'x();' }), /未找到/);
  // match 删除：删 makeRec 段，保留另一个
  setWebWriteJs(p, { event: 'afterload', match: 'makeRec' });
  xml = read(p);
  assert.equal((xml.match(/<Listener event="afterload">/g) || []).length, 1);
  assert.ok(!xml.includes('makeRec'));
  // 删到只剩 1 块后，无 match 可以正常操作（无歧义）
  const r2 = setWebWriteJs(p, { event: 'afterload', js: 'var A = 99;' });
  assert.equal(r2.mode, 'update', '单块无 match 正常替换');
  xml = read(p);
  assert.ok(xml.includes('var A = 99;'));
  fs.rmSync(d, { recursive: true, force: true });
});

function seedToolbar(d, name = 'a.cpt') {
  // create_cpt webWrite=true 已有 WebWriteContent；注入两根 CustomToolBarButton（含 Text 与 JS）
  const p = path.join(d, name);
  createCpt(p, { rows: 3, columns: 3, webWrite: true });
  let raw = fs.readFileSync(p, 'utf8');
  const head = '<WebWriteContent>';
  const tb = head + '\n<ToolBars>\n<ToolBar>\n'
    + '<Widget class="com.fr.form.ui.CustomToolBarButton">\n<WidgetAttr/>\n<Text>\n<![CDATA[上一页]]></Text>\n<IconName>\n<![CDATA[previous]]></IconName>\n<JavaScript class="com.fr.js.JavaScriptImpl">\n<Parameters/>\n<Content>\n<![CDATA[var page = goPrev();]]></Content>\n</JavaScript>\n</Widget>\n'
    + '<Widget class="com.fr.form.ui.CustomToolBarButton">\n<WidgetAttr/>\n<Text>\n<![CDATA[删除记录]]></Text>\n<IconName>\n<![CDATA[]]></IconName>\n<JavaScript class="com.fr.js.JavaScriptImpl">\n<Parameters/>\n<Content>\n<![CDATA[function makeRec(sku){ return sku; }\nvar OP_COL = 38;]]></Content>\n</JavaScript>\n</Widget>\n'
    + '</ToolBar>\n</ToolBars>\n';
  raw = raw.replace(head, tb);
  fs.writeFileSync(p, raw, 'utf8');
  return p;
}

test('set_toolbar_button_js：buttonText 精确定位工具栏按钮 JS（官方结构）', () => {
  const d = tmp();
  const p = seedToolbar(d);
  const r = setToolbarButtonJs(p, { buttonText: '删除记录', js: 'function makeRec(sku){ return sku; }\nvar OP_COL = 40;' });
  assert.equal(r.action, 'set_toolbar_button_js');
  assert.equal(r.mode, 'replace', '（2026-11-03 统一口径：整块写入=mode replace）');
  const xml = read(p);
  // 删除记录按钮 JS 已替换
  const di = xml.lastIndexOf('<Widget class="com.fr.form.ui.CustomToolBarButton">', xml.indexOf('删除记录'));
  const btnBlock = xml.slice(di, xml.indexOf('</Widget>', di));
  assert.ok(btnBlock.includes('OP_COL = 40'), '删除记录按钮 JS 已替换');
  assert.ok(!btnBlock.includes('OP_COL = 38'));
  // 上一页按钮不受影响
  const pi = xml.lastIndexOf('<Widget class="com.fr.form.ui.CustomToolBarButton">', xml.indexOf('上一页'));
  const prevBlock = xml.slice(pi, xml.indexOf('</Widget>', pi));
  assert.ok(prevBlock.includes('goPrev();'), '上一页按钮未受影响');
  // 按钮本身与结构完好
  assert.equal((xml.match(/<Widget class="com\.fr\.form\.ui\.CustomToolBarButton">/g) || []).length, 2);
  assert.equal((validateCpt(p)).filter((x) => x.severity === 'error').length, 0);
  fs.rmSync(d, { recursive: true, force: true });
});

test('set_toolbar_button_js：index/match 定位、删除 JS 保留按钮、未命中抛错', () => {
  const d = tmp();
  const p = seedToolbar(d);
  // index=0 应命中"上一页"
  setToolbarButtonJs(p, { index: 0, js: 'var page = newGo();' });
  let xml = read(p);
  assert.ok(xml.includes('newGo();') && !xml.includes('goPrev();'), 'index=0 命中第一个按钮');
  // match 命中
  setToolbarButtonJs(p, { match: 'OP_COL', js: 'var OP_COL = 41;' });
  xml = read(p);
  assert.ok(xml.includes('OP_COL = 41;'), 'match 精确定位');
  // 未命中抛错
  assert.throws(() => setToolbarButtonJs(p, { buttonText: '不存在' }), /未找到/);
  // 删除 JS：按钮保留
  const r = setToolbarButtonJs(p, { buttonText: '删除记录' });
  assert.equal(r.mode, 'delete');
  xml = read(p);
  const di = xml.lastIndexOf('<Widget class="com.fr.form.ui.CustomToolBarButton">', xml.indexOf('删除记录'));
  const btnEnd = xml.indexOf('</Widget>', di);
  const btnBlock = xml.slice(di, btnEnd);
  assert.ok(btnBlock.includes('<Text>'), '按钮仍保留');
  assert.ok(!btnBlock.includes('JavaScriptImpl'), 'JS 已删除');
  // 无定位方式抛错
  assert.throws(() => setToolbarButtonJs(p, { js: 'x();' }), /定位/);
  fs.rmSync(d, { recursive: true, force: true });
});

test('add_toolbar_button：webWrite 模板（自闭合 ToolBars）新增自定义按钮（官方结构）', () => {
  const d = tmp();
  const p = path.join(d, 'a.cpt');
  createCpt(p, { rows: 3, columns: 3, webWrite: true });
  const r = addToolbarButton(p, { buttonText: '删除记录', js: 'function makeRec(sku){ return sku; }\nvar OP_COL = 38;' });
  assert.equal(r.action, 'add_toolbar_button');
  assert.equal(r.mode, 'new-toolbars');
  const xml = read(p);
  const wwc = xml.indexOf('<WebWriteContent>');
  const tb = xml.indexOf('<ToolBars>');
  assert.ok(tb > wwc && tb < xml.indexOf('</WebWriteContent>', wwc), 'ToolBars 应落在 WebWriteContent 内');
  assert.ok(xml.indexOf('<ToolBar>') > tb, 'ToolBars → ToolBar 层级');
  // 注意：ReportWebAttr/WebPageContent 里另有一个独立的 <ToolBars/>（报表分页工具栏），
  // 只断言 WebWriteContent 区间内的自闭合 <ToolBars/> 已被展开
  const wwcSeg = xml.slice(wwc, xml.indexOf('</WebWriteContent>', wwc));
  assert.ok(!wwcSeg.includes('<ToolBars/>'), 'WebWriteContent 内的自闭合 <ToolBars/> 应被展开');
  // 按钮结构核对（官方 CustomToolBarButton 形态）
  const bi = xml.indexOf('<Widget class="com.fr.form.ui.CustomToolBarButton">');
  const btnBlock = xml.slice(bi, xml.indexOf('</Widget>', bi));
  assert.ok(btnBlock.includes('<WidgetAttr/>'), '官方 <WidgetAttr/> 形态');
  assert.ok(btnBlock.includes('<Text>\n<![CDATA[删除记录]]></Text>'), '按钮文字写入 <Text>');
  assert.ok(btnBlock.includes('<JavaScript class="com.fr.js.JavaScriptImpl">'), 'JS 以 JavaScriptImpl 写入');
  assert.ok(btnBlock.includes('<Parameters/>'), '含官方 <Parameters/>');
  assert.ok(btnBlock.includes('OP_COL = 38'));
  assert.equal((validateCpt(p)).filter((x) => x.severity === 'error').length, 0);
  fs.rmSync(d, { recursive: true, force: true });
});

test('add_toolbar_button：已存在工具栏时末尾追加、无 JS 空按钮 + set_toolbar_button_js 接力、重名报错', () => {
  const d = tmp();
  const p = seedToolbar(d); // 已有「上一页」「删除记录」两根
  // 追加第三根（不传 js → 只建空按钮，之后 set_toolbar_button_js 补 JS —— 本工具存在意义）
  const r = addToolbarButton(p, { buttonText: '导出Excel', iconName: 'print' });
  assert.equal(r.mode, 'append');
  let xml = read(p);
  assert.equal((xml.match(/<Widget class="com\.fr\.form\.ui\.CustomToolBarButton">/g) || []).length, 3);
  const last = xml.lastIndexOf('<Widget class="com.fr.form.ui.CustomToolBarButton">');
  assert.ok(last > xml.indexOf('删除记录'), '新按钮应追加在 ToolBar 末尾');
  const newBlock = xml.slice(last, xml.indexOf('</Widget>', last));
  assert.ok(newBlock.includes('导出Excel') && newBlock.includes('<IconName>\n<![CDATA[print]]></IconName>'));
  assert.ok(!newBlock.includes('JavaScriptImpl'), '空按钮不应含 JS');
  // 接力：给新按钮补 JS
  setToolbarButtonJs(p, { buttonText: '导出Excel', js: 'window.open("/export");' });
  xml = read(p);
  const ei = xml.lastIndexOf('<Widget class="com.fr.form.ui.CustomToolBarButton">', xml.indexOf('导出Excel'));
  const eb = xml.slice(ei, xml.indexOf('</Widget>', ei));
  assert.ok(eb.includes('window.open("/export")'), 'set_toolbar_button_js 接力写 JS 成功');
  // 既有按钮不受影响
  assert.equal((xml.match(/<Widget class="com\.fr\.form\.ui\.CustomToolBarButton">/g) || []).length, 3);
  // 重名报错（追加语义：同文字不重复建）
  assert.throws(() => addToolbarButton(p, { buttonText: '导出Excel' }), /已有文字为「导出Excel」/);
  assert.throws(() => addToolbarButton(p, { buttonText: '删除记录' }), /已有文字为「删除记录」/);
  assert.equal((validateCpt(p)).filter((x) => x.severity === 'error').length, 0);
  fs.rmSync(d, { recursive: true, force: true });
});

test('add_toolbar_button：无 ToolBars 自动创建、无 WebWriteContent 报错、参数校验', () => {
  const d = tmp();
  const p = path.join(d, 'a.cpt');
  createCpt(p, { rows: 3, columns: 3, webWrite: true });
  // 手动移除 WebWriteContent 内的 <ToolBars/> → 模拟无工具栏形态，应自动创建完整结构
  let raw = read(p);
  raw = raw.replace('<ToolBars/>', '');
  fs.writeFileSync(p, raw, 'utf8');
  const r = addToolbarButton(p, { buttonText: '打印' });
  assert.equal(r.mode, 'new-toolbars');
  const xml = read(p);
  assert.ok(xml.includes('<ToolBars>') && xml.includes('<ToolBar>'), '应自动创建 ToolBars/ToolBar');
  assert.ok(xml.includes('<![CDATA[打印]]>'));
  // 无 WebWriteContent（非填报模板）→ 报错
  const p2 = path.join(d, 'b.cpt');
  createCpt(p2, { rows: 3, columns: 3 }); // webWrite=false
  assert.throws(() => addToolbarButton(p2, { buttonText: 'x' }), /WebWriteContent/);
  // 参数校验：缺 buttonText / CDATA 终止符
  assert.throws(() => addToolbarButton(p, {}), /buttonText/);
  assert.throws(() => addToolbarButton(p, { buttonText: 'a]]>b' }), /CDATA|拒绝/);
  assert.equal((validateCpt(p)).filter((x) => x.severity === 'error').length, 0);
  fs.rmSync(d, { recursive: true, force: true });
});

// ---- 审查修复补测（M-3 分支覆盖 / M-2 重名归一 / L-5 CDATA 感知闭合） ----

/** 只替换 WebWriteContent 块内的 ToolBars 节点（避开 ReportWebAttr/WebPageContent 里那个独立 <ToolBars/>） */
function replaceWwcToolBarsXml(p, replacer) {
  let raw = fs.readFileSync(p, 'utf8');
  const open = raw.indexOf('<WebWriteContent>');
  const close = raw.indexOf('</WebWriteContent>', open);
  raw = raw.slice(0, open) + replacer(raw.slice(open, close)) + raw.slice(close);
  fs.writeFileSync(p, raw, 'utf8');
}

test('add_toolbar_button：自闭合 <WebWriteContent/> 展开为块并建工具栏（M-3 分支补测）', () => {
  const d = tmp();
  const p = path.join(d, 'a.cpt');
  createCpt(p, { rows: 2, columns: 2, webWrite: true });
  // 整块替换为自闭合形态
  let raw = read(p);
  const open = raw.indexOf('<WebWriteContent>');
  const close = raw.indexOf('</WebWriteContent>', open);
  raw = raw.slice(0, open) + '<WebWriteContent/>' + raw.slice(close + '</WebWriteContent>'.length);
  fs.writeFileSync(p, raw, 'utf8');
  const r = addToolbarButton(p, { buttonText: '自闭合Wwc' });
  assert.equal(r.mode, 'new-toolbars');
  const xml = read(p);
  assert.ok(xml.includes('<WebWriteContent>') && xml.includes('自闭合Wwc'), '自闭合 WebWriteContent 应展开并含按钮');
  assert.equal((validateCpt(p)).filter((x) => x.severity === 'error').length, 0);
  fs.rmSync(d, { recursive: true, force: true });
});

test('add_toolbar_button：块内自闭合 <ToolBar/> 展开为带按钮的块（M-3 分支补测）', () => {
  const d = tmp();
  const p = path.join(d, 'a.cpt');
  createCpt(p, { rows: 2, columns: 2, webWrite: true });
  replaceWwcToolBarsXml(p, (b) => b.replace('<ToolBars/>',
    '<ToolBars>\n<ToolBarManager>\n<Location>\n<Embed position="1"/>\n</Location>\n<ToolBar/>\n</ToolBarManager>\n</ToolBars>'));
  const r = addToolbarButton(p, { buttonText: '自闭合ToolBar' });
  assert.equal(r.mode, 'append');
  const xml = read(p);
  assert.ok(xml.includes('自闭合ToolBar'));
  const tbSeg = xml.slice(xml.indexOf('<ToolBars>'), xml.indexOf('</ToolBars>', xml.indexOf('<ToolBars>')));
  assert.ok(!tbSeg.includes('<ToolBar/>'), '自闭合 <ToolBar/> 应被展开');
  assert.equal((validateCpt(p)).filter((x) => x.severity === 'error').length, 0);
  fs.rmSync(d, { recursive: true, force: true });
});

test('add_toolbar_button：ToolBars 块内无 ToolBar 的退化形态自动补 ToolBar（M-3 分支补测）', () => {
  const d = tmp();
  const p = path.join(d, 'a.cpt');
  createCpt(p, { rows: 2, columns: 2, webWrite: true });
  replaceWwcToolBarsXml(p, (b) => b.replace('<ToolBars/>', '<ToolBars></ToolBars>'));
  const r = addToolbarButton(p, { buttonText: '空对' });
  assert.equal(r.mode, 'new-toolbar');
  const xml = read(p);
  assert.ok(xml.includes('<ToolBar>') && xml.includes('空对'), '应自动补 ToolBar 并放入按钮');
  assert.equal((validateCpt(p)).filter((x) => x.severity === 'error').length, 0);
  fs.rmSync(d, { recursive: true, force: true });
});

test('add_toolbar_button：重名检查归一化——纯文本 <Text> 与 CDATA 带空格也拦截（M-2 回归）', () => {
  const d = tmp();
  const p = path.join(d, 'a.cpt');
  createCpt(p, { rows: 2, columns: 2, webWrite: true });
  // 手工种两根按钮：一根纯文本 <Text>、一根 CDATA 带空格
  replaceWwcToolBarsXml(p, (b) => b.replace('<ToolBars/>',
    '<ToolBars>\n<ToolBar>\n'
    + '<Widget class="com.fr.form.ui.CustomToolBarButton">\n<WidgetAttr/>\n<Text>删除记录</Text>\n<IconName>\n<![CDATA[]]></IconName>\n</Widget>\n'
    + '<Widget class="com.fr.form.ui.CustomToolBarButton">\n<WidgetAttr/>\n<Text>\n<![CDATA[ 导出Excel ]]>' + '</Text>\n<IconName>\n<![CDATA[]]></IconName>\n</Widget>\n'
    + '</ToolBar>\n</ToolBars>'));
  // 纯文本形态重名 → 拦截（此前漏网）
  assert.throws(() => addToolbarButton(p, { buttonText: '删除记录' }), /已有文字为「删除记录」/);
  // CDATA 带空格形态重名（trim 后相同）→ 拦截（此前漏网）
  assert.throws(() => addToolbarButton(p, { buttonText: '导出Excel' }), /已有文字为「导出Excel」/);
  // 不重名 → 正常追加
  const r = addToolbarButton(p, { buttonText: '新按钮' });
  assert.equal(r.mode, 'append');
  assert.equal((validateCpt(p)).filter((x) => x.severity === 'error').length, 0);
  fs.rmSync(d, { recursive: true, force: true });
});

test('add_toolbar_button：既有按钮 JS CDATA 含字面 </ToolBar> 时追加点仍正确（L-5 回归）', () => {
  const d = tmp();
  const p = path.join(d, 'a.cpt');
  createCpt(p, { rows: 2, columns: 2, webWrite: true });
  // 种一根 JS CDATA 里含字面 </ToolBar> 的按钮（此前 blockRange 会提前闭合，插入点落进 JS）
  replaceWwcToolBarsXml(p, (b) => b.replace('<ToolBars/>',
    '<ToolBars>\n<ToolBar>\n'
    + '<Widget class="com.fr.form.ui.CustomToolBarButton">\n<WidgetAttr/>\n<Text>\n<![CDATA[怪按钮]]></Text>\n<IconName/>\n'
    + '<JavaScript class="com.fr.js.JavaScriptImpl">\n<Parameters/>\n<Content>\n<![CDATA[var s = "</ToolBar>";]]></Content>\n</JavaScript>\n</Widget>\n'
    + '</ToolBar>\n</ToolBars>'));
  const r = addToolbarButton(p, { buttonText: '正常追加' });
  assert.equal(r.mode, 'append');
  const xml = read(p);
  assert.ok(xml.includes('正常追加'), '按钮应追加成功');
  assert.ok(xml.includes('var s = "</ToolBar>";'), '既有按钮 JS 原样保留');
  assert.equal((validateCpt(p)).filter((x) => x.severity === 'error').length, 0);
  fs.rmSync(d, { recursive: true, force: true });
});
// M78 工具栏删/移：ground truth —— Excel导入插件按钮原文（sandbox6 scratch 备份实证，
// FR 设计器 plugin-com.fr.plugin.mark.excel.import.v11-1.9.3 内含同名 class 交叉验证）
const PLUGIN_EXCEL_IMPORT = `<Widget class="com.fr.plugin.excel.ui.ExcelImportButton" pluginID="com.fr.plugin.mark.excel.import.v11" plugin-version="1.9.3">
<WidgetAttr aspectRatioLocked="false" aspectRatioBackup="-1.0" description="">
<MobileBookMark useBookMark="false" bookMarkName="" frozen="false" index="-1" oldWidgetName=""/>
<PrivilegeControl/>
</WidgetAttr>
<Text>
<![CDATA[Excel导入]]></Text>
<Hotkeys>
<![CDATA[]]></Hotkeys>
<IconName>
<![CDATA[customizexcel]]></IconName>
</Widget>`;

function seedToolbarMixed(d, name = 'mix.cpt') {
  // 提交（内置）+ Excel导入（插件，字节原样）+ 分页下一页/上一页（自定义，带 JS）
  const p = path.join(d, name);
  createCpt(p, { rows: 2, columns: 2, webWrite: true });
  replaceWwcToolBarsXml(p, (b) => b.replace('<ToolBars/>',
    '<ToolBars>\n<ToolBarManager>\n<Location>\n<Embed position="1"/>\n</Location>\n<ToolBar>\n'
    + '<Widget class="com.fr.report.web.button.write.Submit">\n<WidgetAttr description="">\n<MobileBookMark useBookMark="false" bookMarkName="" frozen="false"/>\n<PrivilegeControl/>\n</WidgetAttr>\n<Text>\n<![CDATA[${i18n(\'Fine-Engine_Report_Utils_Submit\')}]]></Text>\n<IconName>\n<![CDATA[submit]]></IconName>\n<Verify failVerifySubmit="false" value="true"/>\n<Sheet onlySubmitSelect="false"/>\n</Widget>\n'
    + PLUGIN_EXCEL_IMPORT + '\n'
    + '<Widget class="com.fr.form.ui.CustomToolBarButton">\n<WidgetAttr/>\n<Text>\n<![CDATA[分页下一页]]></Text>\n<IconName/>\n<JavaScript class="com.fr.js.JavaScriptImpl">\n<Parameters/>\n<Content>\n<![CDATA[goNext();]]></Content>\n</JavaScript>\n</Widget>\n'
    + '<Widget class="com.fr.form.ui.CustomToolBarButton">\n<WidgetAttr/>\n<Text>\n<![CDATA[分页上一页]]></Text>\n<IconName/>\n<JavaScript class="com.fr.js.JavaScriptImpl">\n<Parameters/>\n<Content>\n<![CDATA[goPrev();]]></Content>\n</JavaScript>\n</Widget>\n'
    + '</ToolBar>\n</ToolBarManager>\n</ToolBars>'));
  return p;
}

const toolbarOrder = (xml) => [...xml.matchAll(/<Text>\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*<\/Text>/g)]
  .map((m) => m[1]).filter((t) => t && !t.includes('i18n'));

test('delete_toolbar_button：删单个按钮，其余字节原样保留（含插件按钮）', () => {
  const d = tmp();
  const p = seedToolbarMixed(d);
  const r = deleteToolbarButton(p, { buttonText: '分页上一页' });
  assert.equal(r.action, 'delete_toolbar_button');
  assert.equal(r.remaining, 3);
  const xml = read(p);
  assert.ok(!xml.includes('分页上一页'), '目标按钮整颗删除');
  assert.ok(xml.includes('goNext();'), '兄弟按钮 JS 原样保留');
  assert.ok(xml.includes(PLUGIN_EXCEL_IMPORT), '插件按钮字节原样保留（不重建不断言，只保字节）');
  assert.ok(xml.includes('com.fr.report.web.button.write.Submit'), '内置按钮保留');
  assert.equal((validateCpt(p)).filter((x) => x.severity === 'error').length, 0);
  // 未命中/多命中/越界
  assert.throws(() => deleteToolbarButton(p, { buttonText: '不存在' }), /未找到/);
  assert.throws(() => deleteToolbarButton(p, { index: 99 }), /越界/);
  assert.throws(() => deleteToolbarButton(p, {}), /定位方式/);
  fs.rmSync(d, { recursive: true, force: true });
});

test('move_toolbar_button：块级移动保字节，插件按钮可移至首位', () => {
  const d = tmp();
  const p = seedToolbarMixed(d);
  const before = read(p);
  const blocksBefore = [...before.matchAll(/<Widget\b[\s\S]*?<\/Widget>/g)].map((m) => m[0]).sort();
  // 分页下一页（序号 2）移到首位
  const r = moveToolbarButton(p, { buttonText: '分页下一页', to: 'first' });
  assert.equal(r.mode, 'move');
  assert.deepEqual([r.from, r.to], [2, 0]);
  const xml = read(p);
  const blocksAfter = [...xml.matchAll(/<Widget\b[\s\S]*?<\/Widget>/g)].map((m) => m[0]).sort();
  assert.deepEqual(blocksAfter, blocksBefore, '全部 Widget 块字节集合一致（只换序）');
  const order = toolbarOrder(xml);
  assert.ok(order.includes('分页下一页') && order.includes('Excel导入') && order.includes('分页上一页'));
  assert.ok(xml.indexOf('分页下一页') < xml.indexOf('Excel导入') && xml.indexOf('Excel导入') < xml.indexOf('分页上一页'), '目标按钮到首位，其余相对顺序不变');
  assert.ok(xml.includes(PLUGIN_EXCEL_IMPORT), '插件按钮原文保留');
  // 原地移动 noop；非法 to 抛错
  const noop = moveToolbarButton(p, { buttonText: '分页下一页', to: 0 });
  assert.equal(noop.mode, 'noop');
  assert.throws(() => moveToolbarButton(p, { buttonText: '分页下一页', to: 'middle' }), /to 非法/);
  assert.equal((validateCpt(p)).filter((x) => x.severity === 'error').length, 0);
  fs.rmSync(d, { recursive: true, force: true });
});

test('audit3：按钮 JS 的 CDATA 含 </Widget> 字面时删/移仍定位正确（F1）', () => {
  const d = tmp();
  const p = path.join(d, 'c.cpt');
  createCpt(p, { rows: 2, columns: 2, webWrite: true });
  replaceWwcToolBarsXml(p, (b) => b.replace('<ToolBars/>',
    '<ToolBars>\n<ToolBar>\n'
    + '<Widget class="com.fr.form.ui.CustomToolBarButton">\n<WidgetAttr/>\n<Text>\n<![CDATA[拼串按钮]]></Text>\n<IconName/>\n<JavaScript class="com.fr.js.JavaScriptImpl">\n<Parameters/>\n<Content>\n<![CDATA[var s = "</Widget><Widget>";]]></Content>\n</JavaScript>\n</Widget>\n'
    + '<Widget class="com.fr.form.ui.CustomToolBarButton">\n<WidgetAttr/>\n<Text>\n<![CDATA[无辜按钮]]></Text>\n<IconName/>\n</Widget>\n'
    + '</ToolBar>\n</ToolBars>'));
  // 删第二个：若 CDATA 干扰配对，会删错或抛错
  const r = deleteToolbarButton(p, { buttonText: '无辜按钮' });
  assert.equal(r.remaining, 1);
  const xml = read(p);
  assert.ok(xml.includes('拼串按钮') && xml.includes('</Widget><Widget>'), '含字面标签的按钮原样保留');
  assert.ok(!xml.includes('无辜按钮'));
  assert.equal((validateCpt(p)).filter((x) => x.severity === 'error').length, 0);
  fs.rmSync(d, { recursive: true, force: true });
});

test('audit3：删/移只接受按钮文字精确匹配（F2，防模糊误删）', () => {
  const d = tmp();
  const p = seedToolbarMixed(d, 'fuzzy.cpt');
  // '页码' 模糊命中 '页码跳转' 必须拒绝（此前会直接删）
  assert.throws(() => deleteToolbarButton(p, { buttonText: '分页下' }), /精确匹配/);
  assert.throws(() => moveToolbarButton(p, { buttonText: '分页下', to: 'first' }), /精确匹配/);
  // 精确命中仍可用
  const r = deleteToolbarButton(p, { buttonText: '分页下一页' });
  assert.equal(r.remaining, 3);
  fs.rmSync(d, { recursive: true, force: true });
});

test('list_toolbar_buttons：只读列举，序号/class/文字/图标/有无JS齐全', () => {
  const d = tmp();
  const p = seedToolbarMixed(d, 'list.cpt');
  const r = listToolbarButtons(p);
  assert.equal(r.action, 'list_toolbar_buttons');
  assert.equal(r.count, 4);
  assert.deepEqual(r.buttons.map((b) => b.index), [0, 1, 2, 3]);
  assert.equal(r.buttons[1].class, 'com.fr.plugin.excel.ui.ExcelImportButton');
  assert.equal(r.buttons[1].text, 'Excel导入');
  assert.equal(r.buttons[1].icon, 'customizexcel', '插件按钮图标应读回');
  assert.equal(r.buttons[1].hasJs, false);
  assert.equal(r.buttons[2].text, '分页下一页');
  assert.equal(r.buttons[2].icon, '', '新建按钮缺省图标为空');
  assert.equal(r.buttons[2].hasJs, true);
  // 写后读回对照：改图标后 list 应直接显示新名，不再靠字节增量推断
  setToolbarButtonIcon(p, { buttonText: '分页下一页', iconName: 'excel' });
  assert.equal(listToolbarButtons(p).buttons[2].icon, 'excel');
  // 只读：文件字节不变
  const before = read(p);
  listToolbarButtons(p);
  assert.equal(read(p), before);
  // 无工具栏抛错
  const d2 = tmp();
  const p2 = path.join(d2, 'plain.cpt');
  createCpt(p2, { rows: 2, columns: 2, webWrite: true });
  assert.throws(() => listToolbarButtons(p2), /无 <ToolBars>/);
  fs.rmSync(d, { recursive: true, force: true });
  fs.rmSync(d2, { recursive: true, force: true });
});

test('set_fill_toolbar：内置导入按钮与实证原文逐字节一致（M78-calibrate）', () => {
  const d = tmp();
  const p = path.join(d, 'imp.cpt');
  createCpt(p, { rows: 2, columns: 2, webWrite: true });
  const r = setFillToolbar(p, { buttons: ['submit', 'import-append', 'import-clean', 'append-row', 'delete-row'] });
  assert.equal(r.action, 'set_fill_toolbar');
  const xml = read(p);
  // ImExcelAppend 实证原文（sandbox OEM包材下单进度.cpt）：完整 WidgetAttr + Hotkeys + excel 图标
  assert.ok(xml.includes('<Widget class="com.fr.report.web.button.write.ImExcelAppend">'), '追加导入按钮存在');
  assert.ok(xml.includes('<Widget class="com.fr.report.web.button.write.ImExcelClean">'), '清空导入按钮存在');
  assert.ok(xml.includes("${i18n('Fine-Engine_Excel_Import_Append')}"), '追加导入文字为官方i18n');
  assert.ok(xml.includes("${i18n('Fine-Engine_Excel_Import_Clean')}"), '清空导入文字为官方i18n');
  assert.ok(xml.includes('aspectRatioLocked="false"'), '完整 WidgetAttr 形态（设计器识别所需）');
  assert.ok(xml.includes('<Hotkeys>'), 'Hotkeys 节点存在（实证原文结构）');
  // 与第三方插件版严格区分：不应出现 plugin.ExcelImportButton
  assert.ok(!xml.includes('com.fr.plugin.excel.ui.ExcelImportButton'), '内置导入不应混入插件版');
  assert.equal((validateCpt(p)).filter((x) => x.severity === 'error').length, 0);
  // list 交叉：5 按钮可列
  const listed = listToolbarButtons(p);
  assert.equal(listed.count, 5);
  fs.rmSync(d, { recursive: true, force: true });
});

test('set_toolbar_button_icon：改存量按钮图标，JS 与其余按钮原样保留', () => {
  const d = tmp();
  const p = seedToolbarMixed(d, 'icon.cpt');
  const r = setToolbarButtonIcon(p, { buttonText: '分页下一页', iconName: 'print' });
  assert.equal(r.action, 'set_toolbar_button_icon');
  assert.equal(r.iconName, 'print');
  const xml = read(p);
  const ni = xml.indexOf('分页下一页');
  const blkStart = xml.lastIndexOf('<Widget', ni);
  const blk = xml.slice(blkStart, xml.indexOf('</Widget>', ni));
  assert.ok(blk.includes('<![CDATA[print]]>'), '目标按钮图标已换');
  assert.ok(blk.includes('goNext();'), '目标按钮 JS 原样保留');
  assert.ok(xml.includes(PLUGIN_EXCEL_IMPORT), '插件按钮不受影响');
  // 幂等：重复设置结果一致
  const again = read(p);
  setToolbarButtonIcon(p, { buttonText: '分页下一页', iconName: 'print' });
  assert.equal(read(p), again);
  // 清图标 + 未命中抛错
  setToolbarButtonIcon(p, { buttonText: '分页下一页', iconName: '' });
  assert.ok(!read(p).includes('<![CDATA[print]]>'), '空字符串清图标');
  assert.throws(() => setToolbarButtonIcon(p, { buttonText: '不存在' }), /未找到/);
  assert.equal((validateCpt(p)).filter((x) => x.severity === 'error').length, 0);
  fs.rmSync(d, { recursive: true, force: true });
});

test('M83 check_report_js：全块扫描，缺括号这类错可定位到块', () => {
  const d = tmp();
  // 全好：工具栏2 JS + 单元格监听 + 超链script + 填报事件
  const p = seedToolbarMixed(d, 'ok.cpt');
  addCell(p, { column: 0, row: 0, content: 'A' });
  addCell(p, { column: 1, row: 0, content: 'B' });
  setCellListener(p, 0, 0, { event: 'click', js: 'goNext();' });
  addCellHyperlink(p, { column: 1, row: 0, type: 'script', script: 'sortByCol();' });
  setWebWriteJs(p, { event: 'writesuccess', js: 'afterWrite();' });
  const ok = checkReportJs(p);
  assert.equal(ok.action, 'check_report_js');
  assert.equal(ok.failed, 0);
  assert.ok(ok.blocks >= 5, `应扫到≥5块，实际${ok.blocks}`);
  assert.ok(ok.passed >= 5, `应通过≥5块，实际${ok.passed}`);
  // 坏：sandbox7 真实事故形态（try 块没闭合，catch 落单）
  const p2 = seedToolbarMixed(d, 'bad.cpt');
  const broken = 'if (jobs.length > 5) { try { if (x) { toast("批量计算"); } catch (e0) { } }';
  setToolbarButtonJs(p2, { buttonText: '分页下一页', js: broken });
  const bad = checkReportJs(p2);
  assert.equal(bad.failed, 1);
  assert.ok(bad.failures[0].location.includes('工具栏'), `定位到工具栏块：${bad.failures[0].location}`);
  assert.ok(/Unexpected token|missing/i.test(bad.failures[0].error), `报错可读：${bad.failures[0].error}`);
  fs.rmSync(d, { recursive: true, force: true });
});

test('set_report_listener 与 set_webwrite_js 隔离：报表 afterload 不误伤填报 afterload（回归）', () => {
  const d = tmp();
  const p = path.join(d, 'a.cpt');
  createCpt(p, { rows: 3, columns: 3, webWrite: true });
  // 1) 先写填报 Web 事件（落在 WebWriteContent 内）
  setWebWriteJs(p, { event: 'afterload', js: 'webWriteOld();' });
  // 2) 再写报表事件（修复后应落在 Report 块内，绝不误伤 WebWriteContent 里的填报监听）
  const r = setReportListener(p, { event: 'afterload', js: 'reportNew();' });
  assert.equal(r.nodeName, 'Listener');
  const xml = read(p);
  // 两个 afterload 并存
  assert.equal((xml.match(/<Listener event="afterload">/g) || []).length, 2, '报表与填报两个 afterload 应并存');
  assert.ok(xml.includes('webWriteOld();'), '填报监听不被误伤');
  assert.ok(xml.includes('reportNew();'), '报表监听已写入');
  // 位置隔离：webWriteOld 在 WebWriteContent 内，reportNew 在 Report 块内（WebWriteContent 之后）
  const wwc = xml.indexOf('<WebWriteContent>');
  const wwcEnd = xml.indexOf('</WebWriteContent>', wwc);
  const wwPos = xml.indexOf('webWriteOld();');
  const rpPos = xml.indexOf('reportNew();');
  assert.ok(wwPos > wwc && wwPos < wwcEnd, '填报监听在 WebWriteContent 内');
  assert.ok(rpPos > wwcEnd, '报表监听在 Report 块内（WebWriteContent 之后）');
  assert.equal((validateCpt(p)).filter((x) => x.severity === 'error').length, 0);
  fs.rmSync(d, { recursive: true, force: true });
});

test('set_report_listener match/aggregate 也限定 Report 块内，不误伤填报监听（回归）', () => {
  const d = tmp();
  const p = path.join(d, 'a.cpt');
  createCpt(p, { rows: 3, columns: 3, webWrite: true });
  setWebWriteJs(p, { event: 'afterload', js: 'webWriteOld();' });
  // Report 块内先放一个 afterload，再用 match 精确定位替换
  setReportListener(p, { event: 'afterload', js: 'reportA();' });
  setReportListener(p, { event: 'afterload', js: 'reportB();', match: 'reportA' });
  let xml = read(p);
  assert.ok(xml.includes('webWriteOld();'), '填报监听不被 match 模式误伤');
  assert.ok(xml.includes('reportB();'), 'match 命中 Report 块内的 reportA 并替换');
  assert.ok(!xml.includes('reportA();'), 'reportA 被替换');
  // aggregate 也只追加进 Report 块内的 afterload，不碰填报监听
  const ra = setReportListener(p, { event: 'afterload', js: 'reportC();', aggregate: true });
  assert.equal(ra.mode, 'append');
  xml = read(p);
  assert.equal((xml.match(/webWriteOld/g) || []).length, 1, '填报监听内容不被 aggregate 追加污染');
  assert.ok(xml.includes('reportB();') && xml.includes('reportC();'), 'Report 块内 afterload 被聚合追加');
  fs.rmSync(d, { recursive: true, force: true });
});
