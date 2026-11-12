// test/write-boundary.test.js —— 写入边界提示全覆盖（M97）+ 2026-11-07 S6 双档
//
// 背景：审计发现 11 个写工具（delete/move_toolbar_button、set_toolbar_button_icon、
// set_template_theme、update_parameter_widget、add_cell_hyperlink、delete_cell_sort、
// set_cell_content_type、regenerate_from_meta、scheduler_stop、run_fr_engine_check）
// 漏挂 S6 边界提示，与同类工具不一致。本测试锁定：所有非只读工具描述必须带边界约束。
//
// M118 强化：原先只断言描述里出现 "S6" 字样——**留个标记就算过**，语义丢没丢测不出来。
// 现改为断言 S6 提示**自包含**三条语义（不可撤销 / 仅明确要求时调 / 先 read_cpt），
// 并直接量取提示体量上限，防止有人把提示删成空壳或反向膨胀回 157 B 全文。
//
// 2026-11-07 P1 双档（复审 P1-3）：S6 一度按「是否算写」一刀切，导致 13 个只写派生产物
// （引擎报告/本地测试库/调度配置/反编译输出）的工具被谎称"会改 .cpt 且不可撤销"，其中
// run_fr_engine_check 的假警告直接劝退模型跑引擎（与交付铁律冲突）。现在契约分三档：
//   S6_TEMPLATE_WRITE_TOOLS（改 .cpt 正文）→ 强提示；
//   S6_DERIVED_WRITE_TOOLS（只写派生产物）→ 中性提示；
//   NON_TEMPLATE_WRITE_TOOLS（核验类，连提示都不挂）。
// 三档两两不相交、并集恰为全部写类工具，且每一档在运行时的实际描述必须与档位一致。
import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  NON_TEMPLATE_WRITE_TOOLS, S6_TEMPLATE_WRITE_TOOLS, S6_DERIVED_WRITE_TOOLS,
  DESTRUCTIVE_TOOLS, IDEMPOTENT_WRITE_TOOLS, APPEND_WRITE_TOOLS,
} from '../lib/contract.js';
import '../scripts/isolate-store.mjs'; // M123：JS 基线 store 隔离，直跑也不污染真实 store

// 「会改 .cpt 正文」档必须自包含的语义片段（M118：不再依赖 instructions 承接）
const S6_TEMPLATE_SEMANTICS = [
  { key: '不可撤销', re: /不可撤销/ },
  { key: '仅明确要求时调', re: /仅用户明确要求时调/ },
  { key: '先 read_cpt', re: /read_cpt/ },
];
// 「只写派生产物」档必须说清"不动 .cpt 正文"（且不得反向声称不可撤销）
const S6_DERIVED_SEMANTICS = [
  { key: '派生产物', re: /派生产物/ },
  { key: '不改 .cpt 正文', re: /不改 \.cpt 正文/ },
];
const S6_MAX_BYTES = 120; // 当前两档分别约 98 B；留余量，防回弹到 157 B 全文

const hintOf = (desc) => {
  const d = desc || '';
  const i = d.indexOf('【边界·S6】');
  return i < 0 ? null : d.slice(i);
};

