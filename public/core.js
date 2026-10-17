'use strict';
/* =========================================================================
   RS面板前端 · 基础工具 / Toast / Modal / 数据加载 / SSE / 事件委托 / 启动。
   无框架、无构建步骤，原生 JS + SVG 手绘图表。
   加载顺序：core → chart → views → panels → frp → dialogs。
   ========================================================================= */

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC_MAP[c]);

/**
 * 服务端类型的显示名。必须覆盖 launcher.js 的 JAR_RULES / detect() 可能返回的全部 type。
 */
const TYPE_LABEL = {
  forge: 'Forge', neoforge: 'NeoForge', fabric: 'Fabric', quilt: 'Quilt',
  paper: 'Paper', spigot: 'Spigot', purpur: 'Purpur',
  mohist: 'Mohist', arclight: 'Arclight', magma: 'Magma', catserver: 'CatServer',
  vanilla: '原版', jar: '可执行 jar', script: '启动脚本', unknown: '未识别',
};
const typeLabel = (t) => TYPE_LABEL[t] || t || '未识别';

/* ─────────────────────────── 状态 ─────────────────────────── */

const S = {
  panel: null,
  servers: [],
  current: null,
  tab: 'overview',
  detail: null,
  logs: [],
  lastLogN: 0,
  history: new Map(),
  sse: null,
  sseServer: null,
  filePath: '',
  fileData: null,
  props: null,
  players: null,
  backups: null,
  logFiles: null,
  openLog: null,
  autoScroll: true,      // 控制台是否锁定在日志最底端；用户往上滑即解锁
  consoleScrollTop: 0,   // 解锁时记下的位置，控制台重画后回到原处
  busy: new Set(),
  navOpen: false,    // 窄屏下的服务器列表抽屉是否打开
  sidebarIds: null,  // 侧边栏当前渲染出的服务器 id 顺序
  view: {},          // 当前标签页的 DOM 引用
  frpOv: null,       // 全局 FRP 总览，不随 tab 清空
};

/* ─────────────────── 视口 / 指针类型检测 ───────────────────
 * 对应 style.css 的两档媒体查询：NARROW 为窄屏（侧边栏变抽屉），
 * TOUCH 为触摸设备，与宽度无关（窄窗口桌面浏览器仍有鼠标）。
 * 结果写到 <html> 的 class 上，JS 和 CSS 共用。 */
const NARROW = window.matchMedia('(max-width: 860px)');
const TOUCH = window.matchMedia('(pointer: coarse)');

function applyViewportClasses() {
  const root = document.documentElement;
  root.classList.toggle('is-narrow', NARROW.matches);
  root.classList.toggle('is-touch', TOUCH.matches);
  // 变宽回桌面布局时必须收掉抽屉。
  if (!NARROW.matches) toggleSidebar(false);
}

/** 开关服务器列表抽屉。只在窄屏有意义，桌面端按钮由 CSS 隐藏。 */
function toggleSidebar(force) {
  const app = $('.app');
  if (!app) return;
  const open = force == null ? !app.classList.contains('nav-open') : !!force;
  app.classList.toggle('nav-open', open);
  S.navOpen = open;
  // 抽屉打开时锁定底层滚动
  document.body.style.overflow = open ? 'hidden' : '';
  const btn = $('.menu-btn');
  if (btn) btn.setAttribute('aria-expanded', open ? 'true' : 'false');
}

/** 窄屏左上角的抽屉开关。桌面端由 CSS 隐藏。 */
function menuButton() {
  return `<button class="menu-btn" data-action="toggle-sidebar"
    aria-label="服务器列表" aria-controls="serverList" aria-expanded="${S.navOpen}">
    <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor"
         stroke-width="1.6" stroke-linecap="round"><path d="M2.5 4h11M2.5 8h11M2.5 12h11"/></svg>
  </button>`;
}

const TABS = [
  { id: 'overview', label: '概览' },
  { id: 'console', label: '控制台' },
  { id: 'files', label: '文件' },
  { id: 'players', label: '玩家' },
  { id: 'config', label: '服务器配置' },
  { id: 'logs', label: '日志' },
  { id: 'frp', label: 'FRP 管理' },
  { id: 'backups', label: '备份' },
  { id: 'custom', label: '自定义' },
];

