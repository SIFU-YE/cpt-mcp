// cpt-mcp/lib/js-baseline.js —— JS 块数基线（M120；M124 改 per-key 布局以消掉锁残留）
//
// 【背景·实际事故】2026-09-27：run_fr_engine_check 旧探针把引擎导出覆写回源 .cpt
//（roundTrip 与输入同路径），FR writer 重序列化时丢 WorkBook 级 TopJS「售价跟随规格」
// 整块（约 150 行；CDATA 270→269、JS 块 48→47）。validate/quality_gate 全绿放行——
// 两道门禁都不盘点「JS 块数基线」，整块丢失在结构层完全不可见。
//
// 【语义】
//   - 基线建立：validate/quality_gate 首见某路径时记录（validate 报一条 info，仅一次）
//   - 基线刷新：cpt-mcp 自身写盘（xml.js save）成功后自动刷新；无丢失时的增长也刷新
//     （增长不是丢失信号，保持基线新鲜可避免设计器侧加块带来的长期噪声）
//   - 丢失拦截：任一分类计数减少 → validate 报 error（进 gate blocker），基线保持不动。
//     丢失确认后的处置：①经 cpt-mcp 写入工具重做删除（save 自动刷新基线）；
//     ②外部有意修改：删除 %LOCALAPPDATA%\cpt-mcp\js-baseline\ 下**该模板对应的那一个**
//     基线文件（文件内容的 key 字段即模板路径，便于反查）后重跑 validate 重建。
//
// 分类口径（对单元格级聚合计数，避免格坐标变化造成噪声）：
//   wbweb / webwr:<sheet> / topjs:<sheet> / repev:<sheet> /
//   webpg:<sheet> / webpg:@workbook / webview:@workbook / celljs:<sheet> /
//   toolbar:<sheet> / toolbar:page / toolbar:view
// 注意：分类粒度刻意不细分到事件名/格坐标——本模块只回答一个问题：
// 「块是不是整批消失了」，不是变更审计。
// （2026-11-03 C-A：补模板级 WebPageContent/WebViewContent 事件与 page/view 工具栏宿主后新增的
//  webpg:@workbook / webview:@workbook / toolbar:page / toolbar:view 四类。新分类只在当前计数
//  出现、旧基线没有 → 走「无丢失的增长」静默刷新，不会误报丢失。）
//
// 【布局·M124】per-key 文件：store 是**目录**，每个被跟踪的模板一个
// `<sha1(路径)>.json`，内容 {key, updatedAt, total, byCat}。
//
// 为什么不再是「单个大 JSON + 文件锁」（M120→M123 的形态）：
//   M123 发现单文件 read→改→write 在多进程下必丢更新，遂加文件锁。锁已修好
//   跨进程丢更新，但**锁自身的陈锁回收**留了条如实记录的残留边界——
//   「statSync 判定陈锁」与「unlinkSync 真正删掉」之间存在毫秒级窗口，
//   两个进程可能同时拿到锁。M123 结论是「要彻底消除需改 per-key 布局，本轮未采纳」。
//   M124 照此执行：per-key 后 upsert 退化为「单文件原子写」（tmp + rename），
//   **不同 key 物理上互不相干 → 丢更新不再可能 → 锁没有存在理由 → 直接删掉**。
//   残留边界因此不是被缩小，而是**结构上不存在**（没有锁，就没有锁的窗口）。
//   同理也去掉了：可重入簿记（lockDepth）、陈锁回收、超时降级 2s 自旋 ——
//   save() 主写入路径不再有任何自旋等待。
//
// 仍然存在的窄边界（如实记录，且 M123 的锁**同样挡不住**，非本次引入）：
//   两个进程同时触碰**同一个** .cpt 时，checkJsBaseline 用调用方传入的 parsed 判定，
//   若其中一方的 parsed 已落后于磁盘现状，它可能把「偏高」的快照写回。
//   锁只能串行化 store 的读写，无法让已过时的 parsed 变新鲜 —— 这是快照语义的固有边界，
//   真要关闭需给 load() 增加 mtime 并让调用方一路透传（动 load() 契约 + 2 处调用方），
//   属另一件事，本轮未动。
//
// 【并发安全】写入用「唯一 tmp + rename」：rename 在同卷内是原子的，读者永远只会
// 看到完整旧文件或完整新文件，不会读到半截 JSON。Windows 上目标正被并发读时 rename
// 可能 EPERM/EBUSY → 退避重试 3 次；仍失败则放弃本次刷新（下次 save/validate 会补上），
// 绝不阻塞主写入路径。

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { load } from './xml.js';
import { jsBlocks } from './cpt.js';
// 2026-10-29 依赖倒置：写盘后刷新基线由 write-hooks 订阅完成（xml.js 不再 import 本模块，
// 消除 xml → js-baseline → cpt → xml 的 ESM 静态环）。
import { registerWriteHook } from './write-hooks.js';
import { normalizePath as normalizedPath } from './path-util.js';

