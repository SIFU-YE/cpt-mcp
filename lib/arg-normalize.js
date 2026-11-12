// cpt-mcp/lib/arg-normalize.js —— 参数别名归一 + 合法键提示（2026-10-26）
//
// 背景（v1 会话实测）：工具 schema 是 zod .strict()，模型按语义直觉传参
// （text / name / condition / effects / title / width / marginTop / invisible / valueField…）
// 会被 MCP 层直接拒成 "Unrecognized key"，且不告诉它正确字段名 —— 27 次硬失败里 17 次属此类，
// 每次失败就是一轮模型往返。本模块把"可预测的误用"在进 schema 前纠正掉，并回报纠正清单；
// 真正无法纠正的未知键，由 server.js 的 formatArgIssues 附上该处合法字段名。
//
// 设计约束：
//   · 只做"语义等价"的归一，不做猜测性改写；拿不准的一律不碰（宁可报错也不要静默跑偏）。
//   · 归一结果与纠正说明一起返回，调用方把说明附在工具返回体尾部 —— 模型下一轮就能学到规范名。
//   · 与 schema 形状结合：Xxx → XxxMm 这类后缀差异按 schema 实际字段推断，不硬编码单位表。
import { z } from 'zod';
import { canonicalWidgetType } from './widget-types.js';

/**
 * 从 zod schema 里取 object 的字段表（穿透 optional/default/nullable/effects/catch/array 包装）。
 * 也接受"裸字段表"（z.object(raw) 里的 raw）—— server.js 的 tool() 传的就是这种。
 * 兼容 zod v3（_def.type=元素 schema）与 v4（_def.element=元素 schema，_def.type=类型字符串）。
 */
export function objectShapeOf(schema) {
  if (!schema || typeof schema !== 'object') return null;
  const isZod = typeof schema.safeParse === 'function';
  if (!isZod) return schema; // 裸 shape 表
  let s = schema;
  for (let i = 0; i < 8; i += 1) {
    if (!s || typeof s !== 'object') return null;
    if (s instanceof z.ZodObject) return s.shape;
    const d = s._def || {};
    const next = d.innerType
      || d.schema
      || (d.element && typeof d.element === 'object' ? d.element : null)
      || (d.type && typeof d.type === 'object' ? d.type : null); // 仅 zod v3 的 Array
    s = next;
  }
  return null;
}

/** 沿 path 逐段下钻取 object shape（数字段按数组元素处理） */
export function shapeAt(schema, path) {
  let s = schema;
  for (const seg of path || []) {
    if (typeof seg === 'number') {
      if (!s || typeof s.safeParse !== 'function') return null;
      const d = s._def || {};
      s = (d.element && typeof d.element === 'object' ? d.element : null)
        || (d.type && typeof d.type === 'object' ? d.type : null);
      continue;
    }
    const shape = objectShapeOf(s);
    if (!shape) return null;
    s = shape[seg];
  }
  return objectShapeOf(s);
}

/** 该处允许的字段名（供报错提示；取不到返回空数组） */
export function allowedKeysAt(schema, path) {
  const shape = shapeAt(schema, path);
  return shape ? Object.keys(shape) : [];
}

// ---- 值映射器 ----
const ALIGN_MAP = {
  center: 0, centre: 0, middle: 0, 居中: 0, 居中显示: 0,
  left: 2, start: 2, 左: 2, 左对齐: 2,
  right: 4, end: 4, 右: 4, 右对齐: 4,
  justify: 6, 两端: 6, 两端对齐: 6,
};
function toAlign(v) {
  if (typeof v !== 'string') return undefined;
  return ALIGN_MAP[String(v).trim().toLowerCase()];
}

function toBool(v) {
  if (typeof v === 'boolean') return v;
  const s = String(v).trim().toLowerCase();
  if (['true', '1', 'yes', 'y', 'true值', '是'].includes(s)) return true;
  if (['false', '0', 'no', 'n', '否'].includes(s)) return false;
  return undefined;
}

