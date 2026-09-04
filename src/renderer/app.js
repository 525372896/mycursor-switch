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
// 额度分级：<60 绿 / 60–89 黄 / ≥90 红；null = 没有该项
function tier(p) { if (p == null) return 'none'; if (p >= 90) return 'hi'; if (p >= 60) return 'mid'; return 'ok'; }
function paintUsage(row, brief) {
  const u = row.querySelector('.usage');
  const planEl = row.querySelector('.plan-tag');
  const stateEl = row.querySelector('.acct-state');
  if (!u || !planEl) return;
  if (!brief || brief.ok === false) {
    u.classList.add('usage-err');
    u.innerHTML = `<span class="uerr">⚠ ${(brief && brief.msg) || '额度读取失败'}</span>`;
    if (stateEl) { stateEl.textContent = /失效|重新登录/.test((brief && brief.msg) || '') ? '已失效' : '读取失败'; stateEl.className = 'acct-state bad'; }
    return;
  }
  const plan = fmtPlan(brief.membership);
  if (plan) { planEl.textContent = plan; planEl.className = 'plan-tag ' + planClass(brief.membership); planEl.style.display = ''; }
  else { planEl.style.display = 'none'; }
  const total = brief.total == null ? null : Math.round(brief.total);
  if (stateEl) {
    const tt = tier(total);
    stateEl.className = 'acct-state ' + tt;
    stateEl.textContent = total == null ? '可用' : (tt === 'hi' ? '额度紧张' : (tt === 'mid' ? '用量较高' : '额度充足'));
  }
  const meter = (label, val, main) => {
    const p = val == null ? null : Math.max(0, Math.min(100, Math.round(val)));
    const t = tier(p);
    return `<div class="meter ${main ? 'main' : ''} ${t}">
      <span class="mk">${label}</span>
      <span class="mb"><i style="width:${p == null ? 0 : p}%"></i></span>
      <span class="mv">${p == null ? '—' : p + '%'}</span>
    </div>`;
  };
  u.classList.remove('usage-err');
  u.innerHTML = meter('总用量', total, true) + meter('Auto', brief.auto) + meter('API', brief.api) + meter('Grok', brief.grok);
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

// 单行刷新：只重新拉这一个号的额度（清掉它的缓存 → 显示读取中 → 重画），不影响其它行
async function doRefreshOne(a, row) {
  const btn = row.querySelector('.act-refresh');
  if (btn.disabled) return;
  const old = btn.textContent;
  btn.disabled = true; btn.textContent = '刷新中…';
  const u = row.querySelector('.usage');
  const stateEl = row.querySelector('.acct-state');
  if (u) { u.classList.remove('usage-err'); u.innerHTML = '<span class="uload">读取额度中…</span>'; }
  if (stateEl) { stateEl.textContent = '读取中'; stateEl.className = 'acct-state loading'; }
  delete usageCache[a.id];
  try {
    const brief = await window.api.usage(a.id);
    usageCache[a.id] = brief;
    if (row.isConnected) paintUsage(row, brief);
  } catch (e) {
    if (row.isConnected) paintUsage(row, { ok: false, msg: '读取失败' });
  }
  btn.disabled = false; btn.textContent = old;
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
    const initial = ((a.email || '?').trim()[0] || '?').toUpperCase();
    row.innerHTML = `
      <div class="avatar" title="#${idx}"><span>${initial}</span><em>${idx}</em></div>
      <div class="item-body">
        <div class="item-top">
          <span class="email"></span>
          <span class="plan-tag" style="display:none"></span>
          <span class="acct-state loading">读取中</span>
          <span class="meta">…${a.tokenTail || ''}</span>
        </div>
        <div class="usage"><span class="uload">读取额度中…</span></div>
      </div>
      <div class="item-actions">
        <button class="btn btn-sm act-refresh" title="只刷新这一行的额度（重新拉取该账号的套餐/用量）">刷新</button>
        <button class="btn btn-ok btn-sm act-switch">换到它</button>
        <button class="btn btn-sand btn-sm act-claim" title="给这个号领取 Sand(Grok Bot)资格：free / 普通套餐号领到后即可用 bot 额度（免费号需先绑卡）">领资格</button>
        <button class="btn btn-sm act-probe" title="探测这个号在 sand 通道下实际能用哪些高级模型（逐个真调用）">探模型</button>
        <button class="btn btn-info btn-sm act-usage" title="打开该账号的只读额度页（只看用量/额度，不进 Cursor 后台）">额度页</button>
        <button class="btn btn-del btn-sm act-del" title="仅从本工具移除">删除</button>
      </div>`;
    row.querySelector('.email').textContent = a.email || '(未知邮箱)';
    row.querySelector('.email').title = a.email || '';
    row.querySelector('.meta').title = added ? '添加于 ' + added : '';
    row.querySelector('.act-refresh').onclick = () => doRefreshOne(a, row);
    row.querySelector('.act-usage').onclick = () => doUsage(a, row);
    row.querySelector('.act-switch').onclick = () => doSwitch(a, row);
    row.querySelector('.act-claim').onclick = () => doClaimSand(a, row);
    row.querySelector('.act-probe').onclick = () => doProbeSand(a, row);
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

async function doClaimSand(a, row) {
  const btn = row.querySelector('.act-claim');
  const old = btn.textContent;
  btn.disabled = true; btn.textContent = '领取中…';
  try {
    const r = await window.api.claimSand(a.id);
    if (!r || r.ok === false) { logLine('⚠ ' + (a.email || '账号') + '：' + (r && r.msg || '领资格失败')); }
    else if (r.outcome === 'card_required') { logLine('💳 ' + (a.email || '账号') + '：免费号需先绑卡，已打开验证链接，完成后再点一次「领资格」'); }
    else { logLine((r.granted ? '✅ ' : 'ℹ ') + (a.email || '账号') + '：' + (r.msg || '已提交')); }
    if (r && r.granted) { usageCache = {}; setTimeout(() => loadList(true), 400); }   // 领到资格后刷新额度显示
  } catch (e) { logLine('❌ ' + e.message); }
  btn.disabled = false; btn.textContent = old;
}

async function doProbeSand(a, row) {
  const btn = row.querySelector('.act-probe');
  const old = btn.textContent;
  btn.disabled = true; btn.textContent = '探测中…';
  logLine('🔬 ' + (a.email || '账号') + '：正在探测可用模型（约 10-40s）…');
  try {
    const r = await window.api.probeSand(a.id);
    if (!r || r.ok === false) { logLine('⚠ ' + (a.email || '账号') + '：' + (r && r.msg || '探测失败')); }
    else { showProbeResult(a, r); }
  } catch (e) { logLine('❌ ' + e.message); }
  btn.disabled = false; btn.textContent = old;
}
function showProbeResult(a, r) {
  const ok = r.ok || [];
  const failed = (r.results || []).filter((x) => !x.ok);
  logLine('✅ ' + (a.email || '账号') + '：可用 ' + ok.length + ' 个模型');
  const body = $('probeBody');
  body.innerHTML = '<div class="probe-sec">✅ 可用模型 <b>' + ok.length + '</b> 个</div>'
    + '<div class="probe-chips">' + (ok.map((m) => '<span class="chip ok">' + escHtml(m) + '</span>').join('') || '<span class="hint">无</span>') + '</div>'
    + (failed.length ? '<div class="probe-sec dim">不可用（' + failed.length + '）</div><div class="probe-chips">' + failed.map((x) => '<span class="chip" title="' + escHtml((x.errorEnum || '') + ': ' + (x.detail || '')) + '">' + escHtml(x.model) + '</span>').join('') + '</div>' : '');
  $('probeTitle').textContent = '模型探测 · ' + (a.email || '账号');
  $('probeModal').className = '';
}
function escHtml(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

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

// ---- 顶部提示条 ----
function setBanner(kind, html) {
  const b = $('patchBanner');
  if (!html) { b.hidden = true; b.innerHTML = ''; return; }
  b.hidden = false; b.className = 'patch-banner ' + (kind || '');
  b.innerHTML = html + '<button class="bn-x" title="关闭">×</button>';
  b.querySelector('.bn-x').onclick = () => { b.hidden = true; };
}

// ---- 安装状态：5 张统计卡 + 路径 + 目标文件 ----
var PATCH_STATUS = null;
var PATCH_BUSY = false;
function fmtSize(n) { if (n == null) return ''; if (n < 1024) return n + ' B'; if (n < 1048576) return (n / 1024).toFixed(0) + ' KB'; return (n / 1048576).toFixed(1) + ' MB'; }
function setStat(id, value, cls, sub) {
  const el = $(id); if (!el) return;
  el.className = 'stat' + (id === 'statProc' ? ' stat-wide' : '') + (cls ? ' ' + cls : '');
  el.querySelector('.stat-v').textContent = value;
  let s = el.querySelector('.stat-sub');
  if (sub) { if (!s) { s = document.createElement('div'); s.className = 'stat-sub'; el.appendChild(s); } s.textContent = sub; }
  else if (s) s.remove();
}
var FILES_ALL = [];
function renderFiles(files) {
  if (Array.isArray(files)) { FILES_ALL = files; try { window.__files = files; } catch (e) { /* ignore */ } }
  const box = $('filesList'); const sum = $('filesSummary');
  const all = FILES_ALL;
  if (!all.length) { box.innerHTML = '<div class="files-empty">没有识别到目标文件</div>'; sum.textContent = '目标文件 0 个'; return; }
  const patched = all.filter((f) => f.patched).length;
  sum.textContent = `目标文件 ${all.length} 个 · 已改 ${patched} 个`;
  const onlyPatched = $('filesOnlyPatched') && $('filesOnlyPatched').checked;
  let list = onlyPatched && patched ? all.filter((f) => f.patched) : all;
  list = list.slice().sort((a, b) => (b.patched - a.patched) || a.rel.localeCompare(b.rel));
  box.innerHTML = '';
  if (!list.length) { box.innerHTML = '<div class="files-empty">当前没有已改的文件</div>'; return; }
  for (const f of list) {
    const row = document.createElement('div');
    row.className = 'frow' + (f.patched ? ' patched' : '');
    const bits = [];
    if (f.client) bits.push(`<b>${f.client}</b> 标识`);
    if (f.eligibility) bits.push(`<b>${f.eligibility}</b> 资格`);
    if (f.membership) bits.push(`<b>${f.membership}</b> 会员`);
    if (f.stream) bits.push(`<b>${f.stream}</b> Stream`);
    if (!f.patched && f.streamAnchors) bits.push('<span class="anch">有 Stream 锚点</span>');
    if (f.remainingIde) bits.push(`<span class="ide">${f.remainingIde} 未接管</span>`);
    row.innerHTML = `<span class="fmark">${f.patched ? '✓' : '·'}</span><span class="fpath"><span></span></span><span class="fmeta">${bits.join(' · ')}${bits.length ? ' · ' : ''}${fmtSize(f.size)}</span><button class="freveal" title="在资源管理器中显示">⧉</button>`;
    row.querySelector('.fpath > span').textContent = f.rel;
    row.title = f.patched ? '点击查看改了哪几处' : '此文件未改动（点击可查看，会提示无改动）';
    row.onclick = () => openDiff(f);
    row.querySelector('.freveal').onclick = (e) => { e.stopPropagation(); window.api.patchRevealFile(f.rel).then((r) => { if (r && r.ok === false) logLine('⚠ ' + r.error); }).catch(() => { /* ignore */ }); };
    box.appendChild(row);
  }
}
if ($('filesOnlyPatched')) $('filesOnlyPatched').onchange = () => renderFiles();

// ---- 改动详情抽屉：某个目标文件改了哪几处（按 marker 定位，带上下文高亮）----
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function catClass(c) { return { '客户端标识': 'c-client', '资格与会员': 'c-elig', '会员伪装': 'c-mem', 'Stream': 'c-stream' }[c] || ''; }
// 把改动点附近的关键片段高亮：marker 本身、marker 前后被注入的短路语句
function highlightHunk(h) {
  let before = esc(h.before), after = esc(h.after);
  const inj = [
    /(return!1;)$/, /(return!0;)$/, /("enterprise"\|\|)$/, /("sand")$/, /(\w+=!0;)$/, /(p?\w*=!0)$/,
    /(\{runtime:"managed-local",reason:"sand-client"\})$/,
  ];
  for (const re of inj) { if (re.test(before)) { before = before.replace(re, '<span class="hi">$1</span>'); break; } }
  // marker 后面紧跟的：|| 原 gate（死代码）、原三元判定
  after = after.replace(/^(\|\|await Promise\.resolve\([^)]*\)\)\.catch\(\(\)=&gt;!1\))/, '<span class="hd0">$1</span>');
  after = after.replace(/^(;\(yield [^}]*\}:\{[^}]*\})/, '<span class="hd0">$1</span>');
  after = after.replace(/^(\(\w+\))/, '<span class="hk">$1</span>');
  return `${before}<span class="hm">${esc(h.mark)}</span>${after}`;
}
var DIFF_REL = '';
async function openDiff(f) {
  DIFF_REL = f.rel;
  $('diffFile').textContent = f.rel; $('diffFile').title = f.rel;
  $('diffSub').textContent = fmtSize(f.size) + (f.patched ? '' : ' · 未改动');
  $('diffSummary').innerHTML = '';
  $('diffList').innerHTML = '<div class="sess-empty">读取中…（大文件要几秒）</div>';
  $('diffModal').className = '';
  try {
    const r = await window.api.patchFileChanges(f.rel);
    if (DIFF_REL !== f.rel) return;
    if (!r || r.ok === false) { $('diffList').innerHTML = `<div class="sess-empty">读取失败：${esc(r && r.error)}</div>`; return; }
    const pills = [];
    for (const [c, n] of Object.entries(r.byCategory || {})) pills.push(`<span class="pill ${catClass(c) === 'c-stream' ? 'ok' : catClass(c) === 'c-elig' ? 'warn' : ''}">${esc(c)} ${n}</span>`);
    if (r.baselineSize != null) { const d = r.size - r.baselineSize; pills.push(`<span class="pill">相对原文 ${d >= 0 ? '+' : ''}${d} 字节</span>`); }
    if (r.membershipSnippetLen) pills.push(`<span class="pill">文件头注入 ${fmtSize(r.membershipSnippetLen)} 会员伪装脚本</span>`);
    $('diffSummary').innerHTML = pills.join('') || '<span class="pill">无 Sand 改动</span>';
    $('diffSub').textContent = `${fmtSize(r.size)} · ${r.total} 处改动`;
    if (!r.total) { $('diffList').innerHTML = '<div class="sess-empty">这个文件没有任何 Sand 标记，内容与原版一致。</div>'; return; }
    $('diffList').innerHTML = r.hunks.map((h, i) => `
      <div class="hunk">
        <div class="hunk-head"><span class="hn">#${i + 1}</span><span class="hc ${catClass(h.category)}">${esc(h.category)}</span><span class="hd" title="${esc(h.desc)}">${esc(h.desc)}</span><span class="hl">行 ${h.line} · 偏移 ${h.offset.toLocaleString()}</span></div>
        <div class="hunk-code">…${highlightHunk(h)}…</div>
      </div>`).join('');
  } catch (e) { $('diffList').innerHTML = `<div class="sess-empty">读取失败：${esc(e.message)}</div>`; }
}
function closeDiff() { $('diffModal').className = 'modal-hide'; DIFF_REL = ''; }
$('diffClose').onclick = closeDiff;
$('diffModal').onclick = (e) => { if (e.target.id === 'diffModal') closeDiff(); };
$('diffReveal').onclick = () => { if (DIFF_REL) window.api.patchRevealFile(DIFF_REL).catch(() => { /* ignore */ }); };
function paintStatus(s) {
  const pill = $('patchPill'), info = $('patchInfo');
  const applyBtn = $('patchApplyBtn'), restoreBtn = $('patchRestoreBtn');
  if (!s || s.ok === false) {
    pill.className = 'pill bad'; pill.textContent = '未检测到 Cursor';
    info.textContent = (s && s.error) || '未检测到本机 Cursor，请在左下方填写安装路径后点「设置路径」。';
    applyBtn.disabled = true; restoreBtn.disabled = true;
    $('patchVersion').textContent = s && s.version ? 'Cursor ' + s.version : '—';
    ['statClient', 'statStream', 'statElig', 'statIde', 'statProc'].forEach((id) => setStat(id, '—', 'zero'));
    renderFiles([]); $('patchExternal').hidden = true;
    return;
  }
  applyBtn.disabled = PATCH_BUSY; restoreBtn.disabled = PATCH_BUSY || !s.installed;
  $('patchVersion').textContent = 'Cursor ' + s.version;
  const streamChk = $('streamDirectChk');
  const wantStream = !streamChk || streamChk.checked;
  if (s.streamMode) { pill.className = 'pill ok'; pill.textContent = '已启用 · Stream 模式'; applyBtn.textContent = '重新打补丁'; }
  else if (s.installed) { pill.className = 'pill ok'; pill.textContent = '已启用 · 基础模式'; applyBtn.textContent = wantStream && s.streamCapable ? '升级到 Stream' : '重新打补丁'; }
  else { pill.className = 'pill'; pill.textContent = '未打补丁'; applyBtn.textContent = '打补丁'; }
  info.textContent = s.installed
    ? `本机已打补丁（引擎 ${s.toolVersion}）。${s.streamMode ? '对话走本地 agent-host（Stream）。' : (s.streamCapable ? '当前只是基础模式：client-type 已切 GrokBot，但 Stream 锚点不完整或被关闭。' : '当前 Cursor 版本没有 Stream 锚点，只能基础模式。')}`
    : '把 Cursor 的客户端标识切到 GrokBot，并让对话走本地 agent-host。改动逐文件备份、写完自动校验，出问题会整体回滚。';

  setStat('statClient', s.client, s.client ? '' : 'zero');
  const sd = s.streamDetail || {};
  const streamSub = `route ${sd.route} · load ${sd.runtimeLoad} · id ${sd.identity} · exec ${sd.moveExec} · host ${sd.agentHost}`;
  if (s.streamMode) setStat('statStream', s.stream, '', streamSub);
  else if (s.stream) setStat('statStream', s.stream, 'partial', streamSub + '（不完整）');
  else setStat('statStream', 0, 'zero', s.streamCapable ? '版本有锚点，未启用' : '此版本无 Stream 锚点');
  setStat('statElig', s.eligibility, s.eligibility ? '' : 'zero', s.membership ? `含会员伪装 ${s.membership} 处` : '');
  setStat('statIde', s.remainingIde, s.remainingIde ? 'warn' : 'zero', s.remainingIde ? '打补丁会一并处理' : '全部已改');
  setStat('statProc', s.processes == null ? '—' : s.processes, s.processes ? '' : 'zero');
  $('patchVersion').textContent = `Cursor ${s.version} · ${s.path}`; $('patchVersion').title = `安装目录 ${s.path}\n可执行文件 ${s.executable}\n补丁引擎 sand_patch ${s.toolVersion}`;
  const ext = $('patchExternal');
  if (s.external) { ext.hidden = false; ext.textContent = `发现 ${s.external} 处别的工具留下的标记。这里不会去接管或覆盖它们，请先用原来的方式卸载。`; }
  else ext.hidden = true;
  renderFiles(s.files);
}
// withProcesses=false 走缓存（~3ms），用于频繁刷新；点击刷新按钮/操作完成时带进程数
async function loadPatchStatus(withProcesses) {
  try {
    const s = await window.api.patchStatus({ withProcesses: withProcesses !== false });
    PATCH_STATUS = s; paintStatus(s);
  } catch (e) {
    paintStatus({ ok: false, error: e.message });
  }
}

