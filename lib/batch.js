// cpt-mcp/lib/batch.js —— P2 批量工具统一调度层
//
// 设计目标：
//   1. 68 个 batch 工具共用同一套「逐项循环 + 每项独立 try/catch + 汇总」调度器，
//      避免每个工具各写一套循环（reviewer 关注点）。
//   2. 批量工具是单增/删/改/查的薄包装：apply 回调里直接复用 lib/edits.js / lib/generate.js /
//      lib/cpt.js / lib/schedule.js / lib/engine/chart.js 现有单工具逻辑。
//   3. 每项返回独立结果（status ∈ inserted/updated/deleted/read/skipped/failed），
//      单项失败只记 failed，不整体崩溃。
//      【非原子】批量按序逐项落盘：失败项不回滚已成功项，调用方务必检查 summary.failed/results 做补偿；
//      单元格多格如需原子语义请走 batch_mutate_cells（plan 在副本试算→apply 原子写回），不要用 *_batch 拼单元格。
//
// 统一形态（与 server.js zod schema 对齐）：
//   add_*_batch(path, items)                        items = 单增工具入参对象数组
//   delete_*_batch(path, targets)                   targets = 单删工具定位入参对象数组
//   update_*_batch(path, items)                     items = [{ target, patch }]
//   get_*_batch(path, targets)                      targets = 单查工具定位入参对象数组

import {
  updateParameter, addParameter, deleteParameter,
  updateDatasetSql, deleteDataset,
  addFillBinding, updateFillBinding, deleteFillBinding,
  addCellHighlight, addCellHyperlink, deleteCellHyperlink, deleteCellHighlight, getCellHighlight,
  updateCellHyperlink, updateCellHighlight,
  deleteFillSubmit, deleteSheet, deleteStyle,
  updateParameterWidget, deleteParameterWidget,
  deletePageHeaderFooter,
  deleteChart, getCellHyperlink, deleteFloatElement,
  deleteCellSort, updateCellSort, getCellSort,
  getChart, updateChart,
  getCellListener, updateCellListener, deleteCellListener,
  getFloatElement, updateFloatElement,
  updateFillSubmit, updateSheet,
  addToolbarButton, deleteToolbarButton, setToolbarButtonJs, setToolbarButtonIcon, listToolbarButtons,
  setReportListener,
} from './edits.js';
// 2026-10-29 去重：颜色/单位换算实现统一在 leaf 模块 rules.js（edits/cpt/generate 不再各存一份）
import { hexToArgb } from './engine/rules.js';
import {
  addDataset, addStyle, addSheet, addFillSubmit, addParameterWidget, setPageHeaderFooter, addFloatElement,
} from './generate.js';
import { addChart } from './engine/chart.js';
import { datasets, parameters, styles, parameterPanel, fillConfig, cells, overview, gridSizes, aggregateDesignerEscapes } from './cpt.js';
import { addTask, removeTask, getTask, enableTask, disableTask } from './schedule.js';
import { load, save, styleBlocks, locateSheet, sheetBlocks } from './xml.js';

// ---- 通用工具 ----

// 2026-10-29：转义口径统一（本文件原有一份不转义单引号的实现，与 edits 不一致）
import { escapeXmlAttr } from './format.js';

const labelOf = (x, i) => (x && typeof x === 'object' ? (x.name ?? x.index ?? x.taskId ?? x.submitIndex ?? (x.column != null ? `${x.column},${x.row}` : undefined)) : undefined) ?? `#${i}`;

/**
 * 通用批量调度器：逐项执行 apply(item, index)，单项失败只记 failed 不中断。
 * apply 返回对象需带 status（inserted/updated/deleted/read/skipped/failed），其余字段原样透传。
 * @param {object} opts
 * @param {Array} opts.items 目标项数组
 * @param {(item, index) => any|Promise<any>} opts.apply 单项执行器
 * @param {(item, index) => string} [opts.label] 失败时用于标识目标
 */
export async function runBatch({ items, apply, label }) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error('批量工具必须提供非空目标数组（items/targets）');
  }
  const results = [];
  const summary = { total: items.length, inserted: 0, updated: 0, deleted: 0, read: 0, skipped: 0, failed: 0 };
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    try {
      const r = await apply(item, i);
      const status = r && typeof r.status === 'string' ? r.status : 'updated';
      results.push({ ...r, status });
      if (summary[status] !== undefined) summary[status] += 1;
    } catch (e) {
      results.push({ status: 'failed', target: (label ?? labelOf)(item, i), error: e.message });
      summary.failed += 1;
    }
  }
  return { summary, results };
}

// 读回清单里按 name/index 过滤的薄封装
function pickByName(list, names) {
  const wanted = new Set(names.map((n) => String(n)));
  return list.filter((x) => wanted.has(String(x?.name)));
}

