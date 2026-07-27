import path from "node:path";
import fs from "node:fs";
import { and, eq, inArray, lt } from "drizzle-orm";
import { getDb, schema, dataDir } from "@/server/db/client";
import { newId, nowIso } from "@/server/lib/ids";
import { parseJson, toJson } from "@/server/lib/json";
import { badRequest, notFound } from "@/server/lib/errors";
import { createLimiter } from "@/server/lib/limiter";
import { workStarted, workFinished } from "@/server/lib/work-hold";
import { logActivity } from "@/server/services/activity";
import { createDraftItem, applyInferenceToItem, getItem } from "@/server/services/catalog";
import { itemImageDir, relativeImagePath, resolveImagePath, saveBuffer, sha256Of } from "@/server/imaging/storage";
import { normalizeUpload, makeThumbnail, cropToBox } from "@/server/imaging/thumbnails";
import { dominantColors, type DominantColor } from "@/server/imaging/dominant-colors";
import { cutoutFromGenerated, type Cutout } from "@/server/imaging/cutout-ladder";
import { contrastRetry } from "@/server/imaging/regenerate";
import { dhash } from "@/server/imaging/phash";
import { extractItemMetadata, extractBoundingBox } from "@/server/ai/extraction";
import { generateProductShot } from "@/server/ai/image-generation";
import { hasVertexKey } from "@/server/ai/vertex-client";
import type { BBox, ImageRole, ImportJob, ImportStage, StageInfo } from "@/shared/types";

/**
 * Import pipeline: front(+back) photo → draft item ready for review.
 *
 * Stages, in order:
 *   save            originals + a provisional tile so the grid isn't empty
 *   garment_box     locate the garment in each photo, write the tight crops
 *   image_generation redraw each side as a clean studio product shot (Gemini)
 *   background_removal transparent cutouts (ladder in cutout-ladder.ts)
 *   colors          dominant colours, read off the CUTOUT so they're garment-only
 *   ai_metadata     fields + tags, from the PHOTOS and the studio shots together
 *   thumbnail       final catalog tile from the best image we ended up with
 *
 * The order is load-bearing and not the obvious one. Colours come after the
 * cutout because `dominantColors` ignores transparent pixels, so it reports the
 * garment rather than half a bedsheet. Metadata comes last so it can see the
 * studio shots — but it is sent the ORIGINAL photographs too, ranked above them,
 * so a redraw's drift cannot become a recorded fact (ai/extraction.ts).
 *
 * Progress is persisted per stage in import_jobs, so the UI can poll and a
 * killed dev server leaves an inspectable (retryable) record, not a mystery.
 *
 * Failure policy: only the `save` stage is fatal. Everything downstream
 * degrades gracefully — every later stage falls back to the best artifact its
 * predecessors managed to produce — and the reason is stored, never swallowed.
 */

type Stages = Record<ImportStage, StageInfo>;

const initialStages = (): Stages => ({
  save: { status: "pending" },
  garment_box: { status: "pending" },
  image_generation: { status: "pending" },
  background_removal: { status: "pending" },
  colors: { status: "pending" },
  ai_metadata: { status: "pending" },
  thumbnail: { status: "pending" },
});

function updateJob(
  jobId: string,
  patch: Partial<{
    stages: Stages;
    status: "queued" | "running" | "ready_for_review" | "failed";
    error: string | null;
  }>,
): void {
  getDb()
    .update(schema.importJobs)
    .set({
      ...(patch.stages ? { stages: toJson(patch.stages) } : {}),
      ...(patch.status ? { status: patch.status } : {}),
      ...(patch.error !== undefined ? { error: patch.error } : {}),
      updatedAt: nowIso(),
    })
    .where(eq(schema.importJobs.id, jobId))
    .run();
}

function addImageRow(
  itemId: string,
  role: ImageRole,
  absPath: string,
  buffer: Buffer,
  width?: number,
  height?: number,
  phash?: string,
): void {
  getDb()
    .insert(schema.itemImages)
    .values({
      id: newId(),
      itemId,
      role,
      path: relativeImagePath(absPath),
      width: width ?? null,
      height: height ?? null,
      sha256: sha256Of(buffer),
      phash: phash ?? null,
      createdAt: nowIso(),
    })
    .run();
}

