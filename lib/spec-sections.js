// cpt-mcp/lib/spec-sections.js —— 规格 / 参数文档节（L1 路线 B 的**唯一内容源**）
//
// 背景：`build_report.spec`(30,255 B)、`add_style.border`(1,098 B×2 处)、
//       `generate_report.options`(6,720 B) 这类"参数级文档"占了 report 档静态表的 70%。
//       它们是"要用的那一刻才需要读"的知识，不该每请求常驻上下文。
// 做法：巨块参数的语义**只在本表里写一次**，工具的 inputSchema 只留"指向节的引用"
//       （见 lib/light-schemas.js）；模型动手前用
//       get_capabilities({tool:"add_style", section:"styles.border"}) 按需取，只付用到的部分。
// 约束（test/spec-sections.test.js 与门禁 target-table --check 双向锁定）：
//   ① 节键唯一；② 节正文两两不得相同；③ 每节 covers 非空；
//   ④ SECTION_REFS 与每节 usedBy 双向一致（悬空即红）；
//   ⑤ 参数 ≥3 的轻 entry 工具必须登记节引用。
import { LEASE_GROUPS, GATE_GROUPS } from './lease-groups.js';

/** 由 LEASE_GROUPS 渲染族目录正文：与运行时组表**同源**，杜绝"地图与实际租约不一致" */
function renderLeaseDirectory() {
  const lines = Object.entries(LEASE_GROUPS).map(([name, g]) => {
    const reasonText = g.reasons ? g.reasons.join('/') : g.reason;
    return `- ${name}（${g.members.length} 个工具；reason=${reasonText}；ttl=${g.ttlSeconds}s；maxCalls=${g.maxCalls}）：`
      + `${g.why}。成员：${g.members.join('、')}`;
  });
  return [
    '租约组目录（request_deep_tool_access 的 group 取值与成员；解锁一次整族定义进入上下文，按族租不按工具租）：',
    ...lines,
    '- adhoc：任意**未编组**工具按名直租，另传 tools=[工具名]；reason 按涉及面取 adhoc_read（全只读）/ adhoc_write（含写）/ adhoc_destructive（含破坏性），均绑单文件、分级只严不松。',
    '- auto：只记得工具名、不记得组名时的兜底——传 {path, group:"auto", tools:["X"]}，服务端按名反查所属族并用该族 reason/ttl/maxCalls 授予（reason 可省略）。',
    `判组顺序：① 命中门禁组（${GATE_GROUPS.join('/')}）→ **拒绝**并回指正确通道（cell_detail 需 target{sheet,cell}；cell_primitive 需批量失败返回的 failureId；fr_engine 须显式 explicit_engine_check，门禁不自动授予，也可走 verify_cpt 免租约通道；report_rewrite 须用户明确要求）；② 命中具名场景族 → 按该族策略授予；③ 未编组 → 回指 group:"adhoc" 与应传的 reason；④ 一次只能租一个族，跨族要分两次申请。`,
    '提示：granted 后服务端会发 tools/list_changed，桥接重同步约 1~2 秒；紧接着调用仍报 unknown tool 时，等待约 2 秒重试一次即可，不要重复申请同一个组（被拒也耗次数）。',
  ].join('\n');
}

