// cpt-mcp/test/smart.test.js —— 智能报表生成（generate_report）测试
// 覆盖：字段→布局/样式/格式/展开父格/汇总/填报 的自动下沉，以及参数校验的引导性报错。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateReport } from '../lib/engine/index.js';
import { overview, cells, styles, fillConfig } from '../lib/cpt.js';
import '../scripts/isolate-store.mjs'; // M123：JS 基线 store 隔离，直跑也不污染真实 store

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-smart-'));
const file = (n) => path.join(TMP, n);

const FIELDS = [
  { name: 'product_name', label: '产品名称', type: 'text' },
  { name: 'qty', label: '数量', type: 'number', summary: 'sum' },
  { name: 'amount', label: '销售金额', type: 'money', summary: 'sum' },
  { name: 'order_date', label: '下单日期', type: 'date' },
];

test('generateReport：字段+数据源 → 完整报表且自检无 error', () => {
  const p = file('智能报表.cpt');
  const r = generateReport({
    path: p, title: '产品销售明细表',
    source: { connection: 'Doris', table: 'sales' },
    fields: FIELDS,
  });
  assert.equal(r.checkResult.hasError, false, `不应有 error: ${JSON.stringify(r.checkResult.validate.summary)}`);
  assert.equal(r.checkResult.validate.summary.error, 0);

  const ov = overview(p);
  assert.equal(ov.datasets, 1, '应有 1 个数据集');
  // 1 标题 + 4 表头 + 4 数据 + 4 汇总 = 13
  assert.equal(ov.cellCount, 13, `单元格数应为 13，实际 ${ov.cellCount}`);
});

test('generateReport：自动生成 SQL（table + fields）', () => {
  const p = file('sql.cpt');
  const r = generateReport({
    path: p, source: { connection: 'Doris', table: 'sales' },
    fields: [{ name: 'a' }, { name: 'b' }],
  });
  assert.equal(r.summary.sql, 'select a, b from sales');
});

test('generateReport：显式 sql 优先于 table', () => {
  const p = file('sql2.cpt');
  const r = generateReport({
    path: p, source: { connection: 'Doris', table: 'sales', sql: 'select x from y where z=${p1}', parameters: [{ name: 'p1', defaultValue: '1' }] },
    fields: [{ name: 'x' }],
  });
  assert.equal(r.summary.sql, 'select x from y where z=${p1}');
});

test('generateReport：多列数据集自动推导展开父格（首列主扩展，其余 leftParent）', () => {
  const p = file('expand.cpt');
  generateReport({
    path: p, source: { connection: 'Doris', table: 'sales' },
    fields: [{ name: 'a' }, { name: 'b' }, { name: 'c' }],
  });
  const raw = fs.readFileSync(p, 'utf8');
  const dataRow = [...raw.matchAll(/<C c="(\d+)" r="2"[^>]*>([\s\S]*?)<\/C>/g)];
  assert.equal(dataRow.length, 3, '数据行应有 3 个单元格');

  const expandOf = (col) => {
    const m = dataRow.find((x) => x[1] === String(col));
    return /<Expand[^>]*\/>/.exec(m[2])?.[0] ?? '';
  };
  // 首列为主扩展格，无 leftParent
  assert.equal(expandOf(0), '<Expand dir="0"/>', '首列应为主扩展格');
  // 其余列必须声明 leftParent=A3（column=0,row=2 → "A3"），否则各列独立展开导致数据错乱
  assert.match(expandOf(1), /left="A3"/, '第 2 列应声明 leftParent=A3');
  assert.match(expandOf(2), /left="A3"/, '第 3 列应声明 leftParent=A3');
});

