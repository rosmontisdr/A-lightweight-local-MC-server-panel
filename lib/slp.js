'use strict';
/**
 * Minecraft Server List Ping（1.7+ 现代协议），纯 TCP 实现。
 * 无需服务器插件或 RCON，只要 enable-status=true 即可获取版本 / MOTD / 在线人数 / 延迟。
 */
const net = require('net');

function writeVarInt(v) {
  const bytes = [];
  let val = v >>> 0;
  do {
    let b = val & 0x7f;
    val >>>= 7;
    if (val !== 0) b |= 0x80;
    bytes.push(b);
  } while (val !== 0);
  return Buffer.from(bytes);
}

function writeString(s) {
  const b = Buffer.from(s, 'utf8');
  return Buffer.concat([writeVarInt(b.length), b]);
}

/** 构造 Handshake + Status Request */
function buildRequest(host, port) {
  const hostBuf = writeString(host);
  const handshake = Buffer.concat([
    Buffer.from([0x00]),          // packet id
    writeVarInt(-1),              // protocol version: -1 = 未知，服务端忽略
    hostBuf,
    Buffer.from([(port >> 8) & 0xff, port & 0xff]),
    writeVarInt(1),               // next state: status
  ]);
  const handshakePacket = Buffer.concat([writeVarInt(handshake.length), handshake]);
  const statusRequest = Buffer.from([0x01, 0x00]); // length=1, id=0x00
  return Buffer.concat([handshakePacket, statusRequest]);
}

/** 从 buffer 的 offset 读取 VarInt，返回 [值, 新偏移]；数据不足返回 null */
function readVarInt(buf, offset) {
  let result = 0;
  let shift = 0;
  let pos = offset;
  while (true) {
    if (pos >= buf.length) return null;
    const b = buf[pos++];
    result |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) break;
    shift += 7;
    if (shift > 35) throw new Error('VarInt 过长');
  }
  return [result >>> 0, pos];
}

/**
 * @returns {Promise<{ok:boolean, latency:number|null, error?:string,
 *   version?:{name:string,protocol:number}, players?:{online:number,max:number,sample:string[]},
 *   motd?:string, favicon?:string }>}
 */
function ping(host, port, timeout = 5000) {
  return new Promise((resolve) => {
    const started = Date.now();
    let settled = false;
    let buf = Buffer.alloc(0);
    let gotFirstChunk = false;
    let latency = null;

    const done = (res) => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch {}
      resolve(res);
    };

    const socket = net.connect({ host, port });
    socket.setTimeout(timeout);

    socket.on('connect', () => {
      socket.write(buildRequest(host, port));
    });

    socket.on('data', (chunk) => {
      if (!gotFirstChunk) {
        gotFirstChunk = true;
        latency = Date.now() - started;
      }
      buf = Buffer.concat([buf, chunk]);
      try {
        const lenRes = readVarInt(buf, 0);
        if (!lenRes) return;
        const [len, afterLen] = lenRes;
        if (buf.length < afterLen + len) return;

        let pos = afterLen;
        const idRes = readVarInt(buf, pos);
        if (!idRes) return;
        pos = idRes[1];
        const strLenRes = readVarInt(buf, pos);
        if (!strLenRes) return;
        pos = strLenRes[1];
        const json = buf.slice(pos, pos + strLenRes[0]).toString('utf8');
        const data = JSON.parse(json);

        const desc = data.description;
        let motd;
        if (typeof desc === 'string') motd = desc;
        else motd = flattenChat(desc);

        done({
          ok: true,
          latency,
          version: data.version || null,
          players: {
            online: data.players?.online ?? 0,
            max: data.players?.max ?? 0,
            sample: (data.players?.sample || []).map((p) => p.name),
          },
          motd: motd || '',
          favicon: data.favicon || null,
        });
      } catch (e) {
        done({ ok: false, latency: null, error: '解析失败: ' + e.message });
      }
    });

    socket.on('timeout', () => done({ ok: false, latency: null, error: '连接超时' }));
    socket.on('error', (e) => done({ ok: false, latency: null, error: e.code || e.message }));
  });
}

/** 将聊天组件递归拼接为纯文本 */
function flattenChat(node) {
  if (node == null) return '';
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(flattenChat).join('');
  let out = '';
  if (node.text) out += node.text;
  if (node.extra) out += flattenChat(node.extra);
  return out;
}

module.exports = { ping, flattenChat };
