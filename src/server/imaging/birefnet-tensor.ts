/**
 * Pure tensor helpers for the BiRefNet path: image → normalized input tensor,
 * model mask → alpha channel. Kept separate and sharp-based so they are unit
 * testable and stay in the MAIN process (the worker only sees raw floats —
 * see scripts/birefnet-worker.mjs for the process-isolation constraint).
 */
import sharp from "sharp";

export const MODEL_SIZE = 1024;

// ImageNet normalization — BiRefNet's training regime.
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];

/**
 * Resize (stretch) the image to MODEL_SIZE² and produce the Float32 CHW
 * ImageNet-normalized tensor BiRefNet expects. Stretching (not letterboxing)
 * matches the reference BiRefNet preprocessing; the mask is stretched back
 * the same way so geometry cancels out.
 */
export async function toModelTensor(image: Buffer): Promise<Buffer> {
  const { data } = await sharp(image)
    .removeAlpha()
    .resize(MODEL_SIZE, MODEL_SIZE, { fit: "fill" })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const px = MODEL_SIZE * MODEL_SIZE;
  const tensor = new Float32Array(3 * px);
  for (let i = 0; i < px; i++) {
    for (let c = 0; c < 3; c++) {
      tensor[c * px + i] = (data[i * 3 + c]! / 255 - MEAN[c]!) / STD[c]!;
    }
  }
  return Buffer.from(tensor.buffer);
}

/**
 * Combine the original crop with the model's MODEL_SIZE² float mask into a
 * transparent PNG: mask → 8-bit alpha, resized to the crop's dimensions.
 */
export async function maskToAlphaPng(image: Buffer, mask: Float32Array): Promise<Buffer> {
  const meta = await sharp(image).metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  if (width === 0 || height === 0) throw new Error("could not read crop dimensions");

  const alpha8 = Buffer.alloc(mask.length);
  for (let i = 0; i < mask.length; i++) {
    alpha8[i] = Math.max(0, Math.min(255, Math.round(mask[i]! * 255)));
  }
  const alphaResized = await sharp(alpha8, {
    raw: { width: MODEL_SIZE, height: MODEL_SIZE, channels: 1 },
  })
    .resize(width, height, { fit: "fill" })
    .raw()
    .toBuffer();

  // Two separate pipelines: sharp applies ops in a fixed internal order, so
  // removeAlpha() in the same chain would strip the channel joinChannel adds.
  const rgb = await sharp(image).removeAlpha().raw().toBuffer();
  return sharp(rgb, { raw: { width, height, channels: 3 } })
    .joinChannel(alphaResized, { raw: { width, height, channels: 1 } })
    .png()
    .toBuffer();
}
