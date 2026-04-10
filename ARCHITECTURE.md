# ISG Second Brain -- Architecture

> Last updated: 2026-04-10
> Status: Core modules 1-6 are in place, and the integration automation stack for Google, Monday, RealEstateTool, Whisper, PDF generation, and cron orchestration is now part of the codebase.

## What This Is

ISG Second Brain is a local-first commercial real estate intelligence backend for Sullivan Link workflows. It combines:

- structured property, entity, buyer, seller, and deal data in PostgreSQL
- semantic knowledge retrieval through ChromaDB
- natural-language ingestion and routing
- deterministic buyer-to-seller matching
- wiki-style narrative synthesis
- background automation for email, calendars, documents, syncs, transcription, and daily operations

The project is designed to run as a local service first, with explicit scripts and schedulers for batch work instead of hiding important behavior behind a single monolith process.

## Runtime Surfaces

| Surface | Entry point | Purpose |
| --- | --- | --- |
| Express API | `src/api/server.js` | Main HTTP backend on `API_PORT` (default `3100`) |
| CLI | `src/cli/brain.js` | Local operator commands for add/search/match/wiki/MCP |
| MCP server | `src/mcp/server.js` | Five-tool MCP adapter over stdio for agent access |
| One-off scripts | `scripts/*.js` | Imports, matching, scoring, syncs, backup, auth bootstrap |
| Cron scheduler | `src/scheduler/cron.js` + `scripts/start-scheduler.js` | Background orchestration and alerting |
| Watch worker | `scripts/watch-recordings.js` | File-system watcher for transcription intake |

At the time of this update, the API is organized into 12 route modules under `src/api/routes`, with 63 route declarations including the legacy `/brain/*` compatibility stubs.

## High-Level Topology

```text
                           +----------------------+
                           |  CLI / MCP / Scripts |
                           |  brain + workers     |
                           +----------+-----------+
                                      |
                                      v
 +----------------+        +----------+-----------+        +--------------------+
 | Google / Gmail |<------>|     Express API      |<------>|  Monday.com / MCP  |
 | Drive/Calendar |        |  ingestion + lookup  |        |  RealEstateTool    |
 +----------------+        |  search + matching   |        +--------------------+
                           +----+-------------+---+
                                |             |
                                v             v
                        +-------+---+     +---+-------+
                        | PostgreSQL |     | ChromaDB |
                        | structure  |     | embeddings|
                        +-------+---+     +---+-------+
                                |             |
                                +------+------+ 
                                       |
                                       v
                             +---------+----------+
                             | Wiki + PDF + Daily |
                             | briefs + exports   |
                             +---------+----------+
                                       |
                                       v
                             +---------+----------+
                             | Scheduler / Alerts |
                             | cron.log + Gmail   |
                             +--------------------+
```

## Codebase Map

| Path | Responsibility |
| --- | --- |
| `src/api` | Express app, route registration, guardrails, validation |
| `src/db` | Postgres connection, migrations |
| `src/entities` | Entity extraction, clustering, LLC resolution |
| `src/buyers` | Buyer profiles, purchases, lender analytics |
| `src/sellers` | Seller profiles, distress scoring, motivation inference, foreclosure stage |
| `src/ingestion` | Classification, routing, merge/dedup logic |
| `src/knowledge` | Knowledge entry CRUD, embeddings, search, transcription helpers |
| `src/matching` | Score calculation, match persistence, explanations, narratives |
| `src/properties` | Property documents and grouping |
| `src/wiki` | Wiki promotion, queueing, linting |
| `src/integrations` | External system adapters and automation primitives |
| `src/templates` | PDF composition helpers and document-specific layouts |
| `src/scheduler` | Background job registry, execution, logging, Gmail failure alerts |
| `src/mcp` | MCP tools and server wiring |
| `scripts` | Operator scripts, cron targets, imports, backups, auth bootstrap |

## Core Application Flows

### 1. Structured Property Import

The structured import path starts with either county foreclosure files or live RealEstateTool data.

