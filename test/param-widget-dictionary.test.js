// test/param-widget-dictionary.test.js —— M117 参数面板控件「就地改字典」+ add 同名重复防护
//
// 背景（t1 独立复核裁决 · 主张 2/6 属实部分）：
//  - add_parameter_widget 已能写 TableDataDictionary（参数面板侧官方 140 例），但「已有控件把自定义项字典
//    改成取数表字典」这条 update 路是空的 —— update_parameter_widget 只支持 visible/defaultValue/x,y/
//    fontName/noBorder，模型只能 delete→add 重建（会丢坐标/字体/移动端引用）。
//  - add_parameter_widget 对同名控件无条件追加：实测同名 pageSize 调两次落盘 <WidgetName> 序列
//    ["para","pageSize","pageSize"]、2 个 InnerWidget，第二次是新增而非更新（静默重复是危险默认）。
//
// 本文件锁定：
//  ① update_parameter_widget 三形态整块换字典（table/db/custom/formula，复用 dictionaryXml 单一来源）；
//  ② 原位改 items（CustomDictionary）/ kiName+viName+table（TableDataDictionary）；
//  ③ 幂等：字典已一致 → mode:'none' 且零字节改动；
//  ④ 外科性：只动 <Dictionary> 块，<WidgetName>/<BoundsAttr>/<WidgetAttr>/<widgetValue> 等其余字节逐字节不变；
//  ⑤ 同名 add 默认拒绝并指路 update_parameter_widget/rename_parameter_widget/delete_parameter_widget；
//  ⑥ allowDuplicate:true 才追加；
//  ⑦ 真实 MCP 端到端（StdioClientTransport 起 server.js），断言落在落盘 XML 上。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createCpt, addDataset, addParameterWidget, setParameterPanel } from '../lib/generate.js';
import { updateParameterWidget } from '../lib/edits.js';
import { validateCpt } from '../lib/validate.js';
import { parameterPanel } from '../lib/cpt.js';
import '../scripts/isolate-store.mjs'; // M123：JS 基线 store 隔离，直跑也不污染真实 store

delete process.env.CPT_MCP_ALLOWED_ROOTS;

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-pwdict-'));
const errCount = (p) => validateCpt(p).filter((x) => x.severity === 'error').length;

// 官方形态（本机 FR 11.0 语料实证：参数面板侧 TableDataDictionary 140 / DatabaseDictionary 81 /
// CustomDictionary 60 / FormulaDictionary 25）
const OFFICIAL_TABLE = (ds, ki, vi) => `<Dictionary class="com.fr.data.impl.TableDataDictionary">
<FormulaDictAttr kiName="${ki}" viName="${vi}"/>
<TableDataDictAttr>
<TableData class="com.fr.data.impl.NameTableData">
<Name>
<![CDATA[${ds}]]></Name>
</TableData>
</TableDataDictAttr>
</Dictionary>`;
const OFFICIAL_DB = (table, ki, vi, conn) => `<Dictionary class="com.fr.data.impl.DatabaseDictionary">
<DBDictAttr tableName="${table}" schemaName="" ki="${ki}" vi="${vi}" kiName="" viName=""/>
<Connection class="com.fr.data.impl.NameDatabaseConnection">
<DatabaseName>
<![CDATA[${conn}]]></DatabaseName>
</Connection>
</Dictionary>`;
const OFFICIAL_CUSTOM = (items) => `<Dictionary class="com.fr.data.impl.CustomDictionary">
<CustomDictAttr>
${items.map((it) => `<Dict key="${it.key}" value="${it.value}"/>`).join('\n')}
</CustomDictAttr>
</Dictionary>`;
const OFFICIAL_FORMULA = (formula, eFormula) => `<Dictionary class="com.fr.data.impl.FormulaDictionary">
<FormulaDict>
<![CDATA[${formula}]]></FormulaDict>${eFormula == null ? '' : `
<EFormulaDict>
<![CDATA[${eFormula}]]></EFormulaDict>`}
</Dictionary>`;

