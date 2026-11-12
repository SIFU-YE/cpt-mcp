// test/js-error-lines.test.js —— M92 JS 语法错误行号 + check_report_js 进 focused
//
// 背景：v4 会话修 `Unexpected token 'catch'` 跑了 77 步约 20 分钟仍未定位，最后用户亲诊
// （set#2 写回多敲 `}`，priceOf 提前闭合）。复盘三处断裂：
// ① check_report_js 在 focused/report 档不可见（也租不到），排错会话调不到；
// ② 即使调到，failures 也只有块级 location（行号在实现里被 split('\n')[0] 丢掉），描述写的
//    “行号相对块内”名不副实；③ validate 的 warning 同样只有块级信息。
// 修法：行号从 V8 栈首行提取（包裹版减 1 回到块内坐标）；工具进 focused（report 继承）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createCpt } from '../lib/generate.js';
import { setReportJs } from '../lib/edits.js';
import { checkReportJs } from '../lib/cpt.js';
import { validateCpt } from '../lib/validate.js';
import '../scripts/isolate-store.mjs'; // M123：JS 基线 store 隔离，直跑也不污染真实 store

delete process.env.CPT_MCP_ALLOWED_ROOTS;

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-jsline-'));
// 第 4 行多余 `}`（v4 事故同构：块提前闭合，V8 在第 4 行报错）
const BROKEN = ['var a = 1;', 'try {', '  foo();', '}', '} catch (e) {}', 'var z = 9;'].join('\n');

function brokenFile() {
  const d = tmp();
  const p = path.join(d, 'bad.cpt');
  createCpt(p, { rows: 2, columns: 2 });
  setReportJs(p, { js: BROKEN, sheet: 0 });
  return { d, p };
}

test('M92 check_report_js：failures 带块内行号，直指多余 } 行', () => {
  const { d, p } = brokenFile();
  const r = checkReportJs(p);
  assert.equal(r.failed, 1);
  assert.equal(r.failures[0].location, 'sheet1/TopJS');
  assert.equal(r.failures[0].line, 4, `行号应直指第4行多余 }：${JSON.stringify(r.failures)}`);
  assert.equal(BROKEN.split('\n')[r.failures[0].line - 1], '}', '行号换算回源码行应是多余 }');
  assert.match(r.hint, /块内行号/);
  fs.rmSync(d, { recursive: true, force: true });
});

test('M92 check_report_js：顶层 return 照常放行（函数体包裹兜底不回归）+ 合法块无线号', () => {
  const d = tmp();
  const p = path.join(d, 'ok.cpt');
  createCpt(p, { rows: 2, columns: 2 });
  setReportJs(p, { js: 'var t = contentPane;\nreturn 42;', sheet: 0 });
  const r = checkReportJs(p);
  assert.equal(r.failed, 0);
  assert.equal(r.failures.length, 0);
  fs.rmSync(d, { recursive: true, force: true });
});

test('M92 validate：JS warning 复述块内行号（读到即修，不再人肉翻块）', () => {
  const { d, p } = brokenFile();
  const issues = validateCpt(p) ?? [];
  const jsWarns = issues.filter((i) => i.severity === 'warning' && /JS 语法错误/.test(i.message));
  assert.equal(jsWarns.length, 1);
  assert.match(jsWarns[0].location, /第4行/, `location 应带行号：${jsWarns[0].location}`);
  assert.match(jsWarns[0].message, /块内第4行/, `message 应带行号：${jsWarns[0].message}`);
  assert.equal(issues.filter((i) => i.severity === 'error' && /JS 语法错误/.test(i.message)).length, 0, '仍为 warning，不误杀基线');
  fs.rmSync(d, { recursive: true, force: true });
});

test('M92 check_report_js 在 focused 档端到端可调并返回行号（v4 复盘：排错会话必须调得到）', async () => {
  const { d, p } = brokenFile();
  const client = new Client({ name: 'jsline-test', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath, args: ['server.js'], cwd: process.cwd(), stderr: 'pipe',
    env: { CPT_MCP_TOOL_PROFILE: 'focused' },
  });
  await client.connect(transport);
  try {
    const names = (await client.listTools()).tools.map((t) => t.name);
    assert.ok(names.includes('check_report_js'), 'focused 档应含 check_report_js');
    const r = await client.callTool({ name: 'check_report_js', arguments: { path: p } });
    assert.ok(!r.isError, r.content?.[0]?.text);
    const data = JSON.parse(r.content[0].text);
    assert.equal(data.failed, 1);
    assert.equal(data.failures[0].line, 4, `MCP 端到端行号应为 4：${r.content[0].text.slice(0, 300)}`);
  } finally {
    await client.close();
  }
  fs.rmSync(d, { recursive: true, force: true });
});
