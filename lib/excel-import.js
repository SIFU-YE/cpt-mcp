// cpt-mcp/lib/excel-import.js —— Excel 导入离线仿真（普通 Excel 导入 = 位置样式匹配 1:1）
//
// 【要解决的问题】报表 agent 在交付前无法验证「导入 Excel」这条链路：
//   · 模板工具栏有没有「导入Excel」按钮（缺失 → 用户点不到）；
//   · xlsx 的列位/标题与模板表头是否对得上（对不上 → 位置匹配不触发或数据错列）；
//   · 控件类型（文本/数字/日期/字典）与 xlsx 值是否兼容；
//   · 目标表约束（NOT NULL / UNIQUE / 类型）在真实提交时会不会炸。
// 本模块不依赖 FR 服务/浏览器，全部离线完成，可直接进 npm test。
//
// 【FR 语义依据】（fr-docs-mcp 只读参考，docs/excel-import.md 有摘录）
//   · 普通Excel导入（help doc 1091）：内置逻辑为「位置样式匹配」，模板预览的单元格位置样式与
//     Excel 文件完全一致时触发；触发后 Excel 中的数据按其所在单元格位置 **1:1** 导入模板。
//   · 普通Excel导入的不同方式（help doc 2311）：覆盖导入/清空导入/增量导入/自定义导入行列；
//     内置按钮 import-append=ImExcelAppend（导入Excel追加/增量）、import-clean=ImExcelClean
//     （清空后导入；清空只清页面数据，不清数据库）。
//   · 标题行不导入：数据行起点 = 模板列绑定（fillConfig columns[].row）的最小值。
//
// 【0 基/1 基结论（已用真实模板 拆分灌装资料登记表.cpt + lib/cpt.js 交叉核对，见 docs）】
//   CPT XML 的 <C c=".." r="..">、lib/cpt.js cells()、lib/cpt.js fillConfig() 的
//   column/row 全部是 **0 基**：c=0,r=0 即 A1；fillConfig 绑定 row=4 → A1 第 5 行。
//   交叉证据：① 该模板绑定 columns[].row=4，而 cells() 里 row=4 正是 DSColumn 数据行、
//   row=3 是表头文本行；② 同模板提交条件 FormulaCondition 公式 "Y5=1"（A1 1 基）指向
//   0 基 (col=24,row=4)，即数据行最后一格；③ 模板 afterimportexcel JS 里 `var S = 4`、
//   `COL_ID = 18` 与绑定 row=4 / id 列 column=18 完全一致。
//   因此本模块内部一律 0 基：xlsx 数据起始行 = fillConfig 绑定最小 row（xlsxDataRow），
//   列映射 templateColumn = xlsxColumn + columnOffset（columnOffset 默认 0 = 严格 1:1）。
//
// 【公开 API】
//   checkExcelImport({path, excelFile?, matrix?, sheet?, db?, connection?, submitIndex?, columnOffset?,
//                     headerRows?, maxRows?, simulate?, requireButton?}) -> 结果对象
//   返回结构（稳定，供 Lead 包进 local_db_import({action:"excel"})）：
//     {ok, path, excelFile, sheet,
//      import:{buttonFound,buttons,mode,submitIndex,submitName,submitClass,submitMode,
//              targetTable:{schema,name,full}, dataRow,templateDataRow,headerRows,columnOffset,
//              dataColumns,dataColumnCount,condition},
//      excel:{sheet,sheets,rows,columns,headerRows,dataRows,dataRowsTotal,emptyRowsSkipped,truncated,inlineMatrix},
//      mapping:[{xlsxColumn,templateColumn,field,cell,xlsxCell,templateRow,widget,kind,isKey,constant?}],
//      issues:[{severity,code,message,hint,row?,column?,field?}],
//      simulation:{attempted,status:'pass'|'failed'|'skipped'|'disabled',db,table:{schema,name,resolved},
//                  rows,inserted,rolledBack,errors,elapsedMs,reason?,nextAction?},
//      notes:[{code,message}], elapsedMs}
//   ok = 没有任何 severity:'error' 的 issue（warning/info 不影响交付，但要让人看见）。
//
// 【本地 SQLite 试跑】simulate=true 且本地库/目标表可用时，在事务里逐行 INSERT 后 **必然 ROLLBACK**：
//   · 本地库未建 / 目标表缺失 → simulation.status='skipped' + nextAction（local_db_import({action:"auto"})），
//     不算失败；离线仿真不能要求用户先建库。
//   · 主键字段为空时用唯一占位值（数字主键用负数、文本主键用 __cpt_excel_import_N__）并 warning：
//     FR 运行时会按主键策略生成，离线仿真只是让 INSERT 能走通。
//   · NOT NULL / UNIQUE / CHECK / 类型错误照常抛出，收进 simulation.errors，最后 ROLLBACK 并关闭连接，
//     不留事务/锁。
//
// 【边界（离线通过 ≠ 生产通过）】不执行模板里的 beforeimportexcel/afterimportexcel JS；不校验
// 权限、数据字典、真实库连接/触发器/存储过程、移动端；本地镜像是 MySQL DDL 的 SQLite 近似，
// 类型/约束语义可能与真实库不同。详见 docs/excel-import.md。
import path from 'node:path';
import { fillConfig, cells } from './cpt.js';
import { load } from './xml.js';
import { asArray, asReports } from './parsed-shape.js';
import { readWorkbook, readSheet, sheetMatrix, XlsxError, cellRefOf } from './xlsx-read.js';
import { resolveLocalDbName, openLocalDb, closeLocalDb, localTableInfo, listLocalTables } from './localdb.js';

// 内置导入按钮词表（与 lib/fill-integrity.js NON_DATA_WIDGETS、lib/edits.js TOOLBAR_BUTTONS 同源）
export const EXCEL_IMPORT_BUTTONS = Object.freeze({
  'com.fr.report.web.button.write.ImExcelAppend': { name: 'import-append', mode: 'append', label: '导入Excel追加（增量导入）' },
  'com.fr.report.web.button.write.ImExcelClean': { name: 'import-clean', mode: 'clean', label: '清空导入（先清空页面数据再导入）' },
});

/** 默认参数（Lead 的 MCP 工具 schema 依赖这些默认值，改动要同步文档） */
export const EXCEL_IMPORT_DEFAULTS = Object.freeze({
  submitIndex: 0,
  columnOffset: 0,
  maxRows: 2000, // 单次最多检查的数据行
  maxRowsHardCap: 5000, // maxRows 传再大也压到 5000（同步执行保护）
  simulate: true,
  requireButton: false,
  maxSimulationErrors: 20, // 试跑错误最多收集条数（防返回体爆炸）
});

const HEADER_SEVERITY = 'warning';

// ---------------- 通用小工具 ----------------

function issue(severity, code, message, extra = {}) {
  const out = { severity, code, message };
  if (extra.hint != null) out.hint = String(extra.hint);
  if (extra.row != null) out.row = Number(extra.row);
  if (extra.column != null) out.column = Number(extra.column);
  if (extra.field != null) out.field = String(extra.field);
  if (extra.rows != null) out.rows = extra.rows;
  if (extra.count != null) out.count = extra.count;
  if (extra.expected != null) out.expected = String(extra.expected);
  if (extra.actual != null) out.actual = String(extra.actual);
  return out;
}

function addIssue(res, severity, code, message, extra) {
  res.issues.push(issue(severity, code, message, extra));
}

function addNote(res, code, message) {
  res.notes.push({ code, message: String(message) });
}

function hasError(res) {
  return res.issues.some((i) => i.severity === 'error');
}

