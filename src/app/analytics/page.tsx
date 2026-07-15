"use client";

import { useQuery } from "@tanstack/react-query";
import { apiGet } from "@/lib/api";
import type { AnalyticsSummary } from "@/shared/types";
import { PageTitle, Spinner } from "@/components/ui";

function Bars({ title, rows }: { title: string; rows: Array<{ label: string; count: number }> }) {
  const max = Math.max(1, ...rows.map((r) => r.count));
  return (
    <div className="border border-line bg-surface p-5">
      <div className="mb-4 text-[10px] uppercase tracking-[0.25em] text-muted">{title}</div>
      <div className="flex flex-col gap-2">
        {rows.length === 0 ? <span className="text-sm text-faint">no data</span> : null}
        {rows.map((r) => (
          <div key={r.label} className="flex items-center gap-3 text-sm">
            <span className="w-28 shrink-0 truncate text-muted">{r.label}</span>
            <div className="h-2 flex-1 bg-bg">
              <div className="h-2 bg-accent/70" style={{ width: `${(r.count / max) * 100}%` }} />
            </div>
            <span className="w-8 text-right text-muted">{r.count}</span>
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
        <Bars title="Most worn" rows={a.mostWorn.map((x) => ({ label: x.item.name, count: x.wearCount }))} />
        <Bars title="Least worn" rows={a.leastWorn.map((x) => ({ label: x.item.name, count: x.wearCount }))} />
        <Bars title="Wears per week" rows={a.wearsByWeek.map((x) => ({ label: x.week, count: x.count }))} />
      </div>
    </div>
  );
}
