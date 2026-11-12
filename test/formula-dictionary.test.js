// test/formula-dictionary.test.js —— M117 公式数据字典（com.fr.data.impl.FormulaDictionary）全路径
//
// 背景（t1 独立复核裁决 · 主张 2 的初判漏项，队长独立复验属实）：
//  - 官方语料 `com.fr.data.impl.FormulaDictionary` 共 **37 块**（参数面板侧 25 / 单元格控件侧 12）；
//  - 官方两种形态：带 <EFormulaDict>（12 块）与仅有 <FormulaDict>（25 块）；
//  - 现状（修前）：`dictionary.type` 三处枚举（参数控件 / add_cell / update_cell_dictionary）都只有
//    db|table|custom，formula 在 add 与 update、参数面板与单元格**全部路径**都不通。
//
// 本文件锁定：
//  ① dictionaryXml 产出与官方 37 块逐字节同构（含仅有 FormulaDict 的边界形态）；
//  ② 单元格侧 add（add_cell widgetDictionary）与 update（update_cell_dictionary：整块换 + 原位改）全通；
//  ③ 参数面板侧 add（add_parameter_widget）与 update（update_parameter_widget）全通；
//  ④ 空 EFormulaDict 边界形态处理（保留 / 替换 / 清空删除）；
//  ⑤ 外科性：只动 <Dictionary> 块，控件其余字节逐字节不变；
//  ⑥ 幂等：内容一致 → mode:'none' 且零字节改动；
//  ⑦ 真实 MCP 端到端（StdioClientTransport 起 server.js），断言落在落盘 XML 上。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createCpt, addCell, addDataset, addParameterWidget, setParameterPanel } from '../lib/generate.js';
import { dictionaryXml, updateCellDictionary, getCellDictionary, updateParameterWidget } from '../lib/edits.js';
import { SPEC_SECTIONS } from '../lib/contract.js';
import { validateCpt } from '../lib/validate.js';
import '../scripts/isolate-store.mjs'; // M123：JS 基线 store 隔离，直跑也不污染真实 store

delete process.env.CPT_MCP_ALLOWED_ROOTS;

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-formuladict-'));
const errCount = (p) => validateCpt(p).filter((x) => x.severity === 'error').length;
// 官方语料根（与 test/fr-js-escape.test.js 同口径：FR_HOME 优先，缺省 D:/FineReport_11.0）
const FR_ROOT = process.env.FR_HOME
  ? path.join(process.env.FR_HOME, 'webapps/webroot/WEB-INF/reportlets')
  : 'D:/FineReport_11.0/webapps/webroot/WEB-INF/reportlets';

// ---- 官方原文（本机 FR 11.0 语料抽取，逐字节） ----
// demo/analytics/hr/员工变化查询分析.cpt（带 EFormulaDict 形态）
const OFFICIAL_WITH_E = `<Dictionary class="com.fr.data.impl.FormulaDictionary">
<FormulaDict>
<![CDATA[=range(2010,2012)]]></FormulaDict>
<EFormulaDict>
<![CDATA[=$$$+'年']]></EFormulaDict>
</Dictionary>`;
// demo/form/固定资产(增删改).cpt（仅有 FormulaDict 形态）
const OFFICIAL_ONLY_F = `<Dictionary class="com.fr.data.impl.FormulaDictionary">
<FormulaDict>
<![CDATA[=value('Embedded1',2,1,@1)]]></FormulaDict>
</Dictionary>`;
// demo/parameter/下拉树与动态查询.cpt
const OFFICIAL_MONTHS = `<Dictionary class="com.fr.data.impl.FormulaDictionary">
<FormulaDict>
<![CDATA[=range(1,12)]]></FormulaDict>
<EFormulaDict>
<![CDATA[=$$$+"月份"]]></EFormulaDict>
</Dictionary>`;
// 空 EFormulaDict 边界（官方 37 块里没有，但结构上必须能处理）
const EMPTY_E_FORM = `<Dictionary class="com.fr.data.impl.FormulaDictionary">
<FormulaDict>
<![CDATA[=range(1,12)]]></FormulaDict>
<EFormulaDict>
<![CDATA[]]></EFormulaDict>
</Dictionary>`;

