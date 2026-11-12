// test/session-gap-2026-11-05.test.js —— 最新报表会话暴露的 CPT-MCP 能力缺口
//
// 背景：从最新 report 会话真实工具调用里提取出的 3 类高频失败（全部可复现）：
//   ① update_fill_submit 传 index（习惯写法）→ "Unrecognized key: index"；
//      传 condition 对象（FormulaCondition）→ MCP 32602 "expected string, received object"；
//   ② add_parameter_widget 传 type:"textEditor" → "Invalid option"（其它框架语感）；
//   ③ update_parameter_widget 传 dictionary 为 JSON 字符串 → "expected object, received string"。
// 另含本轮收尾的两个验收残余：P2-4（advisories 30 条上限可能截掉 excel 导入提示）、
// P2-5（连接回退 notice 在 schema/data 早退错误路径丢失）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { normalizeArgs } from '../lib/arg-normalize.js';
import { canonicalWidgetType } from '../lib/widget-types.js';
import { capAdvisories } from '../lib/quality.js';
import { connectionFallbackSuffix, importDataFromDb, importSchemaFromDb } from '../lib/localdb-import.js';
import { createCpt, addFillSubmit, addParameterWidget, addSheet } from '../lib/generate.js';
import { setFillToolbar, setReportJs } from '../lib/edits.js';
import { qualityGate } from '../lib/quality.js';
import '../scripts/isolate-store.mjs';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-session-gap-'));
test.after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ } });
let seq = 0;
function newCpt({ webWrite = false } = {}) {
  seq += 1;
  const p = path.join(TMP, `t${seq}.cpt`);
  createCpt(p, { rows: 8, columns: 8, webWrite });
  return p;
}

// ---------- 单元：参数归一（不启 MCP 子进程） ----------

test('update_fill_submit: index/submit/submitIdx 别名 → submitIndex', () => {
  for (const from of ['index', 'submit', 'submitIdx']) {
    const { args, fixes } = normalizeArgs('update_fill_submit', { path: 'a.cpt', [from]: 2 }, {});
    assert.equal(args.submitIndex, 2, `${from} 应搬到 submitIndex`);
    assert.equal(args[from], undefined, `${from} 应被移除`);
    assert.ok(fixes.some((f) => f.includes('→submitIndex')), `应有纠正回执：${fixes}`);
  }
});

test('update_fill_submit: condition 对象（FormulaCondition）→ 公式文本', () => {
  const { args, fixes } = normalizeArgs('update_fill_submit', {
    path: 'a.cpt',
    condition: { class: 'com.fr.data.condition.ListCondition', formula: 'len(AB3)>0' },
  }, {});
  assert.equal(args.condition, 'len(AB3)>0');
  assert.equal(typeof args.condition, 'string');
  assert.ok(fixes.some((f) => f.includes('condition 对象')), `应有纠正回执：${fixes}`);

  // 前导 = 去掉（与处理器口径一致）；{expr} / {value} / {text} 也能提取
  const r2 = normalizeArgs('update_fill_submit', { path: 'a.cpt', condition: { expr: '=Y5=1' } }, {});
  assert.equal(r2.args.condition, 'Y5=1');
  const r3 = normalizeArgs('update_fill_submit', { path: 'a.cpt', condition: { value: 'A1>0' } }, {});
  assert.equal(r3.args.condition, 'A1>0');
});

test('update_fill_submit: 非 FormulaCondition 的 class 不猜 value/text（P2-2）', () => {
  // {class:ListCondition, value:"X1=1"}：value 语义不明；按空 ListCondition 处理，不静默当公式
  const r = normalizeArgs('update_fill_submit', {
    path: 'a.cpt', condition: { class: 'com.fr.data.condition.ListCondition', value: 'X1=1' },
  }, {});
  assert.equal(r.args.condition, 'ListCondition');
  // 显式 formula 才提取，并在回执注明 class 被忽略
  const r2 = normalizeArgs('update_fill_submit', {
    path: 'a.cpt', condition: { class: 'com.fr.data.condition.ListCondition', formula: 'A1=1' },
  }, {});
  assert.equal(r2.args.condition, 'A1=1');
  assert.ok(r2.fixes.some((f) => f.includes('被忽略')), `应注明 class 被忽略：${r2.fixes}`);
  // 空 formula 视为清除条件（对象形态）
  const r3 = normalizeArgs('update_fill_submit', { path: 'a.cpt', condition: { formula: '' } }, {});
  assert.equal(r3.args.condition, '');
  assert.ok(r3.fixes.some((f) => f.includes('清除条件')), `应说明清除：${r3.fixes}`);
  // ListCondition 对象（无 formula）→ 显式空列表条件
  const r4 = normalizeArgs('update_fill_submit', {
    path: 'a.cpt', condition: { class: 'com.fr.data.condition.ListCondition' },
  }, {});
  assert.equal(r4.args.condition, 'ListCondition');
});

