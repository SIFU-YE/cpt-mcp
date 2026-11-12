// test/fill-submit-params.test.js —— sandbox4/v1 会话暴露的 cpt-mcp 能力缺口回归
//
// 背景（2026-10-30 追溯 v1 会话前的缺口）：
//   · 自由 SQL 提交（FreeSQLSubmiter）无法声明 <Parameters>，SQL 里的 ${del_id} 原样进数据库，
//     运行时 MySQL 报 "Truncated incorrect INTEGER value: '${del_id}'"；
//   · get_fill_config 把自由 SQL 提交整条过滤掉（既无 table 也无 ColumnConfig）；
//   · update_report_node 重写节点时丢 class（提交 1→0）；attributes 未命中会静默新插重复节点；
//     parent 只用于插入、不参与查找（给唯一 SubmitVisitor 补 Parameters 被全文件 32 个候选误拦）；
//   · add_fill_binding 对自由 SQL 提交报 "SubmitVisitor 内无 DMLConfig"（误导成结构损坏）；
//   · run_fr_engine_check 批量模式仍强制 path + 单文件租约绑定（5 份模板只能逐份调）。
// 本文件按缺口逐条固化行为（lib 直调口径）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createCpt, addFillSubmit, addDataset } from '../lib/generate.js';
import { updateFillSubmit, updateReportNode, addFillBinding, updateFillBinding, addParameter } from '../lib/edits.js';
import { fillConfig } from '../lib/cpt.js';
import { validateCpt } from '../lib/validate.js';
import { runFrEngineCheck } from '../lib/fr-engine-run.js';
import { DeepToolManager } from '../lib/deep-tools.js';
import '../scripts/isolate-store.mjs';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-mcp-fill-params-'));
// 本机可能已设置 CPT_MCP_ALLOWED_ROOTS（MCP 全局配置）；run_fr_engine_check 会走 assertToolPath，
// 测试临时目录必须显式并入允许根，否则环境差异会让用例假失败。
process.env.CPT_MCP_ALLOWED_ROOTS = [process.env.CPT_MCP_ALLOWED_ROOTS, os.tmpdir()]
  .filter(Boolean).join(path.delimiter);
const file = (n) => path.join(TMP, n);
const read = (p) => fs.readFileSync(p, 'utf8');
const SQL = 'UPDATE t SET is_delete=1 WHERE id=${del_id}';

test('add_fill_submit 自由 SQL：按 SQL 里的 ${x} 自动声明提交参数（含 <Parameters> 结构）', () => {
  const p = file('auto-params.cpt');
  createCpt(p, {});
  const r = addFillSubmit(p, { dbName: '填报-读写', name: '删除-软删SQL', sql: SQL });
  assert.equal(r.mode, 'free-sql');
  assert.deepEqual(r.parameters, ['del_id'], '应自动声明 SQL 里出现的 ${del_id}');
  const raw = read(p);
  assert.ok(raw.includes('<Parameters>'), '必须写 <Parameters> 块');
  assert.ok(/<Parameter>\s*<Attributes name="del_id"\/>\s*<O>\s*<!\[CDATA\[=\$del_id\]\]><\/O>\s*<\/Parameter>/.test(raw),
    `提交参数节点结构应为 <Attributes name="del_id"/> + <O>= $del_id</O>，实际:\n${raw}`);
  // 值必须由报表参数取（=$del_id），而不是常量或空
  assert.ok(raw.includes('<![CDATA[=$del_id]]>'));
});

test('add_fill_submit 自由 SQL：parameters 可覆盖取值；非法参数名/列映射形态传 parameters 直接拒绝', () => {
  const p = file('explicit-params.cpt');
  createCpt(p, {});
  const r = addFillSubmit(p, {
    dbName: '填报-读写',
    sql: 'UPDATE t SET is_delete=1 WHERE id=${del_id}',
    parameters: [{ name: 'del_id', value: '=$fine_userid' }, { name: 'flag', value: '=1' }],
  });
  assert.deepEqual(r.parameters, ['del_id', 'flag']);
  const raw = read(p);
  assert.ok(raw.includes('<Attributes name="del_id"/>') && raw.includes('<![CDATA[=$fine_userid]]>'), '显式取值应覆盖默认 =$del_id');
  assert.ok(raw.includes('<Attributes name="flag"/>') && raw.includes('<![CDATA[=1]]>'));
  assert.throws(
    () => addFillSubmit(p, { dbName: 'x', sql: 'UPDATE t SET a=1', parameters: [{ name: 'bad-name' }] }),
    /非法提交参数名/,
  );
  assert.throws(
    () => addFillSubmit(p, { dsName: 'Doris', table: 't', parameters: [{ name: 'x' }] }),
    /只用于自由 SQL 提交/,
  );
});

