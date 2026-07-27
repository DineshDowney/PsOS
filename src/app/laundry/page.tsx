"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiGet, apiSend } from "@/lib/api";
import type { Item, ItemStatus } from "@/shared/types";
import { Button, Empty, PageTitle, SectionLabel, itemLabel, itemThumb } from "@/components/ui";
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
          disabled={!items.some((i) => i.status === "laundry")}
          loading={moveAll.isPending}
        >
          Laundry done — everything back to available
        </Button>
      </div>

      {/* items-start: columns size to their contents. Stretched, an empty
          "Unavailable" grew to match a 12-item "Available". */}
      <div className="grid items-start gap-6 lg:grid-cols-3">
        {COLUMNS.map((col) => {
          const colItems = items.filter((i) => i.status === col.status);
          return (
            <div key={col.status} className="card p-5">
              <div className="mb-4">
                <SectionLabel>{col.title}</SectionLabel>
                <div className="text-meta text-faint">
                  {colItems.length} · {col.hint}
                </div>
              </div>
              {colItems.length === 0 ? (
                <Empty>Nothing here</Empty>
              ) : (
                <div className="flex flex-col divide-y divide-line/60">
                  {colItems.map((item) => {
                    const thumb = itemThumb(item);
                    // Which row is mid-flight. `move` is one mutation shared by
                    // every row, so the id has to be compared — otherwise all
                    // rows would show a spinner at once.
                    const moving = move.isPending && move.variables?.id === item.id;
                    return (
                      <div
                        key={item.id}
                        className={`group flex items-center gap-3 py-2 transition-opacity ${
                          moving ? "opacity-50" : ""
                        }`}
                      >
                        {/* surface-2, not white: a pale garment in a 48px white
                            well has no edge at all. */}
                        <div className="well h-12 w-12 shrink-0">
                          {thumb ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={thumb} alt="" className="h-full w-full object-contain" />
                          ) : null}
                        </div>
                        <span
                          className="min-w-0 flex-1 truncate text-meta capitalize text-fg"
                          title={item.name || undefined}
                        >
                          {itemLabel(item)}
                        </span>
                        <div className="flex shrink-0 gap-1 opacity-60 transition-opacity group-hover:opacity-100">
                          {COLUMNS.filter((c) => c.status !== col.status).map((c) => (
                            <button
                              key={c.status}
                              onClick={() => move.mutate({ id: item.id, status: c.status })}
                              disabled={moving}
                              title={`Move to ${c.title}`}
                              className="rounded-[2px] border border-line px-2 py-1 text-micro capitalize text-muted transition-colors hover:border-accent hover:text-fg disabled:opacity-40"
                            >
                              {c.status === "available" ? "Available" : c.title.replace("In ", "")}
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
