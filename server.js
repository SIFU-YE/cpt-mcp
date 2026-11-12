#!/usr/bin/env node
/**
 * cpt-mcp —— FineReport 填报报表 .CPT 文件 增删改查 + 生成 + 校验
 *
 * 原子性：完全自包含（本地 XML 编辑），不调用任何其他 MCP / 数据库。
 * 保真性：写操作基于文本锚点定向编辑，仅替换目标节点字节，保证设计器兼容；
 *         生成工具的 XML 结构对照真实 .cpt 样本与「FineReport_CPT_XML映射清单.md」。
 *
 * 工具（208；默认 report 档静态 33 项 + 场景族租约解锁，server-full.js 全量 208；2026-11-12 P0-1 前为 42 项）：
 *   内置本地测试库（2026-11-02，local_db 租约族）：get_local_db_status / local_db_admin / local_db_import /
 *     local_db_exec / local_db_schema / dataset_sql_parity；run_dataset_sql_check 增加 target=local|both。
 *     本地 SQLite 由 MCP 全权管理（建库/镜像/造数），外部真实数据库权限依旧只读。
 *   读: read_cpt / get_datasets / get_parameters / get_cells / get_fill_config / get_styles / get_page_settings / get_parameter_panel
 *   生成: create_cpt（骨架）/ add_dataset / add_style / add_cell（含控件）/ add_fill_submit / set_report_settings / set_parameter_panel / add_parameter_widget（参数面板控件）/ set_grid / add_sheet
 *   增: add_parameter / add_fill_binding
 *   改: update_parameter / update_dataset / update_cell（内容/提示/insertPolicy）/ update_fill_binding / get_cell_style / update_cell_style
 *   参数面板控件: add_parameter_widget / rename_parameter_widget（改名+同名绑定+标签映射+移动端引用同步）/ delete_parameter_widget
 *   删: delete_parameter / delete_cell / delete_fill_binding
 *   校验: validate_cpt / list_cpt_issues / diagnose_fill_row_integrity（填报行完整性一键盘点）/ style_review_cpt / reasonableness_review_cpt
 *   报表构建: build_report
 *   定时任务（auto-runner 模式，持久化到 .cpt 同目录的 .cpt-schedule.json，node-cron 进程内调度）：
 *     schedule_add / schedule_list / schedule_get / schedule_remove / schedule_enable / schedule_disable / schedule_run_now
 *   调度器 / FR 反编译探测：scheduler_status / scheduler_history / scheduler_stop / scheduler_actions / fr_detect / fr_inspect / fr_decompile
 *   本地预览（2026-10-29，族 fr_preview）：start_fr_preview / stop_fr_preview / fr_preview_status（本机拉起独立 FR 报表实例）
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { overview, datasets, parameters, cells, fillConfig, fillSubmitMatrix, styles, pageSettings, parameterPanel, gridSizes, checkReportJs, reportListener, webwriteListener, embeddedSubmits } from './lib/cpt.js';
// 2026-11-07：源码热重启（源码变化 → 进程退出 → DSH mcp-client 自动重连拉起新进程）
import { installHotReload } from './lib/hot-reload.js';
// 2026-11-07 P0：出口 JSON 安全化（node:sqlite readBigInts:true 的 COUNT(*) 是 bigint，
// JSON.stringify 会抛 "Do not know how to serialize a BigInt"）。
import { toJsonSafeDeep } from './lib/json-safe.js';
// 2026-10-26 P0：参数别名归一（v1 会话 17/27 次失败源自"键名猜错"）
import { normalizeArgs, formatFixes, allowedKeysAt, sdkLenientShape, missingRequiredArgs } from './lib/arg-normalize.js';
import { checkDatasetSql, checkDatasetSqlLocal, checkDatasetSqlBoth, checkDatasetSqlAuto } from './lib/sql-check.js';
// 2026-11-02 本地 SQLite 测试库（内置；对外部真实库只读）
import {
  getLocalDbStatus, createLocalDb, dropLocalDb, snapshotLocalDb, restoreLocalDb,
  exportLocalDbSql, runLocalSql, listLocalTables, localTableInfo, localSchemaSnapshot,
  resolveLocalDbName, localDbGuide, sqliteInfo,
  installWriteAuditTriggers, startWriteAuditRun, stopWriteAuditRun, readWriteAudit, getActiveWriteAuditRun,
} from './lib/localdb.js';
import {
  importSchemaFromDb, importDataFromDb, seedLocalDb, importSqlIntoLocalDb,
  importDdlIntoLocalDb, listRealTables, showFullColumns, showIndexes,
  autoPrepareLocalDb,
} from './lib/localdb-import.js';
// 2026-11-09：报表级测试环境（全部外部连接 + 填报目标表 → 内置 SQLite；新建报表 DDL/seed）
import { prepareReportTestEnv } from './lib/test-env.js';
// 2026-11-12：填报提交本地试写/行来源追踪（事务内执行后回滚，不落库）
import { simulateFillSubmit } from './lib/fill-write-sim.js';
// 2026-11-04：Excel 导入离线仿真（xlsx 读取 + 位置匹配校验 + 本地 SQLite 事务试跑回滚）
import { checkExcelImport } from './lib/excel-import.js';
// 2026-11-07 P0：local_db_schema 的 compareWith 严格校验连接名（不回退默认连接、不误查真实库）
import { resolveExactConnection } from './lib/db.js';
import { diffSchemaSnapshots, schemaSnapshotFromShow, normalizeShowColumn, normalizeShowIndex } from './lib/localdb-schema.js';
// 2026-10-26 自主核验：结构 + 门禁 + 期望值对账 + 真引擎，写工具返回体自动带 selfCheck
import { verifyCpt, selfCheckSummary } from './lib/verify.js';
import { briefValidate, briefGate, briefVerify } from './lib/gate-brief.js';
import { gateFingerprint, cacheLookup, cacheStore } from './lib/gate-cache.js';
import { validateCpt, issueSummary } from './lib/validate.js';
import { reviewStyles, reviewReasonableness, buildReport, generateReport } from './lib/engine/index.js';
import { addChart } from './lib/engine/chart.js';
import { buildReportSpecSchema, highlightSchema, sheetParamSchema } from './lib/engine/spec.js';
import {
  updateParameter, addParameter, deleteParameter,
  updateDatasetSql, updateCellTooltip, updateCellContent, updateCellInsertPolicy, deleteCell, deleteCellRange, deleteRowRange, shiftCellRange,
  getCellStyle, updateCellStyle,
  updateFillBinding, addFillBinding, deleteFillBinding, addCellHighlight, addCellHyperlink, setFillToolbar, setCellListener, batchAddCellListeners, setCellWidget, setWidgetValue, updateCellDictionary, getCellDictionary, setCellSpan,
  updateEmbeddedSubmit,
  deleteDataset, deleteChart, getCellHyperlink, deleteFloatElement,
  updateReportNode, setReportListener, setReportJs, setWebWriteExtras, setWebWriteJs, setWebPageJs, setToolbarButtonJs, addToolbarButton, deleteToolbarButton, moveToolbarButton, listToolbarButtons, setToolbarButtonIcon,
  deleteCellHyperlink, deleteCellHighlight, getCellHighlight, deleteCellSort,
  deleteFillSubmit, deleteSheet, deleteStyle, deleteParameterWidget, renameParameterWidget, updateParameterWidget, deletePageHeaderFooter, deleteMobileWidgetRef, setReportImports,
  updateCellHyperlink, updateCellHighlight, updateCellListener, deleteCellListener, getCellListener,
  updateCellSort, getCellSort, getFloatElement, updateFloatElement, updateFillSubmit, updateSheet,
  clearWidgetValue,
  getChart, updateChart,
} from './lib/edits.js';
import {
  createCpt, addDataset, addFileDataset, addTreeDataset, addStyle, addCell, addSheet, addFillSubmit,
  setReportSettings, setParameterPanel, setGrid, addParameterWidget, setPageHeaderFooter, setTemplateTheme,
  addFloatElement,
} from './lib/generate.js';
import {
  addDatasetBatch, deleteDatasetBatch, updateDatasetBatch, getDatasetBatch,
  addParameterBatch, deleteParameterBatch, updateParameterBatch, getParameterBatch,
  addParameterWidgetBatch, deleteParameterWidgetBatch, updateParameterWidgetBatch, getParameterWidgetBatch,
  addStyleBatch, deleteStyleBatch, updateStyleBatch, getStyleBatch,
  getCellBatch,
  addFillBindingBatch, deleteFillBindingBatch, updateFillBindingBatch, getFillBindingBatch,
  addFillSubmitBatch, deleteFillSubmitBatch, updateFillSubmitBatch, getFillSubmitBatch,
  addChartBatch, deleteChartBatch, updateChartBatch, getChartBatch,
  addFloatElementBatch, deleteFloatElementBatch, updateFloatElementBatch, getFloatElementBatch,
  addCellHyperlinkBatch, deleteCellHyperlinkBatch, updateCellHyperlinkBatch, getCellHyperlinkBatch,
  addCellHighlightBatch, deleteCellHighlightBatch, updateCellHighlightBatch, getCellHighlightBatch,
  deleteCellListenerBatch, updateCellListenerBatch, getCellListenerBatch,
  addReportListenerBatch, deleteReportListenerBatch, updateReportListenerBatch, getReportListenerBatch,
  addToolbarButtonBatch, deleteToolbarButtonBatch, updateToolbarButtonBatch, getToolbarButtonBatch,
  addCellSortBatch, deleteCellSortBatch, updateCellSortBatch, getCellSortBatch,
  addScheduleBatch, deleteScheduleBatch, updateScheduleBatch, getScheduleBatch,
  addSheetBatch, deleteSheetBatch, updateSheetBatch, getSheetBatch,
  addPageHeaderFooterBatch, deletePageHeaderFooterBatch, updatePageHeaderFooterBatch, getPageHeaderFooterBatch,
} from './lib/batch.js';
import { addTask, listTasks, getTask, removeTask, enableTask, disableTask, runTask,
  schedulerStatus, schedulerHistory, stopScheduler, listActions, getScheduler, computeNextRun,
} from './lib/schedule.js';
import { detectFrHome } from './lib/fr-decompile.js';
import { inspectFrInstallation } from './lib/fr-decompile.js';
import { capabilityManifest } from './lib/capabilities.js';
import { qualityGate, buildProgress } from './lib/quality.js';
import { planCellBatch, applyCellBatch } from './lib/cell-batch.js';
import { diagnoseFillRowIntegrity } from './lib/fill-integrity.js';
import { DeepToolManager, DEEP_TOOL_GROUPS, toolForFields } from './lib/deep-tools.js';
import { FULL_ONLY_WAIVERS, assertReachability } from './lib/reachability.js';
import { CptReadGate, readCptCompact, CPT_READ_VIEWS } from './lib/read-gate.js';
import { assertToolPath, assertCriticalIntParams } from './lib/security.js';
// 2026-10-29 整理：工具级安全围栏（JS 授权/外部 URL/数据文件/反编译输出）移入声明式策略表，
// tool() 包装层不再按工具名散落 ~95 行 if 分支。
import { runToolGuards } from './lib/tool-guards.js';
// 2026-10-29：显式加载 JS 块基线模块 —— 它通过 lib/write-hooks.js 订阅 xml.save 的写后钩子
// （依赖倒置后不再由 xml.js 静态 import 本模块）。这里显式 side-effect import 保证
// server 进程任何时候 save 都会刷新基线，不依赖「validate/quality 恰好先被 import」的隐式顺序。
// 2026-11-03 C-C：同时取 resetJsBaseline —— validate_cpt 的 resetJsBaseline:true 开关直接调它。
import { resetJsBaseline } from './lib/js-baseline.js';

// ---- 工具边界提示 (S6 修复) ----
// 问题: 模型默认把任何 SQL/数据/报表相关请求理解为"调 cpt-mcp 写入工具改 .cpt"
// 修复: 给所有【写入类】工具追加边界提示, 让模型只在用户明确要求"改 .cpt"时才调
// 实现: server.js 顶部定义边界常量, server.tool() 调用时通过 .describe() 包装
// M118 瘦身：原 157 B 全文（"会改.cpt且不可撤销：仅用户明确要求改报表时调用，否则纯文本
// 回答；细则见instructions，调用前先read_cpt。"）在每个写工具描述尾部各重复一份，
// 实测 report 档 14 个写工具共重复 2198 B（占该档 5.7%）。
// 改为**自包含的短标记**：保留全部三条语义（不可撤销 / 仅明确要求时调 / 先 read_cpt），
// 只是去掉"细则见instructions"这句跨引用——跨引用会迫使 instructions 再复述一遍，
// 实测那反而更贵（instr +681 B 换 tools −826 B，净亏）。现在不再需要 instructions 承接。
const TOOL_BOUNDARY_HINT = '【边界·S6】会改.cpt且不可撤销：仅用户明确要求时调，调用前先 read_cpt。';

/** 派生产物类写工具的中性边界提示（2026-11-07 P1）：注解上是写，但不改 .cpt 正文。
 *  用于 run_fr_engine_check / local_db_* / schedule_* / fr_decompile / fr_preview_* ——
 *  避免模型把「本地建库」「跑真引擎」「装定时任务」误判成会破坏用户模板而不敢调用。
 *  体量与 TOOL_BOUNDARY_HINT 同档（≤120 B），边界测试按档分别断言。 */
const TOOL_BOUNDARY_HINT_DERIVED = '【边界·S6】只写派生产物（引擎报告/本地库/调度），不改 .cpt 正文。';

/** 包装写入类工具描述, 在尾部追加边界提示（2026-11-07 P1 分两档）:
 *  ① 会改 .cpt 正文（S6_TEMPLATE_WRITE_TOOLS）→ TOOL_BOUNDARY_HINT（强约束）；
 *  ② 只写派生产物（S6_DERIVED_WRITE_TOOLS）→ TOOL_BOUNDARY_HINT_DERIVED（中性，不吓退建库/跑引擎）；
 *  ③ 核验类（NON_TEMPLATE_WRITE_TOOLS）→ 不挂。
 *  三档集合的单一事实源是 lib/contract.js（勿在此手写第二份名单）；test/write-boundary.test.js
 *  断言三档两两不相交、并集 = 全部写类工具，且运行时的描述与档位逐条一致。 */
function withWriteBoundary(name, desc) {
  if (NON_TEMPLATE_WRITE_TOOLS.has(name)) return desc;
  if (S6_DERIVED_WRITE_TOOLS.has(name)) return desc + TOOL_BOUNDARY_HINT_DERIVED;
  if (S6_TEMPLATE_WRITE_TOOLS.has(name)) return desc + TOOL_BOUNDARY_HINT;
  return desc;
}

// 安全围栏契约（instructions + 工具注解）统一放在 lib/contract.js，
// 与 scripts/verify-mcp.mjs 共用同一份定义，避免两处清单漂移。
import {
  CPT_MCP_INSTRUCTIONS, annotateFor,
  READ_ONLY_TOOLS, DESTRUCTIVE_TOOLS, IDEMPOTENT_WRITE_TOOLS, APPEND_WRITE_TOOLS, DEEP_TOOLS,
  NON_TEMPLATE_WRITE_TOOLS, S6_TEMPLATE_WRITE_TOOLS, S6_DERIVED_WRITE_TOOLS,
  REPORT_STATIC_TOOLS, SECTION_REFS, selectSpecSections, specSectionProblems,
} from './lib/contract.js';
// 轻 entry（L1 路线 B）：广告 schema 只声明高频字段，巨块参数语义按节下发（lib/spec-sections.js）。
import { LIGHT_TOOLS } from './lib/light-schemas.js';

const server = new McpServer(
  { name: 'cpt-mcp', version: '1.0.0' },
  {
    capabilities: { tools: {} },
    // 安全围栏：把边界 / 工作流 / 铁律前移到 tools/list 阶段，模型动手前即可读到
    instructions: CPT_MCP_INSTRUCTIONS,
  }
);

// 渐进式工具暴露：弱模型只看见完成当前类型任务所需的工具，避免全部 schema 一次性占满上下文；
// 完整入口（CPT_MCP_TOOL_PROFILE=full / node server-full.js）仍注册全部工具，不牺牲能力覆盖。
// 2026-10-26 自包含化：默认档位为 report（业务完整面，静态表见 lib/contract.js），
// 不依赖宿主预设额外注入 CPT_MCP_TOOL_PROFILE；focused 仍可用显式 env 选择（弱模型省 token）。
const TOOL_PROFILE = process.env.CPT_MCP_TOOL_PROFILE ?? 'report';

// 自主核验开关（2026-10-26）：
//   off       —— 关闭写工具自动自检（只保留显式 verify_cpt）
//   structure —— 默认：每次写成功后自动跑 结构校验 + 交付门禁（毫秒级、纯本地）
//   engine    —— 追加真实 FR 引擎加载（5~15s，结果有缓存；只建议在交付前一轮开）
const AUTO_VERIFY_MODE = String(process.env.CPT_MCP_AUTO_VERIFY ?? 'structure').toLowerCase();
// 2026-11-12 P0-2：门禁/校验默认出摘要（部署侧 CPT_MCP_GATE_BRIEF=1 打开；brief:false 取完整明细）。
const GATE_BRIEF_DEFAULT = String(process.env.CPT_MCP_GATE_BRIEF ?? '0') === '1';
const resolveBrief = (brief) => (brief === undefined ? GATE_BRIEF_DEFAULT : brief === true);
/** 缓存命中时给结论挂 cached 标记（不改变结论字段本身） */
const withCacheInfo = (payload, hit) => ({
  ...payload,
  cached: true,
  cachedAgeSeconds: hit.ageSeconds,
  cacheNote: '模板文件与参数未变化，复用上次结论（任何写入/引擎报告/本地库变化后自动重算）',
});
// 深层工具租约 + 读取门禁的运行时；full 入口静态全量暴露（不走租约强制）
const deepTools = new DeepToolManager();
const readGate = new CptReadGate();
if (TOOL_PROFILE === 'full') deepTools.staticExpose = true;
// 3 个编排工具进所有 profile：它们是深层工具与紧凑读取的入口本身。
// batch_mutate_cells 已下沉为深层工具（report_rewrite 组），不再静态进 profile，
// 需先 request_deep_tool_access(group=report_rewrite) 租约解锁。
const ORCHESTRATION_TOOLS = ['request_deep_tool_access', 'record_cpt_read_intent', 'read_cpt_compact'];
// focused 集合独立成常量：report 档 = focused + 报表 persona 缺失的读取/建数据集工具
const FOCUSED_TOOLS = new Set([
  'get_capabilities', 'read_cpt', 'generate_report', 'build_report', 'validate_cpt',
  'get_cell_style', 'update_cell_style', 'update_cell', 'update_dataset',
  'set_report_settings', 'set_grid', 'set_page_header_footer',
  'quality_gate_cpt', 'get_build_progress', 'verify_cpt',
  // M92 JS 语法行号：排错会话曾因 check_report_js 不可见而人肉逐行验 77 步未果；
  // 只读+V8 纯解析不执行，进 focused（report 自动继承），validate 的 fix 指引至此闭环
  'check_report_js',
  // 验收测试发现：原 focused 是纯修改导向，无法从零建表 —— 补最小建表集
  'create_cpt', 'add_dataset', 'add_style', 'add_cell', 'add_fill_submit',
  // 报表JS：给已有模板加一段页面加载时执行的 JS（高频修改诉求）
  'set_report_js',
  // 参数面板：改模板参数控件（含转下拉多选 comboCheckBox 场景）是高频诉求，必进 focused
  'get_parameter_panel', 'set_parameter_panel', 'add_parameter_widget', 'update_parameter_widget', 'delete_parameter_widget',
  // 单元格监听器：商品格/控件事件 JS（stopedit/click/afterinit 等）读写是高频诉求，必进 focused
  // （注意：监听器不在 DEEP_TOOLS 租约体系内——申请 report_rewrite 租约拿不到，需直接进 profile）
  'get_cell_listener', 'add_cell_listener', 'update_cell_listener', 'delete_cell_listener',
  // M91 单元格下拉字典：改存量格取数表字典 ki/vi（如 outer_id→spec_id 平齐）是 V3 高频诉求，
  // 此前无结构化入口只能裸改 XML（V3-historical-commit 误删 FormulaDictAttr），必进 focused
  'update_cell_dictionary',
  // M96 单元格下拉字典读取：核对下拉显示哪列/选项来自哪张表（如 sheet2-C15 ki/vi=spec_id 取 ds_goods）
  // 是 V3 高频诉求；此前读半边空着只能三重证据推定。只读，与 M91 写入口闭环，必进 focused
  'get_cell_dictionary',
  // 报表级 Listener（afterload/onload JS 全文读写）：改 rowCalc 等报表事件脚本是高频诉求，必进 focused
  'get_report_listener', 'set_report_listener',
  // WebWriteContent 监听器（填报 Web 事件 JS 全文读写）：改 Q.cost/Q.combo/frFin 等挂 WebWrite 下的脚本是高频诉求，必进 focused
  'get_webwrite_js', 'set_webwrite_js',
  // M93 工具栏按钮读写：改存量按钮 JS（规格ID补行/下载模板/重算按钮类收尾）是 V3 高频诉求；
  // 此前 focused/report 无工具栏工具，排错会话只能整块裸改（set#2 事故）。只进读+改，增删移保留 full。
  'list_toolbar_buttons', 'set_toolbar_button_js',
  ...ORCHESTRATION_TOOLS,
]);
const PROFILE_TOOLS = {
  // generate profile 面向弱模型：主写路径是 generate_report（另含 3 个编排入口），
  // 交付判定靠 quality_gate_cpt，工序顺序靠 get_build_progress —— 原语被拿走，
  // "想到哪做到哪"没有发挥空间；深层工具（含 batch_mutate_cells）凭租约按需解锁
  generate: new Set(['get_capabilities', 'read_cpt', 'generate_report', 'validate_cpt', 'quality_gate_cpt', 'get_build_progress', ...ORCHESTRATION_TOOLS]),
  focused: FOCUSED_TOOLS,
  // report profile（默认档）：报表业务的完整静态面；不绑定任何宿主 persona。
  // 名单的单一来源是 lib/contract.js 的 REPORT_STATIC_TOOLS（判据逐条写在那里，服务器不重复计数）：
  // 门/协议 5 + 通用只读原语 12 + 静态批量 2 + 每任务必用写原语 9 + 整表生成 1 + 交付门禁 4 = 33 项。
  // 不再用"focused + 追加"写法：focused 是弱模型省 token 的精选子集，两者目标不同，
  // 叠加写法会让 report 跟着 focused 一起膨胀（历史上就这样漂到 57 项 / 150 KB）。
  // 其余能力按场景族下沉（lib/lease-groups.js：16 个场景族 + 既有 5 个门禁/特殊组），租约一次解锁整族；
  // 未编组的长尾走 adhoc 按名直租 —— 能力全部可达，只是"什么时候付 token"。
  report: new Set(REPORT_STATIC_TOOLS),
};
if (!['full', ...Object.keys(PROFILE_TOOLS)].includes(TOOL_PROFILE)) {
  throw new Error(`CPT_MCP_TOOL_PROFILE 非法：${TOOL_PROFILE}（可用 full/focused/report/generate）`);
}

// M104 静态按需暴露：CPT_MCP_EXTRA_TOOLS=逗号分隔的工具名，合并进当前档静态表，重启生效。
// 定位：默认只给小集合（省 token/防幻觉），其余默认隐藏；确实需要时在配置里一次声明，
// 运行时不再走 request_deep_tool_access 临租（不做按次审批）。拼错名启动即抛错，不静默失效。
// 例：CPT_MCP_EXTRA_TOOLS=set_fill_toolbar,get_chart CPT_MCP_TOOL_PROFILE=report node server.js
const EXTRA_TOOLS = String(process.env.CPT_MCP_EXTRA_TOOLS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
if (TOOL_PROFILE !== 'full' && EXTRA_TOOLS.length > 0) {
  for (const t of [...new Set(EXTRA_TOOLS)]) PROFILE_TOOLS[TOOL_PROFILE].add(t);
}

/** 全量已注册工具名（M102 可达性断言与 adhoc 校验用；在 tool() 内逐个登记） */
const ALL_TOOL_NAMES = new Set();
// M102 可达性豁免表本体在 lib/reachability.js（FULL_ONLY_WAIVERS，可 import 单测）。
// 新工具三选一：进某档静态名单 / 进某租约组 / 在豁免表加条目并写理由——否则启动断言抛错。

/** 注册写入类工具 (description 自动追加 S6 边界提示, 并按语义附加 MCP 工具注解) */
// —— 为什么统一 .strict() ——
//   zod 的 object 默认会「静默剥离」输入里未在 schema 声明的字段。
//   对 LLM 来说这是最坏的一类失败：模型以为自己传了参数（比如 add_dataset 的 embedded、
//   或把 font_size 写成了 fontSize），工具却当它没传，照默认行为跑出一个看似成功、实则跑偏的结果。
//   改成 strict 后，拼错/臆造的参数会立刻变成一条明确报错，模型下一轮就能自我纠正。
//   这是「避免模型跑偏」里成本最低、覆盖面最大的一道围栏。
// —— 轻 entry（L1 路线 B）的广告/校验分离 ——
// 广告 schema（opts.advertise）只声明高频字段并用 .passthrough() 放行其余字段；
// **处理器入口**再用该工具原有的完整 schema（z.object(schema).strict()）严格复核，
// 并把解析结果（含默认值与类型转换）交给处理器。这样：
//   ① 上下文里只留"调用契约"（高频字段 + 一句去哪取说明），巨块参数语义按节下发；
//   ② 既有能力一个都不丢——未广告的字段透传到完整 schema，绝不静默剥离；
//   ③ 失败仍精确到字段名，并附上"该字段所属的节"（错误即文档，一次往返闭环）。
const LIGHT_OPTS = Object.fromEntries(
  Object.entries(LIGHT_TOOLS).map(([name, def]) => [name, { advertise: def.advertised, desc: def.description }]),
);

/**
 * 把 zod 校验失败渲染成「字段级错误 + 合法字段清单 + 节引用」（"错误即文档"兜底）。
 *
 * 2026-10-26 强化（v1 会话实测）：27 次硬失败里 17 次是"键名猜错"，而原报错只回 zod 原文
 * （`Unrecognized key: "items"`），既不说该处到底能传什么、也触发不到节引用提示，
 * 模型只能一轮轮试键名。现在对 unrecognized_keys / invalid_enum_value / invalid_type
 * 三类高频错误补上「可用字段」「可用取值」「期望类型」。
 */
function formatArgIssues(name, error, schema) {
  const issues = (error?.issues ?? []).map((i) => {
    const at = i.path?.length ? i.path.join('.') : '(根)';
    let msg = `${at}: ${i.message}`;
    try {
      if (i.code === 'unrecognized_keys') {
        const allowed = allowedKeysAt(schema, i.path || []);
        msg += allowed.length
          ? `（该处可用字段：${allowed.join(', ')}）`
          : '（该处不接受额外字段；请删掉未知键）';
      } else if (i.code === 'invalid_enum_value' || i.code === 'invalid_value' || i.code === 'invalid_literal') {
        const opts = i.options ?? (i.expected !== undefined ? [i.expected] : []);
        if (opts.length) msg += `（可用取值：${opts.map((v) => JSON.stringify(v)).join(' / ')}）`;
      } else if (i.code === 'invalid_type') {
        msg += `（期望 ${i.expected}${i.received ? `，收到 ${i.received}` : ''}）`;
      } else if (i.code === 'too_small' && i.minimum !== undefined) {
        msg += `（最小 ${i.minimum}）`;
      } else if (i.code === 'too_big' && i.maximum !== undefined) {
        msg += `（最大 ${i.maximum}）`;
      }
    } catch {
      // 提示构造失败不影响主错误信息
    }
    return msg;
  });
  const refs = SECTION_REFS[name] ?? [];
  const hint = refs.length ? `；完整参数说明见 get_capabilities({tool:"${name}", section:"${refs[0]}"})` : '';
  return `${name} 参数校验失败：${issues.join(' ｜ ')}${hint}`;
}

function tool(name, desc, schema, handler, opts = {}) {
  ALL_TOOL_NAMES.add(name);
  const inProfile = TOOL_PROFILE === 'full' || PROFILE_TOOLS[TOOL_PROFILE].has(name);
  const isDeep = DEEP_TOOLS.has(name);
  // M121 修死锁：深层工具若声明里没有 path 参数（机器级/全局：fr_detect、fr_inspect、
  // scheduler_status/stop/actions），它无从携带 path —— 若仍按"路径必须匹配"去筛租约，
  // 绑了 path 的租约永远命中不了，granted 之后照样永久"未授权"。登记下来让 beforeCall 跳过该约束。
  if (isDeep && !('path' in schema)) deepTools.markPathless(name);
  // M102：删掉原来的 `if (!inProfile && !isDeep) return`——那行是“存在但不可达”的根因
  // （非深层黑户连定义都不留，adhoc 想租都没处租）。现三向分流在下游完备：
  // 深层黑户→PENDING_DEEP / 非深层黑户→PENDING_ADHOC / 其余→静态注册。
  const advertised = opts.advertise ?? schema;
  // 装配期自检（2026-10-29）：轻 entry 广告层字段必须是完整 schema 的子集。
  // 广告层"只宽不严"——模型看得见的字段必须能被处理器接受；反过来（广告了 strict 不认的
  // 字段）会让模型按文档传参却被 Unrecognized key 拒绝，v1 会话的 force/formula 漂移即此类。
  if (opts.advertise && opts.advertise !== schema) {
    const phantom = Object.keys(opts.advertise).filter((key) => !(key in schema));
    if (phantom.length > 0) {
      throw new Error(`[装配错误] ${name} 的广告 schema 含完整 schema 未接纳的字段：${phantom.join('、')}（广告层字段必须 ⊆ 处理器接受的字段）`);
    }
  }
  // 2026-10-26 P0（v1 会话实测）：严格校验统一**下移到处理器入口**。
  //   旧行为：非轻 entry 工具把 .strict() 挂在广告 schema 上 → MCP SDK 先于处理器拒收
  //   （validateToolInput 在 CallTool 里先跑），模型只能看到 "MCP error -32602 ...
  //   Unrecognized key: x"（无合法键清单、也触发不到 formatArgIssues）。
  //   新行为：SDK 侧只保留「字段类型 + 描述」做文档与轻校验，必填/嵌套严格性/需映射的值
  //   全部下移到处理器（sdkLenientShape 逐字段说明）；处理器入口先 normalizeArgs 做别名归一，
  //   再用 fullSchema 严格校验，报错带「该处可用字段」。
  const fullSchema = z.object(schema).strict();
  const config = {
    description: withWriteBoundary(name, opts.desc ?? desc),
    inputSchema: z.object(sdkLenientShape(name, advertised)).passthrough(),
    annotations: annotateFor(name),
  };
  const cb = async (args, extra) => {
      // 参数契约三件套：别名归一 → 严格校验（报错带合法键）→ 用解析结果（含默认值/类型转换）
      const { args: normalizedArgs, fixes: argFixes } = normalizeArgs(name, args, schema);
      // 缺必填参数给可读报错：否则 z.coerce.number() 会把 undefined 变 NaN，报
      // "expected number, received NaN"（真实会话里 delete_cell_range 就是这样翻车的）。
      const missing = missingRequiredArgs(schema, normalizedArgs);
      if (missing.length > 0) {
        throw new Error(`${name} 缺少必填参数：${missing.join('、')}（完整参数说明见 get_capabilities({tool:"${name}"})）`);
      }
      const parsed = fullSchema.safeParse(normalizedArgs);
      if (!parsed.success) throw new Error(formatArgIssues(name, parsed.error, schema));
      args = parsed.data;
      // 第 3 层围栏：schema 只解决类型，路径/副作用必须在运行时再次判断。
      // 深层工具先过租约闸（越权/超次直接抛错并消耗 1 次额度），再进常规围栏。
      const lease = deepTools.beforeCall(name, args);
      // P2-1 关键整数断言：column/row 空串与布尔值的 coerce 静默转义在此拦截（数字/纯数字字符串不受影响）
      assertCriticalIntParams(name, args);
      try {
        if (args?.path) {
          // 2026-11-06：verify_cpt 注解上归写（engine=true 会落盘 .fr-engine-check / spawn npm），
          // 但 engine=false 时是纯读核验 —— 路径策略按**实际副作用**取，保留"只读核验 FR 官方样本"的能力。
          // 2026-11-07：validate_cpt / quality_gate_cpt 同样只写自有缓存（js-baseline / 租约状态），
          // 不改 .cpt 相邻文件，故一律按只读副作用放行（否则核验 FR 官方样本会回退成硬拒绝）。
          const pathFenceReadOnly = (name === 'verify_cpt' && args.engine === false)
            || name === 'validate_cpt' || name === 'quality_gate_cpt';
          assertToolPath(name, args.path, { write: name !== 'fr_decompile' && !READ_ONLY_TOOLS.has(name) && !pathFenceReadOnly });
        }
      // 工具级安全围栏（策略表见 lib/tool-guards.js）：JS 授权 / 外部 URL / 数据文件路径 /
      // 反编译输出 / 定时任务副作用——与租约闸、路径围栏同级，在 handler 之前。
      runToolGuards(name, args);
      const result = await handler(args, extra);
      deepTools.afterCall(lease);
      // P0-1 额度将尽预警：剩 ≤20% 时把 leaseWarning 注入返回体，模型不用靠数调用次数盲猜。
      // 失败抛错路径已有明确文案（用尽/过期/路径不匹配），此处只处理成功路径的 JSON 返回体。
      const leaseWarn = deepTools.warningFor(lease);
      if (leaseWarn && result?.content?.[0]?.type === 'text') {
        try {
          const data = JSON.parse(result.content[0].text);
          if (data && typeof data === 'object' && !Array.isArray(data) && !data.leaseWarning) {
            result.content[0].text = JSON.stringify({ ...data, leaseWarning: leaseWarn }, null, 2);
          }
        } catch {
          // 非 JSON 返回体不注入
        }
      }
      // 别名纠正回执：让模型下一轮直接用规范字段名（不改变返回体 JSON 结构，追加一条 text）
      if (argFixes.length && result && Array.isArray(result.content)) {
        const note = formatFixes(argFixes);
        if (note) result.content.push({ type: 'text', text: note });
      }
      
      // 自主核验（2026-10-26）：写工具成功后自动跑结构+门禁自检，结论随结果返回（selfCheck）。
      // 自检本身失败不得影响写操作结果：整体 try/catch 吞掉。
      // 例外：NON_TEMPLATE_WRITE_TOOLS（verify_cpt / validate_cpt / quality_gate_cpt）本身就是核验入口，
      // 再挂一遍等于同一套校验跑两次（自检小循环没有信息增量，还会写一遍 js-baseline）。
      if (AUTO_VERIFY_MODE !== 'off' && !READ_ONLY_TOOLS.has(name) && !NON_TEMPLATE_WRITE_TOOLS.has(name) && typeof args?.path === 'string' && /\.cpt$/i.test(args.path)) {
        try { await attachSelfCheck(result, args.path, AUTO_VERIFY_MODE === 'engine'); } catch { /* 核验失败不影响写结果 */ }
      }
      return result;
      } catch (e) {
        deepTools.afterCall(lease);
        throw e;
      }
  };
  // t2 真隐藏：非 full 下 profile 之外的深层工具只暂存定义、不注册（无 disabled 占位）；
  // 租约授予后经回调动态注册，失效后动态注销。full 仍静态全量。
  if (isDeep && !deepTools.staticExpose && !inProfile) {
    PENDING_DEEP_TOOLS.set(name, { config, cb });
    return;
  }
  // M102 adhoc 暂存：非深层、非本档静态暴露的工具同样暂存定义（不注册），
  // 供 group=adhoc 按名直租时动态注册。full 档不受影响（全部静态注册）。
  if (!isDeep && !deepTools.staticExpose && !inProfile) {
    PENDING_ADHOC_TOOLS.set(name, { config, cb });
    return;
  }
  const registered = server.registerTool(name, config, cb);
  if (isDeep) deepTools.register(name, registered, { expose: inProfile });
}

// t2 真隐藏动态注册表（位于首个 tool() 调用之前，保证暂存/回调在注册前就绪）
const PENDING_DEEP_TOOLS = new Map(); // name -> { config, cb }：未解锁深层工具定义
const PENDING_ADHOC_TOOLS = new Map(); // name -> { config, cb }：未解锁非深层工具定义（M102 adhoc 直租用）
const LIVE_DYNAMIC_DEEP = new Map(); // name -> registered handle：租约期内动态注册中的工具
deepTools.onDynamicRegister = (names) => {
  for (const name of names) {
    if (LIVE_DYNAMIC_DEEP.has(name)) continue;
    const def = PENDING_DEEP_TOOLS.get(name) ?? PENDING_ADHOC_TOOLS.get(name);
    if (!def) continue;
    LIVE_DYNAMIC_DEEP.set(name, server.registerTool(name, def.config, def.cb));
  }
};
deepTools.onDynamicUnregister = (names) => {
  for (const name of names) {
    const handle = LIVE_DYNAMIC_DEEP.get(name);
    if (!handle) continue;
    LIVE_DYNAMIC_DEEP.delete(name);
    handle.remove(); // SDK：从注册表删除 + 发送 tools/list_changed
  }
};

const pathSchema = z.string().min(1)
  .regex(/\.cpt$/i, '路径必须以 .cpt 结尾（本 MCP 仅处理 FineReport CPT 模板）')
  .refine(
    (p) => /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('\\\\') || p.startsWith('/'),
    '路径必须是绝对路径 (Windows: C:\\... 或 \\\\server\\...; Linux: /...)'
  )
  .describe('CPT 绝对路径（.cpt 结尾）');

// S1 布尔参数围栏：z.coerce.boolean 会把字符串 "false"/"0" 静默转成 true
// （Boolean("false") === true），isKey/bold/fromEnv 这类语义翻转必须拦下。
// 只接受 boolean 或 true/false/yes/no/1/0/on/off 字符串，其余明确报错。
const boolish = z.union([z.boolean(), z.stringbool()]);

// P2-1 关键整数断言：z.coerce.number 会把 ""/"  "/true 静默转成 0/1（Number("")===0），
// 单元格坐标 column/row 传空串会静默读写第 0 列/行。与 S1 boolish 同一口径：
// 空串与布尔值显式拒绝；数字与纯数字字符串照常放行并转数字；非整数/越界仍按原链拒绝。
// 用 ctx.addIssue 而非 throw —— 普通 Error 会穿透 safeParse，破坏调用方的错误处理约定。
const intParam = z.union([z.number(), z.string(), z.boolean()]).transform((v, ctx) => {
  const fail = (message) => { ctx.addIssue({ code: 'custom', message }); return z.NEVER; };
  if (typeof v === 'boolean') return fail('column/row 不接受布尔值（z.coerce 会静默转成 0/1；请传 0 起的整数）');
  if (typeof v === 'string') {
    if (!v.trim()) return fail('column/row 不接受空字符串（z.coerce 会静默转成 0 导致读写错列/行；请传 0 起的整数或纯数字字符串）');
    const n = Number(v);
    if (!Number.isInteger(n)) return fail(`column/row 非法 "${v}"（须为整数）`);
    return n;
  }
  if (!Number.isInteger(v)) return fail('column/row 须为整数');
  return v;
});
const nonNegIntParam = z.union([z.number(), z.string(), z.boolean()]).transform((v, ctx) => {
  const fail = (message) => { ctx.addIssue({ code: 'custom', message }); return z.NEVER; };
  if (typeof v === 'boolean') return fail('column/row 不接受布尔值（z.coerce 会静默转成 0/1；请传 0 起的整数）');
  if (typeof v === 'string') {
    if (!v.trim()) return fail('column/row 不接受空字符串（z.coerce 会静默转成 0 导致读写错列/行；请传 0 起的整数或纯数字字符串）');
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0) return fail(`column/row 非法 "${v}"（须为 0 起的整数）`);
    return n;
  }
  if (!Number.isInteger(v) || v < 0) return fail('column/row 须为 0 起的整数');
  return v;
});

