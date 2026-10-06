'use strict';
/* =========================================================================
   RS面板前端。无框架、无构建步骤，原生 JS + SVG 手绘图表。
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
  autoScroll: true,
  busy: new Set(),
  navOpen: false,    // 窄屏下的服务器列表抽屉是否打开
  sidebarIds: null,  // 侧边栏当前渲染出的服务器 id 顺序
  view: {},          // 当前标签页的 DOM 引用
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
];

const HISTORY_LEN = 180;

/* ─────────────────────────── 基础工具 ─────────────────────────── */

async function api(path, opts = {}) {
  const { method = 'GET', body, raw } = opts;
  const init = { method, headers: {} };
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
    const close = (value) => { back.remove(); document.removeEventListener('keydown', onKey); resolve(value); };

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
    const onKey = (e) => { if (e.key === 'Escape') close(null); };
    document.addEventListener('keydown', onKey);
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

/* ─────────────────────────── 图表 ─────────────────────────── */

const SVG_NS = 'http://www.w3.org/2000/svg';
const svgEl = (tag, attrs = {}) => {
  const e = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
};

function niceTicks(min, max, count = 4) {
  if (!(max > min)) return { lo: min, hi: min + 1, ticks: [min] };
  const step0 = (max - min) / count;
  const mag = Math.pow(10, Math.floor(Math.log10(step0)));
  const norm = step0 / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = lo; v <= hi + step * 1e-6; v += step) ticks.push(Number(v.toFixed(6)));
  return { lo, hi, ticks };
}

/**
 * 时序折线图。单序列，标题即图例，不画图例框；末端标注当前值。
 */
