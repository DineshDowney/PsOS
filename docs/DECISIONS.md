# Decisions

Significant technical decisions, newest first. Add an entry whenever a choice would surprise
a future reader or was made against a plausible alternative.

## 2026-07-27 — Claude can see the UI now, and the type scale spends uppercase on three things

### A screenshot harness, because "add motion" was the wrong first move

Dinesh asked for motion and animation. The app already had a real motion layer — staggered
tile entrance, garment lift, front/back crossfade, toast slide-in, press-scale, cross-page
view transitions, all under one `prefers-reduced-motion` block. Adding more keyframes on top
would have made it read as over-animated while leaving the actual problem untouched: **there
were no loading or in-flight states**, so more motion would decorate a page that still
flashed empty.

He also asked how to close the "you can't see the output" gap. The answer did not need a new
product: **`Read` can read PNGs**, so the repo only needed something that renders a page to a
file. `scripts/shots.ts` drives the Edge already installed on Windows via `playwright-core`
and writes a full-page PNG of every screen at 1440px and 390px.

`playwright-core`, not `playwright`: the full package downloads its own ~150MB Chromium, and
devDependencies ARE installed on the VM because `npm run build` needs them. A bundled browser
would have shipped 150MB to a machine that will never open one, undoing a quarter of what the
simplification pass had just reclaimed. `playwright-core` is ~3MB and launches
`channel: "msedge"`.

**It paid for itself immediately, with two bugs that reading the code had not surfaced:**

- The **phone wardrobe rendered as a single column**. `grid-cols-[repeat(auto-fill,minmax(240px,1fr))]`
  resolves to exactly one track at 390px, so the primary device showed one full-width garment
  at a time. Now a hard `grid-cols-2` below the `sm` breakpoint.
- The **Color filter rendered full-width** and pushed the status control onto its own row.
  `inputClass` starts with `w-full`; appending `w-28` loses, because Tailwind resolves that
  pair by order in the generated stylesheet, not order in the class attribute. Fixed by
  sizing the wrapper, and the constraint is now written into `inputClass`'s doc comment
  because it will catch the next person too.

Also corrected a claim made in the same session: the local `data/` holds the **seeded**
wardrobe, not real garments. Seed images are opaque black squares, so the paper tile and the
contact shadow — both of which exist specifically for transparent cutouts — cannot be judged
from a shot. Layout, type, spacing and surfaces can.

### Uppercase is a budget, not a default

~48 elements were tracked uppercase at six different tracking values (`.08` `.15` `.18` `.2`
`.25` `.35`), all sized 9–12px: page titles, section headers, buttons, field labels, badges,
tag chips, list rows, import stage names. The problem is not that it is ugly. It is that
**when almost every string on screen shouts, uppercase stops meaning "important" and just
becomes the font**, so a heading cannot outrank the button next to it.

Dinesh chose "refine the identity" over "keep it" or "start over", and gave the uppercase call
to me. The budget: **the page `<h1>`, the wordmark, and the nav.** Nothing else. The masthead
treatment survives — it is the most distinctive thing about the app — precisely because it is
now rare. Everything else drops to sentence case on a six-step scale defined once in `@theme`.

The same argument in another dimension produced the surface tiers: `border border-line` was on
cards, buttons, inputs, badges, chips, list rows and 9px sub-buttons, so a container and a
control were the same object. Now `.card` (raised paper, no border) / `.well` (recessed) /
hairline for dividers and clickable edges.

### The power card gets a way back, and deliberately no power-off

`holdFor` only ever moves the deadline forward — correct, so a 10-minute heartbeat cannot cut
a 4-hour manual hold short. The cost was that a mis-clicked hold pinned the VM up, and
billing, for four hours with no undo. `releaseHold()` / `DELETE /api/system/power` is the
escape hatch that rule needs.

**No "power off now" button**, and that is the interesting half. The app runs unprivileged;
the only thing that can call `shutdown` is the root-run keepalive script, which fires every 30
minutes. An in-app button could therefore only honestly promise "within half an hour" — and a
control that lies is worse than no control. `vm-stop.cmd` and the Google Cloud app already do
it properly. Making it real would need a narrow sudoers grant on the VM; not taken.

### What was rejected

- **More animation as the first move.** Named above: it makes an empty flash more noticeable,
  not less. Loading states first, decoration after.
- **A second typeface.** "Rework the type scale" tempts a display serif. The problem was never
  the face — Instrument Sans at 34px with wide tracking is a good masthead — it was that the
  masthead treatment was applied to everything. Reserving it fixed the hierarchy at zero cost
  in bytes and zero risk to the identity Dinesh already signed off on.
- **A dark theme.** Not asked for, and the palette was deliberately chosen on 2026-07-26.

## 2026-07-27 — Simplification pass: no ML segmentation, eager migrations, Gemini-only extraction, model-ranked outfits

Dinesh reviewed the design doc and asked, of each subsystem, whether it was actually earning
its complexity. Four answers came out of it. Written and verified locally (121 tests,
typecheck, build, `prestart` hook); **not yet run against the real wardrobe**.

### imgly and BiRefNet deleted; the cutout ladder loses its segmentation rung

BiRefNet was unambiguous: gated behind an env var nothing sets, requiring `models/birefnet.onnx`
which exists on no machine, documented as crashing on the VM. It could not run.

imgly was the real question, and the accounting settled it. `@imgly/background-removal-node`
declares `onnxruntime-node` as its own dependency and ships nested copies of both it and
sharp — **574 MB of the 1151 MB `node_modules`**, for a rung that only fires when flat-keying
the grey backdrop we asked for has already failed. The failure it rescues is a garment close
in tone to that backdrop, and matting is the wrong tool for it: segmentation preserves the
crumples and bedsheet shadows that the redraw exists to remove.

