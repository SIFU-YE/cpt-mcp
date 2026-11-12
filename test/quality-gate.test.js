// cpt-mcp/test/quality-gate.test.js —— 质量门槛与工序进度（针对弱模型"想到哪做到哪"的交付围栏）
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createCpt, addDataset, addCell, addStyle, setGrid, addFileDataset, addFillSubmit } from '../lib/generate.js';
import { addToolbarButton } from '../lib/edits.js';
import { generateReport, reviewStyles } from '../lib/engine/index.js';
import { qualityGate, buildProgress } from '../lib/quality.js';
import { createLocalDb, dropLocalDb } from '../lib/localdb.js';
import { validateCpt } from '../lib/validate.js';
import '../scripts/isolate-store.mjs'; // M123：JS 基线 store 隔离，直跑也不污染真实 store
// 回归 hermetic 前置：外部 CPT_MCP_ALLOWED_ROOTS（如 DSH 会话级目录限制）会改变默认允许根，
// qualityGate 内 engineCheckReport 要过路径围栏；以下断言测的是默认行为，先恢复默认再跑。
delete process.env.CPT_MCP_ALLOWED_ROOTS;

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-quality-'));
const file = (name) => path.join(TMP, name);

test('quality_gate：同行多列 dsColumn 默认展开（官方 85% 主流形态）不得误报 blocker', () => {
  const p = file('default-expand.cpt');
  createCpt(p, { rows: 4, columns: 4 });
  addDataset(p, { name: 'ds1', connection: 'Doris', sql: 'SELECT 1' });
  addCell(p, { column: 0, row: 1, contentType: 'dsColumn', dsName: 'ds1', columnName: 'a' });
  addCell(p, { column: 1, row: 1, contentType: 'dsColumn', dsName: 'ds1', columnName: 'b' });
  addCell(p, { column: 2, row: 1, contentType: 'dsColumn', dsName: 'ds1', columnName: 'c' });

  const gate = qualityGate(p);
  assert.equal(gate.pass, true, `默认展开是官方主流形态，不得误报：${JSON.stringify(gate.blockers)}`);
  // 锁定：不再出现"缺左父格"类 blocker（官方 789 行多列数据集 674 行全默认展开的反例教训）
  assert.equal(gate.blockers.filter((b) => /左父格/.test(b.message)).length, 0);
  // 进度阶段也应判定完成
  assert.equal(buildProgress(p).phases.find((x) => x.phase === '单元格与扩展').done, true);
});

test('quality_gate：显式 leftParent 形态（官方实证）同样正常', () => {
  const p = file('explicit.cpt');
  createCpt(p, { rows: 4, columns: 4 });
  addDataset(p, { name: 'ds1', connection: 'Doris', sql: 'SELECT 1' });
  addCell(p, { column: 0, row: 1, contentType: 'dsColumn', dsName: 'ds1', columnName: 'a' });
  addCell(p, { column: 1, row: 1, contentType: 'dsColumn', dsName: 'ds1', columnName: 'b', expand: { dir: 0, leftParent: 'B2' } });
  const gate = qualityGate(p);
  assert.equal(gate.pass, true);
});

test('quality_gate：结构错误必须 pass=false 且 blocker 带修复指引（坐标重复）', () => {
  const p = file('dup.cpt');
  createCpt(p, { rows: 4, columns: 4 });
  addCell(p, { column: 0, row: 0, content: 'x' });
  // 绕过 add_cell 的防重复围栏，模拟外部写坏：把整个单元格块复制一份
  const raw = fs.readFileSync(p, 'utf8');
  const m = raw.match(/<C c="0" r="0"[^>]*>[\s\S]*?<\/C>/);
  fs.writeFileSync(p, raw.replace('</CellElementList>', `${m[0]}\n</CellElementList>`), 'utf8');

  const gate = qualityGate(p);
  assert.equal(gate.pass, false);
  const dup = gate.blockers.filter((b) => /坐标重复/.test(b.message));
  assert.equal(dup.length, 1);
  assert.match(dup[0].fix, /delete_cell/);
  // 进度：质量门槛阶段未完成，nextAction 指向 blocker
  const prog = buildProgress(p);
  assert.equal(prog.phases.find((x) => x.phase === '质量门槛').done, false);
});

