import { describe, expect, it } from "vitest";
import { garmentShadowClass, itemLabel, itemThumb, itemThumbBack, orderedPhotos } from "./ui";
import type { ImageRole, Item, ItemImage } from "@/shared/types";

function image(role: ImageRole, url = `/api/images/x/${role}`): ItemImage {
  return { id: role, role, url, width: null, height: null };
}

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

describe("itemThumb / itemThumbBack", () => {
  it("prefers the normalized tile over a raw cutout over the raw photo", () => {
    const it_ = item({
      images: [image("front"), image("transparent_front"), image("thumbnail")],
    });
    expect(itemThumb(it_)).toBe("/api/images/x/thumbnail");
  });

  it("falls back down the chain when the normalized tile is missing", () => {
    expect(itemThumb(item({ images: [image("front"), image("transparent_front")] }))).toBe(
      "/api/images/x/transparent_front",
    );
    expect(itemThumb(item({ images: [image("front")] }))).toBe("/api/images/x/front");
    expect(itemThumb(item({ images: [] }))).toBeNull();
  });

  // Pre-backfill state for the 15 items that had a generated back before
  // `thumbnail_back` existed: no thumbnail_back row yet, but transparent_back
  // does exist, and that must still show up rather than nothing.
  it("falls back the same way on the back side, independently of the front", () => {
    const it_ = item({ images: [image("transparent_back"), image("back")] });
    expect(itemThumbBack(it_)).toBe("/api/images/x/transparent_back");
  });

  it("is null for a front-only item — nothing to rotate to", () => {
    expect(itemThumbBack(item({ images: [image("front"), image("thumbnail")] }))).toBeNull();
  });
});

describe("orderedPhotos", () => {
  it("puts both generated sides first, then both originals", () => {
    const it_ = item({
      images: [image("front"), image("back"), image("generated_front"), image("generated_back")],
    });
    expect(orderedPhotos(it_).map((i) => i.role)).toEqual([
      "generated_front",
      "generated_back",
      "front",
      "back",
    ]);
  });

  // A front-only item, or one where a side never got past segmentation, must
  // still show something for that slot rather than a gap in the sequence.
  it("falls back per side to a transparent cutout, then a crop", () => {
    const it_ = item({
      images: [image("front"), image("transparent_front"), image("back_cropped"), image("back")],
    });
    expect(orderedPhotos(it_).map((i) => i.role)).toEqual([
      "transparent_front",
      "back_cropped",
      "front",
      "back",
    ]);
  });

  it("drops a slot entirely when nothing at all exists for that side", () => {
    // Imported front-only: no back-anything at all.
    const it_ = item({ images: [image("generated_front"), image("front")] });
    expect(orderedPhotos(it_).map((i) => i.role)).toEqual(["generated_front", "front"]);
  });

  it("is empty for an item with no photos", () => {
    expect(orderedPhotos(item({ images: [] }))).toEqual([]);
  });
});
