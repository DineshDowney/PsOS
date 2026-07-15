# Architecture

Local-first, single-user Next.js 15 app. One process, one folder of state (`data/`), no cloud.

## Layout

```
src/
  app/                 screens (App Router) + thin zod-validated route handlers in app/api/**
  components/          UI primitives (ui.tsx) + providers (react-query, toasts)
  lib/api.ts           typed fetch client; all errors surface as toasts
  shared/types.ts      domain types shared by server and client
  server/
    db/                Drizzle schema + singleton client (WAL SQLite, auto-migrate at boot)
    lib/               errors (AppError + withErrorHandling), ids, json helpers
    services/          business logic: catalog, provenance, wear, outfits, plans,
                       analytics, settings, activity (audit log)
    engine/            deterministic outfit engine + color model (pure, unit-tested)
    imaging/           storage layout, thumbnails, dominant colors, background removal
    imports/           the 5-stage import pipeline
    ai/                agent.ts (Agent SDK wrapper) · extraction.ts (photo → metadata)
                       tools.ts (wardrobe MCP tools + chat system prompt) · chat.ts (SSE)
scripts/               seed.ts (placeholder wardrobe) · launch-psos.cmd (desktop launcher)
drizzle/               generated SQL migrations (npm run db:generate after schema changes)
data/                  gitignored: stylist.db + images/<itemId>/<role>.<ext>
```

## Load-bearing rules

1. **Provenance** — every editable item field tracks `ai` | `user` source. User edits win
   forever; AI writes only untouched fields. All field writes go through
   `services/catalog.ts` (`updateItemFields` for users, `applyInferenceToItem` for AI).
2. **AI boundary** — nothing imports the Agent SDK except `server/ai/agent.ts`. Auth rides
   the machine's Claude Code login; there is no API key anywhere.
3. **Engine over LLM** — outfit combinations come from `engine/outfit-engine.ts`. Chat's
   `suggest_outfits` tool calls the same engine.
4. **Never fail silently** — route handlers wrap in `withErrorHandling` (structured JSON
   errors), pipeline stages record per-stage failures in `import_jobs`, mutations toast on
   error, `activity_log` records user/AI/system actions.
5. **Degradation** — background removal returning `null`, AI extraction failing, etc. never
   block an import; the draft stays reviewable with originals intact.

## Import pipeline

`POST /api/imports` (front + optional back photo) → draft item + job row (status `queued`) →
a bounded in-process queue (`PSOS_IMPORT_CONCURRENCY`, default 2) runs pipelines FIFO →
save originals → background removal (cosmetic) → thumbnail → dominant colors (deterministic
cross-check) → AI metadata via Agent SDK `Read`-tool vision (zod-validated JSON, confidence
per field, null-over-guess) → `applyInferenceToItem` → status `ready_for_review`. The UI
polls the job, then the user reviews/edits (edits flip provenance to `user`) and confirms
(`state: draft → active`).

Reliability notes (learned from real-photo testing, 2026-07-15):
- **Background removal is currently disabled** (`PSOS_DISABLE_BG_REMOVAL=1`): imgly's ONNX
  runtime hard-crashes the whole Node process on load (native GLib conflict with sharp's
  libvips on Windows; uncatchable from JS). Pipeline degrades gracefully — originals become
  the catalog images. Fix planned: isolate removal in a child process or swap the library.
- **Orphan recovery**: jobs stuck `queued`/`running` for >3 min are auto-marked failed on the
  next import-API touch (crash/restart leaves them behind; the in-process queue does not
  survive a restart). Runs lazily in `imports/pipeline.ts`, not `instrumentation.ts` —
  Next's instrumentation bundling pass drags imgly's native binary in and breaks the app.
- **Extraction model is pinned to `claude-sonnet-5`** (Settings → `ai.extractionModel`):
  the unpinned default misidentified garments while reporting 1.0 confidence; Sonnet was
  11-for-11 accurate with honest confidence on the first real batch.

## Chat

`POST /api/chat/sessions/:id/messages` streams SSE. Server runs the Agent SDK with an
in-process MCP server (`mcp__wardrobe__*` tools: search, get item, suggest outfits, log wear,
set status, save outfit, plan, calendar, stats), resumes via the stored SDK session id, and
persists the transcript in `chat_sessions` / `chat_messages`. Tool allowlist enforced via
`canUseTool` — the chat agent has no file or shell access.

## Data lifecycle

- Wear history is event-sourced (`wear_events` + items); `wear_count`/`last_worn_at` are
  recomputed caches. Marking a calendar plan "worn" writes the wear event.
- Trips tables exist for the travel feature (Phase 1 = schema only, tools/UI later).
- Backup = zip of `data/` via Settings → Export (`/api/export`).
