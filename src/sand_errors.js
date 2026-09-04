'use strict';
// 上游错误分类：Connect code / HTTP 状态 / aiserver.v1.ErrorDetails.Error 枚举 → 动作。
// 枚举编号与名称抽取自 Cursor 3.18.9 workbench.desktop.main.js（makeEnum("aiserver.v1.ErrorDetails.Error")）。
// 设计对齐 CLIProxyAPI sdk/cliproxy/auth/conductor_cooldown.go MarkResult 的语义：
//   scope   : none | model | account | pool        冷却作用域
//   action  : continue | stop | reauth | ignore     continue=换号重试, reauth=重换 token 后同号重试一次
//   disable : 账号永久下线（需人工恢复）
//   http/code/type : 回给下游的 OpenAI 风格错误

const ERROR_ENUM = {
  0: 'ERROR_UNSPECIFIED', 1: 'ERROR_BAD_API_KEY', 2: 'ERROR_NOT_LOGGED_IN', 3: 'ERROR_INVALID_AUTH_ID',
  4: 'ERROR_NOT_HIGH_ENOUGH_PERMISSIONS', 5: 'ERROR_BAD_MODEL_NAME', 6: 'ERROR_USER_NOT_FOUND',
  7: 'ERROR_FREE_USER_RATE_LIMIT_EXCEEDED', 8: 'ERROR_PRO_USER_RATE_LIMIT_EXCEEDED', 9: 'ERROR_FREE_USER_USAGE_LIMIT',
  10: 'ERROR_PRO_USER_USAGE_LIMIT', 11: 'ERROR_AUTH_TOKEN_NOT_FOUND', 12: 'ERROR_AUTH_TOKEN_EXPIRED', 13: 'ERROR_OPENAI',
  14: 'ERROR_OPENAI_RATE_LIMIT_EXCEEDED', 18: 'ERROR_AGENT_REQUIRES_LOGIN', 20: 'ERROR_MAX_TOKENS', 21: 'ERROR_USER_ABORTED_REQUEST',
  22: 'ERROR_GENERIC_RATE_LIMIT_EXCEEDED', 23: 'ERROR_PRO_USER_ONLY', 25: 'ERROR_TIMEOUT', 28: 'ERROR_GPT_4_VISION_PREVIEW_RATE_LIMIT',
  29: 'ERROR_CUSTOM_MESSAGE', 30: 'ERROR_OUTDATED_CLIENT', 31: 'ERROR_CLAUDE_IMAGE_TOO_LARGE', 33: 'ERROR_FILE_NOT_FOUND',
  34: 'ERROR_API_KEY_RATE_LIMIT', 35: 'ERROR_DEBOUNCED', 36: 'ERROR_BAD_REQUEST', 37: 'ERROR_REPOSITORY_SERVICE_REPOSITORY_IS_NOT_INITIALIZED',
  38: 'ERROR_UNAUTHORIZED', 39: 'ERROR_NOT_FOUND', 40: 'ERROR_DEPRECATED', 41: 'ERROR_RESOURCE_EXHAUSTED', 42: 'ERROR_BAD_USER_API_KEY',
  43: 'ERROR_CONVERSATION_TOO_LONG', 44: 'ERROR_USAGE_PRICING_REQUIRED', 45: 'ERROR_USAGE_PRICING_REQUIRED_CHANGEABLE',
  46: 'ERROR_GITHUB_NO_USER_CREDENTIALS', 47: 'ERROR_GITHUB_USER_NO_ACCESS', 48: 'ERROR_GITHUB_APP_NO_ACCESS', 49: 'ERROR_GITHUB_MULTIPLE_OWNERS',
  50: 'ERROR_RATE_LIMITED', 51: 'ERROR_RATE_LIMITED_CHANGEABLE', 52: 'ERROR_CUSTOM', 53: 'ERROR_HOOKS_BLOCKED', 54: 'ERROR_SUSPICIOUS_USAGE_BLOCKED',
  55: 'ERROR_EXTENSION_HOST_TIMEOUT', 56: 'ERROR_NETWORK_ERROR', 57: 'ERROR_PROVIDER_ERROR', 58: 'ERROR_MODEL_BLOCKED', 59: 'ERROR_INTERNAL',
  60: 'ERROR_MAX_MODE_REQUIRED', 61: 'ERROR_MODEL_NO_LONGER_SUPPORTED', 62: 'ERROR_PRICING_WARNING', 63: 'ERROR_SLOW_POOL',
  64: 'ERROR_UNSUPPORTED_REGION', 65: 'ERROR_ACCOUNT_CLOSED',
};

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
// 限流指数退避（对应 Quota.BackoffLevel）
const RATE_BACKOFF = [30 * 1000, MIN, 5 * MIN, 15 * MIN, 30 * MIN];
// Cloudflare / 边缘拦截：池级阶梯退避
const POOL_BACKOFF = [MIN, 5 * MIN, 30 * MIN];

