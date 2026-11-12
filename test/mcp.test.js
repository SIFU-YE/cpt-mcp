// cpt-mcp/test/mcp.test.js —— MCP 协议层测试：连接 server.js，枚举工具 + 真实调用工具（zod 参数层）
//
// 说明：整个文件复用**一个** MCP 客户端。每个 test 各自 spawn 一个 server.js 子进程会让
// 本文件从 ~4s 劣化到 ~60s（断言失败时 client.close() 被跳过，残留 stdio 句柄导致
// node 测试进程无法退出，只能等默认 60s 超时兜底）。这里统一在 after() 中关闭。
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { allClassifiedToolNames, annotateFor } from '../lib/contract.js';
import '../scripts/isolate-store.mjs'; // M123：JS 基线 store 隔离，直跑也不污染真实 store

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(__dirname, '..', 'server.js');

let client = null;

before(async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER],
    cwd: path.join(__dirname, '..'),
    // t1 起 server.js 默认 focused；本文件覆盖深层/全量工具，需显式 full。
    env: { CPT_MCP_TOOL_PROFILE: 'full' },
  });
  client = new Client({ name: 'cpt-mcp-test', version: '0.0.1' });
  await client.connect(transport);
});

after(async () => {
  // 无论测试是否失败都必须关闭，否则 stdio 子进程句柄会让 node --test 挂到 60s 超时
  if (client) { try { await client.close(); } catch { /* 已断开则忽略 */ } client = null; }
});

function useTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-mcp-mcptest-'));
}

async function call(tool, args) {
  const res = await client.callTool({ name: tool, arguments: args });
  const text = res.content?.find((c) => c.type === 'text')?.text ?? '';
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  return { res, data };
}

test('MCP server 可连接且暴露全部工具', async () => {
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();

  // 与 lib/contract.js 的归类清单比对（单一事实源），不要再在这里维护第二份列表 ——
  // 每加一个工具就要改一次，迟早漂移（add_cell_hyperlink 就漏过一次）。
  const expected = allClassifiedToolNames().sort();
  assert.deepEqual(names, expected);

  // 顺带校验安全围栏：每个工具的注解必须与契约一致，且没有漏归类/幽灵条目
  const bad = tools.filter((t) => {
    const want = annotateFor(t.name);
    return ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint']
      .some((k) => (t.annotations ?? {})[k] !== want[k]);
  });
  assert.deepEqual(bad.map((t) => t.name), [], '有工具注解与契约不一致');
  // 关键工具参数存在
  const create = tools.find((t) => t.name === 'create_cpt');
  assert.ok(create.inputSchema?.properties?.path, 'create_cpt 应有 path 参数');
  const cell = tools.find((t) => t.name === 'add_cell');
  assert.ok(cell.inputSchema?.properties?.widget, 'add_cell 应有 widget 参数');
  assert.ok(tools.some((t) => t.name === 'get_capabilities'), '应暴露能力清单工具');
});

