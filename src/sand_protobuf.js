'use strict';
// InferenceService/Stream 的 protobuf 编解码 + Connect 协议信封。
// 编码/解码逻辑移植自 SandClaimer 的 sand_rpc.js（现成逆向实现），改写为 Node Buffer 版。
//
// 请求 InferenceStreamRequest（字段号来自逆向）：
//   field1: repeated message { field1=role(varint: 1=user,2=assistant,4=system), field2=text(string) }
//   field7: requestedModel { field1=modelId(string), field2=maxMode(bool), field3=repeated param{field1=id,field2=value} }
//   field8: conversationId(string, 可选)
// 响应 InferenceStreamResponse：
//   field1: part { field1=text(string), field2=final(bool) }
//   field9: thinking part { field1=text }
//   field8: error(string)

function uv(n) { const a = []; n = n >>> 0; while (n > 127) { a.push((n & 127) | 128); n = n >>> 7; } a.push(n); return a; }
function u8(s) { return Buffer.from(String(s), 'utf8'); }
function cat(xs) { return Buffer.concat(xs.map((x) => (Buffer.isBuffer(x) ? x : Buffer.from(x)))); }
function tag(f, w) { return Buffer.from(uv((f << 3) | w)); }
function bstr(f, s) { const b = u8(s); return cat([tag(f, 2), Buffer.from(uv(b.length)), b]); }
function bmsg(f, inner) { return cat([tag(f, 2), Buffer.from(uv(inner.length)), inner]); }
function bvar(f, n) { if (!n) return Buffer.alloc(0); return cat([tag(f, 0), Buffer.from(uv(n))]); }
function bbool(f, v) { return v ? cat([tag(f, 0), Buffer.from([1])]) : Buffer.alloc(0); }

// spec: { mid:string, maxm:bool, params:[{id,value}], msgs:[{r,t}], cid?:string }
function encInferenceRequest(spec) {
  const parts = [];
  for (const m of (spec.msgs || [])) parts.push(bmsg(1, cat([bvar(1, m.r), bstr(2, m.t)])));
  const rm = [bstr(1, spec.mid || 'grok-4.6'), bbool(2, !!spec.maxm)];
  for (const pv of (spec.params || [])) {
    if (pv && pv.id) rm.push(bmsg(3, cat([bstr(1, pv.id), bstr(2, String(pv.value == null ? '' : pv.value))])));
  }
  parts.push(bmsg(7, cat(rm)));
  if (spec.cid) parts.push(bstr(8, spec.cid));
  return cat(parts);
}

function rv(u, st) { let n = 0, s = 0, b; do { b = u[st.i++]; n = n | ((b & 127) << s); s += 7; } while (b & 128 && st.i < u.length); return n >>> 0; }
function skip(u, st, w) { if (w === 0) rv(u, st); else if (w === 1) st.i += 8; else if (w === 5) st.i += 4; else if (w === 2) { const l = rv(u, st); st.i += l; } else st.i = u.length; }
function decPart(u) { const st = { i: 0 }, o = {}; while (st.i < u.length) { const t = rv(u, st), f = t >>> 3, w = t & 7; if (w === 0) { const v = rv(u, st); if (f === 2) o.final = !!v; } else if (w === 2) { const l = rv(u, st); if (f === 1) o.text = u.slice(st.i, st.i + l).toString('utf8'); st.i += l; } else skip(u, st, w); } return o; }
function decStr1(u) { const st = { i: 0 }; while (st.i < u.length) { const t = rv(u, st), f = t >>> 3, w = t & 7; if (w === 2) { const l = rv(u, st); if (f === 1) return u.slice(st.i, st.i + l).toString('utf8'); st.i += l; } else skip(u, st, w); } return ''; }

// 返回 { text?, think?, final?, err? }
function decInferenceResponse(u) {
  const st = { i: 0 }, out = {};
  while (st.i < u.length) {
    const t = rv(u, st), f = t >>> 3, w = t & 7;
    if (w === 2) {
      const l = rv(u, st); const sl = u.slice(st.i, st.i + l); st.i += l;
      if (f === 1) { const p = decPart(sl); if (p.text) out.text = p.text; if (p.final) out.final = 1; }
      else if (f === 9) { const p = decPart(sl); if (p.text) out.think = p.text; }
      else if (f === 8) { out.err = decStr1(sl) || 'inference error'; }
    } else skip(u, st, w);
  }
  return out;
}

// ---- Connect 协议信封：[flag(1B)][len(uint32be)][payload] ----
function encodeEnvelope(payload, flag = 0) {
  const h = Buffer.alloc(5); h[0] = flag; h.writeUInt32BE(payload.length, 1);
  return Buffer.concat([h, payload]);
}
// 流式解析：返回一个 push(chunk) 函数，逐帧回调 onFrame(flag, dataBuffer)
function createEnvelopeParser(onFrame) {
  let buf = Buffer.alloc(0);
  return function push(chunk) {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 5) {
      const flag = buf[0];
      const len = buf.readUInt32BE(1);
      if (buf.length < 5 + len) break;
      const data = buf.slice(5, 5 + len);
      buf = buf.slice(5 + len);
      onFrame(flag, data);
    }
  };
}

module.exports = { encInferenceRequest, decInferenceResponse, encodeEnvelope, createEnvelopeParser };
