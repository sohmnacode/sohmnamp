const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');

let mainWindow;

const PLAYER_WIDTH = 760;
const PLAYER_HEIGHT = 880;
const MINI_WIDTH = 320;
const MINI_HEIGHT = 180;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: PLAYER_WIDTH,
    height: PLAYER_HEIGHT,
    minWidth: 300,
    minHeight: 150,
    maxWidth: PLAYER_WIDTH,
    backgroundColor: '#06060c',
    titleBarStyle: 'default',
    resizable: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    },
    icon: path.join(__dirname, 'assets', 'icon.png'),
    show: false,
  });

  mainWindow.loadFile('index.html');

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  ipcMain.on('toggle-fullscreen', () => {
    mainWindow.setFullScreen(!mainWindow.isFullScreen());
  });

  ipcMain.on('exit-fullscreen', () => {
    mainWindow.setFullScreen(false);
  });

  // Dynamic window resize when panels open/close
  ipcMain.on('resize-window', (event, w, h) => {
    if (mainWindow.isFullScreen()) return;
    const [currentW] = mainWindow.getSize();
    // Animate smoothly by setting size directly
    mainWindow.setSize(currentW, Math.round(h));
  });

  // Mini player mode
  ipcMain.on('mini-mode', (event, enabled) => {
    if (enabled) {
      mainWindow.setMaximumSize(2000, 2000);
      mainWindow.setMinimumSize(MINI_WIDTH, MINI_HEIGHT);
      mainWindow.setSize(MINI_WIDTH, MINI_HEIGHT);
      mainWindow.setAlwaysOnTop(true);
      mainWindow.setMaximumSize(500, 300);
    } else {
      mainWindow.setAlwaysOnTop(false);
      mainWindow.setMaximumSize(PLAYER_WIDTH, 2000);
      mainWindow.setMinimumSize(PLAYER_WIDTH, 400);
      mainWindow.setSize(PLAYER_WIDTH, PLAYER_HEIGHT);
      mainWindow.center();
    }
  });

  mainWindow.on('enter-full-screen', () => {
    mainWindow.setFullScreen(true);
    mainWindow.webContents.send('fullscreen-changed', true);
  });

  mainWindow.on('leave-full-screen', () => {
    mainWindow.setSize(PLAYER_WIDTH, PLAYER_HEIGHT);
    mainWindow.center();
    mainWindow.webContents.send('fullscreen-changed', false);
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-zero-copy');

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

app.setName('SOHMNAMP');
