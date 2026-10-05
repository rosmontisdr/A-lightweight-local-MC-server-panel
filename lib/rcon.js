'use strict';
/**
 * RCON 客户端（Source RCON 协议），零依赖实现。
 * 服务器非面板启动时用它执行控制台指令。
 * 前提：server.properties 中 enable-rcon=true 且已设置 rcon.password。
 */
const net = require('net');

const TYPE = { RESPONSE: 0, COMMAND: 2, AUTH: 3, AUTH_RESPONSE: 2 };

class Rcon {
  constructor({ host = '127.0.0.1', port = 25575, password, timeout = 8000 } = {}) {
    this.host = host;
    this.port = port;
    this.password = password;
    this.timeout = timeout;
    this.socket = null;
    this.buf = Buffer.alloc(0);
    this.nextId = 1;
    this.pending = new Map();
    this.authed = false;
  }

  static encode(id, type, body) {
    const payload = Buffer.from(body, 'utf8');
    const buf = Buffer.alloc(payload.length + 14);
    buf.writeInt32LE(payload.length + 10, 0);
    buf.writeInt32LE(id, 4);
    buf.writeInt32LE(type, 8);
    payload.copy(buf, 12);
    buf.writeInt16LE(0, 12 + payload.length); // 两个结尾 null 字节
    return buf;
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.socket = net.connect({ host: this.host, port: this.port });
      this.socket.setTimeout(this.timeout);
      this.socket.once('connect', resolve);
      this.socket.once('error', (e) => reject(new Error('RCON 连接失败: ' + (e.code || e.message))));
      this.socket.once('timeout', () => reject(new Error('RCON 连接超时')));
      this.socket.on('data', (d) => this._onData(d));
      this.socket.on('error', () => this._flushPending(new Error('RCON 连接中断')));
      this.socket.on('close', () => this._flushPending(new Error('RCON 连接已关闭')));
    });
  }

  _onData(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    while (this.buf.length >= 4) {
      const len = this.buf.readInt32LE(0);
      if (this.buf.length < len + 4) break;
      const id = this.buf.readInt32LE(4);
      const type = this.buf.readInt32LE(8);
      const body = this.buf.slice(12, len + 2).toString('utf8');
      this.buf = this.buf.slice(len + 4);
      this._settle(id, type, body);
    }
  }

  _settle(id, type, body) {
    // 认证失败时服务端回 id = -1
    if (id === -1) {
      const p = this.pending.get(this._authId);
      if (p) { this.pending.delete(this._authId); p.reject(new Error('RCON 密码错误')); }
      return;
    }
    const p = this.pending.get(id);
    if (p) { this.pending.delete(id); p.resolve(body); }
  }

  _flushPending(err) {
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }

  async auth() {
    if (!this.socket) await this.connect();
    const id = this.nextId++;
    this._authId = id;
    const body = await new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.write(Rcon.encode(id, TYPE.AUTH, this.password || ''));
    });
    this.authed = true;
    return body;
  }

  async send(command) {
    if (!this.authed) await this.auth();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.write(Rcon.encode(id, TYPE.COMMAND, command));
    });
  }

  close() {
    try { this.socket?.destroy(); } catch {}
    this.socket = null;
    this.authed = false;
  }
}

/** 一次性执行单条指令 */
async function exec(opts, command) {
  const c = new Rcon(opts);
  try {
    await c.auth();
    return await c.send(command);
  } finally {
    c.close();
  }
}

module.exports = { Rcon, exec };
