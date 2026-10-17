'use strict';
/* =========================================================================
   RS面板前端 · 图表 / 图标。无框架、无构建步骤，原生 JS + SVG 手绘图表。
   加载顺序：core → chart → views → panels → frp → dialogs。
   ========================================================================= */
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

/** 建立折线图的 SVG 骨架与提示层 */
function buildChartSVG(opts, height) {
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
  return { wrap, svg, gGrid, area, line, line2, cross, dot, endDot, endLabel, hit, tip };
}

/**
 * 时序折线图。单序列，标题即图例，不画图例框；末端标注当前值。
 */
function createChart(container, opts) {
  const pad = { t: 12, r: 54, b: 22, l: 46 };
  const height = opts.height || 150;
  let cachedW = 0;
  const { wrap, svg, gGrid, area, line, line2, cross, dot, endDot, endLabel, hit, tip }
    = buildChartSVG(opts, height);
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
    // 宽度由 ResizeObserver 缓存，draw 里不再读 clientWidth 触发强制布局
    if (!cachedW) cachedW = Math.max(240, wrap.clientWidth || container.clientWidth || 400);
    W = cachedW;
    // 窄屏收窄右侧留白，数值标签不再被裁
    pad.r = W < 420 ? 40 : 54;
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

    // 刻度没变就不重建网格
    const gridSig = W + '|' + ticks.join(',');
    if (gGrid._sig !== gridSig) {
      gGrid._sig = gridSig;
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

  const ro = new ResizeObserver(() => {
    cachedW = Math.max(240, wrap.clientWidth || container.clientWidth || 400);
    draw();
  });
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
