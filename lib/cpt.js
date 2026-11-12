// cpt-mcp/lib/cpt.js —— CPT 结构读取：数据集 / 参数 / 单元格 / 填报配置
// 支持多工作表模板（WorkBook.Report 可能为对象或数组，如「sample-fill.cpt」含 sheet1/sheet2）
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { load } from './xml.js';
import { publicEmbeddedCommits, crossCheckEmbedded, scanReportSubmits } from './embedded.js';
// 颜色转换唯一实现（2026-10-29 去重：此前 cpt/edits/rules 各有一份 argbToHex）
import { argbToHex } from './engine/rules.js';
// parsed 树取用口径的唯一实现（2026-10-29 去重：此前 asArray/asReports/cdataOf/unescapeXml 各有一份）
import { asArray, asReports, unescapeXml } from './parsed-shape.js';

// F1 自卫：JS 块读写 hash 与分页（防“桥截断→据残块重写丢行”）。
// sha256 对 CDATA 原文（与读回 js 同一字符串），jsLength 为原文字符数；
// 分页切片只切返回的 js，jsLength/sha256 恒指全文，供写回前对账。
export const jsSha256 = (s) => createHash('sha256').update(String(s ?? ''), 'utf8').digest('hex');
// 字符分页：默认全量。保守口径——越界即错（offset>全文长度/负数/非整数抛错），
// 空返回不报错（offset==全文长度或 limit=0 返回空串）。
export function sliceJs(code, jsOffset, jsLimit, what = 'js') {
  const full = String(code ?? '');
  const n = full.length;
  let off = 0;
  if (jsOffset !== undefined && jsOffset !== null && String(jsOffset).trim() !== '') {
    const v = Number(jsOffset);
    if (!Number.isInteger(v) || v < 0) throw new Error(`${what}: jsOffset 非法 "${jsOffset}"（须为 0 起的整数）`);
    off = v;
  }
  let lim = null;
  if (jsLimit !== undefined && jsLimit !== null && String(jsLimit).trim() !== '') {
    const v = Number(jsLimit);
    if (!Number.isInteger(v) || v < 0) throw new Error(`${what}: jsLimit 非法 "${jsLimit}"（须为非负整数）`);
    lim = v;
  }
  if (off > n) throw new Error(`${what}: jsOffset=${off} 越界（全文仅 ${n} 字符）。请先无分页读回确认 jsLength 后再分段重读`);
  const end = lim == null ? n : Math.min(n, off + lim);
  return full.slice(off, end);
}

// 优先 CDATA（元素含 CDATA 时 fast-xml-parser 会把前后空白放入 #text，CDATA 主体在 __cdata；CDATA 为字面量区不反转义）
const val = (x) => {
  if (x == null) return null;
  if (typeof x !== 'object') return unescapeXml(String(x)); // 纯文本节点（字符串）含实体需反转义
  if ('__cdata' in x) return x.__cdata;
  if ('#text' in x) return unescapeXml(x['#text']); // 混合节点文本含实体需反转义
  return x;
};

export function overview(path) {
  const { raw, parsed } = load(path);
  const wb = parsed.WorkBook || {};
  const tdm = wb.TableDataMap || {};
  const datasets = asArray(tdm.TableData);
  const reports = asReports(parsed);
  const cells = reports.flatMap(({ report }) => asArray(report.CellElementList?.C));
  const floats = reports.flatMap(({ report }) => asArray(report.FloatElementList?.['com.fr.report.cell.FloatElement']));
  const submits = reports.flatMap(({ report }) => asArray(report.ReportWriteAttr?.SubmitVisitor));
  // M72 闭环：主题 + JS/监听器/工具栏概览（set_template_theme / set_report_js / set_webwrite_js /
  // set_toolbar_button_js / set_report_listener / add_cell_listener / set_fill_toolbar 写入后
  // 据此确认「已落盘生效」，不再是无从验证的黑盒）
  const ttm = wb.TemplateThemeAttrMark;
  const theme = ttm && typeof ttm === 'object'
    ? (ttm.TemplateThemeAttrMark?.['@_name'] ?? ttm['@_name'] ?? null)
    : null;
  const jsBlocks = reports.map(({ report, sheet }) => {
    // WebWriteContent 在 WorkBook 级 <ReportWebAttr> 内（真实样本实证）；兼容 Report 子级旧形态兜底
    const web = wb.ReportWebAttr?.WebWriteContent || report.WebWriteContent || {};
    const toolBars = web.ToolBars || {};
    const cellListeners = asArray(report.CellElementList?.C)
      .reduce((n, c) => n + asArray(c.Widget?.Listener).length + asArray(c.Listener).length, 0);
    // 官方结构：<ToolBars><ToolBarManager><ToolBar><Widget .../></ToolBar>...</ToolBarManager></ToolBars>
    const toolbarButtons = asArray(toolBars.ToolBarManager)
      .reduce((n, tbm) => n + asArray(tbm?.ToolBar).reduce((m, tb) => m + asArray(tb?.Widget).length, 0), 0);
    return {
      sheet,
      topJs: report.TopJS != null,
      // 2026-11-03：set_report_js 的 patch 模式/expectedSha256 需要旧 TopJS 的度量与 sha —— 概览直接给，
      // 让「读→核对→片段替换」闭环不依赖裸读 XML。仅在存在 TopJS 时出现（无块零 token 增长）。
      ...(typeof val(report.TopJS) === 'string'
        ? {
          topJsBytes: Buffer.byteLength(val(report.TopJS), 'utf8'),
          topJsLines: val(report.TopJS).split('\n').length,
          topJsSha256: jsSha256(val(report.TopJS)),
        }
        : {}),
      reportListeners: asArray(report.Listener).length,
      webwriteListeners: asArray(web.Listener).length,
      toolbarButtons,
      cellListeners,
    };
  });
  return {
    xmlVersion: wb['@_xmlVersion'] || wb.xmlVersion || null,
    releaseVersion: wb['@_releaseVersion'] || wb.releaseVersion || null,
    sheets: reports.map((r) => r.sheet),
    datasets: datasets.length,
    parameters: datasets.reduce((n, d) => n + asArray(d.Parameters?.Parameter).length, 0),
    cellCount: cells.length,
    floatElements: floats.length,
    fillSubmits: submits.length,
    theme,
    jsBlocks,
    // Web 页面静态资源引用（ReportWebAttr 内 <CSSImport>/<JSImport>；FR 按 webroot 相对路径加载服务器磁盘文件）
    imports: reportImportsFromRaw(raw),
    // 单元格内嵌提交（FreeButton 事件里的 Commit2DBJavaScript → Attributes+DMLConfig）。
    // 这类提交不在 ReportWriteAttr 下，fillSubmits 数不到；这里单独给出清单与总数。
    embeddedSubmits: (() => {
      try {
        const list = publicEmbeddedCommits(raw);
        return {
          count: list.reduce((n, c) => n + c.submitCount, 0),
          cells: list.map((c) => ({
            sheet: c.sheet,
            cell: c.cell,
            cellRef: c.cellRef,
            event: c.event,
            submitCount: c.submitCount,
            submits: c.submits.map((s) => `${s.name}→${s.table || '无表'}(${s.columnCount}字段)`),
          })),
        };
      } catch { return { count: 0, cells: [] }; }
    })(),
  };
}

/** 内嵌提交（Commit2DBJavaScript）清单：单元格/事件/提交名/目标表/字段列映射（写前核对用） */
export function embeddedSubmits(path) {
  const { raw } = load(path);
  const list = publicEmbeddedCommits(raw);
  // 报表级提交一并回显，并做「近表交叉核对」：同一逻辑数据被写成两个表名时
  // （主表/分表），字段列号不一致会把空值写回基表 —— 新品表 operation_record
  // 内嵌 c34 / 主提交 c29 就是这一类，只按表名严格相等永远抓不到。
  let reportLevel = [];
  let crossCheck = [];
  try {
    reportLevel = scanReportSubmits(raw).map((r) => ({
      index: r.index, name: r.name, className: r.className, table: r.table, fieldCount: (r.columns || []).length,
    }));
    crossCheck = crossCheckEmbedded(raw).map((x) => ({
      cell: x.cell ? { column: x.cell.column, row: x.cell.row } : null,
      submit: x.submit,
      vs: x.vs,
    }));
  } catch { /* 读侧降级：不影响主结果 */ }
  return {
    count: list.reduce((n, c) => n + c.submitCount, 0),
    blocks: list.length,
    cells: list,
    reportLevel,
    crossCheck,
    note: '本工具只读内嵌提交（按钮里的 Commit2DBJavaScript）；报表级 SubmitVisitor 见 reportLevel（完整字段用 get_fill_config）。'
      + 'crossCheck 非空 = 内嵌提交与报表级提交在同名字段上列号不一致（会导致写回时互相覆盖成 NULL），'
      + '用 update_embedded_submit(patch) 对齐后复跑本工具确认 crossCheck 清空。',
  };
}

