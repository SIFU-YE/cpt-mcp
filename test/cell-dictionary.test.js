// test/cell-dictionary.test.js —— M91 单元格下拉字典 + 缺 sheet 拒绝语义
//
// 背景：V3 双通道平齐（sheet1-C5 outer_id→spec_id）时没有结构化字典入口，
// 只能裸改 XML，结果把 sheet2-C15 的 <FormulaDictAttr kiName="spec_id" viName="spec_id"/>
// 整行删掉（V3 commit historical-commit 自证"本次工具误删"），且校验没拦下。
// 本测试锁定：updateCellDictionary 只动字典三处（ki/vi/取数表名），其余字节原样；
// 缺失 FormulaDictAttr 可补回（repair）；缺 sheet 时多表同坐标直接拒绝（M91 locateCell）；
// updateReportNode 未传 sheet 且全文件候选多个时直接拒绝（M91）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCpt, addCell, addSheet, addDataset } from '../lib/generate.js';
import { updateCellDictionary, getCellDictionary, setCellWidget, setReportJs, updateReportNode } from '../lib/edits.js';
import { validateCpt } from '../lib/validate.js';
import '../scripts/isolate-store.mjs'; // M123：JS 基线 store 隔离，直跑也不污染真实 store

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-dict-'));
const errCount = (p) => (validateCpt(p)).filter((x) => x.severity === 'error').length;

// FR 真实形态（V3-historical-commit^ 取证）：TableDataDictionary = FormulaDictAttr(ki/vi) + TableDataDictAttr(取数表)
const TABLE_DICT = (ki, vi, ds) => `<Dictionary class="com.fr.data.impl.TableDataDictionary">
<FormulaDictAttr kiName="${ki}" viName="${vi}"/>
<TableDataDictAttr>
<TableData class="com.fr.data.impl.NameTableData">
<Name>
<![CDATA[${ds}]]></Name>
</TableData>
</TableDataDictAttr>
</Dictionary>`;
const EMPTY_CUSTOM_DICT = `<Dictionary class="com.fr.data.impl.CustomDictionary">
<CustomDictAttr>
</CustomDictAttr>
</Dictionary>`;

/** 建一个带取数表字典的下拉格（先 comboBox 再换字典块，模拟设计器落盘形态） */
function comboTableCell(p, { column, row, sheet, ki = 'outer_id', vi = 'outer_id', ds = 'ds_goods' } = {}) {
  addCell(p, { column, row, widget: 'comboBox', sheet });
  const raw = fs.readFileSync(p, 'utf8');
  assert.ok(raw.includes(EMPTY_CUSTOM_DICT), 'comboBox 应先带空 CustomDictionary');
  fs.writeFileSync(p, raw.replace(EMPTY_CUSTOM_DICT, TABLE_DICT(ki, vi, ds)));
}
const dictOf = (p, col, row) => {
  const raw = fs.readFileSync(p, 'utf8');
  const cc = raw.indexOf(`<C c="${col}" r="${row}"`);
  const seg = raw.slice(cc, raw.indexOf('</C>', cc));
  return {
    ki: (seg.match(/<FormulaDictAttr\b[^>]*\bkiName="([^"]*)"/) || [])[1] ?? null,
    vi: (seg.match(/<FormulaDictAttr\b[^>]*\bviName="([^"]*)"/) || [])[1] ?? null,
    table: (seg.match(/<Name>\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*<\/Name>/) || [])[1] ?? null,
  };
};

