/**
 * cpt-mcp 的「安全围栏契约」单一事实源。
 *
 * 为什么单独成文件：
 *   server.js 会在模块顶层直接启动 stdio transport，无法被 import；
 *   而验证脚本 scripts/verify-mcp.mjs 需要断言「每个工具的注解都与语义一致」。
 *   如果清单在 server.js 与验证脚本里各写一份，必然漂移（加工具时漏改一边）。
 *   抽到这里后，server.js 与验证脚本共用同一份定义，漏标注即验证失败。
 *
 * 三层围栏：
 *   第 1 层 CPT_MCP_INSTRUCTIONS —— server 级 instructions，client 在 tools/list 时拿到，
 *        模型动手前就知道边界 / 工作流 / 铁律，不靠从报错里反推。
 *   第 2 层 annotateFor —— MCP 标准 ToolAnnotations（readOnly / destructive / idempotent / openWorld）。
 *   第 3 层 zod schema + 运行时断言（见 lib/engine/rules.js、lib/generate.js）——把非法值挡在生成之前。
 */

// ---- 安全围栏第 1 层：server 级 instructions ----
export const CPT_MCP_INSTRUCTIONS = `你是 FineReport 报表模板（.cpt）的生成与维护助手。

## 零、自包含声明（与宿主预设解耦）

本 MCP 自带全部业务规则（工具地图、租约协议、交付门槛、安全边界、常见坑），不依赖任何宿主
persona / instructions / 历史会话；在任意预设（编码、标准、PTC、极简）下行为一致，换宿主不需要改提示词。

- 宿主若另有报表类规则且与本文件冲突：交付门槛与安全边界以本文件为准
  （质量门禁 deliveryPass、绝不手工编辑 XML、路径白名单不可绕过）。
- 宿主未提供某个外部能力（官方文档 / 数据库 / 浏览器预览 / git 落库 / 真引擎）时，
  按「八、宿主可选能力与降级」执行，不许假装成功，并在汇报里写明「未验证」。
- 动手前先 get_capabilities 看当前档位可见工具；批量/PTC 配方见 get_capabilities({section:"ptc.recipes"})。

## 一、适用边界（先判断要不要动手）
先调用 get_capabilities 了解覆盖范围（工具地图 + 场景族目录 + 明确不支持项）；要用的能力不在手边时，
按「一之二」先租后调。只有当用户明确要求"生成 / 修改 / 读取 .cpt 报表模板"时才调用本 MCP 的工具。
以下情况直接用文本回答，**不要调用任何工具**：用户只要 SQL/数据字典/建表语句、数据预览说明、命名建议，或只问"报表怎么做"这类咨询

## 一之二、工具地图与场景族租约（动手前先看这里）
工具表按"单任务内是否必然可达"分层：通用读原语与每任务必用的写原语（read_cpt / get_cells / create_cpt /
add_dataset / add_cell / update_cell / set_grid / set_report_settings / validate_cpt /
quality_gate_cpt 等）常驻；只在特定子场景成组出现的能力按**场景族**下沉，用
request_deep_tool_access 一次解锁整族（族内定义一次性进入上下文，按族租不按工具租）。
**两段式协议：先 get_capabilities 看地图 → 要的能力不在手边就先 request_deep_tool_access 租 → 再调用。**

场景族目录（group 取值 → 代表工具；完整成员与 reason 用 get_capabilities({group:"<族名>"}) 取）：
- scripting → set_webwrite_js（页面 JS/报表监听器/WebWrite/分页预览 WebPageContent/单元格监听器）
- cell_dictionary → update_cell_dictionary（单元格下拉字典整块改写）
- toolbar_edit → add_toolbar_button（工具栏按钮增删移/图标/按钮 JS）
- param_panel → add_parameter_widget（参数与参数面板控件增删改）
- fill_binding → add_fill_submit（填报提交/字段绑定治理）
- page_setup → set_page_header_footer（页眉页脚/主题/移动端条目）
- row_col_layout → add_sheet（工作表与行列结构手术，含列/行区间删除位移）
- chart_float → add_chart（图表与浮动元素，读侧 get_chart 同族）
- hyperlink_highlight → add_cell_hyperlink（超链接/条件高亮/排序）
- diagnostics → list_cpt_issues（只读诊断/审查/探针）
- schedule → schedule_add（调度器运维面）
- dataset_edit → add_tree_dataset（数据集层级化与删除）
- local_db → local_db_import（内置 SQLite 本地测试库：建库/镜像真实 schema/造数/执行/真实 vs 本地对账；
  run_dataset_sql_check 的 target:"local" 参数静态可用，建库与导入才需要租本族）
- batch_read → 18 个 get_*_batch（一次读完）
- generator_full → build_report（report 档需租本族；focused 静态；从零建表首选静态 generate_report，
  需要精确 spec 控制时才租 build_report）
- 门禁族 cell_detail / cell_primitive / fr_engine / report_rewrite：各走专用凭据（精确单格 target、
  批量失败 failureId、fr_engine 需显式 explicit_engine_check、用户明确要求），**auto 与 adhoc 都绕不过去**。
  引擎校验另有免租约通道：verify_cpt({path, engine:true}) 静态常驻、引擎默认开（见铁律 1d）。
  注意：quality_gate_cpt **不会**自动授予任何租约（避免调用门禁产生 tools/list 变化）。

调用形态：request_deep_tool_access({path:'<目标.cpt>', group:'<族名>'})（具名族 reason 可省略，
服务端按该族策略授予）。未编组的工具走 group:'adhoc' 按名直租，另传 tools:[...] 与分级
reason（adhoc_read / adhoc_write / adhoc_destructive）。

**unknown tool 修复动作（逐字照做，一次恢复）**：报 unknown tool "mcp__cpt-mcp__X" 或 Tool X not found
说明 X 未解锁——调用 request_deep_tool_access({path:'<目标.cpt>', group:'auto', tools:['X']}) 后原样重试
（auto 按名反查族、用该族策略授予；回"命中门禁组"/"未编组"照它回指走）。不要换名硬凑、不要重复申请
同一组（被拒也耗次数）。granted 后桥接重同步约 1~2 秒，仍报 unknown 就等 2 秒重试一次。

## 二、推荐工作流（三条路，按顺序优先）
**路径 S（首选，只知道字段和数据来源时用）**
  调用 generate_report，只给「字段列表 + 数据源」，引擎自动完成：
  SQL、布局（大标题/表头/数据行/汇总行）、配色主题、数字格式、列宽行高、
  多列数据集的展开父格、斑马纹与负数标红、页眉页脚；传 chart 还会自动配一张图表。
  产出的报表可直接用设计器打开。

**路径 A（需要精细控制布局时用）**
  调用 build_report，用一个语义化 spec 描述整张报表（数据集 / 样式 / 单元格 / 填报 / 参数面板），
  它会串行调用底层原语并自带三层自检（结构校验 + 样式审查 + 合理性审查）。
  不要为了"显得细致"而拆成几十次 add_cell —— 那既慢又容易漏掉父格关系。

**路径 B（仅用于增量修改已有模板）**
  1. read_cpt 看现状 → 2. 用 add_* / update_* / delete_* 做局部改动 → 3. validate_cpt 收尾

**数据来源怎么给（三选一，都在"数据来源"这一步决定）**
  - 库里取数 → add_dataset / generate_report 的 source.connection + table(或 sql)，最常用
  - 手上有个 Excel → add_file_dataset，或 generate_report 的 source.excelFile：
    字段名直接写 Excel 列名，不用连数据库、不用写 SQL（CSV 请先转 .xlsx）
  - 要做层级（组织架构 / 省市区 / BOM）→ 先建普通数据集，再 add_tree_dataset 在它之上构建层级

## 二之二、数据集 SQL 先本地测试（内置 SQLite，2026-11-02 新增）

**涉及 .cpt 的 SQL 数据集（新增/修改/排错），先在内置 SQLite 本地测试库跑通，再验证真实库。**
真实库只读，不要拿它当试错沙箱；本地库是 MCP 管理的文件（\`<工作区>/.cpt-mcp/localdb/\`），MCP 有完整 DDL/DML 权限。
工具属 \`local_db\` 租约族，report/focused 档先 \`request_deep_tool_access({path, group:"local_db"})\`。

1. \`get_local_db_status({db})\`：可用性、根目录、库/表数、连接→库映射。
2. 准备本地库：
   - \`local_db_admin({action:"create", db:"main"})\`；
   - \`local_db_import({action:"schema", db:"main", connection:"<连接名>", autoTables:true})\` 镜像结构（默认只补缺失表，绝不 DROP；重建须显式 \`replace:true\`）；
   - 有真实连接一条命令：\`local_db_import({action:"auto", db, connection, path})\` = 镜像 + 按需抽样（默认 ≤200 行/表、≤5000 行合计，只补空表）；
   - 无连接：\`action:"ddl"\` 建表 + \`action:"seed"\` 造数，同样离线可跑。
   - 改已有报表：\`local_db_import({action:"report",db,path})\` 复制连接+填报表到 SQLite；生产数据仅 MCP 只读导入；runtime=unverified，填报须预览实点。
3. 校验（\`run_dataset_sql_check\` 静态、免租约；**target 缺省 local**，真实库须显式 \`target:"real"\`）：
   - 先 \`offline:true\` 只 prepare 校验语法/列名；看数据/参数时 \`offline:false\` 并传 \`params\`；改 SQL 前用 \`sql:"候选"\` 先验；
   - \`dataset_sql_parity({path, datasetName})\`（local_db 租约族）做真实 vs 本地对账；\`run_dataset_sql_check({target:"both"})\` 是免租约替代；
   - 模板原文含 \`\${if(...)}\` 公式参数时先展开“空分支/真实值”再传 local/both；直接传会拼出 \`WHERE 1=1 NULL\` 假语法错，不要据此改模板；
   - \`autoTables:true\` 递归扫任意深度 FROM/JOIN（含 EXISTS/子查询/CTE/UNION）；漏表重跑 schema，不误判本地缺表。
4. \`quality_gate_cpt\` 默认带本地 SQL 审计（本地库没建时给 info 提示并跳过）：SQL 语法错/少返回绑定列进 blockers，缺表/方言缺口只进 advisories；仍要 \`deliveryPass=true\` 才能交付。
5. Excel 导入可离线预检（模板有「导入Excel」按钮时，交付前跑）：\`local_db_import({action:"excel", db, path, excelFile, simulate:true})\` 校验按钮/列位/标题/控件类型与本地目标表约束（事务试插后必然回滚；不执行 FR 前端 JS）。
6. 边界：本地通过 ≠ 生产通过——DECIMAL 精度、时区、collation、\`sql_mode\`、大数据量性能以真实库为准；\`dialectIssues\`/\`caveats\` 是本地限制，不代表 SQL 写错。最终以真实库 + 真引擎校验为准；Node<22.13 无 \`node:sqlite\`，工具会提示升级。

## 三、明确不支持（不要试着绕过，会产出打不开的模板）
- **内置数据集（EmbeddedTableData / 把示例数据塞进模板）**：官方样本的 <RowData> 是 FR 私有压缩
  编码，无法在不反编译商业 jar 的前提下还原，写出来的模板设计器打不开。
  需要数据请用 SQL 数据集（add_dataset / generate_report 的 source）。
- **CSV / 文本 / XML 文件数据集**：官方 1559 个样本与 FR 11.0 安装目录里一个现成实例都没有，
  XML 元素名只能靠猜，猜错就是打不开的模板。请用 Excel 文件数据集（add_file_dataset，
  先把 CSV 用 Excel 另存为 .xlsx），或直接用 SQL 数据集。
- **Compare 的 IN / IS NULL 判断**：官方样本里这两类运算的 <O> 恒为空，无法还原列表/空值写法。
  请改用条件公式（如 "$$$ = \\"已完成\\""、"len($$$) = 0"）。
- **条件字体的斜体**：官方 223 例 FRFontHighlightAction 的 style 只有 0（常规）与 1（粗体）。

## 四、铁律（违反会直接导致生成的报表不可用）
1. **每次写完看 selfCheck**：写工具返回体里自带 selfCheck（结构 + 交付门禁的自检结论，
   CPT_MCP_AUTO_VERIFY 控制）。selfCheck.status 不是 pass 时先按 blockers 的 fix 修，再继续叠加写操作；
   交付前跑一次 verify_cpt({path, engine:true}) 拿全层结论（结构 + 门禁 + 期望值对账 + 真引擎），
   它把 validate_cpt / quality_gate_cpt / 引擎校验三件事合成一次调用（引擎默认开，不需要任何租约）。
1b. **读检查错误再交付**：build_report / generate_report 返回的 checkResult.hasError 为 true 时，
   必须先修掉再交付，不要假装完成。
1c. **交付前必须过质量门槛**：quality_gate_cpt 返回 pass/structuralPass（结构门槛：blockers 为空）与 deliveryPass（最终交付 = pass && engineCheck.status=='pass'），三字段并列、含义不同不要混用；blockers 带 fix，修完重跑。
   **光重跑本工具不会改变引擎结论**：engineCheck 非 pass 时先刷新引擎报告（首选 verify_cpt({path, engine:true})，静态免租约；或按 1d 租 fr_engine 后调 run_fr_engine_check({path})）再重跑；不要对着 not-run/stale 结论反复重跑。门禁/校验可回摘要（brief:true；brief:false 要全量）；文件未变时重复调用会复用上次结论（cached=true）。默认含本地 SQL 离线审计（未建库自动跳过；语法错/绑定列缺失进 blockers，缺表/方言缺口只进 advisories）。
   工序进度用 read_cpt({path, includeProgress:true}) 的 buildProgress（done/detail/nextAction），按顺序推进。
1d. **真引擎通道两条（任选）**：① verify_cpt({path, engine:true}) 静态常驻、引擎默认开、**不需租约**（首选）；② run_fr_engine_check({path}) 属 fr_engine 族，须先 request_deep_tool_access({path, group:"fr_engine", reason:"explicit_engine_check"})（门禁不会自动授予）。not-run/stale 时把 howToRun 交给用户执行，fail 先 validate_cpt。
1e. **已验证必须有证据**：子代理/历史会话自述不算数；主 agent 必须亲自重跑 check_report_js/validate_cpt/quality_gate_cpt，汇报写工具名+时间。
1f. **读回 JS 里的 \`]A\` 是 FR 设计器对 \`]\` 的转义（落盘编码），不是污染/残字符——禁止据此判断损坏、删改或"清洗"JS。** 读工具返回 designerEscapes、check_report_js 返回 designerMarkers 都只在提示这一点（语法判定已解码 \`]A\`→\`]\`）。
1g. **JS 块基线报减少但确属有意删块**：validate_cpt / quality_gate_cpt 传 resetJsBaseline:true 即可复位本模板基线（返回体给旧计数），不要删 %LOCALAPPDATA% 下的基线文件。
2. **多列数据集交给引擎推导父格**：同一行放多个 dsColumn 时，用 build_report / generate_report
   让引擎自动设置主扩展格与左父格。若用 add_cell 逐个拼：FR 的默认展开（无属性 <Expand/> 或
   dir=0）会自动跟随左邻扩展格，多数明细表无需显式父格；仅当默认父格不是你想要的时才显式给
   expand.leftParent（如 "A2"）。
3. **先有样式再建单元格**：add_cell 的 styleIndex 来自 add_style（属 style_manage 租约族，request_deep_tool_access({group:"style_manage"}) 后可用）或复用既有样式（get_cells({path, includeStyle:true}) / read_cpt_compact({view:"styles"}) 可查）；日常改样式用静态 update_cell_style。
4. **两套坐标口径别混**：参数 column/row 从 **0** 起；但单元格引用字符串（expand.leftParent 等，
   如 "A2"）行号从 **1** 起。
5. **水平对齐只能用 0 / 2 / 4 / 6**（0=居中，占官方样本 76.7%，表头与数据行默认；2=左对齐，文本列；
   4=右对齐，数字金额列；6=两端对齐）。传 1 / 3 / 5 会被拒绝 —— 这些值在 1559 个官方样本中
   零出现，设计器无法识别。
6. **写入类工具不可撤销**：动重要模板前先手动备份一份副本；出错无法撤销，只能重新构建。
7. **安全边界不可绕过**：路径只能在允许目录内，FR 安装目录只读；可执行 JavaScript 默认拒绝，不能通过改写 XML 或 update_cell 绕过。
   也不要把生产凭据/真实姓名/手机号/内网主机/桶名写进模板、JS、SQL 或 README；用环境变量或占位符。
8. **写工具 bytes 口径**：写工具返回的 bytes 系 UTF-8 文件字节，可与文件 stat 大小直接对账；落盘核对以此为准。
9. **SQL 数据集先本地后真实**：写/改 SQL 数据集前，先用 run_dataset_sql_check({target:"local", offline:true})
   把语法与绑定列跑通；再跑 target:"real"（或 both）验证真实库。真实库只读，不要拿它当 SQL 试错沙箱。

## 四之二、易混工具速辨（只列真会选错的；其余 get_* 名字已自述用途）
样式：单格样式 get_cells({includeStyle:true})；模板样式表 read_cpt_compact({view:"styles"})；增删命名样式属 style_manage 租约族（add_style/delete_style）；日常改格样式用静态 update_cell_style。
单元格手术已并入 update_cell：内容/公式/tooltip/插入策略/contentType/colspan,rowspan 一处完成（原两工具仅留降级）。
监听JS（四个容器，选错就拿不到目标脚本）：get_cell_listener=单元格；get_report_listener=报表级+分页预览 WebPageContent（看返回 area=report/webpage）；get_webwrite_js=填报Web事件；分页预览 afterload 写入用 set_webpage_js（set_report_listener 只写 Report 子级，set_webwrite_js 只写 WebWriteContent，都碰不到 WebPageContent）。
JS 合并约定（硬约定）：同一容器内、**相同事件类型的 JS 只允许一个 <Listener> 代码块**（加载事件 onload/afterload/beforeOutput/afterOutput/webopen 尤其如此）。
  已存在同 event 块时，用 set_report_listener / set_webwrite_js / set_webpage_js 的 aggregate=true 追加或合并（同 event 多块会按文档顺序并回一块，不丢内容），不要另起新块；
  大块共享 JS 只改一段时用 patchFind+patchReplace 片段替换（其余原文原样保留；兼容设计器转义 \`]A\`，写回仍 \`]A\`）；set_webwrite_js/set_report_listener/set_webpage_js 之外，set_report_js/set_toolbar_button_js/update_cell_listener 也支持（与 js 互斥、需唯一命中；add_cell_listener 只增）。
  整块替换把 ≥4KB JS 缩到 <60% 且少 ≥2KB 被护栏拒绝，确要重写传 allowShrink=true（有 sha 传 expectedSha256 核对）；
  写后重跑 validate_cpt 与 check_report_js（语法通过才算合规）。
数据：get_datasets=数据集（含SQL）；get_parameters=参数；get_parameter_panel=参数面板控件。
填报容器（硬约束）：模板级 WebWriteContent 必须位于 WorkBook 级 ReportWebAttr 内——FR 填报预览只读这里；放到 Report 等其它容器里会"按钮不显示、事件不执行"且设计器保存可能丢节点。缺容器/错位统一用 set_webwrite_extras({path, repair:true}) 修复（工具栏/Web 事件写工具也会先自动搬回）；build_report 传 toolbar 时自动 webWrite=true。

## 五、常用顺序速查
（行末 ⟵租:<族名> 表示该工具已下沉，动手前先 request_deep_tool_access({path, group:'<族名>'})）
create_cpt → add_dataset / add_file_dataset（Excel）/ add_tree_dataset（层级，须先有普通数据集）⟵租:dataset_edit
（SQL 数据集建好后先按「二之二」跑本地离线校验，再继续布局）
→（需要新增命名样式时 add_style ⟵租:style_manage）→ add_cell → add_chart（图表：给数据集+分类字段+数值字段即可）⟵租:chart_float
→ (填报) add_fill_submit ⟵租:fill_binding → add_fill_binding ⟵租:fill_binding
→ set_grid → set_report_settings → set_template_theme ⟵租:page_setup → set_parameter_panel ⟵租:param_panel → add_parameter_widget ⟵租:param_panel
→ (交互) add_cell_highlight / add_cell_hyperlink ⟵租:hyperlink_highlight / add_float_element ⟵租:chart_float → validate_cpt
→ **quality_gate_cpt（pass/structuralPass 结构通过、deliveryPass=true 才可交付）**
另有整族下沉的：单元格下拉字典改 update_cell_dictionary ⟵租:cell_dictionary；工具栏按钮 add_toolbar_button ⟵租:toolbar_edit；
行列结构 add_sheet / delete_cell_range / delete_row_range / shift_cell_range（insert=true 插入式挪移，目的列可被占用）⟵租:row_col_layout；脚本 set_report_js / set_webwrite_js / set_webpage_js / set_report_listener / add_cell_listener ⟵租:scripting。
低层/破坏性改写 batch_mutate_cells / update_report_node ⟵门禁族 report_rewrite（**须用户明确要求**）。

## 六、图表（add_chart / generate_report 的 chart）
只开放三类有官方实证的：column 柱形（194 例）/ line 折线（58）/ pie 饼图（100）。
不要自己拼图表 XML —— VanChart 的 <Plot> 子树有上百个标签，漏一个就是设计器打不开。
- 一个数值列 → 单系列（OneValueCDDefinition，166 例）；多个 → 多系列（MoreNameCDDefinition，230 例）
- 饼图只支持一个数值列（官方 100 个饼图里只有 1 例用了多数值列，形态未验证）
- 聚合方式只能 sum / avg / count / max / min / none

## 七、落库与版本控制（宿主可选能力）

本 MCP 不提供 git / 提交 / 回滚工具，也不做 push / 远端（保持专业化）。写操作口径：
- 单项写工具是原子的；*_batch 批量工具是非原子逐项执行（单项失败记 failed 不中断，已成功项保留，
  必须检查 summary.failed / results 再决定补偿）；单元格批量需要原子时走 batch_mutate_cells
  （plan 试算 → apply 原子写回）。
- 并发写入走乐观锁：报「并发冲突」时重新 load/read 最新内容后重做（勿删文件；批量部分成功先核对已落盘项）。
- 落库取决于宿主是否提供 git 工具（以你工具列表为准；本地常见
  git_status / git_diff / git_log / git_commit / git_init / git_branch，只本地提交、不 push、不建远端）：
  · 有：改前 git_status 看工作区；quality_gate_cpt 通过后 git_commit；
  · 没有：交付时明确写「本次改动未落库」，建议用户自行提交；不要因为缺 git 就拒绝改模板。
- 目录由版本管理接管时可设 CPT_MCP_NO_BAK=1（不建 .bak，目录干净）；.bak-build-* / .bak-batch
  只是崩溃兜底，不是版本，别指望它们回滚。

## 八、宿主可选能力与降级（缺了就降级，不许假装成功）

下列能力由宿主以其它 MCP 工具提供（名字形如 mcp__<server>__<tool>），本 MCP 不内置、也不保证存在。
动手前先看自己工具列表里有没有；没有就按下面的降级路径执行，并在汇报里说明「该项未验证」：

- 官方文档检索（fr-docx-mcp 的 search_docs / read_doc）→ 缺：用 get_capabilities 的分节与配方，
  并说明「未核对官方文档」，不要凭记忆编造官方限制。
- 数据库查询（doris / mysql / testdb 的 execute_query 等）→ 缺：优先用内置 SQLite 本地测试库
  （见「二之二」；没有真实连接也能 ddl+seed 自建样例，target:"local" 静态可用）；真实库可用时用
  run_dataset_sql_check（只读实跑 + 列名对账）。仍不可用则请用户粘贴 SQL 结果样例或行数，
  不要凭空断言「SQL 已跑通」。
- 浏览器预览（browser 的 navigate_page / take_screenshot / evaluate_script）→ 本机装 FineReport 时，
  可先 start_fr_preview({path}) 起独立 FR 实例（fr_preview 族：默认 starting，fr_preview_status 轮询到 running），
  再用宿主浏览器打开 viewUrl/writeUrl 看真实渲染、点工具栏，stop_fr_preview 收尾；无浏览器或本机无 FR 时
  用 check_report_js 查 JS 语法 + quality_gate_cpt / run_fr_engine_check 做引擎级校验，
  并请用户在 FR 设计器确认视觉（写「视觉未自动验证」）。
- git 落库 → 缺：按「七」处理（交付时标注未落库）。
- Excel 读取（excel 的读表工具）→ 缺：直接 add_file_dataset / generate_report(source.excelFile)，
  引擎会自己读表，不必先手工解析 Excel。
- PTC（run_code 程序化调用）→ 缺：用静态批量工具（add_parameter_widget_batch /
  update_parameter_widget_batch）替代循环；add_cell_highlight_batch 已隐藏，需要时 adhoc 临租。
- 真引擎校验（run_fr_engine_check 需要本机 FineReport 安装）→ 缺：quality_gate_cpt 的
  engineCheck 会是 not-run，按它给的 howToRun 交给用户执行，不要伪造 pass。

## 九、重复劳动的默认策略（同一工具 ≥5 次就先想批量化）

- 同类编辑 ≥5 次：优先 add_parameter_widget_batch / update_parameter_widget_batch 等静态批量工具，一次调用替代 N 次，再按 summary.failed + results 补偿（add_cell_highlight_batch 已默认隐藏，按需按名临租）。
- 固定多步序列（读→改→校验→门禁）：宿主有 run_code（PTC 模式）就写成一段 TypeScript 程序，中间结果留在程序内；配方见 get_capabilities({section:"ptc.recipes"})。
- 候选 SQL 批量验证：run_dataset_sql_check 循环（target:"local" 先筛语法/绑定列，再 target:"real"/"both" 与真实库对账），只输出 ok/行数/缺失列。
- 没有批量化手段时先说清「将逐条调用 N 次」再动手，不要闷头跑 30 轮。

## 十、交付汇报模板（每次交付都按这个格式）

1. 产出：改了哪个 .cpt（绝对路径）+ 关键结构变化；
2. 校验：validate_cpt 与 quality_gate_cpt 三态（pass / structuralPass / deliveryPass）+ blockers 数与修复情况；
3. 未完成 / 未验证：缺哪些外部能力（文档 / DB / 预览 / 引擎 / 落库），逐项写「未验证」；
4. 待确认：需要用户拍板的口径或视觉项。

不要只回「已完成」，也不要贴大段 XML —— 结论与证据（工具返回的三态、行数、bytes）比过程更重要。
`;

