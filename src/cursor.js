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
    try { execFile(cmd, args, { timeout: 8000 }, () => resolve()); }
    catch { resolve(); }
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

async function launchCursor() {
  try {
    if (process.platform === 'win32') {
      const exe = findCursorExeWin();
      if (exe) { spawn(exe, [], { detached: true, stdio: 'ignore' }).unref(); return true; }
      spawn('cmd', ['/c', 'start', '', 'cursor'], { detached: true, stdio: 'ignore', shell: false }).unref();
      return true;
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

  // 2) 关 Cursor → 等库解锁 → 写库
  await killCursor();
  for (let i = 0; i < 6 && isDbLocked(); i++) await sleep(300);
  writeKeys(access, refresh, userId, email || '');

  // 3) 重启
  await launchCursor();
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
  normalizeToken, validateToken, exchangeSession, switchAccount,
  stateDbPath, stateDbExists,
};
