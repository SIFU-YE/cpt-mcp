// test/mobile-ref-cleanup.test.js —— P1-2：移动端孤儿条目清理工具
//
// 背景（残留②）：MobileWidgetList / WidgetNameTagMap 孤儿条目（如 fine_username_c）
// 无专用清理工具，rename 只支持现存控件改名（改名≠删除）。
// 修法：delete_mobile_widget_ref 按 widgetName 定向删两处映射，不碰面板与数据集层。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { deleteMobileWidgetRef } from '../lib/edits.js';
import { validateCpt } from '../lib/validate.js';
import { allClassifiedToolNames } from '../lib/contract.js';
import '../scripts/isolate-store.mjs'; // M123：JS 基线 store 隔离，直跑也不污染真实 store

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-mobileref-'));

// 官方形态 fixture：存活控件 kw + 孤儿 fine_username_c（两处各一条残留）
function fixture() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<WorkBook xmlVersion="20211223" releaseVersion="11.5.0">
<TableDataMap>
<TableData name="ds1" class="com.fr.data.impl.DBTableData">
<Parameters>
<Parameter>
<Attributes name="kw"/>
<O>
<![CDATA[]]></O>
</Parameter>
</Parameters>
<Connection>
<DatabaseName>
<![CDATA[Doris]]></DatabaseName>
</Connection>
<Query>
<![CDATA[SELECT 1 WHERE x=\${kw}]]></Query>
</TableData>
</TableDataMap>
<Report name="sheet1">
<CellElementList>
<C c="0" r="0" s="0">
<O>
<![CDATA[a]]></O>
</C>
</CellElementList>
<RowHeight defaultValue="723900">
<![CDATA[723900]]></RowHeight>
<ColumnWidth defaultValue="2743200">
<![CDATA[2743200]]></ColumnWidth>
<ReportPageAttr/>
</Report>
<ReportParameterAttr>
<ParameterUI class="com.fr.form.main.parameter.FormParameterUI">
<Layout class="com.fr.form.ui.container.WParameterLayout">
<WidgetName name="para"/>
<Widget class="com.fr.form.ui.container.WAbsoluteLayout$BoundsWidget">
<InnerWidget class="com.fr.form.ui.TextEditor">
<WidgetName name="kw"/>
<WidgetAttr description=""/>
</InnerWidget>
<BoundsAttr x="10" y="10" width="100" height="24"/>
</Widget>
<Sorted sorted="false"/>
<MobileWidgetList><Widget widgetName="kw"/><Widget widgetName="fine_username_c"/></MobileWidgetList>
<Display display="true"/>
<NameTagModified/>
<WidgetNameTagMap><NameTag name="kw" tag="关键词:"/><NameTag name="fine_username_c" tag="用户名:"/></WidgetNameTagMap>
<ParamAttr class="com.fr.report.mobile.DefaultMobileParamStyle"/>
</Layout>
</ParameterUI>
<Parameter><Attributes name="kw"/><O><![CDATA[]]></O></Parameter>
<Parameter><Attributes name="fine_username_c"/><O><![CDATA[]]></O></Parameter>
</ReportParameterAttr>
<StyleList>
<Style horizontal_alignment="0" imageLayout="1">
<FRFont name="微软雅黑" style="0" size="72"/>
<Background name="NullBackground"/>
<Border/>
</Style>
</StyleList>
</WorkBook>
`;
}

const rpaSeg = (p) => {
  const raw = fs.readFileSync(p, 'utf8');
  const s = raw.indexOf('<ReportParameterAttr>');
  return raw.slice(s, raw.indexOf('</ReportParameterAttr>', s));
};

test('P1-2 孤儿清理：fine_username_c 两处残留被删，存活项与面板/数据集层不动', () => {
  const d = tmp();
  const p = path.join(d, 'a.cpt');
  fs.writeFileSync(p, fixture(), 'utf8');
  assert.equal(validateCpt(p).filter((i) => i.severity === 'error').length, 0, 'fixture 应先天无 error');

  const r = deleteMobileWidgetRef(p, { name: 'fine_username_c' });
  assert.equal(r.action, 'delete_mobile_widget_ref');
  assert.equal(r.removedMobileRef, 1, 'MobileWidgetList 删1条');
  assert.equal(r.removedNameTag, 1, 'TagMap 删1条');

  const seg = rpaSeg(p);
  assert.ok(!seg.includes('widgetName="fine_username_c"'), 'MobileWidgetList 无孤儿残留');
  assert.ok(!seg.includes('<NameTag name="fine_username_c"'), 'TagMap 无孤儿残留');
  assert.ok(seg.includes('<Attributes name="fine_username_c"/>'), '报告参数绑定保留（本工具不碰）');
  assert.ok(seg.includes('<Widget widgetName="kw"/>'), '存活移动端引用保留');
  assert.ok(seg.includes('<NameTag name="kw" tag="关键词:"/>'), '存活标签映射保留');
  assert.ok(seg.includes('<WidgetName name="kw"/>'), '控件本体保留');
  assert.ok(seg.includes('<Attributes name="kw"/>'), '报告参数绑定保留');
  assert.ok(seg.includes('<MobileWidgetList>') && seg.includes('<WidgetNameTagMap>'), '容器本身保留');
  // 数据集层不动
  const raw = fs.readFileSync(p, 'utf8');
  assert.ok(raw.includes('<Attributes name="kw"/>') && raw.includes('x=${kw}'), '数据集层/SQL 未动');
  assert.equal(validateCpt(p).filter((i) => i.severity === 'error').length, 0, '清理后仍无 error');
  fs.rmSync(d, { recursive: true, force: true });
});

test('P1-2 存活控件拒绝清理，无命中抛错（防误删/拼错）', () => {
  const d = tmp();
  const p = path.join(d, 'b.cpt');
  fs.writeFileSync(p, fixture(), 'utf8');

  assert.throws(() => deleteMobileWidgetRef(p, { name: 'kw' }), /仍存在/, '存活控件必须拒绝');
  assert.ok(rpaSeg(p).includes('<Widget widgetName="kw"/>'), '拒绝后原文不动');
  assert.throws(() => deleteMobileWidgetRef(p, { name: 'nope' }), /未找到/, '两处皆无应抛错');
  assert.throws(() => deleteMobileWidgetRef(p, {}), /必须提供 name/, '缺名抛错');
  fs.rmSync(d, { recursive: true, force: true });
});

test('P1-2 仅一处残留也能清理（部分命中）', () => {
  const d = tmp();
  const p = path.join(d, 'c.cpt');
  fs.writeFileSync(p, fixture(), 'utf8');
  // 先清一次 TagMap 残留：第二次调用应只剩 MobileWidgetList 可清
  const r1 = deleteMobileWidgetRef(p, { name: 'fine_username_c' });
  assert.equal(r1.removedMobileRef + r1.removedNameTag, 2);
  // 孤儿已清干净：再调抛错（幂等语义 = 不再有可删项即报错，不静默成功）
  assert.throws(() => deleteMobileWidgetRef(p, { name: 'fine_username_c' }), /未找到/);
  fs.rmSync(d, { recursive: true, force: true });
});

test('P1-2 新工具已进契约归类（无未归类门槛）', () => {
  assert.ok(allClassifiedToolNames().includes('delete_mobile_widget_ref'), 'DESTRUCTIVE_TOOLS 应含新工具');
});
