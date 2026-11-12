// cpt-mcp/lib/engine/rules.js
// 微型报表引擎 —— 规则/常量层
// 数据来源：从 FineReport 11.0 设计器拆解所得（合规静态提取，不反编译字节码）：
//   - webapps/webroot/WEB-INF/lib/fine-report-engine-11.0.jar 内 com/fr/base/theme/*.xml
//     的主题化样式语义（ThemedCellStyle 7 角色 / FRFont / Style / Border / FineColor / Background）+ 真实 cpt 样本校准。
// 单位与量纲（已经真实样本校准）：
//   - 长度 1mm = 144000（行高/列宽/纸张/边距通用）
//   - FRFont size = pt * 4（Demo.cpt 样式0：size=72 -> 18pt）
//   - FineColor color 为 ARGB 有符号 int（-4144960 -> #C0C0C0；-16777216 -> 黑色；-1 -> 白色）

export const MM_TO_UNIT = 144000;



// 控件 class 白名单，用于合理性审查：区分「内置控件」与「自定义/插件控件」。
//
// M106 校正：此前名单只有 generate.js widgetXml 的 9 项，且与实现脱节两处 ——
//   ① 漏 com.fr.form.ui.NumberEditor（widgetXml 的 case 'number' 就是它；官方第一大控件类）
//   ② submit 写成 ...write.SubmitButton，而 widgetXml 实际 emit ...write.Submit
// 后果：任何用数字控件/提交按钮的模板（含本仓库自己生成的成品）都被误报"不在内置白名单"。
// 现以本机 FR 11.0 官方 1550 份模板的**单元格控件类实测**为基准补齐（类名 → 出现次数）：
//   NumberEditor 3740 / TextEditor 1299 / ComboBox 223 / FreeButton 91 / DateEditor 81 / CheckBox 66 /
//   AppendRowButton 42 / DeleteRowButton 42 / RadioGroup 34 / TreeNodeToggleButton 27 / TextArea 27 /
//   MultiFileEditor 22 / IframeEditor 16 / CheckBoxGroup 10 / ComboCheckBox 9 / ComboBox(web) 8 /
//   NumberEditor(web) 8 / FormSubmitButton 8 / TreeComboBoxEditor 7 / TreeNodeToogleButton 6（官方拼写如此）/
//   TextEditor(web) 5 / AppendRowButton(web) 4 / DeleteRowButton(web) 4 / DateEditor(web) 3 /
//   TreeEditor 3 / Password 2 / CheckBox(web) 1 / ComboCheckBox(web) 1
// 只做加法：保留历史项（SubmitButton / AppendColumnRow 等工具链自有形态），名单是「内置」超集。
export const WIDGET_CLASSES = new Set([
  // 表单控件（form.ui）
  'com.fr.form.ui.TextEditor',
  'com.fr.form.ui.NumberEditor',
  'com.fr.form.ui.TextArea',
  'com.fr.form.ui.DateEditor',
  'com.fr.form.ui.ComboBox',
  'com.fr.form.ui.ComboCheckBox',
  'com.fr.form.ui.CheckBox',
  'com.fr.form.ui.CheckBoxGroup',
  'com.fr.form.ui.RadioGroup',
  'com.fr.form.ui.Label',
  'com.fr.form.ui.FreeButton',
  'com.fr.form.ui.Password',
  'com.fr.form.ui.MultiFileEditor',
  'com.fr.form.ui.IframeEditor',
  'com.fr.form.ui.TreeEditor',
  'com.fr.form.ui.TreeComboBoxEditor',
  // 写入工具栏类按钮（作单元格控件）
  'com.fr.report.web.button.write.Submit',
  'com.fr.report.web.button.write.SubmitButton',
  'com.fr.report.web.button.write.AppendColumnRow',
  'com.fr.report.web.button.write.AppendRowButton',
  'com.fr.report.web.button.write.DeleteRowButton',
  'com.fr.report.web.button.form.TreeNodeToggleButton',
  'com.fr.report.web.button.form.TreeNodeToogleButton',
  // 参数面板（web.ui）变体
  'com.fr.report.web.ui.TextEditor',
  'com.fr.report.web.ui.NumberEditor',
  'com.fr.report.web.ui.DateEditor',
  'com.fr.report.web.ui.ComboBox',
  'com.fr.report.web.ui.ComboCheckBox',
  'com.fr.report.web.ui.CheckBox',
  'com.fr.report.web.ui.impl.form.FormSubmitButton',
  'com.fr.report.web.ui.impl.write.AppendRowButton',
  'com.fr.report.web.ui.impl.write.DeleteRowButton',
]);
// 由 class 反推语义名
export const WIDGET_CLASS_TO_KIND = {
  'com.fr.form.ui.TextEditor': 'text',
  'com.fr.form.ui.NumberEditor': 'number',
  'com.fr.form.ui.TextArea': 'textarea',
  'com.fr.form.ui.DateEditor': 'date',
  'com.fr.form.ui.ComboBox': 'comboBox',
  'com.fr.form.ui.ComboCheckBox': 'comboCheckBox',
  'com.fr.form.ui.CheckBox': 'checkBox',
  'com.fr.form.ui.CheckBoxGroup': 'checkBoxGroup',
  'com.fr.form.ui.RadioGroup': 'radioGroup',
  'com.fr.form.ui.Label': 'label',
  'com.fr.form.ui.FreeButton': 'freeButton',
  'com.fr.form.ui.Password': 'password',
  'com.fr.form.ui.MultiFileEditor': 'multiFile',
  'com.fr.form.ui.IframeEditor': 'iframe',
  'com.fr.form.ui.TreeEditor': 'treeEditor',
  'com.fr.form.ui.TreeComboBoxEditor': 'treeComboBox',
  'com.fr.report.web.button.write.Submit': 'submit',
  'com.fr.report.web.button.write.SubmitButton': 'submit',
  'com.fr.report.web.button.write.AppendColumnRow': 'appendRow',
  'com.fr.report.web.button.write.AppendRowButton': 'appendRow',
  'com.fr.report.web.button.write.DeleteRowButton': 'deleteRow',
  'com.fr.report.web.button.form.TreeNodeToggleButton': 'treeNodeToggle',
  'com.fr.report.web.button.form.TreeNodeToogleButton': 'treeNodeToggle',
  'com.fr.report.web.ui.TextEditor': 'text',
  'com.fr.report.web.ui.NumberEditor': 'number',
  'com.fr.report.web.ui.DateEditor': 'date',
  'com.fr.report.web.ui.ComboBox': 'comboBox',
  'com.fr.report.web.ui.ComboCheckBox': 'comboCheckBox',
  'com.fr.report.web.ui.CheckBox': 'checkBox',
  'com.fr.report.web.ui.impl.form.FormSubmitButton': 'submit',
  'com.fr.report.web.ui.impl.write.AppendRowButton': 'appendRow',
  'com.fr.report.web.ui.impl.write.DeleteRowButton': 'deleteRow',
};

