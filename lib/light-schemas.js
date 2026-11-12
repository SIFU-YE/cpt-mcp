// cpt-mcp/lib/light-schemas.js —— 轻 entry（L1 路线 B）：广告 schema + 描述
//
// 为什么需要"广告 schema"与"校验 schema"分离：
//   工具表位于每个请求的前缀，`build_report.spec`(30,255 B) / `add_style.border`(1,098 B×2) /
//   `generate_report.options`(6,720 B) 这类**参数级文档**常驻上下文，占了 report 档静态表的 70%。
//   本模块给出这些工具的"轻 entry"：只广告高频字段 + 一句"去哪取完整说明"；
//   巨块参数的语义外移到 lib/spec-sections.js 的 SPEC_SECTIONS，由
//   get_capabilities({tool,section}) 按需分节下发。
//
// 硬约束（server.js 的 tool() 与 test/light-schema.test.js 共同保证）：
//   ① 广告层**只宽不严**：广告 schema 接受的值集合必须 ⊇ 完整 schema 接受的值集合。
//      否则会出现"模型照文档传参却被广告层拒绝"的假阴性。因此：
//        - 整数类参数广告为 number|string（完整 schema 用 intParam 接受数字串）；
//        - 布尔类参数广告为 boolean|string（完整 schema 用 boolish 接受 "true"/"yes"/"1" 等）；
//        - 枚举类参数广告为 string（完整 schema 才收紧到 enum）；
//        - 对象/数组类参数广告为宽松对象/数组（完整 schema 才逐字段校验）。
//   ② 广告层用 .passthrough()（见 server.js 的 tool()）：未广告的字段必须**透传**到处理器，
//      由处理器的完整 schema 复核 —— 绝不静默丢弃（server.js 顶部注释点名的最坏失败）。
//   ③ 描述 ≤300 B、单参数描述 ≤72 B（UTF-8 字节，唯一口径）。
//   ④ 参数 ≥3 的工具必须在 lib/spec-sections.js 的 SECTION_REFS 登记节引用（否则测试失败）。
import { z } from 'zod';

// —— 广告字段构造器（刻意宽松，见文件头 ①） ——
const P = () => z.string().min(1).regex(/\.cpt$/i).describe('CPT 绝对路径（.cpt 结尾）');
const S = (d) => z.string().describe(d);
const I = (d) => z.union([z.number(), z.string()]).describe(d);
const B = (d) => z.union([z.boolean(), z.string()]).describe(d);
const O = (d) => z.looseObject({}).describe(d);
const A = (d) => z.array(z.unknown()).describe(d);
const SH = (d) => z.union([z.number(), z.string()]).describe(d);

/**
 * 轻 entry 工具表：工具名 → { description, shape, required, advertised }。
 * - `shape` 是字段定义原样（供文档/测试阅读）；
 * - `advertised` 是把 required 之外的字段一律 `.optional()` 后的、**可直接注册的广告 schema**
 *   —— zod 的 raw shape 里字段默认必填，若不标 optional，模型少传一个可选参数就会被
 *   广告层直接拒掉（这正是本文件要避免的假阴性）；
 * - 真正校验仍由 server.js 里该工具原有的完整 schema 完成。
 * @type {Record<string, {description: string, shape: Record<string, import('zod').ZodTypeAny>, required: string[], advertised: Record<string, import('zod').ZodTypeAny>}>}
 */