Replaced by rung 3 = **regenerate once against a pure-magenta backdrop and key that**. Same
flood fill, no code change to `flat-key.ts`, and it fixes the cause rather than matting around
it. This is the chroma-key backdrop that had been sitting in the backlog since 2026-07-26,
applied to one item on demand instead of to the whole catalog — so it no longer implies a
catalog-wide regeneration. Costs $0.04 and ~15s, in the same slot where imgly cost 10-20s of
CPU. Guard: if the retry also fails QA, the ladder falls back to the *original* generation's
keyed output, so a retry can add ground but never lose it.

What we gave up: the no-Gemini path. `stageBackgroundRemoval` used to segment the crop when
Gemini was unconfigured; now there is simply no cutout and the tile stays opaque, with the
stage saying so. That is the honest degradation — the alternative was a bad matte of a
crumpled flat-lay, which is the thing §4.1 argues is not worth having.

Also gone with them: a child process, the `serverExternalPackages` entry, `PSOS_BG_ENGINE`,
`PSOS_DISABLE_BG_REMOVAL`, `PSOS_BG_DEBUG`, and `scripts/backfill-images.ts` (a spent one-shot
whose cutout step was imgly).

**Not yet exercised.** Rung 3 has no failing case in the current wardrobe to test against. It
is covered by unit tests with synthetic near-white garments, which is not the same thing.

### Migrations and orphan recovery moved to a pre-start process

`getDb()` is lazy, so migrations ran on the first request that touched the DB. A freshly
restarted server therefore looked half-deployed — schema correct, new table absent until
somebody loaded a page — which is indistinguishable from a failed migration.

`scripts/boot.ts`, wired as npm's `prestart` and `predev`. A **separate process** rather than
Next's `instrumentation.ts`: no bundler involvement at all, and a non-zero exit aborts the
launch instead of starting a server against a stale schema.

Worth recording because the earlier framing was wrong: the lazy placement was blamed on
imgly's native binary poisoning the `instrumentation.ts` bundling pass, and removing imgly was
expected to "unblock" it. It did — but `instrumentation.ts` was never the only route. A plain
prestart script would have worked the whole time and is the better answer anyway. The
dependency and the workaround were less coupled than the comments claimed.

Orphan recovery moved with it, and is strictly better there: a process that runs *before* the
server can only be looking at the previous run's wreckage, so there is no live job it could
mistake for an orphan. The staleness cutoff stays as a second guard for manual runs.

### Extraction is Gemini-only, and metadata is anchored to the photographs

The Claude branch existed because the laptop had a Claude login and no Gemini credentials
while the VM had the reverse. Nothing imports on the laptop any more, so it was a second way
to do one job. Deleted, along with `extractionEngine()`, the path-vs-inline `imageRef` split,
and the `ai.extractionEngine` setting.

The more consequential half is Dinesh's: metadata was read off the **generated** shots, which
made a closed loop with no correction. A generation shifts a colour → the shift is stored as
metadata → `itemFacts` grounds the *next* generation in that metadata → each retry drifts
further from the real garment while looking more self-consistent.

His proposed fix was to move `ai_metadata` before `image_generation`. Rejected on a cost he
had not seen: `ctx.dominant` is computed from the **cutout**, precisely so it reports garment
pixels rather than half a bedsheet, and that cutout does not exist yet at that point. The
reorder would either lose the colour cross-check or reintroduce a bug fixed on 2026-07-25.

Kept the order, changed the inputs instead: the call now receives the cropped photographs
*and* the studio shots, in that order, with the prompt stating that the photograph wins any
disagreement about colour, shade, pattern, print placement, material or branding, and the
render is only for silhouette, cut, construction and text a crease had obscured. One extra
inline image, same number of calls, no reorder, cross-check intact.

[Guessing] how reliably the model honours "image 1 is authoritative" — that is the thing the
VM test has to answer. If it does not hold, the strict reorder is the fallback and we pay for
it by losing the dominant-colour cross-check.

Knock-on: the settings screen offered Claude model ids for the extraction setting, where a
`claude`-prefixed value is filtered out before it can reach Vertex. A control that looked like
it worked and did nothing. Split into two lists, Claude for chat and Gemini for extraction.

### Outfit suggestions: the engine decides what is allowed, a model decides what is good

Dinesh asked to revisit "engine over LLM" on the grounds that Gemini is cheap. The better
argument is one he did not make: **the engine has never seen the clothes.** `outfitColorScore`
applies a hue wheel to the *string* in `primaryColor`. And the weights (0.40 colour / 0.25
formality / 0.20 freshness / 0.15 rotation) were chosen by judgement, never validated against
his taste — DECISIONS said so on 2026-07-15. Determinism is only worth having when the
function is right.

So the rule was re-scoped rather than dropped. `engine/outfit-engine.ts` keeps everything that
must be exactly right and that a model will get wrong — laundry state, slot completeness,
freshness, rotation, repeat penalty. `services/outfit-stylist.ts` sends the engine's shortlist
of 8 candidates to Gemini as ≤12 garment **tiles** plus metadata, and gets back an ordering
with one line of reasoning each.

The safety is structural, not prompted: the model's entire vocabulary is candidate letters
`"A".."H"`, so `validatePicks` can reject anything that was not on the shortlist. The worst a
hallucinating model can produce is a bad *order* — it cannot invent a garment, pull one from
the laundry, or put two pairs of shoes in an outfit. Any failure at all (no credentials, model
error, unparseable JSON, zero valid picks) falls back to engine ranking and **shows the reason
on the page**, because a degraded answer that looks identical to a good one is the real hazard.

Numbers: Dinesh's first instinct on the shortlist size was that 20 was too many, and he was
right — but the framing was worse than the number. "20 candidate outfits with tile images" is
60+ images. The unit is items, not outfits. `SHORTLIST = 8`, `MAX_TILES = 12`, `TILE_PX = 256`,
all named constants. `fitToTileBudget` trims by dropping whole candidates, never individual
images, so the prompt's numbering can never disagree with what was attached.