test('add_fill_submit: condition 对象同样归一（与 update 同口径）', () => {
  const { args, fixes } = normalizeArgs('add_fill_submit', {
    path: 'a.cpt', dsName: 'D', table: 't', bindings: [{ field: 'id', column: 0, row: 1 }],
    condition: { class: 'com.fr.data.condition.FormulaCondition', formula: 'B2!=null' },
  }, {});
  assert.equal(args.condition, 'B2!=null');
  assert.ok(fixes.some((f) => f.includes('condition 对象')));
});

test('add_parameter_widget: type 语感写法 → FR 官方类型（textEditor/select/…）', () => {
  const cases = [
    ['textEditor', 'text'], ['textarea', 'textarea'], ['textBox', 'text'], ['textfield', 'text'], ['input', 'text'],
    ['select', 'comboBox'], ['dropdown', 'comboBox'], ['combo', 'comboBox'],
    ['multiSelect', 'comboCheckBox'], ['multi-select', 'comboCheckBox'],
    ['checkbox', 'checkBox'], ['datePicker', 'date'], ['submit', 'submitButton'], ['button', 'submitButton'],
    ['label', 'label'], ['text', 'text'], ['comboBox', 'comboBox'],
  ];
  for (const [input, expected] of cases) {
    const { args, fixes } = normalizeArgs('add_parameter_widget', { path: 'a.cpt', name: 'w', type: input }, {});
    assert.equal(args.type, expected, `type "${input}" 应归一为 ${expected}`);
    if (input !== expected) assert.ok(fixes.some((f) => f.includes('→')), `应有纠正回执：${fixes}`);
  }
  // 未知类型不猜（交给 schema 报错）
  assert.equal(normalizeArgs('add_parameter_widget', { path: 'a.cpt', name: 'w', type: 'radio' }, {}).args.type, 'radio');
});

test('widget-types: 单一事实源归一（大小写/空格/下划线不敏感）', () => {
  assert.equal(canonicalWidgetType('Text-Editor').type, 'text');
  assert.equal(canonicalWidgetType('text_editor').type, 'text');
  assert.equal(canonicalWidgetType('combo_box_checkbox').type, 'comboCheckBox');
  assert.equal(canonicalWidgetType('unknown-widget').changed, false);
});

test('add_parameter_widget_batch: items[] 的 type 别名与 dictionary 字符串一并归一', () => {
  const { args, fixes } = normalizeArgs('add_parameter_widget_batch', {
    path: 'a.cpt',
    items: [
      { name: 'kw', type: 'textEditor' },
      { name: 'st', type: 'select', dictionary: '{"type":"table","dsName":"ds1","valueField":"id","textField":"name"}' },
    ],
  }, {});
  assert.equal(args.items[0].type, 'text');
  assert.equal(args.items[1].type, 'comboBox');
  assert.deepEqual(args.items[1].dictionary, { type: 'table', dsName: 'ds1', kiName: 'id', viName: 'name' });
  assert.ok(fixes.length >= 3, `应有纠正回执：${fixes}`);
});

test('update_parameter_widget: dictionary JSON 字符串 → 对象，并继续套 valueField/textField 归一', () => {
  const { args, fixes } = normalizeArgs('update_parameter_widget', {
    path: 'a.cpt', name: 'w',
    dictionary: '{"type":"table","dsName":"ds1","valueField":"sku","displayColumn":"sku_name"}',
  }, {});
  assert.equal(typeof args.dictionary, 'object');
  assert.equal(args.dictionary.kiName, 'sku');
  assert.equal(args.dictionary.viName, 'sku_name');
  assert.ok(fixes.some((f) => f.includes('dictionary（JSON 字符串）→ 对象')), `应有纠正回执：${fixes}`);
});

