// Run with `pnpm test:electron-sandbox`; Linux requires a display server.
// Uses isolated profiles and local fixtures; never signs in or contacts production.
const { app, BrowserWindow, session } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createServer } = require('node:http');
const { pathToFileURL } = require('node:url');

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'liner-security-'));
app.setPath('userData', profile);
// Avoid registering the test runner as the user's liner:// handler.
app.setAsDefaultProtocolClient = () => false;
const failures = [];
const preloads = [];
const check = async (name, fn) => {
  try { await fn(); console.log(`PASS: ${name}`); }
  catch (err) { failures.push(name); console.error(`FAIL: ${name}: ${err.message}`); }
};
const loaded = (win) => new Promise((resolve, reject) => {
  win.webContents.once('did-finish-load', resolve);
  win.webContents.once('did-fail-load', (_event, code, message) => reject(new Error(`${code}: ${message}`)));
});
app.on('browser-window-created', (_event, win) => {
  win.webContents.on('preload-error', (_event, _file, err) => preloads.push(err.message));
});

const wav = Buffer.alloc(44 + 4000);
wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28);
wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
wav.write('data', 36); wav.writeUInt32LE(4000, 40);
let frameProbePreflightRequests = 0;
let frameProbePosts = 0;
let hostileFrameRequests = 0;
let hostileObjectRequests = 0;

const pageServer = createServer((req, res) => {
  if (req.url === '/hostile-frame') hostileFrameRequests += 1;
  if (req.url === '/hostile-object') hostileObjectRequests += 1;
  res.setHeader('Content-Type', 'text/html');
  res.end('<!doctype html><html><body><main id="fixture">isolated renderer fixture</main></body></html>');
});
const apiServer = createServer((req, res) => {
  if (req.url === '/blocked') { res.end('must not be readable'); return; }
  // Deliberately omit CORS headers; the isolated test session must add only its scoped policy.
  if (req.url === '/frame-post' && req.method === 'OPTIONS') frameProbePreflightRequests += 1;
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  if (req.url === '/frame-post' && req.method === 'POST') { frameProbePosts += 1; res.end('{"ok":true}'); return; }
  if (req.url === '/audio') {
    res.setHeader('Content-Type', 'audio/wav');
    res.setHeader('Accept-Ranges', 'bytes');
    if (req.headers.range) res.writeHead(206, { 'Content-Range': `bytes 0-${wav.length - 1}/${wav.length}` });
    res.end(wav);
  } else if (req.url === '/audio-cache') {
    res.setHeader('Content-Type', 'audio/wav'); res.end(wav);
  } else if (req.url === '/image') {
    res.setHeader('Content-Type', 'image/svg+xml');
    res.end('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><rect width="1" height="1" fill="red"/></svg>');
  } else if (req.url === '/allowed') {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('X-Request-Id', 'fixture-request-id');
    res.end(JSON.stringify({ method: req.method, signature: req.headers['x-liner-signature'], requestId: req.headers['x-request-id'] }));
  } else {
    res.setHeader('Content-Type', 'text/plain'); res.end('fixture');
  }
});

