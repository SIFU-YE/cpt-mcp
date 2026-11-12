// cpt-mcp/lib/engine/spec.js
// build_report 工具入参的 结构化 Zod schema（zod v4）。
// 目的：把"语义化 spec"从宽松的 z.record(z.any()) 收紧为带类型/边界的结构化 schema，
// 让类型/必填/枚举/范围错误在 MCP 参数层即被拦截，而非等到运行期；
// 各字段用 .describe() 给出模型可见的中文说明（对齐语义：0=居中，与 sandbox2 成品模板实测一致）。
// 说明：公开 spec 的对象全部 strict；未知键必须显式加入 schema，避免模型把拼写错误
//       或未经验证的 FR 私有字段静默传递成“看似成功”的坏模板。
import { z } from 'zod';

const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, '颜色应为 #RRGGBB（如 #FFFFFF）');
const nonNegInt = z.number().int().min(0);
const cellRow = z.number().int().min(0);

// T1/S1 布尔参数围栏：z.coerce.boolean 会把字符串 "false"/"0" 静默转成 true。
// 与 server.js 同一口径：只接受 boolean 或 true/false/yes/no/1/0/on/off 字符串。
const boolish = z.union([z.boolean(), z.stringbool()]);

// T4/S5 工作表参数：空串曾静默指向第 1 个工作表。纯数字字符串转索引，其余按名称。
// server.js 与 build_report spec 共用此 schema，避免两处漂移。
// 用 ctx.addIssue 而非 throw —— 普通 Error 会穿透 safeParse，破坏调用方的错误处理约定。
export const sheetParamSchema = z.union([z.number().int().min(0), z.string()]).transform((v, ctx) => {
  if (typeof v === 'number') return v;
  const s = String(v).trim();
  if (!s) {
    ctx.addIssue({ code: 'custom', message: 'sheet 不能为空字符串（传索引数字或工作表名称）' });
    return z.NEVER;
  }
  return /^\d+$/.test(s) ? Number(s) : s;
});

/**
 * 条件属性（Highlight）schema —— add_cell_highlight 与 build_report/generate_report 共用。
 * 单一事实源：定义在 spec.js，server.js 直接引用，避免两处漂移。
 *
 * 条件三选一：formula（公式）/ compare（比较）/ conditions（多条件组合）
 * 效果可多选：background / fontColor / value / bold+fontSizePt+fontName
 */
export const compareSchema = z.object({
  op: z.string().min(1).describe(
    '比较运算符：eq / ne / gt / gte / lt / lte / beginsWith / notBeginsWith / endsWith / notEndsWith / contains / notContains（也接受 = != > >= < <=）'
  ),
  value: z.union([z.string(), z.number()]).describe('要比对的值：数字或字符串；以 = 开头则按公式解析'),
}).strict().describe('比较条件：等价于"当前单元格值 op value"，如 {op:"lt", value:0} 表示值为负');

export const highlightSchema = z.object({
  formula: z.string().optional().describe('条件公式（$$$=当前单元格值、row()=行号），如 "$$$ < 0" / "row() % 2 = 0" / "F7 - D7 > 0"'),
  compare: compareSchema.optional().describe('比较条件（与 formula 二选一），如 {op:"lt", value:0}'),
  conditions: z.array(z.object({
    formula: z.string().optional(),
    compare: compareSchema.optional(),
  }).strict()).min(1).optional().describe('多条件组合（与 formula/compare 二选一），每项给 formula 或 compare'),
  logic: z.enum(['and', 'or']).default('and').describe('conditions 的组合方式：and=全部满足（默认）/ or=任一满足'),
  background: hexColor.optional().describe('命中时背景色 #RRGGBB（斑马纹常用 #F5F8FA）'),
  fontColor: hexColor.optional().describe('命中时字体颜色 #RRGGBB（负数标红用 #FF0000）'),
  value: z.string().optional().describe('条件改值：命中时把显示值换成它，纯文本（"已完成"）或公式（"=sum(F4)"）'),
  bold: boolish.optional().describe('命中时加粗'),
  fontSizePt: z.coerce.number().min(1).max(72).optional().describe('命中时字号（磅）'),
  fontName: z.string().optional().describe('命中时字体名'),
  scope: z.enum(['cell', 'row']).default('cell').describe('作用范围：cell=当前单元格（默认）/ row=整行（斑马纹用）'),
  name: z.string().optional().describe('条件属性名（默认 条件属性N）'),
}).strict();

