import { describe, expect, it } from "vitest";
import { targetSize, MAX_EDGE } from "./downscale";

describe("targetSize", () => {
  it("leaves an image that already fits alone", () => {
    expect(targetSize(2000, 1500)).toBeNull();
    expect(targetSize(MAX_EDGE, 1000)).toBeNull();
  });

  it("scales a landscape photo by its long edge", () => {
    // A typical 12MP phone photo.
    expect(targetSize(4000, 3000)).toEqual({ width: 3000, height: 2250 });
  });

  it("scales a portrait photo by its long edge", () => {
    expect(targetSize(3000, 4000)).toEqual({ width: 2250, height: 3000 });
  });

  it("rounds rather than floors, so the aspect ratio holds", () => {
    // 4032x3024 is the real iPhone/OnePlus sensor size. Flooring gives 2249 on
    // the short edge; rounding gives 2250 and keeps 4:3 exact.
    expect(targetSize(4032, 3024)).toEqual({ width: 3000, height: 2250 });
  });

  it("honours a custom max edge", () => {
    expect(targetSize(4000, 2000, 1000)).toEqual({ width: 1000, height: 500 });
  });

  it("never returns a zero dimension for an extreme aspect ratio", () => {
    const size = targetSize(30000, 3, 3000);
    expect(size).toEqual({ width: 3000, height: 1 });
  });

  it("refuses nonsense dimensions instead of producing NaN", () => {
    expect(targetSize(0, 100)).toBeNull();
    expect(targetSize(100, -1)).toBeNull();
    expect(targetSize(Number.NaN, 100)).toBeNull();
    expect(targetSize(Number.POSITIVE_INFINITY, 100)).toBeNull();
  });
});
