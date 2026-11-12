// cpt-mcp/lib/lease-groups.js —— 场景族租约注册表（**单一事实源**）
//
// 为什么单独成模块：
//   ① `lib/deep-tools.js` 的 DEEP_TOOL_GROUPS / 租约策略、`get_capabilities` 的族目录、
//      `CPT_MCP_INSTRUCTIONS` 里的工具地图**必须是同一份**——三处各写一份必然漂移
//      （漏改一边就出"指令让模型调一个租不到的组"）。
//   ② 本模块不 import 任何业务模块（deep-tools.js / contract.js 反向引用它），
//      因此启动断言、单测、门禁脚本可以各自独立 import 而不产生循环依赖。
//
// 定位（方案 2.2）：静态工具表**每个请求**都要付 token；一次租约**每会话付一次**。
// 所以"高频"的口径从"跨会话累计"收紧为"单会话单任务内是否必然可达"：
//   单任务必然用到的读原语与写原语留在档位静态表；只在特定子场景成组出现的能力
//   （脚本/参数面板/填报绑定/工具栏/页眉页脚/行列结构/图表浮动/超链接高亮/诊断/调度/
//   数据集层级/下拉字典）按族下沉，凭 request_deep_tool_access 一次解锁整族。
//   **一个工具可以同时 ∈ 档位静态表与租约族，二者非互斥**（如 add_cell 既在 report
//   静态表、又属 cell_primitive；build_report 默认静态、同时是 generator_full 成员）。

/**
 * @typedef {object} LeaseGroup
 * @property {string[]} members       族内工具名
 * @property {string}   reason        该族唯一合法理由值
 * @property {string[]} [reasons]     多值白名单（既有 fr_engine 有两组值）
 * @property {number}   ttlSeconds    租约有效期
 * @property {number}   maxCalls      租约期内最多调用次数（beforeCall/afterCall 真实扣减）
 * @property {boolean}  pathRequired  是否必须绑定单文件
 * @property {boolean}  [gate]        门禁组：不接受 group=auto 直租
 * @property {string}   [special]     既有组的专用校验分支名
 * @property {string}   why           地图里给模型看的一句话定位
 */

