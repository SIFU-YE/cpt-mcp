// cpt-mcp/lib/generate.js —— CPT 模板生成：从零建骨架 + 分步拼装工具
// 所有生成的 XML 结构均对照真实 .cpt 样本（FineReport 安装目录下的 reportlets 与用户填报样本）反推，
// 标签/属性与映射清单（FineReport_CPT_XML映射清单.md）保持一致。
import fs from 'node:fs';
import path from 'node:path';
import { load, save, findAll, blockRange, replaceAttr, insertBefore, insertAfter, sheetBlocks, locateSheet, styleBlocks } from './xml.js';
import { dictionaryXml, parameterXml } from './edits.js';
// 2026-10-29：XML 转义/公式对象构造来自 leaf 模块 format.js（edits 不再兼作底层工具库）
import { escapeXmlAttr, assertSafeCdata, formulaObjectXml } from './format.js';
// P0-2: 对齐取值的引导性校验（常量源自官方 1559 样本统计）
import { assertHorizontalAlignment, assertVerticalAlignment, PAPER_PRESETS, DESIGN_TOKENS, hexToArgb, mmToUnit, unitToMm } from './engine/rules.js';
// S2: DSColumn 的数据集引用完整性
import { assertDatasetExists } from './cpt.js';
// M76: DSColumn 汇总形态（SummaryGrouper）—— RG 块构造与白名单复用 chart.CHART_AGGS
import { dsColumnRGXml } from './engine/chart.js';
// 自由 SQL 提交的「提交参数」声明（SQL ${x} → <Parameters>，与 update_fill_submit 共用同一实现）
import { normalizeSubmitParameters, submitParametersXml } from './fill-submit.js';
// 参数面板控件 type 别名归一（textEditor→text 等；与 lib/arg-normalize.js 共用同一事实源）
import { canonicalWidgetType } from './widget-types.js';

// ---- 单位换算（真实样本验证：1mm = 144000 单位；实现与基准统一在 rules.js，此处转出以保 API）----
export { mmToUnit, unitToMm };

const DEF_ROW_H = DESIGN_TOKENS.frDefault.rowHeight;  // 骨架默认行高 723900（5.03mm，样本值）
const DEF_COL_W = DESIGN_TOKENS.frDefault.colWidth;   // 骨架默认列宽 2743200（19.05mm，样本值）

