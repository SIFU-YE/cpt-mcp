// test/xlsx-read.test.js —— 最小只读 xlsx 解析器（自研 ZIP + fast-xml-parser）
//
// 测试原则：
//   1) 不依赖第三方 xlsx 库、不联网：测试内自带「最小 ZIP 写入辅助」（本地头/中央目录/EOCD 全手写），
//      需要什么畸形样本就造什么（加密标志、zip64 哨兵、非法压缩方法、CRC 损坏、超限……）；
//   2) 只写系统临时目录（mkdtemp），不污染工作区；
//   3) 断言到 cell 粒度：{row,col,value,raw,type,formula} 与日期/布尔/错误/公式缓存值。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import '../scripts/isolate-store.mjs';
import {
  readWorkbook, readSheet, sheetMatrix, readZip,
  XlsxError, XLSX_ERROR_CODES, XLSX_LIMITS,
  classifyDateFormat, excelSerialToText, parseCellRef, cellRefOf,
} from '../lib/xlsx-read.js';
// ZIP/xlsx 组装辅助抽到 fixtures（与 excel-import 测试共用，避免两份 60 行 ZIP 写入实现漂移）
import { buildZip, buildXlsx, STYLES, XLSX_NS, WORKBOOK_XML, WORKBOOK_RELS } from './fixtures/excel-import/xlsx-builder.js';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-xlsx-read-'));
test.after(() => { try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ } });
let seq = 0;
function writeTmp(buf, name = 'book') {
  seq += 1;
  const file = path.join(tmpRoot, `${name}-${seq}.xlsx`);
  fs.writeFileSync(file, buf);
  return file;
}
/** 断言抛 XlsxError 且 code 命中 */
function throwsCode(code, fn) {
  assert.throws(fn, (err) => {
    assert.ok(err instanceof XlsxError, `应为 XlsxError，实际 ${err?.name}: ${err?.message}`);
    assert.equal(err.code, code, `错误码应为 ${code}，实际 ${err.code}: ${err.message}`);
    assert.ok(typeof err.message === 'string' && err.message.length > 0);
    assert.ok(XLSX_ERROR_CODES.includes(code), `错误码 ${code} 未登记到 XLSX_ERROR_CODES`);
    return true;
  });
}

// ============================== 正常解析 ==============================
test('readWorkbook：多 sheet / 名称 / sharedStrings / styles 元数据', () => {
  const buf = buildXlsx({
    sheets: [
      { name: '明细', content: '<row r="1"><c r="A1"><v>1</v></c></row>' },
      { name: '汇总 & 统计', content: '<row r="1"><c r="A1"><v>2</v></c></row>' },
    ],
    sharedStrings: ['x'],
    styles: STYLES,
  });
  const wb = readWorkbook(writeTmp(buf));
  assert.deepEqual(wb.sheetNames, ['明细', '汇总 & 统计'], 'sheet 名要做 XML 实体解码（&amp; → &）');
  assert.equal(wb.sheets.length, 2);
  assert.equal(wb.date1904, false);
  assert.equal(wb.sharedStringsCount, 1);
  assert.equal(wb.styleCount, 5);
  assert.equal(wb.sheets[0].part, 'xl/worksheets/sheet1.xml');
  assert.equal(wb.sheets[0].kind, 'worksheet');
});

