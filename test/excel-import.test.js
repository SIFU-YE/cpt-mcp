// test/excel-import.test.js —— Excel 导入离线仿真（模板 + xlsx/matrix + 本地 SQLite 试跑）
//
// 原则：不联网、不依赖本机 FR、不写工作区外文件（模板/Excel 都落在 mkdtemp 临时目录；
// 本地库由 scripts/isolate-store.mjs 隔离到临时目录）。
// 覆盖任务要求的场景：通过 / 列错位 / 标题不匹配 / NOT NULL 失败回滚 / 主键空占位 /
// 本地库缺失 skipped / 按钮缺失 warning / requireButton error / xls 拒绝，另加：
// 公式无缓存、监听器 note、行数截断、内联 matrix、simulate=false、无提交、全角表头容忍。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import '../scripts/isolate-store.mjs';
import { createCpt, addCell, addDataset, addFillSubmit } from '../lib/generate.js';
import { setFillToolbar, setWebWriteJs } from '../lib/edits.js';
import { createLocalDb, localTableInfo, listLocalTables } from '../lib/localdb.js';
import { importDdlIntoLocalDb } from '../lib/localdb-import.js';
import { checkExcelImport, normalizeHeaderText, EXCEL_IMPORT_BUTTONS, EXCEL_IMPORT_DEFAULTS, scanExcelImportButtons } from '../lib/excel-import.js';
import { load } from '../lib/xml.js';
import { buildXlsx, STYLES, rowXml, cellXml } from './fixtures/excel-import/xlsx-builder.js';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-excel-import-'));
test.after(() => { try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ } });
let seq = 0;
let dbSeq = 0;

/** 造模板：表头 row=0、数据行 row=1（0 基；A1 第 2 行），绑定列与控件按参数生成 */
function makeTemplate({
  headers = ['ID', '姓名', '数量'],
  bindings = [
    { field: 'id', column: 0, isKey: true },
    { field: 'name', column: 1 },
    { field: 'qty', column: 2 },
  ],
  widgets = { id: 'text', name: 'text', qty: 'number' },
  buttons = ['submit', 'import-append'],
  withSubmit = true,
  freeSql = null,
  listener = null,
} = {}) {
  seq += 1;
  const p = path.join(tmpRoot, `tpl-${seq}.cpt`);
  createCpt(p, { rows: 12, columns: 12, webWrite: true });
  if (withSubmit) {
    if (freeSql) {
      addFillSubmit(p, { sql: freeSql, dbName: 'Doris', name: '提交' });
    } else {
      addDataset(p, { name: 'ds1', connection: 'Doris', sql: 'SELECT 1' });
      headers.forEach((h, i) => {
        if (h != null && String(h) !== '') addCell(p, { column: i, row: 0, content: h, contentType: 'text' });
      });
      for (const b of bindings) {
        const widget = widgets[b.field];
        addCell(p, {
          column: b.column, row: 1, contentType: 'dsColumn', dsName: 'ds1', columnName: b.field,
          ...(widget ? { widget } : {}),
        });
      }
      addFillSubmit(p, {
        dsName: 'Doris', schema: 'bi_ads', table: 'ods_t', name: '提交',
        bindings: bindings.map((b) => ({ ...b, row: 1 })),
      });
    }
  }
  if (buttons && buttons.length) setFillToolbar(p, { buttons });
  if (listener) setWebWriteJs(p, { event: listener.event, js: listener.js });
  return p;
}

/** 造本地目标表（MySQL DDL 由现有 localdb-import 转 SQLite） */
const ODS_DDL = 'CREATE TABLE ods_t (\n  id VARCHAR(64) PRIMARY KEY,\n  name VARCHAR(64) NOT NULL,\n  qty INT,\n  dt DATE\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;';
function makeDb(ddl = ODS_DDL) {
  dbSeq += 1;
  const db = `exctest${dbSeq}_${Date.now().toString(36)}`.slice(0, 60);
  createLocalDb(db, { overwrite: true });
  importDdlIntoLocalDb({ db, ddl, replace: true });
  return db;
}

