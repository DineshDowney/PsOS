"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import clsx from "clsx";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiGet, apiSend } from "@/lib/api";
import type { ImportJob } from "@/shared/types";
import { STAGES, STAGE_LABELS, stageProgress } from "@/lib/import-progress";
import {
  Button, Empty, PageTitle, SectionLabel, garmentShadowClass, itemLabel, itemThumb,
} from "@/components/ui";
import { useToast } from "@/components/providers";
import { useUploadQueue, type UploadItem } from "@/components/upload-queue";

/**
 * Progress through the seven pipeline stages.
 *
 * This used to be seven tiny uppercase words wrapped across a line, each with a
 * "…" or "✓" glued to it — the densest information on the screen rendered in
 * its least legible form. A rail says the same thing at a glance and leaves one
 * plain sentence to name what is happening right now. The sentence's rules live
 * in lib/import-progress.ts, where they can be tested.
 */
function StageRail({ job }: { job: ImportJob }) {
  const { caption, done, failed } = stageProgress(job);

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex gap-1" aria-hidden="true">
        {STAGES.map((stage) => {
          const status = job.stages[stage]?.status ?? "pending";
          return (
            <span
              key={stage}
              title={`${STAGE_LABELS[stage]}${job.stages[stage]?.error ? ` — ${job.stages[stage]!.error}` : ""}`}
              className={clsx(
                "h-1 flex-1 rounded-full transition-colors duration-300",
                status === "done" && "bg-ok/70",
                status === "failed" && "bg-danger",
                status === "running" && "animate-pulse bg-accent",
                status === "skipped" && "bg-line",
                status === "pending" && "bg-surface-2",
              )}
            />
          );
        })}
      </div>
      <div className={clsx("text-meta tabular-nums", failed ? "text-danger" : "text-muted")}>
        {caption}
        {job.status !== "ready_for_review" ? (
          <span className="ml-2 text-faint">
            {done}/{STAGES.length}
          </span>
        ) : null}
      </div>
    </div>
  );
}

const UPLOAD_LABELS: Record<UploadItem["status"], string> = {
  waiting: "Queued",
  preparing: "Shrinking photo",
  uploading: "Uploading",
  done: "Sent",
  failed: "Upload failed",
};

/** Shared row geometry, so a garment crossing upload -> pipeline keeps its place. */
function Row({
  thumb,
  title,
  children,
  actions,
  dimmed = false,
}: {
  thumb: React.ReactNode;
  title: string;
  children: React.ReactNode;
  actions?: React.ReactNode;
  dimmed?: boolean;
}) {
  return (
    <div
      className={clsx(
        "flex flex-col gap-3 py-4 transition-opacity sm:flex-row sm:items-center sm:gap-5",
        dimmed && "opacity-60",
      )}
    >
      <div className="well h-20 w-20 shrink-0 overflow-hidden">{thumb}</div>
      <div className="min-w-0 flex-1">
        <div className="mb-1.5 truncate text-meta capitalize text-fg">{title}</div>
        {children}
      </div>
      {actions ? <div className="flex shrink-0 gap-2">{actions}</div> : null}
    </div>
  );
}

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
  const [preview, setPreview] = useState<string | null>(null);
  useEffect(() => {
    const url = URL.createObjectURL(item.front);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [item.front]);

  return (
    <Row
      dimmed={item.status === "done"}
      title={item.label}
      thumb={
        preview ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={preview} alt="" className="h-full w-full object-cover" />
        ) : null
      }
      actions={
        item.status === "failed" ? (
          <>
            <Button onClick={() => onRetry(item.id)}>Retry</Button>
            <Button variant="ghost" onClick={() => onDismiss(item.id)}>
              Discard
            </Button>
          </>
        ) : undefined
      }
    >
      <div className="flex flex-col gap-1.5">
        <div className="h-1 w-full overflow-hidden rounded-full bg-surface-2">
          <div
            className={clsx(
              "h-1 rounded-full transition-[width] duration-200",
              item.status === "failed" ? "bg-danger" : "bg-accent",
            )}
            style={{ width: item.status === "uploading" ? `${percent}%` : item.status === "waiting" ? "0%" : "100%" }}
          />
        </div>
        <div
          className={clsx(
            "text-meta tabular-nums",
            item.status === "failed" ? "text-danger" : "text-muted",
          )}
        >
          {UPLOAD_LABELS[item.status]}
          {item.status === "uploading" ? ` ${percent}%` : ""}
          <span className="ml-2 text-faint">{item.back ? "front + back" : "front only"}</span>
        </div>
        {item.error ? <div className="text-meta text-danger">{item.error}</div> : null}
      </div>
    </Row>
  );
}

/**
 * One photo slot: click, drop, or paste.
 *
 * It has always LOOKED like a dropzone — dashed border, "click to choose" —
 * while only being a `<label>`, so dragging a photo onto it did nothing and the
 * only feedback after picking one was its filename. Now it takes a drop, takes
 * a paste, and shows the actual photo, which is the only way to catch "that's
 * the wrong shot" before spending a pipeline run on it.
 */
