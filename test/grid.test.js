import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCpt, setGrid } from '../lib/generate.js';
import { gridSizes } from '../lib/cpt.js';
import '../scripts/isolate-store.mjs'; // M123：JS 基线 store 隔离，直跑也不污染真实 store

test('get_grid：读取 defaultValue + CDATA 明细 + mm（多口径）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-grid-'));
  const p = path.join(dir, 'x.cpt');
  createCpt(p, { rows: 3, columns: 4 });
  setGrid(p, { rowHeights: [1296000, 1008000, 723900] });
  const gs = gridSizes(p);
  assert.equal(gs.length, 1);
  const rh = gs[0].rowHeights;
  assert.deepEqual(rh.values, [1296000, 1008000, 723900], 'CDATA=实际行高');
  assert.equal(rh.default, 723900, 'defaultValue 保留模板原值');
  assert.equal(rh.defaultMm, 5.027);
  assert.equal(rh.mm[0], 9, '1296000 → 9mm');
  assert.equal(rh.mm[1], 7, '1008000 → 7mm');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('set_grid updateDefault：默认保留 defaultValue；true 时同步为数组首值', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-grid2-'));
  const p = path.join(dir, 'x.cpt');
  createCpt(p, { rows: 3, columns: 4 });

  // 默认 updateDefault=false：defaultValue 不变
  setGrid(p, { rowHeights: [1008000, 1008000] });
  let rh = gridSizes(p)[0].rowHeights;
  assert.equal(rh.default, 723900, '默认不应改动 defaultValue');
  assert.deepEqual(rh.values, [1008000, 1008000]);

  // updateDefault=true：defaultValue 更新为数组首值
  setGrid(p, { rowHeights: [1296000, 1296000, 1008000], updateDefault: true });
  rh = gridSizes(p)[0].rowHeights;
  assert.equal(rh.default, 1296000, 'updateDefault=true 时 defaultValue=首值');
  assert.deepEqual(rh.values, [1296000, 1296000, 1008000]);
  fs.rmSync(dir, { recursive: true, force: true });
});
