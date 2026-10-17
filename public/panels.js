'use strict';
/* =========================================================================
   RS面板前端 · 控制台 / 文件 / 玩家 / 配置 / 拖拽上传。无框架、无构建步骤，原生 JS + SVG 手绘图表。
   加载顺序：core → chart → views → panels → frp → dialogs。
   ========================================================================= */
/* ─────────────────────────── 控制台 ─────────────────────────── */

function renderConsole(content, st) {
  const d = S.detail || {};
  const foreignRcon = !!d.rcon?.blocked;
  const controllable = (st.managed || d.rcon?.available) && !foreignRcon;
  // 面板重启会失去 stdin 通道，此时服务器仍在运行，与「非面板启动」是两回事，提示要分开。
  const noConsoleHint = foreignRcon
    ? `RCON 端口 <b class="mono">${esc(String(d.rcon?.port ?? ''))}</b> 上监听的不是这台服务器，多半是另一台服务器用了同一个 <b>rcon.port</b>。
       面板不会向它发指令以免打错服务器。请把其中一台的 <b>rcon.port</b>（server.properties）改成不同端口并重启该服务器。`
    : st.stdinLost
      ? `面板重启过，已失去这台服务器的控制台通道（Windows 不允许重新接上别的进程的 stdin）。服务器仍在运行，下面的日志来自 logs/latest.log。
       想要发送指令，请在 server.properties 中设置 <b>enable-rcon=true</b> 与 <b>rcon.password=一个密码</b>，重启服务器后即可；要立即关服请用「强制结束」。`
      : `这台服务器不是由面板启动的，面板无法直接向它的控制台发送指令。
       下面的日志来自 logs/latest.log（含末尾一段历史，其后新增的内容会继续接上）。
       想要发送指令，请在 server.properties 中设置 <b>enable-rcon=true</b> 与 <b>rcon.password=一个密码</b>，重启服务器后即可。`;
  content.innerHTML = `
    ${controllable ? '' : `<div class="console-hint">⚠ ${noConsoleHint}</div>`}
    <div class="quick-cmds">
      ${['list', 'save-all', 'tick query', 'time set day', 'weather clear', 'whitelist list']
        .map((c) => `<button class="btn btn-sm" data-action="quick-cmd" data-cmd="${esc(c)}">${esc(c)}</button>`).join('')}
      <button class="btn btn-sm btn-ghost" data-action="clear-console" style="margin-left:auto">清屏</button>
    </div>
    <div class="console">
      <div class="console-scroll">
        <div class="console-body" id="consoleBody"></div>
        <button class="console-jump" data-action="console-jump" title="跳到最新日志" aria-label="跳到最新日志">
          <svg viewBox="0 0 16 16" width="18" height="18" fill="none" stroke="currentColor"
               stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <path d="M8 3.5v9M3.8 8.6 8 12.9l4.2-4.3"/></svg>
        </button>
      </div>
      <div class="console-input">
        <input id="consoleInput" class="mono" placeholder="${controllable ? '输入指令后回车，例如：say 大家好' : foreignRcon ? 'RCON 端口被其它服务器占用，无法发送指令' : '该服务器未启用 RCON，无法发送指令'}"
               ${controllable ? '' : 'disabled'} autocomplete="off" spellcheck="false">
        <button class="btn btn-primary" data-action="send-cmd" ${controllable ? '' : 'disabled'}>发送</button>
      </div>
    </div>`;

  const body = $('#consoleBody');
  body.innerHTML = '';
  // 待插入的行已在 S.logs 里，重画会一并铺出来，这里丢掉队列免得重复
  pendingLogs = [];
  // 渲染窗口与 server.js 的 SSE_LOG_BACKLOG 同宽
  for (const l of S.logs.slice(-1200)) body.appendChild(logNode(l));
  // 锁着就跟到底；用户翻上去过就回到原处——重画不该把人从正在看的地方拽走
  if (S.autoScroll) pinConsole();
  else restoreConsoleScroll();
  updateConsoleJump();

  const input = $('#consoleInput');
  if (input && controllable) {
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); sendConsole(); }
      if (e.key === 'ArrowUp') { e.preventDefault(); historyNav(-1); }
      if (e.key === 'ArrowDown') { e.preventDefault(); historyNav(1); }
    });
  }

  // 用户主动滚动的入口。滚轮/触摸/按键/拖滚动条都算，只认这几秒内的动作。
  const markUserScroll = () => { S.userScrollAt = Date.now(); };
  for (const ev of ['wheel', 'touchstart', 'touchmove', 'mousedown', 'keydown']) {
    body.addEventListener(ev, markUserScroll, { passive: true });
  }

  body.addEventListener('scroll', () => {
    S.consoleScrollTop = body.scrollTop;
    if (Date.now() - (S.userScrollAt || 0) < USER_SCROLL_MS) {
      // 用户刚动过手：滑到底（留 30px 余量）重新锁定，往上翻就解锁
      S.autoScroll = atConsoleBottom(body);
    } else if (!S.autoScroll && atConsoleBottom(body)) {
      // 没动手时只允许重新锁定。反过来（按几何判断去解锁）会把日志暴涨时的
      // 程序性跟随误判成「用户翻走了」，锁一关就再也跟不住。
      S.autoScroll = true;
    }
    updateConsoleJump();
  });
}

// 认定「用户正在动手滚」的时间窗：触摸惯性滚动会在手指离开后继续，窗口给宽一点
const USER_SCROLL_MS = 500;

function atConsoleBottom(body) {
  return body.scrollTop + body.clientHeight >= body.scrollHeight - 30;
}

function restoreConsoleScroll() {
  const body = $('#consoleBody');
  if (!body || !S.consoleScrollTop) return;
  body.scrollTop = Math.min(S.consoleScrollTop, body.scrollHeight);
}

/** 已经在最底端就没什么可跳的，把圆钮收起来；翻上去了才出现 */
function updateConsoleJump() {
  const btn = $('.console-jump');
  if (btn) btn.hidden = S.autoScroll;
}

/** 清屏：缓冲区、DOM、待插队列一并清掉，并回到「锁定最底端」 */
function clearConsole() {
  S.logs = [];
  pendingLogs = [];
  const body = $('#consoleBody');
  if (body) body.innerHTML = '';
  S.autoScroll = true;
  S.consoleScrollTop = 0;
  updateConsoleJump();
}

/** 跳回日志最底端并重新锁定，顺带把攒着的日志先铺出来 */
function jumpConsoleBottom() {
  if (flushPending) flushLogs();
  S.autoScroll = true;
  pinConsole();
  updateConsoleJump();
}

const cmdHistory = [];
let cmdHistoryIdx = -1;

