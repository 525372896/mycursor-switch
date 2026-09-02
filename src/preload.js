'use strict';
const { contextBridge, ipcRenderer } = require('electron');

// 只暴露这几个安全的调用给界面用（contextIsolation 开着，界面拿不到 Node）
contextBridge.exposeInMainWorld('api', {
  status: () => ipcRenderer.invoke('app:status'),
  list: () => ipcRenderer.invoke('accounts:list'),
  add: (token) => ipcRenderer.invoke('accounts:add', token),
  remove: (id) => ipcRenderer.invoke('accounts:remove', id),
  usage: (id) => ipcRenderer.invoke('accounts:usage', id),
  switch: (id) => ipcRenderer.invoke('accounts:switch', id),
  openUsage: (id) => ipcRenderer.invoke('accounts:openUsage', id),
  checkUpdate: () => ipcRenderer.invoke('app:checkUpdate'),
  openGithub: () => ipcRenderer.invoke('app:openGithub'),
  patchStatus: () => ipcRenderer.invoke('patch:status'),
  patchApply: () => ipcRenderer.invoke('patch:apply'),
  patchRestore: () => ipcRenderer.invoke('patch:restore'),
  patchSetPath: (p) => ipcRenderer.invoke('patch:setPath', p),
  getBlockUpdate: () => ipcRenderer.invoke('prefs:getBlockUpdate'),
  setBlockUpdate: (on) => ipcRenderer.invoke('prefs:setBlockUpdate', on),
  getStreamDirect: () => ipcRenderer.invoke('prefs:getStreamDirect'),
  setStreamDirect: (on) => ipcRenderer.invoke('prefs:setStreamDirect', on),
  onProgress: (cb) => ipcRenderer.on('update-progress', (_e, pct) => cb(pct)),
  onLog: (cb) => ipcRenderer.on('log', (_e, line) => cb(line)),
  onPatchProgress: (cb) => ipcRenderer.on('patch-progress', (_e, p) => cb(p)),
});
