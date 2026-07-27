# psos — how it works, and why

The current build, explained end to end. This is the document to argue with: every
non-obvious choice is stated with the alternative it beat and the reason, so each one can
be reviewed on its own.

**Scope.** Present tense only — what the code does *now*. No history, no changelog; the
dated record of how we got here lives in `docs/DECISIONS.md` and is a different kind of
document. Where a decision has a known cost, the cost is stated rather than buried.

**Prerequisite.** `docs/INTRODUCTION.md` covers what the product is and the five ideas
everything here follows from. This document assumes you have read it.

**Reading order.** §1–§3 are the load-bearing structure — the layering, the invariants,
the data model. Everything after that is a subsystem that only makes sense once those are
in your head. §15 is the honest list of what is weak.

---

## 1. Shape: one process, four layers

The whole app is a single Next.js 15 process. There is no separate backend, no worker
service, no message broker, no cache tier. One `next start`, one SQLite file, one folder
of images.

That is a deliberate constraint, not a stage we haven't outgrown. A single-user wardrobe
of a few hundred garments generates no load that needs a second process, and every tier
you add is a thing that can be down, out of sync, or need its own deploy. The cost is
real and shows up twice: background work lives in process memory (so a restart loses the
queue — see §5.6), and there is no horizontal scaling story at all. Both are accepted.

Inside that process, four layers, and **imports only ever point downward**:

```
src/app/**              screens (React) + route handlers (src/app/api/**)
      │  imports
      ▼
src/server/services/**  business logic — catalog, wear, outfits, plans, analytics,
src/server/engine/**    settings, activity, duplicates; the pure outfit + colour engine
src/server/imaging/**   image work; src/server/ai/** model calls; src/server/imports/**
      │  imports
      ▼
src/server/db/**        Drizzle schema + the singleton connection
src/server/lib/**       primitives with no domain knowledge: ids, json, errors,
                        limiter, work-hold, keepalive, upload-limits, login-throttle
```

`src/shared/types.ts` is the one exception to the direction rule: it sits outside the
stack and both sides import it. It holds domain types with JSON columns already parsed
into real types, so a React component and a service agree on the shape of an `Item`
without either owning it.

### 1.1 Why route handlers are thin

Every file in `src/app/api/**` does the same four things and nothing else: parse params,
validate the body with zod, call one service function, return JSON. The rule is that a
route handler contains no logic worth testing.

The reason is reuse, and it is not hypothetical — it is already load-bearing twice:

- **Chat calls services, not HTTP.** `src/server/ai/tools.ts` gives Claude ten wardrobe
  tools. Each one calls the same service function the matching route handler calls
  (`listItems`, `logWear`, `setItemStatus`, `saveOutfit`, `createPlan`, `getAnalytics`).
  If validation or business rules lived in the route, the chat agent would bypass them.
- **The server-rendered wardrobe calls services, not HTTP.** `src/app/wardrobe/page.tsx`
  calls `listItems({})` directly. No fetch, no localhost round trip.

That second one is only possible because of a property of the storage choice: `better-sqlite3`
is **synchronous**. `listItems` is not async. A React server component can call it inline.
This is a genuine, unusual benefit of embedded SQLite over a networked database, and it is
why the wardrobe screen paints with garments already on it instead of a spinner.

### 1.2 Where the process boundaries actually are

Two things run outside the request-handling process, each for a specific reason:

| Boundary | What | Why |
|---|---|---|
| pre-start process | `scripts/boot.ts`, via npm's `prestart`/`predev` hooks | migrations and orphaned-job recovery must finish before anything can serve a request, and a separate process is unambiguously looking at the *previous* run's wreckage. A non-zero exit aborts the launch. See §3.5 and §5.6. |
| systemd timer | `psos-keepalive-check` on the VM | powering the machine off needs root; the app must not have it. See §11.2. |

Everything else — image resizing, flood-fill keying, HTTP calls to Gemini, the Agent SDK —
runs in-process. There are **no native ML runtimes**, which is what removes the whole class
of "two native libraries in one process segfault each other" problems and keeps the
dependency tree small enough to deploy over a slow link.

---

## 2. The invariants

Five rules that other code is allowed to depend on. Breaking one is a design change, not
a bug fix.

### 2.1 Provenance: AI never overwrites a human edit

Every editable field on an item carries a source — `"ai"` or `"user"` — in
`items.field_sources` (a JSON map). The rules, implemented as two pure functions in
`src/server/services/provenance.ts`:

1. A user edit sets that field's source to `"user"`, permanently.
2. AI inference may only write a field whose source is `"ai"` or unset.
3. **Clearing a field is still a user edit.** If you delete the AI's guess at the
   material, the AI does not refill it on the next run.

Rule 3 is the one that is easy to get wrong and the reason `applyUserEdits` compares with
`JSON.stringify(a ?? null) !== JSON.stringify(b ?? null)` rather than `!==` — so
`null` → `null` is not a change, but `"cotton"` → `null` is.

**The enforcement mechanism is a chokepoint, not a check.** There is exactly one way for
a user write to reach an item field (`updateItemFields`) and exactly one way for an AI
write to (`applyInferenceToItem`), both in `src/server/services/catalog.ts`. Neither takes
a "force" flag. A raw `UPDATE` on an editable column anywhere else in the codebase is a
bug by definition.

Why a chokepoint rather than a per-caller check: this is the property the whole product
rests on. You review 24 garments by hand, then a retry or a backfill runs, and if it
silently reverts your corrections you stop trusting the app entirely. There is no partial
version of this guarantee that is worth having.

The `notes` field is outside provenance entirely — it is never AI-written, so it needs no
tracking. `aiRaw` stores the full inference (confidences, boxes) forever, never mutated,
purely for audit.

### 2.2 The AI boundary

Two model providers, and each has exactly one entry point:

- **Claude** — only `src/server/ai/agent.ts` imports `@anthropic-ai/claude-agent-sdk`.
  Auth rides the machine's Claude Code login (`~/.claude`). There is no API key for
  Claude anywhere in this codebase.
- **Gemini** — only `src/server/ai/vertex-client.ts` speaks HTTP to Google. Every other
  AI module goes through it.

Consequences that are relied on elsewhere: swapping Claude for a direct API call is one
file; the chat agent's tool allowlist is enforced in one place (`canUseTool` in
`agent.ts`, default-deny); and no credential handling is scattered across the app.

### 2.3 Never fail silently

Four mechanisms, each covering a different failure surface:

- Route handlers wrap in `withErrorHandling` (`src/server/lib/errors.ts`) → every failure
  is `{ error: { code, message, detail } }` with a real status, never a blank 500.
- The client's `src/lib/api.ts` turns every non-2xx into a thrown `ApiError` carrying the
  server's own message, which the calling screen surfaces as a toast. Nothing is swallowed.
- Pipeline stages persist their own failure reason into `import_jobs.stages`, so a killed
  server leaves an inspectable record rather than a mystery.
- `activity_log` records user, AI and system actions with an actor — it doubles as the
  "what did the AI just do to my data" log.

### 2.4 Degradation over failure

Image work is cosmetic; metadata is a draft. So: background removal returning `null`, the
image model declining, AI extraction throwing — none of these fail an import. Each stage
falls back to the best artifact its predecessors produced, records why, and the pipeline
continues. Only losing the original photos is fatal, because then there is nothing to
review.

### 2.5 The engine decides what is allowed; a model decides what is good

Outfit generation is split, and the split is the invariant. `engine/outfit-engine.ts`
decides what may be worn — active, available, correct slots, freshness, rotation,
recent-repeat penalty — and a model is only ever allowed to **reorder and annotate the
engine's own output**. It returns indices into a shortlist, never items.

So the worst a model can do here is give a bad *order*. It cannot invent a garment,
resurrect one from the laundry, or build an outfit with two pairs of shoes. Every model
answer is put back through `validatePicks` before it is believed, and any failure falls back
to pure engine ranking with a stated reason. See §8.

---

## 3. Data model

SQLite via Drizzle, WAL mode, `foreign_keys = ON`. Schema in `src/server/db/schema.ts`,
generated migrations in `drizzle/` applied before the server starts (§3.5).

**Conventions, uniformly:** UUIDv4 string IDs; ISO-8601 UTC timestamps as TEXT; calendar
dates as `"YYYY-MM-DD"` TEXT; JSON columns are TEXT with typed accessors in the services
layer. No integer timestamps, no BLOBs.

