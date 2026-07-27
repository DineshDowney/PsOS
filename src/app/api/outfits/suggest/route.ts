import { NextResponse } from "next/server";
import { z } from "zod";
import { badRequest, withErrorHandling } from "@/server/lib/errors";
import { suggestOutfits } from "@/server/services/outfit-stylist";
import { FORMALITIES } from "@/shared/types";

const suggestSchema = z.object({
  formality: z.enum(FORMALITIES).optional(),
  count: z.number().int().min(1).max(8).optional(),
});

export const POST = withErrorHandling(async (req) => {
  const body = await req.json().catch(() => ({}));
  const parsed = suggestSchema.safeParse(body);
  if (!parsed.success) throw badRequest("Invalid request", parsed.error.flatten());

  // Engine shortlists, Gemini ranks, engine validates — see services/outfit-stylist.ts.
  // Takes a few seconds because it looks at the garment images, which is the point.
  const result = await suggestOutfits({
    formality: parsed.data.formality,
    count: parsed.data.count ?? 4,
  });
  return NextResponse.json(result);
});