/** 对象字段被模型写成 JSON 字符串（dictionary / expand 等）：解析回对象，语义等价。 */
function parseJsonObjectField(args, key, fixes, label = key) {
  const v = args[key];
  if (typeof v !== 'string') return;
  const s = v.trim();
  if (!s.startsWith('{')) return;
  try {
    const parsed = JSON.parse(s);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      args[key] = parsed;
      fixes.push(`${label}（JSON 字符串）→ 对象`);
    }
  } catch { /* 非法 JSON 交给 schema 报错（保留原文可读性） */ }
}

/** 控件 type 别名归一（textEditor→text 等；单一事实源 lib/widget-types.js） */
function normalizeWidgetType(obj, fixes, label = '') {
  if (!obj || typeof obj.type !== 'string') return;
  const { type, changed, input } = canonicalWidgetType(obj.type);
  if (changed) {
    obj.type = type;
    fixes.push(`${label}type "${input}"→"${type}"`);
  }
}

/** 提交条件：模型可能传 FormulaCondition 对象（{class:"...FormulaCondition", formula:"..."}）而非公式文本。
 *  P2-2（第三轮独立复验）：class 不是 FormulaCondition 时只取显式 formula 字段，并在回执里注明
 *  「class 被忽略」；不把 value/text 等语义不明的字段当公式猜。 */
const FORMULA_CONDITION_CLASS = 'com.fr.data.condition.FormulaCondition';
const LIST_CONDITION_CLASS = 'com.fr.data.condition.ListCondition';
function normalizeSubmitCondition(args, fixes) {
  const c = args.condition;
  if (!c || typeof c !== 'object' || Array.isArray(c)) return;
  const cls = typeof c.class === 'string' ? c.class.trim() : '';
  const formulaClass = cls === '' || cls === FORMULA_CONDITION_CLASS;
  const raw = c.formula ?? c.expr ?? c.expression ?? (formulaClass ? (c.value ?? c.text) : undefined);
  if (typeof raw !== 'string') {
    // ListCondition（空列表=全部行）：允许对象形态，转成字符串交给 lib 写 <Condition class="...ListCondition"/>
    if (cls === LIST_CONDITION_CLASS || c.list === true || c.type === 'list') {
      args.condition = 'ListCondition';
      fixes.push('condition 对象（ListCondition）→ "ListCondition"');
    }
    return;
  }
  const text = raw.trim().replace(/^\s*=/, '');
  if (text === '' && !formulaClass) return;
  args.condition = text;
  if (!formulaClass) {
    fixes.push(`condition 对象 class="${cls}" 被忽略（本工具只写 FormulaCondition 或 ListCondition）；已取 formula`);
  } else if (text === '') {
    fixes.push('condition 对象 formula 为空 → 清除条件');
  } else {
    fixes.push('condition 对象（FormulaCondition）→ 公式文本');
  }
}