/** 列号(0起) → 列字母：0→A, 25→Z, 26→AA */
export function colLetter(n) {
  let s = '';
  let v = Number(n) + 1;
  while (v > 0) {
    const m = (v - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    v = Math.floor((v - 1) / 26);
  }
  return s;
}

const A4_W = mmToUnit(210);    // 30240000
const A4_H = mmToUnit(297);    // 42768000

/** 属性 upsert：已存在则替换值，不存在则在开标签 > 前插入 attr="value" */
function upsertAttr(out, tagStart, tagEnd, attr, value, what) {
  const seg = out.slice(tagStart, tagEnd);
  const re = new RegExp(`(${attr}\\s*=\\s*["'])[^"']*(["'])`);
  if (re.test(seg)) return replaceAttr(out, tagStart, tagEnd, attr, value, what);
  const m = seg.match(/\/?\s*>$/);
  if (!m) throw new Error(`定位失败：${what} 开标签未闭合`);
  const insertAt = tagStart + seg.length - m[0].length;
  return out.slice(0, insertAt) + ` ${attr}="${value}"` + out.slice(insertAt);
}

// ---------------- 页眉页脚 ----------------
//
// 逆向依据（官方 1559 个 .cpt 样本实证）：
//   872/875 个样本在 ReportAttrSet 内写死这对空骨架（FR 设计器新建模板即带）：
//     <Header reportPageType="0"><Background name="NullBackground"/><LeftList/><CenterList/><RightList/></Header>
//     <Footer .../>（同构）
//   reportPageType 在全部样本中恒为 "0"，无其他取值。
//   带内容的样本只有 3 个，且元素类型唯一：
//     <HFElement className="com.fr.base.headerfooter.FormulaHFElement">
//       <FRFont name="SimSun" style="0" size="72"/>
//       <Formula content="&quot;第&quot; + $$page_number + &quot;页/共&quot; + $$totalPage_number + &quot;页&quot;"
//                text="第1页/共100页"/>
//     </HFElement>
//   页码变量（官方样本实证）：$$page_number / $$totalPage_number
//   Formula 的 content 是公式源码，text 是设计器预览文本（引擎无法求值，故留公式本身）。

/** 官方标配的空页眉页脚骨架 */
const EMPTY_HEADER_FOOTER = `<Header reportPageType="0">
<Background name="NullBackground"/>
<LeftList/>
<CenterList/>
<RightList/>
</Header>
<Footer reportPageType="0">
<Background name="NullBackground"/>
<LeftList/>
<CenterList/>
<RightList/>
</Footer>`;

/**
 * 模板主题（TemplateThemeAttrMark）—— 官方 301 个样本实测的全部取值。
 * 兼容主题(158) > 经典浅灰(61) > 兼容(49) > 清爽科技(24) > 经典深灰(9)
 */
export const TEMPLATE_THEMES = ['兼容主题', '经典浅灰', '兼容', '清爽科技', '经典深灰'];

const THEME_CLASS = 'com.fr.base.iofile.attr.TemplateThemeAttrMark';

/**
 * 设置模板主题（影响报表整体观感：配色、图表调色板等）。幂等：已存在则替换。
 *
 * 【为什么不暴露 dark 属性】
 *   官方 301 个样本的 dark 全是 "false"，没有一例为 true，
 *   按安全围栏原则不给无实证支撑的开关，固定写 dark="false"。
 *
 * @param {string} filePath
 * @param {string} theme 主题名，必须在 TEMPLATE_THEMES 内
 */
export function setTemplateTheme(filePath, theme) {
  if (!TEMPLATE_THEMES.includes(theme)) {
    throw new Error(
      `setTemplateTheme: 主题 "${theme}" 不存在。官方样本里只有这 ${TEMPLATE_THEMES.length} 种：${TEMPLATE_THEMES.join(' / ')}`
    );
  }
  const { raw } = load(filePath);
  let out = raw;

  const inner = `<TemplateThemeAttrMark name="${escapeXmlAttr(theme)}" dark="false"/>`;
  const wrapOpen = `<TemplateThemeAttrMark class="${THEME_CLASS}">`;
  const block = `${wrapOpen}\n${inner}\n</TemplateThemeAttrMark>`;

  const openIdx = out.indexOf(wrapOpen);
  if (openIdx >= 0) {
    // 已存在：整块替换（幂等，重复调用只改名字不会叠加）
    const [s, e] = blockRange(out, openIdx, wrapOpen, '</TemplateThemeAttrMark>');
    out = out.slice(0, s) + block + out.slice(e);
  } else {
    // 不存在：插在 <PreviewType .../> 之后（官方 271/301 例是这个位置）
    const anchor = out.indexOf('<PreviewType');
    if (anchor < 0) throw new Error('setTemplateTheme: 定位失败，模板里找不到 <PreviewType> 锚点');
    const end = out.indexOf('>', anchor) + 1;
    out = `${out.slice(0, end)}\n${block}${out.slice(end)}`;
  }

  save(filePath, out);
  return { action: 'set_template_theme', theme, bytes: Buffer.byteLength(out, 'utf8') };
}

const HF_SLOT_TAGS = { left: 'LeftList', center: 'CenterList', right: 'RightList' };

/**
 * 预设：模型不写公式也能拿到常用的页码。
 * formula = 公式源码；text = 设计器预览文本（对齐官方样本的 text="第1页/共100页" 口径）
 */
const HF_PRESETS = {
  // "第X页/共Y页"（公式与预览文本均取自官方样本 demo/basic/档案式报表.cpt 原文）
  pageNumber: {
    formula: '"第" + $$page_number + "页/共" + $$totalPage_number + "页"',
    text: '第1页/共100页',
  },
  // 简洁 "X / Y"
  pageNumberShort: {
    formula: '$$page_number + " / " + $$totalPage_number',
    text: '1 / 100',
  },
};

/**
 * 把一个槽位的内容规格归一化成 { content, text }（Formula 的两个属性）。
 * 支持 3 种写法（按模型直觉设计，避免逼模型去猜 FR 公式语法）：
 *   '纯文本'                    → 公式 "纯文本"
 *   { text: '纯文本' }          → 同上
 *   { formula: '...' }          → 原样使用（给需要变量/运算的场景）
 *   { preset: 'pageNumber' }    → 用内置预设
 * @param {string|object|null} spec
 * @param {string} slot 槽位名，用于报错定位
 */
function hfSlotToFormula(spec, slot) {
  if (spec == null || spec === '') return null;
  if (typeof spec === 'string') {
    return { content: `"${spec.replace(/"/g, '\\"')}"`, text: spec };
  }
  if (typeof spec !== 'object') {
    throw new Error(`页眉页脚 ${slot} 内容非法（${JSON.stringify(spec)}）：只支持字符串 / {text} / {formula} / {preset}`);
  }
  if (spec.preset) {
    const preset = HF_PRESETS[spec.preset];
    if (!preset) {
      throw new Error(`页眉页脚 ${slot} 的 preset="${spec.preset}" 不存在，可用：${Object.keys(HF_PRESETS).join(' / ')}`);
    }
    return { content: preset.formula, text: spec.text ?? preset.text };
  }
  if (spec.formula != null && spec.formula !== '') {
    return { content: String(spec.formula), text: String(spec.text ?? spec.formula) };
  }
  if (spec.text != null && spec.text !== '') {
    const t = String(spec.text);
    return { content: `"${t.replace(/"/g, '\\"')}"`, text: t };
  }
  return null;
}

/** 生成某个槽位的 XML（无内容则自闭合） */
function hfSlotXml(slot, spec, fontXml) {
  const tag = HF_SLOT_TAGS[slot];
  const f = hfSlotToFormula(spec, slot);
  if (!f) return `<${tag}/>`;
  return `<${tag}>
<HFElement className="com.fr.base.headerfooter.FormulaHFElement">
${fontXml}
<Formula content="${escapeXmlAttr(f.content)}" text="${escapeXmlAttr(f.text)}"/>
</HFElement>
</${tag}>`;
}

/** 生成完整的 <Header> 或 <Footer> 块 */
function hfBlockXml(tag, spec, fontXml) {
  const slots = spec == null ? {} : spec;
  if (typeof slots !== 'object') {
    throw new Error(`页眉页脚 ${tag} 参数非法：应为 { left?, center?, right? } 对象`);
  }
  for (const k of Object.keys(slots)) {
    if (!HF_SLOT_TAGS[k]) {
      throw new Error(`页眉页脚 ${tag}.${k} 不存在：槽位只能是 ${Object.keys(HF_SLOT_TAGS).join(' / ')}`);
    }
  }
  return `<${tag} reportPageType="0">
<Background name="NullBackground"/>
${hfSlotXml('left', slots.left, fontXml)}
${hfSlotXml('center', slots.center, fontXml)}
${hfSlotXml('right', slots.right, fontXml)}
</${tag}>`;
}

/**
 * 设置页眉 / 页脚。
 * @param {string} filePath
 * @param {object} opts
 * @param {object} [opts.header] {left?,center?,right?}；不传则不动页眉
 * @param {object} [opts.footer] 同上
 * @param {number} [opts.fontSizePt=9] 页眉页脚字号（pt）
 * @param {string} [opts.fontName='微软雅黑']
 * @param {number|null} [opts.sheet] 工作表索引，null=第 1 个
 */
export function setPageHeaderFooter(filePath, opts = {}) {
  const { header, footer, fontSizePt = 9, fontName = '微软雅黑' } = opts;
  if (header === undefined && footer === undefined) {
    throw new Error('set_page_header_footer 至少需要给 header 或 footer 之一（都不给则无操作）');
  }
  const pt = Number(fontSizePt);
  if (!Number.isFinite(pt) || pt <= 0 || pt > 72) {
    throw new Error(`页眉页脚字号非法 (${fontSizePt}pt)：须为 0~72 之间的数字`);
  }
  // FRFont size = pt × 4（与单元格一致的口径）
  const fontXml = `<FRFont name="${escapeXmlAttr(fontName)}" style="0" size="${Math.round(pt * 4)}"/>`;

  const { raw } = load(filePath);
  let out = raw;

  // 定位目标 ReportAttrSet：优先按工作表索引，退化到第 1 个
  const attrStarts = findAll(out, '<ReportAttrSet>');
  if (attrStarts.length === 0) throw new Error('定位失败：文档中无 <ReportAttrSet>，请先 create_cpt 生成骨架');
  const occ = opts.sheet == null ? 0 : locateSheet(raw, opts.sheet).index;
  if (occ >= attrStarts.length) {
    throw new Error(`工作表索引 ${occ} 越界：仅 ${attrStarts.length} 个 ReportAttrSet`);
  }
  const [aStart, aEnd] = blockRange(out, attrStarts[occ], '<ReportAttrSet>', '</ReportAttrSet>');

  /** 在 ReportAttrSet 内替换或插入 Header/Footer 块 */
  const apply = (tag, spec) => {
    if (spec === undefined) return; // 未传 = 保持原样
    const block = hfBlockXml(tag, spec, fontXml);
    // 每次改动后重新定位（插入会改变偏移）
    const s2 = findAll(out, '<ReportAttrSet>')[occ];
    const [bs, be] = blockRange(out, s2, '<ReportAttrSet>', '</ReportAttrSet>');
    const seg = out.slice(bs, be);
    const openHits = findAll(seg, `<${tag}`);
    if (openHits.length > 0) {
      // 已有该块：整块替换（含自闭合 <Header/> 形态）
      const [hs, he] = blockRange(seg, openHits[0], `<${tag}`, `</${tag}>`);
      out = out.slice(0, bs + hs) + block + out.slice(bs + he);
    } else {
      // 没有：插到 </ReportSettings> 之后；再退化到 </ReportAttrSet> 之前
      const rs = findAll(seg, '</ReportSettings>');
      const at = rs.length > 0 ? rs[0] + '</ReportSettings>'.length : seg.lastIndexOf('</ReportAttrSet>');
      if (at < 0) throw new Error(`定位失败：${tag} 无处可插`);
      out = out.slice(0, bs + at) + '\n' + block + out.slice(bs + at);
    }
  };

  apply('Header', header);
  apply('Footer', footer);

  save(filePath, out);
  return {
    action: 'set_page_header_footer',
    header: header === undefined ? '未改动' : Object.keys(header ?? {}).filter((k) => header[k] != null),
    footer: footer === undefined ? '未改动' : Object.keys(footer ?? {}).filter((k) => footer[k] != null),
    fontSizePt: pt,
    bytes: Buffer.byteLength(out, 'utf8'),
  };
}

// ---------------- create_cpt：从零生成最小合法骨架 ----------------

/**
 * 生成最小合法 WorkBook 骨架（结构对照「sample-fill.cpt」极简版）：
 * TableDataMap(空) / ReportWebAttr(可选) / Report(空工作表+样式引用) / StyleList / 扩展标记
 */
export function createCpt(filePath, {
  title, rows = 3, columns = 4, withWebAttr = true, webWrite = false,
  xmlVersion = '20211223', releaseVersion = '11.5.0', sheetName = 'sheet1',
} = {}) {
  const abs = path.resolve(filePath);
  if (fs.existsSync(abs)) throw new Error(`文件已存在，拒绝覆盖: ${abs}`);
  const base = path.basename(abs, '.cpt');
  const t = title != null ? assertSafeCdata(title, '报表标题') : base;

  const rowHeights = Array.from({ length: rows }, () => DEF_ROW_H).join(',');
  const colWidths = Array.from({ length: columns }, () => DEF_COL_W).join(',');

  const webAttr = withWebAttr ? `<ReportWebAttr>
<Title>
<![CDATA[${t}]]></Title>
<ServerPrinter/>
<WebPageContent>
<ToolBars/>
<WebPage isPage="false" showAsImage="false" autoScale="false" tdHeavy="false"/>
</WebPageContent>
${webWrite ? `<WebWriteContent>
<ToolBars/>
<EditRowColor setColor="false"/>
<WebWrite SheetPosition="3"/>
<RptLocation isShowAtLeft="true"/>
<UnloadCheck/>
<ShowWidgets/>
<OtherAttr autoStash="false"/>
</WebWriteContent>` : ''}
</ReportWebAttr>
` : '';

  // P1 修复：11.5 模板补 <ElementCaseMobileAttr>（移动端/HTML5 适配），10.x 模板跳过
  const mobileAttr = String(xmlVersion) === '20211223'
    ? `<ElementCaseMobileAttr>
<ElementCaseMobileAttrProvider horizontal="1" vertical="1" zoom="true" refresh="false" isUseHTML="false" isMobileCanvasSize="false" appearRefresh="false" allowFullScreen="false"/>
</ElementCaseMobileAttr>
`
    : '';

  const xml = `${'<?xml version="1.0" encoding="UTF-8"?>\n'}
<WorkBook xmlVersion="${escapeXmlAttr(xmlVersion)}" releaseVersion="${escapeXmlAttr(releaseVersion)}">
<TableDataMap>
</TableDataMap>
${webAttr}${mobileAttr}<Report class="com.fr.report.worksheet.WorkSheet" name="${escapeXmlAttr(sheetName)}">
<ReportPageAttr>
<HR/>
<FR/>
<HC/>
<FC/>
<UPFCR COLUMN="false" ROW="true"/>
</ReportPageAttr>
<ColumnPrivilegeControl/>
<RowPrivilegeControl/>
<RowHeight defaultValue="${DEF_ROW_H}">
<![CDATA[${rowHeights}]]></RowHeight>
<ColumnWidth defaultValue="${DEF_COL_W}">
<![CDATA[${colWidths}]]></ColumnWidth>
<CellElementList>
</CellElementList>
<ReportAttrSet>
<ReportSettings shrinkToFitMode="0" headerHeight="0" footerHeight="0">
<PaperSetting/>
<FollowingTheme background="false"/>
</ReportSettings>
${EMPTY_HEADER_FOOTER}
</ReportAttrSet>
</Report>
<StyleList>
<Style horizontal_alignment="0" imageLayout="1">
<FRFont name="微软雅黑" style="0" size="72"/>
<Background name="NullBackground"/>
<Border/>
</Style>
</StyleList>
<DesignerVersion DesignerVersion="LAA"/>
<PreviewType PreviewType="0"/>
</WorkBook>
`;
  save(abs, xml);
  return {
    action: 'create_cpt', file: abs, bytes: Buffer.byteLength(xml, 'utf8'),
    rows, columns, styleList: 1, note: '骨架已生成：空数据集区、空工作表（含默认样式0）、默认纸张A4纵向',
  };
}

/** 数据集名校验（所有数据集类型共用） */
function assertDatasetName(name) {
  if (!/^[A-Za-z_][\w]*$/.test(String(name || ''))) {
    throw new Error(`数据集名 "${name}" 非法：须为字母/下划线开头，仅含字母数字下划线`);
  }
}

/** 把 <TableData> 块插进 TableDataMap（所有数据集类型共用） */
function insertTableData(filePath, name, block) {
  const { raw, parsed } = load(filePath);
  const tdm = parsed.WorkBook?.TableDataMap;
  const existing = tdm?.TableData ? (Array.isArray(tdm.TableData) ? tdm.TableData : [tdm.TableData]) : [];
  if (existing.some((d) => d['@_name'] === name)) throw new Error(`数据集 ${name} 已存在`);
  // M45 防御: 兼容多种 TableDataMap 形式（详见下方注释）
  // 1) </TableDataMap>                       标准开闭（FR 10.x 老格式 / cpt-mcp createCpt 输出）
  // 2) <TableDataMap/>                       自闭合（FR 11.5 新格式）
  // 3) <TableDataMap attr="..."/>            带属性自闭合
  // 策略: 优先找标准闭合, 没有再找自闭合
  let anchor = '</TableDataMap>';
  if (!raw.includes(anchor)) {
    const m = raw.match(/<TableDataMap\b(?:\s[^>]*)?\/>/);
    if (!m) throw new Error('定位失败：未找到 </TableDataMap> 或 <TableDataMap .../>');
    const attrs = (m[0].match(/<TableDataMap([^>]*?)\/>/)?.[1] ?? '').trim();
    // 函数式替换：attrs 取自**文件内容**（原自闭合标签的属性），字符串式会把其中的 $$/$&/$' 当特殊序列
    const out2 = raw.replace(m[0], () => `<TableDataMap${attrs ? ' ' + attrs : ''}>\n${block}</TableDataMap>`);
    save(filePath, out2);
    return out2;
  }
  const out = insertBefore(raw, anchor, block, '</TableDataMap>');
  save(filePath, out);
  return out;
}

// ---------------- add_dataset：添加 SQL 数据集 ----------------

/** 在 TableDataMap 下新增 SQL 数据集（结构对照真实样本：Parameters/Attributes/Connection/Query/PageQuery） */
export function addDataset(filePath, { name, connection, sql, parameters = [], embedded } = {}) {
  //
  // 【为什么不支持内置数据集（EmbeddedTableData）】
  //   官方 326 个内置数据集的 <RowData> 全是 FR 私有压缩编码（形如 FctKS_E\ZeYN`rdSNZW7G...），
  //   既不是 base64 也不是明文，编码方式无法在"不反编译商业 jar"的合规边界内还原。
  //   ColumnNames 用 ",,.,," 分隔、ColumnTypes 写 java.lang.String 这类是可以还原的，
  //   但真正承载数据的 RowData 还原不了 —— 盲写只会产出设计器打不开的模板。
  //   所以这里明确拒绝（而不是静默忽略），并给出三条可行替代方案。
  if (embedded) {
    throw new Error(
      'add_dataset: 不支持内置数据集（EmbeddedTableData）。\n' +
      '原因：官方样本的 <RowData> 是 FR 私有压缩编码，无法在不反编译商业 jar 的前提下还原，\n' +
      '      写出来的模板设计器会打不开。\n' +
      '替代方案（三选一）：\n' +
      '  1. 照常用 SQL 数据集：connection + sql，预览时连真实库取数；\n' +
      '  2. 用带参数的 SQL 数据集 + add_parameter 给默认值，便于本地调预览；\n' +
      '  3. 只想验证版式：先按 SQL 数据集生成，数据行留空，用 add_cell 塞静态文字做示意。'
    );
  }
  assertDatasetName(name);
  if (!connection || !String(connection).trim()) throw new Error(`数据集 ${name} 缺 connection：必须提供数据连接名（如 Doris/MySQL/填报-读写），空连接将导致预览失败`);
  if (!sql || !String(sql).trim()) throw new Error(`数据集 ${name} 缺 sql：必须提供 SQL 语句`);
  const safeName = escapeXmlAttr(name);
  // connection 写入 <DatabaseName> 的 CDATA：CDATA 是字面量区，不能 escapeXmlAttr（JDBC URL 含 & 会双重转义），只需防 ]]> 闭合
  const safeConn = assertSafeCdata(connection || '', `数据集 ${name} 连接名`);
  const safeSql = assertSafeCdata(sql || '', `数据集 ${name} SQL`);

  // M110：参数值交给 parameterXml —— "=" 开头写官方公式参数形态（可绑单元格，如 =A5，用于下拉联动过滤），
  // 否则字面量（与旧行为逐字节一致）
  const paramsXml = parameters.map((p) => parameterXml(p.name, p.defaultValue)).join('\n');

  const block = `<TableData name="${safeName}" class="com.fr.data.impl.DBTableData">
<Parameters>
${paramsXml || ''}</Parameters>
<Attributes maxMemRowCount="-1"/>
<Connection class="com.fr.data.impl.NameDatabaseConnection">
<DatabaseName>
<![CDATA[${safeConn}]]></DatabaseName>
</Connection>
<Query>
<![CDATA[${safeSql}]]></Query>
<PageQuery>
<![CDATA[]]></PageQuery>
</TableData>
`;
  const out = insertTableData(filePath, name, block);
  return { action: 'add_dataset', name, connection, parameters: parameters.map((p) => p.name), bytes: Buffer.byteLength(out, 'utf8') };
}

// ---------------- add_file_dataset：Excel 文件数据集 ----------------

//
// 【为什么只支持 Excel，不支持 CSV/文本/XML】
//   官方 1559 个样本 + FR 11.0 整个安装目录里，文件数据集只有 ExcelTableData 有现成实例（3 例，形态完全一致）：
//     <TableData name="File1" class="com.fr.data.impl.ExcelTableData">
//     <ExcelTableDataAttr needColumnName="true" isFromEnv="true" filePath="reportlets/jsc/铜山/2.xls"/>
//     <Parameters/>
//     </TableData>
//   TextTableData（CSV/文本）和 XMLTableData 一个现成实例都没有。javap 能看到它们有
//   delimiter/charset/xmlKeyPoint 等 setter，但 XML 元素名只能靠猜——
//   猜错就是设计器打不开的模板。所以先只开放有实证的 Excel，其余明确拒绝并引导转换。
//
//   filePath 两种口径（FileTableData.FILE_PROTOCOL = "file:"）：
//     isFromEnv=true  → 相对 %FR_HOME%/webapps/webroot，如 reportlets/jsc/铜山/2.xls
//     isFromEnv=false → 绝对路径，可带 file: 前缀
//
export function addFileDataset(filePath, { name, dataFile, needColumnName = true, fromEnv = true } = {}) {
  assertDatasetName(name);
  if (!dataFile || !String(dataFile).trim()) {
    throw new Error(`数据集 ${name} 缺 dataFile：必须给出 Excel 文件路径`);
  }
  const p = String(dataFile).trim();
  const ext = path.extname(p).toLowerCase();
  if (!['.xls', '.xlsx'].includes(ext)) {
    throw new Error(
      `add_file_dataset: 只支持 Excel 文件（.xls / .xlsx），当前为 "${ext || '无扩展名'}"。\n` +
      '原因：官方 1559 个样本与 FR 11.0 安装目录里，只有 ExcelTableData 有现成实例，\n' +
      '      CSV/文本（TextTableData）与 XML（XMLTableData）一个实例都没有，XML 元素名只能靠猜，\n' +
      '      猜错就是设计器打不开的模板，所以暂不开放。\n' +
      '替代方案（三选一）：\n' +
      '  1. 用 Excel 把 CSV 另存为 .xlsx，再走本工具；\n' +
      '  2. 数据本来就在库里 → 用 add_dataset（SQL 数据集）；\n' +
      '  3. 只想验证版式 → 先按 SQL 数据集生成，数据行留空，用 add_cell 塞静态文字示意。'
    );
  }
  // 路径围栏：写进模板的路径会被设计器拿去直接读文件，必须挡住穿越与不一致的组合
  // （段级判断：「报表..xls」是合法文件名；「..」作为整段才是穿越 —— 与 security.js assertDataFilePath 同口径）
  if (p.split(/[\\/]+/).includes('..')) {
    throw new Error(`dataFile 不允许包含 ".." 路径段（路径穿越）：${p}`);
  }
  if (fromEnv) {
    if (/^[A-Za-z]:[\\/]/.test(p) || p.startsWith('\\\\') || p.startsWith('/') || p.startsWith('file:')) {
      throw new Error(`dataFile "${p}" 是绝对路径，但 fromEnv=true 要求相对 %FR_HOME%/webapps/webroot 的路径。\n若确实要用绝对路径，请传 fromEnv=false。`);
    }
  } else if (!(/^[A-Za-z]:[\\/]/.test(p) || p.startsWith('\\\\') || p.startsWith('/') || p.startsWith('file:'))) {
    throw new Error(`dataFile "${p}" 不是绝对路径，但 fromEnv=false 要求绝对路径（或 file: 前缀）。\n若想用相对 %FR_HOME%/webapps/webroot 的路径，请传 fromEnv=true。`);
  }

  const safeName = escapeXmlAttr(name);
  const safePath = escapeXmlAttr(p);
  const block = `<TableData name="${safeName}" class="com.fr.data.impl.ExcelTableData">
<ExcelTableDataAttr needColumnName="${needColumnName ? 'true' : 'false'}" isFromEnv="${fromEnv ? 'true' : 'false'}" filePath="${safePath}"/>
<Parameters/>
</TableData>
`;
  const out = insertTableData(filePath, name, block);
  return {
    action: 'add_file_dataset', name, dataFile: p,
    needColumnName: !!needColumnName, fromEnv: !!fromEnv, bytes: Buffer.byteLength(out, 'utf8'),
    note: '列即 Excel 表的列；needColumnName=true 表示首行是列名',
  };
}

// ---------------- add_tree_dataset：树数据集（组织架构 / 地区层级 / BOM 展开） ----------------

//
// 【实证：官方 19 个 RecursionTableData 样本】
//   markFields            19/19 必填 —— 子节点字段的「列序号」（取值见 0(17) / 1(1) / 2(1)）
//   originalTableDataName 19/19 必填 —— 源数据集名
//   parentmarkFields      14/19 可选 —— 父节点字段的列序号（取值 1(12) / 2(1) / 3(1)）
//   markFieldsName         7/19 可选 —— 子节点字段名，出现时必定与 markFields 同时出现
//   parentmarkFieldsName   7/19 可选 —— 父节点字段名，同上
//   separator / limitGeneration 0/19 —— 官方样本一次都没用过，所以不暴露这两个参数
//   元素顺序固定：markFields → parentmarkFields → markFieldsName → parentmarkFieldsName → originalTableDataName
//
// 【为什么列序号必填、字段名可选】
//   19/19 的样本都写了列序号，而 0 个样本「只写字段名不写序号」——
//   只给字段名的话，序号无从推导，会产出没验证过的形态，所以字段名只作为附加信息。
//
export function addTreeDataset(filePath, {
  name, source, childField, childFieldName, parentField, parentFieldName,
} = {}) {
  assertDatasetName(name);
  if (!source || !String(source).trim()) {
    throw new Error(`数据集 ${name} 缺 source：树数据集是在另一个数据集之上构建层级，必须给出源数据集名（先用 add_dataset 建好）`);
  }
  // V1: 源数据集引用完整性 —— 与 DSColumn/图表同口径，悬空引用到预览时才报错
  {
    const { parsed: treeParsed } = load(filePath);
    assertDatasetExists(treeParsed, source, '树数据集源');
  }
  const childIdx = Number(childField);
  if (!Number.isInteger(childIdx) || childIdx < 0) {
    throw new Error(`childField 必须是源数据集里的列序号（0 起，如 0 表示第 1 列），当前为 ${JSON.stringify(childField)}`);
  }
  if (parentField != null && parentField !== '') {
    const pi = Number(parentField);
    if (!Number.isInteger(pi) || pi < 0) {
      throw new Error(`parentField 必须是列序号（0 起），当前为 ${JSON.stringify(parentField)}`);
    }
    if (pi === childIdx) throw new Error(`parentField 与 childField 不能是同一列（都是 ${pi}），那样每个节点都是自己的父亲`);
  }
  // 给了父字段名却没给父列序号 —— 这是会静默产出未验证形态的典型输入
  if (parentFieldName && (parentField == null || parentField === '')) {
    throw new Error(`写了 parentFieldName（${parentFieldName}）却没写 parentField：官方 19 例里字段名总是和列序号成对出现，请同时给出 parentField`);
  }

  const cd = (v, what) => assertSafeCdata(String(v), what);
  const idx = (tag, v) => `<${tag}>
<![CDATA[${cd(v, tag)}]]></${tag}>`;
  const parts = [idx('markFields', childIdx)];
  if (parentField != null && parentField !== '') parts.push(idx('parentmarkFields', Number(parentField)));
  if (childFieldName) parts.push(idx('markFieldsName', childFieldName));
  if (parentFieldName) parts.push(idx('parentmarkFieldsName', parentFieldName));
  parts.push(idx('originalTableDataName', source));

  const block = `<TableData name="${escapeXmlAttr(name)}" class="com.fr.data.impl.RecursionTableData">
${parts.join('\n')}
</TableData>
`;
  const out = insertTableData(filePath, name, block);
  return {
    action: 'add_tree_dataset', name, source,
    childField: childIdx,
    parentField: (parentField == null || parentField === '') ? null : Number(parentField),
    bytes: Buffer.byteLength(out, 'utf8'),
    note: '把该数据集的列拖到单元格并设纵向扩展，即可按层级展开',
  };
}

// ---------------- add_style：新增样式（返回索引） ----------------

function bgXml(backgroundColor) {
  if (backgroundColor == null) return '<Background name="NullBackground"/>';
  const argb = hexToArgb(backgroundColor);
  return `<Background name="ColorBackground">
<color>
<FineColor color="${argb}" hor="-1" ver="-1"/>
</color>
</Background>`;
}

/** 数字/日期格式：<Format class="..." [roundingMode]>[<pattern>]</Format>；class 缺省 TextFormat */
function styleFormatXml(format) {
  if (!format || typeof format !== 'object') return '';
  const cls = escapeXmlAttr(format.class || 'com.fr.base.TextFormat');
  const rm = format.roundingMode != null ? ` roundingMode="${escapeXmlAttr(String(format.roundingMode))}"` : '';
  if (format.pattern == null) return `<Format class="${cls}"${rm}/>`;
  return `<Format class="${cls}"${rm}>
<pattern>
<![CDATA[${assertSafeCdata(String(format.pattern), '格式 pattern')}]]></pattern>
</Format>`;
}

/** 在 StyleList 末尾新增样式，返回其索引（单元格 s 属性直接用该值） */
/** 生成 <Border> 块：四边（top/bottom/left/right）+ 表头外框/内线（outerTop/innerHorizontal）；每边 {style,color?} */
function styleBorderXml(border) {
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

export function addStyle(filePath, {
  fontName = '微软雅黑', fontSizePt = 14, bold = false, italic = false,
  backgroundColor, foregroundColor, horizontalAlignment,
  underline = false, strikethrough = false, verticalAlignment,
  border, textStyle, paddingLeft, paddingRight, lineSpacing, rotation, format,
} = {}) {
  const size = Math.round(Number(fontSizePt) * 4);
  if (!(Number(fontSizePt) >= 6 && Number(fontSizePt) <= 200)) throw new Error(`字号 ${fontSizePt}pt 超出范围（6-200）`);
  // P0-2 安全围栏 + 归一化：
  //  ① 对齐取值必须是官方样本中出现过的合法值（水平 0/2/4/6、垂直 0/1/3），传 1/3/5 在写入前拦截并引导
  //  ② 字符串别名（'center'/'left'/…）归一化为数字，避免旧版写出 horizontal_alignment="center" 这种非法 XML 值
  const hAlign = assertHorizontalAlignment(horizontalAlignment);
  const vAlign = assertVerticalAlignment(verticalAlignment);
  // 加粗/斜体用 java.awt.Font 的 style 位（官方：1=加粗,2=斜体）；下划线/删除线为独立属性（官方序列化方式）
  let styleBits = 0;
  if (bold) styleBits |= 1;         // 加粗
  if (italic) styleBits |= 2;       // 斜体
  const underlineAttr = underline ? ' underline="1"' : '';          // 官方：underline="N"（仅非 0 写）
  const strikeAttr = strikethrough ? ' isStrikethrough="true"' : ''; // 官方：isStrikethrough="true"
  // 未指定时默认水平居中（0=居中，与 sandbox2 成品模板一致）；显式指定时用归一化后的合法值
  const alignVal = hAlign != null ? String(hAlign) : '0';
  let styleAttrs = ` horizontal_alignment="${escapeXmlAttr(alignVal)}"`;
  const numAttr = (k, v) => v != null ? ` ${k}="${escapeXmlAttr(String(v))}"` : '';
  styleAttrs += numAttr('vertical_alignment', vAlign != null ? vAlign : verticalAlignment);
  styleAttrs += numAttr('textStyle', textStyle);
  styleAttrs += numAttr('paddingLeft', paddingLeft);
  styleAttrs += numAttr('paddingRight', paddingRight);
  styleAttrs += numAttr('lineSpacing', lineSpacing);
  styleAttrs += numAttr('rotation', rotation);

  let fontXml;
  if (foregroundColor != null) {
    const argb = hexToArgb(foregroundColor);
    fontXml = `<FRFont name="${escapeXmlAttr(fontName)}" style="${styleBits}" size="${size}"${underlineAttr}${strikeAttr}>
<foreground>
<FineColor color="${argb}" hor="-1" ver="-1"/>
</foreground>
</FRFont>`;
  } else {
    fontXml = `<FRFont name="${escapeXmlAttr(fontName)}" style="${styleBits}" size="${size}"${underlineAttr}${strikeAttr}/>`;
  }
  const style = `<Style${styleAttrs} imageLayout="1">
${fontXml}
${bgXml(backgroundColor)}
${styleBorderXml(border)}
${styleFormatXml(format)}
</Style>
`;
  const { raw } = load(filePath);
  const anchor = '</StyleList>';
  if (!raw.includes(anchor)) throw new Error('定位失败：未找到 </StyleList>');
  // 单元格 s 只索引 StyleList；图表等区域也有 <Style>，不能全局计数。
  // FR 11 官方模板还允许无属性的 <Style>，故也不能只匹配 "<Style "。
  const idx = styleBlocks(raw).blocks.length;
  const out = insertBefore(raw, anchor, style, '</StyleList>');
  save(filePath, out);
  return {
    action: 'add_style', styleIndex: idx, fontName, fontSizePt, bold, italic,
    underline, strikethrough, backgroundColor, foregroundColor, verticalAlignment,
    border, textStyle, paddingLeft, paddingRight, lineSpacing, rotation,
  };
}

// ---------------- add_cell：新增单元格 ----------------

/**
 * 单元格内容块（文本 / DSColumn / 公式），结构对照真实样本。
 *
 * 【result 参数 = 官方 <Result> 元素：字段的"显示值变换"】
 *   官方 5517 个 DSColumn 单元格里只有 479 个带 <Result>（8.7%），且其中 364 个是恒等的 $$$，
 *   所以**它不是必填** —— 不写与 91.3% 的官方样本一致，以前不写是对的。
 *   但它承载的是真正的"字段逻辑"：
 *     `$$$/10000`                    元 → 万元
 *     `ROUND($$$,0)`                 取整
 *     `货主城市+$$$`                  与别的字段拼接
 *     `$$$ + "( 分机号：" + 分机 + ")"`  串成一句话
 *   元素位置（官方实测，顺序固定）：
 *     Attributes > [Condition] > Complex > RG > **Result** > Parameters > [cellSortAttr]
 */
/**
 * 单元格排序块（官方 <cellSortAttr>）——「扩展后排序 / 高级排序」
 *
 * 【逆向依据】FR 11.0 官方 1559 份模板实测：
 *   - <cellSortAttr> 共 105 处，**105/105 都挂在 DSColumn 单元格上**，且 **105/105 位于 <Parameters/> 之后**
 *     ⇒ 官方元素顺序：Attributes > [Condition] > Complex > RG > [Result] > Parameters > [cellSortAttr]
 *   - 三种形态：空标签 <cellSortAttr/> 76 处、空壳 <cellSortAttr><sortExpressions/></cellSortAttr> 21 处、
 *     真带排序表达式的只有 8 处（共 9 条 <cellSortExpression>）
 *   - <cellSortExpression> 只有两个属性：sortRule（方向）与 sortArea（按哪一列排）
 *   - **sortArea 9/9 都指向「别的列」** —— 这就是 FR 的「高级排序」：
 *     排序属性挂在扩展列上，却按另一列的值排序（例：订单ID 单元格上写 sortArea="运货费"）
 *   - 多列排序 = 一个 <sortExpressions> 里按顺序放多条 <cellSortExpression>（官方最多 2 条）
 *   - sortRule 两套口径并存，且与枚举一一对应（全安装目录 29 处取值，两边数量吻合）：
 *         0 / 不排序 → SortRule.NO_SORT
 *         1 / 升序   → SortRule.ASC
 *         2 / 降序   → SortRule.DESC
 *     （javap -p -constants 确认 SortRule 是 enum，且同时提供 parse(int) 与 parse(String)，两种写法都能读回）
 *     ⇒ 本实现**发中文**：中文形式出自 FR 自带的官方教学模板（doc/SpecialSubject/OrderReport/
 *       单列扩展后排序.cpt、多列高级排序.cpt），与本安装同版本，且人读 XML 时一眼看懂方向。
 *
 * @param {Array<{area:string, direction:'asc'|'desc'}>} sorts
 * @returns {string} 空数组返回 ''（不给就不写，对齐官方 92% 的样本）
 */
function sortXml(sorts) {
  if (!sorts || sorts.length === 0) return '';
  if (!Array.isArray(sorts)) throw new Error('sort（扩展后排序）必须是数组，例：[{ area: "销售额", direction: "desc" }]');
  if (sorts.length > 8) {
    throw new Error(`sort 最多 8 条排序键（当前 ${sorts.length} 条）；官方样本最多 2 条，超出的排序在帆软里也不会更可读`);
  }
  const DIR = { asc: '升序', desc: '降序' };
  const exprs = sorts.map((s, i) => {
    if (!s || typeof s !== 'object') throw new Error(`sort[${i}] 必须是 { area, direction } 对象`);
    const area = String(s.area ?? '').trim();
    const dir = String(s.direction ?? '').trim();
    if (!area) throw new Error(`sort[${i}].area（按哪一列排序）不能为空`);
    if (!DIR[dir]) {
      throw new Error(`sort[${i}].direction 只能是 "asc"（升序）或 "desc"（降序），当前为 "${dir}"`);
    }
    return `<cellSortExpression sortRule="${DIR[dir]}" sortArea="${escapeXmlAttr(area)}"/>`;
  });
  return `<cellSortAttr>
<sortExpressions>
${exprs.join('\n')}
</sortExpressions>
</cellSortAttr>
`;
}

/**
 * contentXml（M76 新增 summary 形参）。
 * summary 仅对 dsColumn 有意义：
 *   缺省/空 = 分组形态（自闭合 FunctionGrouper，与改动前逐字节一致，零回归）；
 *   传入 5 键白名单值（sum/avg/count/max/min）= 官方 GettingStarted.cpt 的汇总形态
 *   （RG 非自闭合 SummaryGrouper + FN CDATA 聚合类名）。
 * 非 dsColumn 传 summary 是臆造形态（官方汇总全部挂在 DSColumn 上），直接拒绝。
 */
function contentXml(contentType, content, dsName, columnName, result, sort, ci, summary) {
  if (summary != null && summary !== '' && contentType !== 'dsColumn') {
    throw new Error(`summary（DSColumn 汇总方式）只能用于 contentType="dsColumn" 的数据集列；当前 contentType="${contentType}"`);
  }
  if (contentType === 'dsColumn') {
    // 动态列形态（官方 doc/Parameter/DynamicCol 实证）：columnName 可由列序号 ci 替代
    const colAttr = columnName != null && columnName !== ''
      ? ` columnName="${escapeXmlAttr(columnName)}"`
      : (ci != null && ci !== '' ? ` ci="${Number(ci)}"` : null);
    if (!dsName || !colAttr) {
      throw new Error('DSColumn 单元格必须提供 dsName 与 columnName（动态列形态可用 ci 列序号替代 columnName）');
    }
    let resultXml = '';
    if (result != null && String(result).trim() !== '') {
      if (typeof result !== 'string') {
        throw new Error(`result（显示值公式）必须是字符串，当前为 ${typeof result}。例："$$$/10000"`);
      }
      resultXml = `<Result>\n<![CDATA[${assertSafeCdata(result.trim(), '显示值公式')}]]></Result>\n`;
    }
    // RG 块：缺省 = FunctionGrouper（自闭合，官方主流）；传 summary = SummaryGrouper（官方 GettingStarted.cpt 汇总形态）
    const rgXml = dsColumnRGXml(summary);
    return `<O t="DSColumn">
<Attributes dsName="${escapeXmlAttr(dsName)}"${colAttr}/>
<Complex/>
${rgXml}
${resultXml}<Parameters/>
${sortXml(sort)}</O>`;
  }
  if (contentType === 'formula') {
    // 2026-10-29 修：官方公式对象形态（411 份官方样本实证）。
    // 此前写成普通 <O> CDATA（= 开头文本），设计器/FR 不把它当公式计算，形同文本。
    return formulaObjectXml(content, '单元格公式');
  }
  const safe = assertSafeCdata(content ?? '', '单元格内容');
  // 普通文本单元格（设计器约定：公式必须是 <O t="XMLable" class="com.fr.base.Formula"> 对象）
  return `<O>
<![CDATA[${safe}]]></O>`;
}

/** 控件块（结构对照真实样本：sample-fill.cpt 的 TextEditor / Submit / AppendColumnRow）
 *  opts: { widgetClass, pluginID, pluginVersion, content } —— custom 控件 class 透传 / label 文本 */
function widgetXml(widget, items, opts = {}) {
  // M82: disabled=true → 设计器禁用态形态（<WidgetAttr disabled="true" …>，通知排产表.cpt 等 30 处实证）
  const dis = opts.disabled === true || String(opts.disabled).toLowerCase() === 'true' ? ' disabled="true"' : '';
  const wattr = `<WidgetAttr${dis} aspectRatioLocked="false" aspectRatioBackup="-1.0" description="">
<MobileBookMark useBookMark="false" bookMarkName="" frozen="false" index="-1" oldWidgetName=""/>
<PrivilegeControl/>
</WidgetAttr>`;
  const text = (v) => `<Text>
<![CDATA[${v}]]></Text>`;
  switch (widget) {
    case 'text':
      return `<Widget class="com.fr.form.ui.TextEditor">
${wattr}
<TextAttr/>
<Reg class="com.fr.form.ui.reg.NoneReg"/>
<widgetValue>
<O>
<![CDATA[]]></O>
</widgetValue>
</Widget>`;
    case 'number':
      return `<Widget class="com.fr.form.ui.NumberEditor">
${wattr}
<TextAttr/>
<Reg class="com.fr.form.ui.reg.NoneReg"/>
<widgetValue>
<O>
<![CDATA[]]></O>
</widgetValue>
</Widget>`;
    case 'textarea':
      return `<Widget class="com.fr.form.ui.TextArea">
${wattr}
<TextAttr/>
<Reg class="com.fr.form.ui.reg.NoneReg"/>
<widgetValue>
<O>
<![CDATA[]]></O>
</widgetValue>
</Widget>`;
    case 'date':
      return `<Widget class="com.fr.form.ui.DateEditor">
${wattr}
<DateAttr/>
<widgetValue>
<O>
<![CDATA[]]></O>
</widgetValue>
</Widget>`;
    case 'comboBox': {
      // M109：给了 widgetDictionary → 写数据集/数据库表字典（官方单元格侧 TableDataDictionary 85 例 /
      // DatabaseDictionary 259 例实证 —— "单元格配置下拉单选控件后可以绑定数据集"本就是官方能力）；
      // 不给则维持原 CustomDictionary 逐字节输出（golden 不受影响）。
      const dict = opts.dictionary
        ? dictionaryXml({ dictionary: opts.dictionary, items, label: `单元格控件 ${widget}` })
        : (items && items.length
          ? `<Dictionary class="com.fr.data.impl.CustomDictionary">
<CustomDictAttr>
${items.map((it) => `<Dict key="${escapeXmlAttr(String(it.key ?? it.value))}" value="${escapeXmlAttr(String(it.value ?? it.key))}"/>`).join('\n')}
</CustomDictAttr>
</Dictionary>`
          : '<Dictionary class="com.fr.data.impl.CustomDictionary">\n<CustomDictAttr>\n</CustomDictAttr>\n</Dictionary>');
      return `<Widget class="com.fr.form.ui.ComboBox">
${wattr}
${dict}
<widgetValue>
<O>
<![CDATA[]]></O>
</widgetValue>
</Widget>`;
    }
    case 'checkBox':
      return `<Widget class="com.fr.form.ui.CheckBox">
${wattr}
<TextAttr/>
<widgetValue>
<O>
<![CDATA[]]></O>
</widgetValue>
</Widget>`;
    case 'comboCheckBox': {
      // 多选下拉（真实样本：TableDataDictionary + RAAttr；此处支持 custom 字典项）
      // M109：与 comboBox 同样支持 widgetDictionary（数据集/数据库表字典）
      const dict = opts.dictionary
        ? dictionaryXml({ dictionary: opts.dictionary, items, label: `单元格控件 ${widget}` })
        : (items && items.length
          ? `<Dictionary class="com.fr.data.impl.CustomDictionary">
<CustomDictAttr>
${items.map((it) => `<Dict key="${escapeXmlAttr(String(it.key ?? it.value))}" value="${escapeXmlAttr(String(it.value ?? it.key))}"/>`).join('\n')}
</CustomDictAttr>
</Dictionary>`
          : '<Dictionary class="com.fr.data.impl.CustomDictionary">\n<CustomDictAttr>\n</CustomDictAttr>\n</Dictionary>');
      return `<Widget class="com.fr.form.ui.ComboCheckBox">
${wattr}
${dict}
<widgetValue>
<O>
<![CDATA[]]></O>
</widgetValue>
<RAAttr delimiter="&apos;,&apos;" isArray="false"/>
</Widget>`;
    }
    case 'label':
      return `<Widget class="com.fr.form.ui.Label">
${wattr}
<widgetValue>
<O>
<![CDATA[${assertSafeCdata(opts.content ?? '', '标签文本')}]]></O>
</widgetValue>
<LabelAttr verticalcenter="true" textalign="0" autoline="true"/>
</Widget>`;
    case 'custom': {
      // 自定义控件 class 透传（可带 pluginID/plugin-version，覆盖插件按钮如 ExcelImportButton）
      const cls = opts.widgetClass || 'com.fr.form.ui.TextEditor';
      const plugin = opts.pluginID
        ? ` pluginID="${escapeXmlAttr(opts.pluginID)}"${opts.pluginVersion ? ` plugin-version="${escapeXmlAttr(opts.pluginVersion)}"` : ''}`
        : '';
      return `<Widget class="${escapeXmlAttr(cls)}"${plugin}>
${wattr}
<widgetValue>
<O>
<![CDATA[]]></O>
</widgetValue>
</Widget>`;
    }
    case 'submit':
      return `<Widget class="com.fr.report.web.button.write.Submit">
${wattr}
${text('${i18n(\'Utils-Submit\')}')}
<Hotkeys>
<![CDATA[]]></Hotkeys>
<IconName>
<![CDATA[submit]]></IconName>
<Verify failVerifySubmit="false"/>
<Sheet onlySubmitSelect="false"/>
</Widget>`;
    case 'appendRow':
      return `<Widget class="com.fr.report.web.button.write.AppendColumnRow">
${wattr}
${text('${i18n(\'Fine-Engine_Add_Record\')}')}
<Hotkeys>
<![CDATA[]]></Hotkeys>
<IconName>
<![CDATA[appendrow]]></IconName>
</Widget>`;
    default:
      throw new Error(`不支持的控件类型 "${widget}"：text/textarea/date/comboBox/checkBox/submit/appendRow`);
  }
}

/**
 * 单元格展开（扩展）块生成 —— 这是 FineReport 报表"数据如何展开"的核心机制。
 *
 * 【逆向依据】FineReport 安装目录 官方 1550 个样本全量统计：
 *   - 1555/1559 (99.7%) 样本含 <Expand> 节点
 *   - dir: 0=纵向扩展(5367次) / 1=横向扩展(208次)
 *   - left: 左父格单元格引用(1057次)，形如 "A2"；随 leftParentDefault="false" 出现
 *   - up:   上父格单元格引用(51次)，随 upParentDefault="false" 出现
 *   - order: 排序 1/2；multiNumber: 扩展倍数；extendable: 1
 *   典型形态：<Expand dir="0" leftParentDefault="false" left="A2"/>
 *
 * 【左父格三态】（M114 补全，官方实证 → 语义 → 写法）
 *   ① 未声明（默认）：<Expand dir="0"/> —— 引擎按"跟随左邻扩展格"推导。明细表最常用。
 *   ② 显式指向某格 ：<Expand dir="0" leftParentDefault="false" left="A2"/>（官方 1057 例）
 *   ③ **显式"无"** ：<Expand dir="0" leftParentDefault="false"/>（**无 left 属性**，官方 337 例）
 *      语义：该格**不再**把左邻当父格，按自身 dsColumn 独立向下展开 —— 用来在同一行里
 *      打断"默认串联"，让两个数据集各自成块。
 *      官方实证：demo/analytics/financial/利润结构分析.cpt 第 7 行 —— c2/c3/c5 绑 ds4 三列
 *      （默认串联），c6/c7 静态格分隔，c10 绑 ds5.项目 且写 leftParentDefault="false"、
 *      c13/c14 绑 ds5 其余列（默认跟随 c10）→ 同一行两组数据源各自成块展开。
 *      全量统计：同排 ≥2 个"无左父格的向下扩展根"的官方样本 **811 例**。
 *      此前 cpt-mcp 无法写出形态 ③（leftParent 只接受单元格引用），只能用设计器人工点
 *      「左父格→无」——M114 补上 `leftParent: "none"` 表达法。
 *
 * 【语义】同一行多个数据集列时，首个为主扩展格(dir="0")，其余必须声明 left=<主格>,
 *   否则各列独立展开导致行间数据错乱（这是 v1 之前的核心缺陷）。
 *   反过来，当一行里**故意**要放两组互不相关的数据集时，就要在每组的首格写形态 ③
 *   打断默认串联（否则第二组会被并入第一组的父格链）。
 */
/** M114：「左父格=无」的写法归一化 —— true / 'none' / '无' / 'null' 都表示"显式无左父格" */
export function isNoLeftParent(v) {
  if (v === true) return true;
  if (typeof v !== 'string') return false;
  return ['none', 'null', '无', '无左父格'].includes(v.trim().toLowerCase());
}

export function expandXml(expand, contentType) {
  if (expand && typeof expand === 'object') {
    const { dir, leftParent, upParent, order, multiNumber, extendable } = expand;
    const attrs = [];
    if (dir != null) {
      const d = Number(dir);
      if (d !== 0 && d !== 1) {
        throw new Error(`expand.dir 非法 (${dir})：只能是 0=纵向扩展 或 1=横向扩展`);
      }
      attrs.push(`dir="${d}"`);
    }
    // M114「左父格=无」：显式 leftParentDefault="false" 且**不写 left**（官方 337 例）。
    // 与 leftParent 缺省（<Expand/>：默认跟随左邻）是两种不同语义，别混。
    if (isNoLeftParent(leftParent)) {
      attrs.push('leftParentDefault="false"');
    } else if (leftParent != null && leftParent !== '') {
      const ref = String(leftParent).trim();
      if (!/^[A-Za-z]{1,3}\d{1,5}$/.test(ref)) {
        throw new Error(`expand.leftParent 非法 ("${leftParent}")：须为单元格引用（如 "A2"，行号从 1 起），` +
          `或传 "none" 表示显式「左父格=无」（打断默认串联，让多组数据集各自成块展开，官方 337 例实证）。` +
          `提示：单元格 (column=0,row=1) 对应引用 "A2"`);
      }
      attrs.push('leftParentDefault="false"');
      attrs.push(`left="${ref.toUpperCase()}"`);
    }
    if (upParent != null && upParent !== '') {
      const ref = String(upParent).trim();
      if (!/^[A-Za-z]{1,3}\d{1,5}$/.test(ref)) {
        throw new Error(`expand.upParent 非法 ("${upParent}")：须为单元格引用，如 "A2"（列字母 + 行号，行号从 1 起）`);
      }
      attrs.push('upParentDefault="false"');
      attrs.push(`up="${ref.toUpperCase()}"`);
    }
    if (order != null) attrs.push(`order="${Number(order)}"`);
    if (multiNumber != null) attrs.push(`multiNumber="${Number(multiNumber)}"`);
    if (extendable != null) attrs.push(`extendable="${Number(extendable)}"`);
    return attrs.length ? `<Expand ${attrs.join(' ')}/>` : '<Expand/>';
  }
  // 向后兼容：未显式指定时保持旧行为（dsColumn 默认纵向扩展；文本/控件不扩展）
  return contentType === 'dsColumn' ? '<Expand dir="0"/>' : '<Expand/>';
}

/** 单元格坐标 (column/row, 均 0 起) -> FR 单元格引用字符串（如 column=0,row=1 => "A2"） */
export function cellRef(column, row) {
  const c = Number(column), r = Number(row);
  if (!Number.isInteger(c) || c < 0 || !Number.isInteger(r) || r < 0) return null;
  let s = '';
  let n = c;
  do { s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26) - 1; } while (n >= 0);
  return `${s}${r + 1}`;
}

/** 在 CellElementList 末尾新增单元格（文本/DSColumn/公式，可带填报控件）
 *  widget 可选：text/textarea/date/comboBox/checkBox/comboCheckBox/label/submit/appendRow/custom
 *  widgetClass/pluginID/pluginVersion 用于 custom（自定义 class 透传，覆盖插件按钮）
 *  M105：widget + contentType="dsColumn" 共存（填报拖字段形态：<O t="DSColumn"> 与 <Widget> 同格并存）；
 *  其余类型 + widget 时内容节点置空（控件自带 widgetValue，历史行为不变）
 *  expand 可选：{dir:0|1, leftParent?, upParent?, order?, multiNumber?} 控制数据展开方向与父格
 *  summary 可选（M76）：DSColumn 汇总方式 sum/avg/count/max/min —— 官方 GettingStarted.cpt 的
 *  SummaryGrouper 形态落盘；缺省 = 分组形态（FunctionGrouper，与历史输出一致） */
export function addCell(filePath, {
  column, row, content, contentType = 'text', dsName, columnName, result, sort,
  styleIndex = 0, widget, widgetItems, widgetDictionary, colspan, rowspan,
  widgetClass, pluginID, pluginVersion, sheet,
  disabled, // M82: 控件禁用态（仅 widget 建控件时有效）
  // 动态列形态（官方 doc/Parameter/DynamicCol 实证）：ci 为源数据集列序号，替代 columnName
  ci,
  // P0-1: expand 从 spec 传入；局部变量名 expand 已被下方的 XML 字符串占用，故重命名
  expand: expandParam,
  // M76: DSColumn 汇总方式（sum/avg/count/max/min），仅 contentType="dsColumn" 有效
  summary,
} = {}) {
  const c = Number(column), r = Number(row);
  if (!Number.isInteger(c) || c < 0 || !Number.isInteger(r) || r < 0) throw new Error(`单元格坐标非法：(${column},${row})`);
  if (ci != null && (!Number.isInteger(Number(ci)) || Number(ci) < 0)) {
    throw new Error(`ci（动态列列序号）非法 (${ci})：必须是 0 起的整数`);
  }

  // 安全围栏：排序只能挂在数据集列上 —— 官方 105/105 都在 DSColumn，
  // 挂到文本格/公式格上等于臆造形态，设计器读不回来。
  if (sort != null && sort.length > 0 && contentType !== 'dsColumn') {
    throw new Error(`sort（扩展后排序）只能用于 contentType="dsColumn" 的数据集列；当前 contentType="${contentType}"。`
      + '官方 105 处排序全部挂在 DSColumn 上。若要按某列排序，请把排序挂在该行的扩展列（数据集列）上。');
  }

  // 安全围栏（M76）：汇总只能挂在数据集列上 —— 与 sort 同理，官方汇总单元格全部是 DSColumn
  if (summary != null && summary !== '' && contentType !== 'dsColumn') {
    throw new Error(`summary（DSColumn 汇总方式）只能用于 contentType="dsColumn" 的数据集列；当前 contentType="${contentType}"`);
  }

  // 防御：拒绝同 sheet 同坐标重复 addCell（会产生重复 C 标签，设计器会警告/显示异常）
  // C3: 只 load 一次，探测与主编辑共用同一份 raw
  const { raw: probeRaw, parsed } = load(filePath);
  // S2: DSColumn 引用的数据集必须已声明（悬空引用要到渲染时才报错，排查成本极高）
  if (contentType === 'dsColumn') assertDatasetExists(parsed, dsName, 'DSColumn 数据集');
  // M109 安全围栏：widgetDictionary（单元格下拉的字典来源）形态必须给全，否则会写出设计器读不回的字典。
  // 官方单元格侧实测：TableDataDictionary 85 例 / DatabaseDictionary 259 例（ComboBox/CheckBoxGroup/TreeComboBox）。
  if (widgetDictionary != null) {
    if (!['comboBox', 'comboCheckBox'].includes(String(widget))) {
      throw new Error(`add_cell: widgetDictionary 只适用于下拉类控件（comboBox/comboCheckBox），当前 widget=${JSON.stringify(widget)}`);
    }
    if (typeof widgetDictionary !== 'object' || Array.isArray(widgetDictionary)) throw new Error('add_cell: widgetDictionary 必须是对象');
    const type = String(widgetDictionary.type ?? '');
    if (type === 'table') {
      const ds = String(widgetDictionary.dsName ?? '').trim();
      if (!ds) throw new Error('add_cell: widgetDictionary.type="table" 必须提供 dsName（数据集名，须先用 add_dataset 声明）');
      assertDatasetExists(parsed, ds, '数据集字典');
    } else if (type === 'db') {
      if (!String(widgetDictionary.table ?? '').trim()) throw new Error('add_cell: widgetDictionary.type="db" 必须提供 table（数据库表名）');
      if (!String(widgetDictionary.connection ?? '').trim()) throw new Error('add_cell: widgetDictionary.type="db" 必须提供 connection（数据库连接名）');
      for (const k of ['ki', 'vi']) {
        if (!Number.isInteger(Number(widgetDictionary[k]))) {
          throw new Error(`add_cell: widgetDictionary.type="db" 的 ${k} 必须是整数列索引（0 起），收到 ${JSON.stringify(widgetDictionary[k])}`);
        }
      }
    } else if (type === 'formula') {
      // M117 公式数据字典：formula=值公式（必填）；eFormula=显示公式（可缺省/空 ⇒ 官方仅有 FormulaDict 形态）
      if (!String(widgetDictionary.formula ?? '').trim()) {
        throw new Error('add_cell: widgetDictionary.type="formula" 必须提供 formula（值公式，如 =range(2010,2012)）');
      }
    } else if (type !== 'custom') {
      throw new Error(`add_cell: widgetDictionary.type 只能是 table（数据集字典）/db（数据库表字典）/custom（自定义项）/formula（公式数据字典），收到 ${JSON.stringify(widgetDictionary.type)}`);
    }
  }
  {
    const occ = sheet == null ? 0 : locateSheet(probeRaw, sheet).index;
    const blocks = sheetBlocks(probeRaw);
    const lo = blocks[occ]?.start ?? 0, hi = blocks[occ]?.end ?? probeRaw.length;
    const cellHits = findAll(probeRaw, '<C ').filter((s) => s >= lo && s < hi);
    for (const s of cellHits) {
      const head = probeRaw.slice(s, s + 200).match(/^<C[^>]*\bc="(\d+)"[^>]*\br="(\d+)"|<C[^>]*\br="(\d+)"[^>]*\bc="(\d+)"/);
      if (head) {
        const cc = Number(head[1] ?? head[4]);
        const rr = Number(head[2] ?? head[3]);
        if (cc === c && rr === r) {
          throw new Error(`add_cell 失败：${sheet == null ? '第 1 个工作表' : `工作表 ${sheet}`} 已存在 (${c},${r})；请先 delete_cell 或换一个坐标`);
        }
      }
    }
  }

  // M36 防御: colspan/rowspan 必须是正整数, 否则抛错 (防 NaN 写坏 .cpt)
  let colspanN = null, rowspanN = null;
  if (colspan != null) {
    const n = Number(colspan);
    if (!Number.isInteger(n) || n < 1 || n > 1000) {
      throw new Error(`colspan 非法 (${colspan}): 必须是 1-1000 之间的整数`);
    }
    colspanN = n;
  }
  if (rowspan != null) {
    const n = Number(rowspan);
    if (!Number.isInteger(n) || n < 1 || n > 1000) {
      throw new Error(`rowspan 非法 (${rowspan}): 必须是 1-1000 之间的整数`);
    }
    rowspanN = n;
  }
  const spanAttr = (colspanN != null ? ` cs="${colspanN}"` : '') + (rowspanN != null ? ` rs="${rowspanN}"` : '');

  // M105 填报拖字段语义：widget + dsColumn 共存（<O t="DSColumn"> 与 <Widget> 为兄弟节点，
  // 设计器把字段拖到控件格即此形态）。此前 widget ? '' 直接丢绑定，导致“控件保留、只换绑定”无路可走。
  // 非 dsColumn（文本/公式）+ widget 保持旧行为（内容节点置空，控件自带 widgetValue）。
  // M76: summary 透传 —— dsColumn + 白名单值时 RG 输出官方 SummaryGrouper 汇总形态
  const cellContent = (widget && contentType !== 'dsColumn')
    ? ''
    : contentXml(contentType, content, dsName, columnName, result, sort, ci != null ? Number(ci) : undefined, summary);

  // 展开块：DSColumn dir="0"（官方主流样本）；文本/控件 <Expand/>（官方样本样式；与 FR 11.x 序列化器一致）
  // P1 修复：原版本会写 <CellGUIAttr><CellPageAttr><cellSortAttr>，官方样本中均无；FR 解析器容错但路径分支不同
  // P0-1 修复：支持 expand{dir,leftParent,upParent,...}，多列数据集必须声明左父格，否则各列独立展开导致数据错乱
  const expand = expandXml(expandParam, contentType);
  const widgetBlock = widget ? `\n${widgetXml(widget, widgetItems, { widgetClass, pluginID, pluginVersion, content, disabled, dictionary: widgetDictionary })}` : '';

  const cell = `<C c="${c}" r="${r}" s="${styleIndex}"${spanAttr}>
${cellContent}<PrivilegeControl/>${widgetBlock}
${expand}
</C>
`;
  const anchor = '</CellElementList>';
  if (!probeRaw.includes(anchor)) throw new Error('定位失败：未找到 </CellElementList>');
  // sheet 缺省=第 1 个工作表；指定时按其索引定位对应 CellElementList（每个工作表一个）
  const occ = sheet == null ? 0 : locateSheet(probeRaw, sheet).index;
  const out = insertBefore(probeRaw, anchor, cell, '</CellElementList>', occ);
  save(filePath, out);
  return { action: 'add_cell', cell: `${c},${r}`, sheet: sheet ?? 0, styleIndex, contentType, widget: widget || null };
}

// ---------------- add_float_element：浮动元素 ----------------

/**
 * 浮动元素（FloatElementList）：悬浮在工作表之上、不占网格的元素。
 * 官方 1559 样本实证 94 例：文本 76 例 + 图片 18 例。
 * 图片内容是 FR 私有压缩编码（无法离线生成），故本工具只开放文本形态，
 * XML 骨架逐字取自官方最简实例（demo/Chart/DataVisualization/数据可视化.cpt）：
 *   <com.fr.report.cell.FloatElement>
 *   <FloatElementName name="Float46"/><PrivilegeControl/>
 *   <Location leftDistance topDistance width height/>
 *   <O><![CDATA[文本]]></O><Style index="0"/>
 *   </com.fr.report.cell.FloatElement>
 * 位置单位与行高列宽一致：1mm = 144000 单位。
 */
export function addFloatElement(filePath, {
  content, styleIndex = 0, sheet, name,
  leftMm = 10, topMm = 10, widthMm = 40, heightMm = 10,
} = {}) {
  if (typeof content !== 'string' || !content.trim()) throw new Error('浮动元素内容不能为空');
  assertSafeCdata(content, '浮动元素内容');
  const unit = (v, label, min) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n < min || n > 10000) {
      throw new Error(`浮动元素 ${label} 非法 (${v})：必须是 ${min}-10000 之间的毫米数`);
    }
    return mmToUnit(n);
  };
  const left = unit(leftMm, 'leftMm', 0);
  const top = unit(topMm, 'topMm', 0);
  const width = unit(widthMm, 'widthMm', 1);
  const height = unit(heightMm, 'heightMm', 1);

  let { raw } = load(filePath);
  const blocks = sheetBlocks(raw);
  const occ = sheet == null ? 0 : locateSheet(raw, sheet).index;
  if (!blocks[occ]) throw new Error(`定位失败：不存在工作表 ${sheet ?? 0}`);
  let { start: lo, end: hi } = blocks[occ];

  // 样式索引越界检查（与 validate_cpt 的单元格规则一致）
  const styleCount = styleBlocks(raw).blocks.length;
  const si = Number(styleIndex);
  if (!Number.isInteger(si) || si < 0 || si >= styleCount) {
    throw new Error(`浮动元素 styleIndex=${styleIndex} 越界（StyleList 仅 ${styleCount} 个样式）；请先用 add_style 创建`);
  }

  // 该工作表内查找/创建 <FloatElementList>（官方样本：位于 CellElementList 之前）
  let listOpen = raw.indexOf('<FloatElementList>', lo);
  const listInSheet = listOpen >= 0 && listOpen < hi;
  if (!listInSheet) {
    const cellList = raw.indexOf('<CellElementList', lo);
    if (cellList < 0 || cellList >= hi) throw new Error('定位失败：未找到工作表的 CellElementList');
    raw = raw.slice(0, cellList) + '<FloatElementList>\n</FloatElementList>\n' + raw.slice(cellList);
    listOpen = cellList;
    hi += '<FloatElementList>\n</FloatElementList>\n'.length;
  }
  const listClose = raw.indexOf('</FloatElementList>', listOpen);
  if (listClose < 0) throw new Error('定位失败：FloatElementList 未闭合');
  const block = raw.slice(listOpen, listClose);

  // 命名：缺省自动取文档内最大 FloatN + 1；显式指定时查重（官方形态 "Float46" / "Float36-Copy"）
  let floatName = name != null ? String(name).trim() : null;
  if (floatName) {
    if (!/^[A-Za-z0-9_\-\u4e00-\u9fa5]+$/.test(floatName)) throw new Error(`浮动元素名非法：${name}（仅允许字母/数字/_/-/中文）`);
    if (block.includes(`name="${escapeXmlAttr(floatName)}"`)) throw new Error(`浮动元素名已存在：${floatName}`);
  } else {
    let maxN = 0;
    for (const m of block.matchAll(/name="Float(\d+)/g)) maxN = Math.max(maxN, Number(m[1]));
    floatName = `Float${maxN + 1}`;
  }

  const fe = `<com.fr.report.cell.FloatElement>
<FloatElementName name="${escapeXmlAttr(floatName)}"/>
<PrivilegeControl/>
<Location leftDistance="${left}" topDistance="${top}" width="${width}" height="${height}"/>
<O>
<![CDATA[${content}]]></O>
<Style index="${si}"/>
</com.fr.report.cell.FloatElement>
`;
  raw = raw.slice(0, listClose) + fe + raw.slice(listClose);
  save(filePath, raw);
  return {
    action: 'add_float_element',
    sheet: sheet ?? 0,
    name: floatName,
    styleIndex: si,
    positionMm: { leftMm, topMm, widthMm, heightMm },
  };
}

// ---------------- add_sheet：追加工作表 ----------------

/** 在工作簿末尾追加一个工作表（<Report ...WorkSheet> 块：空格网格 + 空 CellElementList） */
export function addSheet(filePath, { sheetName, rows = 6, columns = 6 } = {}) {
  const { raw } = load(filePath);
  const blocks = sheetBlocks(raw);
  const name = sheetName != null ? String(sheetName) : `sheet${blocks.length + 1}`;
  if (blocks.some((b) => b.name === name)) throw new Error(`工作表已存在：${name}`);
  const rowH = Array.from({ length: rows }, () => DEF_ROW_H).join(',');
  const colW = Array.from({ length: columns }, () => DEF_COL_W).join(',');
  // P1 修复：按当前 WorkBook 的 xmlVersion 决定是否补 <ElementCaseMobileAttr>（11.5 补，10.x 跳）
  const { parsed: parsed0 } = load(filePath);
  const xmlVer = String(parsed0.WorkBook?.['@_xmlVersion'] || parsed0.WorkBook?.xmlVersion || '20211223');
  const mobileAttr = xmlVer === '20211223'
    ? `<ElementCaseMobileAttr>
<ElementCaseMobileAttrProvider horizontal="1" vertical="1" zoom="true" refresh="false" isUseHTML="false" isMobileCanvasSize="false" appearRefresh="false" allowFullScreen="false"/>
</ElementCaseMobileAttr>
`
    : '';
  const block = `<Report class="com.fr.report.worksheet.WorkSheet" name="${escapeXmlAttr(name)}">
${mobileAttr}<ReportPageAttr>
<HR/>
<FR/>
<HC/>
<FC/>
<UPFCR COLUMN="false" ROW="true"/>
<USE REPEAT="false" PAGE="false" WRITE="false"/>
</ReportPageAttr>
<ColumnPrivilegeControl/>
<RowPrivilegeControl/>
<RowHeight defaultValue="${DEF_ROW_H}">
<![CDATA[${rowH}]]></RowHeight>
<ColumnWidth defaultValue="${DEF_COL_W}">
<![CDATA[${colW}]]></ColumnWidth>
<CellElementList>
</CellElementList>
<ReportAttrSet>
<ReportSettings shrinkToFitMode="0" headerHeight="0" footerHeight="0">
<PaperSetting/>
<FollowingTheme background="false"/>
</ReportSettings>
${EMPTY_HEADER_FOOTER}
</ReportAttrSet>
</Report>
`;
  // 追加到最后一个工作表（</Report>）之后
  const out = insertAfter(raw, '</Report>', '\n' + block, '</Report>', blocks.length - 1);
  save(filePath, out);
  return { action: 'add_sheet', sheet: name, rows, columns, bytes: Buffer.byteLength(out, 'utf8') };
}

// ---------------- add_fill_submit：新建填报提交（SubmitVisitor） ----------------

/** FineReport 内置 SQL 提交的 DMLConfig 类型（官方样本实证）。 */
const DML_CONFIG_TYPES = Object.freeze({
  intelligent: 'com.fr.write.config.IntelliDMLConfig',
  insert: 'com.fr.write.config.InsertConfig',
});
const LIST_CONDITION_CLASS = 'com.fr.data.condition.ListCondition';

/**
 * 归一 submitType / configType：
 *   insert / InsertConfig / com.fr.write.config.InsertConfig → 插入提交
 *   intelligent / smart / IntelliDMLConfig → 智能提交（默认）
 * 返回规范类型名 + 完整 class。
 */
function normalizeDmlConfigType(value, { defaultType = null } = {}) {
  const raw = value == null ? '' : String(value).trim();
  if (raw === '') {
    if (!defaultType) return null;
    return { type: defaultType, class: DML_CONFIG_TYPES[defaultType] };
  }
  const compact = raw.toLowerCase().replace(/[^a-z]/g, '');
  if (compact === 'insert' || compact === 'insertconfig' || compact === 'comfrwriteconfiginsertconfig') {
    return { type: 'insert', class: DML_CONFIG_TYPES.insert };
  }
  if (compact === 'intelligent' || compact === 'smart' || compact === 'intellidmlconfig'
    || compact === 'comfrwriteconfigintellidmlconfig') {
    return { type: 'intelligent', class: DML_CONFIG_TYPES.intelligent };
  }
  throw new Error(`add_fill_submit/update_fill_submit: 不支持的提交类型 "${raw}"；可用 insert（插入提交）或 intelligent（智能提交）`);
}

/**
 * 新增 SubmitVisitor 提交。两种形态（二选一）：
 *  ① BuiltInSQLSubmiter（默认）：dsName + table + bindings（列映射整行 upsert）
 *  ② FreeSQLSubmiter（传 sql）：dbName + sql（原始 SQL，可自定义 WHERE 的 UPDATE/DELETE）
 *    —— 官方向：com.fr.report.write.FreeSQLSubmiter 是 BuiltInSQLSubmiter 的父类，序列化为
 *      <DBName>（服务端数据连接名）+ <SQL>（任意 DML）。用于"删除提交/条件更新"等
 *      IntelliDMLConfig 表达不了的形态（如 UPDATE ... SET is_delete=1 WHERE id=${id}）。
 * submitType：intelligent（默认，智能提交）/ insert（插入提交）；也可用 configType 别名。
 * 互斥：sql 与 table/bindings 二选一（语义冲突即报错）。
 */
export function addFillSubmit(filePath, { dsName, table, schema = '', name = '内置SQL1', bindings = [], sheet, sql, dbName, parameters, condition, submitType, configType } = {}) {
  if (sql != null && String(sql).trim() !== '') {
    if (table || bindings.length > 0) {
      throw new Error(`add_fill_submit: sql（自由 SQL 提交）与 table/bindings 互斥 —— 原始 SQL 提交用 dbName+sql，列映射提交用 table+bindings`);
    }
    if (submitType != null || configType != null) {
      throw new Error('add_fill_submit: submitType/configType 只用于列映射提交（BuiltInSQLSubmiter）；自由 SQL 提交没有 DMLConfig');
    }
    if (condition != null && String(condition).trim() !== '') {
      throw new Error('add_fill_submit: condition（提交条件）只用于列映射提交（BuiltInSQLSubmiter）；自由 SQL 提交把过滤条件直接写进 SQL 的 WHERE');
    }
    const safeSql = assertSafeCdata(String(sql), '自由 SQL');
    const safeName = assertSafeCdata(name, '提交名称');
    const connName = dbName != null && String(dbName).trim() !== '' ? String(dbName).trim() : (dsName || '');
    if (!connName) throw new Error(`add_fill_submit: 自由 SQL 提交必须提供 dbName（服务端数据连接名，如 "填报-读写"）或 dsName`);
    // 提交参数声明（2026-10-30 修，sandbox4/v1 实测缺口）：SQL 里的 ${x} 必须声明成
    // <Parameter><Attributes name="x"/><O>= $x</O></Parameter>，否则 FR 不替换、原样进数据库。
    // 默认按 SQL 中的 ${x} 自动声明（value = $x），parameters 可覆盖取值或补声明。
    const paramDecls = normalizeSubmitParameters(String(sql), parameters);
    const paramsXml = submitParametersXml(paramDecls);
    const submit = `<SubmitVisitor class="com.fr.report.write.FreeSQLSubmiter">
<Name>
<![CDATA[${safeName}]]></Name>
<DBName>
<![CDATA[${assertSafeCdata(connName, 'DBName')}]]></DBName>
<SQL>
<![CDATA[${safeSql}]]></SQL>
${paramsXml}</SubmitVisitor>
`;
    const out = insertSubmitVisitor(filePath, submit, sheet);
    save(filePath, out);
    return {
      action: 'add_fill_submit', submitIndex: findAll(out, '<SubmitVisitor').length - 1,
      mode: 'free-sql', dbName: connName, sql: String(sql).slice(0, 120),
      parameters: paramDecls.map((d) => d.name),
      ...(paramDecls.length ? { hint: `已声明提交参数 ${paramDecls.map((d) => d.name).join('、')}（SQL 里的 \${x} 会从对应报表参数取值）；如需固定值/公式请传 parameters:[{name:"x",value:"..."}]` } : {}),
      bytes: Buffer.byteLength(out, 'utf8'),
    };
  }
  if (parameters != null && (!Array.isArray(parameters) || parameters.length > 0)) {
    throw new Error('add_fill_submit: parameters（提交参数声明）只用于自由 SQL 提交（传 sql）；列映射提交的值由 bindings 决定');
  }
  if (!table) throw new Error('必须提供目标表名 table');
  const safeDs = escapeXmlAttr(dsName || '');
  const safeTable = escapeXmlAttr(table);
  const safeSchema = escapeXmlAttr(schema);
  const safeName = assertSafeCdata(name, '提交名称');
  // 提交条件（sandbox19/v1 缺口补齐）：官方形态 <Condition class="com.fr.data.condition.FormulaCondition">
  // <Formula><![CDATA[Y5=1]]></Formula></Condition>，位置在 DMLConfig 末尾（全部 ColumnConfig 之后）。
  // 2026-11-05：condition 也接受 FormulaCondition / ListCondition 对象；字符串 "ListCondition" 表示空列表条件。
  const dml = normalizeDmlConfigType(submitType ?? configType, { defaultType: 'intelligent' });
  const cond = normalizeSubmitCondition(condition);
  const conditionXml = cond.kind === 'formula'
    ? `<Condition class="com.fr.data.condition.FormulaCondition">\n<Formula>\n<![CDATA[${assertSafeCdata(cond.formula, '提交条件')}]]></Formula>\n</Condition>\n`
    : cond.kind === 'list'
      ? `<Condition class="${LIST_CONDITION_CLASS}"/>\n`
      : '';

  const cols = bindings.map((b) => {
    const f = escapeXmlAttr(b.field);
    const isKey = b.isKey ? 'true' : 'false';
    // sandbox19/v1 的最终阻塞点：ColumnConfig 的 skipUnmodified（FR「未修改则跳过」= 列级智能提交）
    // 此前任何工具都不能设置，只能让用户去设计器逐列勾。现在按 binding 粒度透传，缺省 false 保持旧字节。
    const skip = b.skipUnmodified === true ? 'true' : 'false';
    if (b.constant != null) {
      return `<ColumnConfig name="${f}" isKey="${isKey}" skipUnmodified="${skip}">
<O>
<![CDATA[${assertSafeCdata(String(b.constant), `常量 ${f}`)}]]></O>
</ColumnConfig>`;
    }
    const col = Number(b.column), row = Number(b.row);
    if (!Number.isInteger(col) || col < 0 || !Number.isInteger(row) || row < 0) throw new Error(`绑定 ${f} 坐标非法`);
    return `<ColumnConfig name="${f}" isKey="${isKey}" skipUnmodified="${skip}">
<ColumnRow column="${col}" row="${row}"/>
</ColumnConfig>`;
  }).join('\n');

  const submit = `<SubmitVisitor class="com.fr.report.write.BuiltInSQLSubmiter">
<Name>
<![CDATA[${safeName}]]></Name>
<Attributes dsName="${safeDs}"/>
<DMLConfig class="${dml.class}">
<Table schema="${safeSchema}" name="${safeTable}"/>
${cols}
${conditionXml}</DMLConfig>
</SubmitVisitor>
`;
  const out = insertSubmitVisitor(filePath, submit, sheet);
  save(filePath, out);
  return {
    action: 'add_fill_submit', submitIndex: findAll(out, '<SubmitVisitor').length - 1, mode: 'built-in',
    dsName, table, bindings: bindings.length, submitType: dml.type, dmlConfigClass: dml.class,
    ...(cond.kind === 'formula' ? { condition: cond.formula } : cond.kind === 'list' ? { condition: 'ListCondition' } : {}),
    bytes: Buffer.byteLength(out, 'utf8'),
  };
}

/** 提交条件归一（容忍前导 =；支持 FormulaCondition 对象和空 ListCondition）。
 *  返回 {kind:'none'} / {kind:'list'} / {kind:'formula', formula}。
 *  ListCondition（空列表=全部行）可用字符串 "ListCondition"/"list" 或
 *  {class:"com.fr.data.condition.ListCondition"} / {list:true} 表达。 */
const FORMULA_CONDITION_CLASS = 'com.fr.data.condition.FormulaCondition';
function normalizeSubmitCondition(condition) {
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
  // ListCondition 带显式 formula 时按公式处理（与 server 参数归一同口径），否则表示空列表条件。
  if (cls === LIST_CONDITION_CLASS) {
    const explicit = condition.formula ?? condition.expr ?? condition.expression;
    if (typeof explicit === 'string' && explicit.trim() !== '') {
      const s = explicit.trim();
      return { kind: 'formula', formula: s.startsWith('=') ? s.slice(1).trim() : s };
    }
    return { kind: 'list' };
  }
  if (cls && cls !== FORMULA_CONDITION_CLASS) {
    throw new Error(`提交条件对象 class="${cls}" 不支持；可用 FormulaCondition 公式文本或 ListCondition（空列表）`);
  }
  const raw = condition.formula ?? condition.expr ?? condition.expression ?? condition.value ?? condition.text;
  if (typeof raw !== 'string') {
    throw new Error('提交条件对象缺少 formula 字段（需要 {class:"com.fr.data.condition.FormulaCondition", formula:"Y5=1"}、{formula:"Y5=1"} 或 {class:"com.fr.data.condition.ListCondition"}）');
  }
  const s = raw.trim();
  if (s === '') return { kind: 'none' };
  return { kind: 'formula', formula: s.startsWith('=') ? s.slice(1).trim() : s };
}

/** 把 SubmitVisitor 块插入到恰当容器（ReportWriteAttr / 新建容器），两种提交共用同一插入逻辑 */
function insertSubmitVisitor(filePath, submit, sheet) {
  const { raw } = load(filePath);
  let out;
  if (raw.includes('</ReportWriteAttr>')) {
    const occ = sheet == null ? 0 : locateSheet(raw, sheet).index;
    const blocks = sheetBlocks(raw);
    const lo = blocks[occ]?.start ?? 0, hi = blocks[occ]?.end ?? raw.length;
    const rwaHits = findAll(raw, '</ReportWriteAttr>').filter((s) => s >= lo && s < hi);
    if (rwaHits.length > 0) {
      const target = rwaHits[rwaHits.length - 1];
      const all = findAll(raw, '</ReportWriteAttr>');
      const globalOcc = all.indexOf(target);
      out = insertBefore(raw, '</ReportWriteAttr>', submit, '</ReportWriteAttr>', globalOcc);
    } else {
      const reportHits = findAll(raw, '</Report>');
      if (occ >= reportHits.length) throw new Error(`工作表索引 ${occ} 越界`);
      const idx = reportHits[occ];
      out = raw.slice(0, idx) + '<ReportWriteAttr>\n' + submit + '</ReportWriteAttr>\n' + raw.slice(idx);
    }
  } else if (raw.includes('</ReportAttrSet>')) {
    const attrHits = findAll(raw, '</ReportAttrSet>');
    if (attrHits.length === 0) throw new Error('定位失败：</ReportAttrSet> 出现但 findAll 异常');
    const occ = sheet == null ? 0 : locateSheet(raw, sheet).index;
    if (occ >= attrHits.length) throw new Error(`工作表索引 ${occ} 越界：仅 ${attrHits.length} 个 ReportAttrSet`);
    const idx = attrHits[occ] + '</ReportAttrSet>'.length;
    out = raw.slice(0, idx) + '\n<ReportWriteAttr>\n' + submit + '</ReportWriteAttr>\n' + raw.slice(idx);
  } else {
    const anchor = '</Report>';
    const hits = findAll(raw, anchor);
    if (hits.length === 0) throw new Error('定位失败：未找到 </Report>');
    const occ = sheet == null ? 0 : locateSheet(raw, sheet).index;
    if (occ >= hits.length) throw new Error(`工作表索引 ${occ} 越界：仅 ${hits.length} 个工作表`);
    const idx = hits[occ];
    out = raw.slice(0, idx) + '<ReportWriteAttr>\n' + submit + '</ReportWriteAttr>\n' + raw.slice(idx);
  }
  return out;
}

// ---------------- set_report_settings：纸张 / 边距 / 居中 / 缩放 ----------------
// 纸张预设统一来自 rules.js（此前 generate.js 与 rules.js 各有一份，存在漂移风险）

/** 设置纸张/页边距/水平垂直居中/缩放（修改 ReportSettings 下的 PaperSetting，无则创建） */
export function setReportSettings(filePath, opts = {}) {
  // 默认值用 undefined 占位：让"用户未传"能区分于"传了 0"
  const { paper, orientation, paperWidthMm, paperHeightMm,
    marginTopMm, marginBottomMm, marginLeftMm, marginRightMm,
    isHorizontalCenterOnPage, isVerticalCenterOnPage, shrinkToFitMode,
    headerHeightMm, footerHeightMm, sheet,
    frozenColumn, frozenRow } = opts;
  // 关键语义修复：所有"原 PaperSetting 字段"都支持"未传则保留模板原值"。
  // 解决连续调用时的"互踩"（之前用默认值覆盖了已设的 orientation/margins 等）。
  // 先解析模板现状，按"参数未传 = 沿用原值"组装新 paperXml。
  const { raw: raw0 } = load(filePath);
  const target0 = locateSheet(raw0, sheet ?? 0);
  const targetXml0 = raw0.slice(target0.start, target0.end);
  const attrFrom = (tag, attr) => {
    const open = targetXml0.match(new RegExp(`<${tag}\\b[^>]*>`));
    return open ? (open[0].match(new RegExp(`\\b${attr}="([^"]*)"`)) || [])[1] : undefined;
  };
  const ps0 = attrFrom('PaperSetting', 'orientation') == null ? null : { '@_orientation': attrFrom('PaperSetting', 'orientation') };
  const size0 = attrFrom('PaperSize', 'width') == null ? null : {
    '@_width': attrFrom('PaperSize', 'width'), '@_height': attrFrom('PaperSize', 'height'),
  };
  const margin0 = attrFrom('Margin', 'top') == null ? null : {
    '@_top': attrFrom('Margin', 'top'), '@_bottom': attrFrom('Margin', 'bottom'),
    '@_left': attrFrom('Margin', 'left'), '@_right': attrFrom('Margin', 'right'),
  };

  // 1) 纸张：未传 paper/paperWidth/Height → 沿用原值
  let wMm, hMm;
  if (paperWidthMm && paperHeightMm) {
    wMm = Number(paperWidthMm); hMm = Number(paperHeightMm);
  } else if (paper && PAPER_PRESETS[paper.toUpperCase()]) {
    wMm = PAPER_PRESETS[paper.toUpperCase()].w;
    hMm = PAPER_PRESETS[paper.toUpperCase()].h;
  } else if (size0?.['@_width'] && size0?.['@_height']) {
    wMm = unitToMm(size0['@_width']); hMm = unitToMm(size0['@_height']);
  } else {
    wMm = A4_W / 144000; hMm = A4_H / 144000;
  }
  // 2) 方向：未传 → 沿用原值（取开标签属性，不取 children）
  const oriAttrRaw = ps0?.['@_orientation'];
  const currentOri = orientation != null
    ? (Number(orientation) === 1 ? 1 : 0)  // 用户显式 0/1
    : (oriAttrRaw != null ? Number(oriAttrRaw) : 0);
  // 3) 边距：未传 → 沿用原值
  const mt = (marginTopMm != null) ? Number(marginTopMm) : (margin0 ? unitToMm(margin0['@_top']) : 6.85);
  const mb = (marginBottomMm != null) ? Number(marginBottomMm) : (margin0 ? unitToMm(margin0['@_bottom']) : 6.85);
  const ml = (marginLeftMm != null) ? Number(marginLeftMm) : (margin0 ? unitToMm(margin0['@_left']) : 19.05);
  const mr = (marginRightMm != null) ? Number(marginRightMm) : (margin0 ? unitToMm(margin0['@_right']) : 19.05);

  const paperXml = `<PaperSetting orientation="${currentOri === 1 ? '1' : '0'}">
<PaperSize width="${mmToUnit(wMm)}" height="${mmToUnit(hMm)}"/>
<Margin top="${mmToUnit(mt)}" left="${mmToUnit(ml)}" bottom="${mmToUnit(mb)}" right="${mmToUnit(mr)}"/>
</PaperSetting>`;

  const { raw } = load(filePath);
  let out = raw;
  const hitsInTargetSheet = (pattern) => {
    const target = locateSheet(out, sheet ?? 0);
    return findAll(out, pattern).filter((index) => index >= target.start && index < target.end);
  };
  // 1) PaperSetting：已有块则整块替换（兼容自闭合 <PaperSetting/> 与含子节点两种形式）
  const psStarts = hitsInTargetSheet('<PaperSetting');
  if (psStarts.length > 0) {
    const s = psStarts[0];
    const gt = out.indexOf('>', s);
    const isSelfClose = out.slice(s, gt + 1).trim().endsWith('/>');
    if (isSelfClose) {
      out = out.slice(0, s) + paperXml + out.slice(gt + 1);
    } else {
      const [b, e] = blockRange(out, s, '<PaperSetting', '</PaperSetting>');
      out = out.slice(0, b) + paperXml + out.slice(e);
    }
  } else {
    // 无 PaperSetting：在 ReportSettings 内插入（兼容自闭合 <ReportSettings/> 与普通形式）
    const rsHits = hitsInTargetSheet('<ReportSettings');
    if (rsHits.length === 0) throw new Error('定位失败：未找到 <ReportSettings>');
    const rsStart = rsHits[0];
    const gt = out.indexOf('>', rsStart);
    if (gt < 0) throw new Error('定位失败：ReportSettings 开标签未闭合');
    const isRsSelfClose = out.slice(rsStart, gt + 1).trim().endsWith('/>');
    if (isRsSelfClose) {
      // 自闭合 → 展开为开标签 + PaperSetting + 闭合标签；保留原开标签属性（如 <ReportSettings shrinkToFitMode="0"/>）
      const openTag = out.slice(rsStart, gt + 1);
      const attrsPart = openTag.slice('<ReportSettings'.length, openTag.length - 2);
      out = out.slice(0, rsStart) + `<ReportSettings${attrsPart}>\n${paperXml}</ReportSettings>` + out.slice(gt + 1);
    } else {
      out = out.slice(0, gt + 1) + '\n' + paperXml + out.slice(gt + 1);
    }
  }
  // 2) ReportSettings 属性（居中/缩放/首页页码等）：存在则替换，不存在则插入
  // 注意：每次 upsert 都会插入文本使开标签变长，必须每次重新定位 > 位置（rsStart 不变）
  // 匹配 <ReportSettings 与 <ReportSettings/> 两种形态（不带空格要求）
  const rsStarts = hitsInTargetSheet('<ReportSettings');
  if (rsStarts.length > 0) {
    const rsStart = rsStarts[0];
    const applyAttr = (attr, value) => {
      const gt = out.indexOf('>', rsStart);
      if (gt < 0) throw new Error('定位失败：ReportSettings 开标签未闭合');
      out = upsertAttr(out, rsStart, gt + 1, attr, value, 'ReportSettings');
    };
    if (isHorizontalCenterOnPage !== undefined) applyAttr('isHorizontalCenterOnPage', String(!!isHorizontalCenterOnPage));
    if (isVerticalCenterOnPage !== undefined) applyAttr('isVerticalCenterOnPage', String(!!isVerticalCenterOnPage));
    if (shrinkToFitMode !== undefined) applyAttr('shrinkToFitMode', String(shrinkToFitMode));
    if (headerHeightMm !== undefined) applyAttr('headerHeight', String(mmToUnit(headerHeightMm)));
    if (footerHeightMm !== undefined) applyAttr('footerHeight', String(mmToUnit(footerHeightMm)));
  }
  // M50 B: 冻结行列（<FrozenColumnRow columnrow="D8"/> 位于 ReportSettings/PaperSetting 前）
  // frozenColumn/frozenRow 未传 → 不动；都传 0 → 删除节点
  if (frozenColumn !== undefined || frozenRow !== undefined) {
    const fc = frozenColumn === undefined ? 0 : Number(frozenColumn);
    const fr = frozenRow === undefined ? 0 : Number(frozenRow);
    if (!Number.isInteger(fc) || fc < 0 || !Number.isInteger(fr) || fr < 0) {
      throw new Error(`frozenColumn/frozenRow 必须是非负整数，收到 (${frozenColumn},${frozenRow})`);
    }
    const rsStart = hitsInTargetSheet('<ReportSettings')[0];
    if (rsStart === undefined) throw new Error('定位失败：未找到 <ReportSettings>');
    const [rsB, rsE] = blockRange(out, rsStart, '<ReportSettings', '</ReportSettings>');
    const rsSeg = out.slice(rsB, rsE);
    const existing = findAll(out, '<FrozenColumnRow').filter((i) => i >= rsB && i < rsE);
    // FrozenColumnRow 是自闭合节点（<FrozenColumnRow columnrow="D8"/>），用 /> 定位区间
    let existingSeg = null;
    if (existing.length > 0) {
      const st = existing[0];
      const gt = out.indexOf('/>', st);
      if (gt < 0) throw new Error('定位失败：FrozenColumnRow 自闭合异常');
      existingSeg = [st, gt + 2];
    }
    if (fc === 0 && fr === 0) {
      // 删除冻结节点
      if (existingSeg) out = out.slice(0, existingSeg[0]) + out.slice(existingSeg[1]);
    } else {
      // 注意：此局部函数是 **1 基**列号（fc/fr 为冻结窗格的 1 基计数），与模块级 0 基的
      // colLetter(n) 语义不同，故显式命名 1Based，避免同名遮蔽后人误用 0 基口径。
      const colLetter1Based = (n) => { let s = ''; while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); } return s; };
      const cell = `${colLetter1Based(fc || 1)}${fr || 1}`;
      const nodeXml = `<FrozenColumnRow columnrow="${cell}"/>`;
      if (existingSeg) {
        out = out.slice(0, existingSeg[0]) + nodeXml + out.slice(existingSeg[1]);
      } else {
        // 插到 PaperSetting 前（无则插开标签后）
        const psRel = rsSeg.indexOf('<PaperSetting');
        const insertAt = psRel >= 0 ? rsB + psRel : rsB + out.indexOf('>', rsStart) + 1;
        out = out.slice(0, insertAt) + '\n' + nodeXml + out.slice(insertAt);
      }
    }
  }
  save(filePath, out);
  return {
    action: 'set_report_settings', sheet: sheet ?? 0, paper: paper || `${wMm}×${hMm}mm`, orientation: currentOri === 1 ? '横向' : '纵向',
    paperSizeUnit: `${mmToUnit(wMm)}×${mmToUnit(hMm)}`, bytes: Buffer.byteLength(out, 'utf8'),
  };
}