Costs, accepted: instant-and-free becomes a few seconds and a fraction of a cent, and the
order is no longer reproducible. Fine for a button press, not for a page load — so it is a
button press. Chat's `suggest_outfits` deliberately still calls the plain engine; Claude is
already the taste layer there.

### Deferred, with reasons

**Chat stays on Claude.** Dinesh's call. It means the Agent SDK (69 MB) stays, and that chat
still does not work on the VM — the only machine with the wardrobe on it. Porting needs
function calling in `vertex-client.ts` plus a tool loop; the open risk is whether
`streamGenerateContent` fits the current client without losing token-by-token streaming, and
that it turns chat from free into billed per message.

**Function calling deferred with it.** It was only ever needed for chat tools — the stylist
uses plain structured output (`responseMimeType: "application/json"`), which the client
already had.

## 2026-07-27 — GCP-native ingress priced and rejected; Funnel stays, vm-start just gets honest
Dinesh hit the app while the VM was asleep and concluded the server had failed to start. It
had not: `psos.service` is `enabled` and came up in 2.1s with 0 restarts on that boot, Funnel
already serving. The VM was simply off, and `vm-start.cmd` opened the browser the instant the
compute API returned — ~60s before anything could answer. **The defect was the script's
messaging, not its behaviour**, which is worth noting because two larger designs were nearly
built on top of the misdiagnosis.

He then asked to drop Tailscale for something GCP-native, on the grounds that a second vendor
adds complexity down the line. Priced properly, the motive **inverts**:

| | Cost/mo | Inbound ports | Moving parts |
|---|---|---|---|
| **Tailscale Funnel** (kept) | **$0** | **none** | one daemon, one command |
| Domain + Cloud DNS + Caddy | ~$1 | 80 + 443 open | registrar, DNS zone, boot-time DDNS updater, Caddy unit |
| GCP External ALB (+ IAP) | **$18.25** | none | 6 GCP resources |

Three findings settle it. The ALB forwarding rule is **$18.25/mo minimum and bills whether or
not the VM is running** — more for the front door than the house, to reach a machine that is
off ~20h/day. **Google-managed certs cannot attach to a bare VM** [Certain]: they only go
ACTIVE bound to a load balancer's target proxy, so "GCP-native HTTPS without an LB" does not
exist for Compute Engine. And domains are now cheap (~$10.44/yr at Cloudflare's at-cost
pricing), so the "no free-domain path" blocker recorded on 2026-07-26 is no longer what binds
— parts count and monthly cost are.

Every GCP-native replacement is *more* machinery and *more* money than the thing it replaces.
Tailscale remains the low-complexity option. Decision: **park the ingress entirely** — no
domain, no tailnet rename, no Caddy, no load balancer. The reusable lesson is that "reduce
complexity" was a hypothesis, and it did not survive being costed.

Mobile wake moves **out of the codebase**: the Google Cloud app does start/stop on Compute
Engine instances. Nothing to deploy, nothing to secure, no public trigger.

Also rejected, and not to be reopened without new information:
- **A Cloud Run waker endpoint** (URL → starts the VM → polls → redirects). Sound design, and
  Cloud Run/Build/Artifact Registry are already enabled with zero services — Dinesh vetoed it
  as more infrastructure than the problem deserves.
- **SSH-polling readiness from `vm-start.cmd`**. Works, and I verified the mechanics live
  (passwordless `sudo -n`, greppable funnel status, `localhost:3000/login` → 200). But the
  VM's external IP churns every boot, so PuTTY prompts for the host key each time and running
  it unattended means blind-accepting a new key on every start. A real security trade for a
  cosmetic gain.
- **Migrating the app to Cloud Run.** [Certain] architectural mismatch: the import and regen
  pipelines are in-process job queues with 1-wide limiters and 15–40s of background work, and
  Cloud Run reclaims CPU when a request ends. The whole background-job design would have to be
  rebuilt on Cloud Tasks, and SQLite would have to leave local disk.

What actually shipped: `scripts/vm-start.cmd` now checks `instances describe` first and takes
one of two branches — already `RUNNING` says so and opens the app, otherwise it starts the VM
and states plainly that **the first load will fail and to refresh after a minute**. The old
wording buried a "~60-90s" note that the browser's own error page immediately overwrote.

## 2026-07-26 — On-demand image regeneration, grounded in metadata and feedback
Dinesh, called top priority: regenerate an item's studio shots from the item page — pick
front/back/both, say what was wrong last time, and have the regen pick up whatever metadata
edits have been made since.

**Async and job-backed, not a blocking request.** A two-sided regen is 1-2 *sequential* Gemini
calls (the image limiter in `ai/image-generation.ts` is 1-wide process-wide), 15-40s. Holding a
request open that long across the Tailscale Funnel relay is an unverified proxy-timeout risk —
Dinesh chose explicitly to pay for a `regen_jobs` table and a 2s poller rather than find out the
hard way. Routes and job shape mirror the existing import-job pattern rather than inventing a
second one.

**First real migration of this phase.** The previous two features were TypeScript-only enum
additions (`role` is plain `TEXT` with no SQL `CHECK`), so this is the first that actually
generates SQL. Backed up the live DB before deploying and verified 23 items / 279 images intact
after. Worth recording: `getDb()` is lazy, so migrations do **not** run on `systemctl restart` —
they run when the first request touches the DB. A check immediately after restart reports the
new table MISSING and looks like a failed migration when nothing is wrong.

**Per-side results persist as each side finishes**, so a "both" job shows the front landing
while the back is still generating rather than nothing for 40s.

### Prompt grounding
`buildPrompt(context?)` appends two optional sections to the base prompt: KNOWN FACTS from the
item's current metadata, and a REQUIRED FIX section carrying Dinesh's words verbatim, last so it
reads as the override.

**Facts deliberately exclude brand.** Naming a brand risks the model drawing a generic version
of that brand's logo instead of copying the pixels in the source photo — which fights the
prompt's own IDENTITY rule ("reproduce it as it appears"). Offered as a choice; Dinesh took the
no-brand option.

