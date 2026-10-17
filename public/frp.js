'use strict';
/* =========================================================================
   RS面板前端 · FRP 管理。无框架、无构建步骤，原生 JS + SVG 手绘图表。
   加载顺序：core → chart → views → panels → frp → dialogs。
   ========================================================================= */
/* ─────────────────────────── FRP 管理 ─────────────────────────── */

function invalidateFrp() {
  S.view.frp = null;
  S.view.frpSrv = null;
  S.view.frpFor = null;
  S.frpOv = null;
  S.view.frpCardState = null;
}

/** 隧道状态：只给状态与出处，细节走悬停提示 */
function frpTunnelLine(sr) {
  const TIP_CONN = 'frpc 与 frps 的连接是整条链路的旁证，分不出单条隧道；'
    + '要精确到每条，需启用 frpc 管理接口或填 frps dashboard。';
  if (!sr.attached) {
    return sr.attachHow === 'ambiguous'
      ? '<span class="muted">有多条候选</span>'
      : '<span class="muted">尚未配置</span>';
  }
  const t = sr.tunnel;
  if (!t) {
    return '<b>状态未知</b><span class="muted" title="没有可用的状态来源">？</span>';
  }
  if (t.source === 'conn') {
    return t.online
      ? `<b style="color:var(--good)" title="${esc(TIP_CONN)}">运行中</b>`
      : `<b style="color:var(--critical)" title="frpc 进程在跑，但没有到 ${esc(t.remoteAddr || '')} 的连接">未连上 frps</b>`;
  }
  const where = t.source === 'frpc' ? 'frpc 管理接口' : 'frps dashboard';
  const addr = t.localAddr && t.remoteAddr
    ? ` <span class="mono">${esc(t.localAddr)}</span> → <span class="mono">${esc(t.remoteAddr)}</span>`
    : '';
  const title = t.err ? `服务端回报：${esc(t.err)}` : `据 ${where}`;
  return `<b style="color:${t.online ? 'var(--good)' : 'var(--critical)'}" title="${title}">${t.online ? '在线' : '离线'}</b>`
    + addr;
}

async function renderFrp(content, st) {
  if (!S.view.frp || S.view.frpFor !== S.current) {
    content.innerHTML = '<div class="empty">正在读取 FRP 状态…</div>';
    try {
      const [ov, srv] = await Promise.all([api('/api/frp'), api(`/api/servers/${S.current}/frp`)]);
      S.view.frp = ov;
      S.view.frpSrv = srv;
      S.view.frpFor = S.current;
      S.frpOv = ov;   // 概览页的「全部隧道」卡片共用同一份
      if (ov.settings) S.panel = { ...S.panel, frp: ov.settings };
    } catch (e) {
      content.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
      return;
    }
    if (S.tab !== 'frp') return;
    return renderTab();
  }

  const ov = S.view.frp;
  const sr = S.view.frpSrv;
  const proc = ov.process || {};
  const sug = sr.suggestions || {};
  const p = sr.proxy || { ...sug };
  const t = sr.tap || { enabled: false };
  const busy = S.busy.has('frp');

  content.innerHTML = frpPageHTML(ov, sr, proc, sug, p, t, busy);
  bindFrpPage(content, sr, t);
}

