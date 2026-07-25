# psos — Status & Plan

Living document: what is planned, what is done, where we are. Update as work lands.
Last updated: 2026-07-25.

## Current objective

Regenerate every wardrobe image with **Gemini** as a clean studio product shot, front and
back, and have the catalog show the new images. All Gemini calls run **on the VM** — never
from the laptop.

## Where we are

| Thing | State |
|---|---|
| Billing account `01BB42-93FE43-97EFA2` | **Reopened** by Dinesh — `open: true`, project link `billingEnabled: true` |
| Gemini image generation | **Working** and faithful |
| Cutout from generated shot | **Fixed** — was a sharp bug, see finding 8 |
| **Wardrobe regenerated** | **Done 2026-07-25: 24/24 images (16 fronts + 8 backs), 24 clean cutouts, 0 failures, ~$0.96.** Every item's catalog tile is now a generated transparent cutout |
| Front + back regeneration | Built (`--side` to restrict; both by default) |
| Catalog tile follows the new generation | Built — the tile is always repointed at the fresh image |
| App on VM | Running (`systemctl is-active psos` → active) at `http://34.100.219.116:3000` |
| Password gate (opt-in via `PSOS_PASSWORD`) | Built; **not yet set on the VM** (no password in the systemd unit) |
| Static IP `34.100.219.116` | Reserved + attached to `psos-1`. Costs ~$7/mo now that billing is live — keep or release? |
| Firewall `psos-app` | tcp:3000 from `223.185.130.167/32` only. Needs an update whenever Dinesh's home IP rotates |
| Editorial UI (wardrobe/item/import) | Shipped `5babeec` |
| BiRefNet segmentation engine | **Dropped** (Dinesh, 2026-07-25). `PSOS_BG_ENGINE=imgly` is forced in the regen script; its worker crashes on the VM |
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

## Image pipeline as built

`front_cropped` / `back_cropped` → Gemini product shot → cutout ladder:

1. `cutoutQa` on the raw generation — if the model emitted real alpha, use it untouched;
2. `keyFlatBackground` — deterministic flood fill of the flat backdrop we asked for;
3. `removeBackground` (imgly) — ML fallback;
4. flat-key output that removed the backdrop but failed QA — accepted with a logged warning;
5. no transparency at all → the tile shows the generation flattened.

The prompt asks for a **real alpha channel first** and spells out the flat-grey fallback in
detail (no shadow, seam, gradient, vignette or border), because a single stray line across
the backdrop is enough to block a flood fill.

Only a failed *generation* leaves an item untouched. Otherwise the catalog tile always ends
up on the new image — `mapImage()` cache-busts with `?v=<sha256>`, so browsers pick it up.

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

## Backlog (agreed, not started)

- **Phone-triggered VM wake**: a tiny always-on endpoint (Cloud Function/Run) that calls
  `instances.start`, so hitting a URL from the phone boots the VM; open the app ~5 min later.
- **Open the app to the internet, password first** (Dinesh's call, 2026-07-25). The unit now
  has `EnvironmentFile=-/etc/psos.env` and `/usr/local/bin/psos-set-password` prompts for the
  value on the VM, so the password never passes through a transcript. Remaining: he runs it,
  then the `psos-app` firewall source range goes to `0.0.0.0/0` — **in that order**, and
  confirm `/wardrobe` returns 307 before opening (if it does not, the middleware needs a
  rebuild, since Next can inline env vars into the middleware bundle at build time).
- Retry for partially-failed import jobs (stage failed but job `ready_for_review`).
- Category taxonomy pass (underwear → "accessory" vs "bottom" wobble).
- Cloudflare Tunnel + domain (kills IP-allowlist churn, HTTPS, phone-anywhere).
- Editorial treatment for the remaining 7 screens.
- Modeled editorial shots (needs a reference photo of Dinesh — deferred by choice).
