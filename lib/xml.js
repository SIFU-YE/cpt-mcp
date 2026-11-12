// cpt-mcp/lib/xml.js —— CPT(XML) 解析、校验、保真编辑内核
// 设计：读/校验用 fast-xml-parser；写操作基于“文本锚点定向编辑”，
// 只替换目标节点字节，保留其余原文（CDATA/SQL/格式），保证设计器兼容。
import fs from 'node:fs';
import { XMLValidator, XMLParser } from 'fast-xml-parser';
// M120: JS 块基线（写盘后同步刷新，杜绝「删块写盘后立即 validate 的假丢失竞态」）。
// 2026-10-29 整理：改为依赖倒置——本模块只调用 leaf 的 write-hooks，由 js-baseline.js
// 注册钩子，解除原先 xml.js → js-baseline.js → cpt.js → xml.js 的 ESM 静态环。
import { runWriteHooks } from './write-hooks.js';


// A8: 模板大小上限 —— readFileSync 全量读入 + 双遍解析前先卡字节量，
// 防御异常大文件把进程内存打爆。正常 .cpt 在百 KB ~ 几 MB 量级。
const MAX_CPT_BYTES = 64 * 1024 * 1024;

const PARSER_OPTS = {
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  cdataPropName: '__cdata',
  textNodeName: '#text',
  trimValues: false,
  parseTagValue: false,
  parseAttributeValue: false,
  commentPropName: '__comment',
  processEntities: false,
};

// ---- A2 乐观并发控制 ----
// 写路径是 read-modify-write：进程 A load 后进程 B（或外部编辑器）改了文件，
// A 再 save 会静默覆盖 B 的修改。load/save 通过这张表记录「最后一次已知 mtime」，
// save 前对比当前 mtime，不一致即抛冲突。跨进程同样生效（mtime 由文件系统背书）。
const lastKnownMtime = new Map(); // 归一化绝对路径 -> mtimeMs

function mtimeKey(p) { return String(p).replaceAll('\\', '/'); }

/** 显式声明「我就是要覆盖当前内容」（内部回滚/刻意覆盖场景），跳过一次冲突检查 */
export function markFresh(p) {
  try { lastKnownMtime.set(mtimeKey(p), fs.statSync(p).mtimeMs); } catch { /* 文件不存在则无需记录 */ }
}

export function load(path) {
  let raw;
  let rawBytes;
  let size;
  try {
    size = fs.statSync(path).size;
  } catch (e) {
    throw new Error(`无法读取文件: ${path} (${e.message})`);
  }
  if (size > MAX_CPT_BYTES) {
    throw new Error(`文件过大 (${(size / 1024 / 1024).toFixed(1)}MB > 64MB 上限): ${path}。cpt-mcp 面向 flat XML 模板，超大文件请先确认是否拿错了文件`);
  }
  try {
    rawBytes = fs.readFileSync(path);
  } catch (e) {
    throw new Error(`无法读取文件: ${path} (${e.message})`);
  }
  // M48 安全围栏: 拒绝 ZIP 容器格式 (sandbox6/防腐调整跟进报表.cpt 是 ZIP 容器,
  // 11.5 设计器导出的 "模板包", cpt-mcp 设计为 flat XML 1.0, 不读 ZIP)
  // ZIP magic bytes: PK\x03\x04 (0x50 0x4b 0x03 0x04)
  if (rawBytes.length >= 4 && rawBytes[0] === 0x50 && rawBytes[1] === 0x4b && rawBytes[2] === 0x03 && rawBytes[3] === 0x04) {
    throw new Error(`M48 安全围栏: ${path} 是 ZIP 压缩包 (前 4 字节 = PK\x03\x04), cpt-mcp 仅支持 flat XML 1.0 格式. 如需读 ZIP .cpt, 请先用 cptdec 反编译为源码目录, 再用 cpt-mcp 从目录生成新 .cpt`);
  }
  // 其他二进制 magic 也一并拒绝 (避免被 cpt-mcp 误读)
  // - xlsx/xls:  D0 CF 11 E0 或 50 4B (同 ZIP)
  // - 7z:         37 7A BC AF
  // - rar:        52 61 72 21
  // - gz:         1F 8B
  // - pdf:        25 50 44 46
  if (rawBytes.length >= 2) {
    const b0 = rawBytes[0], b1 = rawBytes[1];
    if ((b0 === 0xd0 && b1 === 0xcf) || // OLE2 (xls)
        (b0 === 0x37 && b1 === 0x7a) || // 7z
        (b0 === 0x52 && b1 === 0x61) || // rar
        (b0 === 0x1f && b1 === 0x8b) || // gz
        (b0 === 0x25 && b1 === 0x50) || // pdf
        (b0 === 0x7f && b1 === 0x45)) { // ELF
      throw new Error(`M48 安全围栏: ${path} 是二进制文件 (magic bytes 0x${b0.toString(16)}${b1.toString(16)}), cpt-mcp 仅支持 flat XML 1.0 格式`);
    }
  }
  raw = rawBytes.toString('utf8');
  const err = XMLValidator.validate(raw);
  if (err !== true) {
    throw new Error(`XML 校验失败: ${JSON.stringify(err)}`);
  }
  // C2: parsed 惰性化 —— 写类工具通常只改 raw 不读 parsed，
  // fast-xml-parser 全量解析是单次调用里最贵的步骤，按需执行
  let parsedCache;
  const result = {
    raw,
    path,
    get parsed() {
      if (!parsedCache) parsedCache = new XMLParser(PARSER_OPTS).parse(raw);
      return parsedCache;
    },
  };
  try { lastKnownMtime.set(mtimeKey(path), fs.statSync(path).mtimeMs); } catch { /* ignore */ }
  return result;
}

