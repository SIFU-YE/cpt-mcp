// cpt-mcp/lib/engine/smart.js
// 微型报表引擎 —— 智能报表生成（semantic → 完整报表）
//
// 【为什么需要这一层】
//   build_report 仍要求模型自己算坐标、挑样式索引、决定对齐与数字格式、处理展开父格，
//   这些都是模型最容易跑偏的地方（坐标算错、样式忘建、多列忘记父格 → 数据错乱）。
//   generate_report 把"布局/样式/格式/父格/汇总"全部下沉到引擎，模型只描述业务字段：
//     给什么字段、来自哪张表、每个字段怎么显示 → 直接产出可用且美观的报表。
//
// 【默认值来源】全部来自对 FineReport 安装目录 官方 1559 个样本的统计与既有成品模板校准：
//   - 表头 9mm / 数据 7mm 行高、标题 18pt 加粗、数据 14pt
//   - 水平对齐合法值仅 0(居中,76.7%) / 2(左) / 4(右) / 6(两端对齐)
//   - 数字金额列右对齐 + #,##0.00；日期居中；文本左对齐
//   - 同行多列数据集由 buildReport 自动推导主扩展格与左父格
import { buildReport } from './builder.js';
import { mmToUnit, assertHorizontalAlignment, DESIGN_TOKENS, estimateTextWidthMm } from './rules.js';
import { CHART_TYPES, normalizeAgg } from './chart.js';
import { cellRef } from '../generate.js';

/**
 * 版式密度（P1-1）：从 DESIGN_TOKENS 派生三档，管"整表节奏"——字号/行高/列宽联动。
 * 与 theme（颜色）正交：theme 管色，density 管密度。standard 与既有产物完全一致（golden 锁定）。
 */
const DENSITY = {
  compact: {
    fontPt: { title: 16, header: 12, data: 11, summary: 11 },
    rowHeightMm: { title: 12, header: 8, data: 6, summary: 6 },
    colScale: 0.9,
  },
  standard: {
    fontPt: { ...DESIGN_TOKENS.fontPt },
    rowHeightMm: { ...DESIGN_TOKENS.rowHeightMm },
    colScale: 1,
  },
  roomy: {
    fontPt: { title: 24, header: 18, data: 14, summary: 14 },
    rowHeightMm: { title: 20, header: 12, data: 9, summary: 9 },
    colScale: 1.2,
  },
};

/** 字段显示类型 → 对齐 / 数字格式 / 默认列宽（mm，来自 DESIGN_TOKENS.colWidthMm） */
// 一句话直出默认全部居中（align 0）：数字格式保留（千分位/日期格式不变），只改对齐。
// 如需按类型区分（文本左/数字右），调用方显式传 fields[].align 覆盖。
const FIELD_TYPES = {
  text: { align: 0, format: null, widthMm: DESIGN_TOKENS.colWidthMm.text },
  number: { align: 0, format: { class: 'com.fr.base.CoreDecimalFormat', pattern: '#,##0' }, widthMm: DESIGN_TOKENS.colWidthMm.number },
  money: { align: 0, format: { class: 'com.fr.base.CoreDecimalFormat', pattern: '#,##0.00' }, widthMm: DESIGN_TOKENS.colWidthMm.money },
  percent: { align: 0, format: { class: 'com.fr.base.CoreDecimalFormat', pattern: '0.00%' }, widthMm: DESIGN_TOKENS.colWidthMm.percent },
  date: { align: 0, format: { class: 'com.fr.base.SimpleDateFormatThreadSafe', pattern: 'yyyy-MM-dd' }, widthMm: DESIGN_TOKENS.colWidthMm.date },
  datetime: { align: 0, format: { class: 'com.fr.base.SimpleDateFormatThreadSafe', pattern: 'yyyy-MM-dd HH:mm:ss' }, widthMm: DESIGN_TOKENS.colWidthMm.datetime },
};

