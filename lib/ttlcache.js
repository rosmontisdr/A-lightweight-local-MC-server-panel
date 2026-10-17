'use strict';
/**
 * TTL 缓存。key → { at, data }，过期即失效；可选 pending 去重（同 key 只跑一个刷新）。
 */

class TtlCache {
  /**
   * @param {number} ttl 过期时长（毫秒）
   * @param {number} [failTtl] 负结果（data 为 null/undefined）的过期时长，缺省用 ttl
   */
  constructor(ttl, failTtl = null) {
    this.ttl = ttl;
    this.failTtl = failTtl;
    this.map = new Map();
    this.pending = new Map();
  }

  /** 命中返回 { data }，未命中或过期返回 null */
  get(key) {
    const hit = this.map.get(key);
    if (!hit) return null;
    const ttl = hit.data == null && this.failTtl != null ? this.failTtl : this.ttl;
    return Date.now() - hit.at < ttl ? hit : null;
  }

  set(key, data) {
    this.map.set(key, { at: Date.now(), data });
    return data;
  }

  delete(key) {
    this.map.delete(key);
    this.pending.delete(key);
  }

  invalidate() {
    this.map.clear();
    this.pending.clear();
  }

  /** 同 key 的刷新只跑一个；返回 Promise */
  once(key, fn) {
    if (this.pending.has(key)) return this.pending.get(key);
    const job = Promise.resolve()
      .then(fn)
      .then((data) => this.set(key, data))
      .finally(() => this.pending.delete(key));
    this.pending.set(key, job);
    return job;
  }
}

module.exports = { TtlCache };
