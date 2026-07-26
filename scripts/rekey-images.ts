/**
 * Re-run the cutout ladder over generations we already have.
 *
 * This is the cheap half of `regenerate-images.ts`: same ladder, same tile
 * refresh, but it reads the stored `generated_front` / `generated_back` instead
 * of calling Gemini. So it costs nothing, needs no Vertex credentials, and can
 * run anywhere the data lives — which makes it the right tool whenever the
 * cutout code improves and the existing catalog needs to catch up. Regenerating
 * to pick up a keying fix would be paying $0.04 an image to get the same pixels
 * back.
 *
 * Only touches the `transparent_*` roles and the two tile roles (`thumbnail`,
 * `thumbnail_back`). Originals, crops and the archived raw generations are
 * never written.
 *
 * Also doubles as the backfill for `thumbnail_back` (added 2026-07-26 so the
 * wardrobe grid can rotate front/back): any item with a stored
 * `generated_back` but no `thumbnail_back` row gets one derived from what is
 * already on disk — no Gemini call.
 *
 * Run: npx tsx scripts/rekey-images.ts [--dry-run] [--only <itemId>]
 *          [--side front|back] [--all]
 *
 * By default it skips archived items, matching regenerate-images.ts; `--all`
 * includes them.
 */
import path from "node:path";
import fs from "node:fs";
import { and, eq, ne } from "drizzle-orm";

import { getDb, schema } from "../src/server/db/client";
import { newId, nowIso } from "../src/server/lib/ids";
import { resolveImagePath, relativeImagePath, saveBuffer, sha256Of, itemImageDir } from "../src/server/imaging/storage";
import { makeThumbnail } from "../src/server/imaging/thumbnails";
import { cutoutFromGenerated, type Cutout } from "../src/server/imaging/cutout-ladder";

const db = getDb();

type Side = "front" | "back";

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
    return;
  }
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

/** `role` is "thumbnail" or "thumbnail_back" — same upsert either side. */
function setThumbnail(
  itemId: string,
  role: string,
  absPath: string,
  buffer: Buffer,
  w: number,
  h: number,
): void {
  const existing = imageRow(itemId, role);
  if (!existing) {
    // NOT upsertImage(): that helper is for transparent_front/back, where a
    // null width/height is correct (they are the un-normalized cutout). A tile
    // role always has known dimensions, and this branch is exactly what runs
    // the first time `thumbnail_back` is created for an item — every existing
    // two-sided item hits it once, on this backfill.
    db.insert(schema.itemImages)
      .values({
        id: newId(),
        itemId,
        role: role as never,
        path: relativeImagePath(absPath),
        width: w,
        height: h,
        sha256: sha256Of(buffer),
        createdAt: nowIso(),
      })
      .run();
    return;
  }
  db.update(schema.itemImages)
    .set({ path: relativeImagePath(absPath), width: w, height: h, sha256: sha256Of(buffer) })
    .where(eq(schema.itemImages.id, existing.id))
    .run();
}

/** The stored generation for a side, if the row and the file both survive. */
function generation(itemId: string, side: Side): Buffer | null {
  const row = imageRow(itemId, `generated_${side}`);
  if (!row) return null;
  const abs = resolveImagePath(row.path);
  if (!fs.existsSync(abs)) return null;
  return fs.readFileSync(abs);
}

/**
 * Repoint a catalog tile (front or back) at the new cutout, exactly as
 * regenerate does. `side` picks the role and filename — this is also what
 * backfills `thumbnail_back` for items that had a back generation before that
 * role existed, at $0 (no Gemini call, just re-deriving the tile from the
 * generation already on disk).
 */
async function refreshThumbnail(
  itemId: string,
  dir: string,
  side: Side,
  cutout: Cutout | null,
  generated: Buffer,
): Promise<string> {
  const role = side === "front" ? "thumbnail" : "thumbnail_back";
  if (cutout) {
    const thumb = await makeThumbnail(cutout.png, { alpha: true });
    const p = path.join(dir, `${role}.png`);
    await saveBuffer(p, thumb.buffer);
    setThumbnail(itemId, role, p, thumb.buffer, thumb.width, thumb.height);
    return "transparent tile";
  }
  const thumb = await makeThumbnail(generated);
  const p = path.join(dir, `${role}.jpg`);
  await saveBuffer(p, thumb.buffer);
  setThumbnail(itemId, role, p, thumb.buffer, thumb.width, thumb.height);
  return "opaque tile (no transparency available)";
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const arg = (flag: string): string | undefined => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const only = arg("--only");
  const sideArg = arg("--side") as Side | undefined;
  const sides: Side[] = sideArg ? [sideArg] : ["front", "back"];

  let items = args.includes("--all")
    ? db.select().from(schema.items).all()
    : db.select().from(schema.items).where(ne(schema.items.state, "archived")).all();
  if (only) items = items.filter((i) => i.id === only);

  let rekeyed = 0;
  let clean = 0;
  let lost = 0;

  for (const item of items) {
    const label = item.name || item.id.slice(0, 8);
    const dir = itemImageDir(item.id);
    const cutoutBySide: Record<Side, Cutout | null> = { front: null, back: null };
    const generatedBySide: Record<Side, Buffer | null> = { front: null, back: null };
    let touched = false;

    for (const side of sides) {
      const generated = generation(item.id, side);
      if (!generated) continue;
      touched = true;

      if (dryRun) {
        console.log(`- ${label} (${side}): would re-key`);
        generatedBySide[side] = generated;
        continue;
      }

      const cutout = await cutoutFromGenerated(generated);
      rekeyed++;
      if (cutout) {
        if (cutout.clean) clean++;
        else lost++;
        const cutPath = path.join(dir, `transparent_${side}.png`);
        await saveBuffer(cutPath, cutout.png);
        upsertImage(item.id, `transparent_${side}`, cutPath, cutout.png);
      } else {
        lost++;
      }
      console.log(`${cutout?.clean ? "✓" : "~"} ${label} (${side}): ${cutout ? cutout.how : "no transparency"}`);

      cutoutBySide[side] = cutout;
      generatedBySide[side] = generated;
    }

    if (!touched) continue;
    if (dryRun) continue;
    for (const side of sides) {
      const generated = generatedBySide[side];
      if (!generated) continue;
      console.log(
        `  → ${side} tile: ${await refreshThumbnail(item.id, dir, side, cutoutBySide[side], generated)}`,
      );
    }
  }

  if (dryRun) {
    console.log(`\nDry run over ${items.length} item(s) — nothing written.`);
    return;
  }
  console.log(`\nDone: ${rekeyed} re-keyed, ${clean} clean, ${lost} needing attention.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