// ---------------- 参数面板（set_parameter_panel + add_parameter_widget，指南路线 D） ----------------

/** ParameterUI 骨架（含空 Layout；控件由 addParameterWidget 追加） */
const PARAM_UI_SKELETON = `<ParameterUI class="com.fr.form.main.parameter.FormParameterUI">
<Parameters/>
<Layout class="com.fr.form.ui.container.WParameterLayout">
<WidgetName name="para"/>
<Margin top="1" left="1" bottom="1" right="1"/>
<LCAttr vgap="0" hgap="0" compInterval="0"/>
<NameTagModified/>
<WidgetNameTagMap/>
<ParamAttr class="com.fr.report.mobile.DefaultMobileParamStyle"/>
</Layout>
</ParameterUI>`;

/** 构建完整 ReportParameterAttr 骨架（无控件） */
function paramPanelBlock(title, showWindow, windowPosition) {
  return `<ReportParameterAttr>
<Attributes showWindow="${showWindow ? 'true' : 'false'}" delayPlaying="true" windowPosition="${Number(windowPosition)}" align="0" useParamsTemplate="true" currentIndex="0"/>
<PWTitle>
<![CDATA[${assertSafeCdata(title, '参数面板标题')}]]></PWTitle>
${PARAM_UI_SKELETON}
</ReportParameterAttr>
`;
}