/** 写 xlsx 到临时目录并返回路径 */
function writeXlsx(buf) {
  seq += 1;
  const file = path.join(tmpRoot, `book-${seq}.xlsx`);
  fs.writeFileSync(file, buf);
  return file;
}

/** 标准 xlsx：表头行（A1 行 1）+ 数据从 A1 行 2 起（0 基 row 1） */
function standardXlsx({ headers = ['ID', '姓名', '数量'], rows = [['k1', '张三', 3], ['k2', '李四', 4]] } = {}) {
  const content = [
    rowXml(1, headers.map((h, i) => cellXml.text(`${String.fromCharCode(65 + i)}1`, h))),
    ...rows.map((r, ri) => rowXml(ri + 2, r.map((v, ci) => {
      const ref = `${String.fromCharCode(65 + ci)}${ri + 2}`;
      if (v == null) return '';
      if (typeof v === 'number') return cellXml.number(ref, v);
      return cellXml.text(ref, v);
    }))),
  ].join('');
  return buildXlsx({ sheets: [{ name: 'Sheet1', content }], styles: STYLES });
}

const issuesOf = (res, code) => res.issues.filter((i) => i.code === code);
const hasCode = (res, code) => issuesOf(res, code).length > 0;

// ============================== 1. 通过路径 ==============================
test('通过：xlsx + 模板 + 本地目标表 → 校验通过、SQLite 试跑成功且已 ROLLBACK', () => {
  const p = makeTemplate();
  const file = writeXlsx(standardXlsx());
  const db = makeDb();
  const res = checkExcelImport({ path: p, excelFile: file, db });
  assert.equal(res.ok, true, JSON.stringify(res.issues, null, 1));
  assert.equal(res.excel.sheet, 'Sheet1');
  assert.equal(res.excel.dataRows, 2);
  assert.equal(res.excel.dataRowsTotal, 2);
  assert.equal(res.import.buttonFound, true);
  assert.equal(res.import.mode, 'append');
  assert.deepEqual(res.import.targetTable, { schema: 'bi_ads', name: 'ods_t', full: 'bi_ads.ods_t' });
  assert.equal(res.import.dataRow, 1, 'xlsx 数据起始行 = 模板绑定 row（0 基 1 = A1 第 2 行）');
  assert.equal(res.import.templateDataRow, 1);
  assert.equal(res.mapping.length, 3);
  assert.deepEqual(res.mapping.filter((m) => m.kind === 'xlsx').map((m) => m.xlsxColumn), [0, 1, 2]);
  assert.equal(res.simulation.attempted, true);
  assert.equal(res.simulation.status, 'pass');
  assert.equal(res.simulation.inserted, 2);
  assert.equal(res.simulation.rolledBack, true, '试跑必须回滚，不能真写库');
  assert.equal(localTableInfo(db, 'ods_t').rows, 0, 'ROLLBACK 后目标表应仍是空表（无残留事务/锁）');
  assert.equal(hasCode(res, 'simulation_insert_failed'), false);
  assert.ok(res.notes.some((n) => n.code === 'simulation_rolled_back'));
  assert.ok(res.notes.some((n) => n.code === 'offline_boundary'));
  assert.equal(typeof res.elapsedMs, 'number');
});

test('通过：内联 matrix 入口（matrix 可选，不读 .xlsx 文件）', () => {
  const p = makeTemplate();
  const db = makeDb();
  const res = checkExcelImport({
    path: p,
    db,
    matrix: [
      ['ID', '姓名', '数量'],
      ['k1', '张三', 3],
      ['k2', '李四', 4],
    ],
  });
  assert.equal(res.ok, true, JSON.stringify(res.issues, null, 1));
  assert.equal(res.excel.inlineMatrix, true);
  assert.equal(res.excel.dataRows, 2);
  assert.equal(res.simulation.status, 'pass');
  assert.equal(res.simulation.rolledBack, true);
  assert.ok(res.notes.some((n) => n.code === 'inline_matrix'));
});

