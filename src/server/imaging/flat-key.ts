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
/** Keep opaque blobs at least this fraction of the biggest one; clear the rest. */
const BLOB_KEEP_RATIO = 0.15;

/**
 * Clear opaque specks the flood fill could not reach.
 *
 * The fill only removes background CONNECTED to the border, so any line the
 * generator drew across the backdrop survives and, worse, shields whatever it
 * encloses. Observed 2026-07-25: a 5px floor/backdrop seam near the bottom edge
 * left both bottom corners opaque and failed QA even though 54% of the frame had
 * been keyed correctly.
 *
 * A laid-flat garment is one connected blob, so keeping only blobs comparable in
 * size to the largest removes seams, specks and stray marks. The ratio (not
 * "largest only") leaves room for a genuinely two-piece item.
 */
function dropStrayBlobs(cleared: Uint8Array, w: number, h: number): void {
  const label = new Int32Array(w * h).fill(-1);
  const queue = new Int32Array(w * h);
  const sizes: number[] = [];

  for (let start = 0; start < w * h; start++) {
    if (cleared[start] || label[start] !== -1) continue;
    const id = sizes.length;
    let qh = 0;
    let qt = 0;
    label[start] = id;
    queue[qt++] = start;
    let size = 0;
    while (qh < qt) {
      const p = queue[qh++]!;
      size++;
      const x = p % w;
      const y = (p - x) / w;
      const visit = (nx: number, ny: number) => {
        const np = ny * w + nx;
        if (cleared[np] || label[np] !== -1) return;
        label[np] = id;
        queue[qt++] = np;
      };
      if (x > 0) visit(x - 1, y);
      if (x < w - 1) visit(x + 1, y);
      if (y > 0) visit(x, y - 1);
      if (y < h - 1) visit(x, y + 1);
    }
    sizes.push(size);
  }

  if (sizes.length < 2) return;
  const biggest = Math.max(...sizes);
  const minSize = biggest * BLOB_KEEP_RATIO;
  for (let p = 0; p < w * h; p++) {
    const id = label[p]!;
    if (id >= 0 && sizes[id]! < minSize) cleared[p] = 1;
  }
}

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

  dropStrayBlobs(cleared, w, h);

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

  // toColourspace("b-w") is load-bearing: sharp runs operations in sRGB, so
  // blurring a 1-channel raw buffer hands back THREE channels. Joining that as
  // a 1-channel alpha reads the first third of an interleaved RGB buffer and
  // produces a sheared, geometric mask instead of the garment silhouette
  // (cost a long debug session on 2026-07-25 — same family as the
  // removeAlpha()+joinChannel() trap in thumbnails.ts).
  const alphaChannel =
    feather > 0
      ? await sharp(alpha, { raw: { width: w, height: h, channels: 1 } })
          .blur(feather)
          .toColourspace("b-w")
          .raw()
          .toBuffer()
      : alpha;
  if (alphaChannel.length !== w * h) {
    throw new Error(
      `flat-key: alpha channel is ${alphaChannel.length} bytes, expected ${w * h} — refusing to join a misaligned mask`,
    );
  }

  const rgb = await sharp(input).removeAlpha().raw().toBuffer();
  const png = await sharp(rgb, { raw: { width: w, height: h, channels: 3 } })
    .joinChannel(alphaChannel, { raw: { width: w, height: h, channels: 1 } })
    .png()
    .toBuffer();

  return { png, keptFraction };
}
