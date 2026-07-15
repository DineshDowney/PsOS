import { NextResponse } from "next/server";
import { withErrorHandling } from "@/server/lib/errors";
import { getImportJob } from "@/server/imports/pipeline";

type Ctx = { params: Promise<{ id: string }> };

export const GET = withErrorHandling<Ctx>(async (_req, { params }) => {
  const { id } = await params;
  return NextResponse.json({ job: getImportJob(id) });
});
