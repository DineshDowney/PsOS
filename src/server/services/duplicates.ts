import { and, eq, ne, isNotNull } from "drizzle-orm";
import { getDb, schema } from "@/server/db/client";
import { hammingDistance, SIMILARITY_THRESHOLD } from "@/server/imaging/phash";
import { getItemsByIds } from "@/server/services/catalog";
import type { Item } from "@/shared/types";

/**
 * Review-time duplicate flagging. Compares FRONT photos only:
 *   - exact: identical file bytes (sha256) — the same photo imported twice
 *   - similar: perceptual hash within SIMILARITY_THRESHOLD bits — likely the
 *     same garment photographed again
 * Flag-only by design: nothing is blocked, merged, or deleted automatically.
 */

export interface DuplicateReport {
  exact: Item[];
  similar: Array<{ item: Item; distance: number }>;
}

export function findDuplicates(itemId: string): DuplicateReport {
  const db = getDb();
  const mine = db
    .select()
    .from(schema.itemImages)
    .where(and(eq(schema.itemImages.itemId, itemId), eq(schema.itemImages.role, "front")))
    .get();
  if (!mine) return { exact: [], similar: [] };

  const others = db
    .select({
      itemId: schema.itemImages.itemId,
      sha256: schema.itemImages.sha256,
      phash: schema.itemImages.phash,
    })
    .from(schema.itemImages)
    .innerJoin(schema.items, eq(schema.items.id, schema.itemImages.itemId))
    .where(
      and(
        eq(schema.itemImages.role, "front"),
        ne(schema.itemImages.itemId, itemId),
        ne(schema.items.state, "archived"),
        isNotNull(schema.itemImages.sha256),
      ),
    )
    .all();

  const exactIds: string[] = [];
  const similar: Array<{ id: string; distance: number }> = [];
  for (const o of others) {
    if (mine.sha256 && o.sha256 === mine.sha256) {
      exactIds.push(o.itemId);
    } else if (mine.phash && o.phash) {
      const d = hammingDistance(mine.phash, o.phash);
      if (d <= SIMILARITY_THRESHOLD) similar.push({ id: o.itemId, distance: d });
    }
  }

  const exact = getItemsByIds(exactIds);
  const similarItems = getItemsByIds(similar.map((s) => s.id));
  return {
    exact,
    similar: similar
      .map((s) => ({
        item: similarItems.find((i) => i.id === s.id)!,
        distance: s.distance,
      }))
      .filter((s) => s.item)
      .sort((a, b) => a.distance - b.distance),
  };
}
