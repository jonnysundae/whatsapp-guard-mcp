import { app, BrowserWindow, ipcMain } from 'electron';
import updaterPkg from 'electron-updater';
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
    setupAutoUpdater();
  });
}

// ---------------------------------------------------------------------------
// ATUALIZAÇÃO AUTOMÁTICA (GitHub Releases via electron-updater)
// Baixa em segundo plano; instala ao clicar em "Reiniciar e atualizar" ou ao fechar o app.
// A sessão do WhatsApp (wa_auth) e o banco ficam em %LOCALAPPDATA% e NÃO são tocados.
// ---------------------------------------------------------------------------
const { autoUpdater } = updaterPkg;
const UPDATE_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;
let updaterState = { status: 'idle', currentVersion: app.getVersion(), version: null, percent: 0, error: null };

function setUpdaterState(patch) {
  updaterState = { ...updaterState, ...patch, currentVersion: app.getVersion() };
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('updater:state', updaterState);
  }
}

function fetchBackendState() {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${PORT}/api/state`, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (raw += c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(raw));
        } catch {
          resolve(null);
        }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(2000, () => req.destroy());
  });
}

// Não reinicia no meio de um envio ("digitando...") para não cortar uma mensagem pela metade
async function waitUntilNotSending(maxWaitMs = 90000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const state = await fetchBackendState();
    const busy = Array.isArray(state?.outbox) && state.outbox.some((m) => m.status === 'sending_typing');
    if (!busy) return;
    await new Promise((r) => setTimeout(r, 1500));
  }
}

async function installDownloadedUpdate() {
  if (updaterState.status !== 'downloaded') return { ok: false, error: 'Nenhuma atualização pronta.' };
  setUpdaterState({ status: 'installing' });
  await waitUntilNotSending();
  isQuitting = true;
  stopBackendWorker();
  // Aguarda o motor liberar os arquivos antes de o instalador substituir o programa
  await new Promise((r) => setTimeout(r, 1500));
  autoUpdater.quitAndInstall(true, true);
  return { ok: true };
}

function setupAutoUpdater() {
  ipcMain.handle('updater:get-state', () => updaterState);
  ipcMain.handle('updater:install-now', () => installDownloadedUpdate());
  ipcMain.handle('updater:check-now', async () => {
    if (!app.isPackaged) return updaterState;
    try {
      await autoUpdater.checkForUpdates();
    } catch (err) {
      setUpdaterState({ status: 'error', error: err?.message || String(err) });
    }
    return updaterState;
  });

  if (!app.isPackaged) {
    setUpdaterState({ status: 'dev' });
    return;
  }

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = {
    info: (m) => logInfo('updater', String(m)),
    warn: (m) => logInfo('updater', `WARN ${m}`),
    error: (m) => logError('updater', String(m)),
    debug: () => {}
  };

  autoUpdater.on('checking-for-update', () => setUpdaterState({ status: 'checking', error: null }));
  autoUpdater.on('update-not-available', () => setUpdaterState({ status: 'up-to-date' }));
  autoUpdater.on('update-available', (info) =>
    setUpdaterState({ status: 'downloading', version: info?.version || null, percent: 0 })
  );
  autoUpdater.on('download-progress', (p) =>
    setUpdaterState({ status: 'downloading', percent: Math.round(p?.percent || 0) })
  );
  autoUpdater.on('update-downloaded', (info) => {
    logInfo('updater', 'Atualização baixada e pronta', { version: info?.version });
    setUpdaterState({ status: 'downloaded', version: info?.version || updaterState.version, percent: 100 });
  });
  autoUpdater.on('error', (err) => {
    logError('updater', 'Falha ao verificar/baixar atualização', err);
    setUpdaterState({ status: 'error', error: err?.message || String(err) });
  });

  const check = () => autoUpdater.checkForUpdates().catch(() => {});
  setTimeout(check, 8000);
  setInterval(check, UPDATE_CHECK_INTERVAL_MS);
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
      contextIsolation: true,
      sandbox: true,
      preload: path.join(__dirname, 'preload.cjs')
    }
  });

  mainWindow.loadURL(`http://127.0.0.1:${PORT}`);
  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow?.webContents.send('updater:state', updaterState);
  });

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