function cellBlock(raw, col, row) {
  const m = raw.match(new RegExp(`<C c="${col}" r="${row}"[\\s\\S]*?</C>`));
  return m ? m[0] : null;
}
function innerBlockOf(raw, name) {
  const s = raw.indexOf('<ReportParameterAttr>');
  const e = raw.indexOf('</ReportParameterAttr>', s);
  const seg = raw.slice(s, e);
  const re = /<InnerWidget\b[^>]*>[\s\S]*?<\/InnerWidget>/g;
  let m;
  while ((m = re.exec(seg)) !== null) if (m[0].includes(`<WidgetName name="${name}"/>`)) return m[0];
  return null;
}
function splitAtDictionary(raw) {
  const m = /<Dictionary\b[\s\S]*?<\/Dictionary>/.exec(raw);
  if (!m) throw new Error('无 <Dictionary> 块');
  return [raw.slice(0, m.index), m[0], raw.slice(m.index + m[0].length)];
}

test('M117 ①dictionaryXml 公式字典与官方 37 块逐字节同构（含仅有 FormulaDict 形态）', () => {
  assert.equal(
    dictionaryXml({ dictionary: { type: 'formula', formula: '=range(2010,2012)', eFormula: "=$$$+'年'" }, label: 't' }),
    OFFICIAL_WITH_E,
  );
  assert.equal(
    dictionaryXml({ dictionary: { type: 'formula', formula: "=value('Embedded1',2,1,@1)" }, label: 't' }),
    OFFICIAL_ONLY_F,
  );
  assert.equal(
    dictionaryXml({ dictionary: { type: 'formula', formula: '=range(1,12)', eFormula: '=$$$+"月份"' }, label: 't' }),
    OFFICIAL_MONTHS,
  );
  // eFormula 空串同样落"仅有 FormulaDict"形态（不写空块）
  assert.equal(dictionaryXml({ dictionary: { type: 'formula', formula: "=value('Embedded1',2,1,@1)", eFormula: '' }, label: 't' }), OFFICIAL_ONLY_F);
  // formula 必填
  assert.throws(() => dictionaryXml({ dictionary: { type: 'formula' }, label: 't' }), /必须提供 formula/);
});

test('M117 ②单元格 add 路：add_cell widgetDictionary=formula 落盘官方同构', () => {
  const d = tmp();
  const p = path.join(d, 'a.cpt');
  createCpt(p, { rows: 3, columns: 6 });
  addCell(p, { column: 0, row: 0, widget: 'comboBox', widgetDictionary: { type: 'formula', formula: '=range(2010,2012)', eFormula: "=$$$+'年'" }, sheet: 0 });
  addCell(p, { column: 1, row: 0, widget: 'comboBox', widgetDictionary: { type: 'formula', formula: "=value('Embedded1',2,1,@1)" }, sheet: 0 });
  const raw = fs.readFileSync(p, 'utf8');
  assert.ok(cellBlock(raw, 0, 0).includes(OFFICIAL_WITH_E), '带 EFormulaDict 形态落盘');
  assert.ok(cellBlock(raw, 1, 0).includes(OFFICIAL_ONLY_F), '仅有 FormulaDict 形态落盘');
  assert.ok(cellBlock(raw, 0, 0).includes('com.fr.form.ui.ComboBox'), '控件类不变');
  assert.equal(getCellDictionary(p, { column: 0, row: 0, sheet: 0 }).kind, 'formula', 'get_cell_dictionary 能读回 formula');
  assert.equal(getCellDictionary(p, { column: 0, row: 0, sheet: 0 }).eFormula, "=$$$+'年'");
  assert.equal(getCellDictionary(p, { column: 1, row: 0, sheet: 0 }).eFormula, null, '仅有 FormulaDict 时 eFormula=null');
  assert.equal(errCount(p), 0);
  // 围栏：formula 必填 + 非法类型
  assert.throws(() => addCell(p, { column: 2, row: 0, widget: 'comboBox', widgetDictionary: { type: 'formula' }, sheet: 0 }), /必须提供 formula/);
  assert.throws(() => addCell(p, { column: 2, row: 0, widget: 'comboBox', widgetDictionary: { type: 'bogus' }, sheet: 0 }), /只能是 table/);
  fs.rmSync(d, { recursive: true, force: true });
});