test('readSheet：sharedString / inlineStr / number / boolean / error / 公式缓存值', () => {
  const buf = buildXlsx({
    sheets: [{
      name: 'Sheet1',
      content: [
        '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c></row>',
        '<row r="2"><c r="A2"><v>42</v></c><c r="B2" t="b"><v>1</v></c><c r="C2" t="b"><v>0</v></c></row>',
        '<row r="3"><c r="A3" t="inlineStr"><is><t>内联文本</t></is></c><c r="B3" t="str"><v>字符串结果</v></c><c r="C3" t="e"><v>#DIV/0!</v></c></row>',
        '<row r="4"><c r="A4"><f>SUM(A2:A3)</f><v>42</v></c><c r="B4"><f>1+1</f></c></row>',
      ].join(''),
    }],
    sharedStrings: ['hello', '世界', { runs: ['rich-', 'text'] }],
    styles: STYLES,
  });
  const wb = readWorkbook(writeTmp(buf));
  const sheet = readSheet(wb, 0);
  assert.equal(sheet.maxRow, 3);
  assert.equal(sheet.maxCol, 2);
  assert.equal(sheet.rows, 4);
  assert.equal(sheet.columns, 3);
  assert.equal(sheet.cellCount, 11);

  const get = (r, c) => sheet.cells.find((x) => x.row === r && x.col === c);
  assert.deepEqual(
    { value: get(0, 0).value, raw: get(0, 0).raw, type: get(0, 0).type },
    { value: 'hello', raw: '0', type: 'string' },
  );
  assert.equal(get(0, 1).value, '世界');
  assert.equal(get(0, 2).value, 'rich-text', 'sharedString 富文本 runs 要拼成纯文本');
  assert.deepEqual({ value: get(1, 0).value, type: get(1, 0).type }, { value: 42, type: 'number' });
  assert.deepEqual({ value: get(1, 1).value, type: get(1, 1).type }, { value: true, type: 'boolean' });
  assert.equal(get(1, 2).value, false);
  assert.equal(get(2, 0).value, '内联文本');
  assert.equal(get(2, 1).value, '字符串结果');
  assert.deepEqual({ value: get(2, 2).value, type: get(2, 2).type }, { value: '#DIV/0!', type: 'error' });
  // 公式：有缓存值 → 取缓存值并保留公式
  assert.deepEqual(
    { value: get(3, 0).value, formula: get(3, 0).formula, cached: get(3, 0).cached },
    { value: 42, formula: 'SUM(A2:A3)', cached: undefined },
  );
  // 公式：无缓存值 → value=null + formula + cached:false（excel-import 据此报 formula_no_cached_value）
  assert.deepEqual(
    { value: get(3, 1).value, type: get(3, 1).type, formula: get(3, 1).formula, cached: get(3, 1).cached },
    { value: null, type: 'empty', formula: '1+1', cached: false },
  );
  assert.equal(get(0, 0).ref, 'A1');
  assert.equal(get(3, 1).ref, 'B4');
});

test('readSheet：日期按 styles.xml numFmt 判定（内置 14 / 自定义 yyyy-mm-dd / yyyy/m/d h:mm:ss）', () => {
  const buf = buildXlsx({
    sheets: [{
      name: 'Sheet1',
      content: [
        '<row r="1"><c r="A1" s="1"><v>45292</v></c><c r="B1" s="2"><v>45292</v></c><c r="C1" s="3"><v>45292.75</v></c></row>',
        '<row r="2"><c r="A2" s="4"><v>0.5</v></c><c r="B2" s="0"><v>45292</v></c></row>',
      ].join(''),
    }],
    styles: STYLES,
  });
  const wb = readWorkbook(writeTmp(buf));
  const sheet = readSheet(wb, 'Sheet1');
  const get = (r, c) => sheet.cells.find((x) => x.row === r && x.col === c);
  assert.deepEqual(
    { value: get(0, 0).value, type: get(0, 0).type, raw: get(0, 0).raw },
    { value: '2024-01-01', type: 'date', raw: '45292' },
    '内置 date numFmtId=14 要转成日期文本',
  );
  assert.equal(get(0, 1).value, '2024-01-01');
  assert.equal(get(0, 2).value, '2024-01-01 18:00:00');
  assert.equal(get(0, 2).type, 'datetime');
  assert.equal(get(1, 0).value, '12:00:00', '内置 time numFmtId=21 只给时间');
  assert.equal(get(1, 0).type, 'time');
  // 未标日期格式的普通数字保持 number（不臆造）
  assert.deepEqual({ value: get(1, 1).value, type: get(1, 1).type }, { value: 45292, type: 'number' });
});

test('readSheet：1904 日期系统 / 稀疏行（只给 r= 的空行不影响坐标）', () => {
  const buf = buildXlsx({
    date1904: true,
    sheets: [{
      name: 'S',
      content: '<row r="1"><c r="A1" s="2"><v>43830</v></c></row><row r="5"><c r="C5"><v>9</v></c></row>',
    }],
    styles: STYLES,
  });
  const wb = readWorkbook(writeTmp(buf));
  assert.equal(wb.date1904, true);
  const sheet = readSheet(wb, 0);
  const a1 = sheet.cells.find((c) => c.ref === 'A1');
  // 1904 系统：serial 43831 = 2024-01-01
  assert.equal(a1.value, '2024-01-01');
  assert.equal(sheet.maxRow, 4);
  assert.equal(sheet.maxCol, 2);
  const c5 = sheet.cells.find((c) => c.ref === 'C5');
  assert.equal(c5.value, 9);
  assert.equal(c5.row, 4);
  assert.equal(c5.col, 2);
});