/**
 * Point a catalog tile row (front or back) at freshly-written bytes (path may
 * change .jpg↔.png). `thumbnail` always exists by the time this runs — `save`
 * writes a provisional one — but `thumbnail_back` does not exist until the
 * first back-side generation succeeds, so this upserts rather than assuming
 * an UPDATE will hit a row.
 */
function upsertThumbnailRow(
  itemId: string,
  role: "thumbnail" | "thumbnail_back",
  absPath: string,
  buffer: Buffer,
  width: number,
  height: number,
): void {
  const existing = getDb()
    .select()
    .from(schema.itemImages)
    .where(and(eq(schema.itemImages.itemId, itemId), eq(schema.itemImages.role, role)))
    .get();
  if (existing) {
    getDb()
      .update(schema.itemImages)
      .set({ path: relativeImagePath(absPath), width, height, sha256: sha256Of(buffer) })
      .where(eq(schema.itemImages.id, existing.id))
      .run();
    return;
  }
  addImageRow(itemId, role, absPath, buffer, width, height);
}

export interface StartImportInput {
  front: Buffer;
  back?: Buffer | null;
}

/**
 * Bounded import queue. Uploads enqueue instantly (status "queued") and a
 * fixed number of pipelines run concurrently — a burst of uploads lines up
 * instead of stampeding the machine with parallel image-model work.
 * In-process only: a restart loses the waiting queue, which is why
 * recoverOrphanedJobs() runs at boot (scripts/boot.ts).
 */
const IMPORT_CONCURRENCY = (() => {
  const n = Number(process.env.PSOS_IMPORT_CONCURRENCY ?? 2);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 2;
})();
const runLimited = createLimiter(IMPORT_CONCURRENCY);

export function startImport(input: StartImportInput): ImportJob {
  const item = createDraftItem();
  const jobId = newId();
  const ts = nowIso();
  getDb()
    .insert(schema.importJobs)
    .values({
      id: jobId,
      itemId: item.id,
      stages: toJson(initialStages()),
      status: "queued",
      createdAt: ts,
      updatedAt: ts,
    })
    .run();
  logActivity("system", "import.queued", { type: "import_job", id: jobId });
  enqueue(jobId, item.id, input);
  return getImportJob(jobId);
}

/** Fire and forget behind the limiter; progress lives in the DB. */
function enqueue(jobId: string, itemId: string, input: StartImportInput): void {
  workStarted();
  void runLimited(async () => {
    updateJob(jobId, { status: "running" });
    await runPipeline(jobId, itemId, input);
  })
    .catch((err) => {
      console.error("[psos] import pipeline crashed:", err);
      updateJob(jobId, { status: "failed", error: err instanceof Error ? err.message : String(err) });
    })
    .finally(workFinished);
}

/**
 * Retry a failed import from the originals already on disk. The pipeline
 * regenerates every derived image and re-applies AI inference (provenance
 * still protects any fields the user edited meanwhile). Existing image rows
 * are cleared first so stages re-create them instead of duplicating.
 */
export function retryImport(jobId: string): ImportJob {
  const job = getImportJob(jobId);
  if (job.status !== "failed") {
    throw badRequest(`Only failed imports can be retried (this one is ${job.status})`);
  }
  const db = getDb();
  const images = db
    .select()
    .from(schema.itemImages)
    .where(eq(schema.itemImages.itemId, job.itemId))
    .all();
  const byRole = (role: string) => images.find((i) => i.role === role);
  const front = byRole("front");
  if (!front) {
    throw badRequest("No saved front photo — the original upload never landed; import it again instead.");
  }
  const frontAbs = resolveImagePath(front.path);
  if (!fs.existsSync(frontAbs)) {
    throw badRequest("Saved front photo is missing from disk — import it again instead.");
  }
  const back = byRole("back");
  const backAbs = back ? resolveImagePath(back.path) : null;

  const input: StartImportInput = {
    front: fs.readFileSync(frontAbs),
    back: backAbs && fs.existsSync(backAbs) ? fs.readFileSync(backAbs) : null,
  };

  // Clear derived rows; the pipeline re-inserts everything (originals included,
  // from the same bytes just read back).
  db.delete(schema.itemImages).where(eq(schema.itemImages.itemId, job.itemId)).run();
  updateJob(jobId, { stages: initialStages(), status: "queued", error: null });
  logActivity("user", "import.retried", { type: "import_job", id: jobId });
  enqueue(jobId, job.itemId, input);
  return getImportJob(jobId);
}

