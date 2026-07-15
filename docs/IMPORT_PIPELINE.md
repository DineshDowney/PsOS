# Import Pipeline

The complete path from a garment photo to a reviewed wardrobe item. This is the
foundation of the app — everything downstream (outfits, chat, analytics) consumes
the data this pipeline produces. A new developer should be able to understand the
whole import system from this document alone.

Last updated: 2026-07-15 (Phase 2). Keep this current whenever the pipeline changes.

## The flow at a glance

```
phone/browser                    server (Next.js route handlers → src/server/**)
─────────────                    ────────────────────────────────────────────────
POST /api/imports  ──────────▶   create draft item (state: draft)
  front (file, required)         create import_jobs row (status: queued)
  back  (file, optional)         enqueue pipeline run          ──▶ HTTP 201 (job)
                                 ────────── bounded queue ──────────
                                 max N concurrent (PSOS_IMPORT_CONCURRENCY, default 2)
                                 job status: queued → running
                                 1. save          normalize + store originals   [fatal on failure]
                                 2. background_removal                          [disabled, see below]
                                 3. thumbnail     640px catalog tile
                                 4. colors        deterministic dominant colors
                                 5. ai_metadata   Claude vision → fields + garment bbox
                                    └─ thumbnail re-cropped tight to the bbox
                                 job status: ready_for_review
GET /api/imports (poll) ◀─────   per-stage progress in import_jobs.stages
user reviews at /items/[id]      edits flip field provenance to "user"
POST /api/items/[id]/confirm ─▶  item state: draft → active  (appears in Wardrobe)
```

## Files that own each part

| Concern | File |
|---|---|
| Upload API (multipart) | `src/app/api/imports/route.ts` |
| Job polling API | `src/app/api/imports/[id]/route.ts` |
| Pipeline, queue, crash recovery | `src/server/imports/pipeline.ts` |
| Concurrency limiter | `src/server/lib/limiter.ts` |
| Image storage layout | `src/server/imaging/storage.ts` |
| Normalize / thumbnail / bbox crop | `src/server/imaging/thumbnails.ts` |
| Dominant colors | `src/server/imaging/dominant-colors.ts` |
| Background removal (disabled) | `src/server/imaging/background-removal.ts` |
| AI extraction (metadata + bbox) | `src/server/ai/extraction.ts` |
| Agent SDK wrapper (auth, allowlist) | `src/server/ai/agent.ts` |
| Provenance rules (pure) | `src/server/services/provenance.ts` |
| Item writes (user vs AI) | `src/server/services/catalog.ts` |
| Import screen UI | `src/app/import/page.tsx` |
| Review/edit UI | `src/app/items/[id]/page.tsx` |
| Thumbnail backfill script | `scripts/backfill-thumbnails.ts` |

## Upload contract

`POST /api/imports` — `multipart/form-data` with `front` (required image file) and
`back` (optional image file). One request = one clothing item. Returns `201` with
the job (status `queued`) immediately; processing is asynchronous. Bulk upload
does not exist yet (Phase 3).

## The queue

Uploads do not run immediately — `startImport()` inserts the job as `queued` and
hands the pipeline to a FIFO limiter (`createLimiter`). At most
`PSOS_IMPORT_CONCURRENCY` (default 2) pipelines run at once; a burst of uploads
lines up instead of launching unbounded parallel image + AI work. The queue is
in-process: it does not survive a server restart, which is why crash recovery
exists (below).

Job statuses: `queued → running → ready_for_review | failed`.

## Stages, and what failure means per stage

Stage progress is persisted per stage in `import_jobs.stages`
(`{status: pending|running|done|failed, error?}`), so the UI can poll and a killed
server leaves an inspectable record. Failure policy: **only `save` is fatal** —
everything downstream degrades gracefully and records its failure reason.

1. **save** — `normalizeUpload` (sharp): auto-rotate via EXIF, cap long edge at
   2048px, re-encode JPEG q92. Written to `data/images/<itemId>/front.jpg` (+
   `back.jpg`), one `item_images` row each with sha256. If this stage fails the
   job is `failed` — there is nothing to review.
