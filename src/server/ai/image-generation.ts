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
 * single contact shadow or backdrop seam line is enough to block a flood fill.
 *
 * The prompt is split into PRESENTATION and IDENTITY on purpose. What makes the
 * wardrobe grid look designed is not per-image beauty, it is every tile sharing
 * one pose, one lighting setup and one framing — so those are pinned down
 * exhaustively. Identity is then fenced off separately: the model may press the
 * garment (the source photos are crumpled flat-lays on a bed, and faithfully
 * reproducing the wrinkles is what made the old catalog look cheap) but may not
 * touch colour, pattern, construction or logos. A shot that looks great but is
 * not his garment is a failure, not a win.
 *
 * Fidelity is the whole point: the prompt forbids inventing anything the source
 * photo does not show. A generated image that looks great but isn't his shirt is
 * a failure, not a win.
 */
import { generateContent, firstImage, inlineImage } from "@/server/ai/vertex-client";
import { createLimiter } from "@/server/lib/limiter";

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

/** Exported for image-generation.test.ts's byte-identity check. */
export const PROMPT_BASE = `Recreate this exact garment as a single catalog product shot with the
background removed.

OUTPUT FORMAT
- A PNG with a REAL ALPHA CHANNEL: every pixel that is not garment is fully transparent
  (alpha 0). The garment must be cut out cleanly, edge to edge.
- If — and only if — you cannot emit transparency, fill the background with ONE perfectly
  flat tone of very light neutral grey (#f2f2f0). That fill must be uniform across the
  entire frame: no gradient, no vignette, no lighter or darker patches, no drop shadow or
  contact shadow, no reflection, no table or floor, no horizon/wall seam line, no border or
  frame, no rounded corners. A single stray line or shaded corner ruins the cutout.

PRESENTATION — identical for every garment, so that a grid of these reads as one shoot
- Ghost-mannequin flat lay: the garment faces the camera dead straight on, symmetric, with
  the natural volume of being worn by an invisible body. No perspective, no tilt, no
  rotation, no three-quarter angle, no folding for display.
- Centred and upright, filling most of the frame, with an even margin of empty space on all
  four sides.
- Tops: shoulders level, sleeves relaxed slightly away from the body, cuffs and hem straight
  and level, collar sitting naturally open.
- Bottoms: legs straight and parallel, waistband level and fully visible.
- Soft, even, frontal studio light. No cast shadow, no hotspot, no glare, no vignette.
- Crisp silhouette edges — no glow, halo, blur or feathering around the outline.
- Present the garment freshly steamed: smooth away the random creases, crumples and
  bedsheet wrinkles of the source photo. Keep only the structural folds that are part of the
  garment itself (pleats, cuffs, plackets, seams, ribbing).

IDENTITY — never change any of this
- Colour and exact shade, including gradients and ombré transitions.
- Pattern, print, and graphic: same design, same placement, same scale, same orientation.
- Silhouette and proportions: neckline shape, sleeve length, hem length, overall cut.
- Construction details: seams, panels, stitching, buttons, zips, drawstrings, pockets,
  ribbing, collar and cuff style.
- Any logo, badge or legible text: reproduce it as it appears, in the same position and size.
- Do NOT invent, add, remove, restyle or "upgrade" anything: no new logos, no added text, no
  extra pockets or seams, no changed colour, no styling flourishes. If a detail is unclear in
  the source, omit it rather than guess at it.
- Remove everything that is not the garment: the wearer, skin, hair, hands, feet, mannequin,
  hanger, tripod, stand, bedsheet, and every part of the room. No props, no watermark, no
  colour swatches, no size labels.

The result must be recognisable as the SAME physical item, photographed properly for the
first time.

Output only the image.`;

/**
 * Grounding for a regeneration, added 2026-07-26. Optional and additive: every
 * existing caller (the import pipeline's first pass, the batch script with no
 * facts computed yet) passes nothing and gets PROMPT_BASE back byte-for-byte —
 * verified in image-generation.test.ts so this never silently drifts.
 */
export interface RegenContext {
  /**
   * Pre-formatted lines like "Colour: Oatmeal (heathered)", built by the caller
   * from the item's CURRENT metadata (post user-edits). Deliberately excludes
   * brand: naming a brand risks the model drawing a generic version of that
   * logo instead of copying the exact pixels in the photo, which fights the
   * IDENTITY section's "reproduce it as it appears" rule below.
   */
  facts?: string[];
  /** Dinesh's own words on what was wrong last time. Empty/omitted = no section. */
  feedback?: string;
}

/** Exported for image-generation.test.ts. */
export function buildPrompt(context?: RegenContext): string {
  let prompt = PROMPT_BASE;
  if (context?.facts?.length) {
    prompt += `\n\nKNOWN FACTS ABOUT THIS GARMENT (from cataloguing — trust these over your own
read of the photo where they disagree)
${context.facts.map((f) => `- ${f}`).join("\n")}`;
  }
  const feedback = context?.feedback?.trim();
  if (feedback) {
    prompt += `\n\nREQUIRED FIX FOR THIS REGENERATION (Dinesh's own words — follow this
precisely, even where it means overriding a default above)
"${feedback}"`;
  }
  return prompt;
}

export interface ProductShotResult {
  png: Buffer;
  model: string;
}

/**
 * One image call at a time, process-wide.
 *
 * The image models are rate-limited per MINUTE, and the import queue runs two
 * pipelines concurrently — so two simultaneous calls mostly buy two 429s and
 * two backoff sleeps (20s/45s/90s each). Strictly sequential finishes a batch
 * sooner than parallel-with-backoff, and it costs nothing when only one import
 * is in flight. Deliberately wraps ONLY the image call: the rest of each
 * pipeline stays concurrent.
 */
const imageCallLimiter = createLimiter(1);

/**
 * Generate a clean product shot from a garment crop. Returns null when the
 * model declines or returns no image — callers keep whatever they already had.
 */
export async function generateProductShot(
  crop: Buffer,
  mimeType = "image/jpeg",
  context?: RegenContext,
): Promise<ProductShotResult | null> {
  return imageCallLimiter(() => generateProductShotNow(crop, mimeType, context));
}

async function generateProductShotNow(
  crop: Buffer,
  mimeType: string,
  context?: RegenContext,
): Promise<ProductShotResult | null> {
  try {
    const result = await generateContent({
      models: imageModels(),
      parts: [{ text: buildPrompt(context) }, inlineImage(crop, mimeType)],
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
