// test/toolbar-hosts.test.js —— 工具栏双容器（write=WebWriteContent / page=WebPageContent）
//
// 背景（订单超时-跟进查询.cpt 实测 2026-10-23）：WorkBook 级可同时存在两个 ToolBars 容器，
// 各有一整套同名按钮（首页/上一页/页码跳转/下一页/末页/导出/数据总量）。此前所有工具栏工具
// 硬编码 locateWebWriteContent()，只认 write 那一个：
//   · 只存在于 page 的 JS 串（如 `|| 50;`）→ match 一律「未找到」；
//   · buttonText/index 全部落到 write 那套 → 改完 page 的实际内容不变（"改不动"）。
// 结果是 sheet1 的 4 个分页块只能靠手工文本替换改（口径例外，已记录在共享清单）。
// 本文件锁定补齐后的行为：两个容器各自可读、可写、互不串台。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCpt } from '../lib/generate.js';
import {
  addToolbarButton, listToolbarButtons, setToolbarButtonJs,
  deleteToolbarButton, moveToolbarButton, setToolbarButtonIcon,
} from '../lib/edits.js';
import { validateCpt } from '../lib/validate.js';
import '../scripts/isolate-store.mjs';

delete process.env.CPT_MCP_ALLOWED_ROOTS;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-tbh-'));
const read = (p) => fs.readFileSync(p, 'utf8');
const errs = (p) => validateCpt(p).filter((i) => i.severity === 'error');

/** createCpt 自带 <WebPageContent><ToolBars/><WebPage/></WebPageContent>（page 容器）；
 *  webWrite:true 再生成 <WebWriteContent>（write 容器）——两个容器同时存在的真实形态 */
function fixture() {
  const d = tmp();
  const p = path.join(d, 't.cpt');
  createCpt(p, { rows: 2, columns: 2, webWrite: true });
  return { d, p };
}

test('page 容器：新建按钮（自闭合 ToolBars 展开）并可列出/校验', () => {
  const { d, p } = fixture();
  const r = addToolbarButton(p, { toolbar: 'page', buttonText: '上一页', js: 'var pageSize = 50;' });
  assert.equal(r.toolbar, 'page');
  assert.ok(['new-toolbars', 'new-toolbar', 'append'].includes(r.mode), r.mode);
  const xml = read(p);
  assert.ok(xml.includes('<ToolBarManager>'), 'page 容器内应生成完整 ToolBars 结构');
  assert.ok(xml.includes('<Text>\r\n<![CDATA[上一页]]></Text>') || xml.includes('<![CDATA[上一页]]>'));
  const l = listToolbarButtons(p, { toolbar: 'page' });
  assert.equal(l.toolbar, 'page');
  assert.deepEqual(l.buttons.map((b) => b.text), ['上一页']);
  assert.equal(errs(p).length, 0);
  fs.rmSync(d, { recursive: true, force: true });
});

test('两个容器独立：同名按钮可各自存在，重名检查只扫本容器', () => {
  const { d, p } = fixture();
  addToolbarButton(p, { toolbar: 'page', buttonText: '上一页', js: 'pageJs();' });
  // write 容器此时不存在 → 工具会创建（P0 容器修复行为）
  addToolbarButton(p, { toolbar: 'write', buttonText: '上一页', js: 'writeJs();' });
  const all = listToolbarButtons(p, { toolbar: 'all' });
  assert.equal(all.toolbar, 'all');
  assert.equal(all.toolbars.length, 2);
  assert.equal(all.toolbars.find((x) => x.toolbar === 'page').count, 1);
  assert.equal(all.toolbars.find((x) => x.toolbar === 'write').count, 1);
  // 同容器内再加重名 → 拒绝
  assert.throws(() => addToolbarButton(p, { toolbar: 'page', buttonText: '上一页' }), /已有文字为「上一页」/);
  fs.rmSync(d, { recursive: true, force: true });
});

test('set_toolbar_button_js：toolbar=page 只改 page，write 逐字节不动', () => {
  const { d, p } = fixture();
  addToolbarButton(p, { toolbar: 'page', buttonText: '上一页', js: 'var pageSize = parseInt(ps) || 50;' });
  addToolbarButton(p, { toolbar: 'write', buttonText: '上一页', js: 'var pageSize = parseInt(ps) || 50;' });
  const before = read(p);

  const r = setToolbarButtonJs(p, { toolbar: 'page', buttonText: '上一页', js: 'var pageSize = parseInt(ps) || 1000;' });
  assert.equal(r.toolbar, 'page');
  assert.equal(r.mode, 'replace', '（2026-11-03 统一口径：整块写入=mode replace）');
  const after = read(p);

  // page 段变了、write 段没变：按两个容器各自切片比较
  const slice = (s, name) => {
    const a = s.indexOf(`<${name}`);
    const b = s.indexOf(`</${name}>`, a);
    return s.slice(a, b);
  };
  assert.ok(slice(after, 'WebPageContent').includes('|| 1000;'), 'page 容器应写入新 JS');
  assert.ok(slice(after, 'WebWriteContent').includes('|| 50;'), 'write 容器应保持原样');
  assert.ok(!slice(after, 'WebWriteContent').includes('|| 1000;'));
  assert.ok(before !== after);
  fs.rmSync(d, { recursive: true, force: true });
});

