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

/** Names from "<name> connected" lines that CS2 writes to console.log as each player joins (no netcon needed). */
function extractConnectedNames(text) {
  const names = [];
  for (const raw of text.split(/\r?\n/)) {
    if (!/^\uFEFF?\d{2}\/\d{2} \d{2}:\d{2}:\d{2} /.test(raw) && !/ connected\s*$/.test(raw)) continue;
    const line = raw.replace(/^\uFEFF?\d{2}\/\d{2} \d{2}:\d{2}:\d{2}\s/, '');
    if (line.startsWith('[')) continue;                       // engine messages have a [Tag]
    const m = line.match(/^(.{1,64}) connected\s*$/);
    if (m && !/^(Client|Server):/.test(m[1])) names.push(m[1]);
  }
  return names;
}

/** The game server a console line says we're joining ("Host activate: Remote Connect (<server>)"), else null.
 *  This is the start of a match. Rejoining the SAME server (crash, disconnect) is not a new match. */
function matchServer(raw) {
  const m = stripPrefix(raw).match(/Host activate: Remote Connect \((.+)\)/);
  return m ? m[1] : null;
}
const isMatchStart = (raw) => matchServer(raw) != null;

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
    if (this.logPath) {
      const size = fs.statSync(this.logPath).size;
      this.pos = size;
      // started mid-match? read back to the last match start so the lobby isn't empty
      try {
        const len = Math.min(size, 2 * 1024 * 1024), buf = Buffer.alloc(len);
        const fd = fs.openSync(this.logPath, 'r'); fs.readSync(fd, buf, 0, len, size - len); fs.closeSync(fd);
        const lines = buf.toString('utf8').split(/\r?\n/);
        let i = lines.length - 1;
        while (i >= 0 && !isMatchStart(lines[i])) i--;
        const leftAfter = lines.slice(i + 1);
        if (i >= 0) {   // rejoined the same server? start from the first join, when everyone else connected
          const server = matchServer(lines[i]);
          for (let j = i - 1; j >= 0; j--) { const sv = matchServer(lines[j]); if (sv && sv !== server) break; if (sv === server) i = j; }
        }
        const rest = lines.slice(i);
        if (i >= 0 && !leftAfter.some((l) => /CSGO_GAME_UI_STATE_\w+ -> CSGO_GAME_UI_STATE_MAINMENU/.test(l) && !/LOADINGSCREEN/.test(l)) ) setTimeout(() => { this.feed(rest.join('\n')); this.restoreIfRejoin(); }, 0);
      } catch (_) {}
    }
    let n = 0;
    this.timer = setInterval(() => { this.tail(); if (n++ % 4 === 0) this.pollNetcon(); }, 5000); // status every 20 s
    this.emit('status', { consoleLog: this.logPath, netconPort: this.netconPort });
  }

  stop() { clearInterval(this.timer); if (this.sock) this.sock.destroy(); }

  feed(text) {
    const fresh = [];
    for (const line of text.split(/\r?\n/)) {
      // back in the main menu: the match is over (or we dropped out) — keep the list aside for a quick rejoin
      if (/Host activate: Idle/.test(stripPrefix(line)) && this.server) {
        this.prev = { server: this.server, names: [...this.names], at: Date.now() };
        this.server = null; this.map = null; this.current.clear(); this.names.clear();
        this.emit('matchEnd');
        continue;
      }
      const mp = stripPrefix(line).match(/^Map: "([^"]+)"/);
      if (mp && mp[1] !== '<empty>' && mp[1] !== this.map) { this.map = mp[1]; this.emit('map', this.map); }
      const server = matchServer(line);
      if (server && server !== this.server) {
        this.server = server;
        this.current.clear(); this.names.clear(); this.emit('matchStart');
        // rejoined the same server? only we "connect" then — bring the earlier list back if nobody else shows up
        clearTimeout(this.rejoinTimer);
        this.rejoinTimer = setTimeout(() => this.restoreIfRejoin(), 20000);
        // ask CS2 for the player list right away, then a few more times while everyone connects
        for (const ms of [4000, 10000, 20000, 35000, 60000]) setTimeout(() => this.pollNetcon(), ms);
      }
      for (const id of extractSteamIds(line)) {
        if (id === this.ownSteamId || this.current.has(id)) continue;
        this.current.add(id); fresh.push(id);
      }
    }
    if (fresh.length) this.emit('players', fresh, [...this.current]);
    const listed = extractStatusNames(text).concat(extractConnectedNames(text));
    const freshNames = listed.filter((n) => n !== this.ownName && !this.names.has(n));
    for (const n of freshNames) this.names.add(n);
    if (listed.length) this.emit('statusSeen', { at: Date.now(), count: this.names.size + 1 });
    if (freshNames.length) this.emit('names', freshNames, [...this.names]);
  }

  /** After joining: if no one else connected and it's the server we just left, it was a rejoin. */
  restoreIfRejoin() {
    const p = this.prev;
    if (!p || p.server !== this.server || this.names.size || !p.names.length) return;
    for (const n of p.names) this.names.add(n);
    this.emit('names', [...p.names], [...this.names]);
    this.emit('statusSeen', { at: Date.now(), count: this.names.size + 1 });
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
    const hosts = ['127.0.0.1', '::1', ...Object.values(require('os').networkInterfaces()).flat().filter((x) => x && x.family === 'IPv4' && !x.internal).map((x) => x.address)];
    this.hostIdx = ((this.hostIdx || 0) + (this.lastErr ? 1 : 0)) % hosts.length;
    const s = net.connect({ host: hosts[this.hostIdx], port: this.netconPort });
    s.setEncoding('utf8');
    s.on('connect', () => { this.connecting = false; this.lastErr = null; this.sock = s; this.emit('netcon', true); s.write('status\n'); });
    s.on('data', (d) => this.feed(d));
    s.on('error', (e) => { this.connecting = false; this.lastErr = e && e.code; });
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

module.exports = { LobbyScanner, extractSteamIds, extractStatusNames, extractConnectedNames, isMatchStart, findConsoleLog, stripPrefix };
