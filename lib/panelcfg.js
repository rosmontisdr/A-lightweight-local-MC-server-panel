'use strict';
/**
 * 面板配置：监听地址、端口、端口探测、打开浏览器。
 * server.js 与 launch.js 共用，两处对端口及「端口上是否为本面板」的判断必须一致。
 * 面板只绑 127.0.0.1，不对外监听。
 */

const HOST = '127.0.0.1';
const DEFAULT_PORT = 8080;

/** 只认 1024–65535；更低端口需管理员权限，不应占用 */
function normalizePort(v) {
  const n = Number(v);
  return Number.isInteger(n) && n >= 1024 && n <= 65535 ? n : null;
}

/** 端口优先级：MCPANEL_PORT 环境变量 > 面板保存的设置 > 默认 8080。环境变量供临时调试，不改动用户设置。 */
function resolvePort(store) {
  return normalizePort(process.env.MCPANEL_PORT)
    || normalizePort(store.getSetting('port'))
    || DEFAULT_PORT;
}

/** 用浏览器打开地址；失败不影响面板运行。 */
function openBrowser(url) {
  const { execFile } = require('child_process');
  const [file, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : process.platform === 'darwin' ? ['open', [url]]
      : ['xdg-open', [url]];
  execFile(file, args, { windowsHide: true }, () => {});
}

/** 探测端口上运行的是否为本面板。仅判断端口占用不够：占用者可能是其他程序，此时不应打开浏览器。按 /api/state 返回结构判定。 */
async function isOurPanel(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/state`, {
      signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) return false;
    const j = await res.json();
    return !!(j && j.panel && j.panel.port === port);
  } catch {
    return false;
  }
}

module.exports = { HOST, DEFAULT_PORT, normalizePort, resolvePort, openBrowser, isOurPanel };