// ---- 1. 数据集 ----
export async function addDatasetBatch(path, items) {
  return runBatch({ items, label: (x) => x?.name, apply: (it) => ({ status: 'inserted', target: it?.name, ...addDataset(path, it) }) });
}
export async function deleteDatasetBatch(path, targets) {
  return runBatch({ items: targets, label: (x) => x?.name, apply: (t) => ({ status: 'deleted', target: t?.name, ...deleteDataset(path, t?.name) }) });
}
export async function updateDatasetBatch(path, items) {
  return runBatch({
    items, label: (x) => x?.target?.datasetName, apply: (it) => {
      const t = it?.target ?? {}, p = it?.patch ?? {};
      return { status: 'updated', target: t.datasetName, ...updateDatasetSql(path, t.datasetName, p.sql) };
    },
  });
}
export async function getDatasetBatch(path, targets) {
  const all = datasets(path);
  return runBatch({
    items: targets, label: (x) => x?.name, apply: (t) => {
      const hit = all.find((d) => String(d.name) === String(t?.name));
      return hit ? { status: 'read', target: t?.name, found: true, data: hit } : { status: 'skipped', target: t?.name, found: false };
    },
  });
}

// ---- 2. 参数（数据集层 / 报表级双层通道，P1-1：scope 透传，同名跨层不再互斥） ----
export async function addParameterBatch(path, items) {
  return runBatch({ items, label: (x) => x?.name, apply: (it) => ({ status: 'inserted', target: it?.name, ...addParameter(path, it?.name, it?.defaultValue ?? '', it?.scope ?? 'dataset', it?.dsName) }) });
}
export async function deleteParameterBatch(path, targets) {
  return runBatch({ items: targets, label: (x) => x?.name, apply: (t) => ({ status: 'deleted', target: t?.name, ...deleteParameter(path, t?.name, t?.scope ?? 'auto', t?.dsName) }) });
}
export async function updateParameterBatch(path, items) {
  return runBatch({
    items, label: (x) => x?.target?.name, apply: (it) => {
      const t = it?.target ?? {}, p = it?.patch ?? {};
      return { status: 'updated', target: t.name, ...updateParameter(path, t.name, p.defaultValue, p.newName, t.scope ?? p.scope ?? 'auto', t.dsName ?? p.dsName) };
    },
  });
}
export async function getParameterBatch(path, targets) {
  const all = parameters(path);
  return runBatch({
    items: targets, label: (x) => x?.name, apply: (t) => {
      const hit = all.find((p) => String(p.name) === String(t?.name) && (t?.scope ? p.scope === t.scope : true));
      return hit ? { status: 'read', target: t?.name, found: true, data: hit } : { status: 'skipped', target: t?.name, found: false };
    },
  });
}

// ---- 3. 参数面板控件 ----
export async function addParameterWidgetBatch(path, items) {
  return runBatch({ items, label: (x) => x?.name, apply: (it) => ({ status: 'inserted', target: it?.name, ...addParameterWidget(path, it) }) });
}
export async function deleteParameterWidgetBatch(path, targets) {
  return runBatch({ items: targets, label: (x) => x?.name, apply: (t) => ({ status: 'deleted', target: t?.name, ...deleteParameterWidget(path, t?.name) }) });
}
export async function updateParameterWidgetBatch(path, items) {
  return runBatch({
    items, label: (x) => x?.target?.name, apply: (it) => {
      const t = it?.target ?? {}, p = it?.patch ?? {};
      return { status: 'updated', target: t.name, ...updateParameterWidget(path, { name: t.name, ...p }) };
    },
  });
}
export async function getParameterWidgetBatch(path, targets) {
  const widgets = parameterPanel(path)?.widgets ?? [];
  return runBatch({
    items: targets, label: (x) => x?.name, apply: (t) => {
      const hit = widgets.find((w) => String(w.name) === String(t?.name));
      return hit ? { status: 'read', target: t?.name, found: true, data: hit } : { status: 'skipped', target: t?.name, found: false };
    },
  });
}

// ---- 4. 样式 ----
export async function addStyleBatch(path, items) {
  return runBatch({ items, label: (x) => `style@${x?.fontName ?? ''}`, apply: (it) => ({ status: 'inserted', target: it, ...addStyle(path, it) }) });
}
export async function deleteStyleBatch(path, targets) {
  return runBatch({
    items: targets, label: (x) => `style#${x?.index}`, apply: (t) => ({ status: 'deleted', target: t?.index, ...deleteStyle(path, t?.index, { force: t?.force }) }),
  });
}
export async function updateStyleBatch(path, items) {
  return runBatch({
    items, label: (x) => `style#${x?.target?.index}`, apply: (it) => {
      const t = it?.target ?? {}, p = it?.patch ?? {};
      return { status: 'updated', target: t.index, ...updateStyle(path, { index: t.index, patch: p }) };
    },
  });
}
export async function getStyleBatch(path, targets) {
  const all = styles(path);
  return runBatch({
    items: targets, label: (x) => `style#${x?.index}`, apply: (t) => {
      const idx = Number(t?.index);
      const hit = all[idx];
      return hit ? { status: 'read', target: idx, found: true, data: hit } : { status: 'skipped', target: idx, found: false };
    },
  });
}