/** per-key 文件数上限（按 mtime 淘汰最旧）；导出以便测试断言，避免魔数漂移 */
export const STORE_CAP = 500;
const RENAME_RETRY = 3;
const RENAME_RETRY_MS = 5;

/**
 * store 根**目录**（M124 起不再是单个 .json 文件）。
 * 老配置若把 CPT_MCP_JS_BASELINE 指向 `*.json` 文件路径，这里剥掉 `.json` 当目录用——
 * 这样 `<dir>/x.json`（旧单文件）自然成为 `<dir>/x`（新目录）的 legacy 迁移源。
 */
function storeDir() {
  let p;
  if (process.env.CPT_MCP_JS_BASELINE) {
    p = path.resolve(process.env.CPT_MCP_JS_BASELINE);
  } else if (process.platform === 'win32') {
    p = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'cpt-mcp', 'js-baseline');
  } else {
    p = path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state'), 'cpt-mcp', 'js-baseline');
  }
  return p.toLowerCase().endsWith('.json') ? p.slice(0, -5) : p;
}

/** M124 起返回 store 目录路径（老调用方用 existsSync 判断「基线库是否已落盘」仍然成立） */
export function baselineStorePath() {
  return storeDir();
}

/** 旧单文件 store（M123 及更早），作只读迁移源 */
function legacyStorePath() {
  return `${storeDir()}.json`;
}


function entryPath(key) {
  const hash = crypto.createHash('sha1').update(key, 'utf8').digest('hex');
  return path.join(storeDir(), `${hash}.json`);
}