/** 面板段内某控件的 InnerWidget 块（按 <WidgetName name> 精确匹配） */
function innerBlockOf(raw, name) {
  const s = raw.indexOf('<ReportParameterAttr>');
  const e = raw.indexOf('</ReportParameterAttr>', s);
  const seg = raw.slice(s, e);
  const re = /<InnerWidget\b[^>]*>[\s\S]*?<\/InnerWidget>/g;
  let m;
  while ((m = re.exec(seg)) !== null) if (m[0].includes(`<WidgetName name="${name}"/>`)) return m[0];
  return null;
}
/** 该控件的 BoundsAttr（紧跟 InnerWidget 之后） */
function boundsOf(raw, name) {
  const blk = innerBlockOf(raw, name);
  const at = raw.indexOf(blk);
  return (raw.slice(at + blk.length, at + blk.length + 256).match(/<BoundsAttr\b[^>]*\/>/) || [])[0] ?? null;
}
/** 把文件按「第一个 <Dictionary> 块」切成 [块前, 块, 块后]，用于证明只有字典块被改 */
function splitAtDictionary(raw) {
  const m = /<Dictionary\b[\s\S]*?<\/Dictionary>/.exec(raw);
  if (!m) throw new Error('fixture 无 <Dictionary> 块');
  return [raw.slice(0, m.index), m[0], raw.slice(m.index + m[0].length)];
}

/** 建面板 + 一个自定义项下拉控件（官方 add 路已能写 CustomDictionary） */
function fixture(p) {
  createCpt(p, { rows: 3, columns: 3 });
  setParameterPanel(p, { title: '查询' });
  addDataset(p, { name: 'ds1', connection: 'Doris', sql: 'SELECT spec_id, spec_name FROM t_spec' });
  addParameterWidget(p, {
    name: 'spec', type: 'comboBox', label: '规格：',
    items: [{ key: 'a', value: '甲' }, { key: 'b', value: '乙' }],
    x: 20, y: 30, width: 120, height: 24,
  });
}

test('M117 ①三形态整块换字典：table / db / custom（与 update_cell_dictionary 同源 dictionaryXml）', () => {
  const d = tmp();
  const p = path.join(d, 'a.cpt');
  fixture(p);
  let raw = fs.readFileSync(p, 'utf8');
  assert.ok(raw.includes(OFFICIAL_CUSTOM([{ key: 'a', value: '甲' }, { key: 'b', value: '乙' }])), '前置：自定义字典已落盘');

  // ①-a 自定义项 → 取数表字典（官方参数面板侧 140 例）
  const r1 = updateParameterWidget(p, {
    name: 'spec', dictionary: { type: 'table', dsName: 'ds1', kiName: 'spec_id', viName: 'spec_name' },
  });
  assert.equal(r1.mode, 'replace');
  assert.equal(r1.dictBefore.kind, 'custom');
  assert.equal(r1.dictAfter.kind, 'table');
  raw = fs.readFileSync(p, 'utf8');
  assert.ok(innerBlockOf(raw, 'spec').includes(OFFICIAL_TABLE('ds1', 'spec_id', 'spec_name')), '取数表字典落盘与官方同构');
  assert.deepEqual(r1.changed, ['dictionary']);

  // ①-b → 数据库表字典
  const r2 = updateParameterWidget(p, {
    name: 'spec', dictionary: { type: 'db', table: 't_goods', ki: 0, vi: 1, connection: 'Doris' },
  });
  assert.equal(r2.mode, 'replace');
  assert.equal(r2.dictAfter.kind, 'db');
  raw = fs.readFileSync(p, 'utf8');
  assert.ok(innerBlockOf(raw, 'spec').includes(OFFICIAL_DB('t_goods', 0, 1, 'Doris')), '数据库表字典落盘与官方同构');

  // ①-c → 回到自定义项
  const r3 = updateParameterWidget(p, { name: 'spec', dictionary: { type: 'custom', items: [{ key: 'x', value: 'X' }] } });
  assert.equal(r3.mode, 'replace');
  raw = fs.readFileSync(p, 'utf8');
  assert.ok(innerBlockOf(raw, 'spec').includes(OFFICIAL_CUSTOM([{ key: 'x', value: 'X' }])), '自定义字典落盘');
  assert.equal(errCount(p), 0);
  fs.rmSync(d, { recursive: true, force: true });
});

