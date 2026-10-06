'use strict';
/**
 * 面板配置：监听地址、端口、端口探测、打开浏览器。
 * server.js 与 launch.js 共用，两处对端口及「端口上是否为本面板」的判断必须一致。
 * 面板只绑 127.0.0.1，不对外监听。
 */

const HOST = '127.0.0.1';
const DEFAULT_PORT = 8080;

/** 只认 1024–65535 */
function normalizePort(v) {
  const n = Number(v);
  return Number.isInteger(n) && n >= 1024 && n <= 65535 ? n : null;
}

/** 端口优先级：MCPANEL_PORT 环境变量 > 面板保存的设置 > 默认 8080。环境变量不改动用户设置。 */
function resolvePort(store) {
  return normalizePort(process.env.MCPANEL_PORT)
    || normalizePort(store.getSetting('port'))
    || DEFAULT_PORT;
}

/**
 * 用浏览器打开地址；失败不影响面板运行。
 * 返回 Promise，子进程退出后 resolve；随后结束本进程的调用方须 await。
 */
function openBrowser(url) {
  const { execFile } = require('child_process');
  const [file, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : process.platform === 'darwin' ? ['open', [url]]
      : ['xdg-open', [url]];
  return new Promise((resolve) => {
    try {
      execFile(file, args, { windowsHide: true }, () => resolve());
    } catch {
      resolve(); // 同步抛错也 resolve
    }
  });
}

/** 探测端口上运行的是否为本面板。仅判断端口占用不够，按 /api/state 返回结构判定。 */
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

/**
 * 请面板把界面显示出来。已有页面在看面板时，面板会让那个页面自己冒到前台并返回 page=true，
 * 调用方据此决定要不要开浏览器——外部无法把浏览器里已有的标签页切到前台，只能这样绕。
 */
async function askShow(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/panel/show`, {
      signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) return { page: false };
    const j = await res.json();
    return { page: !!(j && j.page) };
  } catch {
    return { page: false };
  }
}

module.exports = { HOST, DEFAULT_PORT, normalizePort, resolvePort, openBrowser, isOurPanel, askShow };
