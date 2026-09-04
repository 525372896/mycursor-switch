'use strict';
// Cursor Sand 客户端模式补丁引擎 —— 从 SandClaimer 的 sand_patch.py(1.1.8）1:1 移植到 Node。
//
// 目标：给本机 Cursor 打「Sand Stream 客户端模式」补丁（client-type=sand + 资格/会员/模型/Max
// mode 绕过 + managed-local Stream 五件套），并同步回写 product.json 完整性校验值与
// extensionHost 内嵌扩展哈希；支持备份 / 校验 / 失败回滚 / 一键回退。
//
// 所有 marker、注入片段字面量、目标文件清单、apply/remove 顺序均与 sand_patch.py 完全一致，
// 打出的补丁与 SandClaimer 逐字节相同、可互相识别与卸载。
//
// 1.1.8 相对 1.1.5 的变化（已同步）：
//   · Stream 五件套锚点从「写死 minified 字面量」改为「\w+ 泛化易变变量名、只锚定稳定语义串」——
//     同一版本号不同 commit（About 里的 …130 与官方包 …137）变量名并不相同，写死会导致
//     「版本对却一个锚点都命中不了 → 切不过去 / 只能基础模式」。
//   · 打补丁时保留原始片段为死代码 / 短路，卸载按 marker 精确回退，字节级可还原。
//   · agent-host dist 下的 chunk（657/675…）编号随构建变化，改为运行时扫描整个 dist（排除 main.js 与 *-worker.js）。
//   · Stream 完整性判定改为「五类锚点各命中 ≥1」，不再要求精确 (1,1,1,1,2)。
//   · 剥离 direct-stream 残留的步骤挪到 agent-host enablement 之前。

const crypto = require('crypto');

const TOOL_VERSION = '1.1.8';
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
// 1.2.1 新增：本地回路准入放宽（修 ERROR_NOT_LOGGED_IN）。selectTurnRuntime 里官方只让
// userMessageAction+AGENT 进 managed-local(sand)，其余动作/子代理回落 connect→云端 401。
// 这两条把准入白名单放宽 + 短路子代理 runOptions，让后台任务/子代理等 turn 也留在本地 sand 回路。
const SAND_LOCAL_ACTIONS_MARKER = '/*SAND_LOCAL_ACTIONS_V1*/';
const SAND_LOCAL_ACTIONS_END = '/*SAND_LOCAL_ACTIONS_END*/';
const SAND_SUBAGENT_LOCAL_MARKER = '/*SAND_SUBAGENT_LOCAL_V1*/';
// 强制 sand 流量发到 api2（修 "Sand traffic is not supported on this endpoint"）。
// agent-host 的 createTransport 里 baseUrl 归一是 `!n&&isBaseUrlHttp2(t)&&(d=replaceBaseUrlWithApi2(t))`，
// n=useHttp2；agent-host 走 HTTP/2(n=true) → 不归一 → sand 流量发到 agentn.api5.cursor.sh 被服务端拒。
// 我们把 `!n&&` 去掉，让 HTTP/2 也归一到 api2（即 sand-gateway 实测能通的那个端点）。
const SAND_FORCE_API2_MARKER = '/*SAND_FORCE_API2_V1*/';
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

// ---- managed-local Stream 五件套（1.1.8：泛化 minified 变量名，只锚定稳定语义字面量）----
// 以下五处是 3.18.x Stream 回路的结构锚点。minified 变量名（对象 / 网关常量 / 循环变量 / catch 变量）
// 随每次构建变化——同一版本号的不同 commit 变量名并不相同，写死字面量会导致「版本对却一个锚点都命中不了」。
// 因此用 \w+ 泛化易变部分，只锚定 checkFeatureGate / runtime:"managed-local" / agent_host_local_loop /
// createAgentHost 等稳定语义串；打补丁时保留原始片段（短路 + 死代码 / 注入语句），卸载按 marker 精确回退。

// 1) managed-local 路由：无条件返回 managed-local，原三元判定保留为死代码，便于精确回退。
const MANAGED_LOCAL_ROUTE_RE_SRC =
  'try\\{return(\\(yield \\w+\\.checkFeatureGate\\(\\w+\\)\\)\\?' +
  '\\{runtime:"managed-local",reason:"eligible"\\}:' +
  '\\{runtime:"connect",reason:"gate-off"\\})\\}catch\\((\\w+)\\)';
const MANAGED_LOCAL_ROUTE_RESTORE_RE_SRC =
  'try\\{return\\{runtime:"managed-local",reason:"sand-client"\\}' + escapeRegExp(SAND_MANAGED_LOCAL_ROUTE_MARKER) + ';';
function managedLocalRouteSub(m, originalTernary, catchVar) {
  return 'try{return{runtime:"managed-local",reason:"sand-client"}' + SAND_MANAGED_LOCAL_ROUTE_MARKER + ';' +
    originalTernary + '}catch(' + catchVar + ')';
}

// 2) 本地 loop runtime：在 if(!t) 判定前注入 t=!0 强制加载，原 gate 判定与 catch 原样保留。
//    锚定稳定串 agent_host_local_loop，避免依赖 minified 的 gate 常量名。
const LOCAL_RUNTIME_LOAD_RE_SRC =
  '(let (\\w+)=!1;try\\{\\2=await \\w+\\.cursor\\.checkFeatureGate\\(\\w+\\)\\}' +
  'catch\\(\\w+\\)\\{[^{}]*agent_host_local_loop[^{}]*\\})' +
  '(if\\(!\\2\\))';
const LOCAL_RUNTIME_LOAD_RESTORE_RE_SRC = escapeRegExp(SAND_LOCAL_RUNTIME_LOAD_MARKER) + '\\w+=!0;';
function localRuntimeLoadSub(m, head, v, tailIf) {
  return head + SAND_LOCAL_RUNTIME_LOAD_MARKER + v + '=!0;' + tailIf;
}

// 3) agent-host 身份：clientType ide→sand。此处无 minified 变量，字面量替换天然跨构建。
const AGENT_HOST_IDENTITY_ORIGINAL = 'clientIdentity:{clientType:"ide"}';
const AGENT_HOST_IDENTITY_PATCHED = 'clientIdentity:{clientType:"sand"' + SAND_AGENT_HOST_IDENTITY_MARKER + '}';
const DIRECT_STREAM_ANCHOR = 'function hre(e){return t=>{return n=this,o=void 0,s=function*(){';
const AGENT_HOST_ENABLEMENT_RE_SRC = '(this\\._agentHostEnabled=)([A-Za-z_$][A-Za-z0-9_$]*)(,)';
const AGENT_HOST_ENABLEMENT_PATCH_RE_SRC =
  '([A-Za-z_$][A-Za-z0-9_$]*)=!0;' + escapeRegExp(SAND_AGENT_HOST_ENABLEMENT_MARKER) + '(this\\._agentHostEnabled=)\\1(,)';