function PhotoSlot({
  label,
  file,
  onPick,
  highlight,
}: {
  label: string;
  file: File | null;
  onPick: (file: File | null) => void;
  highlight: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);

  useEffect(() => {
    if (!file) {
      setPreview(null);
      return;
    }
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        const dropped = Array.from(e.dataTransfer.files).find((f) => f.type.startsWith("image/"));
        if (dropped) onPick(dropped);
      }}
      className={clsx(
        "relative flex aspect-[4/3] cursor-pointer flex-col items-center justify-center gap-2 overflow-hidden rounded-[2px] border border-dashed text-center transition-colors",
        over || highlight ? "border-accent bg-surface" : "border-line hover:border-fg",
      )}
      onClick={() => inputRef.current?.click()}
    >
      {preview ? (
        <>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={preview} alt={label} className="absolute inset-0 h-full w-full object-cover" />
          <button
            type="button"
            aria-label={`Remove ${label}`}
            onClick={(e) => {
              e.stopPropagation();
              onPick(null);
              if (inputRef.current) inputRef.current.value = "";
            }}
            className="absolute right-2 top-2 flex h-7 w-7 items-center justify-center rounded-full border border-line bg-bg/85 text-meta text-muted backdrop-blur-sm transition-colors hover:border-danger hover:text-danger"
          >
            ×
          </button>
          <span className="absolute inset-x-0 bottom-0 truncate bg-bg/85 px-3 py-1 text-micro text-muted backdrop-blur-sm">
            {file?.name}
          </span>
        </>
      ) : (
        <>
          <span className="text-meta text-muted">{label}</span>
          <span className="text-micro text-faint">Click, drop, or paste</span>
        </>
      )}
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => onPick(e.target.files?.[0] ?? null)}
      />
    </div>
  );
}

export default function ImportPage() {
  const toast = useToast();
  const qc = useQueryClient();
  const [front, setFront] = useState<File | null>(null);
  const [back, setBack] = useState<File | null>(null);
  const [pasteFlash, setPasteFlash] = useState<"front" | "back" | null>(null);

  const { data } = useQuery({
    queryKey: ["imports"],
    queryFn: () => apiGet<{ jobs: ImportJob[] }>("/api/imports"),
    refetchInterval: (query) =>
      query.state.data?.jobs.some((j) => j.status === "running" || j.status === "queued")
        ? 2000
        : 10000,
  });

  const queue = useUploadQueue();

  /* Paste fills the first empty slot — front, then back. */
  const onPaste = useCallback(
    (e: ClipboardEvent) => {
      const image = Array.from(e.clipboardData?.files ?? []).find((f) =>
        f.type.startsWith("image/"),
      );
      if (!image) return;
      e.preventDefault();
      if (!front) {
        setFront(image);
        setPasteFlash("front");
      } else if (!back) {
        setBack(image);
        setPasteFlash("back");
      } else {
        toast("info", "Both slots are full — remove one to paste another");
        return;
      }
      setTimeout(() => setPasteFlash(null), 600);
    },
    [front, back, toast],
  );

  useEffect(() => {
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [onPaste]);

  /**
   * Hand the photos to the queue and clear the form in the same tick, so the
   * next garment can be staged while these bytes are still going up. The upload
   * used to be awaited here, which held the user for 10-15s over Funnel.
   */
  const start = () => {
    if (!front) {
      toast("error", "Pick a front photo first");
      return;
    }
    queue.enqueue({ front, back });
    setFront(null);
    setBack(null);
  };

  const jobs = data?.jobs ?? [];
  const nothingHappening = queue.items.length === 0 && jobs.length === 0;

  return (
    <div>
      <PageTitle sub="Front photo required, back optional. One item per import.">
        Import
      </PageTitle>

      <div className="mb-12 flex max-w-2xl flex-col gap-5">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <PhotoSlot
            label="Front photo"
            file={front}
            onPick={setFront}
            highlight={pasteFlash === "front"}
          />
          <PhotoSlot
            label="Back photo (optional)"
            file={back}
            onPick={setBack}
            highlight={pasteFlash === "back"}
          />
        </div>
        <div>
          {/* Never disabled by upload state — that was the whole complaint. */}
          <Button variant="solid" onClick={start} disabled={!front}>
            Start import
          </Button>
        </div>
      </div>

      {/*
       * One timeline. Uploads and pipeline jobs used to be two visually
       * identical lists stacked on top of each other, so a garment finishing its
       * upload appeared to vanish from one and reappear in the other.
       */}
      <SectionLabel className="mb-4">In progress &amp; awaiting review</SectionLabel>
      {nothingHappening ? (
        <div className="max-w-2xl">
          <Empty>Nothing importing right now.</Empty>
        </div>
      ) : (
        <div className="divide-y divide-line">
          {queue.items.map((item) => (
            <UploadRow key={item.id} item={item} onRetry={queue.retry} onDismiss={queue.dismiss} />
          ))}

          {jobs.map((job) => {
            const thumb = job.item ? itemThumb(job.item) : null;
            return (
              <Row
                key={job.id}
                title={job.item ? itemLabel(job.item) : "Processing…"}
                thumb={
                  thumb ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={thumb}
                      alt=""
                      className={`h-full w-full object-contain ${garmentShadowClass(thumb) ?? ""}`}
                    />
                  ) : null
                }
                actions={
                  job.status === "ready_for_review" && job.item ? (
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
                  ) : undefined
                }
              >
                <StageRail job={job} />
                {job.error ? <div className="mt-1 text-meta text-danger">{job.error}</div> : null}
              </Row>
            );
          })}
        </div>
      )}
    </div>
  );
}
