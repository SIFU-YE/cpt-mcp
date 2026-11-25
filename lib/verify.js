// lib/verify.js —— MCP 自主核验（2026-10-26）
//
// 背景：v1 会话里模型的典型失败不是"写不对"，而是"写完不验"——工具返回成功就宣布完成，
// 结果 validate/quality_gate/引擎三关要另外各占一轮，或者在交付时才暴露 blocker。
// 本模块把"核验"做成 cpt-mcp 自己的能力：
//
//   verifyCpt(path, { engine, expectations, localSqlAudit })
//     ├─ L1 结构：validateCpt()（XML 可解析 + FR 结构/引用完整性/事件唯一性…）
//     ├─ L2 门禁：qualityGate()（blockers/warnings + 建议修复）
//     ├─ L2.5 本地 SQL 审计：localSqlAudit=true 时走 qualityGate 的 SQLite 离线审计
//     │      （2026-11-05：verify_cpt 默认开——本地库未建时 skipped + nextAction，绝不假装验过）
//     ├─ L2.6 Excel 导入预检提示：facts 里发现导入按钮 → 提示 local_db_import({action:"excel"})，
//     │      普通导入 vs 标记/自定义导入分开说（后者离线仿真不覆盖）
//     ├─ L3 对账：expectations（数量/文本/按钮）——"我要的改动真的落地了吗"
//     └─ L4 引擎：runFrEngineCheck()（真 FineReport 加载，需本机装 FR；结果有缓存）
//
// 写工具在 server.js 里自动调用（selfCheck 随返回体返回），也可由 verify_cpt 工具显式调用。
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { validateCpt } from './validate.js';
import { qualityGate } from './quality.js';

const count = (s, re) => (s.match(re) || []).length;

/** 模板的客观事实（供 expectations 对账，也供自检报告引用） */
export function templateFacts(cptPath) {
  const abs = path.resolve(cptPath);
  const raw = fs.readFileSync(abs, 'utf8');
  return {
    path: abs,
    bytes: Buffer.byteLength(raw, 'utf8'),
    sha256: createHash('sha256').update(raw).digest('hex').slice(0, 16),
    cells: count(raw, /<C\s/g),
    styles: count(raw, /<Style\s/g),
    toolbarButtons: count(raw, /class="com\.fr\.form\.ui\.CustomToolBarButton"/g),
    // 2026-11-05 修（审计 P0-C1）：FR 内置工具栏按钮的 class 不在 com.fr.form.ui 下，而在
    // com.fr.report.web.button.* / com.fr.report.web.ui.impl.*（写操作 write.Submit/Verify/ImExcelAppend…、
    // 分页 page.*、导出 Export/Email/Print…）。旧正则只数 com.fr.form.ui.*ToolBarButton → 恒为 0，
    // 导致「导入Excel」按钮在 templateFacts / verify_cpt facts 里完全不可见。
    builtinToolbarButtons: count(raw, /class="com\.fr\.report\.web\.(?:button|ui\.impl)\.[A-Za-z0-9_.$]+"/g),
    builtinToolbarButtonClasses: [...new Set(
      [...raw.matchAll(/class="(com\.fr\.report\.web\.(?:button|ui\.impl)\.[A-Za-z0-9_.$]+)"/g)].map((m) => m[1]),
    )],
    // Excel 导入按钮分三类（语义不同，不能混为一谈；官方 1550 样本实测 class 变体见 docs/excel-import.md）：
    //   append/clean = FR 普通 Excel 导入（位置样式匹配 1:1）→ local_db_import({action:"excel"}) 覆盖
    //   legacy       = 标记导入/自定义导入（ImportExcelData / CustomizeImportExcelData / ExcelImport，
    //                  含 com.fr.report.web.ui.impl.write.* 变体），带列映射/过滤语义，
    //                  离线仿真**不覆盖**，必须 FR 预览验证
    excelImportButtons: (() => {
      const cls = 'com\\.fr\\.report\\.web\\.(?:button|ui\\.impl)\\.write\\.';
      const append = count(raw, new RegExp(`class="${cls}ImExcelAppend"`, 'g'));
      const clean = count(raw, new RegExp(`class="${cls}ImExcelClean"`, 'g'));
      const legacy = count(raw, new RegExp(`class="${cls}(?:ImportExcelData|CustomizeImportExcelData|ExcelImport)"`, 'g'));
      return { append, clean, legacy, total: append + clean + legacy };
    })(),
    submits: count(raw, /<SubmitVisitor\s/g),
    fillBindings: count(raw, /<ColumnConfig\s/g),
    datasets: count(raw, /<TableData\s/g),
    sheets: count(raw, /<Report\s/g),
    listeners: count(raw, /<Listener\s/g),
    toolbarButtonTexts: [...raw.matchAll(/<Widget class="com\.fr\.form\.ui\.CustomToolBarButton">[\s\S]*?<Text>\s*<!\[CDATA\[([\s\S]*?)\]\]>/g)]
      .map((m) => m[1].trim()),
  };
}

