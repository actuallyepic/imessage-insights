"use client";

import type { CSSProperties, ReactNode } from "react";
import { avatarGradient, initialsFor } from "@/lib/format";

/* ------------------------------------------------------------------ *
 * Accent tints
 * ------------------------------------------------------------------ */

export type Tint = "accent" | "sky" | "violet" | "fuchsia" | "amber" | "rose" | "pink" | "neutral";

/** Raw "r,g,b" triples so tinted panels can compose their own alpha stops. */
const TINT_RGB: Record<Exclude<Tint, "neutral">, string> = {
  accent: "52,211,153",
  sky: "56,189,248",
  violet: "167,139,250",
  fuchsia: "232,121,249",
  amber: "251,191,36",
  rose: "251,113,133",
  pink: "244,114,182",
};

const TINT_TEXT: Record<Tint, string> = {
  accent: "text-accent",
  sky: "text-sky",
  violet: "text-violet",
  fuchsia: "text-fuchsia",
  amber: "text-amber",
  rose: "text-rose",
  pink: "text-pink",
  neutral: "text-ink-dim",
};

const TINT_VALUE_TEXT: Record<Tint, string> = {
  accent: "text-accent-soft",
  sky: "text-sky-soft",
  violet: "text-violet-soft",
  fuchsia: "text-fuchsia",
  amber: "text-amber-soft",
  rose: "text-rose",
  pink: "text-pink-soft",
  neutral: "text-ink",
};

export function tintStyle(tint: Tint): CSSProperties | undefined {
  if (tint === "neutral") return undefined;
  return { ["--tint" as string]: TINT_RGB[tint] };
}

/* ------------------------------------------------------------------ *
 * Panel
 * ------------------------------------------------------------------ */

export function Panel({
  children,
  className = "",
  tint = "neutral",
  delay,
  style,
}: {
  children: ReactNode;
  className?: string;
  tint?: Tint;
  /** Seconds of stagger for the rise-in animation. */
  delay?: number;
  style?: CSSProperties;
}) {
  const base = tint === "neutral" ? "panel" : "panel-tint";
  return (
    <div
      className={`${base} animate-rise ${className}`}
      style={{
        ...tintStyle(tint),
        ...(delay !== undefined ? { animationDelay: `${delay}s` } : null),
        ...style,
      }}
    >
      {children}
    </div>
  );
}

/** Uppercase micro-label used above every metric. */
export function PanelLabel({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <p className={`text-[11px] font-semibold uppercase tracking-[0.07em] text-ink-dim ${className}`}>{children}</p>
  );
}

/** Sentence-case panel heading ("Activity over time"). */
export function PanelTitle({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <p className={`text-sm font-semibold text-ink ${className}`}>{children}</p>;
}

export function PanelSubtitle({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <p className={`mt-1 text-xs text-ink-faint ${className}`}>{children}</p>;
}

/* ------------------------------------------------------------------ *
 * Stat card
 * ------------------------------------------------------------------ */

/** Small pill in a stat card's top-right — a delta, a share, or a note. */
export function StatBadge({ children, tint = "neutral" }: { children: ReactNode; tint?: Tint }) {
  if (tint === "neutral") {
    return <span className="text-[11px] font-semibold text-ink-dim">{children}</span>;
  }
  return (
    <span
      className={`inline-flex items-center gap-[3px] rounded-md px-1.5 py-0.5 text-[11px] font-semibold ${TINT_TEXT[tint]}`}
      style={{ backgroundColor: `rgba(${TINT_RGB[tint]},0.14)` }}
    >
      {children}
    </span>
  );
}

export function StatCard({
  label,
  value,
  badge,
  tint = "neutral",
  footer,
  delay,
}: {
  label: ReactNode;
  value: ReactNode;
  badge?: ReactNode;
  tint?: Tint;
  footer?: ReactNode;
  delay?: number;
}) {
  return (
    <Panel tint={tint} delay={delay} className="rounded-[18px] px-[18px] py-[17px]">
      <div className="flex items-center justify-between gap-2">
        <PanelLabel>{label}</PanelLabel>
        {badge}
      </div>
      <p className={`mt-3 text-[28px] font-semibold tracking-[-0.02em] ${TINT_VALUE_TEXT[tint]}`}>{value}</p>
      {footer ? <div className="mt-2.5">{footer}</div> : null}
    </Panel>
  );
}

/* ------------------------------------------------------------------ *
 * Segmented control
 * ------------------------------------------------------------------ */

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
}: {
  options: ReadonlyArray<{ value: T; label: string }>;
  value: T;
  onChange: (value: T) => void;
  ariaLabel?: string;
}) {
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className="flex gap-0.5 rounded-[9px] border border-line-control p-0.5"
    >
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(option.value)}
            className={`cursor-pointer rounded-[7px] px-2.5 py-1 text-[11px] font-semibold transition-colors ${
              active ? "bg-surface-active text-ink" : "text-ink-dim hover:text-ink-secondary"
            }`}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Avatar
 * ------------------------------------------------------------------ */

