const { app, BrowserWindow, ipcMain, globalShortcut, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const fs   = require('fs');
const os   = require('os');
const { pathToFileURL } = require('url');
const { execFile, exec, spawn } = require('child_process');

try { require('dotenv').config({ path: path.join(__dirname, '.env') }); } catch (_) {}

const PLAYER_WIDTH  = 560;
const PLAYER_HEIGHT = 980;
const MINI_WIDTH    = 560;
const MINI_HEIGHT   = 520;

let mainWindow;
let videoWindow;
let tray = null;
let nowPlayingInfo = { title: 'Nothing playing', isPlaying: false };
let windowDragState = null;

app.isQuitting = false;

// ── Whisper persistent server state ──────────────────────────────────────────
let whisperProc  = null;
let whisperReady = false;
let whisperQueue = [];
let whisperBuf   = '';

const isWin = process.platform === 'win32';
const isMas = process.mas === true;
const pythonCandidates = isWin
  ? ['python', 'python3', 'py']   // Windows: rely on PATH / py launcher
  : [
      '/usr/bin/python3',          // macOS system Python — most likely to have user-installed packages
      'python3',                   // PATH lookup (picks up pyenv, conda, venv)
      '/opt/homebrew/bin/python3',
      '/opt/homebrew/bin/python3.12',
      '/opt/homebrew/bin/python3.11',
      '/opt/homebrew/bin/python3.10',
      '/usr/local/bin/python3',
      '/usr/local/bin/python3.12',
      '/usr/local/bin/python3.11',
    ];

function getHelperScript() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'app.asar.unpacked', 'assets', 'speech_helper.py')
    : path.join(__dirname, 'assets', 'speech_helper.py');
}

function startWhisperServer(candidates, onReady) {
  if (!candidates.length) { console.error('[voice] python3 not found'); onReady(false); return; }
  const python = candidates[0];
  const rest   = candidates.slice(1);
  let   becameReady = false; // tracks whether this instance ever signalled READY
  const proc   = spawn(python, [getHelperScript(), '--server'], {
    env: { ...process.env, PYTHONUNBUFFERED: '1' },
    stdio: ['pipe', 'pipe', 'pipe']
  });
  proc.on('error', (e) => {
    if (e.code === 'ENOENT') { startWhisperServer(rest, onReady); return; }
    console.error('[voice] server error:', e.message);
    if (!becameReady) startWhisperServer(rest, onReady);
  });
  proc.stderr.on('data', (d) => { const m=d.toString().trim(); if(m) console.log('[voice] py:', m); });
  proc.stdout.on('data', (data) => {
    whisperBuf += data.toString();
    const lines = whisperBuf.split('\n');
    whisperBuf  = lines.pop();
    for (const line of lines) {
      const t = line.trim();
      if (t === 'READY') {
        becameReady  = true;
        whisperReady = true;
        console.log('[voice] Whisper server ready —', python);
        onReady(true);
        if (whisperQueue.length) proc.stdin.write(whisperQueue[0].tmpFile + '\n');
      } else {
        const item = whisperQueue.shift();
        if (item) {
          console.log('[voice] transcript:', JSON.stringify(t));
          try { fs.unlinkSync(item.tmpFile); } catch(_) {}
          item.resolve(t);
        }
        if (whisperQueue.length && whisperProc) whisperProc.stdin.write(whisperQueue[0].tmpFile + '\n');
      }
    }
  });
  proc.on('exit', (code) => {
    console.log('[voice] server exited, code:', code);
    whisperProc = null; whisperReady = false;
    if (!becameReady) {
      // This python had missing deps — try the next candidate
      console.log('[voice] retrying with next python candidate…');
      startWhisperServer(rest, onReady);
      return;
    }
    while (whisperQueue.length) { const i=whisperQueue.shift(); try{fs.unlinkSync(i.tmpFile);}catch(_){} i.resolve(''); }
  });
  whisperProc = proc;
}
// ─────────────────────────────────────────────────────────────────────────────

