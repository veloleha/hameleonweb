const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  authGet: () => ipcRenderer.invoke('auth:get'),
  authSetApiBaseUrl: (apiBaseUrl) => ipcRenderer.invoke('auth:setApiBaseUrl', apiBaseUrl),
  authRequestCode: (payload) => ipcRenderer.invoke('auth:requestCode', payload),
  authVerifyCode: (payload) => ipcRenderer.invoke('auth:verifyCode', payload),
  authRefreshLicenses: () => ipcRenderer.invoke('auth:refreshLicenses'),
  authClear: () => ipcRenderer.invoke('auth:clear'),

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

  startSufler: (accountId, sinkId) => ipcRenderer.invoke('wa:startSufler', { accountId, sinkId }),
  stopSufler: (accountId) => ipcRenderer.invoke('wa:stopSufler', { accountId }),
  getSuflerUrl: (accountId) => ipcRenderer.invoke('wa:getSuflerUrl', { accountId }),
  getAudioOutputDevices: () => ipcRenderer.invoke('wa:getAudioOutputDevices'),

  checkUpdate: () => ipcRenderer.invoke('app:checkUpdate'),
  installUpdate: (opts) => ipcRenderer.invoke('app:installUpdate', opts),
  onDownloadProgress: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('update:download-progress', handler);
    return () => ipcRenderer.removeListener('update:download-progress', handler);
  },
  onRecStarted: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('rec:started', handler);
    return () => ipcRenderer.removeListener('rec:started', handler);
  },
  onRecStopped: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('rec:stopped', handler);
    return () => ipcRenderer.removeListener('rec:stopped', handler);
  },
  onAuthUpdated: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('auth:updated', handler);
    return () => ipcRenderer.removeListener('auth:updated', handler);
  },
});