/** @type {Record<string, LeaseGroup>} */
export const LEASE_GROUPS = Object.freeze({
  // —— 既有 5 组：语义与门禁不变（cell_detail / cell_primitive / fr_engine / report_rewrite / batch_read） ——
  cell_detail: {
    members: ['get_cell_style', 'get_cell_hyperlink', 'get_cell_highlight'],
    reason: 'exact_cell_read', ttlSeconds: 3600, maxCalls: 20, pathRequired: true,
    gate: true, special: 'cell_detail',
    why: '精确单格读取（必须给 target{sheet,cell}，租约只允许该格）',
  },
  cell_primitive: {
    members: ['add_cell', 'update_cell', 'update_cell_style', 'set_cell_content_type', 'set_cell_span', 'delete_cell'],
    reason: 'batch_failure', ttlSeconds: 3600, maxCalls: 20, pathRequired: true,
    gate: true, special: 'cell_primitive',
    why: '批量失败后凭 failureId 降级单格写（禁止批量失败后循环调单格工具）',
  },
  fr_engine: {
    members: ['fr_engine_check', 'run_fr_engine_check'],
    // 2026-11-07 P1-6：quality_gate_cpt 不再自动授予本族，只保留显式核验理由。
    reasons: ['explicit_engine_check'], reason: 'explicit_engine_check',
    ttlSeconds: 3600, maxCalls: 20, pathRequired: true,
    gate: true, special: 'fr_engine',
    why: '真实 FR 引擎核验（须显式 request_deep_tool_access(reason=explicit_engine_check)；或走 verify_cpt 静态免租约通道）',
  },
  fr_preview: {
    members: ['start_fr_preview', 'stop_fr_preview', 'fr_preview_status'],
    reason: 'explicit_preview', ttlSeconds: 3600, maxCalls: 20, pathRequired: false,
    why: '本地独立 FR 报表实例（设计器内核 headless 启动，浏览器复查样式/点检按钮/看 JS 效果）——须用户明确要求预览',
  },
  report_rewrite: {
    members: ['update_report_node', 'batch_mutate_cells', 'regenerate_from_meta'],
    reason: 'explicit_rewrite', ttlSeconds: 3600, maxCalls: 20, pathRequired: true,
    gate: true, special: 'report_rewrite',
    why: '低层/复杂改写（raw 节点改写、事务式批量写、meta 复现覆盖）——须用户明确要求',
  },
  batch_read: {
    members: [
      'get_dataset_batch', 'get_parameter_batch', 'get_parameter_widget_batch', 'get_style_batch',
      'get_cell_batch', 'get_fill_binding_batch', 'get_fill_submit_batch', 'get_chart_batch',
      'get_float_element_batch', 'get_cell_hyperlink_batch', 'get_cell_highlight_batch', 'get_cell_listener_batch',
      'get_report_listener_batch', 'get_toolbar_button_batch', 'get_cell_sort_batch', 'get_schedule_batch',
      'get_sheet_batch', 'get_page_header_footer_batch',
    ],
    reason: 'batch_read', ttlSeconds: 3600, maxCalls: 20, pathRequired: true, special: 'batch_read',
    why: '18 个 get_*_batch 一次读完（只读但体量大，默认隐藏防一次拉爆上下文）',
  },

  // —— 16 个场景族：按"单会话单任务内是否必然可达"重划静态/租约边界（M113 起逐步下沉；──
  //    另有既有 5 个门禁/特殊组 cell_detail / cell_primitive / fr_engine / fr_preview / report_rewrite，
  //    它们的专用校验分支保持不变） ——
  scripting: {
    members: ['set_report_js', 'set_report_listener', 'set_webwrite_js', 'set_webpage_js', 'set_webwrite_extras',
      'add_cell_listener', 'update_cell_listener', 'delete_cell_listener'],
    reason: 'explicit_script_edit', ttlSeconds: 3600, maxCalls: 20, pathRequired: true,
    why: 'JS/事件脚本读写（页面 JS、报表监听器、WebWrite、分页预览 WebPageContent、单元格监听器）——一次任务通常反复改同一批脚本，故按次数放开',
  },
  cell_dictionary: {
    members: ['update_cell_dictionary'],
    reason: 'explicit_dictionary_edit', ttlSeconds: 3600, maxCalls: 20, pathRequired: true,
    why: '单元格下拉字典整块改写（M91/M109）；读侧 get_cell_dictionary 留静态，写侧按需解锁',
  },
  style_manage: {
    // 2026-11-12 P0-1：add_style 从 report 静态表下沉。样式定义是独立原子手术（20+ 参数），
    // 塞进 add_cell/update_cell_style 会让高频工具 schema 反涨，净亏；改为按族解锁。
    // 日常"改某格样式"用静态的 update_cell_style；只读看样式用 get_cells({includeStyle:true}) /
    // read_cpt_compact(view=styles)。本族只覆盖"新增/删除命名样式"这类低频结构手术。
    members: ['add_style', 'delete_style'],
    reason: 'explicit_style_edit', ttlSeconds: 3600, maxCalls: 20, pathRequired: true,
    why: '命名样式表增删（StyleList 手术）：新增可复用样式或删除样式时一次解锁（日常改单元格样式用静态 update_cell_style）',
  },
  toolbar_edit: {
    members: ['add_toolbar_button', 'set_toolbar_button_js', 'delete_toolbar_button',
      'move_toolbar_button', 'set_toolbar_button_icon'],
    reason: 'explicit_toolbar_edit', ttlSeconds: 3600, maxCalls: 20, pathRequired: true,
    why: '工具栏按钮的增删移/图标（结构改动，低频）；改按钮 JS 走 set_toolbar_button_js（同族）',
  },
  param_panel: {
    members: ['set_parameter_panel', 'add_parameter_widget', 'update_parameter_widget',
      'delete_parameter_widget', 'rename_parameter_widget', 'add_parameter',
      'update_parameter', 'delete_parameter'],
    reason: 'explicit_param_panel', ttlSeconds: 3600, maxCalls: 20, pathRequired: true,
    why: '参数面板控件与参数的增删改（面板布局手术）；读侧 get_parameter_panel 留静态',
  },
  fill_binding: {
    members: ['add_fill_binding', 'update_fill_binding', 'delete_fill_binding',
      'add_fill_submit', 'update_fill_submit', 'delete_fill_submit', 'set_fill_toolbar',
      'get_embedded_submits', 'update_embedded_submit'],
    reason: 'explicit_fill_setup', ttlSeconds: 3600, maxCalls: 20, pathRequired: true,
    why: '填报提交/字段绑定治理（含去主键改纯 INSERT）；含按钮内嵌提交（Commit2DBJavaScript）读写；读侧 get_fill_config 留静态',
  },
  page_setup: {
    members: ['set_page_header_footer', 'delete_page_header_footer', 'set_template_theme',
      'delete_mobile_widget_ref', 'set_report_imports'],
    reason: 'explicit_page_setup', ttlSeconds: 3600, maxCalls: 20, pathRequired: true,
    why: '页眉页脚/主题/移动端条目/Web 页面静态资源（CSSImport/JSImport）等版式一次性设置',
  },
  row_col_layout: {
    members: ['add_sheet', 'update_sheet', 'delete_sheet', 'delete_cell_range', 'shift_cell_range',
      'delete_row_range'],
    reason: 'explicit_layout_edit', ttlSeconds: 3600, maxCalls: 20, pathRequired: true,
    why: '工作表与行列结构手术（增删 sheet、列/行区间删除位移，含 M112 delete_row_range）',
  },
  chart_float: {
    members: ['add_chart', 'update_chart', 'delete_chart', 'get_chart',
      'add_float_element', 'update_float_element', 'delete_float_element', 'get_float_element'],
    reason: 'explicit_chart_edit', ttlSeconds: 3600, maxCalls: 20, pathRequired: true,
    why: '图表与浮动元素族；读侧 get_chart/get_float_element 同族解锁，保证"一次解锁即闭环"',
  },
  hyperlink_highlight: {
    members: ['add_cell_hyperlink', 'update_cell_hyperlink', 'delete_cell_hyperlink',
      'add_cell_highlight', 'update_cell_highlight', 'delete_cell_highlight',
      'update_cell_sort', 'delete_cell_sort'],
    reason: 'explicit_cell_extra', ttlSeconds: 3600, maxCalls: 20, pathRequired: true,
    why: '单元格超链接/条件高亮/排序族（交互装饰类）',
  },
  diagnostics: {
    members: ['list_cpt_issues', 'diagnose_fill_row_integrity', 'style_review_cpt',
      'reasonableness_review_cpt', 'get_cell_sort', 'fr_detect', 'fr_inspect'],
    reason: 'diagnostics_read', ttlSeconds: 3600, maxCalls: 20, pathRequired: true,
    why: '只读诊断/审查/探针族（不改文件）；交付判定以静态表内的 quality_gate_cpt 为主入口',
  },
  schedule: {
    members: ['schedule_add', 'schedule_list', 'schedule_get', 'schedule_remove', 'schedule_enable',
      'schedule_disable', 'schedule_run_now', 'scheduler_status', 'scheduler_history',
      'scheduler_stop', 'scheduler_actions'],
    reason: 'explicit_schedule', ttlSeconds: 3600, maxCalls: 20, pathRequired: true,
    why: '调度器运维面（定时任务增删改查启停执行）；报表会话一般用不上，故整族下沉',
  },
  dataset_edit: {
    members: ['add_tree_dataset', 'delete_dataset'],
    reason: 'explicit_dataset_edit', ttlSeconds: 3600, maxCalls: 20, pathRequired: true,
    why: '数据集的层级化与删除（add_tree_dataset 建层级、delete_dataset 删数据集）；instructions 的「数据来源」一节点名 add_tree_dataset，故必须有可指的组',
  },
  generator_full: {
    // 2026-10-29 整理：generate_report 在 report/focused/generate 三档都静态可见，列入族成员是
    // 纯死配置（beforeCall 对静态暴露工具直接短路，租约永远不生效），故移出；
    // build_report 在 generate 档隐藏，该族唯一有效场景就是 generate 档按需解锁它。
    members: ['build_report'],
    reason: 'explicit_full_generator', ttlSeconds: 3600, maxCalls: 20, pathRequired: false,
    why: 'generate 档按需解锁 build_report（整表生成入口）；report/focused 档 build_report 本就静态可见，申请该族会直接回 already-visible',
  },
  // 内置 SQLite 本地测试库（2026-11-02）：报表数据集 SQL 的离线测试/回归。
  // 与外部真实库严格分离：本族工具只操作 <cwd>/.cpt-mcp/localdb 下的库文件；
  // 外部库导入走 lib/db.js 的只读通道（SHOW/ SELECT），永远不写。
  local_db: {
    members: ['get_local_db_status', 'local_db_admin', 'local_db_import', 'local_db_exec', 'local_db_schema', 'dataset_sql_parity'],
    reason: 'explicit_local_db', ttlSeconds: 3600, maxCalls: 40, pathRequired: false,
    why: '内置 SQLite 本地测试库（测试环境默认口径：建库/镜像真实 schema/按需抽样/造数/执行/真实 vs 本地对账/Excel 导入离线仿真）；本地库 MCP 全权限，外部真实库仍只读；常用路径 run_dataset_sql_check 的 target 缺省 local，静态可用',
  },
});

/** 门禁组：不接受 group=auto 直租，必须走各自专用凭据通道（不绕过任何既有门禁） */
export const GATE_GROUPS = Object.freeze(
  Object.entries(LEASE_GROUPS).filter(([, g]) => g.gate === true).map(([k]) => k),
);

/** 深层工具租约清单：默认隐藏、凭 request_deep_tool_access 短时解锁；full 入口静态全量暴露。
 *  由 LEASE_GROUPS **派生**（不再手写第二份）：凡编入场景族的工具默认隐藏；
 *  未编组的工具（如 set_cell_widget / fr_decompile / 批量写）走 adhoc 按名直租，不在本集合内。 */
export const DEEP_TOOLS = new Set(
  Object.values(LEASE_GROUPS).flatMap((g) => g.members),
);
