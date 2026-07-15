import { z } from "zod";
import { runAgentToResult } from "@/server/ai/agent";
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

/** Shared instruction for locating the garment box — one wording, two callers. */
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
 * Vision metadata extraction for the import pipeline.
 *
 * The agent Reads the item's photos from disk (Claude Code's Read tool handles
 * images natively) and returns structured JSON. Prompted for correctness over
 * completeness: null beats a guess, and every field carries a confidence.
 */

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
  bbox: bboxSchema,
  bbox_back: bboxSchema,
});

function buildPrompt(imagePaths: string[], dominant: DominantColor[]): string {
  const dominantNote =
    dominant.length > 0
      ? `Pixel analysis of the (background-removed) photo reports these dominant colors: ${dominant
          .map((d) => `${d.hex} (${Math.round(d.fraction * 100)}%)`)
          .join(", ")}. Use this as a cross-check when naming colors.`
      : "";

  return `You are cataloguing one clothing item for a personal wardrobe app.
Read these photo file(s) of the SAME item (front and back):
${imagePaths.map((p) => `- ${p}`).join("\n")}

${dominantNote}

Return ONLY a JSON object (no prose before or after) with exactly these keys:
{
  "name": string,                    // short display name, e.g. "White Oxford Shirt"
  "category": ${JSON.stringify(CATEGORIES)} | null,
  "subcategory": string | null,      // e.g. "t-shirt", "chinos", "sneakers"
  "description": string | null,      // 1-2 sentences, plain and factual
  "primary_color": string | null,    // common color name
  "secondary_colors": string[],
  "color_detail": string | null,     // nuanced description, e.g. "washed light blue"
  "pattern": string | null,          // e.g. "solid", "striped", "checked"
  "fit": string | null,              // e.g. "slim", "regular", "oversized" — only if visually evident
  "material": string | null,         // ONLY if reasonably inferable from texture/sheen; else null
  "brand": string | null,            // ONLY if a logo/label is clearly visible; else null
  "formality": ${JSON.stringify(FORMALITIES)} | null,
  "seasons": ${JSON.stringify(SEASONS)} (multi-select, [] if unclear),
  "tags": string[],                  // 3-8 lowercase style tags, e.g. ["minimal","streetwear","layering"]
  "confidence": { [field]: number }, // 0-1 per field you filled
  "bbox": { "x": number, "y": number, "w": number, "h": number } | null,  // ${BOX_INSTRUCTION}
  "bbox_back": { same shape } | null  // same, but for the BACK photo; null when no back photo given
}

Rules:
- Correctness over completeness: use null when not reasonably inferable. Never guess brand or material.
- Judge colors from the garment itself, ignoring background and skin.
- "category" must be one of the allowed values ("full_body" = dresses, jumpsuits, overalls).
- bbox: ${BOX_INSTRUCTION}`;
}

export interface ExtractionInput {
  imagePaths: string[]; // absolute paths
  dominant: DominantColor[];
}

export async function extractItemMetadata(input: ExtractionInput): Promise<AiInference> {
  const model = getSetting("ai.extractionModel") ?? undefined;
  const resultText = await runAgentToResult({
    prompt: buildPrompt(input.imagePaths, input.dominant),
    allowedTools: ["Read"],
    maxTurns: 8,
    model,
  });

  const raw = extractionSchema.parse(extractJsonObject(resultText));

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
    bbox: raw.bbox as BBox | null,
    bboxBack: raw.bbox_back as BBox | null,
    model: model ?? "claude-code-default",
    extractedAt: nowIso(),
  };
}

/**
 * Lightweight garment-box-only extraction — for backfilling thumbnails on
 * items imported before bbox existed. Cheaper/faster than a full re-extract
 * and it never touches metadata, so reviewed fields are untouched.
 */
export async function extractBoundingBox(imagePath: string): Promise<BBox | null> {
  const model = getSetting("ai.extractionModel") ?? undefined;
  const prompt = `Read this clothing photo: ${imagePath}
Return ONLY a JSON object (no prose) of the form:
{ "bbox": { "x": number, "y": number, "w": number, "h": number } | null }
${BOX_INSTRUCTION}`;
  const text = await runAgentToResult({
    prompt,
    allowedTools: ["Read"],
    maxTurns: 6,
    model,
  });
  const parsed = z.object({ bbox: bboxSchema }).parse(extractJsonObject(text));
  return parsed.bbox as BBox | null;
}