test('sheetMatrix：补齐空单元格 + maxRows/maxCols 截断标记', () => {
  const buf = buildXlsx({
    sheets: [{ name: 'S', content: '<row r="1"><c r="B1"><v>7</v></c></row><row r="3"><c r="A3"><v>8</v></c></row>' }],
  });
  const wb = readWorkbook(writeTmp(buf));
  const sheet = readSheet(wb, 0);
  const full = sheetMatrix(sheet);
  assert.equal(full.rows, 3);
  assert.equal(full.columns, 2);
  assert.equal(full.matrix[0][0].type, 'empty');
  assert.equal(full.matrix[0][1].value, 7);
  assert.equal(full.matrix[1][1].type, 'empty');
  assert.equal(full.matrix[2][0].value, 8);
  assert.deepEqual(full.truncated, { rows: false, columns: false });

  const cut = sheetMatrix(sheet, { maxRows: 2, maxCols: 1 });
  assert.equal(cut.rows, 2);
  assert.equal(cut.columns, 1);
  assert.deepEqual(cut.truncated, { rows: true, columns: true });
  assert.equal(cut.matrix.length, 2);
  assert.equal(cut.matrix[0].length, 1);
});

test('merges：mergeCell 区域解析（标题/表头合并区可按锚点比对）', () => {
  const buf = buildXlsx({
    sheets: [{
      name: 'S',
      content: '<row r="1"><c r="A1" t="inlineStr"><is><t>标题</t></is></c></row>',
      extra: '<mergeCells count="1"><mergeCell ref="A1:D1"/></mergeCells>',
    }],
  });
  const wb = readWorkbook(writeTmp(buf));
  const sheet = readSheet(wb, 0);
  assert.equal(sheet.merges.length, 1);
  assert.deepEqual(sheet.merges[0], { ref: 'A1:D1', start: { row: 0, col: 0 }, end: { row: 0, col: 3 } });
});

test('readSheet：按名字大小写容错 / 不存在 → XLSX_SHEET_NOT_FOUND / chartsheet 拒绝', () => {
  const buf = buildXlsx({ sheets: [{ name: 'Sheet1', content: '<row r="1"><c r="A1"><v>1</v></c></row>' }] });
  const wb = readWorkbook(writeTmp(buf));
  assert.equal(readSheet(wb, 'sheet1').name, 'Sheet1', '名字大小写不敏感兜底');
  throwsCode('XLSX_SHEET_NOT_FOUND', () => readSheet(wb, 'NoSuchSheet'));
  throwsCode('XLSX_SHEET_NOT_FOUND', () => readSheet(wb, 5));
  throwsCode('XLSX_INVALID', () => readSheet({}, 0));
});

// ============================== 容器/格式错误 ==============================
test('.xls（OLE2）拒绝：扩展名与文件头两路都要挡住', () => {
  const xlsByExt = path.join(tmpRoot, 'legacy.xls');
  fs.writeFileSync(xlsByExt, Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0]));
  throwsCode('XLS_UNSUPPORTED', () => readWorkbook(xlsByExt));

  const xlsByMagic = writeTmp(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0]));
  throwsCode('XLS_UNSUPPORTED', () => readWorkbook(xlsByMagic));
});

test('非 xlsx 文件：纯文本 / 有效 ZIP 但不是工作簿', () => {
  const plain = path.join(tmpRoot, 'not-zip.xlsx');
  fs.writeFileSync(plain, 'this is not a zip');
  throwsCode('XLSX_NOT_XLSX', () => readWorkbook(plain));

  const otherZip = writeTmp(buildZip([{ name: 'word/document.xml', data: '<w/>' }]));
  throwsCode('XLSX_NOT_XLSX', () => readWorkbook(otherZip));

  throwsCode('XLSX_FILE_NOT_FOUND', () => readWorkbook(path.join(tmpRoot, 'missing.xlsx')));
});

