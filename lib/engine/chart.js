// cpt-mcp/lib/engine/chart.js
// 图表（柱状 / 折线 / 饼）—— 只给「字段 + 数据源」就能出图
//
// 【为什么骨架取自官方样本而不是手写标签】
//   VanChart 的 <Plot> 子树有上百个标签（GI / AttrBackground / AttrBorder / AttrAlpha /
//   ConditionCollection / Legend4VanChart / DataSheet / newPlotFillStyle / 坐标轴…），
//   任何一个拼错或漏掉，结果不是"渲染差点意思"，而是设计器打不开或渲染错乱。
//   而整块里真正随用户需求变化的只有三处：
//     ① 图表名  ② 标题文字  ③ ChartDefinition（取哪个数据集的哪些字段）
//   其余全是「样式默认值」—— 所以做法是把官方样本里能正常打开的 Chart 块整块抽出做骨架，
//   只把这三处开成槽位。骨架由 fr-reverse/extract-chart-templates.mjs 生成，
//   合规边界内（只读 .cpt 的 XML 文本，不做字节码反编译）。
//
// 【图表类型 → Plot class（官方 1559 样本实证）】
//   com.fr.plugin.chart.column.VanChartColumnPlot  194 例
//   com.fr.plugin.chart.PiePlot4VanChart           100 例
//   com.fr.plugin.chart.line.VanChartLinePlot       58 例
//
// 【数据定义 → ChartDefinition（实证：681 个 ChartDefinition）】
//   单数值列 → OneValueCDDefinition（166 例）
//     系列名/X 轴分类 = seriesName；数值 = valueName；function = 聚合类；CategoryName value="无"
//   多数值列 → MoreNameCDDefinition（230 例）
//     X 轴分类 = CategoryName value；数值 = 多个 <ChartSummaryColumn name function customName/>
//   两者组合在官方样本里与 Plot 类型自由交叉（柱形×OneValue 52 例 / 柱形×MoreName 109 例；
//   折线 16/40；饼 76/1），所以按「数值列有几个」自动选，不必让调用方关心。
//
// 【聚合类白名单】com.fr.data.util.function 下实测只有这 6 个可用的
//   SumFunction(85) / NoneFunction(74) / CountFunction(7) / AverageFunction(3) / Max / Min
import fs from 'node:fs';
import { load, save, findAll, insertBefore, sheetBlocks, locateSheet } from '../xml.js';
// 2026-10-29：转义工具移到 leaf 模块 ../format.js —— 不再反向 import ../edits.js，双向依赖消除
import { escapeXmlAttr, assertSafeCdata } from '../format.js';
import { assertDatasetExists } from '../cpt.js';

const TEMPLATES = JSON.parse(
  fs.readFileSync(new URL('./chart-templates.json', import.meta.url), 'utf8')
);

/** 三种最小可用图 → Plot class + 中文名 + 官方样本出处 */
export const CHART_TYPES = {
  column: { label: '柱形图', plotClass: TEMPLATES.column.plotClass, source: TEMPLATES.column.source },
  line: { label: '折线图', plotClass: TEMPLATES.line.plotClass, source: TEMPLATES.line.source },
  pie: { label: '饼图', plotClass: TEMPLATES.pie.plotClass, source: TEMPLATES.pie.source },
};

/** 聚合方式 → FR 聚合类（白名单，防止模型乱填类名产出打不开的模板） */
export const CHART_AGGS = {
  sum: 'com.fr.data.util.function.SumFunction',
  avg: 'com.fr.data.util.function.AverageFunction',
  count: 'com.fr.data.util.function.CountFunction',
  max: 'com.fr.data.util.function.MaxFunction',
  min: 'com.fr.data.util.function.MinFunction',
  none: 'com.fr.data.util.function.NoneFunction',
};

/**
 * DSColumn 汇总白名单 —— 从 CHART_AGGS 派生（M76）。
 * none（NoneFunction）对数据列无意义（= 不聚合，分组本身就是明细），不暴露。
 */
export const DS_SUMMARIES = Object.fromEntries(
  Object.entries(CHART_AGGS).filter(([k]) => k !== 'none')
);

/**
 * 归一化 DSColumn 汇总方式（M76）。
 * @param {string|undefined} v 用户传入的 summary（sum/avg/count/max/min）
 * @returns {string|null} 合法 → 聚合函数全类名；缺省/空 → null（保持 FunctionGrouper 分组形态，零回归）
 */
