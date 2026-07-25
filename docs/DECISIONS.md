# Decisions

Significant technical decisions, newest first. Add an entry whenever a choice would surprise
a future reader or was made against a plausible alternative.

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
