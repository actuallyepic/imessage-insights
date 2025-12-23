import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { readSettings, writeSettings, getSettingsFilePath } from "@/lib/settings";

export type DbPathSource = "explicit" | "env" | "settings" | "auto" | "default" | "none";

export interface DbPathCandidate {
  path: string;
  exists: boolean;
}

export interface DbPathStatus {
  currentPath: string | null;
  source: DbPathSource;
  exists: boolean;
  envPath: string | null;
  savedPath: string | null;
  settingsFile: string;
  candidates: DbPathCandidate[];
}

const DEFAULT_CANDIDATES = [
  path.join(os.homedir(), "Library", "Messages", "chat.db"),
  path.join(os.homedir(), "Library", "Containers", "com.apple.iChat", "Data", "Library", "Messages", "chat.db"),
  path.join(os.homedir(), "Library", "Containers", "com.apple.Messages", "Data", "Library", "Messages", "chat.db"),
];

function expandHome(value: string): string {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

function normalizeDbPath(value: string): string {
  const expanded = expandHome(value.trim());
  const resolved = path.resolve(expanded);
  if (path.extname(resolved) === "") {
    return path.join(resolved, "chat.db");
  }
  return resolved;
}

function safeExists(target: string): boolean {
  try {
    return fs.existsSync(target);
  } catch {
    return false;
  }
}

export function getCandidateDbPaths(): DbPathCandidate[] {
  return DEFAULT_CANDIDATES.map((candidate) => ({
    path: candidate,
    exists: safeExists(candidate),
  }));
}

export function autoDetectDbPath(): string | null {
  const candidates = getCandidateDbPaths().filter((candidate) => candidate.exists);
  if (candidates.length === 0) return null;
  return candidates[0].path;
}

export function resolveDbPath(provided?: string): { path: string; source: DbPathSource } {
  if (provided && provided.trim().length > 0) {
    return { path: normalizeDbPath(provided), source: "explicit" };
  }

  const envPath = process.env.IMESSAGE_DB_PATH;
  if (envPath && envPath.trim().length > 0) {
    return { path: normalizeDbPath(envPath), source: "env" };
  }

  const settings = readSettings();
  if (settings.dbPath && settings.dbPath.trim().length > 0) {
    return { path: normalizeDbPath(settings.dbPath), source: "settings" };
  }

  const autoDetected = autoDetectDbPath();
  if (autoDetected) {
    return { path: autoDetected, source: "auto" };
  }

  return { path: DEFAULT_CANDIDATES[0], source: "default" };
}

export function getDbPathStatus(): DbPathStatus {
  const settings = readSettings();
  const envPath = process.env.IMESSAGE_DB_PATH?.trim() || null;
  const savedPath = settings.dbPath?.trim() || null;

  const resolution = resolveDbPath();
  const currentPath = resolution.path ?? null;

  return {
    currentPath,
    source: currentPath ? resolution.source : "none",
    exists: currentPath ? safeExists(currentPath) : false,
    envPath,
    savedPath,
    settingsFile: getSettingsFilePath(),
    candidates: getCandidateDbPaths(),
  };
}

export function saveDbPath(dbPath: string | null): void {
  if (!dbPath || dbPath.trim().length === 0) {
    writeSettings({});
    return;
  }

  writeSettings({ dbPath: normalizeDbPath(dbPath) });
}

export function autoDetectAndSave(): { detected: string | null } {
  const detected = autoDetectDbPath();
  if (detected) {
    writeSettings({ dbPath: detected });
  }
  return { detected };
}
