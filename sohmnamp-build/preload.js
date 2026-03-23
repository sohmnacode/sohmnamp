const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  resizeWindow:      (w, h) => ipcRenderer.send('resize-window', w, h),
  toggleFullscreen:  ()     => ipcRenderer.send('toggle-fullscreen'),
  exitFullscreen:    ()     => ipcRenderer.send('exit-fullscreen'),
  setMiniMode:       (on)   => ipcRenderer.send('mini-mode', on),
  onFullscreenChanged: (cb) => ipcRenderer.on('fullscreen-changed', (_e, val) => cb(val)),
});
