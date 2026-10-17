'use strict';
/** 隧道条目的增删改事务与关联推断。 */
const fs = require('fs');
const path = require('path');
const frptoml = require('../frptoml');
const frpinstall = require('../frpinstall');
const { tunnelSlug, PROJECT_ROOT } = require('./common');

module.exports = {
  invalidate() {
    this.cache.proxiesAt = 0;
    this.cache.adminAt = 0;
    this.cache.tomlMtime = 0;
    // 配置可能改了 serverAddr，连接旁证随即作废
    this.cache.link = null;
    this.cache.at = 0;
  }

  /** frp 目录的探测结果，5 秒内复用（detect 会递归扫目录） */,
  dirInfo() {
    if (this.cache.dirAt && Date.now() - this.cache.dirAt < 5000) return this.cache.dirInfo;
    this.cache.dirInfo = frpinstall.detect(this.resolveDir());
    this.cache.dirAt = Date.now();
    return this.cache.dirInfo;
  }

  /** 隧道列表，2 秒内复用（采样器同频刷新，状态每秒读盘没必要） */,
  proxies() {
    if (this.cache.proxiesAt && Date.now() - this.cache.proxiesAt < 2000) return this.cache.proxies;
    const { text, exists } = this.readConfig();
    this.cache.proxies = exists ? frptoml.listProxies(text) : [];
    this.cache.proxiesAt = Date.now();
    return this.cache.proxies;
  }

  /** 面板记录里 <proxy 名> ↔ <服务器 id> 的映射 */,
  mapping() {
    const byProxy = new Map();
    const byServer = new Map();
    for (const e of this.store.list()) {
      if (e.frp && e.frp.proxy) {
        byProxy.set(e.frp.proxy, e.id);
        byServer.set(e.id, e.frp.proxy);
      }
    }
    return { byProxy, byServer };
  }
,
  associationFor(serverId) {
    const { byServer } = this.mapping();
    const proxies = this.proxies();
    const explicit = byServer.get(serverId) || null;

    // 以 frpc.toml 为准：localPort 与本机监听端口对得上的那条优先，面板记录只作兜底。
    // 转发口会把 localPort 改走，那时对不上，自然落到记录那条。
    const s = this.manager.get(serverId);
    const port = s && ((s.status && s.status.port) || s.port || null);
    const taken = new Set();
    for (const [id, name] of byServer) {
      if (id !== serverId) taken.add(name);   // 别的服务器已认领的不抢
    }
    const hits = port ? proxies.filter((x) => x.localPort === port && !taken.has(x.name)) : [];
    if (hits.length === 1) return { proxy: hits[0], how: 'byPort' };

    if (explicit) {
      const p = proxies.find((x) => x.name === explicit) || null;
      if (p) return { proxy: p, how: 'explicit' };
      return { proxy: null, how: 'missing', missingName: explicit };
    }

    return { proxy: null, how: hits.length ? 'ambiguous' : 'none' };
  }

  /** 只改「服务器 ↔ 隧道」的记录，不动 frpc.toml */,
  attach(serverId, name) {
    if (!this.manager.get(serverId)) throw new Error('服务器不存在');
    if (name == null || name === '') {
      this.store.update(serverId, { frp: null });
      this.invalidate();
      return { attached: false };
    }
    const p = this.proxies().find((x) => x.name === name);
    if (!p) throw new Error('隧道不存在: ' + name);
    this.store.update(serverId, { frp: { proxy: name } });
    this.invalidate();
    return { attached: true, proxy: name };
  }
,
  async createProxy(fields, serverId = null) {
    return this._lock(() => this._createProxy(fields, serverId));
  }
,
  async _createProxy(fields, serverId = null) {
    const file = this.configPath();
    const { text, exists } = this.readConfig();
    if (!exists) throw new Error('这个目录里没有 frpc.toml');
    const existing = frptoml.listProxies(text).map((p) => p.name);
    const ok = frptoml.validateProxy(fields, { existing });
    const { text: next } = frptoml.addProxy(text, ok);
    await this.writeConfig(next, existing.length + 1);
    if (serverId) this.store.update(serverId, { frp: { proxy: ok.name } });
    this.invalidate();
    this.reload().catch(() => {});
    return ok;
  }
,
  async updateProxy(name, patch, serverId = null) {
    return this._lock(() => this._updateProxy(name, patch, serverId));
  }
,
  async _updateProxy(name, patch, serverId = null) {
    const file = this.configPath();
    const { text, exists } = this.readConfig();
    if (!exists) throw new Error('这个目录里没有 frpc.toml');
    const cur = frptoml.findProxy(text, name);
    if (!cur) throw new Error('隧道不存在: ' + name);

    const merged = {
      name: patch.name != null ? patch.name : cur.name,
      type: patch.type != null ? patch.type : cur.type,
      localIP: patch.localIP != null ? patch.localIP : cur.localIP,
      localPort: patch.localPort != null ? patch.localPort : cur.localPort,
      remotePort: patch.remotePort != null ? patch.remotePort : cur.remotePort,
    };
    const others = frptoml.listProxies(text).filter((p) => p.name !== name).map((p) => p.name);
    const ok = frptoml.validateProxy(merged, { existing: others });

    const { text: renamed } = ok.name !== name
      ? frptoml.setProxyFields(text, name, { name: ok.name })
      : { text };
    const { text: next, changed } = frptoml.setProxyFields(renamed, ok.name, {
      type: ok.type, localIP: ok.localIP, localPort: ok.localPort, remotePort: ok.remotePort,
    });
    await this.writeConfig(next, others.length + 1);

    if (ok.name !== name) {
      const { byProxy } = this.mapping();
      const id = serverId || byProxy.get(name);
      if (id) this.store.update(id, { frp: { proxy: ok.name } });
      // 改名的旧速率基线作废
      this.rate.forget(name + ':in');
      this.rate.forget(name + ':out');
    }
    this.invalidate();
    this.reload().catch(() => {});
    return { proxy: ok, changed, renamed: ok.name !== name };
  }
,
  async removeProxy(name) {
    return this._lock(() => this._removeProxy(name));
  }
,
  async _removeProxy(name) {
    const file = this.configPath();
    const { text, exists } = this.readConfig();
    if (!exists) throw new Error('这个目录里没有 frpc.toml');
    const before = frptoml.listProxies(text).length;
    const { text: next, removed } = frptoml.removeProxy(text, name);
    if (!removed) throw new Error('隧道不存在: ' + name);
    await this.writeConfig(next, before - 1);
    // 删掉的隧道不再留速率基线
    this.rate.forget(name + ':in');
    this.rate.forget(name + ':out');

    const { byProxy } = this.mapping();
    const id = byProxy.get(name);
    if (id) this.store.update(id, { frp: null });
    this.invalidate();
    this.reload().catch(() => {});
    return { removed: true };
  }

  /** 该服务器的默认隧道参数 */,
  suggestions(serverId) {
    const s = this.manager.get(serverId);
    if (!s) throw new Error('服务器不存在');
    const port = (s.status && s.status.port) || s.port || 25565;
    let ip = '127.0.0.1';
    try {
      const raw = String(s.prop('server-ip', '0.0.0.0'));
      if (raw && raw !== '0.0.0.0' && raw !== '::') ip = raw;
    } catch { /* 失败可忽略 */ }
    const taken = new Set(this.proxies().map((p) => p.name));
    let base = tunnelSlug(s.name);
    if (!/[A-Za-z0-9]/.test(base)) base = tunnelSlug(path.basename(s.dir));
    if (!/[A-Za-z0-9]/.test(base)) base = 'mc';
    let name = base;
    for (let i = 2; taken.has(name) && i < 100; i++) name = `${base}-${i}`;
    return { name, type: 'tcp', localIP: ip, localPort: port, remotePort: port };
  }

  /* ─────────────────────────── 采样 ─────────────────────────── */
};
