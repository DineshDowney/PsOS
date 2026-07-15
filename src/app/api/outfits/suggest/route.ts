import { NextResponse } from "next/server";
import { z } from "zod";
import { badRequest, withErrorHandling } from "@/server/lib/errors";
import { generateOutfits } from "@/server/engine/outfit-engine";
import { listItems } from "@/server/services/catalog";
import { recentWearCombos } from "@/server/services/wear";
import { FORMALITIES } from "@/shared/types";

const suggestSchema = z.object({
  formality: z.enum(FORMALITIES).optional(),
  count: z.number().int().min(1).max(8).optional(),
});

export const POST = withErrorHandling(async (req) => {
  const body = await req.json().catch(() => ({}));
  const parsed = suggestSchema.safeParse(body);
  if (!parsed.success) throw badRequest("Invalid request", parsed.error.flatten());
  const suggestions = generateOutfits(listItems(), {
    recentCombos: recentWearCombos(),
    formality: parsed.data.formality,
    count: parsed.data.count ?? 4,
  });
  return NextResponse.json({ suggestions });
});