// T4/S5：工作表参数 schema 以 spec.js 的 sheetParamSchema 为单一事实源（导入改名见下方 import 行）
const sheetSchema = sheetParamSchema;

// t3 描述瘦身：高频参数描述的单一事实源（短引用）。只改 .describe() 文案，不改校验语义。
const SHEET_DESC = '工作表（0起索引/名称，缺省首表）';
// P0-2：门禁/校验的 brief 参数（放在 schema 助手之后定义，避免 TDZ）
const briefParam = boolish.optional().describe('true=摘要（省上下文）；false=完整明细');
const COLUMN_DESC = '列号（0起）';
const ROW_DESC = '行号（0起）';
const UNSAFE_JS_DESC = '安全开关：确认后传true，允许写可执行JS';
const JS_IMPL_DESC = 'JS实现类名';

// 片段替换 / 缩水护栏 / 自卫哈希的通用参数描述（单一事实源）。
// 适用：set_webwrite_js / set_report_listener / set_webpage_js / set_report_js / set_toolbar_button_js / update_cell_listener。
// 2026-11-03：patchFind 匹配已兼容 FR 设计器转义 `]A`（`]` 的落盘编码）——净文本 `]` 与落盘 `]A`
// 两种写法都能命中；回写保持 `]A` 编码（官方语料 237 个 `]` 100% 为 `]A`，见 lib/cpt.js 定案注释）。
const PATCH_FIND_DESC = '片段替换目标：要替换的原文片段（literal，不解释正则；与 js 互斥）。大块共享 JS 只改一段时用它，避免整块替换丢功能；已兼容设计器转义：净文本 `]` 与落盘 `]A` 均可命中';
const PATCH_REPLACE_DESC = '片段替换文本（可空串=删除该片段；仅配合 patchFind；视为 JS，需 allowUnsafeScript=true；回写保持设计器 `]A` 转义编码，已带 `]A` 的不双重编码）';
const PATCH_ALL_DESC = '片段替换允许多处：默认 patchFind 必须唯一命中，true 才替换全部命中处（仅 patch 模式有效）';
const ALLOW_SHRINK_DESC = '整块替换放行开关：大块（≥4KB）被替换成 <60% 且少 ≥2KB 时默认拒绝（防止静默丢功能）；确认是有意整块重写才传 true';
const EXPECTED_SHA_DESC = '自卫哈希：读回的 sha256；传了则在 patch/整块替换/删除前核对目标块，不符拒绝且不写文件';

// 原语滥用软提示：按模板路径记录"连续使用骨架样式 0 的 add_cell"次数
const addCellStyle0Run = new Map();
const ADD_CELL_STYLE0_HINT_AT = 5;

// ---------------- 读 ----------------

tool('get_capabilities', '读取 cpt-mcp 的能力清单、推荐工作流、明确不支持项、工具分类和当前安全策略。生成或修改前优先调用。',
  {
    tool: z.string().min(1).optional().describe('可选：取该工具的完整参数说明与所属节'),
    group: z.string().min(1).optional().describe('可选：只列某场景族的成员、策略与解锁调用'),
    section: z.string().min(1).optional().describe('可选：只取某节参数说明（节键或前缀，如 cell.dictionary / spec.）'),
    leases: boolish.optional().describe('可选：true=附带当前各租约剩余额度与过期秒数'),
  },
  async (args) => {
    const manifest = capabilityManifest(args);
    // P0-1：剩余额度按需下发（只在显式查询时进上下文，不占每请求的 tools/list）。
    if (args?.leases === true) return ok({ ...manifest, activeLeases: deepTools.leaseStatus() });
    return ok(manifest);
  },
  LIGHT_OPTS.get_capabilities);

tool('get_build_progress', '读取构建工序进度（按推荐顺序从模板现状推导，不靠模型记忆）：数据集→样式→单元格与扩展→网格→页面→参数面板→填报→质量门槛→引擎校验。已并入 read_cpt({includeProgress:true})，本独立工具默认隐藏（generate 档仍静态），不要优先使用。',
  { path: pathSchema },
  async ({ path: p }) => ok(buildProgress(p)));

const EXPECTATIONS_SCHEMA = z.object({
  cells: z.coerce.number().int().min(0).optional().describe('期望单元格数'),
  styles: z.coerce.number().int().min(0).optional().describe('期望样式数'),
  toolbarButtons: z.coerce.number().int().min(0).optional().describe('期望自定义工具栏按钮数'),
  submits: z.coerce.number().int().min(0).optional().describe('期望提交数'),
  fillBindings: z.coerce.number().int().min(0).optional().describe('期望填报绑定数'),
  datasets: z.coerce.number().int().min(0).optional().describe('期望数据集数'),
  sheets: z.coerce.number().int().min(0).optional().describe('期望工作表数'),
  bytesMin: z.coerce.number().int().min(0).optional().describe('期望文件字节下限'),
  bytesMax: z.coerce.number().int().min(0).optional().describe('期望文件字节上限'),
  hasText: z.array(z.string()).optional().describe('必须出现的文本片段'),
  notHasText: z.array(z.string()).optional().describe('不得出现的文本片段'),
  toolbarButtonTexts: z.array(z.string()).optional().describe('必须存在的按钮文字'),
}).partial();

tool('verify_cpt', '【自主核验】一次跑完：结构 + 门禁（含本地SQL，缺库跳过）+ 期望值对账 +（可选）真实 FR 引擎加载，返回分层结论。写工具自动带 selfCheck（CPT_MCP_AUTO_VERIFY 控制），交付前建议显式跑一次 engine=true。brief=true 回摘要；同文件同参复用上次结论（cached=true）。',
  {
    path: pathSchema,
    engine: boolish.default(true).describe('跑真引擎加载（需本机装FR，5~15s，有缓存）'),
    expectations: EXPECTATIONS_SCHEMA.optional().describe('期望值对账：数量/文本/按钮，不符即 blocker'),
    timeoutMs: z.coerce.number().int().min(1000).max(600000).optional().describe('引擎层超时（毫秒）'),
    brief: briefParam,
  },
  async ({ path: p, engine, expectations, timeoutMs, brief }) => {
    const useBrief = resolveBrief(brief);
    const localSqlAudit = String(process.env.CPT_MCP_VERIFY_LOCAL_SQL ?? '1') !== '0';
    const options = { engine: engine !== false, expectations: expectations ?? null, timeoutMs: timeoutMs ?? null, localSqlAudit };
    const deps = { engine: true, localSql: localSqlAudit };
    // engine=true 会写引擎报告；本地 SQL 审计读本地库 —— 外部状态都进指纹，避免复用过期结论
    const fpBefore = gateFingerprint(p, deps);
    const hit = cacheLookup('verify_cpt', p, options, fpBefore);
    if (hit) return ok(withCacheInfo(useBrief ? briefVerify(hit.result) : hit.result, hit));
    const result = await verifyCpt(p, {
      engine: options.engine,
      expectations,
      timeoutMs,
      // 2026-11-05：verify_cpt 默认带本地 SQL 审计（本地库未建 → skipped + nextAction，不假 pass）。
      // 不新增工具参数（report 静态表预算极紧），需要关闭时用 env CPT_MCP_VERIFY_LOCAL_SQL=0。
      localSqlAudit,
    });
    // 用跑完之后的指纹落缓存：engine 报告可能刚被本次运行刷新，下一次同条件调用才能命中
    cacheStore('verify_cpt', p, options, gateFingerprint(p, deps), result);
    return ok(useBrief ? briefVerify(result) : result);
  });

tool('quality_gate_cpt', '⭐ 交付门：聚合结构/样式/合理性/引擎校验，返回 pass/structuralPass/deliveryPass 三字段并列与带 fix 的 blockers（默认带本地 SQL 审计）。deliveryPass=true 才可交付；JS 基线陈旧（有意删块）传 resetJsBaseline:true 复位。brief=true 回摘要；同文件同参复用上次结论（cached=true，写入/引擎/库变化后重算）。',
  {
    path: pathSchema,
    localSqlAudit: boolish.default(true).describe('本地 SQLite 离线 SQL 审计（默认开；未建库自动跳过）'),
    localSqlAuditDb: z.string().optional().describe('指定本地库名（缺省按数据连接映射）'),
    localSqlAuditMaxDatasets: z.coerce.number().int().min(1).max(200).optional().describe('最多审计数据集数（默认 50）'),
    resetJsBaseline: boolish.optional().describe('复位本模板 JS 基线'),
    brief: briefParam,
  },
  async ({ path: p, localSqlAudit, localSqlAuditDb, localSqlAuditMaxDatasets, resetJsBaseline: doReset, brief }) => {
    const useBrief = resolveBrief(brief);
    const options = {
      localSqlAudit: localSqlAudit !== false,
      localSqlAuditDb: localSqlAuditDb ?? null,
      localSqlAuditMaxDatasets: localSqlAuditMaxDatasets ?? null,
      resetJsBaseline: doReset === true,
    };
    const deps = { engine: true, localSql: options.localSqlAudit };
    // 复位基线会改 JS 基线状态，属"有意变更"，不读缓存（但仍可写入新结论）
    if (!options.resetJsBaseline) {
      const hit = cacheLookup('quality_gate_cpt', p, options, gateFingerprint(p, deps));
      if (hit) return ok(withCacheInfo(useBrief ? briefGate(hit.result) : hit.result, hit));
    }
    const gate = qualityGate(p, {
      localSqlAudit: options.localSqlAudit,
      localSqlAuditDb,
      localSqlAuditMaxDatasets,
      resetJsBaseline: doReset === true,
    });
    // M69+ 深层租约联动：结构无 blocker 即 structuralPass；引擎结论 pass 才允许交付（deliveryPass）。
    // 2026-11-07 P1-6 收口：本工具**不再自动申请 fr_engine 租约** —— 那会让"调一次门禁"产生
    // tools/list 42→44 的隐藏副作用（宿主镜像/上下文缓存抖动，且注解无法表达）。
    // 引擎刷新改由 nextAction 指路：首选 verify_cpt（静态免租约），或用 run_fr_engine_check（需显式租约）。
    const engineStatus = gate.engineCheck?.status;
    gate.structuralPass = (gate.blockers?.length ?? 0) === 0;
    gate.engineCheck = { ...gate.engineCheck, required: engineStatus !== 'pass' };
    gate.deliveryPass = gate.pass === true && engineStatus === 'pass';
    // 结构化说明"为什么没替你解锁"（不是 granted，也不是失败）——避免模型以为门禁坏了。
    if (gate.engineCheck.required) {
      gate.engineCheck.deepAccess = {
        status: 'not_requested',
        hint: '门禁不自动申请租约（避免改 tools/list）。刷新引擎报告：首选 verify_cpt({path, engine:true})（静态免租约）；本档没有 verify_cpt 时，先 request_deep_tool_access({path, group:"fr_engine", reason:"explicit_engine_check"}) 再调 run_fr_engine_check({path})。',
      };
    }
    // 2026-11-07 P1 门禁自洽：本工具**只读缓存引擎报告、不自动跑引擎**，所以"再跑一次本工具"不会
    // 改变引擎结论。必须给出可执行闭环，否则模型会对着同一个 not-run/stale 反复重跑（v1 会话 92 次）。
    if (gate.engineCheck.required) {
      gate.nextAction = `引擎结论未通过（engineCheck.status=${engineStatus}）：先刷新引擎报告再重跑本工具 —— 首选 verify_cpt({path:${JSON.stringify(p)}, engine:true})（report/focused 档静态免租约）；本档没有 verify_cpt 时：先 request_deep_tool_access({path:${JSON.stringify(p)}, group:"fr_engine", reason:"explicit_engine_check"})，再 run_fr_engine_check({path:${JSON.stringify(p)}})。本工具不自动申请租约，也不会自行改变引擎结论。`;
    }
    // 落缓存的是"加工后"的完整门禁结论（含 structuralPass/deliveryPass/nextAction），
    // 这样 cached 命中的返回体与实跑返回体逐字段一致（brief 只是出口投影）。
    cacheStore('quality_gate_cpt', p, options, gateFingerprint(p, deps), gate);
    return ok(useBrief ? briefGate(gate) : gate);
  });

// ---------------- 深层工具租约 + 紧凑读取门禁（M69+） ----------------

tool('request_deep_tool_access', '【租约】申请解锁场景族工具：具名族（组目录见 get_capabilities）一次解锁整族；adhoc=任意未编组工具按名直租（另传 tools，reason 按涉及面取 adhoc_read/adhoc_write/adhoc_destructive，均绑单文件）；auto=只记得工具名时按名反查所属族并推导 reason。深层工具解锁前不在 tools/list 里，直接调用会报 unknown tool（那是未授权，不是工具不存在）——先租后调。具名族多为 20 次调用 + 1 小时兜底过期；adhoc 分档更短（读 10 次/300s、写 3 次/180s、破坏性 1 次/120s），用尽/过期需重租；剩余额度用 get_capabilities({leases:true}) 查；被拒也耗次数，勿循环申请。',
  {
    path: pathSchema,
    group: z.enum([...Object.keys(DEEP_TOOL_GROUPS), 'adhoc', 'auto']).describe('场景族组名 | adhoc=按名直租 | auto=自动判组'),
    // reason 改可选：具名族各自只有一个合法理由值（服务端按族策略自填），auto 也不需要；
    // adhoc 仍强制分级 reason（adhoc_read/adhoc_write/adhoc_destructive，既有语义不变）。
    reason: z.string().min(1).optional().describe('组理由值；具名族/auto 可省略，adhoc 必填（adhoc_read/adhoc_write/adhoc_destructive）'),
    target: z.object({
      sheet: z.coerce.number().int().min(0).optional(),
      cell: z.string().optional().describe('A1 坐标，如 "A1"'),
      requiredFields: z.array(z.string()).optional().describe('需要读取的字段（style/hyperlink/highlight），决定解锁哪个读取工具'),
    }).optional().describe('cell_detail 必填：目标工作表与单元格'),
    failureId: z.string().optional().describe('batch_mutate_cells 失败时返回的一次性凭据（cell_primitive 必填）'),
    tools: z.array(z.string().min(1)).max(30).optional().describe('adhoc/auto 必填：要租的工具名数组（用 get_capabilities 查合法工具名；已有专用租约通道的不受理）'),
  },
  async ({ path: p, group, reason, target, failureId, tools }) => {
    // 宿主侧预检（lib 只认分类与组表，宿主认注册表与档位可见性）：
    //   · 未注册名直接拒绝（防臆造）；
    //   · 已在当前档位静态可见的工具不占租约（直接告知可用）；
    //   · adhoc 与 auto 共用这份预检 —— auto 必须先把"已经看得见的工具"摘掉，否则像 add_cell
    //     这种"既在静态表、又属门禁族 cell_primitive"的工具会被误判成门禁拒绝。
    if (group === 'adhoc' || group === 'auto') {
      if (tools?.length) {
        const inProfile = (n) => TOOL_PROFILE === 'full' || PROFILE_TOOLS[TOOL_PROFILE].has(n);
        const unknown = tools.filter((t) => !ALL_TOOL_NAMES.has(t));
        if (unknown.length > 0) throw new Error(`${group} 未知工具名：${unknown.join('、')}（用 get_capabilities 查合法工具名；当前共 ${ALL_TOOL_NAMES.size} 个已注册工具）`);
        const visible = tools.filter((t) => inProfile(t));
        const rest = tools.filter((t) => !inProfile(t));
        if (rest.length === 0) {
          return ok({ status: 'already-visible', group, alreadyVisible: visible, note: '所列工具在当前档位已静态可见，无需租约，直接调用即可。' });
        }
        const granted = deepTools.request({ group, path: p, reason, tools: rest });
        return ok({ ...granted, alreadyVisible: visible });
      }
      // 没给 tools：交给 lib 报"必须显式列出 tools"（错误文案集中在 lib，避免两处漂移）
      return ok(deepTools.request({ group, path: p, reason, tools }));
    }
    // 具名族：与 adhoc/auto 同口径 —— 先摘出本档静态已可见成员，只对真正隐藏的成员计租。
    // 旧实现里 report 档申请 cell_detail / generator_full 会 granted 但零新增（get_cell_style /
    // build_report / generate_report 本就可见），cell_primitive 更会白烧一次性 failureId 凭据。
    const inProfile = (n) => TOOL_PROFILE === 'full' || PROFILE_TOOLS[TOOL_PROFILE].has(n);
    // cell_detail 实际只授予 target.requiredFields 对应的那一支（lib 里 toolForFields 是唯一映射），
    // 这里用同一映射判断"这一支是否已静态可见"，避免把静态工具又租一遍。
    const members = group === 'cell_detail' && target
      ? toolForFields(target.requiredFields)
      : [...DEEP_TOOL_GROUPS[group]];
    const alreadyVisible = members.filter((n) => inProfile(n));
    const hidden = members.filter((n) => !inProfile(n));
    // full 档全部静态可见、租约本就无意义：保持返回 granted（旧行为，兼容既有调用方）；
    // 非 full 档若族成员全可见才回 already-visible（不再白烧租约/门禁凭据）。
    if (TOOL_PROFILE !== 'full' && hidden.length === 0) {
      return ok({
        status: 'already-visible', group, alreadyVisible,
        note: '该族工具在当前档位已静态可见，无需租约（也不会消耗门禁凭据，如 cell_primitive 的 failureId）。',
      });
    }
    const granted = deepTools.request({ group, path: p, reason, target, failureId });
    return ok(alreadyVisible.length > 0 ? { ...granted, alreadyVisible } : granted);
  },
  LIGHT_OPTS.request_deep_tool_access);

tool('batch_mutate_cells', '【S6 边界】多单元格批量增/改/删（事务式两阶段，原子：与 *_batch 非原子逐项执行不同）：plan 在临时副本上试算并做结构校验（不改原文件），返回 planId 与逐格摘要；apply 按 planId 原子写回（自动 .bak-batch 备份）。失败时返回 failureId + suggestedDeepTools——单格失败可凭它申请一次单格工具租约做精确降级，禁止批量失败后循环调用单格工具。目标支持 {sheet, cells:["A1","B2"]} 或 cellSet 的 {selectionId}。CPT_MCP_NO_BAK=1 时不留 .bak-batch（版本走报表模式 git 落库）。',
  {
    path: pathSchema,
    mode: z.enum(['plan', 'apply']).describe('plan=试算（不改文件）；apply=按 planId 原子写回'),
    commands: z.array(z.record(z.string(), z.any())).optional().describe('plan 模式必填：[{op:"create"|"update"|"delete", target:{...}, data:{...}}]；update.data.patch 支持 content/tooltip/style/insertPolicy（insertPolicy: copy/default/null 补填报行复制策略，null=删节点；style 支持 styleIndex 直接重绑或属性 patch）'),
    planId: z.string().optional().describe('apply 模式必填：plan 返回的 planId'),
    allowUnsafeScript: boolish.default(false).describe('安全开关：update.patch.content 含可执行脚本特征时必须显式设为 true（与 update_cell 同级）'),
  },
  async ({ path: p, mode, commands, planId }) => {
    if (mode === 'plan') {
      if (!commands?.length) throw new Error('plan 模式必须提供非空 commands 数组');
      return ok(planCellBatch(p, commands));
    }
    if (!planId) throw new Error('apply 模式必须提供 planId');
    return ok(applyCellBatch(p, planId));
  });

tool('record_cpt_read_intent', '【读取门禁】批量/紧凑读取前记录读取意图：明确路径、视图、目的与已确认事实。有未确认事项（uncertainties 非空）时返回 clarification_required 与澄清问题，不签发 permit。成功返回 permitId（10 分钟有效、绑定路径与视图）。',
  {
    path: pathSchema,
    views: z.array(z.enum(CPT_READ_VIEWS)).min(1).describe('本次要读取的视图，如 ["cellSet"] 或 ["overview","cells"]'),
    purpose: z.string().min(1).describe('读取目的（一句话）'),
    confirmedFacts: z.array(z.string()).default([]).describe('已确认的事实（如"用户明确指定工作表0和A1:B1"）'),
    uncertainties: z.array(z.string()).default([]).describe('未确认事项；非空则要求先向用户澄清'),
  },
  async ({ path: p, views, purpose, confirmedFacts, uncertainties }) =>
    ok(readGate.recordIntent({ path: p, views, purpose, confirmedFacts, uncertainties })), LIGHT_OPTS.record_cpt_read_intent);

tool('read_cpt_compact', '【读取门禁】按 permitId 紧凑读取指定视图：分页（默认 20 条、上限 50）+ 长文本裁剪。cellSet 视图支持 ranges/groupBy 选择器并返回 selectionId——可直接驱动 batch_mutate_cells 批量操作（该工具属 report_rewrite 深层组，需先 request_deep_tool_access(group=report_rewrite) 租约解锁），无需逐格读写。cellStyle/hyperlink 视图必须提供 selector.column/row。',
  {
    path: pathSchema,
    permitId: z.string().min(1).describe('record_cpt_read_intent 返回的授权 ID'),
    view: z.enum(CPT_READ_VIEWS).describe('读取视图：overview/datasets/parameters/cells/fill/styles/page/grid/panel/cellStyle/hyperlink/cellSet'),
    selector: z.record(z.string(), z.any()).optional().describe('视图选择器：cells={sheet,column,row}；cellSet={sheet, ranges:["A1:B1"], groupBy:["style"]}；styles={name:样式索引}'),
    cursor: z.coerce.number().int().min(0).default(0).describe('分页起始（配合 hasMore/nextCursor）'),
    limit: z.coerce.number().int().min(1).max(50).default(20).describe('每页条数（上限 50）'),
    detail: z.enum(['summary', 'standard']).default('summary').describe('summary=裁剪长文本；standard=保留更多细节'),
  },
  async ({ path: p, permitId, view, selector, cursor, limit, detail }) => {
    readGate.assertAuthorized({ permitId, path: p, view });
    return ok(readCptCompact(p, { view, selector, cursor, limit, detail }));
  }, LIGHT_OPTS.read_cpt_compact);

tool('read_cpt', '读取 CPT 概览：版本、数据集/参数/单元格数、提交摘要、主题、JS 块计数（确认 set_*_js 已生效）。includeProgress=true 附带构建工序进度（buildProgress）。',
  {
    path: pathSchema,
    includeProgress: boolish.default(false).describe('true=附带 buildProgress 工序进度'),
  },
  async ({ path: p, includeProgress }) => {
    const base = overview(p);
    return ok(includeProgress === true ? { ...base, buildProgress: buildProgress(p) } : base);
  });

tool('get_datasets', '列出 CPT 全部数据集：名称、连接、数据集参数（含默认值）、SQL。', { path: pathSchema },
  async ({ path: p }) => ok(datasets(p)));

tool('get_parameters', '列出 CPT 全部参数：数据集层（scope=dataset，含所属数据集）+ 报表级（scope=report，ReportParameterAttr 直接子级；同名跨层各一条）。（≠数据集本身用 get_datasets；≠面板控件布局用 get_parameter_panel）', { path: pathSchema },
  async ({ path: p }) => ok(parameters(p)));

tool('get_cells', '查询单元格：可按列/行/控件类型过滤；返回坐标/样式索引/提示/控件/内容类型/监听器 JS。includeStyle=true 附加完整样式明细（字体/色/对齐/边框/共享格数）。',
  {
    path: pathSchema,
    column: intParam.optional().describe('按列号过滤'),
    row: intParam.optional().describe('按行号过滤'),
    widgetClass: z.string().optional().describe('按控件类名过滤，如 com.fr.form.ui.TextArea'),
    includeStyle: boolish.default(false).describe('true=附带 styleDetail（样式+共享格数）'),
  },
  async ({ path: p, column, row, widgetClass, includeStyle }) => {
    const all = cells(p);
    let list = all;
    if (column !== undefined) list = list.filter((c) => Number(c.column) === column);
    if (row !== undefined) list = list.filter((c) => Number(c.row) === row);
    if (widgetClass) list = list.filter((c) => (c.widgetClass || '').includes(widgetClass));
    const page = list.slice(0, 200);
    if (includeStyle !== true) return ok({ count: list.length, cells: page });
    // 2026-11-12 P0-1：单格样式并入 get_cells（原 get_cell_style）：样式表读一次 + 全量共享计数，
    // 只对当前页前 50 格展开，避免大模板把上下文拉爆。
    const styleList = styles(p);
    const shares = new Map();
    for (const c of all) {
      if (c.style == null) continue;
      shares.set(c.style, (shares.get(c.style) ?? 0) + 1);
    }
    const detailed = page.slice(0, 50).map((c) => {
      const def = c.style == null ? null : styleList[c.style];
      return {
        ...c,
        styleDetail: def ? { ...def, sharedCells: shares.get(c.style) ?? 0 } : null,
      };
    });
    return ok({ count: list.length, cells: detailed, styleDetailLimit: 50 });
  });

tool('get_fill_config', '读取填报配置：提交设置（目标表/绑定/主键/条件/skipUnmodified、自由 SQL）、校验、快捷键。view:"matrix" 只看跨 sheet 提交拓扑（同目标表/同主键/无来源判别字段），不展开绑定。报表级；内嵌用 get_embedded_submits。', {
  path: pathSchema,
  view: z.enum(['submits', 'matrix']).default('submits').describe('submits=完整配置（默认）；matrix=跨 sheet 提交拓扑/风险'),
},
async ({ path: p, view }) => ok(view === 'matrix' ? fillSubmitMatrix(p) : fillConfig(p)));

tool('get_embedded_submits', '读取【单元格内嵌提交】清单（FreeButton 事件里的 Commit2DBJavaScript → <Attributes name="提交N"> + <DMLConfig>，一个按钮可内嵌多套）。返回：所在单元格（AF2 与 column/row）、事件、每套提交的名称/目标表/字段列映射（column/row/isKey/常量）、提交后回调 JS 长度。用途：① get_fill_config 只数 ReportWriteAttr 的 SubmitVisitor，看不到这类提交（新品表实测 4 套提交它只报 2 套）；② 写前核对字段列号（跨提交列号不一致会把库值覆盖成 NULL）。',
  { path: pathSchema },
  async ({ path: p }) => ok(embeddedSubmits(p)));

tool('get_styles', '读取模板全部样式（StyleList）：索引/字体/字号/加粗/背景色/前景色。已并入读门禁 read_cpt_compact({view:"styles"})，本独立工具默认隐藏（full/adhoc 可用）。',
  { path: pathSchema },
  async ({ path: p }) => {
    const list = styles(p);
    return ok({ count: list.length, styles: list });
  });

tool('get_page_settings', '读取页面设置：纸张（尺寸单位=144000/mm）、边距、水平/垂直居中、缩放、页眉页脚高度。已并入读门禁 read_cpt_compact({view:"page"})，本独立工具默认隐藏（full/adhoc 可用）。',
  { path: pathSchema },
  async ({ path: p }) => ok(pageSettings(p)));

tool('get_grid', '读取各工作表的行高/列宽：defaultValue（全局默认，设计器新增行用）+ CDATA 明细数组（实际每行/每列值，建议以此为准）+ mm 换算值。行高单位 1mm=144000（如 9mm=1296000、7mm=1008000、默认 723900≈5.03mm）。',
  { path: pathSchema },
  async ({ path: p }) => ok({ sheets: gridSizes(p) }));

tool('get_parameter_panel', '读取参数面板：标题/是否显示/控件列表（名称、class、BoundsAttr 位置尺寸）与参数项（同名绑定）。',
  { path: pathSchema },
  async ({ path: p }) => ok(parameterPanel(p)));

// ---------------- 生成（模板骨架 + 分步拼装） ----------------

tool('create_cpt', '创建报表骨架（增量起点，非交付）：仅生成空模板；新表首选静态的 generate_report（字段+数据源自动成型），需要精确 spec 控制时先租 generator_full 再用 build_report；分步仅做增量修改（add_dataset→（需新命名样式时租 style_manage）add_style→add_cell→填报→set_grid→set_report_settings）。填报模板务必传 webWrite=true。',
  {
    path: pathSchema,
    title: z.string().optional().describe('报表标题（写入 ReportWebAttr.Title，缺省用文件名）'),
    rows: z.coerce.number().int().min(1).default(3).describe('初始行数'),
    columns: z.coerce.number().int().min(1).default(4).describe('初始列数'),
    withWebAttr: boolish.default(true).describe('是否生成 ReportWebAttr（Web 属性，填报模板建议 true）'),
    webWrite: boolish.default(false).describe('是否生成 WebWriteContent（填报相关 Web 属性）'),
    xmlVersion: z.string().default('20211223').describe('xmlVersion（11.5：20211223；10.x：20170720）'),
    releaseVersion: z.string().default('11.5.0').describe('releaseVersion（11.5：11.5.0；10.x：10.0.0）'),
  },
  async ({ path: p, title, rows, columns, withWebAttr, webWrite, xmlVersion, releaseVersion }) =>
    ok(createCpt(p, { title, rows, columns, withWebAttr, webWrite, xmlVersion, releaseVersion })), LIGHT_OPTS.create_cpt);

tool('add_sheet', '在工作簿末尾追加工作表（新空白 <Report> 块：格网络 + 空单元格区，默认行高 723900≈5.03mm、列宽 2743200≈19.05mm）。返回新工作表名；之后 add_cell 等传 sheet（索引 0 起或名称）即可写入该表。',
  {
    path: pathSchema,
    sheetName: z.string().min(1).optional().describe('新工作表名（缺省 sheetN；与现有重名会报错）'),
    rows: z.coerce.number().int().min(1).default(6).describe('初始行数'),
    columns: z.coerce.number().int().min(1).default(6).describe('初始列数'),
  },
  async ({ path: p, sheetName, rows, columns }) => ok(addSheet(p, { sheetName, rows, columns })));

tool('delete_sheet', '删除指定工作表（按索引或名称）。要求模板至少保留 1 个工作表——保护防误删最后一张表。',
  { path: pathSchema, sheet: sheetSchema.describe('工作表：0 起索引或名称（不传默认 sheet 0）') },
  async ({ path: p, sheet }) => ok(deleteSheet(p, sheet ?? 0)));

tool('add_dataset', '新增 SQL 数据集（TableData）：连接名、SQL、数据集参数；结构对照真实样本。不支持内置数据集（EmbeddedTableData 的 <RowData> 是 FR 私有压缩编码，写了设计器打不开）。',
  {
    path: pathSchema,
    name: z.string().min(1).describe('数据集名，如 ds1'),
    connection: z.string().min(1).describe('数据连接名（Connection>DatabaseName，如 Doris）'),
    sql: z.string().min(1).describe('SQL 文本（支持 ${参数} 引用）'),
    parameters: z.array(z.object({
      name: z.string().min(1),
      defaultValue: z.string().optional().describe('默认值，可为空'),
    })).optional().describe('数据集参数列表'),
    // 这个字段存在的唯一目的就是「被拒绝」。官方内置数据集的 <RowData> 是 FR 私有压缩编码，
    // 合规边界内无法还原，盲写只会产出设计器打不开的模板。声明它，
    // 才能让模型在真想要内置数据集时收到带替代方案的报错，而不是被 zod 静默剥离后拿到一个 SQL 数据集。
    embedded: boolish.optional().describe('内置数据集——不支持，传 true 会被拒绝'),
  },
  async ({ path: p, name, connection, sql, parameters = [], embedded }) =>
    ok(addDataset(p, { name, connection, sql, parameters, embedded })));

tool('add_file_dataset', '新增 Excel 文件数据集（ExcelTableData）：把 .xls/.xlsx 当数据源，适合数据不在库里只有一张表时。只支持 Excel（CSV/文本/XML 官方零实例，字段只能靠猜，猜错就是打不开的模板）；fromEnv=true 时 dataFile 相对 %FR_HOME%/webapps/webroot。',
  {
    path: pathSchema,
    name: z.string().min(1).describe('数据集名，如 ds1'),
    dataFile: z.string().min(1).describe('Excel 路径；fromEnv=true 时相对 FR webroot'),
    needColumnName: boolish.default(true).describe('Excel 首行是否为列名'),
    fromEnv: boolish.default(true).describe('true=dataFile 相对 %FR_HOME%/webapps/webroot；false=绝对路径'),
  },
  async ({ path: p, name, dataFile, needColumnName, fromEnv }) =>
    ok(addFileDataset(p, { name, dataFile, needColumnName, fromEnv })));

tool('add_tree_dataset', '新增树数据集（RecursionTableData）：在已有数据集之上按「父-子」两列构建层级，用于组织架构、省市区、BOM 展开等树形报表的纵向展开。'
  + '前提：先用 add_dataset 建好源数据集。childField 是子节点列在源数据集里的列序号（0 起），parentField 是父节点列的序号——两者必须都给（官方 19 个样本里字段名总是和列序号成对出现，只给字段名无法推导序号）。'
  + '建好后把该数据集的列拖到单元格并设纵向扩展即可按层级展开。',
  {
    path: pathSchema,
    name: z.string().min(1).describe('树数据集名，如 tree1'),
    source: z.string().min(1).describe('源数据集名（必须已存在）'),
    childField: z.coerce.number().int().min(0).describe('子节点列序号（0 起，0=源数据集第 1 列）'),
    parentField: z.coerce.number().int().min(0).describe('父节点列序号（0 起），不能与 childField 相同'),
    childFieldName: z.string().optional().describe('子节点字段名（附加信息，与 childField 同时给）'),
    parentFieldName: z.string().optional().describe('父节点字段名（附加信息，与 parentField 同时给）'),
  },
  async ({ path: p, name, source, childField, parentField, childFieldName, parentFieldName }) =>
    ok(addTreeDataset(p, { name, source, childField, parentField, childFieldName, parentFieldName })));

tool('add_style', '新增样式（StyleList 追加），返回 styleIndex 供 add_cell 引用。属 style_manage 租约族（report 档默认隐藏）：request_deep_tool_access({path, group:"style_manage"}) 后可用；日常改单元格样式用静态 update_cell_style，查既有样式用 get_cells({includeStyle:true})。表头常用 18pt 加粗+背景色+居中(0)；数据 14pt 居中。支持字体/字号/加粗/斜体/下划线/删除线/前后景色/对齐/垂直对齐/边框/缩进/行距/文本方向。',
  {
    path: pathSchema,
    fontName: z.string().default('微软雅黑'),
    fontSizePt: z.coerce.number().min(6).max(200).default(14).describe('字号（pt），默认 14 = 沙盘2 成品数据行字号；表头/标题可传 18'),
    bold: boolish.default(false),
    italic: boolish.default(false),
    underline: boolish.optional().describe('下划线'),
    strikethrough: boolish.optional().describe('删除线'),
    backgroundColor: z.string().optional().describe('背景色 #RRGGBB，缺省无背景'),
    foregroundColor: z.string().optional().describe('文字色 #RRGGBB'),
    horizontalAlignment: z.coerce.number().int().optional().describe('水平对齐（官方 1559 样本仅出现这 4 个值）：0=居中（76.7%，表头/标题/数据行默认）、2=左对齐（文本列）、4=右对齐（数字/金额列）、6=两端对齐（极罕见）。禁止传 1/3/5（官方样本零出现，设计器无法识别）'),
    verticalAlignment: z.coerce.number().int().optional().describe('垂直对齐（官方样本仅出现 0/1/3）：0=居中（默认值，通常省略不写）、1=靠上、3=靠下'),
    border: z.object({
      top: z.object({ style: z.coerce.number().int().min(0), color: z.string().optional() }).optional(),
      bottom: z.object({ style: z.coerce.number().int().min(0), color: z.string().optional() }).optional(),
      left: z.object({ style: z.coerce.number().int().min(0), color: z.string().optional() }).optional(),
      right: z.object({ style: z.coerce.number().int().min(0), color: z.string().optional() }).optional(),
      outerTop: z.object({ style: z.coerce.number().int().min(0), color: z.string().optional() }).optional(),
      innerHorizontal: z.object({ style: z.coerce.number().int().min(0), color: z.string().optional() }).optional(),
    }).optional().describe('边框：{top,bottom,left,right,outerTop?,innerHorizontal?} 每边 {style 线型(1细实线/2/3/5/14…)，color?}'),
    textStyle: z.coerce.number().int().min(0).max(2).optional().describe('文本控制（官方样本 1/2；对照设计器：自动换行/单行等）'),
    paddingLeft: z.coerce.number().int().min(0).optional().describe('左缩进(px)'),
    paddingRight: z.coerce.number().int().min(0).optional().describe('右缩进(px)'),
    lineSpacing: z.coerce.number().min(0).optional().describe('行间距'),
    rotation: z.coerce.number().optional().describe('文本方向角度（-90=竖排等）'),
    format: z.object({
      class: z.string().optional().describe('格式类，如 com.fr.base.CoreDecimalFormat / TextFormat / SimpleDateFormatThreadSafe'),
      pattern: z.string().optional().describe('格式 pattern，如 #,##0.00 / yyyy-MM-dd'),
      roundingMode: z.coerce.number().optional().describe('舍入模式（CoreDecimalFormat）'),
    }).optional().describe('数字/日期格式（<Format> 子元素）；不传则不生成'),
  },
  async ({ path: p, fontName, fontSizePt, bold, italic, underline, strikethrough, backgroundColor, foregroundColor, horizontalAlignment, verticalAlignment, border, textStyle, paddingLeft, paddingRight, lineSpacing, rotation, format }) =>
    ok(addStyle(p, { fontName, fontSizePt, bold, italic, underline, strikethrough, backgroundColor, foregroundColor, horizontalAlignment, verticalAlignment, border, textStyle, paddingLeft, paddingRight, lineSpacing, rotation, format })), LIGHT_OPTS.add_style);