// 强制 agent-host 后，官方是 waitFor(host); return，不再等 agent-exec。1.1.3 曾删掉 return（AGENTEXEC_KEEP）：
// host 开了但 agent-exec 永不注册，卡 30s+ 后 ERROR_EXTENSION_HOST_TIMEOUT。move_exec ON 时必须保留这个 return。
const AGENTEXEC_SKIP_ORIGINAL =
  'waitForProviderRegistration(r.ctx.signal);return}await this._agentExecProviderService.waitForProviderRegistration';
const AGENTEXEC_SKIP_PATCHED =
  'waitForProviderRegistration(r.ctx.signal);' + SAND_AGENTEXEC_KEEP_MARKER +
  '}await this._agentExecProviderService.waitForProviderRegistration';

// 4) move_exec 网关：强制为真，让 host 用同包 createAgentHostExec 提供工具执行器。
//    用稳定的 createAgentHost), 前缀锁定到唯一一处，绝不误伤同文件里另外两个同构 gate。
//    原 gate 读取用 !0||await... 短路保留（永不求值），卸载时精确还原。
const MOVE_EXEC_GATE_RE_SRC =
  '(createAgentHost\\),)(\\w+)=await Promise\\.resolve\\(' +
  '(\\w+\\.cursor\\.checkFeatureGate\\(\\w+\\))\\)\\.catch\\(\\(\\)=>!1\\)';
const MOVE_EXEC_GATE_RESTORE_RE_SRC =
  '(createAgentHost\\),)(\\w+)=!0' + escapeRegExp(SAND_MOVE_EXEC_MARKER) + '\\|\\|await Promise\\.resolve\\(' +
  '(\\w+\\.cursor\\.checkFeatureGate\\(\\w+\\))\\)\\.catch\\(\\(\\)=>!1\\)';
function moveExecGateSub(m, prefix, v, gate) {
  return prefix + v + '=!0' + SAND_MOVE_EXEC_MARKER + '||await Promise.resolve(' + gate + ').catch(()=>!1)';
}
function moveExecGateRestore(m, prefix, v, gate) {
  return prefix + v + '=await Promise.resolve(' + gate + ').catch(()=>!1)';
}

// ---- 1.2.1 规则A：本地回路准入放宽（对应 SAND_LOCAL_ACTIONS_V1）----
// selectTurnRuntime 里官方判定：只有 userMessageAction 才不返回 "action-not-supported"。锚这段三元的开头，
// 在它前面插一段"白名单动作直接放行(return;=支持)"，原三元整段保留为死代码，卸载按 marker 区间精确删除。
// 白名单外的动作、BYOK(hasModelCredentials)、无 modelId、真正的 unsupported runOptions 仍按官方拒绝。
const LOCAL_RUNTIME_ACTIONS = [
  'userMessageAction', 'resumeAction', 'summarizeAction', 'shellCommandAction', 'cancelAction',
  'executePlanAction', 'asyncAskQuestionCompletionAction', 'backgroundTaskCompletionAction',
  'backgroundShellAction', 'backgroundSubagentAction', 'subscriptionNotificationAction', 'goalContinuationAction',
];
// 锚点：return"userMessageAction"!==<var>.actionCase?"action-not-supported":<同var>.requestedMode!==
// 负向后顾避免已打过的重复注入（END marker 紧跟在 return 前）。
// 容忍别的工具（SandClaimer 早期路线 SAND_SUBAGENT_FOLLOWUP_V1 / SAND_SUBAGENT_TURN_V1）在 return 与
// "userMessageAction" 之间塞的前缀：`"xxxAction"===e.actionCase?void 0:` / `e.isSubagentTurn?void 0:` / marker 注释。
// 前缀用非捕获组，(\w+) 仍是第 1 组；我们的块以无条件 return; 结束，前缀连同原三元一起成死代码，卸载删 marker 区间即还原。
const LOCAL_ACTIONS_THIRD_PARTY_PREFIX_RE_SRC =
  '(?:"[A-Za-z]+"===\\w+\\.actionCase\\?void 0:|\\w+\\.isSubagentTurn\\?void 0:|/\\*SAND_[A-Z0-9_]+\\*/)*';
const LOCAL_ACTIONS_RE_SRC =
  '(?<!' + escapeRegExp(SAND_LOCAL_ACTIONS_END) + ')' +
  'return' + LOCAL_ACTIONS_THIRD_PARTY_PREFIX_RE_SRC +
  '"userMessageAction"!==(\\w+)\\.actionCase\\?"action-not-supported":\\1\\.requestedMode!==';
const LOCAL_ACTIONS_RESTORE_RE_SRC =
  escapeRegExp(SAND_LOCAL_ACTIONS_MARKER) + '[\\s\\S]*?' + escapeRegExp(SAND_LOCAL_ACTIONS_END);
function localActionsSub(m, varName) {
  const actions = LOCAL_RUNTIME_ACTIONS.join('|');
  return (
    SAND_LOCAL_ACTIONS_MARKER +
    'if(!/^(?:' + actions + ')$/.test(String(' + varName + '.actionCase)))return"action-not-supported";' +
    'if(void 0===' + varName + '.modelId)return"model-not-supported";' +
    'if(' + varName + '.hasModelCredentials)return"private-model-not-supported";' +
    'if(' + varName + '.hasUnsupportedRunOptions)return"run-options-not-supported";return;' +
    SAND_LOCAL_ACTIONS_END +
    m
  );
}

// ---- 1.2.1 规则B：子代理 runOptions 短路（对应 SAND_SUBAGENT_LOCAL_V1）----
// 官方把「子代理三项 runOptions 存在」并进 hasUnsupportedRunOptions 的 OR 链里，导致子代理 turn 被判
// run-options-not-supported → connect → 401。这里在该括号前加 !1&&（&& 优先级高于 ||，恒 false），
// 等于把这三项从 OR 里摘掉；原表达式原样保在括号内，卸载精确还原为 ||(...)。
const SUBAGENT_RUN_OPTIONS_RE_SRC =
  '\\|\\|(void 0!==(\\w+)\\.runOptions\\.subagentTypeName' +
  '\\|\\|void 0!==\\2\\.runOptions\\.parentAgentToolCallId' +
  '\\|\\|!0===\\2\\.runOptions\\.directMetaParentChildSubagent)';
const SUBAGENT_RUN_OPTIONS_RESTORE_RE_SRC =
  '\\|\\|!1&&\\((void 0!==(\\w+)\\.runOptions\\.subagentTypeName' +
  '\\|\\|void 0!==\\2\\.runOptions\\.parentAgentToolCallId' +
  '\\|\\|!0===\\2\\.runOptions\\.directMetaParentChildSubagent)\\)' + escapeRegExp(SAND_SUBAGENT_LOCAL_MARKER);
