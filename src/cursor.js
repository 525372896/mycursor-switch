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

// ---------- 领取 Sand 资格（让 free / 普通套餐号能用 bot 额度）----------
// 对齐 SandClaimer sand_api.py 的 claim 编排：已解锁/已授予→短路；团队号→团队通道；否则个人试用；免费号→需绑卡。
// 全程用会话 cookie 打 cursor.com/api/dashboard/*（写操作带 Origin 过 CSRF）；返回结构给 UI 展示。

// 从 token 里拿 user_id：优先 JWT sub，其次 token 里 :: 左边（ws token）
function userIdOf(rawToken) {
  const jwt = jwtOf(rawToken);
  const sub = subFromJwt(jwt);
  if (sub && ('user_' + '').length && String(sub).startsWith('user_')) return String(sub);
  const left = subOf(rawToken);
  if (left && String(left).startsWith('user_')) return String(left);
  return String(sub || '').startsWith('user_') ? String(sub) : (left || '');
}

async function claimSand(rawToken) {
  const token = normalizeToken(rawToken);
  if (!token) return { ok: false, msg: 'token 为空' };
  const jwt = jwtOf(token);
  const userId = userIdOf(token);
  if (!userId || !userId.startsWith('user_')) {
    return { ok: false, outcome: 'no_userid', msg: 'token 里没有 user_ id（可能是纯网页票），无法领取资格' };
  }
  const cookie = 'WorkosCursorSessionToken=' + userId + '::' + jwt;
  const H = { 'User-Agent': UA, 'Accept': 'application/json', 'Content-Type': 'application/json', 'Cookie': cookie, 'Origin': 'https://cursor.com', 'Referer': 'https://cursor.com/dashboard' };
  const post = async (url, body) => {
    const r = await fetch(url, { method: 'POST', headers: H, body: body || '{}' });
    const text = await r.text().catch(() => '');
    return { status: r.status, text };
  };
  try {
    // 1) 已解锁？（GetSandUsageStatus 走 api2，Bearer accessToken）
    try {
      const u = await fetch('https://api2.cursor.sh/aiserver.v1.DashboardService/GetSandUsageStatus', {
        method: 'POST', headers: { 'Authorization': 'Bearer ' + jwt, 'Content-Type': 'application/json', 'connect-protocol-version': '1' }, body: '{}',
      });
      if (u.ok) { const d = await u.json().catch(() => ({})); if (d.includedLimitZero !== true && d.hasNonZeroIncludedLimit === true) return { ok: true, outcome: 'already', granted: true, msg: '已开通 Sand 额度' }; }
    } catch { /* 查不到就继续走领取 */ }
    // 2) 已授予资格？
    const acc = await post('https://cursor.com/api/dashboard/get-sand-access-status');
    if (acc.status === 200) { let d = {}; try { d = JSON.parse(acc.text); } catch {} if (d.state === 'SAND_ACCESS_STATE_GRANTED') return { ok: true, outcome: 'already', granted: true, msg: '已授予 Sand 资格' }; }
    // 3) 团队号？走团队通道
    let teamId = null;
    const me = await post('https://cursor.com/api/dashboard/get-me');
    if (me.status === 200) { try { const d = JSON.parse(me.text); if (Number.isInteger(d.teamId) && d.teamId > 0) teamId = d.teamId; } catch {} }
    if (teamId != null) {
      const t = await post('https://cursor.com/api/dashboard/request-sand-team-access', JSON.stringify({ teamId }));
      if (t.status !== 200) return { ok: false, outcome: 'failed', msg: `团队领取失败（HTTP ${t.status}）` };
      try { await post('https://cursor.com/api/dashboard/update-team-sand-onboarding-completed', JSON.stringify({ teamId })); } catch { /* 幂等辅助 */ }
      return { ok: true, outcome: 'team_ok', granted: true, teamId, msg: '团队 Sand 资格已请求/开通' };
    }
    // 4) 个人试用；免费号需绑卡
    const tr = await post('https://cursor.com/api/dashboard/start-sand-trial');
    if (tr.status !== 200) return { ok: false, outcome: 'failed', msg: `领取失败（HTTP ${tr.status}）：${tr.text.slice(0, 120)}` };
    const low = tr.text.toLowerCase();
    if (low.includes('cardverificationrequired') || low.includes('card_verification')) {
      const m = /"(https:\/\/[^"]*(?:checkout|stripe)[^"]*)"/.exec(tr.text);
      return { ok: true, outcome: 'card_required', granted: false, url: m ? m[1] : '', msg: '免费账号需先验证信用卡' };
    }
    return { ok: true, outcome: 'activated', granted: true, msg: '个人 Sand 资格已开通' };
  } catch (e) {
    return { ok: false, outcome: 'error', msg: '连不上 cursor.com：' + e.message };
  }
}

