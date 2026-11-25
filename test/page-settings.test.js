import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCpt, setReportSettings } from '../lib/generate.js';
import { pageSettings } from '../lib/cpt.js';
import '../scripts/isolate-store.mjs'; // M123：JS 基线 store 隔离，直跑也不污染真实 store

test('set_report_settings：A4 横/边距/居中/缩放 + 页眉页脚 全部生效', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-pageset-'));
  const p = path.join(dir, 'x.cpt');
  createCpt(p, { rows: 3, columns: 3 });
  setReportSettings(p, {
    paper: 'A4', orientation: 1,
    marginTopMm: 10, marginBottomMm: 15, marginLeftMm: 20, marginRightMm: 20,
    isHorizontalCenterOnPage: true, isVerticalCenterOnPage: true,
    shrinkToFitMode: 1, headerHeightMm: 8, footerHeightMm: 10,
  });
  const ps = pageSettings(p);
  assert.equal(ps.orientation, 1, '横向');
  assert.equal(ps.paperSizeUnit.width, 210 * 144000, 'A4 宽 210mm');
  assert.equal(ps.paperSizeUnit.height, 297 * 144000, 'A4 高 297mm');
  assert.equal(ps.marginUnit.top, 10 * 144000);
  assert.equal(ps.marginUnit.bottom, 15 * 144000);
  assert.equal(ps.marginUnit.left, 20 * 144000);
  assert.equal(ps.marginUnit.right, 20 * 144000);
  assert.equal(ps.isHorizontalCenterOnPage, true);
  assert.equal(ps.isVerticalCenterOnPage, true);
  assert.equal(ps.shrinkToFitMode, 1);
  assert.equal(ps.headerHeight, 8 * 144000);
  assert.equal(ps.footerHeight, 10 * 144000);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('set_report_settings：自定义纸张（300mm×200mm）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-pageset2-'));
  const p = path.join(dir, 'x.cpt');
  createCpt(p, { rows: 2, columns: 2 });
  setReportSettings(p, { paperWidthMm: 300, paperHeightMm: 200, orientation: 0, marginTopMm: 0, marginLeftMm: 0 });
  const ps = pageSettings(p);
  assert.equal(ps.paperSizeUnit.width, 300 * 144000);
  assert.equal(ps.paperSizeUnit.height, 200 * 144000);
  assert.equal(ps.orientation, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});
