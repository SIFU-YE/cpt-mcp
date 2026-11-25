// test/verify-local-sql.test.js —— 2026-11-05 补 MCP 缺口：verify_cpt 本地 SQL 层 + 内置按钮 facts
//
// 背景（审计 P0-B / P0-C1）：
//   ① verify_cpt 原先只调 qualityGate(abs) 不带 localSqlAudit → 本地库已建时 SQL 语法错/
//      绑定列缺失会被 verify 漏掉，模型看到 verify pass 就以为"SQL 也验过"。
//   ② templateFacts 的 builtinToolbarButtons 旧正则数的是 com.fr.form.ui.*ToolBarButton，
//      而 FR 内置按钮 class 在 com.fr.report.web.button.* → 恒为 0；Excel 导入按钮完全不可见。
//
// 本测试原则：不联网、不写工作区外文件（模板在 mkdtemp；本地库由 isolate-store 隔离到私有临时目录）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import '../scripts/isolate-store.mjs';
import { createCpt, addCell, addDataset } from '../lib/generate.js';
import { addToolbarButton } from '../lib/edits.js';
import { createLocalDb, dropLocalDb, localDbConfigPath, updateLocalDbConfig } from '../lib/localdb.js';
import { importDdlIntoLocalDb, seedLocalDb } from '../lib/localdb-import.js';
import { templateFacts, verifyCpt, selfCheckSummary } from '../lib/verify.js';

let seq = 0;
const freshDbName = (prefix = 'vls') => {
  seq += 1;
  return `${prefix}${seq}_${Date.now().toString(36)}`.slice(0, 60);
};
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-verify-local-sql-'));

/** 带 SQL 数据集 + 绑定列的模板 */
function sqlTemplate(dir, { name = 'sql.cpt', sql = 'SELECT sku_code, sku_name FROM ods_sku', bindings = ['sku_code', 'sku_name'], connection = 'Doris' } = {}) {
  const p = path.join(dir, name);
  createCpt(p, { rows: 4, columns: 4 });
  addDataset(p, { name: 'ds1', connection, sql });
  bindings.forEach((col, i) => addCell(p, { column: i, row: 1, contentType: 'dsColumn', dsName: 'ds1', columnName: col }));
  return p;
}

function cleanConfig() {
  try { fs.rmSync(localDbConfigPath(), { force: true }); } catch { /* ignore */ }
}

function makeLocalDb(db, ddl = 'CREATE TABLE ods_sku (sku_code varchar(32) NOT NULL, sku_name varchar(64), qty int);') {
  createLocalDb(db);
  updateLocalDbConfig({ default: db, databases: { [db]: { file: `${db}.sqlite`, sourceConnection: 'Doris' } } });
  importDdlIntoLocalDb({ db, ddl });
  seedLocalDb({ db, table: 'ods_sku', rows: [
    { sku_code: 'SKU-1', sku_name: '商品一', qty: 3 },
    { sku_code: 'SKU-2', sku_name: '商品二', qty: 0 },
  ] });
}

const layersById = (v) => Object.fromEntries(v.layers.map((l) => [l.id, l]));

// ============================== facts：内置按钮 ==============================

