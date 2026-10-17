'use strict';
/* =========================================================================
   RS面板前端 · 状态派生 / 外壳 / 主题 / 标签分发 / 概览 / 日志 / 备份。无框架、无构建步骤，原生 JS + SVG 手绘图表。
   加载顺序：core → chart → views → panels → frp → dialogs。
   ========================================================================= */
/* ─────────────────────────── 状态派生 ─────────────────────────── */

function currentServer() { return S.current; }
function currentStatus() {
  return S.servers.find((x) => x.id === S.current) || null;
}

function statusClass(st) {
  if (!st) return 'off';
  if (st.error) return 'err';
  if (st.running && !st.online) return 'warn';
  if (st.running) return 'on';
  return 'off';
}

function statusText(st) {
  if (!st) return '未知';
  if (st.synced === false) return '同步中';
  if (st.error && !st.running) return '异常';
  if (st.running && !st.online) return '启动中';
  if (st.running) return '运行中';
  return '已停止';
}

function recordHistory(st) {
  if (!st) return;
  let h = S.history.get(st.id);
  if (!h) {
    h = { t: [], mem: [], cpu: [], players: [], frpIn: [], frpOut: [] };
    S.history.set(st.id, h);
  }
  const last = h.t[h.t.length - 1];
  if (last && Date.now() - last < 900) return;
  const mem = st.running ? memStats(st).usedMb : 0;
  const cpu = st.running ? (st.cpu || 0) : 0;
  const players = st.running ? st.players.online : 0;
  const fin = st.frp && st.frp.rateIn != null ? st.frp.rateIn : 0;
  const fout = st.frp && st.frp.rateOut != null ? st.frp.rateOut : 0;
  // 五条序列都没变就不记点，图不再每秒空转重画
  const n = h.t.length;
  if (n && h.mem[n - 1] === mem && h.cpu[n - 1] === cpu && h.players[n - 1] === players
    && h.frpIn[n - 1] === fin && h.frpOut[n - 1] === fout) return;
  h.t.push(Date.now());
  h.mem.push(mem);
  h.cpu.push(cpu);
  h.players.push(players);
  h.frpIn.push(fin);
  h.frpOut.push(fout);
  while (h.t.length > HISTORY_LEN) {
    h.t.shift(); h.mem.shift(); h.cpu.shift(); h.players.shift();
    h.frpIn.shift(); h.frpOut.shift();
  }
}

/* ─────────────────────────── 渲染：外壳 ─────────────────────────── */

/** 侧边栏行的副标题文案。 */
function serverMeta(st) {
  if (st.synced === false) return '同步中…';
  if (st.running) return `${st.players.online}/${st.players.max} 人 · ${Math.round(st.cpu || 0)}%`;
  return st.port ? `端口 ${st.port}` : '已停止';
}

/** KPI 状态行下方的运行时长文案 */
function uptimeText(st) {
  if (st.synced === false) return '同步中';
  return st.running ? '已运行 ' + fmtDuration(st.uptimeMs) : '进程未运行';
}

function serverRowHTML(st) {
  // 行尾图标按钮置于 .server-item 之外的定位层，悬停整行时浮在右侧。
  return `<div class="server-item-wrap" data-row="${esc(st.id)}">
      <button class="server-item ${st.id === S.current ? 'active' : ''}" data-action="select-server" data-id="${esc(st.id)}">
        <span class="status-dot ${statusClass(st)}"></span>
        <span class="server-item-body">
          <span class="server-item-name">${esc(st.name)}</span>
          <span class="server-item-meta">${esc(serverMeta(st))}</span>
        </span>
      </button>
      <div class="server-acts">
        <button class="server-act" data-action="rename-server" data-id="${esc(st.id)}"
                title="重命名（只改面板里的显示名）" aria-label="重命名服务器">
          <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor"
               stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M11.5 2.5l2 2-8 8-2.5.5.5-2.5z"/><path d="M10 4l2 2"/>
          </svg>
        </button>
        <button class="server-act danger" data-action="remove-server" data-id="${esc(st.id)}"
                title="从面板移除（磁盘文件不动）" aria-label="移除服务器">
          <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor"
               stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M2.5 4.5h11"/>
            <path d="M6.8 4.5V3.2a1 1 0 0 1 1-1h.4a1 1 0 0 1 1 1v1.3"/>
            <path d="M4.2 4.5v8.3a1.5 1.5 0 0 0 1.5 1.5h4.6a1.5 1.5 0 0 0 1.5-1.5V4.5"/>
            <path d="M6.8 7.3v4.1M9.2 7.3v4.1"/>
          </svg>
        </button>
      </div>
    </div>`;
}

/** 行集合未变时就地改文案与状态类。 */
function patchSidebar(list) {
  for (const st of S.servers) {
    const row = list.querySelector(`[data-row="${CSS.escape(st.id)}"]`);
    if (!row) return false;
    row.querySelector('.server-item').classList.toggle('active', st.id === S.current);
    row.querySelector('.status-dot').className = `status-dot ${statusClass(st)}`;
    row.querySelector('.server-item-name').textContent = st.name;
    row.querySelector('.server-item-meta').textContent = serverMeta(st);
  }
  return true;
}

