// test/embedded-submit.test.js —— 单元格内嵌提交（Commit2DBJavaScript）
//
// 背景（新品表实测 2026-10-23）：FreeButton 的点击事件常是 com.fr.js.Commit2DBJavaScript，
// 它把若干套 <Attributes name="提交N"/> + <DMLConfig> 内嵌在 <JavaScript> 里（不是 SubmitVisitor）。
// 这类提交此前是 cpt-mcp 的盲区，实测三处缺陷：
//   ① get_fill_config / overview().fillSubmits 只数报表级 SubmitVisitor（4 套提交只报 2 套）；
//   ② update_fill_binding 按全局 submitIndex 定位 SubmitVisitor —— 传 1 会**改到报表级第 2 个提交**（误伤）；
//   ③ update_cell_listener / delete_cell_listener 整块替换 Listener → 内嵌 DMLConfig 静默丢失
//      （实测 4 套 → 2 套），且 validate 只报 info。
// 本文件锁定补齐后的行为：读得到、改得准、破坏性操作被拒。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createCpt } from '../lib/generate.js';
import { updateEmbeddedSubmit, updateCellListener, deleteCellListener, getCellListener } from '../lib/edits.js';
import { embeddedSubmits, overview } from '../lib/cpt.js';
import { validateCpt } from '../lib/validate.js';
import { normalizeCell, colName, colIndex } from '../lib/embedded.js';
import '../scripts/isolate-store.mjs';

delete process.env.CPT_MCP_ALLOWED_ROOTS;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-emb-'));
const read = (p) => fs.readFileSync(p, 'utf8');
const cnt = (s, re) => (s.match(re) || []).length;
const warns = (p) => validateCpt(p).filter((i) => i.severity === 'warning');
const errs = (p) => validateCpt(p).filter((i) => i.severity === 'error');

/** 一列映射；constant 给了就写常量值形态 */
const col = (name, column, { isKey = false, constant } = {}) => (constant !== undefined
  ? `<ColumnConfig name="${name}" isKey="${isKey}" skipUnmodified="false">\n<O>\n<![CDATA[${constant}]]></O>\n</ColumnConfig>`
  : `<ColumnConfig name="${name}" isKey="${isKey}" skipUnmodified="false">\n<ColumnRow column="${column}" row="1"/>\n</ColumnConfig>`);

const dml = (table, cols) => `<DMLConfig class="com.fr.write.config.IntelliDMLConfig">
<Table schema="" name="${table}"/>
${cols.join('\n')}
<Condition class="com.fr.data.condition.ListCondition"/>
</DMLConfig>`;

const sub = (name, table, cols) => `<Attributes dsName="填报-读写" name="${name}"/>
${dml(table, cols)}`;

const submitVisitor = (name, table, cols) => `<SubmitVisitor class="com.fr.report.write.BuiltInSQLSubmiter">
<Attributes dsName="填报-读写" name="${name}"/>
${dml(table, cols)}
</SubmitVisitor>`;

/**
 * 夹具（数值口径照抄新品表真实形态，只缩小规模）：
 *   报表级：主提交 → bas_new_product_mechanism（dg_pictrue=c7）；汇总 → mechanism_summary_pashe（operation_record=c29）
 *   内嵌 AF2 点击：提交2 → bas_new_product_mechanism（dg_pictrue=c6，故意与主提交错列）
 *                      提交3 → mechanism_summary（operation_record=c34，与 pashe 的 c29 不一致）
 *              另带提交后回调 JS（fr_submitinfo）
 */
