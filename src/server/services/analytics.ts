import { getDb, schema } from "@/server/db/client";
import { listItems } from "@/server/services/catalog";
import { colorFamily } from "@/server/engine/color";
import type { AnalyticsSummary } from "@/shared/types";

export function getAnalytics(): AnalyticsSummary {
  const items = listItems();

  const byCategory = countBy(items.map((i) => i.category ?? "uncategorized"));
  const byColor = countBy(
    items
      .map((i) => (i.primaryColor ? (colorFamily(i.primaryColor) as string) : ""))
      .filter((c) => c !== "" && c !== "unknown"),
  );
  const byStatus = countBy(items.map((i) => i.status));

  const worn = [...items].sort((a, b) => b.wearCount - a.wearCount);
  const mostWorn = worn.slice(0, 5).filter((i) => i.wearCount > 0);
  const leastWorn = [...items]
    .sort((a, b) => a.wearCount - b.wearCount)
    .slice(0, 5);

  // Wears per ISO week over the last 12 weeks.
  const rows = getDb().select().from(schema.wearEvents).all();
  const weekCounts = new Map<string, number>();
  for (const row of rows) {
    const week = isoWeek(row.wornOn);
    weekCounts.set(week, (weekCounts.get(week) ?? 0) + 1);
  }
  const wearsByWeek = [...weekCounts.entries()]
    .map(([week, count]) => ({ week, count }))
    .sort((a, b) => a.week.localeCompare(b.week))
    .slice(-12);

  return {
    totalItems: items.length,
    byCategory: byCategory.map(([category, count]) => ({ category, count })),
    byColor: byColor.map(([color, count]) => ({ color, count })),
    byStatus: byStatus.map(([status, count]) => ({ status, count })),
    mostWorn: mostWorn.map((item) => ({ item, wearCount: item.wearCount })),
    leastWorn: leastWorn.map((item) => ({ item, wearCount: item.wearCount })),
    wearsByWeek,
  };
}

function countBy(values: string[]): Array<[string, number]> {
  const map = new Map<string, number>();
  for (const v of values) map.set(v, (map.get(v) ?? 0) + 1);
  return [...map.entries()].sort((a, b) => b[1] - a[1]);
}

function isoWeek(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}