test('update_fill_submit_batch: items[].patch.condition 对象也归一', () => {
  const { args } = normalizeArgs('update_fill_submit_batch', {
    path: 'a.cpt',
    items: [{ target: { submitIndex: 1 }, patch: { condition: { formula: 'A1!=null' } } }],
  }, {});
  assert.equal(args.items[0].patch.condition, 'A1!=null');
});

// ---------- lib 入口兜底（batch 不经过 server 归一） ----------

test('lib addParameterWidget 直接调用也接受 type:"textEditor"（batch 路径兜底）', () => {
  const p = newCpt();
  const r = addParameterWidget(p, { name: 'kw', type: 'textEditor', defaultValue: '' });
  assert.equal(r.type, 'text');
  assert.match(fs.readFileSync(p, 'utf8'), /class="com\.fr\.form\.ui\.TextEditor"/);
});

test('lib addFillSubmit 支持 ListCondition（空列表）与显式 formula', () => {
  const p = newCpt({ webWrite: true });
  const r = addFillSubmit(p, {
    dsName: 'D', table: 't_record', name: '提交',
    bindings: [{ field: 'id', column: 0, row: 1, isKey: true }],
    condition: { class: 'com.fr.data.condition.ListCondition' },
  });
  assert.equal(r.condition, 'ListCondition');
  assert.ok(fs.readFileSync(p, 'utf8').includes('<Condition class="com.fr.data.condition.ListCondition"/>'));

  const p2 = newCpt({ webWrite: true });
  const r2 = addFillSubmit(p2, {
    dsName: 'D', table: 't_record', name: '提交2',
    bindings: [{ field: 'id', column: 0, row: 1, isKey: true }],
    condition: { class: 'com.fr.data.condition.ListCondition', formula: 'A1=1' },
  });
  assert.equal(r2.condition, 'A1=1');
  assert.match(fs.readFileSync(p2, 'utf8'), /<Condition class="com\.fr\.data\.condition\.FormulaCondition">/);

  const p3 = newCpt({ webWrite: true });
  assert.throws(
    () => addFillSubmit(p3, {
      dsName: 'D', table: 't_record', name: '提交3',
      bindings: [{ field: 'id', column: 0, row: 1, isKey: true }],
      condition: { class: 'com.fr.data.condition.ObjectCondition' },
    }),
    /不支持/,
  );
});

// ---------- MCP 协议端到端（真实 server.js 子进程） ----------

async function withServer(fn) {
  const client = new Client({ name: 'session-gap-mcp', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['server.js'],
    cwd: process.cwd(),
    stderr: 'pipe',
    env: { CPT_MCP_TOOL_PROFILE: 'full', CPT_MCP_HOT_RELOAD: '0', CPT_MCP_ALLOWED_ROOTS: TMP },
  });
  await client.connect(transport);
  const call = async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: args });
    const texts = (r.content ?? []).filter((x) => x.type === 'text').map((x) => x.text);
    let data = null;
    try { data = JSON.parse(texts[0] ?? ''); } catch { /* 非 JSON */ }
    return { isError: r.isError === true, text: texts.join('\n'), data };
  };
  try {
    return await fn({ client, call });
  } finally {
    await client.close();
  }
}

test('E2E update_fill_submit：index 别名 + condition 对象一次通过（原会话两连败处）', async () => {
  const p = newCpt({ webWrite: true });
  addFillSubmit(p, {
    dsName: 'Doris', table: 't_record', name: '提交',
    bindings: [{ field: 'id', column: 0, row: 1, isKey: true }, { field: 'name', column: 1, row: 1 }],
    condition: 'len(AB3)>0',
  });
  await withServer(async ({ call }) => {
    const r = await call('update_fill_submit', {
      path: p,
      index: 0,
      condition: { class: 'com.fr.data.condition.ListCondition', formula: 'len(AB3)>1' },
    });
    assert.equal(r.isError, false, `不应报错：${r.text}`);
    assert.ok(r.data, `应返回 JSON：${r.text}`);
    assert.deepEqual(r.data.changed?.includes?.('condition') ?? false, true, `changed 应含 condition：${JSON.stringify(r.data.changed)}`);
    assert.equal(r.data.condition, 'len(AB3)>1');
    assert.match(r.text, /参数已自动纠正/, '应附纠正回执');
    assert.match(fs.readFileSync(p, 'utf8'), /<Formula>\s*<!\[CDATA\[len\(AB3\)>1\]\]>/);
  });
});

