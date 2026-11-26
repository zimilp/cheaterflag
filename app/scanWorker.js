'use strict';
// Runs in an Electron utility process so demo parsing never freezes the app.
const { scanDemo, deepScan } = require('./lib/demoScan');
const { parseStats } = require('./lib/matchStats');

process.parentPort.on('message', (e) => {
  const { id, demoPath, deep, statsOnly } = e.data;
  try {
    process.parentPort.postMessage({ id, ok: true, scan: statsOnly ? Object.fromEntries(parseStats(demoPath)) : deep ? deepScan(demoPath, deep) : scanDemo(demoPath) });
  } catch (err) {
    process.parentPort.postMessage({ id, ok: false, error: String(err && err.message || err) });
  }
});
