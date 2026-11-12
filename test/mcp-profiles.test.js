import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createCpt, addStyle, addCell, addFillSubmit } from '../lib/generate.js';
import { READ_ONLY_TOOLS, REPORT_STATIC_TOOLS } from '../lib/contract.js';
import { DEEP_TOOL_GROUPS } from '../lib/deep-tools.js';
import '../scripts/isolate-store.mjs'; // M123：JS 基线 store 隔离，直跑也不污染真实 store

async function list(entry, env) {
  const client = new Client({ name: 'profile-test', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry],
    cwd: process.cwd(),
    stderr: 'pipe',
    // 只传增量覆盖；SDK 会合并到安全默认 env。禁止 {...process.env} 全量透传，
    // 否则会话级变量（如 CPT_MCP_ALLOWED_ROOTS）会污染被测服务行为。
    ...(env ? { env } : {}),
  });
  await client.connect(transport);
  try {
    return (await client.listTools()).tools;
  } finally {
    await client.close();
  }
}

test('渐进式 MCP 入口显著降低弱模型 tools/list 负担，同时保留完整入口', async () => {
  // 2026-10-26 自包含化：默认入口切 report（不依赖宿主预设注入 CPT_MCP_TOOL_PROFILE）；
  // 弱模型省 token 仍可用显式 focused，完整能力走显式 full。
  const [generate, focused, implicitDefault, full, report] = await Promise.all([
    list('server-generate.js'), list('server-focused.js'), list('server.js'), list('server.js', { CPT_MCP_TOOL_PROFILE: 'full' }), list('server.js', { CPT_MCP_TOOL_PROFILE: 'report' }),
  ]);
  assert.deepEqual(generate.map((tool) => tool.name).sort(), [
    'generate_report', 'get_build_progress', 'get_capabilities',
    'quality_gate_cpt', 'read_cpt', 'read_cpt_compact', 'record_cpt_read_intent',
    'request_deep_tool_access', 'validate_cpt',
  ]);
  assert.equal(focused.length, 42);
  // focused 必须含参数面板工具（用户转下拉多选高频场景）
  for (const t of ['get_parameter_panel', 'set_parameter_panel', 'add_parameter_widget', 'update_parameter_widget', 'delete_parameter_widget']) {
    assert.ok(focused.some((x) => x.name === t), `focused 应含 ${t}`);
  }
  // M86：focused 必须含单元格监听器读写工具（用户改商品格监听器高频场景；监听器不在租约体系内，必须进 profile）
  for (const t of ['get_cell_listener', 'add_cell_listener', 'update_cell_listener', 'delete_cell_listener']) {
    assert.ok(focused.some((x) => x.name === t), `focused 应含 ${t}`);
  }
  // M87：focused 必须含报表级 Listener 读写（用户改 afterload JS 的 rowCalc 等高频场景）
  for (const t of ['get_report_listener', 'set_report_listener']) {
    assert.ok(focused.some((x) => x.name === t), `focused 应含 ${t}`);
  }
  // M88：focused 必须含 WebWriteContent 监听器读写（模板 JS 挂 WebWrite 下时的高频场景）
  for (const t of ['get_webwrite_js', 'set_webwrite_js']) {
    assert.ok(focused.some((x) => x.name === t), `focused 应含 ${t}`);
  }
  // M91：focused 必须含单元格下拉字典改（V3 双通道 ki/vi 平齐高频场景；此前无入口只能裸改 XML 致误删）
  assert.ok(focused.some((x) => x.name === 'update_cell_dictionary'), 'focused 应含 update_cell_dictionary');
  // M92：focused 必须含 JS 语法检查（v4 排错 77 步复盘：排错会话必须调得到行号）
  assert.ok(focused.some((x) => x.name === 'check_report_js'), 'focused 应含 check_report_js');
  // M93：focused 必须含工具栏按钮读写（V3 收尾三按钮都要 set_toolbar_button_js；此前无注册只能整块裸改）
  for (const t of ['list_toolbar_buttons', 'set_toolbar_button_js']) {
    assert.ok(focused.some((x) => x.name === t), `focused 应含 ${t}`);
  }
  // M96：focused 必须含字典正文读取（此前读半边空着，只能三重证据推定；与 M91 写入口闭环）
  assert.ok(focused.some((x) => x.name === 'get_cell_dictionary'), 'focused 应含 get_cell_dictionary');
  assert.deepEqual(implicitDefault.map((t) => t.name).sort(), report.map((t) => t.name).sort());
  // M90 report profile / M113 工具定义瘦身：报表模式专用档 = **37 项独立静态表**
  // 名单的单一来源是 lib/contract.js 的 REPORT_STATIC_TOOLS；不再用"focused + 追加"写法
  // （focused 是弱模型省 token 的精选子集，两者目标不同，叠加写法会让 report 跟着 focused 一起膨胀）。
  assert.equal(report.length, REPORT_STATIC_TOOLS.length, `report 档应 ${REPORT_STATIC_TOOLS.length} 项静态工具（M113）`);
  assert.deepEqual(report.map((t) => t.name).sort(), [...REPORT_STATIC_TOOLS].sort(), 'report 档名单 = REPORT_STATIC_TOOLS');
  for (const t of ['get_datasets', 'get_parameters', 'get_cells', 'get_grid',
    'get_fill_config', 'add_file_dataset']) {
    assert.ok(report.some((x) => x.name === t), `report 档应含 ${t}（persona 读取协议/数据源接入）`);
  }
  for (const t of ['get_datasets', 'get_parameters', 'get_cells', 'get_styles', 'get_grid', 'get_page_settings',
    'get_fill_config', 'add_file_dataset']) {
    assert.ok(!focused.some((x) => x.name === t), `focused 档不应含 ${t}（弱模型省 token 子集，persona 需显式用 report 档）`);
  }
  // M113：以下工具原先「静态进 report」（M99-D1~M111 陆续加入），现按场景族整体下沉：
  //   report 静态表里看不到（每请求省 token），但都在具名租约族内 → 一次解锁整族即恢复；
  //   能力仍然完全可达，全局可达性由 test/reachability.test.js 的 196 项不变量锁定。
  for (const [t, group] of [
    ['update_parameter', 'param_panel'], ['delete_parameter', 'param_panel'],
    ['add_parameter', 'param_panel'], ['set_parameter_panel', 'param_panel'],
    ['add_parameter_widget', 'param_panel'], ['update_parameter_widget', 'param_panel'],
    ['delete_parameter_widget', 'param_panel'],
    ['add_fill_submit', 'fill_binding'], ['update_fill_binding', 'fill_binding'],
    ['delete_fill_binding', 'fill_binding'], ['set_fill_toolbar', 'fill_binding'],
    ['add_toolbar_button', 'toolbar_edit'], ['set_toolbar_button_js', 'toolbar_edit'],
    ['set_page_header_footer', 'page_setup'], ['set_template_theme', 'page_setup'],
    ['set_report_imports', 'page_setup'],
    ['get_embedded_submits', 'fill_binding'], ['update_embedded_submit', 'fill_binding'],
    ['update_cell_dictionary', 'cell_dictionary'],
    ['set_report_js', 'scripting'], ['set_report_listener', 'scripting'],
    ['set_webwrite_js', 'scripting'], ['add_cell_listener', 'scripting'],
    ['update_cell_listener', 'scripting'], ['delete_cell_listener', 'scripting'],
    ['add_chart', 'chart_float'], ['add_cell_hyperlink', 'hyperlink_highlight'],
    ['add_tree_dataset', 'dataset_edit'],
    // 2026-11-12 P0-1：以下工具从 report 静态表下沉（能力经租约族/读门禁/focused 保留）
    ['add_style', 'style_manage'], ['delete_style', 'style_manage'],
    ['get_cell_style', 'cell_detail'],
    ['set_cell_content_type', 'cell_primitive'], ['set_cell_span', 'cell_primitive'],
    ['build_report', 'generator_full'],
  ]) {
    assert.ok(!report.some((x) => x.name === t), `${t} 应已下沉到 ${group} 族（不在 report 静态表）`);
    assert.ok(DEEP_TOOL_GROUPS[group]?.has(t), `${t} 必须在 ${group} 族内（否则不可达）`);
  }
  // 2026-11-12 P0-1：get_build_progress 并入 read_cpt({includeProgress:true})；独立工具不在
  // report 静态表（generate 档仍静态，见上方 generate 名单断言），读路径由 read_cpt 承载。
  assert.ok(!report.some((x) => x.name === 'get_build_progress'), 'get_build_progress 并入 read_cpt 后不应常驻 report 静态表');
  // M105 单元格绑定/合并手术已并入 update_cell（contentType / colspan,rowspan），静态只留 update_cell
  assert.ok(report.some((x) => x.name === 'update_cell'), 'report 档应含合并后的 update_cell');
  assert.ok(!report.some((x) => x.name === 'set_cell_content_type'), 'set_cell_content_type 已并入 update_cell，不再常驻');
  assert.ok(!report.some((x) => x.name === 'set_cell_span'), 'set_cell_span 已并入 update_cell，不再常驻');
  assert.ok(!focused.some((x) => x.name === 'set_cell_content_type'), 'focused 档不应含 set_cell_content_type');
  // 184 → 185：新增只读诊断工具 diagnose_fill_row_integrity（填报行完整性一键盘点）
  // 185 → 186：新增 delete_mobile_widget_ref（P1-2 移动端孤儿条目定向删除）
  // 186 → 187：新增 get_report_listener（M87 报表级 Listener 全文读取）
  // 187 → 188：新增 get_webwrite_js（M88 WebWriteContent 监听器全文读取）
  // 188 → 189：新增 update_cell_dictionary（M91 单元格下拉字典原位改，V3 误删断根）
  // 189 → 190：新增 get_cell_dictionary（M96 字典正文只读，读改闭环）
  // 190 → 192：M113 瘦身后归位；192 → 193：新增 clear_widget_value（M115 清理脏 widgetValue）
  // 193 → 194：新增 set_report_imports（Web 页面静态资源引用 CSSImport/JSImport，sandbox17 无参数模板实证）
  // 194 -> 196: get_embedded_submits / update_embedded_submit (btn-embedded Commit2DB submits)
  // 196 -> 197: run_dataset_sql_check（M145 数据集 SQL 只读实跑 + 列名对账）
  // 197 -> 198: verify_cpt（2026-10-26 MCP 自主核验：结构+门禁+期望值对账+真引擎）
  // 198 -> 201: start_fr_preview / stop_fr_preview / fr_preview_status（2026-10-29 本地独立 FR 报表实例）
  // 201 -> 207: 内置 SQLite 本地测试库 6 件套（local_db 租约族；2026-11-02）
  // 207 -> 208: set_webpage_js（分页预览 WebPageContent 事件写入；scripting 租约族；2026-11-07）
  assert.equal(full.length, 208);
  assert.ok(JSON.stringify(generate).length < JSON.stringify(full).length * 0.2);
});