async function rendererProbe(apiBase, signature) {
  const result = {};
  const response = await fetch(`${apiBase}/allowed`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json', 'x-liner-signature': signature,
      'x-liner-timestamp': '1', 'x-liner-nonce': 'fixture', 'x-request-id': 'fixture-request-id',
      'x-client-version': 'fixture', 'x-platform': 'fixture', 'x-user-id': 'fixture-user',
      'x-user-name': 'fixture-user', 'x-session-id': 'fixture-session',
    },
    body: '{}',
  });
  result.allowed = await response.json();
  result.exposedRequestId = response.headers.get('x-request-id');
  const audio = await fetch(`${apiBase}/audio`, { headers: { Range: 'bytes=0-' } });
  result.audioStatus = audio.status;
  result.contentRange = audio.headers.get('content-range');
  const context = new AudioContext();
  const decoded = await context.decodeAudioData(await audio.arrayBuffer());
  result.duration = decoded.duration;
  await context.close();
  const audioCache = await caches.open('liner-native-smoke');
  const cacheResponse = await fetch(`${apiBase}/audio-cache`);
  await audioCache.put(`${apiBase}/audio-cache`, cacheResponse.clone());
  result.cachedAudioBytes = (await (await audioCache.match(`${apiBase}/audio-cache`)).arrayBuffer()).byteLength;
  await caches.delete('liner-native-smoke');
  const image = new Image(); image.crossOrigin = 'anonymous'; image.src = `${apiBase}/image`;
  await image.decode();
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
  const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0);
  result.pixel = Array.from(ctx.getImageData(0, 0, 1, 1).data);
  const glCanvas = document.createElement('canvas');
  const gl = glCanvas.getContext('webgl');
  if (gl) {
    const texture = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
    result.webglError = gl.getError();
    gl.deleteTexture(texture); gl.getExtension('WEBGL_lose_context')?.loseContext();
  } else result.webglError = -1;
  return result;
}

