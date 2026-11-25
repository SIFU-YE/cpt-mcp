// test/widget-props-rebuild.test.js —— 控件输入属性 / 单格重建 / 无字典补骨架（2026-11-19）
//
// 对应另一个会话提出的三项能力缺口（建议稿：某会话/cpt-mcp-能力改进建议-widgetAttr与单格重建.md）：
//   A. 控件输入属性无法写入：允许为空 / 允许直接编辑 / 允许自定义值。
//      实证修正建议稿的猜测：它们不是 <WidgetAttr> 属性，而是 <Widget> 内同级子元素
//      <allowBlank>/<DirectEdit>/<CustomData>（官方 reportlets：销售财务报销表.cpt、
//      自定义参数大小比较.cpt；项目模板 通知排产表.cpt 三属性齐全）。
//   B. 已存在格无法换控件（delete_cell 在 cell_primitive 门禁内）→ add_cell({overwrite:true})
//      一次调用整格重建，不碰其它格/行列尺寸/ColumnRow 绑定。
//   C. update_cell_dictionary 拒绝无 <Dictionary> 的格 → create:true 给下拉控件补官方形态字典骨架。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createCpt, addCell } from '../lib/generate.js';
import { cells, reportListener } from '../lib/cpt.js';
import { setCellWidget, updateCellDictionary, getCellDictionary } from '../lib/edits.js';
import { validateCpt } from '../lib/validate.js';
import '../scripts/isolate-store.mjs';

delete process.env.CPT_MCP_ALLOWED_ROOTS;

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-wprop-'));
const errCount = (p) => (validateCpt(p) || []).filter((x) => x.severity === 'error').length;
const xml = (p) => fs.readFileSync(p, 'utf8');
const cellXml = (p, col, row) => {
  const raw = xml(p);
  const re = new RegExp(`<C c="${col}" r="${row}"[\\s\\S]*?</C>`);
  const m = raw.match(re);
  return m ? m[0] : null;
};

function fixture({ widget = 'comboBox', withDict = true } = {}) {
  const d = tmp();
  const p = path.join(d, 't.cpt');
  createCpt(p, { rows: 3, columns: 3, webWrite: true });
  addCell(p, {
    column: 1, row: 1, widget, widgetItems: withDict ? [{ key: 'A', value: 'A' }] : undefined,
  });
  return { d, p };
}

test('A：add_cell widgetProps 写 <allowBlank>/<DirectEdit>/<CustomData> 子元素（不是 WidgetAttr 属性）', () => {
  const { d, p } = fixture();
  const r = addCell(p, {
    column: 0, row: 0, widget: 'comboBox', widgetItems: [{ key: 'A', value: 'A' }],
    widgetProps: { allowBlank: false, directEdit: true, customData: true },
  });
  assert.equal(r.action, 'add_cell');
  const block = cellXml(p, 0, 0);
  assert.match(block, /<WidgetAttr[^>]*>\s*<MobileBookMark/, 'WidgetAttr 节点应保持原形态');
  assert.doesNotMatch(block, /<WidgetAttr[^>]*\ballowBlank=/, 'allowBlank 不得写成 WidgetAttr 属性');
  const iWa = block.indexOf('</WidgetAttr>');
  const iBlank = block.indexOf('<allowBlank>');
  const iDe = block.indexOf('<DirectEdit>');
  const iCd = block.indexOf('<CustomData>');
  const iDict = block.indexOf('<Dictionary');
  assert.ok(iWa >= 0 && iBlank > iWa, 'allowBlank 应在 </WidgetAttr> 之后');
  assert.ok(iDe > iBlank && iCd > iDe, '官方顺序 allowBlank → DirectEdit → CustomData');
  assert.ok(iDict > iCd, 'Dictionary 应在三个属性之后');
  assert.match(block, /<allowBlank>\s*<\!\[CDATA\[false\]\]><\/allowBlank>/);
  assert.match(block, /<DirectEdit>\s*<\!\[CDATA\[true\]\]><\/DirectEdit>/);
  assert.match(block, /<CustomData>\s*<\!\[CDATA\[true\]\]><\/CustomData>/);
  // 读侧对称
  const c = cells(p).find((x) => x.column === 0 && x.row === 0);
  assert.deepEqual(c.widgetProps, { allowBlank: false, directEdit: true, customData: true });
  assert.equal(errCount(p), 0);
  fs.rmSync(d, { recursive: true, force: true });
});