const NUMERIC_FACTS = ['cells', 'styles', 'toolbarButtons', 'builtinToolbarButtons', 'submits', 'fillBindings', 'datasets', 'sheets', 'listeners'];

/** expectations 对账：返回 blockers（空数组=全部满足） */
export function checkExpectations(facts, raw, expectations) {
  const blockers = [];
  if (!expectations || typeof expectations !== 'object') return blockers;
  for (const key of NUMERIC_FACTS) {
    const want = expectations[key];
    if (want == null) continue;
    const actual = facts[key];
    if (actual !== Number(want)) {
      blockers.push({
        location: '期望值对账',
        message: `${key} 期望 ${want}，实际 ${actual}`,
        fix: `核对本次写操作是否真的生效（用 read_cpt / 对应 get_* 工具确认）；期望值写错就修正 expectations 后重跑 verify_cpt`,
      });
    }
  }
  if (expectations.bytesMin != null && facts.bytes < Number(expectations.bytesMin)) {
    blockers.push({ location: '期望值对账', message: `bytes 期望 ≥${expectations.bytesMin}，实际 ${facts.bytes}`, fix: '文件可能未写入或被截断：重跑写工具后复查 bytes' });
  }
  if (expectations.bytesMax != null && facts.bytes > Number(expectations.bytesMax)) {
    blockers.push({ location: '期望值对账', message: `bytes 期望 ≤${expectations.bytesMax}，实际 ${facts.bytes}`, fix: '文件异常膨胀：检查是否重复写入/嵌套插入' });
  }
  for (const text of expectations.hasText || []) {
    if (!raw.includes(String(text))) {
      blockers.push({ location: '期望值对账', message: `缺少期望文本：${String(text).slice(0, 60)}`, fix: '用 read_cpt 确认该内容写到了哪个 sheet/单元格，再重跑对应写工具' });
    }
  }
  for (const text of expectations.notHasText || []) {
    if (raw.includes(String(text))) {
      blockers.push({ location: '期望值对账', message: `出现了不应存在的文本：${String(text).slice(0, 60)}`, fix: '定位并删除该内容（update_cell / update_report_node / set_* 对应工具）' });
    }
  }
  for (const btn of expectations.toolbarButtonTexts || []) {
    if (!facts.toolbarButtonTexts.includes(String(btn))) {
      blockers.push({
        location: '期望值对账',
        message: `工具栏按钮「${btn}」不存在（现有：${facts.toolbarButtonTexts.join(' / ') || '无'}）`,
        fix: '确认 add_toolbar_button 的 buttonText 与期望一致；WebWriteContent 必须存在（填报预览才显示工具栏）',
      });
    }
  }
  return blockers;
}

/**
 * 自主核验入口。
 * @param {string} cptPath
 * @param {{engine?: boolean, expectations?: object, timeoutMs?: number, localSqlAudit?: boolean}} opts
 *   localSqlAudit=true 时追加 L2.5 本地 SQLite 离线审计（本地库未建 → skipped + nextAction，绝不假 pass）；
 *   server 的 verify_cpt 默认开启，写工具 selfCheck 保持关闭（避免每次写都跑全量 prepare）。
 * @returns {Promise<{ok:boolean, status:'pass'|'warn'|'fail', path:string, bytes?:number, sha256?:string,
 *   durationMs:number, layers:Array<{id:string,name:string,status:string,detail?:string}>, blockers:Array,
 *   warnings:Array, facts?:object, localSqlAuditStatus?:object, excelImport?:object, nextAction:string}>}
 */
