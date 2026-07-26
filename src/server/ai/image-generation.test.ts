import { describe, expect, it } from "vitest";
import { PROMPT_BASE, buildPrompt } from "./image-generation";

describe("buildPrompt", () => {
  /**
   * The whole safety argument for making the prompt context-aware: the import
   * pipeline's first generation passes nothing and must keep sending exactly
   * the prompt that produced the current wardrobe. If this breaks, every new
   * import silently changes behaviour.
   */
  it("is byte-identical to the base prompt with no context", () => {
    expect(buildPrompt()).toBe(PROMPT_BASE);
    expect(buildPrompt({})).toBe(PROMPT_BASE);
    expect(buildPrompt({ facts: [], feedback: "" })).toBe(PROMPT_BASE);
  });

  it("treats whitespace-only feedback as absent", () => {
    expect(buildPrompt({ feedback: "   \n  " })).toBe(PROMPT_BASE);
  });

  it("appends facts as a bulleted section, keeping the base intact", () => {
    const prompt = buildPrompt({ facts: ["Colour: Oatmeal", "Pattern: solid"] });
    expect(prompt.startsWith(PROMPT_BASE)).toBe(true);
    expect(prompt).toContain("KNOWN FACTS");
    expect(prompt).toContain("- Colour: Oatmeal");
    expect(prompt).toContain("- Pattern: solid");
  });

  it("appends feedback verbatim", () => {
    const prompt = buildPrompt({ feedback: "the back is a different shirt" });
    expect(prompt.startsWith(PROMPT_BASE)).toBe(true);
    expect(prompt).toContain("REQUIRED FIX");
    expect(prompt).toContain("the back is a different shirt");
  });

  it("includes both sections when both are given", () => {
    const prompt = buildPrompt({ facts: ["Fit: regular"], feedback: "too baggy" });
    expect(prompt).toContain("- Fit: regular");
    expect(prompt).toContain("too baggy");
    // Feedback last: it is the override, so it should be the final word.
    expect(prompt.indexOf("KNOWN FACTS")).toBeLessThan(prompt.indexOf("REQUIRED FIX"));
  });
});