### 3.1 The tables and what each is for

| Table | Holds | Notes |
|---|---|---|
| `items` | one garment | `state` = draft/active/archived, `status` = available/laundry/unavailable |
| `item_images` | every derived and original image | one row per role per item, see §4.2 |
| `item_tags` | style tags | composite PK `(item_id, tag)`, each carries `source` |
| `item_links` | pairs_well / same_set / similar | schema only, no UI |
| `outfits` + `outfit_items` | saved combinations | `source` = user/ai |
| `wear_events` + `wear_event_items` | wear history | event-sourced, see §3.3 |
| `plans` | calendar | one saved outfit on one date |
| `trips` + `trip_items` | travel | schema only, no UI |
| `chat_sessions` + `chat_messages` | transcripts | `sdk_session_id` resumes the Agent SDK |
| `import_jobs` | pipeline progress | per-stage JSON, one per imported item |
| `regen_jobs` | regeneration progress | per-side JSON, see §6 |
| `activity_log` | audit | actor = user/ai/system |
| `settings` | key/value | **world-readable via the API — never a secret** |

### 3.2 Two `state`-like columns on `items`, deliberately

`state` (draft / active / archived) is *lifecycle*: where the item is in the import→review
→catalog→deleted flow. `status` (available / laundry / unavailable) is *availability*:
whether you could wear it today.

Collapsing them into one column was rejected because they are orthogonal — a draft can be
in the laundry, and an archived item's availability is meaningless rather than false. They
also have different readers: `state` drives which screen shows the item, `status` drives
whether the outfit engine will use it.

Archive is a soft delete. `state = "archived"` hides it everywhere; the row, the images and
the wear history all stay on disk. For a personal archive, "I deleted my favourite jacket
by accident" has no recovery story otherwise.

### 3.3 Wear history is event-sourced

`wear_events` + `wear_event_items` are the source of truth. `items.wear_count` and
`items.last_worn_at` are **caches**, recomputed from scratch (`recomputeWearCaches` in
`src/server/services/wear.ts`) on every log and every delete.

Why not just increment a counter: deleting a mis-logged wear has to be correct, and
decrementing gets `last_worn_at` wrong — you'd need the second-newest date, which the
counter does not know. Recomputing is O(wears per item), which for one person is a handful
of rows. Cheap, and it cannot drift.

The caches exist at all because the outfit engine scores every candidate combination on
freshness and rotation, and joining wear events per candidate would be the hot path.

### 3.4 Drizzle enums are TypeScript-only

`text("role", { enum: [...] })` emits no SQL `CHECK` constraint — it is a compile-time
type, nothing more. Verified against the generated SQL in `drizzle/`.

That is a real property to know: **adding a value to one of these enums needs no
migration.** `"thumbnail_back"` was added to `ImageRole` as a pure TypeScript change. The
flip side is that the database will happily store a garbage role if something bypasses the
type system, so the types are the only guard.

### 3.5 Migrations run before the server accepts anything

`getDb()` in `src/server/db/client.ts` opens the connection and runs `migrate()` on first
use, caching the instance on `globalThis` so Next's dev-server module reloads don't open a
second connection.

"First use" would otherwise mean *the first request that touches the database*, which made
a freshly restarted server look half-deployed: the schema was correct but a new table did
not exist until somebody loaded a page, and that is indistinguishable from a migration that
failed.

So `scripts/boot.ts` calls `getDb()` in its own process first, wired as npm's `prestart`
and `predev`. Both `npm start` and `npm run dev` get it, neither can skip it, and a
migration failure exits non-zero and **aborts the launch** rather than starting a server
against a stale schema. Checking the schema straight after a restart is now meaningful.

---

## 4. Images

The largest subsystem, and the one where the most decisions are stacked.

### 4.1 The core bet: redraw, don't segment

The source material is a garment on a bedsheet with a tripod and feet in frame. Two ways
to turn that into a catalog:

1. **Segment it** — run an ML matting model, cut the garment out of the photo.
2. **Regenerate it** — send the photo to an image model and ask for a clean studio
   product shot of the same garment.

We do (2), and (1) is not in the codebase at all. Segmentation preserves everything wrong
with the photo: the crumples, the bedsheet shadows, the fold lines from the drawer. A
perfect matte of a crumpled shirt is still a photo of a crumpled shirt. And on dark garments
against dark fabric it isn't even a good matte — it smears. Keeping it as a fallback meant
carrying two native ML runtimes and a child process to guard against them crashing each
other, in order to produce a picture the redraw exists to avoid. The cutout problem is
solved deterministically instead (§4.3), because the backdrop is one we asked for.

**The cost of this bet, stated plainly: the catalog image is not a photograph of the
garment.** It is a model's redrawing of it. That is why the prompt in
`src/server/ai/image-generation.ts` is split into two fenced sections:

- **PRESENTATION** — pinned down exhaustively (dead-on angle, level shoulders, straight
  parallel legs, soft frontal light, even margin on four sides). What makes a grid look
  designed is not per-image beauty, it is every tile sharing one pose and one lighting
  setup.
- **IDENTITY** — colour, pattern, silhouette, construction, logos: *never change*. The
  prompt explicitly forbids inventing anything the source doesn't show, and says to omit an
  unclear detail rather than guess at it.

The one liberty granted is pressing: the model may smooth away random creases and bedsheet
wrinkles but must keep structural folds (pleats, cuffs, plackets, ribbing). A shot that
looks great but isn't his garment is a failure, not a win.

Temperature is 0.1 — this is a reproduction task, not a creative one.

### 4.2 Image roles, and what each is for

Each item's folder is `data/images/<itemId>/`, and each role is at most one row in
`item_images`:

| Role | Origin | Used for |
|---|---|---|
| `front` / `back` | the upload, normalized (auto-rotate, ≤2048px, JPEG q92) | archive; source of truth; duplicate hashing |
| `front_cropped` / `back_cropped` | `cropToBox` using the AI garment box | **the input to every generation** |
| `generated_front` / `generated_back` | the image model | the item page's first two photos |
| `transparent_front` / `transparent_back` | the cutout ladder (§4.3) | intermediate; the tile is built from these |
| `thumbnail` / `thumbnail_back` | `makeThumbnail` | the wardrobe grid tiles |

A second copy of every generation is archived under `data/generated/<itemId>/<side>-<hash8>.png`
and never served. That is provenance — if a regeneration makes something worse, the previous
output still exists on disk even though its `item_images` row has been overwritten.

**Originals are never deleted or overwritten by any pipeline.** Only the derived roles get
replaced.

### 4.3 The cutout ladder

`src/server/imaging/cutout-ladder.ts` turns a generated shot into a transparent PNG, trying
four rungs in order:

1. **Native alpha** — the prompt asks for a real alpha channel first. If the model honoured
   it there is nothing to do.
2. **Flat-key** — flood-fill the uniform light-grey backdrop we asked for as the model's
   fallback (`src/server/imaging/flat-key.ts`). This is the workhorse; it handles
   essentially everything.
3. **Contrast retry** — regenerate the garment **once** against a pure-magenta backdrop and
   key that instead. Rung 2 only fails when the garment is close in tone to the grey we
   asked for — a cream shirt, an off-white tee — so the fix is to ask for a backdrop the
   garment cannot possibly match, rather than to matte harder around the problem. Magenta
   appears in no garment, which is the entire point. This is a chroma-key backdrop applied
   to **one item on demand** instead of to the whole catalog.
4. **Flat-key that failed QA** — accepted with a warning, because a garment with a small
   artifact beats no replacement at all.

There is deliberately **no ML segmentation rung**. Matting the original photo preserves
everything the redraw exists to remove — the crumples, the bedsheet shadows, the fold lines
— so a perfect matte of a crumpled shirt is still a picture of a crumpled shirt. It also
cost 574 MB of native runtimes and a child process to survive a libvips/ONNX conflict, to
rescue a case that rung 3 addresses at its cause for $0.04.

Two properties worth knowing about rung 3:

- **It is a closure the caller supplies** (`ContrastRetry`), so `imaging/` never imports
  `ai/`. The import pipeline and the on-demand regen service pass the same helper,
  `contrastRetry` in `imaging/regenerate.ts`, so both spend money the same way.