tool('delete_style', '删除 StyleList 中第 idx 个样式。安全防线：默认拒绝删被引用的样式（被引则越界），传 force=true 才强删；不可删 idx=0（默认样式）。',
  { path: pathSchema, index: z.coerce.number().int().min(0).describe('样式索引（styles 数组下标）'), force: boolish.default(false).describe('默认 false：被引则抛错；true：强删（被引方会越界）') },
  async ({ path: p, index, force }) => ok(deleteStyle(p, index, { force })));

tool('add_cell', '在 (column,row) 新增单元格：文本/公式(= 开头)/DSColumn 数据集列，可带填报控件；控件与绑定可同格并存。公式落盘为官方 Formula 对象（设计器可求值）。样式不在本工具——styleIndex 由 style_manage 族的 add_style 创建（索引从 0 起），或复用既有样式（get_cells({includeStyle:true}) / read_cpt_compact({view:"styles"}) 可查）。完整参数见 get_capabilities({tool:"add_cell"})。',
  {
    path: pathSchema,
    column: nonNegIntParam,
    row: nonNegIntParam,
    content: z.string().optional().describe('单元格文本；contentType=formula 时传公式（带不带 = 均可，如 ROW()-4 或 =ROW()-4）；DSColumn 时忽略'),
    contentType: z.enum(['text', 'formula', 'dsColumn']).default('text'),
    dsName: z.string().optional().describe('DSColumn 数据集名'),
    columnName: z.string().optional().describe('DSColumn 列名'),
    ci: z.coerce.number().int().min(0).optional().describe('动态列形态：源数据集列序号（0 起），替代 columnName。官方动态列模板即此形态'),
    styleIndex: z.coerce.number().int().min(0).default(0).describe('样式索引（add_style 创建，或复用既有样式；get_cells includeStyle 可查）'),
    widget: z.enum(['text', 'number', 'textarea', 'date', 'comboBox', 'checkBox', 'comboCheckBox', 'label', 'submit', 'appendRow', 'custom']).optional().describe('填报控件类型；custom 用 widgetClass 指定任意 class（可带 pluginID 覆盖插件按钮）'),
    widgetItems: z.array(z.object({ key: z.string(), value: z.string() })).optional().describe('comboBox/comboCheckBox 字典项 [{key,value}]（自定义固定项；要绑数据集/数据库表请改用 widgetDictionary）'),
    widgetDictionary: z.object({
      type: z.enum(['table', 'db', 'custom', 'formula']).describe('table=数据集字典(绑数据集，须先 add_dataset) / db=数据库表字典 / custom=自定义项(等同 widgetItems) / formula=公式数据字典'),
      dsName: z.string().optional().describe('type=table 时的数据集名'),
      kiName: z.string().optional().describe('实际值列名（type=table；官方样本也用 ki/vi 列索引形态）'),
      viName: z.string().optional().describe('显示值列名（type=table）'),
      table: z.string().optional().describe('type=db 时的数据库表名'),
      schema: z.string().optional().describe('type=db 时的 schema（可空）'),
      ki: z.coerce.number().int().optional().describe('type=db 时实际值列索引（0 起，必填）'),
      vi: z.coerce.number().int().optional().describe('type=db 时显示值列索引（0 起，必填）'),
      connection: z.string().optional().describe('type=db 时的数据库连接名'),
      formula: z.string().optional().describe('type=formula 时的值公式（如 =range(2010,2012)）'),
      eFormula: z.string().optional().describe('type=formula 时的显示公式（可缺省；如 =$$$+\'年\'）'),
    }).optional().describe('下拉控件的字典来源（M109/M117）：单元格下拉可直接绑数据集/数据库表/公式——官方单元格侧实测 TableDataDictionary 85 例、DatabaseDictionary 259 例、FormulaDictionary 12 例；给了本字段则以它为准，widgetItems 不再生效'),
    widgetClass: z.string().optional().describe('widget=custom 时的控件全类名（如 com.fr.plugin.excel.ui.ExcelImportButton）'),
    disabled: boolish.optional().describe('建控件时设为禁用态（表头禁用态输入框，<WidgetAttr disabled="true"> 实证形态；不传=启用）'),
    pluginID: z.string().optional().describe('插件按钮的 pluginID（如 com.fr.plugin.mark.excel.import.v11）'),
    pluginVersion: z.string().optional().describe('插件按钮的 plugin-version'),
    colspan: z.coerce.number().int().min(1).optional().describe('跨列数'),
    rowspan: z.coerce.number().int().min(1).optional().describe('跨行数'),
    expand: z.object({
      dir: z.coerce.number().int().min(0).max(1).optional().describe('扩展方向：0=纵向扩展（明细表默认）/ 1=横向扩展'),
      leftParent: z.union([z.string(), z.boolean()]).optional().describe('左父格：单元格引用（如 "A2"，行号从 1 起）｜ "none"/true=显式「无」（打断默认串联，多组数据集各成块，官方 337 例）。缺省=引擎自动跟随左邻'),
      upParent: z.string().optional().describe('上父格单元格引用，如 "A2"（横向扩展 dir=1 时使用）'),
      order: z.coerce.number().int().min(1).max(2).optional().describe('扩展后排序 1/2'),
      multiNumber: z.coerce.number().int().min(1).optional().describe('扩展倍数'),
    }).optional().describe('数据展开（扩展）配置。同一行放多组互不相关的数据集时，每组首格要传 leftParent:"none" 打断默认串联，否则后一组会被并入前一组的父格链'),
    summary: z.enum(['sum', 'avg', 'count', 'max', 'min']).optional().describe('DSColumn 汇总模式（仅 contentType="dsColumn" 有效）：sum/avg/count/max/min，传了就以官方 SummaryGrouper 形态落盘（如 sum → com.fr.data.util.function.SumFunction），缺省为分组（FunctionGrouper）'),
    sheet: sheetSchema.optional().describe('工作表：0 起索引或名称（缺省第 1 个；多 sheet 报表用 1/名称写第 2 个表）'),
  },
  async ({ path: p, column, row, content, contentType, dsName, columnName, ci, styleIndex, widget, widgetItems, widgetDictionary, widgetClass, pluginID, pluginVersion, colspan, rowspan, expand, summary, sheet, disabled }) => {
    const r = addCell(p, { column, row, content, contentType, dsName, columnName, ci, styleIndex, widget, widgetItems, widgetDictionary, widgetClass, pluginID, pluginVersion, colspan, rowspan, expand, summary, sheet, disabled });
    // 原语滥用软提示（不硬拦）：连续多次 add_cell 全用骨架样式 0，多半是在逐格拼一张
    // 明细表 —— build_report 会自动完成样式/扩展父格/行高，把事实摆到模型眼前供其纠偏
    const run = r.styleIndex === 0 ? ((addCellStyle0Run.get(p) ?? 0) + 1) : 0;
    addCellStyle0Run.set(p, run);
    if (run === ADD_CELL_STYLE0_HINT_AT) {
      return ok({
        ...r,
        hint: `已连续 ${ADD_CELL_STYLE0_HINT_AT} 次新增默认样式(0)单元格 —— 表头/数据/标题应各有样式。若在从零拼明细表，建议改用 build_report（自动样式+扩展父格+行高），或先 add_style 再继续；进度可用 get_build_progress 查看`,
      });
    }
    return ok(r);
  }, LIGHT_OPTS.add_cell);

tool('set_fill_toolbar', '给既有填报模板（.cpt）设置/替换填报工具栏（模板级 WebWriteContent/ToolBars）。解决双 sheet 报表第 2 个工作表无提交按钮需手工/GUI 的问题——工具栏是模板级，设置一次全 sheet 生效。buttons 可选：submit（提交）/ verify（数据校验）/ append-row（新增行）/ delete-row（删除行）/ import-append（导入Excel追加）/ import-clean（导入Excel清空后导入，设计器内置行为），缺省四按钮全量（不含导入，需显式点名）。模板须已有 <WebWriteContent>（非填报模板会报错，请用 create_cpt(webWrite=true) 或 build_report(webWrite:true) 生成，或用 set_webwrite_extras({path, repair:true}) 创建容器；若容器被旧工具放到 ReportWebAttr 外，本工具会先自动搬回再写并回报 repaired）。',
  {
    path: pathSchema,
    buttons: z.union([
      z.array(z.enum(['submit', 'verify', 'append-row', 'delete-row', 'import-append', 'import-clean'])).describe('按钮列表，缺省四个全量（不含导入）'),
      z.enum(['submit', 'verify', 'append-row', 'delete-row', 'import-append', 'import-clean']).describe('单个按钮'),
    ]).optional().describe('填报工具栏按钮；缺省 = submit/verify/append-row/delete-row 全量'),
  },
  async ({ path: p, buttons }) => ok(setFillToolbar(p, { buttons })));

tool('add_fill_submit', '新增填报提交（SubmitVisitor）。两种形态二选一：\n① 列映射提交（默认，传 dsName+table+bindings）：BuiltInSQLSubmiter，按主键整行 upsert；bindings[].skipUnmodified 控制每列「未修改则跳过」（列级智能提交），condition 设置提交条件（如 "Y5=1"）。submitType 选提交类型：intelligent（默认，IntelliDMLConfig 智能提交）/ insert（InsertConfig 插入提交；Doris 等不支持智能提交的库用这个）。\n② 自由 SQL 提交（传 sql，可选 dbName）：FreeSQLSubmiter，原始 SQL 可自定义 WHERE —— 用于列映射表达不了的形态（如"删除提交/条件更新"：UPDATE ... SET is_delete=1 WHERE id=${id}，绕过整表 upsert 与 is_delete 单元格依赖）。**SQL 里的每个 ${x} 会自动声明成提交参数 <Parameters>（取值 =$x，运行时从同名报表参数取值）**，因此自由 SQL 提交能真正拿到参数；需要覆盖取值/补声明时传 parameters:[{name,value?}]。返回 submitIndex（全局编号；多 sheet 下也可用 sheet+该表内相对索引，口径见 add_fill_binding）供追加绑定；自由 SQL 提交无字段绑定，参数用 parameters。sql 与 table/bindings 互斥。分步收尾须显式调一次 validate_cpt（本工具不自带校验）。',
  {
    path: pathSchema,
    dsName: z.string().optional().describe('填报数据连接名（列映射模式必填；自由 SQL 模式作为 dbName 兜底）'),
    table: z.string().optional().describe('目标表名（列映射模式必填；自由 SQL 模式忽略——互斥于 sql）'),
    schema: z.string().default(''),
    name: z.string().default('内置SQL1').describe('提交名称'),
    submitType: z.string().optional().describe('提交类型（仅列映射模式）：intelligent（默认，智能提交 IntelliDMLConfig）/ insert（插入提交 InsertConfig；Doris 等不支持智能提交的库用这个）。也接受 InsertConfig / IntelliDMLConfig / smart 等写法'),
    bindings: z.array(z.object({
      field: z.string().min(1),
      column: nonNegIntParam.optional(),
      row: nonNegIntParam.optional(),
      isKey: boolish.default(false),
      skipUnmodified: boolish.default(false).describe('FR「未修改则跳过」：true=提交时跳过本次未修改的该列（列级智能提交，只写改动字段；默认 false=整行覆盖）。sandbox19/v1 里没有任何工具能设置它，是「只写改动字段」的最后阻塞点'),
      constant: z.string().optional().describe('常量值绑定（提供后忽略 column/row）'),
    })).optional().describe('初始字段绑定：单元格绑定需 column+row（单元格必须已用 add_cell 创建）；或 constant 常量绑定；skipUnmodified 控制列级智能提交'),
    condition: z.string().nullable().optional().describe('提交条件（列映射提交）：FormulaCondition 公式文本，如 "Y5=1"（不需要前导 =）；传 "ListCondition" 表示空 ListCondition（列表条件=全部行）。自由 SQL 提交请把条件写进 SQL WHERE'),
    sql: z.string().optional().describe('自由 SQL 提交：任意 DML（UPDATE/DELETE...），可含 ${参数} 占位；传了即走 FreeSQLSubmiter，与 table/bindings 互斥。SQL 里每个 ${x} 会自动声明成提交参数（=$x），运行时由报表参数取值'),
    dbName: z.string().optional().describe('自由 SQL 模式的服务端数据连接名（如 "填报-读写"；缺省用 dsName）'),
    parameters: z.array(z.object({
      name: z.string().min(1).describe('提交参数名（对应 SQL 里的 ${name}）'),
      value: z.string().optional().describe('取值表达式（缺省 =$name，从同名报表参数取值；固定值可写 =1 或 =\'常量\'）'),
    })).optional().describe('自由 SQL 提交的提交参数声明（可选；缺省按 SQL 里的 ${x} 自动声明。显式传=以此列表为准，可覆盖取值/补声明）'),
    sheet: sheetSchema.optional().describe('工作表：0 起索引或名称（缺省第 1 个；多 sheet 报表用 1/名称把提交写到第 2 个表）'),
  },
  async ({ path: p, dsName, table, schema, name, bindings = [], sheet, sql, dbName, parameters, condition, submitType, configType }) =>
    ok(addFillSubmit(p, { dsName, table, schema, name, bindings, sheet, sql, dbName, parameters, condition, submitType, configType })));

tool('set_report_settings', '设置纸张（A3/A4/A5/B4/B5 或自定义 mm）/方向/页边距/水平垂直居中/缩放/页眉页脚高度/冻结行列。不传的字段保留模板原值，完整说明见 get_capabilities({tool:"set_report_settings"})。',
  {
    path: pathSchema,
    paper: z.string().optional().describe('纸张预设：A3/A4/A5/B4/B5（不区分大小写）'),
    orientation: z.coerce.number().int().min(0).max(1).optional().describe('0纵向 / 1横向；省略时保留模板当前方向'),
    paperWidthMm: z.coerce.number().optional().describe('自定义纸宽（mm），需同时给 paperHeightMm'),
    paperHeightMm: z.coerce.number().optional().describe('自定义纸高（mm）'),
    marginTopMm: z.coerce.number().optional().describe('上边距（mm，默认6.85）'),
    marginBottomMm: z.coerce.number().optional(),
    marginLeftMm: z.coerce.number().optional().describe('左边距（mm，默认19.05）'),
    marginRightMm: z.coerce.number().optional(),
    isHorizontalCenterOnPage: boolish.optional().describe('水平居中'),
    isVerticalCenterOnPage: boolish.optional().describe('垂直居中'),
    shrinkToFitMode: z.coerce.number().int().optional().describe('缩放模式（0不缩放/1/2自适应等）'),
    headerHeightMm: z.coerce.number().min(0).optional().describe('页眉高度（mm）'),
    footerHeightMm: z.coerce.number().min(0).optional().describe('页脚高度（mm）'),
    frozenColumn: z.coerce.number().int().min(0).optional().describe('冻结列数（从首列起；0=不冻结列）。与 frozenRow 组合：都传 0 表示清除冻结；缺省整个参数则保持模板原样'),
    frozenRow: z.coerce.number().int().min(0).optional().describe('冻结行数（从首行起；0=不冻结行）'),
    sheet: sheetSchema.optional().describe(SHEET_DESC),
  },
  async ({ path: p, paper, orientation, paperWidthMm, paperHeightMm, marginTopMm, marginBottomMm, marginLeftMm, marginRightMm, isHorizontalCenterOnPage, isVerticalCenterOnPage, shrinkToFitMode, headerHeightMm, footerHeightMm, frozenColumn, frozenRow, sheet }) =>
    ok(setReportSettings(p, { paper, orientation, paperWidthMm, paperHeightMm, marginTopMm, marginBottomMm, marginLeftMm, marginRightMm, isHorizontalCenterOnPage, isVerticalCenterOnPage, shrinkToFitMode, headerHeightMm, footerHeightMm, frozenColumn, frozenRow, sheet })), LIGHT_OPTS.set_report_settings);

// M52: 报告级增改查（Listener / TopJS / 任意子节点）
tool('update_report_node', '【S6 边界·M52】在指定工作表 Report 块内 upsert/删除任意子节点（如 Listener / TopJS / ReportPageAttr）。通用低层入口：有 xmlBody → upsert（命中则替换、未命中则插入新节点）；无 xmlBody → 删除（未命中抛错）。【2026-10-30 安全化】attributes 只用于匹配：替换时默认**保留原开标签属性**（旧实现会把 class 等属性丢掉，重写 SubmitVisitor 会丢 FreeSQLSubmiter 提交类型），确需改写属性传 replaceAttributes=true；attributes 未命中时默认报错（旧实现静默新建重复节点），确认要新建传 createIfMissing=true。【M91 防误删】未传 sheet 时全文件候选超过 1 个直接拒绝（禁静默命中首个）：多表/多块模板必须传 sheet 缩范围，或传 attributes 收到唯一。属性完全相同（如多个 <Widget class="com.fr.form.ui.CustomToolBarButton">）时可再传 index=序号（0 起）显式指定。parent 可选：把查找与插入都收进**唯一**父容器（如 parent="SubmitVisitor" 给提交补 <Parameters>；父容器多候选时报错不猜）；<WebWriteContent> 不允许走无 parent 的兜底插入。安全围栏：xmlBody 含可执行脚本容器（<Listener>/<TopJS>/<JavaScript>/<script>）或 nodeName 即脚本容器时，需 allowUnsafeScript=true；纯结构节点（如 ReportPageAttr）不受影响。',
  {
    path: pathSchema,
    nodeName: z.string().regex(/^[A-Za-z_][\w.-]*$/, 'nodeName 必须是合法 XML 标签名（字母/下划线开头，仅含字母数字下划线/./-）').describe('子节点标签名（如 "Listener" / "TopJS" / "ReportPageAttr"）'),
    attributes: z.record(z.string(), z.string()).optional().describe('开标签属性精确匹配（只用于匹配，不用于重建开标签；替换时默认保留原属性，确需改写传 replaceAttributes=true）'),
    xmlBody: z.string().optional().describe('新子节点内容（含/不含外层标签均可）；不传=删除模式'),
    allowUnsafeScript: boolish.default(false).describe('安全开关：xmlBody 写入可执行脚本容器时必须显式设为 true'),
    sheet: sheetSchema.optional(),
    parent: z.string().regex(/^[A-Za-z_][\w.-]*$/, 'parent 必须是合法 XML 标签名').optional().describe('父容器标签（可选）：把查找与插入都收进该容器（如 "SubmitVisitor" 补 <Parameters>、"ReportWebAttr" 补 WorkBook 级节点）；父容器必须唯一（多候选请传 sheet 缩范围）'),
    index: z.coerce.number().int().min(0).optional().describe('候选序号（0 起）：属性无法区分多个同名节点时显式指定第几个'),
    replaceAttributes: boolish.default(false).describe('true=用 attributes 重建开标签属性（旧行为）；默认 false=保留命中原节点的全部开标签属性'),
    createIfMissing: boolish.default(false).describe('true=attributes 未命中时允许新建节点；默认 false=报错（防止旧实现静默插入重复节点的坑）'),
  },
  async ({ path: p, nodeName, attributes, xmlBody, sheet, parent, index, replaceAttributes, createIfMissing }) =>
    ok(updateReportNode(p, { nodeName, attributes, xmlBody, sheet, parent, index, replaceAttributes, createIfMissing })));

tool('get_report_listener', '读取 Listener JS（改前必读）：area=report 报表事件，area=webpage=WorkBook 级 WebPageContent 分页预览。event 精确匹配，同 event 多份传 match。js 为 CDATA 原文；报表事件用 set_report_listener、分页预览用 set_webpage_js 写回。',
  {
    path: pathSchema,
    event: z.string().min(1).describe('事件名：onload/afterload/beforeOutput/afterOutput/webopen 等'),
    match: z.string().optional().describe('特征子串：同 event 多份时定位目标'),
    sheet: sheetSchema.optional(),
    jsOffset: z.union([z.number(), z.string()]).optional().describe('字符分页起点（0 起，默认 0；越界/负数抛错）'),
    jsLimit: z.union([z.number(), z.string()]).optional().describe('字符分页长度（默认全量；0=返回空串）'),
  },
  async ({ path: p, event, match, sheet, jsOffset, jsLimit }) => ok(reportListener(p, { event, match, sheet, jsOffset, jsLimit })));

tool('set_report_listener', '【S6 边界·M52】增/改/删 Report 节点下的 <Listener event="...">（onload/afterload/beforeOutput/afterOutput/webopen 等）。有 js → 拼装为完整 <Listener><JavaScript class="com.fr.js.JavaScriptImpl"><Content>JS</Content></JavaScript></Listener>；无 js → 删该 event 的 Listener。**JS 合并约定：同一容器内相同事件类型的 JS 只允许一个 Listener 代码块**——已有同 event 块时用 aggregate=true（追加新 JS；已有多个同 event 块则按文档顺序全部并为一个块，不丢内容）。传 match（目标 JS 特征子串）可精确定位多个 Listener 之一，用于定点替换/删除。**大块共享 Content（多补丁共用一大段 JS）只改一小段时，必须用 patchFind+patchReplace 片段替换**：literal 查找（默认唯一命中，patchAll=true 允许多处）、只改命中片段、块内其余原文原样保留，且与 js 互斥；**patchFind 已兼容设计器转义 `]A`（净文本 `]` 与落盘 `]A` 均可命中，回写保持 `]A` 编码）**；**整块替换若把大块（≥4KB）缩到 <60% 且少 ≥2KB 会被缩水护栏直接拒绝**（2026-11-03 事故：187KB afterload 被 8KB 替换，JS 块数/语法/门禁全绿但功能全丢），确要整块替换传 allowShrink=true。铁律：读到的 jsLength/jsBytes 与实际收到长度不符或见 Omitted/截断标记时，禁止整块重写，先用 match 或 jsOffset/jsLimit 分段重读。返回体带 mode(patch/replace/delete) 与 jsBytesBefore/jsBytesAfter/jsLinesBefore/jsLinesAfter 供对账。',
  {
    path: pathSchema,
    event: z.string().min(1).describe('事件名：onload/afterload/beforeOutput/afterOutput/webopen/stopedit 等'),
    js: z.string().optional().describe('JS 代码（不传=删除；aggregate=true 时不传=只合并现有散块；与 patchFind 互斥）'),
    aggregate: boolish.optional().describe('聚合/合并模式（推荐）：同 event 已有 Listener 时追加进现有 Content；已有多个同 event 块时按合并约定全部并为一个代码块（JS 依文档顺序拼接）；不传 js 时只做合并'),
    match: z.string().optional().describe('特征子串（可选）：同 event 多个 Listener 时精确定位目标——填目标 JS 独有片段'),
    patchFind: z.string().optional().describe(PATCH_FIND_DESC),
    patchReplace: z.string().optional().describe(PATCH_REPLACE_DESC),
    patchAll: boolish.optional().describe(PATCH_ALL_DESC),
    allowShrink: boolish.optional().describe(ALLOW_SHRINK_DESC),
    className: z.string().default('com.fr.js.JavaScriptImpl').describe(JS_IMPL_DESC),
    name: z.string().optional().describe('可选 NameJavaScript 标识名（仅当多事件时）'),
    expectedSha256: z.string().optional().describe(EXPECTED_SHA_DESC),
    allowUnsafeScript: boolish.default(false).describe(UNSAFE_JS_DESC),
    sheet: sheetSchema.optional(),
  },
  async ({ path: p, event, js, aggregate, match, className, name, sheet, expectedSha256, patchFind, patchReplace, patchAll, allowShrink }) => ok(setReportListener(p, { event, js, aggregate, match, className, name, sheet, expectedSha256, patchFind, patchReplace, patchAll, allowShrink })));

tool('set_report_js', '【S6 边界·M52】报表顶部 JS（报表JS / TopJS）——写入 <TopJS><![CDATA[js]]></TopJS>，JS 在报表页面加载时执行。这是「给报表加一段 JS」最常见的落点：contentPane 初始化、全局 hook、自动刷新等。有 js → 拼装为官方结构写入（整块写入，mode=replace）；无 js → 删除 TopJS（mode=delete）。**大块 TopJS 只改其中一段时用 patchFind+patchReplace 片段替换**（设计器转义 `]A` 感知、默认唯一命中、patchAll=true 允许多处、与 js 互斥、只改 CDATA 内文），返回 mode=patch；**整块写入把 ≥4KB 的旧 TopJS 缩到 <60% 且少 ≥2KB 会被缩水护栏拒绝**（确要整块重写传 allowShrink=true）；expectedSha256 在 patch/整块替换/删除前核对目标块。返回体带 jsBytesBefore/jsBytesAfter/jsLinesBefore/jsLinesAfter（新建时 before=0）。可执行 JavaScript 默认被安全围栏拒绝，需明确传 allowUnsafeScript=true。单元格级 JS 事件请用 add_cell_hyperlink；报表事件（onload/afterload）请用 set_report_listener。',
  {
    path: pathSchema,
    js: z.string().optional().describe('JS 代码（整块写入/替换；不传=删除 TopJS；与 patchFind 互斥）'),
    patchFind: z.string().optional().describe(PATCH_FIND_DESC),
    patchReplace: z.string().optional().describe(PATCH_REPLACE_DESC),
    patchAll: boolish.optional().describe(PATCH_ALL_DESC),
    allowShrink: boolish.optional().describe(ALLOW_SHRINK_DESC),
    expectedSha256: z.string().optional().describe(EXPECTED_SHA_DESC),
    allowUnsafeScript: boolish.default(false).describe(UNSAFE_JS_DESC),
    sheet: sheetSchema.optional(),
  },
  async ({ path: p, js, sheet, patchFind, patchReplace, patchAll, allowShrink, expectedSha256 }) => ok(setReportJs(p, { js, sheet, patchFind, patchReplace, patchAll, allowShrink, expectedSha256 })));

tool('get_webwrite_js', '读取 WebWriteContent 监听器（填报 Web 事件 <Listener event="...">）的 JS 全文（beforeimportexcel/afterimportexcel/beforeappend/afterappend/beforedelete/afterdelete/writesuccess/writefailure/beforewrite/afterwrite 等，改 JS 前必读）。覆盖 WorkBook 级与各 sheet 的 WebWriteContent（返回值含 scope=workbook/sheet 区分）。event 精确匹配；同 event 挂多个 Listener 时传 match（目标 JS 独有特征子串）精确定位。不传 event → 只返回事件清单（event/className/scope/sheet/jsLength/jsBytes/jsLines/sha256，不含 JS 正文），用来先看有哪些事件可读。返回 {event, count, listeners:[{event, className, js, jsLength(字符), jsBytes(UTF-8 字节), jsLines(行数), sha256, scope, sheet, index}]}——js 为 CDATA 原文，可改后经 set_webwrite_js(event, js, match) 写回（读→改→写回闭环；大块只改一段用 patchFind/patchReplace）。只读，不改文件。',
  {
    path: pathSchema,
    event: z.string().min(1).optional().describe('Web 事件名：beforeimportexcel/afterimportexcel/beforeappend/afterappend/beforedelete/afterdelete/writesuccess/writefailure/beforewrite/afterwrite 等；不传则只列事件清单'),
    match: z.string().optional().describe('特征子串（可选）：同 event 多个 Listener 时精确定位——填目标 JS 独有片段（与 set_webwrite_js 的 match 同口径）'),
    sheet: sheetSchema.optional(),
    jsOffset: z.union([z.number(), z.string()]).optional().describe('字符分页起点（0 起，默认 0；越界/负数抛错）'),
    jsLimit: z.union([z.number(), z.string()]).optional().describe('字符分页长度（默认全量；0=返回空串）'),
  },
  async ({ path: p, event, match, sheet, jsOffset, jsLimit }) => ok(webwriteListener(p, { event: event ?? null, match, sheet, jsOffset, jsLimit })), LIGHT_OPTS.get_webwrite_js);

tool('set_webwrite_js', '【S6 边界·M52】在模板级 WebWriteContent 内写入填报 Web 事件的脚本正文。官方结构：<WebWriteContent><Listener event="..."><JavaScript class="..."><Parameters/><Content><![CDATA[js]]></Content></JavaScript></Listener>（如 beforeimportexcel/beforeappend/afterappend/writesuccess/beforedelete 等，官方 82 例实证）。有 js → 写入/替换该 event 的 Listener；无 js → 删除该 event 的 Listener。同一 event 可能挂多个 Listener（真实报表如「不动销产品.cpt」有 6 个 afterload）——此时必须传 match（该 Listener JS 里的特征子串，如 "OP_COL" / "makeRec"）精确定位；**若本意是执行「同事件类型 JS 合并为一个代码块」约定，则改传 aggregate=true**（把散落的同 event 块全部并回一块、按文档顺序拼接，不丢内容；不带 js 时只合并不删除）。**大块共享 Content（多补丁共用一大段 JS，如实测 187KB 的 afterload）只改一小段时，必须用 patchFind+patchReplace 片段替换**：literal 查找（默认唯一命中，patchAll=true 允许多处；**已兼容设计器转义 `]A`：净文本 `]` 与落盘 `]A` 均可命中，回写保持 `]A` 编码，不会把已有 `]A` 解码写回**）、只改命中片段、块内其余原文原样保留，且与 js 互斥；**整块替换若把大块（≥4KB）缩到 <60% 且少 ≥2KB 会被缩水护栏直接拒绝**（2026-11-03 事故：187KB afterload 被 8KB 替换，JS 块数/语法/validate/quality/引擎全绿但功能全丢），确要整块替换传 allowShrink=true。模板须已有 <WebWriteContent>（create_cpt(webWrite=true) / build_report 生成）；可执行 JavaScript 默认被安全围栏拒绝，需明确传 allowUnsafeScript=true。注意：本工具写「填报/提交 Web 事件脚本」；页面加载脚本用 set_report_js，报表事件用 set_report_listener，单元格事件 JS 用 add_cell_listener。铁律：读到的 jsLength/jsBytes 与实际收到长度不符或见 Omitted/截断标记时，禁止整块重写，先用 match 或 jsOffset/jsLimit 分段重读。返回体带 jsBytesBefore/jsBytesAfter/jsLinesBefore/jsLinesAfter 供对账。【2026-10-20 容器修复】若 WebWriteContent 被放在 ReportWebAttr 外（旧工具产物），本工具会先自动搬回正确容器再写，并在返回体带 repaired；缺容器仍报错（用 set_webwrite_extras({path, repair:true}) 创建）。',
  {
    path: pathSchema,
    event: z.string().min(1).describe('Web 事件名：beforeimportexcel/afterimportexcel/beforeappend/afterappend/beforedelete/afterdelete/writesuccess/writefailure/beforewrite/afterwrite 等'),
    js: z.string().optional().describe('JS 代码（不传=删除该 event 的 Listener；aggregate=true 时不传=只合并现有散块；与 patchFind 互斥）'),
    aggregate: boolish.optional().describe('聚合/合并模式：同 event 已有 Listener 时把 JS 追加进现有 Content；已有多个同 event 块时按合并约定全部并为一个代码块（JS 依文档顺序拼接）；不传 js 时只做合并，不删除也不新建'),
    match: z.string().optional().describe('特征子串（可选）：同一 event 挂多个 Listener 时，用它精确定位目标——填目标 Listener JS 里独有的片段（如 "makeRec"、"OP_COL"）'),
    patchFind: z.string().optional().describe(PATCH_FIND_DESC),
    patchReplace: z.string().optional().describe(PATCH_REPLACE_DESC),
    patchAll: boolish.optional().describe(PATCH_ALL_DESC),
    allowShrink: boolish.optional().describe(ALLOW_SHRINK_DESC),
    className: z.string().default('com.fr.js.JavaScriptImpl').describe(JS_IMPL_DESC),
    expectedSha256: z.string().optional().describe(EXPECTED_SHA_DESC),
    allowUnsafeScript: boolish.default(false).describe(UNSAFE_JS_DESC),
  },
  async ({ path: p, event, js, match, className, aggregate, expectedSha256, patchFind, patchReplace, patchAll, allowShrink }) => ok(setWebWriteJs(p, { event, js, match, className, aggregate, expectedSha256, patchFind, patchReplace, patchAll, allowShrink })));

tool('set_webpage_js', '【S6 边界·分页预览】写模板级 <ReportWebAttr><WebPageContent> 的分页预览 Web 事件脚本（官方 50 例全部 afterload：分页预览「加载结束」时执行）。这是分页预览 afterload 的唯一正确落点：set_report_listener 只写 Report 子级、set_webwrite_js 只写 WebWriteContent，都碰不到这里；update_report_node 整节点改写会连同同块审批人注入等 JS 一起覆盖。有 js → 写入/替换该 event 的 Listener；无 js → 删除该 event 的 Listener。同一 event 多 Listener 时必须传 match（目标 JS 独有特征子串）精确定位，禁止静默命中第一个；要合并散块传 aggregate=true。**大块只改一段（如删一行 console.log）必须用 patchFind+patchReplace 片段替换**：literal 查找、默认唯一命中、patchAll=true 允许多处、只改 CDATA 内命中片段，块内其余 JS/审批人注入/ToolBars/WebPage 原样保留；与 js 互斥。整块替换把 ≥4KB 旧块缩到 <60% 且少 ≥2KB 会被缩水护栏拒绝（确要整块替换传 allowShrink=true）；expectedSha256 可在 patch/替换/删除前核对目标块。容器缺失时自动在 ReportWebAttr 内创建标准骨架，自闭合则展开，错位则搬回（返回 repaired）。读侧用 get_report_listener({event, match}) 后按 area=webpage/scope=workbook 取块。可执行 JavaScript 默认被安全围栏拒绝，需明确传 allowUnsafeScript=true。',
  {
    path: pathSchema,
    event: z.string().min(1).describe('分页预览事件名（官方实测全部为 afterload；也接受 onload/beforeOutput 等 FR 支持事件）'),
    js: z.string().optional().describe('JS 代码（整块写入/替换；不传=删除该 event 的 Listener；aggregate=true 时不传=只合并现有散块；与 patchFind 互斥）'),
    aggregate: boolish.optional().describe('聚合/合并模式：同 event 已有 Listener 时把 JS 追加进现有 Content；已有多个同 event 块时按合并约定全部并为一个代码块（JS 依文档顺序拼接）；不传 js 时只做合并，不删除也不新建'),
    match: z.string().optional().describe('特征子串（可选）：同一 event 挂多个 Listener 时精确定位目标——填目标 JS 里独有的片段（如 "审批-分页"）'),
    patchFind: z.string().optional().describe(PATCH_FIND_DESC),
    patchReplace: z.string().optional().describe(PATCH_REPLACE_DESC),
    patchAll: boolish.optional().describe(PATCH_ALL_DESC),
    allowShrink: boolish.optional().describe(ALLOW_SHRINK_DESC),
    className: z.string().default('com.fr.js.JavaScriptImpl').describe(JS_IMPL_DESC),
    expectedSha256: z.string().optional().describe(EXPECTED_SHA_DESC),
    allowUnsafeScript: boolish.default(false).describe(UNSAFE_JS_DESC),
  },
  async ({ path: p, event, js, match, className, aggregate, expectedSha256, patchFind, patchReplace, patchAll, allowShrink }) => ok(setWebPageJs(p, { event, js, match, className, aggregate, expectedSha256, patchFind, patchReplace, patchAll, allowShrink })));

