// cpt-mcp/lib/quality.js —— 工序进度 + 统一质量门槛
//
// 【问题背景】弱模型用原语拼模板时"想到哪做到哪"：样式全用骨架样式 0、
// 忘了设行高列宽、写完不跑校验就宣称完成。instructions 里的推荐顺序是提示词层的，拦不住。
//
// 【方案】把"有序编写"编码为从模板现状推导的事实：
//   - buildProgress(path)：按工序阶段产出 done/detail/nextAction —— 模型每一步都能看到"缺什么、下一步做什么"
//   - qualityGate(path)：validate + 样式审查 + 合理性审查 + 引擎结论聚合成
//     { pass, blockers(带可执行修复指引), checklist } —— 交付门槛：pass 之前不得宣告完成
//
// 【重要教训（官方样本实证，勿回退）】曾在此实现"同行多列 dsColumn 缺左父格 = blocker"，
// 被 300 份官方样本证伪：789 个多列数据集行中 674 个（85%）全部默认展开且工作正常。
// FR 语义：无属性 <Expand/> 与 dir=0 走「默认左父格=左邻扩展格」，显式 left 只是自定义形态。
// 因此这里不存在可靠的错误信号，不得再加此类 blocker。
//
// blockers 的每一条都带 fix（建议的工具调用），让模型可以"看报错→修复→复跑"闭环。
// gatherIssues 是唯一执行三层检查的入口；buildProgress 与 qualityGate 通过
// 传递 blockers 复用结果，禁止互相调用（否则无限递归）。

import fs from 'node:fs';
import { load, styleBlocks } from './xml.js';
import { cells, datasets, fillConfig, fillSubmitMatrix, pageSettings, parameterPanel } from './cpt.js';
import { validateCpt } from './validate.js';
import { diagnoseFillRowIntegrityFromParsed } from './fill-integrity.js';
import { reviewStyles, reviewReasonableness } from './engine/index.js';
import { engineCheckReport } from './fr-engine-report.js';
import { checkJsBaseline, resetJsBaseline } from './js-baseline.js';
import { auditTemplateLocalSql, localSqlAuditBlockers, localSqlAuditWarnings } from './localdb-audit.js';
import { scanExcelImportButtons } from './excel-import.js';

const DEF_ROW_H = 723900;
const DEF_COL_W = 2743200;

