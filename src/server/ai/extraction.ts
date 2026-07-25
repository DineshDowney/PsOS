import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { runAgentToResult } from "@/server/ai/agent";
import {
  generateContent,
  firstText,
  inlineImage,
  hasVertexKey,
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
 * Two engines behind one contract:
 *  - claude: the Agent SDK Reads photo paths off disk (Claude Code's Read tool
 *    handles images natively).
 *  - gemini: photos are base64-inlined into a Vertex request (no filesystem
 *    access there), JSON requested via responseMimeType.
 *
 * Engine selection: `ai.extractionEngine` setting ("claude" | "gemini" |
 * "auto"), default auto = gemini when a Vertex key is present, else claude.
 * That makes the VM (no Claude login, key in .env.local) work without a flip,
 * while the laptop keeps using Claude.
 *
 * Prompted for correctness over completeness either way: null beats a guess,
 * and every field carries a confidence.
 */

// Verified against `listModels()` on 2026-07-25 (the 2.x ids are retired).
const DEFAULT_GEMINI_MODELS = [
  "gemini-flash-latest",
  "gemini-3.6-flash",
  "gemini-3.5-flash",
  "gemini-2.5-flash-lite",
];

function geminiModels(): string[] {
  const configured = getSetting("ai.extractionModel");
  const envOverride = process.env.VERTEX_TEXT_MODELS?.trim();
  if (envOverride) return envOverride.split(",").map((m) => m.trim()).filter(Boolean);
  // A Claude model id in that setting must not leak into Vertex.
  if (configured && !configured.startsWith("claude")) return [configured, ...DEFAULT_GEMINI_MODELS];
  return DEFAULT_GEMINI_MODELS;
}

export function extractionEngine(): "claude" | "gemini" {
  const setting = (getSetting("ai.extractionEngine") ?? "auto").toLowerCase();
  if (setting === "gemini") return "gemini";
  if (setting === "claude") return "claude";
  return hasVertexKey() ? "gemini" : "claude";
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
  bbox: bboxSchema,
  bbox_back: bboxSchema,
});

interface PromptOptions {
  /**
   * How the prompt should refer to the photos: file paths (Claude reads them) or
   * a sentence about attached images (Gemini gets them inline).
   */
  imageRef: string;
  dominant: DominantColor[];
  /**
   * Ask for garment boxes too. False when the input is an already-cropped or
   * generated product shot, where a box is meaningless — the pipeline gets its
   * boxes from `extractBoundingBox` on the ORIGINAL photos instead, so each call
   * has exactly one job.
   */
  withBoxes: boolean;
}

function buildPrompt({ imageRef, dominant, withBoxes }: PromptOptions): string {
  const dominantNote =
    dominant.length > 0
      ? `Pixel analysis of this garment reports these dominant colours: ${dominant
          .map((d) => `${d.hex} (${Math.round(d.fraction * 100)}%)`)
          .join(", ")}. Use it as a cross-check when naming colours, not as the answer.`
      : "";

  const boxKeys = withBoxes
    ? `,
  "bbox": { "x": number, "y": number, "w": number, "h": number } | null,  // ${BOX_INSTRUCTION}
  "bbox_back": { same shape } | null  // same, but for the BACK photo; null when no back photo given`
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
  "confidence": { [field]: number }  // 0-1 per field you filled${boxKeys}
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
  captured in the fields above (do not tag the colour or the category).${
    withBoxes ? `\n- BBOX: ${BOX_INSTRUCTION}` : ""
  }`;
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
  imagePaths: string[]; // absolute paths
  dominant: DominantColor[];
  /**
   * What the model is looking at. "product-shot" = the clean regenerated images,
   * which read far better than a crumpled flat-lay on a bedsheet; garment boxes
   * are then meaningless and are not requested (the pipeline takes them from
   * `extractBoundingBox` on the originals). Defaults to "photo".
   */
  sourceKind?: "photo" | "product-shot";
}

/** How to describe the input images to the model. */
function describeInput(kind: "photo" | "product-shot", count: number, paths?: string[]): string {
  const sides =
    count > 1
      ? "the first is the FRONT, the second is the BACK"
      : "it shows the FRONT only; there is no back image";
  if (paths) {
    const list = paths.map((p) => `- ${p}`).join("\n");
    return kind === "product-shot"
      ? `Read these clean catalog product shots of ONE item (${sides}):\n${list}`
      : `Read these photo file(s) of ONE item (${sides}). They are casual flat-lay photos — ignore the surface, surroundings and lighting:\n${list}`;
  }
  return kind === "product-shot"
    ? `The attached images are clean catalog product shots of ONE item, regenerated from the original photos (${sides}). Judge the garment from these.`
    : `The attached photos show ONE item (${sides}). They are casual flat-lay photos — ignore the surface, surroundings and lighting.`;
}

export async function extractItemMetadata(input: ExtractionInput): Promise<AiInference> {
  const engine = extractionEngine();
  let resultText: string;
  let usedModel: string;

  const kind = input.sourceKind ?? "photo";
  const withBoxes = kind === "photo";

  if (engine === "gemini") {
    const imageRef = describeInput(kind, input.imagePaths.length);
    const result = await generateContent({
      models: geminiModels(),
      parts: [
        { text: buildPrompt({ imageRef, dominant: input.dominant, withBoxes }) },
        ...imageParts(input.imagePaths),
      ],
      responseMimeType: "application/json",
      temperature: 0.1,
      maxOutputTokens: 2048,
    });
    resultText = firstText(result);
    usedModel = result.model;
  } else {
    const model = getSetting("ai.extractionModel") ?? undefined;
    const imageRef = describeInput(kind, input.imagePaths.length, input.imagePaths);
    resultText = await runAgentToResult({
      prompt: buildPrompt({ imageRef, dominant: input.dominant, withBoxes }),
      allowedTools: ["Read"],
      maxTurns: 8,
      model,
    });
    usedModel = model ?? "claude-code-default";
  }

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
    model: usedModel,
    extractedAt: nowIso(),
  };
}

/**
 * Lightweight garment-box-only extraction — for backfilling thumbnails on
 * items imported before bbox existed. Cheaper/faster than a full re-extract
 * and it never touches metadata, so reviewed fields are untouched.
 */
export async function extractBoundingBox(imagePath: string): Promise<BBox | null> {
  const engine = extractionEngine();
  const jsonShape = `Return ONLY a JSON object (no prose) of the form:
{ "bbox": { "x": number, "y": number, "w": number, "h": number } | null }
${BOX_INSTRUCTION}`;

  let text: string;
  if (engine === "gemini") {
    const result = await generateContent({
      models: geminiModels(),
      parts: [{ text: `This is a clothing photo.\n${jsonShape}` }, ...imageParts([imagePath])],
      responseMimeType: "application/json",
      temperature: 0,
      maxOutputTokens: 256,
    });
    text = firstText(result);
  } else {
    text = await runAgentToResult({
      prompt: `Read this clothing photo: ${imagePath}\n${jsonShape}`,
      allowedTools: ["Read"],
      maxTurns: 6,
      model: getSetting("ai.extractionModel") ?? undefined,
    });
  }
  const parsed = z.object({ bbox: bboxSchema }).parse(extractJsonObject(text));
  return parsed.bbox as BBox | null;
}
