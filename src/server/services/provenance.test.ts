import { describe, it, expect } from "vitest";
import {
  applyAiInference,
  applyUserEdits,
  emptyEditableFields,
} from "./provenance";

describe("provenance", () => {
  it("user edits flip field source to user", () => {
    const { fields, sources } = applyUserEdits(emptyEditableFields(), {}, {
      name: "Black Tee",
      primaryColor: "black",
    });
    expect(fields.name).toBe("Black Tee");
    expect(sources.name).toBe("user");
    expect(sources.primaryColor).toBe("user");
    expect(sources.category).toBeUndefined();
  });

  it("unchanged values do not flip provenance", () => {
    const base = { ...emptyEditableFields(), name: "Black Tee" };
    const { sources } = applyUserEdits(base, { name: "ai" }, { name: "Black Tee" });
    expect(sources.name).toBe("ai");
  });

  it("AI writes untouched fields but never user-owned fields", () => {
    const base = { ...emptyEditableFields(), name: "My Custom Name" };
    const { fields, sources, skipped } = applyAiInference(
      base,
      { name: "user" },
      { name: "AI Name", material: "cotton" },
    );
    expect(fields.name).toBe("My Custom Name");
    expect(fields.material).toBe("cotton");
    expect(sources.name).toBe("user");
    expect(sources.material).toBe("ai");
    expect(skipped).toEqual(["name"]);
  });

  it("clearing a field is a user edit and AI cannot refill it", () => {
    const base = { ...emptyEditableFields(), material: "cotton" };
    const afterClear = applyUserEdits(base, { material: "ai" }, { material: null });
    expect(afterClear.fields.material).toBeNull();
    expect(afterClear.sources.material).toBe("user");

    const afterAi = applyAiInference(afterClear.fields, afterClear.sources, {
      material: "polyester",
    });
    expect(afterAi.fields.material).toBeNull();
    expect(afterAi.skipped).toContain("material");
  });

  it("AI re-runs update previously AI-written fields", () => {
    const first = applyAiInference(emptyEditableFields(), {}, { fit: "slim" });
    const second = applyAiInference(first.fields, first.sources, { fit: "regular" });
    expect(second.fields.fit).toBe("regular");
    expect(second.sources.fit).toBe("ai");
  });
});
