'use strict';
/**
 * frpc 进程的枚举、启动、停止与认领，以及 frpc 自身 webServer 的 HTTP 客户端。
 * 与 lib/runtime.js 的 java 进程枚举互不干扰：这里只认 frpc。
 */
const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');
const { ps, sleep } = require('./util');

const PROC_TTL = 3000;

const PS_LIST = `
$out = @()
foreach ($p in (Get-Process -Name frpc -ErrorAction SilentlyContinue)) {
  $cmd = $null; $exe = $null; $st = $null; $rt = $null; $wt = $null
  try {
    $ci = Get-CimInstance Win32_Process -Filter "ProcessId=$($p.Id)"
    $cmd = $ci.CommandLine; $rt = $ci.ReadTransferCount; $wt = $ci.WriteTransferCount
  } catch {}
  try { $exe = $p.Path } catch {}
  try { $st = $p.StartTime.ToString('o') } catch {}
  $out += [PSCustomObject]@{ pid = $p.Id; cmd = $cmd; exe = $exe; start = $st; rt = $rt; wt = $wt }
}
ConvertTo-Json -InputObject $out -Compress -Depth 4
`;

let cache = { at: 0, data: [] };
let busy = null;

/** 枚举本机 frpc 进程。缓存 2 秒；force 为真时立即重取。 */
async function list(force = false) {
  if (!force && Date.now() - cache.at < PROC_TTL) return cache.data;
  if (busy) return cache.data;
  busy = (async () => {
    try {
      const out = (await ps(PS_LIST)).trim();
      const arr = out ? JSON.parse(out) : [];
      cache = { at: Date.now(), data: Array.isArray(arr) ? arr : [arr] };
    } catch {
      cache = { at: Date.now(), data: cache.data };
    } finally {
      busy = null;
    }
    return cache.data;
  })();
  return busy;
}

const PS_CONNS = (pid) => `
$out = @()
foreach ($c in (Get-NetTCPConnection -OwningProcess ${pid} -State Established -ErrorAction SilentlyContinue)) {
  $out += [PSCustomObject]@{ remote = $c.RemoteAddress; port = $c.RemotePort }
}
ConvertTo-Json -InputObject $out -Compress -Depth 3
`;

let peerCache = { pid: null, at: 0, data: new Set() };

/**
 * 该进程已建立的 TCP 连接对端，形如 8.162.3.18:7000。
 * 用来在拿不到 frpc/frps 管理接口时，判断 frpc 到底连没连上 frps。
 */
async function establishedPeers(pid) {
  if (!pid) return new Set();
  if (peerCache.pid === pid && Date.now() - peerCache.at < PROC_TTL) return peerCache.data;
  let set = new Set();
  try {
    const out = (await ps(PS_CONNS(pid), 8000)).trim();
    if (out) {
      const arr = JSON.parse(out);
      set = new Set((Array.isArray(arr) ? arr : [arr]).map((x) => `${x.remote}:${x.port}`));
    }
  } catch {}
  peerCache = { pid, at: Date.now(), data: set };
  return set;
}

function alive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

/** 比对进程启动时刻，容差 2 分钟，排除 pid 复用 */
function sameStart(procStart, recorded) {
  if (!recorded) return true;
  if (!procStart) return false;
  const a = new Date(procStart).getTime();
  const b = new Date(recorded).getTime();
  return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) < 120000;
}

const sameDir = (a, b) => !!a && !!b && path.dirname(a).toLowerCase() === path.dirname(b).toLowerCase();

/**
 * 找出当前该由面板负责的 frpc 进程。
 * rec 为面板上次落盘的 { pid, at, exe }。
 * @returns {{proc:object|null, how:'managed'|'claimed'|'foreign'|null}}
 */
async function resolve(rec, fresh = false) {
  const procs = await list(fresh).catch(() => []);
  const live = procs.filter((p) => alive(p.pid));
  if (!live.length) return { proc: null, how: null };

  if (rec && rec.pid != null) {
    const p = live.find((x) => x.pid === rec.pid);
    if (p && sameStart(p.start, rec.at) && (!rec.exe || sameDir(p.exe, rec.exe))) {
      return { proc: p, how: 'claimed' };
    }
  }
  return { proc: live[0], how: 'foreign' };
}

