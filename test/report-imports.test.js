// test/report-imports.test.js —— Web 页面静态资源引用（ReportWebAttr 内 CSSImport/JSImport）
//
// 背景（sandbox17 实测）：无参数版明细表靠 <CSSImport>/<JSImport> 引用服务器磁盘文件
// （css/index.css、js/jquery.rotate.min.js、js/index.js），放自定义样式与页面 JS。
// cpt-mcp 此前没有任何读写删查入口：update_report_node 的 M91 同名多候选 + upsert 语义
// 导致“第 2 个 JSImport 静默替换第 1 个”（本文件锁定该回归）；build_report 重建还会整段丢掉。
// 本文件锁定 set_report_imports 的整段替换语义 + 读取 + 校验 + 构建透传。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createCpt } from '../lib/generate.js';
import { setReportImports } from '../lib/edits.js';
import { overview, reportImports } from '../lib/cpt.js';
import { validateCpt } from '../lib/validate.js';
import { buildReport } from '../lib/engine/builder.js';
import '../scripts/isolate-store.mjs'; // M123：JS 基线 store 隔离，直跑也不污染真实 store

delete process.env.CPT_MCP_ALLOWED_ROOTS;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-imports-'));
const read = (p) => fs.readFileSync(p, 'utf8');
const errCount = (v) => (Array.isArray(v) ? v : v.issues ?? []).filter((x) => x.severity === 'error').length;
const warnCount = (v) => (Array.isArray(v) ? v : v.issues ?? []).filter((x) => x.severity === 'warning').length;

function fixture() {
  const d = tmp();
  const p = path.join(d, 't.cpt');
  createCpt(p, { rows: 3, columns: 3, webWrite: false });
  return { d, p };
}

test('set_report_imports：整段写入 CSS+JS（顺序=先 CSS 后 JS，与设计器落盘一致）', () => {
  const { d, p } = fixture();
  const r = setReportImports(p, { css: ['css/index.css'], js: ['js/jquery.rotate.min.js', 'js/index.js'] });
  assert.equal(r.action, 'set_report_imports');
  assert.deepEqual(r.css, ['css/index.css']);
  assert.deepEqual(r.js, ['js/jquery.rotate.min.js', 'js/index.js']);
  assert.equal(r.changed, true);
  const xml = read(p);
  assert.equal((xml.match(/<JSImport>/g) || []).length, 2, '两个 JSImport 都必须落盘（不得 upsert 式替换）');
  assert.equal((xml.match(/<CSSImport>/g) || []).length, 1);
  // 顺序：CSSImport 在前，JSImport 在后，且都在 ReportWebAttr 内
  const rwaOpen = xml.indexOf('<ReportWebAttr>');
  const rwaClose = xml.indexOf('</ReportWebAttr>');
  const cssAt = xml.indexOf('<CSSImport>');
  const jsAt = xml.indexOf('<JSImport>');
  assert.ok(rwaOpen >= 0 && cssAt > rwaOpen && jsAt > cssAt && jsAt < rwaClose, 'CSS → JS 顺序落在 ReportWebAttr 内');
  assert.equal(errCount(validateCpt(p)), 0);
  fs.rmSync(d, { recursive: true, force: true });
});

test('set_report_imports：只传一类时另一类原样保留；空数组=清空该类', () => {
  const { d, p } = fixture();
  setReportImports(p, { css: ['css/a.css'], js: ['js/a.js', 'js/b.js'] });
  const r1 = setReportImports(p, { js: ['js/c.js'] });
  assert.deepEqual(r1.js, ['js/c.js']);
  assert.deepEqual(r1.css, ['css/a.css'], '不传 css 则原样保留');
  assert.equal(read(p).match(/<JSImport>/g).length, 1, 'JS 列表被整体替换，不残留旧节点');
  const r2 = setReportImports(p, { css: [] });
  assert.deepEqual(r2.css, []);
  assert.deepEqual(r2.js, ['js/c.js']);
  assert.ok(!read(p).includes('<CSSImport>'), '空数组应删光该类节点');
  // 全清空：两类都空数组
  const r3 = setReportImports(p, { css: [], js: [] });
  assert.ok(!read(p).includes('<JSImport>'));
  assert.equal(errCount(validateCpt(p)), 0, '清空后模板仍合法');
  // 无变化时 noop（不重写文件）
  const before = read(p);
  const r4 = setReportImports(p, { css: [], js: [] });
  assert.equal(r4.mode, 'noop');
  assert.equal(read(p), before);
  fs.rmSync(d, { recursive: true, force: true });
});

