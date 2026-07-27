import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  generateContent,
  firstText,
  inlineImage,
  DEFAULT_TEXT_MODELS,
  type Part,
} from "@/server/ai/vertex-client";
import { extractJsonObject } from "@/server/lib/json";
import { getSetting } from "@/server/services/settings";
import { nowIso } from "@/server/lib/ids";
import {
  CATEGORIES,
  FORMALITIES,
  SEASONS,
  type AiInference,
  type BBox,
  type EditableFields,
} from "@/shared/types";
import type { DominantColor } from "@/server/imaging/dominant-colors";

/** How to frame a garment box, kept next to the only call that asks for one. */
const BOX_INSTRUCTION =
  'A tight box around ONLY the garment in the FRONT photo, as fractions 0..1 of ' +
  'image width/height ("x","y" = top-left corner). EXCLUDE any tripod, monopod, ' +
  'stand, pole, feet, hands, hanger, and background. Use null if you cannot locate ' +
  "it confidently.";

const bboxSchema = z
  .object({
    x: z.number(),
    y: z.number(),
    w: z.number(),
    h: z.number(),
  })
  .nullable()
  .catch(null);

/**
 * Vision metadata extraction for the import pipeline. Gemini only — photos are
 * base64-inlined into a Vertex request and JSON is requested via
 * responseMimeType.
 *
 * The Claude/Agent-SDK path was removed on 2026-07-27. It existed because the
 * laptop had a Claude login and no Gemini credentials while the VM had the
 * reverse, so `auto` picked whichever was present. Nothing imports on the laptop
 * any more, so the branch was a second way to do one job.
 *
 * Prompted for correctness over completeness: null beats a guess, and every
 * field carries a confidence.
 */

function geminiModels(): string[] {
  const configured = getSetting("ai.extractionModel");
  const envOverride = process.env.VERTEX_TEXT_MODELS?.trim();
  if (envOverride) return envOverride.split(",").map((m) => m.trim()).filter(Boolean);
  // Settings written before extraction was Gemini-only may still hold a Claude
  // model id; it must never be sent to Vertex.
  if (configured && !configured.startsWith("claude")) return [configured, ...DEFAULT_TEXT_MODELS];
  return DEFAULT_TEXT_MODELS;
}

const nullableString = z.string().trim().min(1).nullable().catch(null);

const extractionSchema = z.object({
  name: z.string().trim().min(1).catch("Unnamed item"),
  category: z.enum(CATEGORIES).nullable().catch(null),
  subcategory: nullableString,
  description: nullableString,
  primary_color: nullableString,
  secondary_colors: z.array(z.string()).catch([]),
  color_detail: nullableString,
  pattern: nullableString,
  fit: nullableString,
  material: nullableString,
  brand: nullableString,
  formality: z.enum(FORMALITIES).nullable().catch(null),
  seasons: z.array(z.enum(SEASONS)).catch([]),
  tags: z.array(z.string()).catch([]),
  confidence: z.record(z.string(), z.number().min(0).max(1)).catch({}),
});

interface PromptOptions {
  /** The image manifest + authority rule, built by `describeImages`. */
  imageRef: string;
  dominant: DominantColor[];
}

