# Personal Stylist OS

Local-first wardrobe management + AI stylist. Single user, everything on disk, no cloud.

## Run

```bash
npm install
npm run seed     # optional: 14 placeholder items so screens aren't empty
npm run dev      # → http://localhost:3000
```

AI features (import metadata extraction, Stylist Chat) run through the **Claude Agent SDK**
using this machine's existing **Claude Code login** — no API key needed. If AI calls fail,
make sure Claude Code is logged in.

## Screens

Wardrobe (search/filter grid) · Import (photo → AI metadata → review → confirm) ·
Outfit Studio (engine-generated suggestions, save, wear) · Calendar (plan ahead, mark worn) ·
Laundry (availability board) · Analytics · Stylist Chat (Claude with live wardrobe tools) · Settings (model override, backup export, activity log).

## Architecture (short version)

- **Next.js 15 full-stack** (App Router). All backend logic in `src/server/**`, thin route
  handlers in `src/app/api/**`, screens in `src/app/**`.
- **SQLite** (`data/stylist.db`, WAL) via Drizzle; migrations in `drizzle/`, applied at boot.
  Images under `data/images/<itemId>/`. `data/` = the entire app state; back it up via
  Settings → Export.
- **Provenance**: every editable field tracks `ai` vs `user` source
  (`src/server/services/provenance.ts`). AI may only fill fields the user hasn't touched —
  user edits are never overwritten.
- **Outfit engine** (`src/server/engine/`): deterministic, unit-tested scoring
  (color harmony / formality / freshness / rotation / repeat-penalty + diversity). Chat's
  `suggest_outfits` tool calls the same engine.
- **Import pipeline** (`src/server/imports/pipeline.ts`): save → background removal
  (swappable, cosmetic-only) → thumbnail → dominant colors → AI metadata. Per-stage status
  in DB; only photo-save failures are fatal.
- **AI layer** (`src/server/ai/`): Agent SDK behind one wrapper (`agent.ts`); wardrobe tools
  exposed to chat via an in-process MCP server (`tools.ts`).

## Commands

| Command | What |
|---|---|
| `npm run dev` | Start the app |
| `npm test` | Unit tests (engine, provenance, colors) |
| `npm run typecheck` | Strict TS check |
| `npm run db:generate` | Regenerate migrations after schema changes |
| `npm run seed` | Seed placeholder wardrobe (no-op if items exist) |
