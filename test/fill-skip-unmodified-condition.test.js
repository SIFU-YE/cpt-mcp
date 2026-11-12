// test/fill-skip-unmodified-condition.test.js —— sandbox19/v1 会话暴露的 cpt-mcp 能力缺口回归
//
// 背景（2026-10-31 追溯 sandbox19/v1 会话）：
//   ① 会话最后被明确卡住的一条：FR「未修改则跳过」（<ColumnConfig skipUnmodified="true">，
//      即列级智能提交/只写改动字段）在 fill_binding 族 9 个工具里**没有任何参数能设置**，
//      只能让用户去设计器逐列勾 —— 用户已明确要求改，工具做不到；
//   ② 提交条件（DMLConfig 里的 FormulaCondition，如 Y5=1）**既读不到也改不了**：get_fill_config
//      不返回，update_fill_submit 没参数，只能 report_rewrite/update_report_node 手拼 XML；
//      而插列后条件里的 A1 引用不会自动改，条件陈旧会让提交"静默不写库"（一行都不过滤）；
//   ③ update_report_node 的 xmlBody 文档写"含/不含外层标签均可"，实现却无条件再包一层 →
//      出现 <Condition><Condition> 双层嵌套（会话里就是手工再修一层）；
//   ④ add_cell 的 expand 传 JSON 字符串时连试 5 次都被 "expected object" 拒绝（模型自然写法）。
// 本文件按缺口逐条固化行为（lib 直调口径 + 一处归一化单测）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';

import { createCpt, addCell, addFillSubmit } from '../lib/generate.js';
import { addFillBinding, updateFillBinding, updateFillSubmit, updateReportNode, updateEmbeddedSubmit } from '../lib/edits.js';
import { fillConfig } from '../lib/cpt.js';
import { normalizeArgs, sdkLenientShape } from '../lib/arg-normalize.js';
import '../scripts/isolate-store.mjs';

delete process.env.CPT_MCP_ALLOWED_ROOTS;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-mcp-fill-gaps-'));
const file = (n) => path.join(TMP, n);
const read = (p) => fs.readFileSync(p, 'utf8');
const count = (s, re) => (s.match(re) || []).length;

const COND_OPEN = '<Condition class="com.fr.data.condition.FormulaCondition">';

/** 建一个带 webWrite 容器 + 一个列映射提交的模板（skipUnmodified/condition 都落在这里） */
function fixture(name, { bindings, condition } = {}) {
  const p = file(name);
  createCpt(p, { rows: 12, columns: 8, webWrite: true });
  addFillSubmit(p, {
    dsName: 'Doris', table: 'ads_t', name: '提交',
    bindings: bindings ?? [{ field: 'a', column: 0, row: 0, isKey: true }],
    ...(condition !== undefined ? { condition } : {}),
  });
  return p;
}

test('add_fill_submit：bindings[].skipUnmodified 落盘并可回读（列级智能提交不再是盲区）', () => {
  const p = file('add-submit-skip.cpt');
  createCpt(p, { rows: 6, columns: 5, webWrite: true });
  const r = addFillSubmit(p, {
    dsName: 'Doris', table: 't', name: '提交',
    bindings: [
      { field: 'a', column: 0, row: 0, isKey: true, skipUnmodified: true },
      { field: 'b', column: 1, row: 0 },
      { field: 'c', column: 2, row: 0, constant: '0', skipUnmodified: true },
    ],
  });
  assert.equal(r.action, 'add_fill_submit');
  const raw = read(p);
  assert.ok(raw.includes('name="a" isKey="true" skipUnmodified="true">'), `a 应为 skipUnmodified=true：\n${raw}`);
  assert.ok(raw.includes('name="b" isKey="false" skipUnmodified="false">'), 'b 缺省必须保持 false（旧字节不变）');
  assert.ok(raw.includes('name="c" isKey="false" skipUnmodified="true">'), '常量绑定也要能设 skipUnmodified');
  const cols = fillConfig(p).submits[0].columns;
  assert.deepEqual(cols.map((c) => [c.field, c.skipUnmodified]), [['a', true], ['b', false], ['c', true]]);
});

