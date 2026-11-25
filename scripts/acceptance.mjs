// scripts/acceptance.mjs —— 验收测试：3 个画像场景走真实 MCP 协议 + 需求专属断言
// 用法：node scripts/acceptance.mjs
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w):/, '$1:')), '..');
const TMP = path.join(ROOT, 'tmp_test');
fs.mkdirSync(TMP, { recursive: true });
const P = (name) => path.join(TMP, name).replaceAll('\\', '/');

let passed = 0, failed = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { passed++; console.log(`  ✔ ${name}${detail ? ' — ' + detail : ''}`); }
  else { failed++; console.log(`  ✖ ${name}${detail ? ' — ' + detail : ''}`); }
};

/** 与指定 server 建立一条会话（行为验证：模型决策 → 协议执行） */
async function session(serverFile) {
  // t1 起 server.js 默认 focused；验收 A1–A3 覆盖全量工具，需显式 full（仅增量 env，不透传会话变量）。
  const transport = new StdioClientTransport({ command: 'node', args: [path.join(ROOT, serverFile)],
    env: serverFile === 'server.js' ? { CPT_MCP_TOOL_PROFILE: 'full' } : undefined });
  const client = new Client({ name: 'acceptance-test', version: '1.0.0' });
  await client.connect(transport);
  return {
    call: async (tool, args) => {
      const r = await client.callTool({ name: tool, arguments: args });
      if (r.isError) throw new Error(`${tool}: ${r.content?.[0]?.text?.slice(0, 300)}`);
      return JSON.parse(r.content?.[0]?.text ?? '{}');
    },
    tryCall: async (tool, args) => {
      const r = await client.callTool({ name: tool, arguments: args });
      return { isError: !!r.isError, text: r.content?.[0]?.text ?? '', data: (() => { try { return JSON.parse(r.content?.[0]?.text ?? 'null'); } catch { return null; } })() };
    },
    close: () => client.close(),
  };
}

// ============ A1 填报型（focused profile） ============
async function a1() {
  console.log('\n■ A1 填报型：员工信息填报（日期/数字/下拉控件 + 主键绑定）');
  const s = await session('server.js');
  const p = P('验收A1-员工填报.cpt');
  fs.rmSync(p, { force: true });

  await s.call('create_cpt', { path: p, title: '员工信息填报', rows: 4, columns: 5, webWrite: true });
  await s.call('add_style', { path: p, fontSizePt: 12, bold: true, backgroundColor: '#D9E1F2' }); // 1 表头
  await s.call('add_style', { path: p, fontSizePt: 12, backgroundColor: '#FFF9E4' });            // 2 输入区
  const headers = ['工号', '姓名', '部门', '入职日期', '薪资'];
  for (let i = 0; i < 5; i++) await s.call('add_cell', { path: p, column: i, row: 0, content: headers[i], styleIndex: 1 });
  await s.call('add_cell', { path: p, column: 0, row: 1, styleIndex: 2, widget: 'text' });
  await s.call('add_cell', { path: p, column: 1, row: 1, styleIndex: 2, widget: 'text' });
  await s.call('add_cell', { path: p, column: 2, row: 1, styleIndex: 2, widget: 'comboBox', widgetItems: [
    { key: '研发', value: '研发' }, { key: '市场', value: '市场' }, { key: '财务', value: '财务' }] });
  await s.call('add_cell', { path: p, column: 3, row: 1, styleIndex: 2, widget: 'date' });
  await s.call('add_cell', { path: p, column: 4, row: 1, styleIndex: 2, widget: 'number' });
  await s.call('add_fill_submit', { path: p, dsName: 'Doris', table: 'employee_info', bindings: [
    { field: 'emp_no', column: 0, row: 1, isKey: true },
    { field: 'emp_name', column: 1, row: 1 },
    { field: 'dept', column: 2, row: 1 },
    { field: 'hire_date', column: 3, row: 1 },
    { field: 'salary', column: 4, row: 1 },
  ] });
  await s.call('set_grid', { path: p, rowHeights: [900000, 720000, 720000, 720000] });
  await s.call('set_report_settings', { path: p, paper: 'A4' });

  const gate = await s.call('quality_gate_cpt', { path: p });
  ok('A1·质量门槛 pass', gate.pass === true, `blockers=${gate.summary.blockers}`);
  const fc = await s.call('get_fill_config', { path: p });
  const cols = fc.submits?.[0]?.columns ?? [];
  ok('A1·提交配置 5 字段', cols.length === 5, `实际 ${cols.length}`);
  ok('A1·工号为主键', cols.find((c) => c.field === 'emp_no')?.isKey === true);
  const cellsData = await s.call('get_cells', { path: p });
  const classes = cellsData.cells.filter((c) => c.widgetClass).map((c) => c.widgetClass);
  ok('A1·日期控件落位', classes.includes('com.fr.form.ui.DateEditor'));
  ok('A1·数字控件落位', classes.includes('com.fr.form.ui.NumberEditor'));
  ok('A1·下拉控件落位', classes.includes('com.fr.form.ui.ComboBox'));
  await s.close();
  return p;
}

