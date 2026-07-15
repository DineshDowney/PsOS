import { getDb, schema } from "@/server/db/client";
import { newId, nowIso } from "@/server/lib/ids";
import { toJson } from "@/server/lib/json";

export type Actor = "user" | "ai" | "system";

/**
 * Append an entry to the activity log. Never throws — logging must not break
 * the operation being logged — but failures are printed, not swallowed silently.
 */
export function logActivity(
  actor: Actor,
  action: string,
  entity?: { type: string; id: string },
  detail?: Record<string, unknown>,
): void {
  try {
    getDb()
      .insert(schema.activityLog)
      .values({
        id: newId(),
        ts: nowIso(),
        actor,
        action,
        entityType: entity?.type ?? null,
        entityId: entity?.id ?? null,
        detail: detail ? toJson(detail) : null,
      })
      .run();
  } catch (err) {
    console.error("[psos] failed to write activity log:", err);
  }
}
