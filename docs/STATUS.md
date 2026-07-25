# psos — Status & Plan

Living document: what is planned, what is done, where we are. Update as work lands.
Last updated: 2026-07-25.

## Current objective

**Phase closed 2026-07-25.** The wardrobe is regenerated as clean studio product shots, and
*new uploads get the same treatment automatically* — Gemini for both metadata and imagery,
running on the VM, reachable from any device behind a password.

Next phase starts from the backlog at the bottom.

## Where we are

| Thing | State |
|---|---|
| **Upload → catalog, end to end** | **Proven live 2026-07-25** on the VM over HTTP through the password gate: all 7 stages green in ~40 s, all 9 image roles written, Gemini metadata correct |
| **Wardrobe regenerated** | Every item, front and back, as a generated transparent cutout. First pass 24/24; re-run after the prompt + halo fixes |
| Import pipeline | 7 single-purpose stages over one context object (`imports/pipeline.ts`); colours + metadata read the CLEAN generated image, not the raw photo |
| Prompts | Rewritten. Image = PRESENTATION (one pose/light/framing for every garment) vs IDENTITY (untouchable). Metadata = naming convention + category disambiguation + specific colour names |
| Cutout quality | Sheared-mask bug fixed (finding 8); bright halo on the dark grid fixed (finding 10) |
| Gemini rate limits | Same-model backoff 20/45/90s honouring `Retry-After`, plus 5s batch pacing and `--missing` to retry a partial run |
| App on VM | Running at **`http://34.100.219.116:3000`**, commit `4e43ddc` |
| Password gate | **ACTIVE.** Root-owned `/etc/psos.env` via `EnvironmentFile`; no rebuild needed (verified). Rotate with `psos-set-password` on the VM |
| Login brute-force cost | Progressive delay on `/api/auth/login`, deliberately **not** a lockout |
| Firewall `psos-app` | **tcp:3000 from `0.0.0.0/0`** — opened password-first, so the app works from any device including his phone |
| Billing account `01BB42-93FE43-97EFA2` | Open; trial-upgrade credit valid to 2026-10-14 |
| Static IP `34.100.219.116` | Attached to `psos-1`. ~$7/mo — **open question: keep or release?** |
| VM shutdown | Hard 60-min autostop at boot (`psos-autostop.service`). Idle-based shutdown was considered and **rejected** by Dinesh |
| BiRefNet segmentation | **Dropped** as a direction; opt-in via `PSOS_BG_ENGINE=birefnet`, imgly is the default |
| Editorial UI (wardrobe/item/import) | Shipped `5babeec` |
| App icon | Done (`src/app/icon.svg`) |

## Live findings (2026-07-25 session)

Verified against the real API / real images, in order:

1. **API keys do not work on the Vertex REST surface.** `aiplatform.googleapis.com/v1/projects/…`
   returns 401 "Expected OAuth2 access token". An AI Studio key belongs to the Gemini
   Developer API (`generativelanguage.googleapis.com`).
2. **The AI Studio project (`tensile-market-502810-v9`) is blocked**: 403 "Your project has
   been denied access" on every model. Abandoned it.
3. **A key minted in the psos project reaches text models** (`gemini-flash-latest`,
   `gemini-3.6-flash`, `gemini-3.5-flash` all 200), so extraction via Gemini is viable.
4. **The Gemini API free tier has zero image quota** — every image model returned 429
   `GenerateRequestsPerDayPerProjectPerModel-FreeTier`. Cloud billing enabled ≠ paid tier.
5. Model ids in the defaults were stale; they now come from a live `listModels()` call
   (`scripts/vertex-probe.ts` prints what the current credentials can reach).
6. **Root cause of 1–4: the billing account was CLOSED** (`"open": false`) while the project
   link still reported `billingEnabled: true` — the *link* existed, the *account* was shut.
   Dinesh reopened it; the ₹28,157 `FreeTrialUpgrade` credit (valid to 2026-10-14) is scoped
   to that same account, which is why opening it beat creating a new one.
7. **Auth that works on the VM: no key at all.** `VERTEX_USE_ADC=1` + the instance metadata
   server, with the VM on `--scopes=cloud-platform` and `roles/aiplatform.user` on
   `145415295830-compute@developer.gserviceaccount.com`. The laptop physically cannot make
   these calls, which is the point.
8. **The "no cutout passed QA" failure was a sharp bug, not an image problem.**
   `sharp(...).blur()` runs in sRGB, so blurring a **1-channel** raw buffer hands back
   **three** channels. `joinChannel(alpha, {channels: 1})` then read the first third of an
   interleaved RGB buffer and produced a sheared, geometric mask instead of the garment
   silhouette — while `keptFraction` still looked perfectly healthy (45.6%), which is what
   made it read like a contradiction. Fixed with `.toColourspace("b-w")` plus a hard length
   assertion, and covered by two new tests (the existing four all used `feather: 0`, so they
   never touched the broken path). Same family as the `removeAlpha()` + `joinChannel()` trap
   in `thumbnails.ts` — **sharp chains silently change channel counts; always assert.**

9. **Vertex image models are rate-limited per minute, and it bites hard in a batch.**
   The first full run generated 14 of 24 images and lost the other 10 to HTTP 429
   `RESOURCE_EXHAUSTED` — a QPM limit, not billing. Fixed properly: `generateContent()`
   now retries the SAME model on 429/5xx with 20s/45s/90s backoff (honouring `Retry-After`),
   and the batch paces itself (`--delay`, default 5s). Retrying the same model matters —
   falling through to other candidates just spreads load onto equally throttled models.
   The retry run then completed 10/10. Two 429s still occurred mid-run and were simply
   waited out.

