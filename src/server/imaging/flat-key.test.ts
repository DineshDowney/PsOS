import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { keyFlatBackground } from "./flat-key";

/** Light-grey canvas with a dark rectangle in the middle — a fake product shot. */
async function shot(opts: { bg: string; fg: string; inner?: string }): Promise<Buffer> {
  const size = 120;
  const box = await sharp({
    create: { width: 60, height: 60, channels: 3, background: opts.fg },
  })
    .png()
    .toBuffer();
  const layers: sharp.OverlayOptions[] = [{ input: box, left: 30, top: 30 }];
  if (opts.inner) {
    // A light patch INSIDE the garment: must survive (not edge-connected).
    const patch = await sharp({
      create: { width: 10, height: 10, channels: 3, background: opts.inner },
    })
      .png()
      .toBuffer();
    layers.push({ input: patch, left: 55, top: 55 });
  }
  return sharp({ create: { width: size, height: size, channels: 3, background: opts.bg } })
    .composite(layers)
    .png()
    .toBuffer();
}

async function alphaAt(png: Buffer, x: number, y: number): Promise<number> {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return data[(y * info.width + x) * info.channels + 3]!;
}

describe("keyFlatBackground", () => {
  it("clears a uniform light background and keeps the garment", async () => {
    const img = await shot({ bg: "#f2f2f0", fg: "#303030" });
    const out = await keyFlatBackground(img, { feather: 0 });
    expect(out).not.toBeNull();
    expect(await alphaAt(out!.png, 2, 2)).toBe(0); // corner cleared
    expect(await alphaAt(out!.png, 60, 60)).toBe(255); // garment kept
    expect(out!.keptFraction).toBeGreaterThan(0.15);
    expect(out!.keptFraction).toBeLessThan(0.35);
  });

  it("does not punch holes in light areas inside the garment", async () => {
    const img = await shot({ bg: "#f2f2f0", fg: "#303030", inner: "#f2f2f0" });
    const out = await keyFlatBackground(img, { feather: 0 });
    expect(out).not.toBeNull();
    // Same colour as the background, but enclosed by garment → still opaque.
    expect(await alphaAt(out!.png, 60, 60)).toBe(255);
  });

  // Regression (2026-07-25): every test above passed with feather: 0 while the
  // default (feathered) path produced a sheared, geometric mask — sharp's blur
  // promotes a 1-channel raw buffer to 3 channels, so joinChannel read the first
  // third of an interleaved RGB buffer. Assert alignment, not just two pixels.
  it("keeps the mask aligned to the garment when feathering (default)", async () => {
    const img = await shot({ bg: "#f2f2f0", fg: "#303030" });
    const out = await keyFlatBackground(img);
    expect(out).not.toBeNull();

    const { data, info } = await sharp(out!.png)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    let minX = info.width, minY = info.height, maxX = -1, maxY = -1;
    for (let p = 0; p < info.width * info.height; p++) {
      if (data[p * info.channels + 3]! < 128) continue;
      const x = p % info.width;
      const y = (p - x) / info.width;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    // The garment box is (30,30)-(89,89); feathering may shift edges by a pixel.
    expect(minX).toBeGreaterThanOrEqual(29);
    expect(minY).toBeGreaterThanOrEqual(29);
    expect(maxX).toBeLessThanOrEqual(90);
    expect(maxY).toBeLessThanOrEqual(90);
    expect(maxX - minX).toBeGreaterThan(55);
    expect(maxY - minY).toBeGreaterThan(55);
  });

  it("drops stray marks left on the backdrop", async () => {
    // A thin line across the backdrop is not edge-connected background, so the
    // flood fill leaves it; it must not survive into the cutout.
    const size = 120;
    const garment = await sharp({ create: { width: 60, height: 60, channels: 3, background: "#303030" } })
      .png()
      .toBuffer();
    const seam = await sharp({ create: { width: 100, height: 2, channels: 3, background: "#666666" } })
      .png()
      .toBuffer();
    const img = await sharp({ create: { width: size, height: size, channels: 3, background: "#f2f2f0" } })
      .composite([{ input: garment, left: 30, top: 20 }, { input: seam, left: 10, top: 110 }])
      .png()
      .toBuffer();
    const out = await keyFlatBackground(img);
    expect(out).not.toBeNull();
    expect(await alphaAt(out!.png, 50, 110)).toBe(0); // seam gone
    expect(await alphaAt(out!.png, 60, 50)).toBe(255); // garment kept
  });

  it("returns null when the garment matches the background (nothing to key)", async () => {
    const img = await shot({ bg: "#f2f2f0", fg: "#f1f1ef" });
    expect(await keyFlatBackground(img)).toBeNull();
  });

  it("returns null on a busy photo with no uniform border", async () => {
    // Gradient border: the flood fill can't establish a background region.
    const raw = Buffer.alloc(100 * 100 * 3);
    for (let i = 0; i < 100 * 100; i++) {
      raw[i * 3] = i % 255;
      raw[i * 3 + 1] = (i * 7) % 255;
      raw[i * 3 + 2] = (i * 13) % 255;
    }
    const img = await sharp(raw, { raw: { width: 100, height: 100, channels: 3 } })
      .png()
      .toBuffer();
    expect(await keyFlatBackground(img)).toBeNull();
  });
});
