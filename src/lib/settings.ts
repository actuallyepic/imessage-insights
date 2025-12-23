import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export interface AppSettings {
  dbPath?: string;
}

const SETTINGS_DIR_ENV = "IMESSAGE_SETTINGS_DIR";
const SETTINGS_FILE_NAME = "settings.json";

export function getSettingsDir(): string {
  return process.env[SETTINGS_DIR_ENV] || path.join(os.homedir(), ".imessage-insights");
}

export function getSettingsFilePath(): string {
  return path.join(getSettingsDir(), SETTINGS_FILE_NAME);
}

export function readSettings(): AppSettings {
  const settingsFile = getSettingsFilePath();
  try {
    if (!fs.existsSync(settingsFile)) return {};
    const raw = fs.readFileSync(settingsFile, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      const dbPath = typeof parsed.dbPath === "string" ? parsed.dbPath : undefined;
      return { dbPath };
    }
    return {};
  } catch (error) {
    console.warn("Failed to read settings:", error);
    return {};
  }
}

export function writeSettings(settings: AppSettings): void {
  const settingsDir = getSettingsDir();
  const settingsFile = getSettingsFilePath();

  if (!fs.existsSync(settingsDir)) {
    fs.mkdirSync(settingsDir, { recursive: true });
  }

  const payload: AppSettings = {};
  if (settings.dbPath && settings.dbPath.trim().length > 0) {
    payload.dbPath = settings.dbPath.trim();
  }

  fs.writeFileSync(settingsFile, JSON.stringify(payload, null, 2));
}

export function clearSettings(): void {
  const settingsFile = getSettingsFilePath();
  try {
    if (fs.existsSync(settingsFile)) {
      fs.unlinkSync(settingsFile);
    }
  } catch (error) {
    console.warn("Failed to clear settings:", error);
  }
}
