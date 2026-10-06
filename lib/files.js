'use strict';
/**
 * 服务器目录的文件浏览 / 编辑。
 * 所有路径都经过 safeResolve 限制在服务器目录之内，拒绝 ../ 越界。
 */
const fs = require('fs');
const path = require('path');
const { safeResolve } = require('./util');

const MAX_EDIT_BYTES = 4 * 1024 * 1024;   // 面板内编辑上限
const MAX_DOWNLOAD_BYTES = 512 * 1024 * 1024;

/** 面板首页展示的常用文件 */
const IMPORTANT = [
  { name: 'server.properties', label: '服务器配置', kind: 'props' },
  { name: 'whitelist.json', label: '白名单', kind: 'players' },
  { name: 'ops.json', label: '管理员 OP', kind: 'players' },
  { name: 'banned-players.json', label: '封禁玩家', kind: 'players' },
  { name: 'banned-ips.json', label: '封禁 IP', kind: 'players' },
  { name: 'usercache.json', label: '玩家缓存', kind: 'players' },
  { name: 'eula.txt', label: 'EULA 协议', kind: 'text' },
  { name: 'user_jvm_args.txt', label: 'JVM 内存参数', kind: 'text' },
  { name: 'run.bat', label: 'Windows 启动脚本', kind: 'text' },
];

const TEXT_EXT = new Set([
  '.txt', '.properties', '.json', '.json5', '.yml', '.yaml', '.toml', '.cfg', '.conf', '.ini',
  '.log', '.md', '.csv', '.tsv', '.xml', '.html', '.js', '.ts', '.sh', '.bat', '.cmd', '.ps1',
  '.snbt', '.mcfunction', '.lang', '.env', '.gitignore',
]);

function classify(name, isDir) {
  // 目录统一归为 'dir'，所有文件夹共用同一图标，不再按 world / mods 等细分。
  if (isDir) return 'dir';
  if (IMPORTANT.some((f) => f.name === name)) return 'important';
  const ext = path.extname(name).toLowerCase();
  if (ext === '.jar') return 'jar';
  // 压缩包单独一类：文件页据此 kind 显示「解压」按钮（见 app.js renderFiles）
  if (ext === '.zip') return 'zip';
  if (ext === '.log' || ext === '.gz') return 'log';
  if (ext === '.json') return 'json';
  if (TEXT_EXT.has(ext)) return 'text';
  return 'bin';
}

function isTextFile(name) {
  const ext = path.extname(name).toLowerCase();
  return TEXT_EXT.has(ext) || name.startsWith('.');
}

function extOf(name) {
  return path.extname(name).toLowerCase().replace(/^\./, '');
}

/** 按扩展名分组的排序权重，rank 取 EXT_ORDER 下标。 */
const EXT_ORDER = [
  'jar', 'zip', 'mrpack',                                     // 服务端 / mod / 整合包
  'json', 'json5', 'properties', 'yml', 'yaml', 'toml', 'cfg', 'conf', 'ini',
  'txt', 'md', 'csv', 'tsv', 'xml',
  'log', 'gz',
  'bat', 'cmd', 'sh', 'ps1',
  'dat', 'mca', 'nbt', 'mcr', 'snbt', 'mcfunction', 'lang',
];
const EXT_RANK = new Map(EXT_ORDER.map((e, i) => [e, i]));

/** 文件排序键 [组, 组内序, 扩展名]：组 0 认识的扩展名，组 1 未知扩展名，组 2 无扩展名，依次靠后。 */
function sortKey(name) {
  const ext = extOf(name);
  if (!ext) return { g: 2, rank: 0, ext: '' };
  const i = EXT_RANK.get(ext);
  return i == null ? { g: 1, rank: 0, ext } : { g: 0, rank: i, ext: '' };
}

function list(root, rel = '') {
  const abs = safeResolve(root, rel);
  const st = fs.statSync(abs);
  if (!st.isDirectory()) throw new Error('不是目录');
  const entries = fs.readdirSync(abs, { withFileTypes: true }).map((e) => {
    const full = path.join(abs, e.name);
    let size = 0;
    let mtime = null;
    try {
      const s = fs.statSync(full);
      size = s.size;
      mtime = s.mtime.toISOString();
    } catch {}
    const isDir = e.isDirectory();
    return {
      name: e.name,
      isDir,
      size,
      mtime,
      ext: isDir ? '' : extOf(e.name),
      kind: classify(e.name, isDir),
      editable: !isDir && isTextFile(e.name) && size <= MAX_EDIT_BYTES,
    };
  });
  // 文件夹置顶按名称排；文件按扩展名分组，组内按名称。
  entries.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    if (a.isDir) return a.name.localeCompare(b.name, 'zh');
    const ka = sortKey(a.name);
    const kb = sortKey(b.name);
    if (ka.g !== kb.g) return ka.g - kb.g;
    if (ka.rank !== kb.rank) return ka.rank - kb.rank;
    if (ka.ext !== kb.ext) return ka.ext.localeCompare(kb.ext);
    return a.name.localeCompare(b.name, 'zh');
  });
  return {
    path: rel.replace(/\\/g, '/'),
    parent: rel ? path.dirname(rel.replace(/\\/g, '/')).replace(/^\.$/, '') : null,
    entries,
    important: IMPORTANT.filter((f) => fs.existsSync(path.join(abs, f.name))),
  };
}