test('get_fill_config 回读自由 SQL 提交：mode/sql/dbName/parameters 齐全（旧实现整条丢弃）', () => {
  const p = file('read-config.cpt');
  createCpt(p, {});
  addFillSubmit(p, { dbName: '填报-读写', sql: SQL, name: '删除-软删SQL' });
  const fc = fillConfig(p);
  assert.equal(fc.submits.length, 1, '自由 SQL 提交不能被过滤掉');
  const s = fc.submits[0];
  assert.equal(s.mode, 'free-sql');
  assert.equal(s.table, null);
  assert.equal(s.dbName, '填报-读写');
  assert.equal(s.sql, SQL);
  assert.deepEqual(s.parameters, [{ name: 'del_id', value: '=$del_id' }]);
  assert.deepEqual(s.columns, []);
});

test('validate_cpt：自由 SQL 参数声明缺失/报表参数未定义时给 warning（不再是校验盲区）', () => {
  const p = file('validate-free-sql.cpt');
  createCpt(p, {});
  addFillSubmit(p, { dbName: '填报-读写', sql: SQL });
  let issues = validateCpt(p);
  assert.equal(issues.filter((i) => i.severity === 'error').length, 0, issues.map((i) => i.message).join(';'));
  // 模板里没有 del_id 报表参数 → 取值来源缺失，应有 warning
  assert.ok(issues.some((i) => i.severity === 'warning' && /提交参数 del_id 取值 =\$del_id/.test(i.message)),
    `应提示参数取值来源缺失，实际: ${issues.map((i) => i.message).join(';')}`);
  // 人为抽掉 <Parameters> 块 → validate 必须提示 "${del_id} 未声明"
  fs.writeFileSync(p, read(p).replace(/<Parameters>[\s\S]*?<\/Parameters>/, '<Parameters/>'), 'utf8');
  issues = validateCpt(p);
  assert.ok(issues.some((i) => i.severity === 'warning' && /自由 SQL 引用参数 \$\{del_id\}.*没有声明/.test(i.message)),
    `应提示 SQL 引用参数未声明，实际: ${issues.map((i) => i.message).join(';')}`);
});

test('update_fill_submit：改 SQL 自动补齐缺失声明且保留既有自定义取值；显式 parameters 整块替换；清空=自闭合', () => {
  const p = file('update-params.cpt');
  createCpt(p, {});
  addFillSubmit(p, { dbName: '填报-读写', sql: 'UPDATE t SET a=${a}' });
  // 先自定义 a 的取值
  updateFillSubmit(p, { submitIndex: 0, parameters: [{ name: 'a', value: '=$fine_userid' }] });
  assert.ok(read(p).includes('<![CDATA[=$fine_userid]]>'));
  // 改 SQL 引入 ${b}：a 保留自定义取值、b 自动补默认声明
  const r = updateFillSubmit(p, { submitIndex: 0, sql: 'UPDATE t SET a=${a} WHERE b=${b}' });
  assert.ok(r.changed.includes('sql') && r.changed.includes('parameters'));
  assert.deepEqual(r.parameters, ['a', 'b']);
  const raw = read(p);
  assert.ok(raw.includes('<![CDATA[=$fine_userid]]>'), '已有声明的自定义取值不能被覆盖');
  assert.ok(raw.includes('<Attributes name="b"/>') && raw.includes('<![CDATA[=$b]]>'));
  // 显式 parameters = 以此为准（整块替换）
  updateFillSubmit(p, { submitIndex: 0, parameters: [{ name: 'c', value: '=9' }] });
  let fc = fillConfig(p);
  assert.deepEqual(fc.submits[0].parameters, [{ name: 'c', value: '=9' }]);
  // 空数组 = 清空声明
  updateFillSubmit(p, { submitIndex: 0, parameters: [] });
  fc = fillConfig(p);
  assert.deepEqual(fc.submits[0].parameters, []);
  assert.ok(/<Parameters\/>/.test(read(p)), '空声明应写成自闭合 <Parameters/>');
});

