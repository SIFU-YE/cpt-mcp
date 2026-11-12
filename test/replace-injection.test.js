// test/replace-injection.test.js —— M117-r2：String.replace 替换文本特殊序列（$$ / $& / $` / $'）的
// 仓级回归门 + F1–F7 行为测试
//
// 背景（t3 复核 F1–F9）：
//  `str.replace(pattern, 替换文本)` 的第二参是**字符串**时，替换文本里的 `$$`/`$&`/`` $` ``/`$'` 会被当
//  特殊序列展开：`$$`→`$`（静默吃掉一个 $，官方公式普遍含 `$$$`）；`$&`→**匹配到的整个子串**
//  （实测 fontName="A$&B" 把 `</InnerWidget>` 注入属性值 → XML 非法，但 isError=false、validate_cpt 漏报）。
//  正确写法一律是函数式替换 `replace(pat, () => 文本)`。
//
// 本文件做两件事：
//  ① 仓级扫描 `lib/**` + `server.js`（词法级：字符串/注释/正则/模板文本都不算代码，模板 ${} 内插里的
//     代码算），任何"第二参含变量插值"的字符串式 replace 都失败；仅白名单里逐条写明理由的"确认不可达"
//     点豁免（并锁出现次数，新增同形态会红）。
//  ② F1–F7 的落盘行为断言：`$` 载荷必须**原样**落盘（不被吞、不被注入），落盘 XML 良构且 validate 0 error；
//     无 `$` 载荷的产出与"字符串式替换"逐字节等价（等价性见 §等价性测试）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { XMLValidator } from 'fast-xml-parser';
import { createCpt, addDataset, addParameterWidget, setParameterPanel, addFloatElement } from '../lib/generate.js';
import { updateParameterWidget, setWebWriteExtras, updateFloatElement } from '../lib/edits.js';
import { addChart } from '../lib/engine/chart.js';
import { updateStyleBatch } from '../lib/batch.js';
import { validateCpt } from '../lib/validate.js';
import { parameterPanel } from '../lib/cpt.js';
import '../scripts/isolate-store.mjs'; // M123：JS 基线 store 隔离，直跑也不污染真实 store

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-replinj-'));
const errCount = (p) => validateCpt(p).filter((x) => x.severity === 'error').length;
/** XML 良构断言：fast-xml-parser 的 XMLValidator（与 lib/xml.js 同一口径） */
const assertWellFormed = (raw, what) => {
  const r = XMLValidator.validate(raw);
  assert.equal(r, true, `${what} 落盘 XML 应良构，实际：${JSON.stringify(r)}`);
};
/** 测试自建 fixture 时也要防 `$$` 被吞：一律用函数式替换 */
const inject = (raw, needle, replacement) => raw.replace(needle, () => replacement);

