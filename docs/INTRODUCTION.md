# psos — what this is

Start here. This page explains what Personal Stylist OS is, what problem it solves, and the
handful of ideas that shape every technical choice in it. It is the orientation; the other
documents are the detail.

---

## The short version

**A local-first wardrobe catalogue that turns into a personal stylist.**

You photograph a garment front and back. The app cuts it out, redraws it as a clean studio
shot, reads its colour, material, cut and formality, and files it. Once enough of your
clothes are in there, it can answer the question the whole thing exists for: *what should I
wear?* — from what you actually own, minus what is in the laundry.

Single user. One person's clothes, one person's taste. That is not a limitation to be
engineered around later; it is the premise, and it is why the design can be as direct as it
is.

---

## Why it exists

You own the clothes. You still stand in front of them and can't decide.

The interesting part is that the barrier isn't taste — it's **inventory**. You cannot reason
about a wardrobe you cannot see. Things at the back of the shelf may as well not exist,
combinations you have never tried don't occur to you, and half of what you reach for is
whatever is on top of the pile.

So the product is two things stacked, and the order matters:

1. **Get the wardrobe into a form you can query.** Photos, cut out, described, searchable,
   with laundry state and wear history attached.
2. **Then reason over it.** Outfits, planning, packing, "what have I not worn in two months".

Phase 1 — what exists today — is almost entirely (1), with enough of (2) working to prove the
foundation is the right shape. There is no point building a stylist on a catalogue that is
tedious to fill.

---

## The five ideas everything else follows from

If you only remember five things about how this is built, these are they. Each one shows up
again and again in the code, and each one is argued properly in `DESIGN.md`.

### 1. AI drafts. You own the result.

Every editable field on a garment records whether its value came from the model or from you.
**AI may only write fields you have never touched.** The moment you edit something — even to
clear it — that field is yours permanently and no future inference can overwrite it.

This is the load-bearing invariant of the whole system. It is enforced at one chokepoint:
every write to an item field goes through `services/catalog.ts` (you) or
`applyInferenceToItem` (the model). Nothing else is allowed to `UPDATE` those columns.

Without this rule, an app that re-runs inference is an app that silently eats your
corrections, and you stop trusting it. With it, you can let the AI be wrong sometimes.

### 2. Redraw, don't segment.

The obvious way to get a garment onto a clean background is machine-learning segmentation:
run a model, get a mask, cut along it. We did that, and deleted it.

Instead the app asks a generative model for a *new* photograph of the same garment on a
deliberately flat backdrop, then keys that backdrop out arithmetically. It is cheaper, it has
no native ML runtime, no model weights, no child process — and it produces a better image,
because the output is a studio shot rather than a phone snap with its background removed.

Measured, not assumed: across 24 real garments the ML fallback never once fired. It was
removed and `node_modules` went from 1151 MB to 577 MB.

### 3. The engine decides what is allowed; a model decides what is good.

Outfit suggestions are a two-stage thing, and the split is deliberate.

A deterministic, unit-tested engine builds candidates that are *wearable* — right categories,
nothing in the laundry, formality consistent, not the same shirt three days running. It is
good at rules and it cannot hallucinate a garment you don't own.

But it has never seen the clothes. It scores colour by running a hue wheel over the *word*
in a database column. So a model then looks at pictures of the shortlisted candidates,
reorders them, and writes one line saying why.

The safety net is structural rather than hopeful: the model's entire vocabulary is the letters
of the shortlist it was handed, and anything that isn't one of those is discarded. The worst a
bad model can do is a bad ordering. If any part of it fails, you get the engine's ranking and
the page tells you that is what you're looking at.

### 4. Degrade, never fail silently.

A garment import runs seven stages. Exactly one of them — saving the photos — is fatal. Every
other stage can fail, record *why* it failed, and let the import continue. You end up with a
reviewable draft and a visible gap, rather than an error and nothing.

The same instinct runs throughout: route handlers return structured errors, mutations surface
as toasts, an `activity_log` records who did what. The thing that must never happen is the app
quietly doing less than you think it did.

### 5. One folder is the entire state.

`data/` holds the SQLite database and every image. That's it. Back it up by copying one
directory; there is a button in Settings that zips it.

No cloud services in the data path, no external state to reconcile, no account. The app runs
the same on a laptop with no network as it does deployed.

