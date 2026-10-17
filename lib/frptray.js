'use strict';
/**
 * frpc-tray（单文件 frpc 启动器）的对接。
 * 它的配置贴在 exe 尾部：<原 exe 字节> <配置 UTF-8> <长度 4 字节小端> <魔术 16 字节>，
 * 所以面板直接读/写这段，改完让它自己重启一次即可生效。
 * 启停只走它文档化的命令行参数，不按映像名杀进程。
 */
const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');
const { sleep } = require('./util');

const MAGIC = Buffer.from('FRPCTRAYCFGv1\0\0\0', 'binary');
const TAIL = MAGIC.length + 4;
const EXE = 'frpc-tray.exe';
const STOP_TIMEOUT_MS = 20000;

function exePath(dir) {
  return path.join(dir, EXE);
}

/** 该目录里有没有 frpc-tray.exe */
function present(dir) {
  try {
    return fs.statSync(exePath(dir)).isFile();
  } catch {
    return false;
  }
}

/** exe 尾部有没有内嵌配置块（出厂状态下没有） */
function hasConfig(file) {
  try {
    const st = fs.statSync(file);
    if (st.size < TAIL) return false;
    const fd = fs.openSync(file, 'r');
    const head = Buffer.alloc(TAIL);
    try {
      fs.readSync(fd, head, 0, TAIL, st.size - TAIL);
    } finally {
      fs.closeSync(fd);
    }
    if (!head.slice(4).equals(MAGIC)) return false;
    const len = head.readUInt32LE(0);
    return len > 0 && len <= st.size - TAIL;
  } catch {
    return false;
  }
}

/** 读内嵌配置；没有配置块或不是 frpc-tray 就返回 null */
function readConfig(file) {
  let fd = null;
  try {
    const st = fs.statSync(file);
    if (st.size < TAIL) return null;
    fd = fs.openSync(file, 'r');
    const head = Buffer.alloc(TAIL);
    fs.readSync(fd, head, 0, TAIL, st.size - TAIL);
    if (!head.slice(4).equals(MAGIC)) return null;
    const len = head.readUInt32LE(0);
    if (!(len > 0) || len > st.size - TAIL) return null;
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, st.size - TAIL - len);
    return buf.toString('utf8');
  } catch {
    return null;
  } finally {
    if (fd != null) { try { fs.closeSync(fd); } catch { /* 失败可忽略 */ } }
  }
}

/**
 * 改写内嵌配置。只重写 exe 尾部配置区，不整读整写。
 * 写前整份备份，写后回读比对，不符即回滚。
 * exe 正在运行时 Windows 不允许替换，会在这里报出来。
 */
function writeConfig(file, text, expectProxies) {
  if (expectProxies != null) {
    // 只数行首的 [[proxies]]，注释行不算
    const got = String(text).split(/\r?\n/).filter((l) => /^\s*\[\[proxies\]\]\s*$/.test(l)).length;
    if (got !== expectProxies) throw new Error(`写入前校验失败：条目数应为 ${expectProxies}，实际 ${got}`);
  }

  const st = fs.statSync(file);
  const fd = fs.openSync(file, 'r');
  let head;
  try {
    head = Buffer.alloc(2);
    fs.readSync(fd, head, 0, 2, 0);
  } finally {
    fs.closeSync(fd);
  }
  if (!(head[0] === 0x4d && head[1] === 0x5a)) throw new Error('不是可执行文件，已拒绝改写');

  const cur = readConfig(file);
  const baseLen = cur == null ? st.size : st.size - (Buffer.byteLength(cur, 'utf8') + TAIL);
  const cfg = Buffer.from(String(text), 'utf8');
  const len = Buffer.alloc(4);
  len.writeUInt32LE(cfg.length, 0);

  const bak = file + '.bak';
  fs.copyFileSync(file, bak);
  // 截到原 exe 尾部再写配置区，峰值内存与配置大小同级
  let out;
  try {
    out = fs.openSync(file, 'r+');
    fs.ftruncateSync(out, baseLen);
    fs.writeSync(out, Buffer.concat([cfg, len, MAGIC]), 0, cfg.length + TAIL, baseLen);
  } catch (e) {
    if (out != null) { try { fs.closeSync(out); } catch { /* 失败可忽略 */ } }
    fs.copyFileSync(bak, file);
    throw new Error(`写不进 ${EXE}（${e.code || e.message}）。它可能还在运行，先让它退出再试`);
  }
  fs.closeSync(out);

  if (readConfig(file) !== String(text)) {
    fs.copyFileSync(bak, file);
    throw new Error('写入后校验失败，已回滚');
  }
  return { file, bak, bytes: baseLen + cfg.length + TAIL };
}