/** FRP 页主模板 */
function frpPageHTML(ov, sr, proc, sug, p, t, busy) {
  return `
    <div class="cards">

      <div class="card">
        <div class="card-head">
          <div class="card-title">frpc 进程</div>
          <div class="card-sub">${proc.running
            ? `PID ${proc.pid}${proc.how === 'tray' ? '（frpc-tray 托管）' : proc.how === 'foreign' ? '（不是面板启动的）' : ''}`
            : '未运行'}</div>
        </div>
        <div class="field">
          <div class="row" style="flex-wrap:wrap">
            <button class="btn btn-sm btn-primary" data-action="frp-start" ${!ov.installed || proc.running || busy ? 'disabled' : ''}>启动 frpc</button>
            <button class="btn btn-sm" data-action="frp-stop" ${!proc.running || busy ? 'disabled' : ''}>停止 frpc</button>
            <button class="btn btn-sm btn-ghost" data-action="frp-reload" ${!proc.running ? 'disabled' : ''}>重载配置</button>
          </div>
          ${ov.installed && ov.toml.exists && !ov.admin.enabled ? `
          <div class="warn-box" style="margin-top:10px">
            frpc.toml 里没有 <span class="mono">[webServer]</span> 段，面板读不到每条隧道的状态。
            ${ov.statusSource === 'none' ? '配上它（或 frps dashboard）之后，隧道在线状态才是准的。' : ''}
          </div>
          <div class="row" style="margin-top:8px">
            <button class="btn btn-sm" data-action="frp-enable-admin">启用管理接口</button>
            <span class="muted" style="font-size:12px">写入配置，需重启 frpc 生效</span>
          </div>` : ''}
        </div>
        <div class="field" style="margin-bottom:0">
          <label>frp 连携启动</label>
          <div class="seg" data-seg="frp-auto">
            <button type="button" data-frp-auto="0" class="${ov.autoStart ? '' : 'on'}">关闭</button>
            <button type="button" data-frp-auto="1" class="${ov.autoStart ? 'on' : ''}">开启</button>
          </div>
          <div class="muted" style="font-size:12px;margin-top:6px;line-height:1.7">
            开启后，面板启动时会自动把 frpc 一起拉起来。面板退出<b>不会</b>关闭 frpc。
          </div>
        </div>
      </div>
    </div>

    <div class="cards">
      <div class="card" style="grid-column:1/-1">
        <div class="card-head">
          <div class="card-title">本服务器的隧道</div>
          <div class="card-sub">${sr.attached ? esc(sr.proxyName) : (sr.attachHow === 'ambiguous' ? '有多条候选' : '尚未配置')}</div>
        </div>
        ${!ov.installed ? `<div class="warn-box">还没装 frpc，先去「高级设置」选好 frp 目录，或在概览页下载一份。</div>` : ''}
        ${sr.attachHow === 'ambiguous' ? `<div class="warn-box">
          有好几条隧道的本地端口都指向这台服务器，请用右边的下拉选一条。</div>` : ''}
        ${sr.stale ? `<div class="warn-box">隧道的本地端口是 <span class="mono">${sr.stale.localPort}</span>，
          但服务器现在实际监听 <span class="mono">${sr.stale.serverPort}</span>。点「保存」会按当前端口修正。</div>` : ''}
        <div class="row" style="flex-wrap:wrap;gap:10px">
          <div class="field" style="margin:0;flex:1;min-width:150px">
            <label>隧道名</label>
            <input class="input mono" data-frp="name" value="${esc(p.name || '')}">
          </div>
          <div class="field" style="margin:0;flex:1;min-width:150px">
            <label>本地地址</label>
            <input class="input mono" data-frp="localIP" value="${esc(p.localIP || '127.0.0.1')}">
          </div>
          <div class="field" style="margin:0;width:130px">
            <label>本地端口</label>
            <input class="input mono" type="number" min="1" max="65535" data-frp="localPort" value="${p.localPort ?? ''}">
          </div>
          <div class="field" style="margin:0;width:130px">
            <label>远端端口</label>
            <input class="input mono" type="number" min="1" max="65535" data-frp="remotePort" value="${p.remotePort ?? ''}">
          </div>
          ${t.enabled ? '' : `<div class="field" style="margin:0;align-self:flex-end">
            <button class="btn btn-primary btn-sm" data-action="frp-save-proxy" ${!ov.installed ? 'disabled' : ''}>${sr.attached ? '保存' : '创建隧道'}</button>
          </div>`}
          ${sr.attached && !t.enabled ? `<div class="field" style="margin:0;align-self:flex-end">
            <button class="btn btn-danger btn-sm" data-action="frp-del-proxy">删除隧道</button>
          </div>` : ''}
        </div>
        <div class="field" style="margin:12px 0 0">
          <label>关联到哪条隧道</label>
          <div class="row">
            <select class="select" data-frp-attach style="flex:1;max-width:360px">
              <option value="">不关联</option>
              ${(sr.proxies || []).map((x) => `<option value="${esc(x.name)}" ${sr.proxyName === x.name ? 'selected' : ''}>${esc(x.name)}　:${x.localPort ?? '?'} → :${x.remotePort ?? '?'}</option>`).join('')}
            </select>
          </div>
        </div>
        <div class="field" data-card="frp-tap" style="margin:12px 0 0">
          <label>本地转发计数</label>
          <div class="row" style="align-items:center;gap:10px;flex-wrap:wrap">
            <button class="btn btn-sm ${t.enabled ? 'btn-danger' : 'btn-primary'}"
              data-action="frp-tap-toggle" ${sr.attached ? '' : 'disabled'}>${t.enabled ? '关闭' : '开启'}</button>
            ${t.enabled ? `<span class="mono" style="font-size:12px">
              ${t.running
                ? `监听 127.0.0.1:${t.listenPort} → 127.0.0.1:${t.targetPort} · 连接 ${t.conns}`
                : `<span style="color:var(--critical)">转发口没起来</span>`}
              ${t.running && !t.onPath ? `<span style="color:var(--critical)"> · 隧道没指着它，计数读不到</span>` : ''}
            </span>` : ''}
          </div>
          ${t.error ? `<div class="danger-box" style="margin-top:8px">${esc(t.error)}</div>` : ''}
          <div class="muted" style="font-size:12px;margin-top:8px;line-height:1.7">
            启用此选项后面板进程将会与此隧道绑定。变更此选项将会立马重启frpc
          </div>
        </div>
        <div class="muted" style="font-size:12px;margin-top:10px;line-height:1.7">
          隧道状态：${frpTunnelLine(sr)}
        </div>
      </div>
    </div>`;
}

