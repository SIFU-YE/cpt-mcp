// cpt-mcp/test/fr-preview-auth.test.js —— 本地预览实例的 admin 伪装（单元测试，不启动真实 FR）
//
// 覆盖：
//   1. 配置解析（环境变量覆盖）+ 页面内嵌 Dec.system 解析（FR 的 JS 字符串转义）
//   2. FR 前端传输加密（RSA/PKCS#1 v1.5 + 122 字节分片 + "---" 连接）的可逆性
//   3. 本地入口页的 next 白名单（只允许 127.0.0.1 同端口 /webroot/，防开放重定向）
//   4. 登录客户端：复刻 FR11 登录协议（含初始化建号 POST /login/admin），用本地 mock FR 校验
//      —— 断言请求头 transEncryptLevel、密文可用私钥解开、token 提取、错误码映射；
//   5. attachPreviewImpersonation：成功写入口页并包装 URL / 失败/关闭时退回匿名直连 URL。
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import {
  attachPreviewImpersonation,
  decodeFrJsStringLiteral,
  encryptFrTransportPassword,
  isLoopbackHttpUrl,
  loginFrPreview,
  parseFrEmbeddedJson,
  previewIdentityConfig,
  resolveBootstrapTarget,
  writeAuthEntryFile,
} from '../lib/fr-preview.js';

// ---------------------------------------------------------------------------
// 工具：临时目录 / mock FR / RSA
// ---------------------------------------------------------------------------

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const der = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  // 模拟 FR 登录页：公钥 base64 里带 CRLF 折行
  const pemBody = der.match(/.{1,76}/g).join('\r\n');
  return { publicKey, privateKey, der, pemBody };
}

function decryptSections(cipherText, privateKey) {
  return String(cipherText)
    .split('---')
    .map((section) => crypto.privateDecrypt({ key: privateKey, padding: crypto.constants.RSA_PKCS1_PADDING }, Buffer.from(section, 'base64')).toString('utf8'))
    .join('');
}

/** 把 JSON 配置塞进 FR 那种 `Dec.system = JSON.parse('...')` 单引号 JS 字符串。 */
function embedSystemJson(config) {
  const raw = JSON.stringify(config).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  return `<script type="text/javascript">\nwindow.Dec = window.Dec || {};\nwindow.Dec.system = JSON.parse('${raw}');\n</script>`;
}

function makeJwt(expSeconds) {
  const b64url = (v) => Buffer.from(JSON.stringify(v)).toString('base64url');
  return `${b64url({ alg: 'HS256' })}.${b64url({ sub: 'admin', exp: expSeconds })}.signature`;
}

