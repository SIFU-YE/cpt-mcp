// scripts/behavior-regression.mjs —— 完整行为回归（真实 MCP 协议，8 场景：S0–S5/S7/S8，S6 为预留编号）
// 覆盖：profile 可见性 / 填报 / 多sheet / 大屏 / 树形 / Excel 数据源 /
//       定时任务 / 围栏负例组。全部断言走协议层，不直接 import lib。
// 用法：node scripts/behavior-regression.mjs
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w):/, '$1:')), '..');
const TMP = path.join(ROOT, 'tmp_test');
fs.mkdirSync(TMP, { recursive: true });
const P = (name) => path.join(TMP, name).replaceAll('\\', '/');

let passed = 0, failed = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { passed++; console.log(`  ✔ ${name}${detail ? ' — ' + detail : ''}`); }
  else { failed++; console.log(`  ✖ ${name}${detail ? ' — ' + detail : ''}`); }
};

async function session(serverFile, env) {
  const transport = new StdioClientTransport({ command: 'node', args: [path.join(ROOT, serverFile)],
    // 仅增量 env（SDK 合并到安全默认）；禁止 {...process.env} 全量透传污染被测服务。
    ...(env ? { env } : {}) });
  const client = new Client({ name: 'behavior-regression', version: '1.0.0' });
  await client.connect(transport);
  return {
    listTools: async () => (await client.listTools()).tools,
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

// ============ S0 profile 可见性 ============
async function s0() {
  console.log('\n■ S0 profile 可见性');
  // 184→185：新增只读诊断工具 diagnose_fill_row_integrity（填报行完整性一键盘点）
  // 185→186：新增 delete_mobile_widget_ref（P1-2 移动端孤儿条目定向删除）
  // t1 起 server.js 默认即 focused（23）；M85~M96 陆续补进 focused → 41（此后不动）。
  // report 档历史：M99-D1/M101/M102/M103/M105/M111 陆续"静态进 report" → 57 项 / 150 KB。
  // 2026-10-26：report = 独立静态表；focused 也 42 项。
  // 2026-11-12 P0-1：report 42→33（get_build_progress/get_styles/get_page_settings/get_cell_style
  //   并入 read_cpt({includeProgress}) / get_cells({includeStyle}) / 读门禁视图；set_cell_content_type/
  //   set_cell_span 并入 update_cell；add_style/build_report 下沉 style_manage/generator_full 租约族；
  //   add_cell_highlight_batch 默认隐藏走 adhoc）。能力仍完全可达（见 test/reachability.test.js）。
  //   完整能力仍走显式 full（208）。
  for (const [server, expected, env] of [
    ['server-generate.js', 9, {}], ['server-focused.js', 42, {}], ['server.js', 33, {}],
    ['server.js', 33, { CPT_MCP_TOOL_PROFILE: 'report' }], ['server.js', 208, { CPT_MCP_TOOL_PROFILE: 'full' }],
  ]) {
    const s = await session(server, env);
    const tools = await s.listTools();
    const label = Object.keys(env || {}).length ? `${server}(${env.CPT_MCP_TOOL_PROFILE})` : server;
    ok(`S0·${label} 暴露 ${expected} 个工具`, tools.length === expected, `实际 ${tools.length}`);
    await s.close();
  }
}

// ============ S1 填报型 ============
async function s1(s) {
  console.log('\n■ S1 填报型：控件 + 主键绑定');
  const p = P('回归S1-填报.cpt');
  fs.rmSync(p, { force: true });
  await s.call('create_cpt', { path: p, rows: 3, columns: 5, webWrite: true });
  await s.call('add_style', { path: p, fontSizePt: 12, bold: true, backgroundColor: '#D9E1F2' });
  await s.call('add_style', { path: p, fontSizePt: 12 });
  ['工号', '姓名', '部门', '入职日期', '薪资'].forEach((h, i) =>
    s.call('add_cell', { path: p, column: i, row: 0, content: h, styleIndex: 1 }));
  await s.call('add_cell', { path: p, column: 0, row: 1, styleIndex: 2, widget: 'text' });
  await s.call('add_cell', { path: p, column: 1, row: 1, styleIndex: 2, widget: 'text' });
  await s.call('add_cell', { path: p, column: 2, row: 1, styleIndex: 2, widget: 'comboBox', widgetItems: [{ key: '研发', value: '研发' }, { key: '市场', value: '市场' }] });
  await s.call('add_cell', { path: p, column: 3, row: 1, styleIndex: 2, widget: 'date' });
  await s.call('add_cell', { path: p, column: 4, row: 1, styleIndex: 2, widget: 'number' });
  await s.call('add_fill_submit', { path: p, dsName: 'Doris', table: 'emp', bindings: [
    { field: 'no', column: 0, row: 1, isKey: true }, { field: 'name', column: 1, row: 1 }] });
  const gate = await s.call('quality_gate_cpt', { path: p });
  ok('S1·gate pass', gate.pass === true);
  const fc = await s.call('get_fill_config', { path: p });
  ok('S1·主键绑定', fc.submits[0].columns.find((c) => c.field === 'no')?.isKey === true);
}

// ============ S2 多 sheet build_report ============
async function s2(s) {
  console.log('\n■ S2 多 sheet：build_report 一次成型');
  const p = P('回归S2-多sheet.cpt');
  fs.rmSync(p, { force: true });
  const r = await s.call('build_report', { path: p, spec: {
    sheets: [{ name: '华东' }, { name: '华北' }],
    datasets: [{ name: 'ds', connection: 'Doris', sql: 'SELECT region, amount FROM t WHERE region in (${a},${b})',
      parameters: [{ name: 'a', defaultValue: '华东' }, { name: 'b', defaultValue: '华北' }] }],
    styles: [{ fontSizePt: 14 }, { fontSizePt: 12, bold: true }, { fontSizePt: 12 }],
    cells: ['华东', '华北'].flatMap((sheet) => [
      { column: 0, row: 0, content: `${sheet}销售`, styleIndex: 0, colspan: 2, sheet },
      { column: 0, row: 1, content: '地区', styleIndex: 1, sheet },
      { column: 1, row: 1, content: '金额', styleIndex: 1, sheet },
      { column: 0, row: 2, contentType: 'dsColumn', dsName: 'ds', columnName: 'region', styleIndex: 2, sheet },
      { column: 1, row: 2, contentType: 'dsColumn', dsName: 'ds', columnName: 'amount', styleIndex: 2, sheet },
    ]),
    settings: { paper: 'A4' },
  } });
  ok('S2·自检无 error', r.checkResult?.hasError === false);
  const ov = await s.call('read_cpt', { path: p });
  ok('S2·两工作表', ov.sheets.length === 2 && ov.sheets.includes('华东') && ov.sheets.includes('华北'));
  const gate = await s.call('quality_gate_cpt', { path: p });
  ok('S2·gate pass', gate.pass === true);
}

// ============ S3 大屏 ============
async function s3(s) {
  console.log('\n■ S3 大屏：浮动元素 + 三图');
  const p = P('回归S3-大屏.cpt');
  fs.rmSync(p, { force: true });
  await s.call('create_cpt', { path: p, rows: 20, columns: 12 });
  await s.call('add_dataset', { path: p, name: 'ds1', connection: 'Doris', sql: 'SELECT region, amount FROM s1' });
  await s.call('add_dataset', { path: p, name: 'ds2', connection: 'Doris', sql: 'SELECT month, amount FROM s2' });
  await s.call('add_dataset', { path: p, name: 'ds3', connection: 'Doris', sql: 'SELECT cat, amount FROM s3' });
  await s.call('add_style', { path: p, fontSizePt: 24, bold: true, foregroundColor: '#00E4FF' });
  await s.call('add_float_element', { path: p, content: '监控中心', styleIndex: 1, leftMm: 80, topMm: 4, widthMm: 100, heightMm: 14 });
  await s.call('add_chart', { path: p, column: 0, row: 1, colspan: 6, rowspan: 10, type: 'column', dsName: 'ds1', category: 'region', values: ['amount'] });
  await s.call('add_chart', { path: p, column: 6, row: 1, colspan: 6, rowspan: 10, type: 'line', dsName: 'ds2', category: 'month', values: ['amount'] });
  await s.call('add_chart', { path: p, column: 0, row: 11, colspan: 12, rowspan: 9, type: 'pie', dsName: 'ds3', category: 'cat', values: ['amount'] });
  await s.call('set_report_settings', { path: p, paperWidthMm: 508, paperHeightMm: 286 });
  const ov = await s.call('read_cpt', { path: p });
  ok('S3·浮动元素 + 三图', ov.floatElements === 1 && (await s.call('get_cells', { path: p })).cells.filter((c) => c.contentObjectType === 'CC').length === 3);
  const gate = await s.call('quality_gate_cpt', { path: p });
  ok('S3·gate pass', gate.pass === true);
}

// ============ S4 树形报表 ============
async function s4(s) {
  console.log('\n■ S4 树形：组织架构层级');
  const p = P('回归S4-树形.cpt');
  fs.rmSync(p, { force: true });
  await s.call('create_cpt', { path: p, rows: 6, columns: 4 });
  await s.call('add_dataset', { path: p, name: 'org', connection: 'Doris', sql: 'SELECT id, name, parent_id, parent_name FROM org_table' });
  await s.call('add_tree_dataset', { path: p, name: 'org_tree', source: 'org', childField: 0, parentField: 2, childFieldName: 'id', parentFieldName: 'parent_id' });
  const dsList = await s.call('get_datasets', { path: p });
  // get_datasets 直接返回数组
  ok('S4·树数据集注册', dsList.some((d) => d.name === 'org_tree' && /Recursion/.test(d.class ?? '')));
  await s.call('add_style', { path: p, fontSizePt: 12 });
  await s.call('add_cell', { path: p, column: 0, row: 1, contentType: 'dsColumn', dsName: 'org_tree', columnName: 'name', styleIndex: 1 });
  const gate = await s.call('quality_gate_cpt', { path: p });
  ok('S4·gate pass', gate.pass === true);
  // 负例：源数据集拼错
  const bad = await s.tryCall('add_tree_dataset', { path: p, name: 'tree_bad', source: 'org_typo', childField: 0, parentField: 1 });
  ok('S4·源数据集拼错被拒', bad.isError === true && /org_typo/.test(bad.text));
}

// ============ S5 Excel 数据源 ============
async function s5(s) {
  console.log('\n■ S5 Excel 数据源');
  const p = P('回归S5-excel.cpt');
  fs.rmSync(p, { force: true });
  await s.call('create_cpt', { path: p, rows: 4, columns: 4 });
  await s.call('add_file_dataset', { path: p, name: 'ds_xls', dataFile: 'reportlets/jsc/销量.xlsx', fromEnv: true });
  const ds = await s.call('get_datasets', { path: p });
  // get_datasets 直接返回数组
  ok('S5·ExcelTableData 注册', ds[0]?.class === 'com.fr.data.impl.ExcelTableData');
  const bad = await s.tryCall('add_file_dataset', { path: p, name: 'ds_abs', dataFile: path.resolve(os.tmpdir(), 'x.xlsx'), fromEnv: true });
  ok('S5·fromEnv 口径冲突被拒', bad.isError === true && /fromEnv=true/.test(bad.text));
}

// ============ S7 定时任务 ============
async function s7(s) {
  console.log('\n■ S7 定时任务：add → run_now → history → remove');
  // 干净起点：清除此前运行残留的 store（孤儿任务会让 tracked/清理断言不确定）
  for (const f of ['tmp_test/.cpt-schedule.json', 'tmp_test/.cpt-schedule.json.lock']) {
    const fp = path.join(ROOT, f);
    try { fs.rmSync(fp, { force: true }); } catch { /* ignore */ }
  }
  const p = P('回归S7-定时.cpt');
  fs.rmSync(p, { force: true });
  await s.call('create_cpt', { path: p, rows: 2, columns: 2 });
  const added = await s.call('schedule_add', { path: p, cron: '0 3 * * *', action: 'validate' });
  const taskId = added.id ?? added.added;
  ok('S7·任务注册', !!taskId);
  const list = await s.call('schedule_list', { path: p });
  ok('S7·订阅生效', list.tasks[0]?.tracked === true);
  await s.call('schedule_run_now', { path: p, taskId });
  const detail = await s.call('schedule_get', { path: p, taskId });
  ok('S7·立即执行 + 历史', detail.history?.length >= 1 && detail.history[0].status === 'ok', `status=${detail.history?.[0]?.status}`);
  await s.call('schedule_remove', { path: p, taskId });
  const after = await s.call('schedule_list', { path: p });
  ok('S7·移除干净', after.tasks.length === 0);
}

// ============ S8 围栏负例组（协议层逐个试探） ============
async function s8(s) {
  console.log('\n■ S8 围栏负例组');
  const p = P('回归S8-围栏.cpt');
  fs.rmSync(p, { force: true });
  await s.call('create_cpt', { path: p, rows: 3, columns: 3 });
  await s.call('add_cell', { path: p, column: 0, row: 0, content: 'x' });
  const cases = [
    ['脚本注入默认拒绝', () => s.tryCall('update_cell', { path: p, column: 0, row: 0, content: '<script>alert(1)</script>' }), /安全围栏/],
    ['定时副作用默认关闭', () => s.tryCall('schedule_add', { path: p, cron: '0 3 * * *', action: 'decompile' }), /CPT_MCP_ALLOW_SCHEDULE_SIDE_EFFECTS/],
    ['路径围栏', () => s.tryCall('read_cpt', { path: path.join(process.env.SystemRoot || os.tmpdir(), 'system32', 'evil.cpt') }), /安全围栏|允许目录/],
    ['NTFS 数据流拒绝', () => s.tryCall('read_cpt', { path: path.join(path.dirname(p), 'a:b', '回归S8.cpt') }), /备用数据流|非法盘符/],
    ['非法对齐拒绝', () => s.tryCall('add_style', { path: p, horizontalAlignment: 1 }), /1\/3\/5|仅出现/],
    ['CDATA 闭合注入拒绝', () => s.tryCall('add_cell', { path: p, column: 1, row: 0, content: 'a]]><b/>' }), /\]\]>/],
    ['内置数据集引导性拒绝', () => s.tryCall('add_dataset', { path: p, name: 'x', connection: 'c', sql: 's', embedded: true }), /EmbeddedTableData|内置数据集/],
    ['损坏文件 gate 结构化失败', async () => {
      fs.writeFileSync(p + '.broken.cpt', '<broken>');
      // W1 设计：损坏文件不抛异常，而是结构化 pass=false + blocker「无法解析」
      const r = await s.tryCall('quality_gate_cpt', { path: p + '.broken.cpt' });
      return { isError: r.isError || r.data?.pass === false, text: r.isError ? r.text : JSON.stringify(r.data?.blockers) };
    }, /无法解析/],
  ];
  for (const [name, fn, re] of cases) {
    const r = await fn();
    ok(`S8·${name}`, r.isError === true && re.test(r.text), r.isError ? '' : '未拦截！');
  }
}

// ============ 执行 ============
// S1–S8 覆盖全量工具：显式 full（t1 起 server.js 默认 focused）。
const full = await session('server.js', { CPT_MCP_TOOL_PROFILE: 'full' });
try {
  await s0();
  for (const fn of [s1, s2, s3, s4, s5, s7, s8]) {
    try { await fn(full); }
    catch (e) { failed++; console.log(`  ✖ 场景异常: ${e.message.slice(0, 200)}`); }
  }
} finally { await full.close(); }

console.log(`\n行为回归总计: ${passed} 通过 / ${failed} 失败`);
process.exit(failed === 0 ? 0 : 1);
