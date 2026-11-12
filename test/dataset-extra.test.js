// test/dataset-extra.test.js —— Excel 文件数据集 + 树数据集
//
// 逆向依据（官方 1559 样本实证）：
//   ExcelTableData：全库只有 3 例，形态完全一致 ——
//     <TableData name="File1" class="com.fr.data.impl.ExcelTableData">
//     <ExcelTableDataAttr needColumnName="true" isFromEnv="true" filePath="reportlets/jsc/铜山/2.xls"/>
//     <Parameters/>
//     </TableData>
//   RecursionTableData：19 例。markFields / originalTableDataName 19/19 必填，
//     parentmarkFields 14/19，markFieldsName / parentmarkFieldsName 各 7/19（与列序号成对出现）。
//     元素顺序固定：markFields → parentmarkFields → markFieldsName → parentmarkFieldsName → originalTableDataName
//
// 【为什么只测这两类】CSV/文本（TextTableData）与 XML（XMLTableData）在官方样本里零实例，
//   元素名只能靠猜，所以工具层直接拒绝 —— 这里同步断言「拒绝是明确报错而不是静默放行」。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCpt, addFileDataset, addTreeDataset, addDataset } from '../lib/generate.js';
import { validateCpt } from '../lib/validate.js';
import '../scripts/isolate-store.mjs'; // M123：JS 基线 store 隔离，直跑也不污染真实 store

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-ds-'));
const read = (p) => fs.readFileSync(p, 'utf8');

/** validateCpt 在部分版本返回 {issues}，在部分版本直接返回数组 —— 统一取 error 条数 */
const errCount = (p) => {
  const r = validateCpt(p);
  return (r.issues ?? r).filter((i) => i.severity === 'error').length;
};

/** assert.throws 在 strict 模式下不返回错误对象，自己包一层以便断言报错文案 */
function throwsWith(fn, re, msg) {
  let caught;
  try { fn(); } catch (e) { caught = e; }
  assert.ok(caught, msg ?? `应抛错：${re}`);
  assert.match(caught.message, re, msg);
}

/** 建骨架 + 一个普通 SQL 数据集（树数据集依赖它） */
function scaffold(name = 'a.cpt') {
  if (path.basename(name) !== name || name.includes('..')) throw new Error(`scaffold 非法文件名: ${name}`);
  const d = tmp();
  const p = path.join(d, name);
  createCpt(p, { title: 'T', rows: 3, columns: 3 });
  return { d, p };
}

test('add_file_dataset：Excel 数据集结构与官方样本一致', () => {
  const { d, p } = scaffold();
  const r = addFileDataset(p, { name: 'File1', dataFile: 'reportlets/jsc/铜山/2.xls' });
  assert.equal(r.action, 'add_file_dataset');
  assert.equal(r.fromEnv, true);
  assert.equal(r.needColumnName, true);

  const xml = read(p);
  assert.match(xml, /<TableData name="File1" class="com\.fr\.data\.impl\.ExcelTableData">/);
  assert.match(xml, /<ExcelTableDataAttr needColumnName="true" isFromEnv="true" filePath="reportlets\/jsc\/铜山\/2\.xls"\/>/);
  assert.match(xml, /<Parameters\/>/, '官方样本里 Excel 数据集也带空 Parameters');
  assert.equal(errCount(p), 0, '产出仍是可解析的合法模板');
  fs.rmSync(d, { recursive: true, force: true });
});

test('add_file_dataset：fromEnv=false 收绝对路径，needColumnName 可关', () => {
  const { d, p } = scaffold('b.cpt');
  addFileDataset(p, { name: 'f2', dataFile: 'D:/data/销售.xlsx', needColumnName: false, fromEnv: false });
  const xml = read(p);
  assert.match(xml, /isFromEnv="false"/);
  assert.match(xml, /needColumnName="false"/);
  assert.match(xml, /filePath="D:\/data\/销售\.xlsx"/);
  fs.rmSync(d, { recursive: true, force: true });
});

test('安全围栏：非 Excel 扩展名被明确拒绝并给出替代方案', () => {
  const { d, p } = scaffold('c.cpt');
  throwsWith(() => addFileDataset(p, { name: 'f3', dataFile: 'reportlets/a.csv' }), /只支持 Excel/);
  throwsWith(() => addFileDataset(p, { name: 'f3', dataFile: 'reportlets/a.csv' }), /add_dataset/,
    '拒绝信息应引导到 SQL 数据集，而不是把模型晾在半路');
  assert.doesNotMatch(read(p), /f3/, '拒绝时不应写坏模板');
  fs.rmSync(d, { recursive: true, force: true });
});

