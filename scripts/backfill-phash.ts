/**
 * One-off: compute the perceptual hash for existing front photos so duplicate
 * detection covers items imported before the phash column existed.
 * Idempotent. Run: npx tsx scripts/backfill-phash.ts
 */
import fs from "node:fs";
import { and, eq, isNull } from "drizzle-orm";
import { getDb, schema } from "../src/server/db/client";
import { resolveImagePath } from "../src/server/imaging/storage";
import { dhash } from "../src/server/imaging/phash";

async function main() {
  const db = getDb();
  const rows = db
    .select()
    .from(schema.itemImages)
    .where(and(eq(schema.itemImages.role, "front"), isNull(schema.itemImages.phash)))
    .all();
  console.log(`${rows.length} front photos without phash`);
  for (const row of rows) {
    const abs = resolveImagePath(row.path);
    if (!fs.existsSync(abs)) {
      console.log(`- ${row.itemId.slice(0, 8)}: file missing, skip`);
      continue;
    }
    const hash = await dhash(fs.readFileSync(abs));
    db.update(schema.itemImages)
      .set({ phash: hash })
      .where(eq(schema.itemImages.id, row.id))
      .run();
    console.log(`✓ ${row.itemId.slice(0, 8)} ${hash}`);
  }
  console.log("done");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