test('M117 ③单元格 update 路：整块换 formula + 原位改 formula/eFormula + 幂等 + 外科性', () => {
  const d = tmp();
  const p = path.join(d, 'a.cpt');
  createCpt(p, { rows: 3, columns: 6 });
  // 起始：自定义项下拉 → 就地整块换成公式字典
  addCell(p, { column: 2, row: 1, widget: 'comboBox', widgetItems: [{ key: 'a', value: 'A' }], sheet: 0 });
  // 注入官方 <Reg> 形态（com.fr.form.ui.reg.NoneReg 官方 1109 例）与监听占位，证明改字典不碰它们
  {
    const raw0 = fs.readFileSync(p, 'utf8').replace(
      '<Widget class="com.fr.form.ui.ComboBox">\n',
      '<Widget class="com.fr.form.ui.ComboBox">\n<Reg class="com.fr.form.ui.reg.NoneReg"/>\n',
    );
    fs.writeFileSync(p, raw0);
    assert.ok(cellBlock(raw0, 2, 1).includes('<Reg class="com.fr.form.ui.reg.NoneReg"/>'), '前置：<Reg> 已就位');
  }
  const r1 = updateCellDictionary(p, { column: 2, row: 1, sheet: 0, dictionary: { type: 'formula', formula: "=value('Embedded1',2,1,@1)" } });
  assert.equal(r1.mode, 'replace');
  assert.equal(r1.before.kind, 'custom');
  assert.equal(r1.after.kind, 'formula');
  let raw = fs.readFileSync(p, 'utf8');
  assert.ok(cellBlock(raw, 2, 1).includes(OFFICIAL_ONLY_F), '整块换成官方仅有 FormulaDict 形态');
  // 幂等
  const before = fs.readFileSync(p, 'utf8');
  const r2 = updateCellDictionary(p, { column: 2, row: 1, sheet: 0, dictionary: { type: 'formula', formula: "=value('Embedded1',2,1,@1)" } });
  assert.equal(r2.mode, 'none');
  assert.equal(fs.readFileSync(p, 'utf8'), before, '幂等不得改文件');
  // 原位改 formula（保持仅有 FormulaDict 形态）
  const r3 = updateCellDictionary(p, { column: 2, row: 1, sheet: 0, formula: '=range(1,12)' });
  assert.equal(r3.mode, 'update');
  assert.deepEqual(r3.after, { class: 'FormulaDictionary', formula: '=range(1,12)', eFormula: null });
  raw = fs.readFileSync(p, 'utf8');
  assert.ok(cellBlock(raw, 2, 1).includes('<![CDATA[=range(1,12)]]></FormulaDict>'), 'FormulaDict 已原位改');
  assert.ok(!cellBlock(raw, 2, 1).includes('<EFormulaDict>'), '未传 eFormula 时不新增 EFormulaDict 块');
  // 原位补 EFormulaDict
  const r4 = updateCellDictionary(p, { column: 2, row: 1, sheet: 0, eFormula: '=$$$+"月份"' });
  assert.equal(r4.mode, 'update');
  raw = fs.readFileSync(p, 'utf8');
  assert.ok(cellBlock(raw, 2, 1).includes(OFFICIAL_MONTHS), '补 EFormulaDict 后与官方带 E 形态同构');
  // 外科性：只动 <Dictionary> 块
  const [pre, , post] = splitAtDictionary(raw);
  updateCellDictionary(p, { column: 2, row: 1, sheet: 0, formula: '=range(2010,2012)' });
  const after2 = fs.readFileSync(p, 'utf8');
  const [pre2, , post2] = splitAtDictionary(after2);
  assert.equal(pre2, pre, '字典块之前字节逐字节不变');
  assert.equal(post2, post, '字典块之后字节逐字节不变');
  assert.ok(cellBlock(after2, 2, 1).includes('com.fr.form.ui.ComboBox'), '控件类保留');
  assert.ok(cellBlock(after2, 2, 1).includes('<Reg class="com.fr.form.ui.reg.NoneReg"/>'), '<Reg> 原样保留');
  assert.ok(cellBlock(after2, 2, 1).includes('<widgetValue>'), 'widgetValue 保留');
  assert.equal(errCount(p), 0);
  fs.rmSync(d, { recursive: true, force: true });
});

