'use strict';
// 接口调用录制：包裹 fetch，把本工具打给 Cursor 官方（cursor.com / api2.cursor.sh）的每一次请求
// —— 方法 / URL / 入参 / 关键请求头 / 状态码 / 返回体片段 / 耗时 —— 记进环形缓冲并实时推给界面。
// token 一律脱敏（Authorization/Cookie 只留头尾），既能看清"调了哪个接口、传了什么、返回什么"，又不泄露完整凭据。

const MAX = 200;                 // 环形缓冲最多存多少条
const ring = [];                 // 最近的调用记录
let seq = 0;
let sink = null;                 // (event) => void，由 main.js 注入，转发到渲染进程

function setSink(fn) { sink = typeof fn === 'function' ? fn : null; }

// 脱敏：Bearer/JWT/Session token 只保留头 10 尾 6；邮箱保留首字符
function maskToken(v) {
  if (!v) return v;
  return String(v).replace(/(Bearer\s+)?([A-Za-z0-9_-]{20,})(\.[A-Za-z0-9_.-]+)?/g, (m, pre, core) => {
    const head = core.slice(0, 10), tail = core.slice(-6);
    return (pre || '') + head + '…' + tail;
  });
}
function maskHeaders(h) {
  const out = {};
  for (const k of Object.keys(h || {})) {
    const lk = k.toLowerCase();
    if (lk === 'authorization' || lk === 'cookie' || lk === 'x-cursor-checksum' || lk === 'x-client-key') out[k] = maskToken(h[k]);
    else out[k] = h[k];
  }
  return out;
}
function domainOf(url) { try { return new URL(url).host; } catch { return ''; } }
// 从路径推断这次调用"在干嘛"，界面按此分组/上色
function labelOf(url) {
  const u = url || '';
  if (u.includes('/auth/me')) return { stage: '校验登录', tag: 'auth' };
  if (u.includes('/auth/stripe')) return { stage: '读套餐', tag: 'plan' };
  if (u.includes('/usage-summary')) return { stage: '读用量', tag: 'usage' };
  if (u.includes('get-current-period-usage')) return { stage: '读本期用量', tag: 'usage' };
  if (u.includes('get-sand-access-status')) return { stage: '查 Sand 资格', tag: 'sand' };
  if (u.includes('get-sand-usage-status') || u.includes('GetSandUsageStatus')) return { stage: '读 Grok 额度', tag: 'sand' };
  if (u.includes('start-sand-trial')) return { stage: '领 Sand 试用', tag: 'sand' };
  if (u.includes('request-sand-team-access')) return { stage: '团队领 Sand', tag: 'sand' };
  if (u.includes('get-filtered-usage-events')) return { stage: '读用量明细', tag: 'usage' };
  if (u.includes('loginDeepCallbackControl')) return { stage: '深链授权', tag: 'login' };
  if (u.includes('/auth/poll')) return { stage: '深链取票', tag: 'login' };
  if (u.includes('get-me')) return { stage: '读账号信息', tag: 'auth' };
  if (u.includes('AvailableModels')) return { stage: '读可用模型', tag: 'model' };
  if (u.includes('InferenceService')) return { stage: '推理', tag: 'infer' };
  return { stage: '其它', tag: 'misc' };
}
function snippet(s, n = 1200) { s = typeof s === 'string' ? s : ''; return s.length > n ? s.slice(0, n) + `…(+${s.length - n})` : s; }

function record(rec) {
  ring.push(rec);
  if (ring.length > MAX) ring.shift();
  if (sink) { try { sink(rec); } catch { /* ignore */ } }
}
function list() { return ring.slice(); }
function clear() { ring.length = 0; if (sink) { try { sink({ type: 'clear' }); } catch { /* ignore */ } } }

