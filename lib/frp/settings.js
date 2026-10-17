'use strict';
/** Frp 设置、配置读写与管理接口凭据。 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const frptoml = require('../frptoml');
const frpproc = require('../frpproc');
const frptray = require('../frptray');
const frpinstall = require('../frpinstall');
const { FrpsAdmin } = require('../frptraffic');
const { SECRET_MASK } = require('../props');
const { tunnelSlug, freePort, PROJECT_ROOT } = require('./common');

module.exports = {
  getSettings() {
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
    };
  }

  /** 面板管理的 frp 目录；未设置时用项目根目录 */,
  resolveDir() {
    return this.getSettings().dir || PROJECT_ROOT;
  }
,
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

  /** 给 frpc.toml 补上 [webServer] 段（已存在则原样保留），供面板读逐条隧道状态 */,
  async enableAdmin() {
    return this._lock(() => this._enableAdmin());
  }
,
  async _enableAdmin() {
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

  /** frp 目录里如果是 frpc-tray，就用它当运行器；配置改到它 exe 尾部 */,
  trayInfo() {
    const dir = this.resolveDir();
    if (!frptray.present(dir)) return null;
    const exe = frptray.exePath(dir);
    return { dir, exe, hasConfig: frptray.hasConfig(exe) };
  }
,
  configPath() {
    const t = this.trayInfo();
    if (t) return t.exe;
    const d = this.dirInfo();
    return d.configPath || path.join(this.resolveDir(), 'frpc.toml');
  }
,
  readConfig() {
    const t = this.trayInfo();
    if (t) {
      const text = frptray.readConfig(t.exe);
      let mtimeMs = 0;
      try { mtimeMs = fs.statSync(t.exe).mtimeMs; } catch { /* 失败可忽略 */ }
      // frpc-tray 模式下 exe 本身就是配置容器，没有配置块时也视为「存在但为空」
      return { text: text == null ? '' : text, exists: true, mtimeMs };
    }
    return frptoml.read(this.configPath());
  }

  /**
   * 写回配置。frpc-tray 模式下写它 exe 尾部，并按用户要求「改完重启它」——
   * 它还在跑时 exe 被锁着写不进去，所以先让它收工、写完再拉起来。
   */,
  async writeConfig(text, expectProxies) {
    const t = this.trayInfo();
    if (!t) {
      const r = frptoml.writeAtomic(this.configPath(), text, expectProxies);
      this.invalidate();   // 配置变了，adminConfig 等缓存一并作废
      return r;
    }

    const st = await frptray.state(t.exe, true);
    let out;
    try {
      // stop 也要在 try 里：它超时会抛，那会把 frpc 留在停着的状态
      if (st.running) await frptray.stop(t.exe);
      out = frptray.writeConfig(t.exe, text, expectProxies);
    } finally {
      if (st.running) {
        try { frptray.start(t.exe, t.dir); } catch { /* 失败可忽略 */ }
      }
    }
    this.invalidate();
    return out;
  }

  /**
   * frpc 管理接口的端口与凭据。
   * **以配置里的 [webServer] 段为准**——那才是 frpc 实际在用的那一份；
   * 面板设置只好在那里还没有该段时的目标值。
   * 只看设置会导致「配置里有 [webServer]、面板却用不了」（段是别的面板写的、或设置被重置过）。
   */,
  adminConfig() {
    // 每秒的 statusFor() 都会调到，不能每次读盘
    if (this.cache.adminAt && Date.now() - this.cache.adminAt < 2000) return this.cache.adminCfg;
    let out = null;
    const { text, exists } = this.readConfig();
    const ws = exists ? frptoml.readWebServer(text) : null;
    if (ws && ws.port) {
      out = { port: ws.port, user: ws.user || '', password: ws.password || '', managed: !!ws.managed, source: 'config' };
    } else {
      const s = this.store.getSetting('frpAdmin', null);
      if (s && s.port) out = { port: s.port, user: s.user || '', password: s.password || '', managed: false, source: 'setting' };
    }
    this.cache.adminCfg = out;
    this.cache.adminAt = Date.now();
    return out;
  }

  /**
   * 供界面回填的一份快照，随 /api/state 下发。
   * 有了它，「高级设置」与「FRP 设置」弹窗不必再发请求——手机经隧道访问时，
   * 那一次往返就是 200ms 级的卡顿。
   */,
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

  /** 面板管理的 [webServer]：已存在则复用，不存在则在启动时创建并记住 */,
  async ensureAdmin() {
    const file = this.configPath();
    const { text, exists } = this.readConfig();
    if (!exists) return null;
    const cur = frptoml.readWebServer(text);
    if (cur && cur.port) {
      // 已有段就复用它，并且把凭据补记到设置里，免得两处长期对不上
      this.store.setSetting('frpAdmin', { port: cur.port, user: cur.user, password: cur.password });
      return { port: cur.port, user: cur.user, password: cur.password, created: false };
    }

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
,
  adminClient() {
    const admin = this.adminConfig();
    if (!admin) return null;
    return new frpproc.FrpcAdmin(admin);
  }

  /** dashboard 地址与端口拼成完整 URL */,
  frpsUrl() {
    const st = this.getSettings();
    if (!st.frpsHost) return '';
    const proto = /^https?:\/\//i.test(st.frpsHost) ? '' : 'http://';
    const host = st.frpsHost.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
    return proto + host + (st.frpsPort ? ':' + st.frpsPort : '');
  }
,
  frpsClient() {
    const url = this.frpsUrl();
    if (!url) return null;
    const st = this.getSettings();
    return new FrpsAdmin({ url, user: st.frpsUser, password: st.frpsPassword });
  }

  /** frpc.toml 顶层的连接设置，token 只回报有无 */,
  configTop() {
    const { text, exists } = this.readConfig();
    if (!exists) return { exists: false, serverAddr: '', serverPort: null, hasToken: false };
    const t = frptoml.parseTop(text);
    return { exists: true, serverAddr: t.serverAddr, serverPort: t.serverPort, hasToken: !!t.token };
  }

  /** 改写 frpc.toml 顶层的 serverAddr / serverPort / auth.token */,
  async writeTop(patch) {
    return this._lock(() => this._writeTop(patch));
  }
,
  async _writeTop(patch) {
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
};
