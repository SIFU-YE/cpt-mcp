// test/header-footer.test.js —— 页眉页脚
//
// 逆向依据（官方 1559 样本实证）：
//   <Header reportPageType="0"><Background name="NullBackground"/><LeftList/><CenterList/><RightList/></Header>
//   reportPageType 恒为 "0"；内容型元素只有 com.fr.base.headerfooter.FormulaHFElement，
//   内挂 <FRFont/> + <Formula content="公式" text="预览文本"/>。
//   页码变量 $$page_number / $$totalPage_number 取自 demo/basic/档案式报表.cpt 原文。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCpt, setPageHeaderFooter } from '../lib/generate.js';
import { generateReport } from '../lib/engine/index.js';
import { validateCpt } from '../lib/validate.js';
import '../scripts/isolate-store.mjs'; // M123：JS 基线 store 隔离，直跑也不污染真实 store

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-hf-'));
const read = (p) => fs.readFileSync(p, 'utf8');

/** 取某个 <Header>/<Footer> 块的文本 */
function block(xml, tag) {
  const i = xml.indexOf(`<${tag} `);
  assert.notEqual(i, -1, `应有 <${tag}>`);
  return xml.slice(i, xml.indexOf(`</${tag}>`, i) + tag.length + 3);
}

test('骨架自带官方标配的空页眉页脚', () => {
  const d = tmp();
  const p = path.join(d, 'a.cpt');
  createCpt(p, { title: 'T', rows: 3, columns: 3 });
  const xml = read(p);
  assert.match(xml, /<Header reportPageType="0">/, '骨架应含 Header');
  assert.match(xml, /<Footer reportPageType="0">/, '骨架应含 Footer');
  // 三个区都在，且为空
  for (const tag of ['LeftList', 'CenterList', 'RightList']) {
    assert.equal((xml.match(new RegExp(`<${tag}/>`, 'g')) || []).length, 2, `${tag} 在 Header/Footer 各一个空节点`);
  }
  fs.rmSync(d, { recursive: true, force: true });
});

test('页脚页码：preset 生成官方原文公式 + 人话预览文本', () => {
  const d = tmp();
  const p = path.join(d, 'b.cpt');
  createCpt(p, { rows: 2, columns: 2 });
  const r = setPageHeaderFooter(p, { footer: { center: { preset: 'pageNumber' } } });
  assert.equal(r.action, 'set_page_header_footer');

  const footer = block(read(p), 'Footer');
  assert.match(footer, /<HFElement className="com\.fr\.base\.headerfooter\.FormulaHFElement">/);
  assert.match(footer, /content="&quot;第&quot; \+ \$\$page_number \+ &quot;页\/共&quot; \+ \$\$totalPage_number \+ &quot;页&quot;"/,
    '公式应与官方样本一致');
  assert.match(footer, /text="第1页\/共100页"/, '预览文本应是可读的人话，而非公式源码');
  assert.match(footer, /<FRFont[^>]*size="36"/, '9pt → size=36（pt×4 口径）');
  fs.rmSync(d, { recursive: true, force: true });
});

test('纯文本字符串自动包成公式字符串字面量', () => {
  const d = tmp();
  const p = path.join(d, 'c.cpt');
  createCpt(p, { rows: 2, columns: 2 });
  setPageHeaderFooter(p, { header: { left: '机密文件' } });
  const header = block(read(p), 'Header');
  assert.match(header, /content="&quot;机密文件&quot;"/, '纯文本应被包成 "机密文件"');
  assert.match(header, /<LeftList>/);
  assert.match(header, /<CenterList\/>/, '未给的区应为空');
  fs.rmSync(d, { recursive: true, force: true });
});

test('自定义公式原样写入（不被转义破坏）', () => {
  const d = tmp();
  const p = path.join(d, 'd.cpt');
  createCpt(p, { rows: 2, columns: 2 });
  setPageHeaderFooter(p, { footer: { right: { formula: '"共" + $$totalPage_number + "页"' } } });
  const footer = block(read(p), 'Footer');
  assert.match(footer, /content="&quot;共&quot; \+ \$\$totalPage_number \+ &quot;页&quot;"/);
  fs.rmSync(d, { recursive: true, force: true });
});