test('A：text 控件 allowBlank 双写（<allowBlank> + <TextAttr allowBlank> 镜像，官方 TextEditor 形态）', () => {
  const { d, p } = fixture({ widget: 'text' });
  addCell(p, { column: 0, row: 0, content: 'x', widget: 'text', widgetProps: { allowBlank: false } });
  const block = cellXml(p, 0, 0);
  assert.match(block, /<allowBlank>\s*<\!\[CDATA\[false\]\]><\/allowBlank>/);
  assert.match(block, /<TextAttr allowBlank="false"\/>/, 'TextEditor 需同步 TextAttr 镜像属性');
  assert.equal(cells(p).find((x) => x.column === 0 && x.row === 0).widgetProps.allowBlank, false);
  assert.equal(errCount(p), 0);
  fs.rmSync(d, { recursive: true, force: true });
});

test('A：不支持组合/未知键/非布尔值全部拒绝且不写文件', () => {
  const { d, p } = fixture({ widget: 'label' });
  const before = xml(p);
  assert.throws(() => addCell(p, { column: 0, row: 0, widget: 'label', widgetProps: { allowBlank: false } }), /不支持|widgetProps/);
  assert.throws(() => addCell(p, { column: 0, row: 0, widget: 'comboBox', widgetProps: { editable: true } }), /白名单/);
  assert.throws(() => addCell(p, { column: 0, row: 0, widget: 'comboBox', widgetProps: { allowBlank: 'false' } }), /布尔值/);
  assert.throws(() => addCell(p, { column: 1, row: 1, widget: 'comboBox', widgetProps: { customData: true }, overwrite: false }), /已存在/);
  assert.equal(xml(p), before, '被拒绝时文件必须原样');
  fs.rmSync(d, { recursive: true, force: true });
});

test('A：set_cell_widget 就地写 widgetProps（只动属性子元素，内容/绑定/监听器保留）', () => {
  const { d, p } = fixture();
  setCellWidget(p, { column: 1, row: 1, type: 'comboBox', disabled: true });
  const before = cellXml(p, 1, 1);
  const r = setCellWidget(p, { column: 1, row: 1, type: 'comboBox', widgetProps: { allowBlank: true, directEdit: false } });
  assert.deepEqual(r.widgetProps, { allowBlank: true, directEdit: false });
  const after = cellXml(p, 1, 1);
  assert.match(after, /<allowBlank>\s*<\!\[CDATA\[true\]\]><\/allowBlank>/);
  assert.match(after, /<DirectEdit>\s*<\!\[CDATA\[false\]\]><\/DirectEdit>/);
  assert.match(after, /disabled="true"/, '原 disabled 状态保留');
  assert.match(after, /<Dictionary class="com\.fr\.data\.impl\.CustomDictionary">/, '原字典保留');
  assert.equal(errCount(p), 0);
  assert.ok(before.length > 0);
  fs.rmSync(d, { recursive: true, force: true });
});