// ── System Tray ───────────────────────────────────────────────────────────────

function sendTrayCmd(cmd) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('tray-command', cmd);
}

function buildTrayMenu() {
  const { title, isPlaying } = nowPlayingInfo;
  return Menu.buildFromTemplate([
    { label: title || 'Nothing playing', enabled: false },
    { type: 'separator' },
    { label: isPlaying ? 'Pause' : 'Play',  click: () => sendTrayCmd('toggle-play') },
    { label: 'Previous',                     click: () => sendTrayCmd('prev') },
    { label: 'Next',                         click: () => sendTrayCmd('next') },
    { type: 'separator' },
    { label: 'Show SOHMNAMP', click: () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } } },
    { label: 'Quit',          click: () => { app.isQuitting = true; app.quit(); } },
  ]);
}

function setupTray() {
  const iconPath = path.join(__dirname, 'assets', 'icon.png');
  let img = fs.existsSync(iconPath)
    ? nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 })
    : nativeImage.createEmpty();
  tray = new Tray(img);
  tray.setToolTip('SOHMNAMP');
  tray.setContextMenu(buildTrayMenu());
  // On Windows/Linux a single click should show the window; macOS uses the context menu pop-up
  if (process.platform !== 'darwin') {
    tray.on('click', () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } });
  }
}
// ─────────────────────────────────────────────────────────────────────────────

function createWindow() {
  mainWindow = new BrowserWindow({
    width: PLAYER_WIDTH, height: PLAYER_HEIGHT,
    minWidth: 300, minHeight: 200, maxWidth: PLAYER_WIDTH,
    backgroundColor: '#00000000', transparent: true, titleBarStyle: 'default', resizable: true, movable: true,
    webPreferences: { nodeIntegration: false, contextIsolation: true, preload: path.join(__dirname, 'preload.js') },
    icon: path.join(__dirname, 'assets', 'icon.png'), show: false,
  });
  mainWindow.loadFile('index.html');
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    const hs = getHelperScript();
    if (!isMas && fs.existsSync(hs) && !whisperProc) startWhisperServer([...pythonCandidates], (ok) => { if(!ok) console.error('[voice] Whisper server failed'); });
  });
  const ses = mainWindow.webContents.session;
  const ALLOWED_PERMS = ['camera','microphone','media','media-stream','mediaKeySystem','audioCapture','videoCapture','notifications','speech','speechRecognition'];
  const isAllowedPermission = (perm) => {
    if (isMas && ['camera','microphone','media','media-stream','audioCapture','videoCapture'].includes(perm)) return false;
    return ALLOWED_PERMS.includes(perm);
  };
  ses.setPermissionRequestHandler((wc, perm, cb) => cb(isAllowedPermission(perm)));
  ses.setPermissionCheckHandler((wc, perm) => isAllowedPermission(perm));

  // Inject CORS headers so renderer fetch() can reach iTunes Search API and podcast RSS feeds
  ses.webRequest.onHeadersReceived({ urls: ['https://itunes.apple.com/*', 'http://*/*', 'https://*/*'] }, (details, cb) => {
    const headers = { ...details.responseHeaders };
    headers['Access-Control-Allow-Origin']  = ['*'];
    headers['Access-Control-Allow-Methods'] = ['GET'];
    headers['Access-Control-Allow-Headers'] = ['Content-Type', 'User-Agent'];
    cb({ responseHeaders: headers });
  });
  mainWindow.on('enter-full-screen', () => { mainWindow.setFullScreen(true); mainWindow.webContents.send('fullscreen-changed', true); });
  mainWindow.on('leave-full-screen', () => { mainWindow.setSize(PLAYER_WIDTH, PLAYER_HEIGHT); mainWindow.webContents.send('fullscreen-changed', false); });
  // Hide to tray on close instead of quitting (let tray Quit item do the real exit)
  mainWindow.on('close', (e) => {
    if (!app.isQuitting && tray) { e.preventDefault(); mainWindow.hide(); }
  });
  mainWindow.on('closed', () => { mainWindow = null; });
}

