// cpt-mcp/lib/xlsx-read.js —— 最小只读 .xlsx 解析器（零新增依赖）
//
// 【为什么需要】Excel 导入离线仿真（lib/excel-import.js）必须先能读 .xlsx。Node 24 没有内置
// xlsx 解析器，cpt-mcp 约定「零新增 npm 依赖」，所以本模块自研：
//   1) ZIP 容器：手写中央目录解析（支持 store/deflate；拒绝 zip64/加密/多卷；条目声明大小 +
//      累计声明大小 + inflateRawSync({maxOutputLength}) 三重上限防 zip bomb）；
//   2) XML：复用 package.json 已存在的 fast-xml-parser（不是新增依赖）；
//   3) 语义：只做「读单元格 → {row,col,value,raw,type,formula?}」，不求值公式、不还原样式/图片。
//
// 【坐标口径】本模块一律 0 基：row 0 = A1 第 1 行，col 0 = A 列 —— 与 cpt-mcp 全仓库
// （cpt.js cells()/fillConfig()、generate.js addCell()）一致。FR 普通 Excel 导入是「位置样式
// 匹配 1:1」（help doc 1091：模板预览的单元格位置样式和 Excel 文件完全一致时触发，数据按
// 所在单元格位置 1:1 导入）。仿真层把 xlsx 的 (row,col) 与模板的 (row,col) 直接对齐。
//
// 【错误】一切可预期失败抛 XlsxError（name='XlsxError'，带 code/message/details），不抛裸
// Error、不进程崩溃。错误码见 XLSX_ERROR_CODES（文档也列在 docs/excel-import.md）。
//
// 【公开 API】
//   readWorkbook(file, opts?) -> workbook   // 读 workbook.xml + rels + sharedStrings + styles（不解析 worksheet）
//   readSheet(wb, nameOrIndex, opts?) -> sheet // 解析单个 worksheet，返回 cells / merges / 维度
//   sheetMatrix(sheet, {maxRows,maxCols}) -> {rows,columns,matrix,truncated} // 补齐空单元格的二维矩阵
//   readZip(buffer, limits?) -> zip          // 低层 ZIP 读取（导出便于单测/其它模块复用）
//   XlsxError / XLSX_LIMITS / XLSX_ERROR_CODES
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { XMLParser, XMLValidator } from 'fast-xml-parser';

/** 默认上限（可在 readWorkbook(file, opts) 里逐项覆盖，测试用小值即可触发） */
export const XLSX_LIMITS = Object.freeze({
  maxFileBytes: 50 * 1024 * 1024, // 整个文件 >50MB 拒绝
  maxEntryBytes: 32 * 1024 * 1024, // 单个 ZIP 条目解压后上限
  maxTotalBytes: 128 * 1024 * 1024, // 全部条目解压后累计上限（zip bomb）
  maxEntries: 20000, // ZIP 条目数上限
  maxCellsPerSheet: 500000, // 单个 worksheet 的 <c> 数量上限（防巨大表打爆内存）
});

/** 结构化错误码（文档/docs/excel-import.md 同步） */
export const XLSX_ERROR_CODES = Object.freeze([
  'XLSX_FILE_NOT_FOUND', // 文件不存在 / 不是普通文件
  'XLSX_FILE_TOO_LARGE', // > maxFileBytes（默认 50MB）
  'XLS_UNSUPPORTED', // .xls（OLE2 二进制）不支持，请另存为 .xlsx
  'XLSX_NOT_XLSX', // 不是 xlsx：非 ZIP、或 ZIP 内无 xl/workbook.xml
  'XLSX_ZIP_INVALID', // ZIP 结构损坏（无 EOCD / 中央目录越界 / 本地头损坏）
  'XLSX_ZIP_MULTI_DISK', // 多卷 ZIP
  'XLSX_ZIP64_UNSUPPORTED', // zip64（条目数 0xFFFF / 偏移 0xFFFFFFFF / zip64 extra field）
  'XLSX_ZIP_ENCRYPTED', // 加密 ZIP
  'XLSX_ZIP_UNSUPPORTED_METHOD', // 压缩方法非 store(0)/deflate(8)
  'XLSX_ZIP_TOO_MANY_ENTRIES', // 条目数 > maxEntries
  'XLSX_ENTRY_TOO_LARGE', // 单条目解压后 > maxEntryBytes
  'XLSX_ZIP_BOMB', // 累计解压 > maxTotalBytes，或声明大小与实际不符（疑似 zip bomb）
  'XLSX_ZIP_CRC_MISMATCH', // 条目 CRC 与声明不符（文件损坏/被改写）
  'XLSX_PART_MISSING', // 需要的工作表/关系/共享字符串部件在 ZIP 内不存在
  'XLSX_CORRUPT', // 条目解压失败 / XML 不合法（文件损坏）
  'XLSX_INVALID', // XML 结构不是合法工作簿（缺 sheet 引用、rels 断链等）
  'XLSX_SHEET_NOT_FOUND', // readSheet 的 name/index 不存在
  'XLSX_SHEET_UNSUPPORTED', // 目标是 chartsheet/dialogsheet 等非 worksheet
  'XLSX_TOO_MANY_CELLS', // 单表 <c> 数量 > maxCellsPerSheet
]);

/** 结构化错误：调用方按 err.code 分支，不需要正则匹配 message */
export class XlsxError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'XlsxError';
    this.code = code;
    if (details != null) this.details = details;
  }
}