// ============================ 扫描器（词法级） ============================
// 为什么不用简单正则扫 `.replace(`：源码里大量 `.replace(` 出现在**模板字面量文本**与注释里（不是可执行
// 代码），朴素正则会把它们误报；而模板 `${}` 内插里的 `.replace(` 又是真代码，不能漏。故按词法切分。
const REGEX_PREV_KEYWORDS = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'case', 'do', 'else', 'yield', 'await', 'throw']);
const NOT_REGEX_AFTER = new Set([')', ']', '}']);
const REGEX_PREV_CHARS = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^', '']);
const regexAllowed = (prev) => {
  if (!prev) return true;
  if (prev.type === 'punct') return !NOT_REGEX_AFTER.has(prev.value);
  if (prev.type === 'ident') return REGEX_PREV_KEYWORDS.has(prev.value);
  return false;
};
function skipString(src, i) {
  const q = src[i];
  let j = i + 1;
  while (j < src.length) { if (src[j] === '\\') j += 2; else if (src[j] === q) return j + 1; else j++; }
  return src.length;
}
function skipRegex(src, i) {
  let j = i + 1;
  let inClass = false;
  while (j < src.length) {
    const ch = src[j];
    if (ch === '\\') { j += 2; continue; }
    if (ch === '[') { inClass = true; j++; continue; }
    if (ch === ']') { inClass = false; j++; continue; }
    if (ch === '\n') return -1;
    if (ch === '/' && !inClass) { j++; while (/[a-z]/i.test(src[j] || '')) j++; return j; }
    j++;
  }
  return -1;
}
function skipInterp(src, i) {
  let depth = 1;
  let prev = '';
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '/' && src[i + 1] === '/') { const j = src.indexOf('\n', i); i = j < 0 ? src.length : j; continue; }
    if (c === '/' && src[i + 1] === '*') { const j = src.indexOf('*/', i + 2); i = j < 0 ? src.length : j + 2; continue; }
    if (c === '"' || c === "'") { i = skipString(src, i); prev = 'x'; continue; }
    if (c === '`') { i = skipTemplate(src, i).end; prev = 'x'; continue; }
    if (c === '/') {
      if (REGEX_PREV_CHARS.has(prev)) { const end = skipRegex(src, i); if (end > i) { i = end; prev = 'x'; continue; } }
      prev = '/'; i++; continue;
    }
    if (c === '{') { depth++; prev = c; i++; continue; }
    if (c === '}') { depth--; prev = c; i++; if (depth === 0) return i; continue; }
    prev = c; i++;
  }
  return src.length;
}
function skipTemplate(src, i) {
  let j = i + 1;
  let hasInterp = false;
  while (j < src.length) {
    const c = src[j];
    if (c === '\\') { j += 2; continue; }
    if (c === '`') return { end: j + 1, hasInterp };
    if (c === '$' && src[j + 1] === '{') { hasInterp = true; j = skipInterp(src, j + 2); continue; }
    j++;
  }
  return { end: src.length, hasInterp };
}
function templateInterpRanges(src, i) {
  const ranges = [];
  let j = i + 1;
  while (j < src.length) {
    const c = src[j];
    if (c === '\\') { j += 2; continue; }
    if (c === '`') break;
    if (c === '$' && src[j + 1] === '{') { const start = j + 2; const end = skipInterp(src, start); ranges.push([start, end - 1]); j = end; continue; }
    j++;
  }
  return ranges;
}
function lex(src) {
  const tokens = [];
  let i = 0;
  let prev = null;
  const push = (type, start, end, extra = {}) => { const t = { type, start, end, ...extra }; tokens.push(t); prev = t; return t; };
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '/' && src[i + 1] === '/') { const j = src.indexOf('\n', i); const end = j < 0 ? src.length : j; push('comment', i, end); i = end; continue; }
    if (c === '/' && src[i + 1] === '*') { const j = src.indexOf('*/', i + 2); const end = j < 0 ? src.length : j + 2; push('comment', i, end); i = end; continue; }
    if (c === '"' || c === "'") { const end = skipString(src, i); push('string', i, end); i = end; continue; }
    if (c === '`') { const { end, hasInterp } = skipTemplate(src, i); push('template', i, end, { hasInterp }); i = end; continue; }
    if (c === '/') {
      if (regexAllowed(prev)) { const end = skipRegex(src, i); if (end > i) { push('regex', i, end); i = end; continue; } }
      push('punct', i, i + 1, { value: '/' }); i++; continue;
    }
    if (/[A-Za-z_$]/.test(c)) { let j = i + 1; while (j < src.length && /[A-Za-z0-9_$]/.test(src[j])) j++; push('ident', i, j, { value: src.slice(i, j) }); i = j; continue; }
    if (/[0-9]/.test(c)) {
      let j = i + 1;
      while (j < src.length && /[0-9a-fA-FxXoObBeE._]/.test(src[j])) { if ((src[j] === 'e' || src[j] === 'E') && /[+-]/.test(src[j + 1] || '')) j++; j++; }
      push('number', i, j, { value: src.slice(i, j) }); i = j; continue;
    }
    if (c === '=' && src[i + 1] === '>') { push('punct', i, i + 2, { value: '=>' }); i += 2; continue; }
    push('punct', i, i + 1, { value: c }); i++; continue;
  }
  return tokens;
}
/** 递归词法：模板 ${} 内插里的代码也纳入 token 流（否则内插里的 .replace 会漏扫） */
function lexAll(src, offset = 0) {
  const out = [];
  for (const t of lex(src)) {
    out.push({ ...t, start: t.start + offset, end: t.end + offset });
    if (t.type === 'template' && t.hasInterp) {
      for (const [s, e] of templateInterpRanges(src, t.start)) {
        for (const st of lexAll(src.slice(s, e), offset + s)) out.push(st);
      }
    }
  }
  out.sort((a, b) => a.start - b.start);
  return out;
}
function splitArgs(tokens, openIdx) {
  const args = [];
  let depth = 0;
  let start = openIdx + 1;
  for (let k = openIdx + 1; k < tokens.length; k++) {
    const t = tokens[k];
    if (t.type === 'punct') {
      if (t.value === '(' || t.value === '[' || t.value === '{') depth++;
      else if (t.value === ')' || t.value === ']' || t.value === '}') {
        if (t.value === ')' && depth === 0) { args.push([start, k]); return { args, closeIdx: k }; }
        depth--;
      } else if (t.value === ',' && depth === 0) { args.push([start, k]); start = k + 1; }
    }
  }
  return { args, closeIdx: tokens.length - 1 };
}
function classify(src, tokens, range) {
  const [a, b] = range;
  if (a >= b) return { kind: 'missing' };
  const ts = tokens.slice(a, b);
  const text = src.slice(ts[0].start, Math.max(...ts.map((t) => t.end)));
  if (ts[0].type === 'ident' && ts[0].value === 'function') return { kind: 'ok-function' };
  let depth = 0;
  for (const t of ts) {
    if (t.type === 'punct') {
      if (['(', '[', '{'].includes(t.value)) depth++;
      else if ([')', ']', '}'].includes(t.value)) depth--;
      else if (t.value === '=>' && depth === 0) return { kind: 'ok-arrow' };
    }
  }
  if (ts.length === 1) {
    const t = ts[0];
    if (t.type === 'string') return { kind: 'ok-string' };
    if (t.type === 'template') return t.hasInterp ? { kind: 'VIOLATION', text } : { kind: 'ok-template' };
    if (t.type === 'number') return { kind: 'ok-literal' };
    if (t.type === 'ident' && ['true', 'false', 'null'].includes(t.value)) return { kind: 'ok-literal' };
  }
  return { kind: 'VIOLATION', text };
}
/** 返回该源码里"替换文本可含变量插值"的字符串式 replace 站点 */
function scanSource(src) {
  const tokens = lexAll(src);
  const violations = [];
  for (let k = 0; k < tokens.length - 2; k++) {
    if (tokens[k].type === 'punct' && tokens[k].value === '.'
      && tokens[k + 1].type === 'ident' && tokens[k + 1].value === 'replace'
      && tokens[k + 2].type === 'punct' && tokens[k + 2].value === '(') {
      const { args, closeIdx } = splitArgs(tokens, k + 2);
      const c = classify(src, tokens, args[1] ?? [0, 0]);
      if (c.kind === 'VIOLATION') {
        violations.push({
          line: src.slice(0, tokens[k].start).split('\n').length,
          arg1: args[0] && args[0][1] > args[0][0] ? src.slice(tokens[args[0][0]].start, Math.max(...tokens.slice(args[0][0], args[0][1]).map((t) => t.end))) : '',
          arg2: c.text,
        });
      }
      k = closeIdx;
    }
  }
  return violations;
}
function listJsFiles(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') listJsFiles(p, acc); }
    else if (e.name.endsWith('.js')) acc.push(p);
  }
  return acc;
}
const norm = (s) => String(s).replace(/\s+/g, ' ').trim();

