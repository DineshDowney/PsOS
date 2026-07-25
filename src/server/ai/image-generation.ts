/**
 * Product-shot regeneration with Gemini.
 *
 * Why this exists: real wardrobe photos (garment on a dark bedsheet, tripod and
 * feet in frame) defeat segmentation. So we redraw the garment as a clean studio
 * shot instead of fighting the photo.
 *
 * The prompt asks for a real alpha channel FIRST — if the model honours it there
 * is no cutout step at all. The flat-grey fallback exists because it is the easy
 * case for `keyFlatBackground()`, and it is spelled out in detail because a
 * single contact shadow or backdrop seam line is enough to block a flood fill
 * (observed 2026-07-25: a 5px floor seam kept the bottom corners opaque).
 *
 * Fidelity is the whole point: the prompt forbids inventing anything the source
 * photo does not show. A generated image that looks great but isn't his shirt is
 * a failure, not a win.
 */
import { generateContent, firstImage, inlineImage } from "@/server/ai/vertex-client";

// Verified against `listModels()` on 2026-07-25. Cheap-first: flash-image tiers
// before the pro/nano-banana-pro tiers.
const DEFAULT_MODELS = [
  "gemini-3.1-flash-image",
  "gemini-2.5-flash-image",
  "gemini-3.1-flash-lite-image",
  "gemini-3-pro-image",
  "nano-banana-pro-preview",
];

export function imageModels(): string[] {
  const override = process.env.VERTEX_IMAGE_MODELS?.trim();
  if (override) return override.split(",").map((m) => m.trim()).filter(Boolean);
  return DEFAULT_MODELS;
}

const PROMPT = `Recreate the garment in this photo as a clean e-commerce product photograph
with the background removed.

Requirements:
- Output a PNG with a REAL ALPHA CHANNEL: every pixel that is not garment must be fully
  transparent (alpha 0). The garment must be perfectly cut out, edge to edge.
- If — and only if — you cannot emit transparency, fall back to a single perfectly flat
  fill of very light neutral grey (#f2f2f0) behind the garment. In that case the fill must
  be ONE uniform tone across the entire frame: no gradient, no vignette, no lighter or
  darker patches, no drop shadow or contact shadow, no reflection, no surface or table, no
  horizon/floor/wall seam line, no border or frame around the image, no rounded corners.
  A single stray line or shaded corner ruins the cutout, so keep it absolutely flat.
- Show ONLY the garment, laid flat and centered, filling most of the frame, shot straight
  on, with a small even margin of empty background on all four sides.
- No props, no text, no watermark, no logo overlay, no colour swatches, no size labels.
- Remove the wearer, skin, hair, hands, feet, mannequin, hanger, tripod, stand, and every part of the room.
- Preserve EXACTLY what the source shows: colour and shade, pattern, print placement and scale, silhouette, sleeve and hem length, collar and cuff construction, visible seams, buttons, zips, drawstrings, and any legible logo or text.
- Do NOT invent, add, restyle, or "improve" anything: no new logos, no added text, no extra pockets or seams, no changed colour, no added folds or styling flourishes. If a detail is unclear in the source, omit it rather than guess.
- Natural, even studio lighting. The garment should look like the same physical item, photographed properly.

Output only the image.`;

export interface ProductShotResult {
  png: Buffer;
  model: string;
}

/**
 * Generate a clean product shot from a garment crop. Returns null when the
 * model declines or returns no image — callers keep whatever they already had.
 */
export async function generateProductShot(
  crop: Buffer,
  mimeType = "image/jpeg",
): Promise<ProductShotResult | null> {
  try {
    const result = await generateContent({
      models: imageModels(),
      parts: [{ text: PROMPT }, inlineImage(crop, mimeType)],
      responseModalities: ["IMAGE"],
      temperature: 0.1,
    });
    const png = firstImage(result);
    if (!png) {
      console.error(
        `[psos] ${result.model} returned no image (finishReason: ${result.candidates?.[0]?.finishReason ?? "unknown"})`,
      );
      return null;
    }
    return { png, model: result.model };
  } catch (err) {
    console.error("[psos] product-shot generation failed:", err instanceof Error ? err.message : err);
    return null;
  }
}