function historyNav(dir) {
  const input = $('#consoleInput');
  if (!input || !cmdHistory.length) return;
  cmdHistoryIdx = Math.max(-1, Math.min(cmdHistory.length, cmdHistoryIdx + (dir === -1 ? 1 : -1)));
  input.value = cmdHistoryIdx === -1 ? '' : cmdHistory[cmdHistoryIdx] || '';
  input.setSelectionRange(input.value.length, input.value.length);
}

async function sendConsole() {
  const input = $('#consoleInput');
  const cmd = input?.value?.trim();
  if (!cmd) return;
  input.value = '';
  cmdHistory.unshift(cmd);
  if (cmdHistory.length > 60) cmdHistory.pop();
  cmdHistoryIdx = -1;
  try {
    await api(`/api/servers/${S.current}/command`, { method: 'POST', body: { command: cmd } });
  } catch (e) {
    toast(e.message, 'err', 9000);
  }
}

function logNode(l) {
  const el = document.createElement('div');
  el.className = 'log-line log-' + classifyLog(l);
  el.innerHTML = `<span class="log-time">${fmtTime(l.t)}</span><span class="log-text"></span>`;
  el.lastElementChild.textContent = l.line;
  return el;
}

function classifyLog(l) {
  if (l.stream === 'panel') return 'panel';
  if (l.stream === 'cmd') return 'cmd';
  if (l.stream === 'rcon') return 'rcon';
  if (l.stream === 'err') return 'err';
  const s = l.line;
  // 对话先判定。
  if (isPlayerChat(s)) return 'chat';
  if (/\b(ERROR|FATAL|Exception|Caused by)\b/.test(s)) return 'err';
  if (/\bWARN(ING)?\b/.test(s)) return 'warn';
  if (/(joined the game|left the game|玩家.*加入|Player.*logged in)/i.test(s)) return 'join';
  return 'out';
}

/**
 * 玩家对话。服务端日志形如 `… [Server thread/INFO]: <玩家名> 内容`，
 * 1.19 起未签名的消息前多一个 [Not Secure]；玩家名本身可能含方括号（如 daidaitou[The Priest]）。
 * 要求 `>` 后接空格与内容。
 */
function isPlayerChat(s) {
  return /\]: (?:\[Not Secure\] )?<[^<>]{1,32}> \S/.test(s);
}

function appendLog(l) {
  S.logs.push(l);
  if (S.logs.length > 3000) S.logs.splice(0, S.logs.length - 3000);
  if (S.tab !== 'console') return;
  pendingLogs.push(l);
  // 入 DOM 与钉底端必须在同一帧里做完，见 flushLogs
  if (!flushPending) {
    flushPending = true;
    requestAnimationFrame(flushLogs);
  }
}

// 待入 DOM 的日志行。一行一次 appendChild 在日志暴涨时跟不上，
// 且插入与滚动分处两个任务会让「跟住」在中间那一瞬被误判成「已翻上去」（见 flushLogs 的说明）
let pendingLogs = [];
let flushPending = false;

/**
 * 一帧一次：把攒下的日志一次性插进去、裁掉过量的旧行、再钉到最底端，全在同一帧内完成。
 * 顺序很要紧 —— 若先插内容、等下一帧再滚，浏览器在两者之间就会派发 scroll 事件，
 * 那时读到的是「内容长了、位置还没跟上」，照着判断就会把自动锁自己关掉，于是暴涨时卡在半路。
 */
function flushLogs() {
  flushPending = false;
  const body = $('#consoleBody');
  if (!body) { pendingLogs = []; return; }
  if (pendingLogs.length) {
    const frag = document.createDocumentFragment();
    for (const l of pendingLogs) frag.appendChild(logNode(l));
    pendingLogs = [];
    body.appendChild(frag);
    if (body.childElementCount > CONSOLE_DOM_LIMIT) trimConsole(body);
  }
  pinConsole();
}

// DOM 里保留的行数上限。与 server.js 的 SSE_LOG_BACKLOG（1200）同理，只留看得见的一段
const CONSOLE_DOM_LIMIT = 1500;

/**
 * 裁掉超量的旧行。跟住状态无所谓；用户正停在上头看时，删掉的行会让内容整体往上蹿
 * （浏览器不为此补偿），必须把腾出的高度还回滚动位置，否则视野会被一行行推着往下跑，
 * 日志暴涨时几秒钟就滑出几千像素。
 */
function trimConsole(body) {
  const before = body.scrollTop;
  const h0 = body.scrollHeight;
  while (body.childElementCount > CONSOLE_DOM_LIMIT) body.removeChild(body.firstElementChild);
  if (!S.autoScroll) body.scrollTop = before - (h0 - body.scrollHeight);
}

/** 钉到最底端。锁着才钉；调用点都在内容入 DOM 的同一帧里 */
function pinConsole() {
  const body = $('#consoleBody');
  if (body && S.autoScroll) body.scrollTop = body.scrollHeight;
}

/* ─────────────────────────── 文件管理 ─────────────────────────── */

async function loadFiles(path) {
  const id = S.current;
  const data = await api(`/api/servers/${id}/files?path=${encodeURIComponent(path)}`);
  if (S.current !== id) return;
  S.filePath = path;
  S.view.files = data;
  if (S.tab === 'files') renderTab();
}

