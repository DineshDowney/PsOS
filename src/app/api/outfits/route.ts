import { NextResponse } from "next/server";
import { z } from "zod";
import { badRequest, withErrorHandling } from "@/server/lib/errors";
import { listOutfits, saveOutfit } from "@/server/services/outfits";
import { CATEGORIES } from "@/shared/types";

export const GET = withErrorHandling(async () => {
  return NextResponse.json({ outfits: listOutfits() });
});

const saveSchema = z.object({
  name: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
  items: z.array(z.object({ itemId: z.string(), slot: z.enum(CATEGORIES) })).min(1),
});

export const POST = withErrorHandling(async (req) => {
  const parsed = saveSchema.safeParse(await req.json());
  if (!parsed.success) throw badRequest("Invalid outfit", parsed.error.flatten());
  return NextResponse.json({ outfit: saveOutfit(parsed.data) }, { status: 201 });
});