test('templateFacts：内置工具栏按钮按 com.fr.report.web.button.* 计数（旧正则恒 0 已修）', () => {
  const dir = tmp();
  try {
    const p = path.join(dir, 'btn.cpt');
    createCpt(p, { rows: 4, columns: 4, webWrite: true });
    addToolbarButton(p, { builtin: 'import-append' });
    addToolbarButton(p, { builtin: 'import-clean' });
    const f = templateFacts(p);
    assert.equal(f.toolbarButtons, 0, '这两个是内置按钮，不是自定义按钮');
    assert.equal(f.builtinToolbarButtons, 2);
    assert.ok(f.builtinToolbarButtonClasses.includes('com.fr.report.web.button.write.ImExcelAppend'));
    assert.ok(f.builtinToolbarButtonClasses.includes('com.fr.report.web.button.write.ImExcelClean'));
    assert.deepEqual(f.excelImportButtons, { append: 1, clean: 1, legacy: 0, total: 2 });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('templateFacts：标记/自定义导入按钮单独识别（ImportExcelData / CustomizeImportExcelData）', () => {
  const dir = tmp();
  try {
    const p = path.join(dir, 'legacy.cpt');
    createCpt(p, { rows: 4, columns: 4, webWrite: true });
    addToolbarButton(p, { builtin: 'import-append' });
    // 把普通导入按钮改成 FR 的标记导入按钮（真实模板里存在，语义不同）
    const raw = fs.readFileSync(p, 'utf8').replace(
      'com.fr.report.web.button.write.ImExcelAppend',
      'com.fr.report.web.button.write.ImportExcelData',
    );
    fs.writeFileSync(p, raw, 'utf8');
    const f = templateFacts(p);
    assert.equal(f.builtinToolbarButtons, 1);
    assert.deepEqual(f.excelImportButtons, { append: 0, clean: 0, legacy: 1, total: 1 });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ============================== verify_cpt：本地 SQL 层 ==============================

test('verifyCpt(localSqlAudit) 本地库未建：local_sql 层 skipped + nextAction，不假 pass/不阻断', async () => {
  const dir = tmp();
  try {
    cleanConfig();
    const p = sqlTemplate(dir);
    const v = await verifyCpt(p, { localSqlAudit: true });
    const layers = layersById(v);
    assert.ok(layers.local_sql, JSON.stringify(v.layers));
    assert.equal(layers.local_sql.status, 'skipped');
    assert.equal(v.localSqlAuditStatus.enabled, false);
    assert.match(String(v.localSqlAuditStatus.reason), /未初始化/);
    assert.match(String(v.nextAction), /local_db_import\(\{action:"auto"/);
    assert.equal(v.ok, true, '缺库只跳过，不阻断交付');
    assert.equal(v.layers.some((l) => l.id === 'gate' && l.status === 'fail'), false);
  } finally {
    cleanConfig();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('verifyCpt(localSqlAudit) 本地库就绪：好 SQL → local_sql pass（带 db/datasets 证据）', async () => {
  const dir = tmp();
  const db = freshDbName();
  try {
    cleanConfig();
    makeLocalDb(db);
    const p = sqlTemplate(dir);
    const v = await verifyCpt(p, { localSqlAudit: true });
    const layers = layersById(v);
    assert.equal(layers.local_sql.status, 'pass', JSON.stringify(layers.local_sql));
    assert.equal(v.localSqlAuditStatus.enabled, true);
    assert.equal(v.localSqlAuditStatus.db, db);
    assert.equal(v.localSqlAuditStatus.datasets, 1);
    assert.equal(v.ok, true, JSON.stringify(v.blockers));
  } finally {
    dropLocalDb(db, { confirm: true });
    cleanConfig();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('verifyCpt(localSqlAudit) 本地库就绪：SQL 语法错 → local_sql fail + blocker（此前会被 verify 漏掉）', async () => {
  const dir = tmp();
  const db = freshDbName();
  try {
    cleanConfig();
    makeLocalDb(db);
    const p = sqlTemplate(dir, { sql: 'SELEC sku_code FROM ods_sku', bindings: ['sku_code'] });
    const v = await verifyCpt(p, { localSqlAudit: true });
    const layers = layersById(v);
    assert.equal(layers.local_sql.status, 'fail');
    assert.equal(v.ok, false);
    assert.ok(v.blockers.some((b) => /本地 SQL|SQLite 语法/.test(b.message)), JSON.stringify(v.blockers).slice(0, 600));
    assert.equal(v.localSqlAuditStatus.enabled, true);
  } finally {
    dropLocalDb(db, { confirm: true });
    cleanConfig();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('verifyCpt 不传 localSqlAudit 时行为不变：没有 local_sql 层（写工具 selfCheck 不加重）', async () => {
  const dir = tmp();
  const db = freshDbName();
  try {
    cleanConfig();
    makeLocalDb(db);
    const p = sqlTemplate(dir);
    const v = await verifyCpt(p);
    assert.equal(v.layers.some((l) => l.id === 'local_sql'), false);
    assert.equal(v.localSqlAuditStatus, undefined);
    const sc = await selfCheckSummary(p);
    assert.equal(sc.layers.local_sql, undefined);
  } finally {
    dropLocalDb(db, { confirm: true });
    cleanConfig();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ============================== verify_cpt：Excel 导入预检提示 ==============================

test('verifyCpt：模板含普通导入按钮 → excel_import 层 skipped + 指向 action:"excel"', async () => {
  const dir = tmp();
  try {
    const p = path.join(dir, 'imp.cpt');
    createCpt(p, { rows: 6, columns: 6, webWrite: true });
    addToolbarButton(p, { builtin: 'import-append' });
    const v = await verifyCpt(p);
    const layers = layersById(v);
    assert.ok(layers.excel_import, JSON.stringify(v.layers));
    assert.equal(layers.excel_import.status, 'skipped');
    assert.match(layers.excel_import.detail, /普通导入/);
    assert.deepEqual(v.excelImport, { append: 1, clean: 0, legacy: 0, total: 1 });
    assert.match(String(v.nextAction), /local_db_import\(\{action:"excel"/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('verifyCpt：标记/自定义导入按钮 → 明确说"离线仿真不覆盖，必须 FR 预览"', async () => {
  const dir = tmp();
  try {
    const p = path.join(dir, 'legacy.cpt');
    createCpt(p, { rows: 6, columns: 6, webWrite: true });
    addToolbarButton(p, { builtin: 'import-clean' });
    const raw = fs.readFileSync(p, 'utf8').replace(
      'com.fr.report.web.button.write.ImExcelClean',
      'com.fr.report.web.button.write.CustomizeImportExcelData',
    );
    fs.writeFileSync(p, raw, 'utf8');
    const v = await verifyCpt(p);
    const layers = layersById(v);
    assert.equal(layers.excel_import.status, 'skipped');
    assert.match(layers.excel_import.detail, /标记\/自定义导入/);
    assert.match(layers.excel_import.detail, /FR 预览/);
    assert.match(String(v.nextAction), /标记\/自定义导入/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('verifyCpt：没有导入按钮 → 不出现 excel_import 层（零噪声）', async () => {
  const dir = tmp();
  try {
    const p = path.join(dir, 'plain.cpt');
    createCpt(p, { rows: 4, columns: 4, webWrite: true });
    const v = await verifyCpt(p);
    assert.equal(v.layers.some((l) => l.id === 'excel_import'), false);
    assert.equal(v.excelImport, undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ================= 2026-11-05 P1-3/P1-4：审计噪音与覆盖口径 =================

test('verifyCpt：参数化 SQL 的 masked_params 属信息提示，不把 local_sql 层/整体状态降成 warn（P1-3）', async () => {
  const dir = tmp();
  const db = freshDbName();
  try {
    cleanConfig();
    makeLocalDb(db);
    // 公式型参数落表达式位：SQLite 无法直接 prepare NULL 占位，审计会用 formula-empty 占位策略
    const p = sqlTemplate(dir, {
      sql: 'SELECT sku_code FROM ods_sku WHERE 1=1 ${if(len(dept)=0,"","AND qty > 0")}',
      bindings: ['sku_code'],
    });
    const v = await verifyCpt(p, { localSqlAudit: true });
    const layers = layersById(v);
    assert.equal(layers.local_sql.status, 'pass', JSON.stringify(layers.local_sql));
    assert.equal(layers.gate.status, 'pass', JSON.stringify(layers.gate));
    assert.equal(v.status, 'pass', JSON.stringify(v.layers).slice(0, 800));
    assert.equal(
      v.warnings.some((w) => /masked|占位|公式/.test(String(w.message))),
      false,
      `参数占位提示不应升级为 verify.warnings：${JSON.stringify(v.warnings)}`,
    );
    assert.equal(v.localSqlAuditStatus.datasetsChecked, 1, '参数化 SQL 也应算已检查（占位后 prepare 通过）');
  } finally {
    dropLocalDb(db, { confirm: true });
    cleanConfig();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('verifyCpt：库存在但 0 表 → checked=0（不虚报覆盖），本地 SQL 层 warn 且材料性 warning 可见（P1-4/P1-3）', async () => {
  const dir = tmp();
  const db = freshDbName();
  try {
    cleanConfig();
    createLocalDb(db); // 有库、无表
    updateLocalDbConfig({ default: db, databases: { [db]: { file: `${db}.sqlite`, sourceConnection: 'Doris' } } });
    const p = sqlTemplate(dir);
    const v = await verifyCpt(p, { localSqlAudit: true });
    const layers = layersById(v);
    assert.equal(v.localSqlAuditStatus.enabled, true);
    assert.equal(v.localSqlAuditStatus.datasets, 1);
    assert.equal(v.localSqlAuditStatus.datasetsChecked, 0, '缺表不算已检查');
    assert.equal(v.localSqlAuditStatus.datasetsSkipped, 1);
    assert.equal(layers.local_sql.status, 'warn', JSON.stringify(layers.local_sql));
    assert.ok(v.warnings.some((w) => /缺表/.test(String(w.message))), JSON.stringify(v.warnings).slice(0, 500));
    assert.equal(v.ok, true, '覆盖不足不得阻断交付');
  } finally {
    dropLocalDb(db, { confirm: true });
    cleanConfig();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ================= 2026-11-05 独立验收 P1-1/P2-1/P2-2 =================

test('templateFacts：ExcelImport / ui.impl 变体的导入按钮也能识别（P1-1 修复口径对齐）', () => {
  const dir = tmp();
  try {
    const p = path.join(dir, 'legacy-uiimpl.cpt');
    createCpt(p, { rows: 4, columns: 4, webWrite: true });
    addToolbarButton(p, { builtin: 'import-append' });
    const raw = fs.readFileSync(p, 'utf8').replace(
      'com.fr.report.web.button.write.ImExcelAppend',
      'com.fr.report.web.ui.impl.write.ImportExcelData',
    );
    fs.writeFileSync(p, raw, 'utf8');
    const f = templateFacts(p);
    assert.equal(f.excelImportButtons.legacy, 1);
    assert.equal(f.excelImportButtons.total, 1);
    assert.ok(f.builtinToolbarButtonClasses.includes('com.fr.report.web.ui.impl.write.ImportExcelData'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('verifyCpt：SQL 多返回未绑定列属噪音，不把 local_sql 层/整体状态降成 warn（P2-1）', async () => {
  const dir = tmp();
  const db = freshDbName();
  try {
    cleanConfig();
    makeLocalDb(db);
    const p = sqlTemplate(dir, { sql: 'SELECT sku_code, sku_name, qty FROM ods_sku', bindings: ['sku_code'] });
    const v = await verifyCpt(p, { localSqlAudit: true });
    const layers = layersById(v);
    assert.equal(layers.local_sql.status, 'pass', JSON.stringify(layers.local_sql));
    assert.equal(v.status, 'pass', JSON.stringify(v.layers).slice(0, 700));
    assert.equal(v.warnings.some((w) => /多返回/.test(String(w.message))), false);
  } finally {
    dropLocalDb(db, { confirm: true });
    cleanConfig();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('verifyCpt：模板没有 SQL 数据集 → local_sql 说明「不适用」，不再引导建库（P2-2）', async () => {
  const dir = tmp();
  try {
    cleanConfig();
    const p = path.join(dir, 'no-sql.cpt');
    createCpt(p, { rows: 4, columns: 4, webWrite: true });
    addCell(p, { column: 0, row: 0, content: '静态' });
    const v = await verifyCpt(p, { localSqlAudit: true });
    const layers = layersById(v);
    assert.equal(layers.local_sql.status, 'skipped');
    assert.match(layers.local_sql.detail, /不适用/);
    assert.equal(String(v.nextAction).includes('local_db_import({action:"auto"'), false, '无 SQL 数据集不应引导建库');
  } finally {
    cleanConfig();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
