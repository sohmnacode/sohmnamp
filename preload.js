const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {

  // ── Window / UI ────────────────────────────────────────────────────────────
  toggleFullscreen : ()        => ipcRenderer.send('toggle-fullscreen'),
  exitFullscreen   : ()        => ipcRenderer.send('exit-fullscreen'),
  resizeWindow     : (w, h)    => ipcRenderer.send('resize-window', w, h),
  setAlwaysOnTop   : (val)     => ipcRenderer.send('set-always-on-top', val),
  setMiniMode      : (enabled) => ipcRenderer.send('mini-mode', enabled),

  // ── Media permissions ──────────────────────────────────────────────────────
  askMediaAccess      : (type) => ipcRenderer.invoke('ask-media-access', type),
  getMediaAccessStatus: (type) => ipcRenderer.invoke('get-media-access-status', type),

  // ── Voice / Whisper ────────────────────────────────────────────────────────
  transcribeVoice : (audioBytes) => ipcRenderer.invoke('voice-transcribe', audioBytes),
  systemMute      : ()           => ipcRenderer.invoke('voice-system-mute'),
  systemUnmute    : ()           => ipcRenderer.invoke('voice-system-unmute'),
  speak           : (text)       => ipcRenderer.invoke('voice-speak', text),
  speakStop       : ()           => ipcRenderer.send('voice-speak-stop'),

  // ── Claude API key ─────────────────────────────────────────────────────────
  getClaudeKey: () => ipcRenderer.invoke('get-claude-key'),

  // ── Podcast (Node fetch — no CORS) ─────────────────────────────────────────
  podcastSearch : (query)   => ipcRenderer.invoke('podcast-search',  query),
  podcastRss    : (feedUrl) => ipcRenderer.invoke('podcast-rss',     feedUrl),
  podcastCharts : ()        => ipcRenderer.invoke('podcast-charts'),

  // ── Error reporting ────────────────────────────────────────────────────────
  reportError: (info) => ipcRenderer.send('report-error', info),

  // ── Renderer-bound event listeners ────────────────────────────────────────
  onToggleVoice      : (cb) => ipcRenderer.on('toggle-voice',       () => cb()),
  onWakeWord         : (cb) => ipcRenderer.on('wake-word',          () => cb()),
  onFullscreenChanged: (cb) => ipcRenderer.on('fullscreen-changed', (_e, val) => cb(val)),
  onUpdateDownloading: (cb) => ipcRenderer.on('update-downloading', () => cb()),
  onUpdateProgress   : (cb) => ipcRenderer.on('update-progress',    (_e, pct) => cb(pct)),
  onAppAudioMute     : (cb) => ipcRenderer.on('app-audio-mute',     (_e, val) => cb(val)),
});
