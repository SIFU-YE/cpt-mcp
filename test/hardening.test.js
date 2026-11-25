// cpt-mcp/test/hardening.test.js —— 代码审查加固项的回归测试
// 对应审查发现：A1 反编译输出围栏 / A2 乐观并发锁 / A4 ADS与尾部字符 / A5 段级 '..'
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createCpt, addCell, addStyle } from '../lib/generate.js';
import { updateReportNode } from '../lib/edits.js';
import { load, save, markFresh, findAll } from '../lib/xml.js';
import { assertToolPath, assertDecompileOutput, assertDataFilePath } from '../lib/security.js';
import { validateCpt } from '../lib/validate.js';
// 回归 hermetic 前置：外部 CPT_MCP_ALLOWED_ROOTS（如 DSH 会话级目录限制）会改变默认允许根，
// 以下断言测的是默认行为（项目目录+系统临时目录），先恢复默认再跑。各测试文件独立进程，互不影响。
delete process.env.CPT_MCP_ALLOWED_ROOTS;

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-hardening-'));
const file = (name) => path.join(TMP, name);
const FR_HOME = process.env.FR_HOME;

test('A2 回归：load 后文件被外部修改，save 必须报并发冲突而不是静默覆盖', () => {
  const p = file('conflict.cpt');
  createCpt(p, { rows: 2, columns: 2 });
  const { raw } = load(p);
  // 模拟另一进程/外部编辑器修改（改内容 + 刷新 mtime）
  fs.writeFileSync(p, raw.replace('<CellElementList>', '<CellElementList>\n<!-- external edit -->'), 'utf8');
  const future = new Date(Date.now() + 50);
  fs.utimesSync(p, future, future);
  assert.throws(() => save(p, raw), /并发冲突/);
  // 重新 load 后再 save 正常
  const fresh = load(p);
  save(p, fresh.raw.replace('<!-- external edit -->', '<!-- merged -->'));
  assert.ok(fs.readFileSync(p, 'utf8').includes('<!-- merged -->'));
});

test('A2 回归：markFresh 允许刻意覆盖（回滚场景）', () => {
  const p = file('rollback.cpt');
  createCpt(p, { rows: 2, columns: 2 });
  const { raw } = load(p);
  fs.writeFileSync(p, raw + '<!-- changed externally -->', 'utf8');
  const future = new Date(Date.now() + 60);
  fs.utimesSync(p, future, future);
  markFresh(p); // 回滚语义：我就是要覆盖当前内容
  assert.doesNotThrow(() => save(p, raw));
});

test('A1 回归：fr_decompile 输入 FR_HOME 样本且不传 outDir 时，默认输出目录被拒（曾可写进安装目录）', (t) => {
  if (!FR_HOME) return t.skip('未设置 FR_HOME，跳过本机 FR 安装相关断言');
  const sample = path.join(FR_HOME, 'webapps', 'webroot', 'WEB-INF', 'reportlets', 'demo', 'basic', '产品明细.cpt');
  if (!fs.existsSync(sample)) return t.skip('官方样本不存在');
  assert.throws(() => assertDecompileOutput(sample, undefined), /FineReport 安装目录|只读/);
  // 允许目录内的显式 outDir 放行
  assert.doesNotThrow(() => assertDecompileOutput(sample, path.join(TMP, 'decompiled-ok')));
});

test('A4 回归：NTFS 备用数据流与结尾点/空格被拒（win32）', (t) => {
  if (process.platform !== 'win32') return t.skip('仅 Windows');
  assert.throws(() => assertToolPath('add_cell', file('x.cpt:hidden')), /备用数据流|非法盘符/);
  assert.throws(() => assertToolPath('add_cell', file('x.cpt.')), /结尾不允许/);
  assert.throws(() => assertToolPath('add_cell', file('x.cpt ')), /结尾不允许/);
});

test('A6 回归：updateReportNode 非法 nodeName 被拒（正则/XML 双注入面）', () => {
  const p = file('node-inject.cpt');
  createCpt(p, { rows: 2, columns: 2 });
  assert.throws(() => updateReportNode(p, { nodeName: '.*', xmlBody: '<X/>' }), /非法 nodeName/);
  assert.throws(() => updateReportNode(p, { nodeName: 'Foo><Listener', xmlBody: '<X/>' }), /非法 nodeName/);
  assert.throws(() => updateReportNode(p, { nodeName: 'Report|Listener', xmlBody: '<X/>' }), /非法 nodeName/);
  // 合法标签仍可用：纯结构节点 upsert + 属性精确匹配（含正则字符的属性值按字面匹配）
  const r = updateReportNode(p, { nodeName: 'ReportPageAttr', xmlBody: '<X/>' });
  assert.equal(r.mode, 'upsert');
});

test('A5 回归：「报表..cpt」是合法文件名；「..」整段仍拒绝', () => {
  assert.doesNotThrow(() => assertDataFilePath('报表..cpt', { fromEnv: true }));
  assert.throws(() => assertDataFilePath('../etc/x.xls', { fromEnv: true }), /非法或受保护/);
  assert.throws(() => assertDataFilePath('a/../../x.xls', { fromEnv: true }), /非法或受保护/);
});

