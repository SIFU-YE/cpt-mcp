import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { detectFrHome } from '../lib/fr-decompile.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.dirname(here);
const detected = detectFrHome();
if (!detected.frHome) throw new Error('未找到本机 FineReport 安装目录（可设置 FR_HOME）');

const frHome = detected.frHome;
const java = path.join(frHome, 'jre', 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
if (!existsSync(java)) throw new Error(`未找到 FR 自带 Java: ${java}`);

// 参数解析：支持 --batch（多文件一次 JVM 启动）与旧的单文件形式
//   verify-fr-engine.mjs [<cpt> [roundtrip]]      单文件（缺省用官方样本 产品明细.cpt）
//   verify-fr-engine.mjs --batch <a.cpt> <b.cpt>  批量：每文件自动做「加载+导出重读」
const argv = process.argv.slice(2);
const batch = argv[0] === '--batch';
const defaultInput = path.join(
  frHome, 'webapps', 'webroot', 'WEB-INF', 'reportlets', 'demo', 'basic', '产品明细.cpt',
);
// 路径加固（穿越防护的强制执行点）：本脚本是 FrEngineProbe 的唯一调用入口，
// 模型无法触达（MCP 工具层不拉起子进程）；此处在传给 JVM 前拒绝 NUL 与 ".." 段，
// 并统一规范化为真实绝对路径（fs.realpath 解析符号链接/相对段）。
const fsx = await import('node:fs');
function assertCliPath(p) {
  if (p.includes('\0') || p.split(/[\\/]+/).includes('..')) {
    throw new Error(`不允许路径穿越（NUL 或 ".." 段）: ${p}`);
  }
  return fsx.realpathSync.native(path.resolve(p));
}
const inputs = (batch ? argv.slice(1) : (argv[0] ? [argv[0]] : [defaultInput]))
  .filter(Boolean).map(assertCliPath);
if (inputs.length === 0) throw new Error('至少提供一个待验证 .cpt');
for (const input of inputs) {
  if (!existsSync(input)) throw new Error(`待验证 CPT 不存在: ${input}`);
}
const roundTrip = !batch && argv[1] ? assertCliPath(argv[1]) : null;
// 批量模式下 argv[1..] 全部是输入模板，不存在 roundtrip 参数位

const entries = [
  'jre/lib/*', '.install4j/*', 'lib/*', 'server/lib/*',
  'webapps/webroot/WEB-INF/lib/*', 'webapps/webroot/WEB-INF/customLib/*',
  'webapps/webroot/WEB-INF/classes',
].map((entry) => path.join(frHome, entry));
// javac / ecj 对 classpath 通配符的支持不同：javac 支持 "dir/*"，ecj batch 不支持。
// 统一展开为具体 jar 列表，两者通用。
function expandClasspath() {
  const seen = new Set();
  const jars = [];
  for (const base of [
    path.join(frHome, 'jre', 'lib'),
    path.join(frHome, '.install4j'),
    path.join(frHome, 'lib'),
    path.join(frHome, 'server', 'lib'),
    path.join(frHome, 'webapps', 'webroot', 'WEB-INF', 'lib'),
    path.join(frHome, 'webapps', 'webroot', 'WEB-INF', 'customLib'),
  ]) {
    let list;
    try { list = fsx.readdirSync(base); } catch { continue; }
    for (const f of list) {
      if (f.endsWith('.jar')) {
        const abs = path.join(base, f);
        if (!seen.has(abs)) { seen.add(abs); jars.push(abs); }
      }
    }
  }
  jars.push(path.join(frHome, 'webapps', 'webroot', 'WEB-INF', 'classes'));
  return jars.join(path.delimiter);
}
const classpath = expandClasspath();
const classes = path.join(tmpdir(), 'cpt-mcp-fr-probe-classes');
mkdirSync(classes, { recursive: true });

async function compileProbe() {
  const probe = path.join(here, 'FrEngineProbe.java');
  // 优先 FR 自带 ecj（Eclipse Compiler for Java，纯 jar，不需要系统 JDK；本机大概率无 javac）
  const ecjCandidates = (() => {
    try { return fsx.readdirSync(path.join(frHome, 'server', 'lib')).filter((f) => /^ecj[-.].*\.jar$/i.test(f)).map((f) => path.join(frHome, 'server', 'lib', f)); } catch { return []; }
  })();
  const ecj = ecjCandidates[0];
  if (ecj) {
    const viaEcj = spawnSync(java, ['-cp', ecj, 'org.eclipse.jdt.internal.compiler.batch.Main',
      '-source', '8', '-target', '8', '-proc:none', '-encoding', 'UTF-8',
      '-cp', classpath, '-d', classes, probe],
      { cwd: path.join(frHome, 'bin'), stdio: 'inherit', timeout: 120_000 });
    if (!viaEcj.error && viaEcj.status === 0) return;
    if (viaEcj.error) throw viaEcj.error;
    process.exit(viaEcj.status ?? 1);
  }
  // 无 ecj → 退回系统 javac（JAVAC env 或 PATH）
  const javac = process.env.JAVAC ?? 'javac';
  const viaJavac = spawnSync(javac, [
    '-source', '8', '-target', '8', '-proc:none', '-encoding', 'UTF-8',
    '-cp', classpath, '-d', classes, probe,
  ], { cwd: path.join(frHome, 'bin'), stdio: 'inherit', timeout: 120_000 });
  if (viaJavac.error) throw viaJavac.error;
  if (viaJavac.status !== 0) process.exit(viaJavac.status ?? 1);
}
await compileProbe();

const args = ['-cp', `${classes}${path.delimiter}${classpath}`, 'FrEngineProbe'];
if (batch) args.push('--batch', ...inputs);
else {
  args.push(inputs[0]);
  if (roundTrip) args.push(roundTrip);
}
// 安全守卫（2026-09-27）：校验过程对输入 .cpt 必须只读。spawn 前快照哈希，
// 跑完后逐份比对，任何输入被改动（如 probe 误把导出写回源路径）→ 立即失败退出且不落 pass 报告。
const { createHash } = await import('node:crypto');
function sha256Of(p) {
  return createHash('sha256').update(fsx.readFileSync(p)).digest('hex');
}
const hashesBefore = new Map(inputs.map((p) => [p, sha256Of(p)]));

const verified = spawnSync(java, args, {
  cwd: path.join(frHome, 'bin'), stdio: 'inherit', timeout: 300_000,
});
if (verified.error) throw verified.error;

const tampered = inputs.filter((p) => sha256Of(p) !== hashesBefore.get(p));
if (tampered.length > 0) {
  console.error('[verify-fr-engine] 严重：校验过程修改了输入模板（已拒绝出结论）:');
  for (const p of tampered) console.error('  - ' + p);
  process.exit(3);
}

// 验证结论落盘为 JSON 报告（供 MCP 的 fr_engine_check 只读工具查询）。
// 报告默认写到 CPT 同目录的 .fr-engine-check/ 下；但 FR 安装目录只读是硬边界，
// 输入是 FR_HOME 内官方样本时报告改写到项目根目录的 .fr-engine-check/。
try {
  const fs = await import('node:fs');
  const checkedAt = new Date().toISOString();
  const frRoot = path.resolve(frHome).replaceAll('\\', '/');
  for (const cpt of inputs) {
    const inFrHome = path.resolve(cpt).replaceAll('\\', '/').startsWith(`${frRoot}/`);
    const reportDir = inFrHome
      ? path.join(projectRoot, '.fr-engine-check')
      : path.join(path.dirname(cpt), '.fr-engine-check');
    fs.mkdirSync(reportDir, { recursive: true });
    const report = {
      cpt,
      status: verified.status === 0 ? 'pass' : 'fail',
      roundTrip: Boolean(roundTrip) || batch,
      frHome,
      checkedAt,
      tool: 'node scripts/verify-fr-engine.mjs',
    };
    writeFileSync(
      path.join(reportDir, `${path.basename(cpt)}.json`),
      JSON.stringify(report, null, 2),
    );
  }
} catch { /* 报告写失败不影响验证结论 */ }

process.exit(verified.status ?? 1);
