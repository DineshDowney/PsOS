/**
 * Tile every catalog thumbnail into one PNG so the whole wardrobe can be judged
 * at a glance.
 *
 * Reviewing 30+ tiles by clicking through the app misses exactly the problems
 * that matter — a cutout that is subtly worse than its neighbours, two items
 * that are actually the same garment, one tile framed differently from the rest.
 * Those are only visible side by side, which is the same reason the image prompt
 * pins one pose and one light for every garment.
 *
 * Tiles are drawn on the app's own near-black background, because that is what
 * the cutouts were keyed and eroded for; on white, edge artifacts read
 * differently and the sheet would flag problems the real UI does not have.
 *
 * Run: npx tsx scripts/contact-sheet.ts [--out <path>] [--cols N] [--cell N]
 *      [--all]   include drafts and archived items too
 */
import path from "node:path";
import fs from "node:fs";
import sharp from "sharp";
import { and, eq } from "drizzle-orm";
import { getDb, schema, dataDir } from "../src/server/db/client";
import { resolveImagePath } from "../src/server/imaging/storage";

const args = process.argv.slice(2);
const flag = (name: string, fallback: string): string => {
  const i = args.indexOf(`--${name}`);
  return (i >= 0 ? args[i + 1] : undefined) ?? fallback;
};

const OUT = path.resolve(flag("out", path.join(dataDir, "contact-sheet.png")));
const COLS = Number(flag("cols", "6"));
const CELL = Number(flag("cell", "260"));
const LABEL_H = 34;
const PAD = 10;
/** Matches the app's --color-bg; see globals.css. */
const BG = { r: 10, g: 10, b: 11, alpha: 1 };

const db = getDb();

const items = db
  .select()
  .from(schema.items)
  .all()
  .filter((i) => (args.includes("--all") ? true : i.state === "active"))
  .sort((a, b) => (a.category ?? "").localeCompare(b.category ?? "") || a.name.localeCompare(b.name));

if (items.length === 0) {
  console.error("[psos] no items to sheet");
  process.exit(1);
}

/** Best tile for an item, in the order the app itself would prefer. */
function tilePath(itemId: string): string | null {
  const rows = db
    .select()
    .from(schema.itemImages)
    .where(eq(schema.itemImages.itemId, itemId))
    .all();
  for (const role of ["thumbnail", "cutout_front", "generated_front", "front_cropped", "front"]) {
    const row = rows.find((r) => r.role === role);
    if (!row) continue;
    const abs = resolveImagePath(row.path);
    if (fs.existsSync(abs)) return abs;
  }
  return null;
}

async function label(text: string, width: number): Promise<Buffer> {
  // Escaped for SVG: a garment called `Levi's & "Co"` must not break the render.
  const safe = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
  const svg = `<svg width="${width}" height="${LABEL_H}" xmlns="http://www.w3.org/2000/svg">
    <text x="0" y="13" font-family="monospace" font-size="12" fill="#e8e6e1">${safe}</text>
  </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

async function main() {
  const rows = Math.ceil(items.length / COLS);
  const cellW = CELL + PAD * 2;
  const cellH = CELL + LABEL_H + PAD * 2;
  const sheetW = cellW * COLS;
  const sheetH = cellH * rows;

  const composites: sharp.OverlayOptions[] = [];
  const legend: string[] = [];
  let missing = 0;

  for (const [i, item] of items.entries()) {
    const col = i % COLS;
    const row = Math.floor(i / COLS);
    const x = col * cellW + PAD;
    const y = row * cellH + PAD;

    const src = tilePath(item.id);
    legend.push(
      `${String(i + 1).padStart(3)}  ${item.category ?? "?"}  ${item.name || "(unnamed)"}  ${item.id}${src ? "" : "  [NO IMAGE]"}`,
    );
    if (!src) {
      missing++;
      continue;
    }

    // `contain` on the same background keeps every garment at its true relative
    // size in the frame — stretching would hide framing inconsistencies.
    const tile = await sharp(src)
      .resize(CELL, CELL, { fit: "contain", background: BG })
      .flatten({ background: BG })
      .toBuffer();
    composites.push({ input: tile, left: x, top: y });
    composites.push({
      input: await label(`${i + 1}. ${(item.name || "unnamed").slice(0, 30)}`, CELL),
      left: x,
      top: y + CELL + 4,
    });
  }

  await sharp({ create: { width: sheetW, height: sheetH, channels: 4, background: BG } })
    .composite(composites)
    .png()
    .toFile(OUT);

  const legendPath = OUT.replace(/\.png$/, ".txt");
  fs.writeFileSync(legendPath, legend.join("\n") + "\n", "utf8");

  console.log(`[psos] ${items.length} items, ${missing} without an image`);
  console.log(`[psos] sheet:  ${OUT}  (${sheetW}x${sheetH})`);
  console.log(`[psos] legend: ${legendPath}`);
}

main().catch((err) => {
  console.error("[psos] contact sheet failed:", err);
  process.exit(1);
});
