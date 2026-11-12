// cpt-mcp/lib/fr-preview.js —— 本地「独立 FR 报表实例」（完全复刻 FR 设计器内核，headless）
//
// 目标（2026-10-29）：用本机 FineReport 11 设计器自带的 **同一套内核**（jre + fine-*.jar +
// Tomcat 9 + webapps/webroot 决策系统 + 设计器 finedb 快照）在 127.0.0.1 拉起一个**独立**的
// 报表服务实例，用于「复查样式 / 检查功能」：
//   · 真实 FR 渲染（分页、表头、样式、填报控件）——不是模拟 DOM；
//   · 真实 afterload / 工具栏 JS 执行（浏览器里就是 FR 预览页）；
//   · 真实填报提交、导出、Excel 导入等按钮（要落库还需目标表 + 数据连接存在）。
//
// 与 `run_fr_engine_check`（只加载模板做引擎校验）的分工：
//   · 引擎校验 = 静态加载 + 导出重读（快，~10s，回答「设计器能不能打开」）；
//   · 本模块 = 起一个完整报表服务（~30-60s，回答「打开后长什么样、按钮能不能用」）。
//
// 设计约束（对齐 cpt-mcp 既有安全策略）：
//   1. **FR 安装目录只读**：只从 FR_HOME 读 jar/webroot/conf；一切可写目录（conf、logs、temp、
//      webapps）都落在 `CPT_MCP_FR_PREVIEW_HOME`（默认 `<repo>/.fr-preview`）。
//   2. 独立实例：CATALINA_BASE 独立、端口独立（默认随机空闲端口）、finedb 独立副本，
//      不碰用户既有的 8080/8075 服务，也不改 FR_HOME 下的任何文件。
//   3. 平台配置（管理员账号 / 数据连接）持久化在 `.fr-preview/finedb-seed/`：
//      首次启动可自动初始化本地超管 admin（默认口令见 previewIdentityConfig）/ 也可用浏览器
//      打开 platformUrl 手动配置数据连接，`stop` 时自动回写种子；之后每次 start 直接复用。
//   4. 幂等：同一时刻只维护一个预览实例；重复 start 会复用活着的实例，只替换 reportlet。
//   5. 生命周期可控：state.json 记录 pid/端口；stop 走 Tomcat 优雅关闭，超时才强杀；
//      启动前会清理同一预览目录下的残留 java 进程，避免 finedb 锁竞争。
//   6. 内置参数（$fine_username 等）默认 **admin 伪装**：本地实例就绪后自动用平台超管登录，
//      预览 URL 先经本地入口页写会话 Cookie 再跳转，因此 $fine_username/$fine_userid/
//      $fine_role/$fine_position/$fine_display_name 在预览里解析为 admin；只对 127.0.0.1 生效，
//      可用 CPT_MCP_FR_PREVIEW_IMPERSONATE=off 退回匿名预览。
//
// 命令行入口：node scripts/fr-preview.mjs start|stop|status <cpt> [--port N] [--json]
// MCP 工具：start_fr_preview / stop_fr_preview / fr_preview_status（租约族 fr_preview）

import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { platform } from 'node:os';
import { fileURLToPath } from 'node:url';
import { detectFrHome } from './fr-decompile.js';
import { inspectPreviewFinedb } from './preview-local-guard.js';
import { applyLocalConnectionsToFinedb } from './preview-local-config.js';

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const isWin = platform() === 'win32';
const PATH_SEP = isWin ? ';' : ':';

const DEFAULT_TIMEOUT_S = Number(process.env.CPT_MCP_FR_PREVIEW_TIMEOUT_S || 150);
const HEALTH_INTERVAL_MS = 1500;
// 预览实例只监听回环地址；端口优先用显式传入/环境变量，否则自动挑空闲端口。
const LISTEN_HOST = '127.0.0.1';

// ---- 内置参数（$fine_username 等）的 admin 伪装 ----
//
// FR 的内置参数来自平台**登录会话**（匿名访问时全部为空字符串）。本地预览实例默认用
// 平台超管账号登录，再通过一个本地静态入口页把会话 Cookie 写进浏览器，从而让
// $fine_username / $fine_userid / $fine_role / $fine_position / $fine_display_name 等
// 在预览里解析成 admin（与生产里超级管理员看到的效果一致）。
//
// 安全边界（重要）：
//   · 只对 127.0.0.1 上的本机独立预览实例登录 / 写入 Cookie，绝不连接远端 FR；
//   · 入口页只允许跳回同端口的 /webroot/ 页面（防开放重定向）；
//   · 平台口令只用于本机一次性测试库（finedb 种子），默认值可用环境变量覆盖：
//       CPT_MCP_FR_PREVIEW_ADMIN_USER      默认 admin
//       CPT_MCP_FR_PREVIEW_ADMIN_PASSWORD  默认 local-preview-placeholder（本机一次性的测试口令）
//       CPT_MCP_FR_PREVIEW_IMPERSONATE=off 关闭伪装（退回匿名预览）
//       CPT_MCP_FR_PREVIEW_AUTO_INIT=off   未初始化平台时不自动建 admin
const DEFAULT_PREVIEW_ADMIN_USER = 'admin';
// 这不是任何真实环境的凭据：只属于本机 127.0.0.1 上这份可随时删除的 .fr-preview 测试平台库。
const DEFAULT_PREVIEW_ADMIN_PASSWORD = 'local-preview-placeholder';
const AUTH_ENTRY_FILENAME = '_cpt_mcp_fr_auth.html';
const AUTH_COOKIE_NAME = 'fine_auth_token';
const AUTH_TOKEN_RE = /^[A-Za-z0-9._~+/=-]+$/;

/** 读取「内置参数伪装」配置（每次调用时读 env，便于测试/运行期切换）。 */
export function previewIdentityConfig() {
  const raw = process.env.CPT_MCP_FR_PREVIEW_IMPERSONATE;
  const enabled = !(raw != null && /^(0|off|false|no|disabled)$/i.test(String(raw).trim()));
  const username = String(process.env.CPT_MCP_FR_PREVIEW_ADMIN_USER || DEFAULT_PREVIEW_ADMIN_USER).trim() || DEFAULT_PREVIEW_ADMIN_USER;
  const password = process.env.CPT_MCP_FR_PREVIEW_ADMIN_PASSWORD || DEFAULT_PREVIEW_ADMIN_PASSWORD;
  const autoInit = !/^(0|off|false|no|disabled)$/i.test(String(process.env.CPT_MCP_FR_PREVIEW_AUTO_INIT || '').trim());
  return { enabled, username, password, autoInit };
}

/** 还原页面里内嵌的 JS 字符串（`Dec.system = JSON.parse('...')` 里的单引号字符串）。 */
export function decodeFrJsStringLiteral(src) {
  let out = '';
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (ch !== '\\') {
      out += ch;
      continue;
    }
    const nx = src[++i];
    if (nx === 'u') {
      out += String.fromCharCode(parseInt(src.slice(i + 1, i + 5), 16));
      i += 4;
    } else if (nx === 'x') {
      out += String.fromCharCode(parseInt(src.slice(i + 1, i + 3), 16));
      i += 2;
    } else if (nx === 'n') out += '\n';
    else if (nx === 'r') out += '\r';
    else if (nx === 't') out += '\t';
    else if (nx === 'b') out += '\b';
    else if (nx === 'f') out += '\f';
    else if (nx === 'v') out += '\v';
    else if (nx === '0') out += '\0';
    else out += nx; // \\ -> \ ; \" -> " ; \' -> ' ; \/ -> /
  }
  return out;
}