/** 配色主题（表头底色 / 标题色 / 分组底色 / 斑马纹底色） */
//
// 【zebraBg 的取值依据】官方 1559 个模板里 215 个斑马纹 Highlight 的背景色实测 TOP3：
//     #F5F8FA (58 次) > #CCCCFF (32) > #F2F4F7 (26)
// 所以斑马纹底色不再跟 bandBg 混用，而是按主题给出独立值（默认贴近 #F5F8FA）。
const THEMES = {
  blue: { headerBg: '#2E5BFF', headerFg: '#FFFFFF', titleColor: '#1F2937', bandBg: '#F5F7FF', zebraBg: '#F5F8FA' },
  green: { headerBg: '#18A058', headerFg: '#FFFFFF', titleColor: '#1F2937', bandBg: '#F3FAF6', zebraBg: '#F3FAF6' },
  gray: { headerBg: '#4B5563', headerFg: '#FFFFFF', titleColor: '#1F2937', bandBg: '#F3F4F6', zebraBg: '#F5F8FA' },
  dark: { headerBg: '#1F2937', headerFg: '#FFFFFF', titleColor: '#111827', bandBg: '#F9FAFB', zebraBg: '#F5F8FA' },
  orange: { headerBg: '#EA580C', headerFg: '#FFFFFF', titleColor: '#1F2937', bandBg: '#FFF7ED', zebraBg: '#F5F8FA' },
};

const THIN = { style: 1, color: '#BFBFBF' };

// 斑马纹公式：官方样本实测 `row() % 2 = 0` 出现 81 次、`row()%2=0` 45 次、
// `row()%2==0` 32 次 —— 单等号是 FR 公式的主流写法（FR 里 = 与 == 等价，但跟官方保持一致更稳妥）。
export const ZEBRA_FORMULA = 'row() % 2 = 0';
// generate_report 默认套用的模板主题（官方 301 例里的 5 种之一，取观感最好的）
export const DEFAULT_TEMPLATE_THEME = '经典浅灰';
// 负数标红公式：`$$$` 在条件公式里代表当前单元格值（官方 150 个公式用到）。
// 注：官方样本里没有 `$$$ < 0` 这个写法（0 命中），但它是合规的 FR 公式，属业务刚需，保留为默认。
export const NEGATIVE_FORMULA = '$$$ < 0';

// 汇总函数白名单（FR 支持更多，但这 5 个覆盖 99% 场景；收紧可拦住模型乱填函数名）
export const SUMMARY_FUNCS = ['sum', 'count', 'avg', 'max', 'min'];

/**
 * 归一化 summary：true → 'sum'，并校验函数名在白名单内。
 * 不归一化的话 summary:true 会拼出 =true(A3) 这种设计器打不开的公式。
 */
export function normalizeSummary(v, index, fieldName) {
  if (v === true) return 'sum';
  if (v === false || v == null || v === '') return undefined;
  const s = String(v).trim().toLowerCase();
  if (!SUMMARY_FUNCS.includes(s)) {
    throw new Error(
      `generate_report: fields[${index}] ("${fieldName}") 的 summary="${v}" 不支持。` +
      `可用：${SUMMARY_FUNCS.join(' / ')}，或写 true 表示 sum`
    );
  }
  return s;
}

/**
 * 由"字段 + 数据源"直接生成完整报表。
 *
 * @param {object} spec
 * @param {string} spec.path 目标 .cpt 绝对路径
 * @param {string} [spec.title] 报表标题（写在首行，跨所有列合并）
 * @param {object} spec.source 数据源 {connection, table?, sql?, parameters?}
 * @param {Array<{name:string,label?:string,type?:string,widthMm?:number,align?:number,summary?:string}>} spec.fields 字段列表
 * @param {string} [spec.dsName='ds1'] 数据集名
 * @param {string} [spec.theme='blue'] 配色主题
 * @param {object} [spec.fill] 填报提交 {table, dsName?, fields?:[{field,column?}]}；给 table 即生成提交
 * @param {object|boolean} [spec.chart] 图表：true=按字段自动推导；或 {type,category,values,title,rowspan,colspan}。
 *   自动推导：X 轴取第一个文本/日期字段，数值列取所有 number/money/percent 字段（最多 3 个，默认 sum）。
 *   type 可选 column(柱形,默认) / line(折线) / pie(饼图，只支持一个数值列)。图表放在明细表下方。
 * @param {object} [spec.options] 覆盖项 {titleFontSizePt, headerFontSizePt, dataFontSizePt, paper, orientation, fontName, showBand}
 */