// ---- 安全围栏第 2 层：MCP 工具注解 ----
// 默认 openWorldHint=false：本 MCP 只操作本地 .cpt 文件；
// 会把链接交给浏览器或把内容推送到远端的工具显式标记为 open-world。

/** 只读：不改动文件系统
 *  2026-11-07 P1 注解纠正：validate_cpt / quality_gate_cpt 已移出本集合 —— validate 首次校验会写
 *  js-baseline 基线；quality_gate 走同一套 buildProgress（同样触发基线写），两者都落盘/改状态。
 *  （2026-11-07 P1-6 收口后 quality_gate 不再自动申请 fr_engine 租约、不改 tools/list。）
 *  它们不改 .cpt 正文，故同时归入 NON_TEMPLATE_WRITE_TOOLS（不挂 S6、不挂写后 selfCheck）。 */
export const READ_ONLY_TOOLS = new Set([
  'get_capabilities', 'get_build_progress',
  'read_cpt', 'get_datasets', 'get_parameters', 'get_cells', 'get_fill_config', 'get_embedded_submits',
  'get_styles', 'get_page_settings', 'get_grid', 'get_parameter_panel', 'get_cell_style',
  'list_cpt_issues', 'diagnose_fill_row_integrity', 'style_review_cpt', 'reasonableness_review_cpt',
  'schedule_list', 'schedule_get', 'scheduler_status', 'scheduler_history',
  'scheduler_actions', 'fr_detect', 'fr_inspect', 'fr_engine_check', 'fr_preview_status',
  'get_cell_hyperlink', 'get_cell_highlight', 'list_toolbar_buttons', 'check_report_js',
  'get_chart', 'get_float_element', 'get_cell_listener', 'get_cell_sort', // P1 单独项补齐·查
  'get_cell_dictionary', // M96 单元格下拉字典正文读取（ki/vi/取数表/自定义项，与 M91 写入口闭环）
  'get_report_listener', // M87 报表级 Listener + M99-D2 模板级 WebPageContent 监听器全文读取（改 afterload JS 前必读）
  'get_webwrite_js', // M88 WebWriteContent 监听器全文读取（改填报 Web 事件 JS 前必读，与 set_webwrite_js 组成读改写闭环）
  'request_deep_tool_access', 'record_cpt_read_intent', 'read_cpt_compact', // M69+ 深层租约/读取门禁（编排类，本身不改文件）
  'run_dataset_sql_check', // M145 数据集 SQL 只读实跑 + 列名对账（v1 会话 487 次外部查询的缺口）
  // P2 批量项补齐·批查（18 个 get_*_batch）
  'get_dataset_batch', 'get_parameter_batch', 'get_parameter_widget_batch', 'get_style_batch',
  'get_cell_batch', 'get_fill_binding_batch', 'get_fill_submit_batch', 'get_chart_batch',
  'get_float_element_batch', 'get_cell_hyperlink_batch', 'get_cell_highlight_batch', 'get_cell_listener_batch',
  'get_report_listener_batch', 'get_toolbar_button_batch', 'get_cell_sort_batch', 'get_schedule_batch',
  'get_sheet_batch', 'get_page_header_footer_batch',
  // 2026-11-02 内置 SQLite 本地测试库·只读面（查状态/结构/真实 vs 本地对账）
  'get_local_db_status', 'local_db_schema', 'dataset_sql_parity',
]);