export function save(path, raw) {
  // A2: 冲突检测 —— 当前 mtime 与最后一次 load/save 记录不一致，说明文件被
  // 其他进程或外部编辑器改过，本次写入基于过期内容，拒绝覆盖
  const resolved = mtimeKey(path);
  const expected = lastKnownMtime.get(resolved);
  if (expected != null && fs.existsSync(resolved)) {
    const current = fs.statSync(resolved).mtimeMs;
    if (current !== expected) {
      throw new Error(
        `并发冲突：${path} 在本次读取后被外部修改（mtime 已变化）。` +
        '请重新 load/read 最新内容后重做本次修改（load 会刷新并发基线；刻意覆盖用 markFresh）；批量 *_batch 若已部分成功，先核对已落盘项再补剩余项'
      );
    }
  }
  const err = XMLValidator.validate(raw);
  if (err !== true) {
    throw new Error(`写入前 XML 校验失败，已中止写文件: ${JSON.stringify(err)}`);
  }
  // M18 修复: 原子写 (临时文件 + rename), 避免进程崩溃导致 .cpt 写入半截
  // 原理: rename 在同一文件系统上是原子操作, 失败要么旧文件要么新文件
  const tmp = path + '.tmp.' + process.pid + '.' + Date.now();
  fs.writeFileSync(tmp, raw, 'utf8');
  try {
    fs.renameSync(tmp, path);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    throw e;
  }
  // M49 写后强校验: 读回前 4 字节, 必须是 "<?xm" (XML 1.0 声明前缀)
  // 防御任何意外导致 cpt-mcp 写出非 XML 文件 (如 ZIP 容器/二进制)
  // 即使 XMLValidator 通过 (老 validate 不检测 magic bytes), 也必须有此 byte-level 断言
  try {
    const written = fs.readFileSync(path);
    if (written.length < 4 || written[0] !== 0x3c || written[1] !== 0x3f || written[2] !== 0x78 || written[3] !== 0x6d) {
      throw new Error(`M49 安全围栏: ${path} 写后前 4 字节不是 "<?xm" (0x3c 0x3f 0x78 0x6d), 实际 0x${written[0]?.toString(16)} 0x${written[1]?.toString(16)} 0x${written[2]?.toString(16)} 0x${written[3]?.toString(16)}. cpt-mcp 强制输出 flat XML 1.0`);
    }
  } catch (e) {
    if (e.message.startsWith('M49 ')) throw e;
    // M49 读回失败 (ENONENT/EACCES) 不算违规: M18 原子写已保证文件存在且内容正确,
    // 此处 readFileSync 失败通常是临时权限/竞态, 不影响 .cpt 内容本身.
    // 真违规只能是"内容不是 <?xm 开头", 那条 path 在 if 块内 throw.
  }
  // A2: 写入成功后刷新基线，后续 save 以本次 mtime 为准
  try { lastKnownMtime.set(resolved, fs.statSync(resolved).mtimeMs); } catch { /* ignore */ }
  // M120: 写盘成功后同步刷新 JS 块数基线（尽力而为，失败不影响写入结果）。
  // cpt-mcp 自身的增删 JS 块经此自动跟进基线，validate/gate 只拦「非 cpt-mcp 通道造成的丢失」。
  // 2026-10-29：基线刷新改为 write-hooks 订阅（js-baseline.js 注册），本模块不再直接依赖它。
  runWriteHooks(path);
  return raw.length;
}

