'use strict';
// 本地账号存储：把用户加进来的账号（token/邮箱/时间）存到用户数据目录的 accounts.json。
// 完全本地、不联网、不依赖任何服务器 —— 每个用户自己管理自己的号。

const fs = require('fs');
const path = require('path');

let filePath = null;
function init(userDataDir) {
  filePath = path.join(userDataDir, 'accounts.json');
}

function readAll() {
  try {
    if (!filePath || !fs.existsSync(filePath)) return [];
    const arr = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

function writeAll(list) {
  try { fs.writeFileSync(filePath, JSON.stringify(list, null, 2), 'utf8'); } catch { /* ignore */ }
}

// 用 token 尾部做稳定 id（去重、删除定位用）
function idOf(token) {
  const t = (token || '').trim();
  return t.length > 16 ? t.slice(-16) : t;
}

function list() {
  return readAll().map((a) => ({ id: a.id, email: a.email || '', addedAt: a.addedAt || '', tokenTail: (a.token || '').slice(-8) }));
}

function add(token, email) {
  const list0 = readAll();
  const id = idOf(token);
  const now = new Date().toISOString();
  const idx = list0.findIndex((a) => a.id === id);
  const rec = { id, token, email: email || '', addedAt: idx >= 0 ? (list0[idx].addedAt || now) : now };
  if (idx >= 0) list0[idx] = rec; else list0.unshift(rec);
  writeAll(list0);
  return rec;
}

function remove(id) {
  const list0 = readAll();
  const next = list0.filter((a) => a.id !== id);
  writeAll(next);
  return next.length !== list0.length;
}

function tokenById(id) {
  const rec = readAll().find((a) => a.id === id);
  return rec || null;
}

module.exports = { init, list, add, remove, tokenById };