// ---- 实时会话：步骤时间线 + 逐文件动画 + 逐条日志（支持回放上一次会话）----
var SESS_T0 = 0, SESS_TIMER = null, SESS_OP = '', SESS_BACKUP = '';
const OP_LABEL = { install: '打补丁', uninstall: '卸载' };
function resetSession(label, op) {
  document.querySelectorAll('#steps li').forEach((li) => { li.className = ''; li.querySelector('.st-detail').textContent = ''; li.querySelector('.st-ms').textContent = ''; });
  $('sessLog').innerHTML = '';
  $('sfList').innerHTML = ''; $('sfCount').textContent = ''; $('sessFiles').hidden = true;
  $('sessFoot').hidden = true; SESS_BACKUP = '';
  SESS_OP = op || ''; $('sessOp').textContent = SESS_OP ? '· ' + (OP_LABEL[SESS_OP] || SESS_OP) : '';
  $('sfTitle').textContent = SESS_OP === 'uninstall' ? '正在还原的文件' : '正在写入的文件';
  SESS_T0 = Date.now();
  const el = $('sessElapsed');
  el.innerHTML = '<i class="dot-live on"></i>' + (label || '进行中') + ' <span class="sess-sec">0.0s</span>';
  if (SESS_TIMER) clearInterval(SESS_TIMER);
  SESS_TIMER = setInterval(() => { const sec = el.querySelector('.sess-sec'); if (sec) sec.textContent = ((Date.now() - SESS_T0) / 1000).toFixed(1) + 's'; }, 100);
}
function endSession(ok, label, elapsedMs) {
  if (SESS_TIMER) { clearInterval(SESS_TIMER); SESS_TIMER = null; }
  const total = ((elapsedMs != null ? elapsedMs : (Date.now() - SESS_T0)) / 1000).toFixed(1);
  $('sessElapsed').innerHTML = `<i class="dot-live"></i>${label || (ok ? '完成' : '失败')} · ${total}s`;
  if (SESS_BACKUP) $('sessFoot').hidden = false;
}
function fmtMs(ms) { if (!ms) return ''; return ms < 1000 ? ms + 'ms' : (ms / 1000).toFixed(1) + 's'; }
function sessLog(text, cls, atMs) {
  const box = $('sessLog');
  const empty = box.querySelector('.sess-empty'); if (empty) empty.remove();
  const div = document.createElement('div');
  div.className = 'ln' + (cls ? ' ' + cls : '');
  const t = atMs != null ? '+' + (atMs / 1000).toFixed(1) + 's' : new Date().toLocaleTimeString('zh-CN', { hour12: false });
  const tt = document.createElement('span'); tt.className = 't'; tt.textContent = t;
  const m = document.createElement('span'); m.className = 'm'; m.textContent = text;
  div.appendChild(tt); div.appendChild(m);
  box.appendChild(div); box.scrollTop = box.scrollHeight;
  const bm = /备份目录 (.+)$/.exec(text); if (bm) SESS_BACKUP = bm[1].trim();
}
const FILE_STATE_TXT = { pending: '待处理', writing: '写入中…', written: '已写入', restored: '已还原', rolledback: '已回滚', failed: '失败' };
function sessFile(ev) {
  const wrap = $('sessFiles'); wrap.hidden = false;
  if (SESS_OP === 'uninstall' && ev.status === 'writing') ev = { ...ev, status: 'writing', _txt: '还原中…' };
  let row = document.querySelector(`#sfList .sfrow[data-rel="${CSS.escape(ev.rel)}"]`);
  if (!row) {
    row = document.createElement('div'); row.dataset.rel = ev.rel;
    row.innerHTML = '<i class="sfi"></i><span class="sfp"><span></span></span><span class="sfs"></span>';
    row.querySelector('.sfp > span').textContent = ev.rel; row.title = ev.rel;
    $('sfList').appendChild(row);
  }
  row.className = 'sfrow ' + ev.status;
  row.querySelector('.sfs').textContent = ev._txt || FILE_STATE_TXT[ev.status] || ev.status;
  if (ev.status === 'writing') row.scrollIntoView({ block: 'nearest' });
  const rows = [...document.querySelectorAll('#sfList .sfrow')];
  const done = rows.filter((r) => /written|restored/.test(r.className)).length;
  $('sfCount').textContent = `${done} / ${rows.length}`;
}
function logClass(t) {
  if (/^已写入|^已还原|^\s+↳/.test(t)) return 'file';
  if (/^完成|全部通过/.test(t)) return 'ok';
  if (/降级|不完整|未能|拒绝|别的工具|回滚/.test(t)) return 'warn';
  return '';
}
function onPatchEvent(ev) {
  if (!ev) return;
  if (ev.type === 'step') {
    const li = document.querySelector(`#steps li[data-step="${ev.id}"]`); if (!li) return;
    li.className = ev.status;
    li.querySelector('.st-detail').textContent = ev.detail || '';
    li.querySelector('.st-ms').textContent = ev.status === 'running' ? '' : (ev.status === 'skipped' ? '跳过' : fmtMs(ev.ms));
  } else if (ev.type === 'log') {
    sessLog(ev.text || '', logClass(ev.text || ''));
  } else if (ev.type === 'file') {
    sessFile(ev);
  } else if (ev.type === 'error') {
    sessLog('✖ ' + ev.text, 'err');
  } else if (ev.type === 'progress') {
    setPatchProgress(ev.percent, ev.message);
  }
}
// 启动时回放上一次会话：右侧不再一直「待命」，能看到上次是打补丁/卸载、改了哪些文件、哪一步花了多久
async function replayLastSession() {
  try {
    const s = await window.api.patchLastSession();
    if (!s || !s.steps || !s.steps.length) return;
    const okRes = s.result && s.result.ok !== false;
    resetSession('', s.operation);
    if (SESS_TIMER) { clearInterval(SESS_TIMER); SESS_TIMER = null; }
    for (const st of s.steps) onPatchEvent({ type: 'step', ...st });
    for (const f of (s.files || [])) sessFile(f);
    for (const l of (s.logs || [])) { sessLog(l.text, logClass(l.text), l.at); }
    document.querySelectorAll('#sessLog .ln').forEach((el) => el.classList.add('replay'));
    const when = s.finishedAt ? new Date(s.finishedAt).toLocaleString('zh-CN', { hour12: false }) : '';
    const label = (okRes ? (s.result && s.result.noop ? '上次：无需改动' : '上次：完成') : '上次：失败') + (when ? ' · ' + when : '');
    endSession(okRes, label, s.elapsedMs || 0);
    if (s.result && s.result.backupDir) SESS_BACKUP = s.result.backupDir;
    if (SESS_BACKUP) $('sessFoot').hidden = false;
  } catch (e) { /* 没有上次会话就保持待命 */ }
}
$('sessBackupBtn').onclick = () => { if (SESS_BACKUP) window.api.patchOpenFolder(SESS_BACKUP).catch(() => { /* ignore */ }); };

