// cpt-mcp/lib/deep-tools.js —— 会话级深层工具租约（t2 真隐藏动态注册）
// 未解锁的深层工具不进 MCP 注册表（无 disabled 占位）；租约授予后宿主（server.js）
// 经 onDynamicRegister 回调动态注册，租约过期/耗尽后经 onDynamicUnregister 回调动态注销。
// full 入口（staticExpose）仍静态全量注册，不走动态路径。
// 机制定位（M103 明确）：隐藏是为了省 token/防幻觉，不是安全审批——高频工具应进档位静态表
// （如 set_fill_toolbar 已进 report），临租只解决可达性（单文件域+TTL+次数），不管正确性。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { parseA1 } from './cell-batch.js';
import { takeBatchFailure } from './cell-batch.js';
import { detectFrHome } from './fr-decompile.js';
import {
  LEASE_GROUPS, GATE_GROUPS, DEEP_TOOLS,
  READ_ONLY_TOOLS, DESTRUCTIVE_TOOLS, allClassifiedToolNames,
} from './contract.js';
import { normalizePath } from './path-util.js';

/** 组 → 成员集合。**由 LEASE_GROUPS 派生**（单一事实源在 lib/lease-groups.js），
 *  不再在运行时手写第二份清单——那正是"地图与实际租约不一致"的来源。 */
export const DEEP_TOOL_GROUPS = Object.freeze(Object.fromEntries(
  Object.entries(LEASE_GROUPS).map(([group, def]) => [group, new Set(def.members)]),
));

/** 租约策略表（表驱动）：21 个租约组全部走表（16 个场景族 + 既有 5 个门禁/特殊组）；既有 5 组带 special 标记，
 *  保留各自的专用校验分支（failureId / target / 用户明确要求等门禁一律不变）。 */
export const GROUP_POLICY = Object.freeze(Object.fromEntries(
  Object.entries(LEASE_GROUPS).map(([group, def]) => [group, Object.freeze({
    reason: def.reason,
    reasons: def.reasons ?? null,
    ttlSeconds: def.ttlSeconds,
    maxCalls: def.maxCalls,
    pathRequired: def.pathRequired !== false,
    gate: def.gate === true,
    special: def.special ?? null,
    why: def.why,
  })]),
));

export const DEEP_TOOL_NAMES = DEEP_TOOLS;



/** cell_detail 租约按 target.requiredFields 决定解锁哪个读取工具（缺省 style）。
 *  导出给 server.js 做「本档是否已静态可见」的判定，避免宿主与 lib 各写一份映射。 */
export function toolForFields(fields = []) {
  const wanted = new Set(fields);
  if ([...wanted].some((field) => ['hyperlink', 'hyperlinks'].includes(field))) return ['get_cell_hyperlink'];
  if ([...wanted].some((field) => ['highlight', 'highlights'].includes(field))) return ['get_cell_highlight'];
  return ['get_cell_style'];
}

/** 续租提示（2026-10-29 修）：门禁族不能用 group:'auto' —— auto 命中门禁组会被直接拒绝，
 *  旧文案一律回指 auto 等于给死循环药方。这里按工具所属族给出可逐字执行的具名族调用式。 */
function renewHint(toolName, args) {
  const p = JSON.stringify(args?.path ?? '<目标.cpt>');
  const group = Object.entries(DEEP_TOOL_GROUPS).find(([, set]) => set.has(toolName))?.[0];
  const policy = group ? GROUP_POLICY[group] : null;
  if (!policy?.gate) {
    return `重新授权：request_deep_tool_access({path:${p}, group:'auto', tools:['${toolName}']})`;
  }
  const reason = policy.reasons?.length
    ? `'${policy.reasons[0]}'（或 ${policy.reasons.slice(1).map((r) => `'${r}'`).join(' / ')}）`
    : `'${policy.reason}'`;
  const extra = group === 'cell_primitive' ? ', failureId:<batch_mutate_cells 失败返回的一次性凭据>'
    : group === 'cell_detail' ? ', target:{sheet:<表>, cell:"<A1>"}'
    : '';
  return `该工具属门禁族 ${group}，group:'auto'/adhoc 都绕不过门禁；重新授权：`
    + `request_deep_tool_access({path:${p}, group:'${group}', reason:${reason}${extra}})`;
}

