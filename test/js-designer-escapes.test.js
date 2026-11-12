// test/js-designer-escapes.test.js —— C-B：设计器转义 `]A` 的模型可见元数据
//
// 【缺陷证据·2026-11-03 会话审计】sandbox4 会话 10-27 / 10-31 / 11-03 反复出现同一误判：模型把读回的
// `]A` 当"残字符污染"并据此改动模板；11-03 10:56 session-de4f833e 用户第 3 次纠正"A 是设计器自带的
// 标记语言不会影响代码正常运行"（历史见 docs/session-capability-audit-2026-10-31.md 的 G1）。
//
// 口径（M116 已定案，勿回退）：`]A` 是 FR 设计器对 `]` 的落盘转义 —— 官方 1550 份语料里 237 个 `]`
// 100% 都是 `]A` 形态，原文喂 V8 失败 55 块、解码后 0 块。因此：
//   · **读回原文保持不变**（js 字段仍是 CDATA 原文，可与文件逐字节对账）；
//   · 读工具只在 count>0 时附 designerEscapes 元数据 + 固定提示（无标记零 token 增长）；
//   · check_report_js 额外返回 designerMarkers 计数，并说明"解析前已解码"。
// 本文件同时锁住"字段是有标记才出现"与"计数正确"两面，避免提示退化成噪声或消失。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCpt, addCell } from '../lib/generate.js';
import {
  setReportListener, setWebWriteJs, setCellListener, addCellHyperlink,
} from '../lib/edits.js';
import {
  cells, reportListener, webwriteListener, checkReportJs,
  countDesignerEscapes, designerEscapesMeta, aggregateDesignerEscapes,
} from '../lib/cpt.js';
import { getCellListener, getCellHyperlink } from '../lib/edits.js';
import { getReportListenerBatch } from '../lib/batch.js';
import { CPT_MCP_INSTRUCTIONS } from '../lib/contract.js';
import '../scripts/isolate-store.mjs';

// 官方形态：`]` 100% 写作 `]A`（连字符串里的 `]` 也一样，设计器转义是全局的）
const WB_JS = 'var C = F.COLS[si]A;\nconsole.log("[审批]A 完成");'; // 2 个标记
const REP_JS = 'var ks = rows[0]A;'; // 1 个
const CELL_JS = 'this.value = map[key]A;'; // 1 个
const HL_JS = 'var picked = list[idx]A;'; // 1 个

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-esc-'));
const read = (p) => fs.readFileSync(p, 'utf8');

/** 造一个各出口都带 `]A` 的模板 */
function seedEscaped(p) {
  createCpt(p, { rows: 4, columns: 4, webWrite: true });
  addCell(p, { column: 0, row: 0, content: 'X' });
  addCell(p, { column: 1, row: 0, content: 'Y' });
  setWebWriteJs(p, { event: 'afterload', js: WB_JS });
  setReportListener(p, { event: 'afterload', js: REP_JS, sheet: 0 });
  setCellListener(p, 0, 0, { event: 'click', js: CELL_JS });
  addCellHyperlink(p, { column: 1, row: 0, type: 'script', script: HL_JS });
}

test('C-B 单元：countDesignerEscapes / designerEscapesMeta / aggregateDesignerEscapes', () => {
  assert.equal(countDesignerEscapes('var a = []A;'), 1);
  assert.equal(countDesignerEscapes('m[1]A + m[2]A'), 2);
  assert.equal(countDesignerEscapes('var a = [1,2];'), 0, '普通 ] 不是标记');
  assert.equal(countDesignerEscapes(null), 0);
  assert.equal(countDesignerEscapes(undefined), 0);
  // 只有标记才返回元数据（无标记返回 null → 调用方不合并该字段，零 token 增长）
  assert.equal(designerEscapesMeta('var a = [1];'), null);
  const meta = designerEscapesMeta('var a = []A;');
  assert.equal(meta.marker, ']A');
  assert.equal(meta.count, 1);
  assert.match(meta.hint, /设计器对 .* 的转义|转义/);
  assert.match(meta.hint, /不是污染/);
  const agg = aggregateDesignerEscapes(['var a = []A;', 'var b = 1;', 'm[2]A']);
  assert.equal(agg.count, 2);
  assert.equal(agg.blocks, 2, '只数含标记的块');
  assert.equal(aggregateDesignerEscapes(['var b = 1;']), null);
});

