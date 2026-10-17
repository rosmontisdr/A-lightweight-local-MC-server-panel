'use strict';
/* =========================================================================
   RS面板前端 · 启动设置 / 动作处理。无框架、无构建步骤，原生 JS + SVG 手绘图表。
   加载顺序：core → chart → views → panels → frp → dialogs。
   ========================================================================= */
/* ─────────────────────────── 启动设置 ─────────────────────────── */

/** 把 "-Xmx8G -Xms4G" 拆成数组并识别引号，行为与启动器 tokenize 一致 */
function tokenizeArgs(str) {
  const out = [];
  let cur = '';
  let quote = null;
  let has = false;
  for (const ch of String(str || '')) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; has = true; continue; }
    if (/\s/.test(ch)) {
      if (cur || has) { out.push(cur); cur = ''; has = false; }
      continue;
    }
    cur += ch;
  }
  if (cur || has) out.push(cur);
  return out;
}

/** 面板自身设置：端口、明暗模式、主题色 */
/** @param {{flash?:string}} [opts] flash 为要闪一下的 [data-card] 名，用来指认「就是这一项」 */

/** 高级设置弹窗的表单 HTML */
function panelSettingsForm(p, frpSet, curTheme, curAccent) {
  return `
    <div class="field">
      <label>面板端口</label>
      <div class="row">
        <input class="input mono" type="number" min="1024" max="65535" style="width:120px"
               data-port value="${p.port ?? ''}">
        <span class="muted" style="font-size:12px">1024 - 65535</span>
      </div>
      <div class="muted" style="font-size:12px;margin-top:6px">
        改完保存会<b>自动重启面板</b>并把浏览器切到新地址。当前实例由环境变量
        <span class="mono">MCPANEL_PORT</span> 指定时，这里的改动不会生效。
      </div>
      ${p.portFromEnv ? '<div class="danger-box" style="margin-top:8px">检测到 MCPANEL_PORT 环境变量，它优先级更高，端口改动会被忽略。</div>' : ''}
    </div>

    <div class="field">
      <label>明暗模式</label>
      <div class="seg" data-seg="theme">
        <button type="button" data-theme-opt="light" class="${curTheme === 'light' ? 'on' : ''}">浅色</button>
        <button type="button" data-theme-opt="dark" class="${curTheme === 'dark' ? 'on' : ''}">深色</button>
      </div>
    </div>

    <div class="field">
      <label>主题色</label>
      <div class="swatches">
        ${ACCENTS.map((a) => `
          <button type="button" class="swatch ${a.id === curAccent ? 'on' : ''}"
                  data-accent="${a.id}" title="${esc(a.label)}"
                  style="--sw:${a.color}">
            <span></span><em>${esc(a.label)}</em>
          </button>`).join('')}
      </div>
    </div>

    ${TOUCH.matches ? '' : `
    <div class="field">
      <label>允许跨站请求</label>
      <div class="seg" data-seg="xsite">
        <button type="button" data-xsite="0" class="${p.allowCrossSite ? '' : 'on'}">关闭</button>
        <button type="button" data-xsite="1" class="${p.allowCrossSite ? 'on' : ''}">开启</button>
      </div>
      <div class="muted" style="font-size:12px;margin-top:6px;line-height:1.7">
        默认关闭。开启前会再弹一次确认。
      </div>
    </div>`}

    <div class="field">
      <label>FRP 下载源</label>
      <div class="row">
        <input class="input mono" data-frp-mirror style="flex:1"
               value="${esc(frpSet.mirror || '')}" placeholder="下载镜像前缀，留空 = GitHub 官方">
      </div>
      <div class="row" style="margin-top:8px">
        <input class="input mono" data-frp-version style="flex:1"
               value="${esc(frpSet.version || '')}" placeholder="指定版本，如 0.71.0；留空则取最新">
      </div>
    </div>

    <div class="field" data-card="frp-setup">
      <label>FRP 目录</label>
      <div class="row">
        <input class="input mono" data-frp-dir style="flex:1" readonly value="${esc(frpSet.dir || '')}">
        <button class="btn btn-sm" data-frp-pick-dir>选择目录</button>
      </div>
    </div>

    <div class="field">
      <label>FRP 连接设置</label>
      <button class="btn btn-sm" data-frp-settings>FRP 设置…</button>
      <div class="muted" style="font-size:12px;margin-top:6px;line-height:1.7">
        frps 地址与端口、认证 token，以及画吞吐折线图用的 dashboard 地址与端口。
      </div>
    </div>

    <div class="field">
      <label>运行信息</label>
      <dl class="kv">
        <dt>版本</dt><dd>v${esc(p.version ?? '—')}</dd>
        <dt>进程 PID</dt><dd class="mono">${esc(p.pid ?? '—')}</dd>
        <dt>数据目录</dt><dd class="mono" style="font-size:11.5px;word-break:break-all">${esc(p.dataDir ?? '—')}</dd>
        <dt>后台日志</dt><dd class="mono" style="font-size:11.5px;word-break:break-all">${esc(p.logFile ?? 'data/panel.log')}</dd>
      </dl>
    </div>

    <div class="field" style="margin-bottom:0">
      <button class="btn btn-danger btn-sm" data-format>格式化面板…</button>
    </div>`;
}