/** 从 FR 页面 HTML 中取出 `Dec.system` 等内嵌 JSON 配置。 */
export function parseFrEmbeddedJson(html, assignName = 'Dec.system') {
  const m = String(html).match(new RegExp(`${assignName}\\s*=\\s*JSON\\.parse\\('([\\s\\S]*?)'\\);`));
  if (!m) return null;
  try {
    return JSON.parse(decodeFrJsStringLiteral(m[1]));
  } catch {
    return null;
  }
}

/**
 * 复刻 FR 前端的传输加密：RSA/PKCS#1 v1.5，按 122 字节分片，密文用 "---" 连接。
 * 只在内存里算，不落盘、不打印明文/密钥。
 */
export function encryptFrTransportPassword(plainText, publicKeyB64) {
  if (typeof plainText !== 'string' || !plainText) throw new Error('password 不能为空');
  if (typeof publicKeyB64 !== 'string' || !publicKeyB64.trim()) throw new Error('缺少 FR 传输公钥');
  const b64 = publicKeyB64.replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]+=*$/.test(b64)) throw new Error('FR 传输公钥不是合法 base64');
  const chunks = b64.match(/.{1,64}/g) || [b64];
  const pem = `-----BEGIN PUBLIC KEY-----\n${chunks.join('\n')}\n-----END PUBLIC KEY-----\n`;
  let key;
  try {
    key = crypto.createPublicKey({ key: pem, format: 'pem' });
  } catch (e) {
    throw new Error(`FR 传输公钥无法解析：${e?.message || e}`);
  }
  const size = Math.floor(122.5);
  const parts = [];
  for (let i = 0; i < Math.max(plainText.length, 1); i += size) {
    parts.push(crypto.publicEncrypt({ key, padding: crypto.constants.RSA_PKCS1_PADDING }, Buffer.from(plainText.substring(i, i + size), 'utf8')).toString('base64'));
  }
  return parts.join('---');
}

/** 只接受回环地址的 http URL（本地预览实例专用，防止把凭据/会话带到远端）。 */
export function isLoopbackHttpUrl(url) {
  try {
    const u = new URL(String(url));
    return u.protocol === 'http:' && u.hostname === LISTEN_HOST && !u.username && !u.password;
  } catch {
    return false;
  }
}

/**
 * 校验入口页 next 目标：必须落在同端口的本机预览实例的 /webroot/ 下。
 * @returns {{ok:true,url:string}|{ok:false,reason:string}}
 */
export function resolveBootstrapTarget(next, opts = {}) {
  const { port } = opts;
  if (!next) return { ok: false, reason: '缺少 next 参数' };
  let u;
  try {
    u = new URL(String(next));
  } catch {
    return { ok: false, reason: 'next 不是绝对 URL' };
  }
  if (u.protocol !== 'http:') return { ok: false, reason: 'next 只允许 http://' };
  if (u.hostname !== LISTEN_HOST) return { ok: false, reason: 'next 只允许 127.0.0.1' };
  if (Number(u.port || 80) !== Number(port)) return { ok: false, reason: 'next 端口与本机预览实例不一致' };
  if (!u.pathname.startsWith('/webroot/')) return { ok: false, reason: 'next 只允许 /webroot/ 路径' };
  if (u.username || u.password) return { ok: false, reason: 'next 不允许携带凭据' };
  return { ok: true, url: u.toString() };
}

export function frPreviewHome() {
  return process.env.CPT_MCP_FR_PREVIEW_HOME
    ? path.resolve(process.env.CPT_MCP_FR_PREVIEW_HOME)
    : path.join(projectRoot, '.fr-preview');
}

export function frPreviewPaths() {
  const home = frPreviewHome();
  const runtimeDir = path.join(home, 'runtime');
  return {
    home,
    runtimeDir,
    seedDir: path.join(home, 'finedb-seed'),
    stateFile: path.join(home, 'state.json'),
    logFile: path.join(runtimeDir, 'logs', 'fr-preview.log'),
    confDir: path.join(runtimeDir, 'conf'),
    serverXml: path.join(runtimeDir, 'conf', 'server.xml'),
    webappDir: path.join(runtimeDir, 'webapps', 'webroot'),
    webInfDir: path.join(runtimeDir, 'webapps', 'webroot', 'WEB-INF'),
    reportletsDir: path.join(runtimeDir, 'webapps', 'webroot', 'WEB-INF', 'reportlets'),
    // admin 伪装入口页：静态 HTML，写在预览实例自己的 webroot 根下（127.0.0.1 才能访问）。
    authEntryFile: path.join(runtimeDir, 'webapps', 'webroot', AUTH_ENTRY_FILENAME),
  };
}

function exists(p) {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

function mkdirp(p) {
  fs.mkdirSync(p, { recursive: true });
}

function copyDir(src, dest) {
  fs.cpSync(src, dest, { recursive: true, force: true, dereference: false });
}

/** Windows 用 junction（目录联接，不需要管理员权限），POSIX 用 symlink；已正确则跳过。 */
function ensureJunction(target, link) {
  if (!exists(target)) return false;
  try {
    const st = fs.lstatSync(link);
    if (st.isSymbolicLink() || st.isDirectory()) {
      const real = fs.realpathSync(link);
      if (path.resolve(real).toLowerCase() === path.resolve(target).toLowerCase()) return true;
      fs.rmSync(link, { recursive: true, force: true });
    }
  } catch {
    // link 不存在，继续创建
  }
  mkdirp(path.dirname(link));
  fs.symlinkSync(path.resolve(target), link, isWin ? 'junction' : 'dir');
  return true;
}

function ensureDir(p) {
  if (!exists(p)) mkdirp(p);
}

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function writeJson(p, value) {
  mkdirp(path.dirname(p));
  fs.writeFileSync(p, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function rmState(paths) {
  try {
    fs.rmSync(paths.stateFile, { force: true });
  } catch {
    // ignore
  }
}

function processAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e?.code === 'EPERM'; // 存在但无权限（Windows 某些场景）
  }
}

function tailFile(file, lines = 25) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    return text.split(/\r?\n/).filter(Boolean).slice(-lines).join('\n');
  } catch {
    return '';
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, LISTEN_HOST, () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function portAvailable(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.unref();
    srv.once('error', () => resolve(false));
    srv.listen(port, LISTEN_HOST, () => srv.close(() => resolve(true)));
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function probeHttp(url, timeoutMs = 4000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method: 'GET', redirect: 'manual', signal: ctrl.signal });
    return { ok: res.status < 500, status: res.status };
  } catch {
    return { ok: false, status: 0 };
  } finally {
    clearTimeout(timer);
  }
}

