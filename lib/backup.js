'use strict';
/**
 * 世界存档备份 / 还原，打包走 .NET System.IO.Compression（支持 Zip64，进度实时回吐面板）。
 * 还原流程保守：先解压到临时目录校验 level.dat，再替换现有存档并保留旧档，任一步失败即回滚。
 */
const fs = require('fs');
const path = require('path');
const { uid, psQuote, runPsStream } = require('./util');

const DATA_DIR = path.join(__dirname, '..', 'data');
const BACKUP_ROOT = path.join(DATA_DIR, 'backups');

const jobs = new Map();
const JOB_TTL = 30 * 60 * 1000;

function backupDir(serverId) {
  const d = path.join(BACKUP_ROOT, serverId);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function safeName(s) {
  return String(s).replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 40);
}

// ───────────────────────── 任务系统 ─────────────────────────

function gcJobs() {
  const now = Date.now();
  for (const [id, j] of jobs) {
    if (j.finishedAt && now - j.finishedAt > JOB_TTL) jobs.delete(id);
  }
}

function createJob(type, serverId, label) {
  gcJobs();
  const job = {
    id: uid(),
    type,
    serverId,
    label,
    status: 'running',
    startedAt: Date.now(),
    finishedAt: null,
    files: 0,
    bytes: 0,
    totalFiles: null,
    error: null,
    result: null,
    log: [],
  };
  jobs.set(job.id, job);
  return job;
}

function jobLog(job, line) {
  job.log.push({ t: Date.now(), line });
  if (job.log.length > 200) job.log.shift();
}

function getJob(id) {
  return jobs.get(id) || null;
}

// ───────────────────────── 收集要打包的内容 ─────────────────────────

/** @returns {{root:string, prefix:string}[]} */
function collectSources(server, opts = {}) {
  const dir = server.dir;
  const level = server.prop('level-name', 'world');
  const sources = [];
  for (const suffix of ['', '_nether', '_the_end']) {
    const name = level + suffix;
    const p = path.join(dir, name);
    if (fs.existsSync(p) && fs.statSync(p).isDirectory()) {
      sources.push({ root: p, prefix: name });
    }
  }
  for (const f of ['server.properties', 'ops.json', 'whitelist.json',
    'banned-players.json', 'banned-ips.json', 'user_jvm_args.txt', 'eula.txt']) {
    const p = path.join(dir, f);
    if (fs.existsSync(p)) sources.push({ root: p, prefix: f, isFile: true });
  }
  if (opts.includeMods) {
    for (const d of ['mods', 'plugins', 'config', 'defaultconfigs', 'kubejs', 'scripts']) {
      const p = path.join(dir, d);
      if (fs.existsSync(p) && fs.statSync(p).isDirectory()) sources.push({ root: p, prefix: d });
    }
  }
  return sources;
}

// ───────────────────────── 创建备份 ─────────────────────────

