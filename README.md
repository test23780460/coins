# SkyBlock Coin Tracker

Personal Hypixel SkyBlock coin balance tracker. Manually log your total coins over time, view gains/losses, chart progress, and export backups.

**Privacy architecture**

| Layer | Role |
| --- | --- |
| **GitHub Pages** (`coins`) | Public frontend only (login UI + dashboard shell). No coin history. |
| **Cloudflare Worker** | Auth, validation, sessions, GitHub API access. |
| **Private repo** (`skyblock-coin-data`) | Stores sharded JSON history (`data/manifest.json` + `data/shards/`). Never public. |

---

## Live site

- Frontend: https://test23780460.github.io/coins/
- API: https://skyblock-coin-tracker.ptravis022.workers.dev
- Data (private): `skyblock-coin-data` → sharded under `data/shards/` (+ `data/manifest.json`)


---

## Features

- Secure password login (PBKDF2 hash + signed sessions; secrets stay on the Worker)
- Balance entry with `k` / `m` / `b` / `t` parsing
- Unlimited entries per day
- Dashboard stats: current, previous change, last 7 days, all-time
- History with edit / delete
- Chart filters: 7D · 30D · 90D · ALL
- CSV + JSON export, JSON import with server-side backup
- Optional notes on balance changes
- **Automatic backup logging** after 24h without a manual entry (Cloudflare Cron)
- **Profile Progress** (secondary): skill XP + estimated net worth snapshots alongside auto fetches
- America/New_York display timezone
- Mobile-friendly dark UI

---

## Development

### Frontend

```bash
npm install
npm run dev
```

Optional `.env`:

```bash
VITE_API_BASE_URL=http://127.0.0.1:8787
```

### Worker

```bash
cd worker
npm install
npx wrangler dev
```

### Tests & build

```bash
npm test
npm run build
```

### Password hash

```bash
npm run hash-password -- "your-password"
```

Copy the output into the Worker secret `AUTH_PASSWORD_HASH`.

---

## Secrets (Cloudflare Worker)

Never commit real secrets. Set with Wrangler:

```bash
cd worker
npx wrangler secret put AUTH_PASSWORD_HASH
npx wrangler secret put SESSION_SECRET
npx wrangler secret put GITHUB_TOKEN
```

| Secret | Purpose |
| --- | --- |
| `AUTH_PASSWORD_HASH` | PBKDF2 hash from `npm run hash-password` |
| `SESSION_SECRET` | Long random string for signing session tokens |
| `GITHUB_TOKEN` | Fine-grained PAT with Contents read/write on `skyblock-coin-data` |

Plain vars (in `worker/wrangler.jsonc`):

- `GITHUB_OWNER`
- `GITHUB_DATA_REPO`
- `GITHUB_DATA_PATH`
- `ALLOWED_ORIGINS` — GitHub Pages + localhost only (no `*`)

---

## Data repository

Private repo: `skyblock-coin-data`

Long-term storage uses **automatic file sharding** so no single file hits GitHub’s ~1 MB Contents API limit (or the broader Git file limits).

```text
data/manifest.json              # index of all shards + active write target
data/shards/part-0001.json      # sealed / active history chunks
data/shards/part-0002.json
data/skyblock-coins.json        # legacy single file (kept as backup after migration)
data/backups/                   # import backups
```

- New balances append to the **active** shard.
- When that shard approaches ~700 KB, the Worker starts a new `part-XXXX.json`.
- The site/API always loads **all** shards and merges them — charts, history, exports, and stats still use your full history.
- Existing single-file data migrates automatically on the next save.

Every create / edit / delete / import still creates Git commits (built-in history backup).

---

## Automatic logging (24-hour backup)

If you do not manually save a balance for **24 hours**, the Worker automatically records your **Raspberry** liquid coins (purse + bank + personal bank) about once per day until you log manually again.

### How the timer works

- Only **manual** entries reset the inactivity timer.
- Automatic entries do **not** count as manual activity.
- After a manual save, the next auto entry is eligible ~24 hours later.
- While inactive, the Worker records at most **one** automatic balance per 24 hours.
- Cron runs hourly (`0 * * * *`) but only creates an entry when eligible.
- Duplicate cron runs are guarded (re-check before commit + min-interval + automation state).
- Deleting an automatic entry suppresses recreation for 24 hours so cron does not spam replacements.