// 场景族租约注册表（LEASE_GROUPS / GATE_GROUPS）与由它派生的深层工具清单（DEEP_TOOLS）
// 的单一事实源在 lib/lease-groups.js —— 这里 re-export，保持既有 import 路径不变
// （server.js / scripts/verify-mcp.mjs / 各单测都从 contract.js 取）。
// DEEP_TOOLS：generate/focused/report 入口默认隐藏，凭 request_deep_tool_access 短时解锁；
// full 入口静态全量暴露。
export { LEASE_GROUPS, GATE_GROUPS, DEEP_TOOLS } from './lease-groups.js';

/** 破坏性：会删除数据、覆盖已有文件、或产生不可逆副作用 */
export const DESTRUCTIVE_TOOLS = new Set([
  'delete_parameter', 'delete_cell', 'delete_cell_range', 'delete_row_range', 'shift_cell_range',
  // M115：删控件默认值槽 <widgetValue> 整块（清理官方 0 例的脏形态；只删值槽，控件/监听/绑定原样保留）
  'clear_widget_value',
  'delete_fill_binding',
  'delete_dataset', 'delete_chart', 'delete_float_element',  // M51: 删数据集/图表/浮动元素
  // M52-M55: 报告级 + 单元格 + 表格 + 面板 删改查补齐（update_report_node/set_report_listener 的
  // 删除语义与 Report 级结构改写都会留下不可逆变更；set_report_js 可删除 TopJS）
  'update_report_node', 'set_report_listener', 'set_webwrite_extras', 'set_report_js', 'set_webwrite_js', 'set_webpage_js', 'set_toolbar_button_js',
  'delete_cell_hyperlink', 'delete_cell_highlight', 'delete_fill_submit', 'delete_toolbar_button', 'delete_cell_sort',
  'delete_cell_listener', // P1 单独项补齐·删（严格删指定已存在监听器）
  'delete_sheet', 'delete_style', 'delete_parameter_widget', 'delete_page_header_footer',
  'delete_mobile_widget_ref', // P1-2 移动端孤儿条目定向删除（不可逆）
  'create_cpt',        // 目标已存在时拒绝，但会新建文件
  'build_report',      // 默认拒绝覆盖已存在目标（noOverwrite 默认 true；显式 false 才原子替换）
  'generate_report',   // 内部调用 build_report，同样默认拒绝覆盖目标文件
  'regenerate_from_meta', // 从 .cpt.meta.json 复现模板：默认覆盖同名模板（原子替换+留 .bak-build-*），显式 noOverwrite:true 才拒绝
  'schedule_remove', 'scheduler_stop', 'schedule_run_now',
  'fr_decompile',      // 会写出反编译目录
  // P2 批量项补齐·批删（17 个 delete_*_batch）
  'delete_dataset_batch', 'delete_parameter_batch', 'delete_parameter_widget_batch', 'delete_style_batch',
  'delete_fill_binding_batch', 'delete_fill_submit_batch', 'delete_chart_batch', 'delete_float_element_batch',
  'delete_cell_hyperlink_batch', 'delete_cell_highlight_batch', 'delete_cell_listener_batch',
  'delete_report_listener_batch', 'delete_toolbar_button_batch', 'delete_cell_sort_batch', 'delete_schedule_batch',
  'delete_sheet_batch', 'delete_page_header_footer_batch',
  // 2026-11-02 本地库运维：drop/reset 会不可逆删除本地测试库文件（要 confirm:true）
  'local_db_admin',
]);

