/**
 * BiRefNet segmentation worker — runs in its OWN node process, spawned by
 * imaging/background-removal.ts. Loads onnxruntime-node and nothing else;
 * sharp (or any image codec) must never be imported here — mixing libvips and
 * onnxruntime natives in one process hard-crashes on Windows (GLib/DLL
 * conflict, see docs/DECISIONS.md 2026-07-15). The parent does all image
 * decode/encode; this process only sees raw tensors.
 *
 * Usage: node scripts/birefnet-worker.mjs <model.onnx> <in-tensor.bin> <out-mask.bin>
 *   in-tensor.bin  Float32 CHW 3x1024x1024, ImageNet-normalized (parent-made)
 *   out-mask.bin   Float32 1024x1024 alpha in [0,1] (sigmoid applied here)
 * Exit codes: 0 = mask written, 1 = failure (caller keeps the crop).
 */
import fs from "node:fs";

const SIZE = 1024;

const [modelPath, inPath, outPath] = process.argv.slice(2);
if (!modelPath || !inPath || !outPath) {
  console.error("usage: birefnet-worker.mjs <model.onnx> <in-tensor.bin> <out-mask.bin>");
  process.exit(1);
}

try {
  const ort = await import("onnxruntime-node");
  const session = await ort.InferenceSession.create(modelPath, {
    executionProviders: ["cpu"],
    graphOptimizationLevel: "all",
  });

  const raw = fs.readFileSync(inPath);
  const data = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
  const input = new ort.Tensor("float32", data, [1, 3, SIZE, SIZE]);

  const inputName = session.inputNames[0];
  const outputs = await session.run({ [inputName]: input });

  // BiRefNet exports emit one or more side outputs. Pick by SHAPE (the full-res
  // single-channel map) rather than trusting output order.
  const names = session.outputNames;
  const outputName =
    names.find((n) => {
      const d = outputs[n]?.dims ?? [];
      return d.length === 4 && d[1] === 1 && d[2] === SIZE && d[3] === SIZE;
    }) ?? names[names.length - 1];
  const values = outputs[outputName].data;

  // Whether the export already ends in a sigmoid varies between conversions.
  // Applying a second one squashes everything into ~0.5-0.73 — no pixel ever
  // reaches full transparency, so every cutout fails QA with "corner not
  // transparent". Decide from the actual value range instead of assuming.
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < values.length; i++) {
    if (values[i] < min) min = values[i];
    if (values[i] > max) max = values[i];
  }
  const alreadyProbabilities = min >= -0.01 && max <= 1.01;

  const mask = new Float32Array(SIZE * SIZE);
  for (let i = 0; i < mask.length; i++) {
    const v = values[i];
    mask[i] = alreadyProbabilities ? v : 1 / (1 + Math.exp(-v));
  }
  console.error(
    `birefnet: outputs=[${names.join(",")}] chose=${outputName} dims=[${outputs[outputName].dims}] ` +
      `range=${min.toFixed(3)}..${max.toFixed(3)} sigmoid=${alreadyProbabilities ? "skipped" : "applied"}`,
  );
  fs.writeFileSync(outPath, Buffer.from(mask.buffer));
  process.exit(0);
} catch (err) {
  console.error(`birefnet-worker failed: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
}
