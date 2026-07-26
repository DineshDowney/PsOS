/**
 * On-demand regeneration for an already-catalogued item (2026-07-26).
 *
 * Async and job-backed on purpose: "both sides" is 1-2 sequential Gemini calls
 * (the image call limiter in image-generation.ts is process-wide 1-at-a-time),
 * 15-40s worst case. A blocking request that long is an unverified timeout risk
 * over the Tailscale Funnel relay — Dinesh's call, made explicitly, to pay for
 * a job table + poller rather than find out the hard way.
 *
 * Shares its per-side core (generate -> archive -> cutout -> refresh tile) with
 * `scripts/regenerate-images.ts` via `regenerateSide` — the same operation
 * triggered two different ways (batch vs. one item with feedback) had drifted
 * into two copies before this; now there is one.
 *
 * Regeneration always sources from the ORIGINAL crop/photo, never from a
 * previous generation — regenerating a regeneration compounds drift away from
 * the real garment on every retry. The crop is the one fixed anchor to fidelity.
 */
import path from "node:path";
import fs from "node:fs";
import { and, eq, inArray, lt } from "drizzle-orm";
import { getDb, schema, dataDir } from "@/server/db/client";
import { newId, nowIso } from "@/server/lib/ids";
import { parseJson, toJson } from "@/server/lib/json";
import { notFound } from "@/server/lib/errors";
import { createLimiter } from "@/server/lib/limiter";
import { workStarted, workFinished } from "@/server/lib/work-hold";
import { getItem } from "@/server/services/catalog";
import {
  resolveImagePath,
  relativeImagePath,
  saveBuffer,
  sha256Of,
  itemImageDir,
} from "@/server/imaging/storage";
import { makeThumbnail } from "@/server/imaging/thumbnails";
import { cutoutFromGenerated } from "@/server/imaging/cutout-ladder";
import { generateProductShot, type RegenContext } from "@/server/ai/image-generation";
import type { Item, RegenJob, RegenSide, RegenSideResult } from "@/shared/types";

// ---------------------------------------------------------------------------
// Row helpers — the insert-or-update shape thumbnail/generated/transparent
// roles all need, so a regen never leaves two rows fighting over one role.

function findImageRow(itemId: string, role: string) {
  return getDb()
    .select()
    .from(schema.itemImages)
    .where(and(eq(schema.itemImages.itemId, itemId), eq(schema.itemImages.role, role as never)))
    .get();
}

/**
 * `dims` set means "this is a tile role" (thumbnail/thumbnail_back) and gets a
 * known width/height. Omitted means "this is a raw generation or cutout" and
 * width/height stay null — matching the convention every other writer of the
 * generated and transparent roles already follows.
 */
export function upsertImageRow(
  itemId: string,
  role: string,
  absPath: string,
  buffer: Buffer,
  dims?: { width: number; height: number },
): void {
  const values = {
    path: relativeImagePath(absPath),
    sha256: sha256Of(buffer),
    width: dims?.width ?? null,
    height: dims?.height ?? null,
  };
  const existing = findImageRow(itemId, role);
  if (existing) {
    getDb().update(schema.itemImages).set(values).where(eq(schema.itemImages.id, existing.id)).run();
    return;
  }
  getDb()
    .insert(schema.itemImages)
    .values({ id: newId(), itemId, role: role as never, createdAt: nowIso(), ...values })
    .run();
}

// ---------------------------------------------------------------------------
// Source photo + grounding facts

/** Best available ORIGINAL source for a side: the tight crop, else the raw photo. */
export function sourcePhoto(itemId: string, side: RegenSide): { buffer: Buffer; mime: string } | null {
  for (const role of [`${side}_cropped`, side]) {
    const row = findImageRow(itemId, role);
    if (!row) continue;
    const abs = resolveImagePath(row.path);
    if (!fs.existsSync(abs)) continue;
    return { buffer: fs.readFileSync(abs), mime: abs.endsWith(".png") ? "image/png" : "image/jpeg" };
  }
  return null;
}