**Metadata is read at RUN time, not queue time.** If he edits the colour while a job waits its
turn behind another, the edit still grounds the generation.

**`buildPrompt()` with no context returns the base prompt byte-for-byte, with a test asserting
it.** This is the entire safety argument for making the prompt context-aware: the import
pipeline's first generation passes nothing, and without that guarantee every future import
silently changes behaviour.

**Regeneration always sources from the ORIGINAL crop or photo, never from a previous
generation.** Regenerating a regeneration compounds drift away from the real garment on every
retry; the crop is the one fixed anchor to fidelity.

### Two gaps caught by re-deriving the plan mid-build
Dinesh interrupted with "stop and rethink the plan to optimize it" after the backend was
written. Both of these would otherwise have shipped:

**Regen jobs had no concurrency limit**, unlike imports (`createLimiter(2)`). Three clicks would
have queued three jobs all blocked inside the process-wide image limiter while reporting
"running" to the UI. Now 1-wide *at the job level*, so a job that has not started yet honestly
reads "queued".

**Nothing held the VM awake during a regen.** `workStarted`/`workFinished` existed only as
private functions inside `imports/pipeline.ts`, so a regen queued behind other work could have
had the machine power off underneath it. Extracted to `lib/work-hold.ts` and shared. It has to
be **one** counter, not a copy per caller: two independent counters would each run their own
ticker against the same flag file, and "is anything still running?" would be split across
modules that cannot see each other.

The same interruption cut two things out of this commit — the slow-image-load fix (diagnosed but
never *measured*, so measuring comes first) and refactoring `scripts/regenerate-images.ts` onto
the new shared `regenerateSide`. That script has a real latent bug — it only refreshes the FRONT
tile even when regenerating the back, the same bug already fixed twice in sibling scripts — but
it is scope nobody asked for and cannot be exercised without spending money. Both are backlog.

### Photo navigation
Prev/next arrows, swipe, and clickable dots on the item page viewer — four ways to drive one
index. **Any manual navigation stops the auto-cycle permanently**: a carousel that yanks itself
forward a second after you deliberately chose a photo is the most irritating thing it could do.
Arrows are always visible on touch and fade in on hover for pointer devices, because a
hover-revealed control is invisible on a phone.

## 2026-07-26 — Rotate front/back tiles instead of regenerating anything
Dinesh: *"I want both the front and back to be re-generated. So that we can rotate through the
two images."* Checked the DB before spending anything: `generated_back` already existed for 15
of the 23 items — that work was already paid for and just wasn't being shown. The other 8 were
imported front-only, so there is no photo to generate a back from; those need Dinesh with a
camera, not a Gemini call. **This entire change cost $0.**

**New `thumbnail_back` image role**, the same 640px/88%-occupancy tile treatment the front side
already got. Necessary, not cosmetic: rotating the raw `transparent_back` against the normalized
front thumbnail would jump the garment's size and position on every flip, because the two would
be at different scales. Both sides need identical normalization for a flip to read as one
garment turning around rather than two unrelated photos swapping.

`role` is a plain `TEXT` column with no SQL `CHECK` constraint (confirmed against the drizzle
migration files before adding this) — the new value is a TypeScript-only change, no migration.
The pipeline writes it going forward (`bestBack()` mirrors the existing `bestFront()` in
`imports/pipeline.ts`); `scripts/rekey-images.ts` backfills it for existing items by re-deriving
the tile from the `generated_back` already on disk. That script previously computed a back-side
cutout but only ever refreshed the **front** tile, even when called with `--side back` — a
latent bug that had no visible effect until there was a `thumbnail_back` role to refresh.

