'use strict';
const $ = (id) => document.getElementById(id);

function logLine(line) {
  const box = $('log');
  const div = document.createElement('div');
  const t = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  let cls = '';
  if (/✅|已切换|已添加|完成/.test(line)) cls = 'l-ok';
  else if (/⚠|失败|没|超时/.test(line)) cls = 'l-warn';
  else if (/❌|错误/.test(line)) cls = 'l-err';
  div.className = cls;
  div.textContent = `[${t}] ${line}`;
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
}

function setMsg(el, text, kind) {
  el.textContent = text || '';
  el.className = 'msg' + (kind ? ' ' + kind : '');
}

async function loadStatus() {
  try {
    const s = await window.api.status();
    const el = $('status');
    if (s.cursorInstalled) {
      el.className = 'status';
      el.textContent = `✓ 已检测到 Cursor（${s.platform === 'darwin' ? 'macOS' : s.platform === 'win32' ? 'Windows' : s.platform}）`;
    } else {
      el.className = 'status bad';
      el.textContent = '⚠ 没检测到 Cursor 的登录数据，请先安装并登录过一次 Cursor';
    }
  } catch { /* ignore */ }
}

async function loadList() {
  const list = await window.api.list();
  const box = $('list');
  box.innerHTML = '';
  $('count').textContent = list.length ? `（${list.length}）` : '';
  $('empty').style.display = list.length ? 'none' : 'block';
  list.forEach((a, i) => {
    const row = document.createElement('div');
    row.className = 'item';
    const added = a.addedAt ? new Date(a.addedAt).toLocaleString('zh-CN', { hour12: false }) : '';
    row.innerHTML = `
      <span class="idx">${i + 1}</span>
      <span class="email"></span>
      <span class="meta">…${a.tokenTail || ''}</span>
      <button class="btn btn-ok btn-sm act-switch">换到它</button>
      <button class="btn btn-del btn-sm act-del">删除</button>`;
    row.querySelector('.email').textContent = a.email || '(未知邮箱)';
    row.querySelector('.meta').title = added ? '添加于 ' + added : '';
    row.querySelector('.act-switch').onclick = () => doSwitch(a, row);
    row.querySelector('.act-del').onclick = () => doRemove(a);
    box.appendChild(row);
  });
}

async function doAdd() {
  const btn = $('addBtn');
  const token = $('tokenInput').value.trim();
  if (!token) { setMsg($('addMsg'), '请先粘贴 token', 'warn'); return; }
  btn.disabled = true; setMsg($('addMsg'), '校验中…', '');
  try {
    const r = await window.api.add(token);
    if (r.ok) {
      setMsg($('addMsg'), '✅ ' + r.msg, 'ok');
      $('tokenInput').value = '';
      logLine('➕ ' + r.msg);
      await loadList();
    } else {
      setMsg($('addMsg'), '❌ ' + r.msg, 'err');
    }
  } catch (e) { setMsg($('addMsg'), '❌ ' + e.message, 'err'); }
  btn.disabled = false;
}

async function doSwitch(a, row) {
  const btn = row.querySelector('.act-switch');
  btn.disabled = true; btn.textContent = '切换中…';
  try {
    const r = await window.api.switch(a.id);
    if (!r.ok) logLine('❌ ' + (r.msg || '换号失败'));
  } catch (e) { logLine('❌ ' + e.message); }
  btn.disabled = false; btn.textContent = '换到它';
}

async function doRemove(a) {
  await window.api.remove(a.id);
  logLine(`🗑 已删除 ${a.email || '账号'}（仅从本工具移除，不影响 Cursor 账号本身）`);
  await loadList();
}

$('addBtn').onclick = doAdd;
$('refreshBtn').onclick = loadList;
$('clearLog').onclick = () => { $('log').innerHTML = ''; };
window.api.onLog(logLine);

loadStatus();
loadList();