/** 结果骨架（字段固定，任何提前返回都用它，保证 MCP 返回结构稳定） */
function baseResult(input) {
  return {
    ok: false,
    path: input.path ?? null,
    excelFile: input.excelFile ?? null,
    sheet: null,
    import: {
      buttonFound: false,
      buttons: [],
      mode: null,
      submitIndex: input.submitIndex ?? EXCEL_IMPORT_DEFAULTS.submitIndex,
      submitName: null,
      submitClass: null,
      submitMode: null,
      targetTable: null,
      dataRow: null,
      templateDataRow: null,
      headerRows: null,
      columnOffset: input.columnOffset ?? EXCEL_IMPORT_DEFAULTS.columnOffset,
      dataColumns: [],
      dataColumnCount: 0,
      condition: null,
    },
    excel: {
      sheet: null,
      sheets: [],
      rows: 0,
      columns: 0,
      headerRows: 0,
      dataRows: 0,
      dataRowsTotal: 0,
      emptyRowsSkipped: 0,
      truncated: false,
      inlineMatrix: false,
    },
    mapping: [],
    issues: [],
    simulation: {
      attempted: false,
      status: 'disabled',
      db: null,
      table: null,
      rows: 0,
      inserted: 0,
      rolledBack: false,
      errors: [],
      elapsedMs: 0,
    },
    notes: [],
    elapsedMs: 0,
  };
}

function finalize(res, startedAt) {
  res.ok = !hasError(res);
  res.elapsedMs = Date.now() - startedAt;
  return res;
}

/** 全角→半角 + 去空白 + 小写：表头比对容忍「全角/半角、空格、大小写」差异 */
export function normalizeHeaderText(v) {
  return String(v ?? '')
    .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/\u3000/g, ' ')
    .replace(/\s+/g, '')
    .toLowerCase();
}

/** 宽松数字判定（数字控件：即使是 xlsx 文本格，FR 也可能按控件解析成数字） */
function lookNumeric(v) {
  if (typeof v === 'number') return Number.isFinite(v);
  if (typeof v === 'string' && v.trim() !== '') return Number.isFinite(Number(v.replace(/,/g, '')));
  return false;
}

/** 宽松日期文本判定（日期控件：字符串必须是常见日期写法；Excel 日期序列号也接受） */
function lookDateLike(v) {
  if (typeof v !== 'string') return false;
  const s = v.trim();
  if (!s) return false;
  if (/^\d{4}[-/.]\d{1,2}([-/.]\d{1,2})?([ T]\d{1,2}:\d{2}(:\d{2})?)?$/.test(s)) return true;
  return !Number.isNaN(Date.parse(s));
}

/** 控件 class → 值类型期望 */
function widgetKindOf(widgetClass) {
  const cls = String(widgetClass ?? '');
  if (!cls) return null;
  if (/DateEditor$/i.test(cls)) return 'date';
  if (/NumberEditor$/i.test(cls)) return 'number';
  if (/TextArea$|TextEditor$/i.test(cls)) return 'text';
  if (/ComboBox$|ComboCheckBox$|CheckBox$|RadioGroup$|ListBox$|CheckBoxGroup$/i.test(cls)) return 'dictionary';
  return 'other';
}

/** CPT 数值转 DB 值：日期取格式化文本、布尔转 0/1、空值转 null */
function cellToDbValue(cell) {
  if (!cell) return null;
  const v = cell.value;
  if (v == null || v === '') return null;
  switch (cell.type) {
    case 'number': return v;
    case 'boolean': return v ? 1 : 0;
    case 'date':
    case 'datetime':
    case 'time': return v;
    case 'error': return String(v); // 错误值真实导入会写错误文本；先按文本试跑
    default: return typeof v === 'string' ? v : String(v);
  }
}

