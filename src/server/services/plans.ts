import { and, eq, gte, lte } from "drizzle-orm";
import { getDb, schema } from "@/server/db/client";
import { newId, nowIso } from "@/server/lib/ids";
import { badRequest, notFound } from "@/server/lib/errors";
import { logActivity } from "@/server/services/activity";
import { getOutfit } from "@/server/services/outfits";
import { logWear } from "@/server/services/wear";
import type { Plan } from "@/shared/types";

function mapPlan(row: typeof schema.plans.$inferSelect): Plan {
  return {
    id: row.id,
    planDate: row.planDate,
    status: row.status,
    notes: row.notes,
    outfit: getOutfit(row.outfitId),
  };
}

export function listPlans(from: string, to: string): Plan[] {
  const rows = getDb()
    .select()
    .from(schema.plans)
    .where(and(gte(schema.plans.planDate, from), lte(schema.plans.planDate, to)))
    .all();
  return rows.map(mapPlan).sort((a, b) => a.planDate.localeCompare(b.planDate));
}

export function createPlan(input: {
  planDate: string;
  outfitId: string;
  notes?: string | null;
  actor?: "user" | "ai";
}): Plan {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.planDate))
    throw badRequest("planDate must be YYYY-MM-DD");
  getOutfit(input.outfitId); // 404 check
  const id = newId();
  getDb()
    .insert(schema.plans)
    .values({
      id,
      planDate: input.planDate,
      outfitId: input.outfitId,
      notes: input.notes ?? null,
      createdAt: nowIso(),
    })
    .run();
  logActivity(input.actor ?? "user", "plan.created", { type: "plan", id }, {
    planDate: input.planDate,
  });
  return mapPlan(getDb().select().from(schema.plans).where(eq(schema.plans.id, id)).get()!);
}

/**
 * Mark a plan worn/skipped. Marking "worn" also writes the wear event
 * (calendar and wear history stay consistent).
 */
export function setPlanStatus(
  id: string,
  status: "planned" | "worn" | "skipped",
  opts: { sendToLaundry?: boolean } = {},
): Plan {
  const db = getDb();
  const row = db.select().from(schema.plans).where(eq(schema.plans.id, id)).get();
  if (!row) throw notFound("Plan", id);

  db.update(schema.plans).set({ status }).where(eq(schema.plans.id, id)).run();

  if (status === "worn" && row.status !== "worn") {
    const outfit = getOutfit(row.outfitId);
    logWear({
      itemIds: outfit.items.map((x) => x.item.id),
      wornOn: row.planDate,
      outfitId: outfit.id,
      sendToLaundry: opts.sendToLaundry,
    });
  }
  logActivity("user", "plan.status_changed", { type: "plan", id }, { status });
  return mapPlan(db.select().from(schema.plans).where(eq(schema.plans.id, id)).get()!);
}

export function deletePlan(id: string): void {
  const db = getDb();
  const row = db.select().from(schema.plans).where(eq(schema.plans.id, id)).get();
  if (!row) throw notFound("Plan", id);
  db.delete(schema.plans).where(eq(schema.plans.id, id)).run();
  logActivity("user", "plan.deleted", { type: "plan", id });
}