async function doPatchApply() {
  if (PATCH_BUSY) return;
  const btn = $('patchApplyBtn'), rb = $('patchRestoreBtn');
  PATCH_BUSY = true; btn.disabled = true; rb.disabled = true; const oldTxt = btn.textContent; btn.textContent = '打补丁中…';
  setBanner('info', '正在打补丁：会先关闭 Cursor，写完自动校验并重启。请勿在此期间操作 Cursor。');
  resetSession('打补丁', 'install'); showPatchProgress(); setPatchProgress(2, '开始…');
  let r = null;
  try {
    r = await window.api.patchApply();
    if (!r.ok) { setPatchProgress(0, '打补丁失败'); setBanner('bad', '打补丁失败：' + (r.msg || '未知错误') + '。已按备份自动回滚，Cursor 文件保持原样。'); endSession(false); }
    else {
      setPatchProgress(100, r.noop ? '已是最新' : (r.basicMode ? '完成（基础模式）' : '完成（Stream 模式）'));
      const mode = r.streamMode ? 'Stream 模式' : '基础模式';
      setBanner('ok', r.noop ? `已是最新（${mode}），无需改动，Cursor 已重启。` : `补丁完成：${mode}，改写 ${(r.files || []).length} 个文件，用时 ${((r.elapsedMs || 0) / 1000).toFixed(1)}s，Cursor 已重启。` + (r.basicMode && r.streamReason ? ' ' + r.streamReason : ''));
      if (r.backupDir) SESS_BACKUP = r.backupDir;
      endSession(true, r.noop ? '已是最新' : '完成', r.elapsedMs);
    }
  } catch (e) { setPatchProgress(0, '出错'); setBanner('bad', '打补丁出错：' + e.message); sessLog('✖ ' + e.message, 'err'); endSession(false); }
  PATCH_BUSY = false; btn.textContent = oldTxt;
  setTimeout(hidePatchProgress, 1800);
  await loadPatchStatus(true);
}

