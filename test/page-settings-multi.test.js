import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCpt, setReportSettings } from '../lib/generate.js';
import { pageSettings } from '../lib/cpt.js';
import '../scripts/isolate-store.mjs'; // M123：JS 基线 store 隔离，直跑也不污染真实 store

test('page-settings：连续多次 setReportSettings 不漂移（关键回归）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-pageset-multi-'));
  const p = path.join(dir, 'x.cpt');
  createCpt(p, { rows: 2, columns: 2 });

  // 1) 第一次：纸 + 方向 + 水平居中 + 页眉
  setReportSettings(p, { paper: 'A4', orientation: 1, isHorizontalCenterOnPage: true, headerHeightMm: 8 });
  // 2) 第二次：边距 + 垂直居中 + 页脚
  setReportSettings(p, { marginTopMm: 10, isVerticalCenterOnPage: true, footerHeightMm: 10 });
  // 3) 第三次：缩放 + 左右下边距
  setReportSettings(p, { shrinkToFitMode: 2, marginLeftMm: 20, marginRightMm: 20, marginBottomMm: 15 });

  const ps = pageSettings(p);
  assert.equal(ps.orientation, 1, 'orientation 应保持 1');
  assert.equal(ps.isHorizontalCenterOnPage, true);
  assert.equal(ps.isVerticalCenterOnPage, true);
  assert.equal(ps.shrinkToFitMode, 2);
  assert.equal(ps.headerHeight, 8 * 144000);
  assert.equal(ps.footerHeight, 10 * 144000);
  assert.equal(ps.marginUnit.top, 10 * 144000);
  assert.equal(ps.marginUnit.left, 20 * 144000);
  assert.equal(ps.marginUnit.bottom, 15 * 144000);
  assert.equal(ps.marginUnit.right, 20 * 144000);
  assert.equal(ps.paperSizeUnit.width, 210 * 144000);
  assert.equal(ps.paperSizeUnit.height, 297 * 144000);

  // 4) 读 ReportSettings XML 全量属性（防止同名属性重复插入）
  const raw = fs.readFileSync(p, 'utf8');
  const rsStart = raw.indexOf('<ReportSettings');
  const rsOpenEnd = raw.indexOf('>', rsStart);
  const openTag = raw.slice(rsStart, rsOpenEnd + 1);
  // 每个属性应只出现一次
  for (const a of ['isHorizontalCenterOnPage', 'isVerticalCenterOnPage', 'shrinkToFitMode', 'headerHeight', 'footerHeight']) {
    const n = (openTag.match(new RegExp(a + '=', 'g')) || []).length;
    assert.equal(n, 1, `${a} 在 ReportSettings 应只 1 次（实际 ${n}）`);
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('page-settings：清零居中（第二次显式 false 不应被旧值覆盖）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-pageset-clear-'));
  const p = path.join(dir, 'x.cpt');
  createCpt(p, { rows: 2, columns: 2 });
  setReportSettings(p, { isHorizontalCenterOnPage: true, isVerticalCenterOnPage: true });
  // 显式清零
  setReportSettings(p, { isHorizontalCenterOnPage: false, isVerticalCenterOnPage: false });
  const ps = pageSettings(p);
  assert.equal(ps.isHorizontalCenterOnPage, false, '应可显式清零为 false');
  assert.equal(ps.isVerticalCenterOnPage, false);
  fs.rmSync(dir, { recursive: true, force: true });
});
