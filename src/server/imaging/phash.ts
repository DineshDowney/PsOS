import sharp from "sharp";

/**
 * Perceptual difference-hash (dHash): 9×8 grayscale, one bit per adjacent
 * luminance comparison → 64-bit hex string. Two photos of the same garment in
 * similar framing land within a few bits of each other; unrelated photos are
 * typically 25+ bits apart. Used for review-time duplicate FLAGGING only —
 * never auto-merge/auto-delete (per the data-quality philosophy).
 */
export async function dhash(input: Buffer): Promise<string> {
  const { data } = await sharp(input)
    .grayscale()
    .resize(9, 8, { fit: "fill" })
    .raw()
    .toBuffer({ resolveWithObject: true });
  let bits = 0n;
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      bits = (bits << 1n) | (data[y * 9 + x]! < data[y * 9 + x + 1]! ? 1n : 0n);
    }
  }
  return bits.toString(16).padStart(16, "0");
}

/** Hamming distance between two dhash hex strings (0 = identical). */
export function hammingDistance(a: string, b: string): number {
  let x = BigInt("0x" + a) ^ BigInt("0x" + b);
  let n = 0;
  while (x > 0n) {
    n += Number(x & 1n);
    x >>= 1n;
  }
  return n;
}

/** Below this distance two front photos are flagged as likely the same garment. */
export const SIMILARITY_THRESHOLD = 10;
