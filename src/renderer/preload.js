const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  accountsList: () => ipcRenderer.invoke('accounts:list'),
  accountsAdd: () => ipcRenderer.invoke('accounts:add'),
  accountsRename: (id, name) => ipcRenderer.invoke('accounts:rename', { id, name }),
  accountsUpdate: (id, data) => ipcRenderer.invoke('accounts:update', { id, data }),
  accountsDelete: (id) => ipcRenderer.invoke('accounts:delete', { id }),

  selectAccount: (id) => ipcRenderer.invoke('view:selectAccount', { id }),
  openSettings: () => ipcRenderer.invoke('view:openSettings'),
  reloadActive: () => ipcRenderer.invoke('view:reloadActive'),
  updateViewBounds: () => ipcRenderer.invoke('layout:updateViewBounds'),
  setSidebarWidth: (width) => ipcRenderer.invoke('layout:setSidebarWidth', { width }),

  settingsGet: () => ipcRenderer.invoke('settings:get'),
  settingsSet: (partial) => ipcRenderer.invoke('settings:set', partial),
  pickRecordingsPath: () => ipcRenderer.invoke('settings:pickRecordingsPath'),

  listDevices: () => ipcRenderer.invoke('recording:listDevices'),
  testRecording: (cfg) => ipcRenderer.invoke('recording:test', cfg),
  resetCache: (id) => ipcRenderer.invoke('cache:resetAccount', { id }),
  openRecordingsFolder: () => ipcRenderer.invoke('recordings:openFolder'),
});