tool('set_toolbar_button_js', '【S6 边界·M59】写 WebWriteContent → ToolBars 内自定义按钮（CustomToolBarButton）的 JS。官方结构：<WebWriteContent><ToolBars><ToolBar><Widget class="com.fr.form.ui.CustomToolBarButton"><WidgetAttr/><Text>按钮文字</Text><IconName/><JavaScript class="com.fr.js.JavaScriptImpl"><Parameters/><Content>JS</Content></JavaScript></Widget>（官方 13 例实证，如 multipage「上一页」/「打印」；真实报表如「删除记录」按钮）。\n'
  + '定位三选一（必须给一个）：① buttonText=按钮 <Text> 显示文字（推荐，如 "删除记录"）；② index=ToolBar 内第几个 CustomToolBarButton（0 起）；③ match=按钮 JS 中特征子串（如 "OP_COL"）。\n'
  + '有 js → 写入/替换该按钮的 JavaScript（整块写入，mode=replace）；无 js → 删除该按钮的 JavaScript（mode=delete，按钮本身保留）。**大段按钮 JS 只改一段时用 patchFind+patchReplace 片段替换**（设计器转义 `]A` 感知、默认唯一命中、patchAll=true 允许多处、与 js 互斥、只改 Content CDATA 内文）；**整块写入把 ≥4KB 的旧按钮 JS 缩到 <60% 且少 ≥2KB 会被缩水护栏拒绝**（确要整块重写传 allowShrink=true）；expectedSha256 在 patch/整块替换/删除前核对目标 JavaScript 块。返回 mode=patch/replace/delete 与 jsBytesBefore/jsBytesAfter/jsLinesBefore/jsLinesAfter。可执行 JavaScript 默认被安全围栏拒绝，需明确传 allowUnsafeScript=true。\n'
  + '注意：本工具写「工具栏自定义按钮 JS」；填报 Web 事件脚本用 set_webwrite_js，报表事件用 set_report_listener，单元格事件 JS 用 add_cell_listener。'
  + '【新增】按钮本体请用 add_toolbar_button（本工具只写已存在按钮的 JS，按钮不存在会报错）；删整个按钮请用 delete_toolbar_button。【2026-10-20 容器修复】若 WebWriteContent 被放在 ReportWebAttr 外（旧工具产物），本工具会先自动搬回正确容器再写，并在返回体带 repaired；缺容器仍报错（用 set_webwrite_extras({path, repair:true}) 创建）。【2026-10-23 双工具栏】传 toolbar:"page" 可改写 <WebPageContent> 页面工具栏（首页/上一页/页码跳转/下一页/末页…）；两容器可同时存在且按钮同名，此前只认 write → page 那套的 match 一律「未找到」。不确定在哪个栏时传 toolbar:"auto" 依次查找。',
  {
    path: pathSchema,
    buttonText: z.string().optional().describe('按钮 <Text> 显示文字（推荐定位方式，如 "删除记录"/"打印"/"上一页"）'),
    index: z.coerce.number().int().min(0).optional().describe('ToolBar 内 CustomToolBarButton 序号（0 起）'),
    match: z.string().optional().describe('按钮 JS 中特征子串（定位方式之三）'),
    js: z.string().optional().describe('JS 代码（整块写入/替换；不传=删除该按钮的 JavaScript；与 patchFind 互斥）'),
    patchFind: z.string().optional().describe(PATCH_FIND_DESC),
    patchReplace: z.string().optional().describe(PATCH_REPLACE_DESC),
    patchAll: boolish.optional().describe(PATCH_ALL_DESC),
    allowShrink: boolish.optional().describe(ALLOW_SHRINK_DESC),
    expectedSha256: z.string().optional().describe(EXPECTED_SHA_DESC),
    className: z.string().default('com.fr.js.JavaScriptImpl').describe(JS_IMPL_DESC),
    allowUnsafeScript: boolish.default(false).describe(UNSAFE_JS_DESC),
    toolbar: z.enum(['write', 'page', 'view', 'auto']).default('write').describe('容器：write=填报/page=页面/view=预览/auto=依次找')
  },
  async ({ path: p, buttonText, index, match, js, className, toolbar, patchFind, patchReplace, patchAll, allowShrink, expectedSha256 }) => ok(setToolbarButtonJs(p, { buttonText, index, match, js, className, toolbar, patchFind, patchReplace, patchAll, allowShrink, expectedSha256 })));

tool('add_toolbar_button', '【S6 边界】在填报工具栏（WebWriteContent → ToolBars → ToolBar）【新增】一个自定义按钮（CustomToolBarButton）——补齐 set_toolbar_button_js 只能写已有按钮 JS 的缺口：按钮不存在时先用本工具建出来，再写 JS。官方结构：<Widget class="com.fr.form.ui.CustomToolBarButton"><WidgetAttr/><Text>按钮文字</Text><IconName/><JavaScript class="com.fr.js.JavaScriptImpl"><Parameters/><Content>JS</Content></JavaScript></Widget>（官方 13 例实证，如 multipage「上一页」/「打印」；真实报表如「删除记录」按钮）。\n'
  + 'buttonText 必填（按钮显示文字）；iconName 可选（图标名，缺省空）；js 可选——传了则按钮内直接带 JS（可执行 JavaScript 默认被安全围栏拒绝，需明确传 allowUnsafeScript=true），不传则只建空按钮，之后可用 set_toolbar_button_js 补 JS。\n'
  + '工具栏已存在时把按钮追加到 ToolBar 末尾；模板无 ToolBars/工具栏结构会自动创建完整 <ToolBars> 结构。同 ToolBar 内已有相同文字的自定义按钮会报重名错。\n'
  + '【内置按钮通道】builtin 可选（submit/verify/append-row/delete-row/import-append=导入Excel追加/import-clean=导入Excel清空后导入）：往既有工具栏【追加一颗设计器内置按钮】（自带 i18n 文案与图标，行为由 FineReport 内置实现），栏内已有按钮（含自定义 JS 按钮）一律原样保留；该通道按 class 判重，已存在则幂等返回 already-present。\n'
  + '与 set_fill_toolbar 的分工（重要）：set_fill_toolbar 是【整栏重建】，只认词表内置按钮，会冲掉栏内自定义按钮及其 JS（实测 9 按钮模板传 2 词 → 7 个自定义按钮全丢）；只想「加一颗内置按钮、不动现有按钮」请用本工具 builtin。buttonText 渠道只加自定义按钮（CustomToolBarButton）。建成后调位置用 move_toolbar_button，删除用 delete_toolbar_button。【2026-10-20 容器修复】若 WebWriteContent 被放在 ReportWebAttr 外（旧工具产物），本工具会先自动搬回正确容器再写，并在返回体带 repaired；缺容器仍报错（用 set_webwrite_extras({path, repair:true}) 创建）。',
  {
    path: pathSchema,
    buttonText: z.string().min(1).optional().describe('自定义按钮显示文字（buttonText 与 builtin 二选一；作为 <Text>，如 "删除记录"/"导出Excel"/"上一页"）'),
    builtin: z.enum(['submit', 'verify', 'append-row', 'delete-row', 'import-append', 'import-clean']).optional().describe('内置按钮名（与 buttonText 二选一）：import-append=导入Excel(追加) / import-clean=导入Excel(清空后导入)'),
    iconName: z.string().optional().describe('按钮图标名（可选，如 "previous"/"print"；自定义按钮缺省空，内置按钮缺省用其自带图标）'),
    js: z.string().optional().describe('JS 代码（仅自定义按钮：不传=只建按钮不含 JS，之后用 set_toolbar_button_js 补；内置按钮不接受 js）'),
    className: z.string().default('com.fr.js.JavaScriptImpl').describe(JS_IMPL_DESC),
    allowUnsafeScript: boolish.default(false).describe(UNSAFE_JS_DESC),
    toolbar: z.enum(['write', 'page', 'view']).default('write').describe('容器：write=填报(默认)/page=页面/view=预览')
  },
  async ({ path: p, buttonText, iconName, js, className, builtin, toolbar }) => ok(addToolbarButton(p, { buttonText, iconName, js, className, builtin, toolbar })));

tool('list_toolbar_buttons', '【只读·M78】列举工具栏按钮：序号/class/文字/图标/有无JS(含jsBytes/jsLines/sha256)；toolbar=write(默认)/page/all。删改前先列核对序号；改 JS 前用 sha256 做 expectedSha256 自卫。不修改文件。',
  {
    path: pathSchema,
    toolbar: z.enum(['write', 'page', 'view', 'all']).default('write').describe('容器：write(默认)/page/view/all'),
  },
  async ({ path: p, toolbar }) => ok(listToolbarButtons(p, { toolbar })));

tool('delete_toolbar_button', '【S6 边界·M78】删除填报工具栏内单个按钮整颗 <Widget>（按文字/index/JS特征子串定位）：可删旧排序按钮等多余自定义按钮，插件按钮（Excel导入/导出）亦可删。破坏性不可逆——删前请用报表模式 git 落库（删前建议先 list_toolbar_buttons 核对序号）。只删命中的一颗，其余按钮字节原样保留；删 JS 留按钮请用 set_toolbar_button_js。',
  {
    path: pathSchema,
    buttonText: z.string().optional().describe('按钮 <Text> 显示文字（精确匹配；多同名必须改用 index）'),
    index: z.coerce.number().int().min(0).optional().describe('ToolBar 内按钮序号（0 起，全部 Widget 按钮按显示顺序）'),
    match: z.string().optional().describe('按钮 XML 特征子串（如 JS 片段）'),
    toolbar: z.enum(['write', 'page', 'view']).default('write').describe('容器：write=填报(默认)/page=页面/view=预览')
  },
  async ({ path: p, buttonText, index, match, toolbar }) => ok(deleteToolbarButton(p, { buttonText, index, match, toolbar })));

tool('move_toolbar_button', '【S6 边界·M78】移动填报工具栏内单个按钮的位置（块级剪切+粘贴，按钮 XML 与 JS 原样搬运，插件按钮属性保留）：如把翻页按钮移到第一组。定位同 delete_toolbar_button；to=first/last/序号（移动后最终序号）。其余按钮相对顺序不变。',
  {
    path: pathSchema,
    buttonText: z.string().optional().describe('按钮 <Text> 显示文字'),
    index: z.coerce.number().int().min(0).optional().describe('ToolBar 内按钮序号（0 起）'),
    match: z.string().optional().describe('按钮 XML 特征子串'),
    to: z.union([z.enum(['first', 'last']), z.coerce.number().int().min(0)]).describe('目标位置：first=首位 / last=末位 / 数字序号（移动后最终序号）'),
    toolbar: z.enum(['write', 'page', 'view']).default('write').describe('容器：write=填报(默认)/page=页面/view=预览')
  },
  async ({ path: p, buttonText, index, match, to, toolbar }) => ok(moveToolbarButton(p, { buttonText, index, match, to, toolbar })));

tool('set_toolbar_button_icon', '【S6 边界·M78】修改存量工具栏按钮的图标（<IconName> 单节点替换，按钮 JS 与属性原样保留；新建按钮带图标请用 add_toolbar_button 的 iconName）。图标名自由文本，历史模板实证：submit/verify/appendrow/deleterow/previous/print/excel（插件 Excel导入用 customizexcel）；未实证的名字设计器可能显示空白，优先用实证名或传空字符串清图标。定位：buttonText（精确匹配）/ index / match 三选一。',
  {
    path: pathSchema,
    buttonText: z.string().optional().describe('按钮 <Text> 显示文字（精确匹配）'),
    index: z.coerce.number().int().min(0).optional().describe('ToolBar 内按钮序号（0 起）'),
    match: z.string().optional().describe('按钮 XML 特征子串'),
    iconName: z.string().describe('图标名（如 previous/print/excel；空字符串=清除图标）'),
    toolbar: z.enum(['write', 'page', 'view']).default('write').describe('容器：write=填报(默认)/page=页面/view=预览')
  },
  async ({ path: p, buttonText, index, match, iconName, toolbar }) => ok(setToolbarButtonIcon(p, { buttonText, index, match, iconName, toolbar })));

tool('set_webwrite_extras', '【S6 边界·M52】增/改/删 WebWriteContent 内子节点（EditRowColor/WebWrite/RptLocation/UnloadCheck/ShowWidgets/OtherAttr/ToolBars）。传 null=删，不传=不动。ToolBars 仅支持删（增改请用 set_fill_toolbar）。【2026-10-20 容器修复（P0）】本工具是 WebWriteContent 容器的唯一正确落点：模板缺容器时会在 WorkBook 级 <ReportWebAttr> 内创建默认骨架（不再插到 </Report> 前）；容器被旧工具放到 ReportWebAttr 外时，会先连同全部子节点整体搬回再改，并在返回体带 repaired/repairNotes。repair=true 表示「只修容器位置、不改任何子节点」，用于修复历史坏模板（修完重新 validate 应报 0 error）。',
  {
    path: pathSchema,
    editRowColor: z.union([z.null(), z.record(z.string(), z.string())]).optional(),
    webWrite: z.union([z.null(), z.record(z.string(), z.string())]).optional(),
    rptLocation: z.union([z.null(), z.record(z.string(), z.string())]).optional(),
    unloadCheck: z.union([z.null(), z.record(z.string(), z.string())]).optional(),
    showWidgets: z.union([z.null(), z.record(z.string(), z.string())]).optional(),
    otherAttr: z.union([z.null(), z.record(z.string(), z.string())]).optional(),
    toolBars: z.union([z.null(), z.literal(null)]).optional().describe('仅 null=删 ToolBars 整段；其他值忽略（请用 set_fill_toolbar）'),
    repair: boolish.optional().describe('只修容器位置、不改任何子节点：缺容器→在 ReportWebAttr 内创建默认骨架；容器在 ReportWebAttr 外→连同内容整体搬回。用于修复历史坏模板'),
  },
  async ({ path: p, editRowColor, webWrite, rptLocation, unloadCheck, showWidgets, otherAttr, toolBars, repair }) => ok(setWebWriteExtras(p, { editRowColor, webWrite, rptLocation, unloadCheck, showWidgets, otherAttr, toolBars, repair })));

tool('set_report_imports', '【S6 边界·M52】设置模板级 Web 页面静态资源引用（<ReportWebAttr> 内 <CSSImport>/<JSImport> 整段替换，FR 预览时按 webroot 相对路径加载服务器磁盘文件，如 css/index.css、js/index.js）。传的数组即落盘后的完整有序列表（先 CSS 后 JS，与设计器落盘顺序一致）：传空数组=清空该类引用；两类都不传则报错；不传的一类原样保留。路径只收 webroot 相对路径（禁 .. / 绝对路径 / 反斜杠 / http(s) 链接，后缀须与类型一致）。webroot 可选传服务器 webroot 目录，用于核对文件是否存在（缺失只告警、不阻断：本地与生产 webroot 常不一致）。注意：build_report 整表重建默认清空原引用，需用 spec.imports 显式重建或事后用本工具补回。',
  {
    path: pathSchema,
    css: z.array(z.string().min(1)).optional().describe('CSS 引用列表（按序写入 <CSSImport>；空数组=清空；不传=不动）'),
    js: z.array(z.string().min(1)).optional().describe('JS 引用列表（按序写入 <JSImport>；空数组=清空；不传=不动）'),
    webroot: z.string().min(1).optional().describe('可选：服务器 webroot 绝对目录，用于核对引用的文件是否存在（缺失只告警）'),
  },
  async ({ path: p, css, js, webroot }) => ok(setReportImports(p, { css, js, webroot })));

// 页眉页脚的槽位内容规格：字符串=纯文本 / {text} / {formula} / {preset}
// 三种写法都收，是为了避免逼模型去猜 FR 公式语法（写错就生成打不开的模板）。
const hfContentSchema = z.union([
  z.string().min(1).describe('纯文本，直接显示（如 "机密"）'),
  z.object({
    text: z.string().min(1).optional().describe('纯文本内容'),
    formula: z.string().min(1).optional().describe('FR 公式源码，原样写入。可用 $$page_number / $$totalPage_number 引用页码'),
    preset: z.enum(['pageNumber', 'pageNumberShort']).optional()
      .describe('内置预设：pageNumber="第X页/共Y页"；pageNumberShort="X / Y"'),
  }).strict(),
]);
const hfSectionSchema = z.object({
  left: hfContentSchema.optional().describe('左对齐区内容'),
  center: hfContentSchema.optional().describe('居中区内容'),
  right: hfContentSchema.optional().describe('右对齐区内容'),
}).strict().optional().describe('三个区，各自可给内容；不给则为空');

tool('set_page_header_footer', '设置页眉 / 页脚（打印时每页重复显示）。典型用法：页脚居中放页码，页眉左侧放报表名或"机密"字样。每个区的内容可写纯文本，也可用 {preset:"pageNumber"} 直接拿官方样式的页码，或 {formula:"..."} 写自定义 FR 公式（可用 $$page_number、$$totalPage_number）。只给 header 或只给 footer 都可以，未给的那部分保持原样。',
  {
    path: pathSchema,
    header: hfSectionSchema,
    footer: hfSectionSchema,
    fontSizePt: z.coerce.number().min(1).max(72).default(9).describe('页眉页脚字号（pt，默认 9）'),
    fontName: z.string().default('微软雅黑').describe('字体名'),
    sheet: sheetSchema.optional().describe(SHEET_DESC),
  },
  async ({ path: p, header, footer, fontSizePt, fontName, sheet }) =>
    ok(setPageHeaderFooter(p, { header, footer, fontSizePt, fontName, sheet })));

tool('delete_page_header_footer', '删除指定工作表 ReportAttrSet 内的 <Header> 或 <Footer> 块（清成无页眉页脚）。',
  { path: pathSchema, which: z.enum(['header', 'footer']).describe('删哪个：header 或 footer'), sheet: sheetSchema.optional() },
  async ({ path: p, which, sheet }) => ok(deletePageHeaderFooter(p, { which, sheet })));

tool('set_template_theme', '设置模板整体主题（影响报表观感：配色、图表调色板等）。可用主题全部来自官方 1559 个样本的实测取值：兼容主题(158 例) / 经典浅灰(61) / 兼容(49) / 清爽科技(24) / 经典深灰(9)。想让生成的报表看着更"成品"，推荐 经典浅灰 或 清爽科技。幂等，重复调用只改名字不会叠加。',
  {
    path: pathSchema,
    theme: z.enum(['兼容主题', '经典浅灰', '兼容', '清爽科技', '经典深灰'])
      .describe('模板主题名（官方样本实测的全部取值，没有第六种）'),
  },
  async ({ path: p, theme }) => ok(setTemplateTheme(p, theme)));

tool('set_parameter_panel', '设置参数面板：标题 / 是否显示 / 位置 / 打开即查询（生成 ReportParameterAttr；已存在则只 upsert 传入属性，不清空其余属性与控件）。',
  {
    path: pathSchema,
    title: z.string().optional().describe('标题；省略时保留现有值（首次创建默认“参数”）'),
    showWindow: boolish.optional().describe('是否显示；省略时保留现有值（首次创建默认 true）'),
    windowPosition: z.coerce.number().int().optional().describe('窗口位置；省略时保留现有值（首次创建默认 1）'),
    delayPlaying: boolish.optional().describe('打开即查询：false=打开即查（首屏直接出数据）/ true=首屏空白等点查询（默认语义）；省略时不动。写 <Attributes delayPlaying>'),
  },
  async ({ path: p, title, showWindow, windowPosition, delayPlaying }) => ok(setParameterPanel(p, { title, showWindow, windowPosition, delayPlaying })));

tool('add_parameter_widget', '在参数面板新增筛选控件：下拉(comboBox)/下拉多选(comboCheckBox，返回值字符串+逗号分隔)/文本框(text)/日期(date)/复选(checkBox)/标签(label)/查询按钮(submitButton)。控件名与数据集参数同名即自动绑定（需 add_parameter 先加同名参数）。与 add_parameter 的区别：本工具生成面板控件本身，不新增参数定义。M117 同名防护：面板已有同名控件时默认拒绝（改属性/字典用 update_parameter_widget、改名用 rename_parameter_widget、先删用 delete_parameter_widget），确需刻意并存须显式 allowDuplicate=true。【布局/字典修复 2026-10-29】x/y 不传时自动接在现有控件右侧、超出面板宽度自动换行（此前默认 (10,10)，连续新增全部叠在左上角=筛选控件位置异常根因）；checkBox/comboCheckBox 必须提供 dictionary 或非空 items（此前 checkBox 静默丢弃 items → 空复选组）。',
  {
    path: pathSchema,
    name: z.string().min(1).describe('控件名（与参数同名自动绑定，如 产品类型）'),
    type: z.enum(['comboBox', 'comboCheckBox', 'text', 'textarea', 'date', 'checkBox', 'label', 'submitButton']).default('text'),
    label: z.string().optional().describe('显示标签。2026-10-29 起自动生成设计器同款「独立 Label 控件」放控件左侧（LabelName 在 Web 参数面板不渲染，这是此前筛选控件"缺少标签"的根因）；标签宽度按字数估算（约 22px/字），可再用 update_parameter_widget 调 x/y'),
    dictionary: z.object({
      type: z.enum(['db', 'table', 'custom', 'formula']).describe('db=数据库字典 / table=数据集字典 / custom=自定义 / formula=公式数据字典'),
      table: z.string().optional().describe('db：表名'),
      schema: z.string().optional(),
      ki: z.coerce.number().int().optional().describe('db：实际值列索引（-1 用列名）'),
      vi: z.coerce.number().int().optional().describe('db：显示值列索引'),
      kiName: z.string().optional().describe('db：实际值列名 / table：实际值字段'),
      viName: z.string().optional().describe('db：显示值列名 / table：显示值字段'),
      connection: z.string().optional().describe('db：数据连接名'),
      dsName: z.string().optional().describe('table：数据集名（如 ds1）'),
      formula: z.string().optional().describe('formula：值公式（如 =range(2010,2012)）'),
      eFormula: z.string().optional().describe('formula：显示公式（可缺省，如 =$$$+\'年\'）'),
    }).strict().optional().describe('下拉数据源；缺省为自定义空字典。formula=公式数据字典（官方参数面板侧 25 例、单元格侧 12 例）'),
    items: z.array(z.object({ key: z.string(), value: z.string() }).strict()).optional().describe('custom 字典项 [{key,value}]'),
    defaultValue: z.string().default('').describe('控件当前值 / 参数默认值'),
    x: z.coerce.number().int().optional().describe('控件横坐标（BoundsAttr x）。不传=自动排在现有控件右侧、超出面板宽度自动换行（不再默认 (10,10) 造成重叠）；要自定义布局再显式传'),
    y: z.coerce.number().int().optional().describe('控件纵坐标（BoundsAttr y）。不传=自动布局（与 x 一起生效）'),
    width: z.coerce.number().int().default(100), height: z.coerce.number().int().default(24),
    text: z.string().optional().describe('submitButton 按钮文字（默认 查询）'),
    hidden: boolish.optional().describe('隐藏控件：自动停靠到现有控件占位的右下边界（不占可见区域），适合 fine_username 等隐藏传值控件。注意：只挪位置，不写设计器「不可见」属性；真不可见请用 update_parameter_widget(visible=false)'),
    fontName: z.string().optional().describe('仅 type=label：标签字体（如 微软雅黑）'),
    fontSize: z.coerce.number().optional().describe('仅 type=label：字号 FR 单位（设计器常用 96）'),
    noBorder: boolish.optional().describe('仅 type=label：true=无边框（设计器实证形态）'),
    allowDuplicate: boolish.optional().describe('逃生舱：面板已有同名控件时仍追加第二个（默认 false=拒绝并报错指路 update_parameter_widget/rename_parameter_widget/delete_parameter_widget）'),
  },
  async ({ path: p, name, type, label, dictionary, items, defaultValue, x, y, width, height, text, hidden, fontName, fontSize, noBorder, allowDuplicate }) =>
    ok(addParameterWidget(p, { name, type, label, dictionary, items, defaultValue, x, y, width, height, text, hidden, fontName, fontSize, noBorder, allowDuplicate })));

tool('delete_parameter_widget', '删除参数面板上指定 name 的控件。',
  { path: pathSchema, name: z.string().min(1).describe('控件名（与 add_parameter_widget 的 name 一致）') },
  async ({ path: p, name }) => ok(deleteParameterWidget(p, name)));

tool('delete_mobile_widget_ref', '【P1-2 移动端孤儿清理】按 widgetName 定向删除移动端孤儿条目：MobileWidgetList 内 <Widget widgetName="X"/> 与 WidgetNameTagMap 内 <NameTag name="X" …/>（如控件删改后残留的 fine_username_c，移动端布局挂空）。只清孤儿：同名存活控件仍在时拒绝（先 delete_parameter_widget 删控件或 rename 改名）；两处皆无命中时抛错。只改 ReportParameterAttr 块内，不碰面板控件本体、Parameter 绑定与数据集层。',
  { path: pathSchema, name: z.string().min(1).describe('要清理的 widgetName（如 fine_username_c）') },
  async ({ path: p, name }) => ok(deleteMobileWidgetRef(p, { name })));

tool('rename_parameter_widget', '重命名参数面板上的控件（控件名 + 同名报告参数绑定 + WidgetNameTagMap 标签映射 + 移动端控件清单引用，四位一体同步改名）。面板结构里控件名出现在四处：① InnerWidget 内 <WidgetName name="X"/>（控件名本体）② WidgetNameTagMap 内 <NameTag name="X" tag="标签"/>（控件名→标签映射，167/260 面板有）③ <ReportParameterAttr> 内 <Parameter><Attributes name="X"/>（同名报告参数绑定，112/260 面板有）④ MobileWidgetList 内 <Widget widgetName="X"/>（移动端控件清单引用，237/260 面板有）。全部必须同步改名否则绑定断裂/移动端挂空。只改 <ReportParameterAttr> 块内；块外的同名 <Attributes name="X"/>（数据集参数、单元格条件引用，SQL ${X} 与公式的锚点）绝不改。模板内 JS 的 getWidgetByName("X") 属自由文本不改，返回 hint 提示用户确认。newName 须为字母/下划线开头，仅含字母数字下划线，长度 1-64，且不得与现有控件重名。',
  { path: pathSchema, name: z.string().min(1).describe('要改名的控件名（与 add_parameter_widget 的 name 一致）'), newName: z.string().min(1).regex(/^[A-Za-z_][\w]{0,63}$/, '须为字母/下划线开头，仅含字母数字下划线，长度 1-64').describe('新控件名') },
  async ({ path: p, name, newName }) => ok(renameParameterWidget(p, { name, newName })));

tool('update_parameter_widget', '【S6 边界·M80/M81/M84/M117】修改参数面板存量控件：visible=false 在 InnerWidget 的 <WidgetAttr> 加 invisible="true"（设计器「不可见」复选框，不占位；add_parameter_widget 的 hidden 只挪位置不等价）；visible=true 删该属性恢复可见；defaultValue 改文本/日期/下拉/复选/标签控件的 <widgetValue> 默认值（查询按钮等无值控件会拒绝），配 valueType="formula" 可写「控件值类型=公式」（<O t="XMLable" class="com.fr.base.Formula">，公式内容原样放 CDATA，如 ""）；x/y 改控件坐标（BoundsAttr）；fontName/fontSize 支持 Label 与按钮（Label 加 noBorder 去边框；按钮的 FRFont 落在 <Hotkeys> 之后，官方 5 例实证）；输入框/下拉的字体走模板主题，传了会拒绝。**M117 就地改字典**（此前只能 delete→add 重建，会丢坐标/字体/移动端引用）：dictionary:{type:"table",dsName,kiName?,viName?} / {type:"db",table,ki,vi,connection,schema?,kiName?,viName?} / {type:"custom",items:[...]} / {type:"formula",formula,eFormula?} 整块换；或原位改 items（CustomDictionary 整表替换）/ kiName+viName+table（TableDataDictionary）/ formula+eFormula（FormulaDictionary；eFormula 传空串=清空显示公式）。只动 <Dictionary> 块，控件其余字节原样保留；字典已一致时 mode=none 不写文件。**参数面板是全局的，无 sheet 参数**（不像 update_cell_dictionary）。控件本无 <Dictionary> 时拒绝（新建请用 add_parameter_widget）。六组以上至少传一组；get_parameter_panel 可读回 invisible/defaultValue 验收。**type 传 text/textarea 可在两种输入框之间切换 class**（V4 会话缺口：此前不能把 text 改成 textarea）。',
  {
    path: pathSchema,
    name: z.string().min(1).describe('面板控件名（与 add_parameter_widget 的 name 一致）'),
    type: z.enum(['text', 'textarea']).optional().describe('切换输入框 class：text=单行 TextEditor / textarea=多行 TextArea；仅支持 text↔textarea 互转，其它控件类型拒绝（避免破坏下拉/日期/按钮结构）'),
    visible: boolish.optional().describe('可见性：false=不可见 / true=恢复可见（不传=不动）'),
    defaultValue: z.string().optional().describe('控件默认值（文本/日期/下拉/复选/标签；配 valueType="formula" 时作为公式内容原样写入；不传=不动）'),
    valueType: z.enum(['text', 'formula']).optional().describe('控件值类型：formula=公式型（defaultValue 原样放入 <O class="com.fr.base.Formula"> 的 <Attributes> CDATA，如 "" / DATE(2024,1,1)）；缺省=文本型'),
    x: z.coerce.number().optional().describe('控件横坐标（BoundsAttr x；不传=不动）'),
    y: z.coerce.number().optional().describe('控件纵坐标（BoundsAttr y；不传=不动）'),
    width: z.coerce.number().positive().optional().describe('控件宽度（BoundsAttr width；不传=不动；必须 >0）'),
    height: z.coerce.number().positive().optional().describe('控件高度（BoundsAttr height；不传=不动；必须 >0）'),
    label: z.string().optional().describe('显示标签：同步改 LabelName 与配套可见 Label 控件（lbl_<name>）文字；传空字符串=删除标签；Label 控件则改其显示文字。不传=不动'),
    fontName: z.string().optional().describe('仅 Label：字体（如 微软雅黑）'),
    fontSize: z.coerce.number().optional().describe('仅 Label：字号 FR 单位（设计器常用 96，缺省 96）'),
    noBorder: boolish.optional().describe('仅 Label：true=无边框（设计器实证形态）'),
    dictionary: z.object({
      type: z.enum(['table', 'db', 'custom', 'formula']).describe('目标字典类型：table=数据集字典 / db=数据库表字典 / custom=自定义项 / formula=公式数据字典'),
      dsName: z.string().optional().describe('type=table 的数据集名（须已 add_dataset）'),
      kiName: z.string().optional().describe('type=table 的实际值列名'),
      viName: z.string().optional().describe('type=table 的显示值列名'),
      table: z.string().optional().describe('type=db 的数据库表名'),
      schema: z.string().optional().describe('type=db 的 schema（可空）'),
      ki: z.coerce.number().int().optional().describe('type=db 的实际值列索引（0 起）'),
      vi: z.coerce.number().int().optional().describe('type=db 的显示值列索引（0 起）'),
      connection: z.string().optional().describe('type=db 的数据库连接名'),
      items: z.array(z.object({ key: z.string(), value: z.string() }).strict()).optional().describe('type=custom 的字典项'),
      formula: z.string().optional().describe('type=formula 的值公式（如 =range(2010,2012)）'),
      eFormula: z.string().optional().describe('type=formula 的显示公式（可缺省）'),
    }).strict().optional().describe('M117 整块替换字典：把该控件下拉就地改成绑数据集/数据库表/自定义项/公式，坐标与其余字节原样保留；与 items/kiName/viName/table/formula/eFormula 互斥'),
    items: z.array(z.object({ key: z.string(), value: z.string() }).strict()).optional().describe('原位改自定义字典项 [{key,value}]，整表替换（仅 CustomDictionary；空数组=清空项）'),
    kiName: z.string().optional().describe('原位改实际值列名（仅 TableDataDictionary；不传=不动）'),
    viName: z.string().optional().describe('原位改显示值列名（仅 TableDataDictionary；不传=不动）'),
    table: z.string().optional().describe('原位改取数表名（仅 TableDataDictionary；不传=不动）'),
    formula: z.string().optional().describe('原位改公式字典的值公式（仅 FormulaDictionary；不传=不动）'),
    eFormula: z.string().optional().describe('原位改公式字典的显示公式（仅 FormulaDictionary；传空串=清空该块，回到官方仅有 FormulaDict 形态）'),
  },
  async ({ path: p, name, type, visible, defaultValue, valueType, x, y, width, height, label, fontName, fontSize, noBorder, dictionary, items, kiName, viName, table, formula, eFormula }) =>
    ok(updateParameterWidget(p, { name, type, visible, defaultValue, valueType, x, y, width, height, label, fontName, fontSize, noBorder, dictionary, items, kiName, viName, table, formula, eFormula })));

tool('set_grid', '设置行高/列宽（单位=144000/mm，默认行高723900≈5.03mm、列宽2743200≈19.05mm）。可传数组或仅数量。',
  {
    path: pathSchema,
    rowHeights: z.array(z.coerce.number().int().min(0)).optional().describe('各行高（长度不足时用默认补齐）'),
    columnWidths: z.array(z.coerce.number().int().min(0)).optional().describe('各列宽'),
    rowCount: z.coerce.number().int().min(1).optional().describe('按默认行高铺 rowCount 行'),
    columnCount: z.coerce.number().int().min(1).optional().describe('按默认列宽铺 columnCount 列'),
    updateDefault: boolish.default(false).describe('是否同步更新 defaultValue 全局默认'),
    sheet: sheetSchema.optional().describe(SHEET_DESC),
  },
  async ({ path: p, rowHeights, columnWidths, rowCount, columnCount, updateDefault, sheet }) =>
    ok(setGrid(p, { rowHeights, columnWidths, rowCount, columnCount, updateDefault, sheet })));

// ---------------- 增 ----------------

tool('add_parameter', '新增参数（P1-1 双层通道）：scope=dataset 写入数据集层 Parameters 段（供数据集 SQL 的 ${参数} 引用，可用 dsName 指定数据集，缺省首个）；scope=report 写入报表级 ReportParameterAttr（独立通道，与数据集层同名不再互斥，如 fine_username 隐藏传值；要求模板已有参数面板）。与 add_parameter_widget 区别：本工具只加参数定义，不生成参数面板控件。',
  {
    path: pathSchema, name: z.string().min(1), defaultValue: z.string().default(''),
    scope: z.enum(['dataset', 'report']).default('dataset').describe('作用域：dataset=数据集层（默认）/ report=报表级（跨层同名合法）'),
    dsName: z.string().optional().describe('数据集层时指定目标数据集（缺省首个数据集的 Parameters 段）'),
  },
  async ({ path: p, name, defaultValue, scope, dsName }) => ok(addParameter(p, name, defaultValue, scope, dsName)));

tool('add_fill_binding', '新增填报字段绑定（在指定提交的 DMLConfig 中追加 ColumnConfig）。【多 sheet 口径】submitIndex 编号规则：不传 sheet=全文档连续编号（跨表按文档顺序计数，多 sheet 时易错绑到别的表）；传 sheet=该表内相对索引（该表第1个提交=0）。多 sheet 报表必须传 sheet+表内索引；越界报错会直接给出提交分布与正确传参。**自由 SQL 提交（FreeSQLSubmiter）没有 DMLConfig/ColumnConfig，字段绑定对它无效**——SQL 里的 ${x} 用 update_fill_submit 的 parameters 声明（或 add_fill_submit 建提交时自动声明）。',
  {
    path: pathSchema,
    submitIndex: z.coerce.number().int().min(0).default(0).describe('提交序号（0起；不传sheet=全文档编号，传sheet=表内索引）'),
    field: z.string().min(1).describe('数据库字段名'),
    column: intParam.describe('绑定的单元格列号（0 起）'),
    row: intParam.describe('绑定的单元格行号（0 起）'),
    isKey: boolish.default(false).describe('是否主键'),
    skipUnmodified: boolish.default(false).describe('FR「未修改则跳过」：true=提交时跳过本次未修改的该列（列级智能提交）；默认 false=整行覆盖'),
    sheet: sheetSchema.optional().describe('工作表（0 起索引或名称）。多 sheet 且提交分布多表时必须传（此时 submitIndex 为表内相对索引）；单提交模板可省略'),
  },
  async ({ path: p, submitIndex, field, column, row, isKey, sheet, skipUnmodified }) =>
    ok(addFillBinding(p, submitIndex, field, column, row, isKey, sheet, skipUnmodified)));

tool('add_cell_highlight', '给单元格加条件属性（条件格式）：满足条件时改变样式或显示值。\n'
  + '【条件】三选一，不要混用：① formula 公式（最灵活，$$$=当前单元格值、row()=行号，如 "$$$ < 0" / "row() % 2 = 0" / "F7 - D7 > 0"）；'
  + '② compare 比较（{op:"lt", value:0} 这种结构化写法）；③ conditions 数组 + logic 做多条件 AND/OR 组合。\n'
  + '【效果】可同时给多个，每个效果生成一条条件属性：background 背景色 / fontColor 字色 / value 条件改值 / bold+fontSizePt+fontName 条件改字体。\n'
  + '【最经典用法】斑马纹：formula="row() % 2 = 0" + background 浅色（可选 scope:"row"）；负数标红：formula="$$$ < 0" 或 compare={op:"lt",value:0} + fontColor="#FF0000"。\n'
  + '可多次调用叠加多条条件。',
  {
    path: pathSchema,
    column: nonNegIntParam.describe(COLUMN_DESC),
    row: nonNegIntParam.describe(ROW_DESC),
    ...highlightSchema.shape,
  },
  async ({ path: p, column, row, ...rest }) =>
    ok(addCellHighlight(p, { column, row, ...rest })));

tool('delete_cell_highlight', '删除单元格内条件属性。formula 不传 → 清整个 <HighlightList>；传 formula → 按 formula 文本精确删除匹配的条件（FR 设计器按 formula 唯一标识）。',
  { path: pathSchema, column: nonNegIntParam, row: nonNegIntParam, formula: z.string().optional().describe('要删的 formula 文本（不传=清全部）'), sheet: sheetSchema.optional() },
  async ({ path: p, column, row, formula, sheet }) => ok(deleteCellHighlight(p, column, row, { formula, sheet })));

tool('get_cell_highlight', '【只读】读取单元格内全部条件属性（formula/background/fontColor/value/font）。',
  { path: pathSchema, column: nonNegIntParam, row: nonNegIntParam, sheet: sheetSchema.optional() },
  async ({ path: p, column, row, sheet }) => ok(getCellHighlight(p, column, row, { sheet })));