/** 幂等写入：重复调用结果一致（覆盖式设置），不会重复追加 */
export const IDEMPOTENT_WRITE_TOOLS = new Set([
  'set_report_settings', 'set_parameter_panel', 'set_grid', 'set_page_header_footer', 'set_report_imports',
  'update_embedded_submit',
  'set_template_theme',
  'update_parameter', 'update_dataset', 'update_cell', 'update_cell_style',
  'update_fill_binding', 'set_cell_content_type', 'set_cell_span', 'set_cell_widget', 'set_widget_value',
  'schedule_enable', 'schedule_disable',
  'run_fr_engine_check',  // 触发 verify:fr：重跑覆盖同路径 .fr-engine-check 报告（幂等），不改用户 .cpt
  // 2026-11-06 P0 注解纠正：verify_cpt 从 READ_ONLY 移到这里 —— engine 默认 true 会写
  // <cpt 同目录>/.fr-engine-check 报告并 spawn `npm run verify:fr`（幂等：同目标重跑覆盖同一份报告）。
  // 它不改模板正文，故不挂 S6 边界提示、也不挂写后 selfCheck（见 NON_TEMPLATE_WRITE_TOOLS）。
  'verify_cpt',
  // 2026-11-07 P1 注解纠正：validate_cpt / quality_gate_cpt 从 READ_ONLY 移到这里 ——
  // validate 首次校验写 js-baseline 基线（%LOCALAPPDATA%/cpt-mcp/js-baseline/）；
  // quality_gate 走 buildProgress（同触发基线写）；P1-6 收口后它不再自动授予 fr_engine 租约、
  // 不再改 tools/list。两者都不改 .cpt 正文，故同归 NON_TEMPLATE_WRITE_TOOLS
  // （不挂 S6、不挂写后 selfCheck），路径围栏按实际副作用放行。
  'validate_cpt', 'quality_gate_cpt',
  // 本地独立 FR 预览实例：start 重复调用复用活着的实例（只替换 reportlet），stop 重复调用返回 not-running
  'start_fr_preview', 'stop_fr_preview',
  'rename_parameter_widget', // 改名覆盖式写入：同一目标多次改名结果一致（幂等），不追加
  'batch_mutate_cells',  // apply 阶段覆盖工作区文件（带 .bak-batch 备份）；plan 阶段只试算
  'move_toolbar_button', // 块级剪切粘贴：同目标重复移动结果一致（幂等），不追加不删除
  'set_toolbar_button_icon', // 单节点覆盖：同图标重复设置结果一致（幂等）
  'update_parameter_widget', // 覆盖式：同值重复设置结果一致（幂等），不追加
  // P1 单独项补齐·改：原位改已存在目标，重复调用结果一致（幂等），不追加
  'update_chart', 'update_float_element', 'update_cell_hyperlink', 'update_cell_highlight',
  'update_cell_listener', 'update_cell_sort', 'update_fill_submit', 'update_sheet',
  'update_cell_dictionary', // M91 单元格下拉字典原位改（幂等；repair 补回缺失 FormulaDictAttr）
  // P2 批量项补齐·批改（17 个 update_*_batch）
  'update_dataset_batch', 'update_parameter_batch', 'update_parameter_widget_batch', 'update_style_batch',
  'update_fill_binding_batch', 'update_fill_submit_batch', 'update_chart_batch', 'update_float_element_batch',
  'update_cell_hyperlink_batch', 'update_cell_highlight_batch', 'update_cell_listener_batch',
  'update_report_listener_batch', 'update_toolbar_button_batch', 'update_cell_sort_batch', 'update_schedule_batch',
  'update_sheet_batch', 'update_page_header_footer_batch',
]);

