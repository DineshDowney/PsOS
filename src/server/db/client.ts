import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import path from "node:path";
import fs from "node:fs";
import * as schema from "./schema";

export type DB = BetterSQLite3Database<typeof schema>;

const DATA_DIR = path.join(process.cwd(), "data");
const DB_PATH = path.join(DATA_DIR, "stylist.db");
const MIGRATIONS_DIR = path.join(process.cwd(), "drizzle");

/**
 * Singleton DB connection. Survives Next.js dev-server module reloads by
 * stashing the instance on globalThis.
 */
const globalForDb = globalThis as unknown as { __psosDb?: DB };

function createDb(): DB {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const sqlite = new Database(DB_PATH);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: MIGRATIONS_DIR });
  return db;
}

export function getDb(): DB {
  if (!globalForDb.__psosDb) {
    globalForDb.__psosDb = createDb();
  }
  return globalForDb.__psosDb;
}

export { schema };
export const dataDir = DATA_DIR;