// ============================ 白名单（确认不可达，逐条理由） ============================
// 约定：只有"替换文本不可能含 `$`"的点才能进白名单 —— 替换文本来自用户输入或**文件内容**的一律修掉，
// 不许豁免。occurrences 锁出现次数：新增同形态会红，防止把可达点偷偷塞进白名单。
const WHITELIST = [
  {
    file: 'lib/edits.js', arg1: 're', arg2: '` ${key}="${value}"`', occurrences: 1,
    reason: 'setCellSpan.applyAttr：key 为字面量 cs/rs，value 由 norm() 收窄为 1-1000 整数（非用户字符串）',
  },
  {
    file: 'lib/edits.js', arg1: 'existBorder[0]', arg2: 'noBorderXml', occurrences: 1,
    reason: 'updateParameterWidget 边框：noBorderXml 是工具自造纯 XML 常量（无插值、无文件内容、无用户输入）',
  },
  {
    file: 'lib/edits.js', arg1: '/<\\/InnerWidget>\\s*$/', arg2: '`${noBorderXml}\\n</InnerWidget>`', occurrences: 1,
    reason: '同上，模板只插值自造常量 noBorderXml',
  },
  {
    file: 'lib/edits.js', arg1: 're', arg2: '`${attr}="${v}"`', occurrences: 2,
    reason: 'updateParameterWidget.setNum / updateFloatElement.setAttr：v = String(Number(...))，经 Number.isFinite/范围校验后只可能是数字字面量（两处同形态，count 锁死）',
  },
  {
    file: 'lib/edits.js', arg1: '/\\/>$/', arg2: '` ${attr}="${v}"/>`', occurrences: 2,
    reason: '同上（属性不存在时的追加支）',
  },
  {
    file: 'lib/edits.js', arg1: '/<FloatElementName name="[^"]*"/', arg2: '`<FloatElementName name="${safeNew}"`', occurrences: 1,
    reason: 'updateFloatElement 改名：newName 先经 /^[A-Za-z0-9_\\-\\u4e00-\\u9fa5]+$/ 收窄，`$` 不可能出现',
  },
  {
    file: 'lib/edits.js', arg1: 'sm[0]', arg2: '`<Style index="${si}"`', occurrences: 1,
    reason: 'updateFloatElement styleIndex：si 经 Number.isInteger + 范围校验',
  },
  {
    file: 'lib/generate.js', arg1: 'bm[0]', arg2: 'posXml', occurrences: 1,
    reason: 'addParameterWidget hidden 停靠：posXml 由 finalX/finalY/bm[3]/bm[4]（全为数字）拼成',
  },
];