test('add_fill_binding / update_fill_binding：逐列开关 skipUnmodified（含常量绑定路径）', () => {
  const p = fixture('binding-skip.cpt');
  addFillBinding(p, 0, 'b', 1, 0, false, undefined, true);
  let cols = fillConfig(p).submits[0].columns;
  assert.equal(cols.find((c) => c.field === 'b').skipUnmodified, true, 'addFillBinding 第 8 参 skipUnmodified=true 应落盘');
  assert.ok(read(p).includes('name="b" isKey="false" skipUnmodified="true">'));

  const u1 = updateFillBinding(p, 0, 'b', { skipUnmodified: false });
  assert.equal(u1.skipUnmodified, false);
  cols = fillConfig(p).submits[0].columns;
  assert.equal(cols.find((c) => c.field === 'b').skipUnmodified, false, 'updateFillBinding 应能改回 false');

  // 常量绑定分支也要带上 skipUnmodified（旧实现该分支直接 return，参数会被静默丢掉）
  const u2 = updateFillBinding(p, 0, 'b', { constant: 'x', skipUnmodified: true });
  assert.equal(u2.mode, 'constant');
  cols = fillConfig(p).submits[0].columns;
  const b = cols.find((c) => c.field === 'b');
  assert.equal(b.skipUnmodified, true);
  assert.equal(b.constant, 'x');
});

test('update_fill_submit({skipUnmodified})：一次批量设置/恢复该提交全部列', () => {
  const p = fixture('bulk-skip.cpt', {
    bindings: [{ field: 'a', column: 0, row: 0 }, { field: 'b', column: 1, row: 0 }, { field: 'c', column: 2, row: 0 }],
  });
  const r = updateFillSubmit(p, { submitIndex: 0, skipUnmodified: true });
  assert.ok(r.changed.includes('skipUnmodified'));
  assert.equal(r.skipUnmodifiedColumns, 3);
  assert.equal(r.skipUnmodified, true);
  assert.deepEqual(fillConfig(p).submits[0].columns.map((c) => c.skipUnmodified), [true, true, true]);
  // 恢复默认（整行覆盖）
  const r2 = updateFillSubmit(p, { submitIndex: 0, skipUnmodified: false });
  assert.equal(r2.skipUnmodifiedColumns, 3);
  assert.deepEqual(fillConfig(p).submits[0].columns.map((c) => c.skipUnmodified), [false, false, false]);
});