/** SQLite 标识符加双引号 */
function quoteIdent(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

/** SQLite 报错归类（供 simulation.errors.code / issue 提示） */
function classifySimError(err) {
  const msg = String(err?.message ?? err ?? '');
  let m;
  if ((m = msg.match(/NOT NULL constraint failed:\s*([\w.$"]+)/i))) return { code: 'not_null', field: m[1].split('.').pop().replace(/"/g, '') };
  if ((m = msg.match(/UNIQUE constraint failed:\s*([\w.$",\s]+)/i))) return { code: 'unique', field: m[1].split(',')[0].split('.').pop().trim().replace(/"/g, '') };
  if ((m = msg.match(/CHECK constraint failed:\s*([\w.$"]+)/i))) return { code: 'check', field: m[1].split('.').pop().replace(/"/g, '') };
  if ((m = msg.match(/table\s+[\w.$"]+\s+has no column named\s+([\w$"]+)/i))) return { code: 'missing_column', field: m[1].replace(/"/g, '') };
  if ((m = msg.match(/datatype mismatch/i))) return { code: 'datatype_mismatch', field: null };
  return { code: 'insert_failed', field: null };
}

// ---------------- 填报工具栏按钮扫描 ----------------

/** 元素文本（CDATA 优先，xlsx 之外沿用 CPT 的 __cdata 约定） */
function cdataText(node) {
  if (node == null) return null;
  if (typeof node === 'string') return node;
  if (typeof node === 'object') {
    if (node.__cdata != null) return String(node.__cdata);
    if (node['#text'] != null) return String(node['#text']);
  }
  return null;
}

/**
 * 扫描模板工具栏里的内置 Excel 导入按钮（只读）。
 * 有效容器：WorkBook 级 WebWriteContent 与「对应 sheet 的 WebWriteContent」（FR 填报页面设置落这里）；
 * 落在 WebPageContent（数据分析页）的按钮不计入有效，但要给出「放错容器」提示。
 * @returns {{all:object[], effective:object[], legacyEffective:object[], misplaced:object[]}}
 *   effective = 普通导入按钮（ImExcelAppend/ImExcelClean，位置匹配仿真覆盖）；
 *   legacyEffective = 标记/自定义导入按钮（ImportExcelData/CustomizeImportExcelData/ExcelImport，
 *     含 com.fr.report.web.ui.impl.write.* 等变体）—— 离线仿真**不覆盖**，只做提示（2026-11-05 P1-1）。
 */
export function scanExcelImportButtons(parsed, sheetName = null) {
  const wb = parsed?.WorkBook ?? {};
  const containers = [];
  const wbWwc = wb.ReportWebAttr?.WebWriteContent;
  if (wbWwc) containers.push({ container: 'WebWriteContent', scope: 'workbook', sheet: null, node: wbWwc });
  for (const { report, sheet } of asReports(parsed)) {
    if (report?.WebWriteContent && report.WebWriteContent !== wbWwc) {
      containers.push({ container: 'WebWriteContent(sheet)', scope: 'sheet', sheet, node: report.WebWriteContent });
    }
  }
  const wbWpc = wb.ReportWebAttr?.WebPageContent;
  if (wbWpc) containers.push({ container: 'WebPageContent', scope: 'workbook', sheet: null, node: wbWpc });
  for (const { report, sheet } of asReports(parsed)) {
    if (report?.WebPageContent && report.WebPageContent !== wbWpc) {
      containers.push({ container: 'WebPageContent(sheet)', scope: 'sheet', sheet, node: report.WebPageContent });
    }
  }

  const all = [];
  for (const c of containers) {
    for (const tbm of asArray(c.node?.ToolBars?.ToolBarManager)) {
      for (const tb of asArray(tbm?.ToolBar)) {
        for (const w of asArray(tb?.Widget)) {
          const cls = w?.['@_class'] != null ? String(w['@_class']) : null;
          if (!cls) continue;
          const def = EXCEL_IMPORT_BUTTONS[cls] ?? null;
          // 2026-11-05 P1-1：官方样本里真实存在的导入按钮还有
          //   com.fr.report.web.button.write.ImportExcelData（27 份）
          //   com.fr.report.web.button.write.CustomizeImportExcelData（8 份）
          //   com.fr.report.web.ui.impl.write.ImportExcelData（2 份）
          //   com.fr.report.web.button.write.ExcelImport（1 份）
          // 这些是「标记导入/自定义导入」，不是位置匹配的普通导入：识别出来只作提示，不参与仿真。
          const isLegacy = /(?:^|\.)(?:ImportExcelData|CustomizeImportExcelData|ExcelImport)$/.test(cls);
          // 只报「Excel 导入相关」按钮：普通两个 + legacy 四类 + 任何 ImExcel*/ExcelImport*（未知形态也提示）
          const looksImport = def != null || isLegacy || /(^|\.)ImExcel|ExcelImport/i.test(cls);
          if (!looksImport) continue;
          all.push({
            class: cls,
            name: def?.name ?? (isLegacy ? 'import-legacy' : null),
            mode: def?.mode ?? null,
            label: def?.label ?? (isLegacy ? '标记导入/自定义导入（离线仿真不覆盖）' : null),
            legacy: isLegacy,
            text: cdataText(w.Text),
            container: c.container,
            scope: c.scope,
            sheet: c.sheet,
          });
        }
      }
    }
  }
  const effectiveAll = all.filter((b) => {
    if (b.container === 'WebWriteContent') return true;
    if (b.container === 'WebWriteContent(sheet)') return !sheetName || !b.sheet || b.sheet === sheetName;
    return false;
  });
  const effective = effectiveAll.filter((b) => !b.legacy);
  const legacyEffective = effectiveAll.filter((b) => b.legacy);
  const misplaced = all.filter((b) => !effectiveAll.includes(b));
  return { all, effective, legacyEffective, misplaced };
}

// ---------------- 模板侧：单元格 / 表头 / 绑定 ----------------
function cellKey(row, column) {
  return `${row}:${column}`;
}

/** 汇总某 sheet 的模板单元格（cells() 已统一 0 基） */
function collectTemplateCells(cptPath, sheetName) {
  const all = cells(cptPath);
  const wanted = sheetName == null ? all : all.filter((c) => c.sheet === sheetName);
  const list = wanted.length ? wanted : all;
  const byKey = new Map();
  let maxColumn = -1;
  let sheetIndex = null;
  let sheet = null;
  for (const c of list) {
    if (c.column != null && c.row != null) byKey.set(cellKey(c.row, c.column), c);
    if (c.column != null && c.column > maxColumn) maxColumn = c.column;
    if (sheetIndex == null && c.sheetIndex != null) sheetIndex = c.sheetIndex;
    if (sheet == null && c.sheet != null) sheet = c.sheet;
  }
  return { cells: list, byKey, maxColumn, sheetIndex, sheet };
}

/** 模板表头文本：数据行上方最近的一个非空静态文本格（合并表头取锚点即可对上） */
function findTemplateHeader(templateCells, column, templateDataRow) {
  for (let row = templateDataRow - 1; row >= 0; row--) {
    const cell = templateCells.byKey.get(cellKey(row, column));
    if (!cell) continue;
    const text = cell.contentKind === 'text' ? String(cell.contentText ?? '').trim() : '';
    if (text !== '') return { row, text, cell };
  }
  return null;
}

// ---------------- xlsx 侧：读 sheet / 内联 matrix ----------------
/** 内联矩阵（不读文件）→ 与 readSheet 同形的 sheet 对象（matrix 可选入口） */
export function matrixToSheet(matrix, name = '(inline-matrix)') {
  if (!Array.isArray(matrix) || matrix.length === 0) {
    throw new Error('checkExcelImport: matrix 必须是非空二维数组（每行一个数组）');
  }
  const cellsOut = [];
  let maxRow = -1;
  let maxCol = -1;
  matrix.forEach((rowArr, row) => {
    if (!Array.isArray(rowArr)) throw new Error(`checkExcelImport: matrix[${row}] 必须是数组`);
    if (rowArr.length - 1 > maxCol) maxCol = rowArr.length - 1;
    rowArr.forEach((raw, col) => {
      let value = raw;
      let type = 'string';
      if (raw == null || raw === '') return;
      if (typeof raw === 'number') { type = Number.isFinite(raw) ? 'number' : 'string'; if (!Number.isFinite(raw)) value = String(raw); }
      else if (typeof raw === 'boolean') type = 'boolean';
      else if (typeof raw === 'object' && raw !== null && 'value' in raw) { value = raw.value; type = raw.type ?? (typeof value === 'number' ? 'number' : 'string'); }
      else value = String(raw);
      if (value == null || value === '') return;
      cellsOut.push({ row, col, ref: cellRefOf(row, col), value, raw: value, type });
      if (row > maxRow) maxRow = row;
    });
  });
  // 与 xlsx 语义对齐：尾随空行不算数据行（尾随空列仍按 matrix 行宽保留）
  return {
    name,
    index: 0,
    kind: 'worksheet',
    inlineMatrix: true,
    rows: Math.max(0, maxRow + 1),
    columns: Math.max(0, maxCol + 1),
    maxRow,
    maxCol,
    cellCount: cellsOut.length,
    cells: cellsOut,
    merges: [],
  };
}

// ---------------- 主入口 ----------------
/**
 * 校验「模板 + Excel + 本地目标表」能否支撑一次普通 Excel 导入（只读；本地试跑在事务内且必然回滚）。
 * @param {object} input
 * @param {string} input.path .cpt 模板路径（必填）
 * @param {string} [input.excelFile] .xlsx 文件路径（与 matrix 二选一）
 * @param {Array<Array>} [input.matrix] 内联数据矩阵（可选入口，不读文件）
 * @param {string|number} [input.sheet] xlsx sheet 名或 0 基索引
 * @param {string} [input.db] 本地 SQLite 库名（缺省按连接名解析）
 * @param {string} [input.connection] 数据连接名覆盖（默认取提交的 dsName）
 * @param {number} [input.submitIndex=0] fillConfig 提交索引
 * @param {number} [input.columnOffset=0] 列偏移：templateColumn = xlsxColumn + columnOffset
 * @param {number} [input.headerRows] 标题行数覆盖（默认 = 模板数据行 0 基坐标）
 * @param {number} [input.maxRows=2000] 最多检查的数据行（上限 5000）
 * @param {boolean} [input.simulate=true] 是否做本地 SQLite 试跑
 * @param {boolean} [input.requireButton=false] 缺失导入按钮是否升为 error
 * @returns {object} 见文件头返回结构
 */
export function checkExcelImport(input = {}) {
  const startedAt = Date.now();
  const opts = {
    ...EXCEL_IMPORT_DEFAULTS,
    ...input,
    submitIndex: input.submitIndex == null ? EXCEL_IMPORT_DEFAULTS.submitIndex : Number(input.submitIndex),
    columnOffset: input.columnOffset == null ? EXCEL_IMPORT_DEFAULTS.columnOffset : Number(input.columnOffset),
    maxRows: input.maxRows == null ? EXCEL_IMPORT_DEFAULTS.maxRows : Number(input.maxRows),
    simulate: input.simulate !== false,
    requireButton: input.requireButton === true,
  };
  if (!opts.path || String(opts.path).trim() === '') {
    throw new Error('checkExcelImport: path（.cpt 模板路径）必填');
  }
  if (!Number.isInteger(opts.submitIndex) || opts.submitIndex < 0) throw new Error(`checkExcelImport: submitIndex 必须是非负整数，收到 ${input.submitIndex}`);
  if (!Number.isInteger(opts.columnOffset)) throw new Error(`checkExcelImport: columnOffset 必须是整数，收到 ${input.columnOffset}`);
  if (input.headerRows != null && (!Number.isInteger(Number(input.headerRows)) || Number(input.headerRows) < 0)) {
    throw new Error(`checkExcelImport: headerRows 必须是非负整数，收到 ${input.headerRows}`);
  }
  if (!Number.isInteger(opts.maxRows) || opts.maxRows < 1) throw new Error(`checkExcelImport: maxRows 必须是正整数，收到 ${input.maxRows}`);
  if (!opts.excelFile && !Array.isArray(input.matrix)) {
    throw new Error('checkExcelImport: 需要 excelFile（.xlsx 路径）或 matrix（内联二维数组）之一');
  }

  const res = baseResult({ ...input, ...opts });
  res.path = path.resolve(String(opts.path));

  // ---- 1) 模板：fillConfig（提交/绑定/目标表）+ 工具栏按钮 + 单元格 ----
  let fill = null;
  try {
    fill = fillConfig(res.path);
  } catch (e) {
    addIssue(res, 'error', 'cpt_read_failed', `读取模板 fillConfig 失败：${e.message}`, { hint: '确认 path 是 flat XML 的 .cpt（ZIP 容器 .cpt 需先反编译）' });
    return finalize(res, startedAt);
  }
  const submits = Array.isArray(fill.submits) ? fill.submits : [];
  if (submits.length === 0) {
    addIssue(res, 'error', 'submit_not_found', '模板没有任何填报提交（SubmitVisitor），Excel 导入后无处提交', { hint: '先用 get_fill_config 查看；模板需要 add_fill_submit 建内置 SQL 提交（BuiltInSQLSubmiter）' });
    return finalize(res, startedAt);
  }
  const submit = submits[opts.submitIndex];
  if (!submit) {
    addIssue(res, 'error', 'submit_not_found', `提交索引 ${opts.submitIndex} 不存在（共 ${submits.length} 个）`, { hint: `submitIndex 取 0..${submits.length - 1}` });
    return finalize(res, startedAt);
  }
  res.import.submitName = submit.name ?? null;
  res.import.submitClass = submit.class ?? null;
  res.import.submitMode = submit.mode ?? null;
  res.import.condition = submit.condition ?? null;

  let parsed = null;
  try {
    parsed = load(res.path).parsed;
  } catch (e) {
    addIssue(res, 'error', 'cpt_read_failed', `读取模板 XML 失败：${e.message}`, { hint: '确认 .cpt 是 flat XML 1.0' });
    return finalize(res, startedAt);
  }
  const buttonScan = scanExcelImportButtons(parsed, submit.sheet ?? null);
  res.import.buttons = buttonScan.all.map((b) => ({
    class: b.class, name: b.name, mode: b.mode, text: b.text, container: b.container, sheet: b.sheet,
  }));
  res.import.buttonFound = buttonScan.effective.length > 0;
  res.import.mode = buttonScan.effective[0]?.mode ?? null;
  // 2026-11-05 P1-1：标记/自定义导入按钮（legacy）识别出来后只提示、不参与位置匹配仿真
  const legacyButtons = Array.isArray(buttonScan.legacyEffective) ? buttonScan.legacyEffective : [];
  res.import.legacyButtonFound = legacyButtons.length > 0;
  if (res.import.buttonFound) {
    const modes = [...new Set(buttonScan.effective.map((b) => b.mode).filter(Boolean))];
    addNote(res, 'import_button', `工具栏含 Excel 导入按钮：${buttonScan.effective.map((b) => b.label ?? b.class).join('、')}；导入方式=${modes.join('/')}`
      + (res.import.mode === 'append' ? '（增量：数据追加到页面数据结尾行）' : res.import.mode === 'clean' ? '（清空：先清空页面数据再导入，仅清页面不清库）' : ''));
  } else if (legacyButtons.length > 0) {
    // 有导入按钮，但是标记/自定义导入（列映射/过滤语义）→ 本仿真不覆盖，必须 FR 预览验证
    addIssue(res, 'warning', 'import_button_legacy_unsupported',
      `模板只有标记/自定义导入按钮（${[...new Set(legacyButtons.map((b) => b.class))].join('、')}）：本仿真只覆盖普通导入（位置样式匹配 1:1），标记导入的列映射/过滤语义请用 FR 填报预览验证`, {
        hint: '普通导入按钮用 set_fill_toolbar({path, buttons:["import-append"]})；保留标记导入时，本工具只能验按钮存在性，不能替代 FR 预览',
      });
    if (buttonScan.misplaced.length > 0) {
      addIssue(res, 'warning', 'import_button_wrong_container', `找到 Excel 导入按钮，但放在 ${[...new Set(buttonScan.misplaced.map((b) => b.container))].join('/')}，填报预览工具栏不会显示`, {
        hint: '把按钮加到「模板 > 模板web属性 > 填报页面设置」的工具栏（落盘位置是 WebWriteContent），可用 set_fill_toolbar({buttons:["import-append"]})',
      });
    }
  } else {
    if (buttonScan.misplaced.length > 0) {
      addIssue(res, 'warning', 'import_button_wrong_container', `找到 Excel 导入按钮，但放在 ${[...new Set(buttonScan.misplaced.map((b) => b.container))].join('/')}，填报预览工具栏不会显示`, {
        hint: '把按钮加到「模板 > 模板web属性 > 填报页面设置」的工具栏（落盘位置是 WebWriteContent），可用 set_fill_toolbar({buttons:["import-append"]})',
      });
    }
    addIssue(res, opts.requireButton ? 'error' : 'warning', 'import_button_missing', '模板工具栏没有「导入Excel」内置按钮（ImExcelAppend / ImExcelClean），填报页面上用户无法触发 Excel 导入', {
      hint: '用 set_fill_toolbar({path, buttons:["import-append"]})（追加/增量）或 ["import-clean"]（清空）补按钮；改完可重跑本检查',
    });
  }

  // ---- 2) xlsx / matrix 读取 ----
  let wb = null;
  let sheet = null;
  if (Array.isArray(input.matrix)) {
    try {
      sheet = matrixToSheet(input.matrix);
    } catch (e) {
      addIssue(res, 'error', 'matrix_invalid', e.message, { hint: 'matrix 形如 [["标题1","标题2"],["v1","v2"]]' });
      return finalize(res, startedAt);
    }
    res.excel.inlineMatrix = true;
    res.excel.sheets = [sheet.name];
    addNote(res, 'inline_matrix', '本次用的是内联 matrix（未读 .xlsx 文件）；列位/标题语义与位置匹配一致');
  } else {
    try {
      wb = readWorkbook(opts.excelFile);
      res.excel.sheets = wb.sheetNames.slice();
      const wanted = input.sheet != null ? input.sheet : undefined;
      if (wanted != null) {
        sheet = readSheet(wb, wanted);
      } else {
        // 缺省：优先按模板 sheet 名匹配（多 sheet 模板场景），否则取第一个
        const byName = submit.sheet && wb.sheets.find((s) => s.name === submit.sheet);
        sheet = readSheet(wb, byName ? byName.index : 0);
        if (byName == null) {
          addNote(res, 'sheet_defaulted', `未指定 sheet，默认读取第 1 个：「${sheet.name}」${wb.sheets.length > 1 ? `（工作簿共 ${wb.sheets.length} 个 sheet）` : ''}`);
        }
      }
    } catch (e) {
      if (e instanceof XlsxError) {
        addIssue(res, 'error', e.code, e.message, { hint: xlsxErrorHint(e.code) });
      } else {
        addIssue(res, 'error', 'xlsx_read_failed', `读取 Excel 失败：${e.message}`, { hint: '确认文件可读、未被其它程序占用' });
      }
      return finalize(res, startedAt);
    }
  }
  res.excelFile = opts.excelFile ?? null;
  res.sheet = sheet.name;
  res.excel.sheet = sheet.name;
  res.excel.rows = sheet.rows;
  res.excel.columns = sheet.columns;

  // ---- 3) 提交形态与绑定映射 ----
  if (submit.mode === 'free-sql') {
    addIssue(res, 'error', 'free_sql_submit_not_supported', '当前提交是自由 SQL 提交（FreeSQLSubmiter），没有列绑定；普通 Excel 导入按位置写入页面单元格，需要 BuiltInSQLSubmiter 的 ColumnConfig 列映射才能校验', {
      hint: '改用 BuiltInSQLSubmiter（add_fill_submit({table,bindings})），或只做按钮检查后再人工确认',
    });
    return finalize(res, startedAt);
  }
  if (!submit.table) {
    addIssue(res, 'error', 'target_table_missing', '提交没有目标表（fillConfig.submits[i].table 为空）', { hint: 'update_fill_submit 补 table/schema' });
    return finalize(res, startedAt);
  }
  res.import.targetTable = {
    schema: submit.schema ?? '',
    name: submit.table,
    full: submit.schema ? `${submit.schema}.${submit.table}` : submit.table,
  };
  const bindings = Array.isArray(submit.columns) ? submit.columns : [];
  if (bindings.length === 0) {
    addIssue(res, 'error', 'no_fill_bindings', '提交没有任何字段绑定（ColumnConfig），Excel 导入后无法落库', { hint: '用 get_fill_config 查看，再 add_fill_binding 补字段' });
    return finalize(res, startedAt);
  }
  const dupFields = new Map();
  for (const b of bindings) {
    if (!b.field) continue;
    dupFields.set(b.field, (dupFields.get(b.field) ?? 0) + 1);
  }
  const duplicated = [...dupFields.entries()].filter(([, n]) => n > 1).map(([f]) => f);
  if (duplicated.length) {
    addIssue(res, 'error', 'duplicate_field_binding', `同一提交里字段重复绑定：${duplicated.join('、')}`, { hint: '删除重复 ColumnConfig（同名绑定 FR 提交行为未定义）' });
  }
  const coordinateBindings = bindings.filter((b) => b.constant == null && Number.isInteger(b.column) && Number.isInteger(b.row));
  const constantBindings = bindings.filter((b) => b.constant != null);
  if (coordinateBindings.length === 0) {
    addIssue(res, 'error', 'no_coordinate_bindings', '提交没有任何「单元格坐标」绑定（全是常量），无法按位置接收 Excel 数据', { hint: '给需要从 Excel 取数的字段 add_fill_binding 配 column/row' });
    return finalize(res, startedAt);
  }

  const templateDataRow = Math.min(...coordinateBindings.map((b) => b.row));
  const bindingRows = [...new Set(coordinateBindings.map((b) => b.row))].sort((a, b) => a - b);
  if (bindingRows.length > 1) {
    addIssue(res, 'warning', 'binding_rows_mismatch', `绑定分布在多行（0 基 row=${bindingRows.join('、')}），普通 Excel 导入按数据行扩展，只以最小行 ${templateDataRow} 为数据起始行`, { hint: '确认是否本来就要绑定同一数据行的不同列' });
  }
  // headerRows 覆盖：Excel 标题行数与模板数据行 0 基坐标不一致时用，如 Excel 多了 1 行说明
  const xlsxDataRow = input.headerRows != null ? Number(input.headerRows) : templateDataRow;
  if (input.headerRows != null && xlsxDataRow !== templateDataRow) {
    addNote(res, 'header_rows_override', `headerRows=${xlsxDataRow}（模板数据行 0 基=${templateDataRow}）：Excel 前 ${xlsxDataRow} 行按标题/表头处理，数据从 Excel 第 ${xlsxDataRow + 1} 行起、写入模板第 ${templateDataRow + 1} 行起`);
  }
  res.import.dataRow = xlsxDataRow;
  res.import.templateDataRow = templateDataRow;
  res.import.headerRows = xlsxDataRow;
  res.excel.headerRows = xlsxDataRow;

  let templateCells;
  try {
    templateCells = collectTemplateCells(res.path, submit.sheet ?? null);
  } catch (e) {
    addIssue(res, 'error', 'cpt_read_failed', `读取模板单元格失败：${e.message}`, { hint: '确认 .cpt 可被 cells() 解析' });
    return finalize(res, startedAt);
  }

  // mapping：xlsx 列 = 模板列 - columnOffset（templateColumn = xlsxColumn + columnOffset）
  const mapping = [];
  for (const b of coordinateBindings) {
    const templateColumn = b.column;
    const xlsxColumn = templateColumn - opts.columnOffset;
    const templateCell = templateCells.byKey.get(cellKey(b.row, templateColumn)) ?? null;
    const widget = templateCell?.widgetClass ?? null;
    mapping.push({
      xlsxColumn,
      templateColumn,
      field: b.field ?? null,
      cell: cellRefOf(b.row, templateColumn),
      xlsxCell: xlsxColumn >= 0 ? cellRefOf(xlsxDataRow, xlsxColumn) : null,
      templateRow: b.row,
      widget,
      widgetKind: widgetKindOf(widget),
      kind: 'xlsx',
      isKey: b.isKey === true,
    });
    if (!templateCell) {
      addIssue(res, 'warning', 'template_cell_missing', `绑定字段 ${b.field ?? '?'} 指向的模板单元格 ${cellRefOf(b.row, templateColumn)} 不存在（0 基 row=${b.row}, column=${templateColumn}）`, {
        row: b.row, column: templateColumn, field: b.field,
        hint: '位置匹配按单元格写入，数据行缺格会写不进去；在设计器/用 add_cell 补该格',
      });
    } else if (!templateCell.widgetClass && templateCell.contentObjectType !== 'DSColumn' && templateCell.contentKind === 'text') {
      addIssue(res, 'warning', 'template_cell_not_editable', `绑定字段 ${b.field ?? '?'} 的模板格 ${cellRefOf(b.row, templateColumn)} 是静态文本，Excel 导入后无法录入/提交`, {
        row: b.row, column: templateColumn, field: b.field,
        hint: '改成可录入控件（add_cell/update_cell 加 widget）或数据集列（contentType:"dsColumn"）',
      });
    }
    // 列位越界：Excel 里根本没有这一列
    if (xlsxColumn < 0) {
      addIssue(res, 'error', 'column_offset_out_of_range', `字段 ${b.field ?? '?'} 的模板列 ${templateColumn} 减去 columnOffset=${opts.columnOffset} 后是 xlsx 列 ${xlsxColumn}（<0，Excel 不存在）`, {
        column: b.xlsxColumn ?? undefined, field: b.field,
        hint: `columnOffset 太大：它表示「xlsx 列 + columnOffset = 模板列」，默认 0 即严格 1:1`,
      });
    } else if (xlsxColumn > sheet.maxCol) {
      addIssue(res, b.isKey ? 'warning' : 'error', 'template_column_missing', `模板绑定列 ${templateColumn}（字段 ${b.field ?? '?'}）对应 xlsx 第 ${xlsxColumn} 列（0 基），超出 Excel 实际列范围（0..${sheet.maxCol}）`, {
        column: xlsxColumn, field: b.field,
        hint: b.isKey
          ? 'Excel 少了该列：主键可由 FR 运行时生成，但请确认确实是这个策略；非主键字段缺列会永远取不到数'
          : 'Excel 少了该列：检查 columnOffset 或补列；缺这列该字段永远取不到数',
      });
    }
  }
  for (const b of constantBindings) {
    mapping.push({
      xlsxColumn: null,
      templateColumn: null,
      field: b.field ?? null,
      cell: b.column != null && b.row != null ? cellRefOf(b.row, b.column) : null,
      xlsxCell: null,
      templateRow: b.row ?? null,
      widget: null,
      widgetKind: null,
      kind: 'constant',
      isKey: b.isKey === true,
      constant: b.constant,
    });
  }
  mapping.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'xlsx' ? -1 : 1;
    return (a.templateColumn ?? 0) - (b.templateColumn ?? 0);
  });
  res.mapping = mapping;
  res.import.dataColumns = mapping.filter((m) => m.kind === 'xlsx').map((m) => m.templateColumn);
  res.import.dataColumnCount = res.import.dataColumns.length;
  if (constantBindings.length > 0) {
    addNote(res, 'constant_bindings', `常量绑定字段（不从 Excel 取数，提交时用常量值）：${constantBindings.map((b) => `${b.field}=${JSON.stringify(b.constant)}`).join('、')}`);
  }
  // Excel 比模板宽：超出部分不会被位置匹配导入（模板最大列即布局右边界）
  const templateMaxXlsxColumn = templateCells.maxColumn - opts.columnOffset;
  if (sheet.maxCol > templateMaxXlsxColumn) {
    addIssue(res, 'warning', 'excel_extra_columns', `Excel 有 ${sheet.maxCol + 1} 列（0 基 0..${sheet.maxCol}），模板布局只到第 ${templateMaxXlsxColumn + 1} 列（0 基 ${templateMaxXlsxColumn}）：超出部分不会被导入`, {
      hint: '确认 Excel 是否多了列；多余列可忽略，但错列会整体错位',
    });
  }

  // ---- 4) 表头比对（数据行之前的行；标题行不导入，但要能对齐） ----
  const delta = xlsxDataRow - templateDataRow;
  const headerComparisons = [];
  for (const m of mapping) {
    if (m.kind !== 'xlsx') continue;
    if (m.xlsxColumn < 0 || m.xlsxColumn > sheet.maxCol) continue; // 列位本身已报，避免重复噪声
    const tplHeader = findTemplateHeader(templateCells, m.templateColumn, templateDataRow);
    if (!tplHeader) continue;
    const xlsxHeaderRow = tplHeader.row + delta;
    headerComparisons.push({ mapping: m, templateHeader: tplHeader.text, templateHeaderRow: tplHeader.row, xlsxHeaderRow });
  }
  // 只在需要时构建矩阵（表头行 + 数据行 + 截断检测都够用）
  const effectiveMaxRows = Math.min(opts.maxRows, EXCEL_IMPORT_DEFAULTS.maxRowsHardCap);
  if (opts.maxRows > EXCEL_IMPORT_DEFAULTS.maxRowsHardCap) {
    addIssue(res, 'warning', 'max_rows_hard_cap', `maxRows=${opts.maxRows} 超过单次同步检查上限 ${EXCEL_IMPORT_DEFAULTS.maxRowsHardCap}，已按 ${effectiveMaxRows} 行截断`, { hint: '分批检查，或先抽样验证列/表头再全量' });
  }
  let dataRowsTotal = Math.max(0, sheet.maxRow + 1 - xlsxDataRow);
  let scanRows = Math.min(sheet.maxRow + 1, xlsxDataRow + effectiveMaxRows);
  if (scanRows < xlsxDataRow) scanRows = xlsxDataRow;
  const grid = sheetMatrix(sheet, { maxRows: scanRows, maxCols: sheet.columns });

  for (const h of headerComparisons) {
    if (h.xlsxHeaderRow < 0 || h.xlsxHeaderRow >= xlsxDataRow) continue;
    const cell = grid.matrix?.[h.xlsxHeaderRow]?.[h.mapping.xlsxColumn];
    const actualText = cell && cell.type !== 'empty' ? String(cell.value ?? '') : '';
    if (normalizeHeaderText(actualText) === '') {
      addIssue(res, HEADER_SEVERITY, 'header_missing', `表头缺失：模板 ${cellRefOf(h.templateHeaderRow, h.mapping.templateColumn)} 是「${h.templateHeader}」，Excel 同位置 ${cellRefOf(h.xlsxHeaderRow, h.mapping.xlsxColumn)} 为空`, {
        row: h.xlsxHeaderRow, column: h.mapping.xlsxColumn, field: h.mapping.field,
        hint: '普通 Excel 导入要求位置样式一致；Excel 表头行别删/别错位（标题行不导入，但位置要对齐）',
      });
    } else if (normalizeHeaderText(actualText) !== normalizeHeaderText(h.templateHeader)) {
      addIssue(res, HEADER_SEVERITY, 'header_mismatch', `表头不一致：模板 ${cellRefOf(h.templateHeaderRow, h.mapping.templateColumn)}「${h.templateHeader}」 vs Excel ${cellRefOf(h.xlsxHeaderRow, h.mapping.xlsxColumn)}「${actualText}」`, {
        row: h.xlsxHeaderRow, column: h.mapping.xlsxColumn, field: h.mapping.field,
        expected: h.templateHeader, actual: actualText,
        hint: '容忍全角/半角与空格差异；文字确实不同时确认是否改过标题——位置匹配不按标题找列，但错位会整列错数据',
      });
    }
  }

  // ---- 5) 数据行：空行跳过 / 截断 / 值类型 / 公式缓存 ----
  const dataRows = [];
  const emptyRows = [];
  const formulaNoCache = new Map(); // field → rows
  const errorValues = new Map();
  const widgetMismatch = new Map(); // `${code}|${field}` → rows
  const keyEmpty = new Map(); // field → rows
  const dictionaryWidgets = new Set();
  const mappedForValues = mapping.filter((m) => m.kind === 'xlsx');
  for (let i = 0; i < effectiveMaxRows; i++) {
    const xlsxRow = xlsxDataRow + i;
    if (xlsxRow > sheet.maxRow) break;
    const rowCells = mappedForValues.map((m) => grid.matrix?.[xlsxRow]?.[m.xlsxColumn] ?? null);
    const hasAny = rowCells.some((c) => c && c.type !== 'empty');
    if (!hasAny) {
      emptyRows.push(xlsxRow);
      continue;
    }
    const values = [];
    for (let k = 0; k < mappedForValues.length; k++) {
      const m = mappedForValues[k];
      const c = rowCells[k];
      if (c && c.formula != null && (c.value == null || c.type === 'empty')) {
        if (!formulaNoCache.has(m.field)) formulaNoCache.set(m.field, { column: m.xlsxColumn, rows: [] });
        const rec = formulaNoCache.get(m.field);
        if (rec.rows.length < 20) rec.rows.push(xlsxRow);
      }
      if (c && c.type === 'error') {
        if (!errorValues.has(m.field)) errorValues.set(m.field, { column: m.xlsxColumn, rows: [] });
        const rec = errorValues.get(m.field);
        if (rec.rows.length < 20) rec.rows.push(xlsxRow);
      }
      if (m.widgetKind === 'dictionary') dictionaryWidgets.add(m.widget);
      const value = cellToDbValue(c);
      // 控件类型/格式检查（只在有值时；空值交给数据库约束试跑）
      if (value != null && m.widgetKind === 'number' && !lookNumeric(value)) {
        const key = `widget_number_mismatch|${m.field}`;
        if (!widgetMismatch.has(key)) widgetMismatch.set(key, { column: m.xlsxColumn, widget: m.widget, rows: [] });
        if (widgetMismatch.get(key).rows.length < 20) widgetMismatch.get(key).rows.push(xlsxRow);
      }
      if (value != null && m.widgetKind === 'date' && typeof value === 'string' && !lookDateLike(value)) {
        const key = `widget_date_mismatch|${m.field}`;
        if (!widgetMismatch.has(key)) widgetMismatch.set(key, { column: m.xlsxColumn, widget: m.widget, rows: [] });
        if (widgetMismatch.get(key).rows.length < 20) widgetMismatch.get(key).rows.push(xlsxRow);
      }
      if (m.isKey && value == null) {
        if (!keyEmpty.has(m.field)) keyEmpty.set(m.field, []);
        if (keyEmpty.get(m.field).length < 20) keyEmpty.get(m.field).push(xlsxRow);
      }
      values.push({ field: m.field, xlsxColumn: m.xlsxColumn, cell: c, value });
    }
    dataRows.push({ index: i, xlsxRow, values });
    if (dataRows.length >= effectiveMaxRows) break;
  }
  res.excel.dataRowsTotal = dataRowsTotal;
  res.excel.dataRows = dataRows.length;
  res.excel.emptyRowsSkipped = emptyRows.length;
  res.excel.truncated = dataRowsTotal > effectiveMaxRows;
  if (emptyRows.length > 0) {
    addIssue(res, 'info', 'empty_rows_skipped', `跳过 ${emptyRows.length} 个空数据行（Excel 0 基行：${emptyRows.slice(0, 20).map((r) => r + 1).join('、')}${emptyRows.length > 20 ? '…' : ''}）`, {
      rows: emptyRows.slice(0, 20).map((r) => r + 1),
      hint: '空行不写入目标表；若本应导入请检查是否漏填/公式未缓存',
    });
  }
  if (res.excel.truncated) {
    addIssue(res, 'warning', 'rows_truncated', `Excel 有 ${dataRowsTotal} 个数据行（含空行），本次只检查前 ${effectiveMaxRows} 行`, { hint: '分批检查或调大 maxRows（硬上限 5000）' });
  }
  if (dataRows.length === 0) {
    addIssue(res, 'warning', 'no_data_rows', `Excel 从第 ${xlsxDataRow + 1} 行（0 基 ${xlsxDataRow}）起没有非空数据行，导入不会写入任何数据`, { hint: '确认数据行起点（模板绑定 row）和 Excel 内容是否匹配' });
  }
  for (const [field, rec] of formulaNoCache) {
    addIssue(res, 'warning', 'formula_no_cached_value', `字段 ${field} 的 xlsx 单元格有公式但没有缓存值（${rec.rows.map((r) => r + 1).join('、')} 行）`, {
      column: rec.column, field, rows: rec.rows.map((r) => r + 1), count: rec.rows.length,
      hint: '离线无法求值公式：用 Excel/WPS 打开后重新保存（会写缓存值），或把公式列改成值',
    });
  }
  for (const [field, rec] of errorValues) {
    addIssue(res, 'warning', 'excel_error_value', `字段 ${field} 的 xlsx 单元格是错误值（如 #DIV/0!，${rec.rows.map((r) => r + 1).join('、')} 行）`, {
      column: rec.column, field, rows: rec.rows.map((r) => r + 1), count: rec.rows.length,
      hint: '错误值会被原样导入页面（提交可能变成文本/空），先在 Excel 修好',
    });
  }
  for (const [key, rec] of widgetMismatch) {
    const [code, field] = key.split('|');
    addIssue(res, 'warning', code, `字段 ${field} 的控件（${rec.widget}）与 xlsx 值格式不符（${rec.rows.map((r) => r + 1).join('、')} 行）`, {
      column: rec.column, field, rows: rec.rows.map((r) => r + 1), count: rec.rows.length,
      hint: code === 'widget_number_mismatch' ? '数字控件期望数值：xlsx 该列应改数字格式/去掉文本后缀' : '日期控件期望日期：xlsx 该列应设日期格式或改常见日期写法 yyyy-mm-dd',
    });
  }
  for (const [field, rows] of keyEmpty) {
    addIssue(res, 'warning', 'primary_key_empty', `主键字段 ${field} 在 ${rows.length} 个数据行为空（行 ${rows.map((r) => r + 1).join('、')}）`, {
      field, rows: rows.map((r) => r + 1), count: rows.length,
      hint: 'FR 运行时会按主键策略生成（如 UUID/自增），离线仿真用占位值试跑；如需 Excel 带主键，请在模板/提交里配置',
    });
  }
  if (dictionaryWidgets.size > 0) {
    addNote(res, 'dictionary_widget_unverified', `数据行含字典类控件（${[...dictionaryWidgets].map((w) => String(w).split('.').pop()).join('、')}）：离线无法核对下拉字典/显示值转换，需填报预览确认取值命中字典`);
  }

  // ---- 6) 本地 SQLite 试跑（事务内 INSERT，必然 ROLLBACK） ----
  simulateLocally({
    res, opts, submit, dataRows, templateDataRow,
  });

  // ---- 7) 离线边界与不可执行 JS ----
  collectImportListeners(parsed, submit.sheet ?? null).forEach(({ event, container }) => {
    addNote(res, 'listener_not_executed', `模板存在 ${event} 监听器（${container}）：离线仿真不执行 FR JS，导入后的联动/校验/清理必须用「填报预览」实际导入验证，本检查不能算通过该部分`);
  });
  addNote(res, 'offline_boundary', '离线仿真边界：不执行 FR JS、不校验权限/数据字典/真实库连接/触发器/存储过程/移动端；本地 SQLite 是 MySQL DDL 的近似镜像，离线通过 ≠ 生产通过');
  if (xlsxDataRow > 0) {
    addNote(res, 'title_rows_ignored', `Excel 第 1..${xlsxDataRow} 行（0 基 0..${xlsxDataRow - 1}）按标题/表头处理、不导入；数据从 Excel 第 ${xlsxDataRow + 1} 行开始，对应模板第 ${templateDataRow + 1} 行起（位置匹配 1:1）`);
  }

  return finalize(res, startedAt);
}

/** xlsx 错误码 → 可执行提示（供 issue.hint） */
function xlsxErrorHint(code) {
  switch (code) {
    case 'XLS_UNSUPPORTED': return '用 Excel/WPS 打开 .xls，另存为 .xlsx 后重试';
    case 'XLSX_FILE_TOO_LARGE': return 'Excel 文件 >50MB：先拆分/只保留导入所需列行再试';
    case 'XLSX_NOT_XLSX': return '确认文件真是 .xlsx（不是 .xls/.csv/CSV 改名）';
    case 'XLSX_ZIP_ENCRYPTED': return '取消工作簿密码/加密后另存';
    case 'XLSX_SHEET_NOT_FOUND': return '用 sheet 参数指定存在的 sheet 名或 0 基索引';
    case 'XLSX_ZIP64_UNSUPPORTED': return '另存为常规 .xlsx（非 zip64）';
    case 'XLSX_CORRUPT':
    case 'XLSX_ZIP_INVALID':
    case 'XLSX_ZIP_CRC_MISMATCH': return '文件损坏：用 Excel/WPS 打开另存为新文件后重试';
    default: return '检查 Excel 文件本身是否可被 Excel/WPS 正常打开';
  }
}

/** 扫描填报导入事件监听器（beforeimportexcel / afterimportexcel） */
function collectImportListeners(parsed, sheetName) {
  const IMPORT_EVENTS = new Set(['beforeimportexcel', 'afterimportexcel']);
  const out = [];
  const wb = parsed?.WorkBook ?? {};
  const push = (node, container, sheet) => {
    for (const l of asArray(node?.Listener)) {
      const event = l?.['@_event'] != null ? String(l['@_event']) : null;
      if (event && IMPORT_EVENTS.has(event.toLowerCase())) out.push({ event: event.toLowerCase(), container, sheet });
    }
  };
  push(wb.ReportWebAttr?.WebWriteContent, 'WebWriteContent', null);
  for (const { report, sheet } of asReports(parsed)) {
    if (report?.WebWriteContent && report.WebWriteContent !== wb.ReportWebAttr?.WebWriteContent) {
      push(report.WebWriteContent, 'WebWriteContent(sheet)', sheet);
    }
  }
  // 去重（同 event 多容器只报一次）
  const seen = new Set();
  return out.filter((x) => {
    const k = `${x.event}|${x.container}|${x.sheet ?? ''}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return !sheetName || x.sheet == null || x.sheet === sheetName;
  });
}

// ---------------- 本地 SQLite 试跑 ----------------
/**
 * 本地库可用时：事务内逐行 INSERT → 收集 NOT NULL/UNIQUE/类型错误 → **必然 ROLLBACK**。
 * 本地库/表缺失 → skipped + nextAction，不算失败（离线仿真不要求先建库）。
 * 副产物写回 res.simulation / res.issues / res.notes（不返回值）。
 */
function simulateLocally({ res, opts, submit, dataRows, templateDataRow }) {
  const sim = res.simulation;
  if (opts.simulate !== true) {
    sim.status = 'disabled';
    addNote(res, 'simulation_disabled', 'simulate=false：跳过本地 SQLite 试跑（只做列位/表头/控件离线校验）');
    return;
  }
  const connection = opts.connection ?? submit.dsName ?? null;
  let resolved;
  try {
    resolved = resolveLocalDbName({ db: opts.db ?? null, connection });
  } catch (e) {
    sim.status = 'skipped';
    sim.reason = 'local_db_resolve_failed';
    addIssue(res, 'warning', 'local_db_resolve_failed', `解析本地库失败（不阻断交付）：${e.message}`, { hint: '用 local_db_admin({action:"create"}) 建库后重试' });
    return;
  }
  sim.db = resolved.name ?? null;
  sim.table = { schema: submit.schema ?? '', name: submit.table, resolved: null };
  if (!resolved.exists) {
    sim.status = 'skipped';
    sim.reason = 'local_db_missing';
    sim.nextAction = {
      tool: 'local_db_import',
      args: { action: 'auto', db: resolved.name, path: res.path, connection },
      message: `本地库「${resolved.name}」还没建：先 local_db_import({action:"auto", db:"${resolved.name}", path:"${res.path}", connection:"${connection ?? ''}"}) 镜像目标表，再重跑本检查即可真试跑`,
    };
    addNote(res, 'local_db_missing', `本地库未初始化（${resolved.name}），跳过 SQLite 试跑；按 nextAction 建库后可验证 NOT NULL/UNIQUE/类型约束`);
    return;
  }
  let tables;
  try {
    tables = listLocalTables(resolved.name);
  } catch (e) {
    sim.status = 'skipped';
    sim.reason = 'local_db_unreadable';
    addNote(res, 'local_db_unreadable', `本地库可解析但读不到表清单：${e.message}`);
    return;
  }
  const wanted = String(submit.table ?? '');
  const full = submit.schema ? `${submit.schema}.${wanted}` : wanted;
  const findTable = (name) => {
    const low = String(name).toLowerCase();
    return tables.find((t) => String(t).toLowerCase() === low) ?? null;
  };
  const resolvedTable = findTable(wanted) ?? findTable(full) ?? null;
  if (!resolvedTable) {
    sim.status = 'skipped';
    sim.reason = 'local_table_missing';
    sim.nextAction = {
      tool: 'local_db_import',
      args: { action: 'auto', db: resolved.name, path: res.path, connection },
      message: `本地库「${resolved.name}」里没有目标表 ${full}：local_db_import({action:"auto", db:"${resolved.name}", path:"${res.path}", connection:"${connection ?? ''}"}) 会按模板数据集/提交自动镜像，再重跑`,
    };
    addNote(res, 'local_table_missing', `本地库缺目标表 ${full}，跳过 SQLite 试跑（不算失败）；建表后可验证目标约束`);
    return;
  }
  sim.table.resolved = resolvedTable;
  if (dataRows.length === 0) {
    sim.status = 'skipped';
    sim.reason = 'no_data_rows';
    addNote(res, 'simulation_no_rows', '没有非空数据行，跳过 SQLite 试跑');
    return;
  }

  let info;
  try {
    info = localTableInfo(resolved.name, resolvedTable);
  } catch (e) {
    sim.status = 'skipped';
    sim.reason = 'local_table_info_failed';
    addNote(res, 'local_table_info_failed', `读取本地表结构失败：${e.message}`);
    return;
  }
  const localCols = info.columns ?? [];
  const colByName = new Map(localCols.map((c) => [String(c.name).toLowerCase(), c]));

  // 字段存在性预检：绑定字段在目标表里不存在 → 真实 INSERT 必炸（这里直接判 failed，不开事务）
  const precheckErrors = [];
  const insertFields = [];
  for (const m of res.mapping) {
    if (!m.field) continue;
    const col = colByName.get(String(m.field).toLowerCase());
    if (!col) {
      precheckErrors.push({ row: null, field: m.field, code: 'missing_column', message: `目标表 ${resolvedTable} 没有字段 ${m.field}` });
      continue;
    }
    insertFields.push({ ...m, localColumn: col.name, localType: String(col.type ?? '') });
  }
  if (precheckErrors.length > 0) {
    sim.attempted = true;
    sim.status = 'failed';
    sim.errors = precheckErrors;
    addIssue(res, 'error', 'field_not_in_local_table', `本地目标表 ${resolvedTable} 缺少绑定字段：${precheckErrors.map((e) => e.field).join('、')}`, {
      hint: `本地镜像是旧结构：local_db_import({action:"auto", path:"${res.path}", connection:"${connection ?? ''}"}) 同步后重试；或核对 fillConfig 字段名拼写`,
    });
    return;
  }
  // 未绑定的 NOT NULL 列（无默认值、非自增主键）→ 真实 INSERT 会失败，先出 warning
  const boundCols = new Set(insertFields.map((f) => String(f.localColumn).toLowerCase()));
  const unboundNotNull = localCols.filter((c) => c.notnull === true && Number(c.pk) === 0 && c.dflt_value == null && !boundCols.has(String(c.name).toLowerCase()));
  if (unboundNotNull.length > 0) {
    addIssue(res, 'warning', 'not_null_column_unbound', `目标表 ${resolvedTable} 的 NOT NULL 列未被任何绑定覆盖：${unboundNotNull.map((c) => c.name).join('、')}`, {
      hint: '真实提交会报 NOT NULL；在提交里补绑定/常量，或让这些列在库里允许 NULL/有默认值',
    });
  }

  const keys = insertFields.filter((f) => f.isKey);
  const sql = `INSERT INTO ${quoteIdent(resolvedTable)} (${insertFields.map((f) => quoteIdent(f.localColumn)).join(', ')}) VALUES (${insertFields.map(() => '?').join(', ')})`;
  let conn = null;
  let began = false;
  let inserted = 0;
  const errors = [];
  const placeholders = []; // {row, field, value}
  const simStartedAt = Date.now();
  try {
    conn = openLocalDb(resolved.name, { write: true, mustExist: true });
    conn.exec('BEGIN IMMEDIATE');
    began = true;
    const stmt = conn.prepare(sql);
    for (const row of dataRows) {
      if (errors.length >= opts.maxSimulationErrors) {
        sim.errorsTruncated = true;
        break;
      }
      const params = [];
      for (const f of insertFields) {
        if (f.kind === 'constant') {
          params.push(f.constant == null ? null : String(f.constant));
          continue;
        }
        const v = row.values.find((x) => x.field === f.field && x.xlsxColumn === f.xlsxColumn);
        let value = v ? v.value : null;
        if (keys.includes(f) && (value == null || value === '')) {
          // 主键空值：用唯一占位（数字列用负数、文本列用带前缀字符串），只为让试跑能走通
          const numeric = /INT|REAL|NUM|DEC|DOUBLE|FLOAT/i.test(f.localType);
          value = numeric ? -(row.index + 1) : `__cpt_excel_import_${row.index + 1}__`;
          if (placeholders.length < 20) placeholders.push({ row: row.xlsxRow + 1, field: f.field, value });
        }
        params.push(value);
      }
      try {
        stmt.run(...params);
        inserted += 1;
      } catch (e) {
        const cls = classifySimError(e);
        errors.push({
          row: row.xlsxRow + 1, // 返回 Excel 1 基行号，便于对照
          field: cls.field,
          code: cls.code,
          message: String(e?.message ?? e).slice(0, 300),
        });
      }
    }
  } catch (e) {
    const cls = classifySimError(e);
    errors.push({ row: null, field: cls.field, code: cls.code, message: String(e?.message ?? e).slice(0, 300) });
  } finally {
    if (conn) {
      if (began) {
        try { conn.exec('ROLLBACK'); } catch { /* 已被 SQLite 自动回滚等 */ }
        sim.rolledBack = true;
      }
      closeLocalDb(conn);
    }
  }
  sim.attempted = true;
  sim.rows = dataRows.length;
  sim.inserted = inserted;
  sim.errors = errors;
  sim.elapsedMs = Date.now() - simStartedAt;
  sim.status = errors.length > 0 ? 'failed' : (inserted > 0 ? 'pass' : 'skipped');
  if (placeholders.length > 0) {
    addIssue(res, 'warning', 'primary_key_placeholder', `主键字段为空，本地试跑用占位值插入（${placeholders.slice(0, 20).map((p) => `${p.field}@第${p.row}行=${JSON.stringify(p.value)}`).join('、')}）`, {
      hint: 'FR 运行时会按主键策略生成（UUID/自增等）；这里只是让本地 INSERT 能验证其它约束',
    });
  }
  if (errors.length > 0) {
    addIssue(res, 'error', 'simulation_insert_failed', `本地 SQLite 试跑失败：${dataRows.length} 行中成功插入 ${inserted} 行，捕获 ${errors.length} 个错误后已 ROLLBACK`, {
      hint: `按 constraints 修正数据/模板：${errors.slice(0, 5).map((e) => `[${e.code}${e.field ? ':' + e.field : ''}] ${e.message}`).join('；')}${errors.length > 5 ? '……' : ''}；若本地镜像结构过时，先 local_db_import({action:"auto"}) 同步`,
      count: errors.length,
    });
  } else {
    addNote(res, 'simulation_rolled_back', `本地试跑通过 ${inserted} 行后已 ROLLBACK（不写任何数据）；只验证 INSERT 约束，不验证 FR 提交逻辑/权限/触发器`);
  }
}

export default checkExcelImport;
