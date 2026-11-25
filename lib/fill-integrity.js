// cpt-mcp/lib/fill-integrity.js —— 填报行完整性一键盘点（只读诊断）
//
// 【要解决的问题】填报模板的"行完整性"分散在四处，缺任何一处都会导致插入/新增行时数据不齐：
//   1. 插入策略：数据行各格缺 <CellInsertPolicy><InsertPolicy><![CDATA[copy]]></InsertPolicy></CellInsertPolicy>
//      （FR 官方枚举只有 null/default/copy，见 lib/edits.js 的常量池取证注释）→ 插入行取值不复制
//   2. 数据绑定：应当取数的列没有 <O t="DSColumn">（写成了静态文本）→ 行插入后该列无来源
//   3. 录入控件：数据行列格里既无 <Widget> 也无 DSColumn → 页面上既不能录入也取不到数
//   4. 字典：ComboBox/ComboCheckBox 控件的下拉字典（<Dictionary>）缺失 → 页面下拉为空
//   5. 扩展父格：有 left/up 父格引用但引用的单元格不存在 → 扩展关系断链
//
// 本模块只读：不改文件、无副作用，产出可直接驱动修复的坐标清单。
// 修复入口（写回 MCP 通道，不再需要"备份后直写 XML"）：
//   update_cell({ insertPolicy: 'copy' }) / batch_mutate_cells({ data: { patch: { insertPolicy: 'copy' } } })
import { load } from './xml.js';
import { cells } from './cpt.js';
import { asArray, asReports } from './parsed-shape.js';


/** 0 起列号 → A1 列字母（0→A, 25→Z, 26→AA） */
function colLetters(column) {
  let n = Number(column);
  let out = '';
  do { out = String.fromCharCode(65 + (((n % 26) + 26) % 26)) + out; n = Math.floor(n / 26) - 1; } while (n >= 0);
  return out;
}
const a1Of = (cell) => `${colLetters(cell.column)}${Number(cell.row) + 1}`;

/** 该工作表是否启用了填报（ReportWriteAttr 下的 SubmitVisitor / 旧位置 SubmitVisitor） */
function sheetFillState(report) {
  const visitors = asArray(report.ReportWriteAttr?.SubmitVisitor)
    .concat(asArray(report.SubmitVisitor))
    .concat(asArray(report.ReportAttrSet?.SubmitVisitor));
  return { fillEnabled: visitors.length > 0, submitCount: visitors.length };
}

/** 下拉类控件：其数据字典（<Dictionary>）缺失会导致页面下拉为空 */
export const DICT_WIDGET_CLASSES = new Set([
  'com.fr.form.ui.ComboBox',
  'com.fr.form.ui.ComboCheckBox',
]);
/** 非数据录入控件（按钮等）：不算数据格，不要求 insertPolicy */
export const NON_DATA_WIDGETS = new Set([
  'com.fr.report.web.button.write.Submit',
  'com.fr.report.web.button.write.Verify',
  'com.fr.report.web.button.write.AppendColumnRow',
  'com.fr.report.web.button.write.DeleteColumnRow',
  'com.fr.report.web.button.write.ImExcelAppend',
  'com.fr.report.web.button.write.ImExcelClean',
]);
const DSCOLUMN_TYPE = 'DSColumn';