/**
 * Crash recovery: a job still "queued"/"running" whose row hasn't been
 * touched in a while was interrupted by a crash or restart (the in-process
 * queue survives neither). Mark it failed with an honest reason — originals
 * (if the save stage finished) are on disk, so the item can be re-imported.
 *
 * Called from `scripts/boot.ts`, which runs as npm's prestart/predev hook —
 * a separate process, before the server accepts anything, so everything it
 * finds is genuinely the previous process's wreckage. The staleness cutoff
 * stays as a second guard for anyone who runs the script by hand while a
 * server is up: a live pipeline updates its row on every stage transition,
 * far more often than the cutoff.
 */
const ORPHAN_STALE_MS = 3 * 60 * 1000;

export function recoverOrphanedJobs(): number {
  const db = getDb();
  const cutoff = new Date(Date.now() - ORPHAN_STALE_MS).toISOString();
  const orphans = db
    .select()
    .from(schema.importJobs)
    .where(
      and(
        inArray(schema.importJobs.status, ["queued", "running"]),
        lt(schema.importJobs.updatedAt, cutoff),
      ),
    )
    .all();

  for (const job of orphans) {
    const stages = parseJson<Stages>(job.stages, initialStages());
    for (const info of Object.values(stages)) {
      if (info.status === "running") {
        info.status = "failed";
        info.error = "Interrupted by a server restart";
      }
    }
    updateJob(job.id, {
      stages,
      status: "failed",
      error: "Interrupted by a server restart — saved photos are intact; re-import to retry.",
    });
    logActivity("system", "import.orphan_recovered", { type: "import_job", id: job.id });
  }
  if (orphans.length > 0) {
    console.warn(`[psos] marked ${orphans.length} interrupted import job(s) as failed`);
  }
  return orphans.length;
}

// ---------------------------------------------------------------------------
// Stages
//
// One context object carries everything the stages read and write, so the ORDER
// of the calls in runPipeline() is the only sequencing logic there is. Each stage
// owns one artifact, reports its own status, and swallows its own errors — only
// `save` is fatal.

interface Ctx {
  itemId: string;
  dir: string;
  front: Buffer;
  back: Buffer | null;
  frontPath: string;
  backPath: string | null;
  boxFront: BBox | null;
  boxBack: BBox | null;
  cropFront: Buffer | null;
  cropBack: Buffer | null;
  cropFrontPath: string | null;
  cropBackPath: string | null;
  genFront: Buffer | null;
  genBack: Buffer | null;
  genFrontPath: string | null;
  genBackPath: string | null;
  cutoutFront: Cutout | null;
  cutoutBack: Cutout | null;
  dominant: DominantColor[];
}

interface Report {
  mark: (stage: ImportStage, info: StageInfo) => void;
  fail: (stage: ImportStage, err: unknown) => void;
}

/**
 * The cleanest front image available, best first. Everything downstream
 * (colours, thumbnail) reads through this, so "best" is defined once.
 */
function bestFront(ctx: Ctx): { buffer: Buffer; alpha: boolean } {
  if (ctx.cutoutFront) return { buffer: ctx.cutoutFront.png, alpha: true };
  if (ctx.genFront) return { buffer: ctx.genFront, alpha: false };
  if (ctx.cropFront) return { buffer: ctx.cropFront, alpha: false };
  return { buffer: ctx.front, alpha: false };
}

/**
 * Same idea for the back, except a back photo is optional — the item may have
 * been imported front-only, in which case there is nothing to make a tile
 * from and the wardrobe grid simply does not rotate for this item.
 */
function bestBack(ctx: Ctx): { buffer: Buffer; alpha: boolean } | null {
  if (ctx.cutoutBack) return { buffer: ctx.cutoutBack.png, alpha: true };
  if (ctx.genBack) return { buffer: ctx.genBack, alpha: false };
  if (ctx.cropBack) return { buffer: ctx.cropBack, alpha: false };
  if (ctx.back) return { buffer: ctx.back, alpha: false };
  return null;
}

/**
 * Save the originals and put a provisional tile on the grid immediately. The
 * only fatal stage: without the originals there is nothing to work from.
 */
