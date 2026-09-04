'use strict';
// x-cursor-checksum：与 Cursor 3.18.9 workbench 里的 AJg/TJg 逐字节一致（静态抽取核对过）：
//   C = Math.floor(Date.now()/1e6)
//   bytes = Uint8Array([C>>40&255, C>>32&255, C>>24&255, C>>16&255, C>>8&255, C&255])   ← 注意 JS 32 位移位语义
//   t=165; for n: bytes[n] = (bytes[n]^t) + n%256 (Uint8Array 自动 &255); t = bytes[n]
//   header = base64url(bytes) + machineId [+ "/" + macMachineId]
// 缺这个头，服务端会把请求当旧客户端拒绝：ERROR_OUTDATED_CLIENT。
const crypto = require('crypto');

function sha256hex(s) { return crypto.createHash('sha256').update(String(s), 'utf8').digest('hex'); }
function base64Url(buf) { return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }

function timestampBlob() {
  const C = Math.floor(Date.now() / 1e6);
  // 与客户端完全相同的表达式：`>>` 是 32 位移位，C>>40 实际等于 C>>8，C>>32 等于 C
  const x = new Uint8Array([C >> 40 & 255, C >> 32 & 255, C >> 24 & 255, C >> 16 & 255, C >> 8 & 255, C & 255]);
  let t = 165;
  for (let n = 0; n < x.length; n += 1) { x[n] = (x[n] ^ t) + n % 256; t = x[n]; }
  return base64Url(Buffer.from(x));
}

// machineId / macMachineId 都是 64 hex（对应 telemetryService.machineId / macMachineId）
function cursorChecksum(machineId, macMachineId) {
  const I = timestampBlob();
  return macMachineId === undefined || macMachineId === null ? `${I}${machineId}` : `${I}${machineId}/${macMachineId}`;
}

// 由账号稳定身份派生设备身份（同一账号永远同一台"机器"）
function deviceIdentity(identity, encKey) {
  const salt = encKey || 'composer-api';
  return {
    machineId: sha256hex(`${salt}:cursor-machine:${identity}`),
    macMachineId: sha256hex(`${salt}:cursor-mac:${identity}`),
    configVersion: stableUuid('cursor-config', identity),
  };
}

function stableUuid(ns, val) {
  const h = sha256hex(`${ns}:${val}`).slice(0, 32);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

module.exports = { sha256hex, base64Url, cursorChecksum, deviceIdentity, stableUuid, timestampBlob };