test('C-B 读回原文不变 + designerEscapes 计数正确（全部 JS 读出口）', async () => {
  const d = tmp();
  try {
    const p = path.join(d, 'esc.cpt');
    seedEscaped(p);

    // ① get_webwrite_js：原文逐字节一致，元数据 2 个标记
    const wb = webwriteListener(p, { event: 'afterload' });
    assert.equal(wb.listeners[0].js, WB_JS, '读回原文必须不变（不能把 ]A 解成 ]）');
    assert.equal(wb.designerEscapes.count, 2);
    assert.equal(wb.designerEscapes.marker, ']A');
    assert.match(wb.designerEscapes.hint, /设计器/, '必须带固定提示，避免模型再当污染');

    // ② get_report_listener（含分页：计数恒按全文）
    const rl = reportListener(p, { event: 'afterload' });
    assert.equal(rl.listeners[0].js, REP_JS);
    assert.equal(rl.designerEscapes.count, 1);
    const paged = reportListener(p, { event: 'afterload', jsOffset: 0, jsLimit: 5 });
    assert.equal(paged.listeners[0].js, REP_JS.slice(0, 5), '分页切片照旧');
    assert.equal(paged.designerEscapes.count, 1, '分页不改变标记计数（恒指全文）');

    // ③ get_cell_listener
    const cl = getCellListener(p, 0, 0, { event: 'click' });
    assert.equal(cl.listeners[0].js, CELL_JS);
    assert.equal(cl.designerEscapes.count, 1);

    // ④ get_cells 的单元格监听器（数组型出口：按项附元数据）
    const cell = cells(p).find((c) => c.column === 0 && c.row === 0);
    const item = cell.listeners.find((x) => x.event === 'click');
    assert.equal(item.js, CELL_JS);
    assert.equal(item.designerEscapes.count, 1);

    // ⑤ get_cell_hyperlink 的 script
    const hl = getCellHyperlink(p, 1, 0);
    assert.equal(hl.hyperlinks[0].script, HL_JS);
    assert.equal(hl.designerEscapes.count, 1);

    // ⑥ 批量出口 get_report_listener_batch（data 里同样带元数据）
    const batch = await getReportListenerBatch(p, [{ event: 'afterload' }]);
    assert.equal(batch.results[0].data.listeners[0].js, REP_JS);
    assert.equal(batch.results[0].data.designerEscapes.count, 1);
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test('C-B 无标记时不出现 designerEscapes（零标记零 token，普通 ] 不算标记）', () => {
  const d = tmp();
  try {
    const p = path.join(d, 'plain.cpt');
    createCpt(p, { rows: 3, columns: 3, webWrite: true });
    addCell(p, { column: 0, row: 0, content: 'X' });
    setWebWriteJs(p, { event: 'afterload', js: 'var a = [1,2]; var b = F.COLS[0];' });
    setReportListener(p, { event: 'afterload', js: 'var c = rows[0];', sheet: 0 });
    setCellListener(p, 0, 0, { event: 'click', js: 'var d = m[k];' });
    const wb = webwriteListener(p, { event: 'afterload' });
    assert.equal(Object.hasOwn(wb, 'designerEscapes'), false, '无标记不得出现该字段（避免 token 增长）');
    assert.equal(Object.hasOwn(reportListener(p, { event: 'afterload' }), 'designerEscapes'), false);
    assert.equal(Object.hasOwn(getCellListener(p, 0, 0, { event: 'click' }), 'designerEscapes'), false);
    const item = cells(p).find((c) => c.column === 0 && c.row === 0).listeners[0];
    assert.equal(Object.hasOwn(item, 'designerEscapes'), false);
    // 填空清单模式不返回 JS 正文 → 也不报标记元数据
    const listing = webwriteListener(p);
    assert.equal(Object.hasOwn(listing, 'designerEscapes'), false, '清单模式不返回正文，不附元数据');
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test('C-B check_report_js：designerMarkers 统计 + 解析前已解码（不判语法错）', () => {
  const d = tmp();
  try {
    const p = path.join(d, 'esc-chk.cpt');
    seedEscaped(p);
    const chk = checkReportJs(p);
    assert.equal(chk.failed, 0, `解码后这些块都应是合法 JS：${JSON.stringify(chk.failures)}`);
    assert.equal(chk.designerMarkers.total, 5, `4 个出口合计 5 个标记：${JSON.stringify(chk.designerMarkers)}`);
    assert.equal(chk.designerMarkers.blocksWithMarkers, 4);
    assert.match(chk.hint, /已解码/, 'hint 必须说明"解析前已解码"');
    assert.match(chk.hint, /不是缺陷/);

    // 无标记模板：字段不出现（不占 token）
    const p2 = path.join(d, 'plain-chk.cpt');
    createCpt(p2, { rows: 2, columns: 2 });
    addCell(p2, { column: 0, row: 0, content: 'Z' });
    setCellListener(p2, 0, 0, { event: 'click', js: 'var x = [1];' });
    const chk2 = checkReportJs(p2);
    assert.equal(Object.hasOwn(chk2, 'designerMarkers'), false);
    assert.doesNotMatch(chk2.hint, /已解码/);
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test('C-B 契约层：instructions 有 `]A` 铁律（模型动手前就能看到）', () => {
  assert.match(CPT_MCP_INSTRUCTIONS, /设计器对 `]` 的转义/, '铁律应写明 ]A 是设计器转义');
  assert.match(CPT_MCP_INSTRUCTIONS, /不是污染\/残字符/, '铁律应明确不是污染');
  assert.match(CPT_MCP_INSTRUCTIONS, /designerEscapes/, '铁律应指向读工具元数据');
  assert.match(CPT_MCP_INSTRUCTIONS, /designerMarkers/, '铁律应指向 check_report_js 计数');
});
