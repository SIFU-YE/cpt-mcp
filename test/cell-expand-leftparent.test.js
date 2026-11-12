// test/cell-expand-leftparent.test.js —— M114「左父格=无」
//
// 背景（能力缺口，sandbox7 字典转隐藏列改造规格 §7 报出并核实）：
//   设计器可以把某格的**左父格点成「无」**，落盘形态是 <Expand dir="0" leftParentDefault="false"/>
//   —— 有 leftParentDefault="false" 但**没有 left 属性**。语义：该格不再把左邻当父格，
//   按自身 dsColumn 独立向下展开，用来在同一行里打断"默认串联"，让多组数据集各自成块。
//   官方 1550 份样本里该形态有 **337 例**；"同排 ≥2 个无左父格的向下扩展根"有 811 例
//   （典型：demo/analytics/financial/利润结构分析.cpt 第 7 行，c2/c3/c5 绑 ds4、
//    c6/c7 静态分隔、c10 绑 ds5.项目 且 leftParentDefault="false"、c13/c14 绑 ds5 其余列）。
//
//   M114 之前 cpt-mcp 写不出这个形态：expand.leftParent 只接受单元格引用（^[A-Za-z]{1,3}\d+$），
//   缺省/空串落到 <Expand/>（= "默认跟随左邻"，**完全不同的语义**），传 "none" 直接抛错。
//   于是在需要"同排多组数据集"时必须人工开设计器点一下——这正是本轮补的洞。
//
// 本文件锁定三态互不串味，且形态与官方字节一致。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCpt, addDataset, addStyle, addCell, expandXml, isNoLeftParent } from '../lib/generate.js';
import { cells } from '../lib/cpt.js';
import '../scripts/isolate-store.mjs'; // M123：JS 基线 store 隔离，直跑也不污染真实 store

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-lp-'));

test('M114 expandXml：左父格三态各自成形态，互不串味', () => {
  // ① 缺省 = 默认跟随左邻
  assert.equal(expandXml({ dir: 0 }, 'dsColumn'), '<Expand dir="0"/>');
  assert.equal(expandXml({}, 'dsColumn'), '<Expand/>');
  assert.equal(expandXml({ dir: 0, leftParent: '' }, 'dsColumn'), '<Expand dir="0"/>', '空串仍视为"不指定"（向后兼容）');

  // ② 引用 = 显式指向某格
  assert.equal(expandXml({ dir: 0, leftParent: 'A2' }, 'dsColumn'), '<Expand dir="0" leftParentDefault="false" left="A2"/>');
  assert.equal(expandXml({ dir: 0, leftParent: 'b3' }, 'dsColumn'), '<Expand dir="0" leftParentDefault="false" left="B3"/>', '引用应大写归一');

  // ③ 「无」= 显式 leftParentDefault="false" 且无 left —— 与官方字节完全一致
  const OFFICIAL = '<Expand dir="0" leftParentDefault="false"/>';
  assert.equal(expandXml({ dir: 0, leftParent: 'none' }, 'dsColumn'), OFFICIAL);
  assert.equal(expandXml({ dir: 0, leftParent: true }, 'dsColumn'), OFFICIAL);
  assert.equal(expandXml({ dir: 0, leftParent: '无' }, 'dsColumn'), OFFICIAL);
  assert.equal(expandXml({ dir: 0, leftParent: 'none' }, 'dsColumn'), OFFICIAL);

  // 非法引用仍被拒，且错误文案要告知 "none" 这条出路（否则模型只会看到"须为引用"）
  assert.throws(() => expandXml({ dir: 0, leftParent: 'bogus' }, 'dsColumn'), /须为单元格引用/);
  assert.throws(() => expandXml({ dir: 0, leftParent: 'bogus' }, 'dsColumn'), /none/, '报错应提示 "none" 写法');
});

test('M114 isNoLeftParent：归一化只认显式"无"，不误吞引用与空值', () => {
  for (const v of [true, 'none', 'NONE', ' none ', '无', 'null']) assert.equal(isNoLeftParent(v), true, `${JSON.stringify(v)} 应判为"无"`);
  for (const v of [false, undefined, null, '', 'A2', '0', 'nan', 1]) assert.equal(isNoLeftParent(v), false, `${JSON.stringify(v)} 不应判为"无"`);
});