const SETS = {
  usage: new Set(['ERROR_FREE_USER_USAGE_LIMIT', 'ERROR_PRO_USER_USAGE_LIMIT', 'ERROR_USAGE_PRICING_REQUIRED',
    'ERROR_USAGE_PRICING_REQUIRED_CHANGEABLE', 'ERROR_RESOURCE_EXHAUSTED']),
  rate: new Set(['ERROR_RATE_LIMITED', 'ERROR_RATE_LIMITED_CHANGEABLE', 'ERROR_FREE_USER_RATE_LIMIT_EXCEEDED',
    'ERROR_PRO_USER_RATE_LIMIT_EXCEEDED', 'ERROR_GENERIC_RATE_LIMIT_EXCEEDED', 'ERROR_API_KEY_RATE_LIMIT',
    'ERROR_GPT_4_VISION_PREVIEW_RATE_LIMIT', 'ERROR_DEBOUNCED']),
  transient: new Set(['ERROR_OPENAI', 'ERROR_OPENAI_RATE_LIMIT_EXCEEDED', 'ERROR_SLOW_POOL', 'ERROR_TIMEOUT', 'ERROR_PROVIDER_ERROR',
    'ERROR_INTERNAL', 'ERROR_NETWORK_ERROR', 'ERROR_EXTENSION_HOST_TIMEOUT']),
  auth: new Set(['ERROR_UNAUTHORIZED', 'ERROR_NOT_LOGGED_IN', 'ERROR_BAD_API_KEY', 'ERROR_BAD_USER_API_KEY', 'ERROR_INVALID_AUTH_ID',
    'ERROR_AUTH_TOKEN_NOT_FOUND', 'ERROR_AUTH_TOKEN_EXPIRED', 'ERROR_AGENT_REQUIRES_LOGIN', 'ERROR_USER_NOT_FOUND']),
  permission: new Set(['ERROR_NOT_HIGH_ENOUGH_PERMISSIONS', 'ERROR_PRO_USER_ONLY', 'ERROR_MAX_MODE_REQUIRED', 'ERROR_UNSUPPORTED_REGION']),
  model: new Set(['ERROR_BAD_MODEL_NAME', 'ERROR_MODEL_BLOCKED', 'ERROR_MODEL_NO_LONGER_SUPPORTED', 'ERROR_NOT_FOUND']),
  request: new Set(['ERROR_MAX_TOKENS', 'ERROR_CONVERSATION_TOO_LONG', 'ERROR_CLAUDE_IMAGE_TOO_LARGE', 'ERROR_BAD_REQUEST',
    'ERROR_HOOKS_BLOCKED', 'ERROR_FILE_NOT_FOUND']),
  outdated: new Set(['ERROR_OUTDATED_CLIENT', 'ERROR_DEPRECATED']),
};

function backoff(table, level) { return table[Math.min(Math.max(level | 0, 0), table.length - 1)]; }

function looksLikeCloudflare(sig) {
  const h = sig.headers || {};
  if (h['cf-mitigated'] || (h['server'] === 'cloudflare' && [403, 429, 503, 520, 521, 522, 523, 524].includes(sig.httpStatus) && !sig.connectCode)) return true;
  const m = String(sig.message || '');
  return /attention required|cloudflare|error code:\s*10[12]0|just a moment/i.test(m) && /<html|<!doctype/i.test(m);
}