/**
 * 追加类写入：非只读、非破坏性、非幂等（重复调用会追加一行或报重名错）。
 * 显式列出来（而不是靠 default 分支兜底）是为了让归类穷尽 ——
 * 验证脚本会断言「没有任何工具未归类」，新增工具漏归类会直接验证失败。
 */
export const APPEND_WRITE_TOOLS = new Set([
  'add_sheet', 'add_dataset', 'add_file_dataset', 'add_tree_dataset',
  'add_style', 'add_cell', 'add_fill_submit', 'set_fill_toolbar', 'add_toolbar_button',
  'add_parameter_widget', 'add_parameter', 'add_fill_binding', 'add_cell_highlight', 'add_cell_hyperlink',
  'add_chart', 'add_float_element', 'add_cell_listener', 'add_cell_listener_batch',
  // schedule_add 每次 push 一条任务（重试会产生重复定时任务）⇒ 归追加类，非幂等
  'schedule_add',
  // P2 批量项补齐·批增（16 个 add_*_batch）
  'add_dataset_batch', 'add_parameter_batch', 'add_parameter_widget_batch', 'add_style_batch',
  'add_fill_binding_batch', 'add_fill_submit_batch', 'add_chart_batch', 'add_float_element_batch',
  'add_cell_hyperlink_batch', 'add_cell_highlight_batch', 'add_report_listener_batch',
  'add_toolbar_button_batch', 'add_cell_sort_batch', 'add_schedule_batch', 'add_sheet_batch',
  'add_page_header_footer_batch',
  // 2026-11-02 本地 SQLite 测试库：import/exec 是写入且非幂等（seed 默认追加、exec 由 SQL 决定），
  // 归「追加类写入」注解（非只读/非破坏性/非幂等）；schema 替换 + 快照另说明。
  'local_db_import', 'local_db_exec',
]);