/** 工具级字段别名：{ 工具名: { 误写名: 规范名 } } —— 仅做"同名不同写法"的搬移，值语义一致 */
const FIELD_ALIASES = {
  add_toolbar_button: {
    text: 'buttonText', label: 'buttonText', name: 'buttonText', title: 'buttonText', value: 'buttonText',
  },
  // 注意：add_cell_highlight 的 condition 由 SPECIAL 处理（字符串→formula / {op,value}→compare），
  // 不能放这里按字段名硬搬，否则对象形态会被错搬成 formula。
  add_cell_hyperlink: { link: 'url', href: 'url', js: 'script' },
  set_cell_content_type: { type: 'contentType' },
  add_dataset: { query: 'sql', statement: 'sql' },
  update_dataset: { query: 'sql', statement: 'sql' },
  add_style: { align: 'horizontalAlignment' },
  update_cell_style: { align: 'horizontalAlignment' },
  // 2026-10-27 P0-1（两天会话审计 A 类 30 条）：高频误写键名
  add_fill_submit: { columns: 'bindings', cols: 'bindings', columnMap: 'bindings', bindingsMap: 'bindings', configType: 'submitType', submitMode: 'submitType', dmlType: 'submitType' },
  add_parameter_widget: { options: 'items', entries: 'items', dictItems: 'items' },
  update_parameter_widget: { options: 'items', entries: 'items', dictItems: 'items' },
  update_fill_binding: { submit: 'submitIndex', index: 'submitIndex', submitIdx: 'submitIndex' },
  update_fill_submit: { submit: 'submitIndex', index: 'submitIndex', submitIdx: 'submitIndex', configType: 'submitType', submitMode: 'submitType', dmlType: 'submitType' },
  delete_fill_binding: { submit: 'submitIndex', index: 'submitIndex', submitIdx: 'submitIndex' },
  delete_fill_submit: { submit: 'submitIndex', index: 'submitIndex', submitIdx: 'submitIndex' },
  // update_report_node：正文参数是 xmlBody，模型常写 content/xml/nodeXml（09-22 会话实测）
  update_report_node: { content: 'xmlBody', xml: 'xmlBody', nodeXml: 'xmlBody', xmlContent: 'xmlBody', body: 'xmlBody' },
  // V4 会话实测误写：按钮定位写 button / name / title；工作表名写 name；事件名写 eventName。
  set_toolbar_button_js: { button: 'buttonText', text: 'buttonText', name: 'buttonText', title: 'buttonText', label: 'buttonText', event: 'buttonText' },
  update_sheet: { name: 'newName', text: 'newName', title: 'newName', newTitle: 'newName' },
  rename_parameter_widget: { target: 'name', oldName: 'name', new: 'newName', to: 'newName' },
  get_webwrite_js: { eventName: 'event', evt: 'event' },
  get_report_listener: { eventName: 'event', evt: 'event' },
  get_cell_listener: { eventName: 'event', evt: 'event' },
};


/** 字典条目归一（custom 字典项）：
 *  · dictionary.{items|options|entries} → 顶层 items（schema 只认顶层 items）
 *  · 条目形态宽放：'x' → {key:'x',value:'x'}；{text|label|name,value} → {key,value}
 *  用在 add/update_parameter_widget 与 build_report 的 parameterWidgets[]。 */
function normalizeDictEntries(obj, fixes, label) {
  if (!obj || typeof obj !== 'object') return;
  const dict = obj.dictionary;
  if (dict && typeof dict === 'object') {
    for (const k of ['items', 'options', 'entries', 'dictItems']) {
      if (dict[k] !== undefined) {
        const moved = dict[k];
        delete dict[k];
        if (obj.items === undefined) { obj.items = moved; fixes.push(`${label}.dictionary.${k}→items`); }
      }
    }
  }
  if (Array.isArray(obj.items)) {
    obj.items = obj.items.map((it) => {
      if (typeof it === 'string' || typeof it === 'number') {
        fixes.push(`${label}.items 条目 "${it}"→{key,value}`);
        return { key: String(it), value: String(it) };
      }
      if (it && typeof it === 'object') {
        const key = it.key ?? it.text ?? it.label ?? it.name;
        const value = it.value ?? it.text ?? it.label ?? it.name;
        if ((it.key === undefined) && (key !== undefined)) {
          fixes.push(`${label}.items 条目补 key/value`);
          return { key: String(key), value: String(value) };
        }
      }
      return it;
    });
  }
}

