import { NextResponse } from "next/server";
import { withErrorHandling } from "@/server/lib/errors";
import { deleteOutfit, getOutfit } from "@/server/services/outfits";

type Ctx = { params: Promise<{ id: string }> };

export const GET = withErrorHandling<Ctx>(async (_req, { params }) => {
  const { id } = await params;
  return NextResponse.json({ outfit: getOutfit(id) });
});

export const DELETE = withErrorHandling<Ctx>(async (_req, { params }) => {
  const { id } = await params;
  deleteOutfit(id);
  return NextResponse.json({ ok: true });
});
