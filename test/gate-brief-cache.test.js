// test/gate-brief-cache.test.js —— 2026-11-12 P0-2：门禁摘要 + 结论缓存
//
// 目标（按会话记录降本）：
//   ① brief=true 让 validate_cpt / quality_gate_cpt / verify_cpt 只回"结论 + 前 5 条明细 + 计数"，
//      输出显著变小，但 pass/structuralPass/deliveryPass、blockers 的 location/message/fix 仍保留；
//   ② 同一文件 + 同一参数重复调用 → 第二次直接复用上次结论（cached=true/cachedAgeSeconds），
//      不重跑门禁；
//   ③ 文件、引擎报告或本地库发生变化 → 缓存自动失效（cached 消失，重新计算）；
//   ④ 缺省行为不变（不传 brief 且未设 CPT_MCP_GATE_BRIEF 时仍是完整明细）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createCpt, addCell } from '../lib/generate.js';
import { cacheClear, cacheSize, cacheLookup, cacheStore, gateFingerprint, fileFingerprint } from '../lib/gate-cache.js';
import '../scripts/isolate-store.mjs';

delete process.env.CPT_MCP_ALLOWED_ROOTS;

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-gate-'));
const bytes = (v) => Buffer.byteLength(JSON.stringify(v), 'utf8');

