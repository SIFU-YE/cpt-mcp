// test/js-blocks-template-webattr.test.js —— C-A：模板级 ReportWebAttr 容器里的 JS 必须可见
//
// 【缺陷证据·2026-11-03 会话审计】真实模板 sandbox4/V3「产品活动-业务部负责人审批V3.cpt」里
// `<JavaScript class="com.fr.js.JavaScriptImpl">` 原始节点共 6 个：5 个 Listener（1 个在模板级
// <ReportWebAttr><WebPageContent> 内，4 个在 <ReportWebAttr><WebWriteContent> 内）+ 1 个工具栏按钮 JS。
// 用当时的 check_report_js 实测只报 blocks=5（4 填报事件 + 1 工具栏），漏掉的正是模板级 WebPageContent
// 里的分页预览 afterload —— 模型据此误判"工具解析不了工具栏按钮 JS"，js-baseline 也没有 webpg:@workbook
// 分类，整块丢失时门禁看不见。
//
// 根因：lib/cpt.js jsBlocks 只读 report.WebPageContent（Report 子级），而 FR 11 的真实落点是
// WorkBook 级 <ReportWebAttr><WebPageContent>（官方 1550 份语料实测：WebPageContent 528 份 / 50 份挂
// Listener，WebViewContent 63 份 / 3 份挂 Listener，Report 子级 WebPageContent 0 例）。
// 写侧 lib/edits.js 的 locateToolbarHost 早已支持模板级三种宿主（write/page/view），解析层却漏扫 ——
// 本文件把"读/扫/基线三处口径一致"钉死。
//
// 测试用 fixture 全部由 create_cpt 骨架 + 原文插入生成（不依赖本机 sandbox 路径，可离线复现）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCpt } from '../lib/generate.js';
import { checkReportJs, jsBlocks } from '../lib/cpt.js';
import { snapshotJsCounts } from '../lib/js-baseline.js';
import { load } from '../lib/xml.js';
import { validateCpt } from '../lib/validate.js';
import '../scripts/isolate-store.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-jsblk-tpl-'));
const read = (p) => fs.readFileSync(p, 'utf8');

const listenerXml = (event, js) => `<Listener event="${event}"><JavaScript class="com.fr.js.JavaScriptImpl">`
  + `<Parameters/><Content><![CDATA[${js}]]></Content></JavaScript></Listener>`;

/** 往 create_cpt 已有的模板级 <WebPageContent> 里插子节点（真实落点：ReportWebAttr 内） */
function insertIntoWbPage(p, xml) {
  const raw = read(p);
  const open = raw.indexOf('<WebPageContent>');
  const close = raw.indexOf('</WebPageContent>', open);
  assert.ok(open > 0 && close > open, 'create_cpt 骨架应含模板级 WebPageContent');
  fs.writeFileSync(p, raw.slice(0, close) + xml + raw.slice(close));
}

/** 往 ReportWebAttr 末尾插一个容器的标准块（WebViewContent 是 create_cpt 不生成的兼容形态） */
function insertIntoTemplateWebAttr(p, xml) {
  const raw = read(p);
  const at = raw.indexOf('</ReportWebAttr>');
  assert.ok(at > 0, 'create_cpt 骨架应含模板级 ReportWebAttr');
  fs.writeFileSync(p, raw.slice(0, at) + xml + raw.slice(at));
}

/** 把模板级 WebPageContent 里的自闭合 <ToolBars/> 展开成含一个按钮 JS 的工具栏（文件须已存在） */
function expandWbPageToolbars(p, js = 'goPrevPage();') {
  const raw = read(p);
  const open = raw.indexOf('<WebPageContent>');
  const close = raw.indexOf('</WebPageContent>', open);
  const seg = raw.slice(open, close);
  assert.ok(seg.includes('<ToolBars/>'), 'create_cpt 的 WebPageContent 应含自闭合 <ToolBars/>');
  const bars = `<ToolBars><ToolBarManager><ToolBar>`
    + `<Widget class="com.fr.report.web.button.page.Previous"><Text><![CDATA[上一页]]></Text>`
    + `<JavaScript class="com.fr.js.JavaScriptImpl"><Parameters/><Content><![CDATA[${js}]]></Content></JavaScript></Widget>`
    + `</ToolBar></ToolBarManager></ToolBars>`;
  fs.writeFileSync(p, raw.slice(0, open) + seg.replace('<ToolBars/>', bars) + raw.slice(close));
}

