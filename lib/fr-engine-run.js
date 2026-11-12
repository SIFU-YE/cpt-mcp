// cpt-mcp/lib/fr-engine-run.js —— 触发「真实 FineReport 引擎」对 .cpt 的加载校验（verify:fr）
//
// 背景：fr_engine_check 只读 np.mm run verify:fr 落盘的 JSON 报告，但无 shell 的会话
// （如 sandbox2）无法手动执行该命令。本模块让 MCP 工具能安全地拉起
// scripts/verify-fr-engine.mjs（编译 FrEngineProbe.java 并用 FR 自带 JRE 逐份加载模板）。
//
// 安全设计（对齐 lib/fr-decompile.js 的 decompileCpt 既有模式）：
//   - spawn 数组参数，不经 shell → 无命令注入面
//   - env 白名单（只透传 FR/java 运行必需变量）→ 不透传整个 process.env
//   - windowsHide + 320s 超时 + 输出截断
//   - 不绕过路径围栏：cpt 必须已通过 assertToolPath（FR_HOME 内样本仍由调用方按只读处理）
//   - 不伪造成功：子进程退出码 / Java 缺失 / FR_HOME 缺失都如实返回

import { existsSync, readFileSync, statSync } from 'node:fs';
import fsx from 'node:fs';
import { join, dirname, basename, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { platform } from 'node:os';
import { fileURLToPath } from 'node:url';
import { detectFrHome } from './fr-decompile.js';
import { assertToolPath } from './security.js';

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const script = join(projectRoot, 'scripts', 'verify-fr-engine.mjs');
const isWin = platform() === 'win32';

function truncate(s, n = 4000) {
  s = s || '';
  return s.length > n ? s.slice(0, n) + `\n...[截断，共 ${s.length} 字符]` : s;
}

function envWhitelist(frHome) {
  return {
    PATH: process.env.PATH || '',
    SYSTEMROOT: process.env.SYSTEMROOT || '',
    TEMP: process.env.TEMP || '',
    USERPROFILE: process.env.USERPROFILE || '',
    HOME: process.env.HOME || '',
    LANG: process.env.LANG || '',
    FR_HOME: frHome,
    JAVA_HOME: process.env.JAVA_HOME || join(frHome, isWin ? 'jdk' : 'jdk'),
    JAVAC: process.env.JAVAC || 'javac',
  };
}

/**
 * 触发 verify:fr 引擎校验。
 * @param {string} cptPath 目标 .cpt（必须已过路径围栏）
 * @param {{roundTrip?: string, batch?: string[]}} opts
 *   roundTrip: 单文件模式的可选「导出重读」参考 .cpt（对齐 verify-fr-engine.mjs 语义）
 *   batch: 批量模式，传多个 .cpt（一次 JVM 启动逐份加载+导出重读）
 * @returns 结构化结果：{ok, status: 'pass'|'fail'|'timeout'|'spawn-error'|'missing-tool'|'bad-input', ...}
 */
export async function runFrEngineCheck(cptPath, { roundTrip, batch } = {}) {
  // 1) 路径与输入校验
  // 2026-10-30 修（sandbox4/v1 实测缺口）：批量模式原先仍强制 path（schema 拒绝 + 租约按单文件绑定），
  // 想一次校验 5 份模板只能逐份调用；现在 batch 模式 path 可省略，path 仅作为返回体里的上下文/兼容入参。
  // 注意保留旧语义：显式传 batch（含空数组/非数组）即批量意图，坏 batch 直接 bad-input，绝不当单文件跑。
  const batchIntent = batch !== undefined && batch !== null;
  const hasBatch = Array.isArray(batch) && batch.length > 0;
  if (batchIntent && !hasBatch) {
    return { ok: false, status: 'bad-input', cpt: null, hint: 'batch 模式至少给一个 .cpt（batch 必须是长度 ≥1 的数组）' };
  }
  if (!hasBatch && (cptPath == null || String(cptPath).trim() === '')) {
    return { ok: false, status: 'bad-input', cpt: null, hint: '需要 path（单文件）或 batch（批量，至少一个 .cpt）' };
  }
  let cpt = null;
  if (cptPath != null && String(cptPath).trim() !== '') {
    cpt = assertToolPath('fr_engine_check', cptPath, { write: false });
    if (!existsSync(cpt)) return { ok: false, status: 'bad-input', cpt, hint: `${cpt} 不存在` };
  }
  const inputList = hasBatch
    ? batch.map((b) => assertToolPath('fr_engine_check', b, { write: false }))
    : [cpt];
  if (hasBatch && inputList.length === 0) return { ok: false, status: 'bad-input', cpt, hint: 'batch 模式至少给一个 .cpt' };
  for (const ip of inputList) {
    if (!existsSync(ip)) return { ok: false, status: 'bad-input', cpt, hint: `${ip} 不存在` };
  }
  if (!cpt) cpt = inputList[0]; // 纯批量模式：返回体以第一批路径作为上下文
  // 单文件模式下 roundTrip 若给也校验（批量模式忽略 roundTrip）
  if (!hasBatch && roundTrip) {
    const rt = assertToolPath('fr_engine_check', roundTrip, { write: false });
    if (!existsSync(rt)) return { ok: false, status: 'bad-input', cpt, hint: `roundTrip 参考 ${rt} 不存在` };
    // 同路径守卫（2026-09-27）：roundTrip 与输入同路径会被旧版 probe 当作导出目标覆写源模板
    // （实测覆写后 FR writer 丢 TopJS 块）。探针已改为临时文件导出，此处仍早期拒绝以绝后患。
    let rtReal, cptReal;
    try { rtReal = fsx.realpathSync.native(rt); } catch { rtReal = rt; }
    try { cptReal = fsx.realpathSync.native(cpt); } catch { cptReal = cpt; }
    if (rtReal === cptReal) {
      return { ok: false, status: 'bad-input', cpt, hint: `roundTrip 参考 ${rt} 与输入模板相同（不允许）。导出重读由探针内部用临时文件完成，无需也绝不能指向源模板本身。` };
    }
  }

  // 2) 环境预检（优雅降级，不抛错）
  const det = detectFrHome();
  if (!det.frHome) {
    return { ok: false, status: 'missing-tool', cpt, hint: '未探测到本机 FineReport 安装目录（设置 FR_HOME 指向引擎/设计器根目录）。请先装 FR 或用 fr_detect/fr_inspect 盘点。', searched: '' };
  }
  const java = join(det.frHome, 'jre', 'bin', isWin ? 'java.exe' : 'java');
  if (!existsSync(java)) {
    return { ok: false, status: 'missing-tool', cpt, frHome: det.frHome, hint: `未找到 FR 自带 JRE: ${java}` };
  }

  // 3) 拉起 verify-fr-engine.mjs（数组参数，不经 shell）
  const args = [script];
  if (hasBatch) args.push('--batch', ...inputList);
  else {
    args.push(cpt);
    if (roundTrip) args.push(assertToolPath('fr_engine_check', roundTrip, { write: false }));
  }
  return new Promise((resolveP) => {
    const child = spawn(process.execPath, args, {
      cwd: projectRoot,
      windowsHide: true,
      env: envWhitelist(det.frHome),
    });
    let out = ''; let err = '';
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      resolveP({ ok: false, status: 'timeout', cpt, frHome: det.frHome, input: inputList.map((x) => basename(x)), log: truncate(err || out), hint: '引擎校验超时（320s 上限）已被 kill。可先 validate_cpt 确认结构，或稍后重试。' });
    }, 320_000);
    child.stdout.on('data', (b) => { out += b.toString('utf8'); });
    child.stderr.on('data', (b) => { err += b.toString('utf8'); });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolveP({ ok: false, status: 'spawn-error', cpt, frHome: det.frHome, log: e.message, hint: '无法启动 verify:fr 子进程（环境异常）。' });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      // 逐份读回报告，给出可读结论
      const statusOf = (ip) => {
        const name = `${basename(ip)}.json`;
        const dir = join(dirname(ip), '.fr-engine-check');
        const p = join(dir, name);
        if (!existsSync(p)) return { status: 'not-run', path: p };
        let r;
        try { r = JSON.parse(readFileSync(p, 'utf8')); } catch { return { status: 'report-corrupt', path: p }; }
        const stale = statSync(p).mtimeMs < (existsSync(ip) ? statSync(ip).mtimeMs : 0);
        return { status: r.status, path: p, stale, report: r };
      };
      const perInput = inputList.map((ip) => ({ cpt: ip, ...statusOf(ip) }));
      const allPass = perInput.every((x) => x.status === 'pass' && !x.stale);
      resolveP({
        ok: code === 0 && allPass,
        status: code === 0 ? 'pass' : 'fail',
        cpt,
        frHome: det.frHome,
        input: perInput,
        exitCode: code,
        log: truncate((out + (err ? '\n--- stderr ---\n' + err : ''))),
        hint: code === 0
          ? 'verify:fr 已执行完成：结论见 input[].status（pass=引擎可加载；随后可用 fr_engine_check 复查）。'
          : `verify:fr 退出码 ${code}（引擎加载失败或 probe 编译失败）。先用 validate_cpt 修复结构，或 fr_detect 确认 FR_HOME。`,
      });
    });
  });
}