/**
 * Shrink a photo in the browser before uploading it.
 *
 * Phone photos are ~5.8 MB each, so a front+back pair is ~11.4 MB and takes
 * 10-15s to reach the VM over Tailscale Funnel (every byte relays through
 * Bengaluru). At 3000px that pair is closer to 2.4 MB.
 *
 * Why 3000 and not smaller: the import pipeline does NOT feed the upload to
 * Gemini directly. It locates the garment's bounding box, crops to it, and sends
 * the CROP. So the upload's resolution sets the crop's resolution — for a garment
 * filling about half the frame, a 3000px upload yields a ~1500px crop, which is
 * where Gemini's vision path wants to be. A 2000px upload would put that crop
 * near 1000px and [Likely] soften logos, stitching and weave. 3000 is the point
 * where the bytes drop ~5x and the crop is still big enough.
 *
 * This is an optimisation, so it fails soft: anything unexpected (HEIC the
 * browser cannot decode, no canvas, a decode error, a result that came out
 * BIGGER) returns the original file untouched. Shrinking must never be the
 * reason an import fails.
 *
 * Note this permanently lowers the resolution of the archived `front`/`back`
 * originals — see docs/DECISIONS.md. Dinesh's true originals live on the phone
 * and in Downloads\Photos-1-001.
 */

/** Longest edge, in pixels, that we upload. */
export const MAX_EDGE = 3000;
/** JPEG quality for the re-encode. */
export const QUALITY = 0.85;

export interface Size {
  width: number;
  height: number;
}

/**
 * Dimensions to resize to, or null when the image is already small enough.
 *
 * Pure, so the arithmetic is testable without a browser. Rounds rather than
 * floors: flooring a 4000x3000 down to a 3000 long edge gives 2249 on the short
 * edge instead of 2250, and that half-pixel drift is what makes an aspect ratio
 * visibly off on a tall garment.
 */
export function targetSize(width: number, height: number, maxEdge = MAX_EDGE): Size | null {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return null;
  }
  const longest = Math.max(width, height);
  if (longest <= maxEdge) return null;
  const scale = maxEdge / longest;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/** Draw to whichever canvas this browser has, and encode as JPEG. */
async function encodeJpeg(bitmap: ImageBitmap, size: Size): Promise<Blob | null> {
  if (typeof OffscreenCanvas !== "undefined") {
    const canvas = new OffscreenCanvas(size.width, size.height);
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(bitmap, 0, 0, size.width, size.height);
    return canvas.convertToBlob({ type: "image/jpeg", quality: QUALITY });
  }
  // Safari < 16.4 and anything else without OffscreenCanvas.
  const canvas = document.createElement("canvas");
  canvas.width = size.width;
  canvas.height = size.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(bitmap, 0, 0, size.width, size.height);
  return new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", QUALITY));
}

/** Swap the extension for .jpg, since the bytes are now JPEG whatever came in. */
function jpegName(name: string): string {
  return name.replace(/\.[^.]+$/, "") + ".jpg";
}

/**
 * Returns a smaller JPEG, or the original file when shrinking is unnecessary or
 * impossible. Never throws.
 */
export async function downscale(file: File): Promise<File> {
  if (!file.type.startsWith("image/")) return file;

  let bitmap: ImageBitmap | undefined;
  try {
    // `imageOrientation: "from-image"` is load-bearing: without it a photo the
    // phone tagged as rotated draws sideways, and since we re-encode to JPEG the
    // EXIF tag that used to fix it is gone. The garment would be permanently on
    // its side.
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });

    const size = targetSize(bitmap.width, bitmap.height);
    if (!size) return file;

    const blob = await encodeJpeg(bitmap, size);
    // Re-encoding can inflate an already-optimised file; keep whichever is smaller.
    if (!blob || blob.size >= file.size) return file;

    return new File([blob], jpegName(file.name), {
      type: "image/jpeg",
      lastModified: file.lastModified,
    });
  } catch (err) {
    console.warn("[psos] could not shrink photo, uploading it as-is:", err);
    return file;
  } finally {
    bitmap?.close();
  }
}