// ---------------- M73 业务管线：小字号不再误报 blocker ----------------
// 真实业务模板（不动销产品 2pt / 新媒体产品管控表 4pt 等）经真实 FR 引擎实证
// roundTrip=true 可加载（等价设计器能打开）——「<6pt」降为 warning，不得阻断交付判定。
test('M73：小字号（2-4pt）不再阻断 quality_gate，style_review 降为 warning', () => {
  const p = file('small-font.cpt');
  createCpt(p, { rows: 4, columns: 4 });
  addStyle(p, { fontSizePt: 14 }); // style 1（14pt → size=56）
  addCell(p, { column: 0, row: 0, content: 'x', styleIndex: 1 });
  // 把 style 1 字号改为 2pt（size=8），模拟真实业务模板的小字号压缩布局
  const raw = fs.readFileSync(p, 'utf8');
  const m = raw.match(/<FRFont[^>]*size="56"[^>]*\/>/);
  assert.ok(m, '应找到 style 1 的 FRFont');
  fs.writeFileSync(p, raw.replace(m[0], m[0].replace('size="56"', 'size="8"')), 'utf8');

  const st = reviewStyles(p);
  assert.equal(st.issues.filter((i) => i.severity === 'error' && /字号/.test(i.message)).length, 0, '2pt 不得再报 error');
  assert.ok(st.issues.some((i) => i.severity === 'warning' && /字号 2pt/.test(i.message)), '2pt 应提示 warning');

  const gate = qualityGate(p);
  assert.equal(gate.pass, true, `小字号不应阻断交付：${JSON.stringify(gate.blockers)}`);
  assert.equal(gate.blockers.filter((b) => /字号/.test(b.message)).length, 0);
});

test('quality_gate：generate_report 产出的成品模板应 pass=true（无误报）', () => {
  const p = file('good.cpt');
  generateReport({
    path: p,
    title: '月度销售',
    source: { connection: 'Doris', table: 'sales' },
    fields: [
      { name: 'region', label: '地区' },
      { name: 'amount', label: '金额', type: 'money' },
    ],
  });
  const gate = qualityGate(p);
  assert.equal(gate.pass, true, `不应有误报 blocker：${JSON.stringify(gate.blockers)}`);
  const prog = buildProgress(p);
  for (const phase of ['数据集', '样式', '单元格与扩展', '网格（行高列宽）', '页面设置']) {
    const ph = prog.phases.find((x) => x.phase === phase);
    assert.equal(ph.done, true, `${phase} 阶段应判定完成`);
  }
  // 引擎校验未跑时是 not-run 提示而非 blocker
  assert.equal(gate.engineCheck.status, 'not-run');
  assert.equal(gate.pass, true, 'not-run 的引擎结论不阻断 pass');
});

test('build_progress：骨架模板的网格/页面/填报阶段未完成，nextAction 指向首个未完成项', () => {
  const p = file('skeleton.cpt');
  createCpt(p, { rows: 3, columns: 3 });
  const prog = buildProgress(p);
  assert.equal(prog.phases.find((x) => x.phase === '数据集').done, false);
  assert.equal(prog.phases.find((x) => x.phase === '网格（行高列宽）').done, false);
  assert.match(prog.nextAction, /数据集|尚无数据集/);
  setGrid(p, { rowHeights: [1296000, 1008000, 1008000] });
  assert.equal(buildProgress(p).phases.find((x) => x.phase === '网格（行高列宽）').done, true);
});

test('quality_gate：样式全用骨架样式 0 时「样式」阶段判未完成并给出建议', () => {
  const p = file('plain.cpt');
  createCpt(p, { rows: 3, columns: 3 });
  addCell(p, { column: 0, row: 0, content: 'a' });
  addCell(p, { column: 1, row: 0, content: 'b' });
  const prog = buildProgress(p);
  const stylePhase = prog.phases.find((x) => x.phase === '样式');
  assert.equal(stylePhase.done, false);
  assert.match(stylePhase.detail, /add_style/);
  addStyle(p, { fontSizePt: 14 });
  assert.equal(buildProgress(p).phases.find((x) => x.phase === '样式').done, true);
});

