'use strict';
// Cursor Sand 客户端模式补丁引擎 —— 从 SandClaimer 的 sand_patch.py(1.1.5）1:1 移植到 Node。
//
// 目标：给本机 Cursor 打「Sand Stream 客户端模式」补丁（client-type=sand + 资格/会员/模型/Max
// mode 绕过 + managed-local Stream 五件套），并同步回写 product.json 完整性校验值与
// extensionHost 内嵌扩展哈希；支持备份 / 校验 / 失败回滚 / 一键回退。
//
// 所有 marker、注入片段字面量、目标文件清单、apply/remove 顺序均与 sand_patch.py 完全一致，
// 打出的补丁与 SandClaimer 逐字节相同、可互相识别与卸载。

const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync, spawn } = require('child_process');

const TOOL_VERSION = '1.1.5';
const CONFIG_VERSION = 1;

// ---------------- markers ----------------
const SAND_CLIENT_MARKER = '/*SAND_CLIENT_MODE_V1*/';
const SAND_CLIENT_EXISTING_MARKER = '/*SAND_CLIENT_EXISTING_V1*/';
const SAND_ELIGIBILITY_MARKER = '/*SAND_ELIGIBILITY_MODE_V1*/';
const SAND_MODEL_UNLOCK_MARKER = '/*SAND_MODEL_UNLOCK_V1*/';
const SAND_MEM_PRO_MARKER = '/*SAND_MEM_PRO_V1*/';
const SAND_MAXMODE_MARKER = '/*SAND_MAXMODE_V1*/';
const SAND_GLASSFIX_MARKER = '/*SAND_GLASSFIX_V1*/';
const SAND_HDRFIX_MARKER = '/*SAND_HDRFIX_V1*/';
const SAND_HDRFIX_V2_MARKER = '/*SAND_HDRFIX_V2*/';
const SAND_MEMBERSHIP_MARKER = '/*SAND_MEMBERSHIP_SPOOF_V1*/';
const SAND_MANAGED_LOCAL_ROUTE_MARKER = '/*SAND_MANAGED_LOCAL_ROUTE_V1*/';
const SAND_DIRECT_STREAM_MARKER = '/*SAND_DIRECT_INFERENCE_STREAM_V1*/';
const SAND_AGENT_HOST_ENABLEMENT_MARKER = '/*SAND_AGENT_HOST_ENABLEMENT_V1*/';
const SAND_LOCAL_RUNTIME_LOAD_MARKER = '/*SAND_LOCAL_RUNTIME_LOAD_V1*/';
const SAND_AGENT_HOST_IDENTITY_MARKER = '/*SAND_AGENT_HOST_IDENTITY_V1*/';
const SAND_AGENTEXEC_KEEP_MARKER = '/*SAND_AGENTEXEC_KEEP_V1*/';
const SAND_AGENT_IDE_MARKER = '/*SAND_AGENT_IDE_V1*/';
const SAND_STREAM_HOOK_MARKER = '/*SAND_STREAM_HOOK_V1*/';
const SAND_MOVE_EXEC_MARKER = '/*SAND_MOVE_EXEC_V1*/';
const SAND_RPC_REWRITE_MARKER = '/*SAND_RPC_REWRITE_V1*/';
const SAND_RPC_REWRITE_END = '/*SAND_RPC_REWRITE_END*/';
const SAND_STREAM_WRAP_MARKER = '/*SAND_STREAM_WRAP_V1*/';
const SAND_TRANSPORT_HOST_MARKER = '/*SAND_TRANSPORT_HOST_V1*/';
const OLD_RPC_PATH = 'agent.v1.AgentService/Run';
const NEW_RPC_PATH = 'aiserver.v1.InferenceService/Stream';

const LEGACY_SAND_CLIENT_MARKER = '/*K' + 'C_SAND_CLIENT_V1*/';
const LEGACY_SAND_ELIGIBILITY_MARKER = '/*K' + 'C_SAND_ELIGIBILITY_V1*/';

const CLIENT_MARKER_GUARD_PATTERN = '/\\*[A-Z0-9_]*SAND_CLIENT(?:_(?:MODE|EXISTING))?_V1\\*/';
const ELIGIBILITY_MARKER_GUARD_PATTERN = '/\\*[A-Z0-9_]*SAND_ELIGIBILITY(?:_MODE)?_V1\\*/';

// x-cursor-client-type 按请求分流：AgentService / agent.v1 出 ide，其余出 sand。
const SAND_HDRFIX_V2_FN =
  '(function(r){try{var u=String((r&&r.url)||""),s=String((r&&r.service&&r.service.typeName)||"");' +
  'if(/AgentService|\\/agent\\.v1\\./.test(u+s))return"ide"}catch(x){}return"sand"})';

