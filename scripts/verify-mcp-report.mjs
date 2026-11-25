// cpt-mcp/scripts/verify-mcp-report.mjs —— report 档（报表模式）端到端验证
//
// 为什么单独一个脚本：`scripts/verify-mcp.mjs` 走的是 **full 档**（全量工具静态可见），
// 而线上报表会话实际用的是 `CPT_MCP_TOOL_PROFILE=report` —— 那一档在 M113 工具定义瘦身后
// 只剩 37 项静态工具，其余能力全部经**场景族租约**获得。于是出现一个新失败模式：
// "full 档全绿"并不代表 report 档可用（工具看不到、租约租不到、轻 entry 传参被拒）。
//
// 本脚本按报表模式的两条主线各跑一遍真机链路：
//   A. 存量精修（读 → 改单元格/样式 → 写脚本 → validate → quality_gate），脚本走 scripting 租约；
//   B. 从零建表 + 填报（create → dataset → style → cell → 绑定 → 工具栏），绑定/工具栏走 fill_binding 租约。
// 并断言：report 静态表 = REPORT_STATIC_TOOLS（不多不少）、未租的工具报 not found、
// 轻 entry 的参数校验仍然精确到字段。
//
// 运行：node scripts/verify-mcp-report.mjs   （退出码 0=全部通过，1=失败）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { REPORT_STATIC_TOOLS } from '../lib/contract.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(__dirname, '..', 'server.js');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-mcp-report-verify-'));