test('M107 quality_gate：advisories 明细被截断必须显式标记（summary 才是全量口径）', () => {
  // 背景：advisories 为控制返回体积只回前 30 条，而 summary 统计全量。此前 slice 后不给任何标记，
  // 调用方看到 summary.warnings=30 却只能数出 28 条明细，无从知晓少了 2 条 —— 审阅时会把两者混为一谈。
  const p = file('many-advisories.cpt');
  const cols = 40;
  createCpt(p, { rows: 2, columns: cols });
  for (let c = 0; c < cols; c++) addCell(p, { column: c, row: 0, content: '一二三四五六七八九十' });
  setGrid(p, { columnWidths: Array.from({ length: cols }, () => 1440000) }); // 10mm 窄列 → 逐格列宽告警
  const gate = qualityGate(p);
  assert.equal(gate.pass, true, '仅建议级问题不得影响 pass');
  assert.ok(gate.advisoriesTotal > 30, `本用例须造出 >30 条 advisory，实际 ${gate.advisoriesTotal}`);
  assert.equal(gate.advisoriesTotal, gate.summary.warnings + gate.summary.infos,
    `明细总数必须等于 warnings+infos（summary=${JSON.stringify(gate.summary)}）`);
  assert.equal(gate.advisories.length, 30, '明细视图仍只回前 30 条');
  assert.equal(gate.advisoriesTruncated, true, '被截断必须显式标记');
});

test('M107 quality_gate：未截断时 advisoriesTruncated=false，口径同样自洽', () => {
  const p = file('few-advisories.cpt');
  createCpt(p, { rows: 3, columns: 3 });
  addCell(p, { column: 0, row: 0, content: '短' });
  const gate = qualityGate(p);
  assert.equal(gate.advisoriesTruncated, false);
  assert.equal(gate.advisories.length, gate.advisoriesTotal);
  assert.equal(gate.advisoriesTotal, gate.summary.warnings + gate.summary.infos);
});

// ---------------------------------------------------------------------------
// 2026-11-04：localSqlAudit 启用但本地库未初始化 → info advisory（可解释、带 nextAction、不阻断）
// ---------------------------------------------------------------------------

test('quality_gate：本地库未初始化时 localSqlAudit 不再静默跳过，追加 info advisory 且不改 pass/blockers', () => {
  const p = file('local-sql-skipped.cpt');
  createCpt(p, { rows: 4, columns: 4 });
  addDataset(p, { name: 'ds1', connection: 'Doris', sql: 'SELECT sku_code, sku_name FROM ods_sku' });
  addCell(p, { column: 0, row: 1, contentType: 'dsColumn', dsName: 'ds1', columnName: 'sku_code' });
  addCell(p, { column: 1, row: 1, contentType: 'dsColumn', dsName: 'ds1', columnName: 'sku_name' });

  const baseline = qualityGate(p);
  const gate = qualityGate(p, { localSqlAudit: true, localSqlAuditDb: 'definitely_missing_db_20261104' });
  assert.equal(gate.localSqlAudit.enabled, false);
  assert.match(gate.localSqlAudit.reason, /未初始化/);

  const adv = gate.advisories.find((a) => a.code === 'local_sql_audit_skipped');
  assert.ok(adv, JSON.stringify(gate.advisories.map((a) => a.code)));
  assert.equal(adv.severity, 'info', '必须是 info，不能升级成 warning/blocker');
  assert.equal(adv.source, 'local_sql');
  assert.match(adv.message, /未初始化/);
  assert.match(adv.message, /不阻断/);
  assert.match(adv.fix, /local_db_admin/);
  assert.match(adv.fix, /action: "auto"/);
  assert.match(adv.nextAction, /local_db_import/);

  // 语义不变：blockers / pass 与不跑审计时一致；local_sql 不进 blockers
  assert.equal(gate.pass, baseline.pass);
  assert.equal(gate.blockers.filter((b) => b.source === 'local_sql').length, 0);
  assert.deepEqual(
    gate.blockers.map((b) => b.message).sort(),
    baseline.blockers.map((b) => b.message).sort(),
    'advisory 不得改变 blockers 集合',
  );
  // 统计自洽：advisoriesTotal = summary.warnings + summary.infos，info 计入 infos
  assert.equal(gate.advisoriesTotal, gate.summary.warnings + gate.summary.infos);
  assert.ok(gate.summary.infos >= 1, `本地库未建应至少 1 条 info（实际 ${gate.summary.infos}）`);

  // 顶层"审计未生效"必须是显式信号（响应字段，不占 tools/list）
  assert.equal(gate.localSqlAuditStatus.enabled, false);
  assert.equal(gate.localSqlAuditStatus.code, 'local_sql_audit_skipped');
  assert.match(gate.localSqlAuditStatus.reason, /未初始化/);
  assert.match(gate.localSqlAuditStatus.nextAction, /local_db_admin/);
  assert.match(gate.note, /本地 SQL 审计未生效/);

  // 零回归：内部调用不传 localSqlAudit 时不产生该 advisory / status
  assert.equal(baseline.advisories.some((a) => a.code === 'local_sql_audit_skipped'), false);
  assert.equal(baseline.localSqlAudit, undefined);
  assert.equal(baseline.localSqlAuditStatus, undefined);
});