// ============ A2 多 sheet 型（full profile / build_report 一次成型） ============
async function a2() {
  console.log('\n■ A2 多 sheet 型：季度月报（两个工作表，build_report 一次构建）');
  const s = await session('server.js');
  const p = P('验收A2-季度月报.cpt');
  fs.rmSync(p, { force: true });

  const monthCells = (sheet) => ([
    { column: 0, row: 0, content: `${sheet} 销售汇总`, styleIndex: 0, colspan: 2, sheet },
    { column: 0, row: 1, content: '地区', styleIndex: 1, sheet },
    { column: 1, row: 1, content: '销售额', styleIndex: 1, sheet },
    { column: 0, row: 2, contentType: 'dsColumn', dsName: 'ds_month', columnName: 'region', styleIndex: 2, sheet },
    { column: 1, row: 2, contentType: 'dsColumn', dsName: 'ds_month', columnName: 'amount', styleIndex: 3, sheet },
  ]);
  const r = await s.call('build_report', { path: p, spec: {
    title: '季度经营月报',
    sheets: [{ name: '1月' }, { name: '2月' }],
    datasets: [{ name: 'ds_month', connection: 'Doris', sql: 'SELECT region, amount, month FROM monthly_sales WHERE month in (${m1},${m2})',
      parameters: [{ name: 'm1', defaultValue: '1' }, { name: 'm2', defaultValue: '2' }] }],
    styles: [
      { fontName: '微软雅黑', fontSizePt: 16, bold: true },
      { fontName: '微软雅黑', fontSizePt: 12, bold: true, backgroundColor: '#3836B3', foregroundColor: '#FFFFFF' },
      { fontName: '微软雅黑', fontSizePt: 12 },
      { fontName: '微软雅黑', fontSizePt: 12, format: { class: 'com.fr.base.CoreDecimalFormat', pattern: '#,##0.00' } },
    ],
    cells: [...monthCells('1月'), ...monthCells('2月')],
    settings: { paper: 'A4' },
    check: true,
  } });
  ok('A2·build_report checkResult 无 error', r.checkResult?.hasError === false);

  const ov = await s.call('read_cpt', { path: p });
  ok('A2·两个工作表', JSON.stringify(ov.sheets) === JSON.stringify(['1月', '2月']), `实际 ${JSON.stringify(ov.sheets)}`);
  const gate = await s.call('quality_gate_cpt', { path: p });
  ok('A2·质量门槛 pass', gate.pass === true, `blockers=${gate.summary.blockers}`);
  const cellsAll = await s.call('get_cells', { path: p });
  const s1 = cellsAll.cells.filter((c) => c.sheet === '1月').length;
  const s2 = cellsAll.cells.filter((c) => c.sheet === '2月').length;
  ok('A2·两个 sheet 均有单元格', s1 >= 5 && s2 >= 5, `1月=${s1} 2月=${s2}`);
  await s.close();
  return p;
}

