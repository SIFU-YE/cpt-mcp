# cpt-mcp

FineReport 填报报表 `.cpt` 文件的 **MCP 服务器**：读取 / 生成 / 修改 / 删除 / 校验，完全自包含（本地 XML 编辑），不依赖其他 MCP 或数据库。

生成工具的 XML 结构对照真实 `.cpt` 样本与《FineReport_CPT_XML映射清单.md》逐节点对齐，保证设计器兼容。

## 配置方式：环境变量

所有机器相关配置都通过环境变量提供，代码和文档不再写死盘符。复制 [`.env.example`](./.env.example) 为 `.env`（已在 `.gitignore`），或把同名变量注入 MCP 客户端/宿主进程。DSH 会加载 `<DSH_HOME>/.env`；cpt-mcp 本身不读取 `.env`。

| 变量 | 作用 |
|---|---|
| `FR_HOME` | FineReport 安装根目录，用于反编译/真实引擎探测 |
| `FR_REPORTLETS_DIR` | 可选，官方 reportlets 目录；不设置时从 `FR_HOME` 推导 |
| `FR_SAMPLE` | 可选，单个官方 `.cpt` 样本 |
| `CPT_MCP_ALLOWED_ROOTS` | `.cpt` 工作区白名单，分号分隔；支持相对路径，按 MCP 进程 cwd 解析 |
| `CPT_MCP_TOOL_PROFILE` | `generate` / `focused` / `report` / `full` |
| `CPT_MCP_SQL_TARGET` | `local` / `real` / `both` |
| `CPT_MCP_GATE_BRIEF` | `1`=门禁/校验默认摘要（report 模式建议开）；`0`/未设=完整明细 |
| `CPT_MCP_GATE_CACHE_TTL_MS` | 门禁结论缓存 TTL（毫秒，默认 600000=10 分钟；`0` 关闭） |
| `CPT_MCP_FR_PREVIEW_ADMIN_PASSWORD` | 本地预览口令，仅本地测试使用 |
| `CPT_DB_CONNECTIONS` / `CPT_DB_CONN_FILE` | 可选只读数据库连接配置 |
| `CPT_E2E_SAMPLE` | 可选 E2E 样本路径 |

## 工具清单（208）

工具采用渐进式入口，避免较弱模型一次接收 208 个工具及全部 schema；report 档更通过「静态 33 项 + 场景族租约」把每请求的工具定义压到 ≈11.4k tokens（2026-11-12 P0-1 瘦身：42→33，分批把低频工具并入高频工具/读门禁/具名租约族；详见下方 report 档说明与 lib/contract.js 的 REPORT_STATIC_TOOLS）：

- `node server-generate.js`：只暴露 9 个工具（`get_capabilities`、`read_cpt`、`generate_report`、`validate_cpt`、`quality_gate_cpt`、`get_build_progress` 六个核心 + `request_deep_tool_access`、`record_cpt_read_intent`、`read_cpt_compact` 三个编排入口），适合“只给需求直接生成报表”——generate_report 唯一写路径 + 质量门槛判定。
- `node server-focused.js`：暴露 42 个常用生成、修改和校验工具（参数面板控件编辑 `get/set_parameter_panel`、`add/update/delete_parameter_widget`（含下拉多选 comboCheckBox）；单元格监听器读写 `get/add/update/delete_cell_listener`；报表级 Listener 读改写 `get/set_report_listener`（`get_report_listener` 同时读取 WorkBook 级 `ReportWebAttr/WebPageContent` 分页预览事件，area=webpage）；WebWriteContent 监听器读改写 `get/set_webwrite_js`——读回 afterload/填报 Web 事件 JS 全文（rowCalc/frFin 等）改后写回；分页预览事件写入用 `set_webpage_js`（scripting 租约族）；四套 JS 域全覆盖；单元格下拉字典改 `update_cell_dictionary`；JS 语法检查 `check_report_js`——返回块内行号，排错直指报错行（**M116 起先解码 FR 设计器转义 `]A`→`]` 再解析**：`]A` 是设计器对 `]` 的正常落盘编码，官方样本里 237 个 `]` 100% 都是该形态，不解码会把官方模板误报成语法错）；工具栏按钮读写 `list/set_toolbar_button_js`；字典正文读取 `get_cell_dictionary`）。
- `node server.js`：**默认入口（report）**，暴露 33 个静态工具（报表业务完整面）；`server-focused.js` 是弱模型省 token 的精选子集（42 项，**集合与 report 不同**：report 偏读取/数据源/生成，focused 偏修改与 JS 读改写）。
- `node server.js`（**默认档 = report**，33 项静态工具 ≈ 11.4k tokens）：报表业务的完整静态面，名单的单一来源是 `lib/contract.js` 的 `REPORT_STATIC_TOOLS`；**不需要宿主预设注入任何 env**。构成：门/协议 5 + 通用只读原语 12 + 静态批量 2 + 每任务必用写原语 9 + 整表生成 1（`generate_report`）+ 交付门禁 4。**2026-11-12 P0-1 的合并/下沉**：`get_cell_style`→`get_cells({includeStyle:true})`；`set_cell_content_type`/`set_cell_span`→`update_cell({contentType})`/`({colspan,rowspan})`；`get_build_progress`→`read_cpt({includeProgress:true})`；`get_styles`/`get_page_settings`→读门禁 `read_cpt_compact` 的 styles/page 视图；`add_style`→`style_manage` 租约族；`build_report`→`generator_full` 租约族；`add_cell_highlight_batch`→默认隐藏（adhoc 临租）。能力全部可达，只是"什么时候付 token"。
  其余能力按**场景族租约**获得（一次解锁整族，按族租不按工具租）：`scripting`/`cell_dictionary`/`toolbar_edit`/`param_panel`/`fill_binding`/`page_setup`/`row_col_layout`/`chart_float`/`hyperlink_highlight`/`diagnostics`/`schedule`/`dataset_edit`/`fr_preview`/`batch_read`/`generator_full` + 既有门禁族 `cell_detail`/`cell_primitive`/`fr_engine`/`report_rewrite`；未编组的长尾走 `group:'adhoc'` 按名直租。只记得工具名时用 `group:'auto'` 自动判组。族目录、成员与逐字可执行的解锁示例见 `get_capabilities` 的 `toolMap.leaseGroups`（与运行时组表**同源**）。
- `node server-full.js`：完整 208 工具入口，用于精细编辑、调度和 FR 逆向（全量静态可见，不走租约）。

也可在启动 `server.js` 前设置 `CPT_MCP_TOOL_PROFILE=generate|focused|report|full`（默认 `report`；`focused` 供弱模型省 token；`full` 等价于 `server-full.js`）。

**读取**
- `get_build_progress`（已并入 `read_cpt({includeProgress:true})`，默认隐藏）— 构建工序进度（按模板现状推导：数据集→样式→单元格与扩展→网格→页面→参数面板→填报→质量门槛→引擎校验），nextAction 指出下一步
- `quality_gate_cpt` — ⭐ 统一质量门槛（交付判定点）：聚合结构/样式/合理性/左父格/引擎结论，返回 pass/structuralPass/deliveryPass 三字段并列（pass=结构门槛，deliveryPass=pass&&引擎pass，最终交付门槛），deliveryPass=true 才可交付；blockers 每条带可执行修复指引。门禁只读缓存引擎结论、**不自动跑引擎、也不自动授予租约**（调用不会改变 tools/list）：engineCheck 非 pass 时首选 `verify_cpt({path,engine:true})`（静态免租约）刷新报告再重跑；要用 `run_fr_engine_check` 须先显式 `request_deep_tool_access({path,group:"fr_engine",reason:"explicit_engine_check"})`。只重跑门禁不会翻牌（返回体 `nextAction`/`engineCheck.deepAccess.hint` 直接给出这两条路）
  可选 `resetJsBaseline:true`（2026-11-03）：确属有意删块导致 JS 基线告警时复位本模板基线（返回 `baselineReset`/`baselineResetInfo` 旧计数），不必删 AppData 文件；默认 false 时语义不变
- `read_cpt` — 模板概览（版本/数据集数/参数数/单元格数/提交数/主题/JS 块计数，含多工作表）；存在 TopJS 时 `jsBlocks[]` 另带 `topJsBytes/topJsLines/topJsSha256`（供 `set_report_js` 的 patch 对账与 `expectedSha256` 自卫）
- `get_datasets` — 数据集列表（连接/SQL/参数）
- `get_parameters` — 数据集参数（名/默认值/所属数据集）
- `get_cells` — 单元格查询（按列/行/控件过滤；含控件值内容类型与监听器 JS）
- `get_fill_config` — 填报提交配置（目标表/字段绑定/主键/提交类型 `submitType`/`dmlConfigClass`/条件类 `conditionClass`，支持多工作表）。**只含报表级 SubmitVisitor**
- `get_embedded_submits` — 单元格内嵌提交（按钮里的 `Commit2DBJavaScript` → `Attributes`+`DMLConfig`，一个按钮可多套）：单元格/事件/提交名/目标表/字段列映射；并做「近表交叉核对」，同名字段列号不一致会列在 `crossCheck`（写回时会把库值覆盖成 NULL）
- `get_styles`（已并入读门禁 `read_cpt_compact({view:"styles"})`，默认隐藏）— 样式列表（StyleList 索引/字体/颜色）
- `get_page_settings`（已并入读门禁 `read_cpt_compact({view:"page"})`，默认隐藏）— 页面设置（纸张/边距/居中/缩放/页眉页脚高度）
- `get_grid` — 各工作表行高/列宽（defaultValue + CDATA 明细 + mm 换算）
- `get_parameter_panel` — 参数面板（标题/控件列表/BoundsAttr/参数项）

