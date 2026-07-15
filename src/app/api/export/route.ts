import fs from "node:fs";
import { PassThrough } from "node:stream";
import archiver from "archiver";
import { withErrorHandling } from "@/server/lib/errors";
import { dataDir } from "@/server/db/client";
import { logActivity } from "@/server/services/activity";

/** One-click backup: streams a zip of the entire data/ directory. */
export const GET = withErrorHandling(async () => {
  const archive = archiver("zip", { zlib: { level: 6 } });
  const pass = new PassThrough();
  archive.pipe(pass);

  if (fs.existsSync(dataDir)) {
    archive.glob("**/*", {
      cwd: dataDir,
      // WAL/SHM are transient sqlite files; the .db snapshot is what matters.
      ignore: ["stylist.db-wal", "stylist.db-shm"],
    });
  }
  void archive.finalize();

  logActivity("user", "data.exported");
  const filename = `psos-backup-${new Date().toISOString().slice(0, 10)}.zip`;

  const webStream = new ReadableStream({
    start(controller) {
      pass.on("data", (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)));
      pass.on("end", () => controller.close());
      pass.on("error", (err) => controller.error(err));
    },
  });

  return new Response(webStream, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
});
