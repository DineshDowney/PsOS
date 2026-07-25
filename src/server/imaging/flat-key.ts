/**
 * Deterministic background removal for images we generated ourselves.
 *
 * Generated product shots come back on a seamless, near-uniform light
 * background (we asked for it), which makes ML segmentation unnecessary: flood
 * fill inward from the borders, clearing every pixel that stays within
 * tolerance of the corner colour. Edge-connected only, so light-coloured
 * regions INSIDE the garment are never punched through.
 *
 * Fails closed: returns null when the result looks implausible (nothing or
 * almost everything removed), letting callers fall back to segmentation.
 */
import sharp from "sharp";

export interface FlatKeyOptions {
  /** Per-channel colour distance still considered "background". */
  tolerance?: number;
  /** Soften the alpha edge by this blur sigma (0 = hard edge). */
  feather?: number;
}

export interface FlatKeyResult {
  png: Buffer;
  /** Fraction of pixels kept opaque — for logging/QA. */
  keptFraction: number;
}

const CORNER_PATCH = 12;

export async function keyFlatBackground(
  input: Buffer,
  { tolerance = 30, feather = 0.6 }: FlatKeyOptions = {},
): Promise<FlatKeyResult | null> {
  const { data, info } = await sharp(input)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width: w, height: h } = info;
  if (!w || !h) return null;
  const ch = info.channels; // 3 after removeAlpha

  // Reference background colour: mean of the four corner patches.
  let rs = 0, gs = 0, bs = 0, n = 0;
  const corners: Array<[number, number]> = [
    [0, 0],
    [w - CORNER_PATCH, 0],
    [0, h - CORNER_PATCH],
    [w - CORNER_PATCH, h - CORNER_PATCH],
  ];
  for (const [cx, cy] of corners) {
    for (let y = Math.max(0, cy); y < Math.min(h, cy + CORNER_PATCH); y++) {
      for (let x = Math.max(0, cx); x < Math.min(w, cx + CORNER_PATCH); x++) {
        const i = (y * w + x) * ch;
        rs += data[i]!;
        gs += data[i + 1]!;
        bs += data[i + 2]!;
        n++;
      }
    }
  }
  const bg = [rs / n, gs / n, bs / n];
  const tol2 = tolerance * tolerance * 3;

  const isBg = (x: number, y: number): boolean => {
    const i = (y * w + x) * ch;
    const dr = data[i]! - bg[0]!;
    const dg = data[i + 1]! - bg[1]!;
    const db = data[i + 2]! - bg[2]!;
    return dr * dr + dg * dg + db * db <= tol2;
  };

  // Flood fill from every border pixel that matches the background.
  const cleared = new Uint8Array(w * h);
  const queue = new Int32Array(w * h);
  let qh = 0;
  let qt = 0;
  const push = (x: number, y: number) => {
    const p = y * w + x;
    if (cleared[p] || !isBg(x, y)) return;
    cleared[p] = 1;
    queue[qt++] = p;
  };
  for (let x = 0; x < w; x++) {
    push(x, 0);
    push(x, h - 1);
  }
  for (let y = 0; y < h; y++) {
    push(0, y);
    push(w - 1, y);
  }
  while (qh < qt) {
    const p = queue[qh++]!;
    const x = p % w;
    const y = (p - x) / w;
    if (x > 0) push(x - 1, y);
    if (x < w - 1) push(x + 1, y);
    if (y > 0) push(x, y - 1);
    if (y < h - 1) push(x, y + 1);
  }

  let clearedCount = 0;
  const alpha = Buffer.alloc(w * h);
  for (let p = 0; p < w * h; p++) {
    if (cleared[p]) clearedCount++;
    else alpha[p] = 255;
  }
  const keptFraction = 1 - clearedCount / (w * h);
  // Nothing removed (background didn't match) or nearly everything removed
  // (garment same colour as background) — let the caller try something else.
  if (keptFraction > 0.97 || keptFraction < 0.02) return null;

  const alphaChannel =
    feather > 0
      ? await sharp(alpha, { raw: { width: w, height: h, channels: 1 } })
          .blur(feather)
          .raw()
          .toBuffer()
      : alpha;

  const rgb = await sharp(input).removeAlpha().raw().toBuffer();
  const png = await sharp(rgb, { raw: { width: w, height: h, channels: 3 } })
    .joinChannel(alphaChannel, { raw: { width: w, height: h, channels: 1 } })
    .png()
    .toBuffer();

  return { png, keptFraction };
}
