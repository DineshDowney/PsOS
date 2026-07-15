import fs from "node:fs";
import { withErrorHandling, notFound } from "@/server/lib/errors";
import { resolveImagePath } from "@/server/imaging/storage";

type Ctx = { params: Promise<{ path: string[] }> };

const CONTENT_TYPES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

export const GET = withErrorHandling<Ctx>(async (_req, { params }) => {
  const { path: segments } = await params;
  const rel = segments.map(decodeURIComponent).join("/");
  const abs = resolveImagePath(rel);
  if (!fs.existsSync(abs)) throw notFound("Image");
  const ext = abs.slice(abs.lastIndexOf(".")).toLowerCase();
  const data = await fs.promises.readFile(abs);
  return new Response(new Uint8Array(data), {
    headers: {
      "Content-Type": CONTENT_TYPES[ext] ?? "application/octet-stream",
      "Cache-Control": "private, max-age=31536000, immutable",
    },
  });
});