---

## What a garment actually goes through

The clearest way to understand the system is to follow one shirt.

```
  photograph front (+ back)
        │
        ▼
  ┌─────────────────────────── the import pipeline ───────────────────────────┐
  │  save          photos to disk — the ONLY fatal stage                      │
  │  garment_box   find the garment, crop away the bedsheet                   │
  │  image_gen     Gemini redraws it as a studio shot on a flat backdrop      │
  │  cutout        key the backdrop out; retry once on magenta if it fails    │
  │  colors        read dominant colours FROM THE CUTOUT, not the photo       │
  │  ai_metadata   Gemini writes colour, material, fit, formality, pattern    │
  │  thumbnail     normalize to a 640px tile, garment at 88% occupancy        │
  └───────────────────────────────────────────────────────────────────────────┘
        │
        ▼
  draft → you review and correct → confirm → active in the wardrobe
        │
        ▼
  worn · laundered · planned · suggested · counted
```

Two details in there are worth pausing on, because they are the kind of thing that is
invisible until it bites:

- **Colours are read from the cutout, not the photograph.** Read from the photo, the most
  "dominant colour" in a picture of a white shirt on a bed is the bedsheet.
- **Metadata runs last so it can see the studio shot — but the original photographs are sent
  alongside it and declared authoritative.** Otherwise a redraw that drifts slightly becomes a
  recorded fact, which then grounds the *next* redraw. That is a closed loop, and it compounds.

---

## What you can do with it today

| Screen | What it's for |
|---|---|
| **Wardrobe** | The grid. Search, filter by category/colour/status. Tiles rotate front-to-back on hover |
| **Import** | Photos in, drafts out. Drag, drop or paste; watch the seven stages; review and confirm |
| **Item** | One garment: photos, every field, provenance marks, wear history, regenerate its images |
| **Outfit Studio** | Suggestions from what's clean, ranked by a model that looked at them. Save or wear |
| **Calendar** | Plan outfits ahead; mark them worn on the day (which writes the wear event) |
| **Laundry** | Three-column availability board. Anything not available is excluded from suggestions |
| **Analytics** | What you own, what you wear, what you never wear |
| **Stylist Chat** | Claude with live tools over your wardrobe — search, plan, log, pack |
| **Settings** | Model choice, VM power, backup export, activity log |

The real wardrobe currently holds **24 active garments and 299 images**. That is small enough
that some rough edges do not hurt yet, and the docs say so where it matters.

---

## Where it runs

Two places, deliberately not synchronised.

- **The laptop** — development. Holds a seeded placeholder wardrobe, not real clothes.
- **A GCP VM (`psos-1`)** — the real one, at a stable Tailscale Funnel URL with a password
  gate and no inbound firewall port at all.

The VM **powers itself off when idle** and is asleep most of the time, because an always-on
box costs money to do nothing. Working in the app holds it awake; walk away and it sleeps.
Waking it is a deliberate act — a script from the laptop, or the Cloud app from a phone.

The two `data/` folders never reconcile, and the real wardrobe exists in exactly one place.
That is the largest open risk in the project and it is tracked as such.

---

## What it deliberately is not

- **Not multi-user.** No accounts, no sharing, no tenancy. One person.
- **Not a shopping app.** It reasons about clothes you already own.
- **Not cloud-native.** No managed database, no object storage, no queue service. A single
  long-lived process with in-memory job queues, which is why it is a VM and not Cloud Run.
- **Not a proof of concept.** It is meant to be lived in for years, which is why provenance,
  degradation and the audit log exist at this size.

---

## The rest of the documentation

| Document | What it is |
|---|---|
| **`ARCHITECTURE.md`** | The one-page map. Where everything lives. Read this to *find* something |
| **`DESIGN.md`** | The territory. Every subsystem, every non-obvious choice with the alternative it beat. Read this to *understand* something — and §15 is the honest list of what's weak |
| **`DECISIONS.md`** | Dated record of how we got here, newest first. The only place history belongs |
| **`STATUS.md`** | Living: what's done, what's unverified, what's next |
| **`../CLAUDE.md`** | How to work on this project, and the collaboration rules |

The split is worth respecting when adding to it: `DESIGN.md` is present tense only, and
`DECISIONS.md` is the only place that talks about the past. A document that mixes the two
stops being usable as either.
