"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiGet, apiSend } from "@/lib/api";
import {
  FORMALITIES, type Outfit, type OutfitSuggestion,
} from "@/shared/types";
import { Button, Empty, PageTitle, Spinner, inputClass, itemThumb } from "@/components/ui";
import { useToast } from "@/components/providers";

function OutfitItems({ items }: { items: OutfitSuggestion["items"] }) {
  return (
    <div className="flex gap-2">
      {items.map(({ item, slot }) => {
        const thumb = itemThumb(item);
        return (
          <div key={item.id} className="w-24">
            <div className="aspect-square border border-line bg-surface">
              {thumb ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={thumb} alt={item.name} className="h-full w-full object-contain p-1" />
              ) : null}
            </div>
            <div className="mt-1 truncate text-[10px] text-muted" title={item.name}>
              <span className="text-faint">{slot.replace("_", " ")} · </span>
              {item.name}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export default function OutfitsPage() {
  const toast = useToast();
  const qc = useQueryClient();
  const [formality, setFormality] = useState("");
  const [suggestions, setSuggestions] = useState<OutfitSuggestion[] | null>(null);

  const { data: savedData } = useQuery({
    queryKey: ["outfits"],
    queryFn: () => apiGet<{ outfits: Outfit[] }>("/api/outfits"),
  });

  const suggest = useMutation({
    mutationFn: () =>
      apiSend<{ suggestions: OutfitSuggestion[] }>("/api/outfits/suggest", "POST", {
        formality: formality || undefined,
        count: 4,
      }),
    onSuccess: (d) => setSuggestions(d.suggestions),
  });

  const wear = useMutation({
    mutationFn: (input: { itemIds: string[]; sendToLaundry: boolean }) =>
      apiSend("/api/wear", "POST", {
        itemIds: input.itemIds,
        wornOn: new Date().toLocaleDateString("sv-SE"),
        sendToLaundry: input.sendToLaundry,
      }),
    onSuccess: () => {
      toast("info", "Logged — enjoy the day");
      qc.invalidateQueries();
    },
  });

  const save = useMutation({
    mutationFn: (s: OutfitSuggestion) =>
      apiSend<{ outfit: Outfit }>("/api/outfits", "POST", {
        items: s.items.map((x) => ({ itemId: x.item.id, slot: x.slot })),
      }),
    onSuccess: () => {
      toast("info", "Outfit saved");
      qc.invalidateQueries({ queryKey: ["outfits"] });
    },
  });

  return (
    <div>
      <PageTitle sub="Generated from available pieces — laundry is excluded automatically.">
        Outfit Studio
      </PageTitle>

      <div className="mb-8 flex items-end gap-3">
        <label className="flex flex-col gap-1.5">
          <span className="text-[10px] uppercase tracking-[0.2em] text-muted">Occasion</span>
          <select value={formality} onChange={(e) => setFormality(e.target.value)} className={`${inputClass} w-44`}>
            <option value="">Anything</option>
            {FORMALITIES.map((f) => <option key={f} value={f}>{f.replace("_", " ")}</option>)}
          </select>
        </label>
        <Button variant="solid" onClick={() => suggest.mutate()} disabled={suggest.isPending}>
          {suggest.isPending ? "Thinking…" : "Suggest outfits"}
        </Button>
      </div>

      {suggest.isPending ? <Spinner label="Generating" /> : null}

      {suggestions && suggestions.length === 0 ? (
        <Empty>Not enough available items to build an outfit (need tops + bottoms or a full-body piece).</Empty>
      ) : null}

      {suggestions && suggestions.length > 0 ? (
        <div className="mb-14 flex flex-col gap-6">
          {suggestions.map((s, idx) => (
            <div key={idx} className="flex flex-wrap items-center justify-between gap-4 border border-line bg-surface p-5">
              <OutfitItems items={s.items} />
              <div className="flex items-center gap-2">
                <span className="mr-2 text-[10px] uppercase tracking-[0.2em] text-faint">match {Math.round(s.score * 100)}%</span>
                <Button onClick={() => save.mutate(s)}>Save</Button>
                <Button
                  variant="solid"
                  onClick={() =>
                    wear.mutate({
                      itemIds: s.items.map((x) => x.item.id),
                      sendToLaundry: false,
                    })
                  }
                >
                  Wear today
                </Button>
              </div>
            </div>
          ))}
        </div>
      ) : null}

      <h2 className="mb-4 text-[10px] uppercase tracking-[0.25em] text-muted">Saved outfits</h2>
      {!savedData || savedData.outfits.length === 0 ? (
        <Empty>No saved outfits yet.</Empty>
      ) : (
        <div className="flex flex-col gap-4">
          {savedData.outfits.map((o) => (
            <div key={o.id} className="flex flex-wrap items-center justify-between gap-4 border border-line bg-surface p-5">
              <div>
                {o.name ? <div className="mb-2 text-sm">{o.name}</div> : null}
                <OutfitItems items={o.items} />
              </div>
              <div className="flex gap-2">
                <Button
                  variant="solid"
                  onClick={() =>
                    wear.mutate({ itemIds: o.items.map((x) => x.item.id), sendToLaundry: false })
                  }
                >
                  Wear today
                </Button>
                <Button
                  variant="danger"
                  onClick={async () => {
                    await apiSend(`/api/outfits/${o.id}`, "DELETE");
                    qc.invalidateQueries({ queryKey: ["outfits"] });
                  }}
                >
                  Delete
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
