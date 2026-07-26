import { describe, expect, it } from "vitest";
import { itemFacts } from "./regenerate";
import type { Item } from "@/shared/types";

function item(fields: Partial<Item>): Item {
  return {
    id: "x", name: "", category: null, subcategory: null, description: null,
    primaryColor: null, secondaryColors: [], colorDetail: null, pattern: null,
    fit: null, material: null, brand: null, size: null, formality: null,
    seasons: [], price: null, purchaseDate: null, state: "active",
    status: "available", notes: null, wearCount: 0, lastWornAt: null,
    fieldSources: {}, images: [], tags: [],
    createdAt: "2026-01-01", updatedAt: "2026-01-01",
    ...fields,
  };
}

describe("itemFacts", () => {
  it("is empty for an item with no metadata, so the prompt stays unchanged", () => {
    expect(itemFacts(item({}))).toEqual([]);
  });

  it("combines category with subcategory and colour with detail", () => {
    expect(
      itemFacts(item({
        category: "top", subcategory: "t-shirt",
        primaryColor: "Oatmeal", colorDetail: "heathered",
      })),
    ).toEqual(["Category: top / t-shirt", "Colour: Oatmeal (heathered)"]);
  });

  it("omits the parenthetical half when only the main value exists", () => {
    expect(itemFacts(item({ category: "bottom", primaryColor: "Navy" })))
      .toEqual(["Category: bottom", "Colour: Navy"]);
  });

  /**
   * Deliberate: naming a brand risks the model drawing a generic version of
   * that brand's logo instead of copying the pixels in the source photo, which
   * fights the prompt's own "reproduce it as it appears" rule.
   */
  it("never includes brand", () => {
    const facts = itemFacts(item({ brand: "Levi's", primaryColor: "Indigo" }));
    expect(facts.join(" ")).not.toContain("Levi");
  });

  it("includes pattern, material and fit when present", () => {
    expect(itemFacts(item({ pattern: "striped", material: "cotton", fit: "regular" })))
      .toEqual(["Pattern: striped", "Material: cotton", "Fit: regular"]);
  });
});