// ============================== 2. 列错位 / columnOffset ==============================
test('列错位：xlsx 少一列（缺最右绑定列）→ template_column_missing error', () => {
  const p = makeTemplate();
  // 模板绑定 id/name/qty 三列，但 Excel 只有 ID、姓名 两列（少了 qty）
  const file = writeXlsx(buildXlsx({
    styles: STYLES,
    sheets: [{
      name: 'Sheet1',
      content: rowXml(1, [cellXml.text('A1', 'ID'), cellXml.text('B1', '姓名')])
        + rowXml(2, [cellXml.text('A2', 'k1'), cellXml.text('B2', '张三')])
        + rowXml(3, [cellXml.text('A3', 'k2'), cellXml.text('B3', '李四')]),
    }],
  }));
  const res = checkExcelImport({ path: p, excelFile: file, simulate: false });
  assert.equal(res.ok, false, '缺列会让 qty 永远取不到数，必须报 error');
  const missing = issuesOf(res, 'template_column_missing');
  assert.equal(missing.length, 1);
  assert.equal(missing[0].severity, 'error');
  assert.equal(missing[0].field, 'qty');
  assert.equal(missing[0].column, 2);

  // 补上第三列后同一模板通过
  const fixed = checkExcelImport({ path: p, excelFile: writeXlsx(standardXlsx()), simulate: false });
  assert.equal(fixed.ok, true, JSON.stringify(fixed.issues, null, 1));
});

test('columnOffset：xlsx 数据整体左移一列时，columnOffset=1 让映射重新对齐', () => {
  // 模板绑定：name=列1、qty=列2（表头也在列1/列2）；Excel 只有 2 列，姓名/数量在列0/列1
  const p = makeTemplate({
    headers: ['', '姓名', '数量'],
    bindings: [{ field: 'name', column: 1 }, { field: 'qty', column: 2 }],
    widgets: { name: 'text', qty: 'number' },
    buttons: ['submit', 'import-append'],
  });
  const file = writeXlsx(buildXlsx({
    styles: STYLES,
    sheets: [{
      name: 'Sheet1',
      content: rowXml(1, [cellXml.text('A1', '姓名'), cellXml.text('B1', '数量')])
        + rowXml(2, [cellXml.text('A2', '张三'), cellXml.number('B2', 3)])
        + rowXml(3, [cellXml.text('A3', '李四'), cellXml.number('B3', 4)]),
    }],
  }));
  // 目标表只需要 name/qty（本测试的模板没有主键绑定）
  const db = makeDb('CREATE TABLE ods_t (name VARCHAR(64) NOT NULL, qty INT) ENGINE=InnoDB;');

  const misaligned = checkExcelImport({ path: p, excelFile: file, db });
  assert.equal(misaligned.ok, false);
  assert.ok(hasCode(misaligned, 'template_column_missing'));
  assert.ok(hasCode(misaligned, 'header_mismatch'), 'name 列会错位到「数量」表头');

  const aligned = checkExcelImport({ path: p, excelFile: file, db, columnOffset: 1 });
  assert.equal(aligned.ok, true, JSON.stringify(aligned.issues, null, 1));
  assert.equal(aligned.import.columnOffset, 1);
  assert.deepEqual(aligned.mapping.filter((m) => m.kind === 'xlsx').map((m) => m.xlsxColumn), [0, 1]);
  assert.equal(aligned.simulation.status, 'pass');
  assert.equal(aligned.simulation.rolledBack, true);
});

