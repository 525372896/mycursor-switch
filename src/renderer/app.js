'use strict';
const $ = (id) => document.getElementById(id);

var ACCOUNTS = [];
var page = 1;
var PAGE_SIZE = 10;
var usageCache = {};   // id -> 轻量额度（套餐 + 总/A/API/G），刷新时清空

// 套餐名归一化：pro_plus/pro-plus -> Pro+，ultra -> Ultra，enterprise/team -> Team
function fmtPlan(m) {
  const s = String(m || '').toLowerCase().replace(/[\s_+-]/g, '');
  if (!s) return '';
  if (s.includes('proplus')) return 'Pro+';
  if (s.includes('ultra')) return 'Ultra';
  if (s.includes('enterprise') || s.includes('team')) return 'Team';
  if (s.includes('pro')) return 'Pro';
  if (s.includes('free')) return 'Free';
  return m;
}
function planClass(m) {
  const p = fmtPlan(m);
  return { 'Ultra': 'p-ultra', 'Pro+': 'p-proplus', 'Pro': 'p-pro', 'Team': 'p-team', 'Free': 'p-free' }[p] || '';
}
function paintUsage(row, brief) {
  const u = row.querySelector('.usage');
  const planEl = row.querySelector('.plan-tag');
  if (!u || !planEl) return;
  if (!brief || brief.ok === false) {
    u.querySelector('.up').textContent = '—';
    u.querySelector('.ubar').style.display = 'none';
    u.querySelector('.us').textContent = (brief && brief.msg) || '额度读取失败';
    return;
  }
  const plan = fmtPlan(brief.membership);
  if (plan) { planEl.textContent = plan; planEl.className = 'plan-tag ' + planClass(brief.membership); planEl.style.display = ''; }
  else { planEl.style.display = 'none'; }
  const total = brief.total == null ? 0 : Math.round(brief.total);
  u.querySelector('.up').textContent = total + '%';
  const bar = u.querySelector('.ubar'); bar.style.display = '';
  const i = bar.querySelector('i');
  i.style.width = Math.min(100, Math.max(0, total)) + '%';
  i.className = total >= 90 ? 'hi' : (total >= 60 ? 'mid' : '');
  const fmt = (x) => (x == null ? '—' : Math.round(x));
  u.querySelector('.us').textContent = `A${fmt(brief.auto)} API${fmt(brief.api)} G${fmt(brief.grok)}`;
}
async function lazyUsage(row, a) {
  if (usageCache[a.id]) { paintUsage(row, usageCache[a.id]); return; }
  try {
    const brief = await window.api.usage(a.id);
    usageCache[a.id] = brief;
    if (row.isConnected) paintUsage(row, brief);
  } catch (e) {
    if (row.isConnected) paintUsage(row, { ok: false, msg: '读取失败' });
  }
}

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

// 下载进度：在日志区维护"一行"进度条，就地刷新百分比与进度条宽度（不再每 1% 刷一行）
var progressEl = null;
function showProgress(pct) {
  const box = $('log');
  if (!progressEl || !progressEl.isConnected) {
    progressEl = document.createElement('div');
    progressEl.className = 'l-prog';
    progressEl.innerHTML = '<span class="pl">⬇ 下载更新</span><span class="pbar"><i></i></span><span class="pp">0%</span>';
    box.appendChild(progressEl);
  }
  const p = Math.max(0, Math.min(100, Math.round(pct || 0)));
  progressEl.querySelector('i').style.width = p + '%';
  progressEl.querySelector('.pp').textContent = p + '%';
  box.scrollTop = box.scrollHeight;
}
function resetProgress() { progressEl = null; }

function setMsg(el, text, kind) {
  el.textContent = text || '';
  el.className = 'msg' + (kind ? ' ' + kind : '');
}

async function loadStatus() {
  try {
    const s = await window.api.status();
    const el = $('status');
    const plat = s.platform === 'darwin' ? 'macOS' : s.platform === 'win32' ? 'Windows' : s.platform;
    const ver = s.version ? ` · v${s.version}` : '';
    $('aboutVer').textContent = s.version ? `v${s.version}` : '';
    if (s.cursorInstalled) {
      el.className = 'status';
      el.textContent = `✓ 已检测到 Cursor（${plat}）${ver}`;
    } else {
      el.className = 'status bad';
      el.textContent = `⚠ 没检测到 Cursor 登录数据，请先装并登录过一次 Cursor${ver}`;
    }
  } catch { /* ignore */ }
}

