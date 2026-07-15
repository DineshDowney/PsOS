import { and, eq, inArray, ne } from "drizzle-orm";
import { getDb, schema } from "@/server/db/client";
import { newId, nowIso } from "@/server/lib/ids";
import { parseJson, toJson } from "@/server/lib/json";
import { notFound } from "@/server/lib/errors";
import { logActivity, type Actor } from "@/server/services/activity";
import {
  applyAiInference,
  applyUserEdits,
  type FieldSources,
} from "@/server/services/provenance";
import { colorFamily } from "@/server/engine/color";
import type {
  AiInference,
  Category,
  EditableFields,
  Formality,
  Item,
  ItemStatus,
  ItemImage,
  Season,
} from "@/shared/types";

type ItemRow = typeof schema.items.$inferSelect;
type ImageRow = typeof schema.itemImages.$inferSelect;
type TagRow = typeof schema.itemTags.$inferSelect;

// ---------------------------------------------------------------------------
// Mapping

function imageUrl(path: string): string {
  return `/api/images/${path.split(/[\\/]/).map(encodeURIComponent).join("/")}`;
}

function mapImage(row: ImageRow): ItemImage {
  // Content-hash the URL: images are served immutable-cached for a year, and
  // the pipeline/backfill rewrite bytes at the SAME path (thumbnail.jpg), so
  // the version param is what makes browsers pick up regenerated images.
  const v = row.sha256 ? `?v=${row.sha256.slice(0, 10)}` : "";
  return {
    id: row.id,
    role: row.role,
    url: imageUrl(row.path) + v,
    width: row.width,
    height: row.height,
  };
}