const HISTORY_LEN = 180;

// 与 lib/custom.js 的 MOTD_LINE_MAX / JOIN_TEXT_MAX 一致
const MOTD_LINE_MAX = 120;
const JOIN_TEXT_MAX = 200;

/* ─────────────────────────── 基础工具 ─────────────────────────── */

async function api(path, opts = {}) {
  const { method = 'GET', body, raw } = opts;
  const init = { method, headers: { 'X-McPanel': '1' } };
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  } else if (raw) {
    init.body = raw;
  }
  const res = await fetch(path, init);
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { error: text || res.statusText }; }
  if (!res.ok) {
    // 响应体挂在 error 上，调用方可按 data.conflict 这类标记分流，无需匹配错误文案。
    const err = new Error(data.error || `HTTP ${res.status}`);
    err.data = data;
    throw err;
  }
  return data;
}

function fmtBytes(n) {
  if (n == null) return '—';
  if (n === 0) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i === 0 ? 0 : 1)} ${u[i]}`;
}

/** 速率：字节/秒 */
function fmtRate(n) {
  return n == null ? '—' : fmtBytes(n) + '/s';
}

function fmtDuration(ms) {
  if (!ms || ms < 0) return '—';
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d} 天 ${h} 小时`;
  if (h) return `${h} 小时 ${m} 分`;
  if (m) return `${m} 分 ${s % 60} 秒`;
  return `${s} 秒`;
}

function fmtTime(t) {
  const d = new Date(t);
  if (isNaN(d)) return '—';
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function fmtDateTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d)) return '—';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/* ─────────────────────────── Toast / Modal ─────────────────────────── */

function toast(message, level = 'info', ms = 5000) {
  const icons = { ok: '✓', err: '✕', warn: '!', info: 'i' };
  const el = document.createElement('div');
  el.className = `toast ${level}`;
  el.innerHTML = `<span class="t-ico">${icons[level] || 'i'}</span><span>${esc(message)}</span>`;
  $('#toasts').appendChild(el);
  const kill = () => { el.style.opacity = '0'; setTimeout(() => el.remove(), 200); };
  el.addEventListener('click', kill);
  setTimeout(kill, ms);
  return el;   // 调用方可提前收掉（如解压中的提示等完成再撤）
}

// 弹窗栈：Esc 只关最上层
const modalStack = [];
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && modalStack.length) {
    e.preventDefault();
    modalStack[modalStack.length - 1]();
  }
});

function openModal({ title, body, actions = [], wide = false, autofocus = true }) {
  return new Promise((resolve) => {
    const back = document.createElement('div');
    back.className = 'modal-back';
    back.innerHTML = `
      <div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true">
        <div class="modal-head">${esc(title)}</div>
        <div class="modal-body"></div>
        <div class="modal-foot"></div>
      </div>`;
    const bodyEl = $('.modal-body', back);
    const foot = $('.modal-foot', back);
    const entry = () => close(null);
    const close = (value) => {
      back.remove();
      const i = modalStack.indexOf(entry);
      if (i >= 0) modalStack.splice(i, 1);
      resolve(value);
    };

    // body 只构造一次。函数式 body 的第二个参数是 close，弹窗可从内部关闭。
    if (typeof body === 'string') bodyEl.innerHTML = body;
    else if (typeof body === 'function') body(bodyEl, close);
    else bodyEl.appendChild(body);

    for (const a of actions) {
      const b = document.createElement('button');
      b.className = `btn ${a.variant ? 'btn-' + a.variant : ''}`;
      b.textContent = a.label;
      // value 可以是函数：在主按钮点击、弹窗尚未拆除时从表单取值。
      b.onclick = () => {
        if (typeof a.value === 'function') {
          let v;
          try { v = a.value(bodyEl); } catch (err) { toast(err.message, 'err', 8000); return; }
          close(v);
        } else {
          close(a.value);
        }
      };
      foot.appendChild(b);
    }
    modalStack.push(entry);
    back.addEventListener('mousedown', (e) => { if (e.target === back) close(null); });
    $('#modalRoot').appendChild(back);
    // 自动聚焦第一个输入框。autofocus=false 用于输入不是主题的弹窗。
    const first = autofocus ? $('input, textarea, select', bodyEl) : null;
    if (first) setTimeout(() => first.focus(), 30);
  });
}