test('M91 update_cell_dictionary：ki/vi 原位改，绑定与取数表保留', () => {
  const d = tmp();
  const p = path.join(d, 'a.cpt');
  createCpt(p, { rows: 3, columns: 6 });
  comboTableCell(p, { column: 5, row: 2, sheet: 0 });
  const r = updateCellDictionary(p, { column: 5, row: 2, sheet: 0, kiName: 'spec_id', viName: 'spec_id' });
  assert.equal(r.action, 'update_cell_dictionary');
  assert.equal(r.mode, 'update');
  assert.deepEqual(r.before, { ki: 'outer_id', vi: 'outer_id', table: 'ds_goods' });
  assert.deepEqual(r.after, { ki: 'spec_id', vi: 'spec_id', table: 'ds_goods' });
  assert.deepEqual(dictOf(p, 5, 2), { ki: 'spec_id', vi: 'spec_id', table: 'ds_goods' });
  const raw = fs.readFileSync(p, 'utf8');
  assert.ok(raw.includes('com.fr.form.ui.ComboBox'), '控件类型保留');
  assert.ok(raw.includes('<widgetValue>'), 'widgetValue 保留');
  assert.equal(errCount(p), 0);
  fs.rmSync(d, { recursive: true, force: true });
});

test('M91 update_cell_dictionary：值一致幂等 none；只改取数表名', () => {
  const d = tmp();
  const p = path.join(d, 'a.cpt');
  createCpt(p, { rows: 3, columns: 6 });
  comboTableCell(p, { column: 5, row: 2, sheet: 0, ki: 'spec_id', vi: 'spec_id' });
  const r0 = updateCellDictionary(p, { column: 5, row: 2, sheet: 0, kiName: 'spec_id', viName: 'spec_id' });
  assert.equal(r0.mode, 'none');
  const r = updateCellDictionary(p, { column: 5, row: 2, sheet: 0, table: 'ds_goods_new' });
  assert.equal(r.mode, 'update');
  assert.deepEqual(dictOf(p, 5, 2), { ki: 'spec_id', vi: 'spec_id', table: 'ds_goods_new' });
  assert.equal(errCount(p), 0);
  fs.rmSync(d, { recursive: true, force: true });
});

test('M91 update_cell_dictionary：repair 补回被误删的 FormulaDictAttr（historical-commit 形态）', () => {
  const d = tmp();
  const p = path.join(d, 'a.cpt');
  createCpt(p, { rows: 3, columns: 6 });
  comboTableCell(p, { column: 5, row: 2, sheet: 0 });
  // 模拟误删：整行删掉 FormulaDictAttr（只剩 TableDataDictAttr）
  const raw = fs.readFileSync(p, 'utf8');
  fs.writeFileSync(p, raw.replace(/<FormulaDictAttr kiName="[^"]*" viName="[^"]*"\/>\n/, ''));
  assert.equal(dictOf(p, 5, 2).ki, null, '误删形态：ki 缺失');
  const r = updateCellDictionary(p, { column: 5, row: 2, sheet: 0, kiName: 'spec_id', viName: 'spec_id' });
  assert.equal(r.mode, 'repair');
  assert.deepEqual(dictOf(p, 5, 2), { ki: 'spec_id', vi: 'spec_id', table: 'ds_goods' });
  assert.equal(errCount(p), 0);
  // 补回缺一半参数 → 拒绝（避免补出半截字典）
  const raw2 = fs.readFileSync(p, 'utf8');
  fs.writeFileSync(p, raw2.replace(/<FormulaDictAttr kiName="[^"]*" viName="[^"]*"\/>\n/, ''));
  assert.throws(() => updateCellDictionary(p, { column: 5, row: 2, sheet: 0, kiName: 'spec_id' }), /同时传 kiName\+viName/);
  fs.rmSync(d, { recursive: true, force: true });
});

