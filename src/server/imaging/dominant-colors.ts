import sharp from "sharp";

/**
 * Deterministic dominant-color extraction — a cross-check on the AI's color
 * naming. Downscales, quantizes pixels into coarse buckets, ignores fully
 * transparent pixels (so cutouts report garment colors, not background).
 */

export interface DominantColor {
  hex: string;
  fraction: number;
}

export async function dominantColors(
  input: Buffer,
  count = 3,
): Promise<DominantColor[]> {
  const { data, info } = await sharp(input)
    .resize(64, 64, { fit: "inside" })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const buckets = new Map<string, { r: number; g: number; b: number; n: number }>();
  let opaque = 0;
  for (let i = 0; i < data.length; i += info.channels) {
    const a = data[i + 3]!;
    if (a < 128) continue;
    opaque++;
    const r = data[i]!;
    const g = data[i + 1]!;
    const b = data[i + 2]!;
    // 32-step quantization → up to 8^3 buckets
    const key = `${r >> 5}-${g >> 5}-${b >> 5}`;
    const bucket = buckets.get(key) ?? { r: 0, g: 0, b: 0, n: 0 };
    bucket.r += r;
    bucket.g += g;
    bucket.b += b;
    bucket.n++;
    buckets.set(key, bucket);
  }
  if (opaque === 0) return [];

  return [...buckets.values()]
    .sort((a, b) => b.n - a.n)
    .slice(0, count)
    .map((b) => ({
      hex:
        "#" +
        [b.r / b.n, b.g / b.n, b.b / b.n]
          .map((v) => Math.round(v).toString(16).padStart(2, "0"))
          .join(""),
      fraction: Math.round((b.n / opaque) * 1000) / 1000,
    }));
}
