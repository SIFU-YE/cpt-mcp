// 一次性 E2E：真实 MCP stdio 调用验证 2026-11-23 三项能力
// 用法：node --import ./scripts/isolate-store.mjs scripts/e2e-20261123-capabilities.mjs（在 cpt-mcp 目录）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// 允许根目录可用 CPT_MCP_E2E_ROOT 指定；缺省用系统临时目录（不写死任何机器路径）
const ROOT = process.env.CPT_MCP_E2E_ROOT || os.tmpdir();
const dir = fs.mkdtempSync(path.join(ROOT, 'cpt-e2e-cap-'));
const cpt = path.join(dir, 'demo.cpt');
const sqlFile = path.join(dir, 'dataset.sql');
fs.writeFileSync(sqlFile, 'select dept, amount from t_demo where d = ${day}', 'utf8');

async function connect(profile) {
  const client = new Client({ name: 'e2e-cap', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath, args: ['server.js'], cwd: process.cwd(), stderr: 'pipe',
    env: { CPT_MCP_TOOL_PROFILE: profile, CPT_MCP_ALLOWED_ROOTS: ROOT, CPT_MCP_NO_BAK: '1' },
  });
  await client.connect(transport);
  return client;
}

const textOf = (r) => (r.content ?? []).map((b) => b.text ?? '').join('\n');
const jsonOf = (r) => { try { return JSON.parse(textOf(r)); } catch { return null; } };

const results = [];
function record(name, passed, detail) {
  results.push({ name, passed, detail });
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}  ${detail ? '· ' + detail : ''}`);
}

const client = await connect('report');
try {
  // 1) create_cpt + add_dataset(sqlFile)
  const create = await client.callTool({ name: 'create_cpt', arguments: { path: cpt, rows: 8, columns: 6 } });
  record('create_cpt', create.isError !== true, textOf(create).slice(0, 80));

  const addDs = await client.callTool({ name: 'add_dataset', arguments: {
    path: cpt, name: 'ds1', connection: 'Doris', sqlFile, parameters: [{ name: 'day', defaultValue: '2026-11-01' }],
  } });
  const addData = jsonOf(addDs);
  record('add_dataset(sqlFile)', addDs.isError !== true && /t_demo/.test(fs.readFileSync(cpt, 'utf8')),
    addDs.isError ? textOf(addDs).slice(0, 160) : 'sqlSource=' + JSON.stringify(addData?.sqlSource));
  record('add_dataset 回显 sqlSource（不回显全文）', JSON.stringify(addData?.sqlSource ?? {}).includes('dataset.sql'));

  // 2) update_dataset(sqlFile)：同内容替换应成功
  const upd = await client.callTool({ name: 'update_dataset', arguments: { path: cpt, datasetName: 'ds1', sqlFile } });
  record('update_dataset(sqlFile)', upd.isError !== true, textOf(upd).slice(0, 120));

  // 3) generate_report(source.sqlFile) 建另一张表
  const cpt2 = path.join(dir, 'gen.cpt');
  const gen = await client.callTool({ name: 'generate_report', arguments: {
    path: cpt2, title: '文件SQL', source: { connection: 'Doris', sqlFile },
    fields: [{ name: 'dept', label: '部门' }, { name: 'amount', label: '金额', type: 'money' }],
  } });
  record('generate_report(source.sqlFile)',
    gen.isError !== true && fs.existsSync(cpt2) && /t_demo/.test(fs.readFileSync(cpt2, 'utf8')),
    gen.isError ? textOf(gen).slice(0, 200) : 'file ok');
} finally {
  await client.close();
}

// 4) batch_mutate_cells（深层工具：用 full profile 免租约）
const full = await connect('full');
try {
  const plan = await full.callTool({ name: 'batch_mutate_cells', arguments: {
    path: cpt, mode: 'plan',
    commands: [{
      op: 'create',
      data: {
        cells: [
          { column: 0, row: 0, content: '标题' },
          { column: 0, row: 1, content: '表头' },
          { column: 1, row: 1, content: '=sum(A2)' },
        ],
      },
    }],
  } });
  const planData = jsonOf(plan);
  record('batch_mutate_cells plan(create data.cells)',
    plan.isError !== true && planData?.status === 'ready', plan.isError ? textOf(plan).slice(0, 200) : 'planId=' + planData?.planId);

  const apply = await full.callTool({ name: 'batch_mutate_cells', arguments: { path: cpt, mode: 'apply', planId: planData?.planId } });
  const applyData = jsonOf(apply);
  record('batch_mutate_cells apply', apply.isError !== true && applyData?.status === 'applied', textOf(apply).slice(0, 120));

  // 5) 单格简写：data 直接写单元格字段
  const plan2 = await full.callTool({ name: 'batch_mutate_cells', arguments: {
    path: cpt, mode: 'plan',
    commands: [{ op: 'create', target: { cells: ['C3'] }, data: { content: '简写格', colspan: 2 } }],
  } });
  const plan2Data = jsonOf(plan2);
  record('batch_mutate_cells 单格简写（data 直写字段）',
    plan.isError !== true && plan2Data?.status === 'ready', plan2.isError ? textOf(plan2).slice(0, 200) : 'ok');
} finally {
  await full.close();
}

const failed = results.filter((r) => !r.passed);
console.log(`\n结果：${results.length - failed.length}/${results.length} 通过`);
fs.rmSync(dir, { recursive: true, force: true });
process.exit(failed.length ? 1 : 0);
