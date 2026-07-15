# Decisions

Significant technical decisions, newest first. Add an entry whenever a choice would surprise
a future reader or was made against a plausible alternative.

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
