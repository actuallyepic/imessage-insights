import Database, { type Database as BetterSqliteDatabase } from "better-sqlite3";
import os from "node:os";
import path from "node:path";

let cachedDb: BetterSqliteDatabase | null = null;

function resolveDbPath(provided?: string): string {
  if (provided && provided.trim().length > 0) {
    return path.resolve(provided);
  }

  return path.join(
    os.homedir(),
    "Library",
    "Application Support",
    "CallHistoryDB",
    "CallHistory.storedata",
  );
}

export interface DbOptions {
  dbPath?: string;
}

export function getCallHistoryDatabase(options: DbOptions = {}): BetterSqliteDatabase {
  if (cachedDb) {
    return cachedDb;
  }

  const dbPath = resolveDbPath(options.dbPath ?? process.env.CALLHISTORY_DB_PATH);

  cachedDb = new Database(dbPath, {
    readonly: true,
    fileMustExist: true,
  });

  // Ensure the connection is query-only even if a consumer tries to run a write query.
  cachedDb.pragma("query_only = ON");

  // The CallHistory store is typically in WAL mode on modern macOS. Keep this in sync with the store
  // to improve read performance, but ignore failures on older SQLite versions / read-only stores.
  try {
    cachedDb.pragma("journal_mode = WAL");
  } catch {
    // ignore
  }

  return cachedDb;
}

export function closeCallHistoryDatabase(): void {
  if (cachedDb) {
    cachedDb.close();
    cachedDb = null;
  }
}