async function startMockFr(handler) {
  const server = http.createServer((req, res) => {
    Promise.resolve(handler(req, res)).catch((e) => {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end(String(e));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    server,
    port: server.address().port,
    base: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (d) => {
      raw += d;
    });
    req.on('end', () => resolve(raw));
  });
}

function withEnv(env, fn) {
  const prev = {};
  for (const [k, v] of Object.entries(env)) {
    prev[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const [k, v] of Object.entries(prev)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    });
}

// ---------------------------------------------------------------------------
// 1. 配置 + 页面解析
// ---------------------------------------------------------------------------

test('previewIdentityConfig：默认 admin 伪装开启，环境变量可覆盖账号/口令/开关/自动初始化', async () => {
  await withEnv({
    CPT_MCP_FR_PREVIEW_IMPERSONATE: undefined,
    CPT_MCP_FR_PREVIEW_ADMIN_USER: undefined,
    CPT_MCP_FR_PREVIEW_ADMIN_PASSWORD: undefined,
    CPT_MCP_FR_PREVIEW_AUTO_INIT: undefined,
  }, () => {
    const cfg = previewIdentityConfig();
    assert.equal(cfg.enabled, true);
    assert.equal(cfg.username, 'admin');
    assert.equal(cfg.password, 'local-preview-placeholder');
    assert.equal(cfg.autoInit, true);
  });

  await withEnv({ CPT_MCP_FR_PREVIEW_IMPERSONATE: 'off' }, () => {
    assert.equal(previewIdentityConfig().enabled, false);
  });
  await withEnv({ CPT_MCP_FR_PREVIEW_ADMIN_USER: 'report_admin', CPT_MCP_FR_PREVIEW_ADMIN_PASSWORD: 'test-admin-password' }, () => {
    const cfg = previewIdentityConfig();
    assert.equal(cfg.username, 'report_admin');
    assert.equal(cfg.password, 'test-admin-password');
  });
  await withEnv({ CPT_MCP_FR_PREVIEW_AUTO_INIT: '0' }, () => {
    assert.equal(previewIdentityConfig().autoInit, false);
  });
});

test('parseFrEmbeddedJson：还原 FR 页面里的 JS 单引号字符串（转义引号/CRLF/斜杠）', () => {
  const system = {
    encryptionType: 0,
    transmissionEncryption: 2,
    encryptionKey: 'MIIB\r\nline2+/x\r\n',
    decryptionKey: 'A985601ACCF15C78',
    hyperlink: { doc: 'https://help.fanruan.com/a/b' },
  };
  const html = embedSystemJson(system);
  const parsed = parseFrEmbeddedJson(html);
  assert.ok(parsed, '应能解析出 Dec.system');
  assert.equal(parsed.encryptionType, 0);
  assert.equal(parsed.encryptionKey, system.encryptionKey);
  assert.equal(parsed.hyperlink.doc, system.hyperlink.doc);
  assert.equal(parseFrEmbeddedJson('<html>no config</html>'), null);
});

test('decodeFrJsStringLiteral：JS 转义还原（反斜杠/引号/斜杠/换行/U+XXXX）', () => {
  assert.equal(decodeFrJsStringLiteral("a\\\"b"), 'a"b');
  assert.equal(decodeFrJsStringLiteral("a\\'b"), "a'b");
  assert.equal(decodeFrJsStringLiteral('a\\/b'), 'a/b');
  assert.equal(decodeFrJsStringLiteral('a\\\\b'), 'a\\b');
  assert.equal(decodeFrJsStringLiteral('a\\nb'), 'a\nb');
  assert.equal(decodeFrJsStringLiteral('\\u4e2d\\u6587'), '中文');
});

// ---------------------------------------------------------------------------
// 2. 传输加密
// ---------------------------------------------------------------------------

test('encryptFrTransportPassword：RSA/PKCS#1 v1.5 可被私钥解开（短口令）', () => {
  const { privateKey, pemBody } = makeKeyPair();
  const cipher = encryptFrTransportPassword('local-preview-placeholder', pemBody);
  assert.equal(decryptSections(cipher, privateKey), 'local-preview-placeholder');
});

test('encryptFrTransportPassword：长口令按 122 字节分片，用 "---" 连接，逐段可解', () => {
  const { privateKey, pemBody } = makeKeyPair();
  const plain = 'A'.repeat(122) + 'B'.repeat(122) + '中文口令';
  const cipher = encryptFrTransportPassword(plain, pemBody);
  const sections = cipher.split('---');
  assert.equal(sections.length, Math.ceil(plain.length / 122));
  assert.equal(decryptSections(cipher, privateKey), plain);
});

test('encryptFrTransportPassword：非法公钥/空口令抛错', () => {
  assert.throws(() => encryptFrTransportPassword('', 'MIIB'), /password 不能为空/);
  assert.throws(() => encryptFrTransportPassword('x', ''), /缺少 FR 传输公钥/);
  assert.throws(() => encryptFrTransportPassword('x', '不是base64!!'), /不是合法 base64/);
  assert.throws(() => encryptFrTransportPassword('x', 'TUlJQg=='), /无法解析/);
});

// ---------------------------------------------------------------------------
// 3. 本地入口页 / next 白名单
// ---------------------------------------------------------------------------

test('resolveBootstrapTarget：只允许 127.0.0.1 同端口 /webroot/ 下的 http 目标', () => {
  assert.equal(resolveBootstrapTarget('http://127.0.0.1:8080/webroot/decision/view/report?viewlet=a.cpt', { port: 8080 }).ok, true);
  const bad = [
    ['https://127.0.0.1:8080/webroot/x', '只允许 http'],
    ['http://localhost:8080/webroot/x', '只允许 127.0.0.1'],
    ['http://127.0.0.1:9090/webroot/x', '端口与本机预览实例不一致'],
    ['http://127.0.0.1:8080/evil', '只允许 /webroot/ 路径'],
    ['http://user:pass@127.0.0.1:8080/webroot/x', '不允许携带凭据'],
    ['/webroot/x', '不是绝对 URL'],
  ];
  for (const [url, reason] of bad) {
    const r = resolveBootstrapTarget(url, { port: 8080 });
    assert.equal(r.ok, false, url);
    assert.match(r.reason, new RegExp(reason), url);
  }
  assert.equal(resolveBootstrapTarget('', { port: 8080 }).ok, false);
});

test('isLoopbackHttpUrl：只认 127.0.0.1 的 http', () => {
  assert.equal(isLoopbackHttpUrl('http://127.0.0.1:63947'), true);
  assert.equal(isLoopbackHttpUrl('http://127.0.0.1:63947/webroot/decision'), true);
  assert.equal(isLoopbackHttpUrl('https://127.0.0.1:63947'), false);
  assert.equal(isLoopbackHttpUrl('http://localhost:63947'), false);
  assert.equal(isLoopbackHttpUrl('http://doris.example.internal:39030'), false);
  assert.equal(isLoopbackHttpUrl('not a url'), false);
});

test('writeAuthEntryFile：写入会话入口页（含 Cookie 写入与本地校验），拒绝非法 token/next', () => {
  const dir = tmpDir('fr-auth-entry-');
  const paths = { authEntryFile: path.join(dir, '_cpt_mcp_fr_auth.html') };
  const file = writeAuthEntryFile(paths, {
    token: 'eyJhbGciOiJIUzI1NiJ9.payload.sig',
    defaultNext: 'http://127.0.0.1:63947/webroot/decision/view/report?viewlet=a.cpt',
    port: 63947,
  });
  const html = fs.readFileSync(file, 'utf8');
  assert.match(html, /fine_auth_token/);
  assert.match(html, /127\.0\.0\.1/);
  assert.match(html, /eyJhbGciOiJIUzI1NiJ9\.payload\.sig/);
  assert.match(html, /\/webroot\//);

  // token 里不允许出现能破坏 script 的字符
  assert.throws(() => writeAuthEntryFile(paths, { token: 'a"b</script>', defaultNext: 'http://127.0.0.1:1/webroot/x', port: 1 }), /令牌格式异常/);
  // 默认跳转必须是本地预览页
  assert.throws(() => writeAuthEntryFile(paths, { token: 'abc.def', defaultNext: 'http://evil.com/webroot/x', port: 1 }), /不是合法的本地预览 URL/);
});

// ---------------------------------------------------------------------------
// 4. 登录客户端（mock FR）
// ---------------------------------------------------------------------------

test('loginFrPreview：复刻 FR11 登录协议（RSA 传输加密 + transEncryptLevel 头），取回 accessToken', async () => {
  const { pemBody, privateKey } = makeKeyPair();
  const seen = [];
  const expiresAt = Math.floor(Date.now() / 1000) + 3600;
  const token = makeJwt(expiresAt);
  const mock = await startMockFr(async (req, res) => {
    if (req.method === 'GET' && req.url.startsWith('/webroot/decision/login')) {
      res.writeHead(200, { 'Content-Type': 'text/html;charset=UTF-8' });
      res.end(`<!DOCTYPE html><html><body>${embedSystemJson({ encryptionType: 0, transmissionEncryption: 2, encryptionKey: pemBody })}</body></html>`);
      return;
    }
    if (req.method === 'POST' && req.url === '/webroot/decision/login') {
      const body = JSON.parse(await readBody(req));
      seen.push({ path: req.url, headers: req.headers, body });
      const plain = decryptSections(body.password, privateKey);
      if (body.encrypted === true && plain === 'test-password') {
        res.writeHead(200, { 'Content-Type': 'application/json;charset=UTF-8' });
        res.end(JSON.stringify({ data: { username: 'admin', validity: -1, accessToken: token } }));
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json;charset=UTF-8' });
        res.end(JSON.stringify({ errorCode: '21300007', errorMsg: 'User not exist, or wrong password!' }));
      }
      return;
    }
    res.writeHead(404);
    res.end('no');
  });
  try {
    const auth = await loginFrPreview({ baseUrl: mock.base, username: 'admin', password: 'test-password' });
    assert.equal(auth.ok, true);
    assert.equal(auth.token, token);
    assert.equal(auth.mode, 'login');
    assert.ok(auth.expiresAt >= expiresAt * 1000 - 1000);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].headers.transencryptlevel, '1');
    assert.equal(seen[0].headers['x-requested-with'], 'XMLHttpRequest');
    assert.equal(seen[0].body.encrypted, true);
    assert.equal(seen[0].body.validity, -1);

    // 口令不对 → 错误码映射
    const bad = await loginFrPreview({ baseUrl: mock.base, username: 'admin', password: 'wrong-password' });
    assert.equal(bad.ok, false);
    assert.equal(bad.reason, 'wrong-password');
    assert.equal(bad.errorCode, '21300007');
  } finally {
    await mock.close();
  }
});