export function frRuntimeStatus() {
  const detected = detectFrHome();
  if (!detected.frHome) {
    return { status: 'fr-not-installed', ready: false, hint: '未探测到 FineReport；请设置 FR_HOME' };
  }
  const java = path.join(detected.frHome, 'jre', 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
  const engineJar = path.join(detected.frHome, 'webapps', 'webroot', 'WEB-INF', 'lib', 'fine-report-engine-11.0.jar');
  const checks = { jre: fs.existsSync(java), engineJar: fs.existsSync(engineJar) };
  return {
    status: checks.jre && checks.engineJar ? 'ready' : !checks.jre ? 'jre-missing' : 'engine-jar-missing',
    ready: checks.jre && checks.engineJar,
    frHome: detected.frHome,
    checks,
  };
}

export class DeepToolManager {
  constructor({ now = () => Date.now() } = {}) {
    this.now = now;
    this.handles = new Map();
    this.leases = new Map();
    this.exposedStatically = new Set(); // 所属 profile 静态暴露的深层工具：不走租约强制
    this.staticExpose = process.env.CPT_MCP_EXPOSE_DEEP_TOOLS === '1';
    this.dynamicVisible = new Set(); // 真隐藏模式下已动态注册（租约期内可见）的深层工具
    this.pathlessTools = new Set(); // 声明里没有 path 参数的深层工具（机器级/全局：fr_detect、fr_inspect、scheduler_*）
    this.onDynamicRegister = null; // (tools: string[]) => void，宿主注入：动态注册进 MCP 注册表
    this.onDynamicUnregister = null; // (tools: string[]) => void，宿主注入：从 MCP 注册表动态注销
  }

  /** 登记"不碰任何文件"的深层工具：它们无从携带 path，故路径绑定对它们不构成约束。
   *  由宿主在 tool() 注册期用与 zod 校验同一个 schema 对象判定，避免 beforeCall 去猜 args.path
   *  （猜法对"未来的可选 path 工具"会静默放开跨文件复用）。 */
  markPathless(toolName) {
    this.pathlessTools.add(toolName);
  }

  groupOf(toolName) {
    return Object.entries(DEEP_TOOL_GROUPS).find(([, names]) => names.has(toolName))?.[0] || null;
  }

  register(toolName, handle, { expose = false } = {}) {
    this.handles.set(toolName, handle);
    if (expose) {
      this.exposedStatically.add(toolName);
      handle.enable();
      return;
    }
    if (!this.staticExpose) handle.disable();
  }

  cleanup() {
    const now = this.now();
    for (const [leaseId, lease] of this.leases) {
      if (lease.expiresAt <= now || lease.remaining <= 0) {
        clearTimeout(lease.timer);
        this.leases.delete(leaseId);
        this.reconcile(lease.tools);
      }
    }
  }

  reconcile(toolNames) {
    if (this.staticExpose) return;
    for (const toolName of toolNames) {
      if (this.exposedStatically.has(toolName)) continue;
      const stillNeeded = [...this.leases.values()].some((lease) => lease.remaining > 0 && lease.expiresAt > this.now() && lease.tools.includes(toolName));
      if (stillNeeded) continue;
      // 2026-10-27 P0-2（两天会话审计 B 类 22 条，其中 13 次裸 unknown tool）：
      // 额度耗尽/过期后**不再动态注销** —— 保持注册，下一次调用由 beforeCall 抛
      // 「无可用租约 + 可复制的续租命令」，而不是协议层裸 "unknown tool"（零药方）。
      // 「真隐藏」语义保留给从未授予的工具（它们从未注册，tools/list 里没有）。
      if (this.handles.has(toolName)) this.handles.get(toolName)?.disable();
    }
  }

  grant({ group, filePath, tools, target, ttlSeconds = 3600, maxCalls = 20, reason }) {
    const leaseId = crypto.randomUUID();
    const lease = {
      leaseId, group, path: filePath ? normalizePath(filePath) : null,
      tools, target: target || null, reason, remaining: maxCalls, maxCalls,
      expiresAt: this.now() + ttlSeconds * 1000,
    };
    lease.timer = setTimeout(() => {
      const current = this.leases.get(leaseId);
      if (!current || current.expiresAt > this.now()) return;
      this.leases.delete(leaseId);
      this.reconcile(current.tools);
    }, ttlSeconds * 1000 + 10);
    lease.timer.unref?.();
    this.leases.set(leaseId, lease);
    // 静态已注册的走 enable；真隐藏的通知宿主动态注册（幂等：宿主侧去重）
    const dynamic = tools.filter((toolName) => !this.handles.has(toolName) && !this.exposedStatically.has(toolName));
    for (const toolName of dynamic) this.dynamicVisible.add(toolName);
    for (const toolName of tools) this.handles.get(toolName)?.enable();
    if (dynamic.length) this.onDynamicRegister?.(dynamic);
    return {
      status: 'granted', leaseId, group, enabledTools: tools,
      scope: target || (filePath ? { path: path.resolve(filePath) } : {}),
      maxCalls, expiresInSeconds: ttlSeconds,
      // M98 竞态指引：动态注册后服务端会发 tools/list_changed，桥接重同步有约秒级延迟；
      // 若紧接着调用仍报 unknown tool，等待约2秒或重发一次 tools/list 后重试，不要直接放弃。
      note: '工具已动态注册并发送 list_changed；桥接重同步约需 1~2 秒，若紧接着调用仍报 unknown tool 请等待约2秒后重试一次。',
    };
  }

  /** M102 adhoc 直租：任意已注册工具按名租用（兜底“存在但不可达”）。
   * 分级（与分类挂钩，只严不松）：
   * - 全 READ_ONLY → reason 必须为 adhoc_read（300 秒/10 次，读无副作用）；
   * - 含幂等/追加写 → reason 必须为 adhoc_write（180 秒/3 次，绑定单文件）；
   * - 含 DESTRUCTIVE → reason 必须为 adhoc_destructive（120 秒/1 次，绑定单文件）。
   * 硬禁区（直接拒绝，保护既有专用门禁不被旁路）：
   * - 已编入固定深层组的工具（cell_detail/cell_primitive/fr_engine/report_rewrite/batch_read）
   *   必须走各自专用组与 reason（如 report_rewrite 的 explicit_rewrite），adhoc 不予受理；
   * - 未注册/未分类的未知名直接拒绝（用 get_capabilities 查合法工具名）。
   * filePath 必填：租约绑定单文件，beforeCall 按路径强制匹配，防跨文件复用。 */
  grantAdhoc({ filePath, reason, tools }) {
    const wanted = Array.isArray(tools) ? [...new Set(tools.map((t) => String(t)))] : [];
    if (wanted.length === 0) throw new Error('adhoc 必须显式列出 tools=[工具名]（按名直租；用 get_capabilities 查合法工具名）');
    if (!filePath) throw new Error('adhoc 必须绑定 path（租约限定单文件，防止跨文件复用）');
    const known = new Set(allClassifiedToolNames());
    const unknown = wanted.filter((t) => !known.has(t));
    if (unknown.length > 0) throw new Error(`adhoc 未知工具名：${unknown.join('、')}（用 get_capabilities 查合法工具名）`);
    const grouped = wanted.filter((t) => Object.values(DEEP_TOOL_GROUPS).some((s) => s.has(t)));
    if (grouped.length > 0) {
      throw new Error(`adhoc 不受理已有专用租约通道的工具：${grouped.join('、')}（请走各自深层工具组：cell_detail=exact_cell_read / cell_primitive=batch_failure凭failureId / fr_engine=quality_gate或explicit_engine_check / report_rewrite=explicit_rewrite / batch_read=batch_read）`);
    }
    const tier = wanted.some((t) => DESTRUCTIVE_TOOLS.has(t)) ? 'destructive'
      : wanted.some((t) => !READ_ONLY_TOOLS.has(t)) ? 'write' : 'read';
    const wantReason = tier === 'destructive' ? 'adhoc_destructive' : tier === 'write' ? 'adhoc_write' : 'adhoc_read';
    if (reason !== wantReason) {
      throw new Error(`adhoc 本次最高涉及${tier === 'destructive' ? '破坏性' : tier === 'write' ? '写入' : '只读'}工具，reason 必须为 ${wantReason}（当前 "${reason}"）；分级只严不松，混合申请按最严一档执行`);
    }
    const policy = tier === 'destructive' ? { ttlSeconds: 120, maxCalls: 1 }
      : tier === 'write' ? { ttlSeconds: 180, maxCalls: 3 } : { ttlSeconds: 300, maxCalls: 10 };
    const granted = this.grant({ group: 'adhoc', filePath, tools: wanted, reason, ...policy });
    return {
      ...granted,
      tier,
      ...(tier === 'destructive' ? { caution: '破坏性工具临租：单文件域、单次调用、120 秒过期；执行前请自行确认目标与后果，租约只管可达性，不管正确性。' } : {}),
    };
  }
  /** group=auto：只记得工具名、不记得组名时的兜底（instructions 的 unknown tool 修复动作）。
   *  按 tools 反查所属场景族 → 用该族策略授予（reason 可省略）。
   *  **不绕过任何既有门禁**：命中门禁组（cell_detail/cell_primitive/fr_engine/report_rewrite）
   *  直接拒绝并回指正确通道；未编组的工具回指 group=adhoc 与应传的分级 reason。 */
  grantAuto({ filePath, reason, tools }) {
    const wanted = Array.isArray(tools) ? [...new Set(tools.map((t) => String(t)))] : [];
    if (wanted.length === 0) {
      throw new Error('auto 必须显式列出 tools=[工具名]（服务端按工具名反查所属场景族；用 get_capabilities 查合法工具名）');
    }
    const known = new Set(allClassifiedToolNames());
    const unknown = wanted.filter((t) => !known.has(t));
    if (unknown.length > 0) throw new Error(`auto 未知工具名：${unknown.join('、')}（用 get_capabilities 查合法工具名）`);

    const gateHits = wanted.filter((t) => GATE_GROUPS.includes(this.groupOf(t)));
    if (gateHits.length > 0) {
      throw new Error(
        `auto 不绕过门禁组（${gateHits.map((t) => `${t} → 组 ${this.groupOf(t)}`).join('；')}）：`
        + 'cell_detail 需传 target{sheet,cell} 且 reason=exact_cell_read；cell_primitive 需批量失败返回的 failureId；'
        + 'fr_engine 须显式 reason=explicit_engine_check（门禁不自动授予；也可走 verify_cpt 免租约通道）；'
        + 'report_rewrite 须用户明确要求且 reason=explicit_rewrite。请改用对应的具名组调用。',
      );
    }
    const groups = [...new Set(wanted.map((t) => this.groupOf(t)).filter(Boolean))];
    if (groups.length === 0) {
      const tier = wanted.some((t) => DESTRUCTIVE_TOOLS.has(t)) ? 'adhoc_destructive'
        : wanted.some((t) => !READ_ONLY_TOOLS.has(t)) ? 'adhoc_write' : 'adhoc_read';
      throw new Error(
        `auto 无法判组：${wanted.join('、')} 未编入任何场景族，请改用按名直租：`
        + `request_deep_tool_access({path:'<目标.cpt>', group:'adhoc', reason:'${tier}', tools:[${wanted.map((t) => `'${t}'`).join(',')}]})`,
      );
    }
    if (groups.length > 1) {
      throw new Error(`auto 一次只能租一个族：所列工具跨 ${groups.join(' / ')}，请分 ${groups.length} 次申请`);
    }
    const group = groups[0];
    const granted = this.request({ group, path: filePath, reason: undefined });
    return {
      ...granted,
      resolvedFrom: wanted,
      note: `auto 判组 → ${group}（reason=${GROUP_POLICY[group].reason}）；${granted.note}`,
    };
  }

  /** 表驱动的场景族授予（14 个族共用）：具名族只有一个合法 reason，故 reason 可省略；
   *  显式传入则必须匹配（防"用错理由"的静默放行）。 */
  grantGroup(group, { filePath, reason }) {
    const policy = GROUP_POLICY[group];
    const allowed = policy.reasons ?? [policy.reason];
    if (reason !== undefined && reason !== null && reason !== '' && !allowed.includes(reason)) {
      throw new Error(`组 ${group} 仅允许 reason=${allowed.join('/')}（当前 "${reason}"）`);
    }
    if (policy.pathRequired && !filePath) {
      throw new Error(`组 ${group} 必须绑定 path（租约限定单文件，防止跨文件复用）`);
    }
    return this.grant({
      group, filePath, tools: [...DEEP_TOOL_GROUPS[group]],
      ttlSeconds: policy.ttlSeconds, maxCalls: policy.maxCalls,
      reason: (reason === undefined || reason === null || reason === '') ? policy.reason : reason,
    });
  }

  request({ group, path: filePath, reason, target, failureId, tools }) {
    this.cleanup();
    // 非固定成员组的两个入口放在组检查之前：adhoc 按名直租、auto 按名判组。
    if (group === 'adhoc') return this.grantAdhoc({ filePath, reason, tools });
    if (group === 'auto') return this.grantAuto({ filePath, reason, tools });
    const policy = GROUP_POLICY[group];
    // M98 自诊断：未知组直接报出已知组清单——调用方凭此可判定服务端新旧。
    if (!policy) {
      throw new Error(`未知深层工具组 ${group}（已知组：${Object.keys(GROUP_POLICY).join('/')}；`
        + '任意未编组工具可走 group=adhoc 按名直租，只记得工具名可用 group=auto 自动判组）');
    }
    // 既有 5 组的专用门禁分支：语义与阈值一律不变（本方案不新增旁路、不放宽）
    if (policy.special === 'cell_detail') {
      if (reason !== 'exact_cell_read') throw new Error('cell_detail 仅允许 reason=exact_cell_read');
      if (target?.sheet === undefined || !target?.cell) throw new Error('精确单格读取必须明确 target.sheet 和 target.cell');
      parseA1(target.cell);
      return this.grant({
        group, filePath, tools: toolForFields(target.requiredFields), target,
        ttlSeconds: policy.ttlSeconds, maxCalls: policy.maxCalls, reason,
      });
    }
    if (policy.special === 'cell_primitive') {
      if (reason !== 'batch_failure' || !failureId) throw new Error('单格写工具只能在批量操作失败后凭 failureId 解锁');
      const failure = takeBatchFailure(failureId);
      if (!failure) throw new Error('failureId 不存在或已过期');
      if (failure.path !== normalizePath(filePath)) throw new Error('failureId 与当前 CPT 路径不匹配（该 failureId 为一次性凭据，本次请求已将其消耗，换正路径后需用新的 failureId 重新申请）');
      if (!failure.fallbackEligible || failure.affectedCount !== 1) {
        throw new Error('该批量失败涉及多个或不明确的单元格，禁止循环调用单格工具；请修正批量命令（该 failureId 为一次性凭据，本次被拒已将其消耗）');
      }
      return this.grant({
        group, filePath, tools: failure.suggestedTools.filter((name) => DEEP_TOOL_GROUPS.cell_primitive.has(name)),
        target: failure.target,
        ttlSeconds: policy.ttlSeconds, maxCalls: policy.maxCalls, reason,
      });
    }
    if (policy.special === 'fr_engine') {
      if (!policy.reasons.includes(reason)) throw new Error(`FR 引擎工具仅允许 reason=${policy.reasons.join('/')}（显式核验需求；quality_gate_cpt 不再自动授予，也可走 verify_cpt 免租约通道）`);
      const runtime = frRuntimeStatus();
      if (!runtime.ready) return { status: runtime.status, runtime };
      return {
        ...this.grant({
          group, filePath, tools: ['run_fr_engine_check', 'fr_engine_check'],
          ttlSeconds: policy.ttlSeconds, maxCalls: policy.maxCalls, reason,
        }),
        runtime,
      };
    }
    if (policy.special === 'report_rewrite') {
      if (reason !== 'explicit_rewrite') throw new Error('report_rewrite 仅允许 reason=explicit_rewrite（用户明确要求低层/复杂改写）');
      return this.grant({
        group, filePath, tools: [...DEEP_TOOL_GROUPS.report_rewrite],
        ttlSeconds: policy.ttlSeconds, maxCalls: policy.maxCalls, reason,
      });
    }
    if (policy.special === 'batch_read') {
      if (reason !== 'batch_read') throw new Error('batch_read 仅允许 reason=batch_read（批量深挖读取需求）');
      if (!filePath) throw new Error('batch_read 必须绑定 path（租约限定单文件，防止跨文件复用）');
      return this.grant({
        group, filePath, tools: [...DEEP_TOOL_GROUPS.batch_read],
        ttlSeconds: policy.ttlSeconds, maxCalls: policy.maxCalls, reason,
      });
    }
    // 其余场景族：表驱动授予
    return this.grantGroup(group, { filePath, reason });
  }
  beforeCall(toolName, args) {
    if (this.staticExpose || this.exposedStatically.has(toolName)) return null;
    // 2026-10-27 审查修复：adhoc 租出的**非深层**工具同样强制额度。
    // 旧守卫把非 DEEP_TOOL_NAMES 一律放行 ⇒ adhoc 的 maxCalls 形同虚设（只靠 TTL 兜底）；
    // P0-2 取消动态注销后更是永不失守。改为：深层工具 + 曾动态注册（租过）的工具都强制，
    // 纯 profile 静态工具不受影响（它们不在 dynamicVisible）。
    if (!DEEP_TOOL_NAMES.has(toolName) && !this.dynamicVisible.has(toolName)) return null;
    this.cleanup();
    const candidates = [...this.leases.values()].filter((lease) => lease.tools.includes(toolName) && lease.remaining > 0);
    // 路径绑定只约束"真的带 path 参数"的工具：机器级工具（fr_detect/fr_inspect/scheduler_* 等）
    // schema 里没有 path，若仍要求 args.path 匹配，绑了 path 的租约会永远匹配不上 → 永久"未授权"死锁。
    const pathless = this.pathlessTools.has(toolName);
    // 批量模式（目前只有 run_fr_engine_check 的 batch）：一次校验多个文件，单文件租约绑定失去意义。
    // 安全边界不放松：每个 batch 路径仍由 lib/fr-engine-run.js 逐份过 assertToolPath（允许根围栏），
    // 且租约仍要求本工具在有效租约内（candidates 已按 tools 过滤）——只是不再要求 path 与租约一致。
    const batchMode = toolName === 'run_fr_engine_check'
      && Array.isArray(args?.batch) && args.batch.length > 0;
    const lease = candidates.find((item) => pathless || batchMode || !item.path || (args?.path && item.path === normalizePath(args.path)));
    if (!lease) {
      // 两类原因必须分开报：拿去重租是错的药方，路径不匹配该改的是调用参数。
      if (candidates.length > 0) {
        const bound = [...new Set(candidates.map((c) => c.path))].join('、');
        throw new Error(`深层工具 ${toolName} 的租约绑定在 ${bound}，本次调用 path=${args?.path ?? '(未传)'} 不匹配（租约限单文件、禁止跨文件复用）；如需操作其他文件，直接续租该文件：request_deep_tool_access({path:${JSON.stringify(args?.path ?? '<目标.cpt>')}, group:'auto', tools:['${toolName}']})`);
      }
      throw new Error(`深层工具 ${toolName} 当前无可用租约（未授权、额度已用尽或已过期）；${renewHint(toolName, args)}，granted 后原样重试（被拒也耗次数，勿循环申请）`);
    }
    if (lease.target?.cell) {
      const expected = parseA1(lease.target.cell);
      if (Number(args.column) !== expected.column || Number(args.row) !== expected.row) {
        this.afterCall(lease);
        throw new Error(`深层租约只允许访问 ${lease.target.cell}，禁止用于其他单元格或批量循环（本次越权调用已消耗 1 次额度）`);
      }
      if (String(args.sheet ?? 0) !== String(lease.target.sheet)) {
        this.afterCall(lease);
        throw new Error('深层租约的工作表与调用参数不一致（本次调用已消耗 1 次额度）');
      }
    }
    return lease;
  }

  afterCall(lease) {
    if (!lease || this.staticExpose) return;
    lease.remaining -= 1;
    if (lease.remaining <= 0) {
      clearTimeout(lease.timer);
      this.leases.delete(lease.leaseId);
      this.reconcile(lease.tools);
    }
  }

  state() {
    this.cleanup();
    return {
      dynamic: !this.staticExpose,
      groups: Object.fromEntries(Object.entries(DEEP_TOOL_GROUPS).map(([group, names]) => [group, {
        declared: [...names],
        visible: [...names].filter((name) => this.staticExpose
          ? this.handles.has(name)
          : (this.exposedStatically.has(name) || this.dynamicVisible.has(name))),
        unlockable: true,
      }])),
    };
  }

  /** P0-1 剩余额度自查：返回当前有效的租约（剩次 + 过期秒数），供 get_capabilities({leases:true})
   *  按需下发。只在显式查询时进上下文，不占每请求的 tools/list。 */
  leaseStatus() {
    this.cleanup();
    const now = this.now();
    return [...this.leases.values()].map((lease) => ({
      group: lease.group,
      path: lease.path,
      reason: lease.reason,
      tools: lease.tools,
      remaining: lease.remaining,
      maxCalls: lease.maxCalls,
      expiresInSeconds: Math.max(0, Math.round((lease.expiresAt - now) / 1000)),
    }));
  }

  /** P0-1 额度将尽预警：剩 ≤ max(1, ceil(maxCalls×20%)) 且 >0 时回预警文案，否则 null。
   *  由宿主在深层工具调用成功后注入返回体（失败抛错路径已有明确文案，不重复）。 */
  warningFor(lease) {
    if (!lease || this.staticExpose) return null;
    const max = lease.maxCalls ?? 0;
    if (!(max > 0) || lease.remaining <= 0 || lease.remaining >= max) return null;
    if (lease.remaining > Math.max(1, Math.ceil(max * 0.2))) return null;
    return `租约额度将尽：${lease.group} 剩 ${lease.remaining}/${max} 次（约 ${Math.max(0, Math.round((lease.expiresAt - this.now()) / 1000))}s 后过期）；随时用 get_capabilities({leases:true}) 查剩余额度，用尽/过期需重租。`;
  }
}