test('列映射提交不接受 parameters；自由 SQL 提交的字段绑定给出可执行报错（不再是"无 DMLConfig"）', () => {
  const p = file('binding-guard.cpt');
  createCpt(p, {});
  addFillSubmit(p, { dsName: 'Doris', table: 't1', bindings: [{ field: 'id', column: 0, row: 0, isKey: true }] });
  assert.throws(
    () => updateFillSubmit(p, { submitIndex: 0, parameters: [{ name: 'x' }] }),
    /只用于自由 SQL 提交/,
  );

  const q = file('binding-freesql.cpt');
  createCpt(q, {});
  addFillSubmit(q, { dbName: '填报-读写', sql: SQL });
  assert.throws(() => addFillBinding(q, 0, 'id', 0, 0), /自由 SQL 提交.*没有.*ColumnConfig.*parameters/s);
  assert.throws(() => updateFillBinding(q, 0, 'id', { column: 1 }), /自由 SQL 提交/);
});

test('update_report_node：替换默认保留开标签属性（不丢 FreeSQLSubmiter class，不产生重复提交）', () => {
  const p = file('preserve-attrs.cpt');
  createCpt(p, {});
  addFillSubmit(p, { dbName: '填报-读写', sql: SQL, name: '删除-软删SQL' });
  const body = '<Name>\n<![CDATA[改名]]></Name>\n<DBName>\n<![CDATA[填报-读写]]></DBName>\n<SQL>\n<![CDATA[UPDATE t SET is_delete=1 WHERE id=${del_id}]]></SQL>\n<Parameters/>\n';
  const r = updateReportNode(p, { nodeName: 'SubmitVisitor', xmlBody: body });
  assert.equal(r.mode, 'upsert');
  assert.equal(r.attributesPreserved, true);
  const raw = read(p);
  assert.ok(raw.includes('class="com.fr.report.write.FreeSQLSubmiter"'), '重写节点不能丢 class（旧实现会把提交废掉）');
  assert.equal((raw.match(/<SubmitVisitor\b/g) || []).length, 1, '不能静默插入第二个 SubmitVisitor');
});

test('update_report_node：attributes 未命中默认报错（防静默新建重复节点），createIfMissing=true 才新建', () => {
  const p = file('create-missing.cpt');
  createCpt(p, {});
  addFillSubmit(p, { dbName: '填报-读写', sql: SQL });
  assert.throws(
    () => updateReportNode(p, { nodeName: 'SubmitVisitor', attributes: { class: 'com.fr.report.write.BuiltInSQLSubmiter' }, xmlBody: '<X/>' }),
    /未找到匹配 attributes.*createIfMissing=true/s,
  );
  assert.equal((read(p).match(/<SubmitVisitor\b/g) || []).length, 1, '报错时不得写文件');
  const r = updateReportNode(p, {
    nodeName: 'SubmitVisitor',
    attributes: { class: 'com.fr.report.write.BuiltInSQLSubmiter' },
    xmlBody: '<X/>',
    createIfMissing: true,
  });
  assert.equal(r.mode, 'upsert');
  assert.equal((read(p).match(/<SubmitVisitor\b/g) || []).length, 2, '显式 createIfMissing 才允许新建');
  // replaceAttributes=true 是显式改属性（旧行为）：attributes={} 时清空开标签属性
  const r2 = updateReportNode(p, { nodeName: 'SubmitVisitor', attributes: {}, xmlBody: '<Name><![CDATA[x]]></Name>', replaceAttributes: true, index: 0 });
  assert.equal(r2.attributesPreserved, false);
});

