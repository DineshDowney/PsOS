import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { dhash, hammingDistance } from "./phash";

async function image(colors: [string, string]): Promise<Buffer> {
  const half = await sharp({
    create: { width: 50, height: 100, channels: 3, background: colors[1] },
  })
    .png()
    .toBuffer();
  return sharp({
    create: { width: 100, height: 100, channels: 3, background: colors[0] },
  })
    .composite([{ input: half, left: 50, top: 0 }])
    .png()
    .toBuffer();
}

describe("dhash", () => {
  it("identical images have distance 0", async () => {
    const a = await image(["#202020", "#e0e0e0"]);
    expect(hammingDistance(await dhash(a), await dhash(a))).toBe(0);
  });

  it("mirrored gradient images are far apart", async () => {
    const a = await dhash(await image(["#202020", "#e0e0e0"]));
    const b = await dhash(await image(["#e0e0e0", "#202020"]));
    expect(hammingDistance(a, b)).toBeGreaterThan(15);
  });

  it("produces a 16-hex-char hash", async () => {
    const h = await dhash(await image(["#123456", "#abcdef"]));
    expect(h).toMatch(/^[0-9a-f]{16}$/);
  });
});
