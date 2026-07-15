"use client";

import Link from "next/link";
import { useCallback, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";

import { PRESET_LABELS, PageHeader, RangeControl } from "@/components/app-shell";
import {
  AreaChart,
  AxisLabels,
  Avatar,
  Donut,
  EmptyNote,
  ErrorBanner,
  LegendItem,
  Panel,
  PanelSubtitle,
  PanelTitle,
  SkeletonPanel,
  Sparkline,
  SplitBar,
  StatBadge,
  StatCard,
} from "@/components/ui/primitives";
import { useGlobalRange } from "@/hooks/use-global-range";
import { useStatsSummary } from "@/hooks/use-stats-summary";
import { fetchAllCalls, type CallApiRecord } from "@/lib/callhistory/client";
import {
  chatLabel,
  formatCompact,
  formatCount,
  formatDateTime,
  formatDayLong,
  formatDayShort,
  formatDuration,
  formatHourLabel,
  formatHourRange,
  formatPercent,
  formatShortDuration,
  share,
  toDate,
} from "@/lib/format";
import type { SerializableConversationStats as ConversationStats } from "@/lib/imessage/types";

/* ------------------------------------------------------------------ *
 * Local helpers
 * ------------------------------------------------------------------ */

/** Widest the activity chart ever gets; longer ranges are grouped into even chunks. */
const CHART_MAX_POINTS = 400;
/** Sparklines are 110px wide — more than ~20 points is mush. */
const SPARK_MAX_POINTS = 20;
/** Guard against a corrupt timestamp producing a runaway day spine. */
const MAX_SPINE_DAYS = 20_000;

/** Local-time "YYYY-MM-DD". Daily buckets arrive as local midnight, so this round-trips them. */
function dayKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function dayKeyToDate(key: string): Date {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d);
}

type DayBucket = {
  key: string;
  date: Date;
  messages: number;
  calls: number;
  answered: number;
  talkSeconds: number;
};

/** Splits a day spine into at most `maxPoints` consecutive, equal-width chunks. */
function chunkBuckets(buckets: DayBucket[], maxPoints: number): DayBucket[][] {
  if (buckets.length === 0) return [];
  const size = Math.max(1, Math.ceil(buckets.length / maxPoints));
  const chunks: DayBucket[][] = [];
  for (let i = 0; i < buckets.length; i += size) {
    chunks.push(buckets.slice(i, i + size));
  }
  return chunks;
}

function sumOver(chunks: DayBucket[][], pick: (bucket: DayBucket) => number): number[] {
  return chunks.map((chunk) => chunk.reduce((sum, bucket) => sum + pick(bucket), 0));
}

const total = (values: number[]) => values.reduce((sum, value) => sum + value, 0);

/**
 * Honest in-range trend: the second half of the range against the first.
 * Halves are equal length (a middle day is dropped when the count is odd) and
 * `null` when there isn't enough of a range — or enough signal — to compare.
 */
function halfOverHalfTrend(values: number[]): number | null {
  if (values.length < 4) return null;
  const half = Math.floor(values.length / 2);
  const first = total(values.slice(0, half));
  const second = total(values.slice(values.length - half));
  if (first <= 0) return null;
  return (second - first) / first;
}

/** Same comparison for a rate, expressed in percentage points (a % change of a % is ambiguous). */
function halfOverHalfRatePoints(chunks: DayBucket[][]): number | null {
  if (chunks.length < 4) return null;
  const half = Math.floor(chunks.length / 2);
  const rate = (slice: DayBucket[][]) => {
    const flat = slice.flat();
    const calls = total(flat.map((b) => b.calls));
    if (calls <= 0) return null;
    return total(flat.map((b) => b.answered)) / calls;
  };
  const first = rate(chunks.slice(0, half));
  const second = rate(chunks.slice(chunks.length - half));
  if (first === null || second === null) return null;
  return second - first;
}

/** Four evenly spaced ticks across a chart's x-domain. */
function axisTicks(dates: Date[]): string[] {
  if (dates.length === 0) return [];
  if (dates.length <= 4) return dates.map((date) => formatDayShort(date));
  const picks = [0, Math.round((dates.length - 1) / 3), Math.round(((dates.length - 1) * 2) / 3), dates.length - 1];
  return picks.map((index) => formatDayShort(dates[index]));
}