test('安全围栏：dataFile 路径穿越 / 口径不匹配被拒', () => {
  const a = scaffold('d1.cpt');
  assert.throws(() => addFileDataset(a.p, { name: 'x', dataFile: 'reportlets/../../etc/passwd.xls' }), /\.\./);
  assert.throws(() => addFileDataset(a.p, { name: 'x', dataFile: 'D:/a.xlsx', fromEnv: true }), /fromEnv=false/);
  assert.throws(() => addFileDataset(a.p, { name: 'x', dataFile: 'reportlets/a.xlsx', fromEnv: false }), /fromEnv=true/);
  fs.rmSync(a.d, { recursive: true, force: true });
});

test('add_tree_dataset：元素顺序与 CDATA 写法取自官方样本', () => {
  const { d, p } = scaffold('e.cpt');
  addDataset(p, { name: 'ds4', connection: 'Doris', sql: 'SELECT 2' });
  const r = addTreeDataset(p, {
    name: 'Tree1', source: 'ds4', childField: 0, parentField: 1,
    childFieldName: '地区', parentFieldName: '父地区',
  });
  assert.equal(r.action, 'add_tree_dataset');
  assert.equal(r.childField, 0);
  assert.equal(r.parentField, 1);

  const xml = read(p);
  const i = xml.indexOf('<TableData name="Tree1"');
  assert.notEqual(i, -1);
  const blk = xml.slice(i, xml.indexOf('</TableData>', i));
  assert.match(blk, /class="com\.fr\.data\.impl\.RecursionTableData"/);
  // 顺序：markFields → parentmarkFields → markFieldsName → parentmarkFieldsName → originalTableDataName
  const order = ['markFields', 'parentmarkFields', 'markFieldsName', 'parentmarkFieldsName', 'originalTableDataName'];
  let cursor = -1;
  for (const tag of order) {
    const at = blk.indexOf(`<${tag}>`);
    assert.notEqual(at, -1, `应有 <${tag}>`);
    assert.ok(at > cursor, `<${tag}> 的元素顺序与官方样本一致`);
    cursor = at;
  }
  assert.match(blk, /<markFields>\s*<!\[CDATA\[0\]\]><\/markFields>/);
  assert.match(blk, /<originalTableDataName>\s*<!\[CDATA\[ds4\]\]><\/originalTableDataName>/);
  assert.equal(errCount(p), 0);
  fs.rmSync(d, { recursive: true, force: true });
});

test('add_tree_dataset：只给父字段名不给父列序号被拒（避免产出未验证形态）', () => {
  const { d, p } = scaffold('f.cpt');
  addDataset(p, { name: 'ds1', connection: 'Doris', sql: 'SELECT 1' });
  assert.throws(
    () => addTreeDataset(p, { name: 't', source: 'ds1', childField: 0, parentFieldName: '父' }),
    /parentField/,
    '官方 19 例里字段名总和列序号成对出现，只给字段名会产出没验证过的形态',
  );
  assert.throws(
    () => addTreeDataset(p, { name: 't', source: 'ds1', childField: 1, parentField: 1 }),
    /不能是同一列/,
  );
  assert.throws(
    () => addTreeDataset(p, { name: 't', source: '', childField: 0, parentField: 1 }),
    /source/,
  );
  fs.rmSync(d, { recursive: true, force: true });
});

test('两个数据集工具共用数据集名校验与重名防御', () => {
  const { d, p } = scaffold('g.cpt');
  addFileDataset(p, { name: 'ds1', dataFile: 'reportlets/a.xlsx' });
  assert.throws(() => addFileDataset(p, { name: 'ds1', dataFile: 'reportlets/b.xlsx' }), /已存在/);
  assert.throws(() => addTreeDataset(p, { name: '2bad', source: 'ds1', childField: 0, parentField: 1 }), /非法/);
  assert.throws(() => addTreeDataset(p, { name: 'ds1', source: 'ds1', childField: 0, parentField: 1 }), /已存在/);
  fs.rmSync(d, { recursive: true, force: true });
});
