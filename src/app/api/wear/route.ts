import { NextResponse } from "next/server";
import { z } from "zod";
import { badRequest, withErrorHandling } from "@/server/lib/errors";
import { listWearEvents, logWear } from "@/server/services/wear";

export const GET = withErrorHandling(async (req) => {
  const url = new URL(req.url);
  const itemId = url.searchParams.get("itemId") ?? undefined;
  const limit = Number(url.searchParams.get("limit") ?? 50);
  return NextResponse.json({ events: listWearEvents({ itemId, limit }) });
});

const logSchema = z.object({
  itemIds: z.array(z.string()).min(1),
  wornOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  outfitId: z.string().nullable().optional(),
  occasion: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
  sendToLaundry: z.boolean().optional(),
});

export const POST = withErrorHandling(async (req) => {
  const parsed = logSchema.safeParse(await req.json());
  if (!parsed.success) throw badRequest("Invalid wear log", parsed.error.flatten());
  return NextResponse.json({ event: logWear(parsed.data) }, { status: 201 });
});
