import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertDataFilePath, assertSafeExternalUrl, assertToolPath, looksLikeScript } from '../lib/security.js';
import { buildReportSpecSchema } from '../lib/engine/spec.js';
import { buildReport } from '../lib/engine/builder.js';
import '../scripts/isolate-store.mjs'; // M123：JS 基线 store 隔离，直跑也不污染真实 store
// 回归 hermetic 前置：外部 CPT_MCP_ALLOWED_ROOTS（如 DSH 会话级目录限制）会改变默认允许根，
// 以下断言测的是默认行为（项目目录+系统临时目录），先恢复默认再跑。各测试文件独立进程，互不影响。
delete process.env.CPT_MCP_ALLOWED_ROOTS;

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-security-test-'));

test('路径围栏：允许项目/临时目录，拒绝系统目录和受保护目录', () => {
  const allowed = path.join(TMP, 'ok.cpt');
  assert.equal(assertToolPath('create_cpt', allowed), allowed);

  const root = path.parse(process.cwd()).root;
  assert.throws(
    () => assertToolPath('create_cpt', path.join(root, 'Windows', 'System32', 'blocked.cpt')),
    /安全围栏|允许目录/
  );
  assert.throws(() => assertToolPath('read_cpt', path.join(process.cwd(), '.git', 'config')), /受保护路径/);
});

test('数据源与外链围栏：禁止路径穿越、任意协议和凭据外泄', () => {
  assert.equal(assertDataFilePath('reportlets/demo/data.xlsx', { fromEnv: true }), 'reportlets/demo/data.xlsx');
  assert.throws(() => assertDataFilePath('../secrets.xlsx', { fromEnv: true }), /安全围栏/);
  assert.throws(() => assertDataFilePath('C:/Windows/System32/secrets.xlsx', { fromEnv: true }), /安全围栏/);
  assert.equal(assertSafeExternalUrl('https://example.com/report?id=1'), 'https://example.com/report?id=1');
  assert.throws(() => assertSafeExternalUrl('javascript:alert(1)'), /http\/https|安全围栏/);
  assert.throws(() => assertSafeExternalUrl('https://user:pass@example.com/'), /用户名|密码/);
  assert.equal(looksLikeScript('recalcAll()'), false, '普通 FR 公式/事件名不应被误报为脚本');
  assert.equal(looksLikeScript('<script>alert(1)</script>'), true);
});

test('build_report schema：完整公开能力可传递，拼写错误不再静默剥离', () => {
  const result = buildReportSpecSchema.safeParse({
    datasets: [{ name: 'ds1', excelFile: 'reportlets/demo/data.xlsx', needColumnName: true, fromEnv: true }],
    cells: [{ column: 0, row: 0, widget: 'custom', widgetClass: 'com.example.Button', pluginID: 'demo', pluginVersion: '1.0' }],
    charts: [{ column: 0, row: 2, dsName: 'ds1', category: 'name', values: ['amount'] }],
    fills: [{ table: 'sales', bindings: [{ field: 'id', column: 0, row: 1 }] }],
    hfStyle: { fontSizePt: 9 },
    sheets: [{ name: 'sheet1' }, { name: 'sheet2', rows: 5, columns: 5 }],
  });
  assert.equal(result.success, true, JSON.stringify(result.error?.issues));

  const typo = buildReportSpecSchema.safeParse({ cells: [{ column: 0, row: 0, font_size: 12 }] });
  assert.equal(typo.success, false, '未知字段必须返回参数错误');
});

test('build_report：构建失败时保留旧模板，成功后才原子替换', () => {
  const target = path.join(TMP, 'preserve.cpt');
  fs.writeFileSync(target, 'ORIGINAL_TEMPLATE');
  assert.throws(() => buildReport({
    path: target,
    datasets: [
      { name: 'ds1', connection: 'JDBC', sql: 'select 1' },
      { name: 'ds1', connection: 'JDBC', sql: 'select 2' },
    ],
  }), /重名|已存在|dataset|数据集/i);
  assert.equal(fs.readFileSync(target, 'utf8'), 'ORIGINAL_TEMPLATE');
});