/** 模板级 Web 页面静态资源引用（<ReportWebAttr> 内 CSSImport / JSImport 列表，保持文档顺序） */
export function reportImports(path) {
  const { raw } = load(path);
  return reportImportsFromRaw(raw);
}

function reportImportsFromRaw(raw) {
  const openM = raw.match(/<ReportWebAttr\b[^>]*>/);
  if (!openM || openM[0].trim().endsWith('/>')) return { css: [], js: [] };
  const openEnd = raw.indexOf('>', openM.index) + 1;
  const closeIdx = raw.indexOf('</ReportWebAttr>', openEnd);
  if (closeIdx < 0) return { css: [], js: [] };
  const seg = raw.slice(openEnd, closeIdx);
  const collect = (tag) => {
    const out = [];
    const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'g');
    let m;
    while ((m = re.exec(seg)) !== null) {
      const cdata = m[1].match(/<!\[CDATA\[([\s\S]*?)\]\]>/);
      const v = (cdata ? cdata[1] : m[1]).trim();
      if (v) out.push(v);
    }
    return out;
  };
  return { css: collect('CSSImport'), js: collect('JSImport') };
}

export function datasets(path) {
  const { parsed } = load(path);
  const tdm = parsed.WorkBook?.TableDataMap || {};
  return asArray(tdm.TableData).map((d, i) => ({
    index: i,
    name: d['@_name'] || `ds${i}`,
    class: d['@_class'] || null,
    connection: d.Connection?.DatabaseName ? val(d.Connection.DatabaseName) : (d.Connection?.['@_class'] || null),
    parameters: asArray(d.Parameters?.Parameter).map((p) => ({
      name: p.Attributes?.['@_name'] || null,
      defaultValue: p.O ? val(p.O) : null,
    })),
    sql: d.Query ? val(d.Query) : null,
  }));
}

export function parameters(path) {
  // P1-1 双层口径：数据集层（scope=dataset，供 SQL ${} 引用）+ 报表级（scope=report，
  // ReportParameterAttr 直接子级，面板控件同名绑定亦落此处；同名跨层合法，各自一条）。
  const dsParams = datasets(path).flatMap((d) =>
    d.parameters.map((p) => ({ dataset: d.name, scope: 'dataset', ...p }))
  );
  const { parsed } = load(path);
  const rpa = parsed.WorkBook?.ReportParameterAttr;
  const reportParams = asArray(rpa?.Parameter)
    .filter((p) => p && typeof p === 'object')
    .map((p) => ({
      dataset: null,
      scope: 'report',
      name: p.Attributes?.['@_name'] || null,
      defaultValue: p.O ? val(p.O) : null,
    }))
    .filter((p) => p.name);
  return [...dsParams, ...reportParams];
}

/** 读取 StyleList 全部样式：索引/字体/字号/加粗/背景/前景/对齐（兼容属性形式与子元素形式） */
export function styles(path) {
  const { parsed } = load(path);
  const list = parsed.WorkBook?.StyleList?.Style;
  const arr = Array.isArray(list) ? list : list ? [list] : [];
  return arr.map((s, i) => {
    const font = s.FRFont || {};
    const fgNode = font.foreground?.FineColor;
    const bg = s.Background || {};
    const colorNode = bg.color?.FineColor;
    return {
      styleIndex: i,
      fontName: font['@_name'] || null,
      bold: font['@_style'] === '1' || font['@_style'] === '3',
      italic: font['@_style'] === '2' || font['@_style'] === '3',
      fontSizePt: font['@_size'] != null ? Number(font['@_size']) / 4 : null,
      // 前景色：子元素 <foreground><FineColor/> 或属性 foreground="..." 两种形式
      foregroundColor: fgNode ? argbToHex(fgNode['@_color']) : font['@_foreground'] != null ? argbToHex(font['@_foreground']) : null,
      // 背景色：子元素 <color><FineColor/> 或属性 color="..." 两种形式
      backgroundColor: colorNode ? argbToHex(colorNode['@_color']) : bg['@_color'] != null ? argbToHex(bg['@_color']) : null,
      backgroundName: bg['@_name'] || null,
      // 水平对齐：0=居中（sandbox2 成品模板实测；无属性=默认）
      horizontalAlignment: s['@_horizontal_alignment'] != null ? Number(s['@_horizontal_alignment']) : null,
      // 字位：加粗(1)/斜体(2) 来自 style；下划线/删除线为独立属性（官方序列化方式）
      underline: font['@_underline'] != null ? (Number(font['@_underline']) !== 0) : false,
      strikethrough: font['@_isStrikethrough'] != null ? (String(font['@_isStrikethrough']) === 'true') : false,
      // 样式级属性
      verticalAlignment: s['@_vertical_alignment'] != null ? Number(s['@_vertical_alignment']) : null,
      textStyle: s['@_textStyle'] != null ? Number(s['@_textStyle']) : null,
      paddingLeft: s['@_paddingLeft'] != null ? Number(s['@_paddingLeft']) : null,
      paddingRight: s['@_paddingRight'] != null ? Number(s['@_paddingRight']) : null,
      lineSpacing: s['@_lineSpacing'] != null ? Number(s['@_lineSpacing']) : null,
      rotation: s['@_rotation'] != null ? Number(s['@_rotation']) : null,
      // 边框（Top/Bottom/Left/Right/OuterTop/InnerHorizontal：{style,color}）
      border: (() => {
        const bd = s.Border && typeof s.Border === 'object' && !Array.isArray(s.Border) ? s.Border : null;
        if (!bd) return null;
        const side = (n) => {
          if (!n || typeof n !== 'object') return null;
          return {
            style: n['@_style'] != null ? Number(n['@_style']) : null,
            color: n.color?.FineColor ? argbToHex(n.color.FineColor['@_color']) : null,
          };
        };
        return {
          top: side(bd.Top), bottom: side(bd.Bottom), left: side(bd.Left), right: side(bd.Right),
          outerTop: side(bd.OuterTop), innerHorizontal: side(bd.InnerHorizontal),
        };
      })(),
    };
  });
}

// 填报行完整性：单元格插入策略 <CellInsertPolicy><InsertPolicy><![CDATA[copy]]></InsertPolicy></CellInsertPolicy>
// 官方三态（engine jar com.fr.report.cell.cellattr.CellInsertPolicyAttr 常量池实证）：
//   "copy" 插入行复制上一行值 / "default" 走默认插入值 / "null" 不落盘该节点。
// 读取端兼容两种写法：标准子节点 <InsertPolicy> 与直接把值写在 CellInsertPolicy 文本里的兼容形态。
const insertPolicyOf = (cell) => {
  const node = cell?.CellInsertPolicy;
  if (node == null) return null;
  if (typeof node === 'object') {
    if (node.InsertPolicy != null) return val(node.InsertPolicy);
    const inline = val(node);
    return typeof inline === 'string' && inline.trim() !== '' ? inline.trim() : null;
  }
  return String(node).trim() || null;
};

