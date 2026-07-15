import path from "node:path";
import { and, eq, inArray, lt } from "drizzle-orm";
import { getDb, schema } from "@/server/db/client";
import { newId, nowIso } from "@/server/lib/ids";
import { parseJson, toJson } from "@/server/lib/json";
import { notFound } from "@/server/lib/errors";
import { createLimiter } from "@/server/lib/limiter";
import { logActivity } from "@/server/services/activity";
import { createDraftItem, applyInferenceToItem, getItem } from "@/server/services/catalog";
import { itemImageDir, relativeImagePath, saveBuffer, sha256Of } from "@/server/imaging/storage";
import { normalizeUpload, makeThumbnail, cropToBox } from "@/server/imaging/thumbnails";
import { dominantColors, type DominantColor } from "@/server/imaging/dominant-colors";
import { removeBackground } from "@/server/imaging/background-removal";
import { cutoutQa } from "@/server/imaging/cutout-qa";
import { extractItemMetadata } from "@/server/ai/extraction";
import type { BBox, ImageRole, ImportJob, ImportStage, StageInfo } from "@/shared/types";

/**
 * Import pipeline: front(+back) photo → draft item ready for review.
 *
 * Stages: save → background_removal → thumbnail → colors → ai_metadata.
 * Progress is persisted per stage in import_jobs, so the UI can poll and a
 * killed dev server leaves an inspectable (retryable) record, not a mystery.
 *
 * Failure policy: only the `save` stage is fatal. Everything downstream
 * degrades gracefully — a failed cutout keeps originals, failed AI leaves a
 * blank form — and the failure reason is stored, never swallowed.
 */

type Stages = Record<ImportStage, StageInfo>;

const initialStages = (): Stages => ({
  save: { status: "pending" },
  background_removal: { status: "pending" },
  thumbnail: { status: "pending" },
  colors: { status: "pending" },
  ai_metadata: { status: "pending" },
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

function addImageRow(itemId: string, role: ImageRole, absPath: string, buffer: Buffer, width?: number, height?: number): void {
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
      createdAt: nowIso(),
    })
    .run();
}

/** Point the item's thumbnail row at freshly-written bytes (path may change .jpg↔.png). */
function updateThumbnailRow(itemId: string, absPath: string, buffer: Buffer, width: number, height: number): void {
  getDb()
    .update(schema.itemImages)
    .set({ path: relativeImagePath(absPath), width, height, sha256: sha256Of(buffer) })
    .where(and(eq(schema.itemImages.itemId, itemId), eq(schema.itemImages.role, "thumbnail")))
    .run();
}

export interface StartImportInput {
  front: Buffer;
  back?: Buffer | null;
}

/**
 * Bounded import queue. Uploads enqueue instantly (status "queued") and a
 * fixed number of pipelines run concurrently — a burst of uploads lines up
 * instead of stampeding the machine with parallel ONNX/Agent-SDK work.
 * In-process only: a restart loses the waiting queue, which is why
 * recoverOrphanedJobs() runs at boot.
 */
const IMPORT_CONCURRENCY = (() => {
  const n = Number(process.env.PSOS_IMPORT_CONCURRENCY ?? 2);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 2;
})();
const runLimited = createLimiter(IMPORT_CONCURRENCY);

export function startImport(input: StartImportInput): ImportJob {
  ensureOrphanRecovery();
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

  // Fire and forget behind the limiter; progress lives in the DB.
  void runLimited(async () => {
    updateJob(jobId, { status: "running" });
    await runPipeline(jobId, item.id, input);
  }).catch((err) => {
    console.error("[psos] import pipeline crashed:", err);
    updateJob(jobId, { status: "failed", error: err instanceof Error ? err.message : String(err) });
  });

  return getImportJob(jobId);
}

/**
 * Crash recovery: a job still "queued"/"running" whose row hasn't been
 * touched in a while was interrupted by a crash or restart (the in-process
 * queue survives neither). Mark it failed with an honest reason — originals
 * (if the save stage finished) are on disk, so the item can be re-imported.
 *
 * Runs lazily on first import-API use per process rather than in a Next.js
 * instrumentation hook: instrumentation's separate bundling pass drags
 * imgly's native binary into the bundle and 500s the whole route graph
 * (observed 2026-07-15). The staleness cutoff (not process start time)
 * guards active jobs: a live pipeline updates its row every stage
 * transition, far more often than the cutoff.
 */
const ORPHAN_STALE_MS = 3 * 60 * 1000;
let orphanRecoveryDone = false;

function ensureOrphanRecovery(): void {
  if (orphanRecoveryDone) return;
  orphanRecoveryDone = true;
  try {
    recoverOrphanedJobs();
  } catch (err) {
    console.error("[psos] orphaned-job recovery failed:", err);
  }
}

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