const RAW_LIGHT_TOOLS = {
  // —— 门 / 协议 ——
  get_capabilities: {
    description: '工具地图：静态表清单、场景族租约目录（组名/成员/解锁调用）、推荐工作流、明确不支持项、当前档位与安全策略。取某工具的完整参数说明用 {tool,section}（分节下发）。查剩余额度加 {leases:true}。动手前先查这里。',
    shape: {
      tool: S('可选：取该工具的完整参数说明'),
      group: S('可选：只列某场景族的成员与解锁方式'),
      section: S('可选：只取某节参数说明，如 cell.dictionary'),
      leases: B('true=附带各租约剩余额度与过期秒数'),
    },
    required: [],
  },
  request_deep_tool_access: {
    description: '【租约】解锁场景族工具（组目录见 get_capabilities）。具名族多 20 次/1 小时，adhoc 分档更短（读 10 次/300s、写 3 次/180s、破坏 1 次/120s），用尽重租；额度查 {leases:true}；被拒也耗次数。未租调深层工具报 unknown tool，先租后调。',
    shape: {
      path: P(),
      group: S('场景族组名 | adhoc=按名直租 | auto=自动判组'),
      reason: S('组理由值；具名族/auto 可省略，adhoc 必填'),
      tools: A('adhoc/auto 用：要租的工具名数组'),
      target: O('cell_detail 用：{sheet,cell,requiredFields}'),
      failureId: S('cell_primitive 用：批量失败返回的 failureId'),
    },
    required: ['path', 'group'],
  },
  record_cpt_read_intent: {
    description: '声明本次会话要读哪个 .cpt（读取门禁前置）：给视图清单与读取目的，返回 permitId 供 read_cpt_compact 使用。',
    shape: {
      path: P(),
      views: A('本次要读取的视图，如 ["cells"]'),
      purpose: S('读取目的（一句话）'),
    },
    required: ['path', 'views', 'purpose'],
  },
  read_cpt_compact: {
    description: '紧凑读取 .cpt（overview/cells/styles/datasets/parameters/fill/grid/page 等视图，分页）；长文本会被裁剪，深读用对应 get_* 单工具。',
    shape: {
      path: P(),
      permitId: S('record_cpt_read_intent 返回的凭据'),
      view: S('读取视图：overview/cells/styles/...'),
      selector: O('视图选择器，如 {sheet:0,range:"A1:F20"}'),
      limit: I('每页条数（上限 50）'),
      cursor: I('分页游标（配合 hasMore）'),
      detail: S('summary=裁剪长文本；standard=保留细节'),
    },
    required: ['path', 'permitId', 'view'],
  },
  // —— 读 ——
  get_webwrite_js: {
    description: '读 WebWriteContent 监听器 JS 全文（填报 Web 事件）；不传 event 只列事件清单。改脚本前必读；每项带 jsLength/jsBytes/jsLines/sha256 供对账；大块只改一段用 set_webwrite_js 的 patchFind/patchReplace。',
    shape: {
      path: P(),
      event: S('Web 事件名，如 afterappend/beforewrite；不传=只列事件清单'),
      match: S('同一 event 多份脚本时按特征子串定位'),
      sheet: SH('工作表索引或名称（缺省 0）'),
    },
    required: ['path'],
  },
  // —— 写原语 ——
  create_cpt: {
    description: '新建空白 .cpt 模板（增量起点；目标已存在则拒绝）。新表首选 generate_report 自动成型（build_report 需 generator_full 租约）。初始行列/标题可用，其余用 set_grid / set_report_settings 调。填报模板务必传 webWrite=true。',
    shape: {
      path: P(),
      title: S('报表标题（写入 Report 节点）'),
      rows: I('初始行数'),
      columns: I('初始列数'),
      withWebAttr: B('是否生成填报属性节点'),
      webWrite: B('是否生成 WebWriteContent 节点'),
    },
    required: ['path'],
  },
  add_cell: {
    description: '在 (column,row) 新增单元格：文本/公式/DSColumn 列，可带填报控件；样式用 styleIndex（add_style 需 style_manage 租约，可复用既有样式）。完整参数（widget/expand/summary 等）见 get_capabilities({tool:"add_cell"})。',
    shape: {
      path: P(),
      column: I('列号（0 起）'),
      row: I('行号（0 起）'),
      content: S('文本/公式源码（formula 带不带 = 均可；dsColumn 忽略）'),
      contentType: S('text/formula/dsColumn'),
      dsName: S('dsColumn 模式的数据集名'),
      columnName: S('dsColumn 模式的数据集列名'),
      styleIndex: I('样式索引（add_style 创建或复用）'),
      widget: S('填报控件类型（text/comboBox/...）'),
      sheet: SH('工作表索引或名称（缺省首表）'),
    },
    required: ['path', 'column', 'row'],
  },
  update_cell: {
    description: '修改单元格（一次只做一类改动）：content/tooltip/插入策略/contentType 切换绑定类型/colspan,rowspan 跨行跨列。content 以 = 开头=改公式。合并了原 set_cell_content_type / set_cell_span。',
    shape: {
      path: P(),
      column: I('列号（0 起）'),
      row: I('行号（0 起）'),
      content: S('新内容；= 开头=改公式，否则纯文本'),
      tooltip: S('新的单元格提示文本'),
      contentType: S('text/formula/dsColumn/image（切换绑定类型）'),
      colspan: I('跨列数（1 或 null=取消；不传=不动）').nullable(),
      rowspan: I('跨行数（1 或 null=取消；不传=不动）').nullable(),
      sheet: SH('工作表索引或名称（缺省首表）'),
      allowUnsafeScript: B('确认后传 true 才允许可执行 JS'),
    },
    required: ['path', 'column', 'row'],
  },
  add_style: {
    description: '新建样式表并返回 styleIndex（单元格样式索引从 0 起）。属 style_manage 租约族（report 档默认隐藏）；日常改样式用 update_cell_style。边框/对齐/数字格式等完整取值见 get_capabilities({tool:"add_style"})。',
    shape: {
      path: P(),
      fontName: S('字体名，如 微软雅黑'),
      fontSizePt: I('字号（pt）'),
      bold: B('加粗'),
      backgroundColor: S('背景色 #RRGGBB'),
      horizontalAlignment: I('水平对齐：只能 0/2/4/6'),
      border: O('边框 {top,bottom,left,right}；取值见 capabilities'),
      format: O('数字/日期格式；取值见 capabilities'),
    },
    required: ['path'],
  },
  update_cell_style: {
    description: '改已有单元格样式（scope=cell 克隆后改，默认；scope=shared 就地改共享样式）。参数与 add_style 同源，完整取值见 get_capabilities({tool:"update_cell_style"})。',
    shape: {
      path: P(),
      column: I('列号（0 起）'),
      row: I('行号（0 起）'),
      backgroundColor: S('背景色 #RRGGBB'),
      fontName: S('字体名'),
      fontSizePt: I('字号（pt）'),
      bold: B('加粗'),
      border: O('边框 {top,bottom,left,right}；取值见 capabilities'),
      sheet: SH('工作表索引或名称（缺省首表）'),
    },
    required: ['path', 'column', 'row'],
  },
  set_cell_content_type: {
    description: '【已并入 update_cell({contentType,...})；默认隐藏，仅 cell_primitive 降级通道】只换绑定类型（控件保留）：text/formula/dsColumn/image；对象内容需 force=true。',
    shape: {
      path: P(),
      column: I('列号（0 起）'),
      row: I('行号（0 起）'),
      contentType: S('目标类型：text/formula/dsColumn/image'),
      formula: S('formula 模式的公式源码（带不带 = 均可）'),
      content: S('text/image 模式的内容'),
      force: B('true=目标格是对象内容时整块替换'),
      dsName: S('dsColumn 模式的数据集名'),
      columnName: S('dsColumn 模式的数据集列名'),
      sheet: SH('工作表索引或名称（缺省首表）'),
    },
    required: ['path', 'column', 'row', 'contentType'],
  },
  set_cell_span: {
    description: '【已并入 update_cell({colspan,rowspan})；默认隐藏，仅 cell_primitive 降级通道】就地改已有单元格的跨行跨列（合并/拆分），其余结构全保留。',
    shape: {
      path: P(),
      column: I('列号（0 起）'),
      row: I('行号（0 起）'),
      sheet: SH('工作表索引或名称（多表必填）'),
      colspan: I('跨列数（1 或 null=取消；不传=不动）'),
      rowspan: I('跨行数（1 或 null=取消；不传=不动）'),
    },
    required: ['path', 'column', 'row'],
  },
  set_report_settings: {
    description: '报表级页面设置（纸张/方向/页边距/缩放/冻结行列）。全部字段与默认值见 get_capabilities({tool:"set_report_settings"})。',
    shape: {
      path: P(),
      paper: S('纸张预设：A3/A4/A5/B4/B5/自定义'),
      orientation: I('0 纵向 / 1 横向'),
      frozenRow: I('冻结行数（0=不冻）'),
      frozenColumn: I('冻结列数（0=不冻）'),
      shrinkToFitMode: I('缩放模式（0 不缩放/1/2 自适应）'),
      sheet: SH('工作表索引或名称（缺省首表）'),
    },
    required: ['path'],
  },
  // —— spec 巨无霸（L1 路线 B：静态只留入口，spec 分节下发） ——
  build_report: {
    description: '用结构化 spec 一次成型生成整张报表（数据集/样式/单元格/填报/参数面板），自带三层自检。report 档默认隐藏（需租 generator_full）；spec 字段语义用 get_capabilities({tool:"build_report"}) 分节取，不要凭记忆写。',
    shape: {
      path: P(),
      spec: O('结构化 spec（字段语义按节取，见 capabilities）'),
      noOverwrite: B('默认 true=已存在则拒绝；false 才覆盖'),
      meta: B('生成参数留档到 <模板>.meta.json'),
    },
    required: ['path', 'spec'],
  },
  generate_report: {
    description: '给「字段列表 + 数据源」自动生成整张报表（SQL/布局/配色/格式/页眉页脚，可带图表）。完整参数（source/fields/options/chart 等）见 get_capabilities({tool:"generate_report"})。',
    shape: {
      path: P(),
      noOverwrite: B('默认 true=已存在则拒绝；false 才覆盖'),
      title: S('报表大标题（首行跨列）'),
      source: O('数据源：{connection,table|sql} 或 {excelFile}'),
      fields: A('字段列表（从左到右排列）'),
      dsName: S('数据集名（默认 ds1）'),
      fill: O('需要填报提交时的配置'),
      chart: z.union([z.boolean(), z.looseObject({})]).describe('追加图表：true=自动推导，或 {type,category,values}'),
    },
    required: ['path', 'source', 'fields'],
  },
};

/** 把 required 之外的字段一律标 optional：zod raw shape 里字段默认必填 */
function buildAdvertised(def) {
  return Object.fromEntries(
    Object.entries(def.shape).map(([k, v]) => [k, def.required.includes(k) ? v : v.optional()]),
  );
}

export const LIGHT_TOOLS = Object.freeze(Object.fromEntries(
  Object.entries(RAW_LIGHT_TOOLS).map(([name, def]) => [name, Object.freeze({
    ...def, advertised: buildAdvertised(def),
  })]),
));

/** 轻 entry 工具名（供 server.js 批量接线与测试断言） */
export const LIGHT_TOOL_NAMES = Object.freeze(Object.keys(LIGHT_TOOLS));
