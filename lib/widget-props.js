// cpt-mcp/lib/widget-props.js —— 控件输入属性（allowBlank / DirectEdit / CustomData）的唯一实现
//
// 逆向取证（2026-11-19，FR 11.0 本机实测，勿凭记忆改）：
//   · 这三项【不是】<WidgetAttr> 的属性，而是 <Widget>/<InnerWidget> 的**同级子元素**：
//       <allowBlank><![CDATA[false]]></allowBlank>      —— 「允许为空」（FieldEditor.allowBlank，官方 16+ 例）
//       <DirectEdit><![CDATA[false]]></DirectEdit>      —— 「允许直接编辑」（DirectWriteEditor.directEdit，官方 ComboBox 1 例）
//       <CustomData><![CDATA[false]]></CustomData>      —— 「允许自定义值」（CustomWriteAbleRepeatEditor.customData，官方 ComboBox 1 例）
//   · 官方顺序：<WidgetAttr> → (<EMSG>) → <allowBlank> → <DirectEdit> → <CustomData> → <Dictionary> → <widgetValue>
//     实例：reportlets/demo/DataReport/销售财务报销表.cpt（allowBlank）、
//           reportlets/doc/Parameter/MultiValue/自定义参数大小比较.cpt（DirectEdit+CustomData）、
//           某会话/V3/.trash/通知排产表.cpt（三项齐全）。
//   · <WidgetAttr> 实测只有 5 个属性（description/disabled/invisible/aspectRatioLocked/aspectRatioBackup），
//     所以“widgetAttr 白名单”方案对这三项无效 —— 本模块按子元素写入。
//
// 支持矩阵按控件类实证收敛（未验证的组合直接拒绝，避免写出设计器不认的形态）：
//   allowBlank: text/number/textarea/date/comboBox/comboCheckBox
//   directEdit: comboBox/date
//   customData: comboBox
// text/textarea 额外同步 <TextAttr allowBlank="…"> 镜像属性（官方 简单自由填报.cpt 同款双写）。

const SPECS = {
  allowBlank: { element: 'allowBlank', label: '允许为空', mirrorTextAttr: true },
  directEdit: { element: 'DirectEdit', label: '允许直接编辑', mirrorTextAttr: false },
  customData: { element: 'CustomData', label: '允许自定义值', mirrorTextAttr: false },
};
const ORDER = ['allowBlank', 'directEdit', 'customData'];
const SUPPORT = {
  text: ['allowBlank'],
  number: ['allowBlank'],
  textarea: ['allowBlank'],
  date: ['allowBlank', 'directEdit'],
  comboBox: ['allowBlank', 'directEdit', 'customData'],
  comboCheckBox: ['allowBlank'],
};
const MIRROR_TEXT_TYPES = new Set(['text', 'textarea']);

export const WIDGET_PROP_KEYS = Object.freeze(Object.keys(SPECS));
export const WIDGET_PROP_LABELS = Object.freeze(
  Object.fromEntries(Object.entries(SPECS).map(([k, v]) => [k, `${v.label}（<${v.element}>）`])),
);
export const WIDGET_PROP_SUPPORT = Object.freeze(
  Object.fromEntries(Object.entries(SUPPORT).map(([k, v]) => [k, [...v]])),
);

/** 校验并归一 widgetProps（白名单 + 布尔值）；null/undefined → null */
export function normalizeWidgetProps(input) {
  if (input == null) return null;
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('widgetProps 必须是对象，如 {allowBlank:true, customData:true}');
  }
  const entries = Object.entries(input);
  if (entries.length === 0) throw new Error('widgetProps 不能为空对象（不传=不改这些属性）');
  const out = {};
  for (const [k, v] of entries) {
    const spec = SPECS[k];
    if (!spec) {
      throw new Error(`widgetProps 键 "${k}" 不在白名单（允许：${WIDGET_PROP_KEYS.join(' / ')}；` +
        `它们写入 <Widget> 内同级子元素 ${WIDGET_PROP_KEYS.map((x) => `<${SPECS[x].element}>`).join(' / ')}，不是 <WidgetAttr> 属性）`);
    }
    if (typeof v !== 'boolean') throw new Error(`widgetProps.${k} 必须是布尔值 true/false（收到 ${JSON.stringify(v)}）`);
    out[k] = v;
  }
  return out;
}

/** 校验目标控件类型是否支持所请求的属性；不支持时给出可读报错（不写文件） */
export function assertWidgetPropsSupported(widgetType, props, { action = 'widgetProps' } = {}) {
  if (!props) return;
  const type = widgetType == null ? null : String(widgetType);
  if (!type || type === 'custom') {
    throw new Error(`${action}: widgetProps 只支持已知标准控件类型（${Object.keys(SUPPORT).join('/')}），` +
      `当前 widget=${JSON.stringify(widgetType)}；custom 类无法判定支持矩阵，请改用标准类型或先在设计器配置`);
  }
  const allowed = SUPPORT[type];
  if (!allowed) throw new Error(`${action}: 控件类型 "${type}" 不支持 widgetProps（支持：${Object.keys(SUPPORT).join('/')}）`);
  const bad = Object.keys(props).filter((k) => !allowed.includes(k));
  if (bad.length) {
    throw new Error(`${action}: 控件类型 "${type}" 不支持 ${bad.map((k) => `"${k}"`).join('、')}` +
      `（该类型支持：${allowed.join('/') || '无'}）。白名单与官方实证见 get_capabilities({tool:"add_cell",section:"cell.widget"})`);
  }
}