/** update_style：原位改 StyleList 第 index 个样式的常见字段；未传字段与格式原样保留（含边框整块替换/新增） */
function updateStyle(path, { index, patch }) {
  if (patch == null || typeof patch !== 'object') throw new Error('update_style: 必须提供 patch 对象');
  const { raw } = load(path);
  const blocks = styleBlocks(raw).blocks;
  const idx = Number(index);
  if (!Number.isInteger(idx) || idx < 0 || idx >= blocks.length) {
    throw new Error(`update_style: 样式索引 ${index} 越界（共 ${blocks.length} 个）`);
  }
  const current = styles(path)[idx];
  const { start, end } = blocks[idx];
  let seg = raw.slice(start, end);
  const p = patch;

  const setAttr = (tag, name, value) => {
    const re = new RegExp(`\\s${name}="[^"]*"`);
    // 函数式替换：替换文本含用户 patch 值（fontName/对齐/边距等 6+ 字段共用本函数），
    // 字符串式会把 $$/$&/$' 当特殊序列静默改写。第二支依赖 $1/$2 捕获组，故用 (m,g1,g2) 形参承接。
    const v = escapeXmlAttr(String(value));
    if (re.test(tag)) return tag.replace(re, () => ` ${name}="${v}"`);
    return tag.replace(/(\s*)(\/?>)$/, (m, g1, g2) => ` ${name}="${v}"${g1}${g2}`);
  };
  const delAttr = (tag, name) => tag.replace(new RegExp(`\\s${name}="[^"]*"`), '');

  // FRFont 开标签（字体/字号/加粗/斜体/下划线/删除线）
  const fontMatch = seg.match(/<FRFont\b[^>]*>/);
  if (fontMatch) {
    let tag = fontMatch[0];
    if (p.fontName != null) tag = setAttr(tag, 'name', p.fontName);
    if (p.fontSizePt != null) tag = setAttr(tag, 'size', String(Math.round(Number(p.fontSizePt) * 4)));
    if (p.bold != null || p.italic != null) {
      const bold = p.bold != null ? Boolean(p.bold) : current?.bold;
      const italic = p.italic != null ? Boolean(p.italic) : current?.italic;
      let bits = 0; if (bold) bits |= 1; if (italic) bits |= 2;
      tag = setAttr(tag, 'style', String(bits));
    }
    if (p.underline != null) tag = p.underline ? setAttr(tag, 'underline', '1') : delAttr(tag, 'underline');
    if (p.strikethrough != null) tag = p.strikethrough ? setAttr(tag, 'isStrikethrough', 'true') : delAttr(tag, 'isStrikethrough');
    seg = seg.slice(0, fontMatch.index) + tag + seg.slice(fontMatch.index + fontMatch[0].length);
  }

  // 前景色（FRFont 子级 <foreground>）
  if (p.foregroundColor != null) {
    const argb = /^-?\d+$/.test(String(p.foregroundColor)) ? String(p.foregroundColor) : hexToArgb(p.foregroundColor);
    const fgBlock = `<foreground>\n<FineColor color="${argb}" hor="-1" ver="-1"/>\n</foreground>`;
    const ff = seg.match(/<FRFont\b[^>]*>/);
    if (ff && /\/\s*>$/.test(ff[0])) {
      // 自闭合 FRFont → 展开为块再放前景色
      const expanded = ff[0].replace(/\/\s*>$/, '>') + `\n${fgBlock}\n</FRFont>`;
      seg = seg.slice(0, ff.index) + expanded + seg.slice(ff.index + ff[0].length);
    } else {
      seg = replaceOrInsertChild(seg, 'foreground', fgBlock, 'FRFont');
    }
  }
  // 背景色（Style 子级 <Background>）
  if (p.backgroundColor != null) {
    const argb = /^-?\d+$/.test(String(p.backgroundColor)) ? String(p.backgroundColor) : hexToArgb(p.backgroundColor);
    seg = replaceOrInsertChild(seg, 'Background', `<Background name="ColorBackground" color="${argb}"/>`, 'Style');
  }

  // 边框（Style 子级 <Border> 整块替换；无 Border 元素则新增到 </Style> 之前。
  // F6：此前全函数零 border 处理，patch.border 被静默丢弃却返回 updated（假成功）。
  // 非对象 border 直接抛错走 failed，不再假报 updated。）
  let borderApplied = false;
  if (p.border != null) {
    if (typeof p.border !== 'object' || Array.isArray(p.border)) {
      throw new Error('update_style: patch.border 必须是边框对象（{top,bottom,left,right,outerTop?,innerHorizontal?}，每边 {style 线型, color? #RRGGBB}）');
    }
    seg = replaceOrInsertChild(seg, 'Border', styleBorderBlockXml(p.border), 'Style');
    borderApplied = true;
  }

  // Style 开标签属性
  const styleMatch = seg.match(/<Style\b[^>]*>/);
  if (styleMatch) {
    let tag = styleMatch[0];
    const attrMap = { horizontalAlignment: 'horizontal_alignment', verticalAlignment: 'vertical_alignment', textStyle: 'textStyle', paddingLeft: 'paddingLeft', paddingRight: 'paddingRight', lineSpacing: 'lineSpacing', rotation: 'rotation' };
    for (const [k, xmlName] of Object.entries(attrMap)) {
      if (p[k] != null) tag = setAttr(tag, xmlName, p[k]);
    }
    seg = seg.slice(0, styleMatch.index) + tag + seg.slice(styleMatch.index + styleMatch[0].length);
  }

  const out = raw.slice(0, start) + seg + raw.slice(end);
  save(path, out);
  // changed 只报真实落盘键：border 未传（null/undefined）时不报；非法 border 已在上游抛错走 failed
  const changed = Object.keys(p).filter((k) => k !== 'border' || borderApplied);
  return { action: 'update_style', index: idx, changed, bytes: Buffer.byteLength(out, 'utf8') };
}

