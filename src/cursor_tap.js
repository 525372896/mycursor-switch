'use strict';
// Cursor 客户端接口捕捉：Cursor 桌面端走 HTTP/2 + protobuf（Connect 协议），本机抓不到明文 body；
// 但它把每次对话打了哪个后端、走哪条路由、命中哪个 RPC、成败与错误，都写进了自己的日志。
// 这里 tail 这些日志，解析成「客户端 → Cursor 官方」的接口调用事件，和换号器自己的调用区分开（source=cursor）。
//
// 覆盖的日志：
//   agent-host/Cursor Agent Host.log         —— 每轮路由决策（managed-local/connect + reason + model）
//   always-local/Cursor Structured Logs.log  —— 传输层建连(baseUrl) / 提交对话 / 开流 / 结果 / 报错(含 Max 本地拦截)
//   window*/renderer.log                      —— buildRequestedModel（这次带没带 maxMode，"以为关了其实没关"在此现形）

const fs = require('fs');
const path = require('path');
const os = require('os');

let sink = null;
let watchers = [];          // { file, size }
let scanTimer = null;
let seq = 0;
const MAX = 200;
const ring = [];

function setSink(fn) { sink = typeof fn === 'function' ? fn : null; }
function list() { return ring.slice(); }
function clear() { ring.length = 0; if (sink) { try { sink({ type: 'clear', source: 'cursor' }); } catch { /* ignore */ } } }

function logsDir() {
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Cursor', 'logs');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'Cursor', 'logs');
  return path.join(os.homedir(), '.config', 'Cursor', 'logs');
}

// 找最近活跃会话目录下的目标日志文件（Cursor 每次启动新建 <时间戳> 目录）
const FRESH_MS = 10 * 60 * 1000;   // 只盯最近 10 分钟内还在写的日志文件（多窗口/多会话全覆盖）
function targetFiles() {
  const root = logsDir();
  let sessions = [];
  try { sessions = fs.readdirSync(root).filter((d) => /^\d{8}T\d{6}$/.test(d)).map((d) => path.join(root, d)); } catch { return []; }
  // 按目录名倒序取最近 8 个会话（用户可能同时开多个窗口 = 多个会话目录），再按"文件是否新鲜"过滤
  sessions = sessions.sort().slice(-8);
  const out = []; const now = Date.now();
  const walk = (dir) => {
    let ents = []; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (/Cursor Agent Host\.log$/.test(e.name) || /Cursor Structured Logs\.log$/.test(e.name) || /(^|[\\/])renderer\.log$/.test(full)) {
        try { if (now - fs.statSync(full).mtimeMs <= FRESH_MS) out.push(full); } catch { /* ignore */ }
      }
    }
  };
  for (const s of sessions) walk(s);
  return out;
}

function record(rec) {
  const r = { id: ++seq, source: 'cursor', type: 'call', phase: 'done', ...rec };
  ring.push(r); if (ring.length > MAX) ring.shift();
  if (sink) { try { sink(r); } catch { /* ignore */ } }
}

