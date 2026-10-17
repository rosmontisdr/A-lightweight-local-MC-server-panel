'use strict';
/**
 * FRP 管理门面：设置读写、隧道条目的增删改事务、frpc 进程托管、状态与吞吐采样。
 * 实现按职责拆在 lib/frp/ 下（settings / proxies / process / taps / sample），此处只保留门面。
 * 对外的 statusFor() 是同步的，只读缓存，绝不在调用方（1 秒 ticker）里等 IO。
 */
const settings = require('./frp/settings');
const proxies = require('./frp/proxies');
const process_ = require('./frp/process');
const taps = require('./frp/taps');
const sample = require('./frp/sample');
const { RateTracker } = require('./frptraffic');
const { PROJECT_ROOT } = require('./frp/common');

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
      busyAt: 0,
    };
    this.timer = null;
    this.autoTapTimer = null;
    this.healTimer = null;
    this.taps = new Map();   // serverId → TunnelProxy
    this.tapFix = new Map(); // serverId → { at, fails }：自愈重试的退避记账
    this._lockChain = Promise.resolve();
    this._sampleGen = 0;
  }

  /** 配置读改写事务互斥：并发的写操作串行执行，后写不覆盖先写 */
  _lock(fn) {
    const run = this._lockChain.then(fn, fn);
    this._lockChain = run.then(() => {}, () => {});
    return run;
  }
}

Object.assign(Frp.prototype, settings, proxies, process_, taps, sample);

module.exports = { Frp, PROJECT_ROOT };