export async function verifyCpt(cptPath, { engine = false, expectations, timeoutMs, localSqlAudit = false } = {}) {
  const started = Date.now();
  const layers = [];
  const blockers = [];
  const warnings = [];
  const hints = [];
  let facts = null;
  let gate = null;

  const finish = (extra = {}) => {
    const failed = layers.some((l) => l.status === 'fail');
    const warned = layers.some((l) => l.status === 'warn');
    const status = failed ? 'fail' : (warned ? 'warn' : 'pass');
    const nextAction = (failed
      ? '按 blockers 里的 fix 修复后重跑 verify_cpt；结构性 blocker 未清前不要交付/不要继续叠加写操作'
      : (status === 'warn' ? '仅有 warning：可交付，但建议按 warnings 清理（尤其 engine 未跑时）' : '核验通过，可交付（engine=pass 时含真引擎结论）'))
      + (hints.length ? `；${hints.join('；')}` : '');
    return {
      ok: !failed,
      status,
      path: path.resolve(cptPath),
      durationMs: Date.now() - started,
      layers,
      blockers,
      warnings,
      nextAction,
      ...extra,
    };
  };

  // ---------- L0 文件 ----------
  const abs = path.resolve(cptPath);
  if (!fs.existsSync(abs)) {
    layers.push({ id: 'file', name: '文件存在', status: 'fail', detail: `${abs} 不存在` });
    blockers.push({ location: '文件', message: '模板文件不存在', fix: '确认 path（是否 .cpt、是否在允许目录内）；新建请用 create_cpt' });
    return finish();
  }
  facts = templateFacts(abs);

  // ---------- L1 结构 ----------
  let issues = [];
  try {
    const v = validateCpt(abs);
    issues = Array.isArray(v) ? v : (v.issues || []);
    const errs = issues.filter((i) => i.severity === 'error');
    const warns = issues.filter((i) => i.severity === 'warning');
    for (const e of errs.slice(0, 20)) blockers.push({ location: e.location || '结构', message: e.message, fix: e.fix || '按 validate_cpt 指引修复' });
    for (const w of warns.slice(0, 20)) warnings.push({ location: w.location || '结构', message: w.message });
    layers.push({
      id: 'structure', name: '结构校验（validate_cpt）', status: errs.length ? 'fail' : (warns.length ? 'warn' : 'pass'),
      detail: `errors=${errs.length} warnings=${warns.length} infos=${issues.length - errs.length - warns.length}`,
    });
  } catch (e) {
    layers.push({ id: 'structure', name: '结构校验（validate_cpt）', status: 'fail', detail: `模板无法解析：${e.message}` });
    blockers.push({ location: '文件', message: `模板无法解析：${e.message}`, fix: '用备份恢复或重新构建；不要手工改 XML 后继续叠加写操作' });
    return finish({ facts });
  }

  // ---------- L2 交付门禁 ----------
  try {
    // 2026-11-05：把本地 SQL 审计接进 verify_cpt（此前只传 abs → 本地 SQL 层缺失，
    // 本地库已建时 SQL 语法错/绑定列缺失会被 verify 漏掉）。由调用方显式开启，避免写工具 selfCheck 变重。
    gate = qualityGate(abs, { localSqlAudit: localSqlAudit === true });
    const gateBlockers = gate.blockers || [];
    for (const b of gateBlockers.slice(0, 20)) blockers.push({ location: b.location || '门禁', message: b.message, fix: b.fix || '按 quality_gate_cpt 指引修复' });
    const warnCount = gate.summary?.warnings ?? 0;
    const sqlBlockerCount = gateBlockers.filter((b) => b.source === 'local_sql').length;
    // 2026-11-05 P1-3：本地 SQL 审计的「参数占位/方言提示」不参与 gate 层告警状态
    //（否则 SQL 正确但用了公式参数的模板会因 masked_params 被 verify 判 warn）；
    // 材料性审计 warning（缺表/缺列/绑定）由下面的 local_sql 层单独升级。
    const auditWarnCount = Array.isArray(gate.localSqlAudit?.warnings) ? gate.localSqlAudit.warnings.length : 0;
    const gateSignalWarnCount = Math.max(0, warnCount - auditWarnCount);
    layers.push({
      id: 'gate', name: '交付门禁（quality_gate_cpt）', status: gateBlockers.length ? 'fail' : (gateSignalWarnCount ? 'warn' : 'pass'),
      detail: `pass=${gate.pass} blockers=${gateBlockers.length}${sqlBlockerCount ? `（含本地 SQL ${sqlBlockerCount}）` : ''}`
        + ` warnings=${warnCount}${auditWarnCount ? `（其中本地 SQL ${auditWarnCount} 条见 local_sql 层）` : ''}`,
    });
  } catch (e) {
    layers.push({ id: 'gate', name: '交付门禁（quality_gate_cpt）', status: 'fail', detail: `门禁执行失败：${e.message}` });
    blockers.push({ location: '门禁', message: `门禁执行失败：${e.message}`, fix: '先修复模板可读性再跑门禁' });
  }

  // ---------- L2.5 本地 SQL 审计（显式开启时） ----------
  // 关键：本地库没建 → 明确 skipped + nextAction，不能因为"没审计"就显示 pass 而让人以为验过。
  let localSqlAuditStatus = null;
  if (localSqlAudit === true) {
    localSqlAuditStatus = gate?.localSqlAuditStatus ?? null;
    if (!localSqlAuditStatus) {
      layers.push({ id: 'local_sql', name: '本地 SQL 审计（SQLite 离线 prepare）', status: 'skipped', detail: '门禁未返回本地 SQL 审计状态（旧版/异常），本轮无 SQL 证据' });
      hints.push('本地 SQL 审计未运行（门禁未返回状态）；先 local_db_admin({action:"create"}) + local_db_import({action:"auto"}) 后重跑');
    } else if (localSqlAuditStatus.enabled !== true) {
      const reason = String(localSqlAuditStatus.reason || '本地 SQLite 测试库未初始化');
      const noSqlDataset = /没有 SQL 数据集|Excel\/树|不适用/.test(reason);
      layers.push({
        id: 'local_sql', name: '本地 SQL 审计（SQLite 离线 prepare）', status: 'skipped',
        detail: noSqlDataset
          ? `不适用：${reason}（无需建库）`
          : `未运行：${reason}。缺库不阻断，但本轮不含 SQL 证据`,
      });
      if (!noSqlDataset) {
        hints.push('本地 SQL 审计未运行：本地 SQLite 测试库未建；要拿 SQL 证据先 local_db_import({action:"auto", db:"main", connection:"<数据连接名>", path:"<模板.cpt>"})（无真实连接用 action:"ddl"+action:"seed" 造 fixture），再重跑 verify_cpt');
      }
    } else {
      const audit = gate?.localSqlAudit ?? {};
      const sqlBlockers = Array.isArray(audit.blockers) ? audit.blockers.length : 0;
      const sqlWarnings = Array.isArray(audit.warnings) ? audit.warnings.length : 0;
      // 2026-11-05 P1-3：把审计 warning 分「材料性」与「常规噪音」两类。
      // 缺表/缺列/绑定/准备失败 → 影响 SQL 证据完整性，层 warn + 进 verify.warnings；
      // masked_params / dialect_gap / truncated / 参数无法离线判定 / SQL 多返回未用列（文案自述不影响功能）
      // → 只记 info，层保持 pass，避免 SQL 正确但模板只是"查多了"就从 pass 变 warn（实测噪音）。
      const MATERIAL_WARN = /local_db_missing|local_db_missing_table|local_db_schema_mismatch|local_sql_binding|local_sql_prepare_failed|local_sql_denied/;
      const allAuditWarnings = Array.isArray(audit.warnings) ? audit.warnings : [];
      const materialWarnings = allAuditWarnings.filter((w) => MATERIAL_WARN.test(String(w?.code ?? '')));
      const infoWarnings = allAuditWarnings.filter((w) => !MATERIAL_WARN.test(String(w?.code ?? '')));
      layers.push({
        id: 'local_sql', name: '本地 SQL 审计（SQLite 离线 prepare）',
        status: sqlBlockers ? 'fail' : (materialWarnings.length ? 'warn' : 'pass'),
        detail: `db=${localSqlAuditStatus.db ?? '?'} datasets=${localSqlAuditStatus.datasets ?? 0}`
          + ` checked=${localSqlAuditStatus.datasetsChecked ?? '?'}/${localSqlAuditStatus.datasets ?? '?'}`
          + ` blockers=${sqlBlockers} warnings=${sqlWarnings}${infoWarnings.length ? `（其中 ${infoWarnings.length} 条为参数/方言提示，不升级）` : ''}`,
      });
      // 只把材料性 warning 升进 verify.warnings（不重复 blocker）；常规噪音留在 gate advisories。
      if (!sqlBlockers) {
        for (const w of materialWarnings.slice(0, 10)) {
          warnings.push({ location: w.dataset ? `数据集 ${w.dataset}` : '本地 SQL 审计', message: w.message });
        }
      }
      const skippedAdvisory = (gate?.advisories || []).find((a) => a.code === 'local_sql_audit_skipped');
      if (skippedAdvisory) hints.push(String(skippedAdvisory.nextAction || '').split('\n')[0]);
    }
  }

  // ---------- L2.6 Excel 导入离线预检提示（facts 有导入按钮时） ----------
  const excelButtons = facts?.excelImportButtons || null;
  const excelImport = excelButtons && excelButtons.total > 0 ? excelButtons : null;
  if (excelImport) {
    const normal = excelImport.append + excelImport.clean;
    const detail = normal
      ? `模板含 ${normal} 个普通导入按钮（append=${excelImport.append} clean=${excelImport.clean}）`
        + (excelImport.legacy ? `；另有 ${excelImport.legacy} 个标记/自定义导入按钮（离线仿真不覆盖）` : '')
        + '。交付前建议 local_db_import({action:"excel", db:"main", path:"<模板.cpt>", excelFile:"<样例.xlsx>"}) 离线预检；离线通过≠FR 页面行为通过'
      : `模板含 ${excelImport.legacy} 个标记/自定义导入按钮（ImportExcelData/CustomizeImportExcelData）：local_db_import({action:"excel"}) 只覆盖普通导入（位置匹配 1:1），这类必须 FR 预览验证`;
    layers.push({ id: 'excel_import', name: 'Excel 导入离线预检', status: 'skipped', detail });
    hints.push(normal
      ? 'Excel 导入未做离线预检：准备样例 .xlsx 后跑 local_db_import({action:"excel", db:"main", path, excelFile})'
      : '模板是标记/自定义导入按钮，离线仿真不覆盖：必须 FR 填报预览验证');
  }

  // ---------- L3 期望值对账 ----------
  if (expectations && Object.keys(expectations).length) {
    const raw = fs.readFileSync(abs, 'utf8');
    const expBlockers = checkExpectations(facts, raw, expectations);
    for (const b of expBlockers) blockers.push(b);
    layers.push({
      id: 'expectations', name: '期望值对账', status: expBlockers.length ? 'fail' : 'pass',
      detail: expBlockers.length ? `${expBlockers.length} 项不符` : '全部满足',
    });
  } else {
    layers.push({ id: 'expectations', name: '期望值对账', status: 'skipped', detail: '未提供 expectations' });
  }

  // ---------- L4 真引擎 ----------
  if (!engine) {
    layers.push({ id: 'engine', name: '真实 FR 引擎加载', status: 'skipped', detail: '本次未要求（engine=false）' });
  } else {
    try {
      const mod = await import('./fr-engine-run.js');
      const runPromise = mod.runFrEngineCheck(abs);
      const res = timeoutMs
        ? await Promise.race([runPromise, new Promise((_, rej) => setTimeout(() => rej(new Error(`超时 ${timeoutMs}ms`)), timeoutMs))])
        : await runPromise;
      if (res?.ok) {
        layers.push({ id: 'engine', name: '真实 FR 引擎加载', status: 'pass', detail: `status=${res.status}` });
      } else {
        layers.push({ id: 'engine', name: '真实 FR 引擎加载', status: 'fail', detail: `status=${res?.status ?? 'unknown'} ${res?.hint || ''}`.trim() });
        blockers.push({ location: '引擎', message: `真实 FR 引擎加载失败：${res?.hint || res?.status || 'unknown'}`, fix: '先跑 validate_cpt 修复结构；引擎报错看 .fr-engine-check/*.json' });
      }
    } catch (e) {
      layers.push({ id: 'engine', name: '真实 FR 引擎加载', status: 'skipped', detail: `不可用：${e.message}` });
      warnings.push({ location: '引擎', message: `真引擎校验跳过（${e.message}）——本次结论不含引擎证据` });
    }
  }

  return finish({
    facts,
    ...(localSqlAuditStatus ? { localSqlAuditStatus } : {}),
    ...(excelImport ? { excelImport } : {}),
  });
}

/** 给写工具用的轻量自检摘要（server.js 自动附加到返回体） */
export async function selfCheckSummary(cptPath, { engine = false } = {}) {
  const v = await verifyCpt(cptPath, { engine });
  const layerStatus = Object.fromEntries(v.layers.map((l) => [l.id, l.status]));
  return {
    status: v.status,
    layers: layerStatus,
    blockers: v.blockers.slice(0, 5),
    warnings: v.warnings.slice(0, 3),
    facts: v.facts,
    durationMs: v.durationMs,
    nextAction: v.nextAction,
  };
}
