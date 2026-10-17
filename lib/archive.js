'use strict';
/**
 * 服务器目录内的 zip 压缩 / 解压，走 PowerShell + .NET System.IO.Compression，支持 Zip64，进度实时回吐面板。
 * extract() 先跑 preview()，写文件前对每个条目再做两道校验；任一越界即整包拒绝。
 * 只认 .zip。
 */
const fs = require('fs');
const path = require('path');
const { safeResolve, psQuote, runPsStream, uid, fmtBytes } = require('./util');

const PS_HEAD = `$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
`;

/** 面板识别的压缩包 */
function isArchive(name) {
  return /\.zip$/i.test(String(name || ''));
}

/** 解压目标目录名 = 压缩包去掉扩展名 */
function zipStem(name) {
  return String(name).replace(/\.zip$/i, '');
}

/**
 * 条目相对路径是否越界：反斜杠先统一为正斜杠再判断。
  */
const PS_BADREL = `
function Test-BadRel([string]$rel) {
  if ($rel.StartsWith('/')) { return $true }
  if ($rel -match '^[A-Za-z]:') { return $true }
  foreach ($seg in ($rel -split '/')) { if ($seg -eq '..') { return $true } }
  return $false
}
`;

/** 新文件名合法性：不得含路径分隔符或 Windows 非法字符 */
function checkName(name) {
  const n = String(name || '').trim();
  if (!n) throw new Error('名称不能为空');
  if (n === '.' || n === '..') throw new Error('名称非法');
  if (/[\\/:*?"<>|]/.test(n)) throw new Error('名称不能包含 \\ / : * ? " < > | 这些字符');
  return n;
}

/* ─────────────────────────── 预览 ─────────────────────────── */

/**
 * 解析压缩包内容，默认解压到当前目录。
 * @param {string} root 服务器目录
 * @param {string} zipRel 压缩包相对服务器目录的路径
 * @param {string|null} into 目标目录（相对服务器目录）；null 用默认值
 */
async function preview(root, zipRel, into = null) {
  const zipAbs = safeResolve(root, zipRel);
  if (!fs.existsSync(zipAbs)) throw new Error('文件不存在');
  const st = fs.statSync(zipAbs);
  if (!st.isFile()) throw new Error('不是文件');
  const name = path.basename(zipAbs);
  if (!isArchive(name)) throw new Error('只支持 .zip 压缩包');

  let count = 0;
  let bytes = 0;
  let dirs = 0;
  let nested = 0;
  let unsafeCount = 0;
  let unsafeFirst = '';
  const tops = new Set();

  const script = PS_HEAD + PS_BADREL + `
$zip = [System.IO.Compression.ZipFile]::Open(${psQuote(zipAbs)}, 'Read')
try {
  foreach ($e in $zip.Entries) {
    $rel = $e.FullName.Replace('\\','/')
    if ($rel -eq '') { continue }
    $isDir = $rel.EndsWith('/')
    $clean = $rel.TrimEnd('/')
    if ($clean -eq '') { continue }
    if (Test-BadRel $clean) {
      Write-Output 'UNSAFE 1'
      Write-Output ('UNSAFENAME ' + $clean)
      continue
    }
    if ($isDir) { Write-Output 'DIR 1' } else { Write-Output ('FILE ' + $e.Length) }
    if ($clean.Contains('/')) { Write-Output 'NESTED 1' }
    Write-Output ('TOP ' + ($clean -split '/')[0])
  }
} finally { $zip.Dispose() }
`;

  await runPsStream(script, (line) => {
    const sp = line.indexOf(' ');
    const tag = sp < 0 ? line : line.slice(0, sp);
    const val = sp < 0 ? '' : line.slice(sp + 1);
    switch (tag) {
      case 'FILE': count++; bytes += Number(val) || 0; break;
      case 'DIR': dirs++; break;
      case 'NESTED': nested++; break;
      case 'TOP': tops.add(val); break;
      case 'UNSAFE': unsafeCount++; break;
      case 'UNSAFENAME': if (!unsafeFirst) unsafeFirst = val; break;
    }
  }, 120000);

  // 顶层只有一个名字且含嵌套条目：该名字即根文件夹，不再多套一层
  const single = tops.size === 1 && nested > 0;
  const mode = single ? 'here' : 'subdir';
  let destRel;
  if (into == null) destRel = single ? '' : zipStem(name);
  else destRel = String(into).replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');

  safeResolve(root, destRel);

  return {
    name,
    zip: zipRel.replace(/\\/g, '/'),
    entries: count,
    dirs,
    bytes,
    tops: [...tops].slice(0, 12),
    unsafe: unsafeCount,
    unsafeFirst,
    mode,
    suggestDir: zipStem(name),
    dest: destRel,
  };
}

/* ─────────────────────────── 解压 ─────────────────────────── */

/**
 * 解压到 root 之内。扫描与解压在同一次 PowerShell 里完成，不再先跑整份 preview。
 * @param {object} opts { overwrite } 默认 false，同名文件跳过而非覆盖。
 * @returns {{files:number, skipped:number, bytes:number, dest:string}}
 */
async function extract(root, zipRel, into = null, opts = {}) {
  const zipAbs = safeResolve(root, zipRel);
  if (!fs.existsSync(zipAbs)) throw new Error('文件不存在');
  const st = fs.statSync(zipAbs);
  if (!st.isFile()) throw new Error('不是文件');
  const name = path.basename(zipAbs);
  if (!isArchive(name)) throw new Error('只支持 .zip 压缩包');

  const overwrite = !!opts.overwrite;
  const intoMode = into == null ? 'auto' : 'forced';
  const intoVal = into == null ? '' : String(into).replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  const stem = zipStem(name);
  const rootAbs = path.resolve(root);

  let files = 0;
  let skipped = 0;
  let bytes = 0;
  let destRel = null;
  let unsafeCount = 0;
  let unsafeFirst = '';

  // 第一遍在脚本内扫描：校验越界、统计，随即第二遍解压，省一次 PowerShell 冷启动
  const script = PS_HEAD + PS_BADREL + `
$root = ${psQuote(rootAbs)}
$rootSep = $root
if (-not $rootSep.EndsWith([System.IO.Path]::DirectorySeparatorChar)) { $rootSep += [System.IO.Path]::DirectorySeparatorChar }
$rootFull = [System.IO.Path]::GetFullPath($rootSep)
$zip = [System.IO.Compression.ZipFile]::Open(${psQuote(zipAbs)}, 'Read')
$unsafe = 0; $unsafeFirst = ''
$tops = New-Object 'System.Collections.Generic.HashSet[string]'
$nested = 0
try {
  foreach ($e in $zip.Entries) {
    $rel = $e.FullName.Replace('\\','/')
    if ($rel -eq '') { continue }
    $clean = $rel.TrimEnd('/')
    if ($clean -eq '') { continue }
    if ((Test-BadRel $clean)) { $unsafe++; if (-not $unsafeFirst) { $unsafeFirst = $clean }; continue }
    $seg = ($clean -split '/')[0]
    [void]$tops.Add($seg)
    if ($clean.Contains('/')) { $nested++ }
  }
  if ($unsafe -gt 0) { throw ('压缩包里有 ' + $unsafe + ' 个越界条目（例如 ' + $unsafeFirst + '），可能是构造过的包，已拒绝解压') }
  $single = ($tops.Count -eq 1 -and $nested -gt 0)
  if ('${intoMode}' -eq 'forced') { $destRel = '${intoVal.Replace(/'/g, "''")}' }
  elseif ($single) { $destRel = '' }
  else { $destRel = '${stem.Replace(/'/g, "''")}' }
  $destAbs = [System.IO.Path]::GetFullPath((Join-Path $rootFull $destRel))
  if (-not $destAbs.StartsWith($rootFull, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw ('解压目标越界，已拒绝: ' + $destRel)
  }
  Write-Output ('DEST ' + $destRel)
  if (-not [System.IO.Directory]::Exists($destAbs)) { New-Item -ItemType Directory -Force -Path $destAbs | Out-Null }
  $destSep = $destAbs
  if (-not $destSep.EndsWith([System.IO.Path]::DirectorySeparatorChar)) { $destSep += [System.IO.Path]::DirectorySeparatorChar }
  $destFull = [System.IO.Path]::GetFullPath($destSep)
  $n = 0; $sk = 0; $sz = 0
  foreach ($e in $zip.Entries) {
    $rel = $e.FullName.Replace('\\','/')
    if ($rel -eq '') { continue }
    $isDir = $rel.EndsWith('/')
    $clean = $rel.TrimEnd('/')
    if ($clean -eq '') { continue }
    if (Test-BadRel $clean) { throw ('压缩包内含越界路径，已拒绝: ' + $clean) }
    $target = [System.IO.Path]::GetFullPath((Join-Path $destFull $clean))
    if (-not $target.StartsWith($destFull, [System.StringComparison]::OrdinalIgnoreCase)) {
      throw ('压缩包内含越界路径，已拒绝: ' + $clean)
    }
    if ($isDir) {
      if (-not [System.IO.Directory]::Exists($target)) { New-Item -ItemType Directory -Force -Path $target | Out-Null }
      continue
    }
    $parent = [System.IO.Path]::GetDirectoryName($target)
    if (-not [System.IO.Directory]::Exists($parent)) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
    if (${overwrite ? '$true' : '$false'} -or -not [System.IO.File]::Exists($target)) {
      [System.IO.Compression.ZipFileExtensions]::ExtractToFile($e, $target, $true)
      try { [System.IO.File]::SetLastWriteTime($target, $e.LastWriteTime.LocalDateTime) } catch {}
      $n++; $sz += $e.Length
      if ($n % 20 -eq 0) { Write-Output ('PROGRESS ' + $n) }
    } else {
      $sk++
    }
  }
  Write-Output ('DONE ' + $n)
  Write-Output ('SKIPPED ' + $sk)
  Write-Output ('BYTES ' + $sz)
} finally { $zip.Dispose() }
`;

  await runPsStream(script, (line) => {
    if (line.startsWith('DEST ')) { destRel = line.slice(5); return; }
    if (line.startsWith('PROGRESS ')) { files = Number(line.slice(9)) || 0; return; }
    if (line.startsWith('DONE ')) { files = Number(line.slice(5)) || 0; return; }
    if (line.startsWith('SKIPPED ')) { skipped = Number(line.slice(8)) || 0; return; }
    if (line.startsWith('BYTES ')) { bytes = Number(line.slice(6)) || 0; return; }
    if (line.trim()) process.stderr.write('[archive] ' + line + '\n');
  }, 30 * 60 * 1000);

  return { files, skipped, dest: destRel == null ? '' : destRel, bytes };
}

/* ─────────────────────────── 压缩 ─────────────────────────── */

/**
 * 把当前目录下的某个文件/文件夹压成 zip，输出到当前目录。
 * 先写临时文件再改名。
 * @returns {{out:string, files:number, bytes:number}}
 */
async function compress(root, rel, name, outName, opts = {}) {
  const srcRel = path.posix.join(String(rel || '').replace(/\\/g, '/'), name);
  const srcAbs = safeResolve(root, srcRel);
  if (!fs.existsSync(srcAbs)) throw new Error('文件不存在');
  const isDir = fs.statSync(srcAbs).isDirectory();

  const relAbs = safeResolve(root, rel || '');
  const raw = String(outName || '').trim() || (name + '.zip');
  // 先拦截 "." / ".."
  if (raw === '.' || raw === '..') throw new Error('名称非法');
  const out = checkName(isArchive(raw) ? raw : raw + '.zip');
  const destAbs = path.join(relAbs, out);
  const destRel = path.posix.join(String(rel || '').replace(/\\/g, '/'), out).replace(/^\/+/, '');

  if (fs.existsSync(destAbs) && !opts.overwrite) {
    const e = new Error(`已存在同名文件 ${out}`);
    e.conflict = true;
    throw e;
  }
  if (!isDir && srcAbs === destAbs) throw new Error('不能把文件压缩到它自己里面');

  // 临时文件放在输出目录，不在被压缩的内容里面；先清掉上次中断的残留
  cleanupStale(relAbs);
  const tmpAbs = path.join(relAbs, '.mcpanel-' + uid() + '.tmp');
  let files = 0;

  const script = PS_HEAD + `
$src = ${psQuote(srcAbs)}
$tmp = ${psQuote(tmpAbs)}
$prefix = ${psQuote(name)}
$n = 0
$zip = [System.IO.Compression.ZipFile]::Open($tmp, 'Create')
try {
  if ([System.IO.Directory]::Exists($src)) {
    $srcSep = $src
    if (-not $srcSep.EndsWith([System.IO.Path]::DirectorySeparatorChar)) { $srcSep += [System.IO.Path]::DirectorySeparatorChar }
    $srcFull = [System.IO.Path]::GetFullPath($srcSep)
    # 条目名得自己记。
    # 空目录也要留条目。
    # 先建目录条目、再建文件条目，且目录按路径长度从短到长。
    $seen = @{}
    $root = $prefix + '/'
    $zip.CreateEntry($root) | Out-Null
    $seen[$root] = $true
    foreach ($d in (Get-ChildItem -LiteralPath $src -Recurse -Force -Directory | Sort-Object { $_.FullName.Length })) {
      $sub = $d.FullName.Substring($srcFull.Length).Replace('\\','/')
      $entryName = $prefix + '/' + $sub + '/'
      if (-not $seen.ContainsKey($entryName)) {
        $zip.CreateEntry($entryName) | Out-Null
        $seen[$entryName] = $true
      }
    }
    foreach ($f in (Get-ChildItem -LiteralPath $src -Recurse -Force -File)) {
      $sub = $f.FullName.Substring($srcFull.Length).Replace('\\','/')
      $entryName = $prefix + '/' + $sub
      if ($seen.ContainsKey($entryName)) { continue }
      $entry = $zip.CreateEntry($entryName, [System.IO.Compression.CompressionLevel]::Optimal)
      $es = $entry.Open()
      $fs = [System.IO.File]::OpenRead($f.FullName)
      try { $fs.CopyTo($es) } finally { $fs.Dispose(); $es.Dispose() }
      $n++
      if ($n % 20 -eq 0) { Write-Output ('PROGRESS ' + $n) }
    }
  } else {
    $entry = $zip.CreateEntry($prefix, [System.IO.Compression.CompressionLevel]::Optimal)
    $es = $entry.Open()
    $fs = [System.IO.File]::OpenRead($src)
    try { $fs.CopyTo($es) } finally { $fs.Dispose(); $es.Dispose() }
    $n++
  }
} finally { $zip.Dispose() }
Write-Output ('DONE ' + $n)
`;

  try {
    await runPsStream(script, (line) => {
      if (line.startsWith('PROGRESS ')) { files = Number(line.slice(9)) || 0; return; }
      if (line.startsWith('DONE ')) { files = Number(line.slice(5)) || 0; return; }
      if (line.trim()) process.stderr.write('[archive] ' + line + '\n');
    });
    if (opts.overwrite) { try { fs.unlinkSync(destAbs); } catch { /* 失败可忽略 */ } }
    fs.renameSync(tmpAbs, destAbs);
  } catch (e) {
    try { fs.unlinkSync(tmpAbs); } catch { /* 失败可忽略 */ }
    throw e;
  }

  const size = fs.statSync(destAbs).size;
  return { out, outPath: destRel, files, bytes: size, label: fmtBytes(size) };
}

/** 清理中断压缩留下的 .mcpanel-*.tmp */
function cleanupStale(root) {
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (!e.isFile() || !/^\.mcpanel-.*\.tmp$/i.test(e.name)) continue;
    try {
      fs.rmSync(path.join(root, e.name), { force: true });
    } catch { /* 失败可忽略 */ }
  }
}

module.exports = { isArchive, preview, extract, compress, cleanupStale };
