"use client";

import { useQuery } from "@tanstack/react-query";
import { apiGet } from "@/lib/api";
import type { AnalyticsSummary } from "@/shared/types";
import { PageTitle, Spinner, itemLabel } from "@/components/ui";

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
    <div className="border border-line bg-surface p-5">
      <div className="mb-4 text-[10px] uppercase tracking-[0.25em] text-muted">{title}</div>
      <div className="flex flex-col gap-2">
        {rows.length === 0 ? <span className="text-sm text-faint">no data</span> : null}
        {rows.map((r, i) => (
          <div key={`${r.label}-${i}`} className="flex items-center gap-3 text-sm">
            <span className="w-28 shrink-0 truncate text-muted" title={r.title}>
              {r.label}
            </span>
            <div className="h-2 flex-1 bg-surface-2">
              <div
                className="h-2 bg-accent/70 transition-[width] duration-[220ms] ease-out"
                style={{ width: `${(r.count / max) * 100}%` }}
              />
            </div>
            <span className="w-8 text-right tabular-nums text-muted">{r.count}</span>
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
  if (isLoading || !data) return <Spinner label="Loading" />;
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
