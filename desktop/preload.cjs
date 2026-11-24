const { contextBridge, ipcRenderer, webUtils } = require('electron');
contextBridge.exposeInMainWorld('qiliaoDesktop', Object.freeze({
  checkUpdate: () => ipcRenderer.invoke('update:check'),
  downloadUpdate: () => ipcRenderer.invoke('update:download'),
  updateStatus: () => ipcRenderer.invoke('update:status'),
  applyUpdate: () => ipcRenderer.invoke('update:apply'),
  showUpdate: () => ipcRenderer.invoke('update:folder'),
  importBundledQQ: () => ipcRenderer.invoke('qq:import-bundled'),
  importNapCat: file => ipcRenderer.invoke('qq:import',webUtils.getPathForFile(file)),
  startQQ: () => ipcRenderer.invoke('qq:start'),
  unbindQQ: () => ipcRenderer.invoke('qq:unbind'),
  stopQQ: () => ipcRenderer.invoke('qq:stop'),
  status: () => ipcRenderer.invoke('desktop:status'),
  quit: () => ipcRenderer.invoke('desktop:quit')
}));