// ============================== 3. 标题不匹配 ==============================
test('标题不匹配：同位置文本不同 → header_mismatch warning（不阻断），全角/半角差异容忍', () => {
  const p = makeTemplate({ headers: ['ID', '姓名', '数量'], buttons: ['submit', 'import-append'] });
  const db = makeDb();
  const mismatch = checkExcelImport({
    path: p,
    db,
    simulate: false,
    matrix: [
      ['ID', '名字', '数量'],
      ['k1', '张三', 3],
    ],
  });
  assert.equal(mismatch.ok, true, '表头差异是 warning，不阻断交付');
  const hdr = issuesOf(mismatch, 'header_mismatch');
  assert.equal(hdr.length, 1);
  assert.equal(hdr[0].severity, 'warning');
  assert.equal(hdr[0].field, 'name');
  assert.equal(hdr[0].expected, '姓名');
  assert.equal(hdr[0].actual, '名字');

  // 全角/半角 + 空格差异应容忍：模板 ID vs xlsx ＩＤ
  const tolerant = checkExcelImport({
    path: p,
    simulate: false,
    matrix: [
      ['ＩＤ', ' 姓名 ', '数量'],
      ['k1', '张三', 3],
    ],
  });
  assert.equal(hasCode(tolerant, 'header_mismatch'), false, '全角/空格差异不应报 header_mismatch');
});

// ============================== 4. NOT NULL 失败 → 必然回滚 ==============================
test('目标表 NOT NULL 约束失败：本地试跑捕获并 ROLLBACK，ok=false', () => {
  const p = makeTemplate();
  const db = makeDb();
  const res = checkExcelImport({
    path: p,
    db,
    simulate: true,
    matrix: [
      ['ID', '姓名', '数量'],
      ['k1', '', 3], // name 空 → NOT NULL 失败
      ['k2', '李四', 4],
    ],
  });
  assert.equal(res.ok, false);
  assert.equal(res.simulation.status, 'failed');
  assert.equal(res.simulation.attempted, true);
  assert.equal(res.simulation.rolledBack, true);
  assert.equal(res.simulation.inserted, 1, '第二行在事务内能插入，但最终全部回滚');
  assert.equal(res.simulation.errors.length, 1);
  assert.equal(res.simulation.errors[0].code, 'not_null');
  assert.equal(res.simulation.errors[0].field, 'name');
  assert.equal(res.simulation.errors[0].row, 2, '返回 Excel 1 基行号便于对照');
  const failed = issuesOf(res, 'simulation_insert_failed');
  assert.equal(failed.length, 1);
  assert.equal(failed[0].severity, 'error');
  assert.equal(localTableInfo(db, 'ods_t').rows, 0, '失败后必须回滚干净');
});

test('目标表 UNIQUE 约束失败：主键/唯一键重复同样捕获并回滚', () => {
  const p = makeTemplate();
  const db = makeDb('CREATE TABLE ods_t (id VARCHAR(64) PRIMARY KEY, name VARCHAR(64) NOT NULL, qty INT);');
  const res = checkExcelImport({
    path: p,
    db,
    simulate: true,
    matrix: [
      ['ID', '姓名', '数量'],
      ['dup', '张三', 3],
      ['dup', '李四', 4],
    ],
  });
  assert.equal(res.ok, false);
  assert.equal(res.simulation.status, 'failed');
  assert.equal(res.simulation.rolledBack, true);
  assert.equal(res.simulation.errors[0].code, 'unique');
  assert.equal(localTableInfo(db, 'ods_t').rows, 0);
});

