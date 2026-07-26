/**
 * Turn a generated product shot into a transparent cutout.
 *
 * Shared by the import pipeline and `scripts/regenerate-images.ts` — they used to
 * hold separate copies, which is exactly how two code paths drift into disagreeing
 * about what a good cutout is.
 *
 * Rungs, best first:
 *   1. the model emitted usable alpha — nothing to do (the prompt asks for it);
 *   2. flat-key the uniform backdrop we requested as its fallback;
 *   3. ML segmentation (imgly);
 *   4. flat-key output that removed the backdrop but failed QA — accepted with a
 *      warning, because a garment with a small artifact beats no replacement.
 *
 * `cutoutQa` is the judge at every rung, so "did the model give us real
 * transparency?" needs no separate detector: an opaque image fails its
 * corner/border checks by definition.
 */
import { keyFlatBackground } from "./flat-key";
import { removeBackground } from "./background-removal";
import { cutoutQa } from "./cutout-qa";

export interface Cutout {
  png: Buffer;
  /** Which rung produced it — logged per item so we learn what actually works. */
  how: string;
  /** false = background removed but QA found an artifact worth mentioning. */
  clean: boolean;
}

/**
 * A generated shot is framed by our own prompt: "an even margin of empty space
 * on all four sides". So unlike a bbox crop, it can never legitimately fill most
 * of the frame, and anything that does is surviving backdrop.
 *
 * Measured over the wardrobe on 2026-07-26: healthy cutouts keep 23-45% of the
 * frame. 8d05cc43 came back on a non-flat grey backdrop and kept 73% — a slab
 * of backdrop floating above the cap — and sailed through QA on the old 92%
 * bound, because the slab touched no border and no corner. 60% clears every
 * healthy item by 15 points and catches that one.
 */
const GENERATED_MAX_OPAQUE = 0.6;

export async function cutoutFromGenerated(png: Buffer): Promise<Cutout | null> {
  const qaOpts = { maxOpaque: GENERATED_MAX_OPAQUE };
  const native = await cutoutQa(png, qaOpts);
  if (native.ok) return { png, how: "native transparency", clean: true };

  const flat = await keyFlatBackground(png);
  if (flat) {
    const qa = await cutoutQa(flat.png, qaOpts);
    if (qa.ok) {
      return {
        png: flat.png,
        how: `flat-key (kept ${(flat.keptFraction * 100).toFixed(0)}%)`,
        clean: true,
      };
    }
  }

  const seg = await removeBackground(png);
  if (seg) {
    const qa = await cutoutQa(seg.png, qaOpts);
    if (qa.ok) return { png: seg.png, how: "segmentation", clean: true };
  }

  if (flat) {
    const qa = await cutoutQa(flat.png, qaOpts);
    return { png: flat.png, how: `flat-key, QA warning: ${qa.reason}`, clean: false };
  }
  return null;
}
