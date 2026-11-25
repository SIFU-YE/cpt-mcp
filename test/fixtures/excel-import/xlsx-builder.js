// test/fixtures/excel-import/xlsx-builder.js —— 测试用「最小 ZIP 写入 + 最小 xlsx 组装」辅助
//
// 为什么自研：cpt-mcp 约定零新增 npm 依赖（不能用 exceljs/xlsx 写样本），而 Excel 导入仿真的
// 测试必须能「精确造畸形样本」（加密标志、zip64 哨兵、非法压缩方法、截断、CRC 损坏、超限……），
// 所以测试侧手写本地头/中央目录/EOCD，按需注入异常。
//
// 只在测试里使用：node --test 只匹配 *.test.js，本文件不会被当测试执行。
import zlib from 'node:zlib';

// ---------------- CRC32（Node 24 有 zlib.crc32；回退手写表） ----------------
export function crc32(buf) {
  if (typeof zlib.crc32 === 'function') return zlib.crc32(buf) >>> 0;
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let c = 0xffffffff;
  for (const b of buf) c = table[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * 构造 ZIP。entries[i]:
 *   { name, data:string|Buffer, method?:0|8|9, rawComp?:Buffer, crc?:number, flags?:number,
 *     declaredCompSize?:number, declaredUncompSize?:number, localExtra?:Buffer, centralExtra?:Buffer }
 * opts.eocdEntries 覆盖 EOCD 条目数（造 0xffff zip64 哨兵）
 */
export function buildZip(entries, opts = {}) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const e of entries) {
    const nameBuf = Buffer.from(String(e.name), 'utf8');
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(String(e.data ?? ''), 'utf8');
    const method = e.method ?? 8;
    const comp = e.rawComp ?? (method === 8 ? zlib.deflateRawSync(data) : data);
    const crc = e.crc ?? crc32(data);
    const compSize = e.declaredCompSize ?? comp.length;
    const uncompSize = e.declaredUncompSize ?? data.length;
    const flags = e.flags ?? 0;
    const localExtra = e.localExtra ?? Buffer.alloc(0);
    const centralExtra = e.centralExtra ?? Buffer.alloc(0);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc >>> 0, 14);
    local.writeUInt32LE(compSize >>> 0, 18);
    local.writeUInt32LE(uncompSize >>> 0, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(localExtra.length, 28);
    const localBlock = Buffer.concat([local, nameBuf, localExtra, comp]);
    locals.push(localBlock);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(flags, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt32LE(crc >>> 0, 16);
    cd.writeUInt32LE(compSize >>> 0, 20);
    cd.writeUInt32LE(uncompSize >>> 0, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(centralExtra.length, 30);
    cd.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([cd, nameBuf, centralExtra]));
    offset += localBlock.length;
  }
  const cdBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  const count = opts.eocdEntries ?? entries.length;
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(count & 0xffff, 8);
  eocd.writeUInt16LE(count & 0xffff, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cdBuf, eocd]);
}

// ---------------- 最小 xlsx 组装 ----------------
export const XLSX_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
export const R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PKG_REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const CT_NS = 'http://schemas.openxmlformats.org/package/2006/content-types';

export const xmlEsc = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const CONTENT_TYPES = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
  + `<Types xmlns="${CT_NS}">`
  + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
  + '<Default Extension="xml" ContentType="application/xml"/>'
  + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
  + '</Types>';

export const WORKBOOK_XML = (names, { date1904 = false } = {}) => '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
  + `<workbook xmlns="${XLSX_NS}" xmlns:r="${R_NS}">`
  + (date1904 ? '<workbookPr date1904="1"/>' : '')
  + `<sheets>${names.map((n, i) => `<sheet name="${xmlEsc(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets>`
  + '</workbook>';