export const SPEC_SECTIONS = Object.freeze({
  'styles.border': {
    title: '样式·边框',
    usedBy: ['add_style', 'update_cell_style'],
    covers: [
      'border = { top?, bottom?, left?, right?, outerTop?, innerHorizontal? }，每边形如 { style, color? }。',
      'style = 线型编号（官方样本实证：1 细实线最常用，另有 2/3/5/14 等；取整数 >=0）。',
      'color = #RRGGBB；缺省时用设计器默认黑色。',
      'top/bottom/left/right = 单元格四边；outerTop = 表格外框上边线；innerHorizontal = 表格内横线（表头下沿常用）。',
      '不传 border = 完全不动边框（不会清空既有边框）；只传其中几边就只改那几边。',
      '常见坑：想给"表头整行加下框线"用 bottom 而不是 innerHorizontal；innerHorizontal 只在设计器识别为"表格区域"时才渲染。',
    ].join('\n'),
  },
  'styles.fontAlign': {
    title: '样式·字体与对齐',
    usedBy: ['add_style', 'update_cell_style'],
    covers: [
      'fontName（字体名，如 微软雅黑）/ fontSizePt（字号 pt，6–200，默认 14；表头/标题常用 18）/ bold / italic / underline / strikethrough / foregroundColor(#RRGGBB) / backgroundColor(#RRGGBB)。',
      'horizontalAlignment：**只能 0 / 2 / 4 / 6** —— 0=居中（官方样本 76.7%，表头/标题/数据行默认）、2=左对齐（文本列）、4=右对齐（数字/金额列）、6=两端对齐（极罕见）。传 1/3/5 会被拒绝：官方 1559 个样本零出现，设计器无法识别。',
      'verticalAlignment：官方样本仅出现 0/1/3 —— 0=居中（默认，通常省略不写）、1=靠上、3=靠下。',
      'textStyle（文本控制，官方样本 1/2，对照设计器为自动换行/单行等）/ paddingLeft、paddingRight（左右缩进 px）/ lineSpacing（行间距）/ rotation（文本方向角度，-90=竖排）。',
      '不传的字段一律"不动"（不是重置为默认）。',
    ].join('\n'),
  },
  'styles.format': {
    title: '样式·数字与日期格式',
    usedBy: ['add_style'],
    covers: [
      'format = { class?, pattern?, roundingMode? }，对应官方 <Format> 子元素；不传则不生成 <Format>。',
      '数字：class="com.fr.base.CoreDecimalFormat"，pattern 如 "#,##0.00"（千分位两位小数）、"#,##0"（金额整数）；roundingMode 为舍入模式编号。',
      '日期：class="com.fr.base.SimpleDateFormatThreadSafe"，pattern 如 "yyyy-MM-dd"、"yyyy年MM月dd日"。',
      '文本/百分比：class="com.fr.base.TextFormat"（原样文本）。',
      '常见坑：pattern 必须与 class 匹配（把 "#,##0.00" 配给日期类不生效）；只传 pattern 不传 class 时引擎按数字格式处理。',
      '单元格显示"数值右对齐 + 千分位"是报表成品感的主要来源，金额列建议同时给 horizontalAlignment=4。',
    ].join('\n'),
  },
  'styles.scope': {
    title: '样式·scope 克隆语义',
    usedBy: ['update_cell_style'],
    covers: [
      'scope="cell"（默认）：先把目标格当前引用的 FR Style **克隆**一份再改并重新绑定 —— 只影响目标单元格，StyleList 会新增一条样式；同风格的其他单元格不受影响。',
      'scope="shared"：**就地修改**共享样式本体 —— 所有引用该样式索引的单元格一起变化；仅在明确要批量改同一风格时使用。',
      '读回校验：改完用 get_styles 看索引数量是否新增（cell 模式会 +1，shared 模式不变），再用 get_cell_style 核对目标格。',
      '常见坑：默认 cell 模式反复改同一格会不断新增样式条目；同一格要连续改多次时先攒齐字段一次调用。',
    ].join('\n'),
  },
  'cell.widget': {
    title: '单元格·填报控件',
    usedBy: ['add_cell', 'set_cell_content_type'],
    covers: [
      'widget 取值：text（文本，最常用）/ textarea（多行）/ date（日期）/ comboBox（下拉单选）/ checkBox（复选）/ comboCheckBox（下拉多选，返回值为逗号分隔字符串）/ label（标签）/ submit（提交按钮）/ appendRow（增行按钮）/ custom（插件控件，须同时给 widgetClass）。',
      'widgetItems = [{key,value}]：仅 comboBox / comboCheckBox 的**自定义固定项**；要绑数据集或数据库表请改用 widgetDictionary（见 cell.dictionary 节）。',
      'widgetClass：仅 widget="custom" 必填，写插件控件的完整类名，如 com.fr.plugin.excel.ui.ExcelImportButton。',
      'pluginID / pluginVersion：插件控件的归属标识；只有确知插件来源时才写，写错设计器会报"找不到控件"。',
      '控件与数据绑定可同格并存：<Widget>（控件外观/输入类型）与单元格级 <O t="DSColumn">（数据绑定）是兄弟节点 —— 填报"拖字段"形态即两者共存。',
      'label 控件默认值为空时页面上不显示字体，换 label 后务必用 set_widget_value 或 text 参数补显示文本。',
      '不传 widget = 纯数据格（无控件）。',
    ].join('\n'),
  },
  'cell.dictionary': {
    title: '单元格·下拉字典（M109/M117）',
    usedBy: ['add_cell'],
    covers: [
      'widgetDictionary = { type, ... }，仅 comboBox / comboCheckBox 有效；**整块替换**该格下拉的数据来源，控件与内容绑定原样保留。',
      'type="table"（数据集字典，官方单元格侧 85 例）：dsName（须已 add_dataset）+ kiName（实际值列）+ viName（显示值列）。落点为 <Dictionary class="com.fr.data.impl.TableDataDictionary">，FormulaDictAttr 承载 kiName/viName，NameTableData 承载 <Name>ds1</Name>。',
      'type="db"（数据库表字典，官方单元格侧 259 例）：table + ki（实际值列索引，0 起，必填）+ vi（显示值列索引，必填）+ connection，可选 schema / kiName / viName。',
      'type="custom"（自定义固定项，官方 106 例）：items = [{key,value}]；空数组 = 清空项。等价于 add_cell 的 widgetItems 写法。',
      'type="formula"（公式数据字典，M117 新增；官方 37 块实证：参数面板侧 25 / 单元格控件侧 12）：formula（值公式，必填，如 =range(2010,2012)）+ eFormula（显示公式，可缺省，如 =$$$+\'年\'）。落点为 <Dictionary class="com.fr.data.impl.FormulaDictionary">，两段 CDATA：<FormulaDict>（值）/ <EFormulaDict>（显示）；eFormula 缺省或空 ⇒ 官方「仅有 FormulaDict」形态（官方 25/37）。公式按原文写入 CDATA（含 $$$ 不被吞、不被转义）。',
      '改已有格的下拉请用 update_cell_dictionary（只动 <Dictionary> 块）：table/db/custom/formula 四种可整块换（dictionary:{type,...}），也可原位改 items / kiName+viName+table / formula+eFormula（eFormula 传空串 = 清空该块，回到官方仅有 FormulaDict 形态）。参数面板侧的同类能力在 update_parameter_widget（与 update_cell_dictionary 同源 dictionaryXml）。',
      '读回核对用 get_cell_dictionary（kind 返回 table/custom/database/formula/none，公式字典附 formula/eFormula）。',
      '联动场景（按另一格的值过滤本格选项）：官方形态是**数据集参数 + 公式默认值** —— 先 add_dataset 带 parameters:[{name:"project_code", defaultValue:"=A3"}]（公式引用上游单元格），再把本格下拉绑到该数据集（type="table"）。cpt-mcp 不写 DynamicSQLDict 私有形态。',
      '常见坑：kiName/viName 缺失 → 下拉显示为空；dsName 写错 → 设计器打开即报数据集不存在；同时给 widgetItems 与 widgetDictionary 时后者生效；公式字典给 type="formula" 却不给 formula → 直接拒绝（值公式必填）。',
    ].join('\n'),
  },
  'cell.expand': {
    title: '单元格·扩展与汇总',
    usedBy: ['add_cell'],
    covers: [
      'expand = { dsColumnId?, dir?, leftParent?, upParent?, order?, multiNumber? }：dir=0 纵向扩展（明细行，默认）/ 1 横向扩展。',
      '**左父格三态（M114 补全，最容易搞错的一处）**：① 不传 / 传空 → <Expand dir="0"/>，引擎按"跟随左邻扩展格"推导（明细表最常用；官方多列数据集行多数用默认）② 传引用 leftParent:"A2" → <Expand dir="0" leftParentDefault="false" left="A2"/>，显式指向某格（官方 1057 例）③ 传 leftParent:"none"（或 true）→ <Expand dir="0" leftParentDefault="false"/>，**显式"无"左父格**（官方 337 例）：该格不再把左邻当父格，按自身 dsColumn 独立向下展开。',
      '**什么时候必须用形态 ③**：同一行放**两组互不相关的数据集**时，每组首格都要写 leftParent:"none" 打断默认串联；否则第二组会顺着默认规则被并进第一组的父格链，导致行数错乱。官方实证：demo/analytics/financial/利润结构分析.cpt 第 7 行（c2/c3/c5 绑 ds4、c6/c7 静态分隔、c10 绑 ds5.项目 写 leftParentDefault="false"、c13/c14 绑 ds5 其余列）；全量统计"同排 ≥2 个无左父格的向下扩展根"的官方样本 **811 例**。',
      '坐标口径：传引用时是 A1 字符串（如 "A2"），**行号从 1 起**；而工具参数 column/row 从 0 起 —— 两套口径不要混。传 "none" 不是引用，不涉及行号。',
      'dsColumnId：单元格绑定的数据集列 id（contentType=dsColumn 时由 dsName+columnName 推导）。',
      'summary = 汇总模式：sum / avg / count / max / min；传了就以官方 SummaryGrouper 形态落盘，缺省为分组（FunctionGrouper）。汇总格通常不扩展。',
      'order = 扩展后排序 1/2；multiNumber = 扩展倍数。普通明细表用 dir=0 + 默认父格即可。',
    ].join('\n'),
  },
  'cell.contentType': {
    title: '单元格·绑定类型切换',
    usedBy: ['set_cell_content_type'],
    covers: [
      'contentType="text"：纯文本，用 content 参数。',
      'contentType="formula"：公式，用 formula（带不带 = 均可，如 SUM(A1:A10) 或 =SUM(A1:A10)；自动规范为官方 Formula 对象）。改已有公式优先用 update_cell(content:"=...") 原位改，不必换型。',
      'contentType="dsColumn"：数据集列绑定，用 dsName + columnName；可选 summary（sum/avg/count/max/min）。',
      'contentType="image"：图片，用 imageClass（完整类名，默认 com.fr.report.cell.cellattr.core.ImageCellAttr）或 content。',
      'M106 关键落点：绑定只写【单元格级】<O t="DSColumn">（位于 <PrivilegeControl/> 之前、与 <Widget> 同级兄弟），**绝不写进 <Widget><widgetValue>** —— 后者是控件默认值槽，官方 1550 份样本 0 例，写进去 validate_cpt 会报 error。',
      '控件保留语义：目标格已有 <Widget> 时只补/换单元格级绑定，控件外观与输入类型不动（设计器"拖字段"语义）；控件格原本没有单元格级 <O> 时走插入（返回 mode=insert）。',
      '已存在单元格级对象内容（<O t="...">，如绑定/公式/图片）时：传 force=true 由本工具整块替换（控件/合并/监听器保留，原对象内容丢失）；不传则拒绝并提示先 delete_cell。改公式更推荐 update_cell(content:"=...")（原位、不丢对象）。',
    ].join('\n'),
  },
  'cell.span': {
    title: '单元格·跨行跨列（M111）',
    usedBy: ['set_cell_span'],
    covers: [
      'colspan = 跨列数（>=1；1 或 null = 取消跨列）；rowspan = 跨行数（>=1；1 或 null = 取消跨行）；至少传一个，只传一个时另一个保持现状。',
      '就地改 <C> 开标签的 cs/rs：内容、控件、数据绑定、监听器、条件属性、扩展父格引用全部原样保留。',
      '覆盖不变量：被合并覆盖的位置不得再有同表单元格（官方 7142 个跨行列格中仅 53 例越界且全在聚合报表）——覆盖到已有格时直接拒绝并列出坐标，请先 delete_cell 或用 delete_cell_range。',
      '多工作表模板必须显式传 sheet（同坐标格在不同表语义不同，缺省会改错表）。',
      '幂等：值已一致时返回 mode=none，不写文件。',
      '改后建议 validate_cpt 验收（跨行列会改变后续坐标引用关系）。',
    ].join('\n'),
  },
  'cell.update': {
    title: '单元格·覆盖更新',
    usedBy: ['update_cell'],
    covers: [
      'insertPolicy（填报行完整性·插入策略）：copy = 插入新行时复制上一行该格的值 / default = 走默认插入值 / null 或 "" = 删除该属性节点（不传 = 不动）。官方枚举仅 copy/default/null；落点在 <C> 内 CellOptionalAttrHolder 之后、<Expand> 之前。',
      'insertPolicy 与 tooltip/content 互斥：一次调用只做一类改动，同时传会显式报错（避免"以为两样都改了"的静默丢失）。',
      'allowUnsafeScript：content 含可执行 JavaScript 特征（<script>/eval/fetch 等）时默认拒绝；明确确认后传 true，或设环境变量 CPT_MCP_ALLOW_UNSAFE_SCRIPT=1。',
      '适用边界：本工具改 <Content>（CDATA 原文）/ 提示文本 / 插入策略；改样式用 update_cell_style，改绑定类型用 set_cell_content_type，改控件值用 set_widget_value —— 四者勿混。',
      '公式闭环：content 以 "=" 开头时按公式处理——公式格（<O t="XMLable" class="com.fr.base.Formula">）原位替换公式正文并保持对象；普通文本格会升级为官方公式对象；脚本 <Content> 格要求改用 set_cell_content_type。其他对象内容（DSColumn/Image/图表）仍拒绝纯文本覆盖，换型走 set_cell_content_type(force:true)。',
    ].join('\n'),
  },
  'page.settings': {
    title: '页面设置全字段',
    usedBy: ['set_report_settings'],
    covers: [
      '纸张：paper（A3/A4/A5/B4/B5，不区分大小写）；自定义尺寸用 paperWidthMm + paperHeightMm（mm，须成对）。',
      '方向：orientation = 0 纵向 / 1 横向。',
      '页边距（mm）：marginTopMm（默认 6.85）/ marginBottomMm / marginLeftMm（默认 19.05）/ marginRightMm。',
      '居中：isHorizontalCenterOnPage / isVerticalCenterOnPage（布尔）。',
      '缩放：shrinkToFitMode = 0 不缩放 / 1 / 2 自适应等。',
      '页眉页脚高度：headerHeightMm / footerHeightMm（mm，>=0）。',
      '冻结行列：frozenColumn / frozenRow（>=0，从首列/首行起）；**都传 0 = 清除冻结**，整个参数缺省 = 保持模板原样。',
      'sheet：工作表（0 起索引或名称，缺省首表）。',
      '单位口径：文件内长度单位 1mm = 144000；本工具的 mm 参数会自动换算，不要自己乘。',
      '不传的字段一律保留模板原值（不是重置）。',
    ].join('\n'),
  },
  'script.eventsWeb': {
    title: 'WebWrite 事件枚举',
    usedBy: ['get_webwrite_js'],
    covers: [
      '填报 Web 事件名（<WebWriteContent> 下的 <Listener event="...">）：beforeimportexcel / afterimportexcel / beforeappend / afterappend / beforedelete / afterdelete / writesuccess / writefailure / beforewrite / afterwrite（官方 82 例实证）。',
      '作用域：WorkBook 级与各 sheet 级都有 WebWriteContent，返回值含 scope=workbook/sheet 与 sheet 索引用于区分。',
      '同 event 多脚本：一个 event 可以挂多个 <Listener>（真实模板如「不动销产品.cpt」有 6 个 afterload）——此时**必须传 match**（目标 JS 独有的特征子串，如 "OP_COL"/"makeRec"）精确定位；不传 match 且命中多个时直接拒绝，不会静默命中第一个。',
      '合并约定（硬约定）：同一容器内、相同事件类型的 JS 只允许一个 <Listener> 代码块（加载事件 onload/afterload 尤其如此）；已存在同 event 块时用 aggregate=true 追加/合并——同 event 多块会按文档顺序并回一块（不丢内容），不传 js 时只合并不删除，禁止另起新块。合并/写入后重跑 validate_cpt，不再报「事件唯一」即合规。',
      '读改写闭环：get_webwrite_js 读回 js（CDATA 原文）→ 改 → set_webwrite_js(event, js, match) 写回；每项带 jsLength/jsBytes/jsLines，改大块前先量字节数/行数对账。',
      '大块共享 Content 只改一段：用 set_webwrite_js({event, match?, patchFind, patchReplace}) 片段替换（literal、默认唯一命中、只改命中片段）；**整块替换若把 ≥4KB 的 Content 缩到 <60% 且少 ≥2KB 会被缩水护栏拒绝**（2026-11-03 事故：187KB afterload 被 8KB 替换，块数/语法/门禁全绿但功能全丢），确要整块替换传 allowShrink=true；关闭按需追加用 aggregate=true。',
      '容器归属（硬约束，2026-10-20）：模板级 <WebWriteContent> 必须位于 WorkBook 级 <ReportWebAttr> 内；放在 <Report> 等其它容器里时 FR 填报预览读不到（工具栏不显示、事件不执行），设计器保存还可能丢节点。validate_cpt 会对此报 error；用 set_webwrite_extras({path, repair:true}) 搬回即可，写工具栏/Web 事件的工具也会先自动修复并回报 repaired。',
      '四类 JS 落点别混：页面加载脚本 → set_report_js；报表事件（onload/afterload）→ set_report_listener；填报 Web 事件 → set_webwrite_js；单元格控件事件 → add_cell_listener。',
    ].join('\n'),
  },
  'views.compact': {
    title: '紧凑读视图',
    usedBy: ['read_cpt_compact'],
    covers: [
      'view 取值：overview（概览）/ cells（单元格）/ styles（样式）/ datasets（数据集）/ parameters（参数）/ fill（填报）/ grid（网格）/ page（页面设置）。',
      'selector：视图选择器，如 cells={sheet:0,range:"A1:F20"}；cellSet 视图支持 ranges/groupBy 并返回 selectionId，可直接驱动 batch_mutate_cells。',
      'cellStyle / hyperlink 视图必须提供 selector.column/row。',
      '分页：limit（每页条数，默认 20、上限 50）+ cursor（配合返回值 hasMore 翻页）。',
      'detail：summary（默认，裁剪长文本）/ standard（保留更多细节）。',
      '前置条件：必须先 record_cpt_read_intent 拿到 permitId（10 分钟有效、绑定路径与视图），再带 permitId 调用本工具。',
      '用途定位：批量了解现状、省往返；单点深读用对应的 get_* 工具（get_cells/get_styles/…）。',
    ].join('\n'),
  },
  'cpt.create': {
    title: '建模板罕用参数',
    usedBy: ['create_cpt'],
    covers: [
      'xmlVersion：模板 XML 版本号，11.5 用 "20211223"（默认），10.x 用 "20170720"。',
      'releaseVersion：设计器版本号，11.5 用 "11.5.0"（默认），10.x 用 "10.0.0"。',
      'withWebAttr：是否生成 ReportWebAttr（Web 属性节点）；默认 true，填报模板建议保留。',
      'webWrite：是否生成 WebWriteContent（填报相关 Web 属性容器，必须位于 WorkBook 级 ReportWebAttr 内）；默认 false —— **填报模板必须传 true**，否则 add_fill_submit / set_webwrite_js / 工具栏按钮都会因缺少容器而报错。build_report 传了 spec.toolbar 时会自动按 webWrite=true 生成（2026-10-20）。',
      '容器修复：历史模板若 WebWriteContent 缺容器或飘在 ReportWebAttr 外（FR 填报预览读不到），用 set_webwrite_extras({path, repair:true}) 一键修复（搬回并保留全部子节点）；写工具栏/Web 事件的工具发现错位也会先自动搬回并回报 repaired。',
      'rows / columns：初始网格行列数（默认 3 行 4 列）；title：报表标题（写入 ReportWebAttr.Title，缺省用文件名）。',
      '目标文件已存在时拒绝创建（不会覆盖既有模板）。',
    ].join('\n'),
  },
  'groups.lease': {
    title: '租约组目录',
    usedBy: ['request_deep_tool_access'],
    covers: renderLeaseDirectory(),
  },
  'spec.build_report': {
    title: 'build_report 的 spec 树（分节）',
    usedBy: ['build_report'],
    covers: [
      'spec 顶层键：title / rows / columns / headerRowCount / settings / grid / datasets / styles / cells / charts / fill / toolbar / parameters / parameterPanel / parameterWidgets / header / footer / hfStyle / sheets。',
      'title / rows / columns：报表大标题与网格规模；headerRowCount = 前 N 行为表头（自动套用表头行高 9mm=1296000、数据行 7mm=1008000；显式 grid.rowHeights 优先）。',
      'settings：纸张/边距/页面居中/缩放（语义同 page.settings 节）。**字段名带 Mm 后缀**：paperWidthMm / paperHeightMm / marginTopMm / marginBottomMm / marginLeftMm / marginRightMm / headerHeightMm / footerHeightMm；写成 marginTop 会被判为未知字段。grid：行高列宽（单位 1mm=144000）。',
      'datasets[]：{ name, connection, sql, excelFile?, parameters? } —— SQL 数据集或 Excel 文件数据集二选一；parameters 项 { name, defaultValue? }，defaultValue 以 "=" 开头时写成公式（用于下拉联动，见 cell.dictionary 节）。**写完 SQL 建议先用 run_dataset_sql_check 实跑并核对列名**。',
      'styles[]：{ fontName, fontSizePt, bold, horizontalAlignment(0=居中), backgroundColor, foregroundColor, border?, format? } —— 索引即 cells[].styleIndex（从 0 起）。语义见 styles.border / styles.fontAlign / styles.format 节。',
      'cells[]：{ column, row, content, contentType(text|formula|dsColumn), dsName, columnName, styleIndex, widget?, widgetDictionary?, expand?, summary? } —— 语义见 cell.widget / cell.dictionary / cell.expand 节。',
      'charts[]：图表定义（类型只用 column/line/pie，见 instructions 第六章）；fill：填报提交与字段绑定（语义同 fill_binding 族工具的入参）。',
      'toolbar[]：填报工具栏按钮（submit|verify|append-row|delete-row|import-append|import-clean）。',
      'parameters[] / parameterPanel{} / parameterWidgets[]：参数定义、面板属性与面板控件（语义同 param_panel 族工具）。**parameterWidgets[].dictionary 合法键**：type(db|table|custom|formula) / table / schema / ki / vi / kiName / viName / connection / dsName / formula / eFormula；自定义字典项写 **控件顶层的 items**（[{key,value}]），不是 dictionary.items。',
      'header / footer / hfStyle：页眉页脚文本与样式；sheets[]：多工作表定义（每表含自己的 grid/cells/fill）。',
      '整表重建语义（重要）：build_report 从骨架重建，**不继承原模板任何节点** —— 原模板的填报工具栏不会被带过来，不传 spec.toolbar 就没有按钮。若原模板工具栏非空而本次未传，返回值会带 toolbarNotice 预警并回显原按钮。',
      '取法：get_capabilities({tool:"build_report", section:"spec.build_report"})，section 支持前缀匹配（如 section:"spec."）。',
    ].join('\n'),
  },
  'ptc.recipes': {
    title: 'PTC（程序化工具调用）批量配方：把重复调用写成一段 TypeScript',
    usedBy: ['get_capabilities'],
    covers: [
      'PTC = DSH 的 Programmatic Tool Calling：模型写一段 TypeScript，在一次 run_code 里组合多个工具调用；只有 return/console.log 进入对话，中间结果 execution-local（不进上下文）。这是 DSH 的 preset 级呈现模式（tool-presentation: mode = native|ptc|both），cpt-mcp 侧无需任何配置即可被调用。',
      '何时值得用：同一工具重复 ≥5 次（如 30 列表头、20 个参数控件、批量高亮）、或固定多步序列（读→改→校验→门禁）。单次调用别用——固定开销（SDK 文本）反而变大。',
      '前提与限制：① 只有当前 agent 可见的工具进 SDK —— cpt-mcp 的深层工具（set_report_js / run_fr_engine_check / add_cell_highlight 等）未解锁时程序里也调不到，要先 request_deep_tool_access；② 写调用串行执行（读可 Promise.all，maxParallelSubCalls 默认 10）；③ run_code 默认超时 120s、上限 600s，大批量要分批；④ 程序状态每次清空（无跨调用变量）。',
      '结果读取：工具返回体是 MCP 内容块；cpt-mcp 的结果同时带 structuredContent（对象结果=对象；数组结果={items:[…]}），纯文本场景才 JSON.parse(content[0].text)。失败调用 reject ToolCallError（带 toolName），try/catch 后继续即可实现「批量里单条失败不中断」。',
      '配方 A · 批量加参数控件（优先用批量工具，一次调用替代 N 次）：await tools[\'mcp__cpt-mcp__add_parameter_widget_batch\']({ path, items: [{name:\'组别\',type:\'comboBox\',label:\'组别\',dictionary:{type:\'table\',dsName:\'ds1\',kiName:\'g\',viName:\'g\'},x:10,y:10,width:120,height:24}, …] }) → 返回 summary/results，summary.failed>0 时按 results 逐项补偿。',
      '配方 B · 批量高亮（斑马纹 + 负数标红）：await tools[\'mcp__cpt-mcp__add_cell_highlight_batch\']({ path, items: rows.flatMap(r => [{column:0,row:r,formula:\'row() % 2 = 0\',background:\'#F5F8FA\',scope:\'row\'}, {column:5,row:r,formula:\'$$$ < 0\',fontColor:\'#FF0000\'}]) })；字段名用 formula/background/fontColor/scope（别名 condition/effects/wholeRow 也会被自动纠正）。',
      '配方 C · 数据集 SQL 批量校验（替代外部 MCP 手工跑）：for (const sql of candidates) { const r = await tools[\'mcp__cpt-mcp__run_dataset_sql_check\']({ path, sql, maxRows: 5 }); if (r.bindingCheck?.missingInSql?.length) console.log(sql.slice(0,40), r.bindingCheck.missingInSql.map(m=>m.column)); } —— 只把差异打出来，明细不进上下文。',
      '配方 D · 改完一次性过门禁：const g = await tools[\'mcp__cpt-mcp__quality_gate_cpt\']({ path }); console.log(JSON.stringify({deliveryPass:g.deliveryPass, blockers:g.blockers?.length ?? 0})); 需要真实引擎结论时先 request_deep_tool_access({path, group:\'fr_engine\', reason:\'explicit_engine_check\'}) 再调 run_fr_engine_check。',
         '配方 E · 核验交付（替代 validate/gate/engine 三连）：const v = await tools[\'mcp__cpt-mcp__verify_cpt\']({ path, engine: true, expectations: { toolbarButtons: 2, hasText: [\'标题\'] } }); if (!v.ok) console.log(v.blockers); —— 一次拿结构+门禁+期望值对账+真引擎四层结论；写工具返回体也自带 selfCheck（CPT_MCP_AUTO_VERIFY 控制），平时看 selfCheck、交付前跑 verify_cpt。',
      '出错定位：program 里 catch (e) 后 e?.toolName 指出哪个工具失败、e?.message 是工具原文；把失败项聚合成数组 return，比逐次重试省一整轮。',
    ].join('\n'),
  },
  'spec.generate_report': {
    title: 'generate_report 的参数（分节）',
    usedBy: ['generate_report'],
    covers: [
      'source（必填，三选一形态）：{ connection, table } 走库表；{ connection, sql } 走自定义 SQL；{ excelFile, fromEnv? } 直接吃 Excel 文件数据集（fromEnv 默认 true 表示相对 %FR_HOME%/webapps/webroot）。',
      'fields（必填）：字段列表，从左到右排列；每项 { name, label?, type?, align?, widthMm?, result?, sort?, highlights?, summary? } —— **字段名以 smartFieldSchema 为准**：表头别名是 label（不是 title）、列宽是 widthMm（不是 width）、合计是 summary（不是 sum）；type 决定数字格式（money 自动 #,##0.00、date 用 yyyy-MM-dd）；align 是数字 0=居中/2=左/4=右/6=两端（写 "center" 会报 NaN）。',
      'dsName：数据集名，默认 ds1。',
      'options：布局与观感开关（大标题、斑马纹、负数标红、列宽自适应等）；不传则用引擎默认（表头配色 + 全部居中 + 千分位/日期格式）。',
      'chart：追加图表 { type: column|line|pie, category?, values?, title? }；只开放三类有官方实证的类型。',
      'fill：需要填报提交时的配置（目标表/连接/字段绑定/工具栏按钮）；**有 fill 时默认生成四按钮工具栏**（提交/校验/增行/删行），与 build_report 不传 toolbar 就没有按钮不同。',
      'theme：配色主题，取值 **blue / green / gray / dark / orange**（不是 set_template_theme 那套中文主题名——那个是模板主题，两回事）。',
      'header / footer：页眉页脚文本。',
      '取法：get_capabilities({tool:"generate_report", section:"spec.generate_report"})。',
    ].join('\n'),
  },
});

