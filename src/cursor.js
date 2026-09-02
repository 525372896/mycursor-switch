'use strict';
// Cursor 换号核心：与 CursorManager/CursorClientLogin.cs 完全同一套路子，移植到 Node、跨 Windows/macOS。
//
// 换号 = 三步：
//   1) 深链握手（纯网络）：拿账号会话 token 调 cursor.com/api/auth/loginDeepCallbackControl + 轮询
//      api2.cursor.sh/auth/poll，为「本机 + 该账号」登记一次登录，换回桌面 access/refresh/authId。
//      这步必须做，否则换完 Cursor 聊天会报 “Authentication error, log out and back in”。
//   2) 关掉 Cursor → 等库解锁 → 把 cursorAuth/* 写进 state.vscdb（SQLite）。
//   3) 重启 Cursor。
// userId 必须和 access/refresh 是同一个号（用 poll 返回的 authId，或从 JWT 的 sub 兜底），否则身份不一致被拒。

const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile, spawn } = require('child_process');
const { shell } = require('electron');   // 用 shell.openPath 启动 Cursor，避免弹出黑色 cmd 窗口

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';

// ---------- token 规范化 / 解析 ----------

function normalizeToken(raw) {
  raw = (raw || '').trim();
  const marker = 'WorkosCursorSessionToken=';
  const idx = raw.indexOf(marker);
  if (idx >= 0) {
    raw = raw.slice(idx + marker.length);
    const semi = raw.indexOf(';');
    if (semi >= 0) raw = raw.slice(0, semi);
    raw = raw.trim();
  }
  if (raw.includes('%')) {
    try { raw = decodeURIComponent(raw); } catch { /* ignore */ }
  }
  return raw.trim();
}

const jwtOf = (t) => (t.includes('::') ? t.slice(t.indexOf('::') + 2) : t);
const subOf = (t) => (t.includes('::') ? t.slice(0, t.indexOf('::')) : '');

function base64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function subFromJwt(jwt) {
  try {
    const parts = (jwt || '').split('.');
    if (parts.length < 2) return '';
    let payload = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    while (payload.length % 4) payload += '=';
    const obj = JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
    let sub = obj.sub || '';
    return sub.startsWith('auth0|') ? sub.slice('auth0|'.length) : sub;
  } catch { return ''; }
}

function cookieHeader(token) {
  return 'WorkosCursorSessionToken=' + encodeURIComponent(token);
}

// ---------- 校验 token（加号时用）：GET /api/auth/me 拿邮箱 ----------

async function validateToken(rawToken) {
  const token = normalizeToken(rawToken);
  if (!token) return { ok: false, msg: 'token 为空' };
  try {
    const resp = await fetch('https://cursor.com/api/auth/me', {
      method: 'GET',
      headers: { 'User-Agent': UA, 'Accept': '*/*', 'Cookie': cookieHeader(token) },
      redirect: 'follow',
    });
    const finalUrl = resp.url || '';
    const loginRedirect = /workos|\/authorize|authenticator\.cursor|\/login/i.test(finalUrl);
    if (resp.status === 401 || resp.status === 403 || loginRedirect) {
      return { ok: false, msg: 'token 无效或已失效（被要求重新登录）' };
    }
    let email = '';
    try {
      const data = await resp.json();
      email = data.email || (data.user && data.user.email) || data.userEmail || '';
    } catch { /* 非 JSON 也算通过，只是拿不到邮箱 */ }
    if (resp.ok) return { ok: true, email, token };
    return { ok: false, msg: `校验失败（HTTP ${resp.status}）` };
  } catch (e) {
    return { ok: false, msg: '连不上 cursor.com：' + e.message + '（需要能访问外网/科学上网）' };
  }
}

// ---------- 读取额度（自助「只读额度页」用）：调 dashboard 用量接口，返回结构化数据 ----------

