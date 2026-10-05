'use strict';
/**
 * 面板日志：将 stdout / stderr 追加写入 data/panel.log。
 * 面板脱离控制台运行，日志文件是唯一排查途径。
 * 日志超过 1MB 时旧文件改名为 panel.log.1，防止长期运行无限增长。
 */
const fs = require('fs');
const path = require('path');

const LOG_FILE = path.join(__dirname, '..', 'data', 'panel.log');
const MAX_BYTES = 1024 * 1024;

function rotate() {
  try {
    if (fs.statSync(LOG_FILE).size > MAX_BYTES) {
      fs.renameSync(LOG_FILE, `${LOG_FILE}.1`);
    }
  } catch { /* 文件不存在，正常情况 */ }
}

function init() {
  let stream;
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    rotate();
    stream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
  } catch {
    return; // 日志写入失败不影响面板运行
  }
  // 文件流出错（磁盘满、被删）时停止记录，面板继续运行
  stream.on('error', () => { stream = null; });

  stream.write(`\n===== ${new Date().toISOString()} 面板启动 =====\n`);

  for (const name of ['stdout', 'stderr']) {
    const orig = process[name].write.bind(process[name]);
    process[name].write = (chunk, enc, cb) => {
      if (stream) {
        try {
          stream.write(typeof chunk === 'string' ? chunk : String(chunk));
        } catch { /* 记录失败不影响正常输出 */ }
      }
      return orig(chunk, enc, cb);
    };
  }
}

module.exports = { init, LOG_FILE };