export const WORKBOOK_RELS = (names) => '<?xml version="1.0" encoding="UTF-8"?>'
  + `<Relationships xmlns="${PKG_REL_NS}">`
  + names.map((n, i) => `<Relationship Id="rId${i + 1}" Type="${R_NS}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')
  + '</Relationships>';

const SHARED_STRINGS = (items) => '<?xml version="1.0" encoding="UTF-8"?>'
  + `<sst xmlns="${XLSX_NS}" count="${items.length}" uniqueCount="${items.length}">`
  + items.map((it) => (typeof it === 'string'
    ? `<si><t xml:space="preserve">${xmlEsc(it)}</t></si>`
    : `<si>${it.runs.map((t) => `<r><t>${xmlEsc(t)}</t></r>`).join('')}</si>`)).join('')
  + '</sst>';

// cellXfs：0=General, 1=内置14(m/d/yyyy), 2=自定义164(yyyy-mm-dd), 3=自定义165(yyyy/m/d h:mm:ss), 4=内置21(h:mm:ss)
export const STYLES = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
  + `<styleSheet xmlns="${XLSX_NS}">`
  + '<numFmts count="2"><numFmt numFmtId="164" formatCode="yyyy-mm-dd"/><numFmt numFmtId="165" formatCode="yyyy/m/d h:mm:ss"/></numFmts>'
  + '<cellXfs count="5"><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="164"/><xf numFmtId="165"/><xf numFmtId="21"/></cellXfs>'
  + '</styleSheet>';

/** 单行 XML 片段：row(1 基行号, 多个 cell 片段) */
export const rowXml = (rowNumber, cells) => `<row r="${rowNumber}">${cells.join('')}</row>`;

/** 常用 cell 片段构造 */
export const cellXml = {
  /** 内联字符串 */
  text: (ref, text) => `<c r="${ref}" t="inlineStr"><is><t>${xmlEsc(text)}</t></is></c>`,
  /** 数字 */
  number: (ref, n) => `<c r="${ref}"><v>${n}</v></c>`,
  /** 共享字符串（索引） */
  shared: (ref, index) => `<c r="${ref}" t="s"><v>${index}</v></c>`,
  /** 布尔 */
  bool: (ref, v) => `<c r="${ref}" t="b"><v>${v ? 1 : 0}</v></c>`,
  /** 错误值 */
  error: (ref, text) => `<c r="${ref}" t="e"><v>${xmlEsc(text)}</v></c>`,
  /** 日期序列号（style 默认 2 = yyyy-mm-dd；3 = yyyy/m/d h:mm:ss） */
  date: (ref, serial, style = 2) => `<c r="${ref}" s="${style}"><v>${serial}</v></c>`,
  /** 公式；带缓存值时传 cachedValue，不传 = 无缓存（excel-import 会报 formula_no_cached_value） */
  formula: (ref, formula, cachedValue) => (cachedValue === undefined
    ? `<c r="${ref}"><f>${xmlEsc(formula)}</f></c>`
    : `<c r="${ref}"><f>${xmlEsc(formula)}</f><v>${cachedValue}</v></c>`),
};

/**
 * 组装最小 xlsx。
 * sheets: [{ name, content: '<row .../>...', extra?: '<mergeCells .../>' }]
 * mutateParts: (entries) => void 可注入畸形部件
 */
export function buildXlsx({
  sheets = [{ name: 'Sheet1', content: '<row r="1"><c r="A1" t="inlineStr"><is><t>hi</t></is></c></row>' }],
  sharedStrings = null,
  styles = null,
  date1904 = false,
  mutateParts = null,
} = {}) {
  const names = sheets.map((s) => s.name);
  const entries = [
    { name: '[Content_Types].xml', data: CONTENT_TYPES },
    { name: 'xl/workbook.xml', data: WORKBOOK_XML(names, { date1904 }) },
    { name: 'xl/_rels/workbook.xml.rels', data: WORKBOOK_RELS(names) },
    ...sheets.map((s, i) => ({
      name: s.part ?? `xl/worksheets/sheet${i + 1}.xml`,
      data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        + `<worksheet xmlns="${XLSX_NS}"><sheetData>${s.content}</sheetData>${s.extra ?? ''}</worksheet>`,
    })),
  ];
  if (sharedStrings) entries.push({ name: 'xl/sharedStrings.xml', data: SHARED_STRINGS(sharedStrings) });
  if (styles) entries.push({ name: 'xl/styles.xml', data: styles });
  if (mutateParts) mutateParts(entries);
  return buildZip(entries);
}