/** 生成 Style 子级 <Border> 整块（与 lib/generate.js styleBorderXml、lib/edits.js borderBlockXml 同构；
 * 刻意本地实现：edits.js 系多队并发热改文件，同文件争用风险高于双份漂移风险；形态一致性由本文件测试锁定
 *（test/style-border-batch.test.js F6-6：与 update_cell_style 落盘块逐字节对账，正版一变即转红，届时再同步）） */
function styleBorderBlockXml(border) {
  if (!border || typeof border !== 'object') return '<Border/>';
  const side = (tag, v) => {
    if (!v || typeof v !== 'object') return '';
    const style = v.style != null ? ` style="${escapeXmlAttr(String(v.style))}"` : '';
    if (v.color == null) return `<${tag}${style}/>`;
    return `<${tag}${style}>
<color>
<FineColor color="${hexToArgb(v.color)}" hor="-1" ver="-1"/>
</color>
</${tag}>`;
  };
  const tagOf = { top: 'Top', bottom: 'Bottom', left: 'Left', right: 'Right', outerTop: 'OuterTop', innerHorizontal: 'InnerHorizontal' };
  const parts = Object.keys(tagOf).filter((k) => border[k]).map((k) => side(tagOf[k], border[k])).join('\n');
  return parts ? `<Border>\n${parts}\n</Border>` : '<Border/>';
}

/** 替换 seg 内 <tagName> 子块；无则插入到 </closeTag> 之前 */
function replaceOrInsertChild(seg, tagName, newBlock, closeTag) {
  const openRe = new RegExp(`<${tagName}\\b[^>]*>`);
  const m = openRe.exec(seg);
  if (m) {
    const openTag = m[0];
    if (/\/\s*>$/.test(openTag)) {
      return seg.slice(0, m.index) + newBlock + seg.slice(m.index + openTag.length);
    }
    const close = seg.indexOf(`</${tagName}>`, m.index + openTag.length);
    if (close >= 0) {
      return seg.slice(0, m.index) + newBlock + seg.slice(close + `</${tagName}>`.length);
    }
  }
  const ct = seg.indexOf(`</${closeTag}>`);
  if (ct >= 0) return seg.slice(0, ct) + newBlock + '\n' + seg.slice(ct);
  return seg + '\n' + newBlock;
}

// ---- 5. 单元格（批增删改已有 batch_mutate_cells，此处只补批查） ----
export async function getCellBatch(path, targets) {
  const all = cells(path);
  return runBatch({
    items: targets, label: (x) => (x?.column != null ? `${x.column},${x.row}` : undefined), apply: (t) => {
      const c = Number(t?.column), r = Number(t?.row);
      const hit = all.find((x) => Number(x.column) === c && Number(x.row) === r && (t?.sheet === undefined || String(x.sheet) === String(t.sheet) || Number(x.sheetIndex) === Number(t.sheet)));
      return hit ? { status: 'read', target: `${c},${r}`, found: true, data: hit } : { status: 'skipped', target: `${c},${r}`, found: false };
    },
  });
}

// ---- 6. 填报绑定 ----
export async function addFillBindingBatch(path, items) {
  return runBatch({
    items, label: (x) => x?.field,
    apply: (it) => ({
      status: 'inserted', target: it?.field,
      ...addFillBinding(path, it?.submitIndex ?? 0, it?.field, it?.column, it?.row, it?.isKey ?? false, it?.sheet, it?.skipUnmodified === true),
    }),
  });
}
export async function deleteFillBindingBatch(path, targets) {
  return runBatch({
    items: targets, label: (x) => x?.field, apply: (t) => ({ status: 'deleted', target: t?.field, ...deleteFillBinding(path, t?.submitIndex ?? 0, t?.field, t?.sheet) }),
  });
}
export async function updateFillBindingBatch(path, items) {
  return runBatch({
    items, label: (x) => x?.target?.field, apply: (it) => {
      const t = it?.target ?? {}, p = it?.patch ?? {};
      return { status: 'updated', target: t.field, ...updateFillBinding(path, t.submitIndex ?? 0, t.field, p, t.sheet) };
    },
  });
}
export async function getFillBindingBatch(path, targets) {
  const submits = fillConfig(path)?.submits ?? [];
  const all = submits.flatMap((s) => (s.columns ?? []).map((c) => ({ submitIndex: s.index, sheet: s.sheet, ...c })));
  return runBatch({
    items: targets, label: (x) => x?.field, apply: (t) => {
      const hit = all.find((b) => Number(b.submitIndex) === Number(t?.submitIndex ?? 0) && String(b.field) === String(t?.field));
      return hit ? { status: 'read', target: t?.field, found: true, data: hit } : { status: 'skipped', target: t?.field, found: false };
    },
  });
}

// ---- 7. 填报提交 ----
export async function addFillSubmitBatch(path, items) {
  return runBatch({ items, label: (x) => x?.name, apply: (it) => ({ status: 'inserted', target: it?.name, ...addFillSubmit(path, it) }) });
}
export async function deleteFillSubmitBatch(path, targets) {
  return runBatch({
    items: targets, label: (x) => `submit#${x?.submitIndex ?? 0}`, apply: (t) => ({ status: 'deleted', target: t?.submitIndex ?? 0, ...deleteFillSubmit(path, t?.submitIndex ?? 0, t?.sheet) }),
  });
}
export async function updateFillSubmitBatch(path, items) {
  return runBatch({
    items, label: (x) => `submit#${x?.target?.submitIndex ?? 0}`, apply: (it) => {
      const t = it?.target ?? {}, p = it?.patch ?? {};
      return { status: 'updated', target: t.submitIndex ?? 0, ...updateFillSubmit(path, { submitIndex: t.submitIndex, sheet: t.sheet, ...p }) };
    },
  });
}
export async function getFillSubmitBatch(path, targets) {
  const submits = fillConfig(path)?.submits ?? [];
  return runBatch({
    items: targets, label: (x) => `submit#${x?.submitIndex ?? 0}`, apply: (t) => {
      const hit = submits.find((s) => Number(s.index) === Number(t?.submitIndex ?? 0));
      return hit ? { status: 'read', target: t?.submitIndex ?? 0, found: true, data: hit } : { status: 'skipped', target: t?.submitIndex ?? 0, found: false };
    },
  });
}

