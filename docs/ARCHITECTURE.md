# Architecture — the one-page map

Local-first, single-user Next.js 15 app. One process, one folder of state (`data/`).
A production copy runs on GCP VM `psos-1` (systemd service, reachable over Tailscale
Funnel — no inbound port).

**New to the project? Read `docs/INTRODUCTION.md` first** — what psos is, why it exists, and
the five ideas the code follows from.

**This page is the map. `docs/DESIGN.md` is the territory** — it explains how every
component connects to every other and why each choice was made. Read this to find
something; read that to understand it. `docs/DECISIONS.md` is the dated record of how we
got here.

## Layout

```
src/
  app/                 screens (App Router) + thin zod-validated route handlers in app/api/**
  components/          UI primitives (ui.tsx) + nav + providers (react-query, toasts)
  lib/api.ts           typed fetch client; all errors surface as toasts
  lib/import-progress.ts  pure: which sentence describes a job's stage progress
  shared/types.ts      domain types shared by server and client
  server/
    db/                Drizzle schema + singleton client (WAL SQLite; migrations applied by
                       scripts/boot.ts before the server starts — see DESIGN.md §3.5)
    lib/               no-domain primitives: errors, ids, json, limiter, work-hold,
                       keepalive, upload-limits, login-throttle
    services/          business logic: catalog, provenance, wear, outfits, outfit-stylist,
                       plans, analytics, settings, activity (audit log), duplicates
    engine/            deterministic outfit engine + color model (pure, unit-tested)
    imaging/           storage, thumbnails/tiles, cutout ladder + QA, flat-key,
                       on-demand regeneration
    imports/           the 7-stage import pipeline
    ai/                vertex-client.ts (Gemini HTTP) · extraction.ts (photo → metadata)
                       image-generation.ts (product shots) · agent.ts (Claude Agent SDK,
                       chat only) · tools.ts (wardrobe MCP tools) · chat.ts (SSE)
scripts/               boot.ts (migrate + recover, runs as npm prestart/predev) ·
                       shots.ts (screenshot every screen via local Edge) ·
                       seed.ts (placeholder wardrobe) · vertex-probe.ts (what models
                       the current credentials can reach) · cutout-diag.ts
drizzle/               generated SQL migrations (npm run db:generate after schema changes)
data/                  gitignored: stylist.db + images/<itemId>/<role>.<ext>
```

## Load-bearing rules

1. **Provenance** — every editable item field tracks `ai` | `user` source. User edits win
   forever; AI writes only untouched fields. All field writes go through
   `services/catalog.ts` (`updateItemFields` for users, `applyInferenceToItem` for AI).
2. **AI boundary** — one entry point per provider: nothing imports the Agent SDK except
   `server/ai/agent.ts` (chat only; auth rides the machine's Claude Code login, no key), and
   nothing calls Gemini except `server/ai/vertex-client.ts` (env key or VM service account —
   **never** from `settings`, which is served publicly). Everything that looks at a garment
   runs on Gemini.
3. **Engine decides what's allowed, a model decides what's good** — `engine/outfit-engine.ts`
   produces wearable candidates; `services/outfit-stylist.ts` lets Gemini reorder and explain
   them, and `validatePicks` throws away anything that isn't one of those candidates. Any
   failure falls back to engine ranking and says so. Chat's `suggest_outfits` calls the plain
   engine.
4. **Never fail silently** — route handlers wrap in `withErrorHandling` (structured JSON
   errors), pipeline stages record per-stage failures in `import_jobs`, mutations toast on
   error, `activity_log` records user/AI/system actions.
5. **Degradation** — a cutout coming back `null`, AI extraction failing, etc. never block an
   import; the draft stays reviewable with originals intact.
6. **Boot before serve** — `scripts/boot.ts` (npm `prestart`/`predev`) applies migrations and
   marks jobs orphaned by the last restart. A failure there aborts the launch rather than
   starting against a stale schema.

## Import pipeline

`POST /api/imports` (front + optional back photo) → draft item + job row (`queued`) → a
bounded in-process queue (`PSOS_IMPORT_CONCURRENCY`, default 2) runs pipelines FIFO through
seven stages: **save → garment_box → image_generation → background_removal → colors →
ai_metadata → thumbnail**. Only `save` is fatal; every other stage degrades and records why.
Ends at `ready_for_review`; the UI polls, the user reviews (edits flip provenance to `user`)
and confirms (`state: draft → active`).

The stage order is load-bearing. Colours run after the cutout so they read the garment and
not the bedsheet; metadata runs last so it can see the studio shots — but it is sent the
original photographs too, ranked above them, so a redraw's drift never becomes a recorded
fact. **Why each stage sits where it does, and the three concurrency limiters:
`docs/DESIGN.md` §5.**

## Cutouts

`imaging/cutout-ladder.ts`: native alpha → flat-key the grey backdrop → **regenerate once
against a magenta backdrop and key that** → accept the keyed output with a QA warning.
`cutoutQa` judges every rung. There is no ML segmentation and no native ML runtime in the
tree. **`docs/DESIGN.md` §4.3.**

## Image regeneration

`POST /api/items/[id]/regenerate` queues a job (front / back / both + optional free-text
feedback), polled at `GET /api/regen-jobs/[id]`. Always sources from the ORIGINAL crop, never
from a previous generation. Shares its per-side core with `scripts/regenerate-images.ts`.
**`docs/DESIGN.md` §6.**

## Outfit suggestions

`POST /api/outfits/suggest` → `services/outfit-stylist.ts`: the engine shortlists 8 wearable
candidates, Gemini reorders them from ≤12 garment tiles and writes one line each,
`validatePicks` discards anything that isn't one of those candidates, and any failure falls
back to engine ranking with the reason shown. **`docs/DESIGN.md` §8.**

## Chat

`POST /api/chat/sessions/:id/messages` streams SSE. Server runs the Agent SDK with an
in-process MCP server (`mcp__wardrobe__*` tools: search, get item, suggest outfits, log wear,
set status, save outfit, plan, calendar, stats), resumes via the stored SDK session id, and
persists the transcript in `chat_sessions` / `chat_messages`. Tool allowlist enforced via
`canUseTool` — the chat agent has no file or shell access. **Needs a Claude Code login, so it
works on the laptop and not on the VM.**

## Data lifecycle

- Wear history is event-sourced (`wear_events` + items); `wear_count`/`last_worn_at` are
  recomputed caches. Marking a calendar plan "worn" writes the wear event.
- Trips tables exist for the travel feature (Phase 1 = schema only, tools/UI later).
- Backup = zip of `data/` via Settings → Export (`/api/export`).

## The look

One type scale in `@theme` (`globals.css`). **Tracked uppercase is rationed to three roles** —
the page `<h1>`, the wordmark, the nav — and everything else is sentence case, because when
every string shouts none of them do. Three surface tiers (`.card` raised paper, `.well`
recessed, `border-line` for dividers and controls) replace the single hairline that used to be
on containers and 9px buttons alike. All motion is CSS, all of it inside one
`prefers-reduced-motion` block. **`docs/DESIGN.md` §10.**

`npm run shots` writes a full-page PNG of every screen at 1440px and 390px using the Edge
already installed on the machine — the only way this repo can be looked at rather than read.