// ============================ ① 仓级扫描门 ============================
test('仓级回归：lib/** 与 server.js 不得有"替换文本可含变量插值"的字符串式 replace', () => {
  const files = [...listJsFiles(path.join(ROOT, 'lib')), path.join(ROOT, 'server.js')];
  const found = [];
  for (const f of files) {
    const rel = path.relative(ROOT, f).replace(/\\/g, '/');
    for (const v of scanSource(fs.readFileSync(f, 'utf8'))) found.push({ file: rel, arg1: norm(v.arg1), arg2: norm(v.arg2), line: v.line });
  }
  // 白名单消费：按 (file, arg1, arg2) 计数比对
  const key = (x) => `${x.file}\u0000${x.arg1}\u0000${x.arg2}`;
  const counts = new Map();
  for (const v of found) counts.set(key(v), (counts.get(key(v)) ?? 0) + 1);
  const problems = [];
  for (const v of found) {
    const hit = WHITELIST.find((w) => key(w) === key(v));
    if (!hit) problems.push(`${v.file}:${v.line} 未豁免  arg1=${v.arg1}  arg2=${v.arg2}`);
  }
  for (const w of WHITELIST) {
    const n = counts.get(key(w)) ?? 0;
    if (n !== w.occurrences) problems.push(`白名单条目 ${w.file} arg2=${w.arg2} 期望 ${w.occurrences} 处，实际 ${n} 处（形态已变/被修好/新增同类点，请更新白名单）`);
    assert.ok(String(w.reason ?? '').length >= 8, `白名单条目 ${w.file} arg2=${w.arg2} 缺理由`);
  }
  assert.equal(problems.length, 0, `发现未豁免的字符串式 replace（替换文本可能含变量插值，改用 () => 文本）：\n${problems.join('\n')}`);
  assert.ok(files.length > 20, `扫描文件数异常：${files.length}`);
});

