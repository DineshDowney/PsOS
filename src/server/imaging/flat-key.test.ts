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
