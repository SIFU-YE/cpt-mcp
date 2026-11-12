import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCpt, addStyle, addCell } from '../lib/generate.js';
import { styles } from '../lib/cpt.js';
import { getCellStyle, updateCellStyle } from '../lib/edits.js';
import '../scripts/isolate-store.mjs'; // M123：JS 基线 store 隔离，直跑也不污染真实 store

test('样式补漏：下划线/删除线/垂直对齐/边框/文本控制 生成+读取闭环', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-stylex-'));
  const p = path.join(dir, 'x.cpt');
  createCpt(p, { rows: 2, columns: 2 });

  const r = addStyle(p, {
    fontSizePt: 14, bold: true, underline: true, strikethrough: true,
    verticalAlignment: 3, textStyle: 1, paddingLeft: 5, lineSpacing: 4, rotation: -90,
    border: {
      top: { style: 2, color: '#FF0000' }, bottom: { style: 1 },
      left: { style: 1 }, right: { style: 1 }, outerTop: { style: 0 },
    },
  });
  assert.equal(r.styleIndex, 1);
  addCell(p, { column: 0, row: 0, content: 'x', styleIndex: 1 });

  const st = styles(p).find((s) => s.styleIndex === 1);
  assert.equal(st.underline, true, '下划线应读出');
  assert.equal(st.strikethrough, true, '删除线应读出');
  assert.equal(st.verticalAlignment, 3);
  assert.equal(st.textStyle, 1);
  assert.equal(st.paddingLeft, 5);
  assert.equal(st.lineSpacing, 4);
  assert.equal(st.rotation, -90);
  assert.equal(st.border.top.style, 2);
  assert.equal(st.border.top.color, '#FF0000');
  assert.equal(st.border.bottom.style, 1);
  assert.equal(st.border.outerTop.style, 0);

  const gs = getCellStyle(p, 0, 0);
  assert.equal(gs.underline, true);
  assert.equal(gs.strikethrough, true);
  assert.equal(gs.verticalAlignment, 3);
  assert.equal(gs.border.top.style, 2);
  assert.equal(gs.border.top.color, '#FF0000');

  // 修改：取消下划线/删除线、改垂直对齐与边框
  updateCellStyle(p, 0, 0, {
    underline: false, strikethrough: false, verticalAlignment: 1,
    border: { top: { style: 1 }, bottom: { style: 1 }, left: { style: 1 }, right: { style: 1 } },
  });
  const gs2 = getCellStyle(p, 0, 0);
  assert.equal(gs2.underline, false, 'updateCellStyle 应能取消下划线');
  assert.equal(gs2.strikethrough, false);
  assert.equal(gs2.verticalAlignment, 1);
  assert.equal(gs2.border.top.style, 1);
  assert.equal(gs2.border.top.color, null);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('官方样本交叉：能解析官方模板样式（含新字段，不抛错）', (t) => {
  const real = 'D:/FineReport_11.0/webapps/webroot/WEB-INF/reportlets/demo/analytics/Demo.cpt';
  if (!fs.existsSync(real)) { t.skip('官方样本不存在'); return; }
  const sts = styles(real);
  assert.ok(sts.length > 0, '官方样本应有样式');
  assert.ok(Array.isArray(sts), '官方样本样式应为数组');
});