/** 高级设置弹窗的事件接线 */
function bindPanelSettings(bodyEl, close, opts, frpSet) {
  // 明暗与主题色即时生效，无需等「保存」
  bodyEl.querySelector('[data-seg="theme"]').addEventListener('click', (e) => {
    const b = e.target.closest('[data-theme-opt]');
    if (!b) return;
    setTheme(b.dataset.themeOpt);
    for (const x of bodyEl.querySelectorAll('[data-theme-opt]')) {
      x.classList.toggle('on', x === b);
    }
    if (S.tab === 'overview') renderTab();
  });
  bodyEl.addEventListener('click', (e) => {
    const b = e.target.closest('[data-accent]');
    if (!b) return;
    setAccent(b.dataset.accent);
    for (const x of bodyEl.querySelectorAll('[data-accent]')) {
      x.classList.toggle('on', x === b);
    }
    if (S.tab === 'overview') renderTab();
  });

  // 跨站开关是安全边界，不即时生效，点击「保存」才提交。移动端不渲染此开关。
  bodyEl.querySelector('[data-seg="xsite"]')?.addEventListener('click', (e) => {
    const b = e.target.closest('[data-xsite]');
    if (!b) return;
    for (const x of bodyEl.querySelectorAll('[data-xsite]')) {
      x.classList.toggle('on', x === b);
    }
  });

  // 格式化有独立确认流程，不走 data-action 委托，直接挂按钮并先关闭本弹窗。
  bodyEl.querySelector('[data-format]').onclick = () => {
    close(null);
    formatPanel();
  };

  // FRP 设置是另一个弹窗，先关掉本弹窗再打开
  bodyEl.querySelector('[data-frp-settings]').onclick = () => {
    close(null);
    openFrpSettings();
  };

  // FRP 目录：选完立即保存，不必等「保存」
  bodyEl.querySelector('[data-frp-pick-dir]').onclick = async () => {
    const dir = await browseForDir(frpSet.dir || '');
    if (!dir) return;
    try {
      const r = await api('/api/frp/settings', { method: 'PATCH', body: { dir } });
      if (r.frp) S.panel = { ...S.panel, frp: r.frp };
      bodyEl.querySelector('[data-frp-dir]').value = (r.frp && r.frp.dir) || dir;
      invalidateFrp();
      toast('frp 目录已切换', 'ok', 3000);
    } catch (e) {
      toast(e.message, 'err');
    }
  };

  // 从别处跳进来时，把要指的那一项闪一下
  if (opts.flash) {
    const el = bodyEl.querySelector(`[data-card="${opts.flash}"]`);
    if (el) {
      el.classList.add('flash');
      setTimeout(() => el.classList.remove('flash'), 1800);
    }
  }
}

/** 从表单收集改动项 */
function collectPanelSettings(bodyEl) {
  const out = { port: bodyEl.querySelector('[data-port]').value.trim() };
  // 移动端无此开关，不提交该项。
  const xs = bodyEl.querySelector('[data-xsite="1"]');
  if (xs) out.allowCrossSite = xs.classList.contains('on');
  out.frpMirror = bodyEl.querySelector('[data-frp-mirror]').value.trim();
  out.frpVersion = bodyEl.querySelector('[data-frp-version]').value.trim();
  return out;
}

