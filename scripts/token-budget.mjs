// scripts/token-budget.mjs —— 预算门：**绝对预算** + 轻 schema/真隐藏结构断言
//
// 口径与 scripts/token-baseline.mjs 一致：tools/list 序列化 JSON 字符数。
// M113 起把"相对预算"换成"绝对预算"，理由（方案 ④/A8）：
//   旧口径用 `report/full ≤ 45%`、`full < preSlim 基线` 这类**相对**约束，full 一变就整体
//   漂移——历史上就出现过 report 工具数 54/56/57 三份不一致、预算脚本写 54 而实际 57 的长期红。
//   绝对预算直接锁"每请求要付的上下文量"与"工具数"，与档位名绑定，漂移立刻显形。
//
// 单一来源（硬要求）：report 静态工具数与名单一律来自 lib/contract.js 的 REPORT_STATIC_TOOLS，
// 禁止在本脚本手写第二份数字——那正是"预算门与真实档位脱节"的根因。
//
// 用法：node scripts/token-budget.mjs（断言失败时退出码 1，成功 0）
// 顺序 spawn，避免并发打爆 stdio（限流意识）；子进程 env 只传增量覆盖，
// 禁止 {...process.env} 全量透传（SDK 默认 env 是安全子集，全量透传会带入
// CPT_MCP_ALLOWED_ROOTS 等会话变量改变服务行为）。
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPORT_STATIC_TOOLS, LIGHT_TOOL_NAMES } from './token-budget.coupling.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

// ---- 绝对预算（M113 口径；加工具/描述膨胀会自然撞线，需显式评审后调预算） ----
const BUDGET = {
  fullCount: 208,      // full 工具数（精确：加工具必须同步评审预算；208 = 198 + fr_preview 三件套 + local_db 六件套 + set_webpage_js）
  focusedCount: 42,    // focused 工具数（精确）
  reportCount: REPORT_STATIC_TOOLS.length, // report 工具数 —— **单一来源**，不手写
  generateCount: 9,    // generate 工具数（精确）
  // report 档硬上限：2026-11-12 P0-1 瘦身后收紧为 40,000 B（实测 ~38.2 KB；原 46,200 B 是 42 项时代）
  reportMaxBytes: 40000,
  // focused/full 保持既有字符预算（这两档本轮不动，只防回弹）
  focusedMaxChars: 98000,
  fullMaxChars: 250000,
  generateMaxChars: 23000,
  // L3-4 描述上限：**UTF-8 字节**口径（唯一口径）。
  // 注意口径差别（与 context-plan 门禁 A11 的一致性说明）：
  //   · A11 量的是"轻 entry 定义里的 description"（即 target-table.mjs 的 LIGHT 候选定义），
  //     上限 300 B / 72 B，只覆盖 15 个轻 entry 工具 —— 那是"建模值"。
  //   · 本脚本量的是**线上真实 tools/list 的 description**，即注册时的最终文案。
  //     其中每个写工具还会被 withWriteBoundary 追加一条 S6 边界提示
  //     （【边界·S6】…）——这条提示是**全局强制**的
  //     （test/write-boundary.test.js 锁定"所有非只读工具都必须带"）。
  //     M118 前该提示为 157 B 全文，故写工具档位被迫放宽到 457 B；
  //     M118 把它压到 98 B（去掉"细则见instructions"这句跨引用，三条语义全保留：
  //     不可撤销 / 仅明确要求时调 / 先 read_cpt，改为自包含），因此写工具档位下调到 398 B。
  //   故本门禁按**真实口径**设两档：读/门禁工具 ≤300 B；写工具 ≤300 + 98 = 398 B。
  //   两档都锁住"轻 entry 化没有回弹"这一真实意图，而不是用一个做不到的数字当门禁。
  maxDescBytes: 300,
  maxWriteDescBytes: 398, // = 300 B 描述 + 98 B S6 边界提示（M118 自包含短标记，全局强制，见上）
  maxParamDescBytes: 72,
  preSlimFullChars: 257315, // t3 前 full 基线：当前必须显著低于它
  minSavingVsPreSlim: 10000, // 相对 t3 前至少省 10k 字符
};
// focused 下默认真隐藏的深层工具（profile 外 → 未注册；租约后动态出现）。
// 注意：get_cell_style / add_cell / update_cell / update_cell_style 虽在租约组里，
// 但静态进 focused profile（profile 内深层静态可用），故不在此列。
const FOCUSED_HIDDEN = [
  'batch_mutate_cells', 'update_report_node', 'regenerate_from_meta', 'get_cell_hyperlink',
];
const SHORT_HINT_MARK = '【边界·S6】'; // t3 瘦身后的短引用标记（必须存在：边界语义不可丢）
const SHORT_SHEET_DESC = '工作表（0起索引/名称，缺省首表）'; // t3 抽取的公共短描述（必须复用）

