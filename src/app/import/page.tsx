"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiGet, apiSend } from "@/lib/api";
import type { ImportJob, ImportStage } from "@/shared/types";
import {
  Button, Empty, PageTitle, SectionLabel, garmentShadowClass, itemLabel, itemThumb,
} from "@/components/ui";
import { useToast } from "@/components/providers";
import { useUploadQueue, type UploadItem } from "@/components/upload-queue";

const STAGE_LABELS: Record<ImportStage, string> = {
  save: "Save photos",
  garment_box: "Locate garment",
  image_generation: "Studio shot",
  background_removal: "Cut out",
  colors: "Color analysis",
  ai_metadata: "AI metadata",
  thumbnail: "Thumbnail",
};

function StageRow({ job }: { job: ImportJob }) {
  return (
    <div className="flex flex-wrap gap-x-5 gap-y-1 text-[10px] uppercase tracking-[0.08em]">
      {(Object.keys(STAGE_LABELS) as ImportStage[]).map((stage) => {
        // Jobs created before a stage existed have no entry for it.
        const info = job.stages[stage] ?? { status: "pending" as const };
        const color =
          info.status === "done" ? "text-ok"
          : info.status === "failed" ? "text-danger"
          : info.status === "running" ? "text-accent animate-pulse"
          : info.status === "skipped" ? "text-faint line-through"
          : "text-faint";
        return (
          <span key={stage} className={color} title={info.error}>
            {STAGE_LABELS[stage]}
            {info.status === "failed" ? " ✕" : info.status === "done" ? " ✓" : "…"}
          </span>
        );
      })}
    </div>
  );
}

const UPLOAD_LABELS: Record<UploadItem["status"], string> = {
  waiting: "Queued",
  preparing: "Shrinking photo",
  uploading: "Uploading",
  done: "Sent",
  failed: "Failed",
};

/**
 * One queued garment. This covers the gap the job list cannot: until the bytes
 * land there is no job row on the server to poll, so without this the user has
 * no evidence their photos are going anywhere.
 */
function UploadRow({
  item,
  onRetry,
  onDismiss,
}: {
  item: UploadItem;
  onRetry: (id: string) => void;
  onDismiss: (id: string) => void;
}) {
  const percent = Math.round(item.progress * 100);
  const color =
    item.status === "failed" ? "text-danger" : item.status === "done" ? "text-ok" : "text-accent";

  return (
    <div className="flex flex-col gap-2 py-4 sm:flex-row sm:items-center sm:gap-5">
      <div className="min-w-0 flex-1">
        <div className="mb-1 truncate text-sm">{item.label}</div>
        <div className={`text-[10px] uppercase tracking-[0.08em] ${color}`}>
          {UPLOAD_LABELS[item.status]}
          {item.status === "uploading" ? ` ${percent}%` : ""}
          {item.back ? " · front + back" : " · front only"}
        </div>
        {item.status === "uploading" ? (
          <div className="mt-2 h-px w-full bg-line">
            <div className="h-px bg-accent transition-[width]" style={{ width: `${percent}%` }} />
          </div>
        ) : null}
        {item.error ? <div className="mt-1 text-xs text-danger">{item.error}</div> : null}
      </div>
      {item.status === "failed" ? (
        <div className="flex shrink-0 gap-2">
          <Button onClick={() => onRetry(item.id)}>Retry</Button>
          <Button onClick={() => onDismiss(item.id)}>Discard</Button>
        </div>
      ) : null}
    </div>
  );
}

