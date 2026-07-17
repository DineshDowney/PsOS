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
  // BiRefNet exports emit one or more side outputs; the final refined map is
  // conventionally the last output. Take it and sigmoid to [0,1].
  const outputName = session.outputNames[session.outputNames.length - 1];
  const logits = outputs[outputName].data;

  const mask = new Float32Array(SIZE * SIZE);
  for (let i = 0; i < mask.length; i++) {
    mask[i] = 1 / (1 + Math.exp(-logits[i]));
  }
  fs.writeFileSync(outPath, Buffer.from(mask.buffer));
  process.exit(0);
} catch (err) {
  console.error(`birefnet-worker failed: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
}
