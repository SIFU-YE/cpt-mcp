// cpt-mcp/lib/reachability.js —— M102 可达性不变量：每个已注册工具必须可达
//
// 背景：M93/M95/M99-D1/M101 连出四次“存在但不可达”（工具注册了，却不在任何档位、
// 也不在任何租约组，非 full 档调即 unknown tool）。根因是 tool() 的
// `if (!inProfile && !isDeep) return` 静默放行——新工具只调一次 tool() 就算交付，
// 可达性安排全靠作者顺手。本模块把“可达”变成强制不变量：
//   每个工具 ∈ 某档静态名单 ∪ 某租约组 ∪ FULL_ONLY_WAIVERS（三选一，无第四种）。
// 新工具必须做选择题（进档 / 进组 / 加豁免写理由），否则服务端启动直接抛错；
// test/reachability.test.js 锁定该不变量。adhoc 临租是运行时的逃生舱，不计入
// 不变量（否则检查空转——任何工具都能临租，要它何用）。
// M104 原则：默认只给小集合（省 token/防幻觉），其余默认隐藏；确实需要时走
// CPT_MCP_EXTRA_TOOLS 在配置里一次声明进静态表，不做按次审批。临租只留给临时深挖。
// 工具上下文瘦身（M113）后的登记范围（**只针对"仅靠 WAIVERS 覆盖"的那个桶**）：
//   ① 一个工具可以同时 ∈ 档位静态表与租约组，**二者非互斥**（如 add_cell / update_cell_style
//      既在 report 静态表、又属 cell_primitive；build_report/generate_report 默认静态、
//      同时是 generator_full 成员）。因此进静态表的工具**不参与**本表清理。
//   ② 已编入场景族（lib/lease-groups.js）的工具从本表删除 —— 它们有了具名租约通道，
//      再留在豁免表就是"同一工具两处登记"，会掩盖"这个族到底通不通"的判断。
//   ③ 本表只留真正无租约通道者：非原子的批量写（49+2 项）、未编组的低频控件/删样式手术、
//      以及依赖本机 cptdec 的 fr_decompile。这些走 adhoc 按名直租。
import { DEEP_TOOL_GROUPS } from './deep-tools.js';

/** 显式豁免表：长期仅 full 可见、不接受租约的家族（条目须写理由，评审制）。
 * 按需用 adhoc 临租绕行（读 adhoc_read / 写 adhoc_write / 破坏 adhoc_destructive），
 * 但默认不可见——弱模型档位不为之付 token，强模型 full 档全量可用。 */