function resolveVideoSource(opts = {}) {
  if (opts.filePath && typeof opts.filePath === 'string') return pathToFileURL(opts.filePath).href;
  if (!opts.url || typeof opts.url !== 'string') return null;
  try {
    const parsed = new URL(opts.url);
    if (['http:', 'https:', 'file:', 'blob:'].includes(parsed.protocol)) return opts.url;
  } catch (_) {}
  return null;
}

function openFloatingVideoWindow(opts = {}) {
  const src = resolveVideoSource(opts);
  if (!src) return false;
  const name = opts.name || 'SOHMNAMP Video';
  if (videoWindow && !videoWindow.isDestroyed()) {
    videoWindow.close();
  }
  videoWindow = new BrowserWindow({
    width: 960, height: 574,
    minWidth: 320, minHeight: 220,
    backgroundColor: '#000000',
    title: name,
    resizable: true,
    maximizable: true,
    fullscreenable: true,
    alwaysOnTop: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    },
    icon: path.join(__dirname, 'assets', 'icon.png'),
    show: false,
  });
  videoWindow.loadFile(path.join(__dirname, 'video-player.html'), { query: { src, name } });
  videoWindow.once('ready-to-show', () => {
    videoWindow.show();
    videoWindow.focus();
  });
  videoWindow.on('closed', () => { videoWindow = null; });
  return true;
}

// ── All IPC handlers registered ONCE at module level ─────────────────────────

ipcMain.on('update-now-playing', (e, info) => {
  nowPlayingInfo = info;
  if (tray && !tray.isDestroyed()) {
    tray.setContextMenu(buildTrayMenu());
    tray.setToolTip(info.title ? 'SOHMNAMP — ' + info.title : 'SOHMNAMP');
  }
});