function renderFiles(content, st) {
  const d = S.view.files;
  if (!d) {
    content.innerHTML = `<div class="empty">正在读取目录…</div>`;
    S.view.filesLimit = 200;
    loadFiles(S.filePath || '').catch((e) => toast(e.message, 'err'));
    return;
  }
  // 大目录分页渲染，不一次注入数百行
  const limit = S.view.filesLimit || 200;
  const shown = d.entries.slice(0, limit);
  const crumbs = [{ label: '根目录', path: '' }];
  let acc = '';
  for (const part of (d.path || '').split('/').filter(Boolean)) {
    acc = acc ? acc + '/' + part : part;
    crumbs.push({ label: part, path: acc });
  }

  content.innerHTML = `
    <div class="row-between">
      <div class="breadcrumb">
        ${crumbs.map((c, i) => `${i ? '<span class="sep">/</span>' : ''}<button data-action="nav-dir" data-path="${esc(c.path)}">${esc(c.label)}</button>`).join('')}
      </div>
      <div class="row">
        <!-- 触摸设备上没有拖拽，窄屏由 CSS 藏掉 -->
        <span class="muted drag-hint" style="font-size:12px">也可把文件或文件夹直接拖进本页</span>
        <button class="btn btn-sm" data-action="mkdir">新建文件夹</button>
        <button class="btn btn-sm" data-action="upload">上传文件</button>
        <button class="btn btn-sm" data-action="jump-parent" ${d.parent == null ? 'disabled' : ''}>返回上级</button>
      </div>
    </div>

    ${d.important?.length && !d.path ? `
      <div class="card" style="margin-bottom:14px">
        <div class="card-head"><div class="card-title">快捷入口</div></div>
        <div class="row" style="flex-wrap:wrap">
          ${d.important.map((f) => `<button class="btn btn-sm" data-action="open-file" data-path="${esc(f.name)}">${esc(f.label)}<span class="muted mono" style="margin-left:6px;font-size:11px">${esc(f.name)}</span></button>`).join('')}
        </div>
      </div>` : ''}

    <div class="card" style="padding:6px 0">
      <div class="table-scroll">
      <table class="file-table">
        <thead><tr><th>名称</th><th class="num col-size">大小</th><th class="num col-time">修改时间</th><th class="ops">操作</th></tr></thead>
        <tbody>
          ${shown.map((e) => `
            <tr class="${e.kind === 'important' ? 'file-row-imp' : ''}">
              <td><div class="fname" data-action="${e.isDir ? 'nav-dir' : 'open-file'}" data-path="${esc(joinPath(d.path, e.name))}">
                ${fileIcon(e.kind)}<span class="nm">${esc(e.name)}</span>${e.ext ? `<span class="ftype">${esc(e.ext)}</span>` : ''}</div></td>
              <td class="num col-size">${e.isDir ? '—' : fmtBytes(e.size)}</td>
              <td class="num col-time">${fmtDateTime(e.mtime)}</td>
              <td class="ops">
                ${!e.isDir ? `<button class="btn btn-sm btn-ghost" data-action="download" data-path="${esc(joinPath(d.path, e.name))}">下载</button>` : ''}
                ${e.kind === 'zip'
                  ? `<button class="btn btn-sm btn-ghost" data-action="unzip" data-path="${esc(joinPath(d.path, e.name))}" data-name="${esc(e.name)}">解压</button>`
                  : `<button class="btn btn-sm btn-ghost" data-action="zip" data-path="${esc(joinPath(d.path, e.name))}" data-name="${esc(e.name)}">压缩</button>`}
                <button class="btn btn-sm btn-ghost" data-action="rename" data-path="${esc(joinPath(d.path, e.name))}" data-name="${esc(e.name)}">重命名</button>
                <button class="btn btn-sm btn-ghost" style="color:var(--critical)" data-action="delete" data-path="${esc(joinPath(d.path, e.name))}" data-name="${esc(e.name)}" data-dir="${e.isDir}">删除</button>
              </td>
            </tr>`).join('') || '<tr><td colspan="4" class="muted" style="padding:22px;text-align:center">空目录</td></tr>'}
        </tbody>
      </table>
      </div>
    </div>
    ${d.entries.length > limit ? `<button class="btn btn-sm btn-ghost" data-action="files-more" style="width:100%;margin-top:8px">显示更多（已显示 ${limit} / ${d.entries.length}）</button>` : ''}`;
}

function joinPath(dir, name) {
  return dir ? `${dir}/${name}` : name;
}

/* ── 压缩 / 解压 ──
   前端只负责询问输出名与目标目录、并提示耗时；结果提示由后端 broadcast 的 notice 发出。 */

/** 长任务期间挂一条提示，结束即撤；结果由后端 notice 报告。 */
async function withProgress(msg, fn) {
  const t = toast(msg, 'info', 600000);
  try {
    return await fn();
  } finally {
    t.remove();
  }
}

/** 压缩当前目录下的文件 / 文件夹，输出到当前目录 */
async function zipEntry(name) {
  const dir = S.filePath || '';
  const out = await openModal({
    title: '压缩',
    body: `
      <div class="muted" style="font-size:12.5px;line-height:1.7;margin-bottom:12px">
        把 <b class="mono">${esc(name)}</b> 打包成 zip，放在
        <span class="mono">${esc(dir || '根目录')}</span> 下。
      </div>
      <div class="field mb0">
        <label>输出文件名</label>
        <input class="input mono" data-zip-out value="${esc(name)}.zip" autocomplete="off">
      </div>`,
    actions: [
      { label: '取消', value: null },
      {
        label: '压缩',
        variant: 'primary',
        value: (elm) => {
          const v = elm.querySelector('[data-zip-out]').value.trim();
          if (!v) throw new Error('请填写输出文件名');
          return v;
        },
      },
    ],
  });
  if (!out) return;

  const url = `/api/servers/${S.current}/files/compress`;
  const base = { path: dir, name, out };
  try {
    await withProgress(`正在压缩 ${name}…`, () => api(url, { method: 'POST', body: base }));
  } catch (e) {
    if (!e.data?.conflict) return toast(e.message, 'err', 12000);
    // 同名压缩包不静默覆盖，先确认
    const go = await confirmDanger({
      title: '同名文件已存在',
      message: e.message + '，继续会覆盖它。',
      detail: '覆盖之后原来那个压缩包就找不回来了。',
      confirmLabel: '覆盖',
    });
    if (!go) return toast('已取消，没有压缩', 'info', 4000);
    try {
      await withProgress(`正在压缩 ${name}…`, () =>
        api(url, { method: 'POST', body: { ...base, overwrite: true } }));
    } catch (e2) {
      return toast(e2.message, 'err', 12000);
    }
  }
  loadFiles(dir).catch((e) => toast(e.message, 'err'));
}