test('M91 update_cell_dictionary：参数与形态预检', () => {
  const d = tmp();
  const p = path.join(d, 'a.cpt');
  createCpt(p, { rows: 3, columns: 6 });
  comboTableCell(p, { column: 5, row: 2, sheet: 0 });
  addCell(p, { column: 0, row: 0, widget: 'text', sheet: 0 });
  addCell(p, { column: 1, row: 0, widget: 'comboBox', sheet: 0 }); // CustomDictionary
  // sheet 必填
  assert.throws(() => updateCellDictionary(p, { column: 5, row: 2, kiName: 'a' }), /必须显式提供 sheet/);
  // 三改项全空
  assert.throws(() => updateCellDictionary(p, { column: 5, row: 2, sheet: 0 }), /至少传一个/);
  // 空串/非法字符
  assert.throws(() => updateCellDictionary(p, { column: 5, row: 2, sheet: 0, kiName: '' }), /不接受空字符串/);
  assert.throws(() => updateCellDictionary(p, { column: 5, row: 2, sheet: 0, kiName: 'a"b' }), /非法字符/);
  // 非字典格 / Custom 字典（M108 起报错更精确：自定义字典不接受 ki/vi/table，要用 items）
  assert.throws(() => updateCellDictionary(p, { column: 0, row: 0, sheet: 0, kiName: 'a' }), /无 <Dictionary>/);
  assert.throws(() => updateCellDictionary(p, { column: 1, row: 0, sheet: 0, kiName: 'a' }), /不接受 kiName\/viName\/table/);
  // 坐标不存在
  assert.throws(() => updateCellDictionary(p, { column: 9, row: 9, sheet: 0, kiName: 'a' }), /未找到/);
  fs.rmSync(d, { recursive: true, force: true });
});

test('M108 update_cell_dictionary：CustomDictionary 字典项就地整表替换（空字典填项/清空/幂等）', () => {
  // 背景：get_cell_dictionary(M96) 一直能读自定义项，写侧却只支持 TableDataDictionary ——
  // 空自定义字典（如"姓名下拉 0 项"）只能 delete+add 重建控件，与 M106 绑定落点同一类缺口。
  const d = tmp();
  const p = path.join(d, 'custom.cpt');
  createCpt(p, { rows: 3, columns: 4 });
  addCell(p, { column: 1, row: 2, widget: 'comboBox', sheet: 0 }); // 空 CustomDictionary 形态

  const names = [{ key: '张三', value: '张三' }, { key: '李四', value: '李四' }, { key: '王五', value: '王五' }];
  const r1 = updateCellDictionary(p, { column: 1, row: 2, sheet: 0, items: names });
  assert.equal(r1.mode, 'update');
  assert.deepEqual(r1.after.items, names);
  assert.equal(errCount(p), 0);
  // 控件其余字节原样保留（只动 <CustomDictAttr> 内容）
  assert.match(fs.readFileSync(p, 'utf8'), /<Widget class="com\.fr\.form\.ui\.ComboBox"/);
  // 幂等
  assert.equal(updateCellDictionary(p, { column: 1, row: 2, sheet: 0, items: names }).mode, 'none');
  // 整表替换（不是追加）
  const r3 = updateCellDictionary(p, { column: 1, row: 2, sheet: 0, items: [{ key: '赵六', value: '赵六' }] });
  assert.deepEqual(r3.after.items, [{ key: '赵六', value: '赵六' }]);
  // 清空 → 官方空字典形态
  const r4 = updateCellDictionary(p, { column: 1, row: 2, sheet: 0, items: [] });
  assert.deepEqual(r4.after.items, []);
  assert.equal(errCount(p), 0);
  // 传错形态入参 / items 校验
  assert.throws(() => updateCellDictionary(p, { column: 1, row: 2, sheet: 0, kiName: 'a' }), /不接受 kiName\/viName\/table/);
  assert.throws(() => updateCellDictionary(p, { column: 1, row: 2, sheet: 0, items: 'x' }), /必须是 \[{key,value}\] 数组/);
  assert.throws(() => updateCellDictionary(p, { column: 1, row: 2, sheet: 0, items: [{ key: 'a' }] }), /不能为空/);
  assert.throws(() => updateCellDictionary(p, { column: 1, row: 2, sheet: 0, items: [{ key: 'a<b', value: 'v' }] }), /XML 非法字符/);
  fs.rmSync(d, { recursive: true, force: true });
});

test('M108 update_cell_dictionary：TableDataDictionary 传 items 明确拒绝', () => {
  const d = tmp();
  const p = path.join(d, 'table.cpt');
  createCpt(p, { rows: 3, columns: 6 });
  comboTableCell(p, { column: 5, row: 2, sheet: 0 });
  assert.throws(() => updateCellDictionary(p, { column: 5, row: 2, sheet: 0, items: [{ key: 'a', value: 'b' }] }), /不接受 items/);
  fs.rmSync(d, { recursive: true, force: true });
});

