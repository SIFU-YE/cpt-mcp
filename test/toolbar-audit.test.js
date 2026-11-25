// test/toolbar-audit.test.js —— 工具栏按钮「语法通过但运行期点不动」的接线审计
// 背景：2026-11-24 某会话/v1 复盘——按钮 JS 过了 check_report_js 语法检查，
// 但把报表参数 `page` 当参数面板控件 getWidgetByName("page") 取，返回 null 且未判空，
// 点击静默无效；quality_gate_cpt 当时没有工具栏检查，于是"审查通过但按钮是死的"。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createCpt, setParameterPanel, addParameterWidget } from '../lib/generate.js';
import { addToolbarButton, auditToolbarButtons, listToolbarButtons } from '../lib/edits.js';
import { qualityGate } from '../lib/quality.js';
import '../scripts/isolate-store.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-tbaudit-'));

/** 建一个含参数面板（pageSize 控件 + 同名参数）的填报模板，并挂一颗自定义按钮。 */
function fixture(js, { withPageParam = true, withJs = true } = {}) {
  const d = tmp();
  const p = path.join(d, 't.cpt');
  createCpt(p, { rows: 2, columns: 2, webWrite: true });
  setParameterPanel(p, {});
  addParameterWidget(p, { name: 'pageSize', type: 'text' });
  if (withPageParam) {
    // page 只作为报表参数存在，没有对应控件（真实模板的常见形态）
    const raw = fs.readFileSync(p, 'utf8').replace(
      '</ReportParameterAttr>',
      '<Parameter>\n<Attributes name="page"/>\n<O>\n<![CDATA[]]></O>\n</Parameter>\n</ReportParameterAttr>',
    );
    fs.writeFileSync(p, raw, 'utf8');
  }
  addToolbarButton(p, { buttonText: '首页', ...(withJs ? { js } : {}) });
  return { d, p };
}

test('toolbar audit：把报表参数当控件且未判空 → blocker，quality_gate 必须 pass=false', () => {
  const { d, p } = fixture('var pgW = contentPane.parameterEl.getWidgetByName("page");\npgW.setValue(1);');
  const audit = auditToolbarButtons(p);
  assert.equal(audit.pass, false);
  assert.ok(audit.blockers.some((b) => b.code === 'parameter-as-widget-unguarded'), JSON.stringify(audit.blockers));

  const gate = qualityGate(p);
  assert.equal(gate.pass, false, '失效按钮不得通过质量门禁');
  const hit = gate.blockers.filter((b) => /getWidgetByName\("page"\)/.test(b.message));
  assert.equal(hit.length, 1, JSON.stringify(gate.blockers.map((b) => b.message)));
  assert.match(hit[0].fix, /list_toolbar_buttons\(\{audit:true\}\)/);
  fs.rmSync(d, { recursive: true, force: true });
});

test('toolbar audit：有判空/降级 → 不阻断交付，只给 warning（真实模板形态）', () => {
  const { d, p } = fixture('var pgW = contentPane.parameterEl.getWidgetByName("page");\nif (pgW) pgW.setValue(1);');
  const audit = auditToolbarButtons(p);
  assert.equal(audit.pass, true, JSON.stringify(audit.blockers));
  assert.ok(audit.warnings.some((w) => w.code === 'parameter-as-widget-guarded'));

  const gate = qualityGate(p);
  assert.equal(gate.pass, true, JSON.stringify(gate.blockers));
  assert.ok(gate.advisories.some((a) => /getWidgetByName\("page"\)/.test(a.message)));
  fs.rmSync(d, { recursive: true, force: true });
});

test('toolbar audit：引用不存在的控件名 → blocker；自定义按钮无 JS → blocker', () => {
  const { d: d1, p: p1 } = fixture('var x = contentPane.parameterEl.getWidgetByName("nope");\nx.setValue(1);', { withPageParam: false });
  assert.ok(auditToolbarButtons(p1).blockers.some((b) => b.code === 'widget-not-found'));
  fs.rmSync(d1, { recursive: true, force: true });

  const { d: d2, p: p2 } = fixture('', { withJs: false, withPageParam: false });
  assert.ok(auditToolbarButtons(p2).blockers.some((b) => b.code === 'custom-no-js'));
  fs.rmSync(d2, { recursive: true, force: true });
});

test('list_toolbar_buttons({audit:true})：附带 audit.pass/blockers，交付前可直接自查', () => {
  const { d, p } = fixture('var pgW = contentPane.parameterEl.getWidgetByName("page");\npgW.setValue(1);');
  const res = listToolbarButtons(p, { includeJs: false, audit: true });
  assert.ok(res.audit, 'audit=true 必须返回 audit');
  assert.equal(res.audit.pass, false);
  assert.equal(res.audit.buttonCount, 1);
  assert.equal(res.audit.blockers[0].code, 'parameter-as-widget-unguarded');
  fs.rmSync(d, { recursive: true, force: true });
});

test('toolbar audit：调用不存在的 _g().deleteRepoRow → blocker，并给正确 API', () => {
  const { d, p } = fixture('_g().deleteRepoRow(3);', { withPageParam: false });
  const audit = auditToolbarButtons(p);
  const bad = audit.blockers.find((b) => b.code === 'bad-fr-api');
  assert.ok(bad, JSON.stringify(audit.blockers));
  assert.match(bad.fix, /deleteReportRC/);
  assert.equal(qualityGate(p).pass, false);
  fs.rmSync(d, { recursive: true, force: true });
});