### Data source

SkyCrypt’s public website loads stats from its backend (`GET /api/stats/{player}/{profile}`), which requires a private `X-API-Token`. That token is not publicly available.

This tracker therefore:

1. Prefers SkyCrypt’s structured API when `SKYCRYPT_API_TOKEN` is configured.
2. Otherwise uses the **Hypixel SkyBlock API** (SkyCrypt’s upstream) with your `HYPIXEL_API_KEY`.

Configured player/profile (Worker vars):

- `SKYCRYPT_PLAYER=justiwantdreams`
- `SKYCRYPT_PROFILE=Raspberry`

Balance meaning: **purse + coop bank + personal bank** (not net worth / items).

Failures (timeouts, 429/500, wrong profile, missing bank, malformed JSON) **never** write a balance. The next hourly check retries.

### Enable / disable

```text
AUTO_LOG_ENABLED=true   # set false in wrangler.jsonc vars to disable
```

Required secret for automatic logging:

```bash
cd worker
npx wrangler secret put HYPIXEL_API_KEY
```

Get a key at https://developer.hypixel.net/

Optional:

```bash
npx wrangler secret put SKYCRYPT_API_TOKEN
```

### Deploy Worker (includes cron)

```bash
cd worker
npx wrangler deploy
```

Confirm triggers show `0 * * * *` in the deploy output.

### Testing automatic logging

```bash
npm test
```

Unit tests cover eligibility, duplicate windows, SkyCrypt/Hypixel parsers, and failure cases.

Dashboard shows a compact **Automatic Logging** status panel after login.

---

## Profile Progress (secondary analytics)

Separate from coin history. When Hypixel/SkyCrypt profile data is fetched (hourly cron or Run Auto Check), the Worker also saves a **profile snapshot** under `data/profile/` in the private data repo.

| Metric | Source |
| --- | --- |
| Skill XP | Hypixel `player_data.experience.SKILL_*` (same profiles response as coins) |
| Estimated net worth | SkyCrypt only (when `SKYCRYPT_API_TOKEN` is set and that path succeeds) |

- Does **not** affect coin balance, charts, goals, or the 24h inactivity timer
- Missing skills or net worth are marked unavailable (never invents zeros for deltas)
- Duplicate identical snapshots within ~55 minutes are skipped

---

## GitHub Pages

Workflow: `.github/workflows/deploy.yml`

1. Enable Pages → Source: **GitHub Actions**
2. Set repository variable `VITE_API_BASE_URL` to your Worker URL
3. Push to `main` → build, test, deploy

---

## API

| Method | Path | Auth |
| --- | --- | --- |
| POST | `/api/login` | No |
| POST | `/api/logout` | Yes |
| GET | `/api/entries` | Yes |
| POST | `/api/entries` | Yes |
| PUT | `/api/entries/:id` | Yes |
| DELETE | `/api/entries/:id` | Yes |
| POST | `/api/import` | Yes |
| GET | `/api/health` | No |
| GET | `/api/automation/status` | Yes |
| POST | `/api/automation/run` | Yes |
| GET | `/api/profile/progress` | Yes |
| GET | `/api/profile/snapshots` | Yes |

---

## Backup & restore

1. **Export JSON Backup** from the UI, or clone the private data repo.
2. **Import JSON** validates entries, shows counts, confirms, then backs up server-side before replacing.

CSV columns: Date, Time, Timestamp, Total Coins, Gain/Loss, Percentage Change.

---

## Updating

1. Change frontend/worker code locally
2. `npm test` && `npm run build`
3. Commit & push `main` (Pages auto-deploys)
4. `cd worker && npx wrangler deploy` for API changes

---

## Security notes

- No password, token, or session secret in frontend JS or this public repo
- CORS allowlist only
- Login rate limiting (per isolate / IP)
- Server-side validation for all writes
- Failed GitHub reads never wipe the database with an empty file
