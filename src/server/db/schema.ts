import {
  sqliteTable,
  text,
  integer,
  real,
  primaryKey,
  index,
} from "drizzle-orm/sqlite-core";

/**
 * Personal Stylist OS — database schema.
 *
 * Conventions:
 * - IDs are UUIDv4 strings.
 * - Timestamps are ISO-8601 strings (UTC). Dates (worn_on, plan_date) are "YYYY-MM-DD".
 * - JSON columns are TEXT holding JSON; typed accessors live in the services layer.
 * - `field_sources` on items maps field name -> "ai" | "user". AI inference may only
 *   write a field whose source is "ai" or unset. Any user edit flips it to "user"
 *   permanently. This is the mechanism behind "AI never overwrites user edits".
 */

export const items = sqliteTable(
  "items",
  {
    id: text("id").primaryKey(),
    /** draft = mid-import (review pending), active = in catalog, archived = soft-deleted */
    state: text("state", { enum: ["draft", "active", "archived"] })
      .notNull()
      .default("draft"),
    /** availability for outfit generation */
    status: text("status", { enum: ["available", "laundry", "unavailable"] })
      .notNull()
      .default("available"),

    name: text("name").notNull().default(""),
    category: text("category", {
      enum: ["top", "bottom", "full_body", "outerwear", "footwear", "accessory"],
    }),
    subcategory: text("subcategory"),
    /** AI-drafted, user-editable description */
    description: text("description"),
    /** user-only notes — AI never touches this */
    notes: text("notes"),

    primaryColor: text("primary_color"),
    /** JSON string[] */
    secondaryColors: text("secondary_colors"),
    colorDetail: text("color_detail"),
    pattern: text("pattern"),
    fit: text("fit"),
    material: text("material"),
    brand: text("brand"),
    size: text("size"),
    formality: text("formality", {
      enum: ["casual", "smart_casual", "business", "formal", "athletic"],
    }),
    /** JSON string[] of "summer" | "winter" | "monsoon" | "all_season" */
    seasons: text("seasons"),
    price: real("price"),
    purchaseDate: text("purchase_date"),

    /** denormalized caches of wear_events */
    wearCount: integer("wear_count").notNull().default(0),
    lastWornAt: text("last_worn_at"),

    /** JSON Record<string, "ai" | "user"> — field provenance */
    fieldSources: text("field_sources").notNull().default("{}"),
    /** JSON — full raw AI inference incl. per-field confidence; never mutated after import */
    aiRaw: text("ai_raw"),

    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [index("items_state_idx").on(t.state), index("items_status_idx").on(t.status)],
);

export const itemImages = sqliteTable(
  "item_images",
  {
    id: text("id").primaryKey(),
    itemId: text("item_id")
      .notNull()
      .references(() => items.id, { onDelete: "cascade" }),
    role: text("role", {
      enum: ["front", "back", "transparent_front", "transparent_back", "thumbnail"],
    }).notNull(),
    /** path relative to the data/images root */
    path: text("path").notNull(),
    width: integer("width"),
    height: integer("height"),
    sha256: text("sha256"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("item_images_item_idx").on(t.itemId)],
);

export const itemTags = sqliteTable(
  "item_tags",
  {
    itemId: text("item_id")
      .notNull()
      .references(() => items.id, { onDelete: "cascade" }),
    tag: text("tag").notNull(),
    source: text("source", { enum: ["ai", "user"] }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.itemId, t.tag] })],
);

export const itemLinks = sqliteTable("item_links", {
  id: text("id").primaryKey(),
  itemAId: text("item_a_id")
    .notNull()
    .references(() => items.id, { onDelete: "cascade" }),
  itemBId: text("item_b_id")
    .notNull()
    .references(() => items.id, { onDelete: "cascade" }),
  relation: text("relation", {
    enum: ["pairs_well", "same_set", "similar"],
  }).notNull(),
  note: text("note"),
  createdAt: text("created_at").notNull(),
});

export const outfits = sqliteTable("outfits", {
  id: text("id").primaryKey(),
  name: text("name"),
  source: text("source", { enum: ["user", "ai"] }).notNull().default("user"),
  notes: text("notes"),
  createdAt: text("created_at").notNull(),
});