async function doPatchRestore() {
  if (PATCH_BUSY) return;
  const btn = $('patchRestoreBtn'), ab = $('patchApplyBtn');
  PATCH_BUSY = true; btn.disabled = true; ab.disabled = true; btn.textContent = '卸载中…';
  setBanner('info', '正在卸载补丁：会先关闭 Cursor，按备份逐文件还原并校验后重启。');
  resetSession('卸载', 'uninstall'); showPatchProgress(); setPatchProgress(2, '开始…');
  try {
    const r = await window.api.patchRestore();
    if (!r.ok) { setPatchProgress(0, '卸载失败'); setBanner('bad', '卸载失败：' + (r.msg || '未知错误')); endSession(false); }
    else {
      setPatchProgress(100, r.noop ? '本机没有补丁' : '已卸载，Cursor 已重启');
      setBanner('ok', r.noop ? '本机没有补丁，无需改动。' : `已卸载：还原 ${(r.files || []).length} 个文件，用时 ${((r.elapsedMs || 0) / 1000).toFixed(1)}s，Cursor 已重启。`);
      if (r.backupDir) SESS_BACKUP = r.backupDir;
      endSession(true, r.noop ? '本机没有补丁' : '已卸载', r.elapsedMs);
    }
  } catch (e) { setPatchProgress(0, '出错'); setBanner('bad', '卸载出错：' + e.message); sessLog('✖ ' + e.message, 'err'); endSession(false); }
  PATCH_BUSY = false; btn.textContent = '卸载';
  setTimeout(hidePatchProgress, 1800);
  await loadPatchStatus(true);
}

