"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useIsFetching, useQueryClient } from "@tanstack/react-query";
import { useMemo, type ReactNode } from "react";

import { getSupportedTimeZones, getSystemTimeZone } from "@/lib/timezone";
import { GLOBAL_RANGE_PRESETS, useGlobalRange, type GlobalRangePreset } from "@/hooks/use-global-range";
import {
  CallsIcon,
  MessagesIcon,
  OverviewIcon,
  PeopleIcon,
  RefreshIcon,
  ReportsIcon,
} from "@/components/ui/icons";

const NAV = [
  { href: "/", label: "Overview", Icon: OverviewIcon, match: (p: string) => p === "/" },
  { href: "/messages", label: "Messages", Icon: MessagesIcon, match: (p: string) => p.startsWith("/messages") },
  { href: "/calls", label: "Calls", Icon: CallsIcon, match: (p: string) => p.startsWith("/calls") },
  {
    href: "/people",
    label: "People",
    Icon: PeopleIcon,
    match: (p: string) => p.startsWith("/people") || p.startsWith("/person"),
  },
  { href: "/reports", label: "Reports", Icon: ReportsIcon, match: (p: string) => p.startsWith("/reports") },
] as const;

export const PRESET_LABELS: Record<GlobalRangePreset, string> = {
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

/* ------------------------------------------------------------------ *
 * Sidebar
 * ------------------------------------------------------------------ */

function Sidebar() {
  const pathname = usePathname() ?? "/";
  const searchParams = useSearchParams();
  // The range lives in the query string, so nav links must carry it across.
  const query = searchParams.toString();
  const suffix = query ? `?${query}` : "";

  return (
    <aside className="sticky top-0 hidden h-screen w-[236px] flex-none flex-col gap-7 border-r border-line-subtle bg-sidebar px-[18px] py-[26px] md:flex">
      <div className="flex items-center gap-[11px] px-1.5">
        <div
          className="flex h-8 w-8 items-center justify-center rounded-[10px]"
          style={{
            background: "linear-gradient(150deg,var(--accent),var(--sky))",
            boxShadow: "0 6px 16px -6px rgba(52,211,153,0.6)",
          }}
        >
          <span className="h-3 w-3 rounded-[4px] bg-sidebar" />
        </div>
        <div>
          <p className="text-sm font-semibold tracking-[-0.01em] text-ink">Signal</p>
          <p className="text-[11px] text-ink-faint">Communication insights</p>
        </div>
      </div>

      <nav className="flex flex-col gap-[3px]">
        {NAV.map(({ href, label, Icon, match }) => {
          const active = match(pathname);
          return (
            <Link
              key={href}
              href={`${href}${suffix}`}
              aria-current={active ? "page" : undefined}
              className={`flex items-center gap-[11px] rounded-[11px] px-3 py-[9px] text-[13px] transition-colors ${
                active
                  ? "bg-surface-active font-semibold text-ink"
                  : "font-medium text-ink-muted hover:bg-surface hover:text-ink-primary"
              }`}
            >
              <span className="inline-flex h-4 w-4 items-center justify-center">
                <Icon color={active ? "var(--accent)" : "currentColor"} />
              </span>
              {label}
            </Link>
          );
        })}
      </nav>

      <div className="mt-auto flex flex-col gap-3">
        <div className="rounded-[14px] border border-line-panel bg-inset p-[13px]">
          <div className="flex items-center gap-[7px]">
            <span
              className="h-[7px] w-[7px] rounded-full bg-accent"
              style={{ boxShadow: "0 0 0 3px rgba(52,211,153,0.18)" }}
            />
            <span className="text-[11px] font-semibold text-ink-tertiary">Read-only</span>
          </div>
          <p className="mt-[7px] text-[11px] leading-[1.45] text-ink-faint">
            Local database · never leaves this device
          </p>
        </div>
        <div className="flex items-center gap-2.5 px-1.5 py-1">
          <div
            className="flex h-[30px] w-[30px] items-center justify-center rounded-full text-xs font-semibold"
            style={{ background: "linear-gradient(140deg,#a78bfa,#f472b6)", color: "var(--avatar-ink)" }}
          >
            Me
          </div>
          <div className="leading-tight">
            <p className="text-xs font-semibold text-ink-secondary">You</p>
            <p className="text-[11px] text-ink-faint">This Mac</p>
          </div>
        </div>
      </div>
    </aside>
  );
}

/** Horizontal nav for narrow viewports, where the sidebar is hidden. */
function MobileNav() {
  const pathname = usePathname() ?? "/";
  const searchParams = useSearchParams();
  const query = searchParams.toString();
  const suffix = query ? `?${query}` : "";

  return (
    <nav className="flex gap-1 overflow-x-auto border-b border-line-subtle bg-sidebar px-4 py-3 md:hidden">
      {NAV.map(({ href, label, Icon, match }) => {
        const active = match(pathname);
        return (
          <Link
            key={href}
            href={`${href}${suffix}`}
            aria-current={active ? "page" : undefined}
            className={`flex flex-none items-center gap-2 rounded-[11px] px-3 py-2 text-xs ${
              active ? "bg-surface-active font-semibold text-ink" : "font-medium text-ink-muted"
            }`}
          >
            <Icon color={active ? "var(--accent)" : "currentColor"} size={14} />
            {label}
          </Link>
        );
      })}
    </nav>
  );
}

/* ------------------------------------------------------------------ *
 * Range control
 * ------------------------------------------------------------------ */

/** The header's range pill + refresh button, plus the day/custom inputs when needed. */
export function RangeControl() {
  const { range, setPreset, setMode, setDay, setCustomRange, setTimeZone } = useGlobalRange();
  const queryClient = useQueryClient();
  const isFetching = useIsFetching() > 0;
  const supportedTimeZones = useMemo(() => getSupportedTimeZones(), []);

  const selectValue = range.mode === "preset" ? range.preset : range.mode;
  const pillLabel =
    range.mode === "preset" ? PRESET_LABELS[range.preset] : range.mode === "day" ? "Single day" : "Custom range";

  const handleRangeChange = (value: string) => {
    if (value === "day" || value === "custom") {
      setMode(value);
      return;
    }
    setPreset(value as GlobalRangePreset);
  };

  const fieldClass =
    "rounded-[11px] border border-line-control bg-surface px-3 py-2 text-xs text-ink-secondary outline-none focus-visible:border-accent";

  return (
    <div className="flex flex-col items-end gap-2">
      <div className="flex items-center gap-2.5">
        <div className="relative flex items-center gap-2 rounded-[11px] border border-line-control bg-surface px-3 py-2 text-xs font-semibold text-ink-secondary">
          <span className="h-1.5 w-1.5 flex-none rounded-full bg-sky" />
          <span className="whitespace-nowrap">{pillLabel}</span>
          <span aria-hidden className="text-ink-faint">
            ▾
          </span>
          <select
            aria-label="Date range"
            value={selectValue}
            onChange={(event) => handleRangeChange(event.target.value)}
            className="absolute inset-0 cursor-pointer opacity-0"
          >
            <optgroup label="Presets">
              {GLOBAL_RANGE_PRESETS.map((preset) => (
                <option key={preset} value={preset}>
                  {PRESET_LABELS[preset]}
                </option>
              ))}
            </optgroup>
            <optgroup label="Calendar">
              <option value="day">Single day…</option>
              <option value="custom">Custom…</option>
            </optgroup>
          </select>
        </div>
        <button
          type="button"
          aria-label="Refresh"
          onClick={() => queryClient.invalidateQueries()}
          className="flex h-[37px] w-[38px] cursor-pointer items-center justify-center rounded-[11px] border border-line-control bg-surface transition-colors hover:bg-surface-hover"
        >
          <span className={isFetching ? "animate-spin" : undefined}>
            <RefreshIcon color="var(--ink-muted)" />
          </span>
        </button>
      </div>

      {range.mode !== "preset" ? (
        <div className="flex flex-wrap items-center justify-end gap-2">
          {range.mode === "day" ? (
            <input
              type="date"
              aria-label="Day"
              value={range.day}
              onChange={(event) => setDay(event.target.value)}
              className={fieldClass}
            />
          ) : (
            <>
              <input
                type="date"
                aria-label="Start day"
                value={range.startDay}
                onChange={(event) => setCustomRange(event.target.value, range.endDay)}
                className={fieldClass}
              />
              <span className="text-xs text-ink-ghost">→</span>
              <input
                type="date"
                aria-label="End day"
                value={range.endDay}
                onChange={(event) => setCustomRange(range.startDay, event.target.value)}
                className={fieldClass}
              />
            </>
          )}
          <input
            aria-label="Time zone"
            value={range.timeZone}
            onChange={(event) => setTimeZone(event.target.value)}
            list="global-timezones"
            placeholder={getSystemTimeZone()}
            className={`${fieldClass} w-44`}
          />
          <datalist id="global-timezones">
            {supportedTimeZones.map((tz) => (
              <option key={tz} value={tz} />
            ))}
          </datalist>
        </div>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Shell + header
 * ------------------------------------------------------------------ */

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="text-[26px] font-semibold tracking-[-0.02em] text-ink">{title}</h1>
        {subtitle ? <p className="mt-1.5 text-[13px] text-ink-dim">{subtitle}</p> : null}
      </div>
      {actions ? <div className="flex items-center gap-2.5">{actions}</div> : null}
    </div>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen bg-page text-ink-primary">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <MobileNav />
        <main className="flex min-w-0 flex-1 flex-col gap-[22px] px-6 pb-10 pt-[30px] lg:px-[34px]">{children}</main>
      </div>
    </div>
  );
}