// sig: { httpStatus?, connectCode?, errorEnum? (name|number), message?, retryAfterMs?, headers?, level? (该账号当前退避级别), poolLevel? }
function classify(sig) {
  sig = sig || {};
  const en = typeof sig.errorEnum === 'number' ? ERROR_ENUM[sig.errorEnum] : (sig.errorEnum || '');
  const code = String(sig.connectCode || '').toLowerCase();
  const st = sig.httpStatus | 0;
  const msg = String(sig.message || '');
  const base = { errorEnum: en || null, connectCode: code || null, httpStatus: st || null, message: msg.slice(0, 400) };

  if (looksLikeCloudflare(sig)) {
    return { ...base, kind: 'cloudflare', action: 'stop', scope: 'pool', cooldownMs: backoff(POOL_BACKOFF, sig.poolLevel), http: 503, code: 'upstream_blocked', type: 'server_error', alert: true };
  }
  if (en === 'ERROR_USER_ABORTED_REQUEST' || code === 'canceled') {
    return { ...base, kind: 'aborted', action: 'ignore', scope: 'none', cooldownMs: 0, http: 499, code: 'client_closed_request', type: 'invalid_request_error' };
  }
  if (en === 'ERROR_SUSPICIOUS_USAGE_BLOCKED') {
    return { ...base, kind: 'suspicious', action: 'stop', scope: 'account', disable: true, throttlePool: true, cooldownMs: 0, http: 403, code: 'account_blocked', type: 'server_error', alert: true };
  }
  if (en === 'ERROR_ACCOUNT_CLOSED') {
    return { ...base, kind: 'closed', action: 'continue', scope: 'account', disable: true, cooldownMs: 0, http: 502, code: 'upstream_account_closed', type: 'server_error' };
  }
  if (SETS.outdated.has(en)) {
    return { ...base, kind: 'outdated', action: 'stop', scope: 'none', cooldownMs: 0, http: 502, code: 'client_fingerprint_rejected', type: 'server_error', alert: true };
  }
  if (SETS.usage.has(en)) {
    // 额度耗尽：账号级，到下次重置（调用方可用 GetSandUsageStatus.nextReset 覆盖），默认 6h
    return { ...base, kind: 'usage', action: 'continue', scope: 'account', cooldownMs: sig.retryAfterMs || 6 * HOUR, reason: 'usage_limit', http: 429, code: 'insufficient_quota', type: 'insufficient_quota' };
  }
  if (SETS.rate.has(en) || code === 'resource_exhausted' || st === 429) {
    return { ...base, kind: 'rate', action: 'continue', scope: 'account', cooldownMs: sig.retryAfterMs || backoff(RATE_BACKOFF, sig.level), bumpLevel: true, reason: 'rate_limit', http: 429, code: 'rate_limit_exceeded', type: 'rate_limit_error' };
  }
  if (SETS.auth.has(en) || code === 'unauthenticated' || st === 401) {
    // 先重换 token 试一次；调用方在第二次仍失败时按 disable 处理
    return { ...base, kind: 'auth', action: 'reauth', scope: 'account', cooldownMs: 30 * MIN, disableOnRepeat: true, reason: 'auth_failed', http: 502, code: 'upstream_auth_failed', type: 'server_error' };
  }
  if (SETS.permission.has(en) || code === 'permission_denied' || st === 403) {
    return { ...base, kind: 'permission', action: 'continue', scope: 'model', cooldownMs: 12 * HOUR, reason: 'permission_denied', http: 403, code: 'model_not_permitted', type: 'permission_error' };
  }
  if (SETS.model.has(en) || code === 'not_found' || st === 404) {
    return { ...base, kind: 'model', action: 'stop', scope: 'none', cooldownMs: 0, http: 404, code: 'model_not_found', type: 'invalid_request_error' };
  }
  if (SETS.request.has(en) || code === 'invalid_argument' || code === 'failed_precondition' || st === 400 || st === 413) {
    const ctx = /token|too long|context|conversation/i.test(en + ' ' + msg);
    return { ...base, kind: 'request', action: 'stop', scope: 'none', cooldownMs: 0, http: 400, code: ctx ? 'context_length_exceeded' : 'invalid_request_error', type: 'invalid_request_error' };
  }
  if (en === 'ERROR_PRICING_WARNING') {
    return { ...base, kind: 'warning', action: 'ignore', scope: 'none', cooldownMs: 0, http: 200, code: null, type: null };
  }
  if (SETS.transient.has(en) || ['unavailable', 'internal', 'deadline_exceeded', 'unknown', 'aborted', 'data_loss'].includes(code) || st === 408 || (st >= 500 && st <= 599)) {
    return { ...base, kind: 'transient', action: 'continue', scope: 'model', cooldownMs: MIN, reason: 'transient', http: st >= 500 ? 502 : 503, code: 'upstream_error', type: 'server_error' };
  }
  // ERROR_CUSTOM / ERROR_CUSTOM_MESSAGE / ERROR_UNSPECIFIED / 网络层错误：靠文案兜底
  if (/usage limit|quota|out of credits|spending limit|plan limit|pricing/i.test(msg)) {
    return { ...base, kind: 'usage', action: 'continue', scope: 'account', cooldownMs: 6 * HOUR, reason: 'usage_limit', http: 429, code: 'insufficient_quota', type: 'insufficient_quota' };
  }
  if (/rate limit|too many requests|slow down/i.test(msg)) {
    return { ...base, kind: 'rate', action: 'continue', scope: 'account', cooldownMs: backoff(RATE_BACKOFF, sig.level), bumpLevel: true, reason: 'rate_limit', http: 429, code: 'rate_limit_exceeded', type: 'rate_limit_error' };
  }
  if (/not logged in|unauthorized|invalid.*token|token.*expired/i.test(msg)) {
    return { ...base, kind: 'auth', action: 'reauth', scope: 'account', cooldownMs: 30 * MIN, disableOnRepeat: true, reason: 'auth_failed', http: 502, code: 'upstream_auth_failed', type: 'server_error' };
  }
  return { ...base, kind: 'unknown', action: 'continue', scope: 'model', cooldownMs: MIN, reason: 'unknown_error', http: 502, code: 'upstream_error', type: 'server_error' };
}

// 下游 OpenAI 风格错误体
function toOpenAIError(c, extra) {
  return { error: { message: c.message || c.code || 'upstream error', type: c.type || 'server_error', code: c.code || null, param: null, ...(extra || {}) } };
}

module.exports = { ERROR_ENUM, classify, toOpenAIError, RATE_BACKOFF, POOL_BACKOFF };