test('M117 ④空 EFormulaDict 边界：不碰时保留 / 传值替换 / 传空串删除回官方形态', () => {
  const d = tmp();
  const p = path.join(d, 'a.cpt');
  createCpt(p, { rows: 3, columns: 6 });
  addCell(p, { column: 3, row: 2, widget: 'comboBox', widgetDictionary: { type: 'formula', formula: '=range(1,12)' }, sheet: 0 });
  // 人为写成空 EFormulaDict（结构上合法、官方无样本的边界形态）
  let raw = fs.readFileSync(p, 'utf8').replace(
    `<Dictionary class="com.fr.data.impl.FormulaDictionary">
<FormulaDict>
<![CDATA[=range(1,12)]]></FormulaDict>
</Dictionary>`,
    EMPTY_E_FORM,
  );
  fs.writeFileSync(p, raw);
  assert.ok(cellBlock(fs.readFileSync(p, 'utf8'), 3, 2).includes(EMPTY_E_FORM), '前置：空 EFormulaDict 已就位');
  assert.equal(getCellDictionary(p, { column: 3, row: 2, sheet: 0 }).eFormula, '', '读回空 EFormulaDict 得到空串（不崩）');
  // 只改 formula，不碰 eFormula → 空块原样保留
  const r1 = updateCellDictionary(p, { column: 3, row: 2, sheet: 0, formula: '=range(2010,2012)' });
  assert.equal(r1.mode, 'update');
  raw = fs.readFileSync(p, 'utf8');
  assert.ok(cellBlock(raw, 3, 2).includes('<EFormulaDict>\n<![CDATA[]]></EFormulaDict>'), '未传 eFormula 时空块原样保留');
  // 传 eFormula → 替换空块
  const r2 = updateCellDictionary(p, { column: 3, row: 2, sheet: 0, eFormula: "=$$$+'年'" });
  assert.equal(r2.mode, 'update');
  raw = fs.readFileSync(p, 'utf8');
  assert.ok(cellBlock(raw, 3, 2).includes(OFFICIAL_WITH_E), '空块被替换为官方带 E 形态');
  // 传 eFormula='' → 删除块，回到官方"仅有 FormulaDict"形态
  const r3 = updateCellDictionary(p, { column: 3, row: 2, sheet: 0, eFormula: '' });
  assert.equal(r3.mode, 'update');
  assert.equal(r3.after.eFormula, null);
  raw = fs.readFileSync(p, 'utf8');
  assert.ok(cellBlock(raw, 3, 2).includes(`<Dictionary class="com.fr.data.impl.FormulaDictionary">
<FormulaDict>
<![CDATA[=range(2010,2012)]]></FormulaDict>
</Dictionary>`), '清空 eFormula 后回到官方仅有 FormulaDict 形态');
  // 再清一次幂等
  const before = fs.readFileSync(p, 'utf8');
  assert.equal(updateCellDictionary(p, { column: 3, row: 2, sheet: 0, eFormula: '' }).mode, 'none');
  assert.equal(fs.readFileSync(p, 'utf8'), before);
  assert.equal(errCount(p), 0);
  fs.rmSync(d, { recursive: true, force: true });
});