function subagentRunOptionsSub(m, inner) {
  return '||!1&&(' + inner + ')' + SAND_SUBAGENT_LOCAL_MARKER;
}

// ---- SAND_FORCE_API2_V1：把 sand 流量强制归一到 api2 端点 ----
// 官方形状（变量名 minified）：!n&&(0,T.isBaseUrlHttp2)(t)&&(d=(0,T.replaceBaseUrlWithApi2)(t))
//   n=useHttp2；agent-host 走 HTTP/2 → n=true → !n=false → 短路，不归一 → 发到 api5 被拒。
// 打补丁：把 `!n&&` 改成 `(!n||!0)&&`（恒真，且保留 n 引用不产生未用变量）→ HTTP/2 也归一到 api2。
//   原判定链 isBaseUrlHttp2(t)&&(d=replaceBaseUrlWithApi2(t)) 原样保留；卸载按 marker 精确还原成 `!n&&`。
// 负向后顾避免对已打过的重复注入。
const FORCE_API2_RE_SRC =
  '!(\\w+)&&(?!\\|\\|!0)(\\(0,\\w+\\.isBaseUrlHttp2\\)\\(\\w+\\)&&\\(\\w+=\\(0,\\w+\\.replaceBaseUrlWithApi2\\)\\(\\w+\\)\\))';
const FORCE_API2_RESTORE_RE_SRC =
  '\\(!(\\w+)\\|\\|!0\\)&&' + escapeRegExp(SAND_FORCE_API2_MARKER) +
  '(\\(0,\\w+\\.isBaseUrlHttp2\\)\\(\\w+\\)&&\\(\\w+=\\(0,\\w+\\.replaceBaseUrlWithApi2\\)\\(\\w+\\)\\))';
function forceApi2Sub(m, nVar, tail) {
  return '(!' + nVar + '||!0)&&' + SAND_FORCE_API2_MARKER + tail;
}
function forceApi2Restore(m, nVar, tail) {
  return '!' + nVar + '&&' + tail;
}

// ---- SAND_STREAM_SHIM_V1：managed-local 推理改走 InferenceService/Stream（真正修掉 "Sand traffic is not supported on this endpoint"）----
// 实测（同一 session 票、同一套头、同 host api2.cursor.sh）：
//   /aiserver.v1.InferenceService/Stream        → 200，正常出字（sand-gateway 用的就是它）
//   /aiserver.v1.InferenceService/RunInference  → 无论 H1/H2/host，一律 invalid_argument "Sand traffic is not supported on this endpoint"
// 即服务端按 RPC 方法拒 sand，跟 host / HTTP 版本 / 请求头无关（force_api2 那条因此治不了本）。
// 官方 managed-local 的 createPromptSession(hre) 用 managedInferenceClient.runInference 开一条 BiDi 多路复用通道：
//   client→server：runRequest{conversationId,requestedModel,…} / invokeModel{invocationId,request} / cancelInvocation / finishRun
//   server→client：runReady{resolvedModel,promptModelMetadata,…} / invocationResponse{invocationId,response} / invocationEnd{invocationId,error?}
// 其中 invokeModel.request 就是 InferenceStreamRequest（Stream 的请求类型）去掉 requested_model(7)/conversation_id(8)（由 runRequest 补），
// invocationResponse.response 就是 InferenceStreamResponse。所以 RunInference 只是把多次 Stream 装进一条 BiDi 的信封。
// 做法：在 attempt 函数开头把 client 换成 globalThis.__sandStreamShim(client)：
//   · runRequest → 本地直接回 runReady（resolvedModel 原样复制；promptModelMetadata 按模型家族推导，useDsv3Harness=false）
//   · invokeModel → 把 requestedModel/conversationId 补回 request，直接 client.stream(request)（= /InferenceService/Stream，
//     走默认 _backendTransport：api2 + HTTP/1.1，与 sand-gateway 同一条路），回包再包回 invocationResponse/invocationEnd
//   · cancelInvocation / finishRun / abort 按官方语义处理
// Joe 会话、工具执行器、错误分类全部走官方原路——1.1.0–1.1.3 直连 Stream 失败正是因为把 Joe 也一起短路了。
// 钩子只锚定稳定字面量 "Attempt already cancelled" + 结构（minified 变量名全部泛化），ConnectError/Code 通过钩子参数传入垫片。
const SAND_STREAM_SHIM_MARKER = '/*SAND_STREAM_SHIM_V1*/';
const SAND_STREAM_SHIM_END = '/*SAND_STREAM_SHIM_END*/';
const SAND_STREAM_SHIM_HOOK_MARKER = '/*SAND_STREAM_SHIM_HOOK_V1*/';
// 官方形状：function(e,t){return sre(this,void 0,void 0,function*(){if(t.signal.aborted)throw new sn.T("Attempt already cancelled",an.C.Canceled);…e.runInference(…)
const STREAM_SHIM_HOOK_RE_SRC =
  '(function\\(([\\w$]+),([\\w$]+)\\)\\{return [\\w$]+\\(this,void 0,void 0,function\\*\\(\\)\\{' +
  'if\\(\\3\\.signal\\.aborted\\)throw new ([\\w$]+\\.[\\w$]+)\\("Attempt already cancelled",([\\w$]+\\.[\\w$]+)\\.Canceled\\);)' +
  '(?!\\2=\\(typeof globalThis\\.__sandStreamShim)';
function streamShimHookSub(m, head, clientVar, optsVar, ceRef, codeRef) {
  return head + clientVar + '=(typeof globalThis.__sandStreamShim==="function"?globalThis.__sandStreamShim(' +
    clientVar + ',{CE:' + ceRef + ',Code:' + codeRef + '}):' + clientVar + ');' + SAND_STREAM_SHIM_HOOK_MARKER;
}
const STREAM_SHIM_HOOK_RESTORE_RE_SRC =
  '([\\w$]+)=\\(typeof globalThis\\.__sandStreamShim==="function"\\?globalThis\\.__sandStreamShim\\(\\1,' +
  '\\{CE:[\\w$]+\\.[\\w$]+,Code:[\\w$]+\\.[\\w$]+\\}\\):\\1\\);' + escapeRegExp(SAND_STREAM_SHIM_HOOK_MARKER);
const STREAM_SHIM_BLOCK_RE_SRC = escapeRegExp(SAND_STREAM_SHIM_MARKER) + '[\\s\\S]*?' + escapeRegExp(SAND_STREAM_SHIM_END);