/**
 * FR 设计器 JS 转义：`]A` 是设计器对 `]` 的落盘编码（**不是**污染）。
 *
 * M116 定案。此前 M83 起一直把代码位的 `]A` 当"可疑残字"，t7/t8 又因"官方样本 41 份也报错、
 * V8 比 FR 设计器严格"把它降级成 warning 并写进注释（validate.js §10）—— 那个归因是错的。
 * 全量官方语料（webapps/webroot/WEB-INF/reportlets，1550 份 / 336 个非空 JS 块 / 237 个 `]`）实测：
 *   · 含 `]A` 的模板 **915 份**；
 *   · 官方 JS 里 `]` 共 237 个，**100% 都写成 `]A`**（无一例外）；
 *   · 原文直接喂 V8：**55 块失败**（报错就是 `Unexpected identifier 'A'`）；
 *   · 先解码 `]A`→`]` 再喂 V8：**0 块失败**。
 * 即：不转义才是 FR 的形态，`]A` 经设计器还原为 `]` 后是正常 JS。
 * 沙箱 V3 文件同构：25 块原文报错 → 解码后 0 块（该文件根本没有 JS 问题）。
 *
 * ⚠️ 因此：**语法检查必须解码后再解析**；**"代码位出现 `]A`"不是缺陷、不得再报 warning**。
 * 读侧（read_cpt/get_cells 的 js 字段）保持原文所见即所得**不变**——出参要能与文件对账；
 * 解码只发生在"判定"这一步，不发生在"读回"这一步。
 * @param {string} code 文件原文 JS
 * @returns {string} 供语法解析用的解码文本（不改动文件、不影响读回值）
 */
export function decodeFrJsForParse(code) {
  return typeof code === 'string' ? code.split(']A').join(']') : code;
}

/**
 * M116：**失效**的可疑残字检测 —— 保留导出只为兼容既有调用点，恒返回 false。
 *
 * 历史（务必读）：M83 起本函数把代码位 `]A` 当"污染"，t7/t8 发现官方样本 41 份也命中后，
 * 结论被写成"官方样本自身含污染但设计器能打开（V8 比 FR 设计器严格）"，于是降 warning 收场。
 * **该归因错误**：`]A` 是设计器对 `]` 的正常转义（官方 237 个 `]` 100% 如此编码，见
 * decodeFrJsForParse 的实测数据）。当时"官方也中招"这一反常信号本该推翻"它是污染"的前提，
 * 却被用来给检测器找台阶——检测器越"灵敏"，越说明判据本身不成立。
 *
 * 现在：真正的 JS 缺陷由 checkReportJs（解码后 V8 解析）判定；`]A` 不再是缺陷信号。
 * @deprecated M116 起恒为 false；请用 checkReportJs 的语法结果。
 */
export function hasSuspiciousJsResidue(_code) {
  return false;
}

// ---- C-B（2026-11-03 会话审计）：设计器转义 `]A` 的模型可见元数据 ----
// 证据：sandbox4 会话 10-27 / 10-31 / 11-03 三次把读回的 `]A` 当"残字符污染"，其中 11-03 10:56
// session-de4f833e 用户第 3 次纠正"A 是设计器自带的标记语言不会影响代码正常运行"。M116 已在代码
// 注释里定案，但 README/docs/contract/工具输出都没有模型可见提示；check_report_js 解码后判定却不报
// 标记数。因此读数出口统一带元数据（只在 count>0 时出现，避免无标记模板的 token 增长），
// **读回原文语义不变**（仍是 CDATA 原文，可与文件逐字节对账）。
export const DESIGNER_ESCAPE_MARKER = ']A';
/** 固定提示语（读工具返回体里随 designerEscapes 一起出现，避免模型再把它当污染） */
export const DESIGNER_ESCAPE_HINT = '`]A` 是 FR 设计器对 `]` 的转义（落盘编码），不是污染/残字符；不要据此删改 JS。';

/** 数一段 JS 里设计器转义标记（`]A`）的个数；非字符串按 0 计 */
export function countDesignerEscapes(code) {
  if (typeof code !== 'string' || code === '') return 0;
  let n = 0;
  let i = code.indexOf(']A');
  while (i >= 0) { n += 1; i = code.indexOf(']A', i + 2); }
  return n;
}

/** 单段 JS 的 designerEscapes 元数据；无标记返回 null（调用方按"有才加"合并，零标记零 token） */
export function designerEscapesMeta(code) {
  const count = countDesignerEscapes(code);
  return count > 0 ? { marker: DESIGNER_ESCAPE_MARKER, count, hint: DESIGNER_ESCAPE_HINT } : null;
}

/** 聚合多段 JS 的 designerEscapes（读工具返回体顶层用）；无标记返回 null */
export function aggregateDesignerEscapes(codes) {
  let count = 0;
  let blocks = 0;
  for (const code of codes) {
    const n = countDesignerEscapes(code);
    if (n > 0) { count += n; blocks += 1; }
  }
  return count > 0
    ? { marker: DESIGNER_ESCAPE_MARKER, count, blocks, hint: DESIGNER_ESCAPE_HINT }
    : null;
}

/** 读取页面设置：纸张/边距/居中/缩放/水印（首个工作表） */
export function pageSettings(path) {
  const { parsed } = load(path);
  const first = asReports(parsed)[0]?.report;
  const rs = first?.ReportAttrSet?.ReportSettings;
  if (!rs) return null;
  const ps = rs.PaperSetting || {};
  return {
    orientation: ps['@_orientation'] != null ? Number(ps['@_orientation']) : 0,
    paperSizeUnit: ps.PaperSize ? { width: Number(ps.PaperSize['@_width']), height: Number(ps.PaperSize['@_height']) } : null,
    marginUnit: ps.Margin
      ? { top: Number(ps.Margin['@_top']), left: Number(ps.Margin['@_left']), bottom: Number(ps.Margin['@_bottom']), right: Number(ps.Margin['@_right']) }
      : null,
    shrinkToFitMode: rs['@_shrinkToFitMode'] != null ? Number(rs['@_shrinkToFitMode']) : null,
    isHorizontalCenterOnPage: rs['@_isHorizontalCenterOnPage'] === 'true',
    isVerticalCenterOnPage: rs['@_isVerticalCenterOnPage'] === 'true',
    headerHeight: rs['@_headerHeight'] != null ? Number(rs['@_headerHeight']) : null,
    footerHeight: rs['@_footerHeight'] != null ? Number(rs['@_footerHeight']) : null,
  };
}

/** 读取各工作表行高/列宽：defaultValue + CDATA 明细（原生单位与 mm 双口径；CDATA=实际每行值） */
export function gridSizes(path) {
  const { parsed } = load(path);
  const toMm = (u) => (u == null ? null : Math.round((u / 144000) * 1000) / 1000);
  const pick = (node) => {
    if (!node) return null;
    const dv = node['@_defaultValue'] != null ? Number(node['@_defaultValue']) : null;
    const cdata = (node['__cdata'] ?? node['#text'] ?? '').toString();
    const values = cdata.split(',').filter(Boolean).map((x) => Number(x.trim())).filter((x) => Number.isFinite(x));
    return { default: dv, defaultMm: toMm(dv), values, mm: values.map(toMm) };
  };
  return asReports(parsed).map(({ report, sheet, index }) => ({
    sheet, sheetIndex: index,
    rowHeights: pick(report.RowHeight),
    columnWidths: pick(report.ColumnWidth),
  }));
}

