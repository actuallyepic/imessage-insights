import Database, { type Database as BetterSqliteDatabase } from "better-sqlite3";
import { resolveDbPath } from "@/lib/imessage/db-path";

let cachedDb: BetterSqliteDatabase | null = null;

export interface DbOptions {
  dbPath?: string;
}

export function getDatabase(options: DbOptions = {}): BetterSqliteDatabase {
  if (cachedDb) {
    return cachedDb;
  }

  const { path: dbPath } = resolveDbPath(options.dbPath);

  cachedDb = new Database(dbPath, {
    readonly: true,
    fileMustExist: true,
  });

  // Improve query performance when we run aggregations.
  cachedDb.pragma("query_only = ON");
  cachedDb.pragma("journal_mode = WAL");

  return cachedDb;
}

export function closeDatabase(): void {
  if (cachedDb) {
    cachedDb.close();
    cachedDb = null;
  }
}
