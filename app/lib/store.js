'use strict';
// Tiny JSON settings store in the app's user-data folder.
const fs = require('fs');
const path = require('path');

class Store {
  constructor(dir, defaults = {}) {
    this.file = path.join(dir, 'settings.json');
    this.data = { ...defaults };
    try { Object.assign(this.data, JSON.parse(fs.readFileSync(this.file, 'utf8'))); } catch (_) {}
  }
  get(k) { return this.data[k]; }
  set(patch) {
    Object.assign(this.data, patch);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
  }
  all() { return { ...this.data }; }
}

module.exports = { Store };