export const FULL_ONLY_WAIVERS = [
  {
    family: 'batch-writes',
    reason: '【M113 保留】非原子逐项执行（单项失败记 failed 不中断）+ 多为破坏性；批量写走 batch_mutate_cells（原子）或单工具；批量读走 batch_read 租约。默认隐藏防弱模型误调涨上下文。',
    tools: [
      'add_dataset_batch', 'delete_dataset_batch', 'update_dataset_batch',
      'add_parameter_batch', 'delete_parameter_batch', 'update_parameter_batch',
      'delete_parameter_widget_batch', // add_/update_ 已进 report 静态表（P0 2026-10-26）
      'add_style_batch', 'delete_style_batch', 'update_style_batch',
      'add_fill_binding_batch', 'delete_fill_binding_batch', 'update_fill_binding_batch',
      'add_fill_submit_batch', 'delete_fill_submit_batch', 'update_fill_submit_batch',
      'add_chart_batch', 'delete_chart_batch', 'update_chart_batch',
      'add_float_element_batch', 'delete_float_element_batch', 'update_float_element_batch',
      'add_cell_hyperlink_batch', 'delete_cell_hyperlink_batch', 'update_cell_hyperlink_batch',
      'delete_cell_highlight_batch', 'update_cell_highlight_batch',
      // 2026-11-12 P0-1：add_cell_highlight_batch 从 report 静态表下沉（非原子批量便利工具，
      // 与原子化原则冲突；单件 add_cell_highlight 仍在 hyperlink_highlight 族，需要批量时 adhoc 临租）。
      'add_cell_highlight_batch',
      'add_cell_listener_batch', 'delete_cell_listener_batch', 'update_cell_listener_batch',
      'add_report_listener_batch', 'delete_report_listener_batch', 'update_report_listener_batch',
      'add_toolbar_button_batch', 'delete_toolbar_button_batch', 'update_toolbar_button_batch',
      'add_cell_sort_batch', 'delete_cell_sort_batch', 'update_cell_sort_batch',
      'add_schedule_batch', 'delete_schedule_batch', 'update_schedule_batch',
      'add_sheet_batch', 'delete_sheet_batch', 'update_sheet_batch',
      'add_page_header_footer_batch', 'delete_page_header_footer_batch', 'update_page_header_footer_batch',
    ],
  },
  {
    family: 'scaffold-add-update',
    reason: '【M113 清理后仅剩未编组项】控件本体改写（切换 <Widget class> / 改 widgetValue）部分与静态入口重叠、平时用不到，默认隐藏省 token；需要时 adhoc_write 临租。其余原属本族的工具已编入具名场景族（add_sheet→row_col_layout、add_chart→chart_float、set_template_theme→page_setup、add_parameter*→param_panel、add_fill_binding→fill_binding 等），不再需要豁免。',
    tools: [
      'set_cell_widget', 'set_widget_value',
    ],
  },
  {
    family: 'scaffold-delete',
    reason: '【M113 清理后仅剩未编组项】其余原属本族的删除/位移工具已编入具名场景族（delete_*→row_col_layout / hyperlink_highlight / page_setup / toolbar_edit / chart_float / dataset_edit / fill_binding；delete_style→style_manage）。clear_widget_value 因删值槽误伤风险高，留 full deliberate；需要时 adhoc_destructive 单次临租（单文件域、120 秒过期）。',
    tools: [
      'clear_widget_value',
    ],
  },
  {
    family: 'template-meta-reads',
    reason: '【2026-11-12 P0-1】模板级只读元数据已有专用通道：read_cpt_compact({permitId, view:"styles"/"page"})（读门禁，静态工具）覆盖样式表与页面设置；独立读取工具不再每请求常驻，确有裸读需求时 adhoc_read 按名临租。',
    tools: ['get_styles', 'get_page_settings'],
  },
  {
    family: 'decompile',
    reason: '需本机 cptdec 反编译工具链，仅 full 人工调用；无租约通道（环境依赖重，不适合临租扩散）。',
    tools: ['fr_decompile'],
  },
];

/**
 * 可达性断言：all 中每个工具必须至少被 profiles（档位静态名单之并）、
 * groups（租约组成员之并）、waivers（豁免表成员之并）三者之一覆盖。
 * 另校验豁免表无幽灵条目（列了不存在的工具名同样抛错，防表腐烂）。
 * @returns {ok:true, total}；否则 throw（列出全部黑户）。
 */
export function assertReachability({ all, profiles, groups, waivers = FULL_ONLY_WAIVERS }) {
  const covered = new Set();
  for (const p of profiles) for (const t of p) covered.add(t);
  for (const g of groups) for (const t of g) covered.add(t);
  const waived = new Set();
  for (const w of waivers) for (const t of w.tools) waived.add(t);
  const allSet = new Set(all);
  for (const t of waived) {
    if (!allSet.has(t)) throw new Error(`可达性豁免表腐烂：${t} 已不在注册表中（改名/删除工具后未同步豁免表）`);
  }
  const holes = [...allSet].filter((t) => !covered.has(t) && !waived.has(t));
  if (holes.length > 0) {
    throw new Error(
      `可达性断言失败：以下 ${holes.length} 个已注册工具无处可达（不在任何档位、不在任何租约组、不在豁免表）：${holes.join('、')}。` +
      '新工具三选一：进某档静态名单 / 进某租约组 / 在 FULL_ONLY_WAIVERS 加豁免条目并写理由。',
    );
  }
  return { ok: true, total: allSet.size };
}
