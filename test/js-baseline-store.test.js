// test/js-baseline-store.test.js —— M124 per-key 基线 store：布局不变量 + 孤儿回收 + 迁移
//
// 【演进】M120 用单个大 JSON 存基线 → M123 发现跨进程 read→改→write 必丢更新，加了文件锁
//（本文件原名 js-baseline-lock.test.js）→ M123 结论：锁自身留了条「陈锁回收窗口」残留，
// 彻底消除需改 per-key。M124 据此改布局：**per-key 后 upsert 退化为单文件原子写，
// 丢更新不再可能 → 锁没有存在理由 → 直接删掉**，残留从「被缩小」变为「结构上不存在」。
//
// 因此本文件不再测锁行为（t2 陈锁回收 / t3 超时降级 / t4 可重入 均已随锁消失），
// 改测新布局真正要保证的不变量：
//   t1 跨进程并发写共享 store → 条目零丢失（原锁要解决的问题，现由布局结构性保证）
//   t2 孤儿中间文件必被回收（老 writeStore 实测泄漏 143 个/8.1 MB，是 M123 就存在的真缺陷）
//   t3 legacy 单文件迁移：条目不丢、且重复迁移不得把已有备份降级
//   t4 LRU 严格上限（不是「上限 + 节流窗口」的软上限）
//   t5 单条损坏只影响该模板（per-key 相对单文件的核心收益：不再殃及全库）
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { checkJsBaseline, recordJsBaseline, baselineStorePath, STORE_CAP } from '../lib/js-baseline.js';
import { createCpt } from '../lib/generate.js';
import { load } from '../lib/xml.js';
// 本文件自建临时 .cpt 并触发 save → 必须自带隔离，否则绕过 npm test 的 --import
// 直接 `node --test test/js-baseline-store.test.js` 时会往**真实用户 store** 写残留。
import '../scripts/isolate-store.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-jsbl-store-'));