/** 单个单元格的行完整性画像（纯数据推导，可被校验与诊断共用） */
export function cellFillProfile(cell) {
  const widgetClass = cell.widgetClass || null;
  const contentObjectType = cell.contentObjectType || null;
  const isWidgetCell = !!widgetClass;
  const isDataWidget = isWidgetCell && !NON_DATA_WIDGETS.has(widgetClass);
  const isDSColumn = contentObjectType === DSCOLUMN_TYPE;
  const rawPolicy = cell.insertPolicy == null ? null : String(cell.insertPolicy).trim();
  // 【t9 修复·勿回退】三态必须分开判断，不能用 hasInsertPolicyCopy 的反面当「未设」：
  //   policyUnset            = 格内根本没写 <CellInsertPolicy>（读回 null）→ 唯一真正「可补 copy」的状态；
  //   policyExplicitNonCopy  = 显式写了非 copy 的值（如 default，官方 doc/Form/LineForm/插入行策略.cpt）
  //                            → 是设计者的显式决策，**不得**列入待补清单、不得被建议改成 copy；
  //   hasInsertPolicyCopy    = 显式写了 copy。
  const policyUnset = rawPolicy == null || rawPolicy === '';
  const hasInsertPolicyCopy = rawPolicy === 'copy';
  const policyExplicitNonCopy = !policyUnset && !hasInsertPolicyCopy;
  return {
    insertPolicy: cell.insertPolicy ?? null,
    rawPolicy: policyUnset ? null : rawPolicy,
    policyUnset,
    policyExplicitNonCopy,
    hasInsertPolicyCopy,
    widgetClass,
    isWidgetCell,
    isDataWidget,
    isDSColumn,
    // 数据格（需要取数或录入的格）：录入控件格 或 数据集列格
    isDataCell: isDataWidget || isDSColumn,
    contentKind: cell.contentKind,
    needsDict: DICT_WIDGET_CLASSES.has(widgetClass),
    expandDir: cell.expandDir,
    expandLeft: cell.expandLeft,
    expandUp: cell.expandUp,
  };
}

/** 控件是否有数据字典：<Widget> 下的 <Dictionary>（自闭合或整块均可） */
function widgetHasDictionary(parsed, sheetIndex, column, row) {
  const report = asReports(parsed)[sheetIndex]?.report;
  const list = asArray(report?.CellElementList?.C);
  const c = list.find((x) => String(x['@_c']) === String(column) && String(x['@_r']) === String(row));
  const w = c?.Widget;
  if (!w || typeof w !== 'object') return false;
  return w.Dictionary != null;
}

/**
 * 逐 sheet 逐格盘点填报行完整性，产出可直接驱动修复的缺失清单（只读）。
 * @param {object} parsed fast-xml-parser 解析结果（与 lib/xml.js load() 同源）
 * @param {string|null} path CPT 路径（透传给 cells() 做工作表过滤）
 * @param {{sheet?: number|string}} [opts]
 */
