/**
 * One-off backfill: re-crop catalog thumbnails for items imported before the
 * AI garment bounding box existed. For each non-archived item with a front
 * photo, ask Claude for the garment box, crop the front tight to it, and
 * regenerate thumbnail.jpg. Metadata is never touched — only the thumbnail.
 *
 * Idempotent: safe to re-run. Run: npx tsx scripts/backfill-thumbnails.ts
 */
import path from "node:path";
import fs from "node:fs";
import { and, eq, ne } from "drizzle-orm";
import { getDb, schema } from "../src/server/db/client";
import { nowIso } from "../src/server/lib/ids";
import { resolveImagePath, saveBuffer, sha256Of } from "../src/server/imaging/storage";
import { cropToBox, makeThumbnail } from "../src/server/imaging/thumbnails";
import { extractBoundingBox } from "../src/server/ai/extraction";

async function main() {
  const db = getDb();
  const items = db
    .select()
    .from(schema.items)
    .where(ne(schema.items.state, "archived"))
    .all();

  console.log(`${items.length} non-archived items to consider`);
  let cropped = 0;
  let skipped = 0;

  for (const item of items) {
    const front = db
      .select()
      .from(schema.itemImages)
      .where(and(eq(schema.itemImages.itemId, item.id), eq(schema.itemImages.role, "front")))
      .get();
    if (!front) {
      console.log(`- ${item.name || item.id}: no front image, skip`);
      skipped++;
      continue;
    }

    const frontAbs = resolveImagePath(front.path);
    if (!fs.existsSync(frontAbs)) {
      console.log(`- ${item.name || item.id}: front file missing, skip`);
      skipped++;
      continue;
    }

    try {
      const box = await extractBoundingBox(frontAbs);
      if (!box) {
        console.log(`- ${item.name || item.id}: no box returned, skip`);
        skipped++;
        continue;
      }
      const frontBuf = fs.readFileSync(frontAbs);
      const croppedBuf = await cropToBox(frontBuf, box);
      if (!croppedBuf) {
        console.log(`- ${item.name || item.id}: box implausible, skip`);
        skipped++;
        continue;
      }
      const thumb = await makeThumbnail(croppedBuf);
      const thumbPath = path.join(path.dirname(frontAbs), "thumbnail.jpg");
      await saveBuffer(thumbPath, thumb.buffer);

      const existingThumb = db
        .select()
        .from(schema.itemImages)
        .where(and(eq(schema.itemImages.itemId, item.id), eq(schema.itemImages.role, "thumbnail")))
        .get();
      if (existingThumb) {
        db.update(schema.itemImages)
          .set({ width: thumb.width, height: thumb.height, sha256: sha256Of(thumb.buffer) })
          .where(eq(schema.itemImages.id, existingThumb.id))
          .run();
      }
      console.log(`✓ ${item.name || item.id}: cropped [${box.x.toFixed(2)},${box.y.toFixed(2)},${box.w.toFixed(2)},${box.h.toFixed(2)}]`);
      cropped++;
    } catch (err) {
      console.log(`! ${item.name || item.id}: ${err instanceof Error ? err.message : err}`);
      skipped++;
    }
  }

  console.log(`\nDone. cropped=${cropped} skipped=${skipped}  (at ${nowIso()})`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
