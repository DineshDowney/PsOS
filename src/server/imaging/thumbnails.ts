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

const TILE_SIZE = 640;
// Fraction of the tile the garment occupies after trim-and-center. Every
// cutout renders at this occupancy regardless of how much transparent margin
// the matte inherited from the bbox padding — uniform product-grid framing.
const TILE_OCCUPANCY = 0.88;
const ALPHA_CONTENT = 8; // alpha above this counts as visible content

/**
 * Bounding box of the visible (non-transparent) pixels, or null when the
 * image has no visible content at all.
 */
async function alphaContentBox(
  input: Buffer,
): Promise<{ left: number; top: number; width: number; height: number } | null> {
  const { data, info } = await sharp(input)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let minX = info.width;
  let minY = info.height;
  let maxX = -1;
  let maxY = -1;
  for (let i = 3, pixel = 0; i < data.length; i += info.channels, pixel++) {
    if (data[i]! <= ALPHA_CONTENT) continue;
    const x = pixel % info.width;
    const y = (pixel - x) / info.width;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  if (maxX < minX) return null;
  return { left: minX, top: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

/**
 * Catalog thumbnail, 640px square. With `alpha: true` (cutout input) the
 * garment is trimmed to its visible pixels and recentered at a fixed
 * occupancy, and the transparency is preserved as PNG so it floats on
 * whatever the UI paints behind it — no baked background to clash with the
 * page color. Otherwise (crop/full-frame input) flatten to JPEG on the app
 * background.
 */
export async function makeThumbnail(
  input: Buffer,
  opts: { background?: string; alpha?: boolean } = {},
): Promise<ProcessedImage> {
  if (opts.alpha) {
    const box = await alphaContentBox(input);
    if (box) {
      const target = Math.round(TILE_SIZE * TILE_OCCUPANCY);
      const content = await sharp(input)
        .extract(box)
        .resize(target, target, { fit: "inside", withoutEnlargement: false })
        .png()
        .toBuffer({ resolveWithObject: true });
      const buffer = await sharp({
        create: {
          width: TILE_SIZE,
          height: TILE_SIZE,
          channels: 4,
          background: { r: 0, g: 0, b: 0, alpha: 0 },
        },
      })
        .composite([
          {
            input: content.data,
            left: Math.floor((TILE_SIZE - content.info.width) / 2),
            top: Math.floor((TILE_SIZE - content.info.height) / 2),
          },
        ])
        .png()
        .toBuffer();
      return { buffer, width: TILE_SIZE, height: TILE_SIZE };
    }
    // No visible content (cutoutQa should prevent this) — plain contain resize.
    const buffer = await sharp(input)
      .resize(TILE_SIZE, TILE_SIZE, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toBuffer();
    return { buffer, width: TILE_SIZE, height: TILE_SIZE };
  }
  const background = opts.background ?? "#111110";
  const buffer = await sharp(input)
    .resize(TILE_SIZE, TILE_SIZE, { fit: "contain", background })
    .flatten({ background })
    .jpeg({ quality: 88 })
    .toBuffer();
  return { buffer, width: TILE_SIZE, height: TILE_SIZE };
}