// ---- 8. 图表 ----
export async function addChartBatch(path, items) {
  return runBatch({ items, label: (x) => `${x?.column},${x?.row}`, apply: (it) => ({ status: 'inserted', target: `${it?.column},${it?.row}`, ...addChart(path, it) }) });
}
export async function deleteChartBatch(path, targets) {
  return runBatch({
    items: targets, label: (x) => `${x?.column},${x?.row}`, apply: (t) => ({ status: 'deleted', target: `${t?.column},${t?.row}`, ...deleteChart(path, t?.column, t?.row, t?.sheet) }),
  });
}
export async function updateChartBatch(path, items) {
  return runBatch({
    items, label: (x) => `${x?.target?.column},${x?.target?.row}`, apply: (it) => {
      const t = it?.target ?? {}, p = it?.patch ?? {};
      return { status: 'updated', target: `${t.column},${t.row}`, ...updateChart(path, { column: t.column, row: t.row, sheet: t.sheet, ...p }) };
    },
  });
}
export async function getChartBatch(path, targets) {
  return runBatch({
    items: targets, label: (x) => `${x?.column},${x?.row}`, apply: (t) => {
      try {
        const hit = getChart(path, { column: t?.column, row: t?.row, sheet: t?.sheet });
        return { status: 'read', target: `${t?.column},${t?.row}`, found: true, data: hit };
      } catch {
        return { status: 'skipped', target: `${t?.column},${t?.row}`, found: false };
      }
    },
  });
}

// ---- 9. 浮动元素 ----
export async function addFloatElementBatch(path, items) {
  return runBatch({ items, label: (x) => x?.name, apply: (it) => ({ status: 'inserted', target: it?.name, ...addFloatElement(path, it) }) });
}
export async function deleteFloatElementBatch(path, targets) {
  return runBatch({
    items: targets, label: (x) => x?.name, apply: (t) => ({ status: 'deleted', target: t?.name, ...deleteFloatElement(path, t?.name, t?.sheet) }),
  });
}
export async function updateFloatElementBatch(path, items) {
  return runBatch({
    items, label: (x) => x?.target?.name, apply: (it) => {
      const t = it?.target ?? {}, p = it?.patch ?? {};
      return { status: 'updated', target: t.name, ...updateFloatElement(path, { name: t.name, sheet: t.sheet, ...p }) };
    },
  });
}
export async function getFloatElementBatch(path, targets) {
  return runBatch({
    items: targets, label: (x) => x?.name, apply: (t) => {
      const hit = getFloatElement(path, { name: t?.name, sheet: t?.sheet });
      const one = hit?.floats?.find((f) => String(f.name) === String(t?.name)) ?? null;
      return one ? { status: 'read', target: t?.name, found: true, data: one } : { status: 'skipped', target: t?.name, found: false };
    },
  });
}

// ---- 10. 单元格超链接 ----
export async function addCellHyperlinkBatch(path, items) {
  return runBatch({ items, label: (x) => `${x?.column},${x?.row}`, apply: (it) => ({ status: 'inserted', target: `${it?.column},${it?.row}`, ...addCellHyperlink(path, it) }) });
}
export async function deleteCellHyperlinkBatch(path, targets) {
  return runBatch({
    items: targets, label: (x) => `${x?.column},${x?.row}`, apply: (t) => ({ status: 'deleted', target: `${t?.column},${t?.row}`, ...deleteCellHyperlink(path, t?.column, t?.row, { name: t?.name, sheet: t?.sheet }) }),
  });
}
export async function updateCellHyperlinkBatch(path, items) {
  return runBatch({
    items, label: (x) => `${x?.target?.column},${x?.target?.row}`, apply: (it) => {
      const t = it?.target ?? {}, p = it?.patch ?? {};
      return { status: 'updated', target: `${t.column},${t.row}`, ...updateCellHyperlink(path, t.column, t.row, { name: t.name, sheet: t.sheet, ...p }) };
    },
  });
}
export async function getCellHyperlinkBatch(path, targets) {
  return runBatch({
    items: targets, label: (x) => `${x?.column},${x?.row}`, apply: (t) => {
      const hit = getCellHyperlink(path, t?.column, t?.row, t?.sheet);
      return hit?.hasHyperlink ? { status: 'read', target: `${t?.column},${t?.row}`, found: true, data: hit } : { status: 'skipped', target: `${t?.column},${t?.row}`, found: false };
    },
  });
}

