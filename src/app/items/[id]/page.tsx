"use client";

import { use, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiGet, apiSend } from "@/lib/api";
import {
  CATEGORIES, FORMALITIES, type Item, type WearEvent,
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
} from "@/components/ui";
import { useToast } from "@/components/providers";

/**
 * One square frame that crossfades between the garment shots (front/back) on
 * a timer. Click advances immediately. A single photo renders statically.
 */
function RotatingPhotos({ images, name }: { images: Item["images"]; name: string }) {
  const [index, setIndex] = useState(0);
  useEffect(() => {
    if (images.length < 2) return;
    const t = setInterval(() => setIndex((i) => (i + 1) % images.length), 4000);
    return () => clearInterval(t);
  }, [images.length]);

  if (images.length === 0) return null;
  return (
    <div
      className="relative aspect-square w-full cursor-pointer"
      onClick={() => setIndex((i) => (i + 1) % images.length)}
      title={images.length > 1 ? "click to flip" : undefined}
    >
      {images.map((img, i) => (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          key={img.id}
          src={img.url}
          alt={`${name} ${img.role}`}
          className={`absolute inset-0 h-full w-full object-contain transition-opacity duration-700 ${
            i === index ? "opacity-100" : "opacity-0"
          }`}
        />
      ))}
      {images.length > 1 ? (
        <div className="absolute bottom-2 left-1/2 flex -translate-x-1/2 gap-1.5">
          {images.map((img, i) => (
            <span
              key={img.id}
              className={`h-1.5 w-1.5 rounded-full ${i === index ? "bg-fg" : "bg-line"}`}
            />
          ))}
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
      <PageTitle
        eyebrow={item.state === "draft" ? "Draft — review and confirm" : "Item"}
      >
        {item.name || "Untitled"}
      </PageTitle>

      {dupes && (dupes.exact.length > 0 || dupes.similar.length > 0) ? (
        <div className="mb-8 max-w-2xl border-l-2 border-danger pl-4 text-xs">
          <SectionLabel className="text-danger">possible duplicate</SectionLabel>
          <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-muted">
            {dupes.exact.map((d) => (
              <Link key={d.id} href={`/items/${d.id}`} className="underline hover:text-fg">
                {d.name || "Untitled"} — identical photo
              </Link>
            ))}
            {dupes.similar.map((s) => (
              <Link key={s.item.id} href={`/items/${s.item.id}`} className="underline hover:text-fg">
                {s.item.name || "Untitled"} — very similar photo
              </Link>
            ))}
          </div>
        </div>
      ) : null}

      <div className="grid gap-10 lg:grid-cols-[minmax(280px,420px)_1fr]">
        <div className="flex flex-col gap-5">
          {/* Cropped garment shots only — raw photos (tripod, floor…) stay on disk, never shown */}
          <RotatingPhotos
            name={item.name ?? "item"}
            images={(["front", "back"] as const)
              .map((side) => {
                const cropped = item.images.find((i) => i.role === `${side}_cropped`);
                return cropped ?? item.images.find((i) => i.role === side);
              })
              .filter((img): img is NonNullable<typeof img> => Boolean(img))}
          />
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