/** FRP 页的事件接线 */
function bindFrpPage(content, sr, t) {
  // 连携启动开关：改动即保存
  content.querySelector('[data-seg="frp-auto"]')?.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-frp-auto]');
    if (!b) return;
    for (const x of content.querySelectorAll('[data-frp-auto]')) x.classList.toggle('on', x === b);
    try {
      await api('/api/frp/settings', { method: 'PATCH', body: { autoStart: b.dataset.frpAuto === '1' } });
      toast(b.dataset.frpAuto === '1' ? '已开启连携启动' : '已关闭连携启动', 'ok', 3000);
    } catch (err) {
      toast(err.message, 'err');
      invalidateFrp();
    }
  });

  // 重新指定「服务器 ↔ 隧道」的关联，只改记录不动配置文件
  content.querySelector('[data-frp-attach]')?.addEventListener('change', async (e) => {
    const name = e.target.value;
    try {
      await api(`/api/servers/${S.current}/frp/attach`, { method: 'POST', body: { name } });
      await frpRefresh();
      toast(name ? `已关联到 ${name}` : '已取消关联', 'ok', 3000);
    } catch (err) {
      toast(err.message, 'err');
      await frpRefresh();
    }
  });

  // 转发口接管着隧道：隧道名、本地地址、本地端口、远端端口四格一起锁住，点它们只给一句提示，不落光标
  if (t.enabled) {
    let last = 0;
    const hint = () => {
      if (Date.now() - last < 4000) return;
      last = Date.now();
      toast('隧道这几项现在由转发口接管：请先关掉「本地转发计数」，再改隧道', 'warn', 6000);
    };
    for (const key of ['name', 'localIP', 'localPort', 'remotePort']) {
      const input = content.querySelector(`[data-frp="${key}"]`);
      const box = input && input.closest('.field');
      if (!input || !box) continue;
      input.readOnly = true;        // 键盘也改不了
      input.tabIndex = -1;          // Tab 也进不去
      box.classList.add('locked');
      box.addEventListener('click', hint);
    }
  }
}

async function frpRefresh() {
  invalidateFrp();
  renderTab();
}

/** 从概览页的折线图跳到 FRP 页，并闪一下「本地转发计数」这一项 */
function frpTapGuide() {
  S.tab = 'frp';
  destroyView();
  S.view = {};
  renderTabs();
  renderTab();
  let tries = 0;
  const aim = () => {
    const el = document.querySelector('[data-card="frp-tap"]');
    if (!el) {
      if (++tries < 20) setTimeout(aim, 150);
      return;
    }
    el.scrollIntoView({ block: 'center' });
    el.classList.add('flash');
    setTimeout(() => el.classList.remove('flash'), 1800);
  };
  setTimeout(aim, 200);
}

/** 计数开着却没接管住隧道时，把隧道重新指回转发口 */
async function frpTapConnect() {
  const id = S.current;
  toast('正在把隧道接回转发口并重启 frpc，请稍候…', 'info', 60000);
  try {
    const r = await api(`/api/servers/${id}/frp/tap`, { method: 'POST' });
    const skipped = !!(r.restart && r.restart.via === 'skipped');
    toast(skipped
      ? `已把隧道指到 127.0.0.1:${r.listenPort}，但 frpc 没能自动重启，请自己重启它`
      : `已把隧道指到 127.0.0.1:${r.listenPort}，frpc 已重启`,
    skipped ? 'warn' : 'ok', skipped ? 10000 : 6000);
  } catch (e) {
    toast(e.message, 'err', 10000);
  }
  await frpRefresh();
}

