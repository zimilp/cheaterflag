'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { computeStats, awards } = require('../lib/matchStats');

// one round: T team a1..a3 vs CT b1..b2. b1 entry-kills a1 (a2 standing next to a1, no trade),
// a3 kills b1 (trade? no: 10 s later), b2 kills a2, a3 alone vs b2 -> kills b2 -> clutch 1v1 won by T.
function round() {
  const players = ['a1', 'a2', 'a3', 'b1', 'b2'].map((s) => ({ steamid: s, name: s }));
  const team = { a1: 2, a2: 2, a3: 2, b1: 3, b2: 3 };
  const pos = { a1: [0, 0], a2: [100, 0], a3: [3000, 0], b1: [500, 0], b2: [600, 0] };
  const samples = [];
  for (let t = 0; t <= 4000; t += 8) for (const p of players) samples.push({ tick: t, steamid: p.steamid, X: pos[p.steamid][0] + (p.steamid === 'a3' ? t / 8 : 0), Y: pos[p.steamid][1], is_alive: true, team_num: team[p.steamid] });
  const deaths = [
    { tick: 1000, attacker_steamid: 'b1', user_steamid: 'a1', weapon: 'ak47', headshot: true, assister_steamid: 'b2', assistedflash: true },
    { tick: 1700, attacker_steamid: 'a3', user_steamid: 'b1', weapon: 'awp', penetrated: 1 },
    { tick: 2000, attacker_steamid: 'b2', user_steamid: 'a2', weapon: 'm4a1' },
    { tick: 2100, attacker_steamid: 'a3', user_steamid: 'b2', weapon: 'knife' },
  ];
  return {
    players, deaths, samples, roundStarts: [500], roundEnds: [{ tick: 2200, winner: 'T' }],
    hurts: [{ tick: 900, attacker_steamid: 'a1', user_steamid: 'b1', dmg_health: 40, weapon: 'hegrenade' }, { tick: 950, attacker_steamid: 'a2', user_steamid: 'a1', dmg_health: 10, weapon: 'glock' }],
    blinds: [{ tick: 800, attacker_steamid: 'a2', user_steamid: 'a1', blind_duration: 3.2 }, { tick: 800, attacker_steamid: 'b2', user_steamid: 'a1', blind_duration: 2 }],
    plants: [], defuses: [],
  };
}

test('fun stats: entry, clutch, utility, team flash, weapons', () => {
  const s = computeStats(round());
  const g = (id) => s.get(id);
  assert.equal(g('b1').entryKills, 1);
  assert.equal(g('a1').firstDeaths, 1);
  assert.equal(g('a3').clutchWins, 1);
  assert.equal(g('a3').bestClutch, 1);
  assert.equal(g('a3').kills, 2);
  assert.equal(g('a3').awpKills, 1);
  assert.equal(g('a3').knifeKills, 1);
  assert.equal(g('a3').wallbangs, 1);
  assert.equal(g('b2').flashAssists, 1);
  assert.equal(g('a1').utilDamage, 40);
  assert.equal(g('a2').damage, 0);              // team damage doesn't count
  assert.equal(g('a2').teamFlashSecs, 3.2);
  assert.equal(g('b2').enemiesFlashed, 1);
  assert.equal(g('b1').saves + g('b2').saves, 0);
  assert.ok(g('a3').distance > 0);
  const aw = awards(s, new Set(['a1', 'a2', 'a3']));
  assert.ok(aw.get('a3').includes('clutcher'));
  assert.ok(!aw.has('b1'));                     // only members get awards
  for (const id of ['a1', 'a2', 'a3']) assert.ok(aw.get(id) && aw.get(id).length >= 1, id + ' has an award');
});
