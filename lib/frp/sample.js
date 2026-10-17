'use strict';
/** 状态与吞吐采样、总览与单服务器视图。 */
const dns = require('dns');
const frptoml = require('../frptoml');
const frpproc = require('../frpproc');
const frpinstall = require('../frpinstall');
const { FrpsAdmin, indexWithPrefix, PROVIDERS } = require('../frptraffic');
const { SAMPLE_MS, SAMPLE_STUCK_MS, PROJECT_ROOT } = require('./common');

module.exports = {
  tunnelInfo(name, tunnelMap, totalsMap) {
    const t = (tunnelMap || this.cache.tunnel).get(name);
    if (t) return { ...t, conns: null, source: 'frpc' };
    const g = (totalsMap || this.cache.totals).get(name);
    if (g) {
      return {
        online: !!g.online,
        status: g.status || '',
        err: null,
        localAddr: null,
        remoteAddr: null,
        conns: g.conns ?? null,
        source: 'frps',
      };
    }
    // 最后的旁证：frpc 与 frps 的连接在不在。分不出单条隧道，但能说明链路在跑
    if (this.cache.link) {
      return {
        online: this.cache.link.up,
        status: this.cache.link.up ? 'connected' : 'disconnected',
        err: null,
        localAddr: null,
        remoteAddr: this.cache.link.peer,
        conns: null,
        source: 'conn',
      };
    }
    return null;
  }

  /**
   * frpc 进程是否已与 frps 建立连接。
   * 没有管理接口时，这是唯一能说明「隧道在跑」的旁证，且不需要改配置或重启 frpc。
   */,
  async linkState(proc, text) {
    if (!proc.running || !proc.pid) return null;
    const top = frptoml.parseTop(text);
    if (!top.serverAddr || !top.serverPort) return null;
    const peers = await frpproc.establishedPeers(proc.pid);
    let wants = [`${top.serverAddr}:${top.serverPort}`];
    if (!/^\d+\.\d+\.\d+\.\d+$/.test(top.serverAddr)) {
      // DNS 查询限 3 秒：解析器挂起时不拖住采样
      const lookup = dns.promises.lookup(top.serverAddr, { all: true }).catch(() => []);
      const addrs = await Promise.race([
        lookup,
        new Promise((r) => { const t = setTimeout(() => r([]), 3000); t.unref?.(); }),
      ]);
      wants = wants.concat(addrs.map((a) => `${a.address}:${top.serverPort}`));
    }
    return { up: wants.some((w) => peers.has(w)), peer: `${top.serverAddr}:${top.serverPort}`, at: Date.now() };
  }

  /** 当前有没有能判定隧道状态的数据源 */,
  statusSource() {
    if (this.cache.tunnel && this.cache.tunnel.size) return 'frpc';
    if (this.cache.totals && this.cache.totals.size) return 'frps';
    if (this.cache.link) return 'conn';
    return 'none';
  }

  /**
   * 该服务器对应的隧道。按 localPort 与本机监听端口对号在先（frpc.toml 为准），面板记录兜底。
   * @returns {{proxy:object|null, how:'byPort'|'explicit'|'ambiguous'|'missing'|'none', missingName?:string}}
   */,
  startSampler() {
    this.startTaps();
    this.startAutoTaps();
    if (this.timer) return;
    const tick = () => this.sample().catch(() => {});
    this.timer = setInterval(tick, SAMPLE_MS);
    if (this.timer.unref) this.timer.unref();
    tick();

    // 第一次启动（还没配 frp 目录）先扫一遍本机；连携启动等它出结果，扫出来的目录可能正是要启动的那份
    const boot = this.detectDirOnFirstRun().catch(() => null);
    if (this.getSettings().autoStart) {
      setTimeout(() => {
        if (!this.store.getSetting('frpAutoStart', false)) return;
        boot.then(() => this.ensureStarted())
          .catch((e) => console.error('[面板] frpc 自动启动失败：' + e.message));
      }, 1500);
    }
  }

  /** 还没配 frp 目录时扫一遍本机，找到就记下来。返回扫描结果或 null。 */,
  async sample() {
    // 上一轮卡住时不再永久占着 busy；代数递增让过期轮次的写入作废
    if (this.cache.busy && Date.now() - (this.cache.busyAt || 0) < SAMPLE_STUCK_MS) return;
    const gen = this._sampleGen = (this._sampleGen || 0) + 1;
    const alive = () => this._sampleGen === gen;
    this.cache.busy = true;
    this.cache.busyAt = Date.now();
    try {
      // 进程状态先落缓存，后面无论有没有配置文件，界面都读得到
      const proc = await this.processState();
      if (!alive()) return;
      this.cache.process = proc;

      // 本地转发口每轮都求一次速率，与有没有 frps 配置无关
      for (const p of this.taps.values()) p.sample();

      const { text, exists, mtimeMs } = this.readConfig();
      if (!exists) {
        this.cache = {
          ...this.cache, proxies: [], proxiesAt: Date.now(),
          tunnel: new Map(), rates: new Map(), totals: new Map(), link: null,
          adminError: null, trafficError: null, at: Date.now(),
        };
        return;
      }
      if (mtimeMs !== this.cache.tomlMtime) {
        this.cache.tomlMtime = mtimeMs;
        this.cache.proxies = frptoml.listProxies(text);
        this.cache.proxiesAt = Date.now();
        this.cache.tunnel = new Map();
        // 文件变过，连接旁证按新配置重查
        this.cache.link = null;
      }
      const names = this.cache.proxies.map((p) => p.name);

      // frpc 隧道状态
      const admin = this.adminClient();
      if (proc.running && admin && admin.enabled) {
        try {
          const tunnel = await admin.status();
          if (!alive()) return;
          this.cache.tunnel = tunnel;
          this.cache.adminError = null;
        } catch (e) {
          this.cache.adminError = e.message;
        }
      } else {
        this.cache.tunnel = new Map();
        this.cache.adminError = proc.running ? null : 'frpc 未运行';
      }

      // frps 流量
      const frps = this.frpsClient();
      if (!frps) {
        this.cache.trafficError = '未配置 frps 管理接口';
        this.rate.reset();
        this.cache.rates = new Map();
        this.cache.totals = new Map();
      } else {
        try {
          const raw = await frps.allProxies();
          if (!alive()) return;
          const user = frptoml.parseTop(text).user;
          const idx = indexWithPrefix(raw, user);
          const rates = new Map();
          const totals = new Map();
          for (const n of names) {
            const v = idx.get(n);
            if (!v) continue;
            totals.set(n, { in: v.in, out: v.out, conns: v.conns, online: v.online });
            rates.set(n, {
              in: this.rate.sample(n + ':in', v.in),
              out: this.rate.sample(n + ':out', v.out),
            });
          }
          this.cache.rates = rates;
          this.cache.totals = totals;
          this.cache.trafficError = null;
        } catch (e) {
          this.cache.trafficError = e.message;
        }
      }

      // 没有逐条状态来源时，才退一步看 frpc 与 frps 的连接；结果 5 秒内不重复查
      const hasDetail = this.cache.tunnel.size > 0 || this.cache.totals.size > 0;
      if (hasDetail) {
        this.cache.link = null;
      } else if (!this.cache.link || Date.now() - this.cache.link.at > 5000) {
        const link = await this.linkState(proc, text);
        if (!alive()) return;
        this.cache.link = link;
      }

      this.cache.at = Date.now();
    } finally {
      if (alive()) this.cache.busy = false;
    }
  }

  /** 供 McServer 的 status 同步调用 */,
  statusFor(serverId) {
    const info = this.dirInfo();
    const running = !!(this.cache.process && this.cache.process.running);
    const base = {
      installed: info.installed,
      version: info.version,
      running,
      statusSource: this.statusSource(),
      adminEnabled: !!this.adminConfig(),
    };
    const { proxy, how } = this.associationFor(serverId);
    if (!proxy) {
      return { ...base, attached: false, attachHow: how === 'ambiguous' ? 'ambiguous' : 'none', proxy: null, online: false, statusKnown: false };
    }
    const t = this.tunnelInfo(proxy.name);
    const r = this.cache.rates.get(proxy.name) || null;
    const tot = this.cache.totals.get(proxy.name) || null;
    const tap = this.tapFor(serverId);
    const out = {
      ...base,
      attached: true,
      attachHow: how,
      proxy: proxy.name,
      online: !!(t && t.online),
      statusKnown: !!t,
      err: t ? t.err : null,
      localAddr: t ? t.localAddr : null,
      remoteAddr: t ? t.remoteAddr : null,
      rateIn: r ? r.in : null,
      rateOut: r ? r.out : null,
      totalIn: tot ? tot.in : null,
      totalOut: tot ? tot.out : null,
      conns: tot ? tot.conns : null,
      trafficError: this.cache.trafficError,
      trafficAt: this.cache.at || null,
    };
    // 转发口接管着这条隧道才用它的实时字节（比 frps 那份准确也及时）
    if (tap && proxy.localPort === tap.listenPort) {
      const s = tap.snapshot();
      out.rateIn = s.rateIn;
      out.rateOut = s.rateOut;
      out.totalIn = s.in;
      out.totalOut = s.out;
      out.conns = s.conns;
      out.trafficError = null;
    }
    // 没开也带上，概览页据此决定要不要给引导
    out.tap = this.tapSummary(serverId, proxy);
    return out;
  }

  /** GET /api/frp 的响应体 */,
  async overview() {
    const dir = this.resolveDir();
    const info = this.dirInfo();
    const st = this.getSettings();
    // 用采样器两秒一次的结果；没有才现查（现查要走一次 PowerShell 进程枚举）
    const proc = this.cache.process || await this.processState();
    const admin = this.adminConfig();
    const { text, exists } = this.readConfig();
    const top = exists ? frptoml.parseTop(text) : { includes: [] };

    // 与 associationFor() 同口径：先按 localPort 与本机监听端口对上，其次才用显式记录。
    // 只读显式记录会让「全部隧道」那一列与各服务器的 FRP 页自相矛盾。
    const assoc = new Map();
    for (const s of this.manager.list()) {
      const { proxy, how } = this.associationFor(s.id);
      if (proxy && (how === 'explicit' || how === 'byPort')) assoc.set(proxy.name, { serverId: s.id, how });
    }

    return {
      dir,
      dirFromSetting: !!st.dir,
      projectRoot: PROJECT_ROOT,
      installed: info.installed,
      // tray：目录里是 frpc-tray，配置在它 exe 尾部、启停由它自己管
      mode: info.kind || 'frpc',
      exePath: info.exePath,
      version: info.version,
      configPath: info.configPath,
      process: proc,
      autoStart: st.autoStart,
      // 隧道状态从哪来：frpc 管理接口 / frps dashboard / frpc 与 frps 的连接 / 都没有
      statusSource: this.statusSource(),
      link: this.cache.link ? { up: this.cache.link.up, peer: this.cache.link.peer } : null,
      admin: {
        enabled: !!admin,
        port: admin ? admin.port : null,
        managed: !!(admin && admin.managed),
        source: admin ? admin.source : null,
        error: this.cache.adminError,
      },
      toml: {
        path: info.configPath,
        exists,
        includes: top.includes,
        top: {
          serverAddr: top.serverAddr,
          serverPort: top.serverPort,
          hasToken: !!top.token,
        },
        proxies: this.proxies().map((p) => {
          const t = this.tunnelInfo(p.name);
          const r = this.cache.rates.get(p.name) || null;
          const a = assoc.get(p.name) || null;
          return {
            ...p,
            serverId: a ? a.serverId : null,
            attachHow: a ? a.how : null,
            online: !!(t && t.online),
            statusKnown: !!t,
            statusSource: t ? t.source : null,
            err: t ? t.err : null,
            localAddr: t ? t.localAddr : null,
            remoteAddr: t ? t.remoteAddr : null,
            conns: t ? t.conns : null,
            rateIn: r ? r.in : null,
            rateOut: r ? r.out : null,
          };
        }),
      },
      settings: this.settingsSummary(),
      traffic: {
        provider: this.frpsUrl() ? 'frps' : 'none',
        providers: PROVIDERS,
        frps: {
          host: st.frpsHost,
          port: st.frpsPort,
          user: st.frpsUser,
          hasPassword: !!st.frpsPassword,
        },
        error: this.frpsUrl() ? this.cache.trafficError : '未配置 frps 管理接口，看不到隧道吞吐',
      },
      download: {
        mirror: st.mirror,
        version: st.version,
        job: frpinstall.getJob(),
      },
    };
  }

  /** GET /api/servers/:id/frp 的响应体 */,
  async serverFrp(serverId) {
    const s = this.manager.get(serverId);
    if (!s) throw new Error('服务器不存在');
    const info = this.dirInfo();
    const all = this.proxies();
    const { byServer } = this.mapping();
    const { proxy, how, missingName } = this.associationFor(serverId);
    const port = (s.status && s.status.port) || s.port || null;
    const source = this.statusSource();

    return {
      installed: info.installed,
      version: info.version,
      frpDir: this.resolveDir(),
      mode: info.kind || 'frpc',
      attached: !!proxy,
      attachHow: how,
      missingName: missingName || null,
      proxyName: proxy ? proxy.name : null,
      proxy,
      proxies: all,
      mapping: Object.fromEntries(byServer),
      suggestions: this.suggestions(serverId),
      serverPort: port,
      // 隧道指向本地转发口时，localPort 本来就不等于服务器端口，不算陈旧
      stale: proxy && port && proxy.localPort !== port && proxy.localPort !== this.tapPortOf(serverId)
        ? { localPort: proxy.localPort, serverPort: port } : null,
      tunnel: proxy ? this.tunnelInfo(proxy.name) : null,
      statusSource: source,
      link: this.cache.link ? { up: this.cache.link.up, peer: this.cache.link.peer } : null,
      admin: { enabled: !!this.adminConfig() },
      traffic: proxy ? {
        rateIn: (this.cache.rates.get(proxy.name) || {}).in ?? null,
        rateOut: (this.cache.rates.get(proxy.name) || {}).out ?? null,
        error: this.cache.trafficError,
      } : null,
      tap: this.tapSummary(serverId, proxy),
    };
  }
};