test('新增工具 diagnose_fill_row_integrity 已注册为只读，MCP 端到端可调用并产出缺失清单', async () => {
  const full = await list('server.js', { CPT_MCP_TOOL_PROFILE: 'full' });
  const diagTool = full.find((t) => t.name === 'diagnose_fill_row_integrity');
  assert.ok(diagTool, 'server.js 应注册 diagnose_fill_row_integrity（184→185）');
  assert.ok(READ_ONLY_TOOLS.has('diagnose_fill_row_integrity'), '应归类为只读工具');
  assert.equal(diagTool.annotations?.readOnlyHint, true, 'readOnlyHint 应为 true（只读诊断，不改文件）');
  assert.equal(diagTool.annotations?.destructiveHint, false);
  assert.ok(diagTool.inputSchema?.properties?.path, '应有 path 参数');
  // 无未归类工具：工具名与分类清单逐一对齐（单一事实源 = lib/contract.js）
  assert.ok(full.every((t) => t.annotations?.title === t.name), '每个工具都应有契约注解（无漏归类）');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-fill-diag-'));
  const p = path.join(dir, '填报.cpt');
  createCpt(p, { title: 'T', rows: 2, columns: 2, webWrite: true });
  addStyle(p, { fontSizePt: 12 });
  addCell(p, { column: 0, row: 0, content: '工号', styleIndex: 1 });
  addCell(p, { column: 0, row: 1, styleIndex: 0, widget: 'text' });
  addFillSubmit(p, { dsName: 'Doris', table: 'emp', bindings: [{ field: 'no', column: 0, row: 1, isKey: true }] });

  const client = new Client({ name: 'diag-test', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath, args: ['server.js'], cwd: process.cwd(), stderr: 'pipe',
    env: { CPT_MCP_TOOL_PROFILE: 'full' },
  });
  await client.connect(transport);
  try {
    const r = await client.callTool({ name: 'diagnose_fill_row_integrity', arguments: { path: p } });
    assert.ok(!r.isError, r.content?.[0]?.text);
    const data = JSON.parse(r.content[0].text);
    assert.equal(data.action, 'diagnose_fill_row_integrity');
    // 全行未设 insertPolicy = 官方常态（175/178 个官方填报 sheet 如此）→ 不算缺口
    assert.equal(data.totals.missingInsertPolicyCopy, 0);
    assert.deepEqual(data.sheets[0].missing.insertPolicyCopy, []);
    // 只读：盘点前后文件字节一致
    const before = fs.readFileSync(p, 'utf8');
    await client.callTool({ name: 'diagnose_fill_row_integrity', arguments: { path: p } });
    assert.equal(fs.readFileSync(p, 'utf8'), before, '诊断工具不得改动 CPT 文件');

    // 写入口经 MCP 端到端可用：update_cell(insertPolicy) → get_cells 读回一致
    const w = await client.callTool({ name: 'update_cell', arguments: { path: p, column: 0, row: 1, insertPolicy: 'copy' } });
    assert.ok(!w.isError, w.content?.[0]?.text);
    const gc = JSON.parse((await client.callTool({ name: 'get_cells', arguments: { path: p, row: 1 } })).content[0].text);
    assert.equal(gc.cells[0].insertPolicy, 'copy');
    const xml = fs.readFileSync(p, 'utf8');
    assert.ok(xml.includes('<CellInsertPolicy><InsertPolicy><![CDATA[copy]]></InsertPolicy></CellInsertPolicy>'), 'MCP 写入应为官方 CDATA 形态');
    // 非法枚举经 MCP 被拒（不落盘）
    const bad = await client.callTool({ name: 'update_cell', arguments: { path: p, column: 0, row: 1, insertPolicy: 'first' } });
    assert.equal(bad.isError, true);
    assert.match(bad.content[0].text, /取值非法/);
    // insertPolicy 与 content 互斥（一次只做一类改动，不静默丢参）
    const mixed = await client.callTool({ name: 'update_cell', arguments: { path: p, column: 0, row: 1, content: 'x', insertPolicy: 'copy' } });
    assert.equal(mixed.isError, true);
    assert.match(mixed.content[0].text, /一次只做一类改动/);
    assert.match(mixed.content[0].text, /insertPolicy/);
    // 行内不一致才是缺口：加一个未设 insertPolicy 的同行控件格 → diagnose/validate 都能报出
    addCell(p, { column: 1, row: 1, styleIndex: 0, widget: 'text' });
    const d2 = JSON.parse((await client.callTool({ name: 'diagnose_fill_row_integrity', arguments: { path: p } })).content[0].text);
    assert.deepEqual(d2.sheets[0].missing.insertPolicyCopy, ['sheet1!B2'], '行内不一致的缺格应被盘点出来');
    assert.equal(d2.sheets[0].partialRowCount, 1);
    const v = JSON.parse((await client.callTool({ name: 'validate_cpt', arguments: { path: p } })).content[0].text);
    const inc = v.issues.filter((i) => /insertPolicy 不一致/.test(i.message));
    assert.equal(inc.length, 1, `validate_cpt 应报 1 条行内不一致：${JSON.stringify(v.issues.filter((i) => /填报行完整性/.test(i.message)))}`);
    assert.equal(inc[0].severity, 'warning');
    assert.match(inc[0].message, /sheet1!B2 未设 insertPolicy/);
  } finally {
    await client.close();
  }
});