test('M91 locateCell：未传 sheet 且同坐标多表并存 → 拒绝（禁静默命中首表）', () => {
  const d = tmp();
  const p = path.join(d, 'a.cpt');
  createCpt(p, { rows: 3, columns: 3 });
  addSheet(p, { sheetName: 'sheet2', rows: 3, columns: 3 });
  addCell(p, { column: 1, row: 1, widget: 'text', sheet: 0 });
  addCell(p, { column: 1, row: 1, widget: 'text', sheet: 1 });
  // 不传 sheet：两表同坐标 → 拒绝
  assert.throws(() => setCellWidget(p, { column: 1, row: 1, type: 'number' }), /2 个工作表均存在.*禁止静默命中第一格/);
  // 传 sheet：各改各的，互不影响
  const r0 = setCellWidget(p, { column: 1, row: 1, type: 'number', sheet: 0 });
  assert.equal(r0.newClass, 'com.fr.form.ui.NumberEditor');
  const raw = fs.readFileSync(p, 'utf8');
  const hits = [...raw.matchAll(/<Widget class="com\.fr\.form\.ui\.(TextEditor|NumberEditor)"/g)].map((m) => m[1]);
  assert.deepEqual(hits, ['NumberEditor', 'TextEditor'], '只改 sheet0，sheet1 原样');
  assert.equal(errCount(p), 0);
  fs.rmSync(d, { recursive: true, force: true });
});

test('M91 locateCell：单表/唯一坐标不传 sheet 照常工作（向后兼容）', () => {
  const d = tmp();
  const p = path.join(d, 'a.cpt');
  createCpt(p, { rows: 3, columns: 3 });
  addCell(p, { column: 1, row: 1, widget: 'text' });
  const r = setCellWidget(p, { column: 1, row: 1, type: 'number' });
  assert.equal(r.newClass, 'com.fr.form.ui.NumberEditor');
  fs.rmSync(d, { recursive: true, force: true });
});

test('M91 updateReportNode：未传 sheet 且全文件候选多个 → 拒绝；传 sheet 放行', () => {
  const d = tmp();
  const p = path.join(d, 'a.cpt');
  createCpt(p, { rows: 2, columns: 2 });
  // 单候选：不传 sheet 照常 upsert（向后兼容）
  const r0 = updateReportNode(p, { nodeName: 'TopJS', xmlBody: 'var a=1;' });
  assert.equal(r0.mode, 'upsert');
  addSheet(p, { sheetName: 'sheet2', rows: 2, columns: 2 });
  setReportJs(p, { js: 'var s2=1;', sheet: 1 });
  // 全文件 2 个 TopJS，不传 sheet → 拒绝
  assert.throws(() => updateReportNode(p, { nodeName: 'TopJS', xmlBody: 'var x=1;' }), /2 个候选.*禁止静默命中第一个/);
  // 传 sheet → 只改目标表
  const r1 = updateReportNode(p, { nodeName: 'TopJS', xmlBody: 'var s1b=1;', sheet: 0 });
  assert.equal(r1.mode, 'upsert');
  const raw = fs.readFileSync(p, 'utf8');
  assert.ok(raw.includes('var s1b=1;'), 'sheet0 已更新');
  assert.ok(raw.includes('var s2=1;'), 'sheet1 原样保留');
  assert.equal(errCount(p), 0);
  fs.rmSync(d, { recursive: true, force: true });
});

// ---------------- M109：单元格下拉绑数据集/数据库表 ----------------
// 依据（官方 1550 份实测）：单元格控件侧 TableDataDictionary 85 例、DatabaseDictionary 259 例，
// 即"单元格配置下拉单选控件后可以绑定数据集"是官方既有能力；此前单元格侧只写 CustomDictionary。
const OFFICIAL_CELL_TABLE_DICT = (ds, ki, vi) => `<Dictionary class="com.fr.data.impl.TableDataDictionary">
<FormulaDictAttr kiName="${ki}" viName="${vi}"/>
<TableDataDictAttr>
<TableData class="com.fr.data.impl.NameTableData">
<Name>
<![CDATA[${ds}]]></Name>
</TableData>
</TableDataDictAttr>
</Dictionary>`;

