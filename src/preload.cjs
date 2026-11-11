// Ponte mínima e segura entre a janela (http://127.0.0.1) e o atualizador automático do Electron.
// Expõe APENAS dois métodos; a página não ganha acesso ao Node.js nem ao sistema.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('guardiaoUpdater', {
  onState: (callback) => {
    if (typeof callback !== 'function') return;
    ipcRenderer.on('updater:state', (_event, state) => callback(state));
    ipcRenderer.invoke('updater:get-state').then(callback).catch(() => {});
  },
  installNow: () => ipcRenderer.invoke('updater:install-now'),
  checkNow: () => ipcRenderer.invoke('updater:check-now')
});