/**
 * 本地转发计数开关。按一下就做完整个流程：
 * 起停监听口、把隧道 localPort 改到它（或改回服务器端口）、重启 frpc。
 */
async function frpTapToggle() {
  const id = S.current;
  const sr = S.view.frpSrv || {};
  const on = sr.tap && sr.tap.enabled;
  const btn = document.querySelector('[data-action="frp-tap-toggle"]');
  if (btn) btn.disabled = true;
  toast(on ? '正在关闭并重启 frpc，请稍候…' : '正在开启并重启 frpc，请稍候…', 'info', 60000);
  try {
    const r = await api(`/api/servers/${id}/frp/tap`, { method: on ? 'DELETE' : 'POST' });
    const skipped = !!(r.restart && r.restart.via === 'skipped');
    const tail = skipped ? '。frpc 没能自动重启，请自己重启它' : '，frpc 已重启';
    toast(on
      ? (r.restored ? '已关闭：隧道已指回服务器端口' + tail : '本地转发计数已关闭' + tail)
      : `已开启：监听 127.0.0.1:${r.listenPort}，隧道已指向它` + tail,
    skipped ? 'warn' : 'ok', skipped ? 10000 : 6000);
  } catch (e) {
    toast(e.message, 'err', 10000);
  }
  await frpRefresh();
}

async function frpPickDir() {
  const dir = await browseForDir((S.view.frp && S.view.frp.dir) || '');
  if (!dir) return;
  try {
    await api('/api/frp/settings', { method: 'PATCH', body: { dir } });
    await frpRefresh();
    toast('frp 目录已切换', 'ok');
  } catch (e) {
    toast(e.message, 'err');
  }
}

/** 一键安装：先让用户选装官方 frpc 还是懒人 frpc */
async function frpDownload() {
  const f = (S.panel || {}).frp || {};
  const list = (f.sources && f.sources.length) ? f.sources : [
    { id: 'official', label: '官方 frpc' },
    { id: 'lazy', label: '懒人 frpc', note: '开箱即用，推荐', recommend: true },
  ];
  const noteOf = (id) => ((list.find((x) => x.id === id) || {}).note || '');
  const pick = list.some((x) => x.id === f.source) ? f.source : (list.find((x) => x.recommend) || list[0]).id;

  const res = await openModal({
    title: '下载 frp',
    autofocus: false,
    body: (bodyEl) => {
      bodyEl.innerHTML = `
        <div class="field" style="margin-bottom:0">
          <label>选择要安装的版本</label>
          <div class="seg" data-src>
            ${list.map((x) => `<button type="button" data-src-opt="${esc(x.id)}" class="${x.id === pick ? 'on' : ''}">${esc(x.label)}${x.recommend ? ' <span class="tag">更推荐</span>' : ''}</button>`).join('')}
          </div>
          <div class="muted" style="font-size:12px;margin-top:8px;line-height:1.6" data-src-note>${esc(noteOf(pick))}</div>
        </div>`;
      bodyEl.querySelector('[data-src]').addEventListener('click', (e) => {
        const b = e.target.closest('[data-src-opt]');
        if (!b) return;
        for (const x of bodyEl.querySelectorAll('[data-src-opt]')) x.classList.toggle('on', x === b);
        bodyEl.querySelector('[data-src-note]').textContent = noteOf(b.dataset.srcOpt);
      });
    },
    actions: [
      { label: '取消', variant: 'ghost' },
      {
        label: '开始下载',
        variant: 'primary',
        value: (bodyEl) => {
          const on = bodyEl.querySelector('[data-src-opt].on');
          return on ? on.dataset.srcOpt : pick;
        },
      },
    ],
  });
  if (!res) return;

  try {
    await api('/api/frp/download', { method: 'POST', body: { source: res } });
  } catch (e) {
    return toast(e.message, 'err', 12000);
  }
  S.frpOv = null;
  if (S.tab === 'overview') renderTab();
}

