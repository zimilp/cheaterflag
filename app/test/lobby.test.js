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
  assert.equal(isMatchStart('11/26 08:47:38 ChangeGameUIState: CSGO_GAME_UI_STATE_MAINMENU -> CSGO_GAME_UI_STATE_LOADINGSCREEN'), true);
  assert.equal(isMatchStart('11/26 08:47:39 [Client] Map: "de_mirage"'), true);
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