function read(root, rel) {
  const abs = safeResolve(root, rel);
  const st = fs.statSync(abs);
  if (st.isDirectory()) throw new Error('这是一个目录');
  if (st.size > MAX_EDIT_BYTES) {
    throw new Error(`文件 ${(st.size / 1048576).toFixed(1)} MB 超过面板编辑上限，请下载后用本地编辑器打开。`);
  }
  const buf = fs.readFileSync(abs);
  // 二进制判定：前 8KB 是否含 NUL
  const probe = buf.subarray(0, 8192);
  const binary = probe.includes(0);
  if (binary) throw new Error('这是二进制文件，无法在面板中编辑。');
  let content = buf.toString('utf8');
  let encoding = 'utf-8';
  if (content.includes('�')) {
    // 非 UTF-8 时按 GBK 解码
    try {
      content = new TextDecoder('gbk').decode(buf);
      encoding = 'gbk';
    } catch {
      content = buf.toString('latin1');
      encoding = 'latin1';
    }
  }
  return {
    path: rel.replace(/\\/g, '/'),
    content,
    encoding,
    size: st.size,
    mtime: st.mtime.toISOString(),
    eol: content.includes('\r\n') ? 'crlf' : 'lf',
  };
}

function write(root, rel, content) {
  const abs = safeResolve(root, rel);
  if (!rel) throw new Error('未指定文件');
  const st = fs.existsSync(abs) ? fs.statSync(abs) : null;
  if (st && st.isDirectory()) throw new Error('目标是目录');
  // 备份一份原文件
  if (st) {
    try { fs.copyFileSync(abs, abs + '.bak'); } catch {}
  }
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
  return { path: rel.replace(/\\/g, '/'), size: Buffer.byteLength(content, 'utf8') };
}

function mkdir(root, rel, name) {
  if (!name || /[\\/:*?"<>|]/.test(name)) throw new Error('目录名包含非法字符');
  const abs = safeResolve(root, path.join(rel || '', name));
  fs.mkdirSync(abs, { recursive: false });
  return { path: path.relative(root, abs).replace(/\\/g, '/') };
}

function rename(root, rel, newName) {
  const abs = safeResolve(root, rel);
  if (path.resolve(abs) === path.resolve(root)) throw new Error('不能重命名服务器根目录');
  if (!newName || /[\\/:*?"<>|]/.test(newName)) throw new Error('名称包含非法字符');
  const target = path.join(path.dirname(abs), newName);
  if (fs.existsSync(target)) throw new Error('目标已存在: ' + newName);
  fs.renameSync(abs, target);
  return { from: rel, to: path.relative(root, target).replace(/\\/g, '/') };
}

function remove(root, rel, recursive = false) {
  const abs = safeResolve(root, rel);
  if (path.resolve(abs) === path.resolve(root)) throw new Error('不能删除服务器根目录');
  const st = fs.statSync(abs);
  if (st.isDirectory()) {
    if (!recursive) throw new Error('这是目录，需要显式确认递归删除');
    fs.rmSync(abs, { recursive: true, force: true });
  } else {
    fs.unlinkSync(abs);
  }
  return { removed: rel };
}

/** 写上传的文件 */
function upload(root, rel, name, buffer) {
  if (!name || /[\\/:*?"<>|]/.test(name)) throw new Error('文件名包含非法字符');
  const abs = safeResolve(root, path.join(rel || '', name));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, buffer);
  return { path: path.relative(root, abs).replace(/\\/g, '/'), size: buffer.length };
}

function statForDownload(root, rel) {
  const abs = safeResolve(root, rel);
  const st = fs.statSync(abs);
  if (st.isDirectory()) throw new Error('这是一个目录，暂不支持打包下载，请用「备份」功能');
  if (st.size > MAX_DOWNLOAD_BYTES) throw new Error('文件过大，无法通过面板下载');
  return { abs, size: st.size, name: path.basename(abs) };
}

module.exports = { list, read, write, mkdir, rename, remove, upload, statForDownload, IMPORTANT, MAX_EDIT_BYTES };