test('quality_gate：模板没有 SQL 数据集（Excel/树数据集）时不追加 local_sql_audit_skipped', () => {
  const p = file('local-sql-no-dataset.cpt');
  createCpt(p, { rows: 3, columns: 3 });
  addCell(p, { column: 0, row: 0, content: '标题' });
  const gate = qualityGate(p, { localSqlAudit: true, localSqlAuditDb: 'definitely_missing_db_20261104' });
  assert.equal(gate.localSqlAudit.enabled, false);
  assert.match(gate.localSqlAudit.reason, /没有 SQL 数据集|Excel\/树数据集/);
  assert.equal(gate.advisories.some((a) => a.code === 'local_sql_audit_skipped'), false);
  assert.equal(gate.pass, true);
});

// ================= 2026-11-05 缺口补齐（审计 P0-1/P0-2/P1-4） =================

test('validate/quality_gate：Excel 数据集不再误报「未指定数据连接 / SQL 为空」，改为 info 预检指引', () => {
  const p = file('excel-dataset.cpt');
  createCpt(p, { rows: 4, columns: 4 });
  addFileDataset(p, { name: 'excel1', dataFile: path.join(TMP, 'data.xlsx'), fromEnv: false });
  const gate = qualityGate(p);
  const messages = [...gate.blockers, ...gate.advisories].map((a) => a.message);
  assert.equal(messages.some((m) => /未指定数据连接/.test(m)), false, 'Excel 数据集不应再报连接缺失');
  assert.equal(messages.some((m) => /SQL 为空/.test(m)), false, 'Excel 数据集不应再报 SQL 为空');
  assert.ok(
    messages.some((m) => /Excel 数据集/.test(m) && /local_db_import/.test(m)),
    `应给 Excel 数据集 info 预检指引：${messages.filter((m) => /Excel/.test(m)).join(' / ')}`,
  );
  assert.equal(gate.blockers.filter((b) => /数据集/.test(b.message)).length, 0);
});

