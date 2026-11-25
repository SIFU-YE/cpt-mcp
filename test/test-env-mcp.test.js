// test/test-env-mcp.test.js —— 2026-11-04 测试环境改造的 MCP 协议层端到端
//
// 覆盖用户口径：
//   ① 测试环境默认 SQLite：run_dataset_sql_check 不传 target 时 target=local / targetSource=default；
//      真实库须显式 target:"real"；本地库未建返回 localDbReady:false + 可执行 nextAction（不静默连真实库）。
//   ② 真实库按需抽样：local_db_import({action:"auto"}) 在无真实连接时返回结构化 error + nextAction，不崩溃。
//   ③ Excel 导入离线仿真：local_db_import({action:"excel"}) 校验按钮/列位/表头并在本地 SQLite
//      事务内 INSERT 后 ROLLBACK（本地表行数不变）。
//   ④ quality_gate_cpt 本地库未建时给 info advisory（不阻断 pass/blockers）。
//
// 原则：不联网、不连真实库、不依赖本机 FR；模板/xlsx 落在 mkdtemp 临时目录，
// 本地库由 CPT_MCP_LOCALDB_DIR 指向另一临时目录（scripts/isolate-store.mjs 同时兜底隔离）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { REPORT_STATIC_TOOLS } from '../lib/contract.js';
import '../scripts/isolate-store.mjs';
import { createCpt, addCell, addDataset, addFillSubmit } from '../lib/generate.js';
import { setFillToolbar } from '../lib/edits.js';
import { buildXlsx, STYLES, rowXml, cellXml } from './fixtures/excel-import/xlsx-builder.js';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-testenv-mcp-tpl-'));
// 2026-11-05：本地库根放进私有 base 的 .cpt-mcp/localdb（与生产同构），
// 否则 localdb.json 会落到共享的 %TEMP%/localdb.json，被其它套件/历史残留串味。
const LOCALDB_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-testenv-mcp-root-'));
const LOCALDB = path.join(LOCALDB_ROOT, '.cpt-mcp', 'localdb');
fs.mkdirSync(LOCALDB, { recursive: true });
const DB = 'main';
test.after(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
  try { fs.rmSync(LOCALDB, { recursive: true, force: true }); } catch { /* ignore */ }
});

let seq = 0;
function sqlTemplate(sql, bindings = ['sku_code']) {
  seq += 1;
  const p = path.join(TMP, `t${seq}.cpt`);
  createCpt(p, { rows: 6, columns: 6 });
  addDataset(p, { name: 'ds1', connection: 'Doris', sql });
  bindings.forEach((col, i) => addCell(p, { column: i, row: 1, contentType: 'dsColumn', dsName: 'ds1', columnName: col }));
  return p;
}

/** 填报表模板：表头 row=0、数据行 row=1（0 基）；绑定 + 填报工具栏「导入Excel」按钮 */
function fillTemplate() {
  seq += 1;
  const p = path.join(TMP, `fill${seq}.cpt`);
  createCpt(p, { rows: 12, columns: 8, webWrite: true });
  addDataset(p, { name: 'ds1', connection: 'Doris', sql: 'SELECT 1' });
  ['ID', '姓名', '数量'].forEach((h, i) => addCell(p, { column: i, row: 0, content: h, contentType: 'text' }));
  const bindings = [
    { field: 'id', column: 0, isKey: true, widget: 'text' },
    { field: 'name', column: 1, widget: 'text' },
    { field: 'qty', column: 2, widget: 'number' },
  ];
  for (const b of bindings) {
    addCell(p, { column: b.column, row: 1, contentType: 'dsColumn', dsName: 'ds1', columnName: b.field, widget: b.widget });
  }
  addFillSubmit(p, {
    dsName: 'Doris', schema: 'bi_ads', table: 'ods_t', name: '提交',
    bindings: bindings.map((b) => ({ field: b.field, column: b.column, row: 1, isKey: b.isKey === true })),
  });
  setFillToolbar(p, { buttons: ['submit', 'import-append'] });
  return p;
}