/**
 * Grounding facts from the item's CURRENT metadata (post user-edits) — "the
 * new regen should take whatever edits have been made" (Dinesh, 2026-07-26).
 * No brand, deliberately: see RegenContext in image-generation.ts for why.
 */
export function itemFacts(item: Item): string[] {
  const facts: string[] = [];
  if (item.category) {
    facts.push(`Category: ${item.category}${item.subcategory ? ` / ${item.subcategory}` : ""}`);
  }
  if (item.primaryColor) {
    facts.push(`Colour: ${item.primaryColor}${item.colorDetail ? ` (${item.colorDetail})` : ""}`);
  }
  if (item.pattern) facts.push(`Pattern: ${item.pattern}`);
  if (item.material) facts.push(`Material: ${item.material}`);
  if (item.fit) facts.push(`Fit: ${item.fit}`);
  return facts;
}

// ---------------------------------------------------------------------------
// The per-side operation, shared with scripts/regenerate-images.ts

/**
 * Generate + cut out + refresh the tile for ONE side. Never throws — a failure
 * (no source, model decline) comes back as `{ ok: false }` and leaves every
 * existing image for this item untouched, matching the precedent already
 * accepted for the batch script.
 */
export async function regenerateSide(
  itemId: string,
  side: RegenSide,
  context?: RegenContext,
): Promise<RegenSideResult> {
  const src = sourcePhoto(itemId, side);
  if (!src) return { ok: false, error: `No ${side} photo on file to regenerate from` };

  const shot = await generateProductShot(src.buffer, src.mime, context);
  if (!shot) return { ok: false, error: "The model declined to generate an image — left untouched" };

  const dir = itemImageDir(itemId);

  // Archived for provenance/history, never served — same layout the pipeline uses.
  await saveBuffer(
    path.join(dataDir, "generated", itemId, `${side}-${sha256Of(shot.png).slice(0, 8)}.png`),
    shot.png,
  );
  const genPath = path.join(dir, `generated_${side}.png`);
  await saveBuffer(genPath, shot.png);
  upsertImageRow(itemId, `generated_${side}`, genPath, shot.png);

  const cutout = await cutoutFromGenerated(shot.png);
  const tileRole = side === "front" ? "thumbnail" : "thumbnail_back";

  if (cutout) {
    const cutPath = path.join(dir, `transparent_${side}.png`);
    await saveBuffer(cutPath, cutout.png);
    upsertImageRow(itemId, `transparent_${side}`, cutPath, cutout.png);

    const thumb = await makeThumbnail(cutout.png, { alpha: true });
    const thumbPath = path.join(dir, `${tileRole}.png`);
    await saveBuffer(thumbPath, thumb.buffer);
    upsertImageRow(itemId, tileRole, thumbPath, thumb.buffer, { width: thumb.width, height: thumb.height });
    return { ok: true, how: cutout.how };
  }

  // No transparency at all: show the studio shot itself rather than keep a
  // stale tile from before this regen.
  const thumb = await makeThumbnail(shot.png);
  const thumbPath = path.join(dir, `${tileRole}.jpg`);
  await saveBuffer(thumbPath, thumb.buffer);
  upsertImageRow(itemId, tileRole, thumbPath, thumb.buffer, { width: thumb.width, height: thumb.height });
  return { ok: true, how: "opaque (no transparency available)" };
}

// ---------------------------------------------------------------------------
// Jobs

function updateJob(jobId: string, patch: Partial<{
  status: RegenJob["status"];
  results: RegenJob["results"];
  error: string | null;
}>): void {
  getDb()
    .update(schema.regenJobs)
    .set({
      ...(patch.status ? { status: patch.status } : {}),
      ...(patch.results ? { results: toJson(patch.results) } : {}),
      ...(patch.error !== undefined ? { error: patch.error } : {}),
      updatedAt: nowIso(),
    })
    .where(eq(schema.regenJobs.id, jobId))
    .run();
}

