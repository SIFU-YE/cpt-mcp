// scripts/token-baseline.mjs —— t1 止血基线：输出各 MCP 入口 tools/list 负载对比
// 对比 full / report（默认） / focused / generate 四档的工具数、序列化字符数与估算 token。
// 估算口径：estTokens ≈ JSON 字符数 / 4（中英文混合描述的粗估，仅用于档间对比，不代表模型实际计费）。
// 用法：node scripts/token-baseline.mjs [--write]（--write 则同步写入 docs/TOKEN-BASELINE.md）
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const WRITE = process.argv.includes('--write');

const ENTRIES = [
  { label: 'full（完整）', entry: 'server-full.js', env: {} },
  // 2026-10-26 起 server.js 默认档即 report（ROSTER 单一来源 lib/contract.js 的 REPORT_STATIC_TOOLS）
  { label: 'report（默认）', entry: 'server.js', env: {} },
  { label: 'focused（弱模型）', entry: 'server-focused.js', env: {} },
  { label: 'generate（弱模型最小集）', entry: 'server-generate.js', env: {} },
];

async function listEntry(entry, env) {
  const client = new Client({ name: 'token-baseline', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(ROOT, entry)],
    cwd: ROOT,
    stderr: 'pipe',
    // 仅增量 env（SDK 合并到安全默认）；禁止 {...process.env} 全量透传污染被测服务。
    ...(Object.keys(env).length ? { env } : {}),
  });
  await client.connect(transport);
  try {
    return (await client.listTools()).tools;
  } finally {
    await client.close();
  }
}

// 顺序 spawn，避免并发打爆 stdio（限流意识）
const rows = [];
for (const e of ENTRIES) {
  const tools = await listEntry(e.entry, e.env);
  const json = JSON.stringify(tools);
  const chars = json.length;
  const estTokens = Math.round(chars / 4);
  rows.push({ label: e.label, entry: e.entry, count: tools.length, chars, estTokens });
}

const full = rows[0];
const line = (r) => {
  const pct = ((r.estTokens / full.estTokens) * 100).toFixed(1);
  const saved = (100 - (r.estTokens / full.estTokens) * 100).toFixed(1);
  return `| ${r.label} | \`${r.entry}\` | ${r.count} | ${r.chars} | ~${r.estTokens} | ${pct}% | -${saved}% |`;
};
const md = [
  '# MCP 入口 Token 基线（t1 止血）',
  '',
  `> 生成时间：${new Date().toISOString()}；口径：tools/list 序列化 JSON 字符数，estTokens ≈ 字符数 / 4（档间对比用）。`,
  '',
  '| 入口 | 启动文件 | 工具数 | JSON 字符 | 估算 token | 占 full | 相对 full 节省 |',
  '| --- | --- | --- | --- | --- | --- | --- |',
  ...rows.map(line),
  '',
  `- 默认入口 = report：直接启动 \`node server.js\` 仅暴露 ${rows[1].count} 个工具，约为 full 的 ${(rows[1].estTokens / full.estTokens * 100).toFixed(1)}%；2026-11-12 P0-1/P0-2 后 report 静态表为 33 项（历史 42 项）。`,
  '- 完整能力仍可用：`node server-full.js` 或 `CPT_MCP_TOOL_PROFILE=full node server.js`。',
  '- 其它档：`CPT_MCP_TOOL_PROFILE=focused|report|generate|full`；focused 为弱模型精选子集，generate 为最小生成集。',
  '',
].join('\n');

console.log(md);
if (WRITE) {
  fs.writeFileSync(path.join(ROOT, 'docs', 'TOKEN-BASELINE.md'), md, 'utf8');
  console.log('已写入 docs/TOKEN-BASELINE.md');
}
