'use strict';
/**
 * 服务器实例注册表与状态轮询。单例，所有 McServer 实例在此。
 * 后台每秒 ticker 刷新状态、读取新增日志，并推给 SSE 订阅者。
 */
const { McServer } = require('./mcserver');
const { CpuTracker } = require('./runtime');
const { EventEmitter } = require('events');

class Manager extends EventEmitter {
  constructor(store) {
    super();
    this.setMaxListeners(0);
    this.store = store;
    this.servers = new Map();
    this.cpuTracker = new CpuTracker();
    this.dirSizeCache = new Map();
    this._refreshing = false;
    this._worldSizeAt = new Map();
    this.reload();
    this.startTicker();
  }

  reload() {
    const seen = new Set();
    for (const entry of this.store.list()) {
      seen.add(entry.id);
      if (!this.servers.has(entry.id)) {
        this.servers.set(entry.id, new McServer(entry, {
          cpuTracker: this.cpuTracker,
          dirSizeCache: this.dirSizeCache,
          claimedPids: (excludeId) => this.claimedPids(excludeId),
          markLaunched: (id, pid, at) => this.markLaunched(id, pid, at),
          clearLaunched: (id) => this.clearLaunched(id),
        }));
      } else {
        this.servers.get(entry.id).entry = entry;
      }
    }
    for (const id of [...this.servers.keys()]) {
      if (!seen.has(id)) this.servers.delete(id);
    }
  }

  get(id) {
    return this.servers.get(id) || null;
  }

  list() {
    return [...this.servers.values()];
  }

  add(opts) {
    const entry = this.store.add(opts);
    this.reload();
    return this.get(entry.id);
  }

  update(id, patch) {
    this.store.update(id, patch);
    this.reload();
    return this.get(id);
  }

  async remove(id) {
    const s = this.get(id);
    if (!s) throw new Error('服务器不存在');
    if (s.running) throw new Error('请先停止服务器再移除');
    this.servers.delete(id);
    this.store.remove(id);
    return true;
  }

  startTicker() {
    const tick = async () => {
      if (this._refreshing) return;
      this._refreshing = true;
      try {
        for (const s of this.servers.values()) {
          try { s.tailLog(); } catch {}
        }
        // 必须串行刷新。
        for (const s of this.list()) {
          try {
            const status = await raceRefresh(s);
            s.broadcast({ type: 'status', data: status });
            // TPS 需经 RCON / stdin 查询，响应慢。
            // 不等待，方法内部已限流与去重。
            s.autoProbeTps();
          } catch (e) {
            s.status.error = e.message;
          }
        }
        // 世界目录体积计算开销大，每 5 分钟一次
        for (const s of this.servers.values()) {
          const last = this._worldSizeAt.get(s.id) || 0;
          if (Date.now() - last > 5 * 60 * 1000) {
            this._worldSizeAt.set(s.id, Date.now());
            s.refreshWorldSize().catch(() => {});
          }
        }
      } finally {
        this._refreshing = false;
      }
    };
    this._timer = setInterval(() => { tick().catch(() => {}); }, 1000);
    if (this._timer.unref) this._timer.unref();
    tick().catch(() => {});
  }

  /** 记录面板启动的进程 pid 与启动时刻，面板重启后据此重新认领该进程。 */
  markLaunched(id, pid, at) {
    const e = this.store.get(id);
    if (!e) return;
    e.launchedPid = pid;
    e.launchedAt = at;
    this.store.save();
  }

  /** 进程已退出，清除认领记录。 */
  clearLaunched(id) {
    const e = this.store.get(id);
    if (!e || e.launchedPid == null) return;
    delete e.launchedPid;
    delete e.launchedAt;
    this.store.save();
  }

  /** 已被其他服务器认领的 PID（命令行兜底匹配用）。 */
  claimedPids(excludeId) {
    const set = new Set();
    for (const s of this.servers.values()) {
      if (s.id === excludeId) continue;
      const pid = s.status && s.status.pid;
      if (pid) set.add(pid);
    }
    return set;
  }

  /** 面板退出时需关闭的、由面板启动的服务器 */
  ownedPids() {
    return this.list().filter((s) => s.managed).map((s) => ({ id: s.id, name: s.name, pid: s.child.pid }));
  }
}

// 单台刷新的上限。超过即放弃本次等待，用上一次的状态继续。
const REFRESH_TIMEOUT_MS = 6000;

/**
 * 限时刷新。任一探测（进程 / 端口 / SLP）卡住时只在 6 秒后放弃这一台，
 * 不能让它拖住整个 ticker。
 * 放弃的刷新仍在后台跑完并自行写入 status，下一次 tick 拿到的就是它的结果。
 */
function raceRefresh(s) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(s.status), REFRESH_TIMEOUT_MS);
    s.refresh(false).then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

module.exports = { Manager };