ipcMain.on('toggle-fullscreen',  () => { if(mainWindow) mainWindow.setFullScreen(!mainWindow.isFullScreen()); });
ipcMain.on('exit-fullscreen',    () => { if(mainWindow) mainWindow.setFullScreen(false); });
ipcMain.on('resize-window', (e, w, h) => {
  if (!mainWindow || mainWindow.isFullScreen()) return;
  const { screen } = require('electron');
  const bounds = screen.getDisplayMatching(mainWindow.getBounds()).workArea;
  const [curW] = mainWindow.getSize();
  const requestedW = Number.isFinite(Number(w)) ? Math.round(Number(w)) : curW;
  const requestedH = Number.isFinite(Number(h)) ? Math.round(Number(h)) : mainWindow.getSize()[1];
  const width = Math.max(300, Math.min(requestedW, bounds.width));
  const height = Math.max(420, Math.min(requestedH, bounds.height));
  const [curX, curY] = mainWindow.getPosition();
  const x = Math.min(Math.max(curX, bounds.x), bounds.x + bounds.width - width);
  const y = Math.min(Math.max(curY, bounds.y), bounds.y + bounds.height - height);
  mainWindow.setBounds({ x, y, width, height });
});
ipcMain.on('set-always-on-top', (e, val) => { if(mainWindow) mainWindow.setAlwaysOnTop(!!val, 'floating'); });
ipcMain.on('set-window-transparency', (e, val) => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const enabled = !!val;
  mainWindow.setBackgroundColor(enabled ? '#00000000' : '#06060c');
  if (process.platform === 'darwin' && typeof mainWindow.setVibrancy === 'function') {
    try { mainWindow.setVibrancy(null); } catch (_) {}
  }
});
ipcMain.on('begin-window-drag', (e, point) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (!win || win.isDestroyed() || win.isFullScreen()) return;
  const x = Number(point && point.x);
  const y = Number(point && point.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return;
  windowDragState = {
    win,
    startMouse: { x, y },
    startBounds: win.getBounds(),
  };
});
ipcMain.on('move-window-drag', (e, point) => {
  if (!windowDragState || windowDragState.win.isDestroyed()) return;
  if (BrowserWindow.fromWebContents(e.sender) !== windowDragState.win) return;
  const x = Number(point && point.x);
  const y = Number(point && point.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return;
  const dx = Math.round(x - windowDragState.startMouse.x);
  const dy = Math.round(y - windowDragState.startMouse.y);
  windowDragState.win.setPosition(
    windowDragState.startBounds.x + dx,
    windowDragState.startBounds.y + dy,
    false
  );
});
ipcMain.on('end-window-drag', (e) => {
  if (!windowDragState) return;
  if (BrowserWindow.fromWebContents(e.sender) === windowDragState.win) windowDragState = null;
});
ipcMain.on('resize-video-window', (e, w, h) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (win && win === videoWindow && !win.isDestroyed() && !win.isFullScreen()) {
    const { screen } = require('electron');
    const bounds = screen.getDisplayMatching(win.getBounds()).workArea;
    const width = Math.max(320, Math.min(Math.round(w), bounds.width));
    const height = Math.max(220, Math.min(Math.round(h), bounds.height));
    win.setContentSize(width, height);
  }
});
ipcMain.on('set-video-window-always-on-top', (e, val) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (win && win === videoWindow && !win.isDestroyed()) win.setAlwaysOnTop(!!val, 'floating');
});
ipcMain.on('mini-mode', (e, enabled) => {
  if (!mainWindow) return;
  if (enabled) {
    mainWindow.setMaximumSize(2000, 2000); mainWindow.setMinimumSize(MINI_WIDTH, MINI_HEIGHT);
    mainWindow.setSize(MINI_WIDTH, MINI_HEIGHT); mainWindow.setMaximumSize(MINI_WIDTH, 900);
  } else {
    const [x, y] = mainWindow.getPosition();
    const { width: sW, height: sH } = require('electron').screen.getPrimaryDisplay().workAreaSize;
    mainWindow.setMaximumSize(PLAYER_WIDTH, 2000); mainWindow.setMinimumSize(PLAYER_WIDTH, 400);
    mainWindow.setBounds({ x: Math.min(x, sW-PLAYER_WIDTH), y: Math.min(y, sH-PLAYER_HEIGHT), width: PLAYER_WIDTH, height: PLAYER_HEIGHT });
  }
});

ipcMain.handle('ask-media-access', async (e, mediaType) => {
  try {
    if (isMas && ['camera', 'microphone'].includes(mediaType)) return false;
    const { systemPreferences } = require('electron');
    if (typeof systemPreferences.askForMediaAccess === 'function') {
      const granted = await systemPreferences.askForMediaAccess(mediaType);
      console.log(`[media] askForMediaAccess('${mediaType}') →`, granted);
      return granted;
    }
    return true;
  } catch(err) { console.error('[media] error:', err.message); return false; }
});

ipcMain.handle('get-media-access-status', (e, mediaType) => {
  try {
    const { systemPreferences } = require('electron');
    return typeof systemPreferences.getMediaAccessStatus === 'function'
      ? systemPreferences.getMediaAccessStatus(mediaType) : 'granted';
  } catch(_) { return 'unknown'; }
});

ipcMain.handle('open-video-window', (e, opts) => openFloatingVideoWindow(opts));

ipcMain.handle('file-path-to-url', (e, filePath) => {
  if (!filePath || typeof filePath !== 'string') return '';
  try {
    if (!fs.existsSync(filePath)) return '';
    return pathToFileURL(filePath).href;
  } catch (_) {
    return '';
  }
});

