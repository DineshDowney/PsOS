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
 * Only touches the `transparent_*` roles and the thumbnail. Originals, crops and
 * the archived raw generations are never written.
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

function setThumbnail(itemId: string, absPath: string, buffer: Buffer, w: number, h: number): void {
  const existing = imageRow(itemId, "thumbnail");
  if (!existing) {
    upsertImage(itemId, "thumbnail", absPath, buffer);
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

/** Repoint the catalog tile at the new cutout, exactly as regenerate does. */
async function refreshThumbnail(
  itemId: string,
  dir: string,
  cutout: Cutout | null,
  generated: Buffer,
): Promise<string> {
  if (cutout) {
    const thumb = await makeThumbnail(cutout.png, { alpha: true });
    const p = path.join(dir, "thumbnail.png");
    await saveBuffer(p, thumb.buffer);
    setThumbnail(itemId, p, thumb.buffer, thumb.width, thumb.height);
    return "transparent tile";
  }
  const thumb = await makeThumbnail(generated);
  const p = path.join(dir, "thumbnail.jpg");
  await saveBuffer(p, thumb.buffer);
  setThumbnail(itemId, p, thumb.buffer, thumb.width, thumb.height);
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
    let frontCutout: Cutout | null = null;
    let frontGenerated: Buffer | null = null;
    let touched = false;

    for (const side of sides) {
      const generated = generation(item.id, side);
      if (!generated) continue;
      touched = true;

      if (dryRun) {
        console.log(`- ${label} (${side}): would re-key`);
        if (side === "front") frontGenerated = generated;
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

      if (side === "front") {
        frontCutout = cutout;
        frontGenerated = generated;
      }
    }

    if (!touched) continue;
    if (!dryRun && frontGenerated) {
      console.log(`  → tile: ${await refreshThumbnail(item.id, dir, frontCutout, frontGenerated)}`);
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