const styleSchema = z.object({
  id: z.string().optional().describe('样式名称（可选，仅标识用）'),
  fontName: z.string().optional().describe('字体名，如 微软雅黑'),
  fontSizePt: z.number().min(6).max(200).optional().describe('字号(pt)，成品模板：表头/标题 18、数据 14'),
  bold: z.boolean().optional().describe('是否加粗（表头/标题通常 true）'),
  italic: z.boolean().optional().describe('是否斜体'),
  backgroundColor: hexColor.optional().describe('背景色 #RRGGBB，如表头 #3836B3'),
  foregroundColor: hexColor.optional().describe('文字色 #RRGGBB'),
  horizontalAlignment: z.union([z.number(), z.string()]).optional().describe('水平对齐（官方 1559 样本仅出现这 4 个值）：0=居中（76.7%，表头/标题/数据行默认）、2=左对齐（文本列）、4=右对齐（数字/金额列）、6=两端对齐（极罕见）。禁止 1/3/5（官方样本零出现）'),
  underline: z.boolean().optional().describe('下划线（FRFont 位 4）'),
  strikethrough: z.boolean().optional().describe('删除线（FRFont 位 8）'),
  verticalAlignment: z.number().int().optional().describe('垂直对齐（官方样本仅出现 0/1/3）：0=居中（默认值，通常省略不写）、1=靠上、3=靠下'),
  border: z.object({
    top: z.object({ style: z.number().int().min(0), color: hexColor.optional() }).optional(),
    bottom: z.object({ style: z.number().int().min(0), color: hexColor.optional() }).optional(),
    left: z.object({ style: z.number().int().min(0), color: hexColor.optional() }).optional(),
    right: z.object({ style: z.number().int().min(0), color: hexColor.optional() }).optional(),
    outerTop: z.object({ style: z.number().int().min(0), color: hexColor.optional() }).optional(),
    innerHorizontal: z.object({ style: z.number().int().min(0), color: hexColor.optional() }).optional(),
  }).optional().describe('边框：{top,bottom,left,right,outerTop?,innerHorizontal?} 每边 {style 线型(1细实线/2/3/5/14…)，color?}'),
  textStyle: z.number().int().min(0).max(2).optional().describe('文本控制（官方样本 1/2；对照设计器：自动换行/单行等）'),
  paddingLeft: z.number().int().min(0).optional().describe('左缩进(px)'),
  paddingRight: z.number().int().min(0).optional().describe('右缩进(px)'),
  lineSpacing: z.number().min(0).optional().describe('行间距'),
  rotation: z.number().optional().describe('文本方向角度（-90=竖排等）'),
  format: z.object({
    class: z.string().optional().describe('格式类，如 com.fr.base.CoreDecimalFormat / TextFormat'),
    pattern: z.string().optional().describe('格式 pattern，如 #,##0.00 / yyyy-MM-dd'),
    roundingMode: z.number().optional().describe('舍入模式（CoreDecimalFormat）'),
  }).optional().describe('数字/日期格式（<Format> 子元素）'),
}).strict();

const datasetSchema = z.object({
  name: z.string().min(1, '数据集 name 必填'),
  connection: z.string().optional().describe('数据连接名（如 Doris），add_dataset 的 connection'),
  sql: z.string().optional().describe('SQL 文本，支持 ${参数名} 引用数据集参数'),
  excelFile: z.string().optional().describe('Excel 文件路径（.xls/.xlsx），与 connection/sql 二选一'),
  needColumnName: z.boolean().optional().describe('Excel 首行是否为列名（默认 true）'),
  fromEnv: z.boolean().optional().describe('Excel 路径是否相对 %FR_HOME%/webapps/webroot（默认 true）'),
  parameters: z.array(z.object({
    name: z.string().min(1),
    defaultValue: z.string().optional(),
  }).strict()).optional().describe('数据集参数 [{name, defaultValue?}]'),
}).strict();