function getCallParticipants(call: CallApiRecord) {
  if (call.participants.length > 0) {
    // The join table names a participant only when macOS Contacts matched the handle.
    // On a one-to-one call the record's own ZNAME is that same party, so prefer it
    // over falling through to a bare phone number.
    if (call.participants.length === 1 && !call.participants[0].displayName?.trim() && call.name?.trim()) {
      return [{ ...call.participants[0], displayName: call.name.trim() }];
    }
    return call.participants;
  }
  if (call.address) return [{ id: null, handle: call.address, displayName: call.name }];
  return [];
}

type CallPerson = {
  key: string;
  label: string;
  calls: number;
  durationSeconds: number;
  missedIncoming: number;
  lastCallAt: Date | null;
};

/** Rolls the call log up per identity key (shared with `participantBreakdown[].id`). */
function aggregateCallPeople(calls: CallApiRecord[]): CallPerson[] {
  const map = new Map<string, CallPerson>();

  for (const call of calls) {
    const participants = getCallParticipants(call);
    const startedAt = toDate(call.startedAt);
    const duration = Number.isFinite(call.durationSeconds) ? Math.max(0, call.durationSeconds) : 0;
    const missedIncoming = call.direction === "incoming" && !call.answered ? 1 : 0;
    const seen = new Set<string>();

    for (const participant of participants) {
      const key = participant.id ?? participant.handle;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      const label = participant.displayName?.trim() || participant.handle || key;

      const existing = map.get(key);
      if (!existing) {
        map.set(key, {
          key,
          label,
          calls: 1,
          durationSeconds: duration,
          missedIncoming,
          lastCallAt: startedAt,
        });
        continue;
      }

      existing.calls += 1;
      existing.durationSeconds += duration;
      existing.missedIncoming += missedIncoming;
      if (startedAt && (!existing.lastCallAt || startedAt > existing.lastCallAt)) {
        existing.lastCallAt = startedAt;
      }
      if (existing.label === existing.key && label !== existing.key) {
        existing.label = label;
      }
    }
  }

  return Array.from(map.values());
}

type ContactActivity = {
  key: string;
  label: string;
  messageCount: number;
  fromMeCount: number;
  fromThemCount: number;
  callCount: number;
  talkSeconds: number;
};

/** The design's trend pill. Meaning is spelled out in the card's caption. */
function TrendBadge({ trend, unit = "percent" }: { trend: number | null; unit?: "percent" | "points" }) {
  if (trend === null) return null;
  const up = trend >= 0;
  const magnitude =
    unit === "points" ? `${Math.abs(trend * 100).toFixed(1)}pp` : formatPercent(Math.abs(trend), 1);
  return (
    <StatBadge tint={up ? "accent" : "rose"}>
      {up ? "▲" : "▼"} {magnitude}
    </StatBadge>
  );
}

/** Sparkline + the caption that disambiguates the trend pill above it. */
function StatFooter({
  values,
  color,
  delay,
  trended,
  detail,
}: {
  values: number[];
  color: string;
  delay: number;
  trended: boolean;
  detail?: string;
}) {
  const caption = [trended ? "vs first half of range" : null, detail].filter(Boolean).join(" · ");
  return (
    <>
      <Sparkline values={values} color={color} delay={delay} />
      {caption ? <p className="mt-1.5 text-[10px] leading-snug text-ink-ghost">{caption}</p> : null}
    </>
  );
}

/* ------------------------------------------------------------------ *
 * Screen
 * ------------------------------------------------------------------ */

