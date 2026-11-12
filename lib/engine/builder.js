// cpt-mcp/lib/engine/builder.js
// 微型报表引擎 —— 报表构建器（report builder）
// 接收一个语义化的 spec，用 generate.js / edits.js 的"文本锚点定向编辑"原语逐步组装合法 CPT，
// 生成后立即做三层自检：结构校验(validate_cpt) + 样式审查 + 合理性审查。
// 目的：让"报表构建"不是盲拼 XML，而是产出"能通过引擎审查"的模板。
import {
  createCpt, addDataset, addFileDataset, addStyle, addCell, addFillSubmit, addSheet,
  setReportSettings, setGrid, setParameterPanel, addParameterWidget, setPageHeaderFooter, setTemplateTheme, mmToUnit, cellRef,
} from '../generate.js';
import { addParameter as addReportParameter, addCellHighlight, setFillToolbar, readFillToolbarButtons, setReportImports } from '../edits.js';
import { addChart } from './chart.js';
import { validateCpt, issueSummary } from '../validate.js';
import { reportImports } from '../cpt.js';
import { reviewStyles } from './style.js';
import { reviewReasonableness } from './reason.js';
import { HEADER_ROW_H_UNIT, DATA_ROW_H_UNIT } from './rules.js';
import fs from 'node:fs';
import path from 'node:path';

function publishStagedFile(stagedPath, targetPath) {
  // 版本移交报表模式：CPT_MCP_NO_BAK=1 时不建 .bak-build-*（版本由 DSH 报表模式 git 落库承载，
  // .bak 只是崩溃兜底不是版本；报表模式接管的目录建议开启，保持目录干净）。
  const backupEnabled = process.env.CPT_MCP_NO_BAK !== '1';
  const backupPath = fs.existsSync(targetPath) && backupEnabled
    ? `${targetPath}.bak-build-${process.pid}-${Date.now()}`
    : null;
  if (backupPath) fs.renameSync(targetPath, backupPath);
  try {
    fs.renameSync(stagedPath, targetPath);
  } catch (error) {
    if (backupPath && fs.existsSync(backupPath) && !fs.existsSync(targetPath)) {
      try { fs.renameSync(backupPath, targetPath); } catch { /* 保留 backup，避免二次破坏 */ }
    }
    throw error;
  }
  // T2: 备份堆积治理 —— 每次覆盖发布都会新增一份 .bak-build-*，
  // 只保留最近 5 份，更早的删除（文件名含时间戳，字典序即时间序）
  if (backupPath) {
    const dir = path.dirname(targetPath);
    const prefix = `${path.basename(targetPath)}.bak-build-`;
    try {
      const backups = fs.readdirSync(dir)
        .filter((f) => f.startsWith(prefix))
        .sort();
      for (const stale of backups.slice(0, Math.max(0, backups.length - 5))) {
        try { fs.rmSync(path.join(dir, stale), { force: true }); } catch { /* ignore */ }
      }
    } catch { /* 清理失败不影响发布结果 */ }
  }
  return { replaced: !!backupPath, backupPath };
}

/**
 * @typedef {{
 *   path: string,
 *   title?: string,
 *   sheetName?: string,
 *   rows?: number, columns?: number,
 *   settings?: object,               // setReportSettings 的入参（paper/orientation/边距/居中/缩放）
 *   grid?: object,                   // setGrid 的入参（rowHeights/columnWidths/rowCount/columnCount）
 *   datasets?: Array<{name,connection,sql,parameters?}>,
 *   styles?: Array<object>,          // addStyle 的入参（fontName/fontSizePt/bold/...）
 *   cells?: Array<object>,           // addCell 的入参（column/row/content/contentType/style或styleIndex/...）
 *   charts?: Array<object>,          // addChart 的入参（column/row/type/dsName/category/values/title/colspan/rowspan）
 *   fill?: object,                   // addFillSubmit 的入参（dsName/table/bindings/...）
 *   parameters?: Array<{name,defaultValue?}>, // 报表级参数（写入 Parameters 段）
 *   parameterPanel?: object,         // setParameterPanel 的入参（title/showWindow/windowPosition）
 *   parameterWidgets?: Array<object>,// addParameterWidget 的入参（name/type/...）
 *   check?: boolean,                 // 生成后自检，默认 true
 * }}
 */

