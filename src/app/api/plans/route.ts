import { NextResponse } from "next/server";
import { z } from "zod";
import { badRequest, withErrorHandling } from "@/server/lib/errors";
import { createPlan, listPlans } from "@/server/services/plans";

export const GET = withErrorHandling(async (req) => {
  const url = new URL(req.url);
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  if (!from || !to) throw badRequest("from and to (YYYY-MM-DD) are required");
  return NextResponse.json({ plans: listPlans(from, to) });
});

const createSchema = z.object({
  planDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  outfitId: z.string(),
  notes: z.string().nullable().optional(),
});

export const POST = withErrorHandling(async (req) => {
  const parsed = createSchema.safeParse(await req.json());
  if (!parsed.success) throw badRequest("Invalid plan", parsed.error.flatten());
  return NextResponse.json({ plan: createPlan(parsed.data) }, { status: 201 });
});
