const { app, BrowserWindow, ipcMain, globalShortcut } = require('electron');
const path = require('path');
const fs   = require('fs');
const os   = require('os');
const { execFile, exec, spawn } = require('child_process');

const PLAYER_WIDTH  = 560;
const PLAYER_HEIGHT = 880;
const MINI_WIDTH    = 560;
const MINI_HEIGHT   = 520;

let mainWindow;

// ── Whisper persistent server state ──────────────────────────────────────────
let whisperProc  = null;
let whisperReady = false;
let whisperQueue = [];
let whisperBuf   = '';

const isWin = process.platform === 'win32';
const pythonCandidates = isWin
  ? ['python', 'python3', 'py']   // Windows: rely on PATH / py launcher
  : [
      '/opt/homebrew/bin/python3',
      '/opt/homebrew/bin/python3.12',
      '/opt/homebrew/bin/python3.11',
      '/opt/homebrew/bin/python3.10',
      '/usr/local/bin/python3',
      '/usr/local/bin/python3.12',
      '/usr/local/bin/python3.11',
      '/usr/bin/python3',
      'python3'
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
  const proc   = spawn(python, [getHelperScript(), '--server'], {
    env: { ...process.env, PYTHONUNBUFFERED: '1' },
    stdio: ['pipe', 'pipe', 'pipe']
  });
  proc.on('error', (e) => {
    if (e.code === 'ENOENT') { startWhisperServer(rest, onReady); return; }
    console.error('[voice] server error:', e.message); onReady(false);
  });
  proc.stderr.on('data', (d) => { const m=d.toString().trim(); if(m) console.log('[voice] py:', m); });
  proc.stdout.on('data', (data) => {
    whisperBuf += data.toString();
    const lines = whisperBuf.split('\n');
    whisperBuf  = lines.pop();
    for (const line of lines) {
      const t = line.trim();
      if (t === 'READY') {
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
    while (whisperQueue.length) { const i=whisperQueue.shift(); try{fs.unlinkSync(i.tmpFile);}catch(_){} i.resolve(''); }
  });
  whisperProc = proc;
}
// ─────────────────────────────────────────────────────────────────────────────

function createWindow() {
  mainWindow = new BrowserWindow({
    width: PLAYER_WIDTH, height: PLAYER_HEIGHT,
    minWidth: 300, minHeight: 200, maxWidth: PLAYER_WIDTH,
    backgroundColor: '#06060c', titleBarStyle: 'default', resizable: true,
    webPreferences: { nodeIntegration: false, contextIsolation: true, preload: path.join(__dirname, 'preload.js') },
    icon: path.join(__dirname, 'assets', 'icon.png'), show: false,
  });
  mainWindow.loadFile('index.html');
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    const hs = getHelperScript();
    if (fs.existsSync(hs) && !whisperProc) startWhisperServer([...pythonCandidates], (ok) => { if(!ok) console.error('[voice] Whisper server failed'); });
  });
  const ses = mainWindow.webContents.session;
  const ALLOWED_PERMS = ['camera','microphone','media','media-stream','mediaKeySystem','audioCapture','videoCapture','notifications'];
  ses.setPermissionRequestHandler((wc, perm, cb) => cb(ALLOWED_PERMS.includes(perm)));
  ses.setPermissionCheckHandler((wc, perm) => ALLOWED_PERMS.includes(perm));

  // Allow renderer fetch() to reach iTunes Search API and podcast RSS feeds
  ses.webRequest.onHeadersReceived({ urls: ['https://itunes.apple.com/*', 'http://*/*', 'https://*/*'] }, (details, cb) => {
    const headers = { ...details.responseHeaders };
    headers['Access-Control-Allow-Origin']  = ['*'];
    headers['Access-Control-Allow-Methods'] = ['GET'];
    headers['Access-Control-Allow-Headers'] = ['Content-Type', 'User-Agent'];
    // Strip any CSP that would block external fetches
    delete headers['content-security-policy'];
    delete headers['Content-Security-Policy'];
    cb({ responseHeaders: headers });
  });
  mainWindow.on('enter-full-screen', () => { mainWindow.setFullScreen(true); mainWindow.webContents.send('fullscreen-changed', true); });
  mainWindow.on('leave-full-screen', () => { mainWindow.setSize(PLAYER_WIDTH, PLAYER_HEIGHT); mainWindow.webContents.send('fullscreen-changed', false); });
  mainWindow.on('closed', () => { mainWindow = null; });
}

// ── All IPC handlers registered ONCE at module level ─────────────────────────

ipcMain.on('toggle-fullscreen',  () => { if(mainWindow) mainWindow.setFullScreen(!mainWindow.isFullScreen()); });
ipcMain.on('exit-fullscreen',    () => { if(mainWindow) mainWindow.setFullScreen(false); });
ipcMain.on('resize-window', (e, w, h) => { if(mainWindow && !mainWindow.isFullScreen()) mainWindow.setSize(mainWindow.getSize()[0], Math.round(h)); });
ipcMain.on('set-always-on-top', (e, val) => { if(mainWindow) mainWindow.setAlwaysOnTop(!!val, 'floating'); });
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

ipcMain.handle('voice-transcribe', async (e, audioBytes) => {
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
ipcMain.handle('get-claude-key', () => process.env.ANTHROPIC_API_KEY || '');

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

app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-zero-copy');
app.commandLine.appendSwitch('enable-features', 'WebRTC,MediaRecorder,GetDisplayMedia');
app.commandLine.appendSwitch('disable-features', 'WebRtcHideLocalIpsWithMdns');
app.commandLine.appendSwitch('disable-background-timer-throttling');

app.whenReady().then(() => {
  createWindow();
  globalShortcut.register('CommandOrControl+Shift+V', () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('toggle-voice');
  });
});

app.on('window-all-closed', () => {
  globalShortcut.unregisterAll();
  if (whisperProc) { try{whisperProc.kill();}catch(_){} whisperProc=null; }
  if (ttsProc)     { try{ttsProc.kill();}    catch(_){} ttsProc=null;     }
  app.quit();
});

app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
app.setName('SOHMNAMP');
