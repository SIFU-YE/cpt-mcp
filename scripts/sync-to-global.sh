#!/usr/bin/env bash
# cpt-mcp sync-to-global (bash / Git Bash 版，替代 sync-to-global.ps1)
# Source: <repo root> (auto-detected from this script's location)
#
# 同步目标（逐个同步；不存在/未安装的目标自动跳过）：
#   1) $APPDATA/reasonix/mcp-servers/cpt-mcp   —— reasonix 历史全局安装
#   2) $APPDATA/npm/node_modules/cpt-mcp       —— npm -g 安装；DSH 预设里 `command: cpt-mcp`
#      实际启动的是这份（PATH 上的 npm shim 指向它）
#
# 2026-10-20：
#   · 目标从 1 个（reasonix）扩到 2 个：修掉「桌面已修、DSH 仍在跑 npm 全局旧副本」的部署盲区；
#   · 实现改为 Node（scripts/sync-apply.mjs）：单进程算哈希+复制。旧版逐文件 fork
#     sha1sum/cp，200+ 文件在 Windows/Git-Bash 下要跑几分钟，pre-push 会被拖死。
set -uo pipefail

DESKTOP="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APPDATA="${APPDATA:-$HOME/AppData/Roaming}"

if [ ! -d "$DESKTOP" ]; then echo "[sync] desktop not found: $DESKTOP"; exit 1; fi
# 安全护栏：public/worktree 快照不得反向同步到全局（全局目标可能是指向主 worktree 的 junction）
if [ -f "$DESKTOP/.git" ]; then echo "[sync] worktree detected; skip syncing worktree snapshot to global"; exit 0; fi
if ! command -v node >/dev/null 2>&1; then echo "[sync] node not found on PATH"; exit 1; fi
if [ ! -f "$DESKTOP/scripts/sync-apply.mjs" ]; then echo "[sync] sync-apply.mjs not found"; exit 1; fi

exec node "$DESKTOP/scripts/sync-apply.mjs" --desktop "$DESKTOP" \
  "$APPDATA/reasonix/mcp-servers/cpt-mcp" \
  "$APPDATA/npm/node_modules/cpt-mcp"