- **It can add ground but never lose it.** If the retry's cutout also fails QA, rung 4 falls
  back to the *original* generation's keyed output — the garment already accepted everywhere
  else. The retry's image is archived for provenance but never becomes `generated_<side>`:
  a garment floating on magenta is an intermediate, and the grey shot is the better one to
  show on the item page.

The elegant part: **`cutoutQa` is the judge at every rung**, so "did the model actually
give us transparency?" needs no separate detector — an opaque image fails the corner and
border checks by definition. One quality definition, four candidates.

`src/server/imaging/cutout-qa.ts` checks four things on the alpha channel: all four corner
patches essentially transparent; the 1px border band mostly transparent; the opaque area a
sane fraction of the frame; and — the subtle one — that partial alpha isn't dominating the
garment interior. A translucent matte renders like an X-ray once composited, which is what
dark fabric on a dark sheet produces.

The opaque upper bound is **caller-tunable**, and the two callers set it differently on
purpose. A tight bbox crop may legitimately fill most of its frame, so the default is loose
(0.92). But a *generated* shot is framed by our own prompt — "an even margin of empty space
on all four sides" — so it can never legitimately fill the frame, and
`GENERATED_MAX_OPAQUE = 0.6` catches surviving backdrop that touches no border and no
corner and would otherwise sail through.

Two numbers inside the flat-key that are worth understanding rather than tuning blindly:

- **Tolerance 20, not 30.** The fill is connected, so one pixel of fabric falling inside
  the tolerance opens a channel and the fill chews a bite out of the silhouette. Measured
  across the wardrobe, 16 of 17 generated fronts key *identically* at 20 and at 30 — so
  the extra reach bought nothing and cost pale garments their shoulders.
- **Erode the kept region by 2px.** The boundary ring the fill keeps is not garment — each
  of those pixels is a codec blend of garment and backdrop. Feathering makes them
  translucent but cannot fix their *colour*, so they read as a bright outline around every
  item. Dropping the ring costs a pixel of garment and removes the halo.

Both of those are the kind of thing that looks like a magic number and is actually a
measurement.

### 4.4 The tile contract

Every catalog tile is **640×640, garment occupying 88%, centred**, produced by
`makeThumbnail` in `src/server/imaging/thumbnails.ts`.

For a transparent input it does something specific: find the bounding box of visible
(alpha > 8) pixels, extract it, resize *that* to 88% of the tile, and composite it centred
on a fully transparent 640² canvas. It does **not** simply `fit: contain` the incoming PNG.

The difference matters because the incoming cutout inherited whatever margin the bbox crop
happened to have. Without the trim-and-recentre, one garment fills its tile and the next
one floats small in the middle, and a grid of those reads as sloppy. With it, every tile is
framed identically regardless of upstream framing — and front/back tiles for the same item
are the same size and position, which is what makes the grid's rotation (§10.7) not jump.

The tile keeps its transparency as PNG. No background is baked in, so the garment floats on
whatever the page paints and the page's colour can change without regenerating anything.

Opaque fallbacks (no cutout available) flatten onto `#f4f1ea` — deliberately the same value
as `--color-surface` in `globals.css`. **These two are not linked by any shared constant**,
because one lives in server-side sharp and the other in a CSS file. They have to be kept in
step by eye; if they drift, items whose cutout failed render as a visibly wrong-coloured
square. Called out here because it is the least defensible seam in the image system.

### 4.5 Serving, and the cache-busting trick

`GET /api/images/[...path]` resolves the relative path through `resolveImagePath`, which
throws unless the resolved absolute path is inside `data/images` — that's the traversal
guard, and it is done by resolution rather than string inspection.

Responses are `Cache-Control: private, max-age=31536000, immutable`. A year. Immutable.

That is only safe because of one thing: **the URL carries a content hash.** `mapImage` in
`catalog.ts` appends `?v=<sha256[0:10]>` to every image URL. The pipeline and the regen
service rewrite bytes at the *same path* (`thumbnail.png` stays `thumbnail.png`), so
without the version parameter a regenerated image would never be picked up by a browser
that had seen the old one. The hash changes, the URL changes, the cache misses exactly
once. `private` rather than `public` because the images are behind the password gate.

---

## 5. The import pipeline

`src/server/imports/pipeline.ts`. One upload = one garment = one draft item + one job row.

### 5.1 The path

```
POST /api/imports (multipart: front required, back optional)
  └─ createDraftItem()            item row, state=draft
  └─ insert import_jobs           status=queued
  └─ enqueue behind createLimiter(PSOS_IMPORT_CONCURRENCY, default 2)
  └─ 201 with the job                              ← returns immediately

  [worker slot free]  status=running
   1. save               originals + a provisional tile      ← ONLY FATAL STAGE
   2. garment_box        locate the garment, write the crops
   3. image_generation   redraw each side as a studio shot
   4. background_removal cutouts via the ladder
   5. colors             dominant colours, read off the CUTOUT
   6. ai_metadata        fields + tags, from the PHOTOS and the studio shots
   7. thumbnail          final tiles, front and back
  status=ready_for_review

GET /api/imports (UI polls) → per-stage progress
user reviews at /items/[id]   → edits flip provenance to "user"
POST /api/items/[id]/confirm  → state: draft → active
```

### 5.2 The stage order is the interesting part

It is not the obvious order, and each position is chosen:

**Colours run after the cutout, not off the raw photo.** `dominantColors` ignores
transparent pixels, so running it on a cutout reports *garment* colours. Running it on the
raw photo reported half bedsheet — and those colours are then fed into the AI prompt as a
cross-check, so a bad reading actively corrupts the metadata downstream.

**Metadata runs after generation, and is sent both.** The extraction call receives the
photographs (cropped, so no bedsheet) *and* the studio shots, in that order, with the prompt
stating plainly that the photograph wins any disagreement about colour, shade, pattern,
print placement, material or branding.

That ordering is load-bearing, and it closes a loop rather than just improving an answer.
Reading metadata off the generated shots alone means a render's drift becomes a recorded
fact — and `regenerateSide` then grounds the *next* generation in that metadata (§6.3). A
colour that shifted once would be reinforced on every retry, drifting further from the real
garment while looking more self-consistent each time. Sending the photograph as the
authority anchors identity to the thing that was actually photographed, while the render
still contributes what it genuinely shows better: silhouette, cut, construction, and text
that a crease had obscured.

**Garment boxes are found before generation**, because the crop is what gets sent to the
image model. Sending the full frame would have the model redraw the tripod too.

**The thumbnail is last**, because it is defined as "the best image we ended up with", and
that isn't known until everything else has either succeeded or given up.

One subtlety in the metadata stage: it does not ask for bounding boxes at all — `garment_box`
already found them with a dedicated, cheaper call against the original full-frame photos, so
the pipeline folds those into the inference before storing `ai_raw`. One call, one job.
Without the fold-in, a future backfill would find no boxes and pay for another AI call to
rediscover them.

### 5.3 "Best available" is defined once

`bestFront(ctx)` and `bestBack(ctx)` express the fallback chain in one place:
cutout → generated → crop → original. Colours and thumbnails both read through them, so
"which image is best" cannot disagree between two consumers. `bestBack` can return `null`
— roughly a third of the wardrobe was imported front-only, and for those the grid simply
does not rotate.

### 5.4 Failure policy

Only `save` is fatal. Every other stage catches its own errors, records the reason into
`import_jobs.stages`, and returns. The job reaches `ready_for_review` even if stages 2–7
all failed — you get a draft with the original photos and a blank form, which is reviewable.

`stages` is a JSON map of `{status, error?}`, merged with the defaults on read so a job
created before a stage existed doesn't render `undefined`.

### 5.5 The queue

`createLimiter(n)` in `src/server/lib/limiter.ts` — a ~30-line FIFO promise limiter. A
rejected task never jams the queue; the next waiting task still starts.

Three limiters exist, at three different levels, and the layering is intentional:

| Limiter | Width | Where | Why |
|---|---|---|---|
| import pipelines | 2 (`PSOS_IMPORT_CONCURRENCY`) | `imports/pipeline.ts` | a burst of uploads lines up instead of stampeding a 2 GB VM |
| regen jobs | 1 | `imaging/regenerate.ts` | keeps job status honest — see §6.4 |
| **image model calls** | **1, process-wide** | `ai/image-generation.ts` | the real constraint |