const datasetParamSchema = z.object({
  name: z.string().min(1),
  defaultValue: z.string().optional(),
}).strict();

const cellSchema = z.object({
  column: cellRow,
  row: cellRow,
  content: z.string().optional().describe('文本内容；contentType=formula 时以 = 开头；dsColumn 时忽略'),
  contentType: z.enum(['text', 'formula', 'dsColumn']).optional().describe('内容类型：text(文本)/formula(公式)/dsColumn(数据集列，需 dsName+columnName)'),
  dsName: z.string().optional().describe('dsColumn 时的数据集名（对应 datasets[].name）'),
  columnName: z.string().optional().describe('dsColumn 时的字段名'),
  ci: z.number().int().min(0).optional().describe('dsColumn 动态列形态：源数据集列序号（0 起），替代 columnName（官方动态列模板即此形态）'),
  result: z.string().optional().describe('dsColumn 时的显示值变换公式（官方 <Result>，可选）。$$$ 代表原始值。例："$$$/10000" 元转万元、"ROUND($$$,0)" 取整、"货主城市+$$$" 拼接。官方 91.3% 的 DSColumn 不写此元素，仅在需要改写显示值时用'),
  // 扩展后排序（官方 <cellSortAttr>）。只能挂在 dsColumn 上；给别的 contentType 会报错。
  sort: z.array(z.object({
    area: z.string().min(1).describe('按哪一列排序（数据集列名，官方 sortArea）。通常填"别的列"，这就是帆软的高级排序'),
    direction: z.enum(['asc', 'desc']).describe('asc=升序 / desc=降序'),
  })).optional().describe('扩展后排序（官方 <cellSortAttr>，可选）。多条时按数组顺序作为优先级，例：[{area:"地区",direction:"asc"},{area:"销售额",direction:"desc"}] 表示先按地区升序、再按销售额降序。仅 dsColumn 可用；官方 92% 的样本不带排序'),
  styleIndex: nonNegInt.optional().describe('样式索引；styles 数组的第几个（0 起）。样式先定义，cell 引用索引'),
  style: styleSchema.optional().describe('内联样式对象（等价于在 styles 里定义一个，简化写法）'),
  widget: z.enum(['text', 'number', 'textarea', 'date', 'comboBox', 'checkBox', 'comboCheckBox', 'label', 'submit', 'appendRow', 'custom']).optional().describe('填报控件类型；custom 用 widgetClass 指定任意 class（如插件按钮）'),
  widgetItems: z.array(z.object({ key: z.any().optional(), value: z.any().optional() }).strict()).optional().describe('comboBox/comboCheckBox 字典项 [{key,value}]'),
  colspan: nonNegInt.optional().describe('跨列数'),
  rowspan: nonNegInt.optional().describe('跨行数'),
  widgetClass: z.string().optional().describe('widget=custom 时的控件全类名（如 com.fr.plugin.excel.ui.ExcelImportButton）'),
  pluginID: z.string().optional().describe('custom 控件插件 ID（可选）'),
  pluginVersion: z.string().optional().describe('custom 控件插件版本（可选）'),
  expand: z.object({
    dir: z.number().int().min(0).max(1).optional().describe('扩展方向：0=纵向扩展（明细表默认，数据向下铺开）/ 1=横向扩展（数据向右铺开）'),
    leftParent: z.union([z.string(), z.boolean()]).optional().describe('左父格：单元格引用如 "A2"（行号从 1 起）｜ "none"/true=显式「无」左父格（打断默认串联，让同排多组数据集各成块展开，官方 337 例）。不传=引擎自动跟随左邻'),
    upParent: z.string().optional().describe('上父格：单元格引用如 "A2"。横向扩展(dir=1)时使用'),
    order: z.number().int().min(1).max(2).optional().describe('扩展后排序：1=升序 / 2=降序（官方样本仅见 1、2）'),
    multiNumber: z.number().int().min(1).optional().describe('扩展倍数（官方样本见 1/5/6/7/10/25）'),
  }).strict().optional().describe('数据展开配置。**同行放多个 dsColumn 时建议省略本字段**：引擎会自动把首列设为主扩展格、其余列声明左父格。仅当需要横向扩展或自定义父格时才显式指定'),
  highlights: z.array(highlightSchema).optional()
    .describe('条件属性（条件格式）：满足条件时改变样式或显示值。典型：斑马纹 formula:"row() % 2 = 0" + background 浅色 + scope:"row"；负数标红 formula:"$$$ < 0"（或 compare:{op:"lt",value:0}）+ fontColor:"#FF0000"'),
  sheet: sheetParamSchema.optional().describe('工作表：0 起索引或名称（多 sheet 时建议显式传入）'),
}).strict();

