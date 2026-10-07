'use strict';
/**
 * RS面板：HTTP 服务 + API 路由
 * 只监听 127.0.0.1（端口默认 8080，可在「高级设置」改），局域网其他机器无法访问。
 * 零第三方依赖，只用 Node 标准库。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { URL } = require('url');

const { Store, DATA_DIR } = require('./lib/store');
const { Manager } = require('./lib/manager');
const files = require('./lib/files');
const archive = require('./lib/archive');
const backup = require('./lib/backup');
const players = require('./lib/players');
const propsLib = require('./lib/props');
const launcher = require('./lib/launcher');
const { Frp } = require('./lib/frp');
const frpinstall = require('./lib/frpinstall');
const { safeResolve } = require('./lib/util');
const { HOST, DEFAULT_PORT, normalizePort, resolvePort, openBrowser, isOurPanel } = require('./lib/panelcfg');

const PUBLIC_DIR = path.join(__dirname, 'public');

// SSE 连接时首发的历史行数，与 public/app.js 控制台的渲染窗口同宽。
const SSE_LOG_BACKLOG = 1200;

// 页面心跳用长轮询：页面把这条请求挂着，挂着就说明有页面在看面板。
// 挂着的请求也让面板能立刻给它下指令（关闭自己），不必等下一次心跳。
const PAGE_HOLD_MS = 20000;
const pageWaiters = new Set();

/** 给所有挂着的页面下发一条指令 */
function tellPages(payload) {
  for (const done of [...pageWaiters]) done(payload);
}

// 关闭面板时留下的哨兵文件，托盘图标据此立即退出。
// 重启不写，托盘陪着面板换代。
const STOP_FILE = path.join(DATA_DIR, 'panel.stopping');
let stopping = false;
try { fs.rmSync(STOP_FILE, { force: true }); } catch {}

process.on('exit', () => {
  if (!stopping) return;
  try { fs.writeFileSync(STOP_FILE, String(Date.now())); } catch {}
});

/** 本地转发口随面板一起停，指向它们的隧道随之断开 */
function warnTaps() {
  let taps = [];
  try { taps = frp.runningTaps(); } catch { }
  if (!taps.length) return;
  console.log('[面板] 以下本地转发口会随面板关闭而停止，指向它们的隧道将断开：');
  for (const t of taps) {
    console.log(`       · ${t.name}  127.0.0.1:${t.listenPort} → 127.0.0.1:${t.targetPort}`);
  }
}

// 面板由 launch.js 以脱离控制台的方式拉起，需自落日志文件。
// 「格式化面板」也要用 LOG_FILE。
const panellog = require('./lib/panellog');
panellog.init();

const store = new Store();
const manager = new Manager(store);
const frp = new Frp(store, manager);
// McServer 的状态里要带上所属隧道，反向注入以免 manager 反向依赖 frp
manager.frpStatus = (id) => frp.statusFor(id);

const PORT = resolvePort(store);

// ───────────────────────── HTTP 工具 ─────────────────────────

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj, null, 2);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendError(res, e) {
  const msg = e && e.message ? e.message : String(e);
  const code = /不存在|未找到/.test(msg) ? 404 : /非法|越界|拒绝/.test(msg) ? 403 : 400;
  // conflict 供前端分流：同名文件已存在时前端弹「覆盖？」。
  sendJson(res, code, { error: msg, conflict: !!(e && e.conflict) });
}

function readBody(req, limit = 600 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const buf = await readBody(req, 32 * 1024 * 1024);
  if (!buf.length) return {};
  try { return JSON.parse(buf.toString('utf8')); }
  catch { throw new Error('请求体不是合法 JSON'); }
}

/** 后台执行耗时操作，结果经 SSE 通知前端 */
function background(server, label, fn) {
  Promise.resolve()
    .then(fn)
    .then((r) => {
      server.broadcast({ type: 'notice', level: 'ok', message: `${label} 完成` });
      return r;
    })
    .catch((e) => {
      server.broadcast({ type: 'notice', level: 'error', message: `${label} 失败：${e.message}` });
      server.pushLog(`[面板] ${label} 失败：${e.message}`, 'err');
    });
}

function requireServer(id) {
  const s = manager.get(id);
  if (!s) throw new Error('服务器不存在');
  return s;
}

// ───────────────────────── 路由 ─────────────────────────

