// test/multi-sheet-content.test.js —— 2026-11-23：build_report 多 sheet 一次成型
//
// 背景（会话实测）：build_report 的 sheets[] 原先只接受 {name,rows,columns}，
// 传 {grid,cells} 会报 `spec.sheets.0: Unrecognized keys: "grid", "cells"`；
// 想建「一本两表带数据」只能建完再逐格写。本测试锁定：每 sheet 自带 cells/styles/grid/charts
// 一次成型，且与顶层 cells 共用同一套样式登记/展开父格/条件属性逻辑。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildReport } from '../lib/engine/builder.js';
import { generateReport } from '../lib/engine/index.js';
import { cells, styles, gridSizes, datasets } from '../lib/cpt.js';
import '../scripts/isolate-store.mjs';

// sqlFile 受 allowedRoots 约束；测试固定到临时目录，避免依赖开发机环境
process.env.CPT_MCP_ALLOWED_ROOTS = os.tmpdir();

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-multisheet-'));
}

const textsOfSheet = (cpt, sheetIndex) => cells(cpt)
  .filter((c) => c.sheetIndex === sheetIndex && c.contentKind !== 'dsColumn')
  .map((c) => c.contentText ?? c.formula)
  .filter((v) => v != null && String(v).trim() !== '');

test('sheets[].cells/grid：两张表一次建完（带数据与各自行高）', () => {
  const dir = tmp();
  const cpt = path.join(dir, 'two.cpt');
  try {
    const r = buildReport({
      path: cpt, check: true, noOverwrite: true,
      sheets: [
        {
          name: '示例汇总', rows: 6, columns: 4,
          cells: [
            { column: 0, row: 0, content: '示例汇总' },
            { column: 0, row: 1, content: '部门' },
            { column: 1, row: 1, content: '数量' },
            { column: 0, row: 2, contentType: 'dsColumn', dsName: 'ds1', columnName: 'dept' },
          ],
          grid: { rowHeightMm: [12, 9, 7], columnWidthMm: [40, 20] },
        },
        {
          name: '示例监控', rows: 4, columns: 3,
          cells: [
            { column: 0, row: 0, content: '示例监控' },
            { column: 0, row: 1, content: '地区' },
          ],
          grid: { rowHeightMm: [10, 8] },
        },
      ],
      datasets: [{ name: 'ds1', connection: 'Doris', sql: 'select dept, cnt from t' }],
    });
    assert.equal(r.checkResult.hasError, false, JSON.stringify(r.checkResult.errors ?? []));

    assert.deepEqual(textsOfSheet(cpt, 0), ['示例汇总', '部门', '数量']);
    assert.deepEqual(textsOfSheet(cpt, 1), ['示例监控', '地区']);

    const g = gridSizes(cpt);
    assert.equal(g.length, 2, '应有 2 个工作表');
    assert.equal(g[0].rowHeights.values[0], 12 * 144000, 'sheet0 行高 12mm');
    assert.equal(g[1].rowHeights.values[0], 10 * 144000, 'sheet1 行高 10mm');
    assert.equal(g[0].columnWidths.values[0], 40 * 144000, 'sheet0 首列 40mm');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('sheets[].styles：每 sheet 的 styleIndex 优先按本 sheet 样式解析', () => {
  const dir = tmp();
  const cpt = path.join(dir, 'styled.cpt');
  try {
    const r = buildReport({
      path: cpt, check: true, noOverwrite: true,
      styles: [{ fontName: '微软雅黑', fontSizePt: 12 }],
      sheets: [
        { name: 'S1', cells: [{ column: 0, row: 0, content: '顶层样式', styleIndex: 0 }] },
        {
          name: 'S2',
          styles: [{ fontName: '宋体', fontSizePt: 10 }],
          cells: [{ column: 0, row: 0, content: '本表样式', styleIndex: 0 }],
        },
      ],
    });
    assert.equal(r.checkResult.hasError, false);

    const allStyles = styles(cpt);
    const songIndex = allStyles.findIndex((s) => s.fontName === '宋体');
    const yaheiIndex = allStyles.findIndex((s) => s.fontName === '微软雅黑');
    assert.ok(songIndex > 0 && yaheiIndex > 0, '两个字体样式都应写入 StyleList');

    const s2Cell = cells(cpt).find((c) => c.sheetIndex === 1 && c.row === 0);
    assert.equal(s2Cell.style, allStyles[songIndex].styleIndex, 'S2 的 styleIndex 0 必须解析到本表样式（宋体）');
    assert.notEqual(s2Cell.style, allStyles[yaheiIndex].styleIndex);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('datasets[].sqlFile：多 sheet 构建时 SQL 从文件读，回显来源', () => {
  const dir = tmp();
  const cpt = path.join(dir, 'sqlfile.cpt');
  const sqlFile = path.join(dir, 'report.sql');
  try {
    fs.writeFileSync(sqlFile, 'select dept, amount from t_a where d = ${day}', 'utf8');
    const r = buildReport({
      path: cpt, check: true, noOverwrite: true,
      sheets: [{ name: 'S1', cells: [{ column: 0, row: 0, content: 'x' }] }],
      datasets: [{ name: 'ds1', connection: 'Doris', sqlFile, parameters: [{ name: 'day', defaultValue: '2026-11-01' }] }],
    });
    assert.equal(r.checkResult.hasError, false);
    const ds = datasets(cpt).find((d) => d.name === 'ds1');
    assert.match(String(ds.sql ?? ds.sqlText ?? JSON.stringify(ds)), /select dept, amount from t_a/);
    assert.match(fs.readFileSync(cpt, 'utf8'), /where d = \$\{day\}/, 'SQL 原文（含 ${参数}）应写入模板');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('generate_report source.sqlFile：单表生成同样支持文件 SQL', () => {
  const dir = tmp();
  const cpt = path.join(dir, 'gen.cpt');
  const sqlFile = path.join(dir, 'gen.sql');
  try {
    fs.writeFileSync(sqlFile, 'select dept, amount from t_g', 'utf8');
    const r = generateReport({
      path: cpt,
      title: '文件SQL',
      source: { connection: 'Doris', sqlFile },
      fields: [{ name: 'dept', label: '部门' }, { name: 'amount', label: '金额', type: 'money' }],
    });
    assert.equal(r.checkResult.hasError, false);
    assert.match(fs.readFileSync(cpt, 'utf8'), /select dept, amount from t_g/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('sheets[].fill：每表填报提交一次成型（自动开启 WebWriteContent）', () => {
  const dir = tmp();
  const cpt = path.join(dir, 'fill.cpt');
  try {
    const r = buildReport({
      path: cpt, check: true, noOverwrite: true,
      sheets: [
        { name: 'S1', cells: [{ column: 0, row: 0, content: '表一' }] },
        {
          name: 'S2',
          cells: [{ column: 0, row: 2, content: '' }],
          fill: {
            table: 't_fill_s2', dsName: 'Doris',
            bindings: [{ field: 'dept', column: 0, row: 2 }],
          },
        },
      ],
    });
    assert.equal(r.checkResult.hasError, false, JSON.stringify(r.checkResult.errors ?? []));
    const raw = fs.readFileSync(cpt, 'utf8');
    assert.match(raw, /WebWriteContent/, '每表 fill 必须开启 WebWriteContent');
    assert.match(raw, /t_fill_s2/, 'S2 的填报提交表名应落盘');
    // 骨架只有 1 个 sheet 时不应出现第二个 submit 之外的异常：校验整个文件仍可读
    assert.ok(cells(cpt).some((c) => c.sheetIndex === 1 && c.row === 2));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('顶层 cells 与 sheets[].cells 可混用；sheet 索引自动注入', () => {
  const dir = tmp();
  const cpt = path.join(dir, 'mixed.cpt');
  try {
    const r = buildReport({
      path: cpt, check: true, noOverwrite: true,
      cells: [{ column: 0, row: 0, content: '顶层格' }],
      sheets: [
        { name: 'S1' },
        { name: 'S2', cells: [{ column: 0, row: 0, content: '子表格' }] },
      ],
    });
    assert.equal(r.checkResult.hasError, false);
    assert.deepEqual(textsOfSheet(cpt, 0), ['顶层格']);
    assert.deepEqual(textsOfSheet(cpt, 1), ['子表格']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
