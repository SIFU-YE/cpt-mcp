// cpt-mcp/lib/widget-types.js —— 参数面板控件 type 别名归一（2026-11-05 第二轮会话缺口）
//
// 背景（sandbox4 report 会话实测）：模型按其它框架的直觉传 type:"textEditor"，
// add_parameter_widget 直接被 schema 枚举拒成 "Invalid option: expected one of
// comboBox|comboCheckBox|text|date|checkBox|label|submitButton"，一次失败就是一轮往返。
// 这些是**语义等价**的写法（都指文本框/下拉/多选/日期/按钮），归一后行为不变。
//
// 约束：
//   · 只收敛到 FR 官方 7 种控件类型；拿不准的（radio/password/…）不猜，交给 schema 报错；
//   · 大小写/空格/下划线/连字符不敏感（textEditor / text_editor / Text-Editor 都能归一）；
//   · 单一事实源：server.js 的参数归一（lib/arg-normalize.js）与 lib/generate.js 的
//     addParameterWidget（batch 路径不经过 server 归一）都调用本模块，避免两处漂移。
export const WIDGET_TYPE_ALIASES = Object.freeze({
  // 文本框
  text: 'text',
  texteditor: 'text',
  textarea: 'textarea',
  textbox: 'text',
  textfield: 'text',
  input: 'text',
  string: 'text',
  // 下拉
  combobox: 'comboBox',
  combo: 'comboBox',
  select: 'comboBox',
  dropdown: 'comboBox',
  choice: 'comboBox',
  // 下拉多选
  combocheckbox: 'comboCheckBox',
  comboboxcheckbox: 'comboCheckBox',
  multiselect: 'comboCheckBox',
  multicombobox: 'comboCheckBox',
  multi: 'comboCheckBox',
  // 复选
  checkbox: 'checkBox',
  // 日期
  date: 'date',
  datepicker: 'date',
  // 标签
  label: 'label',
  // 查询按钮
  submitbutton: 'submitButton',
  button: 'submitButton',
  submit: 'submitButton',
});
// 官方枚举（用于判断"归一结果是否本就要改"）
const OFFICIAL = new Set(['comboBox', 'comboCheckBox', 'text', 'textarea', 'date', 'checkBox', 'label', 'submitButton']);

/** 归一 key：小写 + 去掉空格/下划线/连字符（text_editor / Text-Editor → texteditor） */
function aliasKey(type) {
  return String(type ?? '').trim().toLowerCase().replace(/[\s_-]+/g, '');
}

/**
 * 把模型语感写法归一到 FR 官方控件类型。
 * @param {string} type 原始 type（可为空/非字符串）
 * @returns {{type:string, changed:boolean, input:string}} 未知写法原样返回（changed=false）
 */
export function canonicalWidgetType(type) {
  const input = String(type ?? '');
  if (OFFICIAL.has(input)) return { type: input, changed: false, input };
  const mapped = WIDGET_TYPE_ALIASES[aliasKey(input)];
  if (mapped && OFFICIAL.has(mapped)) return { type: mapped, changed: mapped !== input, input };
  return { type: input, changed: false, input };
}