test('ZIP 损坏：截断（无 EOCD）/ 中央目录签名错 / deflate 数据坏 / CRC 不符', () => {
  const good = buildXlsx();
  const truncated = writeTmp(good.subarray(0, good.length - 12), 'truncated');
  throwsCode('XLSX_ZIP_INVALID', () => readWorkbook(truncated));

  // 中央目录签名篡改（保留 EOCD，但 CD 首字节不是 PK\x01\x02）
  const buf = Buffer.from(good);
  const cdOffset = buf.readUInt32LE(buf.length - 22 + 16);
  buf.writeUInt32LE(0xdeadbeef, cdOffset);
  throwsCode('XLSX_ZIP_INVALID', () => readWorkbook(writeTmp(buf, 'bad-cd')));

  // deflate 数据坏：合法 ZIP 结构但压缩流损坏
  const badDeflate = buildZip([
    { name: 'xl/workbook.xml', data: WORKBOOK_XML(['S']) },
    { name: 'xl/_rels/workbook.xml.rels', data: WORKBOOK_RELS(['S']) },
    { name: 'xl/worksheets/sheet1.xml', rawComp: Buffer.from(Array.from({ length: 64 }, (_, i) => (i * 37 + 11) & 0xff)), method: 8, data: 'x'.repeat(64) },
  ]);
  throwsCode('XLSX_ZIP_INVALID', () => {
    const wb = readWorkbook(writeTmp(badDeflate, 'bad-inflate'));
    readSheet(wb, 0);
  });

  // CRC 不符：workbook.xml 的 crc 故意写错 → 读 workbook 时暴露
  const badCrc = buildZip([
    { name: 'xl/workbook.xml', data: WORKBOOK_XML(['S']), crc: 1 },
    { name: 'xl/_rels/workbook.xml.rels', data: WORKBOOK_RELS(['S']) },
  ]);
  throwsCode('XLSX_ZIP_CRC_MISMATCH', () => readWorkbook(writeTmp(badCrc, 'bad-crc')));

  // XML 不合法（sheet 标签未闭合）
  const malformed = buildXlsx({
    sheets: [{ name: 'S', content: '<row r="1"><c r="A1"><v>1</v></c></row>' }],
    mutateParts: (entries) => {
      const e = entries.find((x) => x.name === 'xl/worksheets/sheet1.xml');
      e.data = '<?xml version="1.0"?><worksheet><sheetData><row r="1">';
    },
  });
  throwsCode('XLSX_CORRUPT', () => {
    const wb = readWorkbook(writeTmp(malformed, 'malformed'));
    readSheet(wb, 0);
  });

  throwsCode('XLSX_ZIP_INVALID', () => readZip(Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3])));
});

test('ZIP 安全围栏：加密 / zip64 / 非法压缩方法 / 条目数超限', () => {
  const encrypted = buildZip([
    { name: 'xl/workbook.xml', data: WORKBOOK_XML(['S']), flags: 0x0001 },
  ]);
  throwsCode('XLSX_ZIP_ENCRYPTED', () => readWorkbook(writeTmp(encrypted, 'encrypted')));

  const zip64Eocd = buildXlsx();
  // 手工把 EOCD 的 total entries 置为 0xffff 哨兵
  const z64 = Buffer.from(zip64Eocd);
  z64.writeUInt16LE(0xffff, z64.length - 22 + 8);
  z64.writeUInt16LE(0xffff, z64.length - 22 + 10);
  throwsCode('XLSX_ZIP64_UNSUPPORTED', () => readWorkbook(writeTmp(z64, 'zip64-eocd')));

  const zip64Extra = buildZip([
    { name: 'xl/workbook.xml', data: WORKBOOK_XML(['S']), centralExtra: Buffer.from([0x01, 0x00, 0x00, 0x00]) },
  ]);
  throwsCode('XLSX_ZIP64_UNSUPPORTED', () => readWorkbook(writeTmp(zip64Extra, 'zip64-extra')));

  const badMethod = buildZip([{ name: 'xl/workbook.xml', data: WORKBOOK_XML(['S']), method: 9 }]);
  throwsCode('XLSX_ZIP_UNSUPPORTED_METHOD', () => readWorkbook(writeTmp(badMethod, 'bad-method')));

  const manyEntries = buildZip([
    { name: 'a', data: 'a' }, { name: 'b', data: 'b' }, { name: 'c', data: 'c' },
  ]);
  throwsCode('XLSX_ZIP_TOO_MANY_ENTRIES', () => readWorkbook(writeTmp(manyEntries, 'many'), { maxEntries: 2 }));
});

test('ZIP 安全围栏：文件超限 / 单条目超限 / 累计解压超限（zip bomb）', () => {
  const file = writeTmp(buildXlsx(), 'limits');
  throwsCode('XLSX_FILE_TOO_LARGE', () => readWorkbook(file, { maxFileBytes: 10 }));

  const bigWorkbook = buildXlsx({
    sheets: [{ name: 'S', content: '<row r="1"><c r="A1"><v>1</v></c></row>' }],
  });
  throwsCode('XLSX_ENTRY_TOO_LARGE', () => readWorkbook(writeTmp(bigWorkbook, 'entry-limit'), { maxEntryBytes: 200 }));

  // 多个条目各自不大，但声明解压总量超过总上限 → 累计判定为 zip bomb
  const total = readWorkbook(writeTmp(bigWorkbook, 'total-limit'), { maxTotalBytes: 4096 });
  assert.ok(total.sheetNames.length === 1);
  throwsCode('XLSX_ZIP_BOMB', () => readWorkbook(writeTmp(bigWorkbook, 'total-limit2'), { maxTotalBytes: 200 }));

  // 「声明小、实际大」：store 条目实际长度大于声明 → 解压大小不符
  const lying = buildZip([
    { name: 'xl/workbook.xml', data: WORKBOOK_XML(['S']), method: 0, declaredUncompSize: 10 },
  ]);
  throwsCode('XLSX_ZIP_INVALID', () => readWorkbook(writeTmp(lying, 'lying-size')));
});

