import '../scripts/isolate-store.mjs'; // 首行：JS 基线 store 隔离，直跑也不污染真实 store
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createCpt, addStyle, addCell } from '../lib/generate.js';
import { styles } from '../lib/cpt.js';
import { updateCellStyle } from '../lib/edits.js';
import { updateStyleBatch } from '../lib/batch.js';

// F6 回归：update_style(_batch) 的 patch.border 曾被静默丢弃却返回 updated（假成功）。
// 边框正形 = 官方 Style 子级 <Border> 整块（四边 Top/Bottom/Left/Right + OuterTop/InnerHorizontal，
// 每边 {style 线型, color?}，颜色走 <color><FineColor color="ARGB" hor="-1" ver="-1"/>），
// 与 lib/generate.js styleBorderXml、lib/edits.js borderBlockXml 同构，styles() 读回闭环。

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-style-border-'));
  const cpt = path.join(dir, 'border.cpt');
  createCpt(cpt, { rows: 4, columns: 4 });
  return { dir, cpt };
}

const BORDER_SAMPLE = {
  top: { style: 2, color: '#FF0000' },
  bottom: { style: 1 },
  left: { style: 1 },
  right: { style: 1 },
};

test('F6-1：边框样板 patch→读回一致（含默认样式 index=0 与新增样式）', async () => {
  const { dir, cpt } = fixture();
  try {
    const added = addStyle(cpt, { fontSizePt: 12 });
    const r = await updateStyleBatch(cpt, [
      { target: { index: 0 }, patch: { border: BORDER_SAMPLE } },
      { target: { index: added.styleIndex }, patch: { border: BORDER_SAMPLE } },
    ]);
    assert.equal(r.summary.updated, 2);
    for (const res of r.results) {
      assert.equal(res.status, 'updated');
      assert.ok(res.changed.includes('border'), 'border 落盘必须进 changed');
    }
    for (const idx of [0, added.styleIndex]) {
      const st = styles(cpt)[idx];
      assert.equal(st.border.top.style, 2);
      assert.equal(st.border.top.color, '#FF0000');
      assert.equal(st.border.bottom.style, 1);
      assert.equal(st.border.bottom.color, null);
      assert.equal(st.border.left.style, 1);
      assert.equal(st.border.right.style, 1);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('F6-2：border 与字体字段同传同时落盘', async () => {
  const { dir, cpt } = fixture();
  try {
    const added = addStyle(cpt, { fontSizePt: 12 });
    const idx = added.styleIndex;
    const r = await updateStyleBatch(cpt, [
      { target: { index: idx }, patch: { fontSizePt: 18, bold: true, border: { outerTop: { style: 1, color: '#00FF00' } } } },
    ]);
    assert.equal(r.summary.updated, 1);
    assert.deepEqual([...r.results[0].changed].sort(), ['bold', 'border', 'fontSizePt']);
    const st = styles(cpt)[idx];
    assert.equal(st.fontSizePt, 18);
    assert.equal(st.bold, true);
    assert.equal(st.border.outerTop.style, 1);
    assert.equal(st.border.outerTop.color, '#00FF00');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('F6-3：重复 patch 幂等（文件字节一致、读回一致）', async () => {
  const { dir, cpt } = fixture();
  try {
    const added = addStyle(cpt, { fontSizePt: 12 });
    const idx = added.styleIndex;
    const item = { target: { index: idx }, patch: { border: BORDER_SAMPLE } };
    await updateStyleBatch(cpt, [item]);
    const raw1 = fs.readFileSync(cpt, 'utf8');
    const read1 = styles(cpt)[idx].border;
    await updateStyleBatch(cpt, [item]);
    const raw2 = fs.readFileSync(cpt, 'utf8');
    const read2 = styles(cpt)[idx].border;
    assert.equal(raw2, raw1, '重复 patch 不应改动文件字节');
    assert.deepEqual(read2, read1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('F6-4（行为锁定）：未知键沿旧语义透传 changed；border:null 不落盘且不进 changed', async () => {
  const { dir, cpt } = fixture();
  try {
    const added = addStyle(cpt, { fontSizePt: 12 });
    const idx = added.styleIndex;
    const before = styles(cpt)[idx].border;
    const r1 = await updateStyleBatch(cpt, [{ target: { index: idx }, patch: { noSuchKey: 1 } }]);
    assert.equal(r1.results[0].status, 'updated');
    assert.deepEqual(r1.results[0].changed, ['noSuchKey']);
    const r2 = await updateStyleBatch(cpt, [{ target: { index: idx }, patch: { border: null, fontSizePt: 14 } }]);
    assert.equal(r2.results[0].status, 'updated');
    assert.deepEqual(r2.results[0].changed, ['fontSizePt'], 'border:null 未生效，不得进 changed');
    assert.deepEqual(styles(cpt)[idx].border, before, 'border:null 不得改动边框');
    assert.equal(styles(cpt)[idx].fontSizePt, 14);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('F6-5（行为锁定）：非对象 border 诚实失败，不假报 updated', async () => {
  const { dir, cpt } = fixture();
  try {
    const added = addStyle(cpt, { fontSizePt: 12 });
    const idx = added.styleIndex;
    const before = styles(cpt)[idx].border;
    const r = await updateStyleBatch(cpt, [{ target: { index: idx }, patch: { border: 'red' } }]);
    assert.equal(r.summary.failed, 1);
    assert.equal(r.results[0].status, 'failed');
    assert.match(r.results[0].error, /border/);
    assert.deepEqual(styles(cpt)[idx].border, before, '失败项不得改动边框');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function pairedBorderBlockOf(raw) {
  const m = raw.match(/<Border>[\s\S]*?<\/Border>/);
  assert.ok(m, '模板内应存在成对 <Border> 块（自闭合 <Border/> 不计数）');
  return m[0];
}

test('F6-6（形态锁定）：update_style_batch 与 update_cell_style 落盘的 <Border> 块逐字节一致', async () => {
  // 本地 styleBorderBlockXml 系正版 borderBlockXml 的同构复刻（避 edits.js 热改争用）；
  // 本用例把同一份 border 经两条写口落盘并逐字节对账，正版一变即转红，逼同步。
  const border = {
    top: { style: 2, color: '#FF0000' }, bottom: { style: 1 }, left: { style: 1 },
    right: { style: 1 }, outerTop: { style: 0 }, innerHorizontal: { style: 3, color: '#00FF00' },
  };
  const fa = fixture();
  const fb = fixture();
  try {
    const ia = addStyle(fa.cpt, { fontSizePt: 12 }).styleIndex;
    const r = await updateStyleBatch(fa.cpt, [{ target: { index: ia }, patch: { border } }]);
    assert.equal(r.summary.updated, 1);

    const ib = addStyle(fb.cpt, { fontSizePt: 12 }).styleIndex;
    addCell(fb.cpt, { column: 0, row: 0, content: 'x', styleIndex: ib });
    updateCellStyle(fb.cpt, 0, 0, { border });

    const blockA = pairedBorderBlockOf(fs.readFileSync(fa.cpt, 'utf8'));
    const blockB = pairedBorderBlockOf(fs.readFileSync(fb.cpt, 'utf8'));
    assert.equal(blockA, blockB, '两条写口的 <Border> 落盘块必须逐字节一致');
  } finally {
    fs.rmSync(fa.dir, { recursive: true, force: true });
    fs.rmSync(fb.dir, { recursive: true, force: true });
  }
});
