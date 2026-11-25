'use strict';
// Finds Steam/CS2 on this PC and sets CS2's launch options automatically, so friends never
// have to open Steam's Properties dialog. Steam rewrites its config on exit, so this only
// writes while Steam is closed, and always keeps a backup of the original file.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const NEEDED_FLAGS = ['-condebug', '-netconport 2121'];
const STEAM64_BASE = 76561197960265728n;

// ---------- minimal VDF (Valve KeyValues) parser / writer
function parseVdf(text) {
  let i = 0;
  const root = {};
  const stack = [root];
  const order = new WeakMap(); order.set(root, []);
  const keysOf = (o) => order.get(o);
  let pendingKey = null;

  function readString() {
    let s = ''; i++; // skip opening quote
    while (i < text.length && text[i] !== '"') {
      if (text[i] === '\\' && i + 1 < text.length) { s += text[i] + text[i + 1]; i += 2; continue; }
      s += text[i++];
    }
    i++; return s;
  }
  while (i < text.length) {
    const c = text[i];
    if (c === '/' && text[i + 1] === '/') { while (i < text.length && text[i] !== '\n') i++; continue; }
    if (/\s/.test(c)) { i++; continue; }
    if (c === '"') {
      const s = readString();
      const cur = stack[stack.length - 1];
      if (pendingKey === null) pendingKey = s;
      else { if (!(pendingKey in cur)) keysOf(cur).push(pendingKey); cur[pendingKey] = s; pendingKey = null; }
      continue;
    }
    if (c === '{') {
      const cur = stack[stack.length - 1];
      const obj = (cur[pendingKey] && typeof cur[pendingKey] === 'object') ? cur[pendingKey] : {};
      if (!order.has(obj)) order.set(obj, []);
      if (!(pendingKey in cur)) keysOf(cur).push(pendingKey);
      cur[pendingKey] = obj; stack.push(obj); pendingKey = null; i++; continue;
    }
    if (c === '}') { stack.pop(); i++; continue; }
    // unquoted token (rare in Steam files)
    let s = ''; while (i < text.length && !/[\s{}"]/.test(text[i])) s += text[i++];
    const cur = stack[stack.length - 1];
    if (pendingKey === null) pendingKey = s; else { if (!(pendingKey in cur)) keysOf(cur).push(pendingKey); cur[pendingKey] = s; pendingKey = null; }
  }
  root.__order = order;
  return root;
}

function writeVdf(root) {
  const order = root.__order;
  const out = [];
  const walk = (obj, depth) => {
    const tabs = '\t'.repeat(depth);
    const keys = (order && order.get(obj)) || Object.keys(obj);
    const all = [...keys, ...Object.keys(obj).filter((k) => k !== '__order' && !keys.includes(k))];
    for (const k of all) {
      const v = obj[k];
      if (v && typeof v === 'object') { out.push(`${tabs}"${k}"`, `${tabs}{`); walk(v, depth + 1); out.push(`${tabs}}`); }
      else if (v !== undefined) out.push(`${tabs}"${k}"\t\t"${v}"`);
    }
  };
  walk(root, 0);
  return out.join('\n') + '\n';
}

/** Case-insensitive child lookup (Steam isn't consistent about key case). */
function child(obj, key, create = false) {
  if (!obj) return null;
  const k = Object.keys(obj).find((x) => x.toLowerCase() === key.toLowerCase());
  if (k) return obj[k];
  if (!create) return null;
  obj[key] = {};
  return obj[key];
}

function mergeLaunchOptions(existing) {
  let opts = (existing || '').trim();
  for (const f of NEEDED_FLAGS) {
    const name = f.split(' ')[0];
    if (!new RegExp('(^|\\s)' + name + '(\\s|$)').test(opts)) opts = (opts + ' ' + f).trim();
  }
  return opts;
}

function hasNeededFlags(opts) { return mergeLaunchOptions(opts) === (opts || '').trim(); }

// ---------- Windows helpers
function steamDir() {
  try {
    const out = execFileSync('reg', ['query', 'HKCU\\Software\\Valve\\Steam', '/v', 'SteamPath'], { encoding: 'utf8', windowsHide: true });
    const m = out.match(/SteamPath\s+REG_SZ\s+(.+)/);
    if (m && fs.existsSync(m[1].trim())) return path.normalize(m[1].trim());
  } catch (_) {}
  const d = 'C:\\Program Files (x86)\\Steam';
  return fs.existsSync(d) ? d : null;
}

function isSteamRunning() {
  try {
    const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq steam.exe', '/NH'], { encoding: 'utf8', windowsHide: true });
    return /steam\.exe/i.test(out);
  } catch (_) { return false; }
}

/** Finds the CS2 game\csgo folder in any Steam library. */
function findCs2Dir(steam = steamDir()) {
  if (!steam) return null;
  const libs = [steam];
  try {
    const lf = parseVdf(fs.readFileSync(path.join(steam, 'steamapps', 'libraryfolders.vdf'), 'utf8'));
    const folders = child(lf, 'libraryfolders') || {};
    for (const k of Object.keys(folders)) if (folders[k] && folders[k].path) libs.push(folders[k].path.replace(/\\\\/g, '\\'));
  } catch (_) {}
  for (const lib of libs) {
    const d = path.join(lib, 'steamapps', 'common', 'Counter-Strike Global Offensive', 'game', 'csgo');
    if (fs.existsSync(d)) return d;
  }
  return null;
}

function localConfigPath(steamid64, steam = steamDir()) {
  if (!steam || !steamid64) return null;
  const accountId = (BigInt(steamid64) - STEAM64_BASE).toString();
  const p = path.join(steam, 'userdata', accountId, 'config', 'localconfig.vdf');
  return fs.existsSync(p) ? p : null;
}

function cs2AppNode(root, create) {
  const store = child(root, 'UserLocalConfigStore', create);
  const sw = child(store, 'Software', create);
  const valve = child(sw, 'Valve', create);
  const st = child(valve, 'Steam', create);
  const apps = child(st, 'apps', create);
  return child(apps, '730', create);
}

/** Current status for the setup screen. */
function launchOptionsStatus(steamid64) {
  const file = localConfigPath(steamid64);
  if (!file) return { found: false, ok: false };
  try {
    const node = cs2AppNode(parseVdf(fs.readFileSync(file, 'utf8')), false);
    const opts = node ? node.LaunchOptions || '' : '';
    return { found: true, ok: hasNeededFlags(opts), current: opts };
  } catch (_) { return { found: true, ok: false }; }
}

/** Adds the flags. Returns {ok} or {ok:false, reason:'steam-running'|'not-found'|...}. */
function applyLaunchOptions(steamid64) {
  if (isSteamRunning()) return { ok: false, reason: 'steam-running' };
  const file = localConfigPath(steamid64);
  if (!file) return { ok: false, reason: 'not-found' };
  const text = fs.readFileSync(file, 'utf8');
  const root = parseVdf(text);
  const node = cs2AppNode(root, true);
  const before = node.LaunchOptions || '';
  const after = mergeLaunchOptions(before);
  if (after === before.trim()) return { ok: true, changed: false };
  const backup = file + '.cheaterflag-backup';
  if (!fs.existsSync(backup)) fs.writeFileSync(backup, text);
  node.LaunchOptions = after;
  fs.writeFileSync(file, writeVdf(root));
  return { ok: true, changed: true, launchOptions: after };
}

module.exports = {
  parseVdf, writeVdf, mergeLaunchOptions, hasNeededFlags, cs2AppNode,
  steamDir, isSteamRunning, findCs2Dir, launchOptionsStatus, applyLaunchOptions, NEEDED_FLAGS,
};
