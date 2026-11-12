// cpt-mcp/lib/cell-batch.js —— 多单元格紧凑选择 + 事务式批量 CRUD
//
// 模型只传范围/矩阵/补丁；坐标展开、逐格兼容处理、校验与最终写入均在服务端完成。
// plan 阶段在临时副本上复用已验证的单格原语，apply 阶段只对原文件原子保存一次。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { cells } from './cpt.js';
import { load, save } from './xml.js';
import { validateCpt } from './validate.js';
import { addCell } from './generate.js';
import {
  updateCellContent, updateCellTooltip, updateCellStyle, deleteCell,
  deleteCellRange, rebindCellStyle, updateCellInsertPolicy, INSERT_POLICY_VALUES,
} from './edits.js';
import { normalizePath } from './path-util.js';

const TTL_MS = 10 * 60 * 1000;
const MAX_COMMANDS = 100;
const MAX_AFFECTED_CELLS = Number(process.env.CPT_MCP_BATCH_MAX_CELLS || 100_000);

const selections = new Map();
const plans = new Map();
const failures = new Map();

const CELL_SPEC_KEYS = new Set([
  'column', 'row', 'content', 'contentType', 'dsName', 'columnName', 'result', 'sort', 'ci',
  'styleIndex', 'widget', 'widgetItems', 'colspan', 'rowspan', 'widgetClass', 'pluginID',
  'pluginVersion', 'sheet', 'expand',
]);
const STYLE_PATCH_KEYS = new Set([
  'copyFrom', 'styleIndex', 'backgroundColor', 'fontName', 'fontSizePt', 'bold', 'italic',
  'foregroundColor', 'underline', 'strikethrough', 'verticalAlignment', 'border',
  'horizontalAlignment', 'textStyle', 'paddingLeft', 'paddingRight', 'lineSpacing', 'rotation',
]);