**生成（分步拼装模板）**
- `create_cpt` — 从零生成最小合法骨架（WorkBook/空数据集/空工作表/默认样式0，默认 11.5.0 版本）
- `add_sheet` — 在工作簿末尾追加新工作表（多 sheet 报表用）
- `add_dataset` — 新增 SQL 数据集（连接/查询/参数）
- `add_file_dataset` — 新增 Excel 文件数据集（.xls/.xlsx；CSV/文本/XML 官方零实例，明确拒绝）
- `add_tree_dataset` — 新增树数据集（在已有数据集之上按父-子两列建层级，用于组织架构/省市区/BOM）
- `add_style`（已下沉 `style_manage` 租约族；日常改样式用 `update_cell_style`）— 新增样式，返回 styleIndex
- `add_cell` — 新增单元格（文本/公式/DSColumn/填报控件 text·textarea·date·comboBox·checkBox·comboCheckBox·label·submit·appendRow·custom）；DSColumn 可传 `summary`（DSColumn 汇总模式：sum/avg/count/max/min），传了就以官方 SummaryGrouper 形态落盘，缺省为分组。**2026-10-29 公式修正**：`contentType:"formula"` 改写成官方 `<O t="XMLable" class="com.fr.base.Formula"><Attributes><![CDATA[=...]]></Attributes></O>` 对象（此前写普通 `<O>` CDATA，FR 不计算公式），`content` 带不带 `=` 均可
- `add_fill_submit` — 新增填报提交 SubmitVisitor（目标表/字段绑定/常量绑定；**2026-10-31 起** `bindings[].skipUnmodified` 可逐列开启 FR「未修改则跳过」= 列级智能提交，`condition` 可直接写提交条件如 `"Y5=1"`；**2026-11-09 起** `submitType:"insert"` 写 `InsertConfig` 插入提交，缺省 `intelligent` 保持 `IntelliDMLConfig` 智能提交）
- `set_fill_toolbar` — 既有模板填报工具栏（模板级 WebWriteContent/ToolBars：Submit/Verify/AppendColumnRow/DeleteColumnRow，可自定义；双 sheet 报表第 2 表提交按钮一次设置全 sheet 生效）；2026-10-20 起写前自动把错位的 WebWriteContent 搬回 `ReportWebAttr` 并回报 `repaired`
- `set_report_settings` — 纸张（A3/A4/A5/B4/B5 预设或自定义 mm）/边距/居中/缩放/**冻结行列（frozenColumn/frozenRow，FR 官方 FrozenColumnRow 结构）**
- `set_page_header_footer` — 页眉/页脚（左中右三区；内置页码预设或自定义公式）
- `set_report_imports` — Web 页面静态资源引用（ReportWebAttr 内 `<CSSImport>`/`<JSImport>` 整段替换，FR 按 webroot 相对路径加载服务器磁盘文件；build_report 重建默认清空，需用 spec.imports 显式重建）
- `set_template_theme` — 模板整体主题（兼容主题/经典浅灰/兼容/清爽科技/经典深灰，官方 301 例实测）
- `set_parameter_panel` — 参数面板标题/显示/位置（保留已有控件）
- `add_parameter_widget` — 参数面板筛选控件（路线D：下拉/文本框/日期/复选/标签/查询按钮；控件名与参数同名自动绑定；`dictionary.type` 支持 db/table/custom/**formula 公式数据字典**——官方 37 块实证）。**M117 同名防护**：面板已有同名控件时默认拒绝（静默产生两个同名控件是危险默认），报错指路 `update_parameter_widget`/`rename_parameter_widget`/`delete_parameter_widget`；确需刻意并存须显式 `allowDuplicate=true`。**2026-10-29 筛选控件三修**：① `x/y` 不传时自动接在现有控件右侧/换行（此前默认 (10,10)，连续新增全叠在左上角 = 「筛选控件位置异常」根因），显式 x/y 仍按用户坐标落位；② `label` 自动生成**独立可见 Label 控件**（`lbl_<name>`，设计器同款；实测 `<LabelName>` 在 Web 参数面板不渲染 → 此前「缺少标签」的根因），标签宽度按字数估算；③ `checkBox`/`comboCheckBox` 必须提供 `dictionary` 或非空 `items`（此前 checkBox 分支不写 Dictionary/RAAttr、items 被静默丢弃 → 空复选组），缺参数直接报错而不是生成坏控件
- `update_parameter_widget` — 修改存量面板控件：可见性/默认值（含公式值类型）/坐标/字体边框；**2026-10-29 补齐 `width`/`height`/`label`**：尺寸异常可直接改（此前只有 x/y，尺寸错只能 delete→add 重建，正是会话里反复增删的 churn 来源）；`label` 同步改 LabelName 与配套可见 Label 控件文字（传空串=删标签）；**M117 就地改字典**（此前只能 delete→add 重建，会丢坐标/字体/移动端引用）：`dictionary:{type:"table"|"db"|"custom"|"formula"}` 整块换，或原位改 `items`/`kiName+viName+table`/`formula+eFormula`，与 `update_cell_dictionary` 同源 `dictionaryXml`；只动 `<Dictionary>` 块，控件其余字节逐字节保留，字典已一致时 `mode:none` 不写文件（参数面板是全局的，无 sheet 参数）
- `rename_parameter_widget` — 重命名参数面板控件（控件名 + 同名报告参数绑定 + WidgetNameTagMap 标签映射 + 移动端控件清单引用四位一体同步；只改 <ReportParameterAttr> 块内，块外数据集参数/单元格条件引用一概不动）
- `set_grid` — 行高/列宽

**增/改/删**
- `add_parameter` / `update_parameter` / `delete_parameter`
- `update_dataset` — 修改数据集 SQL
- `update_cell` / `delete_cell` — 单元格提示/内容（兼容 `<O>` 与 `<Content>`）；**2026-10-29 公式闭环**：`content` 以 `=` 开头时公式格**原位改公式**（保持官方 Formula 对象）、文本格自动升级为公式对象——此前公式格被当"对象内容"直接拒绝，只能 delete+add 反复重建
- `set_cell_widget` — 修改已有单元格的控件类型（<Widget class> 官方白名单切换，如 text→number 解 "id 类型不匹配"；type=none 删除控件；数据绑定 <O> 与子结构保留；text= 换类型时同步写显示文本）
- `set_cell_content_type`（已并入 `update_cell({contentType,force,formula,dsName,columnName,summary,imageClass})`；独立工具默认隐藏，仅 cell_primitive 批量失败降级通道）— 改造空白/纯文本单元格为目标类型（text/formula/dsColumn/image）；dsColumn 可传 `summary`（DSColumn 汇总模式：sum/avg/count/max/min），传了就以官方 SummaryGrouper 形态落盘，缺省为分组。**2026-10-29**：新增 `force`（目标格已是对象内容如绑定/公式/图片时整块替换，此前错误提示让传 force 但 MCP schema 没这个参数）；formula 模式自动规范为**单个前导 `=`**（此前传 "=ROW()-4" 会写成 "==ROW()-4"）
- `set_widget_value` — 修改已有单元格控件的显示文本（widgetValue；专治 Label 标签控件默认值为空导致字体不显示）
- `*_batch` 批量工具均为【非原子】逐项执行（单项失败记 failed 不中断，已成功项保留，调用后检查 summary.failed/results 做补偿）；单元格多格如需原子请走 `batch_mutate_cells`（plan 试算→apply 原子写回，需 report_rewrite 租约）。
- `delete_cell_range` / `shift_cell_range` — 批量列区间操作：整列删除并右列左移补位 / 整段列平移归位（同步改写填报绑定与父格引用；专治「重建单元格列位错位」需逐格 delete+add 的 token 浪费）；`shift_cell_range` 支持 `insert=true` 插入式挪移（Excel「插入剪切的单元格」）：目的列被占用时让位列自动轮转换位，不再需要「腾暂存列 → 搬块 → 回填」绕行。**2026-10-31 起返回 `staleRefs`**：公式/提交条件里的 A1 引用不会自动改写（sandbox19/v1 里陈旧条件 `Y5=1` 导致提交静默不写库），挪移/删除后一次性列出旧引用与建议新坐标，修法见 hint
- `get_cell_style`（已并入 `get_cells({includeStyle:true})`；独立工具默认隐藏，仅 cell_detail 门禁族通道） / `update_cell_style` — 样式读写（兼容 FRFont `foreground` 属性形式与子元素形式）；`scope` 取 `cell`（默认，克隆后只改目标格）/`shared`（原地改共享样式）；传 `scope:"style"` 会按自然写法归一为 `shared`
- `update_embedded_submit` — 改按钮内嵌提交：`mode=patch` 改单字段列号/行/主键/常量/`skipUnmodified`，`mode=replace` 用 `columns` 整列清单替换（删冗余列，保留 Table/Condition 与其它提交/回调 JS；columns 可逐列带 `skipUnmodified`）；`update_cell_listener` / `delete_cell_listener` 会拒绝整块覆盖这类块（会静默丢提交配置）
- `add_fill_binding` / `update_fill_binding` / `delete_fill_binding` — 填报绑定（update 支持 `constant` 改为写固定值而非取单元格，如 is_delete 改常量 0 根治"依赖单元格被污染"；**2026-10-31 起** add/update 均支持 `skipUnmodified` 逐列开关「未修改则跳过」）
- `add_fill_submit` — 新建填报提交：① 列映射（默认，BuiltInSQLSubmiter 整行 upsert；`submitType:"insert"` 可写 InsertConfig 插入提交，缺省智能提交）；② 传 `sql` 走**自由 SQL 提交**（FreeSQLSubmiter 原始 SQL，可自定义 WHERE 的 UPDATE/DELETE 删除提交，如 `UPDATE ... SET is_delete=1 WHERE id=${id}`）。**2026-10-30：SQL 里的 `${x}` 会自动声明成 `<Parameters>` 提交参数（取值 `=$x`，运行时从同名报表参数取值）**，不再出现 `${del_id}` 原样进库的运行时错；需要覆盖取值或补声明时传 `parameters:[{name,value?}]`。目标数据连接可直接写 `connection`（2026-10-29 起归一：列映射→`dsName`，自由 SQL→`dbName`）
- `delete_dataset` / `delete_chart` / `delete_sheet` / `delete_style` / `delete_fill_submit` / `delete_parameter_widget` / `delete_mobile_widget_ref` / `delete_page_header_footer` — 增补删工具（数据集/图表/工作表/样式/提交/面板控件/移动端孤儿条目/页眉页脚）
- `delete_cell_hyperlink` / `delete_cell_highlight` / `get_cell_highlight` — 单元格超级链接/条件属性的删与查
- `add_cell_highlight` — 单元格条件属性（公式/比较/多条件组合 → 背景、字色、条件改值、条件改字体）
- `add_cell_hyperlink` — 单元格超级链接与 JS 事件（跳转报表并传参 / 外部 URL / 自定义脚本）
- `add_cell_listener` — 给单元格（或其控件/按钮）挂 `<Listener event>` 的控件事件 JS
  （click/afterinit/afteredit/stopedit 等，官方 114 例实证；与超链接 JS 是两套机制）；
  **只增**：同 event 已有 Listener 时报错（修改用 `update_cell_listener`、删除用 `delete_cell_listener`），需 allowUnsafeScript=true；
  本工具不做片段替换（无旧块可改）——只改已存在 Listener 里的一段请用 `update_cell_listener({patchFind,patchReplace})`
- `add_cell_listener_batch` — 批量给多个单元格挂同段事件 JS（cells 坐标列表一次完成，替代逐格调用；**只增**：js 必填，同 event 已有 Listener 的格记 failed 继续，不覆盖、不删除）
- **P1 单独项补齐·改/删/查**（语义分明：update 只改已存在目标、delete 只删已存在目标、get 只读，均不靠「增的覆盖」凑合）：
  - `update_chart` / `get_chart` — 改/查图表（标题、数据集、分类字段、数值列、图表类型，原位重算保留坐标与合并跨度）
  - `update_float_element` / `get_float_element` — 改/查浮动文本元素（内容、样式、位置、名称）
  - `update_cell_hyperlink` — 改单元格超链接/JS 事件（按 name 定位，可改类型/目标/参数/打开方式/改名）
  - `update_cell_highlight` — 改单元格条件属性（按 name/index/formula 定位，改条件或改效果）
  - `update_cell_listener` / `delete_cell_listener` / `get_cell_listener` — 改/删/查单元格控件事件 Listener JS。
    `update_cell_listener` 整块改写传 `js`（mode=replace）；**大段事件 JS 只改一段用 `patchFind`+`patchReplace` 片段替换**（mode=patch，`]A` 感知、默认唯一命中、`patchAll` 允许多处、与 js 互斥）；整块写入触发缩水护栏时传 `allowShrink:true` 放行，`expectedSha256` 写前核对；返回 `jsBytesBefore/jsBytesAfter/jsLinesBefore/jsLinesAfter`
  - `update_cell_sort` / `get_cell_sort` — 设置/替换/读取单元格「扩展后排序」规则
  - `update_fill_submit` — 改填报提交（名称/数据连接/目标表/schema/**提交类型 `submitType`/`configType`**，或自由 SQL 的 sql/dbName/`parameters`）；改 SQL 时自动补齐新出现的 `${x}` 声明、保留已有声明与自定义取值；显式 `parameters` = 以此列表为准整块替换，空数组 = 清空。**2026-10-31 补齐**：`condition` 直接读写提交条件（FormulaCondition 如 `"Y5=1"`，null/空串=清除），`skipUnmodified` 一次设置该提交全部列（列级智能提交）——sandbox19/v1 里这两项只能手拼 XML/找用户在设计器勾。**2026-11-09 补齐（sandbox2/v8）**：`submitType:"insert"` 把智能提交 `IntelliDMLConfig` 改为插入提交 `InsertConfig`；`condition:"ListCondition"` 写空列表条件，已有 ListCondition 也能安全改成公式
  - `update_sheet` — 重命名工作表（网格/单元格/填报配置原样保留）
- `set_report_js` — **报表JS（TopJS/报表顶部JS）**：`<TopJS>` 内写一段在报表页面加载时执行的 JS
  （contentPane 初始化、全局 hook、自动刷新等），可指定 sheet；可执行 JavaScript 需 `allowUnsafeScript=true`。
  **大块 TopJS 只改一段用 `patchFind`+`patchReplace` 片段替换**（`]A` 感知、默认唯一命中、`patchAll` 允许多处、与 js 互斥、只改 CDATA 内文）；
  **整块写入把 ≥4KB 旧 TopJS 缩到 <60% 且少 ≥2KB 会被缩水护栏拒绝**（确要整块重写传 `allowShrink:true`）；
  `expectedSha256` 在 patch/整块替换/删除前核对（`read_cpt` 的 `jsBlocks[].topJsBytes/topJsLines/topJsSha256` 可直接取旧块度量）；
  返回 `mode=patch/replace/delete` 与 `jsBytesBefore/jsBytesAfter/jsLinesBefore/jsLinesAfter`（新建时 before=0）
- `set_report_listener` — 报表事件（Listener）：onload/afterload/beforeOutput/afterOutput/webopen 等挂 JS；同 event 多 Listener 时用 `match` 精确命中；**JS 合并约定**：同一容器内相同事件类型的 JS 只允许一个代码块——已有同 event 块时用 `aggregate:true` 追加/合并（多块按文档顺序并回一块、不丢内容），不要另起新块。**大块共享 Content 只改一段用 `patchFind`+`patchReplace` 片段替换**（literal、默认唯一命中、块内其余原文原样保留；**已兼容设计器转义 `]A`：净文本 `]` 与落盘 `]A` 均可命中，回写保持 `]A` 编码**）；**整块替换把 ≥4KB 的 Content 缩到 <60% 且少 ≥2KB 会被缩水护栏拒绝**（2026-11-03 事故：187KB afterload 被 8KB 替换，块数/语法/门禁全绿但功能全丢），确要整块重写传 `allowShrink:true`；返回 `jsBytesBefore/jsBytesAfter` 供对账
- `update_report_node` — 低层入口：upsert/删除 Report 内任意子节点（Listener/TopJS/ReportPageAttr 等）；正文参数为 `xmlBody`（`content`/`xml`/`nodeXml` 会自动归一，2026-10-29）。**2026-10-30 安全化**：替换时默认**保留原开标签属性**（旧实现会丢 `class`，重写 `<SubmitVisitor>` 会丢 `FreeSQLSubmiter` 提交类型），确需改属性传 `replaceAttributes:true`；`attributes` 未命中默认报错（旧实现静默新插重复节点），确认新建传 `createIfMissing:true`；`parent` 从「只负责插入」升级为「查找+插入都收进唯一父容器」（如 `parent:"SubmitVisitor"` 给提交补 `<Parameters>`，不再被全文件同名候选误拦）。**2026-10-31**：`xmlBody` 含外层标签（如 `<Condition …>…</Condition>`）时原样落盘、不再套成两层（sandbox19/v1 实测 `<Condition><Condition>`；返回 `wrapping:"verbatim"|"wrapped"`）。2026-10-20 新增 `parent` 并禁止 `<WebWriteContent>` 走无 parent 的“插到 `</Report>` 前”兜底（旧行为会把它插错位置、FR 填报预览读不到）
- `set_webwrite_extras` — WebWriteContent 内子节点（EditRowColor/WebWrite/RptLocation 等）。
  **2026-10-20 P0 修复**：缺容器时在 WorkBook 级 `<ReportWebAttr>` 内创建默认骨架（不再插到 `</Report>` 前）；容器被旧版工具放到别处时，写前会连同全部子节点整体搬回并回报 `repaired`；`repair:true` = 只修容器位置、不改子节点（修历史坏模板用）。
  写工具栏/Web 事件的工具（`set_fill_toolbar`/`add_toolbar_button`/`set_toolbar_button_js`/`set_webwrite_js`/`set_webpage_js`/工具栏图标/删/移）发现容器错位时也会先自动搬回再写。
- `get_webwrite_js` — 读 WebWriteContent 内填报 Web 事件的 JS 全文（与 `set_webwrite_js` 配套的读→改→写回闭环）；**2026-10-29 起 `event` 可省略**：不传只返回事件清单（event/className/scope/sheet/jsLength/jsBytes/jsLines/sha256，不含正文），先看有哪些事件再按需读全文；每项带 `jsBytes`(UTF-8 字节)/`jsLines`(行数)，改大块前先对账
- `set_webwrite_js` — 写 WebWriteContent 内填报 Web 事件的脚本正文
  （`<Listener event="..."><JavaScript><Parameters/><Content>js</Content></JavaScript></Listener>`，
  如 beforeimportexcel/writesuccess/afterappend 等；官方 82 例实证）；需 allowUnsafeScript=true。
  同一 event 可挂多个 Listener（真实报表常见）——传 `match`（目标 JS 特征子串）精确定位；
  按 **JS 合并约定**（同容器内同事件类型只留一个代码块）则传 `aggregate:true`：同 event 多块会按文档顺序并回一块（不丢内容），不传 js 时只合并不删除；
  **大块共享 Content（如实测 187KB 的 afterload）只改一小段必须用 `patchFind`+`patchReplace` 片段替换**（literal、默认唯一命中、块内其余原文原样保留，与 js 互斥；**已兼容设计器转义 `]A`——净文本 `]` 与落盘 `]A` 均可命中，回写保持 `]A` 编码，不会把已有 `]A` 解码写回**）；
  **整块替换把 ≥4KB 的 Content 缩到 <60% 且少 ≥2KB 会被缩水护栏直接拒绝**（2026-11-03 事故教训），确要整块重写传 `allowShrink:true`；
  2026-10-20 起写前自动把错位的 WebWriteContent 搬回 `ReportWebAttr` 并回报 `repaired`
  （事故复盘/护栏阈值/片段替换决策表见 [`docs/js-listener-safety.md`](./docs/js-listener-safety.md)）
  ⚠ 读回的 JS 里 `]A` 是 **FineReport 设计器对 `]` 的转义**（M116 实测口径），不是脏数据/不可见字符；**不要**因此整块覆盖或裸改 .cpt 去「清洗」它（2026-10-31 会话审计与缺口清单见 [`docs/session-capability-audit-2026-10-31.md`](./docs/session-capability-audit-2026-10-31.md)）
  **2026-11-03 起模型可见面补齐**：所有读 JS 工具（`get_webwrite_js`/`get_report_listener`(+batch)/`get_cell_listener`/`get_cells`/`get_cell_hyperlink`）在原文含标记时返回 `designerEscapes: { marker:']A', count, hint }`（读回原文不变，仅在 count>0 时出现）；`check_report_js` 返回 `designerMarkers: { total, blocksWithMarkers }` 并注明解析前已解码 —— 都只是元数据，不参与成败判定
- `set_webpage_js` — 写模板级 `<ReportWebAttr><WebPageContent>` 的分页预览 Web 事件 JS（官方 50 例全部 `afterload`：分页预览「加载结束」时执行）。这是分页预览 afterload 的**唯一正确落点**：`set_report_listener` 只写 Report 子级、`set_webwrite_js` 只写 WebWriteContent、`update_report_node` 整节点改写会连带覆盖同块审批人注入等 JS。同 event 多 Listener 必须传 `match` 精确定位；散块用 `aggregate:true` 合并；**只删一行（如 `console.log`）用 `patchFind`+`patchReplace` 片段替换**，同块其余 JS/审批人注入/ToolBars/WebPage 原样保留；容器缺失自动在 ReportWebAttr 内建标准骨架，自闭合展开、错位搬回（返回 `repaired`）；需 `allowUnsafeScript:true`。读侧用 `get_report_listener({event,match})` 后按 `area=webpage`/`scope=workbook` 取块（`scripting` 租约族）
- `set_toolbar_button_js` — 写 WebWriteContent → ToolBars 内自定义按钮（CustomToolBarButton）的 JS
  （如「删除记录」/「打印」/「上一页」按钮，官方 13 例实证）；用 buttonText（按钮文字，推荐）/ index / match 定位；
  **大段按钮 JS 只改一段用 `patchFind`+`patchReplace` 片段替换**（`]A` 感知、默认唯一命中、与 js 互斥、只改 Content CDATA 内文）；
  **整块写入把 ≥4KB 旧按钮 JS 缩到 <60% 且少 ≥2KB 会被缩水护栏拒绝**（确要整块重写传 `allowShrink:true`）；`expectedSha256` 写前核对；
  返回 `mode=patch/replace/delete` 与 `jsBytesBefore/jsBytesAfter/jsLinesBefore/jsLinesAfter`；
  需 allowUnsafeScript=true（2026-10-20 起写前自动把错位的 WebWriteContent 搬回 `ReportWebAttr`）
- `add_toolbar_button` — **新增**填报工具栏按钮，两种渠道：
  ① buttonText 渠道建**自定义**按钮（CustomToolBarButton，按钮本体）——补上 set_toolbar_button_js 只能写已有按钮 JS 的缺口（按钮不存在时先建再写）；
     iconName/js 可选（js 需 allowUnsafeScript=true，不传只建空按钮，之后用 set_toolbar_button_js 补）；
  ② builtin 渠道**追加一颗设计器内置按钮**（submit/verify/append-row/delete-row/import-append=导入Excel追加/import-clean=导入Excel清空后导入），
     只需 `add_toolbar_button({path, builtin:'import-append'})`，栏内已有按钮（含自定义 JS 按钮）原样保留，按 class 判重幂等（已存在返回 already-present）；
     ⚠ 区别：`set_fill_toolbar` 是**整栏重建**（只认词表内置按钮，会冲掉栏内自定义按钮及其 JS——实测 9 按钮传 2 词后 7 个自定义按钮全丢），
     "只想加一颗、别动现有按钮"必须用本工具 builtin；
  工具栏不存在时两条渠道都会自动创建完整 ToolBars 结构（2026-10-20 起：模板彻底缺 WebWriteContent 时仍报错并指路 `create_cpt(webWrite=true)` / `set_webwrite_extras({repair:true})`；容器只是错位则先自动搬回再写）
- `add_chart` — 插入图表（柱形 column / 折线 line / 饼图 pie）：给「数据集 + X 轴分类字段 + 数值字段」即可，
  骨架、配色、图例、坐标轴全部按官方样本填充（VanChart 的 Plot 子树有上百个标签，手写必错）
- `add_float_element` — 浮动文本元素（悬浮于网格之上，如大屏标语/环形图中心大字）：官方 76 例实证形态，
  位置与尺寸用毫米；浮动图片是 FR 私有编码，明确不支持

**校验**
- `validate_cpt` / `list_cpt_issues` — 结构校验（XML 合法性/样式索引越界/绑定一致性/参数引用/页面设置/填报行完整性等）。**2026-10-29 新增参数面板体检**：控件重叠、BoundsAttr 缺失/零尺寸、控件名重复、复选类控件空字典，均以 warning 带 fix 上报（官方样本存在少量刻意重叠/空复选组，故不设为 blocker 以免误杀基线）
  **2026-11-03 新增 `resetJsBaseline:true`**：JS 块基线报"块数较基线减少"但确属有意删块（或写坏块后已重做）时，用它复位**本模板**基线（只删本模板条目后按当前文件重建，返回 `baselineReset`/`baselineResetInfo`(hadBaseline/previous 旧计数/current)），不必去删 `%LOCALAPPDATA%\cpt-mcp\js-baseline\` 文件；不传时语义完全不变（丢失仍拦截）。`quality_gate_cpt` 同一开关
- `diagnose_fill_row_integrity` — 填报行完整性一键盘点（只读）：逐 sheet 逐格产出缺失清单 —— 缺 InsertPolicy=copy 的行内不一致格、数据行内静态文本格、数据行空格无控件/绑定、下拉控件缺 `<Dictionary>`、扩展父格引用悬空；给出逐格可执行的 fix 与 `suggestedFixCells` 批量修复坐标

**微型报表引擎（内置，`lib/engine/`）**
- `style_review_cpt` — 样式审查（字号/字体/对比度/共享度/越界）
- `reasonableness_review_cpt` — 合理性审查（网格/控件/参数面板匹配/填报字段/页面边界）
- `build_report`（已下沉 `generator_full` 租约族；report 档从零建表首选静态 `generate_report`）— 语义化构建报表（spec → 复用生成原语组装，生成后自带三层自检）；2026-10-20 起传 `spec.toolbar` 会自动 `webWrite=true`，避免骨架缺 `WebWriteContent` 导致工具栏写不进去。**2026-11-06 起覆盖保护默认开启**：`noOverwrite` 默认 `true`，目标已存在直接拒绝；确需重跑同一路径必须显式 `noOverwrite:false`（原子替换并留 `.bak-build-*`）。
- `generate_report` — **只给「字段列表 + 数据源」直接出成品报表**：自动完成 SQL、布局（大标题/表头/
  数据行/汇总行）、配色主题、数字格式、列宽行高、多列数据集的展开父格、斑马纹与负数标红、页眉页脚；
  效果与稳定度三层保证：**设计令牌**（rules.js 的 DESIGN_TOKENS 单一事实源）、**版式密度** options.density（compact/standard/roomy 整表联动字号行高列宽）、**列宽自适应**（中文长表头按显示宽度自动加宽）；产物由 test/golden 快照锁定（见下方 test:golden）。可选 options.meta=true 把生成参数留档到 <模板>.meta.json（复现/审计）。
  传 `chart` 还会自动配一张图表。**优先用它**，模型不必自己算坐标、建样式、推导父格。
  覆盖语义与 `build_report` 同口径（2026-11-06）：`noOverwrite` 默认 `true`，目标已存在默认拒绝覆盖，显式 `noOverwrite:false` 才覆盖。
- `regenerate_from_meta` — 从生成参数留档一键复现模板：读取 <模板>.meta.json（meta=true 生成时落盘），build_report 形态 byte 级回放、generate_report 形态回放核心参数；语义=按留档回写同名模板，故**默认覆盖**（原子替换并留 `.bak-build-*`），显式 `noOverwrite:true` 才拒绝覆盖。

引擎规则源自对设计器/引擎 jar 的合规静态提取（主题 XML、资源、类结构），详见 `docs/designer-engine-map.md`。

**定时任务（auto-runner 模式；持久化到 `.cpt-schedule.json`，进程内 `node-cron` 调度）**

> 模仿 `agent-team/core/mcp/server.py` 的 auto-runner：把"定时执行"做成 cpt-mcp 内部能力。
> 任务配置落到 `.cpt` 同目录的 `.cpt-schedule.json`（带 `.lock` 跨进程互斥），本进程立即订阅；
> 重启时自动从 JSON 重新加载并订阅。每个任务可指定 5 字段 cron + 动作（`validate` /
> `style_review` / `reasonableness_review` / `decompile`），最近 50 条
> 执行历史持久化在 store。

- `schedule_add` — 添加任务：`{ path, cron, action, actionArgs?, note? }`
- `schedule_list` — 列出 `.cpt` 全部任务（含 `tracked` / `runState` / `nextRun`）
- `schedule_get` — 单个任务详情（`history[]` + 当前 `runState`）
- `schedule_remove` — 删除任务（从 store 与订阅中同时移除）
- `schedule_enable` / `schedule_disable` — 启停（停止 cron 订阅但保留 store）
- `schedule_run_now` — 立即触发一次（`waitMs=0` 即 fire-and-forget）

**调度器 / FR 反编译探测**

- `scheduler_status` — 调度器全局：启动状态 / 活跃任务数 / PID / node 版本 / 运行时长
- `scheduler_history` — 任务最近执行历史（`limit` 截断，最长 50）
- `scheduler_stop` — 停掉本进程全部订阅（保留 store，下次启动重新加载）
- `scheduler_actions` — 列出可用动作及 `argsSchema`
- `fr_detect` — 探测本地 FineReport 设计器（`FR_HOME` 环境变量 + 默认安装路径）
- `fr_inspect` — 静态盘点本机 FR 引擎/设计器 jar、关键类、主题资源和官方样本数量，不启动 GUI
- `fr_decompile` — 调本地 FR 反编译 `.cpt` 到源码目录（仅在 `bin/cptdec` 存在时可用）
- `fr_engine_check` — 查询「真实 FR 引擎」对某 `.cpt` 的加载校验结论（只读报告，不跑引擎）。
  结论由 `npm run verify:fr -- <模板.cpt>` 生成：用本机 FR 自带 JRE 反射调用引擎的
  `CptTemplateWorkBookReader` 真正加载模板并导出重读（round-trip），**引擎能加载 = 设计器能打开**，
  这是比内置微型引擎更强的地面真值，作为交付前的最终门槛。
- `run_fr_engine_check` — **触发**真实 FR 引擎校验（等价于执行 `npm run verify:fr`，无 shell 会话也能用）：
  编译 FrEngineProbe（优先 FR 自带 ecj，无需系统 JDK）并用 FR 自带 JRE 逐份加载模板，结论写入
  `.fr-engine-check/` 供 `fr_engine_check` 复查。支持单文件 / 导出重读（roundTrip）/ 批量（batch）；
  **批量模式 `path` 可省略**（`path` 与 `batch` 至少给一个；5 份模板一次 JVM 启动校验，不必逐份调用，也不再受单文件租约 path 绑定限制，每份路径仍逐个过安全围栏）。
- `start_fr_preview` — **在本机拉起一个独立的 FR 报表实例**（2026-10-29 新增，族 `fr_preview`）：
  完全复用设计器内核（FR 自带 JRE + fine-*.jar + Tomcat 9 + webapps/webroot 决策系统 + finedb 快照），
  只监听 127.0.0.1 随机端口，可打开**真实预览页**复查样式、点检工具栏按钮/afterload JS/导出/提交。
  与 `run_fr_engine_check` 的分工：引擎校验回答「设计器能不能打开」（~10s，无渲染）；本工具回答
  「打开后长什么样、按钮能不能用」（首次冷启动 30~60s）。返回 `viewUrl`（分页预览）、`writeUrl`（填报预览）、
  `adminUrl`（平台管理，配置同名数据连接用）。**默认立即返回 status=starting**（含 PID/端口/URL），
  用 `fr_preview_status` 轮询到 running 再打开（避免 MCP 客户端 60s 超时；`wait=true` 才阻塞等）。幂等：重复调用复用活着的实例、只替换 reportlet。
  **内置参数默认 admin 伪装**（2026-10-31 新增）：实例就绪后自动用平台超管 `admin` 登录本地实例，
  预览/平台 URL 先经本地会话入口页写 Cookie 再跳转，因此 `$fine_username`/`$fine_userid`/`$fine_role`/
  `$fine_position`/`$fine_display_name` 在预览里解析为 admin；`impersonation` 字段汇报 ok/pending/failed/disabled，
  `impersonate=false` 可匿名对照。账号/口令读 `CPT_MCP_FR_PREVIEW_ADMIN_USER`/`CPT_MCP_FR_PREVIEW_ADMIN_PASSWORD`，
  只对 127.0.0.1 生效、绝不连远端 FR。
- `stop_fr_preview` — 停止预览实例（Tomcat 优雅 shutdown，25s 未退则强杀，并清理同一预览目录残留 java 进程）；
  停机后自动把实例 finedb 回写 `.fr-preview/finedb-seed/`，管理员/数据连接配置下次启动继续生效。
- `fr_preview_status` — 只读查询预览实例状态（pid/端口/健康检查/当前模板/预览 URL/内置参数伪装状态/日志尾部）；
  status=running 时返回带 admin 会话的预览 URL。
- 本地预览实例的目录布局、admin 伪装机制、首次数据连接配置、实测证据与排障见 [`docs/fr-preview.md`](./docs/fr-preview.md)。
- **数据连接安全（2026-11-09）**：预览平台库禁止继承外部生产连接；仅允许 `jdbc:sqlite`/本地 `jdbc:hsqldb`，
  发现 `jdbc:mysql`/Doris 等外部 URL 会拒绝启动。生产数据只由 MCP `local_db_import({action:"report"})`
  只读导入内置 SQLite；`start_fr_preview` 的 `localTest` 缺省 true，会自动把返回的本地 SQLite 连接写入预览
  finedb（只写 `jdbc:sqlite`），缺库/缺表直接拒绝启动；`localTest:false` 不写数据连接但仍会清空外部连接。
- `run_dataset_sql_check` — **只读实跑数据集 SQL + 列名对账**（2026-10-26 新增，M145）：
  从模板取数据集 SQL（或传候选 `sql` 先验），代入 `${参数}` 后以只读通道执行，返回行数/耗时/列名/样例行；
  并把「SQL 实际返回列」与「单元格 dsColumn 绑定的列」双向 diff —— **模板绑定了但 SQL 没返回的列会点名**
  （这类列运行时会空白/报错，是历史上靠人肉数的地方）。
  安全边界：只允许 `SELECT/WITH/SHOW/DESC/EXPLAIN` 单语句（写语句与多语句直接拒绝），强制 `multipleStatements:false`，
  缺省自动套 `LIMIT` 且行数上限 1000、默认 20s 超时（超时即 destroy 连接）；有未解析的 FR 公式参数时**默认不执行**（`force=true` 才跑）。
  需要一份只读连接配置（见下节），键名与 `.cpt` 数据集里的「数据连接名」一致（`get_datasets` 的 `connection` 字段）。

### 数据集 SQL 实跑：连接配置

`run_dataset_sql_check` 需要数据库凭据（cpt-mcp 其余能力都不需要）。凭据只放本地、不入库；按优先级：

```bash
# ① 环境变量（适合在 MCP 启动配置里注入）
CPT_DB_CONNECTIONS='{"Doris":{"host":"...","port":39030,"user":"readonly","password":"...","database":"bi_ods"}}'
# ② 用户级文件（推荐：与安装位置无关，重装/换工程都不丢）
~/.cpt-mcp/db-connections.json
# ③ 当前工作目录下的 db-connections.json（只对当前工程生效，适合不同项目连不同库）
# ④ 任意路径 JSON 文件（显式指定）
CPT_DB_CONN_FILE=/path/to/conns.json
```

文件格式（参照仓库里的 `db-connections.example.json`）：

```json
{ "Doris": { "host": "...", "port": 39030, "user": "readonly", "password": "...", "database": "bi_ods" } }
```

`CPT_DB_NAME` / `CPT_DB_HOST` / `CPT_DB_PORT` / `CPT_DB_USER` / `CPT_DB_PASSWORD` / `CPT_DB_DATABASE` 可配单连接（名字缺省 `Doris`）；
`CPT_DB_DEFAULT` 指定默认连接名；`CPT_DB_DISABLE_CONFIG_FILES=1` 可彻底关掉文件来源（排查用）。
未配置时工具报错会直接给出上述写法，不会静默失败。

### 内置 SQLite 本地测试库（2026-11-02；2026-11-04 起为测试环境默认口径）

不配任何真实库/不联网也能测数据集 SQL：cpt-mcp 内置 **`node:sqlite`**（Node 自带、零依赖），
在 `<cwd>/.cpt-mcp/localdb/` 下维护本地测试库。**本地库由 MCP 全权管理（建库/镜像 schema/按需抽样/造数/重置/快照），
外部真实数据库权限依旧只读。2026-11-04 起 `run_dataset_sql_check` 的 `target` 缺省 `local`（测试环境口径，
真实库结论须显式 `target:"real"`），并支持从真实库按需抽少量数据灌入本地库做实际验证。**

```text
① local_db_admin({ action: "create", db: "main" })                       # 建本地库
② local_db_import({ action: "auto", db: "main", connection: "Doris",     # 一条命令：镜像 schema（autoTables 递归扫表）
                    path: "<模板.cpt>" })                                # + 按需抽样（默认 ≤200 行/表、≤5000 行合计；只补空表）
③ run_dataset_sql_check({ path, offline: true })                         # 缺省 target=local：离线校验语法/列绑定
④ dataset_sql_parity({ path, datasetName })                              # 真实 vs 本地对账（真实库只读）
⑤ local_db_import({ action: "excel", db: "main", path: "<模板.cpt>",     # Excel 导入离线仿真：按钮/列位/标题/控件类型/
                     excelFile: "<样例.xlsx>", simulate: true })          # 本地目标表约束；事务试插后必然回滚
⑥ local_db_import({ action: "report", db: "main", path: "<模板.cpt>" })  # 修改已有报表：全部数据连接 + 填报目标表
                                                                         # 复制到内置 SQLite（schema + 小样本；只读真实库）
```

- 常用入口是已有的 `run_dataset_sql_check`：`target` **缺省 local** / `real`（真实库，显式）/ `both`（对账），`offline=true` 只 prepare；
  也可用 env `CPT_MCP_SQL_TARGET` 或 `<cwd>/.cpt-mcp/localdb.json` 的 `settings.sqlTestTarget` 切默认（`real` 可回到旧行为）；
- 6 个本地库工具在 **`local_db` 租约族**（`request_deep_tool_access({path, group:"local_db"})` 解锁，40 次/1 小时）；
- **修改已有报表**先跑 `local_db_import({action:"report", db:"main", path})`：自动扫描该 .cpt 的**全部数据集连接 + 填报提交目标表**
  （列映射 table / 自由 SQL 的 UPDATE/INSERT/DELETE），有只读真实连接时镜像 schema + 小样本到内置 SQLite；本地已有表复用。
  返回 `runtime.status=unverified`：SQLite 只证明数据/结构/SQL，填报工具栏、Web 事件、真实提交仍必须 `start_fr_preview` 实点；未点检不得写「运行期已验证」；
- **SQLite 写审计（2026-11-11）**：`local_db_import({action:"report", ..., writeAudit:true})` 会在本地填报目标表安装
  `AFTER INSERT/UPDATE/DELETE` 触发器并返回 `writeAudit.runId`；打开预览提交后调
  `local_db_admin({action:"write_audit", db, runId})` 可看总写入事件、INSERT/UPDATE/DELETE 行数、涉及表、before/after 行数、
  首次/末次写入时间，以及目标表有 `fill_type`/`source_sheet` 时的按 sheet 来源分组。
  `start_fr_preview` 也会把检测到的 active `writeAudit.runs` 直接带回，不用回翻上一步响应找 runId。
  默认关闭；可在 `<cwd>/.cpt-mcp/localdb.json` 持久开启：

  ```json
  {
    "settings": {
      "writeAudit": {
        "enabled": true,
        "capture": "counts",
        "installTriggers": true,
        "maxEvents": 5000,
        "retainRuns": 20,
        "simulateMaxRows": 5000
      }
    }
  }
  ```

  env 覆盖：`CPT_MCP_WRITE_AUDIT=1`、`CPT_MCP_WRITE_AUDIT_CAPTURE=counts|keys`、
  `CPT_MCP_WRITE_AUDIT_MAX_EVENTS`、`CPT_MCP_WRITE_AUDIT_RETAIN`、`CPT_MCP_SIMULATE_MAX_ROWS`。只装本地 SQLite，不触碰真实库；默认只记计数/时间，不保存业务值。

- **填报试写（不落库）**：`local_db_admin({action:"simulate_fill", db, path, scenario})` 在本地 SQLite
  事务内按模板提交顺序模拟列映射提交，返回每 sheet 的 insert/update/unchanged/skipped 行数、写事件数、
  重复写 key（`staleKeys`）和可能被旧行覆盖的 key；最后无条件 `ROLLBACK`，本地数据不变。
  `scenario` 形如 `{"sheet1":[{"id":1,"v":"new"}], "sheet2":[{"id":1,"v":"old"}]}`；
  `submitMode:"single-sheet"` 可只模拟一个 sheet，`repeat` 可测重复提交。自由 SQL 提交不模拟，只给
  `FREE_SQL_NOT_SIMULATED` 提示。`get_local_db_status` 现在同时返回 `settings`（读侧抽样配置）和
  `writeAudit`（写审计/试写上限），agent 不用再猜当前配置。
- **跨 sheet 提交拓扑**：`get_fill_config({path, view:"matrix"})` 会检查多个 sheet 是否提交到同一目标表、主键是否相同、
  是否缺 `fill_type`/`source_sheet` 判别字段；`validate_cpt` / `quality_gate_cpt` 给 `FILL_SHARED_TARGET` 告警
  （默认 warning，不阻断存量模板）。典型的“两个相似 sheet 指向同一张表，提交一个 sheet 把另一个旧行也 upsert”场景会在这里暴露。
- `quality_gate_cpt` 默认开启本地 SQL 审计（`localSqlAudit:false` 可关）：**SQL 语法错 / SQL 少返回绑定列 → blocker**；
  本地库缺表/方言缺口只进 advisories，不阻断交付；本地库没建时给 info advisory + 建库引导（不再静默跳过）；
  `localSqlAuditStatus` 带 `datasets/datasetsChecked`（缺表/缺库不算已覆盖）；含 Excel 导入按钮时给
  `excel_import_not_pretested` info advisory（nextAction 指向 `local_db_import({action:"excel"})`，不改 pass）；
  advisories 明细被 30 条上限截断时该 advisory 会提到明细首位，且顶层另有 `excelImport` 精简摘要（P2-4）；
- **门禁摘要 + 结论缓存（2026-11-12 P0-2）**：`validate_cpt` / `quality_gate_cpt` / `verify_cpt` 支持
  `brief:true`（**部署侧 `CPT_MCP_GATE_BRIEF=1` 可设默认**）：只回"结论 + 前 5 条明细（保留 location/message/fix）
  + 全量计数"，把 v1 会话里单次 15~29KB 的门禁输出压到 ≈1.5KB；要完整明细传 `brief:false`。
  同文件同参数重复调用直接复用上次结论（`cached:true` + `cachedAgeSeconds`），TTL 默认 10 分钟；
  失效判据 = 模板内容 sha256 + 引擎报告文件状态 + 本地 SQLite 库文件状态（写入/跑引擎/建库后自动重算，
  只重跑门禁不会拿到过期结论）。实现见 `lib/gate-brief.js` / `lib/gate-cache.js`，回归见
  `test/gate-brief-cache.test.js`；
- `verify_cpt` 默认带 `local_sql` 层（`CPT_MCP_VERIFY_LOCAL_SQL=0` 可关）：本地库未建 → skipped + nextAction
  （不假 pass、不阻断）；本地库就绪 → pass/warn/fail + blocker 带 fix；写工具 selfCheck 仍不带该层；
  参数占位/方言类提示不把整体状态降成 warn（缺表/缺列/绑定类才升级）；`facts` 能识别内置导入按钮；
- `local_db_import` 的连接回退 notice（只配一个连接时）在 schema/data/auto 成功 warnings 与
  **早退错误文本**里都会出现（P2-5，避免连接名写错却查了回退库）
- 抽样默认每表 200 行、合计 5000 行（`settings.sampleRows/maxTotal` 可调），只补空表、不覆盖本地造数；敏感列名只点名、不回显值；
- Excel 导入仿真覆盖「普通 Excel 导入=位置样式匹配 1:1」，不执行 before/afterimportexcel 前端 JS，离线通过 ≠ FR 页面行为通过；
- 方言兼容、已知差异（DECIMAL 精度/时区/collation/方言缺口）、安全模型与排错见 [`docs/local-sqlite.md`](./docs/local-sqlite.md)
  与 [`docs/excel-import.md`](./docs/excel-import.md)；
- 版本要求 Node >= 22.13（`node:sqlite`）；本地二进制 `.sqlite` 与抽样数据在 `.gitignore`（`.cpt-mcp/`），
  导出可提交的 SQL 用 `local_db_admin({action:"export"})`。`localDbGuide` 会在缺库报错里直接给出建库步骤。

### 源码热重启（2026-11-07，开发期）

改 cpt-mcp 自己的代码（`server.js` 或 `lib/**/*.js`）后**不用重启整个 DSH**：进程检测到源码变化会自行退出，
DSH 的 mcp-client（`@deepseek-ai/dsh-mcp-client`）按默认重连策略（`initialDelayMs=500`、`maxAttempts=10`）
自动拉起**同一个 command** 的新进程，新进程加载新代码。

- **默认启用**；`CPT_MCP_HOT_RELOAD=0` 关闭（老版本/缩容/排查启动问题时用）。
- 行为：每 1000ms 轮询「包根 `server.js` + `lib/**/*.js`」的 size+mtime；命中变化后等 **2000ms 静默期**
  （期间再改就顺延），并且启动后先给 **3000ms 宽限期**，避免 pre-push 同步到一半时连环重启。
- **首次**让 watcher 生效仍需重启一次 DSH（旧进程还没装 watcher）；之后改源码即自动生效。
- 更新瞬间**正在执行的工具调用可能失败一次**（连接被断开），重试即可；已提交的写操作不会丢。
- 手动触发（不改文件、只重启进程）：在 **cpt-mcp 所在目录** 放 `cwd` 下的 `.cpt-mcp/hot-reload.request`
  （即 `<cwd>/.cpt-mcp/hot-reload.request`），watch 到后重启并自动删除 marker（不会循环）。
- 只在 `server.js` 里安装；`server-full/focused/generate.js` 都是 `import './server.js'`，同样生效。
- 实现与测试：`lib/hot-reload.js`、`test/hot-reload.test.js`；细节见 [`docs/hot-reload.md`](./docs/hot-reload.md)。

### 自包含（Standalone）：与宿主预设解耦（2026-10-26）

cpt-mcp 的业务规则**全部写在它自己的 server instructions 里**（约 17.7 KB，DSH 上限 32,768 B），
由 MCP 客户端注入系统提示：工具地图 + 租约协议 + 交付门槛 + 安全边界 + 常见坑 + **宿主能力降级路径**
+ 重复劳动策略 + 交付汇报模板。因此它**不依赖任何宿主预设的 persona / instructions / 会话历史**：
在报表模式、普通编码模式、PTC 模式、极简模式下，cpt-mcp 的行为与交付标准一致。

- 默认档位就是业务完整面（`report`，33 项），**不需要宿主再传 `CPT_MCP_TOOL_PROFILE`**；
- 外部能力（官方文档 / 数据库 / 浏览器预览 / git 落库 / Excel / 真引擎 / PTC）**都是可选的**：
  缺哪个就按 instructions「八、宿主可选能力与降级」降级，并在汇报里写「未验证」，绝不假装成功；
- 版本控制不再是依赖：宿主有 git 工具就按流程落库，没有就交付里标注「未落库」；
- 冲突时优先级：**交付门槛与安全边界以 cpt-mcp 的 instructions 为准**（`deliveryPass`、不手工改 XML、路径白名单）。

验证组合（本机用户预设，均可随时删除）：

| 预设目录 | 组成 | 用途 |
|---|---|---|
| `~/.dsh/.agent-presets/cpt-only/` | 普通编码 agent + cpt-mcp（**无**报表 persona/业务契约） | 验证「业务规则确实来自 cpt-mcp 自身」 |
| `~/.dsh/.agent-presets/report-ptc/` | 报表模式 + `tool-presentation: both` | PTC A/B 对照 |

### MCP 自主核验（2026-10-26）

目标：**写完就验**，不靠模型记得再调三个校验工具。两层：

1. **写工具自带 selfCheck**（默认开；`CPT_MCP_AUTO_VERIFY=off|structure|engine`）：
   每次写成功后，cpt-mcp 自己跑「结构校验 + 交付门禁」，把结论挂进返回体
   `selfCheck: { status, layers, blockers, facts, nextAction }`（`structuredContent` 同步带）。
   `status=fail` 时额外追加一条醒目文本，避免模型只看第一段就宣布完成。
2. **`verify_cpt` 一次跑全层**（注解为写——只写引擎报告不改模板正文；report/focused 档静态可见，engine 默认开、无需租约）：

   | 层 | 内容 |
   | --- | --- |
   | structure | `validate_cpt`（XML/引用完整性/事件唯一性…）|
   | gate | `quality_gate_cpt`（blockers/warnings）|
   | local_sql | **本地 SQLite 离线审计**（`verify_cpt` 默认开，env `CPT_MCP_VERIFY_LOCAL_SQL=0` 可关；本地库就绪→pass/warn/fail，未建→skipped + `localSqlAuditStatus` + nextAction，不假 pass）|
   | excel_import | **Excel 导入预检提示**：普通导入→`local_db_import({action:"excel"})`；标记/自定义导入（`ImportExcelData` 等）明确"离线不覆盖，必须 FR 预览"|
   | expectations | **期望值对账**：`cells/styles/toolbarButtons/builtinToolbarButtons/submits/fillBindings/datasets/sheets/bytesMin/bytesMax/hasText/notHasText/toolbarButtonTexts` —— "我要的改动真的落地了吗" |
   | engine | 真实 FR 引擎加载（`engine:false` 跳过；需本机装 FineReport，5~15s 有缓存）|

   返回 `{ ok, status, layers[], blockers[{location,message,fix}], facts, localSqlAuditStatus, excelImport, nextAction }`；
   `expectations` 不符即 blocker（带「期望 X，实际 Y」），例如：

   ```json
   { "verify_cpt": { "path": "a.cpt", "engine": true,
       "expectations": { "toolbarButtons": 2, "hasText": ["批量导入"] } } }
   ```

### PTC / code-mode 友好度（2026-10-26，配合 DSH PTC 模式）

DSH 的 **PTC（Programmatic Tool Calling）** 模式让模型写一段 TypeScript，在一次 `run_code` 里组合多个工具调用
（`tools["mcp__cpt-mcp__add_parameter_widget_batch"]({...})`），中间结果不进上下文——正是 v1 会话里
「同一工具重复 30+ 次」这类工作的解药。cpt-mcp 侧为此做了三项配套：

- **批量工具进 report 档**（一次调用替代 N 次）：`add_parameter_widget_batch` /
  `update_parameter_widget_batch`。两者都是「逐项执行 + per-item results」，
  单条失败记 `failed` 不中断，程序里按 `results` 补偿即可（非原子，需自行回读/回滚）。
  `add_cell_highlight_batch` 属非原子批量便利工具，2026-11-12 P0-1 起默认隐藏（`group:'adhoc'` 按名临租，能力仍可达）。
- **所有结果带 `structuredContent`**：对象结果直接是对象；数组结果包成 `{ items: [...] }`（MCP 要求 object）。
  PTC 程序里可直接 `const { items } = await tools[...]()`，不必再 `JSON.parse(content[0].text)`；文本分支保持原样。
- **内置配方**：`get_capabilities({ section: "ptc.recipes" })` 返回可直接照抄的 4 个模板
  （批量参数控件 / 批量高亮 / 批量 SQL 校验 / 改完一次过门禁）与限制说明。

启用方式（DSH 侧，preset 级）：

```yaml
- id: tool-presentation
  name: '@deepseek-ai/dsh-agent-tool-presentation'
  config:
    mode: both   # both=原生工具+run_code（过渡最稳）；ptc=只给 run_code+SDK