/** 起一个真子进程执行 recordJsBaseline —— 跨进程场景必须用真进程，不能模拟 */
function childRecord(envStore, cptPath) {
  // Windows 上 ESM 动态 import 必须是 file:// URL（裸绝对路径会被当作协议 c: 而报错）
  const modUrl = pathToFileURL(path.join(ROOT, 'lib/js-baseline.js')).href;
  const src = `
    process.env.CPT_MCP_JS_BASELINE = ${JSON.stringify(envStore)};
    process.env.CPT_MCP_ALLOWED_ROOTS = ${JSON.stringify(path.dirname(cptPath))};
    const { recordJsBaseline } = await import(${JSON.stringify(modUrl)});
    recordJsBaseline(${JSON.stringify(cptPath)});
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', src], { cwd: ROOT, stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr?.on('data', (b) => { err += b; });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`子进程退出码 ${code}：${err.slice(0, 400)}`))));
  });
}

/** 读 per-key 目录下全部条目 → [{key, file}] */
function readAllEntries(dir) {
  const out = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    try { out.push({ ...JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')), file: f }); } catch { /* 损坏条目跳过 */ }
  }
  return out;
}

test('M124 t1：N 个子进程并发写共享 store，条目一个都不能丢', async () => {
  const dir = tmp();
  const envStore = path.join(dir, 'shared.json'); // → storeDir 剥 .json 得目录 <dir>/shared
  const storeDir = path.join(dir, 'shared');
  const N = 12;

  // 每个子进程写一份**独立**模板的基线。M123（无锁单文件）时后落盘者会用自己那份
  // 缺别人条目的快照覆盖整个文件；per-key 后每个 key 独占文件，结构上不可能互相覆盖。
  const cpts = [];
  for (let i = 0; i < N; i++) {
    const p = path.join(dir, `m${i}.cpt`);
    createCpt(p, { rows: 3, columns: 3 });
    cpts.push(p);
  }

  await Promise.all(cpts.map((p) => childRecord(envStore, p)));

  const found = new Set(readAllEntries(storeDir).map((e) => e.key));
  const missing = cpts.filter((p) => !found.has(path.resolve(p).toLowerCase()));
  assert.equal(missing.length, 0,
    `并发写丢了 ${missing.length}/${N} 条基线：${missing.map((x) => path.basename(x)).join(',')}`);
  assert.equal(found.size, N, `store 应含 ${N} 个不同 key，实际 ${found.size}`);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('M124 t2：孤儿中间文件被回收，仍在用的新鲜中间文件保留', () => {
  const dir = tmp();
  process.env.CPT_MCP_JS_BASELINE = path.join(dir, 'js-baseline.json'); // → storeDir = <dir>/js-baseline
  process.env.CPT_MCP_ALLOWED_ROOTS = dir;
  const storeDir = path.join(dir, 'js-baseline');

  // 必须**先造孤儿、再触发首次写**：legacy 中间文件清扫是「每进程每 storeDir 一次」的
  // 启动期行为（新代码不再产生 legacy tmp，只需回收历史残留），而 createCpt 的 save
  // 就是本目录的首次写 —— 顺序反了会把清扫机会提前用掉，测不出回收。
  fs.mkdirSync(storeDir, { recursive: true });
  // ① 目录内的孤儿（per-key 写进程在 rename 前被 kill 留下）
  const orphan = path.join(storeDir, 'dead.json.tmp.999.111');
  fs.writeFileSync(orphan, 'x');
  const past = new Date(Date.now() - 10 * 60 * 1000); // 10 分钟前 > TMP_STALE_MS(5min)
  fs.utimesSync(orphan, past, past);
  // ② 仍在用的新鲜中间文件 → 不得删
  const fresh = path.join(storeDir, 'live.json.tmp.888.222');
  fs.writeFileSync(fresh, 'y');
  // ③ legacy 中间文件（老 writeStore 写在父目录，M124 实测真实 store 泄漏 143 个/8.1 MB）
  const legacyDebris = path.join(dir, 'js-baseline.json.tmp.777.333');
  fs.writeFileSync(legacyDebris, 'z');
  fs.utimesSync(legacyDebris, past, past);

  const p = path.join(dir, 'a.cpt');
  createCpt(p, { rows: 3, columns: 3 }); // 本目录首次写 → ensureMigrated + maintainDir
  recordJsBaseline(p); // 再写一次，确认回收不是一次性的、也不会复活

  assert.ok(!fs.existsSync(orphan), '陈旧孤儿中间文件应被回收（否则无限累积，M123 实测 8.1 MB）');
  assert.ok(fs.existsSync(fresh), '新鲜中间文件可能是并发写入者正在用，不得误删');
  assert.ok(!fs.existsSync(legacyDebris), 'legacy 中间文件同样应回收');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('M124 t3：legacy 单文件迁移条目不丢，且重复迁移不得把已有备份降级', async () => {
  const dir = tmp();
  const envStore = path.join(dir, 'js-baseline.json'); // → storeDir = <dir>/js-baseline
  const legacy = path.join(dir, 'js-baseline.json');
  const storeDir = path.join(dir, 'js-baseline');

  // 预置 legacy：1 条待迁
  const keyA = path.join(dir, 'a.cpt').toLowerCase();
  fs.writeFileSync(legacy, JSON.stringify({ version: 1, entries: { [keyA]: { updatedAt: 1111, total: 3, byCat: { wbweb: 1, topjs: 1, repev: 1 } } } }));

  const p = path.join(dir, 'b.cpt');
  createCpt(p, { rows: 3, columns: 3 });
  await childRecord(envStore, p); // 子进程触发迁移

  // ① 条目原样迁过来
  const migrated = readAllEntries(storeDir).find((e) => e.key === keyA);
  assert.ok(migrated, 'legacy 条目应已迁入 per-key 目录');
  assert.equal(migrated.total, 3, 'total 应原样保留');
  assert.equal(migrated.byCat.wbweb, 1, 'byCat 应原样保留');
  // ② legacy 被改名（首次迁移留备份）
  assert.ok(!fs.existsSync(legacy), 'legacy 应已改名，防止重复迁移');
  assert.ok(fs.existsSync(`${legacy}.migrated`), '首次迁移应留备份');

  // ③ 重复迁移场景：legacy 被回滚/并发重生成，且内容只有 1 条（比备份残缺）
  //    若此时再 rename，会把 6 条的完整备份覆盖成 1 条 —— M124 实测真实 store 正是这样降级的
  const backup = `${legacy}.migrated`;
  const backupBefore = fs.readFileSync(backup, 'utf8');
  fs.writeFileSync(legacy, JSON.stringify({ version: 1, entries: { [keyA]: { updatedAt: 2222, total: 1, byCat: { wbweb: 1 } } } }));
  await childRecord(envStore, p); // 新进程再走一次 ensureMigrated

  assert.ok(!fs.existsSync(legacy), '重复迁移后 legacy 也应被清掉');
  assert.equal(fs.readFileSync(backup, 'utf8'), backupBefore, '重复迁移不得覆盖降级已有备份');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('M124 t4：LRU 严格上限（不得退化成「上限+节流窗口」软上限）', () => {
  const dir = tmp();
  process.env.CPT_MCP_JS_BASELINE = path.join(dir, 'cap.json'); // → storeDir = <dir>/cap
  process.env.CPT_MCP_ALLOWED_ROOTS = dir;
  const storeDir = path.join(dir, 'cap');
  fs.mkdirSync(storeDir, { recursive: true });

  // 预置 STORE_CAP + 10 个假条目（文件名+ mtime 即足够，maintainDir 不解析内容）
  const OVER = 10;
  const base = Date.now() - 3600_000;
  for (let i = 0; i < STORE_CAP + OVER; i++) {
    const f = path.join(storeDir, `${String(i).padStart(4, '0')}.json`);
    fs.writeFileSync(f, JSON.stringify({ key: `k${i}`, updatedAt: base + i, total: 1, byCat: {} }));
    const t = new Date(base + i * 1000);
    fs.utimesSync(f, t, t);
  }

  const p = path.join(dir, 'x.cpt');
  createCpt(p, { rows: 3, columns: 3 });
  recordJsBaseline(p); // 一次真实写 → 触发 maintainDir

  const left = fs.readdirSync(storeDir).filter((n) => n.endsWith('.json')).length;
  assert.ok(left <= STORE_CAP, `超量后应被压到 ≤${STORE_CAP}，实际 ${left}（若 >${STORE_CAP} 说明节流成了软上限）`);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('M124 t5：单条基线损坏只影响该模板，不殃及全库', () => {
  const dir = tmp();
  process.env.CPT_MCP_JS_BASELINE = path.join(dir, 'one.json'); // → storeDir = <dir>/one
  process.env.CPT_MCP_ALLOWED_ROOTS = dir;

  const pa = path.join(dir, 'a.cpt');
  const pb = path.join(dir, 'b.cpt');
  createCpt(pa, { rows: 3, columns: 3 });
  createCpt(pb, { rows: 3, columns: 3 });
  recordJsBaseline(pa);
  recordJsBaseline(pb);

  // 腐蚀 a 的条目文件（老单文件布局下，这会让**整个 store** 读不出来 → 全库退回首见重建）
  const storeDir = baselineStorePath();
  const target = readAllEntries(storeDir).find((e) => e.key === path.resolve(pa).toLowerCase());
  assert.ok(target, 'a 的基线文件应存在');
  fs.writeFileSync(path.join(storeDir, target.file), '{ 这不是合法 JSON', 'utf8');

  // a → 损坏按"无基线"处理（首见重建），不抛错
  const ra = checkJsBaseline(pa, load(pa).parsed);
  assert.equal(ra.known, false, '损坏条目应按首见处理，不抛异常');
  // b → 完全不受影响，仍可正常比对
  const rb = checkJsBaseline(pb, load(pb).parsed);
  assert.equal(rb.known, true, '同库另一条目不得被殃及');
  assert.equal(rb.loss, false, 'b 的基线语义应正常');

  fs.rmSync(dir, { recursive: true, force: true });
});