// ---- 11. 条件高亮 ----
export async function addCellHighlightBatch(path, items) {
  return runBatch({
    items, label: (x) => `${x?.column},${x?.row}`, apply: (it) => {
      const { column, row, sheet, ...rest } = it;
      return { status: 'inserted', target: `${column},${row}`, ...addCellHighlight(path, { column, row, sheet, ...rest }) };
    },
  });
}
export async function deleteCellHighlightBatch(path, targets) {
  return runBatch({
    items: targets, label: (x) => `${x?.column},${x?.row}`, apply: (t) => ({ status: 'deleted', target: `${t?.column},${t?.row}`, ...deleteCellHighlight(path, t?.column, t?.row, { formula: t?.formula, sheet: t?.sheet }) }),
  });
}
export async function updateCellHighlightBatch(path, items) {
  return runBatch({
    items, label: (x) => `${x?.target?.column},${x?.target?.row}`, apply: (it) => {
      const t = it?.target ?? {}, p = it?.patch ?? {};
      return { status: 'updated', target: `${t.column},${t.row}`, ...updateCellHighlight(path, { ...t, ...p }) };
    },
  });
}
export async function getCellHighlightBatch(path, targets) {
  return runBatch({
    items: targets, label: (x) => `${x?.column},${x?.row}`, apply: (t) => {
      const hit = getCellHighlight(path, t?.column, t?.row, { sheet: t?.sheet });
      return hit?.hasHighlight ? { status: 'read', target: `${t?.column},${t?.row}`, found: true, data: hit } : { status: 'skipped', target: `${t?.column},${t?.row}`, found: false };
    },
  });
}

// ---- 12. 单元格控件监听（批增已有 add_cell_listener_batch，此处补批删/改/查） ----
export async function deleteCellListenerBatch(path, targets) {
  return runBatch({
    items: targets, label: (x) => `${x?.column},${x?.row}`, apply: (t) => ({ status: 'deleted', target: `${t?.column},${t?.row}`, ...deleteCellListener(path, t?.column, t?.row, { event: t?.event, match: t?.match, sheet: t?.sheet }) }),
  });
}
export async function updateCellListenerBatch(path, items) {
  return runBatch({
    items, label: (x) => `${x?.target?.column},${x?.target?.row}`, apply: (it) => {
      const t = it?.target ?? {}, p = it?.patch ?? {};
      return { status: 'updated', target: `${t.column},${t.row}`, ...updateCellListener(path, t.column, t.row, { event: t.event, match: t.match, sheet: t.sheet, ...p }) };
    },
  });
}
export async function getCellListenerBatch(path, targets) {
  return runBatch({
    items: targets, label: (x) => `${x?.column},${x?.row}`, apply: (t) => {
      const hit = getCellListener(path, t?.column, t?.row, { event: t?.event, sheet: t?.sheet });
      return hit?.count > 0 ? { status: 'read', target: `${t?.column},${t?.row}`, found: true, data: hit } : { status: 'skipped', target: `${t?.column},${t?.row}`, found: false };
    },
  });
}

// ---- 13. 报表事件 Listener（报表JS 事件） ----
export async function addReportListenerBatch(path, items) {
  return runBatch({ items, label: (x) => x?.event, apply: (it) => ({ status: 'inserted', target: it?.event, ...setReportListener(path, it) }) });
}
export async function deleteReportListenerBatch(path, targets) {
  return runBatch({
    items: targets, label: (x) => x?.event, apply: (t) => ({ status: 'deleted', target: t?.event, ...setReportListener(path, { event: t?.event, sheet: t?.sheet, match: t?.match }) }),
  });
}
export async function updateReportListenerBatch(path, items) {
  return runBatch({
    items, label: (x) => x?.target?.event, apply: (it) => {
      const t = it?.target ?? {}, p = it?.patch ?? {};
      return { status: 'updated', target: t.event, ...setReportListener(path, { event: t.event, sheet: t.sheet, match: t.match, ...p }) };
    },
  });
}
export async function getReportListenerBatch(path, targets) {
  return runBatch({
    items: targets, label: (x) => x?.event, apply: (t) => {
      const hit = getReportListener(path, { event: t?.event, sheet: t?.sheet });
      return hit?.listeners?.length > 0 ? { status: 'read', target: t?.event, found: true, data: hit } : { status: 'skipped', target: t?.event, found: false };
    },
  });
}

