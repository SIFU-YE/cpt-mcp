// cpt-mcp/scripts/token-budget.coupling.mjs
// 预算门与"真实档位/轻 entry 清单"的**耦合点**：单一来源，由 lib/ 下的权威定义 re-export。
//
// 为什么要单独一层：scripts/*.mjs 是运维/门禁脚本，直接 import lib/contract.js 时如果
// 该模块将来引入运行期依赖（如 fs / env），脚本会被连带影响；这一层把"脚本只读得到的
// 纯常量"固定下来，并给出一个可被 test/ 断言的位置（预算门读到的名单必须等于服务端用的名单）。
export { REPORT_STATIC_TOOLS } from '../lib/contract.js';
export { LIGHT_TOOL_NAMES } from '../lib/light-schemas.js';
