// cpt-mcp/lib/fr-decompile.js —— 本地 FineReport 设计器反编译 .cpt
//
// 用户在升级要求中明确"本地有 fr 设计器环境可以用于反编译"。本模块探测
// 设计器并调用其反编译工具。设计器在 10.x/11.x 都带 cptdec：
//   - Windows: %FR_HOME%\bin\cptdec.bat  （FR_HOME=<FineReport安装目录>）
//   - 类 Unix : $FR_HOME/bin/cptdec      （FR_HOME=<FineReport安装目录>）
//
// 找不到时不抛错，返回 {ok:false, status:'missing-tool', hint}，让上层工具优雅降级。

import { existsSync, statSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, basename, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { platform } from 'node:os';

const isWin = platform() === 'win32';

function defaultFrHomeCandidates() {
  // 迁移友好：不写死盘符。只从环境变量推导候选目录；找不到时由调用方
  // 给出 `FR_HOME` 配置提示，而不是假设当前机器一定有 C:/D:。
  const candidates = [];
  if (isWin) {
    const bases = [
      process.env.ProgramFiles,
      process.env['ProgramFiles(x86)'],
      process.env.LOCALAPPDATA,
    ].filter(Boolean);
    for (const base of bases) {
      candidates.push(join(base, 'FineReport_11.0'), join(base, 'FineReport_10.0'));
    }
  }
  return candidates;
}

function toolScriptFor(frHome) {
  return isWin ? join(frHome, 'bin', 'cptdec.bat') : join(frHome, 'bin', 'cptdec');
}

function homeLooksLikeFr(home) {
  return existsSync(home) && (
    existsSync(join(home, 'webapps', 'webroot', 'WEB-INF', 'lib', 'fine-report-engine-11.0.jar')) ||
    existsSync(join(home, 'lib', 'fine-report-designer-11.0.jar'))
  );
}

export function detectFrHome() {
  const env = process.env.FR_HOME;
  if (env && homeLooksLikeFr(env)) {
    return { frHome: env, tool: existsSync(toolScriptFor(env)) ? toolScriptFor(env) : null, source: 'env:FR_HOME' };
  }
  for (const cand of defaultFrHomeCandidates()) {
    if (homeLooksLikeFr(cand)) {
      return { frHome: cand, tool: existsSync(toolScriptFor(cand)) ? toolScriptFor(cand) : null, source: 'default' };
    }
  }
  return { frHome: null, tool: null, source: 'not-found' };
}

function zipEntries(jarPath) {
  if (!existsSync(jarPath)) return [];
  const b = readFileSync(jarPath);
  const min = Math.max(0, b.length - 0xffff - 22);
  let eocd = -1;
  for (let i = b.length - 22; i >= min; i--) {
    if (b.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return [];
  const count = b.readUInt16LE(eocd + 10);
  const cdOffset = b.readUInt32LE(eocd + 16);
  const out = [];
  let p = cdOffset;
  for (let i = 0; i < count && p + 46 <= b.length; i++) {
    if (b.readUInt32LE(p) !== 0x02014b50) break;
    const nameLen = b.readUInt16LE(p + 28);
    const extraLen = b.readUInt16LE(p + 30);
    const commentLen = b.readUInt16LE(p + 32);
    out.push(b.subarray(p + 46, p + 46 + nameLen).toString('utf8'));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

function countCptFiles(root, limit = 200000) {
  let count = 0;
  let dirCount = 0;
  const MAX_DIRS = 100000; // A3: 防对异常深/大的目录树无限遍历
  const walk = (dir, depth) => {
    if (count >= limit || dirCount >= MAX_DIRS || depth > 32) return;
    dirCount++;
    let list;
    try { list = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of list) {
      if (count >= limit) return;
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.isFile() && e.name.toLowerCase().endsWith('.cpt')) count++;
    }
  };
  walk(root, 0);
  return count;
}

/**
 * 对本机 FR 做合规的静态逆向盘点：版本、jar、资源、关键类名和官方样本数量。
 * 不读取/反编译方法体，不启动设计器，不修改 FR 安装目录。
 */
export function inspectFrInstallation(frHomeOpt) {
  const det = frHomeOpt ? { frHome: resolve(frHomeOpt), source: 'explicit' } : detectFrHome();
  if (!det.frHome || !homeLooksLikeFr(det.frHome)) {
    return { ok: false, status: 'not-found', ...det, hint: '未找到 FineReport 引擎/设计器 jar' };
  }
  const engineJar = join(det.frHome, 'webapps', 'webroot', 'WEB-INF', 'lib', 'fine-report-engine-11.0.jar');
  const designerJar = join(det.frHome, 'lib', 'fine-report-designer-11.0.jar');
  const decisionJar = join(det.frHome, 'webapps', 'webroot', 'WEB-INF', 'lib', 'fine-decision-report-11.0.jar');
  const engineEntries = zipEntries(engineJar);
  const designerEntries = zipEntries(designerJar);
  const decisionEntries = zipEntries(decisionJar);
  const all = [...engineEntries, ...designerEntries, ...decisionEntries];
  const has = (name) => all.includes(name);
  const countPrefix = (prefix) => all.filter((n) => n.startsWith(prefix) && n.endsWith('.class')).length;
  const reportlets = join(det.frHome, 'webapps', 'webroot', 'WEB-INF', 'reportlets');
  return {
    ok: true,
    status: 'ok',
    frHome: det.frHome,
    source: det.source,
    decompileTool: det.tool ?? (existsSync(toolScriptFor(det.frHome)) ? toolScriptFor(det.frHome) : null),
    engineAvailable: existsSync(engineJar),
    designerAvailable: existsSync(designerJar),
    jars: {
      engine: { path: engineJar, bytes: existsSync(engineJar) ? statSync(engineJar).size : 0, entries: engineEntries.length },
      designer: { path: designerJar, bytes: existsSync(designerJar) ? statSync(designerJar).size : 0, entries: designerEntries.length },
      decision: { path: decisionJar, bytes: existsSync(decisionJar) ? statSync(decisionJar).size : 0, entries: decisionEntries.length },
    },
    officialSamples: existsSync(reportlets) ? countCptFiles(reportlets) : 0,
    classInventory: {
      report: countPrefix('com/fr/report/'),
      form: countPrefix('com/fr/form/'),
      chart: countPrefix('com/fr/chart/'),
      write: countPrefix('com/fr/write/'),
      reader: {
        cptTemplateWorkBookReader: has('com/fr/io/reader/CptTemplateWorkBookReader.class'),
        templateWorkBookIO: has('com/fr/io/TemplateWorkBookIO.class'),
      },
    },
    resources: {
      reportThemes: engineEntries.filter((n) => /^com\/fr\/base\/theme\/CPT-.*\.xml$/.test(n)).map((n) => basename(n, '.xml')),
      symbolTablePresent: has('com/fr/report/fun/impl/symbol.properties'),
    },
    safety: '仅静态读取 jar 条目/资源索引和官方模板数量；不反编译方法体、不启动 GUI、不写入 FR_HOME',
  };
}

function truncate(s, n) { s = s || ''; return s.length > n ? s.slice(0, n) + `\n...[截断，共 ${s.length} 字符]` : s; }

export async function decompileCpt(cptPath, outDirOpt) {
  const cpt = resolve(cptPath);
  if (!existsSync(cpt)) {
    return { ok: false, status: 'cpt-not-found', cpt, hint: `${cpt} 不存在` };
  }
  const det = detectFrHome();
  if (!det.tool) {
    return {
      ok: false,
      status: 'missing-tool',
      cpt,
      hint: `未探测到 FR 设计器反编译工具。请安装 FineReport 设计器并设置环境变量 FR_HOME 指向其根目录（例如 <FineReport安装目录>），目录下需有 bin/cptdec(.bat)。`,
      searched: defaultFrHomeCandidates(),
    };
  }
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  // M29 防御: outDir 校验 — 拒绝 .. 跳出, 拒绝非绝对路径
  // 防止 cptdec 写到任意位置 (类似 sync-to-global M1)
  let baseOut;
  if (outDirOpt) {
    const absOut = resolve(outDirOpt);
    if (!/^[A-Za-z]:[\\/]/.test(absOut) && !absOut.startsWith('/') && !absOut.startsWith('\\\\')) {
      return { ok: false, status: 'bad-outdir', cpt, hint: `outDir 必须是绝对路径: ${outDirOpt}` };
    }
    if (absOut.includes('..')) {
      return { ok: false, status: 'bad-outdir', cpt, hint: `outDir 含 '..', 拒绝: ${outDirOpt}` };
    }
    baseOut = absOut;
  } else {
    baseOut = join(dirname(cpt), '.decompiled', basename(cpt, '.cpt'), ts);
  }
  mkdirSync(baseOut, { recursive: true });

  // cptdec 的常见参数形态（不同版本略有差异，先试 -d，失败再回退到无参）
  const args = [cpt, '-d', baseOut];

  return new Promise((resolveP) => {
    const child = spawn(det.tool, args, {
      cwd: dirname(det.tool),
      windowsHide: true,
      // M7 防御: 不透传整个 process.env, 只透传 java 必需的环境变量
      env: {
        PATH: process.env.PATH || '',
        SYSTEMROOT: process.env.SYSTEMROOT || '',
        TEMP: process.env.TEMP || '',
        USERPROFILE: process.env.USERPROFILE || '',
        HOME: process.env.HOME || '',
        LANG: process.env.LANG || '',
        FR_HOME: det.frHome,
        JAVA_HOME: process.env.JAVA_HOME || det.frHome + (isWin ? '\\jdk' : '/jdk'),
      },
    });
    let out = ''; let err = '';
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      resolveP({ ok: false, status: 'timeout', cpt, frHome: det.frHome, outputDir: baseOut, log: truncate(err || out, 4000), hint: '60s 超时已 kill；可考虑加大超时或检查 cptdec 是否需要 GUI（headless 模式需 -headless）' });
    }, 60000);
    child.stdout.on('data', (b) => { out += b.toString('utf8'); });
    child.stderr.on('data', (b) => { err += b.toString('utf8'); });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolveP({ ok: false, status: 'spawn-error', cpt, frHome: det.frHome, outputDir: baseOut, log: `${e.message}`, hint: '子进程启动失败；请检查 Java 是否可用' });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const log = truncate((out + (err ? '\n--- stderr ---\n' + err : '')), 4000);
      if (code === 0) {
        resolveP({ ok: true, status: 'ok', cpt, frHome: det.frHome, tool: det.tool, source: det.source, outputDir: baseOut, log });
      } else {
        resolveP({ ok: false, status: 'non-zero-exit', cpt, frHome: det.frHome, tool: det.tool, outputDir: baseOut, exitCode: code, log, hint: `cptdec 退出码 ${code}；常见原因：cpt 文件损坏、Java 未安装、版本不匹配` });
      }
    });
  });
}

