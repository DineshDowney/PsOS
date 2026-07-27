"use client";

import { useQuery } from "@tanstack/react-query";
import { apiGet } from "@/lib/api";
import type { AnalyticsSummary } from "@/shared/types";
import { PageTitle, SectionLabel, Skeleton, itemLabel } from "@/components/ui";

/**
 * `title` carries the item name for the hover tooltip. Garment rows are labelled
 * by colour+category now, which is NOT unique — two pairs of blue jeans produce
 * the same label — so the key has to include the index.
 */
interface BarRow {
  label: string;
  count: number;
  title?: string;
}

function Bars({ title, rows }: { title: string; rows: BarRow[] }) {
  const max = Math.max(1, ...rows.map((r) => r.count));
  return (
    <div className="card p-5">
      <SectionLabel className="mb-4">{title}</SectionLabel>
      <div className="flex flex-col gap-2">
        {rows.length === 0 ? <span className="text-meta text-faint">No data yet</span> : null}
        {rows.map((r, i) => (
          <div key={`${r.label}-${i}`} className="flex items-center gap-3 text-meta">
            <span className="w-28 shrink-0 truncate capitalize text-muted" title={r.title}>
              {r.label}
            </span>
            <div className="well h-2 flex-1">
              <div
                className="h-2 rounded-[2px] bg-accent/70 transition-[width] duration-[220ms] ease-out"
                style={{ width: `${(r.count / max) * 100}%` }}
              />
            </div>
            <span className="w-8 text-right tabular-nums text-fg">{r.count}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function AnalyticsPage() {
  const { data, isLoading } = useQuery({
    queryKey: ["analytics"],
    queryFn: () => apiGet<{ analytics: AnalyticsSummary }>("/api/analytics"),
  });
  // Hold the page's actual shape while it loads. This used to blank the whole
  // screen to a bare spinner — no title, no grid, nothing to look at.
  if (isLoading || !data) {
    return (
      <div>
        <PageTitle sub="Reading your wear history">Analytics</PageTitle>
        <div className="grid gap-6 lg:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 6 }, (_, i) => (
            <div key={i} className="card p-5">
              <Skeleton className="mb-4 h-4 w-28" />
              <div className="flex flex-col gap-2">
                {Array.from({ length: 5 }, (_, j) => (
                  <Skeleton key={j} className="h-4 w-full" />
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }
  const a = data.analytics;

  return (
    <div>
      <PageTitle sub={`${a.totalItems} pieces tracked`}>Analytics</PageTitle>
      <div className="grid gap-6 lg:grid-cols-2 xl:grid-cols-3">
        <Bars title="By category" rows={a.byCategory.map((x) => ({ label: x.category.replace("_", " "), count: x.count }))} />
        <Bars title="By color" rows={a.byColor.map((x) => ({ label: x.color, count: x.count }))} />
        <Bars title="By status" rows={a.byStatus.map((x) => ({ label: x.status, count: x.count }))} />
        <Bars
          title="Most worn"
          rows={a.mostWorn.map((x) => ({
            label: itemLabel(x.item),
            count: x.wearCount,
            title: x.item.name || undefined,
          }))}
        />
        <Bars
          title="Least worn"
          rows={a.leastWorn.map((x) => ({
            label: itemLabel(x.item),
            count: x.wearCount,
            title: x.item.name || undefined,
          }))}
        />
        <Bars title="Wears per week" rows={a.wearsByWeek.map((x) => ({ label: x.week, count: x.count }))} />
      </div>
    </div>
  );
}
