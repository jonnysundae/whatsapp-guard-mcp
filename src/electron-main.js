import { app, BrowserWindow } from 'electron';
import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installProcessLogHooks, logError, logInfo } from './logger.js';

installProcessLogHooks('electron-ui');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = Number(process.env.WHATSAPP_GUARD_PORT || 3847);

let mainWindow = null;
let serverChild = null;
let isQuitting = false;

function startBackendWorker() {
  const serverScript = path.join(__dirname, 'main-server.js');
  logInfo('electron-ui', 'Iniciando processo isolado do motor WhatsApp/SQLite', { serverScript });

  serverChild = spawn(process.execPath, [serverScript], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      GUARDIAO_CHILD_MODE: '1'
    },
    stdio: ['pipe', 'ignore', 'ignore'],
    windowsHide: true
  });

  serverChild.on('error', (err) => {
    logError('electron-ui', 'Falha ao iniciar processo do servidor', err);
  });

  serverChild.on('exit', (code) => {
    logInfo('electron-ui', 'Processo do servidor encerrado', { code });
    serverChild = null;
  });
}

function stopBackendWorker() {
  if (!serverChild) return;
  const child = serverChild;
  serverChild = null;
  try {
    child.stdin?.end();
  } catch {
    // ignora
  }
  setTimeout(() => {
    try {
      child.kill();
    } catch {
      // ignora
    }
  }, 600);
}

function waitForBackendReady(timeoutMs = 6000) {
  const start = Date.now();
  return new Promise((resolve) => {
    const check = () => {
      const req = http.get(`http://127.0.0.1:${PORT}/api/health`, (res) => {
        res.resume();
        if (res.statusCode === 200) {
          resolve(true);
        } else if (Date.now() - start < timeoutMs) {
          setTimeout(check, 70);
        } else {
          resolve(false);
        }
      });
      req.on('error', () => {
        if (Date.now() - start < timeoutMs) {
          setTimeout(check, 70);
        } else {
          resolve(false);
        }
      });
      req.setTimeout(500, () => {
        req.destroy();
      });
    };
    check();
  });
}

// Evita duas instâncias abertas ao mesmo tempo
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    startBackendWorker();
    await waitForBackendReady(6000);
    createWindow();
  });
}

function createWindow() {
  const iconPath = path.join(__dirname, '..', 'public', 'icon.png');

  mainWindow = new BrowserWindow({
    width: 980,
    height: 670,
    minWidth: 840,
    minHeight: 580,
    title: 'Guardião WhatsApp',
    icon: iconPath,
    autoHideMenuBar: true,
    backgroundColor: '#f6f7f9',
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#ffffff',
      symbolColor: '#374151',
      height: 44
    },
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  mainWindow.loadURL(`http://127.0.0.1:${PORT}`);

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.on('before-quit', () => {
  if (!isQuitting) {
    isQuitting = true;
    stopBackendWorker();
  }
});

// Fechou a janela = encerra o servidor local e desconecta da sessão na hora
app.on('window-all-closed', () => {
  stopBackendWorker();
  app.quit();
});