/** 工具 → 它外移出去的节（与每节 usedBy 双向一致；悬空即测试失败） */
export const SECTION_REFS = Object.freeze({
  get_capabilities: ['ptc.recipes'],
  request_deep_tool_access: ['groups.lease'],
  record_cpt_read_intent: [],
  read_cpt_compact: ['views.compact'],
  get_webwrite_js: ['script.eventsWeb'],
  create_cpt: ['cpt.create'],
  add_cell: ['cell.widget', 'cell.dictionary', 'cell.expand'],
  update_cell: ['cell.update'],
  add_style: ['styles.border', 'styles.fontAlign', 'styles.format'],
  update_cell_style: ['styles.border', 'styles.fontAlign', 'styles.scope'],
  set_cell_content_type: ['cell.contentType', 'cell.widget'],
  set_cell_span: ['cell.span'],
  set_report_settings: ['page.settings'],
  build_report: ['spec.build_report'],
  generate_report: ['spec.generate_report'],
});

/**
 * 取节说明（供 get_capabilities 分节下发）。
 * @param {string} [tool] 工具名；给定时返回该工具外移出去的节
 * @param {string} [section] 节键（支持前缀/后缀匹配，如 "styles" / "spec." / "cell.dictionary"）
 * @returns {{sections: Record<string, {title: string, body: string, usedBy: string[]}>, unknown: string[]}}
 */