**CSV / file import**

1. `src/import-export/gateway.js` parses UTF-8, UTF-16, XLSX, and JSON input.
2. `src/import-export/foreclosure-import.js` normalizes APN, address, city, dates, trustee/lender fields, and metadata.
3. Properties are deduped by `(apn, region)` and upserted transactionally.
4. `scripts/import-foreclosure-csv.js` can optionally skip seller generation or run in dry-run mode.
5. Property import rows are persisted in `property_import_records` for provenance and replay tracking.

**Live RealEstateTool sync**

1. `src/integrations/realestatetool.js` calls the configured endpoint.
2. The transport auto-detects MCP SSE when `REALESTATETOOL_URL` ends in `/sse`, and falls back to JSON-RPC POST for plain HTTP endpoints.
3. `src/integrations/realestatetool-sync.js` imports new properties, syncs liked/passed review decisions, optionally fetches title/recording docs, and triggers matching.
4. `scripts/sync-properties.js` is the hourly orchestration entrypoint.

### 2. Conversational Ingestion

Natural-language ingestion is centered on `src/ingestion/classifier.js` and `src/ingestion/router.js`.

1. A note, email, transcript, or free-form message enters through `/api/ingest`, `/api/ingest/audio`, CLI, or MCP.
2. The classifier assigns categories such as buyer intel, seller intel, relationship, market insight, action item, or general note.
3. The router creates or merges entities, buyer profiles, seller profiles, and knowledge entries.
4. `src/knowledge/embeddings.js` stores semantic vectors in ChromaDB.
5. High-signal entries can be queued for wiki promotion.

### 3. Matching and Narrative Generation

The matching engine remains deterministic at its core.

1. `src/matching/scorer.js` produces score breakdowns across property type, price, geography, size, strategy, timing, and knowledge alignment.
2. `src/matching/runner.js` materializes match rows.
3. `src/matching/explainer.js` produces human-readable rationales.
4. `src/matching/narrative.js` adds LLM-backed broker narrative output for high-confidence matches.

### 4. Background Operations

The integration stack extends the core app into an operational system.

- Gmail handles outbound mail, draft-only safety mode, inbox search, and inbound lead ingestion.
- Calendar mirrors appointments, due dates, and foreclosure reminders.
- Drive stores generated PDFs, call recordings, and linked files.
- Monday sync mirrors deal state and action updates.
- Whisper transcription converts recordings into ingestible notes.
- PDF generation produces briefs, proposals, flyers, and daily packets.
- The scheduler runs recurring jobs and can send Gmail failure alerts.

### 5. Wiki Promotion and Narrative Maintenance

The wiki remains a curated layer over structured truth.

1. `src/wiki/queue.js` tracks high-signal knowledge entries.
2. `src/wiki/promote.js` writes markdown pages with citations.
3. `src/wiki/lint.js` validates citation syntax, raw source links, and orphan pages.
4. `scripts/run-wiki-maintenance.js` processes the queue and emits reports.

## Integration Automation Stack

| Integration | Main files | Trigger / runner | Notes |
| --- | --- | --- | --- |
| Shared Google auth | `src/integrations/google-auth.js` | `npm run google:auth` via `scripts/bootstrap-google-token.js` | Supports file-based or env-provided token material |
| Gmail | `src/integrations/gmail.js` | `scripts/process-inbound-email.js` | Defaults to drafts until `GMAIL_AUTO_SEND=true` |
| Google Calendar | `src/integrations/calendar.js` | `scripts/sync-calendar.js` | Creates events, reminders, and agenda views |
| Google Drive | `src/integrations/drive.js` | used by PDF/transcription flows | Persists attachment links in `drive_attachments` |
| Monday.com | `src/integrations/monday-sync.js` | `scripts/sync-monday.js` | Board sync plus `monday_links` mapping table |
| RealEstateTool live sync | `src/integrations/realestatetool.js`, `src/integrations/realestatetool-sync.js` | `scripts/sync-properties.js` | Supports both SSE MCP and JSON-RPC transports |
| Whisper transcription | `src/integrations/whisper.js` | `scripts/watch-recordings.js` | Dedupes processed files with a crash-safe log |
| PDF generation | `src/integrations/pdf-generator.js`, `src/templates/*.js` | on-demand, plus daily brief email flow | Uses `pdfkit`, optional Drive upload |
| Cron scheduler | `src/scheduler/cron.js` | `scripts/start-scheduler.js` | Writes JSON-line logs and can send Gmail failure alerts |

