// cpt-mcp/scripts/demo-generate.js —— 用生成工具拼装一个完整填报模板示例（可交付验证物）
// 运行：node scripts/demo-generate.js
// 产物：demo/示例填报模板.cpt（可直接用 FineReport 设计器打开验证）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCpt, addDataset, addStyle, addCell, addFillSubmit, setReportSettings, setParameterPanel, setGrid } from '../lib/generate.js';
import { validateCpt, issueSummary } from '../lib/validate.js';
import { overview } from '../lib/cpt.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, '..', 'demo', '示例填报模板.cpt');
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.rmSync(OUT, { force: true }); // 支持重复运行

// 1. 骨架：26 列（A-Z）横向填报布局
createCpt(OUT, { title: '示例填报模板（cpt-mcp 生成）', rows: 5, columns: 26, withWebAttr: true, webWrite: true, releaseVersion: '11.5.0' });

// 2. 数据集 + 参数（addDataset 的 parameters 已含数据集参数，无需再单独 addParameter）
addDataset(OUT, {
  name: 'ds1', connection: 'Doris',
  sql: "SELECT sku_code, product_name, cost FROM sales_basics_finally WHERE platform_name = '${platform}'",
  parameters: [{ name: 'platform', defaultValue: '天猫' }],
});

// 3. 样式：0 默认 / 1 表头（加粗、背景 #D9E1F2）/ 2 输入框（浅黄背景）
addStyle(OUT, { fontName: '微软雅黑', fontSizePt: 10, bold: true, backgroundColor: '#D9E1F2', horizontalAlignment: 0 });
addStyle(OUT, { fontName: '微软雅黑', fontSizePt: 10, backgroundColor: '#FFF2CC' });

// 4. 单元格：表头行(0) + 数据行(1) 文本输入控件 + 按钮
const headers = ['商品编码', '商品名称', '成本', '平台', '录入人', '备注'];
headers.forEach((h, c) => addCell(OUT, { column: c, row: 0, content: h, styleIndex: 1 }));
addCell(OUT, { column: 0, row: 1, widget: 'text', styleIndex: 2 });
addCell(OUT, { column: 1, row: 1, widget: 'text', styleIndex: 2 });
addCell(OUT, { column: 2, row: 1, widget: 'text', styleIndex: 2 });
addCell(OUT, { column: 3, row: 1, widget: 'text', styleIndex: 2 });
addCell(OUT, { column: 4, row: 1, widget: 'text', styleIndex: 2 });
addCell(OUT, { column: 5, row: 1, widget: 'textarea', styleIndex: 2 });
addCell(OUT, { column: 6, row: 1, contentType: 'dsColumn', dsName: 'ds1', columnName: 'sku_code', styleIndex: 2 });
addCell(OUT, { column: 0, row: 3, widget: 'submit', styleIndex: 2 });
addCell(OUT, { column: 1, row: 3, widget: 'appendRow', styleIndex: 2 });

// 5. 填报提交 + 绑定
addFillSubmit(OUT, {
  dsName: 'Doris', table: 'fill_record', name: '内置SQL1',
  bindings: [
    { field: 'sku_code', column: 0, row: 1 },
    { field: 'product_name', column: 1, row: 1 },
    { field: 'cost', column: 2, row: 1 },
    { field: 'platform', column: 3, row: 1 },
    { field: 'input_user', column: 4, row: 1, isKey: false },
  ],
});

// 6. 页面：A4 横向 + 水平居中
setReportSettings(OUT, { paper: 'A4', orientation: 1, isHorizontalCenterOnPage: true });
// 7. 参数面板
setParameterPanel(OUT, { title: '查询条件', showWindow: true });
// 8. 行高/列宽
setGrid(OUT, { rowCount: 5, columnWidths: Array(26).fill(2743200) });

// 9. 校验 + 概览
const issues = validateCpt(OUT);
console.log('生成完成:', OUT);
console.log('概览:', JSON.stringify(overview(OUT)));
console.log('校验:', JSON.stringify(issueSummary(issues)));
const errs = issues.filter((i) => i.severity === 'error');
if (errs.length) {
  console.error('存在 error：', errs.map((i) => i.message).join('; '));
  process.exitCode = 1;
} else {
  console.log('校验通过（无 error）。可用 FineReport 设计器打开该文件验证。');
}