/** 危险操作确认。requireText 要求原样输入指定文本才放行；取值在弹窗挂载时进行。 */
function confirmDanger({ title, message, detail, confirmLabel = '确认执行', requireText, tone = 'danger' }) {
  // tone='info' 用于不可逆但不危险的动作（如重启面板）。
  const boxCls = tone === 'danger' ? 'danger-box' : 'note-box';
  const btnVariant = tone === 'danger' ? 'danger' : 'primary';
  return openModal({
    title,
    body: `
      <div class="${boxCls}">${esc(message)}</div>
      ${detail ? `<div class="muted" style="font-size:12.5px;line-height:1.7">${detail}</div>` : ''}
      ${requireText ? `<div class="field" style="margin-top:14px">
        <label>请输入 <b class="mono">${esc(requireText)}</b> 以确认</label>
        <input class="input mono" data-confirm-text autocomplete="off">
      </div>` : ''}`,
    actions: [
      { label: '取消', value: false },
      {
        label: confirmLabel,
        variant: btnVariant,
        value: (el) => {
          if (!requireText) return true;
          const typed = el.querySelector('[data-confirm-text]')?.value?.trim();
          if (typed !== requireText) {
            throw new Error(`确认文本不匹配，需要输入「${requireText}」`);
          }
          return true;
        },
      },
    ],
  }).then((v) => v === true);
}

/* ─────────────────────────── 数据加载 ─────────────────────────── */

async function loadState() {
  const r = await api('/api/state');
  S.panel = r.panel;
  S.servers = r.servers;
  renderPanelInfo();
  renderSidebar();
  renderHeader();
  renderTabs();
}

async function loadDetail(id) {
  const d = await api(`/api/servers/${id}`);
  if (S.current !== id) return;
  S.detail = d;
}

async function selectServer(id) {
  S.current = id;
  S.tab = 'overview';
  S.filePath = '';
  S.openLog = null;
  // 换一台服务器就是新的一份日志，控制台回到「锁定最底端」的默认状态
  S.autoScroll = true;
  S.consoleScrollTop = 0;
  // 各标签页缓存都在 S.view，清空它即可；置空前先销毁图表
  destroyView();
  S.view = {};
  // 复用已有 SSE 连接时保留日志缓冲
  if (connectSse(id)) {
    S.logs = [];
    S.lastLogN = 0;
  }
  renderSidebar();
  renderHeader();
  renderTabs();
  $('#content').innerHTML = '<div class="empty">正在加载…</div>';
  try {
    await Promise.all([loadDetail(id), loadState()]);
    renderTab();
  } catch (e) {
    toast(e.message, 'err');
  }
}

/* ─────────────────────────── 页面心跳（长轮询） ─────────────────────────── */

/**
 * 把心跳请求一直挂在面板上，挂着就代表「这个页面在看面板」。
 * 双击 start.bat 或点托盘时，面板会顺着这条挂着的请求让旧标签页自己关掉，再开一个新的
 * ——浏览器没法把已有的标签页切到前台，只能关掉重开。
 */
let titleTimer = null;

function closeSelf() {
  window.close();
  // 浏览器只允许「历史只有一条」的标签页自关；关不掉就退而求其次，闪标题让人找得到
  setTimeout(() => {
    if (window.closed) return;
    const orig = document.title;
    if (titleTimer) clearInterval(titleTimer);
    let on = true;
    let n = 0;
    titleTimer = setInterval(() => {
      document.title = on ? '● ' + orig : orig;
      on = !on;
      if (++n > 9) { clearInterval(titleTimer); titleTimer = null; document.title = orig; }
    }, 350);
    toast('这个标签页关不掉，请手动关闭', 'warn', 6000);
  }, 800);
}