/** 提交高级设置改动；端口变更后引导重启跳转 */
async function submitPanelSettings(res, p, frpSet) {
  // FRP 下载源存的是另一处设置，先提交，且不影响面板本身的改动
  const frpBody = {};
  if ((res.frpMirror || '') !== (frpSet.mirror || '')) frpBody.mirror = res.frpMirror || '';
  if ((res.frpVersion || '') !== (frpSet.version || '')) frpBody.version = res.frpVersion || '';
  if (Object.keys(frpBody).length) {
    try {
      await api('/api/frp/settings', { method: 'PATCH', body: frpBody });
      S.panel = { ...S.panel, frpMirror: res.frpMirror, frpVersion: res.frpVersion };
      invalidateFrp();
    } catch (e) {
      toast('FRP 下载源没保存成功：' + e.message, 'err', 10000);
    }
  }

  // 两项设置各自判断变化，只提交变了的项。
  const body = {};
  const port = Number(res.port);
  if (port !== p.port) body.port = port;
  // 移动端不返回该项（开关未渲染），不参与比对。
  if (res.allowCrossSite != null && !!res.allowCrossSite !== !!p.allowCrossSite) {
    body.allowCrossSite = !!res.allowCrossSite;
  }
  if (!Object.keys(body).length) return toast('设置已更新', 'ok', 2000);

  // 仅在向不安全方向改动时拦截；取消只丢这一项，不连带丢弃端口改动。
  if (body.allowCrossSite === true && !(await confirmAllowCrossSite())) {
    delete body.allowCrossSite;
    if (!Object.keys(body).length) return toast('已取消，设置没有改动', 'info', 4000);
    toast('跨站请求仍保持关闭', 'warn', 5000);
  }

  let out;
  try {
    out = await api('/api/panel/settings', { method: 'PATCH', body });
  } catch (e) {
    return toast(e.message, 'err', 10000);
  }
  S.panel = { ...p, ...out };
  if (!out.restartRequired) return toast('设置已更新', 'ok', 2000);

  // 端口变更后重启并跳转到新地址。新端口已由服务端验证空闲，可安全跳转。
  await confirmDanger({
    title: '重启面板以切换端口',
    message: `面板会重启到端口 ${out.port}，浏览器随后自动跳转。`,
    detail: '正在运行的 Minecraft 服务器<b>不受影响</b>，会继续运行。',
    confirmLabel: '重启',
    tone: 'info',
  }).then(async (ok) => {
    if (!ok) return toast('端口已保存，下次启动面板时生效', 'warn', 6000);
    await api('/api/panel/restart', { method: 'POST', body: {} }).catch(() => {});
    // 沿用当前主机名。
    const target = `${location.protocol}//${location.hostname}:${out.port}/`;
    toast(`正在重启到 ${target} …`, 'info', 4000);
    gotoPanel(target);
  });
}

async function openPanelSettings(opts = {}) {
  const p = S.panel || {};
  const curTheme = document.documentElement.dataset.theme || 'dark';
  const curAccent = localStorage.getItem('mcpanel-accent') || 'green';
  // FRP 相关设置随面板信息一起下发，弹窗不必再发请求
  const frpSet = p.frp || {};

  const res = await openModal({
    title: '高级设置',
    // 端口只是其中一项，主题与配色更常用；不聚焦。
    autofocus: false,
    body: (bodyEl, close) => {
      bodyEl.innerHTML = panelSettingsForm(p, frpSet, curTheme, curAccent);
      bindPanelSettings(bodyEl, close, opts, frpSet);
    },
    actions: [
      { label: '取消', variant: 'ghost' },
      { label: '保存', variant: 'primary', value: (bodyEl) => collectPanelSettings(bodyEl) },
    ],
  });

  if (!res || res.port === '') return;
  await submitPanelSettings(res, p, frpSet);
}

/**
 * 重启后跳到面板的新地址。服务端不再另开标签页，须由本页自己过去。
 * 轮询新地址直到新进程就绪：同端口时用 pid 区分，旧进程尚未退出时不可跳。
 */