**Caught and fixed post-deploy, not before:** the backfill's first run inserted all 15
`thumbnail_back` rows with `width`/`height` both `null`. `setThumbnail`'s insert path had
delegated to `upsertImage`, which is correct for `transparent_front`/`_back` (a null size *is*
right there — it's the un-normalized cutout) but wrong for a tile role, which always has a known
size. The bug was invisible on the front side because that row always already existed by the
time rekey runs (`stageSave` creates it), so only the update branch ever fired. Checked the DB
directly after the first deploy rather than trusting the script's own "0 needing attention"
summary — that summary only covers cutout quality, not row correctness. Fixed and re-ran the
(idempotent, $0) backfill; verified all 15 at `640x640` before calling it done.

### The garment was rendering small — a regression from an hour earlier, not the pipeline
`makeThumbnail` already trims to the garment's alpha bounding box and recenters it at 88%
occupancy — that part was correct and untouched. What shrank it was the light-mode pass
immediately prior: a square 640px tile was placed inside a **portrait** `aspect-[0.78]` box with
padding, so `object-contain` fit to width and the garment landed at roughly 60% of the tile's
*height*. Reverted to a square tile, no padding — the 88% the pipeline already produces is now
what actually shows. The portrait ratio was the right idea borrowed from the wrong source
(a reference whose thumbnails are natively portrait); ours are square, so the frame has to be too.

Also fixed in the same pass: `makeThumbnail`'s opaque-fallback path was still flattening onto
`#111110`, the old dark theme's surface colour — any item whose cutout failed was rendering a
near-black square on the new white page. Flattens onto the paper tone now.

### Item page: regenerated shots first, originals last
Dinesh: *"the first two photos should be regen ones, then the og."* `orderedPhotos()` in
`components/ui.tsx` is the one definition: generated front, generated back, original front,
original back — each of the first two falling back independently to a transparent cutout or the
tight crop when that side was never (re)generated, rather than the slot disappearing. Frame
bumped 280–420px to 300–480px, matching "bigger" applied to the grid tiles too.

### More motion, and what was deliberately left out
*"There's still very little to no animations."* Diagnosis: the light-mode pass's motion was
mostly `:hover`-driven (garment lift, shadow deepening) — invisible on a phone, which is likely
why it read as static. Added: button and segmented-control press-scale (`:active`, which fires
on tap as well as click), a toast slide-in, and increased the tile entrance stagger's distance
and duration since the original values were apparently too subtle to notice.

**Declined for this pass, on purpose:** a sliding-pill background for `SegmentedControl` and a
sliding underline for the nav's active item. Both need measured layout
(`getBoundingClientRect`) to handle variable-width labels correctly — real scope, not a
one-line addition, and not worth rushing alongside everything else here.

## 2026-07-26 — Light mode: white page, paper tiles, and no garment names on screen
Dinesh: *"I think i wanna go light mode. White background. Make the items more bigger. Remove
the names. we don;t need names on front end. Just labels."* Plus motion, *"aesthetically clean
and beautiful like major brands"*, and the look nudged toward `tandpfun/wardrobe`.

**The reference was worth reading rather than guessing at.** Dinesh authorised a one-off
`github.com` fetch (the no-external-HTTP-from-the-laptop rule otherwise stands). Its
`src/styles.css` uses **the same typeface psos already used** — `Instrument Sans Variable` — and
the same zero border-radius. psos was effectively its dark-mode sibling, so this was a palette
and depth change, not a redesign.

**White page, paper tiles — not the reference's all-over cream.** He asked for white; the
reference is `#f4f0e8` throughout. Splitting it deliberately: page `#fdfdfc`, garment ground
`#f4f1ea`. This is load-bearing, not taste. Catalog thumbnails are **transparent cutouts**, so a
cream garment on a white page has no edge at all — the mirror of the problem `.garment-glow`
existed to solve on near-black. On paper it gets two separations: the tile against the page, and
the shadow underneath.

**`.garment-glow` → `.garment-shadow`**, taking the reference's warm `drop-shadow(0 18px 18px
rgb(39 31 23 / .16))`, deepening on hover. Warm rather than neutral: a grey shadow on paper reads
as a printing error. Same `.png`-only gate — the shadow hugs a silhouette, so an opaque JPEG
fallback (which has its own rectangular edge) gets nothing.

**Accent moved from terracotta `#a84b42` to the reference's burgundy `#6e302e`.** Terracotta on
cream is the most over-produced palette in circulation right now; burgundy on white reads chosen.
Burgundy is also a *smaller* contrast step against white than terracotta was against near-black,
so the active nav item gained a weight change on top of the colour — colour alone stopped being
findable at 11px.

**`--color-accent-fg` is a bug fix, not a token for neatness.** Three places did
`hover:bg-accent hover:text-fg` (solid `Button`, the login submit, the wardrobe `+`). The instant
`fg` became ink that was near-black text on dark red. Same class of latent bug: the calendar's
modal scrim was `bg-bg/80`, a dark wash while the page was near-black and *nothing at all* on
white — now an ink scrim.

**Tiles: 160px → 240px, square → portrait `aspect-ratio: .78`.** Worth recording that the
reference's tiles are *not* bigger than ours were (165 vs 160) — "bigger" was Dinesh's own
instruction and won on its own merit. The portrait ratio is the reference's and is the better
idea: garments are taller than wide, so square framing wasted the sides. No pipeline work either
way — thumbnails are already generated at 640px square.

**Not adopted: the reference's right-hand slide-over detail view.** Our item page carries a
15-field edit form with provenance markers; a side panel would cramp it. The route stays.

### Names are hidden, not removed
`itemLabel()` in `components/ui.tsx` is the single definition — `primaryColor`, then
`subcategory ?? category`, falling through to the name and then `"Untitled"` so a bare draft with
neither colour nor category never renders as an empty row. Every screen that showed a name now
shows a label, with the name surviving as a `title` tooltip.

Kept: the column, the editor field, the AI inference, and search — `listItems` already matches
name/description/brand/subcategory, so hiding the name costs no searchability, and the stylist
chat still has something to say.

**The cost is that labels are not unique**, and it bit harder than expected: the analytics bars
keyed rows by label, so two pairs of blue jeans would have collapsed into one row with a React
duplicate-key warning. Keyed by index now. A real disambiguator is not worth building for a
24-item wardrobe.

### Motion: CSS only, one switch to turn it all off
No motion library. `motion`/framer is ~34 KB gzipped and buys spring physics and layout
animation that nothing here needs — against an explicit *"I don't want a heavy ass website"*.
The reference's easings are now tokens (`--ease-out`, `--ease-art`) so the whole app eases alike.
Tiles fade in and rise on a stagger **capped at 12** so tile 40 does not wait a second and a
half. Filter changes cross-dissolve via `keepPreviousData` rather than blanking to a spinner.
Every piece is disabled by one `prefers-reduced-motion` block.

The cross-page fade (`@view-transition` + `experimental.viewTransition`) is the one purely
cosmetic thing here, and is flagged in the CSS as removable without consequence. It may well read
worse than a hard cut: 8 of 9 screens still fetch after hydration, so navigating into them fades
a full page out and a *spinner* in. Kept because Dinesh approved it and it is two seconds to
judge in a browser; delete the flag and the CSS block together if it is ugly.

### Wardrobe is the first screen that server-renders
Every screen was `"use client"` + fetch-after-hydration, so the app opened on a spinner. Fixed on
the landing screen only, by his scoping. `listItems` is **synchronous** (better-sqlite3), so the
server component reads the DB directly — no HTTP hop, no `await`, and the grid arrives with the
HTML. `page.tsx` is the server shell, `grid.tsx` the client island; filtering still happens
client-side, seeded on the unfiltered query key.

**`export const dynamic = "force-dynamic"` is load-bearing.** Without it Next prerenders the
wardrobe at build time and the deployed app serves whatever was in the DB when `npm run build`
ran, forever.

This introduces the only server/client boundary in a codebase that previously had exactly one
pattern (everything client). Small blast radius, but it is a new pattern — the remaining 8
screens are unconverted and stay that way until someone asks.