/** 已知问题形态 → 可执行的修复建议（message 正则匹配） */
function suggestFor(message) {
  const rules = [
    [/样式索引.*越界/, '先 get_styles 查看现有样式，再 add_style 创建所需样式，然后用 update_cell_style 或重建单元格指向新 styleIndex'],
    [/数据集 .* 不存在|不存在（已声明/, '修正 dsName 拼写（报错里列出了已声明数据集），或先 add_dataset / add_file_dataset 创建'],
    [/树数据集源/, '修正 source 拼写（报错里列出了已声明数据集），或先 add_dataset 创建源数据集'],
    [/图表引用的数据集/, '修正图表 dsName，或先创建该数据集'],
    [/绑定的单元格.*不存在/, '用 update_fill_binding 把坐标改到已存在的单元格，或先 add_cell 创建该单元格'],
    [/坐标重复/, '用 delete_cell 删除多余单元格，或合并为一个'],
    [/缺少目标表/, '重建填报提交：add_fill_submit（含 table），再 add_fill_binding 补绑定'],
    [/绑定缺少单元格坐标/, '用 update_fill_binding 补坐标，或绑定改为常量值'],
    [/Location/, '浮动元素 Location 数值非法，delete 后用 add_float_element 重建（leftMm/topMm ≥ 0、宽高 > 0）'],
    [/超出.*合法范围|字号 .* 超出/, 'update_cell_style 改字号到 6-200pt（建议 8-48pt）'],
    [/字号 \d+pt 偏小/, '小字号（<8pt）可加载但可读性差：正文建议用 update_cell_style 改到 8pt 以上；真实旧模板的 <6pt 保留不阻断交付'],
    [/边距 .* 为负/, 'set_report_settings 用毫米重设边距（≥0）'],
    [/纸张尺寸非法/, 'set_report_settings 重设纸张（paper 预设或 paperWidthMm/paperHeightMm > 0）'],
    // 填报行完整性（insertPolicy）：缺 copy 的格插入新行时取值不复制 —— 写入口已收回 MCP 通道
    [/缺少 InsertPolicy=copy/, 'update_cell({ column, row, insertPolicy: "copy" }) 单格补；整行批量用 batch_mutate_cells 的 data.patch.insertPolicy: "copy"（plan → apply）'],
    [/填报行完整性：下拉控件 .* 缺少数据字典/, 'add_cell({ widget: "comboBox", widgetItems: [...] }) 重建控件字典，或按官方 <Dictionary> 形态补节点'],
    [/填报行完整性：数据行列格既无录入控件也无 DSColumn 绑定/, '按用途二选一：add_cell({ widget: "text" }) 补录入控件，或 set_cell_content_type({ contentType: "dsColumn", dsName, columnName }) 补数据绑定'],
    [/扩展父格引用悬空/, '把 left/up 父格改为已存在的单元格（A1 行号从 1 起），或 delete_cell 后 add_cell 重建该格扩展'],
    [/填报行完整性：数据行内的静态文本格/, '固定文案可忽略；需随行复制的文案用 update_cell({ insertPolicy: "copy" }) 补复制策略'],
    // P2-1 收敛：网格超界 warning 的 gate fix 与 reason 自带 suggestion 同口径
    // （get_grid 取数组→尾部按缺省补齐→set_grid 回写；裸 rowCount 会重置自定义行高）
    [/超出 RowHeight 数量/, 'get_grid 取该表行高数组，尾部按默认行高 723900 补齐到覆盖最大行号，再 set_grid({ rowHeights: [...] })（勿用裸 rowCount，会重置已有自定义行高）'],
    [/超出 ColumnWidth 数量/, 'get_grid 取该表列宽数组，尾部按默认列宽 2743200 补齐到覆盖最大列号，再 set_grid({ columnWidths: [...] })（勿用裸 columnCount，会重置已有自定义列宽）'],
    // t8 口径：JS 语法经 validate 以 warning 上报（V8 比设计器严格，error 会误杀官方基线），
    // 此处 fix 使 quality_gate advisory 可闭环；warning 不进 blocker
    [/JS 语法错误/, '先调 check_report_js 拿块内行号定位，再用对应写入工具修正后重跑 quality_gate_cpt：报表JS用 set_report_js / 报表事件用 set_report_listener / 填报事件用 set_webwrite_js / 单元格监听用 update_cell_listener / 工具栏按钮用 set_toolbar_button_js / 超链script用 update_cell_hyperlink'],
  ];
  for (const [re, fix] of rules) {
    if (re.test(message)) return fix;
  }
  return '先 read_cpt 查看现状，按 issue 的 location 定位后用对应工具修复';
}

/** 三层检查的唯一执行入口（buildProgress 与 qualityGate 都从这里拿 blockers）
 * 注：JS 语法经 validateCpt 内复用 check_report_js 以 warning 上报后在此进入 advisory
 * （t8：V8 比设计器严格，error 会误杀官方基线），不另起扫描（单源口径，避免双报漂移）。 */
function gatherIssues(path) {
  const v = validateCpt(path);
  const st = reviewStyles(path);
  const rs = reviewReasonableness(path);
  const rawIssues = [
    ...v.map((i) => ({ ...i, source: 'validate' })),
    ...st.issues.map((i) => ({ ...i, source: 'style_review' })),
    ...rs.issues.map((i) => ({ ...i, source: 'reasonableness' })),
  ];
  const blockers = rawIssues
    .filter((i) => i.severity === 'error')
    .map((i) => ({ ...i, fix: i.fix ?? suggestFor(i.message) }));
  const advisories = rawIssues
    .filter((i) => i.severity !== 'error')
    .map((i) => ({ ...i, fix: suggestFor(i.message) }));
  return { rawIssues, blockers, advisories };
}

/**
 * 从模板现状推导工序进度（有序）。
 * @param {{blockers?:Array}} [precomputed] 传入已算好的 blockers 可跳过重复检查（qualityGate 调用时用）
 */
