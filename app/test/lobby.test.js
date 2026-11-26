'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { extractStatusNames, isMatchStart, extractConnectedNames } = require('../lib/lobbyScanner');

// real CS2 output (Nov 2026), as written to console.log, plus the same over netcon (no timestamp)
const LOG = `11/26 10:10:55 [Client] players  : 10 humans, 0 bots (0 max) (not hibernating) (unreserved)
11/26 10:10:55 [Client] ---------spawngroups----
11/26 10:10:55 [Client] loaded spawngroup(  1)  : SV:  [1: de_mirage | main lump | mapload]
11/26 10:10:55 [Client] ---------players--------
11/26 10:10:55 [Client]   id     time ping loss      state   rate name
11/26 10:10:55 [Client]    0    00:54    0    0     active 786432 loopback:0 'cfab'
11/26 10:10:55 [Client]    3    41:02   31    0     active 786432 'Bluebird'
11/26 10:10:55 [Client]    4  1:02:13   45    0     active 786432 'it''s me'
11/26 10:10:55 [Client] 65535 [NO TIME]   0    0 challenging      0unknown ''
11/26 10:10:55 [Client] #end`;

test('status names with CS2 prefixes', () => {
  assert.deepEqual(extractStatusNames(LOG), ['cfab', 'Bluebird', "it''s me"]);
  const netcon = LOG.split('\n').map((l) => l.replace(/^\d\d\/\d\d [\d:]+ /, '')).join('\n');
  assert.deepEqual(extractStatusNames(netcon), ['cfab', 'Bluebird', "it''s me"]);
});

test('status replies do not look like a new match', () => {
  for (const l of LOG.split('\n')) assert.equal(isMatchStart(l), false, l);
  assert.equal(isMatchStart('11/26 09:23:00 [Client] Map: "<empty>"'), false);
  assert.equal(isMatchStart('11/26 09:42:16 [HostStateManager] Host activate: Remote Connect (=[A:1:4118346762:52697])'), true);
});

test('names from "connected" lines in console.log (real CS2 output)', () => {
  const log = `11/26 12:01:10 [HostStateManager] Host activate: Remote Connect (=[A:1:1:2])
11/26 12:01:11 cfab connected
11/26 12:01:11 The Dapper Frog connected
11/26 12:01:12 1/2 Gallon de Chicha connected
11/26 12:01:12 Client:  Connected [loopback:1] [last packet 0.014 sec ago]
11/26 12:01:12 [Networking] server @ =[A:1:1:2]:  NetChan Setting Timeout to 30.00 seconds`;
  assert.deepEqual(extractConnectedNames(log), ['cfab', 'The Dapper Frog', '1/2 Gallon de Chicha']);
});

test('rejoining the same server keeps the player list', () => {
  const { LobbyScanner } = require('../lib/lobbyScanner');
  const l = new LobbyScanner({ ownName: 'cfab' });
  let last = [];
  l.on('names', (_f, all) => { last = all; });
  l.pollNetcon = () => {};
  l.feed(`11/26 12:09:28 [HostStateManager] Host activate: Remote Connect (=[A:1:2537009174:52699])
11/26 12:09:29 cfab connected
11/26 12:09:29 Xinhai connected
11/26 12:09:30 freeman connected`);
  l.feed(`11/26 12:23:12 [HostStateManager] Host activate: Idle (levelload)
11/26 12:23:43 [HostStateManager] Host activate: Remote Connect (=[A:1:2537009174:52699])
11/26 12:23:44 cfab connected`);
  assert.deepEqual(last, ['Xinhai', 'freeman']);
  assert.equal(l.names.size, 2);
  l.feed(`11/26 13:00:00 [HostStateManager] Host activate: Remote Connect (=[A:1:999:1])
11/26 13:00:01 Rook connected`);
  assert.deepEqual(last, ['Rook']);
});
