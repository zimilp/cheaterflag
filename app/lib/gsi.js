'use strict';
// CS2 Game State Integration (Valve's official, read-only game-state feed).
// Used only to know whether you're in the menu/lobby, in warmup, or mid-match,
// so notifications never pop up while you're playing.
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { EventEmitter } = require('events');

const PORT = 3077;
const CFG_NAME = 'gamestate_integration_cheaterflag.cfg';

function cfgText(token) {
  return `"CheaterFlag"
{
  "uri"       "http://127.0.0.1:${PORT}/gsi"
  "timeout"   "5.0"
  "buffer"    "0.1"
  "throttle"  "0.5"
  "heartbeat" "10.0"
  "auth"      { "token" "${token}" }
  "data"
  {
    "provider"  "1"
    "map"       "1"
    "round"     "1"
    "player_id" "1"
  }
}
`;
}

/** Writes the GSI config into CS2's cfg folder (CS2 reads it at launch). Returns true if it changed. */
function installCfg(cs2Dir, token) {
  if (!cs2Dir) return false;
  const dir = path.join(cs2Dir, 'cfg');
  if (!fs.existsSync(dir)) return false;
  const file = path.join(dir, CFG_NAME);
  const text = cfgText(token);
  try { if (fs.readFileSync(file, 'utf8') === text) return false; } catch (_) {}
  fs.writeFileSync(file, text);
  return true;
}

/** Pure: turns a GSI payload into our simple state. */
function summarize(body) {
  const map = body && body.map;
  const activity = body && body.player && body.player.activity; // menu | playing | textinput
  const phase = map ? map.phase : null;                          // warmup | live | intermission | gameover
  const inMatch = !!map && phase !== 'gameover';
  return { inMatch, phase, activity: activity || null, map: map ? map.name : null };
}

class GameState extends EventEmitter {
  constructor(token) {
    super();
    this.token = token || crypto.randomBytes(12).toString('hex');
    this.state = { inMatch: false, phase: null, activity: null, map: null, running: false };
    this.lastSeen = 0;
  }

  start() {
    this.server = http.createServer((req, res) => {
      if (req.method !== 'POST' || req.url !== '/gsi') { res.writeHead(404); return res.end(); }
      let data = '';
      req.on('data', (c) => { data += c; if (data.length > 1e6) req.destroy(); });
      req.on('end', () => {
        res.writeHead(200); res.end();
        let body; try { body = JSON.parse(data); } catch (_) { return; }
        if (!body.auth || body.auth.token !== this.token) return;
        this.lastSeen = Date.now();
        this.update({ ...summarize(body), running: true });
      });
    });
    this.server.on('error', () => {}); // port busy: we just won't know the game state
    this.server.listen(PORT, '127.0.0.1');
    // no heartbeat for 30 s → CS2 closed
    this.timer = setInterval(() => {
      if (this.state.running && Date.now() - this.lastSeen > 30000) this.update({ inMatch: false, phase: null, activity: null, map: null, running: false });
    }, 5000);
  }

  update(next) {
    const prev = this.state;
    this.state = next;
    if (prev.inMatch !== next.inMatch || prev.phase !== next.phase || prev.running !== next.running) this.emit('change', next, prev);
  }

  /** True when it's OK to show a notification right now. `warmupOk` allows warmup (pre-match warnings). */
  quietTime(warmupOk = false) {
    const s = this.state;
    if (!s.running || !s.inMatch) return false;
    if (warmupOk && s.phase === 'warmup') return false;
    return true;
  }

  stop() { clearInterval(this.timer); if (this.server) this.server.close(); }
}

module.exports = { GameState, installCfg, summarize, cfgText, PORT };
