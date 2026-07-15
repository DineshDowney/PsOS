import type { Category, Formality, Item, OutfitSuggestion } from "@/shared/types";
import { outfitColorScore } from "./color";

/**
 * Deterministic outfit generation.
 *
 * Pure module: takes items + context, returns scored suggestions. No I/O, no
 * randomness beyond an injectable RNG — fully unit-testable. Claude's chat
 * tools call this same engine rather than inventing outfits token-by-token.
 *
 * Scoring dimensions:
 *   - color harmony        (outfitColorScore)
 *   - formality coherence  (items shouldn't span casual ↔ formal)
 *   - freshness            (days since each item was last worn)
 *   - rotation balance     (prefer under-worn items)
 *   - repeat penalty       (down-rank exact combos worn recently)
 * Diversity between the returned suggestions is enforced by greedy selection
 * with an overlap penalty (maximal-marginal-relevance style).
 */

export interface EngineContext {
  /** item-id sets of recently worn outfits (most recent first) */
  recentCombos: Array<Set<string>>;
  /** desired formality, if the user asked for one */
  formality?: Formality;
  /** ISO date used for freshness math (defaults to now) */
  today?: Date;
  /** number of suggestions to return */
  count?: number;
  rng?: () => number;
}

interface Candidate {
  items: Array<{ item: Item; slot: Category }>;
  score: number;
}

const FORMALITY_RANK: Record<Formality, number> = {
  athletic: 0,
  casual: 1,
  smart_casual: 2,
  business: 3,
  formal: 4,
};

function daysSince(dateIso: string | null, today: Date): number {
  if (!dateIso) return 365; // never worn = maximally fresh
  const ms = today.getTime() - new Date(dateIso).getTime();
  return Math.max(0, ms / 86_400_000);
}

function freshnessScore(item: Item, today: Date): number {
  // 0 days → 0, 14+ days → 1, linear between.
  return Math.min(1, daysSince(item.lastWornAt, today) / 14);
}

function rotationScore(item: Item, maxWear: number): number {
  if (maxWear === 0) return 1;
  return 1 - item.wearCount / (maxWear + 1);
}

function formalityScore(items: Item[], wanted?: Formality): number {
  const ranks = items
    .map((i) => (i.formality ? FORMALITY_RANK[i.formality] : null))
    .filter((r): r is number => r !== null);
  if (ranks.length < 2) return 0.8;
  const spread = Math.max(...ranks) - Math.min(...ranks);
  let score = spread <= 1 ? 1 : spread === 2 ? 0.5 : 0.15;
  if (wanted !== undefined) {
    const target = FORMALITY_RANK[wanted];
    const avg = ranks.reduce((a, b) => a + b, 0) / ranks.length;
    const dist = Math.abs(avg - target);
    score *= dist <= 0.5 ? 1 : dist <= 1.5 ? 0.6 : 0.25;
  }
  return score;
}

function comboKey(items: Array<{ item: Item }>): Set<string> {
  return new Set(items.map((x) => x.item.id));
}

function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

function overlap(a: Set<string>, b: Set<string>): number {
  let shared = 0;
  for (const v of a) if (b.has(v)) shared++;
  return shared / Math.min(a.size, b.size);
}

function scoreCandidate(
  candidate: Array<{ item: Item; slot: Category }>,
  ctx: Required<Pick<EngineContext, "recentCombos" | "today">> & EngineContext,
  maxWear: number,
): number {
  const items = candidate.map((c) => c.item);
  const color = outfitColorScore(items.map((i) => i.primaryColor));
  const formality = formalityScore(items, ctx.formality);
  const fresh =
    items.reduce((sum, i) => sum + freshnessScore(i, ctx.today), 0) / items.length;
  const rotation =
    items.reduce((sum, i) => sum + rotationScore(i, maxWear), 0) / items.length;

  const key = comboKey(candidate);
  let repeatPenalty = 0;
  ctx.recentCombos.forEach((combo, idx) => {
    if (setsEqual(combo, key)) {
      repeatPenalty = Math.max(repeatPenalty, 0.5 * (1 - idx / 10));
    }
  });

  return (
    0.4 * color + 0.25 * formality + 0.2 * fresh + 0.15 * rotation - repeatPenalty
  );
}

export function generateOutfits(
  wardrobe: Item[],
  ctx: EngineContext = { recentCombos: [] },
): OutfitSuggestion[] {
  const today = ctx.today ?? new Date();
  const count = ctx.count ?? 4;
  const rng = ctx.rng ?? Math.random;

  const usable = wardrobe.filter(
    (i) => i.state === "active" && i.status === "available",
  );
  const byCat = (c: Category) => usable.filter((i) => i.category === c);

  const tops = byCat("top");
  const bottoms = byCat("bottom");
  const fullBody = byCat("full_body");
  const footwear = byCat("footwear");
  const outerwear = byCat("outerwear");

  const maxWear = usable.reduce((m, i) => Math.max(m, i.wearCount), 0);
  const candidates: Candidate[] = [];
  const fullCtx = { ...ctx, recentCombos: ctx.recentCombos, today };

  const pushCandidate = (parts: Array<{ item: Item; slot: Category }>) => {
    candidates.push({ items: parts, score: scoreCandidate(parts, fullCtx, maxWear) });
  };

  // top + bottom (+ shoes, + sometimes outerwear)
  for (const top of tops) {
    for (const bottom of bottoms) {
      const base = [
        { item: top, slot: "top" as Category },
        { item: bottom, slot: "bottom" as Category },
      ];
      if (footwear.length === 0) {
        pushCandidate(base);
        continue;
      }
      for (const shoes of footwear) {
        const withShoes = [...base, { item: shoes, slot: "footwear" as Category }];
        pushCandidate(withShoes);
        for (const layer of outerwear) {
          pushCandidate([...withShoes, { item: layer, slot: "outerwear" as Category }]);
        }
      }
    }
  }

  // full-body (+ shoes)
  for (const dress of fullBody) {
    const base = [{ item: dress, slot: "full_body" as Category }];
    if (footwear.length === 0) {
      pushCandidate(base);
      continue;
    }
    for (const shoes of footwear) {
      pushCandidate([...base, { item: shoes, slot: "footwear" as Category }]);
    }
  }

  if (candidates.length === 0) return [];

  // Tiny jitter so equal-scored outfits rotate between requests.
  for (const c of candidates) c.score += rng() * 0.02;
  candidates.sort((a, b) => b.score - a.score);

  // Greedy diverse selection.
  const chosen: Candidate[] = [];
  const pool = [...candidates];
  while (chosen.length < count && pool.length > 0) {
    let bestIdx = 0;
    let bestVal = -Infinity;
    for (let i = 0; i < Math.min(pool.length, 200); i++) {
      const cand = pool[i]!;
      const key = comboKey(cand.items);
      const maxOverlap = chosen.length
        ? Math.max(...chosen.map((c) => overlap(comboKey(c.items), key)))
        : 0;
      const val = cand.score - 0.35 * maxOverlap;
      if (val > bestVal) {
        bestVal = val;
        bestIdx = i;
      }
    }
    chosen.push(pool.splice(bestIdx, 1)[0]!);
  }

  return chosen.map((c) => ({
    items: c.items,
    score: Math.round(Math.max(0, Math.min(1, c.score)) * 100) / 100,
  }));
}