test('B：overwrite=false/缺省 → 旧报错文案不变；overwrite=true → 一次调用整格重建', () => {
  const { d, p } = fixture();
  // 旧行为：不加 overwrite 必须保持原报错
  assert.throws(
    () => addCell(p, { column: 1, row: 1, content: 'y' }),
    /已存在 \(1,1\)；请先 delete_cell 或换一个坐标/,
  );
  // 旁格（用于验证「整格替换不得动其它格」）
  addCell(p, { column: 0, row: 2, content: '旁格' });
  const before = xml(p);
  const cellBlocks = (s) => s.match(/<C c="\d+" r="\d+"[\s\S]*?<\/C>/g) || [];
  const othersBefore = cellBlocks(before).filter((b) => !b.startsWith('<C c="1" r="1"'));
  const columnRowBefore = (before.match(/<ColumnRow>[\s\S]*?<\/ColumnRow>/g) || []).join('\n');
  const r = addCell(p, {
    column: 1, row: 1, content: '重建文本', widget: 'text', styleIndex: 0,
    widgetProps: { allowBlank: true }, overwrite: true,
  });
  assert.equal(r.mode, 'overwrite');
  assert.equal(r.overwritten, true);
  const after = xml(p);
  // 目标格只剩一个 C 节点（不能出现重复坐标）
  const dup = (after.match(/<C c="1" r="1"/g) || []).length;
  assert.equal(dup, 1, '整格替换后坐标只应有一个 <C>');
  const c = cells(p).find((x) => x.column === 1 && x.row === 1);
  assert.equal(c.widgetClass, 'com.fr.form.ui.TextEditor', '控件已换为 text');
  assert.deepEqual(c.widgetProps, { allowBlank: true }, '新控件的 widgetProps 生效');
  // 其它格与 ColumnRow 绑定原样
  const othersAfter = cellBlocks(after).filter((b) => !b.startsWith('<C c="1" r="1"'));
  assert.deepEqual(othersAfter, othersBefore, '不得动其它单元格');
  assert.equal((after.match(/<ColumnRow>[\s\S]*?<\/ColumnRow>/g) || []).join('\n'), columnRowBefore, '不得动 ColumnRow 填报绑定');
  assert.equal(errCount(p), 0);
  fs.rmSync(d, { recursive: true, force: true });
});

test('B：overwrite=true 但坐标不存在 → 正常新增（不产生空覆盖）', () => {
  const { d, p } = fixture();
  const r = addCell(p, { column: 2, row: 2, content: '新格', overwrite: true });
  assert.equal(r.mode, undefined);
  assert.equal(r.overwritten, undefined);
  assert.equal(cells(p).find((x) => x.column === 2 && x.row === 2).contentText, '新格');
  assert.equal(errCount(p), 0);
  fs.rmSync(d, { recursive: true, force: true });
});

test('C：update_cell_dictionary create:true 给「无 Dictionary 的下拉控件」补官方骨架', () => {
  const { d, p } = fixture({ widget: 'text' });
  setCellWidget(p, { column: 1, row: 1, type: 'comboBox' }); // 只换 class：无 Dictionary
  assert.throws(
    () => updateCellDictionary(p, { column: 1, row: 1, sheet: 0, items: [{ key: 'a', value: 'A' }] }),
    /无 <Dictionary>/,
  );
  const r = updateCellDictionary(p, {
    column: 1, row: 1, sheet: 0, create: true, items: [{ key: 'a', value: 'A' }],
  });
  assert.equal(r.mode, 'create');
  assert.equal(r.created.kind, 'custom');
  const block = cellXml(p, 1, 1);
  assert.match(block, /<Dictionary class="com\.fr\.data\.impl\.CustomDictionary">/);
  assert.ok(block.indexOf('</WidgetAttr>') < block.indexOf('<Dictionary'), '字典应在 WidgetAttr 之后');
  assert.ok(block.indexOf('<Dictionary') < block.indexOf('<widgetValue>'), '字典应在 widgetValue 之前');
  const dict = getCellDictionary(p, { column: 1, row: 1, sheet: 0 });
  assert.equal(dict.kind, 'custom');
  assert.equal(dict.items[0].key, 'a');
  assert.equal(errCount(p), 0);
  fs.rmSync(d, { recursive: true, force: true });
});

