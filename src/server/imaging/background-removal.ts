import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { execFile } from "node:child_process";
import { newId } from "@/server/lib/ids";

/**
 * Background removal behind a narrow, swappable interface.
 *
 * Implementation: @imgly/background-removal-node running in its OWN node
 * process (scripts/bg-worker.mjs). It must never load in-process: sharp's
 * libvips and imgly's onnxruntime hard-crash the whole server when loaded
 * together on Windows (native GLib/DLL conflict, uncatchable from JS —
 * docs/DECISIONS.md 2026-07-15). A child process turns that worst case into
 * "cutout unavailable, keep the crop".
 *
 * Quality note (same date): imgly output is only good on PRE-CROPPED garment
 * images. Callers must pass the bbox crop, not the full-frame photo.
 *
 * Contract: PNG buffer with alpha, or null when removal is unavailable or
 * failed. Callers treat null as "keep the original" — cosmetic, never
 * load-bearing.
 */

export interface BackgroundRemovalResult {
  png: Buffer;
}

const WORKER = path.join(process.cwd(), "scripts", "bg-worker.mjs");
const TIMEOUT_MS = 180_000; // first run downloads model weights

export async function removeBackground(
  input: Buffer,
): Promise<BackgroundRemovalResult | null> {
  if (process.env.PSOS_DISABLE_BG_REMOVAL === "1") return null;
  if (!fs.existsSync(WORKER)) {
    console.error(`[psos] bg-worker not found at ${WORKER} — skipping cutout`);
    return null;
  }

  const tmpBase = path.join(os.tmpdir(), `psos-bg-${newId()}`);
  const inPath = `${tmpBase}-in.jpg`;
  const outPath = `${tmpBase}-out.png`;

  try {
    await fs.promises.writeFile(inPath, input);
    await new Promise<void>((resolve, reject) => {
      execFile(
        process.execPath,
        [WORKER, inPath, outPath],
        { timeout: TIMEOUT_MS, windowsHide: true },
        (err, _stdout, stderr) => {
          if (err) reject(new Error(stderr?.trim() || err.message));
          else resolve();
        },
      );
    });
    return { png: await fs.promises.readFile(outPath) };
  } catch (err) {
    // A dead worker is a skipped cutout, never a dead server. Keep it loud.
    console.error(
      "[psos] background removal failed (keeping crop):",
      err instanceof Error ? err.message : err,
    );
    return null;
  } finally {
    void fs.promises.rm(inPath, { force: true }).catch(() => {});
    void fs.promises.rm(outPath, { force: true }).catch(() => {});
  }
}