export function generateReport({ path: filePath, title, source = {}, fields = [], dsName = 'ds1', theme = 'blue', fill = null, chart = null, options = {}, noOverwrite = true } = {}) {
  if (!filePath) throw new Error('generate_report: 必须提供 path（目标 .cpt 绝对路径）');
  if (!Array.isArray(fields) || fields.length === 0) {
    throw new Error(
      'generate_report: fields 不能为空。最少给一个字段，例如：\n' +
      'fields: [{ name: "product_name", label: "产品名称" }, { name: "amount", label: "金额", type: "money" }]\n' +
      'type 可选 text(默认) / number / money / percent / date / datetime，决定对齐方式与数字格式。'
    );
  }
  // 数据来源两种口径二选一：库里取数（connection + table/sql）或 直接给个 Excel 文件。
  // Excel 分支不需要连接、不需要 SQL —— 字段名就是 Excel 的列名，正好对应
  // 「用户手上只有一张表」的场景，也是内置数据集被拒之后最顺手的替代路径。
  const isExcel = !!source.excelFile;
  const conn = source.connection;
  if (!isExcel) {
    if (!conn) throw new Error('generate_report: source.connection 必填（数据连接名，如 Doris / MySQL）。若数据不在库里，可改用 source.excelFile 直接指向 .xls/.xlsx');
    if (!source.sql && !source.table) {
      throw new Error('generate_report: source 必须提供 table 或 sql 之一（table 会自动生成 select 字段列表）');
    }
  }

  // 字段类型校验（提前报错，避免生成到一半才发现 type 拼错）
  // summary 归一化：true → 'sum'（模型最常见的写法），并收紧到白名单，
  // 否则会生成 =true(A3) 这类设计器无法解析的公式。
  fields.forEach((f, i) => {
    if (f.type && !FIELD_TYPES[f.type]) {
      throw new Error(
        `generate_report: fields[${i}] ("${f.name}") 的 type="${f.type}" 不支持。` +
        `可用：${Object.keys(FIELD_TYPES).join(' / ')}（不传则按 text 处理）`
      );
    }
    if (!f.name) {
      throw new Error(`generate_report: fields[${i}] 缺少 name（数据库字段名）`);
    }
    if (f.summary != null) f.summary = normalizeSummary(f.summary, i, f.name);
    // result 必须是字符串。数字这类输入（如 result: 10000）会被静默当公式写进去，
    // 设计器里表现为显示值变成一个裸数字，很难排查。
    if (f.result != null && typeof f.result !== 'string') {
      throw new Error(
        `generate_report: fields[${i}] ("${f.name}") 的 result 必须是字符串公式，` +
        `当前为 ${typeof f.result}。例："$$$/10000"（元转万元）`
      );
    }
  });

  // ---- 2.5 扩展后排序（官方 <cellSortAttr>）—— 归一化 + 围栏 ----
  // 【语义】FR 的排序属性挂在「主扩展格」上，而 sortArea 指向真正参与比较的那一列
  //   （官方 9 条排序表达式里 9/9 的 sortArea 都是别的列 —— 这就是帆软的「高级排序」）。
  //   调用方只要说「按销售额降序」，引擎负责挂到主扩展格上，模型不必理解父格/扩展机制。
  // 【两种写法二选一】
  //   ① 顶层 sort 数组：sort: [{ field: '地区', direction: 'asc' }, { field: '销售额', direction: 'desc' }]
  //      —— 顺序即优先级（先按地区升序，地区相同再按销售额降序）
  //   ② 字段快捷：fields: [{ name: '销售额', type: 'money', sort: 'desc' }]
  //   同时给会被拒 —— 两种来源混在一起时排序优先级不明确，宁可让模型重说一次。
  const SORT_DIRS = { asc: '升序', desc: '降序' };
  const fieldNames = fields.map((f) => f.name);
  const sortExprs = [];
  const pushSort = (field, direction, where) => {
    if (!field) throw new Error(`generate_report: ${where} 缺少排序字段（按哪一列排）`);
    const d = String(direction ?? '').trim();
    if (!SORT_DIRS[d]) {
      throw new Error(
        `generate_report: ${where} 的排序方向只能是 "asc"（升序）或 "desc"（降序），当前为 "${direction}"`
      );
    }
    // 围栏：只能按报表里已声明的列排。拍一个不存在的列名，模板在设计器里取不到值，
    // 且这种错误只在预览时才暴露，排查成本极高。
    if (!fieldNames.includes(field)) {
      throw new Error(
        `generate_report: ${where} 的排序字段 "${field}" 不在声明的字段里。已声明：${fieldNames.join('、')}。` +
        '排序只能按报表中已有的列排。'
      );
    }
    sortExprs.push({ area: field, direction: d });
  };

  if (options.sort != null) {
    if (fields.some((f) => f.sort != null)) {
      throw new Error(
        'generate_report: 排序给了两份（顶层 sort + 字段上的 sort），已拒绝。请二选一 —— ' +
        '多键排序用顶层 sort 数组（数组顺序即优先级），单列快捷用字段上的 sort:"asc"|"desc"。'
      );
    }
    if (!Array.isArray(options.sort)) {
      throw new Error(
        `generate_report: sort 必须是数组，例：[{ field: "销售额", direction: "desc" }]。当前为 ${typeof options.sort}`
      );
    }
    options.sort.forEach((s, i) => {
      if (typeof s === 'string') {
        throw new Error(
          `generate_report: sort[${i}] 必须是 { field, direction } 对象，不能是字符串 "${s}"。` +
          '例：{ field: "销售额", direction: "desc" }'
        );
      }
      pushSort(s?.field, s?.direction, `sort[${i}]`);
    });
  } else {
    fields.forEach((f) => {
      if (f.sort != null) pushSort(f.name, f.sort, `字段 "${f.name}" 的 sort`);
    });
  }

  const pal = THEMES[theme] || THEMES.blue;
  if (!THEMES[theme]) {
    throw new Error(`generate_report: theme="${theme}" 不存在，可用：${Object.keys(THEMES).join(' / ')}`);
  }
  // P1-1: 版式密度 —— compact 紧凑（信息密度高的运营表）/ standard 标准 / roomy 宽疏（汇报用）
  const densityName = options.density ?? 'standard';
  const density = DENSITY[densityName];
  if (!density) {
    throw new Error(`generate_report: density="${options.density}" 非法，可用：${Object.keys(DENSITY).join(' / ')}`);
  }
  const fontName = options.fontName ?? '微软雅黑';
  const titlePt = options.titleFontSizePt ?? density.fontPt.title;
  const headerPt = options.headerFontSizePt ?? density.fontPt.header;
  const dataPt = options.dataFontSizePt ?? density.fontPt.data;

  // ---- 1. SQL：未显式给 SQL 时，由 table + fields 生成 select ----
  const safeIdent = (s) => (/^[A-Za-z_][A-Za-z0-9_$]*$/.test(String(s)) ? String(s) : `\`${String(s).replace(/`/g, '')}\``);
  const sql = isExcel ? null : (source.sql
    || `select ${fields.map((f) => safeIdent(f.name)).join(', ')} from ${safeIdent(source.table)}`);

  // ---- 2. 布局：行0=大标题(跨列)  行1=表头  行2=数据  [行3=汇总] ----
  const HEADER_ROW = 1;
  const DATA_ROW = 2;
  const hasSummary = fields.some((f) => f.summary);
  const SUMMARY_ROW = DATA_ROW + 1;
  const colCount = fields.length;
  let rowCount = hasSummary ? SUMMARY_ROW + 1 : DATA_ROW + 1;

  // ---- 3. 样式：用【内联样式对象】而非 styleIndex 数字 ----
  // 原因：createCpt 的骨架已自带默认样式 0，styles 数组下标 ≠ 实际 styleIndex（差 1），
  // 手工算索引极易错位 / 越界。交给 builder 的 registerStyle 分配（带去重缓存），
  // 相同样式会自动复用同一索引，既正确又省样式数。
  const titleStyle = { id: 'title', fontName, fontSizePt: titlePt, bold: true, horizontalAlignment: 0, verticalAlignment: 0 };
  const headerStyle = {
    id: 'header', fontName, fontSizePt: headerPt, bold: true,
    horizontalAlignment: 0, verticalAlignment: 0,
    backgroundColor: pal.headerBg, foregroundColor: pal.headerFg,
    border: { top: THIN, bottom: THIN, left: THIN, right: THIN },
  };
  const makeDataStyle = (f) => {
    const t = FIELD_TYPES[f.type] || FIELD_TYPES.text;
    const align = f.align != null ? assertHorizontalAlignment(f.align) : t.align;
    return {
      id: `field_${f.name}`,
      fontName, fontSizePt: dataPt, horizontalAlignment: align, verticalAlignment: 0,
      ...(t.format ? { format: t.format } : {}),
      border: { top: THIN, bottom: THIN, left: THIN, right: THIN },
    };
  };
  const summaryStyle = {
    id: 'summary', fontName, fontSizePt: dataPt, bold: true, horizontalAlignment: 0,
    verticalAlignment: 0, backgroundColor: pal.bandBg,
    border: { top: { style: 1, color: '#808080' }, bottom: THIN },
  };

  // ---- 4. 单元格 ----
  const cells = [];
  // 标题：跨所有列合并
  if (title) {
    cells.push({ column: 0, row: 0, content: title, style: titleStyle, colspan: colCount });
  }
  // 表头
  fields.forEach((f, i) => {
    cells.push({ column: i, row: HEADER_ROW, content: f.label ?? f.name, style: headerStyle });
  });
  // 数据行：dsColumn（buildReport 会自动推导主扩展格 + 左父格，无需在此处理 expand）
  //
  // 同时挂条件属性。默认给两套：
  //  ① 斑马纹 row() % 2 = 0 + 浅色背景 —— 官方样本里最高频的条件公式（81+45 次），明细表可读性关键
  //  ② 数值列 $$$ < 0 标红 —— 负数醒目，财务报表刚需
  // 注意：斑马纹逐列都写（而不是只写首列 + scope:'row'），因为 Scope val="1" 的
  // "整行"语义只有 81 个样本的旁证，逐列写是确定性正确的做法。
  const asOpt = (v, dflt) => (v !== undefined ? (v || undefined) : dflt);
  const zebra = asOpt(options.zebra, true);
  const zebraColor = options.zebraColor ?? pal.zebraBg ?? pal.bandBg;
  const negativeRed = asOpt(options.negativeRed, true);
  const negativeColor = options.negativeColor ?? '#C00000';

  fields.forEach((f, i) => {
    const highlights = [];
    if (zebra) {
      highlights.push({ formula: ZEBRA_FORMULA, background: zebraColor });
    }
    // 只对数值型字段标红（给文本列加 "$$$ < 0" 没有意义，还会让设计器报警）
    if (negativeRed && ['number', 'money', 'percent'].includes(f.type)) {
      highlights.push({ formula: NEGATIVE_FORMULA, fontColor: negativeColor });
    }
    (f.highlights ?? []).forEach((h) => highlights.push(h));

    cells.push({
      column: i, row: DATA_ROW, contentType: 'dsColumn', dsName, columnName: f.name,
      style: makeDataStyle(f),
      // result = 官方 <Result>：字段的显示值变换（如 "$$$/10000" 元转万元）。
      // 不给就是不给，绝不回填 —— 官方 91.3% 的 DSColumn 也没有这个元素。
      ...(f.result != null ? { result: f.result } : {}),
      ...(highlights.length ? { highlights } : {}),
    });
  });

  // 排序挂到「主扩展格」上 —— 与 builder.autoExpandCells 的推导规则保持一致：
  // 数据行里 column 最小的那个 dsColumn 就是主扩展格（它驱动整行纵向展开，其余列跟随它）。
  // 官方 105 处排序 100% 挂在 DSColumn 上，105/105 位于 <Parameters/> 之后。
  // （若排序字段恰好就是主扩展格本身，sortArea 等于自己的列名 —— 语义是"按本列排序"，
  //   官方 9 条样本里没有这种，但排序取值逻辑是自洽的：取该行的本列值参与比较。）
  if (sortExprs.length) {
    const mainDataCell = cells
      .filter((c) => c.row === DATA_ROW && c.contentType === 'dsColumn')
      .sort((a, b) => a.column - b.column)[0];
    if (mainDataCell) mainDataCell.sort = sortExprs;
  }

  // 汇总行：第 1 列放"合计"，后续列按 summary 给公式
  if (hasSummary) {
    cells.push({ column: 0, row: SUMMARY_ROW, content: '合计', style: { ...summaryStyle, horizontalAlignment: 0 } });
    fields.forEach((f, i) => {
      if (i === 0) return;
      if (!f.summary) {
        cells.push({ column: i, row: SUMMARY_ROW, content: '', style: summaryStyle });
        return;
      }
      cells.push({
        column: i, row: SUMMARY_ROW,
        contentType: 'formula',
        content: `=${f.summary}(${cellRef(i, DATA_ROW)})`,
        style: summaryStyle,
      });
    });
  }

  // ---- 5b. 图表（可选）：chart: true 或 {type,category,values} ----
  //
  // 为什么放进 generate_report：图表是"让报表好看"最立竿见影的一步，但 VanChart 的
  // <Plot> 子树有上百个标签，模型自己拼必错。这里让模型只说「要不要图、什么图、按哪个字段分组」，
  // 剩下的（骨架、配色、图例、坐标轴、数据定义）全部由引擎按官方样本填充。
  //
  // 自动推导规则（没给 category / values 时）：
  //   category = 第一个文本/日期字段（X 轴分类）
  //   values   = 所有数值字段，最多 3 个，默认 sum 聚合
  //   placement= 明细表下方空一行，跨所有列，高 12 行（≈84mm）
  let chartSpec = null;
  let chartInfo = null;
  if (chart) {
    const cfg = chart === true ? {} : chart;
    const type = cfg.type ?? 'column';
    if (!CHART_TYPES[type]) {
      throw new Error(
        `generate_report: chart.type="${type}" 不支持。可用：${Object.keys(CHART_TYPES).join(' / ')}` +
        `（只开放这三类有官方实证的；地图/仪表盘/雷达等标签族庞大且样本少，未开放）`
      );
    }
    const TEXTISH = ['text', 'date', 'datetime'];
    const NUMERIC = ['number', 'money', 'percent'];
    const category = cfg.category
      ?? (fields.find((f) => TEXTISH.includes(f.type ?? 'text')) ?? fields[0]).name;
    if (!fieldNames.includes(category)) {
      throw new Error(`generate_report: chart.category="${category}" 不在 fields 中。已声明：${fieldNames.join('、')}`);
    }

    // 数值列允许三种写法：['amount'] / ['amount','qty'] / [{name:'amount',agg:'avg'}]
    let values = (cfg.values ?? []).map((v) => (typeof v === 'string' ? { name: v } : v));
    if (!values.length) {
      const nums = fields.filter((f) => NUMERIC.includes(f.type));
      if (!nums.length) {
        throw new Error(
          'generate_report: chart 需要至少一个数值字段（type 为 number/money/percent），' +
          '当前字段里一个都没有。\n解决办法（三选一）：\n' +
          '  1. 给某个字段标 type:"number"/"money"/"percent"（如 {name:"amount", type:"money"}）；\n' +
          '  2. 显式指定 chart.values，用 count 计数（如 chart:{values:[{name:"订单号", agg:"count"}]}）；\n' +
          '  3. 不需要图就别传 chart。'
        );
      }
      values = nums.slice(0, 3).map((f) => ({ name: f.name, agg: 'sum', label: f.label ?? f.name }));
    }
    for (const value of values) {
      if (!fieldNames.includes(value?.name)) {
        throw new Error(`generate_report: chart.values 字段 "${value?.name}" 不在 fields 中。已声明：${fieldNames.join('、')}`);
      }
    }
    // 饼图 × 多数值列：官方 100 个 PiePlot4VanChart 里只有 1 例配 MoreName（多数值列），
    // 属未充分验证形态 → 明确拒绝，引导改用柱形/折线，而不是静默产出可能渲染异常的模板。
    if (type === 'pie' && values.length > 1) {
      throw new Error(
        'generate_report: 饼图只支持一个数值列（官方 100 个饼图样本里只有 1 例用了多数值列，形态未经验证）。\n' +
        `当前给了 ${values.length} 个：${values.map((v) => v.name).join('、')}。\n` +
        '想对比多个指标请改用 chart.type="column"（柱形）或 "line"（折线）。'
      );
    }

    const CHART_GAP = 1;                       // 与明细表之间空一行，视觉上不挤
    const chartRow = rowCount + CHART_GAP;
    const rowSpan = cfg.rowspan ?? 12;
    chartSpec = {
      column: 0,
      row: chartRow,
      type,
      title: cfg.title ?? (title ? `${title}（图表）` : ''),
      dsName,
      category,
      values,
      colspan: cfg.colspan ?? Math.max(colCount, 1),
      rowspan: rowSpan,
    };
    rowCount = chartRow + rowSpan;
    chartInfo = {
      type, chartType: CHART_TYPES[type].label, category,
      values: values.map((v) => ({ name: v.name, agg: normalizeAgg(v.agg) })),
      position: { column: 0, row: chartRow, colspan: chartSpec.colspan, rowspan: rowSpan },
      note: '图表骨架与配色取自官方样本，只替换了图表名/标题/数据定义三处',
    };
  }

  // ---- 6. 列宽 / 行高 ----
  // P1-2 列宽自适应：类型默认宽 × 密度系数 与 表头文本显示宽度估算 取 max —— 中文长表头不再被截断
  const columnWidths = fields.map((f) => {
    const typeDef = FIELD_TYPES[f.type] || FIELD_TYPES.text;
    const base = Math.round((f.widthMm ?? typeDef.widthMm) * density.colScale * 10) / 10;
    const fit = estimateTextWidthMm(f.label ?? f.name, headerPt);
    return mmToUnit(Math.max(base, fit));
  });
  const rowHeights = [];
  rowHeights[0] = mmToUnit(title ? density.rowHeightMm.title : density.rowHeightMm.data); // 标题行
  rowHeights[HEADER_ROW] = mmToUnit(density.rowHeightMm.header);
  rowHeights[DATA_ROW] = mmToUnit(density.rowHeightMm.data);
  if (hasSummary) rowHeights[SUMMARY_ROW] = mmToUnit(density.rowHeightMm.summary);
  // 图表区：中间的空行与图表所在行都要有行高，否则 setGrid 会写出含 undefined 的数组。
  // 逐行补默认数据行高（7mm），12 行 ≈ 84mm 的图高。
  for (let i = 0; i < rowCount; i++) {
    if (rowHeights[i] == null) rowHeights[i] = mmToUnit(7);
  }

  // ---- 6. 填报提交（可选）----
  let fillSpec = null;
  if (fill && fill.table) {
    // 填报要往库里写，必须有数据连接。Excel 来源没有连接，这里必须显式要求，
    // 否则会静默生成一个 dsName 为空的提交配置，预览时提交直接失败。
    if (isExcel && !fill.dsName) {
      throw new Error('generate_report: 用 source.excelFile 做展示数据源时，填报（fill）必须显式给 fill.dsName（回写用的数据连接名）——Excel 本身没法当回写目标');
    }
    fillSpec = {
      dsName: fill.dsName ?? source.connection,
      table: fill.table,
      bindings: (fill.fields || fields).map((b, i) => ({
        field: b.field ?? b.name,
        column: b.column ?? i,
        row: b.row ?? DATA_ROW,
        isKey: !!b.isKey,
      })),
    };
  }

  // ---- 7. 交给 buildReport 组装（含展开父格自动推导 + 三层自检）----
  // ---- 5. 页眉页脚 ----
  // 默认给"页脚居中页码"（打印/导出 PDF 时的刚需，官方样本里最常见的非空页脚就是页码），
  // 标题存在时再补页眉左侧报表名。用 options.header/footer 覆盖，传 false/null 关闭。
  // 注意区分两种"假值"：undefined=没给（走默认）；false/null=显式关闭（必须关掉，
  // 不能再被默认值回填，否则"关闭"会被静默忽略）。
  const pageHeader = asOpt(options.header, title ? { left: title } : undefined);
  const pageFooter = asOpt(options.footer, { center: { preset: 'pageNumber' } });

  // ---- 6b. 填报工具栏：一句话直出同等更新业务代码 ----
  // 有 fill（填报）时默认配齐提交/校验/增行/删行，与 set_fill_toolbar 缺省四按钮一致；
  // options.toolbar 可覆盖：false=不建工具栏，数组=自定义按钮列表。
  const DEFAULT_FILL_TOOLBAR = ['submit', 'verify', 'append-row', 'delete-row'];
  let toolbarSpec = null;
  if (options.toolbar === false) {
    toolbarSpec = null;
  } else if (Array.isArray(options.toolbar)) {
    toolbarSpec = options.toolbar.length ? options.toolbar : null;
  } else if (fillSpec) {
    toolbarSpec = DEFAULT_FILL_TOOLBAR;
  }

  const result = buildReport({
    path: filePath,
    // 覆盖保护透传（2026-11-06 P0）：默认拒绝覆盖已存在目标，与 build_report 同语义。
    // generate_report 工具层同样暴露 noOverwrite（默认 true）；显式 false 才允许原子替换。
    noOverwrite,
    title,
    rows: rowCount,
    columns: colCount,
    datasets: [isExcel
      ? {
        name: dsName,
        excelFile: source.excelFile,
        needColumnName: source.needColumnName ?? true,
        fromEnv: source.fromEnv ?? true,
      }
      : { name: dsName, connection: conn, sql, parameters: source.parameters }],
    cells,
    charts: chartSpec ? [chartSpec] : [],
    grid: { rowHeights, columnWidths },
    settings: {
      paper: options.paper ?? 'A4',
      orientation: options.orientation ?? 0,
    },
    header: pageHeader,
    footer: pageFooter,
    ...(options.hfFontSizePt != null ? { hfStyle: { fontSizePt: options.hfFontSizePt } } : {}),
    // 模板主题：默认给"经典浅灰"，让生成的报表一打开就有成品观感（配色/图表调色板）。
    // 传 options.templateTheme = false 可关闭，不写该标记。
    templateTheme: options.templateTheme === false ? null : (options.templateTheme ?? DEFAULT_TEMPLATE_THEME),
    // 参数面板控件：数据集参数自动配同名筛选控件（文本框 —— 无库连接时无法取字典值，
    // comboBox 需要调用方显式给 items/dictionary）。不做这一步，"按 XX 筛选"的需求
    // 在弱模型 profile 里是死路（那边没有 add_parameter_widget 工具）——行为验证发现。
    parameterWidgets: (source.parameters ?? [])
      .filter((p) => p?.name)
      .map((p) => ({ name: p.name, type: 'text', label: p.name, defaultValue: p.defaultValue ?? '' })),
    fill: fillSpec,
    toolbar: toolbarSpec,
    webWrite: !!fillSpec,
    withWebAttr: true,
    // P2-1 生成参数留档（options.meta 显式开启）
    meta: options.meta ? {
      tool: 'generate_report', title: title ?? null, source, fields, dsName, theme, density: densityName,
      chart, fill, options: { toolbar: toolbarSpec },
      parameterFilters: (source.parameters ?? []).map((p) => p.name).filter(Boolean),
    } : null,
  });

  return {
    ...result,
    summary: {
      title: title ?? null,
      dataset: dsName,
      dataSourceType: isExcel ? 'excel' : 'sql',
      ...(isExcel ? { excelFile: source.excelFile } : { sql }),
      fields: fields.length,
      parameterFilters: (source.parameters ?? []).map((p) => p.name).filter(Boolean),
      // 扩展后排序：回显给模型，让它确认自己想要的排序真的写进去了
      sort: sortExprs.length
        ? {
            attachedTo: `第 ${DATA_ROW + 1} 行第 1 列（主扩展格）`,
            keys: sortExprs.map((s) => `${s.area} ${SORT_DIRS[s.direction]}`),
          }
        : null,
      layout: {
        titleRow: title ? 1 : 0, headerRow: HEADER_ROW + 1, dataRow: DATA_ROW + 1,
        summaryRow: hasSummary ? SUMMARY_ROW + 1 : null,
        rowNote: '此处行号按设计器口径（从 1 起）；spec 内 row 参数从 0 起',
      },
      chart: chartInfo,
      theme,
      density: densityName,
      conditionalFormat: {
        note: '默认给数据行加斑马纹（row()%2==0 + 浅背景）与数值列负数标红（$$$ < 0）。可用 options.zebra / options.negativeRed 关闭（传 false）',
        zebra: !!zebra,
        negativeRed: !!negativeRed,
        highlightCount: cells.filter((c) => c.highlights?.length).reduce((n, c) => n + c.highlights.length, 0),
      },
      pageHeaderFooter: {
        note: '默认生成页眉（标题）与页脚（居中页码）。用 options.header / options.footer 覆盖，传 false 关闭',
        header: pageHeader ?? null,
        footer: pageFooter ?? null,
      },
      styles: {
        note: '样式索引由引擎自动分配（内联样式经去重后写入 StyleList），可用 get_styles 查看实际索引',
        defined: ['title 标题(加粗居中)', 'header 表头(加粗+主题底色白字+四边框)', ...fields.map((f) => `field_${f.name}`), ...(hasSummary ? ['summary 汇总行(加粗+底色)'] : [])],
      },
      toolbar: toolbarSpec ? {
        note: '有 fill 时默认提交/校验/增行/删行四按钮；options.toolbar 可自定义，传 false 关闭',
        buttons: toolbarSpec,
      } : null,
    },
  };
}


