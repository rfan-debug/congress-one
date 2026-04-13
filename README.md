# congress-one

Plain-English and Simplified-Chinese summaries of U.S. Congress bills, so an
average reader can understand what a bill actually means in under a minute.

- **Source** — [api.congress.gov](https://api.congress.gov/) (Library of
  Congress; see also <https://www.loc.gov/apis/json-and-yaml/>). Only bills
  introduced on/after **2025-01-01** are ingested.
- **Summarizer** — Google Gemini via
  [Google AI Studio](https://aistudio.google.com/). Each bill is summarized
  **once** and cached in Cloudflare **D1** (SQLite). No per-request LLM calls.
- **Listing** — sortable by introduced date or latest action; searchable by
  title; per-card English ↔ 中文 toggle.
- **Refresh** — a Cloudflare Workers **cron trigger** runs weekly (Sundays at
  06:00 UTC) and ingests any new bills it hasn't seen before.
- **Hosting** — Cloudflare Workers **Free plan** (Worker + D1 + Cron Triggers
  are all included).
- **Deploy** — one-click via a GitHub Actions workflow.

---

## Project layout

```
.
├── src/
│   ├── index.ts       # Worker entry (fetch + scheduled)
│   ├── ingest.ts      # pipeline: Congress API -> Gemini -> D1
│   ├── congress.ts    # api.congress.gov client
│   ├── gemini.ts      # Google Gemini (generativelanguage) client
│   ├── db.ts          # D1 helpers
│   ├── templates.ts   # server-rendered HTML
│   └── types.ts
├── schema.sql         # D1 schema (idempotent)
├── wrangler.toml      # Cloudflare config + cron + D1 binding
├── .github/workflows/deploy.yml
├── package.json
└── tsconfig.json
```

---

## Credentials you need

| Secret                      | Where to get it                                              | Used for                                         |
| --------------------------- | ------------------------------------------------------------ | ------------------------------------------------ |
| `CLOUDFLARE_API_TOKEN`      | Cloudflare dashboard → My Profile → API Tokens → Create Token. Use the **"Edit Cloudflare Workers"** template and add the **D1 → Edit** permission. | Lets GitHub Actions deploy the Worker and apply D1 migrations. |
| `CLOUDFLARE_ACCOUNT_ID`     | Cloudflare dashboard → right sidebar of any Workers page.    | Tells `wrangler` which account to target.        |
| `CLOUDFLARE_D1_DATABASE_ID` | From `wrangler d1 create congress_one` (see below).          | Binds the Worker to your D1 instance.            |
| `CONGRESS_API_KEY`          | <https://api.congress.gov/sign-up/> (free, instant).         | Query bills from api.congress.gov.               |
| `GEMINI_API_KEY`            | <https://aistudio.google.com/> → "Get API key" (free, instant; just a Google account). | Generate the bilingual summaries.                |
| `ADMIN_TOKEN`               | Any random string you make up (`openssl rand -hex 32`).      | Gates the `/admin/ingest` route.                 |

All six go into **GitHub → Settings → Secrets and variables → Actions → New
repository secret** with those exact names. The workflow in
`.github/workflows/deploy.yml` reads them and pushes the three runtime secrets
(`CONGRESS_API_KEY`, `GEMINI_API_KEY`, `ADMIN_TOKEN`) into the Worker via
`wrangler secret put`.

---

## First-time deploy (one-time manual setup)

You only do these two steps once. Everything after that is pushed by CI.

### 1. Create the D1 database

You need to create the D1 database once so Cloudflare can hand you back a
database id. From your laptop:

```bash
npm install
npx wrangler login                         # opens browser, signs you in
npx wrangler d1 create congress_one
```

The command prints something like:

```
✅ Successfully created DB 'congress_one'
[[d1_databases]]
binding = "DB"
database_name = "congress_one"
database_id = "b7f8c0d2-....-............"
```

Copy that `database_id` — that's your `CLOUDFLARE_D1_DATABASE_ID` secret.
You do **not** need to paste it into `wrangler.toml` by hand; the GitHub
Action injects it at deploy time. (If you want to deploy manually from your
laptop instead, paste it into `wrangler.toml` where it says
`REPLACE_WITH_D1_DATABASE_ID`.)

### 2. Add all six secrets to GitHub

Go to **Settings → Secrets and variables → Actions** on the repo and add the
six secrets listed in the table above.

---

## Deploy

### Via GitHub Actions (recommended)

Push to `main` — that's it. The workflow:

1. Type-checks TypeScript (`tsc --noEmit`).
2. Injects the D1 database id into `wrangler.toml`.
3. Applies `schema.sql` to the remote D1 database (idempotent — safe to re-run).
4. Pushes `CONGRESS_API_KEY`, `GEMINI_API_KEY`, `ADMIN_TOKEN` into the
   Worker via `wrangler secret put`.
5. Runs `wrangler deploy`, which publishes the Worker **and** registers the
   weekly cron trigger declared in `wrangler.toml`.

You can also run the workflow manually: **Actions → Deploy to Cloudflare
Workers → Run workflow**.

### Manually from your laptop (optional)

```bash
# One-time
npm install
npx wrangler login
npx wrangler d1 create congress_one          # paste database_id into wrangler.toml
npx wrangler d1 execute congress_one --remote --file=./schema.sql
npx wrangler secret put CONGRESS_API_KEY     # paste value when prompted
npx wrangler secret put GEMINI_API_KEY
npx wrangler secret put ADMIN_TOKEN

# Every deploy
npx wrangler deploy
```

---

## Populating the cache

On a fresh database the homepage will be empty. You have two options:

**Option A — wait for the weekly cron.** The `[triggers]` block in
`wrangler.toml` runs `scheduled()` every Sunday at 06:00 UTC.

**Option B — trigger an ingest right now.** Hit the admin route:

```bash
curl -X POST https://<your-worker>.workers.dev/admin/ingest \
     -H "Authorization: Bearer $ADMIN_TOKEN"
```

Response:

```json
{
  "scanned": 50,
  "alreadyCached": 0,
  "inserted": 47,
  "skipped": 0,
  "errors": []
}
```

`INGEST_LIMIT` in `wrangler.toml` caps how many bills each run will pull
(default: 50). Increase it for backfills, but watch your Gemini quota.

---

## How it works

1. **List recent bills.** `listRecentBills()` hits
   `/v3/bill/119/{hr,s,hjres,…}` on api.congress.gov with
   `fromDateTime=2025-01-01` and filters on `introducedDate` client-side.
2. **De-duplicate.** For each list item we form a deterministic key
   `"<congress>-<type>-<number>"` and check D1. If it's already cached, we skip
   it — Gemini is **never** called twice for the same bill.
3. **Fetch detail + CRS summary.** We pull `/bill/.../` and `/bill/.../summaries`
   so Gemini has title, sponsor, latest action, and (if available) the official
   dense summary.
4. **Summarize.** One Gemini `generateContent` call per bill, asking for ≤220
   words in plain English and ≤220 words in 简体中文 inside
   `<english>`/`<chinese>` tags. A `systemInstruction` enforces a neutral,
   non-partisan tone.
5. **Cache.** The row goes into `bills` in D1 with both summaries and metadata.
6. **Serve.** `GET /` renders cached rows; `GET /api/bills` exposes JSON. No
   LLM calls at request time.

---

## HTTP API

| Method | Path                   | Purpose                                                |
| ------ | ---------------------- | ------------------------------------------------------ |
| GET    | `/`                    | HTML page, sortable and searchable                     |
| GET    | `/api/bills`           | JSON list. Query params: `sort`, `order`, `q`, `limit`, `offset` |
| GET    | `/api/bills/:billId`   | JSON for a single bill (`:billId` is `119-hr-1234` etc.) |
| POST   | `/admin/ingest`        | Run the pipeline now. Requires `Authorization: Bearer $ADMIN_TOKEN` |
| GET    | `/healthz`             | Liveness                                               |

Sort options: `sort=introduced_date` (default) or `sort=latest_action_date`;
`order=desc` (default) or `order=asc`.

---

## Configuration knobs

All live in `wrangler.toml` under `[vars]` (non-secret) or as secrets:

| Name              | Default                      | Meaning                                                |
| ----------------- | ---------------------------- | ------------------------------------------------------ |
| `MIN_BILL_DATE`   | `2025-01-01`                 | Only bills introduced on/after this date are ingested. |
| `INGEST_LIMIT`    | `50`                         | Max bills examined per ingest run.                     |
| `GEMINI_MODEL`    | `gemini-2.5-flash`           | Google Gemini model id used for summarization.         |
| `CONGRESS_API_KEY`  | _secret_                   | api.congress.gov key                                   |
| `GEMINI_API_KEY`    | _secret_                   | Google AI Studio key                                   |
| `ADMIN_TOKEN`       | _secret_                   | Gates `/admin/ingest`                                  |

The cron schedule lives in `[triggers] crons = ["0 6 * * 0"]`. Edit that line
to change the cadence.

---

## Local development

```bash
npm install

# Create a local D1 db + schema
npx wrangler d1 execute congress_one --local --file=./schema.sql

# Dev secrets: create a .dev.vars file (gitignored) with:
#   CONGRESS_API_KEY=...
#   GEMINI_API_KEY=...
#   ADMIN_TOKEN=dev-token

# Run the Worker locally (http://localhost:8787)
npx wrangler dev

# In another shell, trigger an ingest against your local D1
curl -X POST http://localhost:8787/admin/ingest -H "Authorization: Bearer dev-token"
```

To simulate the weekly cron locally:

```bash
npx wrangler dev --test-scheduled
# then in another shell:
curl "http://localhost:8787/__scheduled?cron=0+6+*+*+0"
```

---

## Costs & free-tier notes

- **Cloudflare.** Workers Free tier = 100k requests/day. D1 free tier = 5 GB
  storage, 25M reads/day, 100k writes/day. Cron triggers are free. Well within
  the capacity of a small civic site.
- **api.congress.gov.** Free, but rate-limited (~5,000 req/hr per key). The
  weekly cron uses at most ~10 × INGEST_LIMIT requests.
- **Google Gemini (AI Studio).** Has a free tier with generous per-minute and
  per-day quotas on the Flash models — a weekly run of 50 bills against
  `gemini-2.5-flash` easily fits inside the free allowance. If you outgrow it,
  AI Studio will prompt you to enable billing on the same key. Bump
  `GEMINI_MODEL` to `gemini-2.5-pro` if you want higher-quality summaries
  (slower, smaller free quota).

---

## License

MIT. See `LICENSE`.
