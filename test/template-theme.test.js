// test/template-theme.test.js —— 模板主题 + 内置数据集的引导性拒绝
//
// 逆向依据（官方 1559 个 .cpt 样本实证）：
//   <TemplateThemeAttrMark class="com.fr.base.iofile.attr.TemplateThemeAttrMark">
//     <TemplateThemeAttrMark name="经典浅灰" dark="false"/>
//   </TemplateThemeAttrMark>
//   主题名全部取值（301 处）：兼容主题(158) / 经典浅灰(61) / 兼容(49) / 清爽科技(24) / 经典深灰(9)
//   dark 属性 301 例全为 "false"，没有一例 true
//   位置：271/301 紧跟在 <PreviewType .../> 之后
//
//   内置数据集：326 个 EmbeddedTableData 的 <RowData> 全是 FR 私有压缩编码
//   （形如 FctKS_E\ZeYN`rdSNZW7G...），既非 base64 也非明文，合规边界内无法还原 → 明确拒绝
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCpt, addDataset, setTemplateTheme, TEMPLATE_THEMES } from '../lib/generate.js';
import { generateReport } from '../lib/engine/index.js';
import { validateCpt } from '../lib/validate.js';
import '../scripts/isolate-store.mjs'; // M123：JS 基线 store 隔离，直跑也不污染真实 store

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-theme-'));
const read = (p) => fs.readFileSync(p, 'utf8');
const errCount = (p) => (validateCpt(p)).filter((i) => i.severity === 'error').length;

function seed() {
  const d = tmp();
  const p = path.join(d, 'a.cpt');
  createCpt(p, { rows: 3, columns: 3 });
  return { d, p };
}

test('设置主题：TemplateThemeAttrMark 插在 PreviewType 之后', () => {
  const { d, p } = seed();
  const r = setTemplateTheme(p, '经典浅灰');
  assert.equal(r.action, 'set_template_theme');
  assert.equal(r.theme, '经典浅灰');

  const xml = read(p);
  assert.match(xml, /<TemplateThemeAttrMark class="com\.fr\.base\.iofile\.attr\.TemplateThemeAttrMark">/);
  assert.match(xml, /<TemplateThemeAttrMark name="经典浅灰" dark="false"\/>/);
  assert.ok(
    xml.indexOf('</PreviewType>') >= 0 || xml.indexOf('<PreviewType') >= 0,
    '锚点 PreviewType 应存在'
  );
  assert.ok(
    xml.indexOf('<PreviewType') < xml.indexOf('<TemplateThemeAttrMark'),
    '主题应插在 PreviewType 之后'
  );
  assert.equal(errCount(p), 0);
  fs.rmSync(d, { recursive: true, force: true });
});

test('幂等：重复设置只改名，不叠加', () => {
  const { d, p } = seed();
  setTemplateTheme(p, '经典浅灰');
  setTemplateTheme(p, '清爽科技');
  setTemplateTheme(p, '兼容主题');

  const xml = read(p);
  assert.equal((xml.match(/<TemplateThemeAttrMark class=/g) || []).length, 1, '外层容器只能有一个');
  assert.equal((xml.match(/<TemplateThemeAttrMark name=/g) || []).length, 1, '内层标记只能有一个');
  assert.match(xml, /name="兼容主题"/);
  assert.equal(errCount(p), 0);
  fs.rmSync(d, { recursive: true, force: true });
});

test('安全围栏：主题名不在官方 5 种之内则拒绝', () => {
  const { d, p } = seed();
  assert.throws(() => setTemplateTheme(p, '暗黑模式'), /主题 "暗黑模式" 不存在/);
  assert.throws(() => setTemplateTheme(p, 'dark'), /主题 "dark" 不存在/);
  // 提示里应给出全部可用值
  try {
    setTemplateTheme(p, 'x');
  } catch (e) {
    for (const t of TEMPLATE_THEMES) assert.ok(e.message.includes(t), `错误信息应列出 ${t}`);
  }
  fs.rmSync(d, { recursive: true, force: true });
});

test('generate_report 默认套用 经典浅灰，可关闭', () => {
  const d = tmp();
  const p1 = path.join(d, 'on.cpt');
  generateReport({
    path: p1, source: { connection: 'Doris', table: 't' },
    fields: [{ name: 'a', label: 'A' }],
  });
  assert.match(read(p1), /<TemplateThemeAttrMark name="经典浅灰" dark="false"\/>/, '默认应写主题');

  const p2 = path.join(d, 'off.cpt');
  generateReport({
    path: p2, source: { connection: 'Doris', table: 't' },
    fields: [{ name: 'a', label: 'A' }],
    options: { templateTheme: false },
  });
  assert.doesNotMatch(read(p2), /TemplateThemeAttrMark/, 'templateTheme:false 应不写主题');

  const p3 = path.join(d, 'custom.cpt');
  generateReport({
    path: p3, source: { connection: 'Doris', table: 't' },
    fields: [{ name: 'a', label: 'A' }],
    options: { templateTheme: '清爽科技' },
  });
  assert.match(read(p3), /name="清爽科技"/);
  assert.equal(errCount(p1), 0);
  assert.equal(errCount(p3), 0);
  fs.rmSync(d, { recursive: true, force: true });
});

test('安全围栏：内置数据集（RowData 私有编码）被明确拒绝而非静默忽略', () => {
  const { d, p } = seed();
  // 正常 SQL 数据集不受影响
  const ok = addDataset(p, { name: 'ds1', connection: 'Doris', sql: 'select * from t' });
  assert.equal(ok.action, 'add_dataset');

  assert.throws(
    () => addDataset(p, { name: 'ds2', connection: '', sql: '', embedded: true }),
    /不支持内置数据集|EmbeddedTableData/
  );
  // 拒绝信息应给出替代方案，而不是干巴巴一句"不支持"
  try {
    addDataset(p, { name: 'ds2', connection: '', sql: '', embedded: true });
  } catch (e) {
    assert.match(e.message, /替代方案/);
    assert.match(e.message, /SQL 数据集|RowData/);
  }
  fs.rmSync(d, { recursive: true, force: true });
});