test('C4 回归：findAll 跳过注释/CDATA，且注释内 CDATA 字样的重叠区间被正确合并', () => {
  const raw = '<A><![CDATA[<C />]]><B/></A><!-- <C /> --><C c="0"/><C c="1"/>';
  assert.deepEqual(findAll(raw, '<C ').length, 2);
  const tricky = '<!-- <![CDATA[ -->\n<C c="0"/><C c="1"/>';
  assert.deepEqual(findAll(tricky, '<C ').length, 2);
});

test('C3 回归：addCell 防重复坐标仍生效（单次 load 重构后）', () => {
  const p = file('dup.cpt');
  createCpt(p, { rows: 3, columns: 3 });
  addStyle(p, {});
  addCell(p, { column: 0, row: 0, content: 'x', styleIndex: 0 });
  assert.throws(() => addCell(p, { column: 0, row: 0, content: 'y', styleIndex: 0 }), /已存在/);
});

// ---- 第二轮审查（S 系列） ----

import { addChart } from '../lib/engine/chart.js';
import { addDataset, addFillSubmit } from '../lib/generate.js';
import { addFillBinding, updateDatasetSql, setCellContentType, updateCellContent } from '../lib/edits.js';

test('S2 回归：dsColumn/add_chart/setCellContentType 引用未声明数据集被拒，且报错列出已声明数据集', () => {
  const p = file('dsref.cpt');
  createCpt(p, { rows: 4, columns: 4 });
  addDataset(p, { name: 'ds1', connection: 'Doris', sql: 'SELECT 1' });
  assert.throws(() => addCell(p, { column: 0, row: 0, contentType: 'dsColumn', dsName: '拼写错误', columnName: 'a' }), /已声明：ds1/);
  assert.throws(() => addChart(p, { column: 0, row: 2, dsName: 'ds2', category: 'a', values: ['x'] }), /图表数据集 "ds2" 不存在/);
  addCell(p, { column: 1, row: 0, content: '文本占位' });
  assert.throws(() => setCellContentType(p, { column: 1, row: 0, contentType: 'dsColumn', dsName: 'ds2', columnName: 'a' }), /ds2.*不存在/);
  // 引用已声明数据集正常
  assert.doesNotThrow(() => addCell(p, { column: 0, row: 0, contentType: 'dsColumn', dsName: 'ds1', columnName: 'a' }));
});

test('S2 回归：validate_cpt 捕捉手工写坏的悬空数据集引用（单元格 + 图表；外部引入形态为 warning）', () => {
  const p = file('dangling.cpt');
  createCpt(p, { rows: 6, columns: 4 });
  addDataset(p, { name: 'ds1', connection: 'Doris', sql: 'SELECT 1' });
  addCell(p, { column: 0, row: 0, contentType: 'dsColumn', dsName: 'ds1', columnName: 'a' });
  addChart(p, { column: 0, row: 2, dsName: 'ds1', category: 'c', values: [{ name: 'v' }] });
  // 模拟外部改动：数据集改名，引用悬空
  let raw = fs.readFileSync(p, 'utf8');
  raw = raw.replace('<TableData name="ds1"', '<TableData name="ds_renamed"');
  fs.writeFileSync(p, raw);
  // 官方实证（订单套打.cpt 等）：悬空引用的模板真实引擎仍可加载（渲染期才报错），
  // 因此校验层为 warning（写入围栏已在生成侧拦截），不作为 gate blocker
  const issues = validateCpt(p);
  assert.ok(issues.some((i) => i.severity === 'warning' && /数据集 "ds1" 不存在/.test(i.message)), '应报 DSColumn 悬空引用');
  assert.ok(issues.some((i) => i.severity === 'warning' && /图表引用的数据集 "ds1" 不存在/.test(i.message)), '应报图表悬空引用');
  assert.equal(issues.filter((i) => i.severity === 'error').length, 0, '悬空引用不应再算 error');
});

test('S3 回归：addFillBinding 拒绝非整数坐标与重复字段', () => {
  const p = file('binding.cpt');
  createCpt(p, { rows: 3, columns: 3 });
  addFillSubmit(p, { dsName: 'Doris', table: 't1', bindings: [{ field: 'a', column: 0, row: 1 }] });
  assert.throws(() => addFillBinding(p, 0, 'b', 'x', 1), /非负整数/);
  assert.throws(() => addFillBinding(p, 0, 'a', 0, 1), /已存在/);
  assert.doesNotThrow(() => addFillBinding(p, 0, 'b', 1, 1));
});

test('S4 回归：updateDatasetSql 拒绝空 SQL', () => {
  const p = file('emptysql.cpt');
  createCpt(p, { rows: 2, columns: 2 });
  addDataset(p, { name: 'ds1', connection: 'Doris', sql: 'SELECT 1' });
  assert.throws(() => updateDatasetSql(p, 'ds1', '   '), /不能为空/);
  assert.doesNotThrow(() => updateDatasetSql(p, 'ds1', 'SELECT 2'));
});

