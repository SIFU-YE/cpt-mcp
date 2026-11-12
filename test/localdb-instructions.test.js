// test/localdb-instructions.test.js —— 提示词层：新 MCP 必须教模型使用内置 SQLite 本地测试库（2026-11-02）
// 背景：sandbox4/v1 会话（真实业务 6 模板）13 次 run_dataset_sql_check 全是 target=real（默认），
// 0 次 local_db/dataset_sql_parity —— 当时 MCP 版本/提示词里都没有本地测试库的用法，模型自然只会用真实库。
// 本文件锁住「提示词能教会模型用新功能」：instructions + 能力清单必须同时出现离线测试流程。
import test from 'node:test';
import assert from 'node:assert/strict';
import { CPT_MCP_INSTRUCTIONS } from '../lib/contract.js';
import { capabilityManifest } from '../lib/capabilities.js';

const MAX_INSTRUCTION_BYTES = 32768;
const MIN_MARGIN = 8192;

test('instructions 体积仍在上限内（留 ≥8KB 余量）', () => {
  const bytes = Buffer.byteLength(CPT_MCP_INSTRUCTIONS, 'utf8');
  assert.ok(bytes < MAX_INSTRUCTION_BYTES, `instructions ${bytes}B 超过 ${MAX_INSTRUCTION_BYTES}B`);
  assert.ok(MAX_INSTRUCTION_BYTES - bytes >= MIN_MARGIN, `余量 ${MAX_INSTRUCTION_BYTES - bytes}B 小于 ${MIN_MARGIN}B`);
});

test('instructions 教会模型用本地测试库（默认 local/按需抽样/Excel 预检/对账/边界）', () => {
  const must = [
    '内置 SQLite',
    '二之二',
    'get_local_db_status',
    'local_db',
    'local_db_import',
    'autoTables',
    'run_dataset_sql_check',
    'target 缺省 local',
    'offline:true',
    'dataset_sql_parity',
    'action:"auto"',
    'action:"excel"',
    '≠ 生产通过',
    '真实库只读',
    '公式参数',
    'WHERE 1=1 NULL',
  ];
  for (const kw of must) assert.ok(CPT_MCP_INSTRUCTIONS.includes(kw), `instructions 缺少本地测试库要点：${kw}`);
});

test('instructions 锁定 2026-11-03 会话教训：自述不算验收，主 agent 必须亲自复跑', () => {
  assert.match(CPT_MCP_INSTRUCTIONS, /自述不算数/, '子代理/历史会话自述不能当验收证据');
  assert.match(CPT_MCP_INSTRUCTIONS, /亲自重跑 check_report_js/, '主 agent 必须亲自重跑校验链');
});

test('instructions 把「SQL 先本地后真实」写成铁律，且质量门禁默认审计可被发现', () => {
  assert.match(CPT_MCP_INSTRUCTIONS, /先在内置 SQLite 本地测试库跑通，再验证真实库/, '铁律应显式要求 SQL 先本地后真实');
  assert.match(CPT_MCP_INSTRUCTIONS, /target:"real"/, '应指导本地通过后再跑真实库');
  assert.match(CPT_MCP_INSTRUCTIONS, /本地 SQL 离线审计/, '质量门禁默认审计应写进提示词');
  assert.match(CPT_MCP_INSTRUCTIONS, /deliveryPass=true 才能交付|deliveryPass=true 才可交付/, '交付门槛不可弱化');
});

test('能力清单 workflow/local_sql_test 与 dataSources 同步（不只有 instructions 一份）', () => {
  const manifest = capabilityManifest();
  assert.match(String(manifest.workflow?.localSqlTest || ''), /target 缺省 local/, 'workflow.localSqlTest 应说明缺省 local');
  assert.match(String(manifest.workflow?.localSqlTest || ''), /autoTables/, 'workflow.localSqlTest 应给出 autoTables 建库路径');
  assert.match(String(manifest.workflow?.localSqlTest || ''), /action:"auto"/, 'workflow.localSqlTest 应给出按需抽样 action:auto');
  assert.match(String(manifest.workflow?.excelImportTest || ''), /action:"excel"/, 'workflow.excelImportTest 应给出 Excel 导入仿真用法');
  assert.ok(
    (manifest.supported?.dataSources || []).some((s) => /SQLite/.test(String(s))),
    'supported.dataSources 应列出内置 SQLite 本地测试库',
  );
  // 租约族目录由 LEASE_GROUPS 渲染，必须包含 local_db 且给逐字解锁示例
  const group = manifest.toolMap?.leaseGroups?.local_db;
  assert.ok(group, 'get_capabilities 应包含 local_db 租约族');
  assert.match(String(group.unlock), /group:'local_db'/);
  assert.ok(group.members.includes('local_db_import'));
  assert.ok(group.members.includes('dataset_sql_parity'));
});

test('能力清单 environment.localDb 暴露本地库就绪度（P1-6：不用先解锁租约才知道有没有库）', () => {
  const manifest = capabilityManifest();
  const env = manifest.environment?.localDb;
  assert.ok(env, 'get_capabilities 应包含 environment.localDb');
  assert.equal(typeof env.ready, 'boolean');
  assert.equal(typeof env.note, 'string');
  assert.ok(Array.isArray(env.databases), 'databases 应为数组（最多列前 10 个，不含敏感取值）');
  assert.ok(env.root == null || typeof env.root === 'string');
  // 未就绪时必须给可执行的下一步，不能只说"没有库"
  if (!env.ready) assert.match(env.note, /local_db_import/);
});
