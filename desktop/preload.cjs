const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('qiliaoDesktop', Object.freeze({
  startQQ: () => ipcRenderer.invoke('qq:start'),
  unbindQQ: () => ipcRenderer.invoke('qq:unbind'),
  stopQQ: () => ipcRenderer.invoke('qq:stop'),
  status: () => ipcRenderer.invoke('desktop:status'),
  quit: () => ipcRenderer.invoke('desktop:quit')
}));
