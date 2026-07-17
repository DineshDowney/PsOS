import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { MODEL_SIZE, maskToAlphaPng, toModelTensor } from "./birefnet-tensor";

async function solidImage(hex: string, w = 200, h = 100): Promise<Buffer> {
  return sharp({ create: { width: w, height: h, channels: 3, background: hex } })
    .png()
    .toBuffer();
}

describe("toModelTensor", () => {
  it("produces a CHW float tensor of the model size with ImageNet normalization", async () => {
    const img = await solidImage("#ffffff");
    const buf = await toModelTensor(img);
    expect(buf.byteLength).toBe(3 * MODEL_SIZE * MODEL_SIZE * 4);
    const t = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
    // white pixel, R channel: (1 - 0.485) / 0.229 ≈ 2.249
    expect(t[0]).toBeCloseTo((1 - 0.485) / 0.229, 2);
    // B channel plane: (1 - 0.406) / 0.225 ≈ 2.64
    expect(t[2 * MODEL_SIZE * MODEL_SIZE]).toBeCloseTo((1 - 0.406) / 0.225, 2);
  });

  it("normalizes black to negative channel means", async () => {
    const img = await solidImage("#000000");
    const buf = await toModelTensor(img);
    const t = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
    expect(t[0]).toBeCloseTo(-0.485 / 0.229, 2);
  });
});

describe("maskToAlphaPng", () => {
  it("applies a full mask as full opacity at the crop's own size", async () => {
    const img = await solidImage("#cc4433", 160, 80);
    const mask = new Float32Array(MODEL_SIZE * MODEL_SIZE).fill(1);
    const png = await maskToAlphaPng(img, mask);
    const meta = await sharp(png).metadata();
    expect(meta.width).toBe(160);
    expect(meta.height).toBe(80);
    const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
    expect(info.channels).toBe(4);
    expect(data[3]).toBe(255);
  });

  it("applies a zero mask as full transparency", async () => {
    const img = await solidImage("#cc4433", 64, 64);
    const mask = new Float32Array(MODEL_SIZE * MODEL_SIZE).fill(0);
    const png = await maskToAlphaPng(img, mask);
    const { data } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
    expect(data[3]).toBe(0);
  });
});
