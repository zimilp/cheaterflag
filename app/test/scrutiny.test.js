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

test('bomb reads: rotating to the plant site with no information', () => {
  const { bombReads, DEEP } = require('../lib/demoScan');
  const mk = (seenNearSite, planterSeenFar) => {
    const samples = [], plants = [], roundStarts = [];
    for (let r = 0; r < 4; r++) {
      const F = r * 10000 + 1000, P = F + 40 * 64;
      roundStarts.push(F);
      plants.push({ tick: P, user_steamid: 't1' });
      for (let t = F; t <= P; t += 4) {
        const k = (t - F) / (P - F);
        samples.push({ tick: t, steamid: 'me', team_num: 3, is_alive: true, X: 3000 - 2500 * k, Y: 0, approximate_spotted_by: [] });
        // planter: walks to the site at (0,0) from far away; optionally seen far away (a "fake") or near the site early
        const far = { X: -3000 + 3000 * k, Y: 0 };
        const spotted = (seenNearSite && k > 0.1) || (planterSeenFar && k < 0.2) ? ['me'] : [];
        const pos = seenNearSite ? { X: 500, Y: 0 } : far;
        samples.push({ tick: t, steamid: 't1', team_num: 2, is_alive: true, ...pos, approximate_spotted_by: spotted });
      }
    }
    return { samples, plants, roundStarts, beginPlants: [] };
  };
  const cheat = bombReads(mk(false, true), 'me', DEEP);
  assert.equal(cheat.away, 4);
  assert.equal(cheat.reads, 4);
  assert.equal(cheat.fakeReads, 4);
  const legit = bombReads(mk(true, false), 'me', DEEP);   // T seen at the site early -> rotating is just reacting
  assert.equal(legit.reads, 0);
});

test('bomb reads: someone who goes to the same site every round is not flagged', () => {
  const { bombReads, DEEP } = require('../lib/demoScan');
  const A = { X: 0, Y: 0 }, B = { X: 0, Y: 4000 };
  const samples = [], plants = [], roundStarts = [];
  for (let r = 0; r < 10; r++) {
    const F = r * 10000 + 1000, P = F + 45 * 64, site = r % 2 ? A : B;
    roundStarts.push(F); plants.push({ tick: P, user_steamid: 't1' });
    for (let t = F; t <= P; t += 4) {
      const k = Math.min(1, (t - F) / (35 * 64));
      samples.push({ tick: t, steamid: 'me', team_num: 3, is_alive: true, X: 3500 - 3500 * k, Y: 2000 + 2000 * k, approximate_spotted_by: [] });  // always walks to B
      samples.push({ tick: t, steamid: 't1', team_num: 2, is_alive: true, X: site.X + 3000 * (1 - (t - F) / (P - F)), Y: site.Y - 3000, approximate_spotted_by: [] });
    }
    samples.push({ tick: P, steamid: 't1', team_num: 2, is_alive: true, X: site.X, Y: site.Y, approximate_spotted_by: [] });
  }
  const res = bombReads({ samples, plants, roundStarts, beginPlants: [] }, 'me', DEEP);
  assert.ok(res.wrong >= 3, 'went to B when the bomb was at A');
  const flagged = res.reads >= DEEP.bombReads && res.reads / res.away >= DEEP.bombReadRate && res.unusual >= DEEP.bombUnusual && res.reads >= DEEP.bombWrongRatio * res.wrong;
  assert.equal(flagged, false);
});