/**
 * 启动 frpc。exePath 为 frpc.exe，tomlPath 为配置，cwd 固定为配置所在目录。
 * 直接 spawn 进程本身，不经 cmd，pid 才归 frpc。
 */
function spawnFrpc(exePath, tomlPath, { onLine } = {}) {
  if (!fs.existsSync(exePath)) throw new Error('找不到 frpc.exe: ' + exePath);
  if (!fs.existsSync(tomlPath)) throw new Error('找不到配置文件: ' + tomlPath);

  const child = spawn(exePath, ['-c', tomlPath], {
    cwd: path.dirname(tomlPath),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    detached: true,
  });
  child.unref();

  const feed = (stream, tag) => {
    if (!stream || !onLine) return;
    let buf = '';
    stream.on('data', (d) => {
      buf += d.toString('utf8');
      const lines = buf.split(/\r?\n/);
      buf = lines.pop();
      for (const l of lines) if (l.trim()) onLine(tag, l.trim());
    });
  };
  feed(child.stdout, 'out');
  feed(child.stderr, 'err');
  return child;
}

function taskkill(pid) {
  return new Promise((resolve) => {
    execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => resolve());
  });
}

async function waitGone(pid, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!alive(pid)) return true;
    await sleep(300);
  }
  return !alive(pid);
}

/** frpc 自身 webServer 的 HTTP 客户端 */
class FrpcAdmin {
  constructor({ port, user, password } = {}) {
    this.port = port || null;
    this.user = user || '';
    this.password = password || '';
  }

  get enabled() {
    return !!this.port;
  }

  _headers() {
    if (!this.user) return {};
    const raw = Buffer.from(`${this.user}:${this.password}`, 'utf8').toString('base64');
    return { Authorization: 'Basic ' + raw };
  }

  _url(p) {
    return `http://127.0.0.1:${this.port}${p}`;
  }

  async _get(p, timeout = 3000) {
    const r = await fetch(this._url(p), { headers: this._headers(), signal: AbortSignal.timeout(timeout) });
    if (!r.ok) throw new Error(`frpc 管理接口返回 ${r.status}`);
    return r.json();
  }

  /** 存活探测 */
  async probe() {
    if (!this.enabled) return false;
    try {
      const r = await fetch(this._url('/healthz'), { headers: this._headers(), signal: AbortSignal.timeout(1500) });
      return r.ok;
    } catch {
      return false;
    }
  }

  /** 各条隧道的运行状态，键为 proxy 名 */
  async status() {
    const j = await this._get('/api/status');
    const out = new Map();
    for (const arr of Object.values(j || {})) {
      for (const p of arr || []) {
        out.set(p.name, {
          online: p.status === 'running',
          status: p.status || '',
          err: p.err || null,
          localAddr: p.local_addr || '',
          remoteAddr: p.remote_addr || '',
        });
      }
    }
    return out;
  }

  async reload() {
    const r = await fetch(this._url('/api/reload'), {
      headers: this._headers(), signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) throw new Error(`frpc 重载失败：HTTP ${r.status}`);
  }

  async stop() {
    const r = await fetch(this._url('/api/stop'), {
      method: 'POST', headers: this._headers(), signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) throw new Error(`frpc 停止失败：HTTP ${r.status}`);
  }
}

/** 先走官方优雅停止，失败再强杀 */
async function stopFrpc(pid, admin, timeoutMs = 15000) {
  if (!pid) throw new Error('frpc 未在运行');
  if (admin && admin.enabled) {
    try {
      await admin.stop();
      if (await waitGone(pid, timeoutMs)) return { via: 'admin' };
    } catch {}
  }
  await taskkill(pid);
  await sleep(500);
  if (alive(pid)) throw new Error(`frpc 进程未能结束，请用任务管理器手动结束 PID ${pid}`);
  return { via: 'taskkill' };
}

module.exports = {
  list,
  resolve,
  establishedPeers,
  spawnFrpc,
  stopFrpc,
  taskkill,
  waitGone,
  alive,
  sameStart,
  FrpcAdmin,
};