test('M117 ⑤参数面板 add/update 路：formula 全通（含原位改与清空）', () => {
  const d = tmp();
  const p = path.join(d, 'a.cpt');
  createCpt(p, { rows: 3, columns: 3 });
  setParameterPanel(p, { title: '查询' });
  addDataset(p, { name: 'ds1', connection: 'Doris', sql: 'SELECT 1' });
  // add 路：面板控件直接建公式字典
  addParameterWidget(p, { name: 'year', type: 'comboBox', label: '年份：', dictionary: { type: 'formula', formula: '=range(2010,2012)', eFormula: "=$$$+'年'" }, x: 10, y: 10, width: 120, height: 24 });
  let raw = fs.readFileSync(p, 'utf8');
  assert.ok(innerBlockOf(raw, 'year').includes(OFFICIAL_WITH_E), '面板 add 路落盘官方同构');
  // update 路：原位改 formula（不碰 eFormula —— 原 eFormula 原样保留）
  const r1 = updateParameterWidget(p, { name: 'year', formula: '=range(1,12)' });
  assert.equal(r1.mode, 'update');
  assert.equal(r1.dictAfter.kind, 'formula');
  assert.equal(r1.dictAfter.formula, '=range(1,12)');
  assert.equal(r1.dictAfter.eFormula, "=$$$+'年'", '未传 eFormula 时原显示公式保留（含 $$$ 未被吞）');
  raw = fs.readFileSync(p, 'utf8');
  assert.ok(innerBlockOf(raw, 'year').includes(`<FormulaDict>
<![CDATA[=range(1,12)]]></FormulaDict>
<EFormulaDict>
<![CDATA[=$$$+'年']]></EFormulaDict>`), '面板原位改公式：FormulaDict 已改、EFormulaDict 原样');
  // 原位改 eFormula（$$$ 必须原样落盘）
  const r2 = updateParameterWidget(p, { name: 'year', eFormula: '=$$$+"月份"' });
  assert.equal(r2.mode, 'update');
  raw = fs.readFileSync(p, 'utf8');
  assert.ok(innerBlockOf(raw, 'year').includes(OFFICIAL_MONTHS), '面板原位改显示公式与官方同构');
  // 同值再设 → 幂等
  assert.equal(updateParameterWidget(p, { name: 'year', eFormula: '=$$$+"月份"' }).mode, 'none');
  // 整块换回自定义项，再换回公式（可逆）
  updateParameterWidget(p, { name: 'year', dictionary: { type: 'custom', items: [{ key: 'a', value: 'A' }] } });
  const r3 = updateParameterWidget(p, { name: 'year', dictionary: { type: 'formula', formula: '=range(1,12)', eFormula: '=$$$+"月份"' } });
  assert.equal(r3.mode, 'replace');
  raw = fs.readFileSync(p, 'utf8');
  assert.ok(innerBlockOf(raw, 'year').includes(OFFICIAL_MONTHS));
  // 清空 eFormula → 官方仅有 FormulaDict 形态
  assert.equal(updateParameterWidget(p, { name: 'year', eFormula: '' }).mode, 'update');
  raw = fs.readFileSync(p, 'utf8');
  assert.ok(innerBlockOf(raw, 'year').includes(`<Dictionary class="com.fr.data.impl.FormulaDictionary">
<FormulaDict>
<![CDATA[=range(1,12)]]></FormulaDict>
</Dictionary>`));
  assert.equal(errCount(p), 0);
  fs.rmSync(d, { recursive: true, force: true });
});