function mapJob(row: typeof schema.regenJobs.$inferSelect): RegenJob {
  return {
    id: row.id,
    itemId: row.itemId,
    sides: parseJson<RegenSide[]>(row.sides, []),
    feedback: row.feedback,
    status: row.status,
    results: row.results ? parseJson(row.results, {}) : {},
    error: row.error,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function getRegenJob(jobId: string): RegenJob {
  const row = getDb().select().from(schema.regenJobs).where(eq(schema.regenJobs.id, jobId)).get();
  if (!row) throw notFound("Regen job", jobId);
  return mapJob(row);
}

/**
 * One regen job at a time. The image call itself is already 1-wide
 * process-wide, so a second concurrent job would only sit blocked inside that
 * limiter while looking "running" to the UI. Queueing at the job level instead
 * keeps the status honest: a job that has not started yet still reads "queued".
 */
const runLimited = createLimiter(1);

async function runRegenJob(jobId: string, itemId: string, sides: RegenSide[], feedback: string): Promise<void> {
  updateJob(jobId, { status: "running" });
  try {
    // Read metadata at RUN time, not queue time — if he edits the colour while
    // a job waits its turn, the edit should still ground the generation.
    const facts = itemFacts(getItem(itemId));
    const results: RegenJob["results"] = {};
    for (const side of sides) {
      results[side] = await regenerateSide(itemId, side, { facts, feedback });
      // Persist per side, so polling shows the front landing while the back
      // is still generating rather than nothing for 40s.
      updateJob(jobId, { results });
    }
    updateJob(jobId, { status: "done", results });
  } catch (err) {
    updateJob(jobId, { status: "failed", error: err instanceof Error ? err.message : String(err) });
  }
}

/** Marks jobs orphaned by a server restart. Lazy, once per process — same shape as imports/pipeline.ts. */
const ORPHAN_STALE_MS = 10 * 60_000;
let orphanRecoveryDone = false;

function recoverOrphanedRegenJobs(): void {
  const db = getDb();
  const cutoff = new Date(Date.now() - ORPHAN_STALE_MS).toISOString();
  const orphans = db
    .select()
    .from(schema.regenJobs)
    .where(and(inArray(schema.regenJobs.status, ["queued", "running"]), lt(schema.regenJobs.updatedAt, cutoff)))
    .all();
  for (const job of orphans) {
    db.update(schema.regenJobs)
      .set({ status: "failed", error: "Interrupted by a server restart", updatedAt: nowIso() })
      .where(eq(schema.regenJobs.id, job.id))
      .run();
  }
  if (orphans.length > 0) {
    console.warn(`[psos] marked ${orphans.length} interrupted regen job(s) as failed`);
  }
}

function ensureOrphanRecovery(): void {
  if (orphanRecoveryDone) return;
  orphanRecoveryDone = true;
  try {
    recoverOrphanedRegenJobs();
  } catch (err) {
    console.error("[psos] regen-job orphan recovery failed:", err);
  }
}

export function startRegenJob(itemId: string, sides: RegenSide[], feedback: string): RegenJob {
  ensureOrphanRecovery();
  getItem(itemId); // 404 before spending anything
  const jobId = newId();
  const ts = nowIso();
  getDb()
    .insert(schema.regenJobs)
    .values({ id: jobId, itemId, sides: toJson(sides), feedback, status: "queued", createdAt: ts, updatedAt: ts })
    .run();

  // Hold the VM up for the whole queued+running life of the job, not just the
  // generating part — a job waiting behind another one is still work in flight,
  // and the machine powering off underneath it is exactly what this prevents.
  workStarted();
  void runLimited(() => runRegenJob(jobId, itemId, sides, feedback))
    .catch((err) => {
      console.error("[psos] regen job crashed:", err);
      updateJob(jobId, { status: "failed", error: err instanceof Error ? err.message : String(err) });
    })
    .finally(workFinished);

  return getRegenJob(jobId);
}
