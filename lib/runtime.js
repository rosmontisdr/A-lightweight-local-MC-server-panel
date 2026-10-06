'use strict';
/**
 * 本机进程 / 端口探测。
 * Forge 的启动命令不含服务器目录，无法靠命令行匹配目录；
 * 改以 server.properties 的 server-port 经 netstat 查占用 PID 定位进程，对面板与手动启动均有效。
 */
const os = require('os');
const { execFile } = require('child_process');
const { ps } = require('./util');

const CPU_COUNT = os.cpus().length || 1;

let procCache = { at: 0, data: [] };
let portCache = { at: 0, data: new Map() };
let procBusy = null;  // 在飞的探测，保证同一时刻只有一个 PowerShell / netstat
let portBusy = null;
const TTL = 2000;

const PS_LIST_PROCS = `
$out = @()
foreach ($p in (Get-Process -Name java,javaw -ErrorAction SilentlyContinue)) {
  $cmd = $null
  try { $cmd = (Get-CimInstance Win32_Process -Filter "ProcessId=$($p.Id)").CommandLine } catch {}
  $st = $null
  try { $st = $p.StartTime.ToString('o') } catch {}
  $pe = $null
  try { $pe = $p.Path } catch {}
  $out += [PSCustomObject]@{ pid = $p.Id; mem = $p.WorkingSet64; cpuMs = [math]::Round($p.TotalProcessorTime.TotalMilliseconds); start = $st; cmd = $cmd; exe = $pe }
}
ConvertTo-Json -InputObject $out -Compress -Depth 4
`;

/** 后台探测 java/javaw 进程。失败保留旧数据。 */
function probeProcs() {
  if (procBusy) return procBusy;
  procBusy = ps(PS_LIST_PROCS)
    .then((raw) => {
      let arr = JSON.parse(String(raw).trim() || '[]');
      if (!Array.isArray(arr)) arr = arr ? [arr] : [];
      procCache = { at: Date.now(), data: arr.filter((p) => p && p.pid) };
    })
    .catch(() => { procCache = { at: Date.now(), data: procCache.data }; })
    .then(() => { procBusy = null; });
  return procBusy;
}

/**
 * 列出所有 java/javaw 进程。缓存过期只触发后台刷新，立即返回旧数据。
 * force 为真（刚杀进程 / 刚启动后的判定）才等这一次。首次调用无缓存也必须等。
 */
async function listJavaProcesses(force = false) {
  if (force) {
    await probeProcs();
    return procCache.data;
  }
  if (Date.now() - procCache.at >= TTL) {
    const job = probeProcs();
    if (!procCache.at) await job;
  }
  return procCache.data;
}

/** 后台执行 netstat。失败保留旧数据。 */
function probePorts() {
  if (portBusy) return portBusy;
  portBusy = new Promise((resolve) => {
    execFile('netstat', ['-ano', '-p', 'TCP'], { timeout: 10000, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (err, stdout) => {
      if (err) return resolve(portCache.data);
      const map = new Map();
      for (const line of String(stdout).split(/\r?\n/)) {
        if (!/LISTENING/i.test(line)) continue;
        const parts = line.trim().split(/\s+/);
        if (parts.length < 5) continue;
        const local = parts[1];
        const pid = Number(parts[4]);
        const m = local.match(/:(\d+)$/);
        if (!m || !pid) continue;
        const port = Number(m[1]);
        if (!map.has(port)) map.set(port, []);
        map.get(port).push(pid);
      }
      resolve(map);
    });
  }).then((map) => {
    portCache = { at: Date.now(), data: map };
    portBusy = null;
    return map;
  });
  return portBusy;
}

/** netstat -> Map<端口, pid[]>。与 listJavaProcesses 同理：后台刷新，不在 tick 里等。 */
async function listListeners(force = false) {
  if (force) {
    await probePorts();
    return portCache.data;
  }
  if (Date.now() - portCache.at >= TTL) {
    const job = probePorts();
    if (!portCache.at) await job;
  }
  return portCache.data;
}

/** 查找占用指定端口的 pid，返回对应 java 进程信息。 */
async function findProcessByPort(port) {
  if (!port) return null;
  const listeners = await listListeners();
  const pids = listeners.get(Number(port)) || [];
  if (!pids.length) return null;
  const procs = await listJavaProcesses();
  for (const p of procs) {
    if (pids.includes(p.pid)) return p;
  }
  // 端口被非 java 进程占用（少见）
  return null;
}

/** 查询指定 pid 监听的端口。 */
async function portsForPid(pid) {
  const listeners = await listListeners();
  const out = [];
  for (const [port, pids] of listeners) {
    if (pids.includes(pid)) out.push(port);
  }
  return out.sort((a, b) => a - b);
}

/** 采样两次 CPU 时间差计算占用率。 */
class CpuTracker {
  constructor() {
    this.last = new Map();
    this.value = new Map();
  }

  /** @returns {number|null} 0-100 之间的百分比（相对整机所有核心） */
  sample(pid, cpuMs) {
    if (pid == null || cpuMs == null) return null;
    const now = Date.now();
    const prev = this.last.get(pid);

    // 进程缓存 2 秒、轮询 1 秒，相邻采样常拿到同一 cpuMs（差值 0），此时报 0% 错误。
    // 保留上次有效值，且不更新 last.at，使下次采样覆盖整段间隔，平均值更准。
    if (prev && cpuMs === prev.cpuMs) return this.value.get(pid) ?? null;

    this.last.set(pid, { cpuMs, at: now });
    if (!prev) return null;
    const dt = now - prev.at;
    const dc = cpuMs - prev.cpuMs;
    if (dt <= 0 || dc < 0) return this.value.get(pid) ?? null;

    const v = Math.max(0, Math.min(100, (dc / dt / CPU_COUNT) * 100));
    this.value.set(pid, v);
    return v;
  }

  forget(pid) {
    this.last.delete(pid);
    this.value.delete(pid);
  }
}

/** 目录占用空间（递归，带缓存） */
const sizeCache = new Map();
async function dirSize(dir, maxAgeMs = 60000) {
  const hit = sizeCache.get(dir);
  if (hit && Date.now() - hit.at < maxAgeMs) return hit.size;
  return new Promise((resolve) => {
    const script = `
$p = ${JSON.stringify(dir)}
if (Test-Path -LiteralPath $p) {
  $s = (Get-ChildItem -LiteralPath $p -Recurse -File -Force -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum
  if ($s -eq $null) { $s = 0 }
  [string]$s
} else { '0' }
`;
    ps(script, 120000)
      .then((out) => {
        const size = Number(String(out).trim()) || 0;
        sizeCache.set(dir, { at: Date.now(), size });
        resolve(size);
      })
      .catch(() => resolve(hit ? hit.size : 0));
  });
}

module.exports = {
  listJavaProcesses,
  listListeners,
  findProcessByPort,
  portsForPid,
  CpuTracker,
  dirSize,
  CPU_COUNT,
};
