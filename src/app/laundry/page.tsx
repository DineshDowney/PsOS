"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiGet, apiSend } from "@/lib/api";
import type { Item, ItemStatus } from "@/shared/types";
import { Button, Empty, PageTitle, itemThumb } from "@/components/ui";
import { useToast } from "@/components/providers";

const COLUMNS: Array<{ status: ItemStatus; title: string; hint: string }> = [
  { status: "available", title: "Available", hint: "ready to wear" },
  { status: "laundry", title: "In Laundry", hint: "excluded from outfits" },
  { status: "unavailable", title: "Unavailable", hint: "lent out, storage, repair" },
];

export default function LaundryPage() {
  const toast = useToast();
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ["items", "all"],
    queryFn: () => apiGet<{ items: Item[] }>("/api/items"),
  });

  const move = useMutation({
    mutationFn: (input: { id: string; status: ItemStatus }) =>
      apiSend(`/api/items/${input.id}`, "PATCH", { status: input.status }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["items"] }),
  });

  const moveAll = useMutation({
    mutationFn: async (input: { from: ItemStatus; to: ItemStatus }) => {
      const targets = (data?.items ?? []).filter((i) => i.status === input.from);
      for (const item of targets) {
        await apiSend(`/api/items/${item.id}`, "PATCH", { status: input.to });
      }
      return targets.length;
    },
    onSuccess: (n) => {
      toast("info", `Moved ${n} items`);
      qc.invalidateQueries({ queryKey: ["items"] });
    },
  });

  const items = data?.items ?? [];

  return (
    <div>
      <PageTitle sub="Track what's wearable. Recommendations skip anything not available.">
        Laundry
      </PageTitle>

      <div className="mb-6">
        <Button
          onClick={() => moveAll.mutate({ from: "laundry", to: "available" })}
          disabled={moveAll.isPending || !items.some((i) => i.status === "laundry")}
        >
          {moveAll.isPending ? "Working…" : "Laundry done — everything back to available"}
        </Button>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        {COLUMNS.map((col) => {
          const colItems = items.filter((i) => i.status === col.status);
          return (
            <div key={col.status} className="border border-line bg-surface p-4">
              <div className="mb-4">
                <div className="text-xs uppercase tracking-[0.25em]">{col.title}</div>
                <div className="text-[10px] uppercase tracking-[0.15em] text-faint">
                  {colItems.length} · {col.hint}
                </div>
              </div>
              {colItems.length === 0 ? (
                <Empty>—</Empty>
              ) : (
                <div className="flex flex-col gap-2">
                  {colItems.map((item) => {
                    const thumb = itemThumb(item);
                    return (
                      <div key={item.id} className="flex items-center gap-3 border border-line/60 p-2">
                        <div className="h-12 w-12 shrink-0 bg-bg">
                          {thumb ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={thumb} alt="" className="h-full w-full object-contain" />
                          ) : null}
                        </div>
                        <span className="min-w-0 flex-1 truncate text-sm">{item.name}</span>
                        <div className="flex shrink-0 gap-1">
                          {COLUMNS.filter((c) => c.status !== col.status).map((c) => (
                            <button
                              key={c.status}
                              onClick={() => move.mutate({ id: item.id, status: c.status })}
                              className="border border-line px-2 py-1 text-[9px] uppercase tracking-[0.15em] text-muted hover:border-accent hover:text-fg"
                            >
                              → {c.status === "available" ? "avail" : c.status}
                            </button>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