// 会员伪装 + 模型解锁：拦截 renderer 的 fetch（与 sand_patch.py SAND_MEMBERSHIP_SNIPPET 一致）。
const SAND_MEMBERSHIP_SNIPPET =
  SAND_MEMBERSHIP_MARKER +
  '(function(){try{var G=(typeof globalThis!=="undefined")?globalThis:(typeof self!=="undefined"?self:this);' +
  'if(!G||G.__sandMemPatch)return;G.__sandMemPatch=1;' +
  'var MEM={membershipType:"enterprise",membership_type:"enterprise",isTeamMember:true,teamId:28945905,teamMembershipType:"SELF_SERVE",subscriptionStatus:"active",subscription_status:"active"};' +
  'function dm(a,b){if(a===null||typeof a!=="object")return a;for(var k in b){var v=b[k];' +
  'if(v&&typeof v==="object"&&!Array.isArray(v)){a[k]=dm(typeof a[k]==="object"&&a[k]?a[k]:{},v);}else{a[k]=v;}}return a;}' +
  'function isMem(u){try{return /membership|usage-summary|dashboard\\/get-me|auth\\/(me|full_stripe|stripe_profile)|GetUserInfo|getUserPrivilege|hard-limit/i.test(u);}catch(e){return false;}}' +
  'function isModels(u){try{return /AvailableModels|available-models/i.test(u);}catch(e){return false;}}' +
  'function pmod(b){try{var arr=(b&&b.models)||(b&&b.data&&b.data.models);if(Array.isArray(arr)){' +
  'for(var i=0;i<arr.length;i++){var m=arr[i];if(m&&typeof m==="object"){m.defaultOn=true;m.default_on=true;}}}}catch(e){}return b;}' +
  'function patchBody(b,mem,mod){if(mem){if(Array.isArray(b)){for(var i=0;i<b.length;i++){if(b[i]&&typeof b[i]==="object"){dm(b[i],MEM);}}}else if(b&&typeof b==="object"){dm(b,MEM);}}if(mod){b=pmod(b);}return b;}' +
  'var OF=G.fetch;if(typeof OF==="function"){G.fetch=function(){var a=arguments;' +
  'return OF.apply(this,a).then(function(r){try{var u=(a[0]&&a[0].url)?a[0].url:a[0];' +
  'var mem=isMem(u),mod=isModels(u);if(!mem&&!mod){return r;}' +
  'return r.clone().text().then(function(txt){var b;try{b=JSON.parse(txt);}catch(e){return r;}' +
  'try{b=patchBody(b,mem,mod);}catch(e){}' +
  'try{return new Response(JSON.stringify(b),{status:r.status,statusText:r.statusText,headers:r.headers});}catch(e){return r;}},' +
  'function(){return r;});}catch(e){return r;}});};}}catch(e){}})();';

const MEMBERSHIP_TARGET_NAMES = ['workbench.desktop.main.js', 'workbench.glass.main.js'];

// ---- managed-local Stream 五件套（字面量与桌面 Toolkit 1.2.2 一致）----
const MANAGED_LOCAL_ROUTE_ORIGINAL =
  'try{return(yield o.checkFeatureGate(ae))?' +
  '{runtime:"managed-local",reason:"eligible"}:' +
  '{runtime:"connect",reason:"gate-off"}}catch(e)';
const MANAGED_LOCAL_ROUTE_PATCHED =
  'try{return' + SAND_MANAGED_LOCAL_ROUTE_MARKER +
  '{runtime:"managed-local",reason:"sand-client"}}catch(e)';
const LOCAL_RUNTIME_LOAD_ORIGINAL = 'let t=!1;try{t=await r.cursor.checkFeatureGate(Ds)}';
const LOCAL_RUNTIME_LOAD_PATCHED = 'let t=!0;' + SAND_LOCAL_RUNTIME_LOAD_MARKER + 'try{t=!0}';
const AGENT_HOST_IDENTITY_ORIGINAL = 'clientIdentity:{clientType:"ide"}';
const AGENT_HOST_IDENTITY_PATCHED = 'clientIdentity:{clientType:"sand"' + SAND_AGENT_HOST_IDENTITY_MARKER + '}';
const DIRECT_STREAM_ANCHOR = 'function hre(e){return t=>{return n=this,o=void 0,s=function*(){';
const AGENTEXEC_SKIP_ORIGINAL =
  'waitForProviderRegistration(r.ctx.signal);return}await this._agentExecProviderService.waitForProviderRegistration';
const AGENTEXEC_SKIP_PATCHED =
  'waitForProviderRegistration(r.ctx.signal);' + SAND_AGENTEXEC_KEEP_MARKER +
  '}await this._agentExecProviderService.waitForProviderRegistration';
const MOVE_EXEC_GATE_ORIGINAL = 'p=await Promise.resolve(r.cursor.checkFeatureGate(Us)).catch(()=>!1)';
const MOVE_EXEC_GATE_PATCHED = 'p=!0' + SAND_MOVE_EXEC_MARKER;

const _TRANSPORT_HOST_SWAPS = [
  [
    'this._overrideServiceNameToTransportMapLowerPriorityThanMethodOverrides[kt.typeName]=s.agentBidiTransport',
    'this._overrideServiceNameToTransportMapLowerPriorityThanMethodOverrides[kt.typeName]=this._backendTransport' + SAND_TRANSPORT_HOST_MARKER,
  ],
  [
    'this._overrideMethodNameToTransportMap[kt.methods.run.name]=s.agentBidiTransport',
    'this._overrideMethodNameToTransportMap[kt.methods.run.name]=this._backendTransport' + SAND_TRANSPORT_HOST_MARKER,
  ],
  [
    'this._overrideServiceNameToTransportMapLowerPriorityThanMethodOverrides[l.AgentService.typeName]=e.agentBidiTransport',
    'this._overrideServiceNameToTransportMapLowerPriorityThanMethodOverrides[l.AgentService.typeName]=this._backendTransport' + SAND_TRANSPORT_HOST_MARKER,
  ],
  [
    'this._overrideMethodNameToTransportMap[l.AgentService.methods.run.name]=e.agentBidiTransport',
    'this._overrideMethodNameToTransportMap[l.AgentService.methods.run.name]=this._backendTransport' + SAND_TRANSPORT_HOST_MARKER,
  ],
];