// ============================== 5. 主键空占位 ==============================
test('主键字段为空：用唯一占位值试跑通过 + warning「FR 运行时会按主键策略生成」', () => {
  const p = makeTemplate();
  const db = makeDb();
  const res = checkExcelImport({
    path: p,
    db,
    matrix: [
      ['ID', '姓名', '数量'],
      ['', '张三', 3],
      ['', '李四', 4],
    ],
  });
  assert.equal(res.ok, true, JSON.stringify(res.issues, null, 1));
  assert.equal(res.simulation.status, 'pass');
  assert.equal(res.simulation.inserted, 2);
  assert.equal(res.simulation.rolledBack, true);
  assert.ok(hasCode(res, 'primary_key_empty'), '主键为空的 warning');
  const ph = issuesOf(res, 'primary_key_placeholder');
  assert.equal(ph.length, 1);
  assert.equal(ph[0].severity, 'warning');
  assert.match(ph[0].hint, /FR 运行时会按主键策略生成/);
  assert.equal(localTableInfo(db, 'ods_t').rows, 0);
});

// ============================== 6. 本地库/表缺失 → skipped + nextAction ==============================
test('本地库未建：simulation.status=skipped + nextAction(local_db_import auto)，不算失败', () => {
  const p = makeTemplate();
  const res = checkExcelImport({ path: p, db: 'no_such_db_for_excel_import', matrix: [['ID', '姓名', '数量'], ['k1', '张三', 3]] });
  assert.equal(res.ok, true);
  assert.equal(res.simulation.attempted, false);
  assert.equal(res.simulation.status, 'skipped');
  assert.equal(res.simulation.reason, 'local_db_missing');
  assert.equal(res.simulation.nextAction.tool, 'local_db_import');
  assert.equal(res.simulation.nextAction.args.action, 'auto');
  assert.equal(res.simulation.nextAction.args.db, 'no_such_db_for_excel_import');
  assert.ok(res.notes.some((n) => n.code === 'local_db_missing'));
});

test('目标表缺失：skipped + nextAction（提示先 local_db_import 镜像），不算失败', () => {
  const p = makeTemplate();
  const db = makeDb('CREATE TABLE other_table (id VARCHAR(64) PRIMARY KEY);');
  const res = checkExcelImport({ path: p, db, matrix: [['ID', '姓名', '数量'], ['k1', '张三', 3]] });
  assert.equal(res.ok, true);
  assert.equal(res.simulation.status, 'skipped');
  assert.equal(res.simulation.reason, 'local_table_missing');
  assert.equal(res.simulation.nextAction.tool, 'local_db_import');
});

test('simulate=false：关闭本地试跑但不影响列位/表头检查', () => {
  const p = makeTemplate();
  const res = checkExcelImport({ path: p, simulate: false, matrix: [['ID', '姓名', '数量'], ['k1', '张三', 3]] });
  assert.equal(res.ok, true);
  assert.equal(res.simulation.attempted, false);
  assert.equal(res.simulation.status, 'disabled');
  assert.ok(res.notes.some((n) => n.code === 'simulation_disabled'));
});

// ============================== 7. 导入按钮 ==============================
test('按钮缺失：warning（不阻断）；requireButton=true → error', () => {
  const p = makeTemplate({ buttons: ['submit'] });
  const file = writeXlsx(standardXlsx());
  const warn = checkExcelImport({ path: p, excelFile: file, simulate: false });
  assert.equal(warn.ok, true);
  assert.equal(warn.import.buttonFound, false);
  const missing = issuesOf(warn, 'import_button_missing');
  assert.equal(missing.length, 1);
  assert.equal(missing[0].severity, 'warning');
  assert.match(missing[0].hint, /set_fill_toolbar/);

  const strict = checkExcelImport({ path: p, excelFile: file, simulate: false, requireButton: true });
  assert.equal(strict.ok, false);
  assert.equal(issuesOf(strict, 'import_button_missing')[0].severity, 'error');
});

