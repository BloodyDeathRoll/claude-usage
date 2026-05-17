const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, screen } = require('electron');
const path = require('path');
const fs   = require('fs');
const os   = require('os');

const { getUsage, CLAUDE_PROJECTS_DIR } = require('./src/usageParser');
const { fetchUsage, showAuthWindow, hasBrowserSession } = require('./src/claudeApi');

const CONFIG_PATH      = path.join(os.homedir(), '.claude-overlay-config.json');
const CACHE_PATH       = path.join(os.homedir(), '.claude-usage-cache.json');
const POLL_INTERVAL_MS = 10_000;
const IS_MAC           = process.platform === 'darwin';

let win, tray, pollTimer;

// ── Config ────────────────────────────────────────────────────────────────────

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); }
  catch { return null; }
}

function saveConfig(cfg) {
  try {
    const existing = loadConfig() ?? {};
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({ ...existing, ...cfg }, null, 2));
  } catch (e) { console.error('saveConfig failed:', e); }
}

// ── Tray icon ─────────────────────────────────────────────────────────────────

function buildTrayIcon() {
  const iconPath = path.join(__dirname, 'assets', 'tray-icon.png');
  if (fs.existsSync(iconPath)) {
    const img = nativeImage.createFromPath(iconPath);
    if (IS_MAC) img.setTemplateImage(true);
    return img;
  }
  return nativeImage.createEmpty();
}

// ── Window ────────────────────────────────────────────────────────────────────

function createWindow() {
  const cfg = loadConfig();
  const { width: sw } = screen.getPrimaryDisplay().workArea;
  const { x, y } = cfg?.position ?? { x: sw - 320, y: 50 };

  win = new BrowserWindow({
    width: 300,
    height: 100,
    useContentSize: true,
    x, y,
    alwaysOnTop: true,
    frame: false,
    transparent: false,
    backgroundColor: '#0f0f0f',
    resizable: false,
    skipTaskbar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  win.webContents.on('dom-ready', () => {
    win.show();
    pushUsage();
    win.webContents.send('config-update', loadConfig());
  });

  win.on('close', (e) => {
    e.preventDefault();
    win.hide();
  });
}

function createTray() {
  tray = new Tray(buildTrayIcon());
  tray.setToolTip('Claude Usage Overlay');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show',                 click: () => { win.show(); win.focus(); } },
    { label: 'Connect to claude.ai', click: () => showAuthWindow(() => pushUsage()) },
    { type: 'separator' },
    { label: 'Quit',                 click: () => app.exit(0) },
  ]));
  tray.on('click', () => { win.show(); win.focus(); });
}

// ── Data loop ─────────────────────────────────────────────────────────────────

async function pushUsage() {
  if (!win || win.isDestroyed()) return;
  // Try live API first; fall back to local JSONL counting
  let data = await fetchUsage();
  if (!data) data = await getUsage();
  if (!data) { win.webContents.send('no-data'); return; }
  win.webContents.send('usage-update', data);
  if (data.source === 'api') {
    try { fs.writeFileSync(CACHE_PATH, JSON.stringify(data)); } catch {}
  }
}

function startPolling() {
  pollTimer = setInterval(pushUsage, POLL_INTERVAL_MS);
}

// On first launch (or after cookies expire), the hidden BrowserWindow has no
// claude.ai session so we only get partial data (no Sonnet/Design rows).
// Auto-show the login window once — after the user logs in, cookies persist
// on disk so this never triggers again on subsequent launches.
let _authChecked = false;
async function checkAndAutoAuth() {
  if (_authChecked) return;
  _authChecked = true;
  const has = await hasBrowserSession();
  if (!has) showAuthWindow(() => pushUsage());
}

function startWatcher() {
  let chokidar;
  try { chokidar = require('chokidar'); } catch { return; }
  if (!fs.existsSync(CLAUDE_PROJECTS_DIR)) return;
  chokidar
    .watch(CLAUDE_PROJECTS_DIR, { ignoreInitial: true, depth: 5 })
    .on('change', pushUsage)
    .on('add',    pushUsage)
    .on('error',  () => {});
}

// ── IPC ───────────────────────────────────────────────────────────────────────

ipcMain.on('drag-end', () => {
  if (!win) return;
  const [x, y] = win.getPosition();
  saveConfig({ position: { x, y } });
});

ipcMain.on('minimize', () => win?.hide());

ipcMain.on('resize-to-content', (_, height) => {
  if (!win || win.isDestroyed()) return;
  const h = Math.max(60, Math.min(900, Math.ceil(height)));
  win.setContentSize(300, h);
});

ipcMain.on('save-config', (_, cfg) => {
  saveConfig(cfg);
  pushUsage();
  win?.webContents.send('config-update', loadConfig());
});

ipcMain.handle('get-config', () => loadConfig());

// ── App lifecycle ─────────────────────────────────────────────────────────────

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) { win.show(); win.focus(); }
  });

  app.whenReady().then(() => {
    if (IS_MAC) app.dock.hide();
    createWindow();
    createTray();
    startWatcher();
    startPolling();
    checkAndAutoAuth();
  });

  app.on('window-all-closed', (e) => e.preventDefault());
}