async function holdPing() {
  for (;;) {
    let r = null;
    try {
      r = await api('/api/panel/ping');
    } catch {}
    if (r && r.close) { closeSelf(); return; }
    // 断开时快点重挂，免得面板以为没人在看
    if (!r) await new Promise((res) => setTimeout(res, 1200));
  }
}

holdPing();

/* ─────────────────────────── SSE ─────────────────────────── */

/** 连接该服务器的 SSE；已连上则复用。返回是否新建了连接。 */
function connectSse(id) {
  // 已放弃的流不能复用
  if (S.sse && S.sseServer === id && S.sse.readyState !== EventSource.CLOSED) return false;
  if (S.sse) { S.sse.close(); S.sse = null; }
  S.sseServer = id;
  const es = new EventSource(`/api/servers/${id}/stream`);
  S.sse = es;

  es.onmessage = (ev) => {
    // 旧流已入队的 message 不得写进新服的 UI
    if (S.current !== id) return;
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.type === 'logs') {
      S.logs = msg.data || [];
      S.lastLogN = msg.last || 0;
      if (S.tab === 'console') renderTab();
      return;
    }
    if (msg.type === 'log') {
      S.lastLogN = Math.max(S.lastLogN, msg.data.n);
      appendLog(msg.data);
      return;
    }
    if (msg.type === 'status') {
      const idx = S.servers.findIndex((x) => x.id === id);
      if (idx >= 0) S.servers[idx] = msg.data;
      else S.servers.push(msg.data);
      recordHistory(msg.data);
      renderSidebar();
      renderHeader();
      if (S.tab === 'overview') updateOverview(msg.data);
      if (S.tab === 'players') {
        const p = S.view.players;
        if (p && p.online.online !== msg.data.players.online) {
          api(`/api/servers/${S.current}/players`).then((r) => {
            S.view.players = r;
            if (S.tab === 'players') renderTab();
          }).catch(() => {});
        }
      }
      return;
    }
    if (msg.type === 'joinmsg') {
      // 只更新统计行，不整页重画（会把正在编辑的输入框冲掉）
      if (S.view.custom) S.view.custom.joinMsg = { ...S.view.custom.joinMsg, ...msg.data };
      const el = $('#joinStats');
      if (el) el.innerHTML = joinStatsHTML(msg.data);
      return;
    }
    if (msg.type === 'notice') {
      toast(msg.message, msg.level === 'error' ? 'err' : 'ok', msg.level === 'error' ? 12000 : 5000);
      S.busy.clear();
      renderHeader();
      return;
    }
    if (msg.type === 'state') {
      S.busy.clear();
      renderHeader();
    }
  };

  es.onerror = () => {
    // EventSource 会自行重连，面板重启后自动恢复
  };
  return true;
}

/* ─────────────────────────── 事件委托 ─────────────────────────── */