/** 标准 xlsx：第 1 行表头、第 2 行起数据（与模板 0 基 row=1 对齐） */
function writeXlsx() {
  const headers = ['ID', '姓名', '数量'];
  const rows = [['k1', '张三', 3], ['k2', '李四', 4]];
  const content = [
    rowXml(1, headers.map((h, i) => cellXml.text(`${String.fromCharCode(65 + i)}1`, h))),
    ...rows.map((r, ri) => rowXml(ri + 2, r.map((v, ci) => {
      const ref = `${String.fromCharCode(65 + ci)}${ri + 2}`;
      return typeof v === 'number' ? cellXml.number(ref, v) : cellXml.text(ref, v);
    }))),
  ].join('');
  seq += 1;
  const file = path.join(TMP, `book${seq}.xlsx`);
  fs.writeFileSync(file, buildXlsx({ sheets: [{ name: 'Sheet1', content }], styles: STYLES }));
  return file;
}

async function withServer(env, fn) {
  const client = new Client({ name: 'test-env-mcp', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['server.js'],
    cwd: process.cwd(),
    stderr: 'pipe',
    env: {
      CPT_MCP_LOCALDB_DIR: LOCALDB,
      CPT_MCP_ALLOWED_ROOTS: TMP,
      CPT_MCP_SQL_TARGET: '', // 显式置空：确保走 default 分支，不受宿主环境影响
      CPT_DB_DISABLE_CONFIG_FILES: '1',
      CPT_MCP_HOT_RELOAD: '0',
      ...env,
    },
  });
  await client.connect(transport);
  const call = async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: args });
    const text = r.content?.[0]?.text ?? '';
    let data = null;
    try { data = JSON.parse(text); } catch { /* 非 JSON 报错文案 */ }
    return { isError: r.isError === true, text, data };
  };
  const list = async () => (await client.listTools()).tools;
  try {
    return await fn({ client, call, list });
  } finally {
    await client.close();
  }
}

test('report 档静态工具数与 REPORT_STATIC_TOOLS 一致（不新增工具、不吃 report 预算）', async () => {
  await withServer({ CPT_MCP_TOOL_PROFILE: 'report' }, async ({ list }) => {
    const tools = await list();
    assert.equal(tools.length, REPORT_STATIC_TOOLS.length, `report 静态工具数应为 ${REPORT_STATIC_TOOLS.length}，实际 ${tools.length}`);
    const names = tools.map((t) => t.name);
    assert.ok(names.includes('run_dataset_sql_check'));
    assert.ok(!names.includes('local_db_import'), '本地库工具仍属租约族，不静态可见');
    const rsc = tools.find((t) => t.name === 'run_dataset_sql_check');
    assert.ok(rsc.inputSchema.properties.target, 'target 参数仍暴露');
    assert.equal(rsc.inputSchema.properties.target.default, undefined, 'target 不应再有 default="real"（缺省由解析层决定）');
  });
});