function num(x) { return typeof x === 'number' ? x : (x != null && x !== '' && !isNaN(+x) ? +x : null); }

async function fetchUsage(rawToken) {
  const token = normalizeToken(rawToken);
  if (!token) return { ok: false, msg: 'token 为空' };
  const H = { 'User-Agent': UA, 'Accept': '*/*', 'Cookie': cookieHeader(token) };
  const HJ = { ...H, 'Content-Type': 'application/json', 'Origin': 'https://cursor.com', 'Referer': 'https://cursor.com/dashboard' };
  const out = { ok: true, email: '', membership: '', resetAt: '', usage: null, onDemand: null, grok: null };
  // 先用 /api/auth/me 校验登录态（顺便拿邮箱）；失效直接返回，让界面提示
  try {
    const me = await fetch('https://cursor.com/api/auth/me', { headers: H, redirect: 'follow' });
    const finalUrl = me.url || '';
    if (me.status === 401 || me.status === 403 || /workos|\/authorize|\/login/i.test(finalUrl)) {
      return { ok: false, msg: 'token 已失效（被要求重新登录）' };
    }
    if (me.ok) { const d = await me.json().catch(() => ({})); out.email = d.email || (d.user && d.user.email) || d.userEmail || ''; }
  } catch (e) {
    return { ok: false, msg: '连不上 cursor.com：' + e.message + '（需要能访问外网/科学上网）' };
  }
  // 本期用量（总用量% + Auto/API + 金额）
  try {
    const r = await fetch('https://cursor.com/api/dashboard/get-current-period-usage', { method: 'POST', headers: HJ, body: '{}' });
    const d = await r.json().catch(() => ({}));
    const pu = d && d.planUsage;
    if (pu) out.usage = {
      total: num(pu.totalPercentUsed), auto: num(pu.autoPercentUsed), api: num(pu.apiPercentUsed),
      totalSpend: num(pu.totalSpend), includedSpend: num(pu.includedSpend), limit: num(pu.limit), remaining: num(pu.remaining),
    };
  } catch { /* 单项失败不影响其它 */ }
  // 套餐类型 + 额度重置日 + On-Demand
  try {
    const r = await fetch('https://cursor.com/api/usage-summary', { headers: H });
    const d = await r.json().catch(() => ({}));
    out.membership = d.membershipType || '';
    out.resetAt = d.billingCycleEnd || '';
    const iu = d.individualUsage || {};
    if (iu.onDemand) out.onDemand = { used: num(iu.onDemand.used), limit: num(iu.onDemand.limit), enabled: iu.onDemand.enabled !== false };
  } catch { /* 忽略 */ }
  // Grok Bot 额度（有这块才返回；含试用/周期两种）
  try {
    const r = await fetch('https://cursor.com/api/dashboard/get-sand-usage-status', { method: 'POST', headers: HJ, body: '{}' });
    const d = await r.json().catch(() => ({}));
    const has = ('usagePercent' in d) || ('hasAvailableUsage' in d) || (typeof d.sandTrialExpiresAt === 'string') || (d.includedLimitZero === false) || (d.hasNonZeroIncludedLimit === true);
    if (has) out.grok = {
      usagePercent: num(d.usagePercent), hasAvailable: d.hasAvailableUsage !== false,
      trial: typeof d.sandTrialExpiresAt === 'string', resetAt: d.sandTrialExpiresAt || d.nextResetTimestampUtc || '',
      label: d.grokPlanLabel || 'Grok Bot',
    };
  } catch { /* 忽略 */ }
  // 用量明细（官网 dashboard/usage：近 30 天最多 50 条，按模型/时间的 token 与费用）
  try {
    const end = Date.now(), start = end - 30 * 86400000;
    const body = JSON.stringify({ teamId: 0, startDate: String(start), endDate: String(end), page: 1, pageSize: 50 });
    const r = await fetch('https://cursor.com/api/dashboard/get-filtered-usage-events', { method: 'POST', headers: HJ, body });
    const d = await r.json().catch(() => ({}));
    const arr = Array.isArray(d.usageEventsDisplay) ? d.usageEventsDisplay : [];
    out.events = arr.map((ev) => {
      const tu = ev.tokenUsage || {};
      const tokens = (num(tu.inputTokens) || 0) + (num(tu.outputTokens) || 0) + (num(tu.cacheReadTokens) || 0);
      const ubc = String(ev.usageBasedCosts || '').replace('$', '').trim();
      const costCents = (ubc && ubc !== '-' && !isNaN(+ubc)) ? +ubc * 100 : 0;   // >0=走超额实扣；0=含在套餐(Included)
      return { ts: num(ev.timestamp), model: ev.model || '', kind: ev.kind || '', tokens, costCents };
    });
    out.eventsTotal = num(d.totalUsageEventsCount) || out.events.length;
  } catch { /* 忽略 */ }
  return out;
}