async function stageSave(
  ctx: Ctx,
  input: StartImportInput,
  report: Report,
): Promise<boolean> {
  report.mark("save", { status: "running" });
  try {
    const front = await normalizeUpload(input.front);
    ctx.front = front.buffer;
    ctx.frontPath = path.join(ctx.dir, "front.jpg");
    await saveBuffer(ctx.frontPath, front.buffer);
    addImageRow(
      ctx.itemId,
      "front",
      ctx.frontPath,
      front.buffer,
      front.width,
      front.height,
      await dhash(front.buffer),
    );

    if (input.back && input.back.length > 0) {
      const back = await normalizeUpload(input.back);
      ctx.back = back.buffer;
      ctx.backPath = path.join(ctx.dir, "back.jpg");
      await saveBuffer(ctx.backPath, back.buffer);
      addImageRow(ctx.itemId, "back", ctx.backPath, back.buffer, back.width, back.height);
    }

    // Provisional full-frame tile so the grid shows something while the rest
    // runs; the thumbnail stage replaces these bytes at the end.
    const thumb = await makeThumbnail(front.buffer);
    const thumbPath = path.join(ctx.dir, "thumbnail.jpg");
    await saveBuffer(thumbPath, thumb.buffer);
    addImageRow(ctx.itemId, "thumbnail", thumbPath, thumb.buffer, thumb.width, thumb.height);

    report.mark("save", { status: "done" });
    return true;
  } catch (err) {
    report.fail("save", err);
    return false;
  }
}

/** Locate the garment in each original and write the tight crops. */
async function stageGarmentBox(ctx: Ctx, report: Report): Promise<void> {
  report.mark("garment_box", { status: "running" });
  try {
    ctx.boxFront = await extractBoundingBox(ctx.frontPath);
    if (ctx.backPath) ctx.boxBack = await extractBoundingBox(ctx.backPath);

    if (ctx.boxFront) {
      ctx.cropFront = await cropToBox(ctx.front, ctx.boxFront);
      if (ctx.cropFront) {
        ctx.cropFrontPath = path.join(ctx.dir, "front_cropped.jpg");
        await saveBuffer(ctx.cropFrontPath, ctx.cropFront);
        addImageRow(ctx.itemId, "front_cropped", ctx.cropFrontPath, ctx.cropFront);
      }
    }
    if (ctx.back && ctx.boxBack) {
      ctx.cropBack = await cropToBox(ctx.back, ctx.boxBack);
      if (ctx.cropBack) {
        ctx.cropBackPath = path.join(ctx.dir, "back_cropped.jpg");
        await saveBuffer(ctx.cropBackPath, ctx.cropBack);
        addImageRow(ctx.itemId, "back_cropped", ctx.cropBackPath, ctx.cropBack);
      }
    }

    report.mark(
      "garment_box",
      ctx.cropFront
        ? { status: "done" }
        : { status: "failed", error: "Could not locate the garment — later stages use the full photo" },
    );
  } catch (err) {
    report.fail("garment_box", err);
  }
}

/**
 * Redraw each side as a clean studio product shot. This is what makes the
 * catalog look like a catalog: the source photos are crumpled flat-lays on a
 * bedsheet, which no amount of segmentation can rescue.
 */
async function stageImageGeneration(ctx: Ctx, report: Report): Promise<void> {
  if (!hasVertexKey()) {
    report.mark("image_generation", {
      status: "skipped",
      error: "Gemini is not configured here — falling back to segmenting the crop",
    });
    return;
  }
  report.mark("image_generation", { status: "running" });
  try {
    for (const side of ["front", "back"] as const) {
      const source = side === "front" ? (ctx.cropFront ?? ctx.front) : (ctx.cropBack ?? ctx.back);
      if (!source) continue;

      const shot = await generateProductShot(source, "image/jpeg");
      if (!shot) continue;

      // Archive the raw generation for provenance; never served.
      await saveBuffer(
        path.join(dataDir, "generated", ctx.itemId, `${side}-${sha256Of(shot.png).slice(0, 8)}.png`),
        shot.png,
      );
      const p = path.join(ctx.dir, `generated_${side}.png`);
      await saveBuffer(p, shot.png);
      addImageRow(ctx.itemId, `generated_${side}`, p, shot.png);

      if (side === "front") {
        ctx.genFront = shot.png;
        ctx.genFrontPath = p;
      } else {
        ctx.genBack = shot.png;
        ctx.genBackPath = p;
      }
    }

    report.mark(
      "image_generation",
      ctx.genFront
        ? { status: "done" }
        : { status: "failed", error: "No studio shot produced — kept the cropped photo" },
    );
  } catch (err) {
    report.fail("image_generation", err);
  }
}