test('store（method=0）也支持；单表单元格数上限可触发', () => {
  const stored = buildZip([
    { name: 'xl/workbook.xml', data: WORKBOOK_XML(['S']), method: 0 },
    { name: 'xl/_rels/workbook.xml.rels', data: WORKBOOK_RELS(['S']), method: 0 },
    { name: 'xl/worksheets/sheet1.xml', data: `<?xml version="1.0"?><worksheet xmlns="${XLSX_NS}"><sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData></worksheet>`, method: 0 },
  ]);
  const wb = readWorkbook(writeTmp(stored, 'stored'));
  assert.equal(readSheet(wb, 0).cells[0].value, 1);

  const many = buildXlsx({
    sheets: [{ name: 'S', content: Array.from({ length: 30 }, (_, i) => `<row r="${i + 1}"><c r="A${i + 1}"><v>${i}</v></c></row>`).join('') }],
  });
  throwsCode('XLSX_TOO_MANY_CELLS', () => {
    const wb2 = readWorkbook(writeTmp(many, 'many-cells'));
    readSheet(wb2, 0, { maxCellsPerSheet: 10 });
  }, 'should never reach fromWorkbook');
});

// ============================== 纯函数 ==============================
test('日期格式判定：常见日期/时间格式识别，数字格式不误判', () => {
  for (const [code, kind] of [
    ['yyyy-mm-dd', 'date'],
    ['yyyy/m/d', 'date'],
    ['yyyy/m/d h:mm:ss', 'datetime'],
    ['m/d/yy', 'date'],
    ['m/d/yyyy h:mm', 'datetime'],
    ['h:mm:ss', 'time'],
    ['[h]:mm:ss', 'time'],
    ['yyyy"年"m"月"d"日"', 'date'],
    ['0.00', null],
    ['#,##0.00', null],
    ['General', null],
    ['"金额:"0', null],
    ['mmm-yy', 'date'],
  ]) {
    assert.equal(classifyDateFormat(code), kind, `格式 ${code} 应判为 ${kind}`);
  }
  assert.equal(classifyDateFormat(''), null);
  assert.equal(classifyDateFormat(null), null);
});

test('Excel 序列号转换：1900/1904 系统、date/datetime/time', () => {
  assert.equal(excelSerialToText(45292, 'date', false), '2024-01-01');
  assert.equal(excelSerialToText(45292.75, 'datetime', false), '2024-01-01 18:00:00');
  assert.equal(excelSerialToText(0.5, 'time', false), '12:00:00');
  assert.equal(excelSerialToText(43830, 'date', true), '2024-01-01');
});

test('A1 引用互转；readZip 可独立读取条目', () => {
  assert.deepEqual(parseCellRef('B5'), { row: 4, col: 1 });
  assert.deepEqual(parseCellRef('$AA$10'), { row: 9, col: 26 });
  assert.equal(parseCellRef('not-a-ref'), null);
  assert.equal(cellRefOf(4, 1), 'B5');
  assert.equal(cellRefOf(0, 26), 'AA1');
  const zip = readZip(buildZip([{ name: 'a.txt', data: 'hello' }, { name: 'b.txt', data: 'x'.repeat(100) }]));
  assert.deepEqual(zip.names.sort(), ['a.txt', 'b.txt']);
  assert.equal(zip.readText('a.txt'), 'hello');
  assert.equal(zip.has('nope.txt'), false);
  throwsCode('XLSX_PART_MISSING', () => zip.read('nope.txt'));
});

test('XLSX_LIMITS 是冻结默认值（调用方可在 opts 覆盖）', () => {
  assert.ok(Object.isFrozen(XLSX_LIMITS));
  assert.equal(XLSX_LIMITS.maxFileBytes, 50 * 1024 * 1024);
  assert.ok(XLSX_ERROR_CODES.length >= 15);
});