const settingsSchema = z.object({
  paper: z.enum(['A4', 'A3', 'A5', 'B4', 'B5']).optional().describe('纸张预设（默认 A4）'),
  orientation: z.number().int().min(0).max(1).optional().describe('方向：0=纵向 / 1=横向'),
  paperWidthMm: z.number().positive().optional().describe('自定义纸宽(mm)'),
  paperHeightMm: z.number().positive().optional().describe('自定义纸高(mm)'),
  marginTopMm: z.number().min(0).optional().describe('上边距(mm)'),
  marginBottomMm: z.number().min(0).optional().describe('下边距(mm)'),
  marginLeftMm: z.number().min(0).optional().describe('左边距(mm)'),
  marginRightMm: z.number().min(0).optional().describe('右边距(mm)'),
  headerHeightMm: z.number().min(0).optional().describe('页眉高度(mm)'),
  footerHeightMm: z.number().min(0).optional().describe('页脚高度(mm)'),
  isHorizontalCenterOnPage: z.boolean().optional().describe('页面水平居中'),
  isVerticalCenterOnPage: z.boolean().optional().describe('页面垂直居中'),
  shrinkToFitMode: z.number().optional().describe('缩放模式(0不缩放/1/2自适应)'),
}).strict();

const gridSchema = z.object({
  rowHeights: z.array(z.number()).optional().describe('各行高【原生单位：1mm=144000，不做自动换算】；如 9mm=1296000、默认 5.03mm=723900。优先于 rowHeightMm'),
  rowHeightMm: z.array(z.number()).optional().describe('各行高（mm，模型友好的口径；自动按 1mm=144000 换算），例如 9 → 1296000'),
  columnWidths: z.array(z.number()).optional().describe('各列宽【原生单位：1mm=144000】；如 19.05mm 默认=2743200、22mm=3168000。优先于 columnWidthMm'),
  columnWidthMm: z.array(z.number()).optional().describe('各列宽（mm，自动按 1mm=144000 换算）'),
  rowCount: z.number().int().min(1).optional().describe('行数量（配合缺省行高平铺）'),
  columnCount: z.number().int().min(1).optional().describe('列数量（配合缺省列宽平铺）'),
  updateDefault: z.boolean().optional().describe('传数组时是否同步更新 defaultValue'),
}).strict();

const fillSchema = z.object({
  dsName: z.string().optional().describe('数据连接名（提交使用），如 Doris'),
  table: z.string().min(1, '目标表 table 必填').describe('填报目标表名'),
  schema: z.string().optional().describe('表 schema（可选）'),
  name: z.string().optional().describe('提交名称（默认 内置SQL1）'),
  bindings: z.array(z.object({
    field: z.string().min(1).describe('数据库字段名'),
    column: cellRow.optional().describe('绑定单元格列号(0 起)'),
    row: cellRow.optional().describe('绑定单元格行号(0 起)'),
    isKey: z.boolean().optional().describe('是否主键'),
    constant: z.union([z.string(), z.number()]).optional().describe('常量值绑定（提供后忽略 column/row）'),
  }).strict()).optional().describe('字段绑定列表：数据字段 ↔ 单元格坐标'),
  sheet: sheetParamSchema.optional().describe('提交所属工作表：0 起索引或名称'),
}).strict();

const chartValueSchema = z.union([
  z.string().min(1),
  z.object({
    name: z.string().min(1),
    agg: z.enum(['sum', 'avg', 'count', 'max', 'min', 'none']).default('sum'),
    label: z.string().optional(),
  }).strict(),
]);