ipcMain.handle('voice-transcribe', async (e, audioBytes) => {
  if (isMas) return '';
  return new Promise((resolve) => {
    try {
      const tmpFile = path.join(os.tmpdir(), `sohmnamp_voice_${Date.now()}.wav`);
      fs.writeFileSync(tmpFile, Buffer.from(audioBytes));
      console.log(`[voice] ${Buffer.from(audioBytes).length} bytes WAV → ${tmpFile}`);
      if (!fs.existsSync(getHelperScript())) { try{fs.unlinkSync(tmpFile);}catch(_){} resolve(''); return; }
      const send = () => {
        whisperQueue.push({ tmpFile, resolve });
        if (whisperQueue.length === 1 && whisperProc) whisperProc.stdin.write(tmpFile + '\n');
      };
      if (whisperReady && whisperProc) { send(); }
      else if (!whisperProc) { startWhisperServer([...pythonCandidates], (ok) => { ok ? send() : (()=>{ try{fs.unlinkSync(tmpFile);}catch(_){} resolve(''); })(); }); }
      else { whisperQueue.push({ tmpFile, resolve }); }
    } catch(err) { console.error('[voice] error:', err.message); resolve(''); }
  });
});

// MAS-safe: mute the app's own gain node via renderer message instead of osascript
ipcMain.handle('voice-system-mute',   async () => { if (mainWindow) mainWindow.webContents.send('app-audio-mute', true);  return true; });
ipcMain.handle('voice-system-unmute', async () => { if (mainWindow) mainWindow.webContents.send('app-audio-mute', false); return true; });

let ttsProc = null;
ipcMain.handle('voice-speak', async (e, text) => {
  if (!text) return;
  if (isMas) return false;
  if (ttsProc) { try{ttsProc.kill();}catch(_){} ttsProc = null; }
  return new Promise(res => {
    if (process.platform === 'win32') {
      // PowerShell built-in SAPI TTS — no extra install needed on Windows
      const escaped = text.replace(/'/g, "''");
      const ps = `Add-Type -AssemblyName System.Speech; $s=New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.Rate=2; $s.Speak('${escaped}')`;
      ttsProc = exec(`powershell -NoProfile -NonInteractive -Command "${ps}"`, err => { ttsProc=null; res(!err); });
    } else if (process.platform === 'darwin') {
      ttsProc = exec(`say -v Alex -r 200 "${text.replace(/"/g,'\\"')}"`, err => { ttsProc=null; res(!err); });
    } else {
      ttsProc = exec(`espeak "${text.replace(/"/g,'\\"')}" 2>/dev/null || true`, err => { ttsProc=null; res(!err); });
    }
  });
});
ipcMain.on('voice-speak-stop', () => { if(ttsProc){try{ttsProc.kill();}catch(_){} ttsProc=null;} });
ipcMain.handle('get-claude-key', () => isMas ? '' : (process.env.ANTHROPIC_API_KEY || ''));

// ── Podcast IPC — Electron net module (always available, no fetch needed) ─────
const { net } = require('electron');

function electronGet(urlStr, headers = {}) {
  return new Promise((resolve, reject) => {
    const request = net.request({ url: urlStr, redirect: 'follow' });
    Object.entries({ 'User-Agent': 'SOHMNAMP/4.0', ...headers }).forEach(([k, v]) => request.setHeader(k, v));
    const chunks = [];
    request.on('response', res => {
      res.on('data', d => chunks.push(d));
      res.on('end',  () => resolve(Buffer.concat(chunks).toString('utf8')));
      res.on('error', reject);
    });
    request.on('error', reject);
    request.end();
  });
}

ipcMain.handle('podcast-charts', async () => {
  try {
    const body = await electronGet('https://itunes.apple.com/us/rss/toppodcasts/limit=25/json');
    return JSON.parse(body);
  } catch (err) {
    console.error('[podcast-charts]', err.message);
    return null;
  }
});

ipcMain.handle('podcast-search', async (e, query) => {
  try {
    const body = await electronGet(`https://itunes.apple.com/search?media=podcast&entity=podcast&limit=40&term=${encodeURIComponent(query)}`);
    return JSON.parse(body);
  } catch (err) {
    console.error('[podcast-search]', err.message);
    return { resultCount: 0, results: [] };
  }
});

ipcMain.handle('icy-metadata', async (e, streamUrl) => {
  return new Promise((resolve) => {
    try {
      const request = net.request({ url: streamUrl });
      request.setHeader('Icy-MetaData', '1');
      request.setHeader('User-Agent', 'SOHMNAMP/4.0');
      let metaInt = 0, buf = Buffer.alloc(0), headersDone = false, resolved = false;
      const done = (result) => { if (!resolved) { resolved = true; try { request.abort(); } catch(_) {} resolve(result); } };
      setTimeout(() => done(null), 8000);
      request.on('response', res => {
        metaInt = parseInt(res.headers['icy-metaint'] || '0', 10);
        if (!metaInt) { done(null); return; }
        res.on('data', chunk => {
          buf = Buffer.concat([buf, chunk]);
          if (buf.length >= metaInt + 1) {
            const metaLen = buf[metaInt] * 16;
            if (buf.length >= metaInt + 1 + metaLen) {
              const metaStr = buf.slice(metaInt + 1, metaInt + 1 + metaLen).toString('utf8').replace(/\0/g,'');
              const m = metaStr.match(/StreamTitle='([^']*)'/);
              done(m ? m[1] : null);
            }
          }
        });
        res.on('error', () => done(null));
      });
      request.on('error', () => done(null));
      request.end();
    } catch(e) { resolve(null); }
  });
});

