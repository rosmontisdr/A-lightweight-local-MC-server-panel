'use strict';
/**
 * frps（服务端）管理接口的客户端与吞吐采样。
 * frpc 一侧没有字节统计，累计流量只在 frps 提供；速率由两次采样求差得到。
 */

const { SECRET_MASK } = require('./props');

/** frps 管理接口地址归一化：补协议、去尾部斜杠 */
function normalizeUrl(u) {
  const s = String(u == null ? '' : u).trim();
  if (!s) return '';
  const withProto = /^https?:\/\//i.test(s) ? s : 'http://' + s;
  return withProto.replace(/\/+$/, '');
}

class FrpsAdmin {
  constructor({ url, user, password } = {}) {
    this.url = normalizeUrl(url);
    this.user = user || '';
    this.password = password || '';
  }

  get configured() {
    return !!this.url;
  }

  /** 密码为掩码说明本次请求没带新密码，沿用已存的旧值 */
  get usable() {
    return this.configured && this.password !== SECRET_MASK;
  }

  _headers() {
    if (!this.user) return {};
    const raw = Buffer.from(`${this.user}:${this.password}`, 'utf8').toString('base64');
    return { Authorization: 'Basic ' + raw };
  }

  async _get(p, timeout = 5000) {
    let r;
    try {
      r = await fetch(this.url + p, { headers: this._headers(), signal: AbortSignal.timeout(timeout) });
    } catch (e) {
      const why = e && e.name === 'TimeoutError' ? '超时' : (e && e.cause && e.cause.code) || '无法连接';
      throw new Error(`连不上 frps 管理接口 ${this.url}（${why}）。该接口需在 frps 侧开启并可从本机访问`);
    }
    if (r.status === 401) throw new Error('frps 管理接口拒绝：账号或密码不对');
    if (r.status === 404) throw new Error('frps 管理接口没有这个端点，请确认填的是 dashboard 地址');
    if (!r.ok) throw new Error(`frps 管理接口返回 ${r.status}`);
    return r.json();
  }

  async serverInfo() {
    return this._get('/api/serverinfo');
  }

  /** 某一类型（tcp/udp）的全部代理条目 */
  async proxies(type) {
    const j = await this._get(`/api/proxy/${type}`);
    return Array.isArray(j && j.proxies) ? j.proxies : [];
  }

  /** 一次拿 tcp + udp，键为 frps 上的代理名 */
  async allProxies(timeout = 5000) {
    const out = new Map();
    for (const type of ['tcp', 'udp']) {
      let list = [];
      try {
        list = await this.proxies(type);
      } catch (e) {
        if (type === 'tcp') throw e;
      }
      for (const p of list) {
        if (!p || !p.name) continue;
        out.set(p.name, {
          name: p.name,
          in: Number(p.todayTrafficIn) || 0,
          out: Number(p.todayTrafficOut) || 0,
          conns: Number(p.curConns) || 0,
          status: p.status || '',
          online: p.status === 'online' || p.status === 'running',
        });
      }
    }
    return out;
  }
}

/** 两次采样求差得速率，范式与 lib/runtime.js 的 CpuTracker 一致 */
class RateTracker {
  constructor() {
    this.last = new Map();
    this.rate = new Map();
  }

  /** @returns {number|null} 每秒字节数；无基线或计数器回退时为 null */
  sample(key, cur) {
    if (!Number.isFinite(cur)) return this.rate.get(key) ?? null;
    const now = Date.now();
    const prev = this.last.get(key);
    this.last.set(key, { bytes: cur, at: now });
    if (!prev) return null;
    const dt = now - prev.at;
    const db = cur - prev.bytes;
    // 计数器归零：跨零点、代理重连重建。重新做基线，本轮不留速率
    if (dt <= 0 || db < 0) return null;
    const v = db / (dt / 1000);
    this.rate.set(key, v);
    return v;
  }

  forget(key) {
    this.last.delete(key);
    this.rate.delete(key);
  }

  reset() {
    this.last.clear();
    this.rate.clear();
  }
}

/** frps 侧代理名带 user 前缀，两种写法都登记一份 */
function indexWithPrefix(map, user) {
  const out = new Map(map);
  const pre = user ? user + '.' : '';
  if (pre) {
    for (const [name, v] of map) {
      if (name.startsWith(pre)) out.set(name.slice(pre.length), v);
    }
  }
  return out;
}

/** 可选的吞吐数据源 */
const PROVIDERS = [
  {
    id: 'frps',
    label: 'frps 管理接口',
    note: '按隧道给出真实上下行，需要 frps 的 dashboard 地址与账号密码',
  },
  {
    id: 'none',
    label: '不采集',
    note: '只在概览显示隧道在线状态，不画吞吐折线图',
  },
];

module.exports = { FrpsAdmin, RateTracker, normalizeUrl, indexWithPrefix, PROVIDERS, SECRET_MASK };
