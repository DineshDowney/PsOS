/**
 * Product-shot regeneration with Gemini.
 *
 * Why this exists: real wardrobe photos (garment on a dark bedsheet, tripod and
 * feet in frame) defeat segmentation. Gemini cannot output transparency, so it
 * does not replace the cutout step — it replaces its INPUT: redraw the garment
 * as a clean studio shot on a seamless light background, which is the easy case
 * for `removeBackground()` + `cutoutQa`.
 *
 * Fidelity is the whole point: the prompt forbids inventing anything the source
 * photo does not show. A generated image that looks great but isn't his shirt is
 * a failure, not a win.
 */
import { generateContent, firstImage, inlineImage } from "@/server/ai/vertex-client";

const DEFAULT_MODELS = [
  "gemini-2.5-flash-image",
  "gemini-3-pro-image-preview",
  "gemini-2.5-flash-image-preview",
  "gemini-2.0-flash-preview-image-generation",
];

export function imageModels(): string[] {
  const override = process.env.VERTEX_IMAGE_MODELS?.trim();
  if (override) return override.split(",").map((m) => m.trim()).filter(Boolean);
  return DEFAULT_MODELS;
}

const PROMPT = `Recreate the garment in this photo as a clean e-commerce product photograph.

Requirements:
- Show ONLY the garment, laid flat and centered, filling most of the frame, shot straight on.
- Background: seamless, even, very light neutral grey (#f2f2f0). No gradient, no props, no shadows cast onto the background, no floor line, no text, no watermark.
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