test('扫描器自检：能抓真违规、不误报常量与文本', () => {
  const bad = [
    'a.replace(re, x);',
    'a.replace(re, `p${x}q`);',
    'a.replace(re, x + y);',
    'a.replace(re, escapeXmlAttr(v));',
    'a.replace(re, String(Number(v)));',
  ];
  for (const s of bad) assert.equal(scanSource(s).length, 1, `应报违规：${s}`);
  const ok = [
    "a.replace(re, () => x);",
    "a.replace(re, function () { return x; });",
    "a.replace(re, '');",
    "a.replace(re, '&amp;');",
    "a.replace(re, '\\\\$&');", // escapeRegExp 惯用法：常量且是**故意**用 $&
    "a.replace(re, `plain`);",
    "a.replace(re, 123);",
    "a.replace(re, null);",
    "// a.replace(re, x)\n",
    "const doc = 'a.replace(re, x)';",
    "const doc = `a.replace(re, x)`;", // 模板文本（无插值）不是代码
  ];
  for (const s of ok) assert.equal(scanSource(s).length, 0, `不应报违规：${s}`);
  // 模板 ${} 内插里的 replace 是真代码，必须扫到
  assert.equal(scanSource('const a = `x${y.replace(re, z)}`;').length, 1, '模板内插里的 replace 必须扫到');
  // 正则字面量里的引号/括号不能把参数切错
  assert.equal(scanSource("a.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&');").length, 0, '正则内含引号/括号仍应正确分类为常量');
});

test('等价性：替换文本不含 $ 时，函数式替换与字符串式替换逐字节相同', () => {
  const cases = [
    ['<W><InnerWidget>X</InnerWidget></W>', /<\/InnerWidget>\s*$/, '<FRFont name="微软雅黑" style="0" size="96"/>\n</InnerWidget>'],
    ['<W><InnerWidget>X</InnerWidget></W>', /<\/InnerWidget>\s*$/, ' ${attr}="v"/>'],
    ['<FRFont name="旧"/>', /<FRFont\b[^>]*\/?>/, '<FRFont name="微软雅黑" style="0" size="96"/>'],
    ['<WebWriteContent><EditRowColor a="1"/>\n</WebWriteContent>', /<EditRowColor\b[^>]*\/>\n?/, '<EditRowColor a="D E"/>\n'],
    ['<TableDataMap name="x"/>', /<TableDataMap\b(?:\s[^>]*)?\/>/, '<TableDataMap name="x">\n<TableData a="1"/>\n</TableDataMap>'],
  ];
  for (const [s, p, t] of cases) {
    assert.equal(s.replace(p, t), s.replace(p, () => t), `函数式与字符串式应等价：${t}`);
  }
  // 反过来：含 $ 的载荷在字符串式下确实被改写（证明本门禁防的是真问题）
  const s = '<W></W>';
  assert.notEqual(s.replace(/<\/W>/, '</W$$>'), s.replace(/<\/W>/, () => '</W$$>'));
  assert.notEqual(s.replace(/<\/W>/, 'A$&B'), s.replace(/<\/W>/, () => 'A$&B'));
});