const chartSchema = z.object({
  column: cellRow,
  row: cellRow,
  type: z.enum(['column', 'line', 'pie']).default('column'),
  dsName: z.string().min(1),
  category: z.string().min(1),
  values: z.array(chartValueSchema).min(1),
  title: z.string().optional(),
  colspan: z.number().int().min(1).max(1000).default(4),
  rowspan: z.number().int().min(1).max(1000).default(12),
  sheet: sheetParamSchema.optional(),
}).strict().describe('图表定义：仅支持已由本地 FR 样本验证的 column/line/pie，不接受自拼 XML');

const parameterPanelSchema = z.object({
  title: z.string().optional().describe('参数面板标题（默认 参数）'),
  showWindow: z.boolean().optional().describe('是否显示参数面板'),
  windowPosition: nonNegInt.optional().describe('面板位置'),
}).strict();

const parameterWidgetSchema = z.object({
  name: z.string().min(1, '控件 name 必填').describe('控件名（与数据集参数同名即自动绑定）'),
  type: z.enum(['comboBox', 'text', 'date', 'checkBox', 'label', 'submitButton']).optional().describe('控件类型：下拉/文本框/日期/复选/标签/查询按钮'),
  label: z.string().optional().describe('控件显示标签'),
  defaultValue: z.string().optional().describe('默认值'),
  text: z.string().optional().describe('submitButton 按钮文字（默认 查询）'),
  items: z.array(z.object({
    key: z.union([z.string(), z.number()]).optional(),
    value: z.union([z.string(), z.number()]).optional(),
  })).optional().describe('comboBox 字典项 [{key,value}]'),
  dictionary: z.object({
    type: z.enum(['db', 'table', 'custom', 'formula']).optional().describe('字典类型 db/table/custom/formula'),
    table: z.string().optional().describe('字典表名'),
    schema: z.string().optional(),
    dsName: z.string().optional().describe('数据集字典的数据集名'),
    connection: z.string().optional(),
    ki: z.number().int().optional().describe('数据库字典实际值列索引'),
    vi: z.number().int().optional().describe('数据库字典显示值列索引'),
    kiName: z.string().optional().describe('键字段名'),
    viName: z.string().optional().describe('值字段名'),
    formula: z.string().optional().describe('formula：值公式（如 =range(2010,2012)）'),
    eFormula: z.string().optional().describe('formula：显示公式（可缺省，如 =$$$+\'年\'）'),
  }).strict().optional(),
  x: z.number().optional().describe('控件 x 位置'),
  y: z.number().optional().describe('控件 y 位置'),
  width: z.number().optional().describe('控件宽'),
  height: z.number().optional().describe('控件高'),
}).strict();

/** 页眉页脚槽位内容：字符串=纯文本 / {text} / {formula} / {preset}（三种写法都收，避免逼模型猜 FR 公式语法） */
const hfContentSchema = z.union([
  z.string().min(1).describe('纯文本'),
  z.object({
    text: z.string().min(1).optional().describe('纯文本内容'),
    formula: z.string().min(1).optional().describe('FR 公式源码（可用 $$page_number / $$totalPage_number）'),
    preset: z.enum(['pageNumber', 'pageNumberShort']).optional()
      .describe('pageNumber="第X页/共Y页"；pageNumberShort="X / Y"'),
  }),
]);

const hfSectionSchema = z.object({
  left: hfContentSchema.optional().describe('左区'),
  center: hfContentSchema.optional().describe('中区'),
  right: hfContentSchema.optional().describe('右区'),
}).strict();