test('E2E add_parameter_widget：type:"textEditor" 不再被枚举拒绝', async () => {
  const p = newCpt();
  await withServer(async ({ call }) => {
    const r = await call('add_parameter_widget', { path: p, name: 'kw', type: 'textEditor', defaultValue: '' });
    assert.equal(r.isError, false, `不应报错：${r.text}`);
    assert.equal(r.data.type, 'text');
    assert.match(fs.readFileSync(p, 'utf8'), /class="com\.fr\.form\.ui\.TextEditor"/);
  });
});

test('E2E add_fill_submit：condition 对象（FormulaCondition）不再 32602', async () => {
  const p = newCpt({ webWrite: true });
  await withServer(async ({ call }) => {
    const r = await call('add_fill_submit', {
      path: p, dsName: 'Doris', table: 't_record', name: '提交',
      bindings: [{ field: 'id', column: 0, row: 1, isKey: true }],
      condition: { class: 'com.fr.data.condition.FormulaCondition', formula: 'A2!=null' },
    });
    assert.equal(r.isError, false, `不应报错：${r.text}`);
    assert.equal(r.data.condition, 'A2!=null');
  });
});

test('E2E add/update_fill_submit：submitType/configType 走 MCP schema 并回读', async () => {
  const p = newCpt({ webWrite: true });
  await withServer(async ({ call }) => {
    const a = await call('add_fill_submit', {
      path: p, dsName: 'Doris', table: 't_record', name: '提交',
      bindings: [{ field: 'id', column: 0, row: 1, isKey: true }],
      submitType: 'insert',
    });
    assert.equal(a.isError, false, `不应报错：${a.text}`);
    assert.equal(a.data.submitType, 'insert');
    assert.equal(a.data.dmlConfigClass, 'com.fr.write.config.InsertConfig');

    const g = await call('get_fill_config', { path: p });
    assert.equal(g.isError, false, g.text);
    assert.equal(g.data.submits[0].submitType, 'insert');

    // configType 是 submitType 的兼容别名：schema 不广告，但归一化后仍可用
    const u = await call('update_fill_submit', { path: p, index: 0, configType: 'IntelliDMLConfig' });
    assert.equal(u.isError, false, `不应报错：${u.text}`);
    assert.equal(u.data.submitType, 'intelligent');
    assert.match(u.text, /参数已自动纠正/);
    assert.match(fs.readFileSync(p, 'utf8'), /class="com\.fr\.write\.config\.IntelliDMLConfig"/);
  });
});

test('E2E update_parameter_widget：dictionary JSON 字符串不再 "expected object"', async () => {
  const p = newCpt();
  addParameterWidget(p, { name: 'w', type: 'comboBox', dictionary: { type: 'custom' }, items: [{ key: 'a', value: 'A' }] });
  await withServer(async ({ call }) => {
    const r = await call('update_parameter_widget', {
      path: p, name: 'w',
      dictionary: '{"type":"custom"}',
      items: [{ key: 'b', value: 'B' }],
    });
    assert.equal(r.isError, false, `不应报错：${r.text}`);
    assert.deepEqual(r.data.dictAfter?.items, [{ key: 'b', value: 'B' }]);
  });
});

// ---------- P2-4：advisories 30 条上限不应吞掉 excel 导入提示 ----------

test('P2-4 capAdvisories：被截掉的 pinned 条目提到首位，总数/截断标记不变', () => {  const pinned = { code: 'excel_import_not_pretested' };
  const all = [...Array.from({ length: 34 }, (_, i) => ({ code: `x${i}` })), pinned];
  const r = capAdvisories(all, 30, pinned);
  assert.equal(r.items.length, 30);
  assert.equal(r.items[0], pinned, 'pinned 应可见且在首位');
  assert.equal(r.total, 35);
  assert.equal(r.truncated, true);
  assert.equal(r.pinnedVisible, true);

  const clean = capAdvisories([{ code: 'a' }, { code: 'b' }], 30, null);
  assert.deepEqual(clean.items, [{ code: 'a' }, { code: 'b' }]);
  assert.equal(clean.truncated, false);
  assert.equal(clean.pinnedVisible, true);

  const alreadyFirst = capAdvisories(all.slice(-1).concat(all.slice(0, -1)), 30, pinned);
  assert.equal(alreadyFirst.items[0], pinned);
  assert.equal(alreadyFirst.items.length, 30);
});