// ============================ ② F1–F7 行为断言 ============================
test('F1 fontName：$$ / $& / $\' 载荷原样落盘、XML 良构、validate 0 error（替换支 + 追加支）', () => {
  const d = tmp();
  const p = path.join(d, 'f1.cpt');
  createCpt(p, { rows: 3, columns: 3 });
  setParameterPanel(p, { title: '查询' });
  addParameterWidget(p, { name: 'lbl', type: 'label', x: 10, y: 10, width: 100, height: 24 });
  addParameterWidget(p, { name: 'btn', type: 'submitButton', x: 120, y: 10, width: 80, height: 24 });
  // 替换支（先写一次 FRFont，第二次走 existFont 分支）
  updateParameterWidget(p, { name: 'lbl', fontName: '微软雅黑', fontSize: 96 });
  for (const [payload, expect] of [
    ['A$$B', 'A$$B'],
    ['A$&B', 'A$&amp;B'],
    ["A$'B", 'A$&apos;B'],
    ['A$`B', 'A$`B'],
  ]) {
    const r = updateParameterWidget(p, { name: 'lbl', fontName: payload, fontSize: 96 });
    assert.equal(r.mode, 'update');
    const raw = fs.readFileSync(p, 'utf8');
    const tag = (raw.match(/<FRFont\b[^>]*>/) || [])[0];
    assert.equal(tag, `<FRFont name="${expect}" style="0" size="96"/>`, `fontName=${payload} 应原样落盘（实体转义后）`);
    assert.ok(!/name="[^"]*</.test(tag) && !tag.includes('</InnerWidget>'), '属性值内不得注入标签（$& 注入形态）');
    assertWellFormed(raw, `fontName=${payload}`);
    assert.equal(errCount(p), 0, `fontName=${payload} 后 validate 应 0 error`);
  }
  // 追加支（原本无 FRFont）：label 走 :4176 分支，submitButton 无 <isCustomType> 走 :4174 分支
  const r2 = updateParameterWidget(p, { name: 'btn', fontName: 'A$&B' });
  assert.equal(r2.mode, 'update');
  let raw = fs.readFileSync(p, 'utf8');
  assert.ok(raw.includes('<FRFont name="A$&amp;B" style="0" size="96"/>'), '按钮追加支应原样落盘');
  assertWellFormed(raw, '按钮追加支');
  assert.equal(errCount(p), 0);
  // 等价性（无 $）：落盘就是期望字面量，且文件其余部分逐字节不变
  const before = fs.readFileSync(p, 'utf8');
  updateParameterWidget(p, { name: 'btn', fontName: '微软雅黑', fontSize: 96 });
  raw = fs.readFileSync(p, 'utf8');
  assert.ok(raw.includes('<FRFont name="微软雅黑" style="0" size="96"/>'), '无 $ 时产出与改前口径一致');
  assert.equal(raw, before.replace('A$&amp;B', () => '微软雅黑'), '只应替换字体名，其余字节逐字节不动');
  assert.equal(parameterPanel(p).widgets.find((w) => w.name === 'btn').fontName, '微软雅黑');
  fs.rmSync(d, { recursive: true, force: true });
});

test('F2 defaultValue：文本路与公式路的 $$ 原样落盘（$& 不被注入）', () => {
  const d = tmp();
  const p = path.join(d, 'f2.cpt');
  createCpt(p, { rows: 3, columns: 3 });
  setParameterPanel(p, { title: '查询' });
  addParameterWidget(p, { name: 'kw', type: 'text', x: 10, y: 10, width: 100, height: 24 });
  // 文本路
  for (const payload of ['A$$B', 'A$&B', "A$'B"]) {
    updateParameterWidget(p, { name: 'kw', defaultValue: payload });
    const raw = fs.readFileSync(p, 'utf8');
    assert.ok(raw.includes(`<![CDATA[${payload}]]>`), `文本路 defaultValue=${payload} 应原样落盘`);
    assertWellFormed(raw, `defaultValue=${payload}`);
    assert.equal(errCount(p), 0);
  }
  assert.equal(parameterPanel(p).widgets.find((w) => w.name === 'kw').defaultValue, "A$'B");
  // 等价性（无 $）——必须在切到公式路之前做（公式路后 widgetValue 不再是纯文本 <O>）
  updateParameterWidget(p, { name: 'kw', defaultValue: '普通值' });
  assert.ok(fs.readFileSync(p, 'utf8').includes('<![CDATA[普通值]]>'));
  // 公式路
  for (const payload of ["=$$$+'年'", "=$$+'月'"]) {
    const r = updateParameterWidget(p, { name: 'kw', defaultValue: payload, valueType: 'formula' });
    assert.equal(r.mode, 'update');
    const raw = fs.readFileSync(p, 'utf8');
    assert.ok(raw.includes('<O t="XMLable" class="com.fr.base.Formula">'), '公式 O 形态');
    assert.ok(raw.includes(`<![CDATA[${payload}]]>`), `公式路 defaultValue=${payload} 应原样落盘`);
    assertWellFormed(raw, `formula=${payload}`);
    assert.equal(errCount(p), 0);
  }
  fs.rmSync(d, { recursive: true, force: true });
});

