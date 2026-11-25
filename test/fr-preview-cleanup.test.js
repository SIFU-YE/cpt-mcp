// cpt-mcp/test/fr-preview-cleanup.test.js —— 预览 runtime 审计/清理（2026-11-16）
//
// 背景：start/stop 一次预览后 runtime/（webapps 配置、logs、temp、work、finedb 副本）
// 会一直留在 .fr-preview；旧 stop 只 kill 进程，用户需要反复手工删。
// 本测试锁死：
//   1. previewArtifactAudit 能统计 runtime 真实文件/字节、识别 state 与残留 java；
//   2. cleanupPreviewRuntime 只删 runtime，保留 finedb-seed 与最后一次日志；
//   3. frPreviewStatus 始终带 cleanup 审计，not-running 时给出清理建议。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  frPreviewPaths,
  previewArtifactAudit,
  cleanupPreviewRuntime,
  frPreviewStatus,
  stopFrPreview,
} from '../lib/fr-preview.js';

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function write(file, content = 'x') {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

function withPreviewHome(root, fn) {
  return async () => {
    const prev = process.env.CPT_MCP_FR_PREVIEW_HOME;
    process.env.CPT_MCP_FR_PREVIEW_HOME = path.join(root, 'preview-home');
    try {
      await fn();
    } finally {
      if (prev === undefined) delete process.env.CPT_MCP_FR_PREVIEW_HOME;
      else process.env.CPT_MCP_FR_PREVIEW_HOME = prev;
      fs.rmSync(root, { recursive: true, force: true });
    }
  };
}

test('previewArtifactAudit：统计 runtime 文件/字节，标记 seed 与残留', withPreviewHome(tmpDir('fr-cleanup-audit-'), async () => {
  const paths = frPreviewPaths();
  write(path.join(paths.runtimeDir, 'webapps', 'webroot', 'x.txt'), 'runtime');
  write(path.join(paths.runtimeDir, 'logs', 'fr-preview.log'), 'log-line\n');
  write(path.join(paths.seedDir, 'db.script'), 'SEED');
  write(paths.stateFile, JSON.stringify({ pid: 999999, port: 1, startedAt: new Date().toISOString() }));

  const audit = previewArtifactAudit(paths);
  assert.equal(audit.runtimeExists, true);
  assert.ok(audit.runtimeFiles >= 2, '应统计 runtime 下两个真实文件');
  assert.ok(audit.runtimeBytes >= 7);
  assert.equal(audit.seedConfigured, true);
  assert.equal(audit.seedBytes >= 4, true);
  assert.equal(audit.hasLeftovers, true);
  assert.ok(audit.nextAction.includes('stop_fr_preview'));
}));

test('cleanupPreviewRuntime：删除 runtime、保留 finedb-seed 和最后一次日志', withPreviewHome(tmpDir('fr-cleanup-run-'), async () => {
  const paths = frPreviewPaths();
  write(path.join(paths.runtimeDir, 'webapps', 'webroot', 'x.txt'), 'runtime');
  write(path.join(paths.runtimeDir, 'logs', 'fr-preview.log'), 'last-log\n');
  write(path.join(paths.seedDir, 'db.script'), 'SEED');
  write(paths.stateFile, JSON.stringify({ pid: 999999, port: 1, startedAt: new Date().toISOString() }));

  const res = cleanupPreviewRuntime(paths, { force: true });
  assert.equal(res.ok, true);
  assert.equal(res.status, 'cleaned');
  assert.ok(res.removedFiles >= 2);
  assert.ok(res.freedBytes > 0);
  assert.equal(fs.existsSync(paths.runtimeDir), false, 'runtime 应被删除');
  assert.equal(fs.readFileSync(path.join(paths.seedDir, 'db.script'), 'utf8'), 'SEED', 'seed 必须保留');
  assert.ok(res.lastLog && fs.existsSync(res.lastLog), '最后一次日志应备份');
  assert.equal(fs.readFileSync(res.lastLog, 'utf8'), 'last-log\n');
  assert.equal(fs.existsSync(paths.stateFile), false, 'state.json 应清理');
}));

test('frPreviewStatus：not-running 时也带 cleanup 审计与清理提示', withPreviewHome(tmpDir('fr-cleanup-status-'), async () => {
  const paths = frPreviewPaths();
  write(path.join(paths.runtimeDir, 'temp', 'x.tmp'), 'runtime');
  const status = await frPreviewStatus();
  assert.equal(status.ok, true);
  assert.equal(status.status, 'not-running');
  assert.ok(status.cleanup && status.cleanup.runtimeFiles >= 1);
  assert.ok(status.hint.includes('clean:true'), '有残留时应提示清理');
}));

test('stopFrPreview({clean:true})：无实例时也清理 runtime，保留 seed', withPreviewHome(tmpDir('fr-cleanup-stop-'), async () => {
  const paths = frPreviewPaths();
  write(path.join(paths.runtimeDir, 'logs', 'fr-preview.log'), 'last-log\n');
  write(path.join(paths.runtimeDir, 'temp', 'x.tmp'), 'runtime');
  write(path.join(paths.seedDir, 'db.script'), 'SEED');
  const prevFR = process.env.FR_HOME;
  delete process.env.FR_HOME; // 确保走 no-instance + cleanup 分支，不受测试机 FR_HOME 影响
  try {
    const result = await stopFrPreview({ clean: true });
    assert.equal(result.cleaned, true);
    assert.equal(fs.existsSync(paths.runtimeDir), false, 'stop clean 应删除 runtime');
    assert.equal(fs.readFileSync(path.join(paths.seedDir, 'db.script'), 'utf8'), 'SEED');
    assert.ok(result.lastLog && fs.existsSync(result.lastLog));
  } finally {
    if (prevFR !== undefined) process.env.FR_HOME = prevFR;
  }
}));