test('P2-4 qualityGate：advisories>30 被截断时 excel 导入提示仍可见（明细首位 + 顶层 excelImport）', () => {
  // 31 个 sheet 各放一段语法错误的 TopJS → 31 条 validate advisory；再挂普通导入按钮。
  const p = newCpt({ webWrite: true });
  for (let i = 0; i < 31; i += 1) addSheet(p, { name: `S${i}` });
  for (let i = 0; i < 31; i += 1) setReportJs(p, { sheet: i, js: 'function(){' });
  setFillToolbar(p, { buttons: ['import-append'] });
  const g = qualityGate(p);
  assert.equal(g.advisoriesTruncated, true, `应触发截断：total=${g.advisoriesTotal}`);
  assert.ok(g.excelImport, '顶层应有 excelImport 摘要');
  assert.equal(g.excelImport.found, true);
  assert.equal(g.excelImport.pretested, false);
  assert.equal(g.excelImport.advisoryVisible, true);
  assert.equal(g.advisories[0]?.code, 'excel_import_not_pretested', '被截掉的 excel advisory 应提到明细首位');
  assert.ok(g.advisories.some((a) => a.code === 'excel_import_not_pretested'));
  assert.equal(g.advisories.length, 30);
  assert.equal(g.summary.infos >= 31, true);
});

// ---------- P2-5：连接回退 notice 在早退错误路径也要可见 ----------
test('P2-5 connectionFallbackSuffix：有 notice 才追加，文案含核对指引', () => {
  assert.equal(connectionFallbackSuffix(null), '');
  assert.equal(connectionFallbackSuffix({}), '');
  const suffix = connectionFallbackSuffix({ notice: '配置里没有连接 "X"，已回退到唯一连接 "Doris"' });
  assert.match(suffix, /数据连接回退/);
  assert.match(suffix, /已回退到唯一连接/);
  assert.match(suffix, /核对 connection 名/);
});

test('P2-5 importSchemaFromDb：SHOW TABLES 为空/清单读取失败时错误里带回退 notice', async () => {
  const notice = '配置里没有连接 "X"，已回退到唯一连接 "Doris"';
  const depsBase = {
    resolveConnection: () => ({ name: 'Doris', notice }),
    createLocalDb: () => ({ ok: true }),
  };
  // ① SHOW TABLES 返回空（早退分支）
  await assert.rejects(
    importSchemaFromDb({ db: 'gap_db1', connection: 'X', deps: { ...depsBase, listRealTables: async () => [] } }),
    (err) => {
      assert.match(err.message, /SHOW TABLES 返回空/);
      assert.match(err.message, /数据连接回退/);
      assert.match(err.message, /核对 connection 名/);
      return true;
    },
  );
  // ② 表清单读取抛错（异常分支）
  await assert.rejects(
    importSchemaFromDb({ db: 'gap_db2', connection: 'X', deps: { ...depsBase, listRealTables: async () => { throw new Error('ECONNREFUSED'); } } }),
    (err) => {
      assert.match(err.message, /读取真实库表清单失败/);
      assert.match(err.message, /数据连接回退/);
      return true;
    },
  );
  // ②b 建库失败（P2-1，第三轮独立复验补）
  await assert.rejects(
    importSchemaFromDb({ db: 'gap_db4', connection: 'X', deps: { ...depsBase, createLocalDb: () => { throw new Error('磁盘只读'); }, listRealTables: async () => ['t_real'] } }),
    (err) => {
      assert.match(err.message, /创建本地库失败/);
      assert.match(err.message, /数据连接回退/);
      return true;
    },
  );
  // ③ 无表可导入（tables 都不存在）
  await assert.rejects(
    importSchemaFromDb({ db: 'gap_db3', connection: 'X', tables: ['no_such_table'], deps: { ...depsBase, listRealTables: async () => ['t_real'] } }),
    (err) => {
      assert.match(err.message, /都不存在/);
      assert.match(err.message, /数据连接回退/);
      return true;
    },
  );
});

test('P2-5 importDataFromDb：无表/本地库不可用时错误里带回退 notice', async () => {
  const notice = '配置里没有连接 "X"，已回退到唯一连接 "Doris"';
  const deps = { resolveConnection: () => ({ name: 'Doris', notice }), listLocalTables: () => ['t1'] };
  await assert.rejects(
    importDataFromDb({ db: 'gap_missing_db', connection: 'X', deps }),
    (err) => {
      assert.match(err.message, /数据连接回退/);
      assert.match(err.message, /核对 connection 名/);
      return true;
    },
  );
});