/* ─────────────────────────── 进程 ─────────────────────────── */

const PS_LIST = `
$out = @()
foreach ($p in (Get-Process -Name 'frpc-tray' -ErrorAction SilentlyContinue)) {
  $st = $null; $exe = $null
  try { $st = $p.StartTime.ToString('o') } catch {}
  try { $exe = $p.Path } catch {}
  $out += [PSCustomObject]@{ pid = $p.Id; start = $st; exe = $exe }
}
ConvertTo-Json -InputObject $out -Compress -Depth 3
`;

const NEG_TTL = 15000;   // 没有实例时的重新枚举间隔
const POS_TTL = 20000;   // 有实例时的重新枚举上限（PID 复用兜底）
let cache = { at: 0, data: [] };

/** 进程是否还在；EPERM 表示存在但没有权限访问。 */
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

/**
 * 本机所有 frpc-tray 实例。与 frpc.exe 分得开，靠映像名不同。
 * 已知实例都还在就直接复用它（进程查活的代价是零），实例增减或超过 20 秒才重新枚举。
 */
async function list(force = false) {
  if (!force) {
    const fresh = cache.data.length
      ? Date.now() - cache.at < POS_TTL && cache.data.every((p) => alive(p.pid))
      : Date.now() - cache.at < NEG_TTL;
    if (fresh) return cache.data;
  }
  const { ps } = require('./util');
  try {
    const out = (await ps(PS_LIST, 8000)).trim();
    const arr = out ? JSON.parse(out) : [];
    cache = { at: Date.now(), data: Array.isArray(arr) ? arr : (arr ? [arr] : []) };
  } catch {
    cache = { at: Date.now(), data: cache.data };
  }
  return cache.data;
}

/**
 * 指定 exe 那个实例的状态。
 * 必须按可执行文件路径过滤：同一台机器上可能有两份 frpc-tray（各自的单实例 id 按路径区分），
 * 只按映像名数会把别人的算成自己的。
 */
async function state(exe, force = false) {
  const all = (await list(force)).filter((p) => p && p.pid);
  const want = exe ? path.resolve(exe).toLowerCase() : null;
  const mine = want ? all.filter((p) => p.exe && path.resolve(p.exe).toLowerCase() === want) : all;
  return {
    running: mine.length > 0,
    pid: mine.length ? mine[0].pid : null,
    startedAt: mine.length ? mine[0].start : null,
    count: mine.length,
    others: want ? all.length - mine.length : 0,
  };
}

/** 启动它。它自己会拉起 frpc 子进程。 */
function start(exe, cwd) {
  if (!fs.existsSync(exe)) throw new Error('找不到 frpc-tray.exe: ' + exe);
  const child = spawn(exe, [], { cwd: cwd || path.dirname(exe), detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
  // spawn 失败发 error 事件，无监听会带走整个进程
  child.on('error', (e) => {
    console.error('[面板] frpc-tray 启动失败：' + (e && e.message ? e.message : e));
  });
  cache = { at: 0, data: [] };   // 刚拉起来，下一次枚举立即重查
  return { pid: child.pid };
}

/** 走它文档化的 -stop：唤醒已在运行的实例结束 frpc 并退出；随后等它真的消失。 */
async function stop(exe) {
  const before = await state(exe, true);
  if (!before.running) return { via: 'none' };
  await new Promise((resolve) => {
    execFile(exe, ['-stop'], { windowsHide: true, timeout: 15000 }, () => resolve());
  });
  const deadline = Date.now() + STOP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(400);
    if (!(await state(exe)).running) return { via: '-stop' };
  }
  throw new Error(`已请求 ${EXE} 退出，但 ${Math.round(STOP_TIMEOUT_MS / 1000)} 秒后它仍在运行`);
}

module.exports = {
  MAGIC,
  TAIL,
  EXE,
  exePath,
  present,
  hasConfig,
  readConfig,
  writeConfig,
  list,
  state,
  start,
  stop,
};
