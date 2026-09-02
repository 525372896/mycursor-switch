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
  TARGET_SPECS, EXT_HOST_REL, MEMBERSHIP_TARGET_NAMES, SAND_MEMBERSHIP_SNIPPET,
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
function resolveCursorLayout() {
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
function inspectStatus(layout) {
  const st = {
    clientMarkers: 0, eligibilityMarkers: 0, legacyClientMarkers: 0, legacyEligibilityMarkers: 0,
    managedLocalRouteMarkers: 0, localRuntimeLoadMarkers: 0, directStreamMarkers: 0,
    agentHostEnablementMarkers: 0, agentHostIdentityMarkers: 0, moveExecMarkers: 0,
    ideMatches: 0, externalSandMatches: 0, externalMarkerCount: 0, streamCapable: false, patchedFiles: [],
  };
  const clientGuardRe = new RegExp(CLIENT_MARKER_GUARD_PATTERN, 'g');
  const eligGuardRe = new RegExp(ELIGIBILITY_MARKER_GUARD_PATTERN, 'g');
  const legacyClientRe = new RegExp('(["\'])sand\\1' + escapeRegExp(M.LEGACY_SAND_CLIENT_MARKER), 'g');
  for (const target of layout.targetPaths) {
    const content = decodeJs(fs.readFileSync(target));
    if (contentHasStreamAnchors(content) ||
      content.includes(M.SAND_MANAGED_LOCAL_ROUTE_MARKER) || content.includes(M.SAND_LOCAL_RUNTIME_LOAD_MARKER) ||
      content.includes(M.SAND_DIRECT_STREAM_MARKER) || content.includes(M.SAND_AGENT_HOST_ENABLEMENT_MARKER) ||
      content.includes(M.SAND_AGENT_HOST_IDENTITY_MARKER) || content.includes(M.SAND_MOVE_EXEC_MARKER)) {
      st.streamCapable = true;
    }
    const clientCount = countOcc(content, M.SAND_CLIENT_MARKER) + countOcc(content, M.SAND_CLIENT_EXISTING_MARKER) + countOcc(content, M.SAND_HDRFIX_V2_MARKER);
    const eligibilityCount = countOcc(content, M.SAND_ELIGIBILITY_MARKER);
    const mlr = countOcc(content, M.SAND_MANAGED_LOCAL_ROUTE_MARKER);
    const lrl = countOcc(content, M.SAND_LOCAL_RUNTIME_LOAD_MARKER);
    const ds = countOcc(content, M.SAND_DIRECT_STREAM_MARKER);
    const ahe = countOcc(content, M.SAND_AGENT_HOST_ENABLEMENT_MARKER);
    const ahi = countOcc(content, M.SAND_AGENT_HOST_IDENTITY_MARKER);
    const me = countOcc(content, M.SAND_MOVE_EXEC_MARKER);
    const legacyClientCount = (content.match(legacyClientRe) || []).length;
    const legacyEligibilityCount = countOcc(content, 'return!1;' + M.LEGACY_SAND_ELIGIBILITY_MARKER);
    st.externalMarkerCount += Math.max(0, (content.match(clientGuardRe) || []).length - clientCount - legacyClientCount);
    st.externalMarkerCount += Math.max(0, (content.match(eligGuardRe) || []).length - eligibilityCount - legacyEligibilityCount);
    if (clientCount + eligibilityCount + legacyClientCount + legacyEligibilityCount + mlr + lrl + ds + ahe + ahi + me) st.patchedFiles.push(target);
    st.clientMarkers += clientCount; st.eligibilityMarkers += eligibilityCount;
    st.legacyClientMarkers += legacyClientCount; st.legacyEligibilityMarkers += legacyEligibilityCount;
    st.managedLocalRouteMarkers += mlr; st.localRuntimeLoadMarkers += lrl; st.directStreamMarkers += ds;
    st.agentHostEnablementMarkers += ahe; st.agentHostIdentityMarkers += ahi; st.moveExecMarkers += me;
    for (const [, src] of CLIENT_RULES) {
      const re = new RegExp(src, 'g');
      let m;
      while ((m = re.exec(content)) !== null) { if (m[3] === 'sand') st.externalSandMatches += 1; else st.ideMatches += 1; }
    }
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
function commitPlan(layout, plan, operation, validator) {
  const keys = Object.keys(plan);
  if (!keys.length) throw new SandToolError('内部错误：提交计划为空');
  for (const k of keys) if (sha256hex(fs.readFileSync(plan[k].path)) !== sha256hex(plan[k].original)) throw new SandToolError('文件在计划生成后发生变化，已停止操作：' + plan[k].path);
  const { backupDir, manifest } = createBackup(layout, plan, operation);
  const written = [];
  try {
    for (const k of keys) {
      const it = plan[k];
      if (sha256hex(fs.readFileSync(it.path)) !== sha256hex(it.original)) throw new SandToolError('文件在写入前发生变化，已停止操作：' + it.path);
      atomicWriteSync(it.path, it.nextBytes);
      written.push(k);
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

// ---------------- install / uninstall ----------------
async function install(layout, opts = {}) {
  const prog = (p, m) => { try { if (opts.onProgress) opts.onProgress(p, m); } catch (e) { /* ignore */ } };
  prog(5, '检测本机 Cursor…');
  const before = inspectStatus(layout);
  if (before.externalMarkerCount) throw new SandToolError('检测到其他 Sand 模式标记，本工具不会接管或覆盖它；请先用原安装方式卸载');
  prog(15, '生成补丁方案…');
  // 先按「含 Stream」试算；能凑齐五件套就打 Stream，否则降级为「只打基础 sand 补丁」（全或无，绝不打半套）。
  let { plan, total } = buildInstallPlan(layout, true);
  const streamHits = [
    before.managedLocalRouteMarkers + total.managed_local_route,
    before.localRuntimeLoadMarkers + total.local_runtime_load,
    before.agentHostIdentityMarkers + total.agent_host_identity,
    before.moveExecMarkers + total.move_exec,
    before.agentHostEnablementMarkers + total.agent_host_enablement,
  ];
  const want = [1, 1, 1, 1, 2];
  let wantStream = before.streamModeInstalled || want.every((v, i) => streamHits[i] === v);
  if (!wantStream) {
    // 降级：跳过五件套，只打基础 sand 补丁（client-type 等版本无关部分）
    ({ plan, total } = buildInstallPlan(layout, false));
  }
  if (!Object.keys(plan).length) {
    if (before.installed) {
      prog(35, '关闭 Cursor…'); await closeCursor(layout);
      prog(90, '配置 HTTP/2…'); if (opts.beforeStart) await opts.beforeStart(layout);
      prog(95, '重启 Cursor…'); startCursor(layout);
      prog(100, '完成（已是最新，无需改动）');
      return { ok: true, noop: true, streamMode: before.streamModeInstalled, basicMode: before.installed && !before.streamModeInstalled };
    }
    throw new SandToolError('当前 Cursor 版本未匹配到 Sand 补丁规则（连基础 client-type 锚点都没命中，可能 Cursor 版本差异过大或使用了 app.asar 打包）');
  }
  prog(35, '关闭 Cursor…');
  await closeCursor(layout);
  const changedExt = plannedExtensionNames(layout, plan);
  const validator = () => {
    const status = inspectStatus(layout);
    if (!status.installed || status.ideMatches !== 0 || status.externalMarkerCount !== 0 ||
      status.legacyClientMarkers !== 0 || status.legacyEligibilityMarkers !== 0) {
      throw new SandToolError('安装后状态校验失败：' +
        `installed=${status.installed}, remainingIde=${status.ideMatches}`);
    }
    if (wantStream && !status.streamModeInstalled) {
      throw new SandToolError('Stream 模式安装后校验失败（五件套未全部生效）');
    }
    verifyExtensionHashes(layout, changedExt);
    verifyProductChecksums(layout);
  };
  prog(55, '备份并写入补丁…');
  commitPlan(layout, plan, 'install', validator);
  prog(80, '校验完整性…');
  macSeal(layout);
  await closeCursor(layout);
  prog(90, '配置 HTTP/2…');
  if (opts.beforeStart) await opts.beforeStart(layout);
  prog(95, '重启 Cursor…');
  startCursor(layout);
  prog(100, '完成');
  return { ok: true, streamMode: wantStream, basicMode: !wantStream };
}
async function uninstall(layout, opts = {}) {
  const prog = (p, m) => { try { if (opts.onProgress) opts.onProgress(p, m); } catch (e) { /* ignore */ } };
  prog(8, '检测本机 Cursor…');
  const before = inspectStatus(layout);
  if (before.externalMarkerCount) throw new SandToolError('检测到无法识别的 Sand 模式标记，拒绝修改；请先用原安装方式卸载');
  prog(25, '生成回退方案…');
  const { plan } = buildUninstallPlan(layout);
  if (!Object.keys(plan).length) { prog(95, '重启 Cursor…'); startCursor(layout); prog(100, '完成（本机没有补丁，无需改动）'); return { ok: true, noop: true }; }
  prog(45, '关闭 Cursor…');
  await closeCursor(layout);
  const changedExt = plannedExtensionNames(layout, plan);
  const validator = () => {
    const status = inspectStatus(layout);
    if (status.installed || status.externalMarkerCount) throw new SandToolError('卸载后仍有 Sand marker');
    verifyExtensionHashes(layout, changedExt);
    verifyProductChecksums(layout);
  };
  prog(70, '还原文件…');
  commitPlan(layout, plan, 'uninstall', validator);
  prog(85, '校验完整性…');
  macSeal(layout);
  await closeCursor(layout);
  prog(95, '重启 Cursor…');
  startCursor(layout);
  prog(100, '完成');
  return { ok: true };
}

// ---------------- 给 UI 的高层封装 ----------------
function patchStatus() {
  let layout;
  try { layout = resolveCursorLayout(); }
  catch (e) { return { ok: false, error: e.message }; }
  try {
    const st = inspectStatus(layout);
    return {
      ok: true, version: layout.version, path: layout.installRoot,
      installed: st.installed, streamMode: st.streamModeInstalled, streamCapable: st.streamCapable,
      client: st.clientMarkers + st.legacyClientMarkers, eligibility: st.eligibilityMarkers + st.legacyEligibilityMarkers,
    };
  } catch (e) { return { ok: false, error: e.message, version: layout.version, path: layout.installRoot }; }
}
async function applyPatch(opts) {
  const layout = resolveCursorLayout();
  return install(layout, opts);
}
async function restorePatch(opts) {
  const layout = resolveCursorLayout();
  return uninstall(layout, opts);
}
function setCursorPath(p) {
  saveCursorPath((p || '').trim() || 'auto');
  return patchStatus();
}

module.exports = {
  setConfigDir, resolveCursorLayout, layoutFromPath, saveCursorPath, inspectStatus,
  install, uninstall, closeCursor, startCursor, patchStatus, applyPatch, restorePatch, setCursorPath,
  buildInstallPlan, buildUninstallPlan, SandToolError,
};