function fixture() {
  const d = tmp();
  const p = path.join(d, 't.cpt');
  createCpt(p, { rows: 3, columns: 3 });
  let raw = read(p);

  const button = `<C c="1" r="1">
<O t="String">
<![CDATA[]]></O>
<Widget class="com.fr.form.ui.FreeButton">
<Listener event="click" name="点击1">
<JavaScript class="com.fr.js.Commit2DBJavaScript">
<Parameters/>
${sub('提交2', 'bas_new_product_mechanism', [
  col('sku_code', 1, { isKey: true }), col('dg_pictrue', 6), col('selling_price', 10), col('quantity', 11),
])}
${sub('提交3', 'mechanism_summary', [
  col('sku_code', 1, { isKey: true }), col('new_product_mechanism', 33), col('operation_record', 34),
])}
<JavaScript class="com.fr.js.JavaScriptImpl">
<Parameters/>
<Content>
<![CDATA[if (fr_submitinfo.success) { FR.Msg.toast("删除成功"); }]]></Content>
</JavaScript>
</JavaScript>
</Listener>
</Widget>
</C>`;

  raw = raw.replace('<CellElementList>', `<CellElementList>\n${button}`);
  raw = raw.replace('</Report>', `<ReportWriteAttr>
${submitVisitor('主提交', 'bas_new_product_mechanism', [col('sku_code', 1, { isKey: true }), col('dg_pictrue', 7)])}
${submitVisitor('汇总提交', 'mechanism_summary_pashe', [
  col('sku_code', 1, { isKey: true }), col('new_product_mechanism', 33), col('operation_record', 29),
])}
</ReportWriteAttr>
</Report>`);
  fs.writeFileSync(p, raw);
  return { d, p };
}

test('读侧：overview 与 get_embedded_submits 都看得到内嵌提交', () => {
  const { d, p } = fixture();
  const ov = overview(p);
  assert.equal(ov.fillSubmits, 2, '报表级 SubmitVisitor 仍是 2 个');
  assert.equal(ov.embeddedSubmits.count, 2, 'overview 应报出内嵌提交 2 套');
  const r = embeddedSubmits(p);
  assert.equal(r.count, 2);
  assert.equal(r.blocks, 1);
  const cell = r.cells[0];
  assert.deepEqual(cell.cell, { column: 1, row: 1 });
  assert.equal(cell.cellRef, 'B2');
  assert.equal(cell.event, 'click');
  assert.deepEqual(cell.submits.map((s) => s.name), ['提交2', '提交3']);
  const s2 = cell.submits[0];
  assert.equal(s2.table, 'bas_new_product_mechanism');
  assert.equal(s2.columnCount, 4);
  assert.deepEqual(s2.columns.find((c) => c.name === 'sku_code'), {
    name: 'sku_code', isKey: true, skipUnmodified: false, column: 1, row: 1, constant: null,
  });
  assert.ok(r.reportLevel.length === 2, 'reportLevel 应同时回显报表级提交');
  fs.rmSync(d, { recursive: true, force: true });
});

test('读侧：crossCheck 抓到「近表 + 同名字段列号不一致」（同一逻辑数据被写成两个表名）', () => {
  const { d, p } = fixture();
  const r = embeddedSubmits(p);
  const c3 = r.crossCheck.find((x) => x.submit === '提交3');
  assert.ok(c3, `应命中 提交3 的交叉核对，实际 ${JSON.stringify(r.crossCheck)}`);
  const vs = c3.vs[0];
  assert.equal(vs.reportLevelTable, 'mechanism_summary_pashe');
  assert.equal(vs.embeddedTable, 'mechanism_summary');
  assert.deepEqual(vs.diverged, [{ field: 'operation_record', embedded: 34, reportLevel: 29 }]);
  fs.rmSync(d, { recursive: true, force: true });
});

test('写侧 patch：只改目标字段列号，其它提交与回调 JS 逐字节保留', () => {
  const { d, p } = fixture();
  const before = read(p);
  const r = updateEmbeddedSubmit(p, { submit: '提交3', field: 'operation_record', column: 29 });
  assert.equal(r.mode, 'patch');
  assert.equal(r.table, 'mechanism_summary');
  assert.equal(r.fieldAfter.column, 29);
  const after = read(p);
  assert.equal(cnt(after, /<DMLConfig\b/g), cnt(before, /<DMLConfig\b/g), 'DMLConfig 数量不得变化');
  assert.ok(after.includes('if (fr_submitinfo.success)'), '提交后回调 JS 必须保留');
  // 提交2 完全未受影响
  assert.equal(read(p).includes('<ColumnConfig name="dg_pictrue" isKey="false" skipUnmodified="false">\n<ColumnRow column="6"'), true);
  assert.deepEqual(
    embeddedSubmits(p).cells[0].submits.find((s) => s.name === '提交3').columns.find((c) => c.name === 'operation_record'),
    { name: 'operation_record', isKey: false, skipUnmodified: false, column: 29, row: 1, constant: null },
  );
  // 交叉核对随之清空
  assert.equal(embeddedSubmits(p).crossCheck.length, 0);
  assert.equal(errs(p).length, 0);
  fs.rmSync(d, { recursive: true, force: true });
});