/** 解压：先预览包内容与默认目标目录，再让用户确认 */
async function unzipEntry(zipPath, name) {
  let info;
  try {
    info = await api(`/api/servers/${S.current}/files/archive/preview`, {
      method: 'POST',
      body: { path: zipPath },
    });
  } catch (e) {
    return toast(e.message, 'err', 10000);
  }

  // 越界条目（zip-slip）：整包拒绝，合法条目也不解
  if (info.unsafe) {
    return confirmDanger({
      title: '压缩包已拒绝',
      message: `包里检出 ${info.unsafe} 个越界条目，例如 ${info.unsafeFirst}`,
      detail: '这类条目会把文件写到服务器目录外面去，所以这个包整个都不解压。',
      confirmLabel: '知道了',
      tone: 'info',
    });
  }

  const parent = S.filePath || '';
  // 包内已有根文件夹时默认解到当前目录。
  const def = info.mode === 'here' ? '' : info.suggestDir;

  const whereOf = (into) => (parent ? parent + '/' : '') + (into ? into + '/' : '');
  const noteOf = (into) =>
    into && info.mode === 'here'
      ? `<div class="muted" style="font-size:12px;margin-top:8px;line-height:1.7">
           包里已经有一层 <span class="mono">${esc(info.tops[0] || '')}/</span>，再套一层会变成两层。
         </div>`
      : '';

  const res = await openModal({
    title: '解压',
    body: (bodyEl) => {
      bodyEl.innerHTML = `
        <div class="muted" style="font-size:12.5px;line-height:1.7">
          <span class="mono">${esc(name)}</span>：${info.entries} 个文件，解压后约 ${fmtBytes(info.bytes)}
          ${info.dirs ? `（另有 ${info.dirs} 个目录）` : ''}
        </div>
        <div class="field" style="margin-top:14px;margin-bottom:0">
          <label>解压到</label>
          <div class="seg" data-seg="into">
            <button type="button" data-into="${esc(info.suggestDir)}" class="${def === info.suggestDir ? 'on' : ''}">新文件夹</button>
            <button type="button" data-into="" class="${def === '' ? 'on' : ''}">当前目录</button>
          </div>
          <div data-into-info style="margin-top:9px"></div>
        </div>
        <div class="muted" style="font-size:12px;margin-top:12px;line-height:1.7">
          目标里已经存在的同名文件会跳过，不会被覆盖。
        </div>`;
      // 切换目标就地更新该行，无需重新预览
      const paint = (into) => {
        const where = whereOf(into);
        bodyEl.querySelector('[data-into-info]').innerHTML =
          `<div class="mono" style="font-size:12.5px">解压到 ${esc(where || '服务器目录根')}</div>` + noteOf(into);
      };
      paint(def);
      bodyEl.querySelector('[data-seg="into"]').addEventListener('click', (ev) => {
        const btn = ev.target.closest('[data-into]');
        if (!btn) return;
        for (const b of bodyEl.querySelectorAll('[data-into]')) b.classList.toggle('on', b === btn);
        paint(btn.dataset.into);
      });
    },
    actions: [
      { label: '取消', value: null },
      {
        label: '解压',
        variant: 'primary',
        // 返回对象而非字符串。
        value: (elm) => ({ into: elm.querySelector('[data-into].on').dataset.into }),
      },
    ],
  });
  if (!res) return;

  try {
    await withProgress(`正在解压 ${name}…`, () =>
      api(`/api/servers/${S.current}/files/extract`, {
        method: 'POST',
        body: { path: zipPath, into: res.into },
      }));
  } catch (e) {
    return toast(e.message, 'err', 14000);
  }
  loadFiles(parent).catch((e) => toast(e.message, 'err'));
}

async function openFile(path) {
  try {
    const d = await api(`/api/servers/${S.current}/file?path=${encodeURIComponent(path)}`);
    const content = $('#content');
    content.innerHTML = `
      <div class="row-between" style="margin-bottom:12px">
        <div class="row">
          <button class="btn btn-sm btn-ghost" data-action="close-file">← 返回目录</button>
          <span class="mono" style="font-size:13px">${esc(path)}</span>
          <span class="tag">${esc(d.encoding)}</span>
          <span class="muted" style="font-size:12px">${fmtBytes(d.size)}</span>
        </div>
        <div class="row">
          <span class="muted" style="font-size:12px" id="editorStatus"></span>
          <button class="btn btn-sm" data-action="revert-file" data-path="${esc(path)}">还原</button>
          <button class="btn btn-sm btn-primary" data-action="save-file" data-path="${esc(path)}">保存 (Ctrl+S)</button>
        </div>
      </div>
      <textarea class="editor" id="editor" spellcheck="false">${esc(d.content)}</textarea>
      <div class="muted" style="font-size:12px;margin-top:8px">
        保存时会自动把原文件备份为 <span class="mono">${esc(path)}.bak</span>。
      </div>`;

    const ta = $('#editor');
    ta.addEventListener('input', () => {
      const s = $('#editorStatus');
      if (s) s.textContent = '未保存的修改';
    });
    ta.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); saveFile(path); }
      if (e.key === 'Tab') {
        e.preventDefault();
        const s = ta.selectionStart;
        ta.value = ta.value.slice(0, s) + '  ' + ta.value.slice(ta.selectionEnd);
        ta.selectionStart = ta.selectionEnd = s + 2;
      }
    });
    ta.focus();
  } catch (e) {
    toast(e.message, 'err', 9000);
  }
}

async function saveFile(path) {
  const ta = $('#editor');
  if (!ta) return;
  try {
    await api(`/api/servers/${S.current}/file`, { method: 'PUT', body: { path, content: ta.value } });
    toast(`已保存 ${path}`, 'ok');
    const s = $('#editorStatus');
    if (s) s.textContent = '';
  } catch (e) {
    toast(e.message, 'err');
  }
}

/* ─────────────────────────── 玩家 ─────────────────────────── */

function renderPlayers(content, st) {
  const d = S.view.players;
  if (!d) {
    content.innerHTML = `<div class="empty">正在读取玩家数据…</div>`;
    const id = S.current;
    api(`/api/servers/${id}/players`)
      .then((r) => {
        if (S.current !== id) return;
        S.view.players = r; if (S.tab === 'players') renderTab();
      })
      .catch((e) => toast(e.message, 'err'));
    return;
  }

  const listCard = (kind) => {
    const L = d.lists[kind];
    return `<div class="card">
      <div class="card-head">
        <div class="card-title">${esc(L.label)}</div>
        <div class="card-sub">${L.entries.length} 项</div>
        <div class="card-actions">
          <button class="btn btn-sm" data-action="add-player" data-kind="${kind}">添加</button>
        </div>
      </div>
      ${L.entries.length ? `<table class="file-table">
        <tbody>
        ${L.entries.map((e) => {
          const key = e[L.key];
          const extra = kind === 'ops' ? `等级 ${e.level ?? 4}`
            : kind === 'banned' ? esc(e.reason || '')
            : kind === 'banned-ips' ? esc(e.reason || '')
            : esc(e.uuid || '').slice(0, 13) + '…';
          return `<tr>
            <td><div class="row"><span>${esc(key)}</span><span class="muted" style="font-size:11.5px">${extra}</span></div></td>
            <td class="ops"><button class="btn btn-sm btn-ghost" style="color:var(--critical)"
              data-action="del-player" data-kind="${kind}" data-key="${esc(key)}">移除</button></td>
          </tr>`;
        }).join('')}
        </tbody></table>`
        : '<div class="muted" style="font-size:12.5px;padding:8px 0">列表为空</div>'}
    </div>`;
  };

  const online = (d.online?.list || []);

  content.innerHTML = `
    <div class="cards">
      <div class="card">
        <div class="card-head">
          <div class="card-title">在线玩家</div>
          <div class="card-sub">${d.online.online} / ${d.online.max}</div>
        </div>
        ${online.length ? `<table class="file-table"><tbody>
          ${online.map((n) => `<tr>
            <td>${esc(n)}</td>
            <td class="ops">
              <button class="btn btn-sm" data-action="player-cmd" data-cmd="kick ${esc(n)}">踢出</button>
              <button class="btn btn-sm" data-action="player-cmd" data-cmd="op ${esc(n)}">给OP</button>
              <button class="btn btn-sm" data-action="player-cmd" data-cmd="ban ${esc(n)}">封禁</button>
            </td></tr>`).join('')}
        </tbody></table>`
        : `<div class="muted" style="font-size:12.5px;padding:6px 0">
            ${st.running ? '当前没有玩家在线' : '服务器未运行'}</div>`}
      </div>
      <div class="card">
        <div class="card-head"><div class="card-title">白名单状态</div></div>
        <dl class="kv">
          <dt>白名单开关</dt><dd>${d.whitelistOn ? '<span style="color:var(--good)">已启用</span>' : '<span class="muted">未启用</span>'}</dd>
          <dt>验证模式</dt><dd>${d.offlineMode ? '离线模式（无正版验证）' : '正版验证'}</dd>
        </dl>
        <div class="muted" style="font-size:12px;margin-top:10px;line-height:1.6">
          ${d.whitelistOn ? '' : '白名单开关在「服务器配置」页可以打开（white-list）。'}
          ${d.offlineMode ? '<br>离线模式下，添加白名单时面板会按 Minecraft 规则计算出离线 UUID。' : ''}
        </div>
      </div>
    </div>
    <div class="cards">
      ${listCard('whitelist')}
      ${listCard('ops')}
      ${listCard('banned')}
      ${listCard('banned-ips')}
    </div>`;
}

