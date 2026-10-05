'use strict';
/**
 * 白名单 / OP / 封禁名单的读写。
 * 添加白名单需 UUID：优先查 usercache.json，离线模式（online-mode=false）按 Minecraft 规则算离线 UUID，
 * 均失败则提示改用控制台指令。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const KINDS = {
  whitelist: { file: 'whitelist.json', key: 'name', label: '白名单' },
  ops: { file: 'ops.json', key: 'name', label: '管理员' },
  banned: { file: 'banned-players.json', key: 'name', label: '封禁玩家' },
  'banned-ips': { file: 'banned-ips.json', key: 'ip', label: '封禁 IP' },
};

function filePath(server, kind) {
  const k = KINDS[kind];
  if (!k) throw new Error('未知的名单类型: ' + kind);
  return path.join(server.dir, k.file);
}

function read(server, kind) {
  const k = KINDS[kind];
  if (!k) throw new Error('未知的名单类型: ' + kind);
  try {
    const raw = fs.readFileSync(filePath(server, kind), 'utf8').replace(/^﻿/, '');
    const arr = JSON.parse(raw || '[]');
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function write(server, kind, arr) {
  const p = filePath(server, kind);
  fs.writeFileSync(p + '.bak', fs.existsSync(p) ? fs.readFileSync(p) : '[]');
  fs.writeFileSync(p, JSON.stringify(arr, null, 2), 'utf8');
  return arr;
}

/** 面板展示用的合并视图 */
function overview(server) {
  const out = {};
  for (const kind of Object.keys(KINDS)) {
    out[kind] = {
      label: KINDS[kind].label,
      key: KINDS[kind].key,
      entries: read(server, kind),
    };
  }
  return out;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OFFLINE_RE = /^[0-9a-f]{32}$/i;

function normalizeUuid(u) {
  if (!u) return null;
  const s = String(u).trim();
  if (UUID_RE.test(s)) return s.toLowerCase();
  if (OFFLINE_RE.test(s)) {
    const h = s.toLowerCase();
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  }
  return null;
}

/** 离线 UUID 计算：MD5("OfflinePlayer:<name>")，再套 version 3 / variant 位 */
function offlineUuid(name) {
  const md5 = crypto.createHash('md5').update('OfflinePlayer:' + name, 'utf8').digest();
  md5[6] = (md5[6] & 0x0f) | 0x30;
  md5[8] = (md5[8] & 0x3f) | 0x80;
  const h = md5.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** 按名字在 usercache.json 中查找 UUID */
function lookupUuid(server, name) {
  const lower = String(name).toLowerCase();
  for (const f of ['usercache.json', 'usernamecache.json']) {
    try {
      const arr = JSON.parse(fs.readFileSync(path.join(server.dir, f), 'utf8').replace(/^﻿/, ''));
      if (!Array.isArray(arr)) continue;
      const hit = arr.find((e) => String(e.name || '').toLowerCase() === lower);
      if (hit) {
        const u = normalizeUuid(hit.uuid || hit.id);
        if (u) return u;
      }
    } catch {}
  }
  return null;
}

/** 请求 Mojang 接口获取正版 UUID；需联网，失败返回 null */
async function fetchMojangUuid(name) {
  return new Promise((resolve) => {
    const https = require('https');
    const req = https.get(
      `https://api.mojang.com/users/profiles/minecraft/${encodeURIComponent(name)}`,
      { timeout: 6000 },
      (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          try {
            const j = JSON.parse(data);
            resolve(normalizeUuid(j.id));
          } catch { resolve(null); }
        });
      }
    );
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

async function resolveUuid(server, name, hintUuid) {
  const given = normalizeUuid(hintUuid);
  if (given) return given;
  const cached = lookupUuid(server, name);
  if (cached) return cached;
  const online = String(server.prop('online-mode', 'true')) === 'true';
  if (!online) return offlineUuid(name);
  const mojang = await fetchMojangUuid(name);
  if (mojang) return mojang;
  throw new Error(
    `拿不到玩家「${name}」的 UUID。可以把该玩家加进游戏一次，或直接在控制台执行 /whitelist add ${name}。`
  );
}

async function add(server, kind, entry) {
  const k = KINDS[kind];
  if (!k) throw new Error('未知的名单类型: ' + kind);
  const arr = read(server, kind);
  const now = new Date().toISOString();

  if (kind === 'banned-ips') {
    const ip = String(entry.ip || '').trim();
    if (!/^[0-9a-fA-F.:]{3,45}$/.test(ip)) throw new Error('IP 格式不正确');
    if (arr.some((e) => e.ip === ip)) throw new Error('该 IP 已在封禁列表中');
    arr.push({
      ip,
      created: now,
      source: entry.source || '面板',
      expires: 'forever',
      reason: entry.reason || 'Banned by an operator.',
    });
    write(server, kind, arr);
    return arr;
  }

  const name = String(entry.name || '').trim();
  if (!name || !/^[A-Za-z0-9_]{3,16}$/.test(name)) {
    throw new Error('玩家名不合法（3-16 位，仅限字母、数字、下划线）');
  }
  if (arr.some((e) => String(e.name).toLowerCase() === name.toLowerCase())) {
    throw new Error(`「${name}」已在${k.label}中`);
  }
  const uuid = await resolveUuid(server, name, entry.uuid);

  if (kind === 'whitelist') {
    arr.push({ uuid, name });
  } else if (kind === 'ops') {
    arr.push({
      uuid,
      name,
      level: Number(entry.level) || 4,
      bypassesPlayerLimit: !!entry.bypassesPlayerLimit,
    });
  } else {
    arr.push({
      uuid,
      name,
      created: now,
      source: entry.source || '面板',
      expires: 'forever',
      reason: entry.reason || 'Banned by an operator.',
    });
  }
  write(server, kind, arr);
  return arr;
}

function remove(server, kind, key) {
  const k = KINDS[kind];
  if (!k) throw new Error('未知的名单类型: ' + kind);
  const arr = read(server, kind);
  const lower = String(key).toLowerCase();
  const next = arr.filter((e) => String(e[k.key] || '').toLowerCase() !== lower
    && normalizeUuid(e.uuid) !== normalizeUuid(key));
  if (next.length === arr.length) throw new Error(`未在${k.label}中找到: ${key}`);
  write(server, kind, next);
  return next;
}

function update(server, kind, key, patch) {
  const k = KINDS[kind];
  if (!k) throw new Error('未知的名单类型: ' + kind);
  const arr = read(server, kind);
  const lower = String(key).toLowerCase();
  const idx = arr.findIndex((e) => String(e[k.key] || '').toLowerCase() === lower);
  if (idx < 0) throw new Error(`未在${k.label}中找到: ${key}`);
  if (patch.level != null) arr[idx].level = Math.max(1, Math.min(4, Number(patch.level) || 4));
  if (patch.bypassesPlayerLimit != null) arr[idx].bypassesPlayerLimit = !!patch.bypassesPlayerLimit;
  if (patch.reason != null) arr[idx].reason = String(patch.reason);
  write(server, kind, arr);
  return arr;
}

module.exports = { overview, read, write, add, remove, update, offlineUuid, lookupUuid, KINDS };
