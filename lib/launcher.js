'use strict';
/** 从服务器目录推断启动方式。支持 Forge / NeoForge / Fabric / Quilt / Paper 系 / 原版及 run.bat、run.sh 兜底。 */
const fs = require('fs');
const path = require('path');
const { tokenize } = require('./util');

const IS_WIN = process.platform === 'win32';

/** 读取 user_jvm_args.txt 中未被注释的参数，一行多参数需拆开。 */
function readJvmArgs(dir) {
  const f = path.join(dir, 'user_jvm_args.txt');
  try {
    return fs.readFileSync(f, 'utf8')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#') && !l.startsWith('REM'))
      .flatMap((l) => tokenize(l));
  } catch {
    return [];
  }
}

function listDir(dir) {
  try { return fs.readdirSync(dir); } catch { return []; }
}

/** 查找形如 libraries/net/minecraftforge/forge/<ver>/win_args.txt 的启动参数文件。 */
function findArgsFile(dir, basePath) {
  const root = path.join(dir, basePath);
  if (!fs.existsSync(root)) return null;
  const wanted = IS_WIN ? 'win_args.txt' : 'unix_args.txt';
  const vers = listDir(root).filter((v) => fs.existsSync(path.join(root, v, wanted)));
  if (!vers.length) return null;
  // 取版本号最大的目录。须数字感知。
  vers.sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
  const v = vers[vers.length - 1];
  return { version: v, rel: basePath.split(path.sep).join('/') + '/' + v + '/' + wanted };
}

/**
 * 从 loader 版本目录名推断 MC 版本，推不出返回 null（不猜版本）。
 * Forge 及 1.20.1 代 NeoForge 形如 "1.20.1-47.4.12"；NeoForge 1.20.2 起形如 "21.1.72"，对应 MC 1.21.1。
 */
function mcVersionOf(version) {
  const v = String(version);
  const dashed = v.match(/^(\d+\.\d+(?:\.\d+)?)-/);
  if (dashed) return dashed[1];
  const neo = v.match(/^(\d+)\.(\d+)\./);
  if (neo) return `1.${neo[1]}.${neo[2]}`;
  return null;
}

const JAR_RULES = [
  { re: /^fabric-server-launch.*\.jar$/i, type: 'fabric' },
  { re: /^fabric-server.*\.jar$/i, type: 'fabric' },
  // 部分整合包把 fabric-<版本>.jar 直接放在根目录
  { re: /^fabric.*\.jar$/i, type: 'fabric' },
  { re: /^quilt-server.*\.jar$/i, type: 'quilt' },
  { re: /^quilt.*\.jar$/i, type: 'quilt' },
  { re: /^purpur.*\.jar$/i, type: 'purpur' },
  { re: /^paper.*\.jar$/i, type: 'paper' },
  { re: /^spigot.*\.jar$/i, type: 'spigot' },
  { re: /^mohist.*\.jar$/i, type: 'mohist' },
  { re: /^arclight.*\.jar$/i, type: 'arclight' },
  { re: /^magma.*\.jar$/i, type: 'magma' },
  { re: /^catserver.*\.jar$/i, type: 'catserver' },
  { re: /^forge-.*universal\.jar$/i, type: 'forge' },
  { re: /^neoforge-.*\.jar$/i, type: 'neoforge' },
  { re: /^server\.jar$/i, type: 'vanilla' },
  { re: /^minecraft_server.*\.jar$/i, type: 'vanilla' },
];

function pickJar(dir) {
  const jars = listDir(dir).filter(
    (n) => /\.jar$/i.test(n) && !/-(installer|sources|javadoc|slim)\.jar$/i.test(n)
  );
  for (const rule of JAR_RULES) {
    const hit = jars.find((j) => rule.re.test(j));
    if (hit) return { jar: hit, type: rule.type };
  }
  // 无法识别且只有一个 jar 时，按可执行 jar 处理
  if (jars.length === 1) return { jar: jars[0], type: 'jar' };
  return null;
}

/**
 * @returns {{mode:'java'|'script'|'unknown', type:string, jvmArgs:string[],
 *   programArgs:string[], jar:string|null, javaPath:string, mcVersion:string|null,
 *   loaderVersion:string|null, confidence:string, hint:string}}
 */
