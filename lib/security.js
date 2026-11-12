// cpt-mcp/lib/security.js
// MCP 边界层安全策略：把“模型能传什么路径/脚本/外部链接”从提示词升级为运行时硬闸。
// 默认只允许当前项目和系统临时目录；生产环境可通过 CPT_MCP_ALLOWED_ROOTS 显式配置。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DESTRUCTIVE_TOOLS, READ_ONLY_TOOLS } from './contract.js';

const PROTECTED_SEGMENTS = new Set(['.git', 'node_modules']);

function normalized(p) {
  return path.resolve(p).replace(/[\\/]+$/, '').replaceAll('\\', '/').toLowerCase();
}

function within(candidate, root) {
  const c = normalized(candidate);
  const r = normalized(root);
  return c === r || c.startsWith(`${r}/`);
}

function realPathForCheck(abs) {
  if (fs.existsSync(abs)) return fs.realpathSync.native(abs);
  let current = abs;
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) return abs;
    current = parent;
  }
  return path.join(fs.realpathSync.native(current), path.relative(current, abs));
}

export function allowedRoots() {
  const configured = String(process.env.CPT_MCP_ALLOWED_ROOTS || '')
    .split(path.delimiter).map((v) => v.trim()).filter(Boolean);
  const roots = configured.length ? configured : [process.cwd(), os.tmpdir()];
  // Windows 可能把 long path 的真实路径返回成 8.3 短路径（例如
  // FrontSight -> FRONT~1）。根目录和候选路径必须使用同一套 realpath，
  // 否则合法临时文件会被误判为越界。
  return [...new Set(roots.map((r) => realPathForCheck(path.resolve(r))))];
}

function hasProtectedSegment(abs) {
  return abs.split(/[\\/]+/).some((part) => PROTECTED_SEGMENTS.has(part.toLowerCase()));
}

function frHomes() {
  const env = String(process.env.FR_HOME || '').trim();
  const candidates = [];
  if (env && path.isAbsolute(env)) candidates.push(path.resolve(env));
  for (const base of [process.env.ProgramFiles, process.env['ProgramFiles(x86)']]) {
    if (base) {
      candidates.push(path.join(base, 'FineReport_11.0'), path.join(base, 'FineReport_10.0'));
    }
  }
  return [...new Set(candidates.filter((candidate) => fs.existsSync(candidate)))];
}

function isUnderFrHome(abs) {
  return frHomes().some((home) => within(realPathForCheck(abs), realPathForCheck(home)));
}

/**
 * MCP 工具的 CPT 路径硬闸。
 * fr_decompile / fr_engine_check / fr_inspect 的输入可读 FR_HOME 内官方样本，
 * 但禁止任何普通写工具直接修改 FR_HOME。
 */
export function assertToolPath(toolName, inputPath, { write = !READ_ONLY_TOOLS.has(toolName) } = {}) {
  if (typeof inputPath !== 'string' || !inputPath.trim()) throw new Error('路径不能为空');
  if (inputPath.includes('\0')) throw new Error('路径包含非法 NUL 字符');
  const abs = path.resolve(inputPath);
  // Windows 特殊路径：NTFS 备用数据流（file.cpt:ads —— 写入后内容对常规读取不可见）、
  // 结尾点/空格（Win32 会静默剥掉，造成路径混淆）
  if (process.platform === 'win32') {
    const colon = abs.indexOf(':', 2);
    if (colon >= 0) throw new Error(`安全围栏：路径包含 NTFS 备用数据流或非法盘符语法 ${abs}`);
    const base = path.basename(abs);
    if (/[. ]$/.test(base)) throw new Error(`安全围栏：路径结尾不允许 . 或空格（Win32 会静默剥离）${abs}`);
  }
  if (hasProtectedSegment(abs)) throw new Error(`安全围栏：禁止访问受保护路径 ${abs}`);

  const frReadException = ['fr_decompile', 'fr_engine_check', 'fr_inspect'].includes(toolName) && isUnderFrHome(abs);
  // 2026-10-27 P1-5（审计 C 类 1 条）：FR_HOME 的官方模板样本目录（webapps/webroot/WEB-INF/reportlets/**）
  // 对所有**只读**工具放行——模型需要对照官方样本（如 doc/Advanced）核对形态；写入仍一律拒绝。
  const frSampleRead = !write && isUnderFrHome(abs) && /[\\/]reportlets[\\/]/i.test(abs);
  if (write && isUnderFrHome(abs)) {
    throw new Error(`安全围栏：禁止写入 FineReport 安装目录 ${abs}；FR 目录仅可用于只读逆向/反编译输入`);
  }
  if (!frReadException && !frSampleRead && !allowedRoots().some((root) => within(realPathForCheck(abs), root))) {
    throw new Error(
      `安全围栏：路径不在允许目录内 ${abs}。默认允许当前项目与临时目录；` +
      '如需其他目录，请设置 CPT_MCP_ALLOWED_ROOTS（用分号分隔绝对路径）'
    );
  }
  return abs;
}

