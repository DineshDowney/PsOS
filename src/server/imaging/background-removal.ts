/**
 * Background removal behind a narrow, swappable interface.
 *
 * Current implementation: @imgly/background-removal-node (ONNX, runs locally;
 * downloads model weights on first use). If quality on real wardrobe photos
 * disappoints, replace `removeBackground` with another implementation — a
 * different ONNX model or a Python sidecar — without touching the pipeline.
 *
 * Contract: returns a PNG buffer with alpha, or null when removal is
 * unavailable/failed. Callers must treat null as "keep the original" — the
 * cutout is cosmetic, never load-bearing.
 */

export interface BackgroundRemovalResult {
  png: Buffer;
}

let unavailableReason: string | null = null;

export async function removeBackground(
  input: Buffer,
): Promise<BackgroundRemovalResult | null> {
  if (unavailableReason) return null;
  try {
    const mod = await import("@imgly/background-removal-node");
    const blob = new Blob([new Uint8Array(input)], { type: "image/jpeg" });
    const result = await mod.removeBackground(blob, {
      output: { format: "image/png" },
    });
    const arrayBuffer = await result.arrayBuffer();
    return { png: Buffer.from(arrayBuffer) };
  } catch (err) {
    // Mark unavailable for this process so we fail fast on subsequent items,
    // but keep the error visible — never silent.
    unavailableReason = err instanceof Error ? err.message : String(err);
    console.error("[psos] background removal unavailable:", unavailableReason);
    return null;
  }
}

export function backgroundRemovalUnavailableReason(): string | null {
  return unavailableReason;
}
