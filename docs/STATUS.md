# psos — Status & Plan

Living document: what is planned, what is done, where we are. Update as work lands.
Last updated: 2026-07-26.

## Current objective

**Phase 3 A+B, 2026-07-26.** The app has a real HTTPS URL that survives reboots, and the VM
stays awake while there is work or a human, then sleeps on its own. Next up is the bulk
front-only photo upload, then the UI redesign (Phase C, deferred by Dinesh).

## The URL

**<https://psos.tail620d1e.ts.net>** — Tailscale Funnel, public, real cert, stable across
reboots because it is bound to the machine name rather than the IP. Bookmark it; it does not
change.

Fallbacks if Funnel misbehaves (both tailnet-only, both need Tailscale on the device):
`https://psos.tail620d1e.ts.net` still works inside the tailnet, and `http://100.80.243.100:3000`
hits the VM directly.

## Where we are

| Thing | State |
|---|---|
| **Upload → catalog, end to end** | **Proven live 2026-07-25** on the VM over HTTP through the password gate: all 7 stages green in ~40 s, all 9 image roles written, Gemini metadata correct |
| **Wardrobe regenerated** | Every item, front and back, as a generated transparent cutout. First pass 24/24; re-run after the prompt + halo fixes |
| Import pipeline | 7 single-purpose stages over one context object (`imports/pipeline.ts`); colours + metadata read the CLEAN generated image, not the raw photo |
| Prompts | Rewritten. Image = PRESENTATION (one pose/light/framing for every garment) vs IDENTITY (untouchable). Metadata = naming convention + category disambiguation + specific colour names |
| Cutout quality | Sheared-mask bug fixed (finding 8); bright halo on the dark grid fixed (finding 10) |
| Gemini rate limits | Same-model backoff 20/45/90s honouring `Retry-After`, plus 5s batch pacing and `--missing` to retry a partial run |
| App on VM | **`https://psos.tail620d1e.ts.net`** via Tailscale Funnel |
| Password gate | **ACTIVE.** Root-owned `/etc/psos.env` via `EnvironmentFile`; no rebuild needed (verified). Rotate with `psos-set-password` on the VM |
| Login brute-force cost | Progressive delay on `/api/auth/login`, deliberately **not** a lockout. `x-forwarded-for` trusted only when `PSOS_BEHIND_TLS=1` |
| Inbound firewall | **None.** `psos-app` (tcp:3000) and `psos-allow-web` (tcp:80/443) both deleted 2026-07-26 — Funnel dials out, so no port is open to the app. `default-allow-ssh` stays as the recovery path |
| Billing account `01BB42-93FE43-97EFA2` | Open; trial-upgrade credit valid to 2026-10-14 |
| External IP | **Ephemeral** (`35.244.15.32` today, changes on stop/start — nothing depends on it). Static `34.100.219.116` released 2026-07-26 |
| VM shutdown | 60-min autostop at boot as backstop, plus a 30-min keepalive check (`psos-keepalive.timer`) that cancels it while there is work or a human |
| VM config in git | `deploy/vm/` — units, keepalive script, install steps |
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

## Live findings (2026-07-26 session)

12. **`tailscale serve`/`funnel` do not hang — they block on a browser approval.** Both print a
    `https://login.tailscale.com/f/<feature>?node=…` link and then *wait* for the click, with no
    further output. A 180 s timeout looked exactly like a hang and sent us hunting a nonexistent
    bug; the command finally returned an hour later, the moment the link was clicked. Separately,
    `tailscale cert` returned `500 … your Tailscale account does not support getting TLS certs`,
    which is the message for **HTTPS certificates disabled on the tailnet** — an admin-console
    toggle, not a plan limitation. Always bound these with `timeout` and read the link out of the
    output. Three separate approvals were needed: HTTPS certs, Serve, Funnel.

13. **The login throttle was pricing nothing.** `loginKey()` trusted the first `x-forwarded-for`
    hop, but with the app served directly that header is attacker-supplied — a guesser could
    rotate the key on every request and never accumulate a delay. Fixed: shared bucket unless
    `PSOS_BEHIND_TLS=1`, last hop when a real proxy is in front. Found by re-reading the code,
    not by an incident.