async function frpEnableAdmin() {
  const ok = await confirmDanger({
    title: '启用 frpc 管理接口',
    message: '面板会往 frpc.toml 追加一个只监听 127.0.0.1 的 [webServer] 段，'
      + '用来读每条隧道的在线状态与错误。段里的端口和密码由面板随机生成。',
    detail: '配置里已经有 [webServer] 段的话会原样保留，不会覆盖。<br>'
      + '面板<b>不会</b>去重启 frpc——写进去之后，等你下次自己重启它时才生效。<br>'
      + '这只是让状态更精确；不启用也能从 frpc 与 frps 的连接看出隧道在不在跑。',
    confirmLabel: '写入',
    tone: 'info',
  });
  if (!ok) return;
  try {
    const r = await api('/api/frp/admin', { method: 'POST' });
    await frpRefresh();
    toast(r.message, 'ok', 9000);
  } catch (e) {
    toast(e.message, 'err', 10000);
  }
}

async function frpProc(action, label) {
  // 停掉别人的 frpc 会断掉所有隧道，且面板不会自动再拉起来，先确认
  if (action === 'stop') {
    const proc = (S.view.frp && S.view.frp.process) || null;
    if (proc && proc.how === 'foreign') {
      const ok = await confirmDanger({
        title: '停止 frpc',
        message: '这个 frpc 不是面板启动的，停掉它会让所有隧道断开，而且面板不会把它再拉起来。',
        detail: `PID <span class="mono">${proc.pid}</span>　${esc(proc.exePath || '')}`,
        confirmLabel: '停止',
      });
      if (!ok) return;
    }
  }
  try {
    const r = await api(`/api/frp/${action}`, { method: 'POST' });
    toast(`${label}${r.via ? `（${r.via}）` : ''}`, 'ok');
  } catch (e) {
    toast(e.message, 'err', 12000);
  }
  await frpRefresh();
}

async function frpSaveProxy() {
  const val = (k) => { const e = $(`[data-frp="${k}"]`); return e ? e.value.trim() : ''; };
  const body = {
    name: val('name'),
    type: 'tcp',
    localIP: val('localIP'),
    localPort: Number(val('localPort')),
    remotePort: Number(val('remotePort')),
  };
  try {
    await api(`/api/servers/${S.current}/frp`, { method: 'PUT', body });
    await frpRefresh();
    toast('隧道已保存', 'ok');
  } catch (e) {
    toast(e.message, 'err', 10000);
  }
}

async function frpDelProxy() {
  const name = (S.view.frpSrv && S.view.frpSrv.proxyName) || '';
  const ok = await confirmDanger({
    title: '删除隧道',
    message: '这会从 frpc.toml 里删掉这条隧道，这台服务器随之失去穿透。',
    detail: `<span class="mono">${esc(name)}</span>`,
    confirmLabel: '删除',
  });
  if (!ok) return;
  try {
    await api(`/api/servers/${S.current}/frp`, { method: 'DELETE' });
    await frpRefresh();
    toast('隧道已删除', 'ok');
  } catch (e) {
    toast(e.message, 'err');
  }
}

/**
 * FRP 设置弹窗：frpc.toml 顶层的连接参数 + 画折线图用的 frps dashboard。
 * 所有值随 /api/state 下发，这里不发任何请求——手机经 frp 隧道访问时，
 * 一次往返就是 200ms 级的卡顿。
 */
