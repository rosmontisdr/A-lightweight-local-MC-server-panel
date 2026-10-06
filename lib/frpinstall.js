'use strict';
/**
 * frpc 的探测、下载与安装。
 * 下载源默认 GitHub 官方，可在设置里换成镜像前缀；下载与解压全程在 data/ 下的空目录里进行。
 */
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const crypto = require('crypto');
const { execFile } = require('child_process');

const { uid } = require('./util');
const { DATA_DIR } = require('./store');
const archive = require('./archive');

const GITHUB_API = 'https://api.github.com/repos/fatedier/frp/releases/latest';
const RELEASE_BASE = 'https://github.com/fatedier/frp/releases/download';

/**
 * 可选的下载源。
 * official：官方 frp release，包里是整目录，解压后取 frpc.exe。
 * lazy：用户自己的 frpc-tray，包里就一个裸 exe（不是 zip），下下来直接放目标目录。
 */
const SOURCES = {
  official: {
    id: 'official',
    label: '官方 frpc',
    note: 'fatedier/frp 官方发行版，通用',
    kind: 'zip',
    api: GITHUB_API,
    base: RELEASE_BASE,
  },
  lazy: {
    id: 'lazy',
    label: '懒人 frpc',
    note: '开箱即用，推荐',
    recommend: true,
    kind: 'exe',
    asset: 'frpc-tray.exe',
    api: 'https://api.github.com/repos/rosmontisdr/Client-specialized-frpc/releases/latest',
    base: 'https://github.com/rosmontisdr/Client-specialized-frpc/releases/download',
  },
};

function sourceOf(id) {
  return SOURCES[id] || SOURCES.official;
}
const DEFAULT_VERSION = '0.66.0';
const UA = 'RSPanel';
const MAX_BYTES = 200 * 1024 * 1024;

const PLATFORM = { win32: 'windows', linux: 'linux', darwin: 'darwin' };
const ARCH = { x64: 'amd64', arm64: 'arm64', ia32: '386', arm: 'arm' };

/** 拼接下载地址；mirror 为前缀时直接前置 */
function withMirror(url, mirror) {
  const m = String(mirror == null ? '' : mirror).trim();
  return m ? m.replace(/\/+$/, '') + '/' + url : url;
}

/** 本机对应的安装包文件名 */
function pickAsset(version, platform = process.platform, arch = process.arch) {
  const p = PLATFORM[platform];
  const a = ARCH[arch];
  if (!p || !a) throw new Error(`本机平台暂不支持：${platform}/${arch}`);
  if (platform === 'win32' && a !== 'amd64' && a !== 'arm64') {
    throw new Error('Windows 只有 amd64 与 arm64 两种安装包');
  }
  const ext = platform === 'win32' ? 'zip' : 'tar.gz';
  return `frp_${version}_${p}_${a}.${ext}`;
}

/** 在目录里找 frpc 可执行文件，取路径最浅的一个 */
function locateFrpc(dir) {
  const hits = [];
  const walk = (d, depth) => {
    if (depth > 3) return;
    let entries = [];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (/^frpc(\.exe)?$/i.test(e.name)) hits.push(p);
    }
  };
  walk(dir, 0);
  if (!hits.length) return null;
  return hits.sort((a, b) => a.split(path.sep).length - b.split(path.sep).length)[0];
}

/** 目录名形如 frp_0.71.0_windows_amd64 时取出 0.71.0 */
function versionFromDir(dir) {
  const m = /frp_(\d+\.\d+\.\d+)/i.exec(path.basename(String(dir)));
  return m ? m[1] : null;
}

function probeVersion(exePath) {
  return new Promise((resolve) => {
    execFile(exePath, ['-v'], { timeout: 5000, windowsHide: true }, (err, stdout, stderr) => {
      if (err && !stdout && !stderr) return resolve(null);
      const m = /(\d+\.\d+\.\d+)/.exec(String(stdout || '') + String(stderr || ''));
      resolve(m ? m[1] : null);
    });
  });
}

/**
 * 探测一个目录里是否装好了 frp。
 * kind='tray' 表示目录里是 frpc-tray（单文件启动器），它的配置在 exe 尾部、没有独立的 frpc.toml。
 */
function detect(dir) {
  const abs = dir ? path.resolve(dir) : '';
  const out = { dir: abs, installed: false, kind: null, exePath: null, configPath: null, version: null };
  if (!abs || !fs.existsSync(abs)) return out;

  const trayExe = path.join(abs, 'frpc-tray.exe');
  if (fs.existsSync(trayExe)) {
    out.installed = true;
    out.kind = 'tray';
    out.exePath = trayExe;
    return out;
  }

  const exe = locateFrpc(abs);
  if (!exe) return out;
  out.installed = true;
  out.kind = 'frpc';
  out.exePath = exe;
  out.version = versionFromDir(path.dirname(exe));
  const cfg = path.join(path.dirname(exe), 'frpc.toml');
  out.configPath = fs.existsSync(cfg) ? cfg : null;
  return out;
}