test('写侧 replace：整列清单替换（删冗余列），保留 Table/Condition 与其它提交', () => {
  const { d, p } = fixture();
  const r = updateEmbeddedSubmit(p, {
    submit: '提交2',
    mode: 'replace',
    columns: [{ name: 'sku_code', column: 1, isKey: true }, { name: 'is_delete', column: 32 }],
  });
  assert.equal(r.mode, 'replace');
  assert.equal(r.columnsBefore, 4);
  assert.equal(r.columnsAfter, 2);
  assert.equal(r.removedColumns, 2);
  const after = read(p);
  assert.equal(cnt(after, /<DMLConfig\b/g), 4, '四套 DMLConfig 全部保留');
  assert.ok(after.includes('<Table schema="" name="bas_new_product_mechanism"/>'));
  assert.ok(after.includes('<Condition class="com.fr.data.condition.ListCondition"/>'));
  assert.ok(after.includes('if (fr_submitinfo.success)'));
  const cols = embeddedSubmits(p).cells[0].submits.find((s) => s.name === '提交2').columns;
  assert.deepEqual(cols.map((c) => `${c.name}@c${c.column}${c.isKey ? '#' : ''}`), ['sku_code@c1#', 'is_delete@c32']);
  assert.equal(errs(p).length, 0);
  fs.rmSync(d, { recursive: true, force: true });
});

test('写侧：定位与参数防护（未找到/歧义/重复字段/非法列号/常量互斥）', () => {
  const { d, p } = fixture();
  assert.throws(() => updateEmbeddedSubmit(p, { submit: '不存在', field: 'x', column: 1 }), /未找到内嵌提交/);
  assert.throws(() => updateEmbeddedSubmit(p, { submit: '提交2', field: '不存在', column: 1 }), /未找到字段/);
  assert.throws(() => updateEmbeddedSubmit(p, { submit: '提交2' }), /至少提供/);
  assert.throws(() => updateEmbeddedSubmit(p, { submit: '提交2', field: 'sku_code', column: 1, constant: 0 }), /互斥/);
  assert.throws(() => updateEmbeddedSubmit(p, { submit: '提交2', field: 'sku_code', column: -1 }), /非负整数/);
  assert.throws(() => updateEmbeddedSubmit(p, { submit: '提交2', mode: 'replace', columns: [] }), /非空 columns/);
  assert.throws(() => updateEmbeddedSubmit(p, {
    submit: '提交2', mode: 'replace', columns: [{ name: 'a', column: 1 }, { name: 'a', column: 2 }],
  }), /重复/);
  assert.throws(() => updateEmbeddedSubmit(p, { submit: '提交2', mode: 'bogus' }), /mode 只能是/);
  // cell 选择子：A1 记法/坐标对/纯列名都能解析
  const r = updateEmbeddedSubmit(p, { submit: '提交3', cell: 'B2', field: 'operation_record', column: 29 });
  assert.deepEqual(r.cell, { column: 1, row: 1 });
  fs.rmSync(d, { recursive: true, force: true });
});

test('防护：update/delete_cell_listener 拒绝内嵌提交宿主（避免静默丢提交配置），force 为逃生阀', () => {
  const { d, p } = fixture();
  const before = cnt(read(p), /<DMLConfig\b/g);
  assert.throws(() => updateCellListener(p, 1, 1, { event: 'click', js: 'x();' }), /内嵌提交宿主/);
  assert.throws(() => deleteCellListener(p, 1, 1, { event: 'click' }), /内嵌提交宿主/);
  assert.equal(cnt(read(p), /<DMLConfig\b/g), before, '被拒后文件不得改动');
  // 逃生阀：显式 force=true 才允许整块覆盖（会丢提交配置，属用户明确要求）
  updateCellListener(p, 1, 1, { event: 'click', js: 'x();', force: true });
  assert.equal(cnt(read(p), /<DMLConfig\b/g), before - 2, 'force 覆盖后内嵌提交确实被删（说明护栏是唯一防线）');
  fs.rmSync(d, { recursive: true, force: true });
});