// 垫片源码（注入到 chunk 文件头、"use strict"; 之后）。纯 ES2018，无 minified 标识依赖；全程 try/catch，装不上就原样返回 client。
function streamShimJs() {
  return (
    '(function(){try{var G=(typeof globalThis!=="undefined")?globalThis:this;' +
    'if(!G||typeof G.__sandStreamShim==="function")return;' +
    'var EFFORTS=["low","medium","high","extra-high","xhigh","max"];' +
    // 模型家族 → promptModelMetadata（字段与 aiserver.v1.RunInferencePromptModelMetadata 一致；vendor/promptVersion 取白名单内值）
    'function meta(mid,params){var s=String(mid||"").toLowerCase(),eff;' +
    'try{(params||[]).forEach(function(p){if(p&&p.id==="effort"&&p.value!=null)eff=String(p.value);});}catch(x){}' +
    'var t=function(re){return re.test(s)};' +
    'var isClaude=t(/claude|opus|sonnet|haiku|fable/),isGpt=t(/gpt|codex|^o\\d/),isGemini=t(/gemini/),isGrok=t(/grok/),' +
    'isComposer=t(/composer|cursor-big|dsv3|titanium|matterhorn/),isCodex=t(/codex/),gpt5=t(/gpt-?5/);' +
    'var m={vendor:isClaude?"anthropic":isGpt?"openai":isGemini?"gemini":isGrok?"xai":isComposer?"cursor":"unknown",' +
    'promptVersion:isCodex?"gpt5-codex":t(/haiku/)?"haiku":isComposer?"cursor-0226":"latest",useDsv3Harness:false,' +
    'isClaude4x:isClaude,isFable5:t(/fable-?5/),isOpus5:t(/opus-?5/),isOpus48:t(/opus-?4[.-]8/),isOpus46:t(/opus-?4[.-]6/),isOpus45:t(/opus-?4[.-]5/),' +
    'isSonnet45:t(/sonnet-?4[.-]5/),isSonnet4:t(/sonnet-?4/),isGemini3:t(/gemini-?3/),' +
    'isGpt5Family:gpt5,isGpt5:gpt5&&!t(/gpt-?5[.-]\\d/),isGpt51:t(/gpt-?5[.-]1(?!\\d)/),isGpt52:t(/gpt-?5[.-]2(?!\\d)/)&&!isCodex,' +
    'isGpt54:t(/gpt-?5[.-]4/),isGpt55:t(/gpt-?5[.-]5/),isGpt56:t(/gpt-?5[.-]6/),isCodexFamily:isCodex,' +
    'isGpt52Codex:t(/gpt-?5[.-]2-codex/),isGpt53Codex:t(/gpt-?5[.-]3-codex/),isGpt53CodexSpark:t(/gpt-?5[.-]3-codex-spark/),' +
    'isComposer1:t(/composer-?1(?![.-]?\\d)/),isComposer15:t(/composer-?1[.-]5/),isComposer2:t(/composer-?2/),isComposerMatterhorn:t(/matterhorn/),' +
    'isGrok45ProductPrompt:isGrok,isFruitcake:t(/fruitcake/),isRawTrainingSlug:false};' +
    'if(eff&&EFFORTS.indexOf(eff)>=0)m.reasoningEffort=eff;return m;}' +
    // 把 client.stream 抛出的错误映射成 invocationEnd.error{message,code,details}（官方 ure() 再还原成 ConnectError 走正常分类）
    'function toErr(CE,Code,err){var ce=err;try{if(CE&&typeof CE.from==="function"&&!(err instanceof CE))ce=CE.from(err);}catch(x){ce=err;}' +
    'var code=(ce&&typeof ce.code==="number")?ce.code:((Code&&Code.Unknown)||2);' +
    'var msg=ce?(ce.rawMessage!=null?String(ce.rawMessage):String(ce.message||"")):String(err);var details=[];' +
    'try{var ds=(ce&&Array.isArray(ce.details))?ce.details:[];for(var i=0;i<ds.length;i++){var d=ds[i];if(!d)continue;' +
    'if(typeof d.type==="string"&&d.value!=null)details.push({type:d.type,value:d.value});' +
    'else if(typeof d.getType==="function"&&typeof d.toBinary==="function")details.push({type:d.getType().typeName,value:d.toBinary()});}}catch(x){}' +
    'return{message:msg,code:code,details:details};}' +
    // 服务端消息队列（AsyncIterable），语义对齐官方 BiDi 响应流
    'function Q(){this.items=[];this.waiters=[];this.done=false;this.err=undefined;this.onClose=null;}' +
    'Q.prototype.push=function(v){if(this.done)return;var w=this.waiters.shift();if(w)w.resolve({value:v,done:false});else this.items.push(v);};' +
    'Q.prototype.end=function(err){if(this.done)return;this.done=true;this.err=err;var ws=this.waiters.splice(0);' +
    'for(var i=0;i<ws.length;i++){if(err)ws[i].reject(err);else ws[i].resolve({value:undefined,done:true});}' +
    'var f=this.onClose;this.onClose=null;if(typeof f==="function"){try{f();}catch(x){}}};' +
    'Q.prototype[Symbol.asyncIterator]=function(){var q=this;var it={' +
    'next:function(){if(q.items.length)return Promise.resolve({value:q.items.shift(),done:false});' +
    'if(q.done)return q.err?Promise.reject(q.err):Promise.resolve({value:undefined,done:true});' +
    'return new Promise(function(res,rej){q.waiters.push({resolve:res,reject:rej});});},' +
    'return:function(){q.end();return Promise.resolve({value:undefined,done:true});},' +
    'throw:function(e){q.end();return Promise.reject(e);}};it[Symbol.asyncIterator]=function(){return it;};return it;};' +
    'G.__sandStreamShim=function(client,deps){if(!client||typeof client.stream!=="function")return client;' +
    'var CE=deps&&deps.CE,Code=deps&&deps.Code;var w=Object.create(client);' +
    'w.runInference=function(input,opts){var out=new Q(),active=new Map(),runReq=null,finishing=false,ended=false;var signal=opts&&opts.signal;' +
    'function finishIfIdle(){if(finishing&&active.size===0&&!ended){ended=true;out.end();}}' +
    'function shutdown(){if(ended)return;ended=true;active.forEach(function(ac){try{ac.abort();}catch(x){}});active.clear();out.end();}' +
    'out.onClose=shutdown;' +
    'if(signal){if(signal.aborted){shutdown();return out;}try{signal.addEventListener("abort",shutdown,{once:true});}catch(x){}}' +
    // 补回官方 RunInference 路径剥掉的 requested_model(7)/conversation_id(8)/conversation_group_id(12)/invocation_id(6)
    'function fill(req,inv){var r=req;try{if(req&&typeof req.clone==="function")r=req.clone();}catch(x){r=req;}' +
    'try{if(runReq){if(runReq.requestedModel&&r.requestedModel==null)r.requestedModel=runReq.requestedModel;' +
    'if(runReq.conversationId&&!r.conversationId)r.conversationId=runReq.conversationId;' +
    'if(runReq.conversationGroupId&&!r.conversationGroupId)r.conversationGroupId=runReq.conversationGroupId;}' +
    'if(inv&&inv.invocationId&&!r.invocationId)r.invocationId=inv.invocationId;}catch(x){}return r;}' +
    // 瞬时错误判定：Aborted(10，connect-node 把 ECONNRESET/"aborted"/"socket hang up" 都映成它)、Unavailable(14，含 HTTP 502/503/504)、
    // DeadlineExceeded(4，无显式 deadline 时只可能是网络层 ETIMEDOUT)。Internal/Unknown 等可能是真服务端错误，不重试，交官方分类。
    'var ABORTED=(Code&&Code.Aborted)||10,UNAVAILABLE=(Code&&Code.Unavailable)||14,DEADLINE=(Code&&Code.DeadlineExceeded)||4,CANCELED=(Code&&Code.Canceled)||1;' +
    // 实测 H2 路径上对端会发 RST_STREAM CANCEL(0x8) → connect-node 映成 Canceled(1)；这里已先排除本地取消（ac.signal.aborted），
    // 剩下的 Canceled 全是对端/传输层的，和 Aborted 同等对待：首帧前透明重试，首帧后改映射成 Unavailable。
    'var RETRY_DELAYS=[1000,3000,8000];' +
    'function transient(e){return e.code===ABORTED||e.code===UNAVAILABLE||e.code===DEADLINE||e.code===CANCELED;}' +
    'function sleep(ms,sig){return new Promise(function(r){if(sig&&sig.aborted)return r();var t=setTimeout(r,ms);if(sig){sig.addEventListener("abort",function(){clearTimeout(t);r();},{once:true});}});}' +
    // 每个 invokeModel → 一次 client.stream()。首帧之前遇到瞬时错误：原请求原样重试（对官方完全透明，不触发 resumeAction，
    // 不改 prompt 前缀，cache 不失效）；首帧之后出错只能如实上报——但非本地取消的 Aborted 改成 Unavailable 上报，
    // 否则官方分类把 "aborted" 当用户取消 → CancelledError → 整回合硬失败；Unavailable 会走它的传输错误重试。
    'function invoke(inv){var id=inv.invocationId;var ac=new AbortController();active.set(id,ac);' +
    '(async function(){var req=fill(inv.request,inv),emitted=false,attempt=0,t0=Date.now();' +
    'try{for(;;){var ta=Date.now();try{var it=client.stream(req,{signal:ac.signal});' +
    'for await(var res of it){if(ended)break;emitted=true;out.push({message:{case:"invocationResponse",value:{invocationId:id,response:res}}});}' +
    'if(!ended)out.push({message:{case:"invocationEnd",value:{invocationId:id}}});break;}' +
    'catch(err){if(ended)break;var e=toErr(CE,Code,err);' +
    // 诊断日志（进 exthost.log）：错误码/文案、是否已收到首帧、本次尝试耗时、距离该步开始的总耗时
    'try{console.warn("[sand-shim] stream error",{invocationId:id,attempt:attempt,code:e.code,message:String(e.message).slice(0,160),emitted:emitted,attemptMs:Date.now()-ta,sinceStartMs:Date.now()-t0,selfAborted:ac.signal.aborted});}catch(x){}' +
    'if(ac.signal.aborted){e.code=CANCELED;out.push({message:{case:"invocationEnd",value:{invocationId:id,error:e}}});break;}' +
    'if(!emitted&&transient(e)&&attempt<RETRY_DELAYS.length){var d=RETRY_DELAYS[attempt];attempt++;' +
    'try{console.warn("[sand-shim] retrying before first frame",{invocationId:id,attempt:attempt,delayMs:d});}catch(x){}' +
    'await sleep(d,ac.signal);if(ended||ac.signal.aborted)break;continue;}' +
    'if(e.code===ABORTED||e.code===CANCELED){e.code=UNAVAILABLE;e.message="upstream stream reset ("+e.message+")";}' +
    'out.push({message:{case:"invocationEnd",value:{invocationId:id,error:e}}});break;}}}' +
    'finally{active.delete(id);finishIfIdle();}})();}' +
    // 持续消费输入（WritableIterable.write 要等消费者 next() 才 resolve，不能停）
    '(async function(){try{for await(var msg of input){if(ended)break;var m=msg&&msg.message,c=m&&m.case,v=m&&m.value;' +
    'if(c==="runRequest"){runReq=v||{};var rm=runReq.requestedModel;' +
    'if(!rm||typeof rm!=="object")rm=runReq.requestedModel={modelId:"",maxMode:false,parameters:[],builtInModel:false,isVariantStringRepresentation:false};' +
    'if(!Array.isArray(rm.parameters))rm.parameters=[];' +
    'out.push({message:{case:"runReady",value:{resolvedModel:rm,supportsSelfSummary:false,routedModelDisplayName:undefined,promptModelMetadata:meta(rm.modelId,rm.parameters)}}});}' +
    'else if(c==="invokeModel"){if(v&&v.invocationId)invoke(v);}' +
    'else if(c==="cancelInvocation"){var ac=v&&active.get(v.invocationId);if(ac){try{ac.abort();}catch(x){}}}' +
    'else if(c==="finishRun"){finishing=true;finishIfIdle();}}}catch(err){}' +
    'finishing=true;finishIfIdle();})();' +
    'return out;};return w;};}catch(e){}})();'
  );
}
// ---- SAND_STREAM_H2_V1：让 InferenceService/Stream 走 H2 传输（修「聊着聊着 Connection Error」）----
// 垫片把每步推理发成独立的 /Stream 请求；默认路由落到 _backendTransport（HTTP/1.1、无超时、无保活、每步新建 TCP+TLS）。
// 实测日志：长上下文（35 万 token）步骤在 H1 上频繁被对端重置——`[aborted] socket hang up` / `[aborted] aborted` / `HTTP 502`，
// 官方分类把 "aborted" 当用户取消 → CancelledError → 回合直接失败（Connection Error）；能重试的那些又触发 resumeAction
// 改写 prompt 前缀 → 35 万 token 全量 cache 重写（$4.39 一次）。官方 RunInference 同一后端同一对话 33 步一次不断，
// 差别就在它走 agenticComposerTransport：H2 单连接 + pingConfig 保活 + 服务端 heartbeat。
// 这里把 Stream 方法挂到同一个 agenticComposerTransport 上（baseUrl 也是 api2，实测 H2 /Stream 可通）。
// 注意 H1 降级形态（用户关 H2）下 agenticComposerTransport 是 SSE-bidi 包装（S.stream 会把输入换成 BidiRequestId），
// 不能承载普通 ServerStreaming，所以按 isHttp2 条件路由，关 H2 时回落 _backendTransport（=今天的行为）。
// _getTransportForService 按方法名查表：库里 name:"Stream" 仅 InferenceService / HealthService 两处，后者在查表前已特判，无撞名。
const SAND_STREAM_H2_MARKER = '/*SAND_STREAM_H2_V1*/';
const SAND_STREAM_TRANSPORT_MARKER = '/*SAND_STREAM_TRANSPORT_V1*/';
// 文件门控：只有 agent-host 的路由 chunk（选 managed-local 的那段代码）才有这个字面量；always-local 同款传输表不打。
const STREAM_H2_FILE_GATE = 'managed-local-http2-unavailable';

