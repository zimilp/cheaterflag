'use strict';
// CS2 no longer opens its network console (-netconport is ignored), and it only logs players who join
// AFTER you. To still see all 10, CheaterFlag can (opt-in) make the scoreboard key also run `status`:
// holding TAB then prints the full player list into console.log, which the Lobby tab reads.
// Only standard CS2 config commands (alias/bind) — nothing touches the game itself.
const fs = require('fs');
const path = require('path');

const CFG = 'cheaterflag.cfg';
// "Watch in CS2": a one-shot file cheaterflag.cfg runs at start-up. It holds `playdemo …` while a demo is waiting
// to be opened and is emptied again once CS2 has started, so normal launches are unaffected.
const WATCH = 'cheaterflag_watch.cfg';
const WATCH_IDLE = '// CheaterFlag: empty unless you clicked "Watch in CS2" (then it opens that demo once).\n';
const EXEC_WATCH = '\nexec cheaterflag_watch\n';
const ON = [
  '// CheaterFlag: holding TAB (scoreboard) also lists the players in the console, so the Lobby tab sees everyone.',
  '// Turn it off in CheaterFlag > Settings. Your scoreboard works exactly as before.',
  'alias "+cf_scores" "+showscores; status"',
  'alias "-cf_scores" "-showscores"',
  'bind "TAB" "+cf_scores"',
  '',
].join('\n');
const OFF = '// CheaterFlag: the TAB player list is off (CheaterFlag > Settings).\n';
const RESTORE = OFF + 'bind "TAB" "+showscores"\n';

/** Write cheaterflag.cfg (and make sure autoexec.cfg runs it too, for setups that already exec autoexec). */
function apply(cs2Dir, enabled, wasEnabled = false) {
  if (!cs2Dir) return false;
  const dir = path.join(cs2Dir, 'cfg');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, CFG), (enabled ? ON : wasEnabled ? RESTORE : OFF) + EXEC_WATCH);
  if (!fs.existsSync(path.join(dir, WATCH))) fs.writeFileSync(path.join(dir, WATCH), WATCH_IDLE);
  const auto = path.join(dir, 'autoexec.cfg');
  let text = '';
  try { text = fs.readFileSync(auto, 'utf8'); } catch (_) {}
  if (!/^\s*exec\s+"?cheaterflag"?\s*$/m.test(text)) fs.writeFileSync(auto, (text && !text.endsWith('\n') ? text + '\n' : text) + 'exec cheaterflag\n');
  return true;
}

/** Queue a demo to open when CS2 next starts (null clears it). */
function queueDemo(cs2Dir, demoName) {
  if (!cs2Dir) return false;
  const dir = path.join(cs2Dir, 'cfg');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, WATCH), demoName ? `// CheaterFlag: opens this demo once, then CheaterFlag empties this file.\nplaydemo cheaterflag/${demoName}\n` : WATCH_IDLE);
  return true;
}

module.exports = { apply, queueDemo, CFG, WATCH, ON, OFF, RESTORE };
