'use strict';
const { contextBridge, ipcRenderer } = require('electron');

// 只暴露这几个安全的调用给界面用（contextIsolation 开着，界面拿不到 Node）
contextBridge.exposeInMainWorld('api', {
  status: () => ipcRenderer.invoke('app:status'),
  list: () => ipcRenderer.invoke('accounts:list'),
  add: (token) => ipcRenderer.invoke('accounts:add', token),
  remove: (id) => ipcRenderer.invoke('accounts:remove', id),
  switch: (id) => ipcRenderer.invoke('accounts:switch', id),
  onLog: (cb) => ipcRenderer.on('log', (_e, line) => cb(line)),
});
