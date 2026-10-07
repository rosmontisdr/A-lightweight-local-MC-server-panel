'use strict';
/**
 * 本地转发计数：面板在 listenPort 上监听，把流量转给真正的服务端端口，两个方向各记一份字节。
 * frps 的按隧道字节只在连接关闭时结算，长连接期间读不到；这条转发让面板自己能实时计数。
 * 只监听本机回环，不对外。
 */
const net = require('net');
const { RateTracker } = require('./frptraffic');

class TunnelProxy {
  constructor({ listenPort, targetHost = '127.0.0.1', targetPort } = {}) {
    this.listenPort = listenPort;
    this.targetHost = targetHost;
    this.targetPort = targetPort;
    this.server = null;
    this.in = 0;      // 上行：客户端 → 服务端
    this.out = 0;     // 下行：服务端 → 客户端
    this.conns = 0;
    this.peak = 0;
    this.totalConns = 0;
    this.startedAt = null;
    this.error = null;
    this.rate = new RateTracker();
    this.last = { in: null, out: null };
  }

  get running() {
    return !!this.server;
  }

  /** 起监听；listen 之后 resolve。端口被占或其它错误记在 error 上，不抛。 */
  start() {
    if (this.server) return Promise.resolve(this);
    this.error = null;
    this.rate.reset();
    this.last = { in: null, out: null };
    return new Promise((resolve) => {
      // allowHalfOpen：一侧半关闭不能把另一侧也关掉
      const s = net.createServer({ allowHalfOpen: true }, (c) => this._onConn(c));
      const fail = (e) => {
        this.error = e && e.code === 'EADDRINUSE'
          ? `端口 ${this.listenPort} 已被占用`
          : ((e && e.message) || String(e));
        this.server = null;
        resolve(this);
      };
      s.once('error', fail);
      s.listen(this.listenPort, '127.0.0.1', () => {
        s.removeListener('error', fail);
        s.on('error', (e) => { this.error = (e && e.message) || String(e); });
        this.startedAt = Date.now();
        this.server = s;
        resolve(this);
      });
    });
  }

  stop() {
    const s = this.server;
    this.server = null;
    this.startedAt = null;
    if (s) { try { s.close(); } catch { } }
  }

  _onConn(client) {
    // 两侧都 allowHalfOpen：一个方向结束只 end 对端，另一方向继续通。
    // 否则客户端发完请求就关写方向时，服务端随后发出的响应会被整条丢掉。
    const target = net.connect({ host: this.targetHost, port: this.targetPort, allowHalfOpen: true });
    this.conns++;
    this.totalConns++;
    if (this.conns > this.peak) this.peak = this.conns;

    client.setNoDelay(true);
    target.setNoDelay(true);
    client.on('data', (b) => { this.in += b.length; });
    target.on('data', (b) => { this.out += b.length; });

    // 只有出错才立刻拆两边；正常收尾交给 pipe 传播 end
    const kill = () => { client.destroy(); target.destroy(); };
    client.on('error', kill);
    target.on('error', kill);

    let closed = 0;
    const one = () => { if (++closed >= 2) { this.conns = Math.max(0, this.conns - 1); } };
    client.on('close', one);
    target.on('close', one);

    client.pipe(target);
    target.pipe(client);
  }

  /** 由采样器每 2 秒调一次，把累计字节求成速率 */
  sample() {
    this.last = {
      in: this.rate.sample('tap:in', this.in),
      out: this.rate.sample('tap:out', this.out),
    };
    return this.last;
  }

  snapshot() {
    return {
      running: this.running,
      listenPort: this.listenPort,
      targetHost: this.targetHost,
      targetPort: this.targetPort,
      conns: this.conns,
      peak: this.peak,
      totalConns: this.totalConns,
      in: this.in,
      out: this.out,
      rateIn: this.last.in,
      rateOut: this.last.out,
      startedAt: this.startedAt,
      error: this.error,
    };
  }
}

module.exports = { TunnelProxy };