test('quality_gate：含 Excel 导入按钮 → info advisory excel_import_not_pretested（不改 pass/blockers）', () => {
  const p = file('excel-import-btn.cpt');
  createCpt(p, { rows: 6, columns: 6, webWrite: true });
  addToolbarButton(p, { builtin: 'import-append' });
  const gate = qualityGate(p);
  const adv = gate.advisories.find((a) => a.code === 'excel_import_not_pretested');
  assert.ok(adv, `应出现 excel_import_not_pretested advisory：${JSON.stringify(gate.advisories.map((a) => a.code))}`);
  assert.equal(adv.severity, 'info');
  assert.match(String(adv.message), /普通导入按钮/);
  assert.match(String(adv.nextAction), /local_db_import\(\{ action: "excel"/);
  assert.equal(adv.fix, adv.nextAction, 'fix 与 nextAction 必须同源（可直接执行）');
  // 不改交付判定：pass 仍由 blockers 决定
  const clean = file('excel-import-free.cpt');
  createCpt(clean, { rows: 6, columns: 6, webWrite: true });
  const cleanGate = qualityGate(clean);
  assert.equal(cleanGate.advisories.some((a) => a.code === 'excel_import_not_pretested'), false, '无导入按钮不应提示');
  assert.equal(gate.blockers.some((b) => b.source === 'excel_import'), false, '提示不得升级为 blocker');
});

test('quality_gate：localSqlAuditStatus 给出 datasetsChecked/Skipped（库存在但 0 表不虚报覆盖，P1-4）', () => {
  const db = 'gate_audit_counts_20261105';
  const p = file('local-sql-counts.cpt');
  createCpt(p, { rows: 4, columns: 4 });
  addDataset(p, { name: 'ds1', connection: 'Doris', sql: 'SELECT sku_code FROM ods_sku' });
  addCell(p, { column: 0, row: 1, contentType: 'dsColumn', dsName: 'ds1', columnName: 'sku_code' });
  createLocalDb(db); // 有库、无表
  try {
    const gate = qualityGate(p, { localSqlAudit: true, localSqlAuditDb: db });
    assert.equal(gate.localSqlAuditStatus.enabled, true);
    assert.equal(gate.localSqlAuditStatus.datasets, 1, '扫描到 1 个 SQL 数据集');
    assert.equal(gate.localSqlAuditStatus.datasetsChecked, 0, '库存在但缺表 → checked=0（不得虚报覆盖）');
    assert.equal(gate.localSqlAuditStatus.datasetsSkipped, 1);
    assert.equal(gate.pass, true, '覆盖不足只是 warning/advisory，不得阻断交付');
  } finally {
    dropLocalDb(db, { confirm: true });
  }
});

// ================= 2026-11-05 独立验收 P1-1 / P2-6 =================

test('quality_gate：标记/自定义导入按钮（含 ui.impl 变体）也能触发 gate advisory（P1-1 修复）', () => {
  for (const [idx, cls] of [
    'com.fr.report.web.button.write.ImportExcelData',
    'com.fr.report.web.button.write.CustomizeImportExcelData',
    'com.fr.report.web.ui.impl.write.ImportExcelData',
    'com.fr.report.web.button.write.ExcelImport',
  ].entries()) {
    const p = file(`excel-legacy-${idx}-${cls.split('.').pop()}.cpt`);
    createCpt(p, { rows: 6, columns: 6, webWrite: true });
    addToolbarButton(p, { builtin: 'import-append' });
    const raw = fs.readFileSync(p, 'utf8').replace('com.fr.report.web.button.write.ImExcelAppend', cls);
    fs.writeFileSync(p, raw, 'utf8');
    const gate = qualityGate(p);
    const adv = gate.advisories.find((a) => a.code === 'excel_import_not_pretested');
    assert.ok(adv, `${cls} 应触发 excel_import_not_pretested：${JSON.stringify(gate.advisories.map((a) => a.code))}`);
    assert.match(String(adv.message), /标记\/自定义导入/);
    assert.match(String(adv.nextAction), /必须 FR 填报预览验证/);
    assert.equal(gate.blockers.some((b) => b.source === 'excel_import'), false);
  }
});

test('validate：未知数据集 class 不再被当"合法非 SQL"静默放松（P2-6）', () => {
  const p = file('unknown-dataset-class.cpt');
  createCpt(p, { rows: 4, columns: 4 });
  addFileDataset(p, { name: 'fut', dataFile: path.join(TMP, 'data.xlsx'), fromEnv: false });
  const raw = fs.readFileSync(p, 'utf8').replace(
    'com.fr.data.impl.ExcelTableData',
    'com.fr.data.impl.SomeFutureTableData',
  );
  fs.writeFileSync(p, raw, 'utf8');
  const issues = validateCpt(p);
  assert.ok(issues.some((i) => /未识别的数据集 class/.test(i.message)), JSON.stringify(issues.map((i) => i.message)));
  assert.ok(issues.some((i) => i.severity === 'warning' && /未指定数据连接/.test(i.message)), '未知 class 仍应按 SQL 口径告警');
  assert.ok(issues.some((i) => i.severity === 'warning' && /SQL 为空/.test(i.message)));
});

test('quality_gate：填报模板返回 fillRuntime=unverified，但不改 pass/blockers 语义', () => {
  const p = file('fill-runtime.cpt');
  createCpt(p, { rows: 4, columns: 4, webWrite: true });
  addDataset(p, { name: 'ds1', connection: 'Doris', sql: 'SELECT 1' });
  addCell(p, { column: 0, row: 1, contentType: 'dsColumn', dsName: 'ds1', columnName: 'a' });
  addFillSubmit(p, {
    dsName: 'ds1', table: 't_test',
    bindings: [{ field: 'a', column: 0, row: 1, isKey: true }],
  });

  const gate = qualityGate(p);
  assert.equal(gate.fillRuntime?.applicable, true);
  assert.equal(gate.fillRuntime?.status, 'unverified');
  assert.equal(gate.fillRuntime?.submits, 1);
  assert.match(String(gate.fillRuntime?.nextAction), /action:"report"/);
  assert.ok(gate.advisories.some((a) => a.code === 'fill_runtime_not_verified'));
  // 运行期提示是 info advisory，不得被误升级成 blocker；pass/deliveryPass 语义不被它改写。
  assert.equal(gate.blockers.some((b) => b.source === 'fill_runtime'), false);
});