function renderSidebar() {
  const list = $('#serverList');
  if (!S.servers.length) {
    list.innerHTML = `<div class="muted" style="padding:10px 12px;font-size:12.5px;line-height:1.7">
      还没有添加服务器。<br>点下面的按钮开始。</div>`;
    S.sidebarIds = null;
    return;
  }
  const ids = S.servers.map((s) => s.id);
  const sameSet = S.sidebarIds && ids.length === S.sidebarIds.length
    && ids.every((id, i) => id === S.sidebarIds[i]);
  if (sameSet && patchSidebar(list)) return;
  list.innerHTML = S.servers.map(serverRowHTML).join('');
  S.sidebarIds = ids;
}

/** 重命名侧边栏服务器。只改 panel.json 的 name 字段，不触碰服务器目录与启动配置。 */
async function renameServer(id) {
  const st = (S.servers || []).find((s) => s.id === id);
  if (!st) return;

  const name = await openModal({
    title: '重命名',
    body: `
      <div class="field" style="margin-bottom:0">
        <label>显示名称</label>
        <input class="input" data-name value="${esc(st.name)}" maxlength="60" autocomplete="off">
        <div class="desc">只是面板里显示的名字。<b>不会</b>改动服务器目录、存档或启动配置。</div>
      </div>`,
    actions: [
      { label: '取消', value: null },
      { label: '保存', variant: 'primary', value: (el) => el.querySelector('[data-name]').value.trim() },
    ],
  });
  if (name == null) return;
  if (!name) return toast('名称不能为空', 'err', 4000);
  if (name === st.name) return;

  try {
    await api(`/api/servers/${id}`, { method: 'PATCH', body: { name } });
  } catch (e) {
    return toast(e.message, 'err', 8000);
  }
  // 就地改这一条并重画，不走 loadState()。
  st.name = name;
  renderSidebar();
  renderHeader();
  toast('已重命名', 'ok', 2000);
}

function renderHeader() {
  const el = $('#serverHeader');
  const st = currentStatus();
  if (!st) {
    // 未选中服务器时抽屉开关更必要。
    if (S._headerSig !== 'none') {
      S._headerSig = 'none';
      el.innerHTML = `${menuButton()}<div class="server-title"><h1>RS面板</h1></div>`;
    }
    return;
  }
  const cls = statusClass(st);
  const canStart = !st.running;
  const canStop = st.running;
  // 脏检查：状态与按钮集合没变就不重建，busy 动画不再每秒重播
  const sig = [st.id, st.name, cls, statusText(st), canStart, canStop, ...S.busy].join('|');
  if (S._headerSig === sig) return;
  S._headerSig = sig;
  const actions = [];
  if (canStart) actions.push(`<button class="btn btn-primary" data-action="start">${S.busy.has('start') ? '<span class="spin">◐</span> ' : ''}启动</button>`);
  if (canStop) {
    actions.push(`<button class="btn btn-primary" data-action="stop">${S.busy.has('stop') ? '<span class="spin">◐</span> ' : ''}停止</button>`);
    actions.push(`<button class="btn" data-action="restart">重启</button>`);
    actions.push(`<button class="btn btn-danger" data-action="kill">强制结束</button>`);
  }

  el.innerHTML = `
    ${menuButton()}
    <div class="server-title">
      <span class="pill ${cls}">${statusText(st)}</span>
      <h1>${esc(st.name)}</h1>
    </div>
    <div class="server-path" title="${esc(st.dir || '')}">${esc(st.dir || '')}</div>
    <div class="header-actions">${actions.join('')}</div>`;
}

