#!/usr/bin/env node
// 面向常规生成/修改：暴露高层构建、常用修改和校验工具。
process.env.CPT_MCP_TOOL_PROFILE = 'focused';
await import('./server.js');
