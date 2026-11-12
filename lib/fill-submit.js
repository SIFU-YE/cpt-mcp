// cpt-mcp/lib/fill-submit.js —— 自由 SQL 提交（FreeSQLSubmiter）的「提交参数」声明（leaf：只依赖 ./format.js）
//
// 背景（sandbox4/v1 会话实测，2026-10-30）：add_fill_submit 的自由 SQL 形态只写 DBName+SQL，
// 不声明 <Parameters>；FR 不会自动把报表参数注入 ${x} 占位 —— SQL 原样进数据库，运行时报
// `Truncated incorrect INTEGER value: '${del_id}'`。会话里 update_report_node 又没有安全补参数的
// 能力（重写节点丢 class / attributes 未命中会静默新插），最终结论是"cpt-mcp 没有安全添加提交参数的能力"。
//
// 本模块把「SQL 里 ${x} 引用 → <Parameter><Attributes name="x"/><O><![CDATA[=$x]]></O></Parameter>」
// 收敛为唯一实现，供 add_fill_submit（新建提交）与 update_fill_submit（改 SQL / 改参数）共用：
//   · 只认裸标识符 ${name}；${if(...)} 这类 FR 公式保持原样、不自动声明（避免把公式当参数名）；
//   · 显式 parameters 可覆盖取值（value 缺省 =$name）；
//   · 改 SQL 时只补缺失声明、不动已有声明（自定义取值不会被覆盖）。

import { assertSafeCdata, escapeXmlAttr } from './format.js';

/** SQL 里 ${name} 形式的提交参数引用（裸标识符口径） */
export const SUBMIT_PARAM_REF_RE = /\$\{([a-zA-Z_][\w]*)\}/g;

/** 提取 SQL 引用的提交参数名（去重、保持出现顺序） */
export function submitParamRefs(sql) {
  const out = [];
  for (const m of String(sql ?? '').matchAll(SUBMIT_PARAM_REF_RE)) {
    if (!out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

/**
 * 计算要写入的提交参数声明。
 * @param {string} sql 提交 SQL（用于自动收集 ${x} 引用）
 * @param {Array<{name:string,value?:string}>|undefined} parameters 显式声明（覆盖同名自动声明的取值）
 * @returns {Array<{name:string,value:string}>}
 */
export function normalizeSubmitParameters(sql, parameters) {
  const wanted = new Map();
  for (const name of submitParamRefs(sql)) wanted.set(name, `=$${name}`);
  if (parameters != null) {
    if (!Array.isArray(parameters)) throw new Error('提交参数 parameters 必须是数组：[{name:"del_id"} 或 {name:"x", value:"=$x"}]');
    for (const p of parameters) {
      const name = String(p?.name ?? '').trim();
      if (!name) throw new Error('提交参数 parameters[].name 不能为空（示例：[{name:"del_id"}]）');
      if (!/^[A-Za-z_][\w]*$/.test(name)) {
        throw new Error(`非法提交参数名 "${name}"（只允许字母/下划线开头，后续字母数字下划线）`);
      }
      const raw = p?.value;
      const value = raw != null && String(raw).trim() !== '' ? String(raw) : `=$${name}`;
      wanted.set(name, value);
    }
  }
  return [...wanted.entries()].map(([name, value]) => ({ name, value }));
}

/** 生成 <Parameters> 块（无声明返回空串；调用方决定是否省略该块） */
export function submitParametersXml(list) {
  if (!list || list.length === 0) return '';
  const parts = list.map((p) => `<Parameter>
<Attributes name="${escapeXmlAttr(p.name)}"/>
<O>
<![CDATA[${assertSafeCdata(p.value, `提交参数 ${p.name}`)}]]></O>
</Parameter>`);
  return `<Parameters>
${parts.join('\n')}
</Parameters>
`;
}

/** 从 SubmitVisitor 片段读已声明的参数名（raw 文本口径，用于「改 SQL 时保留既有声明」） */
export function readSubmitParameterNames(submitSeg) {
  const seg = String(submitSeg ?? '');
  const pi = seg.search(/<Parameters\b/);
  if (pi < 0) return [];
  const closeTag = '</Parameters>';
  const ci = seg.indexOf(closeTag, pi);
  const xml = ci < 0 ? seg.slice(pi) : seg.slice(pi, ci + closeTag.length);
  return [...xml.matchAll(/<Attributes\b[^>]*\bname="([^"]*)"/g)].map((m) => m[1]);
}

/**
 * 整块替换/插入 <Parameters>（list 为空 → 写自闭合 <Parameters/>；片段内没有该块 → 插到 </SubmitVisitor> 前）。
 * 用于「显式传 parameters」的语义：以传入列表为准。
 */
export function replaceSubmitParameters(submitSeg, list) {
  const seg = String(submitSeg ?? '');
  const block = list && list.length ? submitParametersXml(list).trimEnd() : '<Parameters/>';
  if (/<Parameters\s*\/>/.test(seg)) return seg.replace(/<Parameters\s*\/>/, () => block);
  const open = seg.indexOf('<Parameters>');
  if (open >= 0) {
    const close = seg.indexOf('</Parameters>', open);
    if (close < 0) throw new Error('提交块内 <Parameters> 未闭合，无法安全替换（请先读回确认结构）');
    return seg.slice(0, open) + block + seg.slice(close + '</Parameters>'.length);
  }
  const closeVisitor = seg.lastIndexOf('</SubmitVisitor>');
  if (closeVisitor < 0) throw new Error('提交块缺少 </SubmitVisitor>，无法插入提交参数');
  return seg.slice(0, closeVisitor) + block + '\n' + seg.slice(closeVisitor);
}

/**
 * 补齐缺失声明（保留已有参数及其自定义取值）—— 改 SQL 时用：
 * 新 SQL 里新出现的 ${x} 自动追加声明，已有声明原样不动。
 */
export function ensureSubmitParameters(submitSeg, decls) {
  const seg = String(submitSeg ?? '');
  const existing = new Set(readSubmitParameterNames(seg));
  const missing = (decls || []).filter((d) => !existing.has(d.name));
  if (missing.length === 0) return seg;
  const addXml = submitParametersXml(missing).trimEnd().replace(/^<Parameters>\n?/, '').replace(/\n?<\/Parameters>$/, '');
  if (/<Parameters\s*\/>/.test(seg)) {
    return seg.replace(/<Parameters\s*\/>/, () => `<Parameters>\n${addXml}\n</Parameters>`);
  }
  const open = seg.indexOf('<Parameters>');
  if (open >= 0) {
    const close = seg.indexOf('</Parameters>', open);
    if (close < 0) throw new Error('提交块内 <Parameters> 未闭合，无法安全追加提交参数（请先读回确认结构）');
    return seg.slice(0, close) + addXml + '\n' + seg.slice(close);
  }
  const closeVisitor = seg.lastIndexOf('</SubmitVisitor>');
  if (closeVisitor < 0) throw new Error('提交块缺少 </SubmitVisitor>，无法插入提交参数');
  return seg.slice(0, closeVisitor) + submitParametersXml(missing) + seg.slice(closeVisitor);
}
