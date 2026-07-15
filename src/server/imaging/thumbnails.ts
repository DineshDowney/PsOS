import sharp from "sharp";
import type { BBox } from "@/shared/types";

export interface ProcessedImage {
  buffer: Buffer;
  width: number;
  height: number;
}

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

/**
 * Crop an image to a normalized garment box (fractions 0..1), padded a little
 * and clamped to the image. Returns null — meaning "use the uncropped image" —
 * when the box is missing, malformed, or implausibly small (a likely
 * mis-detection). Padding is proportional to the box so tight boxes aren't
 * over-expanded.
 */
export async function cropToBox(
  input: Buffer,
  box: BBox,
  padRatio = 0.08,
): Promise<Buffer | null> {
  if (![box.x, box.y, box.w, box.h].every((n) => Number.isFinite(n))) return null;
  if (box.w <= 0 || box.h <= 0) return null;

  const meta = await sharp(input).metadata();
  const imgW = meta.width ?? 0;
  const imgH = meta.height ?? 0;
  if (imgW === 0 || imgH === 0) return null;

  const padX = box.w * padRatio;
  const padY = box.h * padRatio;
  const x0 = clamp01(box.x - padX);
  const y0 = clamp01(box.y - padY);
  const x1 = clamp01(box.x + box.w + padX);
  const y1 = clamp01(box.y + box.h + padY);

  // Round each edge to a pixel, then take the difference — avoids the float
  // drift you get from ceil()-ing a fractional width (0.3*200 = 60.0000001).
  const left = Math.max(0, Math.round(x0 * imgW));
  const top = Math.max(0, Math.round(y0 * imgH));
  const right = Math.min(imgW, Math.round(x1 * imgW));
  const bottom = Math.min(imgH, Math.round(y1 * imgH));
  const width = right - left;
  const height = bottom - top;

  // Guard against degenerate/implausible boxes — fall back to the full image.
  if (width < imgW * 0.05 || height < imgH * 0.05) return null;

  return sharp(input).extract({ left, top, width, height }).toBuffer();
}

/** Normalize an upload: auto-rotate, cap the long edge, re-encode as JPEG. */
export async function normalizeUpload(input: Buffer): Promise<ProcessedImage> {
  const pipeline = sharp(input).rotate().resize(2048, 2048, {
    fit: "inside",
    withoutEnlargement: true,
  });
  const buffer = await pipeline.jpeg({ quality: 92 }).toBuffer();
  const meta = await sharp(buffer).metadata();
  return { buffer, width: meta.width ?? 0, height: meta.height ?? 0 };
}

/**
 * Catalog thumbnail, 640px square. With `alpha: true` (cutout input) the
 * transparency is preserved as PNG so the garment floats on whatever the UI
 * paints behind it — no baked background to clash with the page color.
 * Otherwise (crop/full-frame input) flatten to JPEG on the app background.
 */
export async function makeThumbnail(
  input: Buffer,
  opts: { background?: string; alpha?: boolean } = {},
): Promise<ProcessedImage> {
  if (opts.alpha) {
    const buffer = await sharp(input)
      .resize(640, 640, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toBuffer();
    return { buffer, width: 640, height: 640 };
  }
  const background = opts.background ?? "#111110";
  const buffer = await sharp(input)
    .resize(640, 640, { fit: "contain", background })
    .flatten({ background })
    .jpeg({ quality: 88 })
    .toBuffer();
  return { buffer, width: 640, height: 640 };
}
