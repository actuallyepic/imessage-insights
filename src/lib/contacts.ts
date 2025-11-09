import Database, { type Database as BetterSqliteDatabase } from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

type ContactLookup = Map<string, ContactRecord>;

interface ContactRecord {
  recordId: number | null;
  displayName: string;
}

export interface ContactMatch {
  recordId: number | null;
  name: string;
}

let cachedLookup: ContactLookup | null = null;
let attemptedLoad = false;

export function getContactNameForHandle(identifier: string | null | undefined): string | null {
  return getContactInfoForHandle(identifier)?.name ?? null;
}

export function getContactInfoForHandle(identifier: string | null | undefined): ContactMatch | null {
  if (!identifier) {
    return null;
  }

  const normalized = normalizeHandleIdentifier(identifier);
  if (!normalized) {
    return null;
  }

  const lookup = loadContactLookup();
  const record = lookup.get(normalized);
  if (!record) {
    return null;
  }
  return {
    recordId: record.recordId,
    name: record.displayName,
  };
}

export function normalizeHandleIdentifier(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  let trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const schemePattern = /^(mailto:|email:|e:|tel:|phone:|sms:)/i;
  while (schemePattern.test(trimmed)) {
    trimmed = trimmed.replace(schemePattern, "");
  }

  trimmed = trimmed.replace(/^\/+/, "").replace(/^\\+/, "");

  if (trimmed.includes("@")) {
    const email = trimmed.split(/[?#]/, 1)[0];
    return email.toLowerCase();
  }

  const digitsOnly = trimmed.replace(/[^0-9+]/g, "");
  if (!digitsOnly) {
    return trimmed;
  }

  if (digitsOnly.startsWith("+")) {
    return `+${digitsOnly.replace(/[^0-9]/g, "")}`;
  }

  const numeric = digitsOnly.replace(/\D/g, "");
  if (!numeric) {
    return trimmed;
  }

  if (numeric.startsWith("00") && numeric.length > 4) {
    return `+${numeric.slice(2)}`;
  }

  if (numeric.length === 11 && numeric.startsWith("1")) {
    return `+${numeric}`;
  }

  if (numeric.length === 10) {
    return `+1${numeric}`;
  }

  return numeric;
}

function loadContactLookup(): ContactLookup {
  if (cachedLookup) {
    return cachedLookup;
  }

  if (attemptedLoad) {
    return new Map();
  }

  attemptedLoad = true;

  const lookup: ContactLookup = new Map();
  const dbPaths = discoverContactDatabases();

  for (const dbPath of dbPaths) {
    try {
      mergeContactsFromDb(dbPath, lookup);
    } catch (error) {
      console.warn(`Unable to read contacts database at ${dbPath}:`, error);
    }
  }

  cachedLookup = lookup;
  return lookup;
}

function discoverContactDatabases(): string[] {
  const baseDir = path.join(
    os.homedir(),
    "Library",
    "Application Support",
    "AddressBook",
  );

  const results: string[] = [];
  const seen = new Set<string>();

  function walk(directory: string, depth: number) {
    if (depth > 4) {
      return;
    }

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isFile()) {
        if (entry.name.startsWith("AddressBook") && entry.name.endsWith(".abcddb")) {
          if (!seen.has(fullPath)) {
            results.push(fullPath);
            seen.add(fullPath);
          }
        }
      } else if (entry.isDirectory()) {
        walk(fullPath, depth + 1);
      }
    }
  }

  try {
    const stats = fs.statSync(baseDir);
    if (stats.isDirectory()) {
      walk(baseDir, 0);
    }
  } catch {
    return [];
  }

  return results;
}