export function normalizeDSSummary(v) {
  if (v == null || v === '' || v === false) return null;
  const k = String(v).trim().toLowerCase();
  if (!DS_SUMMARIES[k]) {
    throw new Error(
      `summary（DSColumn 汇总方式）"${v}" 不支持。可用：${Object.keys(DS_SUMMARIES).join(' / ')}` +
      '（不传或空 = 缺省分组形态 FunctionGrouper）'
    );
  }
  return DS_SUMMARIES[k];
}

/**
 * DSColumn 的 <RG> 块（M76）：两种官方形态。
 * 缺省 = 分组形态（自闭合 FunctionGrouper，官方 1559 样本主流）：
 *   <RG class="com.fr.report.cell.cellattr.core.group.FunctionGrouper"/>
 * 传 summary = 汇总形态（官方 GettingStarted.cpt 汇总单元格逐字节实证：
 *   RG 非自闭合，子元素 <FN> 内 CDATA 放聚合函数类名）：
 *   <RG class="com.fr.report.cell.cellattr.core.group.SummaryGrouper">
 *   <FN>
 *   <![CDATA[com.fr.data.util.function.SumFunction]]></FN>
 *   </RG>
 * @param {string|undefined} summary
 * @returns {string}
 */
export function dsColumnRGXml(summary) {
  const fnClass = normalizeDSSummary(summary);
  if (!fnClass) return '<RG class="com.fr.report.cell.cellattr.core.group.FunctionGrouper"/>';
  return `<RG class="com.fr.report.cell.cellattr.core.group.SummaryGrouper">
<FN>
<![CDATA[${fnClass}]]></FN>
</RG>`;
}

/**
 * 归一化聚合方式：true → 'sum'，别名 average/mean → avg，缺省 'sum'。
 * 与 smart.js 的 normalizeSummary 保持同一套手感（true 就是求和）。
 */
export function normalizeAgg(v) {
  if (v === true) return 'sum';
  if (v == null || v === '' || v === false) return 'sum';
  const s = String(v).trim().toLowerCase();
  const alias = { average: 'avg', mean: 'avg', count: 'count', cnt: 'count', total: 'sum' };
  const k = alias[s] ?? s;
  if (!CHART_AGGS[k]) {
    throw new Error(
      `图表的 agg="${v}" 不支持。可用：${Object.keys(CHART_AGGS).join(' / ')}` +
      `（不传或传 true 都表示 sum 求和；不想聚合传 "none"）`
    );
  }
  return k;
}

/**
 * 生成 <ChartDefinition> 段。
 * @param {object} o
 * @param {string} o.dsName 数据集名
 * @param {string} o.category X 轴分类字段名（如 "地区"）
 * @param {Array<{name:string, agg?:string, label?:string}>} o.values 数值列
 */
export function chartDefinitionXml({ dsName, category, values }) {
  if (!dsName) throw new Error('图表缺 dsName：图表要从数据集取数，必须给出数据集名');
  if (!category) throw new Error('图表缺 category：X 轴分类字段名（如 "地区" / "月份"）');
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error('图表缺 values：至少一个数值列，如 [{ name: "amount", agg: "sum" }]');
  }
  const ds = assertSafeCdata(dsName, '图表数据集名');
  // 顶部配置块：官方 681 个 ChartDefinition 里形态完全固定，只有 Top 各属性恒为这几值
  const top = '<Top topCate="-1" topValue="-1" isDiscardOtherCate="false" isDiscardOtherSeries="false" isDiscardNullCate="false" isDiscardNullSeries="false"/>';
  const tableData = `<TableData class="com.fr.data.impl.NameTableData">
<Name>
<![CDATA[${ds}]]></Name>
</TableData>`;

  if (values.length === 1) {
    const v = values[0];
    const agg = normalizeAgg(v.agg);
    return `<ChartDefinition>
<OneValueCDDefinition seriesName="${escapeXmlAttr(String(category))}" valueName="${escapeXmlAttr(String(v.name))}" function="${CHART_AGGS[agg]}">
${top}
${tableData}
<CategoryName value="无"/>
</OneValueCDDefinition>
</ChartDefinition>`;
  }
  const cols = values.map((v) => {
    const agg = normalizeAgg(v.agg);
    const n = String(v.name);
    return `<ChartSummaryColumn name="${escapeXmlAttr(n)}" function="${CHART_AGGS[agg]}" customName="${escapeXmlAttr(String(v.label ?? n))}"/>`;
  }).join('\n');
  return `<ChartDefinition>
<MoreNameCDDefinition>
${top}
${tableData}
<CategoryName value="${escapeXmlAttr(String(category))}"/>
${cols}
</MoreNameCDDefinition>
</ChartDefinition>`;
}

