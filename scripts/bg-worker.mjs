/**
 * Background-removal worker — runs in its OWN node process, spawned by the
 * pipeline. Loads @imgly/background-removal-node and nothing else; sharp must
 * never be imported here (loading both in one process hard-crashes on Windows
 * — native GLib/DLL conflict, see docs/DECISIONS.md 2026-07-15).
 *
 * Usage: node scripts/bg-worker.mjs <input-image> <output-png>
 * Exit codes: 0 = wrote cutout PNG, 1 = failure (caller keeps the crop).
 */
import fs from "node:fs";

const [inPath, outPath] = process.argv.slice(2);
if (!inPath || !outPath) {
  console.error("usage: node bg-worker.mjs <input-image> <output-png>");
  process.exit(1);
}

try {
  const { removeBackground } = await import("@imgly/background-removal-node");
  const input = fs.readFileSync(inPath);
  const blob = new Blob([new Uint8Array(input)], { type: "image/jpeg" });
  const result = await removeBackground(blob, { output: { format: "image/png" } });
  const png = Buffer.from(await result.arrayBuffer());
  fs.writeFileSync(outPath, png);
  process.exit(0);
} catch (err) {
  console.error("bg-worker failed:", err instanceof Error ? err.message : err);
  process.exit(1);
}
