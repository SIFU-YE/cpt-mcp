// cpt-mcp/lib/embedded.js —— 单元格内嵌提交（Commit2DBJavaScript）的定位与解析
//
// 背景（新品表实测 2026-10-23）：FineReport 里「按钮点一下提交入库」的官方形态是
// 单元格 Widget（FreeButton）+ Listener 事件，其 <JavaScript class="com.fr.js.Commit2DBJavaScript">
// 内部可以内嵌**一套或多套**提交配置：
//
//   <JavaScript class="com.fr.js.Commit2DBJavaScript">
//     <Parameters/>
//     <Attributes dsName="填报-读写" name="提交2"/>          ← 第 1 套提交的名字
//     <DMLConfig class="com.fr.write.config.IntelliDMLConfig">
//       <Table schema="" name="bas_new_product_mechanism"/>
//       <ColumnConfig name="sku_code" isKey="true" ...><ColumnRow column="1" row="1"/></ColumnConfig>
//       ...
//       <Condition class="com.fr.data.condition.ListCondition"/>
//     </DMLConfig>
//     <Attributes dsName="填报-读写" name="提交3"/>          ← 第 2 套
//     <DMLConfig ...>...</DMLConfig>
//     <JavaScript class="com.fr.js.JavaScriptImpl">          ← 提交后的回调 JS（fr_submitinfo.*）
//       <Content><![CDATA[...]]></Content>
//     </JavaScript>
//   </JavaScript>
//
// 这类提交**不在** ReportWriteAttr 下，因此：
//   · update_fill_binding（只认 <SubmitVisitor>）看不到、也改不到；
//   · update_cell_listener 按整个 <Listener> 块替换，会静默删掉内嵌的 DMLConfig
//     （实测 4 套 → 2 套，validate 也不报错）。
// 本模块只做「文本锚点定位 + DMLConfig 解析」，读侧(cpt.js)与写侧(edits.js)共用。

import { findAll, blockRange, replaceAttr, sheetBlocks } from './xml.js';

export const COMMIT2DB_CLASS = 'com.fr.js.Commit2DBJavaScript';

/** 取标签属性值（未转义处理：这里只用于 name/class/column 等简单值） */
function attrOf(head, name) {
  const m = String(head).match(new RegExp(`\\b${name}="([^"]*)"`));
  return m ? m[1] : null;
}

/** 取 CDATA 正文；无 CDATA 时取标签内文本 */
function cdataOf(s) {
  const m = String(s).match(/<!\[CDATA\[([\s\S]*?)\]\]>/);
  return m ? m[1] : String(s).trim();
}

/** 绝对偏移 → 所属工作表索引与单元格坐标（输出用；定位失败给 null） */
function locateOwner(raw, offset) {
  let sheet = null;
  let cell = null;
  try {
    const sheets = sheetBlocks(raw);
    for (let i = 0; i < sheets.length; i += 1) {
      if (offset >= sheets[i].start && offset < sheets[i].end) { sheet = i; break; }
    }
    if (sheet != null) {
      // <C c="31" r="1"> —— 注意别误匹配 <CellElementList/<ColumnRow/<Condition 等
      const seg = raw.slice(sheets[sheet].start, offset);
      const re = /<C(?=[\s>])([^>]*)>/g;
      let m;
      let last = null;
      while ((m = re.exec(seg)) !== null) last = m;
      if (last) {
        const column = Number(attrOf(last[1], 'c'));
        const row = Number(attrOf(last[1], 'r'));
        if (Number.isInteger(column) && Number.isInteger(row)) cell = { column, row };
      }
    }
  } catch { /* 工作表结构异常：读侧降级，不影响调用方 */ }
  return { sheet, cell };
}