/** 工具级特殊归一：返回值只用于生成说明，实际都在 args 上就地改 */
const SPECIAL = {
  // add_cell：expand（扩展属性对象）常被模型写成 JSON 字符串（sandbox19/v1 连试 5 次全被
  // "expected object, received string" 拒绝）。JSON 文本与对象语义等价，这里直接解析。
  add_cell(args, fixes) {
    if (typeof args.expand !== 'string') return;
    const s = args.expand.trim();
    if (!s.startsWith('{')) return;
    try {
      const parsed = JSON.parse(s);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        args.expand = parsed;
        fixes.push('expand（JSON 字符串）→ 对象');
      }
    } catch { /* 非法 JSON 交给 schema 报错（保留原文可读性） */ }
  },
  // invisible=true 是"设计器不可见"（update 工具的 visible=false）；add 工具只有 hidden（只挪位置）
  add_parameter_widget(args, fixes) {
    parseJsonObjectField(args, 'dictionary', fixes, 'add_parameter_widget.dictionary');
    normalizeDictEntries(args, fixes, 'add_parameter_widget');
    normalizeWidgetType(args, fixes, 'add_parameter_widget.');
    if (args.invisible === undefined) return;
    const v = toBool(args.invisible);
    delete args.invisible;
    if (v === true && args.hidden === undefined) {
      args.hidden = true;
      fixes.push('invisible→hidden（注意：hidden 只把控件挪到不可见区域，真正隐藏请补 update_parameter_widget(visible=false)）');
    }
  },
  update_parameter_widget(args, fixes) {
    parseJsonObjectField(args, 'dictionary', fixes, 'update_parameter_widget.dictionary');
    normalizeDictEntries(args, fixes, 'update_parameter_widget');
    normalizeWidgetDictionary(args, fixes, { keepCustomDictionary: true });
    if (args.invisible !== undefined) {
      const v = toBool(args.invisible);
      delete args.invisible;
      if (v !== undefined && args.visible === undefined) {
        args.visible = !v;
        fixes.push(`invisible=${v}→visible=${!v}`);
      }
    }
    const border = args.borderStyle ?? args.border;
    if (border !== undefined && args.noBorder === undefined) {
      delete args.borderStyle;
      delete args.border;
      const s = String(border).trim().toLowerCase();
      if (['none', 'no', '0', '无', '无边框'].includes(s)) { args.noBorder = true; fixes.push(`borderStyle="${border}"→noBorder=true`); }
      else if (['solid', 'line', '有', '有边框'].includes(s)) { args.noBorder = false; fixes.push(`borderStyle="${border}"→noBorder=false`); }
      else fixes.push(`borderStyle="${border}" 无法映射（仅支持 none/solid）`);
    }
  },
  // add_fill_submit：目标连接常被写成 connection（列映射模式对应 dsName，自由 SQL 模式对应 dbName）；
  // condition 可能传 FormulaCondition 对象（{class, formula}）而不是公式文本。
  add_fill_submit(args, fixes) {
    normalizeSubmitCondition(args, fixes);
    if (args.connection === undefined) return;
    const conn = args.connection;
    delete args.connection;
    const hasSql = args.sql != null && String(args.sql).trim() !== '';
    const target = hasSql ? 'dbName' : 'dsName';
    if (args[target] === undefined) {
      args[target] = conn;
      fixes.push(`connection→${target}（${hasSql ? '自由 SQL 提交=服务端数据连接名' : '列映射提交=数据源名'}）`);
    }
  },
  // update_fill_submit：同 add_fill_submit 的 condition 对象形态；batch 的 items[].patch 也一并归一
  update_fill_submit(args, fixes) {
    normalizeSubmitCondition(args, fixes);
  },
  update_fill_submit_batch(args, fixes) {
    if (!Array.isArray(args.items)) return;
    for (const it of args.items) {
      if (it && typeof it === 'object') normalizeSubmitCondition(it.patch || {}, fixes);
    }
  },
  // add_parameter_widget_batch / update_parameter_widget_batch：items 不经单品 schema 校验，
  // 在这里按同一口径归一 dictionary JSON 字符串 / dictionary.items 错层 / type 别名。
  add_parameter_widget_batch(args, fixes) {
    if (!Array.isArray(args.items)) return;
    args.items.forEach((it, i) => {
      if (!it || typeof it !== 'object') return;
      parseJsonObjectField(it, 'dictionary', fixes, `items[${i}].dictionary`);
      normalizeWidgetDictionary(it, fixes);
      normalizeDictEntries(it, fixes, `items[${i}]`);
      normalizeWidgetType(it, fixes, `items[${i}].`);
    });
  },
  update_parameter_widget_batch(args, fixes) {
    if (!Array.isArray(args.items)) return;
    args.items.forEach((it, i) => {
      const patch = it && typeof it === 'object' ? it.patch : null;
      if (!patch || typeof patch !== 'object') return;
      parseJsonObjectField(patch, 'dictionary', fixes, `items[${i}].patch.dictionary`);
      normalizeDictEntries(patch, fixes, `items[${i}].patch`);
      normalizeWidgetDictionary(patch, fixes, { keepCustomDictionary: true });
    });
  },
  // update_cell_listener_batch：模型常写成扁平 items[{column,row,event,js/patchFind,...}]，
  // 与单品 update_cell_listener 同形；这里搬到 {target,patch}，避免整批被 schema 拒绝。
  update_cell_listener_batch(args, fixes) {
    if (!Array.isArray(args.items)) return;
    args.items.forEach((it, i) => {
      if (!it || typeof it !== 'object' || it.target || it.patch) return;
      const { column, row, event, match, sheet, ...patch } = it;
      if (column === undefined || row === undefined || !event) return;
      it.target = { column, row, event };
      if (match !== undefined) it.target.match = match;
      if (sheet !== undefined) it.target.sheet = sheet;
      it.patch = patch;
      delete it.column;
      delete it.row;
      delete it.event;
      delete it.match;
      delete it.sheet;
      fixes.push(`items[${i}] 扁平字段→{target,patch}`);
    });
  },
  // update_cell_style：scope='style' 是"改共享样式"的自然写法（真实会话 10-29 踩中）
  update_cell_style(args, fixes) {
    if (args.scope === undefined) return;
    const map = { style: 'shared', sharedstyle: 'shared', single: 'cell' };
    const k = String(args.scope).trim().toLowerCase();
    if (map[k] && args.scope !== map[k]) {
      fixes.push(`scope "${args.scope}"→"${map[k]}"`);
      args.scope = map[k];
    }
  },
  // 高亮：condition 可能是公式字符串或 {op,value}；wholeRow 是 scope 的布尔简写
  add_cell_highlight(args, fixes) {
    if (args.condition !== undefined) {
      const c = args.condition;
      delete args.condition;
      if (typeof c === 'string') {
        if (args.formula === undefined && args.compare === undefined) {
          args.formula = /^\s*=/.test(c) ? c.replace(/^\s*=/, '') : c;
          fixes.push('condition→formula');
        }
      } else if (c && typeof c === 'object' && c.op !== undefined) {
        if (args.compare === undefined) { args.compare = c; fixes.push('condition{op,value}→compare'); }
      } else {
        fixes.push('condition 无法识别（传公式字符串或 {op,value}）');
      }
    }
    if (args.wholeRow !== undefined) {
      const v = toBool(args.wholeRow);
      delete args.wholeRow;
      if (v !== undefined && args.scope === undefined) {
        args.scope = v ? 'row' : 'cell';
        fixes.push(`wholeRow=${v}→scope="${args.scope}"`);
      }
    }
  },
  // generate_report：fields[].title→label、width→widthMm、sum→summary、align 字符串→数字
  generate_report(args, fixes) {
    if (!Array.isArray(args.fields)) return;
    for (const f of args.fields) {
      if (!f || typeof f !== 'object') continue;
      moveField(f, 'title', 'label', fixes, 'fields[].title→label');
      moveField(f, 'width', 'widthMm', fixes, 'fields[].width→widthMm');
      moveField(f, 'sum', 'summary', fixes, 'fields[].sum→summary');
      if (typeof f.align === 'string') {
        const n = toAlign(f.align);
        if (n !== undefined) { fixes.push(`fields[].align "${f.align}"→${n}`); f.align = n; }
      }
    }
  },
  // build_report：spec.settings 边距缺 Mm 单位、parameterWidgets 字典 items 放错层、styles.align 名字
  build_report(args, fixes) {
    const spec = args.spec;
    if (!spec || typeof spec !== 'object') return;
    const st = spec.settings;
    if (st && typeof st === 'object' && !Array.isArray(st)) {
      for (const k of ['marginTop', 'marginBottom', 'marginLeft', 'marginRight',
        'paperWidth', 'paperHeight', 'headerHeight', 'footerHeight']) {
        const mm = `${k}Mm`;
        if (st[k] !== undefined && st[mm] === undefined) {
          st[mm] = st[k];
          delete st[k];
          fixes.push(`spec.settings.${k}→${mm}（页面设置长度字段带 Mm 后缀）`);
        }
      }
    }
    if (Array.isArray(spec.parameterWidgets)) {
      for (const w of spec.parameterWidgets) normalizeDictEntries(w, fixes, 'spec.parameterWidgets[]');
    }
    if (Array.isArray(spec.styles)) {
      for (const s of spec.styles) {
        if (s && typeof s === 'object' && s.align !== undefined && s.horizontalAlignment === undefined) {
          let v = s.align;
          delete s.align;
          if (typeof v === 'string') {
            const n = toAlign(v);
            if (n !== undefined) v = n;
          }
          s.horizontalAlignment = v;
          fixes.push('spec.styles[].align→horizontalAlignment');
        }
      }
    }
  },
};