## Scheduler and Recurring Jobs

The scheduler is implemented in `src/scheduler/cron.js` and currently registers:

| Schedule | Script | Purpose |
| --- | --- | --- |
| Every 15 minutes | `scripts/health-check.js` | Optional health probe |
| Every 30 minutes | `scripts/process-inbound-email.js` | Search unread Gmail lead inquiries and ingest them |
| Hourly | `scripts/sync-properties.js` | RealEstateTool sync |
| Every 4 hours | `scripts/sync-monday.js` | Monday sync |
| Daily at 6:00 AM | `scripts/run-matching.js` | Refresh match inventory |
| Daily at 6:00 AM | `scripts/sync-calendar.js` | Push due items into calendar |
| Daily at 7:00 AM | `scripts/send-daily-brief.js` | Generate and email the morning brief |
| Daily at 11:00 PM | `scripts/backup-database.js` | `pg_dump` backup to local filesystem |

Operational details:

- Job output is summarized into `logs/cron.log`.
- Failures can trigger Gmail alerts to `BROKER_ALERT_EMAIL` or `BROKER_EMAIL`.
- `scripts/backup-database.js` can use the host `pg_dump` or fall back to Docker.

## API and MCP

### API Route Modules

The HTTP API is split across these route modules:

- `health`
- `ingest`
- `search`
- `entities`
- `buyers`
- `sellers`
- `knowledge`
- `properties`
- `match`
- `matches`
- `daily`
- `import-export`

The `import-export` router now includes live foreclosure preview/import endpoints in addition to legacy `/brain/import` and `/brain/export` stubs.

### MCP Surface

`src/mcp/tools.js` currently exposes five tools:

- `brain_add`
- `brain_search`
- `brain_lookup`
- `brain_match`
- `brain_daily`

These tools proxy back into the main Express API rather than duplicating business logic.

## Data Model

The schema has grown past the original module-6 snapshot and now includes core domain tables plus automation/integration state.

### Identity and Relationship Tables

- `entities`
- `entity_relationships`

### Property and Import Tables

- `properties`
- `property_groups`
- `property_import_records`
- `property_documents`

`property_import_records` now matters for more than file provenance. It also acts as the sync-state ledger for recurring RealEstateTool syncs.

### Buyer / Seller / Deal Tables

- `buyer_profiles`
- `buyer_purchases`
- `seller_profiles`
- `matches`
- `deals`

### Knowledge and Narrative Tables

- `knowledge_entries`
- `knowledge_entities`
- `knowledge_properties`
- `wiki_promotion_queue`

### Integration State Tables

- `drive_attachments`
- `monday_links`

`drive_attachments` lets Drive files be linked to a knowledge entry, property, or entity.  
`monday_links` records the mapping between a local brain record and Monday item IDs.

Implementation notes:

- `property_import_records` doubles as a sync cursor/state ledger for recurring RealEstateTool jobs, not just file-import provenance.
- `monday_links` is intentionally flexible and does not enforce a foreign key because the mapped local UUID can represent a match or a deal record.
- `drive_attachments` currently relies on application-side dedupe rather than a database uniqueness constraint.

## Migration History

