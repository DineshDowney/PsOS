/**
 * Boot tasks, run in their own process BEFORE the server accepts a request.
 * Wired as npm's `prestart` and `predev` hooks, so `npm start` and `npm run dev`
 * both get it for free and neither can start without it — a non-zero exit here
 * aborts the launch, which is the point.
 *
 * Two jobs:
 *
 *  1. Run migrations. These used to run on the FIRST DB TOUCH (getDb() is lazy),
 *     which meant a new table did not exist until someone loaded a page. Right
 *     after `systemctl restart psos` the schema looked half-deployed, and that
 *     is indistinguishable from a genuinely failed deploy. Now the schema is
 *     current before anything can ask.
 *
 *  2. Recover orphaned jobs. The import and regen queues live in process memory,
 *     so a crash or restart strands whatever was mid-flight as "running"
 *     forever. Marking them here is strictly better than the lazy per-process
 *     hooks this replaces: a separate process that runs BEFORE the server is
 *     unambiguously looking at the previous process's wreckage, so there is no
 *     live job it could mistake for an orphan.
 *
 * Run manually: npx tsx scripts/boot.ts
 */
import { getDb } from "../src/server/db/client";
import { recoverOrphanedJobs } from "../src/server/imports/pipeline";
import { recoverOrphanedRegenJobs } from "../src/server/imaging/regenerate";

function main(): void {
  // Opening the connection is what applies the migrations.
  getDb();
  console.log("[psos] migrations up to date");

  const imports = recoverOrphanedJobs();
  const regens = recoverOrphanedRegenJobs();
  if (imports === 0 && regens === 0) {
    console.log("[psos] no interrupted jobs to recover");
  }
}

try {
  main();
} catch (err) {
  // Loud and fatal: a server whose schema may be stale is worse than one that
  // refused to start.
  console.error("[psos] boot tasks FAILED — not starting:", err);
  process.exit(1);
}
