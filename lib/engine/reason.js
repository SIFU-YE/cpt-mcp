// cpt-mcp/lib/engine/reason.js
// 微型报表引擎 —— 合理性审查（reasonableness review）
// 关注"语义/工程"层面：网格一致性、控件合法性、参数面板与数据集参数匹配、
// 填报字段规范性、页面设置边界、内容/控件冲突等。与 validate_cpt（结构校验）互补。
import { load } from '../xml.js';
import { datasets, cells, fillConfig, pageSettings, parameterPanel, styles } from '../cpt.js';
import { WIDGET_CLASSES, WIDGET_CLASS_TO_KIND, estimateTextWidthMm } from './rules.js';
import { asArray, asReports } from '../parsed-shape.js';


/** 解析 RowHeight / ColumnWidth 的 CDATA CSV 为数字数组 */
function gridCsv(report, tag) {
  const node = report[tag];
  if (!node) return [];
  const raw = (node['__cdata'] ?? node['#text'] ?? '').toString();
  if (!raw.trim()) return [];
  return raw.split(',').map((x) => Number(x.trim())).filter((x) => Number.isFinite(x));
}

/**
 * 合理性审查。
 * @param {string} path cpt 文件路径
 * @returns {{count:number, issues:Array<{severity,location,message,suggestion?}>}}
 */