// 合理/常用的行标题列标题 font size 边界；来自主题 XML 观察（72/4=18pt 正文标题、128/4=32pt 大标题）
export const FONT_RANGE = { minPt: 6, maxPt: 200 };       // 设计器硬边界
export const FONT_REASONABLE = { minPt: 8, maxPt: 48 };     // 合理性审查建议区间

// ---- 生成默认行高规则（单位制：1mm=144000；与 sandbox2 成品模板"表头9mm/数据7mm"一致）----
// ---- 设计令牌（P0-2：生成效果的单一事实源）----
// 字号阶 / 行高阶 / 列宽阶全部集中于此；smart.js / builder.js 的布局决策只允许引用令牌，
// 禁止散落魔法数字 —— 改一处全局生效，且 golden 快照会锁定任何漂移。
export const DESIGN_TOKENS = {
  fontPt: { title: 18, header: 14, data: 14, summary: 14 },
  rowHeightMm: { title: 14, header: 9, data: 7, summary: 7 },
  colWidthMm: { text: 32, number: 20, money: 24, percent: 18, date: 28, datetime: 40 },
  // FR 骨架默认网格（create_cpt 的空模板行高/列宽；5.03mm / 19.05mm）
  frDefault: { rowHeight: 723900, colWidth: 2743200 },
};

export const HEADER_ROW_H_UNIT = DESIGN_TOKENS.rowHeightMm.header * MM_TO_UNIT; // 1296000（表头 9mm）
export const DATA_ROW_H_UNIT = DESIGN_TOKENS.rowHeightMm.data * MM_TO_UNIT;     // 1008000（数据 7mm）

