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
  ConfirmDialog,
  Field,
  PageTitle,
  SectionLabel,
  SegmentedControl,
  Skeleton,
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
      className="card group relative aspect-square w-full select-none overflow-hidden"
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
                "absolute top-1/2 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full",
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
    <div className="rounded-[2px] border border-line">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center justify-between px-4 py-3 text-meta text-muted transition-colors hover:text-fg"
      >
        Regenerate images
        <span className={clsx("transition-transform duration-200", open && "rotate-45")}>+</span>
      </button>

      {open ? (
        <div className="fade-in flex flex-col gap-4 border-t border-line p-4">
          <SegmentedControl
            options={REGEN_SIDE_OPTIONS.filter((o) => hasBack || o.value === "front")}
            value={hasBack ? choice : "front"}
            onChange={setChoice}
          />
          {!hasBack ? (
            <p className="text-micro text-faint">
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
            <span className="text-micro text-faint">
              {running
                ? job?.status === "queued"
                  ? "Queued…"
                  : "Generating — this takes 15-40s"
                : "Replaces the current images"}
            </span>
            <Button variant="solid" loading={running} onClick={() => start.mutate()}>
              {`Regenerate · ~$${(sides.length * COST_PER_SIDE).toFixed(2)}`}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

const STATUS_OPTIONS = [
  { value: "available", label: "Available" },
  { value: "laundry", label: "Laundry" },
  { value: "unavailable", label: "Unavailable" },
] as const;

/**
 * The editable fields, in one place, so the form's initial values and its
 * dirty-check can never drift apart. Everything is a string because that is
 * what an <input> holds; `save` converts back at the boundary.
 */
function formValues(item: Item): Record<string, string> {
  return {
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
  };
}

function ItemSkeleton() {
  return (
    <div>
      <Skeleton className="mb-3 h-3 w-16" />
      <Skeleton className="mb-10 h-10 w-80" />
      <div className="grid gap-10 lg:grid-cols-[minmax(300px,440px)_1fr]">
        <div className="flex flex-col gap-5">
          <Skeleton className="aspect-square w-full" />
          <Skeleton className="h-8 w-64" />
          <Skeleton className="h-10 w-48" />
        </div>
        <div className="flex max-w-2xl flex-col gap-8">
          {Array.from({ length: 4 }, (_, group) => (
            <div key={group} className="flex flex-col gap-4">
              <Skeleton className="h-4 w-24" />
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                {Array.from({ length: 2 }, (_, f) => (
                  <Skeleton key={f} className="h-16 w-full" />
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

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
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [archiving, setArchiving] = useState(false);

  useEffect(() => {
    if (!item) return;
    setForm(formValues(item));
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

  const confirmImport = useMutation({
    mutationFn: () => apiSend(`/api/items/${id}/confirm`, "POST"),
    onSuccess: () => {
      toast("info", "Added to wardrobe");
      qc.invalidateQueries();
    },
  });

  if (isLoading || !item) return <ItemSkeleton />;

  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  /*
   * Unsaved changes. Save used to sit at the bottom of a 14-field column with
   * nothing anywhere saying the form had been touched — you could edit the
   * colour at the top, navigate away, and lose it silently.
   */
  const saved = formValues(item);
  const dirty = Object.keys(saved).some((k) => (form[k] ?? "") !== saved[k]);
  const src = (field: string) => item.fieldSources[field] as "ai" | "user" | undefined;

  return (
    <div className={dirty ? "pb-24" : undefined}>
      <PageTitle eyebrow={item.state === "draft" ? "Draft — review and confirm" : "Item"}>
        {itemLabel(item)}
      </PageTitle>

      {dupes && (dupes.exact.length > 0 || dupes.similar.length > 0) ? (
        <div className="mb-8 max-w-2xl rounded-[2px] border-l-2 border-danger bg-surface py-3 pl-4 pr-3">
          <div className="text-meta font-medium text-danger">Possible duplicate</div>
          <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-meta text-muted">
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

      <div className="grid gap-10 lg:grid-cols-[minmax(300px,440px)_1fr]">
        {/*
         * Sticky on desktop. The photo used to scroll away while you worked
         * through 14 fields, leaving the left half of a 1440px page empty and
         * the garment — the thing you are describing — off screen.
         */}
        <div className="flex flex-col gap-5 lg:sticky lg:top-8 lg:self-start">
          {/*
           * Studio regenerations first, raw photos last (Dinesh, 2026-07-26:
           * "the first two photos should be regen ones, then the og") — see
           * orderedPhotos() in ui.tsx for the exact fallback chain per slot.
           */}
          <RotatingPhotos name={itemLabel(item)} images={orderedPhotos(item)} />
          {item.images.length === 0 ? (
            <div className="well flex aspect-square items-center justify-center text-meta text-faint">
              No photos
            </div>
          ) : null}

          <div className="flex items-center justify-between gap-3">
            <SegmentedControl
              options={STATUS_OPTIONS}
              value={item.status}
              onChange={(s) =>
                patch.mutate({ status: s }, { onSuccess: () => toast("info", `Marked ${s}`) })
              }
            />
            <span className="shrink-0 text-meta tabular-nums text-muted">
              Worn {item.wearCount}×
              {item.lastWornAt ? ` · ${item.lastWornAt.slice(0, 10)}` : ""}
            </span>
          </div>

          <div className="flex flex-wrap gap-2">
            <Button onClick={() => wearToday.mutate()} loading={wearToday.isPending}>
              Wore it today
            </Button>
            {item.state === "draft" ? (
              <Button
                variant="solid"
                onClick={() => confirmImport.mutate()}
                loading={confirmImport.isPending}
              >
                Confirm import
              </Button>
            ) : null}
          </div>

          <RegenPanel item={item} />
        </div>

        <div className="flex max-w-2xl flex-col gap-8">
          <div className="flex flex-col gap-4">
            <SectionLabel>Category</SectionLabel>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="Category" source={src("category")}>
                <select className={inputClass} value={form.category ?? ""} onChange={set("category")}>
                  <option value="">—</option>
                  {CATEGORIES.map((c) => <option key={c} value={c}>{c.replace("_", " ")}</option>)}
                </select>
              </Field>
              <Field label="Subcategory" source={src("subcategory")}>
                <input className={inputClass} value={form.subcategory ?? ""} onChange={set("subcategory")} />
              </Field>
              <Field label="Formality" source={src("formality")}>
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
              <Field label="Primary color" source={src("primaryColor")}>
                <input className={inputClass} value={form.primaryColor ?? ""} onChange={set("primaryColor")} />
              </Field>
              <Field label="Color detail" source={src("colorDetail")}>
                <input className={inputClass} value={form.colorDetail ?? ""} onChange={set("colorDetail")} />
              </Field>
              <Field label="Pattern" source={src("pattern")}>
                <input className={inputClass} value={form.pattern ?? ""} onChange={set("pattern")} />
              </Field>
            </div>
          </div>

          <div className="flex flex-col gap-4">
            <SectionLabel>Details</SectionLabel>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="Fit" source={src("fit")}>
                <input className={inputClass} value={form.fit ?? ""} onChange={set("fit")} />
              </Field>
              <Field label="Material" source={src("material")}>
                <input className={inputClass} value={form.material ?? ""} onChange={set("material")} />
              </Field>
              <Field label="Brand" source={src("brand")}>
                <input className={inputClass} value={form.brand ?? ""} onChange={set("brand")} />
              </Field>
              <Field label="Size" source={src("size")}>
                <input className={inputClass} value={form.size ?? ""} onChange={set("size")} />
              </Field>
              <Field label="Price" source={src("price")}>
                <input className={inputClass} type="number" value={form.price ?? ""} onChange={set("price")} />
              </Field>
              <Field label="Name" source={src("name")} hint="not shown on screen">
                <input className={inputClass} value={form.name ?? ""} onChange={set("name")} />
              </Field>
            </div>
          </div>

          <div className="flex flex-col gap-4">
            <SectionLabel>Notes</SectionLabel>
            <Field label="Description" source={src("description")}>
              <textarea className={`${inputClass} min-h-20`} value={form.description ?? ""} onChange={set("description")} />
            </Field>
            <Field label="Your notes" hint="private, never touched by AI">
              <textarea className={`${inputClass} min-h-16`} value={form.notes ?? ""} onChange={set("notes")} />
            </Field>
          </div>

          <div className="flex flex-col gap-4">
            <SectionLabel>Tags</SectionLabel>
            <div>
              <div className="mb-2 flex flex-wrap gap-2">
                {item.tags.map((t) => (
                  <button
                    key={t.tag}
                    onClick={() => patch.mutate({ removeTag: t.tag })}
                    title="Click to remove"
                    className="rounded-[2px] border border-line px-2 py-0.5 text-meta text-muted transition-colors hover:border-danger hover:text-danger"
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

          {wearData?.events.length ? (
            <div className="border-t border-line pt-5">
              <SectionLabel className="mb-2">Wear history</SectionLabel>
              <ul className="flex flex-col gap-1 text-meta text-muted">
                {wearData.events.slice(0, 10).map((e) => (
                  <li key={e.id} className="tabular-nums">
                    {e.wornOn}
                    {e.occasion ? ` — ${e.occasion}` : ""}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <div className="border-t border-line pt-5">
            <Button variant="danger" onClick={() => setConfirmArchive(true)}>
              Archive
            </Button>
          </div>
        </div>
      </div>

      {/*
       * The save bar rides in only when something has changed, and clears the
       * desktop sidebar rather than sitting on top of it.
       */}
      {dirty ? (
        <div className="toast-in fixed inset-x-0 bottom-0 z-30 border-t border-line bg-bg/95 backdrop-blur-sm md:left-52">
          <div className="flex items-center justify-between gap-4 px-4 py-3 md:px-14">
            <span className="text-meta text-muted">Unsaved changes</span>
            <div className="flex gap-2">
              <Button variant="ghost" onClick={() => setForm(saved)}>
                Discard
              </Button>
              <Button variant="solid" onClick={save} loading={patch.isPending}>
                Save changes
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      <ConfirmDialog
        open={confirmArchive}
        danger
        busy={archiving}
        title="Archive this item?"
        body="It disappears from the catalog and from outfit suggestions. The photos and wear history are kept."
        confirmLabel="Archive"
        onCancel={() => setConfirmArchive(false)}
        onConfirm={async () => {
          setArchiving(true);
          try {
            await apiSend(`/api/items/${id}`, "DELETE");
            router.push("/wardrobe");
          } catch (e) {
            toast("error", e instanceof Error ? e.message : "Could not archive");
            setArchiving(false);
            setConfirmArchive(false);
          }
        }}
      />
    </div>
  );
}
