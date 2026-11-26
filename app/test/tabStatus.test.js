'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const tab = require('../lib/tabStatus');

test('TAB player list: cfg on/off, autoexec runs it once, user lines kept', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs2-'));
  fs.mkdirSync(path.join(dir, 'cfg'));
  fs.writeFileSync(path.join(dir, 'cfg', 'autoexec.cfg'), 'cl_radar_scale 0.4');
  tab.apply(dir, true);
  tab.apply(dir, true);
  const auto = fs.readFileSync(path.join(dir, 'cfg', 'autoexec.cfg'), 'utf8');
  assert.equal(auto, 'cl_radar_scale 0.4\nexec cheaterflag\n');
  assert.match(fs.readFileSync(path.join(dir, 'cfg', 'cheaterflag.cfg'), 'utf8'), /bind "TAB" "\+cf_scores"/);
  tab.apply(dir, false, true);
  assert.match(fs.readFileSync(path.join(dir, 'cfg', 'cheaterflag.cfg'), 'utf8'), /bind "TAB" "\+showscores"/);
  tab.apply(dir, false, false);
  assert.doesNotMatch(fs.readFileSync(path.join(dir, 'cfg', 'cheaterflag.cfg'), 'utf8'), /bind/);
});