// ---- 对齐常量（P0-2：由 FR 11.0 官方 1559 样本全量统计反推，纠正此前"1/2/3/4 以设计器为准"的模糊描述）----
// 水平对齐 horizontal_alignment：官方样本仅出现 0/2/4/6，与 java SwingConstants 一致：
//   0=CENTER 居中(3328次,76.7%) —— 且关联 style_name 全为 Head/表头/大标题/正文，佐证"居中"
//   2=LEFT   左对齐(736次)       —— 文本列
//   4=RIGHT  右对齐(258次)       —— 数字/金额列
//   6=两端对齐(1次，极罕见)
//   注意：1/3/5 在 1559 个官方样本中【零出现】，传入会让设计器走未知分支
export const HORIZONTAL_ALIGNMENT = { 0: '居中', 2: '左对齐', 4: '右对齐', 6: '两端对齐' };
// 垂直对齐 vertical_alignment：官方样本仅出现 1(靠上)/3(靠下)，0=居中为默认值(省略不写)
export const VERTICAL_ALIGNMENT = { 0: '居中', 1: '靠上', 3: '靠下' };

// 模型友好别名：LLM 常按其他库的习惯传字符串枚举（'center'/'left'/'right'），
// 旧实现会原样写出 horizontal_alignment="center" 这种设计器无法解析的非法值，故在此统一归一化。
const H_ALIGN_ALIAS = {
  center: 0, middle: 0, '居中': 0,
  left: 2, '左': 2, '左对齐': 2,
  right: 4, '右': 4, '右对齐': 4,
  justify: 6, both: 6, '两端对齐': 6, '分散对齐': 6,
};
const V_ALIGN_ALIAS = {
  center: 0, middle: 0, '居中': 0,
  top: 1, up: 1, '靠上': 1, '上': 1,
  bottom: 3, down: 3, '靠下': 3, '下': 3,
};

/**
 * 校验水平对齐取值并归一化为数字（安全围栏）。
 * 同时拦截两类跑偏：① 官方样本中不存在的 1/3/5；② 字符串枚举（旧版会写出非法 XML 值）。
 * @returns {number|undefined} 归一化后的合法取值（0/2/4/6）
 */
export function assertHorizontalAlignment(v) {
  if (v == null || v === '') return undefined;
  if (typeof v === 'string' && !/^-?\d+$/.test(v.trim())) {
    const mapped = H_ALIGN_ALIAS[v.trim().toLowerCase()];
    if (mapped == null) {
      throw new Error(
        `horizontalAlignment="${v}" 无法识别。请使用数字 0=居中 / 2=左对齐 / 4=右对齐 / 6=两端对齐，` +
        `或字符串别名 "center" / "left" / "right" / "justify"（不区分大小写，也支持中文"居中"/"左"/"右"）。` +
        `注意：FR 官方 1559 个样本中仅出现 0/2/4/6，传 1/3/5 设计器无法识别。`
      );
    }
    return mapped;
  }
  const n = Number(v);
  if (!Object.hasOwn(HORIZONTAL_ALIGNMENT, String(n))) {
    throw new Error(
      `horizontalAlignment=${v} 非法：FR 官方 1559 个样本中仅出现 0 / 2 / 4 / 6。` +
      `0=居中（76.7%，表头/标题/数据默认，官方样本中 Head/表头/大标题 样式均为 0）、2=左对齐（文本列）、4=右对齐（数字/金额列）、6=两端对齐（极罕见）。` +
      `请勿传 1/3/5 —— 这些值在官方样本中零出现。`
    );
  }
  return n;
}

/**
 * 校验垂直对齐取值并归一化为数字（官方样本仅 0/1/3）。
 * @returns {number|undefined}
 */
