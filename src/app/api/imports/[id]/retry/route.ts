import { NextResponse } from "next/server";
import { withErrorHandling } from "@/server/lib/errors";
import { retryImport } from "@/server/imports/pipeline";

type Ctx = { params: Promise<{ id: string }> };

export const POST = withErrorHandling<Ctx>(async (_req, { params }) => {
  const { id } = await params;
  return NextResponse.json({ job: retryImport(id) });
});