test('M97/S6 三档：写类工具的边界提示与契约档位逐档一致（防漏挂/防错档/防反向错配）', async () => {
  const client = new Client({ name: 'boundary-test', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath, args: ['server.js'], cwd: process.cwd(), stderr: 'pipe',
    env: { CPT_MCP_TOOL_PROFILE: 'full' },
  });
  await client.connect(transport);
  try {
    const tools = (await client.listTools()).tools;
    assert.ok(tools.length >= 190, `full 档工具数应≥190，实际 ${tools.length}`);
    const byName = new Map(tools.map((t) => [t.name, t]));

    // ① 三档集合自洽：两两不相交，并集恰为三类写注解之并（新增工具漏归档会在这里失败）
    const writeClass = new Set([...DESTRUCTIVE_TOOLS, ...IDEMPOTENT_WRITE_TOOLS, ...APPEND_WRITE_TOOLS]);
    const tiers = [...NON_TEMPLATE_WRITE_TOOLS, ...S6_TEMPLATE_WRITE_TOOLS, ...S6_DERIVED_WRITE_TOOLS];
    assert.equal(new Set(tiers).size, tiers.length, `S6 三档集合不得重叠：${tiers.filter((n, i) => tiers.indexOf(n) !== i).join(',')}`);
    assert.deepEqual([...writeClass].sort(), [...new Set(tiers)].sort(), 'S6 三档并集必须精确等于「全部写类工具」');
    for (const name of writeClass) assert.ok(byName.has(name), `写类工具 ${name} 不是已注册工具（名字漂移/死配置）`);

    // ② 档位与注解一致：三档成员注解上仍须是写（"不写 .cpt 正文"≠"只读"）
    for (const name of writeClass) {
      assert.equal(byName.get(name).annotations?.readOnlyHint, false, `${name} 注解上须为写（readOnlyHint=false）`);
    }

    // ③ 读工具不得被挂 S6（防止把只读核验/读取吓退成"需用户明确要求"）
    const readWithS6 = tools
      .filter((t) => t.annotations?.readOnlyHint === true && hintOf(t.description) !== null)
      .map((t) => t.name);
    assert.deepEqual(readWithS6, [], `以下只读工具误挂 S6 提示：${readWithS6.join(',')}`);

    // ④ 核验类（NON_TEMPLATE_WRITE_TOOLS）：完全不挂提示
    for (const name of NON_TEMPLATE_WRITE_TOOLS) {
      assert.equal(hintOf(byName.get(name)?.description), null, `${name} 是核验类写工具，不得挂 S6 边界提示`);
    }

    // ⑤ 模板写档：强提示 + 三条语义 + 体量上限
    const badTemplate = [];
    const tooLong = [];
    for (const name of S6_TEMPLATE_WRITE_TOOLS) {
      const hint = hintOf(byName.get(name)?.description);
      if (!hint) { badTemplate.push(`${name}(缺 S6)`); continue; }
      const lack = S6_TEMPLATE_SEMANTICS.filter((s) => !s.re.test(hint)).map((s) => s.key);
      if (lack.length) badTemplate.push(`${name}(缺 ${lack.join('/')})`);
      const bytes = Buffer.byteLength(hint, 'utf8');
      if (bytes > S6_MAX_BYTES) tooLong.push(`${name}=${bytes}B`);
    }
    assert.deepEqual(badTemplate, [], `以下「会改 .cpt」写工具的 S6 提示缺失/语义不完整：${badTemplate.join('、')}`);
    assert.deepEqual(tooLong, [], `以下工具的 S6 提示超过 ${S6_MAX_BYTES} B：${tooLong.join('、')}`);

    // ⑥ 派生写档：中性提示（不得声称"不可撤销"，必须说明不改 .cpt 正文）+ 体量上限
    const badDerived = [];
    const tooLongDerived = [];
    for (const name of S6_DERIVED_WRITE_TOOLS) {
      const hint = hintOf(byName.get(name)?.description);
      if (!hint) { badDerived.push(`${name}(缺 S6)`); continue; }
      const lack = S6_DERIVED_SEMANTICS.filter((s) => !s.re.test(hint)).map((s) => s.key);
      if (lack.length) badDerived.push(`${name}(缺 ${lack.join('/')})`);
      if (/不可撤销/.test(hint)) badDerived.push(`${name}(误称不可撤销)`);
      const bytes = Buffer.byteLength(hint, 'utf8');
      if (bytes > S6_MAX_BYTES) tooLongDerived.push(`${name}=${bytes}B`);
    }
    assert.deepEqual(badDerived, [], `以下「只写派生产物」写工具的 S6 提示不对档：${badDerived.join('、')}`);
    assert.deepEqual(tooLongDerived, [], `以下工具的派生档 S6 提示超过 ${S6_MAX_BYTES} B：${tooLongDerived.join('、')}`);
  } finally {
    await client.close();
  }
});
