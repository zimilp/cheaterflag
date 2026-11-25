import test from 'node:test';
import assert from 'node:assert';
import { computeTier } from '../src/vetting.js';

const NOW = 1_800_000_000;
const clean = {
  bans: { CommunityBanned: false, NumberOfVACBans: 0, NumberOfGameBans: 0, DaysSinceLastBan: 0 },
  summary: { communityvisibilitystate: 3, timecreated: NOW - 5 * 365 * 86400 },
  cs2Minutes: 1500 * 60,
};

test('clean established account is approved', () => {
  assert.equal(computeTier(clean, NOW).tier, 'approved');
});
test('recent VAC ban is rejected, old ban is limited', () => {
  assert.equal(computeTier({ ...clean, bans: { ...clean.bans, NumberOfVACBans: 1, DaysSinceLastBan: 30 } }, NOW).tier, 'rejected');
  assert.equal(computeTier({ ...clean, bans: { ...clean.bans, NumberOfVACBans: 1, DaysSinceLastBan: 2000 } }, NOW).tier, 'limited');
});
test('new, private, or low-hours accounts are limited', () => {
  assert.equal(computeTier({ ...clean, summary: { ...clean.summary, timecreated: NOW - 30 * 86400 } }, NOW).tier, 'limited');
  assert.equal(computeTier({ ...clean, summary: { communityvisibilitystate: 1 }, cs2Minutes: null }, NOW).tier, 'limited');
  assert.equal(computeTier({ ...clean, cs2Minutes: 20 * 60 }, NOW).tier, 'limited');
});
test('blacklist rejects; admin override wins over everything', () => {
  assert.equal(computeTier({ ...clean, blacklisted: { category: 'Wallhack', reason: 'demo' } }, NOW).tier, 'rejected');
  assert.equal(computeTier({ ...clean, blacklisted: { category: 'x', reason: 'y' }, override: { tier: 'approved', note: 'appeal ok' } }, NOW).tier, 'approved');
});

test('ban reasons explain the ban type and age', () => {
  const r = computeTier({ ...clean, bans: { ...clean.bans, NumberOfVACBans: 1, DaysSinceLastBan: 45 } }, NOW);
  assert.equal(r.tier, 'rejected');
  assert.match(r.reasons[0], /1 VAC ban \(45 days ago\): caught by Valve Anti-Cheat/);
  const g = computeTier({ ...clean, bans: { ...clean.bans, NumberOfGameBans: 2, DaysSinceLastBan: 900 } }, NOW);
  assert.equal(g.tier, 'limited');
  assert.match(g.reasons[0], /2 game bans \(2\.5 years ago\): banned by a game's developer/);
  const e = computeTier({ ...clean, bans: { ...clean.bans, EconomyBan: 'banned' } }, NOW);
  assert.match(e.reasons[0], /trade ban/);
});