async function doPatchSetPath() {
  const btn = $('cursorPathBtn');
  const p = $('cursorPathInput').value.trim();
  btn.disabled = true;
  try {
    const s = await window.api.patchSetPath(p);
    if (s && s.ok === false && s.error) { logLine('⚠ ' + s.error); setBanner('warn', s.error); }
    else { logLine(p ? ('✅ 已设置 Cursor 路径：' + p) : '✅ 已恢复自动检测 Cursor 路径'); setBanner(null); }
  } catch (e) { logLine('❌ ' + e.message); }
  btn.disabled = false;
  await loadPatchStatus(true);
}

$('probeClose').onclick = () => { $('probeModal').className = 'modal-hide'; };
$('probeModal').onclick = (e) => { if (e.target.id === 'probeModal') $('probeModal').className = 'modal-hide'; };
$('patchApplyBtn').onclick = doPatchApply;
$('patchRestoreBtn').onclick = doPatchRestore;
$('patchRefreshBtn').onclick = () => loadPatchStatus(true);
$('cursorPathBtn').onclick = doPatchSetPath;
$('kvInstallOpen').onclick = () => { const p = PATCH_STATUS && PATCH_STATUS.path; if (p) window.api.patchOpenFolder(p).catch(() => { /* ignore */ }); };
window.api.onPatchEvent(onPatchEvent);
replayLastSession();

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
      setBanner('info', on ? 'GrokBot Stream 已打开：点「打补丁」后对话走本地 agent-host。' : '已切到基础模式：点「打补丁」后只改 client-type，可用 grok-4.6-xhigh-fast 等 Composer 模型。');
      if (PATCH_STATUS) paintStatus(PATCH_STATUS);   // 按钮文案随开关变
    } catch (err) { logLine('❌ ' + err.message); }
  };
}

