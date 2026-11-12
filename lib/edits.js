// cpt-mcp/lib/edits.js —— CPT 写操作（全部基于文本锚点定向编辑，保真）
import { load, save, findAll, blockRange, replaceAttr, insertBefore, removeRange, locateSheet, sheetBlocks, styleBlocks } from './xml.js';
import { statSync } from 'node:fs';
import { assertSafeExternalUrl } from './security.js';
import { unescapeXml as xmlUnescape } from './parsed-shape.js';
import { assertDatasetExists, fillConfig, jsSha256, sliceJs, aggregateDesignerEscapes, DESIGNER_ESCAPE_MARKER } from './cpt.js';
import { locateEmbeddedSubmit, columnConfigXml, normalizeCell, COMMIT2DB_CLASS, scanEmbeddedCommits, colName } from './embedded.js';
// F1 自卫：写侧 expectedSha256 核对（替换前比对当前块 sha，不符拒绝且不写文件）。
// 口径与读侧一致：sha256 对 Listener 块内 Content 的 CDATA 原文（读回 js 同一字符串）。
function assertExpectedSha256(block, expectedSha256, what) {
  const { js } = readListenerJs(block);
  assertExpectedSha256Js(js ?? '', expectedSha256, what);
}
// M76: DSColumn 汇总形态（SummaryGrouper）复用 chart.CHART_AGGS 派生的白名单。
// 2026-10-29 整理：escapeXmlAttr/assertSafeCdata/公式对象构造已抽到 leaf 模块 lib/format.js，
// chart.js 不再反向 import 本模块 —— 历史上 edits → chart → edits 的 ESM 双向依赖已消除。
import { dsColumnRGXml, chartXml, CHART_TYPES, CHART_AGGS, normalizeAgg } from './engine/chart.js';
// 2026-10-29 去重：颜色转换/单位换算的唯一实现放在 leaf 模块 rules.js，
// 本模块（及 cpt.js / generate.js）不再各存一份。
import { argbToHex, hexToArgb, mmToUnit, unitToMm } from './engine/rules.js';
import { escapeXmlAttr, assertSafeCdata, normalizeFormulaExpr, formulaObjectXml } from './format.js';
// 自由 SQL 提交参数声明（SQL ${x} → <Parameters>）：与 generate.js 的 add_fill_submit 共用 leaf 实现
import {
  normalizeSubmitParameters, readSubmitParameterNames, replaceSubmitParameters, ensureSubmitParameters,
} from './fill-submit.js';

/** 宽松读取 <tag …>…</tag> 正文：优先 CDATA，其次裸文本；容忍属性/空白差异（供 get_* 只读路径） */
function readTagText(block, tag) {
  const m = block.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`));
  if (!m) return null;
  const inner = m[1];
  const cdata = inner.match(/<!\[CDATA\[([\s\S]*?)\]\]>/);
  if (cdata) return cdata[1];
  const text = inner.replace(/<!\[CDATA\[|\]\]>/g, '').trim();
  return text || null;
}

/** 定位目标 Parameter 块（含 <Attributes name="X"/>），返回 [块起始, 块结束]（文档全局，legacy 兜底） */
function locateParameter(raw, name, what = `参数 ${name}`) {
  const hit = findParameterInRange(raw, 0, raw.length, name);
  if (!hit) throw new Error(`定位失败：未找到 ${what}`);
  return hit;
}

// ---------------- 参数（数据集层 / 报表级双层通道，P1-1） ----------------
//
// FR 参数分两层（官方结构实证）：
//   ① 数据集层 <TableData name="ds"><Parameters><Parameter><Attributes name="X"/>…，
//      供该数据集 SQL 的 ${X} 引用；
//   ② 报表级 <WorkBook><ReportParameterAttr><Parameter><Attributes name="X"/>…（直接子级，
//      ParameterUI 之后），由参数面板控件同名绑定（add_parameter_widget 自动创建），
//      也可独立存在（如 fine_username 隐藏传值）。
// 同名跨层合法（报表级向下传值），重名判定必须分层 —— 禁止全文档 includes（一层同名即
// 误杀另一层，是"add_parameter 补报表级 fine_username 报已存在"的根因）。

/** 参数名合法性（与 validator 命名口径对齐：字母数字下划线/CJK/$，F7） */
function assertParamName(name) {
  if (!name || !/^[A-Za-z_\u4e00-\u9fff$][\w\u4e00-\u9fff$]{0,63}$/.test(String(name))) {
    throw new Error(`参数名 "${name}" 非法：须为字母/下划线/CJK/$开头, 仅含字母数字下划线/CJK/$, 长度 1-64`);
  }
  return String(name);
}

/** 数据集层目标 <Parameters>…</Parameters> 范围：dsName 指定某数据集，缺省首个（legacy 行为） */
function datasetParametersRange(raw, dsName) {
  if (dsName != null) {
    const [db, de] = locateDataset(raw, dsName);
    const seg = raw.slice(db, de);
    const o = seg.indexOf('<Parameters>');
    if (o < 0) throw new Error(`定位失败：数据集 ${dsName} 内无 <Parameters>`);
    const abs = db + o;
    const close = raw.indexOf('</Parameters>', abs);
    if (close < 0) throw new Error(`定位失败：数据集 ${dsName} 的 <Parameters> 未闭合`);
    return [abs, close + '</Parameters>'.length];
  }
  const anchor = '</Parameters>';
  if (!raw.includes(anchor)) throw new Error('定位失败：未找到 </Parameters>');
  const o = raw.indexOf('<Parameters>');
  const close = raw.indexOf('</Parameters>', Math.max(0, o));
  return [o < 0 ? 0 : o, close + anchor.length];
}

/** 报表级参数区 <ReportParameterAttr>…</ReportParameterAttr> 范围（不存在则引导先建面板） */
function reportParameterAttrRange(raw) {
  const s = raw.indexOf('<ReportParameterAttr>');
  if (s < 0) throw new Error('报表级参数区不存在：请先调 set_parameter_panel 创建参数面板（ReportParameterAttr），再用 scope="report" 新增报表级参数');
  const e = raw.indexOf('</ReportParameterAttr>', s);
  if (e < 0) throw new Error('定位失败：ReportParameterAttr 未闭合');
  return [s, e + '</ReportParameterAttr>'.length];
}

/** 在 [start,end) 内定位 <Parameter> 块（含 <Attributes name="X"/>），找不到返回 null（分层判重用） */
function findParameterInRange(raw, start, end, name) {
  let cursor = start;
  while (true) {
    const s = raw.indexOf('<Parameter>', cursor);
    if (s < 0 || s >= end) return null;
    const [b, e] = blockRange(raw, s, '<Parameter>', '</Parameter>');
    if (raw.slice(s, e).includes(`<Attributes name="${name}"/>`)) return [s, e];
    cursor = e;
  }
}

/** 改/删的跨层定位：scope=dataset/report 定层；auto 跨层唯一自动定位、两层同名抛错明确 */
function resolveParameter(raw, name, scope, dsName) {
  const tryDataset = () => {
    let range;
    try { range = datasetParametersRange(raw, dsName); } catch { return null; }
    const hit = findParameterInRange(raw, range[0], range[1], name);
    return hit ? [...hit, 'dataset'] : null;
  };
  const tryReport = () => {
    let range;
    try { range = reportParameterAttrRange(raw); } catch { return null; }
    const hit = findParameterInRange(raw, range[0], range[1], name);
    return hit ? [...hit, 'report'] : null;
  };
  if (scope === 'dataset') {
    const hit = tryDataset();
    if (!hit) throw new Error(`定位失败：数据集层无参数 ${name}${dsName ? `（数据集 ${dsName}）` : ''}（报表级同名请传 scope="report"）`);
    return hit;
  }
  if (scope === 'report') {
    const hit = tryReport();
    if (!hit) throw new Error(`定位失败：报表级无参数 ${name}（数据集层同名请传 scope="dataset"）`);
    return hit;
  }
  if (scope !== 'auto' && scope != null) throw new Error(`scope 非法："${scope}"（仅支持 auto/dataset/report）`);
  const d = tryDataset();
  const r = tryReport();
  if (d && r) throw new Error(`参数 "${name}" 在数据集层与报表级同时存在，请明确 scope="dataset" 或 scope="report"`);
  if (d) return d;
  if (r) return r;
  throw new Error(`定位失败：未找到 参数 ${name}`);
}

/** 定位数据集块，返回 [块起始, 块结束] */
function locateDataset(raw, name, what = `数据集 ${name}`) {
  const starts = findAll(raw, '<TableData ');
  for (const s of starts) {
    const segTo = raw.slice(s, s + 400);
    if (segTo.includes(`name="${name}"`)) {
      const [b, e] = blockRange(raw, s, '<TableData ', '</TableData>');
      return [b, e];
    }
  }
  throw new Error(`定位失败：未找到 ${what}`);
}

/** 在块内定位子块（openTag..closeTag）的完整范围 */
function locateChildBlock(raw, blockStart, blockEnd, openTag, closeTag, what) {
  const seg = raw.slice(blockStart, blockEnd);
  const o = seg.indexOf(openTag);
  if (o < 0) throw new Error(`定位失败：${what} 段内无 ${openTag}`);
  const abs = blockStart + o;
  const [b, e] = blockRange(raw, abs, openTag, closeTag);
  return [b, e];
}

/** 在块内定位 CDATA 内容范围，返回 [contentStart, contentEnd, oldContent] */
function cdataRangeIn(raw, blockStart, blockEnd, what) {
  const seg = raw.slice(blockStart, blockEnd);
  const o = seg.indexOf('<![CDATA[');
  if (o < 0) throw new Error(`定位失败：${what} 段内无 CDATA`);
  const c = seg.indexOf(']]>', o + 9);
  if (c < 0) throw new Error(`定位失败：${what} 段内 CDATA 未闭合`);
  return [blockStart + o + 9, blockStart + c, raw.slice(blockStart + o + 9, blockStart + c)];
}

// ---------------- 参数 ----------------

export function updateParameter(path, name, defaultValue, newName, scope = 'auto', dsName) {
  name = assertParamName(name);
  if (newName != null) assertParamName(newName);
  const { raw } = load(path);
  let out = raw;
  if (defaultValue !== undefined) {
    const safeVal = assertSafeCdata(defaultValue, `参数 ${name} 默认值`);
    const [pb, pe] = resolveParameter(out, name, scope, dsName);
    const seg = out.slice(pb, pe);
    const o = seg.indexOf('<O>');
    const oBlock = blockRange(out, pb + o, '<O>', '</O>');
    const [cs, ce] = cdataRangeIn(out, oBlock[0], oBlock[1], `参数 ${name} 默认值`);
    out = out.slice(0, cs) + safeVal + out.slice(ce);
  }
  if (newName) {
    const [pb2, pe2, foundScope] = resolveParameter(out, name, scope, dsName);
    // 同层改名判重（跨层同名合法，不拦）
    const layerRange = foundScope === 'report'
      ? reportParameterAttrRange(out)
      : datasetParametersRange(out, dsName);
    if (findParameterInRange(out, layerRange[0], layerRange[1], newName)) {
      throw new Error(`参数名 "${newName}" 在${foundScope === 'report' ? '报表级' : '数据集层'}已存在`);
    }
    const seg2 = out.slice(pb2, Math.min(pe2, pb2 + 200));
    const attrIdx = seg2.indexOf(`<Attributes name="${name}"`);
    out = out.slice(0, pb2 + attrIdx + `<Attributes name="`.length) + newName + out.slice(pb2 + attrIdx + `<Attributes name="`.length + name.length);
  }
  save(path, out);
  return { action: 'update_parameter', name, defaultValue, newName, scope, bytes: Buffer.byteLength(out, 'utf8') };
}

/**
 * 数据集/报表级参数 XML（M110）。
 *
 * 值以 "=" 开头 → 官方【公式参数】形态 `<O t="XMLable" class="com.fr.base.Formula">`，
 * 用于把数据集参数绑到单元格（如 `=A5`）—— 这正是官方"下拉联动/按单元格过滤"的过滤那一半：
 *   单元格下拉 → TableDataDictionary(绑数据集) → 数据集 SQL 带参数 → 参数值 =A5（引用项目格）
 * 官方 1550 份实测：<Parameter> 共 2235 个，值为公式的 189 个，其中直接引用单元格(=A1)的 36 个
 * （如 数据钻取主报表.cpt `参数 id = =A5`、demobetter.cpt `参数 tName = =B2`）。
 * 非 "=" 开头仍写字面量形态，与旧行为逐字节一致。
 */
export function parameterXml(name, value) {
  const v = value == null ? '' : String(value);
  const n = escapeXmlAttr(String(name));
  if (v.trim().startsWith('=')) {
    return `<Parameter>\n<Attributes name="${n}"/>\n<O t="XMLable" class="com.fr.base.Formula">\n<Attributes>\n<![CDATA[${assertSafeCdata(v.trim(), `参数 ${name} 公式`)}]]></Attributes>\n</O>\n</Parameter>`;
  }
  return `<Parameter>\n<Attributes name="${n}"/>\n<O>\n<![CDATA[${assertSafeCdata(v, `参数 ${name} 默认值`)}]]></O>\n</Parameter>`;
}

export function addParameter(path, name, defaultValue = '', scope = 'dataset', dsName) {
  name = assertParamName(name);
  if (scope !== 'dataset' && scope !== 'report') {
    throw new Error(`scope 非法："${scope}"（仅支持 dataset=数据集层 / report=报表级）`);
  }
  const { raw } = load(path);
  // M110：值 "=" 开头 → 公式参数（绑单元格）；否则字面量（与旧行为逐字节一致）
  const snippet = `${parameterXml(name, defaultValue)}\n`;
  let out;
  if (scope === 'report') {
    const [rs, re] = reportParameterAttrRange(raw);
    if (findParameterInRange(raw, rs, re, name)) {
      throw new Error(`报表级参数 "${name}" 已存在（同层互斥；跨层同名请用 scope="dataset" 写入数据集层）`);
    }
    const anchor = '</ReportParameterAttr>';
    out = raw.slice(0, re - anchor.length) + snippet + raw.slice(re - anchor.length);
  } else {
    const [ps, pe] = datasetParametersRange(raw, dsName);
    if (findParameterInRange(raw, ps, pe, name)) {
      throw new Error(`数据集参数 "${name}" 已存在${dsName ? `（数据集 ${dsName}）` : ''}（同层互斥；跨层同名请用 scope="report" 写入报表级）`);
    }
    const anchor = '</Parameters>';
    out = raw.slice(0, pe - anchor.length) + snippet + raw.slice(pe - anchor.length);
  }
  save(path, out);
  return { action: 'add_parameter', name, defaultValue, scope, bytes: Buffer.byteLength(out, 'utf8') };
}

export function deleteParameter(path, name, scope = 'auto', dsName) {
  name = assertParamName(name);
  const { raw } = load(path);
  const [pb, pe] = resolveParameter(raw, name, scope, dsName);
  const out = removeRange(raw, pb, pe);
  save(path, out);
  return { action: 'delete_parameter', name, scope, bytes: Buffer.byteLength(out, 'utf8') };
}

// ---------------- 数据集 SQL ----------------

export function updateDatasetSql(path, datasetName, sql) {
  if (!sql || !String(sql).trim()) throw new Error(`update_dataset: 数据集 ${datasetName} 的 SQL 不能为空`);
  const safeSql = assertSafeCdata(sql, 'SQL 文本');
  const { raw } = load(path);
  const [db, de] = locateDataset(raw, datasetName);
  const [qb, qe] = locateChildBlock(raw, db, de, '<Query>', '</Query>', `数据集 ${datasetName} Query`);
  const [cs, ce] = cdataRangeIn(raw, qb, qe, `数据集 ${datasetName} SQL`);
  const out = raw.slice(0, cs) + safeSql + raw.slice(ce);
  save(path, out);
  return { action: 'update_dataset_sql', dataset: datasetName, bytes: Buffer.byteLength(out, 'utf8') };
}

// ---------------- 单元格 ----------------

/** 定位单元格 <C c="X" r="Y"> 块（属性顺序不敏感；sheet 可选：限指定工作表） */
function locateCell(raw, column, row, what = `单元格(${column},${row})`, sheet) {
  let lo = 0, hi = raw.length;
  if (sheet != null) { const b = locateSheet(raw, sheet); lo = b.start; hi = b.end; }
  const starts = findAll(raw, '<C ').filter((s) => s >= lo && s < hi);
  const hits = [];
  for (const s of starts) {
    // 读完整开标签（属性多的单元格 <C c r s cs rs ...> 可能超过固定截断长度）
    const gt = raw.indexOf('>', s);
    const head = raw.slice(s, gt < 0 ? s + 200 : gt + 1);
    const m = head.match(/^<C\s+([^>]*)>/);
    if (!m) continue;
    const attrs = m[1];
    const get = (k) => (attrs.match(new RegExp(`\\b${k}="([^"]*)"`)) || [])[1];
    if (get('c') === String(column) && get('r') === String(row)) hits.push(s);
  }
  if (hits.length === 0) throw new Error(`定位失败：未找到 ${what}`);
  // 【M91 防误删】未传 sheet 且同坐标在多个工作表均存在 → 拒绝静默命中第一格。
  // 前车：V3 双通道模板 sheet1/sheet2 同坐标格并存（如 C1/C2-R2），缺省曾取首表导致改错通道；
  // sheet1-C5 与 sheet2-C15 同为规格列，C5/C15 一字之差更易连环打错。必须显式传 sheet（0 起索引或表名）。
  if (sheet == null && hits.length > 1) {
    const blocks = sheetBlocks(raw);
    const where = hits.map((s) => {
      const bi = blocks.findIndex((b) => s >= b.start && s < b.end);
      return bi < 0 ? '未知表' : `表${bi}${blocks[bi].name ? `(${blocks[bi].name})` : ''}`;
    });
    throw new Error(`定位失败：${what} 在 ${hits.length} 个工作表均存在（${where.join('、')}），未传 sheet 无法确定改哪一格（禁止静默命中第一格）。请传 sheet=表索引（0 起）或表名后重试。`);
  }
  const [b, e] = blockRange(raw, hits[0], '<C ', '</C>');
  return [b, e];
}

// ---------------- 填报行完整性：InsertPolicy（复制策略） ----------------
//
// 【背景】填报模板「填报行完整性」的最后一环落在单元格的插入策略上：数据行各格必须带
// <CellInsertPolicy><InsertPolicy><![CDATA[copy]]></InsertPolicy></CellInsertPolicy>，
// 插入新行时该格才复制上一行值（否则值为空/默认，提交时主键与关联列缺值）。
// 此前 MCP 无任何入口可写这条属性，业务侧只能"备份后直写 XML"绕过 MCP 通道 —— 本组入口把它收回。
//
// 【真实枚举取证】jar 常量池逆向（scripts/fr-audit-probe.mjs 同源的解析器，只读常量池/字节码）：
//   engine jar  com.fr.report.cell.cellattr.CellInsertPolicyAttr implements com.fr.stable.xml.XMLable
//     fields: XML_TAG / INSERT_POLICY_NULL / INSERT_POLICY_DEFAULT / INSERT_POLICY_COPY / insertPolicy / defaultInsertValue
//     <clinit>: XML_TAG="CellInsertPolicy"; INSERT_POLICY_NULL="null"; INSERT_POLICY_DEFAULT="default"; INSERT_POLICY_COPY="copy"
//     writeXML: startTAG(XML_TAG) → 若入参 != "null" 才 textNode(<InsertPolicy> 的 CDATA) → writeObject(defaultInsertValue) → end
//   即官方枚举只有三个取值：null（=「不写该节点」的语义，节点不落盘）/ default / copy。
//   模板侧元素形态固定为 <CellInsertPolicy><InsertPolicy><![CDATA[值]]></InsertPolicy></CellInsertPolicy>。
// 【位置取证】CellInsertPolicyAttr 是单元格的可选属性之一，序列化位置 = 单元格属性区
//   （<PrivilegeControl/> → <CellOptionalAttrHolder> 之后）→ <Expand> 之前；与设计器
//   "其他属性"面板的落盘顺序一致，也与本模块既有的 ToolTipText 插入锚点策略同源。
export const INSERT_POLICY_VALUES = Object.freeze(['null', 'default', 'copy']);
const INSERT_POLICY_SET = new Set(INSERT_POLICY_VALUES);
/** copy = 插入行时复制上一行该格的值（填报行完整性要求的取值） */
export const INSERT_POLICY_COPY = 'copy';

/** 校验 InsertPolicy 取值（仅真实枚举），返回规范化字符串 */
export function normalizeInsertPolicy(value, what = 'insertPolicy') {
  const v = String(value).trim();
  if (!INSERT_POLICY_SET.has(v)) {
    throw new Error(`${what} 取值非法 "${value}"：官方枚举只有 ${INSERT_POLICY_VALUES.join(' / ')}（copy=插入行复制上一行值；default=走默认插入值；null=不写该节点）`);
  }
  return v;
}

/**
 * 定位元素的完整范围 [start, end)，**同时兼容自闭合写法**。
 * 为什么必须有这个工具：官方 1550 样本里 <CellInsertPolicy/> 自闭合形态出现 576 处 / 82 份模板
 * （设计器把 null 值落盘成自闭合），而 lib/xml.js 的 blockRange 只认「开标签 + 配对闭标签」，
 * 对自闭合会直接抛「未找到闭合标签」—— 即"官方主流形态下写入口全线失效"，把业务侧又逼回直写 XML。
 * @param {string} container 文本容器（整篇 raw 或某个单元格块 seg）
 * @param {number} idx 元素起始下标（必须指向 '<'）
 * @param {string} tag 元素名（如 CellInsertPolicy）
 */
function elementBlockRange(container, idx, tag) {
  const gt = container.indexOf('>', idx);
  if (gt < 0) throw new Error(`块定位失败：${tag} 开标签未闭合`);
  const selfClosing = /\/\s*$/.test(container.slice(idx, gt));
  if (selfClosing) return [idx, gt + 1];
  return blockRange(container, idx, `<${tag}`, `</${tag}>`);
}

/** 定位单元格块内最外层 <CellInsertPolicy> 块（自闭合形态兼容），返回 [块起始, 块结束]，无则 null */
function locateCellInsertPolicy(raw, cb, ce) {
  const hits = findAll(raw, '<CellInsertPolicy').filter((i) => i >= cb && i < ce);
  if (!hits.length) return null;
  return elementBlockRange(raw, hits[0], 'CellInsertPolicy');
}

/**
 * 在单元格块文本 seg 内插入 CellInsertPolicy 节点（返回新 seg）。
 * 位置：<PrivilegeControl/> / <CellOptionalAttrHolder> 之后 → <Expand> 之前 → 块尾。
 * 取证：AbstractCellElement.writeXML 的顺序是 值(O) → CellPrivilegeControl → writerAttrXML，
 * 而 writerAttrXML → writeOtherAttr 里 CellOptionalAttrHolder 与 CellInsertPolicyAttr 同属
 * optionalAttributes，故 CellInsertPolicy 就在 CellOptionalAttrHolder 之后、<Expand>（由 ElementCase
 * 写入）之前 —— 与设计器"其他属性"面板落盘顺序一致。
 * 形态用单空格紧凑写法（与本模块既有节点插入约定一致，XML 语义等价）。
 */
export function upsertCellInsertPolicyXml(seg, value) {
  const node = `<CellInsertPolicy><InsertPolicy><![CDATA[${value}]]></InsertPolicy></CellInsertPolicy>`;
  const privIdx = seg.indexOf('<PrivilegeControl/>');
  // [\s/>] 覆盖自闭合 <CellOptionalAttrHolder/>（旧正则 [\s>] 漏掉 '/'，会静默退到别的锚点）
  const optIdx = seg.search(/<CellOptionalAttrHolder[\s/>]/);
  // 取两者中靠后的锚点（官方顺序：PrivilegeControl 在 CellOptionalAttrHolder 之前）
  if (optIdx >= 0) {
    const [, oe] = elementBlockRange(seg, optIdx, 'CellOptionalAttrHolder');
    return seg.slice(0, oe) + node + seg.slice(oe);
  }
  if (privIdx >= 0) {
    const at = privIdx + '<PrivilegeControl/>'.length;
    return seg.slice(0, at) + node + seg.slice(at);
  }
  const exIdx = seg.search(/<Expand[\s/>]/);
  if (exIdx >= 0) return seg.slice(0, exIdx) + node + seg.slice(exIdx);
  const oIdx = seg.search(/<\/O>/);
  if (oIdx >= 0) {
    const at = oIdx + '</O>'.length;
    return seg.slice(0, at) + node + seg.slice(at);
  }
  // 兜底：直接插在 </C> 之前
  const closeIdx = seg.lastIndexOf('</C>');
  const at = closeIdx >= 0 ? closeIdx : seg.length;
  return seg.slice(0, at) + node + seg.slice(at);
}

/**
 * 写入/替换/删除单元格插入策略（update_cell 的 insertPolicy 参数同源实现）。
 *   value = 'copy' | 'default' | 'null' → 写入或替换（格内已有节点则只换 <InsertPolicy> 的 CDATA）
 *   value = null / ''                   → 删除整块 <CellInsertPolicy>（FR 语义：节点不落盘即 null）
 *   value = undefined                   → 不动（调用方不应调用）
 */
export function updateCellInsertPolicy(path, column, row, value, sheet) {
  const remove = value === null || value === undefined || String(value).trim() === '';
  const policy = remove ? null : normalizeInsertPolicy(value, `单元格(${column},${row}) insertPolicy`);
  const { raw } = load(path);
  const [cb, ce] = locateCell(raw, column, row, `单元格(${column},${row})`, sheet);
  const seg = raw.slice(cb, ce);
  const found = locateCellInsertPolicy(raw, cb, ce);
  let out;
  let mode;
  if (found) {
    const [b, e] = found;
    if (remove) {
      // 删除整块（自闭合与完整形态同一路径）。若节点独占一行（官方设计器落盘形态），
      // 连同该行的缩进与换行一并删掉，避免在单元格内留下空行。
      let from = b;
      let to = e;
      const lineStart = raw.lastIndexOf('\n', b - 1) + 1;
      if (raw.slice(lineStart, b).trim() === '' && /^\s*$/.test(raw.slice(e, raw.indexOf('\n', e) < 0 ? raw.length : raw.indexOf('\n', e)))) {
        from = lineStart;
        const nl = raw.indexOf('\n', e);
        if (nl >= 0) to = nl + 1;
      }
      out = raw.slice(0, from) + raw.slice(to);
      mode = raw.slice(b, e).includes('</CellInsertPolicy>') ? 'remove' : 'remove-self-closing';
    } else {
      const node = `<CellInsertPolicy><InsertPolicy><![CDATA[${policy}]]></InsertPolicy></CellInsertPolicy>`;
      out = raw.slice(0, b) + node + raw.slice(e);
      mode = raw.slice(b, e).includes('</CellInsertPolicy>') ? 'update' : 'update-self-closing';
    }
  } else {
    if (remove) return { action: 'update_cell_insert_policy', cell: `${column},${row}`, mode: 'absent', insertPolicy: null, bytes: Buffer.byteLength(raw, 'utf8') };
    out = raw.slice(0, cb) + upsertCellInsertPolicyXml(seg, policy) + raw.slice(ce);
    mode = 'insert';
  }
  save(path, out);
  return { action: 'update_cell_insert_policy', cell: `${column},${row}`, mode, insertPolicy: policy, bytes: Buffer.byteLength(out, 'utf8') };
}

export function updateCellTooltip(path, column, row, tooltip, sheet) {
  const safeVal = assertSafeCdata(tooltip, 'ToolTipText');
  const { raw } = load(path);
  const [cb, ce] = locateCell(raw, column, row, `单元格(${column},${row})`, sheet);
  const seg = raw.slice(cb, ce);
  const tIdx = seg.indexOf('<ToolTipText>');
  if (tIdx >= 0) {
    const [tb, te] = blockRange(raw, cb + tIdx, '<ToolTipText>', '</ToolTipText>');
    const [cs, ce2] = cdataRangeIn(raw, tb, te, 'ToolTipText');
    const out = raw.slice(0, cs) + safeVal + raw.slice(ce2);
    save(path, out);
    return { action: 'update_cell_tooltip', cell: `${column},${row}`, mode: 'update', bytes: Buffer.byteLength(out, 'utf8') };
  }
  // M82: 格内无提示节点 → 补建（设计器地面真值：通知排产表.cpt =$$$ 悬停形态）。
  // 位置：CellGUIAttr 存在则作其首个子节点；否则在 <PrivilegeControl/> 后新建整块
  // （设计器顺序 O → PrivilegeControl → CellGUIAttr → …）。
  const tipNode = `<ToolTipText>\n<![CDATA[${safeVal}]]></ToolTipText>`;
  const guiMatch = seg.match(/<CellGUIAttr\b[^>]*>/);
  let out;
  if (guiMatch) {
    const abs = cb + guiMatch.index + guiMatch[0].length;
    out = raw.slice(0, abs) + '\n' + tipNode + raw.slice(abs);
  } else {
    const guiBlock = `<CellGUIAttr adjustmode="0" customTooltip="false">\n${tipNode}\n</CellGUIAttr>`;
    const privIdx = seg.indexOf('<PrivilegeControl/>');
    if (privIdx >= 0) {
      const abs = cb + privIdx + '<PrivilegeControl/>'.length;
      out = raw.slice(0, abs) + '\n' + guiBlock + raw.slice(abs);
    } else {
      // 无 PrivilegeControl 的极简格：插到内容节点后（Expand 之前）
      const exIdx = seg.indexOf('<Expand');
      const abs = exIdx >= 0 ? cb + exIdx : ce;
      out = raw.slice(0, abs) + guiBlock + '\n' + raw.slice(abs);
    }
  }
  save(path, out);
  return { action: 'update_cell_tooltip', cell: `${column},${row}`, mode: 'insert', bytes: Buffer.byteLength(out, 'utf8') };
}

export function updateCellContent(path, column, row, content, sheet) {
  const safeVal = assertSafeCdata(content, 'Content');
  const { raw } = load(path);
  const [cb, ce] = locateCell(raw, column, row, `单元格(${column},${row})`, sheet);

  // 2026-10-29 公式闭环（sandbox19 v1 会话「不能改公式」根因）：
  //   官方公式单元格 = <O t="XMLable" class="com.fr.base.Formula"><Attributes><![CDATA[=...]]></Attributes></O> 对象。
  //   ① 已有公式对象 → content 以 = 开头时【原位改公式】，不再被"对象内容不能当纯文本改"挡死；
  //   ② 普通文本 <O> 且 content 以 = 开头 → 按用户意图升级成官方公式对象（裸 CDATA 的 = 文本 FR 不计算）。
  const wantsFormula = /^\s*=/.test(String(content ?? ''));
  const formulaHits = findAll(raw, '<O t="XMLable" class="com.fr.base.Formula">').filter((i) => i >= cb && i < ce);
  if (formulaHits.length > 0) {
    if (!wantsFormula) {
      throw new Error(`单元格(${column},${row}) 是公式对象：改公式请传 = 开头的公式（如 "=ROW()-4"）；要改成文本请用 set_cell_content_type({contentType:"text", content:"...", force:true})`);
    }
    const expr = normalizeFormulaExpr(content, '公式');
    const out = replaceFormulaExprInCell(raw, formulaHits[0], ce, expr);
    save(path, out);
    return { action: 'update_cell_content', cell: `${column},${row}`, mode: 'formula-update', formula: expr, bytes: Buffer.byteLength(out, 'utf8') };
  }

  // 优先 <Content>（脚本节点）；<O t=...> 其他对象内容不可当文本改
  let tagOpen = '<Content>', tagClose = '</Content>';
  let absIdx = findAll(raw, '<Content>').find((i) => i >= cb && i < ce);
  if (absIdx == null) {
    const oHits = findAll(raw, '<O>').filter((i) => i >= cb && i < ce);
    const oTHits = findAll(raw, '<O t="').filter((i) => i >= cb && i < ce);
    // 先判其他对象内容（DSColumn/Image/图表等），再判无内容节点
    if (oTHits.length > 0) {
      throw new Error(`单元格(${column},${row}) 为对象内容（<O t=...>，如 DSColumn/Image/图表），不能作为纯文本修改；要换型请用 set_cell_content_type（对象内容需 force:true）`);
    }
    if (oHits.length === 0) throw new Error(`定位失败：单元格(${column},${row}) 无 <Content> 或 <O> 内容节点`);
    if (wantsFormula) {
      const [tb, te] = blockRange(raw, oHits[0], '<O>', '</O>');
      const expr = normalizeFormulaExpr(content, '公式');
      const out = raw.slice(0, tb) + formulaObjectXml(expr, '公式') + raw.slice(te);
      save(path, out);
      return { action: 'update_cell_content', cell: `${column},${row}`, mode: 'formula-convert', formula: expr, bytes: Buffer.byteLength(out, 'utf8') };
    }
    tagOpen = '<O>';
    tagClose = '</O>';
    absIdx = oHits[0];
  } else if (wantsFormula) {
    throw new Error(`单元格(${column},${row}) 当前是脚本内容（<Content>）；要改成公式请用 set_cell_content_type({contentType:"formula", formula:"=..."})`);
  }
  const [tb, te] = blockRange(raw, absIdx, tagOpen, tagClose);
  const [cs, ce2] = cdataRangeIn(raw, tb, te, 'Content');
  const out = raw.slice(0, cs) + safeVal + raw.slice(ce2);
  save(path, out);
  return { action: 'update_cell_content', cell: `${column},${row}`, bytes: Buffer.byteLength(out, 'utf8') };
}

/** 在已定位的公式对象 <O t="XMLable" class="com.fr.base.Formula"> 内替换 <Attributes> CDATA 正文（保持对象形态） */
function replaceFormulaExprInCell(raw, objIdx, cellEnd, expr) {
  const aStart = raw.indexOf('<Attributes>', objIdx);
  if (aStart < 0 || aStart >= cellEnd) {
    throw new Error('公式对象缺少 <Attributes> 节点（官方形态应为 <O t="XMLable" class="com.fr.base.Formula"><Attributes><![CDATA[=...]]></Attributes></O>）');
  }
  const [ab, ae] = blockRange(raw, aStart, '<Attributes>', '</Attributes>');
  const [cs, ce2] = cdataRangeIn(raw, ab, ae, 'Attributes');
  return raw.slice(0, cs) + expr + raw.slice(ce2);
}

export function deleteCell(path, column, row, sheet) {
  const { raw } = load(path);
  const [cb, ce] = locateCell(raw, column, row, `单元格(${column},${row})`, sheet);
  const out = removeRange(raw, cb, ce);
  save(path, out);
  return { action: 'delete_cell', cell: `${column},${row}`, bytes: Buffer.byteLength(out, 'utf8') };
}

// ---------------- 批量单元格区间操作 ----------------
//
// 背景：用户报告"重建单元格列位错位（如 c8 多了重复列导致 c9-c25 整体后移）时，
// 每格 delete+add 要 ~40 次操作，token 花费巨大"。方案：提供区间级批量工具，
// 一次调用完成「删除整段列 + 把右侧剩余列整体左移」（delete_cell_range + shift_cell_range），
// 并同步改写受影响坐标（<C c= r=>）、填报绑定（ColumnRow）、扩展父格引用（left/up）。

/** 定位工作表内所有单元格块，返回 [{start,end,c,r,head({start,end})}]（start/end 为 <C> 整块） */
function cellsInSheet(raw, sheet) {
  let lo = 0, hi = raw.length;
  if (sheet != null) { const b = locateSheet(raw, sheet); lo = b.start; hi = b.end; }
  const out = [];
  const starts = findAll(raw, '<C ').filter((s) => s >= lo && s < hi);
  for (const s of starts) {
    const gt = raw.indexOf('>', s);
    const head = raw.slice(s, gt < 0 ? s + 200 : gt + 1);
    const m = head.match(/^<C\s+([^>]*)>/);
    if (!m) continue;
    const attrs = m[1];
    const get = (k) => (attrs.match(new RegExp(`\\b${k}="([^"]*)"`)) || [])[1];
    const c = get('c'), r = get('r');
    if (c == null || r == null) continue;
    const [b, e] = blockRange(raw, s, '<C ', '</C>');
    out.push({
      start: b, end: e,
      headStart: s,
      headEnd: gt + 1,
      c: Number(c), r: Number(r),
      cs: get('cs') == null ? 1 : Number(get('cs')),
      rs: get('rs') == null ? 1 : Number(get('rs')),
    });
  }
  return out;
}

/**
 * 扫描 A1 引用（公式文本）。跳过双引号字符串字面量；排除函数名（如 LOG10()）与更长标识符。
 * 只用于"改写窗口/陈旧引用体检"，不做公式求值。
 */
function scanA1RefsInFormula(text) {
  const s = String(text ?? '');
  const out = [];
  let inStr = false;
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (ch === '"') {
      if (inStr && s[i + 1] === '"') { i += 1; continue; }
      inStr = !inStr;
      continue;
    }
    if (inStr) continue;
    const start = i;
    let j = i;
    if (s[j] === '$') j += 1;
    const lettersStart = j;
    while (j < s.length && /[A-Za-z]/.test(s[j])) j += 1;
    const letters = s.slice(lettersStart, j);
    if (letters.length === 0 || letters.length > 3) continue;
    if (s[j] === '$') j += 1;
    const digitsStart = j;
    while (j < s.length && /[0-9]/.test(s[j])) j += 1;
    if (j === digitsStart) continue;
    const digits = s.slice(digitsStart, j);
    const prev = start > 0 ? s[start - 1] : '';
    if (prev && /[A-Za-z0-9_.$]/.test(prev)) continue;
    const next = s[j] ?? '';
    if (next === '(' || /[A-Za-z0-9_]/.test(next)) continue;
    const col = colLettersToIndex(letters);
    const row = Number(digits) - 1;
    if (!Number.isInteger(col) || col < 0 || !Number.isInteger(row) || row < 0) continue;
    out.push({ start, end: j, ref: s.slice(start, j), col, row });
    i = j - 1;
  }
  return out;
}

/**
 * 收集工作表内所有"含 A1 引用的公式文本"位置（列位调整后的陈旧引用体检用）：
 *  - 单元格公式对象 <O class="com.fr.base.Formula"><Attributes><![CDATA[...]]>；
 *  - FormulaCondition（提交条件 / 条件属性 Highlight）。
 * 返回 [{ kind, pos, cell, submit, text }]，pos 为公式块绝对起点（用于排除"将被一起删掉"的块）。
 */
function collectFormulaSites(raw, lo, hi) {
  const sites = [];
  // 1) 单元格公式对象
  for (const s of findAll(raw, '<O ').filter((x) => x >= lo && x < hi)) {
    const gt = raw.indexOf('>', s);
    if (gt < 0) continue;
    const head = raw.slice(s, gt + 1);
    if (!/class="com\.fr\.base\.Formula"/.test(head)) continue;
    if (head.trimEnd().endsWith('/>')) continue;
    let be;
    try { be = blockRange(raw, s, '<O ', '</O>'); } catch { continue; }
    const seg = raw.slice(be[0], be[1]);
    const cd = /<Attributes>\s*<!\[CDATA\[([\s\S]*?)\]\]>/.exec(seg);
    if (!cd) continue;
    const cStart = raw.lastIndexOf('<C ', s);
    let cell = null;
    if (cStart >= lo) {
      const head2 = raw.slice(cStart, raw.indexOf('>', cStart) + 1);
      const cm = head2.match(/\bc="(\d+)"/);
      const rm = head2.match(/\br="(\d+)"/);
      if (cm && rm) cell = `${indexToColLetters(Number(cm[1]))}${Number(rm[1]) + 1}`;
    }
    sites.push({ kind: 'cell-formula', pos: be[0], cell, submit: null, text: cd[1] });
  }
  // 2) FormulaCondition（提交条件在 DMLConfig 内；条件属性在单元格 HighlightList 内）
  for (const s of findAll(raw, '<Condition ').filter((x) => x >= lo && x < hi)) {
    const gt = raw.indexOf('>', s);
    if (gt < 0) continue;
    const head = raw.slice(s, gt + 1);
    if (!head.includes('com.fr.data.condition.FormulaCondition')) continue;
    if (head.trimEnd().endsWith('/>')) continue;
    let be;
    try { be = blockRange(raw, s, '<Condition ', '</Condition>'); } catch { continue; }
    const seg = raw.slice(be[0], be[1]);
    const cd = /<Formula>\s*<!\[CDATA\[([\s\S]*?)\]\]>/.exec(seg);
    if (!cd) continue;
    const svStart = raw.lastIndexOf('<SubmitVisitor', s);
    let submit = null;
    if (svStart >= lo) {
      const svCount = findAll(raw.slice(lo, svStart), '<SubmitVisitor').length;
      submit = svCount;
    }
    sites.push({ kind: 'condition', pos: be[0], cell: null, submit, text: cd[1] });
  }
  return sites;
}

/**
 * 陈旧引用体检（只读、不改字节）：列/行区间挪移后，公式与提交条件里的 A1 引用不会自动改写，
 * 历史上因此出现过"提交条件还写着 Y5=1、一行都不过滤"的静默失败（sandbox19/v1）。
 * classify(col,row) 返回 null（不涉及）或 { issue, suggest? }。
 */
function findStaleRefs(raw, lo, hi, classify, skipPos = null) {
  const refs = [];
  const seen = new Set();
  for (const site of collectFormulaSites(raw, lo, hi)) {
    if (skipPos && skipPos(site.pos)) continue;
    for (const r of scanA1RefsInFormula(site.text)) {
      const hit = classify(r.col, r.row);
      if (!hit) continue;
      const where = site.kind === 'cell-formula'
        ? `单元格 ${site.cell ?? '?'} 公式`
        : site.submit != null ? `提交#${site.submit} 条件` : '条件属性公式';
      const key = `${where}|${r.ref}|${hit.issue}|${hit.suggest ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      refs.push({ where, ref: r.ref, ...hit });
      if (refs.length >= 100) return refs;
    }
  }
  return refs;
}

/** 把 staleRefs 拼成给模型的可读提示（为空返回空串） */
function staleRefsHint(refs) {
  if (!refs || refs.length === 0) return '';
  const head = refs.slice(0, 6).map((r) => `${r.where}：${r.ref}${r.suggest ? `→${r.suggest}` : '（引用会被删除的列/行，悬空）'}`).join('；');
  return `⚠️ 检测到 ${refs.length} 处公式/提交条件仍引用旧坐标（本工具只改写填报绑定与扩展父格，不改公式/条件文本）：${head}${refs.length > 6 ? ' …' : ''}。`
    + '修法：单元格公式用 update_cell({content:"=..."})；提交条件用 update_fill_submit({condition:"..."})；改完再 validate_cpt。';
}

/** 删除一段单元格区间（整列或整行带）。
 * 典型场景：c8 是重复列（多写了一个 combination），需要把 c8 整列删掉。
 * 若传 shiftLeft=true（默认），删除后把该列右侧的所有单元格整体左移一列，
 * 并同步改写填报绑定 ColumnRow 与扩展父格引用（left/up）的列坐标。
 * 只允许整列区间（fromRow/toRow 缺省所有行）；语义上等价于 Excel「删除整列 → 右侧自动左移」。
 * 跨行合并单元格（cs>1/rs>1）横跨被删列时拒绝（避免破坏合并区）。
 */
export function deleteCellRange(path, { sheet, fromColumn, toColumn, shiftLeft = true } = {}) {
  const from = Number(fromColumn), to = Number(toColumn);
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from) {
    throw new Error(`delete_cell_range: 列区间非法 (${fromColumn},${toColumn})，须 0<=fromColumn<=toColumn`);
  }
  const { raw } = load(path);
  const cells = cellsInSheet(raw, sheet);
  const inBand = cells.filter((c) => c.c >= from && c.c <= to);
  if (inBand.length === 0) throw new Error(`delete_cell_range: 列 ${from}..${to} 无单元格`);
  const width = to - from + 1;
  // 陈旧引用体检（只读）：公式/提交条件文本里的 A1 引用不会被本工具改写。
  // 公式块随所属单元格一起被删的情况不算（skipPos 排除）。
  let scanLo = 0, scanHi = raw.length;
  if (sheet != null) { const b0 = locateSheet(raw, sheet); scanLo = b0.start; scanHi = b0.end; }
  const insideDeletedCell = (pos) => inBand.some((c) => pos >= c.start && pos < c.end);
  const staleRefs = shiftLeft
    ? findStaleRefs(raw, scanLo, scanHi, (c, r) => {
      if (c >= from && c <= to) return { issue: 'dangling-ref' };
      if (c > to) return { issue: 'needs-shift', suggest: `${indexToColLetters(c - width)}${r + 1}` };
      return null;
    }, insideDeletedCell)
    : [];
  // 跨列合并防护（整列删除语义下的官方行为）：
  //  - 全宽标题横幅（anchor 在待删带左侧且完整覆盖待删带）：整体缩窄 cs，anchor 仍锚在左端
  //    （官方 FR 行为：删除列后标题横幅自动收窄，覆盖剩余列）
  //  - 合并区锚点落在待删带内部：拒绝（无法确定 FR 如何拆分，宁可报错让用户先解除合并）
  let banner = null;
  const mergedCross = cells.find((c) => c.cs > 1 && c.c <= to && c.c + c.cs - 1 >= from);
  if (mergedCross) {
    // 锚点严格在待删带左侧且完整覆盖待删带 -> 全宽标题横幅，缩窄 cs
    // 锚点落在待删带内部（含锚点恰在带内）-> 无法确定 FR 拆分语义，拒绝
    if (mergedCross.c < from && mergedCross.c + mergedCross.cs - 1 >= to) {
      banner = { c: mergedCross.c, r: mergedCross.r, cs: mergedCross.cs };
    } else {
      throw new Error(`delete_cell_range: 单元格 (${mergedCross.c},${mergedCross.r}) 为跨列合并区 (cs=${mergedCross.cs}，覆盖列 ${mergedCross.c}..${mergedCross.c + mergedCross.cs - 1})，与待删列 ${from}..${to} 相交且锚点位于待删带内。请先解除合并或缩小删除区间`);
    }
  }

  let out = raw;
  // 先删带内单元格（从后往前删，避免漂移）
  const sorted = [...inBand].sort((a, b) => b.start - a.start);
  for (const c of sorted) out = removeRange(out, c.start, c.end);

  // 标题横幅缩窄（删除后重新定位，避免旧索引漂移）
  if (banner) {
    const [bb, be] = locateCell(out, banner.c, banner.r, `标题横幅(${banner.c},${banner.r})`, sheet);
    const headEnd = out.indexOf('>', bb) + 1;
    out = replaceAttr(out, bb, headEnd, 'cs', String(banner.cs - width), `标题横幅 cs`);
  }

  let reboundCount = 0, refRewritten = 0;
  if (shiftLeft) {
    // 右侧剩余单元格整体左移 width 格
    let lo = 0, hi = out.length;
    if (sheet != null) { const b = locateSheet(out, sheet); lo = b.start; hi = b.end; }
    const remaining = cellsInSheet(out, sheet).filter((c) => c.c > to);
    // 从后往前改 c 属性（先改大列号，避免头部偏移影响后续定位——属性替换等长或变长，
    // 反向操作保证前面已处理的标签 index 仍有效）
    const rev = [...remaining].sort((a, b) => b.headStart - a.headStart);
    for (const c of rev) {
      const newC = c.c - width;
      if (newC < 0) throw new Error(`delete_cell_range: 左移后列号非法 (${c.c}->${newC})`);
      out = replaceAttr(out, c.headStart, c.headEnd, 'c', String(newC), `单元格(${c.c},${c.r})`);
    }
    // 同步改写填报绑定 ColumnRow 的 column（在被删列右侧的绑定左移）
    {
      const bind = findAll(out, '<ColumnRow ').filter((s) => s >= lo && s < hi);
      const revBind = [...bind].sort((a, b) => b - a);
      for (const s of revBind) {
        const seg = out.slice(s, out.indexOf('/>', s) + 2);
        const cm = seg.match(/\bcolumn="([^"]+)"/);
        const rm = seg.match(/\brow="([^"]+)"/);
        if (cm && Number(cm[1]) > to) {
          const newCol = Number(cm[1]) - width;
          const tagEnd = s + seg.indexOf('>') + 1;
          out = replaceAttr(out, s, tagEnd, 'column', String(newCol), `绑定行坐标`);
          reboundCount++;
        }
        // row 无关：整列删除不影响行
        void rm;
      }
    }
  }
  save(path, out);
  return {
    action: 'delete_cell_range', sheet: sheet ?? 0,
    columns: [from, to], deletedCells: inBand.length,
    shiftLeft, reboundCount, refRewritten,
    ...(staleRefs.length > 0 ? { staleRefs } : {}),
    hint: `已删除列 ${from}..${to}（${inBand.length} 个单元格）${shiftLeft ? `，右侧剩余列整体左移 ${width} 列` : ''}。${reboundCount ? `同步左移了 ${reboundCount} 个填报绑定坐标。` : ''}`
      + (staleRefs.length > 0 ? staleRefsHint(staleRefs) : '若模板内 JS/公式用旧列坐标引用，请一并确认。'),
    bytes: Buffer.byteLength(out, 'utf8'),
  };
}

/**
 * 删除一段行区间（整行带）—— Excel「删除整行 → 下方自动上移」语义（与 delete_cell_range 的列版对称）。
 *
 * 典型场景：重建时多写了一行、或某数据行整行作废，需要把整行删掉并让下方行上移补位。
 * 行轴与列轴不同：除了 r 坐标，还要同步 rs（跨行合并）、填报绑定 ColumnRow 的 row、
 * 扩展父格 up/left 引用的行号、以及 <RowHeight> 数组（列版对应的是 cs / column / ColumnWidth）。
 *
 * 安全边界（宁可报错不猜）：
 *  - 跨行合并区锚点在待删带内、或只部分覆盖待删带 → 拒绝
 *  - 锚点在带上方且**完整覆盖**待删带 → 整体缩窄 rs（与列版"全宽标题横幅自动缩窄 cs"对称）
 *  - 扩展父格引用（up/left）指向带内单元格、或填报绑定 row 落在带内 → 会留下悬空引用，直接拒绝
 *    （悬空引用要在渲染时才炸，排查成本极高；请先改引用/绑定再删行）
 */
export function deleteRowRange(path, { sheet, fromRow, toRow, shiftUp = true } = {}) {
  const from = Number(fromRow), to = Number(toRow);
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from) {
    throw new Error(`delete_row_range: 行区间非法 (${fromRow},${toRow})，须 0<=fromRow<=toRow`);
  }
  const { raw } = load(path);
  const cells = cellsInSheet(raw, sheet);
  const inBand = cells.filter((c) => c.r >= from && c.r <= to);
  const height = to - from + 1;
  const rowsBelow = cells.some((c) => c.r > to);
  // 陈旧引用体检（只读）：行轴删除同样不会自动改写公式/条件文本里的 A1 行号
  let scanLo = 0, scanHi = raw.length;
  if (sheet != null) { const b0 = locateSheet(raw, sheet); scanLo = b0.start; scanHi = b0.end; }
  const insideDeletedCell = (pos) => inBand.some((c) => pos >= c.start && pos < c.end);
  const staleRefs = shiftUp
    ? findStaleRefs(raw, scanLo, scanHi, (c, r) => {
      if (r >= from && r <= to) return { issue: 'dangling-ref' };
      if (r > to) return { issue: 'needs-shift', suggest: `${indexToColLetters(c)}${r - height + 1}` };
      return null;
    }, insideDeletedCell)
    : [];

  // 跨行合并防护
  let vmerge = null;
  const mergedCross = cells.find((c) => c.rs > 1 && c.r <= to && c.r + c.rs - 1 >= from);
  if (mergedCross) {
    if (mergedCross.r < from && mergedCross.r + mergedCross.rs - 1 >= to) {
      vmerge = { c: mergedCross.c, r: mergedCross.r, rs: mergedCross.rs };
    } else {
      throw new Error(`delete_row_range: 单元格 (${mergedCross.c},${mergedCross.r}) 为跨行合并区 (rs=${mergedCross.rs}，覆盖行 ${mergedCross.r}..${mergedCross.r + mergedCross.rs - 1})，与待删行 ${from}..${to} 相交，且锚点不在带上方完整覆盖。请先解除合并（set_cell_span rowspan=null）或缩小删除区间`);
    }
  }
  // 允许"带内无独立单元格"的情况（空白行、或被上方跨行合并区覆盖的行）——只要有可缩窄的合并
  // 或下方有行可上移，操作就有意义；只有三者皆无（真正的空操作）才拒绝。
  if (inBand.length === 0 && !vmerge && !(shiftUp && rowsBelow)) {
    throw new Error(`delete_row_range: 行 ${from}..${to} 既无单元格、也无可缩窄的跨行合并区、下方也没有可上移的行 —— 本次操作不会产生任何变化`);
  }

  let lo = 0, hi = raw.length;
  if (sheet != null) { const b = locateSheet(raw, sheet); lo = b.start; hi = b.end; }

  // 悬空预检：扩展父格引用 / 填报绑定的行落在待删带内 → 拒绝（避免留下悬空引用）
  // 注意：**引用方自身在待删带内**的 Expand 随格一起被删，不算悬空（真实填报模板里同一数据行的
  // 格普遍写成 left="A3" 之类指向自己这一行；若不排除，删该行会被自己的引用挡住）。
  const ownerInBand = (pos) => inBand.some((c) => pos >= c.start && pos < c.end);
  const dangling = [];
  for (const s of findAll(raw, '<Expand ').filter((x) => x >= lo && x < hi)) {
    if (ownerInBand(s)) continue;
    const gt = raw.indexOf('>', s);
    const m = raw.slice(s, gt + 1).match(/^<Expand\s+([^>]*)>/);
    if (!m) continue;
    for (const attrName of ['up', 'left']) {
      const am = m[1].match(new RegExp(`\\b${attrName}="([A-Za-z]{1,3})([0-9]+)"`));
      if (!am) continue;
      const refRow = Number(am[2]) - 1;
      if (refRow >= from && refRow <= to) dangling.push(`扩展父格 ${attrName}="${am[1]}${am[2]}"`);
    }
  }
  for (const s of findAll(raw, '<ColumnRow ').filter((x) => x >= lo && x < hi)) {
    const seg = raw.slice(s, raw.indexOf('/>', s) + 2);
    const rm = seg.match(/\brow="([^"]+)"/);
    if (rm && Number(rm[1]) >= from && Number(rm[1]) <= to) dangling.push(`填报绑定 row="${rm[1]}"`);
  }
  if (dangling.length > 0) {
    throw new Error(`delete_row_range: 待删行 ${from}..${to} 被 ${dangling.length} 处引用（${dangling.slice(0, 6).join('、')}${dangling.length > 6 ? ' …' : ''}），删除后会悬空。请先改引用/绑定（扩展父格用 set_cell_content_type 重建或改 left/up；绑定用 update_fill_binding）再删行`);
  }

  let out = raw;
  // 先删带内单元格（从后往前删，避免索引漂移）
  for (const c of [...inBand].sort((a, b) => b.start - a.start)) out = removeRange(out, c.start, c.end);

  // 跨行合并区缩窄（删除后重新定位，避免旧索引漂移）
  if (vmerge) {
    const [vb, ve] = locateCell(out, vmerge.c, vmerge.r, `跨行合并区(${vmerge.c},${vmerge.r})`, sheet);
    void ve;
    const headEnd = out.indexOf('>', vb) + 1;
    out = replaceAttr(out, vb, headEnd, 'rs', String(vmerge.rs - height), `跨行合并区 rs`);
  }

  let reboundCount = 0, refRewritten = 0;
  if (shiftUp) {
    // 下方行整体上移 height 行：从后往前改 r 属性（反向保证前面 headStart 仍有效）
    const remaining = cellsInSheet(out, sheet).filter((c) => c.r > to);
    for (const c of [...remaining].sort((a, b) => b.headStart - a.headStart)) {
      const newR = c.r - height;
      if (newR < 0) throw new Error(`delete_row_range: 上移后行号非法 (${c.r}->${newR})`);
      out = replaceAttr(out, c.headStart, c.headEnd, 'r', String(newR), `单元格(${c.c},${c.r})`);
    }
    // 填报绑定 ColumnRow 的 row（带下方绑定上移；带内已被上面的悬空预检拦下）
    for (const s of findAll(out, '<ColumnRow ').filter((x) => x >= lo && x < hi).sort((a, b) => b - a)) {
      const seg = out.slice(s, out.indexOf('/>', s) + 2);
      const rm = seg.match(/\brow="([^"]+)"/);
      if (rm && Number(rm[1]) > to) {
        const tagEnd = s + seg.indexOf('>') + 1;
        out = replaceAttr(out, s, tagEnd, 'row', String(Number(rm[1]) - height), `绑定行坐标`);
        reboundCount++;
      }
    }
    // 扩展父格 up/left 引用的行号（带下方引用上移）
    for (const s of findAll(out, '<Expand ').filter((x) => x >= lo && x < hi).sort((a, b) => b - a)) {
      const gt = out.indexOf('>', s);
      const m = out.slice(s, gt + 1).match(/^<Expand\s+([^>]*)>/);
      if (!m) continue;
      for (const attrName of ['up', 'left']) {
        const am = m[1].match(new RegExp(`\\b${attrName}="([A-Za-z]{1,3})([0-9]+)"`));
        if (!am) continue;
        const refRow = Number(am[2]) - 1;
        if (refRow > to) {
          out = replaceAttr(out, s, gt + 1, attrName, `${am[1]}${refRow - height + 1}`, `扩展父格 ${attrName}`);
          refRewritten++;
        }
      }
    }
    // <RowHeight> 数组：删掉带内条目（下方行高随之上移）—— 与"删整行"语义一致
    const rhStart = out.indexOf('<RowHeight', lo);
    if (rhStart >= 0 && rhStart < hi) {
      const [rb, re] = blockRange(out, rhStart, '<RowHeight', '</RowHeight>');
      const cd = /<!\[CDATA\[([\s\S]*?)\]\]>/.exec(out.slice(rb, re));
      if (cd) {
        const list = cd[1].split(',').map((x) => x.trim());
        if (list.length > from) {
          list.splice(from, Math.min(height, list.length - from));
          const nextCd = `<![CDATA[${list.join(',')}]]>`;
          // 函数式替换：nextCd 由**文件内容**（原 RowHeight CDATA）重新 join 而来
          out = out.slice(0, rb) + out.slice(rb, re).replace(cd[0], () => nextCd) + out.slice(re);
        }
      }
    }
  }
  save(path, out);
  return {
    action: 'delete_row_range', sheet: sheet ?? 0,
    rows: [from, to], deletedCells: inBand.length,
    shiftUp, reboundCount, refRewritten,
    ...(staleRefs.length > 0 ? { staleRefs } : {}),
    hint: `已删除行 ${from}..${to}（${inBand.length} 个单元格）${shiftUp ? `，下方剩余行整体上移 ${height} 行（含 RowHeight 条目）` : ''}。${reboundCount ? `同步上移了 ${reboundCount} 个填报绑定坐标。` : ''}${refRewritten ? `同步改写了 ${refRewritten} 处扩展父格引用。` : ''}`
      + (staleRefs.length > 0 ? staleRefsHint(staleRefs) : '若模板内 JS/公式用旧行坐标引用，请一并确认。'),
    bytes: Buffer.byteLength(out, 'utf8'),
  };
}

/**
 * 将一列区间内所有单元格整体左移/右移 delta 列（不做删除）。
 * 典型场景：整段列位错位（如 c9-c25 整体后移一位）需要整体归位。
 * 与 delete_cell_range 配合：先删重复列，再 shift 把剩余列归位。
 * 同步改写填报绑定 ColumnRow 与扩展父格引用（left/up）的列坐标。
 *
 * 两种语义：
 *  - insert=false（默认，平移）：目的列域已有未移动单元格时拒绝（防覆盖）。
 *  - insert=true（插入式挪移，轮转换位，Excel「插入剪切的单元格」语义）：
 *    目的列域被占用也直接挪——把「源与目的之间的让位列」（|delta| 列）整段轮转
 *    补到腾出的源侧位置。数据零丢失、不产生空洞、不级联表尾；一次调用替代旧方案
 *    「腾空目的列到暂存列 → 搬块 → 回填暂存列」三步，不再需要预留暂存区。
 *    合法性来自轮转是 span=[min(from,to+d) .. max(to,from+d)] 上的双射：
 *    块 [from..to] → +delta；让位列 → -sign(delta)*宽度。
 *
 * 安全边界（宁可报错不猜）：
 *  - 参与移动的跨列合并区必须完整落在块内或让位列内（轮转会把跨边界合并区拆开）→ 拒绝
 *  - 合并区锚点区内还含独立单元格（脏模板）→ 拒绝（行覆盖感知：行 0 标题横幅不误伤数据行）
 *  - 目的位（含 cs/rs 覆盖面积）与未参与移动单元格重叠 → 拒绝（insert 时报错里指路调整行域）
 */
export function shiftCellRange(path, { sheet, fromColumn, toColumn, delta, fromRow, toRow, insert = false } = {}) {
  const from = Number(fromColumn), to = Number(toColumn), d = Number(delta);
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from) {
    throw new Error(`shift_cell_range: 列区间非法 (${fromColumn},${toColumn})，须 0<=fromColumn<=toColumn`);
  }
  if (!Number.isInteger(d) || d === 0) throw new Error(`shift_cell_range: delta 非法 (${delta})，须为非零整数（负=左移，正=右移）`);
  if (from + d < 0) throw new Error(`shift_cell_range: 左移 ${-d} 列后起始列 ${from}->${from + d} 越界`);
  const rf = fromRow == null ? 0 : Number(fromRow);
  const rt = toRow == null ? Infinity : Number(toRow);
  if (!Number.isInteger(rf) || rf < 0) throw new Error(`shift_cell_range: fromRow 非法 (${fromRow})`);
  if (toRow != null && (!Number.isInteger(rt) || rt < rf)) {
    throw new Error(`shift_cell_range: 行区间非法 (${fromRow},${toRow})`);
  }
  const w = to - from + 1;
  // 让位带（insert 轮转）：块 B=[from..to] 与目的 [from+d..to+d] 之间反向换位的 |d| 列
  const gapFrom = d > 0 ? to + 1 : from + d;
  const gapTo = d > 0 ? to + d : from - 1;
  const spanFrom = Math.min(from, gapFrom), spanTo = Math.max(to, gapTo);
  const gapShift = d > 0 ? -w : w;
  const mapCol = insert ? (c) => (c >= from && c <= to ? c + d : c + gapShift) : (c) => c + d;
  const partCol = insert ? (c) => c >= spanFrom && c <= spanTo : (c) => c >= from && c <= to;

  const { raw } = load(path);
  const cells = cellsInSheet(raw, sheet);
  const moving = cells.filter((c) => partCol(c.c) && c.r >= rf && c.r <= rt);
  if (moving.length === 0) throw new Error(`shift_cell_range: 区间内无单元格可移动`);
  const movingSet = new Set(moving.map((c) => `${c.c},${c.r}`));
  const outside = cells.filter((c) => !movingSet.has(`${c.c},${c.r}`));
  // 陈旧引用体检（只读）：列位挪移只改 c 属性/绑定/父格，公式与提交条件里的 A1 文本不会自动改。
  // sandbox19/v1 两次因此静默失败（提交条件仍写 Y5=1 → 一行都不过滤）。这里把"需要人工改"的
  // 位置一次性列出来，避免再去 grep 全文。
  let scanLo = 0, scanHi = raw.length;
  if (sheet != null) { const b0 = locateSheet(raw, sheet); scanLo = b0.start; scanHi = b0.end; }
  const staleRefs = findStaleRefs(raw, scanLo, scanHi, (c, r) => {
    if (!partCol(c) || r < rf || r > rt) return null;
    const nc = mapCol(c);
    if (nc === c) return null;
    return { issue: 'needs-shift', suggest: `${indexToColLetters(nc)}${r + 1}` };
  });

  // 防护 ①：参与移动的合并区（行覆盖感知的脏模板重叠 + insert 轮转边界）
  for (const c of moving) {
    if (c.cs <= 1 && c.rs <= 1) continue;
    if (c.cs > 1) {
      if (insert && !(c.c >= from && c.c + c.cs - 1 <= to) && !(c.c >= gapFrom && c.c + c.cs - 1 <= gapTo)) {
        throw new Error(`shift_cell_range: 单元格 (${c.c},${c.r}) 为跨列合并区 (cs=${c.cs}，覆盖列 ${c.c}..${c.c + c.cs - 1})，横跨块 ${from}..${to} 与让位列 ${gapFrom}..${gapTo} 的轮转边界，插入式挪移会把合并区拆开。请先解除合并（set_cell_span colspan=null）`);
      }
    }
    const spanCovers = moving.filter((o) => o !== c
      && o.c >= c.c && o.c <= c.c + c.cs - 1
      && o.r >= c.r && o.r <= c.r + c.rs - 1).length;
    if (spanCovers > 0) {
      throw new Error(`shift_cell_range: 单元格 (${c.c},${c.r}) 为跨${c.cs > 1 ? '列' : '行'}合并区 (cs=${c.cs},rs=${c.rs})，区内还包含 ${spanCovers} 个独立单元格，平移会破坏合并。请先解除合并`);
    }
  }

  // 防护 ②：目的位碰撞（面积级：cs/rs 覆盖内任一格被未移动单元格占住即拒绝）
  for (const p of moving) {
    const tc0 = mapCol(p.c), tc1 = tc0 + p.cs - 1;
    for (const o of outside) {
      if (o.c + o.cs - 1 < tc0 || o.c > tc1) continue;
      if (o.r + o.rs - 1 < p.r || o.r > p.r + p.rs - 1) continue;
      const shape = o.cs > 1 || o.rs > 1 ? `，合并区 cs=${o.cs},rs=${o.rs}` : '';
      if (insert) {
        throw new Error(`shift_cell_range: 插入式挪移后单元格 (${p.c},${p.r}) 的目的位 (${tc0},${p.r}) 与未参与轮转的单元格 (${o.c},${o.r})${shape} 重叠（该格行不在移动行域 ${rf}..${rt === Infinity ? '末行' : rt} 内，不随挪移换位）。请把它的行纳入 fromRow/toRow 一并轮转，或先解除冲突`);
      }
      throw new Error(`shift_cell_range: 列 ${from}..${to} ${d > 0 ? '右移' : '左移'} ${Math.abs(d)} 列后，目的位 (${tc0},${p.r}) 已有单元格（来自 (${o.c},${o.r})${shape}）。请先 delete_cell_range 清理目标列，或改用 insert=true 插入式挪移（让位列自动轮转换位，不需要暂存列）`);
    }
  }

  let out = raw;
  // 一律从后往前改写：replaceAttr 改属性值会改变后续文本偏移（列号进位 9->10 变长），
  // 逆序处理保证后面要改的标签仍用得住原索引（旧实现 d>0 用正序，进位累积漂移会改错格）
  for (const c of [...moving].sort((a, b) => b.headStart - a.headStart)) {
    out = replaceAttr(out, c.headStart, c.headEnd, 'c', String(mapCol(c.c)), `单元格(${c.c},${c.r})`);
  }
  // 同步改写填报绑定 ColumnRow 的 column（列在移动列域、行在移动行域）
  let lo = 0, hi = out.length;
  if (sheet != null) { const b = locateSheet(out, sheet); lo = b.start; hi = b.end; }
  let reboundCount = 0;
  {
    const bind = findAll(out, '<ColumnRow ').filter((s) => s >= lo && s < hi);
    for (const s of [...bind].sort((a, b) => b - a)) {
      const seg = out.slice(s, out.indexOf('/>', s) + 2);
      const cm = seg.match(/\bcolumn="([^"]+)"/);
      const rm = seg.match(/\brow="([^"]+)"/);
      const col = cm ? Number(cm[1]) : null;
      const row = rm ? Number(rm[1]) : null;
      if (col != null && partCol(col) && (row == null || (row >= rf && row <= rt))) {
        const tagEnd = s + seg.indexOf('>') + 1;
        out = replaceAttr(out, s, tagEnd, 'column', String(mapCol(col)), `绑定行坐标`);
        reboundCount++;
      }
    }
  }
  // 同步改写扩展父格引用 left/up（A1 风格，如 "B2"：列字母+行号，行号从 1 起）
  let refRewritten = 0;
  {
    const refs = findAll(out, '<Expand ').filter((s) => s >= lo && s < hi);
    for (const s of [...refs].sort((a, b) => b - a)) {
      const gt = out.indexOf('>', s);
      const head = out.slice(s, gt + 1);
      const m = head.match(/^<Expand\s+([^>]*)>/);
      if (!m) continue;
      const attrs = m[1];
      for (const attrName of ['left', 'up']) {
        const am = attrs.match(new RegExp(`\\b${attrName}="([A-Za-z]{1,3})([0-9]+)"`));
        if (!am) continue;
        const colIdx = colLettersToIndex(am[1]);
        const rowIdx = Number(am[2]);
        if (partCol(colIdx) && (rowIdx - 1) >= rf && (rowIdx - 1) <= rt) {
          // 每次改写前重新取标签尾：同标签 left/up 先后改写时旧索引会因进位失效
          const tagEnd = out.indexOf('>', s) + 1;
          out = replaceAttr(out, s, tagEnd, attrName, `${indexToColLetters(mapCol(colIdx))}${rowIdx}`, `扩展父格 ${attrName}`);
          refRewritten++;
        }
      }
    }
  }
  save(path, out);
  const gapDesc = insert ? `；让位列 ${gapFrom}..${gapTo} 已轮转补到 ${mapCol(gapFrom)}..${mapCol(gapTo)}` : '';
  return {
    action: 'shift_cell_range', sheet: sheet ?? 0,
    columns: [from, to], delta: d, movedCells: moving.length,
    insert, ...(insert ? { gapColumns: [gapFrom, gapTo], spanColumns: [spanFrom, spanTo] } : {}),
    reboundCount, refRewritten,
    ...(staleRefs.length > 0 ? { staleRefs } : {}),
    hint: (insert
      ? `插入式挪移：列 ${from}..${to} 的 ${moving.length} 个单元格整体${d > 0 ? '右移' : '左移'} ${Math.abs(d)} 列（→ ${from + d}..${to + d}）${gapDesc}。目的列无需为空、不需要暂存列。${reboundCount ? `同步改写了 ${reboundCount} 个填报绑定坐标；` : ''}${refRewritten ? `同步改写了 ${refRewritten} 个扩展父格引用；` : ''}`
      : `已把列 ${from}..${to} 的 ${moving.length} 个单元格整体${d > 0 ? '右移' : '左移'} ${Math.abs(d)} 列（→ ${from + d}..${to + d}）。${reboundCount ? `同步改写了 ${reboundCount} 个填报绑定坐标；` : ''}${refRewritten ? `同步改写了 ${refRewritten} 个扩展父格引用；` : ''}`)
      + (staleRefs.length > 0 ? staleRefsHint(staleRefs) : '模板内 JS/公式若用旧列坐标（getCellValue 或 ${列号} 等）请一并确认。'),
    bytes: Buffer.byteLength(out, 'utf8'),
  };
}

/** 列字母 -> 列索引（A=0, B=1, ..., Z=25, AA=26） */
function colLettersToIndex(letters) {
  let idx = 0;
  for (const ch of String(letters).toUpperCase()) idx = idx * 26 + (ch.charCodeAt(0) - 64);
  return idx - 1;
}

/** 列索引 -> 列字母（0=A, 1=B, ..., 25=Z, 26=AA） */
function indexToColLetters(idx) {
  let n = Number(idx), s = '';
  do { s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26) - 1; } while (n >= 0);
  return s;
}

// ---------------- 单元格样式 ----------------

// 颜色转换（argbToHex / hexToArgb）与单位换算（mmToUnit / unitToMm）统一从
// lib/engine/rules.js 取用（2026-10-29 去重：此前 edits/cpt/generate/rules 各有一份）。

// ---------------- 单元格条件属性（Highlight） ----------------
//
// 逆向依据（官方 1559 个 .cpt 样本实证）：
//   <HighlightList>
//     <Highlight class="com.fr.report.cell.cellattr.highlight.DefaultHighlight">   (2118 次)
//       <Name><![CDATA[条件属性1]]></Name>
//       <Condition class="com.fr.data.condition.FormulaCondition">                 (1506 次)
//         <Formula><![CDATA[row() % 2 == 0]]></Formula>
//       </Condition>
//       <HighlightAction class="...BackgroundHighlightAction">                     (567 次)
//         <Scope val="1"/>                                                        (104 次)
//         <Background name="ColorBackground" color="-855310"/>                     (属性形式 463 / 嵌套 FineColor 69，取多数)
//       </HighlightAction>
//     </Highlight>
//   </HighlightList>
//   插在单元格 <C> 内 <PrivilegeControl/> 之后、<Expand> 之前。
//
// 【为什么不暴露 CommonCondition/ObjectCondition】
//   它们用 <Compare op="N"> 表达大于/小于/等于，但 op 的枚举含义无法从样本反推
//   （同一个 op 值在不同样本里语义不一致，且没有可读的名称可以印证）。
//   安全围栏原则：宁可只给一条能验证的路，也不给一个猜出来的枚举。
//   所以条件一律走 FormulaCondition —— 它是样本里最常见的（1506 次），且语义完全由公式文本决定。
//   公式里 $$$ 表示当前单元格值（150 个官方公式用到），row() 取行号（斑马纹 row()%2==0 共 218 处）。
//
// 【为什么不做 bold】
//   FRFontHighlightAction 的 style 属性样本里只有 0(179) 和 1(44) 两种取值，
//   但同名属性在普通 FRFont 上还有 2（斜体），无法确认高亮场景下的确切含义，故暂不暴露。

const HL_CLASS = 'com.fr.report.cell.cellattr.highlight.DefaultHighlight';
const HL_CONDITION = {
  formula: 'com.fr.data.condition.FormulaCondition',
  list: 'com.fr.data.condition.ListCondition',
  object: 'com.fr.data.condition.ObjectCondition',
};
const HL_ACTIONS = {
  background: 'com.fr.report.cell.cellattr.highlight.BackgroundHighlightAction',
  fontColor: 'com.fr.report.cell.cellattr.highlight.ForegroundHighlightAction',
  value: 'com.fr.report.cell.cellattr.highlight.ValueHighlightAction',
  font: 'com.fr.report.cell.cellattr.highlight.FRFontHighlightAction',
};

/**
 * 比较运算符枚举 —— 来自官方常量，不是猜的。
 * 来源：javap -p -constants fine-core-11.0.jar com.fr.data.core.Compare
 *   public static final int EQUALS=0 / NOT_EQUAL=1 / GREATER_THAN=2 / GREATER_THAN_OR_EQUAL=3
 *   / LESS_THAN=4 / LESS_THAN_OR_EQUAL=5 / BEGINS_WITH=6 / NOT_BEGIN_WITH=7 / ENDS_WITH=8
 *   / NOT_END_WITH=9 / CONTAINS=10 / NOT_CONTAIN=11 / IN=12 / NOT_IN=13 / NULL=14 / NOT_NULL=15
 *
 * 样本侧交叉验证（848 个 ObjectCondition 实测）：
 *   op=4 LESS_THAN 的值几乎全是 0（296 次）→ 就是"$$$ < 0"负数标红，与枚举语义吻合
 *   op=2 GREATER_THAN 的值是 0.6/0.5/0.4/0.3 这类阈值 → 吻合
 *   op=3 GREATER_THAN_OR_EQUAL 值多为 0 → 吻合
 *   op=8 ENDS_WITH 的值是 "*"（字符串）→ 字符串运算，吻合
 * 只做到 NOT_CONTAIN(11)：IN/NOT_IN/NULL/NOT_NULL 在样本里 <O> 恒为空（无法还原列表/空值写法），
 * 按安全围栏原则不予暴露，引导改用 formula。
 */
export const COMPARE_OPS = {
  eq: 0, ne: 1, gt: 2, gte: 3, lt: 4, lte: 5,
  beginsWith: 6, notBeginsWith: 7, endsWith: 8, notEndsWith: 9,
  contains: 10, notContains: 11,
};
const COMPARE_ALIASES = {
  equals: 'eq', '=': 'eq', '==': 'eq',
  notEqual: 'ne', '!=': 'ne', '<>': 'ne',
  greaterThan: 'gt', '>': 'gt',
  greaterThanOrEqual: 'gte', '>=': 'gte',
  lessThan: 'lt', '<': 'lt',
  lessThanOrEqual: 'lte', '<=': 'lte',
};
/** 把 eq / '=' / 'equals' 等各种写法归一化成规范名 */
export function normalizeCompareOp(op) {
  const key = String(op ?? '').trim();
  const lower = key.toLowerCase();
  if (COMPARE_OPS[lower] !== undefined) return lower;
  const aliased = COMPARE_ALIASES[lower] ?? COMPARE_ALIASES[key];
  if (aliased) return aliased;
  throw new Error(
    `add_cell_highlight: compare.op="${op}" 不支持。可用：${Object.keys(COMPARE_OPS).join(' / ')}\n` +
    '（也接受 = != > >= < <= 这些符号写法）。\n' +
    '需要 IN / IS NULL 这类判断请改用 formula（如 "$$$ = \\"已完成\\""）。'
  );
}

/** <O> 载体：整数 t="I"，小数 t="D"，字符串裸 <O>（官方 848 个样本实测的写法） */
function objectValueXml(value) {
  const isInt = typeof value === 'number'
    ? Number.isInteger(value)                       // 0 / 100 / -5 都算整数
    : /^-?\d+$/.test(String(value).trim());
  const isDec = typeof value === 'number'
    ? !Number.isInteger(value)                      // 0.5 / -3.14
    : /^-?\d*\.\d+$/.test(String(value).trim());
  if (isInt) return `<O t="I">\n<![CDATA[${String(value).trim()}]]>\n</O>`;
  if (isDec) return `<O t="D">\n<![CDATA[${String(value).trim()}]]>\n</O>`;
  const text = String(value);
  if (text.trim().startsWith('=')) {
    // 公式值：走 XMLable Formula（官方 4 例）
    return `<O t="XMLable" class="com.fr.base.Formula">\n<Attributes>\n<![CDATA[${assertSafeCdata(text.trim(), '比较值公式')}]]>\n</Attributes>\n</O>`;
  }
  return `<O>\n<![CDATA[${assertSafeCdata(text, '比较值')}]]>\n</O>`;
}

/**
 * 渲染 <Condition> 块。支持三种写法：
 *   { formula }                              → FormulaCondition（样本 1351 次）
 *   { compare: { op, value } }                → ObjectCondition（403 次）
 *   { conditions: [...], logic: 'and'|'or' }  → ListCondition（378 次，多条件组合）
 */
function buildConditionXml(spec) {
  const hasFormula = spec.formula != null && String(spec.formula).trim() !== '';
  const hasCompare = spec.compare != null;
  const hasList = Array.isArray(spec.conditions) && spec.conditions.length > 0;

  const given = [hasFormula, hasCompare, hasList].filter(Boolean).length;
  if (given === 0) {
    throw new Error(
      'add_cell_highlight: 必须给条件，三选一：\n' +
      '  formula: "$$$ < 0"                       公式条件（最灵活，$$$ 是当前单元格值）\n' +
      '  compare: { op: "lt", value: 0 }           比较条件（op 见 COMPARE_OPS）\n' +
      '  conditions: [{formula:"$$$ < 0"}, ...]    多条件组合（配合 logic: "and"/"or"）'
    );
  }
  if (given > 1) {
    throw new Error('add_cell_highlight: formula / compare / conditions 三者只能用一种，不要混着给');
  }

  if (hasFormula) {
    return {
      xml: `<Condition class="${HL_CONDITION.formula}">\n<Formula>\n<![CDATA[${assertSafeCdata(String(spec.formula).trim(), '条件属性公式')}]]>\n</Formula>\n</Condition>`,
      kind: 'formula',
    };
  }
  if (hasCompare) {
    const { op, value } = spec.compare;
    const norm = normalizeCompareOp(op);
    if (value === undefined || value === null || value === '') {
      throw new Error(
        `add_cell_highlight: compare 必须给 value（要比对的值）。示例：{ op: "${norm}", value: 0 }\n` +
        '需要判空请改用 formula（如 "len($$$) = 0"）。'
      );
    }
    return {
      xml: `<Condition class="${HL_CONDITION.object}">\n<Compare op="${COMPARE_OPS[norm]}">\n${objectValueXml(value)}\n</Compare>\n</Condition>`,
      kind: `compare:${norm}`,
    };
  }
  // ListCondition：join="0" 是官方样本的绝对主流（551 : 23），且首个 JoinCondition 的 join 无实际作用
  // 语义推断依据：样本里 3 条全是 join="0" 的组合读出来是"F7-D7<=0 且 奇数行 且 C7非空"，即 AND
  const join = (spec.logic ?? 'and').toLowerCase() === 'or' ? 1 : 0;
  if (!['and', 'or'].includes(String(spec.logic ?? 'and').toLowerCase())) {
    throw new Error(`add_cell_highlight: logic="${spec.logic}" 非法，只能用 and（默认）或 or`);
  }
  const inner = spec.conditions.map((c) => {
    const sub = buildConditionXml(c);
    return `<JoinCondition join="${join}">\n${sub.xml}\n</JoinCondition>`;
  }).join('\n');
  return {
    xml: `<Condition class="${HL_CONDITION.list}">\n${inner}\n</Condition>`,
    kind: `list:${join === 1 ? 'or' : 'and'}(${spec.conditions.length})`,
  };
}

/** 把一个高亮动作规格渲染成 XML 体（不含 HighlightAction 开闭标签） */
export function highlightActionBody(kind, value, scope) {
  if (kind === 'background') {
    const color = /^-?\d+$/.test(String(value)) ? String(value) : hexToArgb(value);
    // Scope val="1" = 整行（104 个官方样本均为此值，且都配 row()%2==0 斑马纹）
    const scopeXml = scope === 'row' ? '<Scope val="1"/>\n' : '';
    return `${scopeXml}<Background name="ColorBackground" color="${escapeXmlAttr(color)}"/>`;
  }
  if (kind === 'fontColor') {
    const color = /^-?\d+$/.test(String(value)) ? String(value) : hexToArgb(value);
    return `<Foreground color="${escapeXmlAttr(color)}"/>`;
  }
  // 条件改值：命中时把单元格显示值换成公式结果（官方 812 次，是数量最多的一类动作）
  // 写法实测：t="XMLable" class="com.fr.base.Formula" 占 596 次（另有 t="Formula" 45 次，取多数）
  if (kind === 'value') {
    const text = String(value).trim();
    const fm = text.startsWith('=') ? text : `="${text.replace(/"/g, '\\"')}"`;
    return `<O t="XMLable" class="com.fr.base.Formula">\n<Attributes>\n<![CDATA[${assertSafeCdata(fm, '条件改值公式')}]]>\n</Attributes>\n</O>`;
  }
  // 条件改字体：只做样本里有确切取值的三项 —— 粗体(style 0/1)、字号(size=pt*4)、字名
  // foreground 走 ForegroundHighlightAction，这里不重复暴露
  if (kind === 'font') {
    const f = value;
    if (f.style != null && !['0', '1', 0, 1].includes(f.style)) {
      throw new Error(
        `add_cell_highlight: 条件字体的 style 只支持 0（常规）/ 1（粗体），收到 "${f.style}"。\n` +
        '官方 223 个 FRFontHighlightAction 里 style 只有 0(179) 和 1(44) 两种取值；\n' +
        '斜体在条件场景下无样本支撑，需要请用普通字体样式设置。'
      );
    }
    // 属性顺序与官方样本一致：name → style → size → foreground
    return `<FRFont name="${escapeXmlAttr(f.name ?? '微软雅黑')}" style="${f.style ?? 0}" size="${Math.round((f.sizePt ?? 11) * 4)}"/>`;
  }
  throw new Error(`不支持的高亮动作 "${kind}"：可用 ${Object.keys(HL_ACTIONS).join(' / ')}`);
}

/**
 * 给单元格追加条件属性（条件格式）。
 * @param {string} path
 * @param {object} opts
 * @param {number} opts.column 列号（0 起）
 * @param {number} opts.row 行号（0 起）
 * @param {string} opts.formula 条件公式（FR 公式，如 '$$$ < 0' / 'row() % 2 == 0'）
 * @param {string} [opts.background] 命中时的背景色（#RRGGBB 或 ARGB 整数）
 * @param {string} [opts.fontColor] 命中时的字体颜色
 * @param {'cell'|'row'} [opts.scope='cell'] 作用范围（row=整行，用于斑马纹）
 * @param {string} [opts.name] 条件属性名（默认 条件属性N）
 * @param {number|null} [opts.sheet] 工作表索引
 */
export function addCellHighlight(path, {
  column, row, sheet,
  formula, compare, conditions, logic,
  background, fontColor, value, bold, fontSizePt, fontName,
  scope, name,
} = {}) {
  if (column == null || row == null) throw new Error('addCellHighlight: 必须提供 column 与 row（均从 0 起）');
  if (scope != null && scope !== 'cell' && scope !== 'row') {
    throw new Error(`addCellHighlight: scope="${scope}" 非法，只能用 cell（当前单元格，默认）或 row（整行）`);
  }
  // bold 必须是布尔：写成 bold:"yes" 会被真值判断静默当成 true，属于典型的模型笔误，必须拦下
  if (bold != null && typeof bold !== 'boolean') {
    throw new Error(`addCellHighlight: bold 只接受 true / false，收到 ${JSON.stringify(bold)}。加粗写 bold: true，常规写 bold: false。`);
  }
  // 条件：三选一（formula / compare / conditions）
  const cond = buildConditionXml({ formula, compare, conditions, logic });

  // 效果：每种效果单独一条 Highlight（对齐官方"条件属性1/条件属性2"的写法）
  const acts = [];
  if (background != null) acts.push({ kind: 'background', value: background });
  if (fontColor != null) acts.push({ kind: 'fontColor', value: fontColor });
  if (value != null) acts.push({ kind: 'value', value });
  if (bold != null || fontSizePt != null || fontName != null) {
    acts.push({ kind: 'font', value: { style: bold ? 1 : 0, sizePt: fontSizePt ?? 11, name: fontName ?? '微软雅黑' } });
  }
  if (acts.length === 0) {
    throw new Error(
      'addCellHighlight: 至少给一个效果，可用：\n' +
      '  background 背景色（#RRGGBB）  fontColor 字色\n' +
      '  value 条件改值（如 "已完成" 或 "=sum(F4)"）\n' +
      '  bold 粗体 / fontSizePt 字号 / fontName 字体名'
    );
  }

  const { raw } = load(path);
  let out = raw;
  const [cb, ce] = locateCell(out, column, row, `单元格(${column},${row})`, sheet);
  let seg = out.slice(cb, ce);

  const existing = findAll(seg, '<Highlight class=');
  const blocks = acts.map((a, i) => {
    const seq = existing.length + i + 1;
    const nm = name && acts.length === 1 ? name : (name ? `${name}${seq}` : `条件属性${seq}`);
    return `<Highlight class="${HL_CLASS}">
<Name>
<![CDATA[${assertSafeCdata(nm, '条件属性名')}]]>
</Name>
${cond.xml}
<HighlightAction class="${HL_ACTIONS[a.kind]}">
${highlightActionBody(a.kind, a.value, scope)}
</HighlightAction>
</Highlight>`;
  });

  const hlIdx = seg.indexOf('<HighlightList>');
  if (hlIdx >= 0) {
    // 已有 HighlightList：在 </HighlightList> 之前追加
    const close = seg.lastIndexOf('</HighlightList>');
    seg = seg.slice(0, close) + blocks.join('\n') + '\n' + seg.slice(close);
  } else {
    // 新建：插在 <Expand 之前（官方样本顺序：O → PrivilegeControl → HighlightList → Expand）
    // 退化到 </C> 之前
    let at = seg.indexOf('<Expand');
    if (at < 0) at = seg.lastIndexOf('</C>');
    if (at < 0) throw new Error('定位失败：单元格内找不到插入点');
    seg = seg.slice(0, at) + `<HighlightList>\n${blocks.join('\n')}\n</HighlightList>\n` + seg.slice(at);
  }

  out = out.slice(0, cb) + seg + out.slice(ce);
  save(path, out);
  return {
    action: 'add_cell_highlight',
    cell: `${column},${row}`,
    condition: cond.kind,      // formula / compare:lt / list:and(2) ...
    effects: acts.map((a) => a.kind),
    scope: scope ?? 'cell',
    highlightCount: existing.length + blocks.length,
    bytes: Buffer.byteLength(out, 'utf8'),
  };
}

// ---------------- 单元格超级链接 / JS 事件 ----------------
//
// 逆向依据（官方 1559 个 .cpt 样本实证）：
//   <C> 内元素顺序：O → PrivilegeControl → NameJavaScriptGroup → HighlightList → Expand
//     （实测 148 例 NameJS 在 Expand 之前、136 例在 HighlightList 之前）
//   <NameJavaScriptGroup><NameJavaScript name="网络报表1"><JavaScript class="...">…</JavaScript></NameJavaScript>
//   JavaScript class 频次：ParameterJavaScript(660) / JavaScriptImpl(555) / ReportletHyperlink(110)
//                          / WebHyperlink(17) / Commit2DBJavaScript(17) / EmailJavaScript(1)
//
// 【为什么 ReportletHyperlink / WebHyperlink 写成两层同名标签】
//   实测 122 例全部是 <JavaScript class="X"><JavaScript class="X">…</JavaScript></JavaScript>，
//   而 JavaScriptImpl 555 例全是单层。二者形态不同是既成事实，照抄即可，不去推断成因。
//   （最可能是父类与子类各写一层，但这条只是猜测，不作为实现依据。）
//
// 【为什么不做 ParameterJavaScript / Commit2DBJavaScript / EmailJavaScript】
//   ParameterJavaScript(660) 多用于参数面板的动态参数联动，参数来源依赖具体控件名，
//   没有稳定可复用的最小结构；Commit2DBJavaScript(17) 与填报提交强耦合；
//   EmailJavaScript 全库仅 1 例。按安全围栏原则，只暴露样本结构稳定、语义明确的三类。

const JS_CLASSES = {
  reportlet: 'com.fr.js.ReportletHyperlink',
  url: 'com.fr.js.WebHyperlink',
  script: 'com.fr.js.JavaScriptImpl',
};
// 双层写法的类（实测结论，不是推断）
const JS_DOUBLE_WRAPPED = new Set([JS_CLASSES.reportlet, JS_CLASSES.url]);
// TargetFrame 实测取值仅这三种：_blank(82) / _self(48) / _dialog(23)
const JS_TARGETS = ['_blank', '_self', '_dialog'];

/** 渲染 <Parameters> 块；无参数时写成自闭合（官方样例两种都有，自闭合更常见） */
function jsParamsXml(params) {
  const entries = Object.entries(params ?? {}).filter(([, v]) => v != null && v !== '');
  if (entries.length === 0) return '<Parameters/>';
  const inner = entries.map(([k, v]) => {
    const text = String(v).trim();
    const isFormula = text.startsWith('=');
    const body = isFormula
      ? `<O t="XMLable" class="com.fr.base.Formula">\n<Attributes>\n<![CDATA[${assertSafeCdata(text, '参数公式')}]]>\n</Attributes>\n</O>`
      : `<O>\n<![CDATA[${assertSafeCdata(text, '参数值')}]]>\n</O>`;
    return `<Parameter>\n<Attributes name="${escapeXmlAttr(k)}"/>\n${body}\n</Parameter>`;
  }).join('\n');
  return `<Parameters>\n${inner}\n</Parameters>`;
}

/** 超链接类型 → 缺省事件名（add/update 共用，避免两处漂移） */
function hyperlinkDefaultName(type) {
  if (type === 'reportlet') return '网络报表';
  if (type === 'url') return '网页链接';
  return '脚本';
}

/** 校验并渲染指定类型超链接的 <JavaScript class="...">…</JavaScript> 外层（含双层包裹）。
 *  paramsXml 提供时原样保留现有 <Parameters> 段（update 沿用现状用），否则按 params 渲染。 */
function buildHyperlinkJsXml(type, { reportletPath, url, script, params, paramsXml, target, width, height, post, className }) {
  const paramsBlock = paramsXml ?? jsParamsXml(params);
  let body;
  if (type === 'reportlet') {
    if (!reportletPath || !String(reportletPath).trim()) {
      throw new Error('addCellHyperlink: type="reportlet" 必须给 reportletPath（目标报表路径，如 "/demo/basic/产品明细.cpt"）');
    }
    const attrs = ['showPI="true"', ...(post ? ['byPost="true"'] : [])].join(' ');
    body = `${paramsBlock}
<TargetFrame>
<![CDATA[${target}]]>
</TargetFrame>
<Features width="${Number(width) || 600}" height="${Number(height) || 400}"/>
<ReportletName ${attrs}>
<![CDATA[${assertSafeCdata(String(reportletPath).trim(), '目标报表路径')}]]>
</ReportletName>
<Attr>
<DialogAttr class="com.fr.js.ReportletHyperlinkDialogAttr">
<O>
<![CDATA[]]>
</O>
<Location center="true"/>
</DialogAttr>
</Attr>`;
  } else if (type === 'url') {
    if (!url || !String(url).trim()) throw new Error('addCellHyperlink: type="url" 必须给 url（目标网址）');
    const safeUrl = assertSafeExternalUrl(url);
    body = `${paramsBlock}
<TargetFrame>
<![CDATA[${target}]]>
</TargetFrame>
<Features width="${Number(width) || 600}" height="${Number(height) || 400}"/>
<URL>
<![CDATA[${assertSafeCdata(safeUrl, '目标网址')}]]>
</URL>`;
  } else {
    if (!script || !String(script).trim()) throw new Error('addCellHyperlink: type="script" 必须给 script（JS 代码）');
    body = `${paramsBlock}
<Content>
<![CDATA[${assertSafeCdata(String(script), 'JS 脚本')}]]>
</Content>`;
  }
  const stdCls = JS_CLASSES[type];
  // 保留原 className（update 沿用现状用）；未提供时按类型标准 class 渲染。
  const cls = className && String(className).trim() !== '' ? className : stdCls;
  const inner = JS_DOUBLE_WRAPPED.has(stdCls)
    ? `<JavaScript class="${cls}">\n${body}\n</JavaScript>`
    : body;
  return `<JavaScript class="${cls}">\n${inner}\n</JavaScript>`;
}

/** 校验并渲染一个完整 <NameJavaScript name="...">…</NameJavaScript> 块（供 add/update 共用） */
function buildHyperlinkNameJavaScript({ type, reportletPath, url, script, params, paramsXml, target = '_blank', width = 600, height = 400, post = false, name, className }) {
  if (!JS_CLASSES[type]) {
    throw new Error(
      `type="${type}" 不支持，只能用：\n` +
      '  reportlet  跳转到另一张报表（reportletPath 必填，可用 params 传参）\n' +
      '  url        跳转到外部网页（url 必填）\n' +
      '  script     执行自定义 JS（script 必填）'
    );
  }
  if (target && !JS_TARGETS.includes(target)) {
    throw new Error(`target="${target}" 非法，官方样本只有 ${JS_TARGETS.join(' / ')} 三种`);
  }
  const jsXml = buildHyperlinkJsXml(type, { reportletPath, url, script, params, paramsXml, target, width, height, post, className });
  return `<NameJavaScript name="${escapeXmlAttr(name)}">\n${jsXml}\n</NameJavaScript>`;
}

/**
 * 给单元格挂超级链接或 JS 事件。
 *
 * @param {string} path
 * @param {object} opts
 * @param {number} opts.column 列号（0 起）
 * @param {number} opts.row 行号（0 起）
 * @param {'reportlet'|'url'|'script'} opts.type 链接类型
 * @param {string} [opts.reportletPath] type=reportlet 时的目标报表路径，如 /demo/basic/产品明细.cpt
 * @param {string} [opts.url] type=url 时的目标网址
 * @param {string} [opts.script] type=script 时的 JS 代码
 * @param {object} [opts.params] 传参 {参数名: 值}，值以 = 开头按公式处理（如 {订单号: '=$订单号'}）
 * @param {string} [opts.target='_blank'] 打开方式：_blank / _self / _dialog
 * @param {number} [opts.width=600] 弹窗宽
 * @param {number} [opts.height=400] 弹窗高
 * @param {boolean} [opts.post=false] 是否用 POST 传参（默认 GET）
 * @param {string} [opts.name] 事件名（默认 网络报表N / 网页链接N / 脚本N）
 * @param {number|null} [opts.sheet] 工作表索引
 */
export function addCellHyperlink(path, {
  column, row, sheet, type,
  reportletPath, url, script, params,
  target = '_blank', width = 600, height = 400, post = false, name,
} = {}) {
  if (column == null || row == null) throw new Error('addCellHyperlink: 必须提供 column 与 row（均从 0 起）');
  if (!JS_CLASSES[type]) {
    throw new Error(
      `addCellHyperlink: type="${type}" 不支持，只能用：\n` +
      '  reportlet  跳转到另一张报表（reportletPath 必填，可用 params 传参）\n' +
      '  url        跳转到外部网页（url 必填）\n' +
      '  script     执行自定义 JS（script 必填）'
    );
  }
  if (target && !JS_TARGETS.includes(target)) {
    throw new Error(`addCellHyperlink: target="${target}" 非法，官方样本只有 ${JS_TARGETS.join(' / ')} 三种`);
  }

  const defaultName = hyperlinkDefaultName(type);
  const jsXml = buildHyperlinkJsXml(type, { reportletPath, url, script, params, target, width, height, post });

  const { raw } = load(path);
  let out = raw;
  const [cb, ce] = locateCell(out, column, row, `单元格(${column},${row})`, sheet);
  let seg = out.slice(cb, ce);

  const gIdx = seg.indexOf('<NameJavaScriptGroup>');
  if (gIdx >= 0) {
    // 已有组：追加进组里（官方支持一个单元格挂多个事件，靠 name 区分）
    const close = seg.indexOf('</NameJavaScriptGroup>', gIdx);
    const existing = findAll(seg, '<NameJavaScript ').length;
    const nm = name ?? `${defaultName}${existing + 1}`;
    const block = `<NameJavaScript name="${escapeXmlAttr(nm)}">\n${jsXml}\n</NameJavaScript>`;
    seg = seg.slice(0, close) + block + '\n' + seg.slice(close);
  } else {
    // 新建组：插在 <HighlightList> 之前；没有 HighlightList 就插在 <Expand 之前
    // （实测顺序：PrivilegeControl → NameJavaScriptGroup → HighlightList → Expand）
    const nm = name ?? `${defaultName}1`;
    const block = `<NameJavaScriptGroup>\n<NameJavaScript name="${escapeXmlAttr(nm)}">\n${jsXml}\n</NameJavaScript>\n</NameJavaScriptGroup>`;
    let at = seg.indexOf('<HighlightList>');
    if (at < 0) at = seg.indexOf('<Expand');
    if (at < 0) at = seg.lastIndexOf('</C>');
    if (at < 0) throw new Error('定位失败：单元格内找不到插入点');
    seg = seg.slice(0, at) + block + '\n' + seg.slice(at);
  }

  out = out.slice(0, cb) + seg + out.slice(ce);
  save(path, out);
  return {
    action: 'add_cell_hyperlink',
    cell: `${column},${row}`,
    type,
    target: type === 'script' ? undefined : target,
    paramCount: Object.keys(params ?? {}).length,
    eventCount: findAll(seg, '<NameJavaScript ').length,
    bytes: Buffer.byteLength(out, 'utf8'),
  };
}

/** 定位 StyleList 中第 idx 个 Style 块，返回 [start, end] */
function locateStyleBlock(raw, idx, what = `样式 ${idx}`) {
  const styles = styleBlocks(raw).blocks;
  if (styles.length <= idx) throw new Error(`定位失败：未找到 ${what}（StyleList 仅有 ${styles.length} 个样式）`);
  return [styles[idx].start, styles[idx].end];
}

/** 定位单元格样式：返回 { cellRange, styleIndex, styleRange } */
function locateCellStyle(raw, column, row, sheet) {
  const [cb, ce] = locateCell(raw, column, row, `单元格(${column},${row})`, sheet);
  const head = raw.slice(cb, raw.indexOf('>', cb) + 1);
  const styleMatch = head.match(/\bs="(\d+)"/);
  // FR 官方模板允许省略 s；设计器把这种单元格解析为默认样式 0。
  const styleIndex = styleMatch ? Number(styleMatch[1]) : 0;
  const [sb, se] = locateStyleBlock(raw, styleIndex, `样式 ${styleIndex}`);
  return { cellRange: [cb, ce], styleIndex, explicitStyle: !!styleMatch, styleRange: [sb, se] };
}

/** 统计引用指定样式索引的单元格数 */
function countStyleRefs(raw, styleIndex) {
  const cells = findAll(raw, '<C ').map((start) => raw.slice(start, raw.indexOf('>', start) + 1));
  return cells.filter((head) => {
    const match = head.match(/\bs="(\d+)"/);
    return Number(match ? match[1] : 0) === styleIndex;
  }).length;
}

/** 把目标单元格绑定到新的 StyleList 索引；原来没有 s 时会补上。 */
function setCellStyleIndex(raw, cellStart, styleIndex) {
  const tagEnd = raw.indexOf('>', cellStart);
  if (tagEnd < 0) throw new Error('定位失败：单元格开标签未闭合');
  const head = raw.slice(cellStart, tagEnd + 1);
  if (/\bs=["']/.test(head)) return replaceAttr(raw, cellStart, tagEnd + 1, 's', String(styleIndex), '单元格样式');
  return raw.slice(0, tagEnd) + ` s="${styleIndex}"` + raw.slice(tagEnd);
}

/** 精确保留原样式 XML，追加为新的 StyleList 项。 */
function cloneStyleForCell(raw, cellStart, styleIndex) {
  const [sb, se] = locateStyleBlock(raw, styleIndex);
  const clone = raw.slice(sb, se);
  const list = styleBlocks(raw);
  const newStyleIndex = list.blocks.length;
  let out = setCellStyleIndex(raw, cellStart, newStyleIndex);
  // 单元格位于 StyleList 之前，补/替换 s 可能改变后续偏移，因此重新定位闭标签。
  const refreshed = styleBlocks(out);
  out = out.slice(0, refreshed.closeStart) + clone + '\n' + out.slice(refreshed.closeStart);
  return { out, styleIndex: newStyleIndex };
}

/** 批量场景专用：把单元格样式直接重绑到既有 StyleList 索引（不克隆、不改样式内容，多格共享同一索引） */
export function rebindCellStyle(path, column, row, styleIndex, sheet) {
  const { raw } = load(path);
  // 目标索引必须真实存在：否则 locateCellStyle 只会改 s 数字而不报错，批量 plan 的结构校验被绕过
  locateStyleBlock(raw, styleIndex);
  const { cellRange } = locateCellStyle(raw, column, row, sheet);
  save(path, setCellStyleIndex(raw, cellRange[0], styleIndex));
}

/** 读取单元格样式 */
export function getCellStyle(path, column, row, sheet) {
  const { raw } = load(path);
  const { styleIndex, styleRange } = locateCellStyle(raw, column, row, sheet);
  const seg = raw.slice(styleRange[0], styleRange[1]);
  const fontTag = (seg.match(/<FRFont\b[^>]*>/) || [])[0] ?? '';
  const fontAttr = (name) => (fontTag.match(new RegExp(`\\b${name}="([^"]*)"`)) || [])[1] ?? null;
  const fontName = fontAttr('name');
  const fontStyle = fontAttr('style');
  const fontSize = fontAttr('size');
  const underlineM = seg.match(/<FRFont [^>]*\bunderline="([^"]+)"/);
  const strikeM = seg.match(/<FRFont [^>]*\bisStrikethrough="([^"]+)"/);
  // 前景色两种形式：子元素 <foreground><FineColor/> 或属性 foreground="..."（真实样本两种都有）
  const fgM = seg.match(/<foreground>\s*<FineColor color="([^"]+)"/);
  const fgAttrM = seg.match(/<FRFont [^>]*\bforeground="([^"]+)"/);
  const bgNameM = seg.match(/<Background name="([^"]+)"/);
  // 背景色两种形式：子元素 <color><FineColor/> 或属性 color="..."（Demo.cpt 的 ReportSettings 用属性形式）
  const bgColorM = seg.match(/<Background name="ColorBackground">[\s\S]*?<FineColor color="([^"]+)"/);
  const bgColorAttrM = seg.match(/<Background name="ColorBackground"\s+color="([^"]+)"/);
  const styleBits = fontStyle == null ? 0 : Number(fontStyle);
  const styleAttr = (k) => {
    const m = seg.match(new RegExp(`<Style(?=\\s|>)[^>]*\\b${k}="([^"]+)"`));
    return m ? Number(m[1]) : null;
  };
  const borderM = seg.match(/<Border>([\s\S]*?)<\/Border>/);
  const parseSide = (tag) => {
    if (!borderM) return null;
    const sm = borderM[1].match(new RegExp(`<${tag} style="(\\d+)"`));
    if (!sm) return null;
    const cm = borderM[1].match(new RegExp(`<${tag} style="[^"]*"[^>]*>[\\s\\S]*?<FineColor color="([^"]+)"`));
    return { style: Number(sm[1]), color: cm ? argbToHex(cm[1]) : null };
  };
  const border = borderM
    ? { top: parseSide('Top'), bottom: parseSide('Bottom'), left: parseSide('Left'), right: parseSide('Right'), outerTop: parseSide('OuterTop'), innerHorizontal: parseSide('InnerHorizontal') }
    : null;
  return {
    cell: `${column},${row}`,
    styleIndex,
    sharedCells: countStyleRefs(raw, styleIndex),
    fontName,
    bold: fontStyle == null ? null : (styleBits & 1) !== 0,
    italic: fontStyle == null ? null : (styleBits & 2) !== 0,
    underline: underlineM ? (Number(underlineM[1]) !== 0) : false,
    strikethrough: strikeM ? (String(strikeM[1]) === 'true') : false,
    fontSizePt: fontSize == null ? null : Number(fontSize) / 4,
    foregroundColor: fgM ? argbToHex(fgM[1]) : fgAttrM ? argbToHex(fgAttrM[1]) : null,
    backgroundName: bgNameM ? bgNameM[1] : null,
    backgroundColor: bgColorM ? argbToHex(bgColorM[1]) : bgColorAttrM ? argbToHex(bgColorAttrM[1]) : null,
    horizontalAlignment: styleAttr('horizontal_alignment'),
    verticalAlignment: styleAttr('vertical_alignment'),
    textStyle: styleAttr('textStyle'),
    paddingLeft: styleAttr('paddingLeft'),
    paddingRight: styleAttr('paddingRight'),
    lineSpacing: styleAttr('lineSpacing'),
    rotation: styleAttr('rotation'),
    border,
  };
}

/** 在 Style 开标签上 upsert 属性（已存在则替换值，不存在则插入） */
function upsertStyleAttr(out, sb, se, attr, value, what) {
  const seg = out.slice(sb, se);
  const re = new RegExp(`(${attr}\\s*=\\s*["'])[^"']*(["'])`);
  if (re.test(seg)) return replaceAttr(out, sb, se, attr, String(value), what);
  const openEnd = seg.indexOf('>');
  if (openEnd < 0) throw new Error(`定位失败：${what} 开标签未闭合`);
  return out.slice(0, sb + openEnd) + ` ${attr}="${String(value)}"` + out.slice(sb + openEnd);
}

/** 只修改指定开标签上的属性，不重建标签，避免丢失 FR 未公开/版本特有属性。 */
function upsertOpenTagAttr(out, tagStart, attr, value, what) {
  const tagEnd = out.indexOf('>', tagStart);
  if (tagEnd < 0) throw new Error(`定位失败：${what} 开标签未闭合`);
  const seg = out.slice(tagStart, tagEnd + 1);
  const re = new RegExp(`\\b${attr}\\s*=\\s*["']`);
  if (re.test(seg)) return replaceAttr(out, tagStart, tagEnd + 1, attr, String(value), what);
  const suffix = seg.match(/\/\s*>$|>$/);
  if (!suffix) throw new Error(`定位失败：${what} 开标签未闭合`);
  const insertAt = tagStart + seg.length - suffix[0].length;
  return out.slice(0, insertAt) + ` ${attr}="${String(value)}"` + out.slice(insertAt);
}

/** 生成 <Border> 块（与 generate.js styleBorderXml 同构；本地实现避免循环依赖） */
function borderBlockXml(border) {
  if (!border || typeof border !== 'object') return '<Border/>';
  const side = (tag, v) => {
    if (!v || typeof v !== 'object') return '';
    const style = v.style != null ? ` style="${escapeXmlAttr(String(v.style))}"` : '';
    if (v.color == null) return `<${tag}${style}/>`;
    return `<${tag}${style}>
<color>
<FineColor color="${hexToArgb(v.color)}" hor="-1" ver="-1"/>
</color>
</${tag}>`;
  };
  const parts = (['top', 'bottom', 'left', 'right', 'outerTop', 'innerHorizontal']
    .filter((k) => border[k])
    .map((k) => side({ top: 'Top', bottom: 'Bottom', left: 'Left', right: 'Right', outerTop: 'OuterTop', innerHorizontal: 'InnerHorizontal' }[k], border[k])))
    .join('\n');
  return parts ? `<Border>\n${parts}\n</Border>` : '<Border/>';
}

/** 替换 Style 块内的 <Border …>（含自闭合 <Border/> 与子元素形式） */
function replaceBorder(out, sb, se, styleIndex, border) {
  const seg = out.slice(sb, se);
  const m = seg.match(/<Border[^>]*\/>|<Border>[\s\S]*?<\/Border>/);
  if (!m) throw new Error(`定位失败：样式 ${styleIndex} 无 Border 元素`);
  const abs = sb + m.index;
  return out.slice(0, abs) + borderBlockXml(border) + out.slice(abs + m[0].length);
}

/** 修改单元格样式（背景色/字号/字体/加粗/文字色）。共享样式会提示受影响单元格数。 */
export function updateCellStyle(path, column, row, {
  backgroundColor, fontName, fontSizePt, bold, italic, foregroundColor,
  underline, strikethrough, verticalAlignment, border,
  horizontalAlignment, textStyle, paddingLeft, paddingRight, lineSpacing, rotation,
  scope = 'cell',
}, sheet) {
  const { raw } = load(path);
  let out = raw;
  const hasChange = [backgroundColor, fontName, fontSizePt, bold, italic, foregroundColor,
    underline, strikethrough, verticalAlignment, border, horizontalAlignment,
    textStyle, paddingLeft, paddingRight, lineSpacing, rotation].some((value) => value !== undefined);
  if (!hasChange) throw new Error('update_cell_style 至少需要提供一个要修改的样式属性');
  if (!['cell', 'shared'].includes(scope)) throw new Error('update_cell_style.scope 只能是 cell 或 shared');

  const located = locateCellStyle(out, column, row, sheet);
  const originalStyleIndex = located.styleIndex;
  const sharedCells = countStyleRefs(out, originalStyleIndex);
  let styleIndex = originalStyleIndex;
  if (scope === 'cell') {
    const cloned = cloneStyleForCell(out, located.cellRange[0], originalStyleIndex);
    out = cloned.out;
    styleIndex = cloned.styleIndex;
  }
  let [sb, se] = locateStyleBlock(out, styleIndex);

  // 背景色
  if (backgroundColor !== undefined) {
    const newArgb = hexToArgb(backgroundColor);
    const seg = out.slice(sb, se);
    if (seg.includes('<Background name="ColorBackground">')) {
      // 子元素形式：替换 FineColor 颜色
      const m = seg.match(/<Background name="ColorBackground">[\s\S]*?<FineColor color="([^"]+)"/);
      if (!m) throw new Error(`定位失败：样式 ${styleIndex} 的 ColorBackground 无颜色`);
      const colorStart = sb + m.index + m[0].indexOf('color="') + 7;
      out = out.slice(0, colorStart) + newArgb + out.slice(colorStart + m[1].length);
    } else {
      const attrM = seg.match(/<Background name="ColorBackground"\s+color="([^"]+)"\s*\/>/);
      if (attrM) {
        // 属性形式（<Background name="ColorBackground" color="..."/>）：替换 color 属性值
        const rel = attrM.index + attrM[0].indexOf('color="') + 7;
        const abs = sb + rel;
        out = out.slice(0, abs) + newArgb + out.slice(abs + attrM[1].length);
      } else {
        // NullBackground → ColorBackground
        const bgIdx = seg.indexOf('<Background name="NullBackground"/>');
        if (bgIdx < 0) throw new Error(`定位失败：样式 ${styleIndex} 无 Background 元素`);
        const abs = sb + bgIdx;
        const newBg = `<Background name="ColorBackground">\n<color>\n<FineColor color="${newArgb}" hor="-1" ver="-1"/>\n</color>\n</Background>`;
        out = out.slice(0, abs) + newBg + out.slice(abs + '<Background name="NullBackground"/>'.length);
      }
    }
  }

/** 定位 Style 块内的 FRFont 完整范围：自闭合（/> 结尾）或非自闭合（含 </FRFont>） */
function locateFRFont(raw, sb, se, styleIndex) {
  const seg = raw.slice(sb, se);
  const fIdx = seg.indexOf('<FRFont ');
  if (fIdx < 0) throw new Error(`定位失败：样式 ${styleIndex} 无 FRFont`);
  const fStart = sb + fIdx;
  const gt = seg.indexOf('>', fIdx);
  if (gt < 0) throw new Error(`定位失败：样式 ${styleIndex} 的 FRFont 未闭合`);
  const tag = seg.slice(fIdx, gt + 1);
  if (tag.trim().endsWith('/>')) {
    return [fStart, sb + gt + 1]; // 自闭合
  }
  return blockRange(raw, fStart, '<FRFont ', '</FRFont>');
}

  // 字体相关：只 upsert 被请求的属性，保留 underline/strike/foreground 及未知版本属性。
  if (fontName !== undefined || fontSizePt !== undefined || bold !== undefined || italic !== undefined
      || foregroundColor !== undefined || underline !== undefined || strikethrough !== undefined) {
    [sb, se] = locateStyleBlock(out, styleIndex);
    let [fb, fe] = locateFRFont(out, sb, se, styleIndex);
    const fontHead = out.slice(fb, out.indexOf('>', fb) + 1);
    const attr = (name) => (fontHead.match(new RegExp(`\\b${name}="([^"]*)"`)) || [])[1] ?? null;
    let styleBits = Number(attr('style') ?? 0);

    if (fontName !== undefined) out = upsertOpenTagAttr(out, fb, 'name', escapeXmlAttr(fontName), `样式 ${styleIndex} FRFont`);
    if (fontSizePt !== undefined) {
      const pt = Number(fontSizePt);
      if (!(pt >= 6 && pt <= 200)) throw new Error(`字号 ${fontSizePt}pt 超出范围（6-200）`);
      out = upsertOpenTagAttr(out, fb, 'size', String(Math.round(pt * 4)), `样式 ${styleIndex} FRFont`);
    }
    if (bold !== undefined) styleBits = bold ? (styleBits | 1) : (styleBits & ~1);
    if (italic !== undefined) styleBits = italic ? (styleBits | 2) : (styleBits & ~2);
    if (bold !== undefined || italic !== undefined) {
      out = upsertOpenTagAttr(out, fb, 'style', String(styleBits), `样式 ${styleIndex} FRFont`);
    }
    if (underline !== undefined) {
      out = upsertOpenTagAttr(out, fb, 'underline', underline ? '1' : '0', `样式 ${styleIndex} FRFont`);
    }
    if (strikethrough !== undefined) {
      out = upsertOpenTagAttr(out, fb, 'isStrikethrough', strikethrough ? 'true' : 'false', `样式 ${styleIndex} FRFont`);
    }

    if (foregroundColor !== undefined) {
      const newArgb = hexToArgb(foregroundColor);
      [sb, se] = locateStyleBlock(out, styleIndex);
      [fb, fe] = locateFRFont(out, sb, se, styleIndex);
      const fontSeg = out.slice(fb, fe);
      const fgM = fontSeg.match(/<foreground>([\s\S]*?)<\/foreground>/);
      const fgAttr = /<FRFont\b[^>]*\bforeground="[^"]*"/.test(fontSeg);
      if (fgM) {
        const colorM = fgM[1].match(/<FineColor color="([^"]+)"/);
        if (!colorM) throw new Error(`定位失败：样式 ${styleIndex} 的 foreground 无颜色`);
        const fgStartAbs = fb + fgM.index;
        const colValIdx = out.indexOf('color="', fgStartAbs) + 7;
        out = out.slice(0, colValIdx) + newArgb + out.slice(colValIdx + colorM[1].length);
        if (fgAttr) out = upsertOpenTagAttr(out, fb, 'foreground', newArgb, `样式 ${styleIndex} FRFont`);
      } else if (fgAttr) {
        out = upsertOpenTagAttr(out, fb, 'foreground', newArgb, `样式 ${styleIndex} FRFont`);
      } else if (/^<FRFont\b[^>]*\/>$/.test(fontSeg)) {
        const expanded = fontSeg.replace(/\/\s*>$/, '>')
          + `\n<foreground>\n<FineColor color="${newArgb}" hor="-1" ver="-1"/>\n</foreground>\n</FRFont>`;
        out = out.slice(0, fb) + expanded + out.slice(fe);
      } else {
        const openEnd = out.indexOf('>', fb) + 1;
        out = out.slice(0, openEnd)
          + `\n<foreground>\n<FineColor color="${newArgb}" hor="-1" ver="-1"/>\n</foreground>`
          + out.slice(openEnd);
      }
    }
  }

  // 样式级属性（垂直对齐/文本控制/缩进/行距/方向）：upsert 到 Style 开标签
  for (const [val, attr] of [
    [horizontalAlignment, 'horizontal_alignment'], [verticalAlignment, 'vertical_alignment'], [textStyle, 'textStyle'],
    [paddingLeft, 'paddingLeft'], [paddingRight, 'paddingRight'],
    [lineSpacing, 'lineSpacing'], [rotation, 'rotation'],
  ]) {
    if (val !== undefined) {
      const [sb4, se4] = locateStyleBlock(out, styleIndex);
      out = upsertStyleAttr(out, sb4, se4, attr, val, `样式 ${styleIndex}`);
    }
  }
  // 边框：替换 <Border>（自闭合或子元素形式）
  if (border !== undefined) {
    const [sb5, se5] = locateStyleBlock(out, styleIndex);
    out = replaceBorder(out, sb5, se5, styleIndex, border);
  }

  save(path, out);
  const st = getCellStyle(path, column, row, sheet);
  return {
    action: 'update_cell_style', cell: `${column},${row}`, styleIndex, originalStyleIndex, scope,
    sharedCells,
    warning: scope === 'shared' && sharedCells > 1
      ? `已按 scope=shared 修改共享样式 ${styleIndex}，共影响 ${sharedCells} 个单元格`
      : null,
    updated: st,
  };
}

// ---------------- 填报绑定 ----------------

/** 定位第 submitIndex 个 SubmitVisitor 块；sheet 指定时仅在该工作表内定位（表内相对索引） */
function locateSubmit(raw, submitIndex, what = `提交 ${submitIndex + 1}`, sheet, pathForHint) {
  let starts;
  if (sheet != null) {
    const b = locateSheet(raw, sheet);
    starts = findAll(raw, '<SubmitVisitor').filter((s) => s >= b.start && s < b.end);
  } else {
    starts = findAll(raw, '<SubmitVisitor');
  }
  if (starts.length <= submitIndex) {
    throw new Error(submitHint(submitIndex, sheet, pathForHint));
  }
  return blockRange(raw, starts[submitIndex], '<SubmitVisitor', '</SubmitVisitor>');
}

/**
 * P2-2 submit 越界时的纠正指引：报出提交分布 + 正确的 sheet/submitIndex 传法，
 * 把"表内相对索引 vs 全局连续编号"口径直接送到报错里，不再靠口口相传。
 */
function submitHint(submitIndex, sheet, pathForHint) {
  let dist = '';
  try {
    const fc = pathForHint ? fillConfig(pathForHint) : { submits: [] };
    const per = new Map();
    fc.submits.forEach((s) => {
      if (!per.has(s.sheet)) per.set(s.sheet, []);
      per.get(s.sheet).push(`${s.name}→${s.table || '(无表)'}`);
    });
    const parts = [...per.entries()].map(([sh, list]) => `${sh}:${list.length}个(${list.join('、')})`);
    dist = parts.length ? `现分布：${parts.join('；')}。` : '文档当前无任何提交。';
  } catch { dist = ''; }
  if (sheet != null) {
    return `定位失败：工作表[${sheet}]内提交不足（传 sheet 时 submitIndex 是该表内相对索引、0 起，请求 submitIndex=${submitIndex}）。${dist}纠正：该表第1个提交传 submitIndex=0；要定位其他表的提交请改传对应 sheet。可用 get_fill_config 查看各表提交清单。`;
  }
  return `定位失败：全文档提交不足（不传 sheet 时 submitIndex 是全局连续编号、跨表按文档顺序 0 起，请求 submitIndex=${submitIndex}）。${dist}纠正：多 sheet 多提交时必须传 sheet（此时 submitIndex 改为该表内相对索引）；单提交模板可省略 sheet。可用 get_fill_config 查看各表提交清单。`;
}

/** 在 SubmitVisitor 块内定位 ColumnConfig 块（按字段名），返回 [start,end, 是否含 ColumnRow] */
function locateColumnConfig(raw, sb, se, field, what = `绑定字段 ${field}`) {
  const seg = raw.slice(sb, se);
  // XML 中 name 属性是转义后的形式，匹配时用 escapeXmlAttr 对齐
  const idx = seg.indexOf(`<ColumnConfig name="${escapeXmlAttr(field)}"`);
  if (idx < 0) throw new Error(`定位失败：未找到 ${what}`);
  const [b, e] = blockRange(raw, sb + idx, '<ColumnConfig ', '</ColumnConfig>');
  const inner = raw.slice(b, e);
  return [b, e, inner.includes('<ColumnRow')];
}

export function updateFillBinding(path, submitIndex, field, { newField, column, row, isKey, constant, skipUnmodified }, sheet) {
  const { raw } = load(path);
  let out = raw;
  const [sb, se] = locateSubmit(out, submitIndex, `提交 ${submitIndex + 1}`, sheet, path);
  // 2026-10-30：自由 SQL 提交没有 ColumnConfig，改绑定无从下手 —— 明确回指 parameters 通道
  if (raw.slice(sb, se).includes('class="com.fr.report.write.FreeSQLSubmiter"')) {
    throw new Error(`updateFillBinding: 提交 ${submitIndex + 1} 是自由 SQL 提交（FreeSQLSubmiter）—— 没有 ColumnConfig 可改；SQL 里的 \${x} 请用 update_fill_submit({path, submitIndex, parameters:[{name:"x"}]}) 声明提交参数。`);
  }
  let [cb0, ce0, hasRow] = locateColumnConfig(out, sb, se, field);
  let curField = field;
  if (newField) {
    out = replaceAttr(out, cb0, ce0, 'name', escapeXmlAttr(newField), `绑定 ${field}`);
    curField = newField; // 改名后必须用新名重定位（旧名已不存在）
  }
  [cb0, ce0, hasRow] = locateColumnConfig(out, sb, se, curField);
  if ((column !== undefined || row !== undefined) && !hasRow) {
    throw new Error(`绑定字段 ${field} 为常量值绑定（无 ColumnRow），无法修改单元格坐标`);
  }
  // M69：常量值绑定 —— 把 <ColumnRow column col row/> 换成 <O><![CDATA[value]]></O>（或反向）。
  // 解决"is_delete 依赖单元格、被 other 字段污染"的根治点：改用固定常量 0。
  // 与 column/row 互斥：传了 constant 就按常量绑定处理；再传 column/row 会报错（语义冲突）。
  if (constant !== undefined) {
    if (column !== undefined || row !== undefined) {
      throw new Error(`update_fill_binding: constant 与 column/row 互斥（常量绑定与单元格坐标二选一）`);
    }
    const safeConst = assertSafeCdata(String(constant), `绑定 ${field} 常量值`);
    // 定位 ColumnConfig 内部（去掉开/闭标签），整块替换为常量形态
    const openEnd = out.indexOf('>', cb0) + 1;
    const closeStart = out.lastIndexOf('</ColumnConfig>', ce0);
    if (closeStart < 0 || closeStart < openEnd) throw new Error(`定位失败：绑定 ${field} 的 ColumnConfig 未闭合`);
    const constBody = `<O>\n<![CDATA[${safeConst}]]></O>`;
    out = out.slice(0, openEnd) + '\n' + constBody + '\n' + out.slice(closeStart);
    if (skipUnmodified !== undefined) {
      const [sb2, se2] = locateSubmit(out, submitIndex, `提交 ${submitIndex + 1}`, sheet, path);
      const [cb2, ce2] = locateColumnConfig(out, sb2, se2, curField);
      out = replaceAttr(out, cb2, ce2, 'skipUnmodified', String(skipUnmodified === true), `绑定 ${field} skipUnmodified`);
    }
    save(path, out);
    return {
      action: 'update_fill_binding', submitIndex, field, constant: String(constant), mode: 'constant',
      ...(skipUnmodified !== undefined ? { skipUnmodified: skipUnmodified === true } : {}),
      bytes: Buffer.byteLength(out, 'utf8'),
      hint: `已把绑定 ${field} 改为常量值 ${JSON.stringify(String(constant))}（不再依赖任何单元格）。${skipUnmodified !== undefined ? ` skipUnmodified=${skipUnmodified === true}。` : ''}`,
    };
  }
  if (column !== undefined || row !== undefined) {
    const seg = out.slice(cb0, ce0);
    const rowIdx = seg.indexOf('<ColumnRow ');
    const rowEndRel = seg.indexOf('/>', rowIdx < 0 ? 0 : rowIdx);
    if (rowIdx < 0 || rowEndRel < 0) throw new Error(`定位失败：绑定 ${field} 无 <ColumnRow/>`);
    let rb = cb0 + rowIdx;
    let re = cb0 + rowEndRel + 2;
    if (column !== undefined) {
      out = replaceAttr(out, rb, re, 'column', String(column), `绑定 ${field} 列`);
      // 替换后重新定位 ColumnRow 区间（值长度变化会导致旧索引失效）
      const seg2 = out.slice(cb0, ce0);
      const r2 = seg2.indexOf('<ColumnRow ');
      const re2 = seg2.indexOf('/>', r2 < 0 ? 0 : r2);
      if (r2 < 0 || re2 < 0) throw new Error(`定位失败：绑定 ${field} 无 <ColumnRow/>`);
      rb = cb0 + r2;
      re = cb0 + re2 + 2;
    }
    if (row !== undefined) out = replaceAttr(out, rb, re, 'row', String(row), `绑定 ${field} 行`);
  }
  if (isKey !== undefined) {
    out = replaceAttr(out, cb0, ce0, 'isKey', String(isKey), `绑定 ${field} isKey`);
  }
  // skipUnmodified（列级智能提交）：FR「未修改则跳过」开关。sandbox19/v1 会话里这是唯一
  // 挡住"只写改动字段"的缺口——fill_binding 族 9 个工具此前全都没有这个参数。
  if (skipUnmodified !== undefined) {
    const [sb2, se2] = locateSubmit(out, submitIndex, `提交 ${submitIndex + 1}`, sheet, path);
    const [cb2, ce2] = locateColumnConfig(out, sb2, se2, curField);
    out = replaceAttr(out, cb2, ce2, 'skipUnmodified', String(skipUnmodified === true), `绑定 ${field} skipUnmodified`);
  }
  save(path, out);
  return {
    action: 'update_fill_binding', submitIndex, field, bytes: Buffer.byteLength(out, 'utf8'),
    ...(skipUnmodified !== undefined ? { skipUnmodified: skipUnmodified === true } : {}),
  };
}

export function addFillBinding(path, submitIndex, field, column, row, isKey = false, sheet, skipUnmodified = false) {
  // S3: 坐标必须是合法非负整数 —— undefined/字符串会直接写进 XML 产生损坏绑定
  const c = Number(column), r = Number(row);
  if (!Number.isInteger(c) || c < 0 || !Number.isInteger(r) || r < 0) {
    throw new Error(`add_fill_binding: column/row 必须是非负整数，收到 (${column},${row})`);
  }
  const safeField = escapeXmlAttr(field);
  const { raw } = load(path);
  const [sb, se] = locateSubmit(raw, submitIndex, `提交 ${submitIndex + 1}`, sheet, path);
  const seg = raw.slice(sb, se);
  // 2026-10-30（sandbox4/v1 实测）：自由 SQL 提交没有 DMLConfig/ColumnConfig，字段绑定对它无效。
  // 旧实现会落到 "SubmitVisitor 内无 </DMLConfig>" 这种定位失败文案，误导成结构损坏。
  if (seg.includes('class="com.fr.report.write.FreeSQLSubmiter"')) {
    throw new Error(`addFillBinding: 提交 ${submitIndex + 1} 是自由 SQL 提交（FreeSQLSubmiter）—— 没有 <DMLConfig>/ColumnConfig，字段绑定对它无效；SQL 里的 \${x} 请用 update_fill_submit({path, submitIndex, parameters:[{name:"x"}]}) 声明（新建提交时 add_fill_submit 也支持 parameters）。`);
  }
  // S3: 同一提交内字段名重复会产生两个 ColumnConfig，FR 提交行为未定义，直接拒绝
  if (seg.includes(`<ColumnConfig name="${safeField}"`)) {
    const where = sheet != null
      ? `工作表[${sheet}]内第 ${submitIndex + 1} 个提交（表内相对索引）`
      : `全局第 ${submitIndex + 1} 个提交（全局连续编号）`;
    throw new Error(`绑定字段 "${field}" 已存在于${where}；如需修改坐标请用 update_fill_binding（传相同 sheet/submitIndex 口径）`);
  }
  const dmlIdx = seg.lastIndexOf('</DMLConfig>');
  if (dmlIdx < 0) throw new Error('定位失败：SubmitVisitor 内无 </DMLConfig>（该提交不是 BuiltInSQLSubmiter 列映射形态；自由 SQL 提交用 parameters 声明参数，不要用字段绑定）');
  const insertAt = sb + dmlIdx;
  const skip = skipUnmodified === true ? 'true' : 'false';
  const snippet = `<ColumnConfig name="${safeField}" isKey="${isKey}" skipUnmodified="${skip}">\n<ColumnRow column="${c}" row="${r}"/>\n</ColumnConfig>\n`;
  const out = raw.slice(0, insertAt) + snippet + raw.slice(insertAt);
  save(path, out);
  return {
    action: 'add_fill_binding', submitIndex, field, column: c, row: r, isKey, skipUnmodified: skip === 'true',
    bytes: Buffer.byteLength(out, 'utf8'),
  };
}

export function deleteFillBinding(path, submitIndex, field, sheet) {
  const { raw } = load(path);
  const [sb, se] = locateSubmit(raw, submitIndex, `提交 ${submitIndex + 1}`, sheet, path);
  const [cb, ce] = locateColumnConfig(raw, sb, se, field);
  const out = removeRange(raw, cb, ce);
  save(path, out);
  return { action: 'delete_fill_binding', submitIndex, field, bytes: Buffer.byteLength(out, 'utf8') };
}

// ============ 单元格内嵌提交（Commit2DBJavaScript）读写 ============
//
// 与 update_fill_binding 的分工：那边只认 <SubmitVisitor>（报表级），这边认
// FreeButton 事件里 <JavaScript class="com.fr.js.Commit2DBJavaScript"> 内嵌的
// <Attributes name="提交N"/> + <DMLConfig>（可多套）。写操作只动目标 DMLConfig 内部，
// 其余字节（其它提交、提交后回调 JS、Widget 其它属性）逐字节保留。

/** update_embedded_submit：改内嵌提交的字段列映射（patch）或整列清单（replace） */
export function updateEmbeddedSubmit(path, {
  cell, submit, sheet, mode = 'patch', field, column, row, isKey, constant, columns, skipUnmodified,
} = {}) {
  const { raw } = load(path);
  const { commit, submit: sub } = locateEmbeddedSubmit(raw, { submit, cell, sheet });
  const where = `${sub.name}@${commit.cell ? `${colName(commit.cell.column)}${commit.cell.row + 1}` : '?'}`;
  const before = sub.columns.length;

  if (mode === 'patch') {
    if (column === undefined && row === undefined && isKey === undefined && constant === undefined && skipUnmodified === undefined) {
      throw new Error('updateEmbeddedSubmit(patch): 至少提供 column/row/isKey/constant/skipUnmodified 之一（要改字段本身请用 replace 模式）');
    }
    if (!field || !String(field).trim()) {
      throw new Error('updateEmbeddedSubmit(patch): 必须提供 field（要改的字段名）。可用 get_embedded_submits 查字段清单');
    }
    if (constant !== undefined && (column !== undefined || row !== undefined)) {
      throw new Error('updateEmbeddedSubmit(patch): constant 与 column/row 互斥（常量绑定与单元格坐标二选一）');
    }
    const seg = raw.slice(sub.dmlStart, sub.dmlEnd);
    const target = seg.indexOf(`<ColumnConfig name="${escapeXmlAttr(String(field))}"`);
    if (target < 0) {
      throw new Error(`updateEmbeddedSubmit(patch): ${where} 内未找到字段 "${field}"。现有字段：${sub.columns.map((c) => c.name).join('、')}`);
    }
    const [cbAbs, ceAbs] = blockRange(raw, sub.dmlStart + target, '<ColumnConfig ', '</ColumnConfig>');
    let out = raw;
    let [cb, ce] = [cbAbs, ceAbs];
    if (isKey !== undefined) {
      out = replaceAttr(out, cb, ce, 'isKey', String(isKey === true), `内嵌提交 ${where} 字段 ${field} isKey`);
    }
    if (constant !== undefined) {
      const openEnd = out.indexOf('>', cb) + 1;
      const closeStart = out.lastIndexOf('</ColumnConfig>', ce);
      if (closeStart < 0 || closeStart < openEnd) throw new Error(`定位失败：内嵌提交 ${where} 字段 ${field} 的 ColumnConfig 未闭合`);
      out = out.slice(0, openEnd) + `\n<O>\n<![CDATA[${assertSafeCdata(String(constant), `内嵌提交字段 ${field} 常量`)}]]></O>\n` + out.slice(closeStart);
    } else if (column !== undefined || row !== undefined) {
      const segNow = out.slice(cb, ce);
      const rIdx = segNow.indexOf('<ColumnRow ');
      const rEnd = segNow.indexOf('/>', rIdx < 0 ? 0 : rIdx);
      if (rIdx < 0 || rEnd < 0) {
        throw new Error(`updateEmbeddedSubmit(patch): ${where} 的字段 "${field}" 是常量值绑定（无 ColumnRow），无法改列坐标；如需改成单元格绑定请用 replace 模式或先在设计器改`);
      }
      let rb = cb + rIdx;
      let re = cb + rEnd + 2;
      if (column !== undefined) {
        if (!Number.isInteger(Number(column)) || Number(column) < 0) throw new Error(`updateEmbeddedSubmit(patch): column 必须是非负整数，收到 ${column}`);
        out = replaceAttr(out, rb, re, 'column', String(Number(column)), `内嵌提交 ${where} 字段 ${field} 列`);
        const seg2 = out.slice(cb, ce);
        const r2 = seg2.indexOf('<ColumnRow ');
        const re2 = seg2.indexOf('/>', r2 < 0 ? 0 : r2);
        rb = cb + r2;
        re = cb + re2 + 2;
      }
      if (row !== undefined) {
        if (!Number.isInteger(Number(row)) || Number(row) < 0) throw new Error(`updateEmbeddedSubmit(patch): row 必须是非负整数，收到 ${row}`);
        out = replaceAttr(out, rb, re, 'row', String(Number(row)), `内嵌提交 ${where} 字段 ${field} 行`);
      }
    }
    // skipUnmodified（列级智能提交）最后处理：前面的常量/坐标改写会改变块长度，需重新定位
    if (skipUnmodified !== undefined) {
      const dmlEndNow = out.indexOf('</DMLConfig>', sub.dmlStart);
      const segNow = out.slice(sub.dmlStart, dmlEndNow < 0 ? out.length : dmlEndNow);
      const targetNow = segNow.indexOf(`<ColumnConfig name="${escapeXmlAttr(String(field))}"`);
      if (targetNow < 0) throw new Error(`定位失败：内嵌提交 ${where} 字段 ${field} 在改写后失配`);
      const [cb2, ce2] = blockRange(out, sub.dmlStart + targetNow, '<ColumnConfig ', '</ColumnConfig>');
      out = replaceAttr(out, cb2, ce2, 'skipUnmodified', String(skipUnmodified === true), `内嵌提交 ${where} 字段 ${field} skipUnmodified`);
    }
    save(path, out);
    const after = scanEmbeddedCommits(out).find((c) => c.start === commit.start);
    const afterSub = after?.submits.find((s) => s.name === sub.name);
    return {
      action: 'update_embedded_submit', cell: commit.cell, submit: sub.name, table: sub.table, mode: 'patch',
      field: String(field), columnsBefore: before, columnsAfter: afterSub?.columns.length ?? before,
      fieldAfter: afterSub?.columns.find((c) => c.name === String(field)) ?? null,
      ...(skipUnmodified !== undefined ? { skipUnmodified: skipUnmodified === true } : {}),
      bytes: Buffer.byteLength(out, 'utf8'),
    };
  }

  if (mode === 'replace') {
    if (!Array.isArray(columns) || columns.length === 0) {
      throw new Error('updateEmbeddedSubmit(replace): 必须提供非空 columns 数组（该提交落盘后的完整字段清单）');
    }
    const seen = new Set();
    const items = columns.map((c, i) => {
      if (!c || typeof c !== 'object') throw new Error(`updateEmbeddedSubmit(replace): columns[${i}] 必须是 {name, column, row?, isKey?} 对象`);
      const name = String(c.name ?? '').trim();
      if (!name) throw new Error(`updateEmbeddedSubmit(replace): columns[${i}].name 不能为空`);
      const safeName = escapeXmlAttr(name);
      if (seen.has(safeName)) throw new Error(`updateEmbeddedSubmit(replace): 字段 "${name}" 重复（同一提交内同名会产生两个 ColumnConfig，FR 行为未定义）`);
      seen.add(safeName);
      const isKey = c.isKey === true;
      if (c.constant !== undefined && c.constant !== null) {
        return columnConfigXml({ name: safeName, isKey, constant: assertSafeCdata(String(c.constant), `内嵌提交字段 ${name} 常量`), skipUnmodified: c.skipUnmodified === true });
      }
      const col = Number(c.column);
      if (!Number.isInteger(col) || col < 0) throw new Error(`updateEmbeddedSubmit(replace): columns[${i}](${name}) 的 column 必须是非负整数`);
      const rw = c.row === undefined ? 1 : Number(c.row);
      if (!Number.isInteger(rw) || rw < 0) throw new Error(`updateEmbeddedSubmit(replace): columns[${i}](${name}) 的 row 必须是非负整数`);
      return columnConfigXml({ name: safeName, column: col, row: rw, isKey, skipUnmodified: c.skipUnmodified === true });
    });
    const dml = raw.slice(sub.dmlStart, sub.dmlEnd);
    const tableTag = (dml.match(/<Table\b[^>]*\/>/) || [])[0];
    if (!tableTag) throw new Error(`updateEmbeddedSubmit(replace): ${where} 的 DMLConfig 内未找到 <Table/>（结构异常，请在设计器核对）`);
    const body = items.join('\n');
    const newDml = `${sub.openTag}\n${tableTag}\n${body}\n${sub.condition ? `${sub.condition}\n` : ''}</DMLConfig>`;
    const out = raw.slice(0, sub.dmlStart) + newDml + raw.slice(sub.dmlEnd);
    save(path, out);
    return {
      action: 'update_embedded_submit', cell: commit.cell, submit: sub.name, table: sub.table, mode: 'replace',
      columnsBefore: before, columnsAfter: items.length, removedColumns: before - items.length,
      columns: columns.map((c) => c.name), bytes: Buffer.byteLength(out, 'utf8'),
    };
  }

  throw new Error(`updateEmbeddedSubmit: mode 只能是 patch 或 replace，收到 "${mode}"`);
}

// M50 C: 既有模板填报工具栏（Template-level WebWriteContent/ToolBars）增删改
// 官方结构参考: reportlets/doc/Form/Cutpage/填报分页.cpt
//   <WebWriteContent><ToolBars><ToolBarManager><Location><Embed position="1"/></Location>
//   <ToolBar><Widget class="com.fr.report.web.button.write.Submit">…</Widget>…</ToolBar>
//   </ToolBarManager></ToolBars></WebWriteContent>
const TOOLBAR_BUTTONS = {
  submit: { class: 'com.fr.report.web.button.write.Submit', text: "${i18n('Fine-Engine_Report_Utils_Submit')}", icon: 'submit', extra: '<Verify failVerifySubmit="false" value="true"/>\n<Sheet onlySubmitSelect="false"/>' },
  verify: { class: 'com.fr.report.web.button.write.Verify', text: "${i18n('Fine-Engine_Report_Verify_Data')}", icon: 'verify', extra: '' },
  'append-row': { class: 'com.fr.report.web.button.write.AppendColumnRow', text: "${i18n('Fine-Engine_Add_Record')}", icon: 'appendrow', extra: '' },
  'delete-row': { class: 'com.fr.report.web.button.write.DeleteColumnRow', text: "${i18n('Fine-Engine_Delete_Column_Row')}", icon: 'deleterow', extra: '' },
  // M78-calibrate: 设计器内置导入按钮（官方文档《普通Excel导入》§2.2 填报页面设置 → 双击「导入 Excel」）。
  // 地面真值：sandbox OEM包材下单进度.cpt（ImExcelAppend）+ sandbox4 备份链（ImExcelClean），
  // 引擎 jar 反编译交叉验证（MultiExcelImportButton/importType，无模板侧设置依赖，按钮自包含）。
  // 注意与插件版区分：com.fr.plugin.excel.ui.ExcelImportButton（第三方插件，MCP 不合成）。
  'import-append': { class: 'com.fr.report.web.button.write.ImExcelAppend', text: "${i18n('Fine-Engine_Excel_Import_Append')}", icon: 'excel', extra: '', fullAttr: true },
  'import-clean': { class: 'com.fr.report.web.button.write.ImExcelClean', text: "${i18n('Fine-Engine_Excel_Import_Clean')}", icon: 'excel', extra: '', fullAttr: true },
};
// 内置导入按钮的完整 WidgetAttr/Hotkeys 形态（与上面实证原文逐字节一致，设计器可识别插件归属/图标）
const FULL_BUTTON_ATTR = `<WidgetAttr aspectRatioLocked="false" aspectRatioBackup="-1.0" description="">
<MobileBookMark useBookMark="false" bookMarkName="" frozen="false" index="-1" oldWidgetName=""/>
<PrivilegeControl/>
</WidgetAttr>`;
const HOTKEYS_EMPTY = `<Hotkeys>
<![CDATA[]]></Hotkeys>`;
export function setFillToolbar(path, { buttons = ['submit', 'verify', 'append-row', 'delete-row'] } = {}) {
  // M50: 接受字符串或数组统一处理（兼容模型传单按钮）
  const list = Array.isArray(buttons) ? buttons : [buttons];
  if (list.length === 0) throw new Error('set_fill_toolbar: buttons 不能为空');
  for (const b of list) {
    if (!TOOLBAR_BUTTONS[b]) throw new Error(`set_fill_toolbar: 未知按钮 "${b}"（可用: ${Object.keys(TOOLBAR_BUTTONS).join(' / ')}）`);
  }
  const widgetXml = (key) => {
    const b = TOOLBAR_BUTTONS[key];
    // fullAttr（内置导入按钮）：WidgetAttr/Hotkeys 必须与实证原文一致，否则设计器不认
    if (b.fullAttr) {
      return `<Widget class="${b.class}">
${FULL_BUTTON_ATTR}
<Text>
<![CDATA[${b.text}]]></Text>
${HOTKEYS_EMPTY}
<IconName>
<![CDATA[${b.icon}]]></IconName>
</Widget>`;
    }
    return `<Widget class="${b.class}">
<WidgetAttr description="">
<MobileBookMark useBookMark="false" bookMarkName="" frozen="false"/>
<PrivilegeControl/>
</WidgetAttr>
<Text>
<![CDATA[${b.text}]]></Text>
<IconName>
<![CDATA[${b.icon}]]></IconName>
${b.extra}
</Widget>`;
  };
  const toolbarXml = `<ToolBars>
<ToolBarManager>
<Location>
<Embed position="1"/>
</Location>
<ToolBar>
${list.map(widgetXml).join('\n')}
</ToolBar>
</ToolBarManager>
</ToolBars>`;

  // 2026-10-20 修复：写前确保 WebWriteContent 在 ReportWebAttr 内（缺容器仍按原口径报错；错位自动搬回）
  const ensured = ensureWebWriteContainerForWrite(path,
    '定位失败：模板无 <WebWriteContent>（非填报模板；请用 create_cpt(webWrite=true) 或 build_report(webWrite:true) 生成，或用 set_webwrite_extras({path, repair:true}) 创建容器）');
  const { raw } = load(path);
  // M50 S15-1: 定位模板级 WebWriteContent 块（兼容自闭合 <WebWriteContent/> 与带属性 <WebWriteContent ...>）
  // 用正则匹配开标签形态：<WebWriteContent> / <WebWriteContent ...> / <WebWriteContent/>
  const wwcOpenRe = /<WebWriteContent\b[^>]*>/;
  const wwcMatch = raw.match(wwcOpenRe);
  if (!wwcMatch) throw new Error('定位失败：模板无 <WebWriteContent>（非填报模板；请用 create_cpt(webWrite=true) 或 build_report 生成）');
  const wwcStart = wwcMatch.index;
  const wwcOpen = wwcMatch[0];
  const isWwcSelfClose = wwcOpen.trim().endsWith('/>');
  let out;
  if (isWwcSelfClose) {
    // 自闭合 → 展开为 <WebWriteContent> + ToolBars + </WebWriteContent>（保留原开标签属性）
    const attrsPart = wwcOpen.slice('<WebWriteContent'.length, wwcOpen.length - 2);
    const wwcOpenNode = `<WebWriteContent${attrsPart}>`;
    out = raw.slice(0, wwcStart) + wwcOpenNode + '\n' + toolbarXml + '\n</WebWriteContent>' + raw.slice(wwcStart + wwcOpen.length);
  } else {
    // 非自闭合 WebWriteContent：定位完整块，ToolBars 兼容三类形态（<ToolBars/> / <ToolBars .../> / <ToolBars>...</ToolBars>）
    const [wb, we] = blockRange(raw, wwcStart, '<WebWriteContent', '</WebWriteContent>');
    const tbRe = /<ToolBars\b[^>]*>/g;
    let tbMatch = null;
    for (let m = tbRe.exec(raw); m !== null; m = tbRe.exec(raw)) {
      if (m.index >= wb && m.index < we) { tbMatch = m; break; }
    }
    if (tbMatch) {
      const tbOpen = tbMatch[0];
      if (tbOpen.trim().endsWith('/>')) {
        // 自闭合 ToolBars（createCpt 产物形态）→ 直接替换该节点为完整块
        out = raw.slice(0, tbMatch.index) + toolbarXml + raw.slice(tbMatch.index + tbOpen.length);
      } else {
        const [tb, te] = blockRange(raw, tbMatch.index, '<ToolBars', '</ToolBars>');
        out = raw.slice(0, tb) + toolbarXml + raw.slice(te);
      }
    } else {
      const insertAt = wb + wwcOpen.length;
      out = raw.slice(0, insertAt) + '\n' + toolbarXml + raw.slice(insertAt);
    }
  }
  save(path, out);
  return { action: 'set_fill_toolbar', buttons: list, ...(ensured.repaired ? { repaired: ensured.repaired, repairNotes: ensured.notes } : {}), bytes: Buffer.byteLength(out, 'utf8') };
}

/**
 * 读取模板级填报工具栏按钮（<WebWriteContent><ToolBars> 内的内置按钮），返回 spec 词表的按钮名数组。
 *
 * 用途：build_report 是「整表重建、不继承原模板任何节点」，重建前先回显原工具栏，
 * 让调用方知道这次重建会清掉哪些按钮（避免"工具栏凭空消失、事后才发现"）。
 * 与 TOOLBAR_BUTTONS 同源反查，不另立一份映射。
 * 只读且容错：无 WebWriteContent / 无按钮 / 文件不存在或读不了，一律返回 []（绝不影响构建）。
 */
export function readFillToolbarButtons(path) {
  try {
    const { raw } = load(path);
    const i = raw.indexOf('<WebWriteContent');
    if (i < 0) return [];
    const open = /<WebWriteContent\b[^>]*>/.exec(raw.slice(i));
    if (!open) return [];
    const start = i + open[0].length;
    const end = raw.indexOf('</WebWriteContent>', start);
    const seg = raw.slice(start, end < 0 ? raw.length : end);
    const reverse = new Map(Object.entries(TOOLBAR_BUTTONS).map(([name, def]) => [def.class, name]));
    const out = [];
    for (const m of seg.matchAll(/<Widget class="([^"]+)"/g)) {
      const name = reverse.get(m[1]);
      if (name && !out.includes(name)) out.push(name);
    }
    return out;
  } catch { return []; }
}

// M47: 把空白/纯文本 cell 改造成指定 contentType (DSColumn/Formula/text 等)
// 解决: 现有 updateCellContent 拒绝 <O t="..."> 对象内容, 需要新工具显式"设类型"
// M76: 入参加 summary —— DSColumn 汇总方式（sum/avg/count/max/min），传了以官方
// GettingStarted.cpt 的 SummaryGrouper 形态落盘；缺省 = 分组形态（与改动前一致）
export function setCellContentType(path, { force = false, column, row, contentType, content, dsName, columnName, formula, imageClass, summary, sheet } = {}) {
  const c = Number(column), r = Number(row);
  if (!Number.isInteger(c) || c < 0 || !Number.isInteger(r) || r < 0) throw new Error(`单元格坐标非法: (${column},${row})`);
  // M76 安全围栏：汇总只能挂在数据集列上（官方汇总单元格全部是 DSColumn）
  if (summary != null && summary !== '' && contentType !== 'dsColumn') {
    throw new Error(`summary（DSColumn 汇总方式）只能用于 contentType="dsColumn"；当前 contentType="${contentType}"`);
  }
  const { raw, parsed } = load(path);
  const [cb, ce] = locateCell(raw, column, row, `单元格(${column},${row})`, sheet);

  // 构造新的 O 节点 XML
  let oXml;
  switch (contentType) {
    case 'text': {
      const txt = content != null ? String(content) : '';
      oXml = `<O>\n<![CDATA[${assertSafeCdata(txt, 'Content')}]]></O>`;
      break;
    }
    case 'formula': {
      const f = String(formula ?? content ?? '').trim();
      if (!f) throw new Error('setCellContentType: formula 模式必须提供 formula 或 content（如 "=ROW()-4" 或 "ROW()-4"）');
      // 2026-10-29 修：传 "=ROW()-4" 不再写成 "==ROW()-4"（normalizeFormulaExpr 保证单个前导 =）
      oXml = formulaObjectXml(f, '单元格公式');
      break;
    }
    case 'dsColumn': {
      if (!dsName || !columnName) throw new Error('setCellContentType: dsColumn 必须传 dsName + columnName');
      assertDatasetExists(parsed, dsName, 'DSColumn 数据集');
      // M76: RG 块 —— 缺省 = FunctionGrouper（自闭合）；传 summary = SummaryGrouper（官方汇总形态）
      const rgXml = dsColumnRGXml(summary);
      // M106：不再追加空占位 <cellSortAttr/>。官方 1030 处「控件格 + 绑定」与设计器拖字段产物
      // 都没有它（官方 105 处 <cellSortAttr> 只在真设了扩展后排序时出现，其中 76 处为空占位）；
      // update_cell_sort 在设置规则时会自建该节点，无需预置。去掉后本工具与 add_cell 产出的绑定块
      // 逐字节一致 —— 「设计器拖字段」的两个入口不再有形态差异。
      oXml = `<O t="DSColumn">\n<Attributes dsName="${escapeXmlAttr(dsName)}" columnName="${escapeXmlAttr(columnName)}"/>\n<Complex/>\n${rgXml}\n<Parameters/>\n</O>`;
      break;
    }
    case 'image': {
      const cls = imageClass || content || 'com.fr.report.cell.cellattr.core.ImageCellAttr';
      oXml = `<O t="Image">\n<Attributes class="${escapeXmlAttr(cls)}"/>\n<Complex/>\n</O>`;
      break;
    }
    default:
      throw new Error(`setCellContentType: 不支持的 contentType "${contentType}" (text/formula/dsColumn/image)`);
  }

  // 替换 cell 内的 O/Content 节点 (跟 updateCellContent 一样的 anchor 策略)
  // M47 关键: 这里用 replaceRange, 不只改 CDATA, 而改整个 O 节点结构
  //
  // M106 修复：控件格里 <Widget><widgetValue> 内部也有 <O>/<O t="...">，那是【控件默认值】槽，
  // 不是单元格内容。此前各 filter 只按 [cb,ce) 过滤、不排除 <Widget> 块，于是对"有控件、无单元格级 <O>"
  // 的格（add_cell(widget) 建出来的格正是这个形态），绑定被写进了 widgetValue：
  //   产出 <widgetValue><O t="DSColumn">…</O></widgetValue> —— 官方 1550 份模板里 0 例；
  //   单元格级仍无绑定（设计器不认），而 cells() 的兼容读取又会把它读成 DSColumn（写错、读掩盖、门禁放行）。
  // 现按 M105 宣称的"控件保留、只换绑定"语义：只在【单元格级】节点上替换；没有就在单元格级
  // <PrivilegeControl/> 之前插入 —— 官方元素顺序为内容节点先于 <PrivilegeControl/>，
  // 官方 1030 处「控件格 + 绑定」全部是这个兄弟形态。
  const wblock = locateWidgetBlock(raw, cb, ce, `单元格(${column},${row})`);
  const isCellLevel = (i) => wblock == null || i < wblock.start || i >= wblock.end;

  let tagOpen, tagClose, absIdx;
  const contentHits = findAll(raw, '<Content>').filter((i) => i >= cb && i < ce && isCellLevel(i));
  if (contentHits.length > 0) {
    tagOpen = '<Content>'; tagClose = '</Content>'; absIdx = contentHits[0];
  } else {
    const oHits = findAll(raw, '<O>').filter((i) => i >= cb && i < ce && isCellLevel(i));
    const oTHits = findAll(raw, '<O t="').filter((i) => i >= cb && i < ce && isCellLevel(i));
    if (oTHits.length > 0) {
      // 2026-10-27 P0-3（审计 G 类 7 条）：对象内容（<O t="...">）换型不再逼 delete+add 两跳。
      if (!force) {
        throw new Error(`setCellContentType: 单元格(${column},${row}) 已是对象内容, 如要换类型请先 delete_cell 再 add_cell（或传 force:true 由本工具整块替换）`);
      }
      const objIdx = oTHits[0];
      // 嵌套安全：对象内容里可能混有不带属性的 <O> 子块，blockRange 单一开标签数不准；
      // 按 <O…>/</O> 配对扫描（'</O>' 不含子串 '<O'，扫描不会误判闭标签）。
      let depth = 0, k = objIdx, oe = -1;
      const isO = (idx) => raw.startsWith('<O', idx) && [' ', '>', '\t', '\r', '\n'].includes(raw[idx + 2]);
      while (k < raw.length) {
        const nextClose = raw.indexOf('</O>', k);
        if (nextClose < 0) throw new Error(`setCellContentType: 对象内容未闭合（单元格(${column},${row})）`);
        const nextOpen = raw.indexOf('<O', k);
        if (nextOpen >= 0 && nextOpen < nextClose && isO(nextOpen)) {
          depth += 1;
          k = nextOpen + 2;
        } else {
          depth -= 1;
          k = nextClose + 4;
          if (depth === 0) { oe = k; break; }
        }
      }
      if (oe < 0) throw new Error(`setCellContentType: 对象内容嵌套异常（单元格(${column},${row})）`);
      const outObj = raw.slice(0, objIdx) + oXml + raw.slice(oe);
      save(path, outObj);
      return { action: 'set_cell_content_type', cell: `${column},${row}`, contentType, mode: 'replace-object', forced: true,
        note: '对象内容已整块替换：控件/合并/监听器保留，原 <O t=...> 对象内容丢失' };
    }
    if (oHits.length === 0) {
      // 单元格级无 <O> 节点（如控件格）：插入到单元格级 <PrivilegeControl/> 之前（官方顺序）
      const pcHits = findAll(raw, '<PrivilegeControl/>').filter((i) => i >= cb && i < ce && isCellLevel(i));
      if (pcHits.length === 0) throw new Error(`定位失败: 单元格(${column},${row}) 无单元格级 PrivilegeControl 锚点`);
      const insIdx = pcHits[0];
      const out = raw.slice(0, insIdx) + oXml + raw.slice(insIdx);
      save(path, out);
      return { action: 'set_cell_content_type', cell: `${column},${row}`, contentType, mode: 'insert' };
    }
    tagOpen = '<O>'; tagClose = '</O>'; absIdx = oHits[0];
  }
  // 用 blockRange + replaceRange 替换
  const [tb, te] = blockRange(raw, absIdx, tagOpen, tagClose);
  const out = raw.slice(0, tb) + oXml + raw.slice(te);
  save(path, out);
  return { action: 'set_cell_content_type', cell: `${column},${row}`, contentType, mode: 'replace' };
}

// ---------------- M68 单元格控件类型 ----------------
// 背景：用户改 id 自增列控件从 text 改为 number（报 "id 类型不匹配"）。cpt-mcp 此前无工具能
// 改已有单元格的 <Widget class> —— set_cell_content_type 只动 <O> 且遇到对象内容即拒绝，
// update_report_node 找不到单元格内嵌 <Widget>。但实测：TextEditor→NumberEditor 是干净的
// class 属性替换，<O t="DSColumn">（数据绑定）与其余 544 字节子结构原样保留、XML 校验通过。
// 本工具定位单元格内的 <Widget> 开标签，只替换 class 属性值（按官方白名单映射），
// 不改内容节点（<O t="DSColumn"> 数据绑定保留）/不清空子结构；type="none" 则删除整个 Widget 块
//（单元格变回纯数据/文本格）。方案依据：官方各填报控件同构，仅 class 不同（TextEditor/
// NumberEditor/TextArea/DateEditor/ComboBox/CheckBox/ComboCheckBox/Label）。

/** 控件类型 -> 官方 Widget class（与 generate.js widgetXml 或 rules.js 白名单一致） */
const CELL_WIDGET_CLASS = {
  text: 'com.fr.form.ui.TextEditor',
  number: 'com.fr.form.ui.NumberEditor',
  textarea: 'com.fr.form.ui.TextArea',
  date: 'com.fr.form.ui.DateEditor',
  comboBox: 'com.fr.form.ui.ComboBox',
  checkBox: 'com.fr.form.ui.CheckBox',
  comboCheckBox: 'com.fr.form.ui.ComboCheckBox',
  label: 'com.fr.form.ui.Label',
  submit: 'com.fr.report.web.button.write.Submit',
  appendRow: 'com.fr.report.web.button.write.AppendColumnRow',
  custom: null, // custom 用 widgetClass 显式指定 class
};

export function setCellWidget(path, { column, row, type, widgetClass, text, sheet, disabled } = {}) {
  if (column == null || row == null) throw new Error('setCellWidget: 必须提供 column 与 row（均从 0 起）');
  if (!type || !String(type).trim()) throw new Error('setCellWidget: 必须提供 type（text/number/textarea/date/comboBox/checkBox/comboCheckBox/label/submit/appendRow/custom/none）');
  const want = String(type).trim();
  const targetClass = want === 'none'
    ? null
    : want === 'custom'
      ? (widgetClass ? String(widgetClass) : null)
      : (CELL_WIDGET_CLASS[want] || null);
  if (want !== 'none' && !targetClass) {
    throw new Error(`setCellWidget: 不支持的控件类型 "${want}"（text/number/textarea/date/comboBox/checkBox/comboCheckBox/label/submit/appendRow/custom/none）`);
  }

  const { raw } = load(path);
  const [cb, ce] = locateCell(raw, column, row, `单元格(${column},${row})`, sheet);
  const seg = raw.slice(cb, ce);
  // 定位单元格内第一个 <Widget ...> 开标签（含自闭合 <Widget .../> 或开闭对）
  const wMatch = seg.match(/<Widget\b[^>]*>/);
  if (!wMatch) throw new Error(`setCellWidget: 单元格(${column},${row}) 内未找到 <Widget>（先 add_cell widget 或确认该格是控件格）`);
  const wAbs = cb + wMatch.index;
  const wEnd = wAbs + wMatch[0].length;

  if (want === 'none') {
    // 删除整个 <Widget>...</Widget> 块（含嵌套；自闭合则删开标签）。保留数据节点 <O>/<Content>。
    // 注意不能用 blockRange('<Widget'）：单元格控件块内含 <WidgetAttr>，其 `<Widget` 前缀会被
    // 误判为嵌套开标签导致深度失衡。单元格级控件不会内嵌另一个 <Widget> 元素，
    // 直接找其后第一个 `</Widget>` 即可。
    const trimmed = wMatch[0].trim();
    let delStart, delEnd;
    if (trimmed.endsWith('/>')) {
      delStart = wAbs; delEnd = wEnd;
    } else {
      const closeIdx = raw.indexOf('</Widget>', wAbs);
      if (closeIdx < 0) throw new Error(`setCellWidget: 单元格(${column},${row}) 的 <Widget> 未闭合`);
      delStart = wAbs; delEnd = closeIdx + '</Widget>'.length;
    }
    const out = raw.slice(0, delStart) + raw.slice(delEnd);
    save(path, out);
    return { action: 'set_cell_widget', cell: `${column},${row}`, type: 'none', mode: 'delete', bytes: Buffer.byteLength(out, 'utf8'), hint: '已删除该单元格的控件（<Widget>），数据/内容节点保留。' };
  }

  // class 属性替换（保留子结构与兄弟数据节点）
  const oldM = wMatch[0].match(/\bclass="([^"]+)"/);
  const oldClass = oldM ? oldM[1] : null;
  let out = replaceAttr(raw, wAbs, wEnd, 'class', targetClass, `单元格(${column},${row}) 控件`);
  // M82: disabled 开关（<WidgetAttr disabled="true">，通知排产表.cpt 等 30 处实证；表头禁用态输入框即此形态）
  let disabledMode = null;
  if (disabled !== undefined && disabled !== null) {
    const wantDisabled = disabled === true || String(disabled).toLowerCase() === 'true';
    const [cb2, ce2] = locateCell(out, column, row, `单元格(${column},${row})`, sheet);
    const seg2 = out.slice(cb2, ce2);
    const waMatch = seg2.match(/<WidgetAttr\b[^>]*>/);
    if (!waMatch) throw new Error(`setCellWidget: 单元格(${column},${row}) 控件内无 <WidgetAttr>（非标准控件形态）`);
    const waTag = waMatch[0];
    const hasDis = /\bdisabled="true"/.test(waTag);
    if (wantDisabled && !hasDis) {
      out = out.slice(0, cb2 + waMatch.index) + waTag.replace(/<WidgetAttr/, '<WidgetAttr disabled="true"') + out.slice(cb2 + waMatch.index + waTag.length);
      disabledMode = 'disabled';
    } else if (!wantDisabled && hasDis) {
      const cleaned = waTag.replace(/\s*\bdisabled="[^"]*"/, '');
      out = out.slice(0, cb2 + waMatch.index) + cleaned + out.slice(cb2 + waMatch.index + waTag.length);
      disabledMode = 'enabled';
    }
  }
  save(path, out);
  // text 参数：换类型的同时写控件显示文本（Label 空默认值不显示字体的场景）
  if (text != null && String(text).trim() !== '') {
    const r2 = setWidgetValue(path, { column, row, text, sheet });
    return {
      action: 'set_cell_widget', cell: `${column},${row}`, type: want,
      oldClass, newClass: targetClass, mode: 'update', text: r2.text, textMode: r2.mode,
      disabled: disabledMode,
      hint: `已把控件改为 ${targetClass} 并写入显示文本 "${r2.text}"。数据绑定 <O> 原样保留。`,
      bytes: r2.bytes,
    };
  }
  const clsMode = oldClass === targetClass ? 'unchanged' : 'update';
  return {
    action: 'set_cell_widget', cell: `${column},${row}`, type: want,
    oldClass, newClass: targetClass, mode: disabledMode ? 'update' : clsMode,
    disabled: disabledMode,
    hint: `已把单元格(${column},${row}) 控件从 ${oldClass || '(无)'} 改为 ${targetClass}（数据绑定 <O> 与子结构原样保留）。${disabledMode === 'disabled' ? '控件已设为禁用态（disabled="true"）。' : ''}${disabledMode === 'enabled' ? '控件禁用已解除。' : ''}${want === 'number' ? '数字控件接受数字输入，可解决 "id 类型不匹配"；' : ''}若改变了控件大类（如 text→comboBox），请用 validate_cpt 复查结构。`,
    bytes: Buffer.byteLength(out, 'utf8'),
  };
}

/** 定位单元格控件块 [start, end)，自闭合控件块返回 null（无值可写） */
function locateWidgetBlock(raw, cb, ce, label) {
  const seg = raw.slice(cb, ce);
  const wMatch = seg.match(/<Widget\b[^>]*>/);
  if (!wMatch) return null;
  const wAbs = cb + wMatch.index;
  const wEnd = wAbs + wMatch[0].length;
  if (wMatch[0].trim().endsWith('/>')) return { start: wAbs, end: wEnd, selfClosing: true, openTag: wMatch[0] };
  const closeIdx = raw.indexOf('</Widget>', wAbs);
  if (closeIdx < 0) throw new Error(`${label}: <Widget> 未闭合`);
  return { start: wAbs, end: closeIdx + '</Widget>'.length, selfClosing: false, openTag: wMatch[0] };
}

/**
 * 取 <widgetValue> 块内的**裸值槽** `<O>`（不带 t 属性）—— 写入默认值必须在它里面。
 *
 * M115 修 bug：原实现写死 `inner.indexOf('<O>')`，匹配不到 `<O t="DSColumn">` 这类带类型的
 * 对象，于是明明有 <O> 却报"widgetValue 内无 <O>"（sandbox4/V3/sample-fillV3.cpt 实测踩到）。
 * 这里返回三种判定，调用方据此决定"插入 / 拒绝并指路"：
 *   · { kind: 'bare', index }        裸 <O>（或 <O ...> 非 DSColumn 类型）→ 可安全插入默认值
 *   · { kind: 'object', index, t }   值槽里是数据集/图片等**单元格内容对象** → 属脏形态，拒绝写值
 *   · { kind: 'none' }               没有 <O>
 */
function findWidgetValueSlot(inner) {
  const any = /<O\b([^>]*)>/.exec(inner);
  if (!any) return { kind: 'none', index: -1 };
  const attrs = any[1] ?? '';
  const tm = /\bt="([^"]+)"/.exec(attrs);
  if (tm && tm[1]) return { kind: 'object', index: any.index, t: tm[1] };
  return { kind: 'bare', index: any.index };
}

/** 修改已有单元格控件的 widgetValue 文本（修 Label 空默认值导致字体不显示的问题） */
export function setWidgetValue(path, { column, row, text, sheet } = {}) {
  if (column == null || row == null) throw new Error('setWidgetValue: 必须提供 column 与 row（均从 0 起）');
  if (text == null || !String(text).length) throw new Error('setWidgetValue: 必须提供 text（控件显示文本；清空请传空格等占位）');
  const safeText = assertSafeCdata(String(text), '控件文本');

  const { raw } = load(path);
  const [cb, ce] = locateCell(raw, column, row, `单元格(${column},${row})`, sheet);
  const blk = locateWidgetBlock(raw, cb, ce, `setWidgetValue: 单元格(${column},${row})`);
  if (!blk) throw new Error(`setWidgetValue: 单元格(${column},${row}) 内未找到 <Widget>（先 add_cell widget 或 set_cell_widget）`);
  if (blk.selfClosing) throw new Error(`setWidgetValue: 单元格(${column},${row}) 的控件为自闭合块，无 widgetValue 可写`);
  const wBlock = raw.slice(blk.start, blk.end);

  let out;
  const wvIdx = wBlock.indexOf('<widgetValue>');
  if (wvIdx >= 0) {
    // 替换已有 widgetValue 内的 CDATA（覆盖语义，幂等）
    const wvEnd = wBlock.indexOf('</widgetValue>', wvIdx);
    if (wvEnd < 0) throw new Error(`setWidgetValue: 单元格(${column},${row}) 的 <widgetValue> 未闭合`);
    const inner = wBlock.slice(wvIdx, wvEnd);
    const cb2 = inner.indexOf('<![CDATA[');
    if (cb2 >= 0) {
      const ce2 = inner.indexOf(']]>', cb2);
      if (ce2 < 0) throw new Error(`setWidgetValue: 单元格(${column},${row}) 的 widgetValue CDATA 未闭合`);
      const absStart = blk.start + wvIdx + cb2 + '<![CDATA['.length;
      const absEnd = blk.start + wvIdx + ce2;
      out = raw.slice(0, absStart) + safeText + raw.slice(absEnd);
    } else {
      // 无 CDATA：在**裸 <O>** 开标签后插入默认值
      const slot = findWidgetValueSlot(inner);
      if (slot.kind === 'object') {
        // M115：值槽里是数据集对象（官方 0 例的脏形态）。**不覆盖**它 —— 那会把对象当默认值
        // 文本写坏；也不静默跳过。指路 clear_widget_value（删值槽）或 set_cell_content_type。
        throw new Error(
          `setWidgetValue: 单元格(${column},${row}) 的 <widgetValue> 内是单元格内容对象 <O t="${slot.t}">，不是可写文本的值槽。`
          + `这是「控件默认值槽塞了数据集对象」的脏形态（官方 1550 份样本 0 例，quality_gate_cpt 会报 error）。`
          + `请先用 clear_widget_value 删掉该 <widgetValue>（数据绑定在单元格级 <O> 上已存在，删掉不影响取数），再写默认值。`,
        );
      }
      if (slot.kind === 'none') throw new Error(`setWidgetValue: 单元格(${column},${row}) 的 widgetValue 内无 <O>`);
      const absIns = blk.start + wvIdx + slot.index + inner.slice(slot.index).indexOf('>') + 1;
      out = raw.slice(0, absIns) + `\n<![CDATA[${safeText}]]>` + raw.slice(absIns);
    }
  } else {
    // 无 widgetValue：在 </Widget> 前插入
    const wvBlock = `<widgetValue>\n<O>\n<![CDATA[${safeText}]]></O>\n</widgetValue>\n`;
    out = raw.slice(0, blk.end - '</Widget>'.length) + wvBlock + raw.slice(blk.end - '</Widget>'.length);
  }
  save(path, out);
  return {
    action: 'set_widget_value', cell: `${column},${row}`, text: String(text),
    mode: wvIdx >= 0 ? 'replace' : 'insert', bytes: Buffer.byteLength(out, 'utf8'),
    hint: '已写入控件显示文本（widgetValue）。Label 控件默认值为空时不显示任何字体，用本工具补文本。',
  };
}

/**
 * 删除单元格控件的 <widgetValue> 整块（M115）。
 *
 * 用途：清理「控件默认值槽里塞了单元格内容对象」的脏形态。
 *   官方落点：数据绑定是**单元格级** `<O t="DSColumn">`（与 <Widget> 平级，在 <PrivilegeControl/> 之前）；
 *   `<Widget><widgetValue>` 只能放默认值/公式。把数据集对象写进值槽在官方 1550 份样本里 **0 例**，
 *   而 quality_gate_cpt 会把它报成 error（sandbox4/V3/sample-fillV3.cpt 实测 11 处）。
 *   值槽整块删掉即是合法形态（多数控件本就没有 <widgetValue>），**不影响取数** —— 绑定在单元格级 <O> 上。
 *
 * 与邻近工具的分工：
 *   · set_cell_widget(type:'none') 删整个 <Widget>（连控件带监听一起没了）—— 太重，且有 Listener 时会被拒；
 *   · set_cell_content_type        改单元格级 <O> 的绑定类型 —— 碰到脏值槽会要求"先 delete_cell"，代价更大；
 *   · 本工具只删 <Widget> 内的 <widgetValue> 一个子节点，其余字节（Listener/Tooltip/扩展/绑定）原样保留。
 *
 * @param {{path:string, column:number, row:number, sheet?:number|string, expectObject?:boolean}} opts
 *   expectObject=true 时仅当值槽里确实是内容对象才动手（批量清理的防呆，避免误删正常默认值）
 */
export function clearWidgetValue(path, { column, row, sheet, expectObject = false } = {}) {
  if (column == null || row == null) throw new Error('clearWidgetValue: 必须提供 column 与 row（均从 0 起）');
  const { raw } = load(path);
  const [cb, ce] = locateCell(raw, column, row, `单元格(${column},${row})`, sheet);
  const blk = locateWidgetBlock(raw, cb, ce, `clearWidgetValue: 单元格(${column},${row})`);
  if (!blk) throw new Error(`clearWidgetValue: 单元格(${column},${row}) 内未找到 <Widget>（本工具只处理已有控件）`);
  if (blk.selfClosing) throw new Error(`clearWidgetValue: 单元格(${column},${row}) 的控件为自闭合块，本就没有 <widgetValue>`);

  const wBlock = raw.slice(blk.start, blk.end);
  const wvIdx = wBlock.indexOf('<widgetValue>');
  if (wvIdx < 0) {
    return {
      action: 'clear_widget_value', cell: `${column},${row}`, mode: 'none',
      message: '该控件本就没有 <widgetValue>（已是合法形态，未改动文件）',
    };
  }
  const wvEnd = wBlock.indexOf('</widgetValue>', wvIdx);
  if (wvEnd < 0) throw new Error(`clearWidgetValue: 单元格(${column},${row}) 的 <widgetValue> 未闭合`);
  const inner = wBlock.slice(wvIdx, wvEnd + '</widgetValue>'.length);
  const slot = findWidgetValueSlot(inner);

  if (expectObject && slot.kind !== 'object') {
    return {
      action: 'clear_widget_value', cell: `${column},${row}`, mode: 'skipped',
      slotKind: slot.kind,
      message: `值槽内不是单元格内容对象（${slot.kind === 'bare' ? '是普通默认值 <O>' : '无 <O>'}），expectObject=true 时不动它`,
    };
  }

  // 连同该块前后的空白一起删，避免留下空行（官方形态里 <widgetValue> 通常带前后换行）
  let absStart = blk.start + wvIdx;
  let absEnd = blk.start + wvIdx + inner.length;
  while (absStart > blk.start && /\s/.test(raw[absStart - 1])) absStart--;
  const trailing = raw.slice(absEnd).match(/^\s*\n/);
  if (trailing) absEnd += trailing[0].length;
  const out = raw.slice(0, absStart) + raw.slice(absEnd);
  save(path, out);
  return {
    action: 'clear_widget_value', cell: `${column},${row}`, mode: 'clear',
    removedSlotKind: slot.kind,
    removedObjectType: slot.kind === 'object' ? slot.t : undefined,
    bytesBefore: raw.length, bytesAfter: out.length,
    hint: '已删除控件默认值槽 <widgetValue>。数据绑定仍在单元格级 <O t="DSColumn"> 上（与 <Widget> 平级），取数不受影响；'
      + '若该控件确实需要默认值，可稍后用 set_widget_value 写文本。改后建议 validate_cpt + quality_gate_cpt 复核。',
  };
}

/**
 * 下拉类字典 XML（db=数据库表字典 / table=数据集字典 / custom=自定义固定项 / formula=公式数据字典）。
 *
 * M109：由 generate.js 的 paramWidgetXml 内联实现抽出（edits.js 是 generate.js 的下层，故置于此共用），
 * 供【单元格控件 widgetXml】、【参数面板控件 paramWidgetXml】、【就地换字典 updateCellDictionary】、
 * 【参数面板就地改字典 updateParameterWidget】共用（单一实现，禁止另抄一份）。
 * 官方 1550 份实测两侧形态一致：单元格控件侧 DatabaseDictionary 259 / TableDataDictionary 85 / CustomDictionary 106；
 * 参数面板侧 TableDataDictionary 140 / DatabaseDictionary 81 / CustomDictionary 60。
 * 也就是"单元格配置下拉单选控件后可以绑定数据集/数据库表"本就是官方能力，此前单元格侧只写 CustomDictionary。
 *
 * M117 补 formula：官方语料 `com.fr.data.impl.FormulaDictionary` 共 37 块（参数面板侧 25 / 单元格控件侧 12），
 * 官方两种形态 —— 带 <EFormulaDict>（12 块）与仅有 <FormulaDict>（25 块）；eFormula 缺省/空即后者。
 */
export function dictionaryXml({ dictionary, items, label = '控件' } = {}) {
  if (dictionary?.type === 'db') {
    // V2: ki/vi 必须是整数（数据库字典列索引）
    const ki = Number(dictionary.ki ?? -1);
    const vi = Number(dictionary.vi ?? -1);
    if (!Number.isInteger(ki) || !Number.isInteger(vi)) {
      throw new Error(`${label} 的 dictionary.ki/vi 必须是整数列索引，收到 ki=${JSON.stringify(dictionary.ki)} vi=${JSON.stringify(dictionary.vi)}`);
    }
    return `<Dictionary class="com.fr.data.impl.DatabaseDictionary">
<DBDictAttr tableName="${escapeXmlAttr(dictionary.table)}" schemaName="${escapeXmlAttr(dictionary.schema ?? '')}" ki="${ki}" vi="${vi}" kiName="${escapeXmlAttr(dictionary.kiName ?? '')}" viName="${escapeXmlAttr(dictionary.viName ?? '')}"/>
<Connection class="com.fr.data.impl.NameDatabaseConnection">
<DatabaseName>
<![CDATA[${assertSafeCdata(dictionary.connection ?? '', `${label} 连接`)}]]></DatabaseName>
</Connection>
</Dictionary>`;
  }
  if (dictionary?.type === 'table') {
    return `<Dictionary class="com.fr.data.impl.TableDataDictionary">
<FormulaDictAttr kiName="${escapeXmlAttr(dictionary.kiName ?? '')}" viName="${escapeXmlAttr(dictionary.viName ?? '')}"/>
<TableDataDictAttr>
<TableData class="com.fr.data.impl.NameTableData">
<Name>
<![CDATA[${assertSafeCdata(dictionary.dsName ?? '', `${label} 数据集`)}]]></Name>
</TableData>
</TableDataDictAttr>
</Dictionary>`;
  }
  if (dictionary?.type === 'formula') {
    // M117 公式数据字典：官方原文
    //   <Dictionary class="com.fr.data.impl.FormulaDictionary">
    //   <FormulaDict>
    //   <![CDATA[=range(2010,2012)]]></FormulaDict>
    //   <EFormulaDict>
    //   <![CDATA[=$$$+'年']]></EFormulaDict>
    //   </Dictionary>
    // FormulaDict=值公式（必填）；EFormulaDict=显示值公式（可缺省 —— 官方 25/37 块只有 FormulaDict）。
    const formula = dictionary.formula ?? '';
    if (String(formula).trim() === '') {
      throw new Error(`${label} 的 dictionary.type="formula" 必须提供 formula（公式，如 =range(2010,2012)）`);
    }
    const eFormula = dictionary.eFormula;
    const eBlock = eFormula == null || String(eFormula).trim() === ''
      ? ''
      : `\n<EFormulaDict>\n<![CDATA[${assertSafeCdata(String(eFormula), `${label} 显示公式`)}]]></EFormulaDict>`;
    return `<Dictionary class="com.fr.data.impl.FormulaDictionary">
<FormulaDict>
<![CDATA[${assertSafeCdata(String(formula), `${label} 公式`)}]]></FormulaDict>${eBlock}
</Dictionary>`;
  }
  return `<Dictionary class="com.fr.data.impl.CustomDictionary">
<CustomDictAttr>
${(items || []).map((it) => `<Dict key="${escapeXmlAttr(String(it.key ?? it.value))}" value="${escapeXmlAttr(String(it.value ?? it.key))}"/>`).join('\n')}
</CustomDictAttr>
</Dictionary>`;
}

/** 读回自定义字典项（属性顺序无关；<Dict …/> 只取 key/value） */
function readCustomDictItems(b) {
  return [...b.matchAll(/<Dict\b([^>]*)\/>/g)].map((m) => ({
    key: (m[1].match(/\bkey="([^"]*)"/) || [])[1] ?? null,
    value: (m[1].match(/\bvalue="([^"]*)"/) || [])[1] ?? null,
  }));
}

/** 读回公式字典两段（FormulaDict=值公式 / EFormulaDict=显示公式；缺块即 null，容忍空 CDATA 形态） */
function readFormulaParts(b) {
  const pick = (tag) => {
    const m = b.match(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>[\\s\\S]*?</${tag}>`));
    return m ? m[1] : null;
  };
  return { formula: pick('FormulaDict'), eFormula: pick('EFormulaDict') };
}

/** 字典块摘要（整块换类型时回显 before/after 用：kind + 该类型的关键字段） */
function dictBlockSnapshot(b) {
  const cls = (/<Dictionary class="([^"]+)"/.exec(b) || [])[1] ?? null;
  const kind = cls == null ? null
    : /CustomDictionary/.test(cls) ? 'custom'
      : /TableDataDictionary/.test(cls) ? 'table'
        : /DatabaseDictionary/.test(cls) ? 'db'
          : /FormulaDictionary/.test(cls) ? 'formula'
            : cls.split('.').pop();
  const out = { kind };
  if (kind === 'custom') out.items = readCustomDictItems(b);
  else if (kind === 'table') {
    out.dsName = (b.match(/<Name>\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*<\/Name>/) || [])[1] ?? null;
    out.kiName = (b.match(/<FormulaDictAttr\b[^>]*\bkiName="([^"]*)"/) || [])[1] ?? null;
    out.viName = (b.match(/<FormulaDictAttr\b[^>]*\bviName="([^"]*)"/) || [])[1] ?? null;
  } else if (kind === 'db') {
    out.table = (b.match(/<DBDictAttr\b[^>]*\btableName="([^"]*)"/) || [])[1] ?? null;
    out.connection = (b.match(/<DatabaseName>\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*<\/DatabaseName>/) || [])[1] ?? null;
  } else if (kind === 'formula') {
    Object.assign(out, readFormulaParts(b));
  }
  return out;
}

/**
 * 字典块【原位】改写（单一实现，供 updateCellDictionary 与 updateParameterWidget 共用）：
 * 只改 <Dictionary>…</Dictionary> 内的目标字段，块外字节一律不动。dictionary != null（整块换类型）
 * 走调用方的 dictionaryXml 路径，本函数只处理逐字段原位改（items / kiName+viName+table / formula+eFormula）。
 * 返回 { block, mode }：mode ∈ none|update|repair。
 */
function editDictBlockInPlace({ block, dOpenTag, wantKi, wantVi, wantTable, wantItems, wantFormula, wantEFormula, fn, where }) {
  const isCustom = /CustomDictionary/.test(dOpenTag);
  const isTable = /TableDataDictionary/.test(dOpenTag);
  const isFormula = /FormulaDictionary/.test(dOpenTag);
  if (!isCustom && !isTable && !isFormula) {
    throw new Error(`${fn}: ${where} 仅支持 CustomDictionary（自定义项，用 items 改）、TableDataDictionary（取数表字典，用 kiName/viName/table 改）与 FormulaDictionary（公式字典，用 formula/eFormula 改），当前形态 ${dOpenTag.slice(0, 90)}；其它字典类型请用 dictionary:{type} 整块替换（table=数据集字典 / db=数据库表字典 / custom=自定义项 / formula=公式字典）`);
  }
  if (isCustom && (wantKi != null || wantVi != null || wantTable != null || wantFormula != null || wantEFormula != null)) {
    throw new Error(`${fn}: ${where} 是 CustomDictionary（自定义字典），不接受 kiName/viName/table/公式；改字典项请传 items:[{key,value}]，或传 dictionary:{type:'table'|'db'|'formula'} 整块替换`);
  }
  if (isTable && (wantItems != null || wantFormula != null || wantEFormula != null)) {
    throw new Error(`${fn}: ${where} 是 TableDataDictionary（取数表字典），不接受 items/公式；改实际值列/显示值列/取数表名请传 kiName/viName/table，或传 dictionary 整块替换`);
  }
  if (isFormula && (wantItems != null || wantKi != null || wantVi != null || wantTable != null)) {
    throw new Error(`${fn}: ${where} 是 FormulaDictionary（公式字典），不接受 items/kiName/viName/table；改公式请传 formula/eFormula，或传 dictionary:{type:'formula',...} 整块替换`);
  }
  let mode = 'none';
  // 替换文本一律用**函数式替换**（() => 文本）：字符串式会把替换文本里的 `$$`/`$&`/`$'`/`` $` ``
  // 当特殊序列 —— `$$` 静默吃掉一个 `$`（官方公式普遍含 `$$$`，如 =$$$+'年'）；`$&` 会把**匹配到的
  // 子串**注入替换结果（曾实测 fontName="A$&B" 把 </InnerWidget> 注进属性值，产出 XML 非法但
  // isError=false、validate 漏报）。M117 该约定只落到字典路，M117-r2 已铺开到 lib/** 与 server.js，
  // 由 test/replace-injection.test.js 扫描守卫；仅"确认不可达"的点在测试白名单里逐条豁免并写明理由。
  if (isCustom) {
    // 整表替换 <CustomDictAttr> 的内容（幂等）。空数组 = 清空字典项 → 官方空字典形态 <CustomDictAttr>\n</CustomDictAttr>。
    // 注意：items 是整表替换，若原 <Dict> 带其它属性（官方样本只有 key/value）不做保留。
    const cda = block.match(/<CustomDictAttr\b[^>]*>([\s\S]*?)<\/CustomDictAttr>/);
    if (!cda) throw new Error(`${fn}: CustomDictionary 内无 <CustomDictAttr>（非标准形态，拒绝改写）`);
    const inner = (wantItems || []).length
      ? `\n${wantItems.map((it) => `<Dict key="${escapeXmlAttr(it.key)}" value="${escapeXmlAttr(it.value)}"/>`).join('\n')}\n`
      : '\n';
    const next = `<CustomDictAttr>${inner}</CustomDictAttr>`;
    if (cda[0] !== next) { block = block.replace(cda[0], () => next); mode = 'update'; }
  } else if (isTable) {
    const fTag = block.match(/<FormulaDictAttr\b[^>]*\/>/);
    if (fTag) {
      let nt = fTag[0];
      if (wantKi != null) nt = nt.replace(/\bkiName="[^"]*"/, () => `kiName="${escapeXmlAttr(wantKi)}"`);
      if (wantVi != null) nt = nt.replace(/\bviName="[^"]*"/, () => `viName="${escapeXmlAttr(wantVi)}"`);
      if (nt !== fTag[0]) { block = block.replace(fTag[0], () => nt); mode = 'update'; }
    } else if (wantKi != null && wantVi != null) {
      // 修复模式：Dictionary 在但 FormulaDictAttr 缺失（即 V3-historical-commit 误删形态），补回整行。
      const ins = `<FormulaDictAttr kiName="${escapeXmlAttr(wantKi)}" viName="${escapeXmlAttr(wantVi)}"/>\n`;
      block = block.replace(dOpenTag, () => `${dOpenTag}\n${ins}`);
      mode = 'repair';
    } else if (wantKi != null || wantVi != null) {
      throw new Error(`${fn}: 该 Dictionary 缺 <FormulaDictAttr>（疑似此前误删），补回需同时传 kiName+viName`);
    }
    if (wantTable != null) {
      const nm = block.match(/<Name>\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*<\/Name>/);
      if (!nm) throw new Error(`${fn}: Dictionary 内无取数表 <Name>（非标准 TableDataDictionary 形态，拒绝改写）`);
      if (nm[1] !== wantTable) {
        block = block.replace(nm[0], () => `<Name>\n<![CDATA[${wantTable}]]></Name>`);
        if (mode === 'none') mode = 'update';
      }
    }
  } else {
    // FormulaDictionary：FormulaDict 必在（官方 37/37 都有）；EFormulaDict 可缺省/空（清空=删块，回到官方仅有 FormulaDict 形态）。
    if (wantFormula != null) {
      const f = block.match(/<FormulaDict\b[^>]*>[\s\S]*?<\/FormulaDict>/);
      if (!f) throw new Error(`${fn}: ${where} 的 FormulaDictionary 内无 <FormulaDict>（非标准形态，拒绝改写；整块重建请传 dictionary:{type:'formula',...}）`);
      const next = `<FormulaDict>\n<![CDATA[${assertSafeCdata(wantFormula, '公式')}]]></FormulaDict>`;
      if (f[0] !== next) { block = block.replace(f[0], () => next); mode = 'update'; }
    }
    if (wantEFormula != null) {
      const e = block.match(/<EFormulaDict\b[^>]*>[\s\S]*?<\/EFormulaDict>/);
      if (String(wantEFormula).trim() === '') {
        if (e) {
          const idx = block.indexOf(e[0]);
          const head = block.slice(0, idx);
          block = (head.endsWith('\n') ? head.slice(0, -1) : head) + block.slice(idx + e[0].length);
          mode = 'update';
        }
      } else {
        const next = `<EFormulaDict>\n<![CDATA[${assertSafeCdata(wantEFormula, '显示公式')}]]></EFormulaDict>`;
        if (e) {
          if (e[0] !== next) { block = block.replace(e[0], () => next); mode = 'update'; }
        } else {
          const f = block.match(/<FormulaDict\b[^>]*>[\s\S]*?<\/FormulaDict>/);
          if (!f) throw new Error(`${fn}: ${where} 的 FormulaDictionary 内无 <FormulaDict>（无法定位 <EFormulaDict> 插入点）`);
          block = block.replace(f[0], () => `${f[0]}\n${next}`);
          mode = 'update';
        }
      }
    }
  }
  return { block, mode };
}

// ---------------- M111 单元格跨行跨列（合并 / 拆分） ----------------
// 背景：官方 1550 份实测 7142 个跨行跨列格（cs 6702 / rs 1576 / cs+rs 1136），而 cpt-mcp 此前只能在
// add_cell 时给【新格】设 colspan/rowspan —— 已有格要改跨列（如"字典 sheet 标题没跨列"）只能
// delete_cell + add_cell 重建（会丢监听/条件属性/扩展父格引用等）。本工具就地改 <C> 开标签的 cs/rs。
// 不变量（官方实测）：被覆盖的位置不得再有同表 <C>（7142 例中仅 53 例越界，且全部落在
// 「聚合报表 PolyWorkSheet」这类特殊报表；普通工作表 0 例）。本工具按此强校验，冲突即拒绝并列出坐标。
export function setCellSpan(path, { column, row, colspan, rowspan, sheet } = {}) {
  const c = Number(column), r = Number(row);
  if (!Number.isInteger(c) || c < 0 || !Number.isInteger(r) || r < 0) throw new Error(`单元格坐标非法: (${column},${row})`);
  if (colspan === undefined && rowspan === undefined) {
    throw new Error('setCellSpan: 至少传 colspan 或 rowspan（正整数=合并跨度；null 或 1=取消该方向合并）');
  }
  const norm = (v, what) => {
    if (v === null || v === undefined) return 1;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1 || n > 1000) {
      throw new Error(`setCellSpan: ${what} 必须是 1-1000 的整数，或 null/1 取消合并（当前 ${JSON.stringify(v)}）`);
    }
    return n;
  };
  const { raw } = load(path);
  // 多表模板必须显式给 sheet：同坐标格在多表并存时缺省必错表（与 M91 locateCell 同口径）
  if (sheet == null && sheetBlocks(raw).length > 1) {
    throw new Error('setCellSpan: 多工作表模板必须显式提供 sheet（表索引 0 起或表名），否则可能改错表');
  }
  const [cb] = locateCell(raw, c, r, `单元格(${c},${r})`, sheet);
  const gt = raw.indexOf('>', cb);
  if (gt < 0) throw new Error(`setCellSpan: 单元格(${c},${r}) 的 <C> 开标签未闭合`);
  let head = raw.slice(cb, gt + 1);
  const cur = (k) => { const m = head.match(new RegExp(`\\b${k}="(\\d+)"`)); return m ? Number(m[1]) : 1; };
  const before = { colspan: cur('cs'), rowspan: cur('rs') };
  const cs = colspan === undefined ? before.colspan : norm(colspan, 'colspan');
  const rs = rowspan === undefined ? before.rowspan : norm(rowspan, 'rowspan');
  if (cs === before.colspan && rs === before.rowspan) {
    return { action: 'set_cell_span', cell: `${c},${r}`, sheet: sheet ?? 0, mode: 'none', before, after: before, bytes: Buffer.byteLength(raw, 'utf8'), hint: '目标跨行跨列与现状一致，未改动。' };
  }
  // 覆盖区冲突检查（同表）：被覆盖位置不得已有 <C>，否则是重叠合并（设计器/引擎不接受的形态）
  const conflicts = [];
  for (const cell of cellsInSheet(raw, sheet)) {
    const dc = Number(cell.c) - c, dr = Number(cell.r) - r;
    if (dc === 0 && dr === 0) continue;
    if (dc >= 0 && dc < cs && dr >= 0 && dr < rs) conflicts.push(`${cell.c},${cell.r}`);
  }
  if (conflicts.length > 0) {
    throw new Error(`setCellSpan: 目标区域覆盖 ${conflicts.length} 个已有单元格（${conflicts.slice(0, 8).map((x) => `(${x})`).join(' ')}${conflicts.length > 8 ? ' …' : ''}）；合并前请先 delete_cell 这些格（或用 delete_cell_range 整段处理），否则会形成重叠合并`);
  }
  // cs/rs 需支持"插入缺失属性 / 删除属性"，replaceAttr 只做替换，故在此自行处理
  const applyAttr = (h, key, value) => {
    const re = new RegExp(`\\s*\\b${key}="[^"]*"`);
    if (value <= 1) return re.test(h) ? h.replace(re, '') : h;
    if (re.test(h)) return h.replace(re, ` ${key}="${value}"`);
    return `${h.slice(0, h.length - 1)} ${key}="${value}">`;
  };
  head = applyAttr(head, 'cs', cs);
  head = applyAttr(head, 'rs', rs);
  const out = raw.slice(0, cb) + head + raw.slice(gt + 1);
  save(path, out);
  return {
    action: 'set_cell_span', cell: `${c},${r}`, sheet: sheet ?? 0, mode: 'update',
    before, after: { colspan: cs, rowspan: rs }, bytes: Buffer.byteLength(out, 'utf8'),
    hint: `跨行跨列已更新（cs ${before.colspan}→${cs} / rs ${before.rowspan}→${rs}），内容/控件/绑定/监听/条件属性其余字节原样保留。`,
  };
}

// ---------------- M91 单元格下拉字典 ----------------
// 背景：V3 双通道平齐（sheet1-C5 outer_id→spec_id）时没有结构化字典入口，
// 只能裸改 XML，结果把 sheet2-C15 的 <FormulaDictAttr kiName="spec_id" viName="spec_id"/>
// 整行删掉（V3 commit historical-commit 自证"本次工具误删"），且校验没拦下。
// 本工具只动 Dictionary 块内三处：FormulaDictAttr 的 kiName/viName、TableDataDictAttr 的
// 取数表名（<Name> CDATA），其余字节原样保留；返回改前改后回显（before/after），调用方
// 再用 validate_cpt 验收。幂等：值一致时 mode=none 不写文件。
export function updateCellDictionary(path, { column, row, sheet, kiName, viName, table, items, dictionary, formula, eFormula } = {}) {
  if (column == null || row == null) throw new Error('updateCellDictionary: 必须提供 column 与 row（均从 0 起）');
  // sheet 必填（不设缺省）：多表模板同坐标格并存时缺省必错表（M91 locateCell 同理），此处直接强制显式。
  if (sheet == null) throw new Error('updateCellDictionary: 必须显式提供 sheet（表索引 0 起或表名；多表模板同坐标格易改错通道，禁止缺省）');
  const wantKi = kiName != null ? String(kiName) : null;
  const wantVi = viName != null ? String(viName) : null;
  const wantTable = table != null ? String(table) : null;
  // M117 公式数据字典（FormulaDictionary）：formula=值公式；eFormula=显示公式（'' = 清空/删除 EFormulaDict 块）。
  const wantFormula = formula != null ? String(formula) : null;
  const wantEFormula = eFormula === undefined || eFormula === null ? null : String(eFormula);
  // M108：补上 CustomDictionary 的写入侧。M96 的 get_cell_dictionary 一直能读自定义项，
  // 但写侧只支持 TableDataDictionary —— 空自定义字典（如"姓名下拉 0 项"）只能 delete+add 重建控件，
  // 与 M106 的绑定落点同一类"就地改不了"缺口。items 为整表替换（幂等：一致则 mode=none）。
  let wantItems = null;
  if (items !== undefined) {
    if (!Array.isArray(items)) throw new Error('updateCellDictionary: items 必须是 [{key,value}] 数组（整表替换）');
    for (const [i, it] of items.entries()) {
      if (!it || typeof it !== 'object' || Array.isArray(it)) throw new Error(`updateCellDictionary: items[${i}] 必须是 {key,value} 对象`);
      for (const f of ['key', 'value']) {
        const v = it[f];
        if (v == null || String(v).trim() === '') throw new Error(`updateCellDictionary: items[${i}].${f} 不能为空`);
        if (/[<>&"']/.test(String(v))) throw new Error(`updateCellDictionary: items[${i}].${f} 含 XML 非法字符 <>&"'`);
      }
    }
    wantItems = items.map((it) => ({ key: String(it.key), value: String(it.value) }));
  }
  if (wantKi == null && wantVi == null && wantTable == null && wantItems == null && wantFormula == null && wantEFormula == null && dictionary == null) {
    throw new Error('updateCellDictionary: kiName/viName/table/items/formula/eFormula/dictionary 至少传一个（取数表字典改实际值列/显示值列/取数表名；自定义字典改字典项用 items；公式字典改公式用 formula/eFormula；整块换字典类型用 dictionary）');
  }
  // M109：dictionary = 整块替换（可换类型，如"自定义固定项 → 绑数据集"），与逐字段改写二选一
  if (dictionary != null) {
    if (typeof dictionary !== 'object' || Array.isArray(dictionary)) throw new Error('updateCellDictionary: dictionary 必须是对象');
    if (wantKi != null || wantVi != null || wantTable != null || wantItems != null || wantFormula != null || wantEFormula != null) {
      throw new Error('updateCellDictionary: dictionary（整块替换）与 kiName/viName/table/items/formula/eFormula 不能同时传，二选一');
    }
    const t = String(dictionary.type ?? '');
    if (!['table', 'db', 'custom', 'formula'].includes(t)) {
      throw new Error(`updateCellDictionary: dictionary.type 只能是 table（数据集字典）/db（数据库表字典）/custom（自定义项）/formula（公式数据字典），收到 ${JSON.stringify(dictionary.type)}`);
    }
    if (t === 'table' && !String(dictionary.dsName ?? '').trim()) {
      throw new Error('updateCellDictionary: dictionary.type="table" 必须提供 dsName（数据集名，须已用 add_dataset 声明）');
    }
    if (t === 'db' && !String(dictionary.table ?? '').trim()) {
      throw new Error('updateCellDictionary: dictionary.type="db" 必须提供 table（数据库表名）');
    }
    if (t === 'formula' && !String(dictionary.formula ?? '').trim()) {
      throw new Error('updateCellDictionary: dictionary.type="formula" 必须提供 formula（值公式，如 =range(2010,2012)）');
    }
    // type=custom 的字典项校验（与顶层 items 同规则）
    if (dictionary.items !== undefined) {
      if (!Array.isArray(dictionary.items)) throw new Error('updateCellDictionary: dictionary.items 必须是 [{key,value}] 数组');
      for (const [i, it] of dictionary.items.entries()) {
        if (!it || typeof it !== 'object' || Array.isArray(it)) throw new Error(`updateCellDictionary: dictionary.items[${i}] 必须是 {key,value} 对象`);
        for (const f of ['key', 'value']) {
          const v = it[f];
          if (v == null || String(v).trim() === '') throw new Error(`updateCellDictionary: dictionary.items[${i}].${f} 不能为空`);
          if (/[<>&"']/.test(String(v))) throw new Error(`updateCellDictionary: dictionary.items[${i}].${f} 含 XML 非法字符 <>&"'`);
        }
      }
    }
  }
  for (const [k, v] of [['kiName', wantKi], ['viName', wantVi], ['table', wantTable]]) {
    if (v != null && v.trim() === '') throw new Error(`updateCellDictionary: ${k} 不接受空字符串（清空字典请用 add_cell 重建控件）`);
    if (v != null && /[<>&"']/.test(v)) throw new Error(`updateCellDictionary: ${k} 含 XML 非法字符 <>&"'（字段名非法）`);
  }
  if (wantTable != null) assertSafeCdata(wantTable, '取数表名');
  // formula 不接受空串（空公式无意义）；eFormula 允许空串 = 清空显示公式（删除 EFormulaDict，回官方仅有 FormulaDict 形态）
  if (wantFormula != null) {
    if (wantFormula.trim() === '') throw new Error('updateCellDictionary: formula 不接受空字符串（公式字典的值公式必填；清空字典请用 dictionary:{type:"custom"} 整块替换）');
    assertSafeCdata(wantFormula, '公式');
  }
  if (wantEFormula != null && wantEFormula.trim() !== '') assertSafeCdata(wantEFormula, '显示公式');

  const { raw, parsed } = load(path);
  const [cb, ce] = locateCell(raw, column, row, `单元格(${column},${row})`, sheet);
  const seg = raw.slice(cb, ce);
  const dOpen = seg.match(/<Dictionary\b[^>]*>/);
  if (!dOpen) throw new Error(`updateCellDictionary: 单元格(${column},${row}) 内无 <Dictionary>（该格不是下拉字典格；新建字典请用 add_cell(widget=comboBox/comboCheckBox) 重建控件）`);
  const isCustom = /CustomDictionary/.test(dOpen[0]);
  const isTable = /TableDataDictionary/.test(dOpen[0]);
  const isFormula = /FormulaDictionary/.test(dOpen[0]);
  if (dictionary == null && !isCustom && !isTable && !isFormula) {
    throw new Error(`updateCellDictionary: 仅支持 CustomDictionary（自定义项，用 items 改）、TableDataDictionary（取数表字典，用 kiName/viName/table 改）与 FormulaDictionary（公式字典，用 formula/eFormula 改），当前形态 ${dOpen[0].slice(0, 90)}；其它字典类型请用 dictionary:{type} 整块替换（table=数据集字典 / db=数据库表字典 / custom=自定义项 / formula=公式字典）`);
  }
  if (dictionary == null && isCustom && (wantKi != null || wantVi != null || wantTable != null || wantFormula != null || wantEFormula != null)) {
    throw new Error(`updateCellDictionary: 单元格(${column},${row}) 是 CustomDictionary（自定义字典），不接受 kiName/viName/table/公式；改字典项请传 items:[{key,value}]（可先用 get_cell_dictionary 读回现有项），或传 dictionary:{type:'table'|'db'|'formula'} 整块替换`);
  }
  if (dictionary == null && isTable && (wantItems != null || wantFormula != null || wantEFormula != null)) {
    throw new Error(`updateCellDictionary: 单元格(${column},${row}) 是 TableDataDictionary（取数表字典），不接受 items/公式；改实际值列/显示值列/取数表名请传 kiName/viName/table，或传 dictionary 整块替换`);
  }
  if (dictionary == null && isFormula && (wantItems != null || wantKi != null || wantVi != null || wantTable != null)) {
    throw new Error(`updateCellDictionary: 单元格(${column},${row}) 是 FormulaDictionary（公式字典），不接受 items/kiName/viName/table；改公式请传 formula/eFormula，或传 dictionary:{type:'formula',...} 整块替换`);
  }
  const dStart = cb + dOpen.index;
  const dClose = raw.indexOf('</Dictionary>', dStart);
  if (dClose < 0 || dClose > ce) throw new Error(`updateCellDictionary: 单元格(${column},${row}) 的 <Dictionary> 未闭合`);
  const dEnd = dClose + '</Dictionary>'.length;
  let block = raw.slice(dStart, dEnd);

  // M109：整块替换字典（可换类型）。场景：「单元格配置下拉单选控件后可以绑定数据集」——
  // 把已有的自定义固定项下拉（如"节点 29 项"）就地改成数据集/数据库表字典，控件/绑定/样式/扩展全部原样保留。
  if (dictionary != null) {
    if (dictionary.type === 'table') assertDatasetExists(parsed, String(dictionary.dsName).trim(), '数据集字典');
    // type=custom 的项在 dictionary.items 上（与顶层 items 参数二选一，此处以 dictionary.items 为准）
    const dictItems = dictionary.type === 'custom' ? (dictionary.items ?? []) : items;
    const nextBlock = dictionaryXml({ dictionary, items: dictItems, label: `单元格(${column},${row})` });
    if (nextBlock === block) {
      return { action: 'update_cell_dictionary', cell: `${column},${row}`, sheet, mode: 'none', before: dictBlockSnapshot(block), after: dictBlockSnapshot(block), bytes: Buffer.byteLength(raw, 'utf8'), hint: '目标字典与现状一致，未改动。' };
    }
    const out = raw.slice(0, dStart) + nextBlock + raw.slice(dEnd);
    save(path, out);
    return {
      action: 'update_cell_dictionary', cell: `${column},${row}`, sheet, mode: 'replace',
      before: dictBlockSnapshot(block), after: dictBlockSnapshot(nextBlock), bytes: Buffer.byteLength(out, 'utf8'),
      hint: `字典已整块替换为 ${dictBlockSnapshot(nextBlock).kind}（控件/内容绑定/样式/扩展其余字节原样保留）。请用 get_cell_dictionary 或 validate_cpt 验收。`,
    };
  }
  const before = isCustom
    ? { class: 'CustomDictionary', items: readCustomDictItems(block) }
    : isFormula
      ? { class: 'FormulaDictionary', ...readFormulaParts(block) }
      : {
        ki: (block.match(/<FormulaDictAttr\b[^>]*\bkiName="([^"]*)"/) || [])[1] ?? null,
        vi: (block.match(/<FormulaDictAttr\b[^>]*\bviName="([^"]*)"/) || [])[1] ?? null,
        table: (block.match(/<Name>\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*<\/Name>/) || [])[1] ?? null,
      };

  // 原位逐字段改写走共用实现（单一来源，与 update_parameter_widget 同源）
  const edited = editDictBlockInPlace({
    block, dOpenTag: dOpen[0], wantKi, wantVi, wantTable, wantItems, wantFormula, wantEFormula,
    fn: 'updateCellDictionary', where: `单元格(${column},${row})`,
  });
  block = edited.block;
  const mode = edited.mode;
  const after = isCustom
    ? { class: 'CustomDictionary', items: readCustomDictItems(block) }
    : isFormula
      ? { class: 'FormulaDictionary', ...readFormulaParts(block) }
      : {
        ki: (block.match(/<FormulaDictAttr\b[^>]*\bkiName="([^"]*)"/) || [])[1] ?? null,
        vi: (block.match(/<FormulaDictAttr\b[^>]*\bviName="([^"]*)"/) || [])[1] ?? null,
        table: (block.match(/<Name>\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*<\/Name>/) || [])[1] ?? null,
      };
  if (mode === 'none') {
    return { action: 'update_cell_dictionary', cell: `${column},${row}`, sheet, mode, before, after, bytes: Buffer.byteLength(raw, 'utf8'), hint: '目标值与现状一致，未改动。' };
  }
  const out = raw.slice(0, dStart) + block + raw.slice(dEnd);
  save(path, out);
  return {
    action: 'update_cell_dictionary', cell: `${column},${row}`, sheet, mode, before, after, bytes: Buffer.byteLength(out, 'utf8'),
    hint: isCustom
      ? `自定义字典项已更新（${before.items.length} 项 → ${after.items.length} 项），控件/绑定/样式/扩展其余字节原样保留。请用 get_cell_dictionary 或 validate_cpt 验收。`
      : isFormula
        ? `公式字典已更新（FormulaDict ${before.formula} → ${after.formula} / EFormulaDict ${before.eFormula} → ${after.eFormula}），其余字节原样保留。请用 get_cell_dictionary 或 validate_cpt 验收。`
        : `字典已${mode === 'repair' ? '补回' : '更新'}（ki ${before.ki}→${after.ki} / vi ${before.vi}→${after.vi} / 表 ${before.table}→${after.table}），其余字节原样保留。请用 validate_cpt 验收结构。`,
  };
}

// ---------------- M96 单元格下拉字典读取 ----------------
// 背景：读半边一直空着——get_cells 不暴露 Dictionary 节点，diagnose 只报有/无，
// M91 写入口回显的前提是“已经知道格子字典是什么”。V3 规格下拉核对（47 选项之争）
// 被迫走“三重证据推定 + 求截图”。本工具一次返回字典正文（ki/vi/取数表/自定义项），
// sheet 必填（M91 同理：多表同坐标读错表同样误导）。只读，不改文件。
export function getCellDictionary(path, { column, row, sheet } = {}) {
  if (column == null || row == null) throw new Error('getCellDictionary: 必须提供 column 与 row（均从 0 起）');
  if (sheet == null) throw new Error('getCellDictionary: 必须显式提供 sheet（表索引 0 起或表名；多表模板同坐标格禁缺省，读错表同样误导排查）');
  const { raw } = load(path);
  const [cb, ce] = locateCell(raw, column, row, `单元格(${column},${row})`, sheet);
  const seg = raw.slice(cb, ce);
  const dOpen = seg.match(/<Dictionary\b[^>]*>/);
  if (!dOpen) {
    return {
      action: 'get_cell_dictionary', cell: `${column},${row}`, sheet, hasDictionary: false,
      kind: 'none', class: null, kiName: null, viName: null, table: null, items: [],
      hint: '该格无 <Dictionary>（不是下拉字典格）。下拉字典缺失会导致页面下拉为空，需要的话用 add_cell(widget=comboBox/comboCheckBox) 重建控件。',
    };
  }
  const cls = (dOpen[0].match(/\bclass="([^"]+)"/) || [])[1] ?? null;
  const dStart = cb + dOpen.index;
  const dClose = raw.indexOf('</Dictionary>', dStart);
  if (dClose < 0 || dClose > ce) throw new Error(`getCellDictionary: 单元格(${column},${row}) 的 <Dictionary> 未闭合`);
  const block = raw.slice(dStart, dClose + '</Dictionary>'.length);
  const base = {
    action: 'get_cell_dictionary', cell: `${column},${row}`, sheet, hasDictionary: true,
    class: cls, kiName: null, viName: null, table: null, items: [],
  };
  if (/TableDataDictionary/.test(dOpen[0])) {
    return {
      ...base, kind: 'table',
      kiName: (block.match(/<FormulaDictAttr\b[^>]*\bkiName="([^"]*)"/) || [])[1] ?? null,
      viName: (block.match(/<FormulaDictAttr\b[^>]*\bviName="([^"]*)"/) || [])[1] ?? null,
      table: (block.match(/<Name>\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*<\/Name>/) || [])[1] ?? null,
      hint: '取数表字典：下拉选项来自指定数据集，显示列=viName，实际值列=kiName。选项行数需连库实查（文件里无答案）。',
    };
  }
  if (/CustomDictionary/.test(dOpen[0])) {
    const items = [...block.matchAll(/<Dict\b[^>]*\bkey="([^"]*)"[^>]*\bvalue="([^"]*)"[^>]*\/>/g)]
      .map((m) => ({ key: m[1], value: m[2] }));
    return { ...base, kind: 'custom', items, hint: `自定义字典：共 ${items.length} 个固定选项（key=实际值，value=显示值）。` };
  }
  if (/DatabaseDictionary/.test(dOpen[0])) {
    const attr = (k) => (block.match(new RegExp(`<DBDictAttr\\b[^>]*\\b${k}="([^"]*)"`)) || [])[1] ?? null;
    return {
      ...base, kind: 'database',
      table: attr('tableName'), kiName: attr('kiName'), viName: attr('viName'),
      hint: '数据库直连字典：选项来自物理表（tableName），ki/vi 为列索引，实际值/显示值列名见 kiName/viName。',
    };
  }
  if (/FormulaDictionary/.test(dOpen[0])) {
    const { formula, eFormula } = readFormulaParts(block);
    return {
      ...base, kind: 'formula', formula, eFormula,
      hint: `公式数据字典（官方 37 块实证）：选项由公式算出 —— FormulaDict=${formula ?? '（缺失）'}；EFormulaDict（显示公式）=${eFormula ?? '（无，官方 25/37 仅有 FormulaDict 形态）'}。改公式请用 update_cell_dictionary 的 formula/eFormula，或 dictionary:{type:'formula',formula,eFormula}。`,
    };
  }
  return { ...base, kind: 'unknown', hint: `未识别的字典形态（${dOpen[0].slice(0, 80)}），原文未改动；请贴出该块人工核对。` };
}

// ---------------- M52 报告级增改查 ----------------

/** 定位第 idx 个 TableData 块（按 name 精确匹配），返回 [start, end, openTagLen] */
function locateTableData(raw, name, idx = 0) {
  const safeName = escapeXmlAttr(name);
  const openRe = new RegExp(`<TableData[^>]*\\bname="${safeName}"[^>]*>`);
  const starts = findAll(raw, '<TableData ');
  let count = 0;
  for (const s of starts) {
    const gt = raw.indexOf('>', s);
    const open = raw.slice(s, gt < 0 ? s + 200 : gt + 1);
    if (openRe.test(open)) {
      if (count === idx) {
        // 兼容自闭合 <TableData .../> 与开闭对
        const trimmed = open.trim();
        if (trimmed.endsWith('/>')) return [s, gt + 1, gt + 1 - s];
        const [b, e] = blockRange(raw, s, '<TableData', '</TableData>');
        return [b, e, open.length];
      }
      count++;
    }
  }
  throw new Error(`定位失败：未找到数据集 ${name}`);
}

/**
 * 在指定工作表的 Report 块内 upsert/删除任意子节点。
 * 解决 update_cell 只能改单元格级 CDATA、无法动 Report 级（Listener/TopJS/分页/标题行高等）的缺口。
 *
 * 通用语义: 给定 `nodeName`（如 "Listener"/"ReportPageAttr"/"FROZENColumn"/"ReportUI"），
 *   - 有 `xmlBody` → 替换/插入该子节点
 *   - 无 `xmlBody` → 删除该子节点（含其文本/属性匹配；attributes 可进一步限定）
 * `xmlBody` 会做 escapeXmlAttr/assertSafeCdata 但不会做整体结构校验——是"低层结构编辑"工具，
 *   复杂的合成（如完整带 CDATA 的 Listener 块）请用 set_report_listener。
 */
/**
 * Report 块定位域：报表级结构化工具（setReportListener/setReportJs）只应在 Report 块内定位，
 * 避免全文扫描误伤 WorkBook 级 ReportWebAttr/WebWriteContent 里同标签的填报监听
 * （ReportWebAttr 排在 Report 块之前，全文第一个 <Listener> 会命中填报监听而非报表监听）。
 */
function reportScope(raw, sheet) {
  if (sheet != null) return locateSheet(raw, sheet);
  const blocks = sheetBlocks(raw);
  if (blocks.length === 0) throw new Error('定位失败：未找到工作表（无 Report 块）');
  return blocks[0];
}

export function updateReportNode(path, {
  nodeName, attributes, xmlBody, sheet, scope, parent, index,
  replaceAttributes = false, createIfMissing = false,
} = {}) {
  if (!nodeName || typeof nodeName !== 'string') throw new Error('updateReportNode: 必须提供 nodeName（子节点标签名，如 "Listener"）');
  // 审计补洞：nodeName 直拼进 RegExp 与输出 XML，非标签字符即正则/XML 双注入（`.*` 误匹配首个 `<`、`Foo><X` 注入任意标签）。
  // schema 层已有同 pattern 校验，这里再守一道（直调 lib 的内部调用同样受益）。
  if (!/^[A-Za-z_][\w.-]*$/.test(nodeName)) throw new Error(`updateReportNode: 非法 nodeName "${nodeName}"（必须是合法 XML 标签名）`);
  // P1-1 预检：attributes 键直拼进匹配正则与输出 XML，非标签字符即注入/写坏文件；先拦后写（直调 lib 同样受益）
  if (attributes != null) {
    if (!attributes || typeof attributes !== 'object' || Array.isArray(attributes)) throw new Error('updateReportNode: attributes 必须是属性名→属性值对象');
    for (const key of Object.keys(attributes)) {
      if (!/^[A-Za-z_][\w.:-]*$/.test(key)) throw new Error(`updateReportNode: 非法 attribute 名 "${key}"（必须是合法 XML 属性名）`);
    }
  }
  if (parent != null && (typeof parent !== 'string' || !/^[A-Za-z_][\w.-]*$/.test(parent))) {
    throw new Error(`updateReportNode: 非法 parent "${parent}"（必须是合法 XML 标签名，如 "ReportWebAttr"）`);
  }
  const escapeRegExp = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const { raw } = load(path);
  // scope='report'：限定 Report 块内（报表级结构化工具用，避免误伤 WebWriteContent 的填报监听）；
  // 默认（undefined）：全文（低层 update_report_node 工具 / setWebWriteExtras 建 WorkBook 级节点需此语义）。
  const b = scope === 'report'
    ? reportScope(raw, sheet)
    : (sheet == null ? { start: 0, end: raw.length } : locateSheet(raw, sheet));

  // parent 作用域（2026-10-30 修，sandbox4/v1 实测缺口）：
  // 旧行为里 parent 只在"没找到节点"时用于插入，查找仍是全文件口径 —— 想给唯一
  // <SubmitVisitor> 补 <Parameters> 时，被全文件 32 个 <Parameters> 误拦且没有办法，
  // 被迫用探针模板/手工改 XML。现在 parent 把「查找 + 插入」都收进该父容器：
  //   · 父容器必须唯一（多候选请传 sheet 缩范围，不猜）；
  //   · 父容器内找到同名节点 → 替换；找不到 → 插到父容器末尾。
  let searchStart = b.start;
  let searchEnd = b.end;
  let parentInsertAt = null;
  if (parent != null) {
    const pStarts = findAll(raw, `<${parent}`).filter((i) => {
      const ch = raw[i + parent.length + 1];
      return ch != null && /[\s/>]/.test(ch) && i >= b.start && i < b.end;
    });
    if (pStarts.length === 0) throw new Error(`updateReportNode: 未找到父容器 <${parent}>（用于插入 <${nodeName}>）`);
    if (pStarts.length > 1) {
      throw new Error(`updateReportNode: 父容器 <${parent}> 有 ${pStarts.length} 个候选，无法确定 <${nodeName}> 放进哪一个（禁止静默命中第一个）。纠正：① 传 sheet 缩小范围；② 父容器也重复时请改用专用工具（如 update_fill_submit 的 parameters）或先人工收口结构。`);
    }
    const pStart = pStarts[0];
    const pOpenEnd = raw.indexOf('>', pStart);
    if (pOpenEnd < 0) throw new Error(`updateReportNode: 父容器 <${parent}> 开标签不完整`);
    if (raw.slice(pStart, pOpenEnd + 1).trim().endsWith('/>')) throw new Error(`updateReportNode: 父容器 <${parent}> 是自闭合节点，无法插入子节点`);
    const pClose = raw.indexOf(`</${parent}>`, pOpenEnd + 1);
    if (pClose < 0) throw new Error(`updateReportNode: 父容器 <${parent}> 未闭合（缺失 </${parent}>）`);
    searchStart = pOpenEnd + 1;
    searchEnd = pClose;
    parentInsertAt = pClose;
  }

  // 在作用域内定位 nodeName 的全部候选（绝对偏移；attributes 提供时按开标签属性过滤）
  const starts = findAll(raw, `<${nodeName}`).filter((i) => {
    const ch = raw[i + nodeName.length + 1];
    return ch != null && /[\s/>]/.test(ch) && i >= searchStart && i < searchEnd;
  });
  const candidates = [];
  for (const s of starts) {
    const ge = raw.indexOf('>', s);
    if (ge < 0) continue;
    const head = raw.slice(s, ge + 1);
    if (attributes) {
      const allMatch = Object.entries(attributes).every(([k, v]) => new RegExp(`\\b${escapeRegExp(k)}="${escapeRegExp(String(v)).replace(/"/g, '\\"')}"`).test(head));
      if (!allMatch) continue;
    }
    candidates.push(s);
  }
  // index：多候选且属性无法区分时按序号选（2026-10-23 补：属性完全相同的 7 个 <Widget> 按钮节点
  // 此前除属性收敛外无第二选择子 → 单按钮不可达，只能手工改 XML）。index 是显式意图，故放行歧义拒绝。
  let target = -1;
  if (index != null) {
    const i = Number(index);
    if (!Number.isInteger(i) || i < 0) throw new Error(`updateReportNode: index 必须是非负整数（0 起），收到 ${index}`);
    if (i >= candidates.length) {
      throw new Error(`updateReportNode: index=${i} 越界（<${nodeName}>${attributes ? '（属性匹配）' : ''} 在${parent ? `父容器 <${parent}>` : sheet == null ? '全文件' : `工作表[${sheet}]`}内共 ${candidates.length} 个候选，可用 0..${candidates.length - 1}）`);
    }
    target = candidates[i];
  } else if (candidates.length) {
    target = candidates[0];
  }

  // 【M91 防误删】未传 sheet 且全文件候选多个 → 拒绝静默命中第一个（与 M89 同口径、M91 locateCell 同口径）。
  // 前车：update_report_node 全文按 nodeName 取首个，多表/多块模板（V3 双通道各表的 Listener、
  // 各表 TopJS）极易改错表；且 scope='report' 缺省只框首表，框内计数会漏掉跨表重复，故此处按全文件计数。
  // attributes 能把全文件候选收到唯一时放行，否则必须显式传 sheet 缩范围。
  // parent 已把范围收进唯一父容器，不再叠加全文件歧义拦截。
  if (parent == null && sheet == null && index == null) {
    // findAll 自带 CDATA/注释排除（JS 字符串里拼 XML 文本不计入），再按标签边界过滤。
    const hits = findAll(raw, `<${nodeName}`).filter((i) => {
      const ch = raw[i + nodeName.length + 1];
      return ch != null && /[\s/>]/.test(ch);
    });
    let n = 0;
    for (const idx of hits) {
      const ge = raw.indexOf('>', idx);
      if (ge < 0) continue;
      const head = raw.slice(idx, ge + 1);
      if (attributes) {
        const allMatch = Object.entries(attributes).every(([k, v]) => new RegExp(`\\b${escapeRegExp(k)}="${escapeRegExp(String(v)).replace(/"/g, '\\"')}"`).test(head));
        if (!allMatch) continue;
      }
      n++;
    }
    if (n > 1) {
      throw new Error(`updateReportNode: 未传 sheet 时全文件 <${nodeName}>${attributes ? '（属性匹配）' : ''}有 ${n} 个候选，无法确定改哪一个（禁止静默命中第一个）。纠正：① 传 sheet=表索引（0 起）或表名缩小范围；② 传 attributes 精确匹配开标签属性（如 {class:"com.fr.form.ui.CustomToolBarButton"} 仍有多项时）；③ 三者都不足以唯一时传 index=序号（0 起，按文档顺序）显式指定第几个。`);
    }
  }
  // parent 内多候选且未给 index：同样不猜（例如父容器里已有多段同名子节点）
  if (parent != null && index == null && candidates.length > 1) {
    throw new Error(`updateReportNode: 父容器 <${parent}> 内 <${nodeName}> 有 ${candidates.length} 个候选，无法确定改哪一个（禁止静默命中第一个）。传 index=序号（0 起）显式指定。`);
  }

  if (xmlBody == null) {
    // 删除模式
    if (target < 0) throw new Error(`updateReportNode: 未找到 <${nodeName}>${attributes ? ' (属性匹配)' : ''}（${parent ? `父容器 <${parent}> 内` : `sheet ${sheet ?? 0}`}）`);
    const ge = raw.indexOf('>', target);
    if (raw.slice(target, ge + 1).trim().endsWith('/>')) {
      // 自闭合
      const out = raw.slice(0, target) + raw.slice(ge + 1);
      save(path, out);
      return { action: 'update_report_node', nodeName, mode: 'delete', sheet: sheet ?? 0, bytes: Buffer.byteLength(out, 'utf8') };
    }
    // 开闭对（边界感知：nodeName="Widget" 不会被 <WidgetAttr 带偏）
    const [sb, se] = nodeBlockRange(raw, target, nodeName);
    const out = raw.slice(0, sb) + raw.slice(se);
    save(path, out);
    return { action: 'update_report_node', nodeName, mode: 'delete', sheet: sheet ?? 0, bytes: Buffer.byteLength(out, 'utf8') };
  }

  // upsert 模式
  const explicitAttrs = attributes
    ? ' ' + Object.entries(attributes).map(([k, v]) => `${k}="${escapeXmlAttr(String(v))}"`).join(' ')
    : '';
  const selfClose = !xmlBody.trim() ? '/>' : '>';
  // xmlBody「含外层标签也可」是工具从 0.1 起就写在文档里的承诺，但旧实现无条件再包一层 ——
  // sandbox19/v1 实测把 <Condition> 套成 <Condition><Condition>…，只能再手工修一层。
  // 这里识别"整节点"形态后原样落盘（属性也用 xmlBody 里的，不再追加），避免双层包裹。
  const trimmedBody = String(xmlBody).trim();
  const escapedName = escapeRegExp(nodeName);
  const wholeNode = trimmedBody !== ''
    && new RegExp(`^<${escapedName}(?=[\\s/>])`).test(trimmedBody)
    && (new RegExp(`</${escapedName}>$`).test(trimmedBody)
      || new RegExp(`^<${escapedName}(?=[\\s/>])[\\s\\S]*?/>$`).test(trimmedBody));
  const buildNode = (attrsText) => (wholeNode
    ? `${trimmedBody}\n`
    : `<${nodeName}${attrsText}${selfClose}${xmlBody}${selfClose === '/>' ? '' : `</${nodeName}>`}\n`);

  let out;
  let attributesPreserved = false;
  if (target >= 0) {
    // 替换：默认**保留原开标签属性**（2026-10-30 修）。旧实现用 attributes 重建开标签，
    // 未传 attributes 时就把 class 等属性全丢掉 —— sandbox4/v1 里重写 <SubmitVisitor> 丢
    // class="...FreeSQLSubmiter"，提交计数 1→0，等于把提交废掉。attributes 只用于"匹配"；
    // 确实要改写属性请显式传 replaceAttributes=true。
    const ge = raw.indexOf('>', target);
    const head = raw.slice(target, ge + 1);
    const oldSelfClose = head.trimEnd().endsWith('/>');
    const oldAttrs = head.slice(1 + nodeName.length, head.length - (oldSelfClose ? 2 : 1));
    const attrsText = replaceAttributes ? explicitAttrs : oldAttrs;
    attributesPreserved = !replaceAttributes;
    const newNode = buildNode(attrsText);
    if (oldSelfClose) {
      out = raw.slice(0, target) + newNode + raw.slice(ge + 1);
    } else {
      const [sb, se] = nodeBlockRange(raw, target, nodeName);
      out = raw.slice(0, sb) + newNode + raw.slice(se);
    }
  } else {
    // 【防误插】attributes 只用于匹配：传了 attributes 却没命中时，旧实现会静默新建一个节点
    // （sandbox4/v1 里一度出现两个 <SubmitVisitor>）。现在默认报错，要新建必须显式 createIfMissing=true。
    if (attributes != null && !createIfMissing) {
      throw new Error(`updateReportNode: 未找到匹配 attributes 的 <${nodeName}>${parent ? `（父容器 <${parent}> 内）` : ''} —— attributes 只用于匹配，未命中的旧行为会静默新建重复节点，已禁止。若确实要新建请显式传 createIfMissing=true；若只是想改属性，请核对 attributes 值或用 index/sheet 精确指定。`);
    }
    const newNode = buildNode(explicitAttrs);
    if (parentInsertAt != null) {
      // 插到唯一父容器末尾（parent 已保证唯一且在 sheet/scope 范围内）
      out = raw.slice(0, parentInsertAt) + newNode + raw.slice(parentInsertAt);
    } else {
      // 插入到 Report 块末尾前（既有语义）。
      // 2026-10-20 修复：WebWriteContent 是 WorkBook 级容器（必须在 ReportWebAttr 内），不再允许
      // 走这条兜底插入——旧行为会把它插到 </Report> 前，FR 填报预览读不到且无任何报错。
      if (nodeName === 'WebWriteContent') {
        throw new Error('updateReportNode: 不负责创建/搬移 <WebWriteContent>（旧兜底会把它插到 </Report> 前，FR 填报预览读不到）。请改用 set_webwrite_extras({path, repair:true}) 修复容器位置，或 create_cpt(webWrite=true)/build_report(webWrite:true) 重建。');
      }
      const closeIdx = raw.lastIndexOf('</Report>', b.end);
      if (closeIdx < 0 || closeIdx < b.start) throw new Error(`updateReportNode: Report 块 ${sheet ?? 0} 未找到 </Report>`);
      out = raw.slice(0, closeIdx) + newNode + raw.slice(closeIdx);
    }
  }
  save(path, out);
  return {
    action: 'update_report_node', nodeName, mode: 'upsert', sheet: sheet ?? 0,
    ...(target >= 0 ? { attributesPreserved } : {}),
    ...(parent ? { parent } : {}),
    wrapping: wholeNode ? 'verbatim' : 'wrapped',
    bytes: Buffer.byteLength(out, 'utf8'),
  };
}

// ---- JS 合并约定（同容器同事件类型只允许一个 <Listener> 代码块）的共用原语 ----

/** 从 <Listener> 块原文取 <Content><![CDATA[...]]></Content> 的 JS 原文；结构不符返回 null。 */
function listenerContentOf(block) {
  const cIdx = block.indexOf('<Content>');
  if (cIdx < 0) return null;
  const cbIdx = block.indexOf('<![CDATA[', cIdx);
  if (cbIdx < 0) return null;
  const ceIdx = block.indexOf(']]>', cbIdx);
  if (ceIdx < 0) return null;
  return block.slice(cbIdx + '<![CDATA['.length, ceIdx);
}

/**
 * 合并同容器同 event 的多个 <Listener> 块：各块 Content 依文档顺序拼接，可选追加 newJs。
 * 任一块缺 <Content> CDATA 时抛错（结构异常，不能安全合并，请改用 match 模式替换）。
 */
function mergeListenerJs(hits, newJs) {
  const parts = hits.map((h) => {
    const c = listenerContentOf(h.block);
    if (c == null) throw new Error('Listener 块缺少 <Content> CDATA，无法安全合并（请先读回确认结构，或改用 match 模式替换）');
    return c;
  });
  if (newJs != null) parts.push(newJs);
  return parts.filter((c) => c !== '').join('\n');
}

/** 用 node 文本替换首个 Listener 块，并删除其余被合并块（自后向前删，避免偏移失效）。 */
function mergeListenerBlocks(raw, hits, node) {
  let out = raw;
  for (let i = hits.length - 1; i >= 1; i--) {
    const s = hits[i].start;
    const e = s + hits[i].block.length;
    let ee = e;
    while (ee < out.length && (out[ee] === '\n' || out[ee] === '\r')) ee++;
    out = out.slice(0, s) + out.slice(ee);
  }
  const first = hits[0];
  return out.slice(0, first.start) + node + out.slice(first.start + first.block.length);
}

/** 官方结构拼装：<Listener event="…"><JavaScript class="…"><Parameters/><Content><![CDATA[js]]></Content>…</Listener>（含末尾换行）。 */
function listenerNode({ event, js, className = 'com.fr.js.JavaScriptImpl', name } = {}) {
  const nm = name ? `\n<NameJavaScript name="${escapeXmlAttr(String(name))}"/>` : '';
  return `<Listener event="${escapeXmlAttr(String(event))}">${nm}
<JavaScript class="${escapeXmlAttr(className)}">
<Parameters/>
<Content>
<![CDATA[${js}]]></Content>
</JavaScript>
</Listener>\n`;
}

// ============ Listener 共享大 Content：整块替换缩水护栏 + 片段替换（2026-11-03 事故后补） ============
//
// 【事故】某填报模板的 afterload 是**一个** 186,767 字节的共享 <Content>（frFin 核心 + 手动化 + Ctrl 多选 +
// 补丁1~4 全在同一段里）。本意只改其中一小段，用 set_webwrite_js(match:'__vX11d', js:8KB) 调用：
// match 只负责「选哪个 Listener 块」，js 却替换了整个 Content —— 文件 533,581 → 366,347 B，
// JS 块数仍 44、语法/validate/quality/引擎全绿，功能已全丢（靠 git 回退恢复）。
//
// 根因是能力缺口：① 没有「只改片段」的入口；② 整块替换前不核对大小；③ 门禁只看「块数/语法」，
// 内容被换掉不可见。这里补两点（写入口自身就能挡住，不必等后置门禁）：
//   ① 整块替换时做**缩水护栏**：旧 Content ≥4KB 且新内容 <旧 60% 且少 ≥2KB → 拒绝写入，
//      并指路 patchFind/patchReplace（片段替换）或 aggregate:true（追加）；确要整块替换传 allowShrink:true；
//   ② patchFind/patchReplace 片段替换：literal 查找（不解释正则），默认要求唯一命中，
//      只替换该片段，块内其余字节（Parameters/className/无关 JS/换行）**原样保留**。
const LISTENER_SHRINK_MIN_OLD_BYTES = 4096;   // 旧 Content ≥ 4KB 才启用护栏（小块正常改写不受影响）
const LISTENER_SHRINK_MAX_KEEP_RATIO = 0.6;   // 新内容 < 旧内容 60% 视为灾难性缩水
const LISTENER_SHRINK_MIN_LOSS_BYTES = 2048;  // 且绝对缩水 ≥ 2KB（避免极小文件上的比例噪声）

/** 取 Listener 块内 <Content><![CDATA[...]]></Content> 的原文与度量；结构不匹配返回 null。 */
function listenerContentSpan(block) {
  const m = String(block).match(/<Content>\s*<!\[CDATA\[([\s\S]*?)\]\]><\/Content>/);
  if (!m) return null;
  const js = m[1];
  const cdStart = m.index + m[0].indexOf('<![CDATA[') + '<![CDATA['.length;
  return { js, chars: js.length, bytes: Buffer.byteLength(js, 'utf8'), lines: js.split('\n').length, cdStart, cdEnd: cdStart + js.length };
}

/** JS 文本度量（字节数用 UTF-8，与文件体积/渲染字符串长度同口径；行数按 \n 计）。 */
function jsMetricsOf(js) {
  const s = String(js);
  return { chars: s.length, bytes: Buffer.byteLength(s, 'utf8'), lines: s.split('\n').length };
}

/**
 * 整块替换的缩水护栏（通用版）：目标 JS 是共享大段时，拒绝「换成小段」的整块替换。
 * @param beforeMetrics 旧 JS 度量（null/undefined → 没有旧块可对账，不拦）
 * @returns 替换前度量（供返回体对账）；allowShrink=true 时放行但仍返回度量。
 */
function guardJsShrink({ action, target, beforeMetrics, afterJs, allowShrink, fixHint }) {
  if (!beforeMetrics) return null; // 无旧块/结构异常 → 交给既有路径，不在护栏里吞信息
  if (allowShrink === true || allowShrink === 'true') return beforeMetrics;
  const after = jsMetricsOf(afterJs);
  const loss = beforeMetrics.bytes - after.bytes;
  if (beforeMetrics.bytes >= LISTENER_SHRINK_MIN_OLD_BYTES
    && after.bytes < beforeMetrics.bytes * LISTENER_SHRINK_MAX_KEEP_RATIO
    && loss >= LISTENER_SHRINK_MIN_LOSS_BYTES) {
    const pct = ((loss / beforeMetrics.bytes) * 100).toFixed(1);
    throw new Error(`${action}: 拒绝整块替换 —— ${target} 的 JS 会从 ${beforeMetrics.bytes}B/${beforeMetrics.lines}行 缩到 ${after.bytes}B/${after.lines}行（-${loss}B, -${pct}%）。${fixHint || ''}文件未改动。`);
  }
  return beforeMetrics;
}

/**
 * 整块替换的缩水护栏（Listener 专用包装）：保持既有报错口径（事故复盘 + aggregate 指路）。
 * 返回替换前度量（供返回体对账）；allowShrink=true 时放行但仍返回度量。
 */
function guardListenerShrink({ action, event, match, beforeBlock, afterJs, allowShrink }) {
  const before = listenerContentSpan(beforeBlock);
  if (!before) return null; // 结构异常（无 CDATA）→ 交给既有路径/报错，不在护栏里吞掉信息
  return guardJsShrink({
    action,
    target: `目标 Listener(event="${event}"${match ? `, match="${match}"` : ''}) 的 Content`,
    beforeMetrics: before,
    afterJs,
    allowShrink,
    fixHint: 'Listener Content 常是「多补丁共用的一大段 JS」，整块替换极易静默丢功能（2026-11-03 事故：187KB afterload 被 8KB 替换，JS 块数/语法/validate/quality/引擎全绿但功能全丢）。安全做法：①只改其中片段 → 传 patchFind + patchReplace（片段替换，块内其余原文原样保留）；②只追加 → aggregate:true；③确实要整块替换 → 传 allowShrink:true（写前用 get_webwrite_js/get_report_listener 核对 jsBytes/jsLines）。',
  });
}

// ============ 片段替换：设计器转义 `]A` 感知的匹配/回写（2026-11-03 线上缺陷修复） ============
//
// 【缺陷证据】2026-11-03 sandbox4 会话 session-de4f833e 14:52:54 / 14:53:07 / 15:01:31 / 15:01:38
// （event=afterload，4 次）反复报「setWebWriteJs: patchFind 在目标 Listener(event="afterload") 的
// Content 里未命中（0 处）—— 文件未改动」。
// 【根因】`]A` 是 FR 设计器对 `]` 的落盘编码（官方语料 1550 份 / 237 个 `]` **100%** 都是 `]A`，
// 见 lib/cpt.js 的 decodeFrJsForParse 定案注释），而模型按读回列表组织 patchFind 时常传「净文本」`]`
// —— 原文 literal 匹配自然 0 处。这不是模型写错，是写侧能力缺口。
// 【口径】匹配三路依次尝试（见 findJsPatchRanges）；回写保持官方落盘编码：
//   patchReplace 里未跟着 A 的 `]` 编码成 `]A`，已写成 `]A` 的保持不动（绝不双重编码 `]AA`）。
//   禁止把已有 `]A` 解码后写回（那会破坏设计器格式）。读回原文语义不变（读工具仍给 CDATA 原文）。
//   标记常量单一事实源：lib/cpt.js 的 DESIGNER_ESCAPE_MARKER（此处不重复定义）。

/**
 * 原文 JS（设计器落盘编码）→ 展示文本视图 + 每个展示字符到原文下标的映射。
 * `]A`(2 字符) → `]`(1 字符) 一一对应；其余字符原样 1:1。
 * @returns {{shown: string, starts: number[], ends: number[]}}
 */
function designerDecodedView(rawJs) {
  const raw = String(rawJs);
  let shown = '';
  const starts = [];
  const ends = [];
  for (let i = 0; i < raw.length;) {
    if (raw[i] === ']' && raw[i + 1] === 'A') {
      shown += ']'; starts.push(i); ends.push(i + 2); i += 2;
    } else {
      shown += raw[i]; starts.push(i); ends.push(i + 1); i += 1;
    }
  }
  return { shown, starts, ends };
}

/** 展示文本片段 → 原文落盘编码：未跟着 A 的 `]` 编码成 `]A`；已是 `]A` 的保持不动（禁止双重编码）。 */
function encodeDesignerJs(text) {
  return String(text).replace(/](?!A)/g, ']A');
}

/** 把 patchFind/原文归一为「LF + 去掉每行尾部空白」的匹配视图；返回展示字符到原文区间的映射。 */
function normalizePatchText(text) {
  return String(text)
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, ''))
    .join('\n');
}

function buildLoosePatchView(raw) {
  const shown = [];
  const starts = [];
  const ends = [];
  const trimLineEnd = () => {
    while (shown.length > 0 && (shown[shown.length - 1] === ' ' || shown[shown.length - 1] === '\t')) {
      shown.pop();
      starts.pop();
      ends.pop();
    }
  };
  for (let i = 0; i < raw.length;) {
    const ch = raw[i];
    if (ch === '\r') {
      const next = raw[i + 1] === '\n' ? i + 2 : i + 1;
      trimLineEnd();
      shown.push('\n');
      starts.push(i);
      ends.push(next);
      i = next;
    } else if (ch === '\n') {
      trimLineEnd();
      shown.push('\n');
      starts.push(i);
      ends.push(i + 1);
      i += 1;
    } else {
      shown.push(ch);
      starts.push(i);
      ends.push(i + 1);
      i += 1;
    }
  }
  return { shown: shown.join(''), starts, ends };
}

/**
 * 在 JS 原文里定位 patchFind（literal，不解释正则），设计器转义感知。四路依次尝试：
 *   ① 原文 literal（模型把读到的 `]A` 原文贴回来）；
 *   ② 原文解码成展示文本（`]A`→`]`）后用净 patchFind 匹配，再把展示偏移映射回原文区间
 *      （模型传净文本 `]`、原文是 `]A` 的主路径）；
 *   ③ 兜底：把 patchFind 自身按设计器规则编码（`]`→`]A`）后再原文 literal；
 *   ④ CRLF/LF 与行尾空格归一后再匹配（真实会话高频：读回是 CRLF，模型粘贴成 LF）。
 * @returns {{ranges: {start:number,end:number}[], matchedBy: 'raw'|'raw-encoded'|'decoded'|'loose'|null}}
 */
function findJsPatchRanges(rawJs, patchFind) {
  const raw = String(rawJs);
  const find = String(patchFind);
  if (!find) return { ranges: [], matchedBy: null };
  const literal = [];
  for (let i = raw.indexOf(find); i >= 0; i = raw.indexOf(find, i + find.length)) {
    const end = i + find.length;
    // 命中落在设计器转义 `]A` 的边界上（只覆盖 `]` 或只覆盖 `A`）：这类 literal 命中会拆散转义、
    // 写回即产生 `]AA` 双重编码/孤立 `]` —— 跳过，交给解码路径按展示文本整体替换。
    if (find.endsWith(']') && raw[end] === 'A') continue;              // 只覆盖了 `]`
    if (i > 0 && raw[i - 1] === ']' && raw[i] === 'A') continue;       // 只覆盖了 `A`
    literal.push({ start: i, end });
  }
  if (literal.length > 0) return { ranges: literal, matchedBy: 'raw' };
  // ② 解码路径：原文 → 展示文本（`]A`→`]`）后匹配，再把展示偏移映射回原文区间。
  //    （原文没有 `]A` 时解码等价于原文，literal 已经试过，跳过）
  if (raw.includes(DESIGNER_ESCAPE_MARKER)) {
    const view = designerDecodedView(raw);
    const offsets = [];
    for (let i = view.shown.indexOf(find); i >= 0; i = view.shown.indexOf(find, i + find.length)) {
      offsets.push(i);
    }
    if (offsets.length > 0) {
      const ranges = offsets.map((d0) => {
        const dEnd = Math.min(d0 + find.length, view.shown.length); // 展示下标（不含）
        return { start: view.starts[d0], end: view.ends[dEnd - 1] };
      });
      return { ranges, matchedBy: 'decoded' };
    }
  }
  // ③ 兜底：把 patchFind 自身按设计器规则编码（`]`→`]A`）后再原文 literal（覆盖模型直接传 raw 的形态）。
  const encoded = encodeDesignerJs(find);
  if (encoded !== find) {
    const encHits = [];
    for (let i = raw.indexOf(encoded); i >= 0; i = raw.indexOf(encoded, i + encoded.length)) {
      encHits.push({ start: i, end: i + encoded.length });
    }
    if (encHits.length > 0) return { ranges: encHits, matchedBy: 'raw-encoded' };
  }
  // ④ CRLF/行尾空格归一：读回窗口/模型粘贴经常把 \r\n 变 \n 或吞掉行尾空格。
  const looseFind = normalizePatchText(find);
  if (looseFind) {
    const view = buildLoosePatchView(raw);
    const looseHits = [];
    for (let i = view.shown.indexOf(looseFind); i >= 0; i = view.shown.indexOf(looseFind, i + looseFind.length)) {
      const last = i + looseFind.length - 1;
      looseHits.push({ start: view.starts[i], end: view.ends[last] });
    }
    if (looseHits.length > 0) return { ranges: looseHits, matchedBy: 'loose' };
  }
  return { ranges: [], matchedBy: null };
}

/** 0 命中时给出最多 3 个「最接近片段」候选（原文偏移 + 上下文），提示模型把片段加长到唯一。 */
function closestJsFragments(rawJs, patchFind, limit = 3) {
  const raw = String(rawJs);
  const find = String(patchFind);
  const out = [];
  const seen = new Set();
  const ctx = (start, end) => raw.slice(Math.max(0, start - 32), Math.min(raw.length, end + 32)).replace(/\r?\n/g, '⏎');
  const maxAnchor = Math.min(24, find.length);
  let view = null;
  for (let n = maxAnchor; n >= 8 && out.length < limit; n -= 2) {
    const anchor = find.slice(0, n);
    const offsets = [];
    const encAnchor = encodeDesignerJs(anchor);
    const rawHit = raw.indexOf(encAnchor);
    if (rawHit >= 0) offsets.push({ start: rawHit, end: rawHit + encAnchor.length });
    if (encAnchor !== anchor) {
      const rawHit2 = raw.indexOf(anchor); // 覆盖「模型传 raw `]A` 而原文反而是净文本」的形态
      if (rawHit2 >= 0) offsets.push({ start: rawHit2, end: rawHit2 + anchor.length });
    }
    if (offsets.length === 0) {
      view = view ?? designerDecodedView(raw);
      const d0 = view.shown.indexOf(anchor);
      if (d0 >= 0) {
        const dEnd = Math.min(d0 + anchor.length, view.shown.length);
        offsets.push({ start: view.starts[d0], end: view.ends[dEnd - 1] });
      }
    }
    for (const off of offsets) {
      if (seen.has(off.start)) continue;
      seen.add(off.start);
      out.push({ offset: off.start, context: ctx(off.start, off.end) });
      if (out.length >= limit) break;
    }
  }
  return out;
}

/** 片段 0 命中错误：说明已按原文/解码各试一次 + 最多 3 个最接近片段候选 + 文件未改动。 */
function jsPatchMissError({ action, target, rawJs, patchFind }) {
  const cands = closestJsFragments(rawJs, patchFind);
  const candText = cands.length > 0
    ? `最接近片段候选（偏移 + 上下文，请据此把 patchFind 加长到唯一）：${cands.map((c) => `\n  · 偏移 ${c.offset}: "${c.context}"`).join('')}`
    : '未找到可用锚点（patchFind 前 8~24 字符在原文/解码文本里也找不到），请先读回目标 JS 再取片段。';
  return `${action}: patchFind 在 ${target} 的 JS 里未命中（0 处）—— 文件未改动。`
    + '已按原文、设计器转义解码（`]A`→`]`）、转义编码、CRLF/LF 与行尾空格归一各试一次。'
    + `${candText}\n请用读工具读回确认原文（注意空白/换行/转义），把片段加长到唯一后重试。`;
}

/**
 * 片段替换核心（set_webwrite_js / set_report_listener / set_webpage_js / set_report_js / set_toolbar_button_js /
 * update_cell_listener 共用）：设计器转义感知定位 patchFind，只替换命中片段；patchReplace 按
 * 官方落盘编码回写（`]`→`]A`，已是 `]A` 的不双重编码），空串=删除片段。
 * 默认要求恰好命中 1 处，patchAll=true 才允许多处。
 * @returns {{js: string, hits: number, matchedBy: string|null}}
 */
function patchJsFragment({ action, target, js, patchFind, patchReplace, patchAll }) {
  const raw = String(js);
  const find = String(patchFind ?? '');
  if (!find) throw new Error(`${action}: patchFind 不能为空（片段替换需提供原文片段；只想追加请用 aggregate:true）`);
  const found = findJsPatchRanges(raw, find);
  const hits = found.ranges.length;
  if (hits === 0) throw new Error(jsPatchMissError({ action, target, rawJs: raw, patchFind: find }));
  const all = patchAll === true || patchAll === 'true';
  if (hits > 1 && !all) {
    throw new Error(`${action}: patchFind 在 ${target} 的 JS 里命中 ${hits} 处（默认只允许 1 处）—— 文件未改动。请把片段加长到唯一，或传 patchAll:true 明确全部替换。`);
  }
  const targets = all ? found.ranges : [found.ranges[0]];
  // 回写编码：保持官方落盘形态；已是 `]A` 的两字符序列不再编码（避免 `]AA` 双重编码）。
  // 换行跟随原块（CRLF 文件写 CRLF），避免 patch 后混入 LF。
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  const replText = String(patchReplace ?? '').replace(/\r\n?/g, '\n').replace(/\n/g, () => eol);
  const repl = encodeDesignerJs(replText);
  let next = raw;
  let delta = 0;
  for (const r of targets) {
    const s = r.start + delta;
    const e = r.end + delta;
    next = next.slice(0, s) + repl + next.slice(e);
    delta += repl.length - (r.end - r.start);
  }
  return { js: next, hits: targets.length, matchedBy: found.matchedBy };
}

/**
 * 片段替换：在 Listener Content 原文里定位 patchFind（literal；含设计器转义 `]A` 解码兜底），
 * 命中处替换为 patchReplace（空串=删除片段）。默认要求恰好命中 1 处；patchAll=true 才允许多处。
 * 只改片段本身，块内其余字节（Parameters/className/无关 JS/换行缩进）原样保留（最小 diff）。
 */
function applyListenerPatch({ action, event, block, patchFind, patchReplace, patchAll }) {
  const content = listenerContentSpan(block);
  if (!content) {
    throw new Error(`${action}: 目标 Listener(event="${event}") 缺少 <Content><![CDATA[...]]></Content> 结构，无法片段替换（文件未改动；请先 get_webwrite_js/get_report_listener 读回确认结构）`);
  }
  const patched = patchJsFragment({
    action, target: `目标 Listener(event="${event}") 的 Content`, js: content.js, patchFind, patchReplace, patchAll,
  });
  const nextJs = assertSafeCdata(patched.js, 'Listener JS');
  const nextBlock = block.slice(0, content.cdStart) + nextJs + block.slice(content.cdEnd);
  return { block: nextBlock, hits: patched.hits, matchedBy: patched.matchedBy, before: content, after: jsMetricsOf(nextJs) };
}

/** 在 raw 的 [start, start+block.length) 处替换为一个或多个目标块（patch 模式复用）。 */
function replaceListenerBlockInRaw(raw, start, block, nextBlock) {
  return raw.slice(0, start) + nextBlock + raw.slice(start + block.length);
}

/** 取块内 <Tag ...><![CDATA[...]]></Tag> 的 CDATA 原文与区间（span 相对块起点）；结构不符返回 null。 */
function tagCdataSpan(block, tag) {
  const m = String(block).match(new RegExp(`<${tag}\\b[^>]*>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]></${tag}>`));
  if (!m) return null;
  const js = m[1];
  const cdStart = m.index + m[0].indexOf('<![CDATA[') + '<![CDATA['.length;
  return { js, chars: js.length, bytes: Buffer.byteLength(js, 'utf8'), lines: js.split('\n').length, cdStart, cdEnd: cdStart + js.length };
}

/** expectedSha256 核对（任意 JS 原文口径；与读工具返回的 jsBytes 同源）。 */
function assertExpectedSha256Js(rawJs, expectedSha256, what) {
  if (expectedSha256 === undefined || expectedSha256 === null || String(expectedSha256).trim() === '') return;
  const want = String(expectedSha256).trim().toLowerCase();
  const raw = String(rawJs ?? '');
  // 读侧可能返回原文 sha，也可能返回设计器解码后的展示文本 sha；写侧同时接受两种口径，
  // 避免模型把 get_webwrite_js 读到的 sha 原样回传时被误判（V4 会话实测 5 次）。
  const candidates = [['raw', jsSha256(raw)]];
  if (raw.includes(DESIGNER_ESCAPE_MARKER)) {
    const view = designerDecodedView(raw);
    candidates.push(['decoded', jsSha256(view.shown)]);
    candidates.push(['encoded', jsSha256(encodeDesignerJs(raw))]);
  }
  if (candidates.some(([, actual]) => actual === want)) return;
  const actualText = [...new Set(candidates.map(([, actual]) => actual))].join(' / ');
  throw new Error(`${what}: expectedSha256 与当前块 sha 不符（期望 ${want}，实际 ${actualText}）。文件可能已被他人修改，或读到的是截断旧块（请核对 jsLength、有无 Omitted/截断标记）。已拒绝写入，文件未动。请用对应 get_* 读工具（按 match 或 jsOffset/jsLimit 分段）重读后再试。`);
}

/** 返回体统一的「patch 匹配方式」注解：仅解码/编码兜底命中时出现（原文命中零 token 增长）。 */
const patchMatchNote = (matchedBy) => (matchedBy && matchedBy !== 'raw'
  ? { patchMatchedBy: matchedBy === 'decoded' ? 'designer-decoded' : matchedBy === 'loose' ? 'line-ending-normalized' : 'designer-encoded-raw', patchFindNote: matchedBy === 'loose' ? 'patchFind 与原文的换行/行尾空格不一致；已按 LF + 去行尾空格归一匹配，回写沿用原块换行。' : '`]A` 是设计器对 `]` 的落盘编码；本次按设计器转义规则匹配成功，回写保持 `]A` 编码。' }
  : {});

/**
 * 片段替换参数的统一预检（5 个 JS 写工具共用）：
 *   · 只传 patchReplace 不传 patchFind → 当前 patchMode=false 会静默走整块写入/删除（危险），明确报错；
 *   · patchFind 传空串 → 等同未传，同样会被当成整块写入/删除，明确报错。
 */
function assertPatchArgs({ action, patchMode, patchFind, patchReplace }) {
  if (!patchMode && patchReplace !== undefined && patchReplace !== null) {
    throw new Error(`${action}: patchReplace 必须配合非空 patchFind（否则会被当成整块写入/删除）—— 请传 patchFind 指定要替换的片段；整块替换请只传 js。`);
  }
  if (!patchMode && patchFind !== undefined && patchFind !== null) {
    throw new Error(`${action}: patchFind 不能为空（空串=未传，会被当成整块写入/删除）—— 片段替换请给非空 patchFind。`);
  }
}


/**
 * 增/改/删 Report 节点下的 <Listener event="..."><JavaScript class="..."><Content>JS</Content></Listener>
 * 完整块（用户传 JS 字符串，工具按官方结构拼）。
 * 与 updateReportNode 的区别：本工具做结构化拼装 + 安全转义 + 模板化 CDATA；updateReportNode 是低层入口。
 * 片段替换（2026-11-03 事故后补）：大块共享 Content 只想改其中一段时传 patchFind + patchReplace（literal、
 *   默认唯一命中，patchAll=true 允许多处）；只改命中片段、块内其余原文原样保留（与 js 互斥）。
 * 缩水护栏：整块替换若会让旧 Content（≥4KB）缩到 <60% 且少 ≥2KB → 拒绝（确要传 allowShrink:true）。
 */
export function setReportListener(path, { event, js, className = 'com.fr.js.JavaScriptImpl', sheet, name, match, aggregate, expectedSha256, patchFind, patchReplace, patchAll, allowShrink } = {}) {
  if (!event || !String(event).trim()) throw new Error('setReportListener: 必须提供 event（如 "onload"/"afterload"/"beforeOutput"/"afterOutput"/"webopen"）');
  // F1 自卫：expectedSha256 不得与 aggregate 联用（合并改写多块，无法单块核对）
  if (aggregate && expectedSha256 !== undefined && expectedSha256 !== null && String(expectedSha256).trim() !== '') {
    throw new Error('setReportListener: expectedSha256 不能与 aggregate 联用（合并改写多块，无法单块核对）。请先 get_report_listener 读回各块 sha256，用 match 逐块改写。');
  }
  // 片段替换（patchFind/patchReplace）与整块写入（js）/合并（aggregate）互斥：
  // 大块共享 Content 想改一段时必须走片段替换，避免「整块换成小段」丢功能（2026-11-03 事故）。
  const patchMode = patchFind !== undefined && patchFind !== null && String(patchFind) !== '';
  if (patchMode) {
    if (js != null) throw new Error('setReportListener: patchFind/patchReplace 是「片段替换」，不能同时传 js（整块替换）—— 只改一段请只传 patchFind(+patchReplace)；整块替换请只传 js（大块需 allowShrink:true）。');
    if (aggregate) throw new Error('setReportListener: patchFind 不能与 aggregate 联用（片段替换 vs 合并追加，语义互斥）。');
  }
  assertPatchArgs({ action: 'setReportListener', patchMode, patchFind, patchReplace });

  // 片段替换模式：只改目标 Listener Content 里的一段，块内其余原文（Parameters/className/无关 JS/换行）原样保留。
  if (patchMode) {
    const { raw } = load(path);
    const b = reportScope(raw, sheet);
    const seg = raw.slice(b.start, b.end);
    const lmRe = new RegExp(`<Listener\\s+event="${escapeXmlAttr(String(event))}"[^>]*>[\\s\\S]*?</Listener>`, 'g');
    const blocks = [];
    let lmHit;
    while ((lmHit = lmRe.exec(seg)) !== null) blocks.push({ start: b.start + lmHit.index, block: lmHit[0] });
    let target = null;
    if (match !== undefined && match !== null && String(match).trim() !== '') {
      target = blocks.find((x) => x.block.includes(String(match))) || null;
      if (!target) throw new Error(`setReportListener: sheet ${sheet ?? 0} Report 块内未找到 event="${event}" 且含 "${match}" 的 Listener`);
    } else if (blocks.length === 1) {
      target = blocks[0];
    } else if (blocks.length === 0) {
      throw new Error(`setReportListener: sheet ${sheet ?? 0} Report 块内未找到 event="${event}" 的 Listener，无法片段替换（patchFind/patchReplace 只改已存在块；要新建请传 js）。文件未改动。`);
    } else {
      throw new Error(`setReportListener: Report 块内 event="${event}" 有 ${blocks.length} 个 Listener，未传 match 无法确定改哪一块（禁止静默命中第一个）。请先 get_report_listener(event="${event}") 读回各块 JS，再传 match=目标 JS 独有的特征子串精确定位后重试。`);
    }
    assertExpectedSha256(target.block, expectedSha256, 'setReportListener');
    const patched = applyListenerPatch({ action: 'setReportListener', event, block: target.block, patchFind, patchReplace, patchAll });
    const out = replaceListenerBlockInRaw(raw, target.start, target.block, patched.block);
    save(path, out);
    return {
      action: 'set_report_listener', event, mode: 'patch', match: match ?? null, patchHits: patched.hits,
      ...patchMatchNote(patched.matchedBy),
      jsBytesBefore: patched.before.bytes, jsBytesAfter: patched.after.bytes,
      jsLinesBefore: patched.before.lines, jsLinesAfter: patched.after.lines,
      bytes: Buffer.byteLength(out, 'utf8'),
      hint: `已片段替换 ${patched.hits} 处（只改命中片段，Listener 其余原文未动）。修改后建议重跑 check_report_js/validate_cpt。`,
    };
  }

  // match 模式：Report 块内同一 event 可挂多个 Listener（真实报表常见），
  // 用 JS 特征子串精确定位目标块再替换/删除；缺省走 updateReportNode（命中第一个）。
  if (match !== undefined && match !== null && String(match).trim() !== '') {
    const { raw } = load(path);
    const b = reportScope(raw, sheet);
    const seg = raw.slice(b.start, b.end);
    const lmRe = new RegExp(`<Listener\\s+event="${escapeXmlAttr(String(event))}"[^>]*>[\\s\\S]*?</Listener>`, 'g');
    let lmHit = null, anchor = -1;
    while ((lmHit = lmRe.exec(seg)) !== null) {
      if (lmHit[0].includes(String(match))) { anchor = b.start + lmHit.index; break; }
    }
    if (anchor < 0) throw new Error(`setReportListener: sheet ${sheet ?? 0} Report 块内未找到 event="${event}" 且含 "${match}" 的 Listener`);
    const blockEnd = raw.indexOf('</Listener>', anchor) + '</Listener>'.length;
    // F1 自卫：替换/删除前核对当前块 sha（不符抛错且不写文件；不传 expectedSha256 则老行为不变）
    assertExpectedSha256(raw.slice(anchor, blockEnd), expectedSha256, 'setReportListener');
    if (js == null) {
      let e = blockEnd;
      while (e < raw.length && (raw[e] === '\n' || raw[e] === '\r')) e++;
      const out = raw.slice(0, anchor) + raw.slice(e);
      save(path, out);
      return { action: 'set_report_listener', event, mode: 'delete', match, bytes: Buffer.byteLength(out, 'utf8') };
    }
    // 缩水护栏：大块共享 Content 禁止整块换成小段（想改一段请走 patchFind/patchReplace；确要整块替换传 allowShrink:true）。
    const shrinkBefore = guardListenerShrink({ action: 'setReportListener', event, match, beforeBlock: raw.slice(anchor, blockEnd), afterJs: js, allowShrink });
    const safeJsM = assertSafeCdata(String(js), 'Listener JS');
    const nodeM = `<Listener event="${escapeXmlAttr(String(event))}">
<JavaScript class="${escapeXmlAttr(className)}">
<Parameters/>
<Content>
<![CDATA[${safeJsM}]]></Content>
</JavaScript>
</Listener>\n`;
    const out = raw.slice(0, anchor) + nodeM + raw.slice(blockEnd);
    save(path, out);
    const afterM = jsMetricsOf(safeJsM);
    return {
      action: 'set_report_listener', event, mode: 'update', match,
      ...(shrinkBefore ? { jsBytesBefore: shrinkBefore.bytes, jsLinesBefore: shrinkBefore.lines } : {}),
      jsBytesAfter: afterM.bytes, jsLinesAfter: afterM.lines,
      bytes: Buffer.byteLength(out, 'utf8'),
      ...(shrinkBefore && shrinkBefore.bytes >= LISTENER_SHRINK_MIN_OLD_BYTES
        ? { hint: `已整块替换 ${shrinkBefore.bytes}B/${shrinkBefore.lines}行 的共享大块（新 ${afterM.bytes}B/${afterM.lines}行）。若只想改其中一段，优先用 patchFind/patchReplace 片段替换，可保留其余原文。` }
        : {}),
    };
  }

  // 【JS 合并约定】aggregate 聚合/合并模式：同一容器内、**相同事件类型的 JS 只允许一个 <Listener> 代码块**。
  //   · 已有 ≥2 块 → 全部并入首块并删除多余块（JS 按文档顺序拼接，不丢内容），mode='merge'；
  //   · 已有 1 块  → 把新 JS 追加进现有 Content，mode='append'（向后兼容）；
  //   · 无块 + 有 js → 落到下方普通插入逻辑（只新建一个块）；
  //   · 未传 js    → 只合并现有散块，**绝不删除不新建**（删除语义走不带 aggregate 的 js 缺省调用）。
  // 防误删不变：不带 aggregate 且同 event 多块、又未传 match 时仍直接拒绝（禁止静默命中第一个）。
  if (aggregate) {
    const { raw } = load(path);
    const b = reportScope(raw, sheet);
    const seg = raw.slice(b.start, b.end);
    const lmRe = new RegExp(`<Listener\\s+event="${escapeXmlAttr(String(event))}"[^>]*>[\\s\\S]*?</Listener>`, 'g');
    const hits = [];
    let lmHit;
    while ((lmHit = lmRe.exec(seg)) !== null) hits.push({ start: b.start + lmHit.index, block: lmHit[0] });
    const safeJsAgg = js == null ? null : assertSafeCdata(String(js), 'Listener JS');
    if (hits.length > 0) {
      const merged = mergeListenerJs(hits, safeJsAgg);
      const out = mergeListenerBlocks(raw, hits, listenerNode({ event, js: merged, className, name }));
      save(path, out);
      const mode = hits.length > 1 ? 'merge' : safeJsAgg != null ? 'append' : 'noop';
      return {
        action: 'set_report_listener', event, mode, mergedBlocks: hits.length, bytes: Buffer.byteLength(out, 'utf8'),
        hint: hits.length > 1
          ? `已把 ${hits.length} 个 event="${event}" 的 Listener 合并为 1 个代码块（JS 按文档顺序拼接，无内容丢失）。注意与既有 JS 的变量/函数重名冲突。`
          : safeJsAgg != null
            ? '已把 JS 追加进现有 Listener 的 Content（按事件类型聚合）。注意与既有 JS 的变量/函数重名冲突。'
            : `event="${event}" 只有 1 个 Listener 块，无需合并。`,
      };
    }
    if (safeJsAgg == null) {
      return {
        action: 'set_report_listener', event, mode: 'noop', mergedBlocks: 0, bytes: Buffer.byteLength(raw, 'utf8'),
        hint: `event="${event}" 无 Listener 块且未提供 js：aggregate 模式不新建也不删除，本次未做改动。`,
      };
    }
    // 无现有 Listener 且带 js：落到下方普通插入逻辑（新建唯一块）
  }

  // F1 自卫（无 match 路径）：传了 expectedSha256 则替换/删除前核对唯一现有块的 sha。
  // 无块 → 拒绝新建（无法核对）；多块 → 沿用 M89 口径拒绝（禁止静默命中第一个）。
  if (expectedSha256 !== undefined && expectedSha256 !== null && String(expectedSha256).trim() !== '') {
    const { raw: raw0 } = load(path);
    const b0 = reportScope(raw0, sheet);
    const seg0 = raw0.slice(b0.start, b0.end);
    const chkRe = new RegExp(`<Listener\\s+event="${escapeXmlAttr(String(event))}"[^>]*>[\\s\\S]*?</Listener>`, 'g');
    const hits0 = seg0.match(chkRe) || [];
    if (hits0.length === 0) {
      throw new Error(`setReportListener: Report 块内未找到 event="${event}" 的 Listener（传了 expectedSha256，无从核对，拒绝新建）。不传 expectedSha256 则按老行为插入新块。`);
    }
    if (hits0.length > 1) {
      throw new Error(`setReportListener: Report 块内 event="${event}" 有 ${hits0.length} 个 Listener，未传 match 无法确定改哪一块（禁止静默命中第一个）。请先 get_report_listener(event="${event}") 读回各块 JS，再传 match=目标 JS 独有的特征子串（如 "rowCalc"/"OP_COL"）精确定位后重试。`);
    }
    assertExpectedSha256(hits0[0], expectedSha256, 'setReportListener');
  }

  if (js == null) {
    // 删：定位并删（限定 Report 块内，避免误删 WebWriteContent 的同 event 填报监听）
    return updateReportNode(path, { nodeName: 'Listener', attributes: { event }, sheet, scope: 'report' });
  }

  // 【M89 防误删】Report 块内同一 event 挂多个 Listener 且未传 match → 拒绝（禁止静默命中第一个）。
  // 与 setWebWriteJs 同口径：真实报表同 event 可挂多个 Listener（官方样本有 6 个 afterload），
  // 缺省静默改/删第一块会错改。必须先 get_report_listener 读回确认块数，再传 match 精确定位。
  if (match === undefined || match === null || String(match).trim() === '') {
    const { raw: raw0 } = load(path);
    const b0 = reportScope(raw0, sheet);
    const seg0 = raw0.slice(b0.start, b0.end);
    const cntRe = new RegExp(`<Listener\\s+event="${escapeXmlAttr(String(event))}"[^>]*>[\\s\\S]*?</Listener>`, 'g');
    const blocks0 = seg0.match(cntRe) || [];
    if (blocks0.length > 1) {
      throw new Error(`setReportListener: Report 块内 event="${event}" 有 ${blocks0.length} 个 Listener，未传 match 无法确定改哪一块（禁止静默命中第一个）。请先 get_report_listener(event="${event}") 读回各块 JS，再传 match=目标 JS 独有的特征子串（如 "rowCalc"/"OP_COL"）精确定位后重试。`);
    }
    // 唯一现有块 + 整块 js 写入 → 缩水护栏（大块只改一段请用 patchFind/patchReplace）。
    if (blocks0.length === 1) guardListenerShrink({ action: 'setReportListener', event, beforeBlock: blocks0[0], afterJs: js, allowShrink });
  }

  const safeJs = assertSafeCdata(String(js), 'Listener JS');
  const safeEvent = escapeXmlAttr(String(event));
  const nm = name ? `\n<NameJavaScript name="${escapeXmlAttr(String(name))}"/>` : '';
  // body 是 <Listener> 的内部（外层 </Listener> 由 updateReportNode 负责闭合）
  const body = `${nm}
<JavaScript class="${escapeXmlAttr(className)}">
<Content>
<![CDATA[${safeJs}]]></Content>
</JavaScript>`;
  // 同一 event 名只允许一个 Listener（FR 设计器语义），有则替换、无则插入（限定 Report 块内）。
  // createIfMissing:true 是内部语义（本工具承诺 upsert-创建）；低层 update_report_node 默认禁止静默新建。
  const res = updateReportNode(path, { nodeName: 'Listener', attributes: { event: String(event) }, xmlBody: body, sheet, scope: 'report', createIfMissing: true });
  const after = jsMetricsOf(safeJs);
  return { ...res, jsBytesAfter: after.bytes, jsLinesAfter: after.lines };
}

/**
 * 增/改/删 Report 节点下的 <TopJS><![CDATA[js]]></TopJS>（报表顶部 JS / 报表初始化 JS）。
 * 这是「报表JS」最常见的落点：JS 在报表页面加载时执行（如 contentPane 初始化、全局 hook）。
 * 用户只传 JS 字符串，本工具按官方结构拼装 + CDATA 安全转义；js 传 null 则删除。
 * 片段替换（2026-11-03 事故后补，与 set_report_listener 同口径）：大块 TopJS 只改其中一段时传
 *   patchFind + patchReplace（设计器转义 `]A` 感知、默认唯一命中、patchAll=true 允许多处），与 js 互斥；
 *   只改 CDATA 内文，块结构（<TopJS> 标签/其余 JS）原样保留。
 * 缩水护栏：整块写入若会让旧 TopJS（≥4KB）缩到 <60% 且少 ≥2KB → 拒绝（确要传 allowShrink:true）。
 * expectedSha256：patch/整块替换/删除前核对目标 TopJS 的 sha（不传则老行为不变）。
 * 与 setReportListener 的区别：Listener 是「报表事件」（onload/afterload 等），TopJS 是无事件挂点的
 * 报表级脚本；两者可并存。安全上可执行 JavaScript 默认被围栏拦截（见 server.js 的 allowUnsafeScript）。
 */
/** TopJS 定位：目标 Report 块内全部 <TopJS> 块 + 全文件总数（多表歧义判定用）。 */
function reportTopJsInfo(raw, sheet) {
  const b = reportScope(raw, sheet);
  const seg = raw.slice(b.start, b.end);
  const re = /<TopJS\b[^>]*>[\s\S]*?<\/TopJS>/g;
  const blocks = [];
  let m;
  while ((m = re.exec(seg)) !== null) blocks.push({ start: b.start + m.index, block: m[0] });
  const total = findAll(raw, '<TopJS').filter((i) => {
    const ch = raw[i + '<TopJS'.length];
    return ch != null && /[\s/>]/.test(ch);
  }).length;
  return { scope: b, blocks, total };
}

export function setReportJs(path, {
  js, sheet, patchFind, patchReplace, patchAll, allowShrink, expectedSha256,
} = {}) {
  const bytesOf = (s) => Buffer.byteLength(s, 'utf8');
  const patchMode = patchFind !== undefined && patchFind !== null && String(patchFind) !== '';
  assertPatchArgs({ action: 'setReportJs', patchMode, patchFind, patchReplace });
  if (patchMode) {
    if (js != null) throw new Error('setReportJs: patchFind/patchReplace 是「片段替换」，不能同时传 js（整块替换）—— 只改一段请只传 patchFind(+patchReplace)；整块替换请只传 js（大块需 allowShrink:true）。');
    const { raw } = load(path);
    const info = reportTopJsInfo(raw, sheet);
    if (sheet == null && info.total > 1) {
      throw new Error(`setReportJs: 全文件有 ${info.total} 个 <TopJS>（多表），未传 sheet 无法确定改哪一个（禁止静默命中第一个）。请先 read_cpt 的 jsBlocks[].topJs 核对哪些表有 TopJS，再传 sheet=表索引（0 起）或表名后重试。文件未改动。`);
    }
    if (info.blocks.length === 0) {
      throw new Error(`setReportJs: sheet ${sheet ?? 0} 的 Report 块内未找到 <TopJS>，无法片段替换（patchFind/patchReplace 只改已存在块；要新建请传 js）。文件未改动。`);
    }
    if (info.blocks.length > 1) {
      throw new Error(`setReportJs: sheet ${sheet ?? 0} 的 Report 块内有 ${info.blocks.length} 个 <TopJS>，无法确定改哪一个（禁止静默命中第一个）。请先 read_cpt 核对，或用 update_report_node 低层入口显式处理。文件未改动。`);
    }
    const target = info.blocks[0];
    const span = tagCdataSpan(target.block, 'TopJS');
    if (!span) {
      throw new Error('setReportJs: 目标 <TopJS> 缺少 <![CDATA[...]]> 结构，无法片段替换（文件未改动；请先 read_cpt 确认结构，或用 update_report_node 低层改写）。');
    }
    assertExpectedSha256Js(span.js, expectedSha256, 'setReportJs');
    const patched = patchJsFragment({ action: 'setReportJs', target: `TopJS(sheet ${sheet ?? 0})`, js: span.js, patchFind, patchReplace, patchAll });
    const nextJs = assertSafeCdata(patched.js, '报表JS');
    const out = raw.slice(0, target.start + span.cdStart) + nextJs + raw.slice(target.start + span.cdEnd);
    save(path, out);
    return {
      action: 'set_report_js', nodeName: 'TopJS', sheet: sheet ?? 0, mode: 'patch', patchHits: patched.hits,
      ...patchMatchNote(patched.matchedBy),
      jsBytesBefore: span.bytes, jsBytesAfter: bytesOf(nextJs),
      jsLinesBefore: span.lines, jsLinesAfter: nextJs.split('\n').length,
      bytes: bytesOf(out),
      hint: `已片段替换 ${patched.hits} 处（只改 TopJS CDATA 内文，其余原文未动）。修改后建议重跑 check_report_js/validate_cpt。`,
    };
  }

  if (js == null) {
    // 删除：TopJS 是 Report 块内节点，限定 Report 块内定位（避免低层全文扫描越界）
    const { raw } = load(path);
    const info = reportTopJsInfo(raw, sheet);
    const wantSha = expectedSha256 !== undefined && expectedSha256 !== null && String(expectedSha256).trim() !== '';
    if (wantSha) {
      if (sheet == null && info.total > 1) {
        throw new Error(`setReportJs: 全文件有 ${info.total} 个 <TopJS>（多表），未传 sheet 无法确定核对/删除哪一个（禁止静默命中第一个）。请传 sheet=表索引（0 起）或表名后重试。`);
      }
      if (info.blocks.length === 0) {
        throw new Error(`setReportJs: 未找到 <TopJS>（传了 expectedSha256，无从核对，拒绝删除）。不传 expectedSha256 则按老行为删除。`);
      }
      assertExpectedSha256Js(tagCdataSpan(info.blocks[0].block, 'TopJS')?.js, expectedSha256, 'setReportJs');
    }
    const beforeSpan = info.blocks.length === 1 ? tagCdataSpan(info.blocks[0].block, 'TopJS') : null;
    const res = updateReportNode(path, { nodeName: 'TopJS', sheet, scope: 'report' });
    return {
      ...res, action: 'set_report_js', nodeName: 'TopJS', mode: 'delete',
      jsBytesBefore: beforeSpan?.bytes ?? 0, jsLinesBefore: beforeSpan?.lines ?? 0,
      jsBytesAfter: 0, jsLinesAfter: 0,
    };
  }

  // 整块写入（替换或新建）：写前核对 expectedSha256 + 缩水护栏
  const { raw } = load(path);
  const info = reportTopJsInfo(raw, sheet);
  const ambiguousGlobal = sheet == null && info.total > 1;
  const wantSha = expectedSha256 !== undefined && expectedSha256 !== null && String(expectedSha256).trim() !== '';
  if (wantSha) {
    if (ambiguousGlobal) {
      throw new Error(`setReportJs: 全文件有 ${info.total} 个 <TopJS>（多表），未传 sheet 无法确定核对/改哪一个（禁止静默命中第一个）。请传 sheet=表索引（0 起）或表名缩小范围。`);
    }
    if (info.blocks.length === 0) {
      throw new Error('setReportJs: 未找到 <TopJS>（传了 expectedSha256，无从核对，拒绝新建）。不传 expectedSha256 则按老行为插入新块。');
    }
    assertExpectedSha256Js(tagCdataSpan(info.blocks[0].block, 'TopJS')?.js, expectedSha256, 'setReportJs');
  }
  const beforeSpan = !ambiguousGlobal && info.blocks.length > 0 ? tagCdataSpan(info.blocks[0].block, 'TopJS') : null;
  const shrinkBefore = beforeSpan
    ? guardJsShrink({
      action: 'setReportJs',
      target: `TopJS(sheet ${sheet ?? 0})`,
      beforeMetrics: beforeSpan,
      afterJs: js,
      allowShrink,
      fixHint: 'TopJS 常是报表初始化共用的一大段 JS，整块替换极易静默丢功能。安全做法：①只改其中片段 → 传 patchFind + patchReplace（块内其余原文原样保留）；②确实要整块替换 → 传 allowShrink:true（写前用 read_cpt 的 jsBlocks[].topJsBytes/topJsLines 核对）。',
    })
    : null;
  const safeJs = assertSafeCdata(String(js), '报表JS');
  const body = `<![CDATA[${safeJs}]]>`;
  const res = updateReportNode(path, { nodeName: 'TopJS', xmlBody: body, sheet, scope: 'report' });
  const after = jsMetricsOf(safeJs);
  return {
    ...res, action: 'set_report_js', nodeName: 'TopJS', mode: 'replace',
    jsBytesBefore: beforeSpan?.bytes ?? 0, jsLinesBefore: beforeSpan?.lines ?? 0,
    jsBytesAfter: after.bytes, jsLinesAfter: after.lines,
    ...(shrinkBefore && shrinkBefore.bytes >= LISTENER_SHRINK_MIN_OLD_BYTES
      ? { hint: `已整块替换 ${shrinkBefore.bytes}B/${shrinkBefore.lines}行 的 TopJS（新 ${after.bytes}B/${after.lines}行）。若只想改其中一段，优先用 patchFind/patchReplace 片段替换，可保留其余原文。` }
      : {}),
  };
}

/**
 * 增/改/删 WebWriteContent 内子节点（EditRowColor/WebWrite/RptLocation/UnloadCheck/ShowWidgets/OtherAttr）。
 *
 * 2026-10-20 修复（P0）：缺容器时不再走 updateReportNode 兜底——旧实现会把容器插到最后一个
 * </Report> 前（即 <Report> 子级、<ReportWebAttr> 之外），FR 填报预览读不到，工具栏按钮/
 * 填报 Web 事件全部静默失效，而 validate/quality/引擎不查容器归属，四件套照样全绿。
 * 现在统一走 ensureWebWriteContainer：无容器 → 在 ReportWebAttr 内创建默认骨架；
 * 容器在别处 → 连同全部子节点整体搬回。传 repair:true 表示「只修容器位置，不改子节点」。
 *
 * webWriteExtras 是白名单：避免模型自由发挥写出设计器不认的子节点。
 * 传空值即删（与 set_report_settings 的覆盖语义一致）；ToolBars 仅支持删（增改请用 set_fill_toolbar）。
 */
const WWC_ALLOWED = new Set(['EditRowColor', 'WebWrite', 'RptLocation', 'UnloadCheck', 'ShowWidgets', 'OtherAttr', 'ToolBars']);
export function setWebWriteExtras(path, {
  editRowColor, webWrite, rptLocation, unloadCheck, showWidgets, otherAttr, toolBars, repair,
} = {}) {
  const payload = { EditRowColor: editRowColor, WebWrite: webWrite, RptLocation: rptLocation, UnloadCheck: unloadCheck, ShowWidgets: showWidgets, OtherAttr: otherAttr, ToolBars: toolBars };
  // 仅处理用户实际传的 key（undefined 不动）
  const updates = Object.entries(payload).filter(([, v]) => v !== undefined);
  const wantRepair = repair === true || repair === 'true' || repair === 1;
  if (updates.length === 0 && !wantRepair) {
    throw new Error('setWebWriteExtras: 至少传一个 WebWriteContent 子节点字段（要删可用 webWrite=null；只修容器位置请传 repair:true）');
  }

  // 先确保容器存在且位于 ReportWebAttr 内（缺则创建，错位则搬回）
  const ensured = ensureWebWriteContainer(path, { createIfMissing: true });
  const repaired = ensured.changed ? { repaired: ensured.action, repairNotes: ensured.notes } : {};
  const { raw } = load(path);
  const wwc = locateWebWriteContent(raw);
  if (!wwc) throw new Error('setWebWriteExtras: 未能定位/创建模板级 <WebWriteContent>');
  const bytes = (x) => Buffer.byteLength(x, 'utf8');
  if (updates.length === 0) {
    return { action: 'set_webwrite_extras', mode: ensured.changed ? 'repair' : 'noop', changed: [], ...repaired, bytes: bytes(raw) };
  }

  const SIMPLE = new Set(['EditRowColor', 'WebWrite', 'RptLocation', 'UnloadCheck', 'ShowWidgets', 'OtherAttr']);
  const segStart = wwc.openEnd + 1;
  const segEnd = wwc.end;
  let newSeg = raw.slice(segStart, segEnd);
  const changed = [];
  for (const [node, val] of updates) {
    if (node === 'ToolBars') {
      if (val === null) {
        // ToolBars 仅支持删除：掩码 CDATA 后按标签边界定位（按钮 JS 的 CDATA 里可能含字面量）
        const masked = newSeg.replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, (c) => ' '.repeat(c.length));
        const hits = [];
        const re = /<ToolBars\b[^>]*>/g;
        let m;
        while ((m = re.exec(masked)) !== null) hits.push(m.index);
        const removals = [];
        for (const idx of hits) {
          const openEnd = masked.indexOf('>', idx);
          if (openEnd < 0) continue;
          const selfClose = masked.slice(idx, openEnd + 1).trim().endsWith('/>');
          const closeAt = selfClose ? openEnd + 1 : masked.indexOf('</ToolBars>', openEnd + 1);
          if (closeAt < 0) throw new Error('WebWriteContent 内 <ToolBars> 未闭合');
          const stop = selfClose ? closeAt : closeAt + '</ToolBars>'.length;
          const s = idx > 0 && newSeg[idx - 1] === '\n' ? idx - 1 : idx;
          removals.push([s, stop]);
        }
        for (const [s, e] of removals.sort((a, b) => b[0] - a[0])) newSeg = newSeg.slice(0, s) + newSeg.slice(e);
        if (removals.length > 0) changed.push('ToolBars(deleted)');
        continue;
      }
      continue; // 不接受 toolBars 字符串（非本工具范围，引导用 set_fill_toolbar）
    }
    if (!SIMPLE.has(node)) continue;
    // 自闭合节点（新值或删）
    if (val === null) {
      // 删
      const r = new RegExp(`<${node}\\b[^>]*/>\\n?`, 'g');
      const before = newSeg;
      newSeg = newSeg.replace(r, '');
      if (newSeg !== before) changed.push(`${node}(deleted)`);
      continue;
    }
    // upsert 自闭合
    const attrs = (typeof val === 'object' && val !== null) ? val : { value: val };
    const attrStr = Object.entries(attrs).map(([k, v]) => `${k}="${escapeXmlAttr(String(v))}"`).join(' ');
    const re = new RegExp(`<${node}\\b[^>]*/>\\n?`);
    const replacement = `<${node} ${attrStr}/>\n`;
    if (re.test(newSeg)) {
      // 函数式替换：replacement 由用户 attributes 插值构造（含 $$/$& 风险）
      newSeg = newSeg.replace(re, () => replacement);
      changed.push(`${node}(updated)`);
    } else {
      // 插入到 WebWriteContent 内容首位
      newSeg = '\n' + replacement + newSeg;
      changed.push(`${node}(inserted)`);
    }
  }
  const out = raw.slice(0, segStart) + newSeg + raw.slice(segEnd);
  if (out === raw) return { action: 'set_webwrite_extras', mode: 'noop', changed: [], ...repaired, bytes: bytes(raw) };
  save(path, out);
  return { action: 'set_webwrite_extras', changed, ...(repaired.repaired ? repaired : {}), bytes: bytes(out) };
}

/** 模板级 WebWriteContent 的默认子节点骨架（与 create_cpt(webWrite=true) 同构，设计器可识别）。 */
const WWC_DEFAULT_CHILDREN = `<ToolBars/>
<EditRowColor setColor="false"/>
<WebWrite SheetPosition="3"/>
<RptLocation isShowAtLeft="true"/>
<UnloadCheck/>
<ShowWidgets/>
<OtherAttr autoStash="false"/>`;

/** 无 <ReportWebAttr> 时创建它所用的默认内容（WebPageContent 骨架，设计器可识别）。 */
const REPORT_WEB_ATTR_SKELETON = `<WebPageContent>
<ToolBars/>
<WebPage isPage="false" showAsImage="false" autoScale="false" tdHeavy="false"/>
</WebPageContent>`;

/** 所有 <WebWriteContent> 开标签位置（findAll 已排除 CDATA/注释里的字面量）。 */
function webWriteContentStarts(raw) {
  const tag = '<WebWriteContent';
  return findAll(raw, tag).filter((i) => {
    const ch = raw[i + tag.length];
    return ch != null && /[\s/>]/.test(ch);
  });
}

/** 判断 idx 是否位于 WorkBook 级 <ReportWebAttr> … </ReportWebAttr> 区间内（开标签之后才算）。 */
function reportWebAttrPlacement(raw, idx) {
  let open = -1;
  for (const m of raw.matchAll(/<ReportWebAttr\b[^>]*>/g)) {
    if (m.index > idx) break;
    open = m.index;
  }
  if (open < 0) return { inside: false, open: -1, close: -1 };
  const openEnd = raw.indexOf('>', open) + 1;
  const close = raw.indexOf('</ReportWebAttr>', openEnd);
  const inside = idx > open && (close < 0 || idx < close);
  return { inside, open, close };
}

/** 模板级 <WebPageContent> 的标准骨架（分页预览页；create_cpt(withWebAttr=true) 同构）。 */
const WEB_PAGE_CONTENT_SKELETON = `<WebPageContent>
<ToolBars/>
<WebPage isPage="false" showAsImage="false" autoScale="false" tdHeavy="false"/>
</WebPageContent>`;

/** 所有 <WebPageContent> 开标签位置（findAll 已排除 CDATA/注释里的字面量）。 */
function webPageContentStarts(raw) {
  const tag = '<WebPageContent';
  return findAll(raw, tag).filter((i) => {
    const ch = raw[i + tag.length];
    return ch != null && /[\s/>]/.test(ch);
  });
}

/** 解析模板内全部顶层 WebPageContent 块（含自闭合；嵌套块只保留最外层）。 */
function webPageContentBlocks(raw) {
  const starts = webPageContentStarts(raw);
  const blocks = [];
  for (const start of starts) {
    const openEnd = raw.indexOf('>', start);
    if (openEnd < 0) throw new Error('WebPageContent 开标签不完整');
    const openTag = raw.slice(start, openEnd + 1);
    const selfClosing = openTag.trim().endsWith('/>');
    const closeStart = selfClosing ? openEnd + 1 : raw.indexOf('</WebPageContent>', openEnd + 1);
    if (closeStart < 0) throw new Error('WebPageContent 未闭合（缺失 </WebPageContent>）');
    const end = selfClosing ? closeStart : closeStart + '</WebPageContent>'.length;
    blocks.push({ start, openEnd, openTag, selfClosing, closeStart, end });
  }
  return blocks.filter((b) => !blocks.some((o) => o !== b && b.start > o.start && b.start < o.end));
}

/** 把 WebPageContent 容器放进 WorkBook 级 ReportWebAttr；没有 ReportWebAttr 时创建它。 */
function insertWebPageContainer(raw, containerXml) {
  const openM = raw.match(/<ReportWebAttr\b[^>]*>/);
  if (openM) {
    const openTag = openM[0];
    if (openTag.trim().endsWith('/>')) {
      const attrs = openTag.slice('<ReportWebAttr'.length, openTag.length - 2);
      const expanded = `<ReportWebAttr${attrs}>\n${containerXml}\n</ReportWebAttr>`;
      return raw.slice(0, openM.index) + expanded + raw.slice(openM.index + openTag.length);
    }
    const close = raw.indexOf('</ReportWebAttr>', openM.index);
    if (close < 0) throw new Error('ReportWebAttr 未闭合（缺失 </ReportWebAttr>）');
    return raw.slice(0, close) + containerXml + '\n' + raw.slice(close);
  }
  const firstReport = raw.search(/<Report\b/);
  if (firstReport < 0) throw new Error('模板缺少 <Report> 工作表，无法确定 WebPageContent 的挂载位置');
  const block = `<ReportWebAttr>\n${containerXml}\n</ReportWebAttr>\n`;
  return raw.slice(0, firstReport) + block + raw.slice(firstReport);
}

/**
 * 写 WebPageContent 前确保容器存在且位于 WorkBook 级 ReportWebAttr 内。
 * 分页预览 afterload 的官方落点是 <ReportWebAttr><WebPageContent>；若模板已有但被
 * 放到 Report 子级/外层，会搬回；缺容器时创建标准骨架；自闭合容器展开。
 * @returns {{raw:string, repaired:'created'|'moved'|'expanded'|undefined, notes:string[]}}
 */
function ensureWebPageContainerForWrite(path) {
  const { raw } = load(path);
  const blocks = webPageContentBlocks(raw);
  const placements = blocks.map((b) => ({ block: b, placement: reportWebAttrPlacement(raw, b.start) }));
  const inside = placements.filter((p) => p.placement.inside);
  if (inside.length > 1) {
    throw new Error(`setWebPageJs: ReportWebAttr 内存在 ${inside.length} 个 <WebPageContent>，无法确定操作哪一个；请先人工删除多余容器`);
  }
  if (inside.length === 1) {
    const { block } = inside[0];
    if (!block.selfClosing) return { raw, repaired: undefined, notes: [] };
    const attrs = block.openTag.slice('<WebPageContent'.length, block.openTag.length - 2);
    const expanded = `<WebPageContent${attrs}>\n<ToolBars/>\n<WebPage isPage="false" showAsImage="false" autoScale="false" tdHeavy="false"/>\n</WebPageContent>`;
    const out = raw.slice(0, block.start) + expanded + raw.slice(block.end);
    save(path, out);
    return { raw: out, repaired: 'expanded', notes: ['WebPageContent 原为自闭合节点，已展开为可挂 Listener 的标准容器'] };
  }
  if (blocks.length === 0) {
    const out = insertWebPageContainer(raw, WEB_PAGE_CONTENT_SKELETON);
    save(path, out);
    return { raw: out, repaired: 'created', notes: ['模板无 <WebPageContent>：已在 WorkBook 级 ReportWebAttr 内创建标准分页预览容器（ToolBars/WebPage）'] };
  }
  if (blocks.length > 1) {
    throw new Error(`setWebPageJs: 模板有 ${blocks.length} 个顶层 <WebPageContent> 且都不在 ReportWebAttr 内，无法自动判定保留哪一个；请先人工删除多余容器`);
  }
  const { block } = placements[0];
  const container = raw.slice(block.start, block.end);
  const without = cutBlock(raw, block.start, block.end);
  const out = insertWebPageContainer(without, container);
  save(path, out);
  return { raw: out, repaired: 'moved', notes: ['WebPageContent 原先不在 ReportWebAttr 内（分页预览读不到），已连同全部子节点整体搬入'] };
}

/** 定位唯一的工作簿级 WebPageContent；无则 null。 */
function locateWebPageContent(raw) {
  const blocks = webPageContentBlocks(raw);
  if (blocks.length === 0) return null;
  const inside = blocks.filter((b) => reportWebAttrPlacement(raw, b.start).inside);
  if (inside.length > 1) throw new Error(`模板存在 ${inside.length} 个 ReportWebAttr 内的 <WebPageContent>，无法确定操作哪一个；请先人工删除多余容器`);
  if (inside.length === 1) return inside[0];
  if (blocks.length === 1) return blocks[0];
  throw new Error(`模板存在 ${blocks.length} 个顶层 <WebPageContent>，无法确定操作哪一个；请先人工删除多余容器`);
}

function webWriteContentBlocks(raw) {
  const starts = webWriteContentStarts(raw);
  const blocks = [];
  for (const start of starts) {
    const openEnd = raw.indexOf('>', start);
    if (openEnd < 0) throw new Error('WebWriteContent 开标签不完整');
    const openTag = raw.slice(start, openEnd + 1);
    const selfClosing = openTag.trim().endsWith('/>');
    const closeStart = selfClosing ? openEnd + 1 : raw.indexOf('</WebWriteContent>', openEnd + 1);
    if (closeStart < 0) throw new Error('WebWriteContent 未闭合（缺失 </WebWriteContent>）');
    const end = selfClosing ? closeStart : closeStart + '</WebWriteContent>'.length;
    blocks.push({ start, openEnd, openTag, selfClosing, closeStart, end });
  }
  return blocks.filter((b) => !blocks.some((o) => o !== b && b.start > o.start && b.start < o.end));
}

/** 从 raw 删除 [start,end) 一段块，并收紧独占行的换行（避免留空行）。 */
function cutBlock(raw, start, end) {
  let s = start;
  let e = end;
  const lineStart = raw.lastIndexOf('\n', s - 1) + 1;
  if (raw.slice(lineStart, s).trim() === '') s = lineStart;
  if (raw[e] === '\r') e += 1;
  if (raw[e] === '\n') e += 1;
  return raw.slice(0, s) + raw.slice(e);
}

/** 把一段 WebWriteContent 容器 XML 放进 WorkBook 级 ReportWebAttr 内；没有 ReportWebAttr 时创建一个。 */
function insertIntoReportWebAttr(raw, containerXml) {
  const openM = raw.match(/<ReportWebAttr\b[^>]*>/);
  if (openM) {
    const openTag = openM[0];
    if (openTag.trim().endsWith('/>')) {
      const attrs = openTag.slice('<ReportWebAttr'.length, openTag.length - 2);
      const expanded = `<ReportWebAttr${attrs}>\n${REPORT_WEB_ATTR_SKELETON}\n${containerXml}\n</ReportWebAttr>`;
      return raw.slice(0, openM.index) + expanded + raw.slice(openM.index + openTag.length);
    }
    const close = raw.indexOf('</ReportWebAttr>', openM.index);
    if (close < 0) throw new Error('ReportWebAttr 未闭合（缺失 </ReportWebAttr>）');
    return raw.slice(0, close) + containerXml + '\n' + raw.slice(close);
  }
  const firstReport = raw.search(/<Report\b/);
  if (firstReport < 0) throw new Error('模板缺少 <Report> 工作表，无法确定 WebWriteContent 的挂载位置');
  const block = `<ReportWebAttr>\n${REPORT_WEB_ATTR_SKELETON}\n${containerXml}\n</ReportWebAttr>\n`;
  return raw.slice(0, firstReport) + block + raw.slice(firstReport);
}

/**
 * 确保模板级 WebWriteContent 存在且位于 WorkBook 级 <ReportWebAttr> 内（FR 填报表单只认这个落点）。
 *
 * 2026-10-20 修复：旧 set_webwrite_extras 缺容器时走 updateReportNode 兜底，会把容器插到
 * 最后一个 </Report> 前（即 <Report> 子级、<ReportWebAttr> 之外）——FR 填报预览读不到，
 * 工具栏按钮/填报 Web 事件全部静默失效；而 validate_cpt/quality_gate 不查容器归属，
 * 四件套照样全绿。本函数成为唯一的正确落点：
 *   · 无容器：在 ReportWebAttr 内创建默认骨架（无 ReportWebAttr 则先创建它）；
 *   · 有容器但在别处：把整块连同全部子节点搬进 ReportWebAttr（内容字节保真）；
 *   · 容器已在正确位置：不动；自闭合容器展开为含默认子节点的块。
 * @param {string} path .cpt 路径
 * @param {{createIfMissing?: boolean}} [opts] createIfMissing=false 时缺容器返回 action='missing'（供工具栏类工具沿用原报错口径）
 * @returns {{raw:string, changed:boolean, action:'ok'|'created'|'moved'|'expanded'|'missing', notes:string[]}}
 */
export function ensureWebWriteContainer(path, { createIfMissing = true } = {}) {
  const { raw } = load(path);
  const blocks = webWriteContentBlocks(raw);
  const placements = blocks.map((b) => ({ block: b, placement: reportWebAttrPlacement(raw, b.start) }));
  const inside = placements.filter((p) => p.placement.inside);
  if (inside.length > 1) {
    throw new Error(`ensureWebWriteContainer: ReportWebAttr 内存在 ${inside.length} 个 <WebWriteContent>（自嵌套或重复），无法自动判定保留哪一个；请先人工删除多余容器`);
  }
  if (blocks.length > 1 && inside.length === 0) {
    throw new Error(`ensureWebWriteContainer: 模板有 ${blocks.length} 个顶层 <WebWriteContent> 且都不在 ReportWebAttr 内，无法自动判定保留哪一个；请先人工删除多余容器`);
  }
  if (inside.length === 1) {
    const { block } = inside[0];
    if (!block.selfClosing) return { raw, changed: false, action: 'ok', notes: [] };
    const attrs = block.openTag.slice('<WebWriteContent'.length, block.openTag.length - 2);
    const expanded = `<WebWriteContent${attrs}>\n${WWC_DEFAULT_CHILDREN}\n</WebWriteContent>`;
    const out = raw.slice(0, block.start) + expanded + raw.slice(block.end);
    save(path, out);
    return { raw: out, changed: true, action: 'expanded', notes: ['WebWriteContent 原为自闭合节点，已展开为含默认子节点的块'] };
  }
  if (blocks.length === 0) {
    if (!createIfMissing) return { raw, changed: false, action: 'missing', notes: ['模板无 <WebWriteContent>'] };
    const container = `<WebWriteContent>\n${WWC_DEFAULT_CHILDREN}\n</WebWriteContent>`;
    const out = insertIntoReportWebAttr(raw, container);
    save(path, out);
    return { raw: out, changed: true, action: 'created', notes: ['模板无 <WebWriteContent>：已在 WorkBook 级 <ReportWebAttr> 内创建默认容器（ToolBars/EditRowColor/WebWrite/RptLocation/UnloadCheck/ShowWidgets/OtherAttr）'] };
  }
  // 有且仅有一个顶层容器，但不在 ReportWebAttr 内 → 连同内容整体搬回
  const { block } = placements[0];
  const container = raw.slice(block.start, block.end);
  const without = cutBlock(raw, block.start, block.end);
  const out = insertIntoReportWebAttr(without, container);
  save(path, out);
  return { raw: out, changed: true, action: 'moved', notes: ['WebWriteContent 原先不在 <ReportWebAttr> 内（FR 填报预览读不到），已连同全部子节点整体搬入 WorkBook 级 <ReportWebAttr>'] };
}

/** 写工具栏/填报事件前确保容器就位：缺容器按各工具原口径抛错；错位则自动搬回并返回 repaired 标记。 */
function ensureWebWriteContainerForWrite(path, missingMessage) {
  const ensured = ensureWebWriteContainer(path, { createIfMissing: false });
  if (ensured.action === 'missing') throw new Error(missingMessage);
  return ensured.changed ? { raw: ensured.raw, repaired: ensured.action, notes: ensured.notes } : { raw: ensured.raw, repaired: undefined, notes: [] };
}

/** 定位模板级 WebWriteContent（须唯一），返回 start/openEnd/closeStart（端点约定与旧实现一致）；无则 null。 */
function locateWebWriteContent(raw) {
  const blocks = webWriteContentBlocks(raw);
  if (blocks.length === 0) return null;
  if (blocks.length > 1) throw new Error(`模板存在 ${blocks.length} 个顶层 <WebWriteContent>，无法确定操作哪一个；请先人工删除多余容器`);
  const b = blocks[0];
  return {
    start: b.start,
    openEnd: b.openEnd,
    openTag: b.openTag,
    selfClosing: b.selfClosing,
    end: b.closeStart,
    inReportWebAttr: reportWebAttrPlacement(raw, b.start).inside,
  };
}

/**
 * 按「标签名边界」定位节点整块（2026-10-23 补）。
 * blockRange 用字面量开标签做前缀匹配，`<Widget` 会连 `<WidgetAttr` 一起算进去 →
 * nodeName="Widget" 这类**有同前缀兄弟标签**的节点永远配不平（实测「未找到闭合 </Widget>」）。
 * 这里改成边界感知（开头后必须紧跟空白 / `/` / `>`），并在 CDATA 掩码上扫描，避免按钮 JS
 * 字符串里的字面标签打乱配对。
 */
function nodeBlockRange(raw, start, nodeName) {
  const masked = raw.replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, (c) => ' '.repeat(c.length));
  const openRe = new RegExp(`<${nodeName}(?=[\\s/>])`, 'g');
  const closeRe = new RegExp(`</${nodeName}>`, 'g');
  const openEnd = raw.indexOf('>', start);
  if (openEnd < 0) throw new Error(`块定位失败：<${nodeName}> 开标签未闭合`);
  let depth = 1;
  let i = openEnd + 1;
  while (i < masked.length) {
    openRe.lastIndex = i;
    closeRe.lastIndex = i;
    const o = openRe.exec(masked);
    const c = closeRe.exec(masked);
    if (!c) throw new Error(`块定位失败：未找到闭合 </${nodeName}>`);
    if (o && o.index < c.index) {
      depth += 1;
      i = o.index + o[0].length;
      continue;
    }
    depth -= 1;
    if (depth === 0) return [start, c.index + c[0].length];
    i = c.index + c[0].length;
  }
  throw new Error(`块定位失败：<${nodeName}> 未闭合`);
}

// ============ 工具栏宿主容器（2026-10-23 补齐） ============//
// 官方 1550 样本实测（2026-10-23 扫描）：752 个文件含 <ToolBars>，宿主只有三种 ——
//   WebWriteContent 585 / WebPageContent 528 / WebViewContent 12（FR 10.0 时代预览工具栏），
//   其中 371 个文件同时有多个容器（双/三工具栏并存是多数情况，不是边缘）。
//   write（默认）= <WebWriteContent> 内 ToolBars —— 填报工具栏（提交/校验/自定义按钮），旧工具一直只认它；
//   page        = <WebPageContent> 内 ToolBars —— 页面工具栏（首页/上一页/页码跳转/下一页/末页…）；
//   view        = <WebViewContent> 内 ToolBars —— 预览工具栏（老模板）。
// 对接跟进表实测：page / write 各有 7 个同名按钮，此前全部工具硬编码 locateWebWriteContent，
// 导致 page 那一整套不可达（match 只存在于 page 的串一律「未找到」，buttonText/index 全落到 write）。
const TOOLBAR_KINDS = ['write', 'page', 'view'];
const TOOLBAR_HOST_NAME = { write: 'WebWriteContent', page: 'WebPageContent', view: 'WebViewContent' };

function normalizeToolbarKind(which, toolName) {
  const k = which == null || String(which).trim() === '' ? 'write' : String(which).trim().toLowerCase();
  if (!TOOLBAR_KINDS.includes(k)) {
    throw new Error(`${toolName}: toolbar 只能是 ${TOOLBAR_KINDS.map((x) => `${x}（${TOOLBAR_HOST_NAME[x]}）`).join(' / ')}，收到 "${which}"`);
  }
  return k;
}

function locateToolbarHost(raw, which = 'write') {
  const name = TOOLBAR_HOST_NAME[which] || 'WebWriteContent';
  const openRe = new RegExp(`<${name}\\b[^>]*>`);
  const m = raw.match(openRe);
  if (!m) return null;
  const start = m.index;
  const open = m[0];
  const selfClosed = open.trim().endsWith('/>');
  if (selfClosed) {
    return { kind: which, name, start, openEnd: start + open.length, end: start + open.length, open, selfClosed: true };
  }
  const [b, e] = blockRange(raw, start, `<${name}`, `</${name}>`);
  return { kind: which, name, start: b, openEnd: b + open.length, end: e, open, selfClosed: false };
}

/** 宿主容器内的 <ToolBars> 块（自闭合也返回） */
function locateToolBarsBlock(raw, host) {
  const seg = raw.slice(host.start, host.end);
  const m = /<ToolBars\b[^>]*>/.exec(seg);
  if (!m) return null;
  const abs = host.start + m.index;
  const open = m[0];
  if (open.trim().endsWith('/>')) {
    return { abs, openEnd: abs + open.length, end: abs + open.length, open, selfClosed: true };
  }
  const closeStart = indexOfOutsideCdata(raw, abs + open.length, '</ToolBars>');
  if (closeStart < 0) throw new Error('<ToolBars> 未闭合或 CDATA 未闭合（按钮 JS 里可能有字面 </ToolBars>）');
  return { abs, openEnd: abs + open.length, end: closeStart + '</ToolBars>'.length, closeStart, open, selfClosed: false };
}

/** 解析「工具栏 + ToolBars 块」；不存在时按容器给出可执行的纠正提示 */
function resolveToolBars(raw, which, toolName) {
  const kind = normalizeToolbarKind(which, toolName);
  const host = locateToolbarHost(raw, kind);
  if (!host) {
    throw new Error(`${toolName}: 模板无 <${TOOLBAR_HOST_NAME[kind]}>（工具栏需挂在其中）`
      + (kind === 'write' ? '。请用 create_cpt(webWrite=true) / build_report(webWrite:true) 生成，或用 set_webwrite_extras({path, repair:true}) 创建容器' : ''));
  }
  const bars = locateToolBarsBlock(raw, host);
  if (!bars || bars.selfClosed) {
    throw new Error(`${toolName}: ${host.name} 内无 <ToolBars> 块（工具栏为空）。请先 add_toolbar_button({toolbar:"${kind}"}) 或 set_fill_toolbar 建栏`);
  }
  return { kind, host, bars };
}

/**
 * 在模板级 WebWriteContent 内 upsert/替换/删除 <Listener event="..."><JavaScript class="...">
 * <Parameters/><Content><![CDATA[js]]></Content></JavaScript></Listener>（填报 Web 事件脚本正文）。
 *
 * 解决反馈缺口：set_webwrite_extras 只支持白名单自闭合叶子节点（EditRowColor 等）；
 * update_report_node 只能定位 Report 块，无法触达模板级 WebWriteContent。
 * 官方样本（82/1550 例，如「导入Excel前清空表.cpt」beforeimportexcel）结构即：
 *   <WebWriteContent><Listener event="..."><JavaScript class="com.fr.js.JavaScriptImpl">
 *     <Parameters/><Content><![CDATA[js]]></Content></JavaScript></Listener></WebWriteContent>
 * event 必填；js 传 null/undefined 且不传 className 视为「替换或写入」（js 必填）。
 * js 传 null → 删除该 event 的 Listener；js 传字符串 → 写入/替换该 event 的 Listener。
 * match：可选。同一 event 可能挂多个 Listener（真实报表如「不动销产品.cpt」有 6 个 afterload），
 *   传 match=JS 中某段特征子串（如 "OP_COL"、"makeRec"）可精确命中目标 Listener；缺省命中第一个。
 * 片段替换（2026-11-03 事故后补）：大块共享 Content 只想改其中一段时，传 patchFind（原文片段，literal 匹配）
 *   + patchReplace（替换文本，缺省空串=删片段）；默认要求唯一命中，patchAll=true 才允许多处。
 *   只改命中片段，块内其余原文（Parameters/className/无关 JS/换行）原样保留，与 js 互斥。
 * 缩水护栏：不带 patchFind 的整块替换若会让旧 Content（≥4KB）缩到 <60% 且少 ≥2KB → 直接拒绝（防止
 *   「187KB 共享大块被换成 8KB、块数/语法/门禁仍全绿但功能全丢」）；确要整块替换传 allowShrink:true。
 */
export function setWebWriteJs(path, { event, js, className = 'com.fr.js.JavaScriptImpl', match, aggregate, expectedSha256, patchFind, patchReplace, patchAll, allowShrink } = {}) {
  if (!event || !String(event).trim()) throw new Error('setWebWriteJs: 必须提供 event（如 "beforeimportexcel"/"beforeappend"/"afterappend"/"writesuccess"/"beforedelete" 等）');
  // 片段替换（patchFind/patchReplace）与整块写入（js）/合并（aggregate）互斥：
  // 大块共享 Content（如 187KB 的 afterload）想改一段时必须走片段替换，避免整块换成小段丢功能（2026-11-03 事故）。
  const patchMode = patchFind !== undefined && patchFind !== null && String(patchFind) !== '';
  if (patchMode) {
    if (js != null) throw new Error('setWebWriteJs: patchFind/patchReplace 是「片段替换」，不能同时传 js（整块替换）—— 只改一段请只传 patchFind(+patchReplace)；整块替换请只传 js（大块需 allowShrink:true）。');
    if (aggregate) throw new Error('setWebWriteJs: patchFind 不能与 aggregate 联用（片段替换 vs 合并追加，语义互斥）。');
  }
  assertPatchArgs({ action: 'setWebWriteJs', patchMode, patchFind, patchReplace });
  // 2026-10-20 修复：写前确保容器在 ReportWebAttr 内（缺容器仍按原口径报错；错位自动搬回）
  const ensured = ensureWebWriteContainerForWrite(path,
    'setWebWriteJs: 模板无 <WebWriteContent>（填报 Web 事件需挂在其中）。请用 create_cpt(webWrite=true) 或 build_report(webWrite:true) 生成含 WebWriteContent 的模板，或用 set_webwrite_extras({path, repair:true}) 创建容器');
  const repairedNote = ensured.repaired ? { repaired: ensured.repaired, repairNotes: ensured.notes } : {};
  const { raw } = load(path);
  const wwc = locateWebWriteContent(raw);
  if (!wwc) throw new Error('setWebWriteJs: 模板无 <WebWriteContent>（填报 Web 事件需挂在其中）。请用 create_cpt(webWrite=true) 或 build_report 生成含 WebWriteContent 的模板');
  const seg = raw.slice(wwc.start, wwc.end);

  // 定位 WebWriteContent 内指定 event 的 <Listener>（同一 event 可挂多个，match 精确命中）。
  // 先全量收集该 event 的所有块，再按 match 判定目标——无 match 且多块时必须拒绝，禁止静默命中第一个。
  const lmRe = new RegExp(`<Listener\\s+event="${escapeXmlAttr(String(event))}"[^>]*>[\\s\\S]*?</Listener>`, 'g');
  let lmHit, lmIndex = -1, blocks = [];
  while ((lmHit = lmRe.exec(seg)) !== null) blocks.push({ block: lmHit[0], index: lmHit.index });
  if (match) {
    const hit = blocks.find((b) => b.block.includes(String(match)));
    if (hit) lmIndex = hit.index;
  } else if (blocks.length === 1) {
    lmIndex = blocks[0].index;
  }
  const listenerStart = lmIndex >= 0 ? wwc.start + lmIndex : -1;

  // 【M89 防误删】同一 event 挂多个 Listener 且未传 match → 拒绝执行（禁止静默命中第一个块）。
  // 上次误删根因：模板 3 个 afterload（frFin/legacy/诊断），缺省静默改/删第一块导致错改。
  // 必须先 get_webwrite_js 读回确认块数，再传 match 特征子串精确定位。
  // 例外：aggregate=true 是「按合并约定把散块并回一块」，不选目标而是全并，故不放行时不算静默命中。
  if (!match && blocks.length > 1 && !aggregate) {
    throw new Error(`setWebWriteJs: WebWriteContent 内 event="${event}" 有 ${blocks.length} 个 Listener，未传 match 无法确定改哪一块（禁止静默命中第一个）。请先 get_webwrite_js(event="${event}") 读回各块 JS，再传 match=目标 JS 独有的特征子串（如 "frFin"/"legacyCalc"/"rowCalc"）精确定位后重试；若本意是执行「同事件类型 JS 合并为一个代码块」约定，改传 aggregate=true。`);
  }

  // 片段替换模式：只改目标 Listener Content 里的一段，块内其余原文（Parameters/className/无关 JS/换行）原样保留。
  if (patchMode) {
    let target = null;
    if (match !== undefined && match !== null && String(match).trim() !== '') {
      target = blocks.find((b) => b.block.includes(String(match))) || null;
      if (!target) throw new Error(`setWebWriteJs: WebWriteContent 内未找到 event="${event}" 且含 "${match}" 的 Listener`);
    } else if (blocks.length === 1) {
      target = blocks[0];
    } else if (blocks.length === 0) {
      throw new Error(`setWebWriteJs: WebWriteContent 内未找到 event="${event}" 的 Listener，无法片段替换（patchFind/patchReplace 只改已存在块；要新建请传 js）。文件未改动。`);
    }
    assertExpectedSha256(target.block, expectedSha256, 'setWebWriteJs');
    const absStart = wwc.start + target.index;
    const patched = applyListenerPatch({ action: 'setWebWriteJs', event, block: target.block, patchFind, patchReplace, patchAll });
    const out = replaceListenerBlockInRaw(raw, absStart, target.block, patched.block);
    save(path, out);
    return {
      action: 'set_webwrite_js', event, mode: 'patch', match: match ?? null, patchHits: patched.hits, ...repairedNote,
      ...patchMatchNote(patched.matchedBy),
      jsBytesBefore: patched.before.bytes, jsBytesAfter: patched.after.bytes,
      jsLinesBefore: patched.before.lines, jsLinesAfter: patched.after.lines,
      bytes: Buffer.byteLength(out, 'utf8'),
      hint: `已片段替换 ${patched.hits} 处（只改命中片段，Listener 其余原文未动）。修改后建议重跑 check_report_js/validate_cpt。`,
    };
  }

  // F1 自卫：传了 expectedSha256 则替换/删除前核对目标块的当前 sha（不符抛错且不写文件）。
  // aggregate 改写多块、无法单块核对 → 拒绝联用；无目标块 → 拒绝新建（无法核对）。
  // 不传 expectedSha256 则老行为不变。
  if (expectedSha256 !== undefined && expectedSha256 !== null && String(expectedSha256).trim() !== '') {
    if (aggregate) {
      throw new Error('setWebWriteJs: expectedSha256 不能与 aggregate 联用（合并改写多块，无法单块核对）。请先 get_webwrite_js 读回各块 sha256，用 match 逐块改写。');
    }
    const target = match ? blocks.find((b) => b.block.includes(String(match))) : blocks[0];
    if (!target) {
      throw new Error(match
        ? `setWebWriteJs: WebWriteContent 内未找到 event="${event}" 且含 "${match}" 的 Listener`
        : `setWebWriteJs: WebWriteContent 内未找到 event="${event}" 的 Listener（传了 expectedSha256，无从核对，拒绝新建）。不传 expectedSha256 则按老行为插入新块。`);
    }
    assertExpectedSha256(target.block, expectedSha256, 'setWebWriteJs');
  }

  // 【JS 合并约定】aggregate 聚合/合并模式（与 setReportListener 同口径、同语义）：
  // 同一容器（WebWriteContent）内相同事件类型的 JS 只允许一个 <Listener> 代码块。
  //   · 已有 ≥2 块 → 全部并入首块并删除多余块（JS 按文档顺序拼接，不丢内容），mode='merge'；
  //   · 已有 1 块  → 追加新 JS，mode='append'；无块 + 有 js → 落到下方插入逻辑；
  //   · 未传 js    → 只合并现有散块，绝不删除不新建。
  if (aggregate) {
    const hits = blocks.map((x) => ({ start: wwc.start + x.index, block: x.block }));
    const safeJsAgg = js == null ? null : assertSafeCdata(String(js), 'WebWrite JS');
    if (hits.length > 0) {
      const merged = mergeListenerJs(hits, safeJsAgg);
      const out = mergeListenerBlocks(raw, hits, listenerNode({ event, js: merged, className }));
      save(path, out);
      const mode = hits.length > 1 ? 'merge' : safeJsAgg != null ? 'append' : 'noop';
      return {
        action: 'set_webwrite_js', event, mode, mergedBlocks: hits.length, ...repairedNote, bytes: Buffer.byteLength(out, 'utf8'),
        hint: hits.length > 1
          ? `已把 ${hits.length} 个 event="${event}" 的 WebWrite 监听合并为 1 个代码块（JS 按文档顺序拼接，无内容丢失）。注意与既有 JS 的变量/函数重名冲突。`
          : safeJsAgg != null
            ? '已把 JS 追加进现有 WebWrite 监听的 Content（按事件类型聚合）。注意与既有 JS 的变量/函数重名冲突。'
            : `event="${event}" 只有 1 个 WebWrite 监听块，无需合并。`,
      };
    }
    if (safeJsAgg == null) {
      return {
        action: 'set_webwrite_js', event, mode: 'noop', mergedBlocks: 0, ...repairedNote, bytes: Buffer.byteLength(raw, 'utf8'),
        hint: `event="${event}" 无 WebWrite 监听块且未提供 js：aggregate 模式不新建也不删除，本次未做改动。`,
      };
    }
    // 无现有监听且带 js：落到下方插入逻辑（新建唯一块）
  }

  if (js == null) {
    // 删除模式
    if (listenerStart < 0) throw new Error(`setWebWriteJs: WebWriteContent 内未找到 event="${event}" 的 Listener`);
    const absEnd = raw.indexOf('</Listener>', listenerStart) + '</Listener>'.length;
    // 连同其后换行一起删
    let e = absEnd;
    while (e < raw.length && (raw[e] === '\n' || raw[e] === '\r')) e++;
    const out = raw.slice(0, listenerStart) + raw.slice(e);
    save(path, out);
    return { action: 'set_webwrite_js', event, mode: 'delete', ...repairedNote, bytes: Buffer.byteLength(out, 'utf8') };
  }

  const safeJs = assertSafeCdata(String(js), 'WebWrite JS');
  const node = `<Listener event="${escapeXmlAttr(String(event))}">
<JavaScript class="${escapeXmlAttr(className)}">
<Parameters/>
<Content>
<![CDATA[${safeJs}]]></Content>
</JavaScript>
</Listener>\n`;
  let out;
  let shrinkBefore = null;
  if (listenerStart >= 0) {
    // 替换
    const absEnd = raw.indexOf('</Listener>', listenerStart) + '</Listener>'.length;
    // 缩水护栏：大块共享 Content 禁止整块换成小段（想改一段请走 patchFind/patchReplace；确要整块替换传 allowShrink:true）。
    shrinkBefore = guardListenerShrink({ action: 'setWebWriteJs', event, match, beforeBlock: raw.slice(listenerStart, absEnd), afterJs: safeJs, allowShrink });
    out = raw.slice(0, listenerStart) + node + raw.slice(absEnd);
  } else {
    // 传了 match 却未命中 → 定位失败，拒绝静默插入（避免误建重复 Listener）
    if (match !== undefined && match !== null && String(match).trim() !== '') {
      throw new Error(`setWebWriteJs: WebWriteContent 内未找到 event="${event}" 且含 "${match}" 的 Listener`);
    }
    // 插入到 WebWriteContent 开标签之后
    const headClose = raw.indexOf('>', wwc.start) + 1;
    out = raw.slice(0, headClose) + '\n' + node + raw.slice(headClose);
  }
  save(path, out);
  const afterWrite = jsMetricsOf(safeJs);
  return {
    action: 'set_webwrite_js', event, mode: listenerStart >= 0 ? 'update' : 'insert', ...repairedNote,
    ...(shrinkBefore ? { jsBytesBefore: shrinkBefore.bytes, jsLinesBefore: shrinkBefore.lines } : {}),
    jsBytesAfter: afterWrite.bytes, jsLinesAfter: afterWrite.lines,
    bytes: Buffer.byteLength(out, 'utf8'),
    ...(shrinkBefore && shrinkBefore.bytes >= LISTENER_SHRINK_MIN_OLD_BYTES
      ? { hint: `已整块替换 ${shrinkBefore.bytes}B/${shrinkBefore.lines}行 的共享大块（新 ${afterWrite.bytes}B/${afterWrite.lines}行）。若只想改其中一段，优先用 patchFind/patchReplace 片段替换，可保留其余原文。` }
      : {}),
  };
}

/**
 * 写模板级 <ReportWebAttr><WebPageContent> 的分页预览 Web 事件脚本（afterload 等）。
 *
 * 背景：官方 1550 份模板中 528 份有 WebPageContent、其中 50 份挂 Listener（全部 afterload）；
 * 该容器里的脚本在分页预览加载结束时执行。旧工具集只能：
 *   · set_report_listener → 只写 Report 块里的 Listener（会改错容器/找不到）；
 *   · set_webwrite_js   → 只写 WebWriteContent；
 *   · update_report_node → 低层整节点改写，容易把同块里的审批人注入等 JS 一起覆盖。
 * 本工具按 Listener 粒度定向编辑，默认保留块内其余字节；大块只改一段用 patchFind/patchReplace。
 *
 * 容器修复：缺 WebPageContent → 在 ReportWebAttr 内建标准骨架；自闭合 → 展开；错位 → 搬回。
 * 防误改：同 event 多 Listener 且未传 match → 拒绝静默命中第一个；expectedSha256 可写前核对；
 * 整块替换有缩水护栏（allowShrink=true 才放行）。
 */
export function setWebPageJs(path, { event, js, className = 'com.fr.js.JavaScriptImpl', match, aggregate, expectedSha256, patchFind, patchReplace, patchAll, allowShrink } = {}) {
  if (!event || !String(event).trim()) throw new Error('setWebPageJs: 必须提供 event（分页预览事件，如 "afterload"）');
  const patchMode = patchFind !== undefined && patchFind !== null && String(patchFind) !== '';
  if (patchMode) {
    if (js != null) throw new Error('setWebPageJs: patchFind/patchReplace 是「片段替换」，不能同时传 js（整块替换）—— 只改一段请只传 patchFind(+patchReplace)；整块替换请只传 js（大块需 allowShrink:true）。');
    if (aggregate) throw new Error('setWebPageJs: patchFind 不能与 aggregate 联用（片段替换 vs 合并追加，语义互斥）。');
  }
  assertPatchArgs({ action: 'setWebPageJs', patchMode, patchFind, patchReplace });

  const hasMatch = match !== undefined && match !== null && String(match).trim() !== '';
  /** 取容器内指定 event 的 Listener 块（不写文件；供写前预检与主流程共用）。 */
  const eventListenerBlocks = (rawText, wpcBlock) => {
    const seg = rawText.slice(wpcBlock.start, wpcBlock.end);
    const lmRe = new RegExp(`<Listener\\s+event="${escapeXmlAttr(String(event))}"[^>]*>[\\s\\S]*?</Listener>`, 'g');
    let lmHit;
    const list = [];
    while ((lmHit = lmRe.exec(seg)) !== null) list.push({ block: lmHit[0], index: lmHit.index });
    return list;
  };

  // 【安全预检】patch / delete / aggregate-无js 都是「只改已存在块」：容器缺失或 match 未命中时
  // 不得先建容器/搬容器再失败（避免留下骨架或位置变更）。这些模式直接读原文操作。
  const needsExisting = patchMode || js == null;
  let raw;
  let wpc;
  let repairedNote = {};
  if (needsExisting) {
    const pre = load(path);
    const wpcPre = locateWebPageContent(pre.raw);
    if (!wpcPre) {
      if (js == null && aggregate && !patchMode) {
        return {
          action: 'set_webpage_js', event, mode: 'noop', mergedBlocks: 0, bytes: Buffer.byteLength(pre.raw, 'utf8'),
          hint: `event="${event}" 无 WebPageContent 监听块且未提供 js：aggregate 模式不新建也不删除，本次未做改动。`,
        };
      }
      throw new Error('setWebPageJs: 模板无 <WebPageContent>（分页预览事件需挂在其中）—— 文件未改动');
    }
    raw = pre.raw;
    wpc = wpcPre;
  } else {
    // 带 match 的整块写入只允许改已存在块：先确认命中，避免「先建容器再报未找到」。
    if (hasMatch) {
      const pre = load(path);
      const wpcPre = locateWebPageContent(pre.raw);
      if (!wpcPre) throw new Error(`setWebPageJs: 模板无 <WebPageContent>，且无法定位 event="${event}" 含 "${match}" 的 Listener —— 文件未改动`);
      if (!eventListenerBlocks(pre.raw, wpcPre).some((b) => b.block.includes(String(match)))) {
        throw new Error(`setWebPageJs: WebPageContent 内未找到 event="${event}" 且含 "${match}" 的 Listener —— 文件未改动`);
      }
    }
    const ensured = ensureWebPageContainerForWrite(path);
    repairedNote = ensured.repaired ? { repaired: ensured.repaired, repairNotes: ensured.notes } : {};
    const post = load(path);
    raw = post.raw;
    wpc = locateWebPageContent(raw);
    if (!wpc) throw new Error('setWebPageJs: 模板无 <WebPageContent>（分页预览事件需挂在其中）');
  }

  // 定位 WebPageContent 内指定 event 的 Listener（同一 event 可挂多个，match 精确命中）。
  const blocks = eventListenerBlocks(raw, wpc);
  if (!hasMatch && blocks.length > 1 && !aggregate) {
    throw new Error(`setWebPageJs: WebPageContent 内 event="${event}" 有 ${blocks.length} 个 Listener，未传 match 无法确定改哪一块（禁止静默命中第一个）。请先 get_report_listener(event="${event}") 读回各块 JS（area=webpage/scope=workbook），再传 match=目标 JS 独有的特征子串精确定位；若本意是执行「同事件类型 JS 合并为一个代码块」约定，改传 aggregate=true。`);
  }
  const pickTarget = ({ allowMissing = false } = {}) => {
    if (hasMatch) {
      const hit = blocks.find((b) => b.block.includes(String(match)));
      if (!hit) throw new Error(`setWebPageJs: WebPageContent 内未找到 event="${event}" 且含 "${match}" 的 Listener`);
      return hit;
    }
    if (blocks.length === 0) {
      if (allowMissing) return null;
      throw new Error(`setWebPageJs: WebPageContent 内未找到 event="${event}" 的 Listener`);
    }
    return blocks[0];
  };

  if (patchMode) {
    const target = pickTarget();
    assertExpectedSha256(target.block, expectedSha256, 'setWebPageJs');
    const absStart = wpc.start + target.index;
    const patched = applyListenerPatch({ action: 'setWebPageJs', event, block: target.block, patchFind, patchReplace, patchAll });
    const out = replaceListenerBlockInRaw(raw, absStart, target.block, patched.block);
    save(path, out);
    return {
      action: 'set_webpage_js', event, mode: 'patch', match: match ?? null, patchHits: patched.hits, ...repairedNote,
      ...patchMatchNote(patched.matchedBy),
      jsBytesBefore: patched.before.bytes, jsBytesAfter: patched.after.bytes,
      jsLinesBefore: patched.before.lines, jsLinesAfter: patched.after.lines,
      bytes: Buffer.byteLength(out, 'utf8'),
      hint: `已片段替换 ${patched.hits} 处（只改命中片段，Listener/WebPageContent 其余原文未动）。修改后建议重跑 check_report_js/validate_cpt。`,
    };
  }

  if (expectedSha256 !== undefined && expectedSha256 !== null && String(expectedSha256).trim() !== '') {
    if (aggregate) {
      throw new Error('setWebPageJs: expectedSha256 不能与 aggregate 联用（合并改写多块，无法单块核对）。请先 get_report_listener 读回各块 sha256，用 match 逐块改写。');
    }
    const target = pickTarget();
    assertExpectedSha256(target.block, expectedSha256, 'setWebPageJs');
  }

  // 同 event 聚合（与 set_report_listener/set_webwrite_js 同口径）：散块并回一块，按文档顺序拼接不丢内容。
  if (aggregate) {
    const hits = blocks.map((x) => ({ start: wpc.start + x.index, block: x.block }));
    const safeJsAgg = js == null ? null : assertSafeCdata(String(js), 'WebPage JS');
    if (hits.length > 0) {
      const merged = mergeListenerJs(hits, safeJsAgg);
      const out = mergeListenerBlocks(raw, hits, listenerNode({ event, js: merged, className }));
      save(path, out);
      const mode = hits.length > 1 ? 'merge' : safeJsAgg != null ? 'append' : 'noop';
      return {
        action: 'set_webpage_js', event, mode, mergedBlocks: hits.length, ...repairedNote, bytes: Buffer.byteLength(out, 'utf8'),
        hint: hits.length > 1
          ? `已把 ${hits.length} 个 event="${event}" 的 WebPageContent 监听合并为 1 个代码块（JS 按文档顺序拼接，无内容丢失）。注意与既有 JS 的变量/函数重名冲突。`
          : safeJsAgg != null
            ? '已把 JS 追加进现有 WebPageContent 监听的 Content（按事件类型聚合）。注意与既有 JS 的变量/函数重名冲突。'
            : `event="${event}" 只有 1 个 WebPageContent 监听块，无需合并。`,
      };
    }
    if (safeJsAgg == null) {
      return {
        action: 'set_webpage_js', event, mode: 'noop', mergedBlocks: 0, ...repairedNote, bytes: Buffer.byteLength(raw, 'utf8'),
        hint: `event="${event}" 无 WebPageContent 监听块且未提供 js：aggregate 模式不新建也不删除，本次未做改动。`,
      };
    }
    // 无现有监听且带 js：落到下方插入逻辑（新建唯一块）
  }

  if (js == null) {
    const target = pickTarget();
    const listenerStart = wpc.start + target.index;
    const absEnd = raw.indexOf('</Listener>', listenerStart) + '</Listener>'.length;
    let e = absEnd;
    while (e < raw.length && (raw[e] === '\n' || raw[e] === '\r')) e++;
    const out = raw.slice(0, listenerStart) + raw.slice(e);
    save(path, out);
    return { action: 'set_webpage_js', event, mode: 'delete', ...repairedNote, bytes: Buffer.byteLength(out, 'utf8') };
  }

  const safeJs = assertSafeCdata(String(js), 'WebPage JS');
  const node = `<Listener event="${escapeXmlAttr(String(event))}">
<JavaScript class="${escapeXmlAttr(className)}">
<Parameters/>
<Content>
<![CDATA[${safeJs}]]></Content>
</JavaScript>
</Listener>\n`;
  const target = blocks.length === 0 ? null : pickTarget({ allowMissing: true });
  let out;
  let shrinkBefore = null;
  if (target) {
    const listenerStart = wpc.start + target.index;
    const absEnd = raw.indexOf('</Listener>', listenerStart) + '</Listener>'.length;
    shrinkBefore = guardListenerShrink({ action: 'setWebPageJs', event, match, beforeBlock: raw.slice(listenerStart, absEnd), afterJs: safeJs, allowShrink });
    out = raw.slice(0, listenerStart) + node + raw.slice(absEnd);
  } else {
    if (hasMatch) throw new Error(`setWebPageJs: WebPageContent 内未找到 event="${event}" 且含 "${match}" 的 Listener`);
    const headClose = raw.indexOf('>', wpc.start) + 1;
    out = raw.slice(0, headClose) + '\n' + node + raw.slice(headClose);
  }
  save(path, out);
  const afterWrite = jsMetricsOf(safeJs);
  return {
    action: 'set_webpage_js', event, mode: target ? 'update' : 'insert', ...repairedNote,
    ...(shrinkBefore ? { jsBytesBefore: shrinkBefore.bytes, jsLinesBefore: shrinkBefore.lines } : {}),
    jsBytesAfter: afterWrite.bytes, jsLinesAfter: afterWrite.lines,
    bytes: Buffer.byteLength(out, 'utf8'),
    ...(shrinkBefore && shrinkBefore.bytes >= LISTENER_SHRINK_MIN_OLD_BYTES
      ? { hint: `已整块替换 ${shrinkBefore.bytes}B/${shrinkBefore.lines}行 的共享大块（新 ${afterWrite.bytes}B/${afterWrite.lines}行）。若只想改其中一段，优先用 patchFind/patchReplace 片段替换，可保留其余原文。` }
      : {}),
  };
}

/** 在 raw 中从 from 起找第一个不在 CDATA 区内的 needle（跳过 <![CDATA[ ... ]]> 跨度）。
 *  朴素 indexOf/blockRange 会被按钮 JS CDATA 里的字面 '</ToolBar>' 等提前闭合（LOW-5）。 */
function indexOfOutsideCdata(raw, from, needle) {
  let i = from;
  while (i < raw.length) {
    const hit = raw.indexOf(needle, i);
    if (hit < 0) return -1;
    const seg = raw.slice(from, hit);
    const opens = seg.split('<![CDATA[').length - 1;
    const closes = seg.split(']]>').length - 1;
    if (opens === closes) return hit;
    i = hit + needle.length;
  }
  return -1;
}

/** 提取 CustomToolBarButton 的 <Text> 显示文字：兼容 CDATA 与纯文本两种官方/手工形态，统一 trim。
 *  用于重名检查（MEDIUM-2：纯文本 <Text>、CDATA 带空格都会穿透精确相等比较）。 */
function extractButtonText(block) {
  const cd = block.match(/<Text>\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*<\/Text>/);
  if (cd) return cd[1].trim();
  const plain = block.match(/<Text>\s*([\s\S]*?)\s*<\/Text>/);
  return plain ? plain[1].trim() : '';
}

/**
 * 【新增】填报工具栏自定义按钮（CustomToolBarButton）—— 补齐 setToolbarButtonJs 只能写
 * 「已有按钮」JS 的缺口。官方结构（与 setToolbarButtonJs 注释同源，13/1550 例实证，如
 * multipage.cpt「上一页」、SelectPrint.cpt「打印」）：
 *   <WebWriteContent><ToolBars><ToolBarManager><Location><Embed position="1"/></Location>
 *   <ToolBar><Widget class="com.fr.form.ui.CustomToolBarButton"><WidgetAttr/><Text>按钮文字</Text>
 *     <IconName/><JavaScript class="com.fr.js.JavaScriptImpl"><Parameters/><Content>JS</Content></JavaScript></Widget>
 *   </ToolBar></ToolBarManager></ToolBars></WebWriteContent>
 * buttonText 必填（按钮 <Text> 显示文字）；iconName 可选（图标名，缺省空）；
 * js 可选 —— 传了则按钮内直接带 JS（<JavaScript class="...JavaScriptImpl">），不传则只建空按钮，
 * 之后可用 setToolbarButtonJs 补 JS（这正是本工具存在的意义：先把按钮建出来）。
 * 【内置按钮通道】builtin 可选：submit / verify / append-row / delete-row / import-append（导入Excel，追加）/
 * import-clean（导入Excel，清空后导入）—— 追加设计器内置按钮，自带 i18n 文案与图标，行为由 FR 内置实现。
 * 该通道只按 class 判重（已存在幂等返回 already-present），栏内既有按钮一律原样保留；
 * 与 set_fill_toolbar 的分工：set_fill_toolbar = 整栏重建（会冲掉自定义按钮），本通道 = 只追加一颗。
 * 插入策略（与 setFillToolbar 同族，兼容全部落盘形态）：
 *   - 模板无 <WebWriteContent> → 报错（非填报模板，请 create_cpt(webWrite=true) / build_report）
 *   - WebWriteContent 自闭合 → 展开为块并写入完整 ToolBars
 *   - WebWriteContent 内无 <ToolBars> → 在开标签后插入完整 ToolBars
 *   - <ToolBars/> 自闭合 → 替换为完整块
 *   - <ToolBars>...</ToolBars>：块内 ToolBar 自闭合 → 展开；否则把新按钮追加到 </ToolBar> 之前
 * 重名（同 ToolBar 内已有相同 <Text> 的 CustomToolBarButton）→ 报错，提示改用 set_toolbar_button_js。
 */
export function addToolbarButton(path, { buttonText, iconName, js, className = 'com.fr.js.JavaScriptImpl', builtin, toolbar = 'write' } = {}) {
  // 【内置按钮通道】builtin 给词表键（submit/verify/append-row/delete-row/import-append/import-clean）时，
  // 追加的是 FineReport 设计器内置按钮（如 ImExcelAppend），行为由 FR 内置实现、自带图标与 i18n 文案。
  // 为什么必须走「追加」而不是 set_fill_toolbar：后者是**整栏重建**（只认词表里的内置按钮），
  // 会冲掉栏内已有的自定义按钮（实测：9 按钮模板传 2 个词 → 7 个自定义按钮连同 JS 全部丢失）。
  // 本通道只往 </ToolBar> 前插一个 Widget，栏内既有按钮字节原样保留。
  const builtinKey = builtin == null || String(builtin).trim() === '' ? null : String(builtin).trim();
  const builtinSpec = builtinKey ? TOOLBAR_BUTTONS[builtinKey] : null;
  if (builtinKey && !builtinSpec) {
    throw new Error(`addToolbarButton: 未知内置按钮 "${builtin}"（可用: ${Object.keys(TOOLBAR_BUTTONS).join(' / ')}）`);
  }
  const text = builtinSpec ? builtinSpec.text : String(buttonText ?? '').trim();
  if (!builtinSpec) {
    if (!text) throw new Error('addToolbarButton: 必须提供 buttonText（自定义按钮显示文字），或传 builtin（内置按钮名）');
    assertSafeCdata(text, '按钮文字');
  } else {
    // 内置按钮的 JS 由 FR 内置实现决定，不接受自定义 JS；显式报错而非静默忽略（项目口径：不静默丢弃入参）
    if (js != null) throw new Error(`addToolbarButton: builtin="${builtinKey}" 是设计器内置按钮，行为由 FineReport 内置实现，不接受自定义 js（需要自定义行为的按钮请用 buttonText+js 建 CustomToolBarButton）`);
    if (buttonText != null && String(buttonText).trim() !== '') throw new Error(`addToolbarButton: builtin="${builtinKey}" 已自带 i18n 文案，不要再传 buttonText（如确需改显示文字请用设计器）`);
  }
  const icon = builtinSpec
    ? (iconName != null ? String(iconName) : builtinSpec.icon)
    : (iconName != null ? String(iconName) : '');
  assertSafeCdata(icon, '按钮图标名');

  const jsNode = js != null
    ? `<JavaScript class="${escapeXmlAttr(className)}">
<Parameters/>
<Content>
<![CDATA[${assertSafeCdata(String(js), '工具栏按钮 JS')}]]></Content>
</JavaScript>
`
    : '';
  // 内置按钮的完整形态（WidgetAttr/Hotkeys 与实证原文逐字节一致，否则设计器不认图标/归属）走同一份定义，
  // 与 set_fill_toolbar 的内置按钮产物保持同构。
  const btnXml = builtinSpec
    ? `<Widget class="${builtinSpec.class}">
${FULL_BUTTON_ATTR}
<Text>
<![CDATA[${text}]]></Text>
${HOTKEYS_EMPTY}
<IconName>
<![CDATA[${icon}]]></IconName>
</Widget>`
    : `<Widget class="com.fr.form.ui.CustomToolBarButton">
<WidgetAttr/>
<Text>
<![CDATA[${text}]]></Text>
<IconName>
<![CDATA[${icon}]]></IconName>
${jsNode}</Widget>`;
  // 2026-10-20 修复：写前确保容器在 ReportWebAttr 内（缺容器仍按原口径报错；错位自动搬回）；仅 write 容器
  // 2026-10-23：新增 toolbar 容器选择（write=WebWriteContent 填报工具栏 / page=WebPageContent 页面工具栏）。
  // 两个容器可同时存在且按钮同名（对接跟进表实测），此前只认 write，page 那套完全不可达。
  const kind = normalizeToolbarKind(toolbar, 'addToolbarButton');
  const ensured = kind === 'write'
    ? ensureWebWriteContainerForWrite(path,
      'addToolbarButton: 模板无 <WebWriteContent>（填报工具栏需挂在其中）。请用 create_cpt(webWrite=true) 或 build_report(webWrite:true) 生成，或用 set_webwrite_extras({path, repair:true}) 创建容器')
    : { repaired: false, notes: [] };
  const ret = (mode, out) => ({
    action: 'add_toolbar_button',
    toolbar: kind,
    buttonText: text,
    ...(builtinKey ? { builtin: builtinKey } : {}),
    mode,
    ...(ensured.repaired ? { repaired: ensured.repaired, repairNotes: ensured.notes } : {}),
    bytes: Buffer.byteLength(out, 'utf8'),
  });
  const toolbarXml = `<ToolBars>
<ToolBarManager>
<Location>
<Embed position="1"/>
</Location>
<ToolBar>
${btnXml}
</ToolBar>
</ToolBarManager>
</ToolBars>`;

  const { raw } = load(path);
  const host = locateToolbarHost(raw, kind);
  if (!host) {
    throw new Error(`addToolbarButton: 模板无 <${TOOLBAR_HOST_NAME[kind]}>（工具栏需挂在其中）`
      + (kind === 'write' ? '。请用 create_cpt(webWrite=true) 或 build_report 生成，或用 set_webwrite_extras({path, repair:true}) 创建容器' : ''));
  }
  if (host.selfClosed) {
    // 自闭合容器 → 展开为块 + 完整 ToolBars
    const attrsPart = host.open.slice(`<${host.name}`.length, host.open.length - 2);
    const out = raw.slice(0, host.start) + `<${host.name}${attrsPart}>\n${toolbarXml}\n</${host.name}>` + raw.slice(host.start + host.open.length);
    save(path, out);
    return ret('new-toolbars', out);
  }

  // 块形态容器：定位完整区间，再定位块内 ToolBars（自闭合或块）
  const wb = host.start;
  const we = host.end;
  const wwcOpen = host.open;
  const hostBars = locateToolBarsBlock(raw, host);
  // 自闭合与块形态都要交给下面的分支处理（自闭合 → 替换为完整结构；缺失 → 新插结构）
  let tbMatch = hostBars ? { index: hostBars.abs, 0: hostBars.open } : null;

  // 重名检查：同 WebWriteContent 工具栏区内已有相同 <Text> 的 CustomToolBarButton
  // （文本两侧归一化比较，兼容 CDATA 与纯文本形态；LOW-6：报错口径与实际扫描范围一致）
  const seg = raw.slice(wb, we);
  if (builtinSpec) {
    // 内置按钮按 class 判重：已存在即幂等返回（不重复追加、不报错——内置按钮无自定义内容，
    // 再插一个只会在设计器里出现两个「导入Excel」）。
    const clsRe = new RegExp(`<Widget class="${builtinSpec.class.replace(/\./g, '\\.')}"`);
    if (clsRe.test(seg)) return ret('already-present', raw);
  }
  const dupRe = /<Widget class="com\.fr\.form\.ui\.CustomToolBarButton"[^>]*>[\s\S]*?<\/Widget>/g;
  let dm;
  while ((dm = dupRe.exec(seg)) !== null) {
    if (extractButtonText(dm[0]) === text) {
      throw new Error(`addToolbarButton: 工具栏内已有文字为「${text}」的 CustomToolBarButton。请换 buttonText，或用 set_toolbar_button_js 改写该按钮的 JS`);
    }
  }

  if (!tbMatch) {
    // 无 ToolBars → 在 WebWriteContent 开标签后插入完整结构
    const insertAt = wb + wwcOpen.length;
    const out = raw.slice(0, insertAt) + '\n' + toolbarXml + raw.slice(insertAt);
    save(path, out);
    return ret('new-toolbars', out);
  }

  const tbOpen = tbMatch[0];
  if (tbOpen.trim().endsWith('/>')) {
    // 自闭合 ToolBars → 替换为完整块
    const out = raw.slice(0, tbMatch.index) + toolbarXml + raw.slice(tbMatch.index + tbOpen.length);
    save(path, out);
    return ret('new-toolbars', out);
  }

  // 块形态 ToolBars：定位块内 ToolBar（\b 保证不误命中 <ToolBarManager>）；
  // 闭合标签用 CDATA 感知定位，避免按钮 JS CDATA 里的字面 '</ToolBars>' 提前闭合（LOW-5）
  const tb = tbMatch.index;
  const te = indexOfOutsideCdata(raw, tb + tbOpen.length, '</ToolBars>');
  if (te < 0) throw new Error('addToolbarButton: <ToolBars> 未闭合或 CDATA 未闭合，无法定位工具栏');
  const barRe = /<ToolBar\b[^>]*>/;
  const barMatch = raw.slice(tb, te).match(barRe);
  if (!barMatch) {
    // 退化形态：ToolBars 块内没有 ToolBar → 在 </ToolBars> 前插入完整 ToolBar
    const out = raw.slice(0, te) + `\n<ToolBar>\n${btnXml}\n</ToolBar>\n` + raw.slice(te);
    save(path, out);
    return ret('new-toolbar', out);
  }
  const barAbsStart = tb + barMatch.index;
  const barOpen = barMatch[0];
  if (barOpen.trim().endsWith('/>')) {
    // 自闭合 ToolBar → 展开为带按钮的块
    const out = raw.slice(0, barAbsStart) + `<ToolBar>\n${btnXml}\n</ToolBar>` + raw.slice(barAbsStart + barOpen.length);
    save(path, out);
    return ret('append', out);
  }
  // 追加到 </ToolBar> 之前（CDATA 感知，防按钮 JS CDATA 内含字面 '</ToolBar>'）
  const closeAt = indexOfOutsideCdata(raw, barAbsStart + barOpen.length, '</ToolBar>');
  if (closeAt < 0) throw new Error('addToolbarButton: <ToolBar> 未闭合或 CDATA 未闭合，无法定位追加点');
  const out = raw.slice(0, closeAt) + '\n' + btnXml + '\n' + raw.slice(closeAt);
  save(path, out);
  return ret('append', out);
}

/**
 * 增/改/删 WebWriteContent → ToolBars → ToolBar → Widget(class="com.fr.form.ui.CustomToolBarButton")
 * 内嵌的 <JavaScript class="com.fr.js.JavaScriptImpl"><Parameters/><Content>JS</Content></JavaScript>（工具栏自定义按钮 JS）。
 *
 * 覆盖此前 cpt-mcp 无法直达的缺口：按钮 JS 在 ToolBars 内而非 Listener/单元格。
 * 官方样本（13/1550 例，如 multipage.cpt「上一页」、SelectPrint.cpt「打印」）与真实报表
 * （不动销/低价福利品/产品报备机制的「删除记录」按钮）结构一致：
 *   <WebWriteContent><ToolBars><ToolBarManager><ToolBar>
 *     <Widget class="com.fr.form.ui.CustomToolBarButton"><WidgetAttr/><Text><![CDATA[删除记录]]></Text>
 *       <IconName/><JavaScript class="com.fr.js.JavaScriptImpl"><Parameters/><Content><![CDATA[js]]></Content></JavaScript></Widget>
 * 定位方式（三选一，必须给一个）：
 *   - buttonText：按钮 <Text> 显示文字（如 "删除记录"，官方/真实报表均带 Text）——推荐；
 *   - index：ToolBar 内第几个 CustomToolBarButton（0 起）；明确的按钮顺序；
 *   - match：按钮 JS 内容中的特征子串（如 "OP_COL"）。
 * js 传字符串 → 写入/替换该按钮的 JavaScript；js 传 null → 删除该按钮的 JavaScript（保留按钮本身）。
 * 片段替换（2026-11-03 事故后补，与 set_webwrite_js 同口径）：大段按钮 JS 只改其中一段时传
 *   patchFind + patchReplace（设计器转义 `]A` 感知、默认唯一命中、patchAll=true 允许多处），与 js 互斥；
 *   只改 <Content><![CDATA[...]]></Content> 内文，按钮结构与其余原文原样保留。
 * 缩水护栏：整块写入若会让旧按钮 JS（≥4KB）缩到 <60% 且少 ≥2KB → 拒绝（确要传 allowShrink:true）。
 * expectedSha256：patch/整块替换/删除前核对目标 JavaScript 块的 sha（不传则老行为不变）。
 */
export function setToolbarButtonJs(path, {
  buttonText, index, match, js, className = 'com.fr.js.JavaScriptImpl', toolbar = 'write',
  patchFind, patchReplace, patchAll, allowShrink, expectedSha256,
} = {}) {
  // 片段替换与整块写入互斥（在任何容器修复/写盘前先校验，避免报错前已有副作用）
  const patchMode = patchFind !== undefined && patchFind !== null && String(patchFind) !== '';
  assertPatchArgs({ action: 'setToolbarButtonJs', patchMode, patchFind, patchReplace });
  if (patchMode && js != null) {
    throw new Error('setToolbarButtonJs: patchFind/patchReplace 是「片段替换」，不能同时传 js（整块替换）—— 只改一段请只传 patchFind(+patchReplace)；整块替换请只传 js（大块需 allowShrink:true）。');
  }
  const whichRaw = toolbar == null || String(toolbar).trim() === '' ? 'write' : String(toolbar).trim().toLowerCase();
  // toolbar="auto"：依次在 write / page 两个容器里找（两个工具栏按钮同名时不必先猜在哪个栏）
  const kinds = whichRaw === 'auto' ? TOOLBAR_KINDS : [normalizeToolbarKind(whichRaw, 'setToolbarButtonJs')];
  let firstErr = null;
  for (const kind of kinds) {
    try {
      return setToolbarButtonJsIn(path, { buttonText, index, match, js, className, toolbar: kind, patchFind, patchReplace, patchAll, allowShrink, expectedSha256 });
    } catch (e) {
      if (!firstErr) firstErr = e;
      if (kinds.length === 1) throw e;
      if (!/未找到|没有 CustomToolBarButton|无 <ToolBars>|无 <Web/.test(e.message)) throw e;
    }
  }
  throw new Error(`${firstErr.message}（toolbar="auto" 已依次尝试 write/page 两个工具栏）`);
}

function setToolbarButtonJsIn(path, { buttonText, index, match, js, className, toolbar, patchFind, patchReplace, patchAll, allowShrink, expectedSha256 }) {
  const kind = toolbar;
  const bytesOf = (s) => Buffer.byteLength(s, 'utf8');
  const patchMode = patchFind !== undefined && patchFind !== null && String(patchFind) !== '';
  if (patchMode && js != null) {
    throw new Error('setToolbarButtonJs: patchFind/patchReplace 是「片段替换」，不能同时传 js（整块替换）—— 只改一段请只传 patchFind(+patchReplace)；整块替换请只传 js（大块需 allowShrink:true）。');
  }
  // 2026-10-20 修复：写前确保容器在 ReportWebAttr 内（缺容器仍按原口径报错；错位自动搬回）；仅 write 容器
  const ensured = kind === 'write'
    ? ensureWebWriteContainerForWrite(path,
      'setToolbarButtonJs: 模板无 <WebWriteContent>（填报工具栏需挂在其中）。请用 create_cpt(webWrite=true) 或 build_report(webWrite:true) 生成，或用 set_webwrite_extras({path, repair:true}) 创建容器')
    : { repaired: false, notes: [] };
  const repairedNote = ensured.repaired ? { repaired: ensured.repaired, repairNotes: ensured.notes } : {};
  const { raw } = load(path);
  const { bars } = resolveToolBars(raw, kind, 'setToolbarButtonJs');

  // 枚举 ToolBar 内全部 CustomToolBarButton（绝对偏移，两个容器通用）
  const btnPattern = /<Widget class="com\.fr\.form\.ui\.CustomToolBarButton"[^>]*>/g;
  const btns = [];
  let bm;
  const toolSeg = raw.slice(bars.abs, bars.closeStart);
  while ((bm = btnPattern.exec(toolSeg)) !== null) {
    const bAbsStart = bars.abs + bm.index;
    const bAbsEndRel = raw.indexOf('</Widget>', bAbsStart);
    if (bAbsEndRel < 0) break;
    const bAbsEnd = bAbsEndRel + '</Widget>'.length;
    const block = raw.slice(bAbsStart, bAbsEnd);
    const textM = block.match(/<Text>\s*<!\[CDATA\[([\s\S]*?)\]\]><\/Text>/);
    btns.push({ absStart: bAbsStart, absEnd: bAbsEnd, text: textM?.[1] ?? '', block });
  }
  if (btns.length === 0) throw new Error('setToolbarButtonJs: ToolBars 内没有 CustomToolBarButton（自定义按钮）');

  // 定位目标按钮
  let target = -1;
  if (buttonText !== undefined && buttonText !== null && String(buttonText).trim() !== '') {
    target = btns.findIndex((b) => b.text.includes(String(buttonText)));
    if (target < 0) throw new Error(`setToolbarButtonJs: 未找到按钮文字含 "${buttonText}" 的 CustomToolBarButton`);
  } else if (index !== undefined && index !== null) {
    const i = Number(index);
    if (!Number.isInteger(i) || i < 0 || i >= btns.length) throw new Error(`setToolbarButtonJs: index=${index} 越界（共 ${btns.length} 个按钮）`);
    target = i;
  } else if (match !== undefined && match !== null && String(match).trim() !== '') {
    target = btns.findIndex((b) => b.block.includes(String(match)));
    if (target < 0) throw new Error(`setToolbarButtonJs: 未找到 JS 含 "${match}" 的 CustomToolBarButton`);
  } else {
    throw new Error('setToolbarButtonJs: 请提供定位方式之一：buttonText（按钮文字，推荐）/ index（按钮序号）/ match（JS 特征子串）');
  }
  const btn = btns[target];
  const btnLabel = btn.text || `#${target}`;

  // 按钮内既有 <JavaScript class="...JavaScriptImpl"> 块？
  const jsRe = /<JavaScript\s+class="com\.fr\.js\.[^"]*JavaScriptImpl"[^>]*>[\s\S]*?<\/JavaScript>/;
  const jsHit = jsRe.exec(btn.block);
  const jsBlock = jsHit ? jsHit[0] : null;
  const jsAbsStart = jsHit ? btn.absStart + jsHit.index : -1;
  const jsAbsEnd = jsHit ? btn.absStart + jsHit.index + jsHit[0].length : -1;
  const jsSpan = jsBlock ? listenerContentSpan(jsBlock) : null;

  if (js == null && !patchMode) {
    if (jsAbsStart < 0) throw new Error(`setToolbarButtonJs: 按钮「${btnLabel}」没有可删除的 JavaScriptImpl`);
    // 自卫：删除前也核对（传了 expectedSha256 才生效）
    assertExpectedSha256Js(jsSpan?.js, expectedSha256, 'setToolbarButtonJs');
    let e = jsAbsEnd;
    while (e < raw.length && (raw[e] === '\n' || raw[e] === '\r')) e++;
    const out = raw.slice(0, jsAbsStart) + raw.slice(e);
    save(path, out);
    return {
      action: 'set_toolbar_button_js', toolbar: kind, button: btnLabel, mode: 'delete', ...repairedNote,
      jsBytesBefore: jsSpan?.bytes ?? 0, jsLinesBefore: jsSpan?.lines ?? 0, jsBytesAfter: 0, jsLinesAfter: 0,
      bytes: bytesOf(out),
    };
  }

  // 片段替换：只改目标按钮 JavaScript 的 Content CDATA 内文，块内其余原文（Parameters/className/换行）原样保留
  if (patchMode) {
    if (jsAbsStart < 0) {
      throw new Error(`setToolbarButtonJs: 按钮「${btnLabel}」没有 JavaScriptImpl 块，无法片段替换（patchFind/patchReplace 只改已存在 JS；要新建请传 js）。文件未改动。`);
    }
    if (!jsSpan) {
      throw new Error(`setToolbarButtonJs: 按钮「${btnLabel}」的 JavaScriptImpl 缺少 <Content><![CDATA[...]]></Content> 结构，无法片段替换（文件未改动；请先 list_toolbar_buttons 核对按钮，或读回确认结构）。`);
    }
    assertExpectedSha256Js(jsSpan.js, expectedSha256, 'setToolbarButtonJs');
    const patched = patchJsFragment({ action: 'setToolbarButtonJs', target: `按钮「${btnLabel}」的 JavaScript`, js: jsSpan.js, patchFind, patchReplace, patchAll });
    const nextJs = assertSafeCdata(patched.js, '工具栏按钮 JS');
    const out = raw.slice(0, jsAbsStart + jsSpan.cdStart) + nextJs + raw.slice(jsAbsStart + jsSpan.cdEnd);
    save(path, out);
    return {
      action: 'set_toolbar_button_js', toolbar: kind, button: btnLabel, mode: 'patch', patchHits: patched.hits,
      ...patchMatchNote(patched.matchedBy), ...repairedNote,
      jsBytesBefore: jsSpan.bytes, jsBytesAfter: bytesOf(nextJs),
      jsLinesBefore: jsSpan.lines, jsLinesAfter: nextJs.split('\n').length,
      bytes: bytesOf(out),
      hint: `已片段替换 ${patched.hits} 处（只改按钮 JavaScript 的命中片段，其余原文未动）。修改后建议重跑 check_report_js/validate_cpt。`,
    };
  }

  // 整块写入：expectedSha256 核对 + 缩水护栏
  const wantSha = expectedSha256 !== undefined && expectedSha256 !== null && String(expectedSha256).trim() !== '';
  if (wantSha) {
    if (jsAbsStart < 0) {
      throw new Error(`setToolbarButtonJs: 按钮「${btnLabel}」没有 JavaScriptImpl（传了 expectedSha256，无从核对，拒绝新建）。不传 expectedSha256 则按老行为插入新 JS。`);
    }
    assertExpectedSha256Js(jsSpan?.js, expectedSha256, 'setToolbarButtonJs');
  }
  const shrinkBefore = jsSpan
    ? guardJsShrink({
      action: 'setToolbarButtonJs',
      target: `按钮「${btnLabel}」的 JavaScript`,
      beforeMetrics: jsSpan,
      afterJs: js,
      allowShrink,
      fixHint: '按钮 JS 常承载整段业务逻辑（补行/导出/重算），整块替换极易静默丢功能。安全做法：①只改其中片段 → 传 patchFind + patchReplace（块内其余原文原样保留）；②确实要整块替换 → 传 allowShrink:true（写前用 list_toolbar_buttons 核对按钮有无 JS）。',
    })
    : null;
  const safeJs = assertSafeCdata(String(js), '工具栏按钮 JS');
  const node = `<JavaScript class="${escapeXmlAttr(className)}">
<Parameters/>
<Content>
<![CDATA[${safeJs}]]></Content>
</JavaScript>\n`;
  let out;
  if (jsAbsStart >= 0) {
    out = raw.slice(0, jsAbsStart) + node + raw.slice(jsAbsEnd);
  } else {
    // 无 JS 则插到按钮 Widget 开标签后（对齐官方顺序：WidgetAttr/Text/IconName 之后、按钮属性前）
    const anchor = raw.indexOf('>', btn.absStart) + 1;
    out = raw.slice(0, anchor) + '\n' + node + raw.slice(anchor);
  }
  save(path, out);
  const after = jsMetricsOf(safeJs);
  return {
    action: 'set_toolbar_button_js', toolbar: kind, button: btnLabel, mode: 'replace', ...repairedNote,
    jsBytesBefore: jsSpan?.bytes ?? 0, jsLinesBefore: jsSpan?.lines ?? 0,
    jsBytesAfter: after.bytes, jsLinesAfter: after.lines,
    bytes: bytesOf(out),
    ...(shrinkBefore && shrinkBefore.bytes >= LISTENER_SHRINK_MIN_OLD_BYTES
      ? { hint: `已整块替换按钮「${btnLabel}」的 ${shrinkBefore.bytes}B/${shrinkBefore.lines}行 按钮 JS（新 ${after.bytes}B/${after.lines}行）。若只想改其中一段，优先用 patchFind/patchReplace 片段替换，可保留其余原文。` }
      : {}),
  };
}

/**
 * 工具栏 Widget 块级操作（M78：逆向 ground truth 见 docs/toolbar-plugin-widgets.md）。
 * 设计铁律：只剪切 / 删除 / 移动**已存在**的 <Widget> 块（字节原样保留），绝不合成未知
 * class 的插件按钮 XML —— Excel导入（com.fr.plugin.excel.ui.ExcelImportButton）/
 * 导出（com.fr.report.web.button.Export）等插件形态只读搬运，不重建。
 */
function scanToolbarWidgets(raw, which = 'write') {
  const { kind, host, bars } = resolveToolBars(raw, which, '工具栏操作');
  if (bars.selfClosed) throw new Error(`工具栏操作：${host.name} 内 <ToolBars> 自闭合（无按钮可操作）`);
  const tbAbs = bars.abs;
  const te = bars.closeStart;
  const barM = raw.slice(tbAbs, te).match(/<ToolBar\b[^>]*>/);
  if (!barM || barM[0].trim().endsWith('/>')) throw new Error(`工具栏操作：${host.name} 的 <ToolBar> 缺失或自闭合（无按钮可操作）`);
  const barAbs = tbAbs + barM.index;
  const barEnd = indexOfOutsideCdata(raw, barAbs + barM[0].length, '</ToolBar>');
  if (barEnd < 0) throw new Error('工具栏操作：<ToolBar> 未闭合');
  // 平衡扫描顶层 <Widget> 块（自闭合 Widget 独立成块；嵌套按栈配对）。
  // F-audit3：按钮 JS 在 CDATA 内，JS 字符串若含 "<Widget"/"</Widget>" 字面会打乱配对——
  // 先把 CDATA 区掩盖为等长空格（偏移与原串一致），在掩盖串上扫描、原串上切片。
  const inner = raw.slice(barAbs, barEnd);
  const masked = inner.replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, (c) => ' '.repeat(c.length));
  const blocks = [];
  const re = /<\/?Widget\b[^>]*>/g;
  const stack = [];
  let m;
  while ((m = re.exec(masked)) !== null) {
    const tag = m[0];
    if (tag[1] === '/') {
      const open = stack.pop();
      if (open !== undefined && stack.length === 0) {
        blocks.push({ absStart: barAbs + open, absEnd: barAbs + m.index + tag.length });
      }
    } else if (!tag.trim().endsWith('/>')) {
      stack.push(m.index);
    } else if (stack.length === 0) {
      blocks.push({ absStart: barAbs + m.index, absEnd: barAbs + m.index + tag.length });
    }
  }
  const classOf = (block) => block.match(/<Widget class="([^"]+)"[^>]*>/)?.[1] ?? '';
  const list = blocks.map((b, i) => {
    const block = raw.slice(b.absStart, b.absEnd);
    return { ...b, index: i, class: classOf(block), text: extractButtonText(block), block };
  });
  return { kind, host, bars, barAbs, barOpenEnd: barAbs + barM[0].length, barEnd, widgets: list };
}

function locateToolbarWidget(widgets, { buttonText, index, match }, toolName) {
  const hasText = buttonText !== undefined && buttonText !== null && String(buttonText).trim() !== '';
  const hasIndex = index !== undefined && index !== null && String(index).trim() !== '';
  const hasMatch = match !== undefined && match !== null && String(match).trim() !== '';
  if (!hasText && !hasIndex && !hasMatch) {
    throw new Error(`${toolName}: 请提供定位方式之一：buttonText（按钮文字）/ index（ToolBar 内序号，0 起，全部按钮）/ match（按钮 XML 特征子串）`);
  }
  if (hasText) {
    // F-audit3：删/移是结构变更，只接受精确匹配（trim 后相等）——模糊单命中曾可误删
    // （如 '页码' 命中 '页码跳转'）。未命中即抛错并提示改用 index。
    const want = String(buttonText).trim();
    const exact = widgets.filter((w) => w.text.trim() === want);
    if (exact.length === 1) return exact[0];
    if (exact.length > 1) throw new Error(`${toolName}: 文字为「${want}」的按钮有 ${exact.length} 个，请改用 index 精确定位`);
    throw new Error(`${toolName}: 未找到文字为「${want}」的工具栏按钮（共 ${widgets.length} 个；精确匹配，请检查文字或改用 index）`);
  }
  if (hasIndex) {
    const i = Number(index);
    if (!Number.isInteger(i) || i < 0 || i >= widgets.length) throw new Error(`${toolName}: index=${index} 越界（共 ${widgets.length} 个按钮）`);
    return widgets[i];
  }
  const hit = widgets.filter((w) => w.block.includes(String(match)));
  if (hit.length === 1) return hit[0];
  if (hit.length > 1) throw new Error(`${toolName}: 含 "${match}" 的按钮有 ${hit.length} 个，请改用 index 精确定位`);
  throw new Error(`${toolName}: 未找到含 "${match}" 的工具栏按钮`);
}

// M78 ⓪ list_toolbar_buttons：只读列举 ToolBar 内全部按钮（序号/class/文字/图标/有无JS）——
// 删/移前先列，核对序号；亦用于与设计器/备份交叉校对按钮清单（含图标核对）。
function extractButtonIcon(block) {
  const cd = block.match(/<IconName>\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*<\/IconName>/);
  if (cd) return cd[1].trim();
  return '';
}
export function listToolbarButtons(path, { toolbar = 'write' } = {}) {
  const { raw } = load(path);
  const which = toolbar == null || String(toolbar).trim() === '' ? 'write' : String(toolbar).trim().toLowerCase();
  const shape = (kind, widgets) => ({
    toolbar: kind,
    count: widgets.length,
    buttons: widgets.map((w) => {
      // 2026-11-03：按钮 JS 的度量/sha —— set_toolbar_button_js 的 patch 对账与 expectedSha256 需要
      // （此前只有 hasJs，模型拿不到旧块 sha，写前自卫形同虚设）。
      const jsBlock = /<JavaScript\s+class="com\.fr\.js\.[^"]*JavaScriptImpl"[^>]*>[\s\S]*?<\/JavaScript>/.exec(w.block)?.[0];
      const span = jsBlock ? listenerContentSpan(jsBlock) : null;
      return {
        index: w.index,
        class: w.class,
        text: w.text,
        icon: extractButtonIcon(w.block),
        hasJs: /<JavaScript[\s>]/.test(w.block),
        ...(span ? { jsBytes: span.bytes, jsLines: span.lines, sha256: jsSha256(span.js) } : {}),
      };
    }),
  });
  if (which === 'all') {
    // 一次列清所有**存在**的容器（官方样本实测：write 585 / page 528 / view 12，371 个文件多容器并存）
    const out = [];
    for (const kind of TOOLBAR_KINDS) {
      try {
        const { widgets } = scanToolbarWidgets(raw, kind);
        out.push(shape(kind, widgets));
      } catch (e) {
        const msg = e.message.split('\n')[0];
        if (/模板无 <Web\w+>/.test(msg)) continue; // 该容器不存在：不列空壳
        out.push({ toolbar: kind, count: 0, buttons: [], note: msg });
      }
    }
    return {
      action: 'list_toolbar_buttons',
      toolbar: 'all',
      count: out.reduce((n, x) => n + x.count, 0),
      toolbars: out,
    };
  }
  const { widgets, kind } = scanToolbarWidgets(raw, which);
  return { action: 'list_toolbar_buttons', ...shape(kind, widgets) };
}

// M78 ③ set_toolbar_button_icon：改存量按钮 <IconName>（只动图标节点，JS/属性原样保留）。
// 图标名自由文本；历史模板实证：submit/verify/appendrow/deleterow/previous/print/excel
//（插件 Excel导入用 customizexcel）。未实证的名字设计器可能显示空白，优先用实证名或留空。
export function setToolbarButtonIcon(path, { buttonText, index, match, iconName, toolbar = 'write' } = {}) {
  const kind = normalizeToolbarKind(toolbar, 'setToolbarButtonIcon');
  const icon = iconName != null ? String(iconName) : '';
  assertSafeCdata(icon, '按钮图标名');
  // 2026-10-20 修复：写前确保容器在 ReportWebAttr 内（缺容器仍按原口径报错；错位自动搬回）
  const ensured = kind === 'write'
    ? ensureWebWriteContainerForWrite(path, '工具栏操作：模板无 <WebWriteContent>。请用 create_cpt(webWrite=true) 或 build_report(webWrite:true) 生成，或用 set_webwrite_extras({path, repair:true}) 创建容器')
    : { repaired: false, notes: [] };
  const { raw } = load(path);
  const { widgets } = scanToolbarWidgets(raw, kind);
  if (widgets.length === 0) throw new Error('setToolbarButtonIcon: ToolBar 内没有按钮');
  const target = locateToolbarWidget(widgets, { buttonText, index, match }, 'setToolbarButtonIcon');
  const block = raw.slice(target.absStart, target.absEnd);
  const iconRe = /<IconName\s*\/>|<IconName>[\s\S]*?<\/IconName>/;
  const hit = iconRe.exec(block);
  if (!hit) throw new Error(`setToolbarButtonIcon: 按钮「${target.text || `#${target.index}`}」内无 <IconName> 节点（非标准按钮形态）`);
  const node = `<IconName>\n<![CDATA[${icon}]]></IconName>`;
  const out = raw.slice(0, target.absStart + hit.index) + node + raw.slice(target.absStart + hit.index + hit[0].length);
  save(path, out);
  return { action: 'set_toolbar_button_icon', toolbar: kind, button: target.text || `#${target.index}`, iconName: icon, mode: 'update', ...(ensured.repaired ? { repaired: ensured.repaired } : {}), bytes: Buffer.byteLength(out, 'utf8') };
}

// M78 ① delete_toolbar_button：删单个按钮整颗 <Widget>（插件按钮亦可删，删前请用 git 落库）
export function deleteToolbarButton(path, { buttonText, index, match, toolbar = 'write' } = {}) {
  const kind = normalizeToolbarKind(toolbar, 'deleteToolbarButton');
  // 2026-10-20 修复：写前确保容器在 ReportWebAttr 内（缺容器仍按原口径报错；错位自动搬回）
  const ensured = kind === 'write'
    ? ensureWebWriteContainerForWrite(path, '工具栏操作：模板无 <WebWriteContent>。请用 create_cpt(webWrite=true) 或 build_report(webWrite:true) 生成，或用 set_webwrite_extras({path, repair:true}) 创建容器')
    : { repaired: false, notes: [] };
  const { raw } = load(path);
  const { widgets } = scanToolbarWidgets(raw, kind);
  if (widgets.length === 0) throw new Error('deleteToolbarButton: ToolBar 内没有按钮');
  const target = locateToolbarWidget(widgets, { buttonText, index, match }, 'deleteToolbarButton');
  let s = target.absStart;
  let e = target.absEnd;
  if (raw[s - 1] === '\n') s -= 1;
  const out = raw.slice(0, s) + raw.slice(e);
  save(path, out);
  return { action: 'delete_toolbar_button', toolbar: kind, button: target.text || `#${target.index}`, class: target.class, remaining: widgets.length - 1, ...(ensured.repaired ? { repaired: ensured.repaired } : {}), bytes: Buffer.byteLength(out, 'utf8') };
}

// M78 ② move_toolbar_button：块级移动单个按钮（字节原样搬运，JS 与插件属性保留）
export function moveToolbarButton(path, { buttonText, index, match, to, toolbar = 'write' } = {}) {
  const kind = normalizeToolbarKind(toolbar, 'moveToolbarButton');
  // 2026-10-20 修复：写前确保容器在 ReportWebAttr 内（缺容器仍按原口径报错；错位自动搬回）
  const ensured = kind === 'write'
    ? ensureWebWriteContainerForWrite(path, '工具栏操作：模板无 <WebWriteContent>。请用 create_cpt(webWrite=true) 或 build_report(webWrite:true) 生成，或用 set_webwrite_extras({path, repair:true}) 创建容器')
    : { repaired: false, notes: [] };
  const { raw } = load(path);
  const { widgets } = scanToolbarWidgets(raw, kind);
  if (widgets.length === 0) throw new Error('moveToolbarButton: ToolBar 内没有按钮');
  const target = locateToolbarWidget(widgets, { buttonText, index, match }, 'moveToolbarButton');
  const n = widgets.length;
  let dest;
  if (to === 'first') dest = 0;
  else if (to === 'last') dest = n - 1;
  else if (Number.isInteger(Number(to)) && Number(to) >= 0) dest = Math.min(Number(to), n - 1);
  else throw new Error(`moveToolbarButton: to 非法 "${to}"（可用 first / last / 0..${n - 1}）`);
  if (dest === target.index) return { action: 'move_toolbar_button', toolbar: kind, button: target.text || `#${target.index}`, from: target.index, to: dest, mode: 'noop', ...(ensured.repaired ? { repaired: ensured.repaired } : {}), bytes: Buffer.byteLength(raw, 'utf8') };
  // 先删后插：删除块（含前一个换行），再按目标序号插入
  let s = target.absStart;
  const e = target.absEnd;
  if (raw[s - 1] === '\n') s -= 1;
  const block = raw.slice(target.absStart, target.absEnd);
  const removed = raw.slice(0, s) + raw.slice(e);
  // removed 坐标系下重算插入点：dest 指“移动后最终序号”
  const rest = scanToolbarWidgets(removed, kind);
  let insertAt;
  if (dest >= rest.widgets.length) {
    insertAt = rest.barEnd; // 末尾：</ToolBar> 之前
    const out = removed.slice(0, insertAt) + '\n' + block + '\n' + removed.slice(insertAt);
    save(path, out);
    return { action: 'move_toolbar_button', toolbar: kind, button: target.text || `#${target.index}`, from: target.index, to: dest, mode: 'move', ...(ensured.repaired ? { repaired: ensured.repaired } : {}), bytes: Buffer.byteLength(out, 'utf8') };
  }
  insertAt = rest.widgets[dest].absStart;
  const out = removed.slice(0, insertAt) + block + '\n' + removed.slice(insertAt);
  save(path, out);
  return { action: 'move_toolbar_button', toolbar: kind, button: target.text || `#${target.index}`, from: target.index, to: dest, mode: 'move', ...(ensured.repaired ? { repaired: ensured.repaired } : {}), bytes: Buffer.byteLength(out, 'utf8') };
}

// ---------------- M53 单元格补齐（hyperlink/highlight 删改查） ----------------

/** 定位单元格内的 <NameJavaScript> 块（按 name 精确匹配），返回 [start, end] */
function locateNameJavaScript(seg, name) {
  const safeName = escapeXmlAttr(String(name));
  const re = new RegExp(`<NameJavaScript\\b[^>]*\\bname="${safeName}"[^>]*>`);
  const m = re.exec(seg);
  if (!m) return null;
  const [b, e] = blockRange(seg, m.index, '<NameJavaScript', '</NameJavaScript>');
  // blockRange 用的是 raw 偏移; 改为 seg 偏移
  return [b, e];
}

// M53 ① delete_cell_hyperlink：删单元格内指定 name 的 NameJavaScript 块（无 name 则删整组 NameJavaScriptGroup）
export function deleteCellHyperlink(path, column, row, { name, sheet } = {}) {
  const { raw } = load(path);
  const [cb, ce] = locateCell(raw, column, row, `单元格(${column},${row})`, sheet);
  const seg = raw.slice(cb, ce);
  const gOpen = seg.indexOf('<NameJavaScriptGroup>');
  const gClose = seg.indexOf('</NameJavaScriptGroup>', gOpen);
  if (gOpen < 0 || gClose < 0) {
    return { action: 'delete_cell_hyperlink', cell: `${column},${row}`, name: name ?? null, removed: 0, bytes: Buffer.byteLength(raw, 'utf8') };
  }
  if (!name) {
    // 删整组
    const block = seg.slice(gOpen, gClose + '</NameJavaScriptGroup>'.length);
    const newSeg = seg.slice(0, gOpen) + seg.slice(gClose + '</NameJavaScriptGroup>'.length);
    const out = raw.slice(0, cb) + newSeg + raw.slice(ce);
    save(path, out);
    return { action: 'delete_cell_hyperlink', cell: `${column},${row}`, name: null, removed: 'group', bytes: Buffer.byteLength(out, 'utf8') };
  }
  // 删指定 name 的 NameJavaScript
  const nsStart = gOpen + '<NameJavaScriptGroup>'.length;
  const group = seg.slice(nsStart, gClose);
  const safeName = escapeXmlAttr(String(name));
  const re = new RegExp(`<NameJavaScript\\b[^>]*\\bname="${safeName}"[^>]*>[\\s\\S]*?</NameJavaScript>\\n?`);
  const m = re.exec(group);
  if (!m) throw new Error(`delete_cell_hyperlink: NameJavaScript name="${name}" 不存在`);
  const newGroup = group.slice(0, m.index) + group.slice(m.index + m[0].length);
  let newSeg = seg.slice(0, nsStart) + newGroup + seg.slice(gClose);
  // 如果整组清空, 删整组
  if (!newGroup.trim()) {
    newSeg = seg.slice(0, gOpen) + seg.slice(gClose + '</NameJavaScriptGroup>'.length);
  }
  const out = raw.slice(0, cb) + newSeg + raw.slice(ce);
  save(path, out);
  return { action: 'delete_cell_hyperlink', cell: `${column},${row}`, name, bytes: Buffer.byteLength(out, 'utf8') };
}

// M53 ② delete_cell_highlight：删单元格内所有或指定 Highlight 条件
//   name 不传 → 清整个 <HighlightList>
//   formula 传 → 删匹配的 <Highlight>（按 formula 文本模糊匹配；FR 设计器是按 formula 唯一标识）
export function deleteCellHighlight(path, column, row, { formula, sheet } = {}) {
  const { raw } = load(path);
  const [cb, ce] = locateCell(raw, column, row, `单元格(${column},${row})`, sheet);
  const seg = raw.slice(cb, ce);
  const hlOpen = seg.indexOf('<HighlightList>');
  const hlClose = seg.lastIndexOf('</HighlightList>');
  if (hlOpen < 0) {
    return { action: 'delete_cell_highlight', cell: `${column},${row}`, removed: 0, bytes: Buffer.byteLength(raw, 'utf8') };
  }
  const inner = seg.slice(hlOpen + '<HighlightList>'.length, hlClose);
  let newInner = inner;
  let removed = 0;
  if (formula) {
    // 删匹配 formula 的 <Highlight ...>...</Highlight> 块（Highlight 带 class 属性；
    // formula 存于 <Formula><![CDATA[...]]></Formula> 中）
    const fEsc = String(formula).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`<Highlight\\b[^>]*>[\\s\\S]*?<![CDATA\\[${fEsc}\\]\\]>[\\s\\S]*?</Highlight>\\n?`);
    if (re.test(newInner)) {
      newInner = newInner.replace(re, '');
      removed = 1;
    } else {
      throw new Error(`delete_cell_highlight: 单元格(${column},${row}) 找不到 formula="${formula}" 的条件`);
    }
  } else {
    // 删整 HighlightList
    removed = (newInner.match(/<Highlight>/g) || []).length;
    newInner = '';
  }
  let newSeg;
  if (!newInner.trim()) {
    newSeg = seg.slice(0, hlOpen) + seg.slice(hlClose + '</HighlightList>'.length);
  } else {
    newSeg = seg.slice(0, hlOpen + '<HighlightList>'.length) + newInner + seg.slice(hlClose);
  }
  const out = raw.slice(0, cb) + newSeg + raw.slice(ce);
  save(path, out);
  return { action: 'delete_cell_highlight', cell: `${column},${row}`, removed, bytes: Buffer.byteLength(out, 'utf8') };
}

// M53 ③ get_cell_highlight：读单元格内全部或指定条件属性
export function getCellHighlight(path, column, row, { sheet } = {}) {
  const { raw } = load(path);
  const [cb, ce] = locateCell(raw, column, row, `单元格(${column},${row})`, sheet);
  const seg = raw.slice(cb, ce);
  const hlOpen = seg.indexOf('<HighlightList>');
  const hlClose = seg.lastIndexOf('</HighlightList>');
  if (hlOpen < 0) {
    return { cell: `${column},${row}`, sheet: sheet ?? 0, highlights: [], hasHighlight: false };
  }
  const inner = seg.slice(hlOpen + '<HighlightList>'.length, hlClose);
  const out = [];
  const re = /<Highlight class="([^"]*)">([\s\S]*?)<\/Highlight>/g;
  let m;
  while ((m = re.exec(inner)) !== null) {
    const cls = m[1];
    const b = m[2];
    // 名称 Name → CDATA
    const name = (b.match(/<Name>[\s\S]*?<!\[CDATA\[([\s\S]*?)\]\]>/) || [])[1]?.trim() ?? null;
    // formula：Condition>Formula → CDATA
    const formula = (b.match(/<Formula>[\s\S]*?<!\[CDATA\[([\s\S]*?)\]\]>/) || [])[1]?.trim() ?? null;
    // HighlightAction 内容（背景色/字色/改值/字体）
    const bg = (b.match(/<Background\s+name="([^"]*)"\s+color="([^"]*)"\s*\/>/) || []);
    const fg = (b.match(/<Foreground\s+color="([^"]*)"\s*\/>/) || []);
    const value = (b.match(/<Value\s+type="([^"]*)"[^>]*>([\s\S]*?)<\/Value>/) || []);
    const bold = /<Bold\s*\/>/.test(b) ? true : (/<Bold>[^<]*<\/Bold>/.test(b) ? true : null);
    out.push({
      name,
      class: cls,
      formula,
      conditionClass: (b.match(/<Condition\s+class="([^"]*)"/) || [])[1] ?? null,
      background: bg[2] ? { name: bg[1], color: bg[2] } : null,
      fontColor: fg[1] ?? null,
      value: value[2] ? { type: value[1], text: value[2].trim() } : null,
      bold,
    });
  }
  return { cell: `${column},${row}`, sheet: sheet ?? 0, highlights: out, hasHighlight: out.length > 0 };
}

// ---------------- M54 表格补齐（fill_submit / sheet / style） ----------------

/** 删除指定 submitIndex 的 SubmitVisitor 整块（blockRange 锚定，开闭对） */
export function deleteFillSubmit(path, submitIndex, sheet) {
  const { raw } = load(path);
  const [b, e] = locateSubmit(raw, submitIndex, `提交 ${submitIndex + 1}`, sheet, path);
  const out = removeRange(raw, b, e);
  save(path, out);
  return { action: 'delete_fill_submit', submitIndex, sheet: sheet ?? 0, bytes: Buffer.byteLength(out, 'utf8') };
}

/** 删除指定工作表（按索引或名称）。要求至少保留 1 个工作表。 */
export function deleteSheet(path, sheet) {
  const { raw } = load(path);
  const blocks = sheetBlocks(raw);
  if (blocks.length <= 1) throw new Error('deleteSheet: 模板必须至少保留 1 个工作表，无法删除最后一个');
  const b = locateSheet(raw, sheet);
  // 删除整段 Report 块 + 紧跟其后的换行
  let end = b.end;
  while (end < raw.length && (raw[end] === '\n' || raw[end] === '\r')) end++;
  const out = raw.slice(0, b.start) + raw.slice(end);
  save(path, out);
  return { action: 'delete_sheet', sheet: b.name ?? sheet, index: b.index, bytes: Buffer.byteLength(out, 'utf8') };
}

/**
 * 删除 StyleList 中第 idx 个 Style 块（无引用检测——若删的样式仍被某单元格/float 引用，将产生越界）。
 * 为安全起见, 函数会先查 cell/float 引用，若被引用则抛错（除非 force=true）。
 */
export function deleteStyle(path, idx, { force = false } = {}) {
  const { raw } = load(path);
  const styles = styleBlocks(raw).blocks;
  if (styles.length <= idx) throw new Error(`deleteStyle: 样式 ${idx} 不存在（StyleList 仅有 ${styles.length} 个）`);
  if (styles.length <= 1) throw new Error('deleteStyle: StyleList 必须至少保留 1 个样式');
  if (idx === 0) throw new Error('deleteStyle: 不可删默认样式 0（所有 c/r 坐标默认引用 style=0；删了会大面积越界）');
  if (!force) {
    // 查 c="..." s="idx" 引用
    const re = new RegExp(`\\bs="${idx}"\\b`);
    if (re.test(raw)) {
      throw new Error(`deleteStyle: 样式 ${idx} 仍被单元格/浮动元素引用；如确认要删请传 force=true（但删后被引用方会越界，建议先改 update_cell_style 改向）`);
    }
  }
  const blk = styleBlocks(raw).blocks[idx];
  const out = removeRange(raw, blk.start, blk.end);
  save(path, out);
  return { action: 'delete_style', index: idx, bytes: Buffer.byteLength(out, 'utf8') };
}

/**
 * 重命名参数面板控件（含同名参数绑定与 WidgetNameTagMap 标签映射）。
 * 官方结构里控件名出现在三处（缺一即绑定断裂/标签丢失）：
 *   ① <InnerWidget>…<WidgetName name="X"/>…</InnerWidget>   —— 控件名本体
 *   ② <WidgetNameTagMap><NameTag name="X" tag="…"/></WidgetNameTagMap> —— 控件名→标签映射（167/面板有）
 *   ④ <MobileWidgetList><Widget widgetName="X"/>…</MobileWidgetList> —— 移动端控件清单引用
 *     （237/260 面板有，widgetName 与 WidgetName 一一对应，漏改移动端布局挂空）
 * 全部同步改名；JS 里的 getWidgetByName("X") 属自由文本，工具不改，返回中提示用户确认。
 * 范围边界（实测 FR 11 模板）：①～④ 均在 <ReportParameterAttr> 块内。块外的同名
 * <Attributes name="X"/>（数据集参数 <TableDataMap><Parameter>、单元格条件
 * <Compare><Parameter>）绝不能改——那是 SQL ${X} 与公式的引用锚点，改了对不上。
 * newName 必须符合控件/参数命名规则（与 assertParamName 同口径：字母/下划线/CJK/$，F7），且不与现有控件重名。
 */
export function renameParameterWidget(path, { name, newName } = {}) {
  if (!name || !String(name).trim()) throw new Error('renameParameterWidget: 必须提供 name（要改名的控件）');
  try {
    newName = assertParamName(newName);
  } catch (e) {
    throw new Error(`renameParameterWidget: 新控件名 "${newName}" 非法：${String(e.message || e).replace(/^参数名 "[^"]*" 非法：/, '')}`);
  }
  if (String(newName) === String(name)) throw new Error('renameParameterWidget: 新旧控件名相同');

  const { raw } = load(path);
  const rpaStart = raw.indexOf('<ReportParameterAttr>');
  const rpaEnd = raw.indexOf('</ReportParameterAttr>', rpaStart);
  if (rpaStart < 0 || rpaEnd < 0) throw new Error('renameParameterWidget: 模板无 <ReportParameterAttr>（请用 create_cpt 生成骨架）');
  // 只允许在 <ReportParameterAttr> 块内改写：块外同名 <Attributes>（数据集参数、单元格条件
  // 引用）必须保持原样，以免破坏 SQL ${X} 与公式。
  const seg = raw.slice(rpaStart, rpaEnd);

  // 1) 定位含旧名的 InnerWidget 块（枚举块，避免非贪婪跨块误匹配）
  const safeOld = escapeXmlAttr(String(name));
  const safeNew = escapeXmlAttr(String(newName));
  const allInner = new RegExp('<InnerWidget\\b[^>]*>[\\s\\S]*?</InnerWidget>', 'g');
  let hit, innerAbs = -1;
  while ((hit = allInner.exec(seg)) !== null) {
    if (hit[0].includes(`<WidgetName name="${safeOld}"/>`)) { innerAbs = rpaStart + hit.index; break; }
  }
  if (innerAbs < 0) throw new Error(`renameParameterWidget: 未找到控件 name="${name}"`);
  // 新名不得与现有控件冲突（含 Layout 自身的 "para" 及其余控件）
  const namesNow = [...seg.matchAll(/<WidgetName\s+name="([^"]+)"/g)].map((m) => m[1]);
  if (namesNow.includes(String(newName))) throw new Error(`renameParameterWidget: 控件名 "${newName}" 已存在`);

  const wNameOld = `<WidgetName name="${safeOld}"/>`;
  const wNameNew = `<WidgetName name="${safeNew}"/>`;
  const attrOld = `<Attributes name="${safeOld}"/>`;
  const attrNew = `<Attributes name="${safeNew}"/>`;
  const nameTagOld = `<NameTag name="${safeOld}"`;
  const nameTagNew = `<NameTag name="${safeNew}"`;
  const mobileOld = `<Widget widgetName="${safeOld}"/>`;
  const mobileNew = `<Widget widgetName="${safeNew}"/>`;

  // 是否存在待改的各处（基于 raw 的 RPA 块内统计，不受后续位移影响）
  const hasInRpa = (needle) => raw.slice(rpaStart, rpaEnd).includes(needle);
  const renamedParameterBinding = hasInRpa(attrOld);
  const renamedNameTag = hasInRpa(nameTagOld);
  const renamedMobileRef = hasInRpa(mobileOld);

  let out = raw;
  // 2) 改控件名本体 <WidgetName name="旧"/>（仅在该 InnerWidget 内替换）
  const innerSeg = out.slice(innerAbs, rpaStart + (hit.index + hit[0].length));
  const wIdx = innerSeg.indexOf(wNameOld);
  if (wIdx < 0) throw new Error(`renameParameterWidget: 控件 name="${name}" 内未找到 <WidgetName>`);
  const absW = innerAbs + wIdx;
  out = out.slice(0, absW) + wNameNew + out.slice(absW + wNameOld.length);

  // 3) 改同名报告参数绑定 <Attributes name="旧"/>（仅 RPA 块内；不存在则不动）
  if (renamedParameterBinding) {
    const seg3Abs = out.slice(rpaStart, rpaEndFor(out));
    const aIdx = seg3Abs.indexOf(attrOld);
    if (aIdx >= 0) {
      const absA = rpaStart + aIdx;
      out = out.slice(0, absA) + attrNew + out.slice(absA + attrOld.length);
    }
  }

  // 4) 改 WidgetNameTagMap 内 <NameTag name="旧" 的映射（仅 RPA 块内；不存在则不动）
  if (renamedNameTag) {
    const seg4Abs = out.slice(rpaStart, rpaEndFor(out));
    const tIdx = seg4Abs.indexOf(nameTagOld);
    if (tIdx >= 0) {
      const absT = rpaStart + tIdx;
      out = out.slice(0, absT) + nameTagNew + out.slice(absT + nameTagOld.length);
    }
  }

  // 5) 改移动端控件清单引用 <Widget widgetName="旧"/>（仅 RPA 块内；不存在则不动）
  if (renamedMobileRef) {
    const seg5Abs = out.slice(rpaStart, rpaEndFor(out));
    const mIdx = seg5Abs.indexOf(mobileOld);
    if (mIdx >= 0) {
      const absM = rpaStart + mIdx;
      out = out.slice(0, absM) + mobileNew + out.slice(absM + mobileOld.length);
    }
  }

  // 6) 可见标签控件（lbl_旧 → lbl_新）：add_parameter_widget 生成的独立 Label 控件也要跟着改名，
  //    否则更新/删除控件时找不到配对标签，面板里会残留一个孤立标签。
  const compOldTag = `<WidgetName name="${escapeXmlAttr(`lbl_${name}`)}"/>`;
  const compNewTag = `<WidgetName name="${escapeXmlAttr(`lbl_${newName}`)}"/>`;
  let renamedLabelWidget = false;
  {
    const apos = out.indexOf(compOldTag, rpaStart);
    const rpos = out.indexOf('</ReportParameterAttr>', rpaStart);
    if (apos >= 0 && rpos > apos) {
      out = out.slice(0, apos) + compNewTag + out.slice(apos + compOldTag.length);
      renamedLabelWidget = true;
    }
  }
  save(path, out);
  const hintParts = [`控件名已改为 "${newName}"`];
  hintParts.push(renamedParameterBinding ? '同名报告参数绑定已同步改名' : '无同名报告参数绑定（未改）');
  hintParts.push(renamedNameTag ? 'WidgetNameTagMap 标签映射已同步改名' : '无同名 NameTag 标签映射（未改）');
  hintParts.push(renamedMobileRef ? '移动端控件清单引用已同步改名' : '无同名移动端控件引用（未改）');
  if (renamedLabelWidget) hintParts.push('配套可见标签控件已同步改名');
  return {
    action: 'rename_parameter_widget', name: String(name), newName: String(newName),
    renamedParameterBinding, renamedNameTag, renamedMobileRef, renamedLabelWidget,
    hint: hintParts.join('；') + '。模板内 JS 若用 getWidgetByName/参数名引用旧名，或数据集/单元格条件用 ${旧名}，请到设计器统一改名。',
    bytes: Buffer.byteLength(out, 'utf8'),
  };
}

/**
 * M80 update_parameter_widget：改参数面板存量控件（可见性 + 默认值 + 坐标 + 字体/边框 + **字典**）。
 * - visible=false → InnerWidget 的 <WidgetAttr> 加 invisible="true"（设计器「不可见」复选框地面真值，
 *   OEM成品计划表.cpt page 控件实证）；visible=true → 删该属性（恢复设计器默认未勾选态）；
 * - defaultValue → 改 <widgetValue><O> CDATA（text/date/comboBox/checkBox/label；无 widgetValue
 *   的 submitButton 等传了就拒绝）；
 * - x/y/width/height → BoundsAttr（2026-10-29 补尺寸，改布局不必删了重建）；label → LabelName（
 *   Label 控件则改 widgetValue 文字；传空字符串=删除标签）；fontName/fontSize/noBorder → Label/按钮；
 * - **M117 字典**：dictionary:{type:'table'|'db'|'custom'|'formula'} 整块换（与 update_cell_dictionary 同源
 *   dictionaryXml）；items（CustomDictionary 整表替换）/ kiName+viName+table（TableDataDictionary 逐字段改）/
 *   formula+eFormula（FormulaDictionary 逐字段改）原位改。参数面板是全局的，无 sheet 概念（不像单元格侧）。
 *   控件本无 <Dictionary> 时拒绝（指路 add_parameter_widget 重建），不静默插入。
 * - 以上任一组至少传一个；都不变 → mode=none（不写文件）。
 * 新增控件请用 add_parameter_widget（其 hidden 参数只挪位置、不写 invisible，不等价）。
 */
export function updateParameterWidget(path, { name, type, visible, defaultValue, valueType, x, y, width, height, label, fontName, fontSize, fontStyle, noBorder, dictionary, items, kiName, viName, table, formula, eFormula } = {}) {
  if (!name || !String(name).trim()) throw new Error('updateParameterWidget: 必须提供 name（面板控件名）');
  const hasType = type !== undefined && type !== null && String(type).trim() !== '';
  const hasVisible = visible !== undefined && visible !== null;
  const hasDefault = defaultValue !== undefined && defaultValue !== null;
  // 2026-10-29：坐标扩展为 x/y/width/height（此前只有 x/y，改不了尺寸 → 布局异常只能删了重建，导致
  // 会话里反复 add/delete 的 churn）；label 支持改/删 LabelName。
  const hasCoord = [x, y, width, height].some((v) => v !== undefined && v !== null);
  const hasLabel = label !== undefined && label !== null;
  const hasFont = fontName !== undefined && fontName !== null && String(fontName).trim() !== '';
  const hasBorder = noBorder !== undefined && noBorder !== null;
  // ---- M117 字典参数归一 + 校验（口径与 updateCellDictionary 对齐，仅少了 sheet） ----
  const wantKi = kiName != null ? String(kiName) : null;
  const wantVi = viName != null ? String(viName) : null;
  const wantTable = table != null ? String(table) : null;
  const wantFormula = formula != null ? String(formula) : null;
  const wantEFormula = eFormula === undefined || eFormula === null ? null : String(eFormula);
  let wantItems = null;
  if (items !== undefined) {
    if (!Array.isArray(items)) throw new Error('updateParameterWidget: items 必须是 [{key,value}] 数组（整表替换）');
    for (const [i, it] of items.entries()) {
      if (!it || typeof it !== 'object' || Array.isArray(it)) throw new Error(`updateParameterWidget: items[${i}] 必须是 {key,value} 对象`);
      for (const f of ['key', 'value']) {
        const v = it[f];
        if (v == null || String(v).trim() === '') throw new Error(`updateParameterWidget: items[${i}].${f} 不能为空`);
        if (/[<>&"']/.test(String(v))) throw new Error(`updateParameterWidget: items[${i}].${f} 含 XML 非法字符 <>&"'`);
      }
    }
    wantItems = items.map((it) => ({ key: String(it.key), value: String(it.value) }));
  }
  const hasDict = dictionary != null || wantItems != null || wantKi != null || wantVi != null
    || wantTable != null || wantFormula != null || wantEFormula != null;
  if (!hasVisible && !hasDefault && !hasCoord && !hasLabel && !hasFont && !hasBorder && !hasDict && !hasType) {
    throw new Error('updateParameterWidget: visible / defaultValue / x,y,width,height / label / fontName / noBorder / dictionary,items,kiName,viName,table,formula,eFormula / type 至少传一个');
  }
  for (const [k, v] of [['x', x], ['y', y], ['width', width], ['height', height]]) {
    if (v === undefined || v === null) continue;
    const n = Number(v);
    if (!Number.isFinite(n)) throw new Error(`updateParameterWidget: ${k} 非法 ${JSON.stringify(v)}（须为数字）`);
    if ((k === 'width' || k === 'height') && n <= 0) throw new Error(`updateParameterWidget: ${k} 必须 > 0（收到 ${n}；控件尺寸为 0 会渲染成不可见的异常控件）`);
  }
  if (dictionary != null) {
    if (typeof dictionary !== 'object' || Array.isArray(dictionary)) throw new Error('updateParameterWidget: dictionary 必须是对象');
    if (wantItems != null || wantKi != null || wantVi != null || wantTable != null || wantFormula != null || wantEFormula != null) {
      throw new Error('updateParameterWidget: dictionary（整块替换）与 items/kiName/viName/table/formula/eFormula 不能同时传，二选一');
    }
    const t = String(dictionary.type ?? '');
    if (!['table', 'db', 'custom', 'formula'].includes(t)) {
      throw new Error(`updateParameterWidget: dictionary.type 只能是 table（数据集字典）/db（数据库表字典）/custom（自定义项）/formula（公式数据字典），收到 ${JSON.stringify(dictionary.type)}`);
    }
    if (t === 'table' && !String(dictionary.dsName ?? '').trim()) {
      throw new Error('updateParameterWidget: dictionary.type="table" 必须提供 dsName（数据集名，须已用 add_dataset 声明）');
    }
    if (t === 'db' && !String(dictionary.table ?? '').trim()) {
      throw new Error('updateParameterWidget: dictionary.type="db" 必须提供 table（数据库表名）');
    }
    if (t === 'formula' && !String(dictionary.formula ?? '').trim()) {
      throw new Error('updateParameterWidget: dictionary.type="formula" 必须提供 formula（值公式，如 =range(2010,2012)）');
    }
    if (dictionary.items !== undefined) {
      if (!Array.isArray(dictionary.items)) throw new Error('updateParameterWidget: dictionary.items 必须是 [{key,value}] 数组');
      for (const [i, it] of dictionary.items.entries()) {
        if (!it || typeof it !== 'object' || Array.isArray(it)) throw new Error(`updateParameterWidget: dictionary.items[${i}] 必须是 {key,value} 对象`);
        for (const f of ['key', 'value']) {
          const v = it[f];
          if (v == null || String(v).trim() === '') throw new Error(`updateParameterWidget: dictionary.items[${i}].${f} 不能为空`);
          if (/[<>&"']/.test(String(v))) throw new Error(`updateParameterWidget: dictionary.items[${i}].${f} 含 XML 非法字符 <>&"'`);
        }
      }
    }
  }
  for (const [k, v] of [['kiName', wantKi], ['viName', wantVi], ['table', wantTable]]) {
    if (v != null && v.trim() === '') throw new Error(`updateParameterWidget: ${k} 不接受空字符串（清空字典请用 add_parameter_widget 重建控件）`);
    if (v != null && /[<>&"']/.test(v)) throw new Error(`updateParameterWidget: ${k} 含 XML 非法字符 <>&"'（字段名非法）`);
  }
  if (wantTable != null) assertSafeCdata(wantTable, '取数表名');
  if (wantFormula != null) {
    if (wantFormula.trim() === '') throw new Error('updateParameterWidget: formula 不接受空字符串（公式字典的值公式必填）');
    assertSafeCdata(wantFormula, '公式');
  }
  if (wantEFormula != null && wantEFormula.trim() !== '') assertSafeCdata(wantEFormula, '显示公式');
  const { raw, parsed } = load(path);
  const rpaStart = raw.indexOf('<ReportParameterAttr>');
  const rpaEnd = raw.indexOf('</ReportParameterAttr>', rpaStart);
  if (rpaStart < 0 || rpaEnd < 0) throw new Error('updateParameterWidget: 模板无 <ReportParameterAttr>');
  const seg = raw.slice(rpaStart, rpaEnd);
  const safeName = escapeXmlAttr(String(name));
  const allInner = new RegExp('<InnerWidget\\b[^>]*>[\\s\\S]*?</InnerWidget>', 'g');
  let hit, innerAbs = -1, innerBlock = null;
  while ((hit = allInner.exec(seg)) !== null) {
    if (hit[0].includes(`<WidgetName name="${safeName}"/>`)) { innerAbs = rpaStart + hit.index; innerBlock = hit[0]; break; }
  }
  if (innerAbs < 0 || !innerBlock) throw new Error(`updateParameterWidget: 未找到控件 name="${name}"`);
  let blk = innerBlock;
  const changed = [];
  // text ↔ textarea：只换 InnerWidget class，并补齐 TextArea 所需的 Reg 节点。
  // V4 会话实测：模型需要把单行文本框改成多行（Excel 粘贴多行），此前 cpt-mcp 只能静默降级成 text。
  if (hasType) {
    const wanted = String(type).trim().toLowerCase();
    if (!['text', 'textarea'].includes(wanted)) {
      throw new Error(`updateParameterWidget: type 仅支持 text / textarea（收到 "${type}"）；其它控件类型请用 add_parameter_widget / set_cell_widget 重建，避免破坏下拉/日期/按钮结构`);
    }
    const clsMatch = blk.match(/<InnerWidget\b[^>]*class="([^"]*)"/);
    if (!clsMatch) throw new Error(`updateParameterWidget: 控件 "${name}" 的 InnerWidget 缺少 class 属性（非标准形态）`);
    const current = clsMatch[1];
    const textClass = 'com.fr.form.ui.TextEditor';
    const areaClass = 'com.fr.form.ui.TextArea';
    if (![textClass, areaClass].includes(current)) {
      throw new Error(`updateParameterWidget: 控件 "${name}" 当前类型为 ${current}，不是 text/textarea；本工具只支持两种输入框互转（其它类型请重建控件）`);
    }
    const targetClass = wanted === 'textarea' ? areaClass : textClass;
    if (current !== targetClass) {
      blk = blk.replace(clsMatch[0], () => clsMatch[0].replace(current, targetClass));
      changed.push(`type=${wanted}`);
    }
    if (wanted === 'textarea' && !blk.includes('<Reg class="com.fr.form.ui.reg.NoneReg"/>')) {
      // TextArea 与 TextEditor 的官方形态差异：TextArea 在 <TextAttr/> 后带 Reg；
      // 缺 Reg 不致命，但设计器保存时会补，主动补齐可避免二次写盘。
      if (blk.includes('<TextAttr/>')) {
        blk = blk.replace('<TextAttr/>', '<TextAttr/>\n<Reg class="com.fr.form.ui.reg.NoneReg"/>');
      }
    }
  }
  if (hasVisible) {
    const want = visible === true || String(visible).toLowerCase() === 'true';
    const waMatch = blk.match(/<WidgetAttr\b[^>]*>/);
    if (!waMatch) throw new Error(`updateParameterWidget: 控件 "${name}" 内无 <WidgetAttr>（非标准控件形态）`);
    const waTag = waMatch[0];
    if (want) {
      if (/\binvisible="true"/.test(waTag)) {
        const cleaned = waTag.replace(/\s*\binvisible="[^"]*"/, '');
        // 函数式替换：替换文本含**文件内容**（waTag），字符串式会把其中的 $$/$&/$' 当特殊序列改写模板
        blk = blk.replace(waTag, () => cleaned);
        changed.push('visible=true');
      } // 否则已可见，无需动
    } else {
      if (/\binvisible="true"/.test(waTag)) { /* 已不可见，无需动 */ } else {
        // 同上：替换文本 = 文件内容 waTag 插入常量属性
        blk = blk.replace(waTag, () => waTag.replace(/<WidgetAttr/, '<WidgetAttr invisible="true"'));
        changed.push('visible=false');
      }
    }
  }
  if (hasDefault) {
    const safeVal = assertSafeCdata(String(defaultValue), `控件 ${name} 默认值`);
    if (valueType === 'formula') {
      // M84 公式值类型：设计器「控件值类型=公式」→ <O t="XMLable" class="com.fr.base.Formula">（objectValueXml 同款，官方实证）。
      // 公式内容原样放 <Attributes> CDATA（如 "" / DATE(2024,1,1)），不带 = 前缀（面板控件公式与条件属性 =公式 约定不同）。
      const wvAny = blk.match(/<widgetValue>[\s\S]*?<\/widgetValue>/);
      if (!wvAny) throw new Error(`updateParameterWidget: 控件 "${name}" 无 <widgetValue>（查询按钮等无值控件不支持 defaultValue）`);
      const formulaO = `<O t="XMLable" class="com.fr.base.Formula">\n<Attributes>\n<![CDATA[${safeVal}]]>\n</Attributes>\n</O>`;
      blk = blk.replace(wvAny[0], () => `<widgetValue>\n${formulaO}\n</widgetValue>`);
      changed.push('valueType=formula');
    } else {
      // 文本类型（默认）：裸 <O>
      const wvAny = blk.match(/<widgetValue>[\s\S]*?<\/widgetValue>/);
      if (!wvAny) throw new Error(`updateParameterWidget: 控件 "${name}" 无 <widgetValue>（查询按钮等无值控件不支持 defaultValue）`);
      const wvMatch = blk.match(/<widgetValue>\s*<O>\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*<\/O>\s*<\/widgetValue>/);
      if (!wvMatch) throw new Error(`updateParameterWidget: 控件 "${name}" 的 <widgetValue> 非纯文本 <O>（可能已是公式/字段类型）；要写公式请传 valueType="formula"`);
      blk = blk.replace(wvMatch[0], () => `<widgetValue>\n<O>\n<![CDATA[${safeVal}]]></O>\n</widgetValue>`);
      changed.push('defaultValue');
    }
  }
  if (hasLabel) {
    const wantLabel = String(label);
    const isLabelWidget = /^<InnerWidget\s+class="com\.fr\.form\.ui\.Label"/.test(blk);
    if (isLabelWidget) {
      // Label 控件的"标签文字"就是 widgetValue 内容（官方 Label 控件无 LabelName）
      const safeVal = assertSafeCdata(wantLabel, `控件 ${name} 标签文字`);
      const wvMatch = blk.match(/<widgetValue>\s*<O>\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*<\/O>\s*<\/widgetValue>/);
      if (!wvMatch) throw new Error(`updateParameterWidget: Label 控件 "${name}" 的 <widgetValue> 不是纯文本 <O>，无法直接改标签文字`);
      if (wvMatch[1] !== wantLabel) {
        blk = blk.replace(wvMatch[0], () => `<widgetValue>\n<O>\n<![CDATA[${safeVal}]]></O>\n</widgetValue>`);
        changed.push(`label=${wantLabel}`);
      }
    } else {
      const existing = blk.match(/<LabelName\b[^>]*\/>/);
      if (wantLabel.trim() === '') {
        if (existing) { blk = blk.replace(existing[0], ''); changed.push('label=(removed)'); }
      } else {
        const newTag = `<LabelName name="${escapeXmlAttr(wantLabel)}"/>`;
        if (existing) {
          if (existing[0] !== newTag) { blk = blk.replace(existing[0], () => newTag); changed.push(`label=${wantLabel}`); }
        } else {
          const wm = blk.match(/<WidgetName\b[^>]*\/>/);
          if (!wm) throw new Error(`updateParameterWidget: 控件 "${name}" 内无 <WidgetName>，无法插入标签`);
          blk = blk.replace(wm[0], () => `${wm[0]}\n${newTag}`);
          changed.push(`label=${wantLabel}`);
        }
      }
    }
  }
  if (hasFont || hasBorder) {
    // M81 原门禁「字体/边框只允许 Label」经 M114 复核**过严**，按官方证据放宽：
    //   全量 1550 份样本里，面板按钮（FormSubmitButton / FreeButton 等）带 <FRFont> 的有 **5 例**
    //   （demo/Phone/form/物流信息登记-phone.cpt 的查询按钮 Search：FRFont 紧跟 <Hotkeys> 之后；
    //    demo/cloud/demobetter.cpt 的 Search；同文件 3 个 FreeButton），
    //   而 Label 带 FRFont 412 例 —— 说明"按钮从来不带 FRFont"不成立，是 M81 当时的取样偏差。
    //   sandbox7 的「查询按钮 fontName 工具不支持」正由此而来；本轮放开按钮的 fontName 写入。
    // 仍然保留的边界：
    //   · 边框（noBorder）继续只允许 Label —— 按钮无官方 border 实证；
    //   · 其余控件（输入框/下拉/日期等）继续拒绝 —— 它们的字体确实走主题，官方无 FRFont 实例。
    const clsMatch = blk.match(/^<InnerWidget\s+class="([^"]+)"/);
    const cls = clsMatch?.[1] ?? '';
    const isLabel = cls === 'com.fr.form.ui.Label';
    const isButton = /Button|Submit/i.test(cls);
    if (!isLabel && !isButton) {
      throw new Error(`updateParameterWidget: 字体/边框只支持 Label 标签与按钮控件，控件 "${name}" 是 ${cls || '未知类'}（输入框/下拉的字体走模板主题，无需逐控件设置；改主题请用 set_template_theme）`);
    }
    if (hasBorder && !isLabel) {
      throw new Error(`updateParameterWidget: 边框只支持 Label 标签控件，控件 "${name}" 是 ${cls}（官方无按钮 border 实证）；按钮边框请走设计器`);
    }
    if (hasFont) {
      const fn = String(fontName).trim();
      const fs = fontSize !== undefined && fontSize !== null ? Number(fontSize) : 96;
      if (!Number.isFinite(fs) || fs <= 0) throw new Error(`updateParameterWidget: fontSize 非法 ${JSON.stringify(fontSize)}（设计器常用 96）`);
      const fst = fontStyle !== undefined && fontStyle !== null ? Number(fontStyle) : 0;
      if (!Number.isInteger(fst) || fst < 0) throw new Error(`updateParameterWidget: fontStyle 非法 ${JSON.stringify(fontStyle)}（0=常规）`);
      const frFont = `<FRFont name="${escapeXmlAttr(fn)}" style="${fst}" size="${fs}"/>`;
      const existFont = blk.match(/<FRFont\b[^>]*\/?>/);
      if (existFont) {
        // 函数式替换：frFont 内嵌用户输入字体名；字符串式会把 $&/$'/$$ 当特殊序列（$& 会把匹配到的
        // <FRFont…/> 或 </InnerWidget> 注入属性值，产出 XML 非法但 isError=false 的静默坏文件）
        blk = blk.replace(existFont[0], () => frFont);
      } else if (isButton) {
        // 按钮的官方落点：<FRFont> 在 <Hotkeys> 之后、<isCustomType> 之前
        // （实证 demo/Phone/form/物流信息登记-phone.cpt 的 FormSubmitButton/Search）。
        // 不能盲目追加到 </InnerWidget> 前 —— 那会跑到 <isCustomType> 之后，与官方顺序不符。
        const customIdx = blk.indexOf('<isCustomType');
        if (customIdx >= 0) blk = blk.slice(0, customIdx) + `${frFont}\n` + blk.slice(customIdx);
        else blk = blk.replace(/<\/InnerWidget>\s*$/, () => `${frFont}\n</InnerWidget>`);
      } else {
        blk = blk.replace(/<\/InnerWidget>\s*$/, () => `${frFont}\n</InnerWidget>`);
      }
      changed.push(`font=${fn}/${fs}`);
    }
    if (hasBorder) {
      const wantNone = noBorder === true || String(noBorder).toLowerCase() === 'true';
      if (!wantNone) throw new Error('updateParameterWidget: 边框目前只支持 noBorder=true（无边框，设计器实证形态）；其他边框请走设计器');
      // 地面真值（OEM成品计划表.cpt 面板 Label）：border 紧跟 FRFont/LabelAttr 之后
      const noBorderXml = `<border style="0">
<color>
<FineColor color="-723724" hor="-1" ver="-1"/>
</color>
</border>`;
      const existBorder = blk.match(/<border\b[\s\S]*?<\/border>|<border\b[^>]*\/>/);
      blk = existBorder ? blk.replace(existBorder[0], noBorderXml) : blk.replace(/<\/InnerWidget>\s*$/, `${noBorderXml}\n</InnerWidget>`);
      changed.push('border=none');
    }
  }
  // M117 字典就地改写：整块换走 dictionaryXml（与 update_cell_dictionary 同源），
  // 原位逐字段改走 editDictBlockInPlace（同一实现）。控件本无 <Dictionary> 时拒绝，不静默插入。
  let dictBefore = null;
  let dictAfter = null;
  if (hasDict) {
    const dOpen = blk.match(/<Dictionary\b[^>]*>/);
    if (!dOpen) throw new Error(`updateParameterWidget: 控件 "${name}" 内无 <Dictionary>（该控件不是下拉字典控件，不静默插入；新建字典请用 add_parameter_widget(type=comboBox/comboCheckBox, dictionary=…) 重建控件）`);
    const dClose = blk.indexOf('</Dictionary>', dOpen.index);
    if (dClose < 0) throw new Error(`updateParameterWidget: 控件 "${name}" 的 <Dictionary> 未闭合`);
    const dEnd = dClose + '</Dictionary>'.length;
    const block = blk.slice(dOpen.index, dEnd);
    if (dictionary != null) {
      if (dictionary.type === 'table') assertDatasetExists(parsed, String(dictionary.dsName).trim(), '数据集字典');
      const dictItems = dictionary.type === 'custom' ? (dictionary.items ?? []) : items;
      const nextBlock = dictionaryXml({ dictionary, items: dictItems, label: `参数控件 ${name}` });
      dictBefore = dictBlockSnapshot(block);
      dictAfter = dictBlockSnapshot(nextBlock);
      if (nextBlock !== block) {
        blk = blk.slice(0, dOpen.index) + nextBlock + blk.slice(dEnd);
        changed.push('dictionary');
      }
    } else {
      const edited = editDictBlockInPlace({
        block, dOpenTag: dOpen[0], wantKi, wantVi, wantTable, wantItems, wantFormula, wantEFormula,
        fn: 'updateParameterWidget', where: `控件 "${name}"`,
      });
      dictBefore = dictBlockSnapshot(block);
      dictAfter = dictBlockSnapshot(edited.block);
      if (edited.mode !== 'none') {
        blk = blk.slice(0, dOpen.index) + edited.block + blk.slice(dEnd);
        changed.push('dictionary');
      }
    }
  }
  // M84 坐标：BoundsAttr 紧跟 InnerWidget 之后（同一 BoundsWidget 内平级），改 x/y（存在则替换，缺省则补）。
  // 必须在 changed 空判断之前算好，否则「只传坐标」会被提前 return mode=none。
  let coordPatch = null;
  if (hasCoord) {
    const afterStart = innerAbs + innerBlock.length;
    const lookahead = raw.slice(afterStart, afterStart + 256);
    const baMatch = lookahead.match(/<BoundsAttr\b[^>]*\/>/);
    if (!baMatch) throw new Error(`updateParameterWidget: 控件 "${name}" 后未找到 <BoundsAttr>（非标准 BoundsWidget 形态）`);
    let baTag = baMatch[0];
    const setNum = (tag, attr, val) => {
      const n = Number(val);
      if (!Number.isFinite(n)) throw new Error(`updateParameterWidget: ${attr} 非法 ${JSON.stringify(val)}（须为数字）`);
      const v = String(n);
      const re = new RegExp(`\\b${attr}="[^"]*"`);
      return re.test(tag) ? tag.replace(re, `${attr}="${v}"`) : tag.replace(/\/>$/, ` ${attr}="${v}"/>`);
    };
    if (x !== undefined && x !== null) baTag = setNum(baTag, 'x', x);
    if (y !== undefined && y !== null) baTag = setNum(baTag, 'y', y);
    if (width !== undefined && width !== null) baTag = setNum(baTag, 'width', width);
    if (height !== undefined && height !== null) baTag = setNum(baTag, 'height', height);
    if (baTag !== baMatch[0]) {
      coordPatch = { relOffset: baMatch.index, newTag: baTag, oldLen: baMatch[0].length };
      const xyDesc = `pos=${x !== undefined ? Number(x) : '(unchanged)'},${y !== undefined ? Number(y) : '(unchanged)'}`;
      // 兼容旧断言：只传 x/y 时 changed 仍为 pos=<x>,<y>；传了尺寸才追加 160x28 后缀
      changed.push((width === undefined && height === undefined)
        ? xyDesc
        : `${xyDesc},${width !== undefined ? Number(width) : '(unchanged)'}x${height !== undefined ? Number(height) : '(unchanged)'}`);
    }
  }
  if (changed.length === 0) {
    const ret = { action: 'update_parameter_widget', name: String(name), mode: 'none', hint: '目标状态与现状一致，未改动' };
    if (hasDict) { ret.dictBefore = dictBefore; ret.dictAfter = dictAfter; }
    return ret;
  }
  let out = raw.slice(0, innerAbs) + blk + raw.slice(innerAbs + innerBlock.length);
  if (coordPatch) {
    // blk 已替换 InnerWidget（长度可能变），BoundsAttr 相对 InnerWidget 结束的偏移不变
    const baAbs = innerAbs + blk.length + coordPatch.relOffset;
    out = out.slice(0, baAbs) + coordPatch.newTag + out.slice(baAbs + coordPatch.oldLen);
  }
  // 可见标签控件（add_parameter_widget 生成的独立 Label，名 lbl_<name>）：文字在 widgetValue 里；
  // label="" 时删除该标签控件（否则改标签只剩 LabelName，预览看不见）。
  if (hasLabel) {
    const compRe = new RegExp(`<Widget class="com\\.fr\\.form\\.ui\\.container\\.WAbsoluteLayout\\$BoundsWidget">\\s*<InnerWidget class="com\\.fr\\.form\\.ui\\.Label">\\s*<WidgetName name="${escapeXmlAttr(`lbl_${name}`)}"/>[\\s\\S]*?</Widget>\\s*`);
    const comp = out.match(compRe);
    if (comp) {
      if (String(label).trim() === '') {
        out = out.slice(0, comp.index) + out.slice(comp.index + comp[0].length);
      } else {
        const safe = assertSafeCdata(String(label), `控件 ${name} 可见标签`);
        const newBlock = comp[0].replace(/<widgetValue>\s*<O>\s*<!\[CDATA\[[\s\S]*?\]\]>\s*<\/O>\s*<\/widgetValue>/, () => `<widgetValue>\n<O>\n<![CDATA[${safe}]]></O>\n</widgetValue>`);
        out = out.slice(0, comp.index) + newBlock + out.slice(comp.index + comp[0].length);
      }
    }
  }
  save(path, out);
  // mode 口径与 update_cell_dictionary 对齐：仅字典整块替换 → 'replace'；其余（含字典原位改/混合改）→ 'update'
  const onlyDictReplace = dictionary != null && changed.length === 1 && changed[0] === 'dictionary';
  const ret = { action: 'update_parameter_widget', name: String(name), mode: onlyDictReplace ? 'replace' : 'update', changed, bytes: Buffer.byteLength(out, 'utf8') };
  if (hasDict) { ret.dictBefore = dictBefore; ret.dictAfter = dictAfter; }
  return ret;
}

/** 内部的 ReportParameterAttr 末尾辅助（rename 过程中 out 在变化，动态求） */
function rpaEndFor(out) {
  const s = out.indexOf('<ReportParameterAttr>');
  return out.indexOf('</ReportParameterAttr>', s);
}

/**
 * 删除参数面板上指定 name 的控件。
 * 官方结构：<Layout><Widget class="com.fr.form.ui.container.WAbsoluteLayout$BoundsWidget">
 *   <InnerWidget class="..."><WidgetName name="X"/>...</InnerWidget><BoundsAttr .../></Widget></Layout>
 * 必须整块删除外层 Widget（BoundsWidget 壳 + InnerWidget + BoundsAttr），否则残留空壳 BoundsWidget
 * 会让设计器打不开（此前缺陷：只删 InnerWidget 留壳，sandbox4 事故已实测）。参数定义 <Parameter>
 * 保留不动（删控件 ≠ 删参数）。
 */
export function deleteParameterWidget(path, name) {
  if (!name) throw new Error('deleteParameterWidget: 必须提供 name（与 add_parameter_widget 的 name 一致）');
  const { raw } = load(path);
  // ReportParameterAttr 块
  const rpaStart = raw.indexOf('<ReportParameterAttr>');
  const rpaEnd = raw.indexOf('</ReportParameterAttr>', rpaStart);
  if (rpaStart < 0 || rpaEnd < 0) {
    throw new Error('deleteParameterWidget: 模板无 <ReportParameterAttr>（请用 create_cpt 生成骨架）');
  }
  const seg = raw.slice(rpaStart, rpaEnd);
  const safeName = escapeXmlAttr(String(name));

  // 枚举所有 InnerWidget 块，选含该 WidgetName 的那个（避免跨块误匹配：非贪婪匹配不能跨 </InnerWidget>）
  const allInner = new RegExp('<InnerWidget\\b[^>]*>[\\s\\S]*?</InnerWidget>', 'g');
  let innerHit = null, innerStart = -1, innerEnd = -1;
  while ((innerHit = allInner.exec(seg)) !== null) {
    if (innerHit[0].includes(`<WidgetName name="${safeName}"/>`)) {
      innerStart = innerHit.index;
      innerEnd = innerHit.index + innerHit[0].length;
      break;
    }
  }
  if (innerStart < 0) throw new Error(`deleteParameterWidget: 未找到 name="${name}" 的控件`);

  // 向上扩展到外层 BoundsWidget 整块（开标签在 InnerWidget 之前，闭标签在 InnerWidget 之后）
  const absInnerStart = rpaStart + innerStart;
  const absInnerEnd = rpaStart + innerEnd;
  // 外层开标签：InnerWidget 之前最近的 <Widget class="...BoundsWidget">
  const before = raw.slice(rpaStart, absInnerStart);
  const bwOpen = before.lastIndexOf('<Widget class="com.fr.form.ui.container.WAbsoluteLayout$BoundsWidget">');
  // 外层闭标签：InnerWidget 之后最近的 </Widget>
  const after = raw.indexOf('</Widget>', absInnerEnd);
  let out;
  if (bwOpen < 0 || after < 0) {
    // 退化：模板不含 BoundsWidget 壳（老式/自制结构），仅删 InnerWidget 并清紧随的空行
    const newSeg = raw.slice(rpaStart, absInnerStart) + raw.slice(absInnerEnd);
    out = raw.slice(0, rpaStart) + newSeg + raw.slice(rpaEnd);
  } else {
    const blockStart = rpaStart + bwOpen;
    const blockEnd = after + '</Widget>'.length;
    // 连同块后换行一起删
    let e = blockEnd;
    while (e < raw.length && (raw[e] === '\n' || raw[e] === '\r')) e++;
    out = raw.slice(0, blockStart) + raw.slice(e);
  }
  // 配套可见标签控件（add_parameter_widget 生成的独立 Label，名为 lbl_<name>）：控件删除后一并删除，
  // 否则面板上会残留一个孤立标签（「删除筛选控件后标签还在」）。
  {
    const compTag = new RegExp(`<Widget class="com\\.fr\\.form\\.ui\\.container\\.WAbsoluteLayout\\$BoundsWidget">\\s*<InnerWidget class="com\\.fr\\.form\\.ui\\.Label">\\s*<WidgetName name="${escapeXmlAttr(`lbl_${name}`)}"/>[\\s\\S]*?</Widget>\\s*`);
    out = out.replace(compTag, '');
  }
  // M72 闭环：add_parameter_widget 会给同名参数写 <Parameter><Attributes name="X"/> 绑定块；
  // 控件删掉后若已无任何同名控件，同步清理该 Parameter 块，否则 get_parameter_panel 读回
  // parameters 残留死条目（删除不完整）。仍有其它同名控件时保留（共享绑定）。
  out = removeOrphanPanelParameter(out, rpaStart, safeName);
  save(path, out);
  return { action: 'delete_parameter_widget', name, removed: (bwOpen < 0 || after < 0) ? 'inner-only' : 'bounds-widget', bytes: Buffer.byteLength(out, 'utf8') };
}

/** 删除 ReportParameterAttr 内「已无同名控件引用」的孤儿 <Parameter> 绑定块 */
function removeOrphanPanelParameter(raw, rpaStart, safeName) {
  const end = raw.indexOf('</ReportParameterAttr>', rpaStart);
  if (end < 0) return raw;
  const seg2 = raw.slice(rpaStart, end);
  if (new RegExp(`<WidgetName name="${safeName}"/>`).test(seg2)) return raw; // 仍有同名控件 → 保留共享绑定
  const pm = new RegExp(`<Parameter>\\s*<Attributes name="${safeName}"[^>]*/>[\\s\\S]*?</Parameter>`).exec(seg2);
  if (!pm) return raw;
  let absStart = rpaStart + pm.index;
  let absEnd = rpaStart + pm.index + pm[0].length;
  while (absEnd < raw.length && (raw[absEnd] === '\n' || raw[absEnd] === '\r')) absEnd++;
  return raw.slice(0, absStart) + raw.slice(absEnd);
}

/**
 * P1-2 delete_mobile_widget_ref：定向删除移动端孤儿条目（残留②）。
 *
 * 背景：控件删掉/改名后，<MobileWidgetList> 内的 <Widget widgetName="X"/> 与
 * <WidgetNameTagMap> 内的 <NameTag name="X" …/> 可能残留成孤儿（如 fine_username_c），
 * 移动端布局挂空；rename 只支持现存控件改名（改名≠删除），此前无专用清理工具。
 *
 * 只删两处（均限定 <ReportParameterAttr> 块内），不碰面板控件本体 / Parameter 绑定 /
 * 数据集层：
 *   ① <MobileWidgetList>…</MobileWidgetList> 内全部 <Widget widgetName="X"…/> 条目；
 *   ② <WidgetNameTagMap>…</WidgetNameTagMap> 内全部 <NameTag name="X"…> 条目。
 * 只清孤儿：RPA 内仍有同名存活控件（<WidgetName name="X"/>）时拒绝（删了会挂空移动端
 * 布局；请先 delete_parameter_widget 删控件，或 rename_parameter_widget 改名）。
 * 两处皆无命中时抛错（不是孤儿或名字拼错）。
 */
export function deleteMobileWidgetRef(path, { name } = {}) {
  if (!name || !String(name).trim()) throw new Error('deleteMobileWidgetRef: 必须提供 name（要清理的 widgetName，如 fine_username_c）');
  const safeName = escapeXmlAttr(String(name));
  const rxName = String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const { raw } = load(path);
  const rpaStart = raw.indexOf('<ReportParameterAttr>');
  const rpaEnd = raw.indexOf('</ReportParameterAttr>', rpaStart);
  if (rpaStart < 0 || rpaEnd < 0) throw new Error('deleteMobileWidgetRef: 模板无 <ReportParameterAttr>');
  const seg = raw.slice(rpaStart, rpaEnd);
  if (seg.includes(`<WidgetName name="${safeName}"/>`)) {
    throw new Error(`deleteMobileWidgetRef: 控件 "${name}" 仍存在（非孤儿），拒绝清理移动端引用；请先 delete_parameter_widget 删控件，或用 rename_parameter_widget 改名（改名会自动同步移动端引用）`);
  }
  let outSeg = seg;
  let removedMobileRef = 0;
  let removedNameTag = 0;
  // ① MobileWidgetList 容器内删条目（容器本身保留，空了也不摘 —— 官方骨架即有空容器形态）
  outSeg = outSeg.replace(/<MobileWidgetList>[\s\S]*?<\/MobileWidgetList>/g, (block) => block.replace(
    new RegExp(`<Widget widgetName="${rxName}"[^>]*>`, 'g'),
    (m) => { removedMobileRef++; return ''; },
  ));
  // ② WidgetNameTagMap 容器内删条目（<NameTag name="X" tag="…"…> 单标签形态）
  outSeg = outSeg.replace(/<WidgetNameTagMap>[\s\S]*?<\/WidgetNameTagMap>/g, (block) => block.replace(
    new RegExp(`<NameTag name="${rxName}"[^>]*>`, 'g'),
    (m) => { removedNameTag++; return ''; },
  ));
  if (removedMobileRef === 0 && removedNameTag === 0) {
    throw new Error(`deleteMobileWidgetRef: 未找到 "${name}" 的移动端条目（MobileWidgetList / WidgetNameTagMap 内均无；若控件本体仍在请用 delete_parameter_widget）`);
  }
  const out = raw.slice(0, rpaStart) + outSeg + raw.slice(rpaEnd);
  save(path, out);
  return { action: 'delete_mobile_widget_ref', name: String(name), removedMobileRef, removedNameTag, bytes: Buffer.byteLength(out, 'utf8') };
}

/**
 * 删除指定工作表 ReportAttrSet 内的 <Header> 或 <Footer> 块（删 = 恢复成无页眉页脚）。
 * sheet 不传默认 sheet 0。
 */
export function deletePageHeaderFooter(path, { which, sheet } = {}) {
  if (!['header', 'footer'].includes(which)) throw new Error('delete_page_header_footer: which 必须是 "header" 或 "footer"');
  const { raw } = load(path);
  const occ = sheet == null ? 0 : locateSheet(raw, sheet).index;
  const attrStarts = findAll(raw, '<ReportAttrSet>');
  if (occ >= attrStarts.length) throw new Error(`工作表 ${occ} 越界`);
  const tag = which === 'header' ? 'Header' : 'Footer';
  // ReportAttrSet 段
  const s2 = attrStarts[occ];
  const [bs, be] = blockRange(raw, s2, '<ReportAttrSet>', '</ReportAttrSet>');
  const seg = raw.slice(bs, be);
  // 自闭合 <Header/> 形态
  const selfRe = new RegExp(`<${tag}/>\\n?`);
  let removed = 0;
  let newSeg = seg;
  if (selfRe.test(seg)) {
    newSeg = seg.replace(selfRe, '');
    removed += (seg.match(selfRe) || []).length;
  }
  // 开闭对 <Header>...</Header>
  const pairHits = findAll(seg, `<${tag}`);
  for (const t of pairHits.reverse()) {
    const ge = raw.indexOf('>', t);
    if (raw.slice(t, ge + 1).trim().endsWith('/>')) continue; // 跳过自闭合
    const [hs, he] = blockRange(seg, t, `<${tag}`, `</${tag}>`);
    newSeg = newSeg.slice(0, hs) + newSeg.slice(he);
    removed += 1;
  }
  if (removed === 0) {
    return { action: 'delete_page_header_footer', which, sheet: occ, removed: 0, bytes: Buffer.byteLength(raw, 'utf8') };
  }
  const out = raw.slice(0, bs) + newSeg + raw.slice(be);
  save(path, out);
  return { action: 'delete_page_header_footer', which, sheet: occ, removed, bytes: Buffer.byteLength(out, 'utf8') };
}



// M51 ① delete_dataset：删除指定数据集（TableData 块）
export function deleteDataset(path, name) {
  const { raw } = load(path);
  const [b, e] = locateTableData(raw, name);
  const out = removeRange(raw, b, e);
  save(path, out);
  return { action: 'delete_dataset', name, bytes: Buffer.byteLength(out, 'utf8') };
}

// M51 ② delete_chart：删除指定坐标的图表单元格（Chart 是 <C><O t="CC">...</O></C>）
export function deleteChart(path, column, row, sheet) {
  const { raw } = load(path);
  const [cb, ce] = locateCell(raw, column, row, `图表(${column},${row})`, sheet);
  const seg = raw.slice(cb, ce);
  if (!seg.includes('<O t="CC">') && !seg.includes('class="com.fr.chart')) {
    throw new Error(`delete_chart 失败：单元格(${column},${row}) 不是图表（无 <O t="CC">）；如为普通单元格请用 delete_cell`);
  }
  const out = removeRange(raw, cb, ce);
  save(path, out);
  return { action: 'delete_chart', cell: `${column},${row}`, sheet: sheet ?? 0, bytes: Buffer.byteLength(out, 'utf8') };
}

// M51 ③ get_cell_hyperlink：读取指定单元格的超级链接（NameJavaScriptGroup 内容）
export function getCellHyperlink(path, column, row, sheet) {
  const { raw } = load(path);
  const [cb, ce] = locateCell(raw, column, row, `单元格(${column},${row})`, sheet);
  const seg = raw.slice(cb, ce);
  const gOpen = seg.indexOf('<NameJavaScriptGroup>');
  const gClose = seg.indexOf('</NameJavaScriptGroup>', gOpen);
  if (gOpen < 0 || gClose < 0) {
    return { cell: `${column},${row}`, sheet: sheet ?? 0, hyperlinks: [], hasHyperlink: false };
  }
  const group = seg.slice(gOpen + '<NameJavaScriptGroup>'.length, gClose);
  const links = [];
  // C-B：超链 script 也是 JS 读回出口，含设计器转义 `]A` 时同样给元数据
  const jsScripts = [];
  const re = /<NameJavaScript name="([^"]*)">([\s\S]*?)<\/NameJavaScript>/g;
  let m;
  while ((m = re.exec(group)) !== null) {
    const [, name, body] = m;
    const js = body.match(/<JavaScript class="([^"]*)">([\s\S]*?)<\/JavaScript>/);
    const cls = js ? js[1] : null;
    let type = null, url = null, script = null, reportletPath = null, params = [];
    if (cls && cls.includes('ReportletHyperlink')) {
      type = 'reportlet';
      // add_cell_hyperlink 写 <ReportletName showPI="true">；官方老样本也有 <ReportletPath> 形态，两处都读。
      // 正文放宽：优先 CDATA、其次裸文本（reportlet 路径有时不带 CDATA，避免漏读）。
      reportletPath = readTagText(body, 'ReportletName') ?? readTagText(body, 'ReportletPath');
    } else if (cls && cls.includes('WebHyperlink')) {
      type = 'url';
      url = readTagText(body, 'URL');
    } else if (cls && cls.includes('JavaScriptImpl')) {
      type = 'script';
      script = readTagText(body, 'Content');
    }
    // 传参读取：官方/MCP 形态是 <Parameter><Attributes name="X"/><O>CDATA</O></Parameter>
    // （公式值 CDATA 在 <O t="XMLable"> 内嵌 <Attributes> 里）。值读取放宽：优先 <O> 内
    // 首个 CDATA，其次 <O> 裸文本（固定值不带 CDATA 时也能读回），不再只认「全块首个 CDATA」。
    params = [];
    const pmRe = /<Parameter>[\s\S]*?<\/Parameter>/g;
    let pm;
    while ((pm = pmRe.exec(body)) !== null) {
      const block = pm[0];
      const pname = (block.match(/<Attributes\b[^>]*?\bname="([^"]*)"/) || [])[1] ?? null;
      const oMatch = block.match(/<O\b[^>]*>([\s\S]*?)<\/O>/);
      let pval = null;
      if (oMatch) {
        const cdata = oMatch[1].match(/<!\[CDATA\[([\s\S]*?)\]\]>/);
        pval = cdata ? cdata[1] : (oMatch[1].trim() || null);
      } else {
        pval = (block.match(/<!\[CDATA\[([\s\S]*?)\]\]>/) || [])[1] ?? null;
      }
      if (pname != null) params.push({ name: pname, value: pval });
    }
    links.push({ name, type, url, script, reportletPath, params });
    if (typeof script === 'string') jsScripts.push(script);
  }
  const designerEscapes = aggregateDesignerEscapes(jsScripts);
  return {
    cell: `${column},${row}`, sheet: sheet ?? 0, hyperlinks: links, hasHyperlink: links.length > 0,
    ...(designerEscapes ? { designerEscapes } : {}),
  };
}

// M51 ④ delete_float_element：删除指定名称的浮动元素（FloatElement 块）
export function deleteFloatElement(path, name, sheet) {
  const { raw } = load(path);
  const blocks = sheetBlocks(raw);
  const occ = sheet == null ? 0 : locateSheet(raw, sheet).index;
  const lo = blocks[occ]?.start ?? 0, hi = blocks[occ]?.end ?? raw.length;
  const safeName = escapeXmlAttr(name);
  const feStarts = findAll(raw, '<com.fr.report.cell.FloatElement').filter((s) => s >= lo && s < hi);
  for (const s of feStarts) {
    const [b, e] = blockRange(raw, s, '<com.fr.report.cell.FloatElement', '</com.fr.report.cell.FloatElement>');
    const seg = raw.slice(b, e);
    if (seg.includes(`<FloatElementName name="${safeName}"`) || seg.includes(`<FloatElementName name="${safeName}"/>`)) {
      const out = removeRange(raw, b, e);
      save(path, out);
      return { action: 'delete_float_element', sheet: occ, name, bytes: Buffer.byteLength(out, 'utf8') };
    }
  }
  throw new Error(`定位失败：未找到浮动元素 ${name}（sheet ${occ}）`);
}

/**
 * 单元格内嵌 <Listener event> 的增/改/删核心（共享给单格与批量入口）。
 * raw 传「当前编辑中的字符串」；每格独立定位，sheet 可选。
 */
function applyCellListenerIn(raw, column, row, { event, js, className = 'com.fr.js.JavaScriptImpl', match, sheet, strictDelete = true, addOnly = false } = {}) {
  const [cb, ce] = locateCell(raw, column, row, `单元格(${column},${row})`, sheet);
  const seg = raw.slice(cb, ce);

  // 定位该单元格内指定 event 的 <Listener>（同 event 可多个，match 精确命中）——复用统一 helper
  const loc = locateCellListener(seg, event, match);
  const lStart = loc ? cb + loc.index : -1;

  // addOnly（add_cell_listener 收敛为「只增」）：同 event 已有 Listener 时报错引导改/删专用工具，不覆盖。
  if (addOnly && lStart >= 0) {
    throw new Error(`add_cell_listener 只增不改：单元格(${column},${row}) 内已存在 event="${event}" 的 Listener；修改请用 update_cell_listener，删除请用 delete_cell_listener`);
  }

  if (js == null) {
    if (lStart < 0) {
      // 单格版保持原有严格语义（找不到即报错）；批量版 strictDelete=false 时视为无操作跳过
      if (strictDelete) throw new Error(`setCellListener: 单元格(${column},${row}) 内未找到 event="${event}" 的 Listener`);
      return { out: raw, mode: 'none' };
    }
    const absEnd = raw.indexOf('</Listener>', lStart) + '</Listener>'.length;
    let e = absEnd;
    while (e < raw.length && (raw[e] === '\n' || raw[e] === '\r')) e++;
    return { out: raw.slice(0, lStart) + raw.slice(e), mode: 'delete' };
  }

  const safeJs = assertSafeCdata(String(js), '单元格 JS');
  const node = `<Listener event="${escapeXmlAttr(String(event))}">
<JavaScript class="${escapeXmlAttr(className)}">
<Parameters/>
<Content>
<![CDATA[${safeJs}]]></Content>
</JavaScript>
</Listener>\n`;
  if (lStart >= 0) {
    const absEnd = raw.indexOf('</Listener>', lStart) + '</Listener>'.length;
    return { out: raw.slice(0, lStart) + node + raw.slice(absEnd), mode: 'update' };
  }
  // 传了 match 却未命中 → 定位失败，拒绝静默插入
  if (match !== undefined && match !== null && String(match).trim() !== '') {
    throw new Error(`setCellListener: 单元格(${column},${row}) 内未找到 event="${event}" 且含 "${match}" 的 Listener`);
  }
  // 对齐官方结构：单元格有 <Widget> 时插到 Widget 开标签后（官方 FreeButton 的 Listener 在 Widget 内）；
  // 无 Widget（普通单元格直接内嵌）时插到 <C ...> 开标签后。
  const wHit = seg.match(/<Widget\b[^>]*>/);
  const anchorEnd = wHit ? cb + wHit.index + wHit[0].length : raw.indexOf('>', cb) + 1;
  return { out: raw.slice(0, anchorEnd) + '\n' + node + raw.slice(anchorEnd), mode: 'insert' };
}

/**
 * 单格版：给单元格挂 <Listener event> 控件事件 JS（「只增」语义）。
 * 仅当该单元格内尚不存在同 event 的 Listener 时才写入；同 event 已有 Listener 时报错
 * （修改请用 update_cell_listener，删除请用 delete_cell_listener），不覆盖、不删除。
 * 与批量入口共享 applyCellListenerIn（单格与批量均走 addOnly 只增语义）。
 */
export function setCellListener(path, column, row, { event, js, className = 'com.fr.js.JavaScriptImpl', sheet } = {}) {
  if (column == null || row == null) throw new Error('setCellListener: 必须提供 column 与 row（均从 0 起）');
  if (!event || !String(event).trim()) throw new Error('setCellListener: 必须提供 event（如 "click"/"afterinit"/"afteredit"/"stopedit"）');
  if (js == null || String(js).trim() === '') throw new Error('add_cell_listener 只增不改删：必须提供 js；删除监听器请用 delete_cell_listener，修改请用 update_cell_listener');
  const { raw } = load(path);
  const r = applyCellListenerIn(raw, column, row, { event, js, className, sheet, addOnly: true });
  save(path, r.out);
  // 只增语义：没有旧块（before 恒 0），统一给 before/after 度量供对账；片段替换请用 update_cell_listener
  const after = jsMetricsOf(String(js));
  return {
    action: 'set_cell_listener', cell: `${column},${row}`, event, mode: r.mode,
    jsBytesBefore: 0, jsLinesBefore: 0, jsBytesAfter: after.bytes, jsLinesAfter: after.lines,
    bytes: Buffer.byteLength(r.out, 'utf8'),
  };
}

/**
 * 批量版：同一段事件 JS 一次性挂到多个单元格（「只增」语义，与单格 add_cell_listener 一致）。
 * 场景：填报模板要为一整列/一整个区域的数据格都挂 stopedit/click 事件 ——
 * 之前只能逐格 add_cell_listener 调用 N 次（真实模板 20~36 个同事件 Listener），
 * 现在 cells:[{column,row}...] 一次完成。js 必填；每个单元格仅当尚不存在同 event 的
 * Listener 时才写入；同 event 已有 Listener 的格记 failed 并继续（不覆盖、不删除）。
 * 每格返回 mode：insert（新挂）/ failed（同 event 已有 Listener）。
 */
export function batchAddCellListeners(path, cells, { event, js, className = 'com.fr.js.JavaScriptImpl', sheet } = {}) {
  if (!event || !String(event).trim()) throw new Error('batchAddCellListeners: 必须提供 event（如 "click"/"afterinit"/"afteredit"/"stopedit"）');
  if (js == null || String(js).trim() === '') throw new Error('batchAddCellListeners: 必须提供 js（只增；删除请用 delete_cell_listener，修改请用 update_cell_listener）');
  if (!Array.isArray(cells) || cells.length === 0) throw new Error('batchAddCellListeners: 必须提供 cells 数组（[{column,row},...]）');
  const coords = cells.map((c) => {
    const col = Number(c?.column), row = Number(c?.row);
    if (!Number.isInteger(col) || col < 0 || !Number.isInteger(row) || row < 0) {
      throw new Error(`batchAddCellListeners: 非法坐标 ${JSON.stringify(c)}（须 {column,row}，均非负整数）`);
    }
    return { column: col, row };
  });
  const seen = new Set();
  for (const { column, row } of coords) {
    const key = `${column},${row}`;
    if (seen.has(key)) throw new Error(`batchAddCellListeners: 坐标重复 ${key}`);
    seen.add(key);
  }

  const { raw } = load(path);
  let out = raw;
  const perCell = [];
  for (const { column, row } of coords) {
    let r;
    try {
      r = applyCellListenerIn(out, column, row, { event, js, className, sheet, addOnly: true });
    } catch (e) {
      // 只增：同 event 已有 Listener → 该格记 failed 并继续，不覆盖、不删除
      if (/只增不改/.test(e.message)) {
        perCell.push({ cell: `${column},${row}`, mode: 'failed', error: e.message });
        continue;
      }
      throw e;
    }
    out = r.out;
    perCell.push({ cell: `${column},${row}`, mode: r.mode });
  }
  save(path, out);
  return {
    action: 'add_cell_listener_batch',
    event,
    cellCount: coords.length,
    inserted: perCell.filter((c) => c.mode === 'insert').length,
    failed: perCell.filter((c) => c.mode === 'failed').length,
    results: perCell,
    hint: `已对 ${coords.length} 个单元格批量只增 event="${event}" 的控件事件 JS；同 event 已有 Listener 的格记 failed 不覆盖。模板内若需每格不同 JS 请逐格 add_cell_listener。`,
    bytes: Buffer.byteLength(out, 'utf8'),
  };
}

/**
 * M79 delete_cell_sort：只删单元格「扩展后排序」规则（Expand>cellSortAttr 与 O>cellSortAttr
 * 内的 cellSortExpression），控件/条件属性/监听 JS 原样保留——重建数据格会丢这些，本工具不动它们。
 *
 * 【逆向依据】sandbox6 防腐调整跟进报表1.cpt 实证（设计器原生写法）：
 *   <Expand dir="0"><cellSortAttr><sortExpressions>
 *     <cellSortExpression sortRule="0" sortArea="A4"/></sortExpressions>
 *   <sortHeader sortArea="A4">…</sortHeader></cellSortAttr></Expand>
 *   且同格 <O> 内带空占位 <cellSortAttr><sortExpressions/></cellSortAttr>；
 *   无规则格形态为 <Expand/>（O 内无 cellSortAttr）——删除即恢复该形态。
 * MCP 自写形态（lib/generate.js sortXml，中文 sortRule，位于 O 内 Parameters 之后）同理可删。
 *
 * 语义（保守）：
 * - Expand 内有 cellSortExpression → 删含表达式的 cellSortAttr 块；Expand 若只剩空白则
 *   塌为自闭合（开标签属性保留，如 dir/leftParent）；若还有其他子节点则只剔除排序块；
 * - O 内有 cellSortExpression → 删含表达式的块；
 * - O 内空占位（无表达式）→ 仅当同格删掉了 Expand 规则时一并清除（恢复从未配置态），
 *   独立存在的空占位（设计器默认，官方 76+21 例）不动，避免无意义 diff；
 * - 全格无表达式 → mode=none（不报错，批量跳过）。
 * 返回 removed[] 供核对：{location:'expand'|'content', sortArea, sortRule}。
 */
function removeCellSortIn(raw, column, row, { sheet } = {}) {
  const [cb, ce] = locateCell(raw, column, row, `单元格(${column},${row})`, sheet);
  let seg = raw.slice(cb, ce);
  const removed = [];
  const exprOf = (block) => [...block.matchAll(/<cellSortExpression\b[^>]*>/g)].map((m) => {
    const area = /sortArea="([^"]*)"/.exec(m[0])?.[1] ?? '';
    const rule = /sortRule="([^"]*)"/.exec(m[0])?.[1] ?? '';
    return { sortArea: area, sortRule: rule };
  });

  // ① Expand 层
  const exOpen = seg.match(/<Expand\b[^>]*>/);
  if (exOpen && !exOpen[0].trim().endsWith('/>')) {
    const exStart = exOpen.index;
    const exClose = seg.indexOf('</Expand>', exStart);
    if (exClose < 0) throw new Error(`deleteCellSort: 单元格(${column},${row}) 的 <Expand> 未闭合`);
    const inner = seg.slice(exStart + exOpen[0].length, exClose);
    // 删含表达式的 <cellSortAttr> 块（块内不嵌套同名标签，非贪婪安全）
    let cleaned = inner;
    for (const m of [...inner.matchAll(/<cellSortAttr>[\s\S]*?<\/cellSortAttr>/g)]) {
      const exprs = exprOf(m[0]);
      if (exprs.length > 0) {
        exprs.forEach((e) => removed.push({ location: 'expand', ...e }));
        cleaned = cleaned.replace(m[0], '');
      }
    }
    if (removed.some((r) => r.location === 'expand')) {
      if (cleaned.trim() === '') {
        // 只剩空白 → 塌为自闭合（保留 dir/leftParent 等属性）
        const openTag = exOpen[0].replace(/\s*>$/, '/>');
        seg = seg.slice(0, exStart) + openTag + seg.slice(exClose + '</Expand>'.length);
      } else {
        seg = seg.slice(0, exStart + exOpen[0].length) + cleaned + seg.slice(exClose);
      }
    }
  }

  // ② O 层（内容区）：删含表达式的块；空占位仅在同格删掉 Expand 规则时清除
  const oOpen = seg.match(/<O\b[^>]*>/);
  if (oOpen && !oOpen[0].trim().endsWith('/>')) {
    const oStart = oOpen.index;
    const oClose = seg.indexOf('</O>', oStart);
    if (oClose >= 0) {
      const oInner = seg.slice(oStart + oOpen[0].length, oClose);
      let oCleaned = oInner;
      let oTouched = false;
      for (const m of [...oInner.matchAll(/<cellSortAttr>[\s\S]*?<\/cellSortAttr>/g)]) {
        const exprs = exprOf(m[0]);
        if (exprs.length > 0) {
          exprs.forEach((e) => removed.push({ location: 'content', ...e }));
          oCleaned = oCleaned.replace(m[0], '');
          oTouched = true;
        } else if (removed.some((r) => r.location === 'expand')) {
          oCleaned = oCleaned.replace(m[0], '');
          oTouched = true;
        }
      }
      if (oTouched) seg = seg.slice(0, oStart + oOpen[0].length) + oCleaned + seg.slice(oClose);
    }
  }

  const out = raw.slice(0, cb) + seg + raw.slice(ce);
  return { out, mode: removed.length > 0 ? 'delete' : 'none', removed };
}

export function deleteCellSort(path, { column, row, cells, sheet } = {}) {
  const coords = cells != null ? cells : [{ column, row }];
  if (!Array.isArray(coords) || coords.length === 0) throw new Error('deleteCellSort: 必须提供 column+row 或 cells 数组（[{column,row},...]）');
  if (coords.length > 500) throw new Error(`deleteCellSort: cells 最多 500 格（当前 ${coords.length} 格）`);
  const norm = coords.map((c) => {
    const col = Number(c?.column), r = Number(c?.row);
    if (!Number.isInteger(col) || col < 0 || !Number.isInteger(r) || r < 0) {
      throw new Error(`deleteCellSort: 非法坐标 ${JSON.stringify(c)}（须 {column,row}，均非负整数）`);
    }
    return { column: col, row: r };
  });
  const seen = new Set();
  for (const { column: col, row: r } of norm) {
    const key = `${col},${r}`;
    if (seen.has(key)) throw new Error(`deleteCellSort: 坐标重复 ${key}`);
    seen.add(key);
  }
  const { raw } = load(path);
  let out = raw;
  const results = [];
  for (const { column: col, row: r } of norm) {
    let single;
    try {
      single = removeCellSortIn(out, col, r, { sheet });
    } catch (e) {
      if (/未找到/.test(e.message)) {
        results.push({ cell: `${col},${r}`, mode: 'none', note: '单元格不存在，跳过' });
        continue;
      }
      throw e;
    }
    out = single.out;
    results.push({ cell: `${col},${r}`, mode: single.mode, removed: single.removed });
  }
  save(path, out);
  return {
    action: 'delete_cell_sort',
    cellCount: norm.length,
    deleted: results.filter((c) => c.mode === 'delete').length,
    skipped: results.filter((c) => c.mode === 'none').length,
    results,
    hint: `已删 ${results.filter((c) => c.mode === 'delete').length} 格的扩展后排序（控件/条件属性/监听 JS 原样保留）。${results.filter((c) => c.mode === 'none').length ? '其余格本无排序规则，已跳过。' : ''}删前建议 git 落库。`,
    bytes: Buffer.byteLength(out, 'utf8'),
  };
}

// ---------------- P1 单独项补齐：改 / 删 / 查 语义工具 ----------------
//
// 语义约定（与「增」严格区分）：
//   update_* 只改「已存在」的目标（按 name / formula / index / 坐标定位），目标不存在即报错；
//   delete_* 只删「已存在」的目标，不存在即报错；
//   get_* 只读，不改文件。
// 全部基于文本锚点原位替换，不追加、不复制、不重建无关结构。

/** XML 属性/文本反转义（读取端口径，与 cpt.js 一致） */

// ============ 图表 get / update ============

const CHART_AGG_BY_CLASS = Object.fromEntries(Object.entries(CHART_AGGS).map(([k, v]) => [v, k]));
const CHART_TYPE_BY_PLOT = Object.fromEntries(Object.entries(CHART_TYPES).map(([k, v]) => [v.plotClass, k]));

/** 在 <Chart> 外层块内做 <Chart …>…</Chart> 平衡扫描（<Chart 不匹配 <ChartDefinition>/<ChartSummaryColumn>） */
function chartBlockRangeIn(raw, from) {
  let depth = 0, i = from;
  while (i < raw.length) {
    const open = raw.indexOf('<Chart ', i);
    const close = raw.indexOf('</Chart>', i);
    if (close < 0) throw new Error('定位失败：Chart 未闭合');
    if (open >= 0 && open < close) { depth += 1; i = open + '<Chart '.length; }
    else { depth -= 1; i = close + '</Chart>'.length; if (depth === 0) return [from, i]; }
  }
  throw new Error('定位失败：Chart 标签不平衡');
}

/** 定位指定坐标图表单元格内的 <Chart>…</Chart> 整块，返回 { cb, ce, chartStart, chartEnd }（绝对偏移） */
function locateChartBlock(raw, column, row, sheet) {
  const [cb, ce] = locateCell(raw, column, row, `图表(${column},${row})`, sheet);
  const seg = raw.slice(cb, ce);
  if (!seg.includes('<O t="CC">')) {
    throw new Error(`坐标(${column},${row}) 不是图表（无 <O t="CC">）；普通单元格请用 delete_cell`);
  }
  const chartOpen = seg.indexOf('<Chart ');
  if (chartOpen < 0) throw new Error(`定位失败：图表(${column},${row}) 内无 <Chart> 块`);
  const [cRelStart, cRelEnd] = chartBlockRangeIn(seg, chartOpen);
  return { cb, ce, chartStart: cb + cRelStart, chartEnd: cb + cRelEnd };
}

/** 从 <Chart> 整块 XML 解析当前配置（类型/标题/名称/数据集/分类/数值列/聚合） */
function parseChartBlock(chartXmlText) {
  const plot = (chartXmlText.match(/<Plot\s+class="([^"]+)"/) || [])[1] ?? null;
  const type = CHART_TYPE_BY_PLOT[plot] ?? null;
  const name = xmlUnescape((chartXmlText.match(/<Chart\s+name="([^"]*)"/) || [])[1] ?? null);
  const titleBlock = chartXmlText.match(/<Title4VanChart>[\s\S]*?<\/Title4VanChart>/);
  const title = titleBlock
    ? ((titleBlock[0].match(/<Title>[\s\S]*?<O>\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*<\/O>/) || [])[1] ?? null)
    : null;
  const dsName = (chartXmlText.match(/<TableData[\s\S]*?<Name>\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*<\/Name>/) || [])[1] ?? null;
  let category = null;
  let values = [];
  const one = chartXmlText.match(/<OneValueCDDefinition\s+([^>]*)\/?>/);
  if (one) {
    const a = one[1];
    const attr = (k) => xmlUnescape((a.match(new RegExp(`\\b${k}="([^"]*)"`)) || [])[1] ?? null);
    category = attr('seriesName');
    const valueName = attr('valueName');
    const aggClass = attr('function');
    values = valueName ? [{ name: valueName, agg: CHART_AGG_BY_CLASS[aggClass] ?? null, label: valueName }] : [];
  } else {
    const more = chartXmlText.match(/<MoreNameCDDefinition>[\s\S]*?<\/MoreNameCDDefinition>/);
    if (more) {
      category = xmlUnescape((more[0].match(/<CategoryName\s+value="([^"]*)"/) || [])[1] ?? null);
      values = [...more[0].matchAll(/<ChartSummaryColumn\s+name="([^"]*)"\s+function="([^"]*)"\s+customName="([^"]*)"/g)]
        .map((x) => ({ name: xmlUnescape(x[1]), agg: CHART_AGG_BY_CLASS[x[2]] ?? null, label: xmlUnescape(x[3]) }));
    }
  }
  return { type, name, title, dsName, category, values };
}

/** get_chart：只读，读取指定坐标图表单元格的当前配置 */
export function getChart(path, { column, row, sheet } = {}) {
  const c = Number(column), r = Number(row);
  if (!Number.isInteger(c) || c < 0 || !Number.isInteger(r) || r < 0) {
    throw new Error(`图表单元格坐标非法：(${column},${row})`);
  }
  const { raw } = load(path);
  const occ = sheet == null ? 0 : locateSheet(raw, sheet).index;
  const loc = locateChartBlock(raw, c, r, sheet);
  const head = raw.slice(loc.cb, raw.indexOf('>', loc.cb) + 1);
  const span = (k) => (head.match(new RegExp(`\\b${k}="([^"]*)"`)) || [])[1] ?? null;
  const info = parseChartBlock(raw.slice(loc.chartStart, loc.chartEnd));
  return {
    cell: `${c},${r}`,
    sheet: occ,
    colspan: span('cs') != null ? Number(span('cs')) : null,
    rowspan: span('rs') != null ? Number(span('rs')) : null,
    ...info,
  };
}

/**
 * update_chart：改【已存在】图表单元格的配置（标题/数据集/分类字段/数值列/图表类型）。
 * 原位重算 <Chart> 块，保留单元格坐标与 cs/rs 合并跨度；未传字段沿用现状。
 */
export function updateChart(path, { column, row, sheet, type, title, dsName, category, values } = {}) {
  const c = Number(column), r = Number(row);
  if (!Number.isInteger(c) || c < 0 || !Number.isInteger(r) || r < 0) {
    throw new Error(`图表单元格坐标非法：(${column},${row})`);
  }
  const { raw, parsed } = load(path);
  const loc = locateChartBlock(raw, c, r, sheet);
  const current = parseChartBlock(raw.slice(loc.chartStart, loc.chartEnd));
  if (type != null && !CHART_TYPES[type]) {
    throw new Error(`update_chart: 图表类型 "${type}" 不支持，可用：${Object.keys(CHART_TYPES).join(' / ')}`);
  }
  const nextType = type ?? current.type;
  const nextTitle = title !== undefined && title !== null ? String(title) : (current.title ?? '');
  const nextDs = dsName != null && String(dsName).trim() !== '' ? String(dsName).trim() : current.dsName;
  const nextCategory = category != null && String(category).trim() !== '' ? String(category).trim() : current.category;
  let nextValues = values != null ? values : current.values;
  if (nextValues == null || nextValues.length === 0) {
    throw new Error('update_chart: 目标图表无可用数值列（values），请显式传入 values（如 [{name:"amount", agg:"sum"}]）');
  }
  nextValues = nextValues.map((v) => (typeof v === 'string' ? { name: v, agg: 'sum' } : v));
  if (dsName != null && String(dsName).trim() !== '' && String(dsName).trim() !== current.dsName) {
    assertDatasetExists(parsed, String(dsName).trim(), '图表数据集');
  }
  const newChart = chartXml({ type: nextType, title: nextTitle, dsName: nextDs, category: nextCategory, values: nextValues });
  const out = raw.slice(0, loc.chartStart) + newChart + raw.slice(loc.chartEnd);
  save(path, out);
  return {
    action: 'update_chart',
    cell: `${c},${r}`,
    sheet: sheet ?? 0,
    type: nextType,
    chartType: CHART_TYPES[nextType]?.label ?? nextType,
    dsName: nextDs,
    category: nextCategory,
    values: nextValues.map((v) => ({ name: v.name, agg: normalizeAgg(v.agg) })),
    bytes: Buffer.byteLength(out, 'utf8'),
  };
}

// ============ 单元格超链接 update ============

/** 解析 <NameJavaScript name="...">…</NameJavaScript> 块 → 结构化字段 + 原样 <Parameters> 段 */
function parseHyperlinkBlock(block) {
  const name = xmlUnescape((block.match(/<NameJavaScript name="([^"]*)"/) || [])[1] ?? null);
  const cls = (block.match(/<JavaScript class="([^"]*)"/) || [])[1] ?? null;
  let type = null;
  if (cls && cls.includes('ReportletHyperlink')) type = 'reportlet';
  else if (cls && cls.includes('WebHyperlink')) type = 'url';
  else if (cls && cls.includes('JavaScriptImpl')) type = 'script';
  const cd = (tag) => readTagText(block, tag);
  const url = cd('URL');
  const script = cd('Content');
  const reportletPath = cd('ReportletName') ?? cd('ReportletPath');
  const target = cd('TargetFrame');
  const fw = (block.match(/<Features\s+width="([^"]*)"\s+height="([^"]*)"/) || []);
  const width = fw[1] != null ? Number(fw[1]) : null;
  const height = fw[2] != null ? Number(fw[2]) : null;
  const post = /byPost="true"/.test(block);
  const paramsXml = (block.match(/<Parameters\/>|<Parameters>[\s\S]*?<\/Parameters>/) || ['<Parameters/>'])[0];
  return { name, cls, type, url, script, reportletPath, target, width, height, post, paramsXml };
}

/**
 * update_cell_hyperlink：改单元格内【已存在】的超级链接（按 name 定位）。
 * 未传字段沿用现有值；newName 改名；type 变更会重建该块（保留 name）。
 */
export function updateCellHyperlink(path, column, row, {
  name, newName, type, reportletPath, url, script, params,
  target, width, height, post, sheet,
} = {}) {
  if (column == null || row == null) throw new Error('updateCellHyperlink: 必须提供 column 与 row（均从 0 起）');
  if (!name || !String(name).trim()) throw new Error('updateCellHyperlink: 必须提供 name（要改的超链接事件名，与 add_cell_hyperlink 的 name 一致）');
  const { raw } = load(path);
  const [cb, ce] = locateCell(raw, column, row, `单元格(${column},${row})`, sheet);
  const seg = raw.slice(cb, ce);
  const targetLoc = locateNameJavaScript(seg, name);
  if (!targetLoc) throw new Error(`updateCellHyperlink: 单元格(${column},${row}) 内未找到超链接 name="${name}"`);
  const cur = parseHyperlinkBlock(seg.slice(targetLoc[0], targetLoc[1]));
  const nextType = type ?? cur.type;
  if (!nextType) throw new Error(`updateCellHyperlink: 超链接 name="${name}" 类型无法识别，请显式传 type`);
  // 保留原 className：未改 type 时沿用现状 class；显式改 type 才切换为新类型标准 class
  const nextClassName = (type != null && type !== cur.type)
    ? JS_CLASSES[nextType]
    : (cur.cls ?? JS_CLASSES[nextType]);
  const next = {
    type: nextType,
    className: nextClassName,
    reportletPath: reportletPath ?? cur.reportletPath,
    url: url ?? cur.url,
    script: script ?? cur.script,
    params: params ?? undefined,
    paramsXml: params != null ? undefined : cur.paramsXml, // 未传 params → 原样保留现有 <Parameters> 段
    target: target ?? cur.target ?? '_blank',
    width: width ?? cur.width ?? 600,
    height: height ?? cur.height ?? 400,
    post: post ?? cur.post ?? false,
    name: newName ?? name,
  };
  const newBlock = buildHyperlinkNameJavaScript(next);
  const out = raw.slice(0, cb + targetLoc[0]) + newBlock + raw.slice(cb + targetLoc[1]);
  save(path, out);
  return {
    action: 'update_cell_hyperlink',
    cell: `${column},${row}`,
    name: next.name,
    type: next.type,
    target: next.type === 'script' ? undefined : next.target,
    bytes: Buffer.byteLength(out, 'utf8'),
  };
}

// ============ 单元格条件属性 update ============

/** 渲染单个 <Highlight class="...">…</Highlight> 块（condXml 为完整 <Condition>…</Condition> 块） */
function renderHighlightBlock({ name, condXml, actionKind, actionValue, scope }) {
  return `<Highlight class="${HL_CLASS}">
<Name>
<![CDATA[${assertSafeCdata(name, '条件属性名')}]]>
</Name>
${condXml}
<HighlightAction class="${HL_ACTIONS[actionKind]}">
${highlightActionBody(actionKind, actionValue, scope)}
</HighlightAction>
</Highlight>`;
}

/**
 * update_cell_highlight：改单元格内【已存在】的一条条件属性（按 name / index / formula 定位，三选一）。
 * 一次改一条：换条件（newFormula/compare/conditions）或换效果（background/fontColor/value/bold+fontSizePt+fontName，选一）。
 * 原条件块 / 原作用范围（scope）未传时沿用现状，做原位块替换，不追加。
 */
export function updateCellHighlight(path, {
  column, row, sheet, name, index, formula,
  newFormula, compare, conditions, logic,
  background, fontColor, value, bold, fontSizePt, fontName, scope,
} = {}) {
  if (column == null || row == null) throw new Error('updateCellHighlight: 必须提供 column 与 row（均从 0 起）');
  const ids = [name != null, index != null, formula != null].filter(Boolean).length;
  if (ids === 0) throw new Error('updateCellHighlight: 必须提供 name / index / formula 之一定位目标条件');
  if (ids > 1) throw new Error('updateCellHighlight: name / index / formula 三选一，不要混用');
  if (scope != null && scope !== 'cell' && scope !== 'row') {
    throw new Error(`updateCellHighlight: scope="${scope}" 非法，只能用 cell（默认）或 row`);
  }
  if (bold != null && typeof bold !== 'boolean') {
    throw new Error(`updateCellHighlight: bold 只接受 true / false，收到 ${JSON.stringify(bold)}`);
  }
  const { raw } = load(path);
  const [cb, ce] = locateCell(raw, column, row, `单元格(${column},${row})`, sheet);
  const seg = raw.slice(cb, ce);
  const hlOpen = seg.indexOf('<HighlightList>');
  const hlClose = seg.lastIndexOf('</HighlightList>');
  if (hlOpen < 0) throw new Error(`updateCellHighlight: 单元格(${column},${row}) 无条件属性`);
  const inner = seg.slice(hlOpen + '<HighlightList>'.length, hlClose);
  const all = [];
  const hlRe = /<Highlight\s+class="([^"]*)">([\s\S]*?)<\/Highlight>/g;
  let m;
  while ((m = hlRe.exec(inner)) !== null) {
    all.push({ start: m.index, end: m.index + m[0].length, body: m[2], block: m[0] });
  }
  const nameOf = (b) => (b.match(/<Name>[\s\S]*?<!\[CDATA\[([\s\S]*?)\]\]>/) || [])[1]?.trim() ?? null;
  const formulaOf = (b) => (b.match(/<Formula>[\s\S]*?<!\[CDATA\[([\s\S]*?)\]\]>/) || [])[1]?.trim() ?? null;
  let matched = null;
  if (index != null) {
    if (!Number.isInteger(Number(index)) || Number(index) < 0 || Number(index) >= all.length) {
      throw new Error(`updateCellHighlight: index=${index} 越界（该单元格共 ${all.length} 条条件属性）`);
    }
    matched = all[Number(index)];
  } else if (name != null) {
    const hits = all.filter((h) => nameOf(h.body) === String(name).trim());
    if (hits.length === 0) throw new Error(`updateCellHighlight: 找不到 name="${name}" 的条件属性`);
    if (hits.length > 1) throw new Error(`updateCellHighlight: name="${name}" 命中 ${hits.length} 条，请用 index 精确定位`);
    matched = hits[0];
  } else {
    const hits = all.filter((h) => formulaOf(h.body) === String(formula).trim());
    if (hits.length === 0) throw new Error(`updateCellHighlight: 找不到 formula="${formula}" 的条件属性`);
    if (hits.length > 1) throw new Error(`updateCellHighlight: formula="${formula}" 命中 ${hits.length} 条（同一条件多效果），请用 name 或 index 精确定位`);
    matched = hits[0];
  }

  // 新条件（未传任何条件 → 沿用原 <Condition> 块原文）
  const hasNewCond = newFormula != null || compare != null || conditions != null;
  let condXml;
  if (hasNewCond) {
    condXml = buildConditionXml({ formula: newFormula, compare, conditions, logic }).xml;
  } else {
    const orig = (matched.body.match(/<Condition\s+[^>]*>[\s\S]*?<\/Condition>/) || [])[0];
    if (!orig) throw new Error('updateCellHighlight: 目标条件属性内无 <Condition> 块（非标准形态）');
    condXml = orig;
  }

  // 新效果（单条）
  const acts = [];
  if (background != null) acts.push({ kind: 'background', value: background });
  if (fontColor != null) acts.push({ kind: 'fontColor', value: fontColor });
  if (value != null) acts.push({ kind: 'value', value });
  if (bold != null || fontSizePt != null || fontName != null) {
    acts.push({ kind: 'font', value: { style: bold ? 1 : 0, sizePt: fontSizePt ?? 11, name: fontName ?? '微软雅黑' } });
  }
  if (acts.length === 0 && !hasNewCond) throw new Error('updateCellHighlight: 至少给一个效果（background/fontColor/value/bold/fontSizePt/fontName）或新条件（newFormula/compare/conditions）');
  if (acts.length > 1) throw new Error('updateCellHighlight: 一次只改一个效果；要加多个效果请用 add_cell_highlight');

  const origName = nameOf(matched.body) ?? `条件属性${(index ?? 0) + 1}`;
  const origScope = /<Scope\s+val="1"/.test(matched.body) ? 'row' : 'cell';
  let newBlock;
  if (acts.length === 1) {
    newBlock = renderHighlightBlock({
      name: origName, condXml, actionKind: acts[0].kind, actionValue: acts[0].value,
      scope: scope ?? origScope,
    });
  } else {
    // 只改条件（无效果参数）：保留原 <HighlightAction> 块原文
    const origAction = (matched.body.match(/<HighlightAction\s+[^>]*>[\s\S]*?<\/HighlightAction>/) || [])[0];
    if (!origAction) throw new Error('updateCellHighlight: 目标条件属性内无 <HighlightAction> 块（非标准形态）');
    newBlock = `<Highlight class="${HL_CLASS}">
<Name>
<![CDATA[${assertSafeCdata(origName, '条件属性名')}]]>
</Name>
${condXml}
${origAction}
</Highlight>`;
  }
  const newInner = inner.slice(0, matched.start) + newBlock + inner.slice(matched.end);
  const newSeg = seg.slice(0, hlOpen + '<HighlightList>'.length) + newInner + seg.slice(hlClose);
  const out = raw.slice(0, cb) + newSeg + raw.slice(ce);
  save(path, out);
  return {
    action: 'update_cell_highlight',
    cell: `${column},${row}`,
    locatedBy: index != null ? 'index' : (name != null ? 'name' : 'formula'),
    conditionChanged: hasNewCond,
    effect: acts[0]?.kind ?? null,
    scope: scope ?? origScope,
    bytes: Buffer.byteLength(out, 'utf8'),
  };
}

// ============ 单元格监听器（Listener）get / update / delete ============

/** 统一块级扫描：单元格片段内全部 <Listener event="…">…</Listener> 块（容忍属性顺序/内层结构差异） */
function findCellListeners(seg) {
  const re = /<Listener\b[^>]*?\bevent="([^"]*)"[^>]*>[\s\S]*?<\/Listener>/g;
  const out = [];
  let m;
  while ((m = re.exec(seg)) !== null) out.push({ index: m.index, event: m[1], block: m[0] });
  return out;
}

/** 判定 Listener 块是否为「内嵌提交」宿主（Commit2DBJavaScript 或块内带 DMLConfig） */
function isEmbeddedCommitBlock(block) {
  return String(block).includes(COMMIT2DB_CLASS) || /<DMLConfig\b/.test(String(block));
}

/**
 * F1 自卫（2026-10-23 实测加固）：内嵌提交宿主块**禁止**整块替换/删除。
 * 实测：AF2 的 click Listener 内嵌 2 套 DMLConfig，update_cell_listener 整块替换后
 * DMLConfig 4→2、validate 仍只报 info —— 静默丢失提交配置。默认拒绝，需显式 force=true。
 */
function assertNotEmbeddedCommit(block, what, force) {
  if (!isEmbeddedCommitBlock(block) || force === true) return;
  const n = (String(block).match(/<DMLConfig\b/g) || []).length;
  throw new Error(`${what}: 目标是内嵌提交宿主（Commit2DBJavaScript，内含 ${n} 套 DMLConfig 提交配置）。`
    + '整块替换/删除会静默丢失这些提交（实测会从 4 套变成 2 套，且 validate 不报错），已拒绝写入，文件未动。'
    + '纠正：改字段列映射用 update_embedded_submit（patch=改单字段列号，replace=整列清单）；查看用 get_embedded_submits。'
    + '确实要整块覆盖（会丢提交配置）请显式传 force=true。');
}

/** 从 Listener 块内宽松提取 className（缺省回退 null）与 JS 正文（CDATA 或裸文本） */
function readListenerJs(block) {
  const className = (block.match(/<JavaScript\s+class="([^"]*)"/) || [])[1] ?? null;
  const jsMatch = block.match(/<Content\b[^>]*>([\s\S]*?)<\/Content>/);
  let js = null;
  if (jsMatch) {
    const cdata = jsMatch[1].match(/<!\[CDATA\[([\s\S]*?)\]\]>/);
    js = cdata ? cdata[1] : (jsMatch[1].trim() || null);
  }
  return { className, js };
}

/** 定位单元格内指定 event 的 <Listener> 块（match 可选精确命中），返回 { index, event, block } 或 null */
function locateCellListener(seg, event, match) {  const wanted = escapeXmlAttr(String(event));
  let li = 0;
  for (const b of findCellListeners(seg)) {
    if (b.event !== wanted) continue;
    if (match) {
      if (b.block.includes(String(match))) return b;
    } else if (li === 0) {
      return b;
    }
    li++;
  }
  return null;
}

/** get_cell_listener：只读，列出单元格内全部（或指定 event 的）控件事件 Listener */
export function getCellListener(path, column, row, { event, sheet, jsOffset, jsLimit } = {}) {
  if (column == null || row == null) throw new Error('getCellListener: 必须提供 column 与 row（均从 0 起）');
  const { raw } = load(path);
  const [cb, ce] = locateCell(raw, column, row, `单元格(${column},${row})`, sheet);
  const seg = raw.slice(cb, ce);
  const listeners = [];
  // C-B：按全文统计设计器转义 `]A`（分页切片不参与计数），读回原文保持不变
  const fullCodes = [];
  for (const b of findCellListeners(seg)) {
    if (event && b.event !== String(event)) continue;
    const { className, js } = readListenerJs(b.block);
    if (typeof js === 'string') fullCodes.push(js);
    const isEmbedded = isEmbeddedCommitBlock(b.block);
    const entry = {
      event: b.event,
      className,
      js: typeof js === 'string' ? sliceJs(js, jsOffset, jsLimit, 'get_cell_listener') : js,
      jsLength: typeof js === 'string' ? js.length : 0,
      sha256: jsSha256(js ?? ''),
    };
    if (isEmbedded) {
      // 读侧纠偏：Commit2DBJavaScript 的 <Content> 只是「提交后回调」，不是可改的页面 JS；
      // 提交配置在 <Attributes>+<DMLConfig> 里，update_cell_listener 碰它会丢配置。
      entry.commit2db = true;
      entry.embeddedSubmitCount = (b.block.match(/<DMLConfig\b/g) || []).length;
      entry.jsRole = 'postSubmitCallback';
      entry.note = '该 Listener 是内嵌提交（Commit2DBJavaScript）：js 字段只是提交后的回调 JS，'
        + `真正的提交配置在 ${entry.embeddedSubmitCount} 套 DMLConfig 里（不属于本工具的 js）。`
        + '读写提交配置请用 get_embedded_submits / update_embedded_submit；update_cell_listener 会拒绝整块替换。';
    }
    listeners.push(entry);
  }
  // C-B：读回原文不变；仅在含设计器转义 `]A` 时附元数据（2026-11-03 用户第 3 次纠正的模型可见面）
  const designerEscapes = aggregateDesignerEscapes(fullCodes);
  return {
    cell: `${column},${row}`, sheet: sheet ?? 0, listeners, count: listeners.length,
    ...(designerEscapes ? { designerEscapes } : {}),
  };
}

/**
 * update_cell_listener：改单元格内【已存在】的 Listener 事件 JS（按 event + 可选 match 定位）。
 * 片段替换（2026-11-03 事故后补，与 set_webwrite_js 同口径）：大段单元格事件 JS 只改其中一段时传
 *   patchFind + patchReplace（设计器转义 `]A` 感知、默认唯一命中、patchAll=true 允许多处），与 js 互斥；
 *   只改 <Content><![CDATA[...]]></Content> 内文，Listener 块其余原文（Parameters/className/换行）原样保留。
 * 缩水护栏：整块写入若会让旧 Content（≥4KB）缩到 <60% 且少 ≥2KB → 拒绝（确要传 allowShrink:true）。
 * expectedSha256：patch/整块替换前核对目标 Listener 的 sha（不传则老行为不变）。
 */
export function updateCellListener(path, column, row, {
  event, js, match, className, sheet, expectedSha256, force,
  patchFind, patchReplace, patchAll, allowShrink,
} = {}) {
  if (column == null || row == null) throw new Error('updateCellListener: 必须提供 column 与 row（均从 0 起）');
  if (!event || !String(event).trim()) throw new Error('updateCellListener: 必须提供 event（如 click/afterinit/afteredit/stopedit）');
  const patchMode = patchFind !== undefined && patchFind !== null && String(patchFind) !== '';
  assertPatchArgs({ action: 'updateCellListener', patchMode, patchFind, patchReplace });
  if (patchMode) {
    if (js != null) throw new Error('updateCellListener: patchFind/patchReplace 是「片段替换」，不能同时传 js（整块替换）—— 只改一段请只传 patchFind(+patchReplace)；整块替换请只传 js（大块需 allowShrink:true）。');
  } else if (js == null || String(js).trim() === '') {
    throw new Error('updateCellListener: js 不能为空（改监听器必须提供新 JS；删除请用 delete_cell_listener）');
  }
  const { raw } = load(path);
  const [cb, ce] = locateCell(raw, column, row, `单元格(${column},${row})`, sheet);
  const seg = raw.slice(cb, ce);
  const loc = locateCellListener(seg, event, match);
  if (!loc) {
    throw new Error(`updateCellListener: 单元格(${column},${row}) 内未找到 event="${event}"${match ? ` 且含 "${match}"` : ''} 的 Listener${patchMode ? '（patchFind/patchReplace 只改已存在块；要新建请用 add_cell_listener）' : ''}`);
  }
  assertNotEmbeddedCommit(loc.block, `updateCellListener: 单元格(${column},${row}) 的 event="${event}" Listener`, force);
  // F1 自卫：替换前核对当前块 sha（不符抛错且不写文件；不传 expectedSha256 则老行为不变）
  assertExpectedSha256(loc.block, expectedSha256, `updateCellListener: 单元格(${column},${row})`);
  const absStart = cb + loc.index;
  const bytesOf = (s) => Buffer.byteLength(s, 'utf8');
  const content = listenerContentSpan(loc.block);

  // 片段替换：只改目标 Listener 的 Content CDATA 内文
  if (patchMode) {
    if (!content) {
      throw new Error(`updateCellListener: 单元格(${column},${row}) 的 event="${event}" Listener 缺少 <Content><![CDATA[...]]></Content> 结构，无法片段替换（文件未改动；请先 get_cell_listener 读回确认结构）。`);
    }
    const patched = patchJsFragment({
      action: 'updateCellListener', target: `单元格(${column},${row}) 的 Listener(event="${event}") Content`, js: content.js, patchFind, patchReplace, patchAll,
    });
    const nextJs = assertSafeCdata(patched.js, '单元格 JS');
    const out = raw.slice(0, absStart + content.cdStart) + nextJs + raw.slice(absStart + content.cdEnd);
    save(path, out);
    const nextClassNamePatched = (loc.block.match(/<JavaScript\s+class="([^"]*)"/) || [])[1] ?? null;
    return {
      action: 'update_cell_listener', cell: `${column},${row}`, event, mode: 'patch', patchHits: patched.hits,
      ...patchMatchNote(patched.matchedBy),
      className: nextClassNamePatched,
      jsBytesBefore: content.bytes, jsBytesAfter: bytesOf(nextJs),
      jsLinesBefore: content.lines, jsLinesAfter: nextJs.split('\n').length,
      bytes: bytesOf(out),
      hint: `已片段替换 ${patched.hits} 处（只改单元格事件 JS 的命中片段，其余原文未动）。修改后建议重跑 check_report_js/validate_cpt。`,
    };
  }

  // 保留原 className：未显式传 className 时沿用原 Listener 的 class，不强制重置为默认
  const nextClassName = (className != null && String(className).trim() !== '')
    ? className
    : ((loc.block.match(/<JavaScript\s+class="([^"]*)"/) || [])[1] ?? 'com.fr.js.JavaScriptImpl');
  // 缩水护栏：整块写入若会把共享大段换成小段 → 拒绝（只改一段请走 patchFind/patchReplace）
  const shrinkBefore = guardJsShrink({
    action: 'updateCellListener',
    target: `单元格(${column},${row}) 的 Listener(event="${event}") Content`,
    beforeMetrics: content,
    afterJs: js,
    allowShrink,
    fixHint: '单元格事件 JS 常是多段逻辑共用的一段代码，整块替换极易静默丢功能。安全做法：①只改其中片段 → 传 patchFind + patchReplace（块内其余原文原样保留）；②确实要整块替换 → 传 allowShrink:true（写前用 get_cell_listener 核对 jsBytes/jsLines）。',
  });
  const safeJs = assertSafeCdata(String(js), '单元格 JS');
  const node = `<Listener event="${escapeXmlAttr(String(event))}">
<JavaScript class="${escapeXmlAttr(nextClassName)}">
<Parameters/>
<Content>
<![CDATA[${safeJs}]]></Content>
</JavaScript>
</Listener>`;
  const out = raw.slice(0, absStart) + node + raw.slice(absStart + loc.block.length);
  save(path, out);
  const after = jsMetricsOf(safeJs);
  return {
    action: 'update_cell_listener', cell: `${column},${row}`, event, mode: 'replace', className: nextClassName,
    jsBytesBefore: content?.bytes ?? 0, jsLinesBefore: content?.lines ?? 0,
    jsBytesAfter: after.bytes, jsLinesAfter: after.lines,
    bytes: bytesOf(out),
    ...(shrinkBefore && shrinkBefore.bytes >= LISTENER_SHRINK_MIN_OLD_BYTES
      ? { hint: `已整块替换 ${shrinkBefore.bytes}B/${shrinkBefore.lines}行 的单元格 Listener（新 ${after.bytes}B/${after.lines}行）。若只想改其中一段，优先用 patchFind/patchReplace 片段替换，可保留其余原文。` }
      : {}),
  };
}

/** delete_cell_listener：删单元格内【已存在】的 Listener 事件 JS（按 event + 可选 match 定位） */
export function deleteCellListener(path, column, row, { event, match, sheet, force } = {}) {
  if (column == null || row == null) throw new Error('deleteCellListener: 必须提供 column 与 row（均从 0 起）');
  if (!event || !String(event).trim()) throw new Error('deleteCellListener: 必须提供 event（如 click/afterinit/afteredit/stopedit）');
  const { raw } = load(path);
  const [cb, ce] = locateCell(raw, column, row, `单元格(${column},${row})`, sheet);
  const seg = raw.slice(cb, ce);
  const loc = locateCellListener(seg, event, match);
  if (!loc) throw new Error(`deleteCellListener: 单元格(${column},${row}) 内未找到 event="${event}"${match ? ` 且含 "${match}"` : ''} 的 Listener`);
  assertNotEmbeddedCommit(loc.block, `deleteCellListener: 单元格(${column},${row}) 的 event="${event}" Listener`, force);
  let absEnd = cb + loc.index + loc.block.length;
  while (absEnd < raw.length && (raw[absEnd] === '\n' || raw[absEnd] === '\r')) absEnd++;
  const out = raw.slice(0, cb + loc.index) + raw.slice(absEnd);
  save(path, out);
  return { action: 'delete_cell_listener', cell: `${column},${row}`, event, mode: 'delete', bytes: Buffer.byteLength(out, 'utf8') };
}

// ============ 单元格扩展后排序 get / update ============

/** sortRule 归一化：0/升序/1 → asc；2/降序 → desc；空/0/不排序 → none；未知原样回显 */
function normalizeSortDirection(rule) {
  const r = String(rule ?? '').trim();
  if (r === '' || r === '0' || r === '不排序' || r === 'none' || r.toLowerCase() === 'no_sort') return 'none';
  if (r === '1' || r === '升序' || r.toLowerCase() === 'asc') return 'asc';
  if (r === '2' || r === '降序' || r.toLowerCase() === 'desc') return 'desc';
  return r;
}

/** get_cell_sort：只读，列出单元格内全部扩展后排序规则（同时扫描 <Expand> 与 <O> 两处官方形态） */
export function getCellSort(path, { column, row, sheet } = {}) {
  if (column == null || row == null) throw new Error('getCellSort: 必须提供 column 与 row（均从 0 起）');
  const { raw } = load(path);
  const [cb, ce] = locateCell(raw, column, row, `单元格(${column},${row})`, sheet);
  const seg = raw.slice(cb, ce);
  const sorts = [];
  for (const m of seg.matchAll(/<cellSortExpression\s+([^>]*)\/?>/g)) {
    const area = xmlUnescape((m[1].match(/\bsortArea="([^"]*)"/) || [])[1] ?? '');
    const rule = (m[1].match(/\bsortRule="([^"]*)"/) || [])[1] ?? '';
    sorts.push({ sortArea: area, sortRule: rule, direction: normalizeSortDirection(rule) });
  }
  return { cell: `${column},${row}`, sheet: sheet ?? 0, sorts, hasSort: sorts.length > 0 };
}

/**
 * update_cell_sort：设置/替换单元格「扩展后排序」规则（sort 为空数组=删除）。
 * 写位置对齐官方/MCP 两种形态：优先 <O> 内 <Parameters/> 之后（DSColumn 官方位置），
 * 其次 <Expand> 内（设计器原生形态），再次展开自闭合 <Expand/>。
 */
export function updateCellSort(path, { column, row, sort, sheet } = {}) {
  if (column == null || row == null) throw new Error('updateCellSort: 必须提供 column 与 row（均从 0 起）');
  if (sort == null) throw new Error('updateCellSort: 必须提供 sort（排序规则数组 [{area, direction}]；空数组=删除）');
  if (!Array.isArray(sort)) throw new Error('updateCellSort: sort 必须是数组，例：[{ area: "销售额", direction: "desc" }]');
  const { raw } = load(path);
  if (sort.length === 0) {
    const r = removeCellSortIn(raw, column, row, { sheet });
    save(path, r.out);
    return { action: 'update_cell_sort', cell: `${column},${row}`, mode: r.mode, removed: r.removed, bytes: Buffer.byteLength(r.out, 'utf8') };
  }
  if (sort.length > 8) throw new Error(`updateCellSort: sort 最多 8 条排序键（当前 ${sort.length} 条）`);
  const DIR = { asc: '升序', desc: '降序' };
  const exprs = sort.map((s, i) => {
    if (!s || typeof s !== 'object') throw new Error(`updateCellSort: sort[${i}] 必须是 { area, direction } 对象`);
    const area = String(s.area ?? '').trim();
    const dir = String(s.direction ?? '').trim();
    if (!area) throw new Error(`updateCellSort: sort[${i}].area（按哪一列排序）不能为空`);
    if (!DIR[dir]) throw new Error(`updateCellSort: sort[${i}].direction 只能是 asc（升序）或 desc（降序），当前 "${dir}"`);
    return `<cellSortExpression sortRule="${DIR[dir]}" sortArea="${escapeXmlAttr(area)}"/>`;
  });
  const block = `<cellSortAttr>
<sortExpressions>
${exprs.join('\n')}
</sortExpressions>
</cellSortAttr>`;

  // 先清除现有排序（Expand 与 O 两处），再原位写入新规则
  let out = removeCellSortIn(raw, column, row, { sheet }).out;
  const [cb2, ce2] = locateCell(out, column, row, `单元格(${column},${row})`, sheet);
  const seg = out.slice(cb2, ce2);

  // 找插入点
  let insertAt = null, patch = null;
  const oOpen = seg.match(/<O\b[^>]*>/);
  if (oOpen && !oOpen[0].trim().endsWith('/>')) {
    const oStart = oOpen.index;
    const oClose = seg.indexOf('</O>', oStart);
    if (oClose >= 0) {
      const oInner = seg.slice(oStart, oClose);
      const pm = oInner.match(/<Parameters\/>|<Parameters\b[^>]*>[\s\S]*?<\/Parameters>/);
      insertAt = pm ? oStart + pm.index + pm[0].length : oClose;
    }
  }
  if (insertAt == null) {
    const exOpen = seg.match(/<Expand\b[^>]*>/);
    if (exOpen) {
      if (exOpen[0].trim().endsWith('/>')) {
        // 自闭合 <Expand/> → 展开为开闭对，把排序块放进去
        const openTag = exOpen[0].replace(/\/>\s*$/, '>');
        patch = { at: exOpen.index, len: exOpen[0].length, text: `${openTag}\n${block}\n</Expand>` };
      } else {
        const exClose = seg.indexOf('</Expand>', exOpen.index);
        if (exClose >= 0) insertAt = exClose;
      }
    }
  }
  if (insertAt == null && patch == null) {
    throw new Error(`updateCellSort: 单元格(${column},${row}) 无 <O> 或 <Expand> 可承载排序规则（排序仅对扩展格/DSColumn 格有意义）`);
  }
  let newSeg;
  if (patch) {
    newSeg = seg.slice(0, patch.at) + patch.text + seg.slice(patch.at + patch.len);
  } else {
    newSeg = seg.slice(0, insertAt) + block + '\n' + seg.slice(insertAt);
  }
  out = out.slice(0, cb2) + newSeg + out.slice(ce2);
  save(path, out);
  return {
    action: 'update_cell_sort',
    cell: `${column},${row}`,
    sort: sort.map((s) => ({ sortArea: s.area, direction: s.direction })),
    bytes: Buffer.byteLength(out, 'utf8'),
  };
}

// ============ 浮动元素 get / update ============

// 单位换算统一从 lib/engine/rules.js 取用（2026-10-29 去重：原先此处硬编码 MM_UNIT=144000，
// 与 rules.MM_TO_UNIT、generate.js 的导出各存一份）。

/** 定位指定名称的浮动元素块（按 sheet 隔离），返回 { start, end, seg } 或 null */
function locateFloatElement(raw, name, sheet) {
  const blocks = sheetBlocks(raw);
  const occ = sheet == null ? 0 : locateSheet(raw, sheet).index;
  const lo = blocks[occ]?.start ?? 0, hi = blocks[occ]?.end ?? raw.length;
  const safeName = escapeXmlAttr(name);
  const feStarts = findAll(raw, '<com.fr.report.cell.FloatElement').filter((s) => s >= lo && s < hi);
  for (const s of feStarts) {
    const [b, e] = blockRange(raw, s, '<com.fr.report.cell.FloatElement', '</com.fr.report.cell.FloatElement>');
    const seg = raw.slice(b, e);
    if (seg.includes(`<FloatElementName name="${safeName}"`)) return { start: b, end: e, seg };
  }
  return null;
}

/** get_float_element：只读，列出指定工作表的浮动文本元素（可传 name 过滤单个） */
export function getFloatElement(path, { name, sheet } = {}) {
  const { raw } = load(path);
  const blocks = sheetBlocks(raw);
  const occ = sheet == null ? 0 : locateSheet(raw, sheet).index;
  const lo = blocks[occ]?.start ?? 0, hi = blocks[occ]?.end ?? raw.length;
  const feStarts = findAll(raw, '<com.fr.report.cell.FloatElement').filter((s) => s >= lo && s < hi);
  const floats = [];
  for (const s of feStarts) {
    const [b, e] = blockRange(raw, s, '<com.fr.report.cell.FloatElement', '</com.fr.report.cell.FloatElement>');
    const seg = raw.slice(b, e);
    const n = xmlUnescape((seg.match(/<FloatElementName name="([^"]*)"/) || [])[1] ?? null);
    if (name && n !== String(name)) continue;
    const content = (seg.match(/<O>\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*<\/O>/) || [])[1] ?? null;
    const style = (seg.match(/<Style\s+index="(\d+)"/) || [])[1] ?? null;
    const loc = (seg.match(/<Location\s+([^>]*)\/?>/) || [])[1] ?? '';
    const num = (k) => { const v = (loc.match(new RegExp(`\\b${k}="([^"]*)"`)) || [])[1]; return v != null ? Number(v) : null; };
    floats.push({
      name: n,
      content,
      styleIndex: style != null ? Number(style) : null,
      positionMm: { leftMm: unitToMm(num('leftDistance')), topMm: unitToMm(num('topDistance')), widthMm: unitToMm(num('width')), heightMm: unitToMm(num('height')) },
    });
  }
  return { sheet: occ, floats, count: floats.length };
}

/** update_float_element：改已存在浮动元素的 内容 / 样式 / 位置 / 名称（未传字段沿用现有值） */
export function updateFloatElement(path, { name, newName, content, styleIndex, leftMm, topMm, widthMm, heightMm, sheet } = {}) {
  if (!name || !String(name).trim()) throw new Error('updateFloatElement: 必须提供 name（要改的浮动元素名）');
  const { raw } = load(path);
  const fb = locateFloatElement(raw, name, sheet);
  if (!fb) throw new Error(`定位失败：未找到浮动元素 ${name}`);
  let seg = fb.seg;
  const changed = [];

  if (newName != null && String(newName).trim() !== '' && String(newName).trim() !== String(name)) {
    if (!/^[A-Za-z0-9_\-\u4e00-\u9fa5]+$/.test(String(newName))) {
      throw new Error(`浮动元素新名非法：${newName}（仅允许字母/数字/_/-/中文）`);
    }
    const safeNew = escapeXmlAttr(String(newName).trim());
    // 查重（同 sheet 内）
    const occ = sheet == null ? 0 : locateSheet(raw, sheet).index;
    const other = locateFloatElement(raw, String(newName).trim(), occ);
    if (other) throw new Error(`浮动元素名已存在：${newName}`);
    seg = seg.replace(/<FloatElementName name="[^"]*"/, `<FloatElementName name="${safeNew}"`);
    changed.push('name');
  }
  if (content != null) {
    assertSafeCdata(content, '浮动元素内容');
    const m = seg.match(/<O>\s*<!\[CDATA\[[\s\S]*?\]\]>\s*<\/O>/);
    if (!m) throw new Error(`浮动元素 ${name} 无 <O> 内容节点（非标准形态）`);
    // 函数式替换：content 是用户输入（CDATA 正文），字符串式会把 $$/$&/$' 当特殊序列
    seg = seg.replace(m[0], () => `<O>\n<![CDATA[${content}]]></O>`);
    changed.push('content');
  }
  if (styleIndex != null) {
    const styleCount = styleBlocks(raw).blocks.length;
    const si = Number(styleIndex);
    if (!Number.isInteger(si) || si < 0 || si >= styleCount) {
      throw new Error(`浮动元素 styleIndex=${styleIndex} 越界（StyleList 仅 ${styleCount} 个样式）`);
    }
    const sm = seg.match(/<Style\s+index="\d+"/);
    if (!sm) throw new Error(`浮动元素 ${name} 无 <Style> 节点（非标准形态）`);
    seg = seg.replace(sm[0], `<Style index="${si}"`);
    changed.push('styleIndex');
  }
  if (leftMm != null || topMm != null || widthMm != null || heightMm != null) {
    const locMatch = seg.match(/<Location\s+([^>]*)\/?>/);
    if (!locMatch) throw new Error(`浮动元素 ${name} 无 <Location> 节点（非标准形态）`);
    let tag = locMatch[0];
    const setAttr = (attr, mmVal, min) => {
      const n = Number(mmVal);
      if (!Number.isFinite(n) || n < min || n > 10000) {
        throw new Error(`浮动元素 ${attr} 非法 (${mmVal})：必须是 ${min}-10000 之间的毫米数`);
      }
      const v = String(mmToUnit(n));
      const re = new RegExp(`\\b${attr}="[^"]*"`);
      return re.test(tag) ? tag.replace(re, `${attr}="${v}"`) : tag.replace(/\/>$/, ` ${attr}="${v}"/>`);
    };
    if (leftMm != null) tag = setAttr('leftDistance', leftMm, 0);
    if (topMm != null) tag = setAttr('topDistance', topMm, 0);
    if (widthMm != null) tag = setAttr('width', widthMm, 1);
    if (heightMm != null) tag = setAttr('height', heightMm, 1);
    if (tag !== locMatch[0]) {
      // 函数式替换：tag 含**文件内容**（原 Location 属性），字符串式会改写其中的 $$/$&/$'
      seg = seg.replace(locMatch[0], () => tag);
      changed.push('position');
    }
  }
  if (changed.length === 0) throw new Error('updateFloatElement: content / styleIndex / 位置(leftMm/topMm/widthMm/heightMm) / newName 至少传一个');
  const out = raw.slice(0, fb.start) + seg + raw.slice(fb.end);
  save(path, out);
  return { action: 'update_float_element', name: String(name), newName: newName ?? null, changed, bytes: Buffer.byteLength(out, 'utf8') };
}

// ============ 填报提交 update ============

/** 在 seg 内替换首个 openTag..closeTag 块内的 CDATA 内容 */
function replaceCdataInSeg(seg, openTag, closeTag, newValue, what) {
  const o = seg.indexOf(openTag);
  if (o < 0) throw new Error(`定位失败：${what} 段内无 ${openTag}`);
  const closeIdx = seg.indexOf(closeTag, o);
  if (closeIdx < 0) throw new Error(`定位失败：${what} 段内无 ${closeTag}`);
  const block = seg.slice(o, closeIdx + closeTag.length);
  const cdOpen = block.indexOf('<![CDATA[');
  if (cdOpen < 0) throw new Error(`定位失败：${what} 段内无 CDATA`);
  const cdClose = block.indexOf(']]>', cdOpen + 9);
  if (cdClose < 0) throw new Error(`定位失败：${what} CDATA 未闭合`);
  return seg.slice(0, o + cdOpen + 9) + newValue + seg.slice(o + cdClose);
}

/** 在 seg 内替换 tagOpen 开标签的属性值 */
function replaceAttrInSeg(seg, tagOpen, attr, newValue, what) {
  const o = seg.indexOf(tagOpen);
  if (o < 0) throw new Error(`定位失败：${what} 无 ${tagOpen}`);
  const gt = seg.indexOf('>', o);
  if (gt < 0) throw new Error(`定位失败：${what} 的 ${tagOpen} 未闭合`);
  const tag = seg.slice(o, gt + 1);
  const escaped = String(attr).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`(\\b${escaped}\\s*=\\s*["'])([^"']*)(["'])`).exec(tag);
  if (!m) throw new Error(`定位失败：${what} 无属性 ${attr}`);
  const valStart = o + m.index + m[1].length;
  const valEnd = valStart + m[2].length;
  return seg.slice(0, valStart) + newValue + seg.slice(valEnd);
}

/** 在段内给【全部】<ColumnConfig> 开标签设置同一属性（批量 switch 用；属性不存在则补上）。 */
function setAllColumnConfigAttr(seg, attr, value) {
  const re = /<ColumnConfig\b[^>]*>/g;
  const hits = [];
  let m;
  while ((m = re.exec(seg)) !== null) hits.push({ start: m.index, tag: m[0] });
  let out = seg;
  let count = 0;
  for (const h of [...hits].reverse()) {
    const re2 = new RegExp(`\\b${attr}\\s*=\\s*"[^"]*"`);
    const newTag = re2.test(h.tag)
      ? h.tag.replace(re2, () => `${attr}="${value}"`)
      : h.tag.slice(0, -1) + ` ${attr}="${value}">`;
    out = out.slice(0, h.start) + newTag + out.slice(h.start + h.tag.length);
    count++;
  }
  return { seg: out, count };
}

const FORMULA_CONDITION_CLASS = 'com.fr.data.condition.FormulaCondition';
const FORMULA_CONDITION_OPEN = '<Condition class="com.fr.data.condition.FormulaCondition">';
const LIST_CONDITION_CLASS = 'com.fr.data.condition.ListCondition';
const LIST_CONDITION_OPEN = `<Condition class="${LIST_CONDITION_CLASS}"/>`;

/** FineReport 内置 SQL 提交的 DMLConfig 类型（官方样本实证）。 */
const DML_CONFIG_TYPES = Object.freeze({
  intelligent: 'com.fr.write.config.IntelliDMLConfig',
  insert: 'com.fr.write.config.InsertConfig',
});

/** 归一 submitType/configType；返回 {type, class} 或 null（未指定）。 */
function normalizeDmlConfigType(value) {
  const raw = value == null ? '' : String(value).trim();
  if (raw === '') return null;
  const compact = raw.toLowerCase().replace(/[^a-z]/g, '');
  if (compact === 'insert' || compact === 'insertconfig' || compact === 'comfrwriteconfiginsertconfig') {
    return { type: 'insert', class: DML_CONFIG_TYPES.insert };
  }
  if (compact === 'intelligent' || compact === 'smart' || compact === 'intellidmlconfig'
    || compact === 'comfrwriteconfigintellidmlconfig') {
    return { type: 'intelligent', class: DML_CONFIG_TYPES.intelligent };
  }
  throw new Error(`updateFillSubmit: 不支持的提交类型 "${raw}"；可用 insert（插入提交）或 intelligent（智能提交）`);
}

/** 只改 <DMLConfig class="..."> 的属性值，其余字节原样保留。 */
function replaceDmlConfigClass(seg, cls) {
  const m = seg.match(/<DMLConfig\b[^>]*>/);
  if (!m) throw new Error('updateFillSubmit: 该提交没有 <DMLConfig>（自由 SQL 提交没有提交类型）');
  if (!/\bclass="[^"]*"/.test(m[0])) throw new Error('updateFillSubmit: DMLConfig 缺少 class 属性，拒绝猜写');
  const tag = m[0].replace(/\bclass="[^"]*"/, () => `class="${cls}"`);
  return seg.slice(0, m.index) + tag + seg.slice(m.index + m[0].length);
}


/**
 * 设置/清空 SubmitVisitor 的提交条件（DMLConfig 内 FormulaCondition）。
 * @param {string} seg SubmitVisitor 段
 * @param {string|null} condition 公式文本（不需要前导 =）；null/'' = 清除条件
 * @returns {{seg: string, changed: boolean, formula: string|null}}
 */
function upsertSubmitCondition(seg, condition) {
  const dmlOpen = seg.indexOf('<DMLConfig');
  if (dmlOpen < 0) throw new Error('updateFillSubmit: 该提交没有 <DMLConfig>（自由 SQL 提交请把过滤条件写进 SQL 的 WHERE）');
  const dmlClose = seg.indexOf('</DMLConfig>', dmlOpen);
  if (dmlClose < 0) throw new Error('updateFillSubmit: DMLConfig 未闭合，拒绝改写（结构异常，请先核对模板）');
  // 现有条件节点（只安全反解 FormulaCondition；其它 class 不猜语义）
  const cOpen = seg.lastIndexOf('<Condition', dmlClose);
  let existing = null;
  if (cOpen > dmlOpen) {
    const headEnd = seg.indexOf('>', cOpen);
    const head = seg.slice(cOpen, headEnd + 1);
    const cls = (head.match(/\bclass="([^"]*)"/) || [])[1] || null;
    const selfClose = head.trimEnd().endsWith('/>');
    let cEnd = headEnd + 1;
    if (!selfClose) {
      const closeIdx = seg.indexOf('</Condition>', headEnd + 1);
      if (closeIdx < 0 || closeIdx > dmlClose) throw new Error('updateFillSubmit: 提交条件 <Condition> 未闭合，拒绝改写');
      cEnd = closeIdx + '</Condition>'.length;
    }
    existing = { start: cOpen, end: cEnd, cls, selfClose };
  }
  // 2026-11-05：condition 接受 FormulaCondition / ListCondition；字符串 "ListCondition" 表示空列表条件。
  const want = condition == null ? { kind: 'none' } : normalizeSubmitConditionText(condition);
  if (want.kind === 'none') {
    if (!existing) return { seg, changed: false, formula: null, type: null };
    if (existing.cls != null && existing.cls !== FORMULA_CONDITION_CLASS && existing.cls !== LIST_CONDITION_CLASS) {
      throw new Error(`updateFillSubmit: 现有提交条件 class="${existing.cls}" 不是已知条件类型，本工具不猜语义、拒绝清除；请用 update_report_node 定向改写`);
    }
    let s = existing.start;
    // 连同一处换行一起删，避免留下空行
    if (seg[s - 1] === '\n') s -= 1;
    return { seg: seg.slice(0, s) + seg.slice(existing.end), changed: true, formula: null, type: null };
  }
  if (want.kind === 'list') {
    if (existing?.cls === LIST_CONDITION_CLASS) {
      if (!existing.selfClose) throw new Error('updateFillSubmit: 现有 ListCondition 含子条件（非空列表），本工具不覆盖非空条件；请用 update_report_node 定向改写');
      return { seg, changed: false, formula: null, type: 'list' };
    }
    if (existing?.cls != null && existing.cls !== FORMULA_CONDITION_CLASS) {
      throw new Error(`updateFillSubmit: 现有提交条件 class="${existing.cls}" 不是 FormulaCondition/ListCondition，拒绝覆盖`);
    }
    const prefix = existing ? seg.slice(0, existing.start) : seg.slice(0, dmlClose);
    const suffix = existing ? seg.slice(existing.end) : seg.slice(dmlClose);
    const sep = existing || prefix.endsWith('\n') ? '' : '\n';
    return { seg: `${prefix}${sep}${LIST_CONDITION_OPEN}${existing ? '' : '\n'}${suffix}`, changed: true, formula: null, type: 'list' };
  }
  if (existing && existing.cls != null && existing.cls !== FORMULA_CONDITION_CLASS && existing.cls !== LIST_CONDITION_CLASS) {
    throw new Error(`updateFillSubmit: 现有提交条件 class="${existing.cls}" 不是 FormulaCondition/ListCondition，本工具只安全改写已知条件`);
  }
  const safe = assertSafeCdata(want.formula, '提交条件');
  const block = `${FORMULA_CONDITION_OPEN}\n<Formula>\n<![CDATA[${safe}]]></Formula>\n</Condition>`;
  if (existing) {
    return { seg: seg.slice(0, existing.start) + block + seg.slice(existing.end), changed: true, formula: want.formula, type: 'formula' };
  }
  const prefix = seg.slice(0, dmlClose);
  const sep = prefix.endsWith('\n') ? '' : '\n';
  return { seg: `${prefix}${sep}${block}\n${seg.slice(dmlClose)}`, changed: true, formula: want.formula, type: 'formula' };
}

/** 提交条件归一（容忍前导 =；支持 FormulaCondition 和空 ListCondition）。
 *  返回 {kind:'none'} / {kind:'list'} / {kind:'formula', formula}。 */
function normalizeSubmitConditionText(condition) {
  if (condition == null) return { kind: 'none' };
  const isObj = typeof condition === 'object' && !Array.isArray(condition);
  if (!isObj) {
    const s = String(condition).trim();
    if (s === '') return { kind: 'none' };
    if (/^(?:listcondition|list)$/i.test(s)) return { kind: 'list' };
    return { kind: 'formula', formula: s.startsWith('=') ? s.slice(1).trim() : s };
  }
  const cls = typeof condition.class === 'string' ? condition.class.trim() : '';
  if (condition.list === true || condition.type === 'list') return { kind: 'list' };
  if (cls === LIST_CONDITION_CLASS) {
    const explicit = condition.formula ?? condition.expr ?? condition.expression;
    if (typeof explicit === 'string' && explicit.trim() !== '') {
      const s = explicit.trim();
      return { kind: 'formula', formula: s.startsWith('=') ? s.slice(1).trim() : s };
    }
    return { kind: 'list' };
  }
  if (cls && cls !== FORMULA_CONDITION_CLASS) {
    throw new Error(`updateFillSubmit: 提交条件对象 class="${cls}" 不支持；可用 FormulaCondition 公式文本或 ListCondition（空列表）`);
  }
  const raw = condition.formula ?? condition.expr ?? condition.expression ?? condition.value ?? condition.text;
  if (typeof raw !== 'string') {
    throw new Error('updateFillSubmit: 提交条件对象缺少 formula 字段（需要 {class:"com.fr.data.condition.FormulaCondition", formula:"Y5=1"}、{formula:"Y5=1"} 或 {class:"com.fr.data.condition.ListCondition"}）');
  }
  const s = raw.trim();
  if (s === '') return { kind: 'none' };
  return { kind: 'formula', formula: s.startsWith('=') ? s.slice(1).trim() : s };
}

/**
 * update_fill_submit：改【已存在】填报提交的名称 / 数据连接 / 目标表 / schema（列映射形态）
 * 或 sql / dbName / parameters（自由 SQL 形态）；sandbox19/v1 补齐：
 *   · condition —— 读/写提交条件（FormulaCondition 公式，或空 ListCondition）；null/''=清除；
 *   · skipUnmodified —— 批量设置该提交全部列的「未修改则跳过」（列级智能提交）；
 *   · submitType/configType —— 改 DMLConfig 类型：IntelliDMLConfig（智能提交）/ InsertConfig（插入提交）。
 * 只改 SubmitVisitor 块内，不追加、不重建、不碰 bindings（bindings 用 update_fill_binding）。
 */
export function updateFillSubmit(path, { submitIndex = 0, name, dsName, table, schema, sql, dbName, sheet, parameters, condition, skipUnmodified, submitType, configType } = {}) {
  const { raw } = load(path);
  const [sb, se] = locateSubmit(raw, submitIndex, `提交 ${submitIndex + 1}`, sheet, path);
  let seg = raw.slice(sb, se);
  const isFreeSql = seg.includes('class="com.fr.report.write.FreeSQLSubmiter"');
  const changed = [];
  // 显式意图（用于区分"一个参数都没传"与"传了但已是目标状态"的无操作）：
  // 例如 condition:null 清除一个本来就不存在的条件应幂等成功，而不是报"至少传一个"。
  const hasIntent = name != null || dsName != null || table != null || schema != null || sql != null
    || dbName != null || parameters != null || condition !== undefined || skipUnmodified !== undefined
    || submitType != null || configType != null;
  let nextCondition;          // 设置后的提交条件（公式文本 / 'ListCondition' / null=已清空；undefined=未涉及）
  let skipUnmodifiedColumns;  // 批量设置的列数
  let nextSubmitType;         // 设置后的提交类型（未涉及=undefined）

  if (name != null && String(name).trim() !== '') {
    seg = replaceCdataInSeg(seg, '<Name>', '</Name>', assertSafeCdata(String(name), '提交名称'), '提交名称');
    changed.push('name');
  }
  if (isFreeSql) {
    if (table != null || schema != null) {
      throw new Error('updateFillSubmit: 该提交为自由 SQL 形态（FreeSQLSubmiter），不能改 table/schema；请用 sql/dbName');
    }
    if (condition !== undefined || skipUnmodified !== undefined) {
      throw new Error('updateFillSubmit: condition / skipUnmodified 只用于列映射提交（BuiltInSQLSubmiter）；自由 SQL 提交请把过滤条件写进 SQL 的 WHERE');
    }
    if (submitType != null || configType != null) {
      throw new Error('updateFillSubmit: submitType/configType 只用于列映射提交（BuiltInSQLSubmiter）；自由 SQL 提交没有 DMLConfig');
    }
    if (sql != null && String(sql).trim() !== '') {
      seg = replaceCdataInSeg(seg, '<SQL>', '</SQL>', assertSafeCdata(String(sql), '自由 SQL'), '自由 SQL');
      changed.push('sql');
      // 2026-10-30 修（sandbox4/v1 实测缺口）：改 SQL 后要保证其中的 ${x} 都有声明，
      // 否则 FR 不替换、${x} 原样进数据库。已有声明原样保留（自定义取值不被覆盖），只补缺失项。
      if (parameters == null) {
        const hasExtra = ensureSubmitParameters(seg, normalizeSubmitParameters(String(sql), null));
        if (hasExtra !== seg) { seg = hasExtra; changed.push('parameters'); }
      }
    }
    if (parameters != null) {
      // 显式传 parameters = 以此列表为准（整块替换）；空数组 = 清空声明（<Parameters/>）
      const decls = normalizeSubmitParameters('', parameters);
      seg = replaceSubmitParameters(seg, decls);
      changed.push('parameters');
    }
    if (dbName != null && String(dbName).trim() !== '') {
      seg = replaceCdataInSeg(seg, '<DBName>', '</DBName>', assertSafeCdata(String(dbName), 'DBName'), 'DBName');
      changed.push('dbName');
    }
  } else {
    if (sql != null) {
      throw new Error('updateFillSubmit: 该提交为列映射形态（BuiltInSQLSubmiter），不能改 sql；如需自由 SQL 请 delete_fill_submit 后 add_fill_submit');
    }
    if (parameters != null) {
      throw new Error('updateFillSubmit: parameters（提交参数声明）只用于自由 SQL 提交（FreeSQLSubmiter）；列映射提交的值由字段绑定（update_fill_binding）决定');
    }
    if (submitType != null || configType != null) {
      const dml = normalizeDmlConfigType(submitType ?? configType);
      const cur = seg.match(/<DMLConfig\b[^>]*\bclass="([^"]*)"/);
      if (!cur) throw new Error('updateFillSubmit: 该提交没有 DMLConfig，无法判断提交类型');
      if (cur[1] !== dml.class) {
        seg = replaceDmlConfigClass(seg, dml.class);
        changed.push('submitType');
      }
      nextSubmitType = dml;
    }
    if (dsName != null && String(dsName).trim() !== '') {
      seg = replaceAttrInSeg(seg, '<Attributes ', 'dsName', escapeXmlAttr(String(dsName).trim()), '提交数据连接');
      changed.push('dsName');
    }
    if (table != null && String(table).trim() !== '') {
      seg = replaceAttrInSeg(seg, '<Table ', 'name', escapeXmlAttr(String(table).trim()), '提交目标表');
      changed.push('table');
    }
    if (schema != null) {
      seg = replaceAttrInSeg(seg, '<Table ', 'schema', escapeXmlAttr(String(schema)), '提交 schema');
      changed.push('schema');
    }
    // 提交条件（sandbox19/v1 缺口补齐）：直接读写 DMLConfig 里的 FormulaCondition，
    // 不再需要 report_rewrite/update_report_node 手拼 XML（那也正是造成 <Condition><Condition>
    // 双层嵌套、以及 Y5=1 陈旧条件导致"提交静默不写库"的路径）。
    if (condition !== undefined) {
      const r = upsertSubmitCondition(seg, condition);
      if (r.changed) {
        seg = r.seg;
        changed.push('condition');
      }
      nextCondition = r.formula ?? (r.type === 'list' ? 'ListCondition' : null);
    }
    // 批量列级智能提交：该提交全部 ColumnConfig 的 skipUnmodified 一次设置
    if (skipUnmodified !== undefined) {
      const r = setAllColumnConfigAttr(seg, 'skipUnmodified', String(skipUnmodified === true));
      if (r.count === 0) throw new Error('updateFillSubmit: 该提交没有 ColumnConfig 可设置 skipUnmodified（自由 SQL 提交请用 SQL WHERE）');
      seg = r.seg;
      changed.push('skipUnmodified');
      skipUnmodifiedColumns = r.count;
    }
  }
  if (changed.length === 0 && !hasIntent) {
    throw new Error('updateFillSubmit: name / dsName / table / schema / condition / skipUnmodified / submitType（列映射）或 sql / dbName / parameters（自由 SQL）至少传一个');
  }
  const out = raw.slice(0, sb) + seg + raw.slice(se);
  save(path, out);
  let unresolvedParamRefs;
  if (isFreeSql) {
    // 提交 SQL 里仍无法解析的 ${...}（非裸标识符，如 FR 公式）—— 不改写，但让调用方看见
    const sqlSeg = seg.match(/<SQL>\s*<!\[CDATA\[([\s\S]*?)\]\]>/);
    unresolvedParamRefs = [...String(sqlSeg ? sqlSeg[1] : '').matchAll(/\$\{([^}]+)\}/g)]
      .map((m) => m[1]).filter((x) => !/^[A-Za-z_][\w]*$/.test(x));
  }
  const dmlClass = !isFreeSql ? (seg.match(/<DMLConfig\b[^>]*\bclass="([^"]*)"/)?.[1] ?? null) : null;
  const submitTypeNow = dmlClass === DML_CONFIG_TYPES.insert ? 'insert'
    : dmlClass === DML_CONFIG_TYPES.intelligent ? 'intelligent' : null;
  return {
    action: 'update_fill_submit', submitIndex, sheet: sheet ?? 0, mode: isFreeSql ? 'free-sql' : 'built-in', changed,
    ...(isFreeSql ? { parameters: readSubmitParameterNames(seg), ...(unresolvedParamRefs.length ? { unresolvedParamRefs } : {}) } : {}),
    ...(!isFreeSql ? { submitType: submitTypeNow, dmlConfigClass: dmlClass } : {}),
    ...(condition !== undefined ? { condition: nextCondition ?? null } : {}),
    ...(skipUnmodifiedColumns !== undefined ? { skipUnmodified: skipUnmodified === true, skipUnmodifiedColumns } : {}),
    bytes: Buffer.byteLength(out, 'utf8'),
  };
}

// ============ 工作表 update ============

/** update_sheet：重命名【已存在】的工作表（改 <Report name="...">，仅 name 属性，不重建网格/内容） */
/**
 * 改工作表：改名（newName）和/或调整顺序（order）。
 *
 * 2026-10-23 补齐 order：此前只能改名，想「把某表临时挪到最后」当绕行手段做不到。
 * 顺序即 .cpt 里 <Report class="…WorkSheet"> 块在文档中的先后（sheetBlocks 的顺序），
 * 故按整块「剪切 → 按目标序号插回」实现，块本身字节原样搬运（不动任何子节点）。
 * order = 移动后该表的目标序号（0 起）；otherSheet 仅用于报错/回显时区分。
 */
export function updateSheet(path, { sheet, newName, order } = {}) {
  const wantRename = newName != null && String(newName).trim() !== '';
  const wantMove = order != null && String(order).trim() !== '';
  if (!wantRename && !wantMove) {
    throw new Error('updateSheet: 至少提供 newName（改名）或 order（调整顺序）之一');
  }
  const { raw } = load(path);
  const b = locateSheet(raw, sheet);
  let out = raw;
  let newNameApplied = null;

  if (wantRename) {
    const safeNew = String(newName).trim();
    const blocks = sheetBlocks(raw);
    if (blocks.some((x) => x.name === safeNew && x.start !== b.start)) {
      throw new Error(`updateSheet: 工作表名已存在：${safeNew}`);
    }
    const head = raw.slice(b.start, raw.indexOf('>', b.start) + 1);
    const m = head.match(/\bname="([^"]*)"/);
    if (!m) throw new Error('updateSheet: 工作表 Report 开标签无 name 属性');
    const valStart = b.start + m.index + 'name="'.length;
    const valEnd = valStart + m[1].length;
    out = raw.slice(0, valStart) + escapeXmlAttr(safeNew) + raw.slice(valEnd);
    newNameApplied = safeNew;
  }

  let moved = null;
  if (wantMove) {
    const blocks = sheetBlocks(out);
    const cur = blocks.findIndex((x) => (wantRename ? x.start === b.start : x.start === b.start));
    const dest = Number(order);
    if (!Number.isInteger(dest) || dest < 0 || dest >= blocks.length) {
      throw new Error(`updateSheet: order=${order} 非法（现有 ${blocks.length} 个工作表，可用 0..${blocks.length - 1}）`);
    }
    if (cur < 0) throw new Error('updateSheet: 定位失败（工作表块在改名后失配）');
    if (dest !== cur) {
      const from = blocks[cur];
      // 连块前换行一起切走，避免留下空行
      let cutFrom = from.start;
      while (cutFrom > 0 && (out[cutFrom - 1] === '\n' || out[cutFrom - 1] === '\r')) cutFrom -= 1;
      const blockText = out.slice(from.start, from.end);
      const removed = out.slice(0, cutFrom) + out.slice(from.end);
      const rest = sheetBlocks(removed);
      let insertAt;
      if (dest >= rest.length) {
        insertAt = rest[rest.length - 1].end;      // 挪到最后：插在末块之后
      } else {
        insertAt = rest[dest].start;               // 挪到目标位置之前
        while (insertAt > 0 && (removed[insertAt - 1] === '\n' || removed[insertAt - 1] === '\r')) insertAt -= 1;
      }
      const glue = dest >= rest.length ? '\n' : '\n';
      out = removed.slice(0, insertAt) + glue + blockText + (dest >= rest.length ? '' : '\n') + removed.slice(insertAt);
      moved = { from: cur, to: dest };
    } else {
      moved = { from: cur, to: dest, noop: true };
    }
  }

  save(path, out);
  const finalBlocks = sheetBlocks(out);
  return {
    action: 'update_sheet',
    sheet: b.name,
    index: moved ? moved.to : b.index,
    ...(newNameApplied ? { newName: newNameApplied } : {}),
    ...(moved ? { order: moved.to, from: moved.from, moved: !moved.noop } : {}),
    sheets: finalBlocks.map((x, i) => `${i}:${x.name || '(未命名)'}`),
    bytes: Buffer.byteLength(out, 'utf8'),
  };
}

export { save, escapeXmlAttr, assertSafeCdata };

// ============ Web 页面静态资源引用（ReportWebAttr 内 <CSSImport>/<JSImport>） ============
//
// 背景（sandbox17 实测）：展示/填报类模板用 <CSSImport>/<JSImport> 引用服务器磁盘文件
// （FR 预览时按 webroot 相对路径加载，如 css/index.css、js/index.js），放自定义样式与页面 JS。
// cpt-mcp 此前没有任何读写删查入口：update_report_node 的 M91 同名多候选拒绝 + upsert
// 语义导致“第 2 个 JSImport 会静默替换第 1 个”（实测复现）；build_report 重建还会整段丢掉。
// 本工具是唯一正确落点：整段替换语义（传的数组即落盘后的完整有序列表，先 CSS 后 JS）。

/** 静态资源路径合法性（FR 按 webroot 相对路径加载；只收相对路径） */
function assertImportPath(p, kind) {
  const tag = kind === 'css' ? 'CSSImport' : 'JSImport';
  if (typeof p !== 'string' || p.trim() === '') throw new Error(`setReportImports: ${tag} 路径必须是非空字符串`);
  const s = p.trim();
  if (/[\x00-\x1f]/.test(s)) throw new Error(`setReportImports: ${tag} 路径含控制字符，已拒绝`);
  assertSafeCdata(s, `${tag} 路径`);
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(s) || s.startsWith('//')) {
    throw new Error(`setReportImports: ${tag} 不支持绝对 URL/协议前缀（FR 按 webroot 相对路径加载）：${s.slice(0, 80)}`);
  }
  if (s.startsWith('/') || s.startsWith('\\') || s.includes('\\')) {
    throw new Error(`setReportImports: ${tag} 必须是 webroot 相对路径（正斜杠分隔，不以 / 开头，不含 .. 与反斜杠）：${s.slice(0, 80)}`);
  }
  if (s.split('/').some((g) => g === '..')) {
    throw new Error(`setReportImports: ${tag} 路径不允许含 ..（目录穿越）：${s.slice(0, 80)}`);
  }
  const ext = kind === 'css' ? /\.css$/i : /\.js$/i;
  if (!ext.test(s)) throw new Error(`setReportImports: ${tag} 路径后缀必须与类型一致（css→.css，js→.js）：${s.slice(0, 80)}`);
  return s;
}

function normalizeImportList(list, kind) {
  if (!Array.isArray(list)) throw new Error(`setReportImports: ${kind} 必须是数组（传空数组=清空该类引用，不传=不动）`);
  return list.map((p) => assertImportPath(p, kind));
}

/** 拼一段 imports XML（顺序：先 CSS 后 JS，与设计器落盘顺序一致） */
function importsXml(cssList, jsList) {
  const lines = [];
  for (const p of cssList) lines.push(`<CSSImport>\n<![CDATA[${p}]]></CSSImport>`);
  for (const p of jsList) lines.push(`<JSImport>\n<![CDATA[${p}]]></JSImport>`);
  return lines.join('\n');
}

/**
 * 设置模板级 Web 页面静态资源引用（<ReportWebAttr> 内 <CSSImport>/<JSImport> 整段替换）。
 * @param {string} path .cpt 路径
 * @param {{css?: string[], js?: string[], webroot?: string}} [opts]
 *   css/js：完整有序列表（传空数组=清空该类；不传=不动）；webroot：服务器 webroot 目录
 *   （可选，仅用于核对文件是否存在——缺失只告警不阻断，本地与生产 webroot 常不一致）。
 * @returns {{action, css, js, changed, removed, warnings, bytes}}
 */
export function setReportImports(path, { css, js, webroot } = {}) {
  const hasCss = css !== undefined;
  const hasJs = js !== undefined;
  if (!hasCss && !hasJs) throw new Error('setReportImports: 至少传 css 或 js 其中之一（数组；传空数组=清空该类引用，不传=不动）');
  const cssList = hasCss ? normalizeImportList(css, 'css') : null;
  const jsList = hasJs ? normalizeImportList(js, 'js') : null;

  const { raw } = load(path);
  const openM = raw.match(/<ReportWebAttr\b[^>]*>/);
  let out;
  let removed = { css: 0, js: 0 };
  if (!openM) {
    // 无 ReportWebAttr：在第一个 <Report> 前创建（含 WebPageContent 骨架，与 insertIntoReportWebAttr 同口径）
    const firstReport = raw.search(/<Report\b/);
    if (firstReport < 0) throw new Error('setReportImports: 模板缺少 <Report> 工作表，无法确定 <ReportWebAttr> 挂载位置');
    const block = `<ReportWebAttr>\n${REPORT_WEB_ATTR_SKELETON}\n${importsXml(cssList ?? [], jsList ?? [])}\n</ReportWebAttr>\n`;
    out = raw.slice(0, firstReport) + block + raw.slice(firstReport);
    save(path, out);
    const warnings = webrootWarnings(cssList ?? [], jsList ?? [], webroot);
    return { action: 'set_report_imports', css: cssList ?? [], js: jsList ?? [], changed: true, removed, createdAttr: true, warnings, bytes: Buffer.byteLength(out, 'utf8') };
  }
  const openTag = openM[0];
  if (openTag.trim().endsWith('/>')) {
    // 自闭合 → 展开（保留属性），WebPageContent 骨架 + 本次 imports
    const attrs = openTag.slice('<ReportWebAttr'.length, openTag.length - 2);
    out = raw.slice(0, openM.index)
      + `<ReportWebAttr${attrs}>\n${REPORT_WEB_ATTR_SKELETON}\n${importsXml(cssList ?? [], jsList ?? [])}\n</ReportWebAttr>`
      + raw.slice(openM.index + openTag.length);
    save(path, out);
    const warnings = webrootWarnings(cssList ?? [], jsList ?? [], webroot);
    return { action: 'set_report_imports', css: cssList ?? [], js: jsList ?? [], changed: true, removed, createdAttr: true, warnings, bytes: Buffer.byteLength(out, 'utf8') };
  }
  const openEnd = raw.indexOf('>', openM.index) + 1;
  // CDATA 掩码只用于标签扫描（等长空格，索引与原文一致），避免路径里的字面量误判
  const maskedAll = raw.replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, (c) => ' '.repeat(c.length));
  const closeIdx = maskedAll.indexOf('</ReportWebAttr>', openEnd);
  if (closeIdx < 0) throw new Error('setReportImports: <ReportWebAttr> 未闭合（缺失 </ReportWebAttr>）');
  const old = readReportImportsIn(raw, openEnd, closeIdx);
  const finalCss = hasCss ? cssList : old.css;
  const finalJs = hasJs ? jsList : old.js;
  const stripped = stripReportImports(raw, openEnd, closeIdx);
  removed = stripped.removed;
  const seg = importsXml(finalCss, finalJs);
  const at = stripped.raw.replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, (c) => ' '.repeat(c.length)).indexOf('</ReportWebAttr>');
  out = stripped.raw.slice(0, at) + (seg ? seg + '\n' : '') + stripped.raw.slice(at);
  const changed = JSON.stringify(finalCss) !== JSON.stringify(old.css) || JSON.stringify(finalJs) !== JSON.stringify(old.js);
  if (!changed) {
    const warnings = webrootWarnings(finalCss, finalJs, webroot);
    return { action: 'set_report_imports', mode: 'noop', css: finalCss, js: finalJs, changed: false, removed, warnings, bytes: Buffer.byteLength(raw, 'utf8') };
  }
  save(path, out);
  const warnings = webrootWarnings(finalCss, finalJs, webroot);
  return { action: 'set_report_imports', css: finalCss, js: finalJs, changed: true, removed, warnings, bytes: Buffer.byteLength(out, 'utf8') };
}

/** 读取 [start, end) 区间内的顶层 CSSImport/JSImport 路径（保持文档顺序） */
function readReportImportsIn(raw, start, end) {
  const collect = (tag) => {
    const out = [];
    const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'g');
    let m;
    while ((m = re.exec(raw)) !== null) {
      if (m.index < start || m.index >= end) continue;
      const cdata = m[1].match(/<!\[CDATA\[([\s\S]*?)\]\]>/);
      const v = (cdata ? cdata[1] : m[1]).trim();
      if (v) out.push(v);
    }
    return out;
  };
  return { css: collect('CSSImport'), js: collect('JSImport') };
}

/** 删除 [start, end) 区间内的全部顶层 CSSImport/JSImport 块；返回新串与删除计数 */
function stripReportImports(raw, start, end) {
  const masked = raw.replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, (c) => ' '.repeat(c.length));
  const ranges = [];
  const removed = { css: 0, js: 0 };
  for (const [tag, key] of [['CSSImport', 'css'], ['JSImport', 'js']]) {
    const re = new RegExp(`<${tag}\\b`, 'g');
    let m;
    while ((m = re.exec(masked)) !== null) {
      const i = m.index;
      if (i < start || i >= end) continue;
      const ch = masked[i + tag.length + 1];
      if (ch == null || !/[\s/>]/.test(ch)) continue;
      const ge = raw.indexOf('>', i);
      if (ge < 0 || ge >= end) throw new Error(`setReportImports: <${tag}> 开标签未闭合`);
      let stop;
      if (raw.slice(i, ge + 1).trim().endsWith('/>')) {
        stop = ge + 1;
      } else {
        const closeIdx = raw.indexOf(`</${tag}>`, ge + 1);
        if (closeIdx < 0) throw new Error(`setReportImports: <${tag}> 未闭合（缺失 </${tag}>）`);
        stop = closeIdx + `</${tag}>`.length;
      }
      let s = i;
      const lineStart = raw.lastIndexOf('\n', s - 1) + 1;
      if (raw.slice(lineStart, s).trim() === '') s = lineStart;
      let e = stop;
      if (raw[e] === '\r') e += 1;
      if (raw[e] === '\n') e += 1;
      ranges.push([s, e]);
      removed[key] += 1;
    }
  }
  ranges.sort((a, b) => b[0] - a[0]);
  let out = raw;
  for (const [s, e] of ranges) out = out.slice(0, s) + out.slice(e);
  return { raw: out, removed };
}

/** webroot 存在性核对（只读 stat；webroot 缺失或文件找不到都只告警不阻断） */
function webrootWarnings(cssList, jsList, webroot) {
  const warnings = [];
  if (webroot == null || String(webroot).trim() === '') return warnings;
  const root = String(webroot).trim().replace(/[/\\]+$/, '');
  let rootOk = false;
  try { rootOk = statSync(root).isDirectory(); } catch { rootOk = false; }
  if (!rootOk) {
    warnings.push(`webroot 目录不存在或不可读（仅跳过存在性核对，不阻断写入）：${root.slice(0, 120)}`);
    return warnings;
  }
  for (const p of [...cssList, ...jsList]) {
    let ok = false;
    try { ok = statSync(`${root}/${p}`).isFile(); } catch { ok = false; }
    if (!ok) warnings.push(`引用的服务器文件在该 webroot 下不存在：${p}（本地与生产 webroot 常不一致，请确认生产环境）`);
  }
  return warnings;
}
