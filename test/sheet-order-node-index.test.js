// test/sheet-order-node-index.test.js —— 补齐两个已确认缺口
//
// 缺口 A（update_sheet 只能改名、不能调顺序）：用户当时想「把某表临时挪到最后」当绕行手段，
//   实测做不到，只能手工改 XML。现在 update_sheet({order}) 支持按序号移动工作表，
//   整块字节原样搬运（顺序即 .cpt 里 Report 块的先后）。
// 缺口 B（update_report_node 只能靠开标签属性收敛）：属性完全相同的多个节点（典型：工具栏
//   多个 <Widget class="com.fr.form.ui.CustomToolBarButton">，7 个属性一模一样）此前无法唯一命中，
//   M91 直接拒绝 → 单节点不可达。现在加 index（0 起，按文档顺序），显式指定第几个。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCpt } from '../lib/generate.js';
import { updateSheet, updateReportNode, addToolbarButton } from '../lib/edits.js';
import { sheetBlocks } from '../lib/xml.js';
import { validateCpt } from '../lib/validate.js';
import '../scripts/isolate-store.mjs';

delete process.env.CPT_MCP_ALLOWED_ROOTS;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-gapfill-'));
const read = (p) => fs.readFileSync(p, 'utf8');
const errs = (p) => validateCpt(p).filter((i) => i.severity === 'error');
const names = (p) => sheetBlocks(read(p)).map((b) => b.name);

/** 三工作表夹具：把 createCpt 产出的单个 Report 块复制两份改名（结构等价，够测顺序） */
function multiSheet() {
  const d = tmp();
  const p = path.join(d, 't.cpt');
  createCpt(p, { rows: 2, columns: 2 });
  const raw = read(p);
  const m = raw.match(/<Report class="com\.fr\.report\.worksheet\.WorkSheet"[\s\S]*?<\/Report>/);
  assert.ok(m, '夹具应含一个 Report 块');
  const block = m[0];
  const b2 = block.replace('name="sheet1"', 'name="sheet2"');
  const b3 = block.replace('name="sheet1"', 'name="sheet3"');
  fs.writeFileSync(p, raw.replace(block, `${block}\n${b2}\n${b3}`));
  return { d, p };
}

test('update_sheet(order)：中间表挪到最后 / 末表挪到最前 / 同位置 noop', () => {
  const { d, p } = multiSheet();
  assert.deepEqual(names(p), ['sheet1', 'sheet2', 'sheet3']);

  const r1 = updateSheet(p, { sheet: 0, order: 2 });
  assert.equal(r1.order, 2);
  assert.equal(r1.moved, true);
  assert.deepEqual(names(p), ['sheet2', 'sheet3', 'sheet1']);
  assert.equal(errs(p).length, 0, '移动后模板必须仍合法');

  const r2 = updateSheet(p, { sheet: 'sheet1', order: 0 });
  assert.deepEqual(names(p), ['sheet1', 'sheet2', 'sheet3']);
  assert.equal(r2.moved, true);

  const r3 = updateSheet(p, { sheet: 1, order: 1 });
  assert.equal(r3.moved, false, '同位置应 noop');
  assert.deepEqual(names(p), ['sheet1', 'sheet2', 'sheet3']);
  fs.rmSync(d, { recursive: true, force: true });
});

test('update_sheet(order)：越界/非法值报错且不改文件；改名+移动可一次完成', () => {
  const { d, p } = multiSheet();
  const before = read(p);
  assert.throws(() => updateSheet(p, { sheet: 0, order: 3 }), /order=3 非法（现有 3 个工作表，可用 0\.\.2）/);
  assert.throws(() => updateSheet(p, { sheet: 0, order: -1 }), /order=-1 非法/);
  assert.throws(() => updateSheet(p, { sheet: 0 }), /至少提供 newName（改名）或 order（调整顺序）之一/);
  assert.equal(read(p), before, '报错不得改文件');

  const r = updateSheet(p, { sheet: 1, newName: '改名表', order: 0 });
  assert.equal(r.newName, '改名表');
  assert.equal(r.order, 0);
  assert.deepEqual(names(p), ['改名表', 'sheet1', 'sheet3']);
  assert.equal(errs(p).length, 0);
  fs.rmSync(d, { recursive: true, force: true });
});

