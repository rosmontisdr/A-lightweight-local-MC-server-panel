'use strict';
/**
 * server.properties 解析与回写。
 * 保留原有注释、空行与键顺序；已存在的键就地替换，新键追加到末尾。
 */

function parse(text) {
  const map = {};
  const lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    const t = line.trim();
    if (!t || t.startsWith('#') || t.startsWith('!')) return;
    const eq = line.indexOf('=');
    if (eq < 0) return;
    const key = line.slice(0, eq).trim();
    map[key] = { value: line.slice(eq + 1), line: i };
  });
  return { lines, map };
}

function set(text, key, value) {
  const { lines, map } = parse(text);
  const v = value == null ? '' : String(value);
  if (map[key]) {
    lines[map[key].line] = key + '=' + v;
  } else {
    while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
    lines.push(key + '=' + v);
  }
  return lines.join('\n');
}

function setMany(text, obj) {
  let out = text;
  for (const [k, v] of Object.entries(obj)) out = set(out, k, v);
  return out;
}

/** 值类型推断，前端据此渲染对应控件 */
function inferType(key, value) {
  if (value === 'true' || value === 'false') return 'boolean';
  if (value !== '' && !isNaN(Number(value)) && !/^0\d/.test(value)) return 'number';
  if (/password|token|secret|key/i.test(key)) return 'password';
  return 'string';
}

/** 常见键的中文说明，仅供展示 */
const DESCRIPTIONS = {
  'server-port': '服务器监听端口',
  'server-ip': '绑定的 IP，0.0.0.0 表示所有网卡',
  'motd': '服务器列表中显示的标语',
  'max-players': '最大玩家数',
  'gamemode': '默认游戏模式 (survival/creative/adventure/spectator)',
  'difficulty': '难度 (peaceful/easy/normal/hard)',
  'level-name': '世界存档目录名',
  'level-seed': '世界种子，留空为随机',
  'level-type': '世界类型',
  'online-mode': '正版验证。false 允许离线玩家进入',
  'white-list': '是否启用白名单',
  'enforce-whitelist': '白名单外的玩家是否被踢出',
  'pvp': '是否允许玩家互相伤害',
  'allow-flight': '是否允许飞行（装 mod 通常需要 true）',
  'allow-nether': '是否允许进入下界',
  'spawn-monsters': '是否生成怪物',
  'spawn-animals': '是否生成动物',
  'spawn-npcs': '是否生成村民',
  'spawn-protection': '出生点保护半径，0 为关闭',
  'view-distance': '视距（区块）',
  'simulation-distance': '模拟距离（区块）',
  'enable-rcon': '启用 RCON 远程控制台',
  'rcon.port': 'RCON 端口',
  'rcon.password': 'RCON 密码',
  'enable-query': '启用 Query 协议',
  'query.port': 'Query 端口',
  'enable-status': '是否在服务器列表中显示状态',
  'hide-online-players': '是否隐藏在线玩家名单',
  'max-tick-time': '单 tick 超时（毫秒），-1 为禁用看门狗',
  'player-idle-timeout': '挂机踢出时间（分钟），0 为不踢',
  'op-permission-level': 'OP 权限等级 1-4',
  'function-permission-level': '函数命令权限等级',
  'enforce-secure-profile': '是否强制安全聊天签名',
  'network-compression-threshold': '网络压缩阈值，-1 为禁用',
  'prevent-proxy-connections': '是否阻止代理连接',
  'require-resource-pack': '是否强制使用资源包',
  'resource-pack': '资源包下载地址',
  'server-resource-pack': '资源包下载地址',
  'max-world-size': '世界边界最大半径',
  'sync-chunk-writes': '同步写入区块（SSD 可关，机械盘建议开）',
  'use-native-transport': '使用 Linux 原生传输优化',
  'broadcast-console-to-ops': '控制台指令是否广播给 OP',
  'broadcast-rcon-to-ops': 'RCON 指令是否广播给 OP',
};

function describe(key) {
  return DESCRIPTIONS[key] || '';
}

// 界面与接口上一律以此代替敏感项的真实值。定长，不泄露密码长度。
const SECRET_MASK = '********';

/** 是否为需要掩码的敏感项。只认 password / secret / token 结尾的键。 */
function isSecretKey(key) {
  return /(^|\.)(password|secret|token)$/i.test(String(key));
}

module.exports = { parse, set, setMany, inferType, describe, DESCRIPTIONS, SECRET_MASK, isSecretKey };