/**
 * Transparent cutouts from the studio shots, via the shared ladder.
 *
 * No generated shot means no cutout. ML segmentation of the raw crop used to
 * fill that gap and was removed on 2026-07-27: it preserved every crumple and
 * bedsheet shadow that the redraw exists to eliminate, and cost 574 MB of native
 * dependencies plus a child process to survive a libvips/ONNX conflict. The
 * honest degradation is an opaque tile from the best photo we have.
 */
async function stageBackgroundRemoval(ctx: Ctx, report: Report): Promise<void> {
  report.mark("background_removal", { status: "running" });
  try {
    let note: string | null = null;

    for (const side of ["front", "back"] as const) {
      const generated = side === "front" ? ctx.genFront : ctx.genBack;
      if (!generated) continue;

      // The ladder's rung 3 regenerates against a contrasting backdrop, so it
      // needs the same source this side was generated from.
      const source = side === "front" ? (ctx.cropFront ?? ctx.front) : (ctx.cropBack ?? ctx.back);
      const cutout: Cutout | null = await cutoutFromGenerated(
        generated,
        source ? contrastRetry(ctx.itemId, source, "image/jpeg") : undefined,
      );
      if (!cutout) continue;

      const p = path.join(ctx.dir, `transparent_${side}.png`);
      await saveBuffer(p, cutout.png);
      addImageRow(ctx.itemId, `transparent_${side}`, p, cutout.png);
      if (side === "front") {
        ctx.cutoutFront = cutout;
        if (!cutout.clean) note = cutout.how;
      } else {
        ctx.cutoutBack = cutout;
      }
    }

    report.mark(
      "background_removal",
      ctx.cutoutFront
        ? { status: "done", ...(note ? { error: note } : {}) }
        : {
            status: "failed",
            error: note ?? "No transparent cutout — the tile keeps the best opaque image",
          },
    );
  } catch (err) {
    report.fail("background_removal", err);
  }
}

/** Deterministic colour cross-check, read off the garment only. */
async function stageColors(ctx: Ctx, report: Report): Promise<void> {
  report.mark("colors", { status: "running" });
  try {
    // Runs AFTER the cutout on purpose: dominantColors ignores transparent
    // pixels, so a cutout reports garment colours. Reading the raw photo (as
    // this used to) reported half bedsheet, and those colours feed the AI prompt.
    ctx.dominant = await dominantColors(bestFront(ctx).buffer);
    report.mark("colors", { status: "done" });
  } catch (err) {
    report.fail("colors", err);
  }
}

/**
 * AI metadata. Sends the PHOTOGRAPHS (cropped where we have a crop) and the
 * studio shots together, with the prompt ranking the photographs above the
 * renders on anything to do with identity — see `describeImages` in
 * ai/extraction.ts for why that ordering is load-bearing.
 *
 * Writes only AI-owned fields (provenance protects user edits).
 */
async function stageAiMetadata(ctx: Ctx, report: Report): Promise<void> {
  report.mark("ai_metadata", { status: "running" });
  try {
    // Prefer the crops: same photograph, minus the bedsheet and the tripod.
    const back = ctx.cropBackPath ?? ctx.backPath;
    const photoPaths = [ctx.cropFrontPath ?? ctx.frontPath, ...(back ? [back] : [])];
    const inference = await extractItemMetadata({
      photoPaths,
      productShotPaths: [ctx.genFrontPath, ctx.genBackPath].filter((p): p is string => p !== null),
      dominant: ctx.dominant,
    });

    // ai_raw stores the whole inference, and the metadata call does not ask for
    // boxes — so fold in the boxes `garment_box` already found, or backfills
    // lose them and re-pay for another AI call.
    applyInferenceToItem(ctx.itemId, {
      ...inference,
      bbox: ctx.boxFront,
      bboxBack: ctx.boxBack,
    });
    report.mark("ai_metadata", { status: "done" });
  } catch (err) {
    report.fail("ai_metadata", err);
  }
}

