// scripts/test-combo-box.mjs —— 验证 cpt-mcp comboBox 真能生成
// 注：文件名命中 node --test 的默认 glob（**/test-*.mjs），会被全量测试收进去跑，
// 故必须自带 store 隔离，否则每次全量都往**真实用户 store** 写一条残留（M123 实测）。
import './isolate-store.mjs';
import fs from 'node:fs';
import path from 'path';
import os from 'os';
import { createCpt, addCell, addStyle } from '../lib/generate.js';
import { overview, cells } from '../lib/cpt.js';

const tmp = path.join(os.tmpdir(), 'cpt-combo-test-' + Date.now() + '.cpt');
console.log('tmp:', tmp);

// 先创建骨架 (避免 addStyle 报 ENOENT)
createCpt(tmp, { rows: 2, columns: 2, sheetName: 'combo 测试' });

// 1 个样式（默认 0）
addStyle(tmp, { fontSizePt: 14, bold: true });

// 表头
addCell(tmp, { column: 0, row: 0, content: '省份', styleIndex: 0 });
addCell(tmp, { column: 1, row: 0, content: '城市', styleIndex: 0 });

// comboBox 测试
addCell(tmp, { column: 0, row: 1, content: '', widget: 'comboBox', widgetItems: [
  { key: 'gd', value: '广东' },
  { key: 'zj', value: '浙江' },
  { key: 'js', value: '江苏' },
], styleIndex: 0 });
addCell(tmp, { column: 1, row: 1, content: '', widget: 'comboBox', widgetItems: [
  { key: 'gz', value: '广州' },
  { key: 'sz', value: '深圳' },
], styleIndex: 0 });

// 验证
const ov = overview(tmp);
const allCells = cells(tmp);
const comboCell = allCells.find((c) => c.column === 0 && c.row === 1);
const xml = fs.readFileSync(tmp, 'utf8');

console.log('\n=== overview ===');
console.log(ov);
console.log('\n=== comboBox cell ===');
console.log('  column:', comboCell?.column, 'row:', comboCell?.row);
console.log('  widgetClass:', comboCell?.widgetClass);
console.log('  contentText:', comboCell?.contentText);

console.log('\n=== XML 片段 (comboBox) ===');
const match = xml.match(/<Widget class="com\.fr\.form\.ui\.ComboBox">[\s\S]*?<\/Widget>/);
console.log(match ? match[0] : 'NOT FOUND');

fs.rmSync(tmp, { force: true });
