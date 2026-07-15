/**
 * Backfill the full image set for items imported before crops/cutouts existed:
 *   1. garment bounding boxes (from stored ai_raw when present, else a
 *      box-only AI call per photo — metadata is never touched)
 *   2. front_cropped / back_cropped files + rows
 *   3. background-removed cutout of the front crop (child process), accepted
 *      only if it passes cutoutQa
 *   4. catalog thumbnail regenerated from the best source: cutout > crop
 *
 * Idempotent — re-running refreshes files and rows in place.
 * Run: npx tsx scripts/backfill-images.ts
 */
import path from "node:path";
import fs from "node:fs";
import { and, eq, ne } from "drizzle-orm";
import { getDb, schema } from "../src/server/db/client";
import { newId, nowIso } from "../src/server/lib/ids";
import { parseJson } from "../src/server/lib/json";
import { resolveImagePath, relativeImagePath, saveBuffer, sha256Of } from "../src/server/imaging/storage";
import { cropToBox, makeThumbnail } from "../src/server/imaging/thumbnails";
import { removeBackground } from "../src/server/imaging/background-removal";
import { cutoutQa } from "../src/server/imaging/cutout-qa";
import { extractBoundingBox } from "../src/server/ai/extraction";
import type { BBox } from "../src/shared/types";

const db = getDb();

function imageRow(itemId: string, role: string) {
  return db
    .select()
    .from(schema.itemImages)
    .where(and(eq(schema.itemImages.itemId, itemId), eq(schema.itemImages.role, role as never)))
    .get();
}

function upsertImage(itemId: string, role: string, absPath: string, buffer: Buffer): void {
  const existing = imageRow(itemId, role);
  if (existing) {
    db.update(schema.itemImages)
      .set({ path: relativeImagePath(absPath), sha256: sha256Of(buffer), width: null, height: null })
      .where(eq(schema.itemImages.id, existing.id))
      .run();
  } else {
    db.insert(schema.itemImages)
      .values({
        id: newId(),
        itemId,
        role: role as never,
        path: relativeImagePath(absPath),
        sha256: sha256Of(buffer),
        createdAt: nowIso(),
      })
      .run();
  }
}

async function boxFor(
  item: { id: string; aiRaw: string | null },
  side: "front" | "back",
  photoAbs: string,
): Promise<BBox | null> {
  const raw = parseJson<{ bbox?: BBox | null; bboxBack?: BBox | null }>(item.aiRaw ?? "null", {});
  const stored = side === "front" ? raw?.bbox : raw?.bboxBack;
  if (stored) return stored;
  return extractBoundingBox(photoAbs);
}

async function main() {
  const items = db.select().from(schema.items).where(ne(schema.items.state, "archived")).all();
  console.log(`${items.length} items`);
  let done = 0;

  for (const item of items) {
    const label = item.name || item.id.slice(0, 8);
    // Seed placeholders have no AI inference and aren't real photos — skip.
    if (item.state === "active" && !item.aiRaw) {
      console.log(`- ${label}: seed item, skip`);
      continue;
    }
    const frontRow = imageRow(item.id, "front");
    if (!frontRow) {
      console.log(`- ${label}: no front photo, skip`);
      continue;
    }
    const frontAbs = resolveImagePath(frontRow.path);
    if (!fs.existsSync(frontAbs)) {
      console.log(`- ${label}: front file missing, skip`);
      continue;
    }
    const dir = path.dirname(frontAbs);

    try {
      // front crop
      const boxF = await boxFor(item, "front", frontAbs);
      const frontBuf = fs.readFileSync(frontAbs);
      const cropFront = boxF ? await cropToBox(frontBuf, boxF) : null;
      if (cropFront) {
        const p = path.join(dir, "front_cropped.jpg");
        await saveBuffer(p, cropFront);
        upsertImage(item.id, "front_cropped", p, cropFront);
      }

      // back crop
      const backRow = imageRow(item.id, "back");
      if (backRow) {
        const backAbs = resolveImagePath(backRow.path);
        if (fs.existsSync(backAbs)) {
          const boxB = await boxFor(item, "back", backAbs);
          const cropBack = boxB ? await cropToBox(fs.readFileSync(backAbs), boxB) : null;
          if (cropBack) {
            const p = path.join(dir, "back_cropped.jpg");
            await saveBuffer(p, cropBack);
            upsertImage(item.id, "back_cropped", p, cropBack);
          }
        }
      }

      // cutout (front crop only) + QA
      let thumbSource = cropFront;
      let cutoutNote = "no crop";
      if (cropFront) {
        const cutout = await removeBackground(cropFront);
        if (cutout) {
          const qa = await cutoutQa(cutout.png);
          if (qa.ok) {
            const p = path.join(dir, "transparent_front.png");
            await saveBuffer(p, cutout.png);
            upsertImage(item.id, "transparent_front", p, cutout.png);
            thumbSource = cutout.png;
            cutoutNote = `cutout ok (opaque ${(qa.opaqueFraction * 100).toFixed(0)}%)`;
          } else {
            cutoutNote = `cutout rejected: ${qa.reason}`;
          }
        } else {
          cutoutNote = "cutout unavailable";
        }
      }

      // thumbnail from best source
      if (thumbSource) {
        const thumb = await makeThumbnail(thumbSource);
        const p = path.join(dir, "thumbnail.jpg");
        await saveBuffer(p, thumb.buffer);
        const existing = imageRow(item.id, "thumbnail");
        if (existing) {
          db.update(schema.itemImages)
            .set({ width: thumb.width, height: thumb.height, sha256: sha256Of(thumb.buffer) })
            .where(eq(schema.itemImages.id, existing.id))
            .run();
        } else {
          upsertImage(item.id, "thumbnail", p, thumb.buffer);
        }
      }

      console.log(`✓ ${label}: crop=${cropFront ? "yes" : "NO"} · ${cutoutNote}`);
      done++;
    } catch (err) {
      console.log(`! ${label}: ${err instanceof Error ? err.message : err}`);
    }
  }
  console.log(`\nDone: ${done}/${items.length}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
