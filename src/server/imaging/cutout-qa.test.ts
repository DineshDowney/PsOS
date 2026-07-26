import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { cutoutQa } from "./cutout-qa";

/** Transparent 200x200 canvas with an opaque rectangle composited on. */
async function cutoutWithRect(rect: {
  left: number;
  top: number;
  width: number;
  height: number;
}): Promise<Buffer> {
  const box = await sharp({
    create: { width: rect.width, height: rect.height, channels: 4, background: "#cc3344ff" },
  })
    .png()
    .toBuffer();
  return sharp({
    create: { width: 200, height: 200, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite([{ input: box, left: rect.left, top: rect.top }])
    .png()
    .toBuffer();
}

describe("cutoutQa", () => {
  it("accepts a clean centered cutout", async () => {
    const png = await cutoutWithRect({ left: 40, top: 40, width: 120, height: 120 });
    const r = await cutoutQa(png);
    expect(r.ok).toBe(true);
    expect(r.opaqueFraction).toBeGreaterThan(0.3);
  });

  it("rejects a fully opaque image (background kept)", async () => {
    const png = await sharp({
      create: { width: 200, height: 200, channels: 4, background: "#333333ff" },
    })
      .png()
      .toBuffer();
    const r = await cutoutQa(png);
    expect(r.ok).toBe(false);
  });

  it("rejects a nearly empty cutout", async () => {
    const png = await cutoutWithRect({ left: 95, top: 95, width: 10, height: 10 });
    const r = await cutoutQa(png);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/empty/);
  });

  it("rejects when content bleeds across the border", async () => {
    const png = await cutoutWithRect({ left: 0, top: 0, width: 200, height: 120 });
    const r = await cutoutQa(png);
    expect(r.ok).toBe(false);
  });

  // Regression (2026-07-26): a slab of surviving backdrop floating above the
  // yellow cap (8d05cc43) passed QA, because it touched no corner and no border
  // and the frame was only 73% opaque — under the old 92% ceiling. Callers that
  // know the framing get to tighten the ceiling.
  it("honours a caller-supplied opaque ceiling", async () => {
    // 170x170 of 200x200 = 72% opaque, inset from every border.
    const png = await cutoutWithRect({ left: 15, top: 15, width: 170, height: 170 });

    const loose = await cutoutQa(png);
    expect(loose.ok).toBe(true); // default ceiling still lets a tight crop through

    const tight = await cutoutQa(png, { maxOpaque: 0.6 });
    expect(tight.ok).toBe(false);
    expect(tight.reason).toMatch(/background kept/);
  });
});
