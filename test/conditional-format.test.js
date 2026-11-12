// test/conditional-format.test.js —— 单元格条件属性（条件格式 / Highlight）
//
// 逆向依据（官方 1559 个 .cpt 样本实证）：
//   HighlightList > Highlight{class:...DefaultHighlight} > Name + Condition{FormulaCondition} + HighlightAction{...}
//   条件类型只用 FormulaCondition（1506 次）—— CommonCondition/ObjectCondition 走 <Compare op="N">，
//   但 op 的枚举含义无法从样本反推，安全起见不暴露。
//   动作：BackgroundHighlightAction(570) / ForegroundHighlightAction(192)
//      （数量最多的是 ValueHighlightAction 812，但它是"改值"不是"改样式"，另案支持）
//   公式里 $$$ = 当前单元格值（150 处），row() = 行号；
//   斑马纹写法实测：`row() % 2 = 0`(81) > `row()%2=0`(45) > `row()%2==0`(32) —— 单等号是官方主流。
//   Scope val="1" = 整行（104 处，且都配 row()%2==0），val="2" 仅 1 处。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCpt, addCell, addDataset } from '../lib/generate.js';
import { addCellHighlight } from '../lib/edits.js';
import { generateReport } from '../lib/engine/index.js';
import { validateCpt } from '../lib/validate.js';
import '../scripts/isolate-store.mjs'; // M123：JS 基线 store 隔离，直跑也不污染真实 store

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-cf-'));
const read = (p) => fs.readFileSync(p, 'utf8');
const errCount = (p) => (validateCpt(p)).filter((i) => i.severity === 'error').length;

/**
 * #RRGGBB → FR 的 ARGB 有符号十进制。
 * 故意不复用 lib/edits.js 的 hexToArgb —— 测试要独立算一遍，
 * 否则实现改错了测试也跟着错，等于没验证。
 */
function argb(hex) {
  return String(((0xff000000 | parseInt(hex.slice(1), 16)) | 0));
}

/** 建一个带数据单元格的模板 */
function seed() {
  const d = tmp();
  const p = path.join(d, 'a.cpt');
  createCpt(p, { rows: 3, columns: 3 });
  addDataset(p, { name: 'ds1', connection: 'Doris', sql: 'SELECT 1' });
  addCell(p, { column: 0, row: 1, content: 'X' });
  addCell(p, { column: 1, row: 1, contentType: 'dsColumn', dsName: 'ds1', columnName: 'amt' });
  return { d, p };
}

test('斑马纹：row()%2==0 + 浅背景 + scope row', () => {
  const { d, p } = seed();
  const r = addCellHighlight(p, { column: 0, row: 1, formula: 'row() % 2 = 0', background: '#F2F6FF', scope: 'row' });
  assert.equal(r.action, 'add_cell_highlight');
  assert.deepEqual(r.effects, ['background']);

  const xml = read(p);
  assert.match(xml, /<Highlight class="com\.fr\.report\.cell\.cellattr\.highlight\.DefaultHighlight">/);
  assert.match(xml, /<Condition class="com\.fr\.data\.condition\.FormulaCondition">/);
  assert.match(xml, /<!\[CDATA\[row\(\) % 2 = 0\]\]>/);
  assert.match(xml, /<HighlightAction class="com\.fr\.report\.cell\.cellattr\.highlight\.BackgroundHighlightAction">/);
  assert.match(xml, /<Scope val="1"\/>/, 'scope=row 应写 Scope val=1');
  assert.match(xml, new RegExp(`<Background name="ColorBackground" color="${argb('#F2F6FF')}"/>`), '#F2F6FF → ARGB');
  assert.equal(errCount(p), 0);
  fs.rmSync(d, { recursive: true, force: true });
});

test('负数标红：ForegroundHighlightAction，默认 scope=cell 不写 Scope', () => {
  const { d, p } = seed();
  addCellHighlight(p, { column: 1, row: 1, formula: '$$$ < 0', fontColor: '#FF0000' });
  const xml = read(p);
  assert.match(xml, /<HighlightAction class="com\.fr\.report\.cell\.cellattr\.highlight\.ForegroundHighlightAction">/);
  assert.match(xml, new RegExp(`<Foreground color="${argb('#FF0000')}"/>`), '#FF0000 → ARGB');
  assert.doesNotMatch(xml, /<Scope/, '默认 cell 范围不应写 Scope');
  assert.equal(errCount(p), 0);
  fs.rmSync(d, { recursive: true, force: true });
});

test('位置正确：HighlightList 在 PrivilegeControl 之后、Expand 之前', () => {
  const { d, p } = seed();
  addCellHighlight(p, { column: 1, row: 1, formula: '$$$ > 0', background: '#FFF2CC' });
  const xml = read(p);
  const cStart = xml.indexOf('<C c="1" r="1"');
  const cEnd = xml.indexOf('</C>', cStart);
  const seg = xml.slice(cStart, cEnd);
  assert.ok(seg.indexOf('<PrivilegeControl/>') < seg.indexOf('<HighlightList>'), '应在 PrivilegeControl 之后');
  assert.ok(seg.indexOf('<HighlightList>') < seg.indexOf('<Expand'), '应在 Expand 之前');
  fs.rmSync(d, { recursive: true, force: true });
});

