import { NextResponse } from "next/server";
import { z } from "zod";
import { badRequest, withErrorHandling } from "@/server/lib/errors";
import { deletePlan, setPlanStatus } from "@/server/services/plans";

type Ctx = { params: Promise<{ id: string }> };

const patchSchema = z.object({
  status: z.enum(["planned", "worn", "skipped"]),
  sendToLaundry: z.boolean().optional(),
});

export const PATCH = withErrorHandling<Ctx>(async (req, { params }) => {
  const { id } = await params;
  const parsed = patchSchema.safeParse(await req.json());
  if (!parsed.success) throw badRequest("Invalid plan update", parsed.error.flatten());
  return NextResponse.json({
    plan: setPlanStatus(id, parsed.data.status, {
      sendToLaundry: parsed.data.sendToLaundry,
    }),
  });
});

export const DELETE = withErrorHandling<Ctx>(async (_req, { params }) => {
  const { id } = await params;
  deletePlan(id);
  return NextResponse.json({ ok: true });
});