function renderTabs() {
  const el = $('#tabs');
  if (!currentStatus()) { el.innerHTML = ''; return; }
  el.innerHTML = TABS.map((t) => `
    <button class="tab ${t.id === S.tab ? 'active' : ''}" data-action="tab" data-tab="${t.id}">${t.label}</button>
  `).join('');
  // 用 scrollIntoView({block:'nearest'}) 只横向挪动标签栏，不连带滚动页面。
  const active = el.querySelector('.tab.active');
  if (active) active.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

function renderPanelInfo() {
  const el = $('#panelInfo');
  if (!S.panel) { el.innerHTML = ''; return; }
  el.innerHTML = `
    <div class="panel-meta">
      <div>面板 v${esc(S.panel.version)} · 端口 <span class="mono">${esc(S.panel.port)}</span></div>
      <div>仅限本机访问 · 数据存于 data/</div>
    </div>
    <div class="panel-actions">
      <button class="btn btn-sm btn-ghost" data-action="panel-restart" title="重启面板进程，正在运行的 Minecraft 服务器不受影响">重启面板</button>
      <button class="btn btn-sm btn-ghost" data-action="panel-shutdown" title="只关闭面板本身，不会关闭 Minecraft 服务器">关闭面板</button>
      <button class="btn btn-sm btn-ghost" data-action="panel-settings">高级设置</button>
    </div>`;
}

/* ── 主题 ─────────────────────────────────────────────────────
 * 明暗模式 + 主题色，均只存浏览器本地（localStorage），不写入服务端的 panel.json。
 */

const ACCENTS = [
  { id: 'green', label: '原版绿', color: '#1baf7a', ink: '#04150f' },
  { id: 'blue', label: '海洋蓝', color: '#2a78d6', ink: '#ffffff' },
  { id: 'violet', label: '紫水晶', color: '#8b5cf6', ink: '#ffffff' },
  { id: 'coral', label: '熔岩橙', color: '#ec835a', ink: '#1a0a04' },
  { id: 'rose', label: '樱花粉', color: '#e0609a', ink: '#ffffff' },
  { id: 'slate', label: '石灰青', color: '#5b7c88', ink: '#ffffff' },
];

function accentById(id) {
  return ACCENTS.find((a) => a.id === id) || ACCENTS[0];
}

/** 把主题色写到 :root，覆盖 style.css 的默认值 */
function applyAccent(id) {
  const a = accentById(id);
  document.documentElement.style.setProperty('--accent', a.color);
  document.documentElement.style.setProperty('--accent-ink', a.ink);
}

function setTheme(mode) {
  document.documentElement.dataset.theme = mode;
  localStorage.setItem('mcpanel-theme', mode);
}

function setAccent(id) {
  applyAccent(id);
  localStorage.setItem('mcpanel-accent', id);
}

/* ─────────────────────────── 标签页分发 ─────────────────────────── */

/** 销毁 S.view 里的图表（含 ResizeObserver），置空前必须先调 */
function destroyView() {
  for (const v of Object.values(S.view)) {
    if (v && typeof v.destroy === 'function') v.destroy();
  }
  // 图表重建后须立刻重画一次
  S.view._hSig = null;
}

function renderTab() {
  const content = $('#content');

  // 只销毁图表，不清空 S.view。
  destroyView();

  const st = currentStatus();
  if (!st) { content.innerHTML = emptyState(); return; }

  if (S.tab === 'overview') return renderOverview(content, st);
  if (S.tab === 'console') return renderConsole(content, st);
  if (S.tab === 'files') return renderFiles(content, st);
  if (S.tab === 'players') return renderPlayers(content, st);
  if (S.tab === 'config') return renderConfig(content, st);
  if (S.tab === 'custom') return renderCustom(content, st);
  if (S.tab === 'logs') return renderLogs(content, st);
  if (S.tab === 'frp') return renderFrp(content, st);
  if (S.tab === 'backups') return renderBackups(content, st);
}

function emptyState() {
  // 手机端不提供添加入口。侧边栏的「添加服务器」由 CSS 隐藏，这里空列表时
  // 连「自动扫描」一起隐藏，只留一句指路文案。
  if (NARROW.matches) {
    return `<div class="empty">
      <svg width="46" height="46" viewBox="0 0 24 24" fill="var(--ink-3)" opacity=".5">${ICONS.mod}</svg>
      <h3>还没有服务器</h3>
      <p class="empty-lead">请在电脑上添加服务器。</p>
      <p class="empty-sub">手机上填不了服务端的目录路径。在电脑上打开这个面板添加一次，之后用手机就能照常管理了。</p>
    </div>`;
  }
  return `<div class="empty">
    <svg width="46" height="46" viewBox="0 0 24 24" fill="var(--ink-3)" opacity=".5">${ICONS.mod}</svg>
    <h3>还没有服务器</h3>
    <p>添加一个本地 Minecraft 服务器目录，面板会自动识别它的启动方式（Forge / Fabric / Paper / 原版），并接管状态监控与控制台。</p>
    <div class="row" style="margin-top:6px">
      <button class="btn btn-primary" data-action="add-server">添加服务器</button>
      <button class="btn" data-action="discover">自动扫描</button>
    </div>
  </div>`;
}

/* ─────────────────────────── 概览 ─────────────────────────── */

/**
 * 内存口径。优先 JVM 堆（jcmd），读不到才退回进程工作集。
 */
function memStats(st) {
  const heap = st.heap;
  if (heap && heap.used != null) {
    const limitMb = (heap.reserved || heap.committed) ? (heap.reserved || heap.committed) / 1048576 : null;
    return {
      usedMb: Number.isFinite(heap.used) ? heap.used / 1048576 : 0,
      limitMb,
      // 卡片显示「内存占用」而非「堆内存」。
      label: '内存占用',
      hintSuffix: limitMb ? ` / ${fmtBytes(limitMb * 1048576)}` : '',
      byHeap: true,
    };
  }
  // 退回工作集时不给出百分比。
  return {
    usedMb: Number.isFinite(st.mem) ? st.mem / 1048576 : 0,
    limitMb: null,
    label: '进程内存',
    hintSuffix: '',
    byHeap: false,
  };
}

/** FRP 卡片副标题：正常时是图例，异常时说明原因 */
function frpSubText(st) {
  const f = st.frp;
  if (!f || !f.attached || frpCardState(st, S.frpOv) !== 'chart') return `最近 ${HISTORY_LEN} 秒`;
  const dot = (c) => `<span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:${c};margin:0 4px 0 8px;vertical-align:middle"></span>`;
  return `${dot('var(--series-frp-up)')}上行${dot('var(--series-frp-dn)')}下行`;
}

/**
 * 网络状况卡片处于哪种状态。既决定正文内容，也用来判断要不要重画——
 * 装没装、配没配、下载进度都会让它变。
 */
function frpCardState(st, ov) {
  const f = st.frp;
  const job = (ov && ov.download && ov.download.job) || null;
  if (!f || !f.installed) {
    if (job && job.status === 'running') return 'downloading';
    return job && job.status === 'error' ? 'dl-error' : 'no-frpc';
  }
  if (!f.attached) return 'no-tunnel';
  if (f.trafficError) return 'no-traffic';
  return 'chart';
}

/** 网络状况卡片主体：画图时返回空串，其余各态返回一句状态加出口 */
function frpCardHTML(st, ov) {
  const job = (ov && ov.download && ov.download.job) || null;
  const box = (inner) => `<div class="empty" style="padding:18px 8px;line-height:1.8">${inner}</div>`;
  const btn = (label, attrs, wrapAttrs) => `<div style="margin-top:12px" ${wrapAttrs || ''}><button class="btn btn-sm" ${attrs}>${label}</button></div>`;
  // 装 frp 是桌面上的活，这一组在窄屏下整体隐藏（见 style.css 的 is-narrow 规则）
  const installBtns = `<div style="margin-top:12px" data-card="frp-install-ctl">
      <button class="btn btn-sm btn-primary" data-action="frp-download">一键下载</button>
      <button class="btn btn-sm" data-action="frp-custom-dir" style="margin-left:8px">自定义 frp 目录</button>
    </div>`;

  switch (frpCardState(st, ov)) {
    case 'downloading':
      return box(`正在下载 frp…
        <div class="meter" style="margin-top:10px"><i style="width:${job.percent || 0}%"></i></div>
        <div class="muted" style="font-size:12px">${esc(job.phase || '')}${job.total ? ` · ${fmtBytes(job.received)} / ${fmtBytes(job.total)}` : ''}</div>`);
    case 'dl-error':
      return box(`未安装frpc${installBtns}
        <div class="danger-box" style="margin-top:10px">${esc(job.error)}</div>`);
    case 'no-frpc':
      return box(`未安装frpc${installBtns}`);
    case 'no-tunnel':
      return box('未配置隧道' + btn('去 FRP 管理', 'data-action="tab" data-tab="frp"'));
    case 'no-traffic':
      // 计数开着却没接管住隧道
      if (st.frp.tap && st.frp.tap.enabled) {
        return box('本地转发计数没接管这条隧道（吞吐读不到）' + btn('立即接上', 'data-action="frp-tap-connect"'));
      }
      return box('未配置 frps 管理接口' + btn('配置', 'data-action="frp-open-settings"'));
    default:
      return '';
  }
}

/**
 * 折线图下方的引导。
 * frps 只在连接断开时结算字节，隧道长时间连着时这张图不会动；没开本地转发计数就先说明原因。
 */
function frpTapHintHTML(st) {
  const f = st.frp;
  if (!f || !f.attached) return '';
  const t = f.tap;
  if (t && t.enabled && t.running && t.onPath) return '';
  // 计数开着却没接管住隧道
  if (t && t.enabled) {
    return `<span>本地转发计数开着，但${t.running ? '这条隧道没指着转发口' : '转发口没起来'}（吞吐读不到）。</span>
      <button class="btn btn-sm" data-action="frp-tap-connect">立即接上</button>`;
  }
  return `<span>隧道长时间连着时这张图不会动（frps 只在连接断开时结算字节）。</span>
    <button class="btn btn-sm" data-action="frp-tap-guide">开启本地转发计数</button>`;
}

/** 全部隧道卡片的副标题：条数 + 配置文件名 */
function frpTunnelsSub(ov) {
  if (!ov || !ov.toml) return '读取中…';
  const p = ov.toml.path || '';
  const n = (ov.toml.proxies || []).length;
  return `${n} 条${p ? ' · ' + p.split(/[\\/]/).pop() : ''}`;
}

/** 全部隧道列表，供概览页与 FRP 页共用 */
function frpTunnelsHTML(ov) {
  if (!ov) return '<div class="empty">读取中…</div>';
  if (!ov.toml || !ov.toml.exists) return '<div class="empty">没有 frpc.toml</div>';
  const list = ov.toml.proxies || [];
  if (!list.length) return '<div class="empty">还没有隧道</div>';

  const state = (x) => {
    if (x.statusKnown === false) return '<span class="muted" title="没有可用的状态来源">状态未知</span>';
    if (x.statusSource === 'conn') {
      return x.online
        ? '<span style="color:var(--good)" title="frpc 已连上 frps；整条链路的旁证，分不出单条隧道">运行中</span>'
        : '<span style="color:var(--critical)" title="frpc 进程在跑，但没连上 frps">未连上</span>';
    }
    return x.online ? '<span style="color:var(--good)">在线</span>' : '<span style="color:var(--critical)">离线</span>';
  };

  return `<table class="kv" style="width:100%">
    ${list.map((x) => `<tr>
      <td class="mono">${esc(x.name)}</td>
      <td class="mono muted" style="font-size:11.5px">${esc(x.localIP || '')}:${x.localPort ?? '?'} → :${x.remotePort ?? '?'}</td>
      <td>${state(x)}</td>
      <td class="muted"${x.attachHow === 'byPort' ? ' title="按本地端口自动识别到这台服务器"' : ''}>${x.serverId ? esc((S.servers.find((s) => s.id === x.serverId) || {}).name || '已关联') : '未关联'}</td>
    </tr>`).join('')}
  </table>`;
}

/** 概览页主模板 */
function overviewHTML(st, d, h, ms, memPct, memLimitMb) {
  return `
    <div class="kpi-row">
      <div class="stat-tile">
        <div class="stat-label"><span class="status-dot ${statusClass(st)}" style="width:7px;height:7px"></span>状态</div>
        <div class="stat-value" id="kpiState">${statusText(st)}</div>
        <div class="stat-delta" id="kpiUptime">${uptimeText(st)}</div>
      </div>

      <div class="stat-tile">
        <div class="stat-label">CPU 占用</div>
        <div class="stat-value" id="kpiCpu">—<span class="unit">%</span></div>
        <div class="stat-delta" id="kpiCpuHint">占整机 ${S.panel ? '' : ''}所有核心的百分比</div>
        ${sparkline(h.cpu.slice(-40), 'var(--series-mem)')}
      </div>

      <div class="stat-tile">
        <div class="stat-label" id="kpiMemLabel">${esc(ms.label)}</div>
        <div class="stat-value" id="kpiMem">—</div>
        <div class="meter ${memPct > 90 ? 'crit' : memPct > 75 ? 'warn' : ''}" id="kpiMemMeter"><i style="transform:scaleX(0)"></i></div>
        <div class="stat-delta" id="kpiMemHint">
          ${st.heap ? 'JVM 堆实时占用' : '读不到 JVM 堆（该运行时没有 jcmd）'}</div>
      </div>

      <div class="stat-tile clickable" data-action="tab" data-tab="players"
           title="点击查看玩家列表">
        <div class="stat-label">在线玩家</div>
        <div class="stat-value" id="kpiPlayers">—</div>
        <div class="stat-delta" id="kpiPlayersHint">—</div>
      </div>

      <div class="stat-tile">
        <div class="stat-label">TPS <span class="muted" style="font-weight:400">(满值 20)</span></div>
        <div class="stat-value" id="kpiTps">—</div>
        <div class="stat-delta" id="kpiTpsHint">—</div>
      </div>
    </div>

    <div class="cards">
      <div class="card">
        <div class="card-head">
          <div class="card-title">内存占用趋势</div>
          <div class="card-sub">最近 ${HISTORY_LEN} 秒</div>
        </div>
        <div id="chartMem"></div>
      </div>
      <div class="card">
        <div class="card-head">
          <div class="card-title">在线玩家趋势</div>
          <div class="card-sub">最近 ${HISTORY_LEN} 秒</div>
        </div>
        <div id="chartPlayers"></div>
      </div>
    </div>

    <div class="cards">
      <div class="card clickable" data-action="tab" data-tab="frp" title="点击管理 FRP 隧道">
        <div class="card-head">
          <div class="card-title">网络状况</div>
          <div class="card-sub">${frpSubText(st)}</div>
        </div>
        <div id="frpCardBody">${frpCardHTML(st, S.frpOv) || '<div id="chartFrp"></div>'}</div>
        <div id="frpTapHint" class="frp-tap-hint">${frpTapHintHTML(st)}</div>
      </div>
      <div class="card">
        <div class="card-head">
          <div class="card-title">全部隧道</div>
          <div class="card-sub" id="frpTunnelsSub">${esc(frpTunnelsSub(S.frpOv))}</div>
        </div>
        <div id="frpTunnels">${frpTunnelsHTML(S.frpOv)}</div>
      </div>
    </div>

    <div class="cards">
      <div class="card">
        <div class="card-head"><div class="card-title">连接信息</div></div>
        ${st.portMismatch ? `<div class="console-hint" style="border-radius:9px;margin-bottom:12px">
          server.properties 里写的是 <span class="mono">${st.configPort}</span>，
          但进程实际监听 <span class="mono">${st.port}</span>（多半是启动参数里带了 <span class="mono">--port</span>）。
          下面按实际端口显示。</div>` : ''}
        <dl class="kv">
          <dt>本机地址</dt><dd class="mono">${esc(d.connections?.local || '—')}</dd>
          <dt>局域网</dt><dd class="mono">${(d.connections?.lan || []).map(esc).join('  /  ') || '—'}</dd>
          <dt>MOTD</dt><dd>${esc(st.motd || '—')}</dd>
          <dt>延迟</dt><dd>${st.latency != null ? st.latency + ' ms' : '—'}</dd>
        </dl>
      </div>

      <div class="card">
        <div class="card-head"><div class="card-title">服务器信息</div></div>
        <dl class="kv">
          <dt>服务端</dt><dd>${esc(d.launch?.type ? typeLabel(d.launch.type) : '—')}${d.launch?.loaderVersion ? ' · ' + esc(String(d.launch.loaderVersion)) : ''}
            ${d.launch?.confidence === 'low' ? '<span class="tag" style="margin-left:6px">识别存疑</span>' : ''}</dd>
          <dt>游戏版本</dt><dd>${esc(st.version?.name || d.launch?.mcVersion || '—')}${!st.version?.name && d.launch?.mcVersion
            ? ' <span class="tag" title="服务器没在运行（或没响应列表 Ping），这里按加载器版本推断">按加载器推断</span>' : ''}</dd>
          <dt>进程 PID</dt><dd class="mono">${st.pid ?? '—'} ${st.launchedByPanel
            ? `<span class="tag">面板启动</span>${st.stdinLost
              ? (st.rcon
                ? (st.rconBlocked
                  ? '<span class="tag" title="rcon.port 被别的服务器占着，这条通道不可用">已失去控制台通道 · RCON 端口被占用</span>'
                  : '<span class="tag" title="stdin 通道已随旧面板一起消失，但该服务器已启用 RCON，指令仍可发送">面板重启 · 经 RCON 控制</span>')
                : '<span class="tag" title="面板重启过，无法再写入该进程的控制台，指令须走 RCON">已失去控制台通道</span>')
              : ''}`
            : (st.running ? '<span class="tag">外部启动</span>' : '')}</dd>
          <dt>Mods</dt><dd>${d.stats?.mods ?? 0}${d.stats?.plugins ? ` · 插件 ${d.stats.plugins}` : ''}</dd>
          <dt>World</dt><dd>${esc(st.world?.name || '—')} ${st.world?.size != null ? `<span class="muted">(${fmtBytes(st.world.size)})</span>` : ''}</dd>
          <dt>RCON</dt><dd>${d.rcon?.blocked
            ? `<span style="color:var(--critical)">端口被占用</span> <span class="muted mono">${esc(String(d.rcon.port ?? ''))}</span>`
            : d.rcon?.available ? '<span style="color:var(--good)">已启用</span>' : '<span class="muted">未启用</span>'}</dd>
        </dl>
        <div class="row" style="margin-top:14px">
          <button class="btn btn-sm" data-action="open-launch-settings">启动设置</button>
          <button class="btn btn-sm" data-action="reload-detail">刷新信息</button>
          <button class="btn btn-sm btn-danger" data-action="remove-server">移除服务器</button>
        </div>
      </div>
    </div>
  `;
}

/** 概览页图表建立 */
function setupOverviewCharts(st, memLimitMb) {
  S.view.chartMem = createChart($('#chartMem'), {
    color: 'var(--series-mem)',
    unit: 'MB',
    height: 156,
    emptyText: st.running ? '正在采集数据…' : '服务器未运行',
    formatAxis: (v) => (v >= 1024 ? (v / 1024).toFixed(1) + 'G' : Math.round(v) + 'M'),
    format: (v) => v.toFixed(0) + ' MB',
    // 用堆上限（≈ -Xmx）作参考线；退回工作集时不画。
    suggestMax: memLimitMb,
  });
  S.view.chartPlayers = createChart($('#chartPlayers'), {
    color: 'var(--series-play)',
    height: 156,
    emptyText: st.running ? '正在采集数据…' : '服务器未运行',
    formatAxis: (v) => String(Math.round(v)),
    format: (v) => `${Math.round(v)} 人`,
    suggestMax: Math.max(st.players.max, 1),
  });
  // 隧道不可用时卡片里放的是提示而不是图
  if ($('#chartFrp')) {
    S.view.chartFrp = createChart($('#chartFrp'), {
      color: 'var(--series-frp-up)',
      color2: 'var(--series-frp-dn)',
      height: 156,
      emptyText: '正在采集数据…',
      formatAxis: (v) => fmtBytes(v),
      format: fmtRate,
      suggestMax: 1024,
    });
  }
}

function renderOverview(content, st) {
  const d = S.detail || {};
  const h = S.history.get(st.id) || { mem: [], cpu: [], players: [] };
  const ms = memStats(st);
  const memLimitMb = ms.limitMb;
  const memPct = memLimitMb ? Math.min(100, (ms.usedMb / memLimitMb) * 100) : null;

  content.innerHTML = overviewHTML(st, d, h, ms, memPct, memLimitMb);
  setupOverviewCharts(st, memLimitMb);

  S.view.frpCardState = frpCardState(st, S.frpOv);

  // 隧道列表只在没缓存时补拉；卡片正文由 updateOverview 按状态刷新
  if (!S.frpOv) {
    api('/api/frp').then((r) => {
      S.frpOv = r;
      patchFrpCards(currentStatus() || st, r);
    }).catch((e) => {
      const el = $('#frpTunnels');
      if (el) el.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
    });
  }

  updateOverview(st);
  frpCardPoll();
}


/** 只更新「网络状况」与「全部隧道」两张卡的内容；st 必须是当下最新的 */
function patchFrpCards(st, r) {
  if (S.tab !== 'overview') return;
  if (r.settings) S.panel = { ...S.panel, frp: r.settings };   // 顺带刷新弹窗的回填值
  const body = $('#frpCardBody');
  if (body) {
    const state = frpCardState(st, r);
    if (state === 'chart') {
      if (!$('#chartFrp')) { renderTab(); return; }   // 装好了，该把折线图建出来
    } else {
      S.view.frpCardState = state;
      body.innerHTML = frpCardHTML(st, r);
    }
  }
  const el = $('#frpTunnels');
  if (el) el.innerHTML = frpTunnelsHTML(r);
  const sub = $('#frpTunnelsSub');
  if (sub) sub.textContent = frpTunnelsSub(r);
  const hint = $('#frpTapHint');
  if (hint) hint.innerHTML = frpTapHintHTML(st);
}

/** 下载进行中时轮询进度 */
function frpCardPoll() {
  const job = S.frpOv && S.frpOv.download && S.frpOv.download.job;
  if (!job || job.status !== 'running') return;
  setTimeout(async () => {
    if (S.tab !== 'overview') return;
    try {
      const r = await api('/api/frp');
      S.frpOv = r;
      patchFrpCards(currentStatus(), r);
    } catch {}
    frpCardPoll();
  }, 1200);
}

const TPS_TIP = 'TPS 由面板自动查询（约每 30 秒一次），不需要手动操作。\n'
  + 'TPS 没有旁路读法，只能向服务器发指令问：面板自己启动的服务器直接写控制台，'
  + '外部启动、或面板重启后认领回来的服务器要走 RCON。两条路都没有时读不到。';

/** TPS 卡片副标题：读到值则显示读取时间，读不到则说明原因。 */
function tpsHintText(st) {
  if (st.tps == null) {
    if (st.synced === false) return '同步中';
    if (!st.running) return '进程未运行';
    if (st.tpsBlocker) return st.tpsBlocker;
    return '正在读取…';
  }
  const secs = st.tpsAt ? Math.round((Date.now() - st.tpsAt) / 1000) : null;
  if (secs == null) return '自动读取';
  return `自动读取 · ${secs < 5 ? '刚刚' : secs + ' 秒前'}`;
}

function updateOverview(st) {
  if (S.tab !== 'overview' || !S.view.chartMem) return;
  const h = S.history.get(st.id) || { t: [], mem: [], cpu: [], players: [] };
  const ms = memStats(st);
  const memPct = ms.limitMb ? Math.min(100, (ms.usedMb / ms.limitMb) * 100) : null;

  // 值不变不写 DOM
  const set = (id, html) => {
    const e = $('#' + id);
    if (e && e.innerHTML !== html) e.innerHTML = html;
  };
  const num = (v, digits = 1) => (Number.isFinite(v) ? v.toFixed(digits) : '—');
  set('kpiState', statusText(st));
  const dot = $('#kpiState')?.previousElementSibling?.querySelector?.('.status-dot');
  if (dot) {
    const dc = 'status-dot ' + statusClass(st);
    if (dot.className !== dc) dot.className = dc;
  }
  set('kpiUptime', uptimeText(st));
  set('kpiCpu', st.running ? `${num(st.cpu ?? 0)}<span class="unit">%</span>` : '—<span class="unit">%</span>');
  set('kpiMem', st.running ? fmtBytes(ms.usedMb * 1048576) : '—');
  set('kpiMemLabel', ms.label);
  set('kpiMemHint', st.running
    ? (ms.byHeap ? 'JVM 堆实时占用' : '读不到 JVM 堆（该运行时没有 jcmd）')
    : (st.synced === false ? '同步中' : '进程未运行'));
  set('kpiPlayers', st.running ? `${st.players.online}<span class="unit">/ ${st.players.max}</span>` : '—');
  set('kpiPlayersHint', st.running ? '当前在线' : (st.synced === false ? '同步中' : '进程未运行'));
  set('kpiTps', st.tps != null ? num(st.tps) : '—');
  const tpsHint = $('#kpiTpsHint');
  if (tpsHint) {
    const t = tpsHintText(st);
    if (tpsHint.textContent !== t) tpsHint.textContent = t;
    if (tpsHint.title !== TPS_TIP) tpsHint.title = TPS_TIP;
  }

  const meter = $('#kpiMemMeter');
  if (meter) {
    const pct = memPct ?? 0;
    const mc = 'meter ' + (memPct == null ? '' : pct > 90 ? 'crit' : pct > 75 ? 'warn' : '');
    if (meter.className !== mc) meter.className = mc;
    meter.firstElementChild.style.transform = `scaleX(${pct / 100})`;
  }

  // 历史没变不重画（updateOverview 每秒都进来）
  const hSig = h.t.length + '|' + (h.t[h.t.length - 1] || 0);
  if (S.view._hSig !== hSig) {
    S.view._hSig = hSig;
    S.view.chartMem.update(h.t.map((t, i) => ({ t, v: h.mem[i] })));
    S.view.chartPlayers.update(h.t.map((t, i) => ({ t, v: h.players[i] })));
    if (S.view.chartFrp) {
      S.view.chartFrp.update(
        h.t.map((t, i) => ({ t, v: h.frpIn[i] || 0 })),
        h.t.map((t, i) => ({ t, v: h.frpOut[i] || 0 })),
      );
    }
  }

  // 网络状况卡在提示态时随状态重画；一旦能画图了就把图表建出来
  if ($('#frpCardBody')) {
    const state = frpCardState(st, S.frpOv);
    if (state === 'chart') {
      if (!$('#chartFrp')) renderTab();
    } else if (state !== S.view.frpCardState) {
      S.view.frpCardState = state;
      $('#frpCardBody').innerHTML = frpCardHTML(st, S.frpOv);
    }
  }

  // 折线图下方的引导：开了转发口就撤掉
  const hint = $('#frpTapHint');
  if (hint) {
    const html = frpTapHintHTML(st);
    if (hint.innerHTML !== html) hint.innerHTML = html;
  }
}

/* ─────────────────────────── 日志 ─────────────────────────── */

function renderLogs(content, st) {
  const d = S.view.logFiles;
  if (!d && !S.openLog) {
    content.innerHTML = `<div class="empty">正在读取日志列表…</div>`;
    const id = S.current;
    api(`/api/servers/${id}/logfiles`)
      .then((r) => {
        if (S.current !== id) return;
        S.view.logFiles = r; if (S.tab === 'logs') renderTab();
      })
      .catch((e) => toast(e.message, 'err'));
    return;
  }

  if (S.openLog) {
    content.innerHTML = `
      <div class="row-between" style="margin-bottom:12px">
        <div class="row">
          <button class="btn btn-sm btn-ghost" data-action="close-log">← 返回列表</button>
          <span class="mono" style="font-size:13px">${esc(S.openLog.file)}</span>
          ${S.openLog.truncated ? '<span class="tag" style="color:var(--warning)">仅显示末尾 2MB</span>' : ''}
          <span class="muted" style="font-size:12px">${fmtBytes(S.openLog.size)}</span>
        </div>
      </div>
      <div class="console" style="height:auto;max-height:calc(100vh - 250px)">
        <div class="console-body" id="logView"></div>
      </div>
      <div id="logMore"></div>`;
    // 分片渲染：大日志整段 textContent 会卡手机数秒
    const view = $('#logView');
    const CHUNK = 300 * 1024;
    const text = S.openLog.content || '';
    S.openLogPos = Math.max(0, text.length - CHUNK);
    S.openLogPaint = () => {
      view.textContent = text.slice(S.openLogPos);
      $('#logMore').innerHTML = S.openLogPos > 0
        ? `<button class="btn btn-sm btn-ghost" data-action="log-more" style="width:100%;margin-top:8px">加载更早的内容</button>`
        : '';
    };
    S.openLogPaint();
    view.scrollTop = view.scrollHeight;
    return;
  }

  content.innerHTML = `
    <div class="card" style="padding:6px 0">
      <div class="table-scroll">
      <table class="file-table">
        <thead><tr><th>日志文件</th><th class="num col-size">大小</th><th class="num col-time">修改时间</th></tr></thead>
        <tbody>
        ${d.files.map((f) => `<tr>
          <td><div class="fname" data-action="open-log" data-file="${esc(f.rel)}">
            ${fileIcon('log')}<span class="nm">${esc(f.rel)}</span></div></td>
          <td class="num col-size">${fmtBytes(f.size)}</td>
          <td class="num col-time">${fmtDateTime(f.mtime)}</td>
        </tr>`).join('') || '<tr><td colspan="3" class="muted" style="padding:22px;text-align:center">没有日志文件</td></tr>'}
        </tbody>
      </table>
      </div>
    </div>
    <div class="muted" style="font-size:12px;margin-top:10px">
      .log.gz 是服务器自动压缩的历史日志，面板会就地解压显示。崩溃报告在 crash-reports/ 目录下。
    </div>`;
}

/* ─────────────────────────── 备份 ─────────────────────────── */

function renderBackups(content, st) {
  const d = S.view.backups;
  if (!d) {
    content.innerHTML = `<div class="empty">正在读取备份列表…</div>`;
    const id = S.current;
    api(`/api/servers/${id}/backups`)
      .then((r) => {
        if (S.current !== id) return;
        S.view.backups = r; if (S.tab === 'backups') renderTab();
      })
      .catch((e) => toast(e.message, 'err'));
    return;
  }

  content.innerHTML = `
    <div class="row-between" style="margin-bottom:14px">
      <div class="row">
        <button class="btn btn-primary btn-sm" data-action="new-backup">立即备份</button>
        <label class="row" style="font-size:12.5px;gap:5px;cursor:pointer">
          <input type="checkbox" id="bkMods"> 同时备份 mods / config
        </label>
      </div>
      <span class="muted mono" style="font-size:11.5px">${esc(d.dir)}</span>
    </div>

    ${d.running ? `<div class="console-hint" style="border-radius:9px;margin-bottom:14px">
      服务器正在运行。运行中备份可能抓到一个正在写入的存档，还原后有小概率需要重新生成区块。
      建议先停止服务器再备份。</div>` : ''}

    ${d.leftovers?.length ? `<div class="card" style="margin-bottom:14px;border-color:color-mix(in srgb, var(--warning) 30%, transparent)">
      <div class="card-head"><div class="card-title">还原前的旧存档</div>
        <div class="card-sub">确认新存档正常后可以删除，以释放空间</div></div>
      <table class="file-table"><tbody>
      ${d.leftovers.map((l) => `<tr>
        <td class="mono" style="font-size:12px">${esc(l.name)}</td>
        <td class="num">${fmtDateTime(l.mtime)}</td>
        <td class="ops"><button class="btn btn-sm btn-ghost" style="color:var(--critical)"
          data-action="del-leftover" data-name="${esc(l.name)}">删除</button></td>
      </tr>`).join('')}
      </tbody></table>
    </div>` : ''}

    <div class="card" style="padding:6px 0">
      <div class="table-scroll">
      <table class="file-table">
        <thead><tr><th>备份文件</th><th class="num col-size">大小</th><th class="num col-time">时间</th><th class="ops">操作</th></tr></thead>
        <tbody>
        ${d.backups.map((b) => `<tr>
          <td><div class="fname">${fileIcon('jar')}<span class="nm mono" style="font-size:12.5px">${esc(b.name)}</span></div></td>
          <td class="num col-size">${fmtBytes(b.size)}</td>
          <td class="num col-time">${fmtDateTime(b.mtime)}</td>
          <td class="ops">
            <button class="btn btn-sm" data-action="restore-backup" data-name="${esc(b.name)}">还原</button>
            <button class="btn btn-sm btn-ghost" data-action="download-backup" data-name="${esc(b.name)}">下载</button>
            <button class="btn btn-sm btn-ghost" style="color:var(--critical)" data-action="del-backup" data-name="${esc(b.name)}">删除</button>
          </td>
        </tr>`).join('') || '<tr><td colspan="4" class="muted" style="padding:26px;text-align:center">还没有备份</td></tr>'}
        </tbody>
      </table>
      </div>
    </div>
    <div class="muted" style="font-size:12px;margin-top:10px;line-height:1.7">
      备份内容：<span class="mono">world</span> 及 <span class="mono">world_nether / world_the_end</span>，
      加上 server.properties、白名单、OP、封禁名单。<br>
      还原前面板会先把现有存档改名保留一份，还原失败会自动回滚。
    </div>`;
}
