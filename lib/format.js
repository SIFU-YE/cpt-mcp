// cpt-mcp/lib/format.js —— 低层 XML 文本构造与公式落盘形态（leaf 模块，不依赖 lib 内其它模块）
//
// 2026-10-29 整理：escapeXmlAttr / assertSafeCdata / formula 归一 原先定义在 lib/edits.js，
// 而 lib/engine/chart.js 与 lib/generate.js 反向 import edits 取用它们 —— 形成
// edits → chart → edits 的 ESM 双向依赖。抽到本 leaf 模块后：
//   edits / generate / chart / batch 都只依赖 format.js，chart 不再回头依赖 edits，环消除；
//   同时公式对象形态（官方 411 份样本实证）只有一个实现，避免各处各写一段 CDATA 拼串。
//
// 约定：本模块只做纯字符串变换，不读文件、不抛业务错误之外的副作用。

/** XML 属性值转义（与官方样本口径一致：五个实体全转义） */
export function escapeXmlAttr(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

/** CDATA 正文安全校验：出现 "]]>" 会提前闭合 CDATA，直接拒绝 */
export function assertSafeCdata(s, what) {
  if (String(s).includes(']]>')) throw new Error(`${what} 包含 "]]>"，会提前闭合 CDATA，已拒绝`);
  return String(s);
}

/** 公式源码归一：去空白并补单个前导 '='（官方公式对象 CDATA 恒以单个 = 开头）。
 *  2026-10-29 修：此前 setCellContentType 无条件加 '='，传 "=ROW()-4" 会写成 "==ROW()-4"。 */
export function normalizeFormulaExpr(v, what = '公式') {
  const s = String(v ?? '').trim();
  if (!s) throw new Error(`${what}不能为空`);
  return s.startsWith('=') ? s : `=${s}`;
}

/** 官方「单元格公式」对象形态（官方 1550 样本中 411 份实证；单元格级裸 CDATA 的 = 文本 0 例）：
 *  <O t="XMLable" class="com.fr.base.Formula"><Attributes><![CDATA[=SUM(A1:A2)]]></Attributes></O>
 *  2026-10-29 修：此前 add_cell(contentType:'formula') 写的是普通 <O> CDATA，FR 不当作公式计算。 */
export function formulaObjectXml(expr, what = '公式') {
  const f = normalizeFormulaExpr(expr, what);
  return `<O t="XMLable" class="com.fr.base.Formula">
<Attributes>
<![CDATA[${assertSafeCdata(f, what)}]]></Attributes>
</O>`;
}