/** Final catalog tile from the best image we ended up with. */
async function stageThumbnail(ctx: Ctx, report: Report): Promise<void> {
  report.mark("thumbnail", { status: "running" });
  try {
    const front = bestFront(ctx);
    const thumb = await makeThumbnail(front.buffer, { alpha: front.alpha });
    const p = path.join(ctx.dir, front.alpha ? "thumbnail.png" : "thumbnail.jpg");
    await saveBuffer(p, thumb.buffer);
    upsertThumbnailRow(ctx.itemId, "thumbnail", p, thumb.buffer, thumb.width, thumb.height);

    // Optional: only items with a usable back side get a rotating tile. Same
    // 640px/88%-occupancy treatment as the front, so flipping between them
    // never jumps the garment's size or position.
    const back = bestBack(ctx);
    if (back) {
      const thumbBack = await makeThumbnail(back.buffer, { alpha: back.alpha });
      const pb = path.join(ctx.dir, back.alpha ? "thumbnail_back.png" : "thumbnail_back.jpg");
      await saveBuffer(pb, thumbBack.buffer);
      upsertThumbnailRow(ctx.itemId, "thumbnail_back", pb, thumbBack.buffer, thumbBack.width, thumbBack.height);
    }

    report.mark("thumbnail", { status: "done" });
  } catch (err) {
    report.fail("thumbnail", err);
  }
}

async function runPipeline(jobId: string, itemId: string, input: StartImportInput): Promise<void> {
  const stages = initialStages();
  const report: Report = {
    mark: (stage, info) => {
      stages[stage] = info;
      updateJob(jobId, { stages });
    },
    fail: (stage, err) => {
      const msg = err instanceof Error ? err.message : String(err);
      stages[stage] = { status: "failed", error: msg };
      updateJob(jobId, { stages });
      console.error(`[psos] import stage ${stage} failed:`, msg);
    },
  };

  const ctx: Ctx = {
    itemId,
    dir: itemImageDir(itemId),
    front: Buffer.alloc(0),
    back: null,
    frontPath: "",
    backPath: null,
    boxFront: null,
    boxBack: null,
    cropFront: null,
    cropBack: null,
    cropFrontPath: null,
    cropBackPath: null,
    genFront: null,
    genBack: null,
    genFrontPath: null,
    genBackPath: null,
    cutoutFront: null,
    cutoutBack: null,
    dominant: [],
  };

  if (!(await stageSave(ctx, input, report))) {
    updateJob(jobId, { status: "failed", error: "Could not save the uploaded photos" });
    return;
  }

  await stageGarmentBox(ctx, report);
  await stageImageGeneration(ctx, report);
  await stageBackgroundRemoval(ctx, report);
  await stageColors(ctx, report);
  await stageAiMetadata(ctx, report);
  await stageThumbnail(ctx, report);

  updateJob(jobId, { status: "ready_for_review", error: null });
  logActivity("system", "import.ready_for_review", { type: "import_job", id: jobId });
}

// ---------------------------------------------------------------------------

function mapJob(row: typeof schema.importJobs.$inferSelect, withItem = true): ImportJob {
  return {
    id: row.id,
    itemId: row.itemId,
    status: row.status,
    // Merged with the defaults: jobs created before a stage existed have no
    // entry for it, and the UI would read undefined.
    stages: { ...initialStages(), ...parseJson<Stages>(row.stages, initialStages()) },
    error: row.error,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ...(withItem ? { item: getItem(row.itemId) } : {}),
  };
}

export function getImportJob(id: string): ImportJob {
  const row = getDb().select().from(schema.importJobs).where(eq(schema.importJobs.id, id)).get();
  if (!row) throw notFound("Import job", id);
  return mapJob(row);
}

/** Jobs whose item is still a draft (pending review or in flight). */
export function listOpenImportJobs(): ImportJob[] {
  const db = getDb();
  const drafts = db
    .select({ id: schema.items.id })
    .from(schema.items)
    .where(eq(schema.items.state, "draft"))
    .all()
    .map((r) => r.id);
  if (drafts.length === 0) return [];
  const rows = db
    .select()
    .from(schema.importJobs)
    .where(inArray(schema.importJobs.itemId, drafts))
    .all();
  return rows.map((r) => mapJob(r)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
