/**
 * Minimal .env loader for tsx scripts.
 *
 * Next.js loads .env.local for the app automatically; standalone scripts
 * (`npx tsx scripts/...`) do not get that, and the Vertex key lives there. No
 * dotenv dependency for ~15 lines. Existing process.env always wins.
 */
import fs from "node:fs";
import path from "node:path";

export function loadEnvFile(file = ".env.local"): void {
  const abs = path.resolve(process.cwd(), file);
  if (!fs.existsSync(abs)) return;
  for (const line of fs.readFileSync(abs, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
