import sharp from "sharp";

export interface ProcessedImage {
  buffer: Buffer;
  width: number;
  height: number;
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
 * Catalog thumbnail: 640px square on the app's background color so the grid
 * looks uniform. Prefers the transparent cutout when available.
 */
export async function makeThumbnail(
  input: Buffer,
  opts: { background?: string } = {},
): Promise<ProcessedImage> {
  const background = opts.background ?? "#111110";
  const buffer = await sharp(input)
    .resize(640, 640, { fit: "contain", background })
    .flatten({ background })
    .jpeg({ quality: 88 })
    .toBuffer();
  return { buffer, width: 640, height: 640 };
}