test('读侧纠偏：get_cell_listener 标明 commit2db 与「js 只是提交后回调」', () => {
  const { d, p } = fixture();
  const l = getCellListener(p, 1, 1).listeners[0];
  assert.equal(l.className, 'com.fr.js.Commit2DBJavaScript');
  assert.equal(l.commit2db, true);
  assert.equal(l.embeddedSubmitCount, 2);
  assert.equal(l.jsRole, 'postSubmitCallback');
  assert.match(l.note, /get_embedded_submits/);
  assert.match(l.js, /fr_submitinfo\.success/, 'js 字段仍是回调正文（供只读查看）');
  fs.rmSync(d, { recursive: true, force: true });
});

test('validate：同表跨提交列号不一致 / 重复字段 / 无坐标字段都只告警不阻断', () => {
  const { d, p } = fixture();
  const w = warns(p).filter((i) => /提交/.test(`${i.location}${i.message}`));
  assert.ok(w.some((i) => /dg_pictrue/.test(`${i.location}${i.message}`) && /=c6/.test(i.message) && /=c7/.test(i.message)),
    `应报 dg_pictrue 同表跨提交错列，实际 ${w.map((x) => `${x.location}｜${x.message}`).join(' | ')}`);
  assert.equal(errs(p).length, 0, '告警不得升格为 error（否则会破坏官方 1550 样本基线）');

  // 手工造坏形态：重复字段 + 无坐标字段
  let raw = read(p);
  raw = raw.replace('<ColumnConfig name="selling_price" isKey="false" skipUnmodified="false">\n<ColumnRow column="10" row="1"/>',
    '<ColumnConfig name="selling_price" isKey="false" skipUnmodified="false">\n<ColumnRow column="10" row="1"/>');
  raw = raw.replace('</DMLConfig>', '<ColumnConfig name="ghost" isKey="false" skipUnmodified="false">\n</ColumnConfig>\n</DMLConfig>');
  fs.writeFileSync(p, raw);
  const w2 = warns(p).filter((i) => /提交/.test(`${i.location}${i.message}`));
  assert.ok(w2.some((i) => /ghost/.test(i.message) && /无 ColumnRow 也无常量/.test(i.message)), '应报无坐标字段');
  fs.rmSync(d, { recursive: true, force: true });
});

test('cellRef 工具函数：列号 ↔ Excel 列名互转', () => {
  assert.equal(colName(31), 'AF');
  assert.equal(colName(0), 'A');
  assert.equal(colName(29), 'AD');
  assert.equal(colIndex('AF'), 31);
  assert.equal(colIndex('ad'), 29);
  assert.deepEqual(normalizeCell('AF2'), { column: 31, row: 1 });
  assert.deepEqual(normalizeCell('31,1'), { column: 31, row: 1 });
  assert.deepEqual(normalizeCell({ column: 3, row: 0 }), { column: 3, row: 0 });
  assert.deepEqual(normalizeCell('AF'), { column: 31, row: null });
  assert.throws(() => normalizeCell('乱写'), /cell 无法解析/);
});

test('MCP：get_embedded_submits / update_embedded_submit 经 fill_binding 租约可调用并真实落盘', async () => {
  const { d, p } = fixture();
  const client = new Client({ name: 'embedded-submit-test', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['server.js'],
    cwd: path.join(__dirname, '..'),
    env: { CPT_MCP_TOOL_PROFILE: 'full' },
    stderr: 'pipe',
  });
  await client.connect(transport);
  try {
    const decode = (r) => JSON.parse(r.content[0].text);
    const access = decode(await client.callTool({
      name: 'request_deep_tool_access',
      arguments: { group: 'fill_binding', path: p, reason: 'explicit_fill_setup' },
    }));
    assert.equal(access.status, 'granted');
    assert.ok(access.enabledTools.includes('get_embedded_submits'), '租约应含 get_embedded_submits');
    assert.ok(access.enabledTools.includes('update_embedded_submit'), '租约应含 update_embedded_submit');

    const got = decode(await client.callTool({ name: 'get_embedded_submits', arguments: { path: p } }));
    assert.equal(got.count, 2);
    assert.equal(got.cells[0].cellRef, 'B2');

    const upd = decode(await client.callTool({
      name: 'update_embedded_submit',
      arguments: { path: p, submit: '提交3', field: 'operation_record', column: 29 },
    }));
    assert.equal(upd.fieldAfter.column, 29);
    assert.equal(embeddedSubmits(p).cells[0].submits.find((s) => s.name === '提交3').columns.find((c) => c.name === 'operation_record').column, 29);
  } finally {
    await client.close();
    fs.rmSync(d, { recursive: true, force: true });
  }
});
