'use strict';
// Every file must at least load: a syntax error in the main process stops the app (and its updater) from starting.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const files = ['bootstrap.js', 'main.js', 'preload.js', 'scanWorker.js', 'renderer/app.js', 'renderer/roles.js', ...fs.readdirSync(path.join(root, 'lib')).filter((f) => f.endsWith('.js')).map((f) => 'lib/' + f)];
for (const f of files) {
  test('syntax ok: ' + f, () => {
    assert.doesNotThrow(() => execFileSync(process.execPath, ['--check', path.join(root, f)], { stdio: 'pipe' }));
  });
}
