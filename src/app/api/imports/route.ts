import { NextResponse } from "next/server";
import { badRequest, withErrorHandling } from "@/server/lib/errors";
import { listOpenImportJobs, startImport } from "@/server/imports/pipeline";

export const GET = withErrorHandling(async () => {
  return NextResponse.json({ jobs: listOpenImportJobs() });
});

/** multipart/form-data: front (required file), back (optional file) */
export const POST = withErrorHandling(async (req) => {
  const form = await req.formData();
  const front = form.get("front");
  const back = form.get("back");
  if (!(front instanceof File) || front.size === 0) {
    throw badRequest("A front photo is required (field name: front)");
  }
  const frontBuf = Buffer.from(await front.arrayBuffer());
  const backBuf =
    back instanceof File && back.size > 0 ? Buffer.from(await back.arrayBuffer()) : null;
  const job = startImport({ front: frontBuf, back: backBuf });
  return NextResponse.json({ job }, { status: 201 });
});
