'use strict';
/**
 * FRP 管理门面：设置读写、隧道条目的增删改事务、frpc 进程托管、状态与吞吐采样。
 * 对外的 statusFor() 是同步的，只读缓存，绝不在调用方（1 秒 ticker）里等 IO。
 */
const fs = require('fs');
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const dns = require('dns');
const { sleep } = require('./util');

const frptoml = require('./frptoml');
const frpproc = require('./frpproc');
const frpinstall = require('./frpinstall');
const frptray = require('./frptray');
const { FrpsAdmin, RateTracker, indexWithPrefix, PROVIDERS } = require('./frptraffic');
const { SECRET_MASK } = require('./props');

const SAMPLE_MS = 2000;
const PROJECT_ROOT = path.join(__dirname, '..');

/** 由服务器名推隧道名：只留传上去不会出问题的字符，压掉重复横杠 */
function tunnelSlug(raw) {
  return String(raw == null ? '' : raw)
    .replace(/[^A-Za-z0-9_.-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 40);
}

/** 取一个本机空闲端口 */
function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

class Frp {
  constructor(store, manager) {
    this.store = store;
    this.manager = manager;
    this.rate = new RateTracker();
    this.cache = {
      at: 0,
      tomlMtime: 0,
      proxies: [],
      tunnel: new Map(),
      rates: new Map(),
      totals: new Map(),
      link: null,
      trafficError: null,
      adminError: null,
      busy: false,
    };
    this.timer = null;
  }

  /* ─────────────────────────── 设置 ─────────────────────────── */

  getSettings() {
    const admin = this.store.getSetting('frpAdmin', null) || null;
    return {
      dir: this.store.getSetting('frpDir', '') || '',
      autoStart: !!this.store.getSetting('frpAutoStart', false),
      mirror: this.store.getSetting('frpMirror', '') || '',
      version: this.store.getSetting('frpVersion', '') || '',
      // 默认取标了「更推荐」的那个源；用户选过之后就以选过的为准
      source: this.store.getSetting('frpSource', 'lazy') || 'lazy',
      frpsHost: this.store.getSetting('frpsHost', '') || '',
      frpsPort: this.store.getSetting('frpsPort', '') || '',
      frpsUser: this.store.getSetting('frpsUser', '') || '',
      frpsPassword: this.store.getSetting('frpsPassword', '') || '',
      adminPort: admin ? admin.port : null,
      hasAdminPassword: !!(admin && admin.password),
    };
  }

  /** 面板管理的 frp 目录；未设置时用项目根目录 */
  resolveDir() {
    return this.getSettings().dir || PROJECT_ROOT;
  }

  patchSettings(body) {
    const s = this.store;
    if ('dir' in body) {
      const d = String(body.dir == null ? '' : body.dir).trim();
      if (!d) s.setSetting('frpDir', '');
      else {
        const abs = path.resolve(d);
        if (!fs.existsSync(abs)) throw new Error('frp 目录不存在: ' + abs);
        if (!fs.statSync(abs).isDirectory()) throw new Error('不是目录: ' + abs);
        s.setSetting('frpDir', abs);
      }
    }
    if ('autoStart' in body) s.setSetting('frpAutoStart', !!body.autoStart);
    if ('mirror' in body) s.setSetting('frpMirror', String(body.mirror == null ? '' : body.mirror).trim());
    if ('version' in body) s.setSetting('frpVersion', String(body.version == null ? '' : body.version).trim().replace(/^v/, ''));
    if ('source' in body) s.setSetting('frpSource', body.source === 'lazy' ? 'lazy' : 'official');
    if ('frpsHost' in body) s.setSetting('frpsHost', String(body.frpsHost == null ? '' : body.frpsHost).trim());
    if ('frpsPort' in body) {
      const raw = String(body.frpsPort == null ? '' : body.frpsPort).trim();
      if (!raw) s.setSetting('frpsPort', '');
      else {
        const p = Number(raw);
        if (!Number.isInteger(p) || p < 1 || p > 65535) throw new Error('dashboard 端口须为 1-65535 的整数');
        s.setSetting('frpsPort', String(p));
      }
    }
    if ('frpsUser' in body) s.setSetting('frpsUser', String(body.frpsUser == null ? '' : body.frpsUser).trim());
    if ('frpsPassword' in body && body.frpsPassword !== SECRET_MASK) {
      s.setSetting('frpsPassword', String(body.frpsPassword == null ? '' : body.frpsPassword));
    }
    // 目录或来源可能变了，缓存作废
    this.cache.dirAt = 0;
    this.cache.proxiesAt = 0;
    this.invalidate();
    return this.getSettings();
  }

  /** 给 frpc.toml 补上 [webServer] 段（已存在则原样保留），供面板读逐条隧道状态 */
  async enableAdmin() {
    const file = this.configPath();
    if (!fs.existsSync(file)) throw new Error('这个目录里没有 frpc.toml');
    const r = await this.ensureAdmin();
    this.invalidate();
    if (!r) throw new Error('这个目录里没有 frpc.toml');
    return {
      created: !!r.created,
      port: r.port,
      message: r.created
        ? '已把 [webServer] 段写入 frpc.toml，重启 frpc 后生效'
        : '配置里已有 [webServer] 段，直接用它',
    };
  }

  /* ─────────────────────────── 配置读写 ─────────────────────────── */

  /** frp 目录里如果是 frpc-tray，就用它当运行器；配置改到它 exe 尾部 */
  trayInfo() {
    const dir = this.resolveDir();
    if (!frptray.present(dir)) return null;
    const exe = frptray.exePath(dir);
    return { dir, exe, hasConfig: frptray.hasConfig(exe) };
  }

  configPath() {
    const t = this.trayInfo();
    if (t) return t.exe;
    const d = this.dirInfo();
    return d.configPath || path.join(this.resolveDir(), 'frpc.toml');
  }

  readConfig() {
    const t = this.trayInfo();
    if (t) {
      const text = frptray.readConfig(t.exe);
      let mtimeMs = 0;
      try { mtimeMs = fs.statSync(t.exe).mtimeMs; } catch {}
      // frpc-tray 模式下 exe 本身就是配置容器，没有配置块时也视为「存在但为空」
      return { text: text == null ? '' : text, exists: true, mtimeMs };
    }
    return frptoml.read(this.configPath());
  }

  /**
   * 写回配置。frpc-tray 模式下写它 exe 尾部，并按用户要求「改完重启它」——
   * 它还在跑时 exe 被锁着写不进去，所以先让它收工、写完再拉起来。
   */
  async writeConfig(text, expectProxies) {
    const t = this.trayInfo();
    if (!t) return frptoml.writeAtomic(this.configPath(), text, expectProxies);

    const st = await frptray.state(t.exe);
    if (st.running) await frptray.stop(t.exe);
    let out;
    try {
      out = frptray.writeConfig(t.exe, text, expectProxies);
    } finally {
      if (st.running) {
        try { frptray.start(t.exe, t.dir); } catch {}
      }
    }
    this.invalidate();
    return out;
  }

  /**
   * 供界面回填的一份快照，随 /api/state 下发。
   * 有了它，「高级设置」与「FRP 设置」弹窗不必再发请求——手机经隧道访问时，
   * 那一次往返就是 200ms 级的卡顿。
   */
  settingsSummary() {
    const s = this.getSettings();
    const top = this.configTop();
    return {
      dir: this.resolveDir(),
      dirFromSetting: !!s.dir,
      mirror: s.mirror,
      version: s.version,
      source: s.source,
      sources: Object.values(frpinstall.SOURCES).map((x) => ({
        id: x.id, label: x.label, note: x.note, recommend: !!x.recommend,
      })),
      host: s.frpsHost,
      port: s.frpsPort,
      user: s.frpsUser,
      hasPassword: !!s.frpsPassword,
      serverAddr: top.serverAddr,
      serverPort: top.serverPort,
      hasToken: top.hasToken,
      hasToml: !!top.exists,
    };
  }

  /** 面板管理的 [webServer]：已存在则复用，不存在则在启动时创建并记住 */
  async ensureAdmin() {
    const file = this.configPath();
    const { text, exists } = this.readConfig();
    if (!exists) return null;
    const cur = frptoml.readWebServer(text);
    if (cur && cur.port) return { port: cur.port, user: cur.user, password: cur.password, created: false };

    let admin = this.store.getSetting('frpAdmin', null);
    if (!admin || !admin.port) {
      admin = {
        port: await freePort(),
        user: 'mcpanel',
        password: crypto.randomBytes(16).toString('hex'),
      };
    }
    const { text: next, created } = frptoml.ensureWebServer(text, admin);
    await this.writeConfig(next, frptoml.listProxies(next).length);
    this.store.setSetting('frpAdmin', admin);
    return { ...admin, created };
  }

  adminClient() {
    const admin = this.store.getSetting('frpAdmin', null);
    if (!admin || !admin.port) return null;
    return new frpproc.FrpcAdmin(admin);
  }

  /** dashboard 地址与端口拼成完整 URL */
  frpsUrl() {
    const st = this.getSettings();
    if (!st.frpsHost) return '';
    const proto = /^https?:\/\//i.test(st.frpsHost) ? '' : 'http://';
    const host = st.frpsHost.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
    return proto + host + (st.frpsPort ? ':' + st.frpsPort : '');
  }

  frpsClient() {
    const url = this.frpsUrl();
    if (!url) return null;
    const st = this.getSettings();
    return new FrpsAdmin({ url, user: st.frpsUser, password: st.frpsPassword });
  }

  /** frpc.toml 顶层的连接设置，token 只回报有无 */
  configTop() {
    const { text, exists } = this.readConfig();
    if (!exists) return { exists: false, serverAddr: '', serverPort: null, hasToken: false };
    const t = frptoml.parseTop(text);
    return { exists: true, serverAddr: t.serverAddr, serverPort: t.serverPort, hasToken: !!t.token };
  }

  /** 改写 frpc.toml 顶层的 serverAddr / serverPort / auth.token */
  async writeTop(patch) {
    const file = this.configPath();
    const { text, exists } = this.readConfig();
    if (!exists) throw new Error('这个目录里没有 frpc.toml');

    const clean = {};
    if (patch.serverAddr != null) {
      const v = String(patch.serverAddr).trim();
      if (!v) throw new Error('服务器地址不能为空');
      if (!/^[A-Za-z0-9_.:-]{1,200}$/.test(v)) throw new Error('服务器地址含有非法字符');
      clean.serverAddr = v;
    }
    if (patch.serverPort != null) {
      const p = Number(patch.serverPort);
      if (!Number.isInteger(p) || p < 1 || p > 65535) throw new Error('服务端口须为 1-65535 的整数');
      clean.serverPort = p;
    }
    // 掩码表示没改，跳过
    if (patch.token != null && patch.token !== SECRET_MASK) {
      const t = String(patch.token);
      if (/[\r\n]/.test(t)) throw new Error('token 不能换行');
      clean['auth.token'] = t;
    }

    const { text: next, changed } = frptoml.setTopFields(text, clean);
    await this.writeConfig(next, frptoml.listProxies(next).length);
    this.invalidate();
    return { changed };
  }

  /* ─────────────────────────── 进程 ─────────────────────────── */

  async processState(fresh = false) {
    // frpc-tray 模式下「在不在跑」看它自己的实例，frpc 是它拉起来的子进程
    const t = this.trayInfo();
    if (t) {
      const st = await frptray.state(t.exe);
      return {
        running: st.running, pid: st.pid, startedAt: st.startedAt,
        how: st.running ? 'tray' : null, exePath: t.exe, tray: true,
      };
    }

    const rec = this.store.getSetting('frpLaunched', null);
    const { proc, how } = await frpproc.resolve(rec, fresh).catch(() => ({ proc: null, how: null }));
    if (!proc) {
      if (rec) this.store.setSetting('frpLaunched', null);
      return { running: false, pid: null, startedAt: null, how: null, exePath: null };
    }
    // 不是面板认领的那份：清掉过时的认领记录。只在确实有记录时才写盘，避免每次采样都落盘。
    if (rec && how !== 'claimed') this.store.setSetting('frpLaunched', null);
    return { running: true, pid: proc.pid, startedAt: proc.start || null, how, exePath: proc.exe || null };
  }

  /**
   * 某条隧道的状态。
   * 来源按可靠度排：frpc 管理接口（逐条、最准）> frps dashboard（逐条）> 无。
   * @returns {{online:boolean, status:string, err:string|null, source:string, conns:number|null}|null}
   */
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
   */
  async linkState(proc, text) {
    if (!proc.running || !proc.pid) return null;
    const top = frptoml.parseTop(text);
    if (!top.serverAddr || !top.serverPort) return null;
    const peers = await frpproc.establishedPeers(proc.pid);
    let wants = [`${top.serverAddr}:${top.serverPort}`];
    if (!/^\d+\.\d+\.\d+\.\d+$/.test(top.serverAddr)) {
      const addrs = await dns.promises.lookup(top.serverAddr, { all: true }).catch(() => []);
      wants = wants.concat(addrs.map((a) => `${a.address}:${top.serverPort}`));
    }
    return { up: wants.some((w) => peers.has(w)), peer: `${top.serverAddr}:${top.serverPort}`, at: Date.now() };
  }

  /** 当前有没有能判定隧道状态的数据源 */
  statusSource() {
    if (this.cache.tunnel && this.cache.tunnel.size) return 'frpc';
    if (this.cache.totals && this.cache.totals.size) return 'frps';
    if (this.cache.link) return 'conn';
    return 'none';
  }

  /**
   * 该服务器对应的隧道。
   * 面板记录优先；手建的隧道没有记录，按 localPort 与本机监听端口匹配推断。
   * @returns {{proxy:object|null, how:'explicit'|'byPort'|'ambiguous'|'missing'|'none', missingName?:string}}
   */
  associationFor(serverId) {
    const { byServer } = this.mapping();
    const proxies = this.proxies();
    const explicit = byServer.get(serverId) || null;
    if (explicit) {
      const p = proxies.find((x) => x.name === explicit) || null;
      if (p) return { proxy: p, how: 'explicit' };
      return { proxy: null, how: 'missing', missingName: explicit };
    }

    const s = this.manager.get(serverId);
    const port = s && ((s.status && s.status.port) || s.port || null);
    if (!port) return { proxy: null, how: 'none' };
    const taken = new Set([...byServer.values()]);
    const hits = proxies.filter((x) => x.localPort === port && !taken.has(x.name));
    if (hits.length === 1) return { proxy: hits[0], how: 'byPort' };
    return { proxy: null, how: hits.length ? 'ambiguous' : 'none' };
  }

  /** 只改「服务器 ↔ 隧道」的记录，不动 frpc.toml */
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

  async start() {
    const dir = this.resolveDir();
    const info = frpinstall.detect(dir);
    if (!info.installed) throw new Error('这个目录里没有 frpc，请先选择 frp 目录或一键下载');
    if (!info.exePath) throw new Error('找不到 frpc.exe');

    const tray = this.trayInfo();
    if (tray) {
      const cur = await this.processState(true);
      if (cur.running) throw new Error(`frpc-tray 已经在运行（PID ${cur.pid}），不用重复启动`);
      // 别的 frpc 也在跑的话不能起，同配置会在服务端撞同名隧道
      const other = await frpproc.resolve(null, true).catch(() => ({ proc: null }));
      if (other.proc) {
        throw new Error(`检测到另一个 frpc 在运行（PID ${other.proc.pid}）。请先停止它，再交由面板启动`);
      }
      // 管理接口写进它内嵌配置，随这次启动一起生效
      await this.ensureAdmin();
      frptray.start(tray.exe, tray.dir);
      for (let i = 0; i < 40; i++) {
        await sleep(300);
        if ((await frptray.state(tray.exe)).running) { this.invalidate(); return { via: 'tray', pid: (await frptray.state(tray.exe)).pid }; }
      }
      throw new Error('frpc-tray 启动后没有常驻，请手动双击它看提示');
    }

    const cur = await this.processState(true);
    if (cur.running) {
      throw new Error(`检测到已在运行的 frpc（PID ${cur.pid}）。请先停止它，再交由面板启动`);
    }

    await this.ensureAdmin();
    const file = this.configPath();
    if (!fs.existsSync(file)) throw new Error('这个目录里没有 frpc.toml');

    const lines = [];
    const child = frpproc.spawnFrpc(info.exePath, file, {
      onLine: (tag, line) => {
        lines.push(line);
        if (lines.length > 40) lines.shift();
        process.stdout.write(`[frpc] ${line}\n`);
      },
    });

    const admin = this.adminClient();
    let ready = false;
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 300));
      if (!frpproc.alive(child.pid)) break;
      if (admin && admin.enabled && (await admin.probe())) { ready = true; break; }
      if (!admin) { ready = true; break; }
    }

    if (!frpproc.alive(child.pid)) {
      const tail = lines.slice(-6).join('\n');
      throw new Error('frpc 启动后立刻退出了。输出末尾：\n' + (tail || '（没有输出）'));
    }

    this.store.setSetting('frpLaunched', {
      pid: child.pid,
      at: new Date().toISOString(),
      exe: info.exePath,
    });
    this.invalidate();
    return { pid: child.pid, adminReady: ready };
  }

  async stop() {
    const tray = this.trayInfo();
    if (tray) {
      const st = await this.processState();
      if (!st.running) throw new Error('frpc-tray 未在运行');
      const r = await frptray.stop(tray.exe);   // 用它自己的 -stop，不按映像名杀
      this.invalidate();
      return r;
    }

    const st = await this.processState();
    if (!st.running) throw new Error('frpc 未在运行');
    const r = await frpproc.stopFrpc(st.pid, this.adminClient());
    this.store.setSetting('frpLaunched', null);
    this.invalidate();
    return r;
  }

  async reload() {
    const admin = this.adminClient();
    if (!admin || !admin.enabled) return { via: 'none' };
    try {
      await admin.reload();
      return { via: 'admin' };
    } catch {
      return { via: 'none' };
    }
  }

  /* ─────────────────────────── 隧件事务 ─────────────────────────── */

  /** 配置或关联变了，缓存作废 */
  invalidate() {
    this.cache.proxiesAt = 0;
    this.cache.tomlMtime = 0;
    // 配置可能改了 serverAddr，连接旁证随即作废
    this.cache.link = null;
    this.cache.at = 0;
  }

  /** frp 目录的探测结果，5 秒内复用（detect 会递归扫目录） */
  dirInfo() {
    if (this.cache.dirAt && Date.now() - this.cache.dirAt < 5000) return this.cache.dirInfo;
    this.cache.dirInfo = frpinstall.detect(this.resolveDir());
    this.cache.dirAt = Date.now();
    return this.cache.dirInfo;
  }

  /** 隧道列表，2 秒内复用（采样器同频刷新，状态每秒读盘没必要） */
  proxies() {
    if (this.cache.proxiesAt && Date.now() - this.cache.proxiesAt < 2000) return this.cache.proxies;
    const { text, exists } = this.readConfig();
    this.cache.proxies = exists ? frptoml.listProxies(text) : [];
    this.cache.proxiesAt = Date.now();
    return this.cache.proxies;
  }

  /** 面板记录里 <proxy 名> ↔ <服务器 id> 的映射 */
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

  async createProxy(fields, serverId = null) {
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

  async updateProxy(name, patch, serverId = null) {
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
    }
    this.invalidate();
    this.reload().catch(() => {});
    return { proxy: ok, changed, renamed: ok.name !== name };
  }

  async removeProxy(name) {
    const file = this.configPath();
    const { text, exists } = this.readConfig();
    if (!exists) throw new Error('这个目录里没有 frpc.toml');
    const before = frptoml.listProxies(text).length;
    const { text: next, removed } = frptoml.removeProxy(text, name);
    if (!removed) throw new Error('隧道不存在: ' + name);
    await this.writeConfig(next, before - 1);

    const { byProxy } = this.mapping();
    const id = byProxy.get(name);
    if (id) this.store.update(id, { frp: null });
    this.invalidate();
    this.reload().catch(() => {});
    return { removed: true };
  }

  /** 该服务器的默认隧道参数 */
  suggestions(serverId) {
    const s = this.manager.get(serverId);
    if (!s) throw new Error('服务器不存在');
    const port = (s.status && s.status.port) || s.port || 25565;
    let ip = '127.0.0.1';
    try {
      const raw = String(s.prop('server-ip', '0.0.0.0'));
      if (raw && raw !== '0.0.0.0' && raw !== '::') ip = raw;
    } catch {}
    const taken = new Set(this.proxies().map((p) => p.name));
    let base = tunnelSlug(s.name);
    if (!/[A-Za-z0-9]/.test(base)) base = tunnelSlug(path.basename(s.dir));
    if (!/[A-Za-z0-9]/.test(base)) base = 'mc';
    let name = base;
    for (let i = 2; taken.has(name) && i < 100; i++) name = `${base}-${i}`;
    return { name, type: 'tcp', localIP: ip, localPort: port, remotePort: port };
  }

  /* ─────────────────────────── 采样 ─────────────────────────── */

  startSampler() {
    if (this.timer) return;
    const tick = () => this.sample().catch(() => {});
    this.timer = setInterval(tick, SAMPLE_MS);
    if (this.timer.unref) this.timer.unref();
    tick();

    if (this.getSettings().autoStart) {
      setTimeout(() => {
        if (this.store.getSetting('frpAutoStart', false)) {
          this.start().catch((e) => console.error('[面板] frpc 自动启动失败：' + e.message));
        }
      }, 1500);
    }
  }

  async sample() {
    if (this.cache.busy) return;
    this.cache.busy = true;
    try {
      // 进程状态先落缓存，后面无论有没有配置文件，界面都读得到
      const proc = await this.processState();
      this.cache.process = proc;

      const file = this.configPath();
      const { text, exists, mtimeMs } = frptoml.read(file);
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
          this.cache.tunnel = await admin.status();
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
        this.cache.link = await this.linkState(proc, text);
      }

      this.cache.at = Date.now();
    } finally {
      this.cache.busy = false;
    }
  }

  /** 供 McServer 的 status 同步调用 */
  statusFor(serverId) {
    const info = this.dirInfo();
    const running = !!(this.cache.process && this.cache.process.running);
    const base = {
      installed: info.installed,
      version: info.version,
      running,
      statusSource: this.statusSource(),
      adminEnabled: !!(this.store.getSetting('frpAdmin', null) || {}).port,
    };
    const { proxy, how } = this.associationFor(serverId);
    if (!proxy) {
      return { ...base, attached: false, attachHow: how === 'ambiguous' ? 'ambiguous' : 'none', proxy: null, online: false, statusKnown: false };
    }
    const t = this.tunnelInfo(proxy.name);
    const r = this.cache.rates.get(proxy.name) || null;
    const tot = this.cache.totals.get(proxy.name) || null;
    return {
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
  }

  /** GET /api/frp 的响应体 */
  async overview() {
    const dir = this.resolveDir();
    const info = this.dirInfo();
    const st = this.getSettings();
    // 用采样器两秒一次的结果；没有才现查（现查要走一次 PowerShell 进程枚举）
    const proc = this.cache.process || await this.processState();
    const admin = this.store.getSetting('frpAdmin', null);
    const { text, exists } = this.readConfig();
    const top = exists ? frptoml.parseTop(text) : { includes: [] };

    // 与 associationFor() 同口径：显式记录优先，其次按 localPort 与本机监听端口对上。
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
        enabled: !!(admin && admin.port),
        port: admin ? admin.port : null,
        managed: !!(exists && frptoml.readWebServer(text) && frptoml.readWebServer(text).managed),
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

  /** GET /api/servers/:id/frp 的响应体 */
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
      stale: proxy && port && proxy.localPort !== port ? { localPort: proxy.localPort, serverPort: port } : null,
      tunnel: proxy ? this.tunnelInfo(proxy.name) : null,
      statusSource: source,
      link: this.cache.link ? { up: this.cache.link.up, peer: this.cache.link.peer } : null,
      admin: { enabled: !!(this.store.getSetting('frpAdmin', null) || {}).port },
      traffic: proxy ? {
        rateIn: (this.cache.rates.get(proxy.name) || {}).in ?? null,
        rateOut: (this.cache.rates.get(proxy.name) || {}).out ?? null,
        error: this.cache.trafficError,
      } : null,
    };
  }
}

module.exports = { Frp, PROJECT_ROOT };