/** build_report 的 spec 入参 schema（顶层与嵌套对象均 strict，未知键直接拒绝） */
export const buildReportSpecSchema = z.object({
  title: z.string().optional().describe('报表标题（写入 ReportWebAttr.Title）'),
  sheetName: z.string().optional().describe('工作表名（默认 sheet1）'),
  rows: z.number().int().min(1).optional().describe('初始行数（骨架网格）'),
  columns: z.number().int().min(1).optional().describe('初始列数（骨架网格）'),
  headerRowCount: z.number().int().min(1).optional().describe('表头行数（前 N 行自动套用：行高 9mm=1296000；其余数据行 7mm=1008000；显式 grid.rowHeights 优先）'),
  settings: settingsSchema.optional().describe('页面设置：纸张/边距/页面居中/缩放'),
  header: hfSectionSchema.optional().describe('页眉：{left?,center?,right?}，每区可为纯文本 / {text} / {formula} / {preset:"pageNumber"}'),
  footer: hfSectionSchema.optional().describe('页脚：同页眉。常见用法 footer.center={preset:"pageNumber"} 放页码'),
  templateTheme: z.enum(['兼容主题', '经典浅灰', '兼容', '清爽科技', '经典深灰']).optional()
    .describe('模板整体主题（配色/图表调色板）。官方样本实测只有这 5 种，推荐 经典浅灰 或 清爽科技'),
  grid: gridSchema.optional().describe('网格：行高/列宽（mm）/行列数量'),
  datasets: z.array(datasetSchema).optional().describe('数据集列表（名称/连接/SQL/参数）'),
  styles: z.array(styleSchema).optional().describe('样式列表（先定义，cell 用 styleIndex 引用；成品：表头 18pt 加粗深蓝底、数据 14pt 居中）'),
  cells: z.array(cellSchema).optional().describe('单元格列表（坐标 + 内容/控件 + styleIndex）'),
  charts: z.array(chartSchema).optional().describe('图表列表（column/line/pie；数据集和字段必须已声明）'),
  fill: fillSchema.optional().describe('填报提交（目标表 + 字段↔单元格绑定）'),
  fills: z.array(fillSchema).optional().describe('多工作表/多提交配置；与 fill 二选一，优先使用 fills'),
  toolbar: z.array(z.enum(['submit', 'verify', 'append-row', 'delete-row', 'import-append', 'import-clean'])).optional().describe('填报工具栏按钮（submit=提交 / verify=校验 / append-row=增行 / delete-row=删行 / import-append=导入Excel追加 / import-clean=导入Excel覆盖）。默认值两条入口不同：generate_report（一句话直出）在有 fill 时默认四按钮全量；build_report 不自动补，不传即无按钮。重建既有模板时若原工具栏非空而未传本字段，返回会带 toolbarNotice 预警并回显原按钮（build_report 是整表重建，会清空原工具栏）'),
  parameters: z.array(datasetParamSchema).optional().describe('数据集参数 [{name, defaultValue?}]'),
  parameterPanel: parameterPanelSchema.optional().describe('参数面板容器'),
  parameterWidgets: z.array(parameterWidgetSchema).optional().describe('参数面板控件（与参数同名自动绑定）'),
  hfStyle: z.object({
    fontSizePt: z.number().positive().max(72).optional(),
    fontName: z.string().optional(),
  }).strict().optional().describe('页眉页脚样式（字号/字体）'),
  sheets: z.array(z.object({
    name: z.string().optional(),
    rows: z.number().int().min(1).optional(),
    columns: z.number().int().min(1).optional(),
  }).strict()).min(1).optional().describe('多工作表定义；sheets[0].name 为主工作表名'),
  check: z.boolean().optional().describe('生成后是否做三层自检（默认 true）'),
  noOverwrite: z.boolean().optional().describe('M37: 覆盖保护。默认（不传/true）目标已存在则抛错拒绝覆盖；显式 false 才原子替换并留 .bak-build-*'),
  webWrite: z.boolean().optional().describe('M37: 设为 true 时, 在 ReportWebAttr 内追加 WebWriteContent 节点（填报表/Web 模板推荐 true）'),
  withWebAttr: z.boolean().optional().describe('M37: 是否生成 ReportWebAttr 顶层节点（Web 模板推荐 true）'),
  imports: z.object({
    css: z.array(z.string().min(1)).optional().describe('CSS 引用列表（按序写入 <CSSImport>；FR 按 webroot 相对路径加载，如 css/index.css）'),
    js: z.array(z.string().min(1)).optional().describe('JS 引用列表（按序写入 <JSImport>；如 js/index.js；多文件保持给定顺序）'),
  }).strict().optional().describe('Web 页面静态资源引用（ReportWebAttr 内 CSSImport/JSImport；只收 webroot 相对路径。build_report 重建默认清空原引用，不传即无）'),
}).strict();
