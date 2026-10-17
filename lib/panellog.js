'use strict';
/**
 * 面板日志：将 stdout / stderr 追加写入 data/panel.log。
 * 日志文件是唯一排查途径。
 * 日志超过 1MB 时旧文件改名为 panel.log.1。
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
  let written = 0;
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    rotate();
    stream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
    try { written = fs.statSync(LOG_FILE).size; } catch { /* 失败可忽略 */ }
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
          const s = typeof chunk === 'string' ? chunk : String(chunk);
          stream.write(s);
          written += Buffer.byteLength(s);
          // 运行期轮转：超限关流、改名、重开，不再只在 init 轮转
          if (written > MAX_BYTES) {
            stream.end();
            stream = null;
            try {
              fs.renameSync(LOG_FILE, `${LOG_FILE}.1`);
            } catch { /* 失败可忽略 */ }
            try {
              stream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
              stream.on('error', () => { stream = null; });
              written = 0;
            } catch { /* 失败可忽略 */ }
          }
        } catch { /* 记录失败不影响正常输出 */ }
      }
      return orig(chunk, enc, cb);
    };
  }
}

module.exports = { init, LOG_FILE };
