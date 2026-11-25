// test/fill-test-workflow.test.js —— 填报测试流程端到端（MCP 协议层）
//
// 串起：本地库建表/造数 → local_db_import({action:"report",writeAudit:true})
//      → 模拟预览写入 local_db_exec → write_audit 读写入次数
//      → simulate_fill 看跨 sheet staleKeys → get_fill_config matrix
// 证明各环节用的是同一个本地库/同一个 runId，而不是单测各自调用。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import '../scripts/isolate-store.mjs';
import { createCpt, addDataset, addSheet, addCell, addFillSubmit } from '../lib/generate.js';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-fill-flow-'));
const LOCALDB = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-fill-flow-db-'));
const DB = 'main';

function makeTemplate() {
  const p = path.join(TMP, 'flow.cpt');
  createCpt(p, { rows: 6, columns: 5, webWrite: true });
  addDataset(p, { name: 'ds1', connection: 'demo_conn', sql: 'SELECT id, source_type, v FROM fill_target_demo' });
  addSheet(p, { sheetName: 's2', rows: 6, columns: 5 });
  addCell(p, { column: 0, row: 1, widget: 'text' });
  addCell(p, { column: 2, row: 1, widget: 'text' });
  addCell(p, { column: 0, row: 1, widget: 'text', sheet: 1 });
  addCell(p, { column: 2, row: 1, widget: 'text', sheet: 1 });
  addFillSubmit(p, {
    dsName: 'demo_conn', table: 'fill_target_demo', name: '提交A', sheet: 0,
    bindings: [
      { field: 'id', isKey: true, column: 0, row: 1 },
      { field: 'source_type', constant: 'A' },
      { field: 'v', column: 2, row: 1 },
    ],
  });
  addFillSubmit(p, {
    dsName: 'demo_conn', table: 'fill_target_demo', name: '提交B', sheet: 1,
    bindings: [
      { field: 'id', isKey: true, column: 0, row: 1 },
      { field: 'source_type', constant: 'B' },
      { field: 'v', column: 2, row: 1 },
    ],
  });
  return p;
}

async function withServer(fn) {
  const client = new Client({ name: 'fill-flow-test', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['server.js'],
    cwd: process.cwd(),
    stderr: 'pipe',
    env: {
      ...process.env,
      CPT_MCP_TOOL_PROFILE: 'full',
      CPT_MCP_LOCALDB_DIR: LOCALDB,
      CPT_MCP_ALLOWED_ROOTS: TMP,
    },
  });
  await client.connect(transport);
  const call = async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: args });
    const text = r.content?.[0]?.text ?? '';
    let data = null;
    try { data = JSON.parse(text); } catch { /* 非 JSON 报错 */ }
    return { isError: r.isError === true, text, data };
  };
  try { return await fn({ call }); } finally { await client.close(); }
}

