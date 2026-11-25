// cpt-mcp/lib/tool-guards.js —— 工具级运行时安全围栏（声明式策略表，单一事实源）
//
// 2026-10-29 整理：server.js 的 tool() 包装层原有一段 ~95 行的
// `if (name === 'xxx') {...}` 名字判断链——同一类围栏（JS 脚本需 allowUnsafeScript、
// 外部 URL 需白名单、数据文件/反编译输出路径需围栏）按工具逐个复制分支，重复且易漏。
// 现抽成「工具名 → 围栏函数」的声明式表：
//   · 新增同类工具只改这里，server.js 包装层保持一行 runToolGuards(name, args)；
//   · 同类策略（如 8 个 JS 载荷工具）用集合表达，不再 8 段 if；
//   · 安全策略集中一处，审计/测试只需看本文件。
//
// 行为契约（与整理前逐条等价，trap-matrix / 安全测试锁定）：
//   · JS 载荷工具：args.js 非空 → assertUnsafeScriptAllowed；
//   · 批量工具：items[].js 或 items[].patch.js 任一非空 → 同上（逐项扫描，plan 阶段即拦）；
//   · URL 类：url 非空 → assertSafeExternalUrl；
//   · 文件路径类：dataFile / excelFile / 反编译 outDir → assertDataFilePath / assertDecompileOutput；
//   · 定时任务 decompile：默认关闭，需 CPT_MCP_ALLOW_SCHEDULE_SIDE_EFFECTS=1。
import {
  assertDecompileOutput, assertDataFilePath, assertSafeExternalUrl,
  assertUnsafeScriptAllowed, looksLikeScript, assertToolPath,
} from './security.js';

/** 参数本身就是 JS 源码的工具（args.js 非空即需显式授权） */
export const JS_PAYLOAD_TOOLS = new Set([
  'set_report_js', 'set_report_listener', 'set_webwrite_js', 'set_webpage_js',
  'add_cell_listener', 'add_cell_listener_batch', 'update_cell_listener',
  'set_toolbar_button_js', 'add_toolbar_button',
]);

/** 批量写工具：逐项扫描 items[].js */
export const JS_ITEMS_TOOLS = new Set(['add_report_listener_batch', 'add_toolbar_button_batch']);

/** 批量写工具：逐项扫描 items[].patch.js */
export const JS_PATCH_ITEMS_TOOLS = new Set([
  'update_report_listener_batch', 'update_cell_listener_batch', 'update_toolbar_button_batch',
]);

// 与整理前口径逐字等价：只排除 undefined，null 也走围栏（String(null)='null' 非空）
const hasJs = (v) => v !== undefined && String(v).trim() !== '';