/** 三个属性完全相同的按钮（典型不可达形态） */
function identicalWidgets() {
  const d = tmp();
  const p = path.join(d, 't.cpt');
  createCpt(p, { rows: 2, columns: 2 });
  for (const t of ['甲', '乙', '丙']) addToolbarButton(p, { toolbar: 'page', buttonText: t, js: `act_${t}();` });
  return { d, p };
}

test('update_report_node(index)：属性相同的多节点——无 index 拒绝，有 index 精确命中', () => {
  const { d, p } = identicalWidgets();
  const cls = 'com.fr.form.ui.CustomToolBarButton';
  const rawBefore = read(p);
  assert.equal((rawBefore.match(new RegExp(`<Widget class="${cls}"`, 'g')) || []).length, 3);

  // 无 index：M91 歧义拒绝
  assert.throws(
    () => updateReportNode(p, { nodeName: 'Widget', attributes: { class: cls }, xmlBody: '<Text>\n<![CDATA[X]]></Text>' }),
    /有 3 个候选/,
  );
  // 有 index 但越界
  assert.throws(
    () => updateReportNode(p, { nodeName: 'Widget', attributes: { class: cls }, xmlBody: '<Text>\n<![CDATA[X]]></Text>', index: 3 }),
    /index=3 越界.*共 3 个候选/,
  );
  assert.equal(read(p), rawBefore, '被拒时不得改文件');

  // index=1 → 只替换第 2 个
  const r = updateReportNode(p, {
    nodeName: 'Widget',
    attributes: { class: cls },
    xmlBody: '<Text>\n<![CDATA[MARK]]></Text>',
    index: 1,
  });
  assert.equal(r.nodeName, 'Widget');
  const after = read(p);
  assert.equal((after.match(/MARK/g) || []).length, 1, '只应命中一处');
  assert.ok(after.includes('act_甲();'), '第 1 个按钮应保留');
  assert.ok(!after.includes('act_乙();'), '第 2 个按钮的 JS 应被替换掉');
  assert.ok(after.includes('act_丙();'), '第 3 个按钮应保留');
  assert.equal(errs(p).length, 0);
  fs.rmSync(d, { recursive: true, force: true });
});

test('update_report_node(index)：删除模式同样按序号精确删', () => {
  const { d, p } = identicalWidgets();
  const cls = 'com.fr.form.ui.CustomToolBarButton';
  const r = updateReportNode(p, { nodeName: 'Widget', attributes: { class: cls }, index: 0 });
  assert.equal(r.mode, 'delete');
  const after = read(p);
  assert.equal((after.match(new RegExp(`<Widget class="${cls}"`, 'g')) || []).length, 2, '应只剩 2 个');
  assert.ok(!after.includes('act_甲();'), '第 1 个按钮应被删');
  assert.ok(after.includes('act_乙();') && after.includes('act_丙();'), '其余按钮保留');
  fs.rmSync(d, { recursive: true, force: true });
});

test('update_report_node(index)：index 与 sheet 组合生效（限定工作表内计数）', () => {
  const { d, p } = multiSheet();
  // 每个 sheet 内各注入一个同名节点，index 应在 sheet 范围内计数
  let raw = read(p);
  raw = raw.replace(/<\/Report>/g, '<Foo a="1"/>\n</Report>');
  fs.writeFileSync(p, raw);
  const r = updateReportNode(p, { nodeName: 'Foo', sheet: 1, xmlBody: '<Bar/>', index: 0 });
  assert.ok(['update', 'upsert'].includes(r.mode), r.mode);
  const after = read(p);
  assert.equal((after.match(/<Bar\/>/g) || []).length, 1);
  assert.equal((after.match(/<Foo a="1"\/>/g) || []).length, 2, '另外两个表的 Foo 不应被动');
  fs.rmSync(d, { recursive: true, force: true });
});