/** get_report_listener：只读 Report 块内 <Listener event="..."> 的 JS（onload/afterload 等） */
function getReportListener(path, { event, sheet } = {}) {
  const { raw } = load(path);
  const blocks = sheetBlocks(raw);
  const occ = sheet == null ? 0 : locateSheet(raw, sheet).index;
  const lo = blocks[occ]?.start ?? 0, hi = blocks[occ]?.end ?? raw.length;
  const seg = raw.slice(lo, hi);
  const listeners = [];
  const re = /<Listener\s+event="([^"]*)"[^>]*>[\s\S]*?<JavaScript\s+class="([^"]*)">[\s\S]*?<Content>\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*<\/Content>[\s\S]*?<\/Listener>/g;
  let m;
  while ((m = re.exec(seg)) !== null) {
    if (event && m[1] !== String(event)) continue;
    listeners.push({ event: m[1], className: m[2], js: m[3] });
  }
  // C-B：批量读出口同样要带设计器转义元数据（`]A` 不是污染，别据此删改）
  const designerEscapes = aggregateDesignerEscapes(listeners.map((l) => l.js));
  return {
    sheet: occ, event: event ?? null, listeners, count: listeners.length,
    ...(designerEscapes ? { designerEscapes } : {}),
  };
}

// ---- 14. 工具栏按钮 ----
export async function addToolbarButtonBatch(path, items) {
  return runBatch({ items, label: (x) => x?.buttonText, apply: (it) => ({ status: 'inserted', target: it?.buttonText, ...addToolbarButton(path, it) }) });
}
export async function deleteToolbarButtonBatch(path, targets) {
  return runBatch({
    items: targets, label: (x) => x?.buttonText ?? `#${x?.index}`, apply: (t) => ({ status: 'deleted', target: t?.buttonText ?? t?.index, ...deleteToolbarButton(path, t) }),
  });
}
export async function updateToolbarButtonBatch(path, items) {
  return runBatch({
    items, label: (x) => x?.target?.buttonText ?? `#${x?.target?.index}`, apply: (it) => {
      const t = it?.target ?? {}, p = it?.patch ?? {};
      if (p.js === undefined && p.iconName === undefined) {
        throw new Error('update_toolbar_button_batch: patch 必须至少提供 js 或 iconName 之一（空 patch 无改动字段）');
      }
      let result = { status: 'updated', target: t.buttonText ?? t.index };
      if (p.js !== undefined) result = { ...result, ...setToolbarButtonJs(path, { buttonText: t.buttonText, index: t.index, match: t.match, js: p.js, className: p.className }) };
      if (p.iconName !== undefined) result = { ...result, ...setToolbarButtonIcon(path, { buttonText: t.buttonText, index: t.index, match: t.match, iconName: p.iconName }) };
      return result;
    },
  });
}
export async function getToolbarButtonBatch(path, targets) {
  const buttons = listToolbarButtons(path)?.buttons ?? [];
  // 2026-10-27 审查修复：targets 漏传不再报 expected array —— 省略/空数组 = 读全部按钮
  const list = Array.isArray(targets) && targets.length > 0 ? targets : buttons.map((_, i) => ({ index: i }));
  return runBatch({
    items: list, label: (x) => x?.buttonText ?? `#${x?.index}`, apply: (t) => {
      const hit = t?.index != null
        ? buttons[Number(t.index)]
        : buttons.find((b) => b?.text === t?.buttonText || b?.buttonText === t?.buttonText);
      return hit ? { status: 'read', target: t?.buttonText ?? t?.index, found: true, data: hit } : { status: 'skipped', target: t?.buttonText ?? t?.index, found: false };
    },
  });
}

// ---- 15. 单元格扩展后排序 ----
export async function addCellSortBatch(path, items) {
  return runBatch({
    items, label: (x) => `${x?.column},${x?.row}`, apply: (it) => {
      if (!Array.isArray(it?.sort) || it.sort.length === 0) throw new Error('add_cell_sort: sort 必须是非空规则数组');
      return { status: 'inserted', target: `${it?.column},${it?.row}`, ...updateCellSort(path, it) };
    },
  });
}
export async function deleteCellSortBatch(path, targets) {
  return runBatch({
    items: targets, label: (x) => `${x?.column},${x?.row}`, apply: (t) => ({ status: 'deleted', target: `${t?.column},${t?.row}`, ...deleteCellSort(path, { column: t?.column, row: t?.row, sheet: t?.sheet }) }),
  });
}
export async function updateCellSortBatch(path, items) {
  return runBatch({
    items, label: (x) => `${x?.target?.column},${x?.target?.row}`, apply: (it) => {
      const t = it?.target ?? {}, p = it?.patch ?? {};
      return { status: 'updated', target: `${t.column},${t.row}`, ...updateCellSort(path, { column: t.column, row: t.row, sheet: t.sheet, sort: p.sort }) };
    },
  });
}
export async function getCellSortBatch(path, targets) {
  return runBatch({
    items: targets, label: (x) => `${x?.column},${x?.row}`, apply: (t) => {
      const hit = getCellSort(path, { column: t?.column, row: t?.row, sheet: t?.sheet });
      return hit?.hasSort ? { status: 'read', target: `${t?.column},${t?.row}`, found: true, data: hit } : { status: 'skipped', target: `${t?.column},${t?.row}`, found: false };
    },
  });
}

// ---- 16. 定时任务 ----
export async function addScheduleBatch(path, items) {
  return runBatch({
    items, label: (x) => x?.note ?? x?.action, apply: async (it) => {
      const r = await addTask(path, it);
      return { status: 'inserted', target: r?.id, ...r };
    },
  });
}
export async function deleteScheduleBatch(path, targets) {
  return runBatch({
    items: targets, label: (x) => x?.taskId, apply: async (t) => ({ status: 'deleted', target: t?.taskId, ...(await removeTask(path, t?.taskId)) }),
  });
}
export async function updateScheduleBatch(path, items) {
  return runBatch({
    items, label: (x) => x?.target?.taskId, apply: async (it) => {
      const t = it?.target ?? {}, p = it?.patch ?? {};
      if (p.enabled != null) {
        const r = p.enabled ? await enableTask(path, t.taskId) : await disableTask(path, t.taskId);
        return { status: 'updated', target: t.taskId, enabled: p.enabled, ...r };
      }
      throw new Error('update_schedule: patch.enabled 必填（boolean）');
    },
  });
}
export async function getScheduleBatch(path, targets) {
  return runBatch({
    items: targets, label: (x) => x?.taskId, apply: async (t) => {
      const taskId = t?.taskId;
      // 缺 taskId / 未找到目标 → skipped（跳过），不记 failed
      if (taskId == null || String(taskId).trim() === '') {
        return { status: 'skipped', target: taskId, found: false };
      }
      try {
        const data = await getTask(path, taskId);
        return { status: 'read', target: taskId, found: true, data };
      } catch (e) {
        if (/任务不存在/.test(e.message)) return { status: 'skipped', target: taskId, found: false };
        throw e;
      }
    },
  });
}

// ---- 17. 工作表 ----
export async function addSheetBatch(path, items) {
  return runBatch({ items, label: (x) => x?.sheetName, apply: (it) => ({ status: 'inserted', target: it?.sheetName, ...addSheet(path, it) }) });
}
export async function deleteSheetBatch(path, targets) {
  return runBatch({
    items: targets, label: (x) => x?.sheet, apply: (t) => ({ status: 'deleted', target: t?.sheet, ...deleteSheet(path, t?.sheet) }),
  });
}
export async function updateSheetBatch(path, items) {
  return runBatch({
    items, label: (x) => x?.target?.sheet, apply: (it) => {
      const t = it?.target ?? {}, p = it?.patch ?? {};
      return { status: 'updated', target: t.sheet, ...updateSheet(path, { sheet: t.sheet, newName: p.newName }) };
    },
  });
}
export async function getSheetBatch(path, targets) {
  const sheets = overview(path).sheets ?? [];
  const grids = gridSizes(path);
  return runBatch({
    items: targets, label: (x) => x?.sheet, apply: (t) => {
      const idx = typeof t?.sheet === 'number' ? t.sheet : sheets.findIndex((n) => String(n) === String(t?.sheet));
      if (idx < 0 || idx >= sheets.length) return { status: 'skipped', target: t?.sheet, found: false };
      return { status: 'read', target: sheets[idx], found: true, data: { sheet: sheets[idx], sheetIndex: idx, ...(grids[idx] ?? {}) } };
    },
  });
}

// ---- 18. 页眉页脚 ----
export async function addPageHeaderFooterBatch(path, items) {
  return runBatch({ items, label: (x) => x?.sheet ?? 0, apply: (it) => ({ status: 'inserted', target: it?.sheet ?? 0, ...setPageHeaderFooter(path, it) }) });
}
export async function deletePageHeaderFooterBatch(path, targets) {
  return runBatch({
    items: targets, label: (x) => `${x?.which}@${x?.sheet ?? 0}`, apply: (t) => ({ status: 'deleted', target: t?.which, ...deletePageHeaderFooter(path, { which: t?.which, sheet: t?.sheet }) }),
  });
}
export async function updatePageHeaderFooterBatch(path, items) {
  return runBatch({
    items, label: (x) => x?.target?.sheet ?? 0, apply: (it) => {
      const t = it?.target ?? {}, p = it?.patch ?? {};
      return { status: 'updated', target: t.sheet ?? 0, ...setPageHeaderFooter(path, { sheet: t.sheet, ...p }) };
    },
  });
}
export async function getPageHeaderFooterBatch(path, targets) {
  return runBatch({
    items: targets, label: (x) => x?.sheet ?? 0, apply: (t) => {
      const hit = getPageHeaderFooter(path, { sheet: t?.sheet });
      return hit ? { status: 'read', target: t?.sheet ?? 0, found: true, data: hit } : { status: 'skipped', target: t?.sheet ?? 0, found: false };
    },
  });
}

/** get_page_header_footer：只读 ReportAttrSet 内 <Header>/<Footer> 三区内容 */
function getPageHeaderFooter(path, { sheet } = {}) {
  const { raw } = load(path);
  const attrStarts = findAllSafe(raw, '<ReportAttrSet>');
  if (attrStarts.length === 0) return null;
  const occ = sheet == null ? 0 : locateSheet(raw, sheet).index;
  const aStart = attrStarts[occ];
  if (aStart == null) return null;
  const block = sliceBlock(raw, aStart, '<ReportAttrSet>', '</ReportAttrSet>');
  const section = (tag) => {
    const open = block.match(new RegExp(`<${tag}\\b[^>]*>`));
    if (!open) return null;
    const openTag = open[0];
    if (/\/\s*>$/.test(openTag)) return { present: true, empty: true };
    const close = block.indexOf(`</${tag}>`, open.index + openTag.length);
    const inner = close >= 0 ? block.slice(open.index + openTag.length, close) : block.slice(open.index + openTag.length);
    return { present: true, empty: !inner.includes('CDATA'), left: cdataSection(inner, 'Left'), center: cdataSection(inner, 'Center'), right: cdataSection(inner, 'Right') };
  };
  return { sheet: occ, header: section('Header'), footer: section('Footer') };
}
function cdataSection(inner, name) {
  const m = inner.match(new RegExp(`<${name}>[\\s\\S]*?<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>[\\s\\S]*?<\\/${name}>`));
  return m ? m[1] : null;
}
function findAllSafe(raw, needle) {
  const out = []; let i = 0;
  while ((i = raw.indexOf(needle, i)) >= 0) { out.push(i); i += needle.length; }
  return out;
}
function sliceBlock(raw, start, openTag, closeTag) {
  const end = raw.indexOf(closeTag, start);
  return end >= 0 ? raw.slice(start, end + closeTag.length) : raw.slice(start);
}