// fast-xml-parser 选项：保留属性/文本空白、禁用数值自动转换（xlsx 的 <v> 是字符串原文，
// 由我们按 t= 自己解码）；processEntities 打开（xlsx 的 sheet 名/共享字符串会含 &amp; 等实体）。
const XML_PARSER = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  trimValues: false,
  parseTagValue: false,
  parseAttributeValue: false,
  processEntities: true,
  removeNSPrefix: false,
  allowBooleanAttributes: true,
});

/** 统一转数组（fast-xml-parser 单子节点 = 对象，多子节点 = 数组） */
function asArray(v) {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

/** 元素文本（fast-xml-parser 三种形态：字符串 / {#text} / CDATA 不在 xlsx 出现） */
function nodeText(node) {
  if (node == null) return null;
  if (typeof node === 'string') return node;
  if (typeof node === 'number' || typeof node === 'boolean') return String(node);
  if (typeof node !== 'object') return null;
  if (node['#text'] != null) {
    const t = node['#text'];
    return typeof t === 'string' || typeof t === 'number' ? String(t) : null;
  }
  return null;
}

/** 解析 XML 并做 well-formed 校验：损坏文件转 XLSX_CORRUPT（不让 fast-xml-parser 静默半解析） */
function parseXml(text, what) {
  const src = String(text ?? '');
  if (!src.trim()) throw new XlsxError('XLSX_CORRUPT', `${what} 是空文件`);
  const valid = XMLValidator.validate(src);
  if (valid !== true) {
    const e = valid && typeof valid === 'object' ? valid.err : null;
    throw new XlsxError('XLSX_CORRUPT', `${what} XML 不合法${e?.msg ? `：${e.msg}` : ''}`, e ?? null);
  }
  try {
    return XML_PARSER.parse(src);
  } catch (e) {
    throw new XlsxError('XLSX_CORRUPT', `${what} XML 解析失败：${e.message}`);
  }
}

// ============================== ZIP（自研，最小只读） ==============================
const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_ZIP64_EOCD = 0x06064b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;
const EOCD_MIN = 22;
const MAX_COMMENT = 0xffff;

function u16(buf, off) {
  if (off < 0 || off + 2 > buf.length) return null;
  return buf.readUInt16LE(off);
}
function u32(buf, off) {
  if (off < 0 || off + 4 > buf.length) return null;
  return buf.readUInt32LE(off);
}

/** 从 EOCD 找到中央目录（返回 EOCD 在 buffer 中的偏移；找不到抛 XLSX_ZIP_INVALID） */
function findEocd(buf) {
  const minStart = Math.max(0, buf.length - EOCD_MIN - MAX_COMMENT);
  for (let i = buf.length - EOCD_MIN; i >= minStart; i--) {
    if (buf.readUInt32LE(i) !== SIG_EOCD) continue;
    const commentLen = buf.readUInt16LE(i + 20);
    // 允许注释之后有极少量尾部字节（个别写入器会追加空行）；中央目录范围后面还会二次校验
    if (i + EOCD_MIN + commentLen <= buf.length) return i;
  }
  return -1;
}

/**
 * 读取 ZIP 中央目录（只读）。
 * @param {Buffer} buf
 * @param {object} [limits] 覆盖 XLSX_LIMITS
 * @returns {{ entries: Map<string, object>, names: string[], limits: object,
 *   has(name:string):boolean, read(name:string):Buffer, readText(name:string):string }}
 */
export function readZip(buf, limits = {}) {
  const lim = { ...XLSX_LIMITS, ...limits };
  if (!Buffer.isBuffer(buf) || buf.length < EOCD_MIN) {
    if (Buffer.isBuffer(buf) && buf.length >= 8 && buf[0] === 0xd0 && buf[1] === 0xcf && buf[2] === 0x11 && buf[3] === 0xe0) {
      throw new XlsxError('XLS_UNSUPPORTED', '文件是 .xls（OLE2 复合文档）不是 .xlsx；请在 Excel/WPS 里另存为 .xlsx 后重试');
    }
    if (Buffer.isBuffer(buf) && buf.length >= 2 && buf[0] === 0x50 && buf[1] === 0x4b) {
      // 有 ZIP 头但短于最小 EOCD → 被截断的 ZIP
      throw new XlsxError('XLSX_ZIP_INVALID', `ZIP 结构损坏：文件只有 ${buf.length} 字节，短于 EOCD 最小值（文件被截断？）`);
    }
    throw new XlsxError('XLSX_NOT_XLSX', `不是有效的 ZIP 容器（文件只有 ${buf?.length ?? 0} 字节）`);
  }
  if (buf[0] !== 0x50 || buf[1] !== 0x4b) {
    if (buf[0] === 0xd0 && buf[1] === 0xcf && buf[2] === 0x11 && buf[3] === 0xe0) {
      throw new XlsxError('XLS_UNSUPPORTED', '文件是 .xls（OLE2 复合文档）不是 .xlsx；请在 Excel/WPS 里另存为 .xlsx 后重试');
    }
    throw new XlsxError('XLSX_NOT_XLSX', '不是 ZIP 容器（前 2 字节不是 PK）；.xlsx 本质是 ZIP，请确认文件类型');
  }
  const eocd = findEocd(buf);
  if (eocd < 0) throw new XlsxError('XLSX_ZIP_INVALID', 'ZIP 结构损坏：找不到 End of Central Directory（文件可能被截断）');

  const diskNumber = u16(buf, eocd + 4);
  const cdStartDisk = u16(buf, eocd + 6);
  const entriesThisDisk = u16(buf, eocd + 8);
  const totalEntries = u16(buf, eocd + 10);
  const cdSize = u32(buf, eocd + 12);
  const cdOffset = u32(buf, eocd + 16);
  if ([diskNumber, cdStartDisk, entriesThisDisk, totalEntries, cdSize, cdOffset].some((v) => v == null)) {
    throw new XlsxError('XLSX_ZIP_INVALID', 'ZIP 结构损坏：EOCD 字段越界');
  }
  // zip64：EOCD 字段被置成哨兵值，或 EOCD 前 20 字节是 zip64 locator
  const zip64Locator = eocd >= 20 ? u32(buf, eocd - 20) : null;
  if (totalEntries === 0xffff || entriesThisDisk === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff
    || zip64Locator === SIG_ZIP64_LOCATOR || zip64Locator === SIG_ZIP64_EOCD) {
    throw new XlsxError('XLSX_ZIP64_UNSUPPORTED', 'ZIP 是 zip64 格式（条目数/尺寸超 32 位），本解析器不支持；请用常规 xlsx');
  }
  if (diskNumber !== 0 || cdStartDisk !== 0 || entriesThisDisk !== totalEntries) {
    throw new XlsxError('XLSX_ZIP_MULTI_DISK', 'ZIP 是多卷/分卷格式，不支持');
  }
  if (totalEntries > lim.maxEntries) {
    throw new XlsxError('XLSX_ZIP_TOO_MANY_ENTRIES', `ZIP 条目数 ${totalEntries} 超过上限 ${lim.maxEntries}`);
  }
  if (cdOffset + cdSize > buf.length) {
    throw new XlsxError('XLSX_ZIP_INVALID', `ZIP 中央目录越界（offset=${cdOffset}, size=${cdSize}, file=${buf.length}）`);
  }

  const entries = new Map();
  const names = [];
  let declaredTotal = 0;
  let off = cdOffset;
  for (let i = 0; i < totalEntries; i++) {
    const sig = u32(buf, off);
    if (sig !== SIG_CENTRAL) {
      throw new XlsxError('XLSX_ZIP_INVALID', `ZIP 中央目录第 ${i + 1} 条签名错误（offset=${off}）`);
    }
    const flags = u16(buf, off + 8);
    const method = u16(buf, off + 10);
    const crc = u32(buf, off + 16);
    const compSize = u32(buf, off + 20);
    const uncompSize = u32(buf, off + 24);
    const nameLen = u16(buf, off + 28);
    const extraLen = u16(buf, off + 30);
    const commentLen = u16(buf, off + 32);
    const localOffset = u32(buf, off + 42);
    if ([flags, method, crc, compSize, uncompSize, nameLen, extraLen, commentLen, localOffset].some((v) => v == null)) {
      throw new XlsxError('XLSX_ZIP_INVALID', `ZIP 中央目录第 ${i + 1} 条字段越界`);
    }
    const nameStart = off + 46;
    if (nameStart + nameLen + extraLen + commentLen > buf.length) {
      throw new XlsxError('XLSX_ZIP_INVALID', `ZIP 中央目录第 ${i + 1} 条名称/扩展区越界`);
    }
    const name = buf.toString('utf8', nameStart, nameStart + nameLen);
    // zip64 extra field（header id 0x0001）
    let extraOff = nameStart + nameLen;
    const extraEnd = extraOff + extraLen;
    while (extraOff + 4 <= extraEnd) {
      const hid = u16(buf, extraOff);
      const hsz = u16(buf, extraOff + 2);
      if (hid === 0x0001) {
        throw new XlsxError('XLSX_ZIP64_UNSUPPORTED', `ZIP 条目 ${name} 使用 zip64 扩展字段，不支持`);
      }
      extraOff += 4 + hsz;
    }
    if (compSize === 0xffffffff || uncompSize === 0xffffffff || localOffset === 0xffffffff) {
      throw new XlsxError('XLSX_ZIP64_UNSUPPORTED', `ZIP 条目 ${name} 的尺寸/偏移是 zip64 哨兵值，不支持`);
    }
    if ((flags & 0x0001) !== 0 || (flags & 0x0040) !== 0) {
      throw new XlsxError('XLSX_ZIP_ENCRYPTED', `ZIP 条目 ${name} 已加密，不支持（请取消密码后另存）`);
    }
    if (method !== 0 && method !== 8) {
      throw new XlsxError('XLSX_ZIP_UNSUPPORTED_METHOD', `ZIP 条目 ${name} 压缩方法=${method}（仅支持 store=0 / deflate=8）`);
    }
    if (uncompSize > lim.maxEntryBytes) {
      throw new XlsxError('XLSX_ENTRY_TOO_LARGE', `ZIP 条目 ${name} 解压后 ${uncompSize} 字节 > 单条目上限 ${lim.maxEntryBytes}`);
    }
    declaredTotal += uncompSize;
    if (declaredTotal > lim.maxTotalBytes) {
      throw new XlsxError('XLSX_ZIP_BOMB', `ZIP 声明解压总量 ${declaredTotal} 字节 > 总上限 ${lim.maxTotalBytes}（疑似 zip bomb）`);
    }
    // 目录条目（以 / 结尾）不读数据，但仍推进游标
    if (!name.endsWith('/') && !entries.has(name)) {
      entries.set(name, { name, flags, method, crc, compSize, uncompSize, localOffset });
      names.push(name);
    }
    off = nameStart + nameLen + extraLen + commentLen;
  }

  function read(name) {
    const key = String(name);
    const e = entries.get(key);
    if (!e) throw new XlsxError('XLSX_PART_MISSING', `ZIP 内缺少条目 ${key}`);
    const lho = e.localOffset;
    if (u32(buf, lho) !== SIG_LOCAL) {
      throw new XlsxError('XLSX_ZIP_INVALID', `ZIP 条目 ${key} 的本地头签名错误（offset=${lho}）`);
    }
    const lNameLen = u16(buf, lho + 26);
    const lExtraLen = u16(buf, lho + 28);
    if (lNameLen == null || lExtraLen == null) {
      throw new XlsxError('XLSX_ZIP_INVALID', `ZIP 条目 ${key} 的本地头字段越界`);
    }
    const dataStart = lho + 30 + lNameLen + lExtraLen;
    if (dataStart + e.compSize > buf.length) {
      throw new XlsxError('XLSX_ZIP_INVALID', `ZIP 条目 ${key} 的数据区越界（文件被截断？）`);
    }
    const comp = buf.subarray(dataStart, dataStart + e.compSize);
    let out;
    if (e.method === 0) {
      if (comp.length !== e.uncompSize) {
        throw new XlsxError('XLSX_ZIP_INVALID', `ZIP 条目 ${key} 是 store 但声明尺寸 ${e.uncompSize} 与实际 ${comp.length} 不符`);
      }
      out = Buffer.from(comp);
    } else {
      // maxOutputLength 用「声明大小」做上限：既限制内存，也能发现「声明小、实际大」的 bomb 手法
      const cap = Math.max(1, Math.min(e.uncompSize > 0 ? e.uncompSize : lim.maxEntryBytes, lim.maxEntryBytes));
      try {
        out = zlib.inflateRawSync(comp, { maxOutputLength: cap });
      } catch (err) {
        if (err && (err.code === 'ERR_BUFFER_TOO_LARGE' || /maxOutputLength|larger than/i.test(String(err.message)))) {
          throw new XlsxError('XLSX_ZIP_BOMB', `ZIP 条目 ${key} 实际解压大小超过声明值 ${e.uncompSize}（疑似 zip bomb / 大小字段被篡改）`);
        }
        throw new XlsxError('XLSX_ZIP_INVALID', `ZIP 条目 ${key} deflate 解压失败：${err.message}`);
      }
    }
    if (out.length > lim.maxEntryBytes) {
      throw new XlsxError('XLSX_ENTRY_TOO_LARGE', `ZIP 条目 ${key} 解压后 ${out.length} 字节 > 单条目上限 ${lim.maxEntryBytes}`);
    }
    if (e.uncompSize > 0 && out.length !== e.uncompSize) {
      throw new XlsxError('XLSX_ZIP_INVALID', `ZIP 条目 ${key} 解压后 ${out.length} 字节与声明 ${e.uncompSize} 不符`);
    }
    const crc = (zlib.crc32 ? zlib.crc32(out) : null);
    if (crc != null && (crc >>> 0) !== (e.crc >>> 0)) {
      throw new XlsxError('XLSX_ZIP_CRC_MISMATCH', `ZIP 条目 ${key} CRC 校验失败（文件损坏或内容被改写）`);
    }
    return out;
  }

  return {
    entries,
    names,
    limits: lim,
    has: (name) => entries.has(String(name)),
    read,
    readText: (name) => read(name).toString('utf8'),
  };
}

// ============================== 日期（styles.xml numFmt 判定） ==============================
// 内置 numFmtId → 日期/时间类型（ECMA-376 内置格式表里与日期时间相关的那批）
const BUILTIN_DATE_KIND = new Map([
  [14, 'date'], [15, 'date'], [16, 'date'], [17, 'date'],
  [18, 'time'], [19, 'time'], [20, 'time'], [21, 'time'], [22, 'datetime'],
  [27, 'date'], [28, 'date'], [29, 'date'], [30, 'date'], [31, 'date'], [32, 'date'],
  [33, 'date'], [34, 'date'], [35, 'date'], [36, 'date'],
  [45, 'time'], [46, 'time'], [47, 'time'],
  [50, 'date'], [51, 'date'], [52, 'date'], [53, 'date'], [54, 'date'], [55, 'date'],
  [56, 'date'], [57, 'date'], [58, 'date'],
]);

/**
 * 从格式串判断是否日期/时间格式（返回 'date' | 'datetime' | 'time' | null）。
 * 覆盖 yyyy-mm-dd / yyyy/m/d h:mm:ss / m/d/yy 等常见写法；无法判定返回 null（保留 number）。
 * 先去掉引号字面量 "..."、转义字符 \x、[颜色]/[$-xxx] 等修饰，只留格式占位符。
 */
export function classifyDateFormat(formatCode) {
  let s = String(formatCode ?? '');
  if (!s.trim()) return null;
  s = s.replace(/\\./g, ''); // \m 之类转义
  s = s.replace(/"[^"]*"/g, ''); // 引号字面量
  s = s.replace(/\[(?!(h+|m+|s+)\])([^\]]*)\]/gi, ''); // [Red]、[$-409]、[DBNum1] 等；保留 [h]/[m]/[s] 计时
  s = s.toLowerCase();
  const hasDate = /[yd]/.test(s);
  const hasTime = /[hs]/.test(s) || /am\/pm|a\/p/.test(s);
  if (hasDate && hasTime) return 'datetime';
  if (hasDate) return 'date';
  if (hasTime) return 'time';
  // 只剩 m（月份名 "mmm" / "mm"）也算日期；但纯数字格式（"0.00"）不会命中这里
  if (/^[^a-z]*m+[^a-z]*$/.test(s)) return 'date';
  return null;
}

