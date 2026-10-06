'use strict';
/**
 * frpc.toml 定点编辑：只改写目标行，不整体解析、不重排、不丢注释。
 * 段落扫描定位 [[proxies]] 条目与顶层段，字段值就地替换。
 * 写盘前备份为 <文件>.bak，写后重新解析校验条目数，不符则回滚。
 */
const fs = require('fs');
const path = require('path');

const HEADER_RE = /^\s*(\[\[?)([^\]\n]+?)(\]\]?)\s*(#.*)?$/;
const KV_RE = /^(\s*)([A-Za-z_][\w.-]*|"[^"]*")(\s*)=(\s*)(.*)$/;

const WEB_SERVER_MARK = '# mcpanel:webServer';
const PROXY_KEYS = ['name', 'type', 'localIP', 'localPort', 'remotePort'];

const EOL = (text) => (/\r\n/.test(text) ? '\r\n' : '\n');

function read(file) {
  let text = '';
  let exists = false;
  let mtimeMs = 0;
  try {
    text = fs.readFileSync(file, 'utf8');
    mtimeMs = fs.statSync(file).mtimeMs;
    exists = true;
  } catch {}
  return { text, eol: EOL(text), exists, mtimeMs };
}

/** 去掉 TOML 字符串的引号与转义 */
function unquote(v) {
  const s = String(v).trim();
  if (s.length >= 2 && s[0] === '"' && s[s.length - 1] === '"') {
    return s.slice(1, -1).replace(/\\(["\\])/g, '$1');
  }
  if (s.length >= 2 && s[0] === "'" && s[s.length - 1] === "'") return s.slice(1, -1);
  return s;
}

/** 基本字符串字面量 */
function quote(v) {
  return '"' + String(v).replace(/[\\"]/g, (c) => '\\' + c) + '"';
}

/** 拆出值与其后的行尾注释，# 在引号内不算注释 */
function splitRHS(rhs) {
  let q = null;
  for (let i = 0; i < rhs.length; i++) {
    const c = rhs[i];
    if (q) {
      if (c === '\\') i++;
      else if (c === q) q = null;
      continue;
    }
    if (c === '"' || c === "'") { q = c; continue; }
    if (c === '#') return { value: rhs.slice(0, i), comment: rhs.slice(i) };
  }
  return { value: rhs, comment: '' };
}

/** 扫描全部段头 */
function sections(lines) {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(HEADER_RE);
    if (!m) continue;
    out.push({ kind: m[1] === '[[' ? 'array' : 'table', path: unquote(m[2]), line: i });
  }
  return out;
}

/**
 * [[proxies]] 条目的行范围。
 * 紧随其后的 [proxies.xxx] 子表并入该条目，遇到其它段头即结束。
 */
function proxySpans(lines) {
  const secs = sections(lines);
  const spans = [];
  for (let i = 0; i < secs.length; i++) {
    const s = secs[i];
    if (s.kind !== 'array' || s.path.toLowerCase() !== 'proxies') continue;
    let end = lines.length;
    for (let j = i + 1; j < secs.length; j++) {
      const n = secs[j];
      if (n.path.toLowerCase().startsWith('proxies.')) continue;
      end = n.line;
      break;
    }
    spans.push({ start: s.line, end });
  }
  return spans;
}

/** 条目自身的键值行（子表之前的部分） */
function ownFieldLines(lines, span) {
  const out = [];
  for (let i = span.start + 1; i < span.end; i++) {
    if (HEADER_RE.test(lines[i])) break;
    const m = lines[i].match(KV_RE);
    if (!m) continue;
    out.push({ line: i, key: unquote(m[2]), rhs: splitRHS(m[5]), m });
  }
  return out;
}

function parseFields(lines, span) {
  const out = {};
  for (const f of ownFieldLines(lines, span)) {
    if (f.key === 'localPort' || f.key === 'remotePort') out[f.key] = Number(f.rhs.value.trim());
    else if (PROXY_KEYS.includes(f.key)) out[f.key] = unquote(f.rhs.value);
  }
  return out;
}

/** 读取全部 [[proxies]] 条目 */
function listProxies(text) {
  const lines = String(text).split(/\r?\n/);
  return proxySpans(lines).map((span) => {
    const f = parseFields(lines, span);
    return {
      name: f.name || '',
      type: f.type || 'tcp',
      localIP: f.localIP || '',
      localPort: Number.isFinite(f.localPort) ? f.localPort : null,
      remotePort: Number.isFinite(f.remotePort) ? f.remotePort : null,
      startLine: span.start,
      endLine: span.end,
    };
  });
}

function findProxy(text, name) {
  return listProxies(text).find((p) => p.name === name) || null;
}

/** 顶层键（serverAddr / serverPort / user / auth.token） */
function parseTop(text) {
  const lines = String(text).split(/\r?\n/);
  const secs = sections(lines);
  const stopAt = secs.length ? secs[0].line : lines.length;
  const out = { serverAddr: '', serverPort: null, user: '', token: '', includes: [] };
  for (let i = 0; i < stopAt; i++) {
    const m = lines[i].match(KV_RE);
    if (!m) continue;
    const key = unquote(m[2]);
    const val = splitRHS(m[5]).value.trim();
    if (key === 'serverAddr') out.serverAddr = unquote(val);
    else if (key === 'serverPort') out.serverPort = Number(val);
    else if (key === 'user') out.user = unquote(val);
    else if (key === 'auth.token') out.token = unquote(val);
    else if (key === 'includes') out.includes.push(unquote(val));
  }
  return out;
}

const TOP_KEYS = ['serverAddr', 'serverPort', 'auth.token'];

/**
 * 就地改写顶层键。缺失的键补到首个段头之前。
 * @returns {{text:string, changed:string[]}}
 */
function setTopFields(text, patch) {
  const lines = String(text).split(/\r?\n/);
  const secs = sections(lines);
  const stopAt = secs.length ? secs[0].line : lines.length;
  const changed = [];
  const pending = [];

  for (const key of TOP_KEYS) {
    if (!(key in patch)) continue;
    const raw = patch[key];
    if (raw == null) continue;
    const rendered = key === 'serverPort' ? String(raw) : quote(raw);

    let hit = -1;
    for (let i = 0; i < stopAt; i++) {
      const m = lines[i].match(KV_RE);
      if (m && unquote(m[2]) === key) { hit = i; break; }
    }
    if (hit >= 0) {
      const m = lines[hit].match(KV_RE);
      if (splitRHS(m[5]).value.trim() === rendered) continue;
      lines[hit] = setLine(lines[hit], rendered);
    } else {
      pending.push(`${key} = ${rendered}`);
    }
    changed.push(key);
  }

  if (pending.length) {
    let at = secs.length ? secs[0].line : lines.length;
    while (at > 0 && lines[at - 1].trim() === '') at--;
    lines.splice(at, 0, ...pending);
  }
  return { text: lines.join(EOL(text)), changed };
}

/** 改写一行中的值，保留缩进、等号两侧空白与行尾注释 */
function setLine(line, value) {
  const m = line.match(KV_RE);
  if (!m) return line;
  const { comment } = splitRHS(m[5]);
  return `${m[1]}${m[2]}${m[3]}=${m[4]}${value}${comment ? ' ' + comment : ''}`;
}

const render = (key, v) => (key === 'localPort' || key === 'remotePort' ? String(v) : quote(v));

/**
 * 就地改写指定条目的字段。缺失的键插到 type 之后。
 * @returns {{text:string, changed:string[]}}
 */
function setProxyFields(text, name, patch) {
  const lines = String(text).split(/\r?\n/);
  const spans = proxySpans(lines);
  let target = null;
  for (const span of spans) {
    const f = parseFields(lines, span);
    if (f.name === name) { target = { span, f }; break; }
  }
  if (!target) throw new Error('隧道不存在: ' + name);

  const changed = [];
  for (const key of PROXY_KEYS) {
    if (!(key in patch)) continue;
    const value = render(key, patch[key]);
    const hit = ownFieldLines(lines, target.span).find((x) => x.key === key);
    if (hit) {
      if (hit.rhs.value.trim() === value) continue;
      lines[hit.line] = setLine(lines[hit.line], value);
    } else {
      const after = ownFieldLines(lines, target.span).find((x) => x.key === 'type');
      lines.splice((after ? after.line : target.span.start) + 1, 0, `${key} = ${value}`);
    }
    changed.push(key);
  }
  return { text: lines.join(EOL(text)), changed };
}

/** 追加一条 [[proxies]] 到文件末尾 */
function addProxy(text, fields) {
  const src = String(text);
  const eol = EOL(src);
  const base = src.replace(/[\s\r\n]+$/, '');
  const block = [
    '',
    '[[proxies]]',
    `name = ${quote(fields.name)}`,
    `type = ${quote(fields.type || 'tcp')}`,
  ];
  if (fields.localIP) block.push(`localIP = ${quote(fields.localIP)}`);
  if (fields.localPort != null) block.push(`localPort = ${fields.localPort}`);
  if (fields.remotePort != null) block.push(`remotePort = ${fields.remotePort}`);
  return { text: (base ? base + eol : '') + block.join(eol) + eol };
}

/** 删除一条 [[proxies]]（含其子表），上方的注释块保留 */
function removeProxy(text, name) {
  const lines = String(text).split(/\r?\n/);
  const spans = proxySpans(lines);
  for (const span of spans) {
    if (parseFields(lines, span).name !== name) continue;
    lines.splice(span.start, span.end - span.start);
    return { text: lines.join(EOL(text)), removed: true };
  }
  return { text: String(text), removed: false };
}

/** 读取 [webServer] 段；managed 表示带面板标记 */
function readWebServer(text) {
  const lines = String(text).split(/\r?\n/);
  const secs = sections(lines);
  const idx = secs.findIndex((s) => s.kind === 'table' && s.path.toLowerCase() === 'webserver');
  if (idx < 0) return null;
  const start = secs[idx].line;
  let end = lines.length;
  for (let j = idx + 1; j < secs.length; j++) { end = secs[j].line; break; }
  const out = { addr: '', port: null, user: '', password: '', managed: false, startLine: start, endLine: end };
  for (let i = start + 1; i < end; i++) {
    const m = lines[i].match(KV_RE);
    if (!m) continue;
    const key = unquote(m[2]);
    const val = splitRHS(m[5]).value.trim();
    if (key === 'addr') out.addr = unquote(val);
    else if (key === 'port') out.port = Number(val);
    else if (key === 'user') out.user = unquote(val);
    else if (key === 'password') out.password = unquote(val);
  }
  out.managed = start > 0 && lines[start - 1].trim() === WEB_SERVER_MARK;
  return out;
}

/** [webServer] 不存在则追加；已存在则原样保留并回读 */
function ensureWebServer(text, cfg) {
  const cur = readWebServer(text);
  if (cur) return { text: String(text), created: false, cfg: cur };
  const src = String(text);
  const eol = EOL(src);
  const base = src.replace(/[\s\r\n]+$/, '');
  const block = [
    '',
    WEB_SERVER_MARK,
    '[webServer]',
    'addr = "127.0.0.1"',
    `port = ${cfg.port}`,
    `user = ${quote(cfg.user)}`,
    `password = ${quote(cfg.password)}`,
  ];
  const next = (base ? base + eol : '') + block.join(eol) + eol;
  return { text: next, created: true, cfg: { ...cfg, managed: true } };
}

/** 校验一条隧道的字段；不合法即抛错 */
function validateProxy(fields, { existing = [] } = {}) {
  const name = String(fields.name == null ? '' : fields.name).trim();
  if (!name) throw new Error('隧道名不能为空');
  if (!/^[A-Za-z0-9_.-]{1,64}$/.test(name)) {
    throw new Error('隧道名只能用字母、数字、下划线、点与连字符（1-64 位）');
  }
  if (existing.includes(name)) throw new Error('隧道名已存在: ' + name);
  const type = String(fields.type || 'tcp').toLowerCase();
  if (!['tcp', 'udp'].includes(type)) throw new Error('只支持 tcp 与 udp 隧道');

  const ip = String(fields.localIP == null ? '' : fields.localIP).trim();
  if (!/^[A-Za-z0-9_.:-]{1,64}$/.test(ip)) throw new Error('本地地址非法: ' + ip);

  const lp = Number(fields.localPort);
  if (!Number.isInteger(lp) || lp < 1 || lp > 65535) throw new Error('本地端口须为 1-65535 的整数');
  const rp = Number(fields.remotePort);
  if (!Number.isInteger(rp) || rp < 1 || rp > 65535) throw new Error('远端端口须为 1-65535 的整数');
  return { name, type, localIP: ip, localPort: lp, remotePort: rp };
}

/**
 * 写盘：先备份原文件为 <file>.bak，再写临时文件并改名。
 * 写后校验条目数，与预期不符则用备份回滚。
 */
function writeAtomic(file, text, expectProxies) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const bak = file + '.bak';
  if (fs.existsSync(file)) fs.copyFileSync(file, bak);

  if (expectProxies != null) {
    const got = listProxies(text).length;
    if (got !== expectProxies) throw new Error(`写入前校验失败：条目数应为 ${expectProxies}，实际 ${got}`);
  }

  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);

  try {
    if (expectProxies != null && listProxies(fs.readFileSync(file, 'utf8')).length !== expectProxies) {
      throw new Error('条目数不符');
    }
  } catch (e) {
    if (fs.existsSync(bak)) fs.copyFileSync(bak, file);
    throw new Error('frpc.toml 写入后校验失败，已回滚：' + e.message);
  }
  return { file, bak };
}

module.exports = {
  read,
  listProxies,
  findProxy,
  parseTop,
  setTopFields,
  TOP_KEYS,
  setProxyFields,
  addProxy,
  removeProxy,
  readWebServer,
  ensureWebServer,
  validateProxy,
  writeAtomic,
  PROXY_KEYS,
  WEB_SERVER_MARK,
};