export function Avatar({
  label,
  identityKey,
  size = 34,
  className = "",
}: {
  label: string | null | undefined;
  /** Stable key for colour selection; falls back to the label. */
  identityKey?: string | null;
  size?: number;
  className?: string;
}) {
  return (
    <span
      className={`flex flex-none items-center justify-center rounded-full font-semibold ${className}`}
      style={{
        width: size,
        height: size,
        background: avatarGradient(identityKey ?? label),
        fontSize: Math.max(10, Math.round(size * 0.35)),
        color: "var(--avatar-ink)",
      }}
      aria-hidden
    >
      {initialsFor(label)}
    </span>
  );
}

/* ------------------------------------------------------------------ *
 * Charts
 * ------------------------------------------------------------------ */

export type PathDomain = { min: number; max: number };

/**
 * Polyline through `values` across a w×h box, top-padded so peaks don't clip.
 * `area` closes the path along the baseline for gradient fills.
 * Pass `domain` to put two series on a shared scale; omit to index each to its own peak.
 */
export function buildPath(
  values: number[],
  w: number,
  h: number,
  { area = false, domain, padTop = 12, padBottom = 8 }: { area?: boolean; domain?: PathDomain; padTop?: number; padBottom?: number } = {},
): string {
  if (values.length === 0) return "";
  if (values.length === 1) {
    const y = h - padBottom;
    return area ? `M0,${y} L${w},${y} L${w},${h} L0,${h} Z` : `M0,${y} L${w},${y}`;
  }
  const min = domain ? domain.min : Math.min(...values);
  const max = domain ? domain.max : Math.max(...values);
  const span = max - min || 1;
  let d = "";
  values.forEach((value, i) => {
    const x = (i / (values.length - 1)) * w;
    const y = h - padBottom - ((value - min) / span) * (h - padTop - padBottom);
    d += `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)} `;
  });
  if (area) d += `L${w},${h} L0,${h} Z`;
  return d.trim();
}

/** The 110×34 trend line that sits under a stat card's number. */
export function Sparkline({
  values,
  color,
  delay = 0,
  height = 28,
}: {
  values: number[];
  color: string;
  delay?: number;
  height?: number;
}) {
  if (values.length < 2) return <div style={{ height }} />;
  return (
    <svg
      viewBox="0 0 110 34"
      width="100%"
      height={height}
      preserveAspectRatio="none"
      className="mt-2 overflow-visible"
      aria-hidden
    >
      <path
        d={buildPath(values, 110, 34)}
        fill="none"
        stroke={color}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeDasharray="240"
        className="animate-spark"
        style={{ animationDelay: `${delay}s` }}
      />
    </svg>
  );
}

export type AreaSeries = {
  values: number[];
  /** CSS colour for the stroke; the fill is derived from it. */
  color: string;
  /** Unique within a page — used for the gradient's id. */
  id: string;
  fillOpacity?: number;
  strokeWidth?: number;
};

/**
 * Two-series area chart ("Activity over time"). Each series is indexed to its own
 * peak by default, matching the design's "indexed to peak" caption; pass
 * `sharedDomain` when the series are directly comparable (e.g. sent vs received).
 */
export function AreaChart({
  series,
  height = 200,
  sharedDomain = false,
  className = "",
}: {
  series: AreaSeries[];
  height?: number;
  sharedDomain?: boolean;
  className?: string;
}) {
  const W = 700;
  const H = 210;
  const usable = series.filter((s) => s.values.length >= 2);
  if (usable.length === 0) {
    return (
      <div className={`flex items-center justify-center text-xs text-ink-ghost ${className}`} style={{ height }}>
        Not enough data in this range
      </div>
    );
  }
  const domain = sharedDomain
    ? (() => {
        const all = usable.flatMap((s) => s.values);
        return { min: Math.min(...all), max: Math.max(...all) };
      })()
    : undefined;

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      width="100%"
      height={height}
      preserveAspectRatio="none"
      className={`overflow-visible ${className}`}
      aria-hidden
    >
      <defs>
        {usable.map((s) => (
          <linearGradient key={s.id} id={s.id} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor={s.color} stopOpacity={s.fillOpacity ?? 0.28} />
            <stop offset="1" stopColor={s.color} stopOpacity="0" />
          </linearGradient>
        ))}
      </defs>
      {[52, 104, 156].map((y) => (
        <line key={y} x1="0" y1={y} x2={W} y2={y} stroke="var(--line-hairline)" strokeWidth="1" />
      ))}
      {usable.map((s) => (
        <path key={`${s.id}-fill`} d={buildPath(s.values, W, H, { area: true, domain })} fill={`url(#${s.id})`} stroke="none" />
      ))}
      {usable.map((s) => (
        <path
          key={`${s.id}-line`}
          d={buildPath(s.values, W, H, { domain })}
          fill="none"
          stroke={s.color}
          strokeWidth={s.strokeWidth ?? 2}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
      ))}
    </svg>
  );
}

