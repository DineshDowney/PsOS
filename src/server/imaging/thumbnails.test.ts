import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { cropToBox } from "./thumbnails";
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
