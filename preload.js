const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('claudeUsage', {
  onUsageUpdate:  (cb) => ipcRenderer.on('usage-update',  (_, data) => cb(data)),
  onConfigUpdate: (cb) => ipcRenderer.on('config-update', (_, data) => cb(data)),
  onNoData:       (cb) => ipcRenderer.on('no-data',       () => cb()),
  dragEnd:        ()    => ipcRenderer.send('drag-end'),
  minimize:       ()    => ipcRenderer.send('minimize'),
  saveConfig:     (cfg) => ipcRenderer.send('save-config', cfg),
  getConfig:      ()    => ipcRenderer.invoke('get-config'),
});
