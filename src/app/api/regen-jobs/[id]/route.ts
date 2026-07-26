import { NextResponse } from "next/server";
import { withErrorHandling } from "@/server/lib/errors";
import { getRegenJob } from "@/server/imaging/regenerate";

type Ctx = { params: Promise<{ id: string }> };

export const GET = withErrorHandling<Ctx>(async (_req, { params }) => {
  const { id } = await params;
  return NextResponse.json({ job: getRegenJob(id) });
});
