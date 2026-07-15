import { desc, eq } from "drizzle-orm";
import { getDb, schema } from "@/server/db/client";
import { newId, nowIso } from "@/server/lib/ids";
import { badRequest, notFound } from "@/server/lib/errors";
import { logActivity } from "@/server/services/activity";
import { getItemsByIds } from "@/server/services/catalog";
import type { Category, Outfit } from "@/shared/types";

export function getOutfit(id: string): Outfit {
  const db = getDb();
  const row = db.select().from(schema.outfits).where(eq(schema.outfits.id, id)).get();
  if (!row) throw notFound("Outfit", id);
  const memberRows = db
    .select()
    .from(schema.outfitItems)
    .where(eq(schema.outfitItems.outfitId, id))
    .all();
  const items = getItemsByIds(memberRows.map((m) => m.itemId));
  return {
    id: row.id,
    name: row.name,
    source: row.source,
    notes: row.notes,
    createdAt: row.createdAt,
    items: memberRows
      .map((m) => ({
        item: items.find((i) => i.id === m.itemId)!,
        slot: m.slot as Category,
      }))
      .filter((x) => x.item),
  };
}

export function listOutfits(): Outfit[] {
  const rows = getDb()
    .select({ id: schema.outfits.id })
    .from(schema.outfits)
    .orderBy(desc(schema.outfits.createdAt))
    .all();
  return rows.map((r) => getOutfit(r.id));
}

export interface SaveOutfitInput {
  name?: string | null;
  notes?: string | null;
  source?: "user" | "ai";
  items: Array<{ itemId: string; slot: Category }>;
}

export function saveOutfit(input: SaveOutfitInput): Outfit {
  if (input.items.length === 0) throw badRequest("An outfit needs at least one item");
  const db = getDb();
  const id = newId();
  db.insert(schema.outfits)
    .values({
      id,
      name: input.name ?? null,
      notes: input.notes ?? null,
      source: input.source ?? "user",
      createdAt: nowIso(),
    })
    .run();
  for (const member of input.items) {
    db.insert(schema.outfitItems)
      .values({ outfitId: id, itemId: member.itemId, slot: member.slot })
      .onConflictDoNothing()
      .run();
  }
  logActivity(input.source === "ai" ? "ai" : "user", "outfit.saved", {
    type: "outfit",
    id,
  });
  return getOutfit(id);
}

export function deleteOutfit(id: string): void {
  getOutfit(id);
  getDb().delete(schema.outfits).where(eq(schema.outfits.id, id)).run();
  logActivity("user", "outfit.deleted", { type: "outfit", id });
}