// ---- SAND_STREAM_TRANSPORT_V1：给 Stream 单独建一条 H2 传输，PING 参数显式写死 ----
// agenticComposerTransport 的 pingConfig 来自 getHttp2PingConfig(AGENTIC_COMPOSER)：该调用点没有 fallbackDefaults，
// 值全靠 Statsig 动态下发；没下发/未 enabled 时 connect-node 里 pingIntervalMs=+Infinity → 这条 H2 会话根本不发 PING，
// 长上下文步骤的静默期（首字前几十秒、思考停顿）就裸露在代理/负载均衡的空闲超时下。
// 这里在 createTransportsForLatestContext 的传输表里追加 sandStreamTransport：同 baseUrl(api2)、同 useHttp2 判定、
// 同 maybeUseCppSpoofToken，但 pingConfig 直接给定：15s 一次 PING、60s 超时（容忍几 MB 请求体把 PING 帧排在后面）、空闲 5min 回收。
// 变量名（baseUrl 的 o / useHttp2 的 r / keepalive 的 t,n）全部从相邻的 originTransport / agenticComposerTransport 项里捕获。
const SAND_STREAM_PING_CONFIG = '{pingIdleConnection:!0,pingIntervalMs:15e3,pingTimeoutMs:6e4,idleConnectionTimeoutMs:3e5}';
const STREAM_TRANSPORT_RE_SRC =
  '(getHttp1KeepaliveDisabled:([\\w$]+),http1KeepaliveInitialDelayMs:([\\w$]+)\\}\\),' +
  'agenticComposerTransport:this\\.bidiTransportFactory\\.createTransport\\(\\{baseUrl:([\\w$]+),useHttp2:!([\\w$]+),' +
  'pingConfig:yield\\(0,[\\w$]+\\.getHttp2PingConfig\\)\\(this\\.host,[\\w$]+\\.Http2TransportCallSite\\.AGENTIC_COMPOSER\\),' +
  'maybeUseCppSpoofToken:!0,bidiTransport:this\\._bidiTransport\\}\\),)' +
  '(?!sandStreamTransport:)';