/** 定位 ReportParameterAttr 不存在时插入骨架的位置，返回插入后骨架的起始索引 */
function ensureParamPanel(out, { title = '参数', showWindow = true, windowPosition = 1 } = {}) {
  let start = out.indexOf('<ReportParameterAttr>');
  if (start >= 0) return { out, start };
  const block = paramPanelBlock(title, showWindow, windowPosition);
  let out2;
  const anchor = '<StyleList>';
  if (out.includes(anchor)) out2 = insertBefore(out, anchor, block, '<StyleList>');
  else {
    const hits = findAll(out, '</Report>');
    if (hits.length === 0) throw new Error('定位失败：未找到 </Report>');
    const idx = hits[hits.length - 1] + '</Report>'.length;
    out2 = out.slice(0, idx) + '\n' + block + out.slice(idx);
  }
  // 把 out2 写回调用方（通过返回值告知新 out 与 start）
  return { out: out2, start: out2.indexOf('<ReportParameterAttr>') };
}

/** 设置参数面板：已有面板只修改显式给出的字段，保留其余属性与 ParameterUI 控件。 */
export function setParameterPanel(filePath, { title, showWindow, windowPosition, delayPlaying } = {}) {
  const { raw } = load(filePath);
  let out = raw;
  const start = out.indexOf('<ReportParameterAttr>');
  if (start < 0) {
    const r = ensureParamPanel(out, {
      title: title ?? '参数',
      showWindow: showWindow ?? true,
      windowPosition: windowPosition ?? 1,
    });
    out = r.out;
  } else {
    // 已存在：仅 upsert 调用方明确给出的属性，避免 title-only 调用重置显示状态/位置。
    const [b, e] = blockRange(out, start, '<ReportParameterAttr>', '</ReportParameterAttr>');
    const seg = out.slice(b, e);
    const aStart = seg.indexOf('<Attributes ');
    if (aStart >= 0) {
      const aEnd = seg.indexOf('/>', aStart);
      if (aEnd >= 0) {
        const attrStart = b + aStart;
        if (showWindow !== undefined) {
          out = upsertAttr(out, attrStart, out.indexOf('/>', attrStart) + 2, 'showWindow', showWindow ? 'true' : 'false', '参数面板 Attributes');
        }
        if (windowPosition !== undefined) {
          out = upsertAttr(out, attrStart, out.indexOf('/>', attrStart) + 2, 'windowPosition', String(Number(windowPosition)), '参数面板 Attributes');
        }
        if (delayPlaying !== undefined) {
          // M84 打开即查询：delayPlaying=true=首屏空白等点查询；false=打开即查（doc-162 口径，backup 12 例实证）
          out = upsertAttr(out, attrStart, out.indexOf('/>', attrStart) + 2, 'delayPlaying', delayPlaying ? 'true' : 'false', '参数面板 Attributes');
        }
      }
    }
    const pStart = title === undefined ? -1 : out.indexOf('<PWTitle>', b);
    if (pStart >= 0) {
      const [tb, te] = blockRange(out, pStart, '<PWTitle>', '</PWTitle>');
      const cb = out.indexOf('<![CDATA[', tb);
      const ce = out.indexOf(']]>', cb + 9);
      if (cb >= 0 && ce >= 0) {
        out = out.slice(0, cb + 9) + assertSafeCdata(title, '参数面板标题') + out.slice(ce);
      }
    }
  }
  save(filePath, out);
  return {
    action: 'set_parameter_panel',
    title: title ?? '保留原值',
    showWindow: showWindow ?? '保留原值',
    windowPosition: windowPosition ?? '保留原值',
    bytes: Buffer.byteLength(out, 'utf8'),
  };
}