tool('check_report_js', '【只读】全模板 JS 语法检查（V8 不执行）：TopJS/报表与模板级 WebPage/WebWrite 事件/单元格/按钮/超链；报错给块内行号。validate/gate/引擎都不解析 JS——少括号这类错只有这里能拦。',
  { path: pathSchema },
  async ({ path: p }) => ok(checkReportJs(p)));

tool('add_cell_hyperlink', '给单元格挂超级链接或 JS 事件（点击/交互）。三种类型：\n'
  + '① reportlet —— 点击跳转到另一张报表，可用 params 把当前行的数据当参数传过去（做下钻报表就靠它）；\n'
  + '② url —— 点击跳转到外部网页；\n'
  + '③ script —— 点击时执行自定义 JS（如确认后删除当前行）。\n'
  + '传参写法：{订单号: "=$订单号"} 这样以等号开头会按公式处理，常用 "=A3" 直接引用单元格；\n'
  + '也可写固定值 {type: "detail"}。一个单元格可以挂多个事件，用 name 区分。',
  {
    path: pathSchema,
    column: nonNegIntParam.describe(COLUMN_DESC),
    row: nonNegIntParam.describe(ROW_DESC),
    type: z.enum(['reportlet', 'url', 'script'])
      .describe('链接类型：reportlet=跳转另一张报表 / url=跳转外部网页 / script=执行自定义 JS'),
    reportletPath: z.string().optional().describe('type=reportlet 必填：目标报表路径，如 "/demo/basic/产品明细.cpt"'),
    url: z.string().optional().describe('type=url 必填：目标网址，需带 http:// 或 https://'),
    script: z.string().optional().describe('type=script 必填：JS 代码'),
    allowUnsafeScript: boolish.default(false).describe(UNSAFE_JS_DESC),
    params: z.record(z.string(), z.union([z.string(), z.number()])).optional()
      .describe('传给目标报表的参数 {参数名: 值}。值以 = 开头按公式处理，如 "=A3" 引用单元格、"=$订单号" 引用参数；否则按固定文本'),
    target: z.enum(['_blank', '_self', '_dialog']).default('_blank')
      .describe('打开方式（官方样本仅这三种）：_blank=新窗口 / _self=当前窗口 / _dialog=对话框'),
    width: z.coerce.number().int().positive().optional().describe('弹窗宽度（默认 600）'),
    height: z.coerce.number().int().positive().optional().describe('弹窗高度（默认 400）'),
    post: boolish.optional().describe('是否用 POST 传参（默认 GET，参数会显示在 URL 上）'),
    name: z.string().optional().describe('事件名（默认 网络报表1 / 网页链接1 / 脚本1）'),
    sheet: sheetSchema.optional().describe('工作表：0 起索引或名称（缺省第 1 个；多 sheet 报表用 1/名称写第 2 个表，与读/删两端一致）'),
  },
  async ({ path: p, column, row, type, reportletPath, url, script, params, target, width, height, post, name, sheet }) =>
    ok(addCellHyperlink(p, { column, row, type, reportletPath, url, script, params, target, width, height, post, name, sheet })));

tool('add_cell_listener', '给单元格挂「控件事件」JavaScript —— 官方 <Listener event="..."><JavaScript class="..."><Parameters/><Content>JS</Content></JavaScript></Listener> 结构（填报控件/按钮的单元格级事件，官方 114 例实证，event 多为 afterinit/click/afteredit/stopedit）。\n'
  + '【只增】仅当该单元格内尚不存在同 event 的 Listener 时才写入；同 event 已有 Listener 时报错（修改请用 update_cell_listener，删除请用 delete_cell_listener），不覆盖、不删除、不靠增覆盖凑合改。\n'
  + '只改已存在 Listener 里的某一段？用 update_cell_listener({patchFind,patchReplace}) 片段替换（设计器转义 `]A` 感知、只改命中片段、其余原文原样保留）；本工具不做片段替换（只增语义，无旧块可改）。返回 mode=insert 与 jsBytesAfter，before 恒 0。\n'
  + '与 add_cell_hyperlink（<NameJavaScript> 超链接 JS）是两套机制；本工具专用于控件/单元格内嵌的 <Listener> 事件。可执行 JavaScript 默认被安全围栏拒绝，需明确传 allowUnsafeScript=true。',
  {
    path: pathSchema,
    column: nonNegIntParam.describe(COLUMN_DESC),
    row: nonNegIntParam.describe(ROW_DESC),
    event: z.string().min(1).describe('事件名：click/afterinit/afteredit/stopedit/statechange 等'),
    js: z.string().min(1).describe('JS 代码（必填；add_cell_listener 只增，不传会报错）'),
    className: z.string().default('com.fr.js.JavaScriptImpl').describe(JS_IMPL_DESC),
    allowUnsafeScript: boolish.default(false).describe(UNSAFE_JS_DESC),
    sheet: sheetSchema.optional(),
  },
  async ({ path: p, column, row, event, js, className, sheet }) => ok(setCellListener(p, column, row, { event, js, className, sheet })));

tool('add_cell_listener_batch', '批量给多个单元格挂「控件事件」JavaScript —— 同一段 Listener 事件 JS（如 stopedit/click/afterinit）一次性写入 cells 里列出的所有单元格，替代 N 次 add_cell_listener 调用（真实模板常见 20~36 个同事件 Listener，逐格调会烧 token）。\n'
  + '【只增】js 必填；每个单元格仅当尚不存在同 event 的 Listener 时才写入；同 event 已有 Listener 的格记 failed 并继续（不覆盖、不删除），与单格 add_cell_listener 只增口径一致。\n'
  + '每个单元格返回 mode：insert（新挂）/ failed（同 event 已有 Listener）。可执行 JavaScript 默认被安全围栏拒绝，需明确传 allowUnsafeScript=true。若各单元格需要不同 JS，请逐格用 add_cell_listener；修改请用 update_cell_listener_batch，删除请用 delete_cell_listener_batch。【非原子批量】逐项执行、单项失败记 failed 不中断（已成功项保留）；调用后检查 summary.failed/results 做补偿；单元格多格原子改写走 batch_mutate_cells（plan→apply）。',
  {
    path: pathSchema,
    cells: z.array(z.object({ column: nonNegIntParam, row: nonNegIntParam }).strict()).min(1).max(500).describe('目标单元格坐标列表（0 起，不可重复）'),
    event: z.string().min(1).describe('事件名：click/afterinit/afteredit/stopedit/statechange 等'),
    js: z.string().min(1).describe('JS 代码（必填；add_cell_listener_batch 只增，不传会报错）'),
    className: z.string().default('com.fr.js.JavaScriptImpl').describe(JS_IMPL_DESC),
    allowUnsafeScript: boolish.default(false).describe(UNSAFE_JS_DESC),
    sheet: sheetSchema.optional(),
  },
  async ({ path: p, cells, event, js, className, sheet }) => ok(batchAddCellListeners(p, cells, { event, js, className, sheet })));

tool('delete_cell_hyperlink', '删除单元格内超级链接/JS 事件。name 不传 → 删整组 NameJavaScriptGroup；传 name → 删指定 NameJavaScript（空组自动清空）。',
  { path: pathSchema, column: nonNegIntParam, row: nonNegIntParam, name: z.string().optional().describe('NameJavaScript 名称（与 add_cell_hyperlink 的 name 一致；不传=删整组）'), sheet: sheetSchema.optional() },
  async ({ path: p, column, row, name, sheet }) => ok(deleteCellHyperlink(p, column, row, { name, sheet })));

tool('delete_cell_sort', '【S6 边界·M79】只删单元格「扩展后排序」规则（<Expand>/<O> 内 <cellSortAttr> 的排序表达式），控件/条件属性/监听 JS 原样保留——重建数据格会丢这些，本工具不动它们。单格传 column+row；多格（如成品表 10 列）传 cells=[{column,row},...]（最多 500，不可重复）。本无规则的格返回 mode=none 跳过，不报错。删前建议 git 落库。',
  {
    path: pathSchema,
    column: nonNegIntParam.optional().describe('单元格列号（0 起；单格模式必填）'),
    row: nonNegIntParam.optional().describe('单元格行号（0 起；单格模式必填）'),
    cells: z.array(z.object({ column: nonNegIntParam, row: nonNegIntParam }).strict()).max(500).optional().describe('批量坐标（与 column+row 二选一）'),
    sheet: sheetSchema.optional().describe(SHEET_DESC),
  },
  async ({ path: p, column, row, cells, sheet }) => ok(deleteCellSort(p, { column, row, cells, sheet })));

tool('add_chart', '在指定单元格插入一张图表（柱形 / 折线 / 饼）。'
  + '只需要给「数据集 + X 轴分类字段 + 数值字段」，图表的骨架、配色、图例、坐标轴、数据定义全部由引擎按官方样本填充 —— '
  + '不要自己拼图表 XML（VanChart 的 Plot 子树有上百个标签，手写必错、错就是设计器打不开）。\n'
  + '① type：column 柱形（默认，比大小） / line 折线（看趋势） / pie 饼图（看占比，只支持一个数值列）。\n'
  + '② category：X 轴分类字段名，如 "地区" / "月份"。\n'
  + '③ values：数值列，可写 ["amount"]、["amount","qty"] 或 [{name:"amount", agg:"avg"}]；'
  + 'agg 可选 sum(默认) / avg / count / max / min / none。\n'
  + '④ colspan/rowspan：图表占的格子数（默认 4 列 × 12 行 ≈ 84mm 高），rowspan 越大图越高。\n'
  + '数据集必须先用 add_dataset / add_file_dataset 建好。想要"字段+数据源直接出带图的报表"，用 generate_report 并传 chart。',
  {
    path: pathSchema,
    column: nonNegIntParam.describe('图表左上角所在列（0 起）'),
    row: nonNegIntParam.describe('图表左上角所在行（0 起）'),
    type: z.enum(['column', 'line', 'pie']).default('column')
      .describe('柱形 column / 折线 line / 饼图 pie（饼图只支持一个数值列）'),
    dsName: z.string().min(1).describe('数据集名（必须已存在）'),
    category: z.string().min(1).describe('X 轴分类字段名，如 "地区"'),
    values: z.array(z.union([
      z.string().min(1),
      z.object({
        name: z.string().min(1).describe('数值字段名'),
        agg: z.enum(['sum', 'avg', 'count', 'max', 'min', 'none']).default('sum').describe('聚合方式'),
        label: z.string().optional().describe('图例上显示的名字（默认用字段名）'),
      }),
    ])).min(1).describe('数值列；一个 → 单系列，多个 → 多系列（饼图只能一个）'),
    title: z.string().optional().describe('图表标题（不传则用图表类型名）'),
    colspan: z.coerce.number().int().min(1).max(1000).default(4).describe('横向占几列'),
    rowspan: z.coerce.number().int().min(1).max(1000).default(12).describe('纵向占几行（12 行 ≈ 84mm）'),
    sheet: sheetSchema.optional().describe(SHEET_DESC),
  },
  async ({ path: p, column, row, type, dsName, category, values, title, colspan, rowspan, sheet }) =>
    ok(addChart(p, { column, row, type, dsName, category, values, title, colspan, rowspan, sheet })));

tool('add_float_element', '插入一个悬浮于网格之上的浮动文本元素（如大屏标语、水印式标注、环形图中心的大字数值）。'
  + 'XML 形态取自官方 76 例浮动文本实例，位置/尺寸用毫米（1mm=144000 单位换算由工具完成）。'
  + 'styleIndex 必须是已存在的样式（get_styles 可查）。官方图片浮动元素是 FR 私有编码，不支持，请勿尝试。',
  {
    path: pathSchema,
    content: z.string().min(1).describe('浮动文本内容'),
    styleIndex: z.coerce.number().int().min(0).default(0).describe('样式索引（先 add_style）'),
    leftMm: z.coerce.number().min(0).max(10000).default(10).describe('距左边缘毫米数'),
    topMm: z.coerce.number().min(0).max(10000).default(10).describe('距上边缘毫米数'),
    widthMm: z.coerce.number().min(1).max(10000).default(40).describe('宽度毫米数'),
    heightMm: z.coerce.number().min(1).max(10000).default(10).describe('高度毫米数'),
    name: z.string().optional().describe('元素名（缺省自动 FloatN；同工作表内不可重名）'),
    sheet: sheetSchema.optional().describe(SHEET_DESC),
  },
  async ({ path: p, content, styleIndex, leftMm, topMm, widthMm, heightMm, name, sheet }) =>
    ok(addFloatElement(p, { content, styleIndex, leftMm, topMm, widthMm, heightMm, name, sheet })));

// ---------------- P1 单独项补齐：改 / 删 / 查 语义工具 ----------------

tool('get_chart', '【只读】读取指定坐标图表单元格的当前配置：类型（column/line/pie）、标题、名称、数据集、分类字段、数值列（含聚合方式）、合并跨度 cs/rs。不修改文件。',
  { path: pathSchema, column: nonNegIntParam.describe('图表左上角列号（0 起）'), row: nonNegIntParam.describe('图表左上角行号（0 起）'), sheet: sheetSchema.optional().describe(SHEET_DESC) },
  async ({ path: p, column, row, sheet }) => ok(getChart(p, { column, row, sheet })));

tool('update_chart', '修改【已存在】图表单元格的配置（改）：标题 title / 数据集 dsName / 分类字段 category / 数值列 values / 图表类型 type（column/line/pie）。原位重算图表块，保留单元格坐标与合并跨度 cs/rs 不变；未传字段沿用图表现状（get_chart 可查）。不追加、不复制、不重建单元格 —— 新建图表请用 add_chart。',
  {
    path: pathSchema,
    column: nonNegIntParam.describe('图表左上角列号（0 起）'),
    row: nonNegIntParam.describe('图表左上角行号（0 起）'),
    type: z.enum(['column', 'line', 'pie']).optional().describe('改图表类型（column/line/pie；不传沿用现状）'),
    dsName: z.string().min(1).optional().describe('改数据集名（必须已存在）'),
    category: z.string().min(1).optional().describe('改 X 轴分类字段名'),
    values: z.array(z.union([
      z.string().min(1),
      z.object({
        name: z.string().min(1),
        agg: z.enum(['sum', 'avg', 'count', 'max', 'min', 'none']).default('sum'),
        label: z.string().optional(),
      }).strict(),
    ])).min(1).optional().describe('改数值列（饼图只能一个）；不传沿用现状'),
    title: z.string().optional().describe('改图表标题'),
    sheet: sheetSchema.optional().describe(SHEET_DESC),
  },
  async ({ path: p, column, row, type, dsName, category, values, title, sheet }) =>
    ok(updateChart(p, { column, row, type, dsName, category, values, title, sheet })));

tool('get_float_element', '【只读】读取指定工作表的浮动文本元素：名称 / 内容 / 样式索引 / 位置（毫米）。可传 name 过滤单个。不修改文件。',
  { path: pathSchema, name: z.string().optional().describe('浮动元素名（不传=列全部）'), sheet: sheetSchema.optional().describe(SHEET_DESC) },
  async ({ path: p, name, sheet }) => ok(getFloatElement(p, { name, sheet })));

tool('update_float_element', '修改【已存在】浮动文本元素（改）：内容 content / 样式 styleIndex / 位置 leftMm、topMm、widthMm、heightMm / 名称 newName。按 name 定位，未传字段沿用现状。不追加、不重建 —— 新建浮动元素请用 add_float_element。',
  {
    path: pathSchema,
    name: z.string().min(1).describe('要改的浮动元素名（与 add_float_element 的 name 一致）'),
    newName: z.string().optional().describe('新名称（可选，改名）'),
    content: z.string().optional().describe('新文本内容'),
    styleIndex: z.coerce.number().int().min(0).optional().describe('新样式索引（先 add_style 创建）'),
    leftMm: z.coerce.number().min(0).max(10000).optional().describe('距左边缘毫米数'),
    topMm: z.coerce.number().min(0).max(10000).optional().describe('距上边缘毫米数'),
    widthMm: z.coerce.number().min(1).max(10000).optional().describe('宽度毫米数'),
    heightMm: z.coerce.number().min(1).max(10000).optional().describe('高度毫米数'),
    sheet: sheetSchema.optional().describe(SHEET_DESC),
  },
  async ({ path: p, name, newName, content, styleIndex, leftMm, topMm, widthMm, heightMm, sheet }) =>
    ok(updateFloatElement(p, { name, newName, content, styleIndex, leftMm, topMm, widthMm, heightMm, sheet })));

tool('update_cell_hyperlink', '修改单元格内【已存在】的超级链接/JS 事件（按 name 定位，与 add_cell_hyperlink 的 name 一致）。可改：类型 type（reportlet/url/script）、reportletPath、url、script、params、target、width/height、post，newName 改名。未传字段沿用现状；type 变更会重建该事件块。可执行 JavaScript（type=script 或改 script）默认被安全围栏拒绝，需明确传 allowUnsafeScript=true。',
  {
    path: pathSchema,
    column: nonNegIntParam.describe(COLUMN_DESC),
    row: nonNegIntParam.describe(ROW_DESC),
    name: z.string().min(1).describe('要改的超链接事件名'),
    newName: z.string().optional().describe('新事件名（可选）'),
    type: z.enum(['reportlet', 'url', 'script']).optional().describe('改类型（不传沿用现状）'),
    reportletPath: z.string().optional().describe('type=reportlet 时的目标报表路径'),
    url: z.string().optional().describe('type=url 时的目标网址（http/https）'),
    script: z.string().optional().describe('type=script 时的 JS 代码'),
    allowUnsafeScript: boolish.default(false).describe('安全开关：仅明确确认后设为 true'),
    params: z.record(z.string(), z.union([z.string(), z.number()])).optional().describe('传参（不传沿用现状）'),
    target: z.enum(['_blank', '_self', '_dialog']).optional().describe('打开方式'),
    width: z.coerce.number().int().positive().optional().describe('弹窗宽'),
    height: z.coerce.number().int().positive().optional().describe('弹窗高'),
    post: boolish.optional().describe('是否 POST 传参'),
    sheet: sheetSchema.optional().describe(SHEET_DESC),
  },
  async ({ path: p, column, row, name, newName, type, reportletPath, url, script, params, target, width, height, post, sheet }) =>
    ok(updateCellHyperlink(p, column, row, { name, newName, type, reportletPath, url, script, params, target, width, height, post, sheet })));

tool('update_cell_highlight', '修改单元格内【已存在】的一条条件属性（条件格式，按 name / index / formula 三选一定位）。可改条件（newFormula / compare / conditions+logic）或效果（background / fontColor / value / bold+fontSizePt+fontName，一次改一个）。未传条件沿用原 <Condition> 块；未传 scope 沿用原作用范围（row=整行）。原位替换，不追加 —— 新增条件请用 add_cell_highlight。',
  {
    path: pathSchema,
    column: nonNegIntParam.describe(COLUMN_DESC),
    row: nonNegIntParam.describe(ROW_DESC),
    name: z.string().optional().describe('按条件属性名定位（如 条件属性1）'),
    index: z.coerce.number().int().min(0).optional().describe('按该单元格内条件属性 0 起序号定位'),
    formula: z.string().optional().describe('按现有条件公式定位（同 formula 多效果时须改用 name/index）'),
    newFormula: z.string().optional().describe('新条件公式（如 "$$$ > 100"）'),
    compare: z.object({ op: z.string(), value: z.union([z.string(), z.number()]) }).strict().optional().describe('新比较条件'),
    conditions: z.array(z.record(z.string(), z.any())).optional().describe('新多条件组合'),
    logic: z.enum(['and', 'or']).optional().describe('多条件组合逻辑'),
    background: z.string().optional().describe('新背景色 #RRGGBB'),
    fontColor: z.string().optional().describe('新字色 #RRGGBB'),
    value: z.string().optional().describe('新条件改值'),
    bold: boolish.optional().describe('新字体加粗'),
    fontSizePt: z.coerce.number().optional().describe('新字号（pt）'),
    fontName: z.string().optional().describe('新字体名'),
    scope: z.enum(['cell', 'row']).optional().describe('作用范围（不传沿用现状）'),
    sheet: sheetSchema.optional().describe(SHEET_DESC),
  },
  async ({ path: p, column, row, name, index, formula, newFormula, compare, conditions, logic, background, fontColor, value, bold, fontSizePt, fontName, scope, sheet }) =>
    ok(updateCellHighlight(p, { column, row, name, index, formula, newFormula, compare, conditions, logic, background, fontColor, value, bold, fontSizePt, fontName, scope, sheet })));

tool('get_cell_listener', '【只读】读取单元格内控件事件 Listener JS（可按 event 过滤）：event/className/js。≠get_report_listener（报表级）、≠get_webwrite_js（填报事件）。',
  { path: pathSchema, column: nonNegIntParam, row: nonNegIntParam, event: z.string().optional().describe('按事件名过滤（如 click/stopedit；不传=全部）'), sheet: sheetSchema.optional(), jsOffset: z.union([z.number(), z.string()]).optional().describe('字符分页起点（0 起，默认 0；越界/负数抛错）'), jsLimit: z.union([z.number(), z.string()]).optional().describe('字符分页长度（默认全量；0=返回空串）') },
  async ({ path: p, column, row, event, sheet, jsOffset, jsLimit }) => ok(getCellListener(p, column, row, { event, sheet, jsOffset, jsLimit })));

tool('update_cell_listener', '修改单元格内【已存在】的控件事件 Listener JS（按 event + 可选 match 定位）。整块改写传新 js（mode=replace）；**大段事件 JS 只改其中一段时传 patchFind+patchReplace 片段替换**（mode=patch；设计器转义 `]A` 感知、默认唯一命中、patchAll=true 允许多处、与 js 互斥、只改 Content CDATA 内文，其余原文原样保留）——两者必给其一（目标不存在则报错，不会静默插入）。**整块写入把 ≥4KB 的旧 Content 缩到 <60% 且少 ≥2KB 会被缩水护栏拒绝**（确要整块重写传 allowShrink=true）；expectedSha256 在 patch/整块替换前核对目标块。未传 className 时沿用原 Listener 的 className，不强制重置；内嵌提交宿主（DMLConfig）默认拒绝整块覆盖。返回 mode=patch/replace 与 jsBytesBefore/jsBytesAfter/jsLinesBefore/jsLinesAfter。可执行 JavaScript 默认被安全围栏拒绝，需明确传 allowUnsafeScript=true。铁律：读到的 jsLength 与实际收到长度不符或见 Omitted/截断标记时，禁止整块重写，先用 match 或 jsOffset/jsLimit 分段重读。',
  {
    path: pathSchema,
    column: nonNegIntParam.describe(COLUMN_DESC),
    row: nonNegIntParam.describe(ROW_DESC),
    event: z.string().min(1).describe('事件名（stopedit/click 等）'),
    js: z.string().min(1).optional().describe('新的 JS 代码（整块改写/替换；与 patchFind 互斥；与 patchFind 二选一必给）'),
    match: z.string().optional().describe('特征子串（同 event 多个 Listener 时精确定位）'),
    patchFind: z.string().optional().describe(PATCH_FIND_DESC),
    patchReplace: z.string().optional().describe(PATCH_REPLACE_DESC),
    patchAll: boolish.optional().describe(PATCH_ALL_DESC),
    allowShrink: boolish.optional().describe(ALLOW_SHRINK_DESC),
    className: z.string().optional().describe('JavaScriptImpl 子类（不传则沿用原 Listener 的 className）'),
    expectedSha256: z.string().optional().describe(EXPECTED_SHA_DESC),
    allowUnsafeScript: boolish.default(false).describe('安全开关：仅明确确认后设为 true'),
    sheet: sheetSchema.optional(),
  },
  async ({ path: p, column, row, event, js, match, className, sheet, expectedSha256, patchFind, patchReplace, patchAll, allowShrink }) => ok(updateCellListener(p, column, row, { event, js, match, className, sheet, expectedSha256, patchFind, patchReplace, patchAll, allowShrink })));

tool('delete_cell_listener', '删除单元格内【已存在】的控件事件 Listener JS（按 event + 可选 match 定位；不存在则报错）。与 add_cell_listener(js=空) 的宽松删除不同，本工具是严格的「删指定已存在监听器」。',
  { path: pathSchema, column: nonNegIntParam, row: nonNegIntParam, event: z.string().min(1).describe('事件名'), match: z.string().optional().describe('特征子串（同 event 多个 Listener 时精确定位）'), sheet: sheetSchema.optional() },
  async ({ path: p, column, row, event, match, sheet }) => ok(deleteCellListener(p, column, row, { event, match, sheet })));

tool('get_cell_sort', '【只读】读取单元格内全部「扩展后排序」规则（<Expand> 与 <O> 两处官方形态一并扫描）：sortArea（按哪一列）/ sortRule / direction（asc/desc/none）。不修改文件。',
  { path: pathSchema, column: nonNegIntParam, row: nonNegIntParam, sheet: sheetSchema.optional() },
  async ({ path: p, column, row, sheet }) => ok(getCellSort(p, { column, row, sheet })));

tool('update_cell_sort', '设置/替换单元格「扩展后排序」规则（改）：sort=[{area, direction}]（direction=asc/desc，多键按数组顺序）；sort=[] 删除排序规则。原位替换，控件/条件属性/监听 JS 原样保留。只对扩展格/DSColumn 格有意义。',
  {
    path: pathSchema,
    column: nonNegIntParam.describe(COLUMN_DESC),
    row: nonNegIntParam.describe(ROW_DESC),
    sort: z.array(z.object({ area: z.string().min(1), direction: z.enum(['asc', 'desc']) }).strict()).describe('排序规则数组；空数组=删除排序'),
    sheet: sheetSchema.optional(),
  },
  async ({ path: p, column, row, sort, sheet }) => ok(updateCellSort(p, { column, row, sort, sheet })));

tool('update_fill_submit', '修改【已存在】填报提交（改，按 submitIndex 定位；多 sheet 口径同 add_fill_binding：不传 sheet=全局编号，传 sheet=表内相对索引）：列映射形态可改 name/目标数据连接 dsName/目标表 table/schema/**提交类型 submitType/configType**/**提交条件 condition**/**全部列 skipUnmodified**；自由 SQL 形态可改 name/sql/dbName/**parameters**。submitType：intelligent（IntelliDMLConfig 智能提交）/ insert（InsertConfig 插入提交）——这是 sandbox2/v8 的能力缺口：Doris 等不支持智能提交的库必须改 insert。condition：如 "Y5=1"（不需要前导 =）写入 DMLConfig 的 FormulaCondition；传 "ListCondition" 表示空列表条件；传 null 或空串=清除条件。skipUnmodified：一次设置该提交全部 ColumnConfig 的「未修改则跳过」（列级智能提交）。自由 SQL 的 parameters 语义：传了=以此列表为准整块替换提交参数声明；只改 sql 时自动补齐 SQL 里新出现的 ${x} 声明（已有声明与自定义取值保留）；空数组=清空声明。不追加、不重建、不碰字段绑定（bindings 用 update_fill_binding）。未传字段沿用现状。',
  {
    path: pathSchema,
    submitIndex: z.coerce.number().int().min(0).default(0).describe('要改的提交序号（0 起）：不传 sheet=全文档连续编号；传 sheet=该表内相对索引；先用 get_fill_config 查'),
    name: z.string().optional().describe('新提交名称'),
    submitType: z.string().optional().describe('提交类型（列映射形态）：intelligent=IntelliDMLConfig 智能提交；insert=InsertConfig 插入提交（Doris 等不支持智能提交的库用）。也接受 InsertConfig / IntelliDMLConfig / smart 等写法'),
    dsName: z.string().optional().describe('新数据连接名（列映射形态）'),
    table: z.string().optional().describe('新目标表（列映射形态）'),
    schema: z.string().optional().describe('新 schema（列映射形态）'),
    condition: z.string().nullable().optional().describe('提交条件（列映射形态）：FormulaCondition 公式文本，如 "Y5=1"；不需要前导 =；传 "ListCondition" 表示空列表条件；null 或空串=清除条件。列位调整后旧条件不会自动改，用它修正'),
    skipUnmodified: boolish.optional().describe('列映射形态：一次设置该提交全部 ColumnConfig 的「未修改则跳过」（true=只写改动列；false=恢复整行覆盖）'),
    sql: z.string().optional().describe('新自由 SQL（自由 SQL 形态）；改后自动补齐新出现的 ${x} 提交参数声明'),
    dbName: z.string().optional().describe('新服务端数据连接名（自由 SQL 形态）'),
    parameters: z.array(z.object({
      name: z.string().min(1).describe('提交参数名（对应 SQL 里的 ${name}）'),
      value: z.string().optional().describe('取值表达式（缺省 =$name；可写 =1 或 =\'常量\'）'),
    })).optional().describe('提交参数声明（仅自由 SQL 形态）：传了=以此列表为准整块替换；空数组=清空声明；不传且改 sql=只补缺失声明'),
    sheet: sheetSchema.optional().describe('工作表（0起/名称；多提交跨表时必传，此时submitIndex为表内索引）'),
  },
  async ({ path: p, submitIndex, name, dsName, table, schema, sql, dbName, sheet, parameters, condition, skipUnmodified, submitType, configType }) =>
    ok(updateFillSubmit(p, { submitIndex, name, dsName, table, schema, sql, dbName, sheet, parameters, condition, skipUnmodified, submitType, configType })));

tool('update_sheet', '【S6 边界·M126】改工作表：改名（newName）和/或调整顺序（order，0 起目标序号）。改名只动 <Report name>，其余原样保留；调顺序按整块剪切再插回（字节原样搬运）。两者至少给一个。',
  {
    path: pathSchema,
    sheet: sheetSchema.describe('要改的工作表：0 起索引或名称'),
    newName: z.string().min(1).optional().describe('新工作表名（改名时必填）'),
    order: z.coerce.number().int().min(0).optional().describe('调整顺序：移动后该表的目标序号（0 起）'),
  },
  async ({ path: p, sheet, newName, order }) => ok(updateSheet(p, { sheet, newName, order })));

// ---------------- P2 批量项补齐：68 个 batch 工具 ----------------
// 统一形态：add_*_batch(items) / delete_*_batch(targets) / update_*_batch(items[{target,patch}]) / get_*_batch(targets)
// 每项独立结果（inserted/deleted/updated/read/skipped/failed），单项失败不整体崩溃（lib/batch.js 统一调度）。
const batchItemsSchema = z.array(z.record(z.string(), z.any())).min(1).max(1000).describe('批量项数组（每项=一次单工具调用，不含path）');
const batchTargetsSchema = z.array(z.record(z.string(), z.any())).min(1).max(1000).describe('批量定位数组（每项=单工具定位入参）');
const batchUpdateSchema = z.array(z.object({
  target: z.record(z.string(), z.any()).describe('定位目标（与单改工具一致）'),
  patch: z.record(z.string(), z.any()).describe('改动字段（与单改工具一致）'),
})).min(1).max(1000).describe('批量改：[{target, patch}]');

// 1. 数据集
tool('add_dataset_batch', '批量新增 SQL 数据集（items=add_dataset 入参数组，每项独立结果，单项失败不中断）。【非原子批量】逐项执行、单项失败记 failed 不中断（已成功项保留）；调用后检查 summary.failed/results 做补偿；单元格多格原子改写走 batch_mutate_cells（plan→apply）。', { path: pathSchema, items: batchItemsSchema },
  async ({ path: p, items }) => ok(await addDatasetBatch(p, items)));
tool('delete_dataset_batch', '批量删除数据集（targets=[{name}]，每项独立结果，单项失败不中断）。【非原子批量】逐项执行、单项失败记 failed 不中断（已成功项保留）；调用后检查 summary.failed/results 做补偿；单元格多格原子改写走 batch_mutate_cells（plan→apply）。', { path: pathSchema, targets: batchTargetsSchema },
  async ({ path: p, targets }) => ok(await deleteDatasetBatch(p, targets)));
tool('update_dataset_batch', '批量修改数据集 SQL（items=[{target:{datasetName},patch:{sql}}]，每项独立结果）。【非原子批量】逐项执行、单项失败记 failed 不中断（已成功项保留）；调用后检查 summary.failed/results 做补偿；单元格多格原子改写走 batch_mutate_cells（plan→apply）。', { path: pathSchema, items: batchUpdateSchema },
  async ({ path: p, items }) => ok(await updateDatasetBatch(p, items)));
tool('get_dataset_batch', '批量读取数据集（targets=[{name}]，返回逐项 found/data）。', { path: pathSchema, targets: batchTargetsSchema },
  async ({ path: p, targets }) => ok(await getDatasetBatch(p, targets)));

// 2. 数据集参数
tool('add_parameter_batch', '批量新增参数（items=[{name,defaultValue?,scope?,dsName?}]，scope=dataset/report，单项失败不中断）。【非原子批量】逐项执行、单项失败记 failed 不中断（已成功项保留）；调用后检查 summary.failed/results 做补偿；单元格多格原子改写走 batch_mutate_cells（plan→apply）。', { path: pathSchema, items: batchItemsSchema },
  async ({ path: p, items }) => ok(await addParameterBatch(p, items)));
tool('delete_parameter_batch', '批量删除参数（targets=[{name,scope?,dsName?}]，scope=auto/dataset/report）。【非原子批量】逐项执行、单项失败记 failed 不中断（已成功项保留）；调用后检查 summary.failed/results 做补偿；单元格多格原子改写走 batch_mutate_cells（plan→apply）。', { path: pathSchema, targets: batchTargetsSchema },
  async ({ path: p, targets }) => ok(await deleteParameterBatch(p, targets)));
tool('update_parameter_batch', '批量修改参数（items=[{target:{name,scope?,dsName?},patch:{defaultValue?,newName?,scope?}}]）。【非原子批量】逐项执行、单项失败记 failed 不中断（已成功项保留）；调用后检查 summary.failed/results 做补偿；单元格多格原子改写走 batch_mutate_cells（plan→apply）。', { path: pathSchema, items: batchUpdateSchema },
  async ({ path: p, items }) => ok(await updateParameterBatch(p, items)));
tool('get_parameter_batch', '批量读取参数（targets=[{name,scope?}]，scope 可限定层）。', { path: pathSchema, targets: batchTargetsSchema },
  async ({ path: p, targets }) => ok(await getParameterBatch(p, targets)));

// 3. 参数面板控件
tool('add_parameter_widget_batch', '批量新增参数面板控件（items=add_parameter_widget 的入参数组，逐项同单品语义）。非原子：逐项执行、失败记 failed 继续（已成功项保留），看 summary/results 补偿。一次调用替代 N 次单品调用。', { path: pathSchema, items: batchItemsSchema },
  async ({ path: p, items }) => ok(await addParameterWidgetBatch(p, items)));
tool('delete_parameter_widget_batch', '批量删除参数面板控件（targets=[{name}]）。【非原子批量】逐项执行、单项失败记 failed 不中断（已成功项保留）；调用后检查 summary.failed/results 做补偿；单元格多格原子改写走 batch_mutate_cells（plan→apply）。', { path: pathSchema, targets: batchTargetsSchema },
  async ({ path: p, targets }) => ok(await deleteParameterWidgetBatch(p, targets)));
tool('update_parameter_widget_batch', '批量修改参数面板控件（items=[{target:{name},patch}]，patch 同 update_parameter_widget）。非原子：逐项执行、失败记 failed 继续，看 summary/results 补偿。', { path: pathSchema, items: batchUpdateSchema },
  async ({ path: p, items }) => ok(await updateParameterWidgetBatch(p, items)));
tool('get_parameter_widget_batch', '批量读取参数面板控件（targets=[{name}]）。', { path: pathSchema, targets: batchTargetsSchema },
  async ({ path: p, targets }) => ok(await getParameterWidgetBatch(p, targets)));

// 4. 样式
tool('add_style_batch', '批量新增样式（items=add_style 入参数组，返回各自 styleIndex）。【非原子批量】逐项执行、单项失败记 failed 不中断（已成功项保留）；调用后检查 summary.failed/results 做补偿；单元格多格原子改写走 batch_mutate_cells（plan→apply）。', { path: pathSchema, items: batchItemsSchema },
  async ({ path: p, items }) => ok(await addStyleBatch(p, items)));
tool('delete_style_batch', '批量删除样式（targets=[{index,force?}]）。【非原子批量】逐项执行、单项失败记 failed 不中断（已成功项保留）；调用后检查 summary.failed/results 做补偿；单元格多格原子改写走 batch_mutate_cells（plan→apply）。', { path: pathSchema, targets: batchTargetsSchema },
  async ({ path: p, targets }) => ok(await deleteStyleBatch(p, targets)));
tool('update_style_batch', '批量修改样式定义（items=[{target:{index},patch}]，常见字体/字号/加粗/对齐/前后景色/边框）。【非原子批量】逐项执行、单项失败记 failed 不中断（已成功项保留）；调用后检查 summary.failed/results 做补偿；单元格多格原子改写走 batch_mutate_cells（plan→apply）。', { path: pathSchema, items: batchUpdateSchema },
  async ({ path: p, items }) => ok(await updateStyleBatch(p, items)));
tool('get_style_batch', '批量读取样式（targets=[{index}]）。', { path: pathSchema, targets: batchTargetsSchema },
  async ({ path: p, targets }) => ok(await getStyleBatch(p, targets)));

// 5. 单元格（批增删改已有 batch_mutate_cells，此处只补批查）
tool('get_cell_batch', '批量读取单元格（targets=[{column,row,sheet?}]，按坐标过滤 cells 清单）。', { path: pathSchema, targets: batchTargetsSchema },
  async ({ path: p, targets }) => ok(await getCellBatch(p, targets)));

// 6. 填报绑定
tool('add_fill_binding_batch', '批量新增填报字段绑定（items=add_fill_binding 入参数组）。【非原子批量】逐项执行、单项失败记 failed 不中断（已成功项保留）；调用后检查 summary.failed/results 做补偿；单元格多格原子改写走 batch_mutate_cells（plan→apply）。', { path: pathSchema, items: batchItemsSchema },
  async ({ path: p, items }) => ok(await addFillBindingBatch(p, items)));