test('update_report_node：parent 作为查找作用域——唯一 SubmitVisitor 内补 Parameters 不再被全文件候选误拦', () => {
  const p = file('parent-scope.cpt');
  createCpt(p, {});
  addDataset(p, { name: 'ds1', connection: 'Doris', sql: 'select 1' }); // 数据集块带 <Parameters> 容器
  addParameter(p, 'del_id', '1'); // 模板已有一个报表参数 <Parameter>，制造全文件多候选
  addFillSubmit(p, { dbName: '填报-读写', sql: 'UPDATE t SET is_delete=1' }); // 自由 SQL、无 <Parameters>
  const paramsXml = '<Parameter>\n<Attributes name="del_id"/>\n<O>\n<![CDATA[=$del_id]]></O>\n</Parameter>\n';
  const r = updateReportNode(p, { nodeName: 'Parameters', parent: 'SubmitVisitor', xmlBody: paramsXml });
  assert.equal(r.mode, 'upsert');
  assert.equal(r.parent, 'SubmitVisitor');
  const raw = read(p);
  const submitSeg = raw.slice(raw.indexOf('<SubmitVisitor'), raw.indexOf('</SubmitVisitor>') + '</SubmitVisitor>'.length);
  assert.ok(submitSeg.includes('<Parameters>'), '应把 <Parameters> 块插进 SubmitVisitor（全文件另有数据集 <Parameters> 也不受影响）');
  assert.ok(submitSeg.includes('<Attributes name="del_id"/>'), '<Parameter> 必须在 SubmitVisitor 的 <Parameters> 内');
  // 父容器不唯一时拒绝（不猜）
  addFillSubmit(p, { dbName: '填报-读写', sql: 'UPDATE t SET is_delete=1 WHERE id=1' });
  assert.throws(
    () => updateReportNode(p, { nodeName: 'Parameters', parent: 'SubmitVisitor', xmlBody: '<Parameters/>' }),
    /父容器 <SubmitVisitor> 有 2 个候选/,
  );
});

test('run_fr_engine_check：批量模式 path 可省略（不再因 path 缺失直接 bad-input / 逐份租约）', async () => {
  const r1 = await runFrEngineCheck(undefined, {});
  assert.equal(r1.status, 'bad-input');
  assert.match(r1.hint, /path.*batch|batch.*path/);
  // 传 batch 后 path 缺失不应再报 "path: expected string"；这里用不存在的文件在环境预检前拿到 bad-input
  const r2 = await runFrEngineCheck(undefined, { batch: [file('not-exist.cpt')] });
  assert.equal(r2.status, 'bad-input');
  assert.match(r2.hint, /不存在/, `批量模式应逐份校验路径，实际: ${JSON.stringify(r2)}`);
});

test('深层工具租约：run_fr_engine_check 批量模式不再被单文件 path 绑定（多文件一次校验）', () => {
  const m = new DeepToolManager();
  m.onDynamicRegister = () => {};
  m.onDynamicUnregister = () => {};
  const leasePath = 'C:/work/a.cpt';
  const g = m.grant({ group: 'adhoc', filePath: leasePath, tools: ['run_fr_engine_check'], reason: 'adhoc_write', maxCalls: 2, ttlSeconds: 3600 });
  assert.ok(g.leaseId);
  // 批量模式：租约绑 a.cpt，但 batch 可含 a/b/c —— 应放行（每份路径仍由 fr-engine-run assertToolPath 围栏）
  const a = m.beforeCall('run_fr_engine_check', { batch: [leasePath, 'C:/work/b.cpt', 'C:/work/c.cpt'] });
  assert.ok(a, '批量校验不应被单文件租约 path 绑定拒绝');
  m.afterCall(a);
  // 单文件模式仍然严格绑定（安全语义不放松）
  assert.throws(
    () => m.beforeCall('run_fr_engine_check', { path: 'C:/work/other.cpt' }),
    /租约绑定在|不匹配/,
  );
});

test('get_capabilities({tool})：深层工具不再被误标"未知工具"，而是引导解锁（v1 会话实测困惑点）', async () => {
  const { capabilityManifest } = await import('../lib/capabilities.js');
  const r = capabilityManifest({ tool: 'add_fill_submit' });
  assert.equal(r.tool.leaseGroup, 'fill_binding');
  assert.deepEqual(r.tool.sections, []);
  assert.ok(r.unknown.every((m) => !/未知工具/.test(m)), `不应误标未知：${JSON.stringify(r.unknown)}`);
  assert.match(r.unknown.join('\n'), /深层工具.*fill_binding.*request_deep_tool_access/);
  // 真正不存在的工具仍然报未知（防臆造）
  const bad = capabilityManifest({ tool: 'NoSuchToolXYZ' });
  assert.match(bad.unknown.join('\n'), /未知工具 NoSuchToolXYZ/);
});