test('M109 add_cell：单元格下拉直接绑数据集（形态与官方逐字节一致）', () => {
  const d = tmp();
  const p = path.join(d, 'cell-table-dict.cpt');
  createCpt(p, { rows: 3, columns: 4 });
  addDataset(p, { name: 'ds_node', connection: 'Doris', sql: 'SELECT node_name FROM t' });
  addCell(p, {
    column: 1, row: 2, widget: 'comboBox', sheet: 0,
    widgetDictionary: { type: 'table', dsName: 'ds_node', kiName: 'node_name', viName: 'node_name' },
  });
  const raw = fs.readFileSync(p, 'utf8');
  assert.ok(raw.includes(OFFICIAL_CELL_TABLE_DICT('ds_node', 'node_name', 'node_name')),
    `应写官方单元格 TableDataDictionary 形态，实际：${raw.slice(raw.indexOf('<Dictionary'), raw.indexOf('</Dictionary>') + 13)}`);
  const got = getCellDictionary(p, { column: 1, row: 2, sheet: 0 });
  assert.equal(got.kind, 'table');
  assert.equal(got.table, 'ds_node');
  assert.equal(got.kiName, 'node_name');
  assert.equal(errCount(p), 0);
  // 校验围栏
  assert.throws(() => addCell(p, { column: 2, row: 2, widget: 'comboBox', sheet: 0, widgetDictionary: { type: 'table' } }), /必须提供 dsName/);
  assert.throws(() => addCell(p, { column: 2, row: 2, widget: 'comboBox', sheet: 0, widgetDictionary: { type: 'table', dsName: '不存在' } }), /数据集/);
  assert.throws(() => addCell(p, { column: 2, row: 2, widget: 'text', sheet: 0, widgetDictionary: { type: 'table', dsName: 'ds_node' } }), /只适用于下拉类控件/);
  assert.throws(() => addCell(p, { column: 2, row: 2, widget: 'comboBox', sheet: 0, widgetDictionary: { type: 'bogus' } }), /只能是 table/);
  fs.rmSync(d, { recursive: true, force: true });
});

test('M109 add_cell：单元格下拉绑数据库表（DatabaseDictionary 形态）', () => {
  const d = tmp();
  const p = path.join(d, 'cell-db-dict.cpt');
  createCpt(p, { rows: 3, columns: 4 });
  addCell(p, {
    column: 0, row: 1, widget: 'comboBox', sheet: 0,
    widgetDictionary: { type: 'db', table: '产品项目', ki: 1, vi: 1, connection: 'FRDemo', schema: '' },
  });
  const raw = fs.readFileSync(p, 'utf8');
  assert.match(raw, /<Dictionary class="com\.fr\.data\.impl\.DatabaseDictionary">/);
  assert.match(raw, /<DBDictAttr tableName="产品项目" schemaName="" ki="1" vi="1"/);
  assert.equal(errCount(p), 0);
  assert.throws(() => addCell(p, { column: 1, row: 1, widget: 'comboBox', sheet: 0, widgetDictionary: { type: 'db', table: 't', ki: 0, vi: 1 } }), /必须提供 connection/);
  fs.rmSync(d, { recursive: true, force: true });
});

