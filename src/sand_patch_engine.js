'use strict';
// 补丁引擎外壳：布局探测 / 状态检查 / 完整性同步 / 备份提交回滚 / 关重启 Cursor / install·uninstall。
// 与 sand_patch.py 的对应函数逐一对齐；纯字符串变换在 ./sand_patch。

const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync, spawn } = require('child_process');

const P = require('./sand_patch');
const {
  TARGET_SPECS, AGENT_HOST_DIST_REL, EXT_HOST_REL, MEMBERSHIP_TARGET_NAMES, SAND_MEMBERSHIP_SNIPPET,
  CLIENT_RULES, CLIENT_MARKER_GUARD_PATTERN, ELIGIBILITY_MARKER_GUARD_PATTERN,
  MEMBERSHIP_SNIPPET_RE_SRC, SandToolError, markers,
  applyPatchToContent, removePatchFromContent, stripRpcSnippets, contentHasStreamAnchors,
  escapeRegExp, countOcc, replaceAllLiteral, sha256hex, productChecksum, sleep,
} = P;
const M = markers;
const TOOL_VERSION = P.TOOL_VERSION;
const CONFIG_VERSION = 1;
const CURSOR_START_ARGS = ['--classic'];

const isWin = process.platform === 'win32';
const isMac = process.platform === 'darwin';

// ---------------- 配置目录（记住自定义 Cursor 路径 + 备份）----------------
let DATA_DIR = path.join(process.env.LOCALAPPDATA || os.homedir(), 'MyCursorSwitch', 'sand-patch');
function setConfigDir(dir) { if (dir) DATA_DIR = dir; }
function configPath() { return path.join(DATA_DIR, 'config.json'); }
function backupsRoot() { return path.join(DATA_DIR, 'backups'); }

// ---------------- fs 小工具 ----------------
function normKey(p) { const r = path.resolve(p); return isWin ? r.toLowerCase() : r; }
function isWithin(p, root) {
  const a = path.resolve(p); const b = path.resolve(root);
  const rel = path.relative(b, a);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}
function decodeJs(buf) { return buf.toString('utf8'); }
function readPlannedFile(p) {
  const original = fs.readFileSync(p);
  let mode = 0o644;
  try { mode = fs.statSync(p).mode; } catch { /* ignore */ }
  return { path: p, original, nextBytes: original, mode };
}
function atomicWriteSync(p, data) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + '.sandtmp-' + process.pid + '-' + Date.now();
  fs.writeFileSync(tmp, data);
  try {
    fs.renameSync(tmp, p);
  } catch (e) {
    try { fs.chmodSync(p, 0o666); } catch { /* ignore */ }
    fs.renameSync(tmp, p);
  } finally {
    try { if (fs.existsSync(tmp)) fs.rmSync(tmp); } catch { /* ignore */ }
  }
}
function writeJsonAtomic(p, obj) { atomicWriteSync(p, Buffer.from(JSON.stringify(obj, null, 2) + '\n', 'utf8')); }

// ---------------- config ----------------
function loadConfig() {
  try {
    const raw = fs.readFileSync(configPath(), 'utf8');
    const v = JSON.parse(raw);
    if (v && typeof v === 'object' && v.version === CONFIG_VERSION) return v;
  } catch { /* ignore */ }
  return {};
}
function saveCursorPath(value) {
  const v = String(value || '').trim();
  if (['auto', 'clear', 'reset', ''].includes(v.toLowerCase())) {
    writeJsonAtomic(configPath(), { version: CONFIG_VERSION, cursorInstallRoot: '', lastVerifiedVersion: '', updatedAt: new Date().toISOString() });
    return null;
  }
  const layout = layoutFromPath(v);
  writeJsonAtomic(configPath(), { version: CONFIG_VERSION, cursorInstallRoot: layout.installRoot, lastVerifiedVersion: layout.version, updatedAt: new Date().toISOString() });
  return layout;
}

// ---------------- 读取 product.json ----------------
function stripBom(buf) { return (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) ? buf.subarray(3) : buf; }
function readProduct(productPath) {
  let value;
  try {
    const st = fs.statSync(productPath);
    if (st.size <= 0 || st.size > 1024 * 1024) throw new SandToolError('product.json 大小异常：' + productPath);
    value = JSON.parse(stripBom(fs.readFileSync(productPath)).toString('utf8'));
  } catch (e) {
    if (e instanceof SandToolError) throw e;
    throw new SandToolError('无法读取 Cursor product.json：' + productPath);
  }
  if (!value || typeof value !== 'object') throw new SandToolError('Cursor product.json 格式错误：' + productPath);
  const name = String(value.applicationName || value.nameShort || '');
  if (name.toLowerCase() !== 'cursor') throw new SandToolError('所选目录不是 Cursor 安装：' + productPath);
  return value;
}