/** 等待服务可响应：轮询 `/webroot/decision`（未登录 302 也算就绪）。 */
async function waitReady(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const url = `http://${LISTEN_HOST}:${port}/webroot/decision`;
  let last = { ok: false, status: 0 };
  while (Date.now() < deadline) {
    last = await probeHttp(url);
    if (last.ok) return { ready: true, status: last.status };
    await new Promise((r) => setTimeout(r, HEALTH_INTERVAL_MS));
  }
  return { ready: false, status: last.status };
}

/** 把 FR_HOME/server/conf 复制到独立 base，并改写端口（HTTP + shutdown）。 */
function prepareConf(frHome, paths, port, shutdownPort) {
  const srcConf = path.join(frHome, 'server', 'conf');
  if (!exists(srcConf)) throw new Error(`FR server/conf 不存在：${srcConf}`);
  fs.rmSync(paths.confDir, { recursive: true, force: true });
  copyDir(srcConf, paths.confDir);
  let xml = fs.readFileSync(paths.serverXml, 'utf8');
  xml = xml.replace(/<Server port="\d+"/, () => `<Server port="${shutdownPort}"`);
  // Connector（含被注释的示例）只改真正的 XML 标签，避免误伤注释文本。
  xml = xml.replace(/<Connector([^>]*?)\bport="\d+"/g, (m, pre) => {
    if (/\bport="\d+"/.test(pre)) return m;
    return `<Connector${pre}port="${port}"`;
  });
  fs.writeFileSync(paths.serverXml, xml, 'utf8');
}

/** 初始化独立 CATALINA_BASE + webapp（只做一次；重复调用只补齐缺失项）。 */
export function prepareRuntime(frHome, paths, port, shutdownPort) {
  mkdirp(paths.runtimeDir);
  mkdirp(path.join(paths.runtimeDir, 'logs'));
  mkdirp(path.join(paths.runtimeDir, 'temp'));
  mkdirp(path.join(paths.runtimeDir, 'work'));
  mkdirp(path.join(paths.runtimeDir, 'webapps'));
  prepareConf(frHome, paths, port, shutdownPort);

  const frWebapp = path.join(frHome, 'webapps', 'webroot');
  const frWebInf = path.join(frWebapp, 'WEB-INF');
  mkdirp(paths.webInfDir);

  // 只读的大目录：直接 junction 到安装目录（不复制 400MB+ jar，也不写 FR_HOME）。
  for (const sub of ['lib', 'classes', 'assets', 'assist', 'customLib', 'local', 'resources', 'plugins']) {
    const target = path.join(frWebInf, sub);
    if (exists(target)) ensureJunction(target, path.join(paths.webInfDir, sub));
  }
  for (const sub of ['help', 'backup']) {
    const target = path.join(frWebapp, sub);
    if (exists(target)) ensureJunction(target, path.join(paths.webappDir, sub));
  }

  // 可写目录：独立真实目录。
  for (const sub of ['reportlets', 'cache', 'temp', 'reportlets_versions', 'logs']) {
    ensureDir(path.join(paths.webInfDir, sub));
  }
  ensureDir(path.join(paths.webappDir, 'logs'));

  // 平台配置（含数据连接加密 key）与 embed 数据库。
  const frConfig = path.join(frWebInf, 'config');
  if (exists(frConfig) && !exists(path.join(paths.webInfDir, 'config'))) {
    copyDir(frConfig, path.join(paths.webInfDir, 'config'));
  }
  const embedDir = path.join(paths.webInfDir, 'embed');
  const finedbDir = path.join(embedDir, 'finedb');
  if (!exists(finedbDir)) {
    mkdirp(finedbDir);
    // 优先用「已初始化好的设计器内核快照」作为平台库（含管理员/数据连接）。
    const seed = paths.seedDir;
    const source = exists(seed) && fs.readdirSync(seed).length ? seed : path.join(frHome, 'bin', 'embed', 'finedb');
    if (exists(source)) {
      for (const name of ['db.script', 'db.log', 'db.lobs', 'db.properties']) {
        const from = path.join(source, name);
        // db.lck / db.tmp 绝不能带：锁文件会阻止新实例打开库，db.tmp 是 HSQLDB 运行期临时文件。
        if (exists(from)) fs.copyFileSync(from, path.join(finedbDir, name));
      }
    }
  }
  const embedProp = path.join(frWebInf, 'embed', 'prop');
  if (exists(embedProp) && !exists(path.join(embedDir, 'prop'))) {
    copyDir(embedProp, path.join(embedDir, 'prop'));
  }
  return paths;
}

function classpath(frHome) {
  const lib = path.join(frHome, 'server', 'lib');
  return [path.join(lib, 'bootstrap.jar'), path.join(lib, 'tomcat-juli.jar')].join(PATH_SEP);
}

function tomcatArgs(frHome, paths) {
  return [
    `-Dcatalina.home=${path.join(frHome, 'server')}`,
    `-Dcatalina.base=${paths.runtimeDir}`,
    `-Djava.io.tmpdir=${path.join(paths.runtimeDir, 'temp')}`,
    '-Dfile.encoding=UTF-8',
    '-cp',
    classpath(frHome),
    'org.apache.catalina.startup.Bootstrap',
  ];
}

function previewUrls(port, viewlet) {
  const base = `http://${LISTEN_HOST}:${port}`;
  const q = encodeURIComponent(viewlet);
  return {
    base,
    platformUrl: `${base}/webroot/decision`,
    // 平台管理页（首次配置数据连接用；本地实例只有回环可达）
    adminUrl: `${base}/webroot/decision#management/connection`,
    viewUrl: `${base}/webroot/decision/view/report?viewlet=${q}`,
    writeUrl: `${base}/webroot/decision/view/report?viewlet=${q}&op=write`,
  };
}

/** 匿名直连 URL（不带 admin 会话时打开的就是这个）。 */
function directUrls(port, viewlet) {
  const raw = previewUrls(port, viewlet);
  return { ...raw, directPlatformUrl: raw.platformUrl, directAdminUrl: raw.adminUrl, directViewUrl: raw.viewUrl, directWriteUrl: raw.writeUrl };
}

// ---------------------------------------------------------------------------
// 平台登录 + admin 伪装入口
// ---------------------------------------------------------------------------

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** 解析 JWT 里的 exp（不校验签名，仅用于本地缓存提前刷新）。 */
function decodeTokenExpiry(token) {
  try {
    const part = String(token).split('.')[1];
    if (!part) return null;
    const json = Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    const exp = JSON.parse(json)?.exp;
    return typeof exp === 'number' ? exp * 1000 : null;
  } catch {
    return null;
  }
}