14. **"Any HTTP request keeps the VM awake" would have been silently expensive.** The Import
    screen's TanStack Query polls every 2–10 s (`refetchInterval`), so a backgrounded tab would
    have refreshed the keepalive forever — precisely the failure mode that got idle shutdown
    rejected on 07-25. The heartbeat therefore requires the tab to be *visible* **and** a
    pointer/key event since the last beat.

15. **Re-arming the poweroff on every idle check would never sleep.** `shutdown -h +40` fired at
    each 30-minute check pushes the deadline 40 minutes out in perpetuity. The check must no-op
    when a poweroff is already scheduled. Caught in design, not in the bill.

16. **The catalog is 15 items, not 26 — and 4 of the 15 have broken cutouts.** First contact
    sheet (`scripts/contact-sheet.ts`) of the whole wardrobe. States: 15 active, 20 archived,
    1 draft. Twelve of the archived are the original seed placeholders, correctly gone. But:

    - **Both copies of the Indigo Block-Print Kurta Shirt are archived**, so that garment is
      missing from the catalog entirely — deduping took out the original as well as the copy.
    - **Two active items have no name and no category** (created 2026-07-17): the cap and the
      checked shirt. AI metadata never landed on them.
    - **"Black Patch Detail Sweatshirt" has been stuck in `draft` since 2026-07-25 17:34** — the
      test upload from that session, never confirmed into the catalog.
    - `Maroon Jockey Boxer Briefs` is categorised **accessory**; its three siblings are `bottom`.

17. **The broken cutouts are all LIGHT-COLOURED garments, and the flood fill is eating them.**
    [Certain — measured.] The four damaged tiles are the cream cap (a whole slab of background
    retained above it), the white checked shirt (bites out of the sleeve), the white Levi's
    briefs (ragged all round) and the cream Kiprun tee (a chunk gone from the shoulder). The
    other eleven — all dark or saturated — are clean.

    Measured on the Kiprun tee's `generated_front.png`: the backdrop corner the fill seeds from
    is **rgb(230,230,230)**, and garment-body pixels sit at **rgb(206–213, 203–208, 191–195)**.
    `keyFlatBackground` uses `tolerance = 30` compared as squared Euclidean
    (`tol² = 30²·3 = 2700`, a radius of ~52 RGB units), and those garment pixels come out at
    **1998–2674 — all under 2700**. So the fill treats the garment as backdrop. Because the fill
    is connectivity-based, one pixel of entry is enough to hollow out a whole region, which is
    exactly the shape of the damage.

    Note how thin the margin is: 2657 vs 2700. Nudging the tolerance down would "fix" these four
    and break on the next garment — the real problem is that a pale garment on a pale backdrop
    is genuinely ambiguous. The structural fix is to stop asking for a light backdrop and ask
    for a **chroma-key colour no garment is near** (saturated green/magenta); the existing 2px
    erosion already handles the colour spill that would cause. Costs a prompt change and a
    regeneration of the affected items. **This will hit every white shirt in the next bulk
    upload**, so it is worth doing before the batch, not after.

    **Fixed 2026-07-26 (`f7478a6`), and the "thin margin" claim above was wrong.** Sweeping the
    tolerance across all 17 generated fronts instead of reasoning from one measurement: **16 of
    17 key byte-identically at 20 and at 30**. The backdrops we ask for are flat enough that the
    extra reach bought nothing, so lowering the default to 20 is not a trade — it repaired the
    three pale garments and changed nothing else. No chroma-key, no prompt change, no
    regeneration, no spend. The floor was measured too: at 10 a legitimately keyable 239,239,239
    backdrop starts surviving in patches, so 20 sits between that and the ~26 where pale fabric
    starts being eaten. Chroma-key remains the answer if a genuinely off-white garment ever
    appears (a cream shirt against a 230 backdrop is unkeyable by colour distance at any
    tolerance) — but it was not needed for these, and recommending it first was over-engineering.

    Two things measured and **rejected**, recorded so they are not re-tried:
    - **Differential kept-fraction** (key at two tolerances, flag a big gap): the bites are only
      ~2% of the frame, below the noise floor. Also falsely rejects a healthy 239-backdrop item.
    - **Silhouette roughness** (perimeter/√area) as an absolute QA gate: a *clean* plaid shirt
      scores 6.20 and a *bitten* tee 5.22, so no threshold separates them. It works beautifully
      as a differential, but that is circular — if you can tell 20 beats 30, just use 20.

