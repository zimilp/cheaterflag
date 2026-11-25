'use strict';
// CheaterFlag demo-link bot. Signs in to the spare Steam account, connects to CS2's game
// coordinator (never launches the game), and turns match share codes into demo download links.
// Reads BOT_USERNAME, BOT_PASSWORD, BOT_SECRET, WORKER_URL from ../secrets.env
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const SteamUser = require('steam-user');
const GlobalOffensive = require('globaloffensive');
const { decodeMatchShareCode } = require('csgo-sharecode');

function loadEnv(file) {
  const env = {};
  if (!fs.existsSync(file)) return env;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return env;
}

const env = { ...loadEnv(path.join(__dirname, '..', 'secrets.env')), ...process.env };
const DATA = path.join(__dirname, 'data');
const TOKEN_FILE = path.join(DATA, 'refresh-token.txt');
fs.mkdirSync(DATA, { recursive: true });

for (const k of ['BOT_USERNAME', 'WORKER_URL', 'BOT_SECRET']) {
  if (!env[k]) { console.error(`Missing ${k} in secrets.env`); process.exit(1); }
}
const WORKER = env.WORKER_URL.replace(/\/$/, '');
const log = (...a) => console.log(new Date().toISOString(), ...a);
const ask = (q) => new Promise((r) => { const rl = readline.createInterface({ input: process.stdin, output: process.stdout }); rl.question(q, (a) => { rl.close(); r(a.trim()); }); });

const client = new SteamUser({ renewRefreshTokens: true });
const csgo = new GlobalOffensive(client);

client.on('steamGuard', async (domain, callback, lastCodeWrong) => {
  if (lastCodeWrong) log('That Steam Guard code was wrong - try the newest code.');
  if (domain) {
    callback(await ask(`Steam Guard code (emailed to ${domain}): `));
  } else {
    console.log('\nThe bot account uses the Steam Mobile app. Either:');
    console.log('  A) open the Steam app on your phone -> tap the shield icon (Steam Guard) at the bottom,');
    console.log('     make sure the BOT account is selected (tap your avatar to switch), and type the 5-letter code here, or');
    console.log('  B) approve the sign-in request in the app, then press Enter here.\n');
    let code = await ask('Code (or just press Enter after approving): ');
    while (!code) {
      log('Waiting up to 20 seconds for the approval...');
      await new Promise((r) => setTimeout(r, 20000));
      if (client.steamID) return; // approval worked
      code = await ask('Approval did not come through. Type the 5-letter code from the Steam app instead: ');
    }
    callback(code.toUpperCase());
  }
});
client.on('refreshToken', (t) => { fs.writeFileSync(TOKEN_FILE, t); log('Saved login token — no password or code needed next time.'); });
client.on('loggedOn', () => { log('Signed in to Steam as the bot account.'); client.gamesPlayed([730]); setTimeout(() => { if (!csgo.haveGCSession) log('Still connecting to CS2 servers...'); }, 20000); });
client.on('error', (e) => { log('Steam error:', e.message); if (/InvalidPassword|AccessDenied/.test(e.message)) try { fs.unlinkSync(TOKEN_FILE); } catch (_) {} setTimeout(logOn, 60000); });
client.on('disconnected', (_r, msg) => log('Disconnected from Steam:', msg));
csgo.on('connectedToGC', () => log('Connected to the CS2 game coordinator.'));
csgo.on('disconnectedFromGC', (r) => log('Game coordinator disconnected:', r));

function logOn() {
  if (fs.existsSync(TOKEN_FILE)) client.logOn({ refreshToken: fs.readFileSync(TOKEN_FILE, 'utf8').trim() });
  else {
    if (!env.BOT_PASSWORD) { console.error('Missing BOT_PASSWORD in secrets.env'); process.exit(1); }
    client.logOn({ accountName: env.BOT_USERNAME, password: env.BOT_PASSWORD });
  }
}

function resolveShareCode(code) {
  return new Promise((resolve, reject) => {
    let matchId;
    try { matchId = decodeMatchShareCode(code).matchId.toString(); } catch (e) { return reject(new Error('Invalid share code')); }
    const timer = setTimeout(() => { csgo.removeListener('matchList', onList); reject(new Error('Game coordinator did not answer')); }, 30000);
    function onList(matches) {
      const m = (matches || []).find((x) => String(x.matchid) === matchId);
      if (!m) return;
      clearTimeout(timer); csgo.removeListener('matchList', onList);
      const stats = m.roundstatsall || [];
      const url = stats.length ? stats[stats.length - 1].map : null;
      url ? resolve(url) : reject(new Error('Valve has no demo for this match (expired?)'));
    }
    csgo.on('matchList', onList);
    csgo.requestGame(code);
  });
}

async function worker(method, route, body) {
  const r = await fetch(WORKER + route, { method, headers: { 'content-type': 'application/json', 'x-bot-secret': env.BOT_SECRET }, body: body ? JSON.stringify(body) : undefined });
  if (!r.ok) throw new Error(`Service ${r.status}: ${await r.text()}`);
  return r.json();
}

async function poll() {
  if (!csgo.haveGCSession) return;
  try {
    const { jobs } = await worker('GET', '/bot/jobs');
    for (const j of jobs) {
      try {
        const url = await resolveShareCode(j.share_code);
        await worker('POST', `/bot/jobs/${j.id}`, { url });
        log('Demo link found for', j.share_code);
      } catch (e) {
        await worker('POST', `/bot/jobs/${j.id}`, { error: e.message });
        log('Failed', j.share_code, '-', e.message);
      }
      await new Promise((r) => setTimeout(r, 2000)); // be gentle with Valve
    }
  } catch (e) { log('Poll error:', e.message); }
}

// test mode: node index.js CSGO-xxxxx-xxxxx-xxxxx-xxxxx-xxxxx
const testCode = process.argv[2];
csgo.on('connectedToGC', async () => {
  if (!testCode) return;
  try { log('Demo URL:', await resolveShareCode(testCode)); } catch (e) { log('Test failed:', e.message); }
  process.exit(0);
});

logOn();
if (!testCode) setInterval(poll, 10000);