function sleepSync(ms) {
  // Node 主线程允许 Atomics.wait，用于无依赖的同步退避
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

const migratedDirs = new Set();
const TMP_STALE_MS = 5 * 60 * 1000; // 中间文件正常存活毫秒级，超过 5 分钟必是孤儿

/**
 * 一次性把旧单文件 store 的条目迁到 per-key 文件。
 * - 逐条迁移且**已存在的 key 不覆盖**：迁移期间另一个进程可能已经写入了更新的基线，
 *   用旧快照覆盖等于把刚刷新的基线又改回陈旧值。
 * - 收尾改名为 `*.migrated`（而非删除）：留备份，且防止下次重复迁移。
 * - **重复迁移必须删而非再 rename**：若 `.migrated` 已在（legacy 被回滚/并发重生成），
 *   再 rename 会把首次迁移的完整备份覆盖成本次的残缺子集 —— M124 实测真实 store
 *   由 6 条降级成 1 条。per-key 目录才是唯一权威，legacy 只是迁移源，删掉不丢信息。
 * 注意本函数**没有 early return**：即使 legacy 不存在也要走到末尾清 legacy 中间产物。
 */
function ensureMigrated() {
  const dir = storeDir();
  if (migratedDirs.has(dir)) return;
  migratedDirs.add(dir);
  let entries = null;
  try {
    const raw = JSON.parse(fs.readFileSync(legacyStorePath(), 'utf8'));
    if (raw && typeof raw === 'object' && raw.entries && typeof raw.entries === 'object') entries = raw.entries;
  } catch { /* 不存在 / 损坏 → 无旧数据可迁 */ }

  if (entries) {
    for (const [key, entry] of Object.entries(entries)) {
      if (!entry || !entry.byCat) continue;
      let exists = false;
      try { exists = fs.existsSync(entryPath(key)); } catch { /* 判不了就当不存在 */ }
      if (exists) continue; // 已有更新的 per-key 基线，别用旧快照覆盖
      writeEntry(key, { key, updatedAt: entry.updatedAt || Date.now(), total: entry.total, byCat: entry.byCat });
    }
    try {
      const flag = `${legacyStorePath()}.migrated`;
      if (fs.existsSync(flag)) fs.unlinkSync(legacyStorePath()); // 重复迁移：备份已在，别覆盖降级
      else fs.renameSync(legacyStorePath(), flag); // 首次迁移：留备份
    } catch { /* 并发者已处理 */ }
  }

  sweepLegacyDebris(dir);
}

/**
 * 清掉旧单文件格式的中间产物 `<legacy>.tmp.*`。
 *
 * 老 `writeStore()` 的 tmp 是 `js-baseline.json.tmp.<pid>.<ts>`，写在 store 的**父目录**里；
 * 它在 rename 或随后的 unlink 双双被占用、或进程被 `node --test` 收尾强杀时会静默留下 ——
 * M124 实测真实 store 已累积 143 个 / 8.1 MB，且没有任何机制回收。
 * 超过 TMP_STALE_MS 才删：正常 tmp 生命周期毫秒级，未满阈值的可能是并发写入者正在用。
 */
function sweepLegacyDebris(dir) {
  const prefix = `${path.basename(legacyStorePath())}.tmp.`;
  let names;
  try { names = fs.readdirSync(path.dirname(dir)); } catch { return; }
  const now = Date.now();
  for (const n of names) {
    if (!n.startsWith(prefix)) continue;
    const f = path.join(path.dirname(dir), n);
    try {
      if (now - fs.statSync(f).mtimeMs > TMP_STALE_MS) fs.unlinkSync(f);
    } catch { /* 被占用 → 下次进程启动再扫 */ }
  }
}

/** 读单个 key 的基线；缺失/损坏/键不符 → null（视为无基线） */
function readEntry(key) {
  try {
    const raw = JSON.parse(fs.readFileSync(entryPath(key), 'utf8'));
    if (raw && typeof raw === 'object' && raw.byCat && raw.key === key) return raw;
  } catch { /* 缺失/损坏 → 视为无基线；损坏只影响这一个模板，不再殃及全库 */ }
  return null;
}

/**
 * 每次写入后的目录维护：① 清孤儿中间文件 ② 超 LRU 上限时按 mtime 淘汰最旧。
 *
 * 刻意不做节流，理由是它比 M123 被替换掉的实现**更便宜**：老 writeStore 每次写都要
 * 对全库 entries 排序（O(n log n)）再 JSON.stringify 62 KB；这里只 readdir 一次（O(n)，
 * 且仅在真的超量时才逐个 stat），孤儿 tmp 数量通常为 0。
 * LRU 因此是**严格上限**（老实现也是严格上限），而非「上限 + 节流窗口」的软上限。
 */
function maintainDir(dir) {
  let names;
  try { names = fs.readdirSync(dir); } catch { return; }
  const now = Date.now();
  const entries = [];
  for (const n of names) {
    if (n.endsWith('.json')) { entries.push(n); continue; }
    if (!n.includes('.tmp.')) continue;
    // per-key 中间文件：<hash>.json.tmp.<pid>.<ts> —— 写进程在 writeFileSync 之后、
    // renameSync 之前被 kill，或 rename/unlink 双双被占用，即成孤儿
    const f = path.join(dir, n);
    try {
      if (now - fs.statSync(f).mtimeMs > TMP_STALE_MS) fs.unlinkSync(f);
    } catch { /* 正在用 → 下次再扫 */ }
  }
  if (entries.length <= STORE_CAP) return;
  const items = [];
  for (const n of entries) {
    try { items.push({ n, mtime: fs.statSync(path.join(dir, n)).mtimeMs }); } catch { /* 消失了就跳过 */ }
  }
  items.sort((a, b) => a.mtime - b.mtime); // 最旧在前
  for (const item of items.slice(0, Math.max(0, items.length - STORE_CAP))) {
    try { fs.unlinkSync(path.join(dir, item.n)); } catch { /* 已被并发删掉 */ }
  }
}

/** 原子写单个 key；失败返回 false（不抛，绝不阻塞 save 主路径） */
function writeEntry(key, entry) {
  const dir = storeDir();
  try { fs.mkdirSync(dir, { recursive: true }); } catch { return false; }
  const target = entryPath(key);
  const tmp = `${target}.tmp.${process.pid}.${Date.now()}`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(entry), 'utf8');
  } catch {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    return false;
  }
  for (let attempt = 0; attempt < RENAME_RETRY; attempt++) {
    try {
      fs.renameSync(tmp, target);
      maintainDir(dir);
      return true;
    } catch {
      if (attempt === RENAME_RETRY - 1) {
        try { fs.unlinkSync(tmp); } catch { /* ignore */ }
        return false;
      }
      sleepSync(RENAME_RETRY_MS); // Windows：目标正被并发读 → 退避重试
    }
  }
  return false;
}

