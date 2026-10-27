const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('ds', {
  pickFolder: () => ipcRenderer.invoke('ds:pick-folder'),
  compare: (args) => ipcRenderer.invoke('ds:compare', args),
  copy: (args) => ipcRenderer.invoke('ds:copy', args),
  cancel: () => ipcRenderer.invoke('ds:cancel'),
  saveReport: (args) => ipcRenderer.invoke('ds:save-report', args),
  rename: (args) => ipcRenderer.invoke('ds:rename', args),
  preview: (args) => ipcRenderer.invoke('ds:preview', args),
  open: (args) => ipcRenderer.invoke('ds:open', args),
  onProgress: (cb) => ipcRenderer.on('ds:progress', (_e, d) => cb(d)),
  onCopyProgress: (cb) => ipcRenderer.on('ds:copy-progress', (_e, d) => cb(d)),
});