tool('delete_fill_binding_batch', '批量删除填报字段绑定（targets=[{submitIndex?,field,sheet?}]）。【非原子批量】逐项执行、单项失败记 failed 不中断（已成功项保留）；调用后检查 summary.failed/results 做补偿；单元格多格原子改写走 batch_mutate_cells（plan→apply）。', { path: pathSchema, targets: batchTargetsSchema },
  async ({ path: p, targets }) => ok(await deleteFillBindingBatch(p, targets)));
tool('update_fill_binding_batch', '批量修改填报字段绑定（items=[{target:{submitIndex?,field,sheet?},patch}]）。【非原子批量】逐项执行、单项失败记 failed 不中断（已成功项保留）；调用后检查 summary.failed/results 做补偿；单元格多格原子改写走 batch_mutate_cells（plan→apply）。', { path: pathSchema, items: batchUpdateSchema },
  async ({ path: p, items }) => ok(await updateFillBindingBatch(p, items)));
tool('get_fill_binding_batch', '批量读取填报字段绑定（targets=[{submitIndex?,field}]）。', { path: pathSchema, targets: batchTargetsSchema },
  async ({ path: p, targets }) => ok(await getFillBindingBatch(p, targets)));

// 7. 填报提交
tool('add_fill_submit_batch', '批量新增填报提交（items=add_fill_submit 入参数组）。【非原子批量】逐项执行、单项失败记 failed 不中断（已成功项保留）；调用后检查 summary.failed/results 做补偿；单元格多格原子改写走 batch_mutate_cells（plan→apply）。', { path: pathSchema, items: batchItemsSchema },
  async ({ path: p, items }) => ok(await addFillSubmitBatch(p, items)));
tool('delete_fill_submit_batch', '批量删除填报提交（targets=[{submitIndex,sheet?}]）。【非原子批量】逐项执行、单项失败记 failed 不中断（已成功项保留）；调用后检查 summary.failed/results 做补偿；单元格多格原子改写走 batch_mutate_cells（plan→apply）。', { path: pathSchema, targets: batchTargetsSchema },
  async ({ path: p, targets }) => ok(await deleteFillSubmitBatch(p, targets)));
tool('update_fill_submit_batch', '批量修改填报提交（items=[{target:{submitIndex,sheet?},patch}]）。【非原子批量】逐项执行、单项失败记 failed 不中断（已成功项保留）；调用后检查 summary.failed/results 做补偿；单元格多格原子改写走 batch_mutate_cells（plan→apply）。', { path: pathSchema, items: batchUpdateSchema },
  async ({ path: p, items }) => ok(await updateFillSubmitBatch(p, items)));
tool('get_fill_submit_batch', '批量读取填报提交（targets=[{submitIndex}]）。', { path: pathSchema, targets: batchTargetsSchema },
  async ({ path: p, targets }) => ok(await getFillSubmitBatch(p, targets)));

// 8. 图表
tool('add_chart_batch', '批量插入图表（items=add_chart 入参数组）。【非原子批量】逐项执行、单项失败记 failed 不中断（已成功项保留）；调用后检查 summary.failed/results 做补偿；单元格多格原子改写走 batch_mutate_cells（plan→apply）。', { path: pathSchema, items: batchItemsSchema },
  async ({ path: p, items }) => ok(await addChartBatch(p, items)));
tool('delete_chart_batch', '批量删除图表（targets=[{column,row,sheet?}]）。【非原子批量】逐项执行、单项失败记 failed 不中断（已成功项保留）；调用后检查 summary.failed/results 做补偿；单元格多格原子改写走 batch_mutate_cells（plan→apply）。', { path: pathSchema, targets: batchTargetsSchema },
  async ({ path: p, targets }) => ok(await deleteChartBatch(p, targets)));
tool('update_chart_batch', '批量修改图表（items=[{target:{column,row,sheet?},patch}]）。【非原子批量】逐项执行、单项失败记 failed 不中断（已成功项保留）；调用后检查 summary.failed/results 做补偿；单元格多格原子改写走 batch_mutate_cells（plan→apply）。', { path: pathSchema, items: batchUpdateSchema },
  async ({ path: p, items }) => ok(await updateChartBatch(p, items)));
tool('get_chart_batch', '批量读取图表（targets=[{column,row,sheet?}]）。', { path: pathSchema, targets: batchTargetsSchema },
  async ({ path: p, targets }) => ok(await getChartBatch(p, targets)));

// 9. 浮动元素
tool('add_float_element_batch', '批量插入浮动文本元素（items=add_float_element 入参数组）。【非原子批量】逐项执行、单项失败记 failed 不中断（已成功项保留）；调用后检查 summary.failed/results 做补偿；单元格多格原子改写走 batch_mutate_cells（plan→apply）。', { path: pathSchema, items: batchItemsSchema },
  async ({ path: p, items }) => ok(await addFloatElementBatch(p, items)));
tool('delete_float_element_batch', '批量删除浮动元素（targets=[{name,sheet?}]）。【非原子批量】逐项执行、单项失败记 failed 不中断（已成功项保留）；调用后检查 summary.failed/results 做补偿；单元格多格原子改写走 batch_mutate_cells（plan→apply）。', { path: pathSchema, targets: batchTargetsSchema },
  async ({ path: p, targets }) => ok(await deleteFloatElementBatch(p, targets)));
tool('update_float_element_batch', '批量修改浮动元素（items=[{target:{name,sheet?},patch}]）。【非原子批量】逐项执行、单项失败记 failed 不中断（已成功项保留）；调用后检查 summary.failed/results 做补偿；单元格多格原子改写走 batch_mutate_cells（plan→apply）。', { path: pathSchema, items: batchUpdateSchema },
  async ({ path: p, items }) => ok(await updateFloatElementBatch(p, items)));
tool('get_float_element_batch', '批量读取浮动元素（targets=[{name,sheet?}]）。', { path: pathSchema, targets: batchTargetsSchema },
  async ({ path: p, targets }) => ok(await getFloatElementBatch(p, targets)));

// 10. 单元格超链接
tool('add_cell_hyperlink_batch', '批量给单元格挂超链接/JS 事件（items=add_cell_hyperlink 入参数组；type=url/script 走安全围栏）。【非原子批量】逐项执行、单项失败记 failed 不中断（已成功项保留）；调用后检查 summary.failed/results 做补偿；单元格多格原子改写走 batch_mutate_cells（plan→apply）。', { path: pathSchema, items: batchItemsSchema, allowUnsafeScript: boolish.default(false) },
  async ({ path: p, items }) => ok(await addCellHyperlinkBatch(p, items)));
tool('delete_cell_hyperlink_batch', '批量删除单元格超链接（targets=[{column,row,name?,sheet?}]）。【非原子批量】逐项执行、单项失败记 failed 不中断（已成功项保留）；调用后检查 summary.failed/results 做补偿；单元格多格原子改写走 batch_mutate_cells（plan→apply）。', { path: pathSchema, targets: batchTargetsSchema },
  async ({ path: p, targets }) => ok(await deleteCellHyperlinkBatch(p, targets)));
tool('update_cell_hyperlink_batch', '批量修改单元格超链接（items=[{target:{column,row,name,sheet?},patch}]）。【非原子批量】逐项执行、单项失败记 failed 不中断（已成功项保留）；调用后检查 summary.failed/results 做补偿；单元格多格原子改写走 batch_mutate_cells（plan→apply）。', { path: pathSchema, items: batchUpdateSchema, allowUnsafeScript: boolish.default(false) },
  async ({ path: p, items }) => ok(await updateCellHyperlinkBatch(p, items)));
tool('get_cell_hyperlink_batch', '批量读取单元格超链接（targets=[{column,row,sheet?}]）。', { path: pathSchema, targets: batchTargetsSchema },
  async ({ path: p, targets }) => ok(await getCellHyperlinkBatch(p, targets)));

// 11. 条件高亮
tool('add_cell_highlight_batch', '批量给单元格加条件属性（items=add_cell_highlight 的入参数组：column/row/formula|compare/…逐项同单品）。非原子：逐项执行、失败记 failed 继续，看 summary/results 补偿。', { path: pathSchema, items: batchItemsSchema },
  async ({ path: p, items }) => ok(await addCellHighlightBatch(p, items)));
tool('delete_cell_highlight_batch', '批量删除单元格条件属性（targets=[{column,row,formula?,sheet?}]）。【非原子批量】逐项执行、单项失败记 failed 不中断（已成功项保留）；调用后检查 summary.failed/results 做补偿；单元格多格原子改写走 batch_mutate_cells（plan→apply）。', { path: pathSchema, targets: batchTargetsSchema },
  async ({ path: p, targets }) => ok(await deleteCellHighlightBatch(p, targets)));
tool('update_cell_highlight_batch', '批量修改单元格条件属性（items=[{target:{column,row,...定位},patch}]）。【非原子批量】逐项执行、单项失败记 failed 不中断（已成功项保留）；调用后检查 summary.failed/results 做补偿；单元格多格原子改写走 batch_mutate_cells（plan→apply）。', { path: pathSchema, items: batchUpdateSchema },
  async ({ path: p, items }) => ok(await updateCellHighlightBatch(p, items)));
tool('get_cell_highlight_batch', '批量读取单元格条件属性（targets=[{column,row,sheet?}]）。', { path: pathSchema, targets: batchTargetsSchema },
  async ({ path: p, targets }) => ok(await getCellHighlightBatch(p, targets)));

// 12. 单元格控件监听（批增已有 add_cell_listener_batch）
tool('delete_cell_listener_batch', '批量删除单元格控件事件 Listener（targets=[{column,row,event,match?,sheet?}]）。【非原子批量】逐项执行、单项失败记 failed 不中断（已成功项保留）；调用后检查 summary.failed/results 做补偿；单元格多格原子改写走 batch_mutate_cells（plan→apply）。', { path: pathSchema, targets: batchTargetsSchema },
  async ({ path: p, targets }) => ok(await deleteCellListenerBatch(p, targets)));
tool('update_cell_listener_batch', '批量修改单元格控件事件 Listener（items=[{target:{column,row,event,match?,sheet?},patch:{js}}]）。【非原子批量】逐项执行、单项失败记 failed 不中断（已成功项保留）；调用后检查 summary.failed/results 做补偿；单元格多格原子改写走 batch_mutate_cells（plan→apply）。', { path: pathSchema, items: batchUpdateSchema, allowUnsafeScript: boolish.default(false) },
  async ({ path: p, items }) => ok(await updateCellListenerBatch(p, items)));
tool('get_cell_listener_batch', '批量读取单元格控件事件 Listener（targets=[{column,row,event?,sheet?}]）。', { path: pathSchema, targets: batchTargetsSchema },
  async ({ path: p, targets }) => ok(await getCellListenerBatch(p, targets)));

// 13. 报表事件 Listener（报表JS 事件）
tool('add_report_listener_batch', '批量新增报表事件 Listener（items=set_report_listener 入参数组，js 走安全围栏）。【非原子批量】逐项执行、单项失败记 failed 不中断（已成功项保留）；调用后检查 summary.failed/results 做补偿；单元格多格原子改写走 batch_mutate_cells（plan→apply）。', { path: pathSchema, items: batchItemsSchema, allowUnsafeScript: boolish.default(false) },
  async ({ path: p, items }) => ok(await addReportListenerBatch(p, items)));
tool('delete_report_listener_batch', '批量删除报表事件 Listener（targets=[{event,match?,sheet?}]）。【非原子批量】逐项执行、单项失败记 failed 不中断（已成功项保留）；调用后检查 summary.failed/results 做补偿；单元格多格原子改写走 batch_mutate_cells（plan→apply）。', { path: pathSchema, targets: batchTargetsSchema },
  async ({ path: p, targets }) => ok(await deleteReportListenerBatch(p, targets)));
tool('update_report_listener_batch', '批量修改报表事件 Listener（items=[{target:{event,match?,sheet?},patch}]）。【非原子批量】逐项执行、单项失败记 failed 不中断（已成功项保留）；调用后检查 summary.failed/results 做补偿；单元格多格原子改写走 batch_mutate_cells（plan→apply）。', { path: pathSchema, items: batchUpdateSchema, allowUnsafeScript: boolish.default(false) },
  async ({ path: p, items }) => ok(await updateReportListenerBatch(p, items)));
tool('get_report_listener_batch', '批量读取报表事件 Listener（targets=[{event?,sheet?}]）。', { path: pathSchema, targets: batchTargetsSchema },
  async ({ path: p, targets }) => ok(await getReportListenerBatch(p, targets)));

// 14. 工具栏按钮
tool('add_toolbar_button_batch', '批量新增填报工具栏自定义按钮（items=add_toolbar_button 入参数组，js 走安全围栏）。【非原子批量】逐项执行、单项失败记 failed 不中断（已成功项保留）；调用后检查 summary.failed/results 做补偿；单元格多格原子改写走 batch_mutate_cells（plan→apply）。', { path: pathSchema, items: batchItemsSchema, allowUnsafeScript: boolish.default(false) },
  async ({ path: p, items }) => ok(await addToolbarButtonBatch(p, items)));
tool('delete_toolbar_button_batch', '批量删除工具栏按钮（targets=[{buttonText|index|match}]）。【非原子批量】逐项执行、单项失败记 failed 不中断（已成功项保留）；调用后检查 summary.failed/results 做补偿；单元格多格原子改写走 batch_mutate_cells（plan→apply）。', { path: pathSchema, targets: batchTargetsSchema },
  async ({ path: p, targets }) => ok(await deleteToolbarButtonBatch(p, targets)));
tool('update_toolbar_button_batch', '批量修改工具栏按钮（items=[{target:{buttonText|index|match},patch:{js?|iconName?}}]）。【非原子批量】逐项执行、单项失败记 failed 不中断（已成功项保留）；调用后检查 summary.failed/results 做补偿；单元格多格原子改写走 batch_mutate_cells（plan→apply）。', { path: pathSchema, items: batchUpdateSchema, allowUnsafeScript: boolish.default(false) },
  async ({ path: p, items }) => ok(await updateToolbarButtonBatch(p, items)));
tool('get_toolbar_button_batch', '批量读取工具栏按钮（targets=[{buttonText|index}]，省略 targets=读全部按钮）。', { path: pathSchema, targets: batchTargetsSchema.optional() },
  async ({ path: p, targets }) => ok(await getToolbarButtonBatch(p, targets)));

// 15. 单元格扩展后排序
tool('add_cell_sort_batch', '批量设置单元格扩展后排序规则（items=[{column,row,sort,sheet?}]，sort 非空）。【非原子批量】逐项执行、单项失败记 failed 不中断（已成功项保留）；调用后检查 summary.failed/results 做补偿；单元格多格原子改写走 batch_mutate_cells（plan→apply）。', { path: pathSchema, items: batchItemsSchema },
  async ({ path: p, items }) => ok(await addCellSortBatch(p, items)));
tool('delete_cell_sort_batch', '批量删除单元格扩展后排序（targets=[{column,row,sheet?}]）。【非原子批量】逐项执行、单项失败记 failed 不中断（已成功项保留）；调用后检查 summary.failed/results 做补偿；单元格多格原子改写走 batch_mutate_cells（plan→apply）。', { path: pathSchema, targets: batchTargetsSchema },
  async ({ path: p, targets }) => ok(await deleteCellSortBatch(p, targets)));
tool('update_cell_sort_batch', '批量替换单元格扩展后排序（items=[{target:{column,row,sheet?},patch:{sort}}]）。【非原子批量】逐项执行、单项失败记 failed 不中断（已成功项保留）；调用后检查 summary.failed/results 做补偿；单元格多格原子改写走 batch_mutate_cells（plan→apply）。', { path: pathSchema, items: batchUpdateSchema },
  async ({ path: p, items }) => ok(await updateCellSortBatch(p, items)));
tool('get_cell_sort_batch', '批量读取单元格扩展后排序（targets=[{column,row,sheet?}]）。', { path: pathSchema, targets: batchTargetsSchema },
  async ({ path: p, targets }) => ok(await getCellSortBatch(p, targets)));

// 16. 定时任务
tool('add_schedule_batch', '批量新增定时任务（items=schedule_add 入参数组）。【非原子批量】逐项执行、单项失败记 failed 不中断（已成功项保留）；调用后检查 summary.failed/results 做补偿；单元格多格原子改写走 batch_mutate_cells（plan→apply）。', { path: pathSchema, items: batchItemsSchema },
  async ({ path: p, items }) => ok(await addScheduleBatch(p, items)));
tool('delete_schedule_batch', '批量删除定时任务（targets=[{taskId}]）。【非原子批量】逐项执行、单项失败记 failed 不中断（已成功项保留）；调用后检查 summary.failed/results 做补偿；单元格多格原子改写走 batch_mutate_cells（plan→apply）。', { path: pathSchema, targets: batchTargetsSchema },
  async ({ path: p, targets }) => ok(await deleteScheduleBatch(p, targets)));
tool('update_schedule_batch', '批量启停定时任务（items=[{target:{taskId},patch:{enabled}}]）。【非原子批量】逐项执行、单项失败记 failed 不中断（已成功项保留）；调用后检查 summary.failed/results 做补偿；单元格多格原子改写走 batch_mutate_cells（plan→apply）。', { path: pathSchema, items: batchUpdateSchema },
  async ({ path: p, items }) => ok(await updateScheduleBatch(p, items)));
tool('get_schedule_batch', '批量读取定时任务详情（targets=[{taskId}]）。', { path: pathSchema, targets: batchTargetsSchema },
  async ({ path: p, targets }) => ok(await getScheduleBatch(p, targets)));

// 17. 工作表
tool('add_sheet_batch', '批量追加工作表（items=add_sheet 入参数组）。【非原子批量】逐项执行、单项失败记 failed 不中断（已成功项保留）；调用后检查 summary.failed/results 做补偿；单元格多格原子改写走 batch_mutate_cells（plan→apply）。', { path: pathSchema, items: batchItemsSchema },
  async ({ path: p, items }) => ok(await addSheetBatch(p, items)));
tool('delete_sheet_batch', '批量删除工作表（targets=[{sheet}]，至少保留 1 个）。【非原子批量】逐项执行、单项失败记 failed 不中断（已成功项保留）；调用后检查 summary.failed/results 做补偿；单元格多格原子改写走 batch_mutate_cells（plan→apply）。', { path: pathSchema, targets: batchTargetsSchema },
  async ({ path: p, targets }) => ok(await deleteSheetBatch(p, targets)));
tool('update_sheet_batch', '批量重命名工作表（items=[{target:{sheet},patch:{newName}}]）。【非原子批量】逐项执行、单项失败记 failed 不中断（已成功项保留）；调用后检查 summary.failed/results 做补偿；单元格多格原子改写走 batch_mutate_cells（plan→apply）。', { path: pathSchema, items: batchUpdateSchema },
  async ({ path: p, items }) => ok(await updateSheetBatch(p, items)));
tool('get_sheet_batch', '批量读取工作表（targets=[{sheet}]）。', { path: pathSchema, targets: batchTargetsSchema },
  async ({ path: p, targets }) => ok(await getSheetBatch(p, targets)));

// 18. 页眉页脚
tool('add_page_header_footer_batch', '批量设置页眉页脚（items=set_page_header_footer 入参数组）。【非原子批量】逐项执行、单项失败记 failed 不中断（已成功项保留）；调用后检查 summary.failed/results 做补偿；单元格多格原子改写走 batch_mutate_cells（plan→apply）。', { path: pathSchema, items: batchItemsSchema },
  async ({ path: p, items }) => ok(await addPageHeaderFooterBatch(p, items)));
tool('delete_page_header_footer_batch', '批量删除页眉页脚（targets=[{which,sheet?}]）。【非原子批量】逐项执行、单项失败记 failed 不中断（已成功项保留）；调用后检查 summary.failed/results 做补偿；单元格多格原子改写走 batch_mutate_cells（plan→apply）。', { path: pathSchema, targets: batchTargetsSchema },
  async ({ path: p, targets }) => ok(await deletePageHeaderFooterBatch(p, targets)));
tool('update_page_header_footer_batch', '批量修改页眉页脚（items=[{target:{sheet?},patch}]）。【非原子批量】逐项执行、单项失败记 failed 不中断（已成功项保留）；调用后检查 summary.failed/results 做补偿；单元格多格原子改写走 batch_mutate_cells（plan→apply）。', { path: pathSchema, items: batchUpdateSchema },
  async ({ path: p, items }) => ok(await updatePageHeaderFooterBatch(p, items)));
tool('get_page_header_footer_batch', '批量读取页眉页脚（targets=[{sheet?}]）。', { path: pathSchema, targets: batchTargetsSchema },
  async ({ path: p, targets }) => ok(await getPageHeaderFooterBatch(p, targets)));

// ---------------- 改 ----------------

tool('update_parameter', '修改参数默认值或重命名参数（P1-1 双层通道）：scope=auto 跨层唯一时自动定位、两层同名时必须明确 scope；同层改名判重，跨层同名合法。',
  {
    path: pathSchema,
    name: z.string().min(1).describe('现有参数名'),
    defaultValue: z.string().optional().describe('新默认值'),
    newName: z.string().optional().describe('新参数名'),
    scope: z.enum(['auto', 'dataset', 'report']).default('auto').describe('作用域：auto=自动定位（默认）/ dataset=数据集层 / report=报表级'),
    dsName: z.string().optional().describe('数据集层时指定目标数据集'),
  },
  async ({ path: p, name, defaultValue, newName, scope, dsName }) => ok(updateParameter(p, name, defaultValue, newName, scope, dsName)));

tool('update_dataset', '修改数据集 SQL（替换 <Query> 中 CDATA）。',
  {
    path: pathSchema,
    datasetName: z.string().min(1).describe('数据集名，如 ds1'),
    sql: z.string().min(1).describe('新的 SQL 文本'),
  },
  async ({ path: p, datasetName, sql }) => ok(updateDatasetSql(p, datasetName, sql)));

// 2026-10-26 P0（v1 会话实测）：引擎/门禁都不执行 SQL，数据集 SQL 只能靠外部 Doris MCP 手工
// 跑 487 次验证、再手动同步回模板；"SQL 返回列 vs 单元格 dsColumn 绑定"也全靠人肉数。
// 本工具补上只读实跑 + 列名双向对账，写入前可先验候选 SQL。
tool('run_dataset_sql_check',
  '只读：实跑数据集SQL并核对返回列与dsColumn绑定（缺列点名）。target=local(缺省,内置SQLite)/real(真实库)/both(对账)；offline=仅prepare；候选SQL含 ${if(...)} 须先展开。quality_gate_cpt 只离线审计不实跑，疑难语法/绑定用它复核。',
  {
    path: pathSchema,
    datasetName: z.string().optional().describe('数据集名（缺省第一个 SQL 数据集）'),
    sql: z.string().optional().describe('候选 SQL（给了则不读模板）'),
    params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).optional()
      .describe('参数值 {name:value}，代入 ${name}'),
    maxRows: z.coerce.number().int().min(1).max(1000).default(20).describe('样例行数(默认20)'),
    explain: boolish.default(false).describe('true=只跑 EXPLAIN 看计划，不取数据'),
    force: boolish.default(false).describe('有未解析参数时仍执行（默认不执行）'),
    timeoutMs: z.coerce.number().int().min(1000).max(120000).optional().describe('超时毫秒（默认 20000）'),
    target: z.enum(['real', 'local', 'both']).optional().describe('缺省local(内置SQLite)/real真实库/both对账'),
    localDb: z.string().optional().describe('本地库名（缺省按连接映射）'),
    offline: boolish.default(false).describe('仅 target=local：true=只 prepare 校验语法/列名，不执行'),
  },
  async ({ path: p, datasetName, sql, params, maxRows, explain, force, timeoutMs, target, localDb, offline }) => {
    // 2026-11-04：target 缺省由 lib/sql-check.resolveSqlCheckTarget 解析（显式 > env CPT_MCP_SQL_TARGET
    // （别名 CPT_MCP_SQL_TEST_TARGET）> .cpt-mcp/localdb.json settings.sqlTestTarget > local），
    // 返回体额外带 target/targetRequested/targetEffective/targetSource；本地库未建时给 nextAction，不静默连真实库。
    return ok(await checkDatasetSqlAuto({
      cptPath: p, dsName: datasetName, sql, params, maxRows, explain, force, timeoutMs, target, localDb, offline,
    }));
  });

// ---------------- 内置 SQLite 本地测试库（2026-11-02；需 local_db 租约族） ----------------
// 定位：报表数据集 SQL 的离线测试/回归。本地库由 MCP 全权管理（建库/镜像 schema/造数/重置），
// 真实库仍只走 lib/db.js 的只读通道；外部库改不了、本地库随便改。
const localDbNameSchema = z.string().min(1).max(64).describe('本地库名（字母/数字/中文/._-；如 main）');

tool('get_local_db_status',
  '只读：查询内置 SQLite 本地测试库状态（Node/node:sqlite 是否可用、根目录、已建库/表数/schemaHash、连接→库映射配置）。本地库用于报表 SQL 离线测试，真实库仍只读。',
  {
    db: localDbNameSchema.optional().describe('只看某个库（缺省列出全部）'),
  },
  async ({ db }) => ok(getLocalDbStatus(db)));

tool('local_db_admin',
  '内置 SQLite 本地测试库运维（完整本地权限）：action=create 建库 / drop 删库（需 confirm:true）/ reset 重置 / snapshot 快照 / restore 恢复 / export 导出可入库的 schema.sql+data.sql / write_audit 读写入审计 / simulate_fill 在事务内试写填报提交并回滚（返回每 sheet insert/update 计数、重复写 key、旧行覆盖风险）。只操作 <cwd>/.cpt-mcp/localdb 下的库文件，不触碰外部真实库。',
  {
    action: z.enum(['create', 'drop', 'reset', 'snapshot', 'restore', 'export', 'write_audit', 'simulate_fill']).describe('运维动作；write_audit=读取 SQLite 写审计；simulate_fill=本地事务试写填报提交后回滚'),
    db: localDbNameSchema,
    confirm: boolish.default(false).describe('drop/reset 必须显式 true'),
    overwrite: boolish.default(false).describe('create 时是否覆盖已有库'),
    snapshot: z.string().max(64).optional().describe('快照名（缺省时间戳；restore 时必填）'),
    includeData: boolish.default(true).describe('export 是否包含数据（false=只导结构）'),
    tables: z.array(z.string()).optional().describe('export 只导指定表'),
    runId: z.string().optional().describe('write_audit：指定 runId（缺省最近一次）'),
    last: z.coerce.number().int().min(1).max(50).default(1).describe('write_audit：最近 N 个 run 中取第 last 个（1=最新）'),
    setup: boolish.default(false).describe('write_audit：先安装触发器并开始一个空 run（一般由 local_db_import action:"report" 自动做；手工建库时可用）'),
    path: z.string().optional().describe('simulate_fill：模板 .cpt 路径'),
    scenario: z.record(z.string(), z.array(z.record(z.string(), z.any()))).optional()
      .describe('simulate_fill：按 sheet 名/0起序号给目标字段行，如 {"sheet1":[{"id":1,"v":"new"}]}；__condition:false 可显式跳过该行'),
    submitMode: z.enum(['all-sheets', 'single-sheet']).default('all-sheets').describe('simulate_fill：all-sheets=按模板全部提交顺序模拟；single-sheet=只模拟 sheet 指定的工作表'),
    sheet: z.union([z.string(), z.coerce.number().int().min(0)]).optional().describe('simulate_fill：single-sheet 时的工作表名/0起序号'),
    submitIndex: z.coerce.number().int().min(0).optional().describe('simulate_fill：只模拟某个全局提交索引'),
    repeat: z.coerce.number().int().min(1).max(20).default(1).describe('simulate_fill：重复提交次数（检测重复写/幂等性）'),
  },
  async ({ action, db, confirm, overwrite, snapshot, includeData, tables, runId, last, setup, path: cptPath, scenario, submitMode, sheet, submitIndex, repeat }) => {
    if (action === 'create') return ok(createLocalDb(db, { overwrite }));
    if (action === 'drop') return ok(dropLocalDb(db, { confirm }));
    if (action === 'reset') {
      dropLocalDb(db, { confirm });
      return ok({ ...createLocalDb(db, { overwrite: true }), reset: true });
    }
    if (action === 'snapshot') return ok(await snapshotLocalDb(db, snapshot));
    if (action === 'restore') {
      if (!snapshot) throw new Error('restore 需要 snapshot 参数（snapshot 名）');
      return ok(await restoreLocalDb(db, snapshot));
    }
    if (action === 'export') return ok(exportLocalDbSql(db, { includeData, tables }));
    if (action === 'write_audit') {
      if (setup === true) {
        const active = getActiveWriteAuditRun(db);
        if (active) return ok({ ...active, reused: true, audit: readWriteAudit(db, { runId: active.runId }) });
        const run = startWriteAuditRun(db, { tables: tables || [] });
        return ok({ ...run, audit: readWriteAudit(db, { runId: run.runId }) });
      }
      return ok(readWriteAudit(db, { runId, last }));
    }
    if (action === 'simulate_fill') {
      if (!cptPath) throw new Error('simulate_fill 需要 path（模板 .cpt）');
      return ok(simulateFillSubmit({
        db, path: cptPath, scenario, mode: submitMode, sheet, submitIndex, repeat,
      }));
    }
    throw new Error(`未知 action：${action}`);
  });

tool('local_db_import',
  '向内置 SQLite 本地测试库导入数据/结构/测试准备：schema=从真实库只读镜像表结构（autoTables=true 时递归扫描当前项目 .cpt 数据集 SQL 任意深度的 FROM/JOIN，含 EXISTS/子查询/CTE/UNION；schema 限定名按裸表镜像）/ data=从真实库只读抽样数据 / auto=一条命令完成 schema+按需抽样（测试环境推荐；抽样默认 ≤200 行/表、≤5000 行合计，仅补空表、不覆盖本地造数；有真实连接时用，无连接返回可执行替代路径）/ **report=报表级测试环境：扫描 .cpt 全部数据集连接 + 填报提交目标表（列映射 table / 自由 SQL 的 UPDATE/INSERT/DELETE），逐个复制到内置 SQLite（有真实连接则只读镜像 schema+按需抽样，已存在则复用），返回未就绪连接/表与运行期预览清单；新建报表可配 ddl/table/rows 建 fixture** / seed=本地造数（JSON 行）/ sql=执行 .sql 文本或文件 / ddl=执行 MySQL CREATE TABLE 文本 / excel=Excel 导入离线仿真（读 .xlsx 或行×列矩阵，校验导入按钮/列位/标题/控件类型与本地目标表约束，并在事务内逐行 INSERT 后 ROLLBACK，不执行 FR 前端 JS）。schema/ddl 默认只补缺失表（已存在同名表跳过，绝不 DROP）；确要 DROP+重建须显式 replace:true。漏表先重跑 schema，不要把“本地缺表”误判成模板 SQL 错。外部真实库始终只读；report 只写本地 SQLite，不写业务库。',
  {
    action: z.enum(['schema', 'data', 'auto', 'report', 'seed', 'sql', 'ddl', 'excel']).describe('导入/测试准备类型'),
    db: localDbNameSchema,
    connection: z.string().optional().describe('真实库连接名（.cpt 里的数据连接名，如 Doris；schema/data/auto 必填；report 可限定只准备一个连接）'),
    path: z.string().optional().describe('auto/report/excel：模板 .cpt 路径（auto/report 扫表与填报目标；excel 读填报绑定/导入按钮）'),
    autoTables: boolish.default(true).describe('schema/data：未显式给 tables 时扫描项目 .cpt 的数据集 SQL 推导表清单（按 connection 过滤）'),
    tables: z.array(z.string()).optional().describe('表清单（schema/data/auto）'),
    root: z.string().optional().describe('autoTables 扫描起点（缺省当前工作目录）'),
    replace: boolish.default(false).describe('schema/ddl：已存在表是否 DROP 重建（默认 false 跳过）'),
    sampleRows: z.coerce.number().int().min(1).max(5000).default(200).describe('data/auto：每张表最多抽样行数（默认 200）'),
    maxTotalRows: z.coerce.number().int().min(1).max(200000).default(5000).describe('data/auto：总行数上限（默认 5000）'),
    append: boolish.default(false).describe('data：true=追加，false=覆盖同表数据'),
    autoSample: boolish.optional().describe('auto：false=只镜像结构不抽样（默认读 localdb.json settings.autoSample，缺省 true）'),
    writeAudit: boolish.optional().describe('report：是否安装 SQLite 写审计触发器并开始 run（缺省读 settings.writeAudit.enabled；true=强制，false=关闭）'),
    table: z.string().optional().describe('seed：目标表'),
    rows: z.array(z.record(z.string(), z.any())).optional().describe('seed：行对象数组'),
    mode: z.enum(['insert', 'replace', 'upsert']).default('insert').describe('seed：写入模式（upsert 需主键）'),
    sql: z.string().optional().describe('sql：SQL 文本（可多语句，事务执行）'),
    file: z.string().optional().describe('sql：.sql 文件路径'),
    ddl: z.string().optional().describe('ddl：MySQL CREATE TABLE 文本'),
    excelFile: z.string().optional().describe('excel：待导入 .xlsx 路径（与 matrix 二选一；不支持 .xls）'),
    matrix: z.array(z.array(z.union([z.string(), z.number(), z.boolean(), z.null()]))).optional()
      .describe('excel：宿主已读出的行×列矩阵（与 excelFile 二选一）'),
    sheet: z.union([z.string(), z.coerce.number().int().min(0)]).optional().describe('excel：sheet 名或 0 起索引（缺省首个）'),
    submitIndex: z.coerce.number().int().min(0).optional().describe('excel：填报提交索引（缺省 0）'),
    columnOffset: z.coerce.number().int().optional().describe('excel：xlsx 列→模板列偏移（缺省 0=按位置 1:1）'),
    headerRows: z.coerce.number().int().min(0).optional().describe('excel：标题行数（缺省=数据行起点-1）'),
    maxRows: z.coerce.number().int().min(1).max(5000).optional().describe('excel：最多仿真数据行数（缺省 2000）'),
    simulate: boolish.default(true).describe('excel：true=本地 SQLite 事务试跑 INSERT 后回滚（默认；不落库）'),
    requireButton: boolish.default(false).describe('excel：true=模板缺「导入Excel」按钮算 error（默认仅 warning）'),
  },
  async (args) => {
    const { action, db } = args;
    if (action === 'schema') {
      return ok(await importSchemaFromDb({
        db, connection: args.connection, tables: args.tables, autoTables: args.autoTables,
        root: args.root, replace: args.replace,
      }));
    }
    if (action === 'data') {
      return ok(await importDataFromDb({
        db, connection: args.connection, tables: args.tables, autoTables: args.autoTables,
        path: args.path, root: args.root,
        sampleRows: args.sampleRows, maxTotal: args.maxTotalRows, append: args.append,
      }));
    }
    if (action === 'auto') {
      return ok(await autoPrepareLocalDb({
        db, connection: args.connection, path: args.path, root: args.root, tables: args.tables,
        sampleRows: args.sampleRows, maxTotal: args.maxTotalRows, replace: args.replace,
        autoSample: args.autoSample,
      }));
    }
    if (action === 'report') {
      return ok(await prepareReportTestEnv({
        db, path: args.path, connection: args.connection,
        sampleRows: args.sampleRows, maxTotal: args.maxTotalRows, replace: args.replace,
        autoSample: args.autoSample, ddl: args.ddl, table: args.table, rows: args.rows, seedMode: args.mode,
        writeAudit: args.writeAudit,
      }));
    }
    if (action === 'seed') {
      return ok(seedLocalDb({ db, table: args.table, rows: args.rows, mode: args.mode }));
    }
    if (action === 'sql') return ok(importSqlIntoLocalDb({ db, sql: args.sql, file: args.file }));
    if (action === 'ddl') return ok(importDdlIntoLocalDb({ db, ddl: args.ddl, replace: args.replace }));
    if (action === 'excel') {
      return ok(checkExcelImport({
        path: args.path, excelFile: args.excelFile, matrix: args.matrix, sheet: args.sheet, db,
        connection: args.connection, submitIndex: args.submitIndex, columnOffset: args.columnOffset,
        headerRows: args.headerRows, maxRows: args.maxRows, simulate: args.simulate,
        requireButton: args.requireButton,
      }));
    }
    throw new Error(`未知 action：${action}`);
  });

tool('local_db_exec',
  '在内置 SQLite 本地测试库执行 SQL（完整本地权限）：mode=query 只读查询（默认），mode=exec 且 allowWrite=true 可建表/增删改查。安全围栏：单语句、拒绝 ATTACH/DETACH/VACUUM/PRAGMA/load_extension，库文件限制在 .cpt-mcp/localdb 内。不连接外部真实库。',
  {
    db: localDbNameSchema,
    sql: z.string().min(1).describe('SQL（单语句；MySQL 常用语法会经方言层改写）'),
    mode: z.enum(['query', 'exec']).default('query').describe('query=只读；exec=写（需 allowWrite:true）'),
    allowWrite: boolish.default(false).describe('exec 模式必须显式 true'),
    params: z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])).optional().describe('位置参数（? 占位符）'),
    maxRows: z.coerce.number().int().min(1).max(5000).default(200).describe('查询最多返回行数'),
    audit: boolish.default(false).describe('exec 模式：记录本次写入的 SQLite 写审计（事件数/影响行数/耗时），返回 writeSummary；需目标表已安装触发器或本次自动安装'),
  },
  async ({ db, sql, mode, allowWrite, params, maxRows, audit }) => {
    if (mode === 'exec' && !allowWrite) throw new Error('写操作需要显式 allowWrite:true（防止把查询误当写语句）');
    if (mode === 'exec' && audit === true) {
      // 已有 prepare/preview 的 active run 时直接复用，避免本地造数把预览审计 run 顶掉。
      const active = getActiveWriteAuditRun(db);
      const run = active || startWriteAuditRun(db, { tables: [], note: 'local_db_exec' });
      let result;
      try {
        result = runLocalSql(db, sql, { write: true, params, maxRows });
        if (!active) stopWriteAuditRun(db, { runId: run.runId });
        const wa = readWriteAudit(db, { runId: run.runId });
        return ok({ ...result, writeSummary: wa.totals, writeAudit: wa, writeAuditReusedActiveRun: Boolean(active) });
      } catch (e) {
        if (!active) stopWriteAuditRun(db, { runId: run.runId });
        throw e;
      }
    }
    return ok(runLocalSql(db, sql, { write: mode === 'exec', params, maxRows }));
  });

