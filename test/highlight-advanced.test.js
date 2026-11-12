// test/highlight-advanced.test.js —— 条件属性进阶：条件改值 / 条件改字体 / 比较条件 / 多条件组合
//
// 逆向依据（官方 1559 个模板实证）：
//   HighlightAction 类型频次：ValueHighlightAction(812) > BackgroundHighlightAction(570)
//     > RowHeightHighlightAction(341) > FRFontHighlightAction(223) > ForegroundHighlightAction(192)
//   ValueHighlightAction 写法：<O t="XMLable" class="com.fr.base.Formula"><Attributes><![CDATA[=公式]]></Attributes></O>（596/643）
//   Condition 类型频次：FormulaCondition(1351) > ObjectCondition(403) > ListCondition(378)
//   Compare.op 枚举来自官方常量（javap -constants com.fr.data.core.Compare），
//     且被样本语义交叉验证：op=4(LESS_THAN) 的值几乎全是 0（296 次）→ 就是 "$$$ < 0"
//   ListCondition：<JoinCondition join="0"> 嵌套子 Condition；join=0 占 551，join=1 占 23
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCpt, addCell, addDataset } from '../lib/generate.js';
import { addCellHighlight, highlightActionBody, COMPARE_OPS } from '../lib/edits.js';
import { validateCpt } from '../lib/validate.js';
import '../scripts/isolate-store.mjs'; // M123：JS 基线 store 隔离，直跑也不污染真实 store

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-hl-'));
const read = (p) => fs.readFileSync(p, 'utf8');
const errCount = (p) => (validateCpt(p)).filter((i) => i.severity === 'error').length;

function seed() {
  const d = tmp();
  const p = path.join(d, 'a.cpt');
  createCpt(p, { rows: 3, columns: 3 });
  addDataset(p, { name: 'ds1', connection: 'Doris', sql: 'SELECT 1' });
  addCell(p, { column: 1, row: 1, contentType: 'dsColumn', dsName: 'ds1', columnName: 'amt' });
  return { d, p };
}
/** 取 (1,1) 单元格内的 XML 片段 */
const cellXml = (xml) => {
  const s = xml.indexOf('<C c="1" r="1"');
  return xml.slice(s, xml.indexOf('</C>', s));
};

test('条件改值：ValueHighlightAction + XMLable Formula', () => {
  const { d, p } = seed();
  const r = addCellHighlight(p, { column: 1, row: 1, formula: '$$$ > 1000', value: '大额' });
  assert.deepEqual(r.effects, ['value']);
  assert.equal(r.condition, 'formula');

  const xml = read(p);
  assert.match(xml, /<HighlightAction class="com\.fr\.report\.cell\.cellattr\.highlight\.ValueHighlightAction">/);
  assert.match(xml, /<O t="XMLable" class="com\.fr\.base\.Formula">/);
  assert.match(xml, /<!\[CDATA\[="大额"\]\]>/, '纯文本自动包成 ="文本" 公式');
  assert.equal(errCount(p), 0);
  fs.rmSync(d, { recursive: true, force: true });
});

test('条件改值：公式原样透传（不重复加等号）', () => {
  const { d, p } = seed();
  addCellHighlight(p, { column: 1, row: 1, formula: '$b = 1', value: '=sum(F4)' });
  const xml = read(p);
  assert.match(xml, /<!\[CDATA\[=sum\(F4\)\]\]>/);
  assert.doesNotMatch(xml, /==sum/, '已带 = 的公式不应再加前缀');
  fs.rmSync(d, { recursive: true, force: true });
});

test('条件改字体：FRFontHighlightAction，size = pt × 4', () => {
  const { d, p } = seed();
  const r = addCellHighlight(p, { column: 1, row: 1, formula: '$$$ > 1000', bold: true, fontSizePt: 14, fontName: '微软雅黑' });
  assert.deepEqual(r.effects, ['font']);
  const xml = read(p);
  assert.match(xml, /<HighlightAction class="com\.fr\.report\.cell\.cellattr\.highlight\.FRFontHighlightAction">/);
  // 官方 FRFont 属性顺序为 name → style → size；size 单位是 1/4 磅
  assert.match(xml, /<FRFont name="微软雅黑" style="1" size="56"\/>/, 'bold → style=1，14pt → size=56');
  assert.equal(errCount(p), 0);
  fs.rmSync(d, { recursive: true, force: true });
});