// 会把链接交给浏览器或把内容推送到远端；仍然是本地写入，但 client 应显示为 open-world。
export const OPEN_WORLD_TOOLS = new Set(['add_cell_hyperlink']);

/**
 * 写了文件系统、但**不写 .cpt 正文**的核验类工具（2026-11-06 P0 引入，2026-11-07 P1 扩充）。
 *
 * 这些工具在注解上必须算写（readOnlyHint=false：确实落盘 / 起进程 / 改 tools/list），
 * 但语义上仍属核验/诊断，因此由 server.js 做三处例外处理：
 *   ① 不追加 S6 写边界提示 ——「会改 .cpt 且不可撤销」对它是假话，且与 instructions 的
 *      「交付前必须跑一次 verify_cpt / quality_gate_cpt」直接冲突，挂上去会让模型不敢调用；
 *   ② 不挂写后自动 selfCheck —— 它们本身就是核验入口，再挂会把同一套校验跑两遍（引擎还会重复 spawn）；
 *   ③ 路径围栏按**只读副作用**放行（它们只写自有缓存：引擎报告目录 / js-baseline / 租约状态），
 *      否则「只读核验 FR 官方样本」的能力会回退（见 server.js 的 pathFenceReadOnly）。
 *
 * 成员与落盘事实：
 *   - verify_cpt：engine=true 写 <cpt 同目录>/.fr-engine-check 报告并 spawn `npm run verify:fr`；
 *   - validate_cpt：首次校验写 js-baseline 基线文件（%LOCALAPPDATA%/cpt-mcp/js-baseline/）；
 *   - quality_gate_cpt：走 buildProgress 写 js-baseline 基线（**不自动授予租约 / 不改 tools/list**，见 P1-6）。
 */
