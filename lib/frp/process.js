'use strict';
/** frpc / frpc-tray 进程托管。 */
const fs = require('fs');
const path = require('path');
const frptoml = require('../frptoml');
const frpproc = require('../frpproc');
const frptray = require('../frptray');
const frpinstall = require('../frpinstall');
const { sleep } = require('../util');
const { PROJECT_ROOT } = require('./common');

module.exports = {
  async processState(fresh = false) {
    // frpc-tray 模式下「在不在跑」看它自己的实例，frpc 是它拉起来的子进程
    const t = this.trayInfo();
    if (t) {
      const st = await frptray.state(t.exe, fresh);
      return {
        running: st.running, pid: st.pid, startedAt: st.startedAt,
        how: st.running ? 'tray' : null, exePath: t.exe, tray: true,
      };
    }

    const rec = this.store.getSetting('frpLaunched', null);
    const { proc, how, error } = await frpproc.resolve(rec, fresh)
      .catch((e) => ({ proc: null, how: null, error: e.message }));
    if (!proc) {
      // 枚举失败与「确实没有」分开：失败时保持上一状态、不清认领
      if (error) {
        return {
          running: !!(rec && this.cache.process && this.cache.process.running),
          pid: rec ? rec.pid : null,
          startedAt: rec ? rec.at : null,
          how: rec ? 'claimed' : null,
          exePath: rec ? rec.exe : null,
          error,
        };
      }
      if (rec) this.store.setSetting('frpLaunched', null);
      return { running: false, pid: null, startedAt: null, how: null, exePath: null };
    }
    // 不是面板认领的那份：清掉过时的认领记录。只在确实有记录时才写盘，避免每次采样都落盘。
    if (rec && how !== 'claimed') this.store.setSetting('frpLaunched', null);
    return { running: true, pid: proc.pid, startedAt: proc.start || null, how, exePath: proc.exe || null };
  }

  /**
   * 某条隧道的状态。
   * 来源按可靠度排：frpc 管理接口（逐条、最准）> frps dashboard（逐条）> 无。
   * @returns {{online:boolean, status:string, err:string|null, source:string, conns:number|null}|null}
   */,
  async start() {
    const dir = this.resolveDir();
    const info = frpinstall.detect(dir);
    if (!info.installed) throw new Error('这个目录里没有 frpc，请先选择 frp 目录或一键下载');
    if (!info.exePath) throw new Error('找不到 frpc.exe');

    const tray = this.trayInfo();
    if (tray) {
      const cur = await this.processState(true);
      if (cur.running) throw new Error(`frpc-tray 已经在运行（PID ${cur.pid}），不用重复启动`);
      // 别的 frpc 也在跑的话不能起，同配置会在服务端撞同名隧道
      const other = await frpproc.resolve(null, true).catch(() => ({ proc: null }));
      if (other.proc) {
        throw new Error(`检测到另一个 frpc 在运行（PID ${other.proc.pid}）。请先停止它，再交由面板启动`);
      }
      // 管理接口写进它内嵌配置，随这次启动一起生效
      await this.ensureAdmin();
      frptray.start(tray.exe, tray.dir);
      for (let i = 0; i < 40; i++) {
        await sleep(300);
        // 每 5 次实查一次枚举，其余轮次走轻量状态
        const now = await frptray.state(tray.exe, i % 5 === 4);
        if (now.running) { this.invalidate(); return { via: 'tray', pid: now.pid }; }
      }
      throw new Error('frpc-tray 启动后没有常驻，请手动双击它看提示');
    }

    const cur = await this.processState(true);
    if (cur.running) {
      throw new Error(`检测到已在运行的 frpc（PID ${cur.pid}）。请先停止它，再交由面板启动`);
    }

    await this.ensureAdmin();
    const file = this.configPath();
    if (!fs.existsSync(file)) throw new Error('这个目录里没有 frpc.toml');

    const lines = [];
    const child = frpproc.spawnFrpc(info.exePath, file, {
      onLine: (tag, line) => {
        lines.push(line);
        if (lines.length > 40) lines.shift();
        process.stdout.write(`[frpc] ${line}\n`);
      },
    });

    const admin = this.adminClient();
    let ready = false;
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 300));
      if (!frpproc.alive(child.pid)) break;
      if (admin && admin.enabled && (await admin.probe())) { ready = true; break; }
      if (!admin) { ready = true; break; }
    }

    if (!frpproc.alive(child.pid)) {
      const tail = lines.slice(-6).join('\n');
      throw new Error('frpc 启动后立刻退出了。输出末尾：\n' + (tail || '（没有输出）'));
    }

    this.store.setSetting('frpLaunched', {
      pid: child.pid,
      at: new Date().toISOString(),
      exe: info.exePath,
    });
    this.invalidate();
    return { pid: child.pid, adminReady: ready };
  }
,
  async stop() {
    const tray = this.trayInfo();
    if (tray) {
      const st = await this.processState(true);
      if (!st.running) throw new Error('frpc-tray 未在运行');
      const r = await frptray.stop(tray.exe);   // 用它自己的 -stop，不按映像名杀
      this.invalidate();
      return r;
    }

    const st = await this.processState(true);
    if (!st.running) throw new Error('frpc 未在运行');
    const r = await frpproc.stopFrpc(st.pid, this.adminClient());
    this.store.setSetting('frpLaunched', null);
    this.invalidate();
    return r;
  }
,
  async reload() {
    const admin = this.adminClient();
    if (!admin || !admin.enabled) return { via: 'none' };
    try {
      await admin.reload();
      return { via: 'admin' };
    } catch {
      return { via: 'none' };
    }
  }

  /* ─────────────────────────── 隧件事务 ─────────────────────────── */

  /** 配置或关联变了，缓存作废 */,
  async restartFrpc() {
    const st = await this.processState(true);
    if (!st.running) return { via: 'not-running' };
    const dir = path.resolve(this.resolveDir()).toLowerCase() + path.sep;
    const exe = st.exePath ? path.resolve(st.exePath).toLowerCase() : '';
    if (!exe.startsWith(dir)) {
      throw new Error(`正在跑的 frpc 不在当前 frp 目录里（${st.exePath || '路径未知'}），面板不去动它，请自己重启`);
    }
    await this.stop();
    // 查活用 alive(pid)，最后再枚举一次确认
    for (let i = 0; i < 30; i++) {
      await sleep(400);
      if (!frpproc.alive(st.pid)) break;
    }
    await this.start();
    return { via: 'restart' };
  }

  /**
   * 开启本地转发计数：起监听口 → 把隧道 localPort 指过来 → 重启 frpc。
   * 用户按下按钮后就该全部做完，不再让人手改配置。
   */,
  async ensureStarted() {
    const cur = await this.processState(true);
    if (cur.running) {
      console.log(`[面板] 连携启动：frpc 已经在跑（PID ${cur.pid}），无需动作`);
      return { via: 'already', pid: cur.pid };
    }
    return this.start();
  }
,
  async detectDirOnFirstRun() {
    if (this.getSettings().dir) return null;
    const found = await frpinstall.scanForFrp();
    if (!found) {
      console.log('[面板] 本机没扫到 frp，可在「高级设置」里选目录或一键下载');
      return null;
    }
    this.patchSettings({ dir: found.dir });
    console.log(`[面板] 已自动识别本机 frp：${found.dir}（${found.kind === 'tray' ? 'frpc-tray' : 'frpc'}）`);
    return found;
  }
};
