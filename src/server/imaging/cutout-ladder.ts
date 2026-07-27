/**
 * Turn a generated product shot into a transparent cutout.
 *
 * Shared by the import pipeline and `server/imaging/regenerate.ts` — they used to
 * hold separate copies, which is exactly how two code paths drift into disagreeing
 * about what a good cutout is.
 *
 * Rungs, best first:
 *   1. the model emitted usable alpha — nothing to do (the prompt asks for it);
 *   2. flat-key the uniform backdrop we requested as its fallback;
 *   3. regenerate ONCE against a contrasting backdrop and key that (optional —
 *      the caller supplies the closure, so this module never imports `ai/`);
 *   4. the rung-2 output that failed QA — accepted with a warning, because a
 *      garment with a small artifact beats no replacement.
 *
 * `cutoutQa` is the judge at every rung, so "did the model give us real
 * transparency?" needs no separate detector: an opaque image fails its
 * corner/border checks by definition.
 *
 * Rung 3 replaced ML segmentation (imgly) on 2026-07-27. Segmentation cost
 * 574 MB of native dependencies and a child process to survive a libvips/ONNX
 * conflict, to rescue a case that only arises when the backdrop we asked for is
 * too close to the garment's own colour. Asking for a backdrop the garment
 * cannot match fixes the cause instead of matting around it — and it is the
 * on-demand form of the chroma-key backdrop we would otherwise have had to
 * apply catalog-wide.
 */
import { keyFlatBackground } from "./flat-key";
import { cutoutQa, type CutoutQaResult } from "./cutout-qa";

export interface Cutout {
  png: Buffer;
  /** Which rung produced it — logged per item so we learn what actually works. */
  how: string;
  /** false = background removed but QA found an artifact worth mentioning. */
  clean: boolean;
}

/**
 * Regenerate the same garment against a contrasting backdrop, or null when
 * regeneration is unavailable or the model declines. Supplied by the caller —
 * `imaging/` does not depend on `ai/`.
 */
export type ContrastRetry = () => Promise<Buffer | null>;

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

const qaOpts = { maxOpaque: GENERATED_MAX_OPAQUE };

/** Key a shot and judge the result. Returns the QA verdict alongside the bytes. */
async function keyAndJudge(
  png: Buffer,
): Promise<{ png: Buffer; keptFraction: number; qa: CutoutQaResult } | null> {
  const flat = await keyFlatBackground(png);
  if (!flat) return null;
  return { png: flat.png, keptFraction: flat.keptFraction, qa: await cutoutQa(flat.png, qaOpts) };
}

export async function cutoutFromGenerated(
  png: Buffer,
  retry?: ContrastRetry,
): Promise<Cutout | null> {
  const native = await cutoutQa(png, qaOpts);
  if (native.ok) return { png, how: "native transparency", clean: true };

  const flat = await keyAndJudge(png);
  if (flat?.qa.ok) {
    return {
      png: flat.png,
      how: `flat-key (kept ${(flat.keptFraction * 100).toFixed(0)}%)`,
      clean: true,
    };
  }

  // Rung 3. The grey backdrop could not be separated from this garment — most
  // likely the garment is itself near-white. Ask for magenta and key that.
  let retryFlat: Awaited<ReturnType<typeof keyAndJudge>> = null;
  if (retry) {
    const contrasted = await retry();
    if (contrasted) {
      const retryNative = await cutoutQa(contrasted, qaOpts);
      if (retryNative.ok) {
        return { png: contrasted, how: "contrast retry (native transparency)", clean: true };
      }
      retryFlat = await keyAndJudge(contrasted);
      if (retryFlat?.qa.ok) {
        return {
          png: retryFlat.png,
          how: `contrast retry, flat-key (kept ${(retryFlat.keptFraction * 100).toFixed(0)}%)`,
          clean: true,
        };
      }
    }
  }

  // Rung 4. Prefer the ORIGINAL generation's keyed output: it is the garment we
  // already accepted everywhere else. Fall to the retry's only when the original
  // keyed to nothing at all, so a retry can add ground but never lose it.
  const fallback = flat ?? retryFlat;
  if (fallback) {
    return {
      png: fallback.png,
      how: `flat-key, QA warning: ${fallback.qa.reason}`,
      clean: false,
    };
  }
  return null;
}
