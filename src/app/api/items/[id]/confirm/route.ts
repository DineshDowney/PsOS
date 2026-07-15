import { NextResponse } from "next/server";
import { withErrorHandling } from "@/server/lib/errors";
import { confirmDraft } from "@/server/services/catalog";

type Ctx = { params: Promise<{ id: string }> };

export const POST = withErrorHandling<Ctx>(async (_req, { params }) => {
  const { id } = await params;
  return NextResponse.json({ item: confirmDraft(id) });
});