function upsert(key, snap) {
  ensureMigrated();
  writeEntry(key, { key, updatedAt: Date.now(), total: snap.total, byCat: snap.byCat });
}

/** 从已解析模板统计 JS 块分类计数（容器 → 稳定分类键） */
export function snapshotJsCounts(parsed) {
  const byCat = {};
  const bump = (k) => { byCat[k] = (byCat[k] || 0) + 1; };
  for (const b of jsBlocks(parsed)) {
    const c = String(b.container ?? '');
    if (c === '填报事件') bump('wbweb');
    else if (c.startsWith('填报事件:')) bump(`webwr:${c.slice('填报事件:'.length)}`);
    // webpg:@workbook = 模板级分页预览 WebPageContent 事件（C-A 补齐；官方 50 份实测）。
    // 与表级 webpg:<sheet> 同前缀、不同键：块在哪个容器丢失都要能被数出来。
    else if (c.startsWith('webpage:')) bump(`webpg:${c.slice('webpage:'.length)}`);
    else if (c.startsWith('webview:')) bump(`webview:${c.slice('webview:'.length)}`);
    else if (c.startsWith('报表事件:')) {
      const sheet = c.slice('报表事件:'.length);
      bump(String(b.location ?? '').endsWith('/TopJS') ? `topjs:${sheet}` : `repev:${sheet}`);
    } else if (c.startsWith('单元格:')) {
      const i = c.indexOf(':(');
      bump(`celljs:${i > 4 ? c.slice('单元格:'.length, i) : c.slice('单元格:'.length)}`);
    } else if (c.startsWith('工具栏:')) bump(`toolbar:${c.slice('工具栏:'.length)}`);
    else bump(`other:${c}`);
  }
  return { total: Object.values(byCat).reduce((n, x) => n + x, 0), byCat };
}

/** 强制刷新基线（xml.js save 成功后的钩子；文件自身即最新事实） */
export function recordJsBaseline(p) {
  try {
    const { parsed } = load(p);
    upsert(normalizedPath(p), snapshotJsCounts(parsed));
  } catch { /* 尽力而为：基线刷新失败不影响写入结果 */ }
}

// 订阅 xml.js 的写盘后钩子（模块求值即注册；未 import 本模块的轻量脚本不参与基线刷新，
// 与改造前"xml.js 静态 import 本模块"在 server 运行时等价）。
registerWriteHook(recordJsBaseline);

