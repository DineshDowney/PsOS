"use client";

import { useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { apiGet } from "@/lib/api";
import { CATEGORIES, type Item } from "@/shared/types";
import {
  Empty,
  ItemCard,
  PageTitle,
  SectionLabel,
  SegmentedControl,
  Spinner,
  inputClass,
} from "@/components/ui";

const STATUS_OPTIONS = [
  { value: "", label: "Any" },
  { value: "available", label: "Available" },
  { value: "laundry", label: "Laundry" },
  { value: "unavailable", label: "Unavailable" },
] as const;

const gridClass = "grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-x-6 gap-y-10";

export default function WardrobePage() {
  const [q, setQ] = useState("");
  const [category, setCategory] = useState("");
  const [color, setColor] = useState("");
  const [status, setStatus] = useState("");

  const params = new URLSearchParams();
  if (q) params.set("q", q);
  if (category) params.set("category", category);
  if (color) params.set("color", color);
  if (status) params.set("status", status);

  const { data, isLoading } = useQuery({
    queryKey: ["items", params.toString()],
    queryFn: () => apiGet<{ items: Item[] }>(`/api/items?${params}`),
  });
  const { data: draftData } = useQuery({
    queryKey: ["items", "drafts"],
    queryFn: () => apiGet<{ items: Item[] }>(`/api/items?state=draft`),
  });

  const items = data?.items ?? [];
  const drafts = draftData?.items ?? [];

  return (
    <div>
      <PageTitle eyebrow="Wardrobe">
        {isLoading ? "—" : `${items.length} ${items.length === 1 ? "piece" : "pieces"}`}
      </PageTitle>

      {drafts.length > 0 ? (
        <div className="mb-12">
          <SectionLabel className="mb-4 text-accent">
            Needs review · {drafts.length}
          </SectionLabel>
          <div className={gridClass}>
            {drafts.map((item) => (
              <ItemCard key={item.id} item={item} />
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

      {isLoading ? (
        <Spinner label="Loading" />
      ) : items.length === 0 ? (
        <Empty>
          Nothing here yet. Import your first piece from the Import screen, or run{" "}
          <code className="text-fg">npm run seed</code> for sample data.
        </Empty>
      ) : (
        <div className={gridClass}>
          {items.map((item) => (
            <ItemCard key={item.id} item={item} />
          ))}
        </div>
      )}

      <Link
        href="/import"
        aria-label="Import an item"
        className="fixed bottom-6 left-4 z-40 flex h-12 w-12 items-center justify-center rounded-full bg-fg text-2xl font-light text-bg transition-colors hover:bg-accent hover:text-fg md:bottom-10 md:left-[15rem]"
      >
        +
      </Link>
    </div>
  );
}
