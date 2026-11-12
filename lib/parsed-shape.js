// cpt-mcp/lib/parsed-shape.js —— fast-xml-parser 解析结果的小工具（leaf：零 lib 依赖）
//
// 2026-10-29 整理：asArray / asReports 曾在 cpt.js、validate.js、fill-integrity.js、sql-check.js、
// engine/reason.js 五处逐字节重复，unescapeXml 在 cpt.js 与 edits.js 各有一份。
// 这些是"读同一份 XML 必须同口径"的底层函数，副本漂移会让不同工具对同一文件给出不同结论，
// 因此收敛到这里；需要改口径时只改一处。
//
// 口径说明（P0-2）：CDATA 是字面量区，读回一律原文不反转义（val/cells/checkReportJs 均如此），
// 读回的 JS 与落盘字节一致；"判定"那一步才解码（见 cpt.js 的 decodeFrJsForParse）。
// 纯文本节点/属性里的 XML 实体则需要 unescapeXml。

export const asArray = (x) => (Array.isArray(x) ? x : x == null ? [] : [x]);

/** 规范化 WorkBook 下所有工作表：[{ report, sheet(名), index }] */
export const asReports = (parsed) => asArray(parsed?.WorkBook?.Report).map((r, i) => ({
  report: r, sheet: r['@_name'] || `sheet${i + 1}`, index: i,
}));

export const cdataOf = (x) => (x && typeof x === 'object' && '__cdata' in x ? x.__cdata : x);

// XML 实体反转义（fast-xml-parser parseAttributeValue:false 不解码属性实体，读取端需自行解码）
export const unescapeXml = (s) => String(s ?? '')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&amp;/g, '&');