function streamTransportSub(m, head, ka, kd, baseVar, h2Var) {
  return head +
    'sandStreamTransport:this.transportFactory.createTransport({baseUrl:' + baseVar + ',useHttp2:!' + h2Var +
    ',maybeUseCppSpoofToken:!0,pingConfig:' + SAND_STREAM_PING_CONFIG +
    ',getHttp1KeepaliveDisabled:' + ka + ',http1KeepaliveInitialDelayMs:' + kd + '})' + SAND_STREAM_TRANSPORT_MARKER + ',';
}
const STREAM_TRANSPORT_RESTORE_RE_SRC =
  'sandStreamTransport:this\\.transportFactory\\.createTransport\\(\\{baseUrl:[\\w$]+,useHttp2:![\\w$]+,' +
  'maybeUseCppSpoofToken:!0,pingConfig:\\{[^{}]*\\},getHttp1KeepaliveDisabled:[\\w$]+,http1KeepaliveInitialDelayMs:[\\w$]+\\}\\)' +
  escapeRegExp(SAND_STREAM_TRANSPORT_MARKER) + ',';

// ---- SAND_STREAM_H2_V1：InferenceService/Stream 路由到上面这条专用传输（H2 时）----
// 官方形状：this._overrideMethodNameToTransportMap[_.InferenceService.methods.runInference.name]=e.agenticComposerTransport
// 专用传输没建成（别的构建形状变了）或用户关了 H2（isHttp2=false）时回落 _backendTransport（= 今天的行为）。
const STREAM_H2_RE_SRC =
  '(this\\._overrideMethodNameToTransportMap\\[([\\w$]+)\\.InferenceService\\.methods\\.runInference\\.name\\]=([\\w$]+)\\.agenticComposerTransport)' +
  '(?!,this\\._overrideMethodNameToTransportMap\\[\\2\\.InferenceService\\.methods\\.stream\\.name\\])';
function streamH2Sub(m, head, svcMod, tr) {
  return head +
    ',this._overrideMethodNameToTransportMap[' + svcMod + '.InferenceService.methods.stream.name]=(' +
    tr + '.sandStreamTransport&&' + tr + '.sandStreamTransport.isHttp2?' + tr + '.sandStreamTransport:this._backendTransport)' +
    SAND_STREAM_H2_MARKER;
}
// 还原要同时认得早期形状（曾指向 agenticComposerTransport）和现形状（sandStreamTransport）
const STREAM_H2_RESTORE_RE_SRC =
  ',this\\._overrideMethodNameToTransportMap\\[[\\w$]+\\.InferenceService\\.methods\\.stream\\.name\\]=\\(' +
  '([\\w$]+)\\.(agenticComposerTransport|sandStreamTransport)&&\\1\\.\\2\\.isHttp2\\?\\1\\.\\2:this\\._backendTransport\\)' +
  escapeRegExp(SAND_STREAM_H2_MARKER);

// 幂等 + 可升级：先剥掉旧块，再插到 "use strict"; 之后（保住严格模式指令；没有该指令就插文件头）
function injectStreamShimBlock(content) {
  const next = content.replace(new RegExp(STREAM_SHIM_BLOCK_RE_SRC, 'g'), '');
  const block = SAND_STREAM_SHIM_MARKER + streamShimJs() + SAND_STREAM_SHIM_END;
  const m = /^(?:"use strict";|'use strict';)/.exec(next);
  if (m) return next.slice(0, m[0].length) + block + next.slice(m[0].length);
  return block + next;
}