async function openFrpSettings() {
  const s = (S.panel && S.panel.frp) || {};
  const hasToml = !!s.hasToml;
  const dis = hasToml ? '' : 'disabled';

  const res = await openModal({
    title: 'FRP 设置',
    autofocus: false,
    body: (bodyEl) => {
      bodyEl.innerHTML = `
        <div class="field">
          <label>服务端地址 <span class="muted" style="font-weight:400">serverAddr</span></label>
          <input class="input mono" data-cfg="serverAddr" value="${esc(s.serverAddr || '')}"
                 placeholder="你的 frps 域名或 IP" ${dis}>
        </div>
        <div class="field">
          <label>服务端口 <span class="muted" style="font-weight:400">serverPort</span></label>
          <input class="input mono" type="number" min="1" max="65535" style="width:150px"
                 data-cfg="serverPort" value="${s.serverPort ?? ''}" ${dis}>
        </div>
        <div class="field">
          <label>认证 token <span class="muted" style="font-weight:400">auth.token</span></label>
          <input class="input mono" type="password" data-cfg="token" ${dis}
                 value="${s.hasToken ? '********' : ''}" placeholder="不使用则留空">
          <div class="muted" style="font-size:12px;margin-top:6px;line-height:1.7">
            上面三项写进 <span class="mono">frpc.toml</span>。掩码表示保持原值不变。
          </div>
        </div>

        <div class="field" style="border-top:1px solid var(--border-soft);padding-top:16px">
          <label>frps dashboard 地址</label>
          <input class="input mono" data-cfg="frpsHost" value="${esc(s.host || '')}" placeholder="例如 1.2.3.4">
        </div>
        <div class="field">
          <label>dashboard 端口</label>
          <input class="input mono" type="number" min="1" max="65535" style="width:150px"
                 data-cfg="frpsPort" value="${esc(s.port || '')}" placeholder="7500">
        </div>
        <div class="row" style="gap:10px">
          <div class="field" style="margin:0;flex:1">
            <label>dashboard 账号</label>
            <input class="input mono" data-cfg="frpsUser" value="${esc(s.user || '')}">
          </div>
          <div class="field" style="margin:0;flex:1">
            <label>dashboard 密码</label>
            <input class="input mono" type="password" data-cfg="frpsPassword"
                   value="${s.hasPassword ? '********' : ''}">
          </div>
        </div>
        <div class="muted" style="font-size:12px;line-height:1.7">
          dashboard 这几项是<b>面板自己</b>的设置，不写进 frpc.toml。frpc 一侧没有字节统计，
          隧道吞吐只能从服务端的 dashboard 取，所以这里不填就看不到概览页的吞吐折线图。
        </div>
        ${hasToml ? '' : '<div class="warn-box" style="margin-top:12px">当前 frp 目录里没有 frpc.toml，上面三项暂时改不了。先去「FRP 管理」选好目录。</div>'}`;

      // 弹窗已经显示出来了，后台再取一次真实值。快照可能是过时的（配置被外部改过），
      // 拿旧值写回去会覆盖用户的配置。只填用户还没动过的框。
      api('/api/frp').then((ov) => {
        if (!ov.settings || !bodyEl.isConnected) return;
        const n = ov.settings;
        S.panel = { ...S.panel, frp: n };
        const fill = (name, oldV, newV) => {
          const el = bodyEl.querySelector(`[data-cfg="${name}"]`);
          if (el && el.value === oldV) el.value = newV;
        };
        fill('serverAddr', s.serverAddr || '', n.serverAddr || '');
        fill('serverPort', s.serverPort == null ? '' : String(s.serverPort), n.serverPort == null ? '' : String(n.serverPort));
        fill('token', s.hasToken ? '********' : '', n.hasToken ? '********' : '');
        fill('frpsHost', s.host || '', n.host || '');
        fill('frpsPort', s.port || '', n.port || '');
        fill('frpsUser', s.user || '', n.user || '');
        fill('frpsPassword', s.hasPassword ? '********' : '', n.hasPassword ? '********' : '');
      }).catch(() => {});
    },
    actions: [
      { label: '取消', variant: 'ghost' },
      {
        label: '保存',
        variant: 'primary',
        value: (bodyEl) => {
          const g = (k) => { const e = bodyEl.querySelector(`[data-cfg="${k}"]`); return e ? e.value.trim() : ''; };
          return {
            serverAddr: g('serverAddr'),
            serverPort: g('serverPort'),
            token: g('token'),
            frpsHost: g('frpsHost'),
            frpsPort: g('frpsPort'),
            frpsUser: g('frpsUser'),
            frpsPassword: g('frpsPassword'),
          };
        },
      },
    ],
  });
  if (!res) return;

  if (hasToml) {
    try {
      const r1 = await api('/api/frp/config', {
        method: 'PATCH',
        body: { serverAddr: res.serverAddr, serverPort: res.serverPort, token: res.token },
      });
      if (r1.frp) S.panel = { ...S.panel, frp: r1.frp };
    } catch (e) {
      toast('frpc.toml 没保存成功：' + e.message, 'err', 10000);
    }
  }
  try {
    const r2 = await api('/api/frp/settings', {
      method: 'PATCH',
      body: {
        frpsHost: res.frpsHost, frpsPort: res.frpsPort,
        frpsUser: res.frpsUser, frpsPassword: res.frpsPassword,
      },
    });
    if (r2.frp) S.panel = { ...S.panel, frp: r2.frp };
  } catch (e) {
    toast('dashboard 设置没保存成功：' + e.message, 'err', 10000);
  }
  await frpRefresh();
  toast('FRP 设置已保存', 'ok');
}