async function runPipeline(jobId: string, itemId: string, input: StartImportInput): Promise<void> {
  const stages = initialStages();
  const mark = (stage: ImportStage, info: StageInfo) => {
    stages[stage] = info;
    updateJob(jobId, { stages });
  };
  const fail = (stage: ImportStage, err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    mark(stage, { status: "failed", error: msg });
    console.error(`[psos] import stage ${stage} failed:`, msg);
  };

  const dir = itemImageDir(itemId);

  // 1. save originals (fatal on failure)
  mark("save", { status: "running" });
  let frontPath: string;
  let backPath: string | null = null;
  let frontBuf: Buffer;
  let backBuf: Buffer | null = null;
  try {
    const front = await normalizeUpload(input.front);
    frontBuf = front.buffer;
    frontPath = path.join(dir, "front.jpg");
    await saveBuffer(frontPath, front.buffer);
    addImageRow(itemId, "front", frontPath, front.buffer, front.width, front.height);

    if (input.back && input.back.length > 0) {
      const back = await normalizeUpload(input.back);
      backBuf = back.buffer;
      backPath = path.join(dir, "back.jpg");
      await saveBuffer(backPath, back.buffer);
      addImageRow(itemId, "back", backPath, back.buffer, back.width, back.height);
    }
    mark("save", { status: "done" });
  } catch (err) {
    fail("save", err);
    updateJob(jobId, { status: "failed", error: "Could not save the uploaded photos" });
    return;
  }

  // 2. provisional full-frame thumbnail — replaced by the garment crop/cutout
  // after the AI locates the garment. The grid shows something meanwhile.
  mark("thumbnail", { status: "running" });
  try {
    const thumb = await makeThumbnail(frontBuf);
    const thumbPath = path.join(dir, "thumbnail.jpg");
    await saveBuffer(thumbPath, thumb.buffer);
    addImageRow(itemId, "thumbnail", thumbPath, thumb.buffer, thumb.width, thumb.height);
    mark("thumbnail", { status: "done" });
  } catch (err) {
    fail("thumbnail", err);
  }

  // 3. deterministic color extraction
  mark("colors", { status: "running" });
  let dominant: DominantColor[] = [];
  try {
    dominant = await dominantColors(frontBuf);
    mark("colors", { status: "done" });
  } catch (err) {
    fail("colors", err);
  }

  // 4. AI metadata + garment boxes (writes only AI-owned fields via provenance)
  mark("ai_metadata", { status: "running" });
  let boxFront: BBox | null = null;
  let boxBack: BBox | null = null;
  try {
    const inference = await extractItemMetadata({
      imagePaths: [frontPath, ...(backPath ? [backPath] : [])],
      dominant,
    });
    applyInferenceToItem(itemId, inference);
    boxFront = inference.bbox ?? null;
    boxBack = inference.bboxBack ?? null;
    mark("ai_metadata", { status: "done" });
  } catch (err) {
    fail("ai_metadata", err);
  }

  // 5. tight garment crops for the item page (raw photos stay on disk only)
  let cropFront: Buffer | null = null;
  try {
    if (boxFront) cropFront = await cropToBox(frontBuf, boxFront);
    if (cropFront) {
      const p = path.join(dir, "front_cropped.jpg");
      await saveBuffer(p, cropFront);
      addImageRow(itemId, "front_cropped", p, cropFront);
    }
    if (backBuf && boxBack) {
      const cropBack = await cropToBox(backBuf, boxBack);
      if (cropBack) {
        const p = path.join(dir, "back_cropped.jpg");
        await saveBuffer(p, cropBack);
        addImageRow(itemId, "back_cropped", p, cropBack);
      }
    }
  } catch (err) {
    console.error("[psos] garment crop failed (item page falls back to originals):", err);
  }

  // 6. background removal on the CROP (imgly output is only good pre-cropped),
  // gated by cutoutQa — a smeared matte keeps the crop instead. The catalog
  // thumbnail becomes cutout > crop > full frame, best available.
  mark("background_removal", { status: "running" });
  let bestThumbSource: Buffer | null = cropFront;
  let thumbHasAlpha = false;
  try {
    const result = cropFront ? await removeBackground(cropFront) : null;
    if (result) {
      const qa = await cutoutQa(result.png);
      if (qa.ok) {
        const cutoutPath = path.join(dir, "transparent_front.png");
        await saveBuffer(cutoutPath, result.png);
        addImageRow(itemId, "transparent_front", cutoutPath, result.png);
        bestThumbSource = result.png;
        thumbHasAlpha = true;
        mark("background_removal", { status: "done" });
      } else {
        mark("background_removal", {
          status: "failed",
          error: `Cutout rejected by quality check (${qa.reason}) — kept the crop`,
        });
      }
    } else {
      mark("background_removal", {
        status: "failed",
        error: cropFront
          ? "Background removal unavailable — kept the cropped photo"
          : "No garment crop available — kept the original photo",
      });
    }
  } catch (err) {
    fail("background_removal", err);
  }

  // 7. final thumbnail from the best source available (alpha PNG for cutouts,
  // so the grid tile has no baked background)
  if (bestThumbSource) {
    try {
      const thumb = await makeThumbnail(bestThumbSource, { alpha: thumbHasAlpha });
      const thumbPath = path.join(dir, thumbHasAlpha ? "thumbnail.png" : "thumbnail.jpg");
      await saveBuffer(thumbPath, thumb.buffer);
      updateThumbnailRow(itemId, thumbPath, thumb.buffer, thumb.width, thumb.height);
    } catch (err) {
      console.error("[psos] final thumbnail failed (kept provisional):", err);
    }
  }

  updateJob(jobId, { status: "ready_for_review", error: null });
  logActivity("system", "import.ready_for_review", { type: "import_job", id: jobId });
}

// ---------------------------------------------------------------------------

function mapJob(row: typeof schema.importJobs.$inferSelect, withItem = true): ImportJob {
  return {
    id: row.id,
    itemId: row.itemId,
    status: row.status,
    stages: parseJson<Stages>(row.stages, initialStages()),
    error: row.error,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ...(withItem ? { item: getItem(row.itemId) } : {}),
  };
}

export function getImportJob(id: string): ImportJob {
  ensureOrphanRecovery();
  const row = getDb().select().from(schema.importJobs).where(eq(schema.importJobs.id, id)).get();
  if (!row) throw notFound("Import job", id);
  return mapJob(row);
}

/** Jobs whose item is still a draft (pending review or in flight). */
export function listOpenImportJobs(): ImportJob[] {
  ensureOrphanRecovery();
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