19. **`cutoutQa` was blind to the damage it exists to catch.** [Certain] Every one of the bitten
    cutouts **passed** QA, and so did the cap: its generation came back on a non-flat backdrop
    with a slab of it floating above the brim, 73% of the frame opaque, touching no corner and no
    border — under the old 92% ceiling. QA is the ladder's only judge at every rung, so a blind
    judge means silently shipping a broken tile, which is the never-fail-silently rule violated
    at the one place it matters.

    A generated shot is framed by *our own prompt* ("an even margin of empty space on all four
    sides"), so it can never legitimately fill most of the frame — healthy cutouts keep 23–45%.
    `cutoutFromGenerated` now holds its input to a **60% ceiling** (15 points of clearance over
    the worst healthy item). The cap now fails flat-key QA, falls through to segmentation, and
    comes out clean — including the speckled top edge from finding 16. The default stays 92%
    because other callers pass bbox crops, where a garment legitimately does fill the frame.

18. **The back photo never reaches the catalog tile.** Traced every consumer: the back feeds the
    garment box, a *second* Gemini image call, a back cutout, and a second image on the metadata
    call — but `bestFront()` is front-only by construction. `describeInput()`
    (`ai/extraction.ts:214`) already emits *"it shows the FRONT only; there is no back image"*
    for single-image input and `bbox_back` is nullable, so **front-only needs no code change**
    and halves the image calls. Shoot the back only where identity lives there (back prints,
    yokes, jacket back panels).

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

# URL / power (on the VM)
tailscale funnel status                                 # is the public URL wired to :3000?
journalctl -t psos-keepalive -n 20                      # every sleep/stay-awake decision
cat /run/psos/keepalive                                 # UNIX-ms deadline, or absent
cat /run/systemd/shutdown/scheduled                     # USEC=… if a poweroff is armed
```

See `deploy/vm/README.md` for the units, the install steps and the Tailscale gotchas.

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

1. **UI redesign (Phase C).** Next up — Dinesh, 2026-07-26, immediately after the cutout fix.
   Measured complaint: 12 motion-related utilities across 1,958 lines of TSX, no animation
   library — but the real cause is structural, not decorative: every screen is `"use client"` +
   fetch-after-hydration, so first paint is an empty page with a spinner. Server-render the first
   screenful before touching any visual direction.
2. **Housekeeping from the contact sheet** (finding 16): un-archive one Indigo Block-Print
   Kurta, name + categorise the two unnamed items, resolve or discard the stuck draft, and move
   `Maroon Jockey Boxer Briefs` off `accessory`.
3. **Catalog the rest of the wardrobe, front-only.** The pipeline is ready and one-shot per
   garment; this is photo-taking work now, not engineering work. Front-only halves the image
   calls and the quota stalling (finding 18).
4. **Bulk import UI** — `<input multiple>` → one photo = one garment → N POSTs. Backend needs no
   changes. Cut from Phase B by Dinesh; still worth having before a 40-garment batch.
5. **Phone-triggered VM wake**: a tiny always-on endpoint (Cloud Function/Run) that calls
   `instances.start`, so hitting a URL from the phone boots the VM.
6. Retry for partially-failed import jobs (a stage failed but the job reached
   `ready_for_review` — currently only wholly-failed jobs can retry).
7. Modeled editorial shots (needs a reference photo of Dinesh — deferred by choice).
8. **Chroma-key backdrop**, if a genuinely off-white garment ever fails (finding 17). Not needed
   for the current wardrobe; only pay the prompt change + regeneration when something actually
   breaks.

Considered and **rejected**: paying for a domain (no free path exists via GCP — see DECISIONS);
tailnet-only `tailscale serve` (more secure, but Dinesh wants the URL to work without a
Tailscale client).

**Superseded:** "idle-based VM shutdown — rejected 2026-07-25" no longer holds. See the
2026-07-26 decision entry: the flag tracks work and interaction rather than traffic, so the
forgotten-tab failure mode that drove the rejection cannot occur.