test('M86 focused 档单元格监听器端到端（用户改商品格监听器场景）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-m86-'));
  const p = path.join(dir, 't.cpt');
  createCpt(p, { rows: 3, columns: 3 });
  addStyle(p, { fontSizePt: 12 });
  addCell(p, { column: 0, row: 1, styleIndex: 1, widget: 'text' });

  const client = new Client({ name: 'm86-test', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath, args: ['server.js'], cwd: process.cwd(), stderr: 'pipe',
    env: { CPT_MCP_TOOL_PROFILE: 'focused' }, // 默认档（用户实际用的入口）
  });
  await client.connect(transport);
  try {
    // focused 档必须能看到监听器读写工具（不进租约、不进 full 也能用）
    const tools = new Set((await client.listTools()).tools.map((t) => t.name));
    for (const t of ['get_cell_listener', 'add_cell_listener', 'update_cell_listener', 'delete_cell_listener']) {
      assert.ok(tools.has(t), `focused 档应注册 ${t}`);
    }
    // 用户场景：商品格监听器插入 deferFill JS（stopedit 事件）→ 读回 → 改 → 读回
    const js1 = 'var r = deferFill(this, "S", "组合装");';
    let r = await client.callTool({ name: 'add_cell_listener', arguments: { path: p, column: 0, row: 1, event: 'stopedit', js: js1, allowUnsafeScript: true } });
    assert.ok(!r.isError, r.content?.[0]?.text);
    let g = JSON.parse((await client.callTool({ name: 'get_cell_listener', arguments: { path: p, column: 0, row: 1 } })).content[0].text);
    assert.equal(g.count, 1);
    assert.equal(g.listeners[0].js, js1, '读回与写入一致');
    // 改：更新 JS 正文
    const js2 = 'var r = deferFill(this, "S", "组合装", true);';
    r = await client.callTool({ name: 'update_cell_listener', arguments: { path: p, column: 0, row: 1, event: 'stopedit', js: js2, allowUnsafeScript: true } });
    assert.ok(!r.isError, r.content?.[0]?.text);
    g = JSON.parse((await client.callTool({ name: 'get_cell_listener', arguments: { path: p, column: 0, row: 1 } })).content[0].text);
    assert.equal(g.listeners[0].js, js2, '修改后读回一致');
    // 删
    r = await client.callTool({ name: 'delete_cell_listener', arguments: { path: p, column: 0, row: 1, event: 'stopedit' } });
    assert.ok(!r.isError, r.content?.[0]?.text);
    g = JSON.parse((await client.callTool({ name: 'get_cell_listener', arguments: { path: p, column: 0, row: 1 } })).content[0].text);
    assert.equal(g.count, 0, '删除后监听器清空');
  } finally {
    await client.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('M87 focused 档报表级 Listener 读改写闭环（用户改 afterload rowCalc 场景）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-m87-'));
  const p = path.join(dir, 't.cpt');
  createCpt(p, { rows: 3, columns: 3 });
  addStyle(p, { fontSizePt: 12 });
  addCell(p, { column: 0, row: 1, styleIndex: 1, widget: 'text' });
  // 先造一个 afterload Listener（含 rowCalc 特征串），模拟用户模板现状
  const { setReportListener } = await import('../lib/edits.js');
  const js0 = [
    'function rowCalc(combo){',
    '  var cost = null;',
    '  if (combo) { cost = combo.cost; }',
    '  return cost;',
    '}',
    'try { rowCalc(null); } catch (e) {}',
  ].join('\n');
  setReportListener(p, { event: 'afterload', js: js0, sheet: 0 });

  const client = new Client({ name: 'm87-test', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath, args: ['server.js'], cwd: process.cwd(), stderr: 'pipe',
    env: { CPT_MCP_TOOL_PROFILE: 'focused' }, // 默认档（用户实际用的入口）
  });
  await client.connect(transport);
  try {
    const tools = new Set((await client.listTools()).tools.map((t) => t.name));
    assert.ok(tools.has('get_report_listener'), 'focused 应注册 get_report_listener');
    assert.ok(tools.has('set_report_listener'), 'focused 应注册 set_report_listener');
    // 读回 afterload 全文
    let r = await client.callTool({ name: 'get_report_listener', arguments: { path: p, event: 'afterload' } });
    assert.ok(!r.isError, r.content?.[0]?.text);
    let g = JSON.parse(r.content[0].text);
    assert.equal(g.count, 1);
    assert.ok(g.listeners[0].js.includes('function rowCalc'), '读回 rowCalc 全文');
    const jsRead = g.listeners[0].js;
    // 模拟用户 2 处改动：①兜底行后插入 cost 置空段 ②回退行加守卫
    const jsNew = jsRead
      .replace(
        '  if (combo) { cost = combo.cost; }',
        '  if (combo) { cost = combo.cost; }\n  if (combo && cost != null && num(miss.missCost) > 0) { cost = null; }'
      );
    assert.notEqual(jsNew, jsRead, '改动生效');
    // 写回（match 特征串精确定位）
    r = await client.callTool({ name: 'set_report_listener', arguments: { path: p, event: 'afterload', js: jsNew, match: 'function rowCalc', allowUnsafeScript: true } });
    assert.ok(!r.isError, r.content?.[0]?.text);
    // 读回验证改动已落盘
    r = await client.callTool({ name: 'get_report_listener', arguments: { path: p, event: 'afterload' } });
    g = JSON.parse(r.content[0].text);
    assert.equal(g.count, 1);
    assert.ok(g.listeners[0].js.includes('cost != null && num(miss.missCost) > 0'), '改动已写回并读回一致');
    // CDATA 原文语义：读回 = 落盘字节
    const xml = fs.readFileSync(p, 'utf8');
    assert.ok(xml.includes('cost != null && num(miss.missCost) > 0'), 'XML 中已含改动（CDATA 原文）');
  } finally {
    await client.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('M88 focused 档 WebWriteContent 监听器读改写闭环（用户改 frFin/rowCalc 挂 WebWrite 下场景）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-m88-'));
  const p = path.join(dir, 't.cpt');
  // 造含 WebWriteContent 的模板（create_cpt(webWrite=true)），再挂填报 Web 事件监听器
  const { createCpt: mkCpt, addStyle: mkStyle, addCell: mkCell } = await import('../lib/generate.js');
  const { setWebWriteJs } = await import('../lib/edits.js');
  mkCpt(p, { rows: 3, columns: 3, webWrite: true });
  mkStyle(p, { fontSizePt: 12 });
  mkCell(p, { column: 0, row: 1, styleIndex: 1, widget: 'text' });
  // 用户模板实况：JS 全挂 WebWriteContent 监听器（Q.combo/rowCalc 都在里面）
  const js0 = [
    'function rowCalc(combo){',
    '  var cost = null;',
    '  if (combo) { cost = combo.cost; }',
    '  return cost;',
    '}',
    'try { rowCalc(null); } catch (e) {}',
  ].join('\n');
  setWebWriteJs(p, { event: 'afterappend', js: js0 });

  const client = new Client({ name: 'm88-test', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath, args: ['server.js'], cwd: process.cwd(), stderr: 'pipe',
    env: { CPT_MCP_TOOL_PROFILE: 'focused' }, // 默认档（用户实际用的入口）
  });
  await client.connect(transport);
  try {
    const tools = new Set((await client.listTools()).tools.map((t) => t.name));
    assert.ok(tools.has('get_webwrite_js'), 'focused 应注册 get_webwrite_js');
    assert.ok(tools.has('set_webwrite_js'), 'focused 应注册 set_webwrite_js');
    // 报表级读取此模板应为空（JS 不在报表级）——复现用户实测
    const rl = await client.callTool({ name: 'get_report_listener', arguments: { path: p, event: 'afterload' } });
    assert.equal(JSON.parse(rl.content[0].text).count, 0, '报表级无 Listener（与用户实测 reportListeners:0 一致）');
    // WebWrite 级读取命中
    let r = await client.callTool({ name: 'get_webwrite_js', arguments: { path: p, event: 'afterappend' } });
    assert.ok(!r.isError, r.content?.[0]?.text);
    let g = JSON.parse(r.content[0].text);
    assert.equal(g.count, 1);
    assert.ok(g.listeners[0].js.includes('function rowCalc'), '读回 WebWrite 内 rowCalc 全文');
    assert.equal(g.listeners[0].scope, 'workbook', 'WorkBook 级 WebWriteContent 命中');
    const jsRead = g.listeners[0].js;
    // 模拟用户 F1 改动：cost 置空守卫
    const jsNew = jsRead.replace(
      '  if (combo) { cost = combo.cost; }',
      '  if (combo) { cost = combo.cost; }\n  if (combo && cost != null && num(miss.missCost) > 0) { cost = null; }'
    );
    assert.notEqual(jsNew, jsRead, '改动生效');
    // 写回（match 特征串精确定位）
    r = await client.callTool({ name: 'set_webwrite_js', arguments: { path: p, event: 'afterappend', js: jsNew, match: 'function rowCalc', allowUnsafeScript: true } });
    assert.ok(!r.isError, r.content?.[0]?.text);
    // 读回验证
    r = await client.callTool({ name: 'get_webwrite_js', arguments: { path: p, event: 'afterappend' } });
    g = JSON.parse(r.content[0].text);
    assert.equal(g.count, 1);
    assert.ok(g.listeners[0].js.includes('num(miss.missCost) > 0'), '改动已写回并读回一致');
    const xml = fs.readFileSync(p, 'utf8');
    assert.ok(xml.includes('num(miss.missCost) > 0'), 'XML 已含改动（CDATA 原文落盘）');
  } finally {
    await client.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('M89 防误删：同 event 多 Listener 无 match 拒绝，match 精确定位（set_webwrite_js/set_report_listener）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-m89-'));
  const p = path.join(dir, 't.cpt');
  const { createCpt: mkCpt } = await import('../lib/generate.js');
  const { setWebWriteJs, setReportListener } = await import('../lib/edits.js');
  const { webwriteListener, reportListener } = await import('../lib/cpt.js');
  mkCpt(p, { rows: 2, columns: 2, webWrite: true });
  // 构造 WebWriteContent 3 个 afterload（模拟用户模板：frFin 引擎 / legacy 兜底 / 诊断）
  let raw = fs.readFileSync(p, 'utf8');
  const mkBlock = (js) => `<Listener event="afterload">
<JavaScript class="com.fr.js.JavaScriptImpl">
<Parameters/>
<Content>
<![CDATA[${js}]]></Content>
</JavaScript>
</Listener>`;
  const blocks = [
    'function frFin() { return 1; } // frFin引擎',
    'function legacyCalc() { return 2; } // legacy兜底',
    'function diag() { return 3; } // 诊断',
  ].map(mkBlock);
  const wwcStart = raw.indexOf('<WebWriteContent>');
  const wwcEnd = raw.indexOf('</WebWriteContent>', wwcStart);
  raw = raw.slice(0, wwcEnd) + blocks.join('\n') + '\n' + raw.slice(wwcEnd);
  fs.writeFileSync(p, raw);
  assert.equal(webwriteListener(p, { event: 'afterload' }).count, 3, '预置 3 块');
  // ① 无 match 写回 → 拒绝（不再静默命中第一个）
  assert.throws(() => setWebWriteJs(p, { event: 'afterload', js: 'x()' }), /有 3 个 Listener，未传 match/, '无 match 必须拒绝');
  // ② 无 match 删除 → 拒绝
  assert.throws(() => setWebWriteJs(p, { event: 'afterload' }), /有 3 个 Listener，未传 match/, '无 match 删除必须拒绝');
  // ③ match 精确定位 legacy 块替换 → 只改命中块
  setWebWriteJs(p, { event: 'afterload', js: 'function legacyCalc() { return 99; } // legacy兜底已改', match: 'legacy兜底' });
  const all = fs.readFileSync(p, 'utf8');
  assert.ok(all.includes('return 1') && all.includes('return 99') && all.includes('return 3'), '只改命中块，frFin/diag 保留');
  assert.equal(webwriteListener(p, { event: 'afterload' }).count, 3, '块数不变');
  // ④ match 不存在 → 拒绝
  assert.throws(() => setWebWriteJs(p, { event: 'afterload', js: 'x()', match: 'NO_SUCH' }), /未找到/, '不存在 match 拒绝');
  // ⑤ 报表级同口径：构造多 afterload Listener（Report 块内），无 match 拒绝
  const p2 = path.join(dir, 'r.cpt');
  mkCpt(p2, { rows: 2, columns: 2 });
  setReportListener(p2, { event: 'afterload', js: 'function A() {} // A块', sheet: 0 });
  // 手工在 </Report> 前注入 2 个额外块（模拟真实模板多 afterload：A块/frFin/B块）
  let raw2 = fs.readFileSync(p2, 'utf8');
  const repEnd2 = raw2.indexOf('</Report>');
  assert.ok(repEnd2 > 0, '找到 </Report>');
  const extra2 = mkBlock('function frFin() { return 7; } // frFin块') + '\n' + mkBlock('function B() { return 8; } // B块');
  raw2 = raw2.slice(0, repEnd2) + extra2 + '\n' + raw2.slice(repEnd2);
  fs.writeFileSync(p2, raw2);
  assert.equal(reportListener(p2, { event: 'afterload' }).count, 3, '报表级 3 块预置');
  assert.throws(() => setReportListener(p2, { event: 'afterload', js: 'x()', sheet: 0 }), /有 3 个 Listener，未传 match/, '报表级无 match 必须拒绝');
  // match 精确定位 B 块
  setReportListener(p2, { event: 'afterload', js: 'function B() { return 88; } // B块已改', match: 'B块', sheet: 0 });
  const all2 = fs.readFileSync(p2, 'utf8');
  assert.ok(all2.includes('return 88'), 'B 块已改');
  assert.equal(reportListener(p2, { event: 'afterload' }).count, 3, '报表级块数不变');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('M90 report 档：报表 persona 读取协议与数据源接入工具端到端可用', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-m90-'));
  const p = path.join(dir, 't.cpt');
  const { createCpt: mkCpt, addDataset, addStyle, addCell } = await import('../lib/generate.js');
  mkCpt(p, { rows: 3, columns: 3 });
  addStyle(p, { fontSizePt: 12 });
  addCell(p, { column: 0, row: 1, styleIndex: 1, content: '部门' });
  addDataset(p, { name: 'ds1', connection: 'Doris', sql: 'SELECT * FROM t' });

  const client = new Client({ name: 'm90-test', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath, args: ['server.js'], cwd: process.cwd(), stderr: 'pipe',
    env: { CPT_MCP_TOOL_PROFILE: 'report' }, // 报表模式专用档
  });
  await client.connect(transport);
  try {
    // persona「token 优化/读取协议」段引用的工具全部可调（不再是 unknown tool）
    const tools = new Set((await client.listTools()).tools.map((t) => t.name));
    for (const t of ['get_datasets', 'get_parameters', 'get_cells', 'get_grid', 'get_fill_config', 'add_file_dataset']) {
      assert.ok(tools.has(t), `report 档应注册 ${t}`);
    }
    // 端到端：读取协议可用
    let r = await client.callTool({ name: 'get_datasets', arguments: { path: p } });
    assert.ok(!r.isError, r.content?.[0]?.text);
    assert.ok(Array.isArray(JSON.parse(r.content[0].text)), 'get_datasets 返回数组');
    assert.ok(JSON.parse(r.content[0].text).some((d) => d.name === 'ds1'), 'get_datasets 读到 ds1');
    r = await client.callTool({ name: 'get_cells', arguments: { path: p } });
    assert.ok(!r.isError, r.content?.[0]?.text);
    // P0-1：单格样式读并入 get_cells({includeStyle:true})
    r = await client.callTool({ name: 'get_cells', arguments: { path: p, includeStyle: true } });
    assert.ok(!r.isError, r.content?.[0]?.text);
    const cellPage = JSON.parse(r.content[0].text);
    assert.ok(cellPage.cells.every((c) => 'styleDetail' in c), 'includeStyle=true 应附带 styleDetail');
    // P0-1：模板样式表/页面设置改走读门禁视图（get_styles/get_page_settings 不再常驻）
    const intent = await client.callTool({ name: 'record_cpt_read_intent', arguments: { path: p, views: ['styles', 'page'], purpose: '读取样式表与页面设置' } });
    assert.ok(!intent.isError, intent.content?.[0]?.text);
    const permitId = JSON.parse(intent.content[0].text).permitId;
    r = await client.callTool({ name: 'read_cpt_compact', arguments: { path: p, permitId, view: 'styles' } });
    assert.ok(!r.isError, r.content?.[0]?.text);
    r = await client.callTool({ name: 'read_cpt_compact', arguments: { path: p, permitId, view: 'page' } });
    assert.ok(!r.isError, r.content?.[0]?.text);
    // 深层工具租约仍在（report 档非 full，batch_mutate_cells 未静态注册）
    assert.ok(!tools.has('batch_mutate_cells'), 'report 档 batch_mutate_cells 需租约（安全边界保留）');
  } finally {
    await client.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('M104/M113 静态按需暴露：CPT_MCP_EXTRA_TOOLS 进静态表，无需临租', async () => {
  // M113 后 report 静态表只剩 37 项常驻能力，大量低频工具转入场景族租约；
  // EXTRA 通道是"某个部署确实高频、不想每次租"的静态放行口（配置里一次声明，重启生效）。
  const base = await list('server.js', { CPT_MCP_TOOL_PROFILE: 'report' });
  const withExtra = await list('server.js', { CPT_MCP_TOOL_PROFILE: 'report', CPT_MCP_EXTRA_TOOLS: 'get_chart,set_template_theme' });
  for (const t of ['get_chart', 'set_template_theme']) {
    assert.ok(withExtra.some((x) => x.name === t), `EXTRA 应静态暴露 ${t}`);
    assert.ok(!base.some((x) => x.name === t), `默认 report 不应含 ${t}（小集合原则）`);
  }
  // M113：set_fill_toolbar 已下沉到 fill_binding 族；EXTRA 同样能把它按回静态表
  const withFill = await list('server.js', { CPT_MCP_TOOL_PROFILE: 'report', CPT_MCP_EXTRA_TOOLS: 'set_fill_toolbar' });
  assert.ok(withFill.some((x) => x.name === 'set_fill_toolbar'), 'EXTRA 应静态暴露 set_fill_toolbar');
  assert.ok(!base.some((x) => x.name === 'set_fill_toolbar'), 'M113 后默认 report 不含 set_fill_toolbar');
});
