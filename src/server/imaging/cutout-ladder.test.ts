import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { cutoutFromGenerated } from "./cutout-ladder";

/**
 * Fake product shots. The ladder only ever sees a generated image, which our own
 * prompt frames with "an even margin of empty space on all four sides" — so the
 * fixtures are a centred garment on a full-bleed backdrop, matching the real
 * input rather than a tight bbox crop.
 */
const SIZE = 120;

async function shot(opts: {
  bg: string | null; // null = transparent backdrop (the model honoured alpha)
  fg: string;
  garment?: number; // garment square side, default 60 (25% of the frame)
}): Promise<Buffer> {
  const side = opts.garment ?? 60;
  const offset = Math.round((SIZE - side) / 2);
  const box = await sharp({
    create: { width: side, height: side, channels: 3, background: opts.fg },
  })
    .png()
    .toBuffer();
  return sharp({
    create: {
      width: SIZE,
      height: SIZE,
      channels: 4,
      background: opts.bg ?? { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite([{ input: box, left: offset, top: offset }])
    .png()
    .toBuffer();
}

/** Wraps a retry so tests can assert it was (or was not) paid for. */
function countingRetry(result: Buffer | null) {
  const state = { calls: 0 };
  return {
    state,
    retry: async () => {
      state.calls++;
      return result;
    },
  };
}

describe("cutoutFromGenerated", () => {
  it("rung 1: keeps the model's own alpha untouched", async () => {
    const png = await shot({ bg: null, fg: "#303030" });
    const { state, retry } = countingRetry(null);

    const out = await cutoutFromGenerated(png, retry);

    expect(out).not.toBeNull();
    expect(out!.how).toBe("native transparency");
    expect(out!.clean).toBe(true);
    // Byte-identical: rung 1 must not re-encode an image that was already fine.
    expect(out!.png).toBe(png);
    expect(state.calls).toBe(0);
  });

  it("rung 2: flat-keys the grey backdrop we asked for", async () => {
    const png = await shot({ bg: "#f2f2f0", fg: "#303030" });
    const { state, retry } = countingRetry(null);

    const out = await cutoutFromGenerated(png, retry);

    expect(out).not.toBeNull();
    expect(out!.how).toMatch(/^flat-key \(kept \d+%\)$/);
    expect(out!.clean).toBe(true);
    // The expensive rung must not fire when the cheap one worked — this is the
    // assertion that keeps rung 3 from quietly costing $0.04 on every import.
    expect(state.calls).toBe(0);
  });

  it("rung 3: a near-white garment is rescued by the contrast retry", async () => {
    // The real failure this rung exists for: the garment is almost the same tone
    // as the light-grey backdrop, so the flood fill cannot tell them apart.
    const png = await shot({ bg: "#f2f2f0", fg: "#f0f0ee" });
    // The retry asks for magenta, which no garment can match.
    const contrasted = await shot({ bg: "#ff00ff", fg: "#f0f0ee" });
    const { state, retry } = countingRetry(contrasted);

    const out = await cutoutFromGenerated(png, retry);

    expect(out).not.toBeNull();
    expect(out!.how).toMatch(/^contrast retry, flat-key \(kept \d+%\)$/);
    expect(out!.clean).toBe(true);
    expect(state.calls).toBe(1);
  });

  it("rung 3: charges for at most one retry", async () => {
    const png = await shot({ bg: "#f2f2f0", fg: "#f0f0ee" });
    const { state, retry } = countingRetry(await shot({ bg: "#f2f2f0", fg: "#f0f0ee" }));

    await cutoutFromGenerated(png, retry);

    expect(state.calls).toBe(1);
  });

  it("rung 4: accepts a QA-failing cutout with a warning rather than nothing", async () => {
    // Garment fills 69% of the frame — over GENERATED_MAX_OPAQUE (0.6), so this
    // is surviving backdrop by our own framing rule. Keyable, but not clean.
    const png = await shot({ bg: "#f2f2f0", fg: "#303030", garment: 100 });

    const out = await cutoutFromGenerated(png);

    expect(out).not.toBeNull();
    expect(out!.clean).toBe(false);
    expect(out!.how).toContain("QA warning");
    expect(out!.how).toContain("of the frame");
  });

  it("rung 4: prefers the original generation over a failed retry", async () => {
    // Both fail QA. The original is the garment already accepted elsewhere, so a
    // retry may add ground but must never take it away.
    const png = await shot({ bg: "#f2f2f0", fg: "#303030", garment: 100 });
    const contrasted = await shot({ bg: "#ff00ff", fg: "#303030", garment: 110 });
    const { state, retry } = countingRetry(contrasted);

    const out = await cutoutFromGenerated(png, retry);

    expect(state.calls).toBe(1);
    expect(out!.clean).toBe(false);
    // Both keep too much of the frame, so the returned percentage says which one
    // we kept. The 100px garment keys to ~64% (flat-key erodes 2px before
    // measuring), the 110px retry to ~78% — so anything under 70 is the original.
    const kept = Number(out!.how.match(/keeps (\d+)%/)![1]);
    expect(kept).toBeLessThan(70);
  });

  it("returns null when nothing is keyable and there is no retry", async () => {
    // A flat frame with no garment at all: keying removes everything.
    const png = await sharp({
      create: { width: SIZE, height: SIZE, channels: 3, background: "#f2f2f0" },
    })
      .png()
      .toBuffer();

    expect(await cutoutFromGenerated(png)).toBeNull();
  });

  it("survives a retry that declines", async () => {
    const png = await shot({ bg: "#f2f2f0", fg: "#f0f0ee" });
    const { state, retry } = countingRetry(null);

    // No throw, and no cutout invented out of nothing.
    const out = await cutoutFromGenerated(png, retry);

    expect(state.calls).toBe(1);
    expect(out).toBeNull();
  });
});
