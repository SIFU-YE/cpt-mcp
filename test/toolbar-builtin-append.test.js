// test/toolbar-builtin-append.test.js —— 补缺口：往既有填报工具栏【追加】设计器内置按钮
//
// 背景（2026-10-17 实测复现）：给「9 按钮工具栏」（3 内置 + 6 自定义 JS 按钮）加一颗「导入Excel」，
//   · set_fill_toolbar 是【整栏重建】：只认词表 6 个内置按钮，传 ['submit','import-append'] 后
//     count 9→2，5 个分页自定义按钮 + 「导出全部」连同 JS 全部丢失（本轮跑 repro-toolbar-gap 实测）；
//   · add_toolbar_button 原先写死 CustomToolBarButton，建不出 ImExcelAppend 这类内置按钮。
//   → 会话只能交给设计器 GUI 手动加。本测试锁定新通道 add_toolbar_button({builtin}) 的语义：
//     只往 </ToolBar> 前追加一颗，栏内既有按钮字节原样保留；按 class 判重幂等。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createCpt } from '../lib/generate.js';
import { addToolbarButton, listToolbarButtons, setFillToolbar } from '../lib/edits.js';
import { validateCpt } from '../lib/validate.js';
import '../scripts/isolate-store.mjs'; // JS 基线 store 隔离

delete process.env.CPT_MCP_ALLOWED_ROOTS;

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-tbbuiltin-'));
const errCount = (v) => (Array.isArray(v) ? v : v.issues ?? []).filter((x) => x.severity === 'error').length;

/** 造一个「9 按钮」既有工具栏：3 内置 + 6 自定义（含 JS），对齐 sandbox14 v3 现状 */
function fixtureNine() {
  const d = tmp();
  const p = path.join(d, 'nine.cpt');
  createCpt(p, { rows: 4, columns: 4, webWrite: true });
  setFillToolbar(p, { buttons: ['append-row', 'delete-row', 'submit'] });
  for (const text of ['首页', '上一页', '页码跳转', '下一页', '末页', '导出全部']) {
    addToolbarButton(p, { buttonText: text, js: `var btn = "${text}"; _g().parameterCommit();` });
  }
  return { d, p };
}

const snapshot = (p) => listToolbarButtons(p).buttons.map((b) => `${b.class}|${b.text}|${b.hasJs}`);

test('缺口修复：builtin 追加内置按钮，既有 9 按钮（含自定义 JS）全部原样保留', () => {
  const { d, p } = fixtureNine();
  const before = snapshot(p);
  assert.equal(before.length, 9, '基线应为 9 个按钮');
  const rawBefore = fs.readFileSync(p, 'utf8');

  const r = addToolbarButton(p, { builtin: 'import-append' });
  assert.equal(r.mode, 'append');
  assert.equal(r.builtin, 'import-append');

  const after = snapshot(p);
  assert.equal(after.length, 10, `应 9→10，实际 ${after.length}`);
  assert.deepEqual(after.slice(0, 9), before, '既有 9 个按钮的 class/text/有无JS 必须逐个不变（顺序也不变）');
  assert.equal(after[9], 'com.fr.report.web.button.write.ImExcelAppend|${i18n(\'Fine-Engine_Excel_Import_Append\')}|false');

  // 既有自定义按钮的 JS 原文必须逐字保留（这是本通道的核心保证）
  const rawAfter = fs.readFileSync(p, 'utf8');
  for (const text of ['首页', '上一页', '页码跳转', '下一页', '末页', '导出全部']) {
    assert.ok(rawAfter.includes(`var btn = "${text}";`), `自定义按钮「${text}」的 JS 不应被动到`);
  }
  assert.ok(rawAfter.includes('class="com.fr.report.web.button.write.ImExcelAppend"'), '内置按钮已落盘');
  // 内置按钮的完整形态（设计器认图标/归属所必需）
  assert.ok(rawAfter.includes('<Hotkeys>\n<![CDATA[]]></Hotkeys>'), '内置按钮应带空 Hotkeys');
  assert.equal(errCount(validateCpt(p)), 0);
  assert.ok(rawBefore.length < rawAfter.length);
  fs.rmSync(d, { recursive: true, force: true });
});

test('幂等：同一内置按钮重复追加 → already-present，按钮数不变', () => {
  const { d, p } = fixtureNine();
  addToolbarButton(p, { builtin: 'import-append' });
  const once = snapshot(p);
  const rawOnce = fs.readFileSync(p, 'utf8');

  const again = addToolbarButton(p, { builtin: 'import-append' });
  assert.equal(again.mode, 'already-present');
  assert.deepEqual(snapshot(p), once, '重复调用不得再插一颗');
  assert.equal(fs.readFileSync(p, 'utf8'), rawOnce, '文件字节不应变化');

  // 另一种内置按钮仍可追加（判重按 class，不按"栏里已有内置按钮"一刀切）
  const other = addToolbarButton(p, { builtin: 'import-clean' });
  assert.equal(other.mode, 'append');
  assert.equal(snapshot(p).length, 11);
  fs.rmSync(d, { recursive: true, force: true });
});