test('MCP 运行时围栏：能力清单、越界路径和可执行脚本默认拒绝', async () => {
  const capabilities = await call('get_capabilities', {});
  assert.equal(capabilities.res.isError, undefined);
  assert.ok(capabilities.data.supported && capabilities.data.explicitlyUnsupported);
  // 版本移交报表模式：cpt-mcp 不提供 git 工具，能力清单必须声明外部版本提供方
  assert.equal(capabilities.data.versioning?.provider, 'host (optional)'); // 2026-10-26 自包含化：宿主可选
  // 2026-11 提示词对齐：旧名 git_commit_all / git_repo_status 在宿主本地 git 里不存在，
  // 清单只能点名真实存在的本地工具（git_commit 等），并保留「可能不存在」的限定
  const hostGitTools = capabilities.data.versioning?.tools ?? [];
  assert.ok(hostGitTools.includes('git_commit'), '能力清单应点名宿主本地 git 提交工具');
  assert.equal(hostGitTools.includes('git_commit_all'), false, '不应再出现宿主不存在的旧工具名');

  const root = path.parse(process.cwd()).root;
  const outside = path.join(root, 'Windows', 'System32', 'blocked.cpt');
  const blocked = await call('create_cpt', { path: outside });
  assert.equal(blocked.res.isError, true, '越界路径必须在运行时拒绝');

  const tmp = useTmp();
  const cpt = path.join(tmp, 'script.cpt');
  await call('create_cpt', { path: cpt });
  await call('add_cell', { path: cpt, column: 0, row: 0, content: '脚本入口' });
  const script = await call('add_cell_hyperlink', {
    path: cpt, column: 0, row: 0, type: 'script', script: 'alert("blocked");',
  });
  assert.equal(script.res.isError, true, '脚本默认必须拒绝');
  const explicitlyAllowed = await call('add_cell_hyperlink', {
    path: cpt, column: 0, row: 0, type: 'script', script: 'alert("allowed");', allowUnsafeScript: true,
  });
  assert.equal(explicitlyAllowed.res.isError, undefined, '显式确认后脚本能力仍可用');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('MCP 运行时围栏：低层入口与批量更新的脚本旁路已封堵', async () => {
  const tmp = useTmp();
  const cpt = path.join(tmp, 'bypass.cpt');
  await call('create_cpt', { path: cpt, rows: 2, columns: 2, webWrite: true });
  await call('add_cell', { path: cpt, column: 0, row: 0, content: 'x' });

  // update_report_node 直写 <Listener> 无 flag 必须拒绝，有 flag 放行
  const listenerXml = '<Listener event="afterload"><JavaScript class="com.fr.js.JavaScriptImpl"><Parameters/><Content><![CDATA[alert(1)]]></Content></JavaScript></Listener>';
  const blocked = await call('update_report_node', { path: cpt, nodeName: 'Listener', xmlBody: listenerXml });
  assert.equal(blocked.res.isError, true, '低层入口直写脚本容器默认必须拒绝');
  const allowed = await call('update_report_node', { path: cpt, nodeName: 'Listener', xmlBody: listenerXml, allowUnsafeScript: true });
  assert.equal(allowed.res.isError, undefined, '显式确认后低层入口仍可用');
  // 纯结构节点不受影响；非法标签名被 schema 拒绝
  const structural = await call('update_report_node', { path: cpt, nodeName: 'ReportPageAttr', xmlBody: '<X/>' });
  assert.equal(structural.res.isError, undefined, '纯结构节点不应被脚本围栏误伤');
  const badName = await call('update_report_node', { path: cpt, nodeName: 'Foo><Bar', xmlBody: '<X/>' });
  assert.equal(badName.res.isError, true, '非法标签名必须拒绝');
  // nodeName 即脚本容器（TopJS）同样设防
  const topjs = await call('update_report_node', { path: cpt, nodeName: 'TopJS', xmlBody: 'alert(1)' });
  assert.equal(topjs.res.isError, true, 'TopJS 直写默认必须拒绝');

  // batch update.patch.content 与 update_cell 同级设防（plan 阶段即拦）
  const scriptPlan = await call('batch_mutate_cells', {
    path: cpt, mode: 'plan',
    commands: [{ op: 'update', target: { sheet: 0, cells: ['A1'] }, data: { patch: { content: '<script>alert(1)</script>' } } }],
  });
  assert.equal(scriptPlan.res.isError, true, '批量更新写脚本默认必须拒绝');
  const scriptPlanAllowed = await call('batch_mutate_cells', {
    path: cpt, mode: 'plan', allowUnsafeScript: true,
    commands: [{ op: 'update', target: { sheet: 0, cells: ['A1'] }, data: { patch: { content: '<script>alert(1)</script>' } } }],
  });
  assert.equal(scriptPlanAllowed.res.isError, undefined, '显式确认后批量写脚本仍可用');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('MCP add_cell_hyperlink 支持 sheet：成品/特殊表头超链不再 -32602', async () => {
  const tmp = useTmp();
  const cpt = path.join(tmp, 'multi-hyper.cpt');
  await call('create_cpt', { path: cpt, rows: 2, columns: 2 });
  await call('add_sheet', { path: cpt, sheetName: '成品表' });
  await call('add_cell', { path: cpt, column: 0, row: 0, content: 'H', sheet: 1 });
  // 曾经：传 sheet 直接 -32602 拒绝；现在：放行并落在第 2 个 Report 块
  const r = await call('add_cell_hyperlink', {
    path: cpt, column: 0, row: 0, type: 'script', script: 'sortByCol()', sheet: 1, allowUnsafeScript: true,
  });
  assert.equal(r.res.isError, undefined, 'sheet=1 不应再被拒绝');
  const back = await call('get_cell_hyperlink', { path: cpt, column: 0, row: 0, sheet: 1 });
  assert.equal(back.res.isError, undefined);
  assert.ok(JSON.stringify(back.data ?? back.res).includes('sortByCol'), '第 2 个表读回超链');
  const back0 = await call('get_cell_hyperlink', { path: cpt, column: 0, row: 0, sheet: 0 });
  assert.ok(!JSON.stringify(back0.data ?? back0.res).includes('sortByCol'), '第 1 个表不被污染');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('MCP build_report：顶层 noOverwrite 安全开关真正传入构建器', async () => {
  const tmp = useTmp();
  const cpt = path.join(tmp, 'no-overwrite.cpt');
  await call('create_cpt', { path: cpt });
  const r = await call('build_report', {
    path: cpt,
    noOverwrite: true,
    spec: { rows: 1, columns: 1 },
  });
  assert.equal(r.res.isError, true, '已有模板且 noOverwrite=true 必须拒绝覆盖');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('MCP 工具真实调用：create→add→validate→read 全链路（zod 参数层）', async () => {
  const tmp = useTmp();
  const cpt = path.join(tmp, 'mcp测试.cpt');

  // 1. create_cpt
  let r = await call('create_cpt', { path: cpt, title: 'MCP测试', rows: 2, columns: 3, webWrite: true });
  assert.equal(r.res.isError, undefined, `create_cpt 不应报错: ${JSON.stringify(r.data)}`);
  assert.equal(r.data.action, 'create_cpt');

  // 2. add_dataset（含数据集参数）
  r = await call('add_dataset', {
    path: cpt, name: 'ds1', connection: 'Doris',
    sql: "SELECT a FROM t WHERE x = '${p}'",
    parameters: [{ name: 'p', defaultValue: 'v' }],
  });
  assert.equal(r.data.action, 'add_dataset');

  // 3. add_cell（文本 + 控件）
  r = await call('add_cell', { path: cpt, column: 0, row: 0, content: '字段', styleIndex: 0 });
  assert.equal(r.data.action, 'add_cell');
  r = await call('add_cell', { path: cpt, column: 0, row: 1, widget: 'text' });
  assert.equal(r.data.widget, 'text');

  // 4. add_fill_submit + 常量绑定（zod 新加的 constant 参数）
  r = await call('add_fill_submit', {
    path: cpt, dsName: 'Doris', table: 't',
    bindings: [{ field: 'f1', column: 0, row: 1 }, { field: 'fixed', constant: 'ABC' }],
  });
  assert.equal(r.data.submitIndex, 0);

  // 5. validate_cpt：无 error
  r = await call('validate_cpt', { path: cpt });
  assert.equal(r.data.summary.error, 0, `validate 不应有 error: ${JSON.stringify(r.data.issues?.filter((i) => i.severity === 'error'))}`);

  // 6. read_cpt 概览
  r = await call('read_cpt', { path: cpt });
  assert.equal(r.data.datasets, 1);
  assert.equal(r.data.cellCount, 2);
  assert.equal(r.data.fillSubmits, 1);

  // 7. get_fill_config 确认常量绑定
  r = await call('get_fill_config', { path: cpt });
  const cols = r.data.submits[0].columns;
  assert.equal(cols.length, 2);
  assert.equal(cols.find((c) => c.field === 'fixed').constant, 'ABC');

  fs.rmSync(tmp, { recursive: true, force: true });
});

test('MCP zod 参数校验：非法参数应返回 isError', async () => {
  const tmp = useTmp();
  const cpt = path.join(tmp, 'x.cpt');
  // 先建一个合法文件
  await call('create_cpt', { path: cpt });
  // 非法：add_cell 负坐标 → zod 拦截 → isError
  const r = await call('add_cell', { path: cpt, column: -1, row: 0 });
  assert.equal(r.res.isError, true, '负坐标应被 zod 拒绝');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('引擎工具真实调用：style_review / reasonableness_review / build_report（含非法 spec 拒绝）', async () => {
  const tmp = useTmp();
  const cpt = path.join(tmp, 'engine.cpt');
  await call('create_cpt', { path: cpt, title: 'engine', rows: 2, columns: 2, webWrite: true });

  // 1. style_review_cpt
  let r = await call('style_review_cpt', { path: cpt });
  assert.equal(r.res.isError, undefined, `style_review_cpt 不应报错: ${JSON.stringify(r.data)}`);
  assert.ok(Array.isArray(r.data.issues), 'style_review_cpt 应返回 issues 数组');

  // 2. reasonableness_review_cpt
  r = await call('reasonableness_review_cpt', { path: cpt });
  assert.equal(r.res.isError, undefined);
  assert.ok(Array.isArray(r.data.issues), 'reasonableness_review_cpt 应返回 issues 数组');

  // 3. build_report：生成 + 三层自检
  r = await call('build_report', {
    path: path.join(tmp, 'b.cpt'),
    spec: { title: 'B', rows: 2, columns: 2, check: true,
      cells: [{ column: 0, row: 0, content: '标题', styleIndex: 0 }],
      fill: { table: 't1', bindings: [{ field: 'f1', column: 0, row: 0, isKey: true }] } },
  });
  assert.equal(r.res.isError, undefined, `build_report 不应报错: ${JSON.stringify(r.data)}`);
  assert.ok(r.data.checkResult, 'build_report 应返回 checkResult');
  assert.equal(typeof r.data.checkResult.hasError, 'boolean');

  // 4. build_report：非法 spec（负坐标）被 zod 拒绝
  r = await call('build_report', { path: path.join(tmp, 'x.cpt'), spec: { cells: [{ column: -1, row: 0 }] } });
  assert.equal(r.res.isError, true, 'build_report 非法 spec 应被 zod 拒绝');
  assert.match(JSON.stringify(r.data), /column|row/i, '拒绝信息应含坐标相关描述或原始错误');

  fs.rmSync(tmp, { recursive: true, force: true });
});

test('generate_report 真实调用：字段+数据源直达可用报表（0 error / 0 warning）', async () => {
  const tmp = useTmp();
  const cpt = path.join(tmp, 'smart.cpt');

  const r = await call('generate_report', {
    path: cpt,
    title: '销售明细表',
    source: { connection: 'Doris', table: 't_sales' },
    fields: [
      { name: 'region', label: '区域', type: 'text' },
      { name: 'salesman', label: '业务员', type: 'text' },
      { name: 'qty', label: '数量', type: 'number', summary: 'sum' },
      { name: 'amount', label: '金额', type: 'money', summary: true },
      { name: 'order_date', label: '下单日期', type: 'date' },
    ],
    theme: 'blue',
  });

  assert.equal(r.res.isError, undefined, `generate_report 不应报错: ${JSON.stringify(r.data)}`);
  assert.ok(r.data.path?.endsWith('smart.cpt'), '应返回生成文件路径');
  assert.ok(r.data.checkResult, 'generate_report 应返回 checkResult');
  assert.equal(r.data.checkResult.hasError, false,
    `生成结果不应有 error: ${JSON.stringify(r.data.checkResult.errors ?? r.data.checkResult)}`);

  // 父格自动推导：5 个字段 → 1 个主扩展格 + 4 个跟随格
  assert.ok(r.data.autoExpand, '应返回 autoExpand 推导结果');
  assert.equal(r.data.autoExpand.count, 5, '5 个数据列都应参与扩展');
  assert.equal(r.data.autoExpand.mainCells.length, 1, '应有 1 个主扩展格');
  assert.equal(r.data.autoExpand.applied.length, 4, '其余 4 列应为跟随格（补 leftParent）');
  assert.match(r.data.autoExpand.applied[0].expand.leftParent, /^A\d+$/,
    '跟随格的 leftParent 应指向主扩展格（A 列）');

  // SQL 自动生成
  assert.ok(r.data.summary, '应返回 summary');
  assert.match(r.data.summary.sql, /select/i, '应自动生成 SQL');
  assert.match(r.data.summary.sql, /t_sales/, 'SQL 应包含表名');
  assert.equal(r.data.summary.fields, 5, 'summary 应记录字段数');

  fs.rmSync(tmp, { recursive: true, force: true });
});
