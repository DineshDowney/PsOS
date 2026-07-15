import { NextResponse } from "next/server";
import { desc } from "drizzle-orm";
import { withErrorHandling } from "@/server/lib/errors";
import { getDb, schema } from "@/server/db/client";
import { parseJson } from "@/server/lib/json";

export const GET = withErrorHandling(async (req) => {
  const limit = Number(new URL(req.url).searchParams.get("limit") ?? 100);
  const rows = getDb()
    .select()
    .from(schema.activityLog)
    .orderBy(desc(schema.activityLog.ts))
    .limit(Math.min(limit, 500))
    .all();
  return NextResponse.json({
    entries: rows.map((r) => ({
      id: r.id,
      ts: r.ts,
      actor: r.actor,
      action: r.action,
      entityType: r.entityType,
      entityId: r.entityId,
      detail: parseJson<Record<string, unknown> | null>(r.detail, null),
    })),
  });
});