test('提交条件：add_fill_submit 写入、get_fill_config 回读、update_fill_submit 改写/清除', () => {
  const p = fixture('condition.cpt', { condition: '=Y5=1' });
  const raw = read(p);
  assert.ok(raw.includes(COND_OPEN), '提交条件节点必须写到 DMLConfig 里');
  assert.ok(/<!\[CDATA\[Y5=1\]\]>/.test(raw), '前导 = 应被归一掉（FormulaCondition 不需要 =）');
  // 结构顺序：Condition 在全部 ColumnConfig 之后、</DMLConfig> 之前
  assert.ok(raw.indexOf(COND_OPEN) > raw.lastIndexOf('<ColumnConfig '));
  assert.ok(raw.indexOf(COND_OPEN) < raw.indexOf('</DMLConfig>'));
  const cfg = fillConfig(p);
  assert.deepEqual(cfg.submits[0].condition, { class: 'com.fr.data.condition.FormulaCondition', formula: 'Y5=1' });

  const r = updateFillSubmit(p, { submitIndex: 0, condition: 'Z5 = 1' });
  assert.ok(r.changed.includes('condition'));
  assert.equal(r.condition, 'Z5 = 1');
  assert.equal(fillConfig(p).submits[0].condition.formula, 'Z5 = 1');
  assert.equal(count(read(p), new RegExp(COND_OPEN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')), 1, '改写不能叠加出第二个 Condition');

  const rClear = updateFillSubmit(p, { submitIndex: 0, condition: null });
  assert.ok(rClear.changed.includes('condition'));
  assert.equal(rClear.condition, null);
  assert.equal(fillConfig(p).submits[0].condition, null, '清除后 get_fill_config 应为 null');
  assert.ok(!read(p).includes(COND_OPEN));
  // 再清除一次：幂等（不报错、不用假 changed）
  const rNoop = updateFillSubmit(p, { submitIndex: 0, condition: null });
  assert.ok(!rNoop.changed.includes('condition'));
});

test('提交条件/skipUnmodified 只属于列映射提交：自由 SQL 提交直接拒绝', () => {
  const p = file('free-sql.cpt');
  createCpt(p, { rows: 4, columns: 4, webWrite: true });
  addFillSubmit(p, { dbName: '填报-读写', name: '删除', sql: 'UPDATE t SET a=1 WHERE id=${id}' });
  assert.throws(() => addFillSubmit(p, { dbName: '填报-读写', sql: 'UPDATE t SET a=1', condition: 'Y5=1' }), /只用于列映射提交/);
  assert.throws(() => updateFillSubmit(p, { submitIndex: 0, condition: 'Y5=1' }), /只用于列映射提交/);
  assert.throws(() => updateFillSubmit(p, { submitIndex: 0, skipUnmodified: true }), /只用于列映射提交/);
});

test('update_report_node：xmlBody 含外层标签时原样落盘（不再套成 <Condition><Condition>）', () => {
  const p = fixture('node-verbatim.cpt', { condition: 'Y5=1' });
  const condXml = `${COND_OPEN}\n<Formula>\n<![CDATA[Z5=1]]></Formula>\n</Condition>`;
  const r = updateReportNode(p, { nodeName: 'Condition', xmlBody: condXml, parent: 'DMLConfig' });
  assert.equal(r.wrapping, 'verbatim');
  assert.equal(r.attributesPreserved, true, '替换时应保留原开标签属性（class 不能被丢）');
  const raw = read(p);
  assert.equal(count(raw, new RegExp(COND_OPEN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')), 1);
  assert.ok(!/<Condition[^>]*>\s*<Condition/.test(raw), `不得出现双层 Condition：\n${raw}`);
  assert.ok(/<!\[CDATA\[Z5=1\]\]>/.test(raw));
  // 只给内层内容时仍按旧语义包裹（向后兼容）
  const r2 = updateReportNode(p, { nodeName: 'Condition', xmlBody: '<Formula>\n<![CDATA[W5=1]]></Formula>', parent: 'DMLConfig' });
  assert.equal(r2.wrapping, 'wrapped');
  assert.equal(count(read(p), new RegExp(COND_OPEN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')), 1);
});

test('update_embedded_submit：patch/replace 都能设置 skipUnmodified', () => {
  const p = file('embedded-skip.cpt');
  createCpt(p, { rows: 4, columns: 4 });
  // 最小内嵌提交夹具：FreeButton 的 Commit2DBJavaScript → Attributes + DMLConfig
  const button = `<C c="1" r="1">
<O t="String">
<![CDATA[]]></O>
<Widget class="com.fr.form.ui.FreeButton">
<Listener event="click" name="点击1">
<JavaScript class="com.fr.js.Commit2DBJavaScript">
<Parameters/>
<Attributes dsName="填报-读写" name="提交2"/>
<DMLConfig class="com.fr.write.config.IntelliDMLConfig">
<Table schema="" name="t"/>
<ColumnConfig name="sku_code" isKey="true" skipUnmodified="false">
<ColumnRow column="1" row="1"/>
</ColumnConfig>
<ColumnConfig name="qty" isKey="false" skipUnmodified="false">
<ColumnRow column="2" row="1"/>
</ColumnConfig>
</DMLConfig>
</JavaScript>
</Listener>
</Widget>
</C>`;
  fs.writeFileSync(p, read(p).replace('<CellElementList>', `<CellElementList>\n${button}`), 'utf8');

  const r = updateEmbeddedSubmit(p, { cell: 'B2', submit: '提交2', mode: 'patch', field: 'qty', skipUnmodified: true });
  assert.equal(r.skipUnmodified, true);
  assert.ok(read(p).includes('name="qty" isKey="false" skipUnmodified="true">'), 'patch 模式应改到 qty 的 skipUnmodified');
  assert.ok(read(p).includes('name="sku_code" isKey="true" skipUnmodified="false">'), '不应误改其它字段');

  updateEmbeddedSubmit(p, {
    cell: 'B2', submit: '提交2', mode: 'replace',
    columns: [
      { name: 'sku_code', column: 1, isKey: true, skipUnmodified: true },
      { name: 'qty', column: 2, skipUnmodified: false },
    ],
  });
  const raw = read(p);
  assert.ok(raw.includes('name="sku_code" isKey="true" skipUnmodified="true">'));
  assert.ok(raw.includes('name="qty" isKey="false" skipUnmodified="false">'));
});

test('参数归一：add_cell 的 expand 传 JSON 字符串自动解析为对象（SDK 层也放行）', () => {
  const schema = { path: z.string(), column: z.number(), row: z.number(), expand: z.object({}).passthrough().optional() };
  const r = normalizeArgs('add_cell', { path: 'x.cpt', column: 0, row: 0, expand: '{"dir":0,"leftParent":"B5"}' }, schema);
  assert.deepEqual(r.args.expand, { dir: 0, leftParent: 'B5' });
  assert.ok(r.fixes.some((f) => f.includes('expand')));
  // 非 JSON 字符串保持原样（交给 schema 报可读错误）
  const bad = normalizeArgs('add_cell', { path: 'x.cpt', column: 0, row: 0, expand: 'not-json' }, schema);
  assert.equal(bad.args.expand, 'not-json');
  // SDK 广告层：expand 必须是 z.any().optional()，否则字符串在处理器之前就被类型校验拒掉
  const advertised = sdkLenientShape('add_cell', schema);
  assert.ok(advertised.expand.safeParse('{"a":1}').success, 'SDK 层应接受 JSON 字符串（由处理器归一）');
});

// TMP 由 node --test 进程退出时清理（sandbox 下不依赖 after 钩子）
process.on('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ } });
