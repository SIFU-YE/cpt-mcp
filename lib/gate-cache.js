// cpt-mcp/lib/gate-cache.js —— 门禁/校验结论缓存（2026-11-12 P0-2）
//
// 为什么：v1 报表会话里 quality_gate_cpt 原始输出平均 28.9KB/次，且大量调用是
// “文件没变、参数没变，再跑一遍看结论”。重复跑既慢又费上下文。
//
// 口径：**只缓存结论，不缓存文件内容**；缓存键 = 工具名 + 绝对路径 + 规范化参数；
// 失效判据 = 模板文件内容 sha256/size + 引擎报告文件状态 + 本地 SQLite 库文件状态
// （后两者决定 engineCheck / localSqlAudit 结论，不能只看 .cpt 有没有变）。
// TTL 默认 10 分钟（CPT_MCP_GATE_CACHE_TTL_MS，0/负数=关闭）；最多 200 条，LRU 淘汰。
// 进程内 Map：不跨进程/会话共享，DSH 重启即清空。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { localDbRoot } from './localdb.js';

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const MAX_ENTRIES = 200;

const cache = new Map(); // key -> { at, fp, result }

function ttlMs() {
  const raw = Number(process.env.CPT_MCP_GATE_CACHE_TTL_MS ?? 600000);
  return Number.isFinite(raw) ? raw : 600000;
}

/** 模板文件指纹：sha256 + size（内容相同即同指纹，mtime 变化不影响） */
export function fileFingerprint(cptPath) {
  try {
    const st = fs.statSync(cptPath);
    const buf = fs.readFileSync(cptPath);
    return `file:${st.size}:${crypto.createHash('sha256').update(buf).digest('hex')}`;
  } catch (e) {
    return `file-error:${e?.message ?? String(e)}`;
  }
}

/** 引擎报告文件状态（quality_gate 的 engineCheck / verify engine 层会读它） */
function engineReportFingerprint(cptPath) {
  const name = `${path.basename(cptPath)}.json`;
  const candidates = [
    path.join(path.dirname(cptPath), '.fr-engine-check', name),
    path.join(projectRoot, '.fr-engine-check', name),
  ];
  const parts = candidates.map((p) => {
    try {
      const st = fs.statSync(p);
      return `${st.size}:${Math.floor(st.mtimeMs)}`;
    } catch {
      return 'none';
    }
  });
  return `engine:${parts.join('|')}`;
}

/** 本地 SQLite 库状态（localSqlAudit 结论依赖库文件；建库/导入后必须失效缓存） */
function localDbFingerprint() {
  try {
    const root = localDbRoot();
    if (!fs.existsSync(root)) return 'localdb:none';
    const entries = fs.readdirSync(root)
      .filter((name) => /\.(db|sqlite|sqlite3)$/i.test(name))
      .sort()
      .map((name) => {
        try {
          const st = fs.statSync(path.join(root, name));
          return `${name}:${st.size}:${Math.floor(st.mtimeMs)}`;
        } catch {
          return `${name}:?`;
        }
      });
    return `localdb:${entries.join('|')}`;
  } catch {
    return 'localdb:error';
  }
}

/**
 * 生成完整缓存指纹。
 * @param {string} cptPath
 * @param {{engine?:boolean, localSql?:boolean}} [deps] 结论依赖的外部状态
 */
export function gateFingerprint(cptPath, deps = {}) {
  const parts = [fileFingerprint(cptPath)];
  if (deps.engine) parts.push(engineReportFingerprint(cptPath));
  if (deps.localSql) parts.push(localDbFingerprint());
  return parts.join('||');
}

function cacheKey(tool, cptPath, options) {
  return `${tool}|${path.resolve(cptPath)}|${JSON.stringify(options ?? {})}`;
}

/**
 * 读缓存。命中返回 { result, ageSeconds }；未命中返回 null。
 * @param {string} tool 工具名
 * @param {string} cptPath 模板路径
 * @param {object} options 影响结论的参数（必须规范化，且不含 brief 这类"视图开关"）
 * @param {string} fp gateFingerprint() 的结果
 */
export function cacheLookup(tool, cptPath, options, fp) {
  const ttl = ttlMs();
  if (!(ttl > 0)) return null;
  const key = cacheKey(tool, cptPath, options);
  const entry = cache.get(key);
  if (!entry) return null;
  if (entry.fp !== fp || Date.now() - entry.at > ttl) {
    cache.delete(key);
    return null;
  }
  // LRU：命中后移到队尾
  cache.delete(key);
  cache.set(key, entry);
  return { result: entry.result, ageSeconds: Math.max(0, Math.round((Date.now() - entry.at) / 1000)) };
}

/** 写缓存（超出上限先淘汰最旧条目） */
export function cacheStore(tool, cptPath, options, fp, result) {
  if (!(ttlMs() > 0)) return;
  cache.delete(cacheKey(tool, cptPath, options));
  cache.set(cacheKey(tool, cptPath, options), { at: Date.now(), fp, result });
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    cache.delete(oldest);
  }
}

/** 测试/诊断用：清空缓存 */
export function cacheClear() {
  cache.clear();
}

/** 测试/诊断用：当前缓存条目数 */
export function cacheSize() {
  return cache.size;
}