// ---- 文本定位辅助 ----

/** 在 raw 中查找 pattern 的所有出现位置（跳过 XML 注释与 CDATA 内的假锚点）。
 *  C4: 排除区间先排序合并，命中判定用二分 —— 大模板（几百个 CDATA）上
 *  旧实现的「每次命中线性扫全部区间」是 O(命中×区间)。 */
export function findAll(raw, pattern) {
  const out = [];
  // 排除区间：XML 注释 <!--..--> 与 CDATA <![CDATA[..]]>
  const skip = [];
  let ci = 0;
  while ((ci = raw.indexOf('<!--', ci)) >= 0) {
    const ce = raw.indexOf('-->', ci + 4);
    if (ce < 0) break;
    skip.push([ci, ce + 3]);
    ci = ce + 3;
  }
  ci = 0;
  while ((ci = raw.indexOf('<![CDATA[', ci)) >= 0) {
    const ce = raw.indexOf(']]>', ci + 9);
    if (ce < 0) break;
    skip.push([ci, ce + 3]);
    ci = ce + 3;
  }
  // 排序合并（注释里出现 "<![CDATA[" 字样时会产生重叠区间，必须合并）
  skip.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const [a, b] of skip) {
    const last = merged[merged.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else merged.push([a, b]);
  }
  const excluded = (idx) => {
    let lo = 0, hi = merged.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const [a, b] = merged[mid];
      if (idx < a) hi = mid - 1;
      else if (idx >= b) lo = mid + 1;
      else return true;
    }
    return false;
  };
  let i = 0;
  while ((i = raw.indexOf(pattern, i)) >= 0) {
    if (!excluded(i)) out.push(i);
    i += pattern.length;
  }
  return out;
}

/** 断言 pattern 在 raw 中唯一出现，返回其索引 */

/** 从 anchorIndex 向后查找目标字符串（跳过最近一个 CDATA 起点的嵌套干扰） */
export function after(raw, anchorIdx, pattern, what) {
  const idx = raw.indexOf(pattern, anchorIdx);
  if (idx < 0) throw new Error(`定位失败：${anchorIdx} 之后未找到 ${what}`);
  return idx;
}

/** 找到从 openTag 开始到配对的 closeTag 的整块（含嵌套同名单标签） */
export function blockRange(raw, startIdx, openTag, closeTag) {
  const openLen = openTag.length;
  const closeLen = closeTag.length;
  let depth = 1;
  let i = startIdx + openLen;
  while (i < raw.length) {
    const o = raw.indexOf(openTag, i);
    const c = raw.indexOf(closeTag, i);
    if (c < 0) throw new Error(`块定位失败：未找到闭合 ${closeTag}`);
    if (o >= 0 && o < c) {
      depth += 1;
      i = o + openLen;
    } else {
      depth -= 1;
      if (depth === 0) return [startIdx, c + closeLen];
      i = c + closeLen;
    }
  }
  throw new Error(`块定位失败：标签不平衡 ${openTag}...${closeTag}`);
}

/** 替换 CDATA 内容（保持 <![CDATA[ ... ]]> 结构） */