/** 读全部 cells (path, opts?)；opts.sheet 可按索引 0/1/... 或 sheet 名过滤；M40 修复 */
export function cells(path, opts = {}) {
  const { parsed } = load(path);
  const sheetFilter = opts.sheet;
  // 把 sheetFilter 标准化成 sheetIndex set; 数字=索引, 字符串=name
  const targetIdx = new Set();
  if (sheetFilter !== undefined) {
    const reports = asReports(parsed);
    if (typeof sheetFilter === 'number') {
      if (sheetFilter >= 0 && sheetFilter < reports.length) targetIdx.add(sheetFilter);
    } else if (typeof sheetFilter === 'string') {
      reports.forEach((r, i) => { if (r.sheet === sheetFilter) targetIdx.add(i); });
    }
    // U1: 过滤条件给定了却一个工作表都没匹配上（名称拼错 / 索引越界），
    // 必须返回空而不是静默放行全部 —— 与 locateSheet 的"未找到即报错"口径一致
    if (targetIdx.size === 0) {
      const known = reports.map((r) => r.sheet).join('、');
      throw new Error(`cells: 未找到工作表 "${sheetFilter}"（现有：${known || '无'}）`);
    }
  }
  return asReports(parsed).flatMap(({ report, sheet, index }) =>
    (targetIdx.size > 0 && !targetIdx.has(index)) ? [] :
    asArray(report.CellElementList?.C).map((c, i) => {
      // 单元格内容标准节点为 <O>（含 <O t=...> 对象形式）；<Content> 为兼容旧结构/脚本
      const o = c.O;
      const content = c.Content || {};
      const widget = c.Widget || {};
      // M72 闭环修复 / M106 订正：控件格的**单元格级**内容节点才是绑定载体（<O t="DSColumn"> 与
      // <Widget> 为兄弟节点，官方 1030/1030 控件格绑定均如此）。此处的 widgetValue 兜底只是
      // **历史兼容读取**：M106 之前 set_cell_content_type 曾把绑定误写进 <Widget><widgetValue><O t="DSColumn">，
      // 那种形态官方 0 例、设计器不认绑定，validate 现在会直接报 error。兜底仅为让存量坏文件仍可被读出定位。
      const wvO = widget.widgetValue?.O ?? null;
      const effO = o != null ? o : wvO;
      // <O> 内容三种形态：CDATA 对象 {__cdata}、纯文本字符串、{#text}（fast-xml-parser 非 CDATA 文本）
      let oText = null;
      if (effO != null && typeof effO === 'object') {
        if (effO['__cdata'] != null) oText = String(effO['__cdata']); // CDATA 为字面量区，不反转义
        else if (effO['#text'] != null) oText = unescapeXml(effO['#text']);
      } else if (typeof effO === 'string' && effO !== '') {
        oText = unescapeXml(effO);
      }
      const oType = effO && typeof effO === 'object' ? (effO['@_t'] || null) : null;
      const oClass = effO && typeof effO === 'object' ? (effO['@_class'] || null) : null;
      // 2026-10-29 公式闭环：官方公式是 <O t="XMLable" class="com.fr.base.Formula"> 对象，
      // 公式源码在 <Attributes> CDATA；此前 cells() 读不出正文（contentText=null）→
      // 模型只能 grep 原始 XML 才知道公式内容，也谈不上"改公式"。
      const formulaExpr = oClass === 'com.fr.base.Formula' ? (val(effO?.Attributes) ?? null) : null;
      return {
        index: i,
        sheet,
        sheetIndex: index,
        column: c['@_c'] != null ? Number(c['@_c']) : null,
        row: c['@_r'] != null ? Number(c['@_r']) : null,
        style: c['@_s'] != null ? Number(c['@_s']) : null,
        colspan: c['@_cs'] != null ? Number(c['@_cs']) : null,
        rowspan: c['@_rs'] != null ? Number(c['@_rs']) : null,
        tooltip: c.CellGUIAttr?.ToolTipText ? val(c.CellGUIAttr.ToolTipText) : null,
        // 填报行完整性：插入策略（copy=插入行复制上一行值）。update_cell 的 insertPolicy 写后可据此读回
        insertPolicy: insertPolicyOf(c),
        widgetClass: widget['@_class'] || null,
        widgetName: widget.WidgetAttr?.widgetName || null,
        // M82: 控件禁用态回显（set_cell_widget/add_cell disabled 写后可验收）
        widgetDisabled: widget.WidgetAttr?.['@_disabled'] === 'true',
        // M72 闭环：单元格级控件事件 Listener（add_cell_listener 写入）在此回读正文。
        // 落点有两处：有 <Widget> 时在 Widget 内；无 Widget 的普通格直接内嵌 <C> 子级（官方 FreeButton/普通格均此形态）
        // P0-2：js 原文所见即所得（CDATA 不反转义），出参可与文件逐字节对账。
        // 【M116】原 jsSuspicious 字段（代码位 ]A 标记）已删除：`]A` 是 FR 正常转义，
        // 该字段恒 false 只会误导读方去"修一个没坏的东西"。真语法缺陷看 check_report_js。
        // C-B：读回原文不变；仅当该段 JS 含设计器转义 `]A` 时附 designerEscapes 元数据（含固定提示），
        // 避免模型把正常转义当"残字符污染"去删改（2026-11-03 用户第 3 次纠正）。
        listeners: asArray(c.Listener).concat(asArray(widget.Listener)).map((l) => {
          const js = l?.JavaScript?.Content ? val(l.JavaScript.Content) : null;
          const esc = designerEscapesMeta(js);
          return {
            event: l?.['@_event'] || null,
            js,
            ...(esc ? { designerEscapes: esc } : {}),
          };
        }),
        // 内容类型：对象形式（<O t="DSColumn|Image|Formula...">）/ 文本（CDATA）/ 脚本（<Content>）/ 空
        contentKind: formulaExpr != null ? 'object:Formula' : oType ? `object:${oType}` : oText != null ? 'text' : content['__cdata'] != null ? 'script' : 'empty',
        contentText: formulaExpr != null ? formulaExpr : (oText != null ? oText : null),
        // 公式单元格的源码（含前导 =；非公式为 null）——改公式前先读这里，改后可用 update_cell(content:"=...") 原位更新
        formula: formulaExpr,
        contentObjectType: oType,
        contentClass: oClass,
        // 扩展信息（注意 FR 语义：无属性 <Expand/> 与 dir=0 走「默认左父格=左邻扩展格」，
        // 官方 789 个多列数据集行中 674 个全默认展开且工作正常；显式 left 只是自定义形态）
        expandDir: c.Expand?.['@_dir'] != null ? Number(c.Expand['@_dir']) : null,
        expandLeft: c.Expand?.['@_left'] || null,
        expandUp: c.Expand?.['@_up'] || null,
        expandLeftParentDefault: c.Expand?.['@_leftParentDefault'] || null,
      };
    })
  );
}

/** 读取参数面板（ReportParameterAttr）：标题/显示/控件列表（含 BoundsAttr 与参数项） */
export function parameterPanel(path) {
  const { parsed } = load(path);
  const rpa = parsed.WorkBook?.ReportParameterAttr;
  if (!rpa) return null;
  const layout = rpa.ParameterUI?.Layout;
  const widgetsRaw = layout?.Widget;
  const widgets = (Array.isArray(widgetsRaw) ? widgetsRaw : widgetsRaw ? [widgetsRaw] : []).map((w) => {
    const inner = w.InnerWidget || {};
    return {
      name: inner.WidgetName?.['@_name'] || null,
      class: inner['@_class'] || null,
      x: w.BoundsAttr ? Number(w.BoundsAttr['@_x']) : null,
      y: w.BoundsAttr ? Number(w.BoundsAttr['@_y']) : null,
      width: w.BoundsAttr ? Number(w.BoundsAttr['@_width']) : null,
      height: w.BoundsAttr ? Number(w.BoundsAttr['@_height']) : null,
      // M80: 可见性 + 默认值回显（update_parameter_widget 写后可验收，不再靠人眼）
      invisible: inner.WidgetAttr?.['@_invisible'] === 'true',
      defaultValue: inner.widgetValue?.O != null ? val(inner.widgetValue.O) : null,
      // M81: 标签字体/边框回显
      fontName: inner.FRFont?.['@_name'] ?? null,
      fontSize: inner.FRFont?.['@_size'] != null ? Number(inner.FRFont['@_size']) : null,
      borderStyle: inner.border?.['@_style'] != null ? Number(inner.border['@_style']) : null,
    };
  });
  const paramsRaw = rpa.Parameter;
  const params = (Array.isArray(paramsRaw) ? paramsRaw : paramsRaw ? [paramsRaw] : []).map((p) => ({
    name: p.Attributes?.['@_name'] || null,
    defaultValue: p.O ? val(p.O) : null,
  }));
  return {
    title: rpa.PWTitle ? val(rpa.PWTitle) : null,
    showWindow: rpa.Attributes?.['@_showWindow'] === 'true',
    windowPosition: rpa.Attributes?.['@_windowPosition'] != null ? Number(rpa.Attributes['@_windowPosition']) : null,
    useParamsTemplate: rpa.Attributes?.['@_useParamsTemplate'] === 'true',
    widgets,
    parameters: params,
  };
}

/**
 * 读 DMLConfig 里的提交条件。官方样本只有 FormulaCondition 能安全表达文本语义；
 * 其它 class（ListCondition/ObjectCondition）暂只回 class，公式置 null（不臆造）。
 */
function readSubmitCondition(dml) {
  const raw = dml?.Condition;
  const one = Array.isArray(raw) ? raw[0] : raw;
  if (one == null || typeof one !== 'object') return null;
  const cls = one['@_class'] ?? null;
  if (cls != null && cls !== 'com.fr.data.condition.FormulaCondition') return { class: cls, formula: null };
  return { class: cls, formula: one.Formula != null ? val(one.Formula) : null };
}