async function route(req, res, url) {
  const p = url.pathname;
  const q = url.searchParams;
  const m = req.method;

  // ---- 静态文件 ----
  if (m === 'GET' && !p.startsWith('/api/')) {
    const rel = p === '/' ? 'index.html' : p.replace(/^\//, '');
    let abs;
    try { abs = safeResolve(PUBLIC_DIR, rel); } catch { return notFound(res); }
    if (!fs.existsSync(abs) || fs.statSync(abs).isDirectory()) return notFound(res);
    const body = fs.readFileSync(abs);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream',
      'Content-Length': body.length,
      'Cache-Control': 'no-cache',
    });
    return res.end(body);
  }

  // ---- 全局 ----
  if (p === '/api/state' && m === 'GET') {
    return sendJson(res, 200, {
      panel: panelInfo(),
      servers: manager.list().map((s) => s.status),
    });
  }

  if (p === '/api/servers' && m === 'POST') {
    const body = await readJson(req);
    if (!body.dir) throw new Error('请提供服务器目录');
    const s = manager.add({ name: body.name, dir: body.dir });
    return sendJson(res, 200, {
      server: s.status,
      launch: s.detectLaunch(true),
      stats: s.stats(),
    });
  }

  // 扫描常见位置，查找现成服务器
  if (p === '/api/discover' && m === 'GET') {
    const os = require('os');
    const home = os.homedir();
    const roots = [
      path.join(home, 'Desktop'), path.join(home, 'Documents'), path.join(home, 'Downloads'),
      'C:\\', 'D:\\', 'E:\\',
      path.join(home, 'AppData', 'Roaming', '.minecraft'),
    ].filter((r) => { try { return fs.statSync(r).isDirectory(); } catch { return false; } });

    const found = new Set();
    for (const root of roots) {
      // 只扫一层。
      let entries = [];
      try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        const dir = path.join(root, e.name);
        if (Store.looksLikeServer(dir)) found.add(dir);
      }
    }
    const known = new Set(manager.list().map((s) => path.resolve(s.dir).toLowerCase()));
    return sendJson(res, 200, {
      candidates: [...found]
        .filter((d) => !known.has(path.resolve(d).toLowerCase()))
        .map((d) => {
          const det = launcher.detect(d);
          let mods = 0;
          try { mods = fs.readdirSync(path.join(d, 'mods')).filter((f) => /\.jar$/.test(f)).length; } catch {}
          return { dir: d, name: path.basename(d), type: det.type, mods, hint: det.hint };
        }),
    });
  }

  // ---- 面板自身的设置 / 重启 / 关闭 ----

  if (p === '/api/panel' && m === 'GET') {
    return sendJson(res, 200, panelInfo());
  }

  // 页面长轮询：页面挂着这条请求，挂着就代表「有页面在看面板」
  if (p === '/api/panel/ping' && m === 'GET') {
    let settled = false;
    const done = (payload) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      pageWaiters.delete(done);
      try { sendJson(res, 200, payload); } catch {}
    };
    const timer = setTimeout(() => done({ ok: true, close: false }), PAGE_HOLD_MS);
    pageWaiters.add(done);
    const bye = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      pageWaiters.delete(done);
    };
    req.on('close', bye);
    req.on('error', bye);
    return;
  }

  // 「把面板显示出来」：有页面挂着就让它们自己关掉，调用方随后开一个新的
  // （浏览器没法把已有的标签页切到前台，只能关掉重开）
  if (p === '/api/panel/show' && m === 'GET') {
    const page = pageWaiters.size > 0;
    if (page) tellPages({ ok: true, close: true });
    return sendJson(res, 200, { page });
  }

  if (p === '/api/panel/settings' && m === 'PATCH') {
    const body = await readJson(req);
    const out = {};

    if ('port' in body) {
      const next = normalizePort(body.port);
      if (!next) throw new Error('端口必须是 1024 - 65535 之间的整数');
      const changed = next !== PORT;
      // 换端口前须确认新端口空闲。
      if (changed && !(await portAvailable(next))) {
        throw new Error(`端口 ${next} 已被其他程序占用，换一个吧`);
      }
      store.setSetting('port', next);
      out.port = next;
      out.restartRequired = changed;
    }

    if ('allowCrossSite' in body) {
      // 立即生效，无需重启面板。
      const allow = !!body.allowCrossSite;
      store.setSetting('allowCrossSite', allow);
      out.allowCrossSite = allow;
    }

    return sendJson(res, 200, { ok: true, ...out });
  }

  if (p === '/api/panel/restart' && m === 'POST') {
    // 先响应再重启。
    sendJson(res, 200, { ok: true, port: PORT });
    setTimeout(() => { relaunch(); setTimeout(() => process.exit(0), 300); }, 200);
    return;
  }

  if (p === '/api/panel/shutdown' && m === 'POST') {
    sendJson(res, 200, { ok: true });
    // 让在看面板的标签页自己关掉，托盘图标随哨兵文件一起退出
    tellPages({ ok: true, close: true });
    warnTaps();
    // 面板退出不会关闭 Minecraft 服务器进程，与点窗口 X 一致
    stopping = true;
    setTimeout(() => process.exit(0), 300);
    return;
  }

  if (p === '/api/panel/format' && m === 'POST') {
    // 将面板还原为初始状态。只删 data/ 下属于面板的内容：服务器列表、面板设置、
    // 备份 zip、面板日志。服务器目录里的存档 / 模组 / 配置不删，仅从面板「忘记」；
    // 正在运行的 Minecraft 进程也不动。
    const body = await readJson(req);
    if (String(body.confirm || '').trim() !== '格式化') {
      throw new Error('确认文本不正确，需要输入「格式化」');
    }
    store.reset();
    try { fs.rmSync(backup.BACKUP_ROOT, { recursive: true, force: true }); } catch {}
    // panel.log 无法删除，截断为空文件。
    try { fs.writeFileSync(panellog.LOG_FILE, ''); } catch {}
    try { fs.rmSync(panellog.LOG_FILE + '.1', { force: true }); } catch {}

    sendJson(res, 200, { ok: true });
    // 重启：设置已清空，新进程须按默认值启动。
    setTimeout(() => { relaunch(); setTimeout(() => process.exit(0), 300); }, 200);
    return;
  }

  // 目录浏览器（添加服务器选路径）
  if (p === '/api/browse' && m === 'GET') {
    const target = q.get('path');
    const os = require('os');
    let dir = target ? path.resolve(target) : os.homedir();
    try {
      if (!fs.statSync(dir).isDirectory()) dir = path.dirname(dir);
    } catch {
      dir = os.homedir();
    }
    const sep = path.sep;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
        .filter((e) => {
          try { return e.isDirectory() && fs.statSync(path.join(dir, e.name)).isDirectory(); }
          catch { return false; }
        })
        .map((e) => ({ name: e.name, path: path.join(dir, e.name), isServer: Store.looksLikeServer(path.join(dir, e.name)) }))
        .sort((a, b) => Number(b.isServer) - Number(a.isServer) || a.name.localeCompare(b.name, 'zh'));
    } catch (e) {
      throw new Error('无法读取目录: ' + e.message);
    }
    const parent = path.dirname(dir);
    return sendJson(res, 200, {
      path: dir,
      parent: parent === dir ? null : parent,
      sep,
      roots: process.platform === 'win32'
        ? 'CDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((d) => d + ':\\').filter((d) => { try { return fs.statSync(d).isDirectory(); } catch { return false; } })
        : ['/'],
      entries,
    });
  }

  // 任务（备份 / 还原）进度
  if (p.startsWith('/api/jobs/') && m === 'GET') {
    const job = backup.getJob(p.slice('/api/jobs/'.length));
    if (!job) throw new Error('任务不存在');
    return sendJson(res, 200, job);
  }

  // ---- FRP ----
  if (p === '/api/frp' && m === 'GET') {
    return sendJson(res, 200, await frp.overview());
  }

  if (p === '/api/frp/settings' && m === 'PATCH') {
    const body = await readJson(req);
    frp.patchSettings(body);
    return sendJson(res, 200, { ok: true, frp: frp.settingsSummary() });
  }

  // frpc.toml 顶层的 serverAddr / serverPort / auth.token
  if (p === '/api/frp/config' && m === 'PATCH') {
    const body = await readJson(req);
    const r = await frp.writeTop(body);
    return sendJson(res, 200, { ok: true, ...r, frp: frp.settingsSummary() });
  }

  if (p === '/api/frp/start' && m === 'POST') {
    return sendJson(res, 200, { ok: true, ...(await frp.start()) });
  }

  if (p === '/api/frp/stop' && m === 'POST') {
    return sendJson(res, 200, { ok: true, ...(await frp.stop()) });
  }

  if (p === '/api/frp/reload' && m === 'POST') {
    return sendJson(res, 200, { ok: true, ...(await frp.reload()) });
  }

  // 给 frpc.toml 补 [webServer] 段，供面板读逐条隧道状态
  if (p === '/api/frp/admin' && m === 'POST') {
    return sendJson(res, 200, { ok: true, ...(await frp.enableAdmin()) });
  }

  if (p === '/api/frp/download' && m === 'GET') {
    return sendJson(res, 200, { job: frpinstall.getJob() });
  }

  if (p === '/api/frp/download' && m === 'POST') {
    const body = await readJson(req);
    const set = frp.getSettings();
    const source = body.source || set.source;
    if (body.source) frp.patchSettings({ source });   // 选了就记住，哪怕这次被挡下

    // 安装会覆盖 frpc.exe；有 frpc 在跑时既会锁文件，也等于在运行的进程底下换二进制
    const st0 = await frp.processState();
    if (st0.running) {
      throw new Error(`已有 frpc 在运行（PID ${st0.pid}），面板不会去动它。请先停止它再安装。`);
    }
    const job = frpinstall.startDownload({
      mirror: set.mirror,
      version: body.version || set.version,
      frpDir: body.dir || frp.resolveDir(),
      source,
    });
    return sendJson(res, 200, { ok: true, job });
  }

  if (p === '/api/frp/proxies' && m === 'POST') {
    const body = await readJson(req);
    const proxy = await frp.createProxy(body, body.serverId || null);
    return sendJson(res, 200, { ok: true, proxy });
  }

  const fpm = p.match(/^\/api\/frp\/proxies\/([^/]+)$/);
  if (fpm && m === 'PATCH') {
    const body = await readJson(req);
    const r = await frp.updateProxy(decodeURIComponent(fpm[1]), body, body.serverId || null);
    return sendJson(res, 200, { ok: true, ...r });
  }
  if (fpm && m === 'DELETE') {
    await frp.removeProxy(decodeURIComponent(fpm[1]));
    return sendJson(res, 200, { ok: true });
  }

  // ---- 单台服务器 ----
  const sm = p.match(/^\/api\/servers\/([^/]+)(\/.*)?$/);
  if (!sm) return notFound(res);
  const server = requireServer(decodeURIComponent(sm[1]));
  const sub = sm[2] || '';

  // 该服务器对应的 FRP 隧道
  if (sub === '/frp' && m === 'GET') {
    return sendJson(res, 200, await frp.serverFrp(server.id));
  }

  if (sub === '/frp' && m === 'PUT') {
    const body = await readJson(req);
    // 已有关联（含按端口推断出来的）就地改，没有才新建
    const cur = frp.associationFor(server.id).proxy;
    if (cur) await frp.updateProxy(cur.name, body, server.id);
    else await frp.createProxy(body, server.id);
    return sendJson(res, 200, await frp.serverFrp(server.id));
  }

  if (sub === '/frp' && m === 'DELETE') {
    const { proxy } = frp.associationFor(server.id);
    if (!proxy) throw new Error('这台服务器还没有关联隧道');
    await frp.removeProxy(proxy.name);
    return sendJson(res, 200, { ok: true });
  }

  // 只改「服务器 ↔ 隧道」的关联记录，不动 frpc.toml
  if (sub === '/frp/attach' && m === 'POST') {
    const body = await readJson(req);
    return sendJson(res, 200, { ok: true, ...frp.attach(server.id, body.name || null) });
  }

  // 本地转发计数：面板自己监听并转发，绕开 frps「连接关闭才结算」。
  // 开关一次就把全部流程走完——起/停监听口、改隧道 localPort、重启 frpc。
  if (sub === '/frp/tap' && m === 'POST') {
    return sendJson(res, 200, { ok: true, ...(await frp.enableTap(server.id)) });
  }

  if (sub === '/frp/tap' && m === 'DELETE') {
    return sendJson(res, 200, { ok: true, ...(await frp.disableTap(server.id)) });
  }

  if (sub === '' && m === 'GET') {
    const status = await server.refresh(true);
    return sendJson(res, 200, {
      status,
      launch: server.detectLaunch(true),
      savedLaunch: server.entry.launch || null,
      stats: server.stats(),
      connections: server.connectionInfo(),
      rcon: { available: server.rconAvailable, enabled: String(server.prop('enable-rcon', 'false')) === 'true' },
    });
  }

  if (sub === '' && m === 'PATCH') {
    const body = await readJson(req);
    const s = manager.update(server.id, body);
    return sendJson(res, 200, { ok: true, server: s.status, launch: s.detectLaunch(true) });
  }

  if (sub === '' && m === 'DELETE') {
    await manager.remove(server.id);
    return sendJson(res, 200, { ok: true });
  }

  // ---- 生命周期 ----
  if (sub === '/start' && m === 'POST') {
    if (server.running) throw new Error('服务器已在运行');
    background(server, '启动', () => server.start());
    return sendJson(res, 200, { ok: true, message: '启动指令已发出，日志会实时显示在控制台' });
  }

  if (sub === '/stop' && m === 'POST') {
    if (!server.running) throw new Error('服务器未在运行');
    const body = await readJson(req).catch(() => ({}));
    background(server, '停止', () => server.stop(body.timeoutMs || 120000));
    return sendJson(res, 200, { ok: true, message: '正在优雅关服（发送 stop 并等待存档保存）' });
  }

  if (sub === '/restart' && m === 'POST') {
    background(server, '重启', async () => {
      // stop() 会一直等到进程真正退出，这里只需再给端口一点释放时间。
      if (server.running) await server.stop(120000);
      await new Promise((r) => setTimeout(r, 1000));
      return server.start();
    });
    return sendJson(res, 200, { ok: true, message: '正在重启' });
  }

  if (sub === '/kill' && m === 'POST') {
    background(server, '强制结束', () => server.kill());
    return sendJson(res, 200, { ok: true, message: '已强制结束进程' });
  }

  if (sub === '/command' && m === 'POST') {
    const body = await readJson(req);
    const r = await server.sendCommand(body.command);
    return sendJson(res, 200, r);
  }

  // 读不到时附 reason，区分「无指令通道」与「服务端不认该指令」。
  if (sub === '/tps' && m === 'POST') {
    const tps = await server.probeTps(6000);
    return sendJson(res, 200, {
      tps,
      reason: tps != null ? null
        : (server.commandBlocker() || '服务端没有可用的 TPS 指令（1.20.3 以下的原版服务端，或未装 Spark 的服务端）'),
    });
  }

  // ---- 日志流 ----
  if (sub === '/logs' && m === 'GET') {
    const since = Number(q.get('since') || 0);
    return sendJson(res, 200, {
      lines: server.logs.filter((l) => l.n > since),
      last: server.logSeq,
    });
  }

  if (sub === '/stream' && m === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const send = (obj) => {
      try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch {}
    };
    send({ type: 'status', data: server.status });
    send({ type: 'logs', data: server.logs.slice(-SSE_LOG_BACKLOG), last: server.logSeq });
    const unsub = server.subscribe(send);
    const ka = setInterval(() => { try { res.write(': keepalive\n\n'); } catch {} }, 15000);
    const close = () => { clearInterval(ka); unsub(); try { res.end(); } catch {} };
    req.on('close', close);
    req.on('error', close);
    return;
  }

  // ---- 日志文件浏览 ----
  if (sub === '/logfiles' && m === 'GET') {
    const out = [];
    for (const d of ['logs', 'crash-reports']) {
      const abs = path.join(server.dir, d);
      try {
        for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
          if (!e.isFile()) continue;
          const st = fs.statSync(path.join(abs, e.name));
          out.push({ rel: d + '/' + e.name, dir: d, name: e.name, size: st.size, mtime: st.mtime.toISOString() });
        }
      } catch {}
    }
    // 按文件名排序：崩溃报告整体在前，组内倒序（最新在前）。
    // numeric 倒序使日志读作 latest.log → …-4 → …-3 → …-2 → …-1。
    const rank = (d) => (d === 'crash-reports' ? 0 : 1);
    out.sort((a, b) => rank(a.dir) - rank(b.dir)
      || b.name.localeCompare(a.name, 'en', { numeric: true }));
    return sendJson(res, 200, { files: out.slice(0, 300) });
  }

  if (sub === '/logfile' && m === 'GET') {
    const rel = q.get('file');
    const abs = safeResolve(server.dir, rel);
    if (!/^(logs|crash-reports)[\\/]/.test(rel.replace(/\\/g, '/'))) {
      throw new Error('只能读取 logs/ 与 crash-reports/ 下的文件');
    }
    const buf = fs.readFileSync(abs);
    let text;
    let truncated = false;
    if (rel.toLowerCase().endsWith('.gz')) {
      text = zlib.gunzipSync(buf).toString('utf8');
    } else {
      text = buf.toString('utf8');
    }
    const maxBytes = 2 * 1024 * 1024;
    if (Buffer.byteLength(text, 'utf8') > maxBytes) {
      text = text.slice(-maxBytes);
      truncated = true;
    }
    return sendJson(res, 200, { file: rel, content: text, truncated, size: buf.length });
  }

  // ---- 文件管理 ----
  if (sub === '/files' && m === 'GET') {
    return sendJson(res, 200, files.list(server.dir, q.get('path') || ''));
  }

  if (sub === '/file' && m === 'GET') {
    return sendJson(res, 200, files.read(server.dir, q.get('path')));
  }

  if (sub === '/file' && m === 'PUT') {
    const body = await readJson(req);
    if (!body.path) throw new Error('缺少 path');
    const r = files.write(server.dir, body.path, body.content ?? '');
    server.broadcast({ type: 'notice', level: 'ok', message: `已保存 ${body.path}` });
    return sendJson(res, 200, r);
  }

  if (sub === '/file/download' && m === 'GET') {
    const rel = q.get('path');
    const { abs, size, name } = files.statForDownload(server.dir, rel);
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': size,
      'Content-Disposition': `attachment; filename="${encodeURIComponent(name)}"`,
    });
    return fs.createReadStream(abs).pipe(res);
  }

  if (sub === '/file/upload' && m === 'POST') {
    const dir = q.get('path') || '';
    const name = q.get('name');
    const buf = await readBody(req);
    const r = files.upload(server.dir, dir, name, buf);
    server.broadcast({ type: 'notice', level: 'ok', message: `已上传 ${r.path}` });
    return sendJson(res, 200, r);
  }

  if (sub === '/files/mkdir' && m === 'POST') {
    const body = await readJson(req);
    return sendJson(res, 200, files.mkdir(server.dir, body.path, body.name));
  }

  if (sub === '/files/rename' && m === 'POST') {
    const body = await readJson(req);
    return sendJson(res, 200, files.rename(server.dir, body.path, body.newName));
  }

  if (sub === '/files/delete' && m === 'POST') {
    const body = await readJson(req);
    return sendJson(res, 200, files.remove(server.dir, body.path, !!body.recursive));
  }

  // ---- 压缩 / 解压 ----
  // 只读。返回条目数、解压目标、是否有越界条目。
  if (sub === '/files/archive/preview' && m === 'POST') {
    const body = await readJson(req);
    return sendJson(res, 200, await archive.preview(server.dir, body.path, body.into ?? null));
  }

  if (sub === '/files/extract' && m === 'POST') {
    const body = await readJson(req);
    const r = await archive.extract(server.dir, body.path, body.into ?? null, { overwrite: !!body.overwrite });
    const where = r.dest ? `${r.dest}/` : '当前目录';
    const extra = r.skipped ? `，跳过 ${r.skipped} 个已存在的文件` : '';
    server.broadcast({ type: 'notice', level: 'ok', message: `已解压 ${body.path} → ${where}（${r.files} 个文件${extra}）` });
    return sendJson(res, 200, r);
  }

  if (sub === '/files/compress' && m === 'POST') {
    const body = await readJson(req);
    const r = await archive.compress(server.dir, body.path, body.name, body.out, { overwrite: !!body.overwrite });
    server.broadcast({ type: 'notice', level: 'ok', message: `已压缩 ${r.out}（${r.files} 个文件，${r.label}）` });
    return sendJson(res, 200, r);
  }

  // ---- server.properties ----
  if (sub === '/props' && m === 'GET') {
    const parsed = server.getProps(true);
    // 掩码只加在这一层。mcserver 的 getProps() 必须保留真实值。
    const items = Object.entries(parsed.map).map(([key, v]) => ({
      key,
      value: propsLib.isSecretKey(key) ? propsLib.SECRET_MASK : v.value,
      type: propsLib.inferType(key, v.value),
      description: propsLib.describe(key),
      secret: propsLib.isSecretKey(key),
    }));
    // 不再返回整份原文。
    return sendJson(res, 200, { items });
  }

  if (sub === '/props' && m === 'PUT') {
    const body = await readJson(req);
    const changes = body.changes || {};
    if (!Object.keys(changes).length) throw new Error('没有要修改的项');
    // 密码项在界面上是掩码。未改动时前端不会提交它；若仍收到掩码值，说明是原样回传，直接拒绝。
    for (const k of Object.keys(changes)) {
      if (propsLib.isSecretKey(k) && changes[k] === propsLib.SECRET_MASK) {
        throw new Error(`「${k}」未修改，请勿提交掩码值`);
      }
    }
    const text = propsLib.setMany(server._propsText || '', changes);
    fs.copyFileSync(path.join(server.dir, 'server.properties'), path.join(server.dir, 'server.properties.bak'));
    fs.writeFileSync(path.join(server.dir, 'server.properties'), text, 'utf8');
    server.getProps(true);
    const restartKeys = ['server-port', 'server-ip', 'enable-rcon', 'rcon.port', 'rcon.password',
      'enable-query', 'query.port', 'level-name', 'online-mode'];
    const needRestart = Object.keys(changes).some((k) => restartKeys.includes(k));
    return sendJson(res, 200, {
      ok: true,
      needRestart,
      message: needRestart
        ? '已保存。其中有需要重启服务器才能生效的项，请重启后再观察效果。'
        : '已保存。部分设置会在下一次世界加载时生效。',
    });
  }

  // ---- 玩家名单 ----
  if (sub === '/players' && m === 'GET') {
    return sendJson(res, 200, {
      lists: players.overview(server),
      online: server.status.players,
      offlineMode: String(server.prop('online-mode', 'true')) !== 'true',
      whitelistOn: String(server.prop('white-list', 'false')) === 'true',
    });
  }

  const pm = sub.match(/^\/players\/(whitelist|ops|banned|banned-ips)$/);
  if (pm && m === 'POST') {
    const body = await readJson(req);
    const arr = await players.add(server, pm[1], body);
    return sendJson(res, 200, { ok: true, entries: arr });
  }

  if (pm && m === 'PATCH') {
    const body = await readJson(req);
    const arr = players.update(server, pm[1], body.key, body.patch || {});
    return sendJson(res, 200, { ok: true, entries: arr });
  }

  const pd = sub.match(/^\/players\/(whitelist|ops|banned|banned-ips)\/(.+)$/);
  if (pd && m === 'DELETE') {
    const arr = players.remove(server, pd[1], decodeURIComponent(pd[2]));
    return sendJson(res, 200, { ok: true, entries: arr });
  }

  // ---- 备份 ----
  if (sub === '/backups' && m === 'GET') {
    return sendJson(res, 200, {
      backups: backup.listBackups(server.id),
      dir: path.join(backup.BACKUP_ROOT, server.id),
      leftovers: backup.listRestoreLeftovers(server),
      running: server.running,
    });
  }

  if (sub === '/backups' && m === 'POST') {
    const body = await readJson(req).catch(() => ({}));
    const job = await backup.createBackup(server, { includeMods: !!body.includeMods });
    return sendJson(res, 200, job);
  }

  if (sub === '/backups/delete' && m === 'POST') {
    const body = await readJson(req);
    return sendJson(res, 200, backup.deleteBackup(server.id, body.name));
  }

  if (sub === '/backups/restore' && m === 'POST') {
    const body = await readJson(req);
    const job = await backup.restoreBackup(server, body.name);
    return sendJson(res, 200, job);
  }

  if (sub === '/backups/download' && m === 'GET') {
    const abs = backup.backupPath(server.id, q.get('name'));
    const st = fs.statSync(abs);
    res.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Length': st.size,
      'Content-Disposition': `attachment; filename="${encodeURIComponent(path.basename(abs))}"`,
    });
    return fs.createReadStream(abs).pipe(res);
  }

  if (sub === '/leftovers/delete' && m === 'POST') {
    const body = await readJson(req);
    return sendJson(res, 200, backup.deleteLeftover(server, body.name));
  }

  return notFound(res);
}

