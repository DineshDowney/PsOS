import { describe, it, expect } from "vitest";
import { stageProgress, STAGES } from "./import-progress";
import type { ImportJob, ImportStage, StageInfo } from "@/shared/types";

/**
 * The Import screen's only real logic. It matters because pipeline stages
 * DEGRADE rather than abort — a job can carry a failed stage and still be
 * usefully working, so the precedence between "failed" and "currently doing X"
 * decides whether a recoverable hiccup makes a live import look dead.
 */
/**
 * `stages` is a full Record in the type but a sparse object in practice: a job
 * created before a stage existed simply has no entry for it, which is exactly
 * the case `stageProgress` has to tolerate. The cast keeps the fixture sparse
 * on purpose rather than papering over it with seven "pending" entries.
 */
function job(
  stages: Partial<Record<ImportStage, StageInfo["status"] | StageInfo>>,
  status: ImportJob["status"] = "running",
): ImportJob {
  const filled: Partial<Record<ImportStage, StageInfo>> = {};
  for (const [k, v] of Object.entries(stages)) {
    filled[k as ImportStage] = typeof v === "string" ? { status: v } : v;
  }
  return {
    id: "job-1",
    itemId: "item-1",
    status,
    stages: filled as Record<ImportStage, StageInfo>,
    error: null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

describe("stageProgress", () => {
  it("names the stage that is running", () => {
    const p = stageProgress(job({ save: "done", garment_box: "running" }));
    expect(p.caption).toBe("Locating the garment");
    expect(p.failed).toBe(false);
  });

  it("counts only completed stages", () => {
    const p = stageProgress(job({ save: "done", garment_box: "done", colors: "running" }));
    expect(p.done).toBe(2);
  });

  it("keeps reporting live work even when an earlier stage failed", () => {
    // The load-bearing case. background_removal degrading must not make a job
    // that is actively writing metadata look dead.
    const p = stageProgress(
      job({ save: "done", background_removal: "failed", ai_metadata: "running" }),
    );
    expect(p.caption).toBe("Writing metadata");
    expect(p.failed).toBe(false);
  });

  it("reports the failure once nothing is running", () => {
    const p = stageProgress(
      job({ save: "done", image_generation: { status: "failed", error: "quota exhausted" } }),
    );
    expect(p.caption).toBe("Studio shot failed — quota exhausted");
    expect(p.failed).toBe(true);
  });

  it("still surfaces a degraded stage after the job is reviewable", () => {
    // Reaching review with a failed stage is normal — it is why a field is
    // blank — so the reason has to survive to the end.
    const p = stageProgress(
      job({ save: "done", ai_metadata: "failed" }, "ready_for_review"),
    );
    expect(p.caption).toBe("Ready for review — Writing metadata failed");
    expect(p.failed).toBe(true);
  });

  it("says ready plainly when every stage behaved", () => {
    const all = Object.fromEntries(STAGES.map((s) => [s, "done" as const]));
    const p = stageProgress(job(all, "ready_for_review"));
    expect(p.caption).toBe("Ready for review");
    expect(p.done).toBe(STAGES.length);
    expect(p.failed).toBe(false);
  });

  it("distinguishes queued from working", () => {
    expect(stageProgress(job({}, "queued")).caption).toBe("Queued");
    expect(stageProgress(job({}, "running")).caption).toBe("Working…");
  });

  it("falls back to the job-level error when no stage owns the failure", () => {
    const j = job({}, "failed");
    j.error = "disk full";
    expect(stageProgress(j).caption).toBe("Import failed — disk full");
  });
});
