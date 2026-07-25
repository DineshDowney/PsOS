/**
 * Diagnostic: why did a given image fail to become a clean cutout?
 * Reports the flat-key result and the QA verdict at each rung, and writes the
 * keyed PNG next to the input for eyeballing. No DB writes.
 *
 * Run: npx tsx scripts/cutout-diag.ts <image-path> [tolerance]
 */
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { keyFlatBackground } from "../src/server/imaging/flat-key";
import { cutoutQa } from "../src/server/imaging/cutout-qa";

async function main() {
  const file = process.argv[2];
  if (!file) {
    console.error("usage: npx tsx scripts/cutout-diag.ts <image-path> [tolerance]");
    process.exit(1);
  }
  const tolerance = process.argv[3] ? Number(process.argv[3]) : undefined;
  const buf = fs.readFileSync(file);
  const meta = await sharp(buf).metadata();
  console.log(`input: ${meta.width}x${meta.height} channels=${meta.channels} hasAlpha=${meta.hasAlpha}`);

  const rawQa = await cutoutQa(buf);
  console.log(`native alpha QA: ${rawQa.ok ? "PASS" : `FAIL (${rawQa.reason})`}`);

  // Corner sample, so a tolerance problem is obvious.
  const { data, info } = await sharp(buf).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const px = (x: number, y: number) => {
    const i = (y * info.width + x) * info.channels;
    return `${data[i]},${data[i + 1]},${data[i + 2]}`;
  };
  console.log(
    `corners: tl=${px(2, 2)} tr=${px(info.width - 3, 2)} bl=${px(2, info.height - 3)} br=${px(info.width - 3, info.height - 3)}`,
  );
  console.log(`edge midpoints: top=${px(Math.floor(info.width / 2), 2)} bottom=${px(Math.floor(info.width / 2), info.height - 3)}`);

  for (const tol of tolerance ? [tolerance] : [20, 30, 45, 60, 80]) {
    const keyed = await keyFlatBackground(buf, { tolerance: tol });
    if (!keyed) {
      console.log(`tolerance ${tol}: flat-key returned null (nothing or everything removed)`);
      continue;
    }
    const qa = await cutoutQa(keyed.png);
    console.log(
      `tolerance ${tol}: kept ${(keyed.keptFraction * 100).toFixed(1)}% → QA ${qa.ok ? "PASS" : `FAIL (${qa.reason})`}`,
    );
    const out = path.join(path.dirname(file), `${path.basename(file, path.extname(file))}-keyed-${tol}.png`);
    fs.writeFileSync(out, keyed.png);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