/** 参数面板控件块（指南路线 D：InnerWidget + BoundsAttr；控件名与 <Parameter> 同名自动绑定） */
function paramWidgetXml(type, { name, label, dictionary, items, defaultValue, text, x, y, width, height, fontName, fontSize, noBorder }) {
  // M81: 字体/边框只允许 Label（输入框字体走主题，往别的类写属臆造形态，拒绝）
  if ((fontName != null && String(fontName).trim() !== '') || noBorder === true || String(noBorder).toLowerCase() === 'true') {
    if (type !== 'label') throw new Error(`字体/边框只支持 type="label"（标签），当前 type="${type}"`);
  }
  // V2: BoundsAttr 数字防御 —— Number("abc")=NaN 会把 x="NaN" 写进 XML（合法但布局损坏）
  const pos = (v, dflt) => {
    const n = Number(v);
    if (!Number.isFinite(n)) throw new Error(`参数控件 ${name} 的位置/尺寸非法：${JSON.stringify(v)}（必须是数字）`);
    return n;
  };
  const xi = pos(x), yi = pos(y), wi = pos(width), hi = pos(height);
  const wattr = `<WidgetAttr aspectRatioLocked="false" aspectRatioBackup="0.0" description="">
<MobileBookMark useBookMark="false" bookMarkName="" frozen="false"/>
<PrivilegeControl/>
</WidgetAttr>`;
  const wv = (v) => `<widgetValue>
<O>
<![CDATA[${assertSafeCdata(v ?? '', `控件 ${name} 值`)}]]></O>
</widgetValue>`;
  const nameTag = `<WidgetName name="${escapeXmlAttr(name)}"/>`;
  const labelTag = label != null ? `<LabelName name="${escapeXmlAttr(label)}"/>` : '';
  // 下拉类字典 XML：与单元格控件侧共用同一实现（M109 抽出），错误文案保留"参数控件 <名>"前缀
  const dictXml = (dictionary, items) => dictionaryXml({ dictionary, items, label: `参数控件 ${name}` });
  // 2026-10-29 修复：复选类控件必须有字典（CheckBoxGroup/ComboCheckBox 无选项时 ACL 渲染为空控件，
  // 用户看到的就是「筛选控件异常」——此前 checkBox 分支连 Dictionary 都不写，items 被静默丢弃）。
  const hasDictSource = dictionary != null || (Array.isArray(items) && items.length > 0);
  let inner;
  switch (type) {
    case 'comboBox': {
      inner = `<InnerWidget class="com.fr.form.ui.ComboBox">
${nameTag}
${labelTag}
${wattr}
${dictXml(dictionary, items)}
${wv(defaultValue)}
</InnerWidget>`;
      break;
    }
    case 'comboCheckBox': {
      // 下拉多选（用户转多选场景：返回值=字符串、分隔符 ','——RAAttr 实证形态同 cell 侧 comboCheckBox）
      if (!hasDictSource) throw new Error(`参数控件 ${name}（comboCheckBox）必须提供 dictionary 或非空 items：下拉多选没有选项会渲染成空控件`);
      inner = `<InnerWidget class="com.fr.form.ui.ComboCheckBox">
${nameTag}
${labelTag}
${wattr}
${dictXml(dictionary, items)}
${wv(defaultValue)}
<RAAttr delimiter="&apos;,&apos;" isArray="false"/>
</InnerWidget>`;
      break;
    }
    case 'text':
      inner = `<InnerWidget class="com.fr.form.ui.TextEditor">
${nameTag}
${labelTag}
${wattr}
<TextAttr/>
${wv(defaultValue)}
</InnerWidget>`;
      break;
    case 'textarea':
      // 多行文本框（V4 会话缺口：textarea 此前被 alias 静默降级成 text）
      inner = `<InnerWidget class="com.fr.form.ui.TextArea">
${nameTag}
${labelTag}
${wattr}
<TextAttr/>
<Reg class="com.fr.form.ui.reg.NoneReg"/>
${wv(defaultValue)}
</InnerWidget>`;
      break;
    case 'date':
      inner = `<InnerWidget class="com.fr.form.ui.DateEditor">
${nameTag}
${labelTag}
${wattr}
<DateAttr/>
${wv(defaultValue)}
</InnerWidget>`;
      break;
    case 'checkBox': {
      // 复选组：官方实证形态（demo/parameter/下拉树与动态显示查询.cpt 等）= Dictionary 之后 widgetValue、
      // 末尾 RAAttr（返回值字符串、分隔符 ','）。此前缺 Dictionary + RAAttr，items 传了也不落盘 → 空复选组。
      if (!hasDictSource) throw new Error(`参数控件 ${name}（checkBox）必须提供 dictionary 或非空 items：复选组没有选项会渲染成空控件（此前会静默丢弃 items，本次已改为报错）`);
      inner = `<InnerWidget class="com.fr.form.ui.CheckBoxGroup">
${nameTag}
${labelTag}
${wattr}
${dictXml(dictionary, items)}
${wv(defaultValue)}
<RAAttr isArray="false" delimiter="&apos;,&apos;"/>
</InnerWidget>`;
      break;
    }
    case 'label': {
      // M81: 标签字体/边框（OEM成品计划表.cpt 实证：LabelAttr 之后跟 FRFont + border style=0）
      let fontXml = '';
      if (fontName != null && String(fontName).trim() !== '') {
        const fs = fontSize !== undefined && fontSize !== null ? Number(fontSize) : 96;
        if (!Number.isFinite(fs) || fs <= 0) throw new Error(`参数控件 ${name} 的 fontSize 非法（设计器常用 96）`);
        fontXml = `<FRFont name="${escapeXmlAttr(String(fontName).trim())}" style="0" size="${fs}"/>`;
      }
      const borderXml = noBorder === true || String(noBorder).toLowerCase() === 'true'
        ? `<border style="0">
<color>
<FineColor color="-723724" hor="-1" ver="-1"/>
</color>
</border>`
        : '';
      inner = `<InnerWidget class="com.fr.form.ui.Label">
${nameTag}
${wv(defaultValue != null ? defaultValue : (label != null ? label : name))}
<LabelAttr verticalcenter="true" textalign="0" autoline="true"/>
${fontXml}${borderXml}</InnerWidget>`;
      break;
    }
    case 'submitButton':
      inner = `<InnerWidget class="com.fr.form.parameter.FormSubmitButton">
<WidgetName name="${escapeXmlAttr(name)}"/>
<Text>
<![CDATA[${assertSafeCdata(text ?? '查询', '按钮文字')}]]></Text>
<Hotkeys>
<![CDATA[enter]]></Hotkeys>
</InnerWidget>`;
      break;
    default:
      throw new Error(`不支持的参数控件类型 "${type}"：comboBox/comboCheckBox/text/textarea/date/checkBox/label/submitButton`);
  }
  return `<Widget class="com.fr.form.ui.container.WAbsoluteLayout$BoundsWidget">
${inner}
<BoundsAttr x="${xi}" y="${yi}" width="${wi}" height="${hi}"/>
</Widget>
`;
}

