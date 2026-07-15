import { eq } from "drizzle-orm";
import { getDb, schema } from "@/server/db/client";

/**
 * Simple key-value settings store.
 * Known keys:
 *   ai.model            — model override for the Agent SDK ("" = Claude Code default)
 *   ai.extractionModel  — model override for import metadata extraction
 */
export const SETTING_KEYS = ["ai.model", "ai.extractionModel"] as const;
export type SettingKey = (typeof SETTING_KEYS)[number];

export function getSetting(key: SettingKey): string | null {
  const row = getDb()
    .select()
    .from(schema.settings)
    .where(eq(schema.settings.key, key))
    .get();
  return row?.value ?? null;
}

export function setSetting(key: SettingKey, value: string): void {
  getDb()
    .insert(schema.settings)
    .values({ key, value })
    .onConflictDoUpdate({ target: schema.settings.key, set: { value } })
    .run();
}

export function getAllSettings(): Record<string, string> {
  const rows = getDb().select().from(schema.settings).all();
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}
