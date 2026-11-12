// cpt-mcp/test/fr-preview.test.js —— 本地独立 FR 预览实例（单元测试，不真正启动 FR）
//
// 覆盖：
//   1. 独立 CATALINA_BASE 的构建（conf 端口改写 / 只读目录 junction / finedb 种子 / 可写目录）
//   2. 状态查询与参数校验（不安装 FR / 不传 path 时的三态返回）
//   3. 空实例 stop 的 not-running 语义
//
// 真启动（30~60s）不在默认 npm test 里跑：设 CPT_MCP_FR_PREVIEW_E2E=1 时才跑一条 smoke；
// 日常核验用 `node scripts/fr-preview.mjs start <cpt>` 或 MCP 工具 start_fr_preview。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  frPreviewPaths,
  prepareRuntime,
  startFrPreview,
  stopFrPreview,
  frPreviewStatus,
} from '../lib/fr-preview.js';

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function write(file, content = 'x') {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

/** 造一个「结构像 FR」的假安装目录；prepareRuntime 只依赖这些结构，不碰真实 jar。 */
function fakeFrHome(root) {
  const home = path.join(root, 'FineReport_11.0');
  write(path.join(home, 'server', 'conf', 'server.xml'),
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<Server port="8005" shutdown="SHUTDOWN">\n' +
    '  <Service name="Catalina">\n' +
    '    <Connector port="8080" protocol="HTTP/1.1" />\n' +
    '  </Service>\n' +
    '</Server>\n');
  write(path.join(home, 'server', 'conf', 'catalina.properties'), '# fake');
  write(path.join(home, 'server', 'lib', 'bootstrap.jar'), 'jar');
  write(path.join(home, 'server', 'lib', 'tomcat-juli.jar'), 'jar');
  write(path.join(home, 'webapps', 'webroot', 'WEB-INF', 'lib', 'fine-report-engine-11.0.jar'), 'engine');
  write(path.join(home, 'webapps', 'webroot', 'WEB-INF', 'config', 'encryption.properties'), 'fake-key=1');
  write(path.join(home, 'webapps', 'webroot', 'WEB-INF', 'embed', 'prop', 'fine-prop.xml'), 'prop');
  write(path.join(home, 'bin', 'embed', 'finedb', 'db.script'), 'SET DATABASE TEST');
  write(path.join(home, 'bin', 'embed', 'finedb', 'db.properties'), 'version=2');
  return home;
}

test('prepareRuntime：独立 CATALINA_BASE 端口改写 + junction + finedb 种子 + 可写目录', () => {
  const root = tmpDir('fr-preview-unit-');
  const prevHome = process.env.CPT_MCP_FR_PREVIEW_HOME;
  process.env.CPT_MCP_FR_PREVIEW_HOME = path.join(root, 'preview-home');
  try {
    const frHome = fakeFrHome(root);
    const paths = frPreviewPaths();
    // 预置一份「已初始化」种子：应优先于 FR 安装目录里的空库被复制。
    write(path.join(paths.seedDir, 'db.script'), 'SET DATABASE SEED');

    prepareRuntime(frHome, paths, 19075, 20075);

    // 1) server.xml 端口被改写到独立端口（HTTP + shutdown），注释里的示例不动
    const serverXml = fs.readFileSync(paths.serverXml, 'utf8');
    assert.match(serverXml, /<Server port="20075"/);
    assert.match(serverXml, /port="19075"/);
    assert.doesNotMatch(serverXml, /port="8080"/);

    // 2) 只读目录用 junction 指回 FR 安装（内容可读，不复制）
    const libLink = path.join(paths.webInfDir, 'lib');
    assert.equal(fs.readFileSync(path.join(libLink, 'fine-report-engine-11.0.jar'), 'utf8'), 'engine');
    const config = path.join(paths.webInfDir, 'config', 'encryption.properties');
    assert.ok(fs.existsSync(config), 'config 应被复制到独立 base');

    // 3) finedb 用种子（不是 FR 安装里的空库）
    assert.equal(fs.readFileSync(path.join(paths.webInfDir, 'embed', 'finedb', 'db.script'), 'utf8'), 'SET DATABASE SEED');

    // 4) 可写目录是真实目录，不是 junction（FR 运行期要写 reportlets/cache/temp/logs）
    for (const sub of ['reportlets', 'cache', 'temp', 'reportlets_versions', 'logs']) {
      assert.ok(fs.lstatSync(path.join(paths.webInfDir, sub)).isDirectory(), `${sub} 应为真实目录`);
    }
    assert.ok(fs.existsSync(path.join(paths.runtimeDir, 'logs')));
    assert.ok(fs.existsSync(path.join(paths.runtimeDir, 'temp')));
    assert.ok(fs.existsSync(path.join(paths.runtimeDir, 'work')));
  } finally {
    if (prevHome === undefined) delete process.env.CPT_MCP_FR_PREVIEW_HOME;
    else process.env.CPT_MCP_FR_PREVIEW_HOME = prevHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('prepareRuntime：没有种子时回退到 FR_HOME/bin/embed/finedb，且绝不带 db.lck', () => {
  const root = tmpDir('fr-preview-unit2-');
  const prevHome = process.env.CPT_MCP_FR_PREVIEW_HOME;
  process.env.CPT_MCP_FR_PREVIEW_HOME = path.join(root, 'preview-home');
  try {
    const frHome = fakeFrHome(root);
    write(path.join(frHome, 'bin', 'embed', 'finedb', 'db.lck'), 'locked');
    const paths = frPreviewPaths();
    prepareRuntime(frHome, paths, 19075, 20075);
    assert.equal(fs.readFileSync(path.join(paths.webInfDir, 'embed', 'finedb', 'db.script'), 'utf8'), 'SET DATABASE TEST');
    assert.ok(!fs.existsSync(path.join(paths.webInfDir, 'embed', 'finedb', 'db.lck')), 'db.lck 不能进独立实例');
  } finally {
    if (prevHome === undefined) delete process.env.CPT_MCP_FR_PREVIEW_HOME;
    else process.env.CPT_MCP_FR_PREVIEW_HOME = prevHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('frPreviewStatus：没有 state.json 时返回 not-running（只读、不启动）', async () => {
  const root = tmpDir('fr-preview-unit3-');
  const prevHome = process.env.CPT_MCP_FR_PREVIEW_HOME;
  process.env.CPT_MCP_FR_PREVIEW_HOME = path.join(root, 'preview-home');
  try {
    const status = await frPreviewStatus();
    assert.equal(status.ok, true);
    assert.equal(status.status, 'not-running');
    assert.equal(status.seedConfigured, false);
    assert.ok(status.runtimeDir.startsWith(root));
  } finally {
    if (prevHome === undefined) delete process.env.CPT_MCP_FR_PREVIEW_HOME;
    else process.env.CPT_MCP_FR_PREVIEW_HOME = prevHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('startFrPreview：path 缺失/非 cpt/不存在的三态错误（不启动任何进程）', async () => {
  const missing = await startFrPreview('');
  assert.equal(missing.ok, false);
  assert.ok(['bad-input', 'fr-not-installed'].includes(missing.status));

  const notCpt = await startFrPreview(path.join(os.tmpdir(), 'x.txt'));
  assert.equal(notCpt.ok, false);
  assert.equal(notCpt.status, 'bad-input');

  const notExist = await startFrPreview(path.join(os.tmpdir(), 'definitely-missing-xyz.cpt'));
  assert.equal(notExist.ok, false);
  assert.equal(notExist.status, 'bad-input');
});

test('frPreviewStatus：进程活着但端口未响应 = starting；超时太久则 stale（异步启动语义）', async () => {
  const root = tmpDir('fr-preview-unit5-');
  const prevHome = process.env.CPT_MCP_FR_PREVIEW_HOME;
  process.env.CPT_MCP_FR_PREVIEW_HOME = path.join(root, 'preview-home');
  try {
    const paths = frPreviewPaths();
    fs.mkdirSync(paths.home, { recursive: true });
    // 用当前测试进程的 pid 冒充「已拉起但还没监听端口」的实例；端口 1 在回环上必然拒绝。
    const writeState = (startedAt) => fs.writeFileSync(paths.stateFile, JSON.stringify({
      pid: process.pid, port: 1, shutdownPort: 2, startedAt, cpt: 'x.cpt', viewlet: 'x.cpt',
    }), 'utf8');

    writeState(new Date().toISOString());
    const starting = await frPreviewStatus();
    assert.equal(starting.ok, true);
    assert.equal(starting.status, 'starting');
    assert.equal(starting.ready, false);
    assert.ok(starting.hint.includes('fr_preview_status'));

    writeState(new Date(Date.now() - 10 * 60 * 1000).toISOString()); // 10 分钟前：判 stale
    const stale = await frPreviewStatus();
    assert.equal(stale.status, 'stale');
  } finally {
    if (prevHome === undefined) delete process.env.CPT_MCP_FR_PREVIEW_HOME;
    else process.env.CPT_MCP_FR_PREVIEW_HOME = prevHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('stopFrPreview：没有实例时返回 not-running（不报错、不清理用户文件）', async () => {
  const prevHome = process.env.CPT_MCP_FR_PREVIEW_HOME;
  process.env.CPT_MCP_FR_PREVIEW_HOME = path.join(tmpDir('fr-preview-unit4-'), 'preview-home');
  try {
    const result = await stopFrPreview();
    // 本机没装 FR 时是 fr-not-installed，装了 FR 则是 not-running；两者都必须是「非成功但无副作用」。
    assert.equal(result.ok, false);
    assert.ok(['not-running', 'fr-not-installed'].includes(result.status));
  } finally {
    if (prevHome === undefined) delete process.env.CPT_MCP_FR_PREVIEW_HOME;
    else process.env.CPT_MCP_FR_PREVIEW_HOME = prevHome;
  }
});
