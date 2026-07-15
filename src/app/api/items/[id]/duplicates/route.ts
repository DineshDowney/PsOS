import { NextResponse } from "next/server";
import { withErrorHandling } from "@/server/lib/errors";
import { findDuplicates } from "@/server/services/duplicates";

type Ctx = { params: Promise<{ id: string }> };

export const GET = withErrorHandling<Ctx>(async (_req, { params }) => {
  const { id } = await params;
  return NextResponse.json(findDuplicates(id));
});
