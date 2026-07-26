"use client";

import { useState } from "react";
import Link from "next/link";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { apiGet } from "@/lib/api";
import { CATEGORIES, type Item } from "@/shared/types";
import {
  Empty,
  ItemCard,
  PageTitle,
  SectionLabel,
  SegmentedControl,
  inputClass,
} from "@/components/ui";

const STATUS_OPTIONS = [
  { value: "", label: "Any" },
  { value: "available", label: "Available" },
  { value: "laundry", label: "Laundry" },
  { value: "unavailable", label: "Unavailable" },
] as const;

// 240 where this used to be 160: garments are the point of the screen, so they
// get the room. ~4 columns on a desktop, 2 on a phone. Thumbnails are generated
// at 640px square, so there is resolution to spare even at 2x.
const gridClass = "grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-x-7 gap-y-12";

export function WardrobeGrid({
  initialItems,
  initialDrafts,
}: {
  initialItems: Item[];
  initialDrafts: Item[];
}) {
  const [q, setQ] = useState("");
  const [category, setCategory] = useState("");
  const [color, setColor] = useState("");
  const [status, setStatus] = useState("");

  const params = new URLSearchParams();
  if (q) params.set("q", q);
  if (category) params.set("category", category);
  if (color) params.set("color", color);
  if (status) params.set("status", status);
  const key = params.toString();

  /*
   * The server already fetched the unfiltered wardrobe, so seed that one key and
   * let every filtered key fetch as before. keepPreviousData is what makes a
   * filter change cross-dissolve rather than blanking to a spinner — the old
   * results stay on screen, dimmed, until the new ones land.
   */
  const { data, isPlaceholderData } = useQuery({
    queryKey: ["items", key],
    queryFn: () => apiGet<{ items: Item[] }>(`/api/items?${key}`),
    initialData: key === "" ? { items: initialItems } : undefined,
    placeholderData: keepPreviousData,
  });
  const { data: draftData } = useQuery({
    queryKey: ["items", "drafts"],
    queryFn: () => apiGet<{ items: Item[] }>(`/api/items?state=draft`),
    initialData: { items: initialDrafts },
  });

  const items = data?.items ?? [];
  const drafts = draftData?.items ?? [];

  return (
    <div>
      <PageTitle eyebrow="Wardrobe">
        {`${items.length} ${items.length === 1 ? "piece" : "pieces"}`}
      </PageTitle>

      {drafts.length > 0 ? (
        <div className="mb-14">
          <SectionLabel className="mb-5 text-accent">Needs review · {drafts.length}</SectionLabel>
          <div className={gridClass}>
            {drafts.map((item, i) => (
              <ItemCard key={item.id} item={item} index={i} />
            ))}
          </div>
        </div>
      ) : null}

      <div className="mb-10 flex flex-col gap-4">
        <SegmentedControl
          options={[
            { value: "", label: "All" },
            ...CATEGORIES.map((c) => ({ value: c, label: c.replace("_", " ") })),
          ]}
          value={category}
          onChange={setCategory}
        />
        <div className="flex flex-wrap items-center gap-3">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search"
            className={`${inputClass} max-w-56`}
          />
          <input
            value={color}
            onChange={(e) => setColor(e.target.value)}
            placeholder="Color"
            className={`${inputClass} w-28`}
          />
          <SegmentedControl options={STATUS_OPTIONS} value={status} onChange={setStatus} />
        </div>
      </div>

      {items.length === 0 ? (
        <Empty>
          Nothing here yet. Import your first piece from the Import screen, or run{" "}
          <code className="text-fg">npm run seed</code> for sample data.
        </Empty>
      ) : (
        <div
          // Keyed on the filter so a new result set re-runs the dissolve.
          key={key}
          className={`fade-in ${gridClass} transition-opacity duration-[180ms] ${
            isPlaceholderData ? "opacity-50" : "opacity-100"
          }`}
        >
          {items.map((item, i) => (
            <ItemCard key={item.id} item={item} index={i} />
          ))}
        </div>
      )}

      <Link
        href="/import"
        aria-label="Import an item"
        className="fixed bottom-6 left-4 z-40 flex h-12 w-12 items-center justify-center rounded-full bg-fg text-2xl font-light text-bg transition-colors hover:bg-accent hover:text-accent-fg md:bottom-10 md:left-[15rem]"
      >
        +
      </Link>
    </div>
  );
}