/** 生成子元素 XML（按官方顺序；空/不存在 → 空串） */
export function widgetPropsChildXml(props) {
  if (!props) return '';
  const lines = [];
  for (const key of ORDER) {
    if (!(key in props)) continue;
    const spec = SPECS[key];
    const value = props[key] ? 'true' : 'false';
    lines.push('<' + spec.element + '>\n<![CDATA[' + value + ']]>' + '</' + spec.element + '>');
  }
  return lines.length ? lines.join('\n') : '';
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 从「控件 XML 块」字符串里原地 upsert 子元素（保留其余字节）；返回 { xml, applied } */
export function applyWidgetPropsToWidgetXml(block, props, { action = 'widgetProps' } = {}) {
  if (!props) return { xml: block, applied: {} };
  let xml = String(block);
  const applied = {};
  for (const key of ORDER) {
    if (!(key in props)) continue;
    const spec = SPECS[key];
    const el = spec.element;
    const value = props[key] ? 'true' : 'false';
    const re = new RegExp(`<${escapeRegExp(el)}\\b[^>]*?(?:/>|>[\\s\\S]*?</${escapeRegExp(el)}>)`);
    const m = re.exec(xml);
    const next = '<' + el + '>\n<![CDATA[' + value + ']]>' + '</' + el + '>';
    if (m) {
      xml = xml.slice(0, m.index) + next + xml.slice(m.index + m[0].length);
    } else {
      // 官方顺序：插到「后续兄弟节点」之前（没有后续则插到 </Widget> 前）
      const laterAnchors = ORDER.slice(ORDER.indexOf(key) + 1).map((k) => `<${SPECS[k].element}`)
        .concat(['<Dictionary', '<widgetValue>', '</Widget>']);
      let at = -1;
      for (const a of laterAnchors) {
        const i = xml.indexOf(a);
        if (i >= 0 && (at < 0 || i < at)) at = i;
      }
      if (at < 0) throw new Error(`${action}: 定位失败（控件块内未找到 </Widget> 或后续兄弟节点）`);
      xml = xml.slice(0, at) + `${next}\n` + xml.slice(at);
    }
    applied[key] = props[key];
  }
  return { xml, applied };
}

/** text/textarea 的 <TextAttr allowBlank="…"> 镜像（官方 TextEditor 双写形态；无 TextAttr 则跳过） */
export function applyAllowBlankMirror(block, allowBlank) {
  if (typeof allowBlank !== 'boolean') return block;
  const value = allowBlank ? 'true' : 'false';
  const m = /<TextAttr\b([^>]*?)(\/?)>/.exec(block);
  if (!m) return block;
  const attrs = m[1];
  let nextAttrs;
  if (/\ballowBlank\s*=\s*"[^"]*"/.test(attrs)) {
    nextAttrs = attrs.replace(/(\ballowBlank\s*=\s*")[^"]*(")/, (m, p1, p2) => `${p1}${value}${p2}`);
  } else {
    nextAttrs = `${attrs} allowBlank="${value}"`;
  }
  return block.slice(0, m.index) + `<TextAttr${nextAttrs}${m[2]}>` + block.slice(m.index + m[0].length);
}

/** 解析控件节点（fast-xml-parser 形态）读取三个子元素；返回仅含存在的键 */
export function readWidgetProps(widgetNode) {
  if (!widgetNode || typeof widgetNode !== 'object') return null;
  const readBool = (node) => {
    if (node == null) return undefined;
    const raw = typeof node === 'string' ? node : (node.__cdata ?? node['#text'] ?? null);
    if (raw == null) return undefined;
    const s = String(raw).trim().toLowerCase();
    if (s === 'true') return true;
    if (s === 'false') return false;
    return undefined;
  };
  const out = {};
  for (const key of ORDER) {
    const spec = SPECS[key];
    const v = readBool(widgetNode[spec.element]);
    if (v !== undefined) out[key] = v;
  }
  // 兼容旧模板：text/textarea 的 allowBlank 可能只写在 <TextAttr allowBlank="false"> 上
  if (out.allowBlank === undefined) {
    const ta = widgetNode.TextAttr;
    const attr = ta && typeof ta === 'object' ? ta['@_allowBlank'] : undefined;
    if (attr === 'true') out.allowBlank = true;
    else if (attr === 'false') out.allowBlank = false;
  }
  return Object.keys(out).length ? out : null;
}

/** add_cell 新建路径用：按控件类型校验并生成「WidgetAttr 之后」的属性子元素串 */
export function buildWidgetPropsXml(widgetType, props, { action = 'add_cell' } = {}) {
  const norm = normalizeWidgetProps(props);
  if (!norm) return '';
  assertWidgetPropsSupported(widgetType, norm, { action });
  return widgetPropsChildXml(norm);
}

/** 就地改路径用：把属性写进已存在的控件 XML 块（含 text/textarea 镜像） */
export function applyWidgetPropsToExistingBlock(widgetType, block, props, { action = 'set_cell_widget' } = {}) {
  const norm = normalizeWidgetProps(props);
  if (!norm) return { xml: block, applied: null };
  assertWidgetPropsSupported(widgetType, norm, { action });
  const r = applyWidgetPropsToWidgetXml(block, norm, { action });
  let xml = r.xml;
  if ('allowBlank' in norm && MIRROR_TEXT_TYPES.has(String(widgetType))) {
    xml = applyAllowBlankMirror(xml, norm.allowBlank);
  }
  return { xml, applied: r.applied };
}

/** 新建路径用：text/textarea 的 <TextAttr allowBlank> 镜像（官方 TextEditor 双写形态） */
export function applyWidgetPropsMirror(widgetType, xml, props) {
  if (!props || !('allowBlank' in props)) return xml;
  if (!MIRROR_TEXT_TYPES.has(String(widgetType))) return xml;
  return applyAllowBlankMirror(xml, props.allowBlank);
}
