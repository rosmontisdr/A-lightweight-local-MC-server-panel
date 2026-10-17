'use strict';
/**
 * 统一的 JSON HTTP 客户端。AbortSignal 超时，非 2xx 先取消响应体再抛错（err.status 带状态码）。
 * frpproc / frptraffic / frpinstall 的 fetch 一律走这里。
 */

/**
 * GET 并解析 JSON。
 * @param {string} url
 * @param {{timeout?:number, headers?:object}} [opts]
 * @returns {Promise<any>}
 */
async function getJson(url, { timeout = 5000, headers = {} } = {}) {
  let r;
  try {
    r = await fetch(url, { headers, signal: AbortSignal.timeout(timeout) });
  } catch (e) {
    const why = e && e.name === 'TimeoutError' ? '超时' : (e && e.cause && e.cause.code) || '无法连接';
    const err = new Error(`连不上 ${url}（${why}）`);
    err.cause = e;
    throw err;
  }
  if (!r.ok) {
    // 非 2xx 先消费/取消响应体，不留悬空连接
    try { await r.body?.cancel(); } catch { /* 失败可忽略 */ }
    const err = new Error(`HTTP ${r.status}`);
    err.status = r.status;
    throw err;
  }
  return r.json();
}

/** GET 原始响应对象，调用方自行判断与读取。 */
async function getRaw(url, { timeout = 5000, headers = {} } = {}) {
  return fetch(url, { headers, signal: AbortSignal.timeout(timeout) });
}

/** POST 并解析 JSON。 */
async function postJson(url, { timeout = 5000, headers = {} } = {}) {
  let r;
  try {
    r = await fetch(url, { method: 'POST', headers, signal: AbortSignal.timeout(timeout) });
  } catch (e) {
    const why = e && e.name === 'TimeoutError' ? '超时' : (e && e.cause && e.cause.code) || '无法连接';
    const err = new Error(`连不上 ${url}（${why}）`);
    err.cause = e;
    throw err;
  }
  if (!r.ok) {
    try { await r.body?.cancel(); } catch { /* 失败可忽略 */ }
    const err = new Error(`HTTP ${r.status}`);
    err.status = r.status;
    throw err;
  }
  return r.json();
}

module.exports = { getJson, getRaw, postJson };