test('M109 update_cell_dictionary：把已有自定义项下拉就地改成绑数据集（控件/绑定保留）', () => {
  const d = tmp();
  const p = path.join(d, 'convert.cpt');
  createCpt(p, { rows: 3, columns: 4 });
  addDataset(p, { name: 'ds_config', connection: 'Doris', sql: 'SELECT node_name FROM t' });
  // 现状复刻：单元格下拉 + 29 项固定字典（正是现场"节点下拉全 29 项"的形态）
  addCell(p, { column: 0, row: 2, widget: 'comboBox', sheet: 0, widgetItems: Array.from({ length: 29 }, (_, i) => ({ key: 'n' + i, value: 'n' + i })) });
  assert.equal(getCellDictionary(p, { column: 0, row: 2, sheet: 0 }).kind, 'custom');
  const r = updateCellDictionary(p, {
    column: 0, row: 2, sheet: 0,
    dictionary: { type: 'table', dsName: 'ds_config', kiName: 'node_name', viName: 'node_name' },
  });
  assert.equal(r.mode, 'replace');
  assert.equal(r.before.kind, 'custom');
  assert.equal(r.before.items.length, 29);
  assert.equal(r.after.kind, 'table');
  assert.equal(r.after.dsName, 'ds_config');
  // 控件仍在（就地替换只动 <Dictionary> 块）
  const raw = fs.readFileSync(p, 'utf8');
  assert.match(raw, /<Widget class="com\.fr\.form\.ui\.ComboBox"/);
  assert.ok(raw.includes(OFFICIAL_CELL_TABLE_DICT('ds_config', 'node_name', 'node_name')));
  assert.equal(errCount(p), 0);
  // 幂等 + 互斥 + 围栏
  assert.equal(updateCellDictionary(p, { column: 0, row: 2, sheet: 0, dictionary: { type: 'table', dsName: 'ds_config', kiName: 'node_name', viName: 'node_name' } }).mode, 'none');
  assert.throws(() => updateCellDictionary(p, { column: 0, row: 2, sheet: 0, dictionary: { type: 'custom', items: [] }, items: [] }), /不能同时传/);
  assert.throws(() => updateCellDictionary(p, { column: 0, row: 2, sheet: 0, dictionary: { type: 'table' } }), /必须提供 dsName/);
  assert.throws(() => updateCellDictionary(p, { column: 0, row: 2, sheet: 0, dictionary: { type: 'table', dsName: '无此数据集' } }), /数据集/);
  // 改回自定义项（整块替换回去）
  const back = updateCellDictionary(p, { column: 0, row: 2, sheet: 0, dictionary: { type: 'custom', items: [{ key: 'a', value: 'a' }] } });
  assert.equal(back.after.kind, 'custom');
  assert.deepEqual(back.after.items, [{ key: 'a', value: 'a' }]);
  assert.equal(errCount(p), 0);
  fs.rmSync(d, { recursive: true, force: true });
});

test('M110 数据集/报表参数可写成官方公式形态（=A5 绑单元格 = 下拉联动过滤那一半）', () => {
  const d = tmp();
  const p = path.join(d, 'param-formula.cpt');
  createCpt(p, { rows: 4, columns: 6 });
  addDataset(p, {
    name: 'ds_node', connection: 'Doris',
    sql: "SELECT node_name FROM ads_workload_config WHERE project_code = '${project_code}'",
    parameters: [{ name: 'project_code', defaultValue: '=A5' }],
  });
  addDataset(p, { name: 'ds_lit', connection: 'Doris', sql: 'SELECT 1', parameters: [{ name: 'k', defaultValue: '收入' }] });
  const raw = fs.readFileSync(p, 'utf8');
  // 官方形态（数据钻取主报表.cpt `参数 id = =A5` / demobetter.cpt `参数 tName = =B2` 实证）
  assert.ok(raw.includes('<Parameter>\n<Attributes name="project_code"/>\n<O t="XMLable" class="com.fr.base.Formula">\n<Attributes>\n<![CDATA[=A5]]></Attributes>\n</O>\n</Parameter>'),
    'dsName 参数以 "=" 开头应写官方公式参数形态');
  // 字面量仍是旧形态（逐字节不变）
  assert.ok(raw.includes('<Parameter>\n<Attributes name="k"/>\n<O>\n<![CDATA[收入]]></O>\n</Parameter>'),
    '非 "=" 开头应保持字面量形态');
  // 报表级参数走同一条 parameterXml（此处只需确认数据集级；报表级需先建参数面板）
  assert.equal(errCount(p), 0);
  fs.rmSync(d, { recursive: true, force: true });
});