/**
 * 复位单个模板的 JS 块基线：删掉该模板的 per-key 条目，再按**当前文件**重建基线。
 *
 * 【为什么需要（2026-11-03 审计 C-C）】sandbox16 会话 11:49:45 session-b9ea67ca 写坏块后重做，
 * 门禁按旧基线报"块数较基线减少"blocker；模型试图
 * `delete_file %LOCALAPPDATA%\cpt-mcp\js-baseline\<sha>.json` 被"路径在工作区外"拒绝，
 * 只能 git_rollback + 重写块绕行。基线条目是 MCP 自有的缓存，不该逼模型（或人）去人不可达的
 * AppData 路径删文件 —— 因此给 validate_cpt / quality_gate_cpt 一个显式开关。
 *
 * 【语义边界（不改变既有丢失告警）】
 *   · 只在调用方显式传 resetJsBaseline:true 时调用；常规 validate/gate 路径完全不变；
 *   · per-key 布局下不同模板物理隔离，只删 `normalizedPath(path)` 这一个 key，
 *     **不会**误伤其他模板的基线条目；
 *   · 删完立即按当前 parsed 重建 —— 复位后"当前计数即基线"，不再报丢失；
 *   · 返回旧计数摘要（previous）供模型/人确认"这次放过了多少块"，不静默。
 *
 * @param {string} p .cpt 路径
 * @param {object} [parsed] 可选：调用方已解析的树（省一次 load）；缺省现读文件
 * @returns {{reset:boolean, key:string, hadBaseline:boolean, previous:null|{total:number,byCat:object}, current:{total:number,byCat:object}, hint:string}}
 */
export function resetJsBaseline(p, parsed) {
  ensureMigrated();
  const key = normalizedPath(p);
  const before = readEntry(key);
  const tree = parsed ?? load(p).parsed;
  const current = snapshotJsCounts(tree);
  // 先删本模板条目（ENOENT 视为已删；per-key 文件被占用等异常交给上层按错误处理，
  // 不静默吞 —— 复位失败却谎报成功会让门禁结论不可信）。
  try {
    fs.unlinkSync(entryPath(key));
  } catch (e) {
    if (e?.code !== 'ENOENT') throw new Error(`JS 块基线复位失败（删除本模板条目时出错：${e?.message ?? e}）`);
  }
  upsert(key, current);
  return {
    reset: true,
    key,
    hadBaseline: Boolean(before),
    previous: before ? { total: before.total, byCat: before.byCat } : null,
    current,
    hint: '仅在本模板 JS 块确实是有意删减（外部工具/设计器有意删块，或写坏块后已重做）时使用；复位后基线=当前文件，不再报丢失。',
  };
}
export function checkJsBaseline(p, parsed) {
  ensureMigrated(); // 首次读之前必须迁移，否则旧库条目会被当成"首见"重建，静默吞掉真实丢失
  const key = normalizedPath(p);
  const current = snapshotJsCounts(parsed);
  const base = readEntry(key);
  if (!base) {
    upsert(key, current);
    return { known: false, loss: false, decreased: [], grew: false, current };
  }
  const cats = new Set([...Object.keys(base.byCat), ...Object.keys(current.byCat)]);
  const decreased = [];
  let grew = false;
  for (const cat of cats) {
    const b = base.byCat[cat] || 0;
    const n = current.byCat[cat] || 0;
    if (n < b) decreased.push({ cat, base: b, now: n });
    else if (n > b) grew = true;
  }
  if (decreased.length === 0) {
    // 无丢失（含纯增长/结构不变）：刷新基线到当前状态，避免陈旧噪声
    upsert(key, current);
  }
  // 有丢失：基线保持不动，等人工确认或经 cpt-mcp 写入路径自然刷新
  return { known: true, loss: decreased.length > 0, decreased, grew, current };
}