export function selectSpecSections(tool, section) {
  const keys = Object.keys(SPEC_SECTIONS);
  let wanted = keys;
  if (tool) {
    const refs = SECTION_REFS[tool];
    if (!refs) {
      return { sections: {}, unknown: [`未知工具 ${tool}（已登记外移节的工具：${Object.keys(SECTION_REFS).join('、')}）`] };
    }
    wanted = refs;
  }
  if (section) {
    const hit = keys.filter((k) => k === section || k.startsWith(section) || k.endsWith(`.${section}`));
    if (hit.length === 0) {
      return { sections: {}, unknown: [`未登记的节 ${section}（可用节键：${keys.join('、')}）`] };
    }
    wanted = wanted.filter((k) => hit.includes(k));
  }
  return {
    sections: Object.fromEntries(wanted.map((k) => [
      k,
      { title: SPEC_SECTIONS[k].title, body: SPEC_SECTIONS[k].covers, usedBy: SPEC_SECTIONS[k].usedBy },
    ])),
    unknown: [],
  };
}

/**
 * 分节体系自检（启动/单测共用）：节键唯一、正文非空且两两不同、引用双向一致。
 * @returns {string[]} 问题清单（空数组 = 一致）
 */
export function specSectionProblems() {
  const problems = [];
  const keys = Object.keys(SPEC_SECTIONS);
  if (new Set(keys).size !== keys.length) problems.push('节键重复');
  const seen = new Map();
  for (const k of keys) {
    const body = SPEC_SECTIONS[k]?.covers;
    if (!body || !String(body).trim()) problems.push(`节正文为空：${k}`);
    else if (seen.has(body)) problems.push(`分节正文重复定义：${seen.get(body)} ≡ ${k}`);
    else seen.set(body, k);
    if (!SPEC_SECTIONS[k]?.usedBy?.length) problems.push(`节未声明 usedBy：${k}`);
  }
  for (const [tool, refs] of Object.entries(SECTION_REFS)) {
    for (const ref of refs) if (!SPEC_SECTIONS[ref]) problems.push(`${tool} 引用了未登记的节 ${ref}`);
  }
  for (const k of keys) {
    for (const t of SPEC_SECTIONS[k].usedBy) {
      if (!(SECTION_REFS[t] ?? []).includes(k)) problems.push(`节 ${k} 声明 usedBy=${t}，但 ${t} 未引用它（双向不一致）`);
    }
  }
  return problems;
}