test('按钮存在：识别 ImExcelAppend / ImExcelClean 并给出导入方式', () => {
  const append = checkExcelImport({ path: makeTemplate({ buttons: ['submit', 'import-append'] }), simulate: false, matrix: [['ID', '姓名', '数量'], ['k1', '张三', 3]] });
  assert.equal(append.import.buttonFound, true);
  assert.equal(append.import.mode, 'append');
  assert.equal(append.import.buttons[0].name, 'import-append');
  assert.equal(append.import.buttons[0].class, 'com.fr.report.web.button.write.ImExcelAppend');

  const clean = checkExcelImport({ path: makeTemplate({ buttons: ['submit', 'import-clean'] }), simulate: false, matrix: [['ID', '姓名', '数量'], ['k1', '张三', 3]] });
  assert.equal(clean.import.mode, 'clean');
  assert.equal(clean.import.buttons[0].name, 'import-clean');
  assert.equal(EXCEL_IMPORT_BUTTONS['com.fr.report.web.button.write.ImExcelClean'].mode, 'clean');
});

// ============================== 8. xls / 非法 Excel ==============================
test('.xls 拒绝：结构化 error issue（不崩溃），ok=false', () => {
  const p = makeTemplate();
  const xls = path.join(tmpRoot, 'legacy.xls');
  fs.writeFileSync(xls, Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0]));
  const res = checkExcelImport({ path: p, excelFile: xls, simulate: false });
  assert.equal(res.ok, false);
  assert.ok(hasCode(res, 'XLS_UNSUPPORTED'));
  assert.match(issuesOf(res, 'XLS_UNSUPPORTED')[0].hint, /另存为 \.xlsx/);
  // 也支持用 extension 之外的手段拒绝：把 xls 内容塞进 .xlsx 文件名
  const renamed = path.join(tmpRoot, 'renamed.xlsx');
  fs.writeFileSync(renamed, Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0, 1, 2, 3]));
  const res2 = checkExcelImport({ path: p, excelFile: renamed, simulate: false });
  assert.equal(res2.ok, false);
  assert.ok(hasCode(res2, 'XLS_UNSUPPORTED'));
});

// ============================== 9. 其它校验 ==============================
test('公式无缓存值：warning（离线无法求值），数据行按空值处理', () => {
  const p = makeTemplate();
  const file = writeXlsx(buildXlsx({
    styles: STYLES,
    sheets: [{
      name: 'Sheet1',
      content: rowXml(1, [cellXml.text('A1', 'ID'), cellXml.text('B1', '姓名'), cellXml.text('C1', '数量')])
        + rowXml(2, [cellXml.text('A2', 'k1'), cellXml.formula('B2', '"张"&"三"'), cellXml.number('C2', 3)]),
    }],
  }));
  const res = checkExcelImport({ path: p, excelFile: file, simulate: false });
  const hit = issuesOf(res, 'formula_no_cached_value');
  assert.equal(hit.length, 1);
  assert.equal(hit[0].severity, 'warning');
  assert.equal(hit[0].field, 'name');
  assert.deepEqual(hit[0].rows, [2]);
});

test('监听器（afterimportexcel）：只写 notes「需预览验证」，不假装已验证', () => {
  const p = makeTemplate({
    listener: { event: 'afterimportexcel', js: 'window.__importedAt = Date.now();' },
    buttons: ['submit', 'import-append'],
  });
  const res = checkExcelImport({ path: p, simulate: false, matrix: [['ID', '姓名', '数量'], ['k1', '张三', 3]] });
  const note = res.notes.filter((n) => n.code === 'listener_not_executed');
  assert.equal(note.length, 1);
  assert.match(note[0].message, /afterimportexcel/);
  assert.match(note[0].message, /填报预览/);
  assert.match(note[0].message, /不能算通过/);
});

test('行数截断：数据行超过 maxRows → rows_truncated warning + truncated 标记', () => {
  const p = makeTemplate();
  const rows = Array.from({ length: 5 }, (_, i) => [`k${i}`, `名${i}`, i + 1]);
  const res = checkExcelImport({ path: p, simulate: false, maxRows: 2, matrix: [['ID', '姓名', '数量'], ...rows] });
  assert.equal(res.excel.dataRowsTotal, 5);
  assert.equal(res.excel.dataRows, 2);
  assert.equal(res.excel.truncated, true);
  const hit = issuesOf(res, 'rows_truncated');
  assert.equal(hit.length, 1);
  assert.equal(hit[0].severity, 'warning');
});

