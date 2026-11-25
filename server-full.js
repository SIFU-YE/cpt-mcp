#!/usr/bin/env node
// 完整入口：显式暴露全部工具（与默认 focused 入口相对）。
// t1 止血后 server.js 默认 focused；需要精细编辑/调度/FR 逆向时用本入口。
process.env.CPT_MCP_TOOL_PROFILE = 'full';
await import('./server.js');