export function assertVerticalAlignment(v) {
  if (v == null || v === '') return undefined;
  if (typeof v === 'string' && !/^-?\d+$/.test(v.trim())) {
    const mapped = V_ALIGN_ALIAS[v.trim().toLowerCase()];
    if (mapped == null) {
      throw new Error(
        `verticalAlignment="${v}" 无法识别。请使用数字 0=居中 / 1=靠上 / 3=靠下，` +
        `或字符串别名 "center" / "top" / "bottom"（也支持中文"居中"/"靠上"/"靠下"）。`
      );
    }
    return mapped;
  }
  const n = Number(v);
  if (!Object.hasOwn(VERTICAL_ALIGNMENT, String(n))) {
    throw new Error(
      `verticalAlignment=${v} 非法：FR 官方样本中仅出现 0 / 1 / 3（0=居中，为默认值通常省略不写；1=靠上；3=靠下）。`
    );
  }
  return n;
}

// 常见字体白名单（FineReport 内置 + Windows/设计器常见），作为“推荐性”提示依据而非硬性报错
export const KNOWN_FONTS = new Set([
  '宋体', 'SimSun', '微软雅黑', 'Microsoft YaHei', '黑体', 'SimHei',
  'Arial', 'Verdana', 'Tahoma', 'Times New Roman', 'Calibri', 'Segoe UI',
  'Heiti SC', 'PingFang SC', 'Hiragino Sans GB', 'Source Han Sans CN', 'Noto Sans CJK SC',
]);

// 纸张预设（mm）
export const PAPER_PRESETS = {
  A4: { w: 210, h: 297 }, A3: { w: 297, h: 420 }, A5: { w: 148, h: 210 },
  B4: { w: 250, h: 353 }, B5: { w: 176, h: 250 },
};

// 单元格样式单点共享上限：超过则提示“改一处影响全表”
export const STYLE_SHARE_WARN_COUNT = 40;


// ---- 颜色工具（ARGB 有符号 int <-> #RRGGBB）----

/** ARGB 有符号 int -> #RRGGBB */
export function argbToHex(argb) {
  const v = (Number(argb) >>> 0) & 0xffffff;
  return '#' + v.toString(16).padStart(6, '0').toUpperCase();
}

/** #RRGGBB / #RGB -> ARGB 有符号 int（FF alpha）。
 *  2026-10-29 整理：与 lib/edits.js、lib/cpt.js 的重复实现合一；
 *  取 edits 的严格口径（非法颜色直接抛错，写侧不会静默写成 0），并兼容 3 位简写。 */
export function hexToArgb(hex) {
  const m = String(hex ?? '').trim().match(/^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/);
  if (!m) throw new Error(`非法颜色 "${hex}"：请用 #RRGGBB 格式`);
  const h = m[1].length === 3 ? m[1].split('').map((c) => c + c).join('') : m[1];
  const argb = (0xff000000 | parseInt(h, 16)) | 0; // -> 32 位有符号
  return String(argb);
}

/** 解析 #RRGGBB 为 {r,g,b} 0-255 */
export function parseHex(hex) {
  const h = String(hex).replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const n = parseInt(full, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

/** WCAG 相对亮度 0-1 */
export function relLuminance(rgb) {
  const f = (c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(rgb.r) + 0.7152 * f(rgb.g) + 0.0722 * f(rgb.b);
}

/** WCAG 对比度 1-21 */
export function contrastRatio(c1, c2) {
  const l1 = relLuminance(c1), l2 = relLuminance(c2);
  const [hi, lo] = l1 >= l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

// ---- 尺寸换算 ----
export const mmToUnit = (mm) => Math.round(Number(mm) * MM_TO_UNIT);
// 舍入口径与旧 edits/src 读侧保持一致：正负值都按十进制 toFixed(3) 半舍入，
// 避免 Math.round 对负半值向 +∞ 取整导致的 0.001mm 漂移（实测 40001 个整数单位里 139 个负值差 0.001）。
export const unitToMm = (u) => +(Number(u) / MM_TO_UNIT).toFixed(3);

/**
 * 文本显示宽度估算（mm）—— 列宽自适应用。
 * 中文/全角字符按 1em 计、半角按 0.5em，pt→mm 换算后加 6mm 内边距。
 * 例：14pt 下"年度销售额完成情况"(9 全角) ≈ 52.7mm，超过 money 列默认 24mm → 自动加宽。
 */
export function estimateTextWidthMm(text, fontPt) {
  const emMm = Number(fontPt) * 0.3528 * 1.05;
  let units = 0;
  for (const ch of String(text ?? '')) units += ch.charCodeAt(0) > 255 ? 1 : 0.5;
  return Math.round((units * emMm + 6) * 10) / 10;
}
