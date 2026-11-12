// cpt-mcp/test/float-element.test.js —— 浮动元素（add_float_element）与真实引擎校验报告查询
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createCpt, addStyle, addFloatElement, addCell, addSheet } from '../lib/generate.js';
import { validateCpt } from '../lib/validate.js';
import { overview } from '../lib/cpt.js';
import { engineCheckReport } from '../lib/fr-engine-report.js';
import '../scripts/isolate-store.mjs'; // M123：JS 基线 store 隔离，直跑也不污染真实 store
// 回归 hermetic 前置：外部 CPT_MCP_ALLOWED_ROOTS（如 DSH 会话级目录限制）会改变默认允许根，
// engineCheckReport 要过路径围栏；以下断言测的是默认行为，先恢复默认再跑。
delete process.env.CPT_MCP_ALLOWED_ROOTS;

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-float-'));
const file = (name) => path.join(TMP, name);

test('add_float_element：官方最简形态（FloatElementList 置于 CellElementList 前）', () => {
  const p = file('float.cpt');
  createCpt(p, { rows: 4, columns: 4 });
  addStyle(p, { fontSizePt: 20, bold: true });
  const r = addFloatElement(p, { content: '29%', styleIndex: 0, leftMm: 30, topMm: 20, widthMm: 25, heightMm: 15 });
  assert.match(r.name, /^Float\d+$/);
  const raw = fs.readFileSync(p, 'utf8');
  const list = raw.match(/<FloatElementList>[\s\S]*<\/FloatElementList>/)?.[0];
  assert.ok(list, '应生成 FloatElementList');
  assert.ok(raw.indexOf('<FloatElementList>') < raw.indexOf('<CellElementList'), 'FloatElementList 在 CellElementList 之前');
  // 官方实例（demo/Chart/DataVisualization/数据可视化.cpt）的最简骨架逐标签对齐
  for (const tag of ['<com.fr.report.cell.FloatElement>', '<FloatElementName name=', '<PrivilegeControl/>', '<Location leftDistance=', '<Style index="0"/>']) {
    assert.ok(list.includes(tag), `浮动元素骨架缺少 ${tag}`);
  }
  assert.ok(list.includes('leftDistance="4320000"'), '30mm 应换算为 4320000 单位（1mm=144000）');
  assert.ok(list.includes('<![CDATA[29%]]>'));
  // 校验器无新增 error
  assert.equal(validateCpt(p).filter((i) => i.severity === 'error').length, 0);
  assert.equal(overview(p).floatElements, 1);
});

test('add_float_element：同一工作表第二次调用复用已有 FloatElementList，名称自动递增', () => {
  const p = file('float2.cpt');
  createCpt(p, { rows: 4, columns: 4 });
  const a = addFloatElement(p, { content: 'A', styleIndex: 0 });
  const b = addFloatElement(p, { content: 'B', styleIndex: 0 });
  assert.notEqual(a.name, b.name);
  const raw = fs.readFileSync(p, 'utf8');
  assert.equal(raw.match(/<FloatElementList>/g).length, 1, '不重复创建 FloatElementList');
  assert.equal(overview(p).floatElements, 2);
});

test('add_float_element：多工作表落到指定 sheet；显式命名按 sheet 查重', () => {
  const p = file('float3.cpt');
  createCpt(p, { rows: 4, columns: 4 });
  addSheet(p, { sheetName: 'sheet2' });
  const a = addFloatElement(p, { content: '首页标语', styleIndex: 0, name: '标语' });
  const b = addFloatElement(p, { content: '第二页标语', styleIndex: 0, sheet: 'sheet2', name: '标语' });
  assert.equal(a.name, '标语');
  assert.equal(b.name, '标语');
  // 同 sheet 重名拒绝，不同 sheet 允许
  assert.throws(() => addFloatElement(p, { content: 'x', styleIndex: 0, name: '标语' }), /已存在/);
  assert.doesNotThrow(() => addFloatElement(p, { content: 'x', styleIndex: 0, sheet: 'sheet2', name: '标语2' }));
});

test('add_float_element：围栏（空内容/越界样式/非法位置/CDATA 注入）', () => {
  const p = file('float4.cpt');
  createCpt(p, { rows: 4, columns: 4 });
  addStyle(p, {});
  assert.throws(() => addFloatElement(p, { content: '  ', styleIndex: 0 }), /内容不能为空/);
  assert.throws(() => addFloatElement(p, { content: 'x', styleIndex: 5 }), /越界/);
  assert.throws(() => addFloatElement(p, { content: 'x', styleIndex: 0, leftMm: -3 }), /leftMm/);
  assert.throws(() => addFloatElement(p, { content: 'x', styleIndex: 0, widthMm: 0 }), /widthMm/);
  assert.throws(() => addFloatElement(p, { content: 'a]]><evil/>b', styleIndex: 0 }), /CDATA/);
  // 未创建过 FloatElementList 的模板，validate 依旧 0 error（位置均为合法默认值）
  const p2 = file('float5.cpt');
  createCpt(p2, { rows: 4, columns: 4 });
  addCell(p2, { column: 0, row: 0, content: 'ok', styleIndex: 0 });
  assert.equal(validateCpt(p2).filter((i) => i.severity === 'error').length, 0);
});

test('add_float_element：validate 捕捉手工写坏的样式索引与 Location', () => {
  const p = file('float6.cpt');
  createCpt(p, { rows: 4, columns: 4 });
  addFloatElement(p, { content: 'v', styleIndex: 0 });
  // 模拟外部写坏：样式索引越界 + 负 width
  let raw = fs.readFileSync(p, 'utf8');
  raw = raw.replace('<Style index="0"/>', '<Style index="42"/>')
    .replace(/width="\d+"/, 'width="-1"');
  fs.writeFileSync(p, raw);
  const issues = validateCpt(p).filter((i) => i.severity === 'error');
  assert.ok(issues.some((i) => i.message.includes('样式索引')), '应报浮动元素样式索引越界');
  assert.ok(issues.some((i) => i.message.includes('width')), '应报 Location.width 非法');
});

test('engineCheckReport：not-run / pass / stale / 路径围栏', () => {
  const p = file('report.cpt');
  createCpt(p, { rows: 2, columns: 2 });
  // not-run
  assert.equal(engineCheckReport(p).status, 'not-run');
  assert.match(engineCheckReport(p).howToRun, /verify:fr/);
  // pass（模拟 verify:fr 落盘）
  const dir = path.join(path.dirname(p), '.fr-engine-check');
  fs.mkdirSync(dir, { recursive: true });
  const reportPath = path.join(dir, `${path.basename(p)}.json`);
  fs.writeFileSync(reportPath, JSON.stringify({ cpt: p, status: 'pass', roundTrip: true, checkedAt: new Date().toISOString() }));
  const pass = engineCheckReport(p);
  assert.equal(pass.status, 'pass');
  assert.equal(pass.ok, true);
  // stale：模板比报告新
  const future = new Date(Date.now() + 5000);
  fs.utimesSync(p, future, future);
  assert.equal(engineCheckReport(p).status, 'stale');
  // 围栏：CPT 不存在 / 越出允许根
  assert.equal(engineCheckReport(file('nope.cpt')).status, 'cpt-not-found');
  if (process.platform === 'win32') {
    assert.throws(() => engineCheckReport('Q:/outside/x.cpt'), /安全围栏|允许目录/);
  }
});
