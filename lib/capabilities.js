// cpt-mcp/lib/capabilities.js
// 面向模型的能力契约：让模型先知道“能做什么/不能做什么/应该走哪条路径”，
// 避免把未覆盖的 FR 功能臆造为 XML，或在原语与一键构建之间来回漂移。
//
// 工具地图（L3 注意力治理）：静态清单 + 场景族租约目录 + 两段式协议 + unknown tool 修复动作。
// 地图与运行时**同源**：族目录直接由 lib/lease-groups.js 的 LEASE_GROUPS 渲染，
// 节说明由 lib/spec-sections.js 的 SPEC_SECTIONS 下发 —— 三处（本返回值 / instructions /
// 运行时组表）不会各写一份而漂移。
import {
  allClassifiedToolNames, READ_ONLY_TOOLS, DESTRUCTIVE_TOOLS, IDEMPOTENT_WRITE_TOOLS,
  APPEND_WRITE_TOOLS, LEASE_GROUPS, GATE_GROUPS, REPORT_STATIC_TOOLS,
  SECTION_REFS, selectSpecSections,
} from './contract.js';
import { securityPolicy } from './security.js';
import { listLocalDbFiles, localDbRoot } from './localdb.js';

/** 族目录条目：成员 + 策略 + 逐字可执行的解锁调用示例 */
function leaseDirectory() {
  return Object.fromEntries(Object.entries(LEASE_GROUPS).map(([name, g]) => [name, {
    members: g.members,
    reason: g.reasons ? g.reasons.join(' / ') : g.reason,
    ttlSeconds: g.ttlSeconds,
    maxCalls: g.maxCalls,
    pathRequired: g.pathRequired !== false,
    gate: g.gate === true,
    why: g.why,
    unlock: `request_deep_tool_access({path:'<目标.cpt>', group:'${name}'${g.gate ? `, reason:'${g.reason}'` : ''}})`,
  }]));
}