test('C-A 模板级 <ReportWebAttr><WebPageContent> 的 Listener 必须进 jsBlocks/checkReportJs', () => {
  const d = tmp();
  try {
    const p = path.join(d, 'tpl-page.cpt');
    createCpt(p, { rows: 3, columns: 3, webWrite: true });
    // 复现真实落点：模板级 WebPageContent 挂分页预览 afterload（官方 50 份同构）
    insertIntoWbPage(p, listenerXml('afterload', 'var pageReady = 1;'));

    const blocks = jsBlocks(load(p).parsed);
    const pageBlocks = blocks.filter((b) => String(b.container).startsWith('webpage:'));
    assert.equal(pageBlocks.length, 1, `模板级分页事件应恰好 1 块：${JSON.stringify(blocks.map((b) => b.location))}`);
    assert.equal(pageBlocks[0].container, 'webpage:@workbook', '模板级容器用 @workbook 与表级 webpage:<sheet> 区分');
    assert.equal(pageBlocks[0].location, '模板/WebPageContent[afterload]');
    assert.match(pageBlocks[0].code, /pageReady/);

    // 验收口径：该模板 JS 节点只有这 1 个（骨架无其它 JS），旧实现报 0，修复后必须报 1
    const chk = checkReportJs(p);
    assert.equal(chk.blocks, 1, `check_report_js 应扫到模板级 1 块，实际 ${chk.blocks}`);
    assert.equal(chk.failed, 0);
    assert.equal(chk.passed, 1);
    // 容器归属正确时 validate 不应报 error
    assert.equal(validateCpt(p).filter((i) => i.severity === 'error').length, 0);
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test('C-A 模板级 WebPageContent 的坏 JS 必须被 check_report_js 定位（修复前完全看不见）', () => {
  const d = tmp();
  try {
    const p = path.join(d, 'tpl-page-bad.cpt');
    createCpt(p, { rows: 3, columns: 3 });
    insertIntoWbPage(p, listenerXml('afterload', 'function broken() {\nvar x = 1;'));
    const chk = checkReportJs(p);
    assert.equal(chk.blocks, 1);
    assert.equal(chk.failed, 1, `模板级坏 JS 必须被抓：${JSON.stringify(chk)}`);
    assert.equal(chk.failures[0].location, '模板/WebPageContent[afterload]', '定位必须指向模板级容器');
    // validate 复用同一扫描，必须出现 JS语法 warning（可见可闭环，不阻断）
    const warn = validateCpt(p).find((i) => i.severity === 'warning' && /JS语法/.test(i.location));
    assert.ok(warn, 'validate 应报 JS语法 warning');
    assert.match(warn.location, /模板\/WebPageContent/);
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test('C-A 模板级 WebViewContent 事件同样覆盖（结构存在才扫，官方 3 例）', () => {
  const d = tmp();
  try {
    const p = path.join(d, 'tpl-view.cpt');
    createCpt(p, { rows: 3, columns: 3 });
    insertIntoTemplateWebAttr(p, `<WebViewContent><ToolBars/>${listenerXml('afterload', 'var viewReady = 1;')}</WebViewContent>`);
    const blocks = jsBlocks(load(p).parsed);
    const viewBlocks = blocks.filter((b) => b.container === 'webview:@workbook');
    assert.equal(viewBlocks.length, 1, `WebViewContent 事件应可见：${JSON.stringify(blocks.map((b) => b.container))}`);
    assert.equal(viewBlocks[0].location, '模板/WebViewContent[afterload]');
    assert.equal(checkReportJs(p).blocks, 1);
    assert.equal(checkReportJs(p).failed, 0);
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test('C-A 模板级 page/view 工具栏按钮 JS 必须进扫描（写侧自 2026-10-23 支持三宿主）', () => {
  const d = tmp();
  try {
    const p = path.join(d, 'tpl-page-toolbar.cpt');
    createCpt(p, { rows: 3, columns: 3 });
    expandWbPageToolbars(p, 'goPrevPage();');
    const blocks = jsBlocks(load(p).parsed);
    const tb = blocks.filter((b) => b.container === '工具栏:page');
    assert.equal(tb.length, 1, `模板级分页工具栏按钮 JS 应可见：${JSON.stringify(blocks.map((b) => b.location))}`);
    assert.equal(tb[0].location, '模板/页面工具栏[上一页]');
    assert.match(tb[0].code, /goPrevPage/);
    assert.equal(checkReportJs(p).blocks, 1);
    assert.equal(checkReportJs(p).failed, 0);

    // view 宿主同理
    const p2 = path.join(d, 'tpl-view-toolbar.cpt');
    createCpt(p2, { rows: 3, columns: 3 });
    insertIntoTemplateWebAttr(p2, '<WebViewContent><ToolBars><ToolBarManager><ToolBar>'
      + '<Widget class="com.fr.report.web.button.page.First"><Text><![CDATA[首页]]></Text>'
      + '<JavaScript class="com.fr.js.JavaScriptImpl"><Parameters/><Content><![CDATA[goFirst();]]></Content></JavaScript></Widget>'
      + '</ToolBar></ToolBarManager></ToolBars></WebViewContent>');
    const vtb = jsBlocks(load(p2).parsed).filter((b) => b.container === '工具栏:view');
    assert.equal(vtb.length, 1);
    assert.equal(vtb[0].location, '模板/预览工具栏[首页]');
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test('C-A 去重/兼容：表级 webpg 与模板级 webpg:@workbook 各自计数，不重复也不吞并', () => {
  const d = tmp();
  try {
    // ① 只有表级 Report 子级 WebPageContent（M99-D2 历史形态）→ 1 块，不得因为模板级扫描而重复
    const p1 = path.join(d, 'sheet-only.cpt');
    createCpt(p1, { rows: 3, columns: 3 });
    const raw1 = read(p1);
    fs.writeFileSync(p1, raw1.replace('</Report>', `<WebPageContent>${listenerXml('afterload', 'var sheetPage = 1;')}</WebPageContent></Report>`));
    const b1 = jsBlocks(load(p1).parsed);
    assert.equal(b1.filter((b) => String(b.container).startsWith('webpage:')).length, 1);
    assert.equal(b1.find((b) => String(b.container).startsWith('webpage:')).container, 'webpage:sheet1');

    // ② 模板级与表级同时存在（两个不同的真实节点）→ 各 1 块，容器键不同
    insertIntoWbPage(p1, listenerXml('afterload', 'var wbPage = 1;'));
    const b2 = jsBlocks(load(p1).parsed);
    const pages = b2.filter((b) => String(b.container).startsWith('webpage:')).map((b) => b.container);
    assert.deepEqual(pages, ['webpage:@workbook', 'webpage:sheet1']);
    assert.equal(checkReportJs(p1).blocks, 2);
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test('C-A js-baseline 分类同步：template 级事件/工具栏进独立分类键，可被丢块拦截', () => {
  const d = tmp();
  try {
    const p = path.join(d, 'tpl-baseline.cpt');
    createCpt(p, { rows: 3, columns: 3, webWrite: true });
    insertIntoWbPage(p, listenerXml('afterload', 'var pageReady = 1;'));
    insertIntoTemplateWebAttr(p, `<WebViewContent><ToolBars/>${listenerXml('afterload', 'var viewReady = 1;')}</WebViewContent>`);
    expandWbPageToolbars(p, 'goPrevPage();');
    const snap = snapshotJsCounts(load(p).parsed);
    assert.equal(snap.byCat['webpg:@workbook'], 1, `模板级分页事件应有独立分类：${JSON.stringify(snap.byCat)}`);
    assert.equal(snap.byCat['webview:@workbook'], 1, `WebViewContent 事件应有独立分类：${JSON.stringify(snap.byCat)}`);
    assert.equal(snap.byCat['toolbar:page'], 1, `模板级分页工具栏应有独立分类：${JSON.stringify(snap.byCat)}`);
    assert.equal(snap.total, 3);
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});
