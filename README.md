# CheaterFlag (by ehbaah!)

Flags known and suspected CS2 cheaters in your matches. Free to run, nothing touches the CS2
process (no VAC risk): it only reads CS2's own console log / network console, Valve's match
demos, and the public Steam Web API.

## What's in here

| Folder | What it is | Runs on |
|---|---|---|
| `app/` | Windows tray app: Steam sign-in, lobby scanner, after-game demo scanner, report helper, review queue, blacklist, members, settings | Each player's PC |
| `worker/` | Shared service: sign-in check, ban/account vetting, trust tiers, blacklist, review queue, demo-job relay, daily member re-check | Cloudflare Workers + D1 (free) |
| `bot/` | Demo-link bot: turns match codes into demo download links using the spare Steam account | Your PC for now, later a free VM |

## One-time setup (admin only)

1. **Install tools + packages:** right-click `setup.ps1` → *Run with PowerShell*.
2. **Deploy the shared service:** run `deploy-worker.ps1`. A browser opens for Cloudflare sign-in.
   It creates the database, stores the secrets from `secrets.env` and writes the service URL into
   `secrets.env` and `app/config.json`.
3. **Start the bot:** `cd bot` → `npm start`. The first time, type the Steam Guard code emailed
   to the bot account. After that it stays signed in (token saved in `bot/data/`).
   Test one match: `node index.js CSGO-xxxxx-xxxxx-xxxxx-xxxxx-xxxxx`.
4. **Run the app:** `cd app` → `npm start`. Sign in through Steam — **the first person to sign in
   becomes the admin**, so do this before anyone else.
5. In the app's **Settings**, paste your game authentication code and most recent match code.
6. In Steam, CS2 → Properties → Launch Options: `-condebug -netconport 2121`.

## Releasing the installer for friends

1. Run `publish.ps1` (after `deploy-worker.ps1`). It pushes to github.com/zimilp/cheaterflag and tags the version.
2. GitHub Actions builds `CheaterFlag-Setup-0.1.0.exe` and attaches it to the Release.
   Installed apps auto-update from new releases. For an update: bump `version` in `app/package.json`, run `publish.ps1` again.

The installer isn't code-signed (a certificate costs money), so Windows shows
"Windows protected your PC" → **More info → Run anyway**.

## How detection works

- **Account vetting** (`worker/src/vetting.js`): VAC/game/community bans, account age, private
  profile, CS2 hours, blacklist, admin overrides → Clean / Caution / Flagged.
  Prime status is not exposed by the Steam API, so it isn't checked.
- **Demo scan** (`app/lib/demoScan.js`), strong evidence only — two independent signals or one extreme:
  - crosshair tracking a moving enemy that the game says you can't see (wallhack)
  - wallbang kills on enemies never spotted (wallhack)
  - 25°+ snap onto target within ~125 ms ending dead-on (aimbot)
  - median reaction under ~125 ms (aimbot)
  Thresholds are first guesses in `THRESHOLDS` — tune them on real demos before trusting them.
- **Retention:** unflagged demos are deleted right after scanning; flagged demos are kept 14 days.
- **Reports:** Valve has no way to send reports from outside the game, and automating it is how
  report bots work (bannable). The app tells you who, which category and which rounds — you click Report.

## Tests

`cd app && npm test` · `cd worker && npm test`
