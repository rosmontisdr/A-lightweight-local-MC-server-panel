'use strict';
/**
 * 自定义：服务器图标（server-icon.png）与标题 / 副标题（server.properties 的 motd）。
 * 入服私聊的发送在 lib/mcserver.js，配置存面板的 panel.json。
 */
const fs = require('fs');
const path = require('path');
const props = require('./props');

const ICON_NAME = 'server-icon.png';
const ICON_SIDE = 64;
const ICON_MAX_BYTES = 1024 * 1024;
// 与 public/panels.js 的 MOTD_LINE_MAX / JOIN_TEXT_MAX 一致
const MOTD_LINE_MAX = 120;
const JOIN_TEXT_MAX = 200;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/* ── 服务器图标 ── */

const iconFile = (server) => path.join(server.dir, ICON_NAME);

/** 图标的现状。url 带 mtime，换了图标浏览器不会拿旧的 */
function iconInfo(server) {
  let st = null;
  try { st = fs.statSync(iconFile(server)); } catch { /* 没有图标 */ }
  if (!st || !st.isFile()) return { exists: false, size: 0, mtime: null, url: null };
  return {
    exists: true,
    size: st.size,
    mtime: st.mtime.toISOString(),
    url: `/api/servers/${encodeURIComponent(server.id)}/icon?v=${Math.floor(st.mtimeMs)}`,
  };
}

function readIcon(server) {
  try {
    const st = fs.statSync(iconFile(server));
    if (!st.isFile()) return null;
    return { buf: fs.readFileSync(iconFile(server)), size: st.size, mtime: st.mtime.toISOString() };
  } catch {
    return null;
  }
}

/** 校验：PNG 签名 + IHDR 里的宽高。Minecraft 只认 64×64 的 PNG。 */
function checkIcon(buf) {
  if (buf.length < 24 || !buf.subarray(0, 8).equals(PNG_MAGIC)) throw new Error('图标必须是 PNG 图片');
  if (buf.toString('latin1', 12, 16) !== 'IHDR') throw new Error('图标不是合法的 PNG 图片');
  const w = buf.readUInt32BE(16);
  const h = buf.readUInt32BE(20);
  if (w !== ICON_SIDE || h !== ICON_SIDE) {
    throw new Error(`图标必须是 ${ICON_SIDE}×${ICON_SIDE} 的 PNG，当前是 ${w}×${h}`);
  }
}

/** 收下上传的图标：先落临时文件并校验，通过才替换 server-icon.png（原图留 .bak）。 */
function receiveIcon(server, req, limit = ICON_MAX_BYTES) {
  const file = iconFile(server);
  const tmp = file + '.tmp';
  return new Promise((resolve, reject) => {
    const out = fs.createWriteStream(tmp);
    let size = 0;
    const fail = (e) => {
      req.unpipe(out);
      out.destroy();
      try { fs.rmSync(tmp, { force: true }); } catch { /* 失败可忽略 */ }
      reject(e);
    };
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) fail(new Error(`图标超过 ${Math.round(limit / 1024)} KB，64×64 的 PNG 通常只有几 KB`));
    });
    req.on('aborted', () => fail(new Error('上传已中断')));
    req.on('error', fail);
    out.on('error', fail);
    req.pipe(out);
    out.on('finish', () => {
      try {
        checkIcon(fs.readFileSync(tmp));
        if (fs.existsSync(file)) fs.copyFileSync(file, file + '.bak');
        fs.renameSync(tmp, file);
        resolve(iconInfo(server));
      } catch (e) {
        try { fs.rmSync(tmp, { force: true }); } catch { /* 失败可忽略 */ }
        reject(e);
      }
    });
  });
}

function removeIcon(server) {
  if (!fs.existsSync(iconFile(server))) throw new Error('这台服务器还没有设置图标');
  fs.rmSync(iconFile(server));
  return { ok: true };
}

/* ── 标题 / 副标题（server.properties 的 motd） ── */

/**
 * 解开 Java 属性的转义：\\n 换行、\\\\ 反斜杠、\\uXXXX 字符。服务端怎么读这个文件，这里就怎么解，
 * 否则 motd 里真有个反斜杠会被当成换行。一次扫完，不逐种替换。
 */