function moveField(obj, from, to, fixes, label) {
  if (obj[from] === undefined || obj[to] !== undefined) return;
  obj[to] = obj[from];
  delete obj[from];
  fixes.push(label);
}

// ---- 通用 Mm 后缀对齐 ----
function normalizeMmSuffixes(args, shapeKeys, fixes) {
  const set = new Set(shapeKeys || []);
  if (!set.size) return;
  for (const k of Object.keys(args)) {
    if (set.has(k)) continue;
    if (!k.endsWith('Mm') && set.has(`${k}Mm`)) {
      args[`${k}Mm`] = args[k];
      delete args[k];
      fixes.push(`${k}→${k}Mm`);
      continue;
    }
    if (k.endsWith('Mm') && set.has(k.slice(0, -2)) && args[k.slice(0, -2)] === undefined) {
      const base = k.slice(0, -2);
      args[base] = args[k];
      delete args[k];
      fixes.push(`${k}→${base}`);
    }
  }
}

/** 下拉字典：valueField/textField/displayColumn/valueColumn → kiName/viName */
function normalizeWidgetDictionary(args, fixes, { keepCustomDictionary = false } = {}) {
  const dict = args.dictionary;
  if (!dict || typeof dict !== 'object' || Array.isArray(dict)) return;
  const map = {
    valueField: 'kiName', keyField: 'kiName', valueColumn: 'kiName',
    textField: 'viName', labelField: 'viName', displayColumn: 'viName',
    dataset: 'dsName', ds: 'dsName', tableName: 'table',
  };
  for (const [from, to] of Object.entries(map)) {
    if (dict[from] === undefined) continue;
    if (dict[to] === undefined) { dict[to] = dict[from]; fixes.push(`dictionary.${from}→${to}`); }
    delete dict[from];
  }
  if (dict.items !== undefined) {
    const moved = dict.items;
    delete dict.items;
    if (args.items === undefined) {
      args.items = moved;
      fixes.push('dictionary.items→items（自定义字典项在控件顶层）');
    }
  }
  // {type:'custom', items:[...]} 归一后 dictionary 只剩空壳 type → 删掉：update_parameter_widget
  // 把 dictionary 与 items 视为「整块替换 / 原位改」二选一，不删会误报"不能同时传"（真实会话踩中）。
  const restKeys = Object.keys(dict).filter((k) => dict[k] !== undefined);
  if (restKeys.length === 1 && restKeys[0] === 'type'
    && String(dict.type).toLowerCase() === 'custom' && args.items !== undefined) {
    if (keepCustomDictionary) {
      dict.items = args.items;
      delete args.items;
      fixes.push('dictionary（type=custom）+items→dictionary:{type:custom,items}（保持整块替换，可把已有 DatabaseDictionary 转成自定义项）');
    } else {
      delete args.dictionary;
      fixes.push('dictionary（空壳 type=custom）+items→items（自定义字典项在控件顶层）');
    }
  }
}