export const NON_TEMPLATE_WRITE_TOOLS = new Set(['verify_cpt', 'validate_cpt', 'quality_gate_cpt']);

/**
 * S6 边界提示两档（2026-11-07 P1：按「是否改 .cpt 正文」而非「是否算写」分档）。
 *  - S6_TEMPLATE_WRITE_TOOLS：会改 .cpt 正文 → 强约束提示（会改.cpt且不可撤销…先 read_cpt）；
 *  - S6_DERIVED_WRITE_TOOLS：注解上是写（确实落盘/起进程），但只写**派生产物**
 *    （引擎校验报告 / 本地测试库 / 调度配置 / 反编译输出），不改 .cpt 正文 → 中性提示，
 *    避免模型把「本地建库」「跑真引擎」「装定时任务」误判成会破坏用户模板而不敢调用。
 *
 * 三档互补：S6_TEMPLATE_WRITE_TOOLS / S6_DERIVED_WRITE_TOOLS / NON_TEMPLATE_WRITE_TOOLS
 * 两两不相交，并集恰为全部写类工具（test/write-boundary.test.js 锁死）。
 */
export const S6_DERIVED_WRITE_TOOLS = new Set([
  'run_fr_engine_check', 'fr_decompile',
  'local_db_admin', 'local_db_import', 'local_db_exec',
  'schedule_add', 'schedule_remove', 'schedule_enable', 'schedule_disable', 'schedule_run_now',
  'scheduler_stop',
  'start_fr_preview', 'stop_fr_preview',
]);

export const S6_TEMPLATE_WRITE_TOOLS = new Set(
  [...DESTRUCTIVE_TOOLS, ...IDEMPOTENT_WRITE_TOOLS, ...APPEND_WRITE_TOOLS]
    .filter((name) => !NON_TEMPLATE_WRITE_TOOLS.has(name) && !S6_DERIVED_WRITE_TOOLS.has(name)),
);

/**
 * 推断工具的 MCP 注解。
 * @param {string} name 工具名
 * @returns {object} ToolAnnotations
 */
