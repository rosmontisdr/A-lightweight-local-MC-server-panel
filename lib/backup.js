'use strict';
/**
 * 世界存档备份 / 还原，打包走 .NET System.IO.Compression（支持 Zip64，进度实时回吐面板）。
 * 还原流程保守：先解压到临时目录校验 level.dat，再替换现有存档并保留旧档，任一步失败即回滚。
 */
const fs = require('fs');
const path = require('path');
const { uid, psQuote, runPsStream, safeResolve } = require('./util');

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

/** 有没有正在跑的备份/还原任务 */
function hasRunningJob() {
  gcJobs();
  for (const j of jobs.values()) {
    if (j.status === 'running') return true;
  }
  return false;
}

// ───────────────────────── 收集要打包的内容 ─────────────────────────

/** level-name 取值，限制在服务器目录内 */
function levelName(server) {
  const level = server.prop('level-name', 'world');
  if (!level || /[:\\/]/.test(level) || level.includes('..')) {
    throw new Error(`server.properties 的 level-name 不合法（${level}），已拒绝`);
  }
  return level;
}

/** @returns {{root:string, prefix:string}[]} */
function collectSources(server, opts = {}) {
  const dir = server.dir;
  const level = levelName(server);
  const sources = [];
  for (const suffix of ['', '_nether', '_the_end']) {
    const name = level + suffix;
    const p = safeResolve(dir, name);
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
        try { job.bytes = fs.statSync(dest).size; } catch { /* 失败可忽略 */ }
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
    try { if (fs.existsSync(dest)) fs.unlinkSync(dest); } catch { /* 失败可忽略 */ }
    return job;
  }
}