// ---- 1.1.5 遗留形状（本工具 v1.0.11–1.0.13 打出的 Stream 三处是「整段字面量替换」，原片段已被覆盖）----
// 1.1.8 的 marker 精确回退对这种形状匹配不到；SandClaimer 1.1.8 自身也没有处理。为了让老用户能干净
// 「回退」或「重新打补丁」升级到 1.1.8 形状，这里按 1.1.5 当时匹配的字面量原样还原（1.1.5 只会在这些
// 字面量精确存在的构建上命中，所以还原出来的就是该构建的真实原文；其它构建根本不会有这种 marker）。
// 必须在 1.1.8 的正则回退之后执行：move_exec 的 1.1.5 形状 `p=!0/*MARK*/` 是 1.1.8 形状
// `p=!0/*MARK*/||await …` 的前缀，用负向前瞻 (?!\|\|) 再保一道。
const LEGACY_115_STREAM_RESTORES = [
  ['managed_local_route',
    escapeRegExp('try{return' + SAND_MANAGED_LOCAL_ROUTE_MARKER + '{runtime:"managed-local",reason:"sand-client"}}catch(e)'),
    'try{return(yield o.checkFeatureGate(ae))?{runtime:"managed-local",reason:"eligible"}:{runtime:"connect",reason:"gate-off"}}catch(e)'],
  ['local_runtime_load',
    escapeRegExp('let t=!0;' + SAND_LOCAL_RUNTIME_LOAD_MARKER + 'try{t=!0}'),
    'let t=!1;try{t=await r.cursor.checkFeatureGate(Ds)}'],
  ['move_exec',
    escapeRegExp('p=!0' + SAND_MOVE_EXEC_MARKER) + '(?!\\|\\|)',
    'p=await Promise.resolve(r.cursor.checkFeatureGate(Us)).catch(()=>!1)'],
];

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
// [相对路径, 扩展名(null=非扩展)]  —— 与 sand_patch.py TARGET_SPECS 一致
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
];
// agent-host dist 里承载 managed-local 路由 / Stream 逻辑的 chunk 文件名（657 / 675 / …）随每次构建变化，
// 写死编号会漏掉路由锚点所在 chunk。1.1.8 起改为运行时扫描整个 dist 目录（排除 main.js 与 *-worker.js）。
const AGENT_HOST_DIST_REL = 'extensions/cursor-agent-host/dist';
const EXT_HOST_REL = 'out/vs/workbench/api/node/extensionHostProcess.js';

class SandToolError extends Error {}