test('MCP 全链路：prepare 返回 runId → 写目标表 → write_audit 计数 → simulate staleKeys', async () => {
  const p = makeTemplate();
  await withServer(async ({ call }) => {
    let r = await call('local_db_admin', { action: 'create', db: DB });
    assert.equal(r.isError, false, r.text);
    r = await call('local_db_import', {
      action: 'ddl', db: DB,
      ddl: 'CREATE TABLE fill_target_demo (id INTEGER PRIMARY KEY, source_type TEXT, v TEXT)',
    });
    assert.equal(r.isError, false, r.text);
    r = await call('local_db_import', { action: 'seed', db: DB, table: 'fill_target_demo', rows: [{ id: 1, source_type: 'A', v: 'old' }] });
    assert.equal(r.isError, false, r.text);

    // ① prepare 报表环境 + 装写审计
    r = await call('local_db_import', { action: 'report', db: DB, path: p, writeAudit: true });
    assert.equal(r.isError, false, r.text);
    assert.equal(r.data?.ok, true, r.text.slice(0, 800));
    const runId = r.data?.writeAudit?.runs?.[0]?.runId;
    assert.ok(runId, `prepare 必须返回 writeAudit.runId：${r.text.slice(0, 800)}`);
    assert.equal(r.data.writeAudit.enabled, true);

    // ② 模拟预览进程写入本地 SQLite（不用 audit:true；触发器应挂到同一个 active run）
    r = await call('local_db_exec', {
      db: DB, mode: 'exec', allowWrite: true,
      sql: "UPDATE fill_target_demo SET v='preview-write' WHERE id=1",
    });
    assert.equal(r.isError, false, r.text);
    assert.equal(r.data?.changes, 1);

    // ③ 读 write_audit：必须看到上面的写入
    r = await call('local_db_admin', { action: 'write_audit', db: DB, runId });
    assert.equal(r.isError, false, r.text);
    assert.equal(r.data?.runId, runId);
    assert.equal(r.data?.enabled, true);
    assert.ok(r.data.totals.writeEvents >= 1, JSON.stringify(r.data));
    assert.ok(r.data.totals.updates >= 1, JSON.stringify(r.data));
    assert.equal(r.data.tables[0].afterRows, 1);
    assert.equal(r.data.bySheetHint.some((x) => x.sheetHint === 'A'), true, JSON.stringify(r.data.bySheetHint));

    // ③b audit:true 不应把 prepare 的 active run 顶掉，而是复用同一个 run
    r = await call('local_db_exec', {
      db: DB, mode: 'exec', allowWrite: true, audit: true,
      sql: "UPDATE fill_target_demo SET v='audit-exec' WHERE id=1",
    });
    assert.equal(r.isError, false, r.text);
    assert.equal(r.data?.writeAuditReusedActiveRun, true, JSON.stringify(r.data).slice(0, 600));
    assert.equal(r.data?.writeAudit?.runId, runId);
    r = await call('local_db_admin', { action: 'write_audit', db: DB, runId });
    assert.ok(r.data.totals.updates >= 2, JSON.stringify(r.data.totals));

    // ④ 试写两个 sheet 同目标：应报告 stale key，并回滚
    r = await call('local_db_admin', {
      action: 'simulate_fill', db: DB, path: p,
      scenario: { 0: [{ id: 1, v: 'new-A' }], 1: [{ id: 1, v: 'old-B' }] },
    });
    assert.equal(r.isError, false, r.text);
    assert.equal(r.data?.rolledBack, true);
    assert.equal(r.data?.totals?.staleKeys, 1, JSON.stringify(r.data?.totals));
    assert.equal(r.data?.totals?.writeEvents, 2);
    assert.ok(r.data.warnings.some((w) => w.code === 'FILL_STALE_ROW_RISK'));

    // 模拟后本地仍是 preview-write（没有落库）
    r = await call('local_db_exec', { db: DB, sql: 'SELECT v FROM fill_target_demo WHERE id=1' });
    assert.equal(r.isError, false, r.text);
    assert.equal(r.data.rows[0].v, 'audit-exec');

    // ⑤ 拓扑矩阵与准备/审计使用同一模板
    r = await call('get_fill_config', { path: p, view: 'matrix' });
    assert.equal(r.isError, false, r.text);
    assert.equal(r.data.summary.sharedTargets, 1);
    assert.equal(r.data.summary.highRiskTargets, 1);

    // ⑥ validate/quality 能看到同一风险，且不阻断结构门禁
    r = await call('validate_cpt', { path: p });
    assert.equal(r.isError, false, r.text);
    assert.ok(r.data.issues.some((i) => i.code === 'FILL_SHARED_TARGET'), JSON.stringify(r.data.issues));

    r = await call('quality_gate_cpt', { path: p, localSqlAudit: false });
    assert.equal(r.isError, false, r.text);
    assert.equal(r.data.pass, true, JSON.stringify(r.data.blockers));
    assert.equal(r.data.fillRuntime.sharedTargets, 1, JSON.stringify(r.data.fillRuntime));
    assert.ok(r.data.advisories.some((w) => w.code === 'fill_shared_target'), JSON.stringify(r.data.advisories));
  });
});
