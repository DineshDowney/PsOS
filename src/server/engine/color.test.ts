import { describe, it, expect } from "vitest";
import { colorFamily, colorPairScore, outfitColorScore } from "./color";

describe("colorFamily", () => {
  it("normalizes synonyms", () => {
    expect(colorFamily("Off-White")).toBe("white");
    expect(colorFamily("charcoal")).toBe("grey");
    expect(colorFamily("light blue denim")).toBe("denim");
    expect(colorFamily("mustard yellow")).toBe("yellow");
    expect(colorFamily("wine")).toBe("burgundy");
    expect(colorFamily(null)).toBe("unknown");
    expect(colorFamily("chartreuse-ish something")).toBe("unknown");
  });
});

describe("colorPairScore", () => {
  it("neutrals pair with everything", () => {
    expect(colorPairScore("black", "red")).toBe(1.0);
    expect(colorPairScore("beige", "green")).toBe(1.0);
  });
  it("complementary beats awkward middle", () => {
    const complementary = colorPairScore("blue", "orange");
    const awkward = colorPairScore("red", "green"); // 120° apart → middle zone
    expect(complementary).toBeGreaterThan(awkward);
  });
  it("tonal same-family is decent", () => {
    expect(colorPairScore("blue", "blue")).toBe(0.75);
  });
});

describe("outfitColorScore", () => {
  it("all-neutral outfit scores high", () => {
    expect(outfitColorScore(["black", "white", "grey"])).toBe(1.0);
  });
  it("clashing outfit scores lower than harmonious one", () => {
    const clash = outfitColorScore(["red", "green", "purple"]);
    const harmony = outfitColorScore(["navy", "white", "beige"]);
    expect(harmony).toBeGreaterThan(clash);
  });
});