/**
 * P0-1 自动展开父格推导 —— 让模型不必理解 FineReport 的父格机制。
 *
 * 【问题】同一行放多个数据集列（明细表最常见形态）时，若各列都只写 <Expand dir="0"/>，
 *   每列会独立纵向展开，行与行之间数据完全错乱 —— 生成的报表不可用。
 * 【逆向依据】官方样本：首个数据列 <Expand dir="0"/>（主扩展格），
 *   同行的其余列 <Expand dir="0" leftParentDefault="false" left="A2"/>（跟随主格）。
 * 【规则】按 (sheet, row) 分组，组内 dsColumn 按 column 升序：
 *   - 第 1 个 => {dir:0}（主扩展格）
 *   - 其余    => {dir:0, leftParent: 主格引用}
 *   - 用户已显式给 expand 的单元格不覆盖（显式优先）
 *
 * 【语义校正（官方 1559 样本实证）】无属性 <Expand/> 与 dir=0 走 FR「默认左父格=左邻扩展格」，
 * 官方 789 个多列数据集行中 674 个全默认展开且工作正常 —— 显式 leftParent 并非必需，
 * 但它是官方有实证的形态（115/789 行显式写了 left），语义等价且更明确，故保留此推导。
 * @param {Array<object>} cells
 * @returns {{cells: Array<object>, applied: Array<{cell:string, expand:object}>}}
 */
export function autoExpandCells(cells) {
  const result = cells.map((c) => ({ ...c }));
  /** @type {Map<string, number[]>} */
  const bySheetRow = new Map();
  result.forEach((c, i) => {
    if (c.expand) return;                 // 显式指定优先，不推导
    if (c.contentType !== 'dsColumn') return; // 仅数据集列需要展开
    const key = `${c.sheet ?? 0}|${c.row ?? 0}`;
    if (!bySheetRow.has(key)) bySheetRow.set(key, []);
    bySheetRow.get(key).push(i);
  });

  const applied = [];   // 被补上 leftParent 的跟随格
  const mainCells = []; // 各行的主扩展格
  for (const [, idxs] of bySheetRow) {
    if (idxs.length < 2) continue; // 单行单列无需父格
    const sorted = idxs.slice().sort((a, b) => (result[a].column ?? 0) - (result[b].column ?? 0));
    const main = result[sorted[0]];
    if (!main.expand) main.expand = { dir: 0 };
    const mainRef = cellRef(main.column, main.row);
    if (!mainRef) continue;
    mainCells.push({ cell: mainRef, expand: main.expand, followCount: sorted.length - 1 });
    for (let k = 1; k < sorted.length; k++) {
      const follow = result[sorted[k]];
      if (follow.expand) continue;
      follow.expand = { dir: 0, leftParent: mainRef };
      applied.push({ cell: cellRef(follow.column, follow.row), expand: follow.expand });
    }
  }
  return { cells: result, applied, mainCells };
}

/**
 * 语义化构建报表。
 * @param {{
 *   path: string,
 *   title?: string, sheetName?: string, rows?: number, columns?: number,
 *   settings?: object, grid?: object,
 *   datasets?: Array<object>, styles?: Array<object>, cells?: Array<object>,
 *   fill?: object, parameters?: Array<object>, parameterPanel?: object, parameterWidgets?: Array<object>,
 *   check?: boolean,
 * }} spec
 */
