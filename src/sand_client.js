'use strict';
// 调 Cursor 官方 Sand 推理：POST https://api2.cursor.sh/aiserver.v1.InferenceService/Stream
// Connect 协议（application/connect+proto），请求/响应都是 5 字节信封帧；带 client-type=sand + checksum → 走 bot 额度。
//
// 头集合对齐 Cursor 3.18.9 connect 拦截器（workbench AJg）+ sand 运行时三件套（sand_rpc.js），顺序按 fetch Headers 语义字母序。
// 错误统一抛 UpstreamError（httpStatus / connectCode / errorEnum / title / detail / retryAfterMs / headers），供 errors.classify()。
//
// ⚠️ 传输仍是 Node https（HTTP/1.1）；改 node:http2 + 连接复用是 P1（见优化方案 5.1.2）。
const https = require('https');
const http = require('http');
const zlib = require('zlib');
const crypto = require('crypto');
const { encInferenceRequest, decInferenceResponse, encodeEnvelope, createEnvelopeParser } = require('./sand_protobuf');
const { cursorChecksum, sha256hex } = require('./sand_checksum');
const { ERROR_ENUM } = require('./sand_errors');

// SAND_UPSTREAM 仅供本地 mock 测试覆盖，例如 http://127.0.0.1:8899
const UP = new URL(process.env.SAND_UPSTREAM || 'https://api2.cursor.sh');
const HOST = UP.hostname;
const PORT = UP.port ? Number(UP.port) : (UP.protocol === 'http:' ? 80 : 443);
const AGENT_MOD = UP.protocol === 'http:' ? http : https;
const PATH = '/aiserver.v1.InferenceService/Stream';

class UpstreamError extends Error {
  constructor(message, fields) {
    super(message || 'upstream error');
    Object.assign(this, { httpStatus: 0, connectCode: null, errorEnum: null, errorEnumNo: null, title: null, detail: null, isRetryable: null, retryAfterMs: 0, headers: {}, bodySnippet: '' }, fields || {});
  }
}

// ---- protobuf 小工具（只读 varint / bytes）----
function rv(u, st) { let n = 0, s = 0, b; do { b = u[st.i++]; n = n | ((b & 127) << s); s += 7; } while (b & 128 && st.i < u.length); return n >>> 0; }
function skip(u, st, w) { if (w === 0) rv(u, st); else if (w === 1) st.i += 8; else if (w === 5) st.i += 4; else if (w === 2) { const l = rv(u, st); st.i += l; } else st.i = u.length; }
// aiserver.v1.CustomErrorDetails { 1 title, 2 detail, 4 is_retryable }
function decCustomDetails(u) {
  const st = { i: 0 }, o = {};
  while (st.i < u.length) {
    const t = rv(u, st), f = t >>> 3, w = t & 7;
    if (w === 2) { const l = rv(u, st); const sl = u.slice(st.i, st.i + l); st.i += l; if (f === 1) o.title = sl.toString('utf8'); else if (f === 2) o.detail = sl.toString('utf8'); }
    else if (w === 0) { const v = rv(u, st); if (f === 4) o.isRetryable = !!v; }
    else skip(u, st, w);
  }
  return o;
}
// aiserver.v1.ErrorDetails { 1 error(enum), 2 details(CustomErrorDetails), 3 is_expected }
function decErrorDetails(u) {
  const st = { i: 0 }, o = {};
  while (st.i < u.length) {
    const t = rv(u, st), f = t >>> 3, w = t & 7;
    if (w === 0) { const v = rv(u, st); if (f === 1) { o.errorEnumNo = v; o.errorEnum = ERROR_ENUM[v] || ('ERROR_#' + v); } else if (f === 3) o.isExpected = !!v; }
    else if (w === 2) { const l = rv(u, st); const sl = u.slice(st.i, st.i + l); st.i += l; if (f === 2) Object.assign(o, decCustomDetails(sl)); }
    else skip(u, st, w);
  }
  return o;
}