The innermost one is the important one. Image models are rate-limited **per minute**. Two
concurrent calls mostly buy two 429s and two backoff sleeps (20s/45s/90s each), so strictly
sequential finishes a batch *sooner* than parallel-with-backoff — and costs nothing when
only one import is in flight. It deliberately wraps only the image call; the rest of each
pipeline stays concurrent.

The upload side is limited too, in the browser: `src/components/upload-queue.tsx` sends
strictly one at a time. Parallel uploads over a single relay just split the same bandwidth
while making every progress bar meaningless.

### 5.6 Crash recovery

Both queues (imports and regens) are in-process, so a crash or restart strands jobs at
`queued`/`running`. `recoverOrphanedJobs()` and `recoverOrphanedRegenJobs()` mark any such
job as failed with an honest reason ("interrupted by a server restart — saved photos are
intact").

Two design points:

- **They run in `scripts/boot.ts`, before the server accepts anything.** A separate
  pre-start process cannot be looking at a live job, because there is no live job yet —
  everything it finds is the previous run's wreckage. Same hook as migrations (§3.5).
- **Staleness cutoff, not process start time** (3 min for imports, 10 for regens). This is
  now a second guard rather than the primary mechanism: it protects anyone who runs
  `npx tsx scripts/boot.ts` by hand while a server is up, since a live pipeline updates its
  row on every stage transition, far more often than the cutoff.

### 5.7 Retry

`POST /api/imports/[id]/retry` re-runs the whole pipeline from the originals already on
disk. Derived image rows are cleared first so stages recreate rather than duplicate them.
Provenance still protects anything edited in the meantime. Only `failed` jobs qualify; if
the front photo never landed, the honest answer is to upload again, and the error says so.

### 5.8 Upload size, and a Next.js trap

`MAX_UPLOAD_BYTES` (64 MB) lives in `src/server/lib/upload-limits.ts` and is imported by
**both** the route guard and `next.config.ts`.

It has to be one constant because of how Next behaves when it disagrees with itself: the
middleware matcher covers `/api/imports`, so Next clones the request body, and past
`experimental.middlewareClientMaxBodySize` it does not reject the request — it pushes EOF
into the stream and hands the route a **truncated** body. For multipart that means the
closing boundary is gone and `req.formData()` throws "expected boundary after body". Two
numbers that drift produce a confusing 500 instead of a clear message.

That file is also deliberately dependency-free, because `next.config.ts` is loaded before
the app's module graph exists — importing anything node-specific there breaks `next build`.

Client-side, `src/lib/downscale.ts` shrinks photos to a 3000px long edge before upload.
3000 specifically: the pipeline sends the *crop* to Gemini, so upload resolution sets crop
resolution. A garment filling half the frame yields a ~1500px crop, which is where the
vision path wants to be; a 2000px upload would put it near 1000px and soften logos and
stitching. Bytes drop ~5×. It fails soft — anything unexpected returns the original file,
because shrinking must never be why an import fails.

---

## 6. On-demand regeneration

`src/server/imaging/regenerate.ts` + the Regenerate panel on the item page. Pick front /
back / both, optionally describe what was wrong, get new studio shots.

### 6.1 It shares its core with the batch script

`regenerateSide(itemId, side, context)` is the whole per-side operation: generate → archive
→ cutout → refresh tile. The item page and `scripts/regenerate-images.ts` are two triggers
for one function.

They had drifted into two copies before this, which is exactly how two code paths end up
disagreeing about what a good cutout is. The same consolidation is why
`cutout-ladder.ts` exists.

### 6.2 Always source from the original

`sourcePhoto()` returns `<side>_cropped` if present, else the raw `<side>` photo. It will
**never** return a previous generation.

Regenerating a regeneration compounds drift away from the real garment on every retry —
each pass is a redrawing of a redrawing. The crop is the one fixed anchor to fidelity, so
every attempt starts from it. The practical consequence: three failed attempts do not leave
you further from the truth than one.

### 6.3 What grounds the prompt

`buildPrompt(context)` appends up to two sections to the base prompt:

- **KNOWN FACTS** — category/subcategory, colour + detail, pattern, material, fit, read
  from the item's *current* metadata. Phrased as "trust these over your own read of the
  photo where they disagree", since by regeneration time a human has usually corrected the
  fields.
- **REQUIRED FIX** — the free-text feedback, quoted verbatim, last, framed as overriding
  the defaults above. It goes last because it is the override and should be the final word.

**Brand is deliberately excluded from the facts.** Naming a brand risks the model drawing a
generic version of that brand's logo instead of copying the exact pixels in the photo —
which fights the IDENTITY section's "reproduce it as it appears" rule. This is a guess
about model behaviour rather than a measurement, and it is asserted in a test so at least
the intent can't be lost silently.

The facts are read at **run** time, not queue time. Editing a colour while a job waits its
turn still grounds the generation.

**Byte-identity guarantee:** `buildPrompt()` with no context returns `PROMPT_BASE`
*exactly*, and `image-generation.test.ts` asserts it. The import pipeline's first pass and
the batch script both pass nothing, so they must keep sending precisely the prompt that
produced the existing wardrobe. Without that test, making the prompt context-aware would be
a silent behaviour change for every future import.

### 6.4 Why it is a job rather than a request

A both-sides regen is 1–2 sequential Gemini calls behind a 1-wide limiter, plus a 429
backoff ladder — 15–40s realistically, longer in the worst case. Holding a request open
that long across the Tailscale Funnel relay is an unverified timeout risk. So: POST returns
a job, the client polls `GET /api/regen-jobs/[id]` every 2s while queued or running.

Navigating away loses the poller, not the job. The new photos are simply there next time
the page loads.

Per-side results are persisted **as each side finishes**, so polling shows the front
landing while the back is still generating rather than nothing for 40 seconds.

The job-level limiter is 1-wide for a specific reason: the image call is already 1-wide
process-wide, so a second concurrent job would sit blocked inside that inner limiter while
reporting "running" to the UI. Queueing at the job level keeps the status honest — a job
that has not started yet reads "queued".

Regen jobs get the same lazy orphan recovery as imports, with a longer cutoff (10 min,
because a single side can legitimately go quiet through the backoff ladder).

### 6.5 The API contract

`POST /api/items/[id]/regenerate` takes a `.strict()` zod body: `sides` (non-empty array
of `"front"`/`"back"`) and optional `feedback` (≤2000 chars). Strict mode means an unknown
key is a 400 — for an endpoint that spends money, silently ignoring a misspelled field is
the wrong default. Sides are de-duplicated (`[...new Set(...)]`) so `["front","front"]`
cannot bill twice for one side. The item's existence is checked before anything is queued.

The UI shows the estimate on the button itself (`Regenerate · ~$0.08` at $0.04/side) rather
than in fine print. Cost belongs on the control that incurs it.

---

## 7. The AI layer

### 7.1 Two providers, split by capability

| Job | Provider | Entry point |
|---|---|---|
| garment metadata + bounding boxes | Gemini | `ai/extraction.ts` |
| product-shot generation | Gemini | `ai/image-generation.ts` |
| outfit ranking | Gemini | `services/outfit-stylist.ts` |
| chat | Claude | `ai/chat.ts` |

Everything that looks at a garment runs on Gemini; only chat runs on Claude. That split is
about where each one is paid for as much as what it is good at: chat rides the machine's
Claude Code login and costs nothing per message, while the vision work bills to the Vertex
project and therefore runs on the VM's own service account, where the metadata server is
reachable and the laptop physically cannot spend money.

The consequence to know: **chat only works where a Claude Code login exists**, which is the
laptop, not the VM. Every other AI feature works in both places.

Gemini gets base64-inlined images — there is no filesystem on the other end — and
`responseMimeType: "application/json"` wherever a structured answer is wanted.

### 7.2 Extraction is prompted for correctness over completeness

The schema demands a specific shape and the prompt demands **null over guessing** — brand
only when a logo is legible, material only when inferable from texture. A null is more
useful than a plausible invention, because a plausible invention is one you won't catch
when reviewing.

Two supporting details:

- **Zod with `.catch()` fallbacks everywhere.** A partially malformed answer degrades to
  nulls on the bad fields instead of throwing away the whole extraction.
- **Deterministic colours are a cross-check, not the answer.** The dominant-colour hexes
  are handed to the model with explicit instructions to use them as a cross-check when
  naming colours. Pixel analysis knows the hex; only the model knows that this particular
  hex is "rust" and not "brown".

The category disambiguation list in the prompt (underwear → bottom, overshirt → outerwear,
etc.) exists because those specific cases were observed wobbling.

`extractBoundingBox()` is a deliberate second, cheaper call shape: box only, no metadata.
Backfills need boxes without touching reviewed fields, and one call with one job is easier
to reason about than one call doing two.

### 7.3 The Gemini client is defensive on purpose

`ai/vertex-client.ts` does four things that exist because of observed failures:

1. **Candidate model lists.** Every caller passes an ordered list; the first model the API
   accepts wins and is remembered for the process. Model IDs move faster than this code, so
   a 404 on one candidate is expected, not an error.
2. **Backoff on transient statuses** (429/5xx), with delays of 20s/45s/90s and honouring
   `Retry-After`. It retries the **same** model — switching candidates would only spread
   load onto other rate-limited models.
3. **Auth is environment-only.** `VERTEX_API_KEY` from the environment, or ADC via the GCE
   metadata server (`VERTEX_USE_ADC=1`). Never from `settings`, which is served publicly.
   The ADC path means **no key exists anywhere** on the VM — and the metadata server is
   only reachable from inside the VM, so the laptop physically cannot spend money that way.
4. **Failure messages keep 1200 chars of the response body.** Quota and permission errors
   name the exact limit, and truncating that turns a 30-second diagnosis into guesswork.

### 7.4 Chat

`POST /api/chat/sessions/:id/messages` streams SSE. The server runs the Agent SDK with an
in-process MCP server exposing ten `mcp__wardrobe__*` tools.

Two storage layers, on purpose: the Agent SDK's own session (via the stored `sdk_session_id`)
provides conversational continuity, while `chat_messages` holds the durable transcript we
control and render. Relying only on the SDK session would mean the transcript disappears if
the SDK's storage does.

The allowlist is the ten wardrobe tools and nothing else — the chat agent has no file
access, no shell, no network. `canUseTool` denies by default.

Streaming has a specific shape: text deltas are yielded as they arrive for responsiveness,
but tool uses flush the accumulated text first and are recorded as their own block, so the
stored transcript shows *what the model did* interleaved with what it said.

---

## 8. The outfit engine

`src/server/engine/outfit-engine.ts` is pure: items + context in, scored suggestions out.
No I/O, no randomness except an injectable RNG. That is what makes it the one piece of real
domain logic with meaningful unit tests.

Scoring is a weighted sum:

```
0.40 × colour harmony      (engine/color.ts)
0.25 × formality coherence (spread across the outfit, plus distance from a requested level)
0.20 × freshness           (days since last worn, saturating at 14)
0.15 × rotation balance    (prefer under-worn items)
     − repeat penalty      (exact combos worn recently, decaying with recency)
```

Colour is the heaviest weight because it is the thing a person notices first and the thing
they can't articulate. `engine/color.ts` normalises free-text colour names ("oatmeal",
"oxblood", "cobalt") into ~18 families via regex synonyms, then scores pairs: neutral +
anything = 1.0, complementary = 0.9, analogous = 0.8, same family = 0.75, and the awkward
middle zone (60–150° apart) = 0.35. Unknown colours get 0.6 — benefit of the doubt, so an
uncatalogued item isn't buried.

