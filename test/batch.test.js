import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createCpt, addDataset, addStyle, addCell, addFillSubmit, setParameterPanel } from '../lib/generate.js';
import { setCellListener } from '../lib/edits.js';
import { datasets, parameters, styles, cells, parameterPanel, fillConfig, overview } from '../lib/cpt.js';
import {
  addDatasetBatch, deleteDatasetBatch, updateDatasetBatch, getDatasetBatch,
  addParameterBatch, deleteParameterBatch, updateParameterBatch, getParameterBatch,
  addParameterWidgetBatch, deleteParameterWidgetBatch, updateParameterWidgetBatch, getParameterWidgetBatch,
  addStyleBatch, deleteStyleBatch, updateStyleBatch, getStyleBatch,
  getCellBatch,
  addFillBindingBatch, deleteFillBindingBatch, updateFillBindingBatch, getFillBindingBatch,
  addFillSubmitBatch, deleteFillSubmitBatch, updateFillSubmitBatch, getFillSubmitBatch,
  addChartBatch, deleteChartBatch, updateChartBatch, getChartBatch,
  addFloatElementBatch, deleteFloatElementBatch, updateFloatElementBatch, getFloatElementBatch,
  addCellHyperlinkBatch, deleteCellHyperlinkBatch, updateCellHyperlinkBatch, getCellHyperlinkBatch,
  addCellHighlightBatch, deleteCellHighlightBatch, updateCellHighlightBatch, getCellHighlightBatch,
  deleteCellListenerBatch, updateCellListenerBatch, getCellListenerBatch,
  addReportListenerBatch, deleteReportListenerBatch, updateReportListenerBatch, getReportListenerBatch,
  addToolbarButtonBatch, deleteToolbarButtonBatch, updateToolbarButtonBatch, getToolbarButtonBatch,
  addCellSortBatch, deleteCellSortBatch, updateCellSortBatch, getCellSortBatch,
  addScheduleBatch, deleteScheduleBatch, updateScheduleBatch, getScheduleBatch,
  addSheetBatch, deleteSheetBatch, updateSheetBatch, getSheetBatch,
  addPageHeaderFooterBatch, deletePageHeaderFooterBatch, updatePageHeaderFooterBatch, getPageHeaderFooterBatch,
} from '../lib/batch.js';
import '../scripts/isolate-store.mjs'; // M123：JS 基线 store 隔离，直跑也不污染真实 store

function fixture(opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-batch-'));
  const cpt = path.join(dir, 'batch.cpt');
  createCpt(cpt, { rows: 20, columns: 12, webWrite: true, ...opts });
  return { dir, cpt };
}

