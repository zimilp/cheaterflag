'use strict';
// Demo retention: unflagged demos are deleted right after scanning; flagged demos are kept
// for 14 days (for review) and then deleted. Only touches CheaterFlag's own demo folders.
const fs = require('fs');
const path = require('path');

const FLAGGED_DAYS = 14;

function safeUnlink(p) { try { fs.unlinkSync(p); return true; } catch (_) { return false; } }

/** After a scan: keep the demo only if someone was flagged. Returns the kept path or null. */
function afterScan(demoPath, flaggedDir, flagged) {
  if (!flagged) { safeUnlink(demoPath); return null; }
  fs.mkdirSync(flaggedDir, { recursive: true });
  const dest = path.join(flaggedDir, path.basename(demoPath));
  fs.renameSync(demoPath, dest);
  return dest;
}

/** Delete flagged demos older than 14 days and any leftover temp/unflagged files. */
function sweep(demoDir, flaggedDir, now = Date.now(), days = FLAGGED_DAYS, extraDirs = []) {
  const removed = [];
  const cutoff = now - days * 86400000;
  if (fs.existsSync(flaggedDir)) {
    for (const f of fs.readdirSync(flaggedDir)) {
      const p = path.join(flaggedDir, f);
      if (fs.statSync(p).mtimeMs < cutoff && safeUnlink(p)) removed.push(p);
    }
  }
  for (const d of extraDirs) {           // copies placed in CS2's folder for "Watch in CS2"
    if (!d || !fs.existsSync(d)) continue;
    for (const f of fs.readdirSync(d)) {
      const p = path.join(d, f);
      if (/\.dem$/i.test(f) && fs.statSync(p).mtimeMs < cutoff && safeUnlink(p)) removed.push(p);
    }
  }
  if (fs.existsSync(demoDir)) {
    for (const f of fs.readdirSync(demoDir)) {
      const p = path.join(demoDir, f);
      // leftovers older than 1 hour (e.g. app closed mid-scan)
      if (fs.statSync(p).isFile() && fs.statSync(p).mtimeMs < now - 3600000 && safeUnlink(p)) removed.push(p);
    }
  }
  return removed;
}

module.exports = { afterScan, sweep, FLAGGED_DAYS };
