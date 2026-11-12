// cpt-mcp/lib/read-gate.js —— CPT 紧凑读取门禁
// 默认 MCP 只暴露 record_cpt_read_intent + read_cpt_compact 两个小 schema；
// 原有细粒度读取函数保留为内部实现，避免 tools/list 长期携带多个重复 schema。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import {
  overview, datasets, parameters, cells, fillConfig, styles, pageSettings, parameterPanel, gridSizes,
} from './cpt.js';
import { getCellStyle, getCellHyperlink } from './edits.js';
import { selectCellSet } from './cell-batch.js';
import { normalizePath as normalizedPath } from './path-util.js';

export const CPT_READ_VIEWS = [
  'overview', 'datasets', 'parameters', 'cells', 'fill', 'styles',
  'page', 'grid', 'panel', 'cellStyle', 'hyperlink',
  'cellSet',
];

const DEFAULT_TTL_SECONDS = 600;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;


function defaultAuditLogPath() {
  if (process.env.CPT_MCP_AUDIT_LOG) return path.resolve(process.env.CPT_MCP_AUDIT_LOG);
  if (process.platform === 'win32') {
    const base = process.env.LOCALAPPDATA || os.tmpdir();
    return path.join(base, 'cpt-mcp', 'audit', 'read-access.jsonl');
  }
  const state = process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state');
  return path.join(state, 'cpt-mcp', 'audit', 'read-access.jsonl');
}

function appendAudit(logPath, entry) {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.appendFileSync(logPath, `${JSON.stringify(entry)}\n`, { encoding: 'utf8', mode: 0o600 });
}

function cleanStrings(values) {
  return values.map((value) => String(value).trim()).filter(Boolean);
}

export class CptReadGate {
  constructor({ auditLogPath = defaultAuditLogPath(), ttlSeconds = DEFAULT_TTL_SECONDS, now = () => Date.now() } = {}) {
    this.auditLogPath = auditLogPath;
    this.ttlSeconds = ttlSeconds;
    this.now = now;
    this.permits = new Map();
  }

  recordIntent({ path: filePath, views, purpose, confirmedFacts, uncertainties = [] }) {
    for (const [permitId, permit] of this.permits) {
      if (permit.expiresAt <= this.now()) this.permits.delete(permitId);
    }
    const questions = cleanStrings(uncertainties);
    const common = {
      timestamp: new Date(this.now()).toISOString(),
      path: path.resolve(filePath),
      purpose: String(purpose).trim(),
      views: [...new Set(views)],
      confirmedFacts: cleanStrings(confirmedFacts),
    };

    if (questions.length > 0) {
      appendAudit(this.auditLogPath, { ...common, status: 'clarification_required', questions });
      return { status: 'clarification_required', questions };
    }

    const permitId = crypto.randomUUID();
    const expiresAt = this.now() + this.ttlSeconds * 1000;
    appendAudit(this.auditLogPath, { ...common, status: 'authorized', permitId, expiresAt: new Date(expiresAt).toISOString() });
    // 严格保证“日志已落盘”先于授权生效；写日志失败时绝不留下可用 permit。
    this.permits.set(permitId, {
      path: normalizedPath(filePath),
      views: new Set(common.views),
      expiresAt,
    });
    return { status: 'authorized', permitId, expiresInSeconds: this.ttlSeconds, views: common.views };
  }

  assertAuthorized({ permitId, path: filePath, view }) {
    const permit = this.permits.get(permitId);
    if (!permit) throw new Error('读取未授权：请先调用 record_cpt_read_intent 获取 permitId');
    if (permit.expiresAt <= this.now()) {
      this.permits.delete(permitId);
      throw new Error('读取授权已过期：请重新调用 record_cpt_read_intent');
    }
    if (permit.path !== normalizedPath(filePath)) {
      throw new Error('读取授权与当前 CPT 路径不匹配：不得把 permitId 用于其他文件');
    }
    if (!permit.views.has(view)) {
      throw new Error(`读取视图 ${view} 未授权：请重新记录读取意图并明确申请该视图`);
    }
  }
}

function truncateValue(value, maxLength, maxItems, fieldPath, truncatedFields) {
  if (typeof value === 'string' && value.length > maxLength) {
    truncatedFields.push(fieldPath);
    return `${value.slice(0, maxLength)}…`;
  }
  if (Array.isArray(value)) {
    if (value.length > maxItems) truncatedFields.push(fieldPath);
    return value.slice(0, maxItems)
      .map((item, index) => truncateValue(item, maxLength, maxItems, `${fieldPath}[${index}]`, truncatedFields));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key, truncateValue(item, maxLength, maxItems, fieldPath ? `${fieldPath}.${key}` : key, truncatedFields),
    ]));
  }
  return value;
}

function paged(view, items, cursor, limit, truncatedFields) {
  const start = Math.min(cursor, items.length);
  const page = items.slice(start, start + limit);
  const next = start + page.length;
  return {
    view,
    total: items.length,
    items: page,
    hasMore: next < items.length,
    nextCursor: next < items.length ? next : null,
    truncatedFields,
  };
}

function requireCellSelector(selector, view) {
  if (selector?.column === undefined || selector?.row === undefined) {
    throw new Error(`${view} 视图必须明确提供 selector.column 和 selector.row；不得推测坐标`);
  }
}

/**
 * 统一紧凑读取。列表默认 20 条、最多 50 条；长文本按 detail 裁剪。
 */
