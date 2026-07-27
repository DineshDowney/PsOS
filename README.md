# Personal Stylist OS

Local-first wardrobe management + AI stylist. Single user, everything on disk, no cloud in
the data path.

**New here? Read [`docs/INTRODUCTION.md`](docs/INTRODUCTION.md)** — what this is, why it
exists, and the ideas the code follows from. This page is just how to run it.

## Run

```bash
npm install
npm run seed     # optional: 14 placeholder items so screens aren't empty
npm run dev      # → http://localhost:3000
```

`predev` applies migrations and recovers interrupted jobs before the server starts; a failure
there aborts the launch rather than serving against a stale schema.

## AI providers

Two, split by capability — see `docs/DESIGN.md` §7.1.

- **Gemini via Vertex AI** does everything that looks at a garment: metadata extraction,
  studio-shot generation, outfit ranking. Needs credentials (env key locally, the VM's own
  service account in production). Everything degrades if it is unreachable — imports still
  produce a reviewable draft.
- **Claude via the Agent SDK** does Stylist Chat only, riding this machine's existing
  **Claude Code login** — no API key. Chat therefore works on a laptop with Claude Code
  installed, and not on the VM.

## Screens

Wardrobe (search/filter grid) · Import (photos → 7-stage pipeline → review → confirm) ·
Item (edit, provenance, regenerate images) · Outfit Studio (engine shortlists, a model ranks) ·
Calendar (plan ahead, mark worn) · Laundry (availability board) · Analytics ·
Stylist Chat (Claude with live wardrobe tools) · Settings (models, VM power, backup, activity log).

## Architecture (short version)

- **Next.js 15 full-stack** (App Router). All backend logic in `src/server/**`, thin
  zod-validated route handlers in `src/app/api/**`, screens in `src/app/**`.
- **SQLite** (`data/stylist.db`, WAL) via Drizzle; migrations in `drizzle/`, applied by
  `scripts/boot.ts` before the server accepts a request. Images under
  `data/images/<itemId>/`. `data/` is the entire app state — back it up via Settings → Export.
- **Provenance**: every editable field tracks `ai` vs `user` source. AI may only fill fields
  you have never touched; your edits are never overwritten. All writes go through
  `services/catalog.ts` or `applyInferenceToItem` — never a raw `UPDATE`.
- **Import pipeline** (`src/server/imports/pipeline.ts`): save → garment_box →
  image_generation → background_removal → colors → ai_metadata → thumbnail. Only `save` is
  fatal; every other stage degrades and records why.
- **Cutouts** (`src/server/imaging/cutout-ladder.ts`): native alpha → key the flat backdrop →
  regenerate once against magenta and key that. No ML segmentation, no native ML runtime.
- **Outfits**: `engine/outfit-engine.ts` produces wearable candidates; `services/outfit-stylist.ts`
  lets Gemini reorder and explain them, discarding anything that wasn't a candidate.

## Commands

| Command | What |
|---|---|
| `npm run dev` | Start the app (runs migrations + job recovery first) |
| `npm test` | Unit tests |
| `npm run typecheck` | Strict TS check |
| `npm run build` | Production build |
| `npm run shots` | Screenshot every screen at 1440px and 390px (needs `npm run dev` running) |
| `npm run db:generate` | Regenerate migrations after schema changes |
| `npm run seed` | Seed placeholder wardrobe (no-op if items exist) |

## Deployment

Runs on a GCP VM (`psos-1`) as a systemd service behind Tailscale Funnel — no inbound port.
The VM powers itself off when idle. Units, keepalive script and install steps are in
`deploy/vm/`.
