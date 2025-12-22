'use client';

import { useCallback, useMemo } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

import {
  computeZonedDayRangeIso,
  computeZonedInclusiveDateRangeIso,
  countInclusiveDays,
  getSystemTimeZone,
  getTodayIsoDateInTimeZone,
  isValidTimeZone,
} from "@/lib/timezone";

export type GlobalRangeMode = "preset" | "day" | "custom";
export type GlobalRangePreset =
  | "1h"
  | "6h"
  | "12h"
  | "1d"
  | "3d"
  | "5d"
  | "7d"
  | "30d"
  | "90d"
  | "all";

export const GLOBAL_RANGE_PRESETS: GlobalRangePreset[] = [
  "1h",
  "6h",
  "12h",
  "1d",
  "3d",
  "5d",
  "7d",
  "30d",
  "90d",
  "all",
];

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const presetDurationsMs: Record<Exclude<GlobalRangePreset, "all">, number> = {
  "1h": 1 * HOUR_MS,
  "6h": 6 * HOUR_MS,
  "12h": 12 * HOUR_MS,
  "1d": 1 * DAY_MS,
  "3d": 3 * DAY_MS,
  "5d": 5 * DAY_MS,
  "7d": 7 * DAY_MS,
  "30d": 30 * DAY_MS,
  "90d": 90 * DAY_MS,
};

function parseMode(raw: string | null | undefined): GlobalRangeMode {
  const value = (raw ?? "").trim().toLowerCase();
  if (value === "day") return "day";
  if (value === "custom") return "custom";
  return "preset";
}

function parsePreset(raw: string | null | undefined): GlobalRangePreset {
  const value = (raw ?? "").trim().toLowerCase();
  return (GLOBAL_RANGE_PRESETS as string[]).includes(value) ? (value as GlobalRangePreset) : "30d";
}

function isIsoDay(value: string | null | undefined): value is string {
  if (!value) return false;
  return /^\d{4}-\d{2}-\d{2}$/.test(value.trim());
}

function sanitizeTimeZone(raw: string | null | undefined) {
  const value = (raw ?? "").trim();
  return isValidTimeZone(value) ? value : getSystemTimeZone();
}

function sanitizeIsoDay(raw: string | null | undefined, fallback: string) {
  if (isIsoDay(raw)) return raw.trim();
  return fallback;
}

function normalizeOrderedRange(startDay: string, endDay: string) {
  return startDay <= endDay ? { startDay, endDay } : { startDay: endDay, endDay: startDay };
}

function computePresetRange(preset: GlobalRangePreset) {
  if (preset === "all") return {};
  const now = new Date();
  const duration = presetDurationsMs[preset];
  const start = new Date(now.getTime() - duration);
  return { startIso: start.toISOString(), endIso: now.toISOString() };
}

export type GlobalRange = {
  mode: GlobalRangeMode;
  preset: GlobalRangePreset;
  timeZone: string;
  day: string;
  startDay: string;
  endDay: string;
  orderedStartDay: string;
  orderedEndDay: string;
  startIso?: string;
  endIso?: string;
  startDate: Date | null;
  endDate: Date | null;
  durationSeconds: number | null;
  durationDays: number | null;
  dayCount: number | null;
};