test('条件字体：非粗体 style=0；bold 只接受布尔', () => {
  const { d, p } = seed();
  addCellHighlight(p, { column: 1, row: 1, formula: '$$$ > 0', bold: false, fontSizePt: 11 });
  assert.match(read(p), /style="0" size="44"/, '11pt → 44（pt × 4）');

  // bold:"yes" 这类笔误必须被拦下，否则会被真值判断静默当成加粗
  assert.throws(
    () => addCellHighlight(p, { column: 1, row: 1, formula: '$$$ > 0', bold: 'yes' }),
    /bold 只接受 true \/ false/
  );
  fs.rmSync(d, { recursive: true, force: true });
});

test('比较条件：ObjectCondition + Compare op（枚举来自官方常量）', () => {
  const { d, p } = seed();
  const r = addCellHighlight(p, { column: 1, row: 1, compare: { op: 'lt', value: 0 }, fontColor: '#FF0000' });
  assert.equal(r.condition, 'compare:lt');
  const xml = read(p);
  assert.match(xml, /<Condition class="com\.fr\.data\.condition\.ObjectCondition">/);
  assert.match(xml, new RegExp(`<Compare op="${COMPARE_OPS.lt}">`), 'lt → op=4（LESS_THAN）');
  assert.match(xml, /<O t="I">\s*<\!\[CDATA\[0\]\]>\s*<\/O>/, '整数用 t="I"');
  assert.match(xml, /<HighlightAction class="[^"]*ForegroundHighlightAction">/);
  assert.equal(errCount(p), 0);
  fs.rmSync(d, { recursive: true, force: true });
});

test('比较条件：小数 t="D"、字符串裸 <O>、符号别名', () => {
  const { d, p } = seed();
  // 小数
  addCellHighlight(p, { column: 1, row: 1, compare: { op: 'gt', value: 0.55 }, background: '#FFE8E8' });
  assert.match(read(p), /<O t="D">\s*<\!\[CDATA\[0\.55\]\]>/, '小数用 t="D"');

  // 符号别名 + 字符串
  addCellHighlight(p, { column: 1, row: 1, compare: { op: '=', value: '已完成' }, fontColor: '#008000' });
  const xml = read(p);
  assert.match(xml, /<Compare op="0">/, "'=' 归一化成 eq → op=0");
  assert.match(xml, /<O>\s*<\!\[CDATA\[已完成\]\]>\s*<\/O>/, '字符串用裸 <O>');
  assert.equal(errCount(p), 0);
  fs.rmSync(d, { recursive: true, force: true });
});

test('多条件组合：ListCondition + JoinCondition', () => {
  const { d, p } = seed();
  const r = addCellHighlight(p, {
    column: 1, row: 1,
    conditions: [{ formula: '$$$ < 0' }, { formula: 'len(C7) != 0' }],
    logic: 'and',
    background: '#FFE8E8',
  });
  assert.equal(r.condition, 'list:and(2)');
  assert.deepEqual(r.effects, ['background']);

  const seg = cellXml(read(p));
  assert.match(seg, /<Condition class="com\.fr\.data\.condition\.ListCondition">/);
  assert.equal((seg.match(/<JoinCondition join="0">/g) || []).length, 2, 'and → join=0');
  assert.equal((seg.match(/<Condition class="com\.fr\.data\.condition\.FormulaCondition">/g) || []).length, 2);
  assert.equal((seg.match(/<HighlightList>/g) || []).length, 1, '只有 1 条 Highlight，条件挂在它内部');
  assert.equal(errCount(p), 0);
  fs.rmSync(d, { recursive: true, force: true });
});

