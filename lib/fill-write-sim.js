// cpt-mcp/lib/fill-write-sim.js —— 填报提交的本地 SQLite 试写/行来源追踪（2026-11-12）
//
// 目的（用户场景）：两个相似 sheet 都提交到同一张目标表，修改一个 sheet 后提交时，
// 另一个 sheet 的旧行也可能参与 upsert。本模块只在本机 SQLite 的**事务内**模拟一次提交，
// 返回每个 sheet 的 insert/update/unchanged 计数、写事件次数、重复写 key、可能被旧值覆盖的 key，
// 最后无条件 ROLLBACK —— 不落库、不碰真实库。
//
// 不模拟：自由 SQL 提交（无法通用推断参数/条件）、FR 前端 JS、before/after 事件。
// 提交条件无法从 xlsx/cpt 单元格值静态求值；场景行可用 __condition:true/false 显式指定，
// 未指定时按"全部通过"处理并返回 condition_not_evaluated 提示。
import crypto from 'node:crypto';
import { fillConfig, fillSubmitMatrix } from './cpt.js';
import { openLocalDb, closeLocalDb, toJsonSafe, readWriteAuditConfig } from './localdb.js';

const MAX_REPEAT = 20;
const DEFAULT_MAX_ROWS = 5000;

function q(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

function norm(v) {
  const s = toJsonSafe(v);
  if (typeof s === 'bigint') return Number(s);
  if (s instanceof Uint8Array) return `base64:${Buffer.from(s).toString('base64')}`;
  return s;
}

function keyHash(values) {
  return crypto.createHash('sha1').update(JSON.stringify(values)).digest('hex').slice(0, 16);
}

function tableExists(db, table) {
  return Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table));
}

function tableColumns(db, table) {
  try { return db.prepare(`PRAGMA table_info(${q(table)})`).all().map((r) => String(r.name)); } catch { return []; }
}

function tableCount(db, table) {
  try { return toJsonSafe(db.prepare(`SELECT COUNT(*) AS n FROM ${q(table)}`).get()?.n ?? 0); } catch { return null; }
}

function allRows(db, table) {
  try { return db.prepare(`SELECT * FROM ${q(table)}`).all().map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, norm(v)]))); } catch { return []; }
}

/** 按 sheet 名/序号取场景行；兼容 fillConfig 的 sheet 名与 0 起序号。 */
function rowsForSheet(scenario, submit, sheetOrder) {
  if (!scenario || typeof scenario !== 'object') return [];
  const keys = [String(submit.sheet), String(sheetOrder.get(submit.sheet) ?? '')].filter(Boolean);
  for (const k of keys) {
    if (Object.prototype.hasOwnProperty.call(scenario, k) && Array.isArray(scenario[k])) return scenario[k];
  }
  return [];
}

/** 由 submit.columns 生成一条目标行；缺失字段不写，常量优先。 */
function valuesFromRow(submit, row, tableCols) {
  const values = {};
  const unknown = [];
  for (const c of submit.columns || []) {
    const field = String(c.field || '');
    if (!field) continue;
    let v;
    if (c.constant != null) v = c.constant;
    else if (row && Object.prototype.hasOwnProperty.call(row, field)) v = row[field];
    else continue;
    if (v === undefined) continue;
    if (!tableCols.includes(field)) { unknown.push(field); continue; }
    values[field] = v;
  }
  return { values, unknown };
}

function buildKey(submit, values) {
  const fields = (submit.columns || []).filter((c) => c.isKey).map((c) => String(c.field || '')).filter(Boolean);
  if (!fields.length) return null;
  const vals = {};
  for (const f of fields) {
    if (!Object.prototype.hasOwnProperty.call(values, f) || values[f] === null || values[f] === '') return null;
    vals[f] = values[f];
  }
  return { fields, values: vals };
}

function runStatement(db, sql, params) {
  return db.prepare(sql).run(...params);
}

