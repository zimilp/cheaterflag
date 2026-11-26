'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { judge, applyScrutiny } = require('../lib/demoScan');

const base = { kills: 20, wallStreaks: 0, snaps: 0, snapRate: 0, unseenWallbangs: 0, medianReactionTicks: 30, reactionSamples: 12 };

test('normal players need strong evidence; risky accounts get stricter rules', () => {
  const m = { ...base, wallStreaks: 3 };
  assert.equal(judge(m).flagged, false);                 // below normal threshold (4)
  assert.equal(judge(m, undefined, 'caution').flagged, false); // one signal, needs two
  assert.equal(judge(m, undefined, 'high').flagged, true);     // banned/blacklisted: one signal is enough
  const two = { ...base, wallStreaks: 3, unseenWallbangs: 3 };
  assert.equal(judge(two, undefined, 'caution').flagged, true);
});

test('applyScrutiny picks the level from the account check', () => {
  const results = [{ steamid: 'a', name: 'A', metrics: { ...base, wallStreaks: 3 }, flagged: false, signals: [], score: 0 },
                   { steamid: 'b', name: 'B', metrics: { ...base, wallStreaks: 3 }, flagged: false, signals: [], score: 0 }];
  const out = applyScrutiny(results, [{ steamid: 'a', tier: 'rejected' }, { steamid: 'b', tier: 'approved' }]);
  assert.equal(out.find((r) => r.steamid === 'a').flagged, true);
  assert.equal(out.find((r) => r.steamid === 'a').scrutiny, 'high');
  assert.equal(out.find((r) => r.steamid === 'b').flagged, false);
});

// ---- Scrutinize (deep check of one player)
const { deepAnalyze } = require('../lib/demoScan');
function aimAt(a, v) {
  const dx = v.X - a.X, dy = v.Y - a.Y, dz = (v.Z + 56) - (a.Z + 64);
  return { yaw: Math.atan2(dy, dx) * 180 / Math.PI, pitch: -Math.atan2(dz, Math.hypot(dx, dy)) * 180 / Math.PI };
}
// shooter "s" kills "v1".."vN"; each victim strafes sideways and is visible for the last 40 ticks
function fight({ kills, lockOn, smoke }) {
  const players = [{ steamid: 's', name: 'S' }];
  const deaths = [], killWindows = [], samples = [];
  for (let k = 0; k < kills; k++) {
    const vid = 'v' + k; players.push({ steamid: vid, name: vid });
    const tick = 1000 + k * 500;
    deaths.push({ tick, attacker_steamid: 's', user_steamid: vid, weapon: 'ak47', headshot: false, thrusmoke: smoke, penetrated: 0 });
    for (let t = tick - 96; t <= tick; t++) {
      const v = { tick: t, steamid: vid, X: 600, Y: (t - tick) * 4, Z: 0, is_alive: true, team_num: 2, approximate_spotted_by: t >= tick - 40 ? ['s'] : [] };
      const a = { tick: t, steamid: 's', X: 0, Y: 0, Z: 0, is_alive: true, team_num: 3, approximate_spotted_by: [] };
      Object.assign(a, lockOn ? aimAt(a, v) : { yaw: 40, pitch: 0 });
      if (!lockOn && t >= tick - 8) Object.assign(a, aimAt(a, v));        // a normal flick at the end
      killWindows.push(a, v);
    }
  }
  return { players, deaths, roundStarts: [0], samples, killWindows };
}

test('scrutinize flags aim locks and smoke kills, and clears a normal player', () => {
  const clean = deepAnalyze(fight({ kills: 6, lockOn: false, smoke: false }), 's');
  assert.equal(clean.flagged, false);
  const locked = deepAnalyze(fight({ kills: 6, lockOn: true, smoke: false }), 's');
  assert.equal(locked.flagged, true);
  assert.ok(locked.signals.some((x) => /locked/.test(x.name)));
  assert.ok(locked.signals.some((x) => /before they were visible/.test(x.name)));
  const smoky = deepAnalyze(fight({ kills: 6, lockOn: false, smoke: true }), 's');
  assert.ok(smoky.signals.some((x) => /smoke/.test(x.name)));
  assert.throws(() => deepAnalyze(fight({ kills: 1, lockOn: false, smoke: false }), 'nobody'));
});

test('players who left early are put on the right team', () => {
  const { addLeavers } = require('../lib/demoScan');
  const teams = [{ score: 6, players: ['a', 'b'] }, { score: 13, players: ['x', 'y'] }];
  const samples = [];
  for (let t = 0; t < 10; t++) {          // first half: a, b, quitter on 3; x, y on 2
    samples.push({ tick: t, steamid: 'a', team_num: 3 }, { tick: t, steamid: 'b', team_num: 3 }, { tick: t, steamid: 'quitter', team_num: 3 },
      { tick: t, steamid: 'x', team_num: 2 }, { tick: t, steamid: 'y', team_num: 2 });
  }
  addLeavers(teams, [{ steamid: 'a' }, { steamid: 'quitter' }, { steamid: 'ghost' }], samples);
  assert.deepEqual(teams[0].players, ['a', 'b', 'quitter']);
  assert.ok(!teams[1].players.includes('quitter'));
});
