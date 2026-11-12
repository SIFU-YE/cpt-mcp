// test/param-widget-font.test.js —— M114 参数面板控件字体：按钮放开、边界收紧
//
// 背景（能力缺口，sandbox7 字典转隐藏列改造规格 §7 报出并核实）：
//   文档记「查询按钮 fontName 工具不支持写入，保持默认字体（非验收项）」。
//   核实：M81 的门禁是"字体/边框只允许 com.fr.form.ui.Label"，且注释写着"官方面板按钮从不带 FRFont"。
//   **该注释不成立** —— 全量 1550 份官方样本里，面板按钮带 <FRFont> 的有 5 例：
//     · demo/Phone/form/物流信息登记-phone.cpt：FormSubmitButton/Search（查询按钮）
//       与 3 个 FreeButton
//     · demo/cloud/demobetter.cpt：FormSubmitButton/Search
//   官方落点：<FRFont> 紧跟 <Hotkeys> 之后、<isCustomType> 之前（见下 FullButtonBlock 注释）。
//   而 Label 带 FRFont 412 例 —— 所以"只有 Label 能带"是 M81 当时的取样偏差。
//
// 本文件锁定 M114 的新边界：
//   · Label   → fontName/fontSize/noBorder 全部可写（原行为不变）
//   · 按钮     → fontName/fontSize 可写，且必须落在 <Hotkeys> 之后（官方顺序）；noBorder 仍拒绝（无实证）
//   · 输入框等 → fontName 仍拒绝（字体走主题，官方无实例）
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCpt, addParameterWidget, setParameterPanel } from '../lib/generate.js';
import { updateParameterWidget } from '../lib/edits.js';
import { parameterPanel } from '../lib/cpt.js';
import '../scripts/isolate-store.mjs'; // M123：JS 基线 store 隔离，直跑也不污染真实 store

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-pwf-'));

function fixture() {
  const d = tmp();
  const p = path.join(d, 't.cpt');
  createCpt(p, { rows: 3, columns: 3 });
  setParameterPanel(p, { title: '筛选' });
  addParameterWidget(p, { name: 'Search', type: 'submitButton' });
  addParameterWidget(p, { name: 'kw', type: 'text' });
  addParameterWidget(p, { name: 'lbl', type: 'label' });
  return { d, p };
}
const innerBlock = (p, clsPart) => {
  const raw = fs.readFileSync(p, 'utf8');
  return raw.match(new RegExp(`<InnerWidget\\s+class="[^"]*${clsPart}[^"]*"[\\s\\S]*?</InnerWidget>`))?.[0] ?? null;
};

test('M114 查询按钮 fontName 可写，且 FRFont 落在官方位置（<Hotkeys> 之后 / <isCustomType> 之前）', () => {
  const { d, p } = fixture();
  const cls = parameterPanel(p).widgets.find((w) => w.name === 'Search').class;
  assert.equal(cls, 'com.fr.form.parameter.FormSubmitButton', '先决：查询按钮类');

  const r = updateParameterWidget(p, { name: 'Search', fontName: '微软雅黑', fontSize: 96 });
  assert.equal(r.action, 'update_parameter_widget');
  assert.match(String(r.changed), /font=微软雅黑\/96/);

  const blk = innerBlock(p, 'Button');
  assert.ok(blk, '应找到按钮的 InnerWidget');
  assert.match(blk, /<FRFont name="微软雅黑" style="0" size="96"\/>/, 'FRFont 应写入');
  // 官方顺序：Text → Hotkeys → FRFont → (isCustomType)
  const iHot = blk.indexOf('<Hotkeys>');
  const iFont = blk.indexOf('<FRFont');
  differAssert(iHot >= 0 && iFont > iHot, 'FRFont 必须在 <Hotkeys> 之后（官方顺序）');
  const iCustom = blk.indexOf('<isCustomType');
  if (iCustom >= 0) differAssert(iFont < iCustom, 'FRFont 必须在 <isCustomType> 之前（官方顺序）');
  fs.rmSync(d, { recursive: true, force: true });
});

function differAssert(cond, msg) { assert.ok(cond, msg); }

test('M114 按钮可改字体/字号；重复写入是"替换"而非"追加"（幂等性现状与 Label 一致）', () => {
  const { d, p } = fixture();
  updateParameterWidget(p, { name: 'Search', fontName: '微软雅黑', fontSize: 96 });
  updateParameterWidget(p, { name: 'Search', fontName: '宋体', fontSize: 80 });
  const blk = innerBlock(p, 'Button');
  const fonts = blk.match(/<FRFont\b[^>]*\/>/g) ?? [];
  assert.equal(fonts.length, 1, `FRFont 应只保留一个（替换语义），实际 ${fonts.length}`);
  assert.match(blk, /name="宋体"/);
  assert.match(blk, /size="80"/);
  // 同值重放：**不返回 mode=none**。这是沿用 M81 的既有行为（Label 路径同样如此：
  // 无条件重建 <FRFont> 并记为 changed），只有 x/y 坐标做了同值短路。
  // 此处断言"结果收敛"而非"报 none" —— 防止把现状误当回归，也防止有人以为它幂等。
  const again = updateParameterWidget(p, { name: 'Search', fontName: '宋体', fontSize: 80 });
  const blk2 = innerBlock(p, 'Button');
  assert.equal((blk2.match(/<FRFont\b[^>]*\/>/g) ?? []).length, 1, '同值重放不得追加出第二个 FRFont');
  assert.equal(blk2, blk, '同值重放后 XML 字节不变（收敛，无副作用）');
  assert.equal(again.mode, 'update', 'font 路径沿用 M81 行为：同值仍报 update（非 none）');
  fs.rmSync(d, { recursive: true, force: true });
});