/** 替换标签内属性值（attr="..."），保留引号与格式 */
export function replaceAttr(raw, tagStart, tagEnd, attr, newValue, what) {
  const seg = raw.slice(tagStart, tagEnd);
  // 属性名必须完整匹配；例如修改 s 时不能命中同一标签更靠前的 cs/rs。
  // attr 名做正则转义 —— 调用方当前都传常量，但一旦传入含元字符的动态名会错配
  const escaped = String(attr).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(\\b${escaped}\\s*=\\s*["'])([^"']*)(["'])`);
  const m = re.exec(seg);
  if (!m) throw new Error(`定位失败：${what} 标签内无属性 ${attr}`);
  // 旧值区间 = m[1]（attr="）之后、m[3]（闭合引号）之前；m[2] 即旧值
  const valStart = tagStart + m.index + m[1].length;
  const valEnd = valStart + m[2].length;
  return raw.slice(0, valStart) + newValue + raw.slice(valEnd);
}

/** 在 anchorText 之后插入 snippet */
export function insertAfter(raw, anchorText, snippet, what, occurrence = 0) {
  const hits = findAll(raw, anchorText);
  if (hits.length <= occurrence) throw new Error(`定位失败：未找到 ${what}（第 ${occurrence + 1} 处）`);
  const idx = hits[occurrence] + anchorText.length;
  return raw.slice(0, idx) + snippet + raw.slice(idx);
}

/** 在 anchorText 之前插入 snippet */
export function insertBefore(raw, anchorText, snippet, what, occurrence = 0) {
  const hits = findAll(raw, anchorText);
  if (hits.length <= occurrence) throw new Error(`定位失败：未找到 ${what}（第 ${occurrence + 1} 处）`);
  const idx = hits[occurrence];
  return raw.slice(0, idx) + snippet + raw.slice(idx);
}

/** 删除 [start,end) 区间的文本 */
export function removeRange(raw, start, end) {
  return raw.slice(0, start) + raw.slice(end);
}

/**
 * StyleList 中的直接 Style 子节点。
 *
 * 不能在整份 CPT 上全局搜索 `<Style `：图表等区域也会序列化 Style，且 FR 11
 * 的合法样式节点允许无属性的 `<Style>`。单元格的 s 索引只指向 StyleList。
 */
export function styleBlocks(raw) {
  const listStart = findAll(raw, '<StyleList')[0];
  if (listStart == null) throw new Error('定位失败：未找到 <StyleList>');
  // 自闭合 <StyleList/>（无任何样式的官方模板形态）：直接返回空
  const listTagEnd = raw.indexOf('>', listStart);
  if (raw.slice(listTagEnd - 1, listTagEnd + 1) === '/>') {
    return { start: listStart, end: listTagEnd + 1, closeStart: listTagEnd - 1, blocks: [] };
  }
  const [listBegin, listEnd] = blockRange(raw, listStart, '<StyleList', '</StyleList>');
  const openEnd = raw.indexOf('>', listBegin);
  const closeStart = raw.lastIndexOf('</StyleList>', listEnd);
  if (openEnd < 0 || closeStart < openEnd) throw new Error('定位失败：StyleList 标签不完整');

  const inner = raw.slice(openEnd + 1, closeStart);
  const token = /<\/?Style(?=\s|>)[^>]*>/g;
  const blocks = [];
  let depth = 0;
  let currentStart = -1;
  let match;
  while ((match = token.exec(inner)) !== null) {
    const tag = match[0];
    const closing = tag.startsWith('</');
    const selfClosing = /\/\s*>$/.test(tag);
    if (!closing) {
      if (depth === 0) currentStart = openEnd + 1 + match.index;
      if (!selfClosing) depth += 1;
      else if (depth === 0) blocks.push({ start: currentStart, end: openEnd + 1 + token.lastIndex });
    } else {
      depth -= 1;
      if (depth < 0) throw new Error('定位失败：StyleList 内 Style 标签不平衡');
      if (depth === 0) {
        blocks.push({ start: currentStart, end: openEnd + 1 + token.lastIndex });
        currentStart = -1;
      }
    }
  }
  if (depth !== 0) throw new Error('定位失败：StyleList 内 Style 标签未闭合');
  return { start: listBegin, end: listEnd, closeStart, blocks };
}

/** 所有 FR 工作表块（兼容 11.0 新旧 WorkSheet 及 PolyWorkSheet 序列化类名）。 */
export function sheetBlocks(raw) {
  const hits = findAll(raw, '<Report class="').filter((start) => {
    const headEnd = raw.indexOf('>', start);
    if (headEnd < 0) return false;
    const head = raw.slice(start, headEnd + 1);
    return /\bclass="com\.fr\.report\.(?:worksheet\.)?WorkSheet"/.test(head)
      || /\bclass="com\.fr\.report\.poly\.PolyWorkSheet"/.test(head);
  });
  return hits.map((s) => {
    const [b, e] = blockRange(raw, s, '<Report ', '</Report>');
    const head = raw.slice(s, s + 400);
    const name = (head.match(/name="([^"]*)"/) || [])[1] || null;
    return { start: b, end: e, name };
  });
}

/** 按索引(0 起)或名称定位工作表，返回 {start,end,name,index}；不存在则抛错 */
export function locateSheet(raw, sheet) {
  const blocks = sheetBlocks(raw);
  if (blocks.length === 0) throw new Error('定位失败：未找到工作表（无 Report 块）');
  let idx;
  if (typeof sheet === 'string') {
    idx = blocks.findIndex((b) => b.name === sheet);
    if (idx < 0) throw new Error(`定位失败：未找到工作表 ${sheet}`);
  } else {
    idx = Number(sheet);
    if (!Number.isInteger(idx) || idx < 0 || idx >= blocks.length) {
      throw new Error(`工作表索引非法：${sheet}（现有 ${blocks.length} 个工作表，0 起）`);
    }
  }
  return { ...blocks[idx], index: idx };
}
