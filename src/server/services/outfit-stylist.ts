import { and, eq, inArray } from "drizzle-orm";
import sharp from "sharp";
import fs from "node:fs";
import { getDb, schema } from "@/server/db/client";
import { extractJsonObject } from "@/server/lib/json";
import { resolveImagePath } from "@/server/imaging/storage";
import { generateOutfits } from "@/server/engine/outfit-engine";
import { listItems } from "@/server/services/catalog";
import { recentWearCombos } from "@/server/services/wear";
import {
  generateContent,
  firstText,
  inlineImage,
  hasVertexKey,
  DEFAULT_TEXT_MODELS,
  type Part,
} from "@/server/ai/vertex-client";
import type { Formality, Item, OutfitSuggestion, StyledSuggestion, StylistResult } from "@/shared/types";
import { z } from "zod";

/**
 * Outfit suggestions: the engine decides what is ALLOWED, the model decides what
 * is GOOD.
 *
 * The engine used to do both. It is excellent at the first job — it knows what
 * is in the laundry, what was worn yesterday, which slots make a complete
 * outfit, and it never forgets — and weak at the second, because it judges
 * "colour harmony" from a hue wheel applied to the string in `primary_color`.
 * It has never seen the clothes. We now have a clean product shot of every
 * garment, so the taste half can be done by something that can actually look.
 *
 * The split, and why it is safe:
 *
 *   1. `generateOutfits` produces a SHORTLIST of complete, wearable candidates.
 *      Every hard constraint (active, available, one item per slot, freshness,
 *      rotation, recent-repeat penalty) is already satisfied before the model
 *      sees anything.
 *   2. The model reorders that shortlist, drops what it thinks does not work,
 *      and says why in one line.
 *   3. `validate` puts the answer back through the engine's own output. The
 *      model can only return indices into the shortlist, so the worst case is a
 *      bad ORDER — it cannot invent an item, resurrect one from the laundry, or
 *      build an outfit with two pairs of shoes.
 *
 * Any failure at all — no credentials, a model error, unparseable JSON, indices
 * out of range — falls back to the engine's own ranking and says so in
 * `fallbackReason`. Suggestions never fail; they only get less opinionated.
 */

/** Candidates handed to the model. Above ~8 the prompt is mostly noise. */
const SHORTLIST = 8;
/**
 * Distinct garments we will attach images for. The shortlist reuses items
 * heavily, so 8 candidates is usually 9-12 distinct garments; anything past this
 * gets trimmed by DROPPING WHOLE CANDIDATES, never by silently sending fewer
 * images than the prompt claims.
 */
const MAX_TILES = 12;
/** Tiles are re-encoded at this size — a 640px tile costs tokens and shows nothing more. */
const TILE_PX = 256;

const pickSchema = z.object({
  picks: z
    .array(
      z.object({
        candidate: z.string(),
        reason: z.string().trim().min(1).nullable().catch(null),
      }),
    )
    .catch([]),
});

/** "A", "B", "C"… — letters for candidates so they cannot be read as item numbers. */
function label(index: number): string {
  return String.fromCharCode(65 + index);
}

/** Absolute paths to each item's catalog tile, by item id. Read-only. */
function tilePaths(itemIds: string[]): Map<string, string> {
  if (itemIds.length === 0) return new Map();
  const rows = getDb()
    .select({ itemId: schema.itemImages.itemId, path: schema.itemImages.path })
    .from(schema.itemImages)
    .where(
      and(
        inArray(schema.itemImages.itemId, itemIds),
        eq(schema.itemImages.role, "thumbnail"),
      ),
    )
    .all();
  const out = new Map<string, string>();
  for (const row of rows) {
    const abs = resolveImagePath(row.path);
    if (fs.existsSync(abs)) out.set(row.itemId, abs);
  }
  return out;
}

/**
 * Tiles are transparent PNGs; JPEG has no alpha, so they must be flattened.
 * White rather than the app's paper tone — this is model input, and maximum
 * contrast against the garment is the only thing that matters here.
 */
async function tilePart(absPath: string): Promise<Part> {
  const jpeg = await sharp(absPath)
    .resize(TILE_PX, TILE_PX, { fit: "contain", background: "#ffffff" })
    .flatten({ background: "#ffffff" })
    .jpeg({ quality: 80 })
    .toBuffer();
  return inlineImage(jpeg, "image/jpeg");
}

function describeItem(item: Item, n: number): string {
  const bits = [
    item.subcategory ?? item.category ?? "garment",
    item.primaryColor,
    item.pattern && item.pattern !== "solid" ? item.pattern : null,
    item.formality,
    item.material,
  ].filter(Boolean);
  return `Item ${n}: ${item.name} — ${bits.join(", ")}`;
}

