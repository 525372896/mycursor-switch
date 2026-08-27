'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const cursor = require('./cursor');
const store = require('./store');

let win = null;
const RELEASES_URL = 'https://github.com/525372896/mycursor-switch/releases/latest';

function createWindow() {
  win = new BrowserWindow({
    width: 880,
    height: 660,
    minWidth: 720,
    minHeight: 520,
    title: 'MyCursor 换号助手',
    backgroundColor: '#0f1729',
    icon: path.join(__dirname, 'icon.png'),
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

// ---------- 自动更新（electron-updater，走 GitHub Release 的 latest.yml）----------
// Windows：未签名也能自动下载 + 一键重启安装；macOS：自动安装需 Apple 签名，这里只提示去下载页手动更新。
// 注意：只有装了「带本更新功能的版本(≥1.0.3)」的用户才会收到之后新版的提示——这是自动更新的固有引导过程。
let updaterReady = false;
function initUpdater() {
  if (!app.isPackaged) { log('（开发模式，跳过自动更新检查）'); return; }
  if (updaterReady) return;
  updaterReady = true;
  try {
    autoUpdater.autoDownload = process.platform === 'win32';
    autoUpdater.autoInstallOnAppQuit = true;

    autoUpdater.on('checking-for-update', () => log('🔎 正在检查更新…'));
    autoUpdater.on('update-not-available', () => log('✅ 已是最新版本'));
    autoUpdater.on('download-progress', (p) => { if (win) win.webContents.send('update-progress', Math.round(p.percent)); });
    autoUpdater.on('error', (e) => log('⚠ 检查更新失败：' + ((e && e.message) || e)));

    autoUpdater.on('update-available', (info) => {
      if (process.platform === 'win32') {
        log(`🎉 发现新版本 v${info.version}，正在后台下载…`);
      } else {
        log(`🎉 发现新版本 v${info.version}（macOS 请到发布页手动下载）`);
        dialog.showMessageBox(win, {
          type: 'info', buttons: ['去下载', '稍后'], defaultId: 0, cancelId: 1,
          message: `发现新版本 v${info.version}`,
          detail: 'macOS 版暂需手动下载安装（自动更新需 Apple 开发者签名）。',
        }).then((r) => { if (r.response === 0) shell.openExternal(RELEASES_URL); }).catch(() => { /* ignore */ });
      }
    });

    autoUpdater.on('update-downloaded', (info) => {
      if (win) win.webContents.send('update-progress', 100);
      log(`✅ 新版本 v${info.version} 已下载完成`);
      dialog.showMessageBox(win, {
        type: 'info', buttons: ['立即重启安装', '稍后'], defaultId: 0, cancelId: 1,
        message: `新版本 v${info.version} 已准备好`,
        detail: '点「立即重启安装」几秒完成更新；选「稍后」则下次退出程序时自动安装。',
      }).then((r) => { if (r.response === 0) setImmediate(() => autoUpdater.quitAndInstall()); }).catch(() => { /* ignore */ });
    });

    setTimeout(() => { autoUpdater.checkForUpdates().catch(() => { /* ignore */ }); }, 3000);
  } catch (e) { log('⚠ 自动更新初始化失败：' + e.message); }
}

// 单实例
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) { app.quit(); }
else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });

  app.whenReady().then(() => {
    store.init(app.getPath('userData'));
    createWindow();
    initUpdater();
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
}

// ---------- IPC ----------

ipcMain.handle('app:status', () => ({
  platform: process.platform,
  cursorInstalled: cursor.stateDbExists(),
  stateDbPath: cursor.stateDbPath(),
  version: app.getVersion(),
}));

ipcMain.handle('app:checkUpdate', () => {
  if (!app.isPackaged) { log('（开发模式无法检查更新，打包后才生效）'); return { ok: false }; }
  log('🔎 正在检查更新…');
  autoUpdater.checkForUpdates().catch((e) => log('⚠ 检查更新失败：' + ((e && e.message) || e)));
  return { ok: true };
});

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