function notFound(res) {
  sendJson(res, 404, { error: '接口不存在' });
}

// ───────────────────────── 启动 ─────────────────────────

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || HOST}`);
  // 只允许本机来源。面板无密码，这是唯一的 CSRF 防线。该检查默认开启，仅在「高级设置」显式打开
  // allowCrossSite 时放行，不得绕过。
  const origin = req.headers.origin;
  if (!store.getSetting('allowCrossSite', false)
      && origin && !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) {
    return sendJson(res, 403, { error: '拒绝跨站请求' });
  }
  route(req, res, url).catch((e) => {
    if (!res.headersSent) sendError(res, e);
    else try { res.end(); } catch {}
  });
});

/**
 * 重新拉起一个面板进程接替自己。detached + unref 使新进程脱离本进程与 start.bat 控制台窗口。
 * 继承环境变量时须摘掉 MCPANEL_OPEN：由 launch.js 起的面板带着它，直接继承会让重启后的
 * 面板再开一个浏览器标签页，而浏览器那一侧已经自己切过去了。
 */
function relaunch() {
  const { spawn } = require('child_process');
  const env = { ...process.env, MCPANEL_RESTARTED: '1' };
  delete env.MCPANEL_OPEN;
  const child = spawn(process.execPath, [__filename], {
    cwd: __dirname,
    detached: true,
    stdio: 'ignore',
    env,
  });
  child.unref();
}

function panelInfo() {
  return {
    port: PORT,
    defaultPort: DEFAULT_PORT,
    // 环境变量优先级最高，界面需提示「修改会被环境变量覆盖」
    portFromEnv: normalizePort(process.env.MCPANEL_PORT) != null,
    dataDir: DATA_DIR,
    allowCrossSite: store.getSetting('allowCrossSite', false),
    version: require('./package.json').version,
    pid: process.pid,
    logFile: panellog.LOG_FILE,
    // 供界面回填输入框，避免为了这些设置去调 /api/frp（那会做一次进程枚举）
    frp: frp.settingsSummary(),
  };
}

/** 探测端口是否空闲（试用绑定后释放） */
function portAvailable(port) {
  return new Promise((resolve) => {
    const net = require('net');
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.once('listening', () => probe.close(() => resolve(true)));
    probe.listen(port, HOST);
  });
}

// 新进程须重试，不可一遇 EADDRINUSE 即判定「面板已在运行」。
// 仅重启拉起的进程重试。
const RESTARTING = process.env.MCPANEL_RESTARTED === '1';
let bindAttempts = 0;

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    if (RESTARTING && bindAttempts++ < 24) {
      setTimeout(() => server.listen(PORT, HOST), 250);
      return;
    }
    return onPortBusy();
  }
  console.error('[!] 服务启动失败:', e.message);
  process.exit(1);
});

/** 端口被占用。正常流程不到此处。
 * 此处兜底：直接 node server.js 撞上「面板已在运行」，或两份同时启动的竞态。 */
async function onPortBusy() {
  if (await isOurPanel(PORT)) {
    console.log(`\n[·] 面板已经在 http://localhost:${PORT} 运行了。\n`);
    // 重启交接时浏览器已经自己切过去了，此处不再多开一个标签页
    if (!RESTARTING) openBrowser(`http://localhost:${PORT}`);
    setTimeout(() => process.exit(0), 500);
    return;
  }
  console.error(`\n[!] 端口 ${PORT} 已被占用，占用它的不是本面板。`);
  console.error('    可以在面板的「高级设置」里换个端口，或临时用环境变量：');
  console.error('    set MCPANEL_PORT=8081 && node server.js\n');
  process.exit(1);
}

