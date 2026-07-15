# Decisions

Significant technical decisions, newest first. Add an entry whenever a choice would surprise
a future reader or was made against a plausible alternative.

## 2026-07-16 — Import workflow completed: retry, review-gated dedup, drafts in Wardrobe
Retry (`POST /api/imports/[id]/retry`) re-runs the pipeline from on-disk originals — chosen
over resumable per-stage retry for simplicity; every stage is idempotent and the whole run
costs ~30 s. Duplicate detection is deliberately flag-only (per the data-quality philosophy
and the researched skill's "never auto-merge" rule): sha256 for identical files + 64-bit
dHash (`item_images.phash`, Hamming ≤ 10) for same-garment-different-photo; verified live
when a crash-recovered upload turned out to be a second kurta photo and was flagged against
the original. Draft items now render in a "Needs review" strip on the Wardrobe screen;
per-field confidence stays in `ai_raw` only (product call: don't surface it). Cutout
thumbnails switched to alpha PNGs and tiles lost their borders/backgrounds so garments merge
with the page black at any theme.

## 2026-07-15 (later) — Cutouts shipped: crop → child-process imgly → deterministic QA gate
Follow-up to the entry below: imgly turned out fine when fed a PRE-CROPPED garment image and
run in its own child process (`scripts/bg-worker.mjs` — no sharp in that process, so the
Windows GLib conflict can't occur; worker death = skipped cutout, not dead server). Verified
on Windows: clean product-style cutouts, ~3 s/image once weights are cached. Residual risk
(dark garment smearing into dark sheet) is caught by `imaging/cutout-qa.ts` — corners/border
must be transparent, opaque fraction sane — with automatic fallback to the crop, so the worst
case equals crop-only quality. UI policy per Dinesh: raw photos (tripod/feet in frame) never
render anywhere; item page shows `front_cropped`/`back_cropped`, the wardrobe tile shows the
cutout flattened on the app background. `PSOS_DISABLE_BG_REMOVAL` now merely skips the cutout
step. NOTE for next VM boot: remove the flag from `psos.service` and `git pull` — the VM
still runs the flag-on config.

## 2026-07-15 — Photo quality: crop-first via AI bounding box; imgly rejected on quality
imgly runs fine on Linux (~12–17 s/image; the crash is Windows-specific) but its OUTPUT on
real wardrobe photos is poor: monopod/feet kept as "foreground", dark garments smeared into
the dark bedsheet as translucent halos. Verified by eye on three representative cutouts.
Decision: don't harden a tool that produces bad output. Instead the metadata extraction call
now also returns a normalized garment bounding box (`bbox`), and the pipeline re-crops the
thumbnail tight to the garment (`cropToBox`, 8% padding, implausible boxes rejected,
non-fatal). `scripts/backfill-thumbnails.ts` re-crops items imported before bbox existed
using a box-only AI call that never touches metadata. True transparent cutouts remain a
possible later layer (better segmentation, child-process isolated, likely on the VM) —
evaluate after living with crops. Photography guidance that costs nothing: keep the
monopod/feet out of frame.

## 2026-07-15 — Deployed to GCP: e2-small VM, IP-allowlist gate, systemd
psos runs on VM `psos-1` (e2-small, asia-south1-a, Debian 12, 20 GB) as systemd service
`psos`; port 3000 is open only to Dinesh's home IP (firewall rule `psos-app`); SSH via gcloud
keys. Dinesh chose IP allowlist over Tailscale knowing mobile-data access breaks (home Wi-Fi
covers the current use case) and "harden first, deploy, then the rest of Phase 2". `data/`
was copied once on deploy day — no sync exists; the VM copy is intended to become canonical.
AI on the VM is OFF: copying the Claude Code OAuth token was blocked by the permission system
as a credential-exfiltration risk and deliberately left as Dinesh's explicit decision
(options: copy token / log in on VM himself / keep AI laptop-only). A stray half-configured
`psos-server` VM (created from the console at 14:25 IST, before any CLI work) was confirmed
his and deleted. Prod build note: never run `npm run build` while a server is serving from
the same `.next` — it corrupts the running instance (hit twice today).

## 2026-07-15 — Background removal disabled pending process isolation
First real import hard-crashed the entire dev server, twice, reproducibly: loading
`@imgly/background-removal-node`'s ONNX runtime into a process where sharp/libvips is active
aborts with `GLib-GObject-CRITICAL` (native DLL conflict on Windows; try/catch never fires).
Decision: `PSOS_DISABLE_BG_REMOVAL=1` skips the stage (pipeline already degrades gracefully);
the proper fix — running removal in a disposable child process, or swapping the library — is
post-deploy Phase 2 work. Cutouts for already-imported items can be backfilled later from the
stored originals.

## 2026-07-15 — Extraction model pinned to claude-sonnet-5
The unpinned Agent SDK default called a blue V-neck athletic tee a "Teal Ribbed Polo Shirt
with three-button placket" at **confidence 1.0** — confidently wrong, the worst failure mode
for a dataset meant to feed every future AI feature. Pinned `ai.extractionModel` to
`claude-sonnet-5`: 11-for-11 accurate on the first real batch (read "JOCKEY"/"Kiprun"
branding off fabric, recognized a kurta's mandarin collar), with honest sub-1.0 confidence
and 0 where it declined to guess. Latency ~16–23 s/item vs ~10 s — data quality wins.

## 2026-07-15 — Bounded import queue + lazy orphan recovery (not instrumentation.ts)
Uploads now enqueue (`status: queued`) behind `createLimiter` (`PSOS_IMPORT_CONCURRENCY`,
default 2) instead of unbounded fire-and-forget — a phone burst can't stampede one machine
with parallel ONNX/Agent-SDK work. Jobs stuck `queued`/`running` >3 min are auto-failed on
the next import-API touch. Recovery deliberately does NOT live in Next's `instrumentation.ts`:
its separate bundling pass pulled imgly's native `.node` binary into the bundle and 500'd
every API route (observed live). The 3-minute staleness cutoff protects actively-running jobs
from dev hot-reload re-running recovery.

## 2026-07-15 — Next.js dev-tools badge cannot be re-shown programmatically
Hiding the dev indicator via its own menu persists until the dev server restarts; Next ≥15.2
exposes no API to un-hide it (vercel/next.js discussion #76605). Decision: no fake in-app
toggle; pinned the badge to `top-right` via `devIndicators.position` and documented "restart
to restore".

## 2026-07-15 — Cost-per-wear dropped from Analytics
Product call by Dinesh. `price` stays on items in case it returns in another form.

## 2026-07-15 — AI auth: Claude Agent SDK on the machine's Claude Code login
No API key exists on this machine and Dinesh's Claude access is his Claude Code login. The
app's AI layer (`src/server/ai/agent.ts`) wraps `@anthropic-ai/claude-agent-sdk`, which runs
the bundled Claude Code runtime and inherits its credentials. Consequences: zero key
management, usage draws from the same subscription limits as interactive Claude Code, and a
direct-API implementation can later be swapped in behind `agent.ts` without touching callers.
Never introduce API-key handling without asking.

## 2026-07-15 — Outfit generation is a deterministic engine, not an LLM call
`src/server/engine/outfit-engine.ts` scores slotted candidates (color harmony 0.4, formality
0.25, freshness 0.2, rotation 0.15, minus recent-repeat penalty) with greedy-diverse
selection. Instant, free, unit-testable, laundry-aware by construction. Claude uses it as the
`suggest_outfits` chat tool and curates/narrates on top. Weakest part by design: the
color-harmony heuristics encode taste — expect tuning rounds against real feedback.

## 2026-07-15 — Field-level provenance for "AI never overwrites user edits"
Every editable item field carries a source (`ai` | `user`) in `items.field_sources`. User
edits flip a field to `user` permanently (including clearing it); AI inference writes only
`ai`/unset fields (`src/server/services/provenance.ts`, unit-tested). Raw inference +
confidences are kept forever in `items.ai_raw`. All field writes must go through
`services/catalog.ts` — never raw UPDATEs.

## 2026-07-15 — Background removal is cosmetic and swappable
`@imgly/background-removal-node` (local ONNX) behind a one-function interface returning
`null` on failure; pipeline keeps originals and the catalog works without cutouts. Quality on
real garment photos is unproven — if it disappoints, swap the implementation (different ONNX
model or sidecar) without touching the pipeline.

## 2026-07-15 — Single-stack Next.js instead of the originally planned FastAPI split
The Python backend earned its place only for imaging/ML libraries; the TS ecosystem covers
this app's needs (sharp, ONNX runtimes, first-class Agent SDK) and one runtime removes CORS,
codegen, and dual dependency management. Revisit only if imaging quality forces a Python
sidecar (see background-removal decision).

## 2026-07-15 — SQLite via Drizzle, event-sourced wear history
`data/` holds the whole app state (WAL-mode SQLite + images) → single-folder backup, zip
export in Settings. Wear history is event-sourced (`wear_events`); `items.wear_count` /
`last_worn_at` are recomputed caches. Migrations generated by drizzle-kit, auto-applied at
boot.
