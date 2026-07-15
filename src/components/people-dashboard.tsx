'use client';

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { RangeControl } from "@/components/app-shell";
import { parseBucketDate } from "@/components/person-timeline";
import { SearchIcon, ShareIcon } from "@/components/ui/icons";
import {
  AreaChart,
  AxisLabels,
  Avatar,
  EmptyNote,
  ErrorBanner,
  LegendItem,
  Panel,
  PanelSubtitle,
  PanelTitle,
  SkeletonPanel,
  StatCard,
  type AreaSeries,
} from "@/components/ui/primitives";
import { useGlobalRange } from "@/hooks/use-global-range";
import { useStatsSummary } from "@/hooks/use-stats-summary";
import { fetchAllCalls, type CallApiRecord, type CallParticipant } from "@/lib/callhistory/client";
import {
  chatLabel,
  displayLabel,
  formatCompact,
  formatCount,
  formatDateTime,
  formatDayLong,
  formatDayShort,
  formatDuration,
  toDate,
} from "@/lib/format";
import type { SerializableConversationStats } from "@/lib/imessage/types";

/* ------------------------------------------------------------------ *
 * Constants
 * ------------------------------------------------------------------ */

/** Mirrors person-fullscreen: the roster + topChats both come out of this one query. */
const STATS_LIMIT = 50;

/** A year of columns is the most the heatmap can show before it stops being readable. */
const MAX_CALENDAR_WEEKS = 53;

/** Guards against a pathological range producing an unbounded day walk. */
const MAX_DAY_SPAN = 4000;

/** Tier 0 is the "no contact" wash; tiers 1-3 are alpha ramps; tier 4 is the live token. */
const HEAT_EMPTY = "rgba(130,130,140,0.16)";
const HEAT_RAMP = [
  "rgba(52,211,153,0.22)",
  "rgba(52,211,153,0.42)",
  "rgba(52,211,153,0.66)",
  "var(--accent)",
] as const;

const PROVIDER_LABELS: Record<CallApiRecord["provider"], string> = {
  facetime: "FaceTime",
  telephony: "Phone",
  unknown: "Unknown",
};

const MEDIA_LABELS: Record<CallApiRecord["media"], string> = {
  audio: "Audio",
  video: "Video",
  unknown: "Unknown",
};

const DIRECTION_LABELS: Record<CallApiRecord["direction"], string> = {
  incoming: "Incoming",
  outgoing: "Outgoing",
  unknown: "Unknown",
};

/* ------------------------------------------------------------------ *
 * Types
 * ------------------------------------------------------------------ */

type PersonRow = {
  key: string;
  label: string;
  /** Messages *from* this person — the roster metric `participantBreakdown` reports. */
  messageCount: number;
  callCount: number;
};

type PersonThread = {
  chatId: number;
  label: string;
  isGroup: boolean;
  fromMeMessages: number;
  fromThemMessages: number;
  totalMessages: number;
  lastMessageAt: Date | null;
  participants: string[];
};

type NormalizedCall = {
  callId: number;
  startedAt: Date | null;
  durationSeconds: number;
  answered: boolean;
  direction: CallApiRecord["direction"];
  provider: CallApiRecord["provider"];
  media: CallApiRecord["media"];
};

type TimelinePoint = {
  bucket: string;
  fromMeCount: number;
  fromThemCount: number;
  totalCount: number;
};

type PersonTimeline = {
  bucket: "hour" | "day" | "week" | "month";
  points: TimelinePoint[];
};

type CalendarDay = {
  key: string;
  date: Date;
  total: number;
  fromMe: number;
  fromThem: number;
};

/* ------------------------------------------------------------------ *
 * Date helpers
 * ------------------------------------------------------------------ */