export const outfitItems = sqliteTable(
  "outfit_items",
  {
    outfitId: text("outfit_id")
      .notNull()
      .references(() => outfits.id, { onDelete: "cascade" }),
    itemId: text("item_id")
      .notNull()
      .references(() => items.id, { onDelete: "cascade" }),
    slot: text("slot", {
      enum: ["top", "bottom", "full_body", "outerwear", "footwear", "accessory"],
    }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.outfitId, t.itemId] })],
);

/** Event-sourced wear history. wear_count / last_worn_at on items are caches of this. */
export const wearEvents = sqliteTable(
  "wear_events",
  {
    id: text("id").primaryKey(),
    /** YYYY-MM-DD */
    wornOn: text("worn_on").notNull(),
    outfitId: text("outfit_id").references(() => outfits.id, { onDelete: "set null" }),
    occasion: text("occasion"),
    notes: text("notes"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("wear_events_date_idx").on(t.wornOn)],
);

export const wearEventItems = sqliteTable(
  "wear_event_items",
  {
    wearEventId: text("wear_event_id")
      .notNull()
      .references(() => wearEvents.id, { onDelete: "cascade" }),
    itemId: text("item_id")
      .notNull()
      .references(() => items.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.wearEventId, t.itemId] })],
);

/** Calendar: planned outfits for future (or past) dates. */
export const plans = sqliteTable(
  "plans",
  {
    id: text("id").primaryKey(),
    /** YYYY-MM-DD */
    planDate: text("plan_date").notNull(),
    outfitId: text("outfit_id")
      .notNull()
      .references(() => outfits.id, { onDelete: "cascade" }),
    status: text("status", { enum: ["planned", "worn", "skipped"] })
      .notNull()
      .default("planned"),
    notes: text("notes"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("plans_date_idx").on(t.planDate)],
);

/** Travel — schema ships in Phase 1, UI comes later. */
export const trips = sqliteTable("trips", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  destination: text("destination"),
  startDate: text("start_date"),
  endDate: text("end_date"),
  notes: text("notes"),
  createdAt: text("created_at").notNull(),
});

export const tripItems = sqliteTable(
  "trip_items",
  {
    tripId: text("trip_id")
      .notNull()
      .references(() => trips.id, { onDelete: "cascade" }),
    itemId: text("item_id")
      .notNull()
      .references(() => items.id, { onDelete: "cascade" }),
    packed: integer("packed", { mode: "boolean" }).notNull().default(false),
  },
  (t) => [primaryKey({ columns: [t.tripId, t.itemId] })],
);

export const chatSessions = sqliteTable("chat_sessions", {
  id: text("id").primaryKey(),
  title: text("title"),
  /** Claude Agent SDK session id, for resuming conversations */
  sdkSessionId: text("sdk_session_id"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const chatMessages = sqliteTable(
  "chat_messages",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => chatSessions.id, { onDelete: "cascade" }),
    role: text("role", { enum: ["user", "assistant"] }).notNull(),
    /** JSON content blocks: [{type:"text",text} | {type:"tool_use",name,summary}] */
    content: text("content").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("chat_messages_session_idx").on(t.sessionId)],
);

/** Import pipeline progress, one row per imported (draft) item. */
export const importJobs = sqliteTable("import_jobs", {
  id: text("id").primaryKey(),
  itemId: text("item_id")
    .notNull()
    .references(() => items.id, { onDelete: "cascade" }),
  /**
   * JSON Record<stage, {status: "pending"|"running"|"done"|"failed", error?: string}>
   * stages: save, background_removal, thumbnail, colors, ai_metadata
   */
  stages: text("stages").notNull(),
  /** queued = waiting for a worker slot; enum is TS-level only (no DB CHECK) */
  status: text("status", { enum: ["queued", "running", "ready_for_review", "failed"] })
    .notNull()
    .default("queued"),
  error: text("error"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

/** Audit trail for user, AI and system actions. Doubles as the AI action log. */
export const activityLog = sqliteTable(
  "activity_log",
  {
    id: text("id").primaryKey(),
    ts: text("ts").notNull(),
    actor: text("actor", { enum: ["user", "ai", "system"] }).notNull(),
    action: text("action").notNull(),
    entityType: text("entity_type"),
    entityId: text("entity_id"),
    /** JSON detail payload */
    detail: text("detail"),
  },
  (t) => [index("activity_ts_idx").on(t.ts)],
);

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});