export function useGlobalRange() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const mode = useMemo(() => parseMode(searchParams.get("rm")), [searchParams]);
  const preset = useMemo(() => parsePreset(searchParams.get("r") ?? searchParams.get("range")), [searchParams]);
  const timeZone = useMemo(() => sanitizeTimeZone(searchParams.get("tz")), [searchParams]);

  const today = useMemo(() => getTodayIsoDateInTimeZone(timeZone), [timeZone]);

  const day = useMemo(() => sanitizeIsoDay(searchParams.get("day"), today), [searchParams, today]);
  const startDay = useMemo(
    () => sanitizeIsoDay(searchParams.get("startDay"), today),
    [searchParams, today],
  );
  const endDay = useMemo(
    () => sanitizeIsoDay(searchParams.get("endDay"), today),
    [searchParams, today],
  );

  const ordered = useMemo(() => normalizeOrderedRange(startDay, endDay), [endDay, startDay]);

  const computedRange = useMemo<{ startIso?: string; endIso?: string }>(() => {
    if (mode === "day") {
      const computed = computeZonedDayRangeIso(day, timeZone);
      return computed ? { startIso: computed.start, endIso: computed.end } : computePresetRange("30d");
    }

    if (mode === "custom") {
      const computed = computeZonedInclusiveDateRangeIso(ordered.startDay, ordered.endDay, timeZone);
      return computed ? { startIso: computed.start, endIso: computed.end } : computePresetRange("30d");
    }

    return computePresetRange(preset);
  }, [day, mode, ordered.endDay, ordered.startDay, preset, timeZone]);

  const startIso = computedRange.startIso;
  const endIso = computedRange.endIso;

  const startDate = useMemo(() => {
    if (!startIso) return null;
    const parsed = new Date(startIso);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }, [startIso]);

  const endDate = useMemo(() => {
    if (!endIso) return null;
    const parsed = new Date(endIso);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }, [endIso]);

  const durationSeconds = useMemo(() => {
    if (!startDate || !endDate) return null;
    const seconds = (endDate.getTime() - startDate.getTime()) / 1000;
    return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
  }, [endDate, startDate]);

  const durationDays = useMemo(() => {
    if (!durationSeconds) return null;
    return durationSeconds / (24 * 60 * 60);
  }, [durationSeconds]);

  const dayCount = useMemo(() => {
    if (mode === "day") return 1;
    if (mode === "custom") return countInclusiveDays(ordered.startDay, ordered.endDay);
    if (preset === "all") return null;
    const durationMs = presetDurationsMs[preset];
    return Math.max(1, Math.ceil(durationMs / DAY_MS));
  }, [mode, ordered.endDay, ordered.startDay, preset]);

  const replaceParams = useCallback(
    (next: URLSearchParams) => {
      const query = next.toString();
      const url = query ? `${pathname}?${query}` : pathname;
      router.replace(url, { scroll: false });
    },
    [pathname, router],
  );

  const setPreset = useCallback(
    (nextPreset: GlobalRangePreset) => {
      const next = new URLSearchParams(searchParams.toString());
      next.set("rm", "preset");
      next.set("r", nextPreset);
      next.delete("range");
      next.delete("day");
      next.delete("startDay");
      next.delete("endDay");
      if (nextPreset === "all") {
        next.delete("tz");
      }
      replaceParams(next);
    },
    [replaceParams, searchParams],
  );

  const setMode = useCallback(
    (nextMode: GlobalRangeMode) => {
      const next = new URLSearchParams(searchParams.toString());
      next.set("rm", nextMode);
      next.delete("range");
      if (nextMode === "preset") {
        next.set("r", preset);
        next.delete("day");
        next.delete("startDay");
        next.delete("endDay");
        replaceParams(next);
        return;
      }

      next.set("tz", timeZone);
      if (nextMode === "day") {
        next.set("day", day);
        next.delete("startDay");
        next.delete("endDay");
      } else {
        next.set("startDay", ordered.startDay);
        next.set("endDay", ordered.endDay);
        next.delete("day");
      }
      replaceParams(next);
    },
    [day, ordered.endDay, ordered.startDay, preset, replaceParams, searchParams, timeZone],
  );

  const setTimeZone = useCallback(
    (nextTimeZone: string) => {
      const next = new URLSearchParams(searchParams.toString());
      next.delete("range");
      const sanitized = sanitizeTimeZone(nextTimeZone);
      next.set("tz", sanitized);
      replaceParams(next);
    },
    [replaceParams, searchParams],
  );

  const setDay = useCallback(
    (nextDay: string) => {
      const next = new URLSearchParams(searchParams.toString());
      next.set("rm", "day");
      next.delete("range");
      next.set("tz", timeZone);
      next.set("day", sanitizeIsoDay(nextDay, today));
      next.delete("startDay");
      next.delete("endDay");
      replaceParams(next);
    },
    [replaceParams, searchParams, timeZone, today],
  );

  const setCustomRange = useCallback(
    (nextStartDay: string, nextEndDay: string) => {
      const next = new URLSearchParams(searchParams.toString());
      next.set("rm", "custom");
      next.delete("range");
      next.set("tz", timeZone);
      next.set("startDay", sanitizeIsoDay(nextStartDay, today));
      next.set("endDay", sanitizeIsoDay(nextEndDay, today));
      next.delete("day");
      replaceParams(next);
    },
    [replaceParams, searchParams, timeZone, today],
  );

  const reset = useCallback(() => {
    setPreset("30d");
  }, [setPreset]);

  const range = useMemo<GlobalRange>(
    () => ({
      mode,
      preset,
      timeZone,
      day,
      startDay,
      endDay,
      orderedStartDay: ordered.startDay,
      orderedEndDay: ordered.endDay,
      startIso,
      endIso,
      startDate,
      endDate,
      durationSeconds,
      durationDays,
      dayCount,
    }),
    [
      day,
      dayCount,
      durationDays,
      durationSeconds,
      endDate,
      endDay,
      endIso,
      mode,
      ordered.endDay,
      ordered.startDay,
      preset,
      startDate,
      startDay,
      startIso,
      timeZone,
    ],
  );

  return {
    range,
    setPreset,
    setMode,
    setTimeZone,
    setDay,
    setCustomRange,
    reset,
    searchParams,
  };
}