async function doCheckUpdate() {
  const btn = $('updateBtn');
  resetProgress();
  btn.disabled = true;
  try {
    const r = await window.api.checkUpdate();
    if (r && r.ok === false) logLine('（开发模式无法检查更新，打包安装后才生效）');
  } catch (e) { logLine('⚠ ' + e.message); }
  setTimeout(() => { btn.disabled = false; }, 2000);
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
      <div class="item-body">
        <div class="item-top">
          <span class="email"></span>
          <span class="plan-tag" style="display:none"></span>
          <span class="meta">…${a.tokenTail || ''}</span>
        </div>
        <div class="usage">
          <span class="up">…</span>
          <span class="ubar"><i></i></span>
          <span class="us">读取额度中</span>
        </div>
      </div>
      <button class="btn btn-info btn-sm act-usage" title="打开该账号的只读额度页（只看用量/额度，不进 Cursor 后台）">额度</button>
      <button class="btn btn-ok btn-sm act-switch">换到它</button>
      <button class="btn btn-del btn-sm act-del">删除</button>`;
    row.querySelector('.email').textContent = a.email || '(未知邮箱)';
    row.querySelector('.meta').title = added ? '添加于 ' + added : '';
    row.querySelector('.act-usage').onclick = () => doUsage(a, row);
    row.querySelector('.act-switch').onclick = () => doSwitch(a, row);
    row.querySelector('.act-del').onclick = () => doRemove(a);
    box.appendChild(row);
    lazyUsage(row, a);
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

// 关于弹窗
function openAbout() { $('aboutModal').className = ''; }
function closeAbout() { $('aboutModal').className = 'modal-hide'; }
function openGithub() { window.api.openGithub().catch(() => { /* ignore */ }); }

async function doAdd() {
  const btn = $('addSubmit');
  const token = $('tokenInput').value.trim();
  if (!token) { setMsg($('addMsg'), '请先粘贴 token', 'warn'); return; }
  btn.disabled = true; setMsg($('addMsg'), '校验中…', '');
  try {
    const r = await window.api.add(token);
    if (r.ok) {
      logLine('➕ ' + r.msg);
      setMsg($('addMsg'), '');   // 清掉「校验中…」，避免关闭异常时残留
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

async function doUsage(a, row) {
  const btn = row.querySelector('.act-usage');
  const old = btn.textContent;
  btn.disabled = true; btn.textContent = '读取中…';
  try {
    const r = await window.api.openUsage(a.id);
    if (r && r.ok === false) logLine('⚠ ' + (r.msg || '读取额度失败'));
  } catch (e) { logLine('❌ ' + e.message); }
  btn.disabled = false; btn.textContent = old;
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
$('refreshBtn').onclick = () => { usageCache = {}; loadList(true); };
$('updateBtn').onclick = doCheckUpdate;
$('aboutBtn').onclick = openAbout;
$('aboutClose').onclick = closeAbout;
$('aboutModal').onclick = (e) => { if (e.target.id === 'aboutModal') closeAbout(); };
$('aboutGithub').onclick = openGithub;
$('aboutStar').onclick = openGithub;
$('clearLog').onclick = () => { $('log').innerHTML = ''; };
// ---- 本机 Cursor 补丁（Sand Stream 客户端模式）----
function showPatchProgress() { const el = $('patchProgress'); if (el) el.hidden = false; }
function hidePatchProgress() { const el = $('patchProgress'); if (el) el.hidden = true; }
function setPatchProgress(pct, message) {
  const p = Math.max(0, Math.min(100, Math.round(pct || 0)));
  const bar = $('patchProgressBar'), txt = $('patchProgressText'), pctEl = $('patchProgressPct');
  if (bar) bar.style.width = p + '%';
  if (pctEl) pctEl.textContent = p + '%';
  if (txt && message) txt.textContent = message;
}

// 自动检测本机补丁状态：已打补丁→显示「✓ 已打补丁」+ 按钮变「重新打补丁」+ 回退可用；未打→回退禁用
async function loadPatchStatus() {
  const pill = $('patchPill');
  const info = $('patchInfo');
  const applyBtn = $('patchApplyBtn');
  const restoreBtn = $('patchRestoreBtn');
  try {
    const s = await window.api.patchStatus();
    if (!s || s.ok === false) {
      pill.className = 'pill warn';
      pill.textContent = '未检测到 Cursor';
      info.textContent = (s && s.error) || '未检测到本机 Cursor，请在下方填写安装路径后点「设置路径」。';
      applyBtn.disabled = true; restoreBtn.disabled = true;
      applyBtn.textContent = '打补丁'; applyBtn.className = 'btn btn-primary';
      return;
    }
    applyBtn.disabled = false;
    if (s.streamMode) {
      pill.className = 'pill ok'; pill.textContent = '✓ 已打补丁';
      applyBtn.textContent = '重新打补丁'; applyBtn.className = 'btn btn-ghost';
      restoreBtn.disabled = false;
      info.textContent = `Cursor ${s.version} · ${s.path} · Stream 回路已启用（本机已打补丁）`;
    } else if (s.installed) {
      pill.className = 'pill ok'; pill.textContent = '✓ 已打补丁（基础）';
      applyBtn.textContent = '重新打补丁'; applyBtn.className = 'btn btn-ghost';
      restoreBtn.disabled = false;
      info.textContent = `Cursor ${s.version} · ${s.path} · 基础模式已生效（当前版本未匹配 Stream 直连）`;
    } else {
      pill.className = 'pill'; pill.textContent = '未打补丁';
      applyBtn.textContent = '打补丁'; applyBtn.className = 'btn btn-primary';
      restoreBtn.disabled = true;
      info.textContent = `Cursor ${s.version} · ${s.path} · 尚未打补丁`;
    }
  } catch (e) {
    pill.className = 'pill warn';
    pill.textContent = '检测失败';
    info.textContent = e.message;
    applyBtn.disabled = false; restoreBtn.disabled = false;
  }
}

async function doPatchApply() {
  const btn = $('patchApplyBtn');
  const rb = $('patchRestoreBtn');
  btn.disabled = true; rb.disabled = true; btn.textContent = '打补丁中…';
  showPatchProgress(); setPatchProgress(2, '开始打补丁…');
  try {
    const r = await window.api.patchApply();
    if (!r.ok) { logLine('❌ ' + (r.msg || '打补丁失败')); setPatchProgress(0, '打补丁失败'); }
    else setPatchProgress(100, r.noop ? '已是最新' : (r.basicMode ? '完成（基础模式）' : '完成（Stream 模式）'));
  } catch (e) { logLine('❌ ' + e.message); setPatchProgress(0, '出错：' + e.message); }
  setTimeout(hidePatchProgress, 1500);
  await loadPatchStatus();
}

async function doPatchRestore() {
  const btn = $('patchRestoreBtn');
  const ab = $('patchApplyBtn');
  btn.disabled = true; ab.disabled = true; btn.textContent = '回退中…';
  showPatchProgress(); setPatchProgress(2, '开始回退…');
  try {
    const r = await window.api.patchRestore();
    if (!r.ok) { logLine('❌ ' + (r.msg || '回退失败')); setPatchProgress(0, '回退失败'); }
    else setPatchProgress(100, r.noop ? '本机没有补丁' : '已回退，Cursor 已重启');
  } catch (e) { logLine('❌ ' + e.message); setPatchProgress(0, '出错：' + e.message); }
  btn.textContent = '回退';
  setTimeout(hidePatchProgress, 1500);
  await loadPatchStatus();
}

async function doPatchSetPath() {
  const btn = $('cursorPathBtn');
  const p = $('cursorPathInput').value.trim();
  btn.disabled = true;
  try {
    const s = await window.api.patchSetPath(p);
    if (s && s.ok === false && s.error) logLine('⚠ ' + s.error);
    else logLine(p ? ('✅ 已设置 Cursor 路径：' + p) : '✅ 已恢复自动检测 Cursor 路径');
  } catch (e) { logLine('❌ ' + e.message); }
  btn.disabled = false;
  await loadPatchStatus();
}

$('patchApplyBtn').onclick = doPatchApply;
$('patchRestoreBtn').onclick = doPatchRestore;
$('cursorPathBtn').onclick = doPatchSetPath;

// 禁止 Cursor 自动更新开关（默认开启）
async function loadBlockUpdate() {
  try { const on = await window.api.getBlockUpdate(); const c = $('blockUpdateChk'); if (c) c.checked = on !== false; } catch (e) { /* ignore */ }
}
if ($('blockUpdateChk')) {
  $('blockUpdateChk').onchange = async (e) => {
    const on = e.target.checked;
    try {
      await window.api.setBlockUpdate(on);
      logLine(on ? '🔒 已禁止 Cursor 自动更新（重启 Cursor 后生效）' : '🔓 已恢复 Cursor 自动更新');
    } catch (err) { logLine('❌ ' + err.message); }
  };
}

// Stream 直连模式开关（默认开；关闭=基础模式，可用 Composer 模型）
async function loadStreamDirect() {
  try { const on = await window.api.getStreamDirect(); const c = $('streamDirectChk'); if (c) c.checked = on !== false; } catch (e) { /* ignore */ }
}
if ($('streamDirectChk')) {
  $('streamDirectChk').onchange = async (e) => {
    const on = e.target.checked;
    try {
      await window.api.setStreamDirect(on);
      logLine(on ? '⚡ 已选 Stream 直连模式（点「打补丁」生效）' : '🧩 已选基础模式：可用 grok-4.6-xhigh-fast 等 Composer 模型（点「打补丁」生效）');
    } catch (err) { logLine('❌ ' + err.message); }
  };
}

// ---- Tab 切换 ----
function switchTab(name) {
  document.querySelectorAll('.tabbtn').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.tabpane').forEach((p) => p.classList.toggle('active', p.id === 'tab-' + name));
  if (name === 'patch') loadPatchStatus();   // 每次进补丁 tab 刷新状态
}
document.querySelectorAll('.tabbtn').forEach((b) => { b.onclick = () => switchTab(b.dataset.tab); });

window.api.onProgress(showProgress);
window.api.onLog(logLine);
window.api.onPatchProgress((p) => setPatchProgress(p.percent, p.message));

loadStatus();
loadList();
loadPatchStatus();
loadBlockUpdate();
loadStreamDirect();