// ---------------- 布局探测 ----------------
function* candidateAppRoots(rawPath) {
  let p = rawPath;
  try { if (fs.statSync(p).isFile()) p = path.dirname(p); } catch { /* ignore */ }
  let current = p;
  for (let i = 0; i < 8; i++) {
    yield current;
    yield path.join(current, 'resources', 'app');
    yield path.join(current, 'Resources', 'app');
    yield path.join(current, 'Contents', 'Resources', 'app');
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}
function findAppBundle(appRoot) {
  let cur = path.resolve(appRoot);
  while (true) {
    if (path.basename(cur).toLowerCase() === 'cursor.app') return cur;
    const parent = path.dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}
function resolveExecutable(appRoot) {
  if (isWin) {
    let installRoot = appRoot;
    if (path.basename(path.dirname(appRoot)).toLowerCase() === 'resources') installRoot = path.dirname(path.dirname(appRoot));
    for (const exe of [path.join(installRoot, 'Cursor.exe'), path.join(installRoot, 'cursor.exe')]) {
      try { if (fs.statSync(exe).isFile()) return [path.resolve(installRoot), path.resolve(exe)]; } catch { /* ignore */ }
    }
    throw new SandToolError('未找到 Cursor 可执行文件：' + installRoot);
  }
  if (isMac) {
    const bundle = findAppBundle(appRoot);
    if (!bundle) throw new SandToolError('macOS Cursor 路径必须位于 Cursor.app 内');
    const exe = path.join(bundle, 'Contents', 'MacOS', 'Cursor');
    try { if (fs.statSync(exe).isFile()) return [path.resolve(bundle), path.resolve(exe)]; } catch { /* ignore */ }
    throw new SandToolError('未找到 Cursor 可执行文件：' + bundle);
  }
  throw new SandToolError('当前仅支持 Windows 和 macOS');
}
function layoutFromPath(value) {
  let rawText = String(value || '').trim().replace(/^"|"$/g, '');
  if (!rawText) throw new SandToolError('Cursor 路径不能为空');
  if (isWin && (rawText.startsWith('\\\\') || rawText.startsWith('\\\\?\\'))) throw new SandToolError('不支持 UNC 或 Windows 设备路径');
  if (!path.isAbsolute(rawText)) throw new SandToolError('Cursor 路径必须是绝对路径：' + rawText);
  if (!fs.existsSync(rawText)) throw new SandToolError('Cursor 路径不存在：' + rawText);
  const raw = path.resolve(rawText);

  const seen = new Set();
  let lastError = null;
  for (const candidate of candidateAppRoots(raw)) {
    let appRoot;
    try { if (!fs.existsSync(candidate)) continue; appRoot = path.resolve(candidate); } catch { continue; }
    const key = normKey(appRoot);
    if (seen.has(key)) continue;
    seen.add(key);
    const productJson = path.join(appRoot, 'product.json');
    if (!fs.existsSync(productJson)) continue;
    try {
      const product = readProduct(productJson);
      const [installRoot, executable] = resolveExecutable(appRoot);
      const targets = [];
      for (const [rel] of TARGET_SPECS) {
        const target = path.join(appRoot, ...rel.split('/'));
        if (!fs.existsSync(target)) continue;
        if (!isWithin(target, appRoot)) throw new SandToolError('目标文件逃逸：' + target);
        targets.push(path.resolve(target));
      }
      // 1.1.8：动态纳入 agent-host dist 下的所有 chunk（路由/Stream 逻辑所在编号随构建变化），排除 main.js 与 *-worker.js
      const seenTargets = new Set(targets.map(normKey));
      const distDir = path.join(appRoot, ...AGENT_HOST_DIST_REL.split('/'));
      let distStat = null;
      try { distStat = fs.statSync(distDir); } catch { /* 没有 dist 目录 */ }
      if (distStat && distStat.isDirectory()) {
        const names = fs.readdirSync(distDir).filter((n) => n.endsWith('.js')).sort();
        for (const name of names) {
          if (name === 'main.js' || name.endsWith('-worker.js')) continue;
          const chunk = path.join(distDir, name);
          let st; try { st = fs.statSync(chunk); } catch { continue; }
          if (!st.isFile()) continue;
          if (!isWithin(chunk, appRoot)) continue;
          const key = normKey(chunk);
          if (seenTargets.has(key)) continue;
          seenTargets.add(key);
          targets.push(path.resolve(chunk));
        }
      }
      if (!targets.length) throw new SandToolError('Cursor 使用 app.asar 或当前版本没有可识别的 Sand 目标文件');
      const extHost = path.join(appRoot, ...EXT_HOST_REL.split('/'));
      const extHostPath = fs.existsSync(extHost) ? path.resolve(extHost) : null;
      const version = String(product.version || product.commit || '未知');
      return { installRoot, appRoot, productJson: path.resolve(productJson), executable, targetPaths: targets, extHostPath, version };
    } catch (e) {
      if (e instanceof SandToolError) { lastError = e; continue; }
      throw e;
    }
  }
  if (lastError) throw new SandToolError('Cursor 路径校验失败：' + lastError.message);
  throw new SandToolError('路径中未找到 Cursor resources/app：' + raw);
}

function psQuery(script) {
  try {
    const out = execFileSync('powershell', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', timeout: 15000, windowsHide: true });
    return String(out || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  } catch { return []; }
}
function winRunningCandidates() {
  return psQuery("$ErrorActionPreference='SilentlyContinue';[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new();Get-CimInstance Win32_Process -Filter \"Name='Cursor.exe'\" | ForEach-Object { if ($_.ExecutablePath) { $_.ExecutablePath } }");
}
function winRegistryCandidates() {
  const script = "$ErrorActionPreference='SilentlyContinue';$roots=@('HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*');Get-ItemProperty $roots | Where-Object { ($_.DisplayName -eq 'Cursor') -or ($_.Publisher -like '*Anysphere*') } | ForEach-Object { if($_.InstallLocation){$_.InstallLocation}; if($_.DisplayIcon){$_.DisplayIcon -replace ',\\s*-?\\d+$',''} }";
  return psQuery(script).map((s) => s.replace(/^"|"$/g, ''));
}
function defaultCandidateGroups() {
  const groups = [];
  const env = (process.env.SAND_CURSOR_INSTALL_DIR || '').trim();
  if (env) groups.push(['环境变量', [env]]);
  if (isWin) {
    const local = process.env.LOCALAPPDATA || '';
    const pf = process.env.ProgramFiles || 'C:\\Program Files';
    const pfx = process.env['ProgramFiles(x86)'] || '';
    const defaults = [
      local && path.join(local, 'Programs', 'Cursor'),
      local && path.join(local, 'Programs', 'cursor'),
      local && path.join(local, 'Cursor'),
      path.join(pf, 'Cursor'),
      pfx && path.join(pfx, 'Cursor'),
    ].filter(Boolean);
    groups.push(['Windows 默认目录', defaults]);
    groups.push(['Windows 安装登记', winRegistryCandidates()]);
    groups.push(['运行中的 Cursor', winRunningCandidates()]);
  } else if (isMac) {
    groups.push(['macOS 默认目录', ['/Applications/Cursor.app', path.join(os.homedir(), 'Applications', 'Cursor.app')]]);
  }
  return groups;
}
function validLayouts(values) {
  const map = new Map();
  for (const v of values) {
    if (!v) continue;
    try { const layout = layoutFromPath(v); map.set(normKey(layout.appRoot), layout); } catch { /* ignore */ }
  }
  return [...map.values()];
}
// 布局探测走 PowerShell 查注册表 / 进程，Windows 上要 3~4s；界面刷状态很频繁，这里做 30s 缓存。
// 「设置路径」与 install/uninstall 开始时会 invalidateLayoutCache()。
let LAYOUT_CACHE = null;   // { at, layout | error }
const LAYOUT_TTL_MS = 30 * 1000;
function invalidateLayoutCache() { LAYOUT_CACHE = null; }
function resolveCursorLayout(opts = {}) {
  const now = Date.now();
  if (!opts.fresh && LAYOUT_CACHE && now - LAYOUT_CACHE.at < LAYOUT_TTL_MS) {
    if (LAYOUT_CACHE.error) throw LAYOUT_CACHE.error;
    // 缓存的布局仍需真实存在（用户可能刚卸了 Cursor）
    try { if (fs.existsSync(LAYOUT_CACHE.layout.productJson)) return LAYOUT_CACHE.layout; } catch { /* fallthrough */ }
  }
  try {
    const layout = resolveCursorLayoutUncached();
    LAYOUT_CACHE = { at: now, layout };
    return layout;
  } catch (e) {
    LAYOUT_CACHE = { at: now, error: e };
    throw e;
  }
}
function resolveCursorLayoutUncached() {
  const configured = loadConfig().cursorInstallRoot;
  if (typeof configured === 'string' && configured.trim()) {
    try { return layoutFromPath(configured); }
    catch (e) { throw new SandToolError('已设置的 Cursor 路径失效：' + configured + '\n请重新「设置路径」，或填 auto 恢复自动检测'); }
  }
  for (const [source, values] of defaultCandidateGroups()) {
    const layouts = validLayouts(values);
    if (layouts.length === 1) return layouts[0];
    if (layouts.length > 1) {
      const opts = layouts.map((l) => '  - ' + l.installRoot).join('\n');
      throw new SandToolError(source + '检测到多个 Cursor 安装，请在上方填写具体路径后「设置路径」：\n' + opts);
    }
  }
  throw new SandToolError('未检测到 Cursor 安装，请在上方填 Cursor.exe / resources/app / 安装目录后「设置路径」');
}

// ---------------- 扩展内嵌 hash / product 校验值 ----------------
function targetExtensionName(layout, filePath) {
  for (const [rel, extName] of TARGET_SPECS) {
    if (!extName) continue;
    const candidate = path.resolve(path.join(layout.appRoot, ...rel.split('/')));
    if (normKey(candidate) === normKey(filePath)) return extName;
  }
  return null;
}
function extensionHashMapPresent(content, extId) {
  return new RegExp('"' + escapeRegExp(extId) + '"\\s*:\\s*\\{').test(content);
}
function updateExtensionHashes(layout, plan) {
  const changed = [];
  for (const key of Object.keys(plan)) {
    const name = targetExtensionName(layout, plan[key].path);
    if (name) changed.push([name, plan[key].nextBytes]);
  }
  if (!changed.length || !layout.extHostPath) return;
  const extKey = normKey(layout.extHostPath);
  const existing = plan[extKey] || readPlannedFile(layout.extHostPath);
  let nextContent = decodeJs(existing.nextBytes);
  const originalContent = decodeJs(existing.original);
  for (const [name, nextMain] of changed) {
    const extId = 'anysphere.' + name;
    if (!extensionHashMapPresent(nextContent, extId)) continue;
    const digest = sha256hex(nextMain);
    const re = new RegExp('("' + escapeRegExp(extId) + '"\\s*:\\s*\\{[\\s\\S]{0,2400}?"main\\.js"\\s*:\\s*")[0-9a-f]{64}(")');
    let cnt = 0;
    nextContent = nextContent.replace(re, (m, g1, g2) => { cnt += 1; return g1 + digest + g2; });
    if (cnt !== 1) throw new SandToolError('无法定位 ' + extId + ' 的内嵌 main.js 哈希');
  }
  if (nextContent !== originalContent) {
    plan[extKey] = { path: layout.extHostPath, original: existing.original, nextBytes: Buffer.from(nextContent, 'utf8'), mode: existing.mode };
  }
}
function syncProductChecksums(layout, plan) {
  const productFile = readPlannedFile(layout.productJson);
  const hasBom = productFile.original.length >= 3 && productFile.original[0] === 0xef && productFile.original[1] === 0xbb && productFile.original[2] === 0xbf;
  let product;
  try { product = JSON.parse(stripBom(productFile.original).toString('utf8')); }
  catch { throw new SandToolError('product.json 无法解析，拒绝提交补丁'); }
  const checksums = product.checksums;
  if (!checksums || typeof checksums !== 'object') return;
  const outRoot = path.resolve(path.join(layout.appRoot, 'out'));
  let changed = false;
  for (const key of Object.keys(checksums)) {
    const parts = key.split(/[\\/]/).filter(Boolean);
    const target = path.resolve(path.join(outRoot, ...parts));
    if (!isWithin(target, outRoot)) throw new SandToolError('product.json checksum 路径逃逸：' + key);
    const planned = plan[normKey(target)];
    let data;
    if (planned) data = planned.nextBytes;
    else if (fs.existsSync(target)) data = fs.readFileSync(target);
    else continue;
    const digest = productChecksum(data);
    if (checksums[key] !== digest) { checksums[key] = digest; changed = true; }
  }
  if (!changed) return;
  let bytes = Buffer.from(JSON.stringify(product, null, '\t'), 'utf8');
  if (hasBom) bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes]);
  plan[normKey(layout.productJson)] = { path: layout.productJson, original: productFile.original, nextBytes: bytes, mode: productFile.mode };
}
function plannedExtensionNames(layout, plan) {
  const names = new Set();
  for (const key of Object.keys(plan)) { const n = targetExtensionName(layout, plan[key].path); if (n) names.add(n); }
  return names;
}
function verifyExtensionHashes(layout, names) {
  if (!layout.extHostPath || !names.size) return;
  const extContent = decodeJs(fs.readFileSync(layout.extHostPath));
  for (const [rel, extName] of TARGET_SPECS) {
    if (!extName || !names.has(extName)) continue;
    const mainPath = path.join(layout.appRoot, ...rel.split('/'));
    if (!fs.existsSync(mainPath)) continue;
    const extId = 'anysphere.' + extName;
    if (!extensionHashMapPresent(extContent, extId)) continue;
    const re = new RegExp('"' + escapeRegExp(extId) + '"\\s*:\\s*\\{[\\s\\S]{0,2400}?"main\\.js"\\s*:\\s*"([0-9a-f]{64})"');
    const m = re.exec(extContent);
    if (!m) throw new SandToolError('无法验证 ' + extId + ' 的内嵌哈希');
    if (m[1] !== sha256hex(fs.readFileSync(mainPath))) throw new SandToolError(extId + ' 的内嵌哈希校验失败');
  }
}
function verifyProductChecksums(layout) {
  const product = JSON.parse(stripBom(fs.readFileSync(layout.productJson)).toString('utf8'));
  const checksums = product && product.checksums;
  if (!checksums || typeof checksums !== 'object') return 0;
  const outRoot = path.resolve(path.join(layout.appRoot, 'out'));
  let checked = 0;
  for (const key of Object.keys(checksums)) {
    const parts = key.split(/[\\/]/).filter(Boolean);
    const target = path.resolve(path.join(outRoot, ...parts));
    if (!isWithin(target, outRoot) || !fs.existsSync(target)) continue;
    checked += 1;
    if (checksums[key] !== productChecksum(fs.readFileSync(target))) throw new SandToolError('product.json 完整性哈希校验失败：' + key);
  }
  return checked;
}

// ---------------- 状态检查 ----------------
const INSPECT_CACHE = new Map();   // normKey(path) -> { mtimeMs, size, file }
function stripPrivate(f) { const o = {}; for (const k of Object.keys(f)) if (!k.startsWith('_')) o[k] = f[k]; return o; }
// 与 sand_patch.py inspect_status 一致，额外输出：
//   · files[]：每个目标文件的相对路径 / 大小 / 是否已改 / 各类 marker 计数（给界面「目标文件」列表）
//   · membershipMarkers / modelUnlockMarkers / maxmodeMarkers / memProMarkers：资格与会员类计数（给界面卡片）
function inspectStatus(layout) {
  const st = {
    clientMarkers: 0, eligibilityMarkers: 0, legacyClientMarkers: 0, legacyEligibilityMarkers: 0,
    managedLocalRouteMarkers: 0, localRuntimeLoadMarkers: 0, directStreamMarkers: 0,
    agentHostEnablementMarkers: 0, agentHostIdentityMarkers: 0, moveExecMarkers: 0,
    localActionsMarkers: 0, subagentLocalMarkers: 0, forceApi2Markers: 0, streamShimMarkers: 0, streamH2Markers: 0, streamTransportMarkers: 0,
    membershipMarkers: 0, modelUnlockMarkers: 0, memProMarkers: 0, maxmodeMarkers: 0, glassfixMarkers: 0,
    ideMatches: 0, externalSandMatches: 0, externalMarkerCount: 0, streamCapable: false, patchedFiles: [], files: [],
  };
  const clientGuardRe = new RegExp(CLIENT_MARKER_GUARD_PATTERN, 'g');
  const eligGuardRe = new RegExp(ELIGIBILITY_MARKER_GUARD_PATTERN, 'g');
  const legacyClientRe = new RegExp('(["\'])sand\\1' + escapeRegExp(M.LEGACY_SAND_CLIENT_MARKER), 'g');
  for (const target of layout.targetPaths) {
    // 文件级缓存：两个 40MB+ 的 workbench 跑多组正则要好几秒，UI 频繁刷新状态时按 (路径, mtime, size) 复用
    let stat = null;
    try { stat = fs.statSync(target); } catch { /* 读不到就走下面 readFileSync 报错 */ }
    const cacheKey = normKey(target);
    const cached = stat && INSPECT_CACHE.get(cacheKey);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      const f = cached.file;
      st.streamCapable = st.streamCapable || f._streamCapable;
      st.externalMarkerCount += f.external;
      if (f.patched) st.patchedFiles.push(target);
      st.ideMatches += f.remainingIde; st.externalSandMatches += f._sandHere;
      for (const k of Object.keys(f._agg)) st[k] += f._agg[k];
      st.files.push(stripPrivate(f));
      continue;
    }
    const buf = fs.readFileSync(target);
    const content = decodeJs(buf);
    const streamAnchors = contentHasStreamAnchors(content);
    const mlr = countOcc(content, M.SAND_MANAGED_LOCAL_ROUTE_MARKER);
    const lrl = countOcc(content, M.SAND_LOCAL_RUNTIME_LOAD_MARKER);
    const ds = countOcc(content, M.SAND_DIRECT_STREAM_MARKER);
    const ahe = countOcc(content, M.SAND_AGENT_HOST_ENABLEMENT_MARKER);
    const ahi = countOcc(content, M.SAND_AGENT_HOST_IDENTITY_MARKER);
    const me = countOcc(content, M.SAND_MOVE_EXEC_MARKER);
    const la = countOcc(content, M.SAND_LOCAL_ACTIONS_MARKER);
    const sl = countOcc(content, M.SAND_SUBAGENT_LOCAL_MARKER);
    const fa = countOcc(content, M.SAND_FORCE_API2_MARKER);
    const ss = countOcc(content, M.SAND_STREAM_SHIM_HOOK_MARKER);
    const sh2 = countOcc(content, M.SAND_STREAM_H2_MARKER);
    const stp = countOcc(content, M.SAND_STREAM_TRANSPORT_MARKER);
    if (streamAnchors || mlr || lrl || ds || ahe || ahi || me || ss || sh2 || stp) st.streamCapable = true;
    const clientCount = countOcc(content, M.SAND_CLIENT_MARKER) + countOcc(content, M.SAND_CLIENT_EXISTING_MARKER) + countOcc(content, M.SAND_HDRFIX_V2_MARKER);
    const eligibilityCount = countOcc(content, M.SAND_ELIGIBILITY_MARKER);
    const legacyClientCount = (content.match(legacyClientRe) || []).length;
    const legacyEligibilityCount = countOcc(content, 'return!1;' + M.LEGACY_SAND_ELIGIBILITY_MARKER);
    const membership = countOcc(content, M.SAND_MEMBERSHIP_MARKER);
    const modelUnlock = countOcc(content, M.SAND_MODEL_UNLOCK_MARKER);
    const memPro = countOcc(content, M.SAND_MEM_PRO_MARKER);
    const maxmode = countOcc(content, M.SAND_MAXMODE_MARKER);
    const glassfix = countOcc(content, M.SAND_GLASSFIX_MARKER);
    const externalHere = Math.max(0, (content.match(clientGuardRe) || []).length - clientCount - legacyClientCount)
      + Math.max(0, (content.match(eligGuardRe) || []).length - eligibilityCount - legacyEligibilityCount);
    st.externalMarkerCount += externalHere;
    const streamHits = mlr + lrl + ds + ahe + ahi + me + la + sl + fa + ss + sh2 + stp;
    const patched = (clientCount + eligibilityCount + legacyClientCount + legacyEligibilityCount + streamHits) > 0;
    if (patched) st.patchedFiles.push(target);
    let ideHere = 0, sandHere = 0;
    for (const [, src] of CLIENT_RULES) {
      const re = new RegExp(src, 'g');
      let m;
      while ((m = re.exec(content)) !== null) { if (m[3] === 'sand') sandHere += 1; else ideHere += 1; }
    }
    st.ideMatches += ideHere; st.externalSandMatches += sandHere;
    const agg = {
      clientMarkers: clientCount, eligibilityMarkers: eligibilityCount,
      legacyClientMarkers: legacyClientCount, legacyEligibilityMarkers: legacyEligibilityCount,
      managedLocalRouteMarkers: mlr, localRuntimeLoadMarkers: lrl, directStreamMarkers: ds,
      agentHostEnablementMarkers: ahe, agentHostIdentityMarkers: ahi, moveExecMarkers: me,
      localActionsMarkers: la, subagentLocalMarkers: sl, forceApi2Markers: fa, streamShimMarkers: ss, streamH2Markers: sh2, streamTransportMarkers: stp,
      membershipMarkers: membership, modelUnlockMarkers: modelUnlock, memProMarkers: memPro,
      maxmodeMarkers: maxmode, glassfixMarkers: glassfix,
    };
    for (const k of Object.keys(agg)) st[k] += agg[k];
    const file = {
      rel: path.relative(layout.appRoot, target).split(path.sep).join('/'),
      size: buf.length,
      patched,
      client: clientCount + legacyClientCount,
      eligibility: eligibilityCount + legacyEligibilityCount + modelUnlock + memPro + maxmode,
      membership,
      stream: streamHits,
      streamAnchors,
      remainingIde: ideHere,
      external: externalHere,
      _agg: agg, _sandHere: sandHere, _streamCapable: !!(streamAnchors || streamHits),
    };
    if (stat) INSPECT_CACHE.set(cacheKey, { mtimeMs: stat.mtimeMs, size: stat.size, file });
    st.files.push(stripPrivate(file));
  }
  st.installed = (st.clientMarkers + st.eligibilityMarkers + st.legacyClientMarkers + st.legacyEligibilityMarkers +
    st.managedLocalRouteMarkers + st.localRuntimeLoadMarkers + st.directStreamMarkers +
    st.agentHostEnablementMarkers + st.agentHostIdentityMarkers + st.moveExecMarkers) > 0;
  st.streamModeInstalled = (st.managedLocalRouteMarkers > 0 && st.localRuntimeLoadMarkers > 0 &&
    st.directStreamMarkers === 0 && st.agentHostEnablementMarkers > 0 && st.agentHostIdentityMarkers > 0 && st.moveExecMarkers > 0);
  return st;
}

// ---------------- plan 构建 ----------------
function addStats(total, s) { for (const k of Object.keys(s)) total[k] = (total[k] || 0) + s[k]; return total; }
function buildInstallPlan(layout, includeStream = true) {
  const plan = {};
  const total = {};
  const memRe = new RegExp(MEMBERSHIP_SNIPPET_RE_SRC, 'g');
  for (const target of layout.targetPaths) {
    const original = readPlannedFile(target);
    let content = decodeJs(original.original);
    // 先清成干净基线，保证能在 Stream / 基础 两种模式之间正确互切（去掉可能已存在的另一种补丁）
    content = removePatchFromContent(content)[0];
    [content] = stripRpcSnippets(content);
    const isMem = MEMBERSHIP_TARGET_NAMES.includes(path.basename(target));
    if (isMem) content = content.replace(memRe, '');
    let [next, stats] = applyPatchToContent(content, includeStream);
    if (isMem) next = SAND_MEMBERSHIP_SNIPPET + next;
    if (next !== content) plan[normKey(target)] = { path: target, original: original.original, nextBytes: Buffer.from(next, 'utf8'), mode: original.mode };
    addStats(total, stats);
  }
  if (Object.keys(plan).length) { updateExtensionHashes(layout, plan); syncProductChecksums(layout, plan); }
  return { plan, total };
}
function buildUninstallPlan(layout) {
  const plan = {};
  const total = {};
  for (const target of layout.targetPaths) {
    const original = readPlannedFile(target);
    const content = decodeJs(original.original);
    const [next, stats] = removePatchFromContent(content);
    if (next !== content) plan[normKey(target)] = { path: target, original: original.original, nextBytes: Buffer.from(next, 'utf8'), mode: original.mode };
    addStats(total, stats);
  }
  if (Object.keys(plan).length) { updateExtensionHashes(layout, plan); syncProductChecksums(layout, plan); }
  return { plan, total };
}

// ---------------- 备份 / 提交 / 回滚 ----------------
function createBackup(layout, plan, operation) {
  const appHash = crypto.createHash('sha256').update(layout.appRoot).digest('hex').slice(0, 16);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = path.join(backupsRoot(), appHash, stamp + '-' + operation);
  const entries = [];
  for (const key of Object.keys(plan)) {
    const it = plan[key];
    const relative = path.relative(layout.appRoot, path.resolve(it.path));
    if (relative.startsWith('..')) throw new SandToolError('计划文件逃逸出 Cursor app：' + it.path);
    atomicWriteSync(path.join(backupDir, 'files', relative), it.original);
    entries.push({ path: relative.split(path.sep).join('/'), originalSha256: sha256hex(it.original), nextSha256: sha256hex(it.nextBytes), mode: it.mode });
  }
  const manifest = { version: 1, toolVersion: TOOL_VERSION, operation, status: 'prepared', appRoot: layout.appRoot, cursorVersion: layout.version, createdAt: new Date().toISOString(), files: entries };
  writeJsonAtomic(path.join(backupDir, 'manifest.json'), manifest);
  return { backupDir, manifest };
}
function commitPlan(layout, plan, operation, validator, onFile) {
  const keys = Object.keys(plan);
  if (!keys.length) throw new SandToolError('内部错误：提交计划为空');
  for (const k of keys) if (sha256hex(fs.readFileSync(plan[k].path)) !== sha256hex(plan[k].original)) throw new SandToolError('文件在计划生成后发生变化，已停止操作：' + plan[k].path);
  const { backupDir, manifest } = createBackup(layout, plan, operation);
  const written = [];
  const rel = (p) => path.relative(layout.appRoot, path.resolve(p)).split(path.sep).join('/');
  const fire = (phase, it, i) => { if (onFile) { try { onFile({ phase, index: i, total: keys.length, rel: rel(it.path), bytes: it.nextBytes.length, before: it.original.length }); } catch { /* ignore */ } } };
  try {
    let i = 0;
    for (const k of keys) {
      const it = plan[k];
      i += 1;
      fire('writing', it, i);
      if (sha256hex(fs.readFileSync(it.path)) !== sha256hex(it.original)) throw new SandToolError('文件在写入前发生变化，已停止操作：' + it.path);
      atomicWriteSync(it.path, it.nextBytes);
      written.push(k);
      fire('written', it, i);
    }
    validator();
    for (const k of keys) if (sha256hex(fs.readFileSync(plan[k].path)) !== sha256hex(plan[k].nextBytes)) throw new SandToolError('写入后哈希校验失败：' + plan[k].path);
    manifest.status = 'committed'; manifest.finishedAt = new Date().toISOString();
    writeJsonAtomic(path.join(backupDir, 'manifest.json'), manifest);
    return backupDir;
  } catch (exc) {
    const rollbackErrors = [];
    for (const k of [...written].reverse()) {
      const it = plan[k];
      try {
        const cur = sha256hex(fs.readFileSync(it.path));
        if (cur === sha256hex(it.original)) continue;
        if (cur !== sha256hex(it.nextBytes)) { rollbackErrors.push(it.path + ': 文件已被外部修改，未覆盖'); continue; }
        atomicWriteSync(it.path, it.original);
      } catch (re) { rollbackErrors.push(it.path + ': ' + re.message); }
    }
    manifest.status = 'rolled_back'; manifest.finishedAt = new Date().toISOString();
    manifest.error = String(exc && exc.message || exc).slice(0, 1000);
    try { writeJsonAtomic(path.join(backupDir, 'manifest.json'), manifest); } catch { /* ignore */ }
    if (rollbackErrors.length) throw new SandToolError('补丁失败且有文件未能自动回滚，请保留备份目录：' + backupDir + '\n' + (exc && exc.message || exc) + '; ' + rollbackErrors.join(' | '));
    throw exc;
  }
}

// ---------------- 关 / 开 Cursor ----------------
function runQuiet(cmd, args) { try { execFileSync(cmd, args, { timeout: 10000, windowsHide: true, stdio: 'ignore' }); } catch { /* ignore */ } }
async function closeCursor(layout) {
  const exeName = path.basename(String(layout.executable)) || (isWin ? 'Cursor.exe' : 'Cursor');
  if (isWin) {
    runQuiet('taskkill', ['/F', '/T', '/IM', exeName]);
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      let out = '';
      try { out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq ' + exeName, '/NH'], { encoding: 'utf8', timeout: 5000, windowsHide: true }); } catch { break; }
      if (!out.toLowerCase().includes(exeName.toLowerCase())) break;
      await sleep(200);
    }
    return;
  }
  if (isMac) {
    runQuiet('osascript', ['-e', 'tell application id "com.todesktop.230313mzl4w4u92" to quit']);
    await sleep(600); runQuiet('pkill', ['-x', 'Cursor']); await sleep(400);
    return;
  }
  runQuiet('pkill', ['-f', 'cursor']); await sleep(400);
}
function startCursor(layout) {
  try {
    if (isWin) {
      spawn(String(layout.executable), CURSOR_START_ARGS, { detached: true, stdio: 'ignore', windowsHide: true }).unref();
      return true;
    }
    if (isMac) {
      const bundle = findAppBundle(layout.appRoot);
      if (!bundle) return false;
      spawn('open', ['-a', bundle, '--args', ...CURSOR_START_ARGS], { detached: true, stdio: 'ignore' }).unref();
      return true;
    }
  } catch { return false; }
  return false;
}

// macOS：改完 Cursor.app 内文件后必须清除隔离属性并 ad-hoc 重签名，否则系统因签名失效拒绝启动。
function macSeal(layout) {
  if (!isMac) return;
  const bundle = findAppBundle(layout.appRoot);
  if (!bundle) return;
  for (const [cmd, args] of [
    ['xattr', ['-cr', bundle]],
    ['codesign', ['--force', '--deep', '--sign', '-', bundle]],
  ]) {
    try { execFileSync(cmd, args, { timeout: 180000, stdio: 'ignore' }); } catch { /* ignore */ }
  }
}

// ---------------- 进度 / 步骤 / 日志 事件 ----------------
// 给界面的结构化事件（对齐参考 UI 的「实时会话」）：
//   step(id, status, detail)  id ∈ locate/scan/plan/close/write/verify/restart，status ∈ running/done/skipped/failed
//   log(text)                 一行日志（含逐文件写入）
//   file(rel, status, extra)  逐文件动画：status ∈ pending/writing/written/restored/failed
//   progress(percent, message) 兼容旧进度条
// 同时把整场会话记录下来（步骤、日志、文件），结束时落盘到 last-session.json：
// 界面重启后右侧「实时会话」直接回放上一次操作，而不是一直显示「待命」。
function lastSessionPath() { return path.join(DATA_DIR, 'last-session.json'); }
function loadLastSession() { try { return JSON.parse(fs.readFileSync(lastSessionPath(), 'utf8')); } catch { return null; } }
function mkReporter(opts, operation) {
  const emit = (ev) => { try { if (opts.onEvent) opts.onEvent(ev); } catch { /* ignore */ } };
  const timers = {};
  const startedAt = Date.now();
  const session = { version: 1, operation, startedAt: new Date(startedAt).toISOString(), toolVersion: TOOL_VERSION, steps: [], logs: [], files: [], result: null };
  const stepIndex = {};
  return {
    session,
    step(id, status, detail) {
      const now = Date.now();
      if (status === 'running') timers[id] = now;
      const ms = timers[id] ? now - timers[id] : 0;
      const rec = { id, status, detail: detail || '', ms: status === 'running' ? 0 : ms, at: now - startedAt };
      if (stepIndex[id] == null) { stepIndex[id] = session.steps.length; session.steps.push(rec); } else session.steps[stepIndex[id]] = rec;
      emit({ type: 'step', ...rec });
    },
    log(text) {
      const rec = { text: String(text), at: Date.now() - startedAt };
      session.logs.push(rec);
      emit({ type: 'log', ...rec });
    },
    file(rel, status, extra) {
      const rec = Object.assign({ rel, status, at: Date.now() - startedAt }, extra || {});
      const i = session.files.findIndex((f) => f.rel === rel);
      if (i < 0) session.files.push(rec); else session.files[i] = Object.assign(session.files[i], rec);
      emit({ type: 'file', ...rec });
    },
    progress(percent, message) {
      emit({ type: 'progress', percent, message });
      try { if (opts.onProgress) opts.onProgress(percent, message); } catch { /* ignore */ }
    },
    finish(result) {
      session.finishedAt = new Date().toISOString();
      session.elapsedMs = Date.now() - startedAt;
      session.result = result;
      try { writeJsonAtomic(lastSessionPath(), session); } catch { /* ignore */ }
      emit({ type: 'session', session });
      return session;
    },
  };
}
function fmtBytes(n) { if (n < 1024) return n + ' B'; if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB'; return (n / 1024 / 1024).toFixed(1) + ' MB'; }
function summarizeStats(total) {
  const client = (total.is_glass || 0) + (total.object_header || 0) + (total.set_header || 0);
  const eligibility = (total.eligibility || 0) + (total.model_unlock || 0);
  const stream = (total.managed_local_route || 0) + (total.local_runtime_load || 0) + (total.agent_host_identity || 0) + (total.move_exec || 0) + (total.agent_host_enablement || 0)
    + (total.local_actions || 0) + (total.subagent_local || 0) + (total.force_api2 || 0) + (total.stream_shim || 0) + (total.stream_h2 || 0) + (total.stream_transport || 0);
  return { client, eligibility, stream };
}
function planFilesForUi(layout, plan) {
  return Object.keys(plan).sort().map((k) => ({
    rel: path.relative(layout.appRoot, plan[k].path).split(path.sep).join('/'),
    before: plan[k].original.length, after: plan[k].nextBytes.length,
  }));
}

// ---------------- install / uninstall ----------------
// 任何一步抛错都把错误记进会话再抛出，界面重启后也能看到「上次在哪一步失败」
async function install(layout, opts = {}) {
  const R = mkReporter(opts, 'install');
  try { return await installInner(layout, opts, R); }
  catch (e) {
    const running = R.session.steps.find((s) => s.status === 'running');
    if (running) R.step(running.id, 'failed', String(e && e.message || e).slice(0, 120));
    R.finish({ ok: false, error: String(e && e.message || e) });
    throw e;
  }
}
async function uninstall(layout, opts = {}) {
  const R = mkReporter(opts, 'uninstall');
  try { return await uninstallInner(layout, opts, R); }
  catch (e) {
    const running = R.session.steps.find((s) => s.status === 'running');
    if (running) R.step(running.id, 'failed', String(e && e.message || e).slice(0, 120));
    R.finish({ ok: false, error: String(e && e.message || e) });
    throw e;
  }
}
async function installInner(layout, opts, R) {
  const t0 = Date.now();

  R.step('locate', 'running');
  R.log(`Cursor ${layout.version} · ${layout.installRoot}`);
  R.log(`可执行文件 ${layout.executable}`);
  R.log(`目标文件 ${layout.targetPaths.length} 个（含 agent-host dist 动态扫描）`);
  R.step('locate', 'done', `Cursor ${layout.version}`);
  R.progress(5, '定位 Cursor…');

  R.step('scan', 'running');
  const before = inspectStatus(layout);
  if (before.externalMarkerCount) {
    R.step('scan', 'failed', `发现 ${before.externalMarkerCount} 处别的工具留下的标记`);
    throw new SandToolError(`发现 ${before.externalMarkerCount} 处别的工具留下的标记。这里不会去接管或覆盖它们，请先用原来的方式卸载。`);
  }
  R.log(before.installed
    ? `当前已有补丁：客户端标识 ${before.clientMarkers + before.legacyClientMarkers} · 资格与会员 ${before.eligibilityMarkers + before.modelUnlockMarkers + before.memProMarkers + before.maxmodeMarkers} · Stream ${before.streamModeInstalled ? '完整' : (before.streamCapable ? '不完整' : '无')}`
    : `当前未打补丁；未接管的 client-type 位点 ${before.ideMatches} 处`);
  R.step('scan', 'done', before.installed ? '已有补丁，将刷新' : '干净');
  R.progress(15, '扫描当前状态…');

  R.step('plan', 'running');
  // 先按「含 Stream」试算；五类锚点各命中 ≥1 就打 Stream（1.1.8 规则，不再要求精确 (1,1,1,1,2)），
  // 否则降级为「只打基础 sand 补丁」（全或无，绝不打半套）。
  let { plan, total } = buildInstallPlan(layout, true);
  const streamHits = {
    route: total.managed_local_route || 0, runtimeLoad: total.local_runtime_load || 0,
    identity: total.agent_host_identity || 0, moveExec: total.move_exec || 0, agentHost: total.agent_host_enablement || 0,
  };
  // 1.2.1 本地回路准入（修 auth error）：这两条是「命中就打、缺了不算半装」的加分项，不纳入 streamComplete 门槛，
  // 免得旧构建（没有这两个锚点）被误判成不完整而降级基础模式。
  const localAdmit = { localActions: total.local_actions || 0, subagentLocal: total.subagent_local || 0, forceApi2: total.force_api2 || 0, streamShim: total.stream_shim || 0, streamH2: total.stream_h2 || 0, streamTransport: total.stream_transport || 0 };
  const streamComplete = Object.values(streamHits).every((v) => v >= 1);
  const streamAny = Object.values(streamHits).some((v) => v >= 1);
  let wantStream = streamComplete;
  let streamReason = '';
  if (opts.preferStream === false) { wantStream = false; streamReason = '用户选择基础模式'; }
  else if (!streamComplete) {
    streamReason = streamAny
      ? `Stream 锚点不完整（route=${streamHits.route} runtimeLoad=${streamHits.runtimeLoad} identity=${streamHits.identity} moveExec=${streamHits.moveExec} agentHost=${streamHits.agentHost}），拒绝半装，降级基础模式`
      : '当前 Cursor 版本没有 Stream 锚点，使用基础模式';
  }
  if (!wantStream) ({ plan, total } = buildInstallPlan(layout, false));
  const sum = summarizeStats(total);
  const files = planFilesForUi(layout, plan);
  if (wantStream) R.log(`Stream 模式 ${sum.stream} 处锚点：route=${streamHits.route} runtimeLoad=${streamHits.runtimeLoad} identity=${streamHits.identity} moveExec=${streamHits.moveExec} agentHost=${streamHits.agentHost} · 本地回路准入 localActions=${localAdmit.localActions} subagentLocal=${localAdmit.subagentLocal} forceApi2=${localAdmit.forceApi2} · Stream 垫片 streamShim=${localAdmit.streamShim} streamTransport=${localAdmit.streamTransport} streamH2=${localAdmit.streamH2}`);
  if (wantStream && !localAdmit.streamShim) R.log('注意：未命中 Stream 垫片锚点（RunInference→Stream）。若客户端聊天报 "Sand traffic is not supported on this endpoint"，说明此 Cursor 构建的 createPromptSession 形状变了，需要更新工具。');
  if (wantStream && localAdmit.streamShim && (!localAdmit.streamH2 || !localAdmit.streamTransport)) R.log(`注意：Stream 专用 H2 传输未完整命中（transport=${localAdmit.streamTransport} route=${localAdmit.streamH2}），将回落 HTTP/1.1 默认传输；长上下文对话可能更容易出现 Connection Error，需要更新工具。`);
  else R.log(streamReason);
  R.log(`改写计划：客户端标识 ${sum.client} 处 · 资格与会员 ${sum.eligibility} 处 · 会员伪装注入 ${MEMBERSHIP_TARGET_NAMES.filter((n) => files.some((f) => f.rel.endsWith('/' + n))).length} 处 · 共改 ${files.length} 个文件`);
  for (const f of files) { R.log(`  ↳ ${f.rel}  (${fmtBytes(f.before)} → ${fmtBytes(f.after)})`); R.file(f.rel, 'pending', { before: f.before, after: f.after }); }
  R.step('plan', 'done', `${files.length} 个文件`);
  R.progress(25, '生成改写计划…');

  if (!Object.keys(plan).length) {
    if (before.installed) {
      R.step('close', 'running'); await closeCursor(layout); R.step('close', 'done');
      R.step('write', 'skipped', '已是最新，无需改动');
      R.step('verify', 'skipped');
      R.progress(90, '配置 HTTP/2…'); if (opts.beforeStart) await opts.beforeStart(layout);
      R.step('restart', 'running'); const ok = startCursor(layout); R.step('restart', ok ? 'done' : 'failed');
      R.progress(100, '完成（已是最新，无需改动）');
      const res = { ok: true, noop: true, streamMode: before.streamModeInstalled, basicMode: before.installed && !before.streamModeInstalled, files: [], elapsedMs: Date.now() - t0 };
      R.finish(res);
      return res;
    }
    R.step('plan', 'failed', '没有命中任何规则');
    throw new SandToolError('当前 Cursor 版本未匹配到 Sand 补丁规则（连基础 client-type 锚点都没命中，可能 Cursor 版本差异过大或使用了 app.asar 打包）');
  }

  R.step('close', 'running');
  await closeCursor(layout);
  R.step('close', 'done');
  R.progress(35, '关闭 Cursor…');

  const changedExt = plannedExtensionNames(layout, plan);
  const validator = () => {
    const status = inspectStatus(layout);
    if (!status.installed || status.ideMatches !== 0 || status.externalMarkerCount !== 0 ||
      status.legacyClientMarkers !== 0 || status.legacyEligibilityMarkers !== 0) {
      throw new SandToolError('安装后状态校验失败：' + `installed=${status.installed}, remainingIde=${status.ideMatches}`);
    }
    if (wantStream && !status.streamModeInstalled) throw new SandToolError('Stream 模式安装后校验失败（五件套未全部生效）');
    verifyExtensionHashes(layout, changedExt);
    verifyProductChecksums(layout);
  };
  R.step('write', 'running');
  const n = files.length;
  let backupDir;
  try {
    backupDir = commitPlan(layout, plan, 'install', validator, (f) => {
      if (f.phase === 'writing') { R.file(f.rel, 'writing'); R.progress(35 + Math.round(((f.index - 1) / n) * 40), `写入 ${f.rel}`); return; }
      R.file(f.rel, 'written', { after: f.bytes });
      R.log(`已写入 ${f.rel}  (${f.index}/${f.total})`);
      R.progress(35 + Math.round((f.index / n) * 40), `写入 ${f.rel}`);
    });
  } catch (e) {
    // commitPlan 已按备份整体回滚；把每个文件标成「已回滚」让界面动画收尾
    for (const f of files) R.file(f.rel, 'rolledback');
    R.log('写入或校验失败，已按备份整体回滚：' + (e && e.message || e));
    throw e;
  }
  R.log(`备份目录 ${backupDir}`);
  R.step('write', 'done', `${n} 个文件`);

  R.step('verify', 'running');
  R.log('改写、扩展哈希、product.json 完整性三项校验全部通过');
  macSeal(layout);
  await closeCursor(layout);
  R.step('verify', 'done');
  R.progress(85, '校验完整性…');

  R.progress(90, '配置 HTTP/2…');
  if (opts.beforeStart) await opts.beforeStart(layout);
  R.step('restart', 'running');
  const started = startCursor(layout);
  R.step('restart', started ? 'done' : 'failed', started ? '' : '未能自动拉起，请手动打开');
  R.progress(100, wantStream ? '完成（Stream 模式）' : '完成（基础模式）');
  R.log(`完成：${wantStream ? 'Stream 模式' : '基础模式'}，共改 ${n} 个文件，用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  const res = { ok: true, streamMode: wantStream, basicMode: !wantStream, streamReason, files, backupDir, elapsedMs: Date.now() - t0 };
  R.finish(res);
  return res;
}

async function uninstallInner(layout, opts, R) {
  const t0 = Date.now();
  R.step('locate', 'running');
  R.log(`Cursor ${layout.version} · ${layout.installRoot}`);
  R.step('locate', 'done', `Cursor ${layout.version}`);
  R.progress(8, '定位 Cursor…');

  R.step('scan', 'running');
  const before = inspectStatus(layout);
  if (before.externalMarkerCount) { R.step('scan', 'failed', '有无法识别的标记'); throw new SandToolError('检测到无法识别的 Sand 模式标记，拒绝修改；请先用原安装方式卸载'); }
  R.log(`当前补丁文件 ${before.patchedFiles.length} 个`);
  R.step('scan', 'done', `${before.patchedFiles.length} 个文件带补丁`);
  R.progress(20, '扫描当前状态…');

  R.step('plan', 'running');
  const { plan } = buildUninstallPlan(layout);
  const files = planFilesForUi(layout, plan);
  for (const f of files) { R.log(`  ↳ 还原 ${f.rel}  (${fmtBytes(f.before)} → ${fmtBytes(f.after)})`); R.file(f.rel, 'pending', { before: f.before, after: f.after }); }
  R.step('plan', 'done', `${files.length} 个文件`);
  R.progress(30, '生成还原计划…');
  if (!Object.keys(plan).length) {
    R.step('close', 'skipped'); R.step('write', 'skipped', '本机没有补丁'); R.step('verify', 'skipped');
    R.step('restart', 'running'); const ok = startCursor(layout); R.step('restart', ok ? 'done' : 'failed');
    R.progress(100, '完成（本机没有补丁，无需改动）');
    const res = { ok: true, noop: true, files: [], elapsedMs: Date.now() - t0 };
    R.finish(res);
    return res;
  }

  R.step('close', 'running'); await closeCursor(layout); R.step('close', 'done'); R.progress(40, '关闭 Cursor…');
  const changedExt = plannedExtensionNames(layout, plan);
  const validator = () => {
    const status = inspectStatus(layout);
    if (status.installed || status.externalMarkerCount) throw new SandToolError('卸载后仍有 Sand marker');
    verifyExtensionHashes(layout, changedExt);
    verifyProductChecksums(layout);
  };
  R.step('write', 'running');
  const n = files.length;
  let backupDir;
  try {
    backupDir = commitPlan(layout, plan, 'uninstall', validator, (f) => {
      if (f.phase === 'writing') { R.file(f.rel, 'writing'); R.progress(40 + Math.round(((f.index - 1) / n) * 40), `还原 ${f.rel}`); return; }
      R.file(f.rel, 'restored', { after: f.bytes });
      R.log(`已还原 ${f.rel}  (${f.index}/${f.total})`);
      R.progress(40 + Math.round((f.index / n) * 40), `还原 ${f.rel}`);
    });
  } catch (e) {
    for (const f of files) R.file(f.rel, 'rolledback');
    R.log('还原或校验失败，已按备份整体回滚：' + (e && e.message || e));
    throw e;
  }
  R.log(`备份目录 ${backupDir}`);
  R.step('write', 'done', `${n} 个文件`);
  R.step('verify', 'running'); macSeal(layout); await closeCursor(layout); R.step('verify', 'done'); R.progress(88, '校验完整性…');
  R.step('restart', 'running'); const started = startCursor(layout); R.step('restart', started ? 'done' : 'failed', started ? '' : '未能自动拉起，请手动打开');
  R.progress(100, '完成（已回退）');
  R.log(`完成：已回退 ${n} 个文件，用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  const res = { ok: true, files, backupDir, elapsedMs: Date.now() - t0 };
  R.finish(res);
  return res;
}

// ---------------- 单文件「改了哪几处」：当前文件 vs 干净基线，按 marker 定位每处改动 ----------------
// 基线来源：最近一次 install 备份里的原件；没有备份就用 removePatchFromContent(当前) 反推（补丁保留原片段为死代码，可精确还原）。
const MARKER_LABELS = {
  SAND_CLIENT_MODE_V1: ['客户端标识', 'x-cursor-client-type: ide → sand'],
  SAND_CLIENT_EXISTING_V1: ['客户端标识', '原本就是 sand，打标记接管'],
  SAND_HDRFIX_V2: ['客户端标识', 'header.set(x-cursor-client-type) 改成按请求分流：AgentService 出 ide，其余出 sand'],
  SAND_GLASSFIX_V1: ['客户端标识', 'glass UI 真分支 glass → sand'],
  SAND_ELIGIBILITY_MODE_V1: ['资格与会员', '资格判定函数开头注入 return!1（短路）'],
  SAND_MODEL_UNLOCK_V1: ['资格与会员', '模型选择器 FREE 锁定判定短路'],
  SAND_MEM_PRO_V1: ['资格与会员', '_membershipType 恒返回 enterprise'],
  SAND_MAXMODE_V1: ['资格与会员', 'hasValidPaymentMethod 恒返回 true（Max mode 解锁）'],
  SAND_MEMBERSHIP_SPOOF_V1: ['会员伪装', '文件头注入 fetch hook：会员/用量响应改 enterprise、模型列表 defaultOn'],
  SAND_MANAGED_LOCAL_ROUTE_V1: ['Stream', '路由无条件返回 managed-local，原三元判定保留为死代码'],
  SAND_LOCAL_RUNTIME_LOAD_V1: ['Stream', '本地 loop runtime 强制加载（gate 判定前注入 =!0）'],
  SAND_AGENT_HOST_IDENTITY_V1: ['Stream', 'agent-host clientType ide → sand'],
  SAND_MOVE_EXEC_V1: ['Stream', 'move_exec 网关短路为真（原 gate 保留在 || 之后）'],
  SAND_AGENT_HOST_ENABLEMENT_V1: ['Stream', '强制开启 agent-host'],
  SAND_LOCAL_ACTIONS_V1: ['Stream', '本地回路准入放宽：后台任务/命令/计划等 turn 走本地 sand（修 auth error）'],
  SAND_SUBAGENT_LOCAL_V1: ['Stream', '子代理 runOptions 短路：子代理 turn 留在本地 sand 回路（修 auth error）'],
  SAND_FORCE_API2_V1: ['Stream', 'sand 流量强制走 api2 端点（HTTP/2 传输也归一到 api2）'],
  SAND_STREAM_SHIM_V1: ['Stream', '文件头注入 RunInference→Stream 垫片：managed-local 推理改走 InferenceService/Stream（修 "Sand traffic is not supported on this endpoint"）'],
  SAND_STREAM_SHIM_END: ['Stream', 'RunInference→Stream 垫片块结束'],
  SAND_STREAM_SHIM_HOOK_V1: ['Stream', 'createPromptSession attempt 开头：inference client 换成垫片包装（runInference 走本地模拟，实际调 Stream）'],
  SAND_STREAM_TRANSPORT_V1: ['Stream', '给 Stream 单独建一条 H2 传输（api2，显式 PING：15s 一次 / 60s 超时 / 空闲 5min 回收），不依赖 Statsig 下发'],
  SAND_STREAM_H2_V1: ['Stream', 'InferenceService/Stream 路由到专用 H2 传输（修长对话 Connection Error；专用传输缺失或关 H2 时回落 _backendTransport）'],
  SAND_AGENTEXEC_KEEP_V1: ['Stream', '（旧版残留）agent-exec 等待保留'],
  SAND_DIRECT_INFERENCE_STREAM_V1: ['Stream', '（旧版残留）createPromptSession 短路'],
  SAND_AGENT_IDE_V1: ['Stream', 'agent Run 出站前把 client-type 改回 ide'],
  SAND_RPC_REWRITE_V1: ['Stream', 'RPC 路径改写（Stream ↔ Agent Run）'],
  SAND_TRANSPORT_HOST_V1: ['Stream', 'Stream 传输主机切到 _backendTransport'],
  SAND_STREAM_WRAP_V1: ['Stream', 'Stream 包装还原'],
  SAND_STREAM_HOOK_V1: ['Stream', '（旧版残留）手写 fetch 桥'],
  // 下面这些不是本工具产生的，是这台 Cursor 被别的工具/更新版打过留下的（SandClaimer 更早的实现路线）
  SAND_SUBAGENT_FOLLOWUP_V1: ['其它工具', '子代理后台任务完成后的后续动作处理'],
  SAND_SUBAGENT_TURN_V1: ['其它工具', '子代理回合判定'],
  SAND_CLIENT_SIDE_SUBAGENT_V1: ['其它工具', 'useClientSideSubagent 强制开'],
  SAND_TASK_TOOL_V1: ['其它工具', 'getTaskToolConfig 覆盖'],
  SAND_MAX_TOKENS_V1: ['其它工具', 'maxTokens 覆盖'],
};
function fileChanges(rel, opts = {}) {
  const layout = resolveCursorLayout();
  const abs = path.resolve(path.join(layout.appRoot, ...rel.split('/')));
  if (!isWithin(abs, layout.appRoot)) throw new SandToolError('路径越界');
  if (!fs.existsSync(abs)) throw new SandToolError('文件不存在：' + rel);
  const current = decodeJs(fs.readFileSync(abs));
  const ctx = Math.max(20, Math.min(200, opts.context || 80));
  // 逐个 marker 定位改动点，抽上下文
  const re = /\/\*(SAND_[A-Z0-9_]+?)(?:_V1|_V2)?\*\//g;
  const hunks = [];
  let m;
  while ((m = re.exec(current)) !== null && hunks.length < 400) {
    const full = m[0];
    const key = full.slice(2, -2);
    const [cat, desc] = MARKER_LABELS[key] || ['其它工具', key + '（非本工具产生）'];
    const start = Math.max(0, m.index - ctx);
    const end = Math.min(current.length, m.index + full.length + ctx);
    hunks.push({ offset: m.index, marker: key, category: cat, desc, before: current.slice(start, m.index), mark: full, after: current.slice(m.index + full.length, end), line: current.slice(0, m.index).split('\n').length });
  }
  // 会员伪装注入在文件头：单独给一条（marker 在开头，上面循环已收进去；这里补 IIFE 长度）
  const memIdx = current.indexOf(M.SAND_MEMBERSHIP_MARKER);
  let membershipSnippetLen = 0;
  if (memIdx >= 0) { const mm = new RegExp(MEMBERSHIP_SNIPPET_RE_SRC).exec(current.slice(memIdx)); if (mm) membershipSnippetLen = mm[0].length; }
  // 与干净基线的字节差：先找最近一次 install 备份里的原件（免费），找不到才反推（大文件要几秒）
  let baselineLen = null; let baselineSource = null;
  try {
    const appHash = crypto.createHash('sha256').update(layout.appRoot).digest('hex').slice(0, 16);
    const root = path.join(backupsRoot(), appHash);
    if (fs.existsSync(root)) {
      const dirs = fs.readdirSync(root).filter((d) => d.endsWith('-install')).sort().reverse();
      for (const d of dirs) {
        const f = path.join(root, d, 'files', ...rel.split('/'));
        if (fs.existsSync(f)) { baselineLen = fs.statSync(f).size; baselineSource = 'backup'; break; }
      }
    }
    if (baselineLen == null && opts.reverse !== false && current.length < 12 * 1024 * 1024) {
      const [restored] = removePatchFromContent(current);
      baselineLen = Buffer.byteLength(restored, 'utf8'); baselineSource = 'reverse';
    }
  } catch { /* ignore */ }
  const byCat = {};
  for (const h of hunks) byCat[h.category] = (byCat[h.category] || 0) + 1;
  return {
    ok: true, rel, abs, size: Buffer.byteLength(current, 'utf8'), baselineSize: baselineLen, baselineSource,
    membershipSnippetLen, total: hunks.length, byCategory: byCat, hunks,
  };
}

// ---------------- 给 UI 的高层封装 ----------------
function runningCursorProcesses(layout) {
  try {
    const exeName = path.basename(String(layout.executable));
    if (isWin) {
      const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq ' + exeName, '/NH', '/FO', 'CSV'], { encoding: 'utf8', timeout: 5000, windowsHide: true });
      return out.split(/\r?\n/).filter((l) => l.toLowerCase().includes(exeName.toLowerCase())).length;
    }
    const out = execFileSync('pgrep', ['-x', exeName], { encoding: 'utf8', timeout: 5000 });
    return out.split(/\r?\n/).filter(Boolean).length;
  } catch { return 0; }
}
function patchStatus(opts = {}) {
  let layout;
  try { layout = resolveCursorLayout(); }
  catch (e) { return { ok: false, error: e.message }; }
  try {
    const st = inspectStatus(layout);
    const eligibilityTotal = st.eligibilityMarkers + st.legacyEligibilityMarkers + st.modelUnlockMarkers + st.memProMarkers + st.maxmodeMarkers;
    const streamTotal = st.managedLocalRouteMarkers + st.localRuntimeLoadMarkers + st.agentHostIdentityMarkers + st.moveExecMarkers + st.agentHostEnablementMarkers;
    return {
      ok: true, version: layout.version, path: layout.installRoot, appRoot: layout.appRoot, executable: layout.executable,
      toolVersion: TOOL_VERSION,
      installed: st.installed, streamMode: st.streamModeInstalled, streamCapable: st.streamCapable,
      client: st.clientMarkers + st.legacyClientMarkers,
      eligibility: eligibilityTotal,
      membership: st.membershipMarkers,
      stream: streamTotal,
      streamDetail: { route: st.managedLocalRouteMarkers, runtimeLoad: st.localRuntimeLoadMarkers, identity: st.agentHostIdentityMarkers, moveExec: st.moveExecMarkers, agentHost: st.agentHostEnablementMarkers, legacyDirect: st.directStreamMarkers },
      remainingIde: st.ideMatches,
      external: st.externalMarkerCount,
      legacy: st.legacyClientMarkers + st.legacyEligibilityMarkers,
      processes: opts.withProcesses === false ? null : runningCursorProcesses(layout),
      files: st.files,
      patchedFileCount: st.patchedFiles.length,
    };
  } catch (e) { return { ok: false, error: e.message, version: layout.version, path: layout.installRoot }; }
}
async function applyPatch(opts) {
  invalidateLayoutCache();
  const layout = resolveCursorLayout({ fresh: true });
  return install(layout, opts);
}
async function restorePatch(opts) {
  invalidateLayoutCache();
  const layout = resolveCursorLayout({ fresh: true });
  return uninstall(layout, opts);
}
function setCursorPath(p) {
  saveCursorPath((p || '').trim() || 'auto');
  invalidateLayoutCache();
  return patchStatus();
}

// 给界面：把相对路径解析成绝对路径（校验在 appRoot 内），供「在资源管理器中显示」
function resolveTargetAbs(rel) {
  const layout = resolveCursorLayout();
  const abs = path.resolve(path.join(layout.appRoot, ...String(rel || '').split('/')));
  if (!isWithin(abs, layout.appRoot) || !fs.existsSync(abs)) throw new SandToolError('文件不存在或越界：' + rel);
  return abs;
}

module.exports = {
  setConfigDir, resolveCursorLayout, invalidateLayoutCache, layoutFromPath, saveCursorPath, inspectStatus,
  install, uninstall, closeCursor, startCursor, patchStatus, applyPatch, restorePatch, setCursorPath,
  buildInstallPlan, buildUninstallPlan, SandToolError, TOOL_VERSION,
  loadLastSession, fileChanges, resolveTargetAbs,
};
