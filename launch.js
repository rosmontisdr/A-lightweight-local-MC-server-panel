'use strict';
/**
 * start.bat 的入口：将面板脱离控制台独立运行。
 * 以 detached + unref 启动独立进程，确认其监听后本进程退出。
 * 判断「端口上是否已运行本面板」必须在派生新进程前完成。输出写入 data/panel.log。
 */
const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const { Store } = require('./lib/store');
const { resolvePort, openBrowser, isOurPanel, askShow } = require('./lib/panelcfg');
const { LOG_FILE } = require('./lib/panellog');

const PORT = resolvePort(new Store());
const URL_ = `http://localhost:${PORT}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 页面收到关闭指令后，实测浏览器拆掉那个标签页只要 39ms；留三倍余量
const SWITCH_MS = 150;

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

/**
 * 托盘图标是否已经在跑。
 * 必须排除本进程：查进程用的 powershell 自己命令行里也含 tray.ps1，不排会永远算作「已在跑」。
 */
function trayRunning() {
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-Command',
      `@(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | Where-Object { $_.CommandLine -like '*tray.ps1*' -and $_.ProcessId -ne $PID }).Count`],
      { encoding: 'utf8', windowsHide: true, timeout: 10000 });
    return Number(String(out).trim()) > 0;
  } catch {
    return false;
  }
}

/**
 * 拉起托盘图标；已在跑就什么都不做。
 * 经 wscript + tray.vbs 转一手：powershell 直接以 detached 起会立刻退出（实测），
 * 不 detached 又会在本进程退出时被带走；wscript 没有控制台，也不闪黑框。
 */
function startTray() {
  if (trayRunning()) return;
  try {
    const child = spawn('wscript.exe', [
      '//B', '//Nologo', path.join(__dirname, 'tray.vbs'), String(PORT),
    ], { cwd: __dirname, detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
  } catch { }
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

  // 面板已在运行：不再派生新进程。已经有页面在看面板时，让那个页面自己关掉，
  // 再开一个新的（浏览器没法把已有的标签页切到前台，只能关掉重开）。openBrowser 须 await。
  if (await isOurPanel(PORT)) {
    console.log(`面板已经在运行：${URL_}`);
    startTray();
    if ((await askShow(PORT)).page) {
      console.log('已让原来的面板标签页关闭，正在打开新的…');
      await sleep(SWITCH_MS);
    } else {
      console.log('正在打开浏览器…');
    }
    await openBrowser(URL_);
    return 0;
  }

  const child = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    cwd: __dirname,
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, MCPANEL_OPEN: '1' },
  });
  child.unref();

  // 等待监听，最多 8 秒。确认后再报启动成功；端口占用、代码报错须在此说明。
  for (let i = 0; i < 40; i++) {
    await sleep(200);
    if (await isOurPanel(PORT)) {
      console.log(`面板已启动：${URL_}`);
      console.log('本窗口会在几秒后自动关闭，关闭后不影响面板运行。');
      startTray();
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