async function addPlayer(kind) {
  const L = S.view.players.lists[kind];
  const isIp = kind === 'banned-ips';
  const body = await openModal({
    title: `添加到${L.label}`,
    body: `
      <div class="field">
        <label>${isIp ? 'IP 地址' : '玩家名'}</label>
        <input class="input mono" data-pk placeholder="${isIp ? '例如 1.2.3.4' : '例如 Steve'}" autocomplete="off">
        <div class="desc">${isIp ? '支持单个 IPv4 / IPv6 地址' : '3-16 位，仅限字母、数字、下划线'}</div>
      </div>
      ${kind === 'banned' ? `<div class="field"><label>封禁原因（可选）</label><input class="input" data-pr placeholder="Banned by an operator."></div>` : ''}
      ${kind === 'ops' ? `<div class="field"><label>OP 等级</label>
        <select class="select" data-pl>
          <option value="4">4 — 完全权限（默认）</option>
          <option value="3">3 — 可管理玩家</option>
          <option value="2">2 — 可用大部分指令</option>
          <option value="1">1 — 可绕过出生点保护</option>
        </select></div>` : ''}
      ${isIp || kind === 'banned' ? '' : `<div class="muted" style="font-size:12px">面板会优先从 usercache.json 里查该玩家的 UUID。</div>`}`,
    actions: [
      { label: '取消', value: null },
      {
        label: '添加',
        variant: 'primary',
        value: (el) => {
          const val = el.querySelector('[data-pk]').value.trim();
          if (!val) throw new Error(isIp ? '请填写 IP 地址' : '请填写玩家名');
          const out = isIp ? { ip: val } : { name: val };
          if (kind === 'banned') out.reason = el.querySelector('[data-pr]')?.value.trim() || undefined;
          if (kind === 'ops') out.level = Number(el.querySelector('[data-pl]')?.value || 4);
          return out;
        },
      },
    ],
  });
  if (!body) return;
  try {
    await api(`/api/servers/${S.current}/players/${kind}`, { method: 'POST', body });
    toast(`已添加到${L.label}`, 'ok');
    S.view.players = null;
    renderTab();
  } catch (e) {
    toast(e.message, 'err', 9000);
  }
}

/* ─────────────────────────── 服务器配置 ─────────────────────────── */

function renderConfig(content, st) {
  const d = S.view.props;
  if (!d) {
    content.innerHTML = `<div class="empty">正在读取 server.properties…</div>`;
    const id = S.current;
    api(`/api/servers/${id}/props`)
      .then((r) => {
        if (S.current !== id) return;
        S.view.props = r; if (S.tab === 'config') renderTab();
      })
      .catch((e) => toast(e.message, 'err'));
    return;
  }

  content.innerHTML = `
    <div class="row-between" style="margin-bottom:14px">
      <div class="row">
        <input class="input" id="propFilter" placeholder="搜索配置项…" style="width:240px" autocomplete="off">
        <span class="muted" style="font-size:12.5px" id="propCount"></span>
      </div>
      <div class="row">
        <button class="btn btn-sm btn-ghost" data-action="open-props-raw">以文本编辑</button>
        <button class="btn btn-sm btn-primary" data-action="save-props">保存修改</button>
      </div>
    </div>
    ${st.running ? `<div class="console-hint" style="border-radius:9px;margin-bottom:14px">
      服务器正在运行。改动会写入文件，但多数项需要重启服务器才会生效。</div>` : ''}
    <div class="card">
      <div id="propList"></div>
    </div>`;

  const render = (filter = '') => {
    const f = filter.toLowerCase();
    const items = d.items.filter((i) => !f || i.key.toLowerCase().includes(f) || (i.description || '').toLowerCase().includes(f));
    $('#propCount').textContent = `${items.length} / ${d.items.length} 项`;
    $('#propList').innerHTML = items.map((i) => `
      <div class="field" style="margin-bottom:12px" data-prop-row="${esc(i.key)}">
        <label class="mono">${esc(i.key)}</label>
        ${i.type === 'boolean'
          ? `<select class="select" data-prop="${esc(i.key)}">
              <option value="true" ${i.value === 'true' ? 'selected' : ''}>true</option>
              <option value="false" ${i.value === 'false' ? 'selected' : ''}>false</option>
             </select>`
          : `<input class="input ${i.type === 'number' ? '' : 'mono'}" data-prop="${esc(i.key)}" value="${esc(i.value)}">`}
        ${i.description ? `<div class="desc">${esc(i.description)}</div>` : ''}
        ${i.secret ? `<div class="desc">已隐藏，不改动则保留原密码；要更换请直接输入新密码。</div>` : ''}
      </div>`).join('') || '<div class="muted">没有匹配的配置项</div>';
  };
  render();
  $('#propFilter').addEventListener('input', (e) => render(e.target.value));
}

async function saveProps() {
  const rows = $$('[data-prop]');
  const changes = {};
  for (const el of rows) {
    const key = el.dataset.prop;
    const orig = S.view.props.items.find((i) => i.key === key);
    if (orig && el.value !== orig.value) changes[key] = el.value;
  }
  if (!Object.keys(changes).length) { toast('没有任何改动', 'info'); return; }
  try {
    const id = S.current;
    const r = await api(`/api/servers/${id}/props`, { method: 'PUT', body: { changes } });
    if (S.current !== id) return;
    toast(r.message || '已保存', 'ok', 7000);
    // PUT 回带最新 items，不再串行 GET
    if (r.items) S.view.props = { items: r.items };
    renderTab();
  } catch (e) {
    toast(e.message, 'err');
  }
}