function onListening() {
  const line = '─'.repeat(58);
  console.log(`\n${line}`);
  console.log('  RS面板 已启动');
  console.log(line);
  console.log(`  面板地址   http://localhost:${PORT}`);
  console.log(`  监听范围   ${HOST}（仅本机可访问）`);
  console.log(`  数据目录   ${DATA_DIR}`);
  console.log(`  已纳管     ${manager.list().length} 台服务器`);
  for (const s of manager.list()) {
    console.log(`             · ${s.name}  (${s.dir})`);
  }
  console.log(`${line}`);
  console.log('  关掉面板：界面左下角「关闭面板」，或直接结束本进程。');
  console.log('  注意：面板退出不会关闭已启动的 Minecraft 服务器。\n');

  // 清掉上次中断留下的下载暂存目录
  frpinstall.cleanupStale();
  frp.startSampler();

  // 仅由 launch.js 设置。重启不经此处，浏览器那一侧会自己切过去。
  if (process.env.MCPANEL_OPEN === '1' && !RESTARTING) {
    // 等一会儿：面板刚重启时，上一次那个标签页会立刻重挂长轮询，认出它就先关掉，免得留下两个
    setTimeout(() => {
      if (pageWaiters.size) {
        tellPages({ ok: true, close: true });
        console.log('  已让原来的面板标签页关闭，正在打开新的\n');
      } else {
        console.log(`  已在浏览器中打开 http://localhost:${PORT}\n`);
      }
      openBrowser(`http://localhost:${PORT}`);
    }, 1500);
  }
}

// 重启重试时同样触发该回调，抽出复用。
server.listen(PORT, HOST, onListening);

process.on('SIGINT', () => {
  const owned = manager.ownedPids();
  const frpRec = store.getSetting('frpLaunched', null);
  if (owned.length || frpRec) {
    console.log('\n[面板] 以下进程由本面板启动，退出后它们会继续运行：');
    for (const o of owned) console.log(`       · ${o.name} (PID ${o.pid})`);
    if (frpRec && frpRec.pid) console.log(`       · frpc (PID ${frpRec.pid})`);
    console.log('[面板] 如需一并停止，请在面板里点「停止」，或稍后手动结束这些 PID。');
  }
  warnTaps();
  stopping = true;
  process.exit(0);
});
