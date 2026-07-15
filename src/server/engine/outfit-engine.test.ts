import { describe, it, expect } from "vitest";
import { generateOutfits } from "./outfit-engine";
import type { Category, Item } from "@/shared/types";

let seq = 0;
function makeItem(overrides: Partial<Item> & { category: Category }): Item {
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
    ...overrides,
  };
}

const rng = () => 0.5; // deterministic

describe("generateOutfits", () => {
  it("returns empty for an empty wardrobe", () => {
    expect(generateOutfits([], { recentCombos: [], rng })).toEqual([]);
  });

  it("builds top+bottom+footwear combos and respects count", () => {
    const wardrobe = [
      makeItem({ category: "top", primaryColor: "white" }),
      makeItem({ category: "top", primaryColor: "black" }),
      makeItem({ category: "bottom", primaryColor: "navy" }),
      makeItem({ category: "bottom", primaryColor: "beige" }),
      makeItem({ category: "footwear", primaryColor: "white" }),
    ];
    const result = generateOutfits(wardrobe, { recentCombos: [], count: 3, rng });
    expect(result).toHaveLength(3);
    for (const outfit of result) {
      const slots = outfit.items.map((i) => i.slot);
      expect(slots).toContain("top");
      expect(slots).toContain("bottom");
      expect(slots).toContain("footwear");
    }
  });

  it("excludes laundry and unavailable items", () => {
    const wardrobe = [
      makeItem({ category: "top", status: "laundry" }),
      makeItem({ category: "top", status: "available", primaryColor: "white" }),
      makeItem({ category: "bottom", primaryColor: "navy" }),
    ];
    const result = generateOutfits(wardrobe, { recentCombos: [], rng });
    const usedIds = result.flatMap((o) => o.items.map((x) => x.item.id));
    expect(usedIds).not.toContain(wardrobe[0]!.id);
  });

  it("supports full-body items as an alternative to top+bottom", () => {
    const dress = makeItem({ category: "full_body", primaryColor: "black" });
    const shoes = makeItem({ category: "footwear", primaryColor: "black" });
    const result = generateOutfits([dress, shoes], { recentCombos: [], rng });
    expect(result.length).toBeGreaterThan(0);
    expect(result[0]!.items.map((i) => i.slot)).toContain("full_body");
  });

  it("prefers fresh items over recently worn ones", () => {
    const today = new Date("2026-07-15T00:00:00Z");
    const wornYesterday = makeItem({
      category: "top",
      primaryColor: "white",
      lastWornAt: "2026-07-14T00:00:00Z",
      wearCount: 20,
    });
    const fresh = makeItem({ category: "top", primaryColor: "white" });
    const bottom = makeItem({ category: "bottom", primaryColor: "navy" });
    const result = generateOutfits([wornYesterday, fresh, bottom], {
      recentCombos: [],
      count: 1,
      today,
      rng,
    });
    expect(result[0]!.items.map((x) => x.item.id)).toContain(fresh.id);
  });

  it("penalizes exact recently-worn combos", () => {
    const top = makeItem({ category: "top", primaryColor: "white" });
    const top2 = makeItem({ category: "top", primaryColor: "grey" });
    const bottom = makeItem({ category: "bottom", primaryColor: "navy" });
    const recent = new Set([top.id, bottom.id]);
    const result = generateOutfits([top, top2, bottom], {
      recentCombos: [recent],
      count: 1,
      rng,
    });
    expect(result[0]!.items.map((x) => x.item.id)).toContain(top2.id);
  });

  it("returned suggestions differ from each other", () => {
    const wardrobe = [
      makeItem({ category: "top", primaryColor: "white" }),
      makeItem({ category: "top", primaryColor: "black" }),
      makeItem({ category: "bottom", primaryColor: "navy" }),
      makeItem({ category: "bottom", primaryColor: "beige" }),
    ];
    const result = generateOutfits(wardrobe, { recentCombos: [], count: 4, rng });
    const keys = result.map((o) =>
      o.items.map((x) => x.item.id).sort().join("|"),
    );
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("respects a requested formality", () => {
    const gymTop = makeItem({ category: "top", formality: "athletic", primaryColor: "grey" });
    const dressShirt = makeItem({ category: "top", formality: "business", primaryColor: "white" });
    const slacks = makeItem({ category: "bottom", formality: "business", primaryColor: "navy" });
    const joggers = makeItem({ category: "bottom", formality: "athletic", primaryColor: "black" });
    const result = generateOutfits([gymTop, dressShirt, slacks, joggers], {
      recentCombos: [],
      count: 1,
      formality: "business",
      rng,
    });
    const ids = result[0]!.items.map((x) => x.item.id);
    expect(ids).toContain(dressShirt.id);
    expect(ids).toContain(slacks.id);
  });
});
