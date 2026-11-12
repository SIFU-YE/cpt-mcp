// test/density.test.js —— P1-1 版式密度 / P1-2 列宽自适应
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { generateReport } from '../lib/engine/index.js';
import { gridSizes } from '../lib/cpt.js';
import { unitToMm } from '../lib/engine/rules.js';
import '../scripts/isolate-store.mjs'; // M123：JS 基线 store 隔离，直跑也不污染真实 store

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-density-'));

// 覆盖语义 2026-11-06：generateReport 默认拒绝覆盖，每次构建用独立文件名（测试不依赖覆盖行为）
let seq = 0;
const build = (density) => {
  const p = path.join(TMP, `d-${density}-${seq++}.cpt`);
  generateReport({
    path: p,
    title: '销售明细',
    source: { connection: 'Doris', table: 'sales' },
    fields: [
      { name: 'region', label: '地区' },
      { name: 'amount', label: '金额', type: 'money' },
    ],
    options: { density },
  });
  return p;
};

test('P1-1：density 三档行高单调（compact < standard < roomy）', () => {
  const heights = ['compact', 'standard', 'roomy'].map((d) => {
    const g = gridSizes(build(d))[0];
    return unitToMm(g.rowHeights.values[1]); // 表头行
  });
  assert.ok(heights[0] < heights[1] && heights[1] < heights[2], `应单调递增：${heights}`);
});

test('P1-1：density 三档字号联动（标题样式 FRFont size = pt×4）', () => {
  const sizes = ['compact', 'standard', 'roomy'].map((d) => {
    const p = build(d);
    const m = fs.readFileSync(p, 'utf8').match(/<FRFont name="微软雅黑" style="1" size="(\d+)"\/>/);
    return Number(m[1]); // 标题样式加粗，取第一个加粗 FRFont
  });
  assert.ok(sizes[0] < sizes[1] && sizes[1] < sizes[2], `标题字号应单调递增：${sizes}`);
});

test('P1-1：非法 density 被拒', () => {
  assert.throws(() => build('ultra'), /density="ultra" 非法/);
});

test('P1-2：长中文表头列宽自动加宽（超过类型默认宽）', () => {
  const p = path.join(TMP, 'wide.cpt');
  generateReport({
    path: p,
    source: { connection: 'Doris', table: 't' },
    fields: [
      { name: 'metric', label: '年度销售额完成情况对比分析' }, // 13 全角 → 估算 ≈ 13×5.19+6 ≈ 73mm
      { name: 'amount', label: '金额', type: 'money' },
    ],
  });
  const g = gridSizes(p)[0];
  const widthsMm = g.columnWidths.values.map(unitToMm);
  assert.ok(widthsMm[0] > 60, `长表头列应加宽到 >60mm，实际 ${widthsMm[0]}mm`);
  assert.ok(widthsMm[1] <= 24 + 0.1, `短表头金额列保持默认 24mm，实际 ${widthsMm[1]}mm`);
});