test('F3 set_webwrite_extras：更新路与插入路的 $$ 原样落盘', async () => {
  const d = tmp();
  const p = path.join(d, 'f3.cpt');
  createCpt(p, { rows: 3, columns: 3, webWrite: true });
  // 插入路：节点不存在
  setWebWriteExtras(p, { showWidgets: { q: 'D$$E' } });
  let raw = fs.readFileSync(p, 'utf8');
  assert.ok(raw.includes('<ShowWidgets q="D$$E"/>'), '插入路应原样落盘');
  assertWellFormed(raw, 'showWidgets 插入路');
  // 更新路：节点已存在（自闭合）
  setWebWriteExtras(p, { editRowColor: { a: 'X' } });
  setWebWriteExtras(p, { editRowColor: { a: 'D$$E' } });
  raw = fs.readFileSync(p, 'utf8');
  assert.ok(raw.includes('<EditRowColor a="D$$E"/>'), '更新路应原样落盘');
  assertWellFormed(raw, 'editRowColor 更新路');
  assert.equal(errCount(p), 0);
  fs.rmSync(d, { recursive: true, force: true });
});

test('F4 update_float_element：content 的 $$ 原样落盘', () => {
  const d = tmp();
  const p = path.join(d, 'f4.cpt');
  createCpt(p, { rows: 3, columns: 3 });
  addFloatElement(p, { content: '标题', name: 'F1' });
  const r = updateFloatElement(p, { name: 'F1', content: '浮$$动' });
  assert.equal(r.action, 'update_float_element');
  assert.ok(r.changed.includes('content'));
  const raw = fs.readFileSync(p, 'utf8');
  assert.ok(raw.includes('<![CDATA[浮$$动]]>'), 'content 应原样落盘');
  assertWellFormed(raw, 'float content');
  assert.equal(errCount(p), 0);
  // 等价性（无 $）
  updateFloatElement(p, { name: 'F1', content: '浮动' });
  assert.ok(fs.readFileSync(p, 'utf8').includes('<![CDATA[浮动]]>'));
  fs.rmSync(d, { recursive: true, force: true });
});

test('F5 文件内容类：用户没传的模板自带 $$ 不得被改写（WidgetAttr / Location / TableDataMap）', () => {
  const d = tmp();
  const p = path.join(d, 'f5.cpt');
  createCpt(p, { rows: 3, columns: 3 });
  setParameterPanel(p, { title: '查询' });
  addParameterWidget(p, { name: 'kw', type: 'text' });
  addFloatElement(p, { content: 'x', name: 'F1' });
  // ① WidgetAttr description 自带 $$
  let raw = inject(fs.readFileSync(p, 'utf8'), 'description=""', 'description="D$$E"');
  // ② Location 自带 $$
  raw = inject(raw, '<Location ', '<Location custom="D$$E" ');
  // ③ TableDataMap 自闭合且属性自带 $$（走 generate.js insertTableData 的自闭合分支）
  raw = inject(raw, '<TableDataMap>\n</TableDataMap>', '<TableDataMap name="D$$E"/>');
  fs.writeFileSync(p, raw);
  assert.ok(raw.includes('description="D$$E"') && raw.includes('custom="D$$E"') && raw.includes('name="D$$E"'), '前置：三处 $$ 已就位');
  // 改 A 字段（可见性 / 位置 / 数据集），B 字段的 $$ 必须原样
  updateParameterWidget(p, { name: 'kw', visible: false });
  assert.ok(fs.readFileSync(p, 'utf8').includes('invisible="true"'), '可见性开关（false）应生效');
  updateParameterWidget(p, { name: 'kw', visible: true });
  updateFloatElement(p, { name: 'F1', leftMm: 20 });
  addDataset(p, { name: 'ds_new', connection: 'Doris', sql: 'select 1' });
  raw = fs.readFileSync(p, 'utf8');
  assert.ok(raw.includes('description="D$$E"'), 'WidgetAttr.description 的 $$ 不得被改写');
  assert.ok(raw.includes('custom="D$$E"'), 'Location.custom 的 $$ 不得被改写');
  assert.ok(raw.includes('name="D$$E"'), 'TableDataMap.name 的 $$ 不得被改写');
  assert.equal(parameterPanel(p).widgets.find((w) => w.name === 'kw').invisible, false, '可见性开关（true）应恢复可见');
  assertWellFormed(raw, 'F5');
  assert.equal(errCount(p), 0);
  fs.rmSync(d, { recursive: true, force: true });
});

