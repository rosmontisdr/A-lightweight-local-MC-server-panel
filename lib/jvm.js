'use strict';
/** 读取 JVM 真实堆占用（jcmd GC.heap_info）。工作集受 -Xms 影响恒贴近 -Xmx，不可用于算占用率。JRE 无 jcmd，返回 null，前端回退工作集。 */
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const TTL = 8000;      // jcmd 需起一个子进程，不应每 tick 执行
const TIMEOUT = 5000;

const cache = new Map();    // pid -> { at, data }
const pending = new Map();  // pid -> Promise，同一 pid 只起一个 jcmd

/** 查找与 java.exe 同目录的 jcmd，找不到交由 PATH。 */
function jcmdFor(javaPath) {
  const exe = process.platform === 'win32' ? 'jcmd.exe' : 'jcmd';
  const p = String(javaPath || '');
  const dir = p ? path.dirname(p) : '';
  if (dir && dir !== '.') {
    const full = path.join(dir, exe);
    try { if (fs.statSync(full).isFile()) return full; } catch { /* 非本地 JDK，回退 PATH */ }
  }
  return 'jcmd';
}

/**
 * 解析 GC.heap_info，兼容两类输出：
 *   G1 / ZGC / Shenandoah：一行含 total reserved / committed / used，即整堆。
 *   Parallel / CMS：按分代分行，需自行累加。
 * 返回字节数；无法解析时返回 null。
 */
function parseHeapInfo(text) {
  let genUsed = 0;
  let genCommitted = 0;
  let sawGen = false;

  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (/^\d+:$/.test(line)) continue;                     // "35548:" 为标题行
    if (/^(Metaspace|class space|Compressed)/i.test(line)) continue;

    // 汇总行，带 reserved 即为整堆
    const summary = line.match(/total reserved (\d+)K,\s*committed (\d+)K,\s*used (\d+)K/);
    if (summary) {
      return {
        reserved: Number(summary[1]) * 1024,
        committed: Number(summary[2]) * 1024,
        used: Number(summary[3]) * 1024,
      };
    }

    // 分代行，含 total 和 used；缩进的 "eden space ... 46% used" 不匹配
    const gen = line.match(/total (\d+)K,\s*used (\d+)K/);
    if (gen) {
      sawGen = true;
      genCommitted += Number(gen[1]) * 1024;
      genUsed += Number(gen[2]) * 1024;
    }
  }

  return sawGen ? { used: genUsed, committed: genCommitted, reserved: null } : null;
}

function runJcmd(pid, javaPath) {
  return new Promise((resolve) => {
    execFile(
      jcmdFor(javaPath), [String(pid), 'GC.heap_info'],
      { timeout: TIMEOUT, windowsHide: true, maxBuffer: 1024 * 1024 },
      (err, stdout) => {
        // jcmd 对不支持的 JVM 以非 0 退出并向 stderr 写原因，一律按读不到处理
        if (err && !stdout) return resolve(null);
        resolve(parseHeapInfo(stdout));
      }
    );
  });
}

/** 取 pid 的堆信息，不阻塞：命中缓存直接返回，否则后台刷新并返回上次值（首次 null）。 */
function heapInfo(pid, javaPath) {
  if (pid == null) return null;
  const hit = cache.get(pid);

  if (!hit || Date.now() - hit.at >= TTL) {
    if (!pending.has(pid)) {
      const job = runJcmd(pid, javaPath)
        .then((data) => { if (data) cache.set(pid, { at: Date.now(), data }); return data; })
        .catch(() => null)
        .then((data) => { pending.delete(pid); return data; });
      pending.set(pid, job);
    }
  }

  return hit ? hit.data : null;
}

/** 进程退出后清缓存。 */
function forget(pid) {
  cache.delete(pid);
  pending.delete(pid);
}

module.exports = { heapInfo, forget, parseHeapInfo, jcmdFor };