function mergeContactsFromDb(dbPath: string, lookup: ContactLookup) {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    db.pragma("query_only = ON");
  } catch {
    // Older macOS versions might not support this pragma.
  }

  try {
    if (!hasTable(db, "ZABCDRECORD")) {
      return;
    }

    const recordStmt = db.prepare(`
      SELECT
        Z_PK AS recordId,
        ZFIRSTNAME,
        ZMIDDLENAME,
        ZLASTNAME,
        ZNICKNAME,
        ZORGANIZATION,
        ZNAME,
        ZNAME1
      FROM ZABCDRECORD
      WHERE Z_ENT = 22
    `);

    const recordRows = recordStmt.all() as Array<Record<string, unknown>>;
    const recordNames = new Map<number, string>();

    for (const row of recordRows) {
      const recordId = typeof row.recordId === "number" ? row.recordId : Number(row.recordId);
      if (!Number.isFinite(recordId)) {
        continue;
      }

      const displayName = buildDisplayName(row);
      if (displayName) {
        recordNames.set(recordId, displayName);
      }
    }

    if (recordNames.size === 0) {
      return;
    }

    if (hasTable(db, "ZABCDPHONENUMBER")) {
      const phoneStmt = db.prepare(`
        SELECT
          ZOWNER AS recordId,
          ZFULLNUMBER,
          ZAREACODE,
          ZLOCALNUMBER,
          ZCOUNTRYCODE
        FROM ZABCDPHONENUMBER
      `);
      const phoneRows = phoneStmt.all() as Array<Record<string, unknown>>;
      for (const row of phoneRows) {
        const recordId = Number((row as { recordId?: unknown }).recordId ?? null);
        if (!Number.isFinite(recordId)) {
          continue;
        }
        const name = recordNames.get(recordId);
        if (!name) {
          continue;
        }
        const value = extractPhoneNumber(row);
        addContactValue(lookup, value, name, recordId);
      }
    }

    if (hasTable(db, "ZABCDEMAILADDRESS")) {
      const emailStmt = db.prepare(`
        SELECT ZOWNER AS recordId, ZADDRESS, ZADDRESSNORMALIZED
        FROM ZABCDEMAILADDRESS
        WHERE ZADDRESS IS NOT NULL
      `);
      const emailRows = emailStmt.all() as Array<{ recordId: number; ZADDRESS?: string; ZADDRESSNORMALIZED?: string }>;
      for (const row of emailRows) {
        const recordId = Number(row.recordId ?? null);
        if (!Number.isFinite(recordId)) {
          continue;
        }
        const name = recordNames.get(recordId);
        if (!name) {
          continue;
        }
        addContactValue(lookup, row.ZADDRESSNORMALIZED ?? row.ZADDRESS ?? null, name, recordId);
      }
    }

    if (hasTable(db, "ZABCDMESSAGINGADDRESS")) {
      const messagingStmt = db.prepare(`
        SELECT ZOWNER AS recordId, ZADDRESS
        FROM ZABCDMESSAGINGADDRESS
        WHERE ZADDRESS IS NOT NULL
      `);
      const messagingRows = messagingStmt.all() as Array<{ recordId: number; ZADDRESS?: string }>;
      for (const row of messagingRows) {
        const recordId = Number(row.recordId ?? null);
        if (!Number.isFinite(recordId)) {
          continue;
        }
        const name = recordNames.get(recordId);
        if (!name) {
          continue;
        }
        addContactValue(lookup, row.ZADDRESS ?? null, name, recordId);
      }
    }
  } finally {
    db.close();
  }
}

function hasTable(db: BetterSqliteDatabase, table: string): boolean {
  try {
    const stmt = db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
    );
    return Boolean(stmt.get(table));
  } catch {
    return false;
  }
}

function buildDisplayName(row: Record<string, unknown>): string | null {
  const first = pickField(row, ["ZFIRSTNAME", "FIRST"]);
  const middle = pickField(row, ["ZMIDDLENAME", "MIDDLENAME"]);
  const last = pickField(row, ["ZLASTNAME", "LAST"]);
  const nickname = pickField(row, ["ZNICKNAME", "NICKNAME"]);
  const organization = pickField(row, ["ZORGANIZATION", "ORGANIZATION"]);
  const fallback = pickField(row, ["ZNAME", "ZNAME1", "NAME"]);

  const pieces = [first, middle, last].filter(Boolean) as string[];
  if (pieces.length > 0) {
    return pieces.join(" ");
  }

  if (nickname) {
    return nickname;
  }

  if (fallback) {
    return fallback;
  }

  if (organization) {
    return organization;
  }

  return null;
}

function pickField(row: Record<string, unknown>, candidates: string[]): string | null {
  const entries = Object.entries(row);
  for (const [key, value] of entries) {
    if (typeof value !== "string" || value.trim().length === 0) {
      continue;
    }
    const lowerKey = key.toLowerCase();
    if (candidates.some((candidate) => candidate.toLowerCase() === lowerKey)) {
      return value.trim();
    }
  }
  return null;
}

function extractPhoneNumber(row: Record<string, unknown>): string | null {
  const fullValue = row.ZFULLNUMBER;
  const full =
    typeof fullValue === "string"
      ? fullValue.trim()
      : typeof fullValue === "number"
        ? String(fullValue)
        : "";
  if (full) {
    return full;
  }

  const parts = [row.ZCOUNTRYCODE, row.ZAREACODE, row.ZLOCALNUMBER]
    .map((value) => {
      if (typeof value === "string") {
        return value.trim();
      }
      if (typeof value === "number") {
        return String(value);
      }
      return "";
    })
    .filter(Boolean);

  if (parts.length > 0) {
    return parts.join(" ");
  }

  return null;
}

function addContactValue(
  lookup: ContactLookup,
  rawValue: string | null | undefined,
  displayName: string,
  recordId: number | null,
) {
  if (!rawValue || !displayName) {
    return;
  }

  const normalized = normalizeHandleIdentifier(rawValue);
  if (!normalized) {
    return;
  }

  if (!lookup.has(normalized)) {
    lookup.set(normalized, { recordId, displayName });
  }
}