/**
 * 归一化入口。
 * @param {string} name 工具名
 * @param {object} rawArgs 调用方传的原始参数
 * @param {object} schema 该工具的完整 zod 参数表（z.object(raw) 里的 raw）
 * @returns {{args: object, fixes: string[]}} args 为浅拷贝（嵌套对象按需就地改），fixes 为纠正说明
 */
export function normalizeArgs(name, rawArgs, schema) {
  const fixes = [];
  if (!rawArgs || typeof rawArgs !== 'object' || Array.isArray(rawArgs)) {
    return { args: rawArgs, fixes };
  }
  const args = { ...rawArgs };
  const shapeKeys = Object.keys(schema || {});

  normalizeMmSuffixes(args, shapeKeys, fixes);

  for (const [from, to] of Object.entries(FIELD_ALIASES[name] || {})) {
    if (args[from] === undefined) continue;
    if (args[to] === undefined) { args[to] = args[from]; fixes.push(`${from}→${to}`); }
    delete args[from];
  }

  if (name === 'add_parameter_widget' || name === 'update_parameter_widget') {
    // dictionary 常被写成 JSON 字符串（真实会话 update_parameter_widget 踩中）——先解析再归一字段
    parseJsonObjectField(args, 'dictionary', fixes, `${name}.dictionary`);
    normalizeWidgetDictionary(args, fixes, { keepCustomDictionary: name === 'update_parameter_widget' });
  }


  // 数组参数容错（audit A 类：get_toolbar_button_batch 传单对象/漏包数组 → "expected array"）：
  // 依据 schema 形状把"单个对象"包成 [v]；放在别名搬移之后，columns→bindings 搬完同样生效。
  const _rootShape = objectShapeOf(schema) || {};
  for (const key of ['targets', 'items', 'bindings', 'commands', 'columns']) {
    let sh = _rootShape[key];
    // 解包 optional/nullable/default 再判数组（zod v3/v4 都走 innerType）
    while (sh && sh._def && sh._def.innerType
      && (sh._def.typeName === 'ZodOptional' || sh._def.typeName === 'ZodNullable' || sh._def.typeName === 'ZodDefault'
        || sh._def.type === 'optional' || sh._def.type === 'nullable' || sh._def.type === 'default')) {
      sh = sh._def.innerType;
    }
    const wantsArray = sh && (sh._def?.typeName === 'ZodArray' || sh._def?.type === 'array'
      || (sh._def && (sh._def.element || typeof sh._def.type === 'object')));
    const v = args[key];
    if (wantsArray && v != null && !Array.isArray(v) && typeof v === 'object') {
      args[key] = [v];
      fixes.push(key + '→[' + key + ']（单对象自动包成数组）');
    }
  }
  const special = SPECIAL[name];
  if (special) special(args, fixes);

  return { args, fixes };
}