/** Excel 序列号 → 格式化字符串（1900/1904 两种日期系统） */
export function excelSerialToText(serial, kind, date1904 = false) {
  const offset = date1904 ? 24107 : 25569; // 1970-01-01 对应的 Excel 序列号
  const ms = Math.round((Number(serial) - offset) * 86400) * 1000;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return String(serial);
  const Y = String(d.getUTCFullYear()).padStart(4, '0');
  const M = String(d.getUTCMonth() + 1).padStart(2, '0');
  const D = String(d.getUTCDate()).padStart(2, '0');
  const h = String(d.getUTCHours()).padStart(2, '0');
  const m = String(d.getUTCMinutes()).padStart(2, '0');
  const sec = String(d.getUTCSeconds()).padStart(2, '0');
  if (kind === 'time') return `${h}:${m}:${sec}`;
  if (kind === 'date') return `${Y}-${M}-${D}`;
  return `${Y}-${M}-${D} ${h}:${m}:${sec}`;
}

/** 解析 xl/styles.xml：cellXfs 索引 → {kind,numFmtId,formatCode} | null */
function parseStyles(xmlText) {
  const parsed = parseXml(xmlText, 'xl/styles.xml');
  const sheet = parsed.styleSheet || {};
  const customFormats = new Map();
  for (const nf of asArray(sheet.numFmts?.numFmt)) {
    const id = Number(nf?.['@_numFmtId']);
    if (Number.isFinite(id)) customFormats.set(id, nf?.['@_formatCode'] != null ? String(nf['@_formatCode']) : '');
  }
  const xfs = asArray(sheet.cellXfs?.xf);
  const formats = xfs.map((xf) => {
    const id = Number(xf?.['@_numFmtId'] ?? 0);
    if (customFormats.has(id)) {
      const code = customFormats.get(id);
      const kind = classifyDateFormat(code);
      return kind ? { kind, numFmtId: id, formatCode: code } : null;
    }
    const kind = BUILTIN_DATE_KIND.get(id) ?? null;
    return kind ? { kind, numFmtId: id, formatCode: null } : null;
  });
  return { formats, customFormats };
}