Two mechanics worth reviewing:

- **Diversity is enforced by greedy selection with an overlap penalty** (maximal-marginal-
  relevance style), not by scoring alone. Without it, the top four suggestions would be the
  same shirt with four different trousers, because the shirt's own score dominates.
- **A tiny random jitter (±0.02)** breaks ties so equal-scored outfits rotate between
  requests rather than returning an identical list forever.

**Why the engine is code and not a prompt.** A model inventing combinations item-by-item
will suggest things you don't own, forget what's in the laundry, and give a different answer
to the same question twice. The engine cannot. Everything above is bookkeeping that has to
be exactly right, which is the one thing deterministic code is unambiguously better at.

### 8.1 What the engine cannot do, and who does it instead

The engine has never seen the clothes. `outfitColorScore` reads the *string* in
`primaryColor` and applies a hue wheel to it. That is a guess about taste dressed up as
arithmetic — and the weights above were chosen by judgement, not validated against anyone's
actual preferences. Determinism is only worth having when the function is right; a
deterministic wrong answer is still wrong.

So `services/outfit-stylist.ts` adds the half the engine cannot do, without giving up the
half it does well:

```
generateOutfits(count: 8)        engine — every candidate is already wearable
   └─ fitToTileBudget            trim to ≤12 distinct garments, whole candidates only
   └─ 256px tile per garment     the model can finally SEE them
   └─ Gemini ranks + explains    returns candidate letters, best first, one reason each
   └─ validatePicks              only letters we actually sent survive
      └─ 0 survivors → engine ranking, with the reason shown in the UI
```

Four things make this safe rather than a regression:

- **The model returns indices, not items.** Its entire vocabulary is "A".."H". It cannot
  name a garment that does not exist or one that is in the wash — those questions were
  settled before it was asked.
- **`fitToTileBudget` drops whole candidates**, never individual images. The prompt numbers
  its items and the images are attached in that order, so sending fewer images than the
  prompt claims would silently misalign every reference.
- **Failure is visible.** No credentials, a model error, unparseable JSON, zero valid picks
  — each falls back to engine ranking and puts the reason on the page. An unstyled list is
  blunter, not broken, and saying which one you are looking at is what stops a degraded
  answer from being mistaken for a bad one.
- **The tests target the boundary, not the taste.** `validatePicks` and `fitToTileBudget`
  are pure and unit-tested; the model's judgement is not testable and is not pretended to be.

What it buys: ordering informed by what the garments actually look like together, and one
concrete sentence per outfit. That sentence is the part the engine could never produce at
any weighting.

Costs, plainly: a suggestion goes from instant and free to a few seconds and a fraction of a
cent, and the returned order is no longer reproducible. Both are acceptable for a deliberate
button press and would not be for a page load — which is why it is a button press.

Chat's `suggest_outfits` tool deliberately calls the **plain engine**, not this. Claude is
already the taste layer in that context; routing it through a second model would be one
model asking another for an opinion it is equally able to form.

---

## 9. The client

React 19, TanStack Query v5, Tailwind v4. No global state library; the query cache *is* the
state.

### 9.1 Query keys and how invalidation works

Keys are `["items", filterString]`, `["item", id]`, `["imports"]`, `["regen-job", jobId]`,
`["wear", id]`, `["duplicates", id]`. Mutations invalidate by prefix: saving an item edit
invalidates both `["item", id]` and `["items"]`, so the grid updates without a manual
refetch.

Polling is driven by `refetchInterval` returning `false` once a job settles, rather than a
`setInterval` the component has to clean up. The regen poller stops itself when status
leaves queued/running.

### 9.2 One screen is server-rendered, and only one

`src/app/wardrobe/page.tsx` is a server component that calls `listItems({})` and
`listItems({ state: "draft" })` synchronously and passes the results into a client island,
`grid.tsx`. It carries `export const dynamic = "force-dynamic"` — **load-bearing**, because
without it Next bakes the wardrobe contents into the build output at deploy time and the
screen never updates again.

The grid keeps `useQuery` for filter changes, seeded with `initialData` on the empty-filter
key only. Filtered keys fetch as normal. `keepPreviousData` is what makes a filter change
cross-dissolve — the old results stay on screen, dimmed, until the new ones land, instead
of blanking to a spinner.

The other eight screens still fetch after hydration. That is an accepted inconsistency: the
wardrobe is the landing screen and the one where a spinner-first paint was actually
annoying. It is also the only server/client boundary in the codebase, which is a new
pattern in an app that had exactly one (everything client).

### 9.3 The upload queue

`src/components/upload-queue.tsx` lives under `Providers`, which wraps every screen and does
**not** unmount on client-side navigation — so an upload keeps running while you move around
the app.

The concurrency rule lives in the **reducer**, not just the worker effect: a transition into
`preparing` is refused while another item is in flight. That makes "one at a time" a
property of the state machine that a test can assert, rather than an emergent property of
effect timing.

It does not survive a tab close or hard reload; `beforeunload` warns. Real durability would
need a Service Worker with Background Fetch, which is far more machinery than one person
uploading garments needs.

Uploads use `XMLHttpRequest` rather than `fetch` for one concrete reason: **fetch cannot
report upload progress in browsers.** An 11 MB photo pair takes 10–15s over the relay, and
a spinner with no number for that long reads as broken.

