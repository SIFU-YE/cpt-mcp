// cpt-mcp/lib/engine/style.js
// 微型报表引擎 —— 样式审查（style review）
// 目的：把“设计器级”的样式规范落到审查，输出可治理的问题（error/warning/info + 建议）。
import { styles, cells } from '../cpt.js';
import {
  FONT_RANGE, FONT_REASONABLE, KNOWN_FONTS, STYLE_SHARE_WARN_COUNT,
  parseHex, contrastRatio,
} from './rules.js';


/** 把一个未渲染的样式行规范化为可比较的 {fg,bg}（缺省前景黑/背景白），用于对比度估计 */
function colorPair(s) {
  const fg = s.foregroundColor ?? '#000000';
  const bg = s.backgroundColor ?? '#FFFFFF';
  return { fg, bg };
}

/**
 * 样式审查。
 * @param {string} path cpt 文件路径
 * @returns {{count:number, issues:Array<{severity,location,message,suggestion?}>}}
 */
export function reviewStyles(path) {
  const issues = [];
  const stylesArr = styles(path);
  const cellArr = cells(path);

  // 统计每个样式被多少单元格共享
  const usage = new Map();
  cellArr.forEach((c) => {
    if (c.style == null) return;
    usage.set(c.style, (usage.get(c.style) || 0) + 1);
  });

  stylesArr.forEach((s, i) => {
    const loc = `样式${i}`;
    const share = usage.get(i) || 0;

    // 1. 字号
    // M73 业务管线修复：真实业务模板大量使用 2-4pt（如超长表头压缩布局），真实 FR 引擎
    // 实证 roundTrip=true 可加载（等价设计器能打开）——「小于 6pt」不是打不开的硬错误，
    // 与官方样本（最低 6pt）不符且可读性差，按 warning 提示即可，不得阻断交付判定。
    // 上界 200pt 仍保留 error（超大字号无实证、多为主观错误）。
    const pt = s.fontSizePt;
    if (pt != null) {
      if (pt > FONT_RANGE.maxPt) {
        issues.push({ severity: 'error', location: loc, message: `字号 ${pt}pt 超出设计器合法上限 ${FONT_RANGE.maxPt}pt` });
      } else if (pt < FONT_REASONABLE.minPt || pt > FONT_REASONABLE.maxPt) {
        issues.push({
          severity: 'warning', location: loc, message: `字号 ${pt}pt 偏${pt < FONT_REASONABLE.minPt ? '小' : '大'}，建议 ${FONT_REASONABLE.minPt}-${FONT_REASONABLE.maxPt}pt`,
          suggestion: pt < FONT_REASONABLE.minPt ? `小于 ${FONT_RANGE.minPt}pt 虽可加载但可读性差，正文至少 ${FONT_REASONABLE.minPt}pt` : '标题类大字请核对层级',
        });
      }
    } else {
      issues.push({ severity: 'warning', location: loc, message: '样式未定义字体字号（可能被默认覆盖）' });
    }

    // 2. 字体存在性/常规性
    if (s.fontName && !KNOWN_FONTS.has(s.fontName)) {
      issues.push({ severity: 'info', location: loc, message: `字体 "${s.fontName}" 不在常用字体清单（可能安装于设计器端，非错误）` });
    }

    // 3. 空样式：无任何可识别属性
    const hasAny = s.fontName || s.fontSizePt != null || s.foregroundColor || s.backgroundColor || s.backgroundName;
    if (!hasAny) {
      issues.push({ severity: 'warning', location: loc, message: '样式基本为空（无字体/颜色/背景），若未被使用可忽略' });
    }

    // 4. 前后景对比度（仅当明确设置了前景或背景色才估算；否则用默认推断易误报）
    if (s.foregroundColor || s.backgroundColor) {
      const { fg, bg } = colorPair(s);
      try {
        const ratio = contrastRatio(parseHex(fg), parseHex(bg));
        if (ratio < 3) {
          issues.push({
            severity: 'warning', location: loc,
            message: `前景 ${fg} / 背景 ${bg} 对比度≈${ratio.toFixed(2)}:1，低于 3:1，正文可读性差`,
            suggestion: '调深前景或调浅背景，或增大字号/加粗',
          });
        }
      } catch { /* 忽略无法解析的颜色 */ }
    }

    // 5. 共享过度
    if (share > STYLE_SHARE_WARN_COUNT) {
      issues.push({
        severity: 'info', location: loc, message: `样式${i} 被 ${share} 个单元格共享，改一处将影响整表，建议按用途拆分样式`,
      });
    }
  });

  // 6. 单元格引用越界
  const styleCount = stylesArr.length;
  cellArr.forEach((c) => {
    if (c.style == null) return;
    if (!Number.isInteger(c.style) || c.style < 0 || c.style >= styleCount) {
      issues.push({ severity: 'error', location: `单元格(${c.sheet}.${c.column},${c.row})`, message: `样式索引 s=${c.style} 越界（StyleList 仅 ${styleCount} 个样式）` });
    }
  });

  return { count: issues.length, issues };
}
