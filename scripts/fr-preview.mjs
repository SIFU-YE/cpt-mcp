#!/usr/bin/env node
// cpt-mcp/scripts/fr-preview.mjs —— 本地独立 FR 报表实例 CLI
//
// 用法：
//   node scripts/fr-preview.mjs start <cpt> [--port N] [--timeout 秒] [--no-wait] [--no-impersonate] [--json]
//   node scripts/fr-preview.mjs stop   [--json]
//   node scripts/fr-preview.mjs status [--json]
//
// 说明：这是 MCP 工具 start_fr_preview / stop_fr_preview / fr_preview_status 的命令行等价物，
// 供无 MCP 会话（或调试）使用；实例完全独立，跑在 127.0.0.1 的随机空闲端口。
//
// 内置参数伪装：默认用平台超管 admin 登录本地预览实例（$fine_username 等解析为 admin）。
// 账号默认 admin，口令读 CPT_MCP_FR_PREVIEW_ADMIN_PASSWORD（缺省见 lib/fr-preview.js）；
// --no-impersonate 退回匿名预览（$fine_username 为空）。

import path from 'node:path';
import { startFrPreview, stopFrPreview, frPreviewStatus } from '../lib/fr-preview.js';

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--json') args.json = true;
    else if (a === '--no-wait') args.wait = false;
    else if (a === '--no-impersonate') args.impersonate = false;
    else if (a === '--port') args.port = Number(argv[++i]);
    else if (a === '--timeout') args.timeout = Number(argv[++i]);
    else if (a === '--help' || a === '-h') args.help = true;
    else args._.push(a);
  }
  return args;
}

/** 把 impersonation 状态翻成 CLI 里的一行说明。 */
function impersonationLine(result) {
  const imp = result.impersonation;
  if (!imp) return null;
  if (imp.status === 'ok') return `  内置参数伪装：已用 ${imp.username} 登录（$fine_username 等解析为 ${imp.username}）`;
  if (imp.status === 'pending') return '  内置参数伪装：等待实例就绪后自动登录（稍后用 status 查看）';
  if (imp.status === 'disabled') return '  内置参数伪装：未启用（预览为匿名会话，$fine_username 为空）';
  if (imp.status === 'failed') return `  内置参数伪装：失败（${imp.reason || imp.errorMsg || '未知原因'}）——下面的 URL 是匿名直连，登录后才能看到 admin`;
  return `  内置参数伪装：${imp.status}`;
}

function human(result) {
  const lines = [];
  if (result.status === 'started' || result.status === 'already-running') {
    lines.push(`本地独立 FR 实例已就绪（${result.status === 'reused' || result.status === 'already-running' ? '复用已有实例' : '新启动'}）`);
    lines.push(`  模板：${result.cpt || ''}`);
    lines.push(`  分页预览：${result.viewUrl}`);
    lines.push(`  填报预览：${result.writeUrl}`);
    lines.push(`  平台管理：${result.adminUrl}`);
    if (result.directViewUrl && result.impersonation?.status === 'ok') lines.push(`  匿名直连（对照）：${result.directViewUrl}`);
    const imp = impersonationLine(result);
    if (imp) lines.push(imp);
    lines.push(`  进程 PID=${result.pid}  端口=${result.port}  实例目录=${result.runtimeDir || ''}`);
    if (result.killedOrphans?.length) lines.push(`  已清理残留 java 进程：${result.killedOrphans.join(', ')}`);
  } else if (result.status === 'starting') {
    lines.push('实例进程已拉起，正在冷启动（FR 通常 30~60s）');
    lines.push(`  分页预览：${result.viewUrl}`);
    lines.push(`  填报预览：${result.writeUrl}`);
    const imp = impersonationLine(result);
    if (imp) lines.push(imp);
    lines.push(`  进程 PID=${result.pid}  端口=${result.port}`);
  } else if (result.status === 'stopped') {
    lines.push(`已停止本地预览实例（PID=${result.pid}，端口=${result.port}${result.graceful ? '，优雅关闭' : '，已强杀'}）`);
    if (result.seedUpdated) lines.push('平台库已回写为种子，管理员/数据连接配置会保留。');
    if (result.killedOrphans?.length) lines.push(`已清理残留 java 进程：${result.killedOrphans.join(', ')}`);
  } else if (result.status) {
    lines.push(`状态：${result.status}`);
    if (result.running === false) lines.push('  当前没有运行中的实例。');
    if (result.pid) lines.push(`  PID=${result.pid}  端口=${result.port}  健康检查 HTTP=${result.health}`);
    if (result.viewUrl) lines.push(`  分页预览：${result.viewUrl}`);
    if (result.writeUrl) lines.push(`  填报预览：${result.writeUrl}`);
    if (result.directViewUrl && result.impersonation?.status === 'ok') lines.push(`  匿名直连（对照）：${result.directViewUrl}`);
    const imp = impersonationLine(result);
    if (imp) lines.push(imp);
  }
  if (result.hint) lines.push(`提示：${result.hint}`);
  if (!result.ok && result.error) lines.push(`错误：${result.error}`);
  if (result.logTail) lines.push(`日志尾部：\n${result.logTail}`);
  return lines.join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args._.length) {
    console.log(`用法：
  node scripts/fr-preview.mjs start <cpt> [--port N] [--timeout 秒] [--no-wait] [--no-impersonate] [--json]
      --no-wait         立即返回 starting（随后用 status 轮询到 running）；缺省等就绪
      --no-impersonate  不登录 admin：预览为匿名会话，$fine_username 等内置参数为空
  node scripts/fr-preview.mjs stop   [--json]
  node scripts/fr-preview.mjs status [--json]

内置参数伪装（默认开）：用本地预览实例的平台超管 admin 登录后打开预览，
$fine_username/$fine_userid/$fine_role/$fine_position/$fine_display_name 解析为 admin。
账号/口令可用 CPT_MCP_FR_PREVIEW_ADMIN_USER / CPT_MCP_FR_PREVIEW_ADMIN_PASSWORD 覆盖。`);
    process.exitCode = args.help ? 0 : 1;
    return;
  }
  const action = args._[0];
  const cpt = args._[1];
  let result;
  if (action === 'start') {
    result = await startFrPreview(cpt ? path.resolve(cpt) : '', {
      port: args.port,
      timeoutSeconds: args.timeout,
      waitForReady: args.wait !== false, // CLI 默认等就绪；--no-wait 立即返回
      impersonate: args.impersonate !== false,
    });
  } else if (action === 'stop') {
    result = await stopFrPreview();
  } else if (action === 'status') {
    result = await frPreviewStatus();
  } else {
    console.error(`未知子命令：${action}`);
    process.exitCode = 1;
    return;
  }
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else console.log(human(result));
  if (!result.ok) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e?.stack || String(e));
  process.exitCode = 1;
});