test('F6 add_chart：title / category / values 的 $$ 原样落盘', () => {
  const d = tmp();
  const p = path.join(d, 'f6.cpt');
  createCpt(p, { rows: 3, columns: 6 });
  addDataset(p, { name: 'ds1', connection: 'Doris', sql: 'select 1' });
  addChart(p, {
    column: 0, row: 0, type: 'column', title: '销$$售', dsName: 'ds1',
    category: 'D$$E', values: [{ name: 'V$$W', agg: 'sum' }], sheet: 0,
  });
  const raw = fs.readFileSync(p, 'utf8');
  assert.ok(raw.includes('销$$售'), 'title 应原样落盘（__CHART_NAME__ / __TITLE__ 两占位符）');
  assert.ok(raw.includes('D$$E'), 'category 应原样落盘');
  assert.ok(raw.includes('V$$W'), 'values.name 应原样落盘（__CHART_DEFINITION__ 占位符）');
  assertWellFormed(raw, 'add_chart');
  assert.equal(errCount(p), 0);
  // 等价性（无 $）：图表块能正常生成
  addChart(p, { column: 5, row: 0, type: 'pie', title: '销售', dsName: 'ds1', category: 'DE', values: [{ name: 'VW', agg: 'sum' }], sheet: 0 });
  assert.equal(errCount(p), 0);
  fs.rmSync(d, { recursive: true, force: true });
});

test('F7 update_style_batch：fontName（替换支）与 textStyle（$1$2 追加支）的 $$ 原样落盘', async () => {
  const d = tmp();
  const p = path.join(d, 'f7.cpt');
  createCpt(p, { rows: 3, columns: 3 });
  const r1 = await updateStyleBatch(p, [{ target: { index: 0 }, patch: { fontName: 'S$$T' } }]);
  assert.equal(r1.summary.updated, 1);
  let raw = fs.readFileSync(p, 'utf8');
  assert.ok(raw.includes('<FRFont name="S$$T"'), '替换支应原样落盘');
  assertWellFormed(raw, 'fontName');
  // 追加支：textStyle 不在 <Style> 开标签上，走 (m,g1,g2) => ` ...$1$2` 分支
  await updateStyleBatch(p, [{ target: { index: 0 }, patch: { textStyle: 'U$$V' } }]);
  raw = fs.readFileSync(p, 'utf8');
  assert.ok(raw.includes('textStyle="U$$V"'), '追加支应原样落盘');
  assert.ok(!raw.includes('$1') && !raw.includes('$2'), '捕获组不得以字面 $1/$2 落盘');
  assertWellFormed(raw, 'textStyle');
  assert.equal(errCount(p), 0);
  // 等价性（无 $）：追加支的 $1/$2 语义不变（属性插在原位置、标签仍闭合）
  await updateStyleBatch(p, [{ target: { index: 0 }, patch: { paddingLeft: '12' } }]);
  raw = fs.readFileSync(p, 'utf8');
  assert.ok(/<Style[^>]* paddingLeft="12"[^>]*>/.test(raw), '追加支应把属性插在 > 之前');
  assertWellFormed(raw, 'paddingLeft');
  fs.rmSync(d, { recursive: true, force: true });
});