### 9.4 Errors reach the user

`toApiError` is shared by the fetch and XHR paths so they cannot drift — in particular the
401 handling, which redirects to `/login` rather than toasting. A toast alone strands a
single-user app whose session just expired.

---

## 10. The look

### 10.1 White page, paper tiles

The page is `#fdfdfc`; garment tiles are `#f4f1ea`. That split is deliberate and has a
functional reason beyond taste: **thumbnails are transparent cutouts**, so a cream shirt on
a white page has no edge at all. On paper it gets two separations — the tile against the
page, and the contact shadow beneath the garment.

All colour lives in `@theme` tokens in `globals.css`, so every screen inherits the palette
without a per-screen change.

`--color-accent-fg` exists as a bug fix rather than decoration: three places do
`hover:bg-accent hover:text-*`, and on burgundy the old value was near-black on dark red.

### 10.2 One type scale, and uppercase is rationed

Everything on screen used to be tracked uppercase: page titles, section headers, buttons,
field labels, badges, tag chips, list rows, the import stage names. Roughly 48 elements at
six different tracking values, all between 9px and 12px. The failure mode is not ugliness —
it is that **when almost every string shouts, uppercase stops meaning "important" and just
becomes the font**, so nothing on the page outranks anything else.

The scale lives in `@theme` in `globals.css` as `--text-*` tokens, and the rule it enforces
is a budget:

| Token | Size | Used for |
|---|---|---|
| `text-display` | 34px, `.13em`, weight 300 | **uppercase** — the page `<h1>`, and nothing else |
| `text-nav` | 11px, `.18em`, semibold | **uppercase** — the wordmark and the nav links |
| `text-heading` | 16px, weight 500 | section headings (`SectionLabel`) |
| `text-body` | 15px | prose, inputs, chat |
| `text-meta` | 13px | labels, buttons, list rows, captions — the workhorse |
| `text-micro` | 11px | badges, provenance marks, tooltips. The floor |

**Three roles keep tracked uppercase — the h1, the wordmark, the nav.** Everything else is
sentence case. The masthead only reads as a deliberate choice when it is rare.

### 10.3 Three surface tiers

The same failure in another dimension: `border border-line` was on cards, buttons, inputs,
badges, chips, list rows and 9px sub-buttons alike, so a container and a control were
visually the same object.

- `.card` — a raised region. Paper, **no border**, a warm two-stop shadow.
- `.well` — a recessed slot inside a card: thumbnails, progress tracks, empty image frames.
- `border-line` — demoted to dividers, and to controls that need an edge to read as
  clickable.

Radius is a flat 2px everywhere it appears. Focus is a real `:focus-visible` accent outline;
before this, inputs had `outline-none` with only a border change and buttons had nothing.

### 10.4 Motion is CSS-only

No animation library. Everything that moves:

| Effect | Trigger |
|---|---|
| garment rests at `scale(0.94)`, rises to `scale(1)` | `group-hover` |
| contact shadow deepens in step | `group-hover` |
| tiles fade in and rise 12px on a 40ms stagger | mount, `--i` set inline |
| toasts arrive from below | mount |
| skeletons sweep a highlight left-to-right | while loading |
| the nav's active bar slides between items | client navigation, via `view-transition-name` |
| buttons scale to 0.95 | `:active` — reaches touch and mouse alike |

The stagger is **capped at 12** in `ItemCard` — otherwise tile 40 waits 1.6 seconds to
appear, and a "lively" grid becomes a slow one.

`.garment-shadow` is applied only to `.png` URLs (via `garmentShadowClass`), because it is
a `drop-shadow` filter that hugs the alpha silhouette. On an opaque JPEG fallback it would
outline a rectangle.

The nav marker is one element with `view-transition-name: nav-marker`; because exactly one
exists in the DOM at a time, the browser tweens it from the old nav item to the new one for
free on a client navigation.

One `@media (prefers-reduced-motion: reduce)` block at the bottom of `globals.css` disables
every one of these, including the view transitions. Anything added later that moves belongs
in that block too.

### 10.5 Loading states hold the layout

Two screens used to blank the entire page to a bare `<Spinner label="Loading" />` — no
title, no structure. The rest rendered `data ?? []`, so you got an empty shell that filled
in. Over Funnel with the VM cold that is 1–3 seconds of nothing.

`Skeleton` / `SkeletonGrid` in `ui.tsx` hold the real geometry instead, and the analytics
and item pages keep their heading and column structure while they wait. The Power card
reserves its own height rather than returning `null`, which used to shove the sections below
it down when the first poll landed.

Mutations report themselves through `Button`'s `loading` prop — a fixed-size inline spinner.
Every caller previously swapped its own label ("Save changes" → "Saving…"), which loses the
label exactly when you want to confirm what you pressed and resizes the button more than the
spinner does. Several mutations reported nothing at all: laundry computed `move.isPending`
and never used it.

### 10.6 Provenance is visible where you would act on it

§2.1 is the app's load-bearing rule, and the item page showed it on **one field of fourteen**.
`Field` now takes a `source` prop and renders an `AI` mark for any field the model wrote.

Only `ai` renders. Marking user-owned fields too would badge almost every row and say
nothing — the useful signal is "this was guessed, check it", and it disappears the moment
you edit, because that edit flips the field to `user` and AI can never overwrite it again.

The item page also gained a save bar that rides in only when the form is dirty. Save used to
sit at the bottom of a 14-field column with nothing indicating unsaved work, so editing the
colour at the top and navigating away lost it silently.

### 10.7 The front/back flip has two independent triggers

Both tile images are stacked with `absolute inset-0` and only **opacity** animates — no
layout shift, and no risk of a size flash, since §4.4 guarantees both tiles are identically
framed.

- **Desktop:** pure CSS, `.group:hover .flip-back { opacity: 1 }`, gated behind
  `@media (hover: hover) and (pointer: fine)`. Instant, free, no JavaScript.
- **Touch:** `useAutoFlip` runs a 4.2s timer, staggered by grid position so the wall doesn't
  blink in unison. It checks the same media query and **returns early on hover-capable
  devices**, so the two triggers never fight — a timer flipping a tile mid-hover-transition
  reads as a glitch. It also returns early under reduced motion.

### 10.8 Names are hidden, not deleted

No screen renders `item.name`. `itemLabel(item)` — `primaryColor · subcategory ?? category`
— is the single definition, with fallbacks through the name to `"Untitled"` so a bare draft
never renders an empty row. The full name is kept as a `title` tooltip.

The column, the editor field, the AI inference and search all still use the name; `listItems`
matches name/description/brand/subcategory, so hiding it costs no searchability.

**Known cost:** labels aren't unique. Two pairs of blue jeans become one indistinguishable
row in the analytics bars. That's why analytics keys its rows by `label + index` rather than
label — a real collision that would silently drop a bar otherwise.

### 10.9 The item page photo order

`orderedPhotos(item)`: generated front, generated back, then the two originals. Each of the
first two slots falls back through `transparent_*` → `*_cropped`, degrading the same way the
rest of the pipeline does rather than disappearing.

Four ways drive one index — auto-cycle, arrows, swipe, dots — and **any manual navigation
stops the auto-cycle permanently**. A carousel that yanks itself forward a second after you
deliberately chose a photo is the most irritating thing that component could do. The index
is also clamped when the photo list shrinks, since a regeneration can change how many slots
exist.

---

## 11. Deployment and the cost problem

Production is a GCP VM (`psos-1`, asia-south1-a, e2-small) running the app as the systemd
service `psos`. Reachable over Tailscale Funnel — no inbound firewall port, no static IP.

### 11.1 Everything the VM needs is in the repo

`deploy/vm/` holds the units, the timer and the keepalive script. These were previously
typed straight onto the box, which meant a rebuilt VM would have silently lost them.

Two configuration facts that are load-bearing and non-obvious:

- **`tailscale up --accept-dns=false`.** MagicDNS rewrites `/etc/resolv.conf`, and the app
  resolves `metadata.google.internal` for Vertex ADC. Letting Tailscale own DNS breaks image
  generation.
- **`PSOS_BEHIND_TLS=1`.** One flag for one deployment fact, read in two places: it makes the
  session cookie `Secure`, and it makes `x-forwarded-for` trustworthy for login throttling.