/* ─────────────────────────── 自定义 ─────────────────────────── */

/** MOTD 颜色代码 → 颜色值，仅预览用 */
const MC_COLORS = {
  0: '#000000', 1: '#0000aa', 2: '#00aa00', 3: '#00aaaa', 4: '#aa0000', 5: '#aa00aa',
  6: '#ffaa00', 7: '#aaaaaa', 8: '#555555', 9: '#5555ff', a: '#55ff55', b: '#55ffff',
  c: '#ff5555', d: '#ff55ff', e: '#ffff55', f: '#ffffff',
};

/** 把带 § 的文本渲染成预览 HTML。只认颜色与加粗，其余代码去掉（与原版客户端一致）。 */
function motdLineHTML(text) {
  let html = '';
  let color = null;
  let bold = false;
  for (const part of String(text || '').split(/(§.)/)) {
    if (!part) continue;
    if (part[0] === '§') {
      const c = (part[1] || '').toLowerCase();
      if (MC_COLORS[c]) color = MC_COLORS[c];
      else if (c === 'r') { color = null; bold = false; }
      else if (c === 'l') bold = true;
      continue;
    }
    const style = `${color ? `color:${color};` : ''}${bold ? 'font-weight:700;' : ''}`;
    html += style ? `<span style="${style}">${esc(part)}</span>` : esc(part);
  }
  return html || '<span class="muted">（空）</span>';
}

function joinStatsHTML(jm) {
  const d = jm || {};
  const last = d.last;
  const tail = last
    ? `最近 ${esc(last.player)} ${esc(fmtTime(last.at))} ${last.ok
      ? '已发送' : `<span style="color:var(--critical)">失败：${esc(last.error || '')}</span>`}`
    : '还没有玩家入服过';
  return `已发送 ${d.sent || 0} 条 · ${tail}`;
}

function renderCustom(content, st) {
  const d = S.view.custom;
  if (!d) {
    content.innerHTML = `<div class="empty">正在读取自定义设置…</div>`;
    const id = S.current;
    api(`/api/servers/${id}/custom`)
      .then((r) => {
        if (S.current !== id) return;
        S.view.custom = r; if (S.tab === 'custom') renderTab();
      })
      .catch((e) => toast(e.message, 'err'));
    return;
  }

  const icon = d.icon || {};
  const jm = d.joinMsg || {};
  const iconSrc = icon.exists ? esc(icon.url) : '';

  content.innerHTML = `
    ${st.running ? `<div class="console-hint" style="border-radius:9px;margin-bottom:14px">
      服务器正在运行：图标与标题要重启服务器后才在客户端生效；入服私聊改完立即生效。</div>` : ''}
    <div class="cards">
      <div class="card icon-card" id="iconCard">
        <div class="card-head">
          <div class="card-title">服务器图标</div>
          <div class="card-sub">客户端在服务器列表里看到的图片</div>
          <div class="card-actions">
            <button class="btn btn-sm" data-action="icon-upload">上传图标</button>
            ${icon.exists ? `<button class="btn btn-sm btn-ghost" data-action="icon-remove"
              style="color:var(--critical)">移除</button>` : ''}
          </div>
        </div>
        <div class="row" style="gap:14px;align-items:flex-start">
          <div class="icon-box" id="iconBox">${icon.exists
            ? `<img id="iconImg" alt="服务器图标" src="${iconSrc}">` : '未设置'}</div>
          <div class="muted" style="font-size:12.5px;line-height:1.9">
            <div>需要 64×64 的 PNG，存为服务器目录下的 <span class="mono">server-icon.png</span>。</div>
            <div>拖一张图片到这张卡片上也可以：会自动按中心裁切、缩放到 64×64 并转成 PNG。</div>
            <div>${icon.exists
              ? `当前图标：${fmtBytes(icon.size)}，${fmtDateTime(icon.mtime)}`
              : '未设置时客户端显示默认图标。'}</div>
          </div>
        </div>
        <input type="file" id="iconInput" accept="image/*" hidden>
      </div>

      <div class="card">
        <div class="card-head">
          <div class="card-title">标题与副标题</div>
          <div class="card-sub">服务器列表里的两行文字</div>
          <div class="card-actions"><button class="btn btn-sm btn-primary" data-action="save-motd">保存</button></div>
        </div>
        <div class="field">
          <label>标题（第一行）</label>
          <input class="input" id="motdTitle" maxlength="${MOTD_LINE_MAX}" autocomplete="off"
                 value="${esc(d.motd.title)}">
        </div>
        <div class="field">
          <label>副标题 / 简介（第二行）</label>
          <input class="input" id="motdSub" maxlength="${MOTD_LINE_MAX}" autocomplete="off"
                 value="${esc(d.motd.subtitle)}">
        </div>
        <div class="desc">两行都留空则不显示。支持 § 颜色代码，如 <span class="mono">§a绿色 §l加粗</span>。</div>
        <div class="field" style="margin:14px 0 0">
          <label>预览</label>
          <div class="motd-preview" id="motdPreview"></div>
        </div>
      </div>

      <div class="card">
        <div class="card-head">
          <div class="card-title">玩家入服自动私聊</div>
          <div class="card-sub">玩家进服时私聊一条自定义文本</div>
          <div class="card-actions"><button class="btn btn-sm btn-primary" data-action="save-join-msg">保存</button></div>
        </div>
        <label class="row" style="gap:7px;font-size:13px;cursor:pointer;margin-bottom:14px">
          <input type="checkbox" id="joinEnabled" ${jm.enabled ? 'checked' : ''}>
          启用
        </label>
        <div class="field">
          <label>私聊内容</label>
          <input class="input" id="joinText" maxlength="${JOIN_TEXT_MAX}" autocomplete="off"
                 value="${esc(jm.text)}" placeholder="例如：欢迎 %player% 加入本服">
          <div class="desc">用 <span class="mono">%player%</span> 表示玩家名。改完立即生效，不必重启服务器。</div>
        </div>
        ${d.channel ? `<div class="warn-box">当前没有可用的指令通道：${esc(d.channel)}<br>
          入服私聊要靠面板向服务器发指令，需要由面板启动该服务器，或在 server.properties 里启用 RCON。</div>` : ''}
        <div class="muted" id="joinStats" style="font-size:12.5px">${joinStatsHTML(jm)}</div>
      </div>
    </div>`;

  // 预览随输入即时更新，模拟客户端的服务器列表条目
  const paint = () => {
    $('#motdPreview').innerHTML = `
      <div class="motd-ico">${iconSrc ? `<img alt="" src="${iconSrc}">` : ''}</div>
      <div style="min-width:0">
        <div class="motd-name">${esc(st.name)}</div>
        <div class="motd-text">${motdLineHTML($('#motdTitle').value)}</div>
        <div class="motd-text">${motdLineHTML($('#motdSub').value)}</div>
      </div>`;
  };
  paint();
  $('#motdTitle').addEventListener('input', paint);
  $('#motdSub').addEventListener('input', paint);

  const img = $('#iconImg');
  if (img) img.onerror = () => { $('#iconBox').textContent = '图标读取失败'; };
  $('#iconInput').addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (file) uploadIcon(file);
  });

  // 拖图片到这张卡片上即换图标。stopPropagation 是为了别让窗口级那套「文件页拖拽」提示层插一脚。
  const card = $('#iconCard');
  const dragsFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  card.addEventListener('dragover', (e) => {
    if (!dragsFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    card.classList.add('dropping');
  });
  card.addEventListener('dragleave', (e) => {
    if (!card.contains(e.relatedTarget)) card.classList.remove('dropping');
  });
  card.addEventListener('drop', (e) => {
    if (!dragsFiles(e)) return;
    e.preventDefault();
    e.stopPropagation();
    card.classList.remove('dropping');
    const file = [...(e.dataTransfer.files || [])].find((f) => isImageFile(f));
    if (!file) return toast('请拖入图片文件（PNG / JPG / WebP / GIF 等）', 'warn', 6000);
    return uploadIcon(file);
  });
}