async function fetchWithTimeout(fetchImpl, url, init = {}, timeoutMs = 12000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Math.max(1000, Number(timeoutMs) || 12000));
  try {
    const res = await fetchImpl(url, { ...init, signal: ctrl.signal, redirect: init.redirect || 'follow' });
    const text = await res.text();
    return { res, text };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 登录本机预览实例的 FR 决策平台，拿会话 token（用于 $fine_username 等内置参数的 admin 伪装）。
 *
 * · 只接受 127.0.0.1 的 http 地址（本地预览实例），绝不向远端 FR 发送口令；
 * · 复刻 FR11 前端协议：GET 登录页 → 取 Dec.system 的 RSA 公钥 → 加密口令 → POST /login；
 * · 平台未初始化（serverInit != success，页面跳到 /login/initialization）时，先 POST /login/admin
 *   用同一口令创建超管账号（autoInit=true 时），再登录。
 *
 * @returns {{ok:true, token:string, username:string, mode:'login'|'initialization', expiresAt:number|null}
 *          |{ok:false, reason:string, mode?:string, errorCode?:string, errorMsg?:string, hint?:string}}
 */
export async function loginFrPreview(opts = {}) {
  const {
    baseUrl,
    username = DEFAULT_PREVIEW_ADMIN_USER,
    password,
    fetchImpl = fetch,
    timeoutMs = 12000,
    autoInit = true,
  } = opts;
  const base = String(baseUrl || '').replace(/\/+$/, '');
  if (!password) return { ok: false, reason: 'no-password', hint: '缺少平台口令（CPT_MCP_FR_PREVIEW_ADMIN_PASSWORD）' };
  if (!isLoopbackHttpUrl(base)) {
    return { ok: false, reason: 'non-local-target', hint: '内置参数伪装只允许访问 127.0.0.1 上的本机预览实例，拒绝连接远端 FR。' };
  }
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/javascript, */*; q=0.01',
    'X-Requested-With': 'XMLHttpRequest',
    transEncryptLevel: '1',
  };

  let page;
  try {
    page = await fetchWithTimeout(fetchImpl, `${base}/webroot/decision/login`, { method: 'GET' }, timeoutMs);
  } catch (e) {
    return { ok: false, reason: 'login-page-unreachable', hint: `本地预览实例未就绪或已退出：${e?.message || e}` };
  }
  const finalPath = (() => {
    try {
      return new URL(page.res.url || `${base}/webroot/decision/login`).pathname;
    } catch {
      return '/webroot/decision/login';
    }
  })();
  const mode = /\/login\/initialization$/.test(finalPath) ? 'initialization' : 'login';
  const system = parseFrEmbeddedJson(page.text, 'Dec.system');
  if (!system?.encryptionKey) {
    return { ok: false, reason: 'login-page-unrecognized', mode, hint: `登录页结构不符合预期（${finalPath}）：无法取得传输公钥，可能是 FR 版本差异。` };
  }
  let cipher;
  try {
    cipher = encryptFrTransportPassword(password, system.encryptionKey);
  } catch (e) {
    return { ok: false, reason: 'encrypt-failed', mode, hint: `口令加密失败：${e?.message || e}` };
  }

  if (mode === 'initialization') {
    if (!autoInit) {
      return {
        ok: false,
        reason: 'platform-not-initialized',
        mode,
        hint: '本地预览实例的决策平台还没初始化：先打开 adminUrl 完成初始化（会创建 admin 账号），或允许自动初始化（CPT_MCP_FR_PREVIEW_AUTO_INIT=on，默认开）。',
      };
    }
    const initRes = await fetchWithTimeout(
      fetchImpl,
      `${base}/webroot/decision/login/admin`,
      { method: 'POST', headers, body: JSON.stringify({ username, password: cipher }) },
      timeoutMs,
    );
    const initPayload = safeJsonParse(initRes.text);
    if (!initPayload || (initPayload.data !== 'success' && initPayload.errorCode)) {
      return {
        ok: false,
        reason: 'auto-init-failed',
        mode,
        errorCode: initPayload?.errorCode,
        errorMsg: initPayload?.errorMsg,
        hint: '平台初始化建号失败：检查账号是否满足 FR 口令策略（至少 8 位且含大小写/数字/特殊字符），或手动打开 adminUrl 初始化。',
      };
    }
  }

  let loginRes;
  try {
    loginRes = await fetchWithTimeout(
      fetchImpl,
      `${base}/webroot/decision/login`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ username, password: cipher, validity: -1, encrypted: true }),
      },
      timeoutMs,
    );
  } catch (e) {
    return { ok: false, reason: 'login-request-failed', mode, hint: `登录请求失败：${e?.message || e}` };
  }
  const payload = safeJsonParse(loginRes.text);
  const data = payload?.data;
  if (data?.accessToken) {
    return {
      ok: true,
      token: data.accessToken,
      username: data.username || username,
      mode,
      expiresAt: decodeTokenExpiry(data.accessToken),
    };
  }
  return {
    ok: false,
    reason: payload?.errorCode === '21300007' ? 'wrong-password' : 'login-failed',
    mode,
    errorCode: payload?.errorCode,
    errorMsg: payload?.errorMsg,
    hint: payload?.errorCode === '21300007'
      ? `本地预览实例的 ${username} 口令不对：设置 CPT_MCP_FR_PREVIEW_ADMIN_PASSWORD 为平台超管口令，或按 docs/fr-preview.md 重置本地平台管理员口令。`
      : '登录本地预览实例失败：可先用 adminUrl 手动登录确认平台状态，或查看 .fr-preview/runtime/logs/fr-preview.log。',
  };
}

/** 生成入口页 HTML：写会话 Cookie 后跳回同端口的 /webroot/ 页面（只在 127.0.0.1 上可用）。 */
function buildAuthEntryHtml({ token, defaultNext }) {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta http-equiv="Cache-Control" content="no-store">
<title>CPT-MCP 本地预览 · admin 伪装入口</title>
<style>body{font:14px/1.6 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;padding:24px;color:#333}</style>
</head>
<body>
<p id="msg">正在写入本地预览会话…</p>
<script>
(function () {
  var TOKEN = ${JSON.stringify(token)};
  var DEFAULT_NEXT = ${JSON.stringify(defaultNext)};
  var msg = document.getElementById('msg');
  var raw = '';
  try { raw = new URLSearchParams(window.location.search).get('next') || ''; } catch (e) {}
  var target = null;
  try { target = new URL(raw || DEFAULT_NEXT, window.location.href); } catch (e) {}
  var ok = !!target && target.protocol === 'http:' && target.hostname === '127.0.0.1' &&
    target.port === window.location.port && target.pathname.indexOf('/webroot/') === 0 &&
    !target.username && !target.password;
  if (!ok) { msg.textContent = '无效的 next：本地预览会话只允许跳转到同端口的 FR 页面。'; return; }
  document.cookie = '${AUTH_COOKIE_NAME}=' + TOKEN + '; path=/; SameSite=Lax';
  window.location.replace(target.href);
})();
</script>
</body>
</html>
`;
}

/**
 * 把 admin 会话写入本地入口页（静态 HTML，放在预览实例自己的 webroot 下）。
 * 浏览器打开入口页 → JS 写 fine_auth_token Cookie → 跳转到目标预览页，
 * 之后 FR 页面（含 ajax/提交）都会带上会话，$fine_username 等内置参数即为 admin。
 */
export function writeAuthEntryFile(paths, { token, defaultNext, port }) {
  if (!AUTH_TOKEN_RE.test(String(token || ''))) throw new Error('登录令牌格式异常，拒绝写入本地入口页');
  const target = resolveBootstrapTarget(defaultNext, { port });
  if (!target.ok) throw new Error(`入口页默认跳转不是合法的本地预览 URL：${target.reason}`);
  mkdirp(path.dirname(paths.authEntryFile));
  fs.writeFileSync(paths.authEntryFile, buildAuthEntryHtml({ token, defaultNext: target.url }), 'utf8');
  return paths.authEntryFile;
}

function removeAuthEntryFile(paths) {
  try {
    fs.rmSync(paths.authEntryFile, { force: true });
    return true;
  } catch {
    return false;
  }
}

let previewTokenCache = null;

async function ensurePreviewToken({ baseUrl, port, fetchImpl, timeoutMs }) {
  const fresh = previewTokenCache && previewTokenCache.port === port && previewTokenCache.expiresAt
    && previewTokenCache.expiresAt - Date.now() > 60000;
  if (fresh) return { ok: true, ...previewTokenCache, cached: true };
  const cfg = previewIdentityConfig();
  const auth = await loginFrPreview({
    baseUrl,
    username: cfg.username,
    password: cfg.password,
    fetchImpl,
    timeoutMs: timeoutMs || 12000,
    autoInit: cfg.autoInit,
  });
  if (auth.ok) previewTokenCache = { port, token: auth.token, username: auth.username, mode: auth.mode, expiresAt: auth.expiresAt, version: Date.now() };
  return auth;
}

/**
 * 计算「带 admin 会话」的预览 URL（写入口页 + 返回包装 URL）。
 * 失败时退回匿名直连 URL，并在 impersonation.status 里说明原因（不抛错，预览本身仍可用）。
 */
export async function attachPreviewImpersonation(paths, opts = {}) {
  const { port, viewlet = '', fetchImpl, timeoutMs, enabled } = opts;
  const cfg = previewIdentityConfig();
  const effectiveEnabled = enabled === false ? false : cfg.enabled;
  const direct = directUrls(port, viewlet);
  const baseImp = { enabled: effectiveEnabled, username: cfg.username };
  if (!effectiveEnabled) {
    return {
      urls: direct,
      impersonation: {
        ...baseImp,
        status: 'disabled',
        hint: '未启用 admin 伪装（CPT_MCP_FR_PREVIEW_IMPERSONATE=off 或调用时 impersonate=false）：预览是匿名会话，$fine_username 等内置参数为空。',
      },
    };
  }
  const auth = await ensurePreviewToken({ baseUrl: `http://${LISTEN_HOST}:${port}`, port, fetchImpl, timeoutMs });
  if (!auth.ok) {
    return {
      urls: direct,
      impersonation: {
        ...baseImp,
        status: 'failed',
        reason: auth.reason,
        mode: auth.mode,
        errorCode: auth.errorCode,
        errorMsg: auth.errorMsg,
        hint: auth.hint,
      },
    };
  }
  const version = previewTokenCache?.version || Date.now();
  let entryFile;
  try {
    entryFile = writeAuthEntryFile(paths, { token: auth.token, defaultNext: direct.viewUrl, port });
  } catch (e) {
    return {
      urls: direct,
      impersonation: { ...baseImp, status: 'failed', reason: 'entry-write-failed', hint: `写本地会话入口页失败：${e?.message || e}` },
    };
  }
  const entryUrl = `http://${LISTEN_HOST}:${port}/webroot/${AUTH_ENTRY_FILENAME}`;
  const wrap = (url) => `${entryUrl}?next=${encodeURIComponent(url)}&v=${version}`;
  return {
    urls: {
      ...direct,
      viewUrl: wrap(direct.viewUrl),
      writeUrl: wrap(direct.writeUrl),
      platformUrl: wrap(direct.platformUrl),
      adminUrl: wrap(direct.adminUrl),
      authEntryUrl: entryUrl,
    },
    impersonation: {
      ...baseImp,
      status: 'ok',
      mode: auth.mode,
      expiresAt: auth.expiresAt,
      cached: Boolean(auth.cached),
      entryFile,
      hint: `已用 ${auth.username} 登录本地预览实例：预览/平台 URL 会先经本地入口页写入会话 Cookie 再跳转，$fine_username 等内置参数解析为 ${auth.username}（仅 127.0.0.1 可达，不涉及任何远端 FR）。`,
    },
  };
}

// ---------------------------------------------------------------------------
// 残留 java 进程清理（上一轮异常退出可能留下同一 CATALINA_BASE 的 java，抢 finedb 锁）
// ---------------------------------------------------------------------------

function runCapture(cmd, args, timeoutMs = 15000) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, timeout: timeoutMs });
  return `${r.stdout || ''}\n${r.stderr || ''}`;
}

