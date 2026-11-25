// cpt-mcp/lib/gate-brief.js —— 门禁/校验结果的摘要视图（2026-11-12 P0-2）
//
// 为什么：v1 报表会话里 quality_gate_cpt 原始输出平均 28.9KB/次、validate_cpt 15.7KB/次，
// 其中绝大多数是模型"知道结论就够了"的明细（checklist 全量、advisories 30 条、每条 fix 长文）。
// brief=true 时只回：结论字段 + 前 5 条最关键明细 + 计数；完整明细仍可用 brief=false 取。
//
// 约束：摘要必须保留**可执行信息**（blocker 的 location/message/fix 前 240 字节），
// 不能只回一个 pass=false —— 否则模型还得再跑一次全量，等于没省。
const MAX_LIST = 5;
const MAX_TEXT = 240;
const MAX_DETAIL = 200;
const MAX_NEXT = 240;

const clip = (value, max) => {
  const text = String(value ?? '');
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
};

function briefIssue(issue) {
  const out = {};
  if (!issue || typeof issue !== 'object') return { message: clip(issue, MAX_TEXT) };
  if (issue.severity) out.severity = issue.severity;
  if (issue.code) out.code = issue.code;
  if (issue.source) out.source = issue.source;
  if (issue.location) out.location = clip(issue.location, 120);
  if (issue.message) out.message = clip(issue.message, MAX_TEXT);
  if (issue.fix) out.fix = clip(issue.fix, MAX_TEXT);
  return out;
}

const briefList = (list) => (Array.isArray(list) ? list : []).slice(0, MAX_LIST).map(briefIssue);

/** validate_cpt 摘要：结论 + 前 5 条 error（warning/info 只给计数） */
export function briefValidate(result) {
  const issues = Array.isArray(result?.issues) ? result.issues : [];
  const errors = issues.filter((i) => i?.severity === 'error');
  const warnings = issues.filter((i) => i?.severity === 'warning');
  const infos = issues.filter((i) => i?.severity === 'info');
  return {
    brief: true,
    path: result?.path,
    summary: result?.summary,
    errorsTotal: errors.length,
    errors: briefList(errors),
    errorsTruncated: errors.length > MAX_LIST,
    warningsTotal: warnings.length,
    infosTotal: infos.length,
    ...(result?.baselineReset !== undefined ? { baselineReset: result.baselineReset } : {}),
    ...(result?.baselineResetInfo ? { baselineResetInfo: result.baselineResetInfo } : {}),
    hint: `摘要模式：只回前 ${MAX_LIST} 条 error（errorsTotal 为总数）；完整 issues 传 brief:false。修复顺序见 errors[].fix。`,
  };
}

/** quality_gate_cpt 摘要：三态结论 + engineCheck 状态 + 前 5 条 blockers + advisory 计数 */
export function briefGate(gate) {
  const blockers = Array.isArray(gate?.blockers) ? gate.blockers : [];
  const engine = gate?.engineCheck ?? {};
  const audit = gate?.localSqlAuditStatus ?? null;
  return {
    brief: true,
    pass: gate?.pass,
    structuralPass: gate?.structuralPass,
    deliveryPass: gate?.deliveryPass,
    summary: gate?.summary,
    engineCheck: {
      status: engine.status,
      ...(engine.required !== undefined ? { required: engine.required } : {}),
      ...(engine.hint ? { hint: clip(engine.hint, 160) } : {}),
      ...(engine.deepAccess?.hint ? { deepAccessHint: clip(engine.deepAccess.hint, MAX_NEXT) } : {}),
    },
    blockersTotal: blockers.length,
    blockers: briefList(blockers),
    blockersTruncated: blockers.length > MAX_LIST,
    advisoriesTotal: gate?.advisoriesTotal ?? (Array.isArray(gate?.advisories) ? gate.advisories.length : 0),
    ...(gate?.advisoriesTruncated !== undefined ? { advisoriesTruncated: gate.advisoriesTruncated } : {}),
    ...(audit
      ? {
          localSqlAuditStatus: {
            enabled: audit.enabled,
            ...(audit.db !== undefined ? { db: audit.db } : {}),
            ...(audit.datasets !== undefined ? { datasets: audit.datasets } : {}),
            ...(audit.datasetsChecked !== undefined ? { datasetsChecked: audit.datasetsChecked } : {}),
            ...(audit.reason ? { reason: clip(audit.reason, MAX_TEXT) } : {}),
          },
        }
      : {}),
    ...(gate?.excelImport ? { excelImport: gate.excelImport } : {}),
    ...(gate?.fillRuntime ? { fillRuntime: gate.fillRuntime } : {}),
    ...(gate?.nextAction ? { nextAction: clip(gate.nextAction, MAX_NEXT) } : {}),
    hint: `摘要模式：blockers 只回前 ${MAX_LIST} 条（blockersTotal 为总数），advisories 明细已省略（advisoriesTotal 为总数）；完整明细传 brief:false。pass/structuralPass/deliveryPass 语义与完整模式一致。`,
  };
}

/** verify_cpt 摘要：分层状态 + 前 5 条 blocker + 计数（facts 明细省略） */
export function briefVerify(verify) {
  const layers = (Array.isArray(verify?.layers) ? verify.layers : []).map((l) => ({
    id: l?.id,
    status: l?.status,
    ...(l?.detail ? { detail: clip(l.detail, MAX_DETAIL) } : {}),
  }));
  const blockers = Array.isArray(verify?.blockers) ? verify.blockers : [];
  const warnings = Array.isArray(verify?.warnings) ? verify.warnings : [];
  return {
    brief: true,
    ok: verify?.ok,
    status: verify?.status,
    path: verify?.path,
    durationMs: verify?.durationMs,
    layers,
    blockersTotal: blockers.length,
    blockers: briefList(blockers),
    blockersTruncated: blockers.length > MAX_LIST,
    warningsTotal: warnings.length,
    ...(verify?.warnings?.length ? { warnings: briefList(warnings) } : {}),
    ...(verify?.localSqlAuditStatus ? { localSqlAuditStatus: verify.localSqlAuditStatus } : {}),
    ...(verify?.excelImport ? { excelImport: verify.excelImport } : {}),
    ...(verify?.nextAction ? { nextAction: clip(verify.nextAction, MAX_NEXT) } : {}),
    hint: `摘要模式：layers 保留每层状态（detail 截断）、blockers/warnings 只回前 ${MAX_LIST} 条；facts 明细省略。完整结果传 brief:false。`,
  };
}
