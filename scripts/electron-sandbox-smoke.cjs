// Run with `pnpm test:electron-sandbox`; Linux requires a display server.
// Uses an isolated profile and local fixtures; never signs in or contacts production.
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

// A short PCM WAV tests the media fetch/decode path without playing audible audio.
const wav = Buffer.alloc(44 + 4000);
wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28);
wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
wav.write('data', 36); wav.writeUInt32LE(4000, 40);
const server = createServer((req, res) => {
  if (req.url === '/blocked') { res.end('must not be readable'); return; }
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  if (req.url === '/audio') {
    res.setHeader('Content-Type', 'audio/wav');
    res.setHeader('Accept-Ranges', 'bytes');
    if (req.headers.range) {
      res.writeHead(206, { 'Content-Range': `bytes 0-${wav.length - 1}/${wav.length}` });
    }
    res.end(wav);
  } else if (req.url === '/image') {
    res.setHeader('Content-Type', 'image/svg+xml');
    res.end('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><rect width="1" height="1" fill="red"/></svg>');
  } else if (req.url === '/allowed') {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ method: req.method, signature: req.headers['x-liner-signature'] }));
  } else {
    res.setHeader('Content-Type', 'text/html');
    res.end('<html><body>development origin fixture</body></html>');
  }
});

async function rendererProbe(base) {
  const result = {
    require: typeof require, process: typeof process,
    bridge: typeof window.linerElectron,
    platform: window.linerElectron.platform,
    isHyprland: typeof window.linerElectron.isHyprland,
    version: await window.linerElectron.getAppVersion(),
  };
  const signed = await window.linerElectron.signRequest({ method: 'POST', path: '/allowed', body: '{}' });
  const response = await fetch(`${base}/allowed`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-liner-signature': signed.signature }, body: '{}',
  });
  result.allowed = await response.json();
  const audio = await fetch(`${base}/audio`, { headers: { Range: 'bytes=0-' } });
  result.audioStatus = audio.status;
  const context = new AudioContext();
  const decoded = await context.decodeAudioData(await audio.arrayBuffer());
  result.duration = decoded.duration;
  await context.close();
  const image = new Image(); image.crossOrigin = 'anonymous'; image.src = `${base}/image`;
  await image.decode();
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
  const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0);
  result.pixel = Array.from(ctx.getImageData(0, 0, 1, 1).data);
  return result;
}

async function main() {
  await app.whenReady();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    const url = new URL(details.url);
    callback({ cancel: ['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol) && !['127.0.0.1', 'localhost'].includes(url.hostname) });
  });
  const mainCreated = new Promise(resolve => app.once('browser-window-created', (_event, win) => resolve(win)));
  await import(pathToFileURL(path.resolve(process.cwd(), 'dist-electron/main.js')).href);
  const win = await mainCreated;
  if (win.webContents.isLoading()) await loaded(win);
  await check('main renderer isolation', () => {
    const prefs = win.webContents.getLastWebPreferences();
    assert.equal(prefs.sandbox, true);
    assert.equal(prefs.contextIsolation, true); assert.equal(prefs.nodeIntegration, false);
  });
  const probe = async (label) => {
    const result = await win.webContents.executeJavaScript(`(${rendererProbe.toString()})(${JSON.stringify(base)})`);
    await check(`${label}: preload IPC, signed CORS POST, audio and canvas work`, () => {
      assert.equal(result.require, 'undefined'); assert.equal(result.process, 'undefined');
      assert.equal(result.bridge, 'object'); assert.equal(result.platform, process.platform);
      assert.equal(result.isHyprland, 'boolean'); assert.equal(typeof result.version, 'string');
      assert.equal(result.allowed.method, 'POST'); assert.ok(result.allowed.signature);
      assert.equal(result.audioStatus, 206); assert.equal(result.duration, 0.25);
      assert.deepEqual(result.pixel, [255, 0, 0, 255]);
    });
  };
  await probe('packaged file origin');
  const overlayCreated = new Promise(resolve => app.once('browser-window-created', (_event, overlay) => resolve(overlay)));
  await win.webContents.executeJavaScript('window.linerElectron.toggleOverlay()');
  const overlay = await overlayCreated;
  if (overlay.webContents.isLoading()) await loaded(overlay);
  await check('overlay renderer isolation and preload', async () => {
    const prefs = overlay.webContents.getLastWebPreferences();
    assert.equal(prefs.sandbox, true);
    const result = await overlay.webContents.executeJavaScript('({ bridge: typeof window.linerElectron, require: typeof require, process: typeof process })');
    assert.deepEqual(result, { bridge: 'object', require: 'undefined', process: 'undefined' });
  });
  // A different hostname makes the fixture cross-origin from the dev page too.
  await win.loadURL(base);
  const devResult = await win.webContents.executeJavaScript(`(${rendererProbe.toString()})(${JSON.stringify(base.replace('127.0.0.1', 'localhost'))})`);
  await check('development origin: CORS media and IPC remain available', () => {
    assert.equal(devResult.allowed.method, 'POST'); assert.ok(devResult.allowed.signature);
    assert.equal(devResult.audioStatus, 206); assert.equal(devResult.duration, 0.25);
    assert.deepEqual(devResult.pixel, [255, 0, 0, 255]);
  });
  await check('no preload failures', () => assert.deepEqual(preloads, []));
}

const timeout = setTimeout(() => { console.error('FAIL: Electron smoke test timed out'); app.exit(1); }, 30000);
main().catch(err => { failures.push('runner'); console.error(err); }).finally(async () => {
  clearTimeout(timeout);
  for (const win of BrowserWindow.getAllWindows()) win.destroy();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  app.exit(failures.length ? 1 : 0);
});
process.on('exit', () => {
  try { fs.rmSync(profile, { recursive: true, force: true }); }
  catch { /* Chromium may retain a temporary profile lock until process exit. */ }
});