/** 参数面板「可见标签」控件（官方设计器形态 = 独立 Label BoundsWidget，位于控件左侧）。
 *  2026-10-29 修复：「缺少标签」的根因是此前只写 InnerWidget 里的 <LabelName>，而 Web 参数面板
 *  不渲染 LabelName（预览实测无标签）。官方 demo/analytics/套打.cpt 等样本都用独立 Label 控件显示标签。 */
function paramLabelWidgetXml(labelName, text, x, y, width, height) {
  return `<Widget class="com.fr.form.ui.container.WAbsoluteLayout$BoundsWidget">
<InnerWidget class="com.fr.form.ui.Label">
<WidgetName name="${escapeXmlAttr(labelName)}"/>
<widgetValue>
<O>
<![CDATA[${assertSafeCdata(text, '参数控件标签')}]]></O>
</widgetValue>
<LabelAttr verticalcenter="true" textalign="0" autoline="true"/>
<FRFont name="微软雅黑" style="0" size="96"/>
<border style="0">
<color>
<FineColor color="-723724" hor="-1" ver="-1"/>
</color>
</border>
</InnerWidget>
<BoundsAttr x="${x}" y="${y}" width="${width}" height="${height}"/>
</Widget>
`;
}

/** 标签宽度估算（中文按 22px/字；官方样本 4 字标签约 90px）。 */
function labelWidthFor(text) {
  const chars = [...String(text ?? '')].length;
  return Math.max(56, Math.min(200, chars * 22 + 2));
}