/** 找出所有「CATALINA_BASE = 本预览实例目录」的 java 进程（best-effort）。 */
function listPreviewProcessPids(paths) {
  const needle = `-Dcatalina.base=${paths.runtimeDir}`.toLowerCase();
  const pids = [];
  if (isWin) {
    const text = runCapture('wmic', ['process', 'where', "name='java.exe'", 'get', 'ProcessId,CommandLine', '/format:list']);
    if (/CommandLine=/i.test(text)) {
      let cmdline = '';
      for (const line of text.split(/\r?\n/)) {
        const m = line.match(/^CommandLine=(.*)$/i);
        if (m) {
          cmdline = m[1];
          continue;
        }
        const p = line.match(/^ProcessId=(\d+)/i);
        if (p) {
          if (cmdline.toLowerCase().includes(needle)) pids.push(Number(p[1]));
          cmdline = '';
        }
      }
      return pids;
    }
    // 旧系统没有 wmic 时退回 PowerShell（慢一点，只在需要清理时兜底）
    const ps = runCapture('powershell', ['-NoProfile', '-NonInteractive', '-Command',
      'Get-CimInstance Win32_Process -Filter "Name=\'java.exe\'" | ForEach-Object { "$($_.ProcessId)|$($_.CommandLine)" }'], 20000);
    for (const line of ps.split(/\r?\n/)) {
      const idx = line.indexOf('|');
      if (idx <= 0) continue;
      const pid = Number(line.slice(0, idx));
      const cmd = line.slice(idx + 1).toLowerCase();
      if (pid && cmd.includes(needle)) pids.push(pid);
    }
    return pids;
  }
  const ps = runCapture('ps', ['-eo', 'pid=,args=']);
  for (const line of ps.split(/\r?\n/)) {
    if (!line.toLowerCase().includes(needle)) continue;
    const m = line.trim().match(/^(\d+)\s/);
    if (m) pids.push(Number(m[1]));
  }
  return pids;
}

function killPidTree(pid) {
  try {
    if (isWin) spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 15000, stdio: 'ignore' });
    else process.kill(pid, 'SIGKILL');
    return true;
  } catch {
    return false;
  }
}

/** 杀掉同一预览目录下残留/重复的 java 进程，避免新实例抢不到 finedb 锁而“假装初始化失败”。 */
export function cleanupPreviewProcesses(paths, opts = {}) {
  const { keepPid = null } = opts;
  const killed = [];
  for (const pid of listPreviewProcessPids(paths)) {
    if (!pid || pid === process.pid || (keepPid && pid === keepPid)) continue;
    if (killPidTree(pid)) killed.push(pid);
  }
  return killed;
}

