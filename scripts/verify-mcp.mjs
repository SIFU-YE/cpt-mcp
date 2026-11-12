// cpt-mcp/scripts/verify-mcp.mjs —— MCP 可用性端到端验证
// 通过 MCP 协议（Client → StdioClientTransport）连接 server.js，实际调用工具完成：
//   listTools → create_cpt → add_dataset → add_parameter → add_style → add_cell → add_fill_submit
//   → set_report_settings → validate_cpt → read_cpt → get_fill_config
// 输出每一步结果；退出码 0=全部通过，1=失败。
// 运行：node scripts/verify-mcp.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
// 与 server.js 共用同一份围栏契约，直接对「真实 listTools 结果」做全量断言。
// server.js 顶层就启动了 stdio transport，不能 import，所以清单抽到了 lib/contract.js。
import {
  CPT_MCP_INSTRUCTIONS, annotateFor, allClassifiedToolNames,
} from '../lib/contract.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(__dirname, '..', 'server.js');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-mcp-verify-'));
const CPT = path.join(TMP, '验证模板.cpt');

let failed = 0;
// get_build_progress 的 9 个基础工序（与 lib/quality.js buildProgress 的相位表对应）。
// 新增工序时在此追加即可；断言"齐备"而非"等于某个数"。
const BASE_PHASES = ['数据集', '样式', '单元格与扩展', '网格（行高列宽）', '页面设置', '参数面板', '填报', '质量门槛', '真实引擎校验'];
const step = (name, ok, detail = '') => {
  console.log(`${ok ? '✔' : '✖'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed += 1;
};
const call = async (client, tool, args) => {
  const res = await client.callTool({ name: tool, arguments: args });
  const text = res.content?.find((c) => c.type === 'text')?.text ?? '';
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  return { res, text, data };
};

const transport = new StdioClientTransport({ command: process.execPath, args: [SERVER], cwd: path.join(__dirname, '..'),
  // t1 起 server.js 默认 focused；端到端验证覆盖全量工具，需显式 full。
  env: { CPT_MCP_TOOL_PROFILE: 'full' } });
const client = new Client({ name: 'cpt-mcp-verify', version: '1.0.0' });

try {
  await client.connect(transport);
  step('MCP 连接', true, 'initialize 握手成功');

  // 0. 安全围栏：server 级 instructions 必须存在（模型动手前读到的第一份契约）
  const instr = client.getInstructions?.() ?? '';
  step('安全围栏·instructions', typeof instr === 'string' && instr.length > 200, `${instr.length} 字符`);
  step('  instructions 与 lib/contract.js 一致', instr === CPT_MCP_INSTRUCTIONS,
    instr === CPT_MCP_INSTRUCTIONS ? '单一事实源未漂移' : 'server 侧与契约模块内容不一致');
  for (const kw of ['适用边界', '推荐工作流', '铁律', 'build_report', 'generate_report', 'get_capabilities']) {
    step(`  instructions 含「${kw}」`, instr.includes(kw));
  }

  // 1. 工具枚举（数量随迭代增长，故用下限断言，避免每次加工具都改脚本）
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name);
  step('listTools 枚举', names.length >= 53, `${names.length} 个工具`);

  // 1b. 安全围栏：全量断言每个工具的注解都与 lib/contract.js 声明的语义一致
  const noAnno = tools.filter((t) => !t.annotations);
  step('安全围栏·注解覆盖率', noAnno.length === 0,
    noAnno.length ? `缺注解: ${noAnno.map((t) => t.name).join(',')}` : `${tools.length}/${tools.length} 全部带注解`);

  // 逐个工具与 annotateFor(name) 的期望值做深比较 —— 加新工具却漏标注会在这里失败
  const annoMismatch = tools.filter((t) => {
    const want = annotateFor(t.name);
    const got = t.annotations ?? {};
    return ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint']
      .some((k) => got[k] !== want[k]);
  });
  step(`安全围栏·注解逐个比对（${tools.length}/${tools.length} 全量）`, annoMismatch.length === 0,
    annoMismatch.length
      ? `与契约不符: ${annoMismatch.map((t) => t.name).join(',')}`
      : `${tools.length}/${tools.length} 注解与 lib/contract.js 完全一致`);

  // 清单里写了但 server 没注册 —— 典型漂移（工具改名/删除后清单没同步）
  const allSets = allClassifiedToolNames();
  const dup = allSets.filter((n, i) => allSets.indexOf(n) !== i);
  step('安全围栏·清单无重复归类', dup.length === 0,
    dup.length ? `同一工具被归到多个类别: ${[...new Set(dup)].join(',')}` : '各分类互斥');

  const phantom = allSets.filter((n) => !names.includes(n));
  step('安全围栏·清单无幽灵条目', phantom.length === 0,
    phantom.length ? `清单里有但 server 未注册: ${phantom.join(',')}` : `${allSets.length} 条清单条目全部存在`);

  // 反向漂移：server 注册了但清单里一个都没有（会落到默认分支，注解仍安全，但应显式归类）
  const unclassified = names.filter((n) => !allSets.includes(n));
  step('安全围栏·无未归类工具', unclassified.length === 0,
    unclassified.length ? `未归类（走默认注解）: ${unclassified.join(',')}` : `${names.length} 个工具全部显式归类`);

  const expectedOpenWorld = tools.filter((t) => annotateFor(t.name).openWorldHint === true).map((t) => t.name);
  const actualOpenWorld = tools.filter((t) => t.annotations?.openWorldHint === true).map((t) => t.name);
  step('安全围栏·openWorld 标记', JSON.stringify(actualOpenWorld.sort()) === JSON.stringify(expectedOpenWorld.sort()),
    `开放世界工具: ${actualOpenWorld.join(',') || '无'}`);
  const required = ['get_capabilities', 'create_cpt', 'add_dataset', 'add_style', 'add_cell', 'add_fill_submit',
    'set_report_settings', 'set_parameter_panel', 'set_grid', 'get_styles', 'get_page_settings',
    'read_cpt', 'get_datasets', 'get_parameters', 'get_cells', 'get_fill_config', 'validate_cpt',
    'style_review_cpt', 'reasonableness_review_cpt', 'build_report'];
  const missing = required.filter((r) => !names.includes(r));
  step('关键工具齐全', missing.length === 0, missing.length ? `缺: ${missing.join(',')}` : `${required.length} 个关键工具全部就位`);

  const capabilities = await call(client, 'get_capabilities', {});
  step('get_capabilities', !capabilities.res.isError && capabilities.data?.toolClasses && capabilities.data?.explicitlyUnsupported,
    '能力清单可被模型直接读取');

  // 2. create_cpt 生成骨架
  let r = await call(client, 'create_cpt', { path: CPT, title: 'MCP验证模板', rows: 4, columns: 6, webWrite: true });
  step('create_cpt', r.data?.action === 'create_cpt' && !r.res.isError, `bytes=${r.data?.bytes}`);

  // 3. add_dataset 数据集
  r = await call(client, 'add_dataset', {
    path: CPT, name: 'ds1', connection: 'Doris',
    sql: "SELECT sku_code FROM sales_basics_finally WHERE platform_name = '${platform}'",
    parameters: [{ name: 'platform', defaultValue: '天猫' }],
  });
  step('add_dataset', r.data?.action === 'add_dataset' && !r.res.isError, `name=${r.data?.name}`);

  // 4. add_style 样式（返回索引 1）
  r = await call(client, 'add_style', { path: CPT, fontSizePt: 12, bold: true, backgroundColor: '#D9E1F2' });
  step('add_style', r.data?.styleIndex === 1, `styleIndex=${r.data?.styleIndex}`);

  // 5. add_cell 文本 + 控件
  r = await call(client, 'add_cell', { path: CPT, column: 0, row: 0, content: '商品编码', styleIndex: 1 });
  step('add_cell(文本)', r.data?.action === 'add_cell' && !r.res.isError, `cell=${r.data?.cell}`);
  r = await call(client, 'add_cell', { path: CPT, column: 0, row: 1, widget: 'text', styleIndex: 1 });
  step('add_cell(控件)', r.data?.widget === 'text' && !r.res.isError, `widget=${r.data?.widget}`);
  r = await call(client, 'add_cell', { path: CPT, column: 1, row: 1, widget: 'submit', styleIndex: 1 });
  step('add_cell(提交按钮)', r.data?.widget === 'submit' && !r.res.isError, `widget=${r.data?.widget}`);

  // 5b. 填报行完整性（t2 补）：本脚本的验证模板是带 SubmitVisitor 的填报模板，数据行控件格必须带
  // insertPolicy=copy，否则 validate_cpt 的「填报行完整性」维度会（正确地）报 warning，
  // 使下面「validate_cpt warning===0」断言失败 —— 补齐写入口是最小合规改动，不是放宽校验。
  r = await call(client, 'update_cell', { path: CPT, column: 0, row: 1, insertPolicy: 'copy' });
  step('update_cell(insertPolicy)', r.data?.insertPolicy === 'copy' && !r.res.isError, `mode=${r.data?.mode}`);

  // 6. add_fill_submit 提交
  r = await call(client, 'add_fill_submit', {
    path: CPT, dsName: 'Doris', table: 'fill_record',
    bindings: [{ field: 'sku_code', column: 0, row: 1 }],
  });
  step('add_fill_submit', r.data?.submitIndex === 0 && !r.res.isError, `table=${r.data?.table}`);

  // 7. set_report_settings 页面
  r = await call(client, 'set_report_settings', { path: CPT, paper: 'A4', orientation: 1, isHorizontalCenterOnPage: true });
  step('set_report_settings', r.data?.action === 'set_report_settings' && !r.res.isError, `paper=${r.data?.paper}`);

  // 8. validate_cpt 校验（关键：MCP 输出应 0 error / 0 warning；info 为弱校验提示可存在）
  r = await call(client, 'validate_cpt', { path: CPT });
  const summary = r.data?.summary;
  step('validate_cpt', !r.res.isError && summary?.error === 0 && summary?.warning === 0,
    `error=${summary?.error} warning=${summary?.warning} info=${summary?.info}`);

  // 9. read_cpt 读取概览
  r = await call(client, 'read_cpt', { path: CPT });
  step('read_cpt', r.data?.datasets === 1 && !r.res.isError, `datasets=${r.data?.datasets} cells=${r.data?.cellCount} submits=${r.data?.fillSubmits}`);

  // 10. get_fill_config 读取填报
  r = await call(client, 'get_fill_config', { path: CPT });
  step('get_fill_config', r.data?.submits?.length === 1 && !r.res.isError, `submits=${r.data?.submits?.length} columns=${r.data?.submits?.[0]?.columns?.length}`);

  // 11. get_styles 读取样式
  r = await call(client, 'get_styles', { path: CPT });
  step('get_styles', r.data?.styles?.length === 2 && !r.res.isError, `${r.data?.styles?.length} 个样式`);

  // 12. 引擎工具：style_review_cpt
  r = await call(client, 'style_review_cpt', { path: CPT });
  step('style_review_cpt', !r.res.isError && Array.isArray(r.data?.issues), `issues=${r.data?.count}`);

  // 13. 引擎工具：reasonableness_review_cpt
  r = await call(client, 'reasonableness_review_cpt', { path: CPT });
  step('reasonableness_review_cpt', !r.res.isError && Array.isArray(r.data?.issues), `issues=${r.data?.count}`);

  // 14. build_report：语义化构建 + 三层自检
  const BP = path.join(TMP, '引擎构建.cpt');
  r = await call(client, 'build_report', {
    path: BP,
    spec: { title: '引擎验证', rows: 2, columns: 2, check: true,
      cells: [{ column: 0, row: 0, content: '标题', styleIndex: 0 }],
      fill: { table: 't1', bindings: [{ field: 'f1', column: 0, row: 0, isKey: true }] },
      settings: { paper: 'A4' } },
  });
  step('build_report(生成+自检)', !r.res.isError && !!r.data?.checkResult, `hasError=${r.data?.checkResult?.hasError}`);

  // 15. build_report：非法 spec（负坐标）被 zod 参数层拒绝
  r = await call(client, 'build_report', { path: path.join(TMP, 'x.cpt'), spec: { cells: [{ column: -1, row: 0 }] } });
  step('build_report(非法 spec 被拒)', r.res.isError === true, `isError=${JSON.stringify(r.res.isError)}`);

  // 8. generate_report：旗舰路径「字段 + 数据源 → 可用报表」
  const smartPath = path.join(TMP, '智能报表.cpt');
  r = await call(client, 'generate_report', {
    path: smartPath,
    title: '门店销售汇总',
    source: { connection: 'Doris', table: 'sales_basics_finally' },
    fields: [
      { name: 'platform_name', label: '平台', type: 'text' },
      { name: 'sku_code', label: 'SKU', type: 'text' },
      { name: 'qty', label: '销量', type: 'number', summary: 'sum' },
      { name: 'amount', label: '销售额', type: 'money', summary: true },
      { name: 'stat_date', label: '统计日期', type: 'date' },
    ],
    theme: 'blue',
  });
  step('generate_report(字段+数据源)', r.res.isError !== true, `isError=${JSON.stringify(r.res.isError)}`);
  step('  generate_report 自检无 error', r.data?.checkResult?.hasError === false,
    `hasError=${JSON.stringify(r.data?.checkResult?.hasError)}`);
  step('  generate_report 自动推导父格', r.data?.autoExpand?.count === 5,
    `主扩展格=${r.data?.autoExpand?.mainCells?.map((m) => m.cell).join(',') || '-'} 跟随格=${r.data?.autoExpand?.applied?.length ?? 0}`);
  step('  generate_report 自动生成 SQL', /select/i.test(r.data?.summary?.sql || ''),
    r.data?.summary?.sql || '(无)');
  step('  generate_report 产出可读文件', fs.existsSync(smartPath) && fs.statSync(smartPath).size > 1000,
    `${fs.existsSync(smartPath) ? fs.statSync(smartPath).size : 0} bytes`);

  // summary:true 必须被归一化成 sum，而不是拼出 =true(A3)
  const sumCells = await call(client, 'get_cells', { path: smartPath, row: 3 });
  const sumContents = (sumCells.data?.cells ?? sumCells.data ?? []).map((c) => c.contentText ?? '').join(' ');
  step('  summary:true 归一化为 sum 公式', /sum\(/.test(sumContents) && !/true\(/.test(sumContents),
    sumContents.trim().slice(0, 80) || '(无汇总行)');

  // 9. 页眉页脚：骨架自带空 Header/Footer，页码预设与官方样本一致
  r = await call(client, 'set_page_header_footer', {
    path: smartPath,
    header: { left: '机密' },
    footer: { center: { preset: 'pageNumber' } },
  });
  step('set_page_header_footer', r.res.isError !== true && r.data?.action === 'set_page_header_footer',
    `isError=${JSON.stringify(r.res.isError)}`);
  const hfXml = fs.readFileSync(smartPath, 'utf8');
  const footerSeg = hfXml.slice(hfXml.indexOf('<Footer '), hfXml.indexOf('</Footer>'));
  step('  页码公式与官方样本一致',
    footerSeg.includes('&quot;第&quot; + $$page_number + &quot;页/共&quot; + $$totalPage_number + &quot;页&quot;'),
    'content 属性逐字符比对 demo/basic/档案式报表.cpt 原文');
  step('  页眉纯文本自动转公式字面量', hfXml.includes('content="&quot;机密&quot;"'));
  step('  页眉页脚后仍通过校验', (await call(client, 'validate_cpt', { path: smartPath })).data?.summary?.error === 0);

  // 10. 条件属性进阶：条件改值 / 比较条件 / 多条件组合（官方 HighlightAction 用量 TOP1 是 ValueHighlightAction 812 次）
  const hlPath = path.join(TMP, 'hl.cpt');
  await call(client, 'create_cpt', { path: hlPath, rows: 4, columns: 3 });
  await call(client, 'add_cell', { path: hlPath, column: 0, row: 0, content: '金额' });
  await call(client, 'add_cell', { path: hlPath, column: 1, row: 0, content: '状态' });

  // 10a. 条件改值
  r = await call(client, 'add_cell_highlight', {
    path: hlPath, column: 1, row: 0,
    formula: '$$$ > 1000', value: '大额',
  });
  step('add_cell_highlight(条件改值)', r.res.isError !== true && r.data?.effects?.includes('value'),
    `effects=${JSON.stringify(r.data?.effects)}`);
  step('  ValueHighlightAction 写法与官方一致',
    fs.readFileSync(hlPath, 'utf8')
      .includes('<O t="XMLable" class="com.fr.base.Formula">'),
    't="XMLable" class="com.fr.base.Formula"（官方 596/643）');

  // 10b. 比较条件（Compare.op 取自官方常量 com.fr.data.core.Compare）
  r = await call(client, 'add_cell_highlight', {
    path: hlPath, column: 0, row: 0,
    compare: { op: 'lt', value: 0 }, fontColor: '#FF0000',
  });
  step('add_cell_highlight(比较条件)', r.res.isError !== true && r.data?.condition === 'compare:lt',
    `condition=${r.data?.condition}`);
  step('  Compare op=4 对应 LESS_THAN',
    fs.readFileSync(hlPath, 'utf8').includes('<Compare op="4">'),
    'op=4 来自 javap -constants com.fr.data.core.Compare，且样本里配对值几乎全是 0');

  // 10c. 多条件组合
  r = await call(client, 'add_cell_highlight', {
    path: hlPath, column: 1, row: 0,
    conditions: [{ formula: '$$$ < 0' }, { compare: { op: 'contains', value: '异常' } }],
    logic: 'or', bold: true, fontSizePt: 14,
  });
  step('add_cell_highlight(多条件 OR 组合)', r.res.isError !== true && r.data?.condition === 'list:or(2)',
    `condition=${r.data?.condition}`);
  const hlXml = fs.readFileSync(hlPath, 'utf8');
  step('  ListCondition 嵌套 JoinCondition',
    hlXml.includes('<Condition class="com.fr.data.condition.ListCondition">')
    && (hlXml.match(/<JoinCondition join="1">/g) || []).length === 2
    && hlXml.includes('<FRFont name="微软雅黑" style="1" size="56"/>'),
    'join=1(or) ×2 + 条件加粗 FRFont(14pt → size=56)');

  // 10d. 安全围栏：条件三选一互斥
  r = await call(client, 'add_cell_highlight', {
    path: hlPath, column: 0, row: 0,
    formula: '$$$ < 0', compare: { op: 'lt', value: 0 }, background: '#FFFFFF',
  });
  step('安全围栏·条件三选一互斥被拒', r.res.isError === true,
    `isError=${JSON.stringify(r.res.isError)}`);
  r = await call(client, 'add_cell_highlight', {
    path: hlPath, column: 0, row: 0, compare: { op: 'between', value: 1 }, fontColor: '#FF0000',
  });
  step('安全围栏·非法比较运算符被拒', r.res.isError === true,
    `isError=${JSON.stringify(r.res.isError)}`);
  step('  条件属性改动后仍通过校验',
    (await call(client, 'validate_cpt', { path: hlPath })).data?.summary?.error === 0);

  // 11. 超级链接：跳转报表 + 传参（官方 ReportletHyperlink 110 例，做下钻报表的核心）
  const linkPath = path.join(TMP, 'link.cpt');
  await call(client, 'create_cpt', { path: linkPath, rows: 4, columns: 3 });
  await call(client, 'add_cell', { path: linkPath, column: 0, row: 1, content: '订单号' });
  await call(client, 'add_cell', { path: linkPath, column: 1, row: 1, content: '详情' });

  r = await call(client, 'add_cell_hyperlink', {
    path: linkPath, column: 1, row: 1, type: 'reportlet',
    reportletPath: '/demo/basic/产品明细.cpt',
    params: { 订单号: '=A2' },
  });
  step('add_cell_hyperlink(跳转报表+传参)', r.res.isError !== true && r.data?.type === 'reportlet',
    `type=${r.data?.type} paramCount=${r.data?.paramCount}`);
  const linkXml = fs.readFileSync(linkPath, 'utf8');
  step('  ReportletHyperlink 双层标签 + 参数公式',
    (linkXml.match(/<JavaScript class="com\.fr\.js\.ReportletHyperlink">/g) || []).length === 2
    && linkXml.includes('<O t="XMLable" class="com.fr.base.Formula">')
    && linkXml.includes('<ReportletName showPI="true">'),
    '双层写法取自官方 122 例一致形态');

  // 11b. 自定义脚本（JavaScriptImpl 单层，官方 555 例）
  r = await call(client, 'add_cell_hyperlink', {
    path: linkPath, column: 0, row: 1, type: 'script', script: 'alert("ok");', allowUnsafeScript: true,
  });
  step('add_cell_hyperlink(自定义脚本)', r.res.isError !== true && r.data?.type === 'script');

  // 挂载顺序：先加高亮、再加链接，链接必须落在 HighlightList 之前
  await call(client, 'add_cell_highlight', {
    path: linkPath, column: 1, row: 1, formula: '$$$ < 0', fontColor: '#FF0000',
  });
  const linkXml2 = fs.readFileSync(linkPath, 'utf8');
  step('  链接挂在 HighlightList 之前、PrivilegeControl 之后',
    linkXml2.indexOf('<PrivilegeControl/>') < linkXml2.indexOf('<NameJavaScriptGroup>')
    && linkXml2.indexOf('<NameJavaScriptGroup>') < linkXml2.indexOf('<HighlightList>'),
    '官方 136 例：NameJS 在 HighlightList 之前');
  step('  JavaScriptImpl 单层 + Content',
    (linkXml2.match(/<JavaScript class="com\.fr\.js\.JavaScriptImpl">/g) || []).length === 1
    && linkXml2.includes('<Content>'));

  r = await call(client, 'add_cell_hyperlink', {
    path: linkPath, column: 0, row: 1, type: 'url', target: '_new',
  });
  step('安全围栏·非法 target 被拒', r.res.isError === true,
    `isError=${JSON.stringify(r.res.isError)}`);
  step('  超级链接改动后仍通过校验',
    (await call(client, 'validate_cpt', { path: linkPath })).data?.summary?.error === 0);

  // 12. 模板主题（TemplateThemeAttrMark：官方 301 例，只有 5 个名字）
  const themePath = path.join(TMP, 'theme.cpt');
  await call(client, 'create_cpt', { path: themePath, rows: 4, columns: 3 });

  r = await call(client, 'set_template_theme', { path: themePath, theme: '清爽科技' });
  step('set_template_theme(清爽科技)', r.res.isError !== true && r.data?.theme === '清爽科技',
    `theme=${r.data?.theme}`);
  const themeXml = fs.readFileSync(themePath, 'utf8');
  step('  ThemeMark 紧跟 PreviewType 且 dark=false',
    themeXml.includes('<TemplateThemeAttrMark name="清爽科技" dark="false"/>')
    && themeXml.indexOf('<PreviewType') < themeXml.indexOf('<TemplateThemeAttrMark'),
    '官方 271/301 紧跟 <PreviewType>；dark 301 例全为 false');

  // 12b. 幂等：换个主题名，块不叠加
  await call(client, 'set_template_theme', { path: themePath, theme: '经典深灰' });
  const themeXml2 = fs.readFileSync(themePath, 'utf8');
  step('  幂等·重设主题不叠加',
    (themeXml2.match(/<TemplateThemeAttrMark name=/g) || []).length === 1
    && themeXml2.includes('name="经典深灰"'),
    `name= 出现 ${(themeXml2.match(/<TemplateThemeAttrMark name=/g) || []).length} 次`);

  r = await call(client, 'set_template_theme', { path: themePath, theme: '暗夜黑' });
  step('安全围栏·非官方主题名被拒', r.res.isError === true,
    `isError=${JSON.stringify(r.res.isError)}`);

  // 12c. 内置数据集必须被「明确拒绝」而不是静默生成（RowData 是 FR 私有压缩编码）
  r = await call(client, 'add_dataset', {
    path: themePath, name: 'ds_embedded', embedded: true, connection: 'Doris', sql: 'select 1',
  });
  step('安全围栏·内置数据集被明确拒绝', r.res.isError === true,
    `isError=${JSON.stringify(r.res.isError)}`);
  step('  拒绝信息给出替代方案',
    typeof r.text === 'string' && r.text.includes('替代方案'),
    '避免模型转而盲写 RowData 产出打不开的模板');

  // 13. Excel 文件数据集（ExcelTableData：官方 3 例，不连数据库也能出报表）
  const fdsPath = path.join(TMP, 'filedata.cpt');
  await call(client, 'create_cpt', { path: fdsPath, rows: 4, columns: 3 });

  r = await call(client, 'add_file_dataset', {
    path: fdsPath, name: 'File1', dataFile: 'reportlets/jsc/铜山/2.xls',
  });
  step('add_file_dataset(Excel 文件数据集)', r.res.isError !== true && r.data?.action === 'add_file_dataset',
    `name=${r.data?.name}`);
  const fdsXml = fs.readFileSync(fdsPath, 'utf8');
  step('  结构与官方 3 例逐字符一致',
    fdsXml.includes('<TableData name="File1" class="com.fr.data.impl.ExcelTableData">')
    && fdsXml.includes('<ExcelTableDataAttr needColumnName="true" isFromEnv="true" filePath="reportlets/jsc/铜山/2.xls"/>')
    && fdsXml.includes('<Parameters/>'));

  // 13b. 绝对路径口径
  r = await call(client, 'add_file_dataset', {
    path: fdsPath, name: 'File2', dataFile: path.join(TMP, '销售.xlsx'), fromEnv: false,
  });
  step('  fromEnv=false 收绝对路径', r.res.isError !== true
    && fs.readFileSync(fdsPath, 'utf8').includes('isFromEnv="false"'));

  r = await call(client, 'add_file_dataset', {
    path: fdsPath, name: 'File3', dataFile: 'reportlets/a.csv',
  });
  step('安全围栏·CSV 被明确拒绝（官方零实例，元素名只能猜）', r.res.isError === true,
    `isError=${JSON.stringify(r.res.isError)}`);
  r = await call(client, 'add_file_dataset', {
    path: fdsPath, name: 'File3', dataFile: path.resolve(os.tmpdir(), 'a.xlsx'), fromEnv: true,
  });
  step('安全围栏·fromEnv 口径不匹配被拒', r.res.isError === true);

  // 14. 树数据集（RecursionTableData：官方 19 例，组织架构/省市区/BOM 层级）
  r = await call(client, 'add_tree_dataset', {
    path: fdsPath, name: 'Tree1', source: 'File1', childField: 0, parentField: 1,
    childFieldName: '部门ID', parentFieldName: '上级部门ID',
  });
  step('add_tree_dataset(层级数据集)', r.res.isError !== true && r.data?.action === 'add_tree_dataset',
    `childField=${r.data?.childField} parentField=${r.data?.parentField}`);
  const treeXml = fs.readFileSync(fdsPath, 'utf8');
  const ti = treeXml.indexOf('<TableData name="Tree1"');
  const tBlk = treeXml.slice(ti, treeXml.indexOf('</TableData>', ti));
  step('  元素顺序与 CDATA 取自官方样本',
    ['markFields', 'parentmarkFields', 'markFieldsName', 'parentmarkFieldsName', 'originalTableDataName']
      .map((t) => tBlk.indexOf(`<${t}>`))
      .every((at, i, arr) => at !== -1 && (i === 0 || at > arr[i - 1]))
    && /<markFields>\s*<!\[CDATA\[0\]\]><\/markFields>/.test(tBlk),
    'markFields → parentmarkFields → markFieldsName → parentmarkFieldsName → originalTableDataName');

  r = await call(client, 'add_tree_dataset', {
    path: fdsPath, name: 'T2', source: 'File1', childField: 1, parentField: 1,
  });
  step('安全围栏·父子同一列被拒', r.res.isError === true);
  await call(client, 'add_file_dataset', { path: fdsPath, name: 'dup', dataFile: 'reportlets/a.xlsx' });
  r = await call(client, 'add_tree_dataset', {
    path: fdsPath, name: 'dup', source: 'File1', childField: 0, parentField: 1,
  });
  step('安全围栏·数据集重名被拒', r.res.isError === true);
  step('  两类新数据集仍通过校验',
    (await call(client, 'validate_cpt', { path: fdsPath })).data?.summary?.error === 0);

  // 15. generate_report 直接吃 Excel 数据源（离终极目标最近的一条路：给字段 + 一张表 = 一张报表）
  const xlRep = path.join(TMP, 'excel报表.cpt');
  r = await call(client, 'generate_report', {
    path: xlRep,
    title: '地区销售汇总',
    source: { excelFile: 'reportlets/data/销售明细.xlsx' },
    fields: [
      { name: '地区', label: '地区', type: 'text' },
      { name: '销售额', label: '销售额', type: 'money', summary: 'sum' },
    ],
  });
  step('generate_report(source.excelFile) —— 不连库直接出报表',
    r.res.isError !== true && r.data?.summary?.dataSourceType === 'excel',
    `dataSourceType=${r.data?.summary?.dataSourceType}`);
  const xlXml = fs.readFileSync(xlRep, 'utf8');
  step('  产出 ExcelTableData 且未凭空造 SQL 数据集',
    xlXml.includes('class="com.fr.data.impl.ExcelTableData"')
    && !xlXml.includes('com.fr.data.impl.DBTableData'),
    '字段+一张 Excel → 完整报表（标题/表头/数据行/合计行+斑马纹+主题）');

  r = await call(client, 'generate_report', {
    path: path.join(TMP, '无来源.cpt'),
    title: 'x',
    source: {},
    fields: [{ name: 'a', type: 'text' }],
  });
  step('安全围栏·既无 connection 又无 excelFile 时报错给出 Excel 出路',
    r.res.isError === true && r.text.includes('excelFile'));

  // 16. 图表：给「字段 + 数据源」白得一张图（P3：柱形 / 折线 / 饼 最小可用集）
  const chartRep = path.join(TMP, '带图报表.cpt');
  r = await call(client, 'generate_report', {
    path: chartRep,
    title: '销售分析',
    source: { connection: 'Doris', table: 'sales' },
    fields: [
      { name: 'region', label: '地区', type: 'text' },
      { name: 'amount', label: '金额', type: 'money', summary: 'sum' },
      { name: 'qty', label: '数量', type: 'number', summary: 'sum' },
    ],
    chart: true,
  });
  const chartXml1 = fs.existsSync(chartRep) ? fs.readFileSync(chartRep, 'utf8') : '';
  step('generate_report(chart:true) —— 字段+数据源直接带图',
    r.res.isError !== true && r.data?.summary?.chart?.type === 'column'
    && chartXml1.includes('com.fr.plugin.chart.column.VanChartColumnPlot'),
    `type=${r.data?.summary?.chart?.type} category=${r.data?.summary?.chart?.category}`);
  step('  两个数值列自动走多系列 MoreNameCDDefinition（官方 230 例）',
    /<MoreNameCDDefinition>/.test(chartXml1) && /<CategoryName value="region"\/>/.test(chartXml1)
    && (chartXml1.match(/<ChartSummaryColumn /g) || []).length === 2);
  step('  图表单元格形态与官方 543 例一致（O t=CC + LayoutAttr + PrivilegeControl + Expand）',
    /<O t="CC">\s*<LayoutAttr selectedIndex="0"\/>/.test(chartXml1)
    && /<\/Chart>\s*<\/O>\s*<PrivilegeControl\/>\s*<Expand\/>/.test(chartXml1));
  step('  带图报表仍通过校验',
    (await call(client, 'validate_cpt', { path: chartRep })).data?.summary?.error === 0);

  // 饼图：自动收敛成单数值列定义
  const pieRep = path.join(TMP, '饼图.cpt');
  r = await call(client, 'generate_report', {
    path: pieRep,
    title: '占比',
    source: { connection: 'Doris', table: 'sales' },
    fields: [
      { name: 'region', label: '地区', type: 'text' },
      { name: 'amount', label: '金额', type: 'money' },
    ],
    chart: { type: 'pie' },
  });
  const pieXml = fs.existsSync(pieRep) ? fs.readFileSync(pieRep, 'utf8') : '';
  step('chart.type=pie —— 单数值列走 OneValueCDDefinition（官方 166 例）',
    r.res.isError !== true
    && pieXml.includes('com.fr.plugin.chart.PiePlot4VanChart')
    && /<OneValueCDDefinition seriesName="region" valueName="amount"/.test(pieXml));

  r = await call(client, 'generate_report', {
    path: path.join(TMP, '饼图多列.cpt'),
    title: 'x',
    source: { connection: 'D', table: 't' },
    fields: [{ name: 'r', type: 'text' }, { name: 'a', type: 'money' }, { name: 'b', type: 'money' }],
    chart: { type: 'pie' },
  });
  step('安全围栏·饼图多数值列被拒（官方 100 个饼图仅 1 例，形态未验证）', r.res.isError === true);

  // add_chart 原语：手工指定坐标与字段
  const manualRep = path.join(TMP, '手工图表.cpt');
  await call(client, 'create_cpt', { path: manualRep, title: 'M', rows: 20, columns: 6 });
  await call(client, 'add_dataset', { path: manualRep, name: 'ds1', connection: 'Doris', sql: 'SELECT 1' });
  r = await call(client, 'add_chart', {
    path: manualRep, column: 0, row: 2, type: 'line',
    dsName: 'ds1', category: '月份', values: [{ name: '销量', agg: 'avg' }], title: '月均销量',
  });
  const mXml = fs.readFileSync(manualRep, 'utf8');
  step('add_chart(折线/avg) —— 原语可用且聚合类取自官方六个',
    r.res.isError !== true && mXml.includes('com.fr.plugin.chart.line.VanChartLinePlot')
    && mXml.includes('com.fr.data.util.function.AverageFunction'),
    `chartType=${r.data?.chartType}`);
  r = await call(client, 'add_chart', {
    path: manualRep, column: 0, row: 2, dsName: 'ds1', category: 'c', values: ['v'],
  });
  step('安全围栏·图表坐标重复被拒', r.res.isError === true);
  r = await call(client, 'add_chart', {
    path: manualRep, column: 1, row: 2, type: 'radar', dsName: 'ds1', category: 'c', values: ['v'],
  });
  step('安全围栏·未开放的图表类型被拒', r.res.isError === true);

  // —— [16] 字段显示值变换（官方 <Result>）——
  //   逆向依据：5517 个 DSColumn 单元格里只有 479 个带 <Result>（8.7%），
  //   其中 364 个还是恒等的 $$$。所以它不是必填项，但它是"字段逻辑"的唯一载体：
  //   $$$/10000（元→万元）、ROUND($$$,0)、货主城市+$$$ 都落在这里。
  const resultRep = path.join(TMP, '显示值变换.cpt');
  r = await call(client, 'generate_report', {
    path: resultRep,
    title: '销售额看板',
    source: { connection: 'D', table: 't' },
    fields: [
      { name: '地区', type: 'text' },
      { name: '销售额', type: 'money', result: '$$$/10000' },
    ],
  });
  const resultXml = fs.readFileSync(resultRep, 'utf8');
  step('generate_report(field.result) —— 字段逻辑落到官方 <Result>',
    r.res.isError !== true
    && /<Result>\s*<!\[CDATA\[\$\$\$\/10000\]\]><\/Result>/.test(resultXml),
    `dataSourceType=${r.data?.summary?.dataSourceType}`);

  // 元素顺序官方固定：Attributes > [Condition] > Complex > RG > Result > Parameters > [cellSortAttr]
  // 注意：要挑「带 result 的那个」DSColumn 块 —— 同一份模板里没传 result 的列本来就没有 <Result>
  const dsBlocks = [...resultXml.matchAll(/<O t="DSColumn">[\s\S]*?<\/O>/g)].map((m) => m[0]);
  const seqOf = (blk) => [...blk.matchAll(/<([A-Za-z][\w]*)\b/g)].map((m) => m[1]);
  const withResult = dsBlocks.find((b) => b.includes('<Result>'));
  const seq = withResult ? seqOf(withResult) : [];
  step('  <Result> 位置贴合官方（RG 之后、Parameters 之前）',
    seq.indexOf('RG') >= 0 && seq.indexOf('Result') > seq.indexOf('RG')
    && seq.indexOf('Parameters') > seq.indexOf('Result'),
    `顺序=${seq.join('>')}`);
  step('  未传 result 的列不含 <Result>（同一模板内对照）',
    dsBlocks.some((b) => !b.includes('<Result>')), `DSColumn 块数=${dsBlocks.length}`);

  // 没给 result 的字段绝不能凭空回填 —— 官方 91.3% 的 DSColumn 没有这个元素
  const noResultRep = path.join(TMP, '无变换.cpt');
  await call(client, 'generate_report', {
    path: noResultRep, title: 'x',
    source: { connection: 'D', table: 't' },
    fields: [{ name: 'a', type: 'text' }],
  });
  step('  未传 result 时不回填（对齐官方 91.3% 样本）',
    !/<Result>/.test(fs.readFileSync(noResultRep, 'utf8')));

  r = await call(client, 'generate_report', {
    path: path.join(TMP, '变换类型错.cpt'), title: 'x',
    source: { connection: 'D', table: 't' },
    fields: [{ name: 'a', type: 'money', result: 10000 }],
  });
  step('安全围栏·result 非字符串被拒（公式不能是数字）', r.res.isError === true);

  const cdataRep = path.join(TMP, '变换注入.cpt');
  await call(client, 'create_cpt', { path: cdataRep, title: 'x', rows: 4, columns: 2 });
  r = await call(client, 'add_cell', {
    path: cdataRep, column: 0, row: 1, contentType: 'dsColumn',
    dsName: 'ds1', columnName: 'a', result: '$$$ ]]> <evil/>',
  });
  step('安全围栏·result 的 CDATA 闭合注入被挡', r.res.isError === true);

  // —— [17] 本机 FR 静态逆向入口 ——
  r = await call(client, 'fr_detect', {});
  step('fr_detect —— 能识别 FR 引擎/设计器而不要求 cptdec',
    r.res.isError !== true && typeof r.data?.source === 'string',
    `source=${r.data?.source} frHome=${r.data?.frHome || 'none'} tool=${r.data?.tool || 'none'}`);
  if (r.data?.frHome) {
    r = await call(client, 'fr_inspect', {});
    step('fr_inspect —— 静态盘点 jar/类/主题/官方样本',
      r.res.isError !== true && r.data?.ok === true && r.data?.classInventory?.reader?.templateWorkBookIO === true,
      `samples=${r.data?.officialSamples} entries=${r.data?.jars?.engine?.entries}`);
  }

  // —— [18] 浮动元素（官方 76 例浮动文本实证） ——
  r = await call(client, 'add_float_element', { path: CPT, content: '销售看板', styleIndex: 0, leftMm: 20, topMm: 5, widthMm: 50, heightMm: 10, name: 'Kpi1' });
  step('add_float_element —— 浮动文本元素（官方 76 例实证）',
    r.res.isError !== true && r.data?.name === 'Kpi1', `name=${r.data?.name}`);
  r = await call(client, 'read_cpt', { path: CPT });
  step('  read_cpt 计数浮动元素', r.data?.floatElements === 1, `floatElements=${r.data?.floatElements}`);
  r = await call(client, 'add_float_element', { path: CPT, content: '重复名', styleIndex: 0, name: 'Kpi1' });
  step('安全围栏·浮动元素重名被拒', r.res.isError === true);
  r = await call(client, 'add_float_element', { path: CPT, content: '越界样式', styleIndex: 99 });
  step('安全围栏·浮动元素样式索引越界被拒', r.res.isError === true);

  // —— [19] 真实引擎校验报告（只读；报告由 npm run verify:fr 生成） ——
  r = await call(client, 'fr_engine_check', { path: CPT });
  step('fr_engine_check —— 无报告时结构化返回 not-run + howToRun',
    r.res.isError !== true && r.data?.status === 'not-run' && typeof r.data?.howToRun === 'string',
    `status=${r.data?.status}`);
  r = await call(client, 'fr_engine_check', { path: path.resolve(os.tmpdir(), '..', 'nonexistent-outside.cpt') });
  step('安全围栏·fr_engine_check 路径围栏生效', r.res.isError === true);

  // —— [20] S1/S5 布尔与 sheet 参数围栏（zod coerce 曾把 "false" 静默转成 true） ——
  r = await call(client, 'add_fill_binding', { path: CPT, submitIndex: 0, field: 'f2', column: 1, row: 1, isKey: 'false' });
  step('S1·isKey:"false" 不再被静默翻转', r.res.isError !== true, `isKey=${r.data?.isKey}`);
  r = await call(client, 'get_fill_config', { path: CPT });
  const f2 = (r.data?.submits?.[0]?.columns || []).find((c) => c.field === 'f2');
  step('  get_fill_config 确认 f2 非主键', f2 && f2.isKey === false, `isKey=${f2?.isKey}`);
  r = await call(client, 'add_cell', { path: CPT, column: 9, row: 9, content: 'x', sheet: '' });
  step('S5·sheet 空串被拒（不再静默指向第 1 个工作表）', r.res.isError === true);

  // —— [21] S2 数据集引用完整性 ——
  r = await call(client, 'add_chart', { path: CPT, column: 0, row: 12, type: 'column', dsName: '不存在的数据集', category: 'a', values: ['x'] });
  step('S2·add_chart 悬空数据集被拒', r.res.isError === true && /不存在/.test(JSON.stringify(r.res) + (r.error?.message || '')));
  r = await call(client, 'add_cell', { path: CPT, column: 2, row: 1, contentType: 'dsColumn', dsName: '拼写错误', columnName: 'a' });
  step('S2·add_cell(dsColumn) 悬空数据集被拒', r.res.isError === true);

  // —— [22] 质量门槛与工序进度（弱模型交付围栏） ——
  // 断言口径：检查"9 个基础工序齐备"，不锁总数——相位表是条件插入的
  // （M120 起"JS 块基线"在 try/catch 内插入，成功即 10 个）。锁 `=== 9` 会让
  // 新增工序本身变成假红，掩盖真回归。
  r = await call(client, 'get_build_progress', { path: CPT });
  const phaseNames = (r.data?.phases ?? []).map((x) => x.phase);
  const missingPhases = BASE_PHASES.filter((p) => !phaseNames.includes(p));
  step('get_build_progress —— 按工序推导阶段清单',
    r.res.isError !== true && Array.isArray(r.data?.phases) && missingPhases.length === 0
      && typeof r.data?.nextAction === 'string'
      && r.data.phases.every((x) => typeof x.phase === 'string' && typeof x.done === 'boolean' && typeof x.detail === 'string'),
    `phases=${r.data?.phases?.length} done=${r.data?.phases?.filter((x) => x.done).length}`
      + (missingPhases.length ? ` 缺失工序=${missingPhases.join('/')}` : ' 基础工序齐备'));
  r = await call(client, 'quality_gate_cpt', { path: CPT });
  step('quality_gate_cpt —— 聚合判定结构完整（pass/blockers/checklist/engineCheck）',
    r.res.isError !== true && typeof r.data?.pass === 'boolean' && Array.isArray(r.data?.blockers) && Array.isArray(r.data?.checklist) && r.data?.engineCheck?.status,
    `pass=${r.data?.pass} blockers=${r.data?.summary?.blockers} engine=${r.data?.engineCheck?.status}`);
  // 负例：手工写坏坐标重复（模拟外部破坏），门槛必须不放行
  const gateRep = path.join(TMP, '门槛坏模板.cpt');
  await call(client, 'create_cpt', { path: gateRep, rows: 3, columns: 3 });
  await call(client, 'add_cell', { path: gateRep, column: 0, row: 0, content: 'x' });
  {
    const raw = fs.readFileSync(gateRep, 'utf8');
    const m = raw.match(/<C c="0" r="0"[^>]*>[\s\S]*?<\/C>/);
    fs.writeFileSync(gateRep, raw.replace('</CellElementList>', `${m[0]}\n</CellElementList>`), 'utf8');
  }
  r = await call(client, 'quality_gate_cpt', { path: gateRep });
  step('quality_gate_cpt —— 坐标重复必须 pass=false 且 fix 指向 delete_cell',
    r.data?.pass === false && r.data?.blockers?.some((b) => /坐标重复/.test(b.message) && /delete_cell/.test(b.fix)));
  // 官方主流形态锁死：同行多列 dsColumn 默认展开不得误报（官方 789 行 674 行全默认展开）
  await call(client, 'add_dataset', { path: gateRep, name: 'ds1', connection: 'Doris', sql: 'SELECT 1' });
  await call(client, 'add_cell', { path: gateRep, column: 0, row: 2, contentType: 'dsColumn', dsName: 'ds1', columnName: 'a' });
  await call(client, 'add_cell', { path: gateRep, column: 1, row: 2, contentType: 'dsColumn', dsName: 'ds1', columnName: 'b' });
  r = await call(client, 'quality_gate_cpt', { path: gateRep });
  step('quality_gate_cpt —— 默认展开多列不得误报左父格（官方 85% 反例教训）',
    !r.data?.blockers?.some((b) => /左父格/.test(b.message)));

  await client.close();
} catch (e) {
  failed += 1;
  console.error('✖ MCP 验证异常:', e.message);
} finally {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 忽略 */ }
}

console.log(failed === 0 ? '\nMCP 可用性验证：全部通过 ✓' : `\nMCP 可用性验证：${failed} 项失败 ✗`);
process.exitCode = failed === 0 ? 0 : 1;