// ---------- 轻量额度（列表行懒加载用）：只取套餐 + 总/Auto/API/Grok 百分比，够画一行额度条 ----------
async function fetchUsageBrief(rawToken) {
  const token = normalizeToken(rawToken);
  if (!token) return { ok: false, msg: 'token 为空' };
  const H = { 'User-Agent': UA, 'Accept': '*/*', 'Cookie': cookieHeader(token) };
  const HJ = { ...H, 'Content-Type': 'application/json', 'Origin': 'https://cursor.com', 'Referer': 'https://cursor.com/dashboard' };
  const out = { ok: true, membership: '', total: null, auto: null, api: null, grok: null };
  // 套餐（顺便当登录态探测）
  try {
    const r = await fetch('https://cursor.com/api/usage-summary', { headers: H, redirect: 'follow' });
    if (r.status === 401 || r.status === 403 || /workos|\/authorize|\/login/i.test(r.url || '')) {
      return { ok: false, msg: 'token 已失效' };
    }
    const d = await r.json().catch(() => ({}));
    out.membership = d.membershipType || '';
  } catch (e) {
    return { ok: false, msg: '连不上 cursor.com' };
  }
  // 本期用量：总% / Auto% / API%
  try {
    const r = await fetch('https://cursor.com/api/dashboard/get-current-period-usage', { method: 'POST', headers: HJ, body: '{}' });
    const d = await r.json().catch(() => ({}));
    const pu = d && d.planUsage;
    if (pu) { out.total = num(pu.totalPercentUsed); out.auto = num(pu.autoPercentUsed); out.api = num(pu.apiPercentUsed); }
  } catch { /* 单项失败不影响其它 */ }
  // Grok Bot 用量%
  try {
    const r = await fetch('https://cursor.com/api/dashboard/get-sand-usage-status', { method: 'POST', headers: HJ, body: '{}' });
    const d = await r.json().catch(() => ({}));
    if ('usagePercent' in d) out.grok = num(d.usagePercent);
  } catch { /* 忽略 */ }
  return out;
}

// ---------- 深链握手（换号时用）：登记本机登录并取回桌面 access/refresh/authId ----------

