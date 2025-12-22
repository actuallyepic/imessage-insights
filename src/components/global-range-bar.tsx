'use client';

import { useMemo } from "react";

import { getSupportedTimeZones, getSystemTimeZone } from "@/lib/timezone";
import { GLOBAL_RANGE_PRESETS, useGlobalRange, type GlobalRangePreset } from "@/hooks/use-global-range";

const presetLabels: Record<GlobalRangePreset, string> = {
  "1h": "Last 1 hour",
  "6h": "Last 6 hours",
  "12h": "Last 12 hours",
  "1d": "Last 1 day",
  "3d": "Last 3 days",
  "5d": "Last 5 days",
  "7d": "Last 7 days",
  "30d": "Last 30 days",
  "90d": "Last 90 days",
  all: "All time",
};

export function GlobalRangeBar({ compact = false }: { compact?: boolean }) {
  const { range, setPreset, setMode, setDay, setCustomRange, setTimeZone, reset } = useGlobalRange();
  const supportedTimeZones = useMemo(() => getSupportedTimeZones(), []);

  const selectValue = range.mode === "preset" ? range.preset : range.mode;

  const handleRangeChange = (value: string) => {
    if (value === "day") {
      setMode("day");
      return;
    }
    if (value === "custom") {
      setMode("custom");
      return;
    }
    setPreset(value as GlobalRangePreset);
  };

  const wrapperClass = compact
    ? "flex flex-wrap items-center gap-2 text-xs text-neutral-400"
    : "flex flex-wrap items-center gap-2 rounded-2xl border border-neutral-800/70 bg-neutral-950/40 p-4 text-xs text-neutral-400 shadow-lg shadow-black/30";

  const pillClass = "flex items-center gap-2 rounded-full border border-neutral-800/80 bg-neutral-950/40 px-3 py-1";
  const inputClass =
    "bg-transparent text-neutral-200 outline-none placeholder:text-neutral-600 [color-scheme:dark]";

  return (
    <div className={wrapperClass}>
      <label className={pillClass}>
        <span className="text-neutral-500">Range</span>
        <select
          value={selectValue}
          onChange={(event) => handleRangeChange(event.target.value)}
          className={inputClass}
        >
          <optgroup label="Presets">
            {GLOBAL_RANGE_PRESETS.map((preset) => (
              <option key={preset} value={preset}>
                {presetLabels[preset]}
              </option>
            ))}
          </optgroup>
          <optgroup label="Calendar">
            <option value="day">Single day…</option>
            <option value="custom">Custom…</option>
          </optgroup>
        </select>
      </label>

      {range.mode === "day" ? (
        <label className={pillClass}>
          <span className="text-neutral-500">Day</span>
          <input
            type="date"
            value={range.day}
            onChange={(event) => setDay(event.target.value)}
            className={inputClass}
          />
        </label>
      ) : null}

      {range.mode === "custom" ? (
        <>
          <label className={pillClass}>
            <span className="text-neutral-500">Start</span>
            <input
              type="date"
              value={range.startDay}
              onChange={(event) => setCustomRange(event.target.value, range.endDay)}
              className={inputClass}
            />
          </label>
          <label className={pillClass}>
            <span className="text-neutral-500">End</span>
            <input
              type="date"
              value={range.endDay}
              onChange={(event) => setCustomRange(range.startDay, event.target.value)}
              className={inputClass}
            />
          </label>
        </>
      ) : null}

      {range.mode !== "preset" ? (
        <>
          <label className={pillClass}>
            <span className="text-neutral-500">TZ</span>
            <input
              value={range.timeZone}
              onChange={(event) => setTimeZone(event.target.value)}
              list="global-timezones"
              placeholder={getSystemTimeZone()}
              className={`${inputClass} w-48`}
            />
          </label>
          <datalist id="global-timezones">
            {supportedTimeZones.length > 0
              ? supportedTimeZones.map((tz) => <option key={tz} value={tz} />)
              : null}
          </datalist>
        </>
      ) : null}

      <button
        type="button"
        onClick={() => reset()}
        className="rounded-full border border-neutral-800/80 bg-neutral-950/40 px-3 py-1 text-xs font-semibold text-neutral-300 transition hover:border-neutral-700 hover:text-white"
      >
        Reset
      </button>
    </div>
  );
}