export function diagnoseFillRowIntegrityFromParsed(parsed, path = null, opts = {}) {
  const allCells = cells(path, opts.sheet === undefined ? {} : { sheet: opts.sheet });
  const bySheetIndex = new Map();
  for (const c of allCells) {
    if (!bySheetIndex.has(c.sheetIndex)) bySheetIndex.set(c.sheetIndex, []);
    bySheetIndex.get(c.sheetIndex).push(c);
  }

  const sheetsOut = [];
  const totals = {
    cells: 0, dataCells: 0, missingInsertPolicyCopy: 0, recommendedInsertPolicyCopy: 0, staticTextCells: 0,
    missingDSColumn: 0, missingWidget: 0, missingDictionary: 0, danglingExpandParent: 0,
  };

  for (const { report, sheet, index } of asReports(parsed)) {
    const sheetCells = bySheetIndex.get(index);
    if (sheetCells === undefined) continue; // 被 opts.sheet 过滤掉
    const { fillEnabled, submitCount } = sheetFillState(report);
    const coords = new Set(sheetCells.filter((c) => c.column != null && c.row != null).map((c) => `${c.column},${c.row}`));

    // 数据行 = 行内至少存在一个「录入控件格 / 数据集列格」
    const dataRows = new Set();
    for (const c of sheetCells) {
      if (c.column == null || c.row == null) continue;
      const prof = cellFillProfile(c);
      if (prof.isDataCell) dataRows.add(c.row);
    }
    // 被合并格（colspan/rowspan）覆盖的坐标：这些格在 XML 里通常不存在；若存在也应视为合并区占位而非缺陷
    const coveredCoords = new Set();
    for (const c of sheetCells) {
      if (c.column == null || c.row == null) continue;
      const cs = Number(c.colspan || 1);
      const rs = Number(c.rowspan || 1);
      if (cs <= 1 && rs <= 1) continue;
      for (let dc = 0; dc < cs; dc++) {
        for (let dr = 0; dr < rs; dr++) {
          if (dc === 0 && dr === 0) continue;
          coveredCoords.add(`${c.column + dc},${c.row + dr}`);
        }
      }
    }
    // 扩展父格引用（A1 字符串，行号从 1 起）
    const parentExists = (ref) => {
      const m = String(ref).trim().toUpperCase().match(/^([A-Z]{1,3})([1-9]\d{0,6})$/);
      if (!m) return false;
      let col = 0;
      for (const ch of m[1]) col = col * 26 + ch.charCodeAt(0) - 64;
      return coords.has(`${col - 1},${Number(m[2]) - 1}`);
    };

    const cellRows = [];
    const missingInsertPolicyCopy = [];
    const recommendedCopyCells = [];
    const inconsistentInsertPolicy = [];
    const staticTextCells = [];
    const missingDSColumn = [];
    const missingWidget = [];
    const missingDictionary = [];
    const danglingExpandParent = [];

    // 【官方样本实证·勿回退】insertPolicy 不是「所有录入格的必备属性」：1550 份官方样本里
    // 只有 28 份显式写过 <InsertPolicy> 子节点（58 处 copy、21 处 default），178 个填报 sheet 中 175 个
    // 整格未写 —— 官方只在「确实需要随行复制」的那些格上开 copy（如 doc/Form/LineForm/插入行策略.cpt
    // 只有 2 格：default 保留录入值 + copy 复制公式）。因此「录入格缺 copy = 缺陷」这条规则在官方语料上
    // 会产生 4000+ 条噪声（实测 4909 格），属误报口径，绝不能当 warning。
    // 【本工具采用的判据】（队长专业域裁定，按此定稿）warning 只给「同一数据行内不一致」：
    // 同行部分格显式设了 copy、其余格没设 —— 这是业务侧「补了若干格又漏了几格」的症状。
    // 官方语料实测命中（均为官方模板自身的真实不一致，报出来是对的，不得再用"零误报"措辞）：
    //   自动匹配.cpt（sheet1!A3 未设 / B3..F3=copy）、LineForm6.cpt（sheet1!B3 未设 / C3..K3=copy）、
    //   demo/form/通讯录(自匹配excel在线导入).cpt（第 7 行多个格未设 / 同行其余格=copy）。
    // 「不设 insertPolicy」本身不是缺口：官方 175/178 个填报 sheet 整格未写，设计器不强制。
    // 【三档定稿（队长专业域裁定）】
    //   ① warning = 同行「仅有 copy 一类显式策略」、其余格未设 → 唯一对齐目标就是 copy，同伴缺 copy 就是真漏格
    //      ⇒ 实测 3 条：自动匹配.cpt A3、LineForm6.cpt B3、通讯录(自匹配excel在线导入).cpt 第 7 行；
    //   ② info = 同行 default+copy 混存（mixedPolicyRows）→ 无唯一对齐目标，报「B3=default，另有 N 格未设」，
    //      但**不给改 copy 的建议**。理由：硬报 warning 就必须挑一个对齐目标，无论挑谁都会诱导模型把另一类
    //      覆盖掉（把 default 改成 copy 正是要防的误导）；且 doc/Form/LineForm/插入行策略.cpt 本身是官方的
    //      "插入行策略"教学范本 —— 它被判 warning 即说明判据与官方设计意图冲突。⇒ 实测 1 条（该文件）；
    //   ③ info = 整行未设 / 仅 default 混用 → 官方常态，只提示、不判缺口。
    // 计数口径：官方语料实测 = warning 3 + mixedPolicyRows(info) 1（不得再写「4 行 warning」）。
    const rowPolicy = new Map(); // row -> [{cell, prof, policy}]
    for (const c of sheetCells) {
      if (c.column == null || c.row == null) continue;
      const prof = cellFillProfile(c);
      if (!(prof.isDataWidget || prof.isDSColumn)) continue;
      if (!rowPolicy.has(c.row)) rowPolicy.set(c.row, []);
      // policy 三态：null=未设 / 'default' 等=显式非 copy / 'copy'
      rowPolicy.get(c.row).push({ c, prof, policy: prof.policyUnset ? null : prof.rawPolicy });
    }
    const inconsistentKeys = new Set();
    const inconsistentRows = [];
    const inconsistentRowSet = new Set();
    const mixedPolicyRows = []; // 行内 default/null 混用：info 级，不做修复建议
    for (const [row, list] of rowPolicy) {
      if (list.length < 2) continue;
      const explicit = list.filter((x) => x.policy != null);
      if (!explicit.length || explicit.length === list.length) continue; // 全无/全有：不算缺口
      const missing = list.filter((x) => x.policy == null);
      const setCopy = explicit.filter((x) => x.policy === 'copy');
      const setNonCopy = explicit.filter((x) => x.policy !== 'copy');
      const addr = (x) => `${sheet}!${a1Of(x.c)}`;
      // 【t9 修复】warning 只在「同行显式策略唯一且就是 copy」（setNonCopy 为空）、且仍有格未设时产出
      // —— 此时 copy 是唯一对齐目标。若同行同时存在显式 default 等非 copy 值（copy+default 混存），
      // 说明设计者本就在混用两种策略、没有唯一对齐目标 → 归 info（mixedPolicyRows），
      // 既不误报 warning，也避免 fix 文案诱导把 default 覆盖成 copy（队长 t9 裁定）。
      // 另：必须真有未设格，否则「有 copy 但无未设格」会被当成缺口（missing=[] 的伪缺口）。
      if (setCopy.length && !setNonCopy.length && missing.length) {
        for (const x of missing) inconsistentKeys.add(`${x.c.column},${x.c.row}`);
        inconsistentRowSet.add(row);
        inconsistentRows.push({
          row,
          rowNumber: row + 1,
          expect: 'copy',
          missing: missing.map(addr),
          missingCount: missing.length,
          // 文案按策略分组：已设 copy 与已设非 copy(default) 分开列，禁止把 default 误述为 copy
          setCopy: setCopy.map(addr),
          setNonCopy: setNonCopy.map(addr),
          setNonCopyPolicies: [...new Set(setNonCopy.map((x) => x.policy))],
        });
        continue;
      }
      mixedPolicyRows.push({
        row,
        rowNumber: row + 1,
        setCopy: setCopy.map(addr),
        setNonCopy: setNonCopy.map(addr),
        setNonCopyPolicies: [...new Set(setNonCopy.map((x) => x.policy))],
        setPolicies: [...new Set(explicit.map((x) => x.policy))],
        unsetCells: missing.map(addr),
        unsetCount: missing.length,
      });
    }
    const sheetPartialRows = inconsistentRows.length;

    for (const c of sheetCells) {
      if (c.column == null || c.row == null) continue;
      const address = `${sheet}!${a1Of(c)}`;
      const prof = cellFillProfile(c);
      const inDataRow = dataRows.has(c.row);
      // 「行内不一致」的缺格：行完整性缺口（业务侧补漏的实际症状）
      const isInconsistent = inconsistentKeys.has(`${c.column},${c.row}`);
      // 【t9】行内一致且本格未设 insertPolicy 的格：这类格才是「按需补 copy」的候选。
      // 判定要点：本行不存在「已设 copy 而未设格并存」（那是 warning）也不存在「显式非 copy + 未设」混用
      // （那没有唯一对齐目标，见 needsCopyHint 的对手分支）——两者都不进待补清单，避免误导覆盖。
      const rowHasExplicitNonCopy = (rowPolicy.get(c.row) || []).some((x) => x.policy != null && x.policy !== 'copy');
      const rowAllUnset = rowPolicy.has(c.row) && (rowPolicy.get(c.row) || []).every((x) => x.policy == null);
      // 纯数据行（该行没有任何格显式写 insertPolicy、也无显式非 copy 值）：官方常态，只作 info 提示，不判缺陷
      const needsCopyHint = !isInconsistent && (prof.isDataWidget || prof.isDSColumn) && prof.policyUnset
        && rowAllUnset && !rowHasExplicitNonCopy;
      const dictOk = !prof.needsDict || widgetHasDictionary(parsed, index, c.column, c.row);
      const expandProblems = [];
      for (const [dir, ref] of [['left', prof.expandLeft], ['up', prof.expandUp]]) {
        if (ref == null || String(ref).trim() === '') continue;
        if (!parentExists(ref)) expandProblems.push({ dir, ref, problem: `扩展父格引用 ${ref} 指向不存在的单元格` });
      }
      // 数据行内既无控件也无 DSColumn 的空格：页面上既不能录入也取不到数。
      // 严重度：仅 info（官方 1550 样本实测 977 处命中合并区占位/行内空档/纯展示模板，无法据此判缺陷）；
      // 仍排除被 cs/rs 覆盖的坐标，减少噪声。
      const isEmptyDataSlot = inDataRow && !prof.isWidgetCell && !prof.isDSColumn && c.contentKind === 'empty'
        && !coveredCoords.has(`${c.column},${c.row}`);
      const isStaticTextDataRow = inDataRow && !prof.isDSColumn && c.contentKind === 'text';

      cellRows.push({
        address, sheet, sheetIndex: index, column: c.column, row: c.row,
        contentKind: c.contentKind, contentObjectType: c.contentObjectType,
        widgetClass: prof.widgetClass,
        expand: { dir: prof.expandDir, left: prof.expandLeft, up: prof.expandUp },
        inDataRow,
        insertPolicy: prof.insertPolicy,
        insertPolicyCopy: prof.hasInsertPolicyCopy,
        insertPolicyUnset: prof.policyUnset,
        // 缺 copy：仅当「同数据行内有格已显式写 copy、而本格压根没写 insertPolicy」时为真
        // （显式 default 不在其列 —— 那是设计者的显式决策，补 copy 会覆盖它）
        needsInsertPolicyCopy: isInconsistent,
        needsInsertPolicyCopyLevel: isInconsistent ? 'warn' : (needsCopyHint ? 'info' : null),
        dictionary: prof.needsDict ? (dictOk ? 'present' : 'missing') : null,
        problems: [
          ...(isInconsistent
            ? [{ kind: 'inconsistentInsertPolicy', level: 'warn', message: '缺 InsertPolicy=copy：同一数据行的其他格已显式设了插入策略，本格没设 —— 插入新行时该格取值会与同行不一致', fix: `对齐同行已显式设置的值：update_cell({ column: ${c.column}, row: ${c.row}, insertPolicy: 'copy' })；整行批量用 batch_mutate_cells 的 data.patch.insertPolicy` }]
            : []),
          ...(needsCopyHint
            ? [{ kind: 'missingInsertPolicyCopy', level: 'info', message: '该数据行没有任何格显式设 insertPolicy（官方样本常态：模型/设计器只在确有需要的格上开 copy）；若本行需要插入行随行复制，才需补 copy', fix: `按需：update_cell({ column: ${c.column}, row: ${c.row}, insertPolicy: 'copy' })` }]
            : []),
          ...(isStaticTextDataRow
            ? [{ kind: 'staticTextInDataRow', message: '数据行内的静态文本格（无 DSColumn 绑定），行插入后没有数据来源（固定文案可忽略）', fix: `若该列应取数：set_cell_content_type({ contentType: 'dsColumn', dsName, columnName })` }]
            : []),
          ...(isEmptyDataSlot
            ? [{ kind: 'missingWidget', message: '数据行列格既无控件也无 DSColumn 绑定（该格无法录入/无数据来源）', fix: `按用途二选一：add_cell({ column, row, widget: 'text' }) 补录入控件，或 set_cell_content_type({ contentType: 'dsColumn', ... }) 补数据绑定` }]
            : []),
          ...(prof.needsDict && !dictOk
            ? [{ kind: 'missingDictionary', message: '下拉控件缺少数据字典（<Dictionary>），页面下拉为空', fix: `add_cell({ widget: 'comboBox', widgetItems: [...] }) 重建控件字典` }]
            : []),
          ...expandProblems.map((p) => ({ kind: 'danglingExpandParent', message: p.problem, fix: `把 ${p.dir} 父格改为已存在的单元格（A1 行号从 1 起），或 delete_cell 后 add_cell 重建该格扩展` })),
        ],
      });

      // missingInsertPolicyCopy = 行内不一致的缺格（warning 级）；全行未设的只在 problems 里作 info
      // （缺格收集统一在下方由 partialRows 收敛，避免重复坐标）
      if (isStaticTextDataRow) staticTextCells.push(address);
      if (isEmptyDataSlot) missingWidget.push({ address, row: c.row, column: c.column });
      if (inDataRow && !prof.isDataCell && c.contentKind !== 'text') missingDSColumn.push(address);
      if (prof.needsDict && !dictOk) missingDictionary.push({ address, widgetClass: prof.widgetClass });
      if (expandProblems.length) danglingExpandParent.push({ address, problems: expandProblems });
      // 「未设 insertPolicy 的数据格」= 明确没写 insertPolicy 的行内格（官方常态，info 级）：不进 warning，
      // 但必须出现在建议修复清单里 —— 否则「全表未设 copy」的模板（如 backup/通知排产表.cpt）
      // 会输出 0 个待修坐标，诊断就无法照 t4 的流程一键补齐。
      // 【t9 修复】只收 policyUnset（null）的格；显式 default 等非 copy 值一律不进待补清单。
      // 且只收「整行未设」的行（rowAllUnset）——同行已有显式策略时（无论 copy 或 default），
      // 待补坐标应交给 partialRows/suggestedFixCells 那条路径，避免把「显式 default 的同行格」
      // 一并推成 copy（那等于否定设计者对该行的显式选择）。
      // 收集统一放在下方聚合处（由 partialRows 收敛 + 本分支），避免同一坐标被多条路径重复入列。
      if (prof.policyUnset && (prof.isDataWidget || prof.isDSColumn) && rowAllUnset) {
        recommendedCopyCells.push(address);
      }
    }

    // 【t9 修复】missingInsertPolicyCopy 单一来源：由 partialRows 收敛（只含未设格，且天然去重）。
    // 这样「显式 default 不入列」「不重复坐标」两条硬要求都成立，且 missing.inconsistentRowMissingCells 与它同源。
    for (const row of inconsistentRows) missingInsertPolicyCopy.push(...row.missing);

    const dataCellCount = cellRows.filter((r) => r.needsInsertPolicyCopy).length;
    totals.cells += sheetCells.length;
    totals.dataCells += dataCellCount;
    totals.missingInsertPolicyCopy += missingInsertPolicyCopy.length;
    totals.recommendedInsertPolicyCopy += recommendedCopyCells.length;
    totals.staticTextCells += staticTextCells.length;
    totals.missingDSColumn += missingDSColumn.length;
    totals.missingWidget += missingWidget.length;
    totals.missingDictionary += missingDictionary.length;
    totals.danglingExpandParent += danglingExpandParent.length;

    sheetsOut.push({
      sheet, sheetIndex: index, fillEnabled, submitCount,
      cellCount: sheetCells.length,
      dataRowCount: dataRows.size,
      dataCellCount,
      // warn = 行内不一致的缺 copy（必须补）；info = 整行未设 insertPolicy（官方常态，按需）
      missingCounts: {
        insertPolicyCopyWarn: cellRows.filter((r) => r.needsInsertPolicyCopyLevel === 'warn' && !r.insertPolicyCopy).length,
        insertPolicyCopyInfo: cellRows.filter((r) => r.needsInsertPolicyCopyLevel === 'info' && !r.insertPolicyCopy).length,
      },
      // 一键修复坐标清单：warning 级缺格 + 按需补的未设格（后者是否补齐由业务判断）。
      // 【t9 修复】去重：同一坐标在「行内不一致缺格」与「未设格」两条路径都会被收集，叠加会出现重复项。
      suggestedFixCells: [...new Set([...missingInsertPolicyCopy, ...recommendedCopyCells])],
      recommendedInsertPolicyCopy: [...new Set(recommendedCopyCells)],
      partialRows: inconsistentRows,
      partialRowCount: sheetPartialRows,
      // 行内 default(null) 混用：官方 doc/Form/LineForm/插入行策略.cpt 即此形态（default 是显式设计决策）
      // → 只作 info，不给改 copy 的修复建议（expect/fix 必须一致，否则会误导模型把 default 全改掉）
      mixedPolicyRows,
      missing: {
        insertPolicyCopy: missingInsertPolicyCopy,
        inconsistentRowMissingCells: inconsistentRows.flatMap((r) => r.missing),
        staticTextCellsInDataRow: staticTextCells,
        dsColumn: missingDSColumn,
        widget: missingWidget,
        dictionary: missingDictionary,
        expandParent: danglingExpandParent,
      },
      cells: cellRows,
    });
  }

  const filledSheets = sheetsOut.filter((s) => s.fillEnabled);
  const clean = totals.missingInsertPolicyCopy === 0 && totals.danglingExpandParent === 0
    && totals.missingDictionary === 0 && totals.missingWidget === 0;
  return {
    action: 'diagnose_fill_row_integrity',
    path,
    sheets: sheetsOut,
    totals,
    summary: clean
      ? (filledSheets.length
        ? `填报行完整性检查通过：${totals.cells} 格 / ${filledSheets.length} 个填报工作表，无「行内 insertPolicy 不一致 / 悬空父格 / 缺字典」问题${totals.recommendedInsertPolicyCopy ? `；另有 ${totals.recommendedInsertPolicyCopy} 个数据格未设 insertPolicy（官方常态，按需补 copy：suggestedFixCells）` : ''}`
        : '未发现启用填报的工作表（无 ReportWriteAttr/SubmitVisitor）——非填报模板，无需补 insertPolicy')
      : `发现缺口：insertPolicy 行内不一致缺格 ${totals.missingInsertPolicyCopy} 格（${sheetsOut.reduce((n, s) => n + s.partialRowCount, 0)} 个数据行）、空格无控件/绑定 ${totals.missingWidget} 格、缺下拉字典 ${totals.missingDictionary} 格、悬空扩展父格 ${totals.danglingExpandParent} 格；另建议补 copy 的未设数据格 ${totals.recommendedInsertPolicyCopy} 格（见 suggestedFixCells）`,
    note: '判据说明：官方 1550 样本实证 insertPolicy 不是所有录入格的必备属性（仅 28 份模板显式写过，58 处 copy / 21 处 default；178 个官方填报 sheet 中 175 个整格未写）。warning 只给「同一数据行部分格显式设了、其余格没设」的行内不一致；整行未设只作 info 并进入 suggestedFixCells（按需补）。',
    fixHints: [
      '按建议清单批量补：batch_mutate_cells({ path, mode: "plan", commands: [{ op: "update", target: { sheet, cells: [...] }, data: { patch: { insertPolicy: "copy" } } }] }) → 拿 planId 再 mode:"apply"',
      '单格修复：update_cell({ path, column, row, insertPolicy: "copy" })',
      '复检：diagnose_fill_row_integrity 与 validate_cpt（填报行完整性维度）',
    ],
  };
}

/** 便捷入口：从路径读取并盘点（只读，不改文件） */
export function diagnoseFillRowIntegrity(path, opts = {}) {
  const { parsed } = load(path);
  return diagnoseFillRowIntegrityFromParsed(parsed, path, opts);
}
