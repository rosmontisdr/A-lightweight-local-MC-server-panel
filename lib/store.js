'use strict';
const path = require('path');
const fs = require('fs');
const { readJsonSafe, writeJsonAtomic, uid } = require('./util');

const DATA_DIR = path.join(__dirname, '..', 'data');
const PANEL_FILE = path.join(DATA_DIR, 'panel.json');

const DEFAULT_KEYBINDS = '@a @e @p @r @s'.split(' ');

class Store {
  constructor() {
    this.data = readJsonSafe(PANEL_FILE, null) || { servers: [], settings: {} };
    if (!Array.isArray(this.data.servers)) this.data.servers = [];
    if (!this.data.settings) this.data.settings = {};
  }

  save() {
    writeJsonAtomic(PANEL_FILE, this.data);
  }

  list() {
    return this.data.servers;
  }

  get(id) {
    return this.data.servers.find((s) => s.id === id) || null;
  }

  add({ name, dir, launch }) {
    const abs = path.resolve(dir);
    if (!fs.existsSync(abs)) throw new Error('目录不存在: ' + abs);
    if (!fs.statSync(abs).isDirectory()) throw new Error('不是目录: ' + abs);
    if (this.data.servers.some((s) => path.resolve(s.dir).toLowerCase() === abs.toLowerCase())) {
      throw new Error('该目录已在列表中: ' + abs);
    }
    const entry = {
      id: uid(),
      name: name || path.basename(abs),
      dir: abs,
      launch: launch || null,
      createdAt: new Date().toISOString(),
    };
    this.data.servers.push(entry);
    this.save();
    return entry;
  }

  /** 读取面板级设置（端口、主题等），缺失则返回默认值 */
  getSetting(key, fallback = null) {
    const v = this.data.settings[key];
    return v === undefined || v === null ? fallback : v;
  }

  setSetting(key, value) {
    this.data.settings[key] = value;
    this.save();
  }

  update(id, patch) {
    const s = this.get(id);
    if (!s) throw new Error('服务器不存在');
    if (patch.name != null) s.name = String(patch.name);
    // 必须用 in 判断。
    if ('launch' in patch) s.launch = patch.launch || null;
    this.save();
    return s;
  }

  /** 清空服务器列表与面板设置，恢复出厂状态。只写 panel.json。 */
  reset() {
    this.data = { servers: [], settings: {} };
    this.save();
  }

  remove(id) {
    const i = this.data.servers.findIndex((s) => s.id === id);
    if (i < 0) throw new Error('服务器不存在');
    const [s] = this.data.servers.splice(i, 1);
    this.save();
    return s;
  }

  static looksLikeServer(dir) {
    try {
      const names = fs.readdirSync(dir);
      const set = new Set(names.map((n) => n.toLowerCase()));
      if (set.has('server.properties')) return true;
      if (set.has('eula.txt') && names.some((n) => /\.jar$/i.test(n))) return true;
      return false;
    } catch {
      return false;
    }
  }
}

module.exports = { Store, DATA_DIR, PANEL_FILE, DEFAULT_KEYBINDS };
