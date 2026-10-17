'use strict';
/** 本地转发计数：监听口生命周期、隧道改指、自愈与退出恢复。 */
const frptoml = require('../frptoml');
const frpproc = require('../frpproc');
const { TunnelProxy } = require('../tunnelproxy');
const { sleep } = require('../util');
const { freePort, AUTO_TAP_STEP_MS, TAP_HEAL_MS, TAP_RETRY_MS, TAP_RETRY_MAX } = require('./common');

module.exports = {
  tapEntry(serverId) {
    const e = this.store.get(serverId);
    const t = e && e.frp && e.frp.tap;
    return t && t.listenPort && t.targetPort ? t : null;
  }

  /** 已启用的转发记录 */,
  tapOn(serverId) {
    const t = this.tapEntry(serverId);
    return t && t.enabled !== false ? t : null;
  }

  /** 已启用的转发口端口；没有返回 null */,
  tapPortOf(serverId) {
    const t = this.tapOn(serverId);
    return t ? t.listenPort : null;
  }

  /** 写回转发记录 */,
  saveTap(serverId, patch) {
    const frp = { ...((this.store.get(serverId) || {}).frp || {}) };
    frp.tap = { ...(frp.tap || {}), ...patch };
    this.store.update(serverId, { frp });
    return frp.tap;
  }

  /** 该服务器当前在跑的转发实例 */,
  tapFor(serverId) {
    const p = this.taps.get(serverId);
    return p && p.running ? p : null;
  }

  /** 起转发口，指向这台服务器当前监听的地址。不动 frpc，也不动被转发的服务端进程。 */,
  async startTap(serverId) {
    const s = this.manager.get(serverId);
    if (!s) throw new Error('服务器不存在');
    const targetPort = (s.status && s.status.port) || s.port || null;
    if (!targetPort) throw new Error('这台服务器没有在监听端口，先把它启动起来');

    // 端口必须复用：隧道配置里已经写成它了，换端口等于把隧道断掉
    const prev = this.tapEntry(serverId);
    const listenPort = prev ? prev.listenPort : await freePort();
    const old = this.taps.get(serverId);
    if (old) old.stop();

    const p = new TunnelProxy({ listenPort, targetHost: '127.0.0.1', targetPort });
    this.taps.set(serverId, p);
    await p.start();
    if (!p.running) {
      this.taps.delete(serverId);
      throw new Error(p.error || `监听 ${listenPort} 失败`);
    }

    // 隧道改指转发口之后，按端口认隧道就不成立了，同时把关联记死
    const { proxy } = this.associationFor(serverId);
    if (proxy) {
      const frp = { ...((this.store.get(serverId) || {}).frp || {}), proxy: proxy.name };
      this.store.update(serverId, { frp });
    }
    this.saveTap(serverId, { listenPort, targetHost: '127.0.0.1', targetPort, enabled: true });

    return {
      ...p.snapshot(),
      proxy: proxy ? proxy.name : ((this.store.get(serverId) || {}).frp || {}).proxy || null,
      tunnelLocalPort: proxy ? proxy.localPort : null,
    };
  }

  /** 停掉转发口。端口记录保留，再开启时还是同一个口。 */,
  stopTap(serverId) {
    const p = this.taps.get(serverId);
    if (p) p.stop();
    this.taps.delete(serverId);
    if (this.tapEntry(serverId)) this.saveTap(serverId, { enabled: false });
  }

  /** 把某条隧道的 localPort 改成指定值（改的是配置文件）。调用方须已持有 _lock 或单独成事务。 */,
  async setProxyLocalPort(serverId, name, localPort) {
    const proxy = this.proxies().find((p) => p.name === name);
    if (!proxy) throw new Error('隧道不存在: ' + name);
    if (proxy.localPort === localPort) return { changed: false };
    await this._updateProxy(name, {
      name: proxy.name,
      type: proxy.type || 'tcp',
      localIP: proxy.localIP || '127.0.0.1',
      localPort,
      remotePort: proxy.remotePort,
    }, serverId);
    return { changed: true };
  }

  /**
   * 重启正在跑的 frpc，让配置改动立即生效。
   * tray 模式下 writeConfig 自己就是「停→写→起」，所以只有非 tray 需要走这里。
   * 只动当前 frp 目录里的那一份：机器上别处还有 frpc 的话不能碰。
   */,
  async enableTap(serverId) {
    return this._lock(() => this._enableTap(serverId));
  }
,
  async _enableTap(serverId) {
    const { proxy } = this.associationFor(serverId);
    if (!proxy) throw new Error('这台服务器还没有关联隧道，先在下面选一条');

    const tap = await this.startTap(serverId);
    const rec = { listenPort: tap.listenPort, targetHost: '127.0.0.1', targetPort: tap.targetPort, enabled: true };
    try {
      await this.setProxyLocalPort(serverId, proxy.name, tap.listenPort);
    } catch (e) {
      // 只停实例、保留 enabled:true，交给自愈退避重试
      const p = this.taps.get(serverId);
      if (p) p.stop();
      this.taps.delete(serverId);
      throw e;
    }
    // updateProxy 改名的分支会把 frp 记录整个换掉，这里把转发记录补回去
    this.saveTap(serverId, rec);
    this.invalidate();
    return { ...tap, proxy: proxy.name, tunnelLocalPort: proxy.localPort, ...(await this.restartForTap()) };
  }

  /** 隧道配置已改完，重启 frpc 让它生效。tray 模式写配置时就重启过了。 */,
  async restartForTap() {
    if (this.trayInfo()) return { restart: { via: 'tray' } };
    try {
      return { restart: await this.restartFrpc() };
    } catch (e) {
      // 配置已经改好，重启失败不该让整件事算失败——如实回报，让用户自己处理
      return { restart: { via: 'skipped', error: e.message } };
    }
  }

  /** 关闭本地转发计数：把隧道 localPort 指回服务器端口 → 重启 frpc */,
  async disableTap(serverId) {
    return this._lock(() => this._disableTap(serverId));
  }
,
  async _disableTap(serverId) {
    const tap = this.tapEntry(serverId);
    const { proxy } = this.associationFor(serverId);
    const s = this.manager.get(serverId);
    const port = s && ((s.status && s.status.port) || s.port || null);

    this.stopTap(serverId);

    let restored = false;
    let restart = null;
    if (proxy && tap && port && proxy.localPort === tap.listenPort) {
      await this.setProxyLocalPort(serverId, proxy.name, port);
      // 同上：改名分支会覆盖记录，把「已关闭但保留端口」补回去
      this.saveTap(serverId, {
        listenPort: tap.listenPort, targetHost: tap.targetHost, targetPort: tap.targetPort, enabled: false,
      });
      restart = (await this.restartForTap()).restart;
      restored = true;
    }
    this.invalidate();
    return { ok: true, restored, localPort: restored ? port : null, restart };
  }

  /**
   * 面板关闭时：把被转发口改走的 localPort 改回服务器端口，并重启一次 frpc。
   * 转发口随面板一起停，不改回去隧道就指着没人听的口。记录保留（enabled 不动），下次启动照旧自动恢复转发。
   * 只改「localPort 正指着转发口」的那些隧道，别的隧道不碰。
   */,
  async restoreTapsOnExit() {
    return this._lock(() => this._restoreTapsOnExit());
  }
,
  async _restoreTapsOnExit() {
    // 收尾期间停掉自愈定时器
    this.stopAutoTaps();
    const restored = [];
    let changed = false;
    for (const e of this.store.list()) {
      const t = e.frp && e.frp.tap;
      if (!t || !t.listenPort || !t.targetPort || t.enabled === false) continue;
      const { proxy } = this.associationFor(e.id);
      if (!proxy || proxy.localPort !== t.listenPort) continue;
      const s = this.manager.get(e.id);
      const port = (s && ((s.status && s.status.port) || s.port)) || t.targetPort;
      try {
        await this.setProxyLocalPort(e.id, proxy.name, port);
        restored.push(`${proxy.name}: ${t.listenPort} → ${port}`);
        changed = true;
      } catch (err) {
        console.error(`[面板] 关闭时恢复 ${proxy.name} 的 localPort 失败：${err.message}`);
      }
    }
    if (!changed) return { restored };
    this.invalidate();
    const r = await this.restartForTap();
    if (r.restart && r.restart.via === 'skipped') {
      console.log('[面板] 关闭时恢复 localPort 后，frpc 没能自动重启：' + r.restart.error);
    }
    return { restored };
  }

  /** 面板启动时把已启用的转发恢复起来 */,
  startTaps() {
    for (const e of this.store.list()) {
      const t = e.frp && e.frp.tap;
      if (!t || !t.listenPort || !t.targetPort || t.enabled === false) continue;
      const p = new TunnelProxy(t);
      this.taps.set(e.id, p);
      p.start().catch(() => { });
    }
  }

  /**
   * 面板启动时把本地转发计数接上：面板记过转发记录、且记录里没被关掉的服务器，
   * 起监听口、把隧道的 localPort 指过来、重启 frpc。不等服务器起来。
   * 没记过记录的一律不碰；用户关掉的（enabled:false）保持关闭；已经接好的不动（也不重启 frpc）。
   */,
  async autoEnableTaps() {
    return this.syncTaps(false);
  }

  /** 运行期间定期自愈：隧道被改回别处时自己接回去，退避重试，次数用完为止 */,
  async healTaps() {
    return this.syncTaps(true);
  }
,
  async syncTaps(backoff) {
    for (const e of this.store.list()) {
      const rec = this.tapEntry(e.id);
      if (!rec || rec.enabled === false) continue;
      const { proxy } = this.associationFor(e.id);
      if (!proxy) continue;
      const live = this.tapFor(e.id);
      if (live && proxy.localPort === rec.listenPort) {
        this.tapFix.delete(e.id);
        continue;
      }
      if (backoff) {
        const st = this.tapFix.get(e.id) || { at: 0, fails: 0 };
        if (st.fails >= TAP_RETRY_MAX) continue;
        if (Date.now() - st.at < TAP_RETRY_MS * 2 ** st.fails) continue;
        this.tapFix.set(e.id, { at: Date.now(), fails: st.fails + 1 });
      }
      try {
        await this.enableTap(e.id);
        const s = this.manager.get(e.id);
        console.log(`[面板] 已把隧道接回本地转发口（${s ? s.name : e.id} → 127.0.0.1:${rec.listenPort}）`);
      } catch (err) {
        const s = this.manager.get(e.id);
        console.error(`[面板] 接上本地转发计数失败（${s ? s.name : e.id}）：${err.message}`);
      }
    }
  }

  /** 启动后延迟一轮再补接：此时配置与端口已就绪；之后每 TAP_HEAL_MS 自愈一轮 */,
  startAutoTaps() {
    if (this.autoTapTimer) return;
    this.autoTapTimer = setTimeout(() => {
      this.autoEnableTaps().catch(() => {});
    }, AUTO_TAP_STEP_MS);
    if (this.autoTapTimer.unref) this.autoTapTimer.unref();
    if (this.healTimer) return;
    this.healTimer = setInterval(() => {
      this.healTaps().catch(() => {});
    }, TAP_HEAL_MS);
    if (this.healTimer.unref) this.healTimer.unref();
  }
,
  stopAutoTaps() {
    if (this.autoTapTimer) { clearTimeout(this.autoTapTimer); this.autoTapTimer = null; }
    if (this.healTimer) { clearInterval(this.healTimer); this.healTimer = null; }
  }

  /** 正在跑的转发口，供退出前提示「指向它们的隧道会断」 */,
  runningTaps() {
    const out = [];
    for (const [id, p] of this.taps) {
      if (!p.running) continue;
      const s = this.manager.get(id);
      out.push({ id, name: s ? s.name : id, listenPort: p.listenPort, targetPort: p.targetPort });
    }
    return out;
  }

  /** 全部转发口的快照，供界面显示。proxy 为这台服务器当前关联的那条隧道 */,
  tapSummary(serverId, proxy) {
    const cfg = this.tapEntry(serverId);
    const live = this.tapFor(serverId);
    if (!cfg && !live) return null;
    const s = live ? live.snapshot() : null;
    return {
      enabled: !!(cfg && cfg.enabled !== false),
      running: !!(s && s.running),
      // 转发口真的在接管这条隧道：监听口在跑，且隧道的 localPort 正指着它
      onPath: !!(live && proxy && proxy.localPort === live.listenPort),
      listenPort: s ? s.listenPort : cfg.listenPort,
      targetPort: s ? s.targetPort : cfg.targetPort,
      conns: s ? s.conns : 0,
      peak: s ? s.peak : 0,
      totalConns: s ? s.totalConns : 0,
      bytesIn: s ? s.in : 0,
      bytesOut: s ? s.out : 0,
      error: s ? s.error : null,
    };
  }
,
};