Funnel was re-evaluated against every GCP-native ingress and **kept on cost and parts count**,
not inertia: an external Application Load Balancer is $18.25/mo minimum and bills while the VM
sleeps, and Google-managed certificates cannot attach to a bare VM at all. Numbers and the
rejected alternatives are in `docs/DECISIONS.md` (2026-07-27) — read that before reopening it.

The VM is asleep most of the time, so **the public URL is dead most of the time**, and nothing
about the ingress changes that: when the machine is off there is no process anywhere to answer.
Waking it is a deliberate manual act — `scripts/vm-start.cmd` from the laptop, or the Google
Cloud app from a phone.

### 11.2 The keepalive chain

The VM powers itself off when idle, because an always-on box costs money for nothing. That
is fine until a 20-garment import is halfway through, or you're sitting reading a screen.

The mechanism is one file holding one number: `/run/psos/keepalive`, a UNIX-ms **deadline**.

```
app (server) ──── holdFor(ms) ────► /run/psos/keepalive   (deadline, tmpfs)
                                            │
browser ─── POST /api/system/power ─────────┘
                                            │  read every 30 min
                            psos-keepalive.timer → psos-keepalive-check (root)
                                            │
                              cancel / arm `shutdown -h +40`
```

Design points, each of which is a decision:

- **A deadline, not a touch/mtime.** "Hold for 4 hours" is then the same operation as the
  10-minute heartbeat with a bigger argument, and `holdFor` only ever moves the deadline
  *forward* — so a short beat can never cut a long hold short.
- **`releaseHold()` / `DELETE /api/system/power` is the escape hatch that rule needs.**
  Forward-only is correct for the heartbeat and wrong for a mis-click: a stray "hold for 4
  hours" pinned the machine up, and billing, for four hours with no way back. Releasing is
  not the same as powering off — it means "nothing is asking me to stay up", so the next
  30-minute check arms the normal grace shutdown, and using the app afterwards starts holding
  it again.
- **`/run/psos` comes from systemd's `RuntimeDirectory=psos`**, owned by the service user.
  That is why nothing in the app needs sudo or a setuid helper. It is tmpfs, so the flag can
  never end up in a `data/` backup and never survives a reboot. Both correct.
- **Everything degrades to a no-op when the directory is absent** — which is how the Windows
  dev machine and `npm test` see it. Nothing in `keepalive.ts` may throw; a failed keepalive
  write must never become a failed import.
- **The script's third branch is the whole reason it is a script.** If a hold is stale and a
  poweroff is *already armed*, leave it alone. Re-arming "+40" on every check would push the
  poweroff forward forever and the VM would never sleep — the exact opposite of the point.
- **`psos-autostop.service` fires `shutdown -h +60` at boot** as a backstop, so there is
  never a window with nothing armed.

Two producers write the flag, and they are different in kind:

- **`work-hold.ts`** — server-side, counts in-flight background work. `workStarted()`
  increments and starts a 5-minute ticker; `workFinished()` decrements and stops the ticker
  at zero. Both the import pipeline and the regen service call it, and it must be **one
  shared counter** — two copies would each run their own ticker against the same file and
  "is anything still running?" would be split across modules that cannot see each other. It
  ticks rather than writing per step because a single step can go quiet for many minutes
  (1-wide image calls plus a 90s backoff), while being entirely healthy. It is
  self-terminating by construction, which is what makes "queue 20 imports and close the
  laptop" safe.
- **`components/keepalive.tsx`** — client-side, and its rule is stricter than it looks. A
  beat requires **both** a visible tab **and** a pointer/key/scroll event since the last beat.
  "Any HTTP request counts" is a trap and was the reason idle shutdown was rejected the first
  time: the import screen polls every 2–10s, so a forgotten background tab would hold the
  machine up forever and quietly bill for it. Walk away and it sleeps.

**The Settings card is the only place any of this is visible.** It offers 30 min / 2 h / 4 h,
a Release, and a countdown that ticks locally against a sampled server-time offset — every
deadline in the payload is server-time, the device clock can be minutes out, and a number
that sits still for a 20-second poll and then jumps twenty seconds reads as broken.

There is deliberately **no "power off now" button**. The app runs unprivileged; the only
thing that can call `shutdown` is the root-run timer script, which fires every 30 minutes. An
in-app button could therefore only honestly promise "within half an hour", and a control that
lies is worse than no control. `scripts/vm-stop.cmd` and the Google Cloud app both do it
properly. Making it real would need a narrow sudoers grant on the VM — not taken.

### 11.3 Data does not sync

`data/` on the laptop and `data/` on the VM are two independent copies. Nothing reconciles
them. This is the single largest operational risk in the system and is called out again in
§15.

---

## 12. Security posture

Single user, internet-reachable, so the surface is small but not zero.

- **Password gate in middleware** (`src/middleware.ts`). Opt-in: unset `PSOS_PASSWORD` (local
  dev) gates nothing; set (deployed) gates every page and API route except the login flow.
  The session token is a deterministic HMAC-SHA256 of a fixed label under the password — a
  plain string compare of the presented cookie against it leaks nothing usable, since both
  sides derive from the server-side secret.
- **Login throttling** (`src/server/lib/login-throttle.ts`) is a **progressive delay, not a
  lockout**. A lockout would let anyone who can reach the port lock Dinesh out of his own
  wardrobe — trading a remote risk for a guaranteed annoyance. Three free attempts, then
  exponential delay to a 5s ceiling. A correct password clears the cost.
- **`x-forwarded-for` is only trusted behind a real proxy**, and takes the **last** hop, not
  the first. The header accumulates left-to-right, so the rightmost entry is the one our own
  proxy appended; reading the leftmost would let an attacker rotate the throttle key on every
  request. Without `PSOS_BEHIND_TLS`, everything shares one bucket — the honest fallback.
- **No secrets in the database.** `settings` is served publicly by `GET /api/settings`. Keys
  live in the environment only: `/etc/psos.env` (root-owned, 0600) on the VM, and Vertex
  needs no key at all thanks to ADC.
- **Path traversal is prevented by resolution**, not string inspection — `resolveImagePath`
  resolves and then verifies the result is inside the images root.
- **The chat agent is default-deny** on tools, with no file or shell access.

---

## 13. Testing

129 tests across 18 files (`npm test`), plus `npm run typecheck` and `npm run build`.

What is tested is **pure logic with real decisions in it**:

| Area | What it protects |
|---|---|
| `provenance` | the §2.1 invariant, including "clearing is an edit" |
| `outfit-engine`, `color` | scoring, diversity, colour families |
| `limiter` | FIFO order, concurrency ceiling, rejection doesn't jam the queue |
| `keepalive` | `holdFor` never moves a deadline backward |
| `login-throttle` | the delay curve and the shared-bucket fallback |
| `cutout-qa`, `flat-key`, `thumbnails`, `phash` | image heuristics against generated fixtures |
| `cutout-ladder` | which rung fires, and **that the paid rung does not fire when a free one worked** |
| `outfit-stylist` | `validatePicks` rejecting anything we did not send; tile-budget trimming |
| `image-generation` | **prompt byte-identity with no context** (§6.3) |
| `regenerate` | fact formatting, and that brand never appears |
| `upload-queue` | one-at-a-time as a reducer property |
| `ui` | `itemLabel` fallback chain, `orderedPhotos` ordering |
| `downscale` | the resize arithmetic, without a browser |
| `import-progress` | that a degraded stage does not make a live import look dead |

What is **not** tested, honestly:

- **Every route handler.** They are thin by policy, so the logic under them is covered — but
  the zod schemas themselves have no unit tests, and a wrong schema would pass typecheck.
- **Anything requiring a model call.** Extraction quality, generation fidelity, prompt
  effectiveness and outfit *taste* are judged by looking at results, not by assertions. For
  the stylist this is deliberate: the boundary around the model is tested, its judgement is
  not, because a test that asserted "these two garments go together" would be encoding the
  same unvalidated taste the engine was criticised for.
- **All rendering.** No component tests, no visual regression — but the look is no longer
  judged only by reading code. `npm run shots` (`scripts/shots.ts`) drives the Edge already
  on the machine through `playwright-core` and writes a full-page PNG of every screen at
  1440px and 390px. `playwright-core` rather than `playwright` on purpose: the latter
  downloads its own ~150MB Chromium, and devDependencies are installed on the VM because
  `npm run build` needs them.

  Two things the harness cannot see. It shoots against the LOCAL database, which holds the
  seeded placeholder wardrobe — flat shapes on opaque black squares — so the paper tile and
  the contact shadow, both of which exist for transparent cutouts, are invisible in a shot.
  And a full-page screenshot renders the whole document, so `position: sticky` elements
  appear at their static position rather than pinned.