test('loginFrPreview：平台未初始化时先 POST /login/admin 建号再登录；autoInit=false 则不动平台', async () => {
  const { pemBody } = makeKeyPair();
  const calls = [];
  const token = makeJwt(Math.floor(Date.now() / 1000) + 600);
  const mock = await startMockFr(async (req, res) => {
    if (req.method === 'GET' && req.url === '/webroot/decision/login') {
      res.writeHead(302, { Location: '/webroot/decision/login/initialization' });
      res.end('');
      return;
    }
    if (req.method === 'GET' && req.url === '/webroot/decision/login/initialization') {
      res.writeHead(200, { 'Content-Type': 'text/html;charset=UTF-8' });
      res.end(`<!DOCTYPE html><html><body>${embedSystemJson({ encryptionType: 0, encryptionKey: pemBody })}</body></html>`);
      return;
    }
    if (req.method === 'POST' && req.url === '/webroot/decision/login/admin') {
      const body = JSON.parse(await readBody(req));
      calls.push({ path: req.url, username: body.username, hasCipher: typeof body.password === 'string' && body.password.length > 0 });
      res.writeHead(200, { 'Content-Type': 'application/json;charset=UTF-8' });
      res.end(JSON.stringify({ data: 'success' }));
      return;
    }
    if (req.method === 'POST' && req.url === '/webroot/decision/login') {
      calls.push({ path: req.url });
      res.writeHead(200, { 'Content-Type': 'application/json;charset=UTF-8' });
      res.end(JSON.stringify({ data: { username: 'admin', accessToken: token } }));
      return;
    }
    res.writeHead(404);
    res.end('no');
  });
  try {
    const auth = await loginFrPreview({ baseUrl: mock.base, username: 'admin', password: 'test-password' });
    assert.equal(auth.ok, true);
    assert.equal(auth.mode, 'initialization');
    assert.equal(auth.token, token);
    assert.deepEqual(calls.map((c) => c.path), ['/webroot/decision/login/admin', '/webroot/decision/login']);
    assert.equal(calls[0].username, 'admin');

    calls.length = 0;
    const skipped = await loginFrPreview({ baseUrl: mock.base, username: 'admin', password: 'test-password', autoInit: false });
    assert.equal(skipped.ok, false);
    assert.equal(skipped.reason, 'platform-not-initialized');
    assert.equal(calls.length, 0);
  } finally {
    await mock.close();
  }
});