test('M117 ②原位改：items 整表替换（CustomDictionary）/ kiName+viName+table（TableDataDictionary）', () => {
  const d = tmp();
  const p = path.join(d, 'a.cpt');
  fixture(p);
  // items 整表替换
  const r1 = updateParameterWidget(p, { name: 'spec', items: [{ key: 'k1', value: 'V1' }, { key: 'k2', value: 'V2' }] });
  assert.equal(r1.mode, 'update');
  assert.equal(r1.dictAfter.kind, 'custom');
  assert.deepEqual(r1.dictAfter.items, [{ key: 'k1', value: 'V1' }, { key: 'k2', value: 'V2' }]);
  let raw = fs.readFileSync(p, 'utf8');
  assert.ok(innerBlockOf(raw, 'spec').includes(OFFICIAL_CUSTOM([{ key: 'k1', value: 'V1' }, { key: 'k2', value: 'V2' }])));
  // 换成取数表字典后，原位逐字段改 ki/vi/取数表名
  updateParameterWidget(p, { name: 'spec', dictionary: { type: 'table', dsName: 'ds1', kiName: 'a', viName: 'b' } });
  const r2 = updateParameterWidget(p, { name: 'spec', kiName: 'spec_id', viName: 'spec_name' });
  assert.equal(r2.mode, 'update');
  assert.deepEqual(r2.dictBefore, { kind: 'table', dsName: 'ds1', kiName: 'a', viName: 'b' });
  assert.deepEqual(r2.dictAfter, { kind: 'table', dsName: 'ds1', kiName: 'spec_id', viName: 'spec_name' });
  const r3 = updateParameterWidget(p, { name: 'spec', table: 'ds_spec2' });
  assert.equal(r3.mode, 'update');
  raw = fs.readFileSync(p, 'utf8');
  assert.ok(innerBlockOf(raw, 'spec').includes(OFFICIAL_TABLE('ds_spec2', 'spec_id', 'spec_name')), '取数表名已原位改');
  assert.equal(errCount(p), 0);
  fs.rmSync(d, { recursive: true, force: true });
});

test('M117 ③幂等：字典已一致 → mode:none 且零字节改动', () => {
  const d = tmp();
  const p = path.join(d, 'a.cpt');
  fixture(p);
  updateParameterWidget(p, { name: 'spec', dictionary: { type: 'table', dsName: 'ds1', kiName: 'spec_id', viName: 'spec_name' } });
  const before = fs.readFileSync(p, 'utf8');
  const r1 = updateParameterWidget(p, { name: 'spec', dictionary: { type: 'table', dsName: 'ds1', kiName: 'spec_id', viName: 'spec_name' } });
  assert.equal(r1.mode, 'none');
  assert.equal(r1.dictBefore.kind, 'table');
  assert.equal(fs.readFileSync(p, 'utf8'), before, '整块替换幂等不得改文件');
  // 原位改同值同样幂等
  const r2 = updateParameterWidget(p, { name: 'spec', kiName: 'spec_id', viName: 'spec_name' });
  assert.equal(r2.mode, 'none');
  assert.equal(fs.readFileSync(p, 'utf8'), before, '原位同值不得改文件');
  // 自定义项同值幂等
  const r3 = updateParameterWidget(p, { name: 'spec', dictionary: { type: 'custom', items: [{ key: 'a', value: '甲' }, { key: 'b', value: '乙' }] } });
  assert.equal(r3.mode, 'replace');
  const before2 = fs.readFileSync(p, 'utf8');
  const r4 = updateParameterWidget(p, { name: 'spec', items: [{ key: 'a', value: '甲' }, { key: 'b', value: '乙' }] });
  assert.equal(r4.mode, 'none');
  assert.equal(fs.readFileSync(p, 'utf8'), before2, 'items 同值不得改文件');
  fs.rmSync(d, { recursive: true, force: true });
});

