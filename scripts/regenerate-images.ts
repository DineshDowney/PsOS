/**
 * Regenerate wardrobe display images with Gemini.
 *
 * For each item: garment crop → Gemini product shot → transparency (flat-key
 * first, segmentation as fallback) → QA gate → thumbnail. Every step keeps the
 * previous artifact, and a failure at any point leaves the item exactly as it
 * was — a bad run can never make the catalog worse.
 *
 * Raw generations are archived under data/generated/<itemId>/ (never served);
 * the servable copy goes to data/images/<itemId>/generated_front.png like every
 * other role.
 *
 * VM-only by intent (the Vertex key lives there).
 *
 * Run: npx tsx scripts/regenerate-images.ts [--dry-run] [--only <itemId>] [--limit N]
 */
import path from "node:path";
import fs from "node:fs";
import { and, eq, ne } from "drizzle-orm";
import { loadEnvFile } from "../src/server/lib/env-file";

loadEnvFile(); // must precede anything that reads VERTEX_API_KEY

import { getDb, schema, dataDir } from "../src/server/db/client";
import { newId, nowIso } from "../src/server/lib/ids";
import {
  resolveImagePath,
  relativeImagePath,
  saveBuffer,
  sha256Of,
  itemImageDir,
} from "../src/server/imaging/storage";
import { makeThumbnail } from "../src/server/imaging/thumbnails";
import { keyFlatBackground } from "../src/server/imaging/flat-key";
import { removeBackground } from "../src/server/imaging/background-removal";
import { cutoutQa } from "../src/server/imaging/cutout-qa";
import { generateProductShot } from "../src/server/ai/image-generation";
import { hasVertexKey } from "../src/server/ai/vertex-client";

const db = getDb();

/** ~$0.04/image at current Gemini flash-image rates; for the dry-run estimate. */
const COST_PER_IMAGE = 0.04;

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

function setThumbnail(itemId: string, absPath: string, buffer: Buffer, w: number, h: number): void {
  const existing = imageRow(itemId, "thumbnail");
  if (existing) {
    db.update(schema.itemImages)
      .set({ path: relativeImagePath(absPath), width: w, height: h, sha256: sha256Of(buffer) })
      .where(eq(schema.itemImages.id, existing.id))
      .run();
  } else {
    upsertImage(itemId, "thumbnail", absPath, buffer);
  }
}

/** Best available source photo for generation: the tight crop, else the original. */
function sourcePhoto(itemId: string): { buffer: Buffer; mime: string } | null {
  for (const role of ["front_cropped", "front"] as const) {
    const row = imageRow(itemId, role);
    if (!row) continue;
    const abs = resolveImagePath(row.path);
    if (!fs.existsSync(abs)) continue;
    return {
      buffer: fs.readFileSync(abs),
      mime: abs.endsWith(".png") ? "image/png" : "image/jpeg",
    };
  }
  return null;
}

/**
 * Turn a generated shot into a transparent cutout. Flat-key first (we control
 * the background, so it is both cheaper and more reliable than ML), then
 * segmentation, then give up. QA decides in every case.
 */
async function cutoutFromGenerated(png: Buffer): Promise<{ png: Buffer; how: string } | null> {
  const flat = await keyFlatBackground(png);
  if (flat) {
    const qa = await cutoutQa(flat.png);
    if (qa.ok) return { png: flat.png, how: `flat-key (kept ${(flat.keptFraction * 100).toFixed(0)}%)` };
  }
  const seg = await removeBackground(png);
  if (seg) {
    const qa = await cutoutQa(seg.png);
    if (qa.ok) return { png: seg.png, how: "segmentation" };
  }
  return null;
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const onlyIdx = args.indexOf("--only");
  const only = onlyIdx >= 0 ? args[onlyIdx + 1] : undefined;
  const limitIdx = args.indexOf("--limit");
  const limit = limitIdx >= 0 ? Number(args[limitIdx + 1]) : undefined;

  if (!dryRun && !hasVertexKey()) {
    console.error("VERTEX_API_KEY is not set (expected in .env.local) — nothing to do.");
    process.exit(1);
  }

  let items = db.select().from(schema.items).where(ne(schema.items.state, "archived")).all();
  if (only) items = items.filter((i) => i.id === only);
  if (limit && limit > 0) items = items.slice(0, limit);

  console.log(`${items.length} item(s) to regenerate`);
  if (dryRun) {
    console.log(`estimated cost: ~$${(items.length * COST_PER_IMAGE).toFixed(2)} at $${COST_PER_IMAGE}/image`);
    for (const item of items) {
      const src = sourcePhoto(item.id);
      console.log(`- ${item.name || item.id.slice(0, 8)}: ${src ? "ready" : "NO SOURCE PHOTO, would skip"}`);
    }
    return;
  }

  const generatedRoot = path.join(dataDir, "generated");
  let generated = 0;
  let cutouts = 0;

  for (const item of items) {
    const label = item.name || item.id.slice(0, 8);
    const src = sourcePhoto(item.id);
    if (!src) {
      console.log(`- ${label}: no source photo, skip`);
      continue;
    }

    const shot = await generateProductShot(src.buffer, src.mime);
    if (!shot) {
      console.log(`! ${label}: generation failed — item left untouched`);
      continue;
    }
    generated++;

    // Archive the raw generation (provenance/history), never served.
    const archiveDir = path.join(generatedRoot, item.id);
    await saveBuffer(
      path.join(archiveDir, `product-${sha256Of(shot.png).slice(0, 8)}.png`),
      shot.png,
    );

    // Servable copy alongside the other roles.
    const dir = itemImageDir(item.id);
    const genPath = path.join(dir, "generated_front.png");
    await saveBuffer(genPath, shot.png);
    upsertImage(item.id, "generated_front", genPath, shot.png);

    const cutout = await cutoutFromGenerated(shot.png);
    if (cutout) {
      const cutPath = path.join(dir, "transparent_front.png");
      await saveBuffer(cutPath, cutout.png);
      upsertImage(item.id, "transparent_front", cutPath, cutout.png);
      const thumb = await makeThumbnail(cutout.png, { alpha: true });
      const thumbPath = path.join(dir, "thumbnail.png");
      await saveBuffer(thumbPath, thumb.buffer);
      setThumbnail(item.id, thumbPath, thumb.buffer, thumb.width, thumb.height);
      cutouts++;
      console.log(`✓ ${label}: generated (${shot.model}) · cutout via ${cutout.how}`);
    } else {
      // No usable transparency: keep the existing cutout/thumbnail rather than
      // downgrade the tile to a light-grey square on the black grid.
      console.log(
        `~ ${label}: generated (${shot.model}) but no cutout passed QA — kept previous thumbnail`,
      );
    }
  }

  console.log(`\nDone: ${generated}/${items.length} generated, ${cutouts} cutouts accepted`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