/** 顶层必填键：外包类型不是 optional/default 即视为必填（zod v4 的 _def.type）。
 *  用于在严格校验前给出可读报错——否则 z.coerce.number() 会把 undefined 变 NaN。 */
export function missingRequiredArgs(schema, args) {
  const missing = [];
  for (const [key, field] of Object.entries(schema || {})) {
    if (args[key] !== undefined) continue;
    const d = field && field._def;
    const t = d ? (d.type ?? d.typeName) : null;
    if (t === 'optional' || t === 'default' || t === 'ZodOptional' || t === 'ZodDefault') continue;
    missing.push(key);
  }
  return missing;
}

/** 把纠正清单格式化成给模型看的一句话（为空返回 null） */
export function formatFixes(fixes) {
  if (!fixes || !fixes.length) return null;
  const uniq = [...new Set(fixes)];
  return `[参数已自动纠正] ${uniq.join('；')}。下次请直接用规范字段名（见 get_capabilities）。`;
}

/**
 * 需要"SDK 层放行、交给处理器归一"的字段（按工具）。
 *
 * 为什么必须这样做：MCP SDK 在调用我们的 handler **之前**就用 inputSchema 严格校验参数
 * （mcp.js: validateToolInput → safeParse），所以：
 *   · 必填字段若由别名提供（text→buttonText），SDK 会因为"buttonText 缺失"直接 32602；
 *   · 嵌套 strict 对象里的未知键（spec.settings.marginTop）SDK 先拒；
 *   · 值形态需要映射的（align:"center"→0）SDK 类型校验先拒。
 * 这些位置在 SDK 层置为 z.any，严格校验仍由处理器入口的 fullSchema 完成（报错更友好）。
 */