function gotoPanel(target, timeout = 30000) {
  const url = target.replace(/\/+$/, '') + '/';
  const sameOrigin = url.startsWith(location.origin);
  const oldPid = (S.panel && S.panel.pid) || 0;
  const deadline = Date.now() + timeout;
  const tick = async () => {
    if (Date.now() > deadline) {
      if ($('#toasts')) toast(`面板没有按时重启，请手动打开 ${url}`, 'err', 10000);
      return;
    }
    try {
      const res = await fetch(url + 'api/state', {
        cache: 'no-store',
        // 跨端口时读不到响应体（无 CORS 头），仅用于判断服务是否已应答
        ...(sameOrigin ? {} : { mode: 'no-cors' }),
      });
      if (sameOrigin) {
        const j = await res.json();
        if (!j.panel || j.panel.pid === oldPid) throw new Error('仍是旧进程');
      }
      // 用 replace 不改写历史：标签页的历史长度保持 1，之后才关得掉自己
      location.replace(url);
    } catch {
      setTimeout(tick, 400);
    }
  };
  // 旧进程退出、新进程绑定需要时间。
  setTimeout(tick, 900);
}

async function restartPanel() {
  const ok = await confirmDanger({
    title: '重启面板',
    message: '面板进程会重启，页面随后自动重新连接。',
    detail: '正在运行的 Minecraft 服务器<b>不受影响</b>，会继续运行。',
    confirmLabel: '重启',
    tone: 'info',
  });
  if (!ok) return;
  await api('/api/panel/restart', { method: 'POST', body: {} }).catch(() => {});
  toast('正在重启面板…', 'info', 5000);
  gotoPanel(location.origin + '/');
}

async function shutdownPanel() {
  const running = (S.servers || []).filter((s) => s.running);
  const ok = await confirmDanger({
    title: '关闭面板',
    message: '面板进程会退出，网页将无法再打开。要重新启动，双击目录里的 start.bat。',
    detail: running.length
      ? `正在运行的 ${running.length} 台服务器（${running.map((s) => esc(s.name)).join('、')}）<b>不会被关闭</b>，会继续运行。`
      : '当前没有正在运行的 Minecraft 服务器。',
    confirmLabel: '关闭面板',
    // 与「重启面板」同属中性操作：不可逆但不丢数据。
    tone: 'info',
  });
  if (!ok) return;
  try {
    await api('/api/panel/shutdown', { method: 'POST', body: {} });
  } catch { /* 进程退出时连接可能被切断，属正常 */ }
  document.body.innerHTML = `
    <div class="panel-closed">
      <div class="t1">面板已关闭</div>
      <div class="t2">这个页面可以关掉了。要重新启动，双击面板目录里的 <span class="mono">start.bat</span>。</div>
    </div>`;
}

/** 格式化面板：清空面板数据并重启。服务端见 POST /api/panel/format */
/**
 * 开启「允许跨站请求」前的确认框，与格式化同级的摩擦（红框 + 打字确认）。
 * 关闭该开关不走这里。
 */
function confirmAllowCrossSite() {
  return confirmDanger({
    title: '允许跨站请求',
    message: '开启后，你访问的任何网页都能在后台驱动这个面板。',
    detail:
      '面板只监听 <span class="mono">127.0.0.1</span> 而且没有密码，拦住跨站请求的只有一项检查：'
      + '请求来源（Origin）必须是 127.0.0.1 或 localhost。开启后这项检查就失效了。'
      + '<br>你浏览的<b>任何网站</b>都能在后台启动 / 停止 / 强制结束你的 Minecraft 服务器，'
      + '读写和删除服务器目录里的文件，改面板端口，甚至格式化面板。'
      + '<br>同一个局域网里的其他机器仍然连不上（监听地址没变），所以风险是「你访问的网页」，'
      + '不是「别人扫到你」。'
      + '<br><b>除非明确知道自己在做什么，否则保持关闭。</b>',
    confirmLabel: '开启',
    requireText: '开启',
    tone: 'danger',
  });
}