tool('local_db_schema',
  '只读：查看内置 SQLite 本地测试库的表结构（列/索引/行数），并可 compareWith 真实库连接做结构对账（缺表/缺列/类型/PK/索引差异）。',
  {
    db: localDbNameSchema,
    tables: z.array(z.string()).optional().describe('只看指定表（缺省前 50 张）'),
    compareWith: z.string().optional().describe('真实库连接名：与本地结构逐表对账（只读）'),
  },
  async ({ db, tables, compareWith }) => {
    const localSnap = localSchemaSnapshot(db);
    const names = tables && tables.length ? tables : Object.keys(localSnap).slice(0, 50);
    const detail = names.filter((t) => localSnap[t]).map((t) => ({
      table: t,
      columns: localSnap[t].columns,
      indexes: localSnap[t].indexes,
      rows: localSnap[t].rows,
    }));
    let compare = null;
    if (compareWith) {
      // 2026-11-07 P0：compareWith 是"用户显式点名"，必须先严格校验连接名 ——
      // resolveConnection 在只配了一个连接时会把未知名字回退过去，导致误查默认/生产库
      // （用户实测：compareWith:"不存在的连接" 也跑了真实库 SHOW TABLES）。
      const exact = resolveExactConnection(compareWith);
      const realTables = await listRealTables(exact.name);
      const expected = {};
      for (const t of names) {
        if (!realTables.includes(t)) continue;
        const [cols, idx] = await Promise.all([showFullColumns(exact.name, t), showIndexes(exact.name, t)]);
        Object.assign(expected, schemaSnapshotFromShow({ table: t, columns: cols, indexes: idx }));
      }
      compare = diffSchemaSnapshots(expected, localSnap);
    }
    return ok({
      db,
      tables: detail,
      tableCount: Object.keys(localSnap).length,
      ...(compare ? { compareWith, compare } : {}),
      note: compare
        ? 'compare=真实库结构 vs 本地结构差异；type/PK/索引差异若属本地 SQLite 类型映射限制可忽略，缺失表/列建议重新 local_db_import(schema)'
        : '本地库结构（SQLite）；与真实库的差异需要 compareWith',
    });
  });

tool('dataset_sql_parity',
  '只读诊断：真实库（只读）与内置 SQLite 本地测试库各跑一遍数据集 SQL，输出列/行数/样例值对账（verdict/caveats）。真实库仍是交付判定依据；本地结果只作离线参考。',
  {
    path: pathSchema,
    datasetName: z.string().optional().describe('数据集名（缺省第一个 SQL 数据集）'),
    localDb: z.string().optional().describe('本地库名（缺省按数据连接映射）'),
    params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).optional().describe('数据集参数值'),
    maxRows: z.coerce.number().int().min(1).max(1000).default(20).describe('每侧样例行数'),
    force: boolish.default(false).describe('有未解析参数时仍执行'),
  },
  async ({ path: p, datasetName, localDb, params, maxRows, force }) =>
    ok(await checkDatasetSqlBoth({ cptPath: p, dsName: datasetName, localDb, params, maxRows, force, sampleRows: Math.min(maxRows, 10) })));

tool('update_cell', '修改单元格【内容/提示/插入策略/内容类型/跨行跨列】（与样式无关；一次调用只做一类改动，分多次调用）：tooltip=提示文本；content=新内容（CDATA 原文；公式格传 = 开头公式即【原位改公式】——保持官方 Formula 对象，文本格传 = 开头会自动升级为公式对象）；contentType=切换绑定类型 text/formula/dsColumn/image（text 用 content/formula 用 formula 或 content/dsColumn 用 dsName+columnName/image 用 imageClass；已是对象内容需 force:true；原 set_cell_content_type 已并入）；colspan/rowspan=就地改跨行跨列（合并/拆分，1 或 null=取消，原 set_cell_span 已并入）；insertPolicy=填报插入策略（copy=插入新行时复制上一行该格的值 / default=走默认插入值 / null 或空串=删除该属性节点）。安全围栏：content 含可执行 JavaScript（<script>/eval/fetch 等）默认拒绝，明确确认后传 allowUnsafeScript=true 或设 CPT_MCP_ALLOW_UNSAFE_SCRIPT=1。改样式请用 update_cell_style，二者勿混。',
  {
    path: pathSchema,
    column: intParam,
    row: intParam,
    tooltip: z.string().optional().describe('新的单元格提示文本（格内无提示节点时自动补建官方 CellGUIAttr/ToolTipText；=$$$ 这类公式原文写入）'),
    content: z.string().optional().describe('新的 Content 内容（CDATA 原文）；以 = 开头时按公式处理：公式格原位改公式、文本格升级为官方公式对象（如 "=ROW()-4"）'),
    insertPolicy: z.string().nullable().optional().describe('填报行完整性·插入策略：copy=插入新行时复制上一行该格的值（官方枚举，位置 <C> 内 CellOptionalAttrHolder 之后、<Expand> 之前）/ default=走默认插入值 / null 或 ""=删除该属性节点（不传=不动）。官方枚举仅 copy/default/null'),
    contentType: z.enum(['text', 'formula', 'dsColumn', 'image']).optional().describe('切换单元格绑定类型（原 set_cell_content_type）：text=纯文本(content) / formula=公式(formula 或 content) / dsColumn=数据集列(dsName+columnName) / image=图片(imageClass+content)；与 tooltip/content/insertPolicy/colspan 互斥'),
    force: boolish.default(false).describe('contentType 模式：目标格已是对象内容（DSColumn/Image/公式）时 true=整块替换；false=拒绝并提示先 delete_cell'),
    formula: z.string().optional().describe('contentType=formula 的公式源码（带不带 = 均可，自动规范为单个 =）'),
    dsName: z.string().optional().describe('contentType=dsColumn 的数据集名'),
    columnName: z.string().optional().describe('contentType=dsColumn 的数据集列名'),
    summary: z.enum(['sum', 'avg', 'count', 'max', 'min']).optional().describe('contentType=dsColumn 的汇总模式（缺省分组）'),
    imageClass: z.string().optional().describe('contentType=image 的图片类名（缺省官方 ImageCellAttr）'),
    colspan: z.coerce.number().int().min(1).max(1000).nullable().optional().describe('跨列数（1 或 null=取消跨列；不传=不动；原 set_cell_span）'),
    rowspan: z.coerce.number().int().min(1).max(1000).nullable().optional().describe('跨行数（1 或 null=取消跨行；不传=不动；原 set_cell_span）'),
    allowUnsafeScript: boolish.default(false).describe('安全开关：仅明确确认后设为 true，允许 content 写入可执行 JavaScript'),
    sheet: sheetSchema.optional().describe(SHEET_DESC),
  },
  async ({ path: p, column, row, tooltip, content, insertPolicy, contentType, force, formula, dsName, columnName, summary, imageClass, colspan, rowspan, allowUnsafeScript, sheet }) => {
    // 一次调用只做一类改动（与既有 insertPolicy 互斥口径一致）：避免"以为两样都改了"的静默丢失。
    const spanGiven = colspan !== undefined || rowspan !== undefined;
    const classes = [
      contentType !== undefined ? 'contentType' : null,
      spanGiven ? 'colspan/rowspan' : null,
      tooltip !== undefined ? 'tooltip' : null,
      contentType === undefined && content !== undefined ? 'content' : null,
      insertPolicy !== undefined ? 'insertPolicy' : null,
    ].filter(Boolean);
    if (classes.length > 1) {
      throw new Error(`update_cell 一次只做一类改动（收到：${classes.join(' + ')}）：请分多次调用`);
    }
    if (contentType !== undefined) {
      // 原 set_cell_content_type 已并入（P0-1 2026-11-12）
      const { setCellContentType } = await import('./lib/edits.js');
      return ok(setCellContentType(p, { column, row, contentType, force, content, formula, dsName, columnName, summary, imageClass, sheet }));
    }
    if (spanGiven) return ok(setCellSpan(p, { column, row, sheet, colspan, rowspan })); // 原 set_cell_span
    if (tooltip !== undefined) return ok(updateCellTooltip(p, column, row, tooltip, sheet));
    if (content !== undefined) return ok(updateCellContent(p, column, row, content, sheet));
    if (insertPolicy !== undefined) return ok(updateCellInsertPolicy(p, column, row, insertPolicy, sheet));
    throw new Error('请至少提供 tooltip、content、contentType、colspan/rowspan 或 insertPolicy 之一');
  }, LIGHT_OPTS.update_cell);

tool('set_cell_content_type', '【已并入 update_cell({contentType,...})，本工具默认隐藏，只保留给 cell_primitive 批量失败降级通道】只换单元格绑定类型（控件保留）：text/formula/dsColumn/image。已是对象内容（如 DSColumn/Image/公式）传 force:true 整块替换；formula 模式自动归一为官方公式对象（单个前导 =）。绑定只写【单元格级】<O t="DSColumn">，绝不写进 <Widget><widgetValue>（官方 0 例）。',
  {
    path: pathSchema,
    column: intParam,
    row: intParam,
    contentType: z.enum(['text', 'formula', 'dsColumn', 'image']).describe('目标 contentType: text=纯文本(用 content 参数) / formula=公式(用 formula/content 参数，带不带 = 均可) / dsColumn=数据集列(用 dsName+columnName) / image=图片(用 imageClass/content)'),
    force: boolish.default(false).describe('目标格已是对象内容（<O t=...>，如 DSColumn/Image/公式）时：true=整块替换（控件/合并/监听器保留，原对象内容丢失）；false=拒绝并提示先 delete_cell'),
    content: z.string().optional().describe('text/image 模式的内容'),
    formula: z.string().optional().describe('formula 模式的公式源码（带不带 = 均可，如 SUM(A1:A10) 或 =SUM(A1:A10)；自动规范为单个 =）'),
    dsName: z.string().optional().describe('dsColumn 模式的数据集名'),
    columnName: z.string().optional().describe('dsColumn 模式的列名'),
    summary: z.enum(['sum', 'avg', 'count', 'max', 'min']).optional().describe('DSColumn 汇总模式（仅 contentType="dsColumn" 有效）：sum/avg/count/max/min，传了就以官方 SummaryGrouper 形态落盘，缺省为分组（FunctionGrouper）'),
    imageClass: z.string().optional().describe('image 模式的完整类名, 默认 com.fr.report.cell.cellattr.core.ImageCellAttr'),
    sheet: sheetSchema.optional().describe(SHEET_DESC),
  },
  async (args) => {
    const { setCellContentType } = await import('./lib/edits.js');
    return ok(setCellContentType(args.path, args));
  }, LIGHT_OPTS.set_cell_content_type);

tool('set_cell_widget', '【S6 边界·M68】修改现有单元格的【控件类型】—— 把单元格内嵌 <Widget class> 在官方白名单间切换（text→number 解决 "id 类型不匹配" 等）。只替换 class 属性值，<O t="DSColumn"> 数据绑定与子结构原样保留；type="none" 删除整块控件（单元格变回纯数据格）。官方各填报控件（TextEditor/NumberEditor/TextArea/DateEditor/ComboBox/CheckBox/ComboCheckBox/Label）同构仅 class 不同。注意：数据绑定用 set_cell_content_type，本工具只管控件外观/输入类型；若从 text 改为 comboBox 等需额外数据字典的大类，请用 add_cell(widget) 重建或 validate_cpt 复查。',
  {
    path: pathSchema,
    column: nonNegIntParam,
    row: nonNegIntParam,
    type: z.enum(['text', 'number', 'textarea', 'date', 'comboBox', 'checkBox', 'comboCheckBox', 'label', 'submit', 'appendRow', 'custom', 'none']).describe('目标控件类型；number=数字（解 id 类型不匹配）；none=删除控件'),
    widgetClass: z.string().optional().describe('custom 模式的完整 class，如 com.fr.plugin.excel.ui.ExcelImportButton'),
    text: z.string().optional().describe('同时写入控件显示文本（widgetValue）——Label 控件默认值为空时不显示字体，换 label 时务必传'),
    sheet: sheetSchema.optional().describe(SHEET_DESC),
    disabled: boolish.optional().describe('控件禁用态：true=禁用（表头禁用态输入框，<WidgetAttr disabled="true"> 设计器实证形态）/ false=解除（不传=不动）'),
  },
  async ({ path: p, column, row, type, widgetClass, text, sheet, disabled }) => ok(setCellWidget(p, { column, row, type, widgetClass, text, sheet, disabled })));

tool('set_cell_span', '【已并入 update_cell({colspan,rowspan})，本工具默认隐藏，只保留给 cell_primitive 批量失败降级通道】就地改已有单元格的跨行跨列（cs/rs，合并/拆分）：内容/控件/绑定/监听/条件属性/扩展父格全保留。覆盖到已有格时拒绝并列出坐标；多表必传 sheet；值一致返回 mode=none。',
  {
    path: pathSchema,
    column: nonNegIntParam.describe('单元格列号（0 起）'),
    row: nonNegIntParam.describe('单元格行号（0 起）'),
    sheet: sheetSchema.optional().describe('工作表（0 起索引/名称；多表模板必填，防改错表）'),
    colspan: z.coerce.number().int().min(1).max(1000).nullable().optional().describe('跨列数（1 或 null = 取消跨列；不传=不动）'),
    rowspan: z.coerce.number().int().min(1).max(1000).nullable().optional().describe('跨行数（1 或 null = 取消跨行；不传=不动）'),
  },
  async ({ path: p, column, row, sheet, colspan, rowspan }) => ok(setCellSpan(p, { column, row, sheet, colspan, rowspan })), LIGHT_OPTS.set_cell_span);

tool('set_widget_value', '【S6 边界·M69】修改已有单元格控件的显示文本（<Widget><widgetValue><O>）。典型场景：Label 标签控件默认值为空 → 页面上字体不显示，用本工具补文本即可。TextEditor/ComboBox 等控件的当前值也可用它设置。与 update_cell 的区别：update_cell 改单元格内容 <O>，本工具改控件内部值 widgetValue。',
  {
    path: pathSchema,
    column: nonNegIntParam,
    row: nonNegIntParam,
    text: z.string().min(1).describe('控件显示文本（覆盖写入）'),
    sheet: sheetSchema.optional().describe(SHEET_DESC),
  },
  async ({ path: p, column, row, text, sheet }) => ok(setWidgetValue(p, { column, row, text, sheet })));

tool('clear_widget_value', '【S6 边界·M115】删除单元格控件的 <widgetValue> 默认值槽整块——专治「控件默认值槽塞了数据集对象」：<Widget><widgetValue><O t="DSColumn">…</O></widgetValue>（官方 1550 份样本 0 例，quality_gate_cpt 报 error）。数据绑定本就在**单元格级** <O t="DSColumn">（与 <Widget> 平级、<PrivilegeControl/> 之前），删掉值槽**不影响取数**，多数控件本就没有 <widgetValue>。只删这一个子节点，Listener/Tooltip/扩展父格/样式/绑定全部原样保留。与邻近工具的分工：set_cell_widget(type:"none") 删整个 <Widget>（含监听，太重）；set_cell_content_type 改绑定类型（碰脏值槽会要求先 delete_cell）；本工具最外科。幂等：本就没有值槽时返回 mode=none 不写文件。改后建议 validate_cpt + quality_gate_cpt 复核。',
  {
    path: pathSchema,
    column: nonNegIntParam.describe('单元格列号（0 起）'),
    row: nonNegIntParam.describe('单元格行号（0 起）'),
    sheet: sheetSchema.optional().describe(SHEET_DESC),
    expectObject: boolish.default(false).describe('true=仅当值槽里确实是内容对象（<O t="...">）才删，否则跳过（批量清理防呆，避免误删正常默认值）'),
  },
  async ({ path: p, column, row, sheet, expectObject }) => ok(clearWidgetValue(p, { column, row, sheet, expectObject })));

tool('update_cell_dictionary', '【S6 边界·M91/M108/M109/M117】修改已有单元格的【下拉数据字典】，只动 <Dictionary> 块，其余字节（控件/内容绑定/样式/扩展）原样保留。用法：① TableDataDictionary 逐字段改 → kiName（实际值列）/viName（显示值列）/table（取数表名），FormulaDictAttr 缺失时同时传 kiName+viName 可补回（repair）；② CustomDictionary 改固定项 → items:[{key,value}] 整表替换（空数组=清空）；③ FormulaDictionary 改公式 → formula（值公式）/eFormula（显示公式，传空串=清空该块）；④ **整块换类型** → dictionary:{type:"table", dsName, kiName?, viName?} 把下拉**就地改成绑数据集**（官方单元格侧 TableDataDictionary 85 例）、{type:"db", table, ki, vi, connection, schema?, kiName?, viName?} 改成数据库表字典（官方 259 例）、{type:"custom", items:[...]}、{type:"formula", formula, eFormula?} 改成公式数据字典（官方 12 例）。典型场景：数据字典原本是 29 项固定列表、需要改成"按项目过滤的数据集下拉"，或双通道规格列平齐（sheet1-C5 outer_id→spec_id）。sheet 必填（多表同坐标格禁止缺省）；Dictionary 缺失时拒绝（新建请用 add_cell widget/widgetDictionary）；dictionary 与 kiName/viName/table/items/formula/eFormula 不能同时传。幂等：一致时 mode=none。改后请用 get_cell_dictionary 或 validate_cpt 验收。',
  {
    path: pathSchema,
    column: nonNegIntParam.describe('单元格列号（0 起）'),
    row: nonNegIntParam.describe('单元格行号（0 起）'),
    sheet: sheetSchema.describe('工作表（0 起索引/名称，必填：多表模板同坐标格禁止缺省，防改错通道）'),
    kiName: z.string().min(1).optional().describe('实际值列名（如 spec_id；不传=不动；仅 TableDataDictionary）'),
    viName: z.string().min(1).optional().describe('显示值列名（如 spec_id；不传=不动；仅 TableDataDictionary）'),
    table: z.string().min(1).optional().describe('取数表名（如 ds_goods；不传=不动；仅 TableDataDictionary）'),
    items: z.array(z.object({ key: z.string().min(1), value: z.string().min(1) })).optional().describe('自定义字典项 [{key,value}]，整表替换（仅 CustomDictionary；空数组=清空项）'),
    formula: z.string().min(1).optional().describe('值公式（如 =range(2010,2012)；不传=不动；仅 FormulaDictionary）'),
    eFormula: z.string().optional().describe('显示公式（如 =$$$+\'年\'；不传=不动；传空串=清空 EFormulaDict 块；仅 FormulaDictionary）'),
    dictionary: z.object({
      type: z.enum(['table', 'db', 'custom', 'formula']).describe('目标字典类型：table=数据集字典 / db=数据库表字典 / custom=自定义项 / formula=公式数据字典'),
      dsName: z.string().optional().describe('type=table 的数据集名（须已 add_dataset）'),
      kiName: z.string().optional().describe('type=table 的实际值列名'),
      viName: z.string().optional().describe('type=table 的显示值列名'),
      table: z.string().optional().describe('type=db 的数据库表名'),
      schema: z.string().optional().describe('type=db 的 schema（可空）'),
      ki: z.coerce.number().int().optional().describe('type=db 的实际值列索引（0 起，必填）'),
      vi: z.coerce.number().int().optional().describe('type=db 的显示值列索引（0 起，必填）'),
      connection: z.string().optional().describe('type=db 的数据库连接名'),
      items: z.array(z.object({ key: z.string().min(1), value: z.string().min(1) })).optional().describe('type=custom 的字典项'),
      formula: z.string().optional().describe('type=formula 的值公式'),
      eFormula: z.string().optional().describe('type=formula 的显示公式（可缺省）'),
    }).optional().describe('整块替换字典（M109/M117）：把该格下拉就地改成绑数据集/数据库表/自定义项/公式数据字典，控件与内容绑定原样保留；与 kiName/viName/table/items/formula/eFormula 互斥'),
  },
  async ({ path: p, column, row, sheet, kiName, viName, table, items, formula, eFormula, dictionary }) => ok(updateCellDictionary(p, { column, row, sheet, kiName, viName, table, items, formula, eFormula, dictionary })));

tool('get_cell_dictionary', '【只读·M96/M117】读取已有单元格的【下拉数据字典正文】：kind（table/custom/database/formula/none）、kiName/viName、取数表名、自定义项、公式字典的 formula/eFormula。用于核对下拉显示哪列、选项来自哪张表。sheet 必填；只读。',
  {
    path: pathSchema,
    column: nonNegIntParam.describe('单元格列号（0 起）'),
    row: nonNegIntParam.describe('单元格行号（0 起）'),
    sheet: sheetSchema.describe('工作表（0 起索引/名称，必填）'),
  },
  async ({ path: p, column, row, sheet }) => ok(getCellDictionary(p, { column, row, sheet })));

tool('get_cell_style', '【只读】查看单元格当前样式：背景色/字体/字号(pt)/加粗/文字色，及该样式被多少单元格共享。已并入 get_cells({includeStyle:true})；本独立工具仅用于 cell_detail 门禁族（精确单格 target）通道，默认隐藏。',
  { path: pathSchema, column: intParam, row: intParam, sheet: sheetSchema.optional().describe(SHEET_DESC) },
  async ({ path: p, column, row, sheet }) => ok(getCellStyle(p, column, row, sheet)));

tool('update_cell_style', '改单元格【样式】且默认只影响目标格：先克隆其 FR Style 再重新绑定，避免共享样式连带改到同风格的其他格。仅批量改共享样式时传 scope="shared"。改内容/JS 请用 update_cell；完整取值见 capabilities。',
  {
    path: pathSchema,
    column: intParam,
    row: intParam,
    backgroundColor: z.string().optional().describe('背景色，HEX #RRGGBB，如 #FF9900'),
    fontName: z.string().optional().describe('字体名，如 微软雅黑'),
    fontSizePt: z.coerce.number().optional().describe('字号（pt，6-200）'),
    bold: boolish.optional().describe('是否加粗'),
    italic: boolish.optional().describe('是否斜体'),
    underline: boolish.optional().describe('是否下划线'),
    strikethrough: boolish.optional().describe('是否删除线'),
    foregroundColor: z.string().optional().describe('文字颜色，HEX #RRGGBB'),
    horizontalAlignment: z.coerce.number().int().optional().describe('水平对齐（官方 Style.horizontal_alignment）：0=居中、2=左、4=右、6=两端'),
    verticalAlignment: z.coerce.number().int().optional().describe('垂直对齐（官方样本仅出现 0/1/3）：0=居中（默认值）、1=靠上、3=靠下'),
    border: z.object({
      top: z.object({ style: z.coerce.number().int().min(0), color: z.string().optional() }).optional(),
      bottom: z.object({ style: z.coerce.number().int().min(0), color: z.string().optional() }).optional(),
      left: z.object({ style: z.coerce.number().int().min(0), color: z.string().optional() }).optional(),
      right: z.object({ style: z.coerce.number().int().min(0), color: z.string().optional() }).optional(),
      outerTop: z.object({ style: z.coerce.number().int().min(0), color: z.string().optional() }).optional(),
      innerHorizontal: z.object({ style: z.coerce.number().int().min(0), color: z.string().optional() }).optional(),
    }).optional().describe('边框：{top,bottom,left,right,outerTop?,innerHorizontal?} 每边 {style 线型(1细实线/2/3/5/14…)，color?}'),
    textStyle: z.coerce.number().int().min(0).max(2).optional().describe('文本控制（1/2；对照设计器）'),
    paddingLeft: z.coerce.number().int().min(0).optional().describe('左缩进(px)'),
    paddingRight: z.coerce.number().int().min(0).optional().describe('右缩进(px)'),
    lineSpacing: z.coerce.number().min(0).optional().describe('行间距'),
    rotation: z.coerce.number().optional().describe('文本方向角度（-90=竖排等）'),
    scope: z.enum(['cell', 'shared']).default('cell').describe('cell=克隆后只改目标单元格（默认）；shared=原地修改共享样式，可能影响多个单元格'),
    sheet: sheetSchema.optional().describe(SHEET_DESC),
  },
  async ({ path: p, column, row, backgroundColor, fontName, fontSizePt, bold, italic, underline, strikethrough, foregroundColor, horizontalAlignment, verticalAlignment, border, textStyle, paddingLeft, paddingRight, lineSpacing, rotation, scope, sheet }) =>
    ok(updateCellStyle(p, column, row, { backgroundColor, fontName, fontSizePt, bold, italic, underline, strikethrough, foregroundColor, horizontalAlignment, verticalAlignment, border, textStyle, paddingLeft, paddingRight, lineSpacing, rotation, scope }, sheet)), LIGHT_OPTS.update_cell_style);

tool('update_fill_binding', '修改填报字段绑定：字段名/单元格坐标/常量值/主键标记（多 sheet 口径同 add_fill_binding：不传 sheet=全文档连续编号，传 sheet=表内相对索引；多 sheet 多提交必须传 sheet）。constant 把绑定从"取某单元格"改为"写固定值"（<ColumnRow> → <O>值</O>，与 column/row 互斥）——用于根治"字段依赖单元格、被其他字段污染"（如 is_delete 不再依赖 c24 单元格，改常量 0）。',
  {
    path: pathSchema,
    submitIndex: z.coerce.number().int().min(0).default(0).describe('提交序号（0起；不传sheet=全文档编号，传sheet=表内索引）'),
    field: z.string().min(1).describe('现有字段名'),
    newField: z.string().optional(),
    column: intParam.optional(),
    row: intParam.optional(),
    constant: z.union([z.string(), z.number(), z.boolean()]).optional().describe('常量值（写固定值而非取单元格）；传了即与 column/row 互斥'),
    isKey: boolish.optional().describe('主键标记（去主键改纯 INSERT 传 false）'),
    skipUnmodified: boolish.optional().describe('FR「未修改则跳过」（列级智能提交）：true=该列只写本次修改过的值；false=整行覆盖。sandbox19/v1 的最终阻塞点，现可逐列开关'),
    sheet: sheetSchema.optional().describe('工作表（0起/名称；多提交跨表时必传，此时submitIndex为表内索引）'),
  },
  async ({ path: p, submitIndex, field, newField, column, row, constant, isKey, sheet, skipUnmodified }) =>
    ok(updateFillBinding(p, submitIndex, field, { newField, column, row, constant, isKey, skipUnmodified }, sheet)));

tool('update_embedded_submit', '【S6 边界·M124】修改单元格内嵌提交（FreeButton 的 Commit2DBJavaScript 里 <Attributes name="提交N"> + <DMLConfig>，不在 ReportWriteAttr 下，所以 update_fill_binding 改不到它）。mode=patch：改单字段的列坐标/行/主键/常量/skipUnmodified（用 field + column/row/isKey/constant/skipUnmodified）；mode=replace：用 columns 完整替换该提交的字段清单（用于删冗余列，保留 <Table> 与 <Condition>，其余字节逐字节不动；columns[].skipUnmodified 可逐列设置）。定位：submit（提交名，如 "提交3"）必传，同名多处时再传 cell（"AF2" 或 {column:31,row:1}）。注：update_cell_listener 会拒绝整块覆盖这类块（会丢提交配置）。',
  {
    path: pathSchema,
    submit: z.string().min(1).describe('内嵌提交名（<Attributes name>，如 "提交3"；先用 get_embedded_submits 查）'),
    cell: z.union([z.string(), z.object({ column: intParam, row: intParam })]).optional()
      .describe('单元格：优先 "AF2"，也收 {column,row}（均从 0 起）或 "31,1"；同名提交多处时必传'),
    sheet: sheetSchema.optional().describe('工作表（0起/名称）'),
    mode: z.enum(['patch', 'replace']).default('patch').describe('patch=改单字段；replace=整列清单替换'),
    field: z.string().optional().describe('patch 模式：要改的字段名'),
    column: intParam.optional().describe('patch 模式：新的列号（0 起；c29=AD 列）'),
    row: intParam.optional().describe('patch 模式：新的行号（0 起，通常 1）'),
    isKey: boolish.optional().describe('patch 模式：主键标记'),
    skipUnmodified: boolish.optional().describe('patch 模式：FR「未修改则跳过」（列级智能提交）开关'),
    constant: z.union([z.string(), z.number(), z.boolean()]).optional().describe('patch 模式：改成常量值（与 column/row 互斥）'),
    columns: z.array(z.object({
      name: z.string().min(1),
      column: intParam.optional(),
      row: intParam.optional(),
      isKey: boolish.optional(),
      skipUnmodified: boolish.optional().describe('replace 模式：该列「未修改则跳过」'),
      constant: z.union([z.string(), z.number(), z.boolean()]).optional(),
    })).optional().describe('replace 模式：该提交落盘后的完整字段清单（如只留 sku_code+is_delete）'),
  },
  async ({ path: p, cell, submit, sheet, mode, field, column, row, isKey, constant, columns, skipUnmodified }) =>
    ok(updateEmbeddedSubmit(p, { cell, submit, sheet, mode, field, column, row, isKey, constant, columns, skipUnmodified })));

// ---------------- 删 ----------------

tool('delete_parameter', '删除参数（P1-1 双层通道）：scope=auto 跨层唯一时自动定位、两层同名时必须明确 scope，只删命中层。', {
  path: pathSchema, name: z.string().min(1),
  scope: z.enum(['auto', 'dataset', 'report']).default('auto').describe('作用域：auto=自动定位（默认）/ dataset=数据集层 / report=报表级'),
  dsName: z.string().optional().describe('数据集层时指定目标数据集'),
},
  async ({ path: p, name, scope, dsName }) => ok(deleteParameter(p, name, scope, dsName)));

tool('delete_cell', '删除单元格（按坐标）。', { path: pathSchema, column: intParam, row: intParam, sheet: sheetSchema.optional().describe(SHEET_DESC) },
  async ({ path: p, column, row, sheet }) => ok(deleteCell(p, column, row, sheet)));

tool('delete_cell_range', '批量删除一整段列区间的所有单元格（含所有行），删除后右侧剩余列整体左移补位（Excel「删除整列」语义），并同步改写填报绑定 ColumnRow 坐标。专治「重建单元格列位错位」：比如 c7 已是 combination，重建 c8 又写了一份 combination，需把 c8 整列删掉——一次调用完成，不再逐格 delete+add 烧 token。参数 shiftLeft=true（默认）删除后右列整体左移；false 则只删不挪。全宽标题合并行（cs 覆盖整表）自动缩窄；合并区锚点在待删带内部时报错。',
  { path: pathSchema, fromColumn: z.coerce.number().int().min(0).describe('起始列（0 起，如 8）'), toColumn: z.coerce.number().int().min(0).describe('结束列（0 起，>= fromColumn）'), shiftLeft: boolish.default(true).describe('删除后右列整体左移补位，默认 true'), sheet: sheetSchema.optional() },
  async ({ path: p, fromColumn, toColumn, shiftLeft, sheet }) => ok(deleteCellRange(p, { sheet, fromColumn, toColumn, shiftLeft })));

tool('delete_row_range', '【S6 边界·M112】批外删除一整段行区间的所有单元格（含所有列），删除后下方剩余行整体上移补位（Excel「删除整行」语义），并同步改写：<C r> 坐标、rs 跨行合并、填报绑定 ColumnRow 的 row、扩展父格 up/left 引用的行号、以及 <RowHeight> 数组。与 delete_cell_range（列版）对称——此前行轴完全没有通道（删一行只能对该行每个列逐个 delete_cell，行上移更是做不到）。参数 shiftUp=true（默认）删除后下方行整体上移；false 则只删不挪。安全边界（宁可报错不猜）：跨行合并锚点在待删带内或只部分覆盖时拒绝（锚点在带上方且完整覆盖 → 自动缩窄 rs）；扩展父格引用/填报绑定指向带内单元格时拒绝（拒绝留悬空引用，请先改引用再删行）。',
  { path: pathSchema, fromRow: z.coerce.number().int().min(0).describe('起始行（0 起，如 3）'), toRow: z.coerce.number().int().min(0).describe('结束行（0 起，>= fromRow）'), shiftUp: boolish.default(true).describe('删除后下方行整体上移补位，默认 true'), sheet: sheetSchema.optional() },
  async ({ path: p, fromRow, toRow, shiftUp, sheet }) => ok(deleteRowRange(p, { sheet, fromRow, toRow, shiftUp })));

tool('shift_cell_range', '把一列区间的所有单元格整体左移/右移 delta 列（不删除），并同步改写填报绑定 ColumnRow 与扩展父格引用（left/up）的列坐标。两种语义：默认平移（目的列须为空，被占用时报错）；insert=true 插入式挪移（Excel「插入剪切的单元格」语义）——目的列被占用时把「源与目的之间的让位列」（|delta| 列）整段轮转补到腾出的源侧，数据零丢失、不产生空洞、不级联表尾，一次调用替代「腾暂存列 → 搬块 → 回填」三步，不再需要预留暂存区。专治「整段列位错位」：如重建后 c9-c25 整体后移一位，先 delete_cell_range 删掉重复列，再本工具把 c9..c25 整体 delta=-1 归位到 c8..c24——一次调用替代约 40 次逐格 delete+add。安全边界：参与移动的跨列合并区须完整落在块/让位列内（跨轮转边界会拆开合并区）→ 报错；目的位与未移动单元格（含 cs/rs 覆盖面积）重叠 → 报错（insert 时报错会指路调整 fromRow/toRow）。',
  { path: pathSchema, fromColumn: z.coerce.number().int().min(0).describe('起始列（0 起，如 9）'), toColumn: z.coerce.number().int().min(0).describe('结束列（0 起，如 25）'), delta: z.coerce.number().int().describe('位移列数（负=左移，正=右移，如 -1）'), insert: boolish.default(false).describe('true=插入式挪移（目的列可被占用，让位列自动轮转换位，无需暂存列）；默认 false=平移（目的列须为空）'), fromRow: z.coerce.number().int().optional().describe('只移动 fromRow..toRow 行内的单元格（缺省所有行）'), toRow: z.coerce.number().int().optional(), sheet: sheetSchema.optional() },
  async ({ path: p, fromColumn, toColumn, delta, insert, fromRow, toRow, sheet }) => ok(shiftCellRange(p, { sheet, fromColumn, toColumn, delta, fromRow, toRow, insert })));

tool('delete_fill_binding', '删除填报字段绑定（多 sheet 口径同 add_fill_binding：不传 sheet=全文档连续编号，传 sheet=表内相对索引；多 sheet 多提交必须传 sheet）。',
  { path: pathSchema, submitIndex: z.coerce.number().int().min(0).default(0).describe('提交序号（0起；不传sheet=全文档编号，传sheet=表内索引）'), field: z.string().min(1), sheet: sheetSchema.optional().describe('工作表（0起/名称；多提交跨表时必传，此时submitIndex为表内索引）') },
  async ({ path: p, submitIndex, field, sheet }) => ok(deleteFillBinding(p, submitIndex, field, sheet)));

tool('delete_fill_submit', '删除指定 submitIndex 的 SubmitVisitor 整块（开闭对）。多 sheet 口径同 add_fill_binding（不传 sheet=全局编号，传 sheet=表内相对索引）。常用于更换/重置填报提交。',
  { path: pathSchema, submitIndex: z.coerce.number().int().min(0).default(0).describe('提交序号（0起；不传sheet=全文档编号，传sheet=表内索引）'), sheet: sheetSchema.optional().describe('工作表（0起/名称；多提交跨表时必传，此时submitIndex为表内索引）') },
  async ({ path: p, submitIndex, sheet }) => ok(deleteFillSubmit(p, submitIndex, sheet)));

// M51 ① delete_dataset：删除数据集（TableData 块）
tool('delete_dataset', '删除指定数据集（TableData 块）。解决"数据集只能加不能删"的缺口：换数据源/清理废弃数据集时无需重建 .cpt。',
  { path: pathSchema, name: z.string().min(1).describe('数据集名（与 add_dataset 的 name 一致）') },
  async ({ path: p, name }) => ok(deleteDataset(p, name)));

// M51 ② delete_chart：删除图表单元格
tool('delete_chart', '删除指定坐标的图表单元格（Chart 是 <O t="CC"> 的单元格）。坐标非图表时抛错提示用 delete_cell。',
  { path: pathSchema, column: nonNegIntParam, row: nonNegIntParam, sheet: sheetSchema.optional().describe(SHEET_DESC) },
  async ({ path: p, column, row, sheet }) => ok(deleteChart(p, column, row, sheet)));

// M51 ③ get_cell_hyperlink：读取单元格超链接
tool('get_cell_hyperlink', '【只读】读取指定单元格的全部超级链接（NameJavaScriptGroup 内容）：name / 类型（reportlet/url/script）/ 目标 / 参数。不修改文件。',
  { path: pathSchema, column: nonNegIntParam, row: nonNegIntParam, sheet: sheetSchema.optional().describe(SHEET_DESC) },
  async ({ path: p, column, row, sheet }) => ok(getCellHyperlink(p, column, row, sheet)));

// M51 ④ delete_float_element：删除浮动元素
tool('delete_float_element', '删除指定名称的浮动元素（FloatElement 块，FloatElementName 匹配）。',
  { path: pathSchema, name: z.string().min(1).describe('浮动元素名（如 Float1 / Float36-Copy）'), sheet: sheetSchema.optional().describe(SHEET_DESC) },
  async ({ path: p, name, sheet }) => ok(deleteFloatElement(p, name, sheet)));

