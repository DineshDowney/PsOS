"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiGet } from "@/lib/api";
import { CATEGORIES, type Item } from "@/shared/types";
import { Empty, ItemCard, PageTitle, Spinner, inputClass } from "@/components/ui";

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

  const items = data?.items ?? [];

  return (
    <div>
      <PageTitle sub={`${items.length} pieces`}>Wardrobe</PageTitle>

      <div className="mb-8 flex flex-wrap gap-3">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search"
          className={`${inputClass} max-w-xs`}
        />
        <select value={category} onChange={(e) => setCategory(e.target.value)} className={`${inputClass} w-40`}>
          <option value="">All categories</option>
          {CATEGORIES.map((c) => (
            <option key={c} value={c}>{c.replace("_", " ")}</option>
          ))}
        </select>
        <input
          value={color}
          onChange={(e) => setColor(e.target.value)}
          placeholder="Color"
          className={`${inputClass} w-32`}
        />
        <select value={status} onChange={(e) => setStatus(e.target.value)} className={`${inputClass} w-40`}>
          <option value="">Any status</option>
          <option value="available">Available</option>
          <option value="laundry">In laundry</option>
          <option value="unavailable">Unavailable</option>
        </select>
      </div>

      {isLoading ? (
        <Spinner label="Loading" />
      ) : items.length === 0 ? (
        <Empty>
          Nothing here yet. Import your first piece from the Import screen, or run{" "}
          <code className="text-fg">npm run seed</code> for sample data.
        </Empty>
      ) : (
        <div className="grid grid-cols-2 gap-6 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
          {items.map((item) => (
            <ItemCard key={item.id} item={item} />
          ))}
        </div>
      )}
    </div>
  );
}
