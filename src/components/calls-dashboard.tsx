"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useCallback, useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";

import { PageHeader, PRESET_LABELS, RangeControl } from "@/components/app-shell";
import {
  AxisLabels,
  Avatar,
  EmptyNote,
  ErrorBanner,
  MeterBar,
  Panel,
  PanelLabel,
  PanelSubtitle,
  PanelTitle,
  Segmented,
  SkeletonPanel,
  Sparkline,
  StatBadge,
  StatCard,
} from "@/components/ui/primitives";
import { useGlobalRange } from "@/hooks/use-global-range";
import {
  formatCount,
  formatDateTime,
  formatDayLong,
  formatDayShort,
  formatDuration,
  formatPercent,
  share,
  toDate,
} from "@/lib/format";
import {
  type CallApiRecord,
  type CallDirection,
  type CallMedia,
  type CallParticipant,
  type CallProvider,
  fetchAllCalls,
} from "@/lib/callhistory/client";

/* ------------------------------------------------------------------ *
 * Filter + sort state
 * ------------------------------------------------------------------ */

type ProviderFilter = "all" | CallProvider;
type MediaFilter = "all" | CallMedia;
type DirectionFilter = "all" | CallDirection;
type AnsweredFilter = "all" | "answered" | "missed";
type RankingMode = "duration" | "calls" | "outgoing" | "missed";

const PROVIDER_OPTIONS = [
  { value: "all", label: "All" },
  { value: "facetime", label: "FaceTime" },
  { value: "telephony", label: "Phone" },
] as const satisfies ReadonlyArray<{ value: ProviderFilter; label: string }>;

const MEDIA_OPTIONS = [
  { value: "all", label: "All" },
  { value: "audio", label: "Audio" },
  { value: "video", label: "Video" },
] as const satisfies ReadonlyArray<{ value: MediaFilter; label: string }>;

const DIRECTION_OPTIONS = [
  { value: "all", label: "All" },
  { value: "incoming", label: "Incoming" },
  { value: "outgoing", label: "Outgoing" },
] as const satisfies ReadonlyArray<{ value: DirectionFilter; label: string }>;

const OUTCOME_OPTIONS = [
  { value: "all", label: "All" },
  { value: "answered", label: "Answered" },
  { value: "missed", label: "Missed" },
] as const satisfies ReadonlyArray<{ value: AnsweredFilter; label: string }>;

const RANKING_OPTIONS = [
  { value: "duration", label: "Talk time" },
  { value: "calls", label: "Calls" },
  { value: "outgoing", label: "Outgoing" },
  { value: "missed", label: "Missed" },
] as const satisfies ReadonlyArray<{ value: RankingMode; label: string }>;

/* ------------------------------------------------------------------ *
 * Local helpers
 * ------------------------------------------------------------------ */

/** Widest daily window we will materialise, so "All time" can't blow up the loop. */
const MAX_BUCKET_DAYS = 2200;
/** Bars we are willing to draw; longer ranges get grouped into equal-width bins. */
const MAX_BARS = 120;

function durationOf(call: CallApiRecord) {
  return Number.isFinite(call.durationSeconds) ? Math.max(0, call.durationSeconds) : 0;
}

