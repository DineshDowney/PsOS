"use client";

import { use, useEffect, useRef, useState } from "react";
import Link from "next/link";
import clsx from "clsx";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiGet, apiSend } from "@/lib/api";
import {
  CATEGORIES, FORMALITIES,
  type Item, type RegenJob, type RegenSide, type WearEvent,
} from "@/shared/types";
import {
  Button,
  Field,
  PageTitle,
  SectionLabel,
  SegmentedControl,
  Spinner,
  StatusBadge,
  inputClass,
  garmentShadowClass,
  itemLabel,
  orderedPhotos,
} from "@/components/ui";
import { useToast } from "@/components/providers";

/** Horizontal px of swipe before it counts as a deliberate gesture, not a tap. */
const SWIPE_THRESHOLD_PX = 40;

/**
 * One square frame that crossfades between the garment shots.
 *
 * Four ways to drive one index: the auto-cycle, arrow buttons, swipe, and the
 * dots. Any MANUAL navigation stops the auto-cycle permanently — a carousel
 * that yanks itself forward a second after you deliberately chose a photo is
 * the single most irritating thing this component could do.
 */
function RotatingPhotos({ images, name }: { images: Item["images"]; name: string }) {
  const [index, setIndex] = useState(0);
  const [manual, setManual] = useState(false);
  const touchStartX = useRef<number | null>(null);
  const count = images.length;

  useEffect(() => {
    if (count < 2 || manual) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const t = setInterval(() => setIndex((i) => (i + 1) % count), 4000);
    return () => clearInterval(t);
  }, [count, manual]);

  // Clamp if the photo list shrinks under us (a regen can change how many
  // slots exist), so the frame never goes blank on a stale index.
  useEffect(() => {
    setIndex((i) => (i < count ? i : 0));
  }, [count]);

  const go = (delta: number) => {
    setManual(true);
    setIndex((i) => (i + delta + count) % count);
  };

  if (count === 0) return null;
  const many = count > 1;

  return (
    <div
      className="group relative aspect-square w-full select-none bg-surface"
      onTouchStart={(e) => {
        touchStartX.current = e.touches[0]?.clientX ?? null;
      }}
      onTouchEnd={(e) => {
        const start = touchStartX.current;
        touchStartX.current = null;
        if (start === null || !many) return;
        const dx = (e.changedTouches[0]?.clientX ?? start) - start;
        if (Math.abs(dx) < SWIPE_THRESHOLD_PX) return;
        go(dx < 0 ? 1 : -1); // drag left = next
      }}
    >
      {images.map((img, i) => (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          key={img.id}
          src={img.url}
          alt={`${name} ${img.role}`}
          className={clsx(
            "absolute inset-0 h-full w-full object-contain transition-opacity duration-700",
            i === index ? "opacity-100" : "opacity-0",
            garmentShadowClass(img.url),
          )}
        />
      ))}

      {many ? (
        <>
          {/* Always visible on touch (no hover to reveal them); fade in on pointer devices. */}
          {([
            { dir: -1, side: "left", glyph: "‹", label: "Previous photo" },
            { dir: 1, side: "right", glyph: "›", label: "Next photo" },
          ] as const).map(({ dir, side, glyph, label }) => (
            <button
              key={side}
              type="button"
              aria-label={label}
              onClick={() => go(dir)}
              className={clsx(
                "absolute top-1/2 flex h-9 w-9 -translate-y-1/2 items-center justify-center",
                "border border-line bg-bg/80 text-lg leading-none text-muted backdrop-blur-sm",
                "transition-[opacity,color,border-color] duration-200 hover:border-fg hover:text-fg",
                "active:scale-95 md:opacity-0 md:group-hover:opacity-100 md:focus-visible:opacity-100",
                side === "left" ? "left-2" : "right-2",
              )}
            >
              {glyph}
            </button>
          ))}

          <div className="absolute bottom-2 left-1/2 flex -translate-x-1/2 gap-1.5">
            {images.map((img, i) => (
              <button
                key={img.id}
                type="button"
                aria-label={`Photo ${i + 1}`}
                onClick={() => {
                  setManual(true);
                  setIndex(i);
                }}
                className={clsx(
                  "h-1.5 w-1.5 rounded-full transition-[transform,background-color] duration-200",
                  i === index ? "scale-125 bg-fg" : "bg-line hover:bg-muted",
                )}
              />
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}

/** Gemini flash-image list price, for the inline estimate on the button. */
const COST_PER_SIDE = 0.04;

const REGEN_SIDE_OPTIONS = [
  { value: "both", label: "Both" },
  { value: "front", label: "Front" },
  { value: "back", label: "Back" },
] as const;

/**
 * Regenerate the studio shots for this item, with the current metadata and a
 * free-text note as grounding.
 *
 * Async by design: a two-sided regen is 15-40s of sequential Gemini calls, so
 * this POSTs a job and polls it rather than holding a request open across the
 * Funnel relay. Navigating away loses the poller, not the job — the new photos
 * are simply there next time the page loads.
 */
function RegenPanel({ item }: { item: Item }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [choice, setChoice] = useState<string>("both");
  const [feedback, setFeedback] = useState("");
  const [jobId, setJobId] = useState<string | null>(null);

  const sides: RegenSide[] = choice === "both" ? ["front", "back"] : [choice as RegenSide];
  const hasBack = item.images.some((i) => i.role === "back" || i.role === "back_cropped");

  const start = useMutation({
    mutationFn: () =>
      apiSend<{ job: RegenJob }>(`/api/items/${item.id}/regenerate`, "POST", {
        sides,
        feedback: feedback.trim() || undefined,
      }),
    onSuccess: ({ job }) => setJobId(job.id),
  });

  const { data: jobData } = useQuery({
    queryKey: ["regen-job", jobId],
    queryFn: () => apiGet<{ job: RegenJob }>(`/api/regen-jobs/${jobId}`),
    enabled: Boolean(jobId),
    refetchInterval: (query) => {
      const s = query.state.data?.job.status;
      return s === "queued" || s === "running" ? 2000 : false;
    },
  });

  const job = jobData?.job;
  const running = Boolean(jobId) && (job?.status === "queued" || job?.status === "running" || start.isPending);

  // Report once when the job settles, then refresh the photos.
  const settledRef = useRef<string | null>(null);
  useEffect(() => {
    if (!job || (job.status !== "done" && job.status !== "failed")) return;
    if (settledRef.current === job.id) return;
    settledRef.current = job.id;

    if (job.status === "failed") {
      toast("error", job.error ?? "Regeneration failed");
    } else {
      const failures = sides.filter((s) => job.results[s] && !job.results[s]!.ok);
      if (failures.length === sides.length) {
        toast("error", job.results[failures[0]!]?.error ?? "Regeneration produced nothing");
      } else if (failures.length > 0) {
        toast("error", `${failures.join(" and ")} failed — the rest was updated`);
      } else {
        toast("info", `Regenerated ${sides.join(" and ")}`);
        setFeedback("");
      }
    }
    setJobId(null);
    void qc.invalidateQueries({ queryKey: ["item", item.id] });
    void qc.invalidateQueries({ queryKey: ["items"] });
  }, [job, sides, toast, qc, item.id]);

  return (
    <div className="border border-line">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between px-4 py-3 text-[10px] uppercase tracking-[0.08em] text-muted transition-colors hover:text-fg"
      >
        Regenerate images
        <span className={clsx("transition-transform duration-200", open && "rotate-45")}>+</span>
      </button>

      {open ? (
        <div className="flex flex-col gap-4 border-t border-line p-4">
          <SegmentedControl
            options={REGEN_SIDE_OPTIONS.filter((o) => hasBack || o.value === "front")}
            value={hasBack ? choice : "front"}
            onChange={setChoice}
          />
          {!hasBack ? (
            <p className="text-[10px] text-faint">
              No back photo on file — only the front can be regenerated.
            </p>
          ) : null}

          <Field label="What was wrong?" hint="optional">
            <textarea
              className={`${inputClass} min-h-20`}
              placeholder="e.g. the back came out as a different shirt — it should have the same print as the front"
              value={feedback}
              onChange={(e) => setFeedback(e.target.value)}
            />
          </Field>

          <div className="flex items-center justify-between gap-3">
            <span className="text-[10px] uppercase tracking-[0.08em] text-faint">
              {running
                ? job?.status === "queued"
                  ? "Queued…"
                  : "Generating — this takes 15-40s"
                : "Replaces the current images"}
            </span>
            <Button
              variant="solid"
              disabled={running}
              onClick={() => start.mutate()}
            >
              {running
                ? "Working…"
                : `Regenerate · ~$${(sides.length * COST_PER_SIDE).toFixed(2)}`}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function Provenance({ item, field }: { item: Item; field: string }) {
  const src = item.fieldSources[field];
  if (!src) return null;
  return (
    <span className={`ml-2 text-[9px] uppercase tracking-[0.08em] ${src === "user" ? "text-ok" : "text-faint"}`}>
      {src}
    </span>
  );
}

const STATUS_OPTIONS = [
  { value: "available", label: "Available" },
  { value: "laundry", label: "Laundry" },
  { value: "unavailable", label: "Unavailable" },
] as const;

export default function ItemPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const toast = useToast();
  const qc = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ["item", id],
    queryFn: () => apiGet<{ item: Item }>(`/api/items/${id}`),
  });
  const { data: wearData } = useQuery({
    queryKey: ["wear", id],
    queryFn: () => apiGet<{ events: WearEvent[] }>(`/api/wear?itemId=${id}`),
  });
  const { data: dupes } = useQuery({
    queryKey: ["duplicates", id],
    queryFn: () =>
      apiGet<{ exact: Item[]; similar: Array<{ item: Item; distance: number }> }>(
        `/api/items/${id}/duplicates`,
      ),
  });

  const item = data?.item;
  const [form, setForm] = useState<Record<string, string>>({});
  const [tagInput, setTagInput] = useState("");

  useEffect(() => {
    if (!item) return;
    setForm({
      name: item.name ?? "",
      category: item.category ?? "",
      subcategory: item.subcategory ?? "",
      description: item.description ?? "",
      notes: item.notes ?? "",
      primaryColor: item.primaryColor ?? "",
      colorDetail: item.colorDetail ?? "",
      pattern: item.pattern ?? "",
      fit: item.fit ?? "",
      material: item.material ?? "",
      brand: item.brand ?? "",
      size: item.size ?? "",
      formality: item.formality ?? "",
      price: item.price != null ? String(item.price) : "",
    });
  }, [item]);

  const patch = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      apiSend<{ item: Item }>(`/api/items/${id}`, "PATCH", body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["item", id] });
      qc.invalidateQueries({ queryKey: ["items"] });
    },
  });

  const save = () => {
    patch.mutate(
      {
        name: form.name,
        category: form.category || null,
        subcategory: form.subcategory || null,
        description: form.description || null,
        notes: form.notes || null,
        primaryColor: form.primaryColor || null,
        colorDetail: form.colorDetail || null,
        pattern: form.pattern || null,
        fit: form.fit || null,
        material: form.material || null,
        brand: form.brand || null,
        size: form.size || null,
        formality: form.formality || null,
        price: form.price ? Number(form.price) : null,
      },
      { onSuccess: () => toast("info", "Saved") },
    );
  };

  const wearToday = useMutation({
    mutationFn: () =>
      apiSend(`/api/wear`, "POST", {
        itemIds: [id],
        wornOn: new Date().toLocaleDateString("sv-SE"),
      }),
    onSuccess: () => {
      toast("info", "Wear logged");
      qc.invalidateQueries({ queryKey: ["item", id] });
      qc.invalidateQueries({ queryKey: ["wear", id] });
    },
  });

  if (isLoading || !item) return <Spinner label="Loading" />;

  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  return (
    <div>
      <PageTitle eyebrow={item.state === "draft" ? "Draft — review and confirm" : "Item"}>
        {itemLabel(item)}
      </PageTitle>

      {dupes && (dupes.exact.length > 0 || dupes.similar.length > 0) ? (
        <div className="mb-8 max-w-2xl border-l-2 border-danger pl-4 text-xs">
          <SectionLabel className="text-danger">possible duplicate</SectionLabel>
          <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-muted">
            {dupes.exact.map((d) => (
              <Link
                key={d.id}
                href={`/items/${d.id}`}
                title={d.name || undefined}
                className="underline hover:text-fg"
              >
                {itemLabel(d)} — identical photo
              </Link>
            ))}
            {dupes.similar.map((s) => (
              <Link
                key={s.item.id}
                href={`/items/${s.item.id}`}
                title={s.item.name || undefined}
                className="underline hover:text-fg"
              >
                {itemLabel(s.item)} — very similar photo
              </Link>
            ))}
          </div>
        </div>
      ) : null}

      {/* 420 -> 480: "make the item image bigger" applied here too, not just the grid */}
      <div className="grid gap-10 lg:grid-cols-[minmax(300px,480px)_1fr]">
        <div className="flex flex-col gap-5">
          {/*
           * Studio regenerations first, raw photos last (Dinesh, 2026-07-26:
           * "the first two photos should be regen ones, then the og") — see
           * orderedPhotos() in ui.tsx for the exact fallback chain per slot.
           */}
          <RotatingPhotos name={itemLabel(item)} images={orderedPhotos(item)} />
          {item.images.length === 0 ? (
            <div className="flex aspect-square items-center justify-center text-faint">
              no photos
            </div>
          ) : null}

          <div className="flex flex-wrap items-center gap-3">
            <StatusBadge status={item.status} />
            <span className="text-xs text-muted">
              worn {item.wearCount}× {item.lastWornAt ? `· last ${item.lastWornAt.slice(0, 10)}` : ""}
            </span>
          </div>
          <SegmentedControl
            options={STATUS_OPTIONS}
            value={item.status}
            onChange={(s) =>
              patch.mutate({ status: s }, { onSuccess: () => toast("info", `Marked ${s}`) })
            }
          />
          <div className="flex gap-2">
            <Button onClick={() => wearToday.mutate()}>Wore it today</Button>
            {item.state === "draft" ? (
              <Button
                variant="solid"
                onClick={async () => {
                  await apiSend(`/api/items/${id}/confirm`, "POST");
                  toast("info", "Added to wardrobe");
                  qc.invalidateQueries();
                }}
              >
                Confirm import
              </Button>
            ) : null}
          </div>

          <RegenPanel item={item} />
        </div>

        <div className="flex max-w-2xl flex-col gap-8">
          <div className="flex flex-col gap-4">
            <SectionLabel>Name</SectionLabel>
            <Field label="Name">
              <span>
                <input className={inputClass} value={form.name ?? ""} onChange={set("name")} />
                <Provenance item={item} field="name" />
              </span>
            </Field>
          </div>

          <div className="flex flex-col gap-4">
            <SectionLabel>Category</SectionLabel>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="Category">
                <select className={inputClass} value={form.category ?? ""} onChange={set("category")}>
                  <option value="">—</option>
                  {CATEGORIES.map((c) => <option key={c} value={c}>{c.replace("_", " ")}</option>)}
                </select>
              </Field>
              <Field label="Subcategory"><input className={inputClass} value={form.subcategory ?? ""} onChange={set("subcategory")} /></Field>
              <Field label="Formality">
                <select className={inputClass} value={form.formality ?? ""} onChange={set("formality")}>
                  <option value="">—</option>
                  {FORMALITIES.map((f) => <option key={f} value={f}>{f.replace("_", " ")}</option>)}
                </select>
              </Field>
            </div>
          </div>

          <div className="flex flex-col gap-4">
            <SectionLabel>Colors</SectionLabel>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="Primary color"><input className={inputClass} value={form.primaryColor ?? ""} onChange={set("primaryColor")} /></Field>
              <Field label="Color detail"><input className={inputClass} value={form.colorDetail ?? ""} onChange={set("colorDetail")} /></Field>
              <Field label="Pattern"><input className={inputClass} value={form.pattern ?? ""} onChange={set("pattern")} /></Field>
            </div>
          </div>

          <div className="flex flex-col gap-4">
            <SectionLabel>Details</SectionLabel>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="Fit"><input className={inputClass} value={form.fit ?? ""} onChange={set("fit")} /></Field>
              <Field label="Material"><input className={inputClass} value={form.material ?? ""} onChange={set("material")} /></Field>
              <Field label="Brand"><input className={inputClass} value={form.brand ?? ""} onChange={set("brand")} /></Field>
              <Field label="Size"><input className={inputClass} value={form.size ?? ""} onChange={set("size")} /></Field>
              <Field label="Price"><input className={inputClass} type="number" value={form.price ?? ""} onChange={set("price")} /></Field>
            </div>
          </div>

          <Field label="Description" hint={item.fieldSources.description === "user" ? "yours" : "AI draft — edits stick"}>
            <textarea className={`${inputClass} min-h-20`} value={form.description ?? ""} onChange={set("description")} />
          </Field>
          <Field label="Notes" hint="private, never touched by AI">
            <textarea className={`${inputClass} min-h-16`} value={form.notes ?? ""} onChange={set("notes")} />
          </Field>

          <div className="flex flex-col gap-4">
            <SectionLabel>Tags</SectionLabel>
            <div>
              <div className="mb-2 flex flex-wrap gap-2">
                {item.tags.map((t) => (
                  <button
                    key={t.tag}
                    onClick={() => patch.mutate({ removeTag: t.tag })}
                    title="click to remove"
                    className="border border-line px-2 py-0.5 text-xs tracking-[0.08em] text-muted hover:border-danger hover:text-danger"
                  >
                    {t.tag} ×
                  </button>
                ))}
              </div>
              <input
                className={inputClass}
                placeholder="Add tag and press Enter"
                value={tagInput}
                onChange={(e) => setTagInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && tagInput.trim()) {
                    patch.mutate({ addTag: tagInput.trim() });
                    setTagInput("");
                  }
                }}
              />
            </div>
          </div>

          <div className="mt-2 flex items-center justify-between border-t border-line pt-5">
            <Button
              variant="danger"
              onClick={async () => {
                if (!confirm("Archive this item? It disappears from the catalog.")) return;
                await apiSend(`/api/items/${id}`, "DELETE");
                router.push("/wardrobe");
              }}
            >
              Archive
            </Button>
            <Button variant="solid" onClick={save} disabled={patch.isPending}>
              {patch.isPending ? "Saving…" : "Save changes"}
            </Button>
          </div>

          {wearData?.events.length ? (
            <div className="border-t border-line pt-4">
              <SectionLabel className="mb-2">Wear history</SectionLabel>
              <ul className="space-y-1 text-sm text-muted">
                {wearData.events.slice(0, 10).map((e) => (
                  <li key={e.id}>{e.wornOn}{e.occasion ? ` — ${e.occasion}` : ""}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
