'use client';

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

interface DbPathCandidate {
  path: string;
  exists: boolean;
}

interface DbPathStatus {
  currentPath: string | null;
  source: string;
  exists: boolean;
  envPath: string | null;
  savedPath: string | null;
  settingsFile: string;
  candidates: DbPathCandidate[];
  detected?: string | null;
  cleared?: boolean;
}

const overviewHref = "/";
const messagesHref = "/messages";
const callsHref = "/calls";
const settingsHref = "/settings";

export default function SettingsPage() {
  const [status, setStatus] = useState<DbPathStatus | null>(null);
  const [dbPath, setDbPath] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadStatus = useCallback(async () => {
    try {
      const response = await fetch("/api/db-path", { cache: "no-store" });
      const payload = (await response.json()) as DbPathStatus;
      setStatus(payload);
      setError(null);
      setNotice(null);
      setDbPath((prev) => (prev.length > 0 ? prev : payload.savedPath ?? payload.currentPath ?? ""));
    } catch (err) {
      setError("Unable to load current settings.");
      console.error(err);
    }
  }, []);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  const candidates = useMemo(() => status?.candidates ?? [], [status]);

  const handleSave = async () => {
    setIsSaving(true);
    setNotice(null);
    setError(null);
    try {
      const response = await fetch("/api/db-path", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dbPath }),
      });
      const payload = (await response.json()) as DbPathStatus;
      setStatus(payload);
      setNotice("Saved database path.");
    } catch (err) {
      setError("Failed to save path.");
      console.error(err);
    } finally {
      setIsSaving(false);
    }
  };

  const handleAutoDetect = async () => {
    setIsSaving(true);
    setNotice(null);
    setError(null);
    try {
      const response = await fetch("/api/db-path", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "auto" }),
      });
      const payload = (await response.json()) as DbPathStatus;
      setStatus(payload);
      setDbPath(payload.savedPath ?? payload.currentPath ?? "");
      if (payload.detected) {
        setNotice(`Auto-detected Messages database at ${payload.detected}.`);
      } else {
        setError("Could not auto-detect the Messages database.");
      }
    } catch (err) {
      setError("Auto-detect failed.");
      console.error(err);
    } finally {
      setIsSaving(false);
    }
  };

  const handleClear = async () => {
    setIsSaving(true);
    setNotice(null);
    setError(null);
    try {
      const response = await fetch("/api/db-path", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "clear" }),
      });
      const payload = (await response.json()) as DbPathStatus;
      setStatus(payload);
      setDbPath(payload.currentPath ?? "");
      setNotice("Cleared saved path. Using auto-detect/default instead.");
    } catch (err) {
      setError("Failed to clear the saved path.");
      console.error(err);
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="min-h-screen bg-neutral-950 pb-16 text-neutral-100">
      <header className="border-b border-neutral-900/60 bg-neutral-950/95 py-6">
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 px-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <Link
                href={overviewHref}
                className="rounded-full border border-neutral-800/80 bg-neutral-900/60 px-3 py-1 text-xs font-semibold text-neutral-200 transition hover:border-neutral-700 hover:text-white"
              >
                Overview
              </Link>
              <Link
                href={messagesHref}
                className="rounded-full border border-neutral-800/80 bg-neutral-900/60 px-3 py-1 text-xs font-semibold text-neutral-200 transition hover:border-neutral-700 hover:text-white"
              >
                Messages
              </Link>
              <Link
                href={callsHref}
                className="rounded-full border border-neutral-800/80 bg-neutral-900/60 px-3 py-1 text-xs font-semibold text-neutral-200 transition hover:border-neutral-700 hover:text-white"
              >
                Calls
              </Link>
              <Link
                href={settingsHref}
                className="rounded-full border border-neutral-800/80 bg-white/5 px-3 py-1 text-xs font-semibold text-white"
              >
                Settings
              </Link>
            </div>
          </div>

          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-white">Settings</h1>
            <p className="mt-2 text-sm text-neutral-400">
              Configure where the app reads your local Messages database. Changes are stored locally on this Mac.
            </p>
          </div>
        </div>
      </header>

      <main className="mx-auto mt-10 flex w-full max-w-5xl flex-col gap-8 px-6">
        <section className="space-y-4 rounded-2xl border border-neutral-800/70 bg-neutral-900/40 p-6">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold text-white">Messages database path</h2>
              <p className="mt-1 text-sm text-neutral-400">
                The app will try a few default locations automatically, but you can override it here.
              </p>
            </div>
            <button
              type="button"
              onClick={handleAutoDetect}
              disabled={isSaving}
              className="rounded-full border border-emerald-400/40 bg-emerald-500/10 px-4 py-2 text-xs font-semibold text-emerald-100 transition hover:border-emerald-300 hover:text-white disabled:opacity-60"
            >
              Auto-detect
            </button>
          </div>

          <label className="block">
            <span className="text-xs font-semibold uppercase tracking-wide text-neutral-500">Database path</span>
            <input
              value={dbPath}
              onChange={(event) => setDbPath(event.target.value)}
              placeholder="/Users/you/Library/Messages/chat.db"
              className="mt-2 w-full rounded-xl border border-neutral-800 bg-neutral-950 px-4 py-3 text-sm text-neutral-100 outline-none ring-emerald-400/40 transition focus:ring-2"
            />
          </label>

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={handleSave}
              disabled={isSaving}
              className="rounded-full border border-neutral-800/80 bg-neutral-900/70 px-4 py-2 text-xs font-semibold text-neutral-200 transition hover:border-neutral-700 hover:text-white disabled:opacity-60"
            >
              Save path
            </button>
            <button
              type="button"
              onClick={handleClear}
              disabled={isSaving}
              className="rounded-full border border-neutral-800/80 bg-neutral-900/40 px-4 py-2 text-xs font-semibold text-neutral-400 transition hover:border-neutral-700 hover:text-white disabled:opacity-60"
            >
              Clear saved path
            </button>
          </div>

          {notice ? (
            <p className="text-sm text-emerald-200">{notice}</p>
          ) : null}
          {error ? <p className="text-sm text-red-400">{error}</p> : null}

          {status ? (
            <div className="mt-4 space-y-2 rounded-2xl border border-neutral-800/60 bg-neutral-950/50 p-4 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="font-semibold text-neutral-200">Current selection</p>
                <span className="rounded-full border border-neutral-800/80 bg-neutral-900/60 px-3 py-1 text-xs text-neutral-300">
                  Source: {status.source}
                </span>
              </div>
              <p className="break-all text-neutral-300">{status.currentPath ?? "(not set)"}</p>
              <p className="text-xs text-neutral-500">
                {status.exists
                  ? "Path exists on disk (or is readable with Full Disk Access)."
                  : "Path not found or not readable yet."}
              </p>
              {status.savedPath ? (
                <p className="text-xs text-neutral-500">Saved override: {status.savedPath}</p>
              ) : null}
              {status.envPath ? (
                <p className="text-xs text-neutral-500">Env override: {status.envPath}</p>
              ) : null}
              <p className="text-xs text-neutral-500">Settings file: {status.settingsFile}</p>
            </div>
          ) : null}
        </section>

        <section className="space-y-3 rounded-2xl border border-neutral-800/70 bg-neutral-900/30 p-6">
          <h3 className="text-sm font-semibold uppercase tracking-wide text-neutral-400">Common locations</h3>
          <ul className="space-y-2 text-sm text-neutral-300">
            {candidates.map((candidate) => (
              <li
                key={candidate.path}
                className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-neutral-800/60 bg-neutral-950/40 px-3 py-2"
              >
                <span className="break-all">{candidate.path}</span>
                <span className="text-xs text-neutral-500">
                  {candidate.exists ? "Found" : "Not found"}
                </span>
              </li>
            ))}
          </ul>
          <p className="text-xs text-neutral-500">
            If the database isn’t detected, add the path manually and grant Full Disk Access to this app in
            System Settings → Privacy &amp; Security → Full Disk Access.
          </p>
        </section>
      </main>
    </div>
  );
}