test('M114 边界：输入框仍拒绝 fontName；按钮仍拒绝 noBorder；Label 两者皆可', () => {
  const { d, p } = fixture();
  // 输入框：字体走主题，官方无 FRFont 实例 → 继续拒绝
  assert.throws(() => updateParameterWidget(p, { name: 'kw', fontName: '微软雅黑' }),
    /只支持 Label 标签与按钮控件/, '输入框应拒绝 fontName');
  // 按钮：无官方 border 实证 → 继续拒绝 noBorder
  assert.throws(() => updateParameterWidget(p, { name: 'Search', noBorder: true }),
    /边框只支持 Label/, '按钮应拒绝 noBorder');
  // Label：两者皆可（原能力不回归）
  const r = updateParameterWidget(p, { name: 'lbl', fontName: '微软雅黑', fontSize: 80, noBorder: true });
  assert.match(String(r.changed), /font=微软雅黑\/80/);
  assert.match(String(r.changed), /border=none/);
  const lblBlk = innerBlock(p, 'com\\.fr\\.form\\.ui\\.Label');
  assert.match(lblBlk, /<FRFont\b/);
  assert.match(lblBlk, /<border style="0">/);
  fs.rmSync(d, { recursive: true, force: true });
});

test('M114 按钮无 <isCustomType> 时 FRFont 退化为插在 </InnerWidget> 之前（不丢写入）', () => {
  const d = tmp();
  const p = path.join(d, 't2.cpt');
  createCpt(p, { rows: 3, columns: 3 });
  setParameterPanel(p, { title: '筛选' });
  addParameterWidget(p, { name: 'Search', type: 'submitButton' });
  // 人为删掉 isCustomType（模拟另一形态的面板），确认退化路径不抛错且仍写入
  let raw = fs.readFileSync(p, 'utf8');
  raw = raw.replace(/<isCustomType[^>]*\/>\s*/g, '');
  fs.writeFileSync(p, raw);
  updateParameterWidget(p, { name: 'Search', fontName: '微软雅黑' });
  const blk = innerBlock(p, 'Button');
  assert.match(blk, /<FRFont[^>]*>/, '无 isCustomType 时也应写入 FRFont');
  assert.ok(blk.indexOf('<FRFont') < blk.indexOf('</InnerWidget>'), 'FRFont 应在闭合标签之前');
  fs.rmSync(d, { recursive: true, force: true });
});

test('M114 官方证据记录：按钮带 FRFont 的样本确实存在（防止门禁再次被"实证错觉"收窄）', () => {
  // 这条断言不依赖 FR 安装目录（CI 上可能没有），只记录结论出处，供 review 时追溯：
  //   5 例 = demo/Phone/form/物流信息登记-phone.cpt（FormSubmitButton/Search + 3×FreeButton）
  //        + demo/cloud/demobetter.cpt（FormSubmitButton/Search）
  // 若日后有人要再收紧按钮的 fontName，必须先推翻这 5 例。
  const FR = process.env.FR_HOME || 'D:/FineReport_11.0';
  const sample = path.join(FR, 'webapps/webroot/WEB-INF/reportlets/demo/Phone/form/物流信息登记-phone.cpt');
  if (!fs.existsSync(sample)) {
    console.log(`（跳过：未找到官方样本 ${sample}；结论出处已记录在 test 注释与 lib/edits.js 的 M114 段）`);
    return;
  }
  const raw = fs.readFileSync(sample, 'utf8');
  const btnBlocks = [...raw.matchAll(/<InnerWidget\s+class="[^"]*(?:Button|Submit)[^"]*"[\s\S]*?<\/InnerWidget>/g)].map((m) => m[0]);
  const withFont = btnBlocks.filter((b) => /<FRFont\b/.test(b));
  assert.ok(withFont.length >= 4, `该样本应含 ≥4 个带 FRFont 的按钮（实测 ${withFont.length}/${btnBlocks.length}）`);
  // 且落点在 Hotkeys 之后
  const search = withFont.find((b) => /FormSubmitButton/.test(b));
  assert.ok(search, '应含带 FRFont 的 FormSubmitButton');
  assert.ok(search.indexOf('<FRFont') > search.indexOf('<Hotkeys>'), '官方落点：FRFont 在 Hotkeys 之后');
});