function copyReportlet(paths, cptPath) {
  mkdirp(paths.reportletsDir);
  const viewlet = path.basename(cptPath);
  const dest = path.join(paths.reportletsDir, viewlet);
  fs.copyFileSync(cptPath, dest);
  return { viewlet, dest };
}

async function stopInstance(frHome, paths) {
  const state = readJson(paths.stateFile);
  if (!state || !state.pid) return { stopped: false, reason: 'no-instance' };
  const { pid, port } = state;
  let graceful = false;
  const java = path.join(frHome, 'jre', 'bin', isWin ? 'java.exe' : 'java');
  if (exists(java)) {
    // Tomcat 优雅关闭：连 shutdown 端口发 SHUTDOWN，让 FR 平台正常 flush finedb。
    const r = spawnSync(java, [...tomcatArgs(frHome, paths), 'stop'], {
      cwd: path.join(frHome, 'server'),
      windowsHide: true,
      timeout: 25000,
      stdio: 'ignore',
    });
    graceful = r.status === 0;
  }
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline && processAlive(pid)) await sleep(500);
  if (processAlive(pid)) {
    if (isWin) {
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 15000, stdio: 'ignore' });
    } else {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        // ignore
      }
    }
    const killDeadline = Date.now() + 8000;
    while (Date.now() < killDeadline && processAlive(pid)) await sleep(300);
  }
  const stillAlive = processAlive(pid);
  rmState(paths);
  // 停机后把平台库回写为种子：之后 start 会复用管理员账号/数据连接配置。
  const seeded = stillAlive ? false : persistSeed(paths);
  return { stopped: true, pid, port, graceful, forced: !graceful && stillAlive === false, seedUpdated: seeded };
}

