const { app, BrowserWindow, shell, screen } = require('electron');
const fs = require('fs');
const path = require('path');

const isDev = !app.isPackaged;
const DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL || 'http://127.0.0.1:3000';
const STATE_FILE = () => path.join(app.getPath('userData'), 'window-state.json');

const DEFAULT_STATE = {
  width: 1400,
  height: 900,
  isMaximized: false,
};

function loadWindowState() {
  try {
    const saved = JSON.parse(fs.readFileSync(STATE_FILE(), 'utf8'));
    return { ...DEFAULT_STATE, ...saved };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

function isOnScreen(bounds) {
  return screen.getAllDisplays().some((display) => {
    const area = display.workArea;
    const overlapsX = bounds.x < area.x + area.width && bounds.x + bounds.width > area.x;
    const overlapsY = bounds.y < area.y + area.height && bounds.y + bounds.height > area.y;
    return overlapsX && overlapsY;
  });
}

function saveWindowState(win) {
  if (!win || win.isDestroyed()) return;

  // Prefer normal (restored) bounds so maximizing doesn't overwrite the last free-floating size.
  const bounds = win.getNormalBounds();
  const state = {
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    isMaximized: win.isMaximized(),
  };

  try {
    fs.writeFileSync(STATE_FILE(), JSON.stringify(state, null, 2));
  } catch (err) {
    console.error('[window-state] Failed to save:', err);
  }
}

function createWindow() {
  const state = loadWindowState();
  const iconPath = path.join(__dirname, '..', 'resources', 'icon.ico');
  const options = {
    width: state.width,
    height: state.height,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: '#0f172a',
    autoHideMenuBar: true,
    title: 'Lexiflow IELTS',
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  };

  if (
    typeof state.x === 'number' &&
    typeof state.y === 'number' &&
    isOnScreen({ x: state.x, y: state.y, width: state.width, height: state.height })
  ) {
    options.x = state.x;
    options.y = state.y;
  }

  const win = new BrowserWindow(options);

  win.once('ready-to-show', () => {
    if (state.isMaximized) win.maximize();
    win.show();
  });

  // Persist on close and while the user repositions/resizes (debounced).
  let saveTimer = null;
  const scheduleSave = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => saveWindowState(win), 300);
  };
  win.on('resize', scheduleSave);
  win.on('move', scheduleSave);
  win.on('maximize', scheduleSave);
  win.on('unmaximize', scheduleSave);
  win.on('close', () => {
    clearTimeout(saveTimer);
    saveWindowState(win);
  });

  // Allow Firebase OAuth (signInWithPopup) to open its popup window,
  // while sending any other external links to the system browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    const allowed =
      url.startsWith('http://127.0.0.1') ||
      url.startsWith('http://localhost') ||
      url.includes('firebaseapp.com') ||
      url.includes('accounts.google.com');
    if (allowed) return { action: 'allow' };
    shell.openExternal(url);
    return { action: 'deny' };
  });

  if (isDev) {
    win.loadURL(DEV_SERVER_URL);
  } else {
    win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