test('mechanics: triggerbot, no-recoil, spinbot and bhop', () => {
  const { mechanicsChecks, DEEP } = require('../lib/demoScan');
  const deaths = [], killWindows = [], fires = [], fireRows = [], samples = [], jumps = [];
  // 6 kills: crosshair sweeps onto the enemy at tick K-10 and fires that same tick
  for (let k = 0; k < 6; k++) {
    const K = 2000 + k * 1000, vid = 'v' + k;
    deaths.push({ tick: K, attacker_steamid: 'me', user_steamid: vid, weapon: 'ak47' });
    fires.push({ tick: K - 10, user_steamid: 'me', weapon: 'ak47' });
    for (let t = K - 96; t <= K; t++) {
      const yaw = t < K - 10 ? 20 - (t - (K - 30)) * 1.0 : 0;      // sweeping 1°/tick, lands on 0° at K-10
      killWindows.push({ tick: t, steamid: 'me', X: 0, Y: 0, Z: 0, pitch: 0, yaw: Math.max(yaw, 0) }, { tick: t, steamid: vid, X: 1000, Y: 0, Z: 8 });
    }
  }
  // 5 sprays of 8 shots with perfectly cancelled recoil
  for (let sp = 0; sp < 5; sp++) for (let i = 0; i < 8; i++) {
    const t = 20000 + sp * 500 + i * 6;
    fires.push({ tick: t, user_steamid: 'me', weapon: 'ak47' });
    fireRows.push({ tick: t, steamid: 'me', pitch: 5 - 2 * (-0.4 * i), yaw: 0, aim_punch_angle: [-0.4 * i, 0, 0] });
  }
  // a spin: 120°/tick for 40 ticks; and 4 chains of 9 hops 40 ticks apart at 400 u/s (speed a human can't reach)
  for (let t = 30000; t < 30040; t += 4) samples.push({ tick: t, steamid: 'me', is_alive: true, pitch: 0, yaw: (t * 25) % 360, X: 0, Y: 0 });
  for (let c = 0; c < 4; c++) for (let j = 0; j < 9; j++) {
    const t = 40000 + c * 2000 + j * 40;
    jumps.push({ tick: t, user_steamid: 'me' });
    samples.push({ tick: t - 4, steamid: 'me', is_alive: true, pitch: 0, yaw: 0, X: (t - 4) * 400 / 64, Y: 0 }, { tick: t, steamid: 'me', is_alive: true, pitch: 0, yaw: 0, X: t * 400 / 64, Y: 0 });
  }
  const r = mechanicsChecks({ deaths, killWindows, fires, fireRows, samples, jumps, roundStarts: [0] }, 'me', DEEP);
  assert.equal(r.trigEligible, 6); assert.equal(r.trig, 6);
  assert.equal(r.sprays, 5); assert.equal(r.stillSprays, 5);
  assert.equal(r.spinRuns, 1);
  assert.equal(r.bhopChains, 4);
});

test('mechanics: normal play is not flagged', () => {
  const { mechanicsChecks } = require('../lib/demoScan');
  const fires = [], fireRows = [], samples = [];
  for (let sp = 0; sp < 5; sp++) for (let i = 0; i < 8; i++) {
    const t = 20000 + sp * 500 + i * 6;
    fires.push({ tick: t, user_steamid: 'me', weapon: 'ak47' });
    fireRows.push({ tick: t, steamid: 'me', pitch: 5 + 0.8 * i + Math.sin(i * 3) * 0.6, yaw: 0, aim_punch_angle: [-0.4 * i, 0, 0] });   // pulls down, imperfectly
  }
  for (let t = 0; t < 400; t += 4) samples.push({ tick: t, steamid: 'me', is_alive: true, pitch: 10, yaw: (t * 3) % 360, X: t, Y: 0 });   // normal turning
  const r = mechanicsChecks({ deaths: [], killWindows: [], fires, fireRows, samples, jumps: [], roundStarts: [0] }, 'me');
  assert.equal(r.stillSprays, 0); assert.equal(r.spinRuns, 0); assert.equal(r.rageTicks, 0); assert.equal(r.bhopChains, 0);
});

test('"how did I die?" notes odd kills on each victim', () => {
  const { analyze } = require('../lib/demoScan');
  const r = analyze({ players: [{ steamid: 'a', name: 'A' }, { steamid: 'v', name: 'V' }], roundStarts: [0], samples: [], killWindows: [],
    deaths: [{ tick: 500, attacker_steamid: 'a', user_steamid: 'v', weapon: 'ak47', thrusmoke: true }, { tick: 900, attacker_steamid: 'a', user_steamid: 'v', weapon: 'ak47' }] });
  const v = r.find((x) => x.steamid === 'v');
  assert.equal(v.deathsTotal, 2);
  assert.equal(v.oddDeaths.length, 1);
  assert.deepEqual(v.oddDeaths[0].reasons, ['through smoke']);
});