/** 估算参数面板可用宽度（px）：由 ReportSettings/PaperSetting 反推有效页宽（横向时取高边），
 *  兜底 A4 纵向 210mm。参数面板控件坐标即 px（设计器 96dpi）。 */
function paramPanelWidthPx(raw) {
  const open = raw.match(/<PaperSetting\b[^>]*>/);
  const orientation = open && /\borientation="1"/.test(open[0]) ? 1 : 0;
  let wMm = 210, hMm = 297;
  const size = raw.match(/<PaperSize\b[^>]*\bwidth="(\d+)"[^>]*\bheight="(\d+)"/);
  if (size) { wMm = Number(size[1]) / 144000; hMm = Number(size[2]) / 144000; }
  const effMm = orientation === 1 ? hMm : wMm;
  return Math.round(effMm * 96 / 25.4);
}

/** 参数面板自动落位（不传 x/y 时）：接在最后一行可见控件右侧，超出面板宽度则换到下一行；
 *  隐藏控件（WidgetAttr invisible="true"）不占可见布局，不参与计算。返回 {x,y}。 */
function autoParamPlacement(panelSeg, panelWidthPx, width) {
  const blocks = [...panelSeg.matchAll(/<Widget class="com\.fr\.form\.ui\.container\.WAbsoluteLayout\$BoundsWidget">([\s\S]*?)<\/Widget>/g)];
  const boxes = [];
  for (const b of blocks) {
    if (/<WidgetAttr[^>]*\binvisible="true"/.test(b[1])) continue; // 隐藏控件不占可见布局
    const ba = b[1].match(/<BoundsAttr x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)"\/>/);
    if (!ba) continue;
    const [x, y, bw, bh] = [Number(ba[1]), Number(ba[2]), Number(ba[3]), Number(ba[4])];
    if ([x, y, bw, bh].every(Number.isFinite)) boxes.push({ x, y, w: bw, h: bh });
  }
  if (boxes.length === 0) return { x: 5, y: 5 };
  const lastY = Math.max(...boxes.map((b) => b.y));
  const rowRight = Math.max(...boxes.filter((b) => b.y === lastY).map((b) => b.x + b.w));
  const bottom = Math.max(...boxes.map((b) => b.y + b.h));
  const limit = Math.max(panelWidthPx - 5, 300);
  if (rowRight + 5 + width <= limit) return { x: Math.round(rowRight + 5), y: Math.round(lastY) };
  return { x: 5, y: Math.round(bottom + 5) };
}