async function main() {
  await app.whenReady();
  await Promise.all([
    new Promise(resolve => pageServer.listen(0, '127.0.0.1', resolve)),
    new Promise(resolve => apiServer.listen(0, '127.0.0.1', resolve)),
  ]);
  const pageBase = `http://127.0.0.1:${pageServer.address().port}`;
  const apiBase = `http://127.0.0.1:${apiServer.address().port}`;
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    const url = new URL(details.url);
    callback({ cancel: ['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol) && !['127.0.0.1', 'localhost'].includes(url.hostname) });
  });

  const mainCreated = new Promise(resolve => app.once('browser-window-created', (_event, win) => resolve(win)));
  const mainModule = await import(pathToFileURL(path.resolve(process.cwd(), 'dist-electron/main.js')).href);
  const win = await mainCreated;
  if (win.webContents.isLoading()) await loaded(win);
  await check('packaged main renderer has sandbox and web security enabled', () => {
    const prefs = win.webContents.getLastWebPreferences();
    assert.equal(prefs.sandbox, true); assert.equal(prefs.webSecurity, true);
    assert.equal(prefs.contextIsolation, true); assert.equal(prefs.nodeIntegration, false);
    assert.equal(new URL(win.webContents.getURL()).protocol, 'file:');
  });
  await check('actual main renderer blocks a remote child frame before it reaches the fixture server', async () => {
    const policy = await win.webContents.executeJavaScript(
      'document.querySelector("meta[http-equiv=\\"Content-Security-Policy\\"]")?.content',
    );
    assert.equal(policy, "frame-src 'none'; object-src 'none'");
    await win.webContents.executeJavaScript(`new Promise(resolve => {
      const frame = document.createElement('iframe');
      frame.src = ${JSON.stringify(`${pageBase}/hostile-frame`)};
      document.body.appendChild(frame);
      setTimeout(resolve, 500);
    })`);
    assert.equal(hostileFrameRequests, 0);
    await win.webContents.executeJavaScript(`new Promise(resolve => {
      const object = document.createElement('object');
      object.data = ${JSON.stringify(`${pageBase}/hostile-object`)};
      object.type = 'text/html';
      document.body.appendChild(object);
      setTimeout(resolve, 500);
    })`);
    assert.equal(hostileObjectRequests, 0);
  });
  await check('hostile top-frame navigation is blocked in the actual main window', async () => {
    const before = win.webContents.getURL();
    await win.webContents.executeJavaScript(`window.location.href = ${JSON.stringify(`${pageBase}/hostile`)}`);
    await new Promise(resolve => setTimeout(resolve, 250));
    const after = win.webContents.getURL();
    assert.equal(new URL(after).protocol, 'file:');
    assert.equal(new URL(after).pathname, new URL(before).pathname);
  });
  await check('main renderer cannot invoke overlay-only privileged IPC', async () => {
    const result = await win.webContents.executeJavaScript(
      'window.linerElectron.getOverlayInitialState().then(() => "allowed", () => "rejected")',
    );
    assert.equal(result, 'rejected');
  });
  await check('native auth bridge round-trips only synthetic tokens through protected storage', async () => {
    const synthetic = {
      accessToken: 'synthetic-native-access-fixture',
      refreshToken: 'synthetic-native-refresh-fixture',
      accessTokenExpiresAt: '2030-01-01T00:00:00.000Z',
      user: { id: 'synthetic-native-user', email: 'fixture@example.test' },
    };
    const saved = await win.webContents.executeJavaScript(
      `window.linerElectron.saveAuthSession(${JSON.stringify(synthetic)})`,
    );
    const recordPath = path.join(profile, 'auth-session.bin');
    if (!saved) {
      assert.ok(process.platform === 'linux', 'safeStorage unavailable on this non-Linux platform');
      assert.equal(fs.existsSync(recordPath), false);
      return;
    }
    const bytes = fs.readFileSync(recordPath);
    assert.equal(bytes.includes(Buffer.from(synthetic.accessToken)), false);
    assert.equal(bytes.includes(Buffer.from(synthetic.refreshToken)), false);
    const loadedSession = await win.webContents.executeJavaScript('window.linerElectron.loadAuthSession()');
    assert.deepEqual(loadedSession, synthetic);
    assert.equal(await win.webContents.executeJavaScript('window.linerElectron.clearAuthSession()'), true);
    assert.equal(fs.existsSync(recordPath), false);
  });
  const outsider = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.resolve(process.cwd(), 'dist-electron/preload.cjs'),
      sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true,
    },
  });
  await outsider.loadURL(pageBase);
  await check('untrusted top-level webContents cannot invoke privileged IPC', async () => {
    const result = await outsider.webContents.executeJavaScript(
      'window.linerElectron.getAppVersion().then(() => "allowed", () => "rejected")',
    );
    assert.equal(result, 'rejected');
  });

  const overlayCreated = new Promise(resolve => app.once('browser-window-created', (_event, overlay) => resolve(overlay)));
  await win.webContents.executeJavaScript('window.linerElectron.toggleOverlay()');
  const overlay = await overlayCreated;
  if (overlay.webContents.isLoading()) await loaded(overlay);
  await check('overlay renderer has sandbox, web security, preload and overlay-only IPC', async () => {
    const prefs = overlay.webContents.getLastWebPreferences();
    assert.equal(prefs.sandbox, true); assert.equal(prefs.webSecurity, true);
    const result = await overlay.webContents.executeJavaScript(`(async () => {
      const bridge = typeof window.linerElectron;
      let allowed = false, mainOnlyRejected = false;
      try { allowed = (await window.linerElectron.getOverlayInitialState()) !== undefined; } catch {}
      try { await window.linerElectron.getAppVersion(); } catch { mainOnlyRejected = true; }
      return { bridge, require: typeof require, process: typeof process, allowed, mainOnlyRejected };
    })()`);
    assert.equal(result.bridge, 'object'); assert.equal(result.require, 'undefined'); assert.equal(result.process, 'undefined');
    assert.equal(result.allowed, true); assert.equal(result.mainOnlyRejected, true);
  });

  const signature = await win.webContents.executeJavaScript(
    `window.linerElectron.signRequest({ method: 'POST', path: '/allowed', body: '{}' }).then(x => x.signature)`,
  );
  const fixturePagePath = path.join(profile, 'renderer-fixture.html');
  fs.writeFileSync(fixturePagePath, '<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="frame-src \'none\'"></head><body><main id="fixture">isolated file-origin fixture</main></body></html>');
  const fixtureSession = session.fromPartition(`liner-security-fixture-${Date.now()}`);
  const fixtureWin = new BrowserWindow({
    show: false,
    webPreferences: { session: fixtureSession, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true },
  });
  const { RendererSecurity } = mainModule;
  const fixtureSecurity = new RendererSecurity({
    builtInIndexPath: fixturePagePath,
    windows: { main: () => fixtureWin.webContents, overlay: () => null },
    corsHosts: { exact: ['127.0.0.1'] },
    allowLoopbackHttpFixtures: true,
  });
  fixtureSecurity.installNavigationGuards(fixtureWin.webContents, () => {});
  fixtureSecurity.installCrossOriginCompatibility(fixtureSession);
  await fixtureWin.loadFile(fixturePagePath);
  const fixtureResult = await fixtureWin.webContents.executeJavaScript(
    `(${rendererProbe.toString()})(${JSON.stringify(apiBase)}, ${JSON.stringify(signature)})`,
  );
  await check('isolated native loopback fixture: signed POST/preflight, range audio, exposed headers, image and WebGL', () => {
    assert.equal(fixtureResult.allowed.method, 'POST'); assert.ok(fixtureResult.allowed.signature);
    assert.equal(fixtureResult.allowed.requestId, 'fixture-request-id');
    assert.equal(fixtureResult.exposedRequestId, 'fixture-request-id');
    assert.equal(fixtureResult.audioStatus, 206); assert.equal(fixtureResult.duration, 0.25);
    assert.equal(fixtureResult.cachedAudioBytes, 4044);
    assert.match(fixtureResult.contentRange, /^bytes 0-/);
    assert.deepEqual(fixtureResult.pixel, [255, 0, 0, 255]); assert.equal(fixtureResult.webglError, 0);
  });
  await check('unlisted host and child-frame CORS are denied in a real Electron renderer', async () => {
    const result = await fixtureWin.webContents.executeJavaScript(`(async () => {
      let unlistedHostRejected = false;
      try { await fetch(${JSON.stringify(apiBase.replace('127.0.0.1', 'localhost'))}/allowed); }
      catch { unlistedHostRejected = true; }
      const childFrameResult = await new Promise(resolve => {
        const frame = document.createElement('iframe');
        frame.sandbox = 'allow-scripts';
        frame.srcdoc = '<script>fetch(${JSON.stringify(`${apiBase}/frame-post`)}, { method: "POST", headers: { "content-type": "application/json", "x-liner-signature": "fixture" }, body: "{}" }).then(() => parent.postMessage("frame-allowed", "*"), () => parent.postMessage("frame-blocked", "*"))<\\/script>';
        const listener = event => {
          if (event.data === 'frame-allowed' || event.data === 'frame-blocked') {
            window.removeEventListener('message', listener); resolve(event.data);
          }
        };
        window.addEventListener('message', listener);
        document.body.appendChild(frame);
        setTimeout(() => { window.removeEventListener('message', listener); resolve('frame-blocked'); }, 400);
      });
      return { unlistedHostRejected, childFrameResult };
    })()`);
    assert.deepEqual(result, { unlistedHostRejected: true, childFrameResult: 'frame-blocked' });
    assert.equal(frameProbePreflightRequests, 1);
    assert.equal(frameProbePosts, 0);
  });
  await check('no preload failures', () => assert.deepEqual(preloads, []));
}

const timeout = setTimeout(() => { console.error('FAIL: Electron smoke test timed out'); app.exit(1); }, 45000);
main().catch(err => { failures.push('runner'); console.error(err); }).finally(async () => {
  clearTimeout(timeout);
  for (const win of BrowserWindow.getAllWindows()) win.destroy();
  for (const server of [pageServer, apiServer]) {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
  app.exit(failures.length ? 1 : 0);
});
process.on('exit', () => {
  try { fs.rmSync(profile, { recursive: true, force: true }); }
  catch { /* Chromium may retain a temporary profile lock until process exit. */ }
});