test('M114 端到端：同排两组数据集各成块，第二组首格写出「左父格=无」且可读回', () => {
  const d = tmp();
  const p = path.join(d, 'R1.cpt');
  createCpt(p, { rows: 4, columns: 12, webWrite: true });
  addDataset(p, { name: 'ds_daily', connection: 'Doris', sql: 'SELECT a,b FROM t1' });
  addDataset(p, { name: 'ds_config', connection: 'Doris', sql: 'SELECT c,d FROM t2' });
  addStyle(p, { fontSizePt: 12 });

  // 第一组 ds_daily：默认串联
  addCell(p, { column: 0, row: 1, contentType: 'dsColumn', dsName: 'ds_daily', columnName: 'a', styleIndex: 1, expand: { dir: 0 } });
  addCell(p, { column: 1, row: 1, contentType: 'dsColumn', dsName: 'ds_daily', columnName: 'b', styleIndex: 1, expand: { dir: 0 } });
  // 静态分隔格
  addCell(p, { column: 3, row: 1, content: '', styleIndex: 1 });
  // 第二组 ds_config：首格显式「无」左父格（打断串联），其余列默认跟随本组首格
  addCell(p, { column: 9, row: 1, contentType: 'dsColumn', dsName: 'ds_config', columnName: 'c', styleIndex: 1, expand: { dir: 0, leftParent: 'none' } });
  addCell(p, { column: 10, row: 1, contentType: 'dsColumn', dsName: 'ds_config', columnName: 'd', styleIndex: 1, expand: { dir: 0 } });

  const raw = fs.readFileSync(p, 'utf8');
  const all = [...raw.matchAll(/<Expand\b([^>]*?)\s*\/>/g)].map((m) => m[1]);
  const noneForm = all.filter((a) => /leftParentDefault="false"/.test(a) && !/\bleft=/.test(a));
  assert.equal(noneForm.length, 1, `应恰有 1 处「左父格=无」，实际 ${noneForm.length}：${JSON.stringify(all)}`);
  assert.equal(`<Expand${noneForm[0]}/>`, '<Expand dir="0" leftParentDefault="false"/>', '字节形态应与官方 demo 一致');

  // 读侧能报出该状态：leftParentDefault="false" 且 expandLeft=null
  const list = cells(p).filter((c) => c.row === 1);
  const c9 = list.find((c) => c.column === 9);
  assert.equal(c9.expandLeft, null, '「左父格=无」不应有 left');
  assert.equal(c9.expandLeftParentDefault, 'false', '应报出 leftParentDefault=false');
  assert.equal(c9.expandDir, 0);
  // 对照组：默认串联的格既无 left 也无 leftParentDefault —— 两种"没有 left"必须能区分
  const c10 = list.find((c) => c.column === 10);
  assert.equal(c10.expandLeft, null);
  assert.equal(c10.expandLeftParentDefault, null, '默认形态与「无」形态靠 leftParentDefault 区分');
  fs.rmSync(d, { recursive: true, force: true });
});

test('M114 build_report 路径同源：spec.expand.leftParent 也接受 "none"', async () => {
  const { buildReportSpecSchema } = await import('../lib/engine/spec.js');
  // zod v4 的嵌套略绕：cells(optional) → array → element(object) → expand(optional) → object
  const cellsSchema = buildReportSpecSchema._zod.def.shape.cells;
  const arr = (cellsSchema._zod.def.innerType ?? cellsSchema)._zod.def;
  const cellShape = (arr.element ?? arr.innerType)._zod.def.shape;
  const expandInner = cellShape.expand._zod.def.innerType ?? cellShape.expand;
  const expandShape = expandInner._zod.def.shape;

  // 两条路径必须都能表达同一形态，否则从 build_report 建表时缺口依旧
  const { expandXml } = await import('../lib/generate.js');
  assert.equal(expandXml({ dir: 0, leftParent: 'none' }, 'dsColumn'), expandXml({ dir: 0, leftParent: true }, 'dsColumn'));

  // spec 路径的 leftParent 必须是 union(string|boolean)：只收 string 时 "none" 能过但 true 不能，
  // 而 add_cell 路径收 union —— 两条路径必须能表达同一个形态（zod v4 把 optional 包在 union 外层）
  const lpOuter = expandShape.leftParent;
  const lpT = lpOuter._zod?.def?.type;
  assert.equal(lpT, 'optional', `spec.expand.leftParent 应为 optional（实际 ${lpT}）`);
  const lp = lpOuter._zod.def.innerType;
  assert.equal(lp._zod.def.type, 'union', `optional 内层应为 union(string|boolean)（实际 ${lp._zod.def.type}），否则与 add_cell 路径不同源`);
  const opts = (lp._zod.def.options ?? []).map((o) => o._zod.def.type);
  assert.deepEqual(opts.sort(), ['boolean', 'string'], '应同时接受字符串引用/none 与布尔 true');
});

test('M114 build_report 的自动推导不会覆盖显式「无」（不静默改写用户意图）', async () => {
  const { autoExpandCells } = await import('../lib/engine/builder.js');
  const out = autoExpandCells([
    { column: 0, row: 1, contentType: 'dsColumn', dsName: 'd1', columnName: 'a' },
    { column: 1, row: 1, contentType: 'dsColumn', dsName: 'd1', columnName: 'b' },
    { column: 9, row: 1, contentType: 'dsColumn', dsName: 'd2', columnName: 'c', expand: { dir: 0, leftParent: 'none' } },
    { column: 10, row: 1, contentType: 'dsColumn', dsName: 'd2', columnName: 'd' },
  ]);
  const c9 = out.cells.find((c) => c.column === 9);
  assert.deepEqual(c9.expand, { dir: 0, leftParent: 'none' }, '显式 expand 必须原样保留（autoExpandCells 只对未指定的格推导）');
  const applied9 = out.applied.find((a) => a.cell === 'J2');
  assert.equal(applied9, undefined, 'j2 已有显式 expand，不应被补 leftParent');
});