test('M117 ④外科性：改字典只动 <Dictionary> 块，其余字节逐字节不变', () => {
  const d = tmp();
  const p = path.join(d, 'a.cpt');
  fixture(p);
  // 先加一个 invisible + 默认值 + 坐标，构造"其余字节"丰富的控件
  updateParameterWidget(p, { name: 'spec', visible: false, defaultValue: '甲', x: 44, y: 55 });
  const before = fs.readFileSync(p, 'utf8');
  const [preBefore, dictBefore, postBefore] = splitAtDictionary(before);
  const wNameBefore = '<WidgetName name="spec"/>';
  const boundsBefore = boundsOf(before, 'spec');
  const wAttrBefore = /<WidgetAttr\b[^>]*>/.exec(innerBlockOf(before, 'spec'))[0];
  const wValueBefore = /<widgetValue>[\s\S]*?<\/widgetValue>/.exec(innerBlockOf(before, 'spec'))[0];
  assert.ok(boundsBefore && wAttrBefore && wValueBefore, '前置：控件四要素齐备');

  updateParameterWidget(p, { name: 'spec', dictionary: { type: 'formula', formula: '=range(2010,2012)', eFormula: "=$$$+'年'" } });
  const after = fs.readFileSync(p, 'utf8');
  const [preAfter, dictAfter, postAfter] = splitAtDictionary(after);
  assert.equal(preAfter, preBefore, '字典块之前的所有字节逐字节不变');
  assert.equal(postAfter, postBefore, '字典块之后的所有字节逐字节不变');
  assert.notEqual(dictAfter, dictBefore, '字典块确实被改');
  // 四要素显式再断言一遍（可读性）
  const blk = innerBlockOf(after, 'spec');
  assert.ok(blk.includes(wNameBefore), '<WidgetName> 原样保留');
  assert.equal(boundsOf(after, 'spec'), boundsBefore, '<BoundsAttr> 原样保留');
  assert.equal(/<WidgetAttr\b[^>]*>/.exec(blk)[0], wAttrBefore, '<WidgetAttr>（含 invisible）原样保留');
  assert.equal(/<widgetValue>[\s\S]*?<\/widgetValue>/.exec(blk)[0], wValueBefore, '<widgetValue> 原样保留');
  assert.equal(parameterPanel(p).widgets.find((w) => w.name === 'spec').invisible, true, '可见性未被字典改写影响');
  assert.equal(parameterPanel(p).widgets.find((w) => w.name === 'spec').defaultValue, '甲', '默认值未被字典改写影响');
  assert.equal(errCount(p), 0);
  fs.rmSync(d, { recursive: true, force: true });
});

test('M117 围栏：控件本无 <Dictionary> 时拒绝并指路 add_parameter_widget；类型/参数冲突报错', () => {
  const d = tmp();
  const p = path.join(d, 'a.cpt');
  createCpt(p, { rows: 3, columns: 3 });
  setParameterPanel(p, { title: '查询' });
  addParameterWidget(p, { name: 'kw', type: 'text' });
  assert.throws(() => updateParameterWidget(p, { name: 'kw', items: [{ key: 'a', value: 'A' }] }), /无 <Dictionary>/);
  assert.throws(() => updateParameterWidget(p, { name: 'kw', items: [{ key: 'a', value: 'A' }] }), /add_parameter_widget/);
  addParameterWidget(p, { name: 'cb', type: 'comboBox', items: [{ key: 'a', value: 'A' }] });
  // 自定义字典不接受 ki/vi/table/公式
  assert.throws(() => updateParameterWidget(p, { name: 'cb', kiName: 'x' }), /不接受 kiName\/viName\/table/);
  assert.throws(() => updateParameterWidget(p, { name: 'cb', formula: '=1' }), /不接受 kiName\/viName\/table/);
  // 整块与逐字段互斥
  assert.throws(() => updateParameterWidget(p, { name: 'cb', dictionary: { type: 'custom', items: [] }, items: [] }), /不能同时传/);
  // 类型围栏
  assert.throws(() => updateParameterWidget(p, { name: 'cb', dictionary: { type: 'bogus' } }), /dictionary.type 只能是/);
  assert.throws(() => updateParameterWidget(p, { name: 'cb', dictionary: { type: 'table' } }), /必须提供 dsName/);
  assert.throws(() => updateParameterWidget(p, { name: 'cb', dictionary: { type: 'formula' } }), /必须提供 formula/);
  assert.throws(() => updateParameterWidget(p, { name: 'cb', dictionary: { type: 'table', dsName: '无此数据集' } }), /数据集/);
  assert.throws(() => updateParameterWidget(p, { name: 'nope', items: [] }), /未找到/);
  assert.throws(() => updateParameterWidget(p, { name: 'cb' }), /至少传一个/);
  fs.rmSync(d, { recursive: true, force: true });
});