test('只给 footer 时 header 保持原样；重复调用幂等覆盖', () => {
  const d = tmp();
  const p = path.join(d, 'e.cpt');
  createCpt(p, { rows: 2, columns: 2 });
  setPageHeaderFooter(p, { header: { left: 'A' } });
  setPageHeaderFooter(p, { footer: { center: { preset: 'pageNumberShort' } } });
  let xml = read(p);
  assert.match(block(xml, 'Header'), /content="&quot;A&quot;"/, '第 1 次设的页眉不应被第 2 次调用清掉');
  assert.match(block(xml, 'Footer'), /\$\$page_number \+ &quot; \/ &quot; \+ \$\$totalPage_number/);

  // 再次设置页脚 → 覆盖而非追加
  setPageHeaderFooter(p, { footer: { center: 'X' } });
  xml = read(p);
  assert.equal((xml.match(/<Footer /g) || []).length, 1, '不应出现两个 Footer 块');
  assert.equal((xml.match(/<CenterList>/g) || []).length, 1, 'CenterList 应被覆盖而非追加');
  fs.rmSync(d, { recursive: true, force: true });
});

test('非法输入被引导性拒绝', () => {
  const d = tmp();
  const p = path.join(d, 'f.cpt');
  createCpt(p, { rows: 2, columns: 2 });
  assert.throws(() => setPageHeaderFooter(p, {}), /header|footer/, '都不给应报错');
  assert.throws(() => setPageHeaderFooter(p, { footer: { center: { preset: 'nope' } } }),
    /preset="nope"|不存在/, '未知 preset 应报可用列表');
  assert.throws(() => setPageHeaderFooter(p, { footer: { middle: 'x' } }),
    /middle|槽位/, '非法槽位名应报可用槽位');
  assert.throws(() => setPageHeaderFooter(p, { footer: { left: 'x' }, fontSizePt: 999 }),
    /字号/, '离谱字号应被拒');
  fs.rmSync(d, { recursive: true, force: true });
});

test('generate_report 默认带页眉（标题）与页脚（页码）', () => {
  const d = tmp();
  const p = path.join(d, 'g.cpt');
  const r = generateReport({
    path: p,
    title: '销售明细表',
    source: { connection: 'Doris', table: 't_sales' },
    fields: [
      { name: 'region', label: '区域', type: 'text' },
      { name: 'amount', label: '金额', type: 'money', summary: true },
    ],
  });
  assert.equal(r.checkResult.hasError, false, `不应有 error: ${JSON.stringify(r.checkResult.errors ?? r.checkResult)}`);

  const xml = read(p);
  assert.match(block(xml, 'Header'), /content="&quot;销售明细表&quot;"/, '页眉左区应为报表标题');
  assert.match(block(xml, 'Footer'), /\$\$page_number/, '页脚中区应为页码');
  assert.equal(r.summary.pageHeaderFooter.header.left, '销售明细表');
  assert.equal(r.summary.pageHeaderFooter.footer.center.preset, 'pageNumber');

  const v = validateCpt(p);
  assert.equal((v.issues ?? v).filter((i) => i.severity === 'error').length, 0, 'validate 不应有 error');
  fs.rmSync(d, { recursive: true, force: true });
});

test('generate_report 可关闭页眉页脚', () => {
  const d = tmp();
  const p = path.join(d, 'h.cpt');
  generateReport({
    path: p,
    title: 'T',
    source: { connection: 'Doris', table: 't' },
    fields: [{ name: 'a', label: 'A' }],
    options: { header: false, footer: false },
  });
  const xml = read(p);
  // 骨架里的空 Header/Footer 仍在（设计器标配），但不应有内容元素
  assert.match(xml, /<Header reportPageType="0">/, '骨架页眉仍在');
  assert.doesNotMatch(xml, /HFElement/, '关闭后不应有任何页眉页脚内容元素');
  fs.rmSync(d, { recursive: true, force: true });
});
