'use strict';
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const cursor = require('./cursor');
const store = require('./store');

let win = null;

function createWindow() {
  win = new BrowserWindow({
    width: 880,
    height: 660,
    minWidth: 720,
    minHeight: 520,
    title: 'MyCursor 换号助手',
    backgroundColor: '#0f1729',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // 需要 preload 里 require('electron')
    },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

function log(line) {
  try { win && win.webContents.send('log', line); } catch { /* ignore */ }
}

// 单实例
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) { app.quit(); }
else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });

  app.whenReady().then(() => {
    store.init(app.getPath('userData'));
    createWindow();
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
}

// ---------- IPC ----------

ipcMain.handle('app:status', () => ({
  platform: process.platform,
  cursorInstalled: cursor.stateDbExists(),
  stateDbPath: cursor.stateDbPath(),
}));

ipcMain.handle('accounts:list', () => store.list());

ipcMain.handle('accounts:add', async (_e, rawToken) => {
  const token = cursor.normalizeToken(rawToken || '');
  if (!token) return { ok: false, msg: '请粘贴 token' };
  const v = await cursor.validateToken(token);
  if (!v.ok) return { ok: false, msg: v.msg || 'token 校验失败' };
  const rec = store.add(token, v.email);
  return { ok: true, email: rec.email, msg: rec.email ? `已添加：${rec.email}` : '已添加（未取到邮箱，token 有效）' };
});

ipcMain.handle('accounts:remove', (_e, id) => ({ ok: store.remove(id) }));

ipcMain.handle('accounts:switch', async (_e, id) => {
  const rec = store.tokenById(id);
  if (!rec) return { ok: false, msg: '账号不存在（可能已删除）' };
  log(`⏳ 正在切换到 ${rec.email || '该账号'}：深链握手中…`);
  try {
    const r = await cursor.switchAccount(rec.token, rec.email, log);
    log((r.handshakeOk ? '✅ ' : '⚠ ') + r.msg);
    return r;
  } catch (e) {
    log('❌ 换号失败：' + e.message);
    return { ok: false, msg: e.message };
  }
});