// 解析 Connect 错误 JSON（unary 错误体或 EndStream trailer 的 error 字段）
function parseConnectError(errObj) {
  const out = { connectCode: errObj && errObj.code ? String(errObj.code) : null, message: (errObj && errObj.message) || '' };
  const details = (errObj && Array.isArray(errObj.details)) ? errObj.details : [];
  for (const d of details) {
    try {
      if (d && typeof d.value === 'string' && /ErrorDetails$/.test(String(d.type || ''))) {
        const buf = Buffer.from(d.value.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
        Object.assign(out, decErrorDetails(buf));
      }
      // connect-es 在注册了类型时会附带 debug JSON
      if (d && d.debug) {
        const dbg = d.debug;
        if (dbg.error && !out.errorEnum) out.errorEnum = String(dbg.error);
        if (dbg.details) { out.title = out.title || dbg.details.title; out.detail = out.detail || dbg.details.detail; if (dbg.details.isRetryable != null) out.isRetryable = !!dbg.details.isRetryable; }
      }
    } catch { /* 单条 detail 解不出来就跳过 */ }
  }
  if (!out.message && out.title) out.message = out.title + (out.detail ? ': ' + out.detail : '');
  return out;
}

function retryAfterMs(h) {
  const v = h && (h['retry-after'] || h['retry-after-ms']);
  if (!v) return 0;
  if (h['retry-after-ms']) return Math.max(0, parseInt(h['retry-after-ms'], 10) || 0);
  const n = parseInt(v, 10);
  if (!isNaN(n)) return Math.max(0, n * 1000);
  const d = Date.parse(v); return isNaN(d) ? 0 : Math.max(0, d - Date.now());
}

// 头集合：按 fetch Headers 迭代语义（小写字母序）排列
function buildHeaders(account, body, opts) {
  const prof = Object.assign({ os: 'linux', arch: 'x64', osVersion: 'unknown', deviceType: 'desktop', timezone: 'UTC', clientVersion: '0.18.0', includeMacMachineId: true, headerProfile: 'full' }, opts.clientProfile || {});
  const reqId = crypto.randomUUID();
  const dev = account.device || {};
  const h = {
    authorization: 'Bearer ' + account.accessToken,
    'connect-protocol-version': '1',
    'content-type': 'application/connect+proto',
    'user-agent': 'connect-es/1.6.1',
    'x-cursor-checksum': cursorChecksum(dev.machineId || sha256hex('m:' + account.identity), prof.includeMacMachineId ? dev.macMachineId : undefined),
    'x-cursor-client-type': 'sand',
    'x-cursor-client-version': opts.clientVersion || prof.clientVersion,
    'x-request-id': reqId,
    'x-sand-box-namespace': 'prod',
  };
  if (prof.headerProfile !== 'minimal') {
    Object.assign(h, {
      'accept-encoding': 'gzip, deflate, br',
      'x-amzn-trace-id': 'Root=' + reqId,
      'x-client-key': sha256hex(account.accessToken),
      'x-cursor-client-arch': prof.arch,
      'x-cursor-client-device-type': prof.deviceType,
      'x-cursor-client-os': prof.os,
      'x-cursor-client-os-version': prof.osVersion,
      'x-cursor-config-version': dev.configVersion || '',
      'x-cursor-timezone': prof.timezone,
      'x-ghost-mode': opts.ghostMode || 'implicit-false',
      'x-new-onboarding-completed': 'false',
      'x-session-id': account.sessionId || crypto.randomUUID(),
    });
  } else {
    h['accept-encoding'] = 'identity';
  }
  h['content-length'] = String(Buffer.byteLength(body));
  const sorted = {};
  for (const k of Object.keys(h).sort()) if (h[k] !== '' && h[k] != null) sorted[k] = h[k];
  return sorted;
}

function decompressStream(res) {
  const enc = String(res.headers['content-encoding'] || '').toLowerCase();
  if (enc === 'gzip') return res.pipe(zlib.createGunzip());
  if (enc === 'br') return res.pipe(zlib.createBrotliDecompress());
  if (enc === 'deflate') return res.pipe(zlib.createInflate());
  return res;
}

// account: { accessToken, identity, device, sessionId }
// spec:    { mid, maxm, params, msgs, cid }
// opts:    { clientVersion, clientProfile, ghostMode, timeoutMs, firstByteTimeoutMs, signal }
// cb:      { onHeaders(status, headers), onText(t), onThink(t), onDone() }
// 成功 resolve；任何失败 reject(UpstreamError)。中途（已有内容后）的 trailer 错误同样 reject，调用方按是否已输出决定处理。
function streamInference(account, spec, opts, cb) {
  opts = opts || {}; cb = cb || {};
  return new Promise((resolve, reject) => {
    const payload = encInferenceRequest(spec);
    const body = encodeEnvelope(payload, 0);
    const headers = buildHeaders(account, body, opts);
    let settled = false;
    const fail = (err) => { if (settled) return; settled = true; reject(err); };
    const ok = () => { if (settled) return; settled = true; resolve(); };

    const req = AGENT_MOD.request({ hostname: HOST, port: PORT, path: PATH, method: 'POST', headers }, (res) => {
      const status = res.statusCode | 0;
      const rh = res.headers || {};
      if (cb.onHeaders) { try { cb.onHeaders(status, rh); } catch { /* ignore */ } }
      const src = decompressStream(res);

      if (status !== 200) {
        let buf = '';
        src.setEncoding('utf8');
        src.on('data', (c) => { if (buf.length < 65536) buf += c; });
        src.on('end', () => {
          let parsed = {};
          try { const j = JSON.parse(buf); parsed = parseConnectError(j.error || j); } catch { /* 非 JSON（可能是 Cloudflare HTML） */ }
          fail(new UpstreamError(parsed.message || ('HTTP ' + status), {
            httpStatus: status, connectCode: parsed.connectCode || null, errorEnum: parsed.errorEnum || null, errorEnumNo: parsed.errorEnumNo || null,
            title: parsed.title || null, detail: parsed.detail || null, isRetryable: parsed.isRetryable, retryAfterMs: retryAfterMs(rh), headers: rh, bodySnippet: buf.slice(0, 2000),
          }));
        });
        src.on('error', (e) => fail(new UpstreamError(e.message, { httpStatus: status, headers: rh })));
        return;
      }

      let trailerErr = null; let inbandErr = null; let gotFinal = false;
      const parse = createEnvelopeParser((flag, data) => {
        if (flag & 1) { inbandErr = inbandErr || new UpstreamError('上游返回了压缩帧（未启用 connect 压缩却收到 flag&1）', { httpStatus: 200, headers: rh, connectCode: 'internal' }); return; }
        if (flag & 2) {
          try {
            const tr = data.length ? JSON.parse(data.toString('utf8')) : {};
            if (tr && tr.error) {
              const p = parseConnectError(tr.error);
              trailerErr = new UpstreamError(p.message || 'upstream error', { httpStatus: 200, connectCode: p.connectCode, errorEnum: p.errorEnum, errorEnumNo: p.errorEnumNo, title: p.title, detail: p.detail, isRetryable: p.isRetryable, retryAfterMs: retryAfterMs(rh), headers: rh });
            }
          } catch { /* 空 trailer 正常 */ }
          return;
        }
        const inf = decInferenceResponse(data);
        if (inf.err) inbandErr = inbandErr || new UpstreamError(inf.err, { httpStatus: 200, headers: rh, connectCode: 'unknown' });
        if (inf.think && cb.onThink) cb.onThink(inf.think);
        if (inf.text && cb.onText) cb.onText(inf.text);
        if (inf.final) gotFinal = true;
      });
      src.on('data', (c) => { try { parse(c); } catch (e) { fail(new UpstreamError('响应帧解析失败: ' + e.message, { httpStatus: 200, headers: rh, connectCode: 'internal' })); req.destroy(); } });
      src.on('end', () => {
        if (trailerErr) return fail(trailerErr);
        if (inbandErr && !gotFinal) return fail(inbandErr);
        if (cb.onDone) { try { cb.onDone(); } catch { /* ignore */ } }
        ok();
      });
      src.on('error', (e) => fail(new UpstreamError(e.message, { httpStatus: 200, headers: rh, connectCode: 'unavailable' })));
    });

    req.on('error', (e) => {
      if (opts.signal && opts.signal.aborted) return fail(new UpstreamError('client aborted', { connectCode: 'canceled' }));
      fail(new UpstreamError('网络错误: ' + e.message, { connectCode: 'unavailable', networkError: true }));
    });
    req.setTimeout(opts.timeoutMs || 180000, () => req.destroy(new Error('上游超时')));
    if (opts.signal) {
      const onAbort = () => req.destroy(new Error('client aborted'));
      if (opts.signal.aborted) onAbort(); else opts.signal.addEventListener('abort', onAbort, { once: true });
    }
    req.write(body);
    req.end();
  });
}

// 模型探测：对一批 model id 各发一条极短请求，返回哪些真正能用（走 sand 通道、maxMode 关、带 cid）。
// account: { accessToken, identity, device, sessionId }；opts: { clientVersion, clientProfile, timeoutMs, onProgress, concurrency }
async function probeModels(account, models, opts) {
  opts = opts || {};
  const runOpts = { clientVersion: opts.clientVersion || '0.18.0', clientProfile: opts.clientProfile || {}, timeoutMs: opts.timeoutMs || 45000 };
  const list = Array.isArray(models) ? models : [];
  const results = [];
  const one = async (mid) => {
    const spec = { mid, maxm: false, params: [{ id: 'effort', value: 'low' }], msgs: [{ r: 1, t: 'Reply with exactly one word: OK' }], cid: crypto.randomUUID() };
    let text = ''; let err = null; let ttft = 0; const t0 = Date.now();
    try {
      await streamInference(account, spec, runOpts, { onText: (t) => { if (!ttft) ttft = Date.now() - t0; text += t; } });
    } catch (e) { err = e instanceof UpstreamError ? e : new UpstreamError(e.message, {}); }
    const ok = !!text && !err;
    const rec = { model: mid, ok, ttftMs: ttft || null,
      errorEnum: err ? (err.errorEnum || err.connectCode || 'error') : null,
      detail: err ? String(err.title || err.message || '').slice(0, 120) : null };
    results.push(rec);
    if (opts.onProgress) { try { opts.onProgress(rec, results.length, list.length); } catch { /* ignore */ } }
    return rec;
  };
  // 小并发（默认 3），逐批跑，避免把号打限流
  const conc = Math.max(1, Math.min(6, opts.concurrency || 3));
  for (let i = 0; i < list.length; i += conc) await Promise.all(list.slice(i, i + conc).map(one));
  results.sort((a, b) => (b.ok - a.ok) || a.model.localeCompare(b.model));
  return { ok: results.filter((r) => r.ok).map((r) => r.model), results };
}

module.exports = { streamInference, probeModels, buildHeaders, parseConnectError, decErrorDetails, UpstreamError, HOST, PATH };