function assertObjectKeys(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} 必须是对象`);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length) throw new Error(`${label} 含未支持字段 ${unknown.join(', ')}；不得猜测或静默忽略`);
}

function cleanup(now = Date.now()) {
  for (const store of [selections, plans, failures]) {
    for (const [id, value] of store) if (value.expiresAt <= now) store.delete(id);
  }
}

function fileRevision(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}



function columnToName(column) {
  let n = Number(column);
  let out = '';
  do {
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return out;
}

export function toA1(column, row) {
  return `${columnToName(column)}${Number(row) + 1}`;
}

export function parseA1(value) {
  const match = String(value || '').trim().toUpperCase().match(/^([A-Z]{1,4})([1-9]\d{0,6})$/);
  if (!match) throw new Error(`单元格地址非法 "${value}"：须为 A1、BC23 这类 A1 地址`);
  let column = 0;
  for (const char of match[1]) column = column * 26 + char.charCodeAt(0) - 64;
  return { column: column - 1, row: Number(match[2]) - 1 };
}

export function parseRange(value) {
  const parts = String(value || '').split(':');
  if (parts.length > 2) throw new Error(`单元格范围非法 "${value}"`);
  const from = parseA1(parts[0]);
  const to = parseA1(parts[1] || parts[0]);
  if (to.column < from.column || to.row < from.row) {
    throw new Error(`范围 "${value}" 必须从左上角写到右下角`);
  }
  return { fromColumn: from.column, fromRow: from.row, toColumn: to.column, toRow: to.row };
}

function addressOf(cell) {
  return `${cell.sheet}!${toA1(cell.column, cell.row)}`;
}

function coordKey(cell) {
  return `${cell.sheetIndex}:${cell.column}:${cell.row}`;
}

function matchesRange(cell, range) {
  return cell.column >= range.fromColumn && cell.column <= range.toColumn
    && cell.row >= range.fromRow && cell.row <= range.toRow;
}

function selectExisting(filePath, selector = {}) {
  assertObjectKeys(selector, new Set(['sheet', 'ranges', 'cells', 'where', 'groupBy']), 'selector');
  if (selector.sheet === undefined) throw new Error('cellSet 必须明确提供 selector.sheet；不得推测工作表');
  if (selector.where !== undefined) {
    assertObjectKeys(selector.where, new Set(['styleIndexes', 'contentKinds', 'widgetClasses', 'nonEmpty']), 'selector.where');
  }
  const all = cells(filePath, { sheet: selector.sheet });
  const ranges = (selector.ranges || []).map(parseRange);
  const points = new Set((selector.cells || []).map((item) => {
    const p = parseA1(item);
    return `${p.column}:${p.row}`;
  }));
  const hasAddressFilter = ranges.length > 0 || points.size > 0;
  const where = selector.where || {};
  return all.filter((cell) => {
    if (hasAddressFilter && !ranges.some((range) => matchesRange(cell, range)) && !points.has(`${cell.column}:${cell.row}`)) return false;
    if (where.styleIndexes?.length && !where.styleIndexes.includes(cell.style ?? 0)) return false;
    if (where.contentKinds?.length && !where.contentKinds.includes(cell.contentKind)) return false;
    if (where.widgetClasses?.length && !where.widgetClasses.some((name) => (cell.widgetClass || '').includes(name))) return false;
    if (where.nonEmpty === true && cell.contentKind === 'empty' && !cell.widgetClass) return false;
    return true;
  });
}

/** 将坐标精确压缩为矩形列表；只有相邻行拥有相同列区间时才纵向合并，不扩大选区。 */
export function compressCellRanges(items) {
  const bySheet = new Map();
  for (const cell of items) {
    const sheet = cell.sheet ?? String(cell.sheetIndex);
    if (!bySheet.has(sheet)) bySheet.set(sheet, new Map());
    const rows = bySheet.get(sheet);
    if (!rows.has(cell.row)) rows.set(cell.row, []);
    rows.get(cell.row).push(cell.column);
  }
  const result = [];
  for (const [sheet, rows] of bySheet) {
    const active = new Map();
    for (const row of [...rows.keys()].sort((a, b) => a - b)) {
      const columns = [...new Set(rows.get(row))].sort((a, b) => a - b);
      const intervals = [];
      for (const column of columns) {
        const last = intervals[intervals.length - 1];
        if (last && column === last[1] + 1) last[1] = column;
        else intervals.push([column, column]);
      }
      const present = new Set();
      for (const [fromColumn, toColumn] of intervals) {
        const key = `${fromColumn}:${toColumn}`;
        present.add(key);
        const previous = active.get(key);
        if (previous && previous.toRow === row - 1) previous.toRow = row;
        else active.set(key, { sheet, fromColumn, toColumn, fromRow: row, toRow: row });
      }
      for (const [key, rect] of [...active]) {
        if (!present.has(key) && rect.toRow < row) {
          result.push(rect);
          active.delete(key);
        }
      }
    }
    result.push(...active.values());
  }
  return result.map((rect) => {
    const from = toA1(rect.fromColumn, rect.fromRow);
    const to = toA1(rect.toColumn, rect.toRow);
    return `${rect.sheet}!${from === to ? from : `${from}:${to}`}`;
  });
}

function summarizeGroups(items, groupBy = []) {
  if (!groupBy.length) return [];
  const groups = new Map();
  for (const cell of items) {
    const keyObject = {};
    for (const field of groupBy) {
      if (field === 'style') keyObject.styleIndex = cell.style ?? 0;
      if (field === 'contentKind') keyObject.contentKind = cell.contentKind;
      if (field === 'widgetClass') keyObject.widgetClass = cell.widgetClass || null;
    }
    const key = JSON.stringify(keyObject);
    if (!groups.has(key)) groups.set(key, { key: keyObject, cells: [] });
    groups.get(key).cells.push(cell);
  }
  return [...groups.values()]
    .sort((a, b) => b.cells.length - a.cells.length)
    .slice(0, 20)
    .map((group) => ({
      key: group.key,
      count: group.cells.length,
      ranges: compressCellRanges(group.cells).slice(0, 20),
      samples: group.cells.slice(0, 3).map(addressOf),
    }));
}

export function selectCellSet(filePath, selector = {}, { detail = 'summary', cursor = 0, limit = 20 } = {}) {
  cleanup();
  const matched = selectExisting(filePath, selector);
  if (matched.length > MAX_AFFECTED_CELLS) {
    throw new Error(`cellSet 命中 ${matched.length} 格，超过上限 ${MAX_AFFECTED_CELLS}；请用 ranges/where 缩小范围`);
  }
  const revision = fileRevision(filePath);
  const selectionId = crypto.randomUUID();
  selections.set(selectionId, {
    path: normalizePath(filePath), revision,
    cells: matched.map((cell) => ({ ...cell })),
    expiresAt: Date.now() + TTL_MS,
  });
  const safeCursor = Math.max(0, Number(cursor) || 0);
  const safeLimit = Math.min(50, Math.max(1, Number(limit) || 20));
  const result = {
    view: 'cellSet', selectionId, snapshotId: revision,
    matchedCount: matched.length,
    coverage: compressCellRanges(matched).slice(0, 50),
    groups: summarizeGroups(matched, selector.groupBy || []),
    samples: matched.slice(0, 3).map(addressOf),
    expiresInSeconds: TTL_MS / 1000,
  };
  if (detail === 'standard') {
    result.items = matched.slice(safeCursor, safeCursor + safeLimit).map((cell) => ({
      sheet: cell.sheet, address: toA1(cell.column, cell.row), style: cell.style,
      contentKind: cell.contentKind, contentText: cell.contentText,
      widgetClass: cell.widgetClass, colspan: cell.colspan, rowspan: cell.rowspan,
      insertPolicy: cell.insertPolicy ?? null,
    }));
    result.cursor = safeCursor;
    result.nextCursor = safeCursor + safeLimit < matched.length ? safeCursor + safeLimit : null;
  }
  return result;
}

function resolveTarget(filePath, target = {}) {
  if (target.selectionId) {
    const selection = selections.get(target.selectionId);
    if (!selection || selection.expiresAt <= Date.now()) throw new Error('selectionId 不存在或已过期，请重新读取 cellSet');
    if (selection.path !== normalizePath(filePath)) throw new Error('selectionId 与当前 CPT 路径不匹配');
    if (selection.revision !== fileRevision(filePath)) throw new Error('selectionId 已失效：CPT 在选择后发生变化');
    return selection.cells.map((cell) => ({ ...cell }));
  }
  return selectExisting(filePath, target);
}

function rememberFailure(error, { filePath, affectedCount = 0, suggestedTools = [], target = null } = {}) {
  const failureId = crypto.randomUUID();
  const fallbackEligible = affectedCount === 1 && suggestedTools.length > 0;
  failures.set(failureId, {
    path: normalizePath(filePath), affectedCount, suggestedTools, target,
    fallbackEligible, expiresAt: Date.now() + TTL_MS,
  });
  return {
    status: 'failed', code: 'batch-operation-failed', failureId,
    fallbackEligible, affectedCount, suggestedDeepTools: suggestedTools,
    target, message: error.message,
  };
}

export function getBatchFailure(failureId) {
  cleanup();
  return failures.get(failureId) || null;
}

export function takeBatchFailure(failureId) {
  const failure = getBatchFailure(failureId);
  if (failure) failures.delete(failureId);
  return failure;
}

function createCells(tempPath, command) {
  const data = command.data || {};
  const target = command.target || {};
  assertObjectKeys(data, new Set(['cells', 'matrix', 'defaults']), 'create.data');
  if (data.defaults !== undefined) assertObjectKeys(data.defaults, CELL_SPEC_KEYS, 'create.data.defaults');
  const specs = [];
  if (Array.isArray(data.cells)) specs.push(...data.cells);
  if (Array.isArray(data.matrix)) {
    if (target.sheet === undefined || !target.anchor) throw new Error('create matrix 必须提供 target.sheet 和 target.anchor');
    const anchor = parseA1(target.anchor);
    data.matrix.forEach((row, rowOffset) => {
      if (!Array.isArray(row)) throw new Error(`create matrix 第 ${rowOffset + 1} 行必须是数组`);
      row.forEach((value, columnOffset) => {
        if (value === null || value === undefined) return;
        const spec = typeof value === 'object' && !Array.isArray(value) ? value : { content: String(value) };
        specs.push({ ...data.defaults, ...spec, sheet: target.sheet, column: anchor.column + columnOffset, row: anchor.row + rowOffset });
      });
    });
  }
  if (!specs.length) throw new Error('create 至少需要 data.cells 或 data.matrix');
  if (specs.length > MAX_AFFECTED_CELLS) throw new Error(`create 目标 ${specs.length} 格超过上限 ${MAX_AFFECTED_CELLS}`);
  specs.forEach((spec, index) => assertObjectKeys(spec, CELL_SPEC_KEYS, `create.data.cells[${index}]`));
  for (const spec of specs) addCell(tempPath, spec);
  return specs.length;
}

function applyStylePatch(tempPath, targets, style) {
  if (!style || !targets.length) return;
  if (style.copyFrom) {
    const source = parseA1(style.copyFrom.cell);
    const sourceCells = cells(tempPath, { sheet: style.copyFrom.sheet });
    const sourceCell = sourceCells.find((cell) => cell.column === source.column && cell.row === source.row);
    if (!sourceCell) throw new Error(`样式参考单元格 ${style.copyFrom.cell} 不存在`);
    for (const cell of targets) rebindCellStyle(tempPath, cell.column, cell.row, sourceCell.style ?? 0, cell.sheetIndex);
    return;
  }
  if (style.styleIndex !== undefined) {
    for (const cell of targets) rebindCellStyle(tempPath, cell.column, cell.row, style.styleIndex, cell.sheetIndex);
    return;
  }
  const patch = { ...style };
  delete patch.copyFrom;
  delete patch.styleIndex;
  const before = cells(tempPath);
  const styleByCoord = new Map(before.map((cell) => [coordKey(cell), cell.style ?? 0]));
  const groups = new Map();
  for (const cell of targets) {
    const styleIndex = styleByCoord.get(coordKey(cell)) ?? 0;
    if (!groups.has(styleIndex)) groups.set(styleIndex, []);
    groups.get(styleIndex).push(cell);
  }
  for (const group of groups.values()) {
    const [first, ...rest] = group;
    const changed = updateCellStyle(tempPath, first.column, first.row, { ...patch, scope: 'cell' }, first.sheetIndex);
    for (const cell of rest) rebindCellStyle(tempPath, cell.column, cell.row, changed.styleIndex, cell.sheetIndex);
  }
}

function updateCells(tempPath, originalPath, command) {
  assertObjectKeys(command.data || {}, new Set(['patch']), 'update.data');
  const targets = resolveTarget(originalPath, command.target);
  if (!targets.length) throw new Error('update 目标选区为空');
  if (targets.length > MAX_AFFECTED_CELLS) throw new Error(`update 目标 ${targets.length} 格超过上限 ${MAX_AFFECTED_CELLS}`);
  const patch = command.data?.patch;
  if (!patch || typeof patch !== 'object') throw new Error('update 必须提供 data.patch');
  // insertPolicy：填报行完整性批量补 copy 的入口（业务侧此前只能"备份后直写 XML"绕过 MCP，
  // 正是被这里的白名单拒掉的）。取值同 update_cell：copy/default/null 写入，null 删除整块节点。
  assertObjectKeys(patch, new Set(['content', 'tooltip', 'style', 'insertPolicy']), 'update.data.patch');
  if (patch.content !== undefined) {
    for (const cell of targets) updateCellContent(tempPath, cell.column, cell.row, patch.content, cell.sheetIndex);
  }
  if (patch.tooltip !== undefined) {
    for (const cell of targets) updateCellTooltip(tempPath, cell.column, cell.row, patch.tooltip, cell.sheetIndex);
  }
  if (patch.insertPolicy !== undefined) {
    if (patch.insertPolicy !== null && !INSERT_POLICY_VALUES.includes(String(patch.insertPolicy).trim())) {
      throw new Error(`update.data.patch.insertPolicy 取值非法 "${patch.insertPolicy}"：官方枚举只有 ${INSERT_POLICY_VALUES.join(' / ')}（null=删除该节点）`);
    }
    for (const cell of targets) updateCellInsertPolicy(tempPath, cell.column, cell.row, patch.insertPolicy, cell.sheetIndex);
  }
  if (patch.style !== undefined) {
    assertObjectKeys(patch.style, STYLE_PATCH_KEYS, 'update.data.patch.style');
    applyStylePatch(tempPath, targets, patch.style);
  }
  if (patch.content === undefined && patch.tooltip === undefined && patch.style === undefined && patch.insertPolicy === undefined) {
    throw new Error('update patch 至少需要 content、tooltip、style 或 insertPolicy');
  }
  return targets.length;
}

function deleteCells(tempPath, originalPath, command) {
  assertObjectKeys(command.data || {}, new Set(['mode']), 'delete.data');
  const mode = command.data?.mode || 'clear';
  if (mode === 'deleteColumns') {
    if (command.target?.sheet === undefined || !Array.isArray(command.target.ranges) || command.target.ranges.length !== 1) {
      throw new Error('deleteColumns 必须明确提供一个 target.sheet 和一个列范围');
    }
    const range = parseRange(command.target.ranges[0]);
    const result = deleteCellRange(tempPath, {
      sheet: command.target.sheet, fromColumn: range.fromColumn, toColumn: range.toColumn, shiftLeft: true,
    });
    return result.deletedCells;
  }
  if (mode !== 'clear') throw new Error(`暂不支持 delete mode=${mode}；当前支持 clear/deleteColumns`);
  const targets = resolveTarget(originalPath, command.target);
  if (!targets.length) throw new Error('delete 目标选区为空');
  for (const cell of targets) deleteCell(tempPath, cell.column, cell.row, cell.sheetIndex);
  return targets.length;
}

function executeCommands(tempPath, originalPath, commands) {
  const summary = { create: 0, update: 0, delete: 0 };
  for (const command of commands) {
    if (command.op === 'create') summary.create += createCells(tempPath, command);
    else if (command.op === 'update') summary.update += updateCells(tempPath, originalPath, command);
    else if (command.op === 'delete') summary.delete += deleteCells(tempPath, originalPath, command);
    else throw new Error(`不支持的批量操作 op=${command.op}`);
  }
  return summary;
}

function inferFailureScope(filePath, command) {
  if (!command) return { affectedCount: 0, target: null };
  if (command.op === 'create') {
    const specs = Array.isArray(command.data?.cells) ? command.data.cells : [];
    if (specs.length === 1) {
      const spec = specs[0];
      if (Number.isInteger(Number(spec.column)) && Number.isInteger(Number(spec.row))) {
        return {
          affectedCount: 1,
          target: { sheet: spec.sheet ?? command.target?.sheet ?? 0, cell: toA1(Number(spec.column), Number(spec.row)) },
        };
      }
    }
    if (Array.isArray(command.data?.matrix) && command.target?.sheet !== undefined && command.target?.anchor) {
      const present = [];
      command.data.matrix.forEach((row, rowOffset) => {
        if (!Array.isArray(row)) return;
        row.forEach((value, columnOffset) => {
          if (value !== null && value !== undefined) present.push({ rowOffset, columnOffset });
        });
      });
      if (present.length === 1) {
        const anchor = parseA1(command.target.anchor);
        return {
          affectedCount: 1,
          target: {
            sheet: command.target.sheet,
            cell: toA1(anchor.column + present[0].columnOffset, anchor.row + present[0].rowOffset),
          },
        };
      }
      return { affectedCount: present.length, target: null };
    }
    return { affectedCount: specs.length, target: null };
  }
  try {
    const targets = resolveTarget(filePath, command.target);
    return {
      affectedCount: targets.length,
      target: targets.length === 1
        ? { sheet: targets[0].sheetIndex, cell: toA1(targets[0].column, targets[0].row) }
        : null,
    };
  } catch {
    return { affectedCount: 0, target: null };
  }
}

export function planCellBatch(filePath, commands) {
  cleanup();
  if (!Array.isArray(commands) || !commands.length) throw new Error('commands 至少需要一条命令');
  if (commands.length > MAX_COMMANDS) throw new Error(`commands 最多 ${MAX_COMMANDS} 条`);
  const { raw } = load(filePath);
  const revision = fileRevision(filePath);
  const tempPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.batch-${crypto.randomUUID()}.cpt`);
  fs.writeFileSync(tempPath, raw, 'utf8');
  let summary;
  try {
    summary = executeCommands(tempPath, filePath, commands);
    const issues = validateCpt(tempPath).filter((issue) => issue.severity === 'error');
    if (issues.length) throw new Error(`批量计划生成后结构校验失败：${issues.slice(0, 3).map((i) => i.message).join('；')}`);
    const finalRaw = fs.readFileSync(tempPath, 'utf8');
    const planId = crypto.randomUUID();
    plans.set(planId, {
      path: normalizePath(filePath), revision, finalRaw, summary,
      expiresAt: Date.now() + TTL_MS,
    });
    return {
      status: 'ready', planId, revision, summary,
      affectedCount: summary.create + summary.update + summary.delete,
      requiresConfirmation: true, expiresInSeconds: TTL_MS / 1000,
    };
  } catch (error) {
    const scope = commands.length === 1 ? inferFailureScope(filePath, commands[0]) : { affectedCount: 0, target: null };
    const suggestedTools = commands.length === 1
      ? commands[0].op === 'create' ? ['add_cell']
        : commands[0].op === 'update' ? ['update_cell', 'update_cell_style']
          : commands[0].op === 'delete' ? ['delete_cell'] : []
      : [];
    return rememberFailure(error, { filePath, ...scope, suggestedTools });
  } finally {
    try { fs.unlinkSync(tempPath); } catch { /* best effort */ }
  }
}

export function applyCellBatch(filePath, planId) {
  cleanup();
  const plan = plans.get(planId);
  if (!plan) throw new Error('planId 不存在或已过期，请重新生成批量计划');
  if (plan.path !== normalizePath(filePath)) throw new Error('planId 与当前 CPT 路径不匹配');
  load(filePath); // 刷新 save() 的乐观并发基线
  if (fileRevision(filePath) !== plan.revision) throw new Error('批量计划已失效：CPT 在 plan 后发生变化');
  // 版本由宿主接管（可选）：CPT_MCP_NO_BAK=1 时不建 .bak-batch-*（同 builder.js publishStagedFile）。
  const backupEnabled = process.env.CPT_MCP_NO_BAK !== '1';
  const backupPath = backupEnabled
    ? `${filePath}.bak-batch-${new Date().toISOString().replace(/[:.]/g, '-')}`
    : null;
  if (backupPath) fs.copyFileSync(filePath, backupPath);
  save(filePath, plan.finalRaw);
  plans.delete(planId);
  return {
    status: 'applied', planId, summary: plan.summary,
    affectedCount: plan.summary.create + plan.summary.update + plan.summary.delete,
    backupPath, revision: fileRevision(filePath),
  };
}