export function annotateFor(name) {
  const base = { openWorldHint: OPEN_WORLD_TOOLS.has(name) };
  if (READ_ONLY_TOOLS.has(name)) {
    return { ...base, title: name, readOnlyHint: true, destructiveHint: false, idempotentHint: true };
  }
  if (DESTRUCTIVE_TOOLS.has(name)) {
    return { ...base, title: name, readOnlyHint: false, destructiveHint: true, idempotentHint: false };
  }
  if (IDEMPOTENT_WRITE_TOOLS.has(name)) {
    return { ...base, title: name, readOnlyHint: false, destructiveHint: false, idempotentHint: true };
  }
  // 其余 add_* 追加类：非只读、非幂等（重复调用会追加或报重名错）
  return { ...base, title: name, readOnlyHint: false, destructiveHint: false, idempotentHint: false };
}

/** 全部已归类工具（供验证脚本做「无未归类工具」断言） */
export function allClassifiedToolNames() {
  return [...READ_ONLY_TOOLS, ...DESTRUCTIVE_TOOLS, ...IDEMPOTENT_WRITE_TOOLS, ...APPEND_WRITE_TOOLS];
}

/**
 * report 档静态工具表（33 项，2026-11-12 P0-1 精简）—— 工具上下文瘦身后的目标清单。
 *
 * 单一来源：server.js 的 PROFILE_TOOLS.report 与 scripts/token-budget.mjs 的 reportCount
 * 都从这里取，**禁止再手写第二份名单或数字**（否则"预算门"与"实际档位"必然漂移——
 * 仓库历史上 report 工具数就出现过 54/56/57 三份不一致的记录）。
 *
 * 归入此表的判据（方案 2.0 判据 S）：
 *   (a) 门/协议：不进静态模型就自助拿不到地图与租约（get_capabilities / request_deep_tool_access /
 *       record_cpt_read_intent / read_cpt / read_cpt_compact）；
 *   (b) 交付门禁：每次交付都要用（validate_cpt / quality_gate_cpt / check_report_js）；
 *   (c) 通用只读原语且单件 ≤1.6 KB：读是每个任务的第一步，为省 1 KB 付一次租约往返是净亏；
 *   (d) 每任务必用的写原语：建表、接数据源、写单元格/样式/绑定类型/页面设置/网格。
 * 其余能力按场景族下沉（lib/lease-groups.js），长尾走 adhoc 按名直租 —— 全部可达，只是"什么时候付"。
 * 注意：一个工具可以同时 ∈ 静态表与租约族，二者非互斥（如 add_cell / update_cell_style 亦属 cell_primitive）。
 *
 * 2026-11-12 P0-1（按会话记录降本）：调用少 ≠ 没用，先判断"能否并入其它工具/已有通道"，再决定去留：
 *   · get_cell_style → 并入 get_cells({includeStyle:true})（单格样式+共享计数一次取回）；
 *     独立工具仍属 cell_detail 门禁族（精确单格 target 通道），默认隐藏。
 *   · set_cell_content_type / set_cell_span → 并入 update_cell（contentType / colspan,rowspan 参数）；
 *     独立工具保留给 cell_primitive 批量失败降级通道，默认隐藏。
 *   · get_build_progress → 并入 read_cpt({includeProgress:true})（工序进度是"整体概览"的一部分）。
 *   · get_styles / get_page_settings → 读门禁 read_cpt_compact 已有 styles/page 视图，独立读取
 *     仅 full/adhoc 使用（FULL_ONLY_WAIVERS: template-meta-reads）。
 *   · add_style → 命名样式增删是独立原子手术，不硬塞进 add_cell/update_cell_style（会把 20+ 参数的
 *     style schema 塞进高频工具，净亏）；改为 style_manage 租约族（add_style/delete_style）。
 *   · build_report → 已属 generator_full 租约族；report 档从零建表首选静态的 generate_report，
 *     需要精确 spec 时再租。focused 档仍静态可见（弱模型路径不变）。
 *   · add_cell_highlight_batch → 非原子批量便利工具，与"原子化"原则冲突，默认隐藏走
 *     FULL_ONLY_WAIVERS(batch-writes) + adhoc 临租；单件 add_cell_highlight 仍在 hyperlink_highlight 族。
 */
export const REPORT_STATIC_TOOLS = Object.freeze([
  // (a) 门 / 协议
  'get_capabilities', 'request_deep_tool_access', 'record_cpt_read_intent', 'read_cpt', 'read_cpt_compact',
  // (c) 通用只读原语
  'get_datasets', 'get_parameters', 'get_cells', 'get_grid',
  'get_cell_dictionary', 'get_cell_listener', 'get_report_listener', 'get_webwrite_js',
  'get_fill_config', 'get_parameter_panel', 'list_toolbar_buttons',
    'run_dataset_sql_check', // 数据集 SQL 实跑+列名对账（只读；v1 会话最大绕行面）
    // P0（2026-10-26）：v1 会话里最高频的三类重复编辑，批量版进 report 档（PTC 程序内也可直接用）
    'add_parameter_widget_batch', 'update_parameter_widget_batch',
  // (d) 每任务必用的写原语（单元格手术合并进 update_cell：内容/公式/tooltip/插入策略/contentType/跨行列）
  'create_cpt', 'add_dataset', 'add_file_dataset', 'update_dataset',
  'add_cell', 'update_cell', 'update_cell_style', 'set_report_settings', 'set_grid',
  // (d) 整表生成入口（轻 entry + spec 分节下发；精确 spec 控制用 generator_full 租约的 build_report）
  'generate_report',
  // (b) 交付门禁 + 自主核验（进度用 read_cpt({includeProgress:true})）
  'validate_cpt', 'verify_cpt', 'quality_gate_cpt', 'check_report_js',
]);

// 规格 / 参数文档节（L1 路线 B 的唯一内容源：巨块参数语义只写一次，工具 schema 只放节引用）
// 与分节下发/自检助手 —— 单一事实源在 lib/spec-sections.js，这里 re-export 保持取用路径不变。
export {
  SPEC_SECTIONS, SECTION_REFS, selectSpecSections, specSectionProblems,
} from './spec-sections.js';