/** 名字 → 围栏函数（只处理需要 args 结构判断的个性化围栏；通用 JS 围栏走上面的集合） */
export const PER_TOOL_GUARDS = {
  fr_decompile: (args) => assertDecompileOutput(args.path, args.outDir),

  add_file_dataset: (args) => assertDataFilePath(args.dataFile, { fromEnv: args.fromEnv }),

  // 2026-11-04 P1（独立验收发现）：local_db_import({action:"excel"}) 会读本地 .xlsx，
  // excelFile 必须与 .cpt 一样受 CPT_MCP_ALLOWED_ROOTS 围栏，否则模型可借仿真读取任意目录文件。
  // 允许绝对/相对路径，但统一经 assertToolPath（只读）解析并校验允许根。
  local_db_import: (args) => {
    if (args.excelFile == null || String(args.excelFile).trim() === '') return;
    assertToolPath('local_db_import', String(args.excelFile).trim(), { write: false });
  },

  // 整表生成：Excel 数据源路径围栏（build_report 支持多数据集）
  build_report: (args) => {
    for (const dataset of args.spec?.datasets || []) {
      if (dataset.excelFile) assertDataFilePath(dataset.excelFile, { fromEnv: dataset.fromEnv ?? true });
    }
  },
  generate_report: (args) => {
    if (args.source?.excelFile) assertDataFilePath(args.source.excelFile, { fromEnv: args.source.fromEnv ?? true });
  },

  add_cell_hyperlink: (args) => {
    if (args.type === 'url') assertSafeExternalUrl(args.url);
    if (args.type === 'script') assertUnsafeScriptAllowed('add_cell_hyperlink', args.allowUnsafeScript);
  },
  update_cell_hyperlink: (args) => {
    if (args.url != null && String(args.url).trim() !== '') assertSafeExternalUrl(args.url);
    if (args.type === 'script' || (args.script != null && String(args.script).trim() !== '')) {
      assertUnsafeScriptAllowed('update_cell_hyperlink', args.allowUnsafeScript);
    }
  },
  add_cell_hyperlink_batch: (args) => {
    for (const it of args.items || []) {
      if (it?.type === 'url') assertSafeExternalUrl(it.url);
      if (it?.type === 'script') assertUnsafeScriptAllowed('add_cell_hyperlink_batch', args.allowUnsafeScript);
    }
  },
  update_cell_hyperlink_batch: (args) => {
    for (const it of args.items || []) {
      const p = it?.patch ?? {};
      if (p.url != null && String(p.url).trim() !== '') assertSafeExternalUrl(p.url);
      if (p.type === 'script' || (p.script != null && String(p.script).trim() !== '')) {
        assertUnsafeScriptAllowed('update_cell_hyperlink_batch', args.allowUnsafeScript);
      }
    }
  },

  // <Content> 直写脚本的入口与 update_cell 同级设防（含脚本特征检测）
  update_cell: (args) => {
    if (args.content !== undefined && looksLikeScript(args.content)) {
      assertUnsafeScriptAllowed('update_cell', args.allowUnsafeScript);
    }
  },
  batch_mutate_cells: (args) => {
    if (!Array.isArray(args.commands)) return;
    const wantsScript = args.commands.some((c) =>
      c?.op === 'update' && c?.data?.patch?.content !== undefined && looksLikeScript(c.data.patch.content));
    if (wantsScript) assertUnsafeScriptAllowed('batch_mutate_cells', args.allowUnsafeScript);
  },

  // raw-XML 低层入口：可直写 <Listener>/<TopJS> 脚本容器（纯结构节点与删除模式不设防）
  update_report_node: (args) => {
    if (args.xmlBody == null) return;
    const scriptContainer = /^(TopJS|Listener|JavaScript)$/i.test(String(args.nodeName || '')) ||
      /<(TopJS|Listener|JavaScript|script)\b/i.test(String(args.xmlBody));
    if (scriptContainer) assertUnsafeScriptAllowed('update_report_node', args.allowUnsafeScript);
  },

  schedule_add: (args) => {
    if (args.action === 'decompile' && process.env.CPT_MCP_ALLOW_SCHEDULE_SIDE_EFFECTS !== '1') {
      throw new Error('安全围栏：定时任务的 decompile 默认关闭；明确确认后设置 CPT_MCP_ALLOW_SCHEDULE_SIDE_EFFECTS=1');
    }
  },
};

/**
 * 执行工具级围栏（在租约/路径围栏之后、handler 之前调用）。
 * @param {string} name 工具名
 * @param {object} args 已通过完整 schema 校验的参数
 */
export function runToolGuards(name, args) {
  // 通用：JS 载荷工具（js 整块写入，或 patchReplace 片段替换文本同样是 JS）
  if (JS_PAYLOAD_TOOLS.has(name) && (hasJs(args.js) || hasJs(args.patchReplace))) {
    assertUnsafeScriptAllowed(name, args.allowUnsafeScript);
  }
  // 通用：批量项里的 JS（2026-11-03：batch 的 patch 对象会透传 patchReplace/expectedSha256 等，
  // 片段替换文本同样是可执行 JS —— 与单工具口径一致，必须过 allowUnsafeScript 围栏）
  if (JS_ITEMS_TOOLS.has(name) && Array.isArray(args.items)
    && args.items.some((it) => hasJs(it?.js))) {
    assertUnsafeScriptAllowed(name, args.allowUnsafeScript);
  }
  if (JS_PATCH_ITEMS_TOOLS.has(name) && Array.isArray(args.items)
    && args.items.some((it) => hasJs(it?.patch?.js) || hasJs(it?.patch?.patchReplace))) {
    assertUnsafeScriptAllowed(name, args.allowUnsafeScript);
  }
  // 个性化围栏
  const guard = PER_TOOL_GUARDS[name];
  if (guard) guard(args);
}
