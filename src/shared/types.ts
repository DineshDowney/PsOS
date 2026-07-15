/**
 * Shared domain types used by both the server layer and React components.
 * These mirror the DB rows but with JSON columns parsed into real types.
 */

export const CATEGORIES = [
  "top",
  "bottom",
  "full_body",
  "outerwear",
  "footwear",
  "accessory",
] as const;
export type Category = (typeof CATEGORIES)[number];

export const FORMALITIES = [
  "casual",
  "smart_casual",
  "business",
  "formal",
  "athletic",
] as const;
export type Formality = (typeof FORMALITIES)[number];

export const SEASONS = ["summer", "winter", "monsoon", "all_season"] as const;
export type Season = (typeof SEASONS)[number];

export type ItemState = "draft" | "active" | "archived";
export type ItemStatus = "available" | "laundry" | "unavailable";
export type FieldSource = "ai" | "user";

export type ImageRole =
  | "front"
  | "back"
  | "front_cropped"
  | "back_cropped"
  | "transparent_front"
  | "transparent_back"
  | "thumbnail";

export interface ItemImage {
  id: string;
  role: ImageRole;
  /** URL path servable via /api/images/<path> */
  url: string;
  width: number | null;
  height: number | null;
}

export interface ItemTag {
  tag: string;
  source: FieldSource;
}

/** Fields the user can edit and the AI can infer — provenance is tracked per field. */
export interface EditableFields {
  name: string;
  category: Category | null;
  subcategory: string | null;
  description: string | null;
  primaryColor: string | null;
  secondaryColors: string[];
  colorDetail: string | null;
  pattern: string | null;
  fit: string | null;
  material: string | null;
  brand: string | null;
  size: string | null;
  formality: Formality | null;
  seasons: Season[];
  price: number | null;
  purchaseDate: string | null;
}

export interface Item extends EditableFields {
  id: string;
  state: ItemState;
  status: ItemStatus;
  /** user-only, never AI-written */
  notes: string | null;
  wearCount: number;
  lastWornAt: string | null;
  fieldSources: Record<string, FieldSource>;
  images: ItemImage[];
  tags: ItemTag[];
  createdAt: string;
  updatedAt: string;
}

export interface AiFieldConfidence {
  value: unknown;
  confidence: number; // 0..1
}

/**
 * Normalized garment bounding box in the front photo — fractions 0..1 of image
 * width/height, (x, y) = top-left corner. Used to crop the catalog thumbnail
 * tight to the garment (excludes tripod, feet, background). Not user-editable.
 */
export interface BBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface AiInference {
  fields: Partial<EditableFields>;
  confidence: Record<string, number>;
  tags: string[];
  /** garment box in the front photo, for tight thumbnail cropping; null if unlocatable */
  bbox?: BBox | null;
  /** garment box in the back photo (when one was provided); null if unlocatable */
  bboxBack?: BBox | null;
  model: string;
  extractedAt: string;
}

export type ImportStage =
  | "save"
  | "background_removal"
  | "thumbnail"
  | "colors"
  | "ai_metadata";

export interface StageInfo {
  status: "pending" | "running" | "done" | "failed";
  error?: string;
}

export interface ImportJob {
  id: string;
  itemId: string;
  status: "queued" | "running" | "ready_for_review" | "failed";
  stages: Record<ImportStage, StageInfo>;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  item?: Item;
}

export interface Outfit {
  id: string;
  name: string | null;
  source: "user" | "ai";
  notes: string | null;
  createdAt: string;
  items: Array<{ item: Item; slot: Category }>;
}

export interface OutfitSuggestion {
  items: Array<{ item: Item; slot: Category }>;
  score: number;
}

export interface WearEvent {
  id: string;
  wornOn: string;
  outfitId: string | null;
  occasion: string | null;
  notes: string | null;
  items: Item[];
}

export interface Plan {
  id: string;
  planDate: string;
  status: "planned" | "worn" | "skipped";
  notes: string | null;
  outfit: Outfit;
}

export interface ChatMessageBlock {
  type: "text" | "tool_use";
  text?: string;
  toolName?: string;
  toolSummary?: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: ChatMessageBlock[];
  createdAt: string;
}

export interface ChatSession {
  id: string;
  title: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ActivityEntry {
  id: string;
  ts: string;
  actor: "user" | "ai" | "system";
  action: string;
  entityType: string | null;
  entityId: string | null;
  detail: Record<string, unknown> | null;
}

export interface AnalyticsSummary {
  totalItems: number;
  byCategory: Array<{ category: string; count: number }>;
  byColor: Array<{ color: string; count: number }>;
  byStatus: Array<{ status: string; count: number }>;
  mostWorn: Array<{ item: Item; wearCount: number }>;
  leastWorn: Array<{ item: Item; wearCount: number }>;
  wearsByWeek: Array<{ week: string; count: number }>;
}
