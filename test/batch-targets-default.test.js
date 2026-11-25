// test/batch-targets-default.test.js —— 审查修复②：get_toolbar_button_batch 省略 targets = 读全部按钮
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCpt } from '../lib/generate.js';
import { addToolbarButton } from '../lib/edits.js';
import { getToolbarButtonBatch } from '../lib/batch.js';
import '../scripts/isolate-store.mjs';

test('targets 省略/空数组 = 读全部按钮；给 targets = 只读指定', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-batch-targets-'));
  try {
    const p = path.join(d, 'a.cpt');
    createCpt(p, { rows: 4, columns: 4, webWrite: true });
    addToolbarButton(p, { buttonText: '批量导入', js: 'var a=1;' });
    addToolbarButton(p, { buttonText: '清空缓冲', js: 'var b=2;' });

    const all = await getToolbarButtonBatch(p, undefined);
    assert.equal(all.summary.total, 2, `省略 targets 应读全部：${JSON.stringify(all.summary)}`);
    const empty = await getToolbarButtonBatch(p, []);
    assert.equal(empty.summary.total, 2, '空数组同义于全部');

    const one = await getToolbarButtonBatch(p, [{ buttonText: '批量导入' }]);
    assert.equal(one.summary.total, 1);
    assert.equal(one.results[0].found, true);
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});