// 小工具（escapeRegExp 在上面的常量定义里已经用到，靠函数声明提升）
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
    new RegExp(MANAGED_LOCAL_ROUTE_RE_SRC).test(content) ||
    new RegExp(LOCAL_RUNTIME_LOAD_RE_SRC).test(content) ||
    content.includes(AGENT_HOST_IDENTITY_ORIGINAL) ||
    content.includes(DIRECT_STREAM_ANCHOR) ||
    new RegExp(MOVE_EXEC_GATE_RE_SRC).test(content) ||
    new RegExp(AGENT_HOST_ENABLEMENT_RE_SRC).test(content) ||
    new RegExp(LOCAL_ACTIONS_RE_SRC).test(content) ||
    new RegExp(SUBAGENT_RUN_OPTIONS_RE_SRC).test(content) ||
    new RegExp(FORCE_API2_RE_SRC).test(content) ||
    new RegExp(STREAM_SHIM_HOOK_RE_SRC).test(content) ||
    (content.includes(STREAM_H2_FILE_GATE) && new RegExp(STREAM_H2_RE_SRC).test(content))
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
function applyPatchToContent(content, includeStream = true) {
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

  // 11) managed-local Stream 五件套（注入，1.1.8 泛化正则版）— 仅 Stream 模式（includeStream）时打，
  //     且由 engine 保证「全或无」：凑不齐五件套时会以 includeStream=false 重打，绝不打半套。
  //     与 sand_patch.py apply_patch_to_content 顺序一致：route → runtime_load → identity → move_exec。
  if (includeStream) {
    {
      const [n, c] = subnAll(next, new RegExp(MANAGED_LOCAL_ROUTE_RE_SRC, 'g'), managedLocalRouteSub);
      next = n; stats.managed_local_route += c;
    }
    {
      const [n, c] = subnAll(next, new RegExp(LOCAL_RUNTIME_LOAD_RE_SRC, 'g'), localRuntimeLoadSub);
      next = n; stats.local_runtime_load += c;
    }
    {
      const c = countOcc(next, AGENT_HOST_IDENTITY_ORIGINAL);
      if (c) { next = replaceAllLiteral(next, AGENT_HOST_IDENTITY_ORIGINAL, AGENT_HOST_IDENTITY_PATCHED); stats.agent_host_identity += c; }
    }
    {
      const [n, c] = subnAll(next, new RegExp(MOVE_EXEC_GATE_RE_SRC, 'g'), moveExecGateSub);
      next = n; stats.move_exec += c;
    }
    // 11b) 1.2.1：本地回路准入放宽 + 子代理短路（修 ERROR_NOT_LOGGED_IN）
    {
      const [n, c] = subnAll(next, new RegExp(LOCAL_ACTIONS_RE_SRC, 'g'), localActionsSub);
      next = n; stats.local_actions += c;
    }
    {
      const [n, c] = subnAll(next, new RegExp(SUBAGENT_RUN_OPTIONS_RE_SRC, 'g'), subagentRunOptionsSub);
      next = n; stats.subagent_local += c;
    }
    // 11c) 1.2.x：sand 流量强制走 api2 端点（修 "Sand traffic is not supported on this endpoint"）
    {
      const [n, c] = subnAll(next, new RegExp(FORCE_API2_RE_SRC, 'g'), forceApi2Sub);
      next = n; stats.force_api2 += c;
    }
    // 11d) managed-local 推理改走 InferenceService/Stream：attempt 钩子 + 文件头垫片块（同一 chunk 内成对出现）。
    //      钩子带负向前瞻天然幂等；垫片块每次刷新都重新注入（升级垫片代码），钩子不在的文件不留块。
    {
      const [n, c] = subnAll(next, new RegExp(STREAM_SHIM_HOOK_RE_SRC, 'g'), streamShimHookSub);
      next = n; stats.stream_shim += c;
      const hooked = c > 0 || new RegExp(STREAM_SHIM_HOOK_RESTORE_RE_SRC).test(next);
      if (hooked) next = injectStreamShimBlock(next);
      else if (next.includes(SAND_STREAM_SHIM_MARKER)) next = next.replace(new RegExp(STREAM_SHIM_BLOCK_RE_SRC, 'g'), '');
    }
    // 11e) InferenceService/Stream 挂到 H2 agenticComposerTransport（PING 保活；关 H2 时按 isHttp2 回落 _backendTransport）。
    //      同一段传输表代码在 cursor-always-local 里也有一份（Tab/cpp 用），跟 agent 推理无关，不去动它：
    //      只在同文件含 managed-local 路由字面量（agent-host 路由 chunk 独有）时才打。
    if (next.includes(STREAM_H2_FILE_GATE)) {
      // 先建专用传输（sandStreamTransport），再把 Stream 路由挂上去；两条都命中才是完整形态。
      {
        const [n, c] = subnAll(next, new RegExp(STREAM_TRANSPORT_RE_SRC, 'g'), streamTransportSub);
        next = n; stats.stream_transport += c;
      }
      const [n, c] = subnAll(next, new RegExp(STREAM_H2_RE_SRC, 'g'), streamH2Sub);
      next = n; stats.stream_h2 += c;
    }
  }

  // 12) 剥离 1.1.0–1.1.3 的 createPromptSession 短路（清理旧状态，始终执行）
  {
    const [n, c] = stripDirectStreamInjection(next);
    next = n; stats.direct_stream += c;
  }

  // 13) 强制开启 agent-host（只改第一个，与 py 的 count=1 一致）— 仅 Stream 模式
  if (includeStream && !next.includes(SAND_AGENT_HOST_ENABLEMENT_MARKER)) {
    const re = new RegExp(AGENT_HOST_ENABLEMENT_RE_SRC);
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
  // managed-local 五件套还原（1.1.8：按 marker 精确回退，原片段本就保留为死代码/短路，去掉注入即还原）
  {
    // 'try{return{runtime:"managed-local",reason:"sand-client"}/*MARK*/;' + 原三元 + '}catch(x)'  →  'try{return' + 原三元 + '}catch(x)'
    const [n, c] = subnAll(next, new RegExp(MANAGED_LOCAL_ROUTE_RESTORE_RE_SRC, 'g'), () => 'try{return');
    next = n; stats.managed_local_route += c;
  }
  {
    const [n, c] = subnAll(next, new RegExp(LOCAL_RUNTIME_LOAD_RESTORE_RE_SRC, 'g'), () => '');
    next = n; stats.local_runtime_load += c;
  }
  {
    const c = countOcc(next, AGENT_HOST_IDENTITY_PATCHED);
    if (c) { next = replaceAllLiteral(next, AGENT_HOST_IDENTITY_PATCHED, AGENT_HOST_IDENTITY_ORIGINAL); stats.agent_host_identity += c; }
  }
  {
    const [n, c] = subnAll(next, new RegExp(MOVE_EXEC_GATE_RESTORE_RE_SRC, 'g'), moveExecGateRestore);
    next = n; stats.move_exec += c;
  }
  // 1.2.1 规则A/B 还原：本地回路准入 marker 区间整体删除；子代理短路还原为 ||(...)
  {
    const [n, c] = subnAll(next, new RegExp(LOCAL_ACTIONS_RESTORE_RE_SRC, 'g'), () => '');
    next = n; stats.local_actions += c;
  }
  {
    // 还原成 ||<inner>（原文没有外层括号，apply 时才加的 !1&&(...)，卸载要脱干净）
    const [n, c] = subnAll(next, new RegExp(SUBAGENT_RUN_OPTIONS_RESTORE_RE_SRC, 'g'), (m, inner) => '||' + inner);
    next = n; stats.subagent_local += c;
  }
  {
    const [n, c] = subnAll(next, new RegExp(FORCE_API2_RESTORE_RE_SRC, 'g'), forceApi2Restore);
    next = n; stats.force_api2 += c;
  }
  // Stream 垫片：去掉 attempt 钩子语句 + 文件头垫片块（两者都是纯注入，删掉即还原）
  {
    const [n, c] = subnAll(next, new RegExp(STREAM_SHIM_HOOK_RESTORE_RE_SRC, 'g'), () => '');
    next = n; stats.stream_shim += c;
    const [n2, c2] = subnAll(next, new RegExp(STREAM_SHIM_BLOCK_RE_SRC, 'g'), () => '');
    next = n2; stats.stream_shim += c2;
  }
  // Stream → H2 传输路由 + 专用传输项：都是纯追加，删掉即还原
  {
    const [n, c] = subnAll(next, new RegExp(STREAM_H2_RESTORE_RE_SRC, 'g'), () => '');
    next = n; stats.stream_h2 += c;
    const [n2, c2] = subnAll(next, new RegExp(STREAM_TRANSPORT_RESTORE_RE_SRC, 'g'), () => '');
    next = n2; stats.stream_transport += c2;
  }
  // 1.1.5 遗留形状还原（见 LEGACY_115_STREAM_RESTORES 注释；放在 1.1.8 正则回退之后）
  for (const [key, reSrc, original] of LEGACY_115_STREAM_RESTORES) {
    const [n, c] = subnAll(next, new RegExp(reSrc, 'g'), () => original);
    next = n; stats[key] += c;
  }
  { const [n, c] = stripDirectStreamInjection(next); next = n; stats.direct_stream += c; }
  // agent-host enablement 还原
  {
    const [n, c] = subnAll(next, new RegExp(AGENT_HOST_ENABLEMENT_PATCH_RE_SRC, 'g'), (m, g1, g2, g3) => g2 + g1 + g3);
    next = n; stats.agent_host_enablement += c;
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
    local_actions: 0, subagent_local: 0, force_api2: 0, stream_shim: 0, stream_h2: 0, stream_transport: 0,
  };
}
function newRemoveStats() {
  return {
    client_type: 0, eligibility: 0, rpc_rewrite: 0, managed_local_route: 0,
    local_runtime_load: 0, direct_stream: 0, agent_host_enablement: 0,
    agent_host_identity: 0, move_exec: 0,
    local_actions: 0, subagent_local: 0, force_api2: 0, stream_shim: 0, stream_h2: 0, stream_transport: 0,
  };
}

module.exports = {
  TOOL_VERSION,
  SandToolError,
  TARGET_SPECS,
  AGENT_HOST_DIST_REL,
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
    SAND_MODEL_UNLOCK_MARKER, SAND_MEM_PRO_MARKER, SAND_MAXMODE_MARKER, SAND_GLASSFIX_MARKER,
    SAND_HDRFIX_V2_MARKER, SAND_MEMBERSHIP_MARKER, SAND_MANAGED_LOCAL_ROUTE_MARKER,
    SAND_LOCAL_RUNTIME_LOAD_MARKER, SAND_DIRECT_STREAM_MARKER, SAND_AGENT_HOST_ENABLEMENT_MARKER,
    SAND_AGENT_HOST_IDENTITY_MARKER, SAND_MOVE_EXEC_MARKER,
    SAND_LOCAL_ACTIONS_MARKER, SAND_LOCAL_ACTIONS_END, SAND_SUBAGENT_LOCAL_MARKER, SAND_FORCE_API2_MARKER,
    SAND_STREAM_SHIM_MARKER, SAND_STREAM_SHIM_END, SAND_STREAM_SHIM_HOOK_MARKER, SAND_STREAM_H2_MARKER, SAND_STREAM_TRANSPORT_MARKER,
    LEGACY_SAND_CLIENT_MARKER, LEGACY_SAND_ELIGIBILITY_MARKER,
  },
  // 供单测 / 诊断：垫片源码与钩子正则
  streamShimJs, STREAM_SHIM_HOOK_RE_SRC, STREAM_SHIM_HOOK_RESTORE_RE_SRC, STREAM_SHIM_BLOCK_RE_SRC,
  STREAM_H2_RE_SRC, STREAM_H2_RESTORE_RE_SRC, STREAM_TRANSPORT_RE_SRC, STREAM_TRANSPORT_RESTORE_RE_SRC,
  MEMBERSHIP_SNIPPET_RE_SRC,
  escapeRegExp, countOcc, replaceAllLiteral, sha256hex, productChecksum, sleep,
};
