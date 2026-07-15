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
  // Escape hatch: @imgly's onnxruntime hard-crashes the whole Node process on
  // some machines (native GLib/DLL conflict with sharp's libvips on Windows —
  // observed 2026-07-15, uncatchable from JS). The flag lets imports run
  // without cutouts until removal is isolated in its own process.
  if (process.env.PSOS_DISABLE_BG_REMOVAL === "1") {
    if (!unavailableReason) {
      unavailableReason = "disabled via PSOS_DISABLE_BG_REMOVAL=1";
      console.warn("[psos] background removal disabled by env flag");
    }
    return null;
  }
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
