'use strict';
// Runs in an Electron utility process so demo parsing never freezes the app.
const { scanDemo } = require('./lib/demoScan');

process.parentPort.on('message', (e) => {
  const { id, demoPath } = e.data;
  try {
    process.parentPort.postMessage({ id, ok: true, scan: scanDemo(demoPath) });
  } catch (err) {
    process.parentPort.postMessage({ id, ok: false, error: String(err && err.message || err) });
  }
});