// ---------- 模型探测：这个号在 sand 通道下实际能用哪些模型 ----------
// web token 先换 session（沿用 exchangeSession），再用 sand_client.probeModels 逐个真调用。
const SAND_PROBE_CANDIDATES = [
  'grok-4.6', 'grok-4.5', 'composer-2.5',
  'claude-fable-5', 'claude-opus-5', 'claude-opus-4-8', 'claude-opus-4-7',
  'claude-sonnet-5', 'claude-sonnet-4-6',
  'gpt-5', 'gpt-5-codex', 'o3', 'gemini-2.5-pro', 'gemini-2.5-flash',
];

async function probeSandModels(rawToken, models) {
  const token = normalizeToken(rawToken);
  if (!token) return { ok: false, msg: 'token 为空' };
  // 拿一个 session accessToken：web 票走深链换取；已是 session 直接用
  let access = jwtOf(token);
  try {
    const claims = JSON.parse(Buffer.from(access.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    if (String(claims.type || '').toLowerCase() !== 'session') {
      const pair = await exchangeSession(token, null);
      if (pair && pair.access) access = pair.access;
    }
  } catch { /* 解析失败就按原样试 */ }
  let sub = subFromJwt(access); if (!sub) sub = subOf(token);
  const { probeModels } = require('./sand_client');
  const { deviceIdentity, stableUuid } = require('./sand_checksum');
  const identity = stableUuid('sand-gateway', sub || access);
  const account = { accessToken: access, identity, device: deviceIdentity(identity, 'composer-api'), sessionId: crypto.randomUUID() };
  try {
    const r = await probeModels(account, Array.isArray(models) && models.length ? models : SAND_PROBE_CANDIDATES, { clientVersion: '0.18.0', timeoutMs: 45000, concurrency: 3 });
    return { ok: true, ...r };
  } catch (e) { return { ok: false, msg: e.message }; }
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

// 兜底定位 Cursor 可执行文件：复用补丁引擎的全套探测（注册表 + 用户设的自定义路径 + 各盘默认目录 +
// 运行进程）。解决「装在非标准盘（如 E:\cursor\cursor）且换号时 Cursor 已关闭 → 固定候选找不到 → 拉不起来」。
function resolveCursorExe() {
  try {
    const layout = require('./sand_patch_engine').resolveCursorLayout();
    if (layout && layout.executable && fs.existsSync(layout.executable)) return layout.executable;
  } catch { /* ignore */ }
  return null;
}

async function launchCursor(preferWinExe) {
  try {
    if (process.platform === 'win32') {
      const exe = preferWinExe || findCursorExeWin() || resolveCursorExe();
      if (exe && fs.existsSync(exe)) {
        try { await shell.openPath(exe); }   // 用系统关联打开 exe，不弹 cmd 黑框
        catch { spawn(exe, [], { detached: true, stdio: 'ignore', windowsHide: true }).unref(); }
        return true;
      }
      return false;   // 找不到 Cursor 就不强开（绝不再 cmd/start 弹黑框），用户手动打开即可
    }
    if (process.platform === 'darwin') {
      const exe = resolveCursorExe();   // 补丁引擎能定位到 Cursor.app 内的可执行
      if (exe) { spawn(exe, [], { detached: true, stdio: 'ignore' }).unref(); return true; }
      await run('open', ['-a', 'Cursor']); return true;
    }
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

  // 3) 重启（按真实结果反馈：拉起失败就提示手动打开，不再谎报已重启）
  const launched = await launchCursor(winExe);
  const startPart = launched ? '并已重启 Cursor' : '，但没能自动拉起 Cursor，请手动打开一次';
  const authPart = handshakeOk ? '（登录握手完成，聊天可直接用）' : '（握手失败，若聊天报 auth error 请在 Cursor 里手动重登一次）';
  return {
    ok: true,
    handshakeOk,
    launched,
    msg: `已切换到 ${email || '该账号'}${startPart}${authPart}。`,
  };
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

module.exports = {
  normalizeToken, validateToken, fetchUsage, fetchUsageBrief, claimSand, probeSandModels, exchangeSession, switchAccount,
  stateDbPath, stateDbExists, SAND_PROBE_CANDIDATES,
};