2. **background_removal** — currently returns "unavailable" by design; the stage
   shows failed with an explanatory message and the pipeline continues. See
   "Background removal status" below.
3. **thumbnail** — 640×640 `fit: contain` on the app background color →
   `thumbnail.jpg`. At this point it is a full-frame thumbnail.
4. **colors** — deterministic pixel quantization (sharp, 64px downscale, 32-step
   RGB buckets, alpha-aware) → top-3 dominant hex colors. Not written to the item;
   passed to the AI prompt as a cross-check for color naming.
5. **ai_metadata** — see "AI extraction" below. On success,
   `applyInferenceToItem` writes fields through provenance rules, then —
   **stage 6, implicit** — if the AI returned a garment bounding box, the
   thumbnail is regenerated cropped tight to the garment (`cropToBox` with 8%
   padding, clamped, rejects implausibly small boxes). Crop failure is non-fatal;
   the full-frame thumbnail stays.

After stage 5 the job is `ready_for_review` **even if stages 2–5 individually
failed** — the draft is always reviewable with originals intact; a failed AI
stage just means a blank form.

## AI extraction

One Claude call per item, via the Claude Agent SDK riding the machine's Claude
Code login (no API key — see `docs/DECISIONS.md`). The agent gets the saved photo
paths and reads them with its `Read` tool (vision); allowlist is `["Read"]` only.

- **Model**: `ai.extractionModel` setting — **pinned to `claude-sonnet-5`**.
  Measured on real photos (2026-07-15): the unpinned default misidentified
  garments *with confidence 1.0*; Sonnet 5 went 11-for-11 with honest confidence
  (brand 0 when no logo visible). Do not unpin without re-validating.
- **Latency**: ~15–23 s per item, which is ~95% of pipeline wall time. At default
  concurrency, 100 items ≈ 30–40 minutes unattended.
- **Contract**: model returns one JSON object — name, category, subcategory,
  description, colors (primary/secondary/detail), pattern, fit, material, brand,
  formality, seasons, 3–8 tags, per-field confidence 0–1, and `bbox` (normalized
  garment box in the front photo, or null). Zod-validated with `.catch()`
  fallbacks so a partially malformed answer degrades to nulls instead of failing
  the import. Prompt demands **null over guessing** — brand/material only when
  visually evident.
- The full raw inference (including confidences and bbox) is stored forever in
  `items.ai_raw` for audit/debug; confidence surfacing in the review UI is a
  Phase 3 item.
- `extractBoundingBox(imagePath)` is a lightweight box-only variant used by
  `scripts/backfill-thumbnails.ts` to re-crop thumbnails of items imported before
  bbox existed, without touching their (possibly reviewed) metadata.

## Provenance — why AI can never overwrite your edits

Every editable field carries a source (`ai` | `user`) in `items.field_sources`.
`applyUserEdits` flips a field to `user` permanently (including clearing it);
`applyAiInference` writes only fields whose source is `ai` or unset and reports
what it skipped. All field writes go through `services/catalog.ts` — raw UPDATEs
on editable fields are forbidden. Unit-tested in `provenance.test.ts`.

Item lifecycle: `draft` (imported, needs review — visible on the Import screen)
→ `active` (confirmed into the Wardrobe) → `archived` (soft-deleted; files and
rows remain on disk).

## Crash recovery

