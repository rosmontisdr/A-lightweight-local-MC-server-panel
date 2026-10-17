'use strict';
/**
 * RCON 客户端（Source RCON 协议），零依赖实现。
 * 服务器非面板启动时用它执行控制台指令。
 * 前提：server.properties 中 enable-rcon=true 且已设置 rcon.password。
 */
const net = require('net');

const TYPE = { RESPONSE: 0, COMMAND: 2, AUTH: 3, AUTH_RESPONSE: 2 };

// 单条指令的应答截止时间。
const REPLY_DEADLINE_MS = 8000;
// 接收缓冲上限，超限视为协议异常，断开连接。
const BUF_LIMIT = 2 * 1024 * 1024;

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
    if (this.buf.length > BUF_LIMIT) {
      this.buf = Buffer.alloc(0);
      this._flushPending(new Error('RCON 响应过大'));
      try { this.socket?.destroy(); } catch {}
      return;
    }
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
      if (p) { this._drop(p); p.reject(new Error('RCON 密码错误')); }
      return;
    }
    const p = this.pending.get(id);
    if (!p) return;
    // 哨兵应答到达：主指令应答已完整
    if (p.owner != null) {
      const main = this.pending.get(p.owner);
      this._drop(p);
      if (main) { this._drop(main); main.resolve(); }
      return;
    }
    // 主指令：多包聚合；带哨兵的等哨兵落地，不带的单包即完成
    p.parts.push(body);
    if (p.sentinel == null) {
      this._drop(p);
      p.resolve();
    }
  }

  _drop(p) {
    if (p.timer) clearTimeout(p.timer);
    this.pending.delete(p.id);
    if (p.sentinel != null) this.pending.delete(p.sentinel);
    if (p.owner != null) this.pending.delete(p.owner);
  }

  _flushPending(err) {
    for (const p of [...this.pending.values()]) {
      this._drop(p);
      if (p.owner != null) continue;   // 哨兵条目的错误由主条目报出
      // 已有应答照发，一条都没收到才报错
      if (p.parts.length) p.resolve();
      else p.reject(err);
    }
    this.pending.clear();
  }

  /** 登记一个待应答条目。owner 指向主条目 id 时表示本条是它的哨兵。 */
  _setPending(id, { resolve, reject, owner = null, sentinel = null }) {
    const entry = { id, owner, sentinel, resolve, reject, parts: [], timer: null };
    entry.timer = setTimeout(() => {
      // 哨兵超时：已有应答按完整处理，一条都没有才失败
      const main = owner == null ? null : this.pending.get(owner);
      this._drop(entry);
      if (owner != null) {
        if (main) {
          this._drop(main);
          if (main.parts.length) main.resolve();
          else main.reject(new Error('RCON 应答超时'));
        }
        return;
      }
      if (entry.parts.length) entry.resolve();
      else entry.reject(new Error('RCON 应答超时'));
    }, REPLY_DEADLINE_MS);
    this.pending.set(id, entry);
    return entry;
  }

  async auth() {
    if (!this.socket) await this.connect();
    const id = this.nextId++;
    this._authId = id;
    let out = '';
    await new Promise((resolve, reject) => {
      const entry = this._setPending(id, {
        resolve: () => { out = entry.parts.join(''); resolve(); },
        reject,
      });
      this.socket.write(Rcon.encode(id, TYPE.AUTH, this.password || ''));
    });
    this.authed = true;
    return out;
  }

  async send(command) {
    if (!this.authed) await this.auth();
    const id = this.nextId++;
    // 追加空指令当哨兵：长回复拆成多个同 id 包，哨兵应答到达才算完整
    const sentinelId = this.nextId++;
    return new Promise((resolve, reject) => {
      const entry = this._setPending(id, {
        resolve: () => resolve(entry.parts.join('')),
        reject,
        sentinel: sentinelId,
      });
      this._setPending(sentinelId, {
        resolve: () => {}, reject: () => {}, owner: id,
      });
      this.socket.write(Rcon.encode(id, TYPE.COMMAND, command));
      this.socket.write(Rcon.encode(sentinelId, TYPE.COMMAND, ''));
    });
  }

  close() {
    this._flushPending(new Error('RCON 连接已关闭'));
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
