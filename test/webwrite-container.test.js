// test/webwrite-container.test.js —— 填报容器归属回归（2026-10-20 P0 修复）
//
// 背景（真实事故，sandbox16 订单超时系列报表）：
//   build_report 未传 webWrite 时骨架没有 <WebWriteContent>；调用方用 set_webwrite_extras 补容器，
//   旧实现走 updateReportNode 兜底，把容器插到最后一个 </Report> 前（= <Report> 子级、
//   <ReportWebAttr> 之外）→ FR 填报预览读不到，工具栏按钮全部不显示、填报 Web 事件不执行；
//   而 validate_cpt / quality_gate / 引擎校验都不查容器归属 → 四件套全绿，问题只能靠人肉比对行号发现。
// 本文件锁定修复后的契约：
//   ① 缺容器 → 在 WorkBook 级 <ReportWebAttr> 内创建（绝不再插 </Report> 前）；
//   ② 容器被旧工具放到别处 → set_webwrite_extras / 各工具栏写工具先自动搬回（内容保真）并回报 repaired；
//   ③ validate_cpt 对“容器在 ReportWebAttr 外”报 error（搬回后消失）；
//   ④ update_report_node 支持 parent 插入；<WebWriteContent> 不再允许走无 parent 兜底插入；
//   ⑤ build_report 传 toolbar 时自动 webWrite=true。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCpt } from '../lib/generate.js';
import { buildReport } from '../lib/engine/builder.js';
import {
  setWebWriteExtras, setFillToolbar, addToolbarButton, setWebWriteJs,
  updateReportNode, ensureWebWriteContainer, listToolbarButtons,
} from '../lib/edits.js';
import { validateCpt } from '../lib/validate.js';
import '../scripts/isolate-store.mjs';

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-wwc-'));
const read = (p) => fs.readFileSync(p, 'utf8');
const errs = (p) => validateCpt(p).filter((x) => x.severity === 'error');

/** 取 <ReportWebAttr>…</ReportWebAttr> 区间（下标）。 */
function rwaRange(raw) {
  const open = raw.indexOf('<ReportWebAttr>');
  const close = raw.indexOf('</ReportWebAttr>', open);
  return { open, close };
}
/** WebWriteContent 是否位于 WorkBook 级 ReportWebAttr 内。 */
function wwcInRwa(p) {
  const raw = read(p);
  const i = raw.indexOf('<WebWriteContent');
  if (i < 0) return false;
  const { open, close } = rwaRange(raw);
  return open >= 0 && i > open && i < close;
}
/** 造“旧工具产出的坏结构”：把 WWC 整块从 ReportWebAttr 挖出来，塞到最后一个 </Report> 前。 */
function makeMisplaced(p) {
  createCpt(p, { webWrite: true, withWebAttr: true, title: 'bad' });
  setFillToolbar(p, { buttons: ['submit', 'append-row'] });
  let raw = read(p);
  const s = raw.indexOf('<WebWriteContent>');
  const e = raw.indexOf('</WebWriteContent>') + '</WebWriteContent>'.length;
  const block = raw.slice(s, e);
  raw = raw.slice(0, s) + raw.slice(e);
  const reportClose = raw.lastIndexOf('</Report>');
  raw = raw.slice(0, reportClose) + '\n' + block + '\n' + raw.slice(reportClose);
  fs.writeFileSync(p, raw, 'utf8');
  assert.equal(wwcInRwa(p), false, '夹具应为错位结构');
}

test('缺容器：set_webwrite_extras 在 ReportWebAttr 内创建，validate 0 error', () => {
  const p = path.join(tmpDir(), 'create.cpt');
  createCpt(p, { webWrite: false, withWebAttr: true, title: 'c' });
  const r = setWebWriteExtras(p, { editRowColor: { setColor: 'true' } });
  assert.equal(r.repaired, 'created');
  assert.ok(r.repairNotes?.some((x) => x.includes('ReportWebAttr')), '应提示在 ReportWebAttr 内创建');
  assert.equal(wwcInRwa(p), true, '容器必须落在 ReportWebAttr 内');
  assert.equal(errs(p).length, 0);
});

