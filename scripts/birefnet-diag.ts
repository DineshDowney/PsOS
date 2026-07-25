/**
 * Diagnostic: run the current background-removal engine over item crops and
 * report the QA verdict per item, writing the PNGs somewhere inspectable. No DB
 * writes — safe to run any time.
 *
 * Run: npx tsx scripts/birefnet-diag.ts [name-fragment ...]
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { and, eq, ne } from "drizzle-orm";

process.env.PSOS_BG_DEBUG ??= "1";

import { getDb, schema } from "../src/server/db/client";
import { resolveImagePath } from "../src/server/imaging/storage";
import { removeBackground } from "../src/server/imaging/background-removal";
import { cutoutQa } from "../src/server/imaging/cutout-qa";

async function main() {
  const fragments = process.argv.slice(2).map((s) => s.toLowerCase());
  const db = getDb();
  const outDir = path.join(os.tmpdir(), "psos-brn-diag");
  fs.mkdirSync(outDir, { recursive: true });

  const items = db.select().from(schema.items).where(ne(schema.items.state, "archived")).all();
  const chosen = items.filter(
    (i) => fragments.length === 0 || fragments.some((f) => (i.name ?? "").toLowerCase().includes(f)),
  );
  console.log(`${chosen.length} item(s); output → ${outDir}`);

  for (const item of chosen) {
    const label = item.name || item.id.slice(0, 8);
    const row = db
      .select()
      .from(schema.itemImages)
      .where(and(eq(schema.itemImages.itemId, item.id), eq(schema.itemImages.role, "front_cropped")))
      .get();
    if (!row) {
      console.log(`- ${label}: no crop`);
      continue;
    }
    const abs = resolveImagePath(row.path);
    if (!fs.existsSync(abs)) {
      console.log(`- ${label}: crop file missing`);
      continue;
    }
    const res = await removeBackground(fs.readFileSync(abs));
    if (!res) {
      console.log(`! ${label}: engine returned null`);
      continue;
    }
    const qa = await cutoutQa(res.png);
    const file = path.join(outDir, `${label.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.png`);
    fs.writeFileSync(file, res.png);
    console.log(
      `${qa.ok ? "PASS" : "FAIL"} ${label} :: ${
        qa.ok ? `opaque ${(qa.opaqueFraction * 100).toFixed(0)}%` : qa.reason
      }`,
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
