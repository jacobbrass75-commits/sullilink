# ISG Second Brain

ISG Second Brain is a local-first commercial real estate intelligence backend. It now includes:

- PostgreSQL + ChromaDB infrastructure
- entity, buyer, seller, knowledge, and matching workflows
- foreclosure CSV import with dry-run preview and parcel grouping
- property document attachment support
- a narrative `raw/` + `wiki/` layer governed by `CLAUDE.md`

## Prerequisites

- Node.js 20+
- npm
- Docker Desktop or a compatible Docker runtime

## Setup

1. Copy `.env.example` to `.env` and adjust values if needed. By default, PostgreSQL is mapped to `5433` to avoid colliding with a locally installed Postgres on macOS.
2. Start the local services:

```powershell
docker-compose up -d
```

3. Install dependencies:

```powershell
npm install
```

4. Run database migrations:

```powershell
node scripts/migrate.js
```

5. Seed the 10 provided test properties:

```powershell
node scripts/seed-test-data.js
```

6. Start the API server:

```powershell
npm start
```

7. Run the test suite:

```powershell
npm test
```

## Background Scheduler

Start the cron worker locally with:

```bash
npm run scheduler:start
```

The scheduler writes JSON-line run records to `logs/cron.log`. Each entry includes the timestamp, job name, status, and duration in milliseconds. Failed jobs attempt to notify the broker via the Gmail alert seam when `BROKER_ALERT_EMAIL` and the Gmail integration are available. If `scripts/health-check.js` is not present yet, that job is skipped automatically.

The default job registry is:

- `*/15 * * * *` → `scripts/health-check.js` when present
- `*/30 * * * *` → `scripts/process-inbound-email.js`
- `0 * * * *` → `scripts/sync-properties.js`
- `0 */4 * * *` → `scripts/sync-monday.js`
- `0 6 * * *` → `scripts/run-matching.js`
- `0 6 * * *` → `scripts/sync-calendar.js`
- `0 7 * * *` → `scripts/send-daily-brief.js`
- `0 23 * * *` → `scripts/backup-database.js`

For a Mac launchd service, point `ProgramArguments` at `node` and `/absolute/path/to/isg-second-brain/scripts/start-scheduler.js`, set `WorkingDirectory` to the repo root, and enable `RunAtLoad` with `KeepAlive` so the worker restarts after reboots. If you prefer PM2, run `pm2 start scripts/start-scheduler.js --name isg-second-brain-scheduler` from the repo root and then `pm2 save`.

## Live Integrations

The app's "local env" means the `.env` file in the repo root plus any local credential files it points to. The new integrations need the following values before live runs:

- Google OAuth for Gmail, Calendar, and Drive: place `google-credentials.json` and `google-token.json` in the repo root, or point `GOOGLE_CREDENTIALS_PATH` and `GOOGLE_TOKEN_PATH` at those files. Inline fallbacks also work with `GOOGLE_CREDENTIALS_JSON`, `GOOGLE_TOKEN_JSON`, or `GOOGLE_REFRESH_TOKEN`.
- To mint `google-token.json` locally, run `npm run google:auth` from the repo root after `google-credentials.json` is in place. The script opens a browser for Google consent and saves the refresh token back into the repo root.
- Gmail live sending: `sendEmail()` stays in draft mode until `GMAIL_AUTO_SEND=true`. Leave it `false` if you want drafts only.
- Scheduler failure alerts: set `BROKER_ALERT_EMAIL` or `BROKER_EMAIL`, make sure Gmail OAuth is working, and optionally set `GMAIL_FROM_ALIAS`. Alerts are sent through the Gmail integration.
- Google Calendar and Drive: the shared OAuth files above are enough to start. Optional overrides are `GOOGLE_CALENDAR_ID`, `GOOGLE_CALENDAR_TIME_ZONE`, `CALENDAR_APPOINTMENT_DURATION_MINUTES`, and `GOOGLE_DRIVE_ROOT_FOLDER`.
- Monday sync: `MONDAY_API_TOKEN` is required. Board IDs already default to the current brokerage board map, so env overrides are only needed if the boards change.
- Monday template follow-up: `MONDAY_LISTINGS_TEMPLATE_GROUP_ID` is still pending because the Listings template group is not defined yet. Add that env var later when the Monday template group exists.
- Realestatetool sync: `REALESTATETOOL_URL` is required for live imports and hourly syncs.
- Whisper transcription: set `TRANSCRIPTION_PROVIDER=whisper` and provide `OPENAI_API_KEY`. Optional overrides are `OPENAI_TRANSCRIPTION_MODEL`, `OPENAI_TRANSCRIPTION_COST_PER_MINUTE`, and `BRAIN_API_URL` if the ingest API is not local.

Live-run prerequisites to keep in mind:

- Start the local services with `docker-compose up -d` before migrations or DB-backed smoke tests.
- Run `node scripts/migrate.js` after pulling new integration work so the latest tables exist.
- Scheduler failure alerts are now code-complete, but they still need working Gmail OAuth plus `BROKER_ALERT_EMAIL` or `BROKER_EMAIL` before a live alert can actually be delivered.

## Endpoints

- `GET /health`
- `POST /api/import/foreclosure/preview`
- `POST /api/import/foreclosure`
- `GET /api/properties/:id`
- `GET /api/properties/:id/group`
- `POST /api/properties/:id/documents`
- `POST /brain/ingest`
- `GET /brain/search`
- `GET /brain/entity/:id`
- `GET /brain/match/:identifier`
- `GET /brain/daily`
- `POST /brain/import`
- `GET /brain/export`

## Health Response

When all dependencies are reachable, `GET /health` returns:

```json
{
  "status": "ok",
  "database": "connected",
  "tables": 8,
  "tables_total": 15,
  "core_tables_expected": 8,
  "chromadb": "connected",
  "inference_provider": "claude",
  "version": "0.1.0"
}
```

If PostgreSQL or ChromaDB is unavailable, the route responds with HTTP 503 and the same JSON shape with the failing dependency marked `disconnected`.

## Foreclosure Import

Preview a real foreclosure CSV without writing data:

```bash
node scripts/import-foreclosure-csv.js /path/to/foreclosures.csv --dry-run
```

Run the live import:

```bash
node scripts/import-foreclosure-csv.js /path/to/foreclosures.csv
```

The importer is UTF-16 aware, deduplicates by `(apn, region)`, records every raw row in `property_import_records`, and groups likely multi-row parcels in `property_groups`.

## Narrative Wiki

The repo includes a Karpathy-inspired narrative layer:

- `raw/` for immutable source material
- `wiki/` for curated markdown pages
- `CLAUDE.md` for citation and maintenance rules

Promote a knowledge entry into the wiki:

```bash
brain promote <knowledge_entry_id>
```

Promote a property PDF or notice into the property wiki page:

```bash
brain promote-document <property_id> /path/to/notice.pdf --document-type notice_of_sale
```

Queue high-signal knowledge entries for promotion:

```bash
brain autopromote --dry-run
brain autopromote --limit 25
```

Lint the wiki for missing citations and stale references:

```bash
brain lint
npm run wiki:maintain
```

`npm run wiki:maintain` processes the auto-promote queue, writes JSON maintenance reports into `wiki/reports/`, and then lints the wiki for missing citations, missing raw sources, orphan pages, and stale references.