async function saveMotd() {
  const title = $('#motdTitle').value.trim();
  const subtitle = $('#motdSub').value.trim();
  if (title === S.view.custom.motd.title && subtitle === S.view.custom.motd.subtitle) {
    toast('没有任何改动', 'info');
    return;
  }
  try {
    const id = S.current;
    const r = await api(`/api/servers/${id}/custom`, { method: 'PUT', body: { motd: { title, subtitle } } });
    if (S.current !== id) return;
    S.view.custom = r;
    toast(r.message || '已保存', 'ok', 7000);
    renderTab();
  } catch (e) {
    toast(e.message, 'err', 9000);
  }
}

async function saveJoinMsg() {
  try {
    const id = S.current;
    const r = await api(`/api/servers/${id}/custom`, {
      method: 'PUT',
      body: { joinMsg: { enabled: $('#joinEnabled').checked, text: $('#joinText').value.trim() } },
    });
    if (S.current !== id) return;
    S.view.custom = r;
    toast(r.message || '已保存', 'ok', 6000);
    renderTab();
  } catch (e) {
    toast(e.message, 'err', 9000);
  }
}

// 与 lib/custom.js 的 ICON_SIDE 一致
const ICON_SIDE = 64;

/** 类型写明了就必须是图片；没写类型的（改名成无后缀等）交给解码器判 */
function isImageFile(f) {
  return !!f && (!f.type || /^image\//i.test(f.type));
}

/**
 * 把任意一张图片变成 64×64 的 PNG：先按中心裁成正方形（不拉伸变形），再缩放到 64×64。
 * 转换在浏览器画布上做，后端只收成品，因此不必给面板塞图像库。
 */
function toIconPng(file) {
  return new Promise((resolve, reject) => {
    if (!isImageFile(file)) {
      return reject(new Error('这不是图片文件，支持 PNG / JPG / WebP / GIF 等'));
    }
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      try {
        // SVG 之类可能报不出原始尺寸，那就按图标大小占位
        const iw = img.naturalWidth || img.width || ICON_SIDE;
        const ih = img.naturalHeight || img.height || ICON_SIDE;
        const c = document.createElement('canvas');
        c.width = ICON_SIDE;
        c.height = ICON_SIDE;
        const ctx = c.getContext('2d');
        const scale = Math.max(ICON_SIDE / iw, ICON_SIDE / ih);
        const w = iw * scale;
        const h = ih * scale;
        // 恰好 64×64 时缩放比是 1，逐像素照搬，不会被重采样糊掉
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, (ICON_SIDE - w) / 2, (ICON_SIDE - h) / 2, w, h);
        c.toBlob((b) => (b ? resolve(b) : reject(new Error('图片转换失败'))), 'image/png');
      } catch (e) {
        reject(new Error('图片转换失败：' + e.message));
      }
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('这张图片浏览器读不了，换一张试试'));
    };
    img.src = url;
  });
}

async function uploadIcon(file) {
  const id = S.current;
  const tip = toast('正在处理图片…', 'info', 30000);
  try {
    const png = await toIconPng(file);
    const res = await fetch(`/api/servers/${id}/icon`, {
      method: 'POST',
      headers: { 'X-McPanel': '1', 'Content-Type': 'image/png' },
      body: png,
    });
    const text = await res.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch { /* 非 JSON 响应按 HTTP 状态报错 */ }
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    if (S.current !== id) return;
    // 只换图标一节，不整页重画
    if (data.icon) { S.view.custom.icon = data.icon; renderTab(); }
    toast('图标已更新，重启服务器后生效', 'ok', 7000);
  } catch (e) {
    toast(e.message, 'err', 10000);
  } finally {
    tip.remove();
  }
}

async function removeIcon() {
  const ok = await confirmDanger({
    title: '移除服务器图标',
    message: '服务器目录下的 server-icon.png 会被删除，客户端将显示默认图标。',
    detail: '原图已留有 server-icon.png.bak，需要时可手动改回。',
    confirmLabel: '移除',
  });
  if (!ok) return;
  try {
    const id = S.current;
    await api(`/api/servers/${id}/icon`, { method: 'DELETE' });
    if (S.current !== id) return;
    S.view.custom = null;
    toast('已移除图标，重启服务器后生效', 'ok', 7000);
    renderTab();
  } catch (e) {
    toast(e.message, 'err', 9000);
  }
}

/* ── 拖拽上传 ─────────────────────────────────────────────────
 * 拖入的可能是文件夹，用 webkitGetAsEntry 递归展开并保留相对路径，落到当前目录下的
 * 同名子目录。仅 Chromium/Firefox 支持目录展开，拿不到 entry 时按普通文件处理。 */

/** 把 entry（文件或目录）递归展开为 [{file, rel}]，rel 为相对路径 */
function walkEntry(entry, prefix = '') {
  const readAll = (reader) => new Promise((resolve) => {
    const out = [];
    // readEntries 每次最多返回 100 条，须反复读到空数组为止。
    const step = () => reader.readEntries((batch) => {
      if (!batch.length) return resolve(out);
      out.push(...batch);
      step();
    }, () => resolve(out));
    step();
  });

  if (entry.isFile) {
    return new Promise((resolve) => {
      entry.file(
        (f) => resolve([{ file: f, rel: prefix + f.name }]),
        () => resolve([]),
      );
    });
  }
  if (entry.isDirectory) {
    return readAll(entry.createReader()).then((kids) =>
      Promise.all(kids.map((k) => walkEntry(k, prefix + entry.name + '/'))))
      .then((sub) => sub.flat());
  }
  return Promise.resolve([]);
}

