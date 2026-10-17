'use strict';
/**
 * Frp 子模块共用的常量与小工具。
 */
const path = require('path');
const net = require('net');

// 采样周期
const SAMPLE_MS = 2000;
// 启动后补接转发口前先等一轮（配置与端口就绪）
const AUTO_TAP_STEP_MS = 2000;
// 转发口自愈：接管不住隧道时按 TAP_RETRY_MS 的倍数退避重试，每个启动周期每台最多 TAP_RETRY_MAX 次
const TAP_HEAL_MS = 10000;
const TAP_RETRY_MS = 30000;
const TAP_RETRY_MAX = 5;
// 采样卡住的判定上限
const SAMPLE_STUCK_MS = 30000;
// lib/frp/ 下的模块比原 lib/frp.js 多一层
const PROJECT_ROOT = path.join(__dirname, '..', '..');

/** 由服务器名推隧道名：只留传上去不会出问题的字符，压掉重复横杠 */
function tunnelSlug(raw) {
  return String(raw == null ? '' : raw)
    .replace(/[^A-Za-z0-9_.-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 40);
}

/** 取一个本机空闲端口 */
function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}


module.exports = {
  SAMPLE_MS, AUTO_TAP_STEP_MS, TAP_HEAL_MS, TAP_RETRY_MS, TAP_RETRY_MAX, SAMPLE_STUCK_MS,
  PROJECT_ROOT, tunnelSlug, freePort,
};