/** 解析一个 DMLConfig 块 → { table, schema, columns[], condition } */
function parseDml(dml) {
  const table = (dml.match(/<Table\b[^>]*\bname="([^"]*)"/) || [])[1] || null;
  const schema = (dml.match(/<Table\b[^>]*\bschema="([^"]*)"/) || [])[1] || null;
  const columns = [];
  const ccRe = /<ColumnConfig\b([^>]*)>/g;
  let cm;
  while ((cm = ccRe.exec(dml)) !== null) {
    const [cb, ce] = blockRange(dml, cm.index, '<ColumnConfig ', '</ColumnConfig>');
    const inner = dml.slice(cb, ce);
    const rowM = inner.match(/<ColumnRow\b([^>]*)\/>/);
    const constM = inner.match(/<O\b[^>]*>([\s\S]*?)<\/O>/);
    const pre = cm[1];
    columns.push({
      name: attrOf(pre, 'name'),
      isKey: attrOf(pre, 'isKey') === 'true',
      skipUnmodified: attrOf(pre, 'skipUnmodified') === 'true',
      column: rowM ? Number(attrOf(rowM[1], 'column')) : null,
      row: rowM ? Number(attrOf(rowM[1], 'row')) : null,
      constant: rowM ? null : (constM ? cdataOf(constM[1]) : null),
    });
    ccRe.lastIndex = ce;
  }
  const condM = dml.match(/<Condition\b[^>]*\/>/) || dml.match(/<Condition\b[\s\S]*?<\/Condition>/);
  return { table, schema, columns, condition: condM ? condM[0] : null };
}

/**
 * 扫描整份 cpt 的内嵌提交（Commit2DBJavaScript）。
 * @returns {Array<{start,end,sheet,cell,submits,callbackJsLength}>}
 */
