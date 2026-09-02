'use strict';
// 打补丁后自动把 Cursor 的「HTTP Compatibility Mode」设为 HTTP/2（用户无感知）。
// Cursor 该设置对应用户 settings.json 里的键：cursor.general.disableHttp2
//   true  = 强制 HTTP/1.1
//   false / 缺省 = HTTP/2
// 因此「启用 HTTP/2」= 写 "cursor.general.disableHttp2": false。
// 采用最小侵入编辑：能只改这一个键就不整体重写，尽量保留用户其它设置与注释。

const os = require('os');
const fs = require('fs');
const path = require('path');

const KEY = 'cursor.general.disableHttp2';

function settingsPath() {
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Cursor', 'User', 'settings.json');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Cursor', 'User', 'settings.json');
  }
  return path.join(os.homedir(), '.config', 'Cursor', 'User', 'settings.json');
}

// enableHttp2=true -> disableHttp2:false；false -> disableHttp2:true
// customPath 仅用于单元测试；生产不传，走本机 settings.json。
function setHttp2(enableHttp2 = true, customPath) {
  const p = customPath || settingsPath();
  const targetVal = enableHttp2 ? 'false' : 'true';
  let raw = '';
  try { raw = fs.readFileSync(p, 'utf8'); } catch { raw = ''; }

  const keyRe = new RegExp('("' + KEY.replace(/\./g, '\\.') + '"\\s*:\\s*)(true|false)');

  let next;
  if (!raw.trim()) {
    next = '{\n  "' + KEY + '": ' + targetVal + '\n}\n';
  } else if (keyRe.test(raw)) {
    const m = raw.match(keyRe);
    if (m && m[2] === targetVal) return { ok: true, path: p, changed: false }; // 已是目标值
    next = raw.replace(keyRe, '$1' + targetVal);
  } else {
    // 在第一个 { 后插入该键
    const idx = raw.indexOf('{');
    if (idx < 0) {
      next = '{\n  "' + KEY + '": ' + targetVal + '\n}\n';
    } else {
      const head = raw.slice(0, idx + 1);
      const tail = raw.slice(idx + 1);
      const insert = '\n  "' + KEY + '": ' + targetVal + ',';
      next = head + insert + tail;
    }
  }

  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const tmp = p + '.sandtmp-' + process.pid + '-' + Date.now();
    fs.writeFileSync(tmp, next, 'utf8');
    try { fs.renameSync(tmp, p); }
    catch (e) { try { fs.chmodSync(p, 0o666); } catch { /* ignore */ } fs.renameSync(tmp, p); }
    return { ok: true, path: p, changed: true };
  } catch (e) {
    return { ok: false, path: p, error: e.message };
  }
}

module.exports = { setHttp2, settingsPath, KEY };
