import { desc, eq, inArray } from "drizzle-orm";
import { getDb, schema } from "@/server/db/client";
import { newId, nowIso } from "@/server/lib/ids";
import { badRequest } from "@/server/lib/errors";
import { logActivity } from "@/server/services/activity";
import { getItemsByIds } from "@/server/services/catalog";
import type { WearEvent } from "@/shared/types";

/**
 * Wear history is event-sourced: wear_events(+items) is the source of truth,
 * items.wear_count / last_worn_at are recomputed caches.
 */

function recomputeWearCaches(itemIds: string[]): void {
  const db = getDb();
  for (const itemId of itemIds) {
    const rows = db
      .select({ wornOn: schema.wearEvents.wornOn })
      .from(schema.wearEventItems)
      .innerJoin(
        schema.wearEvents,
        eq(schema.wearEventItems.wearEventId, schema.wearEvents.id),
      )
      .where(eq(schema.wearEventItems.itemId, itemId))
      .all();
    const lastWorn = rows.reduce<string | null>(
      (max, r) => (max === null || r.wornOn > max ? r.wornOn : max),
      null,
    );
    db.update(schema.items)
      .set({ wearCount: rows.length, lastWornAt: lastWorn, updatedAt: nowIso() })
      .where(eq(schema.items.id, itemId))
      .run();
  }
}

export interface LogWearInput {
  itemIds: string[];
  wornOn: string; // YYYY-MM-DD
  outfitId?: string | null;
  occasion?: string | null;
  notes?: string | null;
  /** move worn items to laundry after logging */
  sendToLaundry?: boolean;
  actor?: "user" | "ai";
}

export function logWear(input: LogWearInput): WearEvent {
  if (input.itemIds.length === 0) throw badRequest("At least one item is required");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.wornOn))
    throw badRequest("wornOn must be YYYY-MM-DD");

  const db = getDb();
  const id = newId();
  db.insert(schema.wearEvents)
    .values({
      id,
      wornOn: input.wornOn,
      outfitId: input.outfitId ?? null,
      occasion: input.occasion ?? null,
      notes: input.notes ?? null,
      createdAt: nowIso(),
    })
    .run();
  for (const itemId of input.itemIds) {
    db.insert(schema.wearEventItems)
      .values({ wearEventId: id, itemId })
      .onConflictDoNothing()
      .run();
  }
  recomputeWearCaches(input.itemIds);

  if (input.sendToLaundry) {
    db.update(schema.items)
      .set({ status: "laundry", updatedAt: nowIso() })
      .where(inArray(schema.items.id, input.itemIds))
      .run();
  }

  logActivity(input.actor ?? "user", "wear.logged", { type: "wear_event", id }, {
    wornOn: input.wornOn,
    itemIds: input.itemIds,
    sendToLaundry: !!input.sendToLaundry,
  });
  return getWearEvent(id);
}

export function deleteWearEvent(id: string): void {
  const db = getDb();
  const itemRows = db
    .select({ itemId: schema.wearEventItems.itemId })
    .from(schema.wearEventItems)
    .where(eq(schema.wearEventItems.wearEventId, id))
    .all();
  db.delete(schema.wearEvents).where(eq(schema.wearEvents.id, id)).run();
  recomputeWearCaches(itemRows.map((r) => r.itemId));
  logActivity("user", "wear.deleted", { type: "wear_event", id });
}

export function getWearEvent(id: string): WearEvent {
  const db = getDb();
  const row = db
    .select()
    .from(schema.wearEvents)
    .where(eq(schema.wearEvents.id, id))
    .get();
  if (!row) throw badRequest(`Wear event '${id}' not found`);
  const itemRows = db
    .select({ itemId: schema.wearEventItems.itemId })
    .from(schema.wearEventItems)
    .where(eq(schema.wearEventItems.wearEventId, id))
    .all();
  return {
    id: row.id,
    wornOn: row.wornOn,
    outfitId: row.outfitId,
    occasion: row.occasion,
    notes: row.notes,
    items: getItemsByIds(itemRows.map((r) => r.itemId)),
  };
}

export function listWearEvents(opts: { itemId?: string; limit?: number } = {}): WearEvent[] {
  const db = getDb();
  let eventIds: string[];
  if (opts.itemId) {
    eventIds = db
      .select({ id: schema.wearEventItems.wearEventId })
      .from(schema.wearEventItems)
      .where(eq(schema.wearEventItems.itemId, opts.itemId))
      .all()
      .map((r) => r.id);
  } else {
    eventIds = db
      .select({ id: schema.wearEvents.id })
      .from(schema.wearEvents)
      .orderBy(desc(schema.wearEvents.wornOn))
      .limit(opts.limit ?? 100)
      .all()
      .map((r) => r.id);
  }
  return eventIds
    .map((id) => getWearEvent(id))
    .sort((a, b) => b.wornOn.localeCompare(a.wornOn))
    .slice(0, opts.limit ?? 100);
}

/** Recent item-id combos, used by the outfit engine's repeat penalty. */
export function recentWearCombos(limit = 20): Array<Set<string>> {
  return listWearEvents({ limit }).map((e) => new Set(e.items.map((i) => i.id)));
}