// ============================== 工作簿 ==============================
/** 列号（0 基）→ A1 列字母 */
export function colLetters(column) {
  let n = Number(column);
  if (!Number.isInteger(n) || n < 0) throw new XlsxError('XLSX_INVALID', `列号非法：${column}`);
  let out = '';
  do {
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return out;
}

/** 0 基 (row,col) → A1 引用（如 (4,1) → B5） */
export function cellRefOf(row, col) {
  return `${colLetters(col)}${Number(row) + 1}`;
}

/** A1 引用 → {row,col}（0 基）；非法返回 null */
export function parseCellRef(ref) {
  const m = /^\$?([A-Za-z]{1,3})\$?(\d+)$/.exec(String(ref ?? '').trim());
  if (!m) return null;
  let col = 0;
  for (const ch of m[1].toUpperCase()) col = col * 26 + (ch.charCodeAt(0) - 64);
  return { row: Number(m[2]) - 1, col: col - 1 };
}

/** 区域引用 "A1:C3" → {start:{row,col},end:{row,col}}；非法返回 null */
function parseRangeRef(ref) {
  const text = String(ref ?? '').trim();
  const parts = text.split(':');
  const a = parseCellRef(parts[0]);
  if (!a) return null;
  const b = parts.length > 1 ? parseCellRef(parts[1]) : a;
  if (!b) return null;
  return {
    start: { row: Math.min(a.row, b.row), col: Math.min(a.col, b.col) },
    end: { row: Math.max(a.row, b.row), col: Math.max(a.col, b.col) },
  };
}

/** ZIP 内路径归一：Target 可能是绝对路径（/xl/...）或相对 xl/ 的路径（worksheets/sheet1.xml） */
function resolvePartPath(baseDir, target) {
  let t = String(target ?? '').replace(/\\/g, '/').trim();
  if (!t) return '';
  if (t.startsWith('/')) return t.replace(/^\/+/, '');
  const parts = `${baseDir}/${t}`.split('/');
  const out = [];
  for (const p of parts) {
    if (!p || p === '.') continue;
    if (p === '..') out.pop();
    else out.push(p);
  }
  return out.join('/');
}

/** sharedStrings.xml → string[]（富文本 runs 拼成纯文本；rPh 拼音注音忽略） */
function parseSharedStrings(xmlText) {
  const parsed = parseXml(xmlText, 'xl/sharedStrings.xml');
  return asArray(parsed.sst?.si).map((si) => {
    if (si == null) return '';
    if (typeof si === 'string') return si;
    if (typeof si === 'object') {
      if (si.t != null) return nodeText(si.t) ?? '';
      if (si.r != null) return asArray(si.r).map((r) => nodeText(r?.t) ?? '').join('');
      return '';
    }
    return String(si);
  });
}

/**
 * 读取 .xlsx 工作簿元数据（不解析 worksheet 单元格）。
 * @param {string} file
 * @param {object} [opts] 覆盖 XLSX_LIMITS（maxFileBytes/maxEntryBytes/maxTotalBytes/maxEntries/maxCellsPerSheet）
 * @returns {object} workbook（供 readSheet 使用；内部字段以 _ 开头）
 */
export function readWorkbook(file, opts = {}) {
  const limits = { ...XLSX_LIMITS, ...opts };
  const abs = path.resolve(String(file ?? ''));
  let stat;
  try {
    stat = fs.statSync(abs);
  } catch {
    throw new XlsxError('XLSX_FILE_NOT_FOUND', `Excel 文件不存在：${abs}`);
  }
  if (!stat.isFile()) throw new XlsxError('XLSX_FILE_NOT_FOUND', `不是普通文件：${abs}`);
  if (stat.size > limits.maxFileBytes) {
    throw new XlsxError('XLSX_FILE_TOO_LARGE', `Excel 文件 ${(stat.size / 1024 / 1024).toFixed(1)}MB > 上限 ${(limits.maxFileBytes / 1024 / 1024).toFixed(1)}MB：${abs}`);
  }
  if (/\.xls$/i.test(abs)) {
    throw new XlsxError('XLS_UNSUPPORTED', `.xls 是 OLE2 二进制格式，不支持离线解析；请先另存为 .xlsx：${abs}`);
  }
  const buf = fs.readFileSync(abs);
  if (buf.length >= 4 && buf[0] === 0xd0 && buf[1] === 0xcf && buf[2] === 0x11 && buf[3] === 0xe0) {
    throw new XlsxError('XLS_UNSUPPORTED', '文件内容是 .xls（OLE2 复合文档）不是 .xlsx；请先另存为 .xlsx');
  }
  if (buf.length < 4 || buf[0] !== 0x50 || buf[1] !== 0x4b) {
    throw new XlsxError('XLSX_NOT_XLSX', '不是 .xlsx 文件（不是 ZIP 容器）；请确认文件类型/是否被错误重命名');
  }
  const zip = readZip(buf, limits);
  if (!zip.has('xl/workbook.xml')) {
    const hint = zip.has('word/document.xml')
      ? '（这看起来是 .docx Word 文档，不是 Excel 工作簿）'
      : '（ZIP 内没有 xl/workbook.xml，不是 Excel 工作簿）';
    throw new XlsxError('XLSX_NOT_XLSX', `不是 .xlsx 工作簿${hint}：${abs}`);
  }
  const workbookXml = parseXml(zip.readText('xl/workbook.xml'), 'xl/workbook.xml');
  const wbNode = workbookXml.workbook;
  if (!wbNode || typeof wbNode !== 'object') {
    throw new XlsxError('XLSX_INVALID', 'xl/workbook.xml 缺少 <workbook> 根节点');
  }
  // 关系表：sheet 的 r:id → worksheet 部件路径
  const rels = new Map();
  if (zip.has('xl/_rels/workbook.xml.rels')) {
    const relsXml = parseXml(zip.readText('xl/_rels/workbook.xml.rels'), 'xl/_rels/workbook.xml.rels');
    for (const rel of asArray(relsXml.Relationships?.Relationship)) {
      const id = rel?.['@_Id'] != null ? String(rel['@_Id']) : null;
      if (!id) continue;
      rels.set(id, {
        target: rel?.['@_Target'] != null ? String(rel['@_Target']) : '',
        type: rel?.['@_Type'] != null ? String(rel['@_Type']) : '',
      });
    }
  }
  const date1904Raw = wbNode.workbookPr?.['@_date1904'];
  const date1904 = date1904Raw === '1' || String(date1904Raw).toLowerCase() === 'true';

  const sheets = asArray(wbNode.sheets?.sheet).map((s, index) => {
    const name = s?.['@_name'] != null ? String(s['@_name']) : `Sheet${index + 1}`;
    const relId = s?.['@_r:id'] != null ? String(s['@_r:id']) : (s?.['@_relationshipId'] != null ? String(s['@_relationshipId']) : null);
    const rel = relId ? rels.get(relId) : null;
    const type = rel?.type ?? '';
    // 兼容「rels 缺失」的极简模板：按惯例路径兜底
    const target = rel?.target || `worksheets/sheet${index + 1}.xml`;
    const part = resolvePartPath('xl', target);
    const kind = type.includes('chartsheet') ? 'chartsheet'
      : type.includes('dialogsheet') ? 'dialogsheet'
        : type.includes('macrosheet') ? 'macrosheet'
          : 'worksheet';
    return {
      index,
      name,
      sheetId: s?.['@_sheetId'] != null ? String(s['@_sheetId']) : null,
      relationId: relId,
      part,
      kind,
      state: s?.['@_state'] != null ? String(s['@_state']) : 'visible',
    };
  });
  if (!sheets.length) throw new XlsxError('XLSX_INVALID', '工作簿里没有任何 sheet（xl/workbook.xml 的 <sheets> 为空）');

  let sharedStrings = [];
  if (zip.has('xl/sharedStrings.xml')) {
    sharedStrings = parseSharedStrings(zip.readText('xl/sharedStrings.xml'));
  }
  let styles = { formats: [], customFormats: new Map() };
  if (zip.has('xl/styles.xml')) {
    styles = parseStyles(zip.readText('xl/styles.xml'));
  }

  return {
    file: abs,
    size: stat.size,
    date1904,
    sheets,
    sheetNames: sheets.map((s) => s.name),
    sharedStringsCount: sharedStrings.length,
    styleCount: styles.formats.length,
    limits,
    _zip: zip,
    _sharedStrings: sharedStrings,
    _styles: styles,
  };
}

/** 断言是 readWorkbook 的产物（防止误把路径/其它对象传进来） */
function assertWorkbook(wb) {
  if (!wb || typeof wb !== 'object' || !Array.isArray(wb.sheets) || !wb._zip) {
    throw new XlsxError('XLSX_INVALID', 'readSheet 的第一个参数必须是 readWorkbook(file) 的返回值');
  }
}

/** 按名字或 0 基索引在工作簿里定位 sheet 元数据 */
function resolveSheetMeta(wb, nameOrIndex) {
  if (typeof nameOrIndex === 'number') {
    if (!Number.isInteger(nameOrIndex) || nameOrIndex < 0 || nameOrIndex >= wb.sheets.length) {
      throw new XlsxError('XLSX_SHEET_NOT_FOUND', `sheet 索引 ${nameOrIndex} 越界（共 ${wb.sheets.length} 个：${wb.sheetNames.join('、')}）`);
    }
    return wb.sheets[nameOrIndex];
  }
  const name = String(nameOrIndex ?? '').trim();
  if (!name) {
    throw new XlsxError('XLSX_SHEET_NOT_FOUND', `sheet 名字为空（可用：${wb.sheetNames.join('、')}）`);
  }
  const exact = wb.sheets.find((s) => s.name === name);
  if (exact) return exact;
  const ci = wb.sheets.find((s) => s.name.toLowerCase() === name.toLowerCase());
  if (ci) return ci;
  throw new XlsxError('XLSX_SHEET_NOT_FOUND', `工作表 "${name}" 不存在（可用：${wb.sheetNames.join('、')}）`, { sheetNames: wb.sheetNames });
}

/** 构造单个单元格对象（统一出口，保证字段稳定） */
function buildCell(rawCell, row, col, styleIndex, ctx) {
  const t = rawCell?.['@_t'] != null ? String(rawCell['@_t']) : 'n';
  const formula = rawCell?.f != null ? nodeText(rawCell.f) : null;
  const hasV = rawCell?.v != null;
  const vText = hasV ? nodeText(rawCell.v) : null;
  const ref = cellRefOf(row, col);
  const base = { row, col, ref };
  const withFormula = (cell) => (formula != null ? { ...cell, formula } : cell);

  if (t === 'inlineStr' || rawCell?.is != null) {
    const inline = rawCell?.is;
    const value = inline == null ? '' : nodeText(inline.t) ?? asArray(inline.r).map((r) => nodeText(r?.t) ?? '').join('');
    return withFormula({ ...base, value, raw: value, type: 'string' });
  }
  if (t === 's') {
    const idx = Number(vText);
    const value = Number.isInteger(idx) ? ctx.sharedStrings[idx] ?? null : null;
    return withFormula({ ...base, value, raw: vText, type: 'string', ...(value == null ? { sharedStringMissing: true } : {}) });
  }
  if (t === 'str') {
    return withFormula({ ...base, value: vText ?? '', raw: vText, type: 'string' });
  }
  if (t === 'b') {
    return withFormula({ ...base, value: vText === '1' || String(vText).toLowerCase() === 'true', raw: vText, type: 'boolean' });
  }
  if (t === 'e') {
    return withFormula({ ...base, value: vText, raw: vText, type: 'error' });
  }
  if (t === 'd') {
    // 部分写入器直接给 ISO 8601 日期文本（不常见）
    return withFormula({ ...base, value: vText, raw: vText, type: 'date', dateKind: 'datetime' });
  }
  // t === 'n'（缺省）或未知 t：按数值/公式缓存值处理
  if (!hasV || vText == null || vText === '') {
    if (formula != null) {
      return { ...base, value: null, raw: null, type: 'empty', formula, cached: false };
    }
    return { ...base, value: null, raw: null, type: 'empty' };
  }
  if (t !== 'n') {
    // 未知 t：保留原文，按字符串处理（不臆造语义）
    return withFormula({ ...base, value: vText, raw: vText, type: 'string', unknownCellType: t });
  }
  const num = Number(vText);
  if (!Number.isFinite(num)) {
    return withFormula({ ...base, value: vText, raw: vText, type: 'string', unknownNumeric: true });
  }
  const fmt = Number.isInteger(styleIndex) && styleIndex >= 0 ? ctx.formats[styleIndex] ?? null : null;
  if (fmt) {
    return withFormula({
      ...base,
      value: excelSerialToText(num, fmt.kind, ctx.date1904),
      raw: vText,
      type: fmt.kind,
      dateKind: fmt.kind,
      numFmtId: fmt.numFmtId,
      numFmt: fmt.formatCode,
    });
  }
  return withFormula({ ...base, value: num, raw: vText, type: 'number' });
}

/**
 * 解析单个 worksheet。
 * @param {object} wb readWorkbook() 返回值
 * @param {string|number} nameOrIndex sheet 名（字符串）或 0 基索引（数字）
 * @param {object} [opts] {maxCells?:number}
 * @returns {object} sheet
 */
export function readSheet(wb, nameOrIndex, opts = {}) {
  assertWorkbook(wb);
  const limits = { ...wb.limits, ...opts };
  const meta = resolveSheetMeta(wb, nameOrIndex);
  if (meta.kind !== 'worksheet') {
    throw new XlsxError('XLSX_SHEET_UNSUPPORTED', `sheet "${meta.name}" 是 ${meta.kind}，不是 worksheet，无法按单元格读取`);
  }
  if (!wb._zip.has(meta.part)) {
    throw new XlsxError('XLSX_INVALID', `工作簿引用的工作表部件不存在：${meta.part}（sheet "${meta.name}"）`);
  }
  const parsed = parseXml(wb._zip.readText(meta.part), meta.part);
  const wsNode = parsed.worksheet ?? parsed;
  const rows = asArray(wsNode?.sheetData?.row);
  const cells = [];
  let maxRow = -1;
  let maxCol = -1;
  const ctx = {
    sharedStrings: wb._sharedStrings ?? [],
    formats: wb._styles?.formats ?? [],
    date1904: wb.date1904 === true,
  };
  for (let ri = 0; ri < rows.length; ri++) {
    const rowNode = rows[ri];
    const rowAttr = rowNode?.['@_r'] != null ? Number(rowNode['@_r']) : null;
    let rowIndex = Number.isInteger(rowAttr) && rowAttr > 0 ? rowAttr - 1 : ri;
    let nextCol = 0;
    for (const rawCell of asArray(rowNode?.c)) {
      const refParsed = parseCellRef(rawCell?.['@_r']);
      const col = refParsed ? refParsed.col : nextCol;
      if (refParsed) rowIndex = refParsed.row; // 以单元格自带的 r= 为准（行 r= 缺失/不一致时更稳）
      const styleIndex = rawCell?.['@_s'] != null ? Number(rawCell['@_s']) : -1;
      const cell = buildCell(rawCell, rowIndex, col, styleIndex, ctx);
      cells.push(cell);
      if (cell.row > maxRow) maxRow = cell.row;
      if (cell.col > maxCol) maxCol = cell.col;
      nextCol = col + 1;
      if (cells.length > limits.maxCellsPerSheet) {
        throw new XlsxError('XLSX_TOO_MANY_CELLS', `工作表 "${meta.name}" 单元格数超过上限 ${limits.maxCellsPerSheet}，请拆小 Excel 或改用列映射检查`);
      }
    }
  }
  const merges = asArray(wsNode?.mergeCells?.mergeCell)
    .map((m) => {
      const range = parseRangeRef(m?.['@_ref']);
      return range ? { ref: String(m['@_ref']), ...range } : null;
    })
    .filter(Boolean);
  const dimension = parseRangeRef(wsNode?.dimension?.['@_ref']);

  return {
    name: meta.name,
    index: meta.index,
    sheetId: meta.sheetId,
    part: meta.part,
    kind: meta.kind,
    state: meta.state,
    rows: maxRow + 1,
    columns: maxCol + 1,
    maxRow,
    maxCol,
    cellCount: cells.length,
    cells,
    merges,
    dimension,
    date1904: ctx.date1904,
  };
}

/** 空单元格占位（sheetMatrix 补齐用；与 buildCell 的 empty 同形，保证消费方分支一致） */
function emptyCell(row, col) {
  return { row, col, ref: cellRefOf(row, col), value: null, raw: null, type: 'empty' };
}

/**
 * 工作表 → 补齐空单元格的二维矩阵。
 * @param {object} sheet readSheet() 返回值
 * @param {{maxRows?:number, maxCols?:number}} [opts] 行列上限（0/缺省=不截断）
 * @returns {{rows:number, columns:number, matrix:object[][], truncated:{rows:boolean,columns:boolean}}}
 */
export function sheetMatrix(sheet, opts = {}) {
  if (!sheet || typeof sheet !== 'object' || !Array.isArray(sheet.cells) || !Number.isInteger(sheet.maxRow) || !Number.isInteger(sheet.maxCol)) {
    throw new XlsxError('XLSX_INVALID', 'sheetMatrix 的第一个参数必须是 readSheet(wb, ...) 的返回值');
  }
  const totalRows = Math.max(0, sheet.maxRow + 1);
  const totalCols = Math.max(0, sheet.maxCol + 1);
  const maxRows = Number.isInteger(opts.maxRows) && opts.maxRows > 0 ? Math.min(opts.maxRows, totalRows) : totalRows;
  const maxCols = Number.isInteger(opts.maxCols) && opts.maxCols > 0 ? Math.min(opts.maxCols, totalCols) : totalCols;
  const matrix = Array.from({ length: maxRows }, () => new Array(maxCols));
  for (let r = 0; r < maxRows; r++) {
    for (let c = 0; c < maxCols; c++) matrix[r][c] = null;
  }
  for (const cell of sheet.cells) {
    if (cell.row < maxRows && cell.col < maxCols) matrix[cell.row][cell.col] = cell;
  }
  for (let r = 0; r < maxRows; r++) {
    for (let c = 0; c < maxCols; c++) {
      if (matrix[r][c] == null) matrix[r][c] = emptyCell(r, c);
    }
  }
  return {
    rows: maxRows,
    columns: maxCols,
    matrix,
    truncated: { rows: maxRows < totalRows, columns: maxCols < totalCols },
  };
}