test('maxRows 硬上限：>5000 压到 5000 并明确说明', () => {
  const p = makeTemplate();
  const res = checkExcelImport({ path: p, simulate: false, maxRows: 99999, matrix: [['ID', '姓名', '数量'], ['k1', '张三', 3]] });
  assert.ok(hasCode(res, 'max_rows_hard_cap'));
  assert.equal(res.excel.dataRows, 1);
});

test('无提交 / 自由 SQL 提交：明确 error，不崩溃', () => {
  const noSubmit = makeTemplate({ withSubmit: false });
  const res = checkExcelImport({ path: noSubmit, simulate: false, matrix: [['ID'], ['k1']] });
  assert.equal(res.ok, false);
  assert.equal(issuesOf(res, 'submit_not_found')[0].severity, 'error');

  const free = makeTemplate({ freeSql: 'INSERT INTO ods_t (id, name) VALUES (${id}, ${name})' });
  const res2 = checkExcelImport({ path: free, simulate: false, matrix: [['ID', '姓名', '数量'], ['k1', '张三', 3]] });
  assert.equal(res2.ok, false);
  assert.ok(hasCode(res2, 'free_sql_submit_not_supported'));
});

test('空数据行：跳过并计数，空 Excel 不算通过（no_data_rows warning）', () => {
  const p = makeTemplate();
  const res = checkExcelImport({
    path: p,
    simulate: false,
    matrix: [
      ['ID', '姓名', '数量'],
      ['', '', ''],
      ['k1', '张三', 3],
      ['', '', ''],
      ['k2', '李四', 4],
    ],
  });
  assert.equal(res.ok, true);
  assert.equal(res.excel.emptyRowsSkipped, 2, '中间/数据区内的空行跳过');
  assert.equal(res.excel.dataRows, 2);
  assert.ok(hasCode(res, 'empty_rows_skipped'));

  const empty = checkExcelImport({ path: p, simulate: false, matrix: [['ID', '姓名', '数量'], ['', '', '']] });
  assert.ok(hasCode(empty, 'no_data_rows'));
  assert.equal(empty.excel.dataRows, 0);
});

test('数据行控件是静态文本 → template_cell_not_editable warning', () => {
  seq += 1;
  const p = path.join(tmpRoot, `static-${seq}.cpt`);
  createCpt(p, { rows: 6, columns: 6, webWrite: true });
  addCell(p, { column: 0, row: 0, content: '姓名', contentType: 'text' });
  addCell(p, { column: 0, row: 1, content: '静态占位', contentType: 'text' }); // 数据行是静态文本，不是控件/数据集列
  addFillSubmit(p, { dsName: 'Doris', table: 'ods_t', bindings: [{ field: 'name', column: 0, row: 1, isKey: false }] });
  setFillToolbar(p, { buttons: ['submit', 'import-append'] });
  const res = checkExcelImport({ path: p, simulate: false, matrix: [['姓名'], ['张三']] });
  assert.ok(hasCode(res, 'template_cell_not_editable'));
  assert.equal(res.ok, true, '只是 warning：静态文本格导入后无法提交，但模板结构本身没坏');
});

