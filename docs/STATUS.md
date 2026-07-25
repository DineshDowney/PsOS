# psos — Status & Plan

Living document: what is planned, what is done, where we are. Update as work lands.
Last updated: 2026-07-25.

## Current objective

Cut the import pipeline over to **Gemini** (Vertex AI, API key) for both metadata
extraction and **product-image regeneration**, then regenerate as much of the wardrobe as
possible. All Gemini calls run **on the VM** — never from the laptop.

## Where we are

| Thing | State |
|---|---|
| Password gate (opt-in via `PSOS_PASSWORD`) | Built, tested locally, **not yet deployed to VM** |
| App icon | Done (`src/app/icon.svg`) |
| Static IP `34.100.219.116` | Reserved + attached to `psos-1` (permanent URL) |
| Editorial UI (wardrobe/item/import) | Shipped `5babeec` |
| Trim-and-center cutout thumbnails | Shipped `6aca6f1` |
| BiRefNet segmentation engine | Committed but **parked** (mass-rejected cutouts: suspected double-sigmoid; model file on VM + laptop) |
| Local `data/` | **Degraded** by the aborted BiRefNet run (lost some good cutouts) — to be replaced by VM copy |
| Vertex API key | Rotated clean 2026-07-25; only copy is a local scratch file → goes to VM `.env.local` |
| Gemini integration | **In progress** (this session) |

## Plan for this session

1. ~~Rotate the exposed API keys~~ — done (3 deleted, 1 clean key created).
2. Build locally (no Gemini calls from the laptop):
   - `src/server/ai/vertex-client.ts` — fetch wrapper, API-key auth, model fallback list.
   - `src/server/ai/image-generation.ts` — `generateProductShot(crop)`.
   - `src/server/ai/extraction.ts` — Gemini branch behind `ai.extractionEngine` setting
     (default `claude`, so nothing changes until flipped).
   - `scripts/regenerate-images.ts` — batch regeneration, `--dry-run`, `--only <id>`.
   - `scripts/backfill-images.ts` — regression fix: never delete a passing cutout.
3. VM session: boot, pull, install, write `.env.local`, validate on ONE item, then batch.
4. Sync `data/` back down (fixes the degraded local copy) → Dinesh judges the catalog.

## Image strategy (why generate, then still segment)

Gemini has **no transparent-background output**. So generation does not replace the cutout
step — it replaces its *input*: generate a clean studio product shot on a seamless neutral
background, then run the existing `removeBackground()` → `cutoutQa` pipeline on that. Real
photos (dark garment on dark bedsheet) are the hard case that broke segmentation; a
synthetic clean background is the easy case.

Every stage keeps its predecessor, so nothing regresses:
`front` (original, never shown) → `front_cropped` → `generated_front` (Gemini) →
`transparent_front` (cutout, QA-gated) → `thumbnail`.

## Data layout

- `data/images/<itemId>/<role>.<ext>` — everything the app serves (unchanged convention).
- `data/generated/<itemId>/` — **new**: raw Gemini output archive, kept for provenance/
  history, never served. Code stays in `src/` and `scripts/`; data stays under `data/`.

## Rules that constrain this work

- No HTTP requests to external hosts from the laptop (corporate EDR). VM verification via
  `gcloud ssh` → `curl localhost:3000`; browser checks are Dinesh's.
- The Vertex key never enters chat, git, or `/api/settings` (which is publicly readable).
  It lives in `~/psos/.env.local` on the VM only.
- AI never overwrites user-edited fields (field-level provenance) — unchanged.
- Never delete source photos or good derived images on a failed run.

## Backlog (agreed, not started)

- **Phone-triggered VM wake**: a tiny always-on endpoint (Cloud Function/Run) that calls
  `instances.start` so hitting a URL from the phone boots the VM; open the app ~5 min later.
  Needs a design decision on the trigger surface + auth.
- Retry for partially-failed import jobs (stage failed but job `ready_for_review`).
- Category taxonomy pass (underwear → "accessory" vs "bottom" wobble).
- Cloudflare Tunnel + domain (kills IP-allowlist churn, HTTPS, phone-anywhere).
- Editorial treatment for the remaining 7 screens.
- Modeled editorial shots (needs a reference photo of Dinesh — deferred by choice).