test('set_toolbar_button_js：toolbar=auto 在 page 里命中（默认 write 会「未找到」）', () => {
  const { d, p } = fixture();
  addToolbarButton(p, { toolbar: 'page', buttonText: '页码跳转', js: 'Math.min(pageSize, 500);' });
  addToolbarButton(p, { toolbar: 'write', buttonText: '占位', js: 'var q = 1;' });
  // 默认 write：该串只在 page 容器里 → write 报「未找到」（这正是此前「改不动」的直接原因）
  assert.throws(() => setToolbarButtonJs(p, { match: 'Math.min(pageSize, 500);', js: 'x();' }), /未找到/);
  const r = setToolbarButtonJs(p, { toolbar: 'auto', match: 'Math.min(pageSize, 500);', js: 'Math.min(pageSize, 1000);' });
  assert.equal(r.toolbar, 'page');
  assert.ok(read(p).includes('Math.min(pageSize, 1000);'));
  fs.rmSync(d, { recursive: true, force: true });
});

test('非法 toolbar 值：明确报错并给出可选值', () => {
  const { d, p } = fixture();
  assert.throws(() => listToolbarButtons(p, { toolbar: 'bogus' }), /toolbar 只能是 write.*page/);
  addToolbarButton(p, { toolbar: 'page', buttonText: '首页' });
  assert.throws(() => setToolbarButtonJs(p, { toolbar: 'bogus', buttonText: '首页', js: 'x();' }), /write/);
  fs.rmSync(d, { recursive: true, force: true });
});

test('view 容器：<WebViewContent> 内 ToolBars 也可读写（官方 12 个样本的老模板形态）', () => {
  const { d, p } = fixture();
  // createCpt 不生成 WebViewContent → 手工注入官方形态（<ReportWebAttr><ServerPrinter/><WebViewContent><ToolBars/>...）
  let raw = read(p);
  assert.ok(raw.includes('<ServerPrinter/>'));
  raw = raw.replace('<ServerPrinter/>', '<ServerPrinter/>\n<WebViewContent>\n<ToolBars/>\n</WebViewContent>');
  fs.writeFileSync(p, raw);

  const r = addToolbarButton(p, { toolbar: 'view', buttonText: '打印', js: 'printAll();' });
  assert.equal(r.toolbar, 'view');
  assert.equal(listToolbarButtons(p, { toolbar: 'view' }).buttons[0].text, '打印');
  const u = setToolbarButtonJs(p, { toolbar: 'view', match: 'printAll();', js: 'printAll2();' });
  assert.equal(u.toolbar, 'view');
  assert.ok(read(p).includes('printAll2();'));
  // all 现在应列出三个容器
  const all = listToolbarButtons(p, { toolbar: 'all' });
  assert.deepEqual(all.toolbars.map((t) => t.toolbar), ['write', 'page', 'view']);
  assert.equal(all.toolbars.find((t) => t.toolbar === 'view').count, 1);
  fs.rmSync(d, { recursive: true, force: true });
});

test('delete / move / icon 也支持 page 容器', () => {
  const { d, p } = fixture();
  for (const t of ['首页', '上一页', '下一页', '末页']) addToolbarButton(p, { toolbar: 'page', buttonText: t });
  // icon
  const ri = setToolbarButtonIcon(p, { toolbar: 'page', buttonText: '末页', iconName: 'last' });
  assert.equal(ri.toolbar, 'page');
  assert.ok(read(p).includes('<![CDATA[last]]>'));
  // move
  const rm = moveToolbarButton(p, { toolbar: 'page', buttonText: '末页', to: 'first' });
  assert.equal(rm.toolbar, 'page');
  assert.equal(listToolbarButtons(p, { toolbar: 'page' }).buttons[0].text, '末页');
  // delete
  const rd = deleteToolbarButton(p, { toolbar: 'page', buttonText: '首页' });
  assert.equal(rd.toolbar, 'page');
  assert.deepEqual(listToolbarButtons(p, { toolbar: 'page' }).buttons.map((b) => b.text), ['末页', '上一页', '下一页']);
  // 容器不存在时的报错要指明是哪个容器
  const d2 = tmp();
  const p2 = path.join(d2, 'e.cpt');
  createCpt(p2, { rows: 1, columns: 1 });
  assert.throws(() => listToolbarButtons(p2, { toolbar: 'write' }), /无 <WebWriteContent>|无 <ToolBars>/);
  fs.rmSync(d, { recursive: true, force: true });
  fs.rmSync(d2, { recursive: true, force: true });
});