async function countFiles(sources) {
  // 全部源合并进一条 PowerShell，每个源不再单独起进程
  const dirs = sources.filter((s) => !s.isFile).map((s) => psQuote(s.root));
  const files = sources.filter((s) => s.isFile).length;
  if (!dirs.length) return files;
  const script = `$n = 0; foreach ($d in @(${dirs.join(',')})) { $n += [int](Get-ChildItem -LiteralPath $d -Recurse -File -Force -ErrorAction SilentlyContinue | Measure-Object).Count }; [string]$n`;
  const n = await new Promise((resolve) => {
    require('child_process').execFile(
      'powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true, timeout: 120000 }, (err, out) => resolve(err ? 0 : Number(String(out).trim()) || 0)
    );
  });
  return n + files;
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

// 还原时允许写回的顶层文件（与 collectSources 收集的配置文件同口径）
const RESTORE_TOP_FILES = new Set([
  'server.properties', 'ops.json', 'whitelist.json',
  'banned-players.json', 'banned-ips.json', 'user_jvm_args.txt', 'eula.txt',
]);

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
    // 逐条目校验越界路径，任何一条越界即整包拒绝（与 archive.extract 同口径）
    const script = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
function Test-BadRel([string]$rel) {
  if ($rel.StartsWith('/')) { return $true }
  if ($rel -match '^[A-Za-z]:') { return $true }
  foreach ($seg in ($rel -split '/')) { if ($seg -eq '..') { return $true } }
  return $false
}
$dest = ${psQuote(tmp)}
$destSep = $dest
if (-not $destSep.EndsWith([System.IO.Path]::DirectorySeparatorChar)) { $destSep += [System.IO.Path]::DirectorySeparatorChar }
$destFull = [System.IO.Path]::GetFullPath($destSep)
$zip = [System.IO.Compression.ZipFile]::OpenRead(${psQuote(zipPath)})
try {
  foreach ($e in $zip.Entries) {
    $rel = $e.FullName.Replace('\\','/')
    if ($rel -eq '') { continue }
    $clean = $rel.TrimEnd('/')
    if ($clean -eq '') { continue }
    if (Test-BadRel $clean) { throw ('压缩包内含越界路径，已拒绝: ' + $clean) }
    $target = [System.IO.Path]::GetFullPath((Join-Path $destFull $clean))
    if (-not $target.StartsWith($destFull, [System.StringComparison]::OrdinalIgnoreCase)) {
      throw ('压缩包内含越界路径，已拒绝: ' + $clean)
    }
    if ($rel.EndsWith('/')) {
      if (-not [System.IO.Directory]::Exists($target)) { New-Item -ItemType Directory -Force -Path $target | Out-Null }
      continue
    }
    $parent = [System.IO.Path]::GetDirectoryName($target)
    if (-not [System.IO.Directory]::Exists($parent)) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
    [System.IO.Compression.ZipFileExtensions]::ExtractToFile($e, $target, $true)
  }
} finally { $zip.Dispose() }
Write-Output "EXTRACTED"
`;
    await runPsStream(script, (l) => {
      if (l !== 'EXTRACTED') jobLog(job, l);
      else jobLog(job, '解压完成，开始校验…');
    });

    // 找出压缩包里顶层含 level.dat 的目录
    const candidates = fs.readdirSync(tmp, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
    const worldDirName = candidates.find((c) => fs.existsSync(path.join(tmp, c, 'level.dat')));

    if (!worldDirName) {
      // 兜底
      throw new Error('压缩包内未找到有效的 world 目录（缺少 level.dat），已中止还原');
    }

    // 变更记账：失败时逐项回滚，不留半新半旧
    const moved = [];   // { dest, safety }
    const written = []; // 新写入的路径（原本不存在的）
    const safetyOf = (p) => p + '.before-restore-' + stamp();
    const swapIn = (src, dest) => {
      if (fs.existsSync(dest)) {
        const safety = safetyOf(dest);
        fs.renameSync(dest, safety);
        moved.push({ dest, safety });
      } else {
        written.push(dest);
      }
      fs.renameSync(src, dest);
    };

    try {
      const targetWorld = path.join(server.dir, worldDirName);
      swapIn(path.join(tmp, worldDirName), targetWorld);
      if (!fs.existsSync(path.join(targetWorld, 'level.dat'))) {
        throw new Error('还原后 level.dat 缺失');
      }
      jobLog(job, `写入存档 -> ${worldDirName}`);
      // 还原子目录（nether / the_end）
      for (const c of candidates) {
        if (c === worldDirName) continue;
        swapIn(path.join(tmp, c), path.join(server.dir, c));
        jobLog(job, `还原 ${c}`);
      }
      // 还原顶层配置文件，只认白名单
      for (const f of fs.readdirSync(tmp, { withFileTypes: true })) {
        if (f.isDirectory()) continue;
        if (!RESTORE_TOP_FILES.has(f.name)) {
          jobLog(job, `跳过 ${f.name}（不在可还原清单里）`);
          continue;
        }
        const dest = path.join(server.dir, f.name);
        if (fs.existsSync(dest)) {
          const safety = safetyOf(dest);
          fs.copyFileSync(dest, safety);
          moved.push({ dest, safety, copy: true });
        } else {
          written.push(dest);
        }
        fs.copyFileSync(path.join(tmp, f.name), dest);
      }

      job.status = 'done';
      job.finishedAt = Date.now();
      jobLog(job, '完成。原存档保留为 .before-restore-*，确认无误后可手动删除。');
      return job;
    } catch (e) {
      // 回滚全部改动项
      try {
        for (const p of written) {
          try { if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true }); } catch { /* 失败可忽略 */ }
        }
        for (const { dest, safety, copy } of moved) {
          try {
            if (copy) fs.copyFileSync(safety, dest);
            else if (fs.existsSync(dest)) { fs.rmSync(dest, { recursive: true, force: true }); fs.renameSync(safety, dest); }
          } catch { /* 失败可忽略 */ }
        }
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
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 失败可忽略 */ }
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
  restoreBackup, getJob, hasRunningJob,
  listRestoreLeftovers, deleteLeftover,
  BACKUP_ROOT,
};