// 环形缓冲里 start/done/error 是同 id 的多条；合并成每次调用一条完整记录，按时间升序。
// extra：从 cursor_tap 传入的「Cursor 客户端」调用（已是合并态），一并纳入。
function merged(extra) {
  const map = new Map();
  for (const r of ring) { const key = 'tool:' + r.id; const prev = map.get(key); map.set(key, prev ? { ...prev, ...r } : r); }
  for (const r of (extra || [])) map.set('cursor:' + r.id, { ...r, source: 'cursor' });
  return [...map.values()].sort((a, b) => a.ts - b.ts);
}
// 自有 JSON：结构清晰、带阶段标签 + 来源(source: tool=换号器 / cursor=Cursor 客户端)，适合脚本再解析
function exportJson(appVersion, extra) {
  const calls = merged(extra);
  return { tool: 'mycursor-switch', appVersion: appVersion || '', exportedAt: new Date().toISOString(), note: 'tokens masked; source=tool 为换号器自身调用，source=cursor 为 Cursor 客户端日志解析', count: calls.length, calls };
}
// 标准 HAR 1.2：可被 Chrome DevTools「Network→导入」/ Charles / Insomnia 直接打开
function toHar(appVersion, extra) {
  const toHeaders = (h) => Object.keys(h || {}).map((name) => ({ name, value: String(h[name]) }));
  const ctOf = (h) => (h && (h['content-type'] || h['Content-Type'])) || 'application/json';
  const entries = merged(extra).map((r) => {
    const req = { method: r.method, url: r.url, httpVersion: 'HTTP/1.1', cookies: [], headers: toHeaders(r.reqHeaders), queryString: [], headersSize: -1, bodySize: r.reqBody ? r.reqBody.length : 0 };
    if (r.reqBody) req.postData = { mimeType: 'application/json', text: r.reqBody };
    const resp = {
      status: r.status || 0, statusText: r.error || '', httpVersion: 'HTTP/1.1', cookies: [], headers: toHeaders(r.respHeaders),
      content: { size: r.respBody ? r.respBody.length : 0, mimeType: ctOf(r.respHeaders), text: r.respBody || '' },
      redirectURL: '', headersSize: -1, bodySize: r.respBody ? r.respBody.length : 0,
    };
    return { startedDateTime: new Date(r.ts).toISOString(), time: r.ms || 0, _source: r.source || 'tool', _stage: r.stage, _tag: r.tag, request: req, response: resp, cache: {}, timings: { send: 0, wait: r.ms || 0, receive: 0 } };
  });
  return { log: { version: '1.2', creator: { name: 'mycursor-switch', version: appVersion || '' }, entries } };
}

// fetch 包裹：签名与 global fetch 一致，可直接在模块里 `const fetch = tracedFetch` 影子替换
async function tracedFetch(url, opts) {
  opts = opts || {};
  const id = ++seq;
  const method = (opts.method || 'GET').toUpperCase();
  const started = Date.now();
  const meta = labelOf(url);
  const base = { id, source: 'tool', type: 'call', ts: started, method, url, host: domainOf(url), stage: meta.stage, tag: meta.tag, reqHeaders: maskHeaders(opts.headers), reqBody: opts.body ? snippet(String(opts.body), 800) : '' };
  record({ ...base, phase: 'start' });
  try {
    const res = await fetchImpl(url, opts);
    let bodyText = '';
    try { bodyText = await res.clone().text(); } catch { /* 流式或已消费，忽略 */ }
    const respHeaders = {};
    try { res.headers.forEach((v, k) => { if (/^(content-type|content-length|retry-after|x-request-id|x-cursor)/i.test(k)) respHeaders[k] = v; }); } catch { /* ignore */ }
    record({ ...base, phase: 'done', status: res.status, ok: res.ok, ms: Date.now() - started, respHeaders, respBody: snippet(bodyText) });
    return res;
  } catch (e) {
    record({ ...base, phase: 'error', ms: Date.now() - started, error: e.message });
    throw e;
  }
}
// 真正的底层 fetch（保存引用，避免影子替换后自引用）
const fetchImpl = globalThis.fetch.bind(globalThis);

module.exports = { tracedFetch, setSink, list, clear, merged, exportJson, toHar, maskToken };
