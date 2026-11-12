// test/standalone.test.js —— 自包含契约（与宿主预设解耦，2026-10-26）
//
// 目标：cpt-mcp 的业务规则必须全部写在它自己的 instructions / 能力清单里，
// 不依赖任何宿主预设（persona / instructions / 会话历史）。本文件锁三件事：
//   ① instructions 体积在 DSH 的 maxInstructionBytes(32768) 之内；
//   ② instructions 不点名任何宿主预设/插件，且覆盖「降级路径 / 重复劳动策略 / 交付汇报」；
//   ③ 无 CPT_MCP_TOOL_PROFILE 时默认档位就是业务完整面（report），开箱即用。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { CPT_MCP_INSTRUCTIONS, REPORT_STATIC_TOOLS } from '../lib/contract.js';
import '../scripts/isolate-store.mjs';

const MAX_INSTRUCTION_BYTES = 32768; // DSH dsh-mcp-client 的 maxInstructionBytes

test('instructions 体积在宿主上限内（留 ≥8KB 余量给归属文本）', () => {
  const bytes = Buffer.byteLength(CPT_MCP_INSTRUCTIONS, 'utf8');
  assert.ok(bytes < MAX_INSTRUCTION_BYTES, `instructions ${bytes}B 超过 ${MAX_INSTRUCTION_BYTES}B`);
  assert.ok(MAX_INSTRUCTION_BYTES - bytes >= 8192, `余量 ${MAX_INSTRUCTION_BYTES - bytes}B 太小`);
});

test('instructions 与宿主预设解耦：不点名任何预设/插件', () => {
  for (const forbidden of ['报表模式', 'report-mode', 'dsh-report-mode', 'dsh-report-git']) {
    assert.equal(CPT_MCP_INSTRUCTIONS.includes(forbidden), false, `不应出现宿主预设名：${forbidden}`);
  }
});

test('instructions 覆盖自包含契约的四个要件', () => {
  for (const required of [
    '自包含声明',                 // 零、自包含声明
    '宿主可选能力与降级',         // 八、降级路径
    '重复劳动的默认策略',         // 九、批量/PTC
    '交付汇报模板',               // 十、汇报格式
  ]) {
    assert.ok(CPT_MCP_INSTRUCTIONS.includes(required), `instructions 缺少要件：${required}`);
  }
});

test('降级路径逐项列全（文档/DB/预览/git/Excel/PTC/引擎都点名）', () => {
  for (const kw of ['fr-docx-mcp', 'execute_query', 'take_screenshot', 'git_status',
    'source.excelFile', 'run_code', 'run_fr_engine_check']) {
    assert.ok(CPT_MCP_INSTRUCTIONS.includes(kw), `降级章节应点名：${kw}`);
  }
  // 降级必须强调"不许假装成功"
  assert.match(CPT_MCP_INSTRUCTIONS, /不许假装成功|不要伪造 pass|未验证/);
});

test('重复劳动策略指向批量工具与 PTC 配方', () => {
  for (const kw of ['add_parameter_widget_batch', 'update_parameter_widget_batch',
    'add_cell_highlight_batch', 'ptc.recipes']) {
    assert.ok(CPT_MCP_INSTRUCTIONS.includes(kw), `重复劳动策略应提到：${kw}`);
  }
});

async function withDefaultProfile(fn) {
  const client = new Client({ name: 'standalone-test', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath, args: ['server.js'], cwd: process.cwd(), stderr: 'pipe',
    // 关键：不传 CPT_MCP_TOOL_PROFILE（验证默认档位即业务完整面）
    env: { CPT_MCP_ALLOWED_ROOTS: os.tmpdir() },
  });
  await client.connect(transport);
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

test('默认档位 = report（开箱即业务完整面，不依赖宿主注入 env）', async () => {
  await withDefaultProfile(async (client) => {
    const names = (await client.listTools()).tools.map((t) => t.name);
    assert.equal(names.length, REPORT_STATIC_TOOLS.length, `默认档应为 ${REPORT_STATIC_TOOLS.length} 项（report），实际 ${names.length}`);
    for (const t of ['get_datasets', 'get_cells', 'run_dataset_sql_check',
      'add_parameter_widget_batch', 'quality_gate_cpt']) {
      assert.ok(names.includes(t), `默认档应含 ${t}`);
    }
    // 2026-11-12 P0-1：非原子批量 add_cell_highlight_batch 默认隐藏（adhoc 临租），不常驻
    assert.equal(names.includes('add_cell_highlight_batch'), false, '默认档不应含非原子批量 highlight 工具');
    // focused 专属的脚本类工具不在默认档（通过租约获取，而不是默认铺开）
    assert.equal(names.includes('set_webwrite_js'), false, '默认档不应静态铺开 scripting 族工具');
  });
});

test('能力清单自报 standalone 且版本控制标为宿主可选', async () => {
  await withDefaultProfile(async (client) => {
    const r = await client.callTool({ name: 'get_capabilities', arguments: {} });
    const data = JSON.parse((r.content || []).find((c) => c.type === 'text').text);
    assert.equal(data.toolProfile.active, 'report', '默认档位应自报 report');
    assert.ok(typeof data.standalone === 'string' && data.standalone.includes('自包含'), '应自报自包含');
    assert.equal(data.versioning.provider, 'host (optional)');
    assert.match(String(data.versioning.flow), /未落库/, '缺 git 时要有降级说法');
    // 默认档位说明里不应再把 report 绑到某个宿主 persona
    assert.equal(/persona/.test(String(data.toolProfile.entries.report)), false);
  });
});