ipcMain.handle('lastfm-open-auth', async (e, url) => {
  const { shell } = require('electron');
  await shell.openExternal(url);
  return true;
});

ipcMain.handle('lastfm-post', async (e, urlStr, body) => {
  return new Promise((resolve, reject) => {
    const request = net.request({ method: 'POST', url: urlStr });
    request.setHeader('Content-Type', 'application/x-www-form-urlencoded');
    request.setHeader('User-Agent', 'SOHMNAMP/4.0');
    const chunks = [];
    request.on('response', res => {
      res.on('data', d => chunks.push(d));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      res.on('error', reject);
    });
    request.on('error', reject);
    request.write(body);
    request.end();
  });
});

ipcMain.handle('podcast-rss', async (e, feedUrl) => {
  try {
    return await electronGet(feedUrl, { 'Accept': 'application/rss+xml, application/xml, text/xml, */*' });
  } catch (err) {
    console.error('[podcast-rss]', err.message);
    return null;
  }
});
// ─────────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────

if (isMas) {
  app.commandLine.appendSwitch('js-flags', '--jitless');
} else {
  app.commandLine.appendSwitch('ignore-gpu-blocklist');
  app.commandLine.appendSwitch('enable-gpu-rasterization');
  app.commandLine.appendSwitch('enable-zero-copy');
  app.commandLine.appendSwitch('enable-features', 'WebRTC,MediaRecorder,GetDisplayMedia');
  app.commandLine.appendSwitch('disable-features', 'WebRtcHideLocalIpsWithMdns');
}
app.commandLine.appendSwitch('disable-background-timer-throttling');

app.whenReady().then(() => {
  createWindow();
  setupTray();
  globalShortcut.register('CommandOrControl+Shift+V', () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('toggle-voice');
  });
});

app.on('before-quit', () => {
  app.isQuitting = true;
  globalShortcut.unregisterAll();
  if (whisperProc) { try{whisperProc.kill();}catch(_){} whisperProc=null; }
  if (ttsProc)     { try{ttsProc.kill();}    catch(_){} ttsProc=null;     }
});

app.on('window-all-closed', () => {
  // Keep alive when tray is present — tray Quit item sets app.isQuitting first
  if (!tray) {
    globalShortcut.unregisterAll();
    if (whisperProc) { try{whisperProc.kill();}catch(_){} whisperProc=null; }
    if (ttsProc)     { try{ttsProc.kill();}    catch(_){} ttsProc=null;     }
    app.quit();
  }
});

app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
app.setName('SOHMNAMP');
