import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { execFile } from "node:child_process";
import { newId } from "@/server/lib/ids";
import { MODEL_SIZE, maskToAlphaPng, toModelTensor } from "./birefnet-tensor";

/**
 * Background removal behind a narrow, swappable interface.
 *
 * Two engines, both running inference in their OWN node process — mixing
 * sharp's libvips with any onnxruntime in one process hard-crashes on Windows
 * (native GLib/DLL conflict, uncatchable from JS — docs/DECISIONS.md
 * 2026-07-15). A child process turns that worst case into "cutout
 * unavailable, keep the crop".
 *
 *   1. BiRefNet (preferred): used when models/birefnet.onnx exists. The model
 *      file is downloaded BY THE USER in a browser (no tooling-originated
 *      external HTTP from this machine — endpoint-security constraint). The
 *      parent does all image work (birefnet-tensor.ts); the worker
 *      (scripts/birefnet-worker.mjs) only sees raw float tensors.
 *   2. imgly (fallback): scripts/bg-worker.mjs, weights bundled in
 *      node_modules.
 *
 * Quality note (2026-07-15): segmentation output is only good on PRE-CROPPED
 * garment images. Callers must pass the bbox crop, not the full-frame photo.
 *
 * Contract: PNG buffer with alpha, or null when removal is unavailable or
 * failed. Callers treat null as "keep the original" — cosmetic, never
 * load-bearing.
 */

export interface BackgroundRemovalResult {
  png: Buffer;
}

const IMGLY_WORKER = path.join(process.cwd(), "scripts", "bg-worker.mjs");
const BIREFNET_WORKER = path.join(process.cwd(), "scripts", "birefnet-worker.mjs");
const BIREFNET_MODEL = path.join(process.cwd(), "models", "birefnet.onnx");
const TIMEOUT_MS = 180_000;

function runWorker(args: string[]): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    execFile(
      process.execPath,
      args,
      { timeout: TIMEOUT_MS, windowsHide: true },
      (err, _stdout, stderr) => {
        if (err) reject(new Error(stderr?.trim() || err.message));
        else resolve();
      },
    );
  });
}

/** BiRefNet path: parent prepares/consumes tensors, worker only runs the model. */
async function removeViaBirefnet(input: Buffer): Promise<BackgroundRemovalResult> {
  const tmpBase = path.join(os.tmpdir(), `psos-brn-${newId()}`);
  const inPath = `${tmpBase}-in.bin`;
  const outPath = `${tmpBase}-mask.bin`;
  try {
    await fs.promises.writeFile(inPath, await toModelTensor(input));
    await runWorker([BIREFNET_WORKER, BIREFNET_MODEL, inPath, outPath]);
    const raw = await fs.promises.readFile(outPath);
    if (raw.byteLength !== MODEL_SIZE * MODEL_SIZE * 4) {
      throw new Error(`unexpected mask size ${raw.byteLength}`);
    }
    const mask = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
    return { png: await maskToAlphaPng(input, mask) };
  } finally {
    void fs.promises.rm(inPath, { force: true }).catch(() => {});
    void fs.promises.rm(outPath, { force: true }).catch(() => {});
  }
}

/** imgly path: worker does decode+matte+encode itself from an image file. */
async function removeViaImgly(input: Buffer): Promise<BackgroundRemovalResult> {
  const tmpBase = path.join(os.tmpdir(), `psos-bg-${newId()}`);
  const inPath = `${tmpBase}-in.jpg`;
  const outPath = `${tmpBase}-out.png`;
  try {
    await fs.promises.writeFile(inPath, input);
    await runWorker([IMGLY_WORKER, inPath, outPath]);
    return { png: await fs.promises.readFile(outPath) };
  } finally {
    void fs.promises.rm(inPath, { force: true }).catch(() => {});
    void fs.promises.rm(outPath, { force: true }).catch(() => {});
  }
}

export function birefnetAvailable(): boolean {
  return fs.existsSync(BIREFNET_MODEL) && fs.existsSync(BIREFNET_WORKER);
}

export async function removeBackground(
  input: Buffer,
): Promise<BackgroundRemovalResult | null> {
  if (process.env.PSOS_DISABLE_BG_REMOVAL === "1") return null;

  const engine =
    process.env.PSOS_BG_ENGINE === "imgly" ? "imgly"
    : birefnetAvailable() ? "birefnet"
    : "imgly";

  try {
    if (engine === "birefnet") return await removeViaBirefnet(input);
    if (!fs.existsSync(IMGLY_WORKER)) {
      console.error(`[psos] bg-worker not found at ${IMGLY_WORKER} — skipping cutout`);
      return null;
    }
    return await removeViaImgly(input);
  } catch (err) {
    // A dead worker is a skipped cutout, never a dead server. Keep it loud.
    console.error(
      `[psos] background removal failed (${engine}, keeping crop):`,
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}