function dayKey(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function startOfDay(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function startOfWeek(date: Date) {
  const start = startOfDay(date);
  start.setDate(start.getDate() - start.getDay());
  return start;
}

function inRange(date: Date | null, start: Date | null, end: Date | null) {
  if (!date) return false;
  if (start && date < start) return false;
  if (end && date > end) return false;
  return true;
}

/* ------------------------------------------------------------------ *
 * Data fetching
 * ------------------------------------------------------------------ */

async function fetchPersonDailyTimeline(params: {
  personKey: string;
  start?: string;
  end?: string;
}): Promise<PersonTimeline> {
  const search = new URLSearchParams();
  search.set("key", params.personKey);
  search.set("bucket", "day");
  if (params.start) search.set("start", params.start);
  if (params.end) search.set("end", params.end);

  const res = await fetch(`/api/person-timeline?${search.toString()}`);
  const json = (await res.json().catch(() => null)) as { data?: PersonTimeline; error?: unknown } | null;
  if (!res.ok) {
    const message = typeof json?.error === "string" ? json.error : "Unable to load this person's timeline.";
    throw new Error(message);
  }
  return json?.data ?? { bucket: "day", points: [] };
}

/* ------------------------------------------------------------------ *
 * Call aggregation (adapted from person-fullscreen.tsx)
 * ------------------------------------------------------------------ */

function getCallParticipants(call: CallApiRecord): CallParticipant[] {
  if (call.participants.length > 0) {
    // The join table names a participant only when macOS Contacts matched the handle.
    // On a one-to-one call the record's own ZNAME is that same party, so prefer it
    // over falling through to a bare phone number.
    if (call.participants.length === 1 && !call.participants[0].displayName?.trim() && call.name?.trim()) {
      return [{ ...call.participants[0], displayName: call.name.trim() }];
    }
    return call.participants;
  }
  if (call.address) return [{ id: call.address, handle: call.address, displayName: call.name }];
  return [];
}

function computeCallStatsForPerson(options: {
  personKey: string;
  allCalls: CallApiRecord[];
  rangeStart: Date | null;
  rangeEnd: Date | null;
}) {
  const { personKey, allCalls, rangeStart, rangeEnd } = options;
  if (!personKey) return null;

  let totalCalls = 0;
  let answeredCalls = 0;
  let missedIncomingCalls = 0;
  let talkSeconds = 0;
  let lastCallAt: Date | null = null;
  let handle: string | null = null;
  const normalized: NormalizedCall[] = [];

  for (const call of allCalls) {
    const startedAt = toDate(call.startedAt);
    if (!inRange(startedAt, rangeStart, rangeEnd)) continue;

    const participant = getCallParticipants(call).find((p) => (p.id ?? p.handle) === personKey);
    if (!participant) continue;

    if (!handle && participant.handle) handle = participant.handle;

    totalCalls += 1;
    if (call.answered) answeredCalls += 1;
    if (call.direction === "incoming" && !call.answered) missedIncomingCalls += 1;

    const duration = Number.isFinite(call.durationSeconds) ? Math.max(0, call.durationSeconds) : 0;
    talkSeconds += duration;
    if (startedAt && (!lastCallAt || startedAt > lastCallAt)) lastCallAt = startedAt;

    normalized.push({
      callId: call.callId,
      startedAt,
      durationSeconds: duration,
      answered: call.answered,
      direction: call.direction,
      provider: call.provider,
      media: call.media,
    });
  }

  normalized.sort(
    (a, b) => (b.startedAt?.getTime() ?? 0) - (a.startedAt?.getTime() ?? 0) || b.callId - a.callId,
  );

  const longestCalls = normalized
    .filter((call) => call.durationSeconds > 0)
    .sort(
      (a, b) =>
        b.durationSeconds - a.durationSeconds ||
        (b.startedAt?.getTime() ?? 0) - (a.startedAt?.getTime() ?? 0),
    )
    .slice(0, 5);

  return {
    totalCalls,
    answeredCalls,
    missedIncomingCalls,
    talkSeconds,
    lastCallAt,
    handle,
    recentCalls: normalized.slice(0, 8),
    longestCalls,
  };
}

function callOutcome(call: NormalizedCall) {
  if (call.answered) return { label: "Answered", className: "text-accent" };
  if (call.direction === "incoming") return { label: "Missed", className: "text-rose" };
  return { label: "No answer", className: "text-amber" };
}

/* ------------------------------------------------------------------ *
 * Thread derivation (adapted from person-fullscreen.tsx)
 * ------------------------------------------------------------------ */

function computeThreadsForPerson(
  stats: SerializableConversationStats | null,
  personKey: string,
): PersonThread[] {
  if (!stats || !personKey) return [];
  const threads: PersonThread[] = [];

  for (const chat of stats.topChats ?? []) {
    const participant = (chat.messageParticipants ?? []).find((p) => {
      if (p.isMe === true || p.id === "me") return false;
      const key = p.id ?? p.displayName ?? `unknown-${chat.chatId}`;
      return key === personKey;
    });
    if (!participant) continue;

    // `sentCount` is everything *I* sent to this chat — exact for a 1:1, an
    // upper bound for a group. It's the only send-side figure the API exposes.
    const fromMeMessages = Math.max(0, chat.sentCount ?? 0);
    const fromThemMessages = Math.max(0, participant.messageCount ?? 0);

    threads.push({
      chatId: chat.chatId,
      label: chatLabel(chat),
      isGroup: Boolean(chat.isGroup),
      fromMeMessages,
      fromThemMessages,
      totalMessages: fromMeMessages + fromThemMessages,
      lastMessageAt: toDate(chat.lastMessageAt),
      participants: chat.participants,
    });
  }

  return threads.sort(
    (a, b) =>
      b.totalMessages - a.totalMessages ||
      (b.lastMessageAt?.getTime() ?? 0) - (a.lastMessageAt?.getTime() ?? 0) ||
      a.label.localeCompare(b.label),
  );
}

/* ------------------------------------------------------------------ *
 * Daily series + calendar
 * ------------------------------------------------------------------ */

/** Gap-filled day list across the range; falls back to the timeline's own span for "all time". */
function buildDaySeries(
  points: TimelinePoint[],
  rangeStart: Date | null,
  rangeEnd: Date | null,
): CalendarDay[] {
  const byKey = new Map<string, TimelinePoint>();
  let earliest: Date | null = null;
  let latest: Date | null = null;

  for (const point of points) {
    byKey.set(point.bucket, point);
    const date = parseBucketDate("day", point.bucket);
    if (!date) continue;
    if (!earliest || date < earliest) earliest = date;
    if (!latest || date > latest) latest = date;
  }

  const startSource = rangeStart ?? earliest;
  const endSource = rangeEnd ?? latest;
  if (!startSource || !endSource) return [];

  const first = startOfDay(startSource);
  const last = startOfDay(endSource);
  if (first > last) return [];

  const days: CalendarDay[] = [];
  const cursor = new Date(first.getTime());
  let guard = 0;
  while (cursor <= last && guard < MAX_DAY_SPAN) {
    guard += 1;
    const key = dayKey(cursor);
    const point = byKey.get(key);
    days.push({
      key,
      date: new Date(cursor.getTime()),
      total: point?.totalCount ?? 0,
      fromMe: point?.fromMeCount ?? 0,
      fromThem: point?.fromThemCount ?? 0,
    });
    cursor.setDate(cursor.getDate() + 1);
  }
  return days;
}

function buildCalendarWeeks(days: CalendarDay[]) {
  if (days.length === 0) return { weeks: [] as Array<Array<CalendarDay | null>>, max: 0, truncated: false };

  const byKey = new Map(days.map((day) => [day.key, day]));
  const cursor = startOfWeek(days[0].date);
  const lastWeekStart = startOfWeek(days[days.length - 1].date);

  const weeks: Array<Array<CalendarDay | null>> = [];
  let guard = 0;
  while (cursor <= lastWeekStart && guard < 700) {
    guard += 1;
    const week: Array<CalendarDay | null> = [];
    for (let offset = 0; offset < 7; offset += 1) {
      const day = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() + offset);
      week.push(byKey.get(dayKey(day)) ?? null);
    }
    weeks.push(week);
    cursor.setDate(cursor.getDate() + 7);
  }

  const truncated = weeks.length > MAX_CALENDAR_WEEKS;
  const visible = truncated ? weeks.slice(-MAX_CALENDAR_WEEKS) : weeks;

  let max = 0;
  for (const week of visible) {
    for (const day of week) {
      if (day && day.total > max) max = day.total;
    }
  }
  return { weeks: visible, max, truncated };
}

function heatColor(total: number, max: number) {
  if (total <= 0 || max <= 0) return HEAT_EMPTY;
  const ratio = total / max;
  if (ratio <= 0.25) return HEAT_RAMP[0];
  if (ratio <= 0.5) return HEAT_RAMP[1];
  if (ratio <= 0.75) return HEAT_RAMP[2];
  return HEAT_RAMP[3];
}

/* ------------------------------------------------------------------ *
 * URL
 * ------------------------------------------------------------------ */

/** Rebuilds /people from the live query string, so every range param survives. */
function buildPeopleHref(currentQuery: string, key: string, label: string) {
  const params = new URLSearchParams(currentQuery);
  params.set("key", key);
  if (label) params.set("label", label);
  else params.delete("label");
  return `/people?${params.toString()}`;
}

/* ------------------------------------------------------------------ *
 * Screen
 * ------------------------------------------------------------------ */

export default function PeopleDashboard() {
  const router = useRouter();
  const { range, searchParams } = useGlobalRange();
  const searchParamsString = searchParams.toString();

  const keyFromUrl = useMemo(() => searchParams.get("key")?.trim() ?? "", [searchParams]);
  const labelFromUrl = useMemo(() => searchParams.get("label")?.trim() ?? "", [searchParams]);

  const [search, setSearch] = useState("");
  const [shareCopied, setShareCopied] = useState(false);

  /* -------------------------------------------------- queries */

  const statsQuery = useStatsSummary({ limit: STATS_LIMIT, start: range.startIso, end: range.endIso });
  const stats = (statsQuery.data as SerializableConversationStats | undefined) ?? null;

  const callsQuery = useQuery({
    queryKey: ["calls", "all"],
    queryFn: fetchAllCalls,
    staleTime: 60_000,
    gcTime: 5 * 60_000,
    refetchOnWindowFocus: true,
    retry: 1,
  });
  const allCalls = useMemo(() => callsQuery.data ?? [], [callsQuery.data]);

  /* -------------------------------------------------- roster */

  const callCountByKey = useMemo(() => {
    const map = new Map<string, number>();
    for (const call of allCalls) {
      if (!inRange(toDate(call.startedAt), range.startDate, range.endDate)) continue;
      const keys = new Set<string>();
      for (const participant of getCallParticipants(call)) {
        const key = participant.id ?? participant.handle;
        if (key) keys.add(key);
      }
      for (const key of keys) map.set(key, (map.get(key) ?? 0) + 1);
    }
    return map;
  }, [allCalls, range.endDate, range.startDate]);

  const people = useMemo<PersonRow[]>(() => {
    const rows: PersonRow[] = [];
    for (const participant of stats?.participantBreakdown ?? []) {
      if (participant.isMe === true) continue;
      const key = participant.id;
      if (!key || key === "me") continue;
      rows.push({
        key,
        label: displayLabel(participant.displayName, key),
        messageCount: Math.max(0, participant.messageCount ?? 0),
        callCount: callCountByKey.get(key) ?? 0,
      });
    }
    return rows.sort((a, b) => b.messageCount - a.messageCount || a.label.localeCompare(b.label));
  }, [callCountByKey, stats?.participantBreakdown]);

  const filteredPeople = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return people;
    return people.filter(
      (person) => person.label.toLowerCase().includes(term) || person.key.toLowerCase().includes(term),
    );
  }, [people, search]);

  /* -------------------------------------------------- selection */

  // Honour ?key= even when the range excludes that person, so a deep link never
  // silently swaps to somebody else.
  const selectedKey = keyFromUrl || people[0]?.key || "";

  useEffect(() => {
    if (keyFromUrl) return;
    const top = people[0];
    if (!top) return;
    router.replace(buildPeopleHref(searchParamsString, top.key, top.label), { scroll: false });
  }, [keyFromUrl, people, router, searchParamsString]);

  const selectedRow = useMemo(
    () => people.find((person) => person.key === selectedKey) ?? null,
    [people, selectedKey],
  );
  const selectedLabel = selectedRow?.label || labelFromUrl || selectedKey || "Unknown";

  const handleSelect = useCallback(
    (person: PersonRow) => {
      if (person.key === selectedKey) return;
      router.replace(buildPeopleHref(searchParamsString, person.key, person.label), { scroll: false });
    },
    [router, searchParamsString, selectedKey],
  );

  /* -------------------------------------------------- per-person data */

  const timelineQuery = useQuery({
    queryKey: ["person-timeline", "people-daily", selectedKey, range.startIso, range.endIso],
    enabled: Boolean(selectedKey),
    staleTime: 60_000,
    gcTime: 5 * 60_000,
    refetchOnWindowFocus: false,
    queryFn: () =>
      fetchPersonDailyTimeline({ personKey: selectedKey, start: range.startIso, end: range.endIso }),
  });

  const callStats = useMemo(
    () =>
      computeCallStatsForPerson({
        personKey: selectedKey,
        allCalls,
        rangeStart: range.startDate,
        rangeEnd: range.endDate,
      }),
    [allCalls, range.endDate, range.startDate, selectedKey],
  );

  const threads = useMemo(() => computeThreadsForPerson(stats, selectedKey), [selectedKey, stats]);

  const messageTotals = useMemo(() => {
    let total = 0;
    let fromMe = 0;
    let fromThem = 0;
    let lastMessageAt: Date | null = null;
    for (const thread of threads) {
      total += thread.totalMessages;
      fromMe += thread.fromMeMessages;
      fromThem += thread.fromThemMessages;
      if (thread.lastMessageAt && (!lastMessageAt || thread.lastMessageAt > lastMessageAt)) {
        lastMessageAt = thread.lastMessageAt;
      }
    }
    return { total, fromMe, fromThem, lastMessageAt };
  }, [threads]);

  const daySeries = useMemo(
    () => buildDaySeries(timelineQuery.data?.points ?? [], range.startDate, range.endDate),
    [range.endDate, range.startDate, timelineQuery.data?.points],
  );

  const calendar = useMemo(() => buildCalendarWeeks(daySeries), [daySeries]);

  const chartSeries = useMemo<AreaSeries[]>(() => {
    if (daySeries.length < 2) return [];
    return [
      {
        values: daySeries.map((day) => day.fromMe),
        color: "var(--accent)",
        id: "people-from-you",
        fillOpacity: 0.28,
      },
      {
        values: daySeries.map((day) => day.fromThem),
        color: "var(--sky)",
        id: "people-from-them",
        fillOpacity: 0,
      },
    ];
  }, [daySeries]);

  const axisLabels = useMemo(() => {
    if (daySeries.length < 2) return [];
    const middle = daySeries[Math.floor((daySeries.length - 1) / 2)];
    const labels = [formatDayShort(daySeries[0].date)];
    if (daySeries.length > 2) labels.push(formatDayShort(middle.date));
    labels.push(formatDayShort(daySeries[daySeries.length - 1].date));
    return labels;
  }, [daySeries]);

  /* -------------------------------------------------- header bits */

  const personHandle = useMemo(() => {
    if (callStats?.handle) return callStats.handle;
    const direct = threads.find((thread) => !thread.isGroup && thread.participants.length === 1);
    if (direct) return direct.participants[0];
    // A bare handle *is* the identity key; a `contact-…` key carries no handle.
    if (selectedKey && !selectedKey.startsWith("contact-") && selectedKey !== "me") return selectedKey;
    return null;
  }, [callStats, selectedKey, threads]);

  const lastActivity = useMemo(() => {
    const candidates = [messageTotals.lastMessageAt, callStats?.lastCallAt ?? null].filter(
      (value): value is Date => Boolean(value),
    );
    if (candidates.length === 0) return null;
    return candidates.reduce((latest, value) => (value > latest ? value : latest));
  }, [callStats?.lastCallAt, messageTotals.lastMessageAt]);

  const subLine = useMemo(() => {
    const parts: string[] = [];
    if (personHandle) parts.push(personHandle);
    if (lastActivity) parts.push(`Last activity ${formatDateTime(lastActivity)}`);
    return parts.join(" · ");
  }, [lastActivity, personHandle]);

  const topDirectThread = useMemo(() => threads.find((thread) => !thread.isGroup) ?? null, [threads]);

  const reportHref = useMemo(() => {
    if (!topDirectThread) return null;
    const params = new URLSearchParams();
    if (range.startIso) params.set("start", range.startIso);
    if (range.endIso) params.set("end", range.endIso);
    const query = params.toString();
    return `/reports/${topDirectThread.chatId}${query ? `?${query}` : ""}`;
  }, [range.endIso, range.startIso, topDirectThread]);

  const handleShare = useCallback(async () => {
    if (typeof window === "undefined") return;
    const url = window.location.href;
    if (typeof navigator !== "undefined" && navigator.share) {
      try {
        await navigator.share({ title: `${selectedLabel} · Signal`, url });
        return;
      } catch {
        // Share sheet dismissed or unavailable — fall through to the clipboard.
      }
    }
    try {
      await navigator.clipboard.writeText(url);
      setShareCopied(true);
      window.setTimeout(() => setShareCopied(false), 1800);
    } catch {
      // Clipboard blocked; nothing further we can do without inventing UI.
    }
  }, [selectedLabel]);

  /* -------------------------------------------------- errors */

  const statsError =
    statsQuery.error instanceof Error
      ? statsQuery.error.message
      : statsQuery.error
        ? "Unable to load message stats."
        : null;
  const callsError =
    callsQuery.error instanceof Error
      ? callsQuery.error.message
      : callsQuery.error
        ? "Unable to load call history."
        : null;
  const timelineError = timelineQuery.error instanceof Error ? timelineQuery.error.message : null;

  const controlClass =
    "inline-flex h-[37px] cursor-pointer items-center gap-2 rounded-[11px] border border-line-control bg-surface px-3 text-xs font-semibold text-ink-secondary transition-colors hover:bg-surface-hover";

  /* -------------------------------------------------- render */

  return (
    // AppShell's <main> pads every other screen; the person-list column has to sit
    // flush against the sidebar, so the padding is neutralised and re-applied to
    // the detail column only.
    <div className="-mx-6 -mb-10 -mt-[30px] flex min-h-0 flex-1 flex-col md:flex-row lg:-mx-[34px]">
      <aside className="flex w-full flex-none flex-col border-b border-line-subtle bg-elevated md:sticky md:top-0 md:h-screen md:w-[264px] md:border-b-0 md:border-r">
        <div className="flex flex-col gap-3 px-[18px] pb-3 pt-[26px]">
          <h2 className="text-[15px] font-semibold tracking-[-0.01em] text-ink">People</h2>
          <div className="relative flex items-center">
            <span className="pointer-events-none absolute left-3 flex items-center text-ink-faint">
              <SearchIcon />
            </span>
            <input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search contacts"
              aria-label="Search contacts"
              className="w-full rounded-[11px] border border-line-control bg-surface py-2 pl-9 pr-3 text-xs text-ink-secondary outline-none placeholder:text-ink-ghost focus-visible:border-accent"
            />
          </div>
        </div>

        <div className="max-h-[320px] min-h-0 flex-1 overflow-y-auto px-2.5 pb-4 md:max-h-none">
          {statsQuery.isPending ? (
            Array.from({ length: 8 }).map((_, index) => (
              <div key={`person-skeleton-${index}`} className="mb-1 h-[46px] animate-pulse rounded-[11px] bg-surface" />
            ))
          ) : filteredPeople.length === 0 ? (
            <EmptyNote className="px-2 py-2">
              {people.length === 0 ? "No people in this range." : "No contacts match that search."}
            </EmptyNote>
          ) : (
            filteredPeople.map((person) => {
              const active = person.key === selectedKey;
              return (
                <button
                  key={person.key}
                  type="button"
                  onClick={() => handleSelect(person)}
                  aria-current={active ? "true" : undefined}
                  className={`mb-0.5 flex w-full cursor-pointer items-center gap-2.5 rounded-[11px] px-2.5 py-2 text-left transition-colors ${
                    active ? "bg-surface-active" : "hover:bg-surface"
                  }`}
                  style={active ? { boxShadow: "inset 2px 0 0 var(--accent)" } : undefined}
                >
                  <Avatar label={person.label} identityKey={person.key} size={30} />
                  <span className="min-w-0 flex-1">
                    <span
                      className={`block truncate text-[13px] ${
                        active ? "font-semibold text-ink" : "font-medium text-ink-secondary"
                      }`}
                    >
                      {person.label}
                    </span>
                    <span className="mt-0.5 block truncate font-mono text-[10px] text-ink-faint">
                      {formatCount(person.messageCount)} · {formatCount(person.callCount)}{" "}
                      {person.callCount === 1 ? "call" : "calls"}
                    </span>
                  </span>
                </button>
              );
            })
          )}
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col gap-[22px] px-6 pb-10 pt-[30px] lg:px-[34px]">
        <div className="flex flex-wrap items-start justify-between gap-4">
          {selectedKey ? (
            <div className="flex min-w-0 items-center gap-3.5">
              <Avatar label={selectedLabel} identityKey={selectedKey} size={60} />
              <div className="min-w-0">
                <h1 className="truncate text-[26px] font-semibold tracking-[-0.02em] text-ink">{selectedLabel}</h1>
                {subLine ? <p className="mt-1 truncate font-mono text-[11px] text-ink-faint">{subLine}</p> : null}
              </div>
            </div>
          ) : (
            <div>
              <h1 className="text-[26px] font-semibold tracking-[-0.02em] text-ink">People</h1>
              <p className="mt-1.5 text-[13px] text-ink-dim">Select a contact to see their activity.</p>
            </div>
          )}

          <div className="flex flex-wrap items-start gap-2.5">
            <RangeControl />
            {selectedKey ? (
              <button type="button" onClick={handleShare} className={controlClass}>
                <ShareIcon />
                {shareCopied ? "Link copied" : "Share"}
              </button>
            ) : null}
            {selectedKey && reportHref ? (
              <Link
                href={reportHref}
                className="inline-flex h-[37px] items-center rounded-[11px] border border-accent/40 bg-accent/10 px-3 text-xs font-semibold text-accent transition-colors hover:bg-accent/20"
              >
                Open report
              </Link>
            ) : null}
          </div>
        </div>

        {statsError ? <ErrorBanner title="Couldn't load message stats" detail={statsError} /> : null}
        {callsError ? (
          <ErrorBanner
            title="Couldn't read Call History"
            detail={`${callsError} Grant Full Disk Access in System Settings → Privacy & Security, then refresh.`}
          />
        ) : null}

        {statsQuery.isPending ? (
          <>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              {Array.from({ length: 4 }).map((_, index) => (
                <SkeletonPanel key={`stat-skeleton-${index}`} height={112} />
              ))}
            </div>
            <SkeletonPanel height={260} />
            <SkeletonPanel height={180} />
          </>
        ) : !selectedKey ? (
          <Panel className="rounded-[18px] p-6">
            <EmptyNote>No people found in this range. Widen the date range to see contacts.</EmptyNote>
          </Panel>
        ) : (
          <>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <StatCard
                label="Messages"
                value={formatCompact(messageTotals.total)}
                delay={0.02}
                footer={
                  <p className="text-[11px] font-semibold">
                    <span className="text-accent">{formatCount(messageTotals.fromMe)} you</span>
                    <span className="text-ink-ghost"> · </span>
                    <span className="text-sky">{formatCount(messageTotals.fromThem)} them</span>
                  </p>
                }
              />
              <StatCard
                label="Calls"
                value={callsQuery.isPending ? "—" : formatCount(callStats?.totalCalls ?? 0)}
                delay={0.06}
                footer={
                  <p className="text-[11px] font-semibold text-ink-dim">
                    {formatCount(callStats?.answeredCalls ?? 0)} answered ·{" "}
                    {formatCount(callStats?.missedIncomingCalls ?? 0)} missed
                  </p>
                }
              />
              <StatCard
                label="Talk time"
                tint="accent"
                value={callsQuery.isPending ? "—" : formatDuration(callStats?.talkSeconds ?? 0)}
                delay={0.1}
                footer={
                  <p className="text-[11px] font-semibold text-ink-dim">
                    Across {formatCount(callStats?.totalCalls ?? 0)}{" "}
                    {(callStats?.totalCalls ?? 0) === 1 ? "call" : "calls"}
                  </p>
                }
              />
              <StatCard
                label="Threads"
                value={formatCount(threads.length)}
                delay={0.14}
                footer={<p className="text-[11px] font-semibold text-ink-dim">Distinct chats</p>}
              />
            </div>

            <Panel className="rounded-[18px] p-[18px]" delay={0.18}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <PanelTitle>Messages over time</PanelTitle>
                  <PanelSubtitle>Daily · this range</PanelSubtitle>
                </div>
                <div className="flex items-center gap-3">
                  <LegendItem color="var(--accent)">From you</LegendItem>
                  <LegendItem color="var(--sky)">From them</LegendItem>
                </div>
              </div>
              <div className="mt-4">
                {timelineQuery.isPending ? (
                  <div className="h-[200px] animate-pulse rounded-[12px] bg-surface" />
                ) : timelineError ? (
                  <ErrorBanner title="Couldn't load this person's timeline" detail={timelineError} />
                ) : chartSeries.length === 0 ? (
                  <EmptyNote>Not enough daily data in this range.</EmptyNote>
                ) : (
                  <>
                    <AreaChart series={chartSeries} height={200} sharedDomain />
                    <AxisLabels labels={axisLabels} />
                  </>
                )}
              </div>
            </Panel>

            <Panel className="rounded-[18px] p-[18px]" delay={0.22}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <PanelTitle>Connection calendar</PanelTitle>
                  <PanelSubtitle>
                    {calendar.truncated
                      ? `Daily messages · last ${calendar.weeks.length} weeks`
                      : "Daily messages · this range"}
                  </PanelSubtitle>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="text-[10px] text-ink-ghost">Less</span>
                  <span className="h-[10px] w-[10px] rounded-[3px]" style={{ background: HEAT_EMPTY }} />
                  {HEAT_RAMP.map((color) => (
                    <span key={color} className="h-[10px] w-[10px] rounded-[3px]" style={{ background: color }} />
                  ))}
                  <span className="text-[10px] text-ink-ghost">More</span>
                </div>
              </div>
              <div className="mt-4 overflow-x-auto">
                {timelineQuery.isPending ? (
                  <div className="h-[108px] animate-pulse rounded-[12px] bg-surface" />
                ) : calendar.weeks.length === 0 ? (
                  <EmptyNote>No daily activity in this range.</EmptyNote>
                ) : (
                  <div className="flex gap-[3px]">
                    {calendar.weeks.map((week, weekIndex) => (
                      <div key={`week-${weekIndex}`} className="flex flex-none flex-col gap-[3px]">
                        {week.map((day, dayIndex) =>
                          day ? (
                            <span
                              key={day.key}
                              className="animate-pop h-[12px] w-[12px] flex-none rounded-[3px]"
                              style={{
                                background: heatColor(day.total, calendar.max),
                                animationDelay: `${Math.min(0.6, (weekIndex * 7 + dayIndex) * 0.0015)}s`,
                              }}
                              title={`${formatDayLong(day.date)} · ${formatCount(day.total)} messages (${formatCount(
                                day.fromMe,
                              )} you · ${formatCount(day.fromThem)} them)`}
                            />
                          ) : (
                            <span key={`empty-${weekIndex}-${dayIndex}`} className="h-[12px] w-[12px] flex-none" />
                          ),
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </Panel>

            <div className="grid gap-[18px] xl:grid-cols-2">
              <Panel className="rounded-[18px] p-[18px]" delay={0.26}>
                <PanelTitle>Top threads</PanelTitle>
                <PanelSubtitle>Chats you share with {selectedLabel}</PanelSubtitle>
                <div className="mt-3.5 flex flex-col gap-2.5">
                  {threads.length === 0 ? (
                    <EmptyNote>No shared threads in this range.</EmptyNote>
                  ) : (
                    threads.slice(0, 6).map((thread) => (
                      <div key={thread.chatId} className="flex items-center justify-between gap-3">
                        <span className="flex min-w-0 items-center gap-1.5">
                          <span className="truncate text-[13px] text-ink-secondary">{thread.label}</span>
                          {thread.isGroup ? (
                            <span className="flex-none text-[10px] font-semibold text-ink-ghost">(group)</span>
                          ) : null}
                        </span>
                        <span className="flex-none font-mono text-[11px] text-ink-muted">
                          {formatCount(thread.totalMessages)}
                        </span>
                      </div>
                    ))
                  )}
                </div>
              </Panel>

              <Panel className="rounded-[18px] p-[18px]" delay={0.3}>
                <PanelTitle>Longest calls</PanelTitle>
                <PanelSubtitle>By talk time · this range</PanelSubtitle>
                <div className="mt-3.5 flex flex-col gap-2.5">
                  {callsQuery.isPending ? (
                    <EmptyNote>Loading call history…</EmptyNote>
                  ) : (callStats?.longestCalls.length ?? 0) === 0 ? (
                    <EmptyNote>No calls with talk time in this range.</EmptyNote>
                  ) : (
                    callStats?.longestCalls.map((call) => (
                      <div key={call.callId} className="flex items-center justify-between gap-3">
                        <span className="min-w-0 truncate text-[13px]">
                          <span className="font-semibold text-ink">{formatDuration(call.durationSeconds)}</span>
                          <span className="text-ink-faint">
                            {" "}
                            · {PROVIDER_LABELS[call.provider]} · {MEDIA_LABELS[call.media]}
                          </span>
                        </span>
                        <span className="flex-none font-mono text-[11px] text-ink-muted">
                          {formatDayShort(call.startedAt)}
                        </span>
                      </div>
                    ))
                  )}
                </div>
              </Panel>
            </div>

            <Panel className="rounded-[18px] p-[18px]" delay={0.34}>
              <PanelTitle>Recent calls</PanelTitle>
              <PanelSubtitle>Most recent first · this range</PanelSubtitle>
              <div className="mt-3.5 overflow-hidden rounded-[12px] border border-line-hairline">
                {callsQuery.isPending ? (
                  <div className="px-3.5 py-4">
                    <EmptyNote>Loading call history…</EmptyNote>
                  </div>
                ) : (callStats?.recentCalls.length ?? 0) === 0 ? (
                  <div className="px-3.5 py-4">
                    <EmptyNote>No calls with {selectedLabel} in this range.</EmptyNote>
                  </div>
                ) : (
                  callStats?.recentCalls.map((call, index) => {
                    const outcome = callOutcome(call);
                    return (
                      <div
                        key={call.callId}
                        className={`flex flex-wrap items-center gap-x-3 gap-y-1 px-3.5 py-2.5 ${
                          index > 0 ? "border-t border-line-hairline" : ""
                        }`}
                      >
                        <span className={`text-[11px] font-semibold ${outcome.className}`}>{outcome.label}</span>
                        <span className="text-[11px] text-ink-faint">{DIRECTION_LABELS[call.direction]}</span>
                        <span className="text-[11px] text-ink-faint">
                          {PROVIDER_LABELS[call.provider]} · {MEDIA_LABELS[call.media]}
                        </span>
                        <span className="text-[11px] text-ink-muted">{formatDateTime(call.startedAt)}</span>
                        <span className="ml-auto font-mono text-[11px] text-ink-secondary">
                          {formatDuration(call.durationSeconds)}
                        </span>
                      </div>
                    );
                  })
                )}
              </div>
            </Panel>
          </>
        )}
      </div>
    </div>
  );
}