/* ─────────────────────────── 联网与发布版本 ─────────────────────────── */

let onlineCache = { at: 0, value: false };

/** 是否能连上下载源。结果缓存 60 秒。 */
async function isOnline(mirror) {
  if (Date.now() - onlineCache.at < 60000) return onlineCache.value;
  const targets = mirror ? [withMirror(RELEASE_BASE, mirror), 'https://api.github.com'] : ['https://api.github.com'];
  let ok = false;
  for (const url of targets) {
    try {
      const r = await fetch(url, { method: 'HEAD', headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(4000) });
      if (r.status < 500) { ok = true; break; }
    } catch {}
  }
  onlineCache = { at: Date.now(), value: ok };
  return ok;
}

/**
 * 确定要装的版本与下载地址。
 * 设置了 version 时完全不请求 GitHub，只通镜像的环境也能用。
 */

async function resolveRelease({ mirror = '', version = '', source = 'official' } = {}) {
  const src = sourceOf(source);
  let tag = '';
  let warn = null;
  let assets = null;

  if (version) {
    tag = 'v' + String(version).trim().replace(/^v/, '');
  } else {
    try {
      const r = await fetch(src.api, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(8000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      tag = String(j.tag_name || '');
      assets = Array.isArray(j.assets) ? j.assets : null;
      if (!tag) throw new Error('返回里没有版本号');
    } catch (e) {
      // 官方源查不到就退回内置版本；另一个源没有内置版本可退，直接报错
      if (src.id !== 'official') throw new Error(`查询 ${src.label} 的最新版失败：${e.message}`);
      tag = 'v' + DEFAULT_VERSION;
      warn = `查询最新版失败（${e.message}），改用内置版本 ${DEFAULT_VERSION}`;
    }
  }

  const ver = tag.replace(/^v/, '');
  const asset = src.asset || pickAsset(ver);
  // 固定包名时不必去核对资产列表；官方源要顺带确认这个平台的包确实存在
  let official = `${src.base}/${tag}/${asset}`;
  if (src.kind !== 'zip') {
    // 什么都不用做，直接用声明好的包名
  } else if (assets) {
    const names = assets.map((a) => a.name);
    const hit = names.find((n) => n.toLowerCase() === asset.toLowerCase());
    if (!hit) throw new Error(`${src.label} 的 ${tag} 里没有 ${asset}。实际有的资产：${names.join('、') || '（无）'}`);
    official = `${src.base}/${tag}/${hit}`;
  }
  return {
    version: ver, asset, official, url: withMirror(official, mirror), warn,
    source: src.id, kind: src.kind, label: src.label,
  };
}

/* ─────────────────────────── 下载 ─────────────────────────── */

async function download(url, destFile, onProgress, kind = 'zip') {
  let res;
  try {
    res = await fetch(url, {
      redirect: 'follow',
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(300000),
    });
  } catch (e) {
    throw new Error(`下载失败：${(e && e.cause && e.cause.code) || e.message}`);
  }
  if (!res.ok) throw new Error(`下载失败：HTTP ${res.status}`);

  const total = Number(res.headers.get('content-length')) || 0;
  if (total > MAX_BYTES) throw new Error('安装包体积异常，已中止');

  let received = 0;
  const src = Readable.fromWeb(res.body);
  src.on('data', (c) => {
    received += c.length;
    if (received > MAX_BYTES) src.destroy(new Error('安装包体积异常，已中止'));
    if (onProgress) onProgress(received, total);
  });
  await pipeline(src, fs.createWriteStream(destFile));

  // 镜像站返回 200 + 错误页是常见情况，落盘后按种类校验文件头
  const fd = fs.openSync(destFile, 'r');
  const head = Buffer.alloc(4);
  try {
    fs.readSync(fd, head, 0, 4, 0);
  } finally {
    fs.closeSync(fd);
  }
  const wantExe = kind === 'exe';
  const ok = wantExe ? (head[0] === 0x4d && head[1] === 0x5a) : (head[0] === 0x50 && head[1] === 0x4b);
  if (!ok) {
    throw new Error(`下到的不是${wantExe ? '可执行文件' : '压缩包'}（可能是错误页），请检查镜像地址`);
  }
  return { bytes: received, total };
}

async function sha256(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
  });
}

/** 尽力校验官方校验和；拿不到就跳过，不阻断安装 */
async function verifyChecksum(zipPath, { version, asset, mirror }) {
  const url = withMirror(`${RELEASE_BASE}/v${version}/frp_sha256_checksums.txt`, mirror);
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(8000) });
    if (!r.ok) return { checked: false };
    const text = await r.text();
    const line = text.split(/\r?\n/).find((l) => l.trim().endsWith(asset));
    if (!line) return { checked: false };
    const want = line.trim().split(/\s+/)[0].toLowerCase();
    const got = await sha256(zipPath);
    if (want !== got) throw new Error('安装包校验不通过，已删除');
    return { checked: true };
  } catch (e) {
    if (/校验不通过/.test(e.message)) throw e;
    return { checked: false };
  }
}