test('set_report_imports：非法路径一律拒绝（目录穿越/绝对路径/反斜杠/URL/错后缀）', () => {
  const { d, p } = fixture();
  assert.throws(() => setReportImports(p, { css: ['../x.css'] }), /\.\./);
  assert.throws(() => setReportImports(p, { css: ['/abs/x.css'] }), /相对/);
  assert.throws(() => setReportImports(p, { css: ['C:\\x.css'] }), /相对|反斜杠/);
  assert.throws(() => setReportImports(p, { css: ['css\\a.css'] }), /反斜杠/);
  assert.throws(() => setReportImports(p, { js: ['https://x/y.js'] }), /URL|协议/);
  assert.throws(() => setReportImports(p, { js: ['js/a.css'] }), /后缀/);
  assert.throws(() => setReportImports(p, { css: ['css/a.js'] }), /后缀/);
  assert.throws(() => setReportImports(p, { css: [''] }), /非空/);
  assert.throws(() => setReportImports(p, { css: 'css/a.css' }), /数组/);
  assert.throws(() => setReportImports(p, {}), /至少传/);
  assert.throws(() => setReportImports(p, { js: ['a]]>b'] }), /CDATA/);
  fs.rmSync(d, { recursive: true, force: true });
});

test('read：overview().imports 与 reportImports 回显落盘列表', () => {
  const { d, p } = fixture();
  setReportImports(p, { css: ['css/index.css'], js: ['js/a.js', 'js/b.js'] });
  assert.deepEqual(reportImports(p), { css: ['css/index.css'], js: ['js/a.js', 'js/b.js'] });
  assert.deepEqual(overview(p).imports, { css: ['css/index.css'], js: ['js/a.js', 'js/b.js'] });
  // 无引用的模板回空列表（不是 null，方便调用方直接遍历）
  const d2 = tmp();
  const p2 = path.join(d2, 'e.cpt');
  createCpt(p2, { rows: 2, columns: 2 });
  assert.deepEqual(reportImports(p2), { css: [], js: [] });
  fs.rmSync(d, { recursive: true, force: true });
  fs.rmSync(d2, { recursive: true, force: true });
});

test('validate：可疑路径与重复引用只告警（不阻断交付）', () => {
  const { d, p } = fixture();
  // 手工造坏形态（绕过写工具的合法性校验，覆盖历史模板/手工改文件场景）
  let raw = read(p);
  const at = raw.indexOf('</ReportWebAttr>');
  raw = raw.slice(0, at)
    + '<CSSImport>\n<![CDATA[../shared/x.css]]></CSSImport>\n'
    + '<JSImport>\n<![CDATA[js/a.js]]></JSImport>\n'
    + '<JSImport>\n<![CDATA[js/a.js]]></JSImport>\n'
    + '<JSImport>\n<![CDATA[C:\\evil.js]]></JSImport>\n'
    + raw.slice(at);
  fs.writeFileSync(p, raw);
  const issues = validateCpt(p);
  assert.equal(errCount(issues), 0, '导入问题只告警、不应 blocking 交付');
  assert.ok(warnCount(issues) >= 3, `应有 ≥3 条导入告警（穿越/重复/反斜杠），实际 ${warnCount(issues)}`);
  const msgs = issues.map((i) => i.message).join('\n');
  assert.ok(msgs.includes('JSImport') && msgs.includes('CSSImport'));
  fs.rmSync(d, { recursive: true, force: true });
});