export function capabilityManifest(query = {}) {
  const { tool, group, section } = query ?? {};
  const profile = process.env.CPT_MCP_TOOL_PROFILE ?? 'report';
  const base = {
    product: 'cpt-mcp',
    standalone: '自包含：业务规则（工具地图/交付门槛/降级路径）全在本 MCP 的 instructions 与能力清单里，不依赖宿主预设 persona；宿主缺文档/DB/预览/git 能力时按 instructions「八、降级」执行。',
    format: 'FineReport .cpt flat XML template',
    toolProfile: {
      active: profile,
      entries: {
        generate: 'node server-generate.js（9 个工具：generate_report 唯一写路径 + quality_gate_cpt 交付判定 + get_build_progress 工序顺序，适合较弱模型）',
        focused: 'node server-focused.js（42 个工具：从零建表最小集 + 常用修改 + 质量门槛；弱模型省 token 用）',
        report: `默认档（CPT_MCP_TOOL_PROFILE 缺省即 report）：node server.js（${REPORT_STATIC_TOOLS.length} 个静态工具：门/协议 + 通用只读原语 + 每任务必用写原语 + 交付门禁；其余能力按场景族租约解锁）`,
        full: 'node server-full.js 或 CPT_MCP_TOOL_PROFILE=full node server.js（全部工具静态全量，完整覆盖）',
      },
    },
    // —— 环境就绪度（2026-11-05 P1-6）：模型不用先解锁 local_db 租约就能知道本地库有没有建；
    //    这是响应体字段，不进 tools/list、不占 report 静态预算。 ——
    environment: {
      localDb: (() => {
        try {
          const files = listLocalDbFiles();
          return {
            root: localDbRoot(),
            ready: files.length > 0,
            databases: files.slice(0, 10).map((f) => f.name),
            total: files.length,
            note: files.length
              ? '本地 SQLite 测试库已就绪：run_dataset_sql_check 缺省 target=local 会直接用它；改已有报表先 local_db_import({action:"report", db, path}) 复制全部连接+填报目标表；Excel 预检用 action:"excel"'
              : '本地 SQLite 测试库未建：run_dataset_sql_check 缺省会返回 localDbReady:false + nextAction；先 local_db_import({action:"auto"})（有真实连接）或 action:"report"（已有报表全量环境）/ action:"ddl"+action:"seed"（纯离线），report/focused 档需先租 local_db 族；内置预览只允许本地 SQLite',
          };
        } catch (e) {
          return { ready: false, error: String(e?.message ?? e) };
        }
      })(),
    },
    // —— L3 工具地图：两段式协议 + 族目录 + 修复动作（与 instructions 同源） ——
    toolMap: {
      protocol: [
        '1) 动手前先 get_capabilities 看地图（本返回值）；',
        '2) 要用的能力不在当前工具表里 → 先 request_deep_tool_access 解锁它所属的场景族；',
        '3) 再调用该工具。只读原语不需要租约；已编组的写能力一律先租后调。',
        '4) 剩余额度随时用 get_capabilities({leases:true}) 查（剩次+过期秒数）；深层调用剩 ≤20% 时返回体自带 leaseWarning，用尽/过期需重租。',
      ],
      staticTools: [...REPORT_STATIC_TOOLS],
      leaseGroups: leaseDirectory(),
      adhoc: '任意**未编组**工具按名直租：request_deep_tool_access({path, group:\'adhoc\', reason:\'adhoc_read|adhoc_write|adhoc_destructive\', tools:[\'X\']})；reason 按涉及面取最严一档，绑单文件。',
      auto: '只记得工具名、不记得组名：request_deep_tool_access({path, group:\'auto\', tools:[\'X\']}) —— 服务端按名反查族并用该族策略授予（reason 可省略）。',
      gateGroups: [...GATE_GROUPS],
      unknownToolFix: '若报 unknown tool "mcp__cpt-mcp__X" 或 Tool X not found：调用 request_deep_tool_access({path:\'<目标.cpt>\', group:\'auto\', tools:[\'X\']}) 后原样重试；不要换工具名硬凑，也不要重复申请同一个组（被拒也耗次数）。granted 后桥接重同步约 1~2 秒，紧接着仍报 unknown 就等约 2 秒重试一次。',
      gateBrief: 'validate_cpt / quality_gate_cpt / verify_cpt 支持 brief:true（结论 + 前 5 条明细 + 全量计数，≈1.5KB；部署侧 CPT_MCP_GATE_BRIEF=1 可设默认）；同文件同参数重复调用返回 cached:true + cachedAgeSeconds（TTL 默认 10 分钟，模板 sha/引擎报告/本地库变化即失效）。要完整明细传 brief:false。',
      /** 取某工具的完整参数说明（= 该工具外移出去的节；工具的广告 schema 里只放节引用） */
      paramDocsBySection: Object.fromEntries(Object.entries(SECTION_REFS)
        .filter(([, refs]) => refs.length > 0)
        .map(([name, refs]) => [name, `get_capabilities({tool:"${name}", section:"${refs[0]}"})`])),
    },
    workflow: {
      newReport: 'generate_report（字段+数据源，静态）或 build_report（完整语义 spec；report 档需先 request_deep_tool_access({group:"generator_full"})）',
      fineControl: '先 read_cpt，再使用单个增量工具，最后 validate_cpt + style_review_cpt + reasonableness_review_cpt',
      orderedBuild: 'read_cpt({includeProgress:true}) 的 buildProgress 按工序（数据集→样式→单元格与扩展→网格→页面→参数→填报）推进，不要想到哪做到哪',
      deliveryGate: 'quality_gate_cpt 返回 pass/structuralPass（结构门槛）与 deliveryPass（最终交付=pass&&engineCheck pass）三字段并列，deliveryPass=true 才可交付；blockers[].fix 给出修复用的工具调用；门禁只读缓存引擎结论、不自动跑引擎、**也不自动授予租约** —— engineCheck 非 pass 时首选 verify_cpt({path,engine:true})（静态免租约）刷新报告再重跑；要用 run_fr_engine_check 须先显式 request_deep_tool_access({path,group:"fr_engine",reason:"explicit_engine_check"})；只重跑门禁不会翻牌；详细 QA 流水线见 docs/qa-workflow.md',
        selfCheck: '自主核验：每次写工具成功后返回体自带 selfCheck（结构+门禁，CPT_MCP_AUTO_VERIFY=off|structure|engine 控制）；要一次拿全层结论（含真引擎与期望值对账）调 verify_cpt({path, engine:true, expectations})',
      localSqlTest: 'SQL 数据集默认先走本地 SQLite 测试库（测试环境口径：run_dataset_sql_check 的 target 缺省 local，真实库须显式 target:"real"）：先 offline:true 验语法/绑定列 → 需要真实库结论再显式 target:"real"（或 both）/ dataset_sql_parity 对账（dataset_sql_parity 属 local_db 租约族，需先 request_deep_tool_access({path, group:"local_db"})；免租约替代是 run_dataset_sql_check({target:"both"})）。本地库准备走 local_db 租约族：local_db_admin 建库；local_db_import({action:"auto", db, connection, path}) 一条命令镜像 schema + 按需抽样（默认 ≤200 行/表、≤5000 行合计，只补空表，不覆盖本地造数；敏感列只点名不回显值）；也可 action:"schema"（autoTables=true 递归扫任意深度 FROM/JOIN，含 EXISTS/子查询/CTE/UNION，schema 限定名按裸表镜像）或纯离线 ddl+seed。sql 候选必须是可执行 SQL：模板原文含 ${if(...)} 等公式参数时先展开为空分支/真实值，直接传 local 会拼出 WHERE 1=1 NULL 的假语法错；真实库只读，不拿它当 SQL 试错沙箱；本地通过≠生产通过，交付看 quality_gate_cpt 的 deliveryPass。',
      reportTestEnv: '改已有报表用 local_db_import({action:"report", db, path})：扫描 .cpt 全部数据集连接 + 填报提交目标表（列映射 table / 自由 SQL 的 UPDATE/INSERT/DELETE），有只读真实连接时镜像 schema+按需抽样到内置 SQLite，本地已有表复用；新建报表用 ddl/table/rows 建 fixture。生产库只允许 MCP 只读读取并导入，内置 FR 预览禁止继承 jdbc:mysql/Doris 等外部连接（发现会 external-data-connection-blocked，只允许本地 jdbc:sqlite/jdbc:hsqldb）；start_fr_preview 的 localTest 缺省 true 会自动把本地 SQLite 连接写入预览 finedb；返回 runtime.status=unverified，填报必须 start_fr_preview 实点；quality_gate_cpt 对填报模板另返回 fillRuntime=unverified（不改 pass/deliveryPass）。加 writeAudit:true 可在本地目标表装写审计触发器并返回 runId；提交后用 local_db_admin({action:"write_audit",db,runId}) 看写入行数/次数/时间；也可 local_db_admin({action:"simulate_fill",db,path,scenario}) 在事务内试写并回滚，看每 sheet 写行数与 staleKeys。',
      excelImportTest: 'Excel 导入离线仿真（模板有「导入Excel」按钮时、交付前必跑）：local_db_import({action:"excel", db, path, excelFile, simulate:true})。按 FR 普通导入「位置样式匹配 1:1」校验导入按钮、xlsx 列位/表头/控件类型/公式缓存与本地目标表约束（NOT NULL/UNIQUE/类型），并在本地 SQLite 事务内逐行 INSERT 后必然 ROLLBACK（不落库、不执行 before/afterimportexcel 前端 JS）；本地库/目标表缺失时 simulation.status=skipped 并给 local_db_import({action:"auto"}) 引导，不算失败。离线通过≠FR 页面行为通过，样式/权限/移动端/真实落库仍需预览或真机验证。',
      reverseDesigner: 'fr_detect → fr_inspect → run_fr_engine_check（触发真实引擎校验，无需 shell）→ fr_engine_check（读结论）；fr_decompile 仅在本机存在 cptdec 时可用',
      paramDocs: '巨块参数（spec / border / dictionary / widgetDictionary / options / 页面设置 / 视图枚举等）的完整语义用 get_capabilities({tool:"<工具名>", section:"<节键>"}) 分节取，不要凭记忆写。',
    },
    supported: {
      dataSources: [
        'SQL database table',
        'Excel .xls/.xlsx',
        'recursion/tree dataset',
        '内置 SQLite 本地测试库（offlineLocalDb）：测试环境默认口径；建库/镜像真实 schema/按需抽样/造数/离线跑数据集 SQL/真实 vs 本地对账/Excel 导入离线仿真；本地通过≠生产通过',
      ],
      layout: ['multiple sheets', 'cells', 'merge/span', 'row/column grid', 'page settings', 'header/footer'],
      presentation: ['styles', 'template themes', 'conditional highlights', 'reportlet/url hyperlinks', 'column/line/pie charts', 'float text elements (官方 76 例实证)'],
      interaction: ['fill submit/bindings (submit type InsertConfig/IntelliDMLConfig / submit condition FormulaCondition/ListCondition / per-column skipUnmodified = 列级智能提交 / free SQL parameters)', 'parameter definitions/panel/widgets', 'report-level JS (TopJS/报表JS) and report events (Listener)', 'page-preview JS (WebPageContent/afterload, set_webpage_js)', 'toolbar buttons: add_toolbar_button(buttonText=自定义按钮 / builtin=追加内置按钮，如 import-append 导入Excel) + set_toolbar_button_js 写 JS + set_fill_toolbar 整栏重建'],
      lifecycle: ['read/validate/review/build/generate', 'real-engine ground-truth check (fr_engine_check + verify:fr)', 'cron validation/review/decompile/snapshot'],
    },
    explicitlyUnsupported: [
      'EmbeddedTableData / RowData 私有压缩编码',
      'CSV/text/XML file datasets (当前没有本机实证模板形态)',
      '未经验证的 VanChart 自定义 Plot XML',
      'Compare IN / IS NULL 私有编码形态（请改用条件公式）',
    ],
    toolClasses: {
      readOnly: [...READ_ONLY_TOOLS].sort(),
      destructive: [...DESTRUCTIVE_TOOLS].sort(),
      idempotentWrite: [...IDEMPOTENT_WRITE_TOOLS].sort(),
      appendWrite: [...APPEND_WRITE_TOOLS].sort(),
      all: allClassifiedToolNames().sort(),
    },
    safety: securityPolicy(),
    // 版本控制是宿主可选能力（2026-10-26 自包含化）：本 MCP 不实现 git，也不假定宿主一定有；
    // .bak 只是崩溃兜底，CPT_MCP_NO_BAK=1 可停建（交给版本管理接管的目录建议开启）。
    versioning: {
      provider: 'host (optional)',
      tools: ['git_status', 'git_diff', 'git_log', 'git_commit', 'git_init', 'git_branch（名字随宿主而定，可能不存在）'],
      flow: '有本地 git 工具时：改前 git_status/git_diff 看干净度 → 改后过 quality_gate_cpt → 仅本地提交；没有时交付里标注「未落库」',
      localBackups: ['.bak-build-*', '.bak-batch-*'],
      noBakEnv: 'CPT_MCP_NO_BAK=1',
      selfContained: '本 MCP 不做版本控制；.bak 不是版本，不能回滚',
    },
  };
  if (!tool && !group && !section) return base;

  // —— 带参查询：按需下发（无参调用仍返回上面的完整清单，向后兼容） ——
  const answer = {
    product: base.product,
    toolProfile: base.toolProfile,
    query: { tool: tool ?? null, group: group ?? null, section: section ?? null },
  };
  if (tool || section) {
    const { sections, unknown } = selectSpecSections(tool, section);
    answer.specSections = sections;
    if (tool) {
      answer.tool = {
        name: tool,
        staticInReport: REPORT_STATIC_TOOLS.includes(tool),
        leaseGroup: Object.entries(LEASE_GROUPS).find(([, g]) => g.members.includes(tool))?.[0] ?? null,
        sections: SECTION_REFS[tool] ?? [],
      };
      if (!(SECTION_REFS[tool] ?? []).length) {
        answer.tool.note = '该工具没有外移出去的参数节（参数说明就在它的 inputSchema 里）。';
      }
    }
    if (unknown.length) {
      // selectSpecSections 对「没有外移参数节」的工具也回“未知工具”—— sandbox4/v1 会话里
      // get_capabilities({tool:"add_fill_submit"}) 就被误标成未知（实际是深层工具，参数在
      // inputSchema）。已注册工具要走「解锁」引导，而不是让模型以为工具名写错。
      answer.unknown = unknown.map((msg) => {
        if (!tool || !allClassifiedToolNames().includes(tool)) return msg;
        const groupName = Object.entries(LEASE_GROUPS).find(([, g]) => g.members.includes(tool))?.[0] ?? null;
        if (groupName) {
          return `工具 ${tool} 是深层工具（场景族 ${groupName}），没有外移参数节 —— 参数说明在其 inputSchema；先 request_deep_tool_access({path:'<目标.cpt>', group:'${groupName}'}) 解锁后调用即可（若当前档位已可见则直接调用）。`;
        }
        return `工具 ${tool} 已注册但没有外移参数节（参数说明在其 inputSchema）；若当前档位看不到它，用 request_deep_tool_access({path:'<目标.cpt>', group:'auto', tools:['${tool}']}) 解锁。`;
      });
    }
  }
  if (group) {
    const dir = leaseDirectory();
    if (dir[group]) {
      answer.group = { name: group, ...dir[group] };
    } else if (group === 'adhoc' || group === 'auto') {
      answer.group = { name: group, why: group === 'adhoc' ? base.toolMap.adhoc : base.toolMap.auto };
    } else {
      answer.unknown = [...(answer.unknown ?? []), `未知场景族 ${group}（可用族：${Object.keys(dir).join('、')}；未编组工具走 group:"adhoc"）`];
    }
  }
  return answer;
}