async function listEntry(entry, env) {
  const client = new Client({ name: 'token-budget', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(ROOT, entry)],
    cwd: ROOT,
    stderr: 'pipe',
    ...(env && Object.keys(env).length ? { env } : {}),
  });
  await client.connect(transport);
  try {
    return { tools: (await client.listTools()).tools, client };
  } catch (e) {
    await client.close();
    throw e;
  }
}

const failures = [];
const check = (name, cond, detail = '') => {
  console.log(`${cond ? '✔' : '✖'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failures.push(name);
};
const utf8 = (s) => Buffer.byteLength(String(s ?? ''), 'utf8');
const bytesOf = (v) => utf8(JSON.stringify(v));

const fullSess = await listEntry('server-full.js');
const full = fullSess.tools;
await fullSess.client.close();
// 2026-10-26：server.js 的默认档位已改为 report（自包含化），focused 必须用 server-focused.js 显式测量，
// 否则这里量到的是 report、focused 预算名存实亡。
const focusedSess = await listEntry('server-focused.js');
const focused = focusedSess.tools;
await focusedSess.client.close();
const reportSess = await listEntry('server.js', { CPT_MCP_TOOL_PROFILE: 'report' });
const report = reportSess.tools;
await reportSess.client.close();
const generateSess = await listEntry('server-generate.js');
const generate = generateSess.tools;
await generateSess.client.close();

const fullJson = JSON.stringify(full);
const focusedJson = JSON.stringify(focused);
const reportJson = JSON.stringify(report);
const generateJson = JSON.stringify(generate);
const est = (bytes) => Math.round(bytes / 3.3);

console.log(`full: ${full.length} 工具 / ${bytesOf(full)} B (~${est(bytesOf(full))} tokens)`);
console.log(`focused: ${focused.length} 工具 / ${bytesOf(focused)} B (~${est(bytesOf(focused))} tokens)`);
console.log(`report: ${report.length} 工具 / ${bytesOf(report)} B (~${est(bytesOf(report))} tokens)`);
console.log(`generate: ${generate.length} 工具 / ${bytesOf(generate)} B (~${est(bytesOf(generate))} tokens)`);

// —— 数量预算 ——
check(`预算·full 工具数 ${BUDGET.fullCount}`, full.length === BUDGET.fullCount, `实际 ${full.length}`);
check(`预算·focused 工具数 ${BUDGET.focusedCount}`, focused.length === BUDGET.focusedCount, `实际 ${focused.length}`);
check(`预算·report 工具数 ${BUDGET.reportCount}（取自 REPORT_STATIC_TOOLS）`, report.length === BUDGET.reportCount, `实际 ${report.length}`);
check(`预算·generate 工具数 ${BUDGET.generateCount}`, generate.length === BUDGET.generateCount, `实际 ${generate.length}`);

// —— report 档名单与 REPORT_STATIC_TOOLS 逐项一致（防"预算门与真实档位脱节"） ——
{
  const live = new Set(report.map((t) => t.name));
  const target = new Set(REPORT_STATIC_TOOLS);
  const extra = [...live].filter((n) => !target.has(n));
  const missing = [...target].filter((n) => !live.has(n));
  check(
    '预算·report 名单 = REPORT_STATIC_TOOLS（不多不少）',
    extra.length === 0 && missing.length === 0,
    `多余 ${extra.join(',') || '无'}；缺失 ${missing.join(',') || '无'}`,
  );
}

// —— 体积预算（report 用绝对 bytes 口径：bytes/3.3 ≤ 12k token ⟺ ≤40,000 B） ——
{
  const reportBytes = bytesOf(report);
  check(`预算·report 静态表 ≤ ${BUDGET.reportMaxBytes} B（≈ ${est(BUDGET.reportMaxBytes)} token）`, reportBytes <= BUDGET.reportMaxBytes,
    `实际 ${reportBytes} B (~${est(reportBytes)} tokens，余量 ${(BUDGET.reportMaxBytes - reportBytes)} B)`);
}
check(`预算·focused 字符 ≤ ${BUDGET.focusedMaxChars}`, focusedJson.length <= BUDGET.focusedMaxChars, `实际 ${focusedJson.length}`);
check(`预算·full 字符 ≤ ${BUDGET.fullMaxChars}`, fullJson.length <= BUDGET.fullMaxChars, `实际 ${fullJson.length}`);
check(`预算·generate 字符 ≤ ${BUDGET.generateMaxChars}`, generateJson.length <= BUDGET.generateMaxChars, `实际 ${generateJson.length}`);
check(
  `预算·report 静态表 < focused 静态表（瘦身必须真的更轻）`,
  bytesOf(report) < bytesOf(focused),
  `report ${bytesOf(report)} B vs focused ${bytesOf(focused)} B`,
);

// —— 瘦身收益（相对 t3 前基线） ——
check(`瘦身·full 低于 t3 前基线 ${BUDGET.preSlimFullChars}`, fullJson.length < BUDGET.preSlimFullChars, `实际 ${fullJson.length}`);
check(
  `瘦身·full 相对 t3 前至少省 ${BUDGET.minSavingVsPreSlim} 字符`,
  BUDGET.preSlimFullChars - fullJson.length >= BUDGET.minSavingVsPreSlim,
  `实际省 ${BUDGET.preSlimFullChars - fullJson.length}`,
);

// —— 描述上限（**UTF-8 字节**口径，唯一口径：工具 ≤300 B、参数 ≤72 B） ——
// 与 context-plan 的门禁 A11 同口径，且**登记范围也一致**：只查 report 静态表内的工具
// （名单来自 lib/contract.js 的 REPORT_STATIC_TOOLS，不在此手写数字）。
// 理由：只有静态表里的 description 是**每请求常驻**的；
// full 档其余工具默认不可见（真隐藏），它们的长描述只在租约解锁后临时进入上下文，
// 把它们卡到 300 B 属于"改了不省每请求 token，却损失调用契约信息"的净亏。
// A11 的 violations 也只在 LIGHT 定义上算——两处按同一登记范围互证，避免各算一套。
{
  const overTools = [];
  const overParams = [];
  const staticNames = new Set(REPORT_STATIC_TOOLS);
  const isWrite = (t) => t.annotations?.readOnlyHint !== true;
  for (const t of report) {
    if (!staticNames.has(t.name)) continue;
    const cap = isWrite(t) ? BUDGET.maxWriteDescBytes : BUDGET.maxDescBytes;
    if (utf8(t.description) > cap) overTools.push(`${t.name}(${utf8(t.description)}B>${cap})`);
    for (const [pName, pDef] of Object.entries(t.inputSchema?.properties ?? {})) {
      if (utf8(pDef?.description) > BUDGET.maxParamDescBytes) overParams.push(`${t.name}.${pName}(${utf8(pDef.description)}B)`);
    }
  }
  check(
    `瘦身·静态表工具描述 ≤ ${BUDGET.maxDescBytes} B（读）/ ≤ ${BUDGET.maxWriteDescBytes} B（写，含强制 S6 提示）`,
    overTools.length === 0,
    overTools.length ? `超限: ${overTools.join(',')}` : `report ${staticNames.size} 项全部达标`,
  );
  check(
    `瘦身·静态表参数描述 ≤ ${BUDGET.maxParamDescBytes} B（UTF-8 字节）`,
    overParams.length === 0,
    overParams.length ? `超限: ${overParams.join(',')}` : '全部达标',
  );
  // 轻 entry 工具（真正每请求常驻的参数文档已外移）必须显著小于"原样"工具
  const lightStatic = report.filter((t) => staticNames.has(t.name) && LIGHT_TOOL_NAMES.includes(t.name));
  const heaviest = lightStatic.slice().sort((a, b) => bytesOf(b) - bytesOf(a))[0];
  check(
    '瘦身·轻 entry 工具的广告 schema ≤ 1,300 B（spec/border/dictionary 等巨块已外移）',
    lightStatic.every((t) => bytesOf(t.inputSchema) <= 1300),
    `共 ${lightStatic.length} 项；最重 ${heaviest?.name} ${heaviest ? bytesOf(heaviest.inputSchema) : '-'} B`,
  );
}

// —— 瘦身形态（语义不断：短引用存在、轻 entry 真的收紧了 schema） ——
check('瘦身·S6 短引用标记存在', fullJson.includes(SHORT_HINT_MARK));
check('瘦身·公共 sheet 短描述被复用', fullJson.includes(SHORT_SHEET_DESC));
{
  // 轻 entry：build_report / add_cell 的**广告** schema 不得再常驻巨块参数文档。
  // build_report 已从 report 静态表下沉到 generator_full 租约（focused 档仍静态），
  // 因此广告 schema 从 focused 列表取；它仍会随租约/EXTRA 进入上下文，形态约束不变。
  const build = focused.find((t) => t.name === 'build_report');
  const addCell = report.find((t) => t.name === 'add_cell');
  check('瘦身·build_report 广告 schema 不含 spec 子树文档（≤1,200 B）',
    build != null && bytesOf(build.inputSchema) <= 1200, `实际 ${build ? bytesOf(build.inputSchema) : '缺失'} B`);
  check('瘦身·add_cell 广告 schema 不含 widgetDictionary/expand',
    addCell != null && !('widgetDictionary' in (addCell.inputSchema?.properties ?? {})) && !('expand' in (addCell.inputSchema?.properties ?? {})),
    `广告参数 ${Object.keys(addCell?.inputSchema?.properties ?? {}).join(',')}`);
  check(`瘦身·轻 entry 工具表非空（${LIGHT_TOOL_NAMES.length} 项）`, LIGHT_TOOL_NAMES.length >= 14, LIGHT_TOOL_NAMES.join(','));
}

// —— 真隐藏（t2 语义：profile 外深层工具未注册，而非 disabled 占位） ——
{
  const names = new Set(focused.map((t) => t.name));
  const leaked = FOCUSED_HIDDEN.filter((n) => names.has(n));
  check('真隐藏·focused 默认不含 profile 外深层工具', leaked.length === 0, leaked.length ? `泄漏: ${leaked.join(',')}` : '4/4 隐藏');
}
{
  // 协议层探针：未解锁深层工具应 not found（真隐藏），而非 disabled 占位。
  // 注：SDK client.callTool 把协议错误转为 isError 结果而非抛错，故断言返回值。
  const probe = await listEntry('server-focused.js');
  let res;
  try {
    res = await probe.client.callTool({ name: 'get_cell_hyperlink', arguments: { path: 'x.cpt', sheet: 0, column: 0, row: 0 } });
  } finally {
    await probe.client.close();
  }
  const text = res.content?.[0]?.text ?? '';
  check('真隐藏·未解锁深层工具调用报 not found', res.isError === true && /not found/.test(text), text.slice(0, 80));
  check('真隐藏·无 disabled 占位文案', !/disabled|暂时禁用/.test(text), text.slice(0, 80));
}

console.log(failures.length === 0 ? '\nToken 预算门：全部通过 ✓' : `\nToken 预算门：${failures.length} 项失败 ✗`);
process.exitCode = failures.length === 0 ? 0 : 1;