export function buildReport({
  path: filePath, title, sheetName, rows, columns, headerRowCount,
  settings, grid, datasets = [], styles = [], cells = [], charts = [],
  fill, fills, toolbar = null, parameters = [], parameterPanel, parameterWidgets = [],
  // 页眉页脚：{left?,center?,right?} × 2；不传则保留骨架里的空 Header/Footer
  header, footer, hfStyle = null,
  // 模板主题（TemplateThemeAttrMark）：不传则不写该标记
  templateTheme = null,
  check = true, noOverwrite = true,
  // M37 修复: build_report 支持 webWrite, 透传给 createCpt 生成 WebWriteContent
  webWrite = false, withWebAttr = true,
  // Web 页面静态资源引用（ReportWebAttr 内 CSSImport/JSImport；重建默认清空，需显式传）
  imports = null,
  // M38 修复: build_report 支持多 sheet (sheets 数组, 第 1 个名字可选 sheetName, 余下追加)
  sheets = null,
  // P2-1 生成参数留档：传入对象时，发布成功后把生成参数写到 <target>.meta.json
  // （含 generatedAt），用于复现与审计。meta 内容由调用方组装（工具层传 spec 摘要）。
  meta = null,
} = {}) {
  if (!filePath) throw new Error('必须提供目标文件路径 path');
  const targetPath = path.resolve(filePath);

  // 0. 覆盖保护（2026-11-06 P0：默认反转）：默认拒绝覆盖已有模板（noOverwrite=true）。
  //    写入不可撤销、.bak-build-* 只是崩溃兜底不是版本，因此"重跑同一路径"必须由调用方显式
  //    传 noOverwrite:false 表达意图。覆盖时旧模板不会在构建期间被删除：先在同目录临时文件
  //    完成全部步骤和三层检查，最后才原子替换。
  //    2026-11-07：报错文案不再自称 build_report —— generate_report / regenerate_from_meta
  //    也会透传到这里，写死工具名会让模型以为调错了工具。
  if (fs.existsSync(targetPath)) {
    if (noOverwrite) {
      throw new Error(`目标文件已存在: ${targetPath}（noOverwrite=true 拒绝覆盖）。确需覆盖请显式传 noOverwrite=false（原子替换并保留 .bak-build-*），或先手动备份/删除目标`);
    }
  }

  // M106: 重建前先回显原模板的填报工具栏。build_report 是【整表重建】——在临时目录从骨架生成、
  // 最后原子替换目标，不继承原模板任何节点；原工具栏不会被带过来，必须由 spec.toolbar 显式重建。
  // 这里先读出来留作"清空预警"（读失败一律 []，绝不影响构建）。
  const previousToolbar = fs.existsSync(targetPath) ? readFillToolbarButtons(targetPath) : [];
  // Web 页面静态资源引用同理：重建会清空原 CSSImport/JSImport，必须由 spec.imports 显式重建。
  let previousImports = { css: [], js: [] };
  if (fs.existsSync(targetPath)) {
    try { previousImports = reportImports(targetPath); } catch { previousImports = { css: [], js: [] }; }
  }

  // 生成过程全部在目标同目录临时文件中进行，最终通过同盘 rename 一次性发布。
  // 任一步失败都不会先删掉旧模板，避免半成品和旧文件丢失。
  const stageDir = fs.mkdtempSync(path.join(path.dirname(targetPath), `.cpt-build-${process.pid}-`));
  const absPath = path.join(stageDir, path.basename(targetPath));
  try {
    const steps = [];

  // 1. 骨架 (S4 修复 + S4 扩展: 用 hasOwnProperty 区分"未传" vs "传空")
  // - sheets 没传 / sheets 为空数组: 用 sheetName (默认 sheet1)
  // - sheets[0].name 是字符串 (含空串): 用 sheets[0].name (用户的显式意图, 包括空串)
  // - sheets[0].name 是 undefined (用户没设 name 字段): 用 sheetName
  const firstSheet = Array.isArray(sheets) ? sheets[0] : null;
  const firstSheetHasName = firstSheet && Object.hasOwn(firstSheet, 'name');
  const effectiveSheetName = firstSheet
    ? (firstSheetHasName ? String(firstSheet.name) : sheetName)
    : sheetName;
  // 2026-10-20 修复：toolbar 非空而调用方没传 webWrite:true 时，旧实现会先建出无 WebWriteContent
  // 的骨架，随后 setFillToolbar 报“模板无 WebWriteContent”（或诱导调用方用 set_webwrite_extras
  // 补容器→旧实现把容器插到 </Report> 前，FR 填报预览读不到）。工具栏必须挂在模板级
  // WebWriteContent 内，这里直接按 toolbar 推导 webWrite，避免踩坑。
  const effectiveWebWrite = webWrite === true || (Array.isArray(toolbar) && toolbar.length > 0);
  const created = createCpt(absPath, {
    title, rows, columns, sheetName: effectiveSheetName,
    withWebAttr, webWrite: effectiveWebWrite,  // M37: 透传 webWrite / withWebAttr（toolbar 非空时自动 true）
  });
  steps.push(created);

  // 1b. Web 页面静态资源引用（CSSImport/JSImport 在 ReportWebAttr 内；重建默认清空，必须显式传）
  if (imports) steps.push(setReportImports(absPath, imports));

  // 1b. M38 修复: 多 sheet 追加 (sheets 是 [{name?, rows?, columns?}] 数组)
  // - 第 1 个 sheet 名称已在 createCpt 阶段生效 (S4 修复)
  // - 余下 sheet 用 addSheet() 追加 (rows/columns 可选, 默认 6x6)
  // - 同名检测: sheets 内任意两 sheet 名 (大小写敏感) 重复时提前抛错
  //   含 effectiveSheetName (主 sheet) 与 sheets[1+].name 的冲突
  //   错误信息: 反查 usedNames, 找到第一个匹配下标 (0=主 sheet, 1..N=sheets 数组下标 + 1)
  //   派生默认名: sheets[i].name 缺省, 用 sheets 数组下标派生 (sheet2, sheet3, ...)
  //   与 addSheet 自身默认 (sheetN) 一致, 用户预期不冲突
  // - s.name 类型校验: 仅接受 string / number / boolean (转字符串); 其他类型抛错
  if (Array.isArray(sheets) && sheets.length > 1) {
    // usedNames 用 Map<name, sourceLabel> (O(1) 反查 + 精确下标)
    // 顺序: 0=主 sheet (effectiveSheetName), 1..=sheets 数组下标
    const usedNames = new Map();
    usedNames.set(effectiveSheetName, '主 sheet');
    for (let i = 1; i < sheets.length; i++) {
      const s = sheets[i];
      const hasName = Object.hasOwn(s, 'name');
      let name;
      if (hasName) {
        const v = s.name;
        // 接受 string / 有限数字 (非 NaN/Infinity) / boolean / null/undefined (=> 空串)
        // 其他类型 (object/array/function/symbol) 抛错 (防 String() 产生 "[object Object]")
        if (typeof v === 'string') {
          name = v;
        } else if (typeof v === 'number') {
          if (Number.isFinite(v)) {
            name = String(v);
          } else {
            throw new Error(`build_report: sheets[${i}].name 数字不接受 NaN/Infinity (实际 ${v})`);
          }
        } else if (typeof v === 'boolean') {
          name = String(v);
        } else if (v === null || v === undefined) {
          name = '';
        } else {
          throw new Error(`build_report: sheets[${i}].name 类型非法 (期望 string/number/boolean, 实际 ${typeof v})`);
        }
      } else {
        name = `sheet${i + 1}`;
      }
      if (usedNames.has(name)) {
        const prevLabel = usedNames.get(name);
        throw new Error(`build_report: sheets 数组下标 ${i} 名字 "${name}" 与 ${prevLabel} 重复 (sheets 内 sheet 名必须唯一, 大小写敏感)`);
      }
      usedNames.set(name, `sheets[${i - 1}]`);
      const r = addSheet(absPath, {
        sheetName: name,
        rows: s.rows ?? 6,
        columns: s.columns ?? 6,
      });
      steps.push({ action: 'add_sheet', ...r });
    }
  }

  // 2. 数据集
  // 两种来源走不同的原语：库里取数 → DBTableData；给个 Excel → ExcelTableData。
  // 这里按 spec 里带没带 excelFile 分流，两种数据集的 XML 结构完全不同，不能混用。
  datasets.forEach((d) => {
    if (d.excelFile) {
      steps.push(addFileDataset(absPath, {
        name: d.name,
        dataFile: d.excelFile,
        needColumnName: d.needColumnName ?? true,
        fromEnv: d.fromEnv ?? true,
      }));
    } else {
      steps.push(addDataset(absPath, d));
    }
  });

  // 3+4. 样式登记（含去重）与单元格：style 可为 {..} 描述（临时登记）或 styleIndex 数字
  const styleCache = new Map(); // key = 去除 id 后的样式对象 -> styleIndex
  const registerStyle = (style) => {
    const key = JSON.stringify({ ...style, id: undefined });
    if (styleCache.has(key)) return styleCache.get(key);
    const r = addStyle(absPath, style);
    styleCache.set(key, r.styleIndex);
    steps.push(r);
    return r.styleIndex;
  };
  // spec 的 styleIndex 是 styles[] 下标，不是 CPT StyleList 的绝对索引。
  // 骨架已占用 StyleList[0]，因此必须保存“声明下标 → 实际序列化索引”的映射。
  const declaredStyleIndexes = styles.map((s) => registerStyle(s));
  // P0-1: 自动推导展开父格（多列数据集声明主扩展格 + leftParent），修复行间数据错乱
  const {
    cells: resolvedCells,
    applied: autoExpandApplied,
    mainCells: autoExpandMain,
  } = autoExpandCells(cells);
  resolvedCells.forEach((c) => {
    const { style, styleIndex, highlights, ...rest } = c;
    let idx = styleIndex;
    if (style && typeof style === 'object') {
      idx = registerStyle(style);
    } else if (styleIndex !== undefined) {
      if (declaredStyleIndexes.length > 0) {
        if (!Number.isInteger(styleIndex) || styleIndex < 0 || styleIndex >= declaredStyleIndexes.length) {
          throw new Error(`build_report: cell(${rest.column},${rest.row}) styleIndex=${styleIndex} 越界；styles 仅声明 ${declaredStyleIndexes.length} 项（0 起）`);
        }
        idx = declaredStyleIndexes[styleIndex];
      } else if (styleIndex !== 0) {
        throw new Error(`build_report: cell(${rest.column},${rest.row}) 给了 styleIndex=${styleIndex}，但 styles 为空；仅 0 可表示骨架默认样式`);
      }
    }
    steps.push(addCell(absPath, { ...rest, styleIndex: idx ?? 0 }));
    // 4b. 条件属性（条件格式）：必须在 addCell 之后追加 —— 它是在已存在的 <C> 块里插入 HighlightList
    (highlights ?? []).forEach((h) => steps.push(addCellHighlight(absPath, {
      column: rest.column, row: rest.row, sheet: rest.sheet, ...h,
    })));
  });

  // 4c. 图表：在单元格之后写入（addChart 自带坐标/类型/字段校验，写坏文件前就会报错）
  const chartSteps = charts.map((ch) => {
    const { style, ...rest } = ch;
    void style; // 图表块自带完整样式，不接受 styleIndex
    return addChart(absPath, rest);
  });
  chartSteps.forEach((s) => steps.push(s));

  // 5. 填报提交: 同时支持 fill (单, 旧 API) 和 fills (多 sheet 多提交, 新 API)
  // M39 修复: fills 是数组, 每个元素传给 addFillSubmit; fill 仍兼容 (单元素)
  if (Array.isArray(fills) && fills.length > 0) {
    for (const f of fills) steps.push(addFillSubmit(absPath, f));
  } else if (fill) {
    steps.push(addFillSubmit(absPath, fill));
  }

  // 5b. 填报工具栏：一句话直出同等更新（业务代码直改，非事后兜底）。
  // fill/fills 存在时若调用方给了 toolbar 数组则按数组建；smart.js 已在有 fill 时默认填四按钮。
  // 模板须有 WebWriteContent（smart.js 有 fill 时 webWrite=true 已保证；直接调 build_report 配 toolbar 时请同时传 webWrite:true）。
  if (Array.isArray(toolbar) && toolbar.length > 0) {
    steps.push(setFillToolbar(absPath, { buttons: toolbar }));
  }

  // 6. 页面设置
  if (settings) steps.push(setReportSettings(absPath, settings));

  // 6b. 页眉页脚（打印时每页重复显示；不给则保留骨架里的空 Header/Footer）
  if (header || footer) steps.push(setPageHeaderFooter(absPath, { header, footer, ...(hfStyle ?? {}) }));

  // 6c. 模板主题（整体观感；不给则不写 TemplateThemeAttrMark）
  if (templateTheme) steps.push(setTemplateTheme(absPath, templateTheme));

  // 7. 网格（表头/数据默认行高：headerRowCount 声明时自动生成；显式 grid.rowHeights 优先）
  let autoRowHeights = null;
  const headerRowN = Number.isInteger(+headerRowCount) && +headerRowCount >= 1 ? +headerRowCount : 0;
  if (headerRowN >= 1) {
    const maxRow = cells.reduce((m, c) => Math.max(m, (c.row ?? 0) + 1), 0);
    const totalRows = Math.max(rows ?? 0, maxRow, headerRowN);
    autoRowHeights = Array.from({ length: totalRows }, (_, i) =>
      (i < headerRowN ? HEADER_ROW_H_UNIT : DATA_ROW_H_UNIT));
  }
  // grid 支持 rowHeightMm/columnWidthMm（自动换算）— 模型友好口径
  const finalGrid = { ...(grid ?? {}) };
  if (finalGrid.rowHeights == null && finalGrid.rowHeightMm != null) {
    finalGrid.rowHeights = finalGrid.rowHeightMm.map((mm) => mmToUnit(Number(mm)));
    delete finalGrid.rowHeightMm;
  }
  if (finalGrid.columnWidths == null && finalGrid.columnWidthMm != null) {
    finalGrid.columnWidths = finalGrid.columnWidthMm.map((mm) => mmToUnit(Number(mm)));
    delete finalGrid.columnWidthMm;
  }
  if (autoRowHeights && finalGrid.rowHeights == null) finalGrid.rowHeights = autoRowHeights;
  if (grid || autoRowHeights) steps.push(setGrid(absPath, finalGrid));

  // 8. 报表级参数
  parameters.forEach((p) => steps.push(addReportParameter(absPath, p.name, p.defaultValue ?? '')));

  // 9. 参数面板（先设置容器，再加控件）
  if (parameterPanel) steps.push(setParameterPanel(absPath, parameterPanel));
  parameterWidgets.forEach((w) => steps.push(addParameterWidget(absPath, w)));

  // 10. 自检
  let checkResult = null;
  if (check) {
    const v = validateCpt(absPath);
    const st = reviewStyles(absPath);
    const rs = reviewReasonableness(absPath);
    const errors = [
      ...v.filter((i) => i.severity === 'error'),
      ...st.issues.filter((i) => i.severity === 'error'),
      ...rs.issues.filter((i) => i.severity === 'error'),
    ];
    checkResult = {
      hasError: errors.length > 0,
      validate: { issues: v, summary: issueSummary(v) },
      style: { count: st.count, issues: st.issues },
      reasonableness: { count: rs.count, issues: rs.issues },
      errors,
    };
    if (checkResult.hasError) {
      const summary = errors.slice(0, 5).map((issue) => issue.message ?? String(issue)).join('；');
      const error = new Error(`build_report 自检失败，未发布目标文件：${summary}`);
      error.checkResult = checkResult;
      throw error;
    }
  }

  const publication = publishStagedFile(absPath, targetPath);

  // M106: 原模板有填报工具栏、本次又没传 spec.toolbar → 重建后工具栏已被清空。
  // 显式预警（不阻断构建）：把原按钮名回显出来，并给出可直接照抄的两种补救写法。
  const requestedToolbar = Array.isArray(toolbar) ? toolbar : [];
  const toolbarNotice = (previousToolbar.length > 0 && requestedToolbar.length === 0)
    ? {
      level: 'warning',
      cleared: previousToolbar,
      message: `原模板填报工具栏原有 ${previousToolbar.length} 个按钮（${previousToolbar.join(' / ')}）；`
        + '本次 build_report 未传 spec.toolbar，重建后模板级工具栏已清空（整表重建不继承原节点）。'
        + `要保留：把 toolbar: [${previousToolbar.map((b) => `'${b}'`).join(', ')}] 传进 spec（并保持 webWrite:true）；`
        + '或重建后用 set_fill_toolbar({ buttons: [...] }) 补回。',
    }
    : null;

  // Web 页面静态资源引用同理：重建会清空原 CSSImport/JSImport，必须由 spec.imports 显式重建。
  const hadImports = previousImports.css.length > 0 || previousImports.js.length > 0;
  const importsNotice = (hadImports && !imports)
    ? {
      level: 'warning',
      cleared: previousImports,
      message: `原模板 Web 页面静态资源引用共 ${(previousImports.css.length + previousImports.js.length)} 个`
        + `${previousImports.css.length ? `（CSS: ${previousImports.css.join(' / ')}）` : ''}`
        + `${previousImports.js.length ? `（JS: ${previousImports.js.join(' / ')}）` : ''}；`
        + '本次 build_report 未传 spec.imports，重建后引用已清空（整表重建不继承原节点）。'
        + '要保留：把 imports: {css:[...], js:[...]} 原样传进 spec；或重建后用 set_report_imports 补回。',
    }
    : null;

  // P2-1: 生成参数留档（.cpt.meta.json）—— 留档失败不影响构建结果
  let metaPath = null;
  if (meta && typeof meta === 'object') {
    try {
      metaPath = `${targetPath}.meta.json`;
      fs.writeFileSync(metaPath, JSON.stringify({
        generator: 'cpt-mcp',
        generatedAt: new Date().toISOString(),
        ...meta,
      }, null, 2));
    } catch { metaPath = null; }
  }

  return {
    path: targetPath,
    steps,
    checkResult,
    metaPath,
    ...publication,
    // M106: 重建把原有填报工具栏清空时的显式预警（否则 null）。
    // 背景：build_report 是整表重建、不继承原节点，而低层路径不传 spec.toolbar 就没有按钮，
    // 静默清空会让"工具栏凭空消失"只能靠人事后回看才发现。
    toolbarNotice,
    // Web 页面静态资源引用被清空时的显式预警（否则 null；语义同 toolbarNotice）。
    importsNotice,
    // P0-1: 透明上报自动推导的展开父格，便于模型/用户核对（不影响 XML 结果）
    autoExpand: {
      mainCells: autoExpandMain,        // 主扩展格（dir=0，驱动纵向展开）
      applied: autoExpandApplied,       // 跟随格（补了 leftParent，跟随主格）
      count: autoExpandMain.length + autoExpandApplied.length, // 参与扩展的数据列总数
      note: autoExpandApplied.length
        ? '已为同行多列数据集自动声明左父格（mainCells 为主扩展格，applied 为跟随格），避免各列独立展开导致行间数据错乱'
        : '无需父格推导（单行单列、或用户已显式指定 expand）',
    },
  };
  } finally {
    fs.rmSync(stageDir, { recursive: true, force: true });
  }
}