function buildPrompt({ imageRef, dominant }: PromptOptions): string {
  const dominantNote =
    dominant.length > 0
      ? `Pixel analysis of this garment reports these dominant colours: ${dominant
          .map((d) => `${d.hex} (${Math.round(d.fraction * 100)}%)`)
          .join(", ")}. Use it as a cross-check when naming colours, not as the answer.`
      : "";

  return `You are cataloguing one clothing item for a personal wardrobe app.
${imageRef}

${dominantNote}

Return ONLY a JSON object (no prose before or after) with exactly these keys:
{
  "name": string,                    // see the naming rule below
  "category": ${JSON.stringify(CATEGORIES)} | null,
  "subcategory": string | null,      // e.g. "t-shirt", "chinos", "sneakers"
  "description": string | null,      // 1-2 sentences, plain and factual
  "primary_color": string | null,    // one common colour name
  "secondary_colors": string[],
  "color_detail": string | null,     // nuance, e.g. "washed indigo fading to sky blue"
  "pattern": string | null,          // e.g. "solid", "striped", "checked", "block print"
  "fit": string | null,              // e.g. "slim", "regular", "oversized" — only if visually evident
  "material": string | null,         // ONLY if reasonably inferable from texture/sheen; else null
  "brand": string | null,            // ONLY if a logo/label is clearly legible; else null
  "formality": ${JSON.stringify(FORMALITIES)} | null,
  "seasons": ${JSON.stringify(SEASONS)} (multi-select, [] if unclear),
  "tags": string[],                  // 3-8 lowercase style tags, e.g. ["minimal","streetwear","layering"]
  "confidence": { [field]: number }  // 0-1 per field you filled
}

Rules:
- Correctness over completeness: use null when not reasonably inferable. Never guess brand
  or material. A null is more useful than a plausible invention.
- NAME: 2-4 words, Title Case, shaped as [distinguishing detail] [colour] [garment type] —
  e.g. "Faded Black Crewneck", "Indigo Block-Print Kurta", "Ombré Blue Athletic Tee".
  Never put the brand in the name (it has its own field). No filler adjectives ("nice",
  "stylish"), no size, no condition. Every item in this wardrobe is named this way, so keep
  the shape consistent — these names are read side by side in a grid.
- COLOUR: judge the garment's own colour, ignoring background, skin and lighting. Prefer a
  specific everyday name ("charcoal", "rust", "olive", "ecru") over a vague one ("dark",
  "multi", "light"). Keep "primary_color" to a single plain name and put the nuance,
  gradients and ombré transitions in "color_detail".
- CATEGORY must be one of the allowed values. Disambiguation, since these recur:
  - t-shirts, shirts, kurtas, sweatshirts, hoodies, vests worn as the main layer -> "top"
  - trousers, jeans, shorts, boxers, briefs, trunks, any underwear bottom -> "bottom"
  - dresses, jumpsuits, overalls, co-ord sets worn as one piece -> "full_body"
  - jackets, coats, blazers, overshirts worn OVER a top -> "outerwear"
  - shoes, sneakers, sandals, slippers, boots -> "footwear"
  - caps, hats, belts, socks, bags, watches, scarves, sunglasses -> "accessory"
- FORMALITY: use "athletic" for sportswear and activewear even when it could pass as casual
  (performance fabric, mesh panels, sports branding are the tell).
- SEASONS: base it on fabric weight and coverage, not colour. Leave [] rather than guessing.
- TAGS: describe style and use ("gym", "layering", "monsoon-friendly"), not facts already
  captured in the fields above (do not tag the colour or the category).`;
}

const MIME_BY_EXT: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

function imageParts(imagePaths: string[]): Part[] {
  return imagePaths.map((p) =>
    inlineImage(fs.readFileSync(p), MIME_BY_EXT[path.extname(p).toLowerCase()] ?? "image/jpeg"),
  );
}

export interface ExtractionInput {
  /**
   * The real photographs, absolute paths, front then back. AUTHORITATIVE on what
   * the garment actually is — always send these, cropped to the garment where a
   * crop exists.
   */
  photoPaths: string[];
  /**
   * The regenerated studio shots for the same item, front then back, when the
   * pipeline produced them. Clearer on silhouette and construction, but they are
   * a model's redrawing and can drift on colour and print, so the prompt ranks
   * them below the photographs.
   */
  productShotPaths?: string[];
  dominant: DominantColor[];
}