// ---------------- 目标文件 ----------------
// [相对路径, 扩展名(null=非扩展)]
const TARGET_SPECS = [
  ['out/main.js', null],
  ['out/vs/workbench/api/worker/extensionHostWorkerMain.js', null],
  ['out/vs/workbench/api/node/extensionHostProcess.js', null],
  ['out/vs/workbench/workbench.glass.main.js', null],
  ['out/vs/workbench/workbench.desktop.main.js', null],
  ['out/vs/code/electron-utility/alwaysLocalSingleton/alwaysLocalSingletonMain.js', null],
  ['extensions/cursor-always-local/dist/main.js', 'cursor-always-local'],
  ['extensions/cursor-local-agent-runtime/dist/main.js', 'cursor-local-agent-runtime'],
  ['extensions/cursor-agent-host/dist/main.js', 'cursor-agent-host'],
  ['extensions/cursor-agent-exec/dist/main.js', 'cursor-agent-exec'],
  ['extensions/cursor-agent-host/dist/657.js', null],
  ['extensions/cursor-agent-host/dist/675.js', null],
];
const EXT_HOST_REL = 'out/vs/workbench/api/node/extensionHostProcess.js';

class SandToolError extends Error {}

// ---------------- 小工具 ----------------
function escapeRegExp(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function countOcc(s, sub) { if (!sub) return 0; let n = 0, i = 0; while ((i = s.indexOf(sub, i)) !== -1) { n += 1; i += sub.length; } return n; }
function replaceAllLiteral(s, a, b) { return a ? s.replaceAll(a, b) : s; }
function sha256hex(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }
function productChecksum(buf) { return crypto.createHash('sha256').update(buf).digest('base64').replace(/=+$/, ''); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// re.subn 等价：re 必须带 g；返回 [新串, 替换次数]
function subnAll(content, re, fn) {
  let count = 0;
  const out = content.replace(re, (...args) => { count += 1; return fn(...args); });
  return [out, count];
}
// count=1 版本：只替换第一个匹配（re 不带 g）
function subnOnce(content, re, fn) {
  let count = 0;
  const out = content.replace(re, (...args) => { count += 1; return fn(...args); });
  return [out, count];
}

// ---------------- direct-stream 注入片段（用于识别并剥离 1.1.0–1.1.3 残留）----------------
function joeStreamSessionJs() {
  return (
    'const n=t.requestedModel;' +
    'if(void 0===n)throw new Error("Sand direct Stream requires requestedModel");' +
    'const o=String(n.modelId||""),i=o.toLowerCase(),' +
    'r=new Map((n.parameters||[]).map(e=>[e.id,e.value])),' +
    's=new Joe(e,n,void 0,void 0).getSession(),' +
    'p={getExecutor:e=>new RK(s.getExecutor(e))},' +
    'a={vendor:i.includes("grok")?"xai":i.includes("gemini")?"gemini":' +
    'i.includes("claude")||i.includes("opus")||i.includes("sonnet")||i.includes("fable")?' +
    '"anthropic":i.includes("gpt")||i.includes("codex")?"openai":"unknown",' +
    'promptVersion:"latest",reasoningEffort:r.get("effort"),' +
    'isGrok45ProductPrompt:i.includes("grok"),' +
    'isClaude4x:i.includes("claude")||i.includes("opus")||i.includes("sonnet")||i.includes("fable"),' +
    'isFable5:i.includes("fable-5"),' +
    'isOpus5:i.includes("opus-5")||i.includes("opus5"),' +
    'isOpus48:i.includes("opus-4.8")||i.includes("opus48"),' +
    'isOpus46:i.includes("opus-4.6")||i.includes("opus46"),' +
    'isOpus45:i.includes("opus-4.5")||i.includes("opus45"),' +
    'isSonnet45:i.includes("sonnet-4.5")||i.includes("sonnet45"),' +
    'isSonnet4:i.includes("sonnet-4")||i.includes("sonnet4"),' +
    'isGemini3:i.includes("gemini-3")||i.includes("gemini3"),' +
    'isGpt56:i.includes("gpt-5.6")||i.includes("gpt5.6"),' +
    'isGpt55:i.includes("gpt-5.5")||i.includes("gpt5.5"),' +
    'isGpt54:i.includes("gpt-5.4")||i.includes("gpt5.4"),' +
    'isGpt53Codex:i.includes("gpt-5.3-codex"),' +
    'isGpt52Codex:i.includes("gpt-5.2-codex"),' +
    'isCodexFamily:i.includes("codex"),isGpt5Family:i.includes("gpt-5")};' +
    'return{promptSession:s,promptToolSession:p,attempt:{resolvedModel:cre(n),' +
    'supportsSelfSummary:!1,routedModelDisplayName:o,' +
    'resolvedModelMetadata:nre(a,o),finish:()=>Promise.resolve()}}'
  );
}
function legacyDirectStreamInjection() {
  return (
    '{' + SAND_DIRECT_STREAM_MARKER +
    'const n=t.requestedModel;' +
    'if(void 0===n)throw new Error("Sand direct Stream requires requestedModel");' +
    'const o=String(n.modelId||""),i=o.toLowerCase(),' +
    'r=new Map(n.parameters.map(e=>[e.id,e.value])),' +
    's=new Joe(e,n,void 0,void 0).getSession(),' +
    'p={getExecutor:e=>new RK(s.getExecutor(e))},' +
    'a={vendor:i.includes("grok")?"xai":i.includes("gemini")?"gemini":' +
    'i.includes("claude")||i.includes("opus")||i.includes("sonnet")||i.includes("fable")?' +
    '"anthropic":i.includes("gpt")||i.includes("codex")?"openai":"unknown",' +
    'promptVersion:"latest",reasoningEffort:r.get("effort"),' +
    'isGrok45ProductPrompt:i.includes("grok"),' +
    'isClaude4x:i.includes("claude")||i.includes("opus")||i.includes("sonnet")||i.includes("fable"),' +
    'isFable5:i.includes("fable-5"),' +
    'isOpus5:i.includes("opus-5")||i.includes("opus5"),' +
    'isOpus48:i.includes("opus-4.8")||i.includes("opus48"),' +
    'isOpus46:i.includes("opus-4.6")||i.includes("opus46"),' +
    'isOpus45:i.includes("opus-4.5")||i.includes("opus45"),' +
    'isSonnet45:i.includes("sonnet-4.5")||i.includes("sonnet45"),' +
    'isSonnet4:i.includes("sonnet-4")||i.includes("sonnet4"),' +
    'isGemini3:i.includes("gemini-3")||i.includes("gemini3"),' +
    'isGpt56:i.includes("gpt-5.6")||i.includes("gpt5.6"),' +
    'isGpt55:i.includes("gpt-5.5")||i.includes("gpt5.5"),' +
    'isGpt54:i.includes("gpt-5.4")||i.includes("gpt5.4"),' +
    'isGpt53Codex:i.includes("gpt-5.3-codex"),' +
    'isGpt52Codex:i.includes("gpt-5.2-codex"),' +
    'isCodexFamily:i.includes("codex"),isGpt5Family:i.includes("gpt-5")};' +
    'return{promptSession:s,promptToolSession:p,attempt:{resolvedModel:cre(n),' +
    'supportsSelfSummary:!1,routedModelDisplayName:o,' +
    'resolvedModelMetadata:nre(a,o),finish:()=>Promise.resolve()}}}'
  );
}
function directStreamInjection() {
  return '{' + SAND_DIRECT_STREAM_MARKER + 'if(!(e&&typeof e.runInference==="function")){' + joeStreamSessionJs() + '}}';
}
const DIRECT_STREAM_SNIPPET_RE_SRC =
  escapeRegExp('{') + escapeRegExp(SAND_DIRECT_STREAM_MARKER) + '[\\s\\S]*?finish:\\(\\)=>Promise\\.resolve\\(\\)\\}+';

function stripDirectStreamInjection(content) {
  if (!content.includes(SAND_DIRECT_STREAM_MARKER)) return [content, 0];
  let total = 0;
  for (const exact of [directStreamInjection(), legacyDirectStreamInjection()]) {
    const c = countOcc(content, exact);
    if (c) { content = replaceAllLiteral(content, exact, ''); total += c; }
  }
  if (content.includes(SAND_DIRECT_STREAM_MARKER)) {
    const [next, n] = subnAll(content, new RegExp(DIRECT_STREAM_SNIPPET_RE_SRC, 'g'), () => '');
    content = next; total += n;
  }
  return [content, total];
}

function contentHasStreamAnchors(content) {
  return (
    content.includes(MANAGED_LOCAL_ROUTE_ORIGINAL) ||
    content.includes(LOCAL_RUNTIME_LOAD_ORIGINAL) ||
    content.includes(AGENT_HOST_IDENTITY_ORIGINAL) ||
    content.includes(DIRECT_STREAM_ANCHOR) ||
    content.includes(MOVE_EXEC_GATE_ORIGINAL) ||
    new RegExp('(this\\._agentHostEnabled=)([A-Za-z_$][A-Za-z0-9_$]*)(,)').test(content)
  );
}

// ---------------- RPC 片段剥离（还原 sand_rpc.js 那条旁路，1.1.5 默认不启用）----------------
function stripRpcSnippets(content) {
  const re1 = new RegExp(escapeRegExp(SAND_RPC_REWRITE_MARKER) + '[\\s\\S]*?' + escapeRegExp(SAND_RPC_REWRITE_END), 'g');
  let [next, n1] = subnAll(content, re1, () => '');
  let n2 = 0;
  if (next.includes(SAND_RPC_REWRITE_MARKER)) {
    const re2 = new RegExp(escapeRegExp(SAND_RPC_REWRITE_MARKER) + '[\\s\\S]*?\\}\\)\\(\\);', 'g');
    [next, n2] = subnAll(next, re2, () => '');
  }
  return [next, n1 + n2];
}

const STREAM_WRAP_RESTORE_RE_SRC =
  '(throw new Error\\("INVARIANT VIOLATION: Transport is undefined for service: "\\+\\w+\\.typeName\\);return )' +
  '\\(typeof globalThis\\.__sandRewriteStream==="function"\\?globalThis\\.__sandRewriteStream\\((\\w+)\\.transport,' +
  '([^)]+)\\):\\2\\.transport\\.stream\\(\\3\\)\\)' +
  escapeRegExp(SAND_STREAM_WRAP_MARKER);

const MEMBERSHIP_SNIPPET_RE_SRC = escapeRegExp(SAND_MEMBERSHIP_MARKER) + '[\\s\\S]*?\\}\\)\\(\\);';

// ---------------- CLIENT_RULES（存 source，用时各自 new RegExp 避免 lastIndex 干扰）----------------
const _mg = '(?!' + CLIENT_MARKER_GUARD_PATTERN + ')';
const CLIENT_RULES = [
  ['is_glass', '(isGlass\\s*\\?\\s*["\']glass["\']\\s*:\\s*)(["\'])(ide|sand)\\2' + _mg],
  ['object_header', '(["\']x-cursor-client-type["\']\\s*:\\s*)(["\'])(ide|sand)\\2' + _mg],
  ['set_header', '(header\\.set\\(\\s*["\']x-cursor-client-type["\']\\s*,\\s*[A-Za-z_$][A-Za-z0-9_$.]*\\s*(?:\\?\\?|\\|\\|)\\s*)(["\'])(ide|sand)\\2' + _mg],
];

// ---------------- apply ----------------
function applyPatchToContent(content) {
  const stats = newStats();
  let next = content;

  // 1) 迁移旧 KC marker
  {
    const re = new RegExp('(["\'])sand\\1' + escapeRegExp(LEGACY_SAND_CLIENT_MARKER), 'g');
    const [n, c] = subnAll(next, re, (m, q) => q + 'sand' + q + SAND_CLIENT_MARKER);
    next = n; stats.migrated_client = c;
  }
  {
    const legacy = 'return!1;' + LEGACY_SAND_ELIGIBILITY_MARKER;
    stats.migrated_eligibility = countOcc(next, legacy);
    next = replaceAllLiteral(next, legacy, 'return!1;' + SAND_ELIGIBILITY_MARKER);
  }

  // 2) header.set 智能分流（整体替换第二实参为 HDRFIX_V2 函数）
  {
    const re = new RegExp(
      '([A-Za-z_$][\\w$]*)\\.header\\.set\\(\\s*(["\'])x-cursor-client-type\\2\\s*,\\s*' +
      '(?:[A-Za-z_$][\\w$]*\\s*\\?\\?\\s*)?' +
      '(["\'])(?:ide|sand|glass)\\3' +
      '(?:/\\*SAND[A-Z0-9_]*_V1\\*/)*' +
      '\\)', 'g');
    const [n, c] = subnAll(next, re, (m, obj, q) =>
      obj + '.header.set(' + q + 'x-cursor-client-type' + q + ',' + SAND_HDRFIX_V2_FN + '(' + obj + ')' + SAND_HDRFIX_V2_MARKER + ')');
    next = n; stats.set_header += c;
  }

  // 3) CLIENT_RULES：ide/sand -> sand（sand 打 EXISTING marker，ide 打 CLIENT marker）
  for (const [key, src] of CLIENT_RULES) {
    const re = new RegExp(src, 'g');
    const [n, c] = subnAll(next, re, (m, g1, g2, g3) => {
      if (g3 === 'sand') { stats.adopted_sand += 1; return g1 + g2 + 'sand' + g2 + SAND_CLIENT_EXISTING_MARKER; }
      return g1 + g2 + 'sand' + g2 + SAND_CLIENT_MARKER;
    });
    next = n; stats[key] += c;
  }

  // 4) glass 真分支修复
  {
    const re = new RegExp('(isGlass\\?)(["\'])glass\\2(:)(["\'])(?:ide|sand)\\4', 'g');
    const [n, c] = subnAll(next, re, (m, g1, q1, g3, q2) => g1 + q1 + 'sand' + q1 + SAND_GLASSFIX_MARKER + g3 + q2 + 'sand' + q2);
    next = n; stats.is_glass += c;
  }

  // 5) 资格函数注入 return!1
  {
    const re = new RegExp('(function\\s+[A-Za-z0-9_$]+\\([A-Za-z0-9_$]+\\)\\{)(const\\{adminSettingsService:)', 'g');
    const [n, c] = subnAll(next, re, (m, g1, g2) => g1 + 'return!1;' + SAND_ELIGIBILITY_MARKER + g2);
    next = n; stats.eligibility += c;
  }

  // 6) 模型选择器解锁 return!1
  {
    const re = new RegExp('(hasResolvedTeamMembership:\\w+,teamId:\\w+\\}\\)\\{)(return \\w+===\\w+\\.FREE&&\\w+&&\\w+===void 0\\})', 'g');
    const [n, c] = subnAll(next, re, (m, g1, g2) => g1 + 'return!1;' + SAND_MODEL_UNLOCK_MARKER + g2);
    next = n; stats.model_unlock += c;
  }

  // 7) _membershipType -> "enterprise"
  {
    const re = new RegExp('(_membershipType=\\(\\)=>)(this\\.storageService\\.get\\()', 'g');
    const [n, c] = subnAll(next, re, (m, g1, g2) => g1 + '"enterprise"||' + SAND_MEM_PRO_MARKER + g2);
    next = n; stats.model_unlock += c;
    // 旧补丁 "pro"|| -> "enterprise"||
    next = next.replace(new RegExp('"pro"\\|\\|(' + escapeRegExp(SAND_MEM_PRO_MARKER) + ')', 'g'), '"enterprise"||$1');
  }

  // 8) Max mode 解锁
  {
    const re = new RegExp('(hasValidPaymentMethod=async\\(\\)=>\\{)(?!return!0;)', 'g');
    const [n, c] = subnAll(next, re, (m, g1) => g1 + 'return!0;' + SAND_MAXMODE_MARKER);
    next = n; stats.model_unlock += c;
  }

  // 9) 还原 stream-wrap / transport-host / RPC 路径（sand_rpc 旁路，1.1.5 撤下）
  {
    const re = new RegExp(STREAM_WRAP_RESTORE_RE_SRC, 'g');
    const [n, c] = subnAll(next, re, (m, prefix, tr, arglist) => `${prefix}${tr}.transport.stream(${arglist})`);
    next = n; stats.rpc_rewrite += c;
  }
  for (const [oldS, newS] of _TRANSPORT_HOST_SWAPS) {
    if (next.includes(newS)) { next = replaceAllLiteral(next, newS, oldS); stats.rpc_rewrite += 1; }
  }
  if (next.includes(NEW_RPC_PATH)) {
    const n = countOcc(next, NEW_RPC_PATH);
    next = replaceAllLiteral(next, NEW_RPC_PATH, OLD_RPC_PATH);
    stats.rpc_rewrite += n;
  }

  // 10) always-local prepareAgentRun：返回前把头改回 ide
  {
    const re = new RegExp('(?<!' + escapeRegExp(SAND_AGENT_IDE_MARKER) + '\\);)return\\{headers:([A-Za-z_$][\\w$]*),credentialFingerprint:', 'g');
    const [n, c] = subnAll(next, re, (m, ident) =>
      `${ident}.set("x-cursor-client-type","ide"${SAND_AGENT_IDE_MARKER});return{headers:${ident},credentialFingerprint:`);
    next = n; stats.rpc_rewrite += c;
  }
  // 卸掉 1.0.5 手写 fetch 桥
  {
    const re = new RegExp(
      'if\\(t&&t\\.typeName==="agent\\.v1\\.AgentService"&&n&&n\\.name==="Run"' +
      '&&typeof globalThis\\.__sandStream==="function"\\)' +
      'return globalThis\\.__sandStream\\(t,n,r,s,o,i,a\\)' +
      escapeRegExp(SAND_STREAM_HOOK_MARKER) + ';', 'g');
    const [n, c] = subnAll(next, re, () => '');
    next = n; stats.rpc_rewrite += c;
  }

  // 11) managed-local Stream 五件套（注入）
  {
    const c = countOcc(next, MANAGED_LOCAL_ROUTE_ORIGINAL);
    if (c) { next = replaceAllLiteral(next, MANAGED_LOCAL_ROUTE_ORIGINAL, MANAGED_LOCAL_ROUTE_PATCHED); stats.managed_local_route += c; }
  }
  {
    const c = countOcc(next, LOCAL_RUNTIME_LOAD_ORIGINAL);
    if (c) { next = replaceAllLiteral(next, LOCAL_RUNTIME_LOAD_ORIGINAL, LOCAL_RUNTIME_LOAD_PATCHED); stats.local_runtime_load += c; }
  }
  {
    const c = countOcc(next, AGENT_HOST_IDENTITY_ORIGINAL);
    if (c) { next = replaceAllLiteral(next, AGENT_HOST_IDENTITY_ORIGINAL, AGENT_HOST_IDENTITY_PATCHED); stats.agent_host_identity += c; }
  }
  {
    const c = countOcc(next, MOVE_EXEC_GATE_ORIGINAL);
    if (c) { next = replaceAllLiteral(next, MOVE_EXEC_GATE_ORIGINAL, MOVE_EXEC_GATE_PATCHED); stats.move_exec += c; }
  }

  // 12) 剥离 1.1.0–1.1.3 的 createPromptSession 短路
  {
    const [n, c] = stripDirectStreamInjection(next);
    next = n; stats.direct_stream += c;
  }

  // 13) 强制开启 agent-host（只改第一个）
  if (!next.includes(SAND_AGENT_HOST_ENABLEMENT_MARKER)) {
    const re = new RegExp('(this\\._agentHostEnabled=)([A-Za-z_$][A-Za-z0-9_$]*)(,)');
    const [n, c] = subnOnce(next, re, (m, g1, variable, g3) =>
      variable + '=!0;' + SAND_AGENT_HOST_ENABLEMENT_MARKER + g1 + variable + g3);
    next = n; stats.agent_host_enablement += c;
  }

  // 14) 还原 1.1.3 的 AGENTEXEC_KEEP（move_exec ON 时要保留 return）
  if (next.includes(AGENTEXEC_SKIP_PATCHED)) {
    next = replaceAllLiteral(next, AGENTEXEC_SKIP_PATCHED, AGENTEXEC_SKIP_ORIGINAL);
  }

  return [next, stats];
}

// ---------------- remove ----------------
function removePatchFromContent(content) {
  const stats = newRemoveStats();
  let next = content;

  { const [n, c] = stripRpcSnippets(next); next = n; stats.client_type += c; }

  // InferenceService/Stream -> agent.v1.AgentService/Run（方法定义级还原）
  {
    const re = new RegExp(
      'typeName:"aiserver\\.v1\\.InferenceService",methods:\\{run:\\{name:"Stream"' +
      '(,I:[$\\w.]+,O:[$\\w.]+,kind:)' +
      '((?:[$\\w.]+\\.)?ServerStreaming|1)\\b', 'g');
    const [n, c] = subnAll(next, re, (m, g1, kind) => {
      const oldKind = kind === '1' ? '3' : kind.replace('ServerStreaming', 'BiDiStreaming');
      return 'typeName:"agent.v1.AgentService",methods:{run:{name:"Run"' + g1 + oldKind;
    });
    next = n; stats.client_type += c;
  }
  if (next.includes(NEW_RPC_PATH)) {
    const n = countOcc(next, NEW_RPC_PATH);
    next = replaceAllLiteral(next, NEW_RPC_PATH, OLD_RPC_PATH);
    stats.client_type += n;
  }
  {
    const re = new RegExp(STREAM_WRAP_RESTORE_RE_SRC, 'g');
    const [n, c] = subnAll(next, re, (m, prefix, tr, arglist) => `${prefix}${tr}.transport.stream(${arglist})`);
    next = n; stats.client_type += c;
  }
  for (const [oldS, newS] of _TRANSPORT_HOST_SWAPS) {
    if (next.includes(newS)) { next = replaceAllLiteral(next, newS, oldS); stats.client_type += 1; }
  }
  {
    const re = new RegExp('[A-Za-z_$][\\w$]*\\.set\\("x-cursor-client-type","ide"' + escapeRegExp(SAND_AGENT_IDE_MARKER) + '\\);', 'g');
    const [n, c] = subnAll(next, re, () => ''); next = n; stats.rpc_rewrite += c;
  }
  {
    const re = new RegExp(
      'if\\(t&&t\\.typeName==="agent\\.v1\\.AgentService"&&n&&n\\.name==="Run"' +
      '&&typeof globalThis\\.__sandStream==="function"\\)' +
      'return globalThis\\.__sandStream\\(t,n,r,s,o,i,a\\)' +
      escapeRegExp(SAND_STREAM_HOOK_MARKER) + ';', 'g');
    const [n, c] = subnAll(next, re, () => ''); next = n; stats.rpc_rewrite += c;
  }

  // 旧 KC client / eligibility
  {
    const re = new RegExp('(["\'])sand\\1' + escapeRegExp(LEGACY_SAND_CLIENT_MARKER), 'g');
    const [n, c] = subnAll(next, re, (m, q) => q + 'ide' + q); next = n; stats.client_type += c;
  }
  {
    const legacy = 'return!1;' + LEGACY_SAND_ELIGIBILITY_MARKER;
    const c = countOcc(next, legacy); next = replaceAllLiteral(next, legacy, ''); stats.eligibility += c;
  }
  // CLIENT / EXISTING / GLASSFIX / HDRFIX
  {
    const re = new RegExp('(["\'])sand\\1' + escapeRegExp(SAND_CLIENT_MARKER), 'g');
    const [n, c] = subnAll(next, re, (m, q) => q + 'ide' + q); next = n; stats.client_type += c;
  }
  {
    const re = new RegExp('(["\'])sand\\1' + escapeRegExp(SAND_CLIENT_EXISTING_MARKER), 'g');
    const [n, c] = subnAll(next, re, (m, q) => q + 'sand' + q); next = n; stats.client_type += c;
  }
  {
    const re = new RegExp('(["\'])sand\\1' + escapeRegExp(SAND_GLASSFIX_MARKER), 'g');
    const [n, c] = subnAll(next, re, (m, q) => q + 'glass' + q); next = n; stats.client_type += c;
  }
  {
    const re = new RegExp('(["\'])sand\\1' + escapeRegExp(SAND_HDRFIX_MARKER), 'g');
    const [n, c] = subnAll(next, re, (m, q) => q + 'ide' + q); next = n; stats.client_type += c;
  }
  // HDRFIX_V2：整个函数调用 -> "ide"
  {
    const re = new RegExp(escapeRegExp(SAND_HDRFIX_V2_FN) + '\\([A-Za-z_$][\\w$]*\\)' + escapeRegExp(SAND_HDRFIX_V2_MARKER), 'g');
    const [n, c] = subnAll(next, re, () => '"ide"'); next = n; stats.client_type += c;
  }
  // eligibility / model_unlock / mem_pro / maxmode
  {
    const re = new RegExp('return!1;' + escapeRegExp(SAND_ELIGIBILITY_MARKER), 'g');
    const [n, c] = subnAll(next, re, () => ''); next = n; stats.eligibility += c;
  }
  {
    const re = new RegExp('return!1;' + escapeRegExp(SAND_MODEL_UNLOCK_MARKER), 'g');
    const [n, c] = subnAll(next, re, () => ''); next = n; stats.eligibility += c;
  }
  {
    const re = new RegExp('"(?:enterprise|pro)"\\|\\|' + escapeRegExp(SAND_MEM_PRO_MARKER), 'g');
    const [n, c] = subnAll(next, re, () => ''); next = n; stats.eligibility += c;
  }
  {
    const re = new RegExp('return!0;' + escapeRegExp(SAND_MAXMODE_MARKER), 'g');
    const [n, c] = subnAll(next, re, () => ''); next = n; stats.eligibility += c;
  }
  // managed-local 五件套还原
  {
    const c = countOcc(next, MANAGED_LOCAL_ROUTE_PATCHED);
    if (c) { next = replaceAllLiteral(next, MANAGED_LOCAL_ROUTE_PATCHED, MANAGED_LOCAL_ROUTE_ORIGINAL); stats.managed_local_route += c; }
  }
  {
    const c = countOcc(next, LOCAL_RUNTIME_LOAD_PATCHED);
    if (c) { next = replaceAllLiteral(next, LOCAL_RUNTIME_LOAD_PATCHED, LOCAL_RUNTIME_LOAD_ORIGINAL); stats.local_runtime_load += c; }
  }
  {
    const c = countOcc(next, AGENT_HOST_IDENTITY_PATCHED);
    if (c) { next = replaceAllLiteral(next, AGENT_HOST_IDENTITY_PATCHED, AGENT_HOST_IDENTITY_ORIGINAL); stats.agent_host_identity += c; }
  }
  {
    const c = countOcc(next, MOVE_EXEC_GATE_PATCHED);
    if (c) { next = replaceAllLiteral(next, MOVE_EXEC_GATE_PATCHED, MOVE_EXEC_GATE_ORIGINAL); stats.move_exec += c; }
  }
  { const [n, c] = stripDirectStreamInjection(next); next = n; stats.direct_stream += c; }
  // agent-host enablement 还原
  {
    const re = new RegExp('([A-Za-z_$][A-Za-z0-9_$]*)=!0;' + escapeRegExp(SAND_AGENT_HOST_ENABLEMENT_MARKER) + '(this\\._agentHostEnabled=)\\1(,)', 'g');
    const [n, c] = subnAll(next, re, (m, g1, g2, g3) => g2 + g1 + g3); next = n; stats.agent_host_enablement += c;
  }
  if (next.includes(AGENTEXEC_SKIP_PATCHED)) {
    next = replaceAllLiteral(next, AGENTEXEC_SKIP_PATCHED, AGENTEXEC_SKIP_ORIGINAL);
  }
  // 会员伪装片段
  {
    const re = new RegExp(MEMBERSHIP_SNIPPET_RE_SRC, 'g');
    const [n, c] = subnAll(next, re, () => ''); next = n; stats.client_type += c;
  }
  // 残留 marker 兜底
  {
    const re = new RegExp('(["\'])(?:ide|sand|glass)\\1((?:/\\*SAND[A-Z0-9_]*_V1\\*/)+)', 'g');
    const [n, c] = subnAll(next, re, (m, quote, markers) => {
      const first = /\/\*(SAND[A-Z0-9_]*_V1)\*\//.exec(markers)[1];
      let value = 'ide';
      if (first.includes('EXISTING')) value = 'sand';
      else if (first.includes('GLASSFIX')) value = 'glass';
      return quote + value + quote;
    });
    next = n; stats.client_type += c;
  }
  return [next, stats];
}

function newStats() {
  return {
    is_glass: 0, object_header: 0, set_header: 0, eligibility: 0, adopted_sand: 0,
    migrated_client: 0, migrated_eligibility: 0, model_unlock: 0, rpc_rewrite: 0,
    managed_local_route: 0, local_runtime_load: 0, direct_stream: 0,
    agent_host_enablement: 0, agent_host_identity: 0, move_exec: 0,
  };
}
function newRemoveStats() {
  return {
    client_type: 0, eligibility: 0, rpc_rewrite: 0, managed_local_route: 0,
    local_runtime_load: 0, direct_stream: 0, agent_host_enablement: 0,
    agent_host_identity: 0, move_exec: 0,
  };
}

module.exports = {
  TOOL_VERSION,
  SandToolError,
  TARGET_SPECS,
  EXT_HOST_REL,
  MEMBERSHIP_TARGET_NAMES,
  SAND_MEMBERSHIP_SNIPPET,
  CLIENT_RULES,
  CLIENT_MARKER_GUARD_PATTERN,
  ELIGIBILITY_MARKER_GUARD_PATTERN,
  applyPatchToContent,
  removePatchFromContent,
  stripRpcSnippets,
  stripDirectStreamInjection,
  contentHasStreamAnchors,
  // 供 layout/commit/inspect 模块（sand_patch_engine.js）复用的常量
  markers: {
    SAND_CLIENT_MARKER, SAND_CLIENT_EXISTING_MARKER, SAND_ELIGIBILITY_MARKER,
    SAND_HDRFIX_V2_MARKER, SAND_MEMBERSHIP_MARKER, SAND_MANAGED_LOCAL_ROUTE_MARKER,
    SAND_LOCAL_RUNTIME_LOAD_MARKER, SAND_DIRECT_STREAM_MARKER, SAND_AGENT_HOST_ENABLEMENT_MARKER,
    SAND_AGENT_HOST_IDENTITY_MARKER, SAND_MOVE_EXEC_MARKER,
    LEGACY_SAND_CLIENT_MARKER, LEGACY_SAND_ELIGIBILITY_MARKER,
  },
  MEMBERSHIP_SNIPPET_RE_SRC,
  escapeRegExp, countOcc, replaceAllLiteral, sha256hex, productChecksum, sleep,
};
