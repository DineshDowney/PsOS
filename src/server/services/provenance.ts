import type { EditableFields, FieldSource } from "@/shared/types";

/**
 * Field-level provenance — the mechanism behind "AI never overwrites user edits".
 *
 * Every editable field carries a source: "ai" (machine-written) or "user"
 * (human-written). Rules:
 *   1. A user edit sets the field's source to "user", permanently.
 *   2. AI inference may only write fields whose source is "ai" or unset.
 *   3. Clearing a field is still a user edit — the AI won't refill it.
 *
 * Both functions are pure; persistence lives in the catalog service.
 */

export type FieldSources = Record<string, FieldSource>;

export const EDITABLE_FIELD_NAMES = [
  "name",
  "category",
  "subcategory",
  "description",
  "primaryColor",
  "secondaryColors",
  "colorDetail",
  "pattern",
  "fit",
  "material",
  "brand",
  "size",
  "formality",
  "seasons",
  "price",
  "purchaseDate",
] as const satisfies ReadonlyArray<keyof EditableFields>;

function changed(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) !== JSON.stringify(b ?? null);
}

export function applyUserEdits(
  current: EditableFields,
  sources: FieldSources,
  patch: Partial<EditableFields>,
): { fields: EditableFields; sources: FieldSources } {
  const fields = { ...current };
  const nextSources = { ...sources };
  for (const key of EDITABLE_FIELD_NAMES) {
    if (!(key in patch)) continue;
    const value = patch[key];
    if (changed(fields[key], value)) {
      (fields as Record<string, unknown>)[key] = value ?? null;
      nextSources[key] = "user";
    }
  }
  return { fields, sources: nextSources };
}

export function applyAiInference(
  current: EditableFields,
  sources: FieldSources,
  inferred: Partial<EditableFields>,
): { fields: EditableFields; sources: FieldSources; skipped: string[] } {
  const fields = { ...current };
  const nextSources = { ...sources };
  const skipped: string[] = [];
  for (const key of EDITABLE_FIELD_NAMES) {
    if (!(key in inferred)) continue;
    if (nextSources[key] === "user") {
      skipped.push(key);
      continue;
    }
    const value = inferred[key];
    if (value === undefined) continue;
    (fields as Record<string, unknown>)[key] = value ?? null;
    nextSources[key] = "ai";
  }
  return { fields, sources: nextSources, skipped };
}

export function emptyEditableFields(): EditableFields {
  return {
    name: "",
    category: null,
    subcategory: null,
    description: null,
    primaryColor: null,
    secondaryColors: [],
    colorDetail: null,
    pattern: null,
    fit: null,
    material: null,
    brand: null,
    size: null,
    formality: null,
    seasons: [],
    price: null,
    purchaseDate: null,
  };
}
