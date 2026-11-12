// test/meta-sidecar.test.js —— P2-1 生成参数留档（.cpt.meta.json）
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { generateReport } from '../lib/engine/index.js';
import { buildReport } from '../lib/engine/builder.js';
import { regenerateFromMeta } from '../lib/regenerate.js';
import '../scripts/isolate-store.mjs'; // M123：JS 基线 store 隔离，直跑也不污染真实 store

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-meta-'));

test('P2-1：build_report meta=true 落盘 .cpt.meta.json（含 generatedAt 与 spec 回显）', () => {
  const p = path.join(TMP, 'with-meta.cpt');
  const spec = { title: '留档测试', rows: 2, columns: 2, datasets: [{ name: 'ds1', connection: 'Doris', sql: 'SELECT 1' }] };
  const r = buildReport({ path: p, ...spec, check: false, meta: { tool: 'build_report', spec } });
  assert.ok(r.metaPath, '应返回 metaPath');
  const meta = JSON.parse(fs.readFileSync(r.metaPath, 'utf8'));
  assert.equal(meta.generator, 'cpt-mcp');
  assert.ok(meta.generatedAt, '应含 generatedAt');
  assert.equal(meta.spec.title, '留档测试');
  assert.equal(meta.tool, 'build_report');
});

test('P2-1：meta=false / 未传时不产生 sidecar', () => {
  const p1 = path.join(TMP, 'no-meta.cpt');
  buildReport({ path: p1, title: '无留档', rows: 2, columns: 2, check: false });
  assert.ok(!fs.existsSync(p1 + '.meta.json'));

  const p2 = path.join(TMP, 'gen-meta.cpt');
  generateReport({
    path: p2,
    title: '带留档',
    source: { connection: 'Doris', table: 't' },
    fields: [{ name: 'a', label: 'A' }],
    options: { meta: true },
  });
  const meta = JSON.parse(fs.readFileSync(p2 + '.meta.json', 'utf8'));
  assert.equal(meta.tool, 'generate_report');
  assert.equal(meta.density, 'standard');
  assert.deepEqual(meta.parameterFilters, []);
});

// 2026-11-07 P1：regenerate_from_meta 的语义就是「按留档回写同名模板」，目标必然已存在 ——
// 默认必须覆盖（否则该工具默认 100% 失败）；显式 noOverwrite:true 才拒绝。
test('regenerate_from_meta：默认覆盖已存在目标（按留档回写），显式 noOverwrite:true 才拒绝', () => {
  const p = path.join(TMP, 'regen-default.cpt');
  const spec = { title: '回写测试', rows: 2, columns: 2 };
  buildReport({ path: p, ...spec, check: false, meta: { tool: 'build_report', spec } });

  // 目标被外部改坏：留档仍在 → 默认调用应直接覆盖回去，不需要任何额外参数
  fs.writeFileSync(p, 'CORRUPTED-BY-EXTERNAL', 'utf8');
  const r = regenerateFromMeta(p);
  assert.equal(r.regeneratedFrom, p + '.meta.json');
  assert.match(fs.readFileSync(p, 'utf8'), /回写测试/, '默认应覆盖并回放留档 spec');
  assert.notEqual(fs.readFileSync(p, 'utf8'), 'CORRUPTED-BY-EXTERNAL');

  // 显式 noOverwrite:true：目标存在即拒绝，且不得改动目标
  fs.writeFileSync(p, 'PRESERVE-ME', 'utf8');
  assert.throws(() => regenerateFromMeta(p, { noOverwrite: true }), /noOverwrite=true.*拒绝覆盖/);
  assert.equal(fs.readFileSync(p, 'utf8'), 'PRESERVE-ME', '拒绝覆盖时目标文件不得被改动');

  // 覆盖会留 .bak-build-*（崩溃兜底），且 meta 留档不被删除
  const baks = fs.readdirSync(TMP).filter((f) => f.startsWith('regen-default.cpt.bak-build-'));
  assert.ok(baks.length >= 1, `覆盖应留 .bak-build-*，实际 ${baks.length}`);
  assert.ok(fs.existsSync(p + '.meta.json'), '回写不应删除 meta 留档');
});
