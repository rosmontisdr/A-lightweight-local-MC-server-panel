'use strict';
const path = require('path');
const fs = require('fs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function uid() {
  return Math.random().toString(36).slice(2, 8) + Date.now().toString(36);
}

function fmtBytes(n) {
  if (!n && n !== 0) return '-';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return n.toFixed(i === 0 ? 0 : 1) + ' ' + u[i];
}

/**
 * 读 JSON。文件不存在返回 def；存在但解析失败抛错（调用方决定告警与兜底）。
 */
function readJsonSafe(file, def) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return def;
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    e.message = `解析失败 ${file}: ${e.message}`;
    throw e;
  }
}

/** 写 JSON。落盘前把现有文件备份为 <file>.bak。 */
function writeJsonAtomic(file, obj) {
  const tmp = file + '.tmp';
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) {
    try { fs.copyFileSync(file, file + '.bak'); } catch { /* 失败可忽略 */ }
  }
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

/**
 * 把 relative 解析到 root 之内，并阻止 ../ 越界。
 * root 本身返回 root。已存在的路径再经 realpath 复核，junction/symlink 不得指向目录外。
 */
function safeResolve(root, relative) {
  const rootAbs = path.resolve(root);
  const abs = path.resolve(rootAbs, relative == null || relative === '' ? '.' : String(relative));
  const rel = path.relative(rootAbs, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error('路径越界，已拒绝: ' + relative);
  }
  // 已存在时解析真实路径：junction/symlink 的目标也必须在 root 内
  try {
    const real = fs.realpathSync(abs);
    const realRoot = fs.realpathSync(rootAbs);
    const rel2 = path.relative(realRoot, real);
    if (rel2.startsWith('..') || path.isAbsolute(rel2)) {
      throw new Error('路径越界，已拒绝: ' + relative);
    }
  } catch (e) {
    if (e && e.message && e.message.startsWith('路径越界')) throw e;
    // 不存在的路径不做 realpath，交由创建方处理
  }
  return abs;
}

/** 运行 PowerShell 脚本，返回 stdout 文本 */
const { execFile, spawn } = require('child_process');
function ps(script, timeout = 15000) {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { timeout, maxBuffer: 32 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) return reject(new Error((stderr || err.message || '').toString().trim()));
        resolve(stdout == null ? '' : stdout.toString());
      }
    );
  });
}

/** PowerShell 单引号字符串拼接用的转义 */
function psQuote(s) {
  return "'" + String(s).replace(/'/g, "''") + "'";
}

/** 执行 PowerShell 并按行实时回调 stdout（脚本以 Write-Output "PROGRESS n" 汇报进度）。用 spawn，不用 execFile。 */
function runPsStream(script, onLine, timeoutMs = 60 * 60 * 1000) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true }
    );
    let errBuf = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill(); } catch { /* 失败可忽略 */ }
      reject(new Error('操作超时'));
    }, timeoutMs);

    let buf = '';
    child.stdout.on('data', (d) => {
      buf += d.toString('utf8');
      const lines = buf.split(/\r?\n/);
      buf = lines.pop();
      for (const l of lines) if (l.trim()) onLine(l.trim());
    });
    child.stderr.on('data', (d) => { errBuf += d.toString('utf8'); });
    child.on('error', (e) => {
      if (settled) return;
      settled = true; clearTimeout(timer); reject(e);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (buf.trim()) onLine(buf.trim());
      if (code === 0) resolve();
      else reject(new Error(errBuf.trim() || `PowerShell 退出码 ${code}`));
    });
  });
}

/** 类 shell 参数切分，支持单/双引号，如把「-Xmx16G -Xms16G」拆成两个参数。 */
function tokenize(str) {
  const out = [];
  let cur = '';
  let quote = null;
  let has = false;
  for (const ch of String(str)) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
    } else if (/\s/.test(ch)) {
      if (cur || has) { out.push(cur); cur = ''; has = false; }
    } else {
      cur += ch;
    }
  }
  if (cur || has) out.push(cur);
  return out;
}

module.exports = { sleep, uid, fmtBytes, readJsonSafe, writeJsonAtomic, safeResolve, ps, psQuote, runPsStream, tokenize };