function unescapeValue(raw) {
  return String(raw == null ? '' : raw).replace(/\\(u[0-9a-fA-F]{4}|[\s\S])/g, (m, g) => {
    if (g[0] === 'u') return String.fromCharCode(parseInt(g.slice(1), 16));
    if (g === 'n') return '\n';
    if (g === 't') return '\t';
    return g;   // \\ → \ ；其余转义按原字符
  });
}

/** 取 motd 的两行。属性文件里换行写作 \n，两行即标题与副标题。 */
function parseMotd(raw) {
  const parts = unescapeValue(raw).split(/\r?\n/);
  return { title: parts[0] || '', subtitle: parts.slice(1).join(' ').trim() };
}

function cleanLine(s, label) {
  const v = String(s == null ? '' : s).replace(/[\r\n]+/g, ' ').trim();
  if (v.length > MOTD_LINE_MAX) throw new Error(`${label}最多 ${MOTD_LINE_MAX} 个字符`);
  return v;
}

/**
 * 编成 motd 的值：两行用 \n 连。
 * escaped 为真时非 ASCII 写成 \uXXXX——文件原本是这种写法就沿用，不把服务端写的转义改成原文。
 */
function encodeMotd(title, subtitle, escaped) {
  // 文本里的反斜杠须先转义，否则会被当成属性转义吃掉（\b 之类），也与 parseMotd 的解法对称
  const esc = (s) => s.replace(/\\/g, '\\\\');
  const t = esc(cleanLine(title, '标题'));
  const s = esc(cleanLine(subtitle, '副标题'));
  const v = t && s ? `${t}\\n${s}` : (t || s);
  return escaped
    ? v.replace(/[^\x20-\x7e]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'))
    : v;
}

/** 写回 server.properties 的 motd。原文件留 .bak，写完强制重读配置。 */
function saveMotd(server, input) {
  const file = path.join(server.dir, 'server.properties');
  if (!fs.existsSync(file)) throw new Error('这个目录里没有 server.properties');
  const text = fs.readFileSync(file, 'utf8');
  const cur = props.parse(text).map.motd;
  const escaped = !!cur && /\\u[0-9a-fA-F]{4}/.test(cur.value);
  const value = encodeMotd(input && input.title, input && input.subtitle, escaped);
  const out = props.set(text, 'motd', value);
  fs.copyFileSync(file, file + '.bak');
  fs.writeFileSync(file, out, 'utf8');
  server.getProps(true);
  return { ...parseMotd(value), raw: value };
}

/* ── 入服私聊 ── */

function normalizeJoinMsg(v) {
  const src = v && typeof v === 'object' ? v : {};
  const text = String(src.text == null ? '' : src.text).replace(/[\r\n]+/g, ' ').trim();
  return { enabled: !!src.enabled, text };
}

function checkJoinMsg(jm) {
  if (!jm.enabled) return jm;
  if (!jm.text) throw new Error('开启入服私聊时必须填写私聊内容');
  if (jm.text.length > JOIN_TEXT_MAX) throw new Error(`私聊内容最多 ${JOIN_TEXT_MAX} 个字符`);
  return jm;
}

/** 日志里的入服行 → 玩家名。原版 / Paper / Forge / Fabric 都是这一句。 */
function matchJoin(line) {
  const m = /(?:^|\s)([A-Za-z0-9_]{3,16}) joined the game\b/.exec(String(line || ''));
  return m ? m[1] : null;
}

/** 私聊内容里的 %player% 换成玩家名 */
function renderJoinText(text, player) {
  return String(text).replace(/%player%/gi, player);
}

/* ── 自定义页的数据 ── */

/** 一页要的全部内容：图标现状、两行标题、入服私聊配置与统计、指令通道 */
function view(server) {
  const { title, subtitle } = parseMotd(server.prop('motd', ''));
  const cfg = normalizeJoinMsg((server.entry.custom || {}).joinMsg);
  const stats = server.joinMsgStats ? server.joinMsgStats() : { sent: 0, last: null };
  return {
    icon: iconInfo(server),
    motd: { title, subtitle },
    joinMsg: { ...cfg, ...stats },
    // 无指令通道时私聊发不出去，界面据此提示
    channel: server.commandBlocker(),
  };
}

module.exports = {
  ICON_NAME, ICON_SIDE, ICON_MAX_BYTES, MOTD_LINE_MAX, JOIN_TEXT_MAX,
  iconFile, iconInfo, readIcon, receiveIcon, removeIcon,
  parseMotd, saveMotd, normalizeJoinMsg, checkJoinMsg, matchJoin, renderJoinText, view,
};