// ---- Tab 切换 ----
function switchTab(name) {
  document.querySelectorAll('.tabbtn').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.tabpane').forEach((p) => p.classList.toggle('active', p.id === 'tab-' + name));
  // 补丁 tab 有自己的「实时会话」日志，隐藏共用「日志」卡，给上面两栏更多空间；账号 tab 再显示回来
  const logcard = document.querySelector('.logcard');
  if (logcard) logcard.style.display = name === 'patch' ? 'none' : '';
  if (name === 'patch') loadPatchStatus(false);   // 每次进补丁 tab 刷新状态（走缓存，瞬间返回）
}
document.querySelectorAll('.tabbtn').forEach((b) => { b.onclick = () => switchTab(b.dataset.tab); });

window.api.onProgress(showProgress);
window.api.onLog(logLine);
window.api.onPatchProgress((p) => setPatchProgress(p.percent, p.message));

loadStatus();
loadList();
loadPatchStatus(true);
loadBlockUpdate();
loadStreamDirect();

// 目标文件栏：默认收起，点“目标文件 …”标题展开/收起（纯界面折叠，不影响补丁逻辑）
(function () {
  const sum = document.getElementById('filesSummary');
  if (!sum) return;
  const col = sum.closest('.patch-col');
  if (col) col.classList.add('files-collapsed');
  sum.addEventListener('click', function () { if (col) col.classList.toggle('files-collapsed'); });
})();