export function buildProgress(path, precomputed) {
  const { raw, parsed } = load(path);
  const cellArr = cells(path);
  const dsArr = datasets(path);
  const st = styleBlocks(raw);
  const fc = fillConfig(path);
  const ps = pageSettings(path) || {};
  const pp = parameterPanel(path);
  const blockers = precomputed?.blockers ?? gatherIssues(path).blockers;

  const styleCount = st.blocks.length;
  const style0Share = cellArr.filter((c) => c.style === 0).length;
  const dsColumnCount = cellArr.filter((c) => c.contentKind === 'object:DSColumn').length;

  // 网格：存在任一非默认行高/列宽值即视为已设置
  const reports = Array.isArray(parsed.WorkBook?.Report)
    ? parsed.WorkBook.Report
    : parsed.WorkBook?.Report ? [parsed.WorkBook.Report] : [];
  let gridSet = false;
  for (const report of reports) {
    for (const tag of ['RowHeight', 'ColumnWidth']) {
      const rawCsv = (report?.[tag]?.__cdata ?? report?.[tag]?.['#text'] ?? '').toString();
      if (rawCsv.split(',').some((x) => {
        const n = Number(x.trim());
        return Number.isFinite(n) && n > 0 && n !== (tag === 'RowHeight' ? DEF_ROW_H : DEF_COL_W);
      })) gridSet = true;
    }
  }

  const dsParamCount = dsArr.reduce((n, d) => n + (d.parameters || []).length, 0);
  const bindingCount = fc.submits.reduce((n, s) => n + s.columns.length, 0);
  // 填报行完整性：数据行缺 insertPolicy=copy 的格数（写入口 = update_cell / batch_mutate_cells）
  let fillIntegrityMissing = 0;
  if (fc.submits.length) {
    try {
      fillIntegrityMissing = diagnoseFillRowIntegrityFromParsed(parsed, path).totals.missingInsertPolicyCopy;
    } catch { fillIntegrityMissing = 0; }
  }

  const phases = [
    {
      phase: '数据集', done: dsArr.length > 0,
      detail: dsArr.length ? dsArr.map((d) => d.name).join('、') : '尚无数据集 —— add_dataset / add_file_dataset / add_tree_dataset',
    },
    {
      phase: '样式', done: styleCount > 1 || (cellArr.length > 0 && style0Share < cellArr.length),
      detail: styleCount > 1
        ? `${styleCount} 个样式（骨架样式0 + ${styleCount - 1} 个自定义）`
        : `仅骨架样式0${cellArr.length ? `，${cellArr.length} 个单元格全部共享它 —— add_style 定义表头/数据/标题样式` : ''}`,
    },
    {
      phase: '单元格与扩展', done: cellArr.length > 0,
      detail: cellArr.length
        ? `${cellArr.length} 个单元格（其中 ${dsColumnCount} 个数据集列；多列同行默认跟随左邻扩展格，无需显式父格）`
        : '尚无单元格',
    },
    {
      phase: '网格（行高列宽）', done: gridSet,
      detail: gridSet ? '已设置非默认行高/列宽' : '全部为默认值 —— set_grid 设置表头/数据行高（表头 9mm、数据 7mm 是常见口径）',
    },
    {
      phase: '页面设置', done: !!ps.paperSizeUnit,
      detail: ps.paperSizeUnit ? `纸张已设置（${Math.round(ps.paperSizeUnit.width / 144000)}×${Math.round(ps.paperSizeUnit.height / 144000)}mm）` : '未显式设置纸张 —— set_report_settings（A4 纵向是常见口径）',
    },
    {
      phase: '参数面板', done: !!(pp && (pp.widgets.length || pp.parameters.length)),
      detail: pp && pp.widgets.length
        ? `${pp.widgets.length} 个控件`
        : dsParamCount > 0
          ? `数据集有 ${dsParamCount} 个参数但面板无控件 —— add_parameter_widget（控件名与参数同名自动绑定）`
          : '无参数（若报表不需要筛选可忽略）',
    },
    {
      phase: '填报', done: fc.submits.length > 0,
      detail: fc.submits.length
        ? `${fc.submits.length} 个提交 / ${bindingCount} 条绑定${fillIntegrityMissing ? `；填报行完整性：${fillIntegrityMissing} 个数据行格缺 insertPolicy=copy（update_cell 或 batch_mutate_cells 的 patch.insertPolicy 补）` : '；数据行 insertPolicy=copy 已齐'}`
        : '无提交配置（展示型报表可忽略）',
    },
    {
      phase: '质量门槛', done: blockers.length === 0,
      detail: blockers.length ? `${blockers.length} 个 blocker —— 调 quality_gate_cpt 查看修复指引` : '结构/样式/合理性检查无 error',
    },
    {
      phase: '真实引擎校验', done: false,
      detail: '调 quality_gate_cpt 查看 engineCheck.status；not-run 时可请用户执行 npm run verify:fr',
    },
  ];

  // M120: JS 块基线相位（丢失本身已作为 validate error 进 blockers；这里给可视相位）
  try {
    const bl = checkJsBaseline(path, parsed);
    let baselinePhase;
    if (bl.loss) {
      const det = bl.decreased.map((d) => `${d.cat} ${d.base}→${d.now}`).join('；');
      baselinePhase = { phase: 'JS 块基线', done: false, detail: `JS 块较基线减少（现存 ${bl.current.total} 块）：${det} —— 疑似整块丢失，见 blockers 修复指引` };
    } else if (!bl.known) {
      baselinePhase = { phase: 'JS 块基线', done: true, detail: `已建立基线（${bl.current.total} 块）——后续将据此拦截整块丢失` };
    } else {
      baselinePhase = { phase: 'JS 块基线', done: true, detail: `${bl.current.total} 个 JS 块，与基线一致` };
    }
    phases.splice(phases.findIndex((p) => p.phase === '真实引擎校验'), 0, baselinePhase);
  } catch { /* 基线比对失败不阻塞工序展示 */ }

  const firstUndone = phases.find((p) => !p.done);
  return { phases, nextAction: firstUndone ? `建议下一步：${firstUndone.detail}` : '全部工序完成，可以交付' };
}

