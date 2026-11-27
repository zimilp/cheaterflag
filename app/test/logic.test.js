'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { aimError, viewDelta } = require('../lib/geometry');
const { analyze } = require('../lib/demoScan');
const { extractSteamIds, LobbyScanner } = require('../lib/lobbyScanner');
const retention = require('../lib/retention');

// ---- helpers: build a player row looking at a target
const lookAt = (from, to) => {
  const dx = to.X - from.X, dy = to.Y - from.Y, dz = (to.Z + 56) - (from.Z + 64);
  return { yaw: Math.atan2(dy, dx) * 180 / Math.PI, pitch: -Math.atan2(dz, Math.hypot(dx, dy)) * 180 / Math.PI };
};

test('geometry: aim error is ~0 when looking straight at target', () => {
  const a = { X: 0, Y: 0, Z: 0 }, b = { X: 1000, Y: 300, Z: 40 };
  Object.assign(a, lookAt(a, b));
  assert.ok(aimError(a, b) < 0.01);
  assert.ok(Math.abs(aimError({ ...a, yaw: a.yaw + 30 }, b) - 30) < 1);
  assert.ok(Math.abs(viewDelta({ pitch: 0, yaw: 0 }, { pitch: 0, yaw: 90 }) - 90) < 1e-6);
});

const CHEAT = '76561198000000001', LEGIT = '76561198000000002', ENEMY = '76561198000000003';
const players = [{ steamid: CHEAT, name: 'cheater' }, { steamid: LEGIT, name: 'legit' }, { steamid: ENEMY, name: 'enemy' }];

function synthetic() {
  const samples = [], killWindows = [], deaths = [];
  // 6 tracking streaks: enemy walks (silently, 112 u/s) behind a wall; cheater's crosshair follows, legit looks away.
  for (let s = 0; s < 6; s++) {
    const base = 10000 + s * 2000;
    for (let i = 0; i < 20; i++) {
      const tick = base + i * 8;
      const enemy = { tick, steamid: ENEMY, X: 1000, Y: i * 14, Z: 0, pitch: 0, yaw: 180, is_alive: true, team_num: 2, approximate_spotted_by: [] };
      const c = { tick, steamid: CHEAT, X: 0, Y: 0, Z: 0, is_alive: true, team_num: 3, approximate_spotted_by: [] };
      Object.assign(c, lookAt(c, enemy));
      const l = { tick, steamid: LEGIT, X: 0, Y: 200, Z: 0, pitch: 0, yaw: 90, is_alive: true, team_num: 3, approximate_spotted_by: [] };
      samples.push(enemy, c, l);
    }
  }
  // 12 kills by cheater, each a 60° snap within 8 ticks; 12 kills by legit with smooth aim.
  for (let k = 0; k < 12; k++) {
    for (const [who, snap] of [[CHEAT, true], [LEGIT, false]]) {
      const tick = 50000 + k * 1000 + (who === LEGIT ? 500 : 0);
      deaths.push({ tick, attacker_steamid: who, user_steamid: ENEMY, weapon: 'ak47', penetrated: 0, thrusmoke: false });
      for (let t = tick - 64; t <= tick; t++) {
        const v = { tick: t, steamid: ENEMY, X: 800, Y: 0, Z: 0, pitch: 0, yaw: 180, is_alive: true, team_num: 2, approximate_spotted_by: t >= tick - 40 ? [who] : [] };
        const a = { tick: t, steamid: who, X: 0, Y: 0, Z: 0, is_alive: true, team_num: 3, approximate_spotted_by: [] };
        const exact = lookAt(a, v);
        let yawOff;
        if (snap) yawOff = t <= tick - 8 ? 60 : 0;
        else yawOff = Math.max(0, (tick - 1 - t) * 0.6); // smooth tracking onto target
        a.pitch = exact.pitch; a.yaw = exact.yaw + yawOff;
        killWindows.push(v, a);
      }
    }
  }
  return { players, deaths, roundStarts: [0, 30000, 60000], samples, killWindows };
}

test('scanner: flags synthetic cheater with strong evidence, not the legit player', () => {
  const res = analyze(synthetic());
  const c = res.find((r) => r.steamid === CHEAT), l = res.find((r) => r.steamid === LEGIT);
  assert.equal(c.flagged, true, JSON.stringify(c.metrics));
  assert.ok(c.signals.some((s) => s.type === 'wallhack'));
  assert.ok(c.signals.some((s) => s.type === 'aimbot'));
  assert.ok(c.rounds.length > 0);
  assert.equal(l.flagged, false, JSON.stringify(l.metrics));
  assert.equal(l.signals.length, 0);
});

test('scanner: no spotted data → no wallhack signals, still no crash', () => {
  const d = synthetic();
  for (const r of d.samples) delete r.approximate_spotted_by;
  const res = analyze(d);
  assert.ok(res.every((r) => !r.signals.some((s) => s.name.startsWith('Tracked'))));
});

test('lobby: extracts SteamIDs in all formats', () => {
  // same account written three ways → one id
  assert.deepEqual(extractSteamIds('76561198012345678 [U:1:52079950] STEAM_1:0:26039975'), ['76561198012345678']);
  const ids = extractSteamIds('#  2 "A" 76561198012345678 ... [U:1:500] ... STEAM_0:1:100').sort();
  assert.deepEqual(ids, ['76561197960265929', '76561197960266228', '76561198012345678']);
});

test('lobby: emits new players once and skips own id', () => {
  const s = new LobbyScanner({ ownSteamId: '76561198000000009' });
  const got = [];
  s.on('players', (fresh) => got.push(...fresh));
  s.feed('76561198000000009\n76561198000000010\n76561198000000010\n76561198000000011');
  assert.deepEqual(got, ['76561198000000010', '76561198000000011']);
});

test('retention: unflagged deleted, flagged kept, old flagged swept', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-')), flagged = path.join(dir, 'flagged');
  const a = path.join(dir, 'a.dem'), b = path.join(dir, 'b.dem');
  fs.writeFileSync(a, 'x'); fs.writeFileSync(b, 'y');
  assert.equal(retention.afterScan(a, flagged, false), null);
  assert.ok(!fs.existsSync(a));
  const kept = retention.afterScan(b, flagged, true);
  assert.ok(fs.existsSync(kept));
  assert.deepEqual(retention.sweep(dir, flagged, Date.now()), []);
  const removed = retention.sweep(dir, flagged, Date.now() + 15 * 86400000);
  assert.deepEqual(removed, [kept]);
});