test('webroot：存在性核对只告警不阻断', () => {
  const { d, p } = fixture();
  const webroot = path.join(d, 'webroot');
  fs.mkdirSync(path.join(webroot, 'css'), { recursive: true });
  fs.mkdirSync(path.join(webroot, 'js'), { recursive: true });
  fs.writeFileSync(path.join(webroot, 'css', 'index.css'), '/* ok */');
  const r = setReportImports(p, { css: ['css/index.css'], js: ['js/missing.js'], webroot });
  assert.equal(r.changed, true, '缺失文件不阻断写入');
  assert.equal(r.warnings.length, 1, `应恰好 1 条缺失告警：${JSON.stringify(r.warnings)}`);
  assert.ok(r.warnings[0].includes('js/missing.js'));
  const r2 = setReportImports(p, { css: ['css/index.css'], js: ['js/nope.js'], webroot: path.join(d, 'no-such-dir') });
  assert.ok(r2.warnings.some((w) => w.includes('webroot')), '不存在的 webroot 应告警');
  fs.rmSync(d, { recursive: true, force: true });
});

test('build_report：spec.imports 透传 + 重建清空预警', () => {
  const d = tmp();
  const p = path.join(d, 'b.cpt');
  const r = buildReport({
    path: p, title: '导入透传', rows: 3, columns: 3,
    imports: { css: ['css/index.css'], js: ['js/a.js'] },
  });
  assert.ok(read(p).includes('<CSSImport>') && read(p).includes('<JSImport>'), 'spec.imports 应落盘');
  assert.deepEqual(reportImports(p), { css: ['css/index.css'], js: ['js/a.js'] });
  assert.equal(r.importsNotice, null, '本次传了 imports，不应有清空预警');
  // 重建不传 imports → 预警（与 toolbarNotice 同口径，不阻断）；显式 noOverwrite:false 表达覆盖意图
  const r2 = buildReport({ path: p, title: '导入透传', rows: 3, columns: 3, noOverwrite: false });
  assert.ok(r2.importsNotice && r2.importsNotice.level === 'warning', '重建清空应有 importsNotice 预警');
  assert.ok(r2.importsNotice.message.includes('css/index.css'), '预警应回显被清空的引用');
  assert.deepEqual(reportImports(p), { css: [], js: [] }, '重建后引用确已清空');
  fs.rmSync(d, { recursive: true, force: true });
});

test('MCP：set_report_imports 经 page_setup 租约可调用（deep 档）', async () => {
  const d = tmp();
  const p = path.join(d, 'm.cpt');
  createCpt(p, { rows: 2, columns: 2 });
  const client = new Client({ name: 'imports-mcp-test', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['server.js'],
    cwd: path.join(__dirname, '..'),
    env: { CPT_MCP_TOOL_PROFILE: 'full' },
    stderr: 'pipe',
  });
  await client.connect(transport);
  try {
    const decode = (r) => JSON.parse(r.content[0].text);
    const access = decode(await client.callTool({
      name: 'request_deep_tool_access',
      arguments: { group: 'page_setup', path: p, reason: 'explicit_page_setup' },
    }));
    assert.equal(access.status, 'granted');
    assert.ok(access.enabledTools.includes('set_report_imports'), 'page_setup 租约应含 set_report_imports');
    const r = decode(await client.callTool({
      name: 'set_report_imports',
      arguments: { path: p, css: ['css/index.css'], js: ['js/a.js'] },
    }));
    assert.equal(r.action, 'set_report_imports');
    assert.deepEqual(r.js, ['js/a.js']);
    assert.deepEqual(reportImports(p), { css: ['css/index.css'], js: ['js/a.js'] }, 'MCP 调用应真实落盘');
  } finally {
    await client.close();
    fs.rmSync(d, { recursive: true, force: true });
  }
});