## 2026-07-26 — Uploads go through a client-side queue, and photos shrink to 3000px first
Front+back is ~11.4 MB and takes 10–15s over Funnel. For all of it the Start button was
disabled and the file inputs still held the last pick, so the next garment could not be staged.
Dinesh: *"can the end user (me) not be released?"*

Worth recording because his first instinct was that the import pipeline's stage isolation should
have contained this. It could not: **the upload completes before `startImport()` is ever
called**, so no job row exists, no stage runs, and there is nothing for the pipeline to isolate.
The failure was in the transport in front of it. Same lesson as the 10 MB truncation bug an hour
earlier — when imports "fail", check whether the pipeline was even reached.

**Queue in the client, not a server-side upload session.** `UploadQueueProvider` mounts inside
`Providers`, which wraps every screen and does not unmount on client-side navigation, so an
upload survives moving around the app. **It does not survive a tab close or hard reload** —
queued items are lost, in-flight ones die. `beforeunload` warns. Durable background upload would
need a Service Worker with Background Fetch, which is disproportionate for one person uploading
garments; the honest trade is a warning dialog instead of machinery.

**Strictly one upload at a time**, Dinesh's call and the right one: the server already runs two
pipelines concurrently with image calls serialized 1-wide, and parallel uploads over a single
DERP relay just split the same bandwidth while making every progress bar meaningless.

**Sequencing lives in a pure reducer.** A transition into `preparing` is *refused* while
anything is in flight, so "one at a time" is an invariant tests assert rather than a side effect
of the worker's guard ref. There is also a `wake()` tick: without it the queue advances only
because the terminal dispatch happens to re-render after the ref clears — true today, and it
would stall silently the moment anyone added an `await` near the end of the worker.

**Downscale to 3000px / q0.85** cuts a pair to ~2.4 MB. Chosen over 2000px because the pipeline
crops the garment box out of the upload and sends the **crop** to Gemini, so upload resolution
sets crop resolution: at 3000px a garment filling half the frame still yields a ~1500px crop,
which is where Gemini's vision path wants to be; at 2000px that crop lands near 1000px and
[Likely] softens logos, stitching and weave. **This is [Likely], not measured** — if a product
shot ever looks softer than the current batch, this is the first suspect.

Two traps in the downscale worth keeping: `imageOrientation: "from-image"` is **load-bearing**,
because re-encoding to JPEG discards the EXIF rotation tag that used to fix a sideways photo —
without the flag the garment is permanently on its side. And it **fails soft in every
direction** (undecodable HEIC, no canvas, a result that came out bigger → return the original),
because shrinking is an optimisation and must never be why an import fails.

**Accepted cost:** the archived `front`/`back` originals are no longer the bytes off the phone.
Acceptable only because Dinesh's true originals live on the device and in
`Downloads\Photos-1-001` — it is a one-way change to stored data.

`apiUpload` moved to **XMLHttpRequest**: [Certain] `fetch` cannot report upload progress in
browsers. The error shaping was factored out so both transports share it, including the
401 → `/login` redirect, which is exactly what gets quietly lost when a second transport appears.

## 2026-07-26 — Wardrobe data off the laptop; one copy now lives on the VM
Dinesh: *"i don't want the data on the laptop."* Deleted local `data/` (119 MB), `models/`
(214 MB BiRefNet weights), `.next/`, and ~1.2 GB of accumulated backups — ~1.75 GB.

`data/` was a stale 25 Jul snapshot showing the pre-fix wardrobe, so keeping it was worse than
not having it: any local UI work would have been judged against broken tiles. The app recreates
an empty DB at boot, and deleting `models/` only costs the segmentation rung locally (the VM
keeps its own copy, so deployed imports are unaffected).

**Flagged, and consciously accepted for now:** this leaves **exactly one copy of the wardrobe**,
on the VM's disk. The existing backup story (Settings → Export) downloads a zip *to the laptop*,
which is the thing being avoided. The right target is a **GCS bucket** with `gsutil rsync` from
the VM — off-machine, pennies a month for ~160 MB, laptop never touches it. Not built yet; it is
the top open risk in STATUS.md.

## 2026-07-26 — Cutout QA gets a tighter ceiling when we control the framing
`cutoutQa` is the cutout ladder's only judge, at every rung. It was blind to the most common
damage mode: pale garments bitten by the flood fill all **passed**, and so did the yellow cap,
whose generation came back on a non-flat backdrop with a slab of it floating above the brim —
73% of the frame opaque, touching no corner and no border, under the 92% ceiling. A blind judge
means silently shipping a broken tile.

Rather than add a geometric heuristic, the fix uses information we already have: a generated shot
is framed by *our own prompt*, which demands "an even margin of empty space on all four sides".
So it can never legitimately fill most of the frame. Healthy cutouts keep 23–45%, so
`cutoutFromGenerated` holds its input to a **60%** ceiling and the cap now falls through to
segmentation, which keys it cleanly.

The ceiling is a caller option, not a new global. Other callers pass **bbox crops with ~8%
padding**, where a garment legitimately does fill the frame, so the default stays 92%. The
principle: how much of the frame is plausible depends on who chose the frame, so the caller that
chose it sets the bound.

**Silhouette roughness** (perimeter/√area) was measured as a general-purpose alternative and
rejected: a clean plaid shirt scores 6.20 while a bitten tee scores 5.22, so no absolute
threshold separates damage from a genuinely intricate outline.

## 2026-07-26 — Flat-key tolerance 30 → 20, chosen by sweeping the wardrobe not by one measurement
Three pale garments were losing chunks of their silhouettes. Diagnosed from a single image the
day before, the conclusion was that the margin was hopelessly thin (2657 against a 2700
threshold) and the only structural fix was a **chroma-key backdrop** plus regeneration.

Sweeping the tolerance across all 17 generated fronts said otherwise: **16 of 17 key
byte-identically at 20 and at 30.** The extra reach was buying nothing, because the backdrops we
ask for are flat. So lowering the default is not a trade of backdrop coverage against garment
safety — it repairs the three and changes nothing else. No prompt change, no regeneration, no
Vertex spend. Recommending chroma-key first was over-engineering from a sample of one.