function persistSeed(paths) {
  const src = path.join(paths.webInfDir, 'embed', 'finedb');
  if (!exists(src)) return false;
  try {
    mkdirp(paths.seedDir);
    // 只回写库文件（db.lck 是运行期锁文件；db.tmp 是 HSQLDB 临时文件，都不能进种子）。
    for (const f of fs.readdirSync(src)) {
      if (f === 'db.lck' || f === 'db.tmp') continue;
      const from = path.join(src, f);
      if (fs.statSync(from).isFile()) fs.copyFileSync(from, path.join(paths.seedDir, f));
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * 启动（或复用）本地独立 FR 报表实例。
 * @param {string} cptPath 要预览的 .cpt（复制进实例的 WEB-INF/reportlets，不改源文件）
 * @param {{port?:number, timeoutSeconds?:number, waitForReady?:boolean, impersonate?:boolean}} [opts]
 *   impersonate=false 时不做 admin 伪装（预览为匿名会话），缺省按 previewIdentityConfig() 开启。
 */
function localConnectionNames(connections) {
  return [...new Set((Array.isArray(connections) ? connections : [])
    .map((c) => String(c?.name ?? '').trim())
    .filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

function localConnectionSignature(connections) {
  return (Array.isArray(connections) ? connections : [])
    .map((c) => `${String(c?.name ?? '').trim()}|${path.resolve(String(c?.dbFile ?? ''))}`)
    .sort((a, b) => a.localeCompare(b))
    .join('\n');
}

/**
 * 启动本地独立 FR 预览实例。
 *
 * @param {string} cptPath
 * @param {object} [opts]
 * @param {{name:string,dbFile:string}[]} [opts.localConnections] 传入时：把这些本地 SQLite
 *   连接写入 runtime finedb（先清空所有 ConnectionConfig），并允许清理种子里的外部连接；
 *   不传时：沿用旧安全围栏（发现外部连接直接拒绝启动）。
 */
export async function startFrPreview(cptPath, opts = {}) {
  // 先做输入校验：非 .cpt/不存在应返回 bad-input，与是否安装 FineReport 无关。
  if (!cptPath || !/\.cpt$/i.test(cptPath)) {
    return { ok: false, status: 'bad-input', hint: 'path 必须指向 .cpt 文件' };
  }
  const cpt = path.resolve(cptPath);
  if (!exists(cpt)) return { ok: false, status: 'bad-input', cpt, hint: `${cpt} 不存在` };

  const paths = frPreviewPaths();
  const detected = detectFrHome();
  if (!detected.frHome) {
    return {
      ok: false,
      status: 'fr-not-installed',
      hint: '未探测到本机 FineReport 安装目录（可设置 FR_HOME 指向设计器根目录）。' +
        'fr_detect/fr_inspect 可盘点；本工具需要设计器自带的 jre + server/ + webapps/webroot。',
    };
  }
  const frHome = detected.frHome;
  const java = path.join(frHome, 'jre', 'bin', isWin ? 'java.exe' : 'java');
  const bootstrap = path.join(frHome, 'server', 'lib', 'bootstrap.jar');
  const webappSrc = path.join(frHome, 'webapps', 'webroot');
  if (!exists(java) || !exists(bootstrap) || !exists(webappSrc)) {
    return {
      ok: false,
      status: 'fr-layout-unsupported',
      frHome,
      hint: `FR 目录缺少预览所需组件：java=${exists(java)} bootstrap=${exists(bootstrap)} webapps=${exists(webappSrc)}`,
    };
  }

  // 0) 安全硬门槛（2026-11-09）：内置预览禁止直连生产库。
  //    MCP 自己可以从生产库只读导入 SQLite，但预览平台库里的外部 ConnectionConfig 不允许继承。
  //    传入 localConnections 时，启动阶段会先清空所有连接再写入本地 SQLite，
  //    因此允许用它洗掉种子里的外部连接；写入失败会直接中止启动。
  const localGuard = inspectPreviewFinedb({ seedDir: paths.seedDir, frHome });
  const willInjectLocal = Array.isArray(opts.localConnections);
  if (!localGuard.ok && !willInjectLocal) {
    return {
      ok: false,
      status: 'external-data-connection-blocked',
      frHome,
      connections: localGuard.blocked.map((c) => c.name),
      sources: localGuard.sources,
      hint: localGuard.reason + '。' +
        '请先 stop_fr_preview，备份/清空 .fr-preview/finedb-seed 后只配置内置 SQLite 连接；' +
        '生产数据请用 local_db_import({action:"report"}) 由 MCP 只读导入本地库，不要把生产连接写进预览平台。',
    };
  }

  // 1) 已有实例活着 → 只替换 reportlet（同一实例可轮换预览多份模板）
  const state = readJson(paths.stateFile);
  if (state && processAlive(state.pid)) {
    // 旧版本启动的实例没有 local-only 标记；无法证明它没有继承生产连接，先要求 stop，避免复用风险。
    if (state.dataConnections?.mode !== 'local-only') {
      return {
        ok: false,
        status: 'preview-running-unsanitized',
        pid: state.pid,
        port: state.port,
        hint: '检测到已运行的预览实例未经「本地数据连接」保护（可能是升级前启动的）。请先 stop_fr_preview 再重新 start；生产数据请走 MCP 只读导入本地 SQLite，不要让预览平台继承生产连接。',
      };
    }
    if (willInjectLocal) {
      const desiredSignature = localConnectionSignature(opts.localConnections);
      if (state.dataConnections.signature !== desiredSignature) {
        return {
          ok: false,
          status: 'preview-restart-required',
          pid: state.pid,
          port: state.port,
          localConnections: localConnectionNames(opts.localConnections),
          hint: '当前报表的本地 SQLite 连接映射与已运行预览实例不一致（或该实例是旧版启动的）。请先 stop_fr_preview，再 start_fr_preview；新实例会写入本地 SQLite 连接。',
        };
      }
    }
    const health = await probeHttp(`http://${LISTEN_HOST}:${state.port}/webroot/decision`);
    if (health.ok) {
      const { viewlet } = copyReportlet(paths, cpt);
      const impersonateOverride = opts.impersonate === false ? false : undefined;
      const auth = await attachPreviewImpersonation(paths, { port: state.port, viewlet, enabled: impersonateOverride });
      return {
        ok: true,
        status: 'already-running',
        reused: true,
        frHome,
        pid: state.pid,
        port: state.port,
        cpt,
        viewlet,
        startedAt: state.startedAt,
        dataConnections: state.dataConnections,
        ...auth.urls,
        impersonation: auth.impersonation,
        hint: auth.impersonation.status === 'ok'
          ? `复用已运行的本地预览实例：已用 ${auth.impersonation.username} 登录（$fine_username 等内置参数解析为 ${auth.impersonation.username}），并把当前 .cpt 复制进 reportlets；刷新页面即可看到最新模板。`
          : '复用已运行的本地预览实例；已把当前 .cpt 复制进 reportlets。刷新页面即可看到最新模板。',
      };
    }
    // 进程在但端口不通：可能还在冷启动（不要急着重启，否则会把抢 finedb 锁的进程搅乱）。
    if (state.pid && !health.ok) {
      const ageSeconds = state.startedAt ? Math.round((Date.now() - Date.parse(state.startedAt)) / 1000) : null;
      if (ageSeconds !== null && ageSeconds <= DEFAULT_TIMEOUT_S + 120) {
        const identity = previewIdentityConfig();
        return {
          ok: true,
          status: 'starting',
          reused: true,
          ready: false,
          frHome,
          pid: state.pid,
          port: state.port,
          cpt: state.cpt,
          viewlet: state.viewlet,
          startedAt: state.startedAt,
          ...directUrls(state.port, state.viewlet || ''),
          impersonation: {
            enabled: identity.enabled,
            username: identity.username,
            status: identity.enabled ? 'pending' : 'disabled',
            hint: identity.enabled
              ? '实例还在冷启动：就绪后调用 fr_preview_status 会返回带 admin 会话的预览 URL。'
              : '未启用 admin 伪装：预览为匿名会话。',
          },
          hint: `实例正在冷启动（已 ${ageSeconds}s，FR 通常 30~60s）：不要重复 start（会打断启动并引发 finedb 锁竞争），用 fr_preview_status 轮询到 status=running。`,
        };
      }
      // 存活过久仍不响应 = 挂死残留：清掉 state 后按残留进程处理。
      rmState(paths);
    }
  }
  if (state && !processAlive(state.pid)) rmState(paths);

  // 1.5) 清理同一预览目录下的残留/重复 java 进程：否则新实例抢不到 finedb 锁，
  //      平台会进入“部署推荐/初始化未完成”的假状态（登录页不可用）。
  const killedOrphans = cleanupPreviewProcesses(paths);

  // 2) 选端口 + 准备独立 base
  const explicitPort = Number(opts.port) || Number(process.env.CPT_MCP_FR_PREVIEW_PORT) || 0;
  if (explicitPort && !(await portAvailable(explicitPort))) {
    return {
      ok: false,
      status: 'port-in-use',
      port: explicitPort,
      hint: `端口 ${explicitPort} 已被占用；不传 port 时会自动挑选空闲端口。`,
    };
  }
  const port = explicitPort || (await freePort());
  let shutdownPort = port + 1000;
  if (shutdownPort > 65000) shutdownPort = port - 1000;
  try {
    prepareRuntime(frHome, paths, port, shutdownPort);
  } catch (e) {
    return { ok: false, status: 'prepare-failed', frHome, error: String(e?.message || e) };
  }
  const { viewlet } = copyReportlet(paths, cpt);

  // 2.5) 本地测试环境：只把本地 SQLite 连接写入 runtime finedb。
  //       传 localConnections 时先清空所有 ConnectionConfig（包括种子里的外部连接），
  //       再写 jdbc:sqlite；写入失败直接中止，绝不带着旧生产连接启动预览。
  let localApplied = null;
  if (willInjectLocal) {
    try {
      localApplied = applyLocalConnectionsToFinedb(
        path.join(paths.webInfDir, 'embed', 'finedb'),
        opts.localConnections,
      );
    } catch (e) {
      return {
        ok: false,
        status: 'local-connection-config-failed',
        frHome,
        error: String(e?.message || e),
        hint: '本地 SQLite 连接写入预览 finedb 失败，未启动预览；先确认 local_db_import({action:"report"}) 已完成。',
      };
    }
  }

  // 3) 拉起设计器同款内核（独立 CATALINA_BASE，headless）
  mkdirp(path.dirname(paths.logFile));
  const out = fs.openSync(paths.logFile, 'a');
  const child = spawn(java, [...tomcatArgs(frHome, paths), 'start'], {
    cwd: path.join(frHome, 'server'),
    detached: true,
    windowsHide: true,
    stdio: ['ignore', out, out],
  });
  child.unref();
  const startedAt = new Date().toISOString();
  const dataConnections = {
    mode: 'local-only',
    localCount: localApplied ? localApplied.names.length : localGuard.localCount,
    names: localApplied ? localApplied.names : [],
    ...(localApplied ? { signature: localConnectionSignature(opts.localConnections), injected: true } : { injected: false }),
    sources: localGuard.sources,
  };
  writeJson(paths.stateFile, { pid: child.pid, port, shutdownPort, startedAt, cpt, viewlet, frHome, runtimeDir: paths.runtimeDir, dataConnections });

  const baseResult = {
    ok: true,
    frHome,
    pid: child.pid,
    port,
    cpt,
    viewlet,
    startedAt,
    runtimeDir: paths.runtimeDir,
    logFile: paths.logFile,
    dataConnections,
    ...directUrls(port, viewlet),
    ...(killedOrphans.length ? { killedOrphans } : {}),
  };
  const identity = previewIdentityConfig();
  const impersonateOverride = opts.impersonate === false ? false : undefined;
  const identityEnabled = impersonateOverride === false ? false : identity.enabled;
  const pendingImpersonation = {
    enabled: identityEnabled,
    username: identity.username,
    status: identityEnabled ? 'pending' : 'disabled',
    hint: identityEnabled
      ? '实例就绪后调用 fr_preview_status：会以 admin 登录本地预览实例，并返回带会话的预览 URL（$fine_username 等内置参数解析为 admin）。'
      : '未启用 admin 伪装（CPT_MCP_FR_PREVIEW_IMPERSONATE=off 或 impersonate=false）：预览为匿名会话。',
  };

  const dataConnectionHint = localApplied
    ? `已把本地 SQLite 连接写入预览平台：${localApplied.names.length ? localApplied.names.join('、') : '（无外部连接）'}；预览只连本地 SQLite，不继承生产连接。`
    : '首次使用若需数据连接：先等 running，再打开 adminUrl → 配置与 .cpt 同名的数据连接，stop 后配置会自动持久化为种子。';
  // 4a) 不等就绪（MCP 工具默认走这条）：立刻返回 starting，避免客户端 60s 请求超时。
  //     调用方用 fr_preview_status 轮询到 status=running 再打开 URL。
  const timeoutMs = Math.max(15, Number(opts.timeoutSeconds) || DEFAULT_TIMEOUT_S) * 1000;
  if (opts.waitForReady === false) {
    return {
      ...baseResult,
      status: 'starting',
      ready: false,
      impersonation: pendingImpersonation,
      hint: `实例进程已拉起（PID=${child.pid}，端口=${port}），FR 冷启动通常 30~60s，使用 fr_preview_status 轮询到 status=running 即可打开 viewUrl/writeUrl。` +
        dataConnectionHint,
    };
  }

  // 4b) 等就绪（CLI 默认走这条）：FR 平台冷启动 20-60s，首次更慢
  const ready = await waitReady(port, timeoutMs);
  if (!ready.ready) {
    const logTail = tailFile(paths.logFile, 30);
    // 端口没起来 = 启动失败，清理 state 防止后续误复用
    rmState(paths);
    return {
      ok: false,
      status: 'timeout',
      frHome,
      pid: child.pid,
      port,
      runtimeDir: paths.runtimeDir,
      logFile: paths.logFile,
      logTail,
      hint: `独立 FR 实例在 ${Math.round(timeoutMs / 1000)}s 内未就绪：查看 logTail / logFile。` +
        '常见原因：端口被占、FR 版本目录结构不同、或首次启动被安全软件拦截。',
    };
  }
  const auth = await attachPreviewImpersonation(paths, { port, viewlet, enabled: impersonateOverride });
  return {
    ...baseResult,
    ...auth.urls,
    status: 'started',
    ready: true,
    impersonation: auth.impersonation,
    hint: (auth.impersonation.status === 'ok'
      ? `实例已就绪，并已用 ${auth.impersonation.username} 登录本地预览实例（$fine_username 等内置参数解析为 ${auth.impersonation.username}）：viewUrl=分页预览，writeUrl=填报预览（含工具栏/提交按钮）。`
      : '实例已就绪：viewUrl=分页预览，writeUrl=填报预览（含工具栏/提交按钮）。') +
      dataConnectionHint,
  };
}

/** 停止本地预览实例（优雅 shutdown，超时强杀；停机后回写 finedb 种子）。 */
export async function stopFrPreview() {
  const paths = frPreviewPaths();
  const detected = detectFrHome();
  if (!detected.frHome) return { ok: false, status: 'fr-not-installed' };
  const result = await stopInstance(detected.frHome, paths);
  previewTokenCache = null;
  const authEntryRemoved = removeAuthEntryFile(paths);
  if (!result.stopped) {
    const killedOrphans = cleanupPreviewProcesses(paths);
    return {
      ok: false,
      status: 'not-running',
      hint: '当前没有运行中的本地预览实例',
      ...(killedOrphans.length ? { killedOrphans, hint: `当前没有运行中的预览实例；已清理 ${killedOrphans.length} 个残留 java 进程。` } : {}),
    };
  }
  const killedOrphans = cleanupPreviewProcesses(paths);
  return {
    ok: true,
    status: 'stopped',
    ...result,
    authEntryRemoved,
    ...(killedOrphans.length ? { killedOrphans } : {}),
    runtimeDir: paths.runtimeDir,
    seedDir: paths.seedDir,
  };
}

/** 查询本地预览实例状态（不启动、不修改任何东西）。 */
export async function frPreviewStatus() {
  const paths = frPreviewPaths();
  const detected = detectFrHome();
  const state = readJson(paths.stateFile);
  const seedFiles = exists(paths.seedDir) ? fs.readdirSync(paths.seedDir, { withFileTypes: true }).filter((d) => d.isFile()).map((d) => d.name) : [];
  const identity = previewIdentityConfig();
  const base = {
    frHome: detected.frHome,
    runtimeDir: paths.runtimeDir,
    seedDir: paths.seedDir,
    seedConfigured: seedFiles.some((f) => f === 'db.script'),
    logFile: paths.logFile,
  };
  if (!state) return { ok: true, status: 'not-running', ...base, hint: '用 start_fr_preview 启动（首次约 30-60s）。' };
  const alive = processAlive(state.pid);
  const health = alive ? await probeHttp(`http://${LISTEN_HOST}:${state.port}/webroot/decision`) : { ok: false, status: 0 };
  const ageSeconds = state.startedAt ? Math.round((Date.now() - Date.parse(state.startedAt)) / 1000) : null;
  if (!alive) {
    return { ok: true, status: 'stale', ...base, pid: state.pid, port: state.port, startedAt: state.startedAt, health: health.status, hint: 'state.json 指向的实例进程已退出：下次 start 会自动清理并重启。' };
  }
  if (!health.ok) {
    // 进程活着但端口未响应 = 正在冷启动；超过「默认超时 + 120s」仍不响则判 stale（防挂死进程被无限等待）。
    const staleAfter = DEFAULT_TIMEOUT_S + 120;
    if (ageSeconds !== null && ageSeconds > staleAfter) {
      return { ok: true, status: 'stale', ...base, pid: state.pid, port: state.port, startedAt: state.startedAt, health: health.status, hint: `进程存活但 ${ageSeconds}s 仍不响应（可能挂死）：stop 后重新 start。` };
    }
    return {
      ok: true, status: 'starting', ready: false, ...base,
      pid: state.pid, port: state.port, startedAt: state.startedAt, ageSeconds,
      cpt: state.cpt, viewlet: state.viewlet, health: health.status,
      logTail: tailFile(paths.logFile, 8),
      impersonation: {
        enabled: identity.enabled,
        username: identity.username,
        status: identity.enabled ? 'pending' : 'disabled',
        hint: identity.enabled ? '实例就绪后本工具会以 admin 登录并返回带会话的预览 URL。' : '未启用 admin 伪装。',
      },
      hint: `实例正在启动（已 ${ageSeconds ?? '?'}s，FR 冷启动通常 30~60s）：继续轮询 fr_preview_status，status=running 后再打开预览 URL。`,
    };
  }
  const auth = await attachPreviewImpersonation(paths, { port: state.port, viewlet: state.viewlet || '' });
  return {
    ok: true,
    status: 'running',
    ready: true,
    ...base,
    pid: state.pid,
    port: state.port,
    startedAt: state.startedAt,
    ageSeconds,
    cpt: state.cpt,
    viewlet: state.viewlet,
    health: health.status,
    logTail: tailFile(paths.logFile, 8),
    ...auth.urls,
    impersonation: auth.impersonation,
  };
}