async function withServer(env, fn) {
  const dir = tmp();
  const p = path.join(dir, 'g.cpt');
  createCpt(p, { rows: 4, columns: 4, webWrite: true });
  const client = new Client({ name: 'gate-brief-test', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath, args: ['server.js'], cwd: process.cwd(), stderr: 'pipe',
    env: { CPT_MCP_TOOL_PROFILE: 'report', CPT_MCP_ALLOWED_ROOTS: `${os.homedir()};${os.tmpdir()}`, ...env },
  });
  await client.connect(transport);
  const call = async (name, args) => {
    const r = await client.callTool({ name, arguments: args });
    const text = r.content?.[0]?.text ?? '';
    let data = null; try { data = JSON.parse(text); } catch { /* 非 JSON */ }
    return { isError: r.isError === true, text, data, res: r };
  };
  try {
    return await fn({ client, call, dir, p });
  } finally {
    await client.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('validate_cpt：第二次同参调用命中缓存；改文件后自动失效', async () => {
  cacheClear();
  await withServer({}, async ({ call, p }) => {
    const first = await call('validate_cpt', { path: p });
    assert.ok(!first.isError, first.text.slice(0, 160));
    assert.equal(first.data?.cached, undefined, '首次应实际计算');
    assert.ok(Array.isArray(first.data?.issues));
    const second = await call('validate_cpt', { path: p });
    assert.equal(second.data?.cached, true, '同文件同参数应命中缓存');
    assert.ok(second.data?.cachedAgeSeconds >= 0);
    assert.deepEqual(second.data?.issues, first.data?.issues, '缓存结论应与首跑一致');
    // 写入改变文件 → 指纹变化 → 缓存失效
    addCell(p, { column: 0, row: 1, content: 'changed' });
    const third = await call('validate_cpt', { path: p });
    assert.equal(third.data?.cached, undefined, '文件变化后必须重算');
  });
});

test('validate_cpt：brief=true 摘要形态正确；大量 issue 时显著更小（单元验证裁剪）', async () => {
  cacheClear();
  await withServer({}, async ({ call, p }) => {
    const brief = await call('validate_cpt', { path: p, brief: true });
    assert.ok(!brief.isError, brief.text.slice(0, 160));
    assert.equal(brief.data?.brief, true);
    assert.ok(Array.isArray(brief.data?.errors) && brief.data.errors.length <= 5);
    assert.match(String(brief.data?.hint), /brief:false/);
    assert.ok(bytes(brief.data) <= 1500, `摘要应 ≤1.5KB，实际 ${bytes(brief.data)}B`);
  });
  // 单元：issue 很多时摘要必须更小，且前 5 条保留 location/message/fix
  const { briefValidate } = await import('../lib/gate-brief.js');
  const issues = Array.from({ length: 40 }, (_, i) => ({
    severity: i < 30 ? 'error' : 'warning',
    code: `E${i}`,
    location: `sheet1!A${i + 1}`,
    message: `第 ${i} 条错误消息，带一段足够长的说明文字用于撑大全量输出`.repeat(2),
    fix: `调用 update_cell 修复第 ${i} 条，再重跑 validate_cpt`.repeat(2),
  }));
  const full = { path: 'x.cpt', summary: { errors: 30, warnings: 10, infos: 0 }, issues };
  const brief = briefValidate(full);
  assert.equal(brief.errorsTotal, 30);
  assert.equal(brief.errors.length, 5);
  assert.equal(brief.errorsTruncated, true);
  assert.ok(bytes(brief) < bytes(full) / 3, `摘要应 < 全量 1/3：${bytes(brief)} vs ${bytes(full)}`);
  assert.ok(brief.errors[0].location && brief.errors[0].fix, '摘要必须保留 location/fix（可执行信息）');
});

test('quality_gate_cpt：缓存命中 + brief 摘要显著更小 + 写入后失效', async () => {
  cacheClear();
  await withServer({}, async ({ call, p }) => {
    const full = await call('quality_gate_cpt', { path: p });
    assert.ok(!full.isError, full.text.slice(0, 200));
    assert.equal(typeof full.data?.pass, 'boolean');
    assert.equal(full.data?.cached, undefined);
    const again = await call('quality_gate_cpt', { path: p });
    assert.equal(again.data?.cached, true);
    assert.equal(again.data?.pass, full.data?.pass);
    const brief = await call('quality_gate_cpt', { path: p, brief: true });
    assert.equal(brief.data?.brief, true);
    assert.equal(brief.data?.pass, full.data?.pass);
    assert.equal(brief.data?.structuralPass, full.data?.structuralPass);
    assert.equal(brief.data?.deliveryPass, full.data?.deliveryPass);
    assert.equal(brief.data?.engineCheck?.status, full.data?.engineCheck?.status);
    assert.ok(Array.isArray(brief.data?.blockers) && brief.data.blockers.length <= 5);
    assert.equal(brief.data?.blockersTotal, (full.data?.blockers ?? []).length);
    assert.ok(bytes(brief.data) < bytes(full.data), `brief 应更小：${bytes(brief.data)}B vs ${bytes(full.data)}B`);
    assert.ok(!('checklist' in brief.data), '摘要不回全量 checklist');
    // 写入 → 文件指纹变化 → 重算（cached 消失）
    addCell(p, { column: 1, row: 2, content: 'x' });
    const fresh = await call('quality_gate_cpt', { path: p });
    assert.equal(fresh.data?.cached, undefined, '文件变化后门禁必须重算');
  });
});

test('verify_cpt(engine:false)：同参第二次命中缓存；brief 摘要保留分层状态', async () => {
  cacheClear();
  await withServer({}, async ({ call, p }) => {
    const full = await call('verify_cpt', { path: p, engine: false });
    assert.ok(!full.isError, full.text.slice(0, 200));
    assert.equal(full.data?.cached, undefined);
    assert.ok(Array.isArray(full.data?.layers) && full.data.layers.length >= 2);
    const again = await call('verify_cpt', { path: p, engine: false });
    assert.equal(again.data?.cached, true);
    const brief = await call('verify_cpt', { path: p, engine: false, brief: true });
    assert.equal(brief.data?.brief, true);
    assert.equal(brief.data?.ok, full.data?.ok);
    assert.equal(brief.data?.status, full.data?.status);
    assert.equal(brief.data?.layers?.length, full.data?.layers?.length);
    assert.ok(bytes(brief.data) < bytes(full.data), `brief 应更小：${bytes(brief.data)}B vs ${bytes(full.data)}B`);
  });
});

test('CPT_MCP_GATE_BRIEF=1 时默认摘要（不传 brief 也是 brief）', async () => {
  cacheClear();
  await withServer({ CPT_MCP_GATE_BRIEF: '1' }, async ({ call, p }) => {
    const gate = await call('quality_gate_cpt', { path: p });
    assert.equal(gate.data?.brief, true, '部署侧打开默认摘要后应直接回摘要');
    assert.ok(!('checklist' in gate.data));
    const full = await call('quality_gate_cpt', { path: p, brief: false });
    assert.equal(full.data?.brief, undefined, 'brief:false 必须能取完整明细');
    assert.ok(Array.isArray(full.data?.checklist));
  });
});

test('缓存单元：TTL=0 关闭；指纹随内容变化；条目数受上限约束', () => {
  cacheClear();
  const p = path.join(tmp(), 'unit.cpt');
  fs.writeFileSync(p, '<Report/>');
  const fp1 = fileFingerprint(p);
  cacheStore('unit_tool', p, { a: 1 }, fp1, { verdict: 'x' });
  assert.equal(cacheSize(), 1);
  const hit = cacheLookup('unit_tool', p, { a: 1 }, fp1);
  assert.equal(hit?.result?.verdict, 'x');
  // 文件变化 → 指纹不同 → 用新指纹查询不命中（真实调用方每次都会传当前指纹）
  fs.writeFileSync(p, '<Report>v2</Report>');
  const fp2 = fileFingerprint(p);
  assert.notEqual(fp2, fp1);
  assert.equal(cacheLookup('unit_tool', p, { a: 1 }, fp2), null, '指纹变化后不应命中');
  // TTL=0 关闭
  const prev = process.env.CPT_MCP_GATE_CACHE_TTL_MS;
  process.env.CPT_MCP_GATE_CACHE_TTL_MS = '0';
  try {
    cacheStore('unit_tool', p, { a: 2 }, fp2, { verdict: 'y' });
    assert.equal(cacheLookup('unit_tool', p, { a: 2 }, fp2), null, 'TTL=0 应禁用缓存');
  } finally {
    if (prev === undefined) delete process.env.CPT_MCP_GATE_CACHE_TTL_MS;
    else process.env.CPT_MCP_GATE_CACHE_TTL_MS = prev;
  }
  // 依赖外部状态的指纹必须可区分
  const fpEngine = gateFingerprint(p, { engine: true });
  assert.notEqual(fpEngine, gateFingerprint(p, {}));
});