let failed = 0;
const step = (name, ok, detail = '') => {
  console.log(`${ok ? '✔' : '✖'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed += 1;
};

const client = new Client({ name: 'cpt-mcp-report-verify', version: '1.0.0' });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [SERVER],
  cwd: path.join(__dirname, '..'),
  // 被测档位：报表模式（弱模型档 focused 与全量档 full 由另外的脚本覆盖）
  env: { CPT_MCP_TOOL_PROFILE: 'report' },
});
const call = async (tool, args) => {
  const res = await client.callTool({ name: tool, arguments: args });
  const text = res.content?.find((c) => c.type === 'text')?.text ?? '';
  let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
  return { res, text, data, isError: res.isError === true };
};

try {
  await client.connect(transport);
  step('MCP 连接（report 档）', true, 'initialize 握手成功');

  // ---------- 0. 静态表与租约边界 ----------
  const names = (await client.listTools()).tools.map((t) => t.name);
  const extra = names.filter((n) => !REPORT_STATIC_TOOLS.includes(n));
  const missing = REPORT_STATIC_TOOLS.filter((n) => !names.includes(n));
  step('report 静态表 = REPORT_STATIC_TOOLS（不多不少）', extra.length === 0 && missing.length === 0,
    `实际 ${names.length} 项；多余 ${extra.join(',') || '无'}；缺失 ${missing.join(',') || '无'}`);

  const probe = await call('set_report_js', { path: path.join(TMP, 'x.cpt'), js: 'var a=1;', allowUnsafeScript: true });
  step('未租约的工具真隐藏（报 not found，而非 disabled 占位）',
    probe.isError && /not found/.test(probe.text) && !/disabled/.test(probe.text), probe.text.slice(0, 90));

  // ---------- A. 存量精修链路 ----------
  console.log('\n■ A. 存量模板精修（读 → 改单元格/样式 → 写脚本 → validate → quality_gate）');
  const A = path.join(TMP, '存量.cpt');
  let r = await call('create_cpt', { path: A, title: '存量', rows: 4, columns: 4, webWrite: true });
  step('A1 create_cpt（轻 entry）', !r.isError, r.data?.action ?? r.text.slice(0, 80));
  r = await call('add_dataset', { path: A, name: 'ds1', connection: 'Doris', sql: 'SELECT 项目, 金额 FROM t' });
  step('A2 add_dataset（静态表内）', !r.isError, r.data?.action ?? r.text.slice(0, 80));
  // 2026-11-12 P0-1：add_style 从 report 静态表下沉 style_manage 租约族（能力不掉）
  const styleHidden = await call('add_style', { path: A, fontSizePt: 12 });
  step('A2b add_style 默认隐藏（真隐藏 → not found）', styleHidden.isError, styleHidden.text.slice(0, 80));
  r = await call('request_deep_tool_access', { path: A, group: 'style_manage' });
  step('A2c 租 style_manage 族', r.data?.status === 'granted', `tools=${r.data?.enabledTools?.length}`);
  r = await call('add_style', { path: A, fontName: '微软雅黑', fontSizePt: 14, bold: true, backgroundColor: '#3836B3', foregroundColor: '#FFFFFF', horizontalAlignment: 0 });
  step('A3 add_style（租约后；轻 entry；边框/对齐语义已外移）', !r.isError, `styleIndex=${r.data?.styleIndex}`);
  const styleIndex = r.data?.styleIndex ?? 1;
  r = await call('add_cell', { path: A, column: 0, row: 0, content: '项目', styleIndex });
  step('A4 add_cell 文本格', !r.isError, r.data?.action ?? r.text.slice(0, 80));
  r = await call('add_cell', { path: A, column: 0, row: 1, contentType: 'dsColumn', dsName: 'ds1', columnName: '项目', styleIndex });
  step('A5 add_cell DSColumn 格（扩展父格语义已外移）', !r.isError, r.data?.action ?? r.text.slice(0, 80));
  r = await call('add_cell', { path: A, column: 1, row: 1, contentType: 'dsColumn', dsName: 'ds1', columnName: '金额', styleIndex });
  step('A6 add_cell 第二个 DSColumn 格', !r.isError, r.data?.action ?? r.text.slice(0, 80));

  // 读回核对（读是每个任务的第一步，必须全在静态表里）
  r = await call('get_cells', { path: A });
  step('A7 get_cells 读回（静态表内只读原语）', !r.isError && Array.isArray(r.data?.cells), `cells=${r.data?.cells?.length}`);
  // 2026-11-12 P0-1：单格样式并入 get_cells({includeStyle:true})；模板样式表走读门禁视图
  r = await call('get_cells', { path: A, row: 0, includeStyle: true });
  step('A8a get_cells({includeStyle:true}) 单格样式', !r.isError && r.data?.cells?.every((c) => 'styleDetail' in c), `cells=${r.data?.cells?.length}`);
  r = await call('record_cpt_read_intent', { path: A, views: ['styles'], purpose: '读取模板样式表' });
  step('A8b record_cpt_read_intent', !r.isError && !!r.data?.permitId, `permitId=${r.data?.permitId ? 'ok' : '缺失'}`);
  r = await call('read_cpt_compact', { path: A, permitId: r.data.permitId, view: 'styles' });
  step('A8c read_cpt_compact(view=styles) 读回（替代 get_styles）', !r.isError && (r.data?.total ?? 0) >= 1, `styles=${r.data?.total}`);
  r = await call('get_datasets', { path: A });
  step('A9 get_datasets 读回', !r.isError && Array.isArray(r.data), `datasets=${Array.isArray(r.data) ? r.data.length : '-'}`);

  // 改样式（轻 entry，scope 语义已外移）
  r = await call('update_cell_style', { path: A, column: 0, row: 0, backgroundColor: '#FF9900', bold: true });
  step('A10 update_cell_style（轻 entry；scope=cell 克隆语义已外移）', !r.isError, r.data?.action ?? r.text.slice(0, 80));

  // 脚本：先租 scripting 族，再写
  const noLease = await call('set_report_js', { path: A, js: 'var x = 1;', allowUnsafeScript: true });
  step('A11 未租 scripting 时写脚本失败（真隐藏）', noLease.isError, noLease.text.slice(0, 80));
  r = await call('request_deep_tool_access', { path: A, group: 'scripting' });
  step('A12 租 scripting 族（reason 省略，服务端自填）', r.data?.status === 'granted', `group=${r.data?.group} tools=${r.data?.enabledTools?.length}`);
  r = await call('set_report_js', { path: A, js: 'function hi(){ return "ok"; }', allowUnsafeScript: true });
  step('A13 租约后 set_report_js 成功', !r.isError, r.data?.action ?? r.text.slice(0, 80));
  r = await call('get_report_listener', { path: A, event: 'afterload' });
  step('A14 get_report_listener（读侧常驻静态表）', !r.isError, `count=${r.data?.count}`);
  r = await call('check_report_js', { path: A });
  step('A15 check_report_js 语法检查', !r.isError, `failures=${r.data?.failures?.length ?? 0}`);

  r = await call('validate_cpt', { path: A });
  const errs = (r.data?.issues ?? []).filter((i) => i.severity === 'error');
  step('A16 validate_cpt 无 error', !r.isError && errs.length === 0, `issues=${r.data?.issues?.length} errors=${errs.length}`);
  r = await call('quality_gate_cpt', { path: A });
  step('A17 quality_gate_cpt 结构门槛', !r.isError && r.data?.structuralPass === true,
    `pass=${r.data?.pass} structuralPass=${r.data?.structuralPass} blockers=${r.data?.blockers?.length}`);
  // 2026-11-12 P0-2：门禁摘要 + 结论缓存
  const briefGate = await call('quality_gate_cpt', { path: A, brief: true });
  step('A18a 门禁摘要 brief=true（结论+前5条+计数）',
    !briefGate.isError && briefGate.data?.brief === true && briefGate.data?.pass === true && typeof briefGate.data?.blockersTotal === 'number',
    `bytes=${Buffer.byteLength(JSON.stringify(briefGate.data), 'utf8')} pass=${briefGate.data?.pass} blockersTotal=${briefGate.data?.blockersTotal}`);
  step('A18b 同文件同参重复调用命中缓存（cached=true）',
    briefGate.data?.cached === true && typeof briefGate.data?.cachedAgeSeconds === 'number',
    `cached=${briefGate.data?.cached} age=${briefGate.data?.cachedAgeSeconds}s`);
  const fullGateAgain = await call('quality_gate_cpt', { path: A, brief: false });
  step('A18c brief:false 取完整明细（checklist/advisories 回来）',
    fullGateAgain.isError === false && fullGateAgain.data?.brief === undefined && Array.isArray(fullGateAgain.data?.checklist),
    `checklist=${fullGateAgain.data?.checklist?.length} advisoriesTotal=${fullGateAgain.data?.advisoriesTotal}`);

  // ---------- B. 从零建表 + 填报链路 ----------
  console.log('\n■ B. 从零建填报模板（绑定/工具栏走 fill_binding 租约）');
  const B = path.join(TMP, '填报.cpt');
  r = await call('create_cpt', { path: B, title: '填报', rows: 4, columns: 4, webWrite: true });
  step('B1 create_cpt（填报模板须 webWrite=true）', !r.isError, r.data?.action ?? r.text.slice(0, 80));
  r = await call('add_dataset', { path: B, name: 'ds1', connection: 'Doris', sql: 'SELECT material_code, qty FROM t' });
  step('B2 add_dataset', !r.isError, r.data?.action ?? r.text.slice(0, 80));
  r = await call('request_deep_tool_access', { path: B, group: 'style_manage' });
  step('B2b 租 style_manage 族（add_style 已下沉）', r.data?.status === 'granted', `tools=${r.data?.enabledTools?.length}`);
  r = await call('add_style', { path: B, fontSizePt: 12 });
  step('B3 add_style', !r.isError, `styleIndex=${r.data?.styleIndex}`);
  const s2 = r.data?.styleIndex ?? 1;
  r = await call('add_cell', { path: B, column: 0, row: 1, styleIndex: s2, widget: 'text' });
  step('B4 add_cell 填报控件格（widget 语义已外移）', !r.isError, r.data?.action ?? r.text.slice(0, 80));

  const submitNoLease = await call('add_fill_submit', { path: B, dsName: 'ds1', table: 't', bindings: [{ field: 'material_code', column: 0, row: 1, isKey: true }] });
  step('B5 未租 fill_binding 时建提交失败（真隐藏）', submitNoLease.isError, submitNoLease.text.slice(0, 80));
  r = await call('request_deep_tool_access', { path: B, group: 'auto', tools: ['add_fill_submit'] });
  step('B6 group=auto 判组 → fill_binding（instructions 兜底路径）',
    r.data?.status === 'granted' && r.data?.group === 'fill_binding', `group=${r.data?.group}`);
  r = await call('add_fill_submit', { path: B, dsName: 'ds1', table: 't', bindings: [{ field: 'material_code', column: 0, row: 1, isKey: true }] });
  step('B7 建填报提交', !r.isError, r.data?.action ?? r.text.slice(0, 80));
  r = await call('get_fill_config', { path: B });
  step('B8 get_fill_config 读回（读侧常驻）', !r.isError && (r.data?.submits?.length ?? 0) > 0, `submits=${r.data?.submits?.length}`);
  r = await call('update_fill_binding', { path: B, submitIndex: 0, field: 'material_code', isKey: false });
  step('B9 update_fill_binding 去主键（M101 场景）', !r.isError, r.data?.action ?? r.text.slice(0, 80));
  r = await call('set_fill_toolbar', { path: B, buttons: ['submit', 'verify', 'append-row', 'delete-row'] });
  step('B10 set_fill_toolbar（同族一次解锁即闭环）', !r.isError, r.data?.action ?? r.text.slice(0, 80));
  r = await call('list_toolbar_buttons', { path: B });
  step('B11 list_toolbar_buttons 读回（读侧常驻）', !r.isError && (r.data?.count ?? 0) >= 4, `buttons=${r.data?.count}`);
  r = await call('set_grid', { path: B, rowHeights: [1296000, 1008000], columnWidths: [2743200, 2743200] });
  step('B12 set_grid 行列尺寸', !r.isError, r.data?.action ?? r.text.slice(0, 80));
  r = await call('set_report_settings', { path: B, paper: 'A4', orientation: 1, frozenRow: 1 });
  step('B13 set_report_settings（轻 entry；18 个页面参数已外移）', !r.isError, `paper=${r.data?.paper}`);
  r = await call('validate_cpt', { path: B });
  const errsB = (r.data?.issues ?? []).filter((i) => i.severity === 'error');
  step('B14 validate_cpt 无 error', !r.isError && errsB.length === 0, `issues=${r.data?.issues?.length} errors=${errsB.length}`);
  r = await call('quality_gate_cpt', { path: B });
  step('B15 quality_gate_cpt 结构门槛', !r.isError && r.data?.structuralPass === true,
    `pass=${r.data?.pass} blockers=${r.data?.blockers?.length}`);

  // ---------- C. 轻 entry 的严格校验仍在（错误即文档） ----------
  console.log('\n■ C. 轻 entry 的参数校验与分节下发');
  r = await call('get_capabilities', { tool: 'add_cell', section: 'cell.dictionary' });
  step('C1 分节下发取回外移语义', !r.isError && r.text.includes('widgetDictionary'), `长度 ${r.text.length}`);
  r = await call('add_cell', { path: B, column: 0, row: 2, styleIndex: s2, bogusParam: 1 });
  step('C2 拼错参数 → 字段级报错 + 节引用', r.isError && /参数校验失败/.test(r.text) && /get_capabilities/.test(r.text), r.text.slice(0, 120));
  r = await call('set_report_settings', { path: B, orientation: 9 });
  step('C3 枚举越界 → 字段级报错', r.isError && /orientation/.test(r.text), r.text.slice(0, 100));
  // 2026-11-12 P0-1：build_report 从 report 静态表下沉 generator_full 租约族
  const buildHidden = await call('build_report', { path: path.join(TMP, 'bad.cpt'), spec: { cells: [{ column: -3, row: 0 }] } });
  step('C4a build_report 默认隐藏（真隐藏 → not found）', buildHidden.isError, buildHidden.text.slice(0, 80));
  r = await call('request_deep_tool_access', { path: B, group: 'generator_full' });
  step('C4b 租 generator_full 族', r.data?.status === 'granted', `tools=${r.data?.enabledTools?.length}`);
  r = await call('build_report', { path: path.join(TMP, 'bad.cpt'), spec: { cells: [{ column: -3, row: 0 }] } });
  step('C4c 巨块 spec 仍被完整校验', r.isError && /spec\.cells\.0\.column/.test(r.text), r.text.slice(0, 120));

  // ---------- D. 案卷完整性（真机产物不残留在仓库） ----------
  const kept = fs.readdirSync(TMP).length;
  step('D1 全部产物建在系统临时目录（不污染仓库）', !TMP.includes(path.join(__dirname, '..', 'tmp_test')), `${kept} 个文件于 ${TMP}`);
} finally {
  await client.close();
  fs.rmSync(TMP, { recursive: true, force: true });
}

console.log(failed === 0 ? '\nreport 档端到端：全部通过 ✓' : `\nreport 档端到端：${failed} 项失败 ✗`);
process.exitCode = failed === 0 ? 0 : 1;