export function fillConfig(path) {
  const { parsed } = load(path);  // SubmitVisitor 位于 ReportWriteAttr 下（附件实证）；兼容 Report/ReportAttrSet 旧位置；遍历全部工作表
  const visitors = asReports(parsed).flatMap(({ report, sheet }) => {
    const collect = (v) => ({ v, sheet });
    return asArray(report.ReportWriteAttr?.SubmitVisitor).map(collect)
      .concat(asArray(report.SubmitVisitor).map(collect), asArray(report.ReportAttrSet?.SubmitVisitor).map(collect));
  });
  const submits = visitors
    .filter(({ v }) => v != null && typeof v === 'object')
    .map(({ v, sheet }, i) => {
      const cls = v['@_class'] || null;
      const isFreeSql = String(cls || '').includes('FreeSQLSubmiter');
      const dml = v.DMLConfig || {};
      const table = dml.Table || {};
      const dmlClass = isFreeSql ? null : (dml['@_class'] || null);
      const condition = readSubmitCondition(dml);
      return {
        index: i,
        sheet,
        name: v.Name ? val(v.Name) : `提交${i + 1}`,
        class: cls,
        // 2026-11-09（sandbox2/v8 能力缺口）：提交类型此前完全不可见，模型只能 grep XML。
        // InsertConfig=插入提交；IntelliDMLConfig=智能提交（Doris 等不支持智能提交的库要改 insert）。
        dmlConfigClass: dmlClass,
        submitType: dmlClass === 'com.fr.write.config.InsertConfig' ? 'insert'
          : dmlClass === 'com.fr.write.config.IntelliDMLConfig' ? 'intelligent'
            : dmlClass ? 'other' : null,
        // 2026-10-30（sandbox4/v1 实测缺口）：自由 SQL 提交既无 table 也无 ColumnConfig，
        // 旧实现按 `s.table || s.columns.length` 过滤会把它们**整条丢弃**（get_fill_config 看不到、
        // validate 也不校验），调用方只能靠 grep 原文确认。现在显式区分形态并回读参数声明。
        mode: isFreeSql ? 'free-sql' : 'built-in',
        dsName: v.Attributes?.['@_dsName'] || null,
        table: table['@_name'] || null,
        schema: table['@_schema'] || '',
        ...(isFreeSql ? {
          dbName: v.DBName != null ? val(v.DBName) : null,
          sql: v.SQL != null ? val(v.SQL) : null,
          parameters: asArray(v.Parameters?.Parameter).map((p) => ({
            name: p?.Attributes?.['@_name'] ?? null,
            value: p?.O != null ? val(p.O) : null,
          })).filter((x) => x.name),
        } : {}),
        columns: asArray(dml.ColumnConfig).map((cc) => ({
          field: cc['@_name'] != null ? unescapeXml(cc['@_name']) : null,
          isKey: cc['@_isKey'] === 'true',
          skipUnmodified: cc['@_skipUnmodified'] === 'true',
          column: cc.ColumnRow?.['@_column'] != null ? Number(cc.ColumnRow['@_column']) : null,
          row: cc.ColumnRow?.['@_row'] != null ? Number(cc.ColumnRow['@_row']) : null,
          constant: cc.O != null ? val(cc.O) : null, // 常量值绑定（无 ColumnRow）
        })),
        // 提交条件（sandbox19/v1 缺口补齐）：<Condition class="com.fr.data.condition.FormulaCondition">
        // <Formula><![CDATA[Y5=1]]></Formula></Condition> —— 旧实现完全不回读，模型只能 grep 原文；
        // 而列位调整后条件里的 A1 引用不会自动改，读不到就无法核对"提交会不会一行都不过滤"。
        condition,
        conditionClass: condition?.class ?? null,
      };
    })
    .filter((s) => s.table || s.columns.length || s.mode === 'free-sql');
  // 校验设置（ReportAttrSet.Verify / FillShortcutSet），取首个存在的工作表
  const firstReport = asReports(parsed)[0]?.report;
  const verify = firstReport?.ReportAttrSet?.Verify
    ? { failVerifySubmit: firstReport.ReportAttrSet.Verify['@_failVerifySubmit'] === 'true', value: firstReport.ReportAttrSet.Verify['@_value'] }
    : null;
  return { submits, verify, shortcut: firstReport?.ReportAttrSet?.FillShortcutSet ? 'configured' : null };
}

// ---- 填报提交拓扑矩阵（P0：跨 sheet 同目标/同主键检测） ----