async function createBackup(server, opts = {}) {
  const sources = collectSources(server, opts);
  if (!sources.length) throw new Error('没有找到可备份的内容（world 目录不存在？）');

  const label = safeName(server.name);
  const fileName = `${label}_${stamp()}${opts.includeMods ? '_含mod' : ''}.zip`;
  const destDir = backupDir(server.id);
  const dest = path.join(destDir, fileName);

  const job = createJob('backup', server.id, `备份 ${server.name}`);
  job.result = { file: fileName };
  jobLog(job, `开始备份 ${sources.length} 项内容`);
  jobLog(job, server.running ? '注意：服务器正在运行，存档可能处于写入中，备份一致性无法保证' : '服务器已停止，存档状态一致');

  // 预估总文件数
  countFiles(sources).then((n) => { job.totalFiles = n; }).catch(() => {});

  const srcPs = sources
    .map((s) => `  @{ Root = ${psQuote(s.root)}; Prefix = ${psQuote(s.prefix)}; IsFile = $${s.isFile ? 'true' : 'false'} }`)
    .join(",\n");

  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$dst = ${psQuote(dest)}
if (Test-Path -LiteralPath $dst) { Remove-Item -LiteralPath $dst -Force }
$sources = @(
${srcPs}
)
$zip = [System.IO.Compression.ZipFile]::Open($dst, 'Create')
try {
  $i = 0
  foreach ($s in $sources) {
    if (-not (Test-Path -LiteralPath $s.Root)) { continue }
    if ($s.IsFile) {
      $entry = $zip.CreateEntry($s.Prefix, [System.IO.Compression.CompressionLevel]::Optimal)
      $es = $entry.Open()
      try { $fs = [System.IO.File]::Open($s.Root, 'Open', 'Read', 'ReadWrite'); try { $fs.CopyTo($es) } finally { $fs.Dispose() } } finally { $es.Dispose() }
      $i++
      Write-Output "PROGRESS $i"
      continue
    }
    $baseLen = $s.Root.Length
    foreach ($f in (Get-ChildItem -LiteralPath $s.Root -Recurse -File -Force -ErrorAction SilentlyContinue)) {
      if ($f.Name -eq 'session.lock') { continue }
      $rel = $f.FullName.Substring($baseLen).TrimStart('\\').Replace('\\','/')
      $entryName = $s.Prefix + '/' + $rel
      $entry = $zip.CreateEntry($entryName, [System.IO.Compression.CompressionLevel]::Optimal)
      $es = $entry.Open()
      try {
        $fs = [System.IO.File]::Open($f.FullName, 'Open', 'Read', 'ReadWrite')
        try { $fs.CopyTo($es) } finally { $fs.Dispose() }
      } finally { $es.Dispose() }
      $i++
      if ($i % 25 -eq 0) { Write-Output "PROGRESS $i" }
    }
  }
} finally {
  $zip.Dispose()
}
Write-Output "DONE $i"
`;

  try {
    await runPsStream(script, (line) => {
      const m = line.match(/^PROGRESS (\d+)$/);
      if (m) {
        job.files = Number(m[1]);
        try { job.bytes = fs.statSync(dest).size; } catch {}
        return;
      }
      const d = line.match(/^DONE (\d+)$/);
      if (d) { job.files = Number(d[1]); return; }
      jobLog(job, line);
    });
    const st = fs.statSync(dest);
    job.status = 'done';
    job.bytes = st.size;
    job.finishedAt = Date.now();
    jobLog(job, `完成：${job.files} 个文件，${(st.size / 1048576).toFixed(1)} MB`);
    return job;
  } catch (e) {
    job.status = 'error';
    job.error = e.message;
    job.finishedAt = Date.now();
    jobLog(job, '失败: ' + e.message);
    try { if (fs.existsSync(dest)) fs.unlinkSync(dest); } catch {}
    return job;
  }
}

async function countFiles(sources) {
  let n = 0;
  for (const s of sources) {
    if (s.isFile) { n++; continue; }
    n += await new Promise((resolve) => {
      const script = `[string](Get-ChildItem -LiteralPath ${psQuote(s.root)} -Recurse -File -Force -ErrorAction SilentlyContinue | Measure-Object).Count`;
      require('child_process').execFile(
        'powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
        { windowsHide: true, timeout: 120000 }, (err, out) => resolve(err ? 0 : Number(String(out).trim()) || 0)
      );
    });
  }
  return n;
}

// ───────────────────────── 列表 / 删除 / 下载 ─────────────────────────

function listBackups(serverId) {
  const dir = backupDir(serverId);
  return fs.readdirSync(dir)
    .filter((n) => n.toLowerCase().endsWith('.zip'))
    .map((n) => {
      const p = path.join(dir, n);
      const st = fs.statSync(p);
      return { name: n, size: st.size, mtime: st.mtime.toISOString() };
    })
    .sort((a, b) => b.mtime.localeCompare(a.mtime));
}

function backupPath(serverId, name) {
  if (!/^[\w\u4e00-\u9fa5.\-]+\.zip$/.test(name)) throw new Error('备份文件名非法');
  const p = path.join(backupDir(serverId), name);
  if (!fs.existsSync(p)) throw new Error('备份不存在');
  return p;
}

function deleteBackup(serverId, name) {
  const p = backupPath(serverId, name);
  fs.unlinkSync(p);
  return { deleted: name };
}

// ───────────────────────── 还原 ─────────────────────────

async function restoreBackup(server, name) {
  if (server.running) {
    throw new Error('服务器正在运行，请先停止后再还原存档。运行中还原会导致存档损坏。');
  }
  const zipPath = backupPath(server.id, name);
  // 临时目录必须与服务器目录同盘。
  const tmp = path.join(server.dir, '.mcpanel-restore-' + uid());
  // 不预先创建

  const job = createJob('restore', server.id, `还原 ${name}`);
  job.result = { file: name };
  jobLog(job, '开始解压到临时目录…');

  try {
    const script = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::ExtractToDirectory(${psQuote(zipPath)}, ${psQuote(tmp)})
Write-Output "EXTRACTED"
`;
    await runPsStream(script, (l) => {
      if (l !== 'EXTRACTED') jobLog(job, l);
      else jobLog(job, '解压完成，开始校验…');
    });

    // 找出压缩包里顶层含 level.dat 的目录
    const level = server.prop('level-name', 'world');
    const candidates = fs.readdirSync(tmp, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
    const worldDirName = candidates.find((c) => fs.existsSync(path.join(tmp, c, 'level.dat')));

    if (!worldDirName) {
      // 兜底
      throw new Error('压缩包内未找到有效的 world 目录（缺少 level.dat），已中止还原');
    }

    const targetWorld = path.join(server.dir, worldDirName);
    const safety = targetWorld + '.before-restore-' + stamp();

    if (fs.existsSync(targetWorld)) {
      jobLog(job, `备份现有存档 -> ${path.basename(safety)}`);
      fs.renameSync(targetWorld, safety);
    }

    try {
      jobLog(job, `写入存档 -> ${worldDirName}`);
      fs.renameSync(path.join(tmp, worldDirName), targetWorld);
      if (!fs.existsSync(path.join(targetWorld, 'level.dat'))) {
        throw new Error('还原后 level.dat 缺失');
      }
      // 还原子目录（nether / the_end）
      for (const c of candidates) {
        if (c === worldDirName) continue;
        const dest = path.join(server.dir, c);
        if (fs.existsSync(dest)) fs.renameSync(dest, dest + '.before-restore-' + stamp());
        fs.renameSync(path.join(tmp, c), dest);
        jobLog(job, `还原 ${c}`);
      }
      // 还原顶层配置文件
      for (const f of fs.readdirSync(tmp, { withFileTypes: true })) {
        if (f.isDirectory()) continue;
        const dest = path.join(server.dir, f.name);
        fs.copyFileSync(path.join(tmp, f.name), dest);
      }

      job.status = 'done';
      job.finishedAt = Date.now();
      jobLog(job, `完成。原存档保留在 ${path.basename(safety)}，确认无误后可手动删除。`);
      return job;
    } catch (e) {
      // 回滚
      try {
        if (fs.existsSync(targetWorld)) fs.rmSync(targetWorld, { recursive: true, force: true });
        if (fs.existsSync(safety)) fs.renameSync(safety, targetWorld);
        jobLog(job, '已回滚到还原前的存档');
      } catch (re) {
        jobLog(job, '回滚失败，请手动处理: ' + re.message);
      }
      throw e;
    }
  } catch (e) {
    job.status = 'error';
    job.error = e.message;
    job.finishedAt = Date.now();
    jobLog(job, '失败: ' + e.message);
    return job;
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

// ───────────────────────── 日志清理 ─────────────────────────

/** 清理还原后遗留的 .before-restore-* 目录 */
function listRestoreLeftovers(server) {
  try {
    return fs.readdirSync(server.dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name.includes('.before-restore-'))
      .map((e) => {
        const p = path.join(server.dir, e.name);
        return { name: e.name, mtime: fs.statSync(p).mtime.toISOString() };
      });
  } catch {
    return [];
  }
}

function deleteLeftover(server, name) {
  if (!name.includes('.before-restore-') || /[\\/]/.test(name)) throw new Error('目录名非法');
  const p = path.join(server.dir, name);
  if (!fs.existsSync(p)) throw new Error('目录不存在');
  fs.rmSync(p, { recursive: true, force: true });
  return { deleted: name };
}

module.exports = {
  createBackup, listBackups, backupPath, deleteBackup,
  restoreBackup, getJob,
  listRestoreLeftovers, deleteLeftover,
  BACKUP_ROOT,
};