test('M117 ⑤⑥同名 add：默认拒绝并指路，allowDuplicate:true 才追加', () => {
  const d = tmp();
  const p = path.join(d, 'a.cpt');
  createCpt(p, { rows: 3, columns: 3 });
  setParameterPanel(p, { title: '查询' });
  addParameterWidget(p, { name: 'project', type: 'text' });
  const rawBefore = fs.readFileSync(p, 'utf8');
  let err = null;
  try { addParameterWidget(p, { name: 'project', type: 'text' }); } catch (e) { err = e; }
  assert.ok(err, '同名默认必须拒绝');
  assert.match(err.message, /已存在同名控件/);
  assert.match(err.message, /update_parameter_widget/, '指路改属性/字典');
  assert.match(err.message, /rename_parameter_widget/, '指路改名');
  assert.match(err.message, /delete_parameter_widget/, '指路先删');
  assert.match(err.message, /allowDuplicate=true/, '给出逃生舱');
  assert.equal(fs.readFileSync(p, 'utf8'), rawBefore, '拒绝时不得落盘');
  // 逃生舱：显式 allowDuplicate=true 才追加
  const r = addParameterWidget(p, { name: 'project', type: 'text', allowDuplicate: true });
  assert.equal(r.action, 'add_parameter_widget');
  const raw = fs.readFileSync(p, 'utf8');
  assert.equal((raw.match(/<WidgetName name="project"\/>/g) || []).length, 2, 'allowDuplicate=true 时确实追加第二个');
  assert.equal((raw.match(/<InnerWidget/g) || []).length, 2, '两个同名控件（Layout 自身的 para 不是 InnerWidget）');
  // boolish 口径：字符串 'true' 同样放行
  addParameterWidget(p, { name: 'other', type: 'text' });
  assert.throws(() => addParameterWidget(p, { name: 'other', type: 'text' }), /已存在同名控件/);
  addParameterWidget(p, { name: 'other', type: 'text', allowDuplicate: 'true' });
  assert.equal((fs.readFileSync(p, 'utf8').match(/<WidgetName name="other"\/>/g) || []).length, 2);
  fs.rmSync(d, { recursive: true, force: true });
});

test('M117 ⑦真实 MCP 端到端：update_parameter_widget 就地改字典 + 同名 add 拒绝/放行（断言落盘 XML）', async () => {
  const d = tmp();
  const p = path.join(d, 'mcp.cpt');
  fixture(p);
  const client = new Client({ name: 'param-widget-dict-e2e', version: '1.0.0' });
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
    // 1) 经 server.js 就地改字典：自定义项 → 公式数据字典（update 路 M117）
    const upd = await call('update_parameter_widget', {
      path: p, name: 'spec',
      dictionary: { type: 'formula', formula: '=range(2010,2012)', eFormula: "=$$$+'年'" },
    });
    assert.equal(upd.isError, false, `MCP update 应成功：${upd.text}`);
    assert.equal(upd.data.mode, 'replace');
    assert.equal(upd.data.dictAfter.kind, 'formula');
    const rawAfterUpdate = fs.readFileSync(p, 'utf8');
    assert.ok(innerBlockOf(rawAfterUpdate, 'spec').includes(OFFICIAL_FORMULA('=range(2010,2012)', "=$$$+'年'")),
      'MCP 调用后落盘 XML 与官方公式字典同构');

    // 2) 经 server.js 同名 add：默认拒绝（指路 update_parameter_widget）
    const dup = await call('add_parameter_widget', { path: p, name: 'spec', type: 'text' });
    assert.equal(dup.isError, true, 'MCP 同名 add 默认必须拒绝');
    assert.match(dup.text, /已存在同名控件/);
    assert.match(dup.text, /update_parameter_widget/);
    assert.equal((fs.readFileSync(p, 'utf8').match(/<WidgetName name="spec"\/>/g) || []).length, 1, '拒绝时面板仍只有一个 spec');

    // 3) 经 server.js 显式 allowDuplicate=true → 追加
    const dup2 = await call('add_parameter_widget', { path: p, name: 'spec', type: 'text', allowDuplicate: true });
    assert.equal(dup2.isError, false, `allowDuplicate=true 应放行：${dup2.text}`);
    assert.equal((fs.readFileSync(p, 'utf8').match(/<WidgetName name="spec"\/>/g) || []).length, 2, '放行后确实两个 spec');
  } finally {
    await client.close();
    fs.rmSync(d, { recursive: true, force: true });
  }
});