// 从一行日志解析出一次"客户端→官方"的调用事件；解析不出返回 null
function parseLine(line, file) {
  // 1) 路由决策：一次真正的推理请求，含 runtime/reason/model/conversationId
  let m = line.match(/Selected Agent Host turn runtime\s+(\{.*\})/);
  if (m) {
    let j = {}; try { j = JSON.parse(m[1]); } catch { return null; }
    const ts = tsOf(line);
    const connect = j.runtime === 'connect';
    return {
      ts, stage: connect ? '推理·经典路' : '推理·Sand', tag: 'infer',
      method: 'POST',
      url: connect ? 'https://api2.cursor.sh/aiserver.v1.ChatService/StreamUnifiedChat（客户端）' : 'https://api2.cursor.sh/aiserver.v1.InferenceService/Stream（客户端·managed-local）',
      status: 200, ms: null,
      reqBody: JSON.stringify({ model: j.modelId || j.model || '', runtime: j.runtime, actionCase: j.actionCase, conversationId: j.conversationId }, null, 2),
      respBody: 'runtime=' + j.runtime + '  reason=' + j.reason + (connect ? '\n（此路由由 Cursor 客户端选择，reason 说明为何没走 Sand）' : ''),
      note: 'reason=' + j.reason,
    };
  }
  // 2) 传输层建连：客户端与某后端建立 HTTP/2（能看出打了哪些官方域名）
  m = line.match(/HTTP2 transport created.*?"baseUrl":"(https:\/\/[^"]+)"/);
  if (m) { return { ts: tsOf(line), stage: '建连', tag: 'misc', method: 'CONNECT', url: m[1], status: 200, ms: null, respBody: 'HTTP/2 transport created' }; }
  // 3) 开流 / 提交对话 / 结果 / 报错（结构化日志）
  m = line.match(/"message":"(Chat submission started|Starting stream request|Using agent backend)"/);
  if (m) {
    const rid = (line.match(/"requestId":"([^"]+)"/) || [])[1] || '';
    const model = (line.match(/"modelName":"([^"]+)"/) || [])[1] || '';
    const label = { 'Chat submission started': '提交对话', 'Starting stream request': '开流请求', 'Using agent backend': '用 agent 后端' }[m[1]];
    return { ts: tsOf(line), stage: label, tag: 'infer', method: 'POST', url: 'https://api2.cursor.sh/aiserver.v1.*（客户端对话）', status: 200, ms: null, reqBody: JSON.stringify({ requestId: rid, model }, null, 2), respBody: m[1] };
  }
  m = line.match(/"message":"(Agent host turn failed|Error in AI response)"/);
  if (m) {
    const err = (line.match(/"error\.message":"([^"]+)"/) || [])[1] || '';
    // Max mode / Named models 这类是客户端本地校验拦截，没真正发出网络请求；单独标注，避免让人以为是服务端 500
    const isLocalGate = /Max mode is only available|Named models unavailable/i.test(err);
    return {
      ts: tsOf(line), stage: isLocalGate ? '被本地拦截' : '对话失败', tag: 'infer', method: 'POST',
      url: 'https://api2.cursor.sh/aiserver.v1.*（客户端对话）', status: isLocalGate ? 0 : 500, ms: null,
      note: isLocalGate ? '客户端本地拦截，请求未真正发出' : '',
      respBody: (isLocalGate ? '⚠ 被 Cursor 客户端本地拦下（未联网）：\n' : '服务端返回错误：') + (err || '未知'),
    };
  }
  // 4) 模型请求装配：能看到这次带没带 maxMode（很多"以为关了其实没关"的情况都在这里现形）
  m = line.match(/\[buildRequestedModel\][^\n]*/);
  if (m) {
    const s = m[0];
    const model = (s.match(/catalogModelId=([^\s]+)/) || [])[1] || '';
    const sel = (s.match(/selectedModelIds=([^\s]+)/) || [])[1] || '';
    const maxMode = (s.match(/maxMode=(\w+)/) || [])[1] || '';
    const params = (s.match(/resolvedParams=(\d+)/) || [])[1] || '';
    return {
      ts: tsOf(line), stage: '装配请求', tag: 'model', method: 'POST',
      url: 'https://api2.cursor.sh/aiserver.v1.*（客户端对话·装配）', status: 200, ms: null,
      note: maxMode === 'true' ? '⚠ 这次带 maxMode=true（free 号会被拒！模型名带 Max 未真正关闭）' : 'maxMode=false（正常）',
      reqBody: JSON.stringify({ catalogModelId: model, selectedModelIds: sel, maxMode, resolvedParams: params }, null, 2),
      respBody: 'model=' + model + '  maxMode=' + maxMode,
    };
  }
  return null;
}
function tsOf(line) { const m = line.match(/^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d+)/); return m ? Date.parse(m[1].replace(' ', 'T')) : Date.now(); }

function scanOnce() {
  const files = targetFiles();
  // 新出现的文件先登记当前大小（只捕获"启动后"的新行，不倒灌历史）
  for (const f of files) {
    if (!watchers.find((w) => w.file === f)) {
      let size = 0; try { size = fs.statSync(f).size; } catch { /* 文件可能刚消失 */ }
      watchers.push({ file: f, size });
    }
  }
  for (const w of watchers) {
    let st; try { st = fs.statSync(w.file); } catch { continue; }
    if (st.size < w.size) w.size = 0;          // 文件被轮转/重建
    if (st.size === w.size) continue;
    let buf = '';
    try { const fd = fs.openSync(w.file, 'r'); const len = st.size - w.size; const b = Buffer.alloc(len); fs.readSync(fd, b, 0, len, w.size); fs.closeSync(fd); buf = b.toString('utf8'); }
    catch { continue; }
    w.size = st.size;
    for (const line of buf.split(/\r?\n/)) { if (!line.trim()) continue; const ev = parseLine(line, w.file); if (ev) record(ev); }
  }
}

function start() {
  if (scanTimer) return { ok: true, already: true };
  watchers = [];
  scanOnce();                                   // 首次只登记基线，不产事件
  scanTimer = setInterval(() => { try { scanOnce(); } catch { /* ignore */ } }, 1000);
  if (scanTimer.unref) scanTimer.unref();
  return { ok: true };
}
function stop() { if (scanTimer) { clearInterval(scanTimer); scanTimer = null; } return { ok: true }; }

module.exports = { start, stop, setSink, list, clear, logsDir };
