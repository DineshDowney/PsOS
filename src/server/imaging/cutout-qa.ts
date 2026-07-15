import sharp from "sharp";

/**
 * Deterministic quality gate for background-removal output. imgly can smear
 * low-contrast backgrounds (dark garment on dark bedsheet) into translucent
 * halos instead of removing them; a bad cutout is worse than no cutout, so
 * callers only replace the crop when this returns ok.
 *
 * Heuristics on the alpha channel (input is a bbox crop with ~8% padding, so
 * a clean cutout has transparent margins and a solid garment in the middle):
 *   1. all four corner patches are essentially transparent
 *   2. the 1-pixel-band border is mostly transparent
 *   3. the opaque area is a sane fraction of the image (not empty, not a
 *      full-frame smear)
 */

export interface CutoutQaResult {
  ok: boolean;
  reason: string | null;
  opaqueFraction: number;
  borderTransparentFraction: number;
}

const CORNER = 8; // px patch per corner
const ALPHA_OPAQUE = 200; // 0-255; above = counts as solid
const ALPHA_CLEAR = 40; // below = counts as transparent

export async function cutoutQa(png: Buffer): Promise<CutoutQaResult> {
  const { data, info } = await sharp(png)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width: w, height: h, channels } = info;
  const alphaAt = (x: number, y: number) => data[(y * w + x) * channels + 3]!;

  // 1. corners
  for (const [cx, cy] of [
    [0, 0],
    [w - CORNER, 0],
    [0, h - CORNER],
    [w - CORNER, h - CORNER],
  ] as const) {
    let solid = 0;
    for (let y = cy; y < cy + CORNER; y++)
      for (let x = cx; x < cx + CORNER; x++)
        if (alphaAt(x, y) > ALPHA_CLEAR) solid++;
    if (solid > CORNER * CORNER * 0.2) {
      return {
        ok: false,
        reason: "corner not transparent — background likely survived",
        opaqueFraction: -1,
        borderTransparentFraction: -1,
      };
    }
  }

  // 2. border band
  let borderClear = 0;
  let borderTotal = 0;
  for (let x = 0; x < w; x++) {
    for (const y of [0, h - 1]) {
      borderTotal++;
      if (alphaAt(x, y) <= ALPHA_CLEAR) borderClear++;
    }
  }
  for (let y = 1; y < h - 1; y++) {
    for (const x of [0, w - 1]) {
      borderTotal++;
      if (alphaAt(x, y) <= ALPHA_CLEAR) borderClear++;
    }
  }
  const borderTransparentFraction = borderClear / borderTotal;

  // 3. opaque fraction
  let opaque = 0;
  const total = w * h;
  for (let i = 3; i < data.length; i += channels) {
    if (data[i]! > ALPHA_OPAQUE) opaque++;
  }
  const opaqueFraction = opaque / total;

  if (borderTransparentFraction < 0.55) {
    return {
      ok: false,
      reason: `border only ${(borderTransparentFraction * 100).toFixed(0)}% transparent — smeared background`,
      opaqueFraction,
      borderTransparentFraction,
    };
  }
  if (opaqueFraction < 0.08) {
    return { ok: false, reason: "cutout nearly empty", opaqueFraction, borderTransparentFraction };
  }
  if (opaqueFraction > 0.92) {
    return {
      ok: false,
      reason: "cutout covers almost the whole frame — background kept",
      opaqueFraction,
      borderTransparentFraction,
    };
  }
  return { ok: true, reason: null, opaqueFraction, borderTransparentFraction };
}