test('M117 ⑥围栏：类型不匹配拒绝（公式字典不接受 items/ki/vi/table；表字典不接受公式）', () => {
  const d = tmp();
  const p = path.join(d, 'a.cpt');
  createCpt(p, { rows: 3, columns: 6 });
  addDataset(p, { name: 'ds1', connection: 'Doris', sql: 'SELECT 1' });
  addCell(p, { column: 4, row: 1, widget: 'comboBox', widgetDictionary: { type: 'formula', formula: '=range(1,12)' }, sheet: 0 });
  addCell(p, { column: 5, row: 1, widget: 'comboBox', widgetDictionary: { type: 'table', dsName: 'ds1', kiName: 'a', viName: 'b' }, sheet: 0 });
  assert.throws(() => updateCellDictionary(p, { column: 4, row: 1, sheet: 0, items: [{ key: 'a', value: 'A' }] }), /不接受 items\/kiName\/viName\/table/);
  assert.throws(() => updateCellDictionary(p, { column: 4, row: 1, sheet: 0, kiName: 'a' }), /不接受 items\/kiName\/viName\/table/);
  assert.throws(() => updateCellDictionary(p, { column: 5, row: 1, sheet: 0, formula: '=1' }), /不接受 items\/公式/);
  assert.throws(() => updateCellDictionary(p, { column: 4, row: 1, sheet: 0, dictionary: { type: 'formula' } }), /必须提供 formula/);
  assert.throws(() => updateCellDictionary(p, { column: 4, row: 1, sheet: 0, dictionary: { type: 'bogus' } }), /dictionary.type 只能是/);
  assert.throws(() => updateCellDictionary(p, { column: 4, row: 1, sheet: 0, formula: '' }), /不接受空字符串/);
  fs.rmSync(d, { recursive: true, force: true });
});

test('M117-r2 F9 测试锁：字典块【原位】改公式必须函数式替换（$$$ 原样落盘；回退成字符串替换即变红）', () => {
  const d = tmp();
  const p = path.join(d, 'f9.cpt');
  createCpt(p, { rows: 3, columns: 6 });
  // 起始：自定义项 → 公式字典（整块换，dictionaryXml 路）
  addCell(p, { column: 0, row: 0, widget: 'comboBox', widgetItems: [{ key: 'a', value: 'A' }], sheet: 0 });
  updateCellDictionary(p, { column: 0, row: 0, sheet: 0, dictionary: { type: 'formula', formula: '=range(1,12)' } });
  // ① 原位【插入】EFormulaDict —— 载荷含 $$$（字符串式会静默吞成 $$）
  updateCellDictionary(p, { column: 0, row: 0, sheet: 0, eFormula: "=$$$+'年'" });
  let raw = fs.readFileSync(p, 'utf8');
  assert.ok(cellBlock(raw, 0, 0).includes("<![CDATA[=$$$+'年']]>"), '原位插入 eFormula 的 $$$ 必须原样落盘');
  // ② 原位【替换】FormulaDict
  updateCellDictionary(p, { column: 0, row: 0, sheet: 0, formula: "=$$$+'年'" });
  raw = fs.readFileSync(p, 'utf8');
  assert.ok(cellBlock(raw, 0, 0).includes("<![CDATA[=$$$+'年']]></FormulaDict>"), '原位改 formula 的 $$$ 必须原样落盘');
  // ③ 原位【替换】EFormulaDict
  updateCellDictionary(p, { column: 0, row: 0, sheet: 0, eFormula: '=$$$+"月份"' });
  raw = fs.readFileSync(p, 'utf8');
  assert.ok(cellBlock(raw, 0, 0).includes('<![CDATA[=$$$+"月份"]]></EFormulaDict>'), '原位改 eFormula 的 $$$ 必须原样落盘');
  // ④ 参数面板侧原位改（formula 替换 + eFormula 插入）
  setParameterPanel(p, { title: '查询' });
  addParameterWidget(p, { name: 'year', type: 'comboBox', dictionary: { type: 'formula', formula: '=range(1,12)' } });
  updateParameterWidget(p, { name: 'year', formula: "=$$$+'年'" });
  updateParameterWidget(p, { name: 'year', eFormula: '=$$$+"月份"' });
  raw = fs.readFileSync(p, 'utf8');
  assert.ok(innerBlockOf(raw, 'year').includes("<![CDATA[=$$$+'年']]></FormulaDict>"), '面板原位改 formula 的 $$$ 必须原样落盘');
  assert.ok(innerBlockOf(raw, 'year').includes('<![CDATA[=$$$+"月份"]]></EFormulaDict>'), '面板原位改 eFormula 的 $$$ 必须原样落盘');
  assert.equal(errCount(p), 0);
  fs.rmSync(d, { recursive: true, force: true });
});