export function mapItem(row: ItemRow, images: ImageRow[], tags: TagRow[]): Item {
  return {
    id: row.id,
    state: row.state,
    status: row.status,
    name: row.name,
    category: row.category,
    subcategory: row.subcategory,
    description: row.description,
    notes: row.notes,
    primaryColor: row.primaryColor,
    secondaryColors: parseJson<string[]>(row.secondaryColors, []),
    colorDetail: row.colorDetail,
    pattern: row.pattern,
    fit: row.fit,
    material: row.material,
    brand: row.brand,
    size: row.size,
    formality: row.formality as Formality | null,
    seasons: parseJson<Season[]>(row.seasons, []),
    price: row.price,
    purchaseDate: row.purchaseDate,
    wearCount: row.wearCount,
    lastWornAt: row.lastWornAt,
    fieldSources: parseJson<FieldSources>(row.fieldSources, {}),
    images: images.map(mapImage),
    tags: tags.map((t) => ({ tag: t.tag, source: t.source })),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function editableOf(item: Item): EditableFields {
  const {
    name, category, subcategory, description, primaryColor, secondaryColors,
    colorDetail, pattern, fit, material, brand, size, formality, seasons,
    price, purchaseDate,
  } = item;
  return {
    name, category, subcategory, description, primaryColor, secondaryColors,
    colorDetail, pattern, fit, material, brand, size, formality, seasons,
    price, purchaseDate,
  };
}

function fieldsToRow(fields: EditableFields) {
  return {
    name: fields.name ?? "",
    category: fields.category,
    subcategory: fields.subcategory,
    description: fields.description,
    primaryColor: fields.primaryColor,
    secondaryColors: toJson(fields.secondaryColors ?? []),
    colorDetail: fields.colorDetail,
    pattern: fields.pattern,
    fit: fields.fit,
    material: fields.material,
    brand: fields.brand,
    size: fields.size,
    formality: fields.formality,
    seasons: toJson(fields.seasons ?? []),
    price: fields.price,
    purchaseDate: fields.purchaseDate,
  };
}

// ---------------------------------------------------------------------------
// Reads

function loadItems(ids?: string[]): Item[] {
  const db = getDb();
  const rows = ids
    ? db.select().from(schema.items).where(inArray(schema.items.id, ids)).all()
    : db.select().from(schema.items).where(ne(schema.items.state, "archived")).all();
  if (rows.length === 0) return [];
  const rowIds = rows.map((r) => r.id);
  const images = db
    .select()
    .from(schema.itemImages)
    .where(inArray(schema.itemImages.itemId, rowIds))
    .all();
  const tags = db
    .select()
    .from(schema.itemTags)
    .where(inArray(schema.itemTags.itemId, rowIds))
    .all();
  return rows.map((row) =>
    mapItem(
      row,
      images.filter((i) => i.itemId === row.id),
      tags.filter((t) => t.itemId === row.id),
    ),
  );
}

export interface ItemFilters {
  q?: string;
  category?: Category;
  color?: string;
  tag?: string;
  status?: ItemStatus;
  state?: "draft" | "active";
}

/**
 * Wardrobe-scale data (hundreds of items) — filter in memory for simple,
 * testable search semantics rather than assembling dynamic SQL.
 */
export function listItems(filters: ItemFilters = {}): Item[] {
  let items = loadItems().filter((i) => i.state !== "archived");
  items = items.filter((i) => i.state === (filters.state ?? "active"));

  if (filters.status) items = items.filter((i) => i.status === filters.status);
  if (filters.category) items = items.filter((i) => i.category === filters.category);
  if (filters.tag) {
    const tag = filters.tag.toLowerCase();
    items = items.filter((i) => i.tags.some((t) => t.tag.toLowerCase() === tag));
  }
  if (filters.color) {
    const wanted = filters.color.toLowerCase();
    items = items.filter((i) => {
      const own = [i.primaryColor, ...i.secondaryColors].filter(Boolean) as string[];
      return own.some(
        (c) =>
          c.toLowerCase().includes(wanted) ||
          colorFamily(c) === wanted ||
          colorFamily(c) === colorFamily(wanted),
      );
    });
  }
  if (filters.q) {
    const q = filters.q.toLowerCase();
    items = items.filter((i) =>
      [
        i.name, i.description, i.brand, i.subcategory, i.colorDetail,
        i.primaryColor, i.material, i.pattern, i.notes,
        ...i.tags.map((t) => t.tag),
      ]
        .filter(Boolean)
        .some((v) => (v as string).toLowerCase().includes(q)),
    );
  }
  return items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function getItem(id: string): Item {
  const item = loadItems([id])[0];
  if (!item) throw notFound("Item", id);
  return item;
}

export function getItemsByIds(ids: string[]): Item[] {
  return loadItems(ids);
}

// ---------------------------------------------------------------------------
// Writes

export function createDraftItem(): Item {
  const db = getDb();
  const id = newId();
  const ts = nowIso();
  db.insert(schema.items)
    .values({ id, state: "draft", createdAt: ts, updatedAt: ts })
    .run();
  logActivity("system", "item.draft_created", { type: "item", id });
  return getItem(id);
}

/** User edit: applies provenance rules, flipping edited fields to "user". */
export function updateItemFields(
  id: string,
  patch: Partial<EditableFields> & { notes?: string | null },
): Item {
  const item = getItem(id);
  const { fields, sources } = applyUserEdits(
    editableOf(item),
    item.fieldSources,
    patch,
  );
  const db = getDb();
  db.update(schema.items)
    .set({
      ...fieldsToRow(fields),
      ...(patch.notes !== undefined ? { notes: patch.notes } : {}),
      fieldSources: toJson(sources),
      updatedAt: nowIso(),
    })
    .where(eq(schema.items.id, id))
    .run();
  logActivity("user", "item.updated", { type: "item", id }, { fields: Object.keys(patch) });
  return getItem(id);
}

/** AI write: only touches fields the user hasn't edited. */
export function applyInferenceToItem(id: string, inference: AiInference): Item {
  const item = getItem(id);
  const { fields, sources, skipped } = applyAiInference(
    editableOf(item),
    item.fieldSources,
    inference.fields,
  );
  const db = getDb();
  db.update(schema.items)
    .set({
      ...fieldsToRow(fields),
      fieldSources: toJson(sources),
      aiRaw: toJson(inference),
      updatedAt: nowIso(),
    })
    .where(eq(schema.items.id, id))
    .run();

  for (const tag of inference.tags) {
    db.insert(schema.itemTags)
      .values({ itemId: id, tag: tag.toLowerCase().trim(), source: "ai" })
      .onConflictDoNothing()
      .run();
  }
  logActivity(
    "ai",
    "item.inference_applied",
    { type: "item", id },
    { model: inference.model, skippedUserFields: skipped },
  );
  return getItem(id);
}

export function setItemStatus(id: string, status: ItemStatus, actor: Actor = "user"): Item {
  getItem(id); // 404 check
  getDb()
    .update(schema.items)
    .set({ status, updatedAt: nowIso() })
    .where(eq(schema.items.id, id))
    .run();
  logActivity(actor, "item.status_changed", { type: "item", id }, { status });
  return getItem(id);
}

export function confirmDraft(id: string): Item {
  const item = getItem(id);
  if (item.state !== "draft") return item;
  getDb()
    .update(schema.items)
    .set({ state: "active", updatedAt: nowIso() })
    .where(eq(schema.items.id, id))
    .run();
  logActivity("user", "item.confirmed", { type: "item", id });
  return getItem(id);
}

export function archiveItem(id: string): void {
  getItem(id);
  getDb()
    .update(schema.items)
    .set({ state: "archived", updatedAt: nowIso() })
    .where(eq(schema.items.id, id))
    .run();
  logActivity("user", "item.archived", { type: "item", id });
}

export function addTag(id: string, tag: string): Item {
  getItem(id);
  getDb()
    .insert(schema.itemTags)
    .values({ itemId: id, tag: tag.toLowerCase().trim(), source: "user" })
    .onConflictDoUpdate({
      target: [schema.itemTags.itemId, schema.itemTags.tag],
      set: { source: "user" },
    })
    .run();
  return getItem(id);
}

export function removeTag(id: string, tag: string): Item {
  getDb()
    .delete(schema.itemTags)
    .where(and(eq(schema.itemTags.itemId, id), eq(schema.itemTags.tag, tag.toLowerCase().trim())))
    .run();
  return getItem(id);
}
