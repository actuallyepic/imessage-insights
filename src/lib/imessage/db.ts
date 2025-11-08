import Database, { type Database as BetterSqliteDatabase } from "better-sqlite3";
import path from "node:path";
import os from "node:os";

let cachedDb: BetterSqliteDatabase | null = null;

function resolveDbPath(provided?: string): string {
  if (provided && provided.trim().length > 0) {
    return path.resolve(provided);
  }

  return path.join(os.homedir(), "Library", "Messages", "chat.db");
}

export interface DbOptions {
  dbPath?: string;
}

export function getDatabase(options: DbOptions = {}): BetterSqliteDatabase {
  if (cachedDb) {
    return cachedDb;
  }

  const dbPath = resolveDbPath(options.dbPath ?? process.env.IMESSAGE_DB_PATH);

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

