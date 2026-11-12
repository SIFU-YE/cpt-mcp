// scripts/e2e-crud.mjs —— M51 删改查补齐 e2e: delete_dataset / delete_chart / get_cell_hyperlink / delete_float_element
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const { createCpt, addDataset, addStyle, addFloatElement, addCell } = await import(pathToFileURL(path.join(here, '../lib/generate.js')).href);
const {
  deleteDataset, deleteChart, getCellHyperlink, deleteFloatElement, addCellHyperlink,
} = await import(pathToFileURL(path.join(here, '../lib/edits.js')).href);
const { addChart } = await import(pathToFileURL(path.join(here, '../lib/engine/chart.js')).href);
const { validateCpt } = await import(pathToFileURL(path.join(here, '../lib/validate.js')).href);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-crud-'));
const p = path.join(dir, 'crud.cpt');
let pass = 0, fail = 0;
const check = (name, ok, extra = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${name}${extra ? ' — ' + extra : ''}`);
  if (ok) pass++; else fail++;
};

createCpt(p, { rows: 4, columns: 4 });
addDataset(p, { name: 'ds1', connection: 'Doris', sql: 'SELECT * FROM t1' });
addDataset(p, { name: 'ds2', connection: 'Doris', sql: 'SELECT * FROM t2' });
addCell(p, { column: 0, row: 0, content: '测试' });

// ① delete_dataset
{
  let xml = fs.readFileSync(p, 'utf8');
  check('add 后 2 数据集', (xml.match(/<TableData /g) || []).length === 2, (xml.match(/<TableData /g) || []).length);
  const r = deleteDataset(p, 'ds1');
  xml = fs.readFileSync(p, 'utf8');
  check('delete_dataset 返回 action', r.action === 'delete_dataset' && r.name === 'ds1');
  check('ds1 已删', !xml.includes('name="ds1"'), '');
  check('ds2 仍在', xml.includes('name="ds2"'), '');
  // 删不存在的应抛错
  let threw = false;
  try { deleteDataset(p, 'nope'); } catch { threw = true; }
  check('删不存在数据集抛错', threw);
  const err = validateCpt(p).filter((i) => i.severity === 'error').length;
  check('validate error=0', err === 0, `errors=${err}`);
}

// ② delete_chart
{
  addDataset(p, { name: 'ds3', connection: 'Doris', sql: 'SELECT 地区,销售额 FROM t3' });
  addChart(p, { column: 2, row: 1, type: 'column', dsName: 'ds3', category: '地区', values: [{ name: '销售额', agg: 'sum' }] });
  let xml = fs.readFileSync(p, 'utf8');
  check('addChart 后含图表', xml.includes('<O t="CC">'), '');
  const r = deleteChart(p, 2, 1);
  xml = fs.readFileSync(p, 'utf8');
  check('delete_chart 返回', r.action === 'delete_chart');
  check('图表已删', !xml.includes('<O t="CC">'), '');
  // 非图表坐标应抛错
  let threw = false;
  try { deleteChart(p, 0, 0); } catch (e) { threw = /不是图表|已存在/.test(e.message); }
  check('非图表坐标抛错', threw);
  const err = validateCpt(p).filter((i) => i.severity === 'error').length;
  check('validate error=0', err === 0, `errors=${err}`);
}

// ③ get_cell_hyperlink
{
  // 先删掉 (0,0) 再重新加一个带超链接的单元格
  addCell(p, { column: 1, row: 2, content: '链接单元格' });
  addCellHyperlink(p, { column: 1, row: 2, type: 'url', url: 'https://example.com', name: '外部链接' });
  let r = getCellHyperlink(p, 1, 2);
  check('get_cell_hyperlink 有链接', r.hasHyperlink === true && r.hyperlinks.length === 1, JSON.stringify(r.hyperlinks));
  check('type=url 且 url 正确', r.hyperlinks[0]?.type === 'url' && String(r.hyperlinks[0]?.url).replace(/\/$/, '') === 'https://example.com', r.hyperlinks[0]?.url);
  check('name 正确', r.hyperlinks[0]?.name === '外部链接', r.hyperlinks[0]?.name);
  // 无链接的单元格返回空
  r = getCellHyperlink(p, 0, 0);
  check('无链接单元格 hasHyperlink=false', r.hasHyperlink === false && r.hyperlinks.length === 0, '');
}

// ④ delete_float_element
{
  addFloatElement(p, { content: '浮动内容', name: 'FloatTest', leftMm: 5, topMm: 5, widthMm: 30, heightMm: 10 });
  let xml = fs.readFileSync(p, 'utf8');
  check('addFloatElement 后存在', xml.includes('name="FloatTest"'), '');
  const r = deleteFloatElement(p, 'FloatTest');
  xml = fs.readFileSync(p, 'utf8');
  check('delete_float_element 返回', r.action === 'delete_float_element' && r.name === 'FloatTest');
  check('FloatTest 已删', !xml.includes('name="FloatTest"'), '');
  let threw = false;
  try { deleteFloatElement(p, 'Ghost'); } catch { threw = true; }
  check('删不存在浮动元素抛错', threw);
  const err = validateCpt(p).filter((i) => i.severity === 'error').length;
  check('validate error=0', err === 0, `errors=${err}`);
}

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\nM51 删改查补齐 e2e: ${pass} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);