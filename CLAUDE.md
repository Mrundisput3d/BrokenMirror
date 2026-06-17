# BrokenMirror

Static site + Node tooling for a Lineage 2 alliance (CPs, schedules, attendance).
Hosted from this repo's root (see `CNAME`); the `*.html` files are the site, and
they read live data from a Firebase Realtime Database.

## Layout

- `*.html` — the static site (admin panel, hall of fame, schedule, market, etc.).
- `images/` — self-hosted assets.
- `scrape-regroups.js` — scrapes the avalanche regroup/respawn schedule and pushes
  it to Firebase (`regroups` node). Run with `npm run scrape` / `npm run push`.
- `discord-bot.js` — screenshot → attendance Discord bot (see below).

## Firebase

Realtime DB: `https://brokenmirrordb-default-rtdb.europe-west1.firebasedatabase.app`

Node tools authenticate with a service-account key (bypasses DB security rules).
The key is **gitignored** — never commit it. Point at it via
`GOOGLE_APPLICATION_CREDENTIALS`, or drop it at `serviceAccountKey.json`.

Relevant nodes:
- `cps/` — clan parties. Each has `leader`, comma-separated `members`, and a
  `clan` field (`clan === "history"` means inactive — skipped by the bot).
- `pendingScans` — queue the Discord bot writes confirmed attendance names to;
  the web Command Center consumes it.
- `regroups` — respawn/regroup schedule written by the scraper.

## Discord bot (`discord-bot.js`)

Members post Lineage 2 screenshots, then someone runs `!scan`. The bot scans
every screenshot posted since the most recent `UPDATED` divider, extracts the
character names (party panel, command-channel selected party, and the self/leader
status bar) with Gemini Vision, fuzzy-matches them against the active CP roster,
and posts one `<message-link> <caption>: name1, name2` line per screenshot (the
caption is the screenshot message's own text, omitted if it had none) with
a **Send to Panel** button. Pressing it pushes the names to `pendingScans` and
posts a fresh `UPDATED` divider (so that batch isn't re-scanned); Cancel discards.

Commands:
- `!scan` — scan every screenshot posted since the last `UPDATED` divider
  (looks back up to 100 messages). Only members with the `SCAN_ROLE` role
  (default `Alliance Leader`) may run it.

Run (foreground, for local dev): `npm run bot` (which is
`node --env-file=.env discord-bot.js`).

Run permanently on a VPS with pm2 (`ecosystem.config.js` defines the `bma-bot`
process, including the `--env-file=.env` flag):
- `npm run bot:start` — start/reload under pm2 and `pm2 save`.
- `npm run deploy` — `git pull`, install prod deps, reload, and `pm2 save`.
- `npm run bot:logs` / `bot:status` / `bot:stop` — manage the running process.

One-time, to make pm2 resurrect the bot after a reboot, run `pm2 startup` and
execute the `sudo …` line it prints (then `npm run bot:start` to snapshot). Note
`.env` and `serviceAccount.json` are gitignored, so copy them onto the VPS by
hand (e.g. `scp`) — `git pull` won't bring them.

Required env (e.g. in a gitignored `.env`):
- `DISCORD_TOKEN` — Discord bot token.
- `GEMINI_API_KEY` — Google Gemini API key.
- `GOOGLE_APPLICATION_CREDENTIALS` — path to the Firebase service-account key
  (optional; defaults to `serviceAccount.json`).

Optional: a `discord-bot-reference.png` next to the script is used as a one-shot
example to anchor the Gemini name extraction.

> ⚠️ The old Python bot (`discord_bot.py`, now removed) had a live bot token
> hardcoded in it. That token is compromised — rotate it in the Discord Developer
> Portal and keep the new one in `.env` only.

## Conventions

- Node 24+ (`.nvmrc`), CommonJS (`"type": "commonjs"`), built-in global `fetch`.
- Secrets live in env / gitignored files, never in source.
