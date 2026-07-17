import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { cropToBox, makeThumbnail } from "./thumbnails";
import type { BBox } from "@/shared/types";

// A 200x400 (WxH) solid image to crop against.
async function testImage(): Promise<Buffer> {
  return sharp({
    create: { width: 200, height: 400, channels: 3, background: "#4488cc" },
  })
    .jpeg()
    .toBuffer();
}

async function dims(buf: Buffer): Promise<{ w: number; h: number }> {
  const m = await sharp(buf).metadata();
  return { w: m.width ?? 0, h: m.height ?? 0 };
}

describe("cropToBox", () => {
  it("crops to a centered half-size box (plus padding)", async () => {
    const img = await testImage();
    const box: BBox = { x: 0.25, y: 0.25, w: 0.5, h: 0.5 };
    const out = await cropToBox(img, box, 0); // no padding for exact math
    expect(out).not.toBeNull();
    const { w, h } = await dims(out!);
    expect(w).toBe(100); // 0.5 * 200
    expect(h).toBe(200); // 0.5 * 400
  });

  it("clamps a box that spills past the edges", async () => {
    const img = await testImage();
    const box: BBox = { x: -0.2, y: -0.2, w: 1.5, h: 1.5 };
    const out = await cropToBox(img, box, 0.1);
    expect(out).not.toBeNull();
    const { w, h } = await dims(out!);
    expect(w).toBe(200);
    expect(h).toBe(400);
  });

  it("returns null for an implausibly tiny box", async () => {
    const img = await testImage();
    const box: BBox = { x: 0.5, y: 0.5, w: 0.01, h: 0.01 };
    expect(await cropToBox(img, box, 0)).toBeNull();
  });

  it("returns null for a malformed box", async () => {
    const img = await testImage();
    expect(await cropToBox(img, { x: 0, y: 0, w: 0, h: 0.5 })).toBeNull();
    expect(await cropToBox(img, { x: NaN, y: 0, w: 0.5, h: 0.5 })).toBeNull();
  });

  it("adds proportional padding around the box", async () => {
    const img = await testImage();
    const box: BBox = { x: 0.4, y: 0.4, w: 0.2, h: 0.2 };
    const out = await cropToBox(img, box, 0.25); // pad = 0.05 each side
    const { w, h } = await dims(out!);
    // width fraction = 0.2 + 2*0.05 = 0.3 → 60px; height 0.3 → 120px
    expect(w).toBe(60);
    expect(h).toBe(120);
  });
});

// A transparent canvas with one opaque rectangle at the given position — a
// stand-in for a cutout whose matte left uneven transparent margins.
async function cutoutLike(
  rect: { left: number; top: number; width: number; height: number },
  canvas = 500,
): Promise<Buffer> {
  const patch = await sharp({
    create: { width: rect.width, height: rect.height, channels: 4, background: "#cc4433" },
  })
    .png()
    .toBuffer();
  return sharp({
    create: { width: canvas, height: canvas, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite([{ input: patch, left: rect.left, top: rect.top }])
    .png()
    .toBuffer();
}

// Bounding box of visible pixels in an output thumbnail.
async function visibleBox(buf: Buffer) {
  const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let minX = info.width, minY = info.height, maxX = -1, maxY = -1;
  for (let i = 3, pixel = 0; i < data.length; i += info.channels, pixel++) {
    if (data[i]! <= 8) continue;
    const x = pixel % info.width;
    const y = (pixel - x) / info.width;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

describe("makeThumbnail (alpha)", () => {
  it("trims and recenters an off-center cutout at fixed occupancy", async () => {
    // Small garment stuck in the top-left corner of a mostly-empty matte.
    const img = await cutoutLike({ left: 10, top: 20, width: 100, height: 50 });
    const thumb = await makeThumbnail(img, { alpha: true });
    expect(thumb.width).toBe(640);
    expect(thumb.height).toBe(640);

    const box = await visibleBox(thumb.buffer);
    // Long edge scaled to 88% of the tile; 2:1 aspect preserved.
    expect(box.width).toBeGreaterThanOrEqual(561);
    expect(box.width).toBeLessThanOrEqual(565);
    expect(Math.abs(box.width / box.height - 2)).toBeLessThan(0.05);
    // Centered: content midpoint within a couple px of the tile midpoint.
    expect(Math.abs((box.minX + box.maxX) / 2 - 319.5)).toBeLessThanOrEqual(2);
    expect(Math.abs((box.minY + box.maxY) / 2 - 319.5)).toBeLessThanOrEqual(2);
  });

  it("produces identical framing for the same garment with different margins", async () => {
    const tight = await cutoutLike({ left: 0, top: 0, width: 200, height: 100 }, 220);
    const loose = await cutoutLike({ left: 300, top: 350, width: 200, height: 100 }, 900);
    const a = await visibleBox((await makeThumbnail(tight, { alpha: true })).buffer);
    const b = await visibleBox((await makeThumbnail(loose, { alpha: true })).buffer);
    expect(Math.abs(a.width - b.width)).toBeLessThanOrEqual(2);
    expect(Math.abs(a.height - b.height)).toBeLessThanOrEqual(2);
    expect(Math.abs(a.minX - b.minX)).toBeLessThanOrEqual(2);
    expect(Math.abs(a.minY - b.minY)).toBeLessThanOrEqual(2);
  });

  it("falls back gracefully on a fully transparent image", async () => {
    const empty = await sharp({
      create: { width: 300, height: 300, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    })
      .png()
      .toBuffer();
    const thumb = await makeThumbnail(empty, { alpha: true });
    expect(thumb.width).toBe(640);
    expect(thumb.height).toBe(640);
  });
});
