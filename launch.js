'use strict';
/**
 * start.bat 的入口：将面板脱离控制台独立运行。
 * Windows 关闭控制台会向挂载其上的所有进程发送 CTRL_CLOSE_EVENT，前台 node 随之退出；
 * 故以 detached + unref 启动独立进程，确认其监听后本进程退出。
 * 判断「端口上是否已运行本面板」必须在派生新进程前完成，否则会派生一个注定失败进程。输出写入 data/panel.log。
 */
const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');

const { Store } = require('./lib/store');
const { resolvePort, openBrowser, isOurPanel } = require('./lib/panelcfg');
const { LOG_FILE } = require('./lib/panellog');

const PORT = resolvePort(new Store());
const URL_ = `http://localhost:${PORT}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 端口是否有进程监听（不区分监听者）。 */
function portBusy(port) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port });
    const done = (v) => { sock.destroy(); resolve(v); };
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
    sock.setTimeout(800, () => done(false));
  });
}

function tail(file, n) {
  try {
    return fs.readFileSync(file, 'utf8').trimEnd().split(/\r?\n/).slice(-n).join('\n');
  } catch {
    return `（读不到日志 ${file}）`;
  }
}

async function main() {
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 18) {
    console.error(`[!] 需要 Node.js 18 或更高版本，当前是 ${process.version}。`);
    return 1;
  }

  // 面板已在运行：本次双击意图是打开面板，直接开浏览器，不再派生新进程
  if (await isOurPanel(PORT)) {
    console.log(`面板已经在运行，正在打开浏览器：${URL_}`);
    openBrowser(URL_);
    return 0;
  }

  const child = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    cwd: __dirname,
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, MCPANEL_OPEN: '1' },
  });
  child.unref();

  // 等待监听，最多 8 秒。确认后再报启动成功；端口占用、代码报错须在此说明，窗口关闭后无法查看。
  for (let i = 0; i < 40; i++) {
    await sleep(200);
    if (await isOurPanel(PORT)) {
      console.log(`面板已启动：${URL_}`);
      console.log('本窗口会在几秒后自动关闭，关闭后不影响面板运行。');
      return 0;
    }
  }

  // 启动失败：区分端口被其他程序占用与面板自身崩溃，后者输出日志末尾。
  if (await portBusy(PORT)) {
    console.error(`[!] 端口 ${PORT} 被其他程序占用了，面板没能启动。`);
    console.error('    换个端口：先临时改 MCPANEL_PORT 环境变量，或用面板界面里的「高级设置 → 端口」。');
  } else {
    console.error('[!] 面板启动失败（等了 8 秒仍没有响应）。日志末尾：');
    console.error('--------------------------------------------------');
    console.error(tail(LOG_FILE, 15));
    console.error('--------------------------------------------------');
    console.error(`    完整日志：${LOG_FILE}`);
  }
  return 1;
}

main().then((code) => process.exit(code), (e) => {
  console.error('[!] 启动出错:', e && e.stack || e);
  process.exit(1);
});