function startOfDay(date: Date) {
  const copy = new Date(date);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

/** Local-time day key, so buckets line up with the dates we print. */
function dayKey(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function participantLabel(participant: CallParticipant) {
  return participant.displayName?.trim() || participant.handle;
}

/** Participants, falling back to the call's raw address when the join table is empty. */
function participantsOf(call: CallApiRecord): CallParticipant[] {
  if (call.participants.length > 0) {
    // The join table carries a name only when macOS Contacts matched the handle.
    // For a one-to-one call the record's own ZNAME identifies that same party, so
    // prefer it over rendering a bare phone number.
    if (call.participants.length === 1 && !call.participants[0].displayName?.trim() && call.name?.trim()) {
      return [{ ...call.participants[0], displayName: call.name.trim() }];
    }
    return call.participants;
  }
  if (call.address) return [{ handle: call.address, displayName: call.name }];
  return [];
}

function callTargets(call: CallApiRecord) {
  const labels = participantsOf(call).map(participantLabel).filter(Boolean);
  if (labels.length === 0) return "Unknown";
  if (labels.length <= 3) return labels.join(", ");
  return `${labels.slice(0, 2).join(", ")} +${labels.length - 2}`;
}

function providerLabel(provider: CallProvider) {
  if (provider === "facetime") return "FaceTime";
  if (provider === "telephony") return "Phone";
  return null;
}

function mediaLabel(media: CallMedia) {
  if (media === "video") return "Video";
  if (media === "audio") return "Audio";
  return null;
}

function directionLabel(direction: CallDirection) {
  if (direction === "outgoing") return "↗ Outgoing";
  if (direction === "incoming") return "↙ Incoming";
  return "Unknown direction";
}

type DayBucket = { date: Date; count: number; duration: number };

/**
 * One bucket per day across [start, end] — dense, so gaps read as gaps.
 * Calls are already range-filtered by the caller.
 */
function computeDailyBuckets(
  calls: CallApiRecord[],
  { start, end }: { start: Date | null; end: Date | null },
): DayBucket[] {
  if (!start || !end) return [];
  const first = startOfDay(start);
  const last = startOfDay(end);
  if (last < first) return [];

  const buckets = new Map<string, DayBucket>();
  const cursor = new Date(first);
  while (cursor <= last && buckets.size < MAX_BUCKET_DAYS) {
    buckets.set(dayKey(cursor), { date: new Date(cursor), count: 0, duration: 0 });
    cursor.setDate(cursor.getDate() + 1);
  }

  for (const call of calls) {
    const startedAt = toDate(call.startedAt);
    if (!startedAt) continue;
    const bucket = buckets.get(dayKey(startedAt));
    if (!bucket) continue;
    bucket.count += 1;
    bucket.duration += durationOf(call);
  }

  return Array.from(buckets.values());
}

type Bar = { label: string; count: number; days: number };

/** Collapse daily buckets to at most MAX_BARS equal-width bins. */
function toBars(buckets: DayBucket[]): { bars: Bar[]; daysPerBar: number } {
  if (buckets.length === 0) return { bars: [], daysPerBar: 1 };
  const daysPerBar = Math.max(1, Math.ceil(buckets.length / MAX_BARS));
  if (daysPerBar === 1) {
    return {
      bars: buckets.map((bucket) => ({ label: formatDayShort(bucket.date), count: bucket.count, days: 1 })),
      daysPerBar,
    };
  }
  const bars: Bar[] = [];
  for (let i = 0; i < buckets.length; i += daysPerBar) {
    const slice = buckets.slice(i, i + daysPerBar);
    bars.push({
      label: formatDayShort(slice[0].date),
      count: slice.reduce((sum, bucket) => sum + bucket.count, 0),
      days: slice.length,
    });
  }
  return { bars, daysPerBar };
}

type PersonStat = {
  key: string;
  label: string;
  calls: number;
  answered: number;
  missed: number;
  missedIncoming: number;
  incoming: number;
  outgoing: number;
  totalDuration: number;
  lastCallAt: Date | null;
};

function personMetric(person: PersonStat, mode: RankingMode) {
  if (mode === "calls") return person.calls;
  if (mode === "outgoing") return person.outgoing;
  if (mode === "missed") return person.missedIncoming;
  return person.totalDuration;
}

/* ------------------------------------------------------------------ *
 * Local presentation bits
 * ------------------------------------------------------------------ */

/** Mono meta line under a stat number. */
function Meta({ children }: { children: ReactNode }) {
  return <p className="font-mono text-[10px] text-ink-dim">{children}</p>;
}

/** The 4-up highlight card: small label, mid-size value, mono sub-line. */
function MiniCard({
  label,
  value,
  sub,
  valueClass = "text-ink",
  delay,
}: {
  label: string;
  value: ReactNode;
  sub: ReactNode;
  valueClass?: string;
  delay?: number;
}) {
  return (
    <Panel delay={delay} className="rounded-2xl px-4 py-[15px]">
      <p className="text-[11px] text-ink-dim">{label}</p>
      <p className={`mt-1.5 text-[19px] font-semibold ${valueClass}`}>{value}</p>
      <p className="mt-1 truncate font-mono text-[10px] text-ink-faint">{sub}</p>
    </Panel>
  );
}

function PagerButton({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="cursor-pointer rounded-[7px] border border-line-control px-2.5 py-1 text-[11px] font-semibold text-ink-muted transition-colors hover:bg-surface-hover hover:text-ink"
    >
      {children}
    </button>
  );
}

/* ------------------------------------------------------------------ *
 * Screen
 * ------------------------------------------------------------------ */

export default function CallsDashboard() {
  const { range } = useGlobalRange();
  const searchParams = useSearchParams();

  const [provider, setProvider] = useState<ProviderFilter>("all");
  const [media, setMedia] = useState<MediaFilter>("all");
  const [direction, setDirection] = useState<DirectionFilter>("all");
  const [answeredFilter, setAnsweredFilter] = useState<AnsweredFilter>("all");
  const [rankingMode, setRankingMode] = useState<RankingMode>("duration");

  // Paging resets when the slice changes, but is remembered per slice.
  const recentLimitKey = useMemo(() => {
    return JSON.stringify({
      provider,
      media,
      direction,
      answered: answeredFilter,
      start: range.startIso,
      end: range.endIso,
    });
  }, [answeredFilter, direction, media, provider, range.endIso, range.startIso]);

  const [recentLimitByKey, setRecentLimitByKey] = useState<Record<string, number>>({});
  const recentLimit = recentLimitByKey[recentLimitKey] ?? 50;

  const setRecentLimit = useCallback(
    (updater: number | ((value: number) => number)) => {
      setRecentLimitByKey((current) => {
        const existing = current[recentLimitKey] ?? 50;
        const next = typeof updater === "function" ? updater(existing) : updater;
        if (next === existing) return current;
        return { ...current, [recentLimitKey]: next };
      });
    },
    [recentLimitKey],
  );

  // The call history API has no range parameters — it pages the whole log, and we
  // slice client-side. Ordered newest-first by the query layer.
  const callsQuery = useQuery({
    queryKey: ["calls", "all"],
    queryFn: fetchAllCalls,
    staleTime: 60_000,
    gcTime: 5 * 60_000,
    refetchOnWindowFocus: true,
    retry: 1,
    // This route is same-origin and reads a local SQLite file, so the default
    // "online" network mode is wrong for it: when the online heuristic reads
    // false, a failed attempt is paused rather than retried, and the query sits
    // in `pending` forever — the skeleton never resolves and a real failure
    // (e.g. no Full Disk Access) never surfaces.
    networkMode: "always",
  });

  const allCalls = useMemo(() => callsQuery.data ?? [], [callsQuery.data]);

  const rangeBounds = useMemo(
    () => ({ start: range.startDate, end: range.endDate }),
    [range.endDate, range.startDate],
  );

  const filteredCalls = useMemo(() => {
    return allCalls.filter((call) => {
      if (provider !== "all" && call.provider !== provider) return false;
      if (media !== "all" && call.media !== media) return false;
      if (direction !== "all" && call.direction !== direction) return false;
      if (answeredFilter === "answered" && !call.answered) return false;
      if (answeredFilter === "missed" && call.answered) return false;

      if (rangeBounds.start || rangeBounds.end) {
        const startedAt = toDate(call.startedAt);
        if (!startedAt) return false;
        if (rangeBounds.start && startedAt < rangeBounds.start) return false;
        if (rangeBounds.end && startedAt > rangeBounds.end) return false;
      }

      return true;
    });
  }, [allCalls, answeredFilter, direction, media, provider, rangeBounds.end, rangeBounds.start]);

  const totals = useMemo(() => {
    let callCount = 0;
    let answeredCount = 0;
    let missedCount = 0;
    let missedIncomingCount = 0;
    let outgoingCount = 0;
    let incomingCount = 0;
    let facetimeCount = 0;
    let telephonyCount = 0;
    let videoCount = 0;
    let audioCount = 0;
    let totalDuration = 0;
    let latest: Date | null = null;
    let earliest: Date | null = null;

    for (const call of filteredCalls) {
      callCount += 1;
      if (call.answered) answeredCount += 1;
      else missedCount += 1;
      if (call.direction === "incoming") incomingCount += 1;
      if (call.direction === "outgoing") outgoingCount += 1;
      if (call.direction === "incoming" && !call.answered) missedIncomingCount += 1;
      if (call.provider === "facetime") facetimeCount += 1;
      if (call.provider === "telephony") telephonyCount += 1;
      if (call.media === "video") videoCount += 1;
      if (call.media === "audio") audioCount += 1;
      totalDuration += durationOf(call);

      const startedAt = toDate(call.startedAt);
      if (startedAt) {
        if (!latest || startedAt > latest) latest = startedAt;
        if (!earliest || startedAt < earliest) earliest = startedAt;
      }
    }

    return {
      callCount,
      answeredCount,
      missedCount,
      missedIncomingCount,
      outgoingCount,
      incomingCount,
      facetimeCount,
      telephonyCount,
      videoCount,
      audioCount,
      totalDuration,
      answeredRate: share(answeredCount, callCount),
      avgDuration: answeredCount > 0 ? totalDuration / answeredCount : 0,
      latest,
      earliest,
    };
  }, [filteredCalls]);

  // Preset "all" has no bounds — fall back to the span the data actually covers.
  const windowStart = rangeBounds.start ?? totals.earliest;
  const windowEnd = rangeBounds.end ?? totals.latest;

  const dailyBuckets = useMemo(
    () => computeDailyBuckets(filteredCalls, { start: windowStart, end: windowEnd }),
    [filteredCalls, windowEnd, windowStart],
  );

  const { bars, daysPerBar } = useMemo(() => toBars(dailyBuckets), [dailyBuckets]);
  const barPeak = useMemo(() => bars.reduce((max, bar) => (bar.count > max ? bar.count : max), 0), [bars]);
  const sparkValues = useMemo(() => bars.map((bar) => bar.count), [bars]);

  /**
   * The only trend the call log can honestly support: talk time in the second half
   * of the visible range against the first half. Not a previous-period comparison.
   */
  const talkTrend = useMemo(() => {
    if (dailyBuckets.length < 4) return null;
    const mid = Math.floor(dailyBuckets.length / 2);
    const first = dailyBuckets.slice(0, mid).reduce((sum, bucket) => sum + bucket.duration, 0);
    const second = dailyBuckets.slice(mid).reduce((sum, bucket) => sum + bucket.duration, 0);
    if (first <= 0) return null;
    return (second - first) / first;
  }, [dailyBuckets]);

  const peopleAggregate = useMemo(() => {
    const map = new Map<string, PersonStat>();

    for (const call of filteredCalls) {
      const participants = participantsOf(call);
      const participantKeys = new Set(
        participants.map((participant) => participant.id ?? participant.handle).filter(Boolean),
      );
      const startedAt = toDate(call.startedAt);
      const duration = durationOf(call);
      const missedIncoming = call.direction === "incoming" && !call.answered ? 1 : 0;

      for (const key of participantKeys) {
        const existing = map.get(key);
        const participant = participants.find((p) => (p.id ?? p.handle) === key);
        const handle = participant?.handle ?? key;
        const label = participant ? participantLabel(participant) : handle;
        if (!existing) {
          map.set(key, {
            key,
            label,
            calls: 1,
            answered: call.answered ? 1 : 0,
            missed: call.answered ? 0 : 1,
            missedIncoming,
            incoming: call.direction === "incoming" ? 1 : 0,
            outgoing: call.direction === "outgoing" ? 1 : 0,
            totalDuration: duration,
            lastCallAt: startedAt,
          });
          continue;
        }
        existing.calls += 1;
        existing.answered += call.answered ? 1 : 0;
        existing.missed += call.answered ? 0 : 1;
        existing.missedIncoming += missedIncoming;
        existing.incoming += call.direction === "incoming" ? 1 : 0;
        existing.outgoing += call.direction === "outgoing" ? 1 : 0;
        existing.totalDuration += duration;
        if (startedAt && (!existing.lastCallAt || startedAt > existing.lastCallAt)) {
          existing.lastCallAt = startedAt;
        }
        if (existing.label === handle && participant?.displayName?.trim()) {
          existing.label = participant.displayName.trim();
        } else if (existing.label === existing.key && label !== existing.key) {
          existing.label = label;
        }
      }
    }

    return Array.from(map.values());
  }, [filteredCalls]);

  const rankedPeople = useMemo(() => {
    const list = [...peopleAggregate];
    if (rankingMode === "calls") {
      return list.sort(
        (a, b) => b.calls - a.calls || b.totalDuration - a.totalDuration || a.label.localeCompare(b.label),
      );
    }
    if (rankingMode === "outgoing") {
      return list.sort(
        (a, b) =>
          b.outgoing - a.outgoing ||
          b.calls - a.calls ||
          b.totalDuration - a.totalDuration ||
          a.label.localeCompare(b.label),
      );
    }
    if (rankingMode === "missed") {
      return list.sort(
        (a, b) =>
          b.missedIncoming - a.missedIncoming ||
          b.missed - a.missed ||
          b.calls - a.calls ||
          a.label.localeCompare(b.label),
      );
    }
    return list.sort(
      (a, b) => b.totalDuration - a.totalDuration || b.calls - a.calls || a.label.localeCompare(b.label),
    );
  }, [peopleAggregate, rankingMode]);

  const topPeople = useMemo(
    () => rankedPeople.filter((person) => personMetric(person, rankingMode) > 0).slice(0, 8),
    [rankedPeople, rankingMode],
  );
  const topPeopleMax = topPeople.length > 0 ? personMetric(topPeople[0], rankingMode) : 0;

  const highlights = useMemo(() => {
    const longestCall = filteredCalls.reduce<CallApiRecord | null>((best, call) => {
      const duration = durationOf(call);
      if (duration <= 0) return best;
      if (!best) return call;
      return duration > durationOf(best) ? call : best;
    }, null);

    const busiestDay = dailyBuckets.reduce<DayBucket | null>((best, bucket) => {
      if (bucket.count === 0) return best;
      if (!best) return bucket;
      return bucket.count > best.count ? bucket : best;
    }, null);

    const mostOutgoing =
      [...peopleAggregate]
        .sort((a, b) => b.outgoing - a.outgoing || b.calls - a.calls || a.label.localeCompare(b.label))
        .find((person) => person.outgoing > 0) ?? null;

    const mostMissedIncoming =
      [...peopleAggregate]
        .sort(
          (a, b) => b.missedIncoming - a.missedIncoming || b.calls - a.calls || a.label.localeCompare(b.label),
        )
        .find((person) => person.missedIncoming > 0) ?? null;

    return { longestCall, busiestDay, mostOutgoing, mostMissedIncoming };
  }, [dailyBuckets, filteredCalls, peopleAggregate]);

  const recentCalls = useMemo(() => filteredCalls.slice(0, recentLimit), [filteredCalls, recentLimit]);
  const hasMoreRecent = recentLimit < filteredCalls.length;

  const personHref = useCallback(
    (person: PersonStat) => {
      const params = new URLSearchParams(searchParams.toString());
      params.set("key", person.key);
      params.set("label", person.label);
      return `/people?${params.toString()}`;
    },
    [searchParams],
  );

  const rangeLabel =
    range.mode === "preset" ? PRESET_LABELS[range.preset] : range.mode === "day" ? "Single day" : "Custom range";

  const spanLabel =
    windowStart && windowEnd ? `${formatDayLong(windowStart)} – ${formatDayLong(windowEnd)}` : null;

  const subtitle = (
    <>
      {rangeLabel}
      {spanLabel ? ` · ${spanLabel}` : null} ·{" "}
      <span className="text-ink-muted">
        {formatCount(filteredCalls.length)} calls
        {totals.latest ? ` · latest ${formatDateTime(totals.latest)}` : null}
      </span>
    </>
  );

  const accessError = callsQuery.error instanceof Error ? callsQuery.error.message : null;
  // A query whose retry is paused reports `pending` with no error, forever. Never
  // let that state render as an endless skeleton — say what is actually going on.
  const isStalled = callsQuery.fetchStatus === "paused" && callsQuery.data === undefined;

  /* ---------------------------------------------------------------- *
   * Loading / error
   * ---------------------------------------------------------------- */

  if (callsQuery.isPending && !isStalled) {
    return (
      <>
        <PageHeader title="Calls" subtitle="Loading call history…" actions={<RangeControl />} />
        <SkeletonPanel height={58} className="rounded-2xl" />
        <div className="grid gap-3.5 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <SkeletonPanel key={`stat-${i}`} height={118} />
          ))}
        </div>
        <div className="grid gap-3.5 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <SkeletonPanel key={`mini-${i}`} height={92} className="rounded-2xl" />
          ))}
        </div>
        <div className="grid gap-3.5 lg:grid-cols-[1.55fr_1fr]">
          <SkeletonPanel height={330} className="rounded-[20px]" />
          <SkeletonPanel height={330} className="rounded-[20px]" />
        </div>
        <SkeletonPanel height={340} className="rounded-[20px]" />
      </>
    );
  }

  if (accessError || isStalled) {
    return (
      <>
        <PageHeader title="Calls" actions={<RangeControl />} />
        {accessError ? (
          <ErrorBanner
            title="Can’t read Call History"
            detail={`${accessError} Grant your terminal “Full Disk Access” (System Settings → Privacy & Security), then refresh.`}
          />
        ) : (
          <ErrorBanner
            title="Call history didn’t load"
            detail="The request was paused before it could finish. Check that the app is online, then refresh."
          />
        )}
      </>
    );
  }

  /* ---------------------------------------------------------------- *
   * Screen
   * ---------------------------------------------------------------- */

  const filtersBar = (
    <Panel className="flex flex-wrap items-center gap-2.5 rounded-2xl px-4 py-3.5">
      <PanelLabel className="mr-1">Filters</PanelLabel>
      <Segmented options={PROVIDER_OPTIONS} value={provider} onChange={setProvider} ariaLabel="Provider" />
      <Segmented options={MEDIA_OPTIONS} value={media} onChange={setMedia} ariaLabel="Media" />
      <Segmented options={DIRECTION_OPTIONS} value={direction} onChange={setDirection} ariaLabel="Direction" />
      <Segmented options={OUTCOME_OPTIONS} value={answeredFilter} onChange={setAnsweredFilter} ariaLabel="Outcome" />
    </Panel>
  );

  if (filteredCalls.length === 0) {
    return (
      <>
        <PageHeader title="Calls" subtitle={subtitle} actions={<RangeControl />} />
        {filtersBar}
        <Panel className="rounded-[20px] px-[22px] py-6">
          <PanelTitle>No calls in this view</PanelTitle>
          <PanelSubtitle>
            {allCalls.length === 0
              ? "The call history database is empty."
              : "Nothing matches these filters in the selected range. Widen the range or clear a filter."}
          </PanelSubtitle>
        </Panel>
      </>
    );
  }

  return (
    <>
      <PageHeader title="Calls" subtitle={subtitle} actions={<RangeControl />} />

      {filtersBar}

      {/* Six headline metrics */}
      <div className="grid gap-3.5 sm:grid-cols-2 lg:grid-cols-3">
        <StatCard
          label="Calls"
          value={formatCount(totals.callCount)}
          delay={0.02}
          badge={<StatBadge tint="accent">{formatPercent(totals.answeredRate)} connected</StatBadge>}
          footer={
            sparkValues.length >= 2 ? (
              <Sparkline values={sparkValues} color="var(--ink-secondary)" delay={0.1} />
            ) : null
          }
        />
        <StatCard
          label="Talk time"
          tint="accent"
          value={formatDuration(totals.totalDuration)}
          delay={0.06}
          badge={
            talkTrend === null ? undefined : (
              <StatBadge tint={talkTrend >= 0 ? "accent" : "rose"}>
                {talkTrend >= 0 ? "▲" : "▼"} {formatPercent(Math.abs(talkTrend), 1)} vs 1st half
              </StatBadge>
            )
          }
          footer={
            <Meta>
              {totals.answeredCount > 0
                ? `Avg · ${formatDuration(totals.avgDuration)} / answered`
                : "No answered calls"}
            </Meta>
          }
        />
        <StatCard
          label="Missed"
          tint="amber"
          value={formatCount(totals.missedCount)}
          delay={0.1}
          badge={<StatBadge tint="amber">{formatPercent(share(totals.missedCount, totals.callCount))}</StatBadge>}
          footer={<Meta>{formatCount(totals.missedIncomingCount)} incoming · not answered</Meta>}
        />
        <StatCard
          label="Outgoing"
          tint="sky"
          value={formatCount(totals.outgoingCount)}
          delay={0.14}
          badge={<StatBadge tint="sky">{formatPercent(share(totals.outgoingCount, totals.callCount))}</StatBadge>}
          footer={<Meta>{formatCount(totals.incomingCount)} incoming</Meta>}
        />
        <StatCard
          label="FaceTime"
          tint="violet"
          value={formatCount(totals.facetimeCount)}
          delay={0.18}
          badge={
            <StatBadge tint="violet">{formatPercent(share(totals.facetimeCount, totals.callCount))}</StatBadge>
          }
          footer={<Meta>{formatCount(totals.telephonyCount)} phone</Meta>}
        />
        <StatCard
          label="Video"
          value={formatCount(totals.videoCount)}
          delay={0.22}
          badge={<StatBadge>{formatPercent(share(totals.videoCount, totals.callCount))}</StatBadge>}
          footer={<Meta>{formatCount(totals.audioCount)} audio</Meta>}
        />
      </div>

      {/* Four highlights */}
      <div className="grid gap-3.5 sm:grid-cols-2 lg:grid-cols-4">
        <MiniCard
          label="Longest call"
          delay={0.24}
          value={highlights.longestCall ? formatDuration(durationOf(highlights.longestCall)) : "—"}
          sub={
            highlights.longestCall
              ? `${callTargets(highlights.longestCall)} · ${formatDayShort(highlights.longestCall.startedAt)}`
              : "No calls with a duration"
          }
        />
        <MiniCard
          label="Busiest day"
          delay={0.28}
          value={
            highlights.busiestDay
              ? `${formatCount(highlights.busiestDay.count)} ${highlights.busiestDay.count === 1 ? "call" : "calls"}`
              : "—"
          }
          sub={highlights.busiestDay ? formatDayLong(highlights.busiestDay.date) : "—"}
        />
        <MiniCard
          label="Most outgoing"
          delay={0.32}
          value={highlights.mostOutgoing ? formatCount(highlights.mostOutgoing.outgoing) : "—"}
          sub={highlights.mostOutgoing ? highlights.mostOutgoing.label : "No outgoing calls"}
        />
        <MiniCard
          label="Most missed (in)"
          delay={0.36}
          valueClass="text-amber-soft"
          value={highlights.mostMissedIncoming ? formatCount(highlights.mostMissedIncoming.missedIncoming) : "—"}
          sub={highlights.mostMissedIncoming ? highlights.mostMissedIncoming.label : "No missed incoming calls"}
        />
      </div>

      {/* Top people + daily calls */}
      <div className="grid gap-3.5 lg:grid-cols-[1.55fr_1fr]">
        <Panel delay={0.38} className="rounded-[20px] px-[22px] py-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <PanelTitle>Top people</PanelTitle>
            <Segmented
              options={RANKING_OPTIONS}
              value={rankingMode}
              onChange={setRankingMode}
              ariaLabel="Rank people by"
            />
          </div>

          <div className="mt-3 flex flex-col gap-0.5">
            {topPeople.length === 0 ? (
              <EmptyNote className="py-4">No people match this ranking in the current view.</EmptyNote>
            ) : (
              topPeople.map((person, index) => {
                const metric = personMetric(person, rankingMode);
                const primary = rankingMode === "duration" ? formatDuration(metric) : formatCount(metric);
                return (
                  <Link
                    key={person.key}
                    href={personHref(person)}
                    className="flex items-center gap-[13px] rounded-xl px-2 py-[9px] transition-colors hover:bg-surface"
                  >
                    <span className="w-4 flex-none font-mono text-[11px] text-ink-ghost">{index + 1}</span>
                    <Avatar label={person.label} identityKey={person.key} size={34} />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-baseline justify-between gap-2.5">
                        <span className="truncate text-[13px] font-semibold text-ink-primary">{person.label}</span>
                        <span className="flex-none font-mono text-[11px] text-accent-soft">{primary}</span>
                      </span>
                      <span className="mt-1.5 flex items-center gap-2">
                        <span className="flex-1">
                          <MeterBar
                            ratio={share(metric, topPeopleMax)}
                            color="linear-gradient(90deg,var(--accent),var(--sky))"
                            delay={index * 0.04}
                          />
                        </span>
                        <span className="flex-none whitespace-nowrap font-mono text-[10px] text-ink-ghost">
                          {formatCount(person.calls)} {person.calls === 1 ? "call" : "calls"} ·{" "}
                          {formatCount(person.incoming)} in / {formatCount(person.outgoing)} out
                        </span>
                      </span>
                    </span>
                  </Link>
                );
              })
            )}
          </div>
        </Panel>

        <Panel delay={0.42} className="rounded-[20px] px-[22px] py-5">
          <div className="flex items-start justify-between gap-3">
            <div>
              <PanelTitle>Daily calls</PanelTitle>
              <PanelSubtitle>
                {rangeLabel}
                {daysPerBar > 1 ? ` · ${daysPerBar}d per bar` : null}
              </PanelSubtitle>
            </div>
            {barPeak > 0 ? (
              <span className="flex-none font-mono text-[11px] text-sky">peak {formatCount(barPeak)}</span>
            ) : null}
          </div>

          {bars.length === 0 ? (
            <EmptyNote className="mt-4">No dated calls in this range.</EmptyNote>
          ) : (
            <>
              <div className="mt-4 flex h-[150px] items-end gap-[3px]">
                {bars.map((bar, index) => {
                  const ratio = barPeak > 0 ? bar.count / barPeak : 0;
                  return (
                    <div
                      key={`${bar.label}-${index}`}
                      className="flex h-full flex-1 flex-col justify-end"
                      title={`${bar.label}${bar.days > 1 ? ` +${bar.days - 1}d` : ""} · ${bar.count} calls`}
                    >
                      <div
                        className="w-full origin-bottom rounded-[2px] animate-bar"
                        style={{
                          height: bar.count > 0 ? `${Math.max(4, ratio * 100)}%` : "2px",
                          background: bar.count > 0 ? "var(--sky)" : "var(--track)",
                          opacity: bar.count > 0 ? (ratio > 0.85 ? 1 : ratio > 0.5 ? 0.6 : 0.28) : 1,
                          animationDelay: `${Math.min(index * 0.015, 0.6)}s`,
                        }}
                      />
                    </div>
                  );
                })}
              </div>
              <AxisLabels labels={[bars[0].label, bars[bars.length - 1].label]} className="mt-2.5" />
            </>
          )}
        </Panel>
      </div>

      {/* Recent calls */}
      <Panel delay={0.46} className="rounded-[20px] px-[22px] py-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <PanelTitle>Recent calls</PanelTitle>
            <PanelSubtitle>
              Showing {formatCount(recentCalls.length)} of {formatCount(filteredCalls.length)}
            </PanelSubtitle>
          </div>
          {hasMoreRecent ? (
            <div className="flex items-center gap-2">
              <PagerButton onClick={() => setRecentLimit((value) => Math.min(filteredCalls.length, value + 50))}>
                Show more
              </PagerButton>
              <PagerButton onClick={() => setRecentLimit(filteredCalls.length)}>Show all</PagerButton>
            </div>
          ) : recentLimit > 50 ? (
            <PagerButton onClick={() => setRecentLimit(50)}>Show less</PagerButton>
          ) : null}
        </div>

        <div className="mt-3.5 divide-y divide-line-hairline overflow-hidden rounded-[14px] border border-line-subtle">
          {recentCalls.map((call) => {
            const target = participantsOf(call)[0];
            const label = callTargets(call);
            const kind = [providerLabel(call.provider), mediaLabel(call.media)].filter(Boolean).join(" · ");
            const duration = durationOf(call);
            return (
              <div key={call.callId} className="flex items-center gap-3.5 bg-inset px-4 py-[13px]">
                <Avatar label={label} identityKey={target?.id ?? target?.handle ?? label} size={34} />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                    <span className="truncate text-[13px] font-semibold text-ink-primary">{label}</span>
                    <span
                      className={`text-[11px] font-semibold ${call.answered ? "text-accent" : "text-amber"}`}
                    >
                      {call.answered ? "Answered" : call.outcome === "missed" ? "Missed" : "No answer"}
                    </span>
                    <span className="text-[11px] text-ink-ghost">{directionLabel(call.direction)}</span>
                    {kind ? <span className="text-[11px] text-ink-ghost">{kind}</span> : null}
                  </div>
                  <p className="mt-1 text-[11px] text-ink-faint">
                    {call.startedAt ? formatDateTime(call.startedAt) : "Unknown time"}
                  </p>
                </div>
                <span className="flex-none font-mono text-[13px] font-semibold text-ink-secondary">
                  {duration > 0 ? formatDuration(duration) : "—"}
                </span>
              </div>
            );
          })}
        </div>
      </Panel>
    </>
  );
}