/** 在参数面板新增筛选控件（指南路线 D）：控件名与 <Parameter> 同名自动绑定；位置由 BoundsAttr 决定。
 *  2026-10-29 布局修复：x/y 不传时自动接在现有控件右侧/换行（此前默认 (10,10)，连续新增会全部叠在左上角，
 *  这正是「筛选控件样式/位置异常」的高频根因）；要自定义布局仍可显式传 x/y。
 *  M117 同名防护：面板内已存在同名控件时默认**拒绝**（此前无条件追加会静默产生两个同名控件，面板行为不确定）；
 *  确需并存（罕见）须显式 allowDuplicate=true。 */
export function addParameterWidget(filePath, {
  name, type = 'text', label, dictionary, items, defaultValue = '',
  x, y, width = 100, height = 24, text, hidden = false,
  fontName, fontSize, noBorder, // M81: 仅 type=label 有效（标签字体/无边框）
  allowDuplicate = false, // M117: 同名逃生舱（boolish 口径）
} = {}) {
  if (!name) throw new Error('必须提供控件名 name（与参数同名绑定）');
  // 2026-11-05：模型语感写法（textEditor/select/dropdown…）归一为 FR 官方 7 类控件；
  // batch 路径不经过 server 的 arg-normalize，故在 lib 入口再兜一次（与单品同一口径）。
  const widgetType = canonicalWidgetType(type);
  if (widgetType.changed) type = widgetType.type;
  const { raw } = load(filePath);
  let out = raw;
  // 1) 确保 ReportParameterAttr 存在
  let start = out.indexOf('<ReportParameterAttr>');
  if (start < 0) {
    const r = ensureParamPanel(out);
    out = r.out;
    start = r.start;
  }
  // 2) 确保 ParameterUI 存在
  if (!out.includes('<ParameterUI', start)) {
    const end = out.indexOf('</ReportParameterAttr>', start);
    if (end < 0) throw new Error('定位失败：ReportParameterAttr 未闭合');
    out = out.slice(0, end) + PARAM_UI_SKELETON + '\n' + out.slice(end);
  }
  // 3) 确保 Layout 存在，并在其末尾插入 Widget
  let layoutEnd = out.indexOf('</Layout>', start);
  if (layoutEnd < 0) {
    const uiEnd = out.indexOf('</ParameterUI>', start);
    if (uiEnd < 0) throw new Error('定位失败：ParameterUI 未闭合');
    // 对齐官方 Layout 骨架（含官方尾部元素 NameTagModified/WidgetNameTagMap/ParamAttr，
    // 缺失会导致参数面板布局尾部不完整、设计器打不开——sandbox4 事故复盘）
    const layout = `<Layout class="com.fr.form.ui.container.WParameterLayout">
<WidgetName name="para"/>
<Margin top="1" left="1" bottom="1" right="1"/>
<LCAttr vgap="0" hgap="0" compInterval="0"/>
<NameTagModified/>
<WidgetNameTagMap/>
<ParamAttr class="com.fr.report.mobile.DefaultMobileParamStyle"/>
</Layout>`;
    out = out.slice(0, uiEnd) + layout + '\n' + out.slice(uiEnd);
    layoutEnd = out.indexOf('</Layout>', start);
  }
  // 2026-10-29 自动布局：x/y 未传（或只传其一）时自动接在现有控件右侧/换行，避免默认 (10,10) 全重叠
  const panelSeg0 = out.slice(start, layoutEnd);
  const autoPlaced = !hidden && (x == null || y == null);
  // 可见标签 = 独立 Label 控件（LabelName 在 Web 参数面板不渲染）；hidden 隐藏控件不配可见标签
  const showLabel = !hidden && label != null && String(label).trim() !== '' && type !== 'label';
  const lw = showLabel ? labelWidthFor(label) : 0;
  let labelName = null;
  if (showLabel) {
    const base = `lbl_${name}`;
    let cand = base, k = 2;
    while (panelSeg0.includes(`<WidgetName name="${cand}"/>`)) cand = `${base}_${k++}`;
    labelName = cand;
  }
  let finalX = x, finalY = y;
  if (autoPlaced) {
    const placed = autoParamPlacement(panelSeg0, paramPanelWidthPx(out), showLabel ? lw + 2 + Number(width) : Number(width));
    finalX = showLabel ? placed.x + lw + 2 : placed.x;
    finalY = placed.y;
  } else if (showLabel) {
    // 显式 x/y 视为控件坐标：标签贴左侧；空间不足（labelX<5）整体右移，保证标签完整可见
    const labelX = Number(finalX) - lw - 2;
    if (labelX < 5) finalX = Number(finalX) + (5 - labelX);
  }
  if (hidden && (finalX == null || finalY == null)) { finalX = 0; finalY = 0; }
  const widget = paramWidgetXml(type, { name, label, dictionary, items, defaultValue, text, x: finalX, y: finalY, width, height, fontName, fontSize, noBorder });
  const labelWidget = showLabel
    ? paramLabelWidgetXml(labelName, String(label), Math.round(Number(finalX) - lw - 2), Number(finalY), lw, Number(height))
    : '';
  // M117 同名防护：面板 Layout 内已有同名 <WidgetName> 时默认拒绝（此前静默追加第二个同名控件）。
  // 检查范围限定 <ReportParameterAttr> 块内、插入点之前 —— 含 Layout 自身的 "para"。
  const allowDup = allowDuplicate === true || String(allowDuplicate).toLowerCase() === 'true';
  if (!allowDup) {
    const dupRe = new RegExp(`<WidgetName name="${escapeXmlAttr(name)}"/>`);
    if (dupRe.test(out.slice(start, layoutEnd))) {
      throw new Error(`add_parameter_widget: 参数面板已存在同名控件 "${name}"（同名重复会静默产生两个控件，面板行为不确定，已拒绝）。改属性/字典请用 update_parameter_widget；要改名请用 rename_parameter_widget；确需先删旧再建请用 delete_parameter_widget；若确实要刻意并存同名控件，请显式传 allowDuplicate=true。`);
    }
  }
  let insertXml = labelWidget + widget;
  // hidden 隐藏控件：自动停靠到现有控件占位的右下边界（max(x+width), max(y+height)），
  // 不占用可见区域 —— 如 fine_username 等需要隐藏传值的系统控件。
  if (hidden) {
    const layoutSeg = out.slice(0, layoutEnd);
    const bRe = /<BoundsAttr x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)"\/>/g;
    let m2, maxX = 0, maxY = 0, found = false;
    while ((m2 = bRe.exec(layoutSeg)) !== null) {
      found = true;
      maxX = Math.max(maxX, Number(m2[1]) + Number(m2[3]));
      maxY = Math.max(maxY, Number(m2[2]) + Number(m2[4]));
    }
    finalX = found ? maxX : (finalX ?? 0);
    finalY = found ? maxY : (finalY ?? 0);
    const bm = widget.match(/<BoundsAttr x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)"\/>/);
    if (!bm) throw new Error(`参数控件 ${name} 的 BoundsAttr 缺失（内部错误）`);
    const posXml = `<BoundsAttr x="${finalX}" y="${finalY}" width="${bm[3]}" height="${bm[4]}"/>`;
    insertXml = widget.replace(bm[0], posXml);
  }
  out = out.slice(0, layoutEnd) + insertXml + out.slice(layoutEnd);
  // 4) 追加同名 Parameter（同名自动绑定；不存在才加）
  const segEnd = out.indexOf('</ReportParameterAttr>', start);
  if (segEnd < 0) throw new Error('定位失败：ReportParameterAttr 未闭合');
  const attrSeg = out.slice(start, segEnd);
  const paramRe = new RegExp(`<Attributes name="${escapeXmlAttr(name)}"/>`);
  if (!paramRe.test(attrSeg)) {
    const pBlock = `<Parameter>
<Attributes name="${escapeXmlAttr(name)}"/>
<O>
<![CDATA[${assertSafeCdata(defaultValue ?? '', `参数 ${name} 默认值`)}]]></O>
</Parameter>
`;
    out = out.slice(0, segEnd) + pBlock + out.slice(segEnd);
  }
  save(filePath, out);
  const ret = { action: 'add_parameter_widget', name, type, x: finalX, y: finalY, width, height, bytes: Buffer.byteLength(out, 'utf8') };
  if (hidden) ret.hidden = true;
  if (showLabel) ret.labelWidget = { name: labelName, x: Math.round(Number(finalX) - lw - 2), y: Number(finalY), width: lw, height: Number(height) };
  if (autoPlaced) { ret.autoPlaced = true; ret.hint = '未传 x/y，已自动排在现有控件右侧（超出面板宽度自动换行）；如需精确布局用 update_parameter_widget 调 x/y/width/height'; }
  return ret;
}

// ---------------- set_grid：行高 / 列宽 ----------------

/** 设置行高/列宽（替换 RowHeight/ColumnWidth 的 defaultValue 与 CDATA；可传数组或仅数量） */
export function setGrid(filePath, { rowHeights, columnWidths, rowCount, columnCount, updateDefault = false, sheet } = {}) {
  // 防御：禁止 rowHeights/columnWidths 为空数组（会把 CDATA 刷成空字符串，破坏布局）
  if (Array.isArray(rowHeights) && rowHeights.length === 0) {
    throw new Error('set_grid: rowHeights 不能为空数组（请提供至少 1 个值或省略改用 rowCount）');
  }
  if (Array.isArray(columnWidths) && columnWidths.length === 0) {
    throw new Error('set_grid: columnWidths 不能为空数组（请提供至少 1 个值或省略改用 columnCount）');
  }
  const { raw } = load(filePath);
  let out = raw;
  const apply = (tag, values, count, defaultValue, what) => {
    const target = locateSheet(out, sheet ?? 0);
    const targetXml = out.slice(target.start, target.end);
    // 正则定位 defaultValue 属性（不依赖其在标签中的顺序）
    const re = new RegExp(`<${tag}\\s[^>]*\\bdefaultValue="`);
    const m = re.exec(targetXml);
    if (!m) throw new Error(`定位失败：未找到 <${tag} defaultValue>`);
    const o = target.start + m.index + m[0].length;
    const dvEnd = out.indexOf('"', o);
    if (dvEnd < 0) throw new Error(`定位失败：<${tag}> defaultValue 未闭合`);
    const cb = out.indexOf('<![CDATA[', dvEnd);
    if (cb < 0) throw new Error(`定位失败：<${tag}> 无 CDATA`);
    const ce = out.indexOf(']]>', cb + 9);
    if (ce < 0) throw new Error(`定位失败：<${tag}> CDATA 未闭合`);
    // 生成新 CSV：数组优先，其次按 count 平铺 defaultValue；均未提供则不动任何内容
    let csv = null;
    let list = null;
    if (Array.isArray(values)) {
      // V3: 元素必须是有限数字 —— NaN 混进 CSV 会静默损坏布局且审查侧无感知
      list = values.map(Number);
      if (list.some((n) => !Number.isFinite(n))) {
        throw new Error(`set_grid: ${what} 数组含非数字元素（${values.filter((v) => !Number.isFinite(Number(v))).map((v) => JSON.stringify(v)).join('、')}），已拒绝`);
      }
      if (count != null) {
        while (list.length < count) list.push(defaultValue);
        list = list.slice(0, count);
      }
      csv = list.join(',');
    } else if (count != null) {
      csv = Array.from({ length: count }, () => defaultValue).join(',');
    }
    if (csv == null) return null; // 无参数：不修改（尤其不得把现有 defaultValue 重写为常量）
    // defaultValue 属性：count 平铺更新为平铺值；数组默认保留模板原值，updateDefault=true 时更新为数组首值
    const newDefault = list != null
      ? (updateDefault && list.length > 0 ? String(list[0]) : out.slice(o, dvEnd))
      : String(defaultValue);
    // 从后往前替换，避免偏移失效（CDATA 在 defaultValue 之后）
    out = out.slice(0, cb + 9) + csv + out.slice(ce);
    out = out.slice(0, o) + newDefault + out.slice(dvEnd);
    return csv;
  };
  // 仅当提供了对应参数时才处理，避免静默改写模板的 defaultValue/CDATA
  const rowsCsv = (rowHeights !== undefined || rowCount !== undefined)
    ? apply('RowHeight', rowHeights, rowCount, DEF_ROW_H, 'RowHeight') : null;
  const colsCsv = (columnWidths !== undefined || columnCount !== undefined)
    ? apply('ColumnWidth', columnWidths, columnCount, DEF_COL_W, 'ColumnWidth') : null;
  save(filePath, out);
  return { action: 'set_grid', sheet: sheet ?? 0, rowHeights: rowsCsv, columnWidths: colsCsv, bytes: Buffer.byteLength(out, 'utf8') };
}