/**
 * advisories 明细裁剪（P2-4，2026-11-05）。
 * 默认只回前 cap 条；pinned 条目若会被截掉，则提到明细首位再裁 —— 总数/统计不变，
 * 只保证「交付前必须知道」的关键提示（Excel 导入未预检）不因条数上限而不可见。
 * @template T
 * @param {T[]} all 全量 advisories
 * @param {number} [cap=30] 明细上限
 * @param {T|null} [pinned=null] 保证可见的条目
 * @returns {{items:T[], total:number, truncated:boolean, pinnedVisible:boolean}}
 */
export function capAdvisories(all = [], cap = 30, pinned = null) {
  const list = Array.isArray(all) ? all : [];
  const c = Math.max(0, Number(cap) || 0);
  const pinnedInFirst = !pinned || list.slice(0, c).includes(pinned);
  if (!pinned || list.length <= c || pinnedInFirst) {
    return { items: list.slice(0, c), total: list.length, truncated: list.length > c, pinnedVisible: pinnedInFirst };
  }
  const items = [pinned, ...list.filter((x) => x !== pinned)].slice(0, c);
  return {
    items,
    total: list.length,
    truncated: true,
    pinnedVisible: items.includes(pinned),
  };
}

/**
 * 统一质量门槛。pass=true 之前不得宣告模板完成。
 * @param {string} path .cpt 绝对路径
 * @param {{localSqlAudit?:boolean, localSqlAuditDb?:string, localSqlAuditMaxDatasets?:number}} [opts]
 *   localSqlAudit=true 时额外跑「本地 SQLite 离线 SQL 审计」（服务器 quality_gate_cpt 默认开启；
 *   verify/attachSelfCheck 等内部调用不传，保持零回归）。本地库没配置时审计自动跳过，不产生 blocker。
 * @returns {{pass:boolean, summary:{blockers,warnings,infos}, checklist, blockers, advisories, advisoriesTotal, advisoriesTruncated, engineCheck, localSqlAudit?}}
 */
export function qualityGate(path, opts = {}) {
  // W1: 模板损坏（非法 XML 等）时 gate 必须结构化失败（pass=false + blocker），
  // 而不是抛异常 —— 门槛的职责就是给出可执行的结论，哪怕结论是"这文件读不了"
  try {
    return gateImpl(path, opts);
  } catch (e) {
    return {
      pass: false,
      summary: { blockers: 1, warnings: 0, infos: 0 },
      checklist: [],
      nextAction: '模板无法解析，先修复文件本身',
      blockers: [{
        severity: 'error',
        location: '文件',
        message: `模板无法解析：${e.message}`,
        fix: '若文件被外部工具改坏：用备份恢复或重新构建；若是 build 产物异常：删除后重新 build_report',
      }],
      advisories: [],
      engineCheck: { status: 'unavailable', hint: '模板无法解析，引擎校验无意义' },
      note: 'pass/structuralPass=true 仅结构通过；deliveryPass=true（=pass&&engineCheck pass）才可最终交付。三字段并列返回不要混用。blockers 每条带 fix（建议的工具调用）；修复后重跑本工具直到通过',
    };
  }
}

