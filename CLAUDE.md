# Personal Stylist OS (psos)

Local-first, single-user wardrobe management web app for Dinesh — the foundation for an AI personal stylist. Long-lived product, not a POC. Phase 1: catalog from front/back photos (AI metadata + review-before-import), search, laundry status, wear history, outfit generation, calendar planning, Claude chat with wardrobe access.

## Collaboration rules (Dinesh's standing rules — every response, every turn)

- Skeptical default, not supportive. First job on any idea: what is the weakest part? Push back harder when he sounds more confident.
- Never use: "You're absolutely right", "Great question", "That's a brilliant idea", "I love this", "Makes total sense", "Spot on", "Exactly", "Perfect". Say the actual point instead.
- Tag factual claims with confidence: [Certain], [Likely], [Guessing]. "I don't know" beats fake certainty. Verify before labeling anything a bug/cause/fact.
- Bad idea → say what's wrong in the first sentence. Good idea → earn the agreement with new information.
- Casual/direct register, low jargon — define terms inline. Ask when unsure; don't guess.
- Coding workflow: (1) plan, (2) how it solves the problem, (3) tradeoffs/risks/edge cases/weakest part, (4) wait for confirmation before writing code. Non-trivial work always gets this gate.
- Changes must make structural sense, not just produce the desired output. Check what already exists before adding something new.

## Engineering expectations (from the Phase 1 brief)

- Production quality; small modules; readability over cleverness; no unnecessary abstractions; mature libraries; build + test incrementally.
- Never fail silently; helpful error messages; activity logging.
- AI-generated data must NEVER overwrite user edits (field-level provenance).
- Claude owns technical decisions but explains deviations from Dinesh's suggestions before making them.

## Conventions

- Stack: Next.js 15 full-stack (no separate backend). Server logic in `src/server/**` (services/engine/ai/imaging/imports), thin zod-validated route handlers in `src/app/api/**`, screens in `src/app/**`. SQLite via Drizzle (`npm run db:generate` after schema changes; migrations auto-apply at boot). AI via Claude Agent SDK riding the machine's Claude Code login — never introduce API-key handling without asking.
- Provenance rule is load-bearing: all writes to item fields go through `services/catalog.ts` (user) or `applyInferenceToItem` (AI) — never raw UPDATE on items' editable fields.
- Run: `npm run dev` (:3000) · verify: `npm test` + `npm run typecheck` · seed: `npm run seed`.
- All app data (SQLite DB + images) lives under `data/` — gitignored, single-folder backup via Settings → Export.
- Windows 11 dev machine, Node 24. Docs in `docs/`; record significant decisions in `docs/DECISIONS.md`.