The floor was measured too, so 20 is not taste: at 10 a legitimately keyable 239,239,239 backdrop
starts surviving in patches, and pale fabric starts being eaten around 26.

Chroma-key is still the only answer for a **genuinely off-white** garment — a cream shirt against
a 230 backdrop is unkeyable by colour distance at any tolerance — so it stays in the backlog,
unbuilt, until something actually fails.

`scripts/rekey-images.ts` exists because of this: re-running the ladder over generations we
already have costs nothing, while regenerating to pick up a keying fix would pay $0.04 an image
to get the same pixels back. 24 sides re-keyed on the VM, 24 clean, 0 needing attention.

## 2026-07-26 — HTTPS via Tailscale Funnel; no domain bought, no inbound port
The app was internet-facing on plain HTTP at a raw IP (`http://34.100.219.116:3000`) with the
firewall open to `0.0.0.0/0`, so the shared password crossed the wire in cleartext and the
session cookie could not be `Secure`. It now serves on **`https://psos.tail620d1e.ts.net`**.

Cloudflare Tunnel was the obvious candidate and was rejected on one hard requirement: the VM
powers off constantly, and a Cloudflare *quick* tunnel mints a **random** hostname on every
start. A *named* tunnel is stable but needs a domain whose nameservers point at Cloudflare —
i.e. a purchase. **There is no free-domain path** [Certain on GCP, Likely on the rest]: GCP
Cloud Domains is a paid reseller, Google Domains was sold to Squarespace in 2023, and the
free-TLD registrars (Freenom et al.) stopped issuing in 2023.

Tailscale Funnel satisfies every constraint at once: hostname bound to the machine name (stable
across reboots), a real Let's Encrypt cert Tailscale renews, free on the Personal plan, and
**no inbound firewall port at all** because `tailscaled` dials out. Cost: an ugly hostname
bookmarked once, and a second vendor in the boot path. Upgrade path if a domain is ever bought:
swap to a named Cloudflare tunnel in ~15 min — nothing in the app depends on either.

Tailnet-only `tailscale serve` was offered as strictly more secure (his phone is already on the
tailnet, so it would have worked with zero public exposure). Dinesh chose public Funnel, so
`/api/auth/login` remains the one endpoint strangers can reach and the login throttle keeps
carrying real weight.

Two gotchas worth remembering: `--accept-dns=false` on `tailscale up` is **load-bearing** — MagicDNS
rewrites `/etc/resolv.conf` and the app resolves `metadata.google.internal` for Vertex ADC, so
letting Tailscale own DNS would break image generation. And both `serve` and `funnel` **block
waiting for a browser approval** the first time, printing a `login.tailscale.com/f/...` link;
that looks exactly like a hang and cost us a session's worth of confusion.

**Cost correction:** releasing the static IP was earlier described as saving ~$7/mo. GCP has
billed *all* external IPv4 since 2024, so an attached ephemeral IP still costs ~$0.005/hr
[Likely]. The real saving is only the many hours the VM is powered off, when a reservation bills
and an ephemeral address does not. An external IP is kept either way — the VM needs outbound
reach for Vertex and Tailscale, and dropping it forces Cloud NAT, which costs far more. So the
case for Funnel is security and stability, not money.

## 2026-07-26 — Login throttle only trusts `x-forwarded-for` behind a real proxy
`loginKey()` read the first `x-forwarded-for` hop unconditionally. Served directly, that header
is just attacker-supplied text, so a guesser could hand himself a fresh bucket on every request
and the progressive delay priced nothing at all — a security hole disguised as a security
feature. Now: one **shared** bucket unless `PSOS_BEHIND_TLS=1`, and the **last** hop when a
proxy we control is in front (the rightmost entry is the one our proxy appended; everything to
its left is client-supplied). The shared fallback is coarser but honest, and it still prices
every guess.

The same flag drives `secure` on the session cookie, which is why it is a flag and not a
constant: hardcoding `secure: true` would make the cookie unsettable over the plain HTTP that
`npm run dev` serves locally.

## 2026-07-26 — Idle VM shutdown, SUPERSEDING the 2026-07-25 rejection
Idle-based shutdown was rejected on 2026-07-25 because a forgotten open tab would keep the VM
alive indefinitely. That objection was correct against the design on the table — "any HTTP
request counts as activity" — and it is a real trap here: the Import screen polls every 2–10 s,
so a backgrounded tab would have billed forever.

Reinstated with a design that cannot fail that way, because the flag tracks **work and human
interaction**, not traffic. `/run/psos/keepalive` holds a UNIX-ms deadline, written by exactly
three things: the import queue while jobs are in flight (self-terminating — the queue drains and
the flag goes stale), a client heartbeat that fires **only** when the tab is visible *and* a
pointer/key event has happened since the last beat, and a manual "hold 4 h" button.

A systemd timer checks every 30 min: fresh → `shutdown -c`; stale with nothing armed →
`shutdown -h +40`; **stale with one already armed → leave it alone**. That third branch is the
part that is easy to get wrong — re-arming `+40` on every stale check would push the poweroff
out forever and silently turn a 60-minute autostop into an infinite one. `psos-autostop.service`
(`shutdown -h +60` at boot) stays as the backstop, so an idle boot still dies at T+60 exactly as
before; after the last real activity the VM sleeps between +40 and +70 min.

The flag lives on tmpfs via systemd's `RuntimeDirectory=psos`, which creates `/run/psos` owned
by the service user — so the app needs **no sudo, no setuid helper and no sudoers entry**, and a
stale hold can never survive a reboot or land in the `data/` backup.

## 2026-07-26 — VM units live in `deploy/vm/`, not just on the box
The systemd units, the keepalive script and the install steps were typed straight onto the VM,
so a rebuilt or replaced instance would have silently lost them and nobody would have known
until the bill or the poweroff misbehaved. They are in the repo now. Secrets stay out:
`/etc/psos.env` is root-owned and never committed.