/**
 * 本地 SQL 审计因「本地库未初始化」而跳过 → 追加 info advisory（2026-11-04）。
 *
 * 用户口径：本地库没建时不能静默跳过 —— 要给可解释的 info + 具体 nextAction 工具调用，
 * 但**不得**改变 pass/structuralPass/deliveryPass 或 blockers 语义（环境问题不阻断交付）。
 * 模板没有 SQL 数据集 / 模板无法解析 / 审计异常等情况不追加这条（不是"本地库未建"）。
 */
function localSqlAuditSkippedAdvisory(path, audit) {
  if (!audit || audit.enabled !== false) return null;
  const reason = String(audit.reason ?? '');
  if (!/未初始化/.test(reason)) return null;
  let connection = 'Doris';
  try {
    const first = datasets(path).find((d) => d.sql && String(d.sql).trim());
    if (first?.connection) connection = String(first.connection);
  } catch { /* 模板解析失败时保持示例连接名 */ }
  const nextAction = [
    '本地 SQLite 测试库未建，本地 SQL 审计本轮已跳过（不影响 pass/blockers/deliveryPass）。初始化后自动启用：',
    '  ⓪ report/focused 档先解锁租约：request_deep_tool_access({ path: "<模板.cpt>", group: "local_db" })',
    '  ① local_db_admin({ action: "create", db: "main" })',
    `  ② local_db_import({ action: "auto", db: "main", connection: ${JSON.stringify(connection)}, path: ${JSON.stringify(path)} })`,
    '     （镜像结构 + 按需抽样；没有真实库连接时改用 local_db_import({ action: "ddl", ... }) + local_db_import({ action: "seed", ... }) 纯离线造 fixture）',
    `  ③ 重跑 quality_gate_cpt({ path: ${JSON.stringify(path)} })`,
  ].join('\n');
  return {
    severity: 'info',
    source: 'local_sql',
    code: 'local_sql_audit_skipped',
    location: '本地 SQL 审计',
    message: `本地 SQL 审计已跳过（本地 SQLite 测试库未初始化，环境问题不阻断交付）：${reason}`,
    fix: nextAction,
    nextAction,
  };
}