export function reviewReasonableness(path) {
  const issues = [];
  const { parsed } = load(path);
  const reports = asReports(parsed);
  const cellArr = cells(path);
  const dsArr = datasets(path);
  const pp = parameterPanel(path);

  // 1. 网格一致性：单元格坐标 vs 行高/列宽数组
  // P2-1 收敛：超界 warning 必须自带可执行 fix（此前"规则严但修法散"）—— 安全口径为
  // get_grid 取数组→尾部按缺省值补齐→set_grid 回写；勿用裸 rowCount/columnCount，
  // 那会把整表已有自定义行高/列宽重置为缺省值。
  reports.forEach(({ report, sheet }) => {
    const rowsCsv = gridCsv(report, 'RowHeight');
    const colsCsv = gridCsv(report, 'ColumnWidth');
    const rowCount = rowsCsv.length;
    const colCount = colsCsv.length;
    cellArr.filter((c) => c.sheet === sheet).forEach((c) => {
      if (c.column != null && colCount > 0 && c.column >= colCount) {
        issues.push({
          severity: 'warning', location: `单元格(${sheet}.${c.column},${c.row})`, message: `列号 ${c.column} 超出 ColumnWidth 数量 ${colCount}，该列可能无列宽定义`,
          suggestion: `可执行修复：get_grid 取该表列宽数组，尾部按默认列宽 2743200 补齐至 ${c.column + 1} 个，再 set_grid({ columnWidths: [...] })（勿用裸 columnCount，会重置已有自定义列宽）`,
        });
      }
      if (c.row != null && rowCount > 0 && c.row >= rowCount) {
        issues.push({
          severity: 'warning', location: `单元格(${sheet}.${c.column},${c.row})`, message: `行号 ${c.row} 超出 RowHeight 数量 ${rowCount}，该行可能无行高定义`,
          suggestion: `可执行修复：get_grid 取该表行高数组，尾部按默认行高 723900 补齐至 ${c.row + 1} 个，再 set_grid({ rowHeights: [...] })（勿用裸 rowCount，会重置已有自定义行高）`,
        });
      }
    });
  });

  // 1b. 列宽疑似不足：静态文本格的显示宽度估算超过该列（含合并跨度）可用宽度。
  // 依据：中文全角 ≈ 1em、半角 ≈ 0.5em（字号取单元格样式，缺省 12pt）。仅检查静态文本，
  // 数据集列的运行时内容宽度不可知。合并单元格按跨列宽度合计。
  const stylePt = new Map(styles(path).map((s) => [s.styleIndex, s.fontSizePt]));
  reports.forEach(({ report, sheet }) => {
    const colsCsv = gridCsv(report, 'ColumnWidth');
    const colMm = (col, span) => {
      let sum = 0;
      for (let i = col; i < col + (span ?? 1); i++) {
        const u = colsCsv[i];
        if (u == null) return null;
        sum += u;
      }
      return sum / 144000;
    };
    cellArr.filter((c) => c.sheet === sheet && c.contentKind === 'text' && c.contentText && c.column != null).forEach((c) => {
      const available = colMm(c.column, c.colspan);
      if (available == null) return;
      // U5 藏列豁免：可用宽度 <2mm 即设计隐藏列（填报命令列 0.1/0.01mm 实证），
      // 其文本必然“超宽”，截断与否不可见，直接跳过（可见列最小 21mm，阈值无误伤）。
      if (available < 2) return;
      const est = estimateTextWidthMm(c.contentText, stylePt.get(c.style ?? 0) ?? 12);
      if (est > available + 0.5) {
        issues.push({
          severity: 'warning',
          location: `单元格(${sheet}.${c.column},${c.row})`,
          message: `列宽疑似不足：文本显示宽约 ${est.toFixed(1)}mm，可用 ${available.toFixed(1)}mm（可能被截断；自动换行/合并单元格可忽略）`,
          suggestion: 'set_grid 加宽该列，或设置单元格文本控制为自动换行',
        });
      }
    });
  });

  // 2. 控件合法性 + 内容/控件冲突
  cellArr.forEach((c) => {
    const loc = `单元格(${c.sheet}.${c.column},${c.row})`;
    if (c.widgetClass && !WIDGET_CLASSES.has(c.widgetClass)) {
      issues.push({ severity: 'info', location: loc, message: `控件类 "${c.widgetClass}" 不在内置白名单（可能为自定义/插件控件，非错误）` });
    }
    // M106 移除：网格单元格控件不再检查 widgetName。
    // M117 更正数字：M106 原文「单元格控件共 5788 个，带 <widgetName> 的 0 个（0.0%）」是统计口径错误
    // ——把 <WidgetName> 当成了 <Widget> 的属性名，实际是 <Widget> 的子节点。本机 FR 11.0 官方 1550 份模板
    // 按 <C>…</C> 内 <Widget> 块精确统计：单元格控件共 5857 个，带 <WidgetName> 的 **245 个（4.18%）**，
    // 覆盖 17 个类（TextEditor 116 / NumberEditor 29 / ComboBox 19 / FreeButton 16 / RadioGroup 12…）；
    // 按旧口径分母 5788 计亦为 245/5788 ≈ 4.23%。即「单元格控件也可以有 WidgetName」是官方事实。
    // 但移除结论不变：网格里的单元格控件靠
    // **坐标 + DSColumn 绑定**定位，FR 不要求起名；"起名"是**参数面板控件**的惯例 —— 面板侧已由下方
    // 「参数面板控件缺少名称（WidgetName）」(warning) 单独把关。
    // 因此**不恢复**这条 info（官方 4.18% 有名字，恢复会让 95.8% 的正常模板继续刷屏噪声），
    // 也不为它加单元格侧 widgetName 写入参数（无真实场景在等）。
    // 此前这条 info 会在**每一份**官方模板上刷屏，且当前工具链无法为单元格控件设 widgetName
    //（add_cell / set_cell_widget 均无该参数），属不可执行的噪声。
    // 内容与控件并存：控件格不应再有【文本】内容（控件值会覆盖它）。
    // M106 校正：对象内容（<O t="DSColumn">/Formula/Image → contentKind='object:xxx'）与控件并存是
    // 填报模板的**正常形态** —— 官方 1550 份模板里「控件格 + 数据绑定」共 1030 处全部如此，
    // 设计器把字段拖到控件格就是产出这个形态。此前条件用 contentText 非空判定，而 cells() 对对象节点
    // 会带出节点间缩进空白（形如 "\n\n"），于是把这 1030 例正常形态全部误报成"控件与文本冲突"。
    // 故改按 contentKind === 'text' 判定，且文本需 trim 后非空。
    if (c.widgetClass && c.contentKind === 'text' && String(c.contentText ?? '').trim()) {
      issues.push({ severity: 'warning', location: loc, message: `单元格同时存在控件(${WIDGET_CLASS_TO_KIND[c.widgetClass] || c.widgetClass})与文本内容，可能被控件值覆盖` });
    }
  });

  // 3. 参数面板控件 vs 数据集参数匹配（控件名宜与数据集参数同名，便于绑定/查询）
  if (pp && pp.widgets && pp.widgets.length) {
    const paramNames = new Set(dsArr.flatMap((d) => (d.parameters || []).map((p) => p.name)).filter(Boolean));
    pp.widgets.forEach((w) => {
      const loc = `参数面板控件(${w.name || '?'})`;
      if (!w.name) issues.push({ severity: 'warning', location: loc, message: '参数面板控件缺少名称（WidgetName），无法与数据集参数绑定' });
      else if (!paramNames.has(w.name) && w.class && WIDGET_CLASS_TO_KIND[w.class]) {
        issues.push({ severity: 'info', location: loc, message: `控件 ${w.name} 未匹配到任何数据集参数（若为查询按钮/标签或外部传参可忽略）` });
      }
    });
  }

  // 4. 填报字段规范性
  const fc = fillConfig(path);
  const boundCells = new Map();
  fc.submits.forEach((s) => {
    const loc = `提交 ${s.name}`;
    const fields = new Set();
    s.columns.forEach((col) => {
      const f = col.field;
      if (!f) { issues.push({ severity: 'error', location: loc, message: '绑定字段缺少 name' }); return; }
      if (fields.has(f)) issues.push({ severity: 'warning', location: `${loc}.${f}`, message: '绑定字段重复' });
      fields.add(f);
      if (!/^[A-Za-z0-9_\u4e00-\u9fa5]+$/.test(f)) {
        issues.push({ severity: 'info', location: `${loc}.${f}`, message: `字段名 "${f}" 含特殊字符（空格/引号/括号/连字符等），请确认与数据库列名一致` });
      }
      if (col.column != null && col.row != null) {
        const key = `${s.sheet}.${col.column},${col.row}`;
        if (boundCells.has(key)) issues.push({ severity: 'warning', location: `${loc}.${f}`, message: `单元格(${col.column},${col.row}) 被多个绑定字段引用` });
        boundCells.set(key, f);
      }
    });
  });

  // 5. 页面设置边界（pageSettings 每次 load+全量解析，必须提到循环外只取一次）
  const ps = pageSettings(path) || {};
  reports.forEach(({ sheet }) => {
    if (!ps.paperSizeUnit) {
      issues.push({ severity: 'info', location: `Report(${sheet})`, message: '使用默认纸张设置（未显式指定尺寸），可接受' });
    } else {
      const mmToU = 144000;
      const wMm = ps.paperSizeUnit.width / mmToU, hMm = ps.paperSizeUnit.height / mmToU;
      const m = ps.marginUnit || {};
      const borders = [
        ['上边距', m.top / mmToU], ['下边距', m.bottom / mmToU],
        ['左边距', m.left / mmToU], ['右边距', m.right / mmToU],
      ];
      borders.forEach(([name, v]) => {
        if (v == null) return;
        if (v < 0) issues.push({ severity: 'error', location: `Report(${sheet})`, message: `${name} 为负值 ${v}mm` });
        else if (v > Math.min(wMm, hMm) / 2) issues.push({ severity: 'warning', location: `Report(${sheet})`, message: `${name} ${v}mm 接近/超过纸张一半，内容区过窄` });
      });
      if (wMm <= 0 || hMm <= 0) issues.push({ severity: 'error', location: `Report(${sheet})`, message: `纸张尺寸非法（${wMm}mm x ${hMm}mm）` });
    }
  });

  // 6. 数据集合理性
  // 2026-11-05 修（审计 P0-2）：Excel/内嵌/命名等非 SQL 数据集没有 Connection/SQL 是**正常形态**，
  // 只在 DBTableData（SQL 数据集）上提示连接缺失，避免合法 Excel 数据集被误判成问题。
  dsArr.forEach((d) => {
    const loc = `数据集 ${d.name || '?'}`;
    const cls = String(d.class ?? '');
    if (/DBTableData/i.test(cls) && !d.connection) {
      issues.push({ severity: 'info', location: loc, message: '未指定数据连接（Connection），预览时可能无法取数' });
    }
    const refs = [...new Set([...(String(d.sql || '').matchAll(/\$\{([A-Za-z_\u4e00-\u9fff$][\w\u4e00-\u9fff$]*)\}/g))].map((m) => m[1]))];
    const defined = new Set((d.parameters || []).map((p) => p.name).filter(Boolean));
    refs.forEach((r) => { if (!defined.has(r)) issues.push({ severity: 'info', location: `${loc} SQL`, message: `SQL 引用参数 ${r}，将来可由外部传参或数据集参数赋默认值` }); });
  });

  return { count: issues.length, issues };
}