test('S6 回归：属性较多的单元格（长开标签）仍可定位并改写', () => {
  const p = file('longhead.cpt');
  createCpt(p, { rows: 3, columns: 3 });
  addStyle(p, {});
  addCell(p, { column: 0, row: 0, content: 't', styleIndex: 0, colspan: 1, rowspan: 1 });
  assert.doesNotThrow(() => updateCellContent(p, 0, 0, '新内容'));
});

// ---- 第三轮审查（T 系列） ----

import { buildReport } from '../lib/engine/builder.js';
import { highlightSchema, buildReportSpecSchema, sheetParamSchema } from '../lib/engine/spec.js';

test('T1 回归：highlightSchema.bold 的 "false" 不再翻转（S1 在共享 schema 的残留）', () => {
  assert.equal(highlightSchema.parse({ formula: '$$$ < 0', bold: 'false' }).bold, false);
  assert.equal(highlightSchema.parse({ formula: '$$$ < 0', bold: 'true' }).bold, true);
  assert.throws(() => highlightSchema.parse({ formula: '$$$ < 0', bold: 'weird' }));
});

test('T4 回归：spec 层 sheet 空串被拒；纯数字字符串转索引', () => {
  assert.throws(() => sheetParamSchema.parse(''), /不能为空/);
  assert.equal(sheetParamSchema.parse(' 2 '), 2);
  assert.equal(sheetParamSchema.parse('sheet2'), 'sheet2');
  const bad = buildReportSpecSchema.safeParse({ cells: [{ column: 0, row: 0, sheet: '' }] });
  assert.equal(bad.success, false);
});

test('T2 回归：build_report 反复覆盖发布后 .bak-build-* 不超过 5 份', () => {
  const p = file('bak-prune.cpt');
  for (let i = 0; i < 7; i++) {
    // 覆盖语义 2026-11-06：默认拒绝覆盖，反复发布须显式 noOverwrite:false
    buildReport({ path: p, title: `v${i}`, rows: 2, columns: 2, check: false, noOverwrite: false });
  }
  const backups = fs.readdirSync(path.dirname(p)).filter((f) => f.startsWith('bak-prune.cpt.bak-build-'));
  assert.ok(backups.length <= 5, `备份应 ≤5 份，实际 ${backups.length}`);
  // 目标文件仍是最新内容
  assert.ok(fs.readFileSync(p, 'utf8').includes('v6'), '发布后目标应为最后一次构建产物');
});

// ---- 第四轮审查（U 系列） ----

import { cells } from '../lib/cpt.js';
import { addSheet } from '../lib/generate.js';
import '../scripts/isolate-store.mjs'; // M123：JS 基线 store 隔离，直跑也不污染真实 store

// ---- 审查批次：动态列 ci 形态 ----

test('动态列：addCell 支持 dsName+ci（官方动态列形态），validate 不误报', () => {
  const p = file('dyn-col.cpt');
  createCpt(p, { rows: 4, columns: 4 });
  addDataset(p, { name: 'ds1', connection: 'Doris', sql: 'SELECT region, qty FROM t' });
  addStyle(p, {});
  assert.doesNotThrow(() => addCell(p, { column: 0, row: 1, contentType: 'dsColumn', dsName: 'ds1', ci: 1, styleIndex: 1 }));
  const xml = fs.readFileSync(p, 'utf8');
  assert.match(xml, /<Attributes dsName="ds1" ci="1"\/>/, '应写出 ci 属性且无 columnName');
  assert.ok(!xml.includes('columnName='), '不应写出 columnName');
  assert.equal(validateCpt(p).filter((i) => i.severity === 'error').length, 0);
  // 负例：ci 非法
  assert.throws(() => addCell(p, { column: 1, row: 1, contentType: 'dsColumn', dsName: 'ds1', ci: -1 }), /ci（动态列列序号）非法/);
  assert.throws(() => addCell(p, { column: 1, row: 1, contentType: 'dsColumn', dsName: 'ds1' }), /columnName/);
});

test('U1 回归：cells 按 sheet 过滤时，名称拼错/索引越界必须报错而不是静默返回全部', () => {  const p = file('sheetfilter.cpt');
  createCpt(p, { rows: 2, columns: 2 });
  addSheet(p, { sheetName: '明细' });
  addCell(p, { column: 0, row: 0, content: 'x' });
  assert.throws(() => cells(p, { sheet: '拼写错误' }), /未找到工作表/);
  assert.throws(() => cells(p, { sheet: 99 }), /未找到工作表/);
  // 正常过滤不受影响
  assert.equal(cells(p, { sheet: '明细' }).length, 0);
  assert.equal(cells(p, { sheet: 'sheet1' }).length, 1);
  assert.equal(cells(p).length, 1, '不带过滤仍返回全部');
});
