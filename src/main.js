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

// 打开该账号的「只读额度页」：用 token 拉额度后，弹一个只展示数字的小窗（不进 Cursor 后台、无任何操作）
ipcMain.handle('accounts:openUsage', async (_e, id) => {
  const rec = store.tokenById(id);
  if (!rec) return { ok: false, msg: '账号不存在（可能已删除）' };
  log(`📊 正在读取 ${rec.email || '该账号'} 的额度…`);
  let u;
  try { u = await cursor.fetchUsage(rec.token); }
  catch (e) { log('❌ 读取额度失败：' + e.message); return { ok: false, msg: e.message }; }
  if (!u || u.ok === false) { log('⚠ 读取额度失败：' + ((u && u.msg) || '')); return { ok: false, msg: u && u.msg }; }
  const title = rec.email || u.email || '账号';
  const html = buildUsageHtml(title, u);
  const uw = new BrowserWindow({
    width: 560, height: 780, title: `额度 · ${title}`, backgroundColor: '#0f1729',
    parent: win, autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  uw.setMenuBarVisibility(false);
  uw.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  log(`✅ 已打开 ${title} 的额度页（只读）`);
  return { ok: true };
});

// 生成「只读额度页」HTML（自包含：内联样式 + 数据，纯展示，不含任何可操作按钮）
// 分两段对齐官网：① 额度概览（Spending：Cursor Models / Other Models / Grok Bot / On-Demand）② 用量明细（Usage：按模型/时间的 token 与费用）
function buildUsageHtml(email, u) {
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const pctColor = (p) => p == null ? '#8ea0c8' : p >= 90 ? '#ef4444' : p >= 70 ? '#f59e0b' : '#10b981';
  const money = (cents) => cents == null ? '—' : '$' + (cents / 100).toFixed(2);
  const fmtDate = (iso) => { if (!iso) return '—'; const d = new Date(iso); return isNaN(d.getTime()) ? '—' : d.toLocaleString('zh-CN', { hour12: false }); };
  const fmtShort = (ms) => { if (!ms) return '—'; const d = new Date(ms); return isNaN(d.getTime()) ? '—' : d.toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }); };
  const daysLeft = (iso) => { if (!iso) return null; const d = new Date(iso); if (isNaN(d.getTime())) return null; return Math.ceil((d.getTime() - Date.now()) / 86400000); };
  const tk = (n) => !n ? '—' : (n >= 10000 ? (n / 10000).toFixed(1) + '万' : String(n));
  const bar = (p) => `<div class="bar"><i style="width:${Math.max(2, Math.min(100, p == null ? 0 : p))}%;background:${pctColor(p)}"></i></div>`;
  const line = (title, pct, sub) => `<div class="c"><div class="ct"><span>${title}</span><span class="cv" style="color:${pctColor(pct)}">${pct == null ? '—' : pct.toFixed(0) + '% used'}</span></div>${bar(pct)}${sub ? `<div class="sub">${sub}</div>` : ''}</div>`;

  const usage = u.usage || {};
  const includedPct = (usage.limit && usage.limit > 0 && usage.totalSpend != null) ? Math.round(1000 * usage.totalSpend / usage.limit) / 10 : null;
  const grok = u.grok, od = u.onDemand;

  // ① 额度概览（对齐官网 Spending）
  let overview = '';
  if (usage.auto != null) overview += line('Cursor Models · 含 Cursor Grok / Composer', usage.auto);
  if (usage.api != null) overview += line('Other Models · Claude / GPT 等', usage.api);
  if (includedPct != null) overview += line('含额度使用率', includedPct, `已用 ${money(usage.totalSpend)} / 上限 ${money(usage.limit)}${usage.remaining != null ? ' · 剩余 ' + money(usage.remaining) : ''}`);
  if (grok) {
    const dl = daysLeft(grok.resetAt);
    overview += line(`🤖 ${esc(grok.label)}${grok.trial ? ' · 试用' : ' · 周额度'}`, grok.usagePercent, `${grok.hasAvailable === false ? '已用完' : '可用'}${grok.resetAt ? ' · ' + (grok.trial ? '试用到期 ' : '重置 ') + fmtDate(grok.resetAt) + (dl != null && dl >= 0 ? `（还剩 ${dl} 天）` : '') : ''}`);
  }
  if (od) overview += `<div class="c"><div class="ct"><span>On-Demand 超额</span><span class="cv">${od.enabled ? money(od.used) + (od.limit != null ? ' / ' + money(od.limit) : ' / 无限') : 'Disabled'}</span></div><div class="sub">${od.enabled ? '已开启' : '未开启（超额已关闭）'}</div></div>`;
  if (!overview) overview = '<div class="empty">未读取到额度概览（可能是免费号）。</div>';

  // ② 用量明细（对齐官网 Usage）
  const evs = u.events || [];
  let detail;
  if (evs.length) {
    const rows = evs.slice(0, 50).map((ev) => {
      const cost = ev.costCents > 0 ? '$' + (ev.costCents / 100).toFixed(2) : '<span class="inc">Included</span>';
      return `<tr><td>${fmtShort(ev.ts)}</td><td class="mdl" title="${esc(ev.model)}">${esc(ev.model)}</td><td class="num">${tk(ev.tokens)}</td><td class="num">${cost}</td></tr>`;
    }).join('');
    detail = `<table class="tbl"><thead><tr><th>时间</th><th>模型</th><th>Tokens</th><th>费用</th></tr></thead><tbody>${rows}</tbody></table>`;
  } else {
    detail = '<div class="empty">近 30 天暂无用量明细。</div>';
  }

  return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>额度</title><style>
*{box-sizing:border-box}body{margin:0;background:#0f1729;color:#e6ecff;font-family:"Segoe UI","Microsoft YaHei",-apple-system,sans-serif;font-size:14px;padding:16px}
.hd{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:12px}
.em{font-weight:700;font-size:16px;word-break:break-all}
.badge{font-size:12px;padding:2px 8px;border-radius:999px;background:#1b2748;border:1px solid #26324f;color:#8ea0c8}
.reset{color:#8ea0c8;font-size:12px}
.sec{font-size:12px;color:#7cc0ff;font-weight:700;margin:6px 2px 8px}
.c{background:#16203a;border:1px solid #26324f;border-radius:12px;padding:11px 13px;margin-bottom:9px}
.ct{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:13px;color:#b9c6e6;margin-bottom:8px}
.cv{font-weight:700;font-size:14px;color:#e6ecff;white-space:nowrap}
.bar{height:9px;background:#1b2748;border:1px solid #26324f;border-radius:6px;overflow:hidden}
.bar i{display:block;height:100%;border-radius:6px}
.sub{color:#8ea0c8;font-size:12px;margin-top:7px}
.empty{color:#8ea0c8;text-align:center;padding:22px}
.tblwrap{background:#16203a;border:1px solid #26324f;border-radius:12px;overflow:hidden}
.tbl{width:100%;border-collapse:collapse;font-size:12px}
.tbl th{text-align:left;color:#8ea0c8;font-weight:600;padding:7px 9px;border-bottom:1px solid #26324f}
.tbl td{padding:6px 9px;border-bottom:1px solid #1b2748;color:#d7e0f7}
.tbl tr:last-child td{border-bottom:none}
.tbl td.mdl{max-width:190px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:ui-monospace,Consolas,monospace}
.tbl td.num{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}
.tbl .inc{color:#10b981}
.foot{color:#59668c;font-size:11px;text-align:center;margin-top:10px}
</style></head><body>
<div class="hd"><span class="em">${esc(email)}</span>${u.membership ? `<span class="badge">${esc(u.membership)}</span>` : ''}${u.resetAt ? `<span class="reset">额度重置：${fmtDate(u.resetAt)}</span>` : ''}</div>
<div class="sec">额度概览（Spending）</div>
${overview}
<div class="sec" style="margin-top:14px">用量明细（Usage · 近30天最多50条，共 ${u.eventsTotal || evs.length} 条）</div>
<div class="tblwrap">${detail}</div>
<div class="foot">只读视图 · 数据来自 Cursor 官方接口</div>
</body></html>`;
}