async function exchangeSession(fullToken, log) {
  try {
    const jwt = jwtOf(fullToken);
    let sub = subFromJwt(jwt);
    if (!sub) sub = subOf(fullToken);
    const cookieToken = (sub ? sub + '::' : '') + jwt;

    const verifier = base64url(crypto.randomBytes(32));
    const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
    const uuid = crypto.randomUUID();

    // 1) 无头授权 uuid（等价于浏览器在 loginDeepControl 页确认这次登录）
    const cb = await fetch('https://cursor.com/api/auth/loginDeepCallbackControl', {
      method: 'POST',
      headers: {
        'User-Agent': UA,
        'Content-Type': 'application/json',
        'Cookie': cookieHeader(cookieToken),
        'Origin': 'https://cursor.com',
        'Referer': 'https://cursor.com/loginDeepControl',
      },
      body: JSON.stringify({ uuid, challenge, mode: 'login' }),
    });
    if (!cb.ok) { log && log(`深链授权失败（HTTP ${cb.status}）`); return null; }

    // 2) 轮询取回 access/refresh（404=还没就绪，退避重试）
    for (let i = 0; i < 8; i++) {
      const pl = await fetch('https://api2.cursor.sh/auth/poll', {
        method: 'POST',
        headers: { 'User-Agent': UA, 'Content-Type': 'application/json' },
        body: JSON.stringify({ uuid, verifier }),
      });
      if (pl.status === 404) { await sleep(1200); continue; }
      if (!pl.ok) { log && log(`轮询失败（HTTP ${pl.status}）`); return null; }
      const data = await pl.json();
      const access = data.accessToken || '';
      let refresh = data.refreshToken || '';
      const authId = data.authId || '';
      if (!access) return null;
      if (!refresh) refresh = access;
      return { access, refresh, authId };
    }
    log && log('深链握手轮询超时');
    return null;
  } catch (e) {
    log && log('深链握手异常：' + e.message);
    return null;
  }
}

// ---------- 写 Cursor 本地库 state.vscdb ----------

function stateDbPath() {
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
      'Cursor', 'User', 'globalStorage', 'state.vscdb');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'state.vscdb');
  }
  return path.join(os.homedir(), '.config', 'Cursor', 'User', 'globalStorage', 'state.vscdb');
}

function stateDbExists() {
  try { return fs.existsSync(stateDbPath()); } catch { return false; }
}

// 把 token/身份字段整套一致地写进 state.vscdb。算出就写新值，算不出就把旧值删掉，绝不留半套旧身份。
function writeKeys(accessToken, refreshToken, userId, email) {
  const dbPath = stateDbPath();
  if (!fs.existsSync(dbPath)) {
    throw new Error('找不到 Cursor 的 state.vscdb，确认本机装了 Cursor 且登录过一次。');
  }
  const Database = require('better-sqlite3');
  const db = new Database(dbPath);
  try {
    db.exec('CREATE TABLE IF NOT EXISTS ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)');
    const set = [
      ['cursorAuth/accessToken', accessToken],
      ['cursorAuth/refreshToken', refreshToken],
      ['cursorAuth/cachedSignUpType', 'Auth_0'],
    ];
    if (email) set.push(['cursorAuth/cachedEmail', email]);
    if (userId) set.push(['cursorAuth/userId', userId]);

    const del = ['cursorAuth/stripeMembershipType', 'cursorAuth/stripeSubscriptionStatus'];
    if (!userId) del.push('cursorAuth/userId');
    if (!email) del.push('cursorAuth/cachedEmail');

    const put = db.prepare('INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)');
    const rm = db.prepare('DELETE FROM ItemTable WHERE key = ?');
    const tx = db.transaction(() => {
      for (const [k, v] of set) put.run(k, v);
      for (const k of del) rm.run(k);
    });
    tx();
  } finally {
    db.close();
  }
}

function isDbLocked() {
  const dbPath = stateDbPath();
  const Database = require('better-sqlite3');
  let db;
  try {
    db = new Database(dbPath, { timeout: 100 });
    db.prepare('SELECT count(*) FROM sqlite_master').get();
    return false;
  } catch { return true; }
  finally { try { db && db.close(); } catch { /* ignore */ } }
}

// ---------- 关 / 开 Cursor ----------

function run(cmd, args) {
  return new Promise((resolve) => {
    try { execFile(cmd, args, { timeout: 8000, windowsHide: true }, () => resolve()); }
    catch { resolve(); }
  });
}

