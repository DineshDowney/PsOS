/**
 * Diagnostic: which Gemini models does this key/endpoint actually serve?
 *
 * Model ids change faster than code; run this before a batch to see what
 * responds. Text probes are ~free (a few tokens); the image probe costs one
 * image (~$0.04) and is skipped unless --image is passed.
 *
 * Never prints the key. Run: npx tsx scripts/vertex-probe.ts [--image]
 */
import { loadEnvFile } from "../src/server/lib/env-file";

loadEnvFile();

import sharp from "sharp";
import {
  generateContent,
  firstText,
  firstImage,
  inlineImage,
  hasVertexKey,
  listModels,
} from "../src/server/ai/vertex-client";
import { imageModels } from "../src/server/ai/image-generation";

const TEXT_CANDIDATES = [
  "gemini-flash-latest",
  "gemini-3.6-flash",
  "gemini-3.5-flash",
  "gemini-2.5-flash-lite",
];

async function probeText(model: string): Promise<string> {
  try {
    const res = await generateContent({
      models: [model],
      parts: [{ text: 'Reply with exactly this JSON: {"ok":true}' }],
      responseMimeType: "application/json",
      maxOutputTokens: 32,
      temperature: 0,
    });
    return `OK  ${model} → ${firstText(res).slice(0, 40)}`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `--  ${model} → ${msg.replace(/\s+/g, " ").slice(0, 160)}`;
  }
}

async function main() {
  if (!hasVertexKey()) {
    console.error("VERTEX_API_KEY not set (expected in .env.local)");
    process.exit(1);
  }
  console.log("=== models this key can reach ===");
  try {
    const models = await listModels();
    const usable = models.filter((m) => m.supportedGenerationMethods?.includes("generateContent"));
    for (const m of usable) {
      const id = m.name.replace(/^models\//, "");
      console.log(`  ${id}${/image/i.test(id) ? "   <-- image-capable?" : ""}`);
    }
    console.log(`(${usable.length} of ${models.length} support generateContent)`);
  } catch (err) {
    console.log(`  listModels failed: ${err instanceof Error ? err.message : err}`);
  }

  console.log("\n=== text/vision probe ===");
  for (const m of TEXT_CANDIDATES) console.log(await probeText(m));

  if (!process.argv.includes("--image")) {
    console.log("\n(skipping image probe; pass --image to spend ~$0.04)");
    return;
  }

  console.log("\n=== image models ===");
  const swatch = await sharp({
    create: { width: 256, height: 256, channels: 3, background: "#3366aa" },
  })
    .jpeg()
    .toBuffer();
  for (const m of imageModels()) {
    try {
      const res = await generateContent({
        models: [m],
        parts: [
          { text: "Recreate this solid colour square as a product photo on a light grey background." },
          inlineImage(swatch, "image/jpeg"),
        ],
        responseModalities: ["IMAGE"],
        temperature: 0,
      });
      const img = firstImage(res);
      console.log(`OK  ${m} → ${img ? `${img.length} bytes image` : "no image part"}`);
      if (img) break; // one working image model is all we need
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`--  ${m} → ${msg.replace(/\s+/g, " ").slice(0, 160)}`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