test('错位坏结构：validate 报 error；set_webwrite_extras({repair:true}) 搬回且子节点保真', () => {
  const p = path.join(tmpDir(), 'repair.cpt');
  makeMisplaced(p);
  const bad = errs(p);
  assert.ok(bad.some((x) => x.message.includes('不在 WorkBook 级')), `validate 应报容器错位：${JSON.stringify(bad)}`);

  const r = setWebWriteExtras(p, { repair: true });
  assert.equal(r.repaired, 'moved');
  assert.equal(r.mode, 'repair');
  assert.equal(wwcInRwa(p), true);
  assert.equal(errs(p).length, 0);
  // 子节点保真：repair 不许丢 ToolBars/按钮
  assert.ok(read(p).includes('ToolBarManager'), 'repair 不得丢 ToolBars');
  assert.equal(listToolbarButtons(p).count, 2, 'repair 不得丢按钮');
  // 幂等：再修一次不动
  const r2 = setWebWriteExtras(p, { repair: true });
  assert.equal(r2.mode, 'noop');
});

test('错位坏结构：set_fill_toolbar / add_toolbar_button / set_webwrite_js 写前自动搬回', () => {
  const p1 = path.join(tmpDir(), 'fill.cpt');
  makeMisplaced(p1);
  const r1 = setFillToolbar(p1, { buttons: ['submit'] });
  assert.equal(r1.repaired, 'moved');
  assert.equal(wwcInRwa(p1), true);
  assert.equal(errs(p1).length, 0);

  const p2 = path.join(tmpDir(), 'btn.cpt');
  makeMisplaced(p2);
  const r2 = addToolbarButton(p2, { buttonText: '导出', js: 'var a = 1;' });
  assert.equal(r2.repaired, 'moved');
  assert.equal(wwcInRwa(p2), true);
  assert.equal(errs(p2).length, 0);

  const p3 = path.join(tmpDir(), 'js.cpt');
  makeMisplaced(p3);
  const r3 = setWebWriteJs(p3, { event: 'beforewrite', js: 'var x = 1;' });
  assert.equal(r3.repaired, 'moved');
  assert.equal(wwcInRwa(p3), true);
  assert.equal(errs(p3).length, 0);
});

test('update_report_node：parent 可把节点插进 ReportWebAttr；WebWriteContent 无 parent 兜底必须拒绝', () => {
  const p = path.join(tmpDir(), 'urn.cpt');
  createCpt(p, { webWrite: false, withWebAttr: true, title: 'u' });
  const r = updateReportNode(p, { nodeName: 'ReportPageAttrMarker', xmlBody: '<X/>', parent: 'ReportWebAttr' });
  assert.equal(r.mode, 'upsert');
  const raw = read(p);
  assert.ok(raw.indexOf('<ReportPageAttrMarker') < raw.indexOf('</ReportWebAttr>'), '应插在 ReportWebAttr 内');
  assert.throws(
    () => updateReportNode(p, { nodeName: 'WebWriteContent', xmlBody: '<WebWriteContent/>' }),
    /不负责创建\/搬移/,
    'WebWriteContent 不允走 </Report> 前兜底',
  );
});

test('build_report：传 toolbar 未传 webWrite 时自动 webWrite=true', () => {
  const p = path.join(tmpDir(), 'build.cpt');
  buildReport({ path: p, title: 'b', rows: 4, columns: 4, toolbar: ['submit', 'append-row'], check: false });
  assert.equal(wwcInRwa(p), true, 'toolbar 非空时骨架必须含 ReportWebAttr 内 WebWriteContent');
  assert.ok(read(p).includes('ToolBarManager'), '工具栏应建成');
  assert.equal(errs(p).length, 0);
});

test('正常模板/自闭合容器：ensureWebWriteContainer 幂等，自闭合展开', () => {
  const p = path.join(tmpDir(), 'ok.cpt');
  createCpt(p, { webWrite: true, withWebAttr: true, title: 'ok' });
  const before = read(p);
  const r = ensureWebWriteContainer(p);
  assert.equal(r.action, 'ok');
  assert.equal(read(p), before, '已正确容器不得改动');

  // 自闭合 WebWriteContent（在 ReportWebAttr 内）→ 展开为含默认子节点的块
  const q = path.join(tmpDir(), 'selfclose.cpt');
  createCpt(q, { webWrite: false, withWebAttr: true, title: 's' });
  let raw = read(q);
  raw = raw.replace('</ReportWebAttr>', '<WebWriteContent/>\n</ReportWebAttr>');
  fs.writeFileSync(q, raw, 'utf8');
  const r2 = ensureWebWriteContainer(q);
  assert.equal(r2.action, 'expanded');
  assert.ok(read(q).includes('<EditRowColor setColor="false"/>'), '展开后应含默认子节点');
});