## 2026-07-25 — Wardrobe images are AI-REGENERATED, not segmented
Segmentation was the wrong problem. Real photos (dark garment on a dark bedsheet, tripod and
feet in frame) defeat any matte, and better models only made the failure prettier. Gemini now
redraws each garment as a clean studio product shot and the cutout is taken from THAT — a
synthetic flat backdrop is the easy case. BiRefNet is dropped as a direction (opt-in via
`PSOS_BG_ENGINE=birefnet`; imgly is the default) and segmentation survives only as the third
rung of `imaging/cutout-ladder.ts`, which in practice never fires: deterministic flood-fill
keying won 24/24. Cost is ~$0.04/image, one-time per garment. The alternative considered and
rejected was paying for OpenAI image editing; Vertex draws on existing GCP credits.

## 2026-07-25 — Vertex AI authenticated by the VM's own service account, no API key anywhere
An AI Studio key only works against `generativelanguage.googleapis.com`, whose free tier has
zero image quota (429 `...FreeTier`), and the Vertex REST surface rejects keys outright (401,
wants OAuth). So the VM uses ADC via the GCE metadata server (`VERTEX_USE_ADC=1`, instance
scope `cloud-platform`, `roles/aiplatform.user`). Strictly better than a key: nothing to
rotate or leak, and the laptop *physically cannot* spend money this way because the metadata
server is only reachable from inside the VM. Two keys were exposed in a transcript earlier in
the session and deleted; this design removes the class of mistake.

## 2026-07-25 — Import pipeline reordered so AI reads the CLEAN image
Stages are now `save → garment_box → image_generation → background_removal → colors →
ai_metadata → thumbnail`, each a single-purpose function over one context object. The order is
deliberate and not the obvious one: colours and metadata run LAST, off the generated studio
shot and the cutout, because `dominantColors` ignores transparent pixels (so a cutout reports
garment colours instead of half bedsheet) and a clean isolated garment yields better colour
and pattern calls than a crumpled flat-lay. Garment boxes come from `extractBoundingBox` on
the ORIGINALS, so each AI call has exactly one job; the found boxes are folded back into
`ai_raw` because that column stores the whole inference and the product-shot prompt does not
ask for boxes. Accepted cost: two AI calls and ~40 s per upload instead of one — Dinesh's
call, "uploads do not need to be instant."

## 2026-07-25 — The image prompt separates PRESENTATION from IDENTITY
Look and feel comes from consistency, not per-image beauty, so the prompt pins one pose, one
lighting setup and one framing for every garment — a grid of them has to read as one shoot.
Identity (colour, pattern, print placement, construction, logos, proportions) is fenced off
as untouchable. The deliberate change: presentation now explicitly permits pressing the
garment — smoothing the random creases of the source photo — because the previous "preserve
EXACTLY what the source shows" faithfully reproduced bedsheet wrinkles, which is what made
the catalog look cheap. A shot that looks great but is not his garment is still a failure.

## 2026-07-25 — Internet-facing behind a password, with a delay instead of a lockout
`psos-app` now allows tcp:3000 from `0.0.0.0/0` (Dinesh's call: his home IP rotates and he
wants phone access), gated by `PSOS_PASSWORD`. Order matters — the gate was verified live
before the firewall opened. The password lives only in root-owned `/etc/psos.env`, set by
`/usr/local/bin/psos-set-password` on the VM so it never has to pass through a transcript;
`EnvironmentFile` + restart is enough, no rebuild (verified). `/api/auth/login` is throttled
by a progressive DELAY (3 free attempts, then 250ms doubling to 5s, cleared by a correct
password) rather than a lockout: a hard block would let anyone who can reach the port lock
Dinesh out of his own wardrobe, trading a remote risk for a guaranteed annoyance. Still plain
HTTP — the password crosses the wire in the clear, which is the standing argument for the
Cloudflare Tunnel on the backlog.

## 2026-07-25 — sharp silently changes channel counts; always assert
Two full debugging sessions were lost to the same class of bug, so it is written down.
`sharp().blur()` runs in sRGB, so blurring a **1-channel** raw buffer returns **three**
channels — `joinChannel(alpha, {channels: 1})` then reads the first third of an interleaved
RGB buffer and produces a sheared, geometric mask while `keptFraction` still looks healthy.
Separately, `removeAlpha()` and `joinChannel()` in the SAME chain strips the joined channel.
Rules: never chain channel-count-changing ops, use `toColourspace("b-w")` after operating on
a mask, and assert buffer length equals `w * h` before joining. Also: keying a flat backdrop
must ERODE the kept region before feathering — the boundary ring is a garment/backdrop blend,
and feathering makes it translucent without fixing its colour, which put a bright halo
(luminance 158 vs a garment at 30) around every item on the dark grid.

## 2026-07-16 (later) — VM caught up to latest code; auto-shutoff tightened to 60 min
Pulled `608644d..feccdac` on `psos-1`, removed `PSOS_DISABLE_BG_REMOVAL` from
`psos.service` (the child-process cutout fix is platform-independent, so the
VM gets real cutouts now, not just crops), rebuilt, and replaced the VM's
`data/` with a fresh copy from the laptop (stale copy still had seed items and
none of the crop/cutout/dedup work). `psos-autostop.service`'s timer dropped
from 180 to 60 minutes per Dinesh's instruction, edited in the unit file so it
persists across boots, not just the current session. Confirmed live at the
VM's (ephemeral) IP: 13 active items served, matching the laptop count. One
operational note for next time: the auto-shutoff fired mid-deployment during
this session (real time elapsed past the armed 60-minute mark while stuck on
an unrelated tool outage) — a restart was needed to finish. Nothing was lost
since git/service-file state persists on the boot disk, but future VM sessions
should budget the full deploy sequence inside one 60-minute window rather than
assuming the timer resets on inactivity.

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