```

本机已生成一份用户预设 `~/.dsh/.agent-presets/report-ptc/`（报表模式 + `mode: both`，可随时删除）。
PTC 不能绕过 cpt-mcp 的租约：深层工具（`set_report_js` / `run_fr_engine_check` / 批量高亮之外的交互工具）
未解锁时不在 SDK，需先 `request_deep_tool_access` 再跑程序。

## 模块分层与单一事实源（2026-10-29 整理）

依赖方向固定为 **leaf（零 lib 依赖）→ 核心读写 → 领域模块 → server 装配层**；`scripts/verify-mcp.mjs` 与 `test/cohesion-invariants.test.js` 把关键同源关系锁成门禁。

| 层 | 模块 | 职责（单一事实源） |
|---|---|---|
| leaf | `lib/format.js` | XML 转义 + 公式对象 XML（消掉 edits↔chart 静态循环） |
| leaf | `lib/parsed-shape.js` | parsed 树取用口径：`asArray`/`asReports`/`cdataOf`/`unescapeXml` |
| leaf | `lib/path-util.js` | 路径归一（租约/选择集/JS 基线/读取门禁同口径） |
| leaf | `lib/write-hooks.js` | 写盘后钩子注册表（js-baseline 订阅，消掉 xml↔js-baseline↔cpt 循环） |
| leaf | `lib/tool-guards.js` | 工具级安全围栏声明式表（server 包装层一行 `runToolGuards`） |
| 核心 | `lib/xml.js` · `lib/cpt.js` · `lib/edits.js` · `lib/generate.js` | 读 / 写 / 生成 |
| 领域 | `lib/engine/*` · `lib/validate.js` · `lib/quality.js` · `lib/batch.js` · `lib/cell-batch.js` | 校验、审查、批量、租约 |
| 装配 | `server.js` | 工具注册 / 参数契约 / 租约接线；静态名单来自 `lib/contract.js`（report）、`lib/light-schemas.js`（轻 entry）、`lib/lease-groups.js`（场景族） |

- 写工具边界提示（`【边界·S6】`）的工具清单由 contract 的三类写集合**派生**，不再手写第二份。
- 颜色/尺寸换算（`argbToHex`/`hexToArgb`/`mmToUnit`/`unitToMm`）只在 `lib/engine/rules.js` 实现。
- 同源不变量：四档注册表 ↔ 分类集合一一对应（写集合两两不相交、并集 = 非只读）；租约族成员 / 轻 entry / report 静态表 / 注册表互相包含；轻 entry 广告字段必须 ⊆ 处理器完整 schema（server 启动即自检，防"广告了却被 strict 拒绝"的幽灵参数）。

## 安全与覆盖边界

- MCP 默认只允许当前项目目录和系统临时目录；`.git` / `node_modules` 永远拒绝访问。设置 `CPT_MCP_ALLOWED_ROOTS` 后以显式列表为准。
- FineReport 安装目录只读：`fr_detect` / `fr_inspect` 可盘点，不能被写入；`fr_decompile` / `fr_engine_check` 只允许把安装目录作为只读输入。
- 真实引擎校验的 JVM 进程由 `run_fr_engine_check`（MCP 工具）或 `npm run verify:fr`（命令行）发起；
  `run_fr_engine_check` 仅对指定 .cpt 运行预置脚本（数组参数、无 shell、env 白名单、320s 超时），
  不会执行任意命令；FR 安装目录仍只读（输入可读、报告重定向到允许目录）。
- 本地预览实例（`start_fr_preview`）同样遵守 FR 安装目录只读：只 junction 引用 jar/资源，conf/logs/temp/webapps/finedb
  全部落在 `<repo>/.fr-preview/`（已 gitignore）；只监听 `127.0.0.1` 随机端口，源 .cpt 复制进实例 reportlets、
  不改源文件；`stop_fr_preview` 记录 pid 走 Tomcat 优雅关闭，25s 未退才强杀。
  **设计器升级后**：jars 是 junction 会立即指向新版，但已运行实例仍加载旧类、`config/finedb` 是启动时复制快照，
  必须 `stop_fr_preview` 后重新 `start_fr_preview`；完整同步/回滚/验证步骤见 [`docs/fr-preview.md`](./docs/fr-preview.md) §9。
- 外部 URL 只允许 `http/https`；可执行 JavaScript 默认拒绝，必须逐次传 `allowUnsafeScript=true`，或显式设置 `CPT_MCP_ALLOW_UNSAFE_SCRIPT=1`。
- `build_report` 的 spec 和嵌套对象均为 strict schema，未知字段直接报错；构建先写同目录临时文件，三层检查完成后再原子替换旧模板，并留下可恢复的 `.bak-build-*`。**默认不覆盖已存在目标**（`noOverwrite` 默认 true）；`generate_report` 同口径；`regenerate_from_meta` 例外——按留档回写同名模板，**默认覆盖**（显式 `noOverwrite:true` 才拒绝）。
- **参数容错（2026-10-26）**：MCP SDK 会在调用处理器**之前**用 inputSchema 严格校验，模型"按语义直觉"写参数（`text` / `condition` / `title` / `width` / `marginTop` / `invisible` / `valueField`…）过去会被 `-32602 Unrecognized key` 直接拒掉，且不告诉它正确字段名（v1 会话 27 次硬失败里 17 次属此类）。现在的分层是：
  1. SDK 侧 schema 只做**文档 + 类型提示**（必填与嵌套严格性下移，别名目标字段放行）；
  2. 处理器入口先做**别名归一**（`text|label|name→buttonText`、`condition→formula`、`wholeRow→scope`、`title→label`、`width→widthMm`、`sum→summary`、`marginTop→marginTopMm`、`invisible→visible`（update）或 `hidden`（add）、`valueField/textField→kiName/viName`、`dictionary.items→items`、`align:"center"→0`…），成功时在返回体尾部回一条 `[参数已自动纠正]`；
  3. 归一后再用完整 strict schema 校验，**报错附「该处可用字段 / 可用取值」**（`Unrecognized key: "x"（该处可用字段：a, b, c）`）。
  真正无法纠正的未知键仍然报错（不静默丢弃），只是错误信息变成一次往返就能改对。
- 运行时能力清单优先调用 `get_capabilities`；已验证能力和明确不支持项也可见于 [`lib/capabilities.js`](./lib/capabilities.js)。详细策略见 [`docs/security-and-coverage.md`](./docs/security-and-coverage.md)。
- 版本控制是宿主可选能力（cpt-mcp 不提供 git 工具）：宿主有 `git_status` / `git_commit` 之类**本地** git 工具就按「改前看工作区 → 过 `quality_gate_cpt` → **仅本地提交**」走；**不上传云端、不建远端**，`sandbox*` 历史数据只留在本地仓库；没有 git 就在交付里标注「未落库」；`.bak-build-*`/`.bak-batch` 只是崩溃兜底不是版本，报表模式接管的目录可设 `CPT_MCP_NO_BAK=1` 停建。

## 开发

```bash
npm install
npm test        # 800 项测试（生成链路/MCP 协议层/真实样本回归/浮动元素/引擎报告/安全加固/引用完整性/质量门槛；单测自带 hermetic 前置，不受外部 CPT_MCP_ALLOWED_ROOTS 影响）
npm run review  # 官方 reportlets 全样本回归（样式审查/合理性审查，可用 --limit/--dir 抽样）
npm run review:gate  # 质量门槛 · 官方样本地面真值回归（全量 1550 样本基线 100% pass；
                     # 任何 blocker/异常都是门槛规则回归——先人工确认样本再修正规则，勿加白名单）
npm run test:golden      # 生成产物快照回归（同 spec 必须产出 byte 级一致的 XML；输出漂移即刻显形）
npm run test:golden:update  # 有意的样式/布局变更后重新固化基线（commit 说明须写明原因）
npm run test:behavior    # 完整行为回归：8 场景（S0–S5/S7/S8，S6 为预留编号）27 断言走真实 MCP 协议（profile/填报/多sheet/大屏/树形/Excel/定时/围栏负例）
npm run test:acceptance  # 验收测试：3 画像场景（填报/多sheet/大屏）× 14 断言
npm run verify:mcp  # MCP 协议层端到端验证（208 工具注解全量比对 + 引擎工具调用；verify:mpc 为旧别名）
npm run verify:fr   # 用真实 FR 引擎加载 + 导出重读校验 .cpt（结论落盘 .fr-engine-check/）；
                    # --batch a.cpt b.cpt ... 一次 JVM 启动批量校验多个模板
node scripts/fr-preview.mjs start <cpt> --json  # 本地独立 FR 预览实例（start|stop|status，详见 docs/fr-preview.md）
node scripts/demo-generate.js # 生成 demo/示例填报模板.cpt（可用设计器打开验证）
```

## 默认 spec 模板（`build_report` 复用基线）

`build_report` 工具的 spec 入参支持直接 spread 一个默认配置，避免每次重复定义页面/网格/样式。模板与说明见：

- 默认 spec：[`docs/base-spec/cpt-mcp-default-spec.json`](./docs/base-spec/cpt-mcp-default-spec.json)（1.0.0，反推自 `sandbox2/新品表.cpt`）
- 使用说明：[`docs/base-spec/README.md`](./docs/base-spec/README.md)（含覆盖规则、3 个组合示例、样式索引速查、维护规则）
- **QA 工作流**：[`docs/qa-workflow.md`](./docs/qa-workflow.md)（有序构建规程 + 构建者/审查者 subagent 流水线 + 薄弱模型 profile 纪律）

加载时**必须**过滤 `_comment` / `_source` / `_schemaRef` 等下划线开头的元字段，spread 后只追加业务字段（`title` / `datasets` / `cells` / `fill` / `parameters` / `parameterWidgets`）。

## 单位约定

- 长度：`1mm = 144000` 单位（行高/列宽/纸张/边距通用）
- 颜色：API 使用 `#RRGGBB`，内部转 ARGB 十进制写入 XML
- 单元格坐标：`column`/`row` 均从 0 起

## 工具集速查（最新引擎版）

### 写入流（按推荐顺序）
| 步骤 | 工具 | 关键点 |
|---|---|---|
| 1 | `create_cpt` | 骨架（拒绝覆盖已有） |
| 2 | `add_dataset` | connection/sql 必填；name 命名合法 |
| 3 | `add_style` | 默认 14pt；表头/标题可传 18；可下划线/删除线/垂直对齐/边框 |
| 4 | `add_cell` | 必先建样式；同坐标重复抛错；`sheet` 支持多工作表 |
| 5 | `add_fill_submit` | `sheet` 支持；submitIndex 全文档连续 |
| 6 | `add_fill_binding` / `update_fill_binding` | submitIndex 全文档；`column`/`row` + `field` |
| 7 | `set_grid` | 1mm=144000；空数组抛错；`updateDefault` 可同步 defaultValue |
| 8 | `set_report_settings` | 多次调用互不踩（沿用原值）；mm 输入；不传保留模板原值 |
| 9 | `set_parameter_panel` + `add_parameter_widget` | 控件名与参数同名自动绑定 |

### 读取流
| 工具 | 用途 |
|---|---|
| `read_cpt` | 概览（xmlVersion/sheets/datasets/parameters/cells/fillSubmits/theme/jsBlocks）；jsBlocks 读回主题 + TopJS/报表 Listener/Web 事件/工具栏按钮/单元格监听器 的存在性计数（M72：JS/主题/工具栏写入后不再是黑盒）|
| `get_datasets` / `get_parameters` | 数据集/参数列表 |
| `get_cells` | 按列/行/控件过滤；返回 sheet/sheetIndex；contentObjectType 兼容控件值内 <O t="DSColumn">（set_cell_content_type 改造控件格后可读回）；listeners 读回单元格级事件 JS |
| `get_styles`（已并入读门禁 view=styles）| 样式列表（含 horizontalAlignment/underline/strikethrough/border） |
| `get_grid` | 行高列宽（defaultValue + CDATA 明细 + mm）|
| `get_page_settings`（已并入读门禁 view=page）| 纸张/边距/居中/缩放/页眉页脚 |
| `get_parameter_panel` | 参数面板控件 |
| `get_fill_config` | SubmitVisitor + ColumnConfig |
| `get_cell_style`（已并入 `get_cells({includeStyle:true})`）| 单格样式（含 border）|
| `validate_cpt` / `list_cpt_issues` | 结构校验（跨工作表）|
| `diagnose_fill_row_integrity` | 填报行完整性盘点（缺 copy/缺字典/悬空父格）|
| `style_review_cpt` | 样式审查（字号/字体/对比/共享/越界）|
| `reasonableness_review_cpt` | 合理性（网格/控件/参数面板/填报）|
| `build_report` | 一次构建完整报表（含三层自检 checkResult）|

### 多工作表（多 sheet）
- `add_sheet` 新建
- `add_cell`/`add_fill_submit`/`add_fill_binding`/`update_cell*` 等用 `sheet`（索引 0 起或名称）
- `add_fill_submit` 三分支全部 sheet-aware
- `add_fill_binding`/`update_fill_binding` submitIndex **全文档连续编号**（不感知 sheet）—— 模型可先 `get_fill_config` 查 sheet 对应 submitIndex

### 重要规则
- **不传 fontSizePt 时**：`add_style` 默认 **14pt**（与沙盘2 成品数据行一致）
- **不传 horizontalAlignment 时**：`add_style` 默认 0=居中（与沙盘2 成品实测一致）
- **不传 set_report_settings 任意字段时**：保留模板原值（不踩前次设置）
- **CDATA 内容**：含 `]]>` 会被拒；SQL/CDATA 字面量区不需 XML escape
- **JSDOC 标记**：所有写入 `assertSafeCdata` 已校验 `]]>`
- **填报容器归属（2026-10-20 P0 修复）**：模板级 `WebWriteContent` 必须位于 WorkBook 级 `<ReportWebAttr>` 内（FR 填报预览只读这里）；放到 `<Report>` 等其它容器里会“按钮不显示、填报事件不执行”，设计器保存还可能丢节点。
  - 缺容器 → `set_webwrite_extras` 自动在 `ReportWebAttr` 内创建；错位 → 写工具会先自动搬回并回报 `repaired`；
  - 历史坏模板修复：`set_webwrite_extras({path, repair:true})`；`validate_cpt` 会对错位/自嵌套报 error（修复后消失）；
  - `build_report` 传 `toolbar` 时自动 `webWrite=true`。



## License

ISC License. See [`LICENSE`](./LICENSE).
