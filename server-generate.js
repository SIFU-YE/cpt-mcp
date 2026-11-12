#!/usr/bin/env node
// 面向较弱模型：只暴露“需求 → 报表 → 校验”四个工具。
process.env.CPT_MCP_TOOL_PROFILE = 'generate';
await import('./server.js');
