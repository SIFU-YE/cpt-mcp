// cpt-mcp/lib/write-hooks.js —— 写入后钩子注册表（leaf 模块，无 lib 内依赖）
//
// 2026-10-29 整理：lib/xml.js 的 save() 需要在写盘后刷新「JS 块数基线」（M120/M124），
// 原先直接 import recordJsBaseline from './js-baseline.js'，而 js-baseline.js 又 import
// load from './xml.js'、cpt.js 再回到 xml.js —— 形成 xml → js-baseline → cpt → xml 的
// ESM 静态循环（此前靠"环上只在函数体内使用对方导出"的口头约束维持）。
//
// 改为依赖倒置：xml.js 只在写盘后调用本模块的 runWriteHooks()（单向依赖 leaf），
// 由上层（js-baseline.js 在模块求值时）registerWriteHook(recordJsBaseline) 订阅。
// 钩子是可选增强：未注册（如仅 import xml.js 的脚本）时写入行为与之前一致，不产生副作用。

const hooks = [];

/** 注册写盘后钩子（幂等；同一函数重复注册只保留一份） */
export function registerWriteHook(fn) {
  if (typeof fn === 'function' && !hooks.includes(fn)) hooks.push(fn);
}

/** 写盘后按注册顺序执行钩子；单个钩子失败不影响写入结果，也不阻断其它钩子 */
export function runWriteHooks(filePath) {
  for (const fn of hooks) {
    try { fn(filePath); } catch { /* 钩子失败不影响写入 */ }
  }
}

/** 已注册钩子数量（供测试断言，不代表业务状态） */
export function writeHookCount() {
  return hooks.length;
}