The in-process queue means a crash or restart strands jobs at `queued`/`running`.
On the first import-API touch per process, `recoverOrphanedJobs()` marks any such
job **older than 3 minutes** as `failed` with an honest reason ("interrupted by a
server restart — saved photos are intact"). The staleness cutoff prevents a dev
hot-reload from killing an actively-running import. This deliberately does NOT
live in Next's `instrumentation.ts`: its separate bundling pass pulls imgly's
native binary into the route bundle and 500s the app (observed live 2026-07-15).

## Background removal — how it works now (crop-first + child process + QA gate)

Two problems were found on 2026-07-15 and both are solved (see
`docs/DECISIONS.md`):

1. **Windows crash** — imgly's ONNX runtime + sharp's libvips in one process
   abort the server (uncatchable native conflict). Fix: imgly runs in its own
   node child process (`scripts/bg-worker.mjs`, spawned by
   `imaging/background-removal.ts`, 180 s timeout). The worker must never
   import sharp; a dead worker means "no cutout", never a dead server.
2. **Quality** — imgly output on full-frame photos was garbage (kept
   tripod/feet, smeared dark-on-dark). Fix: it only ever receives the **bbox
   crop**, which turns output product-quality. Residual dark-garment-on-dark-
   sheet smears are caught by `imaging/cutout-qa.ts` (corners + border must be
   transparent, opaque fraction sane); a rejected cutout falls back to the crop.

Image outcome per item: `front`/`back` originals (disk only, never shown in the
UI), `front_cropped`/`back_cropped` (item page), `transparent_front` (when QA
passes), `thumbnail` = cutout > crop > full frame. Cutout thumbnails are
**alpha PNGs** (no baked background — the garment floats on whatever the page
paints); crop/full-frame fallbacks are JPEGs flattened on the app background. `scripts/backfill-images.ts` retrofits all of this onto items
imported earlier (boxes from `ai_raw` or a box-only AI call; never touches
metadata). `PSOS_DISABLE_BG_REMOVAL=1` now just skips the cutout step.

## Storage & data layout

Everything lives under `data/` (gitignored): `stylist.db` (SQLite, WAL) +
`images/<itemId>/<role>.<ext>` where role ∈ front, back, transparent_front,
thumbnail. DB rows store paths relative to `data/images`; `/api/images/[...path]`
serves them traversal-safe. Originals are never deleted or overwritten by the
pipeline. sha256 is stored per image (future duplicate detection). Single-folder
backup: zip `data/` (Settings → Export).

## Environment flags

| Flag | Default | Meaning |
|---|---|---|
| `PSOS_DISABLE_BG_REMOVAL` | unset | `1` = skip background removal stage (required on Windows) |
| `PSOS_IMPORT_CONCURRENCY` | `2` | max simultaneous import pipelines |

## Deployment note

Production instance: GCP VM `psos-1` (e2-small, asia-south1-a), app as systemd
service `psos` (`npm start`, `NODE_ENV=production`, bg removal disabled), port
3000 open only to Dinesh's IP (firewall rule `psos-app`). `data/` was copied from
the dev machine on 2026-07-15 — **the VM copy and the laptop copy do not sync**;
pick one home for real data. AI (chat + import extraction) is **not active on the
VM** until Claude credentials are set up there (open decision — the app works
minus AI; imports would save photos but produce blank metadata).

## Retry

`POST /api/imports/[id]/retry` (UI: Retry button on failed jobs). Re-runs the
whole pipeline from the originals already on disk — derived image rows are
cleared first, provenance still protects user-edited fields. Only `failed`
jobs qualify; if the front photo never landed, the answer is re-upload.

## Duplicate detection (flag-only)

`GET /api/items/[id]/duplicates` compares FRONT photos of non-archived items:
identical sha256 = "identical photo"; perceptual dHash
(`imaging/phash.ts`, 64-bit, Hamming ≤ 10) = "very similar photo". The item
page shows a warning strip linking to suspects. Nothing is ever blocked,
merged, or deleted automatically. Hashes are computed at import
(`save` stage); `scripts/backfill-phash.ts` covers pre-existing items.

## Review visibility

Draft items appear at the top of the Wardrobe screen ("Needs review · N")
as well as on the Import screen, and are editable/confirmable immediately.
Per product decision, per-field confidence values are stored in `ai_raw` but
not surfaced in the UI.

## Known gaps / deliberate cuts

- Bulk upload UI — deliberately cut (2026-07-16): the queue already processes
  any backlog unattended; uploads stay one-at-a-time.
- Category taxonomy wobble (e.g. underwear → "accessory" vs "bottom") — needs
  a vocabulary pass someday.
- VM is behind: needs `git pull`, bg-removal flag removed from `psos.service`,
  Claude login, and a fresh `data/` sync (parked for Phase 3).