| Migration | Purpose |
| --- | --- |
| `001_core_tables.sql` | Base entities, properties, buyers, sellers, knowledge, matches, deals, `_migrations` |
| `002_realestatetool_entity_fields.sql` | Property financial fields and live import identifiers |
| `003_buyer_enhancements.sql` | Expanded buy-box criteria and purchase history |
| `004_seller_enhancements.sql` | Distress, motivation, timeline, stage, AI fields |
| `005_knowledge_enhancements.sql` | Chroma references, AI summaries, knowledge join tables |
| `006_match_enhancements.sql` | Match score breakdowns, narratives, richer statuses |
| `007_property_assets.sql` | Property groups, import records, property documents |
| `008_wiki_automation.sql` | Wiki promotion queue and document promotion tracking |
| `009_drive_attachments.sql` | Google Drive attachment linkage |
| `010_monday_links.sql` | Monday board/item linkage |

## Key Operational Scripts

| Script | Role |
| --- | --- |
| `scripts/migrate.js` | Apply pending SQL migrations |
| `scripts/seed-test-data.js` | Load deterministic local fixtures |
| `scripts/import-foreclosure-csv.js` | Preview or import foreclosure files |
| `scripts/import-from-realestatetool.js` | Direct import from RealEstateTool |
| `scripts/run-matching.js` | Full or targeted matching execution |
| `scripts/score-sellers.js` | Distress scoring and seller inference batch work |
| `scripts/process-inbound-email.js` | Gmail lead triage worker |
| `scripts/sync-properties.js` | RealEstateTool sync worker |
| `scripts/sync-monday.js` | Monday sync worker |
| `scripts/sync-calendar.js` | Calendar sync worker |
| `scripts/send-daily-brief.js` | Brief generation plus email send |
| `scripts/watch-recordings.js` | Live file-system watcher for audio ingestion |
| `scripts/transcribe-folder.js` | Batch transcription helper |
| `scripts/bootstrap-google-token.js` | One-time OAuth bootstrap for local Google token creation |
| `scripts/backup-database.js` | Postgres backup helper |
| `scripts/run-wiki-maintenance.js` | Queue processing and wiki linting |
| `scripts/run-ioc-sweep.js` | End-to-end smoke-test script |

## Environment and External Dependencies

### Core Services

- PostgreSQL 16
- ChromaDB
- Node.js 20+

### AI / Inference

- Anthropic via `@anthropic-ai/sdk`
- OpenAI for transcription and optional inference
- Ollama fallback for local inference

### External Integrations

- Google Gmail
- Google Calendar
- Google Drive
- Monday.com
- RealEstateTool / MCP bridge

Important behavior:

- Gmail live sending is gated by `GMAIL_AUTO_SEND=true`.
- Google auth is shared across Gmail, Calendar, and Drive.
- Monday sync requires `MONDAY_API_TOKEN`.
- RealEstateTool requires `REALESTATETOOL_URL`.
- Whisper transcription requires `OPENAI_API_KEY` when OpenAI is the provider.

## Testing and Verification

The project uses Node's built-in test runner with both unit and integration coverage.

Coverage areas include:

- imports and normalization
- buyer and seller workflows
- ingestion and classification
- matching and narratives
- wiki promotion and linting
- Google integrations
- Monday sync
- RealEstateTool sync
- PDF generation
- scheduler logging and alerting
- recording watch/transcription flows

As of this update, a full local `npm test` run passed with 149 tests.

## Operational Notes

- The original top-of-file record counts were intentionally removed from this document because they drift too quickly with local reseeds and live syncs.
- `MONDAY_LISTINGS_TEMPLATE_GROUP_ID` is still a documented follow-up rather than a guaranteed configured value.
- The Google auth path supports both local files and env-provided token material; the bootstrap script exists so the repo can mint a local token when needed.
- The Gmail, Calendar, and Drive integrations are designed as reusable primitives, so scheduler jobs and scripts call into those adapters instead of reimplementing API logic.
- RealEstateTool transport behavior is now explicit architecture: SSE MCP endpoints are supported directly and are no longer treated as plain JSON-RPC POST endpoints.
- Several automation paths persist state outside Postgres by design, including cron logs, scheduler alert flow, Google OAuth material, generated PDFs, and the Whisper processed-file log.
