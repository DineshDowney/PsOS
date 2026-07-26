import { NextResponse } from "next/server";
import { badRequest, tooLarge, withErrorHandling } from "@/server/lib/errors";
import { listOpenImportJobs, startImport } from "@/server/imports/pipeline";
import { MAX_UPLOAD_BYTES, MAX_UPLOAD_LABEL, megabytes } from "@/server/lib/upload-limits";

export const GET = withErrorHandling(async () => {
  return NextResponse.json({ jobs: listOpenImportJobs() });
});

/**
 * Read the multipart body, turning the two ways it can fail into messages a
 * human can act on.
 *
 * Over-size is checked BEFORE parsing, because Next truncates an over-cap body
 * instead of rejecting it: the parse then dies on the missing closing boundary
 * with "expected boundary after body", which tells the user nothing. Content-
 * Length is client-supplied, so this is a courtesy fast-path, not a security
 * boundary — the real cap is enforced by Next itself.
 */
async function readForm(req: Request): Promise<FormData> {
  const declared = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES) {
    throw tooLarge(
      `Those photos add up to ${megabytes(declared)}, over the ${MAX_UPLOAD_LABEL} limit. Import them one at a time, or shrink them first.`,
    );
  }
  try {
    return await req.formData();
  } catch (err) {
    throw tooLarge(
      `The upload arrived incomplete, which usually means it was over the ${MAX_UPLOAD_LABEL} limit or the connection dropped. Try one photo at a time.`,
      err instanceof Error ? err.message : String(err),
    );
  }
}

/** multipart/form-data: front (required file), back (optional file) */
export const POST = withErrorHandling(async (req) => {
  const form = await readForm(req);
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