test('缺省 target=local（不静默连真实库）+ 本地库未建给 nextAction', async () => {
  await withServer({ CPT_MCP_TOOL_PROFILE: 'full' }, async ({ call }) => {
    const p = sqlTemplate('SELECT sku_code FROM ods_sku');
    // 本地库未建：明确 localDbReady=false，且 nextAction 含租约/建库/auto 步骤
    const missing = await call('run_dataset_sql_check', { path: p, datasetName: 'ds1' });
    assert.equal(missing.isError, false, missing.text.slice(0, 400));
    assert.equal(missing.data.target, 'local');
    assert.equal(missing.data.targetSource, 'default');
    assert.equal(missing.data.targetRequested, null);
    assert.equal(missing.data.localDbReady, false);
    assert.match(String(missing.data.nextAction), /request_deep_tool_access/);
    assert.match(String(missing.data.nextAction), /local_db_import\(\{ action: "auto"/);
    assert.ok(!/连接.*真实库|No database selected/.test(String(missing.data.error || '')), '不得因本地缺库改连真实库');

    // 显式 target=real 才打真实库（本测试禁用了配置 → 必须是连接配置类错误，而不是本地结果）
    const real = await call('run_dataset_sql_check', { path: p, datasetName: 'ds1', target: 'real' });
    const realText = `${real.text}`;
    assert.ok(real.isError || real.data?.ok === false, '真实库未配置时应失败');
    assert.match(realText, /连接|configured|CPT_DB|db-connections/i, realText.slice(0, 400));
  });
});

test('本地库就绪后缺省 target=local 直接跑 SQL 并核对绑定列', async () => {
  await withServer({ CPT_MCP_TOOL_PROFILE: 'full' }, async ({ call }) => {
    const created = await call('local_db_admin', { action: 'create', db: DB });
    assert.equal(created.isError, false, created.text.slice(0, 200));
    const ddl = await call('local_db_import', {
      action: 'ddl', db: DB,
      ddl: 'CREATE TABLE ods_sku (sku_code varchar(32) NOT NULL, sku_name varchar(64), qty int);',
    });
    assert.equal(ddl.isError, false, ddl.text.slice(0, 300));
    const seed = await call('local_db_import', {
      action: 'seed', db: DB, table: 'ods_sku', mode: 'insert',
      rows: [{ sku_code: 'SKU-1', sku_name: '商品一', qty: 3 }, { sku_code: 'SKU-2', sku_name: '商品二', qty: 0 }],
    });
    assert.equal(seed.isError, false, seed.text.slice(0, 300));

    const p = sqlTemplate('SELECT sku_code FROM ods_sku WHERE qty > 0');
    const r = await call('run_dataset_sql_check', { path: p, datasetName: 'ds1', localDb: DB });
    assert.equal(r.isError, false, r.text.slice(0, 400));
    assert.equal(r.data.target, 'local');
    assert.equal(r.data.targetSource, 'default');
    assert.equal(r.data.localDbReady, true);
    assert.equal(r.data.ok, true, r.text.slice(0, 400));
    assert.deepEqual(r.data.bindingCheck.missingInSql, []);
    const rows = r.data.execution?.rows ?? r.data.rows ?? r.data.sampleRows ?? [];
    assert.equal(rows[0]?.sku_code, 'SKU-1', JSON.stringify(r.data).slice(0, 500));

    // 2026-11-05 缺口补齐：verify_cpt 现在默认带本地 SQL 审计层（此前只调 qualityGate(abs) 不带审计）
    const ver = await call('verify_cpt', { path: p, engine: false });
    assert.equal(ver.isError, false, ver.text.slice(0, 400));
    const verLayers = Object.fromEntries(ver.data.layers.map((l) => [l.id, l.status]));
    assert.equal(verLayers.local_sql, 'pass', JSON.stringify(ver.data.layers).slice(0, 500));
    assert.equal(ver.data.localSqlAuditStatus.enabled, true);
    assert.equal(ver.data.localSqlAuditStatus.db, DB);

    // 本地库在、SQL 语法错 → verify_cpt 必须 fail（旧实现会漏掉这一层）
    // 2026-11-09：报表级测试环境 action:"report" 能复用本地已有表；runtime 明确 unverified
    const rep = await call('local_db_import', { action: 'report', db: DB, path: p });
    assert.equal(rep.isError, false, rep.text.slice(0, 500));
    assert.equal(rep.data.ok, true, JSON.stringify(rep.data.missing));
    assert.equal(rep.data.kind, 'existing');
    assert.equal(rep.data.runtime.status, 'unverified');

    const bad = sqlTemplate('SELEC sku_code FROM ods_sku');
    const verBad = await call('verify_cpt', { path: bad, engine: false });
    assert.equal(verBad.isError, false, verBad.text.slice(0, 300));
    assert.equal(verBad.data.ok, false);
    const badLayers = Object.fromEntries(verBad.data.layers.map((l) => [l.id, l.status]));
    assert.equal(badLayers.local_sql, 'fail', JSON.stringify(verBad.data.layers).slice(0, 500));
    assert.ok(
      verBad.data.blockers.some((b) => /SQLite 语法/.test(String(b.message))),
      JSON.stringify(verBad.data.blockers).slice(0, 600),
    );
  });
});

test('local_db_import({action:"auto"}) 无真实连接：结构化 error + 纯离线 nextAction，不崩溃', async () => {
  await withServer({ CPT_MCP_TOOL_PROFILE: 'full' }, async ({ call }) => {
    const p = sqlTemplate('SELECT sku_code FROM ods_sku');
    const r = await call('local_db_import', {
      action: 'auto', db: 'auto_db', connection: 'Doris', path: p,
    });
    assert.equal(r.isError, false, r.text.slice(0, 400));
    assert.equal(r.data.ok, false);
    assert.ok(r.data.error?.code, JSON.stringify(r.data.error));
    assert.match(String(r.data.nextAction), /action: "ddl"/);
    assert.match(String(r.data.nextAction), /action: "seed"/);
  });
});

test('local_db_import({action:"excel"})：按钮/列位校验 + 本地事务试插后回滚（行数不变）', async () => {
  await withServer({ CPT_MCP_TOOL_PROFILE: 'full' }, async ({ call }) => {
    const p = fillTemplate();
    const xlsx = writeXlsx();
    const created = await call('local_db_admin', { action: 'create', db: `${DB}_excel` });
    assert.equal(created.isError, false, created.text.slice(0, 200));
    const ddl = await call('local_db_import', {
      action: 'ddl', db: `${DB}_excel`,
      ddl: 'CREATE TABLE ods_t (id varchar(64) PRIMARY KEY, name varchar(64) NOT NULL, qty int);',
    });
    assert.equal(ddl.isError, false, ddl.text.slice(0, 300));

    const r = await call('local_db_import', {
      action: 'excel', db: `${DB}_excel`, path: p, excelFile: xlsx, simulate: true,
    });
    assert.equal(r.isError, false, r.text.slice(0, 500));
    assert.equal(r.data.ok, true, JSON.stringify(r.data.issues).slice(0, 500));
    assert.equal(r.data.import.buttonFound, true);
    assert.equal(r.data.import.mode, 'append');
    assert.equal(r.data.mapping.filter((m) => m.field).length, 3);
    assert.equal(r.data.simulation.attempted, true);
    assert.equal(r.data.simulation.rolledBack, true);
    assert.equal(r.data.simulation.inserted, 2);

    // 事务回滚证据：本地目标表仍 0 行
    const count = await call('local_db_exec', { db: `${DB}_excel`, sql: 'SELECT COUNT(*) AS c FROM ods_t' });
    assert.equal(count.isError, false, count.text.slice(0, 300));
    assert.equal(Number(count.data.rows[0].c), 0, '仿真必须回滚，不得落库');

    // 2026-11-05 缺口补齐：verify_cpt 对「含导入按钮的模板」必须给出 excel_import 提示层
    const ver = await call('verify_cpt', { path: p, engine: false });
    assert.equal(ver.isError, false, ver.text.slice(0, 400));
    const verLayers = Object.fromEntries(ver.data.layers.map((l) => [l.id, l.status]));
    assert.equal(verLayers.excel_import, 'skipped', JSON.stringify(ver.data.layers).slice(0, 600));
    assert.equal(ver.data.excelImport.total, 1);
    assert.match(String(ver.data.nextAction), /local_db_import\(\{action:"excel"/);

    // 2026-11-04 P1 回归：excelFile 必须受 CPT_MCP_ALLOWED_ROOTS 围栏（独立验收发现）
    const outside = path.join(TMP, '..', `outside-${Date.now()}.xlsx`);
    fs.writeFileSync(outside, 'not-a-real-xlsx');
    try {
      const denied = await call('local_db_import', {
        action: 'excel', db: `${DB}_excel`, path: p, excelFile: outside,
      });
      assert.equal(denied.isError, true, denied.text.slice(0, 300));
      assert.match(denied.text, /安全围栏|允许目录/);
    } finally {
      try { fs.rmSync(outside, { force: true }); } catch { /* ignore */ }
    }
  });
});

test('quality_gate_cpt：本地库未建时给 info advisory（nextAction），不改 pass/blockers', async () => {
  // 独立空本地库根：本文件前面的用例建过 main 库，这里必须保证「未建库」场景
  await withServer({ CPT_MCP_TOOL_PROFILE: 'report', CPT_MCP_LOCALDB_DIR: path.join(LOCALDB, 'gate-empty') }, async ({ call }) => {
    const p = sqlTemplate('SELECT sku_code FROM ods_sku');
    const before = await call('validate_cpt', { path: p });
    assert.equal(before.isError, false, before.text.slice(0, 300));
    const gate = await call('quality_gate_cpt', { path: p });
    assert.equal(gate.isError, false, gate.text.slice(0, 400));
    assert.equal(gate.data.localSqlAuditStatus.enabled, false);
    const skipped = (gate.data.advisories || []).find((a) => a.code === 'local_sql_audit_skipped');
    assert.ok(skipped, `应出现 local_sql_audit_skipped advisory：${JSON.stringify(gate.data.advisories).slice(0, 500)}`);
    assert.match(String(skipped.nextAction), /local_db_admin/);
    assert.equal(gate.data.pass, true, '环境问题不得阻断结构门槛');
  });
});
