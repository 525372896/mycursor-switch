'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, session } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const cursor = require('./cursor');
const store = require('./store');
const patchEngine = require('./sand_patch_engine');
const http2 = require('./http2');
const cursorSettings = require('./cursor_settings');
const fs = require('fs');

let win = null;
const GITHUB_URL = 'https://github.com/525372896/mycursor-switch';
const RELEASES_URL = GITHUB_URL + '/releases/latest';

function createWindow() {
  win = new BrowserWindow({
    width: 1080,
    height: 760,
    minWidth: 920,
    minHeight: 640,
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
    try { patchEngine.setConfigDir(path.join(app.getPath('userData'), 'sand-patch')); } catch { /* ignore */ }
    createWindow();
    // 默认禁止 Cursor 自动更新（防止升级后补丁失效）；用户可在补丁 Tab 关掉此开关
    try { if (getBlockUpdate()) cursorSettings.setAutoUpdateBlocked(true); } catch { /* ignore */ }
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

// 关于页：在系统浏览器打开项目 GitHub 主页（只开固定地址，不接受任意 URL）
ipcMain.handle('app:openGithub', () => {
  shell.openExternal(GITHUB_URL).catch(() => { /* ignore */ });
  return { ok: true, url: GITHUB_URL };
});

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

// 模型探测：这个号在 sand 通道下实际能用哪些高级模型
ipcMain.handle('accounts:probeSand', async (_e, id) => {
  const rec = store.tokenById(id);
  if (!rec) return { ok: false, msg: '账号不存在（可能已删除）' };
  log(`🔬 正在探测 ${rec.email || '该账号'} 在 sand 下可用的模型（逐个真调用，约 10-40s）…`);
  try {
    const r = await cursor.probeSandModels(rec.token);
    if (!r.ok) { log('⚠ 探测失败：' + (r.msg || '未知')); return r; }
    log(`✅ ${rec.email || '该账号'} 可用 ${r.ok.length} 个模型：${r.ok.join('、') || '无'}`);
    return r;
  } catch (e) { log('❌ 探测失败：' + e.message); return { ok: false, msg: e.message }; }
});

// 领取 Sand 资格：让 free / 普通套餐号拿到 bot 额度（原理图「情况③」）
ipcMain.handle('accounts:claimSand', async (_e, id) => {
  const rec = store.tokenById(id);
  if (!rec) return { ok: false, msg: '账号不存在（可能已删除）' };
  log(`⏳ 正在给 ${rec.email || '该账号'} 领取 Sand 资格…`);
  try {
    const r = await cursor.claimSand(rec.token);
    if (!r.ok) { log('⚠ 领取 Sand 资格：' + (r.msg || '失败')); return r; }
    if (r.outcome === 'card_required') {
      log('⚠ ' + (rec.email || '该账号') + '：免费号需先绑卡，已打开验证链接');
      if (r.url) shell.openExternal(r.url).catch(() => { /* ignore */ });
    } else {
      log((r.granted ? '✅ ' : 'ℹ ') + (rec.email || '该账号') + '：' + r.msg);
    }
    return r;
  } catch (e) { log('❌ 领取 Sand 资格失败：' + e.message); return { ok: false, msg: e.message }; }
});

// 轻量额度（列表行懒加载）：套餐 + 总/Auto/API/Grok 百分比
ipcMain.handle('accounts:usage', async (_e, id) => {
  const rec = store.tokenById(id);
  if (!rec) return { ok: false, msg: '账号不存在' };
  try { return await cursor.fetchUsageBrief(rec.token); }
  catch (e) { return { ok: false, msg: e.message }; }
});

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

// 打开该账号的额度页：用 token 注入登录态，内嵌浏览器（webview）只给看官网 Usage / Spending 两个页面，
// 并隐藏 Cursor 左侧的其它菜单 + 左下角账号信息。等同「用 token 登录网页」，但客户只看得到额度这两页。
ipcMain.handle('accounts:openUsage', async (_e, id) => {
  const rec = store.tokenById(id);
  if (!rec) return { ok: false, msg: '账号不存在（可能已删除）' };
  const token = cursor.normalizeToken(rec.token);
  const title = rec.email || '账号';
  const part = `uv-${id}-${Date.now()}`;   // 每次用独立内存分区注入该号 cookie，避免多账号串登录态
  try {
    const ses = session.fromPartition(part);
    await ses.cookies.set({
      url: 'https://cursor.com', name: 'WorkosCursorSessionToken',
      value: encodeURIComponent(token), domain: '.cursor.com', path: '/',
      secure: true, httpOnly: true, sameSite: 'no_restriction',
      expirationDate: Math.floor(Date.now() / 1000) + 86400,
    });
  } catch (e) { log('⚠ 注入登录态失败：' + e.message); }
  const uw = new BrowserWindow({
    width: 1120, height: 820, title: `额度 · ${title}`, backgroundColor: '#ffffff',
    parent: win, autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, webviewTag: true },
  });
  uw.setMenuBarVisibility(false);
  const q = 'part=' + encodeURIComponent(part) + '&email=' + encodeURIComponent(title);
  uw.loadFile(path.join(__dirname, 'renderer', 'usageview.html'), { search: q });
  log(`🌐 已用 ${title} 的登录态打开额度页（Usage / Spending）`);
  return { ok: true };
});

// ---------- 本机 Cursor 补丁（Sand Stream 客户端模式）----------
function friendlyPatchErr(e) {
  const m = (e && e.message) || String(e);
  if (/EPERM|EACCES|EROFS|permission|拒绝访问|denied|read-only/i.test(m)) {
    if (process.platform === 'darwin') {
      return m + '（写入 Cursor.app 需要权限：若 Cursor 装在 /Applications，请以管理员权限运行本工具，或把 Cursor 移到「~/Applications」后重试）';
    }
    return m + '（写入 Cursor 目录需要权限：请先完全退出 Cursor，并以管理员身份运行本工具后重试）';
  }
  return m;
}

// withProcesses=false 时 3ms 返回（文件级 + 布局缓存），界面轮询用；带进程数要跑一次 tasklist（~0.5s）
ipcMain.handle('patch:status', (_e, opts) => {
  try { return patchEngine.patchStatus(opts || {}); }
  catch (e) { return { ok: false, error: (e && e.message) || String(e) }; }
});

ipcMain.handle('patch:setPath', (_e, p) => {
  try { return patchEngine.setCursorPath(p || ''); }
  catch (e) { return { ok: false, error: (e && e.message) || String(e) }; }
});

// 结构化事件（step / log / progress）转发给界面的「实时会话」面板；同时保留旧 patch-progress 通道
function patchEventSink() {
  return (ev) => { try { if (win) win.webContents.send('patch-event', ev); } catch (e) { /* ignore */ } };
}
const patchProgressSink = (percent, message) => { try { if (win) win.webContents.send('patch-progress', { percent, message }); } catch (e) { /* ignore */ } };

ipcMain.handle('patch:apply', async () => {
  try {
    log('⏳ 正在给本机 Cursor 打 Sand 补丁（会自动关闭并重启 Cursor）…');
    const r = await patchEngine.applyPatch({
      preferStream: getStreamDirect(),   // 用户开关：Stream 直连 or 基础模式
      onEvent: patchEventSink(),
      onProgress: patchProgressSink,
      // HTTP 兼容模式静默切到 HTTP/2（用户无感知，不在日志中提示）
      beforeStart: async () => { try { http2.setHttp2(true); } catch (e) { /* 静默处理 */ } },
    });
    const mode = r.streamMode
      ? 'Stream 模式已生效'
      : '基础模式已生效' + (r.streamReason ? '（' + r.streamReason + '）' : '');
    log('✅ 补丁完成' + (r.noop ? '（已是最新，无需改动）' : `（改写 ${(r.files || []).length} 个文件）`) + '。Cursor 已重启，' + mode + '。');
    return { ok: true, streamMode: !!r.streamMode, basicMode: !!r.basicMode, noop: !!r.noop, files: r.files || [], streamReason: r.streamReason || '', elapsedMs: r.elapsedMs || 0 };
  } catch (e) {
    const msg = friendlyPatchErr(e);
    log('❌ 打补丁失败：' + msg);
    try { if (win) win.webContents.send('patch-event', { type: 'error', text: msg }); } catch (e2) { /* ignore */ }
    return { ok: false, msg };
  }
});

ipcMain.handle('patch:restore', async () => {
  try {
    log('⏳ 正在回退本机 Cursor 补丁（会自动关闭并重启 Cursor）…');
    const r = await patchEngine.restorePatch({ onEvent: patchEventSink(), onProgress: patchProgressSink });
    log('✅ 已回退补丁' + (r.noop ? '（本机没有补丁，无需改动）' : `（还原 ${(r.files || []).length} 个文件）`) + '。Cursor 已重启。');
    return { ok: true, noop: !!r.noop, files: r.files || [], elapsedMs: r.elapsedMs || 0 };
  } catch (e) {
    const msg = friendlyPatchErr(e);
    log('❌ 回退失败：' + msg);
    try { if (win) win.webContents.send('patch-event', { type: 'error', text: msg }); } catch (e2) { /* ignore */ }
    return { ok: false, msg };
  }
});

ipcMain.handle('patch:openFolder', (_e, p) => {
  try { if (p && fs.existsSync(p)) { shell.showItemInFolder(p); return { ok: true }; } } catch (e) { /* ignore */ }
  return { ok: false };
});

// 上一次打补丁/卸载的完整会话（步骤/日志/逐文件），界面启动后回放，不再一直「待命」
ipcMain.handle('patch:lastSession', () => {
  try { return patchEngine.loadLastSession(); } catch (e) { return null; }
});
// 某个目标文件「改了哪几处」：按 marker 定位每处改动并带上下文
ipcMain.handle('patch:fileChanges', (_e, rel) => {
  try { return patchEngine.fileChanges(String(rel || '')); }
  catch (e) { return { ok: false, error: (e && e.message) || String(e) }; }
});
// 在资源管理器 / Finder 里定位某个目标文件
ipcMain.handle('patch:revealFile', (_e, rel) => {
  try { const abs = patchEngine.resolveTargetAbs(String(rel || '')); shell.showItemInFolder(abs); return { ok: true, abs }; }
  catch (e) { return { ok: false, error: (e && e.message) || String(e) }; }
});

// ---------- 偏好：禁止 Cursor 自动更新开关（默认开启）----------
function prefsPath() { return path.join(app.getPath('userData'), 'prefs.json'); }
function readPrefs() { try { return JSON.parse(fs.readFileSync(prefsPath(), 'utf8')); } catch { return {}; } }
function writePrefs(o) { try { fs.mkdirSync(path.dirname(prefsPath()), { recursive: true }); fs.writeFileSync(prefsPath(), JSON.stringify(o, null, 2)); } catch { /* ignore */ } }
function getBlockUpdate() { return readPrefs().blockCursorUpdate !== false; }   // 未设置过默认视为 true

ipcMain.handle('prefs:getBlockUpdate', () => getBlockUpdate());
ipcMain.handle('prefs:setBlockUpdate', (_e, on) => {
  const p = readPrefs(); p.blockCursorUpdate = !!on; writePrefs(p);
  let applied = false;
  try { applied = cursorSettings.setAutoUpdateBlocked(!!on).ok; } catch (e) { /* ignore */ }
  log(on ? '🔒 已禁止 Cursor 自动更新（update.mode=none，重启 Cursor 后生效）' : '🔓 已恢复 Cursor 自动更新');
  return { ok: true, applied };
});

// Stream 直连模式偏好（默认开）：关闭=基础模式，可用 grok-4.6-xhigh-fast 等 Composer 模型
function getStreamDirect() { return readPrefs().streamDirect !== false; }
ipcMain.handle('prefs:getStreamDirect', () => getStreamDirect());
ipcMain.handle('prefs:setStreamDirect', (_e, on) => {
  const p = readPrefs(); p.streamDirect = !!on; writePrefs(p);
  log(on ? '⚡ 已选择 Stream 直连模式（点「打补丁」后生效）' : '🧩 已选择基础模式：可用 Composer 模型（如 grok-4.6-xhigh-fast），点「打补丁」后生效');
  return { ok: true };
});
