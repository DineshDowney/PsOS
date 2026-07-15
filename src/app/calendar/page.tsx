"use client";

import { useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiGet, apiSend } from "@/lib/api";
import type { Outfit, Plan } from "@/shared/types";
import { Button, PageTitle } from "@/components/ui";
import { useToast } from "@/components/providers";

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function monthMeta(year: number, month: number) {
  const first = new Date(Date.UTC(year, month, 1));
  const last = new Date(Date.UTC(year, month + 1, 0));
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  // Monday-first offset: JS getUTCDay() is 0=Sun..6=Sat
  const leading = (first.getUTCDay() + 6) % 7;
  return { from: fmt(first), to: fmt(last), days: last.getUTCDate(), leading };
}

function outfitLabel(o: Outfit): string {
  return o.name || o.items.map((x) => x.item.name).join(" + ");
}

export default function CalendarPage() {
  const toast = useToast();
  const qc = useQueryClient();
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth());
  const [pickerDate, setPickerDate] = useState<string | null>(null);

  const { from, to, days, leading } = monthMeta(year, month);

  const { data: plansData } = useQuery({
    queryKey: ["plans", from, to],
    queryFn: () => apiGet<{ plans: Plan[] }>(`/api/plans?from=${from}&to=${to}`),
  });
  const { data: outfitsData } = useQuery({
    queryKey: ["outfits"],
    queryFn: () => apiGet<{ outfits: Outfit[] }>("/api/outfits"),
  });

  const createPlan = useMutation({
    mutationFn: (input: { planDate: string; outfitId: string }) =>
      apiSend("/api/plans", "POST", input),
    onSuccess: () => {
      setPickerDate(null);
      toast("info", "Outfit planned");
      qc.invalidateQueries({ queryKey: ["plans"] });
    },
  });
  const setStatus = useMutation({
    mutationFn: (input: { id: string; status: "worn" | "skipped" | "planned" }) =>
      apiSend(`/api/plans/${input.id}`, "PATCH", { status: input.status }),
    onSuccess: (_d, v) => {
      if (v.status === "worn") toast("info", "Marked worn — wear history updated");
      qc.invalidateQueries();
    },
  });

  const plans = plansData?.plans ?? [];
  const outfits = outfitsData?.outfits ?? [];
  const todayStr = new Date().toLocaleDateString("sv-SE");
  const monthLabel = new Date(year, month, 1).toLocaleString("en", {
    month: "long",
    year: "numeric",
  });

  const prev = () => (month === 0 ? (setYear(year - 1), setMonth(11)) : setMonth(month - 1));
  const next = () => (month === 11 ? (setYear(year + 1), setMonth(0)) : setMonth(month + 1));

  const totalCells = Math.ceil((leading + days) / 7) * 7;

  return (
    <div>
      <PageTitle sub="Plan outfits ahead; mark them worn on the day.">Calendar</PageTitle>

      <div className="mb-6 flex items-center gap-4">
        <Button onClick={prev}>←</Button>
        <span className="w-48 text-center text-sm uppercase tracking-[0.2em]">{monthLabel}</span>
        <Button onClick={next}>→</Button>
        <Button
          variant="ghost"
          onClick={() => {
            setYear(now.getFullYear());
            setMonth(now.getMonth());
          }}
        >
          Today
        </Button>
      </div>

      <div className="grid grid-cols-7 border-l border-t border-line">
        {WEEKDAYS.map((d) => (
          <div
            key={d}
            className="border-b border-r border-line bg-surface px-2 py-2 text-center text-[10px] uppercase tracking-[0.25em] text-muted"
          >
            {d}
          </div>
        ))}
        {Array.from({ length: totalCells }, (_, cell) => {
          const dayNum = cell - leading + 1;
          if (dayNum < 1 || dayNum > days) {
            return <div key={cell} className="min-h-28 border-b border-r border-line bg-bg" />;
          }
          const date = `${year}-${String(month + 1).padStart(2, "0")}-${String(dayNum).padStart(2, "0")}`;
          const dayPlans = plans.filter((p) => p.planDate === date);
          const isToday = date === todayStr;
          return (
            <div
              key={cell}
              className={`group relative min-h-28 border-b border-r border-line p-2 ${
                isToday ? "bg-surface-2" : "bg-surface"
              }`}
            >
              <div className="mb-1 flex items-center justify-between">
                <span className={`text-xs ${isToday ? "text-accent" : "text-muted"}`}>
                  {dayNum}
                </span>
                <button
                  onClick={() => setPickerDate(date)}
                  className="border border-line px-1.5 text-xs leading-5 text-faint opacity-0 transition-opacity hover:border-accent hover:text-fg group-hover:opacity-100"
                  title="Plan an outfit"
                >
                  +
                </button>
              </div>
              <div className="flex flex-col gap-1.5">
                {dayPlans.map((p) => (
                  <div key={p.id} className="border border-line/70 bg-bg p-1.5">
                    <div
                      className={`truncate text-[11px] leading-tight ${
                        p.status === "skipped" ? "text-faint line-through" : "text-fg"
                      }`}
                      title={outfitLabel(p.outfit)}
                    >
                      {outfitLabel(p.outfit)}
                    </div>
                    {p.status === "worn" ? (
                      <div className="mt-0.5 text-[9px] uppercase tracking-[0.2em] text-ok">worn</div>
                    ) : p.status === "planned" ? (
                      <div className="mt-1 flex gap-2">
                        <button
                          className="text-[9px] uppercase tracking-[0.15em] text-ok hover:underline"
                          onClick={() => setStatus.mutate({ id: p.id, status: "worn" })}
                        >
                          worn
                        </button>
                        <button
                          className="text-[9px] uppercase tracking-[0.15em] text-faint hover:underline"
                          onClick={() => setStatus.mutate({ id: p.id, status: "skipped" })}
                        >
                          skip
                        </button>
                        <button
                          className="text-[9px] uppercase tracking-[0.15em] text-danger hover:underline"
                          onClick={async () => {
                            await apiSend(`/api/plans/${p.id}`, "DELETE");
                            qc.invalidateQueries({ queryKey: ["plans"] });
                          }}
                        >
                          remove
                        </button>
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>

      {pickerDate ? (
        <div
          className="fixed inset-0 z-40 flex items-center justify-center bg-bg/80"
          onClick={() => setPickerDate(null)}
        >
          <div
            className="w-full max-w-md border border-line bg-surface p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-4 flex items-center justify-between">
              <span className="text-xs uppercase tracking-[0.25em] text-muted">
                Plan for {pickerDate}
              </span>
              <button
                className="text-muted hover:text-fg"
                onClick={() => setPickerDate(null)}
                aria-label="Close"
              >
                ✕
              </button>
            </div>
            {outfits.length === 0 ? (
              <p className="text-sm text-muted">
                No saved outfits yet. Create one in the{" "}
                <Link href="/outfits" className="text-fg underline">
                  Outfit Studio
                </Link>{" "}
                (generate suggestions → Save), then plan it here.
              </p>
            ) : (
              <div className="flex max-h-80 flex-col gap-2 overflow-y-auto">
                {outfits.map((o) => (
                  <button
                    key={o.id}
                    disabled={createPlan.isPending}
                    onClick={() => createPlan.mutate({ planDate: pickerDate, outfitId: o.id })}
                    className="border border-line px-3 py-2 text-left text-sm text-muted hover:border-accent hover:text-fg disabled:opacity-40"
                  >
                    {outfitLabel(o)}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