/**
 * 模拟填报提交（本地 SQLite，事务内执行后 ROLLBACK）。
 *
 * @param {object} o
 * @param {string} o.db 本地库名
 * @param {string} o.path .cpt 路径
 * @param {object} [o.scenario] {sheet名或0起序号: [目标字段行对象]}
 * @param {string|number} [o.sheet] mode=single-sheet 时指定
 * @param {number} [o.submitIndex] 只模拟某个全局提交
 * @param {'all-sheets'|'single-sheet'} [o.mode] 缺省 all-sheets
 * @param {number} [o.repeat] 同一提交流程重复次数（默认 1，最大 20）
 * @returns {{ok:boolean, db:string, path:string, totals:object, sheets:object[], submissions:object[], tables:object[], staleKeys:object[], warnings:object[], rolledBack:boolean}}
 */
export function simulateFillSubmit(o = {}) {
  const dbName = String(o.db || '').trim();
  const cptPath = String(o.path || '').trim();
  if (!dbName) throw new Error('simulateFillSubmit 缺少 db');
  if (!cptPath) throw new Error('simulateFillSubmit 缺少 path');
  const repeat = Math.min(Math.max(1, Number(o.repeat) || 1), MAX_REPEAT);
  const mode = o.mode === 'single-sheet' ? 'single-sheet' : 'all-sheets';
  const maxRows = Math.min(Math.max(1, Number(o.maxRows) || readWriteAuditConfig().simulateMaxRows || DEFAULT_MAX_ROWS), 20000);
  const all = fillConfig(cptPath);
  let submits = Array.isArray(all.submits) ? all.submits : [];
  const sheetOrder = new Map();
  let order = 0;
  for (const s of (all.submits || [])) {
    if (!sheetOrder.has(s.sheet)) sheetOrder.set(s.sheet, order++);
  }
  if (o.submitIndex != null) {
    const idx = Number(o.submitIndex);
    submits = submits.filter((s) => Number(s.index) === idx);
    if (!submits.length) throw new Error(`未找到提交 submitIndex=${o.submitIndex}`);
  }
  if (mode === 'single-sheet') {
    if (o.sheet == null) throw new Error('mode=single-sheet 需要 sheet（工作表名或 0 起序号）');
    const target = String(o.sheet);
    submits = submits.filter((s) => String(s.sheet) === target
      || String(sheetOrder.get(s.sheet) ?? '') === target
      || String(s.sheet).toLowerCase() === target.toLowerCase());
    if (!submits.length) throw new Error(`未找到工作表 ${target} 的提交`);
  }

  const scenarioRows = [];
  for (const s of submits) scenarioRows.push(...rowsForSheet(o.scenario, s, sheetOrder));
  if (scenarioRows.length > maxRows) {
    return {
      ok: false,
      db: dbName,
      path: cptPath,
      rolledBack: true,
      error: { code: 'scenario_too_large', message: `场景行数 ${scenarioRows.length} 超过上限 ${maxRows}（settings.writeAudit.simulateMaxRows 可调，最大 20000）` },
    };
  }

  const db = openLocalDb(dbName, { internal: true, mustExist: true });
  const startedAt = Date.now();
  const warnings = [];
  const matrix = (() => { try { return fillSubmitMatrix(cptPath); } catch { return null; } })();
  if (matrix?.summary?.sharedTargets) {
    for (const w of matrix.warnings) warnings.push({ ...w, source: 'submit_matrix' });
  }
  const tableStats = new Map();
  const sheetStats = new Map();
  const writesByKey = new Map();
  const lastValueByKey = new Map();
  const submissions = [];
  const submissionMap = new Map();
  let inserted = 0; let updated = 0; let unchanged = 0; let skipped = 0; let errors = 0; let writeEvents = 0;
  let rolledBack = false;
  try {
    db.exec('BEGIN IMMEDIATE');
    // before 快照必须在事务内、任何写之前
    const targets = [...new Set(submits.map((s) => s.table).filter(Boolean))];
    for (const table of targets) {
      if (!tableExists(db, table)) {
        warnings.push({ code: 'TARGET_TABLE_MISSING', severity: 'error', table, message: `本地 SQLite 缺少目标表 ${table}；先 local_db_import({action:"report",db,path}) 准备。` });
        continue;
      }
      tableStats.set(table, { table, beforeRows: tableCount(db, table), afterRows: null, inserted: 0, updated: 0, unchanged: 0, errors: 0 });
    }

    for (let r = 0; r < repeat; r += 1) {
      for (const submit of submits) {
        const table = submit.table;
        const stat = sheetStats.get(submit.sheet) || {
          sheet: submit.sheet, submits: 0, eligible: 0, inserted: 0, updated: 0, unchanged: 0, skipped: 0, errors: 0,
        };
        sheetStats.set(submit.sheet, stat);
        let sub = submissionMap.get(submit.index);
        if (!sub) {
          sub = {
            index: submit.index, sheet: submit.sheet, name: submit.name, table: table || null,
            mode: submit.mode, submitType: submit.submitType,
            scenarioRows: 0, eligible: 0, inserted: 0, updated: 0, unchanged: 0, skipped: 0, errors: 0,
            conditionSkipped: false,
          };
          submissionMap.set(submit.index, sub);
          submissions.push(sub);
          stat.submits += 1;
        }
        const rows = rowsForSheet(o.scenario, submit, sheetOrder);
        if (r === 0) sub.scenarioRows = rows.length;
        if (submit.mode === 'free-sql') {
          if (r === 0) warnings.push({ code: 'FREE_SQL_NOT_SIMULATED', severity: 'warning', sheet: submit.sheet, submit: submit.name, message: '自由 SQL 提交未在本地试写（无法通用推断参数/条件）；请用本地 SQL 或真实预览验证。' });
          continue;
        }
        if (!table || !tableStats.has(table)) {
          sub.errors += 1; stat.errors += 1; errors += 1;
          continue;
        }
        const cols = tableColumns(db, table);
        const statTable = tableStats.get(table);
        const hasCondition = Boolean(submit.conditionClass);
        let condMissing = 0;
        for (const row of rows) {
          if (row && row.__condition === false) { sub.skipped += 1; stat.skipped += 1; skipped += 1; continue; }
          if (hasCondition && row && !Object.prototype.hasOwnProperty.call(row, '__condition')) condMissing += 1;
          const { values, unknown } = valuesFromRow(submit, row, cols);
          if (unknown.length) {
            warnings.push({ code: 'UNKNOWN_TARGET_COLUMN', severity: 'info', table, fields: [...new Set(unknown)], message: `提交 ${submit.name} 的字段在本地目标表中不存在，已忽略：${[...new Set(unknown)].join(', ')}` });
          }
          sub.eligible += 1; stat.eligible += 1;
          const key = buildKey(submit, values);
          if (!key) { sub.skipped += 1; stat.skipped += 1; skipped += 1; continue; }
          const keyVals = key.values;
          const whereSql = key.fields.map((f) => `${q(f)} IS ?`).join(' AND ');
          const existing = db.prepare(`SELECT * FROM ${q(table)} WHERE ${whereSql} LIMIT 1`).get(...key.fields.map((f) => keyVals[f]));
          const existingNorm = existing ? Object.fromEntries(Object.entries(existing).map(([k, v]) => [k, norm(v)])) : null;
          const keyH = keyHash(keyVals);
          const rec = writesByKey.get(keyH) || { keyHash: keyH, sheets: [], submits: [], writes: 0 };
          if (!rec.sheets.includes(submit.sheet)) rec.sheets.push(submit.sheet);
          if (!rec.submits.includes(submit.name)) rec.submits.push(submit.name);
          rec.writes += 1;
          writesByKey.set(keyH, rec);
          const isInsert = submit.submitType === 'insert' || !existingNorm;
          try {
            if (isInsert) {
              const fields = Object.keys(values);
              if (!fields.length) throw new Error('插入行没有可写字段');
              const sql = `INSERT INTO ${q(table)} (${fields.map(q).join(',')}) VALUES (${fields.map(() => '?').join(',')})`;
              runStatement(db, sql, fields.map((f) => values[f]));
              const last = lastValueByKey.get(keyH)?.values || null;
              if (last && JSON.stringify(last) !== JSON.stringify(values)) warnings.push({
                code: 'STALE_KEY_OVERWRITE', severity: 'warning', sheet: submit.sheet, submit: submit.name, keyHash: keyH,
                message: '同一主键被不同 sheet 以不同值写入；后写的 sheet 可能覆盖前一个 sheet 的新数据。',
              });
              lastValueByKey.set(keyH, { sheet: submit.sheet, values });
              sub.inserted += 1; stat.inserted += 1; statTable.inserted += 1; inserted += 1; writeEvents += 1;
            } else {
              const updates = [];
              for (const [f, v] of Object.entries(values)) {
                if (key.fields.includes(f)) continue;
                const col = (submit.columns || []).find((c) => String(c.field || '') === f);
                if (col?.skipUnmodified === true && existingNorm && JSON.stringify(existingNorm[f]) === JSON.stringify(v)) continue;
                updates.push(f);
              }
              if (!updates.length) {
                sub.unchanged += 1; stat.unchanged += 1; statTable.unchanged += 1; unchanged += 1;
              } else {
                const setSql = updates.map((f) => `${q(f)} = ?`).join(', ');
                runStatement(db, `UPDATE ${q(table)} SET ${setSql} WHERE ${whereSql}`, [...updates.map((f) => values[f]), ...key.fields.map((f) => keyVals[f])]);
                const prev = lastValueByKey.get(keyH);
                if (prev && prev.sheet !== submit.sheet && JSON.stringify(prev.values) !== JSON.stringify(values)) {
                  warnings.push({
                    code: 'STALE_KEY_OVERWRITE', severity: 'warning', sheet: submit.sheet, submit: submit.name, keyHash: keyH,
                    message: `主键被 sheet「${prev.sheet}」先写、又被 sheet「${submit.sheet}」以不同值覆盖；请核对是否把旧 sheet 的旧行也提交了。`,
                  });
                }
                lastValueByKey.set(keyH, { sheet: submit.sheet, values });
                sub.updated += 1; stat.updated += 1; statTable.updated += 1; updated += 1; writeEvents += 1;
              }
            }
          } catch (e) {
            sub.errors += 1; stat.errors += 1; statTable.errors += 1; errors += 1;
            warnings.push({ code: 'SIM_WRITE_FAILED', severity: 'warning', table, sheet: submit.sheet, submit: submit.name, message: `试写失败（该行已跳过）：${e.message}` });
          }
        }
        if (hasCondition && condMissing > 0) {
          sub.conditionSkipped = true;
          warnings.push({ code: 'CONDITION_NOT_EVALUATED', severity: 'info', table, sheet: submit.sheet, submit: submit.name, message: `${condMissing} 行未提供 __condition，已按“通过”模拟；实际 FR 提交条件（${submit.condition?.formula || submit.conditionClass}）可能过滤掉部分行。` });
        }
        sub.eligible = sub.eligible;
      }
    }
    // after 行数在事务内、rollback 之前取
    for (const t of tableStats.values()) t.afterRows = tableCount(db, t.table);
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* ignore */ }
    rolledBack = true;
    throw e;
  } finally {
    if (!rolledBack) { try { db.exec('ROLLBACK'); } catch { /* ignore */ } rolledBack = true; }
    closeLocalDb(db);
  }

  const staleKeys = [...writesByKey.values()]
    .filter((r) => r.sheets.length > 1)
    .sort((a, b) => b.writes - a.writes)
    .slice(0, 20)
    .map((r) => ({ keyHash: r.keyHash, sheets: r.sheets, submits: r.submits, writes: r.writes }));
  const overwritten = warnings.filter((w) => w.code === 'STALE_KEY_OVERWRITE').length;
  if (staleKeys.length) {
    warnings.push({
      code: 'FILL_STALE_ROW_RISK', severity: 'warning',
      message: `${staleKeys.length} 个主键被多个 sheet 写入；如果其中包含另一个 sheet 的旧行，提交后可能把新数据覆盖回旧值。`,
    });
  }
  return {
    ok: true,
    db: dbName,
    path: cptPath,
    mode,
    repeat,
    rolledBack: true,
    elapsedMs: Date.now() - startedAt,
    totals: {
      sheets: sheetStats.size,
      submissions: submissions.length,
      scenarioRows: scenarioRows.length,
      eligible: submissions.reduce((n, s) => n + s.eligible, 0),
      inserted,
      updated,
      unchanged,
      skipped,
      errors,
      writeEvents,
      staleKeys: staleKeys.length,
      overwrittenKeys: overwritten,
    },
    sheets: [...sheetStats.values()].sort((a, b) => String(a.sheet).localeCompare(String(b.sheet))),
    submissions,
    tables: [...tableStats.values()].map((t) => ({ ...t, delta: typeof t.beforeRows === 'number' && typeof t.afterRows === 'number' ? t.afterRows - t.beforeRows : null })),
    staleKeys,
    warnings,
  };
}
