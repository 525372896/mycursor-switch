'use strict';
// 读写本机 Cursor 用户 settings.json 的若干键（用于「禁止 Cursor 自动更新」）。
// 用「JSON 感知的正则」逐键 upsert（只改这几个键的值），不整体 JSON.parse——因为 Cursor 的
// settings.json 允许注释/尾逗号（jsonc），整体解析会失败。
//   禁止自动更新：update.mode=none + update.enableWindowsBackgroundUpdates=false
//   恢复自动更新：update.mode=default + update.enableWindowsBackgroundUpdates=true

const os = require('os');
const fs = require('fs');
const path = require('path');

function settingsPath() {
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Cursor', 'User', 'settings.json');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Cursor', 'User', 'settings.json');
  }
  return path.join(os.homedir(), '.config', 'Cursor', 'User', 'settings.json');
}

function readText() {
  try { return fs.readFileSync(settingsPath(), 'utf8'); } catch { return ''; }
}

function writeText(txt) {
  const p = settingsPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + '.sandtmp-' + process.pid + '-' + Date.now();
  fs.writeFileSync(tmp, txt, 'utf8');
  try { fs.renameSync(tmp, p); }
  catch (e) { try { fs.chmodSync(p, 0o666); } catch { /* ignore */ } fs.renameSync(tmp, p); }
}

// 只改值不删键：键在就替换值，不在就插到第一个 { 后。valueLiteral 是 JSON 字面量（如 '"none"' / 'false'）。
function upsertKey(txt, key, valueLiteral) {
  const kr = new RegExp('("' + key.replace(/\./g, '\\.') + '"\\s*:\\s*)("[^"]*"|true|false|null|[\\d.]+)');
  if (kr.test(txt)) return txt.replace(kr, '$1' + valueLiteral);
  const idx = txt.indexOf('{');
  if (idx < 0) return '{\n  "' + key + '": ' + valueLiteral + '\n}\n';
  return txt.slice(0, idx + 1) + '\n  "' + key + '": ' + valueLiteral + ',' + txt.slice(idx + 1);
}

function setAutoUpdateBlocked(blocked) {
  let txt = readText();
  if (!txt.trim()) txt = '{\n}\n';
  const pairs = blocked
    ? [['update.mode', '"none"'], ['update.enableWindowsBackgroundUpdates', 'false']]
    : [['update.mode', '"default"'], ['update.enableWindowsBackgroundUpdates', 'true']];
  for (const [k, v] of pairs) txt = upsertKey(txt, k, v);
  try { writeText(txt); return { ok: true, path: settingsPath() }; }
  catch (e) { return { ok: false, error: e.message }; }
}

module.exports = { setAutoUpdateBlocked, settingsPath };
