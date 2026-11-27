'use strict';
// Runs in an Electron utility process so demo parsing never freezes the app.
const { scanDemo, deepScan } = require('./lib/demoScan');
const { parseStats } = require('./lib/matchStats');
const replay = require('./lib/replay');

process.parentPort.on('message', (e) => {
  const { id, demoPath, deep, statsOnly } = e.data;
  if (e.data.replay) {   // in-app 2D replay of one moment
    try {
      const { tick, focus, bg } = e.data.replay;
      const background = bg || replay.demoBackground(demoPath);
      process.parentPort.postMessage({ id, ok: true, scan: { replay: replay.buildReplay(demoPath, tick, focus, background), bg: background } });
    } catch (err) { process.parentPort.postMessage({ id, ok: false, error: String(err && err.message || err) }); }
    return;
  }
  try {
    process.parentPort.postMessage({ id, ok: true, scan: statsOnly ? (() => { const m = parseStats(demoPath); return { stats: Object.fromEntries([...m].map(([id, x]) => [id, { ...x }])), highlights: Object.fromEntries([...m].map(([id, x]) => [id, x.highlights || []])) }; })() : deep ? deepScan(demoPath, deep) : scanDemo(demoPath) });
  } catch (err) {
    process.parentPort.postMessage({ id, ok: false, error: String(err && err.message || err) });
  }
});