function createChart(container, opts) {
  const pad = { t: 12, r: 54, b: 22, l: 46 };
  const height = opts.height || 150;
  const wrap = document.createElement('div');
  wrap.className = 'chart-wrap';
  const svg = svgEl('svg', { class: 'chart-svg', height });
  const defs = svgEl('defs');
  const gid = 'grad-' + Math.random().toString(36).slice(2, 8);
  const grad = svgEl('linearGradient', { id: gid, x1: '0', y1: '0', x2: '0', y2: '1' });
  grad.append(svgEl('stop', { offset: '0%', 'stop-color': opts.color, 'stop-opacity': '0.26' }));
  grad.append(svgEl('stop', { offset: '100%', 'stop-color': opts.color, 'stop-opacity': '0.01' }));
  defs.appendChild(grad);
  svg.appendChild(defs);

  const gGrid = svgEl('g');
  const area = svgEl('path', { fill: `url(#${gid})` });
  const line = svgEl('path', { fill: 'none', stroke: opts.color, 'stroke-width': '2', 'stroke-linejoin': 'round', 'stroke-linecap': 'round' });
  // 第二条序列（可选），只画线不铺渐变
  const line2 = opts.color2
    ? svgEl('path', { fill: 'none', stroke: opts.color2, 'stroke-width': '2', 'stroke-linejoin': 'round', 'stroke-linecap': 'round' })
    : null;
  const cross = svgEl('line', { stroke: 'var(--axis)', 'stroke-width': '1', 'stroke-dasharray': '3 3', opacity: '0' });
  const dot = svgEl('circle', { r: '4', fill: opts.color, stroke: 'var(--surface)', 'stroke-width': '2', opacity: '0' });
  const endDot = svgEl('circle', { r: '3.5', fill: opts.color, stroke: 'var(--surface)', 'stroke-width': '2' });
  const endLabel = svgEl('text', { fill: 'var(--ink-2)', 'font-size': '11.5', 'font-weight': '600', 'dominant-baseline': 'middle' });
  const hit = svgEl('rect', { fill: 'transparent', y: 0 });
  svg.append(gGrid, area, line);
  if (line2) svg.appendChild(line2);
  svg.append(cross, dot, endDot, endLabel, hit);

  const tip = document.createElement('div');
  tip.className = 'chart-tip';
  wrap.append(svg, tip);
  container.innerHTML = '';
  container.appendChild(wrap);

  let pts = [];
  let pts2 = [];
  let W = 400;
  const emptyEl = document.createElement('div');
  emptyEl.className = 'chart-empty';
  emptyEl.textContent = opts.emptyText || '暂无数据';

  const xs = (i) => {
    const n = pts.length;
    if (n <= 1) return pad.l;
    return pad.l + (i / (n - 1)) * (W - pad.l - pad.r);
  };
  let scale = { lo: 0, hi: 1 };

  function draw() {
    W = Math.max(240, wrap.clientWidth || container.clientWidth || 400);
    svg.setAttribute('width', W);
    svg.setAttribute('height', height);
    hit.setAttribute('width', W);
    hit.setAttribute('height', height);

    if (pts.length < 2) {
      gGrid.innerHTML = '';
      area.setAttribute('d', '');
      line.setAttribute('d', '');
      if (line2) line2.setAttribute('d', '');
      endDot.setAttribute('opacity', '0');
      endLabel.setAttribute('opacity', '0');
      if (!wrap.querySelector('.chart-empty')) wrap.appendChild(emptyEl);
      emptyEl.style.height = height + 'px';
      return;
    }
    emptyEl.remove();

    const values = pts.map((p) => p.v).concat(pts2.map((p) => p.v));
    const rawMax = Math.max(...values);
    const rawMin = opts.zeroBase === false ? Math.min(...values) : 0;
    const top = opts.suggestMax ? Math.max(rawMax, opts.suggestMax) : rawMax;
    const { lo, hi, ticks } = niceTicks(rawMin, top * 1.08 || 1, 4);
    scale = { lo, hi };

    const ys = (v) => height - pad.b - ((v - lo) / (hi - lo || 1)) * (height - pad.t - pad.b);

    gGrid.innerHTML = '';
    for (const t of ticks) {
      const y = ys(t);
      gGrid.appendChild(svgEl('line', {
        x1: pad.l, x2: W - pad.r, y1: y, y2: y,
        stroke: t === lo ? 'var(--axis)' : 'var(--grid)', 'stroke-width': '1',
      }));
      const label = svgEl('text', {
        x: pad.l - 8, y, 'text-anchor': 'end', 'dominant-baseline': 'middle',
        fill: 'var(--ink-3)', 'font-size': '10.5',
      });
      label.textContent = opts.formatAxis ? opts.formatAxis(t) : String(Math.round(t));
      gGrid.appendChild(label);
    }

    const lineD = pts.map((p, i) => `${i ? 'L' : 'M'}${xs(i).toFixed(1)},${ys(p.v).toFixed(1)}`).join(' ');
    line.setAttribute('d', lineD);
    area.setAttribute('d', `${lineD} L${xs(pts.length - 1).toFixed(1)},${height - pad.b} L${pad.l},${height - pad.b} Z`);
    if (line2) {
      line2.setAttribute('d', pts2.length > 1
        ? pts2.map((p, i) => `${i ? 'L' : 'M'}${xs(i).toFixed(1)},${ys(p.v).toFixed(1)}`).join(' ')
        : '');
    }

    const last = pts[pts.length - 1];
    const lx = xs(pts.length - 1);
    const ly = ys(last.v);
    endDot.setAttribute('cx', lx);
    endDot.setAttribute('cy', ly);
    endDot.setAttribute('opacity', '1');
    endLabel.setAttribute('x', Math.min(lx + 8, W - pad.r + 6));
    endLabel.setAttribute('y', Math.max(pad.t + 6, Math.min(ly, height - pad.b)));
    endLabel.textContent = opts.format ? opts.format(last.v) : String(last.v);
  }

  function nearest(clientX) {
    const rect = svg.getBoundingClientRect();
    const x = clientX - rect.left;
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < pts.length; i++) {
      const d = Math.abs(xs(i) - x);
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  }

  function showTip(i, clientX, clientY) {
    const p = pts[i];
    const x = xs(i);
    const y = height - pad.b - ((p.v - scale.lo) / (scale.hi - scale.lo || 1)) * (height - pad.t - pad.b);
    cross.setAttribute('x1', x);
    cross.setAttribute('x2', x);
    cross.setAttribute('y1', pad.t);
    cross.setAttribute('y2', height - pad.b);
    cross.setAttribute('opacity', '1');
    dot.setAttribute('cx', x);
    dot.setAttribute('cy', y);
    dot.setAttribute('opacity', '1');

    const wrapRect = wrap.getBoundingClientRect();
    const row = (color, v) => `<div class="tip-row"><span class="tip-dot" style="background:${color}"></span>
      <span>${esc(opts.format ? opts.format(v) : v)}${opts.unit ? ' ' + esc(opts.unit) : ''}</span></div>`;
    tip.innerHTML = `<div class="tip-time">${fmtTime(p.t)}</div>` + row(opts.color, p.v)
      + (pts2[i] ? row(opts.color2, pts2[i].v) : '');
    tip.classList.add('on');
    const tw = tip.offsetWidth;
    let left = x + 12;
    if (left + tw > wrapRect.width - 4) left = x - tw - 12;
    tip.style.left = Math.max(0, left) + 'px';
    tip.style.top = Math.max(0, y - 42) + 'px';
  }

  function hideTip() {
    cross.setAttribute('opacity', '0');
    dot.setAttribute('opacity', '0');
    tip.classList.remove('on');
  }

  // 用 pointer 事件而非 mouse。
  // .chart-svg 的 touch-action:pan-y 保证纵向拖仍翻页，只有横向拖落到这里。
  svg.addEventListener('pointermove', (e) => {
    if (pts.length < 2) return;
    showTip(nearest(e.clientX), e.clientX, e.clientY);
  });
  // 鼠标移开即收，触摸在手指抬起时收
  svg.addEventListener('pointerleave', (e) => { if (e.pointerType !== 'touch') hideTip(); });
  svg.addEventListener('pointerup', (e) => { if (e.pointerType === 'touch') hideTip(); });
  svg.addEventListener('pointercancel', hideTip);

  const ro = new ResizeObserver(() => draw());
  ro.observe(wrap);

  return {
    update(next, next2) { pts = next || []; pts2 = next2 || []; draw(); },
    destroy() { ro.disconnect(); },
  };
}