// ---------------- 校验 ----------------

tool('validate_cpt', '全量校验：XML/结构/填报绑定/参数引用/坐标唯一性/JS 基线比对（较基线减少即 error，拦截整块丢失）。JS 块确属有意删减时传 resetJsBaseline:true 复位本模板基线。返回带 fix 的问题清单。brief=true 回摘要（结论+前5条 error）；文件未变时重复调用复用上次结论（cached=true）。',
  {
    path: pathSchema,
    resetJsBaseline: boolish.optional().describe('复位本模板 JS 基线'),
    brief: briefParam,
  },
  async ({ path: p, resetJsBaseline: doReset, brief }) => {
    const useBrief = resolveBrief(brief);
    if (doReset !== true) {
      const hit = cacheLookup('validate_cpt', p, {}, gateFingerprint(p));
      if (hit) return ok(withCacheInfo(useBrief ? briefValidate(hit.result) : hit.result, hit));
    }
    // C-C（2026-11-03）：显式复位本模板 JS 基线 —— 必须在 validateCpt 之前（否则本轮仍按旧基线
    // 报"块数减少"）；只影响本模板条目，失败如实带回 error 而不是假装成功。
    let baselineResetInfo = null;
    if (doReset === true) {
      try { baselineResetInfo = resetJsBaseline(p); } catch (e) { baselineResetInfo = { reset: false, error: e?.message ?? String(e) }; }
    }
    const issues = validateCpt(p);
    const result = {
      path: p, summary: issueSummary(issues), issues,
      ...(baselineResetInfo ? { baselineReset: baselineResetInfo.reset === true, baselineResetInfo } : {}),
    };
    cacheStore('validate_cpt', p, {}, gateFingerprint(p), result);
    return ok(useBrief ? briefValidate(result) : result);
  });

tool('list_cpt_issues', '列出 CPT 校验问题（error/warning/info，含位置与建议）。',
  { path: pathSchema, severity: z.enum(['all', 'error', 'warning', 'info']).default('all') },
  async ({ path: p, severity }) => {
    const issues = validateCpt(p).filter((i) => severity === 'all' || i.severity === severity);
    return ok({ count: issues.length, issues });
  });

tool('diagnose_fill_row_integrity', '【只读·填报行完整性一键盘点】逐 sheet 逐格盘点填报行完整性并产出缺失清单（坐标可直接驱动修复）：① 缺 InsertPolicy=copy 的格（插入新行该格不复制上一行值）② 数据行内静态文本格（无 DSColumn 绑定）③ 数据行空格既无控件也无 DSColumn ④ 下拉控件缺数据字典 ⑤ 扩展父格引用悬空。写入口：update_cell(insertPolicy) / batch_mutate_cells(data.patch.insertPolicy)。不改文件。',
  {
    path: pathSchema,
    sheet: sheetSchema.optional().describe('工作表：0 起索引或名称（缺省全部工作表）'),
  },
  async ({ path: p, sheet }) => ok(diagnoseFillRowIntegrity(p, sheet === undefined ? {} : { sheet })));

// ---------------- 微型报表引擎 ----------------

tool('style_review_cpt', '样式审查：基于设计器级样式规范（字号范围/字体存在性/前后景对比度/共享度/越界），返回可治理的样式问题清单。',
  { path: pathSchema },
  async ({ path: p }) => ok({ path: p, ...reviewStyles(p) }));

tool('reasonableness_review_cpt', '合理性审查：网格一致性、控件合法性、参数面板-数据集参数匹配、填报字段规范性、页面设置边界、内容/控件冲突等。',
  { path: pathSchema },
  async ({ path: p }) => ok({ path: p, ...reviewReasonableness(p) }));

tool('build_report', '用结构化 spec 一次成型生成整张报表（数据集/样式/单元格/填报/参数面板），自带三层自检。report 档默认隐藏，需 request_deep_tool_access({path, group:"generator_full"}) 解锁；从零建表优先用静态的 generate_report。spec 字段语义用 get_capabilities({tool:"build_report"}) 分节取。整表重建：不继承原模板节点，工具栏需显式传 spec.toolbar（2026-10-20 修复：toolbar 非空时会自动 webWrite=true，避免骨架缺 WebWriteContent 导致工具栏写不进去）。',
  { path: pathSchema, spec: buildReportSpecSchema, noOverwrite: boolish.default(true).describe('默认 true：目标已存在则拒绝覆盖（防误覆盖）；确需覆盖显式传 false'),
    meta: boolish.default(false).describe('生成参数留档：发布成功后把 spec 写到 <模板>.meta.json（复现/审计用），默认关闭') },
  async ({ path: p, spec, noOverwrite, meta }) => ok(buildReport({
    path: p,
    ...spec,
    // 兼容两种调用口径：推荐把 noOverwrite 放在工具顶层；旧 spec 里的同名字段仍有效。
    // 2026-11-06 P0：默认 true（拒绝覆盖）——只有顶层显式 false 才放行覆盖，spec 内旧字段可强制 true。
    noOverwrite: noOverwrite === false ? false : (spec.noOverwrite ?? true),
    meta: meta ? { tool: 'build_report', spec } : null,
  })), LIGHT_OPTS.build_report);

// ---------------- 智能报表生成（字段 + 数据源 → 完整报表） ----------------

/** generate_report 的字段定义 schema */
// 汇总函数名白名单。模型常写成 summary: true —— 与其报错逼它猜，不如归一化成 sum。
const SUMMARY_FUNCS = ['sum', 'count', 'avg', 'max', 'min'];

const smartFieldSchema = z.object({
  name: z.string().min(1).describe('数据库字段名（必须能在 SQL 结果集中找到）'),
  label: z.string().optional().describe('表头显示名（缺省用 name）'),
  type: z.enum(['text', 'number', 'money', 'percent', 'date', 'datetime']).optional()
    .describe('显示类型，决定数字格式（对齐默认全部居中）：text=文本 / number=整数(#,##0) / money=金额(#,##0.00) / percent=百分比(0.00%) / date=日期(yyyy-MM-dd) / datetime=日期时间(yyyy-MM-dd HH:mm:ss)；如需按类型区分对齐用 align 覆盖'),
  widthMm: z.coerce.number().optional().describe('列宽（mm）。缺省按类型给：text 32 / number 20 / money 24 / percent 18 / date 28 / datetime 40'),
  result: z.string().optional().describe('显示值变换公式（官方 <Result>，可选）。$$$ 代表该字段原始值，例："$$$/10000"（元转万元）、"ROUND($$$,0)"（取整）、"ROUND($$$/10000,2)"（万元保留两位）、"货主城市+$$$"（拼接别的字段）。只改显示、不改汇总口径'),
  align: z.coerce.number().int().optional().describe('覆盖默认对齐：0=居中 / 2=左对齐 / 4=右对齐 / 6=两端对齐（只能用这几个值）'),
  sort: z.enum(['asc', 'desc']).optional()
    .describe('单列排序快捷写法：asc=升序 / desc=降序。例：给"销售额"字段写 sort:"desc" = 按销售额降序。'
      + '需要多键排序（如先按地区升序再按销售额降序）请改用顶层的 sort 数组；两者同时给会被拒绝'),
  highlights: z.array(highlightSchema).optional()
    .describe('该字段的额外条件属性（叠加在默认的斑马纹/负数标红之上）。可用公式 formula、比较 compare、值替换 value、加粗 bold 等'),
  summary: z.union([z.boolean(), z.string()]).optional()
    .describe('汇总方式：true 或 "sum" 都表示合计；也支持 count / avg / max / min。给了会在报表底部生成"合计"汇总行')
    .transform((v) => {
      if (v === true) return 'sum';
      if (v === false || v === undefined) return undefined;
      const s = String(v).trim().toLowerCase();
      if (!SUMMARY_FUNCS.includes(s)) {
        throw new Error(`fields[].summary 非法 ("${v}")：只能用 ${SUMMARY_FUNCS.join(' / ')}，或写 true 表示 sum`);
      }
      return s;
    }),
}).strict();

tool('generate_report', '⭐ 智能报表生成（只知道字段和数据来源时的首选）：给「字段列表 + 数据源」，引擎自动完成 SQL、布局、样式配色、数字格式、列宽行高、填报工具栏与展开父格。数据源二选一：source.connection+table/sql 或 source.excelFile。'
  + '数据源两种口径二选一：库里取数 → source.connection + source.table(或 sql)；数据不在库里、手上只有一张 Excel → source.excelFile（字段名写 Excel 列名即可，不用连数据库）。',
  {
    path: pathSchema,
    noOverwrite: boolish.default(true).describe('默认 true=已存在则拒绝覆盖；false 才覆盖'),
    title: z.string().optional().describe('报表大标题（写在首行，跨所有列合并居中加粗）。不给则无标题行'),
    source: z.object({
      connection: z.string().min(1).describe('数据连接名，如 Doris / MySQL（对应设计器里已配好的数据连接）。用 excelFile 时不需要').optional(),
      table: z.string().optional().describe('表名。不给 sql 时必填，引擎自动生成 `select 字段列表 from 表`'),
      sql: z.string().optional().describe('自定义 SQL（给了则优先于 table）。支持 ${参数名} 引用数据集参数'),
      excelFile: z.string().optional().describe('Excel 文件路径（.xls/.xlsx）——数据不在库里、手上只有一张表时用这个，此时不需要 connection / table / sql，字段名就是 Excel 列名。fromEnv=true（默认）时相对 %FR_HOME%/webapps/webroot'),
      needColumnName: boolish.optional().describe('配合 excelFile：Excel 首行是否为列名（默认 true）'),
      fromEnv: boolish.optional().describe('配合 excelFile：true=路径相对 FR 环境根目录（默认）；false=绝对路径'),
      parameters: z.array(z.object({
        name: z.string().min(1),
        defaultValue: z.string().optional(),
      }).strict()).optional().describe('数据集参数 [{name, defaultValue?}]，配合 SQL 里的 ${参数名}'),
    }).strict(),
    fields: z.array(smartFieldSchema).min(1).describe('字段列表（按顺序从左到右排列）。每项至少给 name'),
    dsName: z.string().default('ds1').describe('数据集名（默认 ds1）'),
    theme: z.enum(['blue', 'green', 'gray', 'dark', 'orange']).default('blue').describe('配色主题（表头底色+白字）：blue / green / gray / dark / orange'),
    fill: z.object({
      table: z.string().min(1).describe('填报提交的目标表'),
      dsName: z.string().optional().describe('填报数据连接名（缺省用 source.connection）'),
      fields: z.array(z.object({
        field: z.string().min(1).describe('数据库字段名'),
        column: nonNegIntParam.optional().describe('绑定单元格列号（0 起，缺省按 fields 顺序）'),
        row: nonNegIntParam.optional().describe('绑定单元格行号（0 起，缺省 2=数据行）'),
        isKey: boolish.optional().describe('是否主键'),
      }).strict()).optional().describe('提交字段绑定（缺省把 fields 全部绑定到数据行）'),
    }).strict().optional().describe('需要生成填报提交（填报表）时给这项；只做查询报表则不传'),
    options: z.object({
      titleFontSizePt: z.coerce.number().optional().describe('标题字号 pt（默认 18）'),
      headerFontSizePt: z.coerce.number().optional().describe('表头字号 pt（默认 14）'),
      dataFontSizePt: z.coerce.number().optional().describe('数据字号 pt（默认 14）'),
      paper: z.enum(['A4', 'A3', 'A5', 'B4', 'B5']).optional().describe('纸张（默认 A4）'),
      orientation: z.coerce.number().int().min(0).max(1).optional().describe('0=纵向 / 1=横向（默认 0）'),
      fontName: z.string().optional().describe('字体名（默认 微软雅黑）'),
      density: z.enum(['compact', 'standard', 'roomy']).optional()
        .describe('版式密度（字号/行高/列宽整表联动）：compact=紧凑（信息密度高的运营表）/ standard=标准（默认）/ roomy=宽疏（汇报演示用）'),
      zebra: boolish.optional().describe('数据行斑马纹（隔行浅色背景），默认 true；传 false 关闭'),
      zebraColor: z.string().optional().describe('斑马纹背景色 #RRGGBB（默认取主题配套浅色）'),
      negativeRed: boolish.optional().describe('数值列负数标红，默认 true；传 false 关闭'),
      negativeColor: z.string().optional().describe('负数字色 #RRGGBB（默认 #C00000）'),
      sort: z.array(z.object({
        field: z.string().min(1).describe('排序字段名，必须是 fields 中已有字段'),
        direction: z.enum(['asc', 'desc']).describe('asc=升序 / desc=降序'),
      }).strict()).optional().describe('多键排序；数组顺序即优先级。与字段上的 sort 二选一'),
      header: z.union([hfSectionSchema, z.literal(false)]).optional()
        .describe('页眉 {left?,center?,right?}。默认用 title 填左区；传 false 关闭'),
      footer: z.union([hfSectionSchema, z.literal(false)]).optional()
        .describe('页脚 {left?,center?,right?}。默认中区为页码 {preset:"pageNumber"}；传 false 关闭'),
      hfFontSizePt: z.coerce.number().min(1).max(72).optional().describe('页眉页脚字号 pt（默认 9）'),
      templateTheme: z.union([
        z.enum(['兼容主题', '经典浅灰', '兼容', '清爽科技', '经典深灰']),
        z.literal(false),
      ]).optional().describe('模板整体主题（配色/图表调色板），默认 经典浅灰；传 false 则不写主题标记'),
      toolbar: z.union([
        z.array(z.enum(['submit', 'verify', 'append-row', 'delete-row', 'import-append', 'import-clean'])),
        z.literal(false),
      ]).optional().describe('填报工具栏：有 fill 时默认提交/校验/增行/删行四按钮；传数组自定义，传 false 关闭'),
      meta: boolish.optional().describe('生成参数留档：发布成功后把生成参数写到 <模板>.meta.json（复现/审计用），默认关闭'),
    }).strict().optional().describe('可选覆盖项'),
    chart: z.union([
      z.literal(true).describe('true = 按字段自动推导：X 轴取第一个文本/日期字段，数值列取所有 number/money/percent 字段（最多 3 个，默认 sum 求和），柱形图，放在明细表下方'),
      z.object({
        type: z.enum(['column', 'line', 'pie']).default('column')
          .describe('column 柱形（默认，比大小）/ line 折线（看趋势）/ pie 饼图（看占比，只支持一个数值列）'),
        category: z.string().optional().describe('X 轴分类字段名（不给则自动取第一个文本/日期字段）'),
        values: z.array(z.union([
          z.string().min(1),
          z.object({
            name: z.string().min(1),
            agg: z.enum(['sum', 'avg', 'count', 'max', 'min', 'none']).default('sum'),
            label: z.string().optional(),
          }).strict(),
        ])).optional().describe('数值列（不给则自动取所有数值字段，最多 3 个）'),
        title: z.string().optional().describe('图表标题（默认「<报表标题>（图表）」）'),
        colspan: z.coerce.number().int().min(1).max(1000).optional().describe('横向占几列（默认跨所有列）'),
        rowspan: z.coerce.number().int().min(1).max(1000).optional().describe('纵向占几行（默认 12 行 ≈ 84mm 高）'),
      }).strict(),
      z.literal(false),
    ]).optional().describe('追加一张图表。传 true 全自动推导；或给 {type,category,values} 精细控制；传 false / 不传则不生成图表。图表的骨架、配色、图例、坐标轴由引擎按官方样本填充，不用自己拼 XML'),
  },
  async ({ path: p, title, source, fields, dsName, theme, fill, chart, options, noOverwrite }) =>
    ok(generateReport({ path: p, title, source, fields, dsName, theme, fill, chart, options: options || {}, noOverwrite })), LIGHT_OPTS.generate_report);
tool('regenerate_from_meta', '从 .cpt.meta.json 生成参数留档一键复现模板（留档由 build_report/generate_report 的 meta=true 产生）。build_report 形态完整回放（byte 级一致）；generate_report 形态回放核心参数。语义=按留档回写同名模板：**默认覆盖**（原子替换并留 .bak-build-*）；显式 noOverwrite:true 则目标存在即拒绝。',
  { path: pathSchema, noOverwrite: boolish.default(false).describe('默认 false：按留档回写已存在目标（留 .bak-build-*）；传 true 则目标存在即拒绝') },
  async ({ path: p, noOverwrite }) => {
    const { regenerateFromMeta } = await import('./lib/regenerate.js');
    return ok(regenerateFromMeta(p, { noOverwrite }));
  });

// ---------------- 定时任务（auto-runner 模式：持久化到 .cpt 同目录的 .cpt-schedule.json） ----------------
// 模仿 agent-team/core/mcp/server.py 的 auto-runner：暴露 schedule/scheduler 工具集，
// 进程内 node-cron 调度；配置与执行历史持久化在 .cpt-schedule.json（带 .lock 跨进程互斥）。
// 启动时自动从 .cpt-schedule.json 加载全部任务并订阅。

tool('schedule_add', '为指定 .cpt 添加一个定时任务。cron 为 5 字段标准表达式（分 时 日 月 周），action 为 scheduler_actions 列举的动作之一。配置持久化到 .cpt 同目录的 .cpt-schedule.json；本进程立即订阅该任务。',
  {
    path: pathSchema,
    cron: z.string().min(9).describe('cron 表达式（5 字段：分 时 日 月 周），如 "0 3 * * *" / "*/30 * * * *" / "0 0 * * 0"'),
    action: z.string().min(1).describe('动作名（先用 scheduler_actions 看可用动作），如 validate / style_review / reasonableness_review / decompile'),
    actionArgs: z.record(z.any()).optional().describe('动作参数（按动作的 argsSchema，缺省 {}）'),
    note: z.string().optional().describe('备注，仅写入 store，便于自己看'),
  },
  async ({ path: p, cron: cronExpr, action, actionArgs, note }) => {
    const r = await addTask(p, { cron: cronExpr, action, actionArgs, note });
    return ok({ added: r.id, action, cron: cronExpr, nextRun: r.task.nextRun, storePath: r.storePath });
  });

tool('schedule_list', '列出指定 .cpt 的全部定时任务（含 tracked 状态、最近一次执行状态 nextRun/lastRun/历史条数）。',
  { path: pathSchema },
  async ({ path: p }) => ok(await listTasks(p)));

tool('schedule_get', '查单个定时任务详情（含完整 history，与 runState 当前状态）。',
  { path: pathSchema, taskId: z.string().uuid() },
  async ({ path: p, taskId }) => ok(await getTask(p, taskId)));

tool('schedule_remove', '删除一个定时任务（从 store 与 node-cron 订阅中同时移除）。',
  { path: pathSchema, taskId: z.string().uuid() },
  async ({ path: p, taskId }) => ok(await removeTask(p, taskId)));

tool('schedule_enable', '启用一个被禁用的定时任务。',
  { path: pathSchema, taskId: z.string().uuid() },
  async ({ path: p, taskId }) => ok(await enableTask(p, taskId)));

tool('schedule_disable', '禁用一个定时任务（停止 cron 订阅，但保留 store 记录）。',
  { path: pathSchema, taskId: z.string().uuid() },
  async ({ path: p, taskId }) => ok(await disableTask(p, taskId)));

tool('schedule_run_now', '立即触发一次任务执行（不修改 cron、不等触发窗口）。【同步/异步】waitMs>0（默认 30000）同步等待并返回 runState；waitMs=0 为异步 fire-and-forget（只返回 fired/mode，不含 runState，用 scheduler_history 查结果）。',
  {
    path: pathSchema,
    taskId: z.string().uuid(),
    waitMs: z.coerce.number().int().min(0).max(120000).default(30000).describe('最长等待结果毫秒（0=不等，异步 fire-and-forget）'),
  },
  async ({ path: p, taskId, waitMs }) => {
    if (waitMs === 0) {
      // 异步：不阻塞调用方，立即返回任务被触发
      runTask(p, taskId).catch(() => { /* 错误已写 history */ });
      return ok({ fired: true, taskId, mode: 'fire-and-forget' });
    }
    const sch = getScheduler();
    const start = Date.now();
    const state = await sch.runNow(p, taskId);
    return ok({ taskId, runState: state, waitedMs: Date.now() - start });
  });

// ---------------- 调度器全局 / FR 设计器探测 ----------------

tool('scheduler_status', '调度器全局状态：是否已启动、活跃任务数（PID 列表）、进程 pid、node 版本、运行秒数。',
  {},
  async () => ok(await schedulerStatus()));

tool('scheduler_history', '查某任务的最近执行历史（最多 50 条；limit 截断）。',
  {
    path: pathSchema,
    taskId: z.string().uuid(),
    limit: z.coerce.number().int().min(1).max(50).default(20),
  },
  async ({ path: p, taskId, limit }) => ok(await schedulerHistory(p, taskId, limit)));

tool('scheduler_stop', '停掉本进程内全部订阅的定时任务（保留 .cpt-schedule.json 配置；下次启动仍会重新加载）。',
  {},
  async () => ok(stopScheduler()));

tool('scheduler_actions', '列出调度器支持的全部动作（名称 / 用途 / 参数 schema）。',
  {},
  async () => ok({ actions: listActions() }));

tool('fr_detect', '探测本地 FineReport 设计器与引擎：扫 FR_HOME 环境变量 + 默认安装路径；即使没有 cptdec，也会报告可用于静态逆向的 FR_HOME/jar。',
  {},
  async () => ok(detectFrHome()));

tool('fr_inspect', '合规盘点本机 FineReport：读取引擎/设计器 jar 的版本、关键类名、主题资源、官方样本数量；不反编译方法体、不启动 GUI、不写 FR_HOME。',
  {
    frHome: z.string().regex(/^[A-Za-z]:[\\/]/, 'frHome 必须是 Windows 绝对路径').optional().describe('可选 FR 根目录，缺省自动探测'),
  },
  async ({ frHome }) => {
    // A3 围栏：显式 frHome 必须是已探测的 FR 安装（在 FR_HOME 内）或位于允许目录，
    // 防止对任意目录做无上限树遍历
    if (frHome) assertToolPath('fr_inspect', frHome, { write: false });
    return ok(inspectFrInstallation(frHome));
  });

tool('fr_decompile', '调用本地 FR cptdec 反编译 .cpt 到源码目录；仅当 fr_detect 返回 decompileTool 时可用。没有 cptdec 时请用 fr_inspect 做静态逆向盘点。',
  {
    path: pathSchema,
    outDir: z.string().optional().describe('反编译输出目录（缺省 <cpt_dirname>/.decompiled/<basename>/<ts>/）'),
  },
  async ({ path: p, outDir }) => {
    const { decompileCpt } = await import('./lib/fr-decompile.js');
    return ok(await decompileCpt(p, outDir));
  });

tool('fr_engine_check', '查询「真实 FineReport 引擎」对某个 .cpt 的加载校验结论（地面真值：引擎能加载 = 设计器能打开）。'
  + '结论由 verify:fr（run_fr_engine_check 工具触发，或 npm run verify:fr -- <cpt>）生成，本工具只读报告不跑引擎。'
  + 'status=not-run 时请先用 run_fr_engine_check 触发校验再重查（无 shell 会话也能触发）；status=stale 表示模板在验证后又改过；'
  + 'status=pass 即可放心交付，status=fail 先用 validate_cpt 修复。',
  {
    path: pathSchema,
  },
  async ({ path: p }) => {
    const { engineCheckReport } = await import('./lib/fr-engine-report.js');
    return ok(engineCheckReport(p));
  });

tool('run_fr_engine_check', '触发「真实 FineReport 引擎」对 .cpt 做加载校验（等价于手工执行 npm run verify:fr -- <cpt>）。'
  + '它启动本机 FR 自带 JRE 逐份加载模板：status=pass 表示引擎能加载（设计器能打开），并把结论写入 '
  + '.fr-engine-check/ 报告，随后 fr_engine_check 只读可复查（fresh/stale）。无 shell 的会话也能用本工具触发。\n'
  + '用法：① 单文件 path=<cpt>；② 单文件+导出重读 roundTrip=<参考cpt>；③ 批量 batch=[cpt1, cpt2]（一次 JVM 启动，每份自动加载+导出重读；批量模式 path 可省略，多文件不再需要逐份调用/逐份租约）。\n'
  + '前置：需本机有 FineReport 安装（fr_detect 可查）；fr_engine_check 返回 not-run/stale 时优先用本工具触发，而不是让用户手动跑命令。\n'
  + '安全：仅对指定 .cpt 运行预置的 verify-fr-engine 脚本（数组参数、无 shell、env 白名单、320s 超时），不会执行任意命令。\n'
  + '【只读保证·M119】校验过程对源 .cpt 只读（spawn 前后 sha256 比对 + 探针导出一律走临时文件，导出重读不会覆写任何用户路径）；roundTrip 与 path 同路径会被早期拒绝。',
  {
    path: pathSchema.optional().describe('单文件模式目标 .cpt；批量模式可省略（path 与 batch 至少给一个）'),
    roundTrip: z.string().regex(/\.cpt$/i, 'roundTrip 必须是以 .cpt 结尾的参考模板路径').optional().describe('可选：单文件模式的导出重读参考 .cpt；缺省不做导出重读'),
    batch: z.array(pathSchema).min(1).optional().describe('批量模式：多个 .cpt 一次 JVM 启动逐份校验（自动加载+导出重读）。传了 batch 就走批量，忽略 roundTrip；path 可省略'),
  },
  async ({ path: p, roundTrip, batch }) => {
    if ((p == null || String(p).trim() === '') && !(Array.isArray(batch) && batch.length > 0)) {
      throw new Error('run_fr_engine_check: 需要 path（单文件）或 batch（批量，至少一个 .cpt）');
    }
    const { runFrEngineCheck } = await import('./lib/fr-engine-run.js');
    return ok(await runFrEngineCheck(p, { roundTrip, batch }));
  });

tool('start_fr_preview', '在本机拉起一个**独立**的 FineReport 报表实例（完全复用设计器内核：FR 自带 JRE + fine-*.jar + Tomcat 9 + webapps/webroot 决策系统 + finedb 快照），'
  + '用浏览器打开真实预览页，做**样式复查 / 功能点检**（分页、表头、填报控件、工具栏按钮、afterload JS、导出、提交等）。\n'
  + '与 run_fr_engine_check 的分工：引擎校验回答「设计器能不能打开」（~10s，无渲染）；本工具回答「打开后长什么样、按钮能不能点」（首次 30~60s）。\n'
  + '用法：path=<cpt>；返回 viewUrl（分页预览）/ writeUrl（填报预览，含工具栏）/ adminUrl（平台管理，配置数据连接用）。\n'
  + '【内置参数默认 admin 伪装】FR 的 $fine_username/$fine_userid/$fine_role/$fine_position/$fine_display_name 来自平台登录会话。实例就绪后本工具默认用平台超管 admin 登录本地实例，'
  + '返回的预览/平台 URL 先经本地入口页写入会话 Cookie 再跳转，因此预览里这些内置参数解析为 admin（与生产里超管看到的一致）；impersonation 字段会汇报 status=ok/failed/disabled。'
  + '账号默认 admin，口令读 CPT_MCP_FR_PREVIEW_ADMIN_PASSWORD（本地一次性测试库，缺省见 docs/fr-preview.md）；只对 127.0.0.1 生效，绝不连接远端 FR。\n'
  + '幂等：同一时刻只维护一个实例；重复调用复用活着的实例，只把当前 .cpt 复制进实例 reportlets（刷新页面即最新）。\n'
  + '返回：默认**立即返回** status=starting（含 PID/端口/预览 URL，impersonation=pending）——FR 冷启动 30~60s，请用 fr_preview_status 轮询到 status=running 再打开 URL（避免 MCP 客户端 60s 请求超时）。wait=true 才阻塞等就绪并返回 impersonation=ok。\n'
  + '安全：FR 安装目录只读；conf/logs/temp/webapps/finedb 全部落在 `<repo>/.fr-preview/`；只监听 127.0.0.1 随机空闲端口；不改源 .cpt、不碰用户现有 8080/8075 服务；启动前会清理同一预览目录下的残留 java 进程（避免 finedb 锁竞争）。\n'
  + '数据连接安全：内置预览禁止继承外部生产连接；平台库只允许 jdbc:sqlite/本地 jdbc:hsqldb，发现 jdbc:mysql/doris 等外部 URL 会直接拒绝启动。默认 localTest=true 时，先用 local_db_import({action:"report"}) 由 MCP 只读导入本地 SQLite，start 会自动把同名本地连接写入 finedb（只写 jdbc:sqlite）；缺库/缺表直接拒绝启动；localTest=false 不写数据连接但仍清空外部连接。',
  {
    path: pathSchema,
    port: z.number().int().min(1024).max(65000).optional().describe('可选：指定监听端口（缺省自动挑空闲端口；只监听 127.0.0.1）'),
    wait: boolish.optional().describe('可选：true=阻塞等实例就绪后才返回（可能超过 MCP 客户端 60s 超时，不推荐）；缺省 false 立即返回 starting，用 fr_preview_status 轮询'),
    timeoutSeconds: z.number().int().min(15).max(600).optional().describe('可选：wait=true 时等待就绪的秒数（缺省 150s；FR 平台冷启动通常 30~60s）'),
    impersonate: boolish.optional().describe('可选：缺省 true=用 admin 登录让 $fine_username 等内置参数解析为 admin；false=匿名预览（便于对照/排查）'),
    localTest: boolish.optional().describe('可选：缺省 true=只允许本地 SQLite 测试环境（先 local_db_import action:report；缺库/缺表直接拒绝启动）；false=不写数据连接，但仍会清空 finedb 外部连接'),
  },
  async ({ path: p, port, wait, timeoutSeconds, impersonate, localTest }) => {
    const { startFrPreview } = await import('./lib/fr-preview.js');
    let localConnections = [];
    const auditRuns = [];
    if (localTest !== false) {
      const { localPreviewConnections } = await import('./lib/test-env.js');
      const mapping = localPreviewConnections(p);
      if (!mapping.ok) {
        return ok({
          ok: false,
          status: 'local-test-env-not-ready',
          path: mapping.path,
          missing: mapping.missing,
          nextAction: mapping.nextAction,
          hint: '内置预览只允许本地 SQLite 数据连接；请先按 nextAction 准备本地测试环境，不要继承生产连接。',
        });
      }
      localConnections = mapping.connections;
      // 把 prepare 阶段开启的 active run 直接带回来，调用方不用回翻上一步响应找 runId。
      for (const c of localConnections) {
        try {
          const active = getActiveWriteAuditRun(c.db);
          if (active && !auditRuns.some((r) => r.runId === active.runId)) {
            auditRuns.push({ connection: c.name, db: c.db, runId: active.runId, startedAt: active.startedAt });
          }
        } catch { /* 审计不是启动预览的前置条件 */ }
      }
    }
    const result = await startFrPreview(p, { port, timeoutSeconds, waitForReady: wait === true, impersonate: impersonate !== false, localConnections });
    return ok({
      ...result,
      ...(auditRuns.length
        ? { writeAudit: { runs: auditRuns, nextAction: '提交后调用 local_db_admin({ action:"write_audit", db, runId }) 查看写入行数/次数/时间。' } }
        : {}),
    });
  });

tool('stop_fr_preview', '停止 start_fr_preview 拉起的本地独立 FR 报表实例（Tomcat 优雅 shutdown，25s 未退则强杀；并清理同一预览目录下残留的 java 进程）。'
  + '停机后自动把实例里的平台库回写为 `.fr-preview/finedb-seed/`，管理员账号与数据连接配置会保留到下次启动；同时删除本地 admin 会话入口页。\n'
  + '没在运行时返回 status=not-running（不报错，并顺手清理残留进程）。',
  {},
  async () => {
    const { stopFrPreview } = await import('./lib/fr-preview.js');
    return ok(await stopFrPreview());
  });

tool('fr_preview_status', '查询本地独立 FR 报表实例状态（只读）：是否运行、PID/端口、健康检查码、当前预览模板与预览 URL、内置参数伪装（impersonation）状态、日志尾部。'
  + 'status=running 时会用 admin 登录本地预览实例并返回带会话的预览 URL（$fine_username 等解析为 admin）；start 之后用它确认实例是否还活着；页面打不开时先看这里再决定重启动。',
  {},
  async () => {
    const { frPreviewStatus } = await import('./lib/fr-preview.js');
    return ok(await frPreviewStatus());
  });

// ---------------- 工具 ----------------

  /**
   * 自主核验：把自检结论挂到写工具的返回体上（不改变写操作本身的成功/失败）。
   * 有 blocker 时额外追加一条 text —— 即使调用方只读第一段文本也能看到"这步写完结构坏了"。
   */
  async function attachSelfCheck(result, cptPath, engine) {
  if (!result || !Array.isArray(result.content)) return;
  const ck = await selfCheckSummary(cptPath, { engine: Boolean(engine) });
  const textIdx = result.content.findIndex((c) => c && c.type === 'text');
  if (textIdx < 0) return;
  try {
    const data = JSON.parse(result.content[textIdx].text);
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      data.selfCheck = ck;
      result.content[textIdx].text = JSON.stringify(data, null, 2);
      if (result.structuredContent && typeof result.structuredContent === 'object' && !Array.isArray(result.structuredContent)) {
        result.structuredContent = { ...result.structuredContent, selfCheck: ck };
      }
    }
  } catch {
    // 非 JSON 返回体：只追加文本提示
  }
  if (ck.status === 'fail') {
    const first = (ck.blockers || []).map((b) => `· ${b.location ? b.location + '：' : ''}${b.message}`).slice(0, 3).join('\n');
    result.content.push({
      type: 'text',
      text: `⚠ cpt-mcp 自主核验 ${ck.status === 'fail' ? '未通过' : '有警告'}：` +
        (ck.blockers?.length ? `\n${first}${ck.blockers.length > 3 ? `\n· 另有 ${ck.blockers.length - 3} 项，见 selfCheck` : ''}` : '') +
        `\n建议：${ck.nextAction}`,
    });
  }
  }

function ok(data) {
  // 2026-10-26 P0（PTC / code-mode 友好）：对象型结果同时回 structuredContent。
  //   · MCP 客户端（含 DSH 的 PTC 桥）可直接拿对象，不必再 JSON.parse(content[0].text)；
  //   · text 分支保持原样，纯文本客户端行为不变。
  //   数组型结果不包 structuredContent（协议要求 object；包 {items:[…]} 会改变既有形状）。
  // 2026-11-07 P0：先做出口 JSON 安全化 —— node:sqlite 的 readBigInts:true 让 COUNT(*) 等
  // 聚合是 bigint，直接 JSON.stringify 会抛 "Do not know how to serialize a BigInt"，
  // 整个工具调用失败；structuredContent 也会在协议层序列化时炸。这里统一把 bigint 转
  // number/string、Uint8Array 转 base64，其余结构（Date/类实例/普通对象）原样透传。
  const safe = toJsonSafeDeep(data);
  const content = [{ type: 'text', text: JSON.stringify(safe, null, 2) }];
  // 数组型结果统一包成 { items: [...] }（MCP 要求 structuredContent 是 object），
  // 这样读取类工具（get_datasets/get_cells/get_styles…）在程序里也能直接用结构化内容循环。
  const structured = Array.isArray(safe)
    ? { items: safe }
    : (safe && typeof safe === 'object' ? safe : null);
  return structured ? { content, structuredContent: structured } : { content };
}

process.on('unhandledRejection', (err) => {
  console.error('[cpt-mcp] unhandled rejection:', err);
});

const transport = new StdioServerTransport();

// M104 校验：EXTRA 名必须真实存在（防拼错静默失效）；full 档无需 EXTRA（已全量）。
if (EXTRA_TOOLS.length > 0) {
  const unknownExtra = [...new Set(EXTRA_TOOLS)].filter((t) => !ALL_TOOL_NAMES.has(t));
  if (unknownExtra.length > 0) throw new Error(`CPT_MCP_EXTRA_TOOLS 未知工具名：${unknownExtra.join('、')}（用 get_capabilities 查合法工具名）`);
}
// 分节体系自检（启动即执行）：节键唯一、正文非空且两两不同、SECTION_REFS 与 usedBy 双向一致。
// 轻 entry 工具的参数说明只存在 SPEC_SECTIONS 一处，悬空引用 = 模型按 schema 去查却查不到。
{
  const problems = specSectionProblems();
  if (problems.length > 0) throw new Error(`SPEC_SECTIONS 分节体系不一致（${problems.length} 项）：${problems.join('；')}`);
}
// M102 可达性断言（启动即执行）：每个已注册工具必须可达——某档静态名单 ∪
// 某租约组 ∪ FULL_ONLY_WAIVERS 三选一。新工具未做选择直接起不来，
// “存在但不可达”不可能再悄悄落地。adhoc 临租是运行时逃生舱，不计入（否则检查空转）。
assertReachability({
  all: [...ALL_TOOL_NAMES],
  profiles: [FOCUSED_TOOLS, PROFILE_TOOLS.report, PROFILE_TOOLS.generate],
  groups: Object.values(DEEP_TOOL_GROUPS),
  waivers: FULL_ONLY_WAIVERS,
});

await server.connect(transport);

// 2026-11-07：安装源码热重启 watcher（fail-open —— 安装失败只告警，绝不影响 MCP 服务本身）。
// 只监控 cpt-mcp 自身源码（server.js + lib/**/*.js）；本地测试库/报表工作区/预览运行时不在监控范围。
// 命中后进程退出，DSH mcp-client 按默认重连策略（500ms 起、最多 10 次）拉起新进程加载新代码。
// 关闭方式：CPT_MCP_HOT_RELOAD=0；手动触发：<cwd>/.cpt-mcp/hot-reload.request。
try {
  installHotReload({
    root: path.dirname(fileURLToPath(import.meta.url)),
    cwd: process.cwd(),
  });
} catch (e) {
  console.error('[cpt-mcp] 源码热重启安装失败（忽略，不影响服务）：', e?.message ?? e);
}

