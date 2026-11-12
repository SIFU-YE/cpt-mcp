// V4 会话缺口：参数面板多行文本框（textarea）此前被 alias 静默降级成 text。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCpt, addParameterWidget } from '../lib/generate.js';
import { updateParameterWidget } from '../lib/edits.js';
import { parameterPanel } from '../lib/cpt.js';
import '../scripts/isolate-store.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-textarea-'));
const innerSeg = (p) => {
  const raw = fs.readFileSync(p, 'utf8');
  const s = raw.indexOf('<ReportParameterAttr>');
  const e = raw.indexOf('</ReportParameterAttr>', s);
  return raw.slice(s, e);
};

test('add_parameter_widget: textarea 生成 TextArea 多行控件（不再降级为 text）', () => {
  const d = tmp();
  const p = path.join(d, 'a.cpt');
  createCpt(p, { rows: 3, columns: 3 });
  const r = addParameterWidget(p, { name: 'remark', type: 'textarea', label: '备注', x: 10, y: 10, width: 180, height: 60 });
  assert.equal(r.type, 'textarea');
  const seg = innerSeg(p);
  assert.match(seg, /<InnerWidget class="com\.fr\.form\.ui\.TextArea">/);
  assert.match(seg, /<Reg class="com\.fr\.form\.ui\.reg\.NoneReg"\/>/);
  assert.doesNotMatch(seg, /<InnerWidget class="com\.fr\.form\.ui\.TextEditor">[\s\S]*remark/);
  fs.rmSync(d, { recursive: true, force: true });
});

test('update_parameter_widget: text → textarea 只切 class 并补 Reg；反向可切回', () => {
  const d = tmp();
  const p = path.join(d, 'a.cpt');
  createCpt(p, { rows: 3, columns: 3 });
  addParameterWidget(p, { name: 'remark', type: 'text', label: '备注', x: 10, y: 10, width: 180, height: 24 });
  assert.match(innerSeg(p), /<InnerWidget class="com\.fr\.form\.ui\.TextEditor">/);

  const up = updateParameterWidget(p, { name: 'remark', type: 'textarea' });
  assert.equal(up.mode, 'update');
  assert.match(innerSeg(p), /<InnerWidget class="com\.fr\.form\.ui\.TextArea">/);
  assert.match(innerSeg(p), /<Reg class="com\.fr\.form\.ui\.reg\.NoneReg"\/>/);

  const back = updateParameterWidget(p, { name: 'remark', type: 'text' });
  assert.equal(back.mode, 'update');
  assert.match(innerSeg(p), /<InnerWidget class="com\.fr\.form\.ui\.TextEditor">/);

  // 非 text/textarea 控件拒绝，提示重建
  assert.throws(
    () => updateParameterWidget(p, { name: 'remark', type: 'textarea', dictionary: { type: 'custom', items: [{ key: 'a', value: 'a' }] } }),
    /无 <Dictionary>|不是 text\/textarea/
  );
  fs.rmSync(d, { recursive: true, force: true });
});

test('add_parameter_widget: 已有 DatabaseDictionary 用 dictionary:{type:custom} 转自定义项不误报', () => {
  const d = tmp();
  const p = path.join(d, 'a.cpt');
  createCpt(p, { rows: 3, columns: 3 });
  addParameterWidget(p, {
    name: 'dept', type: 'comboBox', label: '部门',
    dictionary: { type: 'db', table: 't_dept', ki: 0, vi: 1, connection: 'test', kiName: 'code', viName: 'name' },
    x: 10, y: 10, width: 120, height: 24,
  });
  assert.match(innerSeg(p), /com\.fr\.data\.impl\.DatabaseDictionary/);
  // 该工具支持整块换字典；验证不会因 items 归一被误判互斥（写的是 CustomDictionary）
  updateParameterWidget(p, {
    name: 'dept',
    dictionary: { type: 'custom', items: [{ key: '业务部', value: '业务部' }] },
  });
  assert.match(innerSeg(p), /com\.fr\.data\.impl\.CustomDictionary/);
  assert.match(innerSeg(p), /key="业务部"/);
  fs.rmSync(d, { recursive: true, force: true });
});