/** Legend swatch + label, e.g. "▪ Messages". */
export function LegendItem({ color, children }: { color: string; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px] text-ink-muted">
      <span className="h-[9px] w-[9px] rounded-[3px]" style={{ background: color }} />
      {children}
    </span>
  );
}

/** Axis tick strip under a chart. */
export function AxisLabels({ labels, className = "" }: { labels: string[]; className?: string }) {
  return (
    <div className={`mt-2 flex justify-between font-mono text-[10px] text-ink-ghost ${className}`}>
      {labels.map((label, i) => (
        <span key={`${label}-${i}`}>{label}</span>
      ))}
    </div>
  );
}

/** Donut with a value in the well — "Message balance", "Send / receive balance". */
export function Donut({
  ratio,
  primary,
  secondary,
  value,
  caption,
  size = 92,
}: {
  /** 0..1 — the share taken by `primary`. */
  ratio: number;
  primary: string;
  secondary: string;
  value: ReactNode;
  caption: ReactNode;
  size?: number;
}) {
  const pct = Math.max(0, Math.min(1, ratio)) * 100;
  return (
    <div
      className="relative flex-none rounded-full"
      style={{
        width: size,
        height: size,
        background: `conic-gradient(${primary} 0 ${pct}%, ${secondary} 0 100%)`,
      }}
    >
      <div className="absolute inset-3 flex flex-col items-center justify-center rounded-full bg-well">
        <span className="text-[17px] font-semibold text-ink">{value}</span>
        <span className="text-[9px] text-ink-faint">{caption}</span>
      </div>
    </div>
  );
}

/** Two-tone progress track (from-you / from-them splits). */
export function SplitBar({
  segments,
  className = "",
  height = 6,
}: {
  segments: Array<{ value: number; color: string }>;
  className?: string;
  height?: number;
}) {
  const total = segments.reduce((sum, s) => sum + Math.max(0, s.value), 0);
  return (
    <div className={`flex overflow-hidden rounded-[3px] bg-track ${className}`} style={{ height }}>
      {total > 0
        ? segments.map((segment, i) => (
            <div
              key={i}
              style={{ width: `${(Math.max(0, segment.value) / total) * 100}%`, background: segment.color }}
            />
          ))
        : null}
    </div>
  );
}

/** Single animated bar, used in ranked lists. */
export function MeterBar({
  ratio,
  color,
  height = 6,
  delay = 0,
}: {
  ratio: number;
  color: string;
  height?: number;
  delay?: number;
}) {
  const pct = Math.max(0, Math.min(1, ratio)) * 100;
  return (
    <div className="overflow-hidden rounded-[3px] bg-track" style={{ height }}>
      <div
        className="h-full origin-left rounded-[3px] animate-bar-x"
        style={{ width: `${Math.max(pct, ratio > 0 ? 2 : 0)}%`, background: color, animationDelay: `${delay}s` }}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * States
 * ------------------------------------------------------------------ */

export function EmptyNote({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <p className={`text-xs text-ink-ghost ${className}`}>{children}</p>;
}

export function ErrorBanner({ title, detail }: { title: string; detail?: string }) {
  return (
    <div
      className="rounded-2xl border p-4"
      style={{ borderColor: "rgba(251,113,133,0.35)", background: "rgba(251,113,133,0.08)" }}
    >
      <p className="text-sm font-semibold text-rose">{title}</p>
      {detail ? <p className="mt-1 text-xs text-ink-muted">{detail}</p> : null}
    </div>
  );
}

/** Panel-shaped shimmer for first load. */
export function SkeletonPanel({ className = "", height = 120 }: { className?: string; height?: number }) {
  return <div className={`panel animate-pulse rounded-[18px] ${className}`} style={{ height }} />;
}