document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const a = el.dataset.action;
  const st = currentStatus();

  // 窄屏下点抽屉里的任何按钮都收起抽屉。
  // 关闭按钮与遮罩本身走 toggle-sidebar，是收起动作，不在此列。
  if (NARROW.matches && a !== 'toggle-sidebar' && el.closest('.sidebar')) toggleSidebar(false);

  try {
    switch (a) {
      case 'toggle-sidebar': return toggleSidebar();
      case 'select-server': return selectServer(el.dataset.id);
      // 行尾图标按钮是 .server-item 的兄弟节点而非子节点，无需拦截事件。
      case 'rename-server': return renameServer(el.dataset.id);
      case 'tab':
        S.tab = el.dataset.tab;
        renderTabs();
        renderTab();
        return;
      case 'panel-restart': return restartPanel();
      case 'panel-shutdown': return shutdownPanel();
      case 'panel-settings': return openPanelSettings();
      case 'frp-custom-dir': return openPanelSettings({ flash: 'frp-setup' });
      case 'add-server': return addServerFlow();
      case 'discover': {
        const r = await api('/api/discover');
        await openModal({
          title: '自动扫描结果',
          // 绑定在弹窗存续期间完成
          body: (el, close) => {
            el.innerHTML = r.candidates.length
              ? `<div class="muted" style="font-size:12.5px;margin-bottom:10px">在常见位置找到 ${r.candidates.length} 个服务器：</div>
                 ${r.candidates.map((c) => `<div class="dir-item" style="cursor:default">
                   ${fileIcon('dir')}
                   <div style="flex:1;min-width:0">
                     <div>${esc(c.name)}</div>
                     <div class="muted mono" style="font-size:11px;overflow:hidden;text-overflow:ellipsis">${esc(c.dir)}</div>
                   </div>
                   <button class="btn btn-sm btn-primary" data-quickadd="${esc(c.dir)}">添加</button>
                 </div>`).join('')}`
              : '<div class="muted">没有找到现成的服务器目录。可以手动指定路径添加。</div>';
            // 委托挂在 el 上
            el.addEventListener('click', async (e) => {
              const b = e.target.closest('[data-quickadd]');
              if (!b) return;
              try {
                const r2 = await api('/api/servers', { method: 'POST', body: { dir: b.dataset.quickadd } });
                toast(`已添加 ${r2.server.name}`, 'ok');
                close(null);   // 移除、resolve 并解绑 keydown
                await loadState();
                await selectServer(r2.server.id);
              } catch (err) { toast(err.message, 'err'); }
            });
          },
          actions: [{ label: '关闭', value: null }],
          wide: true,
        });
        return;
      }
      case 'start': case 'stop': case 'restart': case 'kill': return serverAction(a);
      case 'remove-server': return removeServer(el.dataset.id);
      case 'frp-pick-dir': return frpPickDir();
      case 'frp-download': return frpDownload();
      case 'frp-start': return frpProc('start', 'frpc 已启动');
      case 'frp-stop': return frpProc('stop', 'frpc 已停止');
      case 'frp-reload': return frpProc('reload', '已请求重载');
      case 'frp-save-proxy': return frpSaveProxy();
      case 'frp-tap-toggle': return frpTapToggle();
      case 'frp-tap-guide': return frpTapGuide();
      case 'frp-tap-connect': return frpTapConnect();
      case 'frp-del-proxy': return frpDelProxy();
      case 'frp-open-settings': return openFrpSettings();
      case 'frp-enable-admin': return frpEnableAdmin();
      case 'reload-detail':
        await loadDetail(S.current);
        renderTab();
        toast('已刷新', 'ok');
        return;
      case 'open-launch-settings': return openLaunchSettings();
      case 'quick-cmd': {
        const input = $('#consoleInput');
        if (input) { input.value = el.dataset.cmd; input.focus(); }
        return sendConsole();
      }
      case 'send-cmd': return sendConsole();
      case 'clear-console': return clearConsole();
      case 'console-jump': return jumpConsoleBottom();
      case 'nav-dir': return loadFiles(el.dataset.path);
      case 'jump-parent': return loadFiles(S.view.files.parent ?? '');
      case 'open-file': return openFile(el.dataset.path);
      case 'close-file': return loadFiles(S.filePath).catch((e) => toast(e.message, 'err'));
      case 'save-file': return saveFile(el.dataset.path);
      case 'revert-file': return openFile(el.dataset.path);
      case 'download': {
        window.location.href = `/api/servers/${S.current}/file/download?path=${encodeURIComponent(el.dataset.path)}`;
        return;
      }
      case 'mkdir': {
        const name = await openModal({
          title: '新建文件夹',
          body: `<div class="field mb0"><label>文件夹名</label><input class="input" data-mk autocomplete="off"></div>`,
          actions: [
            { label: '取消', value: null },
            {
              label: '创建',
              variant: 'primary',
              value: (elm) => {
                const v = elm.querySelector('[data-mk]').value.trim();
                if (!v) throw new Error('请填写文件夹名');
                return v;
              },
            },
          ],
        });
        if (!name) return;
        await api(`/api/servers/${S.current}/files/mkdir`, { method: 'POST', body: { path: S.filePath, name } });
        toast('已创建', 'ok');
        return loadFiles(S.filePath);
      }
      case 'rename': {
        const newName = await openModal({
          title: '重命名',
          body: `<div class="field mb0"><label>新名称</label><input class="input" data-rn value="${esc(el.dataset.name)}" autocomplete="off"></div>`,
          actions: [
            { label: '取消', value: null },
            {
              label: '重命名',
              variant: 'primary',
              value: (elm) => {
                const v = elm.querySelector('[data-rn]').value.trim();
                if (!v) throw new Error('请填写新名称');
                return v;
              },
            },
          ],
        });
        if (!newName || newName === el.dataset.name) return;
        await api(`/api/servers/${S.current}/files/rename`, { method: 'POST', body: { path: el.dataset.path, newName } });
        toast('已重命名', 'ok');
        return loadFiles(S.filePath);
      }
      case 'delete': {
        const isDir = el.dataset.dir === 'true';
        const ok = await confirmDanger({
          title: isDir ? '删除文件夹' : '删除文件',
          message: isDir
            ? '将递归删除该文件夹及其全部内容，无法撤销。'
            : '将永久删除该文件，无法撤销。',
          detail: `<span class="mono">${esc(el.dataset.path)}</span>`,
          confirmLabel: '删除',
          requireText: isDir ? el.dataset.name : undefined,
        });
        if (!ok) return toast('已取消（确认文本不匹配或用户取消）', 'warn');
        await api(`/api/servers/${S.current}/files/delete`, { method: 'POST', body: { path: el.dataset.path, recursive: isDir } });
        toast('已删除', 'ok');
        return loadFiles(S.filePath);
      }
      case 'zip': return zipEntry(el.dataset.name);
      case 'unzip': return unzipEntry(el.dataset.path, el.dataset.name);
      case 'upload': {
        const input = document.createElement('input');
        input.type = 'file';
        input.multiple = true;
        input.onchange = () => uploadFiles([...input.files].map((f) => ({ file: f, rel: f.name })));
        input.click();
        return;
      }
      case 'add-player': return addPlayer(el.dataset.kind);
      case 'del-player': {
        const ok = await confirmDanger({
          title: '从名单中移除',
          message: '仅从 json 名单文件中移除该条目，不影响玩家当前的游戏数据。',
          detail: `<b>${esc(el.dataset.key)}</b>`,
          confirmLabel: '移除',
        });
        if (!ok) return;
        await api(`/api/servers/${S.current}/players/${el.dataset.kind}/${encodeURIComponent(el.dataset.key)}`, { method: 'DELETE' });
        toast('已移除', 'ok');
        S.view.players = null;
        return renderTab();
      }
      case 'player-cmd': {
        const cmd = el.dataset.cmd;
        const ok = await confirmDanger({
          title: '执行游戏指令',
          message: `将在服务器控制台执行：${cmd}`,
          confirmLabel: '执行',
        });
        if (!ok) return;
        await api(`/api/servers/${S.current}/command`, { method: 'POST', body: { command: cmd } });
        toast(`已执行：${cmd}`, 'ok');
        return;
      }
      case 'save-props': return saveProps();
      case 'save-motd': return saveMotd();
      case 'save-join-msg': return saveJoinMsg();
      case 'icon-upload': return $('#iconInput')?.click();
      case 'icon-remove': return removeIcon();
      case 'open-props-raw': {
        S.tab = 'files';
        renderTabs();
        return openFile('server.properties');
      }
      case 'open-log': {
        const id = S.current;
        const r = await api(`/api/servers/${id}/logfile?file=${encodeURIComponent(el.dataset.file)}`);
        if (S.current !== id) return;
        S.openLog = r;
        return renderTab();
      }
      case 'close-log': {
        S.openLog = null;
        return renderTab();
      }
      case 'log-more': {
        if (!S.openLogPaint) return;
        S.openLogPos = Math.max(0, S.openLogPos - 300 * 1024);
        S.openLogPaint();
        return;
      }
      case 'files-more': {
        S.view.filesLimit = (S.view.filesLimit || 200) + 200;
        return renderTab();
      }
      case 'new-backup': {
        const includeMods = $('#bkMods')?.checked;
        const ok = await openModal({
          title: '创建备份',
          body: `<div class="warn-box">备份世界存档可能需要几分钟（取决于存档大小），期间请不要关闭面板。</div>
                 <div class="muted" style="font-size:12.5px">${includeMods
                   ? '将包含 world + mods + config，体积会大很多。'
                   : '将包含 world 存档与核心配置文件。'}</div>`,
          actions: [{ label: '取消', value: null }, { label: '开始备份', value: 'ok', variant: 'primary' }],
        });
        if (ok !== 'ok') return;
        toast('备份中，完成后会通知…', 'info', 20000);
        const job = await api(`/api/servers/${S.current}/backups`, { method: 'POST', body: { includeMods } });
        if (job.status === 'done') toast(`备份完成：${job.files} 个文件，${fmtBytes(job.bytes)}`, 'ok', 8000);
        else toast('备份失败：' + job.error, 'err', 12000);
        S.view.backups = null;
        return renderTab();
      }
      case 'restore-backup': {
        const ok = await confirmDanger({
          title: '还原存档',
          message: '这会把当前世界替换成备份里的版本。当前世界会先被改名保留，但仍请确认你选对了备份。',
          detail: `<span class="mono">${esc(el.dataset.name)}</span>`,
          confirmLabel: '还原',
          requireText: 'restore',
        });
        if (!ok) return toast('已取消（需要输入 restore 确认）', 'warn');
        const job = await api(`/api/servers/${S.current}/backups/restore`, { method: 'POST', body: { name: el.dataset.name } });
        if (job.status === 'done') toast('还原完成，启动服务器即可看到效果', 'ok', 9000);
        else toast('还原失败：' + job.error, 'err', 14000);
        S.view.backups = null;
        return renderTab();
      }
      case 'download-backup':
        window.location.href = `/api/servers/${S.current}/backups/download?name=${encodeURIComponent(el.dataset.name)}`;
        return;
      case 'del-backup': {
        const ok = await confirmDanger({
          title: '删除备份',
          message: '备份文件将被永久删除，无法恢复。',
          detail: `<span class="mono">${esc(el.dataset.name)}</span>`,
          confirmLabel: '删除',
        });
        if (!ok) return;
        await api(`/api/servers/${S.current}/backups/delete`, { method: 'POST', body: { name: el.dataset.name } });
        toast('已删除', 'ok');
        S.view.backups = null;
        return renderTab();
      }
      case 'del-leftover': {
        const ok = await confirmDanger({
          title: '删除旧存档',
          message: '这是上一次还原时保留下来的存档目录，删除后无法恢复。',
          detail: `<span class="mono">${esc(el.dataset.name)}</span>`,
          confirmLabel: '删除',
          requireText: el.dataset.name,
        });
        if (!ok) return;
        await api(`/api/servers/${S.current}/leftovers/delete`, { method: 'POST', body: { name: el.dataset.name } });
        toast('已删除', 'ok');
        S.view.backups = null;
        return renderTab();
      }
      default: return;
    }
  } catch (err) {
    toast(err.message, 'err', 12000);
  }
});

