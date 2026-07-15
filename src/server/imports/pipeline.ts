import path from "node:path";
import { eq, inArray } from "drizzle-orm";
import { getDb, schema } from "@/server/db/client";
import { newId, nowIso } from "@/server/lib/ids";
import { parseJson, toJson } from "@/server/lib/json";
import { notFound } from "@/server/lib/errors";
import { logActivity } from "@/server/services/activity";
import { createDraftItem, applyInferenceToItem, getItem } from "@/server/services/catalog";
import { itemImageDir, relativeImagePath, saveBuffer, sha256Of } from "@/server/imaging/storage";
import { normalizeUpload, makeThumbnail } from "@/server/imaging/thumbnails";
import { dominantColors, type DominantColor } from "@/server/imaging/dominant-colors";
import { removeBackground } from "@/server/imaging/background-removal";
import { extractItemMetadata } from "@/server/ai/extraction";
import type { ImageRole, ImportJob, ImportStage, StageInfo } from "@/shared/types";

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
  patch: Partial<{ stages: Stages; status: "running" | "ready_for_review" | "failed"; error: string | null }>,
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

export interface StartImportInput {
  front: Buffer;
  back?: Buffer | null;
}

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
      status: "running",
      createdAt: ts,
      updatedAt: ts,
    })
    .run();
  logActivity("system", "import.started", { type: "import_job", id: jobId });

  // Fire and forget; progress lives in the DB.
  void runPipeline(jobId, item.id, input).catch((err) => {
    console.error("[psos] import pipeline crashed:", err);
    updateJob(jobId, { status: "failed", error: err instanceof Error ? err.message : String(err) });
  });

  return getImportJob(jobId);
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
  try {
    const front = await normalizeUpload(input.front);
    frontBuf = front.buffer;
    frontPath = path.join(dir, "front.jpg");
    await saveBuffer(frontPath, front.buffer);
    addImageRow(itemId, "front", frontPath, front.buffer, front.width, front.height);

    if (input.back && input.back.length > 0) {
      const back = await normalizeUpload(input.back);
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

  // 2. background removal (optional)
  mark("background_removal", { status: "running" });
  let cutout: Buffer | null = null;
  try {
    const result = await removeBackground(frontBuf);
    if (result) {
      cutout = result.png;
      const cutoutPath = path.join(dir, "transparent_front.png");
      await saveBuffer(cutoutPath, cutout);
      addImageRow(itemId, "transparent_front", cutoutPath, cutout);
      mark("background_removal", { status: "done" });
    } else {
      mark("background_removal", {
        status: "failed",
        error: "Background removal unavailable — kept the original photo",
      });
    }
  } catch (err) {
    fail("background_removal", err);
  }

  // 3. thumbnail (from cutout when available)
  mark("thumbnail", { status: "running" });
  try {
    const thumb = await makeThumbnail(cutout ?? frontBuf);
    const thumbPath = path.join(dir, "thumbnail.jpg");
    await saveBuffer(thumbPath, thumb.buffer);
    addImageRow(itemId, "thumbnail", thumbPath, thumb.buffer, thumb.width, thumb.height);
    mark("thumbnail", { status: "done" });
  } catch (err) {
    fail("thumbnail", err);
  }

  // 4. deterministic color extraction
  mark("colors", { status: "running" });
  let dominant: DominantColor[] = [];
  try {
    dominant = await dominantColors(cutout ?? frontBuf);
    mark("colors", { status: "done" });
  } catch (err) {
    fail("colors", err);
  }

  // 5. AI metadata (writes only AI-owned fields via provenance)
  mark("ai_metadata", { status: "running" });
  try {
    const inference = await extractItemMetadata({
      imagePaths: [frontPath, ...(backPath ? [backPath] : [])],
      dominant,
    });
    applyInferenceToItem(itemId, inference);
    mark("ai_metadata", { status: "done" });
  } catch (err) {
    fail("ai_metadata", err);
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
