<#
.SYNOPSIS
  Sync cpt-mcp desktop (development copy) to reasonix global MCP install.

.DESCRIPTION
  Source : <repo root> (auto-detected from this script's location)
  Target : %APPDATA%\reasonix\mcp-servers\cpt-mcp

  The sync manifest is generated at runtime by `node scripts/sync-manifest.mjs --ps1`
  which scans lib/, scripts/, test/, docs/ and the top-level files. This means new
  directories are picked up automatically without editing the manifest by hand.

  Steps:
    1. Generate manifest via sync-manifest.mjs
    2. Backup global files to .bak-YYYYMMDD-HHMMSS\
    3. Diff desktop vs global (SHA1 per file)
    4. Copy changed files
    5. Run npm install in global if package.json changed
    6. stdIO handshake check (initialize + tools/list)
    7. Print rollback command

.PARAMETER ManifestPath
  Override path to sync-manifest.mjs (default: scripts/sync-manifest.mjs in desktop root)

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\sync-to-global.ps1
  powershell -ExecutionPolicy Bypass -File scripts\sync-to-global.ps1 -DryRun
  powershell -ExecutionPolicy Bypass -File scripts\sync-to-global.ps1 -Force
#>
[CmdletBinding()]
param(
  [switch]$DryRun,
  [switch]$SkipTest,
  [switch]$Force,
  [string]$ManifestPath
)

$ErrorActionPreference = 'Stop'

# Force UTF-8 output so non-ASCII messages don't get garbled by legacy PowerShell
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

# ---- Paths ----
# 从脚本位置推导仓库根（scripts/ 的父目录），换机器/换用户名不用改本文件。
$Desktop = Split-Path -Parent $PSScriptRoot
# APPDATA 可能未被继承（如 commit_cpt 经 env 白名单启动 git 的 pre-push hook），兜底用 USERPROFILE 推导
if (-not $env:APPDATA) { $env:APPDATA = Join-Path $env:USERPROFILE 'AppData\Roaming' }
$Global  = Join-Path $env:APPDATA 'reasonix\mcp-servers\cpt-mcp'
if (-not $ManifestPath) { $ManifestPath = Join-Path $Desktop 'scripts\sync-manifest.mjs' }

if (-not (Test-Path $Desktop))      { Write-Error "Desktop dir not found: $Desktop"; exit 1 }
if (-not (Test-Path $Global))       { Write-Error "Global dir not found: $Global"; exit 1 }
if (-not (Test-Path $ManifestPath)) { Write-Error "Manifest script not found: $ManifestPath"; exit 1 }

# ---- 0. Generate manifest (auto-scan) ----
Write-Host "Generating sync manifest from $ManifestPath ..." -ForegroundColor Gray
$manifestRaw = node $ManifestPath --ps1 2>&1 | Out-String
if ($LASTEXITCODE -ne 0) {
  Write-Error "sync-manifest.mjs failed (exit $LASTEXITCODE): $manifestRaw"
  exit 1
}
# Parse: keep only lines that are single-quoted strings, drop comment lines starting with '#'
$FilesToSync = @()
foreach ($line in ($manifestRaw -split "`r?`n")) {
  $trim = $line.Trim()
  if ($trim -eq '') { continue }
  if ($trim.StartsWith('#')) { continue }
  if ($trim -match "^'([^']+)'$") { $FilesToSync += $Matches[1] }
  else { Write-Warning "manifest line ignored: $trim" }
}
Write-Host ("OK: manifest has {0} files (auto-scanned from {1})" -f $FilesToSync.Count, $Desktop) -ForegroundColor Green
if ($DryRun) {
  Write-Host ""
  Write-Host "Manifest preview (first 10):" -ForegroundColor Cyan
  $FilesToSync | Select-Object -First 10 | ForEach-Object { Write-Host "  $_" }
  Write-Host "  ... (truncated)" -ForegroundColor Gray
}

# ---- 1. Backup ----
$ts = Get-Date -Format 'yyyyMMdd-HHmmss'
$bakDir = Join-Path $Global ".bak-$ts"
if ($DryRun) {
  Write-Host ""
  Write-Host "[DRY-RUN] backup dir would be: $bakDir"
} else {
  New-Item -ItemType Directory -Path $bakDir -Force | Out-Null
  foreach ($f in $FilesToSync) {
    $src = Join-Path $Global $f
    if (Test-Path $src) {
      $dst = Join-Path $bakDir $f
      New-Item -ItemType Directory -Path (Split-Path $dst) -Force | Out-Null
      Copy-Item $src $dst -Force
    }
  }
  Write-Host "OK: backup created at $bakDir" -ForegroundColor Green
}

# ---- 2. Diff ----
$diffList = @()
foreach ($f in $FilesToSync) {
  $src = Join-Path $Desktop $f
  $dst = Join-Path $Global $f
  if (-not (Test-Path $src)) { continue }
  if (-not (Test-Path $dst)) {
    $diffList += [pscustomobject]@{ File = $f; Status = 'NEW' }
  } else {
    $a = (Get-FileHash $src -Algorithm SHA1).Hash
    $b = (Get-FileHash $dst -Algorithm SHA1).Hash
    if ($a -ne $b) { $diffList += [pscustomobject]@{ File = $f; Status = 'DIFF' } }
  }
}
if ($diffList.Count -eq 0) {
  if (-not $Force) {
    Write-Host "OK: desktop and global are in sync, nothing to do" -ForegroundColor Green
    exit 0
  }
  Write-Host "Force: copying entire manifest" -ForegroundColor Yellow
  foreach ($f in $FilesToSync) {
    if (Test-Path (Join-Path $Desktop $f)) { $diffList += [pscustomobject]@{ File = $f; Status = 'FORCE' } }
  }
}
Write-Host ""
Write-Host "Files to sync (Count=$($diffList.Count)):" -ForegroundColor Cyan
$diffList | Format-Table -AutoSize
if ($DryRun) { Write-Host "[DRY-RUN] end"; exit 0 }

# ---- 3. Copy ----
foreach ($row in $diffList) {
  $f = $row.File
  $src = Join-Path $Desktop $f
  $dst = Join-Path $Global $f
  # M1 路径安全: 拒绝包含 ..\ 或 / 跳出的路径, 防止 sync-manifest 被污染后写出 $Global 之外
  if ($f -match '(^|[\\/])\.\.([\\/]|$)') {
    Write-Error "manifest 路径含 '..', 拒绝同步 (path traversal 防御): $f"
    exit 2
  }
  # M1b: 拒绝 Windows 非法文件名字符 / 控制字符 / 绝对路径盘符或根路径
  # （只排危险形态，不做 ASCII 白名单 —— 文档名可能是中文，如 docs/cpt-mcp-业务流程审计.md）
  if ($f -match '[<>:"|?*\x00-\x1f]') {
    Write-Error "manifest 路径含非法字符, 拒绝同步: $f"
    exit 2
  }
  if ($f -match '^[A-Za-z]:[\\/]' -or $f -match '^[\\/]') {
    Write-Error "manifest 路径是绝对路径 (盘符/根路径), 拒绝同步: $f"
    exit 2
  }
  New-Item -ItemType Directory -Path (Split-Path $dst) -Force | Out-Null
  Copy-Item $src $dst -Force
  Write-Host "  copied: $f" -ForegroundColor Gray
}

# ---- 4. npm install if package.json changed ----
$pkgChanged = $diffList | Where-Object { $_.File -eq 'package.json' }
if ($pkgChanged) {
  Write-Host ""
  Write-Host "package.json changed -> running npm install in global" -ForegroundColor Yellow
  Push-Location $Global
  try { npm install 2>&1 | Select-Object -Last 5 | ForEach-Object { Write-Host "  $_" } }
  finally { Pop-Location }
}

# ---- 5. stdIO handshake + tool count ----
if ($SkipTest) { Write-Host "SkipTest: skipping verification"; exit 0 }

Write-Host ""
Write-Host "stdIO handshake check..." -ForegroundColor Yellow

# Write probe to a temp file (avoids heredoc escaping issues)
$tmp = Join-Path $env:TEMP ("cpt-mcp-sync-probe-" + [guid]::NewGuid().ToString('N') + ".mjs")
$probeJs = @'
import { spawn } from 'node:child_process';
const p = spawn(process.execPath, ['server.js'], { stdio: ['pipe','pipe','pipe'], cwd: process.cwd(), env: { ...process.env, CPT_MCP_TOOL_PROFILE: 'full' } });
let buf = '';
p.stdout.on('data', (b) => { buf += b.toString(); });
p.stderr.on('data', (b) => process.stderr.write(b));
const init = JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'sync-probe',version:'0.1'}}});
const noti = JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized',params:{}});
const list = JSON.stringify({jsonrpc:'2.0',id:2,method:'tools/list',params:{}});
p.stdin.write(init + '\n');
setTimeout(() => p.stdin.write(noti + '\n'), 500);
setTimeout(() => p.stdin.write(list + '\n'), 1000);
setTimeout(() => {
  p.kill();
  const m = buf.match(/"name":"([a-z_]+)"/g) || [];
  const uniq = [...new Set(m.map(s => s.match(/"name":"([^"]+)"/)[1]))];
  const ver = (buf.match(/"version":"([^"]+)"/) || ['','?'])[1];
  console.log('SERVER_VERSION:' + ver);
  console.log('TOOL_COUNT:' + uniq.length);
  console.log('TOOLS:' + uniq.sort().join(','));
  process.exit(0);
}, 2500);
'@
try {
  # Use [System.IO.File]::WriteAllText with UTF-8 (no BOM) to avoid PS5/PS7 incompatibility
  $utf8NoBom = New-Object System.Text.UTF8Encoding($False)
  [System.IO.File]::WriteAllText($tmp, $probeJs, $utf8NoBom)
  Push-Location $Global
  $out = node $tmp 2>&1 | Out-String
  Pop-Location
  Write-Host $out
  if ($out -match 'TOOL_COUNT:(\d+)') {
    $n = [int]$Matches[1]
    Write-Host "OK: stdIO handshake succeeded, tool count = $n" -ForegroundColor Green
    if ($n -lt 32) {
      Write-Error "Tool count too low ($n). Roll back: see backup at $bakDir"
      exit 2
    }
  } else {
    Write-Error "stdIO handshake failed. Backup: $bakDir"
    exit 2
  }
} finally {
  if (Test-Path $tmp) { Remove-Item $tmp -Force }
}

# ---- 6. Rollback hint ----
Write-Host ""
Write-Host "=== Sync complete ===" -ForegroundColor Green
Write-Host "Backup: $bakDir"
Write-Host "Rollback (if needed):"
Write-Host "  Copy-Item '$bakDir\*' '$Global\' -Recurse -Force" -ForegroundColor Yellow
Write-Host "Next reasonix desktop launch will auto-reconnect global cpt-mcp."