test('loginFrPreview：拒绝非回环目标（不向远端 FR 发口令），未就绪实例返回可读原因', async () => {
  for (const baseUrl of ['http://localhost:8080', 'http://doris.example.internal:39030', 'https://127.0.0.1:8080']) {
    const r = await loginFrPreview({ baseUrl, username: 'admin', password: 'x' });
    assert.equal(r.ok, false, baseUrl);
    assert.equal(r.reason, 'non-local-target');
  }
  // 端口没人监听 → login-page-unreachable（不是抛错）
  const r = await loginFrPreview({ baseUrl: 'http://127.0.0.1:9', username: 'admin', password: 'x', timeoutMs: 1200 });
  assert.equal(r.ok, false);
  assert.ok(['login-page-unreachable', 'login-page-unrecognized'].includes(r.reason));
});

// ---------------------------------------------------------------------------
// 5. attachPreviewImpersonation
// ---------------------------------------------------------------------------

test('attachPreviewImpersonation：成功时写入口页并包装 URL；关闭时退回匿名直连', async () => {
  const { pemBody } = makeKeyPair();
  const token = makeJwt(Math.floor(Date.now() / 1000) + 3600);
  const mock = await startMockFr(async (req, res) => {
    if (req.method === 'GET' && req.url.startsWith('/webroot/decision/login')) {
      res.writeHead(200, { 'Content-Type': 'text/html;charset=UTF-8' });
      res.end(`<!DOCTYPE html><html><body>${embedSystemJson({ encryption: 0, encryptionKey: pemBody })}</body></html>`);
      return;
    }
    if (req.method === 'POST' && req.url === '/webroot/decision/login') {
      res.writeHead(200, { 'Content-Type': 'application/json;charset=UTF-8' });
      res.end(JSON.stringify({ data: { username: 'admin', accessToken: token } }));
      return;
    }
    res.writeHead(404);
    res.end('no');
  });
  const dir = tmpDir('fr-attach-');
  const paths = { authEntryFile: path.join(dir, '_cpt_mcp_fr_auth.html') };
  try {
    const result = await attachPreviewImpersonation(paths, { port: mock.port, viewlet: 'a.cpt' });
    assert.equal(result.impersonation.status, 'ok');
    assert.equal(result.impersonation.username, 'admin');
    assert.match(result.urls.viewUrl, /_cpt_mcp_fr_auth\.html\?next=/);
    assert.match(decodeURIComponent(result.urls.viewUrl), /127\.0\.0\.1:\d+\/webroot\/decision\/view\/report/);
    assert.match(result.urls.writeUrl, /op%3Dwrite/);
    assert.equal(result.urls.directViewUrl.includes('_cpt_mcp_fr_auth'), false);
    assert.ok(fs.existsSync(paths.authEntryFile));

    // 显式关闭 → 不登录、不写入口页
    fs.rmSync(paths.authEntryFile, { force: true });
    const off = await attachPreviewImpersonation(paths, { port: mock.port, viewlet: 'a.cpt', enabled: false });
    assert.equal(off.impersonation.status, 'disabled');
    assert.equal(off.impersonation.enabled, false);
    assert.equal(off.urls.viewUrl, `http://127.0.0.1:${mock.port}/webroot/decision/view/report?viewlet=a.cpt`);
    assert.equal(fs.existsSync(paths.authEntryFile), false);
  } finally {
    await mock.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('attachPreviewImpersonation：登录失败时退回匿名直连 URL 并给出原因（不抛错）', async () => {
  const { pemBody } = makeKeyPair();
  const mock = await startMockFr(async (req, res) => {
    if (req.method === 'GET' && req.url.startsWith('/webroot/decision/login')) {
      res.writeHead(200, { 'Content-Type': 'text/html;charset=UTF-8' });
      res.end(`<!DOCTYPE html><html><body>${embedSystemJson({ encryption: 0, encryptionKey: pemBody })}</body></html>`);
      return;
    }
    if (req.method === 'POST' && req.url === '/webroot/decision/login') {
      res.writeHead(200, { 'Content-Type': 'application/json;charset=UTF-8' });
      res.end(JSON.stringify({ errorCode: '21300007', errorMsg: 'User not exist, or wrong password!' }));
      return;
    }
    res.writeHead(404);
    res.end('no');
  });
  const dir = tmpDir('fr-attach-fail-');
  const paths = { authEntryFile: path.join(dir, '_cpt_mcp_fr_auth.html') };
  try {
    const result = await attachPreviewImpersonation(paths, { port: mock.port, viewlet: 'a.cpt' });
    assert.equal(result.impersonation.status, 'failed');
    assert.equal(result.impersonation.reason, 'wrong-password');
    assert.equal(result.urls.viewUrl, `http://127.0.0.1:${mock.port}/webroot/decision/view/report?viewlet=a.cpt`);
    assert.equal(fs.existsSync(paths.authEntryFile), false);
  } finally {
    await mock.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