function detect(dir) {
  const result = {
    mode: 'unknown',
    type: 'unknown',
    javaPath: 'java',
    jvmArgs: readJvmArgs(dir),
    programArgs: [],
    jar: null,
    mcVersion: null,
    loaderVersion: null,
    confidence: 'low',
    hint: '',
  };

  // 1) Forge / NeoForge：用 @args 文件启动。
  //    NeoForge 有两代目录布局：1.20.2 起为 libraries/net/neoforged/neoforge/<21.1.72>/；
  //    1.20.1 为 libraries/net/neoforged/forge/<1.20.1-47.1.105>/（沿用 Forge 产物名）。
  const ARGS_LAYOUTS = [
    { type: 'forge', base: ['libraries', 'net', 'minecraftforge', 'forge'] },
    { type: 'neoforge', base: ['libraries', 'net', 'neoforged', 'neoforge'] },
    { type: 'neoforge', base: ['libraries', 'net', 'neoforged', 'forge'] },
  ];
  for (const layout of ARGS_LAYOUTS) {
    const found = findArgsFile(dir, path.join(...layout.base));
    if (!found) continue;
    result.mode = 'java';
    result.type = layout.type;
    result.programArgs = ['@' + found.rel];
    result.loaderVersion = found.version;
    result.mcVersion = mcVersionOf(found.version);
    result.confidence = 'high';
    return result;
  }

  // 2) 可执行 jar（Fabric / Quilt / Paper 系 / 原版）
  const picked = pickJar(dir);
  if (picked) {
    result.mode = 'java';
    result.type = picked.type;
    result.jar = picked.jar;
    result.programArgs = ['-jar', picked.jar];
    result.confidence = picked.type === 'jar' ? 'low' : 'medium';
    // fabric-server-launch 的版本号
    const vm = picked.jar.match(/(\d+\.\d+(?:\.\d+)?)/);
    if (vm) result.loaderVersion = vm[1];
    if (picked.type === 'jar') {
      result.hint = '只找到一个 jar，已按可执行 jar 处理，请确认是否正确。';
    }
    return result;
  }

  // 3) 兜底：run.bat / run.sh
  for (const s of ['run.bat', 'start.bat', 'start.sh', 'run.sh']) {
    if (fs.existsSync(path.join(dir, s))) {
      result.mode = 'script';
      result.type = 'script';
      result.programArgs = [s];
      result.confidence = 'medium';
      result.hint = `未找到可识别的启动 jar，将执行 ${s}。脚本中的 pause 可能导致停止后进程残留。`;
      return result;
    }
  }

  result.hint = '未能识别启动方式，请在「启动设置」中手动填写。';
  return result;
}

/**
 * 校验并规整用户保存的启动配置，不可用返回 null，调用方回退自动探测。
 * 所有来自 HTTP 的配置都必须经过此校验。
 */
function normalize(cfg) {
  if (!cfg || typeof cfg !== 'object') return null;
  // 只留非空、单行字符串。不可用 map(String)。
  // 丢弃含换行/回车的参数。
  const clean = (s) => typeof s === 'string' && s.length > 0 && !/[\r\n]/.test(s);
  const strs = (v) => (Array.isArray(v) ? v.filter(clean) : []);
  const programArgs = strs(cfg.programArgs);
  if (!programArgs.length) return null;
  const javaPath = clean(cfg.javaPath) ? cfg.javaPath.trim() : '';
  return {
    mode: cfg.mode === 'script' ? 'script' : 'java',
    type: typeof cfg.type === 'string' && cfg.type ? cfg.type : 'jar',
    javaPath: javaPath || 'java',
    jvmArgs: strs(cfg.jvmArgs),
    programArgs,
    jar: typeof cfg.jar === 'string' && cfg.jar ? cfg.jar : null,
    mcVersion: cfg.mcVersion || null,
    loaderVersion: cfg.loaderVersion || null,
    nogui: cfg.nogui !== false,
    confidence: 'manual',
    hint: '这是手动保存的启动配置。',
  };
}

module.exports = { detect, readJvmArgs, pickJar, normalize };