export function assertDecompileOutput(inputPath, outDir) {
  // outDir 缺省时也必须校验 —— decompileCpt 的默认输出是 <cpt 同目录>/.decompiled/，
  // 当输入是 FR_HOME 内官方样本时，缺省路径会写进 FineReport 安装目录（违反只读契约）。
  // 因此这里按「实际将写入的目录」做校验，而不是在 outDir 为空时直接放行。
  const absInput = path.resolve(inputPath);
  const absOut = path.resolve(outDir ?? path.join(path.dirname(absInput), '.decompiled'));
  if (hasProtectedSegment(absOut)) throw new Error(`安全围栏：反编译输出不能写入受保护路径 ${absOut}`);
  // FR 安装目录只读是无例外的硬边界（输入豁免只覆盖「读」）
  if (isUnderFrHome(absOut)) {
    throw new Error(`安全围栏：反编译输出不能写入 FineReport 安装目录 ${absOut}；请显式传 outDir 指向允许目录或 CPT 同级 .decompiled 之外的位置`);
  }
  const safeDefault = path.join(path.dirname(absInput), '.decompiled');
  const allowed = allowedRoots().some((root) => within(realPathForCheck(absOut), root));
  const localDecompiled = within(absOut, safeDefault);
  if (!allowed && !localDecompiled) {
    throw new Error(`安全围栏：反编译输出目录不在允许目录内 ${absOut}`);
  }
}

/**
 * 校验写入 CPT 的 Excel 数据源引用。
 * fromEnv=true 只允许 FR webroot 下的相对路径，fromEnv=false 才允许本机绝对路径，
 * 且绝对路径仍受 allowedRoots 约束。这样模型不能借助 Excel 数据集读取任意文件。
 */
export function assertDataFilePath(dataFile, { fromEnv = true } = {}) {
  if (typeof dataFile !== 'string' || !dataFile.trim()) throw new Error('数据文件路径不能为空');
  const p = dataFile.trim();
  // 段级判断（「报表..cpt」是合法文件名；「..」作为整段才是路径穿越）
  const segments = p.split(/[\\/]+/);
  if (p.includes('\0') || segments.includes('..') || hasProtectedSegment(p)) {
    throw new Error('安全围栏：数据文件路径包含非法或受保护路径片段');
  }
  const absolute = /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('\\\\') || p.startsWith('/');
  if (fromEnv) {
    if (absolute || p.startsWith('file:')) {
      throw new Error('安全围栏：fromEnv=true 时数据文件必须是相对 %FR_HOME%/webapps/webroot 的路径');
    }
    return p;
  }
  if (!absolute && !p.startsWith('file:')) {
    throw new Error('安全围栏：fromEnv=false 时数据文件必须是绝对路径');
  }
  return assertToolPath('add_file_dataset', p.replace(/^file:/i, ''), { write: false });
}

export function assertSafeExternalUrl(value) {
  let u;
  try { u = new URL(String(value).trim()); } catch { throw new Error('外部链接必须是合法的 http:// 或 https:// URL'); }
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('安全围栏：只允许 http/https 外部链接');
  if (u.username || u.password) throw new Error('安全围栏：外部链接不允许携带用户名或密码');
  if (String(value).length > 2048) throw new Error('外部链接过长（最多 2048 字符）');
  return u.toString();
}

export function looksLikeScript(value) {
  return /<script\b|javascript\s*:|\b(?:eval|fetch|XMLHttpRequest|document\.|window\.|location\.|localStorage\.)/i.test(String(value || ''));
}

// P2-1 关键整数断言：z.coerce.number 会把 ""/"  "/true 静默转成 0/1（Number("")===0）。
// 单元格坐标 column/row 传空串会静默读写第 0 列/行，必须显式拒绝；数字与纯数字字符串照常放行。
// 覆盖顶层参数与批量 items/targets（含 target 嵌套一层）；只读/写入工具统一生效。
const CRITICAL_INT_FIELDS = new Set(['column', 'row']);
export function assertCriticalIntParams(toolName, args) {
  if (!args || typeof args !== 'object') return;
  const check = (obj) => {
    if (!obj || typeof obj !== 'object') return;
    for (const key of CRITICAL_INT_FIELDS) {
      const value = obj[key];
      if (value === undefined) continue;
      if (typeof value === 'string' && value.trim() === '') {
        throw new Error(
          `参数断言：${toolName}.${key} 不接受空字符串（z.coerce 会静默转成 0 导致读写错列/行；请传 0 起的整数或纯数字字符串）`
        );
      }
      if (typeof value === 'boolean') {
        throw new Error(
          `参数断言：${toolName}.${key} 不接受布尔值（z.coerce 会静默转成 0/1；请传 0 起的整数）`
        );
      }
    }
  };
  check(args);
  for (const listKey of ['items', 'targets']) {
    const list = args[listKey];
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      if (!item || typeof item !== 'object') continue;
      check(item);
      check(item.target);
    }
  }
}

export function assertUnsafeScriptAllowed(toolName, enabled) {
  if (enabled === true || String(process.env.CPT_MCP_ALLOW_UNSAFE_SCRIPT).toLowerCase() === 'true' || process.env.CPT_MCP_ALLOW_UNSAFE_SCRIPT === '1') return;
  throw new Error(`安全围栏：${toolName} 写入可执行 JavaScript 已阻止。仅在明确确认风险后传 allowUnsafeScript=true，或设置 CPT_MCP_ALLOW_UNSAFE_SCRIPT=1`);
}

export function securityPolicy() {
  return {
    allowedRoots: allowedRoots(),
    unsafeScriptEnabled: process.env.CPT_MCP_ALLOW_UNSAFE_SCRIPT === '1' || String(process.env.CPT_MCP_ALLOW_UNSAFE_SCRIPT).toLowerCase() === 'true',
    // 披露列表刻意不含 '.git'：.git 仍在围栏 PROTECTED_SEGMENTS 中被拦截（安全必需，
    // 防读取 .git/config 等凭据/元数据），但模型可见面要保持零 git 字样（MCP 专业化）。
    protectedSegments: [...PROTECTED_SEGMENTS].filter((s) => s !== '.git'),
    destructiveTools: [...DESTRUCTIVE_TOOLS].sort(),
    readOnlyTools: [...READ_ONLY_TOOLS].sort(),
  };
}
