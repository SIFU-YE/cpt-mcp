// test/hyperlink.test.js —— 单元格超级链接 / JS 事件
//
// 逆向依据（官方 1559 个 .cpt 样本实证）：
//   <C> 内顺序：O → PrivilegeControl → NameJavaScriptGroup → HighlightList → Expand
//     （148 例 NameJS 在 Expand 之前，136 例在 HighlightList 之前）
//   JavaScript class 频次：ParameterJavaScript(660) / JavaScriptImpl(555)
//     / ReportletHyperlink(110) / WebHyperlink(17) / Commit2DBJavaScript(17) / EmailJavaScript(1)
//   ReportletHyperlink 与 WebHyperlink 实测 122 例全部为双层同名标签；
//     JavaScriptImpl 实测 555 例全部为单层 —— 两种形态不同是既成事实，照抄不推断成因。
//   TargetFrame 取值仅 _blank(82) / _self(48) / _dialog(23)
//   Features 默认 width="600" height="400"（118 例）
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCpt, addCell, addSheet } from '../lib/generate.js';
import { addCellHyperlink, addCellHighlight } from '../lib/edits.js';
import { validateCpt } from '../lib/validate.js';
import '../scripts/isolate-store.mjs'; // M123：JS 基线 store 隔离，直跑也不污染真实 store

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-link-'));
const read = (p) => fs.readFileSync(p, 'utf8');
const errCount = (p) => (validateCpt(p)).filter((i) => i.severity === 'error').length;

function seed() {
  const d = tmp();
  const p = path.join(d, 'a.cpt');
  createCpt(p, { rows: 4, columns: 3 });
  addCell(p, { column: 0, row: 1, content: '详情' });
  addCell(p, { column: 1, row: 1, content: '帮助' });
  addCell(p, { column: 2, row: 1, content: '删除' });
  return { d, p };
}
const cellXml = (xml, c) => {
  const s = xml.indexOf(`<C c="${c}" r="1"`);
  return xml.slice(s, xml.indexOf('</C>', s));
};

test('跳转报表：ReportletHyperlink 双层标签 + 目标路径', () => {
  const { d, p } = seed();
  const r = addCellHyperlink(p, {
    column: 0, row: 1, type: 'reportlet',
    reportletPath: '/demo/basic/产品明细.cpt',
  });
  assert.equal(r.action, 'add_cell_hyperlink');
  assert.equal(r.type, 'reportlet');
  assert.equal(r.eventCount, 1);

  const seg = cellXml(read(p), 0);
  // 双层同名标签（官方 122 例一致）
  assert.equal((seg.match(/<JavaScript class="com\.fr\.js\.ReportletHyperlink">/g) || []).length, 2);
  assert.match(seg, /<NameJavaScriptGroup>/);
  assert.match(seg, /<NameJavaScript name="网络报表1">/);
  assert.match(seg, /<ReportletName showPI="true">/);
  assert.match(seg, /<!\[CDATA\[\/demo\/basic\/产品明细\.cpt\]\]>/);
  assert.match(seg, /<!\[CDATA\[_blank\]\]>/, '默认 _blank');
  assert.match(seg, /<Features width="600" height="400"\/>/, '官方默认 600×400');
  assert.match(seg, /<DialogAttr class="com\.fr\.js\.ReportletHyperlinkDialogAttr">/);
  assert.equal(errCount(p), 0);
  fs.rmSync(d, { recursive: true, force: true });
});

test('跳转报表传参：公式值走 XMLable Formula，固定值走裸 <O>', () => {
  const { d, p } = seed();
  addCellHyperlink(p, {
    column: 0, row: 1, type: 'reportlet',
    reportletPath: '/detail.cpt',
    params: { 订单号: '=A3', type: 'detail' },
    post: true,
  });
  const seg = cellXml(read(p), 0);
  assert.match(seg, /<Attributes name="订单号"\/>\s*<O t="XMLable" class="com\.fr\.base\.Formula">/);
  assert.match(seg, /<!\[CDATA\[=A3\]\]>/);
  assert.match(seg, /<Attributes name="type"\/>\s*<O>\s*<!\[CDATA\[detail\]\]>\s*<\/O>/);
  assert.match(seg, /<ReportletName showPI="true" byPost="true">/, 'post=true → byPost');
  assert.equal(errCount(p), 0);
  fs.rmSync(d, { recursive: true, force: true });
});

test('无参数时 Parameters 自闭合（官方样例形态）', () => {
  const { d, p } = seed();
  addCellHyperlink(p, { column: 0, row: 1, type: 'reportlet', reportletPath: '/x.cpt' });
  assert.match(cellXml(read(p), 0), /<Parameters\/>/);
  fs.rmSync(d, { recursive: true, force: true });
});

test('跳转网页：WebHyperlink + URL', () => {
  const { d, p } = seed();
  const r = addCellHyperlink(p, {
    column: 1, row: 1, type: 'url',
    url: 'https://help.finereport.com/doc-view-865.html',
    target: '_dialog', width: 800, height: 600,
  });
  assert.equal(r.type, 'url');
  const seg = cellXml(read(p), 1);
  assert.equal((seg.match(/<JavaScript class="com\.fr\.js\.WebHyperlink">/g) || []).length, 2, '同样双层');
  assert.match(seg, /<URL>\s*<!\[CDATA\[https:\/\/help\.finereport\.com\/doc-view-865\.html\]\]>\s*<\/URL>/);
  assert.match(seg, /<!\[CDATA\[_dialog\]\]>/);
  assert.match(seg, /<Features width="800" height="600"\/>/);
  assert.equal(errCount(p), 0);
  fs.rmSync(d, { recursive: true, force: true });
});

