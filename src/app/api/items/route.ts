import { NextResponse } from "next/server";
import { withErrorHandling } from "@/server/lib/errors";
import { listItems } from "@/server/services/catalog";
import type { Category, ItemStatus } from "@/shared/types";

export const GET = withErrorHandling(async (req) => {
  const url = new URL(req.url);
  const p = url.searchParams;
  const items = listItems({
    q: p.get("q") ?? undefined,
    category: (p.get("category") as Category) ?? undefined,
    color: p.get("color") ?? undefined,
    tag: p.get("tag") ?? undefined,
    status: (p.get("status") as ItemStatus) ?? undefined,
    state: (p.get("state") as "draft" | "active") ?? undefined,
  });
  return NextResponse.json({ items });
});