- **The migration path.** Migrations are applied and verified by hand against a backup.

---

## 14. How a change flows through

A worked example, because the layering only becomes obvious when traced. *You edit an
item's colour and regenerate the back:*

```
PATCH /api/items/[id]                    route: zod-validate, call one service fn
  └─ services/catalog.updateItemFields()
       └─ provenance.applyUserEdits()     colour source: "ai" → "user", permanently
       └─ UPDATE items                    the only place this write can happen
       └─ activity_log                    actor=user
  ← { item }
client: invalidate ["item", id] + ["items"]  → item page and grid both refresh

POST /api/items/[id]/regenerate {sides:["back"], feedback:"..."}
  └─ imaging/regenerate.startRegenJob()
       └─ getItem()                       404 before spending anything
       └─ INSERT regen_jobs               status=queued
       └─ work-hold.workStarted()         VM will not power off from here on
       └─ limiter(1) ──► runRegenJob()    async; request returns now
  ← { job }                               client polls every 2s

  [job runs]
   itemFacts(getItem(id))                 reads the EDITED colour — run time, not queue time
   regenerateSide(id, "back", {facts, feedback})
     └─ sourcePhoto()                     back_cropped — the ORIGINAL, never a generation
     └─ ai/image-generation               buildPrompt(base + facts + feedback)
          └─ imageCallLimiter(1) ──► vertex-client (candidate models, 429 backoff)
     └─ archive to data/generated/
     └─ upsert generated_back
     └─ cutout-ladder                     native alpha → flat-key → contrast retry → warn
     └─ upsert transparent_back
     └─ makeThumbnail(alpha)              640², trim to alpha bbox, 88%, centred
     └─ upsert thumbnail_back             new sha256 → new ?v= → browser cache misses once
   UPDATE regen_jobs results              persisted per side
   status=done
       └─ work-hold.workFinished()        ticker stops if nothing else is running

client: job settles → toast → invalidate ["item", id] + ["items"]
```

Every arrow in that trace crosses exactly one layer boundary downward.

---

## 15. Weak points — the review list

Ordered by how much they'd cost if they bit.

1. **`data/` on the VM is the only copy of the wardrobe.** No off-machine backup, no sync
   between laptop and VM. A disk failure loses every photo and every reviewed field. This is
   the highest-risk item in the system by a wide margin and it is not an engineering-hard
   problem — it is unstarted.
2. **The tile background colour is duplicated by hand.** `#f4f1ea` appears in
   `thumbnails.ts` (server, sharp) and in `globals.css` (client, CSS) with no shared source
   of truth. If they drift, every item whose cutout failed renders a wrong-coloured square.
3. **The catalog images are model output, not photographs.** The prompt fences identity
   hard, but nothing *verifies* fidelity. A generation that subtly changes a placket or drops
   a pocket is caught only by eye. There is no automated check and no obvious cheap one.
4. **Cutouts now depend on one mechanism plus a paid retry.** With no segmentation fallback,
   a garment that defeats both the grey flat-key and the magenta retry gets a QA-warned
   cutout and nothing better. Rung 3 has never fired against the real wardrobe — there was
   no failing case to build it against — so it is untested in the only way that counts.
   Failure mode is cosmetic and reported, not silent, which is why this sits at 4 and not 1.
5. **In-process queues lose their backlog on restart.** Orphan recovery marks the jobs failed
   honestly, but "failed" here means "you have to press retry", not "it resumed".
6. **`scripts/regenerate-images.ts` has not been migrated onto `regenerateSide`** and still
   carries a front-only tile-refresh bug that has already been fixed twice in sibling scripts.
   The exact drift that §6.1 exists to prevent, still present in one place.
7. **Image load time on the wardrobe grid is unmeasured.** It feels slow. There are at least
   two plausible causes (the always-mounted back `<img>` double-fetching, and 23 transparent
   PNGs simply being a lot of bytes) and no measurement distinguishing them. Deliberately
   parked rather than guessed at.
8. **Labels are not unique** (§10.8). Accepted for a 24-item wardrobe; it degrades as the
   catalog grows.
9. **`?v=` cache-busting depends on `sha256` being populated.** Any writer that inserts an
   image row without a hash produces a permanently-cached URL that never updates. The upsert
   helpers all set it; nothing enforces it.
10. **`prefers-reduced-motion` coverage is by convention.** One CSS block lists every animated
    class by name. A new animation that forgets to register there silently ignores the
    preference.
11. **Eight items have no back photo.** Not an engineering problem — they need photographing —
    but it means a third of the grid does not rotate and their Back regen option is hidden.
12. **Chat runs only where a Claude Code login exists**, i.e. the laptop. On the VM — the only
    machine with the wardrobe on it — the chat screen cannot answer. Porting it to Gemini
    function calling is understood and deliberately not done yet.
13. **The stylist's shortlist bounds what it can suggest.** The model reorders eight engine
    candidates; it cannot propose a ninth. That is what makes it safe, and it also means a
    genuinely great combination the engine never enumerated stays invisible. Raising
    `SHORTLIST`/`MAX_TILES` trades cost and prompt noise for reach; both are single constants.

---

## Appendix: environment flags

Every knob the app reads. Anything not listed here has no effect.

| Flag | Default | Meaning |
|---|---|---|
| `PSOS_PASSWORD` | unset | the single-user gate. Unset = no login screen (local dev). Root-owned `/etc/psos.env` on the VM |
| `PSOS_BEHIND_TLS` | unset | `1` when something else terminates TLS (Funnel). Makes the session cookie `Secure` and makes `x-forwarded-for` trustworthy — §12 |
| `PSOS_IMPORT_CONCURRENCY` | `2` | max simultaneous import pipelines — §5.5 |
| `VERTEX_API_KEY` | unset | Gemini key. Environment only, **never** from `settings` |
| `VERTEX_USE_ADC` | unset | `1` = authenticate via the GCE metadata server instead of a key. How the VM works, and why no key exists there |
| `VERTEX_TEXT_MODELS` | unset | comma-separated override for the text/vision candidate list |
| `VERTEX_IMAGE_MODELS` | unset | comma-separated override for the image-generation candidate list |
| `GEMINI_API_HOST` | public endpoint | override the API base URL |

---

## Appendix: where things live

| Concern | File |
|---|---|
| Schema, migrations | `src/server/db/schema.ts`, `drizzle/` |
| DB connection (singleton) | `src/server/db/client.ts` |
| Boot tasks: migrate + recover orphans | `scripts/boot.ts` (npm `prestart` / `predev`) |
| Provenance rules (pure) | `src/server/services/provenance.ts` |
| All item field writes | `src/server/services/catalog.ts` |
| Import pipeline, queue, recovery | `src/server/imports/pipeline.ts` |
| On-demand regeneration | `src/server/imaging/regenerate.ts` |
| Cutout ladder / QA / flat-key | `src/server/imaging/{cutout-ladder,cutout-qa,flat-key}.ts` |
| Tiles, crops, normalization | `src/server/imaging/thumbnails.ts` |
| Product-shot prompt + generation | `src/server/ai/image-generation.ts` |
| Metadata extraction (Gemini) | `src/server/ai/extraction.ts` |
| Gemini HTTP client, shared model list | `src/server/ai/vertex-client.ts` |
| Claude Agent SDK wrapper (chat only) | `src/server/ai/agent.ts` |
| Wardrobe tools for chat | `src/server/ai/tools.ts` |
| Outfit scoring (constraints) | `src/server/engine/outfit-engine.ts`, `engine/color.ts` |
| Outfit ranking (taste) + validator | `src/server/services/outfit-stylist.ts` |
| Concurrency, VM hold, keepalive | `src/server/lib/{limiter,work-hold,keepalive}.ts` |
| Auth gate | `src/middleware.ts`, `src/server/lib/login-throttle.ts` |
| Shared UI primitives, labels, ordering | `src/components/ui.tsx` |
| Design tokens + motion | `src/app/globals.css` |
| Typed fetch + upload with progress | `src/lib/api.ts` |
| VM units, timer, keepalive script | `deploy/vm/` |
