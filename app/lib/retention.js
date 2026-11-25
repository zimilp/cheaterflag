'use strict';
// Demo retention: flagged demos are kept 14 days (for review). Clean demos are kept for the number of
// days chosen in Settings (0 = delete right after scanning). Only touches CheaterFlag's own demo folders.
const fs = require('fs');
const path = require('path');

const FLAGGED_DAYS = 14;

function safeUnlink(p) { try { fs.unlinkSync(p); return true; } catch (_) { return false; } }

/** After a scan: flagged -> flaggedDir; clean -> cleanDir (if keeping clean demos) or deleted. Returns the kept path or null. */
function afterScan(demoPath, flaggedDir, flagged, cleanDir = null) {
  const dir = flagged ? flaggedDir : cleanDir;
  if (!dir) { safeUnlink(demoPath); return null; }
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, path.basename(demoPath));
  if (dest !== demoPath) fs.renameSync(demoPath, dest);
  return dest;
}

function sweepDir(dir, cutoff, removed) {
  if (!dir || !fs.existsSync(dir)) return;
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    if (/\.dem$/i.test(f) && fs.statSync(p).mtimeMs < cutoff && safeUnlink(p)) removed.push(p);
  }
}

/** Total size (bytes) and count of demo files in the given folders. */
function usage(dirs) {
  let bytes = 0, count = 0;
  for (const d of dirs) {
    if (!d || !fs.existsSync(d)) continue;
    for (const f of fs.readdirSync(d)) if (/\.dem$/i.test(f)) { try { bytes += fs.statSync(path.join(d, f)).size; count++; } catch (_) {} }
  }
  return { bytes, count };
}

/** Delete flagged demos older than 14 days and any leftover temp/unflagged files. */
function sweep(demoDir, flaggedDir, now = Date.now(), days = FLAGGED_DAYS, extraDirs = [], cleanDir = null, cleanDays = 0) {
  const removed = [];
  const cutoff = now - days * 86400000;
  if (fs.existsSync(flaggedDir)) {
    for (const f of fs.readdirSync(flaggedDir)) {
      const p = path.join(flaggedDir, f);
      if (fs.statSync(p).mtimeMs < cutoff && safeUnlink(p)) removed.push(p);
    }
  }
  sweepDir(cleanDir, now - cleanDays * 86400000, removed);   // clean demos past their keep period
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

module.exports = { afterScan, sweep, usage, FLAGGED_DAYS };
