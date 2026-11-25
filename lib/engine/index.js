// cpt-mcp/lib/engine/index.js
// 微型报表引擎入口：汇总导出 样式审查 / 合理性审查 / 报表构建 与设计器规则常量。
export { reviewStyles } from './style.js';
export { reviewReasonableness } from './reason.js';
export { buildReport, autoExpandCells } from './builder.js';
export { generateReport } from './smart.js';
export * as rules from './rules.js';
