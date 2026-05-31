'use strict';
const { app, BrowserWindow, Menu, shell, ipcMain } = require('electron');
const path    = require('path');
const { spawn } = require('child_process');
const https   = require('https');

let mainWindow;
let serverProcess;
const PORT = 3000;

// ── Start embedded Node server ───────────────────────────────────────────────
function startServer() {
  const serverPath = path.join(__dirname, '..', 'server.js');
  serverProcess = spawn(process.execPath, [serverPath], {
    env:   { ...process.env, PORT: String(PORT), ELECTRON: '1', NO_HTTPS: '' },
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd:   path.join(__dirname, '..'),
  });
  serverProcess.stdout.on('data', d => process.stdout.write('[server] ' + d));
  serverProcess.stderr.on('data', d => process.stderr.write('[server] ' + d));
  serverProcess.on('exit', code => { if (code !== 0) console.warn('Server exited:', code); });

  // Wait until /api/health responds
  return new Promise(resolve => {
    const check = () => {
      const req = https.request(
        { hostname: 'localhost', port: PORT, path: '/api/health', rejectUnauthorized: false },
        res => { if (res.statusCode === 200) resolve(); else setTimeout(check, 400); }
      );
      req.on('error', () => setTimeout(check, 400));
      req.end();
    };
    setTimeout(check, 800);
  });
}

// ── Create window ─────────────────────────────────────────────────────────────
async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280, height: 840,
    minWidth: 900, minHeight: 620,
    backgroundColor: '#060810',
    show: false,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  // Trust our self-signed cert
  mainWindow.webContents.on('certificate-error', (e, _url, _err, _cert, cb) => {
    e.preventDefault(); cb(true);
  });

  // Open external links in system browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  await startServer().catch(err => console.error('Server start failed:', err));

  mainWindow.loadURL(`https://localhost:${PORT}`);
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    if (process.env.NODE_ENV === 'development') mainWindow.webContents.openDevTools();
  });
  mainWindow.on('closed', () => { mainWindow = null; });
}

// ── App Menu ──────────────────────────────────────────────────────────────────
function buildMenu() {
  const template = [
    { label: 'File', submenu: [
      { label: 'Reload', accelerator: 'CmdOrCtrl+R', click: () => mainWindow?.reload() },
      { type: 'separator' },
      { role: 'quit' },
    ]},
    { label: 'Edit', submenu: [
      { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
    ]},
    { label: 'View', submenu: [
      { role: 'toggleDevTools' },
      { role: 'togglefullscreen' },
    ]},
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────
app.whenReady().then(() => { buildMenu(); createWindow(); });

app.on('window-all-closed', () => {
  if (serverProcess) serverProcess.kill();
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => { if (!mainWindow) createWindow(); });

app.on('before-quit', () => { if (serverProcess) serverProcess.kill(); });