export function readCptCompact(filePath, {
  view,
  selector = {},
  cursor = 0,
  limit = DEFAULT_LIMIT,
  detail = 'summary',
} = {}) {
  const safeCursor = Math.max(0, Number(cursor) || 0);
  const safeLimit = Math.min(MAX_LIMIT, Math.max(1, Number(limit) || DEFAULT_LIMIT));
  const maxText = detail === 'standard' ? 2000 : 200;
  const truncatedFields = [];
  let result;

  if (view === 'overview') {
    result = { view, data: overview(filePath), truncatedFields };
  } else if (view === 'datasets') {
    let list = datasets(filePath);
    if (selector.name) list = list.filter((item) => item.name === selector.name);
    if (detail === 'summary') {
      list = list.map(({ index, name, class: className, connection, parameters: params, sql }) => ({
        index, name, class: className, connection, parameterCount: params.length, sql,
      }));
    }
    result = paged(view, list, safeCursor, safeLimit, truncatedFields);
  } else if (view === 'parameters') {
    let list = parameters(filePath);
    if (selector.name) list = list.filter((item) => item.name === selector.name || item.dataset === selector.name);
    result = paged(view, list, safeCursor, safeLimit, truncatedFields);
  } else if (view === 'cellSet') {
    return selectCellSet(filePath, selector, { detail, cursor: safeCursor, limit: safeLimit });
  } else if (view === 'cells') {
    let list = cells(filePath, selector.sheet === undefined ? {} : { sheet: selector.sheet });
    if (selector.column !== undefined) list = list.filter((item) => item.column === selector.column);
    if (selector.row !== undefined) list = list.filter((item) => item.row === selector.row);
    if (selector.widgetClass) list = list.filter((item) => (item.widgetClass || '').includes(selector.widgetClass));
    // 【M116 已移除 jsAlert】旧逻辑在 standard 口径下扫描原文 JS，命中代码位 `]A` 就挂
    // "可疑残字"告警。实测证明 `]A` 是 FR 设计器对 `]` 的正常转义（官方 237 个 `]`
    // 100% 如此编码），该告警 100% 误报、且会把读方推向"去修一个没坏的东西"。
    // 真正的 JS 缺陷由 check_report_js / validate_cpt 判定（M116 起已解码后再解析）。
    const jsAlert = null;
    if (detail === 'summary') {
      list = list.map(({ sheet, column, row, style, colspan, rowspan, widgetClass, contentKind, contentText, insertPolicy }) => ({
        sheet, column, row, style, colspan, rowspan, widgetClass, contentKind, contentText, insertPolicy: insertPolicy ?? null,
      }));
    }
    result = paged(view, list, safeCursor, safeLimit, truncatedFields);
    if (jsAlert) result.jsAlert = jsAlert;
  } else if (view === 'fill') {
    const config = fillConfig(filePath);
    let list = config.submits;
    if (selector.name) list = list.filter((item) => item.name === selector.name || item.table === selector.name);
    if (detail === 'summary') {
      list = list.map(({ index, sheet, name, class: className, dsName, table, schema, columns }) => ({
        index, sheet, name, class: className, dsName, table, schema, columnCount: columns.length,
      }));
    }
    result = { ...paged(view, list, safeCursor, safeLimit, truncatedFields), verify: config.verify, shortcut: config.shortcut };
  } else if (view === 'styles') {
    let list = styles(filePath);
    if (selector.name !== undefined) {
      const wanted = Number(selector.name);
      list = list.filter((item) => item.styleIndex === wanted);
    }
    if (detail === 'summary') {
      list = list.map(({ styleIndex, fontName, bold, fontSizePt, foregroundColor, backgroundColor, horizontalAlignment }) => ({
        styleIndex, fontName, bold, fontSizePt, foregroundColor, backgroundColor, horizontalAlignment,
      }));
    }
    result = paged(view, list, safeCursor, safeLimit, truncatedFields);
  } else if (view === 'page') {
    result = { view, data: pageSettings(filePath), truncatedFields };
  } else if (view === 'grid') {
    let list = gridSizes(filePath);
    if (selector.sheet !== undefined) {
      list = list.filter((item) => item.sheet === selector.sheet || item.sheetIndex === selector.sheet);
    }
    list = list.map((item) => detail === 'summary' ? {
      sheet: item.sheet,
      sheetIndex: item.sheetIndex,
      rowDefault: item.rowHeights?.default ?? null,
      rowCount: item.rowHeights?.values.length ?? 0,
      columnDefault: item.columnWidths?.default ?? null,
      columnCount: item.columnWidths?.values.length ?? 0,
    } : {
      ...item,
      rowHeights: item.rowHeights ? { ...item.rowHeights, values: item.rowHeights.values.slice(0, safeLimit), mm: item.rowHeights.mm.slice(0, safeLimit) } : null,
      columnWidths: item.columnWidths ? { ...item.columnWidths, values: item.columnWidths.values.slice(0, safeLimit), mm: item.columnWidths.mm.slice(0, safeLimit) } : null,
    });
    result = paged(view, list, safeCursor, safeLimit, truncatedFields);
  } else if (view === 'panel') {
    const panel = parameterPanel(filePath);
    if (!panel || detail === 'standard') result = { view, data: panel, truncatedFields };
    else result = { view, data: { ...panel, widgets: undefined, parameters: undefined, widgetCount: panel.widgets.length, parameterCount: panel.parameters.length }, truncatedFields };
  } else if (view === 'cellStyle') {
    requireCellSelector(selector, view);
    result = { view, data: getCellStyle(filePath, selector.column, selector.row, selector.sheet), truncatedFields };
  } else if (view === 'hyperlink') {
    requireCellSelector(selector, view);
    result = { view, data: getCellHyperlink(filePath, selector.column, selector.row, selector.sheet), truncatedFields };
  } else {
    throw new Error(`未知读取视图：${view}`);
  }

  return truncateValue(result, maxText, safeLimit, '', truncatedFields);
}