test('M117 ⑨官方语料实证：真实模板里的 FormulaDictionary 可就地改公式（只动字典块，$$$ 原样）', { skip: !fs.existsSync(FR_ROOT) }, () => {
  // 样本：demo/parameter/下拉树与动态查询.cpt（官方原文 =range(1,12) + =$$$+"月份"，全文件仅此 1 块）
  const src = path.join(FR_ROOT, 'demo/parameter/下拉树与动态查询.cpt');
  if (!fs.existsSync(src)) return; // 语料版本差异：样本缺失则不做断言（不臆造证据）
  const d = tmp();
  const p = path.join(d, 'official.cpt');
  fs.copyFileSync(src, p);
  const raw0 = fs.readFileSync(p, 'utf8');
  assert.ok(raw0.includes(OFFICIAL_MONTHS), '官方样本应含公式字典原文 =range(1,12) / =$$$+"月份"');
  const idx = raw0.indexOf(OFFICIAL_MONTHS);
  // 定位持有该字典的面板控件名
  const s = raw0.indexOf('<ReportParameterAttr>');
  const e = raw0.indexOf('</ReportParameterAttr>', s);
  const re = /<InnerWidget\b[^>]*>[\s\S]*?<\/InnerWidget>/g;
  let m;
  let owner = null;
  while ((m = re.exec(raw0.slice(s, e))) !== null) {
    if (m[0].includes(OFFICIAL_MONTHS)) { owner = (m[0].match(/<WidgetName name="([^"]+)"/) || [])[1]; break; }
  }
  assert.ok(owner, '应能定位持有公式字典的面板控件');
  const errBefore = errCount(p);
  const r = updateParameterWidget(p, { name: owner, formula: '=range(2010,2012)' });
  assert.equal(r.mode, 'update');
  assert.equal(r.dictAfter.formula, '=range(2010,2012)');
  assert.equal(r.dictAfter.eFormula, '=$$$+"月份"', '显示公式（含 $$$）原样保留');
  const after = fs.readFileSync(p, 'utf8');
  const NEW = OFFICIAL_MONTHS.replace('=range(1,12)', '=range(2010,2012)');
  assert.equal(after, raw0.slice(0, idx) + NEW + raw0.slice(idx + OFFICIAL_MONTHS.length), '官方文件除该字典块外逐字节不变');
  assert.equal(errCount(p), errBefore, '改后结构校验错误数不增加');
  fs.rmSync(d, { recursive: true, force: true });
});

test('M117 ⑧文档同源：cell.dictionary 分节含 formula 说明（与运行时 schema 同源，report 档可下发）', () => {
  const body = SPEC_SECTIONS['cell.dictionary'].covers;
  assert.match(body, /type="formula"/, '分节应写 type="formula"');
  assert.match(body, /FormulaDictionary/, '分节应写落点类名');
  assert.match(body, /EFormulaDict/, '分节应写两段 CDATA 形态');
  assert.match(body, /update_parameter_widget/, '分节应指路参数面板侧同类能力');
  assert.match(body, /update_cell_dictionary/, '分节应指路单元格侧 update 路');
});

test('M117 ⑦真实 MCP 端到端：单元格与参数面板两侧的 add/update formula 全通（断言落盘 XML）', async () => {
  const d = tmp();
  const p = path.join(d, 'mcp.cpt');
  createCpt(p, { rows: 3, columns: 6 });
  setParameterPanel(p, { title: '查询' });
  addDataset(p, { name: 'ds1', connection: 'Doris', sql: 'SELECT 1' });
  const client = new Client({ name: 'formula-dict-e2e', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath, args: ['server.js'], cwd: process.cwd(), stderr: 'pipe',
    env: { CPT_MCP_TOOL_PROFILE: 'full' },
  });
  await client.connect(transport);
  const call = async (name, args) => {
    const r = await client.callTool({ name, arguments: args });
    let data = null;
    try { data = JSON.parse(r.content?.[0]?.text ?? ''); } catch { /* 错误文案非 JSON */ }
    return { isError: r.isError === true, text: r.content?.[0]?.text ?? '', data };
  };
  try {
    // 单元格 add 路
    const add = await call('add_cell', {
      path: p, column: 0, row: 0, widget: 'comboBox',
      widgetDictionary: { type: 'formula', formula: '=range(2010,2012)', eFormula: "=$$$+'年'" }, sheet: 0,
    });
    assert.equal(add.isError, false, `MCP add_cell formula 应成功：${add.text}`);
    let raw = fs.readFileSync(p, 'utf8');
    assert.ok(cellBlock(raw, 0, 0).includes(OFFICIAL_WITH_E), 'MCP add_cell 落盘官方同构');
    // 单元格 update 路：整块换 + 原位改
    const rep = await call('update_cell_dictionary', { path: p, column: 0, row: 0, sheet: 0, dictionary: { type: 'formula', formula: '=range(1,12)' } });
    assert.equal(rep.isError, false, `MCP update_cell_dictionary 整块换应成功：${rep.text}`);
    assert.equal(rep.data.mode, 'replace');
    const inplace = await call('update_cell_dictionary', { path: p, column: 0, row: 0, sheet: 0, eFormula: '=$$$+"月份"' });
    assert.equal(inplace.isError, false, `MCP 原位改 eFormula 应成功：${inplace.text}`);
    raw = fs.readFileSync(p, 'utf8');
    assert.ok(cellBlock(raw, 0, 0).includes(OFFICIAL_MONTHS), 'MCP 两步后落盘与官方同构');
    const read = await call('get_cell_dictionary', { path: p, column: 0, row: 0, sheet: 0 });
    assert.equal(read.isError, false);
    assert.equal(read.data.kind, 'formula');
    assert.equal(read.data.formula, '=range(1,12)');
    assert.equal(read.data.eFormula, '=$$$+"月份"');

    // 参数面板 add 路 + update 路
    const padd = await call('add_parameter_widget', {
      path: p, name: 'year', type: 'comboBox', label: '年份：',
      dictionary: { type: 'formula', formula: '=range(2010,2012)', eFormula: "=$$$+'年'" },
      x: 10, y: 10, width: 120, height: 24,
    });
    assert.equal(padd.isError, false, `MCP add_parameter_widget formula 应成功：${padd.text}`);
    raw = fs.readFileSync(p, 'utf8');
    assert.ok(innerBlockOf(raw, 'year').includes(OFFICIAL_WITH_E), 'MCP 面板 add 路落盘官方同构');
    const pupd = await call('update_parameter_widget', { path: p, name: 'year', formula: '=range(1,12)', eFormula: '=$$$+"月份"' });
    assert.equal(pupd.isError, false, `MCP 面板原位改公式应成功：${pupd.text}`);
    assert.equal(pupd.data.mode, 'update');
    raw = fs.readFileSync(p, 'utf8');
    assert.ok(innerBlockOf(raw, 'year').includes(OFFICIAL_MONTHS), 'MCP 面板 update 路落盘官方同构');

    // 枚举层围栏：formula 之外的非法类型仍被拒
    const bad = await call('update_cell_dictionary', { path: p, column: 0, row: 0, sheet: 0, dictionary: { type: 'bogus' } });
    assert.equal(bad.isError, true, '非法 dictionary.type 应被拒');
  } finally {
    await client.close();
    fs.rmSync(d, { recursive: true, force: true });
  }
});