test('generateReport：字段类型 → 对齐与数字格式（一句话直出默认全部居中）', () => {
  const p = file('format.cpt');
  generateReport({
    path: p, source: { connection: 'Doris', table: 't' },
    fields: [
      { name: 'name', type: 'text' },
      { name: 'amt', type: 'money' },
      { name: 'dt', type: 'date' },
    ],
  });
  const st = styles(p);
  const byAlign = st.map((s) => s.horizontalAlignment);
  // 一句话直出默认全部居中（0）；如需文本左/数字右，显式传 fields[].align 覆盖
  assert.ok(!byAlign.includes(2), '默认不应再有左对齐(2)');
  assert.ok(!byAlign.includes(4), '默认不应再有右对齐(4)');
  assert.ok(byAlign.includes(0) || byAlign.includes(null), '默认应对齐居中(0/默认)');

  const raw = fs.readFileSync(p, 'utf8');
  // pattern 以 CDATA 子元素形式写入：<pattern><![CDATA[#,##0.00]]></pattern>
  assert.match(raw, /#,\s*##0\.00/, 'money 应为 #,##0.00');
  assert.match(raw, /yyyy-MM-dd/, 'date 应为 yyyy-MM-dd');
});

test('generateReport：summary 生成汇总行与公式', () => {
  const p = file('summary.cpt');
  generateReport({
    path: p, source: { connection: 'Doris', table: 't' },
    fields: [{ name: 'a' }, { name: 'b', summary: 'sum' }],
  });
  const list = cells(p);
  const sumCell = list.find((c) => Number(c.row) === 3 && Number(c.column) === 1);
  assert.ok(sumCell, '应存在汇总单元格(row=3,column=1)');
  // 数据行 row=2 → 设计器行号 3；B 列 → =sum(B3)
  assert.match(String(sumCell.contentText ?? ''), /sum\(B3\)/, `汇总公式应为 =sum(B3)，实际 ${sumCell.contentText}`);
});

test('generateReport：fill 生成填报提交与字段绑定', () => {
  const p = file('fill.cpt');
  generateReport({
    path: p, source: { connection: 'Doris', table: 'sales' },
    fields: [{ name: 'a' }, { name: 'b' }],
    fill: { table: 'sales', fields: [{ field: 'a', isKey: true }, { field: 'b' }] },
  });
  const raw = fs.readFileSync(p, 'utf8');
  assert.match(raw, /BuiltInSQLSubmiter/, '应生成提交器');
  const cfg = fillConfig(p);
  assert.ok(cfg.submits?.length >= 1, '应有 1 个提交');
  assert.equal(cfg.submits[0].columns.length, 2, '应有 2 个字段绑定');
  assert.equal(cfg.submits[0].columns[0].isKey, true, '第 1 个字段应为主键');
});

test('generateReport：一句话直出有 fill 时默认建四按钮工具栏', () => {
  const p = file('toolbar.cpt');
  generateReport({
    path: p, source: { connection: 'Doris', table: 'sales' },
    fields: [{ name: 'a' }, { name: 'b' }],
    fill: { table: 'sales' },
  });
  const raw = fs.readFileSync(p, 'utf8');
  assert.match(raw, /<ToolBar>/, '应生成工具栏');
  assert.match(raw, /com\.fr\.report\.web\.button\.write\.Submit/, '应含提交按钮');
  assert.match(raw, /com\.fr\.report\.web\.button\.write\.Verify/, '应含校验按钮');
  assert.match(raw, /AppendColumnRow/, '应含增行按钮');
  assert.match(raw, /DeleteColumnRow/, '应含删行按钮');
});

test('generateReport：fields[].align 可覆盖默认居中', () => {
  const p = file('align-override.cpt');
  generateReport({
    path: p, source: { connection: 'Doris', table: 't' },
    fields: [{ name: 'a', type: 'text', align: 2 }, { name: 'b', type: 'money', align: 4 }],
  });
  const st = styles(p);
  const byAlign = st.map((s) => s.horizontalAlignment);
  assert.ok(byAlign.includes(2), '显式 align=2 应保留左对齐');
  assert.ok(byAlign.includes(4), '显式 align=4 应保留右对齐');
});

test('generateReport：非法入参给出引导性报错（不是静默生成坏文件）', () => {
  const p = file('never.cpt');
  // 缺 fields
  assert.throws(() => generateReport({ path: p, source: { connection: 'D' }, fields: [] }), /fields 不能为空/);
  // 缺 connection
  assert.throws(() => generateReport({ path: p, source: { table: 't' }, fields: [{ name: 'a' }] }), /connection/);
  // 既无 table 也无 sql
  assert.throws(() => generateReport({ path: p, source: { connection: 'D' }, fields: [{ name: 'a' }] }), /table 或 sql/);
  // 未知 type
  assert.throws(
    () => generateReport({ path: p, source: { connection: 'D', table: 't' }, fields: [{ name: 'a', type: 'int128' }] }),
    /type="int128" 不支持/
  );
  // 未知 theme
  assert.throws(
    () => generateReport({ path: p, source: { connection: 'D', table: 't' }, theme: 'rainbow', fields: [{ name: 'a' }] }),
    /theme="rainbow" 不存在/
  );
  assert.equal(fs.existsSync(p), false, '校验失败时不应生成文件');
});

test('generateReport：默认拒绝覆盖已存在目标（2026-11-06 P0），noOverwrite:false 才覆盖', () => {
  const p = file('overwrite-guard.cpt');
  generateReport({ path: p, source: { connection: 'Doris', table: 'sales' }, fields: [{ name: 'a' }] });
  const before = fs.readFileSync(p, 'utf8');
  assert.throws(
    () => generateReport({ path: p, source: { connection: 'Doris', table: 'sales' }, fields: [{ name: 'b' }] }),
    /noOverwrite=true.*拒绝覆盖/,
    '默认（不传 noOverwrite）应拒绝覆盖已存在模板'
  );
  assert.equal(fs.readFileSync(p, 'utf8'), before, '拒绝覆盖时目标文件不得被改动');
  assert.doesNotThrow(() => {
    generateReport({ path: p, source: { connection: 'Doris', table: 'sales' }, fields: [{ name: 'b' }], noOverwrite: false });
  }, '显式 noOverwrite:false 才允许覆盖');
});

test('generateReport：产出为合法 XML 纯文本（非 ZIP/二进制）', () => {
  const p = file('xml.cpt');
  generateReport({ path: p, source: { connection: 'D', table: 't' }, fields: [{ name: 'a' }] });
  const head = fs.readFileSync(p).subarray(0, 4).toString('latin1');
  assert.equal(head, '<?xm', '前 4 字节应为 <?xm');
});