/** 状态卡用的 12 点迷你趋势线 */
function sparkline(values, color) {
  if (!values || values.length < 2) return '';
  const W = 100;
  const H = 26;
  const max = Math.max(...values, 0.0001);
  const min = Math.min(...values, 0);
  const span = max - min || 1;
  const d = values.map((v, i) => {
    const x = (i / (values.length - 1)) * W;
    const y = H - 2 - ((v - min) / span) * (H - 4);
    return `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  return `<svg class="stat-spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
    <path d="${d} L${W},${H} L0,${H} Z" fill="${color}" opacity="0.12"/>
    <path d="${d}" fill="none" stroke="${color}" stroke-width="1.6" vector-effect="non-scaling-stroke"/>
  </svg>`;
}

/* ─────────────────────────── 图标 ─────────────────────────── */

const ICONS = {
  // 所有文件夹共用此图标，后端 classify 对目录一律返回 'dir'
  dir: '<path d="M3 7a2 2 0 0 1 2-2h3.5l1.5 2H19a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  mod: '<path d="M20 7l-8-4-8 4v10l8 4 8-4V7zm-8 12l-6-3V8.5l6 3V19zm1-9.3l-6-3L12 4l5 2.7-5 3z"/>',
  log: '<path d="M6 2h8l4 4v16H6V2zm8 1.5V7h3.5L14 3.5zM8 12h8v1.5H8V12zm0 3.5h8V17H8v-1.5zm0-7h4V10H8V8.5z"/>',
  json: '<path d="M5 3h14a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zm3.5 4.5L6 12l2.5 4.5 1.3-.7L8 12l1.8-3.8-1.3-.7zm7 0l-1.3.7L16 12l-1.8 3.8 1.3.7L18 12l-2.5-4.5z"/>',
  text: '<path d="M6 2h8l4 4v16H6V2zm8 1.5V7h3.5L14 3.5zM8 11h8v1.5H8V11zm0 3.5h8V16H8v-1.5z"/>',
  jar: '<path d="M8 2h8v2l1.5 2.2A4 4 0 0 1 18 8.4V19a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V8.4c0-.8.2-1.5.5-2.2L8 4V2zm2 8h4V8h-4v2z"/>',
  important: '<path d="M12 2l2.4 5.2 5.6.8-4 4 .9 5.6-4.9-2.6L7.1 17.6 8 12 4 8l5.6-.8L12 2z"/>',
  // 压缩包图标
  zip: '<path d="M5 3h14a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zm6 0h2v3h-2V3zm0 4h2v3h-2V7zm0 4h2v3h-2v-3zm0 4h2v3h-2v-3z"/>',
  bin: '<path d="M6 2h12a1 1 0 0 1 1 1v18H5V3a1 1 0 0 1 1-1zm2 4v2h2V6H8zm4 0v2h2V6h-2zm4 0v2h2V6h-2z"/>',
};

function fileIcon(kind) {
  const p = ICONS[kind] || ICONS.bin;
  const colors = {
    dir: 'var(--warning)', mod: 'var(--series-play)',
    log: 'var(--ink-3)', json: 'var(--warning)', jar: 'var(--serious)',
    important: 'var(--warning)', zip: 'var(--series-play)',
  };
  return `<svg class="file-ico" viewBox="0 0 24 24" fill="${colors[kind] || 'var(--ink-3)'}">${p}</svg>`;
}

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
  h.t.push(Date.now());
  // 记堆而非工作集
  h.mem.push(st.running ? memStats(st).usedMb : 0);
  h.cpu.push(st.running ? (st.cpu || 0) : 0);
  h.players.push(st.running ? st.players.online : 0);
  // FRP 隧道吞吐，单位 B/s；没有数据时记 0
  h.frpIn.push(st.frp && st.frp.rateIn != null ? st.frp.rateIn : 0);
  h.frpOut.push(st.frp && st.frp.rateOut != null ? st.frp.rateOut : 0);
  while (h.t.length > HISTORY_LEN) {
    h.t.shift(); h.mem.shift(); h.cpu.shift(); h.players.shift();
    h.frpIn.shift(); h.frpOut.shift();
  }
}

/* ─────────────────────────── 渲染：外壳 ─────────────────────────── */

/** 侧边栏行的副标题文案。 */
function serverMeta(st) {
  if (st.running) return `${st.players.online}/${st.players.max} 人 · ${Math.round(st.cpu || 0)}%`;
  return st.port ? `端口 ${st.port}` : '已停止';
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
    const row = list.querySelector(`[data-row="${st.id}"]`);
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
    el.innerHTML = `${menuButton()}<div class="server-title"><h1>RS面板</h1></div>`;
    return;
  }
  const cls = statusClass(st);
  const canStart = !st.running;
  const canStop = st.running;
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

function renderTab() {
  const content = $('#content');

  // 只销毁图表，不清空 S.view。
  for (const v of Object.values(S.view)) {
    if (v && typeof v.destroy === 'function') v.destroy();
  }

  const st = currentStatus();
  if (!st) { content.innerHTML = emptyState(); return; }

  if (S.tab === 'overview') return renderOverview(content, st);
  if (S.tab === 'console') return renderConsole(content, st);
  if (S.tab === 'files') return renderFiles(content, st);
  if (S.tab === 'players') return renderPlayers(content, st);
  if (S.tab === 'config') return renderConfig(content, st);
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
      usedMb: heap.used / 1048576,
      limitMb,
      // 卡片显示「内存占用」而非「堆内存」。
      label: '内存占用',
      hintSuffix: limitMb ? ` / ${fmtBytes(limitMb * 1048576)}` : '',
      byHeap: true,
    };
  }
  // 退回工作集时不给出百分比。
  return {
    usedMb: st.mem / 1048576,
    limitMb: null,
    label: '进程内存',
    hintSuffix: '',
    byHeap: false,
  };
}

/** FRP 卡片副标题：正常时是图例，异常时说明原因 */
function frpSubText(st) {
  const f = st.frp;
  if (!f || !f.attached || frpCardHTML(st)) return `最近 ${HISTORY_LEN} 秒`;
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
      return box('未配置 frps 管理接口' + btn('配置', 'data-action="frp-open-settings"'));
    default:
      return '';
  }
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
      <td class="muted"${x.attachHow === 'byPort' ? ' title="按本地端口自动识别，还没记进面板；在那台服务器的 FRP 页保存一次即可固定"' : ''}>${x.serverId ? esc((S.servers.find((s) => s.id === x.serverId) || {}).name || '已关联') : '未关联'}</td>
    </tr>`).join('')}
  </table>`;
}

function renderOverview(content, st) {
  const d = S.detail || {};
  const h = S.history.get(st.id) || { mem: [], cpu: [], players: [] };
  const ms = memStats(st);
  const memLimitMb = ms.limitMb;
  const memPct = memLimitMb ? Math.min(100, (ms.usedMb / memLimitMb) * 100) : null;

  content.innerHTML = `
    <div class="kpi-row">
      <div class="stat-tile">
        <div class="stat-label"><span class="status-dot ${statusClass(st)}" style="width:7px;height:7px"></span>状态</div>
        <div class="stat-value" id="kpiState">${statusText(st)}</div>
        <div class="stat-delta" id="kpiUptime">${st.running ? '已运行 ' + fmtDuration(st.uptimeMs) : '进程未运行'}</div>
      </div>

      <div class="stat-tile">
        <div class="stat-label">CPU 占用</div>
        <div class="stat-value" id="kpiCpu">—<span class="unit">%</span></div>
        <div class="stat-delta" id="kpiCpuHint">占整机 ${S.panel ? '' : ''}所有核心的百分比</div>
        ${sparkline(h.cpu.slice(-40), 'var(--series-mem)')}
      </div>

      <div class="stat-tile">
        <div class="stat-label" id="kpiMemLabel">${ms.label}</div>
        <div class="stat-value" id="kpiMem">—</div>
        <div class="meter ${memPct > 90 ? 'crit' : memPct > 75 ? 'warn' : ''}" id="kpiMemMeter"><i style="width:0%"></i></div>
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
        <div id="frpCardBody">${frpCardHTML(st, S.view.frpOv) || '<div id="chartFrp"></div>'}</div>
      </div>
      <div class="card">
        <div class="card-head">
          <div class="card-title">全部隧道</div>
          <div class="card-sub" id="frpTunnelsSub">${frpTunnelsSub(S.view.frpOv)}</div>
        </div>
        <div id="frpTunnels">${frpTunnelsHTML(S.view.frpOv)}</div>
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
                ? '<span class="tag" title="stdin 通道已随旧面板一起消失，但该服务器已启用 RCON，指令仍可发送">面板重启 · 经 RCON 控制</span>'
                : '<span class="tag" title="面板重启过，无法再写入该进程的控制台，指令须走 RCON">已失去控制台通道</span>')
              : ''}`
            : (st.running ? '<span class="tag">外部启动</span>' : '')}</dd>
          <dt>Mods</dt><dd>${d.stats?.mods ?? 0}${d.stats?.plugins ? ` · 插件 ${d.stats.plugins}` : ''}</dd>
          <dt>World</dt><dd>${esc(st.world?.name || '—')} ${st.world?.size != null ? `<span class="muted">(${fmtBytes(st.world.size)})</span>` : ''}</dd>
          <dt>RCON</dt><dd>${d.rcon?.available ? '<span style="color:var(--good)">已启用</span>' : '<span class="muted">未启用</span>'}</dd>
        </dl>
        <div class="row" style="margin-top:14px">
          <button class="btn btn-sm" data-action="open-launch-settings">启动设置</button>
          <button class="btn btn-sm" data-action="reload-detail">刷新信息</button>
          <button class="btn btn-sm btn-danger" data-action="remove-server">移除服务器</button>
        </div>
      </div>
    </div>
  `;

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

  S.view.frpCardState = frpCardState(st, S.view.frpOv);

  // 隧道列表只在没缓存时补拉；卡片正文由 updateOverview 按状态刷新
  if (!S.view.frpOv) {
    api('/api/frp').then((r) => {
      S.view.frpOv = r;
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
}

/** 下载进行中时轮询进度 */
function frpCardPoll() {
  const job = S.view.frpOv && S.view.frpOv.download && S.view.frpOv.download.job;
  if (!job || job.status !== 'running') return;
  setTimeout(async () => {
    if (S.tab !== 'overview') return;
    try {
      const r = await api('/api/frp');
      S.view.frpOv = r;
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

  const set = (id, html) => { const e = $('#' + id); if (e) e.innerHTML = html; };
  set('kpiState', statusText(st));
  const dot = $('#kpiState')?.previousElementSibling?.querySelector?.('.status-dot');
  if (dot) dot.className = 'status-dot ' + statusClass(st);
  set('kpiUptime', st.running ? '已运行 ' + fmtDuration(st.uptimeMs) : '进程未运行');
  set('kpiCpu', st.running ? `${(st.cpu ?? 0).toFixed(1)}<span class="unit">%</span>` : '—<span class="unit">%</span>');
  set('kpiMem', st.running ? fmtBytes(ms.usedMb * 1048576) : '—');
  set('kpiMemLabel', ms.label);
  set('kpiMemHint', st.running
    ? (ms.byHeap ? 'JVM 堆实时占用' : '读不到 JVM 堆（该运行时没有 jcmd）')
    : '进程未运行');
  set('kpiPlayers', st.running ? `${st.players.online}<span class="unit">/ ${st.players.max}</span>` : '—');
  set('kpiPlayersHint', st.running ? '当前在线' : '进程未运行');
  set('kpiTps', st.tps != null ? st.tps.toFixed(1) : '—');
  const tpsHint = $('#kpiTpsHint');
  if (tpsHint) {
    tpsHint.textContent = tpsHintText(st);
    tpsHint.title = TPS_TIP;
  }

  const meter = $('#kpiMemMeter');
  if (meter) {
    const pct = memPct ?? 0;
    meter.className = 'meter ' + (memPct == null ? '' : pct > 90 ? 'crit' : pct > 75 ? 'warn' : '');
    meter.firstElementChild.style.width = pct + '%';
  }

  S.view.chartMem.update(h.t.map((t, i) => ({ t, v: h.mem[i] })));
  S.view.chartPlayers.update(h.t.map((t, i) => ({ t, v: h.players[i] })));
  if (S.view.chartFrp) {
    S.view.chartFrp.update(
      h.t.map((t, i) => ({ t, v: h.frpIn[i] || 0 })),
      h.t.map((t, i) => ({ t, v: h.frpOut[i] || 0 })),
    );
  }

  // 网络状况卡在提示态时随状态重画；一旦能画图了就把图表建出来
  if ($('#frpCardBody')) {
    const state = frpCardState(st, S.view.frpOv);
    if (state === 'chart') {
      if (!$('#chartFrp')) renderTab();
    } else if (state !== S.view.frpCardState) {
      S.view.frpCardState = state;
      $('#frpCardBody').innerHTML = frpCardHTML(st, S.view.frpOv);
    }
  }
}

/* ─────────────────────────── 控制台 ─────────────────────────── */

function renderConsole(content, st) {
  const d = S.detail || {};
  const controllable = st.managed || d.rcon?.available;
  // 面板重启会失去 stdin 通道，此时服务器仍在运行，与「非面板启动」是两回事，提示要分开。
  const noConsoleHint = st.stdinLost
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
      <div class="console-body" id="consoleBody"></div>
      <div class="console-input">
        <input id="consoleInput" class="mono" placeholder="${controllable ? '输入指令后回车，例如：say 大家好' : '该服务器未启用 RCON，无法发送指令'}"
               ${controllable ? '' : 'disabled'} autocomplete="off" spellcheck="false">
        <button class="btn btn-primary" data-action="send-cmd" ${controllable ? '' : 'disabled'}>发送</button>
      </div>
    </div>`;

  const body = $('#consoleBody');
  body.innerHTML = '';
  // 渲染窗口与 server.js 的 SSE_LOG_BACKLOG 同宽
  for (const l of S.logs.slice(-1200)) body.appendChild(logNode(l));
  scrollConsole(true);

  const input = $('#consoleInput');
  if (input && controllable) {
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); sendConsole(); }
      if (e.key === 'ArrowUp') { e.preventDefault(); historyNav(-1); }
      if (e.key === 'ArrowDown') { e.preventDefault(); historyNav(1); }
    });
  }
  body.addEventListener('scroll', () => {
    S.autoScroll = body.scrollTop + body.clientHeight >= body.scrollHeight - 30;
  });
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
  const body = $('#consoleBody');
  if (!body) return;
  body.appendChild(logNode(l));
  while (body.childElementCount > 1500) body.removeChild(body.firstElementChild);
  scrollConsole(false);
}

function scrollConsole(force) {
  const body = $('#consoleBody');
  if (!body) return;
  if (force || S.autoScroll) body.scrollTop = body.scrollHeight;
}

/* ─────────────────────────── 文件管理 ─────────────────────────── */

async function loadFiles(path) {
  const data = await api(`/api/servers/${S.current}/files?path=${encodeURIComponent(path)}`);
  S.filePath = path;
  S.view.files = data;
  if (S.tab === 'files') renderTab();
}

function renderFiles(content, st) {
  const d = S.view.files;
  if (!d) {
    content.innerHTML = `<div class="empty">正在读取目录…</div>`;
    loadFiles(S.filePath || '').catch((e) => toast(e.message, 'err'));
    return;
  }
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
          ${d.entries.map((e) => `
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
    </div>`;
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
    api(`/api/servers/${S.current}/players`)
      .then((r) => { S.view.players = r; if (S.tab === 'players') renderTab(); })
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
    api(`/api/servers/${S.current}/props`)
      .then((r) => { S.view.props = r; if (S.tab === 'config') renderTab(); })
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
    const r = await api(`/api/servers/${S.current}/props`, { method: 'PUT', body: { changes } });
    toast(r.message || '已保存', 'ok', 7000);
    S.view.props = await api(`/api/servers/${S.current}/props`);
    renderTab();
  } catch (e) {
    toast(e.message, 'err');
  }
}

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
      bodyEl.innerHTML = `
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
    },
    actions: [
      { label: '取消', variant: 'ghost' },
      {
        label: '保存',
        variant: 'primary',
        value: (bodyEl) => {
          const out = { port: bodyEl.querySelector('[data-port]').value.trim() };
          // 移动端无此开关，不提交该项。
          const xs = bodyEl.querySelector('[data-xsite="1"]');
          if (xs) out.allowCrossSite = xs.classList.contains('on');
          out.frpMirror = bodyEl.querySelector('[data-frp-mirror]').value.trim();
          out.frpVersion = bodyEl.querySelector('[data-frp-version]').value.trim();
          return out;
        },
      },
    ],
  });

  if (!res || res.port === '') return;

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

/* ─────────────────────────── FRP 管理 ─────────────────────────── */

function invalidateFrp() {
  S.view.frp = null;
  S.view.frpSrv = null;
  S.view.frpFor = null;
  S.view.frpOv = null;
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
      S.view.frpOv = ov;   // 概览页的「全部隧道」卡片共用同一份
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
  const busy = S.busy.has('frp');

  content.innerHTML = `
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
          <div class="field" style="margin:0;align-self:flex-end">
            <button class="btn btn-primary btn-sm" data-action="frp-save-proxy" ${!ov.installed ? 'disabled' : ''}>${sr.attached ? '保存' : '创建隧道'}</button>
          </div>
          ${sr.attached ? `<div class="field" style="margin:0;align-self:flex-end">
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
        <div class="muted" style="font-size:12px;margin-top:10px;line-height:1.7">
          隧道状态：${frpTunnelLine(sr)}
        </div>
      </div>
    </div>`;



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

}

async function frpRefresh() {
  invalidateFrp();
  renderTab();
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
  S.view.frpOv = null;
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

/* ─────────────────────────── 日志 ─────────────────────────── */

function renderLogs(content, st) {
  const d = S.view.logFiles;
  if (!d && !S.openLog) {
    content.innerHTML = `<div class="empty">正在读取日志列表…</div>`;
    api(`/api/servers/${S.current}/logfiles`)
      .then((r) => { S.view.logFiles = r; if (S.tab === 'logs') renderTab(); })
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
      </div>`;
    const view = $('#logView');
    view.textContent = S.openLog.content;
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
    api(`/api/servers/${S.current}/backups`)
      .then((r) => { S.view.backups = r; if (S.tab === 'backups') renderTab(); })
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
  // 各标签页缓存都在 S.view，清空它即可
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
    await loadDetail(id);
    await loadState();
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
    const onKey = (e) => { if (e.key === 'Escape') close(null); };
    const close = (v) => { back.remove(); document.removeEventListener('keydown', onKey); resolve(v); };
    document.addEventListener('keydown', onKey);
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
        S.view = {};
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
      case 'clear-console':
        S.logs = [];
        $('#consoleBody').innerHTML = '';
        return;
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
      case 'open-props-raw': {
        S.tab = 'files';
        renderTabs();
        return openFile('server.properties');
      }
      case 'open-log': {
        S.openLog = await api(`/api/servers/${S.current}/logfile?file=${encodeURIComponent(el.dataset.file)}`);
        return renderTab();
      }
      case 'close-log': {
        S.openLog = null;
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
        `/api/servers/${S.current}/file/upload?path=${encodeURIComponent(dir)}&name=${encodeURIComponent(name)}`,
        { method: 'POST', body: item.file });
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

boot();
