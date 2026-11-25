'use strict';
// Runs in an Electron utility process so demo parsing never freezes the app.
const { scanDemo, deepScan } = require('./lib/demoScan');

process.parentPort.on('message', (e) => {
  const { id, demoPath, deep } = e.data;
  try {
    process.parentPort.postMessage({ id, ok: true, scan: deep ? deepScan(demoPath, deep) : scanDemo(demoPath) });
  } catch (err) {
    process.parentPort.postMessage({ id, ok: false, error: String(err && err.message || err) });
  }
});