test('自定义脚本：JavaScriptImpl 单层 + Content', () => {
  const { d, p } = seed();
  addCellHyperlink(p, {
    column: 2, row: 1, type: 'script',
    script: 'FR.Msg.confirm("警告", "确定要删除吗？");',
    name: '删除确认',
  });
  const seg = cellXml(read(p), 2);
  assert.equal((seg.match(/<JavaScript class="com\.fr\.js\.JavaScriptImpl">/g) || []).length, 1, '单层（官方 555 例一致）');
  assert.match(seg, /<Content>\s*<!\[CDATA\[FR\.Msg\.confirm/);
  assert.match(seg, /<NameJavaScript name="删除确认">/);
  assert.equal(errCount(p), 0);
  fs.rmSync(d, { recursive: true, force: true });
});

test('位置正确：NameJavaScriptGroup 在 HighlightList 之前、Expand 之前', () => {
  const { d, p } = seed();
  // 先加高亮再加链接：链接应插到 HighlightList 之前
  addCellHighlight(p, { column: 0, row: 1, formula: '$$$ < 0', fontColor: '#FF0000' });
  addCellHyperlink(p, { column: 0, row: 1, type: 'url', url: 'https://a.com' });
  const seg = cellXml(read(p), 0);
  assert.ok(seg.indexOf('<NameJavaScriptGroup>') < seg.indexOf('<HighlightList>'), '应在 HighlightList 之前');
  assert.ok(seg.indexOf('<HighlightList>') < seg.indexOf('<Expand'), 'HighlightList 应在 Expand 之前');
  assert.ok(seg.indexOf('<PrivilegeControl/>') < seg.indexOf('<NameJavaScriptGroup>'), '应在 PrivilegeControl 之后');
  assert.equal(errCount(p), 0);
  fs.rmSync(d, { recursive: true, force: true });
});

test('一个单元格可挂多个事件，编号递增', () => {
  const { d, p } = seed();
  addCellHyperlink(p, { column: 0, row: 1, type: 'url', url: 'https://a.com' });
  const r2 = addCellHyperlink(p, { column: 0, row: 1, type: 'url', url: 'https://b.com' });
  assert.equal(r2.eventCount, 2);
  const seg = cellXml(read(p), 0);
  assert.equal((seg.match(/<NameJavaScriptGroup>/g) || []).length, 1, '不应出现两个容器');
  assert.equal((seg.match(/<NameJavaScript /g) || []).length, 2);
  assert.match(seg, /网页链接1/);
  assert.match(seg, /网页链接2/);
  assert.equal(errCount(p), 0);
  fs.rmSync(d, { recursive: true, force: true });
});

test('安全围栏：非法输入被引导性拒绝', () => {
  const { d, p } = seed();
  // 缺 type
  assert.throws(
    () => addCellHyperlink(p, { column: 0, row: 1, url: 'https://a.com' }),
    /type="undefined" 不支持/
  );
  // reportlet 缺路径
  assert.throws(
    () => addCellHyperlink(p, { column: 0, row: 1, type: 'reportlet' }),
    /reportletPath/
  );
  // url 缺网址
  assert.throws(
    () => addCellHyperlink(p, { column: 0, row: 1, type: 'url' }),
    /必须给 url/
  );
  // script 缺代码
  assert.throws(
    () => addCellHyperlink(p, { column: 0, row: 1, type: 'script' }),
    /必须给 script/
  );
  // 非法 target
  assert.throws(
    () => addCellHyperlink(p, { column: 0, row: 1, type: 'url', url: 'https://a.com', target: '_new' }),
    /target="_new" 非法/
  );
  // 缺坐标
  assert.throws(
    () => addCellHyperlink(p, { type: 'url', url: 'https://a.com' }),
    /column 与 row/
  );
  fs.rmSync(d, { recursive: true, force: true });
});

test('addCellHyperlink 支持 sheet：在第 2 个表写超链，落点独立于第 1 个表', () => {
  const d = tmp();
  const p = path.join(d, 'multi.cpt');
  createCpt(p, { rows: 3, columns: 3 });
  addCell(p, { column: 0, row: 0, content: 'H0', sheet: 0 });
  addSheet(p, { sheetName: '成品表' });
  addCell(p, { column: 0, row: 0, content: 'H1', sheet: 1 });
  addCellHyperlink(p, { column: 0, row: 0, type: 'script', script: 'sortSheet2()', sheet: 1 });
  const raw = read(p);
  const reports = raw.split('</Report>');
  assert.equal(reports.length - 1, 2, '应有两个 Report 块');
  assert.ok(!reports[0].includes('sortSheet2()'), '第 1 个表不应被污染');
  assert.ok(reports[1].includes('sortSheet2()'), '超链应落在第 2 个 Report 块');
  assert.equal(errCount(p), 0);
  fs.rmSync(d, { recursive: true, force: true });
});