// ============ A3 大屏型（full profile / 原语 + 浮动元素 + 三图） ============
async function a3() {
  console.log('\n■ A3 大屏型：销售监控中心（浮动标语/KPI + 柱/折/饼三图）');
  const s = await session('server.js');
  const p = P('验收A3-销售大屏.cpt');
  fs.rmSync(p, { force: true });

  await s.call('create_cpt', { path: p, title: '2026 销售监控中心', rows: 30, columns: 12 });
  await s.call('add_dataset', { path: p, name: 'ds_region', connection: 'Doris', sql: 'SELECT region, amount FROM sales GROUP BY region' });
  await s.call('add_dataset', { path: p, name: 'ds_month', connection: 'Doris', sql: 'SELECT month, amount FROM sales_trend' });
  await s.call('add_dataset', { path: p, name: 'ds_cat', connection: 'Doris', sql: 'SELECT category, amount FROM sales_by_category' });
  await s.call('add_style', { path: p, fontName: '微软雅黑', fontSizePt: 28, bold: true, foregroundColor: '#00E4FF' }); // 1 大屏字
  await s.call('add_style', { path: p, fontName: '微软雅黑', fontSizePt: 12, foregroundColor: '#FFFFFF', backgroundColor: '#0B1D3A' }); // 2 底
  await s.call('add_float_element', { path: p, content: '2026 销售监控中心', styleIndex: 1, leftMm: 60, topMm: 4, widthMm: 120, heightMm: 16, name: 'Banner' });
  await s.call('add_float_element', { path: p, content: '▲ 年度目标完成率 87.6%', styleIndex: 1, leftMm: 60, topMm: 22, widthMm: 80, heightMm: 8, name: 'KPI' });
  await s.call('add_chart', { path: p, column: 0, row: 2, colspan: 6, rowspan: 14, type: 'column', dsName: 'ds_region', category: 'region', values: [{ name: 'amount', agg: 'sum' }], title: '各地区销售额' });
  await s.call('add_chart', { path: p, column: 6, row: 2, colspan: 6, rowspan: 14, type: 'line', dsName: 'ds_month', category: 'month', values: [{ name: 'amount', agg: 'sum' }], title: '月度趋势' });
  await s.call('add_chart', { path: p, column: 0, row: 16, colspan: 6, rowspan: 14, type: 'pie', dsName: 'ds_cat', category: 'category', values: [{ name: 'amount', agg: 'sum' }], title: '品类占比' });
  await s.call('add_cell', { path: p, column: 6, row: 16, content: 'TOP 品类明细', styleIndex: 2 });
  await s.call('set_report_settings', { path: p, paperWidthMm: 508, paperHeightMm: 286 }); // 16:9 大屏

  const gate = await s.call('quality_gate_cpt', { path: p });
  ok('A3·质量门槛 pass', gate.pass === true, `blockers=${gate.summary.blockers}`);
  const ov = await s.call('read_cpt', { path: p });
  ok('A3·两个浮动元素', ov.floatElements === 2, `实际 ${ov.floatElements}`);
  const cellsAll = await s.call('get_cells', { path: p });
  const charts = cellsAll.cells.filter((c) => c.contentObjectType === 'CC');
  ok('A3·三张图表落位', charts.length === 3, `实际 ${charts.length}`);
  const gateP = gate.checklist.find((x) => x.phase === '页面设置');
  ok('A3·自定义大屏纸张', gateP.done === true, gateP.detail);
  await s.close();
  return p;
}

const artifacts = [];
for (const fn of [a1, a2, a3]) {
  try { artifacts.push(await fn()); }
  catch (e) { failed++; console.log(`  ✖ 场景异常: ${e.message.slice(0, 200)}`); }
}
console.log(`\n验收结果: ${passed} 通过 / ${failed} 失败`);
console.log('产物:');
for (const a of artifacts) console.log('  ', a);
fs.writeFileSync(path.join(TMP, 'acceptance-artifacts.json'), JSON.stringify(artifacts, null, 2));
process.exit(failed === 0 ? 0 : 1);
