/**
 * What to say about an import job's progress, in one sentence.
 *
 * Pure and separate from the component because the ordering rules here are the
 * only real logic on the Import screen, and they are easy to get subtly wrong:
 * a job can have a FAILED stage and still be running a later one (stages
 * degrade rather than abort), so "failed" must not win over "currently doing
 * X" — otherwise a recoverable hiccup makes a working import look dead.
 */
import type { ImportJob, ImportStage } from "@/shared/types";

/** Pipeline order. The rail reads left to right in exactly this order. */
export const STAGES: ImportStage[] = [
  "save",
  "garment_box",
  "image_generation",
  "background_removal",
  "colors",
  "ai_metadata",
  "thumbnail",
];

export const STAGE_LABELS: Record<ImportStage, string> = {
  save: "Saving photos",
  garment_box: "Locating the garment",
  image_generation: "Studio shot",
  background_removal: "Cutting out",
  colors: "Reading colours",
  ai_metadata: "Writing metadata",
  thumbnail: "Thumbnail",
};

export interface StageProgress {
  caption: string;
  /** Stages finished successfully, for the "3/7" readout. */
  done: number;
  /** Whether the caption is reporting a failure, so the caller can colour it. */
  failed: boolean;
}

export function stageProgress(job: ImportJob): StageProgress {
  const running = STAGES.find((s) => job.stages[s]?.status === "running");
  const firstFailed = STAGES.find((s) => job.stages[s]?.status === "failed");
  const done = STAGES.filter((s) => job.stages[s]?.status === "done").length;

  if (job.status === "ready_for_review") {
    // A degraded stage still matters at the end — it is why a field is empty.
    return firstFailed
      ? { caption: `Ready for review — ${STAGE_LABELS[firstFailed]} failed`, done, failed: true }
      : { caption: "Ready for review", done, failed: false };
  }

  if (running) return { caption: STAGE_LABELS[running], done, failed: false };

  if (job.status === "failed" || (firstFailed && job.status !== "queued")) {
    const stage = firstFailed ? STAGE_LABELS[firstFailed] : "Import";
    const detail = firstFailed ? job.stages[firstFailed]?.error : job.error;
    return { caption: `${stage} failed${detail ? ` — ${detail}` : ""}`, done, failed: true };
  }

  if (job.status === "queued") return { caption: "Queued", done, failed: false };
  return { caption: "Working…", done, failed: false };
}