/** 从自由 SQL 里尽力提取写目标表（只为矩阵分组，不作为 SQL 执行依据）。 */
function freeSqlWriteTables(sql) {
  const out = [];
  const re = /\b(?:insert\s+into|update|delete\s+from|replace\s+into)\s+[`"']?([A-Za-z0-9_$\u4e00-\u9fa5.]+)[`"']?/gi;
  let m;
  while ((m = re.exec(String(sql || '')))) {
    const t = m[1].split('.').pop();
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

function submitHasFilter(s) {
  if (!s) return false;
  if (s.condition && typeof s.condition === 'object') {
    if (s.condition.formula != null && String(s.condition.formula).trim() !== '') return true;
    // ListCondition / ObjectCondition 等结构化条件也视为有过滤（不臆测具体值）
    if (s.condition.class && s.condition.class !== 'com.fr.data.condition.FormulaCondition') return true;
  }
  return false;
}

function submitHasDiscriminator(s) {
  const cols = Array.isArray(s?.columns) ? s.columns : [];
  const discCols = cols.filter((c) => {
    const name = String(c.field || '');
    const value = c.constant;
    return /^(fill_type|source_sheet|source_type|sheet_id|sheet_name)$/i.test(name)
      || (value != null && /^(sheet\d*|sheet[_-]?[0-9]+|.*sheet.*)$/i.test(String(value)));
  });
  // 仅“有 fill_type 常量列”不够：它还必须进入主键，或提交条件真的按它过滤。
  // 否则目标表仍只按 id upsert，两个 sheet 的旧行仍可能互相覆盖（双 sheet 样本实测）。
  if (discCols.some((c) => c.isKey === true)) return true;
  const formula = String(s?.condition?.formula || '');
  return /(?:fill_type|source_sheet|source_type|sheet_id|sheet_name)/i.test(formula);
}

function matrixTargetOf(s) {
  if (s.mode === 'free-sql') {
    const tables = freeSqlWriteTables(s.sql);
    const db = s.dbName || '';
    if (!tables.length) return null;
    return {
      connection: db,
      schema: '',
      table: tables[0],
      target: `${db || '<未声明连接>'}.${tables[0]}`,
      extraTables: tables.slice(1),
      freeSql: true,
    };
  }
  if (!s.table) return null;
  const connection = s.dsName || '';
  const schema = s.schema || '';
  return {
    connection,
    schema,
    table: s.table,
    target: `${connection || '<未声明连接>'}.${schema ? `${schema}.` : ''}${s.table}`,
    extraTables: [],
    freeSql: false,
  };
}

/**
 * 从 fillConfig 的 submits 构建跨 sheet 提交拓扑。
 * 纯函数导出，便于单测；fillSubmitMatrix(path) 是文件入口。
 */
export function buildFillSubmitMatrix(submits = []) {
  const list = Array.isArray(submits) ? submits : [];
  const groups = new Map();
  for (const s of list) {
    const target = matrixTargetOf(s);
    if (!target) continue;
    const key = target.target;
    if (!groups.has(key)) {
      groups.set(key, {
        ...target,
        sheets: [],
        submits: [],
        keyFields: [],
        sameKey: false,
      });
    }
    const g = groups.get(key);
    if (!g.sheets.includes(s.sheet)) g.sheets.push(s.sheet);
    const keys = (s.columns || []).filter((c) => c.isKey).map((c) => String(c.field || '')).filter(Boolean);
    for (const k of keys) if (!g.keyFields.includes(k)) g.keyFields.push(k);
    g.submits.push({
      index: s.index,
      sheet: s.sheet,
      name: s.name,
      mode: s.mode,
      submitType: s.submitType,
      keyFields: keys,
      hasFilter: submitHasFilter(s),
      hasDiscriminator: submitHasDiscriminator(s),
      condition: s.condition?.formula ?? null,
    });
  }

  const warnings = [];
  const targetGroups = [];
  for (const g of groups.values()) {
    if (g.sheets.length < 2) continue;
    g.sheets.sort((a, b) => a - b);
    // 同一目标下每个 sheet 的主键集合是否一致（取交集后与每个 sheet 比）
    const keySets = g.submits.map((s) => new Set(s.keyFields));
    g.sameKey = keySets.length > 1 && keySets.every((set) => set.size === keySets[0].size
      && [...set].every((k) => keySets[0].has(k)));
    const noFilter = g.submits.every((s) => s.hasFilter !== true);
    const anyDiscriminator = g.submits.some((s) => s.hasDiscriminator === true);
    const highRisk = g.sameKey && !g.submits.every((s) => s.hasDiscriminator === true);
    targetGroups.push({
      target: g.target,
      connection: g.connection,
      schema: g.schema,
      table: g.table,
      sheets: g.sheets,
      keyFields: g.keyFields,
      sameKey: g.sameKey,
      allSubmitsUnfiltered: noFilter,
      hasSheetDiscriminator: anyDiscriminator,
      severity: 'warning',
      risk: highRisk ? 'shared-target-same-key-no-discriminator' : 'shared-target',
    });
    warnings.push({
      code: 'FILL_SHARED_TARGET',
      severity: 'warning',
      location: `提交目标 ${g.target}`,
      message: `工作表 ${g.sheets.join('、')} 都提交到 ${g.target}`
        + (g.keyFields.length ? `（主键 ${g.keyFields.join(',')}）` : '')
        + (highRisk
          ? '，且没有把来源 sheet 判别字段纳入主键/提交条件：提交一个 sheet 时另一个 sheet 的旧行也可能被 upsert，存在新数据被旧数据覆盖/回退的风险。'
          : '；请确认这是有意共享目标，并确保每个 sheet 的提交条件/主键能区分来源。'),
      fix: '给每个 sheet 增加 fill_type/source_sheet 常量列并纳入主键或提交流条件（update_fill_submit/update_fill_binding），或拆分目标表；改后重跑 validate_cpt 确认告警消失。',
    });
  }

  const sheets = [];
  for (const s of list) {
    const t = matrixTargetOf(s);
    sheets.push({
      index: s.index,
      sheet: s.sheet,
      name: s.name,
      mode: s.mode,
      submitType: s.submitType,
      target: t ? t.target : null,
      keyFields: (s.columns || []).filter((c) => c.isKey).map((c) => String(c.field || '')).filter(Boolean),
      hasFilter: submitHasFilter(s),
      hasDiscriminator: submitHasDiscriminator(s),
    });
  }
  return {
    sheetCount: new Set(list.map((s) => s.sheet)).size,
    submitCount: list.length,
    sheets,
    targetGroups,
    warnings,
    summary: {
      sharedTargets: targetGroups.length,
      highRiskTargets: targetGroups.filter((g) => g.risk !== 'shared-target').length,
      needsWriteSimulation: targetGroups.length > 0,
    },
  };
}

/** 文件入口：读取 .cpt 并返回提交拓扑矩阵。 */
export function fillSubmitMatrix(path) {
  return buildFillSubmitMatrix(fillConfig(path).submits);
}

// ---- S2 数据集引用完整性 ----

/** TableDataMap 中已声明的数据集名集合（任何 TableData 子类都算：SQL/Excel/树） */
export function datasetNamesOf(parsed) {
  const tdm = parsed.WorkBook?.TableDataMap || {};
  return new Set(asArray(tdm.TableData).map((d) => d['@_name']).filter(Boolean));
}

/**
 * M83 check_report_js：扫描模板内全部 JS 块并做语法检查（只解析不执行）。
 *
 * 背景：sandbox7 实测——粘贴防卡改造少写一个 `}`，validate/gate/引擎加载全绿，
 * 填报预览才报 SyntaxError。MCP 全链路没有任何环节解析 JS，本工具补该缺口。
 *
 * 覆盖：TopJS / 报表事件 / 填报事件（WebWrite）/ 单元格控件事件+单元格事件 /
 * 工具栏按钮 JS / 单元格超链 script。校验用 new vm.Script（V8 解析器，与浏览器
 * 同源语法）；FR 把这些片段当函数体/事件槽执行，顶层 return 合法，故 raw 失败时
 * 再试函数体包裹——两次都失败才判错（误报空间只剩 import/export 模块语法，
 * 这些槽位本就不支持模块）。
 * 只读，不改文件。
 */
/** 读取报表级 Listener（<Listener event="..."> 的 JS 全文）：event 精确匹配，可选 match 特征子串
 *  在同 event 多 Listener 时精确定位。返回 [{event, className, js, jsLength(字符数), jsBytes(UTF-8 字节), jsLines(行数), sha256, sheet, index}]，
 *  无匹配返回 []。jsBytes/jsLines 用于整块替换前对账（与 set_report_listener 的缩水护栏同口径）。
 *  与 set_report_listener 的 match 口径一致：读回的 js 原文可直接改后写回（CDATA 字面量区）。 */
export function reportListener(path, { event, match, sheet, jsOffset, jsLimit } = {}) {
  const { parsed } = load(path);
  const out = [];
  // C-B：按全文（不是分页切片）统计设计器转义标记，返回体顶层给聚合元数据
  const fullCodes = [];
  // 模板级 <ReportWebAttr><WebPageContent>（分页预览）监听器：官方 1550 份中 528 份有该容器、
  // 50 份挂 Listener（全部 afterload）。旧实现只扫 Report 子级，导致 get_report_listener
  // 看不到用户实际要改的分页预览 afterload；这里按 area=webpage/scope=workbook 纳入读闭环。
  const wb = parsed.WorkBook ?? {};
  const wbPage = wb.ReportWebAttr?.WebPageContent ?? wb.ReportAttr?.WebPageContent;
  if (wbPage) {
    for (const l of asArray(wbPage.Listener)) {
      const ev = l?.['@_event'];
      if (event !== undefined && event !== null && ev !== String(event)) continue;
      const code = val(l?.JavaScript?.Content);
      if (typeof code !== 'string') continue;
      if (match !== undefined && match !== null && String(match).trim() !== '' && !code.includes(String(match))) continue;
      fullCodes.push(code);
      out.push({
        event: ev ?? null,
        className: l?.JavaScript?.['@_class'] ?? null,
        js: sliceJs(code, jsOffset, jsLimit, 'get_report_listener'),
        jsLength: code.length,
        jsBytes: Buffer.byteLength(code, 'utf8'),
        jsLines: code.split('\n').length,
        sha256: jsSha256(code),
        sheet: null,
        index: null,
        area: 'webpage',
        scope: 'workbook',
      });
    }
  }
  for (const { report, sheet: sname, index } of asReports(parsed)) {
    if (sheet !== undefined && sheet !== null) {
      const want = typeof sheet === 'number' ? index : String(sheet);
      const have = typeof sheet === 'number' ? index : sname;
      if (String(want) !== String(have)) continue;
    }
    for (const l of asArray(report.Listener)) {
      const ev = l?.['@_event'];
      if (event !== undefined && event !== null && ev !== String(event)) continue;
      const code = val(l?.JavaScript?.Content);
      if (typeof code !== 'string') continue;
      if (match !== undefined && match !== null && String(match).trim() !== '' && !code.includes(String(match))) continue;
      fullCodes.push(code);
      out.push({
        event: ev ?? null,
        className: l?.JavaScript?.['@_class'] ?? null,
        js: sliceJs(code, jsOffset, jsLimit, 'get_report_listener'),
        jsLength: code.length,
        jsBytes: Buffer.byteLength(code, 'utf8'),
        jsLines: code.split('\n').length,
        sha256: jsSha256(code),
        sheet: sname,
        index,
        area: 'report',
      });
    }
    // M99-D2 WebPageContent（分页预览）监听器同样可见（location 前缀区分容器，不与报表事件混淆）
    for (const l of asArray(report.WebPageContent?.Listener)) {
      const ev = l?.['@_event'];
      if (event !== undefined && event !== null && ev !== String(event)) continue;
      const code = val(l?.JavaScript?.Content);
      if (typeof code !== 'string') continue;
      if (match !== undefined && match !== null && String(match).trim() !== '' && !code.includes(String(match))) continue;
      fullCodes.push(code);
      out.push({
        event: ev ?? null,
        className: l?.JavaScript?.['@_class'] ?? null,
        js: sliceJs(code, jsOffset, jsLimit, 'get_report_listener'),
        jsLength: code.length,
        jsBytes: Buffer.byteLength(code, 'utf8'),
        jsLines: code.split('\n').length,
        sha256: jsSha256(code),
        sheet: sname,
        index,
        area: 'webpage',
      });
    }
  }
  // C-B：读回原文不变（js 仍是 CDATA 原文）；另附设计器转义元数据，避免模型把 `]A` 当污染。
  const designerEscapes = aggregateDesignerEscapes(fullCodes);
  return {
    action: 'get_report_listener', event: event ?? null, match: match ?? null, count: out.length, listeners: out,
    ...(designerEscapes ? { designerEscapes } : {}),
  };
}

/** 读取 WebWriteContent 监听器（填报 Web 事件 <Listener event="..."> 的 JS 全文）：
 *  覆盖 WorkBook 级 <ReportWebAttr><WebWriteContent> 与各 sheet Report 子级旧形态。
 *  event 精确匹配；同 event 多 Listener 时传 match 特征子串精确定位（与 set_webwrite_js 同口径）。
 *  返回 {event, match, count, listeners:[{event, className, js, jsLength(字符数), jsBytes(UTF-8 字节), jsLines(行数), sha256, scope(workbook/sheet), sheet}]}——
 *  js 为 CDATA 原文，可改后经 set_webwrite_js 写回；改大块前用 jsBytes/jsLines 对账（写侧整块替换有缩水护栏，
 *  只改片段用 set_webwrite_js({event, patchFind, patchReplace})）。只读，不改文件。 */
export function webwriteListener(path, { event, match, sheet, jsOffset, jsLimit } = {}) {
  const { parsed } = load(path);
  const wb = parsed.WorkBook ?? {};
  // 不传 event → 只列事件清单（浏览器式"先看有哪些事件"，避免模型盲目猜事件名）
  const listing = event === undefined || event === null;
  const out = [];
  // C-B：只在真的返回 JS 正文时统计设计器转义标记（清单模式不含正文，不占 token）
  const fullCodes = [];
  const collect = (wwc, scope, sname, index) => {
    if (!wwc || typeof wwc !== 'object') return;
    for (const l of asArray(wwc.Listener)) {
      const ev = l?.['@_event'];
      if (!listing && ev !== String(event)) continue;
      const code = val(l?.JavaScript?.Content);
      if (typeof code !== 'string') continue;
      if (match !== undefined && match !== null && String(match).trim() !== '' && !code.includes(String(match))) continue;
      if (!listing) fullCodes.push(code);
      const base = { event: ev ?? null, className: l?.JavaScript?.['@_class'] ?? null };
      const metrics = { jsLength: code.length, jsBytes: Buffer.byteLength(code, 'utf8'), jsLines: code.split('\n').length, sha256: jsSha256(code) };
      out.push(listing
        ? { ...base, ...metrics, scope, sheet: sname, index }
        : { ...base, js: sliceJs(code, jsOffset, jsLimit, 'get_webwrite_js'), ...metrics, scope, sheet: sname, index });
    }
  };
  const wbWeb = wb.ReportWebAttr?.WebWriteContent;
  collect(wbWeb, 'workbook', null, null);
  for (const { report, sheet: sname, index } of asReports(parsed)) {
    if (sheet !== undefined && sheet !== null) {
      const want = typeof sheet === 'number' ? index : String(sheet);
      const have = typeof sheet === 'number' ? index : sname;
      if (String(want) !== String(have)) continue;
    }
    const web = report.WebWriteContent;
    if (web && web !== wbWeb) collect(web, 'sheet', sname, index);
  }
  if (listing) {
    return {
      action: 'get_webwrite_js', event: null, match: match ?? null, count: out.length,
      events: out,
      hint: out.length > 0
        ? '未传 event：这是事件清单（不含 JS 正文）。传 event（可加 match/sheet）读取对应 JS 全文。'
        : '模板内没有 WebWriteContent 监听器（填报 Web 事件）；写事件 JS 用 set_webwrite_js。',
    };
  }
  // C-B：读回原文不变（js 仍是 CDATA 原文），仅追加 `]A` 转义元数据（无标记不出现）。
  const designerEscapes = listing ? null : aggregateDesignerEscapes(fullCodes);
  return {
    action: 'get_webwrite_js', event: event ?? null, match: match ?? null, count: out.length, listeners: out,
    ...(designerEscapes ? { designerEscapes } : {}),
  };
}

/** 枚举模板内全部 JS 块（供 checkReportJs 语法扫描与 M94 事件唯一性共用）。
 *  container：同一容器标识（workbook 级填报 / 表级报表事件 / 表级填报 / 模板级分页|预览事件 /
 *  单元格 / 工具栏按钮）；event：Listener 事件名（TopJS/按钮JS/超链无事件则为 null，不参与唯一性判定）。
 *
 *  2026-11-03 审计修复（C-A）：旧实现只读 **Report 子级** WebPageContent（官方 1550 份实测 0 例），
 *  真正落点 WorkBook 级 <ReportWebAttr><WebPageContent> 整类漏扫 —— V3 审批模板原始 6 个
 *  `<JavaScript>` 节点 check_report_js 只报 5 块（漏的正是分页预览 afterload），js-baseline 也没有
 *  对应分类，块丢失时门禁完全看不见。官方语料落点统计：
 *    · ReportWebAttr.WebPageContent 528 份，其中 50 份挂 Listener（全部 afterload）；
 *    · ReportWebAttr.WebViewContent 63 份，其中 3 份挂 Listener；
 *    · Report 子级 WebPageContent/WebWriteContent 均 0 例（保留兼容读取，勿删）。
 *  写侧口径对照 lib/edits.js 的 TOOLBAR_HOST_NAME：page/view 工具栏同样在模板级容器里，旧 jsBlocks
 *  只扫 WebWrite 宿主 → 那 158 份 page ToolBars（17 个按钮 JS）同样漏扫，一并补齐。 */
export function jsBlocks(parsed) {
  const wb = parsed.WorkBook ?? {}; const reports = asReports(parsed);
  const blocks = [];
  const jsCodeOf = (jsNode) => {
    if (!jsNode || typeof jsNode !== 'object') return null;
    const s = val(jsNode.Content);
    return typeof s === 'string' ? s : null;
  };
  const pushListener = (container, prefix, l) => {
    const code = jsCodeOf(l?.JavaScript);
    if (code == null) return;
    blocks.push({ container, event: l?.['@_event'] ?? null, location: `${prefix}[${l?.['@_event'] ?? '?'}]`, code });
  };
  /** 工具栏宿主内全部按钮 JS（宿主容器→稳定分类键，见 js-baseline.snapshotJsCounts） */
  const pushToolbarJs = (container, prefix, toolBars) => {
    for (const tbm of asArray(toolBars?.ToolBarManager)) {
      for (const tb of asArray(tbm?.ToolBar)) {
        asArray(tb?.Widget).forEach((wdg, i) => {
          const code = jsCodeOf(wdg?.JavaScript);
          if (code == null) return;
          const txt = val(wdg?.Text);
          blocks.push({ container, event: null, location: `${prefix}[${typeof txt === 'string' && txt ? txt.slice(0, 12) : `#${i}`}]`, code });
        });
      }
    }
  };
  // ReportAttr 是历史/兼容落点（官方 1550 份 0 例）；ReportWebAttr 才是 FR 11 实际落点。
  const wbAttr = wb.ReportWebAttr ?? wb.ReportAttr ?? {};
  const wbWeb = wbAttr.WebWriteContent;
  const wbPage = wbAttr.WebPageContent;
  const wbView = wbAttr.WebViewContent;
  // 填报事件：WorkBook 级为主；Report 子级旧形态兼容（与 overview 同策略）
  if (wbWeb) asArray(wbWeb.Listener).forEach((l) => pushListener('填报事件', '填报事件', l));
  // 模板级 Web 事件（分页预览 WebPageContent / 旧版预览工具栏 WebViewContent）：
  // container 用 @workbook 与表级 webpage:<sheet> 区分（去重/基线分类天然不同键）。
  if (wbPage) asArray(wbPage.Listener).forEach((l) => pushListener('webpage:@workbook', '模板/WebPageContent', l));
  if (wbView) asArray(wbView.Listener).forEach((l) => pushListener('webview:@workbook', '模板/WebViewContent', l));
  for (const { report, sheet } of reports) {
    const topJs = val(report.TopJS);
    if (typeof topJs === 'string') blocks.push({ container: `报表事件:${sheet}`, event: null, location: `${sheet}/TopJS`, code: topJs });
    asArray(report.Listener).forEach((l) => pushListener(`报表事件:${sheet}`, `${sheet}/报表事件`, l));
    // M99-D2 WebPageContent（分页预览）独立容器：与 WebWrite/填报事件绝不能并入合并
    // （三审批各 1 个分页 afterload 实证）。读/扫/去重天然按容器分区。
    // 去重：模板级与 Report 级若指向同一解析节点（仅历史形态可能），只算一次。
    if (report.WebPageContent && report.WebPageContent !== wbPage) {
      asArray(report.WebPageContent.Listener).forEach((l) => pushListener(`webpage:${sheet}`, `${sheet}/WebPageContent`, l));
    }
    const web = report.WebWriteContent;
    if (web && web !== wbWeb) asArray(web.Listener).forEach((l) => pushListener(`填报事件:${sheet}`, `${sheet}/填报事件`, l));
    for (const c of asArray(report.CellElementList?.C)) {
      const at = `c${c?.['@_c'] ?? '?'},r${c?.['@_r'] ?? '?'}`;
      const w = c.Widget || {};
      asArray(w.Listener).forEach((l) => pushListener(`单元格:${sheet}:(${at})`, `${sheet}/格(${at})控件事件`, l));
      asArray(c.Listener).forEach((l) => pushListener(`单元格:${sheet}:(${at})`, `${sheet}/格(${at})单元格事件`, l));
      const btnJs = jsCodeOf(w.JavaScript);
      if (btnJs != null) blocks.push({ container: `单元格:${sheet}:(${at})`, event: null, location: `${sheet}/格(${at})按钮JS`, code: btnJs });
      for (const nj of asArray(c.NameJavaScriptGroup?.NameJavaScript)) {
        const code = jsCodeOf(nj?.JavaScript);
        if (code != null) blocks.push({ container: `单元格:${sheet}:(${at})`, event: null, location: `${sheet}/格(${at})超链[${nj?.['@_name'] ?? '?'}]`, code });
      }
    }
    // write 宿主沿用既有 per-sheet 口径：基线分类 toolbar:<sheet> 保持稳定，避免存量基线误报丢失。
    pushToolbarJs(`工具栏:${sheet}`, `${sheet}/工具栏`, report.WebWriteContent?.ToolBars || wbWeb?.ToolBars);
  }
  // page/view 宿主是模板级容器（edits.js 自 2026-10-23 起三种宿主均可写），旧实现完全漏扫。
  // container 复用 `工具栏:` 前缀映射，分类键落 toolbar:page / toolbar:view（无存量基线，不产生误报）。
  pushToolbarJs('工具栏:page', '模板/页面工具栏', wbPage?.ToolBars);
  pushToolbarJs('工具栏:view', '模板/预览工具栏', wbView?.ToolBars);
  return blocks;
}

/** M94：同一容器内同事件 Listener 去重扫描。返回 count>1 的组（容器+事件+各块定位）。 */
export function duplicateEventGroups(path) {
  const { parsed } = load(path);
  const byKey = new Map();
  for (const b of jsBlocks(parsed)) {
    if (!b.event) continue;
    const key = `${b.container}||${b.event}`;
    if (!byKey.has(key)) byKey.set(key, { container: b.container, event: b.event, locations: [] });
    byKey.get(key).locations.push(b.location);
  }
  return [...byKey.values()].filter((g) => g.locations.length > 1);
}

export function checkReportJs(path) {
  const { parsed } = load(path);
  const all = jsBlocks(parsed);
  const blocks = all.map(({ location, code }) => ({ location, code }));
  let passed = 0, skipped = 0;
  const failures = [];
  for (const b of blocks) {
    if (!b.code.trim()) { skipped++; continue; }
    const chk = syntaxCheck(b.code);
    if (chk.ok) { passed++; continue; }
    failures.push({ location: b.location, ...(chk.line != null ? { line: chk.line } : {}), error: chk.error, ...(chk.rawError ? { rawError: chk.rawError } : {}) });
  }
  // C-B：设计器转义 `]A` 只是元数据，不是缺陷 —— 但必须让模型看见"总共有多少个/涉及几块"，
  // 否则它会像 2026-11-03 session-de4f833e 那样把读回的 `]A` 当残字符污染去删改。
  // 解析前已由 syntaxCheck 解码（decodeFrJsForParse），这里只计数，不参与成败判定。
  const markerCounts = all.map((b) => countDesignerEscapes(b.code));
  const markerTotal = markerCounts.reduce((n, x) => n + x, 0);
  const blocksWithMarkers = markerCounts.filter((n) => n > 0).length;
  const designerMarkers = markerTotal > 0 ? { total: markerTotal, blocksWithMarkers } : null;
  const decodeNote = designerMarkers
    ? ` ${designerMarkers.total} 个 \`]A\`（${designerMarkers.blocksWithMarkers} 块）是 FR 设计器对 \`]\` 的转义，解析前已解码，不是缺陷。`
    : '';
  return {
    action: 'check_report_js',
    blocks: blocks.length,
    passed,
    failed: failures.length,
    skipped,
    failures,
    ...(designerMarkers ? { designerMarkers } : {}),
    hint: (failures.length
      ? `发现 ${failures.length} 个 JS 语法错误（填报预览会报 SyntaxError）：failures[i].line 即块内行号（1 起，直指报错行），修后重跑 validate/推送。`
      : `全部 ${passed} 个 JS 块语法通过${skipped ? `（${skipped} 个空块跳过）` : ''}。注：只查语法，变量未定义等运行时错误仍需预览实测。`) + decodeNote,
  };
}

/** 从 V8 编译错误栈首行取行号（evalmachine.<anonymous>:N），取不到返回 null */
function stackLine(err) {
  const m = /^evalmachine\.<anonymous>:(\d+)/m.exec(String(err?.stack ?? ''));
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isInteger(n) && n >= 1 ? n : null;
}

function syntaxCheck(code) {
  // M116：先解码 FR 设计器转义（`]A`→`]`）再解析。不解码会把官方 100% 的 `]` 形态
  // 全判成语法错（实测官方 55 块假阳性、V3 文件 25 块假阳性）。
  const decoded = decodeFrJsForParse(code);
  try {
    new vm.Script(decoded);
    return { ok: true };
  } catch (e) {
    const rawError = String(e?.message ?? e).split('\n')[0];
    const rawLine = stackLine(e);
    try {
      new vm.Script(`(function(){\n${decoded}\n})`);
      // FR 把片段当函数体/事件槽执行，顶层 return 合法 → 包裹过即算过
      return { ok: true };
    } catch (e2) {
      const error = String(e2?.message ?? e2).split('\n')[0];
      // 【M92】行号相对块内：包裹版整体下移 1 行（代码自第 2 行起），须减 1；
      // 减出非法值时回退裸解析行号；都没有则不带 line（调用方按块级处理）。
      const wrappedLine = stackLine(e2);
      const line = (wrappedLine != null && wrappedLine >= 2 ? wrappedLine - 1 : null) ?? rawLine ?? null;
      return { ok: false, error, ...(line != null ? { line } : {}), ...(error === rawError ? {} : { rawError }) };
    }
  }
}

/**
 * 断言 dsName 已在模板中声明。悬空引用的模板能通过加载、能被设计器打开，
 * 但渲染时必然报「数据集不存在」—— 把这种错误提前到写入时刻。
 */
export function assertDatasetExists(parsed, dsName, what = '数据集') {
  const names = datasetNamesOf(parsed);
  if (!names.has(String(dsName))) {
    throw new Error(
      `${what} "${dsName}" 不存在。模板中已声明：${[...names].join('、') || '（无）'}。` +
      '请先用 add_dataset / add_file_dataset / add_tree_dataset 创建，或修正拼写'
    );
  }
}