/**
 * The image manifest and the authority rule — the part of the prompt that stops
 * a redraw's mistakes from becoming recorded facts.
 *
 * Metadata used to be read off the generated shots alone, because a clean
 * isolated garment reads better than a crumpled flat-lay. That created a loop
 * with no correction: a generation shifts a colour, the shift is recorded as
 * metadata, and `regenerateSide` then grounds the NEXT generation in that
 * metadata (see itemFacts in imaging/regenerate.ts). Each retry drifts further
 * from the real garment while looking more self-consistent.
 *
 * Sending both, with the photograph ranked first, keeps the clean view for
 * shape while anchoring identity to the thing that was actually photographed.
 */
function describeImages(photos: number, shots: number): string {
  const sides = (n: number) =>
    n > 1 ? "front then back" : "front only — there is no back image";

  const lines = [
    `Images 1-${photos} are the ORIGINAL PHOTOGRAPHS of ONE item (${sides(photos)}).`,
    "They are casual flat-lay photos — ignore the surface, surroundings and lighting.",
  ];
  if (shots > 0) {
    lines.push(
      `Images ${photos + 1}-${photos + shots} are CLEANED-UP RENDERS of the same item ` +
        `(${sides(shots)}), regenerated from those photographs.`,
      "",
      "AUTHORITY: the photographs are the item. Where a render disagrees with a photograph " +
        "about colour, shade, pattern, print placement, material or branding, the PHOTOGRAPH " +
        "is correct — a render is a redrawing and can drift. Use the renders only for what " +
        "they genuinely show better: silhouette, cut, construction details, and text or logos " +
        "obscured by a crease in the original.",
    );
  }
  return lines.join("\n");
}

export async function extractItemMetadata(input: ExtractionInput): Promise<AiInference> {
  const shots = input.productShotPaths ?? [];
  const imageRef = describeImages(input.photoPaths.length, shots.length);

  const result = await generateContent({
    models: geminiModels(),
    parts: [
      { text: buildPrompt({ imageRef, dominant: input.dominant }) },
      // Order is load-bearing: it is what the numbering in `imageRef` refers to.
      ...imageParts([...input.photoPaths, ...shots]),
    ],
    responseMimeType: "application/json",
    temperature: 0.1,
    maxOutputTokens: 2048,
  });

  const raw = extractionSchema.parse(extractJsonObject(firstText(result)));

  const fields: Partial<EditableFields> = {
    name: raw.name,
    category: raw.category,
    subcategory: raw.subcategory,
    description: raw.description,
    primaryColor: raw.primary_color,
    secondaryColors: raw.secondary_colors,
    colorDetail: raw.color_detail,
    pattern: raw.pattern,
    fit: raw.fit,
    material: raw.material,
    brand: raw.brand,
    formality: raw.formality,
    seasons: raw.seasons,
  };

  return {
    fields,
    confidence: raw.confidence,
    tags: raw.tags.map((t) => t.toLowerCase().trim()).filter(Boolean),
    // Boxes are not asked for here — `extractBoundingBox` is a separate, cheaper
    // call against the ORIGINAL full-frame photos, and the pipeline folds its
    // result in. One call, one job.
    bbox: null,
    bboxBack: null,
    model: result.model,
    extractedAt: nowIso(),
  };
}

/**
 * Garment-box-only extraction, against an ORIGINAL full-frame photo. A separate,
 * cheaper call than the metadata one: it has a single job, and it never touches
 * metadata, so reviewed fields cannot be disturbed by asking where the garment is.
 */
export async function extractBoundingBox(imagePath: string): Promise<BBox | null> {
  const jsonShape = `Return ONLY a JSON object (no prose) of the form:
{ "bbox": { "x": number, "y": number, "w": number, "h": number } | null }
${BOX_INSTRUCTION}`;

  const result = await generateContent({
    models: geminiModels(),
    parts: [{ text: `This is a clothing photo.\n${jsonShape}` }, ...imageParts([imagePath])],
    responseMimeType: "application/json",
    temperature: 0,
    maxOutputTokens: 256,
  });
  const parsed = z.object({ bbox: bboxSchema }).parse(extractJsonObject(firstText(result)));
  return parsed.bbox as BBox | null;
}
