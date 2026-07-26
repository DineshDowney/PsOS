import { describe, expect, it } from "vitest";
import { garmentShadowClass, itemLabel } from "./ui";
import type { Item } from "@/shared/types";

/** Only the fields itemLabel reads; the rest of Item is irrelevant here. */
function item(fields: Partial<Item>): Item {
  return {
    id: "x",
    name: "",
    category: null,
    subcategory: null,
    description: null,
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
    state: "active",
    status: "available",
    notes: null,
    wearCount: 0,
    lastWornAt: null,
    fieldSources: {},
    images: [],
    tags: [],
    createdAt: "2026-01-01",
    updatedAt: "2026-01-01",
    ...fields,
  };
}

describe("itemLabel", () => {
  it("reads colour then subcategory", () => {
    expect(itemLabel(item({ primaryColor: "Oatmeal", subcategory: "tee", category: "top" })))
      .toBe("Oatmeal · tee");
  });

  it("falls back to the category when there is no subcategory", () => {
    expect(itemLabel(item({ primaryColor: "Navy", category: "outerwear" }))).toBe(
      "Navy · outerwear",
    );
  });

  it("drops the missing half rather than leaving a dangling separator", () => {
    expect(itemLabel(item({ primaryColor: "Navy" }))).toBe("Navy");
    expect(itemLabel(item({ category: "footwear" }))).toBe("footwear");
  });

  // A fresh draft has neither colour nor category yet, and the name is the only
  // thing the AI has written. Without this it would render as a blank row.
  it("falls back to the name when there is nothing to build a label from", () => {
    expect(itemLabel(item({ name: "Some AI Name" }))).toBe("Some AI Name");
  });

  it("never returns an empty string", () => {
    expect(itemLabel(item({}))).toBe("Untitled");
  });

  // Colour+category wins over the name whenever both exist — the whole point is
  // that names do not appear on screen.
  it("prefers the label over the name", () => {
    expect(itemLabel(item({ name: "Oatmeal Crewneck Tee", primaryColor: "Oatmeal", subcategory: "tee" })))
      .toBe("Oatmeal · tee");
  });
});

describe("garmentShadowClass", () => {
  it("shadows transparent cutouts only", () => {
    expect(garmentShadowClass("/api/images/a/thumbnail.png")).toBe("garment-shadow");
    expect(garmentShadowClass("/api/images/a/thumbnail.jpg")).toBeUndefined();
    expect(garmentShadowClass(null)).toBeUndefined();
  });
});