const SDK_LENIENT = {
  add_toolbar_button: ['buttonText', 'builtin', 'iconName', 'js'],
  // expand 允许 JSON 字符串（处理器 SPECIAL.add_cell 解析），SDK 层先放行，否则字符串在
  // 到达归一化之前就被类型校验拒掉（full 档广告完整 schema 时）。
  add_cell: ['expand'],
  set_cell_content_type: ['contentType', 'content', 'formula'],
  add_dataset: ['sql'],
  update_dataset: ['sql'],
  add_cell_highlight: ['formula', 'compare', 'conditions', 'logic', 'background', 'fontColor', 'value', 'bold', 'fontSizePt', 'fontName', 'scope'],
  add_cell_hyperlink: ['type', 'url', 'script', 'params'],
  add_parameter_widget: ['dictionary', 'items', 'hidden', 'type'],
  update_parameter_widget: ['dictionary', 'items', 'visible', 'noBorder', 'valueType'],
  // condition 允许 FormulaCondition 对象（SPECIAL 归一到公式文本）；SDK 层先放行，否则对象形态
  // 在到达处理器之前就被 z.string() 拒成 "expected string, received object"。
  add_fill_submit: ['condition'],
  update_fill_submit: ['condition'],
  generate_report: ['fields', 'source', 'options', 'fill', 'chart', 'theme'],
  build_report: ['spec'],
  add_style: ['horizontalAlignment'],
  update_cell_style: ['horizontalAlignment'],
  set_cell_content_type_extra: [],
};

/**
 * 生成"只做文档、不做严格校验"的 SDK 侧参数表（保留 type 与 description 供 tools/list）。
 * 规则：
 *   · 别名目标字段 / 已知需要归一或嵌套的字段 / *Mm 后缀 / align → z.any（描述保留）
 *   · 其余字段 → .optional()（保留类型校验，但必填下移到处理器，报错更友好）
 */
export function sdkLenientShape(name, shape) {
  const lenient = new Set([
    ...(SDK_LENIENT[name] || []),
    ...Object.values(FIELD_ALIASES[name] || {}).filter(Boolean),
  ]);
  const out = {};
  for (const [key, field] of Object.entries(shape || {})) {
    const desc = field && typeof field === 'object' ? field.description : undefined;
    const isLenient = lenient.has(key) || key === 'align' || /Mm$/.test(key);
    if (isLenient) {
      const anyField = z.any().optional(); // zod v4：z.any() 仍要求键存在，必须再 .optional()
      out[key] = desc ? anyField.describe(desc) : anyField;
    } else if (field && typeof field.optional === 'function') {
      out[key] = field.optional();
    } else {
      out[key] = field;
    }
  }
  return out;
}