async function formatPanel() {
  const running = (S.servers || []).filter((s) => s.running);
  const ok = await confirmDanger({
    title: '格式化面板',
    // 说明放在这里，点开按钮才显示。
    message:
      '将清空服务器列表、面板设置（端口、明暗、主题色）、全部备份 zip 和面板日志，'
      + '回到刚解压出来的状态。此操作无法撤销。',
    detail:
      (running.length
        ? `正在运行的 ${running.length} 台服务器（${running.map((s) => esc(s.name)).join('、')}）<b>不会被关闭</b>，会继续运行。`
        : '当前没有正在运行的 Minecraft 服务器。')
      + '<br>服务器目录里的存档、模组、配置、服务器本体<b>一个都不会动</b>，'
      + '正在运行的服务器也不会被关掉 —— 只是面板不再记得它们，需要重新「添加服务器」。',
    confirmLabel: '格式化',
    // 真正删除数据，用红色并要求原样输入「格式化」才放行
    requireText: '格式化',
    tone: 'danger',
  });
  if (!ok) return;

  try {
    await api('/api/panel/format', { method: 'POST', body: { confirm: '格式化' } });
  } catch (e) {
    return toast(e.message, 'err', 10000);
  }

  // 端口设置在格式化后会被清空，不能 reload 当前 origin，
  // 须跳到重启后真正监听的地址。MCPANEL_PORT 优先级最高：存在时端口仍为当前值。
  const fromEnv = S.panel && S.panel.portFromEnv;
  // 沿用当前主机名。
  const port = fromEnv ? location.port : ((S.panel && S.panel.defaultPort) || 8080);
  const target = `${location.protocol}//${location.hostname}:${port}/`;

  // 页面即将被替换，先关闭 SSE。
  if (S.sse) { S.sse.close(); S.sse = null; }

  document.body.innerHTML = `
    <div class="panel-closed">
      <div class="t1">面板已格式化</div>
      <div class="t2">数据已清空，面板正在以默认设置重启……这个页面稍后会自动跳到
        <span class="mono">${esc(target)}</span>。</div>
    </div>`;
  gotoPanel(target);
}