function buildPrompt(
  candidates: OutfitSuggestion[],
  itemNumber: Map<string, number>,
  formality?: Formality,
): string {
  const lines = candidates.map((c, i) => {
    const parts = c.items.map((x) => `${x.slot} = Item ${itemNumber.get(x.item.id)}`);
    return `Candidate ${label(i)}: ${parts.join(", ")}`;
  });

  return `You are styling one man's personal wardrobe. Every garment below is his, and the
attached images are catalog shots of those exact garments, in item-number order.

${[...itemNumber.entries()]
  .map(([, n]) => n)
  .sort((a, b) => a - b)
  .map((n) => `Item ${n}`)
  .join(", ")} correspond to the attached images in order.

These candidate outfits are already valid: everything in them is clean, available, and fills a
sensible slot. Your job is ONLY to judge which ones actually look good together, using the
images — colour and tone against each other, pattern clashes, whether the formality reads as
one deliberate outfit rather than three separate decisions.

${lines.join("\n")}
${formality ? `\nHe asked for something ${formality.replace("_", " ")}.` : ""}

Return ONLY a JSON object (no prose before or after):
{
  "picks": [
    { "candidate": "A", "reason": "one short sentence on why this works" }
  ]
}

Rules:
- Order "picks" best first. That order is the whole point of asking you.
- DROP any candidate you would not actually wear together. Returning three good outfits beats
  returning eight with five duds. Returning none is allowed if none of them work.
- Only use candidate letters from the list above. Do not invent outfits or swap items.
- REASON: one sentence, concrete and about THESE clothes ("the rust tee warms up the cold
  grey"), never generic filler ("a stylish, versatile look"). No preamble.`;
}

/**
 * Trim the shortlist until its distinct-item count fits MAX_TILES. Drops whole
 * candidates from the bottom (they are already score-ordered), so the prompt and
 * the attached images can never disagree about how many items exist.
 *
 * Exported for tests: this and `validatePicks` are the two places a bug would be
 * invisible in the output but wrong.
 */
export function fitToTileBudget(candidates: OutfitSuggestion[]): OutfitSuggestion[] {
  const kept: OutfitSuggestion[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const ids = candidate.items.map((x) => x.item.id);
    const next = new Set([...seen, ...ids]);
    if (next.size > MAX_TILES && kept.length > 0) break;
    kept.push(candidate);
    for (const id of ids) seen.add(id);
  }
  return kept;
}

/**
 * The safety net. Turns whatever the model said into suggestions, keeping only
 * picks that name a candidate we actually sent.
 *
 * This is what makes the whole arrangement safe: because a pick can only be an
 * index into the shortlist, a hallucinating model produces a worse ORDER and
 * nothing else. It cannot invent a garment, pull one out of the laundry, or put
 * two pairs of shoes in one outfit — the engine already settled all of that.
 */
export function validatePicks(
  shortlist: OutfitSuggestion[],
  picks: Array<{ candidate: string; reason: string | null }>,
  count: number,
): StyledSuggestion[] {
  const byLabel = new Map(shortlist.map((c, i) => [label(i), c]));
  const used = new Set<string>();
  const out: StyledSuggestion[] = [];
  for (const pick of picks) {
    const key = pick.candidate.trim().toUpperCase();
    const candidate = byLabel.get(key);
    if (!candidate || used.has(key)) continue;
    used.add(key);
    out.push({ ...candidate, reason: pick.reason });
    if (out.length >= count) break;
  }
  return out;
}

export interface StylistOptions {
  formality?: Formality;
  /** How many suggestions to return. */
  count?: number;
}

/** Engine ranking, unstyled — the answer whenever the model cannot be used. */
function engineOnly(
  candidates: OutfitSuggestion[],
  count: number,
  fallbackReason: string | null,
): StylistResult {
  return {
    suggestions: candidates.slice(0, count).map((s) => ({ ...s, reason: null })),
    rankedBy: "engine",
    fallbackReason,
  };
}

export async function suggestOutfits(opts: StylistOptions = {}): Promise<StylistResult> {
  const count = opts.count ?? 4;
  const candidates = generateOutfits(listItems(), {
    recentCombos: recentWearCombos(),
    formality: opts.formality,
    count: SHORTLIST,
  });

  if (candidates.length === 0) return engineOnly(candidates, count, null);
  if (!hasVertexKey()) {
    return engineOnly(candidates, count, "Gemini is not configured here — engine ranking only");
  }

  const shortlist = fitToTileBudget(candidates);

  // Item numbers are assigned in first-appearance order across the shortlist, so
  // the numbering the prompt uses is the order the images are attached in.
  const itemNumber = new Map<string, number>();
  const items: Item[] = [];
  for (const candidate of shortlist) {
    for (const { item } of candidate.items) {
      if (itemNumber.has(item.id)) continue;
      itemNumber.set(item.id, itemNumber.size + 1);
      items.push(item);
    }
  }

  const tiles = tilePaths(items.map((i) => i.id));
  // An item with no tile on disk would break the image/number correspondence,
  // which is worse than not asking the model at all.
  const missing = items.filter((i) => !tiles.has(i.id));
  if (missing.length > 0) {
    return engineOnly(
      candidates,
      count,
      `${missing.length} item(s) have no catalog tile on disk — engine ranking only`,
    );
  }

  try {
    const parts: Part[] = [
      { text: buildPrompt(shortlist, itemNumber, opts.formality) },
      { text: items.map((item, i) => describeItem(item, i + 1)).join("\n") },
      ...(await Promise.all(items.map((item) => tilePart(tiles.get(item.id)!)))),
    ];

    const result = await generateContent({
      models: DEFAULT_TEXT_MODELS,
      parts,
      responseMimeType: "application/json",
      temperature: 0.4, // taste, not extraction — a little variety between asks
      maxOutputTokens: 1024,
    });

    const parsed = pickSchema.parse(extractJsonObject(firstText(result)));
    const suggestions = validatePicks(shortlist, parsed.picks, count);

    if (suggestions.length === 0) {
      return engineOnly(candidates, count, "The model returned no usable picks");
    }
    return { suggestions, rankedBy: "model", fallbackReason: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[psos] outfit styling failed, falling back to the engine:", message);
    return engineOnly(candidates, count, `Styling failed (${message})`);
  }
}