export default function OverviewDashboard() {
  const { range, searchParams } = useGlobalRange();

  const messagesQueryInput = useMemo(() => {
    if (!range.startIso || !range.endIso) return { limit: 50 } as const;
    return { limit: 50, start: range.startIso, end: range.endIso } as const;
  }, [range.endIso, range.startIso]);

  const {
    data: messagesData,
    isPending: messagesLoading,
    error: messagesErrorRaw,
  } = useStatsSummary(messagesQueryInput);

  const callsQuery = useQuery({
    queryKey: ["calls", "all"],
    queryFn: fetchAllCalls,
    staleTime: 60_000,
    gcTime: 5 * 60_000,
    refetchOnWindowFocus: true,
    retry: 1,
  });

  const messages = (messagesData as ConversationStats | undefined) ?? null;
  const allCalls = useMemo(() => callsQuery.data ?? [], [callsQuery.data]);

  // `fetchAllCalls` is unfiltered — the range is applied here.
  const filteredCalls = useMemo(() => {
    const start = range.startDate;
    const end = range.endDate;
    if (!start || !end) return allCalls;
    return allCalls.filter((call) => {
      const startedAt = toDate(call.startedAt);
      if (!startedAt) return false;
      return startedAt >= start && startedAt <= end;
    });
  }, [allCalls, range.endDate, range.startDate]);

  /* ---- Aligned day spine (messages + calls share an x-axis) ---- */

  const dayBuckets = useMemo<DayBucket[]>(() => {
    const messageDays = new Map<string, number>();
    for (const bucket of messages?.dailyCounts ?? []) {
      const date = toDate(bucket.date);
      if (!date) continue;
      const key = dayKey(date);
      const count = Math.max(0, bucket.sentCount) + Math.max(0, bucket.receivedCount);
      messageDays.set(key, (messageDays.get(key) ?? 0) + count);
    }

    const callDays = new Map<string, { calls: number; answered: number; talkSeconds: number }>();
    for (const call of filteredCalls) {
      const date = toDate(call.startedAt);
      if (!date) continue;
      const key = dayKey(date);
      const entry = callDays.get(key) ?? { calls: 0, answered: 0, talkSeconds: 0 };
      entry.calls += 1;
      if (call.answered) entry.answered += 1;
      entry.talkSeconds += Number.isFinite(call.durationSeconds) ? Math.max(0, call.durationSeconds) : 0;
      callDays.set(key, entry);
    }

    // "YYYY-MM-DD" sorts chronologically.
    const observed = Array.from(new Set([...messageDays.keys(), ...callDays.keys()])).sort();
    // Prefer the selected range's bounds so quiet leading/trailing days still register.
    const firstKey = range.startDate ? dayKey(range.startDate) : observed[0];
    const lastKey = range.endDate ? dayKey(range.endDate) : observed[observed.length - 1];
    if (!firstKey || !lastKey || lastKey < firstKey) return [];

    const spine: DayBucket[] = [];
    const cursor = dayKeyToDate(firstKey);
    const last = dayKeyToDate(lastKey);
    while (cursor <= last && spine.length < MAX_SPINE_DAYS) {
      const key = dayKey(cursor);
      const calls = callDays.get(key);
      spine.push({
        key,
        date: new Date(cursor),
        messages: messageDays.get(key) ?? 0,
        calls: calls?.calls ?? 0,
        answered: calls?.answered ?? 0,
        talkSeconds: calls?.talkSeconds ?? 0,
      });
      cursor.setDate(cursor.getDate() + 1);
    }
    return spine;
  }, [filteredCalls, messages, range.endDate, range.startDate]);

  const chartChunks = useMemo(() => chunkBuckets(dayBuckets, CHART_MAX_POINTS), [dayBuckets]);
  const sparkChunks = useMemo(() => chunkBuckets(dayBuckets, SPARK_MAX_POINTS), [dayBuckets]);

  const chunkDays = chartChunks[0]?.length ?? 1;
  const granularity = chunkDays === 1 ? "Daily volume" : `${chunkDays}-day volume`;

  const messageSeries = useMemo(() => sumOver(chartChunks, (b) => b.messages), [chartChunks]);
  const callSeries = useMemo(() => sumOver(chartChunks, (b) => b.calls), [chartChunks]);
  const axisLabels = useMemo(() => axisTicks(chartChunks.map((chunk) => chunk[0].date)), [chartChunks]);

  const messageSpark = useMemo(() => sumOver(sparkChunks, (b) => b.messages), [sparkChunks]);
  const callSpark = useMemo(() => sumOver(sparkChunks, (b) => b.calls), [sparkChunks]);
  const talkSpark = useMemo(() => sumOver(sparkChunks, (b) => b.talkSeconds), [sparkChunks]);
  // A connect rate is undefined on a day with no calls — those chunks are dropped rather than zeroed.
  const connectSpark = useMemo(
    () =>
      sparkChunks
        .map((chunk) => {
          const calls = total(chunk.map((b) => b.calls));
          return calls > 0 ? total(chunk.map((b) => b.answered)) / calls : null;
        })
        .filter((value): value is number => value !== null),
    [sparkChunks],
  );

  const dailyMessages = useMemo(() => dayBuckets.map((b) => b.messages), [dayBuckets]);
  const dailyCalls = useMemo(() => dayBuckets.map((b) => b.calls), [dayBuckets]);
  const dailyTalk = useMemo(() => dayBuckets.map((b) => b.talkSeconds), [dayBuckets]);

  const messageTrend = halfOverHalfTrend(dailyMessages);
  const callTrend = halfOverHalfTrend(dailyCalls);
  const talkTrend = halfOverHalfTrend(dailyTalk);
  const connectTrend = useMemo(() => halfOverHalfRatePoints(chunkBuckets(dayBuckets, 400)), [dayBuckets]);

  /* ---- Totals ---- */

  const callTotals = useMemo(() => {
    let talkSeconds = 0;
    let answered = 0;
    let latest: Date | null = null;
    for (const call of filteredCalls) {
      talkSeconds += Number.isFinite(call.durationSeconds) ? Math.max(0, call.durationSeconds) : 0;
      if (call.answered) answered += 1;
      const startedAt = toDate(call.startedAt);
      if (startedAt && (!latest || startedAt > latest)) latest = startedAt;
    }
    const callCount = filteredCalls.length;
    return {
      callCount,
      answered,
      missed: callCount - answered,
      talkSeconds,
      connectRate: share(answered, callCount),
      avgTalk: answered > 0 ? talkSeconds / answered : null,
      latest,
    };
  }, [filteredCalls]);

  const messageTotals = messages?.totals ?? null;

  const latestActivity = useMemo(() => {
    const messagesLatest = toDate(messages?.latestMessageAt ?? null);
    if (!messagesLatest) return callTotals.latest;
    if (!callTotals.latest) return messagesLatest;
    return messagesLatest > callTotals.latest ? messagesLatest : callTotals.latest;
  }, [callTotals.latest, messages?.latestMessageAt]);

  /* ---- Hour of day ---- */

  const hourBars = useMemo(() => {
    const totals = new Array<number>(24).fill(0);
    for (const bucket of messages?.hourlyCounts ?? []) {
      const hour = Number(bucket.hour);
      if (!Number.isInteger(hour) || hour < 0 || hour > 23) continue;
      totals[hour] += Math.max(0, bucket.sentCount) + Math.max(0, bucket.receivedCount);
    }
    const max = Math.max(...totals);
    if (max <= 0) return null;
    return {
      max,
      peakHour: totals.indexOf(max),
      bars: totals.map((count, hour) => {
        const ratio = count / max;
        return {
          hour,
          count,
          heightPct: Math.max(6, ratio * 100),
          // Alpha via opacity keeps the fill on `var(--accent)` so light mode follows.
          opacity: ratio > 0.75 ? 1 : ratio > 0.4 ? 0.55 : 0.22,
        };
      }),
    };
  }, [messages?.hourlyCounts]);

  /* ---- People ---- */

  const callPeople = useMemo(() => aggregateCallPeople(filteredCalls), [filteredCalls]);

  const messagePeople = useMemo(() => {
    if (!messages) return [];
    const aggregate = new Map<string, ContactActivity>();

    for (const chat of messages.topChats ?? []) {
      // `sentCount` is the whole thread's outbound total, so group members each
      // pick it up — hence the "includes your messages in shared group chats" note.
      const mySent = Math.max(0, chat.sentCount ?? 0);

      for (const participant of chat.messageParticipants ?? []) {
        if (participant.isMe || participant.id === "me") continue;
        const key = participant.id ?? participant.displayName ?? `unknown-${chat.chatId}`;
        const label = participant.displayName ?? "Unknown";
        const fromThem = Math.max(0, participant.messageCount ?? 0);

        const existing =
          aggregate.get(key) ??
          {
            key,
            label,
            messageCount: 0,
            fromMeCount: 0,
            fromThemCount: 0,
            callCount: 0,
            talkSeconds: 0,
          };

        existing.messageCount += mySent + fromThem;
        existing.fromMeCount += mySent;
        existing.fromThemCount += fromThem;
        if (existing.label === "Unknown" && label !== "Unknown") existing.label = label;
        aggregate.set(key, existing);
      }
    }

    return Array.from(aggregate.values());
  }, [messages]);

  const mostContacted = useMemo(() => {
    const combined = new Map<string, ContactActivity>();
    for (const person of messagePeople) combined.set(person.key, { ...person });

    for (const person of callPeople) {
      const existing =
        combined.get(person.key) ??
        {
          key: person.key,
          label: person.label,
          messageCount: 0,
          fromMeCount: 0,
          fromThemCount: 0,
          callCount: 0,
          talkSeconds: 0,
        };
      existing.callCount += person.calls;
      existing.talkSeconds += person.durationSeconds;
      if (existing.label === existing.key && person.label !== person.key) existing.label = person.label;
      combined.set(person.key, existing);
    }

    // Log-scaled so a single marathon call can't outrank a year of messages.
    const activityScore = (entry: ContactActivity) =>
      Math.log1p(Math.max(0, entry.messageCount)) +
      Math.log1p(Math.max(0, entry.callCount)) +
      Math.log1p(Math.max(0, entry.talkSeconds) / 60) * 0.6;

    return Array.from(combined.values())
      .filter((entry) => entry.messageCount > 0 || entry.callCount > 0)
      .sort(
        (a, b) =>
          activityScore(b) - activityScore(a) ||
          b.messageCount - a.messageCount ||
          b.callCount - a.callCount ||
          a.label.localeCompare(b.label),
      )
      .slice(0, 6);
  }, [callPeople, messagePeople]);

  const topThreads = useMemo(() => (messages?.topChats ?? []).slice(0, 5), [messages?.topChats]);

  const missedCallLeader = useMemo(() => {
    const ranked = [...callPeople]
      .filter((person) => person.missedIncoming > 0)
      .sort((a, b) => b.missedIncoming - a.missedIncoming || a.label.localeCompare(b.label));
    return ranked[0] ?? null;
  }, [callPeople]);

  const messagesPerCall =
    messageTotals && callTotals.callCount > 0 ? messageTotals.messageCount / callTotals.callCount : null;

  /* ---- Reply times ---- */

  const myReply = messages?.firstReplyTimes?.meResponding ?? null;
  const theirReply = messages?.firstReplyTimes?.themResponding ?? null;
  const myMedian = myReply?.medianSeconds ?? null;
  const theirMedian = theirReply?.medianSeconds ?? null;
  const replyRatio =
    myMedian && theirMedian && myMedian > 0 && theirMedian > 0 ? theirMedian / myMedian : null;

  /* ---- Links ---- */

  const personHref = useCallback(
    (key: string, label: string) => {
      const params = new URLSearchParams(searchParams.toString());
      params.set("key", key);
      params.set("label", label);
      return `/people?${params.toString()}`;
    },
    [searchParams],
  );

  const threadHref = useCallback(
    (chatId: number) => {
      const params = new URLSearchParams();
      if (range.startIso) params.set("start", range.startIso);
      if (range.endIso) params.set("end", range.endIso);
      const query = params.toString();
      return `/reports/${chatId}${query ? `?${query}` : ""}`;
    },
    [range.endIso, range.startIso],
  );

  /* ---- Header copy ---- */

  const rangeLabel =
    range.mode === "preset" ? PRESET_LABELS[range.preset] : range.mode === "day" ? "Single day" : "Custom range";

  const subtitle = (
    <>
      {rangeLabel}
      {range.startDate && range.endDate ? (
        <> · {formatDayShort(range.startDate)} – {formatDayLong(range.endDate)}</>
      ) : null}
      {latestActivity ? (
        <>
          {" · "}
          <span className="text-ink-muted">latest activity {formatDateTime(latestActivity)}</span>
        </>
      ) : null}
    </>
  );

  const messagesError =
    messagesErrorRaw instanceof Error ? messagesErrorRaw.message : messagesErrorRaw ? "Unable to load messages." : null;
  const callsError =
    callsQuery.error instanceof Error ? callsQuery.error.message : callsQuery.error ? "Unable to load calls." : null;

  const loading = messagesLoading || callsQuery.isPending;
  const isEmpty =
    !loading && (messageTotals?.messageCount ?? 0) === 0 && callTotals.callCount === 0;

  return (
    <>
      <PageHeader title="Overview" subtitle={subtitle} actions={<RangeControl />} />

      {messagesError ? <ErrorBanner title="Messages couldn’t load" detail={messagesError} /> : null}
      {callsError ? <ErrorBanner title="Calls couldn’t load" detail={callsError} /> : null}

      {loading ? (
        <>
          <div className="grid gap-3.5 sm:grid-cols-2 xl:grid-cols-4">
            {[0, 1, 2, 3].map((i) => (
              <SkeletonPanel key={i} height={140} />
            ))}
          </div>
          <div className="grid gap-3.5 lg:grid-cols-[1.85fr_1fr]">
            <SkeletonPanel height={300} />
            <SkeletonPanel height={300} />
          </div>
          <SkeletonPanel height={200} />
          <div className="grid gap-3.5 lg:grid-cols-[1.6fr_1fr]">
            <SkeletonPanel height={320} />
            <SkeletonPanel height={320} />
          </div>
        </>
      ) : isEmpty ? (
        <Panel className="rounded-[20px] px-[22px] py-8">
          <PanelTitle>No activity in this range</PanelTitle>
          <PanelSubtitle>Pick a wider range to see messages and calls.</PanelSubtitle>
        </Panel>
      ) : (
        <>
          {/* ---- Stat cards ---- */}
          <div className="grid gap-3.5 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard
              delay={0.02}
              label="Messages"
              value={formatCompact(messageTotals?.messageCount ?? 0)}
              badge={<TrendBadge trend={messageTrend} />}
              footer={
                <StatFooter
                  values={messageSpark}
                  color="var(--accent)"
                  delay={0}
                  trended={messageTrend !== null}
                  detail={messageTotals ? `${formatCount(messageTotals.messageCount)} total` : undefined}
                />
              }
            />
            <StatCard
              delay={0.08}
              label="Calls"
              value={formatCompact(callTotals.callCount)}
              badge={<TrendBadge trend={callTrend} />}
              footer={
                <StatFooter
                  values={callSpark}
                  color="var(--violet)"
                  delay={0.1}
                  trended={callTrend !== null}
                  detail={`${formatCount(callTotals.answered)} answered · ${formatCount(callTotals.missed)} not`}
                />
              }
            />
            <StatCard
              delay={0.14}
              label="Talk time"
              value={formatDuration(callTotals.talkSeconds)}
              badge={<TrendBadge trend={talkTrend} />}
              footer={
                <StatFooter
                  values={talkSpark}
                  color="var(--sky)"
                  delay={0.2}
                  trended={talkTrend !== null}
                  detail={callTotals.avgTalk !== null ? `Avg ${formatDuration(callTotals.avgTalk)} answered` : undefined}
                />
              }
            />
            <StatCard
              delay={0.2}
              label="Connect rate"
              value={callTotals.callCount > 0 ? formatPercent(callTotals.connectRate) : "—"}
              badge={<TrendBadge trend={connectTrend} unit="points" />}
              footer={
                <StatFooter
                  values={connectSpark}
                  color="var(--amber)"
                  delay={0.3}
                  trended={connectTrend !== null}
                  detail={
                    callTotals.callCount > 0
                      ? `${formatCount(callTotals.answered)} of ${formatCount(callTotals.callCount)} answered`
                      : "No calls in range"
                  }
                />
              }
            />
          </div>

          {/* ---- Activity over time + balance / reply ---- */}
          <div className="grid gap-3.5 lg:grid-cols-[1.85fr_1fr]">
            <Panel delay={0.22} className="rounded-[20px] px-[22px] py-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <PanelTitle>Activity over time</PanelTitle>
                  <PanelSubtitle>{granularity}, indexed to peak</PanelSubtitle>
                </div>
                <div className="flex gap-3.5">
                  <LegendItem color="var(--accent)">Messages</LegendItem>
                  <LegendItem color="var(--violet)">Calls</LegendItem>
                </div>
              </div>
              <div className="mt-3.5">
                <AreaChart
                  height={200}
                  series={[
                    { values: callSeries, color: "var(--violet)", id: "overview-calls", fillOpacity: 0.22 },
                    { values: messageSeries, color: "var(--accent)", id: "overview-messages", strokeWidth: 2.4 },
                  ]}
                />
              </div>
              {axisLabels.length > 0 ? <AxisLabels labels={axisLabels} /> : null}
            </Panel>

            <div className="flex flex-col gap-3.5">
              <Panel delay={0.26} className="rounded-[20px] px-5 py-[18px]">
                <PanelTitle>Message balance</PanelTitle>
                {messageTotals && messageTotals.messageCount > 0 ? (
                  <div className="mt-3.5 flex items-center gap-[18px]">
                    <Donut
                      ratio={share(messageTotals.receivedCount, messageTotals.messageCount)}
                      primary="var(--accent)"
                      secondary="var(--sky)"
                      value={formatPercent(share(messageTotals.receivedCount, messageTotals.messageCount))}
                      caption="from them"
                    />
                    <div className="flex flex-col gap-[11px] text-xs">
                      <div>
                        <div className="flex items-center gap-[7px] text-ink-tertiary">
                          <span className="h-2 w-2 rounded-[2px]" style={{ background: "var(--accent)" }} />
                          From them
                        </div>
                        <p className="ml-[15px] mt-0.5 font-mono text-xs text-ink-faint">
                          {formatCount(messageTotals.receivedCount)}
                        </p>
                      </div>
                      <div>
                        <div className="flex items-center gap-[7px] text-ink-tertiary">
                          <span className="h-2 w-2 rounded-[2px]" style={{ background: "var(--sky)" }} />
                          From you
                        </div>
                        <p className="ml-[15px] mt-0.5 font-mono text-xs text-ink-faint">
                          {formatCount(messageTotals.sentCount)}
                        </p>
                      </div>
                    </div>
                  </div>
                ) : (
                  <EmptyNote className="mt-3.5">No messages in this range.</EmptyNote>
                )}
              </Panel>

              <Panel delay={0.3} className="flex-1 rounded-[20px] px-5 py-[18px]">
                <PanelTitle>First reply time</PanelTitle>
                <PanelSubtitle>Median, messages only</PanelSubtitle>
                {myMedian !== null || theirMedian !== null ? (
                  <>
                    <div className="mt-3.5 flex gap-[22px]">
                      <div>
                        <p className="text-[11px] text-ink-dim">You</p>
                        <p className="mt-1 text-[22px] font-semibold text-accent">{formatShortDuration(myMedian)}</p>
                      </div>
                      <div className="w-px bg-line" />
                      <div>
                        <p className="text-[11px] text-ink-dim">Them</p>
                        <p className="mt-1 text-[22px] font-semibold text-violet">{formatShortDuration(theirMedian)}</p>
                      </div>
                    </div>
                    {replyRatio !== null ? (
                      <p className="mt-3.5 text-[11px] leading-[1.5] text-ink-faint">
                        {replyRatio >= 1 ? (
                          <>
                            You reply{" "}
                            <span className="font-semibold text-ink-tertiary">{replyRatio.toFixed(1)}× faster</span> than
                            the people you talk to.
                          </>
                        ) : (
                          <>
                            They reply{" "}
                            <span className="font-semibold text-ink-tertiary">{(1 / replyRatio).toFixed(1)}× faster</span>{" "}
                            than you do.
                          </>
                        )}
                      </p>
                    ) : null}
                    <p className="mt-1.5 text-[10px] text-ink-ghost">
                      {formatCount(myReply?.sampleCount ?? 0)} / {formatCount(theirReply?.sampleCount ?? 0)} replies
                      sampled
                    </p>
                  </>
                ) : (
                  <EmptyNote className="mt-3.5">Not enough back-and-forth in this range.</EmptyNote>
                )}
              </Panel>
            </div>
          </div>

          {/* ---- Hour of day ---- */}
          <Panel delay={0.32} className="rounded-[20px] px-[22px] py-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <PanelTitle>When you communicate</PanelTitle>
                <PanelSubtitle>Messages by hour of day</PanelSubtitle>
              </div>
              {hourBars ? (
                <p className="text-xs text-ink-muted">
                  Peak · <span className="font-semibold text-accent">{formatHourRange(hourBars.peakHour)}</span>
                </p>
              ) : null}
            </div>
            {hourBars ? (
              <>
                <div className="mt-4 flex h-24 items-end gap-1">
                  {hourBars.bars.map((bar) => (
                    <div key={bar.hour} className="flex h-full flex-1 flex-col justify-end">
                      <div
                        className="animate-bar w-full origin-bottom rounded-t-[4px] rounded-b-[2px]"
                        style={{
                          height: `${bar.heightPct}%`,
                          background: "var(--accent)",
                          opacity: bar.opacity,
                          animationDelay: `${(bar.hour * 0.02).toFixed(2)}s`,
                        }}
                      >
                        <span className="sr-only">
                          {formatHourRange(bar.hour)}: {formatCount(bar.count)} messages
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
                <AxisLabels
                  className="mt-2.5"
                  labels={[0, 6, 12, 18, 23].map((hour) => formatHourLabel(hour))}
                />
              </>
            ) : (
              <EmptyNote className="mt-3.5">No messages in this range.</EmptyNote>
            )}
          </Panel>

          {/* ---- Most contacted + threads / insight ---- */}
          <div className="grid gap-3.5 lg:grid-cols-[1.6fr_1fr]">
            <Panel delay={0.34} className="rounded-[20px] px-[22px] py-5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <PanelTitle>Most contacted</PanelTitle>
                <span className="text-[11px] text-ink-faint">Messages + calls</span>
              </div>
              {mostContacted.length > 0 ? (
                <div className="mt-3 flex flex-col gap-0.5">
                  {mostContacted.map((person, index) => (
                    <Link
                      key={person.key}
                      href={personHref(person.key, person.label)}
                      className="flex items-center gap-[13px] rounded-xl px-2 py-[9px] transition-colors hover:bg-surface"
                    >
                      <span className="w-4 flex-none font-mono text-[11px] text-ink-ghost">{index + 1}</span>
                      <Avatar label={person.label} identityKey={person.key} size={34} />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-baseline justify-between gap-2.5">
                          <span className="truncate text-[13px] font-semibold text-ink-primary">{person.label}</span>
                          <span className="flex-none font-mono text-[11px] text-ink-faint">
                            {person.talkSeconds > 0 ? formatDuration(person.talkSeconds) : "—"}
                          </span>
                        </div>
                        <div className="mt-1.5 flex items-center gap-2">
                          <SplitBar
                            className="flex-1"
                            segments={[
                              { value: person.fromThemCount, color: "var(--accent)" },
                              { value: person.fromMeCount, color: "var(--sky)" },
                            ]}
                          />
                          <span className="flex-none whitespace-nowrap font-mono text-[10px] text-ink-ghost">
                            {formatCount(person.messageCount)} · {formatCount(person.callCount)} calls
                          </span>
                        </div>
                      </div>
                    </Link>
                  ))}
                </div>
              ) : (
                <EmptyNote className="mt-3.5">No contacts in this range.</EmptyNote>
              )}
              <p className="mt-3 text-[10px] text-ink-ghost">
                Bar splits messages from them <span className="text-accent">▪</span> vs from you{" "}
                <span className="text-sky">▪</span>. Includes your messages in shared group chats.
              </p>
            </Panel>

            <div className="flex flex-col gap-3.5">
              <Panel delay={0.38} className="rounded-[20px] px-5 py-[18px]">
                <PanelTitle className="mb-3">Top threads</PanelTitle>
                {topThreads.length > 0 ? (
                  <div className="flex flex-col gap-[11px]">
                    {topThreads.map((chat) => (
                      <Link
                        key={chat.chatId}
                        href={threadHref(chat.chatId)}
                        className="flex items-center justify-between gap-3 rounded-md transition-colors hover:text-ink"
                      >
                        <span className="truncate text-xs text-ink-tertiary">{chatLabel(chat)}</span>
                        <span className="flex-none font-mono text-[11px] text-ink-faint">
                          {formatCount(chat.messageCount)}
                        </span>
                      </Link>
                    ))}
                  </div>
                ) : (
                  <EmptyNote>No threads in this range.</EmptyNote>
                )}
              </Panel>

              {messagesPerCall !== null || missedCallLeader ? (
                <Panel delay={0.42} tint="accent" className="rounded-[20px] px-5 py-[18px]">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.07em] text-accent">Insight</p>
                  <p className="mt-2 text-[13px] leading-[1.5] text-ink-secondary">
                    {messagesPerCall !== null ? (
                      <>
                        You exchange{" "}
                        <span className="font-semibold text-ink">≈ {messagesPerCall.toFixed(1)} messages</span> for every
                        call.{" "}
                      </>
                    ) : null}
                    {missedCallLeader ? (
                      <>
                        <span className="font-semibold text-ink">{missedCallLeader.label}</span> has the most missed
                        incoming calls —{" "}
                        <span className="font-semibold text-ink">
                          {formatCount(missedCallLeader.missedIncoming)} in this range
                        </span>
                        .
                      </>
                    ) : null}
                  </p>
                </Panel>
              ) : null}
            </div>
          </div>
        </>
      )}
    </>
  );
}