export function scanEmbeddedCommits(raw) {
  const out = [];
  const re = /<JavaScript\b([^>]*)>/g;
  let m;
  while ((m = re.exec(raw)) !== null) {
    if (!String(m[1]).includes(COMMIT2DB_CLASS)) continue;
    const start = m.index;
    let b;
    let e;
    try {
      [b, e] = blockRange(raw, start, '<JavaScript ', '</JavaScript>');
    } catch {
      continue; // 结构损坏：交给 validate 报，不在这里抛
    }
    re.lastIndex = e; // 跳过块内嵌套的 <JavaScript class="...JavaScriptImpl">
    const block = raw.slice(b, e);
    const submits = [];
    const attrRe = /<Attributes\b([^>]*)\/>/g;
    let am;
    while ((am = attrRe.exec(block)) !== null) {
      const name = attrOf(am[1], 'name');
      if (!name) continue;
      const dmlIdx = block.indexOf('<DMLConfig', am.index + am[0].length);
      if (dmlIdx < 0) continue;
      let db;
      let de;
      try {
        [db, de] = blockRange(block, dmlIdx, '<DMLConfig ', '</DMLConfig>');
      } catch {
        continue;
      }
      const parsed = parseDml(block.slice(db, de));
      submits.push({
        name,
        dsName: attrOf(am[1], 'dsName'),
        table: parsed.table,
        schema: parsed.schema,
        columns: parsed.columns,
        condition: parsed.condition,
        // 绝对区间（写侧定向编辑用；读侧不展示）
        dmlStart: b + db,
        dmlEnd: b + de,
        openTag: block.slice(db, block.indexOf('>', db) + 1),
      });
      attrRe.lastIndex = de;
    }
    const cbM = block.match(/<JavaScript\b[^>]*class="com\.fr\.js\.JavaScriptImpl"[\s\S]*?<Content\b[^>]*>([\s\S]*?)<\/Content>/);
    const owner = locateOwner(raw, b);
    out.push({
      start: b,
      end: e,
      sheet: owner.sheet,
      cell: owner.cell,
      event: (raw.slice(Math.max(0, b - 400), b).match(/<Listener\b[^>]*\bevent="([^"]*)"/g) || [])
        .map((s) => (s.match(/event="([^"]*)"/) || [])[1]).pop() || null,
      submits,
      submitCount: submits.length,
      callbackJsLength: cbM ? cdataOf(cbM[1]).length : 0,
    });
  }
  return out;
}

/** 读侧对外形状：去掉内部绝对区间与开放标签，只留可读信息 */
export function publicEmbeddedCommits(raw) {  return scanEmbeddedCommits(raw).map((c) => ({
    sheet: c.sheet,
    cell: c.cell,
    cellRef: c.cell ? `${colName(c.cell.column)}${c.cell.row + 1}` : null,
    event: c.event,
    submitCount: c.submitCount,
    callbackJsLength: c.callbackJsLength,
    submits: c.submits.map((s) => ({
      name: s.name,
      dsName: s.dsName,
      table: s.table,
      columnCount: s.columns.length,
      columns: s.columns,
    })),
  }));
}

/** 扫描报表级提交（ReportWriteAttr 下的 <SubmitVisitor>，与 fill_config 同一口径，只取表/字段） */
export function scanReportSubmits(raw) {
  const out = [];
  for (const s of findAll(raw, '<SubmitVisitor')) {
    let block;
    try { block = blockRange(raw, s, '<SubmitVisitor', '</SubmitVisitor>'); } catch { continue; }
    const seg = raw.slice(block[0], block[1]);
    const head = seg.slice(0, 300);
    const name = (head.match(/<Attributes\b[^>]*\bname="([^"]*)"/) || [])[1] || null;
    const className = (head.match(/<SubmitVisitor\b[^>]*\bclass="([^"]*)"/) || [])[1] || null;
    const di = seg.indexOf('<DMLConfig');
    if (di < 0) {
      out.push({ index: out.length, name, className, table: null, columns: [] });
      continue;
    }
    let db;
    let de;
    try { [db, de] = blockRange(seg, di, '<DMLConfig ', '</DMLConfig>'); } catch { continue; }
    const parsed = parseDml(seg.slice(db, de));
    out.push({ index: out.length, name, className, table: parsed.table, schema: parsed.schema, columns: parsed.columns });
  }
  return out;
}

/**
 * 内嵌提交 vs 报表级提交的「近表交叉核对」。
 * 现实里同一份逻辑数据常被写成两个表名（如 mechanism_summary 与 mechanism_summary_pashe，
 * 或主表和分表），只按表名严格相等会漏掉真实的不一致（新品表 operation_record
 * 内嵌 c34 / 主提交 c29 就是这种）。判据：表名互相前缀 且 共享字段 ≥3 且列号有分歧。
 */
export function crossCheckEmbedded(raw) {
  const reportLevel = scanReportSubmits(raw);
  const embedded = scanEmbeddedCommits(raw);
  const result = [];
  for (const c of embedded) {
    for (const s of c.submits) {
      const here = new Map((s.columns || []).filter((x) => x.name && x.column != null).map((x) => [x.name, x.column]));
      const vs = [];
      for (const r of reportLevel) {
        if (!r.table || !s.table) continue;
        const near = r.table === s.table
          || (r.table.startsWith(s.table) && r.table !== s.table)
          || (s.table.startsWith(r.table) && s.table !== r.table);
        if (!near) continue;
        const there = new Map((r.columns || []).filter((x) => x.name && x.column != null).map((x) => [x.name, x.column]));
        const shared = [...here.keys()].filter((k) => there.has(k));
        if (shared.length < 3) continue;
        const diverged = shared.filter((k) => here.get(k) !== there.get(k))
          .map((k) => ({ field: k, embedded: here.get(k), reportLevel: there.get(k) }));
        if (diverged.length) {
          vs.push({
            reportLevelSubmit: r.name || `提交#${r.index + 1}`,
            reportLevelTable: r.table,
            embeddedTable: s.table,
            sharedFields: shared.length,
            diverged,
          });
        }
      }
      if (vs.length) result.push({ cell: c.cell, submit: s.name, vs });
    }
  }
  return result;
}

/** 0 起列号 → Excel 列名（31 → AF） */export function colName(column) {
  let n = Number(column);
  if (!Number.isInteger(n) || n < 0) return null;
  let s = '';
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
}

/** Excel 列名 → 0 起列号（AF → 31，支持多字母） */
export function colIndex(ref) {
  const s = String(ref || '').trim().toUpperCase();
  if (!/^[A-Z]+$/.test(s)) return null;
  let n = 0;
  for (const ch of s) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/**
 * 定位某一套内嵌提交；返回与该提交的 DMLConfig 绝对区间。
 * @param {{submit: string, cell?: {column:number,row:number}|string, sheet?: number}} sel
 */
export function locateEmbeddedSubmit(raw, sel = {}) {
  const all = scanEmbeddedCommits(raw);
  const wantName = sel.submit == null ? null : String(sel.submit).trim();
  const wantCell = normalizeCell(sel.cell);
  const wantSheet = sel.sheet == null ? null : Number(sel.sheet);
  const hits = [];
  for (const c of all) {
    if (wantSheet != null && c.sheet !== wantSheet) continue;
    if (wantCell && (!c.cell || c.cell.column !== wantCell.column || c.cell.row !== wantCell.row)) continue;
    for (const s of c.submits) {
      if (wantName && s.name !== wantName) continue;
      hits.push({ commit: c, submit: s });
    }
  }
  const avail = all.flatMap((c) => c.submits.map(
    (s) => `${s.name}@${c.cell ? `${colName(c.cell.column)}${c.cell.row + 1}` : '?'}（${s.table || '无表'}，${s.columns.length} 字段）`,
  ));
  if (hits.length === 0) {
    throw new Error(`定位失败：未找到内嵌提交${wantName ? ` "${wantName}"` : ''}`
      + `${wantCell ? ` 于单元格(${wantCell.column},${wantCell.row})` : ''}。`
      + `${avail.length ? `现有内嵌提交：${avail.join('、')}。` : '文档当前没有内嵌提交（Commit2DBJavaScript）。'}`
      + '纠正：名与单元格至少给一个，同名多处时必须再传 cell。可用 get_embedded_submits 查看清单。');
  }
  if (hits.length > 1) {
    throw new Error(`定位失败：内嵌提交 "${wantName || ''}" 命中 ${hits.length} 处（${hits
      .map((h) => h.commit.cell ? `${colName(h.commit.cell.column)}${h.commit.cell.row + 1}` : '?').join('、')}）。`
      + '纠正：请同时传 cell（{column,row} 或 "AF2"）以唯一定位。');
  }
  return { commit: hits[0].commit, submit: hits[0].submit };
}

/** 单元格选择子归一化：{column,row} / "AF2" / "31,1" / "AF" */
export function normalizeCell(cell) {
  if (cell == null) return null;
  if (typeof cell === 'object') {
    const column = Number(cell.column);
    const row = Number(cell.row);
    if (!Number.isInteger(column) || !Number.isInteger(row)) {
      throw new Error('cell 必须含整数 column 与 row（均从 0 起）');
    }
    return { column, row };
  }
  const s = String(cell).trim();
  const pair = s.match(/^(\d+)\s*[,:]\s*(\d+)$/);
  if (pair) return { column: Number(pair[1]), row: Number(pair[2]) };
  const a1 = s.match(/^([A-Za-z]+)(\d+)$/);
  if (a1) {
    const column = colIndex(a1[1]);
    if (column != null) return { column, row: Number(a1[2]) - 1 };
  }
  const onlyCol = colIndex(s);
  if (onlyCol != null) return { column: onlyCol, row: null };
  throw new Error(`cell 无法解析：${s}（支持 {column,row} / "AF2" / "31,1" / "AF"）`);
}

/** 生成一段 ColumnConfig（skipUnmodified 缺省 false） */
export function columnConfigXml({ name, column, row = 1, isKey = false, constant, skipUnmodified = false }) {
  const safeName = String(name);
  if (constant !== undefined && constant !== null) {
    return `<ColumnConfig name="${safeName}" isKey="${isKey}" skipUnmodified="${skipUnmodified}">\n`
      + `<O>\n<![CDATA[${String(constant)}]]></O>\n</ColumnConfig>`;
  }
  return `<ColumnConfig name="${safeName}" isKey="${isKey}" skipUnmodified="${skipUnmodified}">\n`
    + `<ColumnRow column="${column}" row="${row}"/>\n</ColumnConfig>`;
}

export { attrOf, cdataOf, parseDml, findAll };