/* ─────────────────────────── 主题 / 启动 ─────────────────────────── */

function initTheme() {
  const saved = localStorage.getItem('mcpanel-theme');
  if (saved) document.documentElement.dataset.theme = saved;
  applyAccent(localStorage.getItem('mcpanel-accent') || 'green');
}

async function boot() {
  initTheme();
  // 视口/指针检测须在首次渲染前就位：抽屉初始状态与触摸专属样式都依赖 <html> 的 class。
  applyViewportClasses();
  // 跨断点时样式与空状态文案都要切换（手机端只有一句「请在电脑上添加服务器」）。
  // 无服务器时需重画，其余情况布局由 CSS 处理。
  const onBreakpoint = () => {
    applyViewportClasses();
    if (!S.servers.length) renderTab();
  };
  NARROW.addEventListener('change', onBreakpoint);
  TOUCH.addEventListener('change', applyViewportClasses);
  // Esc 关闭抽屉。手机端用不到，外接键盘场景需要。
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && S.navOpen) toggleSidebar(false);
  });
  // 转屏后宽度可能跨过断点，重算一次
  window.addEventListener('orientationchange', () => setTimeout(applyViewportClasses, 120));
  try {
    await loadState();
    if (S.servers.length) await selectServer(S.servers[0].id);
    else { renderTab(); }
  } catch (e) {
    toast('无法连接面板服务：' + e.message, 'err', 20000);
  }
  renderPanelInfo();
}
