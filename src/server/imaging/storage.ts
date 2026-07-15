import path from "node:path";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { dataDir } from "@/server/db/client";

/**
 * Image file storage. Layout: data/images/<itemId>/<role>.<ext>
 * DB rows store paths relative to the images root; the /api/images route
 * serves them. Originals are never deleted or overwritten by the pipeline.
 */

export const imagesRoot = path.join(dataDir, "images");

export function itemImageDir(itemId: string): string {
  const dir = path.join(imagesRoot, itemId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function relativeImagePath(absPath: string): string {
  return path.relative(imagesRoot, absPath).split(path.sep).join("/");
}

/** Resolve a relative image path safely (no traversal outside the root). */
export function resolveImagePath(relPath: string): string {
  const abs = path.resolve(imagesRoot, relPath);
  const root = path.resolve(imagesRoot);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new Error("Invalid image path");
  }
  return abs;
}

export function sha256Of(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

export async function saveBuffer(absPath: string, buffer: Buffer): Promise<void> {
  await fs.promises.mkdir(path.dirname(absPath), { recursive: true });
  await fs.promises.writeFile(absPath, buffer);
}
