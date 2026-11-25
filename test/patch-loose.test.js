// V4 会话实测：patchFind 与读回原文的换行/行尾空格不一致时 0 命中。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCpt } from '../lib/generate.js';
import { setWebWriteJs } from '../lib/edits.js';
import { webwriteListener } from '../lib/cpt.js';
import '../scripts/isolate-store.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-patch-'));

test('set_webwrite_js: patchFind 可匹配「行尾空格不同」的原文', () => {
  const d = tmp();
  const p = path.join(d, 'a.cpt');
  createCpt(p, { rows: 2, columns: 2, webWrite: true });
  setWebWriteJs(p, {
    event: 'afterload',
    js: 'var a = 1;   \nvar b = 2;',
    allowUnsafeScript: true,
  });
  const r = setWebWriteJs(p, {
    event: 'afterload',
    patchFind: 'var a = 1;\nvar b = 2;',
    patchReplace: 'var a = 10;\nvar b = 20;',
    allowUnsafeScript: true,
  });
  assert.equal(r.mode, 'patch');
  assert.equal(r.patchHits, 1);
  assert.equal(r.patchMatchedBy, 'line-ending-normalized');
  const js = webwriteListener(p, { event: 'afterload' }).listeners[0].js;
  assert.match(js, /var a = 10;/);
  assert.match(js, /var b = 20;/);
  fs.rmSync(d, { recursive: true, force: true });
});

test('set_webwrite_js: expectedSha256 接受读回的 sha', () => {
  const d = tmp();
  const p = path.join(d, 'a.cpt');
  createCpt(p, { rows: 2, columns: 2, webWrite: true });
  setWebWriteJs(p, { event: 'afterload', js: 'var a = 1;', allowUnsafeScript: true });
  const read = webwriteListener(p, { event: 'afterload' }).listeners[0];
  const r = setWebWriteJs(p, {
    event: 'afterload',
    js: 'var a = 2;',
    expectedSha256: read.sha256,
    allowUnsafeScript: true,
  });
  assert.ok(['replace', 'update'].includes(r.mode), `mode=${r.mode}`);
  assert.match(webwriteListener(p, { event: 'afterload' }).listeners[0].js, /var a = 2;/);
  fs.rmSync(d, { recursive: true, force: true });
});