export default function ImportPage() {
  const toast = useToast();
  const qc = useQueryClient();
  const frontRef = useRef<HTMLInputElement>(null);
  const backRef = useRef<HTMLInputElement>(null);
  const [frontName, setFrontName] = useState("");
  const [backName, setBackName] = useState("");

  const { data } = useQuery({
    queryKey: ["imports"],
    queryFn: () => apiGet<{ jobs: ImportJob[] }>("/api/imports"),
    refetchInterval: (query) =>
      query.state.data?.jobs.some((j) => j.status === "running" || j.status === "queued")
        ? 2000
        : 10000,
  });

  const queue = useUploadQueue();

  /**
   * Hand the photos to the queue and clear the form in the same tick, so the
   * next garment can be staged while these bytes are still going up. The upload
   * used to be awaited here, which held the user for 10-15s over Funnel.
   */
  const start = () => {
    const front = frontRef.current?.files?.[0];
    if (!front) {
      toast("error", "Pick a front photo first");
      return;
    }
    queue.enqueue({ front, back: backRef.current?.files?.[0] ?? null });

    setFrontName("");
    setBackName("");
    if (frontRef.current) frontRef.current.value = "";
    if (backRef.current) backRef.current.value = "";
  };

  const jobs = data?.jobs ?? [];

  return (
    <div>
      <PageTitle sub="Front photo required, back optional. One item per import.">
        Import
      </PageTitle>

      <div className="mb-12 flex max-w-2xl flex-col gap-5">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {(
            [
              ["Front photo", frontRef, frontName, setFrontName],
              ["Back photo (optional)", backRef, backName, setBackName],
            ] as const
          ).map(([label, ref, name, setName]) => (
            <label
              key={label}
              className="flex aspect-video cursor-pointer flex-col items-center justify-center gap-2 border border-dashed border-line text-center hover:border-fg"
            >
              <span className="text-[10px] uppercase tracking-[0.08em] text-muted">{label}</span>
              <span className="max-w-full truncate px-4 text-xs text-fg">{name || "click to choose"}</span>
              <input
                ref={ref}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => setName(e.target.files?.[0]?.name ?? "")}
              />
            </label>
          ))}
        </div>
        <div>
          {/* Never disabled by upload state — that was the whole complaint. */}
          <Button variant="solid" onClick={start} disabled={!frontName}>
            Start import
          </Button>
        </div>
      </div>

      {queue.items.length > 0 ? (
        <>
          <SectionLabel className="mb-4">Uploading</SectionLabel>
          <div className="mb-12 divide-y divide-line">
            {queue.items.map((item) => (
              <UploadRow key={item.id} item={item} onRetry={queue.retry} onDismiss={queue.dismiss} />
            ))}
          </div>
        </>
      ) : null}

      <SectionLabel className="mb-4">In progress & awaiting review</SectionLabel>
      {jobs.length === 0 ? (
        <Empty>No pending imports.</Empty>
      ) : (
        <div className="divide-y divide-line">
          {jobs.map((job) => {
            const thumb = job.item ? itemThumb(job.item) : null;
            return (
              <div key={job.id} className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:gap-5">
                <div className="h-20 w-20 shrink-0 bg-surface">
                  {thumb ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={thumb}
                      alt=""
                      className={`h-full w-full object-contain ${garmentShadowClass(thumb) ?? ""}`}
                    />
                  ) : null}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="mb-1 text-sm text-muted">
                    {job.item ? itemLabel(job.item) : "Processing…"}
                  </div>
                  <StageRow job={job} />
                  {job.error ? <div className="mt-1 text-xs text-danger">{job.error}</div> : null}
                </div>
                <div className="flex shrink-0 gap-2">
                  {job.status === "ready_for_review" && job.item ? (
                    <>
                      <Link href={`/items/${job.item.id}`}>
                        <Button>Review</Button>
                      </Link>
                      <Button
                        variant="solid"
                        onClick={async () => {
                          await apiSend(`/api/items/${job.itemId}/confirm`, "POST");
                          toast("info", "Added to wardrobe");
                          qc.invalidateQueries();
                        }}
                      >
                        Confirm
                      </Button>
                    </>
                  ) : job.status === "failed" ? (
                    <>
                      <span className="text-xs uppercase tracking-[0.08em] text-danger">failed</span>
                      <Button
                        onClick={async () => {
                          try {
                            await apiSend(`/api/imports/${job.id}/retry`, "POST");
                            toast("info", "Retrying from saved photos");
                          } catch (e) {
                            toast("error", e instanceof Error ? e.message : "Retry failed");
                          }
                          qc.invalidateQueries({ queryKey: ["imports"] });
                        }}
                      >
                        Retry
                      </Button>
                    </>
                  ) : job.status === "queued" ? (
                    <span className="text-xs uppercase tracking-[0.08em] text-muted">queued</span>
                  ) : (
                    <span className="text-xs uppercase tracking-[0.08em] text-muted">processing</span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