test('通用批量调度器：单项失败不整体崩溃，汇总逐项结果', async () => {
  const { dir, cpt } = fixture();
  try {
    const r = await addDatasetBatch(cpt, [
      { name: 'ds1', connection: 'Doris', sql: 'select 1' },
      { name: 'ds1', connection: 'Doris', sql: 'select 2' }, // 重名 → failed
      { name: 'ds2', connection: 'Doris', sql: 'select 3' },
    ]);
    assert.equal(r.summary.total, 3);
    assert.equal(r.summary.inserted, 2);
    assert.equal(r.summary.failed, 1);
    assert.equal(r.results.length, 3);
    assert.deepEqual(datasets(cpt).map((d) => d.name).sort(), ['ds1', 'ds2']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('1. 数据集批增/查/改/删', async () => {
  const { dir, cpt } = fixture();
  try {
    assert.equal((await addDatasetBatch(cpt, [
      { name: 'ds1', connection: 'Doris', sql: 'select 1' },
      { name: 'ds2', connection: 'Doris', sql: 'select 2' },
    ])).summary.inserted, 2);
    const got = await getDatasetBatch(cpt, [{ name: 'ds1' }, { name: 'nope' }]);
    assert.equal(got.results[0].found, true);
    assert.equal(got.results[1].status, 'skipped');
    assert.equal((await updateDatasetBatch(cpt, [{ target: { datasetName: 'ds1' }, patch: { sql: 'select 9' } }])).summary.updated, 1);
    assert.equal(datasets(cpt).find((d) => d.name === 'ds1').sql, 'select 9');
    assert.equal((await deleteDatasetBatch(cpt, [{ name: 'ds1' }, { name: 'ds2' }])).summary.deleted, 2);
    assert.equal(datasets(cpt).length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('2. 数据集参数批增/查/改/删', async () => {
  const { dir, cpt } = fixture();
  try {
    addDataset(cpt, { name: 'ds1', connection: 'Doris', sql: 'select ${a}, ${b}' });
    assert.equal((await addParameterBatch(cpt, [{ name: 'a', defaultValue: '1' }, { name: 'b', defaultValue: '2' }])).summary.inserted, 2);
    assert.equal((await getParameterBatch(cpt, [{ name: 'a' }, { name: 'b' }])).results.filter((r) => r.found).length, 2);
    assert.equal((await updateParameterBatch(cpt, [{ target: { name: 'a' }, patch: { defaultValue: '9' } }])).summary.updated, 1);
    assert.equal(parameters(cpt).find((p) => p.name === 'a').defaultValue, '9');
    assert.equal((await deleteParameterBatch(cpt, [{ name: 'a' }, { name: 'b' }])).summary.deleted, 2);
    assert.equal(parameters(cpt).length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('3. 参数面板控件批增/查/改/删', async () => {
  const { dir, cpt } = fixture();
  try {
    addDataset(cpt, { name: 'ds1', connection: 'Doris', sql: 'select 1' });
    setParameterPanel(cpt, { title: '参数' });
    assert.equal((await addParameterWidgetBatch(cpt, [
      { name: 'w1', type: 'text' }, { name: 'w2', type: 'text' },
    ])).summary.inserted, 2);
    assert.equal((await getParameterWidgetBatch(cpt, [{ name: 'w1' }])).results[0].found, true);
    assert.equal((await updateParameterWidgetBatch(cpt, [{ target: { name: 'w1' }, patch: { defaultValue: 'x' } }])).summary.updated, 1);
    assert.equal(parameterPanel(cpt).widgets.find((w) => w.name === 'w1').defaultValue, 'x');
    assert.equal((await deleteParameterWidgetBatch(cpt, [{ name: 'w1' }, { name: 'w2' }])).summary.deleted, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('4. 样式批增/查/改/删', async () => {
  const { dir, cpt } = fixture();
  try {
    const added = await addStyleBatch(cpt, [{ fontSizePt: 12 }, { fontSizePt: 14, bold: true }]);
    assert.equal(added.summary.inserted, 2);
    assert.deepEqual(added.results.map((r) => r.styleIndex).sort(), [1, 2]);
    assert.equal((await getStyleBatch(cpt, [{ index: 1 }, { index: 2 }])).results.filter((r) => r.found).length, 2);
    assert.equal((await updateStyleBatch(cpt, [{ target: { index: 1 }, patch: { fontSizePt: 18, bold: true, horizontalAlignment: 2 } }])).summary.updated, 1);
    const s1 = styles(cpt)[1];
    assert.equal(s1.fontSizePt, 18);
    assert.equal(s1.bold, true);
    assert.equal(s1.horizontalAlignment, 2);
    assert.equal((await deleteStyleBatch(cpt, [{ index: 2 }, { index: 1 }])).summary.deleted, 2);
    assert.equal(styles(cpt).length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('5. 单元格批查（get_cell_batch）', async () => {
  const { dir, cpt } = fixture();
  try {
    addCell(cpt, { column: 0, row: 0, content: 'A' });
    addCell(cpt, { column: 1, row: 1, content: 'B' });
    const r = await getCellBatch(cpt, [{ column: 0, row: 0 }, { column: 9, row: 9 }]);
    assert.equal(r.results[0].found, true);
    assert.equal(r.results[1].status, 'skipped');
    assert.equal(cells(cpt).length, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('6. 填报绑定批增/查/改/删', async () => {
  const { dir, cpt } = fixture();
  try {
    addCell(cpt, { column: 0, row: 0, content: 'v' });
    addCell(cpt, { column: 1, row: 0, content: 'v' });
    addFillSubmit(cpt, { dsName: 'Doris', table: 't', name: '提交1' });
    assert.equal((await addFillBindingBatch(cpt, [
      { submitIndex: 0, field: 'f1', column: 0, row: 0 },
      { submitIndex: 0, field: 'f2', column: 1, row: 0 },
    ])).summary.inserted, 2);
    assert.equal((await getFillBindingBatch(cpt, [{ submitIndex: 0, field: 'f1' }])).results[0].found, true);
    assert.equal((await updateFillBindingBatch(cpt, [{ target: { submitIndex: 0, field: 'f1' }, patch: { column: 1 } }])).summary.updated, 1);
    assert.equal((await deleteFillBindingBatch(cpt, [{ submitIndex: 0, field: 'f1' }, { submitIndex: 0, field: 'f2' }])).summary.deleted, 2);
    assert.equal(fillConfig(cpt).submits[0].columns.length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('7. 填报提交批增/查/改/删', async () => {
  const { dir, cpt } = fixture();
  try {
    assert.equal((await addFillSubmitBatch(cpt, [
      { dsName: 'Doris', table: 't1', name: '提交1' },
      { dsName: 'Doris', table: 't2', name: '提交2' },
    ])).summary.inserted, 2);
    assert.equal(fillConfig(cpt).submits.length, 2);
    assert.equal((await getFillSubmitBatch(cpt, [{ submitIndex: 0 }, { submitIndex: 1 }])).results.filter((r) => r.found).length, 2);
    assert.equal((await updateFillSubmitBatch(cpt, [{ target: { submitIndex: 0 }, patch: { name: '改名' } }])).summary.updated, 1);
    assert.equal(fillConfig(cpt).submits[0].name, '改名');
    assert.equal((await deleteFillSubmitBatch(cpt, [{ submitIndex: 1 }, { submitIndex: 0 }])).summary.deleted, 2);
    assert.equal(fillConfig(cpt).submits.length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('8. 图表批增/查/改/删', async () => {
  const { dir, cpt } = fixture();
  try {
    addDataset(cpt, { name: 'ds1', connection: 'Doris', sql: 'select region, amount' });
    assert.equal((await addChartBatch(cpt, [
      { column: 0, row: 0, dsName: 'ds1', category: 'region', values: ['amount'], colspan: 4, rowspan: 10 },
      { column: 5, row: 0, dsName: 'ds1', category: 'region', values: ['amount'], colspan: 4, rowspan: 10 },
    ])).summary.inserted, 2);
    assert.equal((await getChartBatch(cpt, [{ column: 0, row: 0 }])).results[0].found, true);
    assert.equal((await updateChartBatch(cpt, [{ target: { column: 0, row: 0 }, patch: { title: '新标题' } }])).summary.updated, 1);
    assert.equal((await deleteChartBatch(cpt, [{ column: 0, row: 0 }, { column: 5, row: 0 }])).summary.deleted, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('9. 浮动元素批增/查/改/删', async () => {
  const { dir, cpt } = fixture();
  try {
    assert.equal((await addFloatElementBatch(cpt, [
      { content: 'A', name: 'f1' }, { content: 'B', name: 'f2' },
    ])).summary.inserted, 2);
    assert.equal((await getFloatElementBatch(cpt, [{ name: 'f1' }])).results[0].found, true);
    assert.equal((await updateFloatElementBatch(cpt, [{ target: { name: 'f1' }, patch: { content: '改' } }])).summary.updated, 1);
    assert.equal((await deleteFloatElementBatch(cpt, [{ name: 'f1' }, { name: 'f2' }])).summary.deleted, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('10. 单元格超链接批增/查/改/删', async () => {
  const { dir, cpt } = fixture();
  try {
    addCell(cpt, { column: 0, row: 0, content: 'v' });
    addCell(cpt, { column: 1, row: 0, content: 'v' });
    assert.equal((await addCellHyperlinkBatch(cpt, [
      { column: 0, row: 0, type: 'url', url: 'https://example.com', name: 'h1' },
      { column: 1, row: 0, type: 'url', url: 'https://example.com', name: 'h1' },
    ])).summary.inserted, 2);
    assert.equal((await getCellHyperlinkBatch(cpt, [{ column: 0, row: 0 }])).results[0].found, true);
    assert.equal((await updateCellHyperlinkBatch(cpt, [{ target: { column: 0, row: 0, name: 'h1' }, patch: { url: 'https://example.org' } }])).summary.updated, 1);
    assert.equal((await deleteCellHyperlinkBatch(cpt, [{ column: 0, row: 0 }, { column: 1, row: 0 }])).summary.deleted, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('11. 条件高亮批增/查/改/删', async () => {
  const { dir, cpt } = fixture();
  try {
    addCell(cpt, { column: 0, row: 0, content: 'v' });
    addCell(cpt, { column: 1, row: 0, content: 'v' });
    assert.equal((await addCellHighlightBatch(cpt, [
      { column: 0, row: 0, formula: '$$$ < 0', fontColor: '#FF0000' },
      { column: 1, row: 0, formula: '$$$ < 0', fontColor: '#FF0000' },
    ])).summary.inserted, 2);
    assert.equal((await getCellHighlightBatch(cpt, [{ column: 0, row: 0 }])).results[0].found, true);
    assert.equal((await updateCellHighlightBatch(cpt, [{ target: { column: 0, row: 0, formula: '$$$ < 0' }, patch: { fontColor: '#00FF00' } }])).summary.updated, 1);
    assert.equal((await deleteCellHighlightBatch(cpt, [{ column: 0, row: 0 }, { column: 1, row: 0 }])).summary.deleted, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('12. 单元格监听批查/改/删（批增已有 add_cell_listener_batch）', async () => {
  const { dir, cpt } = fixture();
  try {
    addCell(cpt, { column: 0, row: 0, content: 'v' });
    addCell(cpt, { column: 1, row: 0, content: 'v' });
    setCellListener(cpt, 0, 0, { event: 'click', js: 'old()' });
    setCellListener(cpt, 1, 0, { event: 'click', js: 'old()' });
    assert.equal((await getCellListenerBatch(cpt, [{ column: 0, row: 0, event: 'click' }])).results[0].found, true);
    assert.equal((await updateCellListenerBatch(cpt, [{ target: { column: 0, row: 0, event: 'click' }, patch: { js: 'new()' } }])).summary.updated, 1);
    assert.equal((await deleteCellListenerBatch(cpt, [{ column: 0, row: 0, event: 'click' }, { column: 1, row: 0, event: 'click' }])).summary.deleted, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('13. 报表事件 Listener 批增/查/改/删', async () => {
  const { dir, cpt } = fixture();
  try {
    assert.equal((await addReportListenerBatch(cpt, [
      { event: 'onload', js: 'a()' }, { event: 'afterload', js: 'b()' },
    ])).summary.inserted, 2);
    assert.equal((await getReportListenerBatch(cpt, [{ event: 'onload' }])).results[0].found, true);
    assert.equal((await updateReportListenerBatch(cpt, [{ target: { event: 'onload' }, patch: { js: 'a2()' } }])).summary.updated, 1);
    assert.equal((await deleteReportListenerBatch(cpt, [{ event: 'onload' }, { event: 'afterload' }])).summary.deleted, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('14. 工具栏按钮批增/查/改/删', async () => {
  const { dir, cpt } = fixture();
  try {
    assert.equal((await addToolbarButtonBatch(cpt, [
      { buttonText: '按钮A' }, { buttonText: '按钮B' },
    ])).summary.inserted, 2);
    assert.equal((await getToolbarButtonBatch(cpt, [{ buttonText: '按钮A' }])).results[0].found, true);
    assert.equal((await updateToolbarButtonBatch(cpt, [{ target: { buttonText: '按钮A' }, patch: { iconName: 'print' } }])).summary.updated, 1);
    assert.equal((await deleteToolbarButtonBatch(cpt, [{ buttonText: '按钮A' }, { buttonText: '按钮B' }])).summary.deleted, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('14b. 工具栏按钮批改：空 patch 报错不静默记 updated', async () => {
  const { dir, cpt } = fixture();
  try {
    await addToolbarButtonBatch(cpt, [{ buttonText: '按钮A' }]);
    const r = await updateToolbarButtonBatch(cpt, [{ target: { buttonText: '按钮A' }, patch: {} }]);
    assert.equal(r.summary.failed, 1);
    assert.equal(r.summary.updated, 0);
    assert.match(r.results[0].error, /js 或 iconName/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('15. 单元格扩展后排序批增/查/改/删', async () => {
  const { dir, cpt } = fixture();
  try {
    addDataset(cpt, { name: 'ds1', connection: 'Doris', sql: 'select region, amount' });
    addCell(cpt, { column: 0, row: 0, contentType: 'dsColumn', dsName: 'ds1', columnName: 'region' });
    addCell(cpt, { column: 1, row: 0, contentType: 'dsColumn', dsName: 'ds1', columnName: 'amount' });
    assert.equal((await addCellSortBatch(cpt, [
      { column: 0, row: 0, sort: [{ area: 'amount', direction: 'desc' }] },
      { column: 1, row: 0, sort: [{ area: 'region', direction: 'asc' }] },
    ])).summary.inserted, 2);
    assert.equal((await getCellSortBatch(cpt, [{ column: 0, row: 0 }])).results[0].found, true);
    assert.equal((await updateCellSortBatch(cpt, [{ target: { column: 0, row: 0 }, patch: { sort: [{ area: 'region', direction: 'asc' }] } }])).summary.updated, 1);
    assert.equal((await deleteCellSortBatch(cpt, [{ column: 0, row: 0 }, { column: 1, row: 0 }])).summary.deleted, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('16. 定时任务批增/查/改(启停)/删', async () => {
  const { dir, cpt } = fixture();
  try {
    const added = await addScheduleBatch(cpt, [
      { cron: '0 3 * * *', action: 'validate', note: 't1' },
      { cron: '0 4 * * *', action: 'validate', note: 't2' },
    ]);
    assert.equal(added.summary.inserted, 2);
    const ids = added.results.map((r) => r.id);
    assert.equal((await getScheduleBatch(cpt, [{ taskId: ids[0] }])).results[0].found, true);
    assert.equal((await updateScheduleBatch(cpt, [{ target: { taskId: ids[0] }, patch: { enabled: false } }])).summary.updated, 1);
    assert.equal((await deleteScheduleBatch(cpt, [{ taskId: ids[0] }, { taskId: ids[1] }])).summary.deleted, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('16b. 定时任务批查：缺 taskId / 未找到记 skipped 不记 failed', async () => {
  const { dir, cpt } = fixture();
  try {
    const r = await getScheduleBatch(cpt, [{ taskId: undefined }, { taskId: 'no-such-id' }]);
    assert.equal(r.summary.failed, 0);
    assert.equal(r.summary.skipped, 2);
    assert.ok(r.results.every((x) => x.status === 'skipped' && x.found === false));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('17. 工作表批增/查/改/删', async () => {
  const { dir, cpt } = fixture();
  try {
    assert.equal((await addSheetBatch(cpt, [{ sheetName: '华东' }, { sheetName: '华北' }])).summary.inserted, 2);
    assert.deepEqual(overview(cpt).sheets, ['sheet1', '华东', '华北']);
    assert.equal((await getSheetBatch(cpt, [{ sheet: '华东' }, { sheet: '华北' }])).results.filter((r) => r.found).length, 2);
    assert.equal((await updateSheetBatch(cpt, [{ target: { sheet: '华东' }, patch: { newName: '华东区' } }])).summary.updated, 1);
    assert.ok(overview(cpt).sheets.includes('华东区'));
    assert.equal((await deleteSheetBatch(cpt, [{ sheet: '华北' }, { sheet: '华东区' }])).summary.deleted, 2);
    assert.deepEqual(overview(cpt).sheets, ['sheet1']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('18. 页眉页脚批增/查/改/删', async () => {
  const { dir, cpt } = fixture();
  try {
    assert.equal((await addPageHeaderFooterBatch(cpt, [
      { header: { left: '机密' }, footer: { center: { preset: 'pageNumber' } }, sheet: 0 },
    ])).summary.inserted, 1);
    assert.equal((await getPageHeaderFooterBatch(cpt, [{ sheet: 0 }])).results[0].found, true);
    assert.equal((await updatePageHeaderFooterBatch(cpt, [{ target: { sheet: 0 }, patch: { header: { left: '新' } } }])).summary.updated, 1);
    assert.equal((await deletePageHeaderFooterBatch(cpt, [{ which: 'header', sheet: 0 }])).summary.deleted, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