/* ─────────────────────────── 安装 ─────────────────────────── */

/** 把解压出来、frpc 所在的那一层铺进 frp 目录；已存在的 frpc.toml 不动 */
function installInto(srcDir, frpDir) {
  const exe = locateFrpc(srcDir);
  if (!exe) throw new Error('安装包解压后没找到 frpc，可能下错了平台');
  const from = path.dirname(exe);
  fs.mkdirSync(frpDir, { recursive: true });
  const copied = [];
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    if (!e.isFile()) continue;
    const to = path.join(frpDir, e.name);
    if (/^frpc\.toml$/i.test(e.name) && fs.existsSync(to)) continue;
    fs.copyFileSync(path.join(from, e.name), to);
    copied.push(e.name);
  }
  return { exePath: path.join(frpDir, path.basename(exe)), copied };
}

/** 清掉上次中断留下的下载暂存目录 */
function cleanupStale() {
  let names = [];
  try {
    names = fs.readdirSync(DATA_DIR);
  } catch {
    return;
  }
  for (const n of names) {
    if (!/^frp-download-/.test(n)) continue;
    try {
      fs.rmSync(path.join(DATA_DIR, n), { recursive: true, force: true });
    } catch {}
  }
}

/* ─────────────────────────── 下载任务 ─────────────────────────── */

let job = null;

function getJob() {
  return job;
}

function newStaging() {
  const dir = path.join(DATA_DIR, 'frp-download-' + uid());
  fs.mkdirSync(dir);
  if (fs.readdirSync(dir).length !== 0) throw new Error('下载暂存目录非空，已拒绝');
  return dir;
}

/**
 * 启动一次下载安装。同一时刻只允许一个任务。
 * @returns 任务状态对象（随后由 getJob() 轮询）
 */
function startDownload({ mirror = '', version = '', frpDir, source = 'official' }) {
  if (job && job.status === 'running') throw new Error('已有一个下载任务在进行');
  if (!frpDir) throw new Error('请先选择 frp 目录');

  job = {
    status: 'running',
    phase: '准备',
    received: 0,
    total: 0,
    percent: 0,
    message: '',
    error: null,
    version: version || '',
    asset: '',
  };

  const run = async () => {
    let staging = null;
    try {
      staging = newStaging();
      job.phase = '查询版本';
      const rel = await resolveRelease({ mirror, version, source });
      job.version = rel.version;
      job.asset = rel.asset;
      if (rel.warn) job.message = rel.warn;

      const onProgress = (got, total) => {
        job.received = got;
        job.total = total;
        job.percent = total ? Math.min(99, Math.round((got / total) * 100)) : 0;
      };

      // 懒人 frpc 是单个裸 exe，下到暂存目录校验后再放过去；官方源是整目录的 zip
      if (rel.kind === 'exe') {
        const tmp = path.join(staging, rel.asset);
        job.phase = '下载';
        await download(rel.url, tmp, onProgress, 'exe');
        job.phase = '安装';
        fs.mkdirSync(frpDir, { recursive: true });
        const dest = path.join(frpDir, rel.asset);
        fs.copyFileSync(tmp, dest);
        job.percent = 100;
        job.status = 'done';
        job.phase = '完成';
        job.message = `已安装${rel.label} ${rel.version}`;
        job.result = { version: rel.version, exePath: dest, source: rel.source };
        return;
      }

      const zip = path.join(staging, 'frp.zip');
      job.phase = '下载';
      await download(rel.url, zip, onProgress);

      job.phase = '校验';
      await verifyChecksum(zip, { version: rel.version, asset: rel.asset, mirror });

      job.phase = '解压';
      await archive.extract(staging, 'frp.zip', null, { overwrite: true });

      job.phase = '安装';
      const { exePath, copied } = installInto(staging, frpDir);
      job.percent = 100;
      job.status = 'done';
      job.phase = '完成';
      job.message = `已安装 frp ${rel.version}`;
      job.result = { version: rel.version, exePath, copied };
    } catch (e) {
      job.status = 'error';
      job.error = e && e.message ? e.message : String(e);
    } finally {
      if (staging) {
        try {
          fs.rmSync(staging, { recursive: true, force: true });
        } catch {}
      }
    }
  };

  run();
  return job;
}

module.exports = {
  detect,
  locateFrpc,
  versionFromDir,
  probeVersion,
  isOnline,
  resolveRelease,
  pickAsset,
  SOURCES,
  sourceOf,
  download,
  installInto,
  cleanupStale,
  startDownload,
  getJob,
  DEFAULT_VERSION,
};
