"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiGet, apiUpload, apiSend } from "@/lib/api";
import type { ImportJob, ImportStage } from "@/shared/types";
import { Button, Empty, PageTitle, itemThumb } from "@/components/ui";
import { useToast } from "@/components/providers";

const STAGE_LABELS: Record<ImportStage, string> = {
  save: "Save photos",
  background_removal: "Remove background",
  thumbnail: "Thumbnail",
  colors: "Color analysis",
  ai_metadata: "AI metadata",
};

function StageRow({ job }: { job: ImportJob }) {
  return (
    <div className="flex flex-wrap gap-x-5 gap-y-1 text-[10px] uppercase tracking-[0.15em]">
      {(Object.keys(STAGE_LABELS) as ImportStage[]).map((stage) => {
        const info = job.stages[stage];
        const color =
          info.status === "done" ? "text-ok"
          : info.status === "failed" ? "text-danger"
          : info.status === "running" ? "text-accent animate-pulse"
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

  const upload = useMutation({
    mutationFn: (form: FormData) => apiUpload<{ job: ImportJob }>("/api/imports", form),
    onSuccess: () => {
      toast("info", "Import started");
      setFrontName("");
      setBackName("");
      if (frontRef.current) frontRef.current.value = "";
      if (backRef.current) backRef.current.value = "";
      qc.invalidateQueries({ queryKey: ["imports"] });
    },
  });

  const start = () => {
    const front = frontRef.current?.files?.[0];
    if (!front) {
      toast("error", "Pick a front photo first");
      return;
    }
    const form = new FormData();
    form.set("front", front);
    const back = backRef.current?.files?.[0];
    if (back) form.set("back", back);
    upload.mutate(form);
  };

  const jobs = data?.jobs ?? [];

  return (
    <div>
      <PageTitle sub="Front photo required, back optional. One item per import.">
        Import
      </PageTitle>

      <div className="mb-12 flex max-w-2xl flex-col gap-4 border border-line bg-surface p-6">
        <div className="grid grid-cols-2 gap-4">
          {(
            [
              ["Front photo", frontRef, frontName, setFrontName],
              ["Back photo (optional)", backRef, backName, setBackName],
            ] as const
          ).map(([label, ref, name, setName]) => (
            <label
              key={label}
              className="flex aspect-video cursor-pointer flex-col items-center justify-center gap-2 border border-dashed border-line text-center hover:border-accent"
            >
              <span className="text-[10px] uppercase tracking-[0.2em] text-muted">{label}</span>
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
          <Button variant="solid" onClick={start} disabled={upload.isPending}>
            {upload.isPending ? "Uploading…" : "Start import"}
          </Button>
        </div>
      </div>

      <h2 className="mb-4 text-[10px] uppercase tracking-[0.25em] text-muted">In progress & awaiting review</h2>
      {jobs.length === 0 ? (
        <Empty>No pending imports.</Empty>
      ) : (
        <div className="flex flex-col gap-4">
          {jobs.map((job) => {
            const thumb = job.item ? itemThumb(job.item) : null;
            return (
              <div key={job.id} className="flex items-center gap-5 border border-line bg-surface p-4">
                <div className="h-20 w-20 shrink-0 border border-line">
                  {thumb ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={thumb} alt="" className="h-full w-full object-contain" />
                  ) : null}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="mb-1 text-sm">{job.item?.name || "Processing…"}</div>
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
                    <span className="text-xs uppercase tracking-[0.2em] text-danger">failed</span>
                  ) : job.status === "queued" ? (
                    <span className="text-xs uppercase tracking-[0.2em] text-muted">queued</span>
                  ) : (
                    <span className="text-xs uppercase tracking-[0.2em] text-accent">processing</span>
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