test('形态一致性：builtin 追加的 ImExcelAppend 与 set_fill_toolbar 产物逐字节一致', () => {
  const { d, p } = fixtureNine();
  addToolbarButton(p, { builtin: 'import-append' });

  const d2 = tmp();
  const p2 = path.join(d2, 'sf.cpt');
  createCpt(p2, { rows: 2, columns: 2, webWrite: true });
  setFillToolbar(p2, { buttons: ['import-append'] });

  const slice = (file) => {
    const raw = fs.readFileSync(file, 'utf8');
    const s = raw.indexOf('<Widget class="com.fr.report.web.button.write.ImExcelAppend">');
    assert.ok(s >= 0, '应找到内置按钮块');
    const e = raw.indexOf('</Widget>', s) + '</Widget>'.length;
    return raw.slice(s, e);
  };
  assert.equal(slice(p), slice(p2), '两个写入通道的内置按钮形态必须同构（防双份定义漂移）');
  fs.rmSync(d, { recursive: true, force: true });
  fs.rmSync(d2, { recursive: true, force: true });
});

test('对照反证：set_fill_toolbar 整栏重建会冲掉自定义按钮（锁定"必须用 builtin 通道"的理由）', () => {
  const { d, p } = fixtureNine();
  const before = snapshot(p);
  assert.equal(before.length, 9);

  const r = setFillToolbar(p, { buttons: ['submit', 'import-append'] });
  assert.deepEqual(r.buttons, ['submit', 'import-append']);
  const after = snapshot(p);
  assert.equal(after.length, 2, '整栏重建语义：9 → 2');
  const lost = before.filter((x) => !after.includes(x));
  // 9 → 2：submit 因在新列表里而保留，其余 8 个（2 内置 + 6 自定义 JS 按钮）全丢
  assert.equal(lost.length, 8, `应丢失 8 个既有按钮，实际 ${lost.length}`);
  for (const text of ['首页', '上一页', '页码跳转', '下一页', '末页', '导出全部']) {
    assert.ok(!snapshot(p).some((x) => x.endsWith(`|${text}|true`)), `自定义按钮「${text}」应已被整栏重建冲掉`);
  }
  assert.ok(fs.readFileSync(p, 'utf8').includes('class="com.fr.report.web.button.write.ImExcelAppend"'));
  assert.equal(errCount(validateCpt(p)), 0, '即使丢按钮，结构仍是合法 XML（所以门禁抓不住误用）');
  fs.rmSync(d, { recursive: true, force: true });
});

test('参数围栏：builtin 不接受 js/buttonText，未知 builtin 与空入参都明确报错', () => {
  const { d, p } = fixtureNine();
  assert.throws(() => addToolbarButton(p, { builtin: 'import-append', js: 'alert(1)' }), /内置按钮.*不接受自定义 js/);
  assert.throws(() => addToolbarButton(p, { builtin: 'import-append', buttonText: '自定义导入' }), /已自带 i18n 文案/);
  assert.throws(() => addToolbarButton(p, { builtin: 'no-such-button' }), /未知内置按钮/);
  assert.throws(() => addToolbarButton(p, {}), /必须提供 buttonText|builtin/);
  // 失败不得留下半成品
  assert.equal(snapshot(p).length, 9);
  fs.rmSync(d, { recursive: true, force: true });
});

test('MCP 端到端：add_toolbar_button({builtin}) 可调，且不破坏既有按钮', async () => {
  const { d, p } = fixtureNine();
  const before = snapshot(p);
  const client = new Client({ name: 'tbbuiltin-test', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath, args: ['server-full.js'], cwd: process.cwd(), stderr: 'pipe',
  });
  await client.connect(transport);
  try {
    const res = await client.callTool({ name: 'add_toolbar_button', arguments: { path: p, builtin: 'import-append' } });
    assert.equal(res.isError, undefined, `调用不应报错: ${res.content?.[0]?.text}`);
    const data = JSON.parse(res.content[0].text);
    assert.equal(data.mode, 'append');
    assert.equal(data.builtin, 'import-append');
    const after = snapshot(p);
    assert.equal(after.length, before.length + 1);
    assert.deepEqual(after.slice(0, before.length), before);
  } finally {
    await client.close();
    fs.rmSync(d, { recursive: true, force: true });
  }
});