test('多次调用叠加为多条 Highlight，编号递增', () => {
  const { d, p } = seed();
  addCellHighlight(p, { column: 1, row: 1, formula: '$$$ < 0', fontColor: '#FF0000' });
  const r2 = addCellHighlight(p, { column: 1, row: 1, formula: '$$$ > 1000', background: '#FFE8E8', fontColor: '#C00000' });
  assert.equal(r2.highlightCount, 3, '一次调用给了两种效果 → 拆成 2 条；合计 3 条');
  const xml = read(p);
  assert.equal((xml.match(/<HighlightList>/g) || []).length, 1, '不应出现两个 HighlightList 容器');
  assert.equal((xml.match(/<Highlight class=/g) || []).length, 3);
  assert.match(xml, /条件属性1/);
  assert.match(xml, /条件属性2/);
  assert.match(xml, /条件属性3/);
  assert.equal(errCount(p), 0);
  fs.rmSync(d, { recursive: true, force: true });
});

test('自定义条件属性名', () => {
  const { d, p } = seed();
  addCellHighlight(p, { column: 1, row: 1, formula: '$$$ = 0', background: '#EEEEEE', name: '零值置灰' });
  const xml = read(p);
  assert.match(xml, /<!\[CDATA\[零值置灰\]\]>/);
  assert.doesNotMatch(xml, /条件属性1/);
  fs.rmSync(d, { recursive: true, force: true });
});

test('非法输入被引导性拒绝', () => {
  const { d, p } = seed();
  // 缺公式
  assert.throws(() => addCellHighlight(p, { column: 1, row: 1, background: '#FFF' }), /formula|公式/);
  // 缺效果
  assert.throws(() => addCellHighlight(p, { column: 1, row: 1, formula: '$$$ < 0' }), /background|fontColor|效果/);
  // 非法 scope
  assert.throws(() => addCellHighlight(p, { column: 1, row: 1, formula: '$$$ < 0', background: '#FFF', scope: 'column' }),
    /scope|cell|row/);
  // 非法颜色
  assert.throws(() => addCellHighlight(p, { column: 1, row: 1, formula: '$$$ < 0', fontColor: '红' }), /颜色|#RRGGBB/);
  // 缺坐标
  assert.throws(() => addCellHighlight(p, { formula: '$$$ < 0', fontColor: '#FFF' }), /column|row/);
  fs.rmSync(d, { recursive: true, force: true });
});

test('generate_report 默认带斑马纹 + 数值列负数标红', () => {
  const d = tmp();
  const p = path.join(d, 'z.cpt');
  const r = generateReport({
    path: p,
    title: '利润表',
    source: { connection: 'Doris', table: 't_profit' },
    fields: [
      { name: 'dept', label: '部门', type: 'text' },
      { name: 'revenue', label: '收入', type: 'money' },
      { name: 'profit', label: '利润', type: 'money', summary: 'sum' },
      { name: 'stat_date', label: '日期', type: 'date' },
    ],
  });
  assert.equal(r.checkResult.hasError, false, `不应有 error: ${JSON.stringify(r.checkResult.errors ?? r.checkResult)}`);

  const xml = read(p);
  // 4 列都应有斑马纹（公式用官方主流的单等号写法 row() % 2 = 0）
  assert.equal((xml.match(/row\(\) % 2 = 0/g) || []).length, 4, '每列一个斑马纹');
  assert.match(xml, new RegExp(`<Background name="ColorBackground" color="${argb('#F5F8FA')}"/>`),
    'blue 主题斑马纹底色 #F5F8FA（官方样本 TOP1，58 次）');

  // 只有两个 money 列有负数标红（text/date 列不该加）
  assert.equal((xml.match(/\$\$\$ < 0/g) || []).length, 2, '仅 money 类型列加负数标红');
  assert.match(xml, new RegExp(`<Foreground color="${argb('#C00000')}"/>`), '#C00000 → ARGB');

  assert.equal(r.summary.conditionalFormat.zebra, true);
  assert.equal(r.summary.conditionalFormat.negativeRed, true);
  assert.equal(r.summary.conditionalFormat.highlightCount, 6, '4 斑马纹 + 2 标红');
  assert.equal(errCount(p), 0);
  fs.rmSync(d, { recursive: true, force: true });
});

test('generate_report 可关闭斑马纹与负数标红', () => {
  const d = tmp();
  const p = path.join(d, 'n.cpt');
  generateReport({
    path: p,
    source: { connection: 'Doris', table: 't' },
    fields: [{ name: 'a', label: 'A', type: 'money' }],
    options: { zebra: false, negativeRed: false },
  });
  const xml = read(p);
  assert.doesNotMatch(xml, /row\(\) % 2 = 0/);
  assert.doesNotMatch(xml, /\$\$\$ < 0/);
  assert.doesNotMatch(xml, /HighlightList/);
  fs.rmSync(d, { recursive: true, force: true });
});

test('字段级 highlights 叠加在默认效果之上', () => {
  const d = tmp();
  const p = path.join(d, 'h.cpt');
  generateReport({
    path: p,
    source: { connection: 'Doris', table: 't' },
    fields: [
      { name: 'score', label: '得分', type: 'number',
        highlights: [{ formula: '$$$ >= 90', fontColor: '#008000', name: '优秀标绿' }] },
    ],
  });
  const xml = read(p);
  assert.match(xml, /row\(\) % 2 = 0/, '默认斑马纹仍在');
  assert.match(xml, /\$\$\$ >= 90/, '字段自定义条件应保留');
  assert.match(xml, /<!\[CDATA\[优秀标绿\]\]>/);
  assert.equal(errCount(p), 0);
  fs.rmSync(d, { recursive: true, force: true });
});
