import { describe, it, expect } from "vitest";
import { fitToTileBudget, validatePicks } from "./outfit-stylist";
import type { Category, Item, OutfitSuggestion } from "@/shared/types";

/**
 * These two functions are the reason the model is allowed anywhere near outfit
 * suggestions. `validatePicks` is the boundary that turns "whatever the model
 * said" into "one of the outfits the engine already approved"; `fitToTileBudget`
 * is what stops the prompt's item numbering from disagreeing with the images
 * actually attached. Everything else in the module is prompt text and I/O.
 */

let seq = 0;
function item(category: Category): Item {
  seq++;
  return {
    id: `item-${seq}`,
    state: "active",
    status: "available",
    name: `Item ${seq}`,
    subcategory: null,
    description: null,
    notes: null,
    primaryColor: null,
    secondaryColors: [],
    colorDetail: null,
    pattern: null,
    fit: null,
    material: null,
    brand: null,
    size: null,
    category,
    formality: null,
    seasons: [],
    price: null,
    purchaseDate: null,
    wearCount: 0,
    lastWornAt: null,
    fieldSources: {},
    images: [],
    tags: [],
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

function outfit(...items: Item[]): OutfitSuggestion {
  return {
    items: items.map((i) => ({ item: i, slot: i.category as Category })),
    score: 0.5,
  };
}

describe("validatePicks", () => {
  const a = outfit(item("top"), item("bottom"));
  const b = outfit(item("top"), item("bottom"));
  const c = outfit(item("top"), item("bottom"));
  const shortlist = [a, b, c];

  it("returns the model's order, not the engine's", () => {
    const out = validatePicks(
      shortlist,
      [
        { candidate: "C", reason: "third is best" },
        { candidate: "A", reason: "then this" },
      ],
      4,
    );
    expect(out.map((s) => s.items)).toEqual([c.items, a.items]);
    expect(out[0]!.reason).toBe("third is best");
  });

  it("drops candidates that were never sent", () => {
    // "Z" is the shape of a hallucination: plausible, and not ours.
    const out = validatePicks(shortlist, [{ candidate: "Z", reason: "invented" }], 4);
    expect(out).toEqual([]);
  });

  it("keeps only the first of a repeated candidate", () => {
    const out = validatePicks(
      shortlist,
      [
        { candidate: "B", reason: "first mention" },
        { candidate: "B", reason: "duplicate" },
      ],
      4,
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.reason).toBe("first mention");
  });

  it("tolerates sloppy casing and whitespace", () => {
    const out = validatePicks(shortlist, [{ candidate: " b ", reason: null }], 4);
    expect(out).toHaveLength(1);
    expect(out[0]!.items).toEqual(b.items);
  });

  it("never returns more than asked for", () => {
    const out = validatePicks(
      shortlist,
      [
        { candidate: "A", reason: null },
        { candidate: "B", reason: null },
        { candidate: "C", reason: null },
      ],
      2,
    );
    expect(out).toHaveLength(2);
  });

  it("carries the engine's own items through untouched", () => {
    const out = validatePicks(shortlist, [{ candidate: "A", reason: "ok" }], 4);
    // The model contributes ordering and a sentence. Nothing else.
    expect(out[0]!.items).toBe(a.items);
    expect(out[0]!.score).toBe(a.score);
  });
});

describe("fitToTileBudget", () => {
  it("keeps every candidate when the wardrobe is small", () => {
    const shared = [item("top"), item("bottom"), item("footwear")] as const;
    const candidates = [outfit(...shared), outfit(...shared)];
    expect(fitToTileBudget(candidates)).toHaveLength(2);
  });

  it("drops whole candidates rather than sending fewer images than promised", () => {
    // Each candidate introduces 3 brand-new garments, so the 12-tile budget is
    // spent after four of them.
    const candidates = Array.from({ length: 8 }, () =>
      outfit(item("top"), item("bottom"), item("footwear")),
    );
    const kept = fitToTileBudget(candidates);

    const distinct = new Set(kept.flatMap((c) => c.items.map((x) => x.item.id)));
    expect(distinct.size).toBeLessThanOrEqual(12);
    expect(kept).toHaveLength(4);
    // Score-ordered, so trimming must come off the bottom.
    expect(kept[0]).toBe(candidates[0]);
  });

  it("never returns nothing, even if one candidate alone blows the budget", () => {
    const huge = outfit(...Array.from({ length: 20 }, () => item("accessory")));
    expect(fitToTileBudget([huge])).toHaveLength(1);
  });
});
