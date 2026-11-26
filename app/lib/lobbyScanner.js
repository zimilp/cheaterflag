'use strict';
// Lobby scanner. Never touches the CS2 process. Two read-only sources:
//  1) console.log written by the -condebug launch option (tailed)
//  2) CS2's built-in network console (-netconport 2121), where we send "status"
// Any SteamIDs found are reported through onPlayers().

const fs = require('fs');
const net = require('net');
const path = require('path');
const { EventEmitter } = require('events');

const STEAM64_BASE = 76561197960265728n;

/** Pull SteamID64s out of console text. Handles 7656119…, [U:1:n] and STEAM_x:y:z forms. */
function extractSteamIds(text) {
  const ids = new Set();
  for (const m of text.matchAll(/\b(7656119\d{10})\b/g)) ids.add(m[1]);
  for (const m of text.matchAll(/\[U:1:(\d+)\]/g)) ids.add((STEAM64_BASE + BigInt(m[1])).toString());
  for (const m of text.matchAll(/STEAM_[0-5]:([01]):(\d+)/g)) ids.add((STEAM64_BASE + BigInt(m[2]) * 2n + BigInt(m[1])).toString());
  return [...ids];
}

/** Remove what CS2 puts in front of console lines: "11/26 10:10:55 " (console.log) and "[Client] " (channel). */
function stripPrefix(line) {
  return line.replace(/^\uFEFF?/, '').replace(/^\d{2}\/\d{2} \d{2}:\d{2}:\d{2}\s+/, '').replace(/^\[[A-Za-z]+\]\s?/, '');
}

/** Player names from CS2's `status` output (CS2 no longer prints SteamIDs there). Example line:
 *  "11/26 10:10:55 [Client]    0    00:54    0    0     active 786432 loopback:0 'cfab'" */
function extractStatusNames(text) {
  const names = [];
  let inPlayers = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = stripPrefix(raw);
    if (/^-+\s*players\s*-+/i.test(line)) { inPlayers = true; continue; }
    if (/^#end/.test(line) || /^-{3,}\w/.test(line)) { inPlayers = false; continue; }
    const m = line.match(/^\s*\d+\s+(?:[\d:]+|\[[^\]]*\]|BOT)\s+[^']*'(.*)'\s*$/);
    if (m && (inPlayers || /\b(active|spawning|connected|challenging)\b/.test(line))) {
      const n = m[1];
      if (n && n !== 'unknown') names.push(n);
    }
  }
  return names;
}

/** True when a console line says a new match/map is loading (reset the lobby list).
 *  Not "loaded spawngroup": that also appears inside every `status` reply. */
function isMatchStart(raw) {
  const line = stripPrefix(raw);
  return /ChangeGameUIState: \S+ -> CSGO_GAME_UI_STATE_LOADINGSCREEN/.test(line)
    || /Host activate: Remote Connect/.test(line)
    || (/^Map: "/.test(line) && !/<empty>/.test(line));
}

const DEFAULT_CS2_DIRS = [
  'C:\\Program Files (x86)\\Steam\\steamapps\\common\\Counter-Strike Global Offensive\\game\\csgo',
  'D:\\SteamLibrary\\steamapps\\common\\Counter-Strike Global Offensive\\game\\csgo',
  'E:\\SteamLibrary\\steamapps\\common\\Counter-Strike Global Offensive\\game\\csgo',
];

function findConsoleLog(customDir) {
  for (const d of [customDir, ...DEFAULT_CS2_DIRS].filter(Boolean)) {
    const p = path.join(d, 'console.log');
    if (fs.existsSync(p)) return p;
  }
  return null;
}

class LobbyScanner extends EventEmitter {
  constructor({ cs2Dir, netconPort = 2121, ownSteamId, ownName } = {}) {
    super();
    this.cs2Dir = cs2Dir; this.netconPort = netconPort; this.ownSteamId = ownSteamId; this.ownName = ownName;
    this.current = new Set(); this.names = new Set(); this.pos = 0; this.timer = null; this.sock = null;
  }

  start() {
    this.logPath = findConsoleLog(this.cs2Dir);
    if (this.logPath) this.pos = fs.statSync(this.logPath).size; // only new lines
    let n = 0;
    this.timer = setInterval(() => { this.tail(); if (n++ % 4 === 0) this.pollNetcon(); }, 5000); // status every 20 s
    this.emit('status', { consoleLog: this.logPath, netconPort: this.netconPort });
  }

  stop() { clearInterval(this.timer); if (this.sock) this.sock.destroy(); }

  feed(text) {
    const fresh = [];
    for (const line of text.split(/\r?\n/)) {
      if (isMatchStart(line)) {
        this.current.clear(); this.names.clear(); this.emit('matchStart');
        // ask CS2 for the player list right away, then a few more times while everyone connects
        for (const ms of [4000, 10000, 20000, 35000, 60000]) setTimeout(() => this.pollNetcon(), ms);
      }
      for (const id of extractSteamIds(line)) {
        if (id === this.ownSteamId || this.current.has(id)) continue;
        this.current.add(id); fresh.push(id);
      }
    }
    if (fresh.length) this.emit('players', fresh, [...this.current]);
    const listed = extractStatusNames(text);
    if (listed.length) this.emit('statusSeen', { at: Date.now(), count: listed.length });
    const freshNames = listed.filter((n) => n !== this.ownName && !this.names.has(n));
    for (const n of freshNames) this.names.add(n);
    if (freshNames.length) this.emit('names', freshNames, [...this.names]);
  }

  tail() {
    if (!this.logPath) return;
    try {
      const size = fs.statSync(this.logPath).size;
      if (size < this.pos) this.pos = 0; // log rotated
      if (size === this.pos) return;
      const fd = fs.openSync(this.logPath, 'r');
      const buf = Buffer.alloc(Math.min(size - this.pos, 2 * 1024 * 1024));
      fs.readSync(fd, buf, 0, buf.length, this.pos);
      fs.closeSync(fd);
      this.pos += buf.length;
      this.feed(buf.toString('utf8'));
    } catch (_) { /* CS2 may hold the file; try again next tick */ }
  }

  pollNetcon() {
    if (this.sock) { this.sock.write('status\n'); return; }
    if (this.connecting) return;
    this.connecting = true;
    const s = net.connect({ host: '127.0.0.1', port: this.netconPort });
    s.setEncoding('utf8');
    s.on('connect', () => { this.connecting = false; this.sock = s; this.emit('netcon', true); s.write('status\n'); });
    s.on('data', (d) => this.feed(d));
    s.on('error', () => { this.connecting = false; });
    s.on('close', () => { this.connecting = false; if (this.sock === s) { this.sock = null; this.emit('netcon', false); } });
  }

  /** Resolves once CS2's network console is reachable (CS2 running with -netconport). */
  ensureNetcon(timeoutMs = 120000) {
    return new Promise((resolve, reject) => {
      const end = Date.now() + timeoutMs;
      const tick = () => {
        if (this.sock) return resolve();
        if (Date.now() > end) return reject(new Error('Could not reach CS2. Is the lobby scanner turned on (Setup step 2) and CS2 open?'));
        this.pollNetcon(); setTimeout(tick, 2000);
      };
      tick();
    });
  }

  /** Sends one console command to CS2. */
  async send(cmd) { await this.ensureNetcon(5000); this.sock.write(cmd + '\n'); }

  scanNow() { this.tail(); this.pollNetcon(); }
}

module.exports = { LobbyScanner, extractSteamIds, extractStatusNames, isMatchStart, findConsoleLog, stripPrefix };