async function openLaunchSettings() {
  const d = S.detail || {};
  const detected = d.launch || {};
  const saved = d.savedLaunch;
  // 有自定义配置则展示自定义，没有则展示自动探测结果
  const cur = saved && saved.programArgs ? saved : detected;

  const result = await openModal({
    title: '启动设置',
    wide: true,
    body: (bodyEl) => {
      bodyEl.innerHTML = `
      <div class="console-hint" style="border-radius:9px;margin-bottom:16px">
        面板只按这里的配置启动服务器，<b>不会自动改写你目录里的任何文件</b>。
        ${saved ? '当前使用你保存的自定义配置。' : '当前使用自动探测的结果。'}
      </div>

      <dl class="kv" style="margin-bottom:16px">
        <dt>自动探测</dt>
        <dd>${esc(typeLabel(detected.type))}
          ${detected.jar ? `<span class="mono muted"> ${esc(detected.jar)}</span>` : ''}
          ${detected.confidence === 'low' ? '<span class="tag" style="margin-left:6px">存疑</span>' : ''}</dd>
      </dl>
      ${detected.hint ? `<div class="muted" style="font-size:12.5px;margin:-8px 0 16px">${esc(detected.hint)}</div>` : ''}

      <div class="field">
        <label>java.exe 路径</label>
        <input class="input mono" data-lp value="${esc(cur.javaPath || 'java')}" autocomplete="off">
        <div class="desc">填 <span class="mono">java</span> 表示使用 PATH 中的 Java。也可以填完整路径，
          例如 <span class="mono">C:\\Program Files\\Java\\jdk-17\\bin\\java.exe</span>。</div>
      </div>

      <div class="field">
        <label>JVM 参数（空格分隔）</label>
        <input class="input mono" data-lj value="${esc((cur.jvmArgs || []).join(' '))}" autocomplete="off">
        <div class="desc">例如 <span class="mono">-Xmx8G -Xms4G</span>。留空表示使用 Java 默认堆大小。
          ${!saved && !(cur.jvmArgs || []).length
            ? '<b style="color:var(--warn)">当前为空：目录下没有 user_jvm_args.txt，直接启动会使用默认内存上限。</b>' : ''}</div>
      </div>

      <div class="field">
        <label>程序参数（空格分隔）</label>
        <input class="input mono" data-lpa value="${esc((cur.programArgs || []).join(' '))}" autocomplete="off">
        <div class="desc">决定实际加载什么，例如 <span class="mono">-jar fabric-server-launch.jar</span>
          或 <span class="mono">@libraries/net/minecraftforge/forge/1.20.1-47.2.0/win_args.txt</span>。不能为空。</div>
      </div>

      <label class="row" style="gap:7px;font-size:13px;cursor:pointer">
        <input type="checkbox" data-ln ${cur.nogui === false ? '' : 'checked'}>
        追加 nogui 参数（不弹服务端自己的窗口）
      </label>

      <div class="console-hint" data-lscriptnote hidden style="border-radius:9px;margin-top:14px">
        当前识别为<b>脚本启动</b>：面板会执行 <span class="mono">cmd /c &lt;程序参数&gt;</span>，
        上面填的 java 路径和 JVM 参数不参与启动（由你的脚本自己决定）。想改内存请编辑那个脚本。
      </div>

      <div class="field" style="margin-top:18px">
        <label>启动命令预览</label>
        <div class="mono" data-lpreview style="font-size:12px;line-height:1.8;color:var(--text-2);word-break:break-all;background:var(--surface-2);padding:10px 12px;border-radius:8px"></div>
      </div>`;

      // 脚本型与 java 型启动方式不同（cmd /c 与 java + JVM 参数）。预览、输入框禁用态、
      // 保存的 mode 共用此判断，保持一致。
      const resolveMode = (prog) => (
        cur.mode === 'script' || (prog.length === 1 && /\.(bat|cmd|sh|ps1)$/i.test(prog[0]))
          ? 'script' : 'java'
      );

      const upd = () => {
        const nogui = bodyEl.querySelector('[data-ln]').checked;
        const prog = tokenizeArgs(bodyEl.querySelector('[data-lpa]').value);
        const script = resolveMode(prog) === 'script';

        // 脚本模式下 java 路径与 JVM 参数无效，置灰。
        for (const sel of ['[data-lp]', '[data-lj]']) {
          bodyEl.querySelector(sel).disabled = script;
        }
        bodyEl.querySelector('[data-lscriptnote]').hidden = !script;

        const parts = script
          ? ['cmd.exe', '/c', ...prog, ...(nogui ? ['nogui'] : [])]
          : [
              bodyEl.querySelector('[data-lp]').value.trim() || 'java',
              ...tokenizeArgs(bodyEl.querySelector('[data-lj]').value),
              ...prog,
              ...(nogui ? ['nogui'] : []),
            ];
        // 带空格的参数在真实命令行中须加引号，预览照实显示
        bodyEl.querySelector('[data-lpreview]').textContent =
          parts.map((p) => (/[\s"]/.test(p) ? JSON.stringify(p) : p)).join(' ');
      };
      bodyEl.addEventListener('input', upd);
      bodyEl.addEventListener('change', upd);
      upd();
      // 供「保存」按钮复用同一判断。
      bodyEl.__resolveMode = resolveMode;
    },
    actions: [
      ...(saved ? [{ label: '恢复自动探测', value: '__reset__' }] : []),
      { label: '取消', value: null },
      {
        label: '保存',
        variant: 'primary',
        value: (el) => {
          const programArgs = tokenizeArgs(el.querySelector('[data-lpa]').value);
          if (!programArgs.length) throw new Error('程序参数不能为空 —— 面板不知道该加载什么');
          if (programArgs.some((a) => a.includes('\n') || a.includes('\r'))) {
            throw new Error('参数里不能有换行');
          }
          return {
            javaPath: el.querySelector('[data-lp]').value.trim() || 'java',
            jvmArgs: tokenizeArgs(el.querySelector('[data-lj]').value),
            programArgs,
            nogui: el.querySelector('[data-ln]').checked,
            // 与预览同一判断，所见即所存
            mode: el.__resolveMode(programArgs),
            // 保留识别出的元信息，用于决定 TPS 查询指令与界面显示
            type: detected.type,
            jar: detected.jar,
            loaderVersion: detected.loaderVersion,
            mcVersion: detected.mcVersion,
          };
        },
      },
    ],
  });

  if (result === '__reset__') {
    try {
      await api(`/api/servers/${S.current}`, { method: 'PATCH', body: { launch: null } });
      toast('已恢复为自动探测的启动配置', 'ok');
      await loadDetail(S.current);
      renderTab();
    } catch (e) { toast(e.message, 'err'); }
    return;
  }
  if (!result) return;

  try {
    await api(`/api/servers/${S.current}`, { method: 'PATCH', body: { launch: result } });
    toast('启动设置已保存，下次启动生效', 'ok');
    await loadDetail(S.current);
    renderTab();
  } catch (e) {
    toast(e.message, 'err');
  }
}

/* ─────────────────────────── 动作 ─────────────────────────── */

async function addServerFlow() {
  const result = await openModal({
    title: '添加服务器',
    wide: true,
    body: (el) => {
      el.innerHTML = `
        <div class="field">
          <label>服务器目录</label>
          <div class="row">
            <input class="input mono" data-dir placeholder="C:\\Users\\你\\Desktop\\server" autocomplete="off">
            <button class="btn" data-browse>浏览…</button>
          </div>
          <div class="desc">选择包含 server.properties 的目录</div>
        </div>
        <div class="field">
          <label>显示名称（可选）</label>
          <input class="input" data-name placeholder="留空则用目录名" autocomplete="off">
        </div>
        <div class="field" style="margin-bottom:0">
          <label>自动扫描到的服务器</label>
          <div data-discover class="muted" style="font-size:12.5px">正在扫描…</div>
        </div>`;

      el.querySelector('[data-browse]').onclick = async () => {
        const picked = await browseForDir(el.querySelector('[data-dir]').value.trim());
        if (!picked) return;
        el.querySelector('[data-dir]').value = picked;
        const n = el.querySelector('[data-name]');
        if (!n.value) n.value = picked.split(/[\\/]/).filter(Boolean).pop() || '';
      };

      // 委托挂在 el 上，扫描结果刷新 innerHTML 时监听不丢失
      el.addEventListener('click', (e) => {
        const b = e.target.closest('[data-pick]');
        if (!b) return;
        el.querySelector('[data-dir]').value = b.dataset.pick;
        const n = el.querySelector('[data-name]');
        if (!n.value) n.value = b.dataset.pick.split(/[\\/]/).filter(Boolean).pop() || '';
      });

      api('/api/discover').then((r) => {
        const box = el.querySelector('[data-discover]');
        if (!box) return;
        box.innerHTML = r.candidates.length
          ? r.candidates.map((c) => `<button type="button" class="btn btn-sm" style="margin:3px 6px 3px 0" data-pick="${esc(c.dir)}">
              ${esc(c.name)} <span class="muted" style="font-size:11px">${esc(c.type)}${c.mods ? ` · ${c.mods} mods` : ''}</span>
            </button>`).join('')
          : '<span class="muted">没有找到现成的服务器，可以直接填写目录路径。</span>';
      }).catch((err) => {
        const box = el.querySelector('[data-discover]');
        if (box) box.textContent = '扫描失败：' + err.message;
      });
    },
    actions: [
      { label: '取消', value: null },
      {
        label: '添加',
        variant: 'primary',
        value: (el) => {
          const dir = el.querySelector('[data-dir]').value.trim();
          if (!dir) throw new Error('请填写服务器目录');
          return { dir, name: el.querySelector('[data-name]').value.trim() || undefined };
        },
      },
    ],
  });

  if (!result) return;
  try {
    const r = await api('/api/servers', { method: 'POST', body: result });
    toast(`已添加：${r.server.name}`, 'ok');
    await loadState();
    await selectServer(r.server.id);
  } catch (e) {
    toast(e.message, 'err', 9000);
  }
}

/** 目录选择器弹窗，导航状态在内部维护。 */
function browseForDir(startPath) {
  return new Promise((resolve) => {
    const back = document.createElement('div');
    back.className = 'modal-back';
    back.innerHTML = `
      <div class="modal wide" role="dialog" aria-modal="true">
        <div class="modal-head">选择服务器目录</div>
        <div class="modal-body" data-body></div>
        <div class="modal-foot">
          <button class="btn" data-cancel>取消</button>
          <button class="btn btn-primary" data-pick>选择此目录</button>
        </div>
      </div>`;
    $('#modalRoot').appendChild(back);

    let lastGood = null;
    const entry = () => close(null);
    const close = (v) => {
      back.remove();
      const i = modalStack.indexOf(entry);
      if (i >= 0) modalStack.splice(i, 1);
      resolve(v);
    };
    modalStack.push(entry);
    back.addEventListener('mousedown', (e) => { if (e.target === back) close(null); });
    back.querySelector('[data-cancel]').onclick = () => close(null);
    back.querySelector('[data-pick]').onclick = () => close(lastGood);

    const bodyEl = back.querySelector('[data-body]');
    bodyEl.addEventListener('click', (e) => {
      const b = e.target.closest('[data-nav]');
      if (b) load(b.dataset.nav);
    });

    async function load(p) {
      bodyEl.innerHTML = '<div class="muted" style="padding:20px">读取中…</div>';
      let d;
      try {
        d = await api('/api/browse' + (p ? `?path=${encodeURIComponent(p)}` : ''));
      } catch (err) {
        bodyEl.innerHTML = `<div class="danger-box">${esc(err.message)}</div>`;
        return;
      }
      lastGood = d.path;
      bodyEl.innerHTML = `
        <div class="row" style="margin-bottom:10px">
          <input class="input mono" value="${esc(d.path)}" readonly>
        </div>
        <div class="row" style="margin-bottom:10px;flex-wrap:wrap">
          ${d.roots.map((r) => `<button type="button" class="btn btn-sm" data-nav="${esc(r)}">${esc(r)}</button>`).join('')}
          ${d.parent ? `<button type="button" class="btn btn-sm btn-ghost" data-nav="${esc(d.parent)}">↑ 上级目录</button>` : ''}
        </div>
        <div class="dir-list">
          ${d.entries.map((e) => `<button type="button" class="dir-item" data-nav="${esc(e.path)}">
            ${fileIcon('dir')}<span>${esc(e.name)}</span>
            ${e.isServer ? '<span class="srv-hint">Minecraft 服务器</span>' : ''}
          </button>`).join('') || '<div class="muted" style="padding:16px">此目录下没有子目录</div>'}
        </div>`;
    }

    load(startPath || '');
  });
}

async function serverAction(action) {
  const id = S.current;
  const st = currentStatus();
  if (!id) return;
  try {
    if (action === 'start') {
      S.busy.add('start'); renderHeader();
      await api(`/api/servers/${id}/start`, { method: 'POST' });
      toast('启动指令已发出，切换到「控制台」可以看到实时输出', 'info', 7000);
    } else if (action === 'stop') {
      const ok = await openModal({
        title: '停止服务器',
        body: `<div class="warn-box">面板会向服务器发送 <b>stop</b> 指令，等待它保存存档后正常退出。这个过程可能需要几十秒。</div>
               <div class="muted" style="font-size:12.5px">如果服务器卡住不响应，可以改用「强制结束」，但可能丢失未保存的数据。</div>`,
        actions: [{ label: '取消', value: null }, { label: '停止', value: 'ok', variant: 'primary' }],
      });
      if (ok !== 'ok') return;
      S.busy.add('stop'); renderHeader();
      await api(`/api/servers/${id}/stop`, { method: 'POST' });
      toast('正在优雅关服…', 'info');
    } else if (action === 'restart') {
      const ok = await confirmDanger({
        title: '重启服务器',
        message: '将先停止服务器（等待存档保存），再重新启动。玩家会被断开连接。',
        confirmLabel: '重启',
      });
      if (!ok) return;
      await api(`/api/servers/${id}/restart`, { method: 'POST' });
      toast('正在重启…', 'info');
    } else if (action === 'kill') {
      const ok = await confirmDanger({
        title: '强制结束进程',
        message: '这会立即杀掉 Java 进程，服务器来不及保存存档，最近几分钟的进度可能丢失。',
        detail: `目标进程 PID：<b class="mono">${st?.pid ?? '未知'}</b>`,
        confirmLabel: '强制结束',
      });
      if (!ok) return;
      await api(`/api/servers/${id}/kill`, { method: 'POST' });
      toast('已发送强制结束指令', 'warn');
    }
  } catch (e) {
    toast(e.message, 'err', 12000);
  } finally {
    S.busy.delete('start');
    S.busy.delete('stop');
    renderHeader();
  }
}

/** 从面板移除服务器；id 省略时作用于当前选中项。 */
async function removeServer(id = S.current) {
  const st = (S.servers || []).find((s) => s.id === id);
  if (!st) return;
  const ok = await confirmDanger({
    title: '从面板移除服务器',
    message: '只会把服务器从面板列表里移除，磁盘上的文件一个都不会动。',
    detail: `目录：<span class="mono">${esc(st.dir)}</span>`,
    confirmLabel: '移除',
  });
  if (!ok) return;
  try {
    await api(`/api/servers/${id}`, { method: 'DELETE' });
    toast('已移除', 'ok');
    S.history.delete(id);
    if (id === S.current) {
      S.current = null;
      S.detail = null;
      if (S.sse) { S.sse.close(); S.sse = null; S.sseServer = null; }
      await loadState();
      if (S.servers.length) await selectServer(S.servers[0].id);
      else renderTab();
    } else {
      await loadState();
    }
  } catch (e) {
    toast(e.message, 'err');
  }
}


boot();
