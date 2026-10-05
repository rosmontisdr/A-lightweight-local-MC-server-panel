'use strict';
/**
 * 单个 Minecraft 服务器的运行时封装。
 * managed：面板 spawn 的进程，控制台走 stdin/stdout，指令即时生效；external：面板启动前已有的进程，只能读日志文件，发指令须走 RCON（server.properties 开 enable-rcon）。
 * 进程定位走 server-port → netstat → PID；Forge 启动命令行不含服务器目录，命令行匹配不可靠。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { StringDecoder } = require('string_decoder');
const { EventEmitter } = require('events');

const props = require('./props');
const launcher = require('./launcher');
const rcon = require('./rcon');
const rt = require('./runtime');
const jvm = require('./jvm');

const LOG_LIMIT = 3000;
const PING_CACHE_MS = 3000;
// 单次读取日志增量的上限。服务器启动瞬间日志可爆发数十 MB，同步读 + 逐行广播会卡住事件循环。
const TAIL_MAX = 512 * 1024;

class McServer extends EventEmitter {
  constructor(entry, ctx = {}) {
    super();
    this.setMaxListeners(0);
    this.entry = entry;
    this.ctx = ctx;              // { cpuTracker }
    this.child = null;
    this.childExited = null;     // 记录退出码
    this._adoptedPid = null;     // 面板重启后认领回来的、本面板启动过的进程 pid
    this._stoppingPid = null;    // 已发出停止指令、正在收尾的进程 pid；此时 start() 不能误报「已在运行」
    this.logs = [];
    this.logSeq = 0;
    this.subscribers = new Set();
    this.pingCache = { at: 0, data: null, port: null };
    this.tpsCache = { at: 0, value: null };
    this.tpsProbeResolvers = [];
    this.tpsLastTry = 0;     // 上次主动查询时刻，用于自动查询限流
    this.tpsMisses = 0;      // 连续未探到值的轮数，用于对无 TPS 指令的服务端退避
    this._tpsProbing = false; // 一次只查一轮，避免 1 秒 tick 叠加
    this._props = null;
    this._propsMtime = 0;
    this._tail = { decoder: new StringDecoder('utf8'), offset: 0, file: null };
    this._stdoutDecoder = new StringDecoder('utf8');
    this._stderrDecoder = new StringDecoder('utf8');
    this._stdoutBuf = '';
    this._stderrBuf = '';
    this._launchCache = null;
    this.lastError = null;
    this.status = {
      id: entry.id,
      running: false,
      managed: false,
      pid: null,
      port: null,
      cpu: null,
      mem: 0,
      uptimeMs: 0,
      startTime: null,
      players: { online: 0, max: 0, list: [] },
      version: null,
      motd: '',
      latency: null,
      tps: null,
      tpsAt: null,
      tpsBlocker: null,
      world: null,
      error: null,
    };
  }

  get id() { return this.entry.id; }
  get name() { return this.entry.name; }
  get dir() { return this.entry.dir; }
  get managed() { return !!(this.child && this.child.pid); }
  get running() { return this.status.running; }
  /** 由本面板启动的进程：managed 表示 stdin 通道仍在，认领回来的进程通道已随旧面板消失。 */
  get launchedByPanel() { return this.managed || this._adoptedPid != null; }
  /** 面板启动过但已失去 stdin 通道（面板重启过）。指令须走 RCON，停止只能走 RCON 或强制结束。 */
  get stdinLost() { return !this.managed && this._adoptedPid != null; }

  // ─────────────────────────── 配置 ───────────────────────────

  getLaunch() {
    // 保存的配置须通过 launcher.normalize 规整才使用；规整失败（如 programArgs 为空）则回退自动探测，避免用残缺配置 spawn。
    const saved = launcher.normalize(this.entry.launch);
    if (saved) return saved;
    if (!this._launchCache) this._launchCache = launcher.detect(this.dir);
    return this._launchCache;
  }

  /** 探测结果（用于前端展示可编辑的启动配置） */
  detectLaunch(force = false) {
    if (force || !this._launchCache) this._launchCache = launcher.detect(this.dir);
    return this._launchCache;
  }

  getProps(force = false) {
    const f = path.join(this.dir, 'server.properties');
    try {
      const st = fs.statSync(f);
      if (!force && this._props && this._propsMtime === st.mtimeMs) return this._props;
      const text = fs.readFileSync(f, 'utf8');
      this._propsText = text;
      this._props = props.parse(text);
      this._propsMtime = st.mtimeMs;
      return this._props;
    } catch {
      return { lines: [], map: {} };
    }
  }

  prop(key, def = null) {
    const p = this.getProps();
    return p.map[key] ? p.map[key].value : def;
  }

  get port() {
    const v = Number(this.prop('server-port', '25565'));
    return Number.isFinite(v) && v > 0 ? v : 25565;
  }

  get rconConfig() {
    const enabled = String(this.prop('enable-rcon', 'false')) === 'true';
    const password = this.prop('rcon.password', '');
    if (!enabled || !password) return null;
    return { host: '127.0.0.1', port: Number(this.prop('rcon.port', '25575')) || 25575, password };
  }

  get rconAvailable() { return !!this.rconConfig; }

  /**
   * 返回向该服务器发送指令的通道状态：有通道返回 null，无通道返回原因。
   * 判断条件与 sendCommand() 的分支一致：managed 可写 stdin，external 只能走 RCON。无通道即无 TPS，读日志猜出的值不算数。
   * @param {boolean} [running] 传入构造中的状态，避免读到上一轮的 this.status
   */
  commandBlocker(running = this.status.running) {
    if (this.managed && this.child?.stdin?.writable) return null;
    if (this.rconConfig) return null;
    if (!running) return '服务器未运行';
    if (this.stdinLost) return '面板重启后已失去控制台通道，且未启用 RCON';
    if (String(this.prop('enable-rcon', 'false')) === 'true') return 'RCON 缺少密码';
    return '未启用 RCON';
  }

  // ─────────────────────────── 状态 ───────────────────────────

  /**
   * 多策略定位服务器进程，依次尝试：面板 spawn 的 PID（最准，进程刚启动时以 this.child 为准）、配置端口的监听进程、命令行含启动 jar 名或 @args 路径的进程。
   * 启动参数可覆盖 server-port，仅凭配置端口判断不可靠。
   * @returns {{proc: object|null, how: string|null}}
   */
  async resolveProcess(configPort, force) {
    const procs = await rt.listJavaProcesses(force);

    if (this.child && this.child.pid) {
      const p = procs.find((x) => x.pid === this.child.pid)
        || { pid: this.child.pid, mem: this.status.mem, cpuMs: null, start: this.childStartTime };
      return { proc: p, how: 'managed' };
    }

    // 面板重启后认领本面板启动过的进程。pid 会被系统复用，须同时比对启动时刻。
    this._adoptedPid = null;
    const rec = this.entry.launchedPid;
    if (rec) {
      const p = procs.find((x) => x.pid === rec);
      if (p && this._sameStart(p.start, this.entry.launchedAt)) {
        this._adoptedPid = p.pid;
        return { proc: p, how: 'launched' };
      }
      // 进程已退出或 pid 被复用，记录作废
      this.ctx.clearLaunched?.(this.id);
    }

    const claimed = this.ctx.claimedPids ? this.ctx.claimedPids(this.id) : new Set();
    const free = (p) => !!p && !claimed.has(p.pid);

    const byPort = await rt.findProcessByPort(configPort);
    if (free(byPort)) return { proc: byPort, how: 'port' };

    const needles = this.matchNeedles();
    if (needles.length) {
      const hit = procs.find((p) => free(p)
        && needles.some((n) => String(p.cmd || '').toLowerCase().includes(n)));
      if (hit) return { proc: hit, how: 'cmdline' };
    }

    return { proc: null, how: null };
  }

  /** 比对进程启动时刻与记录值，容差 2 分钟：用于排除 pid 复用。 */
  _sameStart(procStart, recorded) {
    if (!recorded) return true;
    if (!procStart) return false;
    const a = new Date(procStart).getTime();
    const b = new Date(recorded).getTime();
    return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) < 120000;
  }

  /** 用于匹配进程命令行的特征串（全部小写） */
  matchNeedles() {
    const launch = this.getLaunch();
    const out = new Set();
    if (launch.jar) out.add(launch.jar.toLowerCase());
    for (const a of launch.programArgs || []) {
      if (a.startsWith('@')) out.add(a.slice(1).toLowerCase().replace(/\\/g, '/'));
      else if (/\.jar$/i.test(a)) out.add(a.toLowerCase());
    }
    // 部分启动器会将服务器目录写入命令行
    out.add(this.dir.toLowerCase().replace(/\\/g, '/'));
    out.add(this.dir.toLowerCase());
    return [...out].filter((n) => n.length > 4);
  }

  async refresh(force = false) {
    const dir = this.dir;
    const configPort = this.port;

    // 1) 定位进程
    const { proc, how } = await this.resolveProcess(configPort, force);
    const running = !!proc;

    // 2) 进程实际监听端口，以进程为准，配置值仅作参考
    let port = configPort;
    let portMismatch = false;
    if (proc) {
      const ports = await rt.portsForPid(proc.pid);
      if (ports.length) {
        const rconPort = Number(this.prop('rcon.port', '0')) || 0;
        const queryPort = Number(this.prop('query.port', '0')) || 0;
        if (ports.includes(configPort)) {
          port = configPort;
        } else {
          const candidates = ports.filter((p) => p !== rconPort && p !== queryPort);
          port = candidates.length ? candidates[0] : ports[0];
          portMismatch = port !== configPort;
        }
      }
    }

    // 3) CPU
    let cpu = null;
    if (running && this.ctx.cpuTracker) {
      cpu = this.ctx.cpuTracker.sample(proc.pid, proc.cpuMs);
    }

    // 3b) JVM 堆占用。须用进程自身 exe 定位 jcmd，不能用启动配置里的 javaPath：服务器可能由另一 JDK 启动，jcmd 版本不匹配会读不到。
    let heap = null;
    if (running) {
      heap = jvm.heapInfo(proc.pid, proc.exe);
    } else if (this.status && this.status.pid) {
      jvm.forget(this.status.pid);
    }

    // 4) SLP 信息（版本 / MOTD / 在线玩家 / 延迟）
    let slp = this.pingCache.data;
    if (running && (force || this.pingCache.port !== port || Date.now() - this.pingCache.at > PING_CACHE_MS)) {
      slp = await this.ping(port);
      this.pingCache = { at: Date.now(), data: slp, port };
    } else if (!running) {
      this.pingCache = { at: 0, data: null, port: null };
      slp = null;
    }

    this.status = {
      id: this.id,
      name: this.name,
      dir,
      running,
      managed: this.managed,
      launchedByPanel: this.launchedByPanel,
      stdinLost: this.stdinLost,
      detectedBy: how,
      controllable: this.managed || this.rconAvailable,
      rcon: this.rconAvailable,
      pid: proc ? proc.pid : null,
      port,
      configPort,
      portMismatch,
      cpu,
      mem: proc ? proc.mem : 0,
      // JVM 堆真实占用，读不到（JRE 无 jcmd / 非 HotSpot）时为 null，前端回退到 mem（进程工作集）。
      heap,
      startTime: proc ? proc.start : null,
      uptimeMs: proc && proc.start ? Math.max(0, Date.now() - new Date(proc.start).getTime()) : 0,
      players: slp && slp.ok
        ? { online: slp.players.online, max: slp.players.max, list: slp.players.sample }
        : { online: 0, max: Number(this.prop('max-players', '20')) || 20, list: [] },
      version: slp && slp.ok ? slp.version : null,
      motd: slp && slp.ok ? slp.motd : '',
      latency: slp && slp.ok ? slp.latency : null,
      tps: this.tpsCache.value,
      // 读取时刻（前端显示「N 秒前」）与读不到的原因。
      tpsAt: this.tpsCache.at || null,
      tpsBlocker: this.commandBlocker(running),
      online: !!(slp && slp.ok),
      world: this.worldInfo(),
      error: this.lastError,
    };
    return this.status;
  }

  ping(port) {
    const ip = String(this.prop('server-ip', '0.0.0.0'));
    const host = !ip || ip === '0.0.0.0' || ip === '::' ? '127.0.0.1' : ip;
    return require('./slp').ping(host, port || this.port, 4000);
  }

  worldInfo() {
    const name = this.prop('level-name', 'world');
    const wdir = path.join(this.dir, name);
    let mtime = null;
    let exists = false;
    try {
      const st = fs.statSync(wdir);
      exists = st.isDirectory();
      mtime = st.mtime.toISOString();
    } catch {}
    return {
      name,
      exists,
      mtime,
      size: this.ctx.dirSizeCache ? this.ctx.dirSizeCache.get(wdir) ?? null : null,
    };
  }

  async refreshWorldSize() {
    const wdir = path.join(this.dir, this.prop('level-name', 'world'));
    const size = await rt.dirSize(wdir);
    if (this.ctx.dirSizeCache) this.ctx.dirSizeCache.set(wdir, size);
    return size;
  }

  stats() {
    const counts = { mods: 0, plugins: 0 };
    try { counts.mods = fs.readdirSync(path.join(this.dir, 'mods')).filter((f) => /\.jar(\.disabled)?$/i.test(f)).length; } catch {}
    try { counts.plugins = fs.readdirSync(path.join(this.dir, 'plugins')).filter((f) => /\.jar$/i.test(f)).length; } catch {}
    let eula = false;
    try { eula = /^\s*eula\s*=\s*true/im.test(fs.readFileSync(path.join(this.dir, 'eula.txt'), 'utf8')); } catch {}
    return { ...counts, eula };
  }

  // ─────────────────────────── 日志 ───────────────────────────

  pushLog(line, stream = 'out', { quiet = false } = {}) {
    // quiet：TPS 轮询指令与回显不进控制台缓冲区、不广播，避免维度输出刷屏。parseTps 仍执行，探针依赖它取值。
    if (quiet) {
      this.parseTps(line);
      return { n: this.logSeq, t: Date.now(), line, stream };
    }
    const rec = { n: ++this.logSeq, t: Date.now(), line, stream };
    this.logs.push(rec);
    if (this.logs.length > LOG_LIMIT) this.logs.splice(0, this.logs.length - LOG_LIMIT);
    this.parseTps(line);
    for (const fn of this.subscribers) {
      try { fn({ type: 'log', data: rec }); } catch {}
    }
    return rec;
  }

  parseTps(line) {
    if (!line) return;
    // 先剥掉 § 颜色代码，否则服务端把颜色插在数字中间时会匹配失败。
    const s = String(line).replace(/§./g, '');

    // 原版 /tick query（1.20.3 起自带，Fabric / Forge 亦可用）不输出 "TPS" 字样，须换算。
    // 形如：Average time per tick: 0.2ms (Target: 50.0ms)
    const tq = s.match(/Average time per tick:\s*([\d.]+)\s*ms(?:\s*\(Target:\s*([\d.]+)\s*ms\))?/i);
    if (tq) {
      const ms = Number(tq[1]);
      const targetMs = Number(tq[2]) || 50;
      // 目标耗时 50ms 即 20 TPS；实际耗时更长表示跟不上，TPS 按比例下降，上限为目标值。
      if (Number.isFinite(ms) && ms > 0 && targetMs > 0) this._setTps(Math.min(1000 / targetMs, 1000 / ms));
      return;
    }

    const m = s.match(/Mean TPS:\s*([\d.]+)/i)                          // Forge / NeoForge
      || s.match(/TPS from last[^:]*:\s*([\d.]+)/i)                     // Paper / Spigot / Spark
      || s.match(/([\d.]+)\s*TPS\b/i)                                   // Carpet: "20.0 TPS"
      || s.match(/TPS:\s*([\d.]+)/i);
    if (m) this._setTps(Number(m[1]));
  }

  /** 写入 TPS 并唤醒正在等待的探针 */
  _setTps(v) {
    if (!Number.isFinite(v) || v < 0 || v > 100) return;
    this.tpsCache = { at: Date.now(), value: v };
    for (const r of this.tpsProbeResolvers) r(v);
    this.tpsProbeResolvers = [];
  }

  /** 读日志文件的增量（用于 external 形态；managed 走 stdout） */
  tailLog() {
    if (this.managed) return; // 托管进程用 stdout，避免日志重复
    const f = path.join(this.dir, 'logs', 'latest.log');
    let st;
    try { st = fs.statSync(f); } catch { return; }
    if (this._tail.file !== f || st.size < this._tail.offset) {
      // 换了文件或日志轮转：已有内容不读，直接从末尾续读
      this._tail = { decoder: new StringDecoder('utf8'), offset: st.size, file: f };
      this._tailStarted = false;
      this.pushLog('[面板] 已附加到日志文件（该进程非面板启动，仅显示新增日志）', 'panel');
      return;
    }
    if (st.size === this._tail.offset) return;

    // 增量过大时只读末尾一段：宁可丢掉中间的行，也不能让一次同步读拖住整个 tick。
    let from = this._tail.offset;
    let len = st.size - from;
    if (len > TAIL_MAX) {
      from = st.size - TAIL_MAX;
      len = TAIL_MAX;
    }
    const buf = Buffer.alloc(len);
    let fd;
    try {
      fd = fs.openSync(f, 'r');
      fs.readSync(fd, buf, 0, len, from);
    } catch {
      return;
    } finally {
      if (fd != null) { try { fs.closeSync(fd); } catch {} }
    }
    this._tail.file = f;
    this._tail.offset = st.size;

    let text = this._tail.decoder.write(buf);
    // 附件点落在行中间，丢掉残缺的首行，从下一个换行开始
    if (!this._tailStarted) {
      this._tailStarted = true;
      const idx = text.indexOf('\n');
      if (idx < 0) return;
      text = text.slice(idx + 1);
    }
    for (const l of text.split('\n')) {
      const s = l.replace(/\r$/, '');
      if (s.trim()) this.pushLog(s, 'tail');
    }
  }

  _attachStdout() {
    this._stdoutBuf = '';
    this.child.stdout.on('data', (buf) => {
      const text = this._stdoutBuf + this._stdoutDecoder.write(buf);
      const lines = text.split(/\r?\n/);
      this._stdoutBuf = lines.pop();
      for (const l of lines) this.pushLog(l, 'out');
    });
    this.child.stderr.on('data', (buf) => {
      const text = this._stderrBuf + this._stderrDecoder.write(buf);
      const lines = text.split(/\r?\n/);
      this._stderrBuf = lines.pop();
      for (const l of lines) this.pushLog(l, 'err');
    });
  }

  subscribe(fn) {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  broadcast(msg) {
    for (const fn of this.subscribers) {
      try { fn(msg); } catch {}
    }
  }

  // ─────────────────────────── 进程控制 ───────────────────────────

  async start() {
    if (this.managed) throw new Error('该服务器已由面板启动，正在运行中');
    // 刚发过停止指令时进程可能仍在存档收尾，等它退干净再启动，不要误报「已在运行」。
    if (this._stoppingPid && !(await this.waitForGone(this._stoppingPid, 60000))) {
      throw new Error('上一次的停止指令还没让进程退出，请稍候再启动，或用「强制结束」。');
    }
    if (this.status.running) {
      throw new Error(this.launchedByPanel
        ? '该服务器由本面板启动且仍在运行，但面板重启过，已经接不回它的控制台。\n'
          + '请先「停止」；停止也失败就用「强制结束」，然后再启动。'
        : '检测到服务器已经在运行（非面板启动）。请先停止它，或直接用 RCON 控制。');
    }
    const launch = this.getLaunch();
    if (launch.mode === 'unknown') throw new Error(launch.hint || '无法识别启动方式，请手动配置');

    const jvmArgs = Array.isArray(launch.jvmArgs) ? [...launch.jvmArgs] : [];
    const nogui = launch.nogui === false ? [] : ['nogui'];
    let cmd;
    let args;
    if (launch.mode === 'script') {
      cmd = process.platform === 'win32' ? 'cmd.exe' : 'sh';
      args = process.platform === 'win32'
        ? ['/c', launch.programArgs[0], ...nogui]
        : [launch.programArgs[0], ...nogui];
    } else {
      cmd = launch.javaPath || 'java';
      args = [...jvmArgs, ...launch.programArgs, ...nogui];
    }

    if (!fs.existsSync(path.join(this.dir, 'eula.txt')) ||
        !/eula\s*=\s*true/i.test(fs.readFileSync(path.join(this.dir, 'eula.txt'), 'utf8'))) {
      this.pushLog('[面板] 警告：eula.txt 未同意 EULA，服务器会拒绝启动。请先设为 eula=true。', 'panel');
    }

    this.lastError = null;
    this.pushLog(`[面板] 启动命令: ${cmd} ${args.join(' ')}`, 'panel');
    this.pushLog(`[面板] 工作目录: ${this.dir}`, 'panel');

    let child;
    try {
      child = spawn(cmd, args, {
        cwd: this.dir,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        // 必须 detached：Windows 上非 detached 的子进程随父进程退出而被终止，
        // 面板重启会连带杀掉服务器，与「面板退出不关闭服务器」的承诺相悖。
        detached: true,
      });
    } catch (e) {
      this.lastError = e.message;
      throw new Error('启动失败: ' + e.message);
    }
    child.unref();

    this.child = child;
    this.childExited = null;
    this.childStartTime = new Date().toISOString();
    // 记下 pid 与启动时刻：面板重启后据此认领该进程，pid 复用靠启动时刻排除。
    this.ctx.markLaunched?.(this.id, child.pid, this.childStartTime);
    this._attachStdout();

    child.on('error', (e) => {
      this.lastError = e.code === 'ENOENT'
        ? `找不到可执行文件「${cmd}」，请检查 Java 是否在 PATH 中，或在启动设置里填写 java.exe 的完整路径。`
        : e.message;
      this.pushLog('[面板] 进程错误: ' + this.lastError, 'err');
      this.child = null;
      this.childExited = { code: null, error: this.lastError };
      this.broadcast({ type: 'state', state: 'error', error: this.lastError });
    });

    child.on('exit', (code, signal) => {
      this.child = null;
      this._stoppingPid = null;
      this.childExited = { code, signal };
      this.ctx.clearLaunched?.(this.id);
      this._flushStdout();
      const msg = signal
        ? `[面板] 服务器进程被信号 ${signal} 终止`
        : `[面板] 服务器进程已退出，退出码 ${code}`;
      this.pushLog(msg, code === 0 || signal ? 'panel' : 'err');
      this.broadcast({ type: 'state', state: 'stopped', code });
      this.tpsCache = { at: 0, value: null };
      this.tpsLastTry = 0;
      this.tpsMisses = 0;
      this._tpsProbing = false;
      this.refresh(true).catch(() => {});
    });

    child.on('spawn', () => {
      this.broadcast({ type: 'state', state: 'started', pid: child.pid });
    });

    return { pid: child.pid, command: `${cmd} ${args.join(' ')}` };
  }

  _flushStdout() {
    if (this._stdoutBuf) { this.pushLog(this._stdoutBuf, 'out'); this._stdoutBuf = ''; }
    if (this._stderrBuf) { this.pushLog(this._stderrBuf, 'err'); this._stderrBuf = ''; }
  }

  /**
   * 优雅停止：优先发 stop 指令，等进程自己在超时内退出。
   * @returns {Promise<{via:string, code:number|null}>}
   */
  async stop(timeoutMs = 120000) {
    if (this.managed) {
      this.pushLog('[面板] 发送 stop 指令，等待服务器保存并退出…', 'panel');
      this._stoppingPid = this.child.pid;
      try { this.child.stdin.write('stop\n'); } catch (e) {
        this._stoppingPid = null;
        throw new Error('写入 stdin 失败: ' + e.message);
      }
      const exited = await this.waitForExit(timeoutMs);
      if (!exited) {
        throw new Error(`等待 ${Math.round(timeoutMs / 1000)} 秒后进程仍未退出。可以用「强制结束」立即杀掉，但可能丢失未保存的数据。`);
      }
      this._stoppingPid = null;
      return { via: 'stdin', code: this.childExited ? this.childExited.code : null };
    }

    if (this.status.running) {
      if (!this.rconAvailable) {
        throw new Error(
          (this.stdinLost
            ? '面板重启过，已失去这个服务器的控制台通道，且未启用 RCON。\n'
            : '这个服务器不是面板启动的，面板无法向它的控制台发送指令。\n') +
          '方案一：在游戏里用 OP 账号执行 /stop。\n' +
          '方案二：在 server.properties 里设置 enable-rcon=true 和 rcon.password=xxx，重启服务器后面板就能接管控制台。\n' +
          '方案三：直接使用「强制结束」（有丢失存档的风险）。'
        );
      }
      // status.pid 来自每秒的状态缓存，刚启动或刚刷新过时可能还是空的，此时现查一次。
      let pid = this.status.pid;
      if (!pid) {
        const found = await this.resolveProcess(this.port, true).catch(() => ({ proc: null }));
        pid = found.proc ? found.proc.pid : null;
      }
      this._stoppingPid = pid || null;
      const res = await this.sendCommand('stop');
      // RCON 的应答只代表服务端收到了指令，JVM 还要存档再退出。不等干净就返回，
      // 紧接着的 start() 会把「仍在收尾」误判成「已在运行」而拒绝启动。
      const gone = await this.waitForGone(pid, timeoutMs);
      this._stoppingPid = null;
      if (!gone) {
        throw new Error(`已发送 stop，但等待 ${Math.round(timeoutMs / 1000)} 秒后进程仍未退出。可以用「强制结束」立即杀掉，但可能丢失未保存的数据。`);
      }
      // 进程已不在，认领记录立即作废，免得下一次刷新前还挂着 stdinLost。
      this._adoptedPid = null;
      this.ctx.clearLaunched?.(this.id);
      await this.refresh(true).catch(() => {});
      return { via: 'rcon', response: res.response };
    }
    throw new Error('服务器未在运行');
  }

  waitForExit(timeoutMs) {
    const child = this.child;
    if (!child) return Promise.resolve(true);
    return new Promise((resolve) => {
      let done = false;
      const finish = (v) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(v);
      };
      const timer = setTimeout(() => finish(false), timeoutMs);
      child.once('exit', () => finish(true));
    });
  }

  /** 进程是否仍存在。process.kill(pid,0) 不发送信号，只做存在性检查；EPERM 表示存在但无权限。 */
  _alive(pid) {
    try { process.kill(pid, 0); return true; }
    catch (e) { return e.code === 'EPERM'; }
  }

  /**
   * 等待指定进程真正消失。RCON 的 stop 只保证服务端收到了指令，JVM 存档退出还要数秒到数十秒，
   * 不等待就无法判断进程是否已经让出端口、能不能立刻重启。
   */
  async waitForGone(pid, timeoutMs = 120000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (!pid || !this._alive(pid)) return true;
      if (Date.now() >= deadline) return false;
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  /** 强制结束（taskkill /T 连子进程一起杀） */
  async kill() {
    const pid = this.child?.pid || this.status.pid;
    if (!pid) throw new Error('没有找到该服务器的进程');
    this.pushLog(`[面板] 强制结束进程 ${pid}`, 'panel');
    await new Promise((resolve, reject) => {
      const { execFile } = require('child_process');
      execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, (err, _o, stderr) => {
        if (err && !/not found|没有找到/i.test(String(stderr))) {
          return reject(new Error(String(stderr || err.message).trim()));
        }
        resolve();
      });
    });
    this.child = null;
    this._adoptedPid = null;
    this._stoppingPid = null;
    this.ctx.clearLaunched?.(this.id);
    await new Promise((r) => setTimeout(r, 800));
    await this.refresh(true).catch(() => {});
    return { pid };
  }

  /** 发送一条控制台指令 */
  async sendCommand(cmd, { quiet = false } = {}) {
    const line = String(cmd).replace(/[\r\n]+/g, ' ').trim();
    if (!line) throw new Error('指令为空');

    if (this.managed && this.child?.stdin?.writable) {
      this.pushLog('> ' + line, 'cmd', { quiet });
      this.child.stdin.write(line + '\n');
      return { via: 'stdin' };
    }

    const cfg = this.rconConfig;
    if (cfg && this.status.running) {
      this.pushLog('> ' + line + '  (via RCON)', 'cmd', { quiet });
      const response = await rcon.exec(cfg, line);
      if (response && response.trim()) this.pushLog(response.trim(), 'rcon', { quiet });
      return { via: 'rcon', response };
    }

    if (!this.status.running) throw new Error('服务器未在运行，无法发送指令');
    throw new Error(
      '无法发送指令：该服务器不是面板启动的，且未启用 RCON。\n' +
      '在 server.properties 中设置 enable-rcon=true、rcon.password=你的密码，重启后即可通过面板控制台操作。'
    );
  }

  /**
   * 主动查询 TPS。不同服务端的指令不一样，依次试。
   * @returns {Promise<number|null>}
   */
  async probeTps(timeoutMs = 4000) {
    if (!this.status.running) return null;
    // 无指令通道则直接返回已知值（通常为 null），避免空等 超时 × 候选条数。
    if (this.commandBlocker()) return this.tpsCache.value;

    // 候选按命中概率排列。原版 tick query 自 1.20.3 起自带，覆盖 Fabric / Forge / 原版；
    // tps 只存在于 Paper 系与装过 Spark 的服务端。服务端不认的指令会立即换下一条，多列代价很低。
    const type = this.getLaunch().type;
    const PLAIN = ['tick query', 'tps'];
    const PLUGIN = ['tps', 'spark tps', 'tick query'];
    const candidates = type === 'forge' ? ['forge tps', ...PLAIN]
      : type === 'neoforge' ? ['neoforge tps', 'forge tps', ...PLAIN]
      : type === 'paper' || type === 'spigot' || type === 'purpur' || type === 'mohist'
        || type === 'arclight' || type === 'magma' || type === 'catserver' ? PLUGIN
      : PLAIN;

    for (const cmd of candidates) {
      // 每条候选各等各的。等待器须在 sendCommand() 之前挂上：RCON 响应在 sendCommand 内部即 pushLog，等返回再挂会漏掉 TPS 行。
      // wait 不能建在循环外：首条超时后其余 await 会立即拿到已 settle 的 promise，等于只试第一条。
      let done = false;
      let resolveWait = null;
      const wait = new Promise((r) => { resolveWait = r; });
      const finish = (v) => { if (!done) { done = true; resolveWait(v); } };
      const drop = () => { this.tpsProbeResolvers = this.tpsProbeResolvers.filter((f) => f !== handler); };
      const handler = (v) => { clearTimeout(timer); finish(v); };
      const timer = setTimeout(() => { drop(); finish(null); }, timeoutMs);
      this.tpsProbeResolvers.push(handler);

      let res = null;
      try {
        // quiet：轮询用的指令和回显不往控制台里丢
        res = await this.sendCommand(cmd, { quiet: true });
      } catch {
        // 发送失败（通道失去 / 服务端不认该指令），换下一条。
        clearTimeout(timer);
        drop();
        finish(null);
        continue;
      }

      // 服务端明确回「未知指令」时立即换下一条，不必空等满超时。
      if (res && typeof res.response === 'string' && /未知|Unknown|Incomplete/i.test(res.response)) {
        clearTimeout(timer);
        drop();
        finish(null);
        continue;
      }

      const v = await wait;
      if (v != null) {
        this.tpsCache = { at: Date.now(), value: v };
        this.tpsMisses = 0;
        return v;
      }
    }
    this.tpsMisses++;
    return this.tpsCache.value;
  }

  /**
   * 自动查询 TPS，由 manager 的轮询调用，不 await。查询最长等待 4 秒 × 候选条数，同步会阻塞 1 秒的状态刷新；结果随下一轮 status 广播给前端。
   * @param {number} minIntervalMs 两次主动查询的最小间隔，默认 10 秒；上限 30 秒
   */
  autoProbeTps(minIntervalMs = 10000) {
    if (this._tpsProbing) return;
    if (!this.status.running) return;
    if (this.commandBlocker()) return;
    // 面板启动的服务器走 stdin 查询，服务端会把 tick query 的整条输出（4 行）记进自己的日志。
    // 间隔取 10 秒而非 2 秒：TPS 只需「大致知道卡不卡」，2 秒一次等于每分钟 120 行日志噪音。
    // 连续多轮无值说明服务端没有 TPS 指令（原版、未装 Carpet 的 Fabric），每条候选只能等到超时，退避到 30 秒。
    // 上限 30 秒：TPS 读数再慢也不该超过半分钟，调用方传更大的值在此截断。
    const interval = Math.min(this.tpsMisses >= 3 ? 30000 : minIntervalMs, 30000);
    if (Date.now() - this.tpsLastTry < interval) return;
    this._tpsProbing = true;
    this.tpsLastTry = Date.now();
    this.probeTps().catch(() => {}).finally(() => { this._tpsProbing = false; });
  }

  /** 面板展示用连接地址，使用进程实际监听端口而非配置端口 */
  connectionInfo() {
    const port = this.status?.port || this.port;
    const ips = [];
    for (const list of Object.values(os.networkInterfaces())) {
      for (const ni of list || []) {
        if (ni.family === 'IPv4' && !ni.internal) ips.push(ni.address);
      }
    }
    return {
      port,
      configPort: this.port,
      mismatch: !!this.status?.portMismatch,
      lan: ips.map((ip) => `${ip}:${port}`),
      local: `127.0.0.1:${port}`,
    };
  }
}

module.exports = { McServer, LOG_LIMIT };