/**
 * 生成完整的图表单元格 XML（不含 <C> 外层）。
 * @returns {string} `<Chart ...>...</Chart>`
 */
export function chartXml({ type = 'column', title = '', dsName, category, values }) {
  const tpl = TEMPLATES[type];
  if (!tpl) {
    throw new Error(
      `图表类型 "${type}" 不支持。可用：${Object.keys(CHART_TYPES).join(' / ')}` +
      `（当前只开放这三类有官方实证的；地图/仪表盘/雷达等标签族庞大且样本少，未开放）`
    );
  }
  // 函数式替换：三处替换文本都由用户输入构造（title/values/category 等），字符串式会把其中的
  // $$/$&/$' 当特殊序列 —— 一个 $ 就能污染整张图表 XML（$& 还会把占位符本身注入）
  return tpl.template
    .replace('__CHART_NAME__', () => escapeXmlAttr(String(title || CHART_TYPES[type].label)))
    .replace('__TITLE__', () => assertSafeCdata(String(title ?? ''), '图表标题'))
    .replace('__CHART_DEFINITION__', () => chartDefinitionXml({ dsName, category, values }));
}

/**
 * 在指定单元格插入图表。
 * 单元格块形态（官方 543 例实证）：
 *   <C c r cs rs><O t="CC"><LayoutAttr selectedIndex="0"/>CHART</O><PrivilegeControl/><Expand/></C>
 * 其中 <O t="CC"> 后紧跟 LayoutAttr 的有 540/543（99.4%），故固定写出。
 */
export function addChart(filePath, {
  column, row, type = 'column', title = '', dsName, category, values,
  colspan = 4, rowspan = 12, sheet,
} = {}) {
  const c = Number(column), r = Number(row);
  if (!Number.isInteger(c) || c < 0 || !Number.isInteger(r) || r < 0) {
    throw new Error(`图表单元格坐标非法：(${column},${row})`);
  }
  for (const [k, v] of [['colspan', colspan], ['rowspan', rowspan]]) {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1 || n > 1000) throw new Error(`图表 ${k} 非法 (${v})：必须是 1-1000 之间的整数`);
  }
  // 图表块在这里就把参数全部校验完（类型/聚合/字段），避免写坏文件后才报错
  const chart = chartXml({ type, title, dsName, category, values });

  const { raw, parsed } = load(filePath);
  // S2: 图表引用的数据集必须已声明
  assertDatasetExists(parsed, dsName, '图表数据集');
  // 防御：同坐标已有单元格会产生重复 <C>，设计器会警告/显示异常
  const occ = sheet == null ? 0 : locateSheet(raw, sheet).index;
  const blocks = sheetBlocks(raw);
  const lo = blocks[occ]?.start ?? 0, hi = blocks[occ]?.end ?? raw.length;
  for (const s of findAll(raw, '<C ')) {
    if (s < lo || s >= hi) continue;
    const head = raw.slice(s, s + 200).match(/^<C[^>]*\bc="(\d+)"[^>]*\br="(\d+)"|<C[^>]*\br="(\d+)"[^>]*\bc="(\d+)"/);
    if (!head) continue;
    if (Number(head[1] ?? head[4]) === c && Number(head[2] ?? head[3]) === r) {
      throw new Error(`add_chart 失败：已存在 (${c},${r})；请先 delete_cell 或换一个坐标`);
    }
  }

  const cell = `<C c="${c}" r="${r}" cs="${Number(colspan)}" rs="${Number(rowspan)}">
<O t="CC">
<LayoutAttr selectedIndex="0"/>
${chart}
</O>
<PrivilegeControl/>
<Expand/>
</C>
`;
  const anchor = '</CellElementList>';
  if (!raw.includes(anchor)) throw new Error('定位失败：未找到 </CellElementList>');
  const out = insertBefore(raw, anchor, cell, anchor, occ);
  save(filePath, out);
  return {
    action: 'add_chart',
    cell: `${c},${r}`,
    sheet: sheet ?? 0,
    type,
    chartType: CHART_TYPES[type].label,
    plotClass: CHART_TYPES[type].plotClass,
    dsName,
    category,
    values: values.map((v) => ({ name: v.name, agg: normalizeAgg(v.agg) })),
    bytes: Buffer.byteLength(out, 'utf8'),
  };
}