test('纯库函数契约：默认值/常量表冻结，缺参抛 TypeError 级错误', () => {
  assert.ok(Object.isFrozen(EXCEL_IMPORT_DEFAULTS));
  assert.equal(EXCEL_IMPORT_DEFAULTS.maxRows, 2000);
  assert.equal(EXCEL_IMPORT_DEFAULTS.maxRowsHardCap, 5000);
  assert.ok(Object.isFrozen(EXCEL_IMPORT_BUTTONS));
  assert.equal(normalizeHeaderText(' 姓 名 '), '姓名');
  assert.equal(normalizeHeaderText('ＡＢＣ'), 'abc');
  assert.throws(() => checkExcelImport({}), /path/);
  const p = makeTemplate();
  assert.throws(() => checkExcelImport({ path: p }), /excelFile.*matrix|matrix.*excelFile/);
  assert.throws(() => checkExcelImport({ path: p, matrix: [['a']], columnOffset: 0.5 }), /columnOffset/);
  assert.throws(() => checkExcelImport({ path: p, matrix: [['a']], submitIndex: -1 }), /submitIndex/);
});

// ================= 2026-11-05 独立验收 P1-1：legacy 导入按钮识别 =================

test('scanExcelImportButtons：标记/自定义导入按钮进 legacyEffective（含 ui.impl / ExcelImport 变体），不参与位置匹配仿真', () => {
  const cases = [
    'com.fr.report.web.button.write.ImportExcelData',
    'com.fr.report.web.button.write.CustomizeImportExcelData',
    'com.fr.report.web.ui.impl.write.ImportExcelData',
    'com.fr.report.web.button.write.ExcelImport',
  ];
  for (const cls of cases) {
    seq += 1;
    const p = path.join(tmpRoot, `legacy-scan-${seq}.cpt`);
    createCpt(p, { rows: 6, columns: 6, webWrite: true });
    setFillToolbar(p, { buttons: ['submit', 'import-append'] });
    const raw = fs.readFileSync(p, 'utf8').replace('com.fr.report.web.button.write.ImExcelAppend', cls);
    fs.writeFileSync(p, raw, 'utf8');
    const scan = scanExcelImportButtons(load(p).parsed);
    assert.equal(scan.effective.length, 0, `${cls} 不应被当成普通导入按钮`);
    assert.equal(scan.legacyEffective.length, 1, `${cls} 应被识别为 legacy`);
    assert.equal(scan.legacyEffective[0].class, cls);
    assert.equal(scan.legacyEffective[0].mode, null);
    assert.equal(scan.legacyEffective[0].name, 'import-legacy');
  }
});

test('checkExcelImport：只有标记/自定义导入按钮 → legacyButtonFound + warning，明确"本仿真不覆盖"', () => {
  seq += 1;
  const p = path.join(tmpRoot, `legacy-check-${seq}.cpt`);
  createCpt(p, { rows: 6, columns: 6, webWrite: true });
  addCell(p, { column: 0, row: 0, content: '姓名', contentType: 'text' });
  addCell(p, { column: 0, row: 1, content: '张三', contentType: 'text' });
  addFillSubmit(p, { dsName: 'Doris', table: 'ods_t', bindings: [{ field: 'name', column: 0, row: 1, isKey: false }] });
  setFillToolbar(p, { buttons: ['submit', 'import-append'] });
  const raw = fs.readFileSync(p, 'utf8').replace(
    'com.fr.report.web.button.write.ImExcelAppend',
    'com.fr.report.web.button.write.CustomizeImportExcelData',
  );
  fs.writeFileSync(p, raw, 'utf8');
  const res = checkExcelImport({ path: p, simulate: false, matrix: [['姓名'], ['张三']] });
  assert.equal(res.import.buttonFound, false);
  assert.equal(res.import.legacyButtonFound, true);
  const legacyIssue = res.issues.find((i) => i.code === 'import_button_legacy_unsupported');
  assert.ok(legacyIssue, JSON.stringify(res.issues.map((i) => i.code)));
  assert.equal(legacyIssue.severity, 'warning');
  assert.match(legacyIssue.message, /标记\/自定义导入/);
  assert.match(legacyIssue.message, /FR 填报预览/);
  assert.equal(res.issues.some((i) => i.code === 'import_button_missing'), false, '有 legacy 按钮时不应误报"没有导入按钮"');
});