test('多条件组合：logic=or → join=1，子条件可用 compare', () => {
  const { d, p } = seed();
  const r = addCellHighlight(p, {
    column: 1, row: 1,
    conditions: [{ compare: { op: 'lt', value: 0 } }, { compare: { op: 'contains', value: '异常' } }],
    logic: 'or',
    fontColor: '#C00000',
  });
  assert.equal(r.condition, 'list:or(2)');
  const seg = cellXml(read(p));
  assert.equal((seg.match(/<JoinCondition join="1">/g) || []).length, 2, 'or → join=1');
  assert.match(seg, new RegExp(`<Compare op="${COMPARE_OPS.contains}">`), 'contains → op=10');
  assert.equal(errCount(p), 0);
  fs.rmSync(d, { recursive: true, force: true });
});

test('多种效果并存：一次调用生成多条 Highlight', () => {
  const { d, p } = seed();
  const r = addCellHighlight(p, {
    column: 1, row: 1,
    formula: '$$$ < 0',
    background: '#FFE8E8', fontColor: '#C00000', bold: true, value: '亏损',
  });
  assert.deepEqual(r.effects, ['background', 'fontColor', 'value', 'font']);
  assert.equal(r.highlightCount, 4);
  const seg = cellXml(read(p));
  assert.equal((seg.match(/<Highlight class=/g) || []).length, 4);
  // 四条共用同一个 Condition
  assert.equal((seg.match(/<Formula>\s*<\!\[CDATA\[\$\$\$ < 0\]\]>/g) || []).length, 4);
  assert.equal(errCount(p), 0);
  fs.rmSync(d, { recursive: true, force: true });
});

test('安全围栏：条件/效果的非法组合被引导性拒绝', () => {
  const { d, p } = seed();

  // 三种条件混用
  assert.throws(
    () => addCellHighlight(p, { column: 1, row: 1, formula: '$$$ < 0', compare: { op: 'lt', value: 0 }, background: '#FFF' }),
    /formula \/ compare \/ conditions 三者只能用一种/
  );
  // 完全不给条件
  assert.throws(
    () => addCellHighlight(p, { column: 1, row: 1, background: '#FFFFFF' }),
    /必须给条件，三选一/
  );
  // 不给效果
  assert.throws(
    () => addCellHighlight(p, { column: 1, row: 1, formula: '$$$ < 0' }),
    /至少给一个效果/
  );
  // 非法比较运算符
  assert.throws(
    () => addCellHighlight(p, { column: 1, row: 1, compare: { op: 'between', value: 1 }, fontColor: '#FFF' }),
    /compare\.op="between" 不支持/
  );
  // compare 缺 value
  assert.throws(
    () => addCellHighlight(p, { column: 1, row: 1, compare: { op: 'lt' }, fontColor: '#FFF' }),
    /compare 必须给 value/
  );
  // 空 conditions 数组
  assert.throws(
    () => addCellHighlight(p, { column: 1, row: 1, conditions: [], background: '#FFF' }),
    /必须给条件/
  );
  // 非法 logic
  assert.throws(
    () => addCellHighlight(p, {
      column: 1, row: 1, logic: 'xor',
      conditions: [{ formula: '$$$ < 0' }, { formula: '$$$ > 0' }], background: '#FFF',
    }),
    /logic="xor" 非法/
  );
  fs.rmSync(d, { recursive: true, force: true });
});

test('安全围栏：条件字体的 style 只放行 0/1（官方 223 例只有这两值）', () => {
  const { d, p } = seed();
  // 库函数直接调用时，非法 style 也要被挡住
  assert.throws(
    () => highlightActionBody('font', { style: 2, sizePt: 12 }, 'cell'),
    /style 只支持 0（常规）\/ 1（粗体）/
  );
  // 合法值可通过
  assert.match(highlightActionBody('font', { style: 1, sizePt: 12 }, 'cell'), /style="1" size="48"/);
  fs.rmSync(d, { recursive: true, force: true });
});
