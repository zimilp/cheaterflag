'use strict';
const test = require('node:test');
const assert = require('node:assert');
const B = require('../renderer/balance');
const Roles = require('../renderer/roles');

// a player with `r` rounds of stats at a given strength (1 = average)
function row(id, strength, { awp = false, util = 1, matches = 30, rounds = 600 } = {}) {
  const d = { rounds, kills: rounds * 0.7 * strength, deaths: rounds * 0.68 / strength, damage: rounds * 80 * strength, assists: rounds * 0.15,
    entryKills: rounds * 0.1, firstDeaths: rounds * 0.1, trades: rounds * 0.08, flashAssists: rounds * 0.05 * util, enemiesFlashed: rounds * 0.3 * util,
    utilDamage: rounds * 5 * util, clutchWins: 3, clutchAttempts: 12, awpKills: awp ? rounds * 0.3 : 0, roundsT: rounds / 2, roundsCT: rounds / 2,
    wins: matches / 2, losses: matches / 2 };
  return { steamid: id, name: 'P' + id, matches, fullMatches: matches, full: d, all: d };
}

test('ratings: stronger stats give a higher rating, few rounds stay near average', () => {
  const strong = B.ratingOf(row('1', 1.3).full).value, weak = B.ratingOf(row('2', 0.75).full).value;
  assert.ok(strong > 1.1 && weak < 0.9, `${strong} ${weak}`);
  assert.equal(B.ratingOf({ rounds: 10 }), null);
  const fewRounds = B.ratingOf(row('3', 1.5, { rounds: 30 }).full).value;
  assert.ok(fewRounds < strong, 'little data is pulled towards average');
});

test('balance: ten players split into close teams, AWPers and IGLs apart, ping spread', () => {
  const strengths = [1.45, 1.3, 1.2, 1.1, 1.0, 1.0, 0.95, 0.9, 0.8, 0.7];
  const players = strengths.map((s, i) => {
    const r = row(String(i), s, { awp: i === 0 || i === 1, util: i === 4 || i === 6 ? 3 : 1, matches: i === 4 || i === 6 ? 60 : 20 });
    return { ...B.profile(r.name, r.steamid, r, r, Roles), ping: { iad: i < 5 ? 20 : 60, ord: 40 } };
  });
  const res = B.balance(players, 'iad');
  assert.equal(res.A.players.length, 5);
  assert.ok(Math.abs(res.A.skill - res.B.skill) < 0.05, `${res.A.skill} vs ${res.B.skill}`);
  assert.ok(res.winA >= 40 && res.winA <= 60);
  const team = (id) => (res.A.players.some((p) => p.steamid === id) ? 'A' : 'B');
  assert.notEqual(team('0'), team('1'), 'the two AWPers are split');
  assert.notEqual(team('4'), team('6'), 'the two best IGLs are split');
  assert.ok(['4', '6'].includes(res.A.igl) && ['4', '6'].includes(res.B.igl));
  assert.ok(Math.abs(res.A.ping - res.B.ping) <= 16, 'high-ping players are spread');
  assert.ok(res.A.players.every((p) => p.reason.length > 5));
});

test('balance: guests without stats count as average; needs exactly 10', () => {
  const ppl = Array.from({ length: 10 }, (_, i) => B.profile('G' + i, null, null, null, Roles));
  assert.equal(B.balance(ppl, null).A.players[0].skill, 1);
  assert.throws(() => B.balance(ppl.slice(0, 9), null));
});

test('regions: the fairest server is the one with the lowest worst ping', () => {
  const ppl = [{ ping: { iad: 20, ord: 45 } }, { ping: { iad: 90, ord: 50 } }];
  assert.equal(B.rankRegions(ppl)[0].pop, 'ord');
});

test('ping: reads the average from Windows ping output', () => {
  const { parsePing } = require('../lib/ping');
  assert.equal(parsePing('Packets: Sent = 3, Received = 3\r\n    Minimum = 21ms, Maximum = 25ms, Average = 23ms'), 23);
  assert.equal(parsePing('Request timed out.'), null);
  assert.equal(parsePing('rtt min/avg/max/mdev = 20.1/22.6/25.0/1.2 ms'), 23);
});

test('map pick: a player strong on the chosen map is rated higher there (with enough rounds)', () => {
  const avg = row('9', 1.0), onNuke = row('9', 1.4, { rounds: 300 }), few = row('9', 1.4, { rounds: 30 });
  const base = B.profile('P', '9', avg, avg, Roles).skill;
  const withMap = B.profile('P', '9', avg, avg, Roles, onNuke, 'Nuke');
  assert.ok(withMap.skill > base + 0.05, `${withMap.skill} vs ${base}`);
  assert.match(withMap.why, /Nuke \d\.\d\d/);
  assert.equal(B.profile('P', '9', avg, avg, Roles, few, 'Nuke').skill, base, 'under 60 rounds on the map: ignored');
});