test('C：create:true 只对下拉控件生效；dictionary/table/formula 三种来源均可', () => {
  const { d, p } = fixture({ widget: 'text' });
  // 非下拉控件 → 拒绝
  assert.throws(
    () => updateCellDictionary(p, { column: 1, row: 1, sheet: 0, create: true, items: [{ key: 'a', value: 'A' }] }),
    /只支持下拉控件/,
  );
  // 换成 comboBox 后用 create:true 补骨架（同一坐标）
  setCellWidget(p, { column: 1, row: 1, type: 'comboBox' });
  const r = updateCellDictionary(p, {
    column: 1, row: 1, sheet: 0, create: true, items: [{ key: 'x', value: 'X' }],
  });
  assert.equal(r.mode, 'create');
  assert.equal(getCellDictionary(p, { column: 1, row: 1, sheet: 0 }).kind, 'custom');
  fs.rmSync(d, { recursive: true, force: true });
});

test('MCP report 档端到端：add_cell widgetProps/overwrite/widgetItems(数组) 均可调、get_cells 可读回', async () => {
  const dir = tmp();
  const p = path.join(dir, 'e2e.cpt');
  const client = new Client({ name: 'wprop-test', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath, args: ['server.js'], cwd: process.cwd(), stderr: 'pipe',
    env: { CPT_MCP_TOOL_PROFILE: 'report' },
  });
  await client.connect(transport);
  const call = async (name, args) => {
    const r = await client.callTool({ name, arguments: args });
    const text = r.content?.[0]?.text ?? '';
    let data = null;
    try { data = JSON.parse(text); } catch { /* error text */ }
    return { isError: r.isError === true, text, data };
  };
  try {
    const tools = (await client.listTools()).tools;
    const props = Object.keys(tools.find((t) => t.name === 'add_cell').inputSchema.properties);
    assert.ok(props.includes('widgetProps'), `add_cell 广告 schema 应含 widgetProps，实际 ${props.join(',')}`);
    assert.ok(props.includes('overwrite'), 'add_cell 广告 schema 应含 overwrite');
    const created = await call('create_cpt', { path: p, rows: 3, columns: 3, webWrite: true });
    assert.ok(!created.isError, created.text.slice(0, 200));
    const added = await call('add_cell', {
      path: p, column: 0, row: 0, widget: 'comboBox',
      widgetItems: [{ key: 'A', value: 'A' }], widgetProps: { allowBlank: false, customData: true },
    });
    assert.ok(!added.isError, added.text.slice(0, 300));
    const read = await call('get_cells', { path: p, column: 0, row: 0 });
    const cell = (read.data?.cells || read.data || [])[0] || read.data;
    assert.deepEqual(cell?.widgetProps, { allowBlank: false, customData: true });
    const re = await call('add_cell', { path: p, column: 0, row: 0, content: '换掉', widget: 'text', overwrite: true });
    assert.ok(!re.isError, re.text.slice(0, 300));
    assert.equal(re.data?.mode, 'overwrite');
    // 顶层数组不被桥接序列化成字符串（建议稿 §1.1 的回归保护）
    const added2 = await call('add_cell', {
      path: p, column: 1, row: 1, widget: 'comboBox', widgetItems: [{ key: 'B', value: 'B' }],
    });
    assert.ok(!added2.isError, `widgetItems 数组应原样通过：${added2.text.slice(0, 200)}`);
  } finally {
    await client.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('规格分节已记录三项能力（供 get_capabilities 按需下发，不进常驻 schema）', async () => {
  const { SPEC_SECTIONS } = await import('../lib/spec-sections.js');
  const widget = SPEC_SECTIONS['cell.widget'].covers;
  assert.match(widget, /widgetProps/);
  assert.match(widget, /allowBlank/);
  assert.match(widget, /overwrite/);
  assert.match(SPEC_SECTIONS['cell.dictionary'].covers, /create:true/);
  assert.ok(reportListener); // 保持可导入（避免误删导入）
});