// Windows：查正在运行的 Cursor.exe 完整路径（换号后按原路径重启，避免装在非标准位置找不到而弹黑框）
function winCursorPath() {
  return new Promise((resolve) => {
    try {
      execFile('powershell',
        ['-NoProfile', '-Command', '(Get-Process Cursor -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Path)'],
        { timeout: 6000, windowsHide: true },
        (err, stdout) => { const p = (stdout || '').trim(); resolve(p && fs.existsSync(p) ? p : null); });
    } catch { resolve(null); }
  });
}

async function killCursor() {
  if (process.platform === 'win32') {
    await run('taskkill', ['/F', '/IM', 'Cursor.exe']);
  } else if (process.platform === 'darwin') {
    await run('osascript', ['-e', 'tell application "Cursor" to quit']);
    await sleep(600);
    await run('pkill', ['-x', 'Cursor']);
  } else {
    await run('pkill', ['-f', 'cursor']);
  }
  await sleep(800);
}

function findCursorExeWin() {
  const local = process.env.LOCALAPPDATA || '';
  const pf = process.env.ProgramFiles || 'C:\\Program Files';
  const cands = [
    local && path.join(local, 'Programs', 'cursor', 'Cursor.exe'),
    path.join(pf, 'Cursor', 'Cursor.exe'),
    'D:\\cursor\\Cursor.exe',
  ].filter(Boolean);
  for (const c of cands) { try { if (fs.existsSync(c)) return c; } catch { /* ignore */ } }
  return null;
}

async function launchCursor(preferWinExe) {
  try {
    if (process.platform === 'win32') {
      const exe = preferWinExe || findCursorExeWin();
      if (exe) {
        try { await shell.openPath(exe); }   // 用系统关联打开 exe，不弹 cmd 黑框
        catch { spawn(exe, [], { detached: true, stdio: 'ignore', windowsHide: true }).unref(); }
        return true;
      }
      return false;   // 找不到 Cursor 就不强开（绝不再 cmd/start 弹黑框），用户手动打开即可
    }
    if (process.platform === 'darwin') { await run('open', ['-a', 'Cursor']); return true; }
    spawn('cursor', [], { detached: true, stdio: 'ignore' }).unref();
    return true;
  } catch { return false; }
}

// ---------- 换号主流程 ----------

async function switchAccount(fullToken, email, log) {
  const token = normalizeToken(fullToken);

  // 1) 深链握手（纯网络，Cursor 可还开着）
  let access, refresh, userId, handshakeOk;
  const pair = await exchangeSession(token, log);
  if (pair) {
    handshakeOk = true;
    access = pair.access; refresh = pair.refresh;
    const sub = subFromJwt(access);
    userId = pair.authId ? pair.authId : (sub ? 'auth0|' + sub : '');
  } else {
    handshakeOk = false;
    log && log('⚠ 深链握手失败，退回直接写会话令牌（若聊天报错请在 Cursor 里手动重新登录一次）。');
    access = refresh = jwtOf(token);
    let sub = subFromJwt(access); if (!sub) sub = subOf(token);
    userId = sub ? 'auth0|' + sub : '';
  }

  // 2) 关 Cursor → 等库解锁 → 写库（先记住正在运行的 Cursor 路径，换完按原路径重启）
  let winExe = null;
  if (process.platform === 'win32') { try { winExe = await winCursorPath(); } catch { /* ignore */ } }
  await killCursor();
  for (let i = 0; i < 6 && isDbLocked(); i++) await sleep(300);
  writeKeys(access, refresh, userId, email || '');

  // 3) 重启
  await launchCursor(winExe);
  return {
    ok: true,
    handshakeOk,
    msg: handshakeOk
      ? `已切换到 ${email || '该账号'} 并重启 Cursor（已完成登录握手，聊天可直接用）。`
      : `已切换到 ${email || '该账号'} 并重启（握手失败，若聊天报 auth error 请在 Cursor 里手动重登一次）。`,
  };
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

module.exports = {
  normalizeToken, validateToken, fetchUsage, fetchUsageBrief, exchangeSession, switchAccount,
  stateDbPath, stateDbExists,
};
