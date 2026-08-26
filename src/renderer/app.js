'use strict';
const $ = (id) => document.getElementById(id);

var ACCOUNTS = [];
var page = 1;
var PAGE_SIZE = 10;

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
      el.textContent = '⚠ 没检测到 Cursor 登录数据，请先装并登录过一次 Cursor';
    }
  } catch { /* ignore */ }
}

async function loadList(keepPage) {
  ACCOUNTS = await window.api.list();
  const pages = Math.max(1, Math.ceil(ACCOUNTS.length / PAGE_SIZE));
  if (!keepPage) page = 1;
  if (page > pages) page = pages;
  renderList();
}

function renderList() {
  const box = $('list');
  box.innerHTML = '';
  const total = ACCOUNTS.length;
  $('count').textContent = total ? `共 ${total} 个账号` : '';
  $('empty').style.display = total ? 'none' : 'block';
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const start = (page - 1) * PAGE_SIZE;
  const slice = ACCOUNTS.slice(start, start + PAGE_SIZE);

  slice.forEach((a, i) => {
    const idx = start + i + 1;
    const row = document.createElement('div');
    row.className = 'item';
    const added = a.addedAt ? new Date(a.addedAt).toLocaleString('zh-CN', { hour12: false }) : '';
    row.innerHTML = `
      <span class="idx">${idx}</span>
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

  // 分页条（>1 页才显示）
  const pg = $('pager');
  if (pages > 1) {
    pg.style.display = 'flex';
    pg.innerHTML = '';
    const prev = document.createElement('button'); prev.textContent = '‹ 上一页'; prev.disabled = page <= 1;
    prev.onclick = () => { if (page > 1) { page--; renderList(); } };
    const info = document.createElement('span'); info.textContent = `第 ${page} / ${pages} 页`;
    const next = document.createElement('button'); next.textContent = '下一页 ›'; next.disabled = page >= pages;
    next.onclick = () => { if (page < pages) { page++; renderList(); } };
    pg.appendChild(prev); pg.appendChild(info); pg.appendChild(next);
  } else {
    pg.style.display = 'none'; pg.innerHTML = '';
  }
}

// 添加账号弹窗
function openAdd() { $('addModal').className = ''; $('tokenInput').value = ''; setMsg($('addMsg'), ''); setTimeout(() => $('tokenInput').focus(), 30); }
function closeAdd() { $('addModal').className = 'modal-hide'; }

async function doAdd() {
  const btn = $('addSubmit');
  const token = $('tokenInput').value.trim();
  if (!token) { setMsg($('addMsg'), '请先粘贴 token', 'warn'); return; }
  btn.disabled = true; setMsg($('addMsg'), '校验中…', '');
  try {
    const r = await window.api.add(token);
    if (r.ok) {
      logLine('➕ ' + r.msg);
      closeAdd();
      await loadList();   // 回到第 1 页看到新号
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
  await loadList(true);
}

$('addBtn').onclick = openAdd;
$('addClose').onclick = closeAdd;
$('addSubmit').onclick = doAdd;
$('addModal').onclick = (e) => { if (e.target.id === 'addModal') closeAdd(); };
$('refreshBtn').onclick = () => loadList(true);
$('clearLog').onclick = () => { $('log').innerHTML = ''; };
window.api.onLog(logLine);

loadStatus();
loadList();