/**
 * 从一次 drop 取出待上传文件列表。webkitGetAsEntry 必须在 drop 事件处理中同步调用，
 * 先同步取出 entry 再异步展开。
 */
function collectDrop(dt) {
  const items = [...(dt.items || [])].filter((i) => i.kind === 'file');
  const entries = items.map((i) => (i.webkitGetAsEntry ? i.webkitGetAsEntry() : null));
  if (entries.some(Boolean)) {
    return Promise.all(entries.map((en, i) =>
      en ? walkEntry(en) : Promise.resolve([{ file: items[i].getAsFile(), rel: '' }])))
      .then((r) => r.flat().filter((x) => x.file));
  }
  // 无 entry API 时按普通文件收集
  return Promise.resolve([...dt.files].map((f) => ({ file: f, rel: f.name })));
}

/** 上传入口，input[type=file] 与拖拽共用 */
async function uploadFiles(list) {
  if (!list.length) return toast('没有可上传的文件', 'warn');
  if (!S.current) return toast('请先添加并选择一台服务器', 'warn');
  // 发起时固定目标服务器，中途切服不改道
  const targetId = S.current;
  const base = S.filePath || '';
  const total = list.length;
  let done = 0;
  let failed = 0;
  let bytes = 0;
  let cancelled = false;

  const panel = document.createElement('div');
  panel.className = 'up-panel';
  panel.innerHTML = `
    <div class="up-head"><span>正在上传</span><span class="up-count">0 / ${total}</span></div>
    <div class="up-bar"><i></i></div>
    <div class="up-now"></div>
    <div class="up-foot"><button class="btn btn-sm btn-ghost" data-up-cancel>取消</button></div>`;
  document.body.appendChild(panel);
  const $count = panel.querySelector('.up-count');
  const $bar = panel.querySelector('.up-bar > i');
  const $now = panel.querySelector('.up-now');
  panel.querySelector('[data-up-cancel]').onclick = () => {
    cancelled = true;
    panel.querySelector('.up-foot').innerHTML = '<span class="muted" style="font-size:12px">正在停止…</span>';
  };

  const failMsgs = new Set();
  for (const item of list) {
    if (cancelled) break;
    const rel = (item.rel || item.file.name).replace(/\\/g, '/');
    const slash = rel.lastIndexOf('/');
    // 相对路径拆成「目录 + 文件名」，复用后端的 path + name 查询参数；
    // 后端 upload() 已有 mkdirSync(recursive)，嵌套目录无需额外处理。
    const dir = joinPath(base, slash >= 0 ? rel.slice(0, slash) : '');
    const name = slash >= 0 ? rel.slice(slash + 1) : rel;
    $now.innerHTML = `<span class="up-file">${esc(name)}</span><span class="up-dir">${esc(slash >= 0 ? rel.slice(0, slash) : base)}</span>`;
    try {
      const res = await fetch(
        `/api/servers/${targetId}/file/upload?path=${encodeURIComponent(dir)}&name=${encodeURIComponent(name)}`,
        { method: 'POST', body: item.file, headers: { 'X-McPanel': '1' } });
      if (!res.ok) {
        const t = await res.text();
        let msg = `HTTP ${res.status}`;
        try { msg = JSON.parse(t).error || msg; } catch { }
        throw new Error(msg);
      }
      bytes += item.file.size;
    } catch (e) {
      failed++;
      failMsgs.add(e.message);
    }
    done++;
    $count.textContent = `${done} / ${total}`;
    $bar.style.width = `${Math.round((done / total) * 100)}%`;
  }

  const okCount = done - failed;
  $now.innerHTML = cancelled
    ? `<span class="up-file">已取消</span>`
    : `<span class="up-file">完成 ${okCount} 个${failed ? `，失败 ${failed} 个` : ''}</span>`
      + `<span class="up-dir">${fmtBytes(bytes)}</span>`;
  $bar.style.width = '100%';
  $bar.style.background = failed ? 'var(--warning)' : 'var(--accent)';
  panel.querySelector('.up-foot').innerHTML = '<button class="btn btn-sm" data-up-close>关闭</button>';
  panel.querySelector('[data-up-close]').onclick = () => panel.remove();
  if (!failed && !cancelled) setTimeout(() => panel.remove(), 2500);

  if (failed) toast(`有 ${failed} 个文件上传失败：${[...failMsgs].slice(0, 2).join('；')}`, 'err', 8000);
  else if (cancelled) toast(`已上传 ${okCount} 个后被取消`, 'warn');
  else toast(`已上传 ${okCount} 个文件`, 'ok', 2500);

  // 只刷新文件列表，不整体 renderTab。
  if (S.tab === 'files') loadFiles(base);
}

{
  const veil = document.createElement('div');
  veil.className = 'drop-veil';
  veil.innerHTML = `<div class="box">
      <div class="t1">松手即可上传</div>
      <div class="t2" id="dropWhere"></div>
    </div>`;
  document.body.appendChild(veil);

  // dragleave 在子元素间移动时也会触发，用计数器判断是否真正离开窗口。
  let depth = 0;
  const onFilesTab = () => S.tab === 'files' && !!S.current;
  const hide = () => { depth = 0; veil.classList.remove('on'); };
  const dragsFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');

  window.addEventListener('dragenter', (e) => {
    if (!dragsFiles(e) || !onFilesTab()) return;
    e.preventDefault();
    depth++;
    veil.querySelector('#dropWhere').textContent =
      `将放入 ${S.filePath ? '/' + S.filePath : '服务器根目录'}`;
    veil.classList.add('on');
  });

  // dragover / drop 一律拦下文件拖拽，不区分标签页。不在文件页时拦下后只提示。
  window.addEventListener('dragover', (e) => {
    if (!dragsFiles(e)) return;
    e.preventDefault();               // 须 preventDefault。
    if (onFilesTab()) e.dataTransfer.dropEffect = 'copy';
  });

  window.addEventListener('dragleave', (e) => {
    if (!veil.classList.contains('on')) return;
    e.preventDefault();
    if (--depth <= 0) hide();
  });

  window.addEventListener('drop', (e) => {
    if (!dragsFiles(e)) return;
    e.preventDefault();
    if (!onFilesTab()) {
      hide();
      return toast('请先切到「文件」标签页，再把文件拖进来', 'warn', 4000);
    }
    hide();
    collectDrop(e.dataTransfer)
      .then(uploadFiles)
      .catch((err) => toast('读取拖入内容失败：' + err.message, 'err'));
  });

  // 拖到页面但未落在窗口内（如标题栏）时也要收起提示层
  window.addEventListener('dragend', hide);
  window.addEventListener('blur', hide);
}