10. **Every cutout wore a bright halo on the dark grid, and it was structural.** Measured on a
    real tile: semi-transparent edge pixels at luminance **158** against a garment at **30**.
    The boundary ring the flood fill keeps is not garment — each pixel is a camera/codec blend
    of garment and light backdrop — and feathering makes it translucent without fixing its
    COLOUR. `keyFlatBackground` now erodes the kept region 2px before feathering, so the soft
    edge is built from real garment pixels: same tile after, **30.9** against 29.8. The
    plausibility check had to move BEFORE erosion, since erosion always trims the ring and was
    starting to make a total keying failure look like a 3% success.

11. **A new upload was getting good metadata and a bad picture.** The pipeline never called
    Gemini for imagery — `generateProductShot` lived only in the batch script — so uploads
    still segmented the crumpled photo. Worse, segmentation preferred BiRefNet, whose worker
    crashes on the VM, so a fresh upload there was *guaranteed* no cutout. Now wired as a
    first-class stage, and proven live end to end.

## Import pipeline as built

Seven single-purpose stages over one context object (`imports/pipeline.ts`):

`save → garment_box → image_generation → background_removal → colors → ai_metadata → thumbnail`

The order is load-bearing and not the obvious one: **colours and metadata come last**, read off
the cutout and the generated shot, because `dominantColors` ignores transparent pixels (so a
cutout reports garment colours instead of half bedsheet) and a clean isolated garment yields
better colour/pattern calls than a crumpled flat-lay. Garment boxes come from
`extractBoundingBox` on the ORIGINALS so each AI call has one job — and the found boxes are
folded back into `ai_raw`, which stores the whole inference.

Cutout ladder (`imaging/cutout-ladder.ts`, shared by the pipeline and the batch script):

1. `cutoutQa` on the raw generation — if the model emitted real alpha, use it untouched;
2. `keyFlatBackground` — deterministic flood fill of the flat backdrop we asked for;
3. `removeBackground` (imgly) — ML fallback, in practice never reached;
4. flat-key output that failed QA — accepted with a logged warning;
5. no transparency at all → the tile shows the generation flattened.

In 24/24 real cases rung 2 won: Gemini does not emit alpha, but it does honour "one perfectly
flat tone". Only a failed *generation* leaves an item untouched; otherwise the tile always ends
up on the new image — `mapImage()` cache-busts with `?v=<sha256>`, so browsers pick it up.

Failure policy: only `save` is fatal. Every later stage falls back to the best artifact its
predecessors produced, and stages can report `skipped` (e.g. no Gemini configured on the
laptop) rather than faking success.

## Runbook

```bash
# on the VM (~/psos), keyless — uses the VM's own service-account identity
npx tsx scripts/regenerate-images.ts --dry-run          # count + cost estimate, no spend
npx tsx scripts/regenerate-images.ts --limit 1          # one item, eyeball it first
npx tsx scripts/regenerate-images.ts                    # everything, front + back
npx tsx scripts/regenerate-images.ts --missing          # retry only what has no generation yet
npx tsx scripts/regenerate-images.ts --only <itemId>    # redo one item
npx tsx scripts/cutout-diag.ts <image>                  # why didn't this become a cutout?
```

## Data layout

- `data/images/<itemId>/<role>.<ext>` — everything the app serves.
- `data/generated/<itemId>/<side>-<sha8>.png` — raw Gemini output archive, never served.

## Rules that constrain this work

- No HTTP requests to external hosts from the laptop (corporate EDR — incident SIR0886312).
  VM verification via `gcloud ssh` → `curl localhost:3000`; browser checks are Dinesh's.
- Vertex credentials never enter chat, git, or `/api/settings` (publicly readable).
- AI never overwrites user-edited *fields* (field-level provenance) — unchanged.
- Never delete source photos; archive every generation.

## Backlog — next phase starts here

Highest value first:

1. **HTTPS via Cloudflare Tunnel + a domain.** The app is internet-facing on plain HTTP, so
   the password crosses the wire in the clear and the session cookie cannot be `secure`. Also
   kills the fixed-IP dependency (see the static-IP question above) and makes phone access
   work anywhere. Until it lands, treat the psos password as low-value and never reuse one.
2. **Phone-triggered VM wake**: a tiny always-on endpoint (Cloud Function/Run) that calls
   `instances.start`, so hitting a URL from the phone boots the VM; open the app ~5 min later.
   Matters more now that the app is genuinely usable from a phone.
3. **Catalog the rest of the wardrobe.** The pipeline is ready and one-shot per garment; this
   is now photo-taking work, not engineering work.
4. Quality follow-ups from the regeneration: the cap's cutout had speckle artifacts along the
   top edge, and the blue block-print kurta looks like two duplicate items (archive one).
   Re-check both after the prompt + halo re-run.
5. Retry for partially-failed import jobs (a stage failed but the job reached
   `ready_for_review` — currently only wholly-failed jobs can retry).
6. Editorial treatment for the remaining 7 screens.
7. Modeled editorial shots (needs a reference photo of Dinesh — deferred by choice).

Considered and **rejected**: idle-based VM shutdown (Dinesh, 2026-07-25) — a forgotten open
tab would keep the VM alive indefinitely, and the hard 60-minute autostop is good enough.