function gateImpl(path, opts = {}) {
  // C-C（2026-11-03）：可选复位本模板 JS 块基线 —— 必须在 gatherIssues/validate 之前做，
  // 否则本轮校验仍会按旧基线报"块数减少"blocker。只在显式 resetJsBaseline:true 时执行，
  // 默认路径语义完全不变（丢失告警照旧拦截）。
  let baselineResetInfo = null;
  if (opts.resetJsBaseline === true) {
    try {
      baselineResetInfo = resetJsBaseline(path);
    } catch (e) {
      baselineResetInfo = { reset: false, error: e?.message ?? String(e) };
    }
  }
  const { rawIssues, blockers, advisories } = gatherIssues(path);

  // 本地 SQLite 离线审计（2026-11-02；quality_gate_cpt 默认开启，内部调用默认关闭）
  // 只把「模板自身错误」并入 blockers；本地库缺表/方言缺口只进 advisories，避免环境问题误伤交付判定。
  let localSqlAudit = null;
  const auditBlockers = [];
  const auditWarnings = [];
  const auditInfos = [];
  if (opts.localSqlAudit === true) {
    try {
      localSqlAudit = auditTemplateLocalSql(path, {
        db: opts.localSqlAuditDb,
        maxDatasets: opts.localSqlAuditMaxDatasets,
      });
      auditBlockers.push(...localSqlAuditBlockers(localSqlAudit));
      auditWarnings.push(...localSqlAuditWarnings(localSqlAudit));
      // 2026-11-04：本地库未建不再静默跳过 —— info advisory + nextAction（不改 pass/blockers）
      const skipped = localSqlAuditSkippedAdvisory(path, localSqlAudit);
      if (skipped) auditInfos.push(skipped);
    } catch (e) {
      localSqlAudit = { enabled: false, reason: `本地 SQL 审计异常：${e.message}`, datasets: [], blockers: [], warnings: [], dialectIssues: [] };
    }
  }
  // 2026-11-05 P0-1（审计补齐）：模板含 Excel 导入按钮但本轮没做离线预检 → info advisory。
  // 只在响应体里提示（不新增工具/参数、不改 pass/blockers/deliveryPass），但让模型在交付判定点
  // 就能看到「导入链路尚未验证」以及普通导入 vs 标记/自定义导入的处理差异。
  // P2-3（独立验收）：先用 raw 文本粗筛，只有疑似含导入按钮才做完整 XML 解析
  //（否则 5MB 官方模板会因每次 gate 多一次 load 而 +2s）。
  let excelImportAdvisory = null;
  // P2-4（独立验收）：advisories 明细有 30 条上限，excel advisory 追加在末尾时可能被截掉
  //（advisoriesTotal 仍 +1 但模型看不到）。响应体顶层再给一份精简摘要，与 advisories 是否被截无关。
  let excelImportSummary = null;
  try {
    const raw = fs.readFileSync(path, 'utf8');
    if (/ImExcel|ImportExcelData|CustomizeImportExcelData|ExcelImport/i.test(raw)) {
      const { parsed } = load(path);
      const scan = scanExcelImportButtons(parsed);
      const normal = Array.isArray(scan?.effective) ? scan.effective : [];
      const legacy = Array.isArray(scan?.legacyEffective) ? scan.legacyEffective : [];
      if (normal.length || legacy.length) {
        const parts = [];
        if (normal.length) parts.push(`${normal.length} 个普通导入按钮（${[...new Set(normal.map((b) => b.mode))].join('/')}）`);
        if (legacy.length) parts.push(`${legacy.length} 个标记/自定义导入按钮（${[...new Set(legacy.map((b) => b.class))].join('、')}，离线仿真不覆盖）`);
        const nextAction = [
          '模板含 Excel 导入按钮，本轮未做离线导入预检（不影响 pass/blockers/deliveryPass）：',
          '  ⓪ report/focused 档先解锁租约：request_deep_tool_access({ path: "<模板.cpt>", group: "local_db" })',
          '  ① 准备与模板位置对齐的样例 .xlsx（列位/表头与模板一致）；',
          '  ② local_db_import({ action: "excel", db: "main", path: "<模板.cpt>", excelFile: "<样例.xlsx>" })'
            + '（按钮/列位/表头/控件类型/本地目标表约束，事务试插后回滚）',
          ...(legacy.length
            ? ['  ③ 标记/自定义导入（ImportExcelData / CustomizeImportExcelData / ExcelImport 等）离线仿真不覆盖：必须 FR 填报预览验证']
            : []),
        ].join('\n');
        const message = `模板含 ${parts.join('；')}，但未做离线导入预检——这不代表导入链路已验过`;
        excelImportAdvisory = {
          severity: 'info',
          source: 'excel_import',
          code: 'excel_import_not_pretested',
          location: 'Excel 导入',
          message,
          fix: nextAction,
          nextAction,
        };
        auditInfos.push(excelImportAdvisory);
        excelImportSummary = {
          found: true,
          pretested: false,
          code: 'excel_import_not_pretested',
          normal: normal.length,
          legacy: legacy.length,
          total: normal.length + legacy.length,
          normalModes: [...new Set(normal.map((b) => b.mode))],
          legacyClasses: [...new Set(legacy.map((b) => b.class))],
          message,
          nextAction,
        };
      }
    }
  } catch (e) {
    // 提示层失败不影响门禁结论；把原因留在响应体，方便排查（不升级为 blocker/warning）
    auditInfos.push({
      severity: 'info', source: 'excel_import', code: 'excel_import_scan_failed',
      location: 'Excel 导入', message: `Excel 导入按钮扫描跳过：${e.message}`,
      fix: '用 get_fill_config 核对导入按钮；或手动 local_db_import({action:"excel"}) 预检',
    });
  }

  // 2026-11-09：填报运行期无法由 quality_gate 证明（工具栏/Web 事件/真实提交都要 FR 页面实点）。
  // 这里只把「未验证」变成响应体可见字段 + info advisory，绝不改 pass/blockers/deliveryPass。
  let fillRuntime = null;
  try {
    const fc = fillConfig(path);
    const submits = Array.isArray(fc?.submits) ? fc.submits : [];
    const matrix = submits.length ? fillSubmitMatrix(path) : null;
    if (matrix && matrix.summary.sharedTargets > 0) {
      auditWarnings.push({
        severity: 'warning',
        source: 'fill_submit',
        code: 'fill_shared_target',
        location: '填报提交拓扑',
        message: matrix.warnings[0]?.message || '检测到多个工作表提交到同一目标表，提交时可能把其他 sheet 的旧行一并写入。',
        fix: matrix.warnings[0]?.fix || '检查各 sheet 的提交目标/条件/主键，必要时拆分目标表或增加 fill_type/source_sheet 判别字段。',
      });
    }
    if (submits.length) {
      const nextAction = [
        '模板含填报提交，但 quality_gate 不验证 FR 运行期（结构/引擎通过 ≠ 填报能提交）：',
        '  ⓪ report/focused 档先租 local_db 族：request_deep_tool_access({ path: "<模板.cpt>", group: "local_db" })',
        '  ① local_db_import({ action:"report", db:"main", path:"<模板.cpt>", writeAudit:true })',
        '     （复制全部数据集连接 + 填报目标表到内置 SQLite；返回 writeAudit.runId，供提交后核对写入行数）',
        '  ② request_deep_tool_access({ path:"<模板.cpt>", group:"fr_preview" }) → start_fr_preview({ path:"<模板.cpt>" })',
        '  ③ 打开 writeUrl 实点提交/工具栏/afterload JS；未点检不得写「运行期已验证」',
        '  ④ 提交后用 local_db_admin({ action:"write_audit", db, runId })（runId 来自第①步）查看写入行数/次数/时间',
        '  ⑤ 需要对比两个 sheet 的写入时可先试写：local_db_admin({ action:"simulate_fill", db, path, scenario })（事务回滚，不落库）',
      ].join('\n');
      const advisory = {
        severity: 'info',
        source: 'fill_runtime',
        code: 'fill_runtime_not_verified',
        location: '填报运行期',
        message: `模板含 ${submits.length} 个填报提交；quality_gate 只证明结构与引擎，不代表运行期提交已通过`
          + (matrix?.summary?.sharedTargets ? `；检测到 ${matrix.summary.sharedTargets} 个跨 sheet 共享目标，建议先做写审计` : ''),
        fix: nextAction,
        nextAction,
      };
      auditInfos.push(advisory);
      fillRuntime = {
        applicable: true,
        status: 'unverified',
        submits: submits.length,
        sharedTargets: matrix?.summary?.sharedTargets ?? 0,
        highRiskTargets: matrix?.summary?.highRiskTargets ?? 0,
        targetGroups: matrix?.targetGroups ?? [],
        warnings: matrix?.warnings ?? [],
        advisoryCode: advisory.code,
        nextAction,
      };
    }
  } catch (e) {
    auditInfos.push({
      severity: 'info', source: 'fill_runtime', code: 'fill_runtime_scan_failed',
      location: '填报运行期', message: `填报提交扫描跳过：${e.message}`,
      fix: '用 get_fill_config 核对填报提交，再按 start_fr_preview 实点',
    });
  }

  const allBlockers = [...blockers, ...auditBlockers];
  const allAdvisories = [...advisories, ...auditWarnings, ...auditInfos];

  // 2026-11-04：本地 SQL 审计"生效状态"必须是顶层显式信号（响应字段，不进 tools/list）——
  // 否则模型看到 pass:true 就以为"已做本地 SQL 验证"。这里只做可见性，不改 pass/blockers 语义。
  const skippedAdvisory = auditInfos.find((a) => a.code === 'local_sql_audit_skipped') ?? null;
  const dsRows = Array.isArray(localSqlAudit?.datasets) ? localSqlAudit.datasets : [];
  // 2026-11-05 P1-4：只有真正 prepare 过的数据集（pass/blocker）算「已检查」；
  // 缺库/缺表的 warning/skipped 不算覆盖，避免「库存在但 0 表」被误读成 datasets:1 已覆盖。
  const datasetsChecked = dsRows.filter((r) => r && (r.status === 'pass' || r.status === 'blocker')).length;
  const localSqlAuditStatus = opts.localSqlAudit === true
    ? {
        enabled: localSqlAudit?.enabled === true,
        ...(localSqlAudit?.enabled === true
          ? {
              db: localSqlAudit.db ?? null,
              // 2026-11-05 P1-4：datasets=扫描到的数据集数；checked/skipped 才是真实覆盖
              //（库存在但 0 表时 datasets>0 而 checked=0，避免把「没表可查」误读成「已覆盖」）。
              datasets: dsRows.length,
              datasetsChecked,
              datasetsSkipped: dsRows.length - datasetsChecked,
            }
          : { reason: localSqlAudit?.reason ?? '本地 SQL 审计未生效' }),
        ...(skippedAdvisory ? { code: skippedAdvisory.code, nextAction: skippedAdvisory.nextAction } : {}),
      }
    : null;

  // 真实引擎结论（只读报告；not-run/stale 是提示，不算 blocker）
  let engineCheck;
  try {
    const r = engineCheckReport(path);
    engineCheck = { status: r.status, hint: r.hint };
  } catch (e) {
    engineCheck = { status: 'unavailable', hint: `引擎结论不可用：${e.message}` };
  }

  const progress = buildProgress(path, { blockers: allBlockers });
  const enginePhase = progress.phases.find((p) => p.phase === '真实引擎校验');
  enginePhase.done = engineCheck.status === 'pass';
  enginePhase.detail = engineCheck.hint;

  // M107: advisories 是【明细视图】，为控制返回体积默认只回前 30 条；summary 统计的是全量。
  const ADVISORY_CAP = 30;
  // P2-4：excel advisory 若恰好被 30 条上限截掉，就把这一条提到明细首位（不改变总数/统计，
  // 只是保证「导入未预检」这个交付前必须知道的信息不会因条数上限而不可见）。
  const advisoryView = capAdvisories(allAdvisories, ADVISORY_CAP, excelImportAdvisory);
  const auditNoteSuffix = skippedAdvisory
    ? '；【本轮本地 SQL 审计未生效】本地 SQLite 测试库未初始化 —— 这不代表模板已通过本地 SQL 验证；建库步骤见 advisories 中 code=local_sql_audit_skipped 的 nextAction'
    : '';
  return {
    pass: allBlockers.length === 0,
    summary: {
      blockers: allBlockers.length,
      warnings: rawIssues.filter((i) => i.severity === 'warning').length + auditWarnings.length,
      infos: rawIssues.filter((i) => i.severity === 'info').length + auditInfos.length,
    },
    checklist: progress.phases,
    nextAction: progress.nextAction,
    blockers: allBlockers,
    advisories: advisoryView.items,
    advisoriesTotal: advisoryView.total,
    advisoriesTruncated: advisoryView.truncated,
    engineCheck,
    ...(localSqlAudit ? { localSqlAudit } : {}),
    ...(localSqlAuditStatus ? { localSqlAuditStatus } : {}),
    ...(excelImportSummary
      ? { excelImport: { ...excelImportSummary, advisoryVisible: advisoryView.pinnedVisible } }
      : {}),
    ...(fillRuntime ? { fillRuntime } : {}),
    // C-C：仅在显式传 resetJsBaseline:true 时出现；baselineResetInfo.previous 是复位前旧计数摘要。
    ...(baselineResetInfo ? { baselineReset: baselineResetInfo.reset === true, baselineResetInfo } : {}),
    note: 'pass/structuralPass=true 仅结构通过；deliveryPass=true（=pass&&engineCheck pass）才可最终交付。三字段并列返回不要混用。blockers 每条带 fix（建议的工具调用）；修复后重跑本工具直到 pass/structuralPass=true —— 但光重跑本工具不会改变引擎结论：deliveryPass 另需 engineCheck.status==\'pass\'，非 pass 时先调 run_fr_engine_check({path})（或 verify_cpt({path, engine:true})）刷新引擎报告，再重跑本工具。advisories 只回前 30 条明细（advisoriesTotal 是总数、advisoriesTruncated 标记是否被截断），统计口径以 summary 为准。localSqlAudit 为本机 SQLite 离线审计结论：blockers 属模板自身错误；缺表/方言缺口在 advisories（不阻断交付）；本地库未初始化时给 info advisory（code=local_sql_audit_skipped，附建库/抽样 nextAction），不改变 pass/deliveryPass；生效状态另见顶层 localSqlAuditStatus' + auditNoteSuffix,
  };
}
